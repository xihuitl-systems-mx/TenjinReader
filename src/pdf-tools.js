import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNull,
  PDFRef,
  ParseSpeeds,
} from "pdf-lib";

const MAX_PDF_PAGE_DIMENSION = 14_400;
const A4_SIZE = Object.freeze([595.28, 841.89]);
const LOAD_OPTIONS = Object.freeze({
  ignoreEncryption: true,
  parseSpeed: ParseSpeeds.Fastest,
  throwOnInvalidObject: false,
  updateMetadata: false,
});
const SAVE_OPTIONS = Object.freeze({
  addDefaultPage: false,
  updateFieldAppearances: false,
  useObjectStreams: true,
});

const ACROFORM = PDFName.of("AcroForm");
const FIELDS = PDFName.of("Fields");
const FIELD_TYPE = PDFName.of("FT");
const FIELD_NAME = PDFName.of("T");
const FIELD_VALUE = PDFName.of("V");
const KIDS = PDFName.of("Kids");
const SIGNATURE = PDFName.of("Sig");
const SUBTYPE = PDFName.of("Subtype");
const WIDGET = PDFName.of("Widget");
const XFA = PDFName.of("XFA");

function normalizeBytes(value, description = "PDF") {
  let bytes;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  if (!bytes) {
    throw new TypeError(`Los datos del ${description} deben ser binarios.`);
  }
  if (bytes.byteLength === 0) {
    throw new TypeError(`Los datos del ${description} están vacíos.`);
  }
  return bytes;
}

function sourceBytes(source, index, description = "PDF") {
  if (
    source
    && typeof source === "object"
    && !(source instanceof ArrayBuffer)
    && !ArrayBuffer.isView(source)
  ) {
    const candidate = source.bytes ?? source.data;
    if (candidate !== undefined) {
      return normalizeBytes(candidate, `${description} ${index + 1}`);
    }
  }
  return normalizeBytes(source, `${description} ${index + 1}`);
}

function exactBytes(bytes) {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : Uint8Array.from(bytes);
}

function cleanLibraryMessage(error) {
  return String(error?.message || error || "error desconocido")
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, 240);
}

async function loadPdf(value, description = "PDF") {
  const bytes = normalizeBytes(value, description);
  try {
    return await PDFDocument.load(bytes, LOAD_OPTIONS);
  } catch (error) {
    throw new Error(
      `No se pudo leer el ${description}: ${cleanLibraryMessage(error)}`,
      { cause: error },
    );
  }
}

function lookupDict(context, value) {
  try {
    return context.lookupMaybe(value, PDFDict);
  } catch {
    return undefined;
  }
}

function lookupArray(dict, key) {
  try {
    return dict?.lookupMaybe(key, PDFArray);
  } catch {
    return undefined;
  }
}

function lookupName(dict, key) {
  try {
    return dict?.lookupMaybe(key, PDFName);
  } catch {
    return undefined;
  }
}

function hasNonNullValue(dict, key) {
  try {
    const value = dict?.get(key);
    return value !== undefined && value !== PDFNull;
  } catch {
    return false;
  }
}

function scanAcroFormFields(pdfDocument, acroForm) {
  const rootFields = lookupArray(acroForm, FIELDS);
  if (!rootFields) {
    return { formFieldCount: 0, signatureFieldCount: 0, signedSignatureCount: 0 };
  }

  const seenReferences = new Set();
  const seenDictionaries = new Set();
  let formFieldCount = 0;
  let signatureFieldCount = 0;
  let signedSignatureCount = 0;

  const visit = (rawField, inheritedType, inheritedValue = false) => {
    if (rawField instanceof PDFRef) {
      const referenceKey = rawField.toString();
      if (seenReferences.has(referenceKey)) return;
      seenReferences.add(referenceKey);
    }

    const field = lookupDict(pdfDocument.context, rawField);
    if (!field || seenDictionaries.has(field)) return;
    seenDictionaries.add(field);

    const fieldType = lookupName(field, FIELD_TYPE) || inheritedType;
    const hasValue = hasNonNullValue(field, FIELD_VALUE) || inheritedValue;
    const kids = lookupArray(field, KIDS);
    const childFields = [];

    if (kids) {
      for (let index = 0; index < kids.size(); index += 1) {
        const rawKid = kids.get(index);
        const kid = lookupDict(pdfDocument.context, rawKid);
        if (!kid) continue;

        const subtype = lookupName(kid, SUBTYPE);
        const isPlainWidget = (
          subtype === WIDGET
          && !kid.has(FIELD_NAME)
          && !kid.has(FIELD_TYPE)
        );
        if (!isPlainWidget) childFields.push(rawKid);
      }
    }

    if (fieldType && childFields.length === 0) {
      formFieldCount += 1;
      if (fieldType === SIGNATURE) {
        signatureFieldCount += 1;
        if (hasValue) signedSignatureCount += 1;
      }
      return;
    }

    for (const childField of childFields) {
      visit(childField, fieldType, hasValue);
    }
  };

  for (let index = 0; index < rootFields.size(); index += 1) {
    visit(rootFields.get(index), undefined, false);
  }

  return { formFieldCount, signatureFieldCount, signedSignatureCount };
}

