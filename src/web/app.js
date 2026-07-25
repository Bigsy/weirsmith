// The weirsmith UI.
//
// Plain DOM, no framework, no build step. All the real work is in src/core,
// which is browser-safe and shared with the CLI; this file is presentation and
// the browser's I/O edge.
//
// The one opinion the layout enforces: **the probe result comes before the
// download button.** Merging dictionaries and emitting a pack is the easy half
// and also the dangerous half — a pack full of words Harper already knew makes
// Harper worse at the typos it used to catch. So the numbers that tell you
// whether to bother are the loudest thing on the page, and the pack size stays
// visible from the moment there is one.
import {
  ALL_DIALECTS, buildPack, canonicalFlags, caseTwins, guessFlags, mergeSources, probeDialects,
  renderDictionary, sanitize, validateManifest, verifyPack,
} from "../core/index.js";
import { download, loadSources } from "./read.js";
import { createLinter, reusableLinter } from "./linter.js";

const state = {
  sources: [],
  merged: null,
  accepted: [],
  rejected: [],
  /** word -> the flags its source supplied, if any. Built once; a scan per
   *  rendered row would be quadratic against a 50,000-entry dictionary. */
  sourceFlags: new Map(),
  probe: null,
  /** word -> flags, once the user has overridden the guess */
  overrides: new Map(),
  /** rule name -> flags, a whole group corrected at once */
  groupFlags: new Map(),
  pack: null,
};

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [children].flat()) {
    if (child != null) node.append(child);
  }
  return node;
};
const plural = (n, word) => {
  if (n === 1) return `1 ${word}`;
  const many = word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`;
  return `${n.toLocaleString()} ${many}`;
};

/**
 * The flag sets worth offering as one click.
 *
 * Deliberately short. The full Rune vocabulary is in src/core/harper-flags.js and
 * anything can be typed by hand, but a list of thirty flag combinations is not a
 * tagging tool, it is a spreadsheet.
 */
const PRESETS = [
  ["~NgS", "countable noun — kubelet, kubelets, kubelet's"],
  ["~Nmg", "mass noun, no plural — kubectl, telehealth"],
  ["Og", "proper noun — Istio, SystmOne"],
  ["OgS", "proper noun that pluralises — SLO, ICB"],
  ["~VGdS", "verb — deprescribe, deprescribes, deprescribed"],
  ["~J", "adjective — nosocomial"],
  ["~N", "already plural — sequelae"],
  ["~R", "adverb"],
];

// ---------------------------------------------------------------- step 1

function wireFileInput() {
  const zone = $("dropzone");
  const picker = $("picker");

  zone.addEventListener("click", () => picker.click());
  zone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      picker.click();
    }
  });
  picker.addEventListener("change", () => accept([...picker.files]));

  for (const type of ["dragenter", "dragover"]) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add("over");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    zone.addEventListener(type, () => zone.classList.remove("over"));
  }
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    accept([...event.dataTransfer.files]);
  });
}

async function accept(files) {
  if (!files.length) return;

  try {
    state.sources = await loadSources(files);
  } catch (error) {
    $("sources").replaceChildren(el("p", { className: "error", textContent: `${error.message}` }));
    return;
  }

  state.merged = mergeSources(state.sources);
  ({ accepted: state.accepted, rejected: state.rejected } = sanitize(state.merged.entries));
  state.sourceFlags = new Map(
    state.accepted.filter((entry) => entry.flags).map((entry) => [entry.word, entry.flags]),
  );
  state.probe = null;
  state.overrides.clear();
  state.groupFlags.clear();
  state.pack = null;

  renderSources();
  $("step-probe").hidden = false;
  $("step-tag").hidden = true;
  $("step-build").hidden = true;
  $("probe-result").replaceChildren();
  $("pack-size").hidden = true;
  $("step-probe").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderSources() {
  const nodes = state.sources.map((source) => el("div", { className: "card" }, [
    el("h3", { textContent: source.name }),
    el("p", { className: "count", textContent: plural(source.entries.length, "entry") }),
    ...source.notes.map((note) => el("p", { className: "note", textContent: note })),
    source.excluded?.length
      ? el("p", {
        className: "note",
        textContent: `${plural(source.excluded.length, "entry")} skipped: `
          + `${source.excluded[0].reason}`,
      })
      : null,
  ]));

  // What each source added that no earlier one had. Often the honest answer is
  // that a source was not worth including, and that should be visible before
  // any effort goes into tagging its words.
  if (state.sources.length > 1) {
    nodes.push(el("table", { className: "contribution" }, [
      el("caption", { textContent: "What each source added that no earlier one had" }),
      el("thead", {}, el("tr", {}, [
        el("th", { textContent: "Source" }),
        el("th", { textContent: "Entries" }),
        el("th", { textContent: "New" }),
        el("th", { textContent: "Already covered" }),
      ])),
      el("tbody", {}, state.merged.contribution.map(({ name, total, added, duplicates }) => el(
        "tr",
        {},
        [
          el("td", { textContent: name }),
          el("td", { className: "num", textContent: total.toLocaleString() }),
          el("td", { className: "num", textContent: added.toLocaleString() }),
          el("td", { className: "num", textContent: duplicates.toLocaleString() }),
        ],
      ))),
    ]));
  }

  if (state.merged.conflicts.length) nodes.push(renderConflicts());

  if (state.merged.collisions.length) {
    // A count and one example rather than a list. Whether a collision costs a
    // word depends on casing and flags in a way not worth predicting — a
    // lowercase common noun already covers its ALL-CAPS rendering, so most are
    // harmless. The verify step at the end measures which are not.
    const [example] = state.merged.collisions;
    nodes.push(el("p", { className: "note" }, [
      `Case collisions: ${state.merged.collisions.length.toLocaleString()}`,
      ` (${example.shadowed.join(", ")} / ${example.winner}). `,
      "Harper keeps the last of each; the check after building reports any that cost a word.",
    ]));
  }

  if (state.rejected.length) nodes.push(renderRejections());

  $("sources").replaceChildren(...nodes);
}

/** Property-flag disagreements. Reported, never silently resolved. */
function renderConflicts() {
  const { conflicts } = state.merged;
  const hard = conflicts.filter((conflict) => conflict.hard).length;

  return el("details", { className: "card warn", open: hard > 0 }, [
    el("summary", {
      textContent: `${plural(conflicts.length, "word")} tagged differently by two sources`
        + `${hard ? ` — ${hard} contradictory` : ""}`,
    }),
    el("p", {
      className: "note",
      textContent: "The first source wins. Unioning these would claim a word is two"
        + " parts of speech at once, and a wrong tag degrades Harper's grammar rules"
        + " quietly — so they are listed instead.",
    }),
    el("table", {}, el("tbody", {}, conflicts.slice(0, 50).map((conflict) => el("tr", {}, [
      el("td", { textContent: conflict.word }),
      el("td", { textContent: `${conflict.sources[0].name}: ${conflict.sources[0].flags}` }),
      el("td", { textContent: `${conflict.sources[1].name}: ${conflict.sources[1].flags}` }),
      el("td", {
        className: conflict.hard ? "hard" : "",
        textContent: conflict.hard ? "contradictory" : "",
      }),
    ])))),
  ]);
}

/** Entries that can never work, grouped by why. */
function renderRejections() {
  const byReason = new Map();
  for (const { reason, word } of state.rejected) {
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push(word);
  }

  return el("details", { className: "card" }, [
    el("summary", { textContent: `${plural(state.rejected.length, "entry")} skipped` }),
    el("ul", {}, [...byReason].sort((a, b) => b[1].length - a[1].length).map(([reason, words]) => el(
      "li",
      {},
      [
        el("strong", { textContent: `${words.length.toLocaleString()} ` }),
        `${reason} — `,
        el("code", { textContent: words.slice(0, 6).join(" ") }),
      ],
    ))),
  ]);
}

// ---------------------------------------------------------------- step 2

async function probe() {
  const words = state.accepted.map((entry) => entry.word);
  if (!words.length) return;

  const button = $("probe");
  button.disabled = true;
  $("progress").hidden = false;
  $("probe-result").replaceChildren();

  // One worker, five dialects. Five workers would each compile the 18 MB binary
  // again — measured at 2.4s against 0.55s — so the linter is reused and this
  // code owns disposing it.
  const reusable = reusableLinter();
  const total = words.length * ALL_DIALECTS.length;
  let previous = 0;
  let dialectIndex = 0;

  try {
    state.probe = await probeDialects(reusable.makeLinter, words, {
      disposeLinters: false,
      onProgress: ({ done, dialect }) => {
        if (done < previous) dialectIndex += 1; // a new dialect restarted the count
        previous = done;
        const overall = dialectIndex * words.length + done;
        $("bar-fill").style.width = `${Math.round((overall / total) * 100)}%`;
        $("progress-label").textContent = `probing ${dialect} — ${done.toLocaleString()}`
          + ` of ${words.length.toLocaleString()}`;
      },
    });
  } catch (error) {
    $("probe-result").replaceChildren(el("p", { className: "error", textContent: `${error}` }));
    return;
  } finally {
    await reusable.dispose();
    $("progress").hidden = true;
    button.disabled = false;
  }

  renderProbe();
  renderTagging();
  $("step-tag").hidden = state.probe.missing.length === 0;
  $("step-build").hidden = state.probe.missing.length === 0;
  updatePackSize();
}

function renderProbe() {
  const { missing, dialectVariants, known } = state.probe;
  const total = missing.length + dialectVariants.length + known.length;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);

  const nodes = [el("div", { className: "split" }, [
    el("div", { className: "figure headline" }, [
      el("strong", { textContent: missing.length.toLocaleString() }),
      el("span", { textContent: "missing from every dialect" }),
      el("small", { textContent: `${pct(missing.length)}% — the only words worth adding` }),
    ]),
    el("div", { className: "figure" }, [
      el("strong", { textContent: known.length.toLocaleString() }),
      el("span", { textContent: "Harper already knows" }),
      el("small", { textContent: `${pct(known.length)}% — adding these would cost precision` }),
    ]),
    el("div", { className: "figure" }, [
      el("strong", { textContent: dialectVariants.length.toLocaleString() }),
      el("span", { textContent: "dialect variants" }),
      el("small", { textContent: `${pct(dialectVariants.length)}% — do not add` }),
    ]),
  ])];

  if (!missing.length) {
    nodes.push(el("p", { className: "verdict good" }, [
      el("strong", { textContent: "Harper already knows all of it. " }),
      "There is nothing here worth converting, which is the most useful thing this"
      + " tool can tell you.",
    ]));
  }

  if (dialectVariants.length) {
    // The trap: these look exactly like gaps when you probe one dialect, and
    // adding them does nothing at all.
    nodes.push(el("details", { className: "card warn" }, [
      el("summary", {
        textContent: `${plural(dialectVariants.length, "word")} Harper knows but flags`
          + " in some dialects — do NOT add these",
      }),
      el("p", {
        className: "note",
        textContent: "Harper is right about these: it knows them and is flagging them as the"
          + " wrong dialect. Its dialect check never consults pack dictionaries, so adding one"
          + " changes nothing and the pack carries a dead entry. Set Harper's dialect instead.",
      }),
      el("table", {}, el("tbody", {}, dialectVariants.slice(0, 50).map(({ word, flaggedIn }) => el(
        "tr",
        {},
        [
          el("td", { textContent: word }),
          el("td", { className: "note", textContent: `flagged in ${flaggedIn.join(", ")}` }),
        ],
      )))),
    ]));
  }

  $("probe-result").replaceChildren(...nodes);
}

// ---------------------------------------------------------------- step 3

/** The flags in force for a word: explicit override, then group, then guess. */
function flagsFor(word) {
  if (state.overrides.has(word)) return state.overrides.get(word);
  const { flags, rule } = guessFlags(word);
  return state.groupFlags.get(rule) ?? flags;
}


function renderTagging() {
  const groups = new Map();
  for (const word of state.probe.missing) {
    const { rule, why, flags } = guessFlags(word);
    if (!groups.has(rule)) groups.set(rule, { rule, why, guessed: flags, words: [] });
    groups.get(rule).words.push(word);
  }

  const nodes = [...groups.values()]
    .sort((a, b) => b.words.length - a.words.length)
    .map(renderGroup);

  $("tagging").replaceChildren(...nodes);
}

function renderGroup(group) {
  const current = state.groupFlags.get(group.rule) ?? group.guessed;

  const select = el("select", { title: "Apply to every word in this group" });
  for (const [flags, label] of PRESETS) {
    select.append(el("option", { value: flags, textContent: `${flags} — ${label}`, selected: flags === current }));
  }
  select.addEventListener("change", () => {
    state.groupFlags.set(group.rule, select.value);
    // Group changes are a bulk correction, so per-word overrides inside this
    // group are cleared — otherwise the group control would silently do nothing
    // to the words you had already touched.
    for (const word of group.words) state.overrides.delete(word);
    renderTagging();
    updatePackSize();
  });

  const shown = group.words.slice(0, 40);
  return el("details", { className: "card group", open: group.words.length <= 40 }, [
    el("summary", {}, [
      el("strong", { textContent: plural(group.words.length, "word") }),
      el("span", { className: "rule", textContent: ` ${group.rule} — ${group.why}` }),
    ]),
    el("div", { className: "bulk" }, [el("label", {}, ["Apply to all: ", select])]),
    el("ul", { className: "words" }, shown.map((word) => renderWord(word))),
    group.words.length > shown.length
      ? el("p", {
        className: "hint",
        textContent: `Showing ${shown.length} of ${group.words.length}. The rest take the`
          + " group's flags; build and edit words.txt if you need per-word control over"
          + " thousands of entries.",
      })
      : null,
  ]);
}

function renderWord(word) {
  const value = flagsFor(word);
  // A hunspell source knows its own affixes but carries no part of speech, so the
  // guess is the default even here — Harper's grammar rules need the part of
  // speech, and a word imported with none is a quiet quality tax. The source's
  // flags are shown so an informed choice is one click away.
  const fromSource = state.sourceFlags.get(word);

  const input = el("input", {
    value,
    size: 8,
    className: state.overrides.has(word) ? "edited" : "",
    "aria-label": `flags for ${word}`,
  });
  input.addEventListener("change", () => {
    state.overrides.set(word, input.value.trim());
    renderTagging();
    updatePackSize();
  });

  // Compared as sets, not as strings: a merged entry's flags come back in
  // canonical order (`~NSg`) while the shape guess writes them the way a human
  // would (`~NgS`). Comparing text would offer to "adopt" the identical thing.
  const differs = fromSource && canonicalFlags([...fromSource]) !== canonicalFlags([...value]);

  let adopt = null;
  if (differs) {
    adopt = el("button", {
      className: "adopt",
      type: "button",
      textContent: `source said ${fromSource}`,
      title: "Use the flags this word's dictionary supplied, translated into Harper's",
    });
    adopt.addEventListener("click", () => {
      state.overrides.set(word, fromSource);
      renderTagging();
      updatePackSize();
    });
  }

  return el("li", {}, [
    el("code", { className: "word", textContent: word, title: word }),
    input,
    adopt,
  ]);
}

// ---------------------------------------------------------------- step 4

/** The entries the pack would contain, in merge order. */
function packEntries() {
  return state.probe.missing.map((word) => ({ word, flags: flagsFor(word) }));
}

function updatePackSize() {
  if (!state.probe?.missing.length) {
    $("pack-size").hidden = true;
    return;
  }
  const entries = packEntries();
  const bytes = new TextEncoder().encode(renderDictionary(entries)).length;
  const size = bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KiB`;
  const pill = $("pack-size");
  pill.hidden = false;
  pill.textContent = `${plural(entries.length, "word")} · ${size} of dictionary`;
}

