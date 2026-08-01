#!/usr/bin/env node
// weirsmith — forge Harper Weirpacks from ordinary dictionary files.
//
// Node I/O lives here and only here; all the real work is in src/core, which is
// browser-safe so the same logic can back a web UI later.
import { parseArgs } from "node:util";
import { basename, join, resolve } from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import {
  ALL_DIALECTS, EXPORT_FORMATS, buildPack, caseTwins, mergeSources, pairSourceFiles, parseAuto,
  parseHunspellSource, parseSource, probeDialects, probeWords, sanitize, toCspell, toHunspell,
  toWordList, verifyPack, withoutGz,
} from "./core/index.js";
import { createLinter } from "./node/linter.js";

const USAGE = `weirsmith — convert your own dictionaries into a Harper Weirpack

Usage:
  weirsmith probe  <file...>  [--dialect <name>] [--out <file>]
  weirsmith build  <dir...>   [--out <dir>]
  weirsmith export <dir|pack...> [--format <list>] [--out <dir>]
  weirsmith verify <pack...>  [--dialect <name>]
  weirsmith inspect <pack>

Commands:
  probe    Lint candidate words against a real Harper and report which ones it
           already knows. This is the point of the tool: Harper's curated
           dictionary is far bigger than people expect, and only the words it is
           missing are worth converting. --out writes those as a words.txt.
  build    Build a .weirpack from a pack directory (manifest.json + words.txt,
           plus an optional rules/ directory of .weir files).
  export   Write the same word list out for other spell checkers.
  verify   Load a pack into Harper and confirm every word, and every form the
           affix flags generate, now lints clean.
  inspect  Print what is inside a pack.

Input files:
  Plain word lists (one per line, # comments), hunspell .dic, and .gz of either.
  A .dic is paired with its .aff automatically — passed on the command line or
  sitting next to it — which is what makes its flags translatable into Harper's.
  Pass several files and they are merged, with a report of what each one added.

Export formats (comma-separated, or "all"):
${Object.entries(EXPORT_FORMATS).map(([name, what]) => `  ${name.padEnd(9)}${what}`).join("\n")}

  Targets with an affix engine are given the flags and inflect the words
  themselves; targets without one are given the forms written out.

Options:
  --dialect  american | british | australian | canadian | indian | all
             (probe default: all; verify default: american)
  --format   Export formats (default: all)
  --out      Output file (probe) or directory (build/export; default: dist)
  --help     Show this message
`;

