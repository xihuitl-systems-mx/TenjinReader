import test from "node:test";
import assert from "node:assert/strict";

import { replaceFileTransaction } from "../src/file-transaction.js";

function memoryBackend(entries, { failStagedMove = false, failWrite = false } = {}) {
  const files = new Map(Object.entries(entries));
  let temporaryIndex = 0;
  return {
    files,
    options: {
      getStats: async (path) => files.has(path)
        ? { isFile: true, size: files.get(path).length }
        : null,
      temporaryPath: async (path) => `${path}.tmp-${++temporaryIndex}`,
      writeStagedFile: async (path) => {
        files.set(path, "nuevo");
        if (failWrite) throw new Error("fallo de escritura");
      },
      moveFile: async (source, destination) => {
        if (failStagedMove && source.endsWith("tmp-1") && destination === "/doc.pdf") {
          throw new Error("fallo al intercambiar");
        }
        if (!files.has(source)) throw new Error("origen ausente");
        files.set(destination, files.get(source));
        files.delete(source);
      },
      removeFile: async (path) => files.delete(path),
    },
  };
}

test("reemplaza el destino solo después de verificar el archivo temporal", async () => {
  const backend = memoryBackend({ "/doc.pdf": "viejo" });
  await replaceFileTransaction({
    destination: "/doc.pdf",
    byteLength: 5,
    overwrite: true,
    ...backend.options,
  });
  assert.equal(backend.files.get("/doc.pdf"), "nuevo");
  assert.deepEqual([...backend.files.keys()], ["/doc.pdf"]);
});

test("restaura el original si falla el intercambio del temporal", async () => {
  const backend = memoryBackend({ "/doc.pdf": "viejo" }, { failStagedMove: true });
  await assert.rejects(
    replaceFileTransaction({
      destination: "/doc.pdf",
      byteLength: 5,
      overwrite: true,
      ...backend.options,
    }),
    /intercambiar/iu,
  );
  assert.equal(backend.files.get("/doc.pdf"), "viejo");
});

test("una escritura temporal fallida nunca toca el original", async () => {
  const backend = memoryBackend({ "/doc.pdf": "viejo" }, { failWrite: true });
  await assert.rejects(
    replaceFileTransaction({
      destination: "/doc.pdf",
      byteLength: 5,
      overwrite: true,
      ...backend.options,
    }),
    /escritura/iu,
  );
  assert.equal(backend.files.get("/doc.pdf"), "viejo");
});
