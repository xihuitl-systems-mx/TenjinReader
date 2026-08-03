import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import UPNG from "png2icons/lib/UPNG.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(testDirectory, "..");

function asArrayBuffer(buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
}

function boundsFor(pixels, width, height, predicate) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (
        predicate(
          pixels[offset],
          pixels[offset + 1],
          pixels[offset + 2],
          pixels[offset + 3],
        )
      ) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
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

function pixelAt(pixels, width, x, y) {
  const offset = (y * width + x) * 4;
  return pixels.subarray(offset, offset + 4);
}

test("PDF icon keeps a centered portrait document silhouette", async () => {
  const file = await readFile(
    path.join(
      projectDirectory,
      "installer",
      "PdfDocument.png",
    ),
  );
  const decoded = UPNG.decode(asArrayBuffer(file));
  const pixels = new Uint8Array(UPNG.toRGBA8(decoded)[0]);

  assert.equal(decoded.width, 1024);
  assert.equal(decoded.height, 1024);

  for (const [x, y] of [
    [0, 0],
    [1023, 0],
    [0, 1023],
    [1023, 1023],
  ]) {
    assert.equal(pixelAt(pixels, decoded.width, x, y)[3], 0);
  }

  const interior = pixelAt(
    pixels,
    decoded.width,
    512,
    256,
  );
  assert.ok(interior[3] >= 250);
  assert.ok(
    interior[0] >= 235 &&
      interior[1] >= 235 &&
      interior[2] >= 235,
  );

  const redBounds = boundsFor(
    pixels,
    decoded.width,
    decoded.height,
    (red, green, blue, alpha) =>
      alpha >= 128 &&
      red >= 100 &&
      red - green >= 10 &&
      red - blue >= 10,
  );
  assert.ok(redBounds.width >= 650);
  assert.ok(redBounds.width <= 700);
  assert.ok(redBounds.height >= 900);
  assert.ok(redBounds.height <= 940);
  assert.ok(redBounds.height / redBounds.width >= 1.3);
  assert.ok(redBounds.left >= 150);
  assert.ok(redBounds.top >= 40);
  assert.ok(redBounds.right <= 873);
  assert.ok(redBounds.bottom <= 983);
  assert.ok(
    Math.abs(
      redBounds.left - (decoded.width - 1 - redBounds.right),
    ) <= 2,
  );
  assert.ok(
    Math.abs(
      redBounds.top -
        (decoded.height - 1 - redBounds.bottom),
    ) <= 2,
  );
});

test("PDF ICO contains readable alpha-safe frames from 16 to 256 px", async () => {
  const icon = await readFile(
    path.join(
      projectDirectory,
      "installer",
      "PdfDocument.ico",
    ),
  );
  const frameCount = icon.readUInt16LE(4);
  const expectedSizes = [
    256,
    128,
    96,
    72,
    64,
    48,
    32,
    24,
    16,
  ];

  assert.equal(frameCount, expectedSizes.length);

  for (let index = 0; index < frameCount; index += 1) {
    const entryOffset = 6 + index * 16;
    const size = icon[entryOffset] || 256;
    const length = icon.readUInt32LE(entryOffset + 8);
    const offset = icon.readUInt32LE(entryOffset + 12);
    const frame = icon.subarray(offset, offset + length);
    const decoded = UPNG.decode(asArrayBuffer(frame));
    const pixels = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
    const alphaBounds = boundsFor(
      pixels,
      size,
      size,
      (_red, _green, _blue, alpha) => alpha >= 128,
    );

    assert.equal(size, expectedSizes[index]);
    assert.equal(icon.readUInt16LE(entryOffset + 6), 32);
    assert.equal(decoded.width, size);
    assert.equal(decoded.height, size);
    assert.ok(alphaBounds.left >= 1);
    assert.ok(alphaBounds.top >= 1);
    assert.ok(alphaBounds.right <= size - 2);
    assert.ok(alphaBounds.bottom <= size - 2);
    assert.ok(alphaBounds.height > alphaBounds.width);
    assert.ok(
      alphaBounds.width / alphaBounds.height >= 0.65,
    );
    assert.ok(
      alphaBounds.width / alphaBounds.height <= 0.8,
    );
    assert.ok(
      Math.abs(
        alphaBounds.left -
          (size - 1 - alphaBounds.right),
      ) <= 1,
    );
    assert.ok(
      Math.abs(
        alphaBounds.top -
          (size - 1 - alphaBounds.bottom),
      ) <= 1,
    );
  }
});

