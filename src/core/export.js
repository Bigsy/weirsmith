// Exporting a word list to the other formats spell checkers actually read.
//
// A Weirpack is the native target, but the same curated list is worth having as
// a hunspell dictionary (LibreOffice, and most of Unix), a flat custom
// dictionary (Word) or a cspell dictionary. The formats differ in one way that
// decides everything here: **whether the target has an affix engine.**
//
//   hunspell  has one. So we transcribe Harper's flag definitions into an
//             `.aff` and hand over `word/FLAGS` unchanged. Both formats
//             describe an affix the same way — a list of (remove, add,
//             condition) triples — which is the same correspondence
//             `src/core/affix.js` relies on in the other direction.
//   Word,     have none. A flat list is all they read, so the forms have to be
//   cspell    written out, and that means expanding the flags ourselves.
//
// So this module contains the affix engine that `affix.js` deliberately does
// not: `expandEntries`. It exists for the targets that cannot expand, and it is
// checked against a real Harper in `test/packs.test.js` rather than trusted —
// Harper generating `formularies` from `formulary/~NgS` is the oracle for our
// expansion producing the same string.
//
// Browser-safe: strings and objects in, strings out.
import { HARPER_FLAGS } from "./harper-flags.js";

/** What each format is, for `--help` and for the docs. */
export const EXPORT_FORMATS = {
  weirpack: "Harper Weirpack (the native format; see buildPack)",
  hunspell: ".dic + .aff — LibreOffice, hunspell, most Unix spell checkers",
  word: "flat one-word-per-line .dic — Microsoft Word custom dictionary",
  cspell: "cspell dictionary + a dictionaryDefinitions snippet",
  text: "plain word list, base forms only — the lowest common denominator",
};

/**
 * Harper flag letters that a hunspell `.aff` cannot name.
 *
 * hunspell flags are single characters, and in practice its tooling treats `>`
 * and `^` as syntax rather than as flag names. Both are affixes we want to keep,
 * so they are renamed on the way out — to the letter their rule is named after,
 * which keeps the `.aff` readable — and the renaming is reported rather than
 * done silently, because a flag that changes meaning between two files is the
 * worst failure mode this project has.
 */
export const HUNSPELL_FLAG_ALIASES = { ">": "E", "^": "T" };

const isAffix = (flag) => Boolean(HARPER_FLAGS.affixes[flag]);
const isProperty = (flag) => Boolean(HARPER_FLAGS.properties[flag]);

/** Split a flag field into flag characters, rejecting anything Harper does not define. */
function splitKnownFlags(flags) {
  const unknown = [...(flags ?? "")].filter((flag) => !isAffix(flag) && !isProperty(flag));
  if (unknown.length) {
    throw new Error(
      `unknown Rune flag(s): ${[...new Set(unknown)].join(", ")}. `
      + "Add them to tools/sync-flags.mjs and re-sync from Harper's annotations.json.",
    );
  }
  return [...(flags ?? "")];
}

// ---------------------------------------------------------------- expansion

/**
 * A hunspell/Rune affix condition as an anchored regex.
 *
 * Conditions are literal characters and character classes matched against the
 * end of the word for a suffix and the start of it for a prefix. They come out
 * of Harper's generated annotations, so anything outside that alphabet means the
 * upstream format has changed and guessing would be worse than stopping.
 */
export function conditionRegex(condition, kind) {
  if (!/^[A-Za-z[\]^.]+$/.test(condition)) {
    throw new Error(`unsupported affix condition ${JSON.stringify(condition)}`);
  }
  return kind === "prefix" ? new RegExp(`^(?:${condition})`) : new RegExp(`(?:${condition})$`);
}

/** Apply one (remove, add) replacement, or null if it would consume the whole word. */
function applyReplacement(word, { remove, add }, kind) {
  if (remove.length >= word.length) return null;
  if (kind === "prefix") {
    return add + (remove ? word.slice(remove.length) : word);
  }
  return (remove ? word.slice(0, -remove.length) : word) + add;
}

