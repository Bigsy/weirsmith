// Parsing ordinary dictionary files into Weirpack candidates.
//
// Browser-safe: takes and returns strings. No file system access lives here, so
// the same code backs both the CLI and the web UI.
import { HARPER_FLAGS } from "./harper-flags.js";
import { parseSource } from "./source.js";

/** Every flag character Harper defines — used to recognise a `word/FLAGS` line. */
const KNOWN_FLAGS = new Set([
  ...Object.keys(HARPER_FLAGS.affixes), ...Object.keys(HARPER_FLAGS.properties),
]);

/** A word that cannot go into a Weirpack, and why. */
const reject = (word, reason) => ({ word, reason });

/**
 * Harper stores dictionary entries as single tokens and looks them up that way.
 * An entry containing a space or a hyphen can therefore never match, because
 * the tokenizer will have split the text before the lookup happens. Digits and
 * apostrophes are fine.
 */
const USABLE = /^[\p{L}\p{N}']+$/u;

/**
 * Tokens that are not words.
 *
 * Real dictionaries — especially ones scraped from code — carry hex constants,
 * leetspeak and bare numbers. They are worse than useless in a pack: every entry
 * widens Harper's accepted set and feeds its suggestion engine, so junk costs
 * precision on everything around it.
 *
 * The hard part is not the rejecting, it is the *not* over-rejecting, and the
 * examples make that concrete. `DCB0129` is a clinical safety standard whose
 * every character happens to be a hex digit. `utf8mb4` interleaves letters and
 * digits twice. `S3`, `HL7`, `GP2GP`, `log4j` and `a11y` are all real. A regex
 * aimed at `0b00b135` reaches every one of them unless it is written narrowly,
 * so each rule below carries the counter-example it must not catch, and
 * test/fixtures/example/words.txt asserts the whole corpus survives.
 *
 * Rules are ordered; the first match wins and its `why` is reported.
 */
export const JUNK_RULES = [
  {
    name: "all-digits",
    why: "not word-shaped (all digits)",
    // Keeps: nothing. A bare number is never a dictionary entry.
    test: (word) => /^\p{N}+$/u.test(word),
  },
  {
    name: "hex-literal",
    why: "not word-shaped (hex literal)",
    // Keeps: `0x` is not a prefix any word starts with.
    test: (word) => /^0[xX][0-9a-fA-F]+$/.test(word),
  },
  {
    name: "hex-constant",
    why: "not word-shaped (hex or leetspeak constant)",
    // Every character a hex digit, at least one of them a *digit*, and either
    // long or visibly interleaved.
    //
    // The two conditions are what save the real words. `DCB0129` is all-hex but
    // short and cleanly split into letters-then-digits, so it survives; `0bab10c`
    // is the same length and rejected because it alternates four times.
    // `deadbeef` and `cafe` have no digit at all — shape cannot tell those from
    // words, so they are left for the probe to filter.
    test: (word) => /^[0-9a-fA-F]+$/.test(word)
      && /\d/.test(word)
      && (word.length >= 8 || transitions(word) >= 3),
  },
];

/** How many times a token switches between letters and digits. */
function transitions(word) {
  let count = 0;
  for (let i = 1; i < word.length; i += 1) {
    if (/\d/.test(word[i]) !== /\d/.test(word[i - 1])) count += 1;
  }
  return count;
}

/** The rule that rejects this word, or undefined if it looks like a word. */
export function findJunkRule(word) {
  return JUNK_RULES.find((rule) => rule.test(word));
}

/**
 * Strip the decorations cspell-style word lists carry.
 *
 * cspell marks forbidden words with a leading `!`, and uses `*` and `+` to note
 * where affixes and compounds may attach. None of that survives into Rune, but
 * the bare word underneath is still useful to us.
 */
function stripCspellMarkers(line) {
  if (line.startsWith("!")) return null; // forbidden word — never add it
  return line.replace(/^[*+]+/, "").replace(/[*+]+$/, "");
}

/**
 * Parse a plain newline-delimited word list (cspell dictionaries, SCOWL dumps,
 * anything one-word-per-line). Blank lines and `#` comments are ignored.
 */
export function parseWordList(text) {
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const word = stripCspellMarkers(line);
    if (word) entries.push({ word, flags: null });
  }
  return entries;
}

/**
 * Parse a hunspell `.dic`.
 *
 * This is the same shape as Harper's `dictionary.dict` — an approximate count
 * on the first line, then `word/FLAGS` — which is why adapting hunspell is
 * mostly a no-op. Hunspell also permits trailing morphological fields
 * (`word/S po:noun`), separated by whitespace; we drop those.
 *
 * Note the flags are carried through verbatim. They are only meaningful if the
 * companion `.aff` uses the same single-character flag scheme Harper does, so
 * `keepSourceFlags` defaults to off in the build pipeline.
 */
export function parseHunspellDic(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];

  // First line is a count, not a word — but only skip it if it really is one.
  const start = /^\d+\s*$/.test((lines[0] ?? "").trim()) ? 1 : 0;

  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;

    const [entry] = line.split(/\s+/, 1); // drop morphological fields
    if (!entry) continue;

    // A backslash escapes a literal slash in hunspell.
    const slash = entry.search(/(?<!\\)\//);
    const word = (slash === -1 ? entry : entry.slice(0, slash)).replace(/\\\//g, "/");
    const flags = slash === -1 ? null : entry.slice(slash + 1) || null;

    if (word) entries.push({ word, flags });
  }
  return entries;
}

