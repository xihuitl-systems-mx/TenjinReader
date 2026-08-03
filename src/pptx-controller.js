import JSZip from "jszip";
import { PPTXViewer } from "pptxviewjs";
import {
  calculateReferenceRenderSize,
  calculateSlideDisplaySize,
} from "./presentation-layout.js";

export {
  calculateReferenceRenderSize,
  calculateSlideDisplaySize,
} from "./presentation-layout.js";

const MAX_ENTRIES = 5000;
const MAX_UNCOMPRESSED_BYTES = 600 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 250;
const DEFAULT_SLIDE_SIZE = { cx: 12_192_000, cy: 6_858_000 };
const MAX_BACKING_DIMENSION = 4096;

function asUint8Array(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  throw new TypeError("El PPTX debe proporcionarse como ArrayBuffer o Uint8Array.");
}

function exactArrayBuffer(bytes) {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * Performs cheap structural checks before the renderer touches an untrusted ZIP.
 * JSZip reads the central directory first, so the size limits are checked before
 * slide media is expanded by PptxViewJS.
 */
export async function inspectPptx(input) {
  const bytes = asUint8Array(input);
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error("El archivo no tiene una cabecera PPTX válida.");
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(exactArrayBuffer(bytes), {
      checkCRC32: false,
      createFolders: false,
    });
  } catch {
    throw new Error("No se pudo abrir el contenedor PPTX; puede estar dañado o cifrado.");
  }

  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) {
    throw new Error("El PPTX contiene demasiados elementos internos.");
  }
  if (!zip.file("[Content_Types].xml") || !zip.file("ppt/presentation.xml")) {
    throw new Error("El archivo ZIP no contiene una presentación PowerPoint válida.");
  }
  if (zip.file("ppt/vbaProject.bin")) {
    throw new Error("Los archivos con macros no son compatibles con el visor seguro.");
  }

  let compressed = 0;
  let uncompressed = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const metadata = entry._data;
    const compressedSize = Number(metadata?.compressedSize || 0);
    const uncompressedSize = Number(metadata?.uncompressedSize || 0);
    compressed += Math.max(0, compressedSize);
    uncompressed += Math.max(0, uncompressedSize);
    if (uncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("El PPTX se expande a más de 600 MB y se bloqueó por seguridad.");
    }
  }

  if (compressed > 0 && uncompressed / compressed > MAX_COMPRESSION_RATIO) {
    throw new Error("El PPTX tiene una relación de compresión inusual y se bloqueó por seguridad.");
  }

  return {
    entryCount: entries.length,
    compressedBytes: compressed,
    uncompressedBytes: uncompressed,
  };
}

export class PptxController {
  constructor(canvas, host, onState = () => {}) {
    this.canvas = canvas;
    this.host = host;
    this.onState = onState;
    this.viewer = null;
    this.slideCount = 0;
    this.slideIndex = 0;
    this.zoom = 1;
    this.fit = true;
    this.slideSize = DEFAULT_SLIDE_SIZE;
    this.renderSequence = 0;
    this.renderCanvas = null;
    this.renderedSlideIndex = -1;
    this.fontsReady = null;
    this.lastHostWidth = -1;
    this.lastHostHeight = -1;
  }

  async load(input) {
    const bytes = asUint8Array(input);
    const inspection = await inspectPptx(bytes);
    this.destroy();

    const canvasDocument = this.canvas?.ownerDocument
      || (typeof document !== "undefined" ? document : null);
    if (!canvasDocument?.createElement) {
      throw new Error("No se pudo crear el lienzo interno de la presentación.");
    }
    this.renderCanvas = canvasDocument.createElement("canvas");

    this.viewer = new PPTXViewer({
      canvas: this.renderCanvas,
      debug: false,
      enableThumbnails: false,
      slideSizeMode: "fit",
      backgroundColor: "#ffffff",
      autoRenderFirstSlide: false,
      autoExposeGlobals: true,
      autoChartRerenderDelayMs: 0,
    });

    await this.viewer.loadFile(exactArrayBuffer(bytes));
    this.slideCount = this.viewer.getSlideCount();
    if (!this.slideCount) {
      throw new Error("La presentación no contiene diapositivas visibles.");
    }

    const dimensions = this.viewer.processor?.getSlideDimensions?.();
    if (Number(dimensions?.cx) > 0 && Number(dimensions?.cy) > 0) {
      this.slideSize = { cx: Number(dimensions.cx), cy: Number(dimensions.cy) };
    }
    this.slideIndex = 0;
    this.zoom = 1;
    this.fit = true;
    this.configureReferenceCanvas();
    this.resetRendererForReferenceCanvas();
    await this.render(0);
    return inspection;
  }

  get aspectRatio() {
    return this.slideSize.cx / this.slideSize.cy;
  }

  sizeCanvas() {
    const hostWidth = this.host.clientWidth;
    const hostHeight = this.host.clientHeight;
    const aspect = this.aspectRatio || 16 / 9;
    const { width, height } = calculateSlideDisplaySize({
      hostWidth,
      hostHeight,
      aspectRatio: aspect,
      zoom: this.zoom,
    });
    const requestedRatio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelRatio = Math.max(
      0.5,
      Math.min(requestedRatio, MAX_BACKING_DIMENSION / Math.max(width, height)),
    );

    const cssWidth = `${Math.round(width)}px`;
    const cssHeight = `${Math.round(height)}px`;
    const backingWidth = Math.max(1, Math.round(width * pixelRatio));
    const backingHeight = Math.max(1, Math.round(height * pixelRatio));
    if (this.canvas.style.width !== cssWidth) this.canvas.style.width = cssWidth;
    if (this.canvas.style.height !== cssHeight) this.canvas.style.height = cssHeight;
    // Assigning width/height clears and reallocates a canvas even when the
    // numeric value is unchanged. Avoid that cost on redundant observer ticks.
    if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth;
    if (this.canvas.height !== backingHeight) this.canvas.height = backingHeight;
    const stage = this.canvas.parentElement;
    if (stage) {
      stage.style.width = `${Math.round(width)}px`;
      stage.style.height = `${Math.round(height)}px`;
      stage.style.aspectRatio = String(aspect);
    }
    this.lastHostWidth = hostWidth;
    this.lastHostHeight = hostHeight;
    return { width, height, pixelRatio };
  }