/**
 * Every form one affix flag generates from a word.
 *
 * All matching replacements are applied, not just the first: that is hunspell's
 * behaviour, and while Harper's conditions happen to be mutually exclusive
 * (`[^aeiou]y`, `[aeiou]y`, `[sxzh]`, `[^sxzhy]`), relying on that would break
 * quietly the day one of them is not.
 */
export function formsForFlag(word, flag) {
  const definition = HARPER_FLAGS.affixes[flag];
  if (!definition) return [];

  const forms = [];
  for (const replacement of definition.replacements) {
    if (!conditionRegex(replacement.condition, definition.kind).test(word)) continue;
    const form = applyReplacement(word, replacement, definition.kind);
    if (form && form !== word) forms.push(form);
  }
  return forms;
}

/**
 * Expand one entry into every form its flags generate, base word first.
 *
 * Forms follow the order the flags are written — `kubelet/~NgS` gives the
 * possessive before the plural, `kubelet/~NSg` the other way round — with
 * prefixed forms last. Deterministic per input, and canonical if the entries
 * came through `mergeSources`, which sorts the flag field.
 *
 * Prefixes combine with suffixes only when both sides set `cross_product`,
 * which is hunspell's rule and Harper's: `^` (superlative) and `v` (`-ive`) do
 * not cross, so `unbiggest` is not a word this produces.
 */
export function expandEntry({ word, flags }) {
  const affixes = splitKnownFlags(flags).filter(isAffix);
  const suffixes = affixes.filter((flag) => HARPER_FLAGS.affixes[flag].kind === "suffix");
  const prefixes = affixes.filter((flag) => HARPER_FLAGS.affixes[flag].kind === "prefix");

  const suffixed = suffixes.flatMap((flag) => formsForFlag(word, flag));
  const forms = [word, ...suffixed];

  for (const prefix of prefixes) {
    forms.push(...formsForFlag(word, prefix));
    if (!HARPER_FLAGS.affixes[prefix].cross_product) continue;
    for (const flag of suffixes) {
      if (!HARPER_FLAGS.affixes[flag].cross_product) continue;
      for (const form of formsForFlag(word, flag)) forms.push(...formsForFlag(form, prefix));
    }
  }

  return [...new Set(forms)];
}

/**
 * Expand a whole list.
 *
 * @returns `{ words, byWord, generated }` — `words` deduplicated in first-seen
 *          order (case-sensitively: `abs` and `ABS` are two strings here, and
 *          which of them a target keeps is the target's business), `byWord` the
 *          forms per base entry, `generated` how many forms the flags added.
 */
export function expandEntries(entries) {
  const words = [];
  const seen = new Set();
  const byWord = new Map();

  for (const entry of entries) {
    const forms = expandEntry(entry);
    byWord.set(entry.word, forms);
    for (const form of forms) {
      if (seen.has(form)) continue;
      seen.add(form);
      words.push(form);
    }
  }

  return { words, byWord, generated: words.length - entries.length };
}

// ---------------------------------------------------------------- hunspell

/**
 * Render the `.aff` for the affix flags a list uses.
 *
 * One `SFX`/`PFX` block per flag, transcribed from the same definitions Harper
 * ships — so hunspell inflects the words exactly as Harper does, rather than us
 * writing the forms out and hoping.
 */