const plural = (n, word) => {
  if (n === 1) return `${n} ${word}`;
  return `${n} ${word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`}`;
};

function fail(message) {
  console.error(`weirsmith: ${message}`);
  process.exit(1);
}

/** Count occurrences, biggest first — the shape every report here wants. */
function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------- reading

/**
 * Read a text file, transparently decompressing gzip.
 *
 * Detected by magic bytes rather than by extension: dictionary downloads are
 * routinely renamed, and `zlib` is here in the CLI rather than in core precisely
 * so core stays browser-safe (the web entry point uses `DecompressionStream`).
 */
async function readText(file) {
  const bytes = await readFile(file);
  const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  return (gzipped ? gunzipSync(bytes) : bytes).toString("utf8");
}

/** The `.aff` sitting next to a `.dic` on disk, if there is one. */
async function siblingAff(dicFile) {
  const stem = withoutGz(dicFile).slice(0, -4);
  for (const candidate of [`${stem}.aff`, `${stem}.aff.gz`]) {
    try {
      await readFile(candidate);
      return candidate;
    } catch { /* not there — try the next */ }
  }
  return null;
}

/**
 * Load every file into a merge-ready source.
 *
 * The pairing rule — a `.aff` belongs to the `.dic` of the same stem and is not
 * a source of words itself — lives in core, so the CLI and the web UI cannot
 * drift apart on it. Looking on disk for an `.aff` the user did not mention is
 * the one part only the CLI can do.
 *
 * Without an `.aff`, a `.dic`'s flags are meaningless outside the file that
 * defined them, so they are dropped rather than carried into the merge — see the
 * invariant at the top of src/core/merge.js.
 */
async function loadSources(files) {
  const sources = [];

  for (const source of pairSourceFiles(files)) {
    const { name: file, kind } = source;
    const name = basename(file);
    const text = await readText(file);

    if (kind !== "dic") {
      // A plain list, or weirsmith's own word/FLAGS format — parseAuto tells them
      // apart by content, so `probe --out` output can be fed straight back in.
      sources.push({ name, entries: parseAuto(text, file), notes: [] });
      continue;
    }

    const affFile = source.aff ?? await siblingAff(file);
    const parsed = parseHunspellSource({ dic: text, aff: affFile ? await readText(affFile) : null });
    const notes = [];

    if (affFile) {
      const { identical, remapped, unmapped } = parsed.flagMap;
      notes.push(
        `paired with ${basename(affFile)}: ${identical.length + remapped.length} of `
        + `${identical.length + remapped.length + unmapped.length} flags map onto Harper's`
        + (remapped.length ? ` (${remapped.map((m) => `${m.from}→${m.to}`).join(" ")})` : ""),
      );
      if (unmapped.length) {
        // D3: keep the word, drop the flag, report the loss per flag. A flag
        // nothing in this dictionary uses costs nothing, so it is counted rather
        // than listed — otherwise the report reads as a loss that never happened.
        const used = unmapped.filter(({ flag }) => parsed.dropped.get(flag));
        if (used.length) {
          notes.push(
            "no Harper equivalent, flag dropped on: "
            + used.map(({ flag, label }) => `${flag} (${label}) ×${parsed.dropped.get(flag)}`)
              .join(", "),
          );
        }
        if (used.length < unmapped.length) {
          notes.push(
            `${unmapped.length - used.length} further flag(s) have no Harper equivalent`
            + " but no entry uses them",
          );
        }
      }
      if (parsed.excluded.length) {
        for (const [reason, count] of tally(parsed.excluded.map((e) => e.reason))) {
          notes.push(`skipped ${count}: ${reason}`);
        }
      }
      for (const warning of parsed.warnings) notes.push(`warning: ${warning}`);
    } else {
      notes.push("no .aff found — flags ignored, since a flag letter only means"
        + " something in the file that defines it");
    }

    sources.push({
      name,
      // Flags without an .aff are not translatable, so they are dropped here
      // rather than rejected by the merge: probing only needs the words.
      entries: parsed.flagsTranslated
        ? parsed.entries
        : parsed.entries.map(({ word }) => ({ word, flags: null })),
      notes,
    });
  }

  return sources;
}

// ---------------------------------------------------------------- probe

