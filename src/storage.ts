import { createClient } from "@supabase/supabase-js";
import { JobFailedError } from "./types.js";

/*
 * Files in Supabase Storage (uploaded specification documents; generated
 * documents from T1.9). Storage has no database role the worker could use,
 * so this one client holds the project's secret key — for Storage only,
 * never for the database (CLAUDE.md rule 1). Handlers only ever pass paths
 * read through their job's org-scoped connection, and check the org prefix.
 */
export interface FileStore {
  download(bucket: string, path: string): Promise<Uint8Array>;
}

export function createFileStore(url: string, secretKey: string): FileStore {
  const client = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async download(bucket, path) {
      const { data, error } = await client.storage.from(bucket).download(path);
      if (error) {
        const status = (error as { status?: number; statusCode?: string | number }).status;
        if (status === 400 || status === 404) {
          throw new JobFailedError("The file is no longer in storage. Upload it again.");
        }
        throw error;
      }
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}

/** When SUPABASE_URL / SUPABASE_SECRET_KEY are not set: jobs that need files fail at once. */
export const unavailableFileStore: FileStore = {
  download() {
    throw new JobFailedError(
      "Proc-Robot can't open uploaded files right now. Please try again later.",
    );
  },
};

/** Paths in tenant buckets start with the organization's id. */
export function assertOrgPath(path: string, organizationId: string): void {
  if (!path.startsWith(`${organizationId}/`)) {
    throw new Error("A file path outside the job's organization");
  }
}
