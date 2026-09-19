import JSZip from "jszip";

const JPEG_MIME_TYPE = "image/jpeg";
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DEFAULT_JPEG_SCALE = 1.6;
const DEFAULT_JPEG_QUALITY = 0.88;
const MAX_EXPORT_CANVAS_DIMENSION = 8_192;
const MAX_EXPORT_CANVAS_PIXELS = 32 * 1024 * 1024;
const EMU_PER_INCH = 914_400;
const PPTX_LONG_EDGE = Math.round(13.333333 * EMU_PER_INCH);
const ZIP_FILE_DATE = new Date("1980-01-01T00:00:00.000Z");

function requirePdfDocument(pdfDocument) {
  const pageCount = Number(pdfDocument?.numPages);
  if (!Number.isInteger(pageCount) || pageCount < 1 || typeof pdfDocument.getPage !== "function") {
    throw new TypeError("Se necesita un documento PDF abierto con al menos una página.");
  }
  return pageCount;
}

function normalizedScale(value) {
  if (value === undefined) return DEFAULT_JPEG_SCALE;
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError("La escala JPEG debe ser un número mayor que cero.");
  }
  return scale;
}

function normalizedQuality(value) {
  if (value === undefined) return DEFAULT_JPEG_QUALITY;
  const quality = Number(value);
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new RangeError("La calidad JPEG debe estar entre 0 y 1.");
  }
  return quality;
}

function safeCanvasScale(page, requestedScale) {
  const viewport = page.getViewport({ scale: requestedScale });
  const width = Math.max(1, Number(viewport?.width) || 1);
  const height = Math.max(1, Number(viewport?.height) || 1);
  const dimensionRatio = MAX_EXPORT_CANVAS_DIMENSION / Math.max(width, height);
  const areaRatio = Math.sqrt(MAX_EXPORT_CANVAS_PIXELS / Math.max(width * height, 1));
  const ratio = Math.min(1, dimensionRatio, areaRatio);
  return ratio < 1 ? requestedScale * ratio : requestedScale;
}

function createScratchCanvas(width, height) {
  if (typeof globalThis.document?.createElement === "function") {
    const canvas = globalThis.document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  if (typeof globalThis.OffscreenCanvas === "function") {
    return new globalThis.OffscreenCanvas(width, height);
  }
  throw new Error(
    "La conversión a JPEG requiere un entorno gráfico compatible con Canvas.",
  );
}

function resizeCanvas(canvas, width, height) {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext?.("2d", { alpha: false });
  if (!context) {
    throw new Error("No se pudo crear el lienzo temporal para convertir el PDF.");
  }
  return context;
}

function dataUrlToBytes(dataUrl) {
  const separator = dataUrl.indexOf(",");
  if (separator < 0 || typeof globalThis.atob !== "function") {
    throw new Error("El motor gráfico no pudo codificar la página como JPEG.");
  }
  const binary = globalThis.atob(dataUrl.slice(separator + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function canvasToJpegBytes(canvas, quality) {
  let blob;
  let bytes;
  if (typeof canvas.convertToBlob === "function") {
    blob = await canvas.convertToBlob({ type: JPEG_MIME_TYPE, quality });
  } else if (typeof canvas.toBlob === "function") {
    blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) => result ? resolve(result) : reject(
          new Error("El motor gráfico no pudo codificar la página como JPEG."),
        ),
        JPEG_MIME_TYPE,
        quality,
      );
    });
  } else if (typeof canvas.toDataURL === "function") {
    bytes = dataUrlToBytes(canvas.toDataURL(JPEG_MIME_TYPE, quality));
  } else {
    throw new Error("El motor gráfico no permite exportar imágenes JPEG.");
  }
  if (!bytes) {
    if (!blob || typeof blob.arrayBuffer !== "function") {
      throw new Error("El motor gráfico no pudo codificar la página como JPEG.");
    }
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("El motor gráfico devolvió una imagen que no es JPEG.");
  }
  return bytes;
}

function pageImageName(pageNumber, pageCount) {
  const digits = Math.max(3, String(pageCount).length);
  return `pagina-${String(pageNumber).padStart(digits, "0")}.jpg`;
}

/**
 * Renders one page at a time into a detached canvas. It intentionally yields
 * each JPEG before requesting the next page so callers can write it to disk
 * without retaining every rendered bitmap in memory.
 */
