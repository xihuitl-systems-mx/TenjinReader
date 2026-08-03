import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the desktop allowlist contains the narrow file operations used by rename and cache", async () => {
  const config = JSON.parse(await readFile(new URL(
    "../neutralino.config.json",
    import.meta.url,
  ), "utf8"));
  const allowed = new Set(config.nativeAllowList);
  for (const capability of [
    "filesystem.copy",
    "filesystem.move",
    "filesystem.readDirectory",
    "filesystem.remove",
  ]) {
    assert.equal(allowed.has(capability), true, `${capability} must be allowed`);
  }

  const nativeSource = await readFile(new URL("../src/native.js", import.meta.url), "utf8");
  assert.match(nativeSource, /PRESENTATION_CACHE_ENTRY/u);
  assert.match(nativeSource, /assertPresentationCachePath/u);
  assert.match(nativeSource, /filesystem\.copy\(source, destination/u);
});
