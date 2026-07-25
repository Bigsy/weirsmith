// Unit tests for `.aff` parsing and flag derivation. No Harper, no WASM.
//
// `dictionary-en` is a pinned devDependency and is used here as a fixture: it is
// the reference hunspell dictionary, and the whole claim of Phase 1 — that
// hunspell's affix table and Harper's describe the same rules — is a claim about
// real files, not about a synthetic example. The version is pinned exactly
// because these tests assert measured counts against it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, describe, it } from "node:test";

import {
  deriveFlagMap, joinFlags, parseAff, parseHunspellSource, splitFlags, translateFlags,
} from "../src/core/index.js";

const EN = new URL("../node_modules/dictionary-en/", import.meta.url);

describe("splitFlags", () => {
  it("splits single-character flags", () => {
    assert.deepEqual(splitFlags("MS!", "single"), ["M", "S", "!"]);
  });

  it("splits two-character flags in long mode", () => {
    assert.deepEqual(splitFlags("MSaB", "long"), ["MS", "aB"]);
  });

  it("splits numeric flags on commas", () => {
    assert.deepEqual(splitFlags("1,23,456", "num"), ["1", "23", "456"]);
  });

  it("round-trips through joinFlags", () => {
    for (const [flags, mode] of [["MS", "single"], ["MSaB", "long"], ["1,23", "num"]]) {
      assert.equal(joinFlags(splitFlags(flags, mode), mode), flags);
    }
  });

  it("treats a missing flag field as no flags", () => {
    assert.deepEqual(splitFlags(null), []);
  });
});

describe("parseAff", () => {
  it("parses a suffix block into replacements", () => {
    const { affixes } = parseAff("SFX G Y 2\nSFX G e ing e\nSFX G 0 ing [^e]\n");
    assert.deepEqual(affixes.get("G"), {
      flag: "G",
      kind: "suffix",
      crossProduct: true,
      replacements: [
        { remove: "e", add: "ing", condition: "e", continuation: null },
        { remove: "", add: "ing", condition: "[^e]", continuation: null },
      ],
    });
  });

  it("records a prefix as a prefix", () => {
    const { affixes } = parseAff("PFX A Y 1\nPFX A 0 re .\n");
    assert.equal(affixes.get("A").kind, "prefix");
  });

  it("reads cross_product off the block header", () => {
    const { affixes } = parseAff("SFX V N 1\nSFX V 0 ive .\n");
    assert.equal(affixes.get("V").crossProduct, false);
  });

  it("separates continuation flags from the suffix itself", () => {
    const { affixes } = parseAff("SFX S Y 1\nSFX S 0 s/X .\n");
    const [rule] = affixes.get("S").replacements;
    assert.deepEqual({ add: rule.add, continuation: rule.continuation }, { add: "s", continuation: "X" });
  });

  it("warns when a block declares a rule count it does not deliver", () => {
    const { warnings } = parseAff("SFX G Y 5\nSFX G 0 ing .\n");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /declared 5 rules but 1 followed/);
  });

  it("notes an unsupported FLAG mode instead of guessing", () => {
    const { flagMode, warnings } = parseAff("FLAG UTF-8\nSFX G Y 1\nSFX G 0 ing .\n");
    assert.equal(flagMode, "single");
    assert.match(warnings[0], /unsupported FLAG mode/);
  });

  it("honours FLAG long", () => {
    assert.equal(parseAff("FLAG long\n").flagMode, "long");
  });

  it("classifies excluding directives by the reason they exclude", () => {
    const { excluding } = parseAff("ONLYINCOMPOUND c\nFORBIDDENWORD X\nNEEDAFFIX z\n");
    assert.deepEqual([...excluding.keys()], ["c", "X", "z"]);
    assert.match(excluding.get("c"), /only valid inside a compound/);
    assert.match(excluding.get("X"), /forbidden/);
  });

  it("keeps non-affix flags whose words are still words", () => {
    const { kept } = parseAff("NOSUGGEST !\nKEEPCASE q\nCOMPOUNDRULE 2\nCOMPOUNDRULE n*1t\n");
    assert.deepEqual([...kept].sort(), ["!", "1", "n", "q", "t"]);
  });

  it("counts the directives it ignores rather than dropping them silently", () => {
    const { ignored } = parseAff("REP a ei\nREP ei a\nTRY esia\n");
    assert.deepEqual([...ignored], [["REP", 2], ["TRY", 1]]);
  });
});

