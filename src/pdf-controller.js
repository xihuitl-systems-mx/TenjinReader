import {
  AnnotationMode,
  GlobalWorkerOptions,
  PDFDataRangeTransport,
  PasswordResponses,
  TextLayer,
  getDocument,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { clamp, isSafeExternalUrl, mapWithConcurrency } from "./utils.js";
import { PDFJS_ASSET_OPTIONS, PDF_RANGE_CHUNK_BYTES } from "./pdf-source.js";
import { SearchTextCache } from "./search-text-cache.js";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_UNDO = 100;
const MAX_VIEWPORT_DIMENSION = 16_384;
const MAX_CANVAS_DIMENSION = 8_192;
const MAX_CANVAS_PIXELS = 32 * 1024 * 1024;
const CHOICE_EDIT_FLAG = 0x40000;
const FORM_FIELD_TYPES = new Set(["Tx", "Btn", "Ch"]);
const SEARCH_PAGE_CONCURRENCY = 2;

export class PdfByteSourceRangeTransport extends PDFDataRangeTransport {
  constructor(source, initialData = null) {
    const initialBytes = initialData
      ? new Uint8Array(initialData)
      : null;
    super(
      source.length,
      initialBytes,
      Boolean(initialBytes && initialBytes.byteLength >= source.length),
      source.name,
    );
    this.source = source;
    this.aborted = false;
  }

  requestDataRange(begin, end) {
    void this.source.readRange(begin, end)
      .then((data) => {
        if (!this.aborted) this.onDataRange(begin, new Uint8Array(data));
      })
      .catch((error) => {
        if (!this.aborted) {
          console.error("No se pudo leer un rango del PDF.", error);
          this.onDataRange(begin, null);
        }
      });
  }

  abort() {
    this.aborted = true;
  }
}

function normalizeRotation(value) {
  return ((Math.round(Number(value) || 0) % 360) + 360) % 360;
}

function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let position = 0;
  while ((position = haystack.indexOf(needle, position)) !== -1) {
    count += 1;
    position += Math.max(1, needle.length);
  }
  return count;
}

function makeSvgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function convertRectangle(viewport, rectangle) {
  const first = viewport.convertToViewportPoint(rectangle[0], rectangle[1]);
  const second = viewport.convertToViewportPoint(rectangle[2], rectangle[3]);
  return [first[0], first[1], second[0], second[1]];
}

function cloneFormState(state) {
  if (!state) return null;
  return {
    kind: state.kind,
    value: Array.isArray(state.value) ? [...state.value] : state.value,
  };
}

function formStatesEqual(first, second) {
  if (!first || !second || first.kind !== second.kind) return false;
  if (Array.isArray(first.value) || Array.isArray(second.value)) {
    const firstValues = Array.isArray(first.value) ? first.value : [first.value];
    const secondValues = Array.isArray(second.value) ? second.value : [second.value];
    return (
      firstValues.length === secondValues.length
      && firstValues.every((value, index) => value === secondValues[index])
    );
  }
  return first.value === second.value;
}

function formStateFromAnnotation(annotation) {
  const fieldValue = annotation?.fieldValue;
  if (annotation?.fieldType === "Tx") {
    return { kind: "text", value: String(fieldValue ?? "") };
  }
  if (annotation?.fieldType === "Btn" && annotation.checkBox) {
    const value = fieldValue && fieldValue !== "Off" ? String(fieldValue) : null;
    return { kind: "checkbox", value };
  }
  if (annotation?.fieldType === "Btn" && annotation.radioButton) {
    const value = fieldValue && fieldValue !== "Off" ? String(fieldValue) : null;
    return { kind: "radio", value };
  }
  if (annotation?.fieldType === "Ch") {
    const values = Array.isArray(fieldValue)
      ? fieldValue.map((value) => String(value))
      : fieldValue === null || fieldValue === undefined
        ? []
        : [String(fieldValue)];
    return {
      kind: "choice",
      value: annotation.multiSelect ? values : (values[0] ?? ""),
    };
  }
  return null;
}

function cssColor(color, fallback = "") {
  if (!color || typeof color.length !== "number" || color.length < 3) {
    return fallback;
  }
  const components = Array.from(color).slice(0, 3).map((value) => (
    clamp(Math.round(Number(value) || 0), 0, 255)
  ));
  return `rgb(${components.join(" ")})`;
}

export class PdfController {
  constructor(elements, callbacks = {}) {
    this.elements = elements;
    this.onState = callbacks.onState || (() => {});
    this.onDirty = callbacks.onDirty || (() => {});
    this.onStatus = callbacks.onStatus || (() => {});
    this.onToast = callbacks.onToast || (() => {});
    this.onExternal = callbacks.onExternal || (() => {});

    this.document = null;
    this.loadingTask = null;
    this.rangeTransport = null;
    this.renderTask = null;
    this.textLayerTask = null;
    this.pageOrder = [];
    this.activePagesCache = null;
    this.deletedPages = new Set();
    this.rotations = new Map();
    this.operations = [];
    this.undoStack = [];
    this.currentPosition = 0;
    this.scale = 1.25;
    this.fit = true;
    this.tool = "select";
    this.color = "#e9b949";
    this.toolSize = 3;
    this.currentPage = null;
    this.viewport = null;
    this.renderSequence = 0;
    this.pointerSession = null;
    this.pendingTextPoint = null;
    this.searchResults = [];
    this.searchPosition = -1;
    this.searchQuery = "";
    this.searchSequence = 0;
    this.searchTextCache = new SearchTextCache();
    this.operationCounter = 0;
    this.passwordProtected = false;
    this.formFieldCount = 0;
    this.formInitialValues = new Map();
    this.formEdits = new Map();
    this.formWidgets = new Map();
    this.formIndexPromise = null;
    this.formIndexComplete = false;
    this.formControlCounter = 0;
    this.lastFitViewerWidth = -1;
    this.lastFitViewerHeight = -1;

    this.bindPointerEvents();
    this.bindTextEntry();
  }

  get hasPageEdits() {
    return (
      this.operations.length > 0 ||
      this.deletedPages.size > 0 ||
      [...this.rotations.values()].some((value) => normalizeRotation(value) !== 0)
    );
  }

  get hasFormChanges() {
    return this.formEdits.size > 0;
  }

  get hasChanges() {
    return this.hasPageEdits || this.hasFormChanges;
  }

  get activePages() {
    if (!this.activePagesCache) {
      this.activePagesCache = this.pageOrder.filter(
        (pageIndex) => !this.deletedPages.has(pageIndex),
      );
    }
    return this.activePagesCache;
  }

