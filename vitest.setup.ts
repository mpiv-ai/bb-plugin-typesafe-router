// `@get-bb/plugin-sdk@0.4.87` ships `dist/provider-bridge.js` as ESM, but the
// bundle inlines cross-spawn behind esbuild's CommonJS shim and evaluates it at
// module load. The shim looks for a `require` that plain ESM does not have, so
// importing the subpath throws `Dynamic require of "child_process"` — under
// Node directly, not only under Vitest.
//
// `bb plugin build` handles this by prepending a `createRequire` banner to
// `dist/host.js`, which is why the real artifact loads. This does the same
// thing for the test run. Remove it when the SDK ships a bundle without the
// shim.
import { createRequire } from "node:module";

const globals = globalThis as { require?: NodeJS.Require };
globals.require ??= createRequire(import.meta.url);
