import {
  degrees,
  LineCapStyle,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFTextField,
  PDFWidgetAnnotation,
  StandardFonts,
  rgb,
} from 'pdf-lib';

const MAX_ANNOTATIONS = 10_000;
const MAX_TEXT_LENGTH = 4_096;
const MAX_INK_POINTS = 20_000;
const MAX_COORDINATE = 1_000_000;

const DEFAULTS = Object.freeze({
  textColor: '#111827',
  textSize: 14,
  highlightColor: '#fde047',
  highlightOpacity: 0.35,
  inkColor: '#2563eb',
  inkOpacity: 0.9,
  inkWidth: 2,
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteNumber(value, fallback, minimum, maximum) {
  const parsed = typeof value === 'string' && value.trim() !== ''
    ? Number(value)
    : value;

  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    return fallback;
  }

  return clamp(parsed, minimum, maximum);
}

function normalizePageIndex(value, pageCount) {
  const parsed = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value)
    : value;

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }

  if (Number.isInteger(pageCount) && parsed >= pageCount) {
    return null;
  }

  return parsed;
}

function normalizeHexColor(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }

  let hex = value.trim().toLowerCase();
  if (hex.startsWith('#')) {
    hex = hex.slice(1);
  }

  if (/^[0-9a-f]{3}$/.test(hex)) {
    hex = [...hex].map((character) => character.repeat(2)).join('');
  }

  return /^[0-9a-f]{6}$/.test(hex) ? `#${hex}` : fallback;
}

function toPdfColor(hex) {
  return rgb(
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  );
}

function sanitizeText(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return Array.from(String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/\0/g, '')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''))
    .slice(0, MAX_TEXT_LENGTH)
    .join('');
}

function normalizePoint(rawPoint) {
  const x = Array.isArray(rawPoint) ? rawPoint[0] : rawPoint?.x;
  const y = Array.isArray(rawPoint) ? rawPoint[1] : rawPoint?.y;
  const parsedX = finiteNumber(x, Number.NaN, -MAX_COORDINATE, MAX_COORDINATE);
  const parsedY = finiteNumber(y, Number.NaN, -MAX_COORDINATE, MAX_COORDINATE);

  return Number.isFinite(parsedX) && Number.isFinite(parsedY)
    ? { x: parsedX, y: parsedY }
    : null;
}

function normalizeText(raw, pageCount) {
  const pageIndex = normalizePageIndex(
    raw?.pageIndex ?? raw?.originalPageIndex ?? raw?.page,
    pageCount,
  );
  const text = sanitizeText(raw?.text ?? raw?.value);

  if (pageIndex === null || text.length === 0) {
    return null;
  }

  return {
    pageIndex,
    x: finiteNumber(raw?.x, 0, -MAX_COORDINATE, MAX_COORDINATE),
    y: finiteNumber(raw?.y, 0, -MAX_COORDINATE, MAX_COORDINATE),
    text,
    size: finiteNumber(raw?.size, DEFAULTS.textSize, 1, 512),
    color: normalizeHexColor(raw?.color, DEFAULTS.textColor),
  };
}

function normalizeHighlight(raw, pageCount) {
  const pageIndex = normalizePageIndex(
    raw?.pageIndex ?? raw?.originalPageIndex ?? raw?.page,
    pageCount,
  );
  let x = finiteNumber(raw?.x, 0, -MAX_COORDINATE, MAX_COORDINATE);
  let y = finiteNumber(raw?.y, 0, -MAX_COORDINATE, MAX_COORDINATE);
  let width = finiteNumber(raw?.width, 0, -MAX_COORDINATE, MAX_COORDINATE);
  let height = finiteNumber(raw?.height, 0, -MAX_COORDINATE, MAX_COORDINATE);

  if (pageIndex === null || width === 0 || height === 0) {
    return null;
  }

  if (width < 0) {
    x = clamp(x + width, -MAX_COORDINATE, MAX_COORDINATE);
    width = Math.abs(width);
  }
  if (height < 0) {
    y = clamp(y + height, -MAX_COORDINATE, MAX_COORDINATE);
    height = Math.abs(height);
  }

  return {
    pageIndex,
    x,
    y,
    width,
    height,
    color: normalizeHexColor(raw?.color, DEFAULTS.highlightColor),
    opacity: finiteNumber(raw?.opacity, DEFAULTS.highlightOpacity, 0, 1),
  };
}

