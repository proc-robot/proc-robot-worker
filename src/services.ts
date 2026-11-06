import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import { ClaudeExtractor } from "./extraction/claude.js";
import { FakeExtractor } from "./extraction/fake.js";
import type { Extractor } from "./extraction/types.js";
import type { Logger } from "./log.js";
import { createFileStore, unavailableFileStore, type FileStore } from "./storage.js";
import { JobFailedError } from "./types.js";

/** Outside services the handlers use, built once from the configuration. */
export type Services = {
  files: FileStore;
  extractor: Extractor;
};

/** When no API key is set: extraction jobs fail at once (and refund), and the log says why. */
const unavailableExtractor: Extractor = {
  name: "unavailable",
  extract() {
    throw new JobFailedError(
      "Reading documents isn't available right now. Please try again later.",
    );
  },
};

export function createServices(config: Config, log: Logger): Services {
  const files =
    config.SUPABASE_URL && config.SUPABASE_SECRET_KEY
      ? createFileStore(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY)
      : unavailableFileStore;
  if (files === unavailableFileStore) {
    log.error("SUPABASE_URL or SUPABASE_SECRET_KEY is not set; jobs that read files will fail");
  }

  let extractor: Extractor;
  if (config.EXTRACTION_FAKE) {
    log.warn("EXTRACTION_FAKE is on: documents are read without AI (tests and development only)");
    extractor = new FakeExtractor();
  } else if (config.ANTHROPIC_API_KEY) {
    extractor = new ClaudeExtractor(
      new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 3 }),
      { primary: config.EXTRACTION_MODEL, review: config.EXTRACTION_REVIEW_MODEL },
      log,
    );
  } else {
    log.error("ANTHROPIC_API_KEY is not set; document extraction will fail");
    extractor = unavailableExtractor;
  }
  return { files, extractor };
}