describe("deriveFlagMap against Harper's own table", () => {
  it("matches a rule set to the Harper flag with identical replacements", () => {
    // hunspell M is `0 's .`; Harper spells the same rule `g`.
    const { map, remapped } = deriveFlagMap(parseAff("SFX M Y 1\nSFX M 0 's .\n"));
    assert.equal(map.get("M"), "g");
    assert.deepEqual(remapped, [{ from: "M", to: "g", kind: "suffix", label: "-'s" }]);
  });

  it("ignores replacement order when matching", () => {
    // Same four rules as Harper's `d`, listed in a different order.
    const shuffled = "SFX D Y 4\nSFX D 0 ed [^ey]\nSFX D 0 d e\nSFX D 0 ed [aeiou]y\nSFX D y ied [^aeiou]y\n";
    assert.equal(deriveFlagMap(parseAff(shuffled)).map.get("D"), "d");
  });

  it("reports a rule with no Harper equivalent as unmapped, with a label", () => {
    const { map, unmapped } = deriveFlagMap(parseAff("PFX C Y 1\nPFX C 0 de .\n"));
    assert.equal(map.size, 0);
    assert.deepEqual(unmapped, [{ flag: "C", kind: "prefix", label: "de-" }]);
  });

  it("does not match a suffix to a prefix with the same letters", () => {
    // Harper's `r` is the prefix `re-`. A suffix `-re` is a different rule.
    assert.equal(deriveFlagMap(parseAff("SFX A Y 1\nSFX A 0 re .\n")).map.size, 0);
  });

  it("flags a cross_product mismatch rather than hiding it", () => {
    // Harper's `^` (-est) is cross_product: false. Claiming true would generate
    // combinations Harper's own table does not.
    const { crossProductDiffers } = deriveFlagMap(parseAff(
      "SFX T Y 4\nSFX T 0 st e\nSFX T y iest [^aeiou]y\nSFX T 0 est [aeiou]y\nSFX T 0 est [^ey]\n",
    ));
    assert.deepEqual(crossProductDiffers, [{ from: "T", to: "^" }]);
  });
});

