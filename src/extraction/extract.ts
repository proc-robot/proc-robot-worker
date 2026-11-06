import { JobFailedError } from "../types.js";
import { loadPdf, measurePdf, splitPdf } from "./pdf.js";
import { dataRowCount, parseSpreadsheet } from "./sheet.js";
import type {
  Chunk,
  ExtractedItem,
  Extractor,
  FieldConfidence,
  ListIssue,
  ListItem,
  Usage,
} from "./types.js";
import { normalizeUnit, type UnitIndex } from "./units.js";
import { validateItems } from "./validate.js";

/*
 * Document extraction end to end (TASKS.md T1.3.4–T1.3.9): measure a file
 * for its credit estimate, split it into parts, read each part, and turn the
 * answers into validated items that point back to their source.
 */

export type FileType = "pdf" | "xlsx" | "xls" | "csv";

/** Spreadsheet rows per model call. */
export const ROWS_PER_PART = 80;
/** Larger files are refused at inspection, before any credits are spent. */
export const MAX_ROWS = 5_000;
export const MAX_PAGES = 300;

export type Measurement = { page_count?: number; row_count?: number; scanned?: boolean };

/** What the credit estimate needs (D10): pages (and scans) or data rows. */
export async function measureFile(type: FileType, bytes: Uint8Array): Promise<Measurement> {
  if (type === "pdf") {
    const { pageCount, scanned } = measurePdf(await loadPdf(bytes));
    if (pageCount === 0) throw new JobFailedError("This PDF has no pages.");
    if (pageCount > MAX_PAGES) {
      throw new JobFailedError(
        `This PDF has ${pageCount} pages; the limit is ${MAX_PAGES}. Upload the item pages only.`,
      );
    }
    return { page_count: pageCount, scanned };
  }
  const rows = dataRowCount(parseSpreadsheet(bytes));
  if (rows === 0) throw new JobFailedError("This spreadsheet has no rows to read.");
  if (rows > MAX_ROWS) {
    throw new JobFailedError(
      `This spreadsheet has ${rows.toLocaleString("en-US")} rows; the limit is ${MAX_ROWS.toLocaleString("en-US")}. Split it into smaller files.`,
    );
  }
  return { row_count: rows };
}

/** The parts of a file, each small enough for one model call. */
export async function splitFile(
  type: FileType,
  fileName: string,
  bytes: Uint8Array,
): Promise<Chunk[]> {
  if (type === "pdf") {
    const pdf = await loadPdf(bytes);
    const totalPages = pdf.getPageCount();
    return (await splitPdf(pdf)).map((part) => ({ kind: "pdf", fileName, totalPages, ...part }));
  }
  return parseSpreadsheet(bytes).flatMap((sheet) => {
    const chunks: Chunk[] = [];
    for (let start = 0; start < sheet.rows.length; start += ROWS_PER_PART) {
      chunks.push({
        kind: "sheet",
        fileName,
        sheet: sheet.name,
        header: sheet.header,
        rows: sheet.rows.slice(start, start + ROWS_PER_PART),
      });
    }
    return chunks;
  });
}

const clamp = (score: number) => Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
const text = (value: string, max: number) => {
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, max);
  return trimmed === "" ? null : trimmed;
};
const specKey = (key: string) =>
  key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

/** Where an item came from, in the whole document (D3). */
function sourceRef(item: ExtractedItem, chunk: Chunk): Record<string, string | number> {
  if (chunk.kind === "pdf") {
    const within = item.source.page ?? 1;
    const page = chunk.firstPage + Math.min(Math.max(within, 1), chunk.pageCount) - 1;
    return { file: chunk.fileName, page };
  }
  const ref: Record<string, string | number> = { file: chunk.fileName, sheet: chunk.sheet };
  const row = item.source.row ?? chunk.rows[0]?.row;
  if (row) {
    ref.row = row;
    const cells = chunk.rows.find((candidate) => candidate.row === row)?.cells;
    if (cells && cells.length > 0) ref.cells = `${cells[0]!.col}${row}:${cells.at(-1)!.col}${row}`;
  }
  if (item.source.last_row && row && item.source.last_row > row)
    ref.last_row = item.source.last_row;
  return ref;
}

function toItem(
  item: ExtractedItem,
  chunk: Chunk,
  units: UnitIndex,
): Omit<ListItem, "position" | "validation_flags"> | null {
  const name = text(item.name, 500);
  if (!name) return null;
  const specs: Record<string, string> = {};
  for (const { key, value } of item.specs) {
    const cleanKey = specKey(key);
    const cleanValue = text(value, 500);
    if (cleanKey && cleanValue && !(cleanKey in specs)) specs[cleanKey] = cleanValue;
  }
  const quantity =
    item.quantity !== null && Number.isFinite(item.quantity) && item.quantity >= 0
      ? Math.round(item.quantity * 10_000) / 10_000
      : null;
  const unit = text(item.unit, 50);
  const confidence: FieldConfidence = {
    overall: clamp(item.confidence.overall),
    fields: {
      name: clamp(item.confidence.name),
      specs: clamp(item.confidence.specs),
      quantity: clamp(quantity === null && item.quantity !== null ? 0 : item.confidence.quantity),
      unit: clamp(item.confidence.unit),
    },
  };
  return {
    name,
    description: text(item.description, 4000),
    specs,
    quantity,
    unit,
    unit_code: normalizeUnit(unit, units),
    notes: text(item.notes, 2000),
    source_ref: sourceRef(item, chunk),
    confidence,
  };
}

export type ExtractionResult = {
  title: string;
  items: ListItem[];
  issues: ListIssue[];
  model: string;
  usage: Usage;
};

export async function extractChunks(params: {
  chunks: Chunk[];
  fileName: string;
  extractor: Extractor;
  units: UnitIndex;
  signal: AbortSignal;
  onProgress?: (done: number, total: number) => Promise<void>;
}): Promise<ExtractionResult> {
  const { chunks, extractor, units, signal } = params;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const models = new Set<string>();
  const unchecked: Omit<ListItem, "validation_flags">[] = [];
  const issues: ListIssue[] = [];
  let title = "";

  for (const [index, chunk] of chunks.entries()) {
    signal.throwIfAborted();
    const result = await extractor.extract(chunk, signal);
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    usage.costUsd += result.usage.costUsd;
    models.add(result.model);
    title ||= result.output.title.trim();

    for (const item of result.output.items) {
      const converted = toItem(item, chunk, units);
      if (converted) unchecked.push({ ...converted, position: unchecked.length });
    }
    for (const skipped of result.output.skipped) {
      const source: Record<string, string | number> =
        chunk.kind === "pdf"
          ? { file: chunk.fileName, page: chunk.firstPage + Math.max((skipped.page ?? 1) - 1, 0) }
          : {
              file: chunk.fileName,
              sheet: chunk.sheet,
              ...(skipped.row ? { row: skipped.row } : {}),
            };
      issues.push({ code: "unparseable_row", message: skipped.reason.slice(0, 300), source });
    }
    await params.onProgress?.(index + 1, chunks.length);
  }

  return {
    title: (title || params.fileName.replace(/\.[^.]+$/, "")).slice(0, 200),
    items: validateItems(unchecked),
    issues,
    model: [...models].join(", "),
    usage,
  };
}
