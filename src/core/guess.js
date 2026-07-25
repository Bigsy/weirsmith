// Guessing Rune flags from the shape of a word.
//
// Bulk-converted dictionaries arrive as bare spellings with no part of speech.
// Harper will happily accept a word with empty metadata — it stops being
// flagged as a typo, which is the main thing — but its grammar rules and
// chunker lean on part-of-speech information, so a pack of untagged words is a
// quiet quality tax on everything around them.
//
// These heuristics get most entries close enough that a human is correcting a
// minority rather than tagging from scratch. Every rule is deliberately
// conservative: a wrong noun/verb tag is worse than a plain noun tag, so
// ambiguous endings are left alone.

/**
 * Ordered rules. First match wins, so the specific cases sit above the general
 * ones. `why` is surfaced in the CLI and is meant to be shown next to the
 * suggestion in the web UI too.
 */
export const RULES = [
  {
    name: "acronym",
    why: "all caps or contains a digit — treated as a proper noun that pluralises",
    test: (w) => /\d/.test(w) || (w.length > 1 && w === w.toUpperCase()),
    flags: "OgS",
  },
  {
    name: "proper-noun",
    why: "starts with a capital — product or company name",
    test: (w) => /^\p{Lu}/u.test(w),
    flags: "Og",
  },
  {
    name: "adverb",
    why: "ends in -ly",
    test: (w) => /ly$/.test(w),
    flags: "~R",
  },
  {
    name: "abstract-noun",
    why: "abstract/uncountable ending — no plural form",
    test: (w) => /(ness|ity|ism|ology|ography|ance|ence|ency|ancy)$/.test(w),
    flags: "~Nmg",
  },
  {
    name: "gerund",
    why: "ends in -ing — gerund, treated as a mass noun",
    test: (w) => /ing$/.test(w),
    flags: "~Nmg",
  },
  {
    name: "verb",
    why: "verb-forming ending — gets -s, -ed and -ing",
    test: (w) => /(ise|ize|ate|ify)$/.test(w),
    flags: "~VGdS",
  },
  {
    name: "adjective",
    why: "unambiguous adjective ending",
    test: (w) => /(able|ible|ous|ive|ical)$/.test(w),
    flags: "~J",
  },
  {
    name: "already-plural",
    why: "already ends in -s — no further plural",
    test: (w) => /s$/.test(w),
    flags: "~N",
  },
  {
    name: "countable-noun",
    why: "default — countable noun with plural and possessive",
    test: () => true,
    flags: "~NgS",
  },
];

/**
 * Suggest flags for a word.
 *
 * @returns `{ flags, rule, why }`
 */
export function guessFlags(word) {
  const rule = RULES.find((candidate) => candidate.test(word));
  return { flags: rule.flags, rule: rule.name, why: rule.why };
}