function inspectLoadedPdf(pdfDocument) {
  let acroForm;
  try {
    acroForm = pdfDocument.catalog.lookupMaybe(ACROFORM, PDFDict);
  } catch {
    acroForm = undefined;
  }

  const hasAcroForm = Boolean(acroForm);
  const hasXfa = Boolean(acroForm?.has(XFA));
  const fields = acroForm
    ? scanAcroFormFields(pdfDocument, acroForm)
    : { formFieldCount: 0, signatureFieldCount: 0, signedSignatureCount: 0 };

  return {
    pageCount: pdfDocument.getPageCount(),
    encrypted: Boolean(pdfDocument.isEncrypted),
    hasAcroForm,
    hasXfa,
    ...fields,
    hasDigitalSignatures: fields.signatureFieldCount > 0,
    hasSignedDigitalSignatures: fields.signedSignatureCount > 0,
  };
}

function assertTransformable(features, { allowForms, operation }) {
  if (features.encrypted) {
    throw new Error(`No se puede ${operation} un PDF cifrado o protegido.`);
  }
  if (features.hasXfa) {
    throw new Error(
      `No se puede ${operation} un PDF con formulario XFA sin dañarlo.`,
    );
  }
  if (features.signatureFieldCount > 0) {
    throw new Error(
      `No se puede ${operation} un PDF con campos de firma digital.`,
    );
  }
  if (!allowForms && features.formFieldCount > 0) {
    throw new Error(
      `No se puede ${operation} un PDF con formularios rellenables sin aplanarlos.`,
    );
  }
}

function progressCallback(options) {
  const callback = options?.onProgress;
  if (callback !== undefined && typeof callback !== "function") {
    throw new TypeError("onProgress debe ser una función.");
  }
  return callback;
}

async function reportProgress(callback, operation, phase, completed, total) {
  if (!callback) return;
  await callback({ operation, phase, completed, total });
}

function validatePageOrder(order, pageCount) {
  if (!Array.isArray(order)) {
    throw new TypeError("El orden de páginas debe ser un arreglo de índices.");
  }
  if (order.length !== pageCount) {
    throw new RangeError(
      "El orden debe incluir exactamente una vez cada página del PDF.",
    );
  }

  const seen = new Set();
  for (const pageIndex of order) {
    if (
      !Number.isSafeInteger(pageIndex)
      || pageIndex < 0
      || pageIndex >= pageCount
    ) {
      throw new RangeError("El orden contiene un índice de página inválido.");
    }
    if (seen.has(pageIndex)) {
      throw new RangeError("El orden contiene páginas duplicadas.");
    }
    seen.add(pageIndex);
  }
  return [...order];
}

function normalizeCompositionOrder(order, pageCounts) {
  if (!Array.isArray(order) || order.length === 0) {
    throw new TypeError("El PDF final debe conservar al menos una página.");
  }

  const seenPages = new Set();
  return order.map((entry, position) => {
    const sourceIndex = entry?.sourceIndex;
    const pageIndex = entry?.pageIndex;
    if (
      !Number.isSafeInteger(sourceIndex)
      || sourceIndex < 0
      || sourceIndex >= pageCounts.length
    ) {
      throw new RangeError(
        `La página ${position + 1} usa un archivo de origen inválido.`,
      );
    }
    if (
      !Number.isSafeInteger(pageIndex)
      || pageIndex < 0
      || pageIndex >= pageCounts[sourceIndex]
    ) {
      throw new RangeError(
        `La página ${position + 1} usa un índice de página inválido.`,
      );
    }

    const key = `${sourceIndex}:${pageIndex}`;
    if (seenPages.has(key)) {
      throw new RangeError("El orden contiene páginas duplicadas.");
    }
    seenPages.add(key);
    return { sourceIndex, pageIndex };
  });
}

