import { PDFDocument, StandardFonts } from "pdf-lib";
import * as XLSX from "xlsx";
import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeExtractor, costUsd, needsSecondReading } from "../src/extraction/claude.js";
import { extractChunks, measureFile, splitFile } from "../src/extraction/extract.js";
import { FakeExtractor } from "../src/extraction/fake.js";
import { measurePdf, splitPdf } from "../src/extraction/pdf.js";
import { formatRow, parseSpreadsheet } from "../src/extraction/sheet.js";
import type { Chunk, ExtractedItem, ExtractionOutput, Extractor } from "../src/extraction/types.js";
import { buildUnitIndex, normalizeUnit } from "../src/extraction/units.js";
import { validateItems } from "../src/extraction/validate.js";
import { silentLogger } from "../src/log.js";
import { JobFailedError } from "../src/types.js";

/** Unit tests of the extraction pipeline (TASKS.md T1.3.4–T1.3.9); no database, no AI. */

const UNITS = buildUnitIndex([
  { code: "pcs", name: "Pieces", aliases: ["pc", "unit", "units", "bh", "ea"] },
  { code: "m", name: "Metre", aliases: ["meter", "mtr"] },
  { code: "m2", name: "Square metre", aliases: ["sqm"] },
  { code: "lot", name: "Lot", aliases: ["lots"] },
]);

function workbook(sheets: Record<string, (string | number | null)[][]>, merges: XLSX.Range[] = []) {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    if (merges.length) sheet["!merges"] = merges;
    XLSX.utils.book_append_sheet(book, sheet, name);
  }
  return new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

const BOQ = workbook(
  {
    BOQ: [
      ["PT Kigen — CCTV Office Tower"],
      [],
      ["No", "Description", "Brand", "Qty", "Unit"],
      [1, "IP dome camera 4MP", "Hikvision", 24, "unit"],
      [2, "NVR 32 channel", null, 1, "set"],
      [null, "Subtotal", null, null, null],
    ],
  },
  [XLSX.utils.decode_range("C4:C5")],
);

async function pdfWithPages(textPages: number, imagePages: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < textPages; i++) {
    pdf.addPage().drawText(`Item ${i + 1}`, { x: 50, y: 700, font, size: 12 });
  }
  // A 1×1 PNG stands in for a scanned page.
  const png = await pdf.embedPng(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  for (let i = 0; i < imagePages; i++) {
    pdf.addPage().drawImage(png, { x: 0, y: 0, width: 600, height: 800 });
  }
  return pdf.save();
}

const item = (overrides: Partial<ExtractedItem> = {}): ExtractedItem => ({
  name: "IP dome camera",
  description: "IP dome camera 4MP",
  specs: [{ key: "Resolution", value: "4 MP" }],
  quantity: 24,
  unit: "unit",
  notes: "",
  source: { sheet: null, row: null, last_row: null, page: null },
  confidence: { overall: 0.95, name: 0.95, specs: 0.95, quantity: 0.95, unit: 0.95 },
  ...overrides,
});

describe("spreadsheets", () => {
  it("finds the header, keeps row numbers and fills values merged down", () => {
    const [sheet] = parseSpreadsheet(BOQ);
    expect(sheet!.name).toBe("BOQ");
    expect(sheet!.header?.row).toBe(3);
    expect(sheet!.rows.map((row) => row.row)).toEqual([4, 5, 6]);
    expect(formatRow(sheet!.rows[1]!)).toBe(
      "R5 | A=2 | B=NVR 32 channel | C=Hikvision | D=1 | E=set",
    );
  });

  it("reads CSV files too, and counts their rows for the estimate", async () => {
    const csv = new TextEncoder().encode(
      "Item,Qty,Unit\nCat6 cable,305,m\nRJ45 connector,200,pcs\n",
    );
    expect(await measureFile("csv", csv)).toEqual({ row_count: 2 });
  });

  it("refuses a spreadsheet with nothing to read", async () => {
    await expect(measureFile("xlsx", workbook({ Empty: [] }))).rejects.toThrow(
      "This spreadsheet has no rows to read.",
    );
  });

  it("splits into parts per sheet", async () => {
    const rows = [
      ["Description", "Qty"],
      ...Array.from({ length: 170 }, (_, i) => [`Item ${i}`, i]),
    ];
    const chunks = await splitFile(
      "xlsx",
      "big.xlsx",
      workbook({
        A: rows,
        B: [
          ["Item", "Qty"],
          ["x", 1],
        ],
      }),
    );
    expect(
      chunks.map((chunk) => (chunk.kind === "sheet" ? `${chunk.sheet}:${chunk.rows.length}` : "")),
    ).toEqual(["A:80", "A:80", "A:10", "B:1"]);
  });
});

