// Unit tests for the browser-safe core. No Harper, no WASM — these run in
// milliseconds and cover the parsing and assembly logic.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  buildAnnotations,
  buildPack,
  collectFlags,
  detectListFormat,
  guessFlags,
  pairSourceFiles,
  parseAuto,
  parseHunspellDic,
  parseSource,
  parseWordList,
  renderDictionary,
  sanitize,
  validateManifest,
} from "../src/core/index.js";

const MANIFEST = {
  author: "Test", version: "1.0.0", description: "Test pack", license: "MIT",
};

describe("parseWordList", () => {
  it("ignores blanks and comments", () => {
    const entries = parseWordList("# a comment\n\nkubelet\n  etcd  \n");
    assert.deepEqual(entries.map((e) => e.word), ["kubelet", "etcd"]);
  });

  it("drops cspell forbidden words and strips affix markers", () => {
    const entries = parseWordList("!forbidden\n*suffixed\ncompound+\n");
    assert.deepEqual(entries.map((e) => e.word), ["suffixed", "compound"]);
  });

  it("strips cspell-tools directive comments", () => {
    // The @cspell/dict-* packages carry build directives in their word lists.
    // They are comments, so nothing special is needed to skip them — this pins
    // that, because a directive imported as a word would be silently absurd.
    const entries = parseWordList(
      "# cspell-tools: keep-case no-split\nkubelet\n# cspell-word-list-source: foo\netcd\n",
    );
    assert.deepEqual(entries.map((e) => e.word), ["kubelet", "etcd"]);
  });
});

describe("parseHunspellDic", () => {
  it("skips the leading count line and splits flags", () => {
    const entries = parseHunspellDic("3\nkubelet/NgS\netcd\nGrafana/O\n");
    assert.deepEqual(entries, [
      { word: "kubelet", flags: "NgS" },
      { word: "etcd", flags: null },
      { word: "Grafana", flags: "O" },
    ]);
  });

  it("keeps the first line when it is not a count", () => {
    assert.equal(parseHunspellDic("kubelet\netcd\n").length, 2);
  });

  it("drops trailing morphological fields", () => {
    const [entry] = parseHunspellDic("1\nkubelet/S po:noun is:plural\n");
    assert.deepEqual(entry, { word: "kubelet", flags: "S" });
  });

  it("honours an escaped slash in the word itself", () => {
    const [entry] = parseHunspellDic("1\\/2\n1\\/2/S\n");
    assert.equal(entry.word, "1/2");
  });
});

describe("detectListFormat and parseAuto", () => {
  // A `.txt` can be a plain list or weirsmith's own word/FLAGS format, and the
  // name cannot tell you which. Getting it wrong means reading `kubelet/~NgS` as
  // a word containing a slash and discarding it — so weirsmith would refuse to
  // read the file `probe --out` writes.
  it("recognises its own word/FLAGS format", () => {
    assert.equal(detectListFormat("# header\nkubelet/~NgS\nIstio/Og\n"), "source");
  });

  it("treats a plain word list as plain", () => {
    assert.equal(detectListFormat("kubelet\netcd\nIstio\n"), "plain");
  });

  it("is not fooled by a slash that is not a flag list", () => {
    // `and/or` and a URL both contain slashes; neither is a flag field.
    assert.equal(detectListFormat("and/or\nhttp://example.com\nTCP/IP\n"), "plain");
  });

  it("parses a flagged list keeping only the flags the file states", () => {
    // The unflagged line gets no flags here, even though parseSource would guess
    // some: a merge must not report a guess as something a source claimed.
    const entries = parseAuto("kubelet/~NgS\netcd\n", "words.txt");
    assert.deepEqual(entries, [
      { word: "kubelet", flags: "~NgS" },
      { word: "etcd", flags: null },
    ]);
  });

  it("round-trips what probe --out writes", () => {
    const written = "# 2 words no Harper dialect recognises.\nkubelet/~NgS\nQALY/OgS\n";
    const { accepted } = sanitize(parseAuto(written, "out.txt"));
    assert.deepEqual(accepted, [
      { word: "kubelet", flags: "~NgS" },
      { word: "QALY", flags: "OgS" },
    ]);
  });

  it("still parses a .dic as hunspell whatever its contents look like", () => {
    assert.deepEqual(parseAuto("1\nkubelet/MS\n", "en.dic"), [{ word: "kubelet", flags: "MS" }]);
  });

  it("sees through a .gz extension to the real one", () => {
    assert.deepEqual(parseAuto("1\nkubelet/MS\n", "en.dic.gz"), [{ word: "kubelet", flags: "MS" }]);
  });
});