/** Strip a `.gz` so the real extension is visible underneath it. */
export const withoutGz = (name) => (name.endsWith(".gz") ? name.slice(0, -3) : name);

/**
 * Is this a plain word list, or weirsmith's own `word/FLAGS` format?
 *
 * They share the `.txt` extension and cannot be told apart by name. It matters
 * because a plain-list parser reads `kubelet/~NgS` as a word containing a slash
 * and throws it away as unusable — so weirsmith would refuse to read the file it
 * writes itself, and `probe --out` could not be fed back in.
 *
 * The test is deliberately narrow: a slash whose right-hand side is made only of
 * flag characters Harper actually defines. A cspell list, a SCOWL dump or a URL
 * list therefore stays plain, because `and/or` and `http://…` do not qualify.
 */
export function detectListFormat(text, { sample = 200 } = {}) {
  let seen = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    if (seen >= sample) break;
    seen += 1;

    const slash = line.indexOf("/");
    if (slash <= 0 || slash === line.length - 1) continue;
    const flags = line.slice(slash + 1);
    if ([...flags].every((flag) => KNOWN_FLAGS.has(flag))) return "source";
  }
  return "plain";
}

/**
 * weirsmith's own `word/FLAGS` list, keeping only the flags the file states.
 *
 * `parseSource` fills in a shape guess for unflagged lines, which is right when
 * building a pack and wrong here: a merge needs to know what each source
 * actually claimed, so that a guess is never reported as a source's opinion.
 */
export function parseFlaggedList(text) {
  return parseSource(text).map(({ word, flags, guessed }) => ({
    word, flags: guessed ? null : flags,
  }));
}

/**
 * Pick a parser from the file name and, for a `.txt`, from its contents.
 *
 * Returns plain `{ word, flags }` entries whatever the input was, so callers do
 * not branch on format.
 */
export function parseAuto(text, filename = "") {
  if (withoutGz(filename).endsWith(".dic")) return parseHunspellDic(text);
  return detectListFormat(text) === "source" ? parseFlaggedList(text) : parseWordList(text);
}

/**
 * Work out which files are sources and which are affix tables for them.
 *
 * A `.aff` is not a source of words — it is the key to another file's flags — so
 * it is paired with the `.dic` of the same stem and removed from the list. This
 * is the rule the CLI and the web UI both need, and it is pure name arithmetic,
 * so it lives here rather than being written twice and drifting.
 *
 * @param names  file names, in the order the user supplied them
 * @returns `[{ name, kind, aff }]` — `kind` is `"dic"` or `"list"`, `aff` the
 *          name of the paired affix table or null
 */
export function pairSourceFiles(names) {
  const stem = (name) => withoutGz(name).replace(/\.[^.]*$/, "");
  const isAff = (name) => withoutGz(name).endsWith(".aff");

  const affs = new Map();
  for (const name of names.filter(isAff)) affs.set(stem(name), name);

  return names.filter((name) => !isAff(name)).map((name) => ({
    name,
    kind: withoutGz(name).endsWith(".dic") ? "dic" : "list",
    aff: affs.get(stem(name)) ?? null,
  }));
}

/**
 * Drop entries Harper could never match, and de-duplicate.
 *
 * Returns the survivors plus a categorised list of what was thrown away, so the
 * CLI (and later the UI) can tell the user what happened instead of silently
 * shrinking their input.
 */
export function sanitize(entries) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();

  for (const entry of entries) {
    const { word } = entry;

    if (seen.has(word)) {
      rejected.push(reject(word, "duplicate"));
      continue;
    }
    seen.add(word);

    if (word.includes(" ")) {
      rejected.push(reject(word, "multi-word (Harper matches single tokens)"));
    } else if (word.includes("-")) {
      rejected.push(reject(word, "hyphenated (the tokenizer splits on hyphens)"));
    } else if (word.includes("_")) {
      // Called out separately from "unsupported characters" because it is a large
      // and very specific category — code identifiers. `@cspell/dict-golang`
      // alone contributed 2,258 of them (`AF_APPLETALK`, `SIGQUIT`-style
      // constants), 16% of a real six-dictionary merge, and "unsupported
      // characters" tells you nothing about why or what to do instead.
      //
      // Verified rather than assumed: Harper lints `AF_APPLETALK` as
      // `APPLETALK`, so the tokenizer splits on underscores exactly as it does on
      // hyphens, and adding the underscored entry to a pack leaves the lint in
      // place. Add `APPLETALK` instead.
      rejected.push(reject(word, "contains an underscore (the tokenizer splits on underscores)"));
    } else if (!USABLE.test(word)) {
      rejected.push(reject(word, "unsupported characters"));
    } else {
      const junk = findJunkRule(word);
      if (junk) rejected.push(reject(word, junk.why));
      else accepted.push(entry);
    }
  }

  return { accepted, rejected };
}
