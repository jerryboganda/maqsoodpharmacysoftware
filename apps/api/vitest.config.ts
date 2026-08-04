// vitest + NestJS gotcha (same class of problem this repo already solved for `dev`/`start`, see
// scripts/register-loader.mjs's own header comment): NestJS's DI resolves constructor-injected
// dependencies via `emitDecoratorMetadata`-generated `reflect-metadata`. Vitest's default
// transform is esbuild, which -- like `tsx` -- does NOT implement `emitDecoratorMetadata` at all
// (a known esbuild limitation, not a bug); every `@Injectable()` constructor parameter would
// resolve as `undefined` and Nest would throw "Nest can't resolve dependencies" for nearly every
// provider in this app. `unplugin-swc` swaps vitest's transform to SWC, which DOES implement
// decorator metadata emission (`jsc.transform.decoratorMetadata` below) -- this is the standard,
// documented fix for "NestJS + Vitest" (NestJS's own testing docs recommend it as the Vitest
// alternative to the Jest+ts-jest default), not a workaround invented for this repo.
import { loadEnvFile } from "node:process";
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Local dev convenience only (mirrors `dev`/`start`'s own `node --env-file=../../.env`, which
// vitest's own CLI has no equivalent flag for) -- loads the repo-root `.env` (DB_HOST/DB_PORT/
// DB_USER/DB_PASSWORD/DB_NAME) so `vitest run` works out of the box against the local dev
// database without extra setup. CI never has this file (it sets the same env vars directly in
// the workflow's `env:` block instead) -- swallow the "file doesn't exist" case rather than fail.
try {
  loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // no .env (CI, or a machine that hasn't configured one yet) -- rely on already-set env vars.
}

export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    globals: false,
    environment: "node",
    // Real integration tests against a real MySQL instance (see test/support/test-app.ts) --
    // deliberately NOT mocked. This codebase's own established practice all session (every wave's
    // own live-verification step) is that `tsc` passing is not evidence of correctness for
    // money/stock/permission logic; these tests inherit that same standard. A shared MySQL
    // connection pool per test file means concurrent test files must not race on the same rows --
    // run test FILES sequentially (fileParallelism: false) while individual tests within a file
    // may still run concurrently if a suite opts in. Real MySQL, real migrations, real seed data.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
