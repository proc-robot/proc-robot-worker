import * as XLSX from "xlsx";
import { JobFailedError } from "../types.js";
import type { ParsedSheet, SheetRow } from "./types.js";

/*
 * Spreadsheets (TASKS.md T1.3.4): .xlsx, .xls and .csv through SheetJS,
 * keeping each value's sheet, row and column so every extracted item points
 * back to where it came from (D3).
 */

/** Words that name a BOQ/RAB column, in English and Indonesian. */
const HEADER_WORDS = [
  "no",
  "item",
  "items",
  "description",
  "desc",
  "uraian",
  "pekerjaan",
  "nama barang",
  "barang",
  "specification",
  "specifications",
  "spec",
  "spesifikasi",
  "qty",
  "quantity",
  "quantities",
  "volume",
  "vol",
  "jumlah",
  "unit",
  "uom",
  "satuan",
  "sat",
  "brand",
  "merk",
  "merek",
  "type",
  "tipe",
  "model",
  "remark",
  "remarks",
  "keterangan",
  "price",
  "harga",
  "unit price",
  "harga satuan",
  "total",
];

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** How many cells of a row read like column names. */
function headerScore(row: SheetRow): number {
  return row.cells.filter((cell) => {
    const text = normalize(cell.value);
    return text.length > 0 && text.length <= 30 && HEADER_WORDS.includes(text);
  }).length;
}

/** A cell's text: numbers as written by the machine (no thousands separators), the rest as displayed. */
function cellText(cell: XLSX.CellObject): string {
  if (cell.t === "n" && typeof cell.v === "number") return String(cell.v);
  if (cell.t === "b") return cell.v ? "TRUE" : "FALSE";
  const text = cell.w ?? (cell.v === undefined || cell.v === null ? "" : String(cell.v));
  return text.replace(/\s+/g, " ").trim();
}

/** The rows of one worksheet. A value merged down several rows is repeated on each of them. */
function readRows(sheet: XLSX.WorkSheet): SheetRow[] {
  if (!sheet["!ref"]) return [];
  const range = XLSX.utils.decode_range(sheet["!ref"]);

  // Vertical merges (a brand or section spanning rows): give every row the value.
  const filled = new Map<string, string>();
  for (const merge of sheet["!merges"] ?? []) {
    if (merge.e.r === merge.s.r) continue;
    const origin = sheet[XLSX.utils.encode_cell(merge.s)] as XLSX.CellObject | undefined;
    if (!origin) continue;
    const value = cellText(origin);
    for (let r = merge.s.r + 1; r <= merge.e.r; r++) {
      filled.set(XLSX.utils.encode_cell({ r, c: merge.s.c }), value);
    }
  }

  const rows: SheetRow[] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cells: SheetRow["cells"] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const address = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[address] as XLSX.CellObject | undefined;
      const value = cell ? cellText(cell) : (filled.get(address) ?? "");
      if (value !== "") cells.push({ col: XLSX.utils.encode_col(c), value });
    }
    if (cells.length > 0) rows.push({ row: r + 1, cells });
  }
  return rows;
}

/** The header is the first of the opening rows with at least two column names. */
function splitHeader(rows: SheetRow[]): { header: SheetRow | null; rows: SheetRow[] } {
  const index = rows.slice(0, 30).findIndex((row) => headerScore(row) >= 2);
  if (index === -1) return { header: null, rows };
  return { header: rows[index]!, rows: rows.slice(index + 1) };
}

export function parseSpreadsheet(bytes: Uint8Array): ParsedSheet[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "array", cellDates: true, dense: false });
  } catch {
    throw new JobFailedError(
      "This spreadsheet could not be opened. Check that the file isn't damaged.",
    );
  }
  return workbook.SheetNames.flatMap((name) => {
    const sheet = workbook.Sheets[name];
    if (!sheet || sheet["!type"] === "chart") return [];
    const { header, rows } = splitHeader(readRows(sheet));
    return rows.length > 0 ? [{ name, header, rows }] : [];
  });
}

/** Rows that will be read, across all sheets: what the credit estimate counts. */
export const dataRowCount = (sheets: ParsedSheet[]) =>
  sheets.reduce((total, sheet) => total + sheet.rows.length, 0);

/** "R12 | A=1 | B=Dome camera 4 MP | C=24 | D=unit": how rows are shown to the model. */
export const formatRow = (row: SheetRow) =>
  [`R${row.row}`, ...row.cells.map((cell) => `${cell.col}=${cell.value}`)].join(" | ");
