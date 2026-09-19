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
const iconNames = [
  "PdfDocument",
  "PptDocument",
  "PptxDocument",
  "OdpDocument",
  "OdfDocument",
];
const expectedSizes = [256, 128, 96, 72, 64, 48, 32, 24, 16];

function decodePng(buffer) {
  const bytes = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
  const png = UPNG.decode(bytes);
  return {
    width: png.width,
    height: png.height,
    pixels: new Uint8Array(UPNG.toRGBA8(png)[0]),
  };
}

function pixelAt(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return image.pixels.subarray(offset, offset + 4);
}

function alphaBounds(image, minimumAlpha = 128) {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (pixelAt(image, x, y)[3] < minimumAlpha) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return {
    left,
    top,
    right,
    bottom,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

test("file icons share a portrait silhouette and a visible folded corner", async () => {
  const pngFiles = await Promise.all(
    iconNames.map((name) =>
      readFile(path.join(projectDirectory, "installer", `${name}.png`)),
    ),
  );
  const images = pngFiles.map(decodePng);
  assert.equal(new Set(pngFiles.map((file) => file.toString("base64"))).size, 5);

  for (const [index, image] of images.entries()) {
    const name = iconNames[index];
    assert.equal(image.width, 1024, name);
    assert.equal(image.height, 1024, name);
    for (const [x, y] of [[0, 0], [1023, 0], [0, 1023], [1023, 1023]]) {
      assert.equal(pixelAt(image, x, y)[3], 0, `${name} corner`);
    }
    const bounds = alphaBounds(image);
    assert.ok(bounds.width >= 600 && bounds.width <= 650, name);
    assert.ok(bounds.height >= 860 && bounds.height <= 900, name);
    assert.ok(bounds.width / bounds.height >= 0.69, name);
    assert.ok(bounds.width / bounds.height <= 0.74, name);
    assert.ok(Math.abs(bounds.left - (1023 - bounds.right)) <= 3, name);

    const foldSeam = pixelAt(image, 730, 160);
    const foldFace = pixelAt(image, 800, 105);
    assert.ok(foldSeam[3] >= 250 && foldSeam[0] < 60, `${name} seam`);
    assert.ok(foldFace[3] >= 250 && foldFace[0] > 150, `${name} fold`);
  }
});

test("every file icon has alpha-safe Windows ICO frames from 16 to 256 px", async () => {
  for (const name of iconNames) {
    const ico = await readFile(
      path.join(projectDirectory, "installer", `${name}.ico`),
    );
    assert.equal(ico.readUInt16LE(4), expectedSizes.length, name);
    for (const [index, expectedSize] of expectedSizes.entries()) {
      const entry = 6 + index * 16;
      const size = ico[entry] || 256;
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      const image = decodePng(ico.subarray(offset, offset + length));
      const bounds = alphaBounds(image);
      assert.equal(size, expectedSize, name);
      assert.equal(image.width, size, name);
      assert.equal(image.height, size, name);
      assert.equal(ico.readUInt16LE(entry + 6), 32, name);
      assert.ok(bounds.left >= 1 && bounds.top >= 1, name);
      assert.ok(bounds.right <= size - 2 && bounds.bottom <= size - 2, name);
      assert.ok(bounds.height > bounds.width, name);
      assert.ok(bounds.width / bounds.height >= 0.66, name);
      assert.ok(bounds.width / bounds.height <= 0.79, name);
    }
  }
});

test("the five file extensions have independent Windows icon associations", async () => {
  const installer = await readFile(
    path.join(projectDirectory, "installer", "TenjinReader.iss"),
    "utf8",
  );
  for (const [extension, name] of [
    ["pdf", "PdfDocument"],
    ["ppt", "PptDocument"],
    ["pptx", "PptxDocument"],
    ["odp", "OdpDocument"],
    ["odf", "OdfDocument"],
  ]) {
    assert.match(installer, new RegExp(`Source: "${name}\\.ico"`));
    assert.match(
      installer,
      new RegExp(`ValueName: "\\.${extension}"; ValueData: "TenjinReader\\.${extension.toUpperCase()}"`),
    );
    assert.match(
      installer,
      new RegExp(`TenjinReader\\.${extension.toUpperCase()}\\\\DefaultIcon"; ValueType: string; ValueData: """\\{app}\\\\${name}\\.ico""`),
    );
  }
});