export async function* pdfToJpegPages(
  pdfDocument,
  { scale, quality, onProgress } = {},
) {
  const pageCount = requirePdfDocument(pdfDocument);
  const requestedScale = normalizedScale(scale);
  const jpegQuality = normalizedQuality(quality);
  if (onProgress !== undefined && typeof onProgress !== "function") {
    throw new TypeError("onProgress debe ser una función.");
  }

  let canvas = null;
  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      let bytes;
      let width;
      let height;
      let pageWidth;
      let pageHeight;
      try {
        const pageViewport = page.getViewport({ scale: 1 });
        pageWidth = Math.max(1, Number(pageViewport?.width) || 1);
        pageHeight = Math.max(1, Number(pageViewport?.height) || 1);
        const effectiveScale = safeCanvasScale(page, requestedScale);
        const viewport = page.getViewport({ scale: effectiveScale });
        width = Math.max(1, Math.round(viewport.width));
        height = Math.max(1, Math.round(viewport.height));
        canvas ||= createScratchCanvas(width, height);
        const context = resizeCanvas(canvas, width, height);

        context.save?.();
        context.fillStyle = "#ffffff";
        context.fillRect?.(0, 0, width, height);
        context.restore?.();

        const renderTask = page.render({
          canvas,
          viewport,
          background: "rgb(255,255,255)",
          intent: "print",
          // PDF.js AnnotationMode.ENABLE_STORAGE. This also paints current form
          // values from annotationStorage when the caller is converting an open
          // form, without importing the full PDF.js bundle into this module.
          annotationMode: 3,
        });
        await renderTask.promise;
        bytes = await canvasToJpegBytes(canvas, jpegQuality);
      } finally {
        // Releasing page resources keeps long conversions bounded. This does
        // not modify the source PDF or the visible viewer canvas.
        page.cleanup?.();
      }
      const name = pageImageName(pageNumber, pageCount);
      if (onProgress) {
        await onProgress({
          completed: pageNumber,
          total: pageCount,
          pageNumber,
          name,
        });
      }
      yield { name, bytes, width, height, pageWidth, pageHeight };
    }
  } finally {
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

function xmlSafeText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function zipFile(zip, path, data) {
  zip.file(path, data, { date: ZIP_FILE_DATE, createFolders: true });
}

function officeTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function coreProperties({ title, description, keywords }) {
  const timestamp = officeTimestamp();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlSafeText(title)}</dc:title>
  <dc:creator>TenjinReader - Xihuitl Systems</dc:creator>
  <cp:lastModifiedBy>TenjinReader - Xihuitl Systems</cp:lastModifiedBy>
  <dc:description>${xmlSafeText(description)}</dc:description>
  <cp:keywords>${xmlSafeText(keywords)}</cp:keywords>
  <dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified>
</cp:coreProperties>`;
}

function lineFromItems(items) {
  let text = "";
  let previousEnd = null;
  let previousFontSize = 10;
  for (const item of items.sort((first, second) => first.x - second.x)) {
    const value = item.text;
    if (!value) continue;
    const gap = previousEnd === null ? 0 : item.x - previousEnd;
    const needsSpace = (
      text.length > 0
      && !/\s$/u.test(text)
      && !/^\s/u.test(value)
      && gap > Math.max(0.8, Math.min(previousFontSize, item.fontSize) * 0.12)
    );
    text += `${needsSpace ? " " : ""}${value}`;
    previousEnd = Math.max(previousEnd ?? item.x, item.x + item.width);
    previousFontSize = item.fontSize;
  }
  return text.replace(/[ \t]+/gu, " ").trim();
}

function textLines(textContent) {
  const positioned = [];
  for (const raw of textContent?.items ?? []) {
    const text = String(raw?.str ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "");
    if (!text) continue;
    const transform = Array.isArray(raw.transform) || ArrayBuffer.isView(raw.transform)
      ? raw.transform
      : [];
    const x = Number(transform[4]);
    const y = Number(transform[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const fontSize = Math.max(
      1,
      Math.hypot(Number(transform[0]) || 0, Number(transform[1]) || 0),
      Number(raw.height) || 0,
    );
    positioned.push({
      text,
      x,
      y,
      width: Math.max(0, Math.abs(Number(raw.width) || 0)),
      fontSize,
    });
  }

  positioned.sort((first, second) => second.y - first.y || first.x - second.x);
  const rows = [];
  let currentRow = null;
  for (const item of positioned) {
    const belongsToCurrentRow = currentRow && (
      Math.abs(currentRow.y - item.y)
      <= Math.max(1.5, Math.min(currentRow.fontSize, item.fontSize) * 0.35)
    );
    if (belongsToCurrentRow) {
      currentRow.items.push(item);
      currentRow.fontSize = Math.max(currentRow.fontSize, item.fontSize);
      currentRow.y = (
        currentRow.y * (currentRow.items.length - 1) + item.y
      ) / currentRow.items.length;
    } else {
      currentRow = { y: item.y, fontSize: item.fontSize, items: [item] };
      rows.push(currentRow);
    }
  }
  return rows
    .sort((first, second) => second.y - first.y)
    .map((row) => lineFromItems(row.items))
    .filter(Boolean);
}

function wordParagraph(text) {
  return `<w:p><w:r><w:t xml:space="preserve">${xmlSafeText(text)}</w:t></w:r></w:p>`;
}

function wordPageBreak() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

/**
 * Creates a small, editable DOCX by extracting PDF text page by page.
 * It deliberately does not claim layout fidelity or OCR support: the package
 * metadata records both limitations and image-only PDFs fail with a clear
 * message instead of producing a deceptively blank Word document.
 */
export async function pdfToDocx(pdfDocument) {
  const pageCount = requirePdfDocument(pdfDocument);
  const paragraphs = [];
  let extractedLineCount = 0;

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    let lines;
    try {
      const content = await page.getTextContent({
        includeMarkedContent: true,
        disableCombineTextItems: false,
      });
      lines = textLines(content);
    } finally {
      page.cleanup?.();
    }
    extractedLineCount += lines.length;
    if (lines.length) {
      paragraphs.push(...lines.map(wordParagraph));
    } else {
      paragraphs.push(wordParagraph(""));
    }
    if (pageNumber < pageCount) paragraphs.push(wordPageBreak());
  }

  if (extractedLineCount === 0) {
    throw new Error(
      "No se encontró texto editable. El PDF parece contener páginas escaneadas y esta conversión ligera no incluye OCR.",
    );
  }

  const zip = new JSZip();
  zipFile(zip, "[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
  zipFile(zip, "_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);
  zipFile(zip, "docProps/core.xml", coreProperties({
    title: "Documento convertido desde PDF",
    description: "Conversión de texto editable con diseño aproximado. No incluye OCR ni garantiza conservar tablas, columnas, tipografías o imágenes del PDF original.",
    keywords: "TenjinReader, DOCX, texto editable, sin OCR, diseño aproximado",
  }));
  zipFile(zip, "docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>TenjinReader</Application>
  <Company>Xihuitl Systems</Company>
  <Pages>${pageCount}</Pages>
  <AppVersion>1.3</AppVersion>
</Properties>`);
  zipFile(zip, "word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.join("\n    ")}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`);
  zipFile(zip, "word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
</w:styles>`);
  zipFile(zip, "word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);

  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: DOCX_MIME_TYPE,
    platform: "DOS",
  });
}

function emptyShapeTree() {
  return `<p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
}

function slideSizeForImage(width, height) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  if (safeWidth >= safeHeight) {
    return {
      cx: PPTX_LONG_EDGE,
      cy: Math.max(EMU_PER_INCH, Math.round(PPTX_LONG_EDGE * safeHeight / safeWidth)),
    };
  }
  return {
    cx: Math.max(EMU_PER_INCH, Math.round(PPTX_LONG_EDGE * safeWidth / safeHeight)),
    cy: PPTX_LONG_EDGE,
  };
}