async function rebuildPageTree(pdfDocument, pageOrder, onPage) {
  const originalPages = pdfDocument.getPages().slice();
  for (let pageIndex = pdfDocument.getPageCount() - 1; pageIndex >= 0; pageIndex -= 1) {
    pdfDocument.removePage(pageIndex);
  }
  for (let position = 0; position < pageOrder.length; position += 1) {
    pdfDocument.addPage(originalPages[pageOrder[position]]);
    await onPage?.(position + 1, pageOrder.length);
  }
}

function normalizeGroups(groups, pageCount) {
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new TypeError("Debes indicar al menos un grupo de páginas.");
  }

  return groups.map((rawGroup, groupIndex) => {
    const candidate = (
      rawGroup
      && !Array.isArray(rawGroup)
      && typeof rawGroup === "object"
    ) ? rawGroup.pages : rawGroup;
    const group = typeof candidate === "string"
      ? parsePageRanges(candidate, pageCount)
      : candidate;

    if (!Array.isArray(group) || group.length === 0) {
      throw new TypeError(`El grupo ${groupIndex + 1} no contiene páginas.`);
    }

    const seen = new Set();
    return group.map((pageIndex) => {
      if (
        !Number.isSafeInteger(pageIndex)
        || pageIndex < 0
        || pageIndex >= pageCount
      ) {
        throw new RangeError(
          `El grupo ${groupIndex + 1} contiene un índice de página inválido.`,
        );
      }
      if (seen.has(pageIndex)) {
        throw new RangeError(
          `El grupo ${groupIndex + 1} contiene páginas duplicadas.`,
        );
      }
      seen.add(pageIndex);
      return pageIndex;
    });
  });
}

/**
 * Converts human page ranges (one-based) such as "1-3, 7, 10" to unique,
 * zero-based page indices while preserving the order written by the user.
 */
export function parsePageRanges(value, pageCount) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new RangeError("El número total de páginas debe ser un entero positivo.");
  }

  const text = String(value ?? "")
    .replace(/[–—]/gu, "-")
    .trim();
  if (!text) {
    throw new TypeError("Escribe al menos una página o rango.");
  }

  const result = [];
  const seen = new Set();
  for (const rawSegment of text.split(",")) {
    const segment = rawSegment.trim();
    const match = /^(\d+)\s*(?:-\s*(\d+))?$/u.exec(segment);
    if (!match) {
      throw new TypeError(`El rango "${segment || rawSegment}" no es válido.`);
    }

    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    if (
      !Number.isSafeInteger(first)
      || !Number.isSafeInteger(last)
      || first < 1
      || last > pageCount
    ) {
      throw new RangeError(
        `Las páginas deben estar entre 1 y ${pageCount}.`,
      );
    }
    if (first > last) {
      throw new RangeError(`El rango ${first}-${last} está invertido.`);
    }

    for (let pageNumber = first; pageNumber <= last; pageNumber += 1) {
      const pageIndex = pageNumber - 1;
      if (!seen.has(pageIndex)) {
        seen.add(pageIndex);
        result.push(pageIndex);
      }
    }
  }
  return result;
}

export async function inspectPdfFeatures(input) {
  const pdfDocument = await loadPdf(input);
  return inspectLoadedPdf(pdfDocument);
}

/** Reorders a PDF in place at the page-tree level to preserve AcroForms. */
export async function reorderPdfPages(input, order, options = {}) {
  const onProgress = progressCallback(options);
  const pdfDocument = await loadPdf(input);
  const features = inspectLoadedPdf(pdfDocument);
  assertTransformable(features, {
    allowForms: true,
    operation: "ordenar",
  });
  const validatedOrder = validatePageOrder(order, features.pageCount);
  await reportProgress(onProgress, "reorder", "loaded", 0, features.pageCount);

  await rebuildPageTree(pdfDocument, validatedOrder, (completed, total) => (
    reportProgress(onProgress, "reorder", "pages", completed, total)
  ));

  const output = await pdfDocument.save(SAVE_OPTIONS);
  await reportProgress(
    onProgress,
    "reorder",
    "complete",
    validatedOrder.length,
    validatedOrder.length,
  );
  return output instanceof Uint8Array ? output : new Uint8Array(output);
}

