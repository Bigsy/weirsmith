// Integration tests: build a pack from the fixture corpus, load it into a real
// Harper, and check the words, the forms the affix flags generate, and that the
// pack does not make Harper worse.
//
// The corpus is `test/fixtures/example/` — a test fixture, not a shipped pack.
// weirsmith converts the dictionaries a user brings and ships no word data of
// its own, so there is no `packs/` directory to test against. What the fixture
// preserves is coverage: real vocabulary Harper genuinely does not know, one
// base word per affix branch, and the letter/digit tokens the junk filter must
// not reject.
//
// The generated forms are the part that is easy to get wrong. `SLO/OgS` is only
// worth writing instead of three separate entries if the `S` affix really does
// produce `SLOs`, and the affix conditions are character classes that care
// about the final letter — `QALY` ends in an uppercase Y, which matches a
// different branch than a lowercase one would.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";

import {
  buildPack, expandEntries, mergeSources, parseHunspellSource, parseSource, probeDialects,
  probeWords, sanitize, verifyPack,
} from "../src/core/index.js";
import { createLinter } from "../src/node/linter.js";

const FIXTURES = new URL("./fixtures/", import.meta.url);

/** Build the fixture pack straight from source, never from dist/. */
async function buildFixturePack() {
  const dir = new URL("example/", FIXTURES);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", dir), "utf8"));
  const entries = parseSource(await readFile(new URL("words.txt", dir), "utf8"));
  const { accepted } = sanitize(entries);
  return { ...buildPack({ manifest, entries: accepted }), words: accepted.map((e) => e.word) };
}

/** Read a fixture word list, ignoring comments. */
async function readWords(name) {
  return parseSource(await readFile(new URL(name, FIXTURES), "utf8")).map((e) => e.word);
}

/**
 * Forms that must exist but are never written down, one per affix branch.
 * Writing `kubelets` by hand would make this test prove nothing.
 */
const INFLECTIONS = [
  ["kubelet", ["kubelets", "kubelet's"]],
  ["formulary", ["formularies"]],
  ["QALY", ["QALYs"]],
  ["SLO", ["SLOs"]],
  ["protobuf", ["protobufs"]],
  ["deprescribe", ["deprescribes", "deprescribed", "deprescribing"]],
  ["rerender", ["rerenders", "rerendered", "rerendering"]],
];

describe("example pack", () => {
  let linter;
  let pack;

  before(async () => {
    pack = await buildFixturePack();
    linter = await createLinter("american");
    const failures = await linter.loadWeirpackFromBytes(pack.bytes);
    assert.equal(failures, undefined, `pack failed to import: ${JSON.stringify(failures)}`);
  });

  after(() => linter?.dispose());

  it("every word in the pack lints clean", async () => {
    const { unknown } = await probeWords(linter, pack.words);
    assert.deepEqual(unknown, [], `still flagged: ${unknown.join(", ")}`);
  });

  it("affix flags generate the expected forms", async () => {
    const expected = INFLECTIONS.flatMap(([, forms]) => forms);
    const { unknown } = await probeWords(linter, expected);
    assert.deepEqual(unknown, [], `inflections not generated: ${unknown.join(", ")}`);
  });

  it("declares every flag its dictionary uses", async () => {
    const annotations = JSON.parse(pack.files.get("annotations.json"));
    const declared = new Set([
      ...Object.keys(annotations.affixes),
      ...Object.keys(annotations.properties),
    ]);
    const used = new Set(
      pack.files.get("dictionary.dict").split("\n").slice(1)
        .filter(Boolean)
        .flatMap((line) => [...(line.split("/")[1] ?? "")]),
    );
    for (const flag of used) assert.ok(declared.has(flag), `flag '${flag}' is not declared`);
  });
});

