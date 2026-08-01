# weirsmith

Convert your own dictionaries into a [Harper](https://writewithharper.com)
Weirpack — in your browser, or from the command line.

Harper is a fast, private, offline grammar checker. Its curated dictionary is
good, but it will never contain your stack's vocabulary, your industry's jargon
or your company's product names — and the official route for adding words is to
open a pull request against Harper itself.

Weirpacks are the escape hatch. weirsmith builds them from files you already
have.

**weirsmith ships no word data of its own.** It is a converter, not a
dictionary: you bring the words, it tells you which ones Harper is actually
missing, helps you tag them, and emits a pack. The licence of whatever you
convert travels with your pack and is yours to honour — the same position a
compiler is in.

## The point is the probe, not the conversion

Reformatting a `.dic` into a `.weirpack` is fifty lines and nobody needs a
project for it. The reason to use weirsmith is that it measures what is *worth*
converting.

Point it at `dictionary-en`, a standard 49,555-word English hunspell dictionary:

```
$ weirsmith probe node_modules/dictionary-en/index.dic

index.dic  49565 entries
  paired with index.aff: 17 of 23 flags map onto Harper's (A→r I→i V→v N→n J→z D→d T→^ R→> P→p M→g)
  no Harper equivalent, flag dropped on: C (de-) ×207, E (dis-) ×207, F (con-) ×76, K (pro-) ×52, H (-ieth) ×63, Z (-iers) ×1377
  skipped 3: only valid inside a compound, not a word on its own

49565 entries after merging
  skipped     10  not word-shaped (all digits)

Harper already knows 49412 words (100%)

missing everywhere: 143 words
```

**99.7%.** Converting that dictionary would add 49,412 words Harper already had,
and every one of them makes Harper worse — see below. The 143 left over are
mostly abbreviations.

That number, applied to *your* dictionary, is the product.

## Why bulk converting hurts

Harper's spell checker uses Levenshtein automata over its dictionary. Every word
you add widens the accepted set *and* feeds the suggestion engine, so a bulk
import quietly stops Harper catching real typos and makes its suggestions worse.
A curated 2 KiB pack beats a bulk 2 MiB one comfortably.

So the pipeline is **probe → filter → tag**, and weirsmith reports what it
dropped rather than silently shrinking your input. There is a regression test
that loads a pack and asserts Harper still classifies known misspellings and
ordinary words exactly as it did before.

## In the browser

Use the hosted version at **[weirsmith.bigsy.uk](https://weirsmith.bigsy.uk/)**,
or run it locally:

```bash
npm run web        # then open http://localhost:8080
npm run build:web  # a self-contained dist/web for any static host
```

Drop in your files, probe, tag the survivors, download the pack. **Nothing is
uploaded** — your dictionary is read by your own browser and there is no server
to send it to. That is also why the licensing position above is honest rather
than a disclaimer.

It works on plain static hosting, including GitHub Pages: Harper is
single-threaded — no `SharedArrayBuffer`, no `Atomics` — so no COOP/COEP headers
are needed. The cold load is about 8 MB gzipped of WebAssembly and ~600 ms of
compile, cached afterwards. `src/web/measure.html` re-measures that whenever
harper.js is bumped.

## On the command line

```bash
weirsmith probe  <file...> [--dialect <name>] [--out words.txt]
weirsmith build  <dir...>  [--out dist]
weirsmith export <dir|pack...> [--format hunspell,word,cspell] [--out dist]
weirsmith verify <pack...>
weirsmith inspect <pack>
```

Input can be plain word lists, hunspell `.dic`, weirsmith's own `word/FLAGS`
format, and `.gz` of any of them. Pass several files and they are merged, with a
report of what each one contributed:

```
$ weirsmith probe en.dic en.aff jargon.txt clinical.txt

what each source added that no earlier one had:
  en.dic                        49565 new of 49565 (100%)
  jargon.txt                      412 new of 500 (82%)
  clinical.txt                     18 new of 400 (5%)
```

Often the honest answer is that a source was not worth including.

## Hunspell affix flags

Supply a `.dic` **and** its `.aff` and the affix flags are translated into
Harper's own, so plurals and verb forms keep working instead of being dropped.

The mapping is derived, never hardcoded: weirsmith parses both affix tables and
matches them by rule. Against `dictionary-en`, 17 of 23 flags match a Harper
flag exactly — 7 under the same letter (`U X Y G S B L`) and 10 under a
different one (`A→r`, `M→g`, `T→^`, `R→>` …). Harper's Rune annotations are
evidently derived from the same SCOWL affix conventions.

Six have no Harper equivalent — `de-`, `dis-`, `con-`, `pro-`, ordinal `-th` and
`-ers`. For those the **word is kept and the flag dropped**, with a count per
flag so the loss is visible rather than assumed.

Without an `.aff`, flags are dropped rather than carried through. A flag letter
only means something in the file that defines it: in `dictionary-en` `M` is the
possessive and `S` the plural, and another dictionary is free to use `M` for
`-ment`. Merging raw flag fields from two dictionaries produces flags that are
all still valid characters and now mean the wrong thing — nothing errors, the
pack builds, and the inflections are silently wrong.

## The dialect trap

Probing under a single dialect gives a misleading answer.

```
$ weirsmith probe clinical.txt --dialect all

8 words Harper knows but flags in some dialects — do NOT add these,
they are handled by the dialect setting:
  haematology            flagged in american, canadian
  paediatrics            flagged in american
  pediatrics             flagged in british, australian, canadian, indian
```

Harper knows `haematology` perfectly well; under American English it is
deliberately flagging it as the wrong dialect and suggesting `hematology`.
Adding it to a pack does **nothing** — the dialect check never consults pack
dictionaries, so the lint survives and the pack carries a dead entry.

`--dialect all` separates *"Harper has never heard of this"* from *"wrong
dialect for this setting"*. Only the first kind belongs in a pack. The browser
UI always probes all five, and `all` is the CLI's probe default. Select one
dialect explicitly only when you deliberately want a dialect-specific report.

There is a third kind, and `verify` is what finds it: a word flagged by a Harper
**rule** rather than by a dictionary lookup. `ok` is reported as a `Spelling`
lint, but the message is "Use `okay` instead of `ok`" — add `ok` to a pack and it
imports cleanly while `ok`, `Ok` and `OK` all stay flagged. Nothing in a
dictionary can silence a rule, so those entries are dead weight too.

## The Weirpack format

Harper's [Weir documentation](https://writewithharper.com/docs/weir#Weirpacks)
covers the rules half of the format and omits dictionaries entirely. This is
what a pack actually is.

A `.weirpack` is a plain **ZIP**:

| File | Purpose | Required |
|---|---|---|
| `manifest.json` | metadata | **yes** |
| `dictionary.dict` | word list | no |
| `annotations.json` | flag definitions the word list uses | no |
| `*.weir` | rules; rule name is the filename stem | no |

`manifest.json` must carry four string fields or the import fails outright:

```json
{
  "author": "Ada Lovelace",
  "version": "1.0.0",
  "description": "Rules for Victorian technical writing.",
  "license": "MIT"
}
```

Extra fields (`keywords`, `website`) are allowed and ignored.

`dictionary.dict` is Harper's "Rune" format, which is hunspell's `.dic` with the
affix table moved into JSON — an approximate entry count on the first line, then
`word/FLAGS`:

```
3
kubelet/~NgS        # inline comments are fine
Grafana/Og
etcd/~Nmg
```

`annotations.json` is `{"affixes": {...}, "properties": {...}}`, keyed by single
characters, and only needs the flags that dictionary actually uses. weirsmith
emits the minimum and slices the definitions verbatim from upstream
(`tools/sync-flags.mjs`).

**Dictionary-only packs with no rules are valid and work.** That is the case the
docs don't mention.

Note that the ZIP is **not reproducible**: `packWeirpackFiles` calls fflate's
`zipSync` without an mtime and takes no options, so every entry is stamped with
the time of the build. Two builds of identical input differ in the container
while being identical in every byte Harper reads. Compare pack *contents*, not
checksums.

### Flags

Properties attach metadata; affixes generate extra word forms.

| Flag | Kind | Effect |
|---|---|---|
| `~` | property | common word |
| `N` `O` `V` `J` `R` | property | noun, proper noun, verb, adjective, adverb |
| `m` / `w` | property | mass noun only / mass + countable |
| `S` | affix | plural — handles `-s`, `-es`, `y→ies` |
| `g` | affix | possessive `'s` |
| `G` / `d` | affix | `-ing` (drops a trailing `e`) / `-ed` |
| `Y` `B` `L` `n` `p` | affix | `-ly`, `-able`, `-ment`, `-ion`, `-ness` |

The full set is in `src/core/harper-flags.js`.

So one line does the work of several:

```
SLO/OgS           ->  SLO, SLOs, SLO's
deprescribe/~VGdS ->  deprescribe, deprescribes, deprescribed, deprescribing
formulary/~NgS    ->  formulary, formularies, formulary's
```

Don't write the inflected forms out by hand — `test/packs.test.js` asserts the
affixes really do generate them.

### The one real gotcha

`import_weirpack` runs every `test` and `allows` assertion in the pack's `.weir`
rules **before** importing anything. If one fails, nothing at all is imported
and you get a `{ruleName: [{expected, got}]}` map back instead of `undefined`.

`undefined` means success. `weirsmith verify` reports the failures readably.

## Authoring a pack by hand

A pack directory is a manifest, a word list and optionally some rules:

```
mypack/
  manifest.json
  words.txt
  rules/            # optional
    MyRule.weir
```

`words.txt` is one entry per line. Flags are optional — omit them and weirsmith
guesses from the word's shape, which is fine for the long tail:

```
kubelet/~NgS        # explicit flags win
Grafana             # guessed: starts with a capital -> Og
observability/~Nmg  # trailing comments are stripped
```

The guesses are deliberately conservative (a wrong noun/verb tag is worse than a
plain noun tag), so ambiguous endings fall through to a countable noun. Graded
against WordNet on 78,019 words the guess agrees **80%** of the time, so check
anything you care about — that is what the browser UI's tagging step is for.

## Using a pack

Weirpack loading is supported by `harper-cli`, `harper.js`, the official Harper
Chrome extension and Harper Desktop.

```bash
harper-cli lint --weirpack mypack.weirpack README.md
```

```js
import { readFile } from 'node:fs/promises';
import { Dialect, LocalLinter } from 'harper.js';
import { binary } from 'harper.js/binary';

const bytes = await readFile('mypack.weirpack');
const linter = new LocalLinter({ binary, dialect: Dialect.American });
await linter.setup();

try {
  const failures = await linter.loadWeirpackFromBytes(bytes);
  if (failures !== undefined) console.error('rule tests failed', failures);
} finally {
  linter.dispose();
}
```

## The same list in other spell checkers

A curated list is worth more than one spell checker, so `export` writes it out
for the others. One thing decides how each target is treated: **whether it has
an affix engine.**

```
$ weirsmith export mypack --format hunspell,word

  [hunspell] .dic + .aff — LibreOffice, hunspell, most Unix spell checkers
  mypack.dic                      23 words    0.2 KiB
  mypack.aff                                  0.6 KiB
    property flags have no hunspell equivalent, word kept and flag dropped: ~ ×12, O ×11, N ×9
    hunspell inflects from the .aff, so the forms are not written out
  [word] flat one-word-per-line .dic — Microsoft Word custom dictionary
  mypack-word.dic                 53 words    0.4 KiB
    30 inflected forms written out — Word has no affix engine
```

**hunspell has one**, so nothing is expanded: Harper's flag definitions are
transcribed into an `.aff` and the `.dic` carries `word/FLAGS` unchanged. The two
formats describe an affix identically — a list of `(remove, add, condition)`
triples — which is the correspondence `src/core/affix.js` already relies on in
the opposite direction. So hunspell inflects the words exactly as Harper does,
rather than us writing forms out and hoping. `test/export.test.js` round-trips
the result back through weirsmith's own `.aff` derivation and asserts it
recovers the flags it started from.

Two things are lost on the way, and both are reported rather than assumed:
Harper's **property** flags (`~` common, `N` noun, `m` mass) describe what a word
*is* and hunspell has nowhere to put them, so the word is kept and the flag
dropped; and `>` and `^` are renamed to `E` and `T`, because hunspell's tooling
treats those two characters as syntax.

**Word and cspell have no affix engine**, so for those the forms *are* written
out — the one place weirsmith expands affixes itself. Harper is the oracle for
that in `test/packs.test.js`: every form the expander generates must be one a
real Harper accepts from the same flags, and every form the suite knows Harper
generates must appear in the expansion. Asserting only the first would let
"generate nothing at all" pass.

`--format text` is base spellings only, for anything that just wants a list.
Word caps the size of a custom dictionary and the cap varies by version, so the
report gives you the word count and the byte size to check yours against.

## Where to find dictionaries

Look for **domain vocabulary**, not for dictionaries of languages. Harper checks
English only — five dialects, no French or German mode — and it already knows
general English. A field's jargon is where the gaps are, and the difference is
not marginal:

| Source | Usable words | New to Harper | % |
|---|---|---|---|
| `@cspell/dict-cpp` | 32,262 | 18,326 | 57% |
| `@cspell/dict-python` | 8,613 | 3,841 | 45% |
| `@cspell/dict-software-terms` | 4,082 | 1,881 | 46% |
| `@cspell/dict-cryptocurrencies` | 627 | 454 | 72% |
| `@cspell/dict-aws` | 1,522 | 152 | 10% |
| `dictionary-en` (general English) | 49,555 | 143 | **0.3%** |

Measured across all five dialects on 2026-07-25. `src/web/sources.html` has the
full table, the licences (verified against the published tarballs) and the
domains where nothing good exists yet.

Four things worth knowing before you go looking:

- **A high percentage is not permission to take it all.** `dict-cpp`'s 18,326 new
  words are mostly API identifiers — `Conv1d`, `wcscspn` — not prose. Novelty
  means the dictionary is on-topic, not that every word in it earns a place.
- **Maths, science and finance are largely a gap.**
  `@cspell/dict-scientific-terms-us` is the obvious candidate and is unusable: its
  maths list contains exactly one word and everything else is inside a
  `.trie.gz`. For finance, your own documents are the realistic source.
- **Not everything labelled "cspell" is MIT.** `@cspell/dict-medicalterms` is
  GPL-3.0-or-later; its tarball carries the full GPLv3.
- **cspell's *language* dictionaries ship a compiled trie** and no plain word
  list. weirsmith does not decode that. The *domain* dictionaries are plain text
  and work fine.

## What will not work

- **Hyphenated, underscored or multi-word entries.** Harper matches single
  tokens, so `blue-green`, `AF_APPLETALK` and `low hanging` can never fire — the
  tokenizer splits them first, and `AF_APPLETALK` lints as `APPLETALK`. They are
  dropped and reported, which matters more than it sounds: underscored code
  identifiers were 16% of a real six-dictionary merge.
- **Junk that looks like words.** Hex constants, leetspeak and bare numbers are
  rejected — carefully, because `DCB0129`, `utf8mb4`, `S3`, `GP2GP`, `HL7`,
  `log4j` and `a11y` are all legitimate and all easy to reject by accident.
- **Whole general-English dictionaries.** They convert; they just don't help.

## Development

```bash
make            # list the targets
make test       # 173 tests; the pack suites load a real Harper
make web        # the UI, at http://localhost:8080
make check      # tests, then a real pack build and verification
make probe FILE=node_modules/dictionary-en/index.dic
make export DIR=mypack   # every format, into dist/
```

Dependencies install themselves — `make test` works in a fresh clone. The
targets wrap the npm scripts, which stay the source of truth because CI calls
them directly: `npm test`, `npm run build`, `npm run verify`, `npm run web`,
`npm run build:web`.

The suite is six files. `test/core.test.js`, `test/affix.test.js`,
`test/merge.test.js` and `test/export.test.js` are pure and run in milliseconds —
`make watch` re-runs those on every save. `test/packs.test.js` boots a real
Harper and takes a couple of seconds, which is the point: it builds a pack from
source, loads it, and checks the words, the affix-generated forms, the expansion
the flat-file exporters depend on, the dialect split and that Harper still
catches the typos it caught before.

`src/core/` is browser-safe — it takes and returns strings and bytes and never
touches a file system, so the same code backs both front ends. Node I/O lives in
`src/cli.js`, browser I/O in `src/web/read.js`, and the Harper linter is
injected rather than imported, so the browser passes a `WorkerLinter` where the
CLI passes a `LocalLinter`.

There is no bundler. The browser resolves bare specifiers through an import map,
and `npm run build:web` copies files and rewrites that map.

## Roadmap

- Weir *rule* authoring. weirsmith handles the dictionary half of the format;
  the rules half is currently pass-through only.
- `FLAG long` and `FLAG num` hunspell dictionaries are parsed but untested
  against a real one.
- cspell `.trie` decoding, if someone actually needs a language dictionary.

## Licence

weirsmith's original source is MIT licensed. The Harper flag definitions in
`src/core/harper-flags.js` are modified from
[Automattic/harper](https://github.com/Automattic/harper) under Apache-2.0; see
`THIRD_PARTY_NOTICES.md` and `LICENSES/` for attribution and complete
third-party licence texts.
