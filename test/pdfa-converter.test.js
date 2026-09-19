import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { Canvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  PDF_A4_CONVERSION_LIMITATIONS,
  PDF_A4_IMPLEMENTATION,
  convertPdfToPdfA4,
  detectPdfA4Declaration,
} from "../src/pdfa-converter.js";

const ONE_PIXEL_JPEG = Uint8Array.from(Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==",
  "base64",
));

class FakeCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.context = {
      fillStyle: "",
      fillRect() {},
      restore() {},
      save() {},
    };
  }

  getContext() {
    return this.context;
  }

  async convertToBlob() {
    return new Blob([ONE_PIXEL_JPEG], { type: "image/jpeg" });
  }
}

class NapiOffscreenCanvas {
  #canvas;

  constructor(width, height) {
    this.#canvas = new Canvas(width, height);
  }

  get width() {
    return this.#canvas.width;
  }

  set width(value) {
    this.#canvas.width = value;
  }

  get height() {
    return this.#canvas.height;
  }

  set height(value) {
    this.#canvas.height = value;
  }

  getContext(type, options) {
    return this.#canvas.getContext(type, options);
  }

  convertToBlob({ type, quality } = {}) {
    return Promise.resolve(new Blob(
      [this.#canvas.toBuffer(type ?? "image/png", quality)],
      { type: type ?? "image/png" },
    ));
  }
}

function withFakeCanvas(action) {
  const previous = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = FakeCanvas;
  return Promise.resolve()
    .then(action)
    .finally(() => {
      if (previous === undefined) delete globalThis.OffscreenCanvas;
      else globalThis.OffscreenCanvas = previous;
    });
}

function createPdfFixture(pageSizes) {
  const cleaned = [];
  const requested = [];
  const pages = pageSizes.map(([width, height], index) => ({
    cleanup() {
      cleaned.push(index + 1);
    },
    getViewport({ scale }) {
      return { width: width * scale, height: height * scale };
    },
    render({ annotationMode, intent, canvas }) {
      assert.equal(annotationMode, 3);
      assert.equal(intent, "print");
      assert.ok(canvas.width > 0);
      assert.ok(canvas.height > 0);
      return { promise: Promise.resolve() };
    },
  }));
  return {
    document: {
      numPages: pages.length,
      async getPage(pageNumber) {
        requested.push(pageNumber);
        return pages[pageNumber - 1];
      },
    },
    cleaned,
    requested,
  };
}

test("convertPdfToPdfA4 creates a parseable PDF 2.0 visual archive copy", async () => {
  await withFakeCanvas(async () => {
    const { document, cleaned, requested } = createPdfFixture([
      [612, 792],
      [792, 612],
    ]);
    const progress = [];
    const result = await convertPdfToPdfA4(document, {
      title: "Expediente <2026> & final",
      date: "2026-07-31T20:00:00Z",
      onProgress: (state) => progress.push(state),
    });

    assert.ok(result.bytes instanceof Uint8Array);
    assert.equal(result.pageCount, 2);
    assert.equal(result.profile, "PDF/A-4");
    assert.equal(result.method, "rasterized-srgb");
    assert.equal(PDF_A4_IMPLEMENTATION.standard, "ISO 19005-4:2020");
    assert.deepEqual(PDF_A4_IMPLEMENTATION.externalRuntimeDependencies, []);
    assert.equal(result.declaration.isPdfA4, true);
    assert.equal(result.declaration.pdfVersion, "2.0");
    assert.equal(result.declaration.part, 4);
    assert.equal(result.declaration.revision, 2020);
    assert.equal(result.declaration.hasOutputIntent, true);
    assert.equal(result.declaration.isEncrypted, false);
    assert.strictEqual(result.limitations, PDF_A4_CONVERSION_LIMITATIONS);
    assert.deepEqual(progress.map(({ completed, total }) => [completed, total]), [
      [1, 2],
      [2, 2],
    ]);
    // Rendering also returns the unscaled page box, so PDF/A conversion does
    // not request every page a second time just to recover its dimensions.
    assert.deepEqual(requested, [1, 2]);
    assert.deepEqual(cleaned, [1, 2]);

    const source = Buffer.from(result.bytes).toString("latin1");
    assert.ok(source.startsWith("%PDF-2.0"));
    assert.match(source, /<pdfaid:part>4<\/pdfaid:part>/u);
    assert.match(source, /<pdfaid:rev>2020<\/pdfaid:rev>/u);
    assert.match(source, /Expediente &lt;2026&gt; &amp; final/u);
    assert.match(source, /\/S \/GTS_PDFA1/u);
    assert.match(source, /\/DestOutputProfile 4 0 R/u);
    assert.doesNotMatch(source, /\/Encrypt\b/u);
    assert.doesNotMatch(source, /\/JavaScript\b|\/JS\b/u);

    const reopened = await PDFDocument.load(result.bytes);
    assert.equal(reopened.getPageCount(), 2);
    assert.deepEqual(reopened.getPage(0).getSize(), { width: 612, height: 792 });
    assert.deepEqual(reopened.getPage(1).getSize(), { width: 792, height: 612 });
  });
});

test("the bundled real PDF completes the PDF.js raster-to-PDF/A-4 pipeline", async () => {
  const previous = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = NapiOffscreenCanvas;
  const source = new Uint8Array(await readFile(new URL("../qa/sample.pdf", import.meta.url)));
  const loadingTask = getDocument({
    data: source,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useSystemFonts: true,
  });
  let pdfDocument;
  try {
    pdfDocument = await loadingTask.promise;
    const result = await convertPdfToPdfA4(pdfDocument, {
      title: "Muestra real de TenjinReader",
      date: "2026-07-31T20:00:00Z",
    });
    assert.equal(result.pageCount, pdfDocument.numPages);
    const reopened = await PDFDocument.load(result.bytes);
    assert.equal(reopened.getPageCount(), pdfDocument.numPages);

    // Allows this exact end-to-end fixture to be passed to veraPDF and Poppler
    // during release QA without committing generated binaries.
    if (process.env.TENJINREADER_PDFA_QA_OUTPUT) {
      await writeFile(process.env.TENJINREADER_PDFA_QA_OUTPUT, result.bytes);
    }
  } finally {
    await loadingTask.destroy();
    if (previous === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = previous;
  }
});

test("the generated classic xref table points to every indirect object", async () => {
  await withFakeCanvas(async () => {
    const { document } = createPdfFixture([[300, 400]]);
    const { bytes } = await convertPdfToPdfA4(document, {
      date: "2026-07-31T20:00:00Z",
    });
    const source = Buffer.from(bytes).toString("latin1");
    const startXref = Number(source.match(/startxref\n(\d+)\n%%EOF/u)?.[1]);
    assert.equal(source.slice(startXref, startXref + 4), "xref");

    const xref = source.slice(startXref).match(/xref\n0 (\d+)\n([\s\S]*?)trailer/u);
    assert.ok(xref);
    const objectCount = Number(xref[1]) - 1;
    const entries = xref[2].trimEnd().split("\n").slice(1);
    assert.equal(entries.length, objectCount);
    entries.forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      const marker = `${index + 1} 0 obj`;
      assert.equal(source.slice(offset, offset + marker.length), marker);
    });
  });
});

