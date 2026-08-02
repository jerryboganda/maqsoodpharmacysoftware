// Registers ts-node's ESM loader without the deprecated --experimental-loader CLI flag.
// Used by the dev/start scripts: `node --import ./scripts/register-loader.mjs src/main.ts`.
//
// Why ts-node (and not tsx/esbuild): NestJS's dependency injection relies on
// TypeScript's `emitDecoratorMetadata`, which esbuild-based tools (tsx, swc without the
// metadata plugin) do not implement. ts-node runs the real TypeScript compiler per file, so
// constructor-based `@Injectable()` DI works exactly as NestJS expects.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("ts-node/esm", pathToFileURL("./"));
