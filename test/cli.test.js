// Public CLI behaviour that is too important to leave implicit in the core
// tests. In particular, the default probe must not confuse a known dialect
// variant with a dictionary gap.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = new URL("../", import.meta.url);

describe("the probe command", () => {
  let dir;
  let source;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "weirsmith-cli-"));
    source = join(dir, "dialect-variants.txt");
    await writeFile(source, [
      "haematology",
      "aetiology",
      "immunisation",
      "paediatrics",
      "neighbourhood",
      "pediatrics",
      "",
    ].join("\n"));
  });

  after(async () => rm(dir, { recursive: true, force: true }));

  it("checks every dialect by default and labels an explicit single-dialect probe honestly", {
    timeout: 15_000,
  }, async () => {
    const defaultProbe = await execFileAsync(
      process.execPath,
      ["src/cli.js", "probe", source],
      { cwd: ROOT },
    );
    assert.match(defaultProbe.stdout, /6 words Harper knows but flags in some dialects/);
    assert.match(defaultProbe.stdout, /missing everywhere: 0 words/);

    const americanProbe = await execFileAsync(
      process.execPath,
      ["src/cli.js", "probe", source, "--dialect", "american"],
      { cwd: ROOT },
    );
    assert.match(americanProbe.stdout, /missing in american: 5 words/);
    assert.doesNotMatch(americanProbe.stdout, /missing everywhere/);
  });
});
