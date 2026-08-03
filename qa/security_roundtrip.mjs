import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { protectPdf, unlockPdf } from "../src/pdf-security.js";

const qaDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.resolve(qaDirectory, "..", "build", "qa-security");
const password = "folentra-qa-2026";

await mkdir(outputDirectory, { recursive: true });

const document = await PDFDocument.create();
const firstPage = document.addPage([420, 595]);
const secondPage = document.addPage([420, 595]);
const font = await document.embedFont(StandardFonts.Helvetica);
firstPage.drawText("Folentra PDF - prueba de seguridad", {
  x: 42,
  y: 535,
  font,
  size: 18,
});
firstPage.drawText("Este documento conserva paginas y formularios AcroForm.", {
  x: 42,
  y: 500,
  font,
  size: 11,
});
secondPage.drawText("Formulario rellenable", {
  x: 42,
  y: 535,
  font,
  size: 16,
});
const field = document.getForm().createTextField("persona.nombre");
field.setText("Xihuitl Systems");
field.addToPage(secondPage, {
  x: 42,
  y: 470,
  width: 250,
  height: 32,
  font,
});

const original = await document.save({
  updateFieldAppearances: false,
  useObjectStreams: false,
});
const protectedBytes = await protectPdf(original, password);
const unlocked = await unlockPdf(protectedBytes, password);

await Promise.all([
  writeFile(path.join(outputDirectory, "original.pdf"), original),
  writeFile(path.join(outputDirectory, "protected.pdf"), protectedBytes),
  writeFile(path.join(outputDirectory, "unlocked.pdf"), unlocked),
]);

console.log(outputDirectory);
