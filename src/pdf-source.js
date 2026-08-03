import { toExactArrayBuffer } from "./utils.js";

export const PDF_RANGE_CHUNK_BYTES = 1024 * 1024;

export function resolvePdfJsAssetUrl(path, baseUrl = globalThis.document?.baseURI) {
  const relative = String(path || "");
  if (!baseUrl) return relative;
  return new URL(relative, baseUrl).href;
}

export const PDFJS_ASSET_OPTIONS = Object.freeze({
  // Workers resolve relative fetches from their hashed /assets/ URL, not from
  // the document root. Absolute runtime URLs keep all decoder/font requests at
  // the packaged application root in both Neutralino and a regular browser.
  cMapUrl: resolvePdfJsAssetUrl("./cmaps/"),
  cMapPacked: true,
  standardFontDataUrl: resolvePdfJsAssetUrl("./standard_fonts/"),
  // OpenJPEG (JPX/JPEG 2000), JBIG2, ICC color management and their
  // JavaScript fallbacks are distributed together in this directory.
  wasmUrl: resolvePdfJsAssetUrl("./wasm/"),
});

function abortError() {
  return new DOMException("La lectura del PDF fue cancelada.", "AbortError");
}

function validateLength(value) {
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new TypeError("No se pudo determinar el tamaño del PDF.");
  }
  return length;
}

function normalizeRange(begin, end, length) {
  const start = Number(begin);
  const finish = Number(end);
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(finish)
    || start < 0
    || finish <= start
    || start >= length
  ) {
    throw new RangeError("El rango solicitado para el PDF no es válido.");
  }
  return [start, Math.min(finish, length)];
}

/**
 * Creates a small random-access facade over a PDF without imposing an
 * application-level maximum size. `readAll` is deliberately lazy and is used
 * only by operations that must rewrite the complete document.
 */
export function createPdfByteSource({
  length,
  name = "documento.pdf",
  path = null,
  modifiedAt = null,
  readRange,
}) {
  const byteLength = validateLength(length);
  if (typeof readRange !== "function") {
    throw new TypeError("La fuente PDF necesita lectura por rangos.");
  }

  let aborted = false;
  const pending = new Map();

  const source = {
    length: byteLength,
    name: String(name || "documento.pdf"),
    path: typeof path === "string" ? path : null,
    modifiedAt: Number.isFinite(modifiedAt) ? Number(modifiedAt) : null,

    async readRange(begin, end) {
      if (aborted) throw abortError();
      const [start, finish] = normalizeRange(begin, end, byteLength);
      const key = `${start}:${finish}`;
      if (pending.has(key)) return pending.get(key);

      const request = Promise.resolve(readRange(start, finish))
        .then((value) => {
          if (aborted) throw abortError();
          const buffer = toExactArrayBuffer(value);
          if (buffer.byteLength !== finish - start) {
            throw new Error("El archivo cambió o no se pudo leer el rango PDF completo.");
          }
          return buffer;
        })
        .finally(() => pending.delete(key));
      pending.set(key, request);
      return request;
    },

    async readAll({ chunkSize = PDF_RANGE_CHUNK_BYTES, onProgress } = {}) {
      if (aborted) throw abortError();
      const size = Math.max(64 * 1024, Math.floor(Number(chunkSize) || 0));
      let output;
      try {
        output = new Uint8Array(byteLength);
      } catch (error) {
        throw new RangeError(
          `No hay memoria suficiente para editar este PDF de ${byteLength} bytes. `
          + "Aún puedes leerlo mediante la carga progresiva.",
          { cause: error },
        );
      }
      for (let start = 0; start < byteLength; start += size) {
        const finish = Math.min(byteLength, start + size);
        output.set(new Uint8Array(await source.readRange(start, finish)), start);
        onProgress?.(finish, byteLength);
      }
      return output.buffer;
    },

    abort() {
      aborted = true;
      pending.clear();
    },
  };

  return source;
}

export function createMemoryPdfByteSource(data, metadata = {}) {
  const buffer = toExactArrayBuffer(data);
  const bytes = new Uint8Array(buffer);
  return createPdfByteSource({
    length: bytes.byteLength,
    name: metadata.name,
    path: metadata.path,
    modifiedAt: metadata.modifiedAt,
    readRange: (begin, end) => bytes.slice(begin, end).buffer,
  });
}
