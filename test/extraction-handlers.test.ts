import { existsSync } from "node:fs";
import pg from "pg";
import * as XLSX from "xlsx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, withOrg, type Pool } from "../src/db.js";
import { FakeExtractor } from "../src/extraction/fake.js";
import type { Extractor } from "../src/extraction/types.js";
import { extractDocument } from "../src/handlers/extract.js";
import { inspectDocument } from "../src/handlers/inspect-document.js";
import { jobs } from "../src/jobs.js";
import { silentLogger } from "../src/log.js";
import type { Services } from "../src/services.js";
import type { FileStore } from "../src/storage.js";
import {
  JobFailedError,
  type JobContext,
  type JobHandler,
  type JobOutcome,
  type JobRef,
} from "../src/types.js";

/**
 * The extraction handlers (TASKS.md T1.3) against the local database, as
 * procrobot_worker. Handlers are called directly, with jobs created as rows
 * only (no queue message), so a dev worker cannot pick them up; files come
 * from an in-memory store instead of Supabase Storage.
 */
if (existsSync(".env")) process.loadEnvFile(".env");
const WORKER_URL =
  process.env.DATABASE_URL ?? "postgresql://procrobot_worker:worker-local@127.0.0.1:54322/postgres";
const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

let admin: pg.Pool;
let worker: Pool;
let orgA: string;
let orgB: string;
let project: string;
const files = new Map<string, Uint8Array>();
const store: FileStore = {
  async download(_bucket, path) {
    const bytes = files.get(path);
    if (!bytes) throw new JobFailedError("The file is no longer in storage. Upload it again.");
    return bytes;
  },
};
const services = (extractor: Extractor = new FakeExtractor()): Services => ({
  files: store,
  extractor,
});

function workbook(rows: (string | number | null)[][]): Uint8Array {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "BOQ");
  return new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

/** A job row as the RPCs create it, but without a queue message. */
async function jobRow(
  org: string,
  queue: string,
  documentId: string,
  credits = 0,
): Promise<JobRef> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into public.ai_jobs (organization_id, queue, payload, credits_reserved)
     values ($1, $2, $3::jsonb, $4) returning id`,
    [org, queue, JSON.stringify({ document_id: documentId }), credits],
  );
  return { id: rows[0]!.id, queue, organizationId: org, attempt: 1 };
}

/** Runs a handler the way the runner does, then records the outcome on the job. */
async function run(handler: JobHandler<unknown>, job: JobRef, documentId: string) {
  const context: JobContext<unknown> = {
    job,
    payload: { document_id: documentId },
    progress: (percent, message) => jobs.progress(worker, job, percent, message).then(() => {}),
    db: (fn) => withOrg(worker, job.organizationId, fn),
    signal: new AbortController().signal,
    workerId: "test-worker",
    log: silentLogger,
  };
  try {
    const outcome: JobOutcome = (await handler.run(context)) ?? {};
    await jobs.succeeded(worker, job, outcome);
    return outcome;
  } catch (error) {
    if (!(error instanceof JobFailedError)) throw error;
    await jobs.failed(worker, job, error.message);
    return null;
  }
}

async function document(id: string) {
  const { rows } = await admin.query("select * from public.documents_in where id = $1", [id]);
  return rows[0];
}

const balance = async (org: string) =>
  (
    await admin.query<{ plan_credits: number }>(
      "select plan_credits from public.credit_balances where organization_id = $1",
      [org],
    )
  ).rows[0]!.plan_credits;

/** An uploaded document waiting for inspection, with its job. */
async function upload(name: string, bytes: Uint8Array, org = orgA) {
  const path = `${org}/${project}/${Date.now()}-${name}`;
  files.set(path, bytes);
  const { rows } = await admin.query<{ id: string }>(
    `insert into public.documents_in (organization_id, project_id, file_path, file_name, file_type, file_size)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [org, project, path, name, name.split(".").pop(), bytes.byteLength],
  );
  const id = rows[0]!.id;
  const job = await jobRow(org, "inspect_document", id);
  await admin.query("update public.documents_in set job_id = $2 where id = $1", [id, job.id]);
  return { id, job };
}

/** What extract_document() does: reserve the estimate and hand the document to an extract job. */
async function startExtraction(id: string, org = orgA): Promise<JobRef> {
  const { estimated_credits: credits } = await document(id);
  const job = await jobRow(org, "extract", id, credits);
  await admin.query("select private.reserve_credits($1, $2, $3, 'Test extraction')", [
    org,
    credits,
    job.id,
  ]);
  await admin.query(
    "update public.documents_in set status = 'extracting', job_id = $2 where id = $1",
    [id, job.id],
  );
  return job;
}

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  worker = createPool(WORKER_URL, 4, silentLogger);
  const suffix = Date.now().toString(36);
  const { rows } = await admin.query<{ id: string }>(
    `insert into public.organizations (name, slug, country, default_currency)
     values ($1, $2, 'SG', 'SGD'), ($3, $4, 'SG', 'SGD') returning id`,
    [
      `Extract Test A ${suffix}`,
      `extract-test-a-${suffix}`,
      `Extract Test B ${suffix}`,
      `extract-test-b-${suffix}`,
    ],
  );
  orgA = rows[0]!.id;
  orgB = rows[1]!.id;
  const projects = await admin.query<{ id: string }>(
    `insert into public.projects (organization_id, name, delivery_country) values ($1, 'CCTV', 'SG') returning id`,
    [orgA],
  );
  project = projects.rows[0]!.id;
});