describe("sanitize", () => {
  it("rejects entries Harper's tokenizer could never match", () => {
    const { accepted, rejected } = sanitize([
      { word: "kubelet" },
      { word: "low hanging" },
      { word: "blue-green" },
      { word: "kubelet" },
    ]);
    assert.deepEqual(accepted.map((e) => e.word), ["kubelet"]);
    assert.deepEqual(rejected.map((r) => r.reason), [
      "multi-word (Harper matches single tokens)",
      "hyphenated (the tokenizer splits on hyphens)",
      "duplicate",
    ]);
  });

  it("explains an underscore rather than calling it an unsupported character", () => {
    // Code identifiers are a big, specific category — 2,258 of them in a real
    // six-dictionary merge — and Harper splits on underscore just as it does on
    // hyphen, so `AF_APPLETALK` in a pack can never match `AF_APPLETALK` in text.
    // Asserted here because the reason string is the only thing telling a user to
    // add `APPLETALK` instead.
    const { accepted, rejected } = sanitize([{ word: "AF_APPLETALK" }]);
    assert.deepEqual(accepted, []);
    assert.match(rejected[0].reason, /underscore/);
  });

  it("keeps digits and apostrophes", () => {
    const { accepted } = sanitize([{ word: "NEWS2" }, { word: "o'clock" }]);
    assert.equal(accepted.length, 2);
  });
});

describe("the junk filter", () => {
  // Real dictionaries carry tokens that are not words: hex constants scraped out
  // of source comments, leetspeak, bare numbers. They are worse than useless in
  // a pack, because every entry widens Harper's accepted set.
  //
  // The hard part is not the rejecting, it is not over-rejecting. `DCB0129` is
  // made entirely of hex digits and `utf8mb4` interleaves letters and digits
  // twice — both are real vocabulary. A regex tuned to kill `0b00b135` kills
  // them too unless it is written carefully, so the whole fixture corpus is the
  // guard rail here, not a handful of examples.
  const JUNK = [
    ["000ff1ce", "hex constant, digits and hex letters interleaved"],
    ["0b00b135", "leetspeak"],
    ["0bab10c", "leetspeak, odd length"],
    ["deadbeef00", "long hex constant"],
    ["0xdeadbeef", "C hex literal"],
    ["12345", "all digits"],
    ["2024", "a bare year"],
  ];

  for (const [word, why] of JUNK) {
    it(`rejects ${word} (${why})`, () => {
      const { accepted, rejected } = sanitize([{ word }]);
      assert.deepEqual(accepted, [], `${word} should not survive sanitize()`);
      assert.match(rejected[0].reason, /not word-shaped|hex|digit/);
    });
  }

  it("keeps every word in the fixture corpus", async () => {
    // test/fixtures/example/words.txt exists partly to be this list: NEWS2, S3,
    // GP2GP, HL7, DCB0129, ISO13485, log4j, utf8mb4 and a11y are all legitimate
    // and all easy to reject by accident.
    const text = await readFile(new URL("./fixtures/example/words.txt", import.meta.url), "utf8");
    const words = parseSource(text);
    const { accepted, rejected } = sanitize(words);
    assert.deepEqual(
      rejected,
      [],
      `the junk filter ate real vocabulary: ${rejected.map((r) => r.word).join(", ")}`,
    );
    assert.equal(accepted.length, words.length);
  });

  it("keeps numeronyms and word-shaped hex", () => {
    // `i18n` Harper already knows; `deadbeef` too. Shape alone cannot tell a
    // hex constant from a word made of hex letters, so anything without a digit
    // is left to the probe to filter.
    const { accepted } = sanitize([{ word: "i18n" }, { word: "deadbeef" }, { word: "cafe" }]);
    assert.deepEqual(accepted.map((e) => e.word), ["i18n", "deadbeef", "cafe"]);
  });
});

describe("pairSourceFiles", () => {
  it("pairs a .dic with the .aff of the same stem", () => {
    assert.deepEqual(pairSourceFiles(["en.dic", "en.aff", "extra.txt"]), [
      { name: "en.dic", kind: "dic", aff: "en.aff" },
      { name: "extra.txt", kind: "list", aff: null },
    ]);
  });

  it("pairs through .gz on either side", () => {
    assert.deepEqual(pairSourceFiles(["en.dic.gz", "en.aff.gz"]), [
      { name: "en.dic.gz", kind: "dic", aff: "en.aff.gz" },
    ]);
  });

  it("leaves a .dic unpaired when no .aff was supplied", () => {
    assert.deepEqual(pairSourceFiles(["en.dic"]), [{ name: "en.dic", kind: "dic", aff: null }]);
  });

  it("does not pair an .aff with a differently named .dic", () => {
    const paired = pairSourceFiles(["en_GB.dic", "en_US.aff"]);
    assert.equal(paired[0].aff, null);
  });

  it("never treats an .aff as a source of words", () => {
    assert.deepEqual(pairSourceFiles(["en.aff"]), []);
  });
});