test("detectPdfA4Declaration reports a declaration, not generic conformance", () => {
  const spoofedPdf = new TextEncoder().encode(`%PDF-2.0
1 0 obj
<< /Type /Metadata /Subtype /XML >>
stream
<pdfaid:part>4</pdfaid:part><pdfaid:rev>2020</pdfaid:rev>
endstream
endobj
trailer << /Encrypt 9 0 R >>
%%EOF`);
  const inspection = detectPdfA4Declaration(spoofedPdf);
  assert.deepEqual(inspection, {
    isPdfA4: true,
    pdfVersion: "2.0",
    part: 4,
    revision: 2020,
    hasMetadata: true,
    hasOutputIntent: false,
    isEncrypted: true,
  });
  assert.equal("valid" in inspection, false);
  assert.equal("conformant" in inspection, false);

  const ordinaryPdf = new TextEncoder().encode("%PDF-1.7\n%%EOF");
  assert.equal(detectPdfA4Declaration(ordinaryPdf).isPdfA4, false);
});

test("convertPdfToPdfA4 validates the document and progress callback", async () => {
  await assert.rejects(
    convertPdfToPdfA4({ numPages: 0, getPage() {} }),
    /al menos una página/u,
  );
  const { document } = createPdfFixture([[100, 100]]);
  await assert.rejects(
    convertPdfToPdfA4(document, { onProgress: true }),
    /onProgress debe ser una función/u,
  );
});