function normalizeFormField(raw, pageCount) {
  const pageIndex = normalizePageIndex(
    raw?.pageIndex ?? raw?.originalPageIndex ?? raw?.page,
    pageCount,
  );
  let x = finiteNumber(raw?.x, 0, -MAX_COORDINATE, MAX_COORDINATE);
  let y = finiteNumber(raw?.y, 0, -MAX_COORDINATE, MAX_COORDINATE);
  let width = finiteNumber(raw?.width, 0, -MAX_COORDINATE, MAX_COORDINATE);
  let height = finiteNumber(raw?.height, 0, -MAX_COORDINATE, MAX_COORDINATE);

  if (width < 0) {
    x = clamp(x + width, -MAX_COORDINATE, MAX_COORDINATE);
    width = Math.abs(width);
  }
  if (height < 0) {
    y = clamp(y + height, -MAX_COORDINATE, MAX_COORDINATE);
    height = Math.abs(height);
  }
  if (pageIndex === null || width < 4 || height < 4) {
    return null;
  }

  const requestedName = String(
    raw?.fieldName ?? raw?.name ?? 'Campo rellenable',
  )
    .replace(/\0/g, '')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 128);

  return {
    pageIndex,
    x,
    y,
    width,
    height,
    fieldName: requestedName || 'Campo rellenable',
  };
}

function normalizeInk(raw, pageCount, remainingPoints) {
  const pageIndex = normalizePageIndex(
    raw?.pageIndex ?? raw?.originalPageIndex ?? raw?.page,
    pageCount,
  );
  const rawPoints = Array.isArray(raw?.points) ? raw.points : [];
  const points = [];

  for (const rawPoint of rawPoints) {
    if (points.length >= remainingPoints) {
      break;
    }
    const point = normalizePoint(rawPoint);
    if (point) {
      points.push(point);
    }
  }

  if (pageIndex === null || points.length === 0) {
    return null;
  }

  return {
    pageIndex,
    points,
    color: normalizeHexColor(raw?.color, DEFAULTS.inkColor),
    width: finiteNumber(raw?.width, DEFAULTS.inkWidth, 0.1, 256),
    opacity: finiteNumber(raw?.opacity, DEFAULTS.inkOpacity, 0, 1),
  };
}

function normalizeRotation(raw, pageCount) {
  const pageIndex = normalizePageIndex(
    raw?.pageIndex ?? raw?.originalPageIndex ?? raw?.page,
    pageCount,
  );
  const value = raw?.delta ?? raw?.rotation ?? raw?.angle;
  const parsed = typeof value === 'string' && value.trim() !== ''
    ? Number(value)
    : value;

  if (pageIndex === null || typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    return null;
  }

  // PDF page rotations are quarter turns. Round transient UI values and reduce
  // very large deltas before they reach the PDF object.
  const delta = ((Math.round(parsed / 90) * 90) % 360 + 360) % 360;
  return delta === 0 ? null : { pageIndex, delta };
}

