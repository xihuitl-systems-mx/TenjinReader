import test from "node:test";
import assert from "node:assert/strict";
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  StandardFonts,
} from "pdf-lib";
import { getDocument, PasswordResponses } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  inspectPdfSecurity,
  PDF_SECURITY_ERROR_CODES,
  protectPdf,
  unlockPdf,
} from "../src/pdf-security.js";

async function createFormFixture() {
  const document = await PDFDocument.create();
  const firstPage = document.addPage([320, 480]);
  const secondPage = document.addPage([340, 500]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  firstPage.drawText("Documento confidencial", { x: 30, y: 430, font, size: 16 });

  const field = document.getForm().createTextField("persona.nombre");
  field.setText("Xihuitl");
  field.addToPage(secondPage, {
    x: 30,
    y: 400,
    width: 180,
    height: 28,
    font,
  });
  return document.save({
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function createSignedFixture() {
  const document = await PDFDocument.create();
  document.addPage([320, 480]);
  const signature = document.context.obj({
    FT: PDFName.of("Sig"),
    T: PDFHexString.fromText("Firma1"),
    V: {
      Type: PDFName.of("Sig"),
      Filter: PDFName.of("Adobe.PPKLite"),
      SubFilter: PDFName.of("adbe.pkcs7.detached"),
      ByteRange: [0, 0, 0, 0],
      Contents: PDFHexString.of("00"),
    },
  });
  document.getForm().acroForm.normalizedEntries().Fields.push(
    document.context.register(signature),
  );
  return document.save({ useObjectStreams: false });
}

async function openWithPdfJs(bytes, password) {
  const task = getDocument({ data: Uint8Array.from(bytes), password });
  try {
    return await task.promise;
  } catch (error) {
    await task.destroy();
    throw error;
  }
}

test("protectPdf applies real AES-256 encryption readable by PDF.js", async () => {
  const source = await createFormFixture();
  const snapshot = Buffer.from(source);
  const protectedBytes = await protectPdf(source, "lectura-segura-2026", {
    permissions: { copy: false, modify: true },
  });

  assert.deepEqual(Buffer.from(source), snapshot, "the source must not mutate");
  const security = await inspectPdfSecurity(protectedBytes, "lectura-segura-2026");
  assert.equal(security.isEncrypted, true);
  assert.equal(security.isAuthenticated, true);
  assert.equal(security.algorithm, "AES-256");
  assert.equal(security.keyLength, 256);
  assert.equal(security.pageCount, 2);
  assert.equal(security.permissions.copy, false);

  await assert.rejects(
    openWithPdfJs(protectedBytes),
    (error) => error?.code === PasswordResponses.NEED_PASSWORD,
  );
  await assert.rejects(
    openWithPdfJs(protectedBytes, "incorrecta"),
    (error) => error?.code === PasswordResponses.INCORRECT_PASSWORD,
  );

  const opened = await openWithPdfJs(protectedBytes, "lectura-segura-2026");
  assert.equal(opened.numPages, 2);
  const fields = await opened.getFieldObjects();
  assert.equal(
    fields["persona.nombre"].find(({ type }) => type === "text")?.value,
    "Xihuitl",
  );
  await opened.cleanup();
});

test("unlockPdf removes encryption and preserves pages and AcroForm values", async () => {
  const source = await createFormFixture();
  const protectedBytes = await protectPdf(source, "clave-valida-2026");
  const unlockedBytes = await unlockPdf(protectedBytes, "clave-valida-2026");

  const security = await inspectPdfSecurity(unlockedBytes);
  assert.equal(security.isEncrypted, false);
  assert.equal(security.pageCount, 2);

  const reopened = await PDFDocument.load(unlockedBytes, { updateMetadata: false });
  assert.deepEqual(
    reopened.getPages().map((page) => page.getSize()),
    [{ width: 320, height: 480 }, { width: 340, height: 500 }],
  );
  assert.equal(
    reopened.getForm().getTextField("persona.nombre").getText(),
    "Xihuitl",
  );
  assert.ok(
    reopened.getForm()
      .getTextField("persona.nombre")
      .acroField
      .getWidgets()[0]
      .getAppearances()?.normal,
  );
});

test("security operations reject unsafe passwords and invalid state", async () => {
  const source = await createFormFixture();
  await assert.rejects(
    protectPdf(source, "corta"),
    (error) => error?.code === PDF_SECURITY_ERROR_CODES.WEAK_PASSWORD,
  );
  await assert.rejects(
    protectPdf(source, "misma-clave", { ownerPassword: "misma-clave" }),
    (error) => error?.code === PDF_SECURITY_ERROR_CODES.WEAK_PASSWORD,
  );
  await assert.rejects(
    unlockPdf(source, "cualquier-clave"),
    (error) => error?.code === PDF_SECURITY_ERROR_CODES.NOT_PROTECTED,
  );

  const protectedBytes = await protectPdf(source, "clave-correcta");
  await assert.rejects(
    unlockPdf(protectedBytes, "clave-incorrecta"),
    (error) => error?.code === PDF_SECURITY_ERROR_CODES.INVALID_PASSWORD,
  );
  await assert.rejects(
    protectPdf(protectedBytes, "otra-clave-segura"),
    (error) => error?.code === PDF_SECURITY_ERROR_CODES.ALREADY_PROTECTED,
  );
  await assert.rejects(
    protectPdf(await createSignedFixture(), "firma-no-se-toca"),
    (error) => error?.code === PDF_SECURITY_ERROR_CODES.SIGNED_PDF_UNSUPPORTED,
  );
});
