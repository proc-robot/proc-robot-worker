import { EncryptedPDFError, PDFDict, PDFDocument, PDFName, type PDFPage } from "pdf-lib";
import { JobFailedError } from "../types.js";

/*
 * PDFs (TASKS.md T1.3.5): counted and split here; Claude reads them natively,
 * so page references come from the page each part starts on.
 */

/** Pages per model call: keeps each answer well within the output limit. */
export const PAGES_PER_PART = 10;
/** Raw bytes per part. The API takes 32 MB per request, and base64 adds a third. */
const MAX_PART_BYTES = 20 * 1024 * 1024;

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    if (error instanceof EncryptedPDFError) {
      throw new JobFailedError("This PDF is password-protected. Upload a copy without a password.");
    }
    throw new JobFailedError("This PDF could not be opened. Check that the file isn't damaged.");
  }
}

/** A page with images but no fonts is a scan: its text exists only as pixels. */
function isImageOnly(page: PDFPage): boolean {
  const resources = page.node.Resources();
  if (!resources) return true;
  const fonts = resources.lookupMaybe(PDFName.of("Font"), PDFDict);
  const images = resources.lookupMaybe(PDFName.of("XObject"), PDFDict);
  return (!fonts || fonts.keys().length === 0) && !!images && images.keys().length > 0;
}

/** Page count, and whether most pages are scans (OCR costs double, PLAN.md → Credits). */
export function measurePdf(pdf: PDFDocument): { pageCount: number; scanned: boolean } {
  const pages = pdf.getPages();
  let imageOnly = 0;
  for (const page of pages) {
    try {
      if (isImageOnly(page)) imageOnly++;
    } catch {
      // An odd page structure is treated as text.
    }
  }
  return { pageCount: pages.length, scanned: pages.length > 0 && imageOnly / pages.length > 0.5 };
}

export type PdfPart = { bytes: Uint8Array; firstPage: number; pageCount: number };

async function copy(source: PDFDocument, indices: number[]): Promise<Uint8Array> {
  const part = await PDFDocument.create();
  const pages = await part.copyPages(source, indices);
  pages.forEach((page) => part.addPage(page));
  return part.save();
}

/** Splits the document into parts of up to PAGES_PER_PART pages, smaller when pages are heavy. */
export async function splitPdf(source: PDFDocument): Promise<PdfPart[]> {
  const total = source.getPageCount();
  const parts: PdfPart[] = [];

  async function add(start: number, count: number): Promise<void> {
    const indices = Array.from({ length: count }, (_, i) => start + i);
    const bytes = await copy(source, indices);
    if (bytes.byteLength <= MAX_PART_BYTES) {
      parts.push({ bytes, firstPage: start + 1, pageCount: count });
    } else if (count > 1) {
      const half = Math.ceil(count / 2);
      await add(start, half);
      await add(start + half, count - half);
    } else {
      throw new JobFailedError(
        `Page ${start + 1} of this PDF is too large to read (over 20 MB). Try a smaller scan.`,
      );
    }
  }

  for (let start = 0; start < total; start += PAGES_PER_PART) {
    await add(start, Math.min(PAGES_PER_PART, total - start));
  }
  return parts;
}
