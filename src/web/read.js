// The browser's I/O edge.
//
// Files are read here and text goes into core, exactly as src/cli.js does with
// `node:fs` and `node:zlib`. Nothing is uploaded: the user's dictionary is read
// by their own browser, and there is no server to send it to.
//
// gzip lives at this edge on purpose. `DecompressionStream` is a browser API and
// `zlib` is a Node one; core sees decompressed text either way and stays
// portable between them.
import { pairSourceFiles, parseAuto, parseHunspellSource } from "../core/index.js";

/**
 * Read a `File` as text, transparently decompressing gzip.
 *
 * Detected by magic bytes rather than by extension, because dictionary downloads
 * are routinely renamed on the way to a hard disk.
 */
export async function readTextFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!gzipped) return new TextDecoder().decode(bytes);

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/**
 * Turn dropped files into merge-ready sources.
 *
 * A `.dic` is paired with the `.aff` of the same stem if the user supplied one,
 * which is what makes its flags translatable into Harper's. Without it the flags
 * are dropped rather than carried through, because a flag letter only means
 * something in the file that defines it.
 *
 * @param files  `File` objects, in the order the user picked them
 * @returns `[{ name, entries, notes, flagMap, dropped, excluded }]`
 */
export async function loadSources(files) {
  const byName = new Map(files.map((file) => [file.name, file]));
  const sources = [];

  for (const { name, kind, aff } of pairSourceFiles([...byName.keys()])) {
    const text = await readTextFile(byName.get(name));

    if (kind !== "dic") {
      // A plain list, or weirsmith's own word/FLAGS format — parseAuto tells them
      // apart by content, so `probe --out` output can be fed straight back in.
      sources.push({ name, entries: parseAuto(text, name), notes: [], excluded: [] });
      continue;
    }

    const affText = aff ? await readTextFile(byName.get(aff)) : null;
    const parsed = parseHunspellSource({ dic: text, aff: affText });
    const notes = [];

    if (parsed.flagsTranslated) {
      const { identical, remapped, unmapped } = parsed.flagMap;
      const matched = identical.length + remapped.length;
      notes.push(`paired with ${aff}: ${matched} of ${matched + unmapped.length} flags map onto Harper's`);
      const lost = unmapped.filter(({ flag }) => parsed.dropped.get(flag));
      if (lost.length) {
        notes.push(
          "no Harper equivalent, flag dropped on: "
          + lost.map(({ flag, label }) => `${flag} (${label}) ×${parsed.dropped.get(flag)}`).join(", "),
        );
      }
    } else {
      notes.push("no .aff supplied — flags ignored, since a flag letter only means"
        + " something in the file that defines it");
    }

    for (const warning of parsed.warnings) notes.push(warning);

    sources.push({
      name,
      entries: parsed.flagsTranslated
        ? parsed.entries
        : parsed.entries.map(({ word }) => ({ word, flags: null })),
      notes,
      excluded: parsed.excluded,
    });
  }

  return sources;
}

/** Offer bytes to the user as a download. */
export function download(filename, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