  invalidateActivePages() {
    this.activePagesCache = null;
  }

  get currentPageIndex() {
    return this.activePages[this.currentPosition] ?? 0;
  }

  async load(input, options = {}) {
    await this.destroyDocument();
    this.passwordProtected = false;
    this.resetEdits();

    const isRangeSource = (
      input
      && typeof input === "object"
      && Number.isSafeInteger(input.length)
      && typeof input.readRange === "function"
    );
    let documentSource;
    if (isRangeSource) {
      this.rangeTransport = new PdfByteSourceRangeTransport(
        input,
        options.initialData || null,
      );
      documentSource = {
        range: this.rangeTransport,
        rangeChunkSize: PDF_RANGE_CHUNK_BYTES,
        disableStream: true,
        disableAutoFetch: true,
      };
    } else {
      const data = input instanceof Uint8Array
        ? input
        : new Uint8Array(input instanceof ArrayBuffer ? input : input);
      documentSource = { data };
    }

    const loadingTask = getDocument({
      ...documentSource,
      ...PDFJS_ASSET_OPTIONS,
      useSystemFonts: true,
      enableXfa: false,
      isEvalSupported: false,
      stopAtErrors: false,
    });
    this.loadingTask = loadingTask;

    loadingTask.onPassword = (updatePassword, reason) => {
      this.passwordProtected = true;
      const message =
        reason === PasswordResponses.INCORRECT_PASSWORD
          ? "La contraseña no es correcta. Inténtalo de nuevo:"
          : "Este PDF está protegido. Escribe la contraseña para abrirlo:";
      const password = window.prompt(message);
      if (password === null) {
        loadingTask.destroy();
        return;
      }
      updatePassword(password);
    };

    this.document = await loadingTask.promise;
    try {
      if ((await this.document.getPermissions()) !== null) {
        this.passwordProtected = true;
      }
    } catch {
      // Permission metadata is optional; password prompts remain the primary signal.
    }
    this.pageOrder = Array.from({ length: this.document.numPages }, (_, index) => index);
    this.invalidateActivePages();
    this.currentPosition = 0;
    this.scale = 1.25;
    this.fit = true;
    await this.render();
    return {
      pageCount: this.document.numPages,
      fingerprint: this.document.fingerprints?.[0] || null,
      passwordProtected: this.passwordProtected,
      formFieldCount: this.formFieldCount,
    };
  }

  resetEdits() {
    this.pageOrder = [];
    this.invalidateActivePages();
    this.deletedPages.clear();
    this.rotations.clear();
    this.operations = [];
    this.undoStack = [];
    this.currentPosition = 0;
    this.searchResults = [];
    this.searchPosition = -1;
    this.searchQuery = "";
    this.searchTextCache.clear();
    this.operationCounter = 0;
    this.formFieldCount = 0;
    this.formInitialValues.clear();
    this.formEdits.clear();
    this.formWidgets.clear();
    this.formIndexPromise = null;
    this.formIndexComplete = false;
    this.formControlCounter = 0;
    this.lastFitViewerWidth = -1;
    this.lastFitViewerHeight = -1;
    this.hideTextEntry();
    this.notifyDirty();
  }

  getChanges() {
    return {
      texts: this.operations.filter((operation) => operation.type === "text"),
      highlights: this.operations.filter((operation) => operation.type === "highlight"),
      formFields: this.operations.filter((operation) => operation.type === "form-field"),
      inks: this.operations.filter((operation) => operation.type === "ink"),
      rotations: Object.fromEntries(
        [...this.rotations.entries()].filter(([, value]) => normalizeRotation(value) !== 0),
      ),
      deletedPages: [...this.deletedPages],
    };
  }

  async saveFormDocument() {
    if (!this.document || !this.hasFormChanges) return null;
    await this.ensureFormWidgetIndex();
    if (!this.formIndexComplete) {
      throw new Error(
        "No se pudieron preparar todos los campos del formulario. "
        + "Vuelve a intentarlo antes de guardar.",
      );
    }
    for (const fieldName of this.formEdits.keys()) {
      this.updateFormStorage(fieldName);
    }
    const output = await this.document.saveDocument();
    return output instanceof Uint8Array ? output : new Uint8Array(output);
  }

  getEditedTextFieldNames() {
    return [...this.formEdits.entries()]
      .filter(([, state]) => state.kind === "text")
      .map(([fieldName]) => fieldName);
  }

  getState() {
    return {
      pagePosition: this.activePages.length ? this.currentPosition + 1 : 0,
      pageCount: this.activePages.length,
      originalPageIndex: this.currentPageIndex,
      zoom: this.scale,
      fit: this.fit,
      tool: this.tool,
      dirty: this.hasChanges,
      canUndo: this.undoStack.length > 0,
      searchPosition: this.searchPosition,
      searchCount: this.searchResults.length,
      canEdit: !this.passwordProtected,
      formFieldCount: this.formFieldCount,
    };
  }

  emitState() {
    this.onState(this.getState());
  }

  notifyDirty() {
    this.onDirty(this.hasChanges);
    this.emitState();
  }

  pushUndo(action) {
    this.undoStack.push(action);
    if (this.undoStack.length > MAX_UNDO) {
      this.undoStack.shift();
    }
  }

  setTool(tool) {
    const allowed = new Set([
      "select",
      "text",
      "field",
      "highlight",
      "ink",
      "eraser",
    ]);
    if (this.tool === "text" && tool !== "text") {
      this.commitTextEntry();
    }
    if (this.passwordProtected && tool !== "select") {
      this.onToast("Los PDF protegidos se abren en modo de solo lectura.");
      tool = "select";
    }
    this.tool = allowed.has(tool) ? tool : "select";
    this.pointerSession = null;
    this.clearPreview();
    if (this.tool !== "text") this.hideTextEntry();
    this.updateLayerInteraction();
    this.renderOperations();
    this.emitState();
  }

  setColor(color) {
    if (/^#[\da-f]{6}$/i.test(String(color))) {
      this.color = String(color).toLowerCase();
    }
  }

  setToolSize(value) {
    this.toolSize = clamp(Number(value) || 3, 1, 24);
  }

  async previous() {
    await this.goToPosition(this.currentPosition - 1);
  }

  async next() {
    await this.goToPosition(this.currentPosition + 1);
  }

  async goToPosition(position) {
    if (!this.activePages.length) return;
    if (!this.elements.textEditor.hidden) this.commitTextEntry();
    const next = clamp(Math.round(Number(position) || 0), 0, this.activePages.length - 1);
    if (next === this.currentPosition && this.currentPage) {
      this.emitState();
      return;
    }
    this.currentPosition = next;
    await this.render();
  }