/**
 * Builds an ordered PDF from base and optional external sources. A base-only
 * composition keeps the original page objects (and ordinary AcroForms). Once
 * external pages are present, every source must be a plain PDF because
 * pdf-lib.copyPages() cannot safely transfer an AcroForm field tree.
 */
export async function composePdfPages(inputs, order, options = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new TypeError("Selecciona al menos un PDF de origen.");
  }
  const onProgress = progressCallback(options);
  const sourceDocuments = [];
  const sourceFeatures = [];
  const sourceData = [];

  for (let sourceIndex = 0; sourceIndex < inputs.length; sourceIndex += 1) {
    const bytes = sourceBytes(inputs[sourceIndex], sourceIndex);
    const pdfDocument = await loadPdf(bytes, `PDF ${sourceIndex + 1}`);
    const features = inspectLoadedPdf(pdfDocument);
    if (features.pageCount < 1) {
      throw new RangeError(`El PDF ${sourceIndex + 1} no contiene páginas.`);
    }
    sourceData.push(bytes);
    sourceDocuments.push(pdfDocument);
    sourceFeatures.push(features);
  }

  const normalizedOrder = normalizeCompositionOrder(
    order,
    sourceFeatures.map(({ pageCount }) => pageCount),
  );
  const baseOnly = normalizedOrder.every(({ sourceIndex }) => sourceIndex === 0);

  if (baseOnly) {
    const baseFeatures = sourceFeatures[0];
    assertTransformable(baseFeatures, {
      allowForms: true,
      operation: "ordenar",
    });
    const baseOrder = normalizedOrder.map(({ pageIndex }) => pageIndex);
    const retainedPages = new Set(baseOrder);
    const deletedPages = Array.from(
      { length: baseFeatures.pageCount },
      (_, pageIndex) => pageIndex,
    ).filter((pageIndex) => !retainedPages.has(pageIndex));

    let baseDocument = sourceDocuments[0];
    let compactOrder = baseOrder;
    if (deletedPages.length > 0 && baseFeatures.formFieldCount > 0) {
      // Reuse the engine's tested widget pruning before removing form pages.
      const { createEditedPdf } = await import("./pdf-engine.js");
      const prunedBytes = await createEditedPdf(sourceData[0], { deletedPages });
      baseDocument = await loadPdf(prunedBytes, "PDF base");
      const naturalRetainedOrder = Array.from(
        { length: baseFeatures.pageCount },
        (_, pageIndex) => pageIndex,
      ).filter((pageIndex) => retainedPages.has(pageIndex));
      compactOrder = baseOrder.map((pageIndex) => (
        naturalRetainedOrder.indexOf(pageIndex)
      ));
    }

    await rebuildPageTree(baseDocument, compactOrder, (completed, total) => (
      reportProgress(onProgress, "compose", "pages", completed, total)
    ));
    const output = await baseDocument.save(SAVE_OPTIONS);
    await reportProgress(
      onProgress,
      "compose",
      "complete",
      normalizedOrder.length,
      normalizedOrder.length,
    );
    return output instanceof Uint8Array ? output : new Uint8Array(output);
  }

  for (const features of sourceFeatures) {
    assertTransformable(features, {
      allowForms: false,
      operation: "combinar",
    });
  }

  const outputDocument = await PDFDocument.create({ updateMetadata: false });
  const copiedPages = new Array(normalizedOrder.length);
  for (let sourceIndex = 0; sourceIndex < sourceDocuments.length; sourceIndex += 1) {
    const positions = [];
    const pageIndices = [];
    for (let position = 0; position < normalizedOrder.length; position += 1) {
      if (normalizedOrder[position].sourceIndex === sourceIndex) {
        positions.push(position);
        pageIndices.push(normalizedOrder[position].pageIndex);
      }
    }
    if (pageIndices.length === 0) continue;

    const pages = await outputDocument.copyPages(
      sourceDocuments[sourceIndex],
      pageIndices,
    );
    for (let index = 0; index < pages.length; index += 1) {
      copiedPages[positions[index]] = pages[index];
    }
  }

  for (let position = 0; position < copiedPages.length; position += 1) {
    outputDocument.addPage(copiedPages[position]);
    await reportProgress(
      onProgress,
      "compose",
      "pages",
      position + 1,
      copiedPages.length,
    );
  }

  const output = await outputDocument.save(SAVE_OPTIONS);
  await reportProgress(
    onProgress,
    "compose",
    "complete",
    copiedPages.length,
    copiedPages.length,
  );
  return output instanceof Uint8Array ? output : new Uint8Array(output);
}

