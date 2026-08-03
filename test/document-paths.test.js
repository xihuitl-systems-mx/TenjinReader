import test from "node:test";
import assert from "node:assert/strict";

import { sameDocumentPath, siblingDocumentPath } from "../src/document-paths.js";

test("siblingDocumentPath conserva la carpeta y cambia solo el nombre", () => {
  assert.equal(
    siblingDocumentPath("C:\\Documentos\\Informe.PDF", "Resumen.PDF"),
    "C:\\Documentos\\Resumen.PDF",
  );
  assert.equal(
    siblingDocumentPath("/home/ana/charla.pptx", "reunion.pptx"),
    "/home/ana/reunion.pptx",
  );
});

test("siblingDocumentPath rechaza nombres que intentan cambiar de carpeta", () => {
  assert.throws(
    () => siblingDocumentPath("C:\\Documentos\\Informe.pdf", "otra\\ruta.pdf"),
    /nueva ruta/iu,
  );
});

test("sameDocumentPath respeta mayusculas segun la plataforma", () => {
  assert.equal(
    sameDocumentPath("C:\\Docs\\Informe.pdf", "c:/docs/informe.pdf", "windows"),
    true,
  );
  assert.equal(
    sameDocumentPath("/home/Ana/Informe.pdf", "/home/ana/informe.pdf", "linux"),
    false,
  );
});