async function build() {
  const form = new FormData($("manifest"));
  const manifest = Object.fromEntries([...form].map(([key, value]) => [key, `${value}`.trim()]));

  const problems = validateManifest(manifest);
  if (problems.length) {
    $("build-result").replaceChildren(el("ul", { className: "error" },
      problems.map((problem) => el("li", { textContent: problem }))));
    return;
  }

  const entries = packEntries();
  let pack;
  try {
    pack = buildPack({ manifest, entries });
  } catch (error) {
    // Almost always a hand-typed flag Harper has no definition for.
    $("build-result").replaceChildren(el("p", { className: "error", textContent: `${error.message}` }));
    return;
  }

  state.pack = pack;
  const name = `${(manifest.description.split(/\s+/)[0] || "weirsmith").toLowerCase()
    .replace(/[^a-z0-9]/g, "")}.weirpack`;

  const verified = await verify(pack, entries.map((entry) => entry.word));
  renderBuildResult(pack, entries, verified, name);
  download(name, pack.bytes);
}

/**
 * Load the pack we just built back into a real Harper and re-probe its words.
 *
 * The CLI has always done this, and until now the UI did not — it handed over a
 * download and asserted a word count. That count is the one number in the tool
 * that was not measured, and it can be wrong: Harper keeps one entry per word
 * regardless of case, so a pack containing both `BUILDKIT` and `BuildKit` imports
 * cleanly and silently adds only one of them. Merging six cspell dictionaries
 * produced 19 such words out of 3,908.
 *
 * A throwaway linter, because loading a pack mutates it.
 */
