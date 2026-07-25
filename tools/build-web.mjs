// Copy the web UI into a self-contained directory for static hosting.
//
// There is no bundler, so "building" means copying files and rewriting one
// import map. The dev server serves the repository root, where bare specifiers
// resolve through `/node_modules/...`; a deployed copy has no node_modules, so
// the map points at the files next to it instead.
//
// Output is `dist/web/`, which is gitignored. It works on any static host —
// Harper is single-threaded, so no COOP/COEP headers are needed.
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "dist/web");
const HARPER = join(ROOT, "node_modules/harper.js/dist");

/**
 * Only the slim binary is shipped.
 *
 * Asking harper.js for the full binary makes the browser fetch both — it
 * initialises the slim glue first and swallows the failure — so shipping full
 * would mean 36 MB of wasm in the directory and ~36 MB over the wire on a cold
 * load. Slim measured identically on everything weirsmith uses. `binary.js`
 * itself is still copied, because src/web/linter.js imports it statically; its
 * wasm is only fetched if someone asks for `?flavour=full`, which a deployed
 * copy cannot serve.
 */
const HARPER_FILES = [
  "index.js",
  "binary.js",
  "slimBinary.js",
  "harper_wasm_slim_bg.wasm",
];

const IMPORT_MAP = `<script type="importmap">
{
  "imports": {
    "harper.js": "./harper/index.js",
    "harper.js/binary": "./harper/binary.js",
    "harper.js/slimBinary": "./harper/slimBinary.js"
  }
}
</script>`;

await mkdir(join(OUT, "harper"), { recursive: true });
await mkdir(join(OUT, "core"), { recursive: true });

// harper.js, plus whatever chunk its dist splits out (the name is a build hash,
// so it is discovered rather than hardcoded).
const chunks = (await readdir(HARPER)).filter((name) => /^BinaryModule-.*\.js$/.test(name));
for (const name of [...HARPER_FILES, ...chunks]) {
  await copyFile(join(HARPER, name), join(OUT, "harper", name));
}

// src/core, imported by the UI as ../core/*.
for (const name of await readdir(join(ROOT, "src/core"))) {
  await copyFile(join(ROOT, "src/core", name), join(OUT, "core", name));
}

// The pages, with the import map rewritten and the module paths made relative.
for (const page of ["index.html", "sources.html", "measure.html"]) {
  let html = await readFile(join(ROOT, "src/web", page), "utf8");
  html = html
    .replace(/<script type="importmap">[\s\S]*?<\/script>/, IMPORT_MAP)
    .replaceAll('"/src/core/', '"./core/')
    .replaceAll('"/src/web/', '"./');
  await writeFile(join(OUT, page), html);
}

for (const name of ["app.js", "app.css", "linter.js", "read.js"]) {
  await copyFile(join(ROOT, "src/web", name), join(OUT, name));
}

const total = await Promise.all(
  (await readdir(OUT, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map(async (entry) => (await readFile(join(entry.parentPath, entry.name))).length),
);
const bytes = total.reduce((sum, size) => sum + size, 0);

console.log(`dist/web  ${total.length} files, ${(bytes / 1e6).toFixed(1)} MB`);
console.log(`  ${(bytes / 1e6 - 18).toFixed(2)} MB of that is not the WebAssembly binary`);
console.log(`  serve it from any static host: cd dist/web && python3 -m http.server`);
console.log(`  note ${basename(OUT)} is gitignored; nothing here is committed`);
