// Blueprint: docs/system-analysis/17-technical-blueprint.md §5.4 -- "Applied by an idempotent
// runner at deploy time, recorded in `__drizzle_migrations`. Never auto-sync."
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createDb, createDbPool } from "../client";

async function main() {
  const pool = createDbPool();
  const db = createDb(pool);
  console.log("Applying migrations from packages/db/migrations ...");
  const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
  await migrate(db, { migrationsFolder });
  console.log("Migrations applied successfully.");
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exitCode = 1;
});
