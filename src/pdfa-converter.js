import { pdfToJpegPages } from "./conversion-tools.js";

const PDF_A4_PART = 4;
const PDF_A4_REVISION = 2020;
const DEFAULT_SCALE = 2;
const DEFAULT_QUALITY = 0.94;
const MAX_PDF_NUMBER = 1_000_000_000;
const TEXT_ENCODER = new TextEncoder();

// sRGB-v2-micro.icc from saucecontrol/Compact-ICC-Profiles. The profile is
// released under CC0-1.0 and is intentionally embedded to keep conversion
// local and independent of operating-system colour-profile paths.
// Source: https://github.com/saucecontrol/Compact-ICC-Profiles
const SRGB_V2_MICRO_BASE64 =
  "AAAByGxjbXMCEAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5knZEAPUCAsD1AdCyBnqUijgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJZGVzYwAAAPAAAABfY3BydAAAAQwAAAAMd3RwdAAAARgAAAAUclhZWgAAASwAAAAUZ1hZWgAAAUAAAAAUYlhZWgAAAVQAAAAUclRSQwAAAWgAAABgZ1RSQwAAAWgAAABgYlRSQwAAAWgAAABgZGVzYwAAAAAAAAAFdVJHQgAAAAAAAAAAAAAAAHRleHQAAAAAQ0MwAFhZWiAAAAAAAADzVAABAAAAARbJWFlaIAAAAAAAAG+gAAA48gAAA49YWVogAAAAAAAAYpYAALeJAAAY2lhZWiAAAAAAAAAkoAAAD4UAALbEY3VydgAAAAAAAAAqAAAAfAD4AZwCdQODBMkGTggSChgMYg70Ec8U9hhqHC4gQySsKWoufjPrObM/1kZXTTZUdlwXZB1shnVWfo2ILJI2nKunjLLbvpnKx9dl5Hfx+f//";

/**
 * Deliberate trade-offs of the lightweight converter.
 *
 * Rasterising is the only dependable browser-local way to eliminate fonts,
 * JavaScript, actions, multimedia, encryption, external resources and other
 * arbitrary source constructs without pretending that a metadata tag alone
 * makes an unknown input conformant. It preserves the rendered appearance,
 * but the output is an archival visual copy rather than an editable clone.
 */
export const PDF_A4_CONVERSION_LIMITATIONS = Object.freeze([
  "El texto se conserva visualmente, pero deja de ser seleccionable o editable.",
  "Los formularios, enlaces, comentarios, adjuntos y contenido multimedia se aplanan.",
  "Las firmas digitales del original no se transfieren a la copia de archivo.",
  "La conversión crea una copia visual sRGB; no preserva tintas directas ni perfiles CMYK originales.",
]);

export const PDF_A4_IMPLEMENTATION = Object.freeze({
  standard: "ISO 19005-4:2020",
  profile: "PDF/A-4",
  pdfVersion: "2.0",
  validationProfile: "veraPDF PDF/A-4",
  validationDocumentation: "https://docs.verapdf.org/cli/validation/",
  colourProfile: "sRGB-v2-micro.icc (CC0-1.0)",
  externalRuntimeDependencies: Object.freeze([]),
});

function base64ToBytes(value) {
  if (typeof globalThis.atob !== "function") {
    throw new Error("El entorno no puede cargar el perfil de color sRGB incluido.");
  }
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const SRGB_PROFILE_BYTES = base64ToBytes(SRGB_V2_MICRO_BASE64);

function requirePdfDocument(pdfDocument) {
  const pageCount = Number(pdfDocument?.numPages);
  if (!Number.isInteger(pageCount) || pageCount < 1 || typeof pdfDocument.getPage !== "function") {
    throw new TypeError("Se necesita un documento PDF abierto con al menos una página.");
  }
  return pageCount;
}

function normalizedTitle(value) {
  const title = String(value ?? "Copia de archivo PDF/A-4").trim();
  return title || "Copia de archivo PDF/A-4";
}

function normalizedDate(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("La fecha de conversión no es válida.");
  }
  return date.toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function xmlText(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function pdfString(value) {
  const utf16 = [];
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0xffff) {
      utf16.push(codePoint);
    } else {
      const adjusted = codePoint - 0x10000;
      utf16.push(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
    }
  }
  return `<FEFF${utf16.map((unit) => unit.toString(16).padStart(4, "0")).join("").toUpperCase()}>`;
}

function pdfNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number >= MAX_PDF_NUMBER) {
    throw new RangeError("La página tiene dimensiones que no se pueden representar en PDF.");
  }
  return Number(number.toFixed(4)).toString();
}

