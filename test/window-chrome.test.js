import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import UPNG from "png2icons/lib/UPNG.js";

const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("the top bar has no app brand and native window controls remain enabled", async () => {
  const [html, css, configText] = await Promise.all([
    readFile(path.join(projectDirectory, "index.html"), "utf8"),
    readFile(path.join(projectDirectory, "src", "styles.css"), "utf8"),
    readFile(path.join(projectDirectory, "neutralino.config.json"), "utf8"),
  ]);
  const config = JSON.parse(configText);
  assert.doesNotMatch(html, /class="brand(?:-mark|-name)?"/);
  assert.doesNotMatch(css, /\.brand(?:-mark|-name)?\s*\{/);
  assert.equal(config.modes.window.borderless, false);
  assert.ok(config.nativeAllowList.includes("window.setIcon"));
});

test("the Windows title-bar icon is a fully transparent PNG", async () => {
  const buffer = await readFile(
    path.join(projectDirectory, "public", "window-titlebar-transparent.png"),
  );
  const png = UPNG.decode(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
  );
  const pixels = new Uint8Array(UPNG.toRGBA8(png)[0]);
  assert.equal(png.width, 200);
  assert.equal(png.height, 200);
  for (let index = 3; index < pixels.length; index += 4) {
    assert.equal(pixels[index], 0);
  }
});
