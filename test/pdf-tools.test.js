import test from "node:test";
import assert from "node:assert/strict";
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  StandardFonts,
} from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";

import {
  composePdfPages,
  inspectPdfFeatures,
  jpgImagesToPdf,
  mergePdfFiles,
  optimizePdf,
  parsePageRanges,
  reorderPdfPages,
  splitPdf,
  splitPdfSequential,
} from "../src/pdf-tools.js";

const jpgCanvas = createCanvas(2, 1);
const jpgContext = jpgCanvas.getContext("2d");
jpgContext.fillStyle = "#ef4444";
jpgContext.fillRect(0, 0, 2, 1);
const JPG_2X1 = jpgCanvas.toBuffer("image/jpeg", 80);

async function createPlainFixture(widths) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  widths.forEach((width, index) => {
    const page = document.addPage([width, 300 + index]);
    page.drawText(`Pagina ${index + 1}`, {
      x: 20,
      y: 250,
      size: 14,
      font,
    });
  });
  return document.save({ useObjectStreams: false });
}

async function createFormFixture() {
  const document = await PDFDocument.create();
  const firstPage = document.addPage([210, 300]);
  const secondPage = document.addPage([220, 301]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const form = document.getForm();

  const firstField = form.createTextField("page.first");
  firstField.setText("Primero");
  firstField.addToPage(firstPage, {
    x: 20,
    y: 200,
    width: 120,
    height: 24,
    font,
  });

  const secondField = form.createTextField("page.second");
  secondField.setText("Segundo");
  secondField.addToPage(secondPage, {
    x: 20,
    y: 200,
    width: 120,
    height: 24,
    font,
  });

  return document.save({
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function createXfaFixture() {
  const document = await PDFDocument.create();
  document.addPage([200, 300]);
  const form = document.getForm();
  form.acroForm.dict.set(
    PDFName.of("XFA"),
    document.context.obj([
      PDFHexString.fromText("template"),
      PDFHexString.fromText("<xfa />"),
    ]),
  );
  return document.save({
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function createSignatureFixture({ signed = true } = {}) {
  const document = await PDFDocument.create();
  document.addPage([200, 300]);
  const form = document.getForm();
  const signature = document.context.obj({
    FT: PDFName.of("Sig"),
    T: PDFHexString.fromText("Firma1"),
  });
  if (signed) {
    signature.set(
      PDFName.of("V"),
      document.context.obj({
        Type: PDFName.of("Sig"),
        Filter: PDFName.of("Adobe.PPKLite"),
        SubFilter: PDFName.of("adbe.pkcs7.detached"),
        ByteRange: [0, 0, 0, 0],
        Contents: PDFHexString.of("00"),
      }),
    );
  }
  form.acroForm.normalizedEntries().Fields.push(
    document.context.register(signature),
  );
  return document.save({
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function pageWidths(bytes) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  return document.getPages().map((page) => page.getWidth());
}

test("parsePageRanges converts one-based ranges and preserves requested order", () => {
  assert.deepEqual(parsePageRanges("3, 1-2, 2, 5–6", 6), [2, 0, 1, 4, 5]);
  assert.throws(() => parsePageRanges("", 5), /al menos una página/i);
  assert.throws(() => parsePageRanges("4-2", 5), /invertido/i);
  assert.throws(() => parsePageRanges("1, 7", 6), /entre 1 y 6/i);
  assert.throws(() => parsePageRanges("1-x", 6), /no es válido/i);
});

test("inspectPdfFeatures distinguishes plain, AcroForm, XFA and signatures", async () => {
  const plain = await inspectPdfFeatures(await createPlainFixture([200]));
  assert.deepEqual(
    {
      pageCount: plain.pageCount,
      hasAcroForm: plain.hasAcroForm,
      hasXfa: plain.hasXfa,
      formFieldCount: plain.formFieldCount,
      signatureFieldCount: plain.signatureFieldCount,
    },
    {
      pageCount: 1,
      hasAcroForm: false,
      hasXfa: false,
      formFieldCount: 0,
      signatureFieldCount: 0,
    },
  );

  const form = await inspectPdfFeatures(await createFormFixture());
  assert.equal(form.hasAcroForm, true);
  assert.equal(form.hasXfa, false);
  assert.equal(form.formFieldCount, 2);
  assert.equal(form.signatureFieldCount, 0);

  const xfa = await inspectPdfFeatures(await createXfaFixture());
  assert.equal(xfa.hasAcroForm, true);
  assert.equal(xfa.hasXfa, true);

  const unsignedSignature = await inspectPdfFeatures(
    await createSignatureFixture({ signed: false }),
  );
  assert.equal(unsignedSignature.signatureFieldCount, 1);
  assert.equal(unsignedSignature.signedSignatureCount, 0);

  const signedSignature = await inspectPdfFeatures(
    await createSignatureFixture({ signed: true }),
  );
  assert.equal(signedSignature.hasDigitalSignatures, true);
  assert.equal(signedSignature.hasSignedDigitalSignatures, true);
  assert.equal(signedSignature.signedSignatureCount, 1);
});

test("reorderPdfPages preserves page objects and interactive AcroForm widgets", async () => {
  const original = await createFormFixture();
  const snapshot = Buffer.from(original);
  const progress = [];
  const output = await reorderPdfPages(original, [1, 0], {
    onProgress: (entry) => progress.push(entry),
  });

  assert.deepEqual(Buffer.from(original), snapshot, "the source bytes must not mutate");
  assert.deepEqual(await pageWidths(output), [220, 210]);
  assert.equal(progress.at(-1).phase, "complete");

  const reopened = await PDFDocument.load(output, { updateMetadata: false });
  const form = reopened.getForm();
  assert.equal(form.getTextField("page.first").getText(), "Primero");
  assert.equal(form.getTextField("page.second").getText(), "Segundo");
  const firstWidget = form
    .getTextField("page.first")
    .acroField
    .getWidgets()[0];
  const secondWidget = form
    .getTextField("page.second")
    .acroField
    .getWidgets()[0];
  assert.equal(firstWidget.P(), reopened.getPage(1).ref);
  assert.equal(secondWidget.P(), reopened.getPage(0).ref);
  assert.ok(firstWidget.getAppearances()?.normal);
  assert.ok(secondWidget.getAppearances()?.normal);
});

test("reorderPdfPages rejects invalid orders, XFA and digital signature fields", async () => {
  const plain = await createPlainFixture([200, 210]);
  await assert.rejects(reorderPdfPages(plain, [0]), /exactamente una vez/i);
  await assert.rejects(reorderPdfPages(plain, [0, 0]), /duplicadas/i);
  await assert.rejects(reorderPdfPages(plain, [0, 3]), /índice.*inválido/i);
  await assert.rejects(
    reorderPdfPages(await createXfaFixture(), [0]),
    /formulario XFA/i,
  );
  await assert.rejects(
    reorderPdfPages(await createSignatureFixture(), [0]),
    /firma digital/i,
  );
});

test("composePdfPages interleaves flat sources in the exact requested order", async () => {
  const base = await createPlainFixture([101, 102]);
  const external = await createPlainFixture([201, 202]);
  const output = await composePdfPages(
    [base, external],
    [
      { sourceIndex: 1, pageIndex: 1 },
      { sourceIndex: 0, pageIndex: 0 },
      { sourceIndex: 1, pageIndex: 0 },
    ],
  );
  assert.deepEqual(await pageWidths(output), [202, 101, 201]);
});

test("composePdfPages can remove base pages while keeping remaining AcroForms", async () => {
  const formBytes = await createFormFixture();
  const output = await composePdfPages(
    [formBytes],
    [{ sourceIndex: 0, pageIndex: 1 }],
  );
  const reopened = await PDFDocument.load(output, { updateMetadata: false });

  assert.deepEqual(await pageWidths(output), [220]);
  assert.equal(reopened.getForm().getFieldMaybe("page.first"), undefined);
  assert.equal(reopened.getForm().getTextField("page.second").getText(), "Segundo");
  const widget = reopened
    .getForm()
    .getTextField("page.second")
    .acroField
    .getWidgets()[0];
  assert.equal(widget.P(), reopened.getPage(0).ref);
  assert.ok(widget.getAppearances()?.normal);
  assert.equal(reopened.getPage(0).node.Annots().size(), 1);
});

test("composePdfPages validates plans and rejects forms when external pages are used", async () => {
  const plain = await createPlainFixture([100]);
  const form = await createFormFixture();
  await assert.rejects(composePdfPages([plain], []), /al menos una página/i);
  await assert.rejects(
    composePdfPages([plain], [
      { sourceIndex: 0, pageIndex: 0 },
      { sourceIndex: 0, pageIndex: 0 },
    ]),
    /duplicadas/i,
  );
  await assert.rejects(
    composePdfPages(
      [plain, form],
      [
        { sourceIndex: 0, pageIndex: 0 },
        { sourceIndex: 1, pageIndex: 0 },
      ],
    ),
    /formularios rellenables/i,
  );
});

test("mergePdfFiles preserves source and page order and reports progress", async () => {
  const progress = [];
  const output = await mergePdfFiles(
    [
      await createPlainFixture([110]),
      { bytes: await createPlainFixture([210, 220]), name: "segundo.pdf" },
    ],
    { onProgress: (entry) => progress.push(entry) },
  );

  assert.deepEqual(await pageWidths(output), [110, 210, 220]);
  assert.deepEqual(
    progress.filter(({ phase }) => phase === "files").map(({ completed }) => completed),
    [1, 2],
  );
  assert.equal(progress.at(-1).phase, "complete");
});

test("mergePdfFiles rejects AcroForms, XFA and signatures instead of orphaning widgets", async () => {
  await assert.rejects(
    mergePdfFiles([await createFormFixture()]),
    /formularios rellenables/i,
  );
  await assert.rejects(
    mergePdfFiles([await createXfaFixture()]),
    /formulario XFA/i,
  );
  await assert.rejects(
    mergePdfFiles([await createSignatureFixture()]),
    /firma digital/i,
  );
});

test("splitPdf creates independent outputs from arrays and range strings", async () => {
  const source = await createPlainFixture([101, 102, 103]);
  const progress = [];
  const outputs = await splitPdf(source, ["1, 3", [1]], {
    onProgress: (entry) => progress.push(entry),
  });

  assert.equal(outputs.length, 2);
  assert.deepEqual(await pageWidths(outputs[0]), [101, 103]);
  assert.deepEqual(await pageWidths(outputs[1]), [102]);
  assert.equal(progress.at(-1).phase, "complete");
  await assert.rejects(splitPdf(source, [[0, 0]]), /duplicadas/i);

  const formOutputs = await splitPdf(await createFormFixture(), [[1], [0]]);
  const secondPageOnly = await PDFDocument.load(formOutputs[0], { updateMetadata: false });
  const firstPageOnly = await PDFDocument.load(formOutputs[1], { updateMetadata: false });
  assert.equal(secondPageOnly.getPageCount(), 1);
  assert.equal(secondPageOnly.getForm().getTextField("page.second").getText(), "Segundo");
  assert.throws(() => secondPageOnly.getForm().getTextField("page.first"));
  assert.equal(firstPageOnly.getPageCount(), 1);
  assert.equal(firstPageOnly.getForm().getTextField("page.first").getText(), "Primero");
  assert.throws(() => firstPageOnly.getForm().getTextField("page.second"));
});

test("splitPdfSequential creates one output at a time with backpressure", async () => {
  const source = await createPlainFixture([101, 102, 103]);
  const progress = [];
  const iterator = splitPdfSequential(source, [[0], "2-3"], {
    onProgress: (entry) => progress.push(entry),
  })[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.deepEqual(await pageWidths(first.value), [101]);
  assert.deepEqual(
    progress.map(({ phase, completed }) => [phase, completed]),
    [["groups", 1]],
    "the second output must not start until the consumer requests it",
  );

  const second = await iterator.next();
  assert.equal(second.done, false);
  assert.deepEqual(await pageWidths(second.value), [102, 103]);
  assert.deepEqual(
    progress.map(({ phase, completed }) => [phase, completed]),
    [["groups", 1], ["groups", 2]],
  );

  const complete = await iterator.next();
  assert.equal(complete.done, true);
  assert.equal(complete.value, undefined);
  assert.equal(progress.at(-1).phase, "complete");
});

test("optimizePdf is lossless, preserves forms and never returns more bytes", async () => {
  const original = await createFormFixture();
  const output = await optimizePdf(original);
  assert.ok(output.byteLength <= original.byteLength);

  const reopened = await PDFDocument.load(output, { updateMetadata: false });
  const form = reopened.getForm();
  assert.equal(reopened.getPageCount(), 2);
  assert.equal(form.getTextField("page.first").getText(), "Primero");
  assert.equal(form.getTextField("page.second").getText(), "Segundo");
  for (const field of form.getFields()) {
    assert.ok(field.acroField.getWidgets()[0].getAppearances()?.normal);
  }

  await assert.rejects(
    optimizePdf(await createSignatureFixture()),
    /firma digital/i,
  );
});

test("optimizePdf reuses an equal-size source instead of cloning the whole PDF", async () => {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.addPage([100, 200]);
  const original = await document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: true,
  });
  const output = await optimizePdf(original);
  assert.equal(output.byteLength, original.byteLength);
  assert.strictEqual(output, original);
});

test("jpgImagesToPdf embeds one valid JPG per page without transcoding it", async () => {
  const progress = [];
  const output = await jpgImagesToPdf(
    [JPG_2X1, { data: JPG_2X1 }],
    { onProgress: (entry) => progress.push(entry) },
  );
  const reopened = await PDFDocument.load(output, { updateMetadata: false });

  assert.equal(reopened.getPageCount(), 2);
  assert.deepEqual(reopened.getPage(0).getSize(), { width: 2, height: 1 });
  assert.deepEqual(reopened.getPage(1).getSize(), { width: 2, height: 1 });
  assert.equal(progress.at(-1).phase, "complete");

  const a4Output = await jpgImagesToPdf([JPG_2X1], {
    pageSize: "a4",
    margin: 24,
  });
  const a4 = await PDFDocument.load(a4Output, { updateMetadata: false });
  assert.ok(a4.getPage(0).getWidth() > a4.getPage(0).getHeight());

  await assert.rejects(
    jpgImagesToPdf([new Uint8Array([1, 2, 3])]),
    /no es un archivo JPG válido/i,
  );
});
