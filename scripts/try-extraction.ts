import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeExtractor } from "../src/extraction/claude.js";
import { extractChunks, measureFile, splitFile, type FileType } from "../src/extraction/extract.js";
import { buildUnitIndex } from "../src/extraction/units.js";
import { createLogger } from "../src/log.js";

/**
 * Reads one local file with Claude, exactly as the `extract` job does, and
 * prints the items, flags and cost. Nothing is stored. For checking the
 * prompt and the accuracy on sample documents (TASKS.md T1.13.3):
 *
 *   npm run try:extract -- ~/Documents/boq.xlsx
 *
 * Needs ANTHROPIC_API_KEY (in .env or the environment). Units come from a
 * short built-in list, so some "unknown unit" flags may differ from the app.
 */
if (existsSync(".env")) process.loadEnvFile(".env");

const path = process.argv[2];
if (!path) {
  console.error("Usage: npm run try:extract -- <file.xlsx|.xls|.csv|.pdf>");
  process.exit(1);
}
const type = extname(path).slice(1).toLowerCase() as FileType;
if (!["pdf", "xlsx", "xls", "csv"].includes(type)) {
  console.error("Only .xlsx, .xls, .csv and .pdf files are read.");
  process.exit(1);
}

const bytes = new Uint8Array(readFileSync(path));
const log = createLogger("info", { script: "try-extraction" });
const extractor = new ClaudeExtractor(
  new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  {
    primary: process.env.EXTRACTION_MODEL ?? "claude-haiku-5-5",
    review: process.env.EXTRACTION_REVIEW_MODEL ?? "claude-opus-5-5",
  },
  log,
);
const units = buildUnitIndex([
  {
    code: "pcs",
    name: "Pieces",
    aliases: ["pc", "piece", "ea", "each", "nos", "no", "unit", "units", "buah", "bh"],
  },
  { code: "set", name: "Set", aliases: ["sets"] },
  { code: "lot", name: "Lot", aliases: ["lots"] },
  { code: "ls", name: "Lump sum", aliases: ["lump sum", "lumpsum", "l.s", "l/s"] },
  { code: "m", name: "Metre", aliases: ["meter", "meters", "mtr", "mtrs"] },
  { code: "m2", name: "Square metre", aliases: ["sqm", "m²"] },
  { code: "roll", name: "Roll", aliases: ["rol", "rolls"] },
  { code: "box", name: "Box", aliases: ["boxes", "dus"] },
]);

const measured = await measureFile(type, bytes);
const chunks = await splitFile(type, basename(path), bytes);
console.log(`Measured: ${JSON.stringify(measured)} → ${chunks.length} part(s)`);

const result = await extractChunks({
  chunks,
  fileName: basename(path),
  extractor,
  units,
  signal: new AbortController().signal,
  onProgress: async (done, total) => console.log(`Read part ${done} of ${total}`),
});

console.log(`\n${result.title} — ${result.items.length} items, model: ${result.model}`);
for (const item of result.items) {
  const flags = item.validation_flags.map((flag) => flag.code).join(", ");
  console.log(
    `${String(item.position + 1).padStart(3)}. ${item.name} | ${item.quantity ?? "?"} ${item.unit ?? ""} (${item.unit_code ?? "-"}) | ${JSON.stringify(item.specs)} | ${JSON.stringify(item.source_ref)} | conf ${item.confidence.overall}${flags ? ` | ⚑ ${flags}` : ""}`,
  );
}
for (const issue of result.issues)
  console.log(`  skipped: ${JSON.stringify(issue.source)} ${issue.message}`);
console.log(
  `\nTokens: ${result.usage.inputTokens} in, ${result.usage.outputTokens} out — USD ${result.usage.costUsd.toFixed(4)}`,
);