/** Merges plain PDFs. Interactive/XFA/signature fields are rejected safely. */
export async function mergePdfFiles(inputs, options = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new TypeError("Selecciona al menos un PDF para unir.");
  }
  const onProgress = progressCallback(options);
  const outputDocument = await PDFDocument.create({ updateMetadata: false });

  for (let sourceIndex = 0; sourceIndex < inputs.length; sourceIndex += 1) {
    const bytes = sourceBytes(inputs[sourceIndex], sourceIndex);
    const sourceDocument = await loadPdf(bytes, `PDF ${sourceIndex + 1}`);
    const features = inspectLoadedPdf(sourceDocument);
    assertTransformable(features, {
      allowForms: false,
      operation: "unir",
    });
    if (features.pageCount < 1) {
      throw new RangeError(`El PDF ${sourceIndex + 1} no contiene páginas.`);
    }

    const copiedPages = await outputDocument.copyPages(
      sourceDocument,
      sourceDocument.getPageIndices(),
    );
    for (const page of copiedPages) outputDocument.addPage(page);
    await reportProgress(
      onProgress,
      "merge",
      "files",
      sourceIndex + 1,
      inputs.length,
    );
  }

  const output = await outputDocument.save(SAVE_OPTIONS);
  await reportProgress(onProgress, "merge", "complete", inputs.length, inputs.length);
  return output instanceof Uint8Array ? output : new Uint8Array(output);
}

/**
 * Splits a PDF sequentially while preserving ordinary AcroForms. Groups contain
 * zero-based page indices, or
 * one-based range strings accepted by parsePageRanges(). The generator applies
 * backpressure: it does not build the next PDF until the current result has
 * been consumed, so callers can write each Uint8Array without retaining every
 * output in memory.
 */
export async function* splitPdfSequential(input, groups, options = {}) {
  const onProgress = progressCallback(options);
  const sourceDocument = await loadPdf(input);
  const features = inspectLoadedPdf(sourceDocument);
  assertTransformable(features, {
    allowForms: true,
    operation: "dividir",
  });
  const normalizedGroups = normalizeGroups(groups, features.pageCount);

  for (let groupIndex = 0; groupIndex < normalizedGroups.length; groupIndex += 1) {
    let output;
    if (features.formFieldCount > 0) {
      // Keep the original page objects and prune widgets from removed pages.
      // copyPages() alone would leave the AcroForm field tree behind.
      output = await composePdfPages(
        [input],
        normalizedGroups[groupIndex].map((pageIndex) => ({
          sourceIndex: 0,
          pageIndex,
        })),
      );
    } else {
      const outputDocument = await PDFDocument.create({ updateMetadata: false });
      const pages = await outputDocument.copyPages(
        sourceDocument,
        normalizedGroups[groupIndex],
      );
      for (const page of pages) outputDocument.addPage(page);
      output = await outputDocument.save(SAVE_OPTIONS);
    }
    await reportProgress(
      onProgress,
      "split",
      "groups",
      groupIndex + 1,
      normalizedGroups.length,
    );
    yield output instanceof Uint8Array ? output : new Uint8Array(output);
  }

  await reportProgress(
    onProgress,
    "split",
    "complete",
    normalizedGroups.length,
    normalizedGroups.length,
  );
}

/**
 * Compatibility helper that collects splitPdfSequential() into an array.
 * Prefer the generator when outputs can be saved or uploaded one at a time.
 */
export async function splitPdf(input, groups, options = {}) {
  const outputs = [];
  for await (const output of splitPdfSequential(input, groups, options)) {
    outputs.push(output);
  }
  return outputs;
}

/**
 * Performs structural, lossless optimization. If rewriting does not make the
 * file smaller, an exact copy of the original bytes is returned.
 */