function imagePlacement(image, slide) {
  const ratio = Math.min(slide.cx / image.width, slide.cy / image.height);
  const cx = Math.max(1, Math.round(image.width * ratio));
  const cy = Math.max(1, Math.round(image.height * ratio));
  return {
    x: Math.round((slide.cx - cx) / 2),
    y: Math.round((slide.cy - cy) / 2),
    cx,
    cy,
  };
}

function pptxTheme() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="TenjinReader">
  <a:themeElements>
    <a:clrScheme name="TenjinReader">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="26322C"/></a:dk2><a:lt2><a:srgbClr val="F5F5F2"/></a:lt2>
      <a:accent1><a:srgbClr val="B53932"/></a:accent1><a:accent2><a:srgbClr val="236654"/></a:accent2>
      <a:accent3><a:srgbClr val="D3A532"/></a:accent3><a:accent4><a:srgbClr val="6B7C93"/></a:accent4>
      <a:accent5><a:srgbClr val="8D6A9F"/></a:accent5><a:accent6><a:srgbClr val="5F8F99"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="TenjinReader"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="TenjinReader">
      <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/><a:satMod val="300000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="50000"/><a:satMod val="200000"/></a:schemeClr></a:solidFill></a:fillStyleLst>
      <a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>
      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
      <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/><a:satMod val="120000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
  <a:objectDefaults/><a:extraClrSchemeLst/>