  configureReferenceCanvas() {
    if (!this.renderCanvas) return;
    const size = calculateReferenceRenderSize(
      this.aspectRatio || 16 / 9,
      typeof window !== "undefined" ? window.devicePixelRatio : 1,
    );
    this.renderCanvas.style.width = `${size.logicalWidth}px`;
    this.renderCanvas.style.height = `${size.logicalHeight}px`;
    // PptxViewJS applies its own DPR backing-store sizing from these logical
    // dimensions. Keeping them fixed prevents text wrapping from changing on
    // window resize or zoom.
    this.renderCanvas.width = size.logicalWidth;
    this.renderCanvas.height = size.logicalHeight;
    if (this.viewer?.processor?.renderContext) {
      this.viewer.processor.renderContext.pixelRatio = size.pixelRatio;
    }
  }

  resetRendererForReferenceCanvas() {
    const drawingDocument = this.viewer?.processor?.drawingDocument;
    if (!drawingDocument) return;
    // pptxviewjs initializes its arrow-capable graphics engine on a temporary
    // canvas. Force one recreation so every layer targets our stable canvas.
    drawingDocument.graphics = null;
    drawingDocument.graphicsEngine = null;
    drawingDocument.canvas = null;
  }

  async waitForFonts() {
    if (this.fontsReady) return this.fontsReady;
    const fontSet = this.canvas?.ownerDocument?.fonts;
    this.fontsReady = fontSet?.ready
      ? Promise.resolve(fontSet.ready).catch(() => undefined)
      : Promise.resolve();
    return this.fontsReady;
  }

  paintReferenceCanvas() {
    if (!this.renderCanvas) return;
    const context = this.canvas?.getContext?.("2d");
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      this.renderCanvas,
      0,
      0,
      this.renderCanvas.width,
      this.renderCanvas.height,
      0,
      0,
      this.canvas.width,
      this.canvas.height,
    );
  }

  async render(index = this.slideIndex) {
    if (!this.viewer) return;
    const safeIndex = Math.max(0, Math.min(this.slideCount - 1, Number(index) || 0));
    const sequence = ++this.renderSequence;
    this.sizeCanvas();
    if (safeIndex !== this.renderedSlideIndex) {
      await this.waitForFonts();
      await this.viewer.renderSlide(safeIndex, this.renderCanvas, { quality: "high" });
    }
    if (sequence !== this.renderSequence) return;
    this.paintReferenceCanvas();
    this.renderedSlideIndex = safeIndex;
    this.slideIndex = safeIndex;
    this.onState(this.getState());
  }

  async previous() {
    await this.render(this.slideIndex - 1);
  }

  async next() {
    await this.render(this.slideIndex + 1);
  }

  async goTo(index) {
    await this.render(index);
  }

  async setZoom(nextZoom) {
    this.fit = false;
    this.zoom = Math.max(0.35, Math.min(3, Number(nextZoom) || 1));
    await this.render();
  }

  async fitToWindow() {
    this.fit = true;
    this.zoom = 1;
    await this.render();
  }

  async resize() {
    if (this.fit && this.viewer) {
      if (
        this.host.clientWidth === this.lastHostWidth
        && this.host.clientHeight === this.lastHostHeight
      ) {
        return;
      }
      await this.render();
    }
  }

  getState() {
    return {
      slideIndex: this.slideIndex,
      slideCount: this.slideCount,
      zoom: this.zoom,
      fit: this.fit,
    };
  }

  destroy() {
    this.renderSequence += 1;
    const viewer = this.viewer;
    const processor = viewer?.processor;
    const zip = processor?.zip || processor?.processor?.zip || processor?.zipProcessor?.zip;
    try {
      processor?.destroy?.();
    } catch {
      // Some partially parsed presentations do not expose a complete cleanup path.
    }
    if (viewer) viewer.presentation = null;
    viewer?.destroy?.();
    if (typeof window !== "undefined") {
      if (window.currentProcessor?.processor === processor) {
        window.currentProcessor = null;
      }
      if (!zip || window.currentZipData === zip) {
        window.currentZipData = null;
      }
      if (zip && window.PPTXSlideRenderer?.currentZip === zip) {
        window.PPTXSlideRenderer.currentZip = null;
      }
    }
    if (this.renderCanvas) {
      this.renderCanvas.width = 1;
      this.renderCanvas.height = 1;
    }
    this.viewer = null;
    this.renderCanvas = null;
    this.renderedSlideIndex = -1;
    this.fontsReady = null;
    this.slideCount = 0;
    this.slideIndex = 0;
    if (this.canvas) {
      // Resizing clears the bitmap and releases its backing allocation in one
      // operation; clearing the full high-resolution slide first is wasted work.
      this.canvas.width = 1;
      this.canvas.height = 1;
    }
    this.lastHostWidth = -1;
    this.lastHostHeight = -1;
  }
}