function concatBytes(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function ascii(value) {
  return TEXT_ENCODER.encode(String(value));
}

function streamObjectChunks(dictionary, bytes) {
  // Keep the encoded stream as a separate chunk. In particular, JPEG page
  // data can be tens or hundreds of megabytes; copying it into an object body
  // and then copying that body again would multiply peak memory needlessly.
  return [
    ascii(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`),
    bytes,
    ascii("\nendstream"),
  ];
}

function makeXmp({ title, timestamp }) {
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Folentra PDF">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>${PDF_A4_PART}</pdfaid:part>
      <pdfaid:rev>${PDF_A4_REVISION}</pdfaid:rev>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:format>application/pdf</dc:format>
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlText(title)}</rdf:li></rdf:Alt></dc:title>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreatorTool>Folentra PDF</xmp:CreatorTool>
      <xmp:CreateDate>${timestamp}</xmp:CreateDate>
      <xmp:ModifyDate>${timestamp}</xmp:ModifyDate>
      <xmp:MetadataDate>${timestamp}</xmp:MetadataDate>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>Folentra PDF - Xihuitl Systems</pdf:Producer>
      <pdf:PDFVersion>2.0</pdf:PDFVersion>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

function simpleDocumentId(images, title) {
  // A deterministic 128-bit non-cryptographic identifier. PDF file IDs are
  // identifiers, not security primitives; avoiding randomness also makes
  // archival output reproducible when the timestamp is supplied by a caller.
  const state = Uint32Array.from([0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]);
  const update = (byte) => {
    for (let index = 0; index < state.length; index += 1) {
      state[index] ^= (byte + index * 37) & 0xff;
      state[index] = Math.imul(state[index], 0x01000193 + index * 2) >>> 0;
      state[index] = (state[index] << (index + 3) | state[index] >>> (29 - index)) >>> 0;
    }
  };
  for (const byte of TEXT_ENCODER.encode(title)) update(byte);
  for (const image of images) {
    update(image.width & 0xff);
    update(image.height & 0xff);
    update(image.bytes.length & 0xff);
    const stride = Math.max(1, Math.floor(image.bytes.length / 256));
    for (let index = 0; index < image.bytes.length; index += stride) update(image.bytes[index]);
  }
  return Array.from(state)
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("")
    .toUpperCase();
}

function buildPdfA4(images, { title, timestamp }) {
  const catalogObject = 1;
  const pagesObject = 2;
  const metadataObject = 3;
  const iccObject = 4;
  const outputIntentObject = 5;
  const objectCount = outputIntentObject + images.length * 3;
  const objects = new Array(objectCount + 1);
  const pageReferences = [];

  for (let index = 0; index < images.length; index += 1) {
    const pageObject = 6 + index * 3;
    const imageObject = pageObject + 1;
    const contentObject = pageObject + 2;
    const image = images[index];
    const width = pdfNumber(image.pageWidth);
    const height = pdfNumber(image.pageHeight);
    pageReferences.push(`${pageObject} 0 R`);

    objects[pageObject] = ascii(
      `<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 ${imageObject} 0 R >> >> /Contents ${contentObject} 0 R >>`,
    );
    objects[imageObject] = streamObjectChunks(
      `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      image.bytes,
    );
    const content = ascii(`q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`);
    objects[contentObject] = streamObjectChunks("", content);
  }

  objects[catalogObject] = ascii(
    `<< /Type /Catalog /Version /2.0 /Pages ${pagesObject} 0 R /Metadata ${metadataObject} 0 R /OutputIntents [${outputIntentObject} 0 R] /Lang ${pdfString("es-MX")} >>`,
  );
  objects[pagesObject] = ascii(
    `<< /Type /Pages /Count ${images.length} /Kids [${pageReferences.join(" ")}] >>`,
  );
  objects[metadataObject] = streamObjectChunks(
    "/Type /Metadata /Subtype /XML",
    TEXT_ENCODER.encode(makeXmp({ title, timestamp })),
  );
  objects[iccObject] = streamObjectChunks(
    "/N 3 /Alternate /DeviceRGB",
    SRGB_PROFILE_BYTES,
  );
  objects[outputIntentObject] = ascii(
    `<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier ${pdfString("sRGB")} /Info ${pdfString("sRGB IEC61966-2.1 compatible")} /DestOutputProfile ${iccObject} 0 R >>`,
  );

  const chunks = [ascii("%PDF-2.0\n%\xE2\xE3\xCF\xD3\n")];
  const offsets = new Array(objectCount + 1).fill(0);
  let offset = chunks[0].length;
  for (let objectNumber = 1; objectNumber <= objectCount; objectNumber += 1) {
    offsets[objectNumber] = offset;
    const prefix = ascii(`${objectNumber} 0 obj\n`);
    const suffix = ascii("\nendobj\n");
    chunks.push(prefix);
    offset += prefix.length;
    const bodyChunks = Array.isArray(objects[objectNumber])
      ? objects[objectNumber]
      : [objects[objectNumber]];
    for (const chunk of bodyChunks) {
      chunks.push(chunk);
      offset += chunk.length;
    }
    chunks.push(suffix);
    offset += suffix.length;
  }

  const xrefOffset = offset;
  const xref = [
    `xref\n0 ${objectCount + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((position) => `${String(position).padStart(10, "0")} 00000 n \n`),
  ].join("");
  const documentId = simpleDocumentId(images, `${title}\n${timestamp}`);
  chunks.push(ascii(xref));
  chunks.push(ascii(
    `trailer\n<< /Size ${objectCount + 1} /Root ${catalogObject} 0 R /ID [<${documentId}> <${documentId}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ));
  return concatBytes(chunks);
}

/**
 * Creates a self-contained PDF/A-4 archival visual copy from an open PDF.js
 * document. The controlled output contains only page images, one embedded ICC
 * profile and XMP metadata; source PDF objects are never copied through.
 *
 * This API does not call its structural inspection a conformance validator.
 * Full ISO conformance is tested in project QA with veraPDF's PDF/A-4 profile.
 */
export async function convertPdfToPdfA4(
  pdfDocument,
  { title, date, scale = DEFAULT_SCALE, quality = DEFAULT_QUALITY, onProgress } = {},
) {
  const pageCount = requirePdfDocument(pdfDocument);
  if (onProgress !== undefined && typeof onProgress !== "function") {
    throw new TypeError("onProgress debe ser una función.");
  }

  const images = [];
  let pageNumber = 0;
  for await (const rendered of pdfToJpegPages(pdfDocument, { scale, quality })) {
    pageNumber += 1;
    const pageWidth = Number(rendered.pageWidth);
    const pageHeight = Number(rendered.pageHeight);
    pdfNumber(pageWidth);
    pdfNumber(pageHeight);
    images.push({
      bytes: rendered.bytes,
      width: rendered.width,
      height: rendered.height,
      pageWidth,
      pageHeight,
    });
    if (onProgress) {
      await onProgress({ completed: pageNumber, total: pageCount, pageNumber });
    }
  }

  if (images.length !== pageCount) {
    throw new Error("No se pudieron representar todas las páginas para PDF/A-4.");
  }
  const normalized = {
    title: normalizedTitle(title),
    timestamp: normalizedDate(date),
  };
  const bytes = buildPdfA4(images, normalized);
  const declaration = detectPdfA4Declaration(bytes);
  if (!declaration.isPdfA4 || !declaration.hasOutputIntent || declaration.isEncrypted) {
    throw new Error("La copia generada no contiene la estructura mínima esperada de PDF/A-4.");
  }
  return Object.freeze({
    bytes,
    pageCount,
    profile: "PDF/A-4",
    method: "rasterized-srgb",
    declaration,
    limitations: PDF_A4_CONVERSION_LIMITATIONS,
  });
}

function bytesToLatin1(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  let value = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    value += String.fromCharCode(...input.subarray(offset, offset + chunkSize));
  }
  return value;
}

