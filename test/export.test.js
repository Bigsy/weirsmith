// Unit tests for the non-Weirpack exporters. Pure — no Harper, no WASM.
//
// The expansion these assert is checked against a real Harper in
// test/packs.test.js: this file pins the strings, that file pins the fact that
// Harper agrees they are the forms it generates.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HUNSPELL_FLAG_ALIASES, conditionRegex, expandEntries, expandEntry, formsForFlag,
  parseHunspellSource, parseSource, renderAff, renderHunspellDic, toCspell, toHunspell,
  toWordList,
} from "../src/core/index.js";

describe("conditionRegex", () => {
  it("anchors a suffix condition at the end and a prefix at the start", () => {
    assert.ok(conditionRegex("[^aeiou]y", "suffix").test("formulary"));
    assert.ok(!conditionRegex("[^aeiou]y", "suffix").test("holiday"));
    assert.ok(conditionRegex(".", "prefix").test("render"));
  });

  it("refuses a condition outside the format's alphabet", () => {
    // Anything else means Harper's annotations have changed shape, and guessing
    // would silently mistranslate every word using that flag.
    assert.throws(() => conditionRegex("(a|b)", "suffix"), /unsupported affix condition/);
  });
});

describe("formsForFlag", () => {
  it("picks the branch the word's ending selects", () => {
    assert.deepEqual(formsForFlag("kubelet", "S"), ["kubelets"]);
    assert.deepEqual(formsForFlag("formulary", "S"), ["formularies"]);
    assert.deepEqual(formsForFlag("box", "S"), ["boxes"]);
    assert.deepEqual(formsForFlag("holiday", "S"), ["holidays"]);
  });

  it("treats conditions as case-sensitive, as hunspell does", () => {
    // QALY ends in an uppercase Y, which is not in [sxzhy], so it takes the
    // plain -s branch rather than y->ies. AGENTS.md calls this out; assert it.
    assert.deepEqual(formsForFlag("QALY", "S"), ["QALYs"]);
  });

  it("drops a trailing e before -ing", () => {
    assert.deepEqual(formsForFlag("deprescribe", "G"), ["deprescribing"]);
    assert.deepEqual(formsForFlag("rerender", "G"), ["rerendering"]);
  });

  it("generates possessives and prefixes", () => {
    assert.deepEqual(formsForFlag("SLO", "g"), ["SLO's"]);
    assert.deepEqual(formsForFlag("render", "r"), ["rerender"]);
  });

  it("returns nothing for a property flag or an unused affix", () => {
    assert.deepEqual(formsForFlag("kubelet", "~"), []);
    assert.deepEqual(formsForFlag("sequelae", "S"), ["sequelaes"]); // flagged only if S is set
  });

  it("never consumes the whole word", () => {
    assert.deepEqual(formsForFlag("y", "S"), []);
  });
});

describe("expandEntry", () => {
  it("puts the base form first, then follows the order the flags are written", () => {
    assert.deepEqual(expandEntry({ word: "kubelet", flags: "~NgS" }),
      ["kubelet", "kubelet's", "kubelets"]);
    assert.deepEqual(expandEntry({ word: "kubelet", flags: "~NSg" }),
      ["kubelet", "kubelets", "kubelet's"]);
  });

  it("expands a verb into all four forms", () => {
    assert.deepEqual(expandEntry({ word: "deprescribe", flags: "~VGdS" }),
      ["deprescribe", "deprescribing", "deprescribed", "deprescribes"]);
  });

  it("adds nothing for an entry with only property flags", () => {
    assert.deepEqual(expandEntry({ word: "kubectl", flags: "~Nm" }), ["kubectl"]);
    assert.deepEqual(expandEntry({ word: "nosocomial", flags: "~J" }), ["nosocomial"]);
  });

  it("handles a bare entry with no flags at all", () => {
    assert.deepEqual(expandEntry({ word: "etcd", flags: null }), ["etcd"]);
  });

  it("crosses a prefix with a suffix only when both allow it", () => {
    // r (re-) and d (-ed) both cross_product, so rerendered is generated.
    assert.ok(expandEntry({ word: "render", flags: "~VrdS" }).includes("rerendered"));
    // ^ (superlative) does not cross, so no un+est combination appears.
    const forms = expandEntry({ word: "big", flags: "~JU^" });
    assert.ok(forms.includes("unbig"));
    assert.ok(forms.includes("bigst") || forms.includes("bigest"));
    assert.ok(!forms.some((form) => form.startsWith("un") && form.endsWith("st")));
  });

  it("rejects a flag Harper does not define", () => {
    assert.throws(() => expandEntry({ word: "kubelet", flags: "~N%" }), /unknown Rune flag/);
  });
});