async function verify(pack, words) {
  const status = el("p", { className: "hint", textContent: "verifying against Harper…" });
  $("build-result").replaceChildren(status);
  $("build").disabled = true;

  const linter = await createLinter();
  try {
    return await verifyPack(linter, pack.bytes, words, {
      onProgress: ({ done, total }) => {
        status.textContent = `verifying against Harper — ${done.toLocaleString()}`
          + ` of ${total.toLocaleString()}`;
      },
    });
  } catch (error) {
    return { ok: false, stillFlagged: [], error };
  } finally {
    await linter.dispose();
    $("build").disabled = false;
  }
}

function renderBuildResult(pack, entries, verified, name) {
  const size = `${(pack.bytes.length / 1024).toFixed(1)} KiB`;
  const affixes = Object.keys(JSON.parse(pack.files.get("annotations.json")).affixes).length;
  const nodes = [];

  if (verified.error) {
    nodes.push(el("p", { className: "error", textContent: `could not verify: ${verified.error}` }));
  } else if (verified.testFailures) {
    nodes.push(el("p", { className: "error" }, [
      el("strong", { textContent: "rule tests failed, so Harper imported nothing. " }),
      "Every test in a pack's .weir rules runs before anything is imported.",
    ]));
  } else if (verified.ok) {
    nodes.push(el("p", { className: "verdict good" }, [
      el("strong", { textContent: `${plural(entries.length, "word")} verified. ` }),
      `${size}, ${plural(affixes, "affix flag")} declared. `,
      "Every word was loaded into a real Harper and now lints clean.",
    ]));
  } else {
    // The honest version of the headline number.
    const took = entries.length - verified.stillFlagged.length;
    const twins = caseTwins(entries.map((entry) => entry.word));
    nodes.push(el("p", { className: "verdict warn" }, [
      el("strong", { textContent: `${plural(took, "word")} verified, ${verified.stillFlagged.length} did not take. ` }),
      `${size}, ${plural(affixes, "affix flag")} declared.`,
    ]));
    nodes.push(el("details", { className: "card warn", open: true }, [
      el("summary", { textContent: `${plural(verified.stillFlagged.length, "word")} Harper still flags after loading the pack` }),
      el("p", {
        className: "note",
        textContent: "Harper keeps one entry per word regardless of case, so two"
          + " spellings that differ only in case become one — the later of them."
          + " Remove whichever you do not want and build again.",
      }),
      el("ul", {}, verified.stillFlagged.slice(0, 60).map((word) => el("li", {}, [
        el("code", { textContent: word }),
        twins.get(word)
          ? el("small", { className: "note", textContent: ` also in this pack as ${twins.get(word).join(", ")}` })
          : null,
      ]))),
    ]));
  }

  nodes.push(el("p", { className: "hint" }, [
    `Downloaded as ${name}. Re-check it any time with `,
    el("code", { textContent: `weirsmith verify ${name}` }),
  ]));

  $("build-result").replaceChildren(...nodes);
}

// ---------------------------------------------------------------- start

wireFileInput();
$("probe").addEventListener("click", probe);
$("build").addEventListener("click", build);
$("manifest").addEventListener("submit", (event) => event.preventDefault());