describe("expansion for targets with no affix engine", () => {
  // Word and cspell read a flat list, so `expandEntries` has to generate the
  // inflected forms itself — the one place weirsmith does the job it otherwise
  // leaves to Harper (see the header of src/core/affix.js).
  //
  // Harper is the oracle for that, in both directions: nothing we generate may
  // be a form Harper rejects, and nothing Harper is known to generate may be
  // missing from our output. Asserting only the first would pass a "generate
  // nothing at all" bug.
  let linter;
  let entries;

  before(async () => {
    const dir = new URL("example/", FIXTURES);
    const manifest = JSON.parse(await readFile(new URL("manifest.json", dir), "utf8"));
    ({ accepted: entries } = sanitize(parseSource(await readFile(new URL("words.txt", dir), "utf8"))));
    linter = await createLinter("american");
    const failures = await linter.loadWeirpackFromBytes(buildPack({ manifest, entries }).bytes);
    assert.equal(failures, undefined, `pack failed to import: ${JSON.stringify(failures)}`);
  });

  after(() => linter?.dispose());

  it("generates no form Harper rejects", async () => {
    const { words, generated } = expandEntries(entries);
    assert.ok(generated > 20, `expansion produced only ${generated} extra forms`);
    const { unknown } = await probeWords(linter, words);
    assert.deepEqual(unknown, [], `we generate forms Harper does not accept: ${unknown.join(", ")}`);
  });

  it("misses none of the forms Harper generates", () => {
    const { byWord } = expandEntries(entries);
    for (const [word, forms] of INFLECTIONS) {
      const ours = byWord.get(word) ?? [];
      for (const form of forms) {
        assert.ok(ours.includes(form), `expansion of ${word} is missing ${form}`);
      }
    }
  });
});

describe("the dialect trap", () => {
  // Two things that look identical when you probe one dialect and are not the
  // same thing at all: a word Harper has never heard of, and a word Harper
  // knows and is correctly flagging as the wrong dialect. Only the first
  // belongs in a pack; adding the second is inert, because the dialect check
  // never consults pack dictionaries.
  //
  // This test also keeps "every word in the pack lints clean" honest. That test
  // is vacuous if Harper knew the words all along, so the same run asserts the
  // corpus really is missing everywhere.
  let classified;
  let fixtureWords;
  let variants;

  before(async () => {
    fixtureWords = (await buildFixturePack()).words;
    variants = await readWords("dialect-variants.txt");
    classified = await probeDialects(createLinter, [...fixtureWords, ...variants]);
  });

  it("classifies every fixture word as missing in all five dialects", () => {
    const missing = new Set(classified.missing);
    const found = fixtureWords.filter((word) => !missing.has(word));
    assert.deepEqual(found, [], `Harper has learnt these — swap them out: ${found.join(", ")}`);
  });

  it("classifies dialect variants as variants, not as gaps", () => {
    // Asserted as "some but not all dialects", never as a specific dialect
    // list: which dialects flag `haematology` is Harper's business.
    const flagged = new Map(classified.dialectVariants.map((v) => [v.word, v.flaggedIn]));
    for (const word of variants) {
      assert.ok(flagged.has(word), `${word} was not classified as a dialect variant`);
      assert.ok(flagged.get(word).length > 0, `${word} was flagged in no dialect`);
    }
    assert.deepEqual(
      variants.filter((word) => classified.missing.includes(word)),
      [],
      "a dialect variant was reported as a genuine gap — it would be dead weight in a pack",
    );
  });
});

describe("merging two dictionaries whose flags collide", () => {
  // The merge invariant, asserted against a real linter rather than in the
  // abstract. Two sources both use the flag letter `S`, and it means a different
  // rule in each: the plural in one, `-ness` in the other. Read through their own
  // `.aff` files they translate to different Harper flags; concatenated raw they
  // would both look like Harper's plural, and the pack would build anyway with
  // the wrong forms in it.
  //
  // `nosocomial` is the discriminator. If the merge is right, Harper generates
  // `nosocomialness` and not `nosocomials`. If the flags collided, the reverse.
  const PLURAL_AFF = [
    "SFX S Y 4",
    "SFX S y ies [^aeiou]y", "SFX S 0 s [aeiou]y", "SFX S 0 es [sxzh]", "SFX S 0 s [^sxzhy]",
  ].join("\n");
  const NESS_AFF = [
    "SFX S Y 3",
    "SFX S y iness [^aeiou]y", "SFX S 0 ness [aeiou]y", "SFX S 0 ness [^y]",
  ].join("\n");

  let linter;

  before(async () => {
    const merged = mergeSources([
      {
        name: "plural-S",
        ...parseHunspellSource({ dic: "1\nformulary/S\n", aff: PLURAL_AFF }),
      },
      {
        name: "ness-S",
        ...parseHunspellSource({ dic: "1\nnosocomial/S\n", aff: NESS_AFF }),
      },
    ]);
    assert.deepEqual(
      merged.entries.map((e) => `${e.word}/${e.flags}`),
      ["formulary/S", "nosocomial/p"],
      "the two S flags did not translate to different Harper flags",
    );

    const { bytes } = buildPack({
      manifest: {
        author: "weirsmith test suite",
        version: "0.1.0",
        description: "Two sources, one flag letter, two meanings.",
        license: "MIT",
      },
      entries: merged.entries,
    });

    linter = await createLinter("american");
    assert.equal(await linter.loadWeirpackFromBytes(bytes), undefined);
  });

  after(() => linter?.dispose());

  it("generates each source's real forms", async () => {
    const { unknown } = await probeWords(linter, ["formularies", "nosocomialness"]);
    assert.deepEqual(unknown, [], `not generated: ${unknown.join(", ")}`);
  });

  it("does not generate the forms the other source's S would have produced", async () => {
    // If `nosocomial` had picked up the plural S, this would come back clean —
    // and nothing else in the suite would have noticed.
    const { unknown } = await probeWords(linter, ["nosocomials"]);
    assert.deepEqual(unknown, ["nosocomials"], "the two sources' S flags collided");
  });
});

