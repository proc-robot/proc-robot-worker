import { z } from "zod";
import { measureFile, type FileType } from "../extraction/extract.js";
import type { Services } from "../services.js";
import { assertOrgPath } from "../storage.js";
import { defineHandler, JobFailedError } from "../types.js";

type DocumentRow = {
  id: string;
  file_path: string;
  file_type: FileType;
  status: string;
  job_id: string | null;
};

/**
 * Measures an uploaded document (TASKS.md T1.3.3, D10): pages and scans for
 * a PDF, data rows for a spreadsheet. A database trigger turns them into the
 * credit estimate the member confirms before extraction. Free: no credits.
 */
export function inspectDocument(services: Services) {
  return defineHandler({
    queue: "inspect_document",
    payload: z.object({ document_id: z.uuid() }),
    async run({ job, payload, db, progress, log }) {
      const document = await db(async (client) => {
        const { rows } = await client.query<DocumentRow>(
          `select id, file_path, file_type, status, job_id from public.documents_in where id = $1`,
          [payload.document_id],
        );
        return rows[0];
      });
      if (!document) throw new JobFailedError("This document was deleted.");
      if (document.job_id !== job.id || document.status !== "uploaded") {
        log.info("the document no longer waits for this inspection");
        return { result: { skipped: true } };
      }
      assertOrgPath(document.file_path, job.organizationId);

      await progress(20, "Opening the file…");
      const bytes = await services.files.download("spec-files", document.file_path);
      await progress(60, document.file_type === "pdf" ? "Counting pages…" : "Counting rows…");
      const measured = await measureFile(document.file_type, bytes);

      await db((client) =>
        client.query(
          `update public.documents_in
           set page_count = $2, row_count = $3, scanned = $4, status = 'ready', error = null
           where id = $1 and job_id = $5 and status = 'uploaded'`,
          [
            document.id,
            measured.page_count ?? null,
            measured.row_count ?? null,
            measured.scanned ?? null,
            job.id,
          ],
        ),
      );
      return { result: { ...measured } };
    },
  });
}
