import { z } from "zod";
import { extractChunks, splitFile, type FileType } from "../extraction/extract.js";
import type { Unit } from "../extraction/types.js";
import { buildUnitIndex } from "../extraction/units.js";
import type { Services } from "../services.js";
import { assertOrgPath } from "../storage.js";
import { defineHandler, JobFailedError } from "../types.js";

type DocumentRow = {
  id: string;
  project_id: string;
  file_path: string;
  file_name: string;
  file_type: FileType;
  status: string;
  job_id: string | null;
  estimated_credits: number | null;
};

/**
 * Reads a document into an item list (TASKS.md T1.3.4–T1.3.9): split the
 * file, read each part with Claude, normalize units, validate, and store
 * the list in `needs_review` for a person to check (D6).
 *
 * The credits were reserved by extract_document(); the job reports what it
 * used and the database settles the rest. A failure refunds everything and
 * marks the document failed with the job's message.
 */
export function extractDocument(services: Services) {
  return defineHandler({
    queue: "extract",
    payload: z.object({ document_id: z.uuid() }),
    async run({ job, payload, db, progress, signal, log }) {
      const document = await db(async (client) => {
        const { rows } = await client.query<DocumentRow>(
          `select id, project_id, file_path, file_name, file_type, status, job_id, estimated_credits
           from public.documents_in where id = $1`,
          [payload.document_id],
        );
        return rows[0];
      });
      if (!document) throw new JobFailedError("This document was deleted.");
      if (document.job_id !== job.id) {
        log.info("the document no longer waits for this extraction");
        return { result: { skipped: true }, creditsConsumed: 0 };
      }
      if (document.status === "extracted") {
        // Delivered again after it was done: keep the list already stored.
        return { result: { repeated: true }, creditsConsumed: document.estimated_credits ?? 0 };
      }
      if (document.status !== "extracting") {
        throw new JobFailedError("This document is no longer waiting to be read.");
      }
      assertOrgPath(document.file_path, job.organizationId);

      await progress(5, "Opening the file…");
      const bytes = await services.files.download("spec-files", document.file_path);
      const chunks = await splitFile(document.file_type, document.file_name, bytes);
      if (chunks.length === 0) throw new JobFailedError("This document has nothing to read.");

      const units = await db(async (client) => {
        const { rows } = await client.query<Unit>("select code, name, aliases from public.units");
        return buildUnitIndex(rows);
      });

      await progress(
        10,
        chunks.length > 1 ? `Reading part 1 of ${chunks.length}…` : "Reading the items…",
      );
      const result = await extractChunks({
        chunks,
        fileName: document.file_name,
        extractor: services.extractor,
        units,
        signal,
        onProgress: (done, total) =>
          progress(
            10 + Math.round((80 * done) / total),
            done < total ? `Reading part ${done + 1} of ${total}…` : "Checking the items…",
          ),
      });
      const flagged = result.items.filter((item) => item.validation_flags.length > 0).length;
      log.info("document read", {
        parts: chunks.length,
        items: result.items.length,
        flagged,
        issues: result.issues.length,
        model: result.model,
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        cost_usd: result.usage.costUsd,
      });
      if (result.items.length === 0) {
        throw new JobFailedError(
          "No items were found in this document. Check that it holds a bill of quantities, or add the items by hand.",
        );
      }

      const itemListId = await db(async (client) => {
        // A repeated delivery replaces the unconfirmed list it wrote before.
        await client.query("delete from public.item_lists where document_id = $1", [document.id]);
        const { rows } = await client.query<{ id: string }>(
          `insert into public.item_lists (organization_id, project_id, document_id, title, issues, model)
           values ($1, $2, $3, $4, $5::jsonb, $6)
           returning id`,
          [
            job.organizationId,
            document.project_id,
            document.id,
            result.title,
            JSON.stringify(result.issues),
            result.model,
          ],
        );
        const listId = rows[0]!.id;
        await client.query(
          `insert into public.list_items
             (organization_id, item_list_id, position, name, description, specs, quantity, unit,
              unit_code, notes, source_ref, confidence, validation_flags)
           select $1, $2, x.position, x.name, x.description, x.specs, x.quantity, x.unit,
                  x.unit_code, x.notes, x.source_ref, x.confidence, x.validation_flags
           from jsonb_to_recordset($3::jsonb) as x(
             position integer, name text, description text, specs jsonb, quantity numeric,
             unit text, unit_code text, notes text, source_ref jsonb, confidence jsonb,
             validation_flags jsonb)`,
          [job.organizationId, listId, JSON.stringify(result.items)],
        );
        const updated = await client.query(
          `update public.documents_in set status = 'extracted', error = null
           where id = $1 and job_id = $2 and status = 'extracting'`,
          [document.id, job.id],
        );
        if (updated.rowCount === 0) {
          throw new JobFailedError("This document changed while it was being read. Try again.");
        }
        return listId;
      });

      return {
        result: {
          item_list_id: itemListId,
          items: result.items.length,
          flagged,
          issues: result.issues.length,
        },
        creditsConsumed: document.estimated_credits ?? 0,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: Number(result.usage.costUsd.toFixed(6)),
      };
    },
  });
}
