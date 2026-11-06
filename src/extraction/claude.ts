import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Logger } from "../log.js";
import { JobFailedError } from "../types.js";
import { chunkContent, SYSTEM_PROMPT } from "./prompt.js";
import {
  extractionOutputSchema,
  type Chunk,
  type ChunkResult,
  type ExtractionOutput,
  type Extractor,
  type Usage,
} from "./types.js";

/*
 * Extraction with Claude (TASKS.md T1.3.5, T1.3.6). Each part goes to the
 * fast model first (claude-haiku-5-5). If its answer is cut off, refused,
 * invalid or mostly uncertain, the part is read again by the stronger model
 * (claude-opus-5-5), whose answer is used.
 */

/** USD per million tokens (input, output); claude-api skill, cached 2026-10-06. */
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-fable-5-1": [10, 50],
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  let [input, output] = PRICES[model] ?? PRICES["claude-opus-5-5"]!;
  // Haiku 5.5 costs five times as much for prompts over 100K tokens.
  if (model === "claude-haiku-5-5" && inputTokens > 100_000) [input, output] = [0.5, 2.5];
  return (inputTokens * input + outputTokens * output) / 1_000_000;
}

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  costUsd: a.costUsd + b.costUsd,
});

/** Mostly uncertain: worth a second reading by the stronger model. */
export function needsSecondReading(output: ExtractionOutput): boolean {
  if (output.items.length === 0) return output.skipped.length > 0;
  const scores = output.items.map((item) => item.confidence.overall);
  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const uncertain = scores.filter((score) => score < 0.8).length / scores.length;
  return average < 0.6 || uncertain > 0.3;
}

type Reading =
  | { ok: true; output: ExtractionOutput; model: string; usage: Usage }
  | { ok: false; reason: "refusal" | "max_tokens" | "invalid"; usage: Usage };

export class ClaudeExtractor implements Extractor {
  readonly name = "claude";

  constructor(
    private readonly client: Anthropic,
    private readonly models: { primary: string; review: string },
    private readonly log: Logger,
  ) {}

  async extract(chunk: Chunk, signal: AbortSignal): Promise<ChunkResult> {
    const first = await this.read(this.models.primary, chunk, signal);
    if (first.ok && !needsSecondReading(first.output)) {
      return { output: first.output, model: first.model, usage: first.usage };
    }

    this.log.info("second reading with the review model", {
      reason: first.ok ? "low_confidence" : first.reason,
    });
    const second = await this.read(this.models.review, chunk, signal);
    const usage = addUsage(first.usage, second.usage);
    if (second.ok) return { output: second.output, model: second.model, usage };
    if (first.ok) return { output: first.output, model: first.model, usage };
    throw new JobFailedError(
      second.reason === "max_tokens"
        ? "Part of this document has too many items to read at once. Split the file and upload the parts."
        : "This document couldn't be read. Add its items by hand, or try another copy of the file.",
    );
  }

  private async read(model: string, chunk: Chunk, signal: AbortSignal): Promise<Reading> {
    // The refusal fallback is only offered for the larger models (not Haiku).
    const fallback = model.startsWith("claude-haiku")
      ? {}
      : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };
    let response;
    try {
      response = await this.client.beta.messages.parse(
        {
          model,
          max_tokens: 32_000,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: chunkContent(chunk) }],
          output_config: { effort: "medium", format: betaZodOutputFormat(extractionOutputSchema) },
          ...fallback,
        },
        { signal, timeout: 15 * 60_000 },
      );
    } catch (error) {
      // A request the API rejects (an unreadable PDF part) won't succeed on a
      // retry; rate limits, overload and network errors will, so they are rethrown.
      if (error instanceof Anthropic.BadRequestError) {
        this.log.warn("the model rejected a document part", { status: error.status, model });
        throw new JobFailedError(
          "This document couldn't be read. Check that the file opens, or add its items by hand.",
        );
      }
      throw error;
    }

    const usage: Usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      costUsd: costUsd(response.model, response.usage.input_tokens, response.usage.output_tokens),
    };
    if (response.stop_reason === "refusal") return { ok: false, reason: "refusal", usage };
    if (response.stop_reason === "max_tokens") return { ok: false, reason: "max_tokens", usage };
    const parsed = extractionOutputSchema.safeParse(response.parsed_output);
    if (!parsed.success) return { ok: false, reason: "invalid", usage };
    return { ok: true, output: parsed.data, model: response.model, usage };
  }
}
