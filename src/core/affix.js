// Reading a hunspell `.aff`, and working out which Harper flag each of its
// flags means.
//
// This is not an affix engine. weirsmith never expands `kubelet/S` into
// `kubelets` — Harper does that itself from the flag. All we have to do is
// answer one question per flag: *which* Harper flag is this the same rule as?
//
// That question is answerable because the two formats describe affixes the same
// way — a list of (remove, add, condition) triples — and because Harper's Rune
// annotations are evidently derived from the same SCOWL affix conventions
// hunspell dictionaries use. The rules come out byte-identical. Against
// `dictionary-en@4.0.0`, 17 of its 23 flags match a Harper flag exactly; only
// the letters naming them differ, and only sometimes.
//
// So the mapping is *derived*, never hardcoded. A hardcoded table would be a
// guess about one dictionary that silently mistranslates the next one, and
// mistranslation here is the worst failure mode in the project: nothing errors,
// the pack builds, and the inflections are wrong.
//
// Browser-safe: strings in, objects out.
import { HARPER_FLAGS } from "./harper-flags.js";
import { parseHunspellDic } from "./wordlist.js";

/** hunspell writes an empty strip/append field as `0`. */
const NONE = "0";

/**
 * How a `.aff` names its flags. `FLAG long` means two characters per flag,
 * `FLAG num` a comma-separated list of numbers. Both change how a `.dic`'s
 * flag field must be split, so guessing wrong turns one flag into two.
 */
export const FLAG_MODES = ["single", "long", "num"];

/**
 * Flags a `.aff` declares outside its affix table.
 *
 * These are not affixes and have no Harper equivalent, but they are not junk
 * either — and two of them change whether the *word* should be imported at all,
 * not just whether a flag survives:
 *
 * - `ONLYINCOMPOUND` marks a fragment that is only a word inside a compound.
 *   `dictionary-en` uses it for `1th`, `2th`, `3th`, which exist so that `11th`
 *   and `123th` can be assembled. Importing `1th` as a word would be wrong.
 * - `FORBIDDENWORD` marks a spelling the dictionary explicitly rejects, and
 *   `NEEDAFFIX` a stem that is not a word until something is attached.
 *
 * Everything else here is a real word carrying a hint Harper expresses its own
 * way — `NOSUGGEST` marks words that are spelt correctly but should never be
 * offered as a correction — so the word is kept and the flag dropped.
 */
const EXCLUDING_DIRECTIVES = {
  ONLYINCOMPOUND: "only valid inside a compound, not a word on its own",
  FORBIDDENWORD: "explicitly forbidden by the source dictionary",
  NEEDAFFIX: "a stem, not a word — only its affixed forms are real",
  PSEUDOROOT: "a stem, not a word — only its affixed forms are real", // NEEDAFFIX's old name
};

const KEPT_DIRECTIVES = [
  "NOSUGGEST", "KEEPCASE", "CIRCUMFIX", "WARN", "SUBSTANDARD",
  "COMPOUNDFLAG", "COMPOUNDBEGIN", "COMPOUNDMIDDLE", "COMPOUNDEND",
  "COMPOUNDPERMITFLAG", "COMPOUNDFORBIDFLAG", "COMPOUNDROOT", "FORCEUCASE",
];

/** Split a `.dic` entry's flag field into individual flags. */
export function splitFlags(flags, mode = "single") {
  if (!flags) return [];
  if (mode === "num") return flags.split(",").map((flag) => flag.trim()).filter(Boolean);
  if (mode === "long") return flags.match(/../g) ?? [];
  return [...flags];
}

/** Join flags back into a `.dic` flag field. */
export function joinFlags(flags, mode = "single") {
  return mode === "num" ? flags.join(",") : flags.join("");
}

/**
 * Parse a `.aff`.
 *
 * Only the affix table and the flag mode are interpreted. Everything else —
 * `REP`, `TRY`, `COMPOUNDRULE`, `ICONV` — describes suggestion and compounding
 * behaviour that Harper implements its own way, so it is recorded as ignored
 * rather than half-translated.
 *
 * @returns `{ flagMode, affixes, excluding, kept, ignored, warnings }` where
 *          `affixes` is a Map of flag to
 *          `{ flag, kind, crossProduct, replacements }`, `excluding` a Map of
 *          flag to the reason its words must be skipped, and `kept` a Set of
 *          non-affix flags whose words are fine
 */
