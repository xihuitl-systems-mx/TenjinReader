import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { Canvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";

import {
  PDFJS_ASSET_OPTIONS,
  resolvePdfJsAssetUrl,
} from "../src/pdf-source.js";
import { PDFJS_RUNTIME_ASSET_DIRECTORIES } from "../vite.config.js";

const JPX_IMAGE = Buffer.from(
  "AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAACAAAAAgAAwcHAAAAAAAPY29scgEAAAAAABAAAADqanAyY/9P/1EALwAAAAAACAAAAAgAAAAAAAAAAAAAAAgAAAAIAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAAMEBAAB/1wADUBASEhQSEhQSEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS40/5AACgAAAAAAaQAB/5PH1AQJb8fUBAlvx9QECH/PwAgEcKfgBARwx9oFH2gQBB8EH8faCAANAvl/o+0EAAs9/r/D6gOH1AYNAe8LPXnB84MAIhiDoPnBgAN+bcHzhIPnCCIaEFcDf+ZP/9k=",
  "base64",
);

function createJpxPdf() {
  const chunks = [Buffer.from("%PDF-1.7\n", "ascii")];
  const offsets = [0];
  let length = chunks[0].length;
  const append = (...values) => {
    for (const value of values) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "ascii");
      chunks.push(bytes);
      length += bytes.length;
    }
  };
  const addObject = (number, ...body) => {
    offsets[number] = length;
    append(`${number} 0 obj\n`, ...body, "\nendobj\n");
  };

  addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  addObject(
    3,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 8 8] ",
    "/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
  );
  addObject(
    4,
    `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode /Length ${JPX_IMAGE.length} >>\nstream\n`,
    JPX_IMAGE,
    "\nendstream",
  );
  const content = Buffer.from("q 8 0 0 8 0 0 cm /Im0 Do Q", "ascii");
  addObject(5, `<< /Length ${content.length} >>\nstream\n`, content, "\nendstream");

  const xrefOffset = length;
  append("xref\n0 6\n0000000000 65535 f \n");
  for (let number = 1; number <= 5; number += 1) {
    append(`${String(offsets[number]).padStart(10, "0")} 00000 n \n`);
  }
  append(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(chunks));
}

test("packages the PDF.js OpenJPEG runtime used by JPX scans", async () => {
  assert.ok(PDFJS_RUNTIME_ASSET_DIRECTORIES.includes("wasm"));
  await Promise.all([
    access(new URL("../node_modules/pdfjs-dist/wasm/openjpeg.wasm", import.meta.url)),
    access(new URL(
      "../node_modules/pdfjs-dist/wasm/openjpeg_nowasm_fallback.js",
      import.meta.url,
    )),
  ]);
  assert.equal(PDFJS_ASSET_OPTIONS.wasmUrl, "./wasm/");
  assert.equal(
    resolvePdfJsAssetUrl("./wasm/", "https://example.test/folentra/"),
    "https://example.test/folentra/wasm/",
  );

  const controllerSource = await readFile(new URL(
    "../src/pdf-controller.js",
    import.meta.url,
  ), "utf8");
  assert.match(controllerSource, /\.\.\.PDFJS_ASSET_OPTIONS/u);

  const mainSource = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const splitPreviewSource = await readFile(new URL(
    "../src/pdf-split-preview.js",
    import.meta.url,
  ), "utf8");
  assert.equal((mainSource.match(/\.\.\.PDFJS_ASSET_OPTIONS/gu) || []).length, 2);
  assert.match(splitPreviewSource, /\.\.\.PDFJS_ASSET_OPTIONS/u);

  const appShell = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(
    appShell,
    /script-src 'self' 'wasm-unsafe-eval'/u,
    "The CSP must permit PDF.js to instantiate the packaged OpenJPEG WASM module.",
  );
});

test("OpenJPEG renders an embedded JPX page instead of leaving it blank", async () => {
  const previous = {
    DOMMatrix: globalThis.DOMMatrix,
    ImageData: globalThis.ImageData,
    Path2D: globalThis.Path2D,
  };
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: createJpxPdf(),
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    // Node's PDF.js binary-data factory does not fetch file: WASM URLs; the
    // browser build uses WASM while this regression exercises its bundled JS
    // OpenJPEG fallback from the same packaged directory.
    useWasm: false,
    wasmUrl: new URL("../node_modules/pdfjs-dist/wasm/", import.meta.url).toString(),
  });

  try {
    const document = await task.promise;
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 8 });
    const canvas = new Canvas(viewport.width, viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;

    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonWhite = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] < 250 || pixels[index + 1] < 250 || pixels[index + 2] < 250) {
        nonWhite += 1;
      }
    }
    assert.ok(nonWhite > canvas.width * canvas.height * 0.8);
  } finally {
    await task.destroy();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