afterAll(async () => {
  await admin.query("delete from public.organizations where id in ($1, $2)", [orgA, orgB]);
  await worker.end();
  await admin.end();
});

const BOQ = workbook([
  ["No", "Description", "Brand", "Qty", "Unit"],
  [1, "IP dome camera 4MP", "Hikvision", 24, "unit"],
  [2, "NVR 32 channel", "Hikvision", 1, "set"],
  [3, "Cat6 cable", null, 305, "Mtr"],
]);

describe("inspecting and extracting a document", () => {
  it("measures the upload, then extracts its items and keeps the credits it used", async () => {
    const { id, job } = await upload("BOQ Tower.xlsx", BOQ);
    await run(inspectDocument(services()) as JobHandler<unknown>, job, id);
    expect(await document(id)).toMatchObject({
      status: "ready",
      row_count: 3,
      estimated_credits: 1,
    });

    const before = await balance(orgA);
    const extractJob = await startExtraction(id);
    expect(await balance(orgA)).toBe(before - 1);
    const outcome = await run(extractDocument(services()) as JobHandler<unknown>, extractJob, id);
    expect(outcome?.creditsConsumed).toBe(1);

    expect(await document(id)).toMatchObject({ status: "extracted", error: null });
    const { rows: lists } = await admin.query(
      "select id, title, status, model, issues from public.item_lists where document_id = $1",
      [id],
    );
    expect(lists).toEqual([
      expect.objectContaining({
        title: "BOQ Tower",
        status: "needs_review",
        model: "fake",
        issues: [],
      }),
    ]);
    const { rows: items } = await admin.query(
      `select position, name, quantity::float as quantity, unit, unit_code, specs, source_ref
       from public.list_items where item_list_id = $1 order by position`,
      [lists[0]!.id],
    );
    expect(items).toEqual([
      expect.objectContaining({
        name: "IP dome camera 4MP",
        quantity: 24,
        unit: "unit",
        unit_code: "pcs",
        specs: { brand: "Hikvision" },
      }),
      expect.objectContaining({
        name: "NVR 32 channel",
        quantity: 1,
        unit: "set",
        unit_code: "set",
      }),
      expect.objectContaining({ name: "Cat6 cable", quantity: 305, unit: "Mtr", unit_code: "m" }),
    ]);
    expect(items[0]!.source_ref).toEqual({
      file: "BOQ Tower.xlsx",
      sheet: "BOQ",
      row: 2,
      cells: "A2:E2",
    });

    const { rows: settled } = await admin.query(
      "select credits_consumed, credits_settled_at from public.ai_jobs where id = $1",
      [extractJob.id],
    );
    expect(settled[0]).toMatchObject({ credits_consumed: 1, credits_settled_at: expect.any(Date) });
    expect(await balance(orgA)).toBe(before - 1);

    // Delivered again: the stored list is kept, nothing is doubled.
    const again = await run(extractDocument(services()) as JobHandler<unknown>, extractJob, id);
    expect(again?.result).toEqual({ repeated: true });
    const count = await admin.query(
      "select count(*)::int as n from public.item_lists where document_id = $1",
      [id],
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  it("fails a document without items, with a reason, and refunds its credits", async () => {
    const { id, job } = await upload(
      "notes.xlsx",
      workbook([["Notes"], ["Delivery within 4 weeks"]]),
    );
    await run(inspectDocument(services()) as JobHandler<unknown>, job, id);
    const before = await balance(orgA);
    const extractJob = await startExtraction(id);
    await run(extractDocument(services()) as JobHandler<unknown>, extractJob, id);

    expect(await document(id)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/^No items were found in this document/),
    });
    expect(await balance(orgA)).toBe(before);
  });

  it("refuses a document of another organization than the job's", async () => {
    const { id } = await upload("boq.xlsx", BOQ);
    const foreignJob = await jobRow(orgB, "inspect_document", id);
    await run(inspectDocument(services()) as JobHandler<unknown>, foreignJob, id);
    const { rows } = await admin.query("select status, error from public.ai_jobs where id = $1", [
      foreignJob.id,
    ]);
    expect(rows[0]).toEqual({ status: "failed", error: "This document was deleted." });
    expect((await document(id)).status).toBe("uploaded");
  });

  it("fails the inspection of an unreadable PDF for the user", async () => {
    const { id, job } = await upload("scan.pdf", new TextEncoder().encode("not really a pdf"));
    await run(inspectDocument(services()) as JobHandler<unknown>, job, id);
    expect(await document(id)).toMatchObject({
      status: "failed",
      error: "This PDF could not be opened. Check that the file isn't damaged.",
      estimated_credits: null,
    });
  });
});
