import { defineConfig } from "tsup";

// See index.ts's header comment for why this package needs a bundled build at all (drizzle-kit
// vs. ts-node/esm consumers disagree on extensionless relative imports).
export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  // drizzle-orm/mysql2 stay real node_modules imports in the output, not inlined.
  external: ["drizzle-orm", "mysql2"],
});