/**
 * Detects an explicit PDF/A-4 declaration and controlled structural markers.
 * It intentionally does not return a field named `valid` or `conformant`:
 * only a complete validator such as veraPDF can certify ISO 19005-4.
 */
export function detectPdfA4Declaration(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
  // The converter writes its metadata and output intent before the first page
  // image, while encryption is declared in the trailer. Bounded windows avoid
  // copying a multi-gigabyte archival file into a JavaScript string merely to
  // inspect those markers. Other producers may place XMP elsewhere, in which
  // case a standards validator remains the appropriate tool.
  const headLength = Math.min(bytes.length, 4 * 1024 * 1024);
  const tailStart = Math.max(headLength, bytes.length - 256 * 1024);
  const source = `${bytesToLatin1(bytes.subarray(0, headLength))}\n${
    bytesToLatin1(bytes.subarray(tailStart))
  }`;
  const header = source.slice(0, 16).match(/^%PDF-(\d\.\d)/u)?.[1] ?? null;
  const part = source.match(/<pdfaid:part>\s*(\d+)\s*<\/pdfaid:part>/u)?.[1] ?? null;
  const revision = source.match(/<pdfaid:rev>\s*(\d{4})\s*<\/pdfaid:rev>/u)?.[1] ?? null;
  const hasOutputIntent = /\/Type\s*\/OutputIntent\b/u.test(source)
    && /\/S\s*\/GTS_PDFA1\b/u.test(source)
    && /\/DestOutputProfile\s+\d+\s+\d+\s+R\b/u.test(source);
  const isEncrypted = /\/Encrypt\b/u.test(source);
  const hasMetadata = /\/Type\s*\/Metadata\b/u.test(source)
    && /\/Subtype\s*\/XML\b/u.test(source);
  const isPdfA4 = (
    header === "2.0"
    && part === String(PDF_A4_PART)
    && revision === String(PDF_A4_REVISION)
    && hasMetadata
  );
  return Object.freeze({
    isPdfA4,
    pdfVersion: header,
    part: part === null ? null : Number(part),
    revision: revision === null ? null : Number(revision),
    hasMetadata,
    hasOutputIntent,
    isEncrypted,
  });
}
