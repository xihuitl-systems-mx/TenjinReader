import assert from "node:assert/strict";
import test from "node:test";

import JSZip from "jszip";

import {
  pdfToDocx,
  pdfToJpegPages,
  pdfToPptx,
} from "../src/conversion-tools.js";

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

function createPdfFixture({ pageSizes, textPages = [] }) {
  let activeRenders = 0;
  let maximumActiveRenders = 0;
  const cleanedPages = [];
  const renderOrder = [];
  const pages = pageSizes.map(([baseWidth, baseHeight], index) => ({
    cleanup() {
      cleanedPages.push(index + 1);
    },
    getTextContent: async () => ({ items: textPages[index] ?? [] }),
    getViewport: ({ scale }) => ({
      width: baseWidth * scale,
      height: baseHeight * scale,
      scale,
    }),
    render({ canvas, viewport, annotationMode, intent }) {
      assert.equal(canvas.width, Math.round(viewport.width));
      assert.equal(canvas.height, Math.round(viewport.height));
      assert.equal(annotationMode, 3);
      assert.equal(intent, "print");
      const promise = (async () => {
        activeRenders += 1;
        maximumActiveRenders = Math.max(maximumActiveRenders, activeRenders);
        renderOrder.push(index + 1);
        await Promise.resolve();
        activeRenders -= 1;
      })();
      return { promise };
    },
  }));

  return {
    document: {
      numPages: pages.length,
      async getPage(pageNumber) {
        return pages[pageNumber - 1];
      },
    },
    diagnostics: {
      cleanedPages,
      renderOrder,
      get maximumActiveRenders() {
        return maximumActiveRenders;
      },
    },
  };
}

test("pdfToJpegPages renders sequentially into a detached reusable canvas", async () => {
  await withFakeCanvas(async () => {
    const { document, diagnostics } = createPdfFixture({
      pageSizes: [[100, 200], [300, 150], [80, 80]],
    });
    const progress = [];
    const output = [];
    for await (const page of pdfToJpegPages(document, {
      scale: 2,
      quality: 0.75,
      onProgress: (state) => progress.push(state),
    })) {
      output.push(page);
    }

    assert.deepEqual(output.map(({ name }) => name), [
      "pagina-001.jpg",
      "pagina-002.jpg",
      "pagina-003.jpg",
    ]);
    assert.deepEqual(output.map(({ width, height }) => [width, height]), [
      [200, 400],
      [600, 300],
      [160, 160],
    ]);
    assert.deepEqual(output.map(({ pageWidth, pageHeight }) => [pageWidth, pageHeight]), [
      [100, 200],
      [300, 150],
      [80, 80],
    ]);
    assert.ok(output.every(({ bytes }) => (
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-1) === 0xd9
    )));
    assert.deepEqual(diagnostics.renderOrder, [1, 2, 3]);
    assert.equal(diagnostics.maximumActiveRenders, 1);
    assert.deepEqual(diagnostics.cleanedPages, [1, 2, 3]);
    assert.deepEqual(progress.map(({ completed, total }) => [completed, total]), [
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});

test("pdfToJpegPages validates options without allocating a visible canvas", async () => {
  const { document } = createPdfFixture({ pageSizes: [[100, 100]] });
  await assert.rejects(
    async () => {
      for await (const _page of pdfToJpegPages(document, { quality: 2 })) {
        // The invalid option must fail before the first page is requested.
      }
    },
    /calidad JPEG.*entre 0 y 1/u,
  );
});

test("pdfToDocx creates editable page text and records fidelity limitations", async () => {
  const { document } = createPdfFixture({
    pageSizes: [[612, 792], [612, 792]],
    textPages: [
      [
        { str: "Segundo renglón", transform: [12, 0, 0, 12, 72, 680], width: 96 },
        { str: "Uno & <dos>", transform: [12, 0, 0, 12, 72, 720], width: 70 },
        { str: "tres", transform: [12, 0, 0, 12, 155, 720], width: 30 },
      ],
      [{ str: "Página final", transform: [11, 0, 0, 11, 72, 720], width: 65 }],
    ],
  });

  const bytes = await pdfToDocx(document);
  assert.ok(bytes instanceof Uint8Array);
  const zip = await JSZip.loadAsync(bytes);
  for (const path of [
    "[Content_Types].xml",
    "_rels/.rels",
    "docProps/core.xml",
    "word/document.xml",
    "word/styles.xml",
    "word/_rels/document.xml.rels",
  ]) {
    assert.ok(zip.file(path), `missing ${path}`);
  }

  const documentXml = await zip.file("word/document.xml").async("string");
  assert.match(documentXml, /Uno &amp; &lt;dos&gt; tres/u);
  assert.ok(documentXml.indexOf("Uno") < documentXml.indexOf("Segundo"));
  assert.equal((documentXml.match(/w:type="page"/gu) ?? []).length, 1);
  assert.match(documentXml, /Página final/u);
  const coreXml = await zip.file("docProps/core.xml").async("string");
  assert.match(coreXml, /diseño aproximado/u);
  assert.match(coreXml, /No incluye OCR/u);
});

test("pdfToDocx rejects image-only PDFs instead of returning an empty Word file", async () => {
  const { document } = createPdfFixture({
    pageSizes: [[612, 792]],
    textPages: [[]],
  });
  await assert.rejects(pdfToDocx(document), /no incluye OCR/iu);
});

test("pdfToPptx creates a related image slide for every PDF page", async () => {
  await withFakeCanvas(async () => {
    const { document } = createPdfFixture({
      pageSizes: [[612, 792], [792, 612]],
    });
    const bytes = await pdfToPptx(document);
    assert.ok(bytes instanceof Uint8Array);
    const zip = await JSZip.loadAsync(bytes);
    for (const path of [
      "[Content_Types].xml",
      "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels",
      "ppt/slideMasters/slideMaster1.xml",
      "ppt/slideLayouts/slideLayout1.xml",
      "ppt/theme/theme1.xml",
      "ppt/slides/slide1.xml",
      "ppt/slides/slide2.xml",
      "ppt/slides/_rels/slide1.xml.rels",
      "ppt/slides/_rels/slide2.xml.rels",
      "ppt/media/image1.jpg",
      "ppt/media/image2.jpg",
    ]) {
      assert.ok(zip.file(path), `missing ${path}`);
    }

    const presentationXml = await zip.file("ppt/presentation.xml").async("string");
    assert.equal((presentationXml.match(/<p:sldId /gu) ?? []).length, 2);
    assert.match(presentationXml, /<p:sldSz cx="\d+" cy="\d+" type="custom"\/>/u);
    const slideXml = await zip.file("ppt/slides/slide1.xml").async("string");
    assert.match(slideXml, /r:embed="rId1"/u);
    assert.match(slideXml, /contenido no editable/u);
    const relationships = await zip.file("ppt/slides/_rels/slide1.xml.rels").async("string");
    assert.match(relationships, /Target="\.\.\/media\/image1\.jpg"/u);
    assert.match(relationships, /slideLayout1\.xml/u);
    const coreXml = await zip.file("docProps/core.xml").async("string");
    assert.match(coreXml, /rasterizó como una imagen JPEG/u);
    assert.match(coreXml, /no son editables/u);
  });
});