function asList(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function rotationList(value) {
  if (value instanceof Map) {
    return [...value].map(([pageIndex, delta]) => ({ pageIndex, delta }));
  }
  if (Array.isArray(value)) {
    return value.map((entry) => (
      Array.isArray(entry)
        ? { pageIndex: entry[0], delta: entry[1] }
        : entry
    ));
  }
  if (value && typeof value === 'object' && value.pageIndex === undefined) {
    return Object.entries(value).map(([pageIndex, delta]) => ({ pageIndex, delta }));
  }
  return asList(value);
}

function deletionList(value) {
  if (value instanceof Set || Array.isArray(value)) {
    return [...value];
  }
  return value === undefined || value === null ? [] : [value];
}

function appendTypedOperation(operation, buckets) {
  const type = String(operation?.type ?? operation?.kind ?? '').toLowerCase();

  if (type === 'text') {
    buckets.texts.push(operation);
  } else if (type === 'highlight') {
    buckets.highlights.push(operation);
  } else if (type === 'formfield' || type === 'form-field' || type === 'field') {
    buckets.formFields.push(operation);
  } else if (type === 'ink') {
    buckets.inks.push(operation);
  } else if (type === 'rotate' || type === 'rotation') {
    buckets.rotations.push(operation);
  } else if (type === 'delete' || type === 'deletion') {
    buckets.deletedPages.push(
      operation?.pageIndex ?? operation?.originalPageIndex ?? operation?.page,
    );
  }
}

/**
 * Returns a bounded, canonical change set. Invalid/incomplete transient UI
 * operations are omitted; numeric and color values are normalized.
 */
export function validateChanges(changes = {}, pageCount) {
  if (
    pageCount !== undefined
    && (!Number.isSafeInteger(pageCount) || pageCount < 1)
  ) {
    throw new RangeError('pageCount must be a positive integer.');
  }

  if (
    changes === null
    || (typeof changes !== 'object' && !Array.isArray(changes))
  ) {
    throw new TypeError('changes must be an object or an operation array.');
  }

  const incoming = {
    texts: [],
    highlights: [],
    formFields: [],
    inks: [],
    rotations: [],
    deletedPages: [],
  };

  if (Array.isArray(changes)) {
    for (const operation of changes) {
      appendTypedOperation(operation, incoming);
    }
  } else {
    incoming.texts.push(...asList(changes.texts ?? changes.text));
    incoming.highlights.push(...asList(changes.highlights ?? changes.highlight));
    incoming.formFields.push(
      ...asList(changes.formFields ?? changes.formField ?? changes.fields),
    );
    incoming.inks.push(...asList(changes.inks ?? changes.ink));
    incoming.rotations.push(...rotationList(changes.rotations ?? changes.rotation));
    incoming.deletedPages.push(
      ...deletionList(changes.deletedPages ?? changes.deletions),
    );

    for (const operation of asList(
      changes.annotations ?? changes.operations ?? changes.edits,
    )) {
      appendTypedOperation(operation, incoming);
    }
  }

  const normalized = {
    texts: [],
    highlights: [],
    formFields: [],
    inks: [],
    rotations: [],
    deletedPages: [],
  };

  let annotationCount = 0;
  for (const raw of incoming.texts) {
    if (annotationCount >= MAX_ANNOTATIONS) break;
    const operation = normalizeText(raw, pageCount);
    if (operation) {
      normalized.texts.push(operation);
      annotationCount += 1;
    }
  }

  for (const raw of incoming.highlights) {
    if (annotationCount >= MAX_ANNOTATIONS) break;
    const operation = normalizeHighlight(raw, pageCount);
    if (operation) {
      normalized.highlights.push(operation);
      annotationCount += 1;
    }
  }

  for (const raw of incoming.formFields) {
    if (annotationCount >= MAX_ANNOTATIONS) break;
    const operation = normalizeFormField(raw, pageCount);
    if (operation) {
      normalized.formFields.push(operation);
      annotationCount += 1;
    }
  }

  let pointCount = 0;
  for (const raw of incoming.inks) {
    if (annotationCount >= MAX_ANNOTATIONS || pointCount >= MAX_INK_POINTS) break;
    const operation = normalizeInk(raw, pageCount, MAX_INK_POINTS - pointCount);
    if (operation) {
      normalized.inks.push(operation);
      pointCount += operation.points.length;
      annotationCount += 1;
    }
  }

  for (const raw of incoming.rotations.slice(0, MAX_ANNOTATIONS)) {
    const operation = normalizeRotation(raw, pageCount);
    if (operation) {
      normalized.rotations.push(operation);
    }
  }

  const uniqueDeletedPages = new Set();
  for (const rawPageIndex of incoming.deletedPages) {
    const pageIndex = normalizePageIndex(rawPageIndex, pageCount);
    if (pageIndex !== null) {
      uniqueDeletedPages.add(pageIndex);
    }
  }
  normalized.deletedPages = [...uniqueDeletedPages].sort((a, b) => b - a);

  return normalized;
}

function normalizeInputBytes(originalBytes) {
  if (originalBytes instanceof Uint8Array) {
    return originalBytes;
  }
  if (originalBytes instanceof ArrayBuffer) {
    return new Uint8Array(originalBytes);
  }
  if (ArrayBuffer.isView(originalBytes)) {
    return new Uint8Array(
      originalBytes.buffer,
      originalBytes.byteOffset,
      originalBytes.byteLength,
    );
  }
  throw new TypeError('originalBytes must be a Uint8Array or ArrayBuffer.');
}

function standardFontCanEncode(text, font) {
  try {
    for (const character of Array.from(text)) {
      if (character !== '\n' && character !== '\r' && character !== '\t') {
        font.encodeText(character);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function fontSafeText(text, font) {
  let result = '';
  const unsupported = new Set();
  for (const character of Array.from(text)) {
    if (character === '\n') {
      result += '\n';
      continue;
    }
    if (character === '\t') {
      result += '    ';
      continue;
    }
    try {
      font.encodeText(character);
      result += character;
    } catch {
      unsupported.add(character);
    }
  }
  if (unsupported.size) {
    throw new RangeError(
      'El texto añadido contiene caracteres que esta versión ligera no puede guardar '
      + '(por ejemplo, emoji, cirílico o CJK). Usa caracteres latinos.',
    );
  }
  return result;
}

function drawInk(page, operation) {
  const options = {
    color: toPdfColor(operation.color),
    opacity: operation.opacity,
  };

  if (operation.points.length === 1) {
    page.drawCircle({
      x: operation.points[0].x,
      y: operation.points[0].y,
      size: operation.width / 2,
      ...options,
    });
    return;
  }

  for (let index = 1; index < operation.points.length; index += 1) {
    page.drawLine({
      start: operation.points[index - 1],
      end: operation.points[index],
      thickness: operation.width,
      lineCap: LineCapStyle.Round,
      ...options,
    });
  }
}

/**
 * Regenerates normal appearance streams for edited AcroForm text fields.
 *
 * PDF.js writes the canonical field value correctly, but some PDF producers
 * place cloned Widget dictionaries in Page/Annots instead of the canonical
 * Kids referenced by the field tree. Updating both sets keeps the saved value
 * visible in readers that do not honor NeedAppearances.
 */
export async function refreshFormTextAppearances(originalBytes, fieldNames = []) {
  const bytes = normalizeInputBytes(originalBytes);
  const requestedNames = [...new Set(
    Array.from(fieldNames || []).filter(
      (fieldName) => typeof fieldName === 'string' && fieldName.length > 0,
    ),
  )];
  if (bytes.byteLength === 0 || requestedNames.length === 0) {
    return bytes.slice();
  }

  const pdfDocument = await PDFDocument.load(bytes, { updateMetadata: false });
  const acroForm = pdfDocument.catalog.lookupMaybe(
    PDFName.of('AcroForm'),
    PDFDict,
  );
  // pdf-lib cannot preserve XFA. Leave hybrid/XFA documents untouched and let
  // their reader regenerate appearances from NeedAppearances instead.
  if (!acroForm || acroForm.has(PDFName.of('XFA'))) {
    return bytes.slice();
  }

  const form = pdfDocument.getForm();
  const textFields = requestedNames
    .map((fieldName) => form.getFieldMaybe(fieldName))
    .filter((field) => field instanceof PDFTextField);
  if (textFields.length === 0) {
    return bytes.slice();
  }

  const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
  const subtypeName = PDFName.of('Subtype');
  const widgetName = PDFName.of('Widget');
  const parentName = PDFName.of('Parent');
  let refreshedFieldCount = 0;

  for (const field of textFields) {
    let value;
    try {
      value = field.getText() || '';
    } catch {
      continue;
    }
    if (!standardFontCanEncode(value, font)) continue;

    const canonicalWidgets = new Set(
      field.acroField.getWidgets().map((widget) => widget.dict),
    );
    field.updateAppearances(font);

    for (const page of pdfDocument.getPages()) {
      const annotations = page.node.Annots();
      if (!annotations) continue;

      for (let index = 0; index < annotations.size(); index += 1) {
        const annotation = pdfDocument.context.lookupMaybe(
          annotations.get(index),
          PDFDict,
        );
        if (
          !annotation
          || canonicalWidgets.has(annotation)
          || annotation.get(subtypeName) !== widgetName
        ) {
          continue;
        }

        const parent = pdfDocument.context.lookupMaybe(
          annotation.get(parentName),
          PDFDict,
        );
        if (parent !== field.acroField.dict) continue;

        field.updateWidgetAppearance(
          PDFWidgetAnnotation.fromDict(annotation),
          font,
        );
      }
    }
    refreshedFieldCount += 1;
  }

  if (refreshedFieldCount === 0) {
    return bytes.slice();
  }

  const output = await pdfDocument.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: true,
  });
  return output instanceof Uint8Array ? output : new Uint8Array(output);
}

function removeDeletedPageFormWidgets(pdfDocument, deletedPages) {
  if (deletedPages.size === 0) return;

  const acroForm = pdfDocument.catalog.lookupMaybe(
    PDFName.of('AcroForm'),
    PDFDict,
  );
  // Avoid invoking PDFDocument#getForm for XFA because pdf-lib removes XFA.
  if (!acroForm || acroForm.has(PDFName.of('XFA'))) return;

  const subtypeName = PDFName.of('Subtype');
  const widgetName = PDFName.of('Widget');
  const parentName = PDFName.of('Parent');
  const removedPageRefs = new Set();
  const removedAnnotationRefs = new Set();
  const retainedAnnotationRefs = new Set();
  const pagePresenceByField = new Map();
  const pages = pdfDocument.getPages();

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    const isRemoved = deletedPages.has(pageIndex);
    if (isRemoved) removedPageRefs.add(page.ref.toString());
    const annotations = page.node.Annots();
    if (!annotations) continue;

    for (let index = 0; index < annotations.size(); index += 1) {
      const annotationObject = annotations.get(index);
      const annotationRef = pdfDocument.context.getObjectRef(
        pdfDocument.context.lookup(annotationObject),
      );
      const annotation = pdfDocument.context.lookupMaybe(
        annotationObject,
        PDFDict,
      );
      if (!annotation || annotation.get(subtypeName) !== widgetName) continue;

      if (annotationRef) {
        (isRemoved ? removedAnnotationRefs : retainedAnnotationRefs)
          .add(annotationRef.toString());
      }
      const owner = pdfDocument.context.lookupMaybe(
        annotation.get(parentName) || annotationObject,
        PDFDict,
      );
      if (!owner) continue;
      const presence = pagePresenceByField.get(owner) || {
        removed: false,
        retained: false,
      };
      presence[isRemoved ? 'removed' : 'retained'] = true;
      pagePresenceByField.set(owner, presence);
    }
  }

  const form = pdfDocument.getForm();
  for (const field of form.getFields()) {
    const presence = pagePresenceByField.get(field.acroField.dict);
    if (presence?.removed && !presence.retained) {
      form.acroForm.removeField(field.acroField);
      continue;
    }

    const widgets = field.acroField.getWidgets();
    const removedWidgetIndices = [];
    for (let index = 0; index < widgets.length; index += 1) {
      const widget = widgets[index];
      const widgetRef = pdfDocument.context.getObjectRef(widget.dict);
      const widgetRefKey = widgetRef?.toString();
      const pageRefKey = widget.P()?.toString();
      if (
        (widgetRefKey && retainedAnnotationRefs.has(widgetRefKey))
        || (!removedPageRefs.has(pageRefKey) && !removedAnnotationRefs.has(widgetRefKey))
      ) {
        continue;
      }
      removedWidgetIndices.push(index);
    }

    for (let index = removedWidgetIndices.length - 1; index >= 0; index -= 1) {
      field.acroField.removeWidget(removedWidgetIndices[index]);
    }
    if (field.acroField.getWidgets().length === 0) {
      form.acroForm.removeField(field.acroField);
    }
  }
}

function clippedFormFieldRectangle(operation, page) {
  const cropBox = page.getCropBox();
  const left = Math.max(operation.x, cropBox.x);
  const bottom = Math.max(operation.y, cropBox.y);
  const right = Math.min(
    operation.x + operation.width,
    cropBox.x + cropBox.width,
  );
  const top = Math.min(
    operation.y + operation.height,
    cropBox.y + cropBox.height,
  );
  const width = right - left;
  const height = top - bottom;
  return width >= 4 && height >= 4
    ? { x: left, y: bottom, width, height }
    : null;
}

function nextFormFieldName(usedRootNames, counter) {
  let fieldNumber = counter;
  let candidate;
  do {
    candidate = `FolentraPDF_Campo_${fieldNumber}`;
    fieldNumber += 1;
  } while (usedRootNames.has(candidate));
  usedRootNames.add(candidate);
  return { fieldName: candidate, nextCounter: fieldNumber };
}

function ensureAcroFormFontResource(pdfDocument, form, font) {
  const defaultResourcesName = PDFName.of('DR');
  const fontsName = PDFName.of('Font');
  let defaultResources = form.acroForm.dict.lookupMaybe(
    defaultResourcesName,
    PDFDict,
  );
  if (!defaultResources) {
    defaultResources = pdfDocument.context.obj({});
    form.acroForm.dict.set(defaultResourcesName, defaultResources);
  }
  let fonts = defaultResources.lookupMaybe(fontsName, PDFDict);
  if (!fonts) {
    fonts = pdfDocument.context.obj({});
    defaultResources.set(fontsName, fonts);
  }
  const fontName = PDFName.of(font.name);
  if (!fonts.has(fontName)) {
    fonts.set(fontName, font.ref);
  }
}

async function addAcroFormTextFields(
  pdfDocument,
  operations,
  deletedPages,
  font,
) {
  const activeOperations = operations
    .filter(({ pageIndex }) => !deletedPages.has(pageIndex))
    .map((operation) => {
      const page = pdfDocument.getPage(operation.pageIndex);
      return {
        page,
        rectangle: clippedFormFieldRectangle(operation, page),
      };
    })
    .filter(({ rectangle }) => rectangle !== null);
  if (activeOperations.length === 0) return;

  const acroForm = pdfDocument.catalog.lookupMaybe(
    PDFName.of('AcroForm'),
    PDFDict,
  );
  if (acroForm?.has(PDFName.of('XFA'))) {
    throw new Error(
      'Este PDF usa un formulario XFA. No se pueden añadir campos AcroForm '
      + 'sin eliminar su formulario original.',
    );
  }

  const form = pdfDocument.getForm();
  ensureAcroFormFontResource(pdfDocument, form, font);
  const usedRootNames = new Set(
    form.acroForm
      .getFields()
      .map(([field]) => field.getPartialName())
      .filter(Boolean),
  );
  let fieldCounter = 1;
  for (const { page, rectangle } of activeOperations) {
    const allocation = nextFormFieldName(usedRootNames, fieldCounter);
    fieldCounter = allocation.nextCounter;
    const fieldName = allocation.fieldName;
    const field = form.createTextField(fieldName);
    field.acroField.dict.set(
      PDFName.of('TU'),
      PDFHexString.fromText('Campo rellenable'),
    );
    const borderWidth = 1;
    field.addToPage(page, {
      x: rectangle.x + borderWidth / 2,
      y: rectangle.y + borderWidth / 2,
      width: rectangle.width - borderWidth,
      height: rectangle.height - borderWidth,
      font,
      textColor: rgb(0.07, 0.08, 0.07),
      backgroundColor: undefined,
      borderColor: rgb(0.14, 0.4, 0.33),
      borderWidth,
      rotate: degrees(0),
    });
    field.setFontSize(clamp(rectangle.height - 4, 4, 12));
    field.updateAppearances(font);
  }
}

/**
 * Applies edits against original (pre-deletion) page indices and returns a new
 * PDF byte array. The source byte array is never modified.
 */
export async function createEditedPdf(originalBytes, changes = {}) {
  const bytes = normalizeInputBytes(originalBytes);
  if (bytes.byteLength === 0) {
    throw new TypeError('originalBytes cannot be empty.');
  }

  // updateMetadata:false keeps the source information dictionary intact.
  const pdfDocument = await PDFDocument.load(bytes, { updateMetadata: false });
  const pageCount = pdfDocument.getPageCount();
  if (pageCount < 1) {
    throw new RangeError('The source PDF must contain at least one page.');
  }

  const validated = validateChanges(changes, pageCount);
  if (validated.deletedPages.length >= pageCount) {
    throw new RangeError('An edited PDF must retain at least one page.');
  }

  const deletedPages = new Set(validated.deletedPages);
  removeDeletedPageFormWidgets(pdfDocument, deletedPages);
  const drawableTexts = validated.texts.filter(
    ({ pageIndex }) => !deletedPages.has(pageIndex),
  );
  const hasNewFormFields = validated.formFields.some(
    ({ pageIndex }) => !deletedPages.has(pageIndex),
  );
  const font = drawableTexts.length > 0 || hasNewFormFields
    ? await pdfDocument.embedFont(StandardFonts.Helvetica)
    : null;
  const encodedTexts = drawableTexts.map((operation) => ({
    ...operation,
    text: fontSafeText(operation.text, font),
  }));

  for (const operation of validated.highlights) {
    if (deletedPages.has(operation.pageIndex)) continue;
    pdfDocument.getPage(operation.pageIndex).drawRectangle({
      x: operation.x,
      y: operation.y,
      width: operation.width,
      height: operation.height,
      color: toPdfColor(operation.color),
      opacity: operation.opacity,
      borderWidth: 0,
    });
  }

  for (const operation of validated.inks) {
    if (deletedPages.has(operation.pageIndex)) continue;
    drawInk(pdfDocument.getPage(operation.pageIndex), operation);
  }

  for (const operation of encodedTexts) {
    pdfDocument.getPage(operation.pageIndex).drawText(
      operation.text,
      {
        x: operation.x,
        y: operation.y,
        size: operation.size,
        color: toPdfColor(operation.color),
        font,
        lineHeight: operation.size * 1.2,
      },
    );
  }

  await addAcroFormTextFields(
    pdfDocument,
    validated.formFields,
    deletedPages,
    font,
  );

  for (const operation of validated.rotations) {
    if (deletedPages.has(operation.pageIndex)) continue;
    const page = pdfDocument.getPage(operation.pageIndex);
    const currentAngle = page.getRotation().angle;
    const angle = ((currentAngle + operation.delta) % 360 + 360) % 360;
    page.setRotation(degrees(angle));
  }

  // Indices refer to the original document, so removals must run high-to-low.
  for (const pageIndex of validated.deletedPages) {
    pdfDocument.removePage(pageIndex);
  }

  const output = await pdfDocument.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: true,
  });
  return output instanceof Uint8Array ? output : new Uint8Array(output);
}
