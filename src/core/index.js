// weirsmith core.
//
// Everything exported here is browser-safe — it takes and returns strings,
// objects and byte arrays, and never touches a file system. The CLI wraps it
// with Node I/O; a web UI can import exactly the same functions.
export {
  parseWordList, parseHunspellDic, parseAuto, sanitize, JUNK_RULES, findJunkRule,
  pairSourceFiles, withoutGz, detectListFormat, parseFlaggedList,
} from "./wordlist.js";
export { guessFlags, RULES } from "./guess.js";
export {
  probeWords, probeDialects, verifyPack, SPELLING, ALL_DIALECTS,
} from "./probe.js";
export {
  buildPack,
  buildAnnotations,
  collectFlags,
  renderDictionary,
  validateManifest,
  REQUIRED_MANIFEST_FIELDS,
} from "./pack.js";
export { HARPER_FLAGS } from "./harper-flags.js";
export {
  EXPORT_FORMATS,
  HUNSPELL_FLAG_ALIASES,
  conditionRegex,
  expandEntries,
  expandEntry,
  formsForFlag,
  renderAff,
  renderHunspellDic,
  toCspell,
  toHunspell,
  toWordList,
} from "./export.js";
export { parseSource, renderSource } from "./source.js";
export { mergeSources, canonicalFlags, caseGroups, caseTwins } from "./merge.js";
export {
  parseAff,
  deriveFlagMap,
  translateFlags,
  parseHunspellSource,
  splitFlags,
  joinFlags,
  FLAG_MODES,
} from "./affix.js";
