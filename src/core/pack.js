// Assembling a .weirpack.
//
// A Weirpack is a plain ZIP with `manifest.json` at the root, optionally
// `dictionary.dict` + `annotations.json` (Harper's "Rune" dictionary format,
// which is hunspell's with the affix table moved into JSON), and any number of
// `*.weir` rule files whose names become the rule names.
//
// Browser-safe: `packWeirpackFiles` is a harper.js export and zips with fflate,
// so this module runs unchanged in Node and in the browser.
import { packWeirpackFiles } from "harper.js";

import { HARPER_FLAGS } from "./harper-flags.js";

/** Manifest fields Harper requires; loading fails outright if any is missing. */
export const REQUIRED_MANIFEST_FIELDS = ["author", "version", "description", "license"];

export function validateManifest(manifest) {
  const problems = [];
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (typeof manifest?.[field] !== "string" || manifest[field] === "") {
      problems.push(`manifest.${field} must be a non-empty string`);
    }
  }
  return problems;
}

/**
 * Render `dictionary.dict`.
 *
 * The first line is an approximate entry count — Harper uses it to size its
 * allocation, not to validate — followed by one `word/FLAGS` per line.
 */
export function renderDictionary(entries) {
  const lines = entries.map(({ word, flags }) => (flags ? `${word}/${flags}` : word));
  return `${entries.length}\n${lines.join("\n")}\n`;
}

/** Every distinct flag character used across the entries. */
export function collectFlags(entries) {
  const flags = new Set();
  for (const { flags: entryFlags } of entries) {
    for (const flag of entryFlags ?? "") flags.add(flag);
  }
  return flags;
}

/**
 * Build the `annotations.json` for a set of entries.
 *
 * A pack's annotation table is self-contained — it needs definitions for
 * exactly the flags its dictionary uses and nothing more — so we emit the
 * minimum rather than copying Harper's whole table.
 */
export function buildAnnotations(entries) {
  const annotations = { affixes: {}, properties: {} };
  const unknown = [];

  for (const flag of [...collectFlags(entries)].sort()) {
    if (HARPER_FLAGS.affixes[flag]) {
      annotations.affixes[flag] = HARPER_FLAGS.affixes[flag];
    } else if (HARPER_FLAGS.properties[flag]) {
      annotations.properties[flag] = HARPER_FLAGS.properties[flag];
    } else {
      unknown.push(flag);
    }
  }

  if (unknown.length) {
    throw new Error(
      `unknown Rune flag(s): ${unknown.join(", ")}. `
      + "Add them to tools/sync-flags.mjs and re-sync from Harper's annotations.json.",
    );
  }

  return annotations;
}

/**
 * Build the pack.
 *
 * @param manifest  object with at least author/version/description/license
 * @param entries   `[{ word, flags }]`
 * @param rules     `{ RuleName: weirSource }` — omit for a dictionary-only pack
 * @returns `{ bytes, files }`, where `files` is the archive contents for
 *          inspection or for writing an unpacked copy alongside the zip
 */
export function buildPack({ manifest, entries = [], rules = {} }) {
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error(problems.join("; "));

  const files = new Map();
  files.set("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  if (entries.length) {
    files.set("annotations.json", `${JSON.stringify(buildAnnotations(entries), null, 2)}\n`);
    files.set("dictionary.dict", renderDictionary(entries));
  }

  for (const [name, source] of Object.entries(rules)) {
    files.set(`${name}.weir`, source);
  }

  return { bytes: packWeirpackFiles(files), files };
}