export function parseAff(text) {
  const affixes = new Map();
  const excluding = new Map();
  const kept = new Set();
  const ignored = new Map();
  const warnings = [];
  let flagMode = "single";

  const lines = text.split(/\r?\n/);
  let open = null; // the SFX/PFX block currently being filled

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const at = `line ${index + 1}`;
    const fields = line.split(/\s+/);
    const [directive] = fields;

    if (directive === "FLAG") {
      const mode = fields[1];
      if (FLAG_MODES.includes(mode)) {
        flagMode = mode;
      } else {
        warnings.push(`${at}: unsupported FLAG mode '${mode}', assuming single-character flags`);
      }
      continue;
    }

    if (EXCLUDING_DIRECTIVES[directive]) {
      if (fields[1]) excluding.set(fields[1], EXCLUDING_DIRECTIVES[directive]);
      continue;
    }

    if (KEPT_DIRECTIVES.includes(directive)) {
      if (fields[1]) kept.add(fields[1]);
      continue;
    }

    if (directive === "COMPOUNDRULE") {
      // `COMPOUNDRULE 2` is a count; `COMPOUNDRULE n*1t` is a pattern whose
      // letters are flags. The words carrying them are real (`0`, `4th`), so
      // the flags are kept-and-dropped rather than excluding.
      const pattern = fields[1] ?? "";
      if (!/^\d+$/.test(pattern)) for (const flag of pattern.replace(/[*?()]/g, "")) kept.add(flag);
      continue;
    }

    if (directive !== "SFX" && directive !== "PFX") {
      ignored.set(directive, (ignored.get(directive) ?? 0) + 1);
      continue;
    }

    const kind = directive === "SFX" ? "suffix" : "prefix";
    const flag = fields[1];

    // A block header is `SFX flag Y|N count`; a rule line is
    // `SFX flag remove add condition`. The third field tells them apart.
    const isHeader = fields[2] === "Y" || fields[2] === "N";

    if (isHeader) {
      if (open && open.declared !== open.set.replacements.length) {
        warnings.push(
          `${open.at}: ${open.set.kind} '${open.set.flag}' declared ${open.declared} rules`
          + ` but ${open.set.replacements.length} followed`,
        );
      }
      const set = { flag, kind, crossProduct: fields[2] === "Y", replacements: [] };
      affixes.set(flag, set);
      open = { set, declared: Number(fields[3]), at };
      continue;
    }

    if (!open || open.set.flag !== flag || open.set.kind !== kind) {
      // Rule lines may legally follow their header in any order in the file, so
      // fall back to the flag's existing block rather than dropping the rule.
      const existing = affixes.get(flag);
      if (!existing || existing.kind !== kind) {
        warnings.push(`${at}: ${kind} rule for '${flag}' has no matching header, ignored`);
        continue;
      }
      open = { set: existing, declared: existing.replacements.length, at };
    }

    // `add` may carry continuation flags — `s/X` means "and also apply X to the
    // result". Harper has no equivalent, so the flag is recorded and the
    // suffix used bare.
    const [add, continuation = null] = (fields[3] ?? NONE).split("/");
    open.set.replacements.push({
      remove: fields[2] === NONE ? "" : fields[2],
      add: add === NONE ? "" : add,
      condition: fields[4] ?? ".",
      continuation,
    });
  }

  if (open && open.declared !== open.set.replacements.length) {
    warnings.push(
      `${open.at}: ${open.set.kind} '${open.set.flag}' declared ${open.declared} rules`
      + ` but ${open.set.replacements.length} followed`,
    );
  }

  return { flagMode, affixes, excluding, kept, ignored, warnings };
}

/**
 * Canonical form of a rule set, for equality testing.
 *
 * Sorted, because the two formats list the same replacements in different
 * orders; and deliberately *excluding* `crossProduct`, because that governs how
 * affixes combine rather than what a single affix produces. Where it differs the
 * pair is still the same rule, so it is reported alongside the match instead of
 * blocking it.
 */
function canonical({ kind, replacements }) {
  const rules = replacements
    .map(({ remove, add, condition }) => `${remove}>${add}/${condition}`)
    .sort();
  return `${kind}:${rules.join(" ")}`;
}

/** Harper's own affix table, canonicalised once. */
const HARPER_BY_RULE = new Map(
  Object.entries(HARPER_FLAGS.affixes).map(([flag, set]) => [
    canonical({ kind: set.kind, replacements: set.replacements }),
    { flag, crossProduct: set.cross_product, description: set["#"] },
  ]),
);

/** A short human label for a flag, read off its own rules: `-ers`, `de-`. */
function describe({ kind, replacements }) {
  const shapes = [...new Set(replacements.map(({ add }) => add))].filter(Boolean);
  const longest = shapes.sort((a, b) => b.length - a.length)[0] ?? "";
  return kind === "prefix" ? `${longest}-` : `-${longest}`;
}

/**
 * Derive the source-flag → Harper-flag mapping for a parsed `.aff`.
 *
 * @returns `{ map, identical, remapped, unmapped, crossProductDiffers }`
 *   - `map`         Map of source flag to Harper flag, for the flags that match
 *   - `identical`   matched and the letter happens to be the same
 *   - `remapped`    matched under a different letter
 *   - `unmapped`    no Harper equivalent — see D3: keep the word, drop the flag
 */
export function deriveFlagMap(aff) {
  const map = new Map();
  const identical = [];
  const remapped = [];
  const unmapped = [];
  const crossProductDiffers = [];

  for (const [flag, set] of aff.affixes) {
    const match = HARPER_BY_RULE.get(canonical(set));

    if (!match) {
      unmapped.push({ flag, kind: set.kind, label: describe(set) });
      continue;
    }

    map.set(flag, match.flag);
    (flag === match.flag ? identical : remapped).push({
      from: flag, to: match.flag, kind: set.kind, label: describe(set),
    });

    if (set.crossProduct !== match.crossProduct) {
      crossProductDiffers.push({ from: flag, to: match.flag });
    }
  }

  return { map, identical, remapped, unmapped, crossProductDiffers };
}

