// Blueprint: docs/system-analysis/17-technical-blueprint.md §5.3 Decision D-03 ("drizzle-kit
// generate -> hand-reviewed SQL migration files, committed to git") and §5.4 ("Schema migrations:
// drizzle-kit generate -> review -> commit as packages/db/migrations/NNNN_description.sql.
// Applied by an idempotent runner at deploy time ... Never auto-sync.") and §5.6 (MySQL 8,
// utf8mb4, the [BINDING] server settings this schema targets).
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "mysql",
  schema: "./schema/index.ts",
  out: "./migrations",
  // §5.6: driver-level connection settings live in the application's pool config, not here --
  // this file only needs a DB URL to introspect against when `drizzle-kit generate` diffs the
  // schema. Read from the environment so no credential is ever committed; `generate` from a
  // schema-only diff does not require a reachable database at all (drizzle-kit falls back to
  // schema-only SQL generation when no `dbCredentials`/live connection is available).
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "mysql://root@localhost:3306/pharmacy_dev",
  },
  strict: true,
  verbose: true,
});
