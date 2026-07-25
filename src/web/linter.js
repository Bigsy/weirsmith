// Browser-side Harper setup.
//
// The mirror image of src/node/linter.js, and the reason src/core/ takes an
// injected `makeLinter` instead of importing one: Node reads an 18 MB WASM
// binary off disk and lints on the main thread, the browser fetches it and lints
// in a worker. Neither of those facts is allowed to reach core.
//
// Two things make this cheaper than it looks. Harper is single-threaded — no
// SharedArrayBuffer, no Atomics, plain `WebAssembly.instantiate` — so no
// COOP/COEP headers are needed and it runs on any static host. And harper.js
// bootstraps its worker from an inlined blob, so there is no separate worker
// file to serve.
import { Dialect, WorkerLinter } from "harper.js";
import { binary } from "harper.js/binary";
import { slimBinary } from "harper.js/slimBinary";

/**
 * Which WebAssembly build to load. Default `slim`, and not for the reason the
 * name suggests.
 *
 * On disk slim is only 265 KB smaller than full — 17.97 MB against 18.23 MB,
 * 1.5%. But asking harper.js 2.4.0 for the *full* binary makes it fetch **both**:
 * `loadBinaryUncached` initialises the slim glue first, rewriting the URL to
 * `harper_wasm_slim_bg.wasm`, inside a try/catch that swallows the failure for
 * the full flavour, and only then loads the binary you asked for. Measured in
 * Chrome, a cold load of `full` transfers ~36 MB raw where `slim` transfers ~18.
 *
 * So slim halves the cold load, and it does it by skipping a download that was
 * never needed rather than by dropping capability. Measured against full on a
 * 16 KB document, slim is indistinguishable: 750 rules in the default config,
 * the same 93 lints with identical spans, messages and suggestions, the same
 * curated dictionary, the same dialect behaviour, and Weirpack import works.
 * That is not a proof of equivalence — something must account for the 265 KB —
 * but nothing weirsmith depends on is missing.
 *
 * Pass `full` to compare for yourself; src/web/measure.html does exactly that.
 */
export const BINARIES = { slim: slimBinary, full: binary };

export const DIALECTS = {
  american: Dialect.American,
  british: Dialect.British,
  australian: Dialect.Australian,
  canadian: Dialect.Canadian,
  indian: Dialect.Indian,
};

function resolve(dialect) {
  const resolved = DIALECTS[dialect];
  if (resolved === undefined) {
    throw new Error(
      `unknown dialect '${dialect}' (expected one of ${Object.keys(DIALECTS).join(", ")})`,
    );
  }
  return resolved;
}

/**
 * Start a linter in a worker.
 *
 * The expensive part is fetching and compiling the binary, and it happens once
 * per worker — about 8 MB gzipped over the wire, then ~600 ms of compile and
 * dictionary construction, measured in Chrome. The transfer is cached
 * afterwards; the compile is not. Keep the linter and switch its dialect rather
 * than making a second one.
 */
export async function createLinter(dialect = "american", { flavour = "slim" } = {}) {
  const module = BINARIES[flavour];
  if (!module) {
    throw new Error(`unknown binary flavour '${flavour}' (expected slim or full)`);
  }
  const linter = new WorkerLinter({ binary: module, dialect: resolve(dialect) });
  await linter.setup();
  return linter;
}

/**
 * A `makeLinter` for `probeDialects` that reuses a single worker.
 *
 * `probeDialects` asks for a linter per dialect, which off the main thread would
 * otherwise mean a fresh worker — and a fresh compile of the binary — five times
 * over. This hands back the same linter with its dialect changed, so pass
 * `disposeLinters: false` alongside it and call `dispose()` when the whole probe
 * is finished.
 *
 * @returns `{ makeLinter, dispose }`
 */
export function reusableLinter({ flavour = "slim" } = {}) {
  let linter = null;

  return {
    async makeLinter(dialect) {
      if (!linter) {
        linter = await createLinter(dialect, { flavour });
        return linter;
      }
      await linter.setDialect(resolve(dialect));
      return linter;
    },
    async dispose() {
      await linter?.dispose();
      linter = null;
    },
  };
}
