// Asking a real Harper what it already knows.
//
// This is the step that keeps packs small and honest. Harper's curated
// dictionary is far larger than people assume — it already has `webhook`,
// `middleware`, `telemetry`, `SaaS`, `Kubernetes`, `comorbidity`, `sepsis` and
// thousands more — so shipping a raw source list means shipping mostly
// redundancy, and every redundant word costs precision in Harper's spell
// suggestions.
//
// Browser-safe: the linter is injected, so Node passes a LocalLinter and the
// web UI passes a WorkerLinter.

/** Harper's lint kind for an unrecognised word. */
export const SPELLING = "Spelling";

// Words are probed inside a carrier so they sit mid-sentence. A bare word on
// its own line picks up capitalisation lints that have nothing to do with
// whether Harper knows it.
const PREFIX = "I saw ";
const SUFFIX = " today. ";

/**
 * Split words into those Harper already recognises and those it flags.
 *
 * Words are batched into documents rather than linted one at a time; Harper
 * handles a few thousand characters in well under a tenth of a second, so
 * batching is the difference between seconds and hours on a large list.
 *
 * @param linter        a harper.js Linter (Local or Worker), already set up
 * @param words         the candidate words
 * @param charBudget    approximate characters per lint call
 * @param onProgress    called as `{ done, total }` after each batch
 * @param spellingOnly  ignore lints that are not spelling complaints
 */
export async function probeWords(linter, words, {
  charBudget = 4000,
  onProgress,
  spellingOnly = true,
} = {}) {
  const known = [];
  const unknown = [];
  let cursor = 0;

  while (cursor < words.length) {
    let text = "";
    const placed = [];

    while (cursor < words.length && text.length < charBudget) {
      const word = words[cursor];
      const start = text.length + PREFIX.length;
      text += PREFIX + word + SUFFIX;
      placed.push({ word, start, end: start + word.length });
      cursor += 1;
    }

    const spans = [];
    const lints = await linter.lint(text, { language: "plaintext" });
    for (const lint of lints) {
      try {
        if (spellingOnly && lint.lint_kind() !== SPELLING) continue;
        const span = lint.span();
        spans.push([span.start, span.end]);
      } finally {
        lint.free?.();
      }
    }

    for (const { word, start, end } of placed) {
      const flagged = spans.some(([from, to]) => from < end && to > start);
      (flagged ? unknown : known).push(word);
    }

    onProgress?.({ done: cursor, total: words.length });
  }

  return { known, unknown };
}

/** The dialects Harper ships. A word only counts as missing if all of them flag it. */
export const ALL_DIALECTS = ["american", "british", "australian", "canadian", "indian"];

/**
 * Probe across every dialect, separating genuinely unknown words from dialect
 * variants.
 *
 * This distinction matters more than it looks. Probing a single dialect reports
 * `haematology`, `paediatrics` and `neighbourhood` as missing under American —
 * but Harper knows all three perfectly well and is deliberately flagging them
 * as the wrong dialect, suggesting `hematology`, `pediatrics`, `neighborhood`.
 *
 * Adding such a word to a pack does not help: the dialect check does not
 * consult pack dictionaries, so the lint survives and the pack carries a
 * useless entry. British spellings are Harper's job via its dialect setting,
 * not a pack's job.
 *
 * @param makeLinter      `async (dialect) => Linter` — injected so this stays
 *                        browser-safe; the caller decides Local vs Worker
 * @param disposeLinters  dispose each linter after its dialect. Leave on when
 *                        `makeLinter` builds one per call. Turn it off when it
 *                        hands back the *same* linter with a new dialect, which
 *                        is what the browser does to avoid compiling an 18 MB
 *                        binary once per dialect — then the caller disposes.
 * @returns `{ missing, dialectVariants, known }`
 */
export async function probeDialects(makeLinter, words, {
  dialects = ALL_DIALECTS,
  onProgress,
  disposeLinters = true,
  ...options
} = {}) {
  const flaggedIn = new Map(words.map((word) => [word, []]));

  for (const dialect of dialects) {
    const linter = await makeLinter(dialect);
    try {
      const { unknown } = await probeWords(linter, words, {
        ...options,
        onProgress: (progress) => onProgress?.({ ...progress, dialect }),
      });
      for (const word of unknown) flaggedIn.get(word).push(dialect);
    } finally {
      if (disposeLinters) await linter.dispose();
    }
  }

  const missing = [];
  const dialectVariants = [];
  const known = [];

  for (const [word, flagging] of flaggedIn) {
    if (flagging.length === dialects.length) missing.push(word);
    else if (flagging.length) dialectVariants.push({ word, flaggedIn: flagging });
    else known.push(word);
  }

  return { missing, dialectVariants, known };
}

/**
 * Check that a built pack actually does its job.
 *
 * Loads the pack into a linter and re-probes. Every word passed in should come
 * back clean; anything still flagged is reported rather than thrown, because a
 * partial failure is usually a bad flag on one entry rather than a broken pack.
 *
 * The linter is mutated, so hand this a throwaway one.
 *
 * @returns `{ ok, stillFlagged, testFailures }`
 */
export async function verifyPack(linter, packBytes, expectedWords, options = {}) {
  const testFailures = await linter.loadWeirpackFromBytes(packBytes);
  if (testFailures !== undefined) {
    return { ok: false, stillFlagged: [], testFailures };
  }

  const { unknown } = await probeWords(linter, expectedWords, options);
  return { ok: unknown.length === 0, stillFlagged: unknown, testFailures: undefined };
}