describe("a case collision costs a word", () => {
  // Why `mergeSources` reports collisions and why the UI verifies what it builds.
  // Harper keys its dictionary case-insensitively, so a pack containing two
  // spellings of one word imports cleanly and adds only one of them. Nothing
  // errors; the pack simply does less than it claims.
  //
  // Asserted as "one of the pair is still flagged", never which one — that is
  // Harper's business. What weirsmith relies on is only that the loss is real and
  // that `verifyPack` sees it.
  let linter;

  before(async () => {
    const { bytes } = buildPack({
      manifest: {
        author: "weirsmith test suite",
        version: "0.1.0",
        description: "Two spellings of one word.",
        license: "MIT",
      },
      // Invented, so no Harper release can start knowing them.
      entries: [{ word: "ZorbLat", flags: "Og" }, { word: "ZORBLAT", flags: "OgS" }],
    });
    linter = await createLinter("american");
    assert.equal(await linter.loadWeirpackFromBytes(bytes), undefined, "the pack imported cleanly");
  });

  after(() => linter?.dispose());

  it("imports without error and still leaves one spelling flagged", async () => {
    const { unknown } = await probeWords(linter, ["ZorbLat", "ZORBLAT"]);
    assert.equal(
      unknown.length,
      1,
      `expected exactly one spelling to be shadowed, got ${JSON.stringify(unknown)}`,
    );
  });

  it("is invisible without verification, which is the point", async () => {
    // A single entry works fine. The collision is what breaks it, so no amount of
    // checking the *input* would catch this — only loading the built pack does.
    const { bytes } = buildPack({
      manifest: {
        author: "weirsmith test suite",
        version: "0.1.0",
        description: "One spelling.",
        license: "MIT",
      },
      entries: [{ word: "ZorbLat", flags: "Og" }],
    });
    const clean = await createLinter("american");
    try {
      const result = await verifyPack(clean, bytes, ["ZorbLat"]);
      assert.equal(result.ok, true, "one spelling on its own verifies clean");
    } finally {
      clean.dispose();
    }
  });
});

describe("packs do not regress Harper", () => {
  // A pack that quietly stops Harper catching real typos is worse than no pack.
  // Every added word widens the spell checker's accepted set and feeds its
  // suggestion engine, so this is the check that matters most.
  //
  // Measured as a before/after diff rather than a fixed expectation: not every
  // misspelling is a Spelling lint (Harper catches `occured` with a Typo rule),
  // and hardcoding which is which would test Harper, not the packs.
  const TYPOS = ["wierd", "recieve", "seperate", "occured", "definately", "acheive", "concious"];
  const ORDINARY = ["hospital", "computer", "patient", "database", "clinical", "network"];

  it("classifies typos and ordinary words exactly as it did before", async () => {
    const probeAll = async (linter) => {
      const typos = await probeWords(linter, TYPOS);
      const ordinary = await probeWords(linter, ORDINARY);
      return { flaggedTypos: typos.unknown, flaggedOrdinary: ordinary.unknown };
    };

    const baselineLinter = await createLinter("american");
    let baseline;
    try {
      baseline = await probeAll(baselineLinter);
    } finally {
      baselineLinter.dispose();
    }

    const linter = await createLinter("american");
    try {
      const { bytes } = await buildFixturePack();
      assert.equal(await linter.loadWeirpackFromBytes(bytes), undefined);
      const afterLoad = await probeAll(linter);

      assert.deepEqual(
        afterLoad.flaggedTypos,
        baseline.flaggedTypos,
        "a pack swallowed a misspelling Harper used to catch",
      );
      assert.deepEqual(
        afterLoad.flaggedOrdinary,
        baseline.flaggedOrdinary,
        "a pack started flagging an ordinary word",
      );
    } finally {
      linter.dispose();
    }
  });
});
