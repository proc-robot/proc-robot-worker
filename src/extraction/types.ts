import { z } from "zod";

/*
 * Document extraction (TASKS.md T1.3): the shapes passed between the file
 * parsers, the model and the database.
 */

/** One spreadsheet row: its 1-based row number and its non-empty cells by column letter. */
export type SheetRow = { row: number; cells: { col: string; value: string }[] };

export type ParsedSheet = {
  name: string;
  /** The row that names the columns (No, Description, Qty, Unit, …), if one was found. */
  header: SheetRow | null;
  /** Non-empty rows after the header. */
  rows: SheetRow[];
};

/** A part of a document small enough for one model call. */
export type Chunk = (
  | {
      kind: "sheet";
      fileName: string;
      sheet: string;
      header: SheetRow | null;
      rows: SheetRow[];
    }
  | {
      kind: "pdf";
      fileName: string;
      /** A PDF of just these pages. */
      bytes: Uint8Array;
      /** 1-based page number of this part's first page in the whole document. */
      firstPage: number;
      pageCount: number;
      totalPages: number;
    }
) & {
  /**
   * The headings the previous part of the same sheet or PDF ended under, so
   * items before the first heading in this part keep their section.
   */
  previousSection?: string[];
};

/*
 * What the model returns, validated before anything is stored (CLAUDE.md
 * rule 10). Structured outputs only allow closed objects, so specifications
 * come back as key/value pairs and are turned into an object afterwards.
 * Number ranges are not part of the schema the API sees; they are clamped
 * here instead.
 */
const score = z.number().describe("0 to 1: how sure you are this value is read correctly.");

const where = {
  row: z.number().int().nullable().describe("The spreadsheet row (R12 is row 12), or null."),
  page: z.number().int().nullable().describe("The page within the excerpt, from 1, or null."),
};

export const extractedItemSchema = z.object({
  section: z
    .array(z.string())
    .describe(
      "The headings the item sits under, outermost first, as written, e.g. ['B. PERALATAN DAN INSTALASI CCTV', 'I. LANTAI-1 & Site']; empty when there are none.",
    ),
  name: z.string().describe("Short, clean name of the product or work, e.g. 'IP dome camera'."),
  description: z.string().describe("The full description as written, or an empty string."),
  specs: z
    .array(z.object({ key: z.string(), value: z.string() }))
    .describe("Structured specifications with snake_case English keys, values copied exactly."),
  conflicts: z
    .array(
      z.object({
        key: z.string().describe("The specification key, as in specs."),
        values: z.array(z.object({ value: z.string(), ...where })),
      }),
    )
    .describe(
      "Specifications the item's own text gives different values for, each value with where it is written; empty when there are none.",
    ),
  quantity: z
    .number()
    .nullable()
    .describe("The quantity as a plain number, or null if none is given."),
  unit: z.string().describe("The unit as written (pcs, m, lot, unit, set…), or an empty string."),
  notes: z.string().describe("Anything else on the line worth keeping, or an empty string."),
  source: z.object({
    sheet: z.string().nullable(),
    row: z.number().int().nullable().describe("The row number the line starts on (spreadsheets)."),
    last_row: z.number().int().nullable().describe("The last row, if the item spans several rows."),
    page: z.number().int().nullable().describe("The page within this excerpt, from 1 (PDFs)."),
  }),
  confidence: z.object({
    overall: score,
    name: score,
    specs: score,
    quantity: score,
    unit: score,
  }),
});

export const extractionOutputSchema = z.object({
  title: z.string().describe("A short title for the whole list, at most 80 characters."),
  items: z.array(extractedItemSchema),
  skipped: z
    .array(
      z.object({
        row: z.number().int().nullable(),
        page: z.number().int().nullable(),
        reason: z.string(),
      }),
    )
    .describe("Lines that look like items but could not be read."),
});

export type ExtractedItem = z.infer<typeof extractedItemSchema>;
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

/** Token use and cost of one or more model calls. */
export type Usage = { inputTokens: number; outputTokens: number; costUsd: number };

export type ChunkResult = { output: ExtractionOutput; model: string; usage: Usage };

/** Reads one chunk. The Claude extractor in production; a deterministic one for tests. */
export interface Extractor {
  readonly name: string;
  extract(chunk: Chunk, signal: AbortSignal): Promise<ChunkResult>;
}

export type FieldConfidence = { overall: number; fields: Record<string, number> };

export type ValidationFlag = {
  code:
    | "missing_quantity"
    | "missing_unit"
    | "unknown_unit"
    | "duplicate"
    | "conflicting_specs"
    | "low_confidence";
  message: string;
  field?: string;
};

/** An item as it is stored in `list_items`. */
export type ListItem = {
  position: number;
  /** The headings it sits under, joined with " › "; null when none. */
  section: string | null;
  name: string;
  description: string | null;
  specs: Record<string, string>;
  quantity: number | null;
  unit: string | null;
  unit_code: string | null;
  notes: string | null;
  source_ref: Record<string, string | number>;
  confidence: FieldConfidence;
  validation_flags: ValidationFlag[];
};

/** A problem with the document as a whole (`item_lists.issues`). */
export type ListIssue = {
  code: "unparseable_row";
  message: string;
  source: Record<string, string | number>;
};

export type Unit = { code: string; name: string; aliases: string[] };
