// The dev server. No Harper, no WASM — it listens on a spare port and makes a
// handful of requests.
//
// This exists because of a real bug: the server mapped `/` straight onto
// src/web/index.html and served its bytes from there. But that page links to
// `./app.css` and `./app.js`, and a relative URL resolves against the address the
// browser asked for, not against wherever the file sits on disk — so `/` produced
// unstyled HTML with no working JavaScript while `/src/web/index.html` was
// perfect. Every test and every screenshot used the second URL. The one the
// server itself printed was the broken one.
//
// So the assertions below are about *paths*, not about file contents.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createStaticServer } from "../tools/serve.mjs";

describe("the dev server", () => {
  let origin;
  let server;

  before(async () => {
    server = createStaticServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  /** Fetch without following redirects, so the redirect itself is visible. */
  const raw = (path) => fetch(`${origin}${path}`, { redirect: "manual" });

  it("redirects / rather than serving the page from there", async () => {
    // The whole point: a 200 here would mean relative URLs resolve one directory
    // too high, which is exactly the bug.
    const response = await raw("/");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/src/web/index.html");
  });

  it("lands on a page whose stylesheet and script actually load", async () => {
    const page = await fetch(`${origin}/`); // following redirects this time
    assert.equal(page.status, 200);
    const html = await page.text();

    // Resolve each relative reference the way a browser would, against the final
    // URL, and check the server really serves it.
    const references = [...html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(references.length >= 2, "expected relative css and js references");

    for (const reference of references) {
      const resolved = new URL(reference, page.url);
      const asset = await fetch(resolved);
      assert.equal(asset.status, 200, `${reference} resolved to ${resolved.pathname} and 404'd`);
    }
  });

  it("adds the trailing slash before serving a directory's index", async () => {
    // `/src/web` and `/src/web/` are different bases for a relative URL, so the
    // slash has to be real before index.html is served.
    const bare = await raw("/src/web");
    assert.equal(bare.status, 302);
    assert.equal(bare.headers.get("location"), "/src/web/");

    const slashed = await raw("/src/web/");
    assert.equal(slashed.status, 302);
    assert.equal(slashed.headers.get("location"), "/src/web/index.html");
  });

  it("serves the wasm with the content type the browser needs", async () => {
    const response = await fetch(`${origin}/node_modules/harper.js/dist/harper_wasm_slim_bg.wasm`, {
      method: "HEAD",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/wasm");
    // Every worker fetches this, and it is 18 MB.
    assert.match(response.headers.get("cache-control"), /max-age/);
  });

  it("does not cache source files", async () => {
    const response = await fetch(`${origin}/src/web/app.js`, { method: "HEAD" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("refuses to serve anything outside the repository", async () => {
    // Encoded, so the path only escapes after decoding — the case a naive check
    // misses.
    const response = await raw("/%2e%2e/%2e%2e/etc/passwd");
    assert.ok([403, 404].includes(response.status), `got ${response.status}`);
  });

  it("404s a file that is not there", async () => {
    assert.equal((await raw("/src/web/nope.css")).status, 404);
  });
});
