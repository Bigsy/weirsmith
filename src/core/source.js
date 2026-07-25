// The `words.txt` authoring format.
//
// One entry per line. Flags are optional — omit them and weirsmith guesses from
// the word's shape, which is fine for the long tail but worth overriding on
// anything you care about:
//
//     # comments and blank lines are ignored
//     kubelet/~NgS        # explicit flags win
//     Grafana             # guessed: proper noun -> Og
//     observability/~Nmg  # trailing comments are stripped
//
// This is deliberately the same `word/FLAGS` shape as hunspell `.dic` and
// Harper's `dictionary.dict`, so the three are copy-pasteable between each
// other.
import { guessFlags } from "./guess.js";

/**
 * Parse a `words.txt`.
 *
 * @returns `[{ word, flags, guessed, rule, why, line }]`
 */
export function parseSource(text) {
  const entries = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const withoutComment = raw.split("#")[0].trim();
    if (!withoutComment) return;

    const slash = withoutComment.indexOf("/");
    const word = slash === -1 ? withoutComment : withoutComment.slice(0, slash);
    const explicit = slash === -1 ? null : withoutComment.slice(slash + 1).trim();
    if (!word) return;

    if (explicit) {
      entries.push({ word, flags: explicit, guessed: false, line: index + 1 });
    } else {
      const { flags, rule, why } = guessFlags(word);
      entries.push({ word, flags, guessed: true, rule, why, line: index + 1 });
    }
  });

  return entries;
}

/** Render entries back out as `words.txt`, one `word/FLAGS` per line. */
export function renderSource(entries, { header } = {}) {
  const lines = entries.map(({ word, flags }) => (flags ? `${word}/${flags}` : word));
  return `${header ? `${header}\n` : ""}${lines.join("\n")}\n`;
}
