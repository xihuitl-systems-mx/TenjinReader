import test from "node:test";
import assert from "node:assert/strict";

import {
  baseName,
  canScrollVertically,
  clamp,
  formatFileSize,
  getDocumentType,
  hexToNormalizedRgb,
  isSafeExternalUrl,
  isSupportedDocument,
  mapWithConcurrency,
  normalizeExternalUrl,
  toExactArrayBuffer,
  wheelDeltaToPixels,
} from "../src/utils.js";

test("detects PDF and supported presentation extensions case-insensitively", () => {
  assert.equal(getDocumentType("manual.pdf"), "pdf");
  assert.equal(getDocumentType("C:\\Docs\\DECK.PPTX"), "pptx");
  assert.equal(getDocumentType("C:\\Docs\\LEGACY.PPT"), "pptx");
  assert.equal(getDocumentType("/tmp/deck.odp"), "pptx");
  assert.equal(getDocumentType("/tmp/formula.odf"), "pptx");
  assert.equal(getDocumentType("/tmp/archive.pdf.exe"), null);
  assert.equal(getDocumentType("notes.txt"), null);
  assert.equal(getDocumentType(".pdf"), "pdf");
  assert.equal(getDocumentType(null), null);
  assert.equal(isSupportedDocument("slides.pptx"), true);
  assert.equal(isSupportedDocument("slides.odp"), true);
  assert.equal(isSupportedDocument("image.png"), false);
});

test("extracts a base name from Windows and POSIX paths", () => {
  assert.equal(baseName("C:\\Users\\Ada\\report.pdf"), "report.pdf");
  assert.equal(baseName("/home/ada/slides.pptx"), "slides.pptx");
  assert.equal(baseName("/home/ada/folder/"), "folder");
  assert.equal(baseName("report.pdf"), "report.pdf");
  assert.equal(baseName(""), "");
});

test("formats byte sizes compactly and rejects invalid sizes", () => {
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(0.5), "1 B");
  assert.equal(formatFileSize(900), "900 B");
  assert.equal(formatFileSize(1024), "1 KB");
  assert.equal(formatFileSize(1536), "1.5 KB");
  assert.equal(formatFileSize(1024 ** 2), "1 MB");
  assert.equal(formatFileSize(10.567 * 1024, 2), "10.57 KB");
  assert.equal(formatFileSize(-1), "—");
  assert.equal(formatFileSize(Number.NaN), "—");
});

test("clamps values even when bounds arrive in reverse order", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-2, 0, 10), 0);
  assert.equal(clamp(12, 0, 10), 10);
  assert.equal(clamp(5, 10, 0), 5);
});

test("normalizes wheel deltas from pixels, lines, and pages", () => {
  assert.equal(wheelDeltaToPixels(80, 0, 600), 80);
  assert.equal(wheelDeltaToPixels(3, 1, 600), 48);
  assert.equal(wheelDeltaToPixels(-1, 2, 600), -600);
  assert.equal(wheelDeltaToPixels(1, 2, 0), 1);
  assert.equal(wheelDeltaToPixels(Number.NaN, 0, 600), 0);
});

test("detects remaining vertical scroll room in either direction", () => {
  const scrollport = {
    scrollTop: 100,
    scrollHeight: 1000,
    clientHeight: 500,
  };

  assert.equal(canScrollVertically(scrollport, -1), true);
  assert.equal(canScrollVertically(scrollport, 1), true);
  assert.equal(
    canScrollVertically({ ...scrollport, scrollTop: 0 }, -1),
    false,
  );
  assert.equal(
    canScrollVertically({ ...scrollport, scrollTop: 500 }, 1),
    false,
  );
  assert.equal(
    canScrollVertically({ ...scrollport, scrollTop: 499.5 }, 1),
    false,
  );
  assert.equal(canScrollVertically(scrollport, 0), false);
});

test("normalizes three- and six-digit hex colors", () => {
  assert.deepEqual(hexToNormalizedRgb("#000"), { r: 0, g: 0, b: 0 });
  assert.deepEqual(hexToNormalizedRgb("fff"), { r: 1, g: 1, b: 1 });
  assert.deepEqual(hexToNormalizedRgb("#8040ff"), {
    r: 128 / 255,
    g: 64 / 255,
    b: 1,
  });
  assert.equal(hexToNormalizedRgb("#abcd"), null);
  assert.equal(hexToNormalizedRgb("red"), null);
});

test("creates an exact ArrayBuffer for sliced and pooled views", () => {
  const backing = new Uint8Array([9, 1, 2, 3, 8]);
  const exact = toExactArrayBuffer(backing.subarray(1, 4));

  assert.equal(exact.byteLength, 3);
  assert.deepEqual([...new Uint8Array(exact)], [1, 2, 3]);

  const original = new ArrayBuffer(2);
  assert.equal(toExactArrayBuffer(original), original);
  assert.throws(() => toExactArrayBuffer([1, 2]), TypeError);
});

test("allows only safe HTTP, HTTPS, and mailto URLs", () => {
  assert.equal(isSafeExternalUrl("https://example.com/docs"), true);
  assert.equal(isSafeExternalUrl("http://localhost:8080/"), true);
  assert.equal(isSafeExternalUrl("mailto:help@example.com"), true);
  assert.equal(isSafeExternalUrl("mailto:a@example.com%0d%0abcc:evil@example.com"), false);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(isSafeExternalUrl("file:///etc/passwd"), false);
  assert.equal(isSafeExternalUrl("https://user:secret@example.com"), false);
  assert.equal(isSafeExternalUrl(" https://example.com"), false);
  assert.equal(normalizeExternalUrl("https://example.com"), "https://example.com/");
  assert.equal(normalizeExternalUrl("mailto:"), null);
});

test("maps expensive work with bounded concurrency and stable order", async () => {
  let active = 0;
  let maximumActive = 0;
  const completionOrder = [];
  const output = await mapWithConcurrency([30, 5, 20, 1], async (delay, index) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    completionOrder.push(index);
    active -= 1;
    return `resultado-${index}`;
  }, 2);

  assert.equal(maximumActive, 2);
  assert.notDeepEqual(completionOrder, [0, 1, 2, 3]);
  assert.deepEqual(output, [
    "resultado-0",
    "resultado-1",
    "resultado-2",
    "resultado-3",
  ]);
  await assert.rejects(mapWithConcurrency([1], null), TypeError);
  await assert.rejects(mapWithConcurrency([1], async () => 1, 0), RangeError);
});
