// A static server for developing the web UI. No dependencies, no bundler.
//
// It serves the repository root so that `/node_modules/harper.js/...` resolves,
// which is what the import map in src/web/index.html points bare specifiers at.
// For deployment, `npm run build:web` copies the same files into a self-contained
// directory instead.
//
// Not a production server: no caching, no directory listings, no range requests.
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".dic": "text/plain; charset=utf-8",
  ".aff": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Send the browser somewhere else, and let it re-resolve relative URLs there. */
function redirect(response, to) {
  response.writeHead(302, { location: to }).end();
}

/**
 * Build the server without starting it, so a test can drive it on a spare port.
 *
 * Worth testing for a dev-only tool because the bug it had was invisible from the
 * path everything else used: `/src/web/index.html` worked while `/` — the URL this
 * very file prints — served a page whose stylesheet and script 404'd.
 */
export function createStaticServer() {
  return createServer(handle);
}

async function handle(request, response) {
  const url = new URL(request.url, "http://localhost");

  // `/` must *redirect*, not serve the page's bytes from here.
  //
  // index.html links to `./app.css` and `./app.js`, which resolve against the
  // URL the browser asked for, not against wherever the file lives on disk.
  // Serving it at `/` therefore asks the browser for `/app.css` — a 404 — and you
  // get unstyled HTML with no working JavaScript.
  if (url.pathname === "/") {
    redirect(response, "/src/web/index.html");
    return;
  }

  // Refuse anything that climbs out of the repository.
  const path = join(ROOT, normalize(decodeURIComponent(url.pathname)));
  if (!path.startsWith(ROOT)) {
    response.writeHead(403).end("forbidden");
    return;
  }

  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      // Same trap: `/src/web` and `/src/web/` are different bases for a relative
      // URL, so the trailing slash has to be real before index.html is served.
      redirect(response, url.pathname.endsWith("/") ? `${url.pathname}index.html` : `${url.pathname}/`);
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "content-length": info.size,
      // Every worker fetches the binary, and it is 18 MB. Without this, spawning
      // five linters downloads it five times and the UI feels broken. It only
      // changes on `npm install`, so caching it is safe; source files are not
      // cached, because reloading after an edit is the point of a dev server.
      "cache-control": extname(path) === ".wasm" ? "public, max-age=86400" : "no-store",
    });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
}

// Only listen when run as a command, so importing this in a test is side-effect free.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  createStaticServer().listen(PORT, () => {
    console.log(`weirsmith: http://localhost:${PORT}/  (serving ${ROOT})`);
  });
}