describe("guessFlags", () => {
  const cases = [
    ["NEWS2", "OgS", "acronym"],
    ["FHIR", "OgS", "acronym"],
    ["Grafana", "Og", "proper-noun"],
    ["quickly", "~R", "adverb"],
    ["observability", "~Nmg", "abstract-noun"],
    ["triaging", "~Nmg", "gerund"],
    ["pseudonymise", "~VGdS", "verb"],
    ["scalable", "~J", "adjective"],
    ["saturations", "~N", "already-plural"],
    ["kubelet", "~NgS", "countable-noun"],
  ];

  for (const [word, flags, rule] of cases) {
    it(`${word} -> ${flags} (${rule})`, () => {
      assert.deepEqual(
        { flags: guessFlags(word).flags, rule: guessFlags(word).rule },
        { flags, rule },
      );
    });
  }
});

describe("parseSource", () => {
  it("prefers explicit flags over guesses", () => {
    const [explicit, guessed] = parseSource("kubelet/~Nmg  # override\nkubelet2\n");
    assert.deepEqual(
      { flags: explicit.flags, guessed: explicit.guessed },
      { flags: "~Nmg", guessed: false },
    );
    assert.equal(guessed.guessed, true);
  });

  it("strips trailing comments and blank lines", () => {
    assert.equal(parseSource("# header\n\nkubelet   # trailing\n").length, 1);
  });
});

describe("renderDictionary", () => {
  it("writes the count line Rune expects", () => {
    const dict = renderDictionary([{ word: "kubelet", flags: "~NgS" }, { word: "etcd", flags: null }]);
    assert.equal(dict, "2\nkubelet/~NgS\netcd\n");
  });
});

describe("buildAnnotations", () => {
  it("emits only the flags in use", () => {
    const annotations = buildAnnotations([{ word: "kubelet", flags: "~NgS" }]);
    assert.deepEqual(Object.keys(annotations.affixes).sort(), ["S", "g"]);
    assert.deepEqual(Object.keys(annotations.properties).sort(), ["N", "~"]);
  });

  it("refuses a flag Harper has no definition for", () => {
    assert.throws(
      () => buildAnnotations([{ word: "kubelet", flags: "Ω" }]),
      /unknown Rune flag/,
    );
  });

  it("collects flags across every entry", () => {
    const flags = collectFlags([{ word: "a", flags: "NS" }, { word: "b", flags: "Og" }]);
    assert.deepEqual([...flags].sort(), ["N", "O", "S", "g"]);
  });
});

describe("validateManifest", () => {
  it("accepts a complete manifest", () => {
    assert.deepEqual(validateManifest(MANIFEST), []);
  });

  it("names every missing required field", () => {
    const problems = validateManifest({ author: "Test" });
    assert.equal(problems.length, 3);
    assert.ok(problems.every((p) => /version|description|license/.test(p)));
  });

  it("rejects a non-string field", () => {
    assert.deepEqual(validateManifest({ ...MANIFEST, version: 1 }), [
      "manifest.version must be a non-empty string",
    ]);
  });
});

describe("buildPack", () => {
  it("produces a zip carrying the three dictionary files", () => {
    const { bytes, files } = buildPack({
      manifest: MANIFEST,
      entries: [{ word: "kubelet", flags: "~NgS" }],
    });
    assert.deepEqual(
      [...files.keys()].sort(),
      ["annotations.json", "dictionary.dict", "manifest.json"],
    );
    assert.equal(bytes[0], 0x50); // "PK" — it really is a zip
    assert.equal(bytes[1], 0x4b);
  });

  it("omits dictionary files for a rules-only pack", () => {
    const { files } = buildPack({ manifest: MANIFEST, rules: { Example: "expr main test" } });
    assert.deepEqual([...files.keys()].sort(), ["Example.weir", "manifest.json"]);
  });

  it("refuses to build without the required manifest fields", () => {
    assert.throws(() => buildPack({ manifest: { author: "Test" } }), /must be a non-empty string/);
  });

  it("produces identical archive contents for identical input", () => {
    // Determinism is asserted on the *contents*, not on the zip bytes, and that
    // is not a cop-out: harper.js's `packWeirpackFiles(files)` calls fflate's
    // `zipSync` with no mtime and takes no options, so every entry is stamped
    // with the time of the build. Two builds of the same input a few seconds
    // apart therefore differ in the container while being identical in every
    // byte that Harper reads.
    //
    // So `.weirpack` files cannot be compared with a checksum. Compare what is
    // inside them.
    const build = () => buildPack({
      manifest: MANIFEST,
      entries: [{ word: "kubelet", flags: "~NgS" }, { word: "etcd", flags: "~Nmg" }],
    });
    assert.deepEqual([...build().files], [...build().files]);
  });
});
