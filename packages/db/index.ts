// The package's public entry point for OTHER packages/apps to import (e.g. apps/api).
//
// Why this file exists separately from schema/index.ts + client.ts: this package's schema/*.ts
// files deliberately use extensionless relative imports (see tsconfig.json's documented Bundler
// override) because drizzle-kit's schema loader breaks on explicit `./tenant.js` specifiers
// (verified empirically -- MODULE_NOT_FOUND). apps/api runs on ts-node/esm (required for
// NestJS's emitDecoratorMetadata, see apps/api/scripts/register-loader.mjs), whose resolver does
// not honor extensionless Bundler-style imports either -- the same mismatch documented in
// packages/db/scripts/migrate.ts's history, just from the consumer side this time. Bundling this
// one entry point with tsup (esbuild) resolves and inlines every internal relative import into a
// single self-contained dist/index.js + dist/index.d.ts, so apps/api's tsc (NodeNext) and
// ts-node/esm both consume a clean, ordinary compiled module -- the extensionless convention
// never leaves this package's own source tree.
export * from "./schema/index";
export { closeDb, createDb, createDbPool, getDb } from "./client";