export function renderAff(flags, { name } = {}) {
  const used = [...new Set(flags)].filter(isAffix);
  const lines = [
    "# Generated by weirsmith. Affix rules transcribed from Harper's own flag",
    "# definitions (Automattic/harper, annotations.json, Apache-2.0), so the",
    "# inflections here are the ones Harper generates, not a re-derivation.",
    ...(name ? [`# Source: ${name}`] : []),
    "",
    "SET UTF-8",
    "TRY esianrtolcdugmphbyfvkwzESIANRTOLCDUGMPHBYFVKWZ'",
    "",
  ];

  const renamed = used.filter((flag) => HUNSPELL_FLAG_ALIASES[flag]);
  if (renamed.length) {
    lines.push(
      ...renamed.map((flag) => `# Harper flag ${flag} is named ${HUNSPELL_FLAG_ALIASES[flag]} here`),
      "",
    );
  }

  for (const flag of used) {
    const definition = HARPER_FLAGS.affixes[flag];
    const kind = definition.kind === "prefix" ? "PFX" : "SFX";
    const letter = HUNSPELL_FLAG_ALIASES[flag] ?? flag;
    const comment = definition["#"];

    if (comment) lines.push(`# ${comment}`);
    lines.push(`${kind} ${letter} ${definition.cross_product ? "Y" : "N"} ${definition.replacements.length}`);
    for (const { remove, add, condition } of definition.replacements) {
      lines.push(`${kind} ${letter} ${remove || "0"} ${add || "0"} ${condition}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}`;
}

/**
 * Render a hunspell `.dic`, and say what it cost.
 *
 * Harper's property flags (`~` common, `N` noun, `O` proper noun, `m` mass …)
 * describe what a word *is*; hunspell has nowhere to put that, so the word is
 * kept and the property dropped — the same D3 policy `probe` applies to
 * hunspell flags with no Harper equivalent, reported per flag so the loss is
 * visible instead of assumed.
 */
export function renderHunspellDic(entries) {
  const dropped = new Map();
  const lines = [];

  for (const { word, flags } of entries) {
    const kept = [];
    for (const flag of splitKnownFlags(flags)) {
      if (isAffix(flag)) kept.push(HUNSPELL_FLAG_ALIASES[flag] ?? flag);
      else dropped.set(flag, (dropped.get(flag) ?? 0) + 1);
    }
    lines.push(kept.length ? `${word}/${kept.join("")}` : word);
  }

  return {
    dic: `${entries.length}\n${lines.join("\n")}\n`,
    dropped: [...dropped].sort((a, b) => b[1] - a[1]),
  };
}

/** A hunspell dictionary pair: `.dic` carrying flags, `.aff` defining them. */
export function toHunspell(entries, { name } = {}) {
  const { dic, dropped } = renderHunspellDic(entries);
  const flags = entries.flatMap((entry) => splitKnownFlags(entry.flags));
  const notes = [];

  if (dropped.length) {
    notes.push(
      "property flags have no hunspell equivalent, word kept and flag dropped: "
      + dropped.map(([flag, count]) => `${flag} ×${count}`).join(", "),
    );
  }
  const renamed = [...new Set(flags)].filter((flag) => HUNSPELL_FLAG_ALIASES[flag]);
  if (renamed.length) {
    notes.push(
      "affix flags renamed for hunspell: "
      + renamed.map((flag) => `${flag}→${HUNSPELL_FLAG_ALIASES[flag]}`).join(" "),
    );
  }

  return { dic, aff: renderAff(flags, { name }), notes };
}

// ---------------------------------------------------------------- flat lists

/**
 * A flat word list, one per line.
 *
 * `expand: true` writes out the affix-generated forms, which is the only way to
 * carry them into a target with no affix engine. Without it the list is base
 * spellings only and `SLOs` stays flagged.
 */
export function toWordList(entries, { expand = true, header } = {}) {
  const { words, generated } = expand
    ? expandEntries(entries)
    : { words: entries.map((entry) => entry.word), generated: 0 };
  const body = `${words.join("\n")}\n`;

  return {
    text: header ? `${header}\n${body}` : body,
    words,
    generated,
    bytes: new TextEncoder().encode(body).length,
  };
}

/**
 * A cspell dictionary, plus the config that points at it.
 *
 * cspell's own dictionaries are plain word lists, and its `dictionaryDefinitions`
 * needs a name and a path — so the snippet is emitted alongside rather than left
 * as an exercise.
 */
export function toCspell(entries, { name = "custom", description } = {}) {
  const { text, words, generated } = toWordList(entries, {
    header: `# ${description ?? name} — generated by weirsmith`,
  });
  const config = {
    dictionaryDefinitions: [{ name, path: `./${name}.txt`, description: description ?? name }],
    dictionaries: [name],
  };

  return { text, config: `${JSON.stringify(config, null, 2)}\n`, words, generated };
}