describe("PDFs", () => {
  it("counts pages and recognizes scans", async () => {
    expect(measurePdf(await PDFDocument.load(await pdfWithPages(3, 1)))).toEqual({
      pageCount: 4,
      scanned: false,
    });
    expect(measurePdf(await PDFDocument.load(await pdfWithPages(1, 3)))).toEqual({
      pageCount: 4,
      scanned: true,
    });
  });

  it("splits into parts of ten pages that remember where they start", async () => {
    const parts = await splitPdf(await PDFDocument.load(await pdfWithPages(23, 0)));
    expect(parts.map((part) => [part.firstPage, part.pageCount])).toEqual([
      [1, 10],
      [11, 10],
      [21, 3],
    ]);
  });

  it("refuses a file that is not a PDF", async () => {
    await expect(measureFile("pdf", new TextEncoder().encode("not a pdf"))).rejects.toBeInstanceOf(
      JobFailedError,
    );
  });
});

describe("units", () => {
  it("maps what documents write to the units table's codes", () => {
    expect(normalizeUnit("Unit", UNITS)).toBe("pcs");
    expect(normalizeUnit("bh.", UNITS)).toBe("pcs");
    expect(normalizeUnit("Mtr", UNITS)).toBe("m");
    expect(normalizeUnit("m²", UNITS)).toBe("m2");
    expect(normalizeUnit("lots", UNITS)).toBe("lot");
    expect(normalizeUnit("pail", UNITS)).toBeNull();
    expect(normalizeUnit(null, UNITS)).toBeNull();
  });
});

describe("validation", () => {
  const base = {
    description: null,
    notes: null,
    source_ref: {},
    confidence: { overall: 0.95, fields: { name: 0.95, specs: 0.95, quantity: 0.95, unit: 0.95 } },
  };

  it("flags missing and unknown values, duplicates, conflicts and doubtful readings", () => {
    const items = validateItems([
      {
        ...base,
        position: 0,
        name: "Laptop",
        specs: { cpu: "Core i5" },
        quantity: 10,
        unit: "unit",
        unit_code: "pcs",
      },
      {
        ...base,
        position: 1,
        name: "Laptop",
        specs: { cpu: "Core i7" },
        quantity: 2,
        unit: "unit",
        unit_code: "pcs",
      },
      {
        ...base,
        position: 2,
        name: "laptop",
        specs: { cpu: "core i5" },
        quantity: 10,
        unit: "unit",
        unit_code: "pcs",
      },
      {
        ...base,
        position: 3,
        name: "Cable",
        specs: {},
        quantity: null,
        unit: null,
        unit_code: null,
      },
      {
        ...base,
        position: 4,
        name: "Paint",
        specs: {},
        quantity: 5,
        unit: "pail",
        unit_code: null,
      },
      {
        ...base,
        position: 5,
        name: "Switch",
        specs: {},
        quantity: 1,
        unit: "unit",
        unit_code: "pcs",
        confidence: { overall: 0.7, fields: { name: 0.9, specs: 0.9, quantity: 0.4, unit: 0.9 } },
      },
    ]);
    const codes = items.map((entry) => entry.validation_flags.map((flag) => flag.code));
    expect(codes).toEqual([
      [],
      ["conflicting_specs"],
      ["duplicate"],
      ["missing_quantity", "missing_unit"],
      ["unknown_unit"],
      ["low_confidence"],
    ]);
    expect(items[1]!.validation_flags[0]!.message).toBe(
      "Same name as item 1, but cpu differs (Core i5 vs Core i7).",
    );
    expect(items[5]!.validation_flags[0]).toMatchObject({ field: "quantity" });

    // A missing quantity is not also "uncertain".
    const [missing] = validateItems([
      {
        ...base,
        position: 0,
        name: "Patch panel",
        specs: {},
        quantity: null,
        unit: "pcs",
        unit_code: "pcs",
        confidence: { overall: 0.9, fields: { name: 0.9, specs: 0.9, quantity: 0.3, unit: 0.9 } },
      },
    ]);
    expect(missing!.validation_flags.map((flag) => flag.code)).toEqual(["missing_quantity"]);
  });
});