</a:theme>`;
}

/**
 * Creates a PPTX with one raster JPEG per slide. The visual layout is retained,
 * but PDF text and vector objects intentionally remain non-editable; that
 * limitation is written into the package's core metadata.
 */
export async function pdfToPptx(pdfDocument) {
  requirePdfDocument(pdfDocument);
  const zip = new JSZip();
  const slides = [];
  let slideSize = null;

  for await (const image of pdfToJpegPages(pdfDocument, {
    scale: DEFAULT_JPEG_SCALE,
    quality: DEFAULT_JPEG_QUALITY,
  })) {
    slideSize ||= slideSizeForImage(image.width, image.height);
    const slideNumber = slides.length + 1;
    const placement = imagePlacement(image, slideSize);
    slides.push({ slideNumber, image, placement });
    zipFile(zip, `ppt/media/image${slideNumber}.jpg`, image.bytes);
  }

  const slideOverrides = slides.map(({ slideNumber }) => (
    `  <Override PartName="/ppt/slides/slide${slideNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
  )).join("\n");
  zipFile(zip, "[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${slideOverrides}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
  zipFile(zip, "_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);
  zipFile(zip, "docProps/core.xml", coreProperties({
    title: "Presentación convertida desde PDF",
    description: "Conversión visual: cada página del PDF se rasterizó como una imagen JPEG de diapositiva completa. El texto, vectores y formularios no son editables en PowerPoint.",
    keywords: "TenjinReader, PPTX, JPEG, contenido rasterizado, no editable",
  }));
  zipFile(zip, "docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>TenjinReader</Application><PresentationFormat>Personalizado</PresentationFormat><Slides>${slides.length}</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides><MMClips>0</MMClips><ScaleCrop>false</ScaleCrop><Company>Xihuitl Systems</Company><AppVersion>1.4</AppVersion>
</Properties>`);

  const slideIds = slides.map(({ slideNumber }) => (
    `    <p:sldId id="${255 + slideNumber}" r:id="rId${slideNumber + 1}"/>`
  )).join("\n");
  zipFile(zip, "ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>
${slideIds}
  </p:sldIdLst>
  <p:sldSz cx="${slideSize.cx}" cy="${slideSize.cy}" type="custom"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`);
  const presentationRelationships = slides.map(({ slideNumber }) => (
    `  <Relationship Id="rId${slideNumber + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${slideNumber}.xml"/>`
  )).join("\n");
  zipFile(zip, "ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${presentationRelationships}
</Relationships>`);
  zipFile(zip, "ppt/theme/theme1.xml", pptxTheme());
  zipFile(zip, "ppt/slideMasters/slideMaster1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld name="TenjinReader">${emptyShapeTree()}</p:spTree></p:cSld>
  <p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst>
  <p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>
</p:sldMaster>`);
  zipFile(zip, "ppt/slideMasters/_rels/slideMaster1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`);
  zipFile(zip, "ppt/slideLayouts/slideLayout1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="En blanco">${emptyShapeTree()}</p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`);
  zipFile(zip, "ppt/slideLayouts/_rels/slideLayout1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`);

  for (const { slideNumber, placement } of slides) {
    zipFile(zip, `ppt/slides/slide${slideNumber}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld name="Página PDF ${slideNumber}">
    ${emptyShapeTree()}
      <p:pic>
        <p:nvPicPr><p:cNvPr id="2" name="Página PDF ${slideNumber}" descr="Página PDF rasterizada como JPEG; contenido no editable"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr><a:xfrm><a:off x="${placement.x}" y="${placement.y}"/><a:ext cx="${placement.cx}" cy="${placement.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln><a:noFill/></a:ln></p:spPr>
      </p:pic>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`);
    zipFile(zip, `ppt/slides/_rels/slide${slideNumber}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${slideNumber}.jpg"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`);
  }

  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: PPTX_MIME_TYPE,
    platform: "DOS",
  });
}