  async setZoom(value) {
    if (!this.elements.textEditor.hidden) this.commitTextEntry();
    this.fit = false;
    this.scale = clamp(Number(value) || 1, 0.25, 4);
    await this.render();
  }

  async fitToWindow() {
    if (!this.elements.textEditor.hidden) this.commitTextEntry();
    this.fit = true;
    await this.render();
  }

  async resize() {
    if (this.fit && this.document) {
      const width = this.elements.viewer.clientWidth;
      const height = this.elements.viewer.clientHeight;
      if (
        width === this.lastFitViewerWidth
        && height === this.lastFitViewerHeight
      ) {
        return;
      }
      if (!this.elements.textEditor.hidden) this.commitTextEntry();
      await this.render();
    }
  }

  async rotateCurrentPage() {
    if (!this.document) return;
    if (this.passwordProtected) {
      this.onToast("Los PDF protegidos se abren en modo de solo lectura.");
      return;
    }
    if (!this.elements.textEditor.hidden) this.commitTextEntry();
    const pageIndex = this.currentPageIndex;
    const previous = normalizeRotation(this.rotations.get(pageIndex) || 0);
    const next = normalizeRotation(previous + 90);
    this.rotations.set(pageIndex, next);
    this.pushUndo({ kind: "rotate", pageIndex, previous });
    this.notifyDirty();
    await this.render();
    this.onToast(
      "Página rotada 90° a la derecha. Guarda el PDF para conservar la orientación.",
    );
  }

  async deleteCurrentPage() {
    if (!this.document) return;
    if (this.passwordProtected) {
      this.onToast("Los PDF protegidos se abren en modo de solo lectura.");
      return;
    }
    if (!this.elements.textEditor.hidden) this.commitTextEntry();
    if (this.activePages.length <= 1) {
      this.onToast("El PDF debe conservar al menos una página.");
      return;
    }
    const pageIndex = this.currentPageIndex;
    this.deletedPages.add(pageIndex);
    this.invalidateActivePages();
    this.pushUndo({ kind: "delete", pageIndex });
    this.currentPosition = clamp(this.currentPosition, 0, this.activePages.length - 1);
    this.notifyDirty();
    await this.render();
  }

  async undo() {
    if (!this.elements.textEditor.hidden) this.commitTextEntry();
    const action = this.undoStack.pop();
    if (!action) return;
    if (action.kind === "add") {
      this.operations = this.operations.filter((operation) => operation.id !== action.operationId);
    } else if (action.kind === "remove") {
      this.operations.splice(action.index, 0, action.operation);
    } else if (action.kind === "rotate") {
      if (normalizeRotation(action.previous) === 0) {
        this.rotations.delete(action.pageIndex);
      } else {
        this.rotations.set(action.pageIndex, action.previous);
      }
    } else if (action.kind === "delete") {
      this.deletedPages.delete(action.pageIndex);
      this.invalidateActivePages();
      const restoredPosition = this.activePages.indexOf(action.pageIndex);
      if (restoredPosition >= 0) this.currentPosition = restoredPosition;
    } else if (action.kind === "form") {
      this.applyFormState(action.fieldName, action.previous, { pushUndo: false });
    }
    this.notifyDirty();
    await this.render();
  }

  computeScale(page, rotation) {
    const unscaled = page.getViewport({ scale: 1, rotation });
    if (this.fit) {
      const maxWidth = Math.max(200, this.elements.viewer.clientWidth - 72);
      const maxHeight = Math.max(180, this.elements.viewer.clientHeight - 72);
      this.scale = clamp(
        Math.min(maxWidth / unscaled.width, maxHeight / unscaled.height),
        0.001,
        4,
      );
    }
    const safeScale = Math.min(
      this.scale,
      MAX_VIEWPORT_DIMENSION / Math.max(unscaled.width, unscaled.height, 1),
    );
    this.scale = Math.max(0.001, safeScale);
    return this.scale;
  }