describe("extracting parts", () => {
  const stub = (outputs: ExtractionOutput[]): Extractor => {
    let call = 0;
    return {
      name: "stub",
      extract: async () => ({
        output: outputs[call++]!,
        model: "claude-haiku-5-5",
        usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.0002 },
      }),
    };
  };

  it("points each item back to its page in the whole document and cleans the answer up", async () => {
    const chunks: Chunk[] = [
      {
        kind: "pdf",
        fileName: "specs.pdf",
        bytes: new Uint8Array(),
        firstPage: 1,
        pageCount: 10,
        totalPages: 13,
      },
      {
        kind: "pdf",
        fileName: "specs.pdf",
        bytes: new Uint8Array(),
        firstPage: 11,
        pageCount: 3,
        totalPages: 13,
      },
    ];
    const result = await extractChunks({
      chunks,
      fileName: "specs.pdf",
      extractor: stub([
        {
          title: "CCTV BOQ",
          items: [item({ source: { sheet: null, row: null, last_row: null, page: 2 } })],
          skipped: [],
        },
        {
          title: "",
          items: [
            item({
              name: "  NVR  32 channel ",
              specs: [
                { key: "Channels", value: "32" },
                { key: "channels", value: "64" },
                { key: "Brand", value: " " },
              ],
              quantity: -1,
              unit: "set",
              source: { sheet: null, row: null, last_row: null, page: 3 },
            }),
          ],
          skipped: [{ row: null, page: 1, reason: "The price column is unreadable." }],
        },
      ]),
      units: UNITS,
      signal: new AbortController().signal,
    });

    expect(result.title).toBe("CCTV BOQ");
    expect(result.items.map((entry) => entry.source_ref)).toEqual([
      { file: "specs.pdf", page: 2 },
      { file: "specs.pdf", page: 13 },
    ]);
    expect(result.items[0]).toMatchObject({
      specs: { resolution: "4 MP" },
      unit_code: "pcs",
      position: 0,
    });
    expect(result.items[1]).toMatchObject({
      name: "NVR 32 channel",
      specs: { channels: "32" },
      quantity: null,
      unit_code: null,
      position: 1,
    });
    expect(result.items[1]!.validation_flags.map((flag) => flag.code)).toContain(
      "missing_quantity",
    );
    expect(result.issues).toEqual([
      {
        code: "unparseable_row",
        message: "The price column is unreadable.",
        source: { file: "specs.pdf", page: 11 },
      },
    ]);
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 400, costUsd: 0.0004 });
    expect(result.model).toBe("claude-haiku-5-5");
  });

  it("reads a spreadsheet by its column names without AI (the test extractor)", async () => {
    const chunks = await splitFile("xlsx", "BOQ Tower.xlsx", BOQ);
    const result = await extractChunks({
      chunks,
      fileName: "BOQ Tower.xlsx",
      extractor: new FakeExtractor(),
      units: UNITS,
      signal: new AbortController().signal,
    });
    expect(result.title).toBe("BOQ Tower");
    expect(
      result.items.map((entry) => [entry.name, entry.quantity, entry.unit_code, entry.specs]),
    ).toEqual([
      ["IP dome camera 4MP", 24, "pcs", { brand: "Hikvision" }],
      ["NVR 32 channel", 1, null, { brand: "Hikvision" }],
      ["Subtotal", null, null, {}],
    ]);
    expect(result.items[0]!.source_ref).toEqual({
      file: "BOQ Tower.xlsx",
      sheet: "BOQ",
      row: 4,
      cells: "A4:E4",
    });
  });
});