export async function optimizePdf(input, options = {}) {
  const onProgress = progressCallback(options);
  const original = normalizeBytes(input);
  const pdfDocument = await loadPdf(original);
  const features = inspectLoadedPdf(pdfDocument);
  assertTransformable(features, {
    allowForms: true,
    operation: "optimizar",
  });
  await reportProgress(onProgress, "optimize", "loaded", 0, 1);

  const candidate = await pdfDocument.save(SAVE_OPTIONS);
  const candidateBytes = candidate instanceof Uint8Array
    ? candidate
    : new Uint8Array(candidate);
  const output = candidateBytes.byteLength < original.byteLength
    ? candidateBytes
    // The source is already an immutable input from this function's point of
    // view. Reusing it avoids allocating a third full-document buffer while
    // both the source and the rewritten candidate are still live.
    : original;

  await reportProgress(onProgress, "optimize", "complete", 1, 1);
  return output;
}

function normalizedPageSize(pageSize, imageWidth, imageHeight, margin) {
  if (pageSize === undefined || pageSize === "image") {
    const maximumImageDimension = Math.max(1, MAX_PDF_PAGE_DIMENSION - margin * 2);
    const scale = Math.min(
      1,
      maximumImageDimension / Math.max(imageWidth, imageHeight, 1),
    );
    return [
      Math.max(1, imageWidth * scale + margin * 2),
      Math.max(1, imageHeight * scale + margin * 2),
    ];
  }

  if (pageSize === "a4") {
    return imageWidth > imageHeight
      ? [A4_SIZE[1], A4_SIZE[0]]
      : [...A4_SIZE];
  }

  if (
    Array.isArray(pageSize)
    && pageSize.length === 2
    && pageSize.every(
      (dimension) => Number.isFinite(dimension)
        && dimension > 0
        && dimension <= MAX_PDF_PAGE_DIMENSION,
    )
  ) {
    return [Number(pageSize[0]), Number(pageSize[1])];
  }

  throw new RangeError(
    'pageSize debe ser "image", "a4" o un arreglo [ancho, alto] válido.',
  );
}

/** Converts one or more JPG images to a local PDF, one image per page. */
export async function jpgImagesToPdf(images, options = {}) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new TypeError("Selecciona al menos una imagen JPG.");
  }
  const onProgress = progressCallback(options);
  const margin = options.margin === undefined ? 0 : Number(options.margin);
  if (!Number.isFinite(margin) || margin < 0 || margin >= MAX_PDF_PAGE_DIMENSION / 2) {
    throw new RangeError("El margen de página no es válido.");
  }

  const pdfDocument = await PDFDocument.create({ updateMetadata: false });
  for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
    // pdf-lib 1.17 reads JPEG markers from the start of the backing buffer,
    // so pooled Node buffers and sliced typed arrays must first become exact.
    const bytes = exactBytes(sourceBytes(images[imageIndex], imageIndex, "JPG"));
    let image;
    try {
      image = await pdfDocument.embedJpg(bytes);
    } catch (error) {
      throw new Error(
        `La imagen ${imageIndex + 1} no es un archivo JPG válido.`,
        { cause: error },
      );
    }

    const [pageWidth, pageHeight] = normalizedPageSize(
      options.pageSize,
      image.width,
      image.height,
      margin,
    );
    const availableWidth = pageWidth - margin * 2;
    const availableHeight = pageHeight - margin * 2;
    if (availableWidth <= 0 || availableHeight <= 0) {
      throw new RangeError("El margen no deja espacio para colocar la imagen.");
    }
    const scale = Math.min(
      availableWidth / image.width,
      availableHeight / image.height,
    );
    const width = image.width * scale;
    const height = image.height * scale;
    const page = pdfDocument.addPage([pageWidth, pageHeight]);
    page.drawImage(image, {
      x: (pageWidth - width) / 2,
      y: (pageHeight - height) / 2,
      width,
      height,
    });

    await reportProgress(
      onProgress,
      "jpg-to-pdf",
      "images",
      imageIndex + 1,
      images.length,
    );
  }

  const output = await pdfDocument.save(SAVE_OPTIONS);
  await reportProgress(onProgress, "jpg-to-pdf", "complete", images.length, images.length);
  return output instanceof Uint8Array ? output : new Uint8Array(output);
}