async function commandProbe(files, options) {
  if (!files.length) fail("probe needs at least one file");

  const sources = await loadSources(files);
  if (!sources.length) fail("probe needs at least one word list or .dic (an .aff is not a source)");

  const merged = mergeSources(sources);

  for (const source of sources) {
    console.log(`${source.name}  ${plural(source.entries.length, "entry")}`);
    for (const note of source.notes) console.log(`  ${note}`);
  }

  if (sources.length > 1) {
    // The honest answer is often that a source was not worth including.
    console.log("\nwhat each source added that no earlier one had:");
    for (const { name, total, added } of merged.contribution) {
      const pct = total ? Math.round((added / total) * 100) : 0;
      console.log(`  ${name.padEnd(28)} ${String(added).padStart(6)} new of ${total} (${pct}%)`);
    }
  }

  if (merged.conflicts.length) {
    // Surfaced, never resolved silently — a merge that hides disagreements is a
    // bulk import wearing a better coat.
    const hard = merged.conflicts.filter((conflict) => conflict.hard).length;
    console.log(
      `\n${plural(merged.conflicts.length, "word")} tagged differently by two sources`
      + `${hard ? `, ${hard} contradictory` : ""} — first source wins, review these:`,
    );
    for (const conflict of merged.conflicts.slice(0, 15)) {
      const [first, second] = conflict.sources;
      console.log(
        `  ${conflict.word.padEnd(24)} ${first.name}: ${first.flags}`
        + `  vs  ${second.name}: ${second.flags}${conflict.hard ? "  (contradictory)" : ""}`,
      );
    }
    if (merged.conflicts.length > 15) {
      console.log(`  ... and ${merged.conflicts.length - 15} more`);
    }
  }

  if (merged.collisions.length) {
    // A count and one example, not a list. Harper keeps the last of each pair,
    // and whether that costs a word depends on casing and flags in a way not
    // worth predicting here: a lowercase common noun already covers its ALL-CAPS
    // rendering, so most of these are harmless. `verify` measures which are not.
    const [example] = merged.collisions;
    console.log(
      `\ncase collisions: ${merged.collisions.length}`
      + ` (${example.shadowed.join(", ")} / ${example.winner}). Harper keeps the last`
      + " of each; run verify after building to see whether any word was lost.",
    );
  }

  const { accepted, rejected } = sanitize(merged.entries);
  console.log(`\n${plural(merged.entries.length, "entry")} after merging`);
  for (const [reason, count] of tally(rejected.map((r) => r.reason))) {
    console.log(`  skipped ${String(count).padStart(6)}  ${reason}`);
  }

  const words = accepted.map((entry) => entry.word);
  const flagsByWord = new Map(accepted.map((entry) => [entry.word, entry.flags]));
  // A probe is only safe by default when it checks every dialect. Otherwise a
  // known variant such as `haematology` looks exactly like a genuine gap and
  // gets written into a pack even though a pack cannot silence dialect rules.
  const selectedDialect = options.dialect ?? "all";
  const allDialectProbe = selectedDialect === "all";
  const dialects = allDialectProbe ? ALL_DIALECTS : [selectedDialect];

  // Progress is a redrawn line, which only makes sense on a terminal; piped or
  // in CI it would be thousands of lines of carriage returns.
  const onProgress = process.stderr.isTTY
    ? ({ done, total, dialect }) => {
      process.stderr.write(`\r  probing ${dialect} ${done}/${total}\x1b[K`);
    }
    : undefined;

  const { missing, dialectVariants, known } = await probeDialects(createLinter, words, {
    dialects, onProgress,
  });
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");

  const pct = words.length ? Math.round((known.length / words.length) * 100) : 0;
  console.log(`\nHarper already knows ${plural(known.length, "word")} (${pct}%)`);

  if (dialectVariants.length) {
    // Worth calling out loudly: these look missing but adding them is useless,
    // because Harper's dialect check does not consult pack dictionaries.
    console.log(
      `\n${plural(dialectVariants.length, "word")} Harper knows but flags in some dialects —`
      + " do NOT add these, they are handled by the dialect setting:",
    );
    for (const { word, flaggedIn } of dialectVariants.slice(0, 15)) {
      console.log(`  ${word.padEnd(22)} flagged in ${flaggedIn.join(", ")}`);
    }
    if (dialectVariants.length > 15) console.log(`  ... and ${dialectVariants.length - 15} more`);
  }

  const missingLabel = allDialectProbe ? "missing everywhere" : `missing in ${selectedDialect}`;
  console.log(`\n${missingLabel}: ${plural(missing.length, "word")}`);

  if (options.out) {
    // Flags translated out of a source's .aff are carried through; anything
    // without them is left bare for the shape guess at build time. Either way
    // this file is a starting point for tagging, not a finished pack.
    const withFlags = missing.filter((word) => flagsByWord.get(word)).length;
    const scope = allDialectProbe
      ? "no Harper dialect recognises"
      : `Harper flags in ${selectedDialect}`;
    const header = `# ${missing.length} words ${scope}.\n`
      + `# ${withFlags} carry flags translated from a source .aff; the rest are\n`
      + "# guessed from word shape at build time. Add explicit flags after a\n"
      + "# slash to override, e.g. kubelet/~NgS\n";
    const lines = missing.map((word) => {
      const flags = flagsByWord.get(word);
      return flags ? `${word}/${flags}` : word;
    });
    await writeFile(options.out, `${header}${lines.join("\n")}\n`);
    console.log(`wrote ${options.out}`);
  } else if (missing.length) {
    console.log(`\n${missing.slice(0, 40).join("\n")}`);
    if (missing.length > 40) console.log(`... and ${missing.length - 40} more`);
  }
}

