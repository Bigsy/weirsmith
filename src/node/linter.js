// Node-side Harper setup.
//
// Kept out of src/core so the core stays importable in a browser, where the
// binary is fetched rather than read off disk and a WorkerLinter is usually the
// right choice.
import { Dialect, LocalLinter } from "harper.js";
import { binary } from "harper.js/binary";

export const DIALECTS = {
  american: Dialect.American,
  british: Dialect.British,
  australian: Dialect.Australian,
  canadian: Dialect.Canadian,
  indian: Dialect.Indian,
};

/**
 * Start a linter.
 *
 * Setup constructs Harper's curated dictionary, which is the expensive part —
 * about a second — so reuse the result rather than creating one per pack.
 */
export async function createLinter(dialect = "american") {
  const resolved = DIALECTS[dialect];
  if (resolved === undefined) {
    throw new Error(`unknown dialect '${dialect}' (expected one of ${Object.keys(DIALECTS).join(", ")})`);
  }

  const linter = new LocalLinter({ binary, dialect: resolved });
  await linter.setup();
  return linter;
}