  async render() {
    if (!this.document || !this.activePages.length) return;
    if (!this.elements.textEditor.hidden) {
      this.commitTextEntry();
    }
    const sequence = ++this.renderSequence;
    this.renderTask?.cancel?.();
    this.textLayerTask?.cancel?.();
    this.hideTextEntry();
    this.onStatus("Dibujando página…");

    const pageIndex = this.currentPageIndex;
    const previousPage = this.currentPage;
    const page = await this.document.getPage(pageIndex + 1);
    if (sequence !== this.renderSequence) return;
    this.currentPage = page;
    let annotations = [];
    try {
      annotations = await page.getAnnotations({ intent: "display" });
    } catch {
      annotations = [];
    }
    if (sequence !== this.renderSequence) return;

    const rotation = normalizeRotation(page.rotate + (this.rotations.get(pageIndex) || 0));
    this.lastFitViewerWidth = this.elements.viewer.clientWidth;
    this.lastFitViewerHeight = this.elements.viewer.clientHeight;
    const scale = this.computeScale(page, rotation);
    const viewport = page.getViewport({ scale, rotation });
    this.viewport = viewport;

    const {
      canvas,
      pageStack,
      textLayer,
      formLayer,
      linksLayer,
      overlay,
    } = this.elements;
    const requestedRatio = Math.min(window.devicePixelRatio || 1, 2);
    const dimensionRatio =
      MAX_CANVAS_DIMENSION / Math.max(viewport.width, viewport.height, 1);
    const areaRatio = Math.sqrt(
      MAX_CANVAS_PIXELS / Math.max(viewport.width * viewport.height, 1),
    );
    const pixelRatio = Math.max(0.01, Math.min(requestedRatio, dimensionRatio, areaRatio));

    canvas.width = Math.max(1, Math.round(viewport.width * pixelRatio));
    canvas.height = Math.max(1, Math.round(viewport.height * pixelRatio));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    pageStack.style.width = `${viewport.width}px`;
    pageStack.style.height = `${viewport.height}px`;

    for (const layer of [textLayer, formLayer, linksLayer, overlay]) {
      layer.replaceChildren();
      layer.style.width = `${viewport.width}px`;
      layer.style.height = `${viewport.height}px`;
    }
    textLayer.style.setProperty("--total-scale-factor", String(viewport.scale));
    overlay.setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`);
    overlay.setAttribute("width", String(viewport.width));
    overlay.setAttribute("height", String(viewport.height));

    const context = canvas.getContext("2d", { alpha: false });
    context.save();
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();

    const hasUnsupportedFormAppearance = annotations.some((annotation) => (
      annotation.subtype === "Widget"
      && (
        !FORM_FIELD_TYPES.has(annotation.fieldType)
        || annotation.pushButton
      )
    ));
    formLayer.classList.toggle(
      "canvas-form-appearances",
      hasUnsupportedFormAppearance,
    );

    this.renderTask = page.render({
      canvasContext: context,
      viewport,
      transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      background: "rgba(255,255,255,1)",
      annotationMode: hasUnsupportedFormAppearance
        ? AnnotationMode.ENABLE
        : AnnotationMode.ENABLE_FORMS,
    });
    try {
      await this.renderTask.promise;
    } catch (error) {
      if (error?.name !== "RenderingCancelledException") throw error;
      return;
    }
    if (sequence !== this.renderSequence) return;

    try {
      this.textLayerTask = new TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: true }),
        container: textLayer,
        viewport,
      });
      await this.textLayerTask.render();
    } catch {
      textLayer.replaceChildren();
    }
    if (sequence !== this.renderSequence) return;

    this.renderLinks(annotations, viewport);
    this.renderFormControls(annotations, viewport);
    this.renderOperations();
    this.updateLayerInteraction();
    if (previousPage && previousPage !== page) {
      try {
        previousPage.cleanup();
      } catch {
        // Resource cleanup is best-effort; the document owns the final cache.
      }
    }
    this.onStatus("Listo");
    this.emitState();
  }

  renderLinks(annotations, viewport) {
    const layer = this.elements.linksLayer;
    for (const annotation of annotations) {
      if (annotation.subtype !== "Link" || !Array.isArray(annotation.rect)) continue;
      const viewportRect = convertRectangle(viewport, annotation.rect);
      const left = Math.min(viewportRect[0], viewportRect[2]);
      const top = Math.min(viewportRect[1], viewportRect[3]);
      const width = Math.abs(viewportRect[2] - viewportRect[0]);
      const height = Math.abs(viewportRect[3] - viewportRect[1]);
      if (width < 1 || height < 1) continue;

      const link = document.createElement("button");
      link.type = "button";
      link.className = "pdf-link";
      link.style.left = `${left}px`;
      link.style.top = `${top}px`;
      link.style.width = `${width}px`;
      link.style.height = `${height}px`;
      link.setAttribute("aria-label", "Abrir enlace del PDF");

      if (annotation.url && isSafeExternalUrl(annotation.url)) {
        link.title = annotation.url;
        link.addEventListener("click", () => this.onExternal(annotation.url));
      } else if (annotation.dest) {
        link.title = "Ir al destino dentro del PDF";
        link.addEventListener("click", async () => {
          try {
            let destination = annotation.dest;
            if (typeof destination === "string") {
              destination = await this.document.getDestination(destination);
            }
            const reference = Array.isArray(destination) ? destination[0] : null;
            if (!reference) return;
            const targetPage = await this.document.getPageIndex(reference);
            const position = this.activePages.indexOf(targetPage);
            if (position >= 0) await this.goToPosition(position);
          } catch {
            this.onToast("No se pudo abrir ese destino interno.");
          }
        });
      } else {
        continue;
      }
      layer.append(link);
    }
  }

  registerFormWidget(annotation) {
    if (
      annotation?.subtype !== "Widget"
      || typeof annotation.fieldName !== "string"
      || annotation.fieldName.length === 0
      || typeof annotation.id !== "string"
    ) {
      return null;
    }
    const initialState = formStateFromAnnotation(annotation);
    if (!initialState) return null;

    const fieldName = annotation.fieldName;
    if (!this.formInitialValues.has(fieldName)) {
      this.formInitialValues.set(fieldName, cloneFormState(initialState));
      this.formFieldCount = this.formInitialValues.size;
    }

    let widgets = this.formWidgets.get(fieldName);
    if (!widgets) {
      widgets = new Map();
      this.formWidgets.set(fieldName, widgets);
    }
    const widget = {
      id: annotation.id,
      kind: initialState.kind,
      exportValue: annotation.exportValue == null
        ? null
        : String(annotation.exportValue),
      buttonValue: annotation.buttonValue == null
        ? null
        : String(annotation.buttonValue),
    };
    widgets.set(annotation.id, widget);
    if (this.formEdits.has(fieldName)) {
      this.writeFormStorageValue(widget, this.formEdits.get(fieldName));
    }
    return {
      fieldName,
      initialState,
      widget,
    };
  }

  async ensureFormWidgetIndex() {
    if (
      this.formIndexComplete
      || this.formIndexPromise
      || !this.document
      || this.formFieldCount === 0
    ) {
      return this.formIndexPromise;
    }

    const sourceDocument = this.document;
    const promise = (async () => {
      for (let pageNumber = 1; pageNumber <= sourceDocument.numPages; pageNumber += 1) {
        if (this.document !== sourceDocument) return;
        const page = await sourceDocument.getPage(pageNumber);
        try {
          const annotations = await page.getAnnotations({ intent: "display" });
          if (this.document !== sourceDocument) return;
          for (const annotation of annotations) {
            this.registerFormWidget(annotation);
          }
        } finally {
          if (page !== this.currentPage) page.cleanup?.();
        }
      }
      if (this.document === sourceDocument) {
        this.formIndexComplete = true;
      }
    })()
      .catch((error) => {
        if (this.document === sourceDocument) {
          console.warn("No se pudieron indexar todos los campos del formulario.", error);
        }
      })
      .finally(() => {
        if (this.formIndexPromise === promise) {
          this.formIndexPromise = null;
        }
      });
    this.formIndexPromise = promise;
    return promise;
  }

  writeFormStorageValue(widget, state) {
    const storage = this.document?.annotationStorage;
    if (!storage || !widget?.id) return;
    if (!state) {
      storage.remove(widget.id);
      return;
    }

    if (state.kind === "checkbox") {
      storage.setValue(widget.id, {
        value: state.value !== null && state.value === widget.exportValue,
      });
    } else if (state.kind === "radio") {
      storage.setValue(widget.id, {
        value: state.value !== null && state.value === widget.buttonValue,
      });
    } else {
      storage.setValue(widget.id, { value: state.value });
    }
  }

  updateFormStorage(fieldName) {
    const widgets = this.formWidgets.get(fieldName);
    if (!widgets) return;
    const state = this.formEdits.get(fieldName) || null;
    for (const widget of widgets.values()) {
      this.writeFormStorageValue(widget, state);
    }
  }

  currentFormState(fieldName) {
    return cloneFormState(
      this.formEdits.get(fieldName)
      || this.formInitialValues.get(fieldName),
    );
  }

  applyFormState(fieldName, requestedState, options = {}) {
    const initialState = this.formInitialValues.get(fieldName);
    if (!initialState || !requestedState || requestedState.kind !== initialState.kind) {
      return false;
    }

    const nextState = cloneFormState(requestedState);
    if (nextState.kind === "choice" && Array.isArray(nextState.value)) {
      nextState.value = nextState.value.map((value) => String(value));
    } else if (nextState.value !== null) {
      nextState.value = String(nextState.value ?? "");
    }

    const currentState = this.currentFormState(fieldName);
    if (formStatesEqual(currentState, nextState)) return false;

    const wasDirty = this.hasChanges;
    if (options.pushUndo) {
      this.pushUndo({
        kind: "form",
        fieldName,
        previous: currentState,
      });
    }

    if (formStatesEqual(initialState, nextState)) {
      this.formEdits.delete(fieldName);
    } else {
      this.formEdits.set(fieldName, nextState);
    }
    this.updateFormStorage(fieldName);
    this.syncFormControls(fieldName);
    if (this.formEdits.has(fieldName)) {
      void this.ensureFormWidgetIndex();
    }

    if (
      options.notify !== false
      && (options.pushUndo || wasDirty !== this.hasChanges)
    ) {
      this.notifyDirty();
    }
    return true;
  }

  syncFormControls(fieldName) {
    const state = this.currentFormState(fieldName);
    if (!state) return;
    for (const control of this.elements.formLayer.querySelectorAll(".pdf-form-control")) {
      if (control.dataset.formName !== fieldName) continue;
      if (state.kind === "text") {
        control.value = state.value;
      } else if (state.kind === "checkbox" || state.kind === "radio") {
        control.checked = state.value !== null
          && state.value === control.dataset.formOption;
      } else if (state.kind === "choice" && control instanceof HTMLSelectElement) {
        const values = new Set(
          Array.isArray(state.value) ? state.value : [state.value],
        );
        for (const option of control.options) {
          option.selected = values.has(option.value);
        }
      } else if (state.kind === "choice") {
        control.value = Array.isArray(state.value)
          ? (state.value[0] ?? "")
          : state.value;
      }
    }
  }

  readFormControl(control, annotation) {
    if (annotation.fieldType === "Tx") {
      return { kind: "text", value: control.value };
    }
    if (annotation.checkBox) {
      return {
        kind: "checkbox",
        value: control.checked ? String(annotation.exportValue ?? "Yes") : null,
      };
    }
    if (annotation.radioButton) {
      return {
        kind: "radio",
        value: control.checked ? String(annotation.buttonValue ?? "") : null,
      };
    }
    if (annotation.fieldType === "Ch" && control instanceof HTMLSelectElement) {
      const values = [...control.selectedOptions].map((option) => option.value);
      return {
        kind: "choice",
        value: annotation.multiSelect ? values : (values[0] ?? ""),
      };
    }
    return { kind: "choice", value: control.value };
  }

  bindFormControl(control, annotation) {
    const continuousInput = annotation.fieldType === "Tx"
      || (annotation.fieldType === "Ch" && !(control instanceof HTMLSelectElement));
    control._plumaUndoArmed = true;
    control.addEventListener("focus", () => {
      if (continuousInput) control._plumaUndoArmed = true;
    });
    const eventName = continuousInput ? "input" : "change";
    control.addEventListener(eventName, () => {
      const changed = this.applyFormState(
        annotation.fieldName,
        this.readFormControl(control, annotation),
        { pushUndo: continuousInput ? control._plumaUndoArmed : true },
      );
      if (changed && continuousInput) {
        control._plumaUndoArmed = false;
      }
    });
  }

  styleFormWidget(wrapper, control, annotation, viewport) {
    const viewportRect = convertRectangle(viewport, annotation.rect);
    const left = Math.min(viewportRect[0], viewportRect[2]);
    const top = Math.min(viewportRect[1], viewportRect[3]);
    const width = Math.abs(viewportRect[2] - viewportRect[0]);
    const height = Math.abs(viewportRect[3] - viewportRect[1]);
    if (width < 1 || height < 1) return false;

    wrapper.style.left = `${left}px`;
    wrapper.style.top = `${top}px`;
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;

    const rotation = normalizeRotation(
      Number(viewport.rotation || 0) + Number(annotation.rotation || 0),
    );
    if (rotation === 90) {
      control.style.width = `${height}px`;
      control.style.height = `${width}px`;
      control.style.transform = `translateX(${width}px) rotate(90deg)`;
    } else if (rotation === 180) {
      control.style.width = `${width}px`;
      control.style.height = `${height}px`;
      control.style.transform = `translate(${width}px, ${height}px) rotate(180deg)`;
    } else if (rotation === 270) {
      control.style.width = `${height}px`;
      control.style.height = `${width}px`;
      control.style.transform = `translateY(${height}px) rotate(270deg)`;
    } else {
      control.style.width = `${width}px`;
      control.style.height = `${height}px`;
    }

    const background = cssColor(annotation.backgroundColor);
    if (background) control.style.setProperty("--pdf-field-background", background);
    const borderWidth = Number(annotation.borderStyle?.width) || 0;
    const borderColor = cssColor(annotation.borderColor);
    if (borderWidth > 0 && borderColor) {
      control.style.borderWidth = `${Math.max(1, borderWidth * viewport.scale)}px`;
      control.style.borderColor = borderColor;
      control.style.borderStyle = annotation.borderStyle?.style === 2 ? "dashed" : "solid";
    }

    const appearance = annotation.defaultAppearanceData;
    const fontSize = Number(appearance?.fontSize);
    if (fontSize > 0) {
      control.style.fontSize = `${Math.max(6, fontSize * viewport.scale)}px`;
    }
    const fontColor = cssColor(appearance?.fontColor);
    if (fontColor) control.style.color = fontColor;
    const alignments = ["left", "center", "right"];
    if (alignments[annotation.textAlignment]) {
      control.style.textAlign = alignments[annotation.textAlignment];
    }
    return true;
  }

  createFormControl(annotation, viewport) {
    const registration = this.registerFormWidget(annotation);
    if (!registration || annotation.hidden || !Array.isArray(annotation.rect)) {
      return null;
    }
    const { fieldName, initialState } = registration;
    const state = this.currentFormState(fieldName) || initialState;
    const wrapper = document.createElement("span");
    wrapper.className = "pdf-form-widget";
    wrapper.dataset.annotationId = annotation.id;

    let control;
    if (annotation.fieldType === "Tx") {
      control = annotation.multiLine
        ? document.createElement("textarea")
        : document.createElement("input");
      if (!annotation.multiLine) {
        control.type = annotation.password ? "password" : "text";
      }
      control.value = state.value;
      control.autocomplete = "off";
      control.spellcheck = false;
      if (Number(annotation.maxLen) > 0) {
        control.maxLength = Number(annotation.maxLen);
      }
      control.readOnly = this.passwordProtected || Boolean(annotation.readOnly);
      control.classList.add("pdf-form-text");
    } else if (annotation.checkBox || annotation.radioButton) {
      control = document.createElement("input");
      control.type = annotation.radioButton ? "radio" : "checkbox";
      const option = String(
        annotation.radioButton
          ? annotation.buttonValue ?? ""
          : annotation.exportValue ?? "Yes",
      );
      control.dataset.formOption = option;
      control.checked = state.value !== null && state.value === option;
      control.name = `pdf-form-${fieldName}`;
      control.disabled = this.passwordProtected || Boolean(annotation.readOnly);
      control.classList.add(
        annotation.radioButton ? "pdf-form-radio" : "pdf-form-checkbox",
      );
    } else if (annotation.fieldType === "Ch") {
      const editableCombo = annotation.combo
        && (Number(annotation.fieldFlags) & CHOICE_EDIT_FLAG) !== 0;
      if (editableCombo) {
        control = document.createElement("input");
        control.type = "text";
        const list = document.createElement("datalist");
        const listId = `pdf-form-options-${++this.formControlCounter}`;
        list.id = listId;
        for (const option of annotation.options || []) {
          const item = document.createElement("option");
          item.value = String(option.exportValue ?? option.displayValue ?? "");
          item.label = String(option.displayValue ?? option.exportValue ?? "");
          list.append(item);
        }
        control.setAttribute("list", listId);
        control.value = Array.isArray(state.value)
          ? (state.value[0] ?? "")
          : state.value;
        wrapper.append(list);
      } else {
        control = document.createElement("select");
        control.multiple = Boolean(annotation.multiSelect);
        for (const option of annotation.options || []) {
          const item = document.createElement("option");
          item.value = String(option.exportValue ?? option.displayValue ?? "");
          item.textContent = String(option.displayValue ?? option.exportValue ?? "");
          control.append(item);
        }
        const values = new Set(
          Array.isArray(state.value) ? state.value : [state.value],
        );
        for (const option of control.options) {
          option.selected = values.has(option.value);
        }
      }
      control.disabled = this.passwordProtected || Boolean(annotation.readOnly);
      control.classList.add("pdf-form-choice");
    } else {
      return null;
    }

    control.classList.add("pdf-form-control");
    control.dataset.formName = fieldName;
    control.dataset.formKind = state.kind;
    control.required = Boolean(annotation.required);
    control.setAttribute(
      "aria-label",
      String(annotation.alternativeText || fieldName),
    );
    control.title = String(annotation.alternativeText || fieldName);
    if (!this.styleFormWidget(wrapper, control, annotation, viewport)) {
      return null;
    }
    this.bindFormControl(control, annotation);
    wrapper.append(control);
    return wrapper;
  }

  renderFormControls(annotations, viewport) {
    const layer = this.elements.formLayer;
    for (const annotation of annotations) {
      const widget = this.createFormControl(annotation, viewport);
      if (widget) layer.append(widget);
    }
  }

  updateLayerInteraction() {
    const editing = this.tool !== "select";
    this.elements.overlay.style.pointerEvents = editing ? "all" : "none";
    this.elements.textLayer.classList.toggle("selection-disabled", editing);
    this.elements.formLayer.classList.toggle(
      "forms-disabled",
      editing || this.passwordProtected,
    );
    this.elements.linksLayer.classList.toggle("links-disabled", editing);
    this.elements.pageStack.dataset.tool = this.tool;
  }

  operationsForCurrentPage() {
    const pageIndex = this.currentPageIndex;
    return this.operations.filter((operation) => operation.pageIndex === pageIndex);
  }

  renderOperations() {
    const overlay = this.elements.overlay;
    overlay.replaceChildren();
    if (!this.viewport) return;

    const layerOrder = { highlight: 0, ink: 1, "form-field": 2, text: 3 };
    const operations = this.operationsForCurrentPage().sort(
      (first, second) => layerOrder[first.type] - layerOrder[second.type],
    );
    for (const operation of operations) {
      let element;
      if (operation.type === "highlight") {
        const rectangle = convertRectangle(this.viewport, [
          operation.x,
          operation.y,
          operation.x + operation.width,
          operation.y + operation.height,
        ]);
        element = makeSvgElement("rect", {
          x: Math.min(rectangle[0], rectangle[2]),
          y: Math.min(rectangle[1], rectangle[3]),
          width: Math.abs(rectangle[2] - rectangle[0]),
          height: Math.abs(rectangle[3] - rectangle[1]),
          fill: operation.color,
          "fill-opacity": operation.opacity,
          rx: 2,
        });
      } else if (operation.type === "ink") {
        const points = operation.points
          .map(([x, y]) => this.viewport.convertToViewportPoint(x, y).join(","))
          .join(" ");
        element = makeSvgElement("polyline", {
          points,
          fill: "none",
          stroke: operation.color,
          "stroke-opacity": operation.opacity,
          "stroke-width": operation.width * this.viewport.scale,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        });
      } else if (operation.type === "form-field") {
        const rectangle = convertRectangle(this.viewport, [
          operation.x,
          operation.y,
          operation.x + operation.width,
          operation.y + operation.height,
        ]);
        element = makeSvgElement("rect", {
          x: Math.min(rectangle[0], rectangle[2]),
          y: Math.min(rectangle[1], rectangle[3]),
          width: Math.abs(rectangle[2] - rectangle[0]),
          height: Math.abs(rectangle[3] - rectangle[1]),
          rx: 2,
        });
        element.classList.add("form-field-placeholder");
      } else if (operation.type === "text") {
        const [x, y] = this.viewport.convertToViewportPoint(operation.x, operation.y);
        element = makeSvgElement("text", {
          x,
          y,
          fill: operation.color,
          "font-family": "Arial, sans-serif",
          "font-size": operation.size * this.viewport.scale,
        });
        const lines = String(operation.text).split(/\r?\n/);
        lines.forEach((line, index) => {
          const span = makeSvgElement("tspan", {
            x,
            dy: index === 0 ? 0 : operation.size * this.viewport.scale * 1.2,
          });
          span.textContent = line || " ";
          element.append(span);
        });
      }
      if (!element) continue;
      element.dataset.opId = operation.id;
      element.classList.add("pdf-operation");
      if (this.tool === "eraser") element.classList.add("erasable");
      overlay.append(element);
    }
  }

  bindPointerEvents() {
    const overlay = this.elements.overlay;
    overlay.addEventListener("pointerdown", (event) => this.handlePointerDown(event));
    overlay.addEventListener("pointermove", (event) => this.handlePointerMove(event));
    overlay.addEventListener("pointerup", (event) => this.handlePointerUp(event));
    overlay.addEventListener("pointercancel", () => this.cancelPointerSession());
    // Mouse events are a compatibility fallback for older system WebViews and
    // automation/accessibility drivers that do not emit PointerEvents.
    overlay.addEventListener("mousedown", (event) => this.handlePointerDown(event));
    overlay.addEventListener("mousemove", (event) => this.handlePointerMove(event));
    overlay.addEventListener("mouseup", (event) => this.handlePointerUp(event));
    overlay.addEventListener("click", (event) => {
      if (
        this.viewport
        && this.tool === "text"
        && this.elements.textEditor.hidden
      ) {
        this.showTextEntry(this.localPoint(event));
      }
    });
  }

  localPoint(event) {
    const rectangle = this.elements.overlay.getBoundingClientRect();
    return {
      x: ((event.clientX - rectangle.left) / rectangle.width) * this.viewport.width,
      y: ((event.clientY - rectangle.top) / rectangle.height) * this.viewport.height,
    };
  }

  handlePointerDown(event) {
    if (!this.viewport || event.button !== 0) return;
    const pointerId = Number.isInteger(event.pointerId) ? event.pointerId : "mouse";
    if (this.pointerSession) return;
    const point = this.localPoint(event);

    if (this.tool === "eraser") {
      const operationId =
        event.target instanceof Element
          ? event.target.closest("[data-op-id]")?.dataset?.opId
          : null;
      if (operationId) {
        const index = this.operations.findIndex((operation) => operation.id === operationId);
        if (index >= 0) {
          const [operation] = this.operations.splice(index, 1);
          this.pushUndo({ kind: "remove", operation, index });
          this.notifyDirty();
          this.renderOperations();
        }
      }
      return;
    }

    if (this.tool === "text") {
      if (!this.elements.textEditor.hidden) return;
      this.showTextEntry(point);
      return;
    }

    if (!["field", "highlight", "ink"].includes(this.tool)) return;
    event.preventDefault();
    if (pointerId !== "mouse") {
      this.elements.overlay.setPointerCapture?.(pointerId);
    }
    this.pointerSession = {
      pointerId,
      tool: this.tool,
      start: point,
      points: [point],
    };
    this.renderPreview();
  }

  handlePointerMove(event) {
    const pointerId = Number.isInteger(event.pointerId) ? event.pointerId : "mouse";
    if (!this.pointerSession || pointerId !== this.pointerSession.pointerId) return;
    const point = this.localPoint(event);
    if (["field", "highlight"].includes(this.pointerSession.tool)) {
      this.pointerSession.current = point;
    } else {
      const previous =
        this.pointerSession.points[this.pointerSession.points.length - 1];
      if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 1.5) {
        this.pointerSession.points.push(point);
      }
    }
    this.renderPreview();
  }

  handlePointerUp(event) {
    const pointerId = Number.isInteger(event.pointerId) ? event.pointerId : "mouse";
    if (!this.pointerSession || pointerId !== this.pointerSession.pointerId) return;
    const session = this.pointerSession;
    this.pointerSession = null;
    if (pointerId !== "mouse") {
      this.elements.overlay.releasePointerCapture?.(pointerId);
    }

    if (session.tool === "highlight") {
      const end = session.current || this.localPoint(event);
      if (Math.abs(end.x - session.start.x) >= 4 && Math.abs(end.y - session.start.y) >= 4) {
        const [pdfX1, pdfY1] = this.viewport.convertToPdfPoint(session.start.x, session.start.y);
        const [pdfX2, pdfY2] = this.viewport.convertToPdfPoint(end.x, end.y);
        this.addOperation({
          type: "highlight",
          x: Math.min(pdfX1, pdfX2),
          y: Math.min(pdfY1, pdfY2),
          width: Math.abs(pdfX2 - pdfX1),
          height: Math.abs(pdfY2 - pdfY1),
          color: this.color,
          opacity: 0.36,
        });
      }
    } else if (session.tool === "field") {
      const end = session.current || this.localPoint(event);
      if (
        Math.abs(end.x - session.start.x) >= 24
        && Math.abs(end.y - session.start.y) >= 14
      ) {
        const [pdfX1, pdfY1] = this.viewport.convertToPdfPoint(
          session.start.x,
          session.start.y,
        );
        const [pdfX2, pdfY2] = this.viewport.convertToPdfPoint(end.x, end.y);
        this.addOperation({
          type: "form-field",
          x: Math.min(pdfX1, pdfX2),
          y: Math.min(pdfY1, pdfY2),
          width: Math.abs(pdfX2 - pdfX1),
          height: Math.abs(pdfY2 - pdfY1),
          fieldName: "Campo rellenable",
        });
        this.onToast(
          "Campo AcroForm creado. Guarda el PDF para empezar a rellenarlo.",
        );
      }
    } else if (session.points.length >= 2) {
      this.addOperation({
        type: "ink",
        points: session.points.map((point) => this.viewport.convertToPdfPoint(point.x, point.y)),
        color: this.color,
        width: this.toolSize / Math.max(this.viewport.scale, 0.1),
        opacity: 0.95,
      });
    }
    this.clearPreview();
    this.renderOperations();
  }

  cancelPointerSession() {
    this.pointerSession = null;
    this.clearPreview();
    this.renderOperations();
  }

  renderPreview() {
    // Pointer movement can fire much faster than the display refresh rate.
    // Preserve the already-rendered operation nodes and replace only the tiny
    // transient preview instead of rebuilding the entire SVG on every event.
    this.clearPreview();
    const session = this.pointerSession;
    if (!session) return;
    let element;
    if (session.tool === "highlight") {
      const end = session.current || session.start;
      element = makeSvgElement("rect", {
        id: "operation-preview",
        x: Math.min(session.start.x, end.x),
        y: Math.min(session.start.y, end.y),
        width: Math.abs(end.x - session.start.x),
        height: Math.abs(end.y - session.start.y),
        fill: this.color,
        "fill-opacity": 0.36,
        rx: 2,
      });
    } else if (session.tool === "field") {
      const end = session.current || session.start;
      element = makeSvgElement("rect", {
        id: "operation-preview",
        class: "form-field-preview",
        x: Math.min(session.start.x, end.x),
        y: Math.min(session.start.y, end.y),
        width: Math.abs(end.x - session.start.x),
        height: Math.abs(end.y - session.start.y),
        rx: 2,
      });
    } else {
      element = makeSvgElement("polyline", {
        id: "operation-preview",
        points: session.points.map((point) => `${point.x},${point.y}`).join(" "),
        fill: "none",
        stroke: this.color,
        "stroke-width": this.toolSize,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      });
    }
    this.elements.overlay.append(element);
  }

  clearPreview() {
    this.elements.overlay.querySelector("#operation-preview")?.remove();
  }

  nextOperationId() {
    this.operationCounter += 1;
    return `op-${Date.now().toString(36)}-${this.operationCounter.toString(36)}`;
  }

  addOperation(operation) {
    const complete = {
      ...operation,
      id: this.nextOperationId(),
      pageIndex: this.currentPageIndex,
    };
    this.operations.push(complete);
    this.pushUndo({ kind: "add", operationId: complete.id });
    this.notifyDirty();
  }

  bindTextEntry() {
    const { textInput } = this.elements;
    textInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.hideTextEntry();
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.commitTextEntry();
      }
    });
    textInput.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (this.elements.textEditor.hidden) return;
        this.commitTextEntry();
      }, 0);
    });
  }

  showTextEntry(point) {
    const { textEditor, textInput } = this.elements;
    const fontSize = clamp(this.toolSize * 4 + 8, 10, 40);
    const [pdfX, pdfY] = this.viewport.convertToPdfPoint(
      point.x,
      point.y + fontSize * this.viewport.scale,
    );
    this.pendingTextPoint = { x: pdfX, y: pdfY, size: fontSize };
    const pageRectangle = this.elements.pageStack.getBoundingClientRect();
    const editorWidth = 270;
    const editorHeight = 126;
    const left = clamp(pageRectangle.left + point.x + 8, 8, window.innerWidth - editorWidth - 8);
    const top = clamp(pageRectangle.top + point.y + 8, 8, window.innerHeight - editorHeight - 8);
    textEditor.hidden = false;
    textEditor.style.left = `${left}px`;
    textEditor.style.top = `${top}px`;
    textEditor.style.transform = "none";
    textEditor.style.setProperty("--entry-color", this.color);
    textInput.value = "";
    textInput.style.fontSize = `${fontSize * this.viewport.scale}px`;
    textInput.focus();
  }

  hideTextEntry() {
    this.pendingTextPoint = null;
    this.elements.textEditor.hidden = true;
    this.elements.textInput.value = "";
  }

  commitTextEntry() {
    const text = this.elements.textInput.value.trim();
    const point = this.pendingTextPoint;
    this.hideTextEntry();
    if (!text || !point) return;
    this.addOperation({
      type: "text",
      x: point.x,
      y: point.y,
      text: text.slice(0, 4000),
      size: point.size,
      color: this.color,
      lineHeight: point.size * 1.2,
    });
    this.renderOperations();
  }

  async search(query) {
    if (!this.elements.textEditor.hidden) this.commitTextEntry();
    const normalizedQuery = normalizeSearch(query).trim();
    if (!this.document || !normalizedQuery) {
      // Clearing the field also cancels any page extraction already in flight.
      this.searchSequence += 1;
      this.searchQuery = "";
      this.searchResults = [];
      this.searchPosition = -1;
      this.emitState();
      return;
    }

    if (normalizedQuery === this.searchQuery && this.searchResults.length) {
      await this.nextSearchResult();
      return;
    }

    const sequence = ++this.searchSequence;
    this.searchQuery = normalizedQuery;
    this.searchResults = [];
    this.searchPosition = -1;
    this.onStatus("Buscando texto…");
    this.emitState();

    const sourceDocument = this.document;
    const pages = [...this.activePages];
    const results = await mapWithConcurrency(
      pages,
      async (pageIndex) => {
        if (
          sequence !== this.searchSequence
          || this.document !== sourceDocument
        ) {
          return null;
        }

        let text = this.searchTextCache.get(pageIndex);
        if (text === null) {
          const page = await sourceDocument.getPage(pageIndex + 1);
          try {
            if (
              sequence !== this.searchSequence
              || this.document !== sourceDocument
            ) {
              return null;
            }
            const content = await page.getTextContent();
            if (
              sequence !== this.searchSequence
              || this.document !== sourceDocument
            ) {
              return null;
            }
            text = normalizeSearch(
              content.items.map((item) => item.str || "").join(" "),
            );
            this.searchTextCache.set(pageIndex, text);
          } finally {
            // Search may touch hundreds of pages. Drop operator/font resources
            // as soon as text extraction completes, except for the page that
            // remains painted in the viewer.
            if (page !== this.currentPage) page.cleanup?.();
          }
        }
        const matches = countOccurrences(text, normalizedQuery);
        return matches ? { pageIndex, matches } : null;
      },
      SEARCH_PAGE_CONCURRENCY,
    );

    if (
      sequence !== this.searchSequence
      || this.document !== sourceDocument
    ) return;
    this.searchResults = results.filter(Boolean);
    this.onStatus("Listo");
    if (this.searchResults.length) {
      this.searchPosition = 0;
      const position = this.activePages.indexOf(this.searchResults[0].pageIndex);
      if (position >= 0) {
        this.currentPosition = position;
        await this.render();
      }
    } else {
      this.onToast("No se encontró ese texto.");
      this.emitState();
    }
  }

  async nextSearchResult() {
    if (!this.searchResults.length) return;
    this.searchPosition = (this.searchPosition + 1) % this.searchResults.length;
    const pageIndex = this.searchResults[this.searchPosition].pageIndex;
    const position = this.activePages.indexOf(pageIndex);
    if (position >= 0) {
      this.currentPosition = position;
      await this.render();
    }
  }

  async destroyDocument() {
    this.renderSequence += 1;
    this.searchSequence += 1;
    this.renderTask?.cancel?.();
    this.textLayerTask?.cancel?.();
    this.rangeTransport?.abort();
    try {
      await this.loadingTask?.destroy?.();
    } catch {
      // The worker may already be gone.
    }
    this.document = null;
    this.loadingTask = null;
    this.rangeTransport = null;
    this.currentPage = null;
    this.viewport = null;
  }

  async destroy() {
    await this.destroyDocument();
    this.resetEdits();
    this.elements.canvas.width = 1;
    this.elements.canvas.height = 1;
    this.elements.textLayer.replaceChildren();
    this.elements.formLayer.replaceChildren();
    this.elements.linksLayer.replaceChildren();
    this.elements.overlay.replaceChildren();
  }
}