describe("dictionary-en 4.0.0 as a fixture", () => {
  let aff;
  let dic;

  before(async () => {
    aff = await readFile(new URL("index.aff", EN), "utf8");
    dic = await readFile(new URL("index.dic", EN), "utf8");
  });

  it("parses all 23 affix flags with no warnings", () => {
    const parsed = parseAff(aff);
    assert.equal(parsed.affixes.size, 23);
    assert.equal(parsed.flagMode, "single");
    assert.deepEqual(parsed.warnings, []);
  });

  it("derives the 7 / 10 / 6 split", () => {
    // The headline claim: 17 of 23 hunspell flags are the same rule as a Harper
    // flag, so a hunspell dictionary needs classifying, not an affix engine.
    const { identical, remapped, unmapped } = deriveFlagMap(parseAff(aff));
    assert.equal(identical.length, 7);
    assert.equal(remapped.length, 10);
    assert.equal(unmapped.length, 6);
  });

  it("derives exactly the mapping that was measured by hand", () => {
    // The table is asserted, never hardcoded — src/core/affix.js derives it from
    // the two rule sets. Hardcoding would be a guess about one dictionary that
    // silently mistranslates the next.
    const { identical, remapped, unmapped } = deriveFlagMap(parseAff(aff));
    assert.deepEqual(identical.map((m) => m.from).sort(), ["B", "G", "L", "S", "U", "X", "Y"]);
    assert.deepEqual(
      remapped.map((m) => `${m.from}->${m.to}`).sort(),
      ["A->r", "D->d", "I->i", "J->z", "M->g", "N->n", "P->p", "R->>", "T->^", "V->v"],
    );
    assert.deepEqual(
      unmapped.map(({ flag, label }) => [flag, label]).sort(),
      [["C", "de-"], ["E", "dis-"], ["F", "con-"], ["H", "-ieth"], ["K", "pro-"], ["Z", "-iers"]],
    );
  });

  it("finds no cross_product mismatch", () => {
    assert.deepEqual(deriveFlagMap(parseAff(aff)).crossProductDiffers, []);
  });

  it("translates the whole dictionary and accounts for every entry", () => {
    const source = parseHunspellSource({ dic, aff });
    const lines = dic.split("\n").slice(1).filter(Boolean).length;
    assert.equal(lines, 49568);
    assert.equal(source.entries.length + source.excluded.length, lines);
    assert.deepEqual(source.warnings, []);
  });

  it("excludes the compound-only fragments and nothing else", () => {
    // `1th`, `2th` and `3th` exist so `11th` and `123th` can be assembled. They
    // are not words, and importing them would be a silent quality loss.
    const { excluded } = parseHunspellSource({ dic, aff });
    assert.deepEqual(excluded.map((e) => e.word), ["1th", "2th", "3th"]);
  });

  it("counts every D3 flag loss per flag", () => {
    // D3: keep the word, drop the flag, report the count. These six flags are
    // the ones Harper has no equivalent for, and 1,982 entries carry one.
    const { dropped } = parseHunspellSource({ dic, aff });
    assert.deepEqual(Object.fromEntries([...dropped].sort()), {
      C: 207, E: 207, F: 76, H: 63, K: 52, Z: 1377,
    });
  });

  it("separates non-affix flags from D3 losses", () => {
    // `!` is NOSUGGEST and the rest are COMPOUNDRULE flags. Reporting them as
    // dropped affixes would overstate the loss by an order of magnitude.
    const { nonAffix, undeclared } = parseHunspellSource({ dic, aff });
    assert.deepEqual([...nonAffix.keys()].sort(), ["!", "1", "m", "n", "p", "t"]);
    assert.deepEqual([...undeclared.keys()], []);
  });

  it("translates flags rather than passing them through", () => {
    const { entries } = parseHunspellSource({ dic, aff });
    const byWord = new Map(entries.map((e) => [e.word, e]));
    // `M` is hunspell's possessive; Harper spells it `g`. `MS` becomes `gS`.
    assert.deepEqual(
      { flags: byWord.get("Ahmed").flags, sourceFlags: byWord.get("Ahmed").sourceFlags },
      { flags: "g", sourceFlags: "M" },
    );
    // NOSUGGEST is dropped, the affix flags survive, the word stays.
    assert.equal(byWord.get("bullshit").flags, "gS");
  });

  it("keeps source flags verbatim when no .aff is supplied, and says so", () => {
    const source = parseHunspellSource({ dic });
    assert.equal(source.flagMap, null);
    assert.match(source.warnings[0], /no \.aff supplied/);
    const byWord = new Map(source.entries.map((e) => [e.word, e]));
    assert.equal(byWord.get("Ahmed").flags, "M"); // untranslated
  });
});

describe("translateFlags", () => {
  const aff = parseAff([
    "NOSUGGEST !",
    "ONLYINCOMPOUND c",
    "PFX C Y 1", "PFX C 0 de .", // no Harper equivalent
    "SFX M Y 1", "SFX M 0 's .", // -> g
    "SFX S Y 4",
    "SFX S y ies [^aeiou]y", "SFX S 0 s [aeiou]y", "SFX S 0 es [sxzh]", "SFX S 0 s [^sxzhy]",
  ].join("\n"));

  const options = {
    map: deriveFlagMap(aff).map,
    flagMode: aff.flagMode,
    excluding: aff.excluding,
    kept: aff.kept,
    declared: new Set([...aff.affixes.keys(), ...aff.excluding.keys(), ...aff.kept]),
  };
  const translate = (flags) => translateFlags(flags, options);

  it("translates mapped flags and drops unmapped ones", () => {
    const result = translate("MSC");
    assert.equal(result.flags, "gS");
    assert.deepEqual(result.dropped, ["C"]);
  });

  it("reports the word as excluded when a flag says it is not a word", () => {
    assert.match(translate("Mc").excluded, /only valid inside a compound/);
  });

  it("keeps a word carrying a non-affix flag", () => {
    const result = translate("S!");
    assert.deepEqual(
      { flags: result.flags, nonAffix: result.nonAffix, excluded: result.excluded },
      { flags: "S", nonAffix: ["!"], excluded: null },
    );
  });

  it("separates a flag the .aff never declared from a D3 loss", () => {
    const result = translate("SQ");
    assert.deepEqual(
      { dropped: result.dropped, undeclared: result.undeclared },
      { dropped: [], undeclared: ["Q"] },
    );
  });

  it("returns null flags rather than an empty string", () => {
    assert.equal(translate("C").flags, null);
    assert.equal(translate(null).flags, null);
  });
});