// ---------------------------------------------------------------- build

async function readRules(dir) {
  const rules = {};
  let names = [];
  try {
    names = await readdir(join(dir, "rules"));
  } catch {
    return rules; // no rules/ directory — dictionary-only pack
  }
  for (const name of names.filter((file) => file.endsWith(".weir"))) {
    rules[basename(name, ".weir")] = await readFile(join(dir, "rules", name), "utf8");
  }
  return rules;
}

/**
 * Read a pack from a source directory or from a built `.weirpack`.
 *
 * Both are legitimate inputs to `export`: a directory is what you author, and a
 * pack is what a colleague sends you. A pack's `dictionary.dict` opens with an
 * entry count, which is not a word — hence the `slice(1)`.
 */
async function readPackSource(target) {
  if (target.endsWith(".weirpack")) {
    const { unpackWeirpackBytes } = await import("harper.js");
    const { manifest, files } = unpackWeirpackBytes(new Uint8Array(await readFile(target)));
    const dict = files.get("dictionary.dict") ?? "";
    const rules = Object.fromEntries([...files]
      .filter(([name]) => name.endsWith(".weir"))
      .map(([name, source]) => [basename(name, ".weir"), source]));
    return {
      manifest,
      entries: parseSource(dict.split(/\r?\n/).slice(1).join("\n")),
      rules,
      stem: basename(target, ".weirpack"),
    };
  }

  const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
  let entries = [];
  try {
    entries = parseSource(await readFile(join(target, "words.txt"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { manifest, entries, rules: await readRules(target), stem: basename(resolve(target)) };
}

async function buildOne(dir, outDir) {
  const { manifest, entries, rules, stem } = await readPackSource(dir);
  const { accepted, rejected } = sanitize(entries);
  const { bytes } = buildPack({ manifest, entries: accepted, rules });

  const target = join(outDir, `${stem}.weirpack`);
  await writeFile(target, bytes);

  const guessed = accepted.filter((entry) => entry.guessed).length;
  const ruleCount = Object.keys(rules).length;
  console.log(
    `${target}  ${plural(accepted.length, "word")}`
    + (guessed ? ` (${guessed} guessed)` : "")
    + (ruleCount ? `, ${plural(ruleCount, "rule")}` : "")
    + `, ${(bytes.length / 1024).toFixed(1)} KiB`,
  );
  for (const { word, reason } of rejected) {
    console.log(`  dropped ${word} — ${reason}`);
  }

  return { target, words: accepted.map((entry) => entry.word) };
}

async function commandBuild(dirs, options) {
  if (!dirs.length) fail("build needs at least one pack directory");
  const outDir = options.out ?? "dist";
  await mkdir(outDir, { recursive: true });
  for (const dir of dirs) await buildOne(dir, outDir);
}

// ---------------------------------------------------------------- export

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

/**
 * Write one pack out in one format.
 *
 * Each format reports the same three things — what it wrote, how many words are
 * in it, and how big it is — because the answer to "will this fit in my spell
 * checker" differs per target and is the user's call, not ours.
 */
async function exportOne(source, format, outDir) {
  const { manifest, entries, rules, stem } = source;
  const written = [];
  const notes = [];

  if (format === "weirpack") {
    const { bytes } = buildPack({ manifest, entries, rules });
    await writeFile(join(outDir, `${stem}.weirpack`), bytes);
    written.push([`${stem}.weirpack`, entries.length, bytes.length]);
  } else if (format === "hunspell") {
    const { dic, aff, notes: hunspellNotes } = toHunspell(entries, { name: stem });
    await writeFile(join(outDir, `${stem}.dic`), dic);
    await writeFile(join(outDir, `${stem}.aff`), aff);
    written.push([`${stem}.dic`, entries.length, dic.length], [`${stem}.aff`, null, aff.length]);
    notes.push(...hunspellNotes, "hunspell inflects from the .aff, so the forms are not written out");
  } else if (format === "word") {
    const { text, words, generated, bytes } = toWordList(entries);
    await writeFile(join(outDir, `${stem}-word.dic`), text);
    written.push([`${stem}-word.dic`, words.length, bytes]);
    notes.push(
      `${generated} inflected forms written out — Word has no affix engine`,
      "Word caps a custom dictionary's size and the cap varies by version; check"
      + ` yours against ${words.length} words / ${kib(bytes)}`,
    );
  } else if (format === "cspell") {
    const { text, config, words, generated } = toCspell(entries, {
      name: stem, description: manifest.description,
    });
    await writeFile(join(outDir, `${stem}-cspell.txt`), text);
    await writeFile(join(outDir, `${stem}-cspell.json`), config);
    written.push([`${stem}-cspell.txt`, words.length, text.length],
      [`${stem}-cspell.json`, null, config.length]);
    notes.push(`${generated} inflected forms written out — cspell reads a plain list`);
  } else if (format === "text") {
    const { text, words, bytes } = toWordList(entries, { expand: false });
    await writeFile(join(outDir, `${stem}.txt`), text);
    written.push([`${stem}.txt`, words.length, bytes]);
    notes.push("base spellings only — no inflections, no flags");
  }

  for (const [name, count, size] of written) {
    console.log(
      `  ${name.padEnd(28)}${count === null ? "" : plural(count, "word").padStart(12)}`
      + `  ${kib(size).padStart(9)}`,
    );
  }
  for (const note of notes) console.log(`    ${note}`);
}

async function commandExport(targets, options) {
  if (!targets.length) fail("export needs a pack directory or a .weirpack");

  const requested = options.format === "all"
    ? Object.keys(EXPORT_FORMATS)
    : options.format.split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = requested.filter((format) => !EXPORT_FORMATS[format]);
  if (unknown.length) {
    fail(`unknown format(s) ${unknown.join(", ")} `
      + `(expected ${Object.keys(EXPORT_FORMATS).join(", ")} or all)`);
  }

  const outDir = options.out ?? "dist";
  await mkdir(outDir, { recursive: true });

  for (const target of targets) {
    const source = await readPackSource(target);
    // Sanitising here rather than in core keeps `export` honest about the same
    // rules `build` applies: a word Harper could never match is not written out
    // in another format either.
    const { accepted, rejected } = sanitize(source.entries);
    console.log(`${target} -> ${outDir}/  (${plural(accepted.length, "word")})`);
    for (const { word, reason } of rejected) console.log(`  dropped ${word} — ${reason}`);

    for (const format of requested) {
      console.log(`  [${format}] ${EXPORT_FORMATS[format]}`);
      await exportOne({ ...source, entries: accepted }, format, outDir);
    }
  }
}

// ---------------------------------------------------------------- verify

async function commandVerify(packs, options) {
  if (!packs.length) fail("verify needs at least one .weirpack");

  const { unpackWeirpackBytes } = await import("harper.js");
  let failed = false;

  for (const pack of packs) {
    const bytes = new Uint8Array(await readFile(pack));
    const { files } = unpackWeirpackBytes(bytes);

    // Probe the base spellings the pack claims to add. Affix-generated forms are
    // covered by the round-trip in test/, not here.
    const dict = files.get("dictionary.dict") ?? "";
    const words = dict.split(/\r?\n/).slice(1)
      .map((line) => line.split("#")[0].trim())
      .filter(Boolean)
      .map((line) => line.split("/")[0]);

    // A clean linter per pack, so packs cannot mask each other's gaps.
    const linter = await createLinter(options.dialect ?? "american");
    try {
      const before = await probeWords(linter, words);
      const result = await verifyPack(linter, bytes, words);

      if (result.testFailures) {
        failed = true;
        console.log(`✗ ${pack} — Weir rule tests failed, nothing was imported`);
        for (const [rule, failures] of Object.entries(result.testFailures)) {
          for (const { expected, got } of failures) {
            console.log(`    ${rule}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
          }
        }
        continue;
      }

      if (result.ok) {
        console.log(
          `✓ ${pack} — ${plural(words.length, "word")} verified `
          + `(${before.unknown.length} were flagged before the pack loaded)`,
        );
      } else {
        failed = true;
        console.log(`✗ ${pack} — ${plural(result.stillFlagged.length, "word")} still flagged`);

        // Say *why* where we can. A word that imported without error and still
        // does not match is usually shadowed by another spelling of itself:
        // Harper's dictionary is keyed case-insensitively and keeps the last
        // entry, so `BUILDKIT` loses to `BuildKit`.
        const twins = caseTwins(words);
        let explained = 0;
        for (const word of result.stillFlagged.slice(0, 20)) {
          const twin = twins.get(word);
          if (twin) explained += 1;
          console.log(`    ${word.padEnd(24)}${twin ? `also in this pack as ${twin.join(", ")}` : ""}`);
        }
        if (result.stillFlagged.length > 20) {
          console.log(`    ... and ${result.stillFlagged.length - 20} more`);
        }
        if (explained) {
          console.log(
            "\n  Words listed with another spelling differ from it only by case."
            + " Harper keeps one entry per word regardless of case, so remove"
            + " whichever spelling you do not want.",
          );
        }
        if (explained < result.stillFlagged.length) {
          // The other reason, and it is not fixable from a pack at all: some
          // words are flagged by a *rule* that happens to report a Spelling
          // lint. `ok` is one — "Use `okay` instead of `ok`" survives however the
          // word is tagged. Like a dialect variant, such an entry is dead weight.
          console.log(
            "\n  The rest are flagged by a Harper rule rather than by a dictionary"
            + " lookup — `ok` gets \"Use `okay` instead of `ok`\", which no pack"
            + " entry can silence. Check the lint message; if it is advice rather"
            + " than \"misspelled\", drop the word.",
          );
        }
      }
    } finally {
      linter.dispose();
    }
  }

  if (failed) process.exit(1);
}

// ---------------------------------------------------------------- inspect

async function commandInspect(packs) {
  if (!packs.length) fail("inspect needs a .weirpack");
  const { unpackWeirpackBytes } = await import("harper.js");

  for (const pack of packs) {
    const bytes = new Uint8Array(await readFile(pack));
    const { manifest, files } = unpackWeirpackBytes(bytes);
    console.log(`${pack}  (${(bytes.length / 1024).toFixed(1)} KiB)`);
    console.log(`  manifest  ${JSON.stringify(manifest)}`);
    for (const [name, contents] of files) {
      if (name === "manifest.json") continue;
      const lines = contents.split("\n").filter(Boolean).length;
      console.log(`  ${name.padEnd(18)} ${plural(lines, "line")}`);
    }
  }
}

// ---------------------------------------------------------------- entry

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dialect: { type: "string" },
    format: { type: "string", default: "all" },
    out: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command, ...args] = positionals;

if (values.help || !command) {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}

const commands = {
  probe: () => commandProbe(args, values),
  build: () => commandBuild(args, values),
  export: () => commandExport(args, values),
  verify: () => commandVerify(args, values),
  inspect: () => commandInspect(args, values),
};

if (!commands[command]) fail(`unknown command '${command}'\n\n${USAGE}`);

await commands[command]().catch((error) => fail(error.message));