test("PPTX icon reuses the PDF silhouette with an orange PPTX treatment", async () => {
  const [pdfFile, pptxFile] = await Promise.all([
    readFile(path.join(projectDirectory, "installer", "PdfDocument.png")),
    readFile(path.join(projectDirectory, "installer", "PptxDocument.png")),
  ]);
  const pdfDecoded = UPNG.decode(asArrayBuffer(pdfFile));
  const pptxDecoded = UPNG.decode(asArrayBuffer(pptxFile));
  const pdfPixels = new Uint8Array(UPNG.toRGBA8(pdfDecoded)[0]);
  const pptxPixels = new Uint8Array(UPNG.toRGBA8(pptxDecoded)[0]);

  assert.equal(pptxDecoded.width, 1024);
  assert.equal(pptxDecoded.height, 1024);
  assert.equal(pptxPixels.byteLength, pdfPixels.byteLength);

  let orangePixels = 0;
  let redPixels = 0;
  for (let offset = 0; offset < pptxPixels.byteLength; offset += 4) {
    assert.equal(
      pptxPixels[offset + 3],
      pdfPixels[offset + 3],
      `alpha differs at pixel ${offset / 4}`,
    );
    const red = pptxPixels[offset];
    const green = pptxPixels[offset + 1];
    const blue = pptxPixels[offset + 2];
    const alpha = pptxPixels[offset + 3];
    if (
      alpha >= 128 &&
      red >= 150 &&
      green >= 70 &&
      green <= 190 &&
      blue <= 120 &&
      red - green >= 25
    ) {
      orangePixels += 1;
    }
    if (
      alpha >= 128 &&
      red >= 130 &&
      green < 70 &&
      red - green >= 55 &&
      red - blue >= 55
    ) {
      redPixels += 1;
    }
  }

  assert.ok(orangePixels >= 150_000);
  assert.equal(redPixels, 0);
});

test("PPTX ICO contains the same alpha-safe Windows frame sizes", async () => {
  const icon = await readFile(
    path.join(projectDirectory, "installer", "PptxDocument.ico"),
  );
  const expectedSizes = [256, 128, 96, 72, 64, 48, 32, 24, 16];
  const frameCount = icon.readUInt16LE(4);
  assert.equal(frameCount, expectedSizes.length);

  for (let index = 0; index < frameCount; index += 1) {
    const entryOffset = 6 + index * 16;
    const size = icon[entryOffset] || 256;
    const length = icon.readUInt32LE(entryOffset + 8);
    const offset = icon.readUInt32LE(entryOffset + 12);
    const decoded = UPNG.decode(asArrayBuffer(icon.subarray(offset, offset + length)));
    const pixels = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
    const alphaBounds = boundsFor(
      pixels,
      size,
      size,
      (_red, _green, _blue, alpha) => alpha >= 128,
    );

    assert.equal(size, expectedSizes[index]);
    assert.equal(icon.readUInt16LE(entryOffset + 6), 32);
    assert.equal(decoded.width, size);
    assert.equal(decoded.height, size);
    assert.ok(alphaBounds.height > alphaBounds.width);
    assert.ok(alphaBounds.left >= 1);
    assert.ok(alphaBounds.top >= 1);
    assert.ok(alphaBounds.right <= size - 2);
    assert.ok(alphaBounds.bottom <= size - 2);
  }
});