describe("expandEntries", () => {
  it("deduplicates across entries and counts what the flags added", () => {
    const entries = [
      { word: "kubelet", flags: "~NgS" },   // 3 forms
      { word: "kubelets", flags: null },     // already generated above
      { word: "Istio", flags: "Og" },        // 2 forms
    ];
    const { words, generated, byWord } = expandEntries(entries);
    assert.deepEqual(words, ["kubelet", "kubelet's", "kubelets", "Istio", "Istio's"]);
    assert.equal(generated, words.length - entries.length);
    assert.deepEqual(byWord.get("Istio"), ["Istio", "Istio's"]);
  });

  it("keeps case variants apart — which one wins is the target's business", () => {
    const { words } = expandEntries([{ word: "abs", flags: "~N" }, { word: "ABS", flags: "O" }]);
    assert.deepEqual(words, ["abs", "ABS"]);
  });
});

describe("renderAff", () => {
  it("transcribes a Harper flag into a hunspell SFX block", () => {
    const aff = renderAff("S");
    assert.match(aff, /^SET UTF-8$/m);
    assert.match(aff, /^SFX S Y 4$/m);
    assert.match(aff, /^SFX S y ies \[\^aeiou\]y$/m);
    assert.match(aff, /^SFX S 0 es \[sxzh\]$/m);
  });

  it("writes an empty strip or append field as 0", () => {
    assert.match(renderAff("g"), /^SFX g 0 's \.$/m);
  });

  it("marks a non-crossing affix N", () => {
    assert.match(renderAff("^"), /^SFX T N 4$/m);
  });

  it("renames the flags hunspell cannot name, and says so", () => {
    const aff = renderAff(">");
    assert.match(aff, /^SFX E Y 4$/m);
    assert.match(aff, /# Harper flag > is named E here/);
    assert.equal(HUNSPELL_FLAG_ALIASES[">"], "E");
  });

  it("emits PFX for a prefix", () => {
    assert.match(renderAff("U"), /^PFX U Y 1$/m);
  });

  it("defines only the flags the list uses, and ignores properties", () => {
    const aff = renderAff("~NgS");
    assert.match(aff, /^SFX g /m);
    assert.match(aff, /^SFX S /m);
    assert.ok(!/^SFX G /m.test(aff));
    assert.ok(!/[SP]FX [~N] /.test(aff));
  });
});

describe("renderHunspellDic", () => {
  it("keeps affix flags, drops properties, and counts the loss per flag", () => {
    const { dic, dropped } = renderHunspellDic([
      { word: "kubelet", flags: "~NgS" },
      { word: "kubectl", flags: "~Nmg" },
      { word: "Istio", flags: "Og" },
    ]);
    assert.equal(dic, "3\nkubelet/gS\nkubectl/g\nIstio/g\n");
    assert.deepEqual(dropped, [["~", 2], ["N", 2], ["m", 1], ["O", 1]]);
  });

  it("writes a bare word when nothing survives", () => {
    const { dic } = renderHunspellDic([{ word: "nosocomial", flags: "~J" }]);
    assert.equal(dic, "1\nnosocomial\n");
  });

  it("counts entries on the first line, hunspell's convention", () => {
    const { dic } = renderHunspellDic([{ word: "a", flags: null }, { word: "b", flags: null }]);
    assert.match(dic, /^2\n/);
  });
});

describe("toHunspell", () => {
  it("returns a matched pair and reports both kinds of loss", () => {
    const { dic, aff, notes } = toHunspell(parseSource("kubelet/~NgS\nbigger/~J>\n"), { name: "x" });
    assert.match(dic, /^kubelet\/gS$/m);
    assert.match(dic, /^bigger\/E$/m);   // > renamed
    assert.match(aff, /^SFX E Y 4$/m);   // and defined under the new name
    assert.equal(notes.length, 2);
    assert.match(notes[0], /property flags have no hunspell equivalent/);
    assert.match(notes[1], /affix flags renamed for hunspell: >→E/);
  });

  it("round-trips: the .aff we write is one weirsmith itself can read back", () => {
    // The strongest check available without installing hunspell. `affix.js`
    // derives what each hunspell flag means by matching rule sets against
    // Harper's — so feeding it our own output must recover the flags we started
    // from. If the transcription drifted, the derivation would report the flag
    // as unmapped or map it somewhere else, which is exactly the silent
    // mistranslation the project is most afraid of.
    const entries = parseSource("kubelet/~NgS\ndeprescribe/~VGdS\nbigger/~J>\nbest/~J^\nrender/~VrUdS\n");
    const { dic, aff } = toHunspell(entries);
    const { flagMap, entries: back } = parseHunspellSource({ dic, aff });

    assert.deepEqual(flagMap.unmapped, []);
    assert.deepEqual(flagMap.remapped.map(({ from, to }) => `${from}${to}`), ["E>", "T^"]);
    // Affix flags survive; property flags were dropped on the way out.
    assert.deepEqual(back.map(({ word, flags }) => `${word}/${flags ?? ""}`), [
      "kubelet/gS", "deprescribe/GdS", "bigger/>", "best/^", "render/rUdS",
    ]);
  });

  it("every flag the dic uses is defined by the aff", () => {
    const entries = parseSource("kubelet/~NgS\ndeprescribe/~VGdS\nrender/~VrUdS\nbest/~J^\n");
    const { dic, aff } = toHunspell(entries);
    const used = new Set(dic.split("\n").slice(1).filter(Boolean)
      .flatMap((line) => [...(line.split("/")[1] ?? "")]));
    const defined = new Set([...aff.matchAll(/^(?:SFX|PFX) (\S+) [YN] \d+$/gm)].map((m) => m[1]));
    assert.deepEqual([...used].filter((flag) => !defined.has(flag)), []);
  });
});

describe("toWordList", () => {
  it("expands by default so a flat target still gets the plurals", () => {
    const { text, words, generated } = toWordList(parseSource("kubelet/~NgS\nIstio/Og\n"));
    assert.deepEqual(words, ["kubelet", "kubelet's", "kubelets", "Istio", "Istio's"]);
    assert.equal(generated, 3);
    assert.equal(text, "kubelet\nkubelet's\nkubelets\nIstio\nIstio's\n");
  });

  it("can be asked for base spellings only", () => {
    const { text, generated } = toWordList(parseSource("kubelet/~NgS\n"), { expand: false });
    assert.equal(text, "kubelet\n");
    assert.equal(generated, 0);
  });

  it("reports its size, since some targets cap a custom dictionary", () => {
    const { bytes } = toWordList(parseSource("kubelet/~Nm\n"));
    assert.equal(bytes, "kubelet\n".length);
  });

  it("puts a header above the words when given one", () => {
    const { text } = toWordList(parseSource("kubelet/~Nm\n"), { header: "# hi" });
    assert.equal(text, "# hi\nkubelet\n");
  });
});

describe("toCspell", () => {
  it("emits a word list and the config that points at it", () => {
    const { text, config, words } = toCspell(parseSource("kubelet/~NgS\n"), {
      name: "mystack", description: "My stack",
    });
    assert.match(text, /^# My stack — generated by weirsmith$/m);
    assert.deepEqual(words, ["kubelet", "kubelet's", "kubelets"]);
    const parsed = JSON.parse(config);
    assert.deepEqual(parsed.dictionaries, ["mystack"]);
    assert.deepEqual(parsed.dictionaryDefinitions, [
      { name: "mystack", path: "./mystack.txt", description: "My stack" },
    ]);
  });
});