describe("Claude", () => {
  const sheetChunk: Chunk = {
    kind: "sheet",
    fileName: "boq.xlsx",
    sheet: "BOQ",
    header: null,
    rows: [{ row: 4, cells: [{ col: "A", value: "Camera" }] }],
  };
  const answer = (overall: number, extra: Record<string, unknown> = {}) => ({
    model: "claude-haiku-5-5",
    stop_reason: "end_turn",
    usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
    parsed_output: {
      title: "BOQ",
      items: [item({ confidence: { ...item().confidence, overall } })],
      skipped: [],
    },
    ...extra,
  });
  const client = (...responses: unknown[]) => {
    const parse = vi.fn();
    responses.forEach((response) => parse.mockResolvedValueOnce(response));
    return { parse, client: { beta: { messages: { parse } } } as unknown as Anthropic };
  };
  const extractor = (anthropic: Anthropic) =>
    new ClaudeExtractor(
      anthropic,
      { primary: "claude-haiku-5-5", review: "claude-opus-5-5" },
      silentLogger,
    );

  it("prices the tokens per model", () => {
    expect(costUsd("claude-haiku-5-5", 1_000_000, 100_000)).toBeCloseTo(0.5 + 0.25);
    expect(costUsd("claude-haiku-5-5", 50_000, 10_000)).toBeCloseTo(0.005 + 0.005);
    expect(costUsd("claude-opus-5-5", 1_000_000, 100_000)).toBeCloseTo(4 + 2);
  });

  it("keeps a confident first reading", async () => {
    const { parse, client: anthropic } = client(answer(0.95));
    const result = await extractor(anthropic).extract(sheetChunk, new AbortController().signal);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls[0]![0]).toMatchObject({ model: "claude-haiku-5-5" });
    expect(parse.mock.calls[0]![0]).not.toHaveProperty("fallbacks");
    expect(result.model).toBe("claude-haiku-5-5");
  });

  it("reads an uncertain part again with the review model, with the refusal fallback", async () => {
    const { parse, client: anthropic } = client(
      answer(0.4),
      answer(0.9, { model: "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 100 } }),
    );
    const result = await extractor(anthropic).extract(sheetChunk, new AbortController().signal);
    expect(parse.mock.calls[1]![0]).toMatchObject({
      model: "claude-opus-5-5",
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
    });
    expect(result.model).toBe("claude-opus-5-5");
    expect(result.usage.inputTokens).toBe(1_001_000);
  });

  it("fails for the user when neither model can read the part", async () => {
    const { client: anthropic } = client(
      answer(0.9, { stop_reason: "refusal", parsed_output: null }),
      answer(0.9, { stop_reason: "max_tokens", parsed_output: null }),
    );
    await expect(
      extractor(anthropic).extract(sheetChunk, new AbortController().signal),
    ).rejects.toThrow(/too many items to read at once/);
  });

  it("asks for a second reading when most items are uncertain", () => {
    const output = (scores: number[]): ExtractionOutput => ({
      title: "",
      skipped: [],
      items: scores.map((overall) => item({ confidence: { ...item().confidence, overall } })),
    });
    expect(needsSecondReading(output([0.9, 0.95, 0.85]))).toBe(false);
    expect(needsSecondReading(output([0.9, 0.5, 0.6]))).toBe(true);
    expect(needsSecondReading({ title: "", items: [], skipped: [] })).toBe(false);
  });
});
