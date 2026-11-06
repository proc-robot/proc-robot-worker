import { JobFailedError } from "../types.js";
import type { Chunk, ChunkResult, ExtractedItem, Extractor, SheetRow } from "./types.js";

/*
 * A deterministic stand-in for Claude (EXTRACTION_FAKE=true): it reads
 * spreadsheets by their column names, with no AI and no cost. For the
 * end-to-end tests and local development without an API key — never
 * production.
 */

const ROLES: Record<string, string[]> = {
  number: ["no", "nomor", "number"],
  name: ["description", "desc", "uraian", "item", "items", "pekerjaan", "nama barang", "barang"],
  quantity: ["qty", "quantity", "quantities", "volume", "vol", "jumlah"],
  unit: ["unit", "uom", "satuan", "sat"],
  brand: ["brand", "merk", "merek"],
  model: ["type", "tipe", "model"],
  specification: ["specification", "specifications", "spec", "spesifikasi"],
  notes: ["remark", "remarks", "keterangan", "notes"],
};

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function columnRoles(header: SheetRow): Map<string, string> {
  const roles = new Map<string, string>();
  for (const cell of header.cells) {
    const text = normalize(cell.value);
    const role = Object.entries(ROLES).find(([, words]) => words.includes(text))?.[0];
    if (role && ![...roles.values()].includes(role)) roles.set(cell.col, role);
  }
  return roles;
}

export class FakeExtractor implements Extractor {
  readonly name = "fake";

  async extract(chunk: Chunk): Promise<ChunkResult> {
    if (chunk.kind === "pdf") {
      throw new JobFailedError(
        "Reading PDFs needs the AI model, which isn't set up on this worker.",
      );
    }
    const roles = chunk.header ? columnRoles(chunk.header) : new Map<string, string>();
    const items: ExtractedItem[] = [];
    let section = chunk.previousSection ?? [];
    for (const row of chunk.rows) {
      const value = (role: string) =>
        row.cells.find((cell) => roles.get(cell.col) === role)?.value ?? "";
      const name = value("name");
      if (!name) continue;
      // A heading: numbered "A." (a section) or "II." (a part of one), with no quantity or unit.
      const number = value("number").trim();
      if (!value("quantity") && !value("unit") && /^[A-Z]{1,4}\.?$/.test(number)) {
        const heading = `${number} ${name}`;
        const part = /^[IVX]+\.?$/.test(number) && section.length > 0;
        section = part ? [section[0]!, heading] : [heading];
        continue;
      }
      const quantityText = value("quantity").replace(/,/g, "");
      const quantity =
        quantityText && Number.isFinite(Number(quantityText)) ? Number(quantityText) : null;
      const specs = (["brand", "model", "specification"] as const)
        .filter((role) => value(role))
        .map((role) => ({ key: role, value: value(role) }));
      items.push({
        section,
        name,
        description: name,
        specs,
        conflicts: [],
        quantity,
        unit: value("unit"),
        notes: value("notes"),
        source: { sheet: chunk.sheet, row: row.row, last_row: null, page: null },
        confidence: {
          overall: quantity === null ? 0.5 : 0.95,
          name: 0.95,
          specs: 0.95,
          quantity: quantity === null ? 0.3 : 0.95,
          unit: 0.95,
        },
      });
    }
    return {
      output: { title: chunk.fileName.replace(/\.[^.]+$/, ""), items, skipped: [] },
      model: "fake",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
  }
}