/**
 * Translate one entry's flag field into Harper flags.
 *
 * Unmapped affix flags are dropped and the word kept (D3). The base word is the
 * part Harper is actually missing; the derivations a dropped flag would have
 * generated are a bounded loss, and reporting the count per flag is what keeps
 * it a known loss rather than an assumed one.
 *
 * Flags are sorted into four outcomes rather than one, because "we dropped a
 * flag" and "this is not a word" are very different facts to report:
 *
 * @returns
 *   - `flags`       the Harper flag string, or null
 *   - `dropped`     affix flags with no Harper equivalent (D3)
 *   - `nonAffix`    flags the `.aff` declares for something other than affixes
 *   - `undeclared`  flags the `.aff` never mentions — a mismatched pair
 *   - `excluded`    the reason this word must be skipped entirely, or null
 */
export function translateFlags(flagField, {
  map, flagMode = "single", excluding = new Map(), kept = new Set(), declared = null,
} = {}) {
  const dropped = [];
  const nonAffix = [];
  const undeclared = [];
  const translated = [];
  let excluded = null;

  for (const flag of splitFlags(flagField, flagMode)) {
    const harper = map.get(flag);
    if (harper !== undefined) {
      if (!translated.includes(harper)) translated.push(harper);
    } else if (excluding.has(flag)) {
      excluded ??= excluding.get(flag);
    } else if (kept.has(flag)) {
      nonAffix.push(flag);
    } else if (declared && !declared.has(flag)) {
      // The .aff never mentions this flag. That is not a D3 loss, it means the
      // .dic and .aff do not belong together — worth saying out loud, because
      // the pack would still build and its inflections would be wrong.
      undeclared.push(flag);
    } else {
      dropped.push(flag);
    }
  }

  return {
    flags: translated.length ? translated.join("") : null,
    dropped,
    nonAffix,
    undeclared,
    excluded,
  };
}


/**
 * Parse a `.dic` and its `.aff` together, producing entries whose flags are
 * Harper's.
 *
 * Pass the `.dic` alone and the flags come through verbatim — the raw path,
 * which is only meaningful for a source that already uses Harper's own flag
 * letters. Everything that merges sources must go through here with an `.aff`,
 * because two dictionaries' `S` are not the same `S` until each has been
 * through its own affix table.
 *
 * @param dic  `.dic` text
 * @param aff  `.aff` text, or null for the raw path
 * @returns `{ entries, flagMap, dropped, nonAffix, undeclared, excluded,
 *            unmapped, warnings, flagMode }` — the four report maps are keyed by
 *          flag and count entries, so a loss is always a number, never a shrug
 */
export function parseHunspellSource({ dic, aff = null }) {
  const entries = parseHunspellDic(dic);

  if (!aff) {
    return {
      entries,
      flagsTranslated: false,
      flagMap: null,
      dropped: new Map(),
      nonAffix: new Map(),
      undeclared: new Map(),
      excluded: [],
      unmapped: [],
      warnings: ["no .aff supplied — source flags kept verbatim, which is only"
        + " correct if this dictionary already uses Harper's flag letters"],
      flagMode: "single",
    };
  }

  const parsed = parseAff(aff);
  const derived = deriveFlagMap(parsed);
  const declared = new Set([
    ...parsed.affixes.keys(), ...parsed.excluding.keys(), ...parsed.kept,
  ]);

  const dropped = new Map();
  const nonAffix = new Map();
  const undeclared = new Map();
  const excluded = [];
  const translated = [];

  const tally = (into, flags) => {
    for (const flag of flags) into.set(flag, (into.get(flag) ?? 0) + 1);
  };

  for (const entry of entries) {
    const result = translateFlags(entry.flags, {
      map: derived.map, flagMode: parsed.flagMode, excluding: parsed.excluding,
      kept: parsed.kept, declared,
    });

    if (result.excluded) {
      excluded.push({ word: entry.word, reason: result.excluded });
      continue;
    }

    tally(dropped, result.dropped);
    tally(nonAffix, result.nonAffix);
    tally(undeclared, result.undeclared);
    translated.push({ word: entry.word, flags: result.flags, sourceFlags: entry.flags });
  }

  const warnings = [...parsed.warnings];
  if (undeclared.size) {
    warnings.push(
      `${undeclared.size} flag(s) in the .dic are not declared in the .aff`
      + ` (${[...undeclared.keys()].join(", ")}) — check the two files belong together`,
    );
  }

  return {
    entries: translated,
    flagsTranslated: true,
    flagMap: derived,
    dropped,
    nonAffix,
    undeclared,
    excluded,
    unmapped: derived.unmapped,
    warnings,
    flagMode: parsed.flagMode,
  };
}
