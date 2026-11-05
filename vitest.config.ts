import { defineConfig } from "vitest/config";

/**
 * Integration tests against the local Supabase database (`npm run db:start`
 * in ../proc-robot-web). They run one file at a time: they share the database.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
