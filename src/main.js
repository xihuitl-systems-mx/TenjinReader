import { PdfByteSourceRangeTransport, PdfController } from "./pdf-controller.js";
import {
  getLaunchDocumentPath,
  getPathStats,
  getPresentationPreviewCacheBackend,
  copyPath,
  createTemporaryDirectory,
  initializeNative,
  isNative,
  joinPath,
  movePath,
  onWindowClose,
  openDocumentDialog,
  openExternal,
  openFilesDialog,
  executeCommand,
  readBinarySource,
  readDescriptorBytes,
  readPath,
  removeFilePath,
  removeTemporaryDirectory,
  saveFileDialog,
  savePdfDialog,
  selectFolderDialog,
  setTitle,
  sourceName,
  writePath,
  writePathAtomic,
} from "./native.js";
import { sameDocumentPath, siblingDocumentPath } from "./document-paths.js";
import { syncAnnotationColorIndicator } from "./annotation-controls.js";
import {
  PDFJS_ASSET_OPTIONS,
  PDF_RANGE_CHUNK_BYTES,
  createMemoryPdfByteSource,
} from "./pdf-source.js";
import {
  baseName,
  canScrollVertically,
  formatFileSize,
  getDocumentType,
  toExactArrayBuffer,
  wheelDeltaToPixels,
} from "./utils.js";

const WHEEL_PAGE_THRESHOLD = 48;
const WHEEL_GESTURE_IDLE_MS = 220;
const WHEEL_EDGE_TOLERANCE = 16;

const byId = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Falta el elemento de interfaz #${id}.`);
  return element;
};

const ui = {
  app: byId("app"),
  welcome: byId("welcome-screen"),
  workspace: byId("document-workspace"),
  dropZone: byId("drop-zone"),
  fileInput: byId("file-input"),
  openButton: byId("open-btn"),
  saveSplit: byId("save-split"),
  saveButton: byId("save-btn"),
  saveMenuButton: byId("save-menu-btn"),
  saveMenu: byId("save-menu"),
  saveAsButton: byId("save-as-btn"),
  convertButton: byId("convert-btn"),
  title: byId("document-title"),
  titleInput: byId("document-title-input"),
  dirty: byId("dirty-indicator"),
  fileKind: byId("file-kind"),
  fileMeta: byId("file-meta"),
  readOnly: byId("readonly-badge"),
  readOnlyLabel: byId("readonly-label"),
  toolbar: byId("pdf-toolbar"),
  editTools: document.querySelector(".edit-tools"),
  styleControls: byId("style-controls"),
  historyTools: document.querySelector(".history-tools"),
  searchControl: document.querySelector(".search-control"),
  selectTool: byId("tool-select"),
  textTool: byId("tool-text"),
  fieldTool: byId("tool-field"),
  highlightTool: byId("tool-highlight"),
  inkTool: byId("tool-ink"),
  eraserTool: byId("tool-eraser"),
  undoButton: byId("undo-btn"),
  rotateButton: byId("rotate-btn"),
  deleteButton: byId("delete-btn"),
  organizeButton: byId("organize-btn"),
  signButton: byId("sign-btn"),
  documentTools: document.querySelector(".document-tools"),
  colorControl: byId("color-control"),
  sizeControl: byId("size-control"),
  sizeValue: byId("size-value"),
  previousButton: byId("prev-page-btn"),
  pageInput: byId("page-input"),
  pageTotal: byId("page-total"),
  nextButton: byId("next-page-btn"),
  zoomOutButton: byId("zoom-out-btn"),
  zoomValue: byId("zoom-value"),
  zoomInButton: byId("zoom-in-btn"),
  fitButton: byId("fit-btn"),
  searchInput: byId("search-input"),
  searchCount: byId("search-count"),
  viewer: byId("viewer"),
  pdfViewer: byId("pdf-viewer"),
  pdfPage: byId("pdf-page"),
  pdfCanvas: byId("pdf-canvas"),
  textLayer: byId("text-layer"),
  formLayer: byId("form-layer"),
  linksLayer: byId("links-layer"),
  overlay: byId("annotation-overlay"),
  pptxViewer: byId("pptx-viewer"),
  pptxCanvas: byId("pptx-canvas"),
  statusPrimary: byId("status-primary"),
  statusIndicator: byId("status-indicator"),
  statusMessage: byId("status-message"),
  stats: byId("document-stats"),
  loading: byId("loading-overlay"),
  loadingMessage: byId("loading-message"),
  loadingDetail: byId("loading-detail"),
  toast: byId("toast"),
  toastMessage: byId("toast-message"),
  toastClose: byId("toast-close-btn"),
  textEditor: byId("text-entry-editor"),
  textInput: byId("text-entry-input"),
  textCancel: byId("text-entry-cancel"),
  textConfirm: byId("text-entry-confirm"),
  mergePdfButton: byId("merge-pdf-btn"),
  splitPdfButton: byId("split-pdf-btn"),
  compressPdfButton: byId("compress-pdf-btn"),
  pdfA4Button: byId("pdfa4-pdf-btn"),
  toPdfButton: byId("to-pdf-btn"),
  unlockPdfButton: byId("unlock-pdf-btn"),
  protectPdfButton: byId("protect-pdf-btn"),
  toolDialog: byId("tool-dialog"),
  toolDialogForm: byId("tool-dialog-form"),
  toolDialogTitle: byId("tool-dialog-title"),
  toolDialogDescription: byId("tool-dialog-description"),
  toolDialogBody: byId("tool-dialog-body"),
  toolDialogClose: byId("tool-dialog-close"),
  toolDialogCancel: byId("tool-dialog-cancel"),
  toolDialogPrimary: byId("tool-dialog-primary"),
};

let activeDocument = null;
let toastTimer = 0;
let resizeTimer = 0;
let busy = false;
let wheelGestureTimer = 0;
let wheelGestureDirection = 0;
let wheelGestureDelta = 0;
let wheelGestureLatched = false;
let wheelNavigationInProgress = false;
let renamingDocument = false;
let documentRenamePromise = null;

function status(message, kind = "ready") {
  const normalizedMessage = String(message || "").trim();
  const visibleMessage = normalizedMessage.toLocaleLowerCase() === "listo"
    ? ""
    : normalizedMessage;
  ui.statusMessage.textContent = visibleMessage;
  ui.statusPrimary.hidden = !visibleMessage;
  ui.statusIndicator.classList.toggle("is-busy", kind === "busy");
  ui.statusIndicator.classList.toggle("is-error", kind === "error");
}

function showLoading(message, detail = "Esto debería tardar solo un momento") {
  busy = true;
  ui.app.classList.add("is-busy");
  ui.loadingMessage.textContent = message;
  ui.loadingDetail.textContent = detail;
  ui.loading.hidden = false;
  status(message, "busy");
}

function hideLoading() {
  busy = false;
  ui.app.classList.remove("is-busy");
  ui.loading.hidden = true;
  if (ui.statusIndicator.classList.contains("is-busy")) {
    status("");
  }
}

function showToast(message, isError = false) {
  window.clearTimeout(toastTimer);
  ui.toastMessage.textContent = message;
  ui.toast.classList.toggle("is-error", isError);
  ui.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    ui.toast.hidden = true;
  }, isError ? 5500 : 3200);
}

function showToolDialog({
  title,
  description = "",
  primaryLabel = "Continuar",
  render,
  collect = () => true,
}) {
  if (ui.toolDialog.open) ui.toolDialog.close();
  // Keep the document behind the modal immutable until the choice resolves.
  // This also blocks global shortcuts such as Ctrl+O/Ctrl+S, while controls
  // inside the dialog (for example "Añadir otro PDF") remain available.
  busy = true;
  ui.app.classList.add("is-busy");
  ui.toolDialogTitle.textContent = title;
  ui.toolDialogDescription.textContent = description;
  ui.toolDialogBody.replaceChildren();
  ui.toolDialogPrimary.textContent = primaryLabel || "Continuar";
  ui.toolDialogPrimary.hidden = !primaryLabel;

  return new Promise((resolve, reject) => {
    const listeners = new AbortController();
    let settled = false;
    const clearSensitiveFields = () => {
      for (const input of ui.toolDialogBody.querySelectorAll('input[type="password"]')) {
        input.value = "";
      }
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      listeners.abort();
      clearSensitiveFields();
      if (ui.toolDialog.open) ui.toolDialog.close();
      busy = false;
      ui.app.classList.remove("is-busy");
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      listeners.abort();
      clearSensitiveFields();
      if (ui.toolDialog.open) ui.toolDialog.close();
      busy = false;
      ui.app.classList.remove("is-busy");
      reject(error);
    };

    try {
      render?.(ui.toolDialogBody, finish);
    } catch (error) {
      fail(error);
      return;
    }
    ui.toolDialogForm.addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        const value = collect(ui.toolDialogBody);
        if (value !== undefined) finish(value);
      } catch (error) {
        showToast(cleanErrorMessage(error), true);
      }
    }, { signal: listeners.signal });
    for (const button of [ui.toolDialogClose, ui.toolDialogCancel]) {
      button.addEventListener("click", () => finish(null), {
        signal: listeners.signal,
      });
    }
    ui.toolDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    }, { signal: listeners.signal });
    try {
      ui.toolDialog.showModal();
    } catch (error) {
      fail(error);
    }
  });
}

function chooseToolOption(title, description, choices) {
  return showToolDialog({
    title,
    description,
    primaryLabel: null,
    render(body, finish) {
      const grid = document.createElement("div");
      grid.className = "dialog-choice-grid";
      for (const choice of choices) {
        const button = document.createElement("button");
        const label = document.createElement("strong");
        const detail = document.createElement("small");
        button.type = "button";
        button.className = "dialog-choice";
        label.textContent = choice.label;
        detail.textContent = choice.detail || "";
        button.append(label, detail);
        button.addEventListener("click", () => finish(choice.value));
        grid.append(button);
      }
      body.append(grid);
    },
  });
}

function runDocumentAction(action) {
  return Promise.resolve()
    .then(action)
    .catch((error) => {
      status("No se pudo completar la acción", "error");
      showToast(cleanErrorMessage(error), true);
      console.error(error);
    });
}

function cleanErrorMessage(error) {
  const message = String(error?.message || error || "Ocurrió un error inesperado.")
    .replace(/\s+/g, " ")
    .trim();
  if ([
    "INVALID_PASSWORD",
    "NOT_PROTECTED",
    "ALREADY_PROTECTED",
    "WEAK_PASSWORD",
    "INSUFFICIENT_PERMISSIONS",
    "SIGNED_PDF_UNSUPPORTED",
    "UNSUPPORTED_ENCRYPTION",
    "INVALID_INPUT",
    "OPERATION_FAILED",
  ].includes(error?.code)) {
    return message.slice(0, 240);
  }
  if (/password|contrase|encrypted|cifrad/iu.test(message)) {
    return "No se pudo abrir el documento protegido. Comprueba la contraseña.";
  }
  if (/invalid pdf|missing pdf|cabecera|header/iu.test(message)) {
    return "El archivo no parece ser un PDF válido.";
  }
  if (/out of memory|array buffer|allocation failed|invalid typed array length|memoria insuficiente/iu.test(message)) {
    return "No hay memoria disponible para abrir o transformar este PDF. Cierra otras aplicaciones e inténtalo de nuevo.";
  }
  return message.slice(0, 240);
}

function suggestedEditedName(name) {
  const stem = String(name || "documento.pdf").replace(/\.pdf$/iu, "");
  return `${stem}-editado.pdf`;
}

function canRenameActiveDocument() {
  if (!activeDocument) return false;
  if (activeDocument.type === "pdf") return !activeDocument.readOnly;
  return Boolean(
    activeDocument.type === "pptx"
    && isNative
    && typeof activeDocument.path === "string",
  );
}

function currentDocumentExtension() {
  const match = baseName(activeDocument?.name || "").match(/(\.[^.]+)$/u);
  return match?.[1] || (activeDocument?.type === "pdf" ? ".pdf" : "");
}

function validatedDocumentName(value) {
  let name = String(value || "").trim().replace(/[. ]+$/u, "");
  if (!name) throw new Error("Escribe un nombre para el documento.");
  if (/[\u0000-\u001f<>:"\/\\|?*]/u.test(name)) {
    throw new Error('El nombre no puede contener < > : " / \\ | ? *');
  }

  const extension = currentDocumentExtension();
  if (extension && !name.toLocaleLowerCase().endsWith(extension.toLocaleLowerCase())) {
    name += extension;
  }
  const stem = extension ? name.slice(0, -extension.length) : name;
  if (!stem || stem === ".") throw new Error("Escribe un nombre para el documento.");
  const deviceStem = stem.split(".", 1)[0];
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(deviceStem)) {
    throw new Error("Ese nombre está reservado por Windows.");
  }
  if (new TextEncoder().encode(name).byteLength > 240) {
    throw new Error("El nombre es demasiado largo.");
  }
  return name;
}

function beginDocumentRename() {
  if (!canRenameActiveDocument() || renamingDocument) return;
  renamingDocument = true;
  ui.titleInput.value = activeDocument.name;
  ui.title.hidden = true;
  ui.titleInput.hidden = false;
  ui.titleInput.focus();
  const extension = currentDocumentExtension();
  const selectionEnd = extension
    ? Math.max(0, ui.titleInput.value.length - extension.length)
    : ui.titleInput.value.length;
  ui.titleInput.setSelectionRange(0, selectionEnd);
}

async function renamePresentationOnDisk(nextName) {
  const documentToRename = activeDocument;
  const sourcePath = documentToRename?.path;
  if (
    !documentToRename
    || documentToRename.type !== "pptx"
    || !isNative
    || typeof sourcePath !== "string"
  ) {
    throw new Error("Esta presentación no se puede renombrar en disco.");
  }

  showLoading("Cambiando nombre…", "Actualizando la presentación en su carpeta original");
  try {
    const destination = siblingDocumentPath(sourcePath, nextName);
    const samePath = sameDocumentPath(sourcePath, destination, runtimePlatform());
    const destinationStats = samePath ? null : await getPathStats(destination);
    let overwrite = false;
    if (destinationStats) {
      if (!destinationStats.isFile) {
        throw new Error("La nueva ruta está ocupada por una carpeta.");
      }
      overwrite = window.confirm(
        `Ya existe "${nextName}". ¿Quieres reemplazar ese archivo?`,
      );
      if (!overwrite) {
        status("Cambio de nombre cancelado");
        return false;
      }
    }

    await movePath(sourcePath, destination, { overwrite });
    if (activeDocument !== documentToRename) {
      throw new Error("El documento activo cambió antes de terminar el renombrado.");
    }
    documentToRename.path = destination;
    documentToRename.name = nextName;
    documentToRename.nameDirty = false;
    documentToRename.dirty = false;
    status("Presentación renombrada");
    showToast("La presentación se renombró en su carpeta original.");
    return true;
  } finally {
    hideLoading();
  }
}

async function waitForDocumentRename() {
  const pendingRename = documentRenamePromise;
  if (!pendingRename) return;
  try {
    await pendingRename;
  } catch {
    // finishDocumentRename reports the actionable error to the user.
  }
}

async function finishDocumentRename(commit = true) {
  if (!renamingDocument) return true;
  let nextName = activeDocument?.name || "";
  if (commit) {
    try {
      nextName = validatedDocumentName(ui.titleInput.value);
    } catch (error) {
      showToast(cleanErrorMessage(error), true);
      window.requestAnimationFrame(() => ui.titleInput.focus());
      return false;
    }
  }

  renamingDocument = false;
  ui.titleInput.hidden = true;
  ui.title.hidden = false;
  if (commit && activeDocument && nextName !== activeDocument.name) {
    if (activeDocument.type === "pptx") {
      const renamePromise = renamePresentationOnDisk(nextName);
      documentRenamePromise = renamePromise;
      try {
        await renamePromise;
      } catch (error) {
        showToast(cleanErrorMessage(error), true);
        status("No se pudo cambiar el nombre", "error");
        console.error(error);
      } finally {
        if (documentRenamePromise === renamePromise) documentRenamePromise = null;
      }
    } else {
      activeDocument.name = nextName;
      activeDocument.nameDirty = true;
      activeDocument.dirty = true;
      status("Nombre listo · Guardar reemplazará el nombre anterior");
    }
  }
  setDocumentIdentity();
  return true;
}

function saveMenuIsOpen() {
  return !ui.saveMenu.hidden;
}

function closeSaveMenu({ restoreFocus = false } = {}) {
  if (!saveMenuIsOpen()) return;
  ui.saveMenu.hidden = true;
  ui.saveMenuButton.setAttribute("aria-expanded", "false");
  if (restoreFocus && !ui.saveMenuButton.disabled) ui.saveMenuButton.focus();
}

function openSaveMenu({ focusLast = false } = {}) {
  if (ui.saveMenuButton.disabled || ui.saveAsButton.disabled) return;
  ui.saveMenu.hidden = false;
  ui.saveMenuButton.setAttribute("aria-expanded", "true");
  const items = [...ui.saveMenu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  const item = focusLast ? items.at(-1) : items[0];
  window.requestAnimationFrame(() => item?.focus());
}

function toggleSaveMenu() {
  if (saveMenuIsOpen()) closeSaveMenu({ restoreFocus: true });
  else openSaveMenu();
}

function setDocumentIdentity() {
  if (!activeDocument) {
    renamingDocument = false;
    ui.title.hidden = false;
    ui.titleInput.hidden = true;
    ui.title.textContent = "Sin documento";
    ui.title.disabled = true;
    ui.title.title = "";
    ui.fileKind.hidden = true;
    ui.fileMeta.hidden = true;
    ui.dirty.hidden = true;
    void setTitle("");
    return;
  }

  ui.title.textContent = activeDocument.name;
  ui.title.disabled = !canRenameActiveDocument();
  ui.title.title = canRenameActiveDocument() ? "Haz clic para cambiar el nombre" : "";
  if (canRenameActiveDocument()) {
    ui.title.setAttribute(
      "aria-label",
      `${activeDocument.name}. Haz clic para cambiar el nombre`,
    );
  } else {
    ui.title.setAttribute("aria-label", activeDocument.name);
  }
  const kind = baseName(activeDocument.name).split(".").pop() || activeDocument.type;
  ui.fileKind.textContent = kind.toUpperCase();
  ui.fileKind.hidden = false;
  ui.fileMeta.textContent = formatFileSize(activeDocument.size);
  ui.fileMeta.hidden = false;
  ui.dirty.hidden = !activeDocument.dirty;
  const prefix = activeDocument.dirty ? "• " : "";
  void setTitle(`${prefix}${activeDocument.name}`);
}

function setDirty(dirty) {
  if (!activeDocument || activeDocument.type !== "pdf") return;
  const next = Boolean(dirty) || Boolean(activeDocument.nameDirty);
  if (activeDocument.dirty === next) return;
  activeDocument.dirty = next;
  setDocumentIdentity();
}

function updateToolButtons(tool) {
  const tools = {
    select: ui.selectTool,
    text: ui.textTool,
    field: ui.fieldTool,
    highlight: ui.highlightTool,
    ink: ui.inkTool,
    eraser: ui.eraserTool,
  };
  for (const [name, button] of Object.entries(tools)) {
    const active = name === tool;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function activeUsesPdfController() {
  return Boolean(
    activeDocument
    && (activeDocument.type === "pdf" || activeDocument.renderer === "pdf"),
  );
}

function activeUsesPptxController() {
  return Boolean(
    activeDocument
    && activeDocument.type === "pptx"
    && activeDocument.renderer !== "pdf",
  );
}

function updatePdfState(state) {
  if (!activeUsesPdfController()) return;
  if (activeDocument.type === "pdf") {
    activeDocument.readOnly = state.canEdit === false;
  } else {
    activeDocument.readOnly = true;
  }
  setMode(activeDocument.type);
  ui.pageInput.value = String(state.pagePosition || 1);
  ui.pageInput.max = String(Math.max(1, state.pageCount));
  ui.pageTotal.textContent = `de ${state.pageCount}`;
  ui.previousButton.disabled = state.pagePosition <= 1;
  ui.nextButton.disabled = state.pagePosition >= state.pageCount;
  ui.zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;
  ui.fitButton.classList.toggle("is-active", state.fit);
  ui.undoButton.disabled = !state.canUndo;
  ui.deleteButton.disabled = state.pageCount <= 1;
  ui.searchCount.textContent = state.searchCount
    ? `${state.searchPosition + 1}/${state.searchCount}`
    : "0/0";
  ui.pdfPage.dataset.pageNumber = String(state.pagePosition || 1);
  ui.pdfPage.setAttribute("aria-label", `Página ${state.pagePosition || 1}`);
  updateToolButtons(state.tool);
}

function updatePptxState(state) {
  if (!activeDocument || activeDocument.type !== "pptx") return;
  const current = state.slideCount ? state.slideIndex + 1 : 0;
  ui.pageInput.value = String(current || 1);
  ui.pageInput.max = String(Math.max(1, state.slideCount));
  ui.pageTotal.textContent = `de ${state.slideCount}`;
  ui.previousButton.disabled = current <= 1;
  ui.nextButton.disabled = current >= state.slideCount;
  ui.zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;
  ui.fitButton.classList.toggle("is-active", state.fit);
}

const pdf = new PdfController(
  {
    viewer: ui.viewer,
    pageStack: ui.pdfPage,
    canvas: ui.pdfCanvas,
    textLayer: ui.textLayer,
    formLayer: ui.formLayer,
    linksLayer: ui.linksLayer,
    overlay: ui.overlay,
    textEditor: ui.textEditor,
    textInput: ui.textInput,
  },
  {
    onState: updatePdfState,
    onDirty: setDirty,
    onStatus: (message) => status(message, message.includes("…") ? "busy" : "ready"),
    onToast: (message) => showToast(message),
    onExternal: async (url) => {
      if (!(await openExternal(url))) showToast("Ese enlace no es seguro.", true);
    },
  },
);

let pptx = null;
let officeConverterStatePromise = null;

async function ensureOfficeConverterState() {
  if (!isNative) {
    throw new Error(
      "La conversión de documentos Office necesita la aplicación de escritorio.",
    );
  }
  if (!officeConverterStatePromise) {
    officeConverterStatePromise = (async () => {
      const [{ createOfficeConverter }, { createPresentationPreviewCache }] = await Promise.all([
        import("./office-converter.js"),
        import("./presentation-preview-cache.js"),
      ]);
      let previewCache = null;
      try {
        const backend = await getPresentationPreviewCacheBackend();
        previewCache = createPresentationPreviewCache({
          ...backend,
          platform: runtimePlatform(),
          getStats: getPathStats,
        });
      } catch (error) {
        console.warn("La caché de presentaciones no está disponible", error);
      }
      const converter = createOfficeConverter({
        execCommand: executeCommand,
        getStats: getPathStats,
        platform: runtimePlatform(),
        previewCache,
        onPreviewCacheError: (error) => {
          console.warn("No se pudo usar la caché de presentaciones", error);
        },
      });
      if (previewCache) {
        void previewCache.prune().catch((error) => {
          console.warn("No se pudo limitar la caché de presentaciones", error);
        });
      }
      return Object.freeze({ converter, previewCache });
    })().catch((error) => {
      officeConverterStatePromise = null;
      throw error;
    });
  }
  return officeConverterStatePromise;
}

async function ensureOfficeConverter() {
  return (await ensureOfficeConverterState()).converter;
}

function warmOfficeConverter() {
  if (!isNative) return;
  void ensureOfficeConverter()
    .then((converter) => converter.warmUp())
    .catch(() => {
      // LibreOffice is optional; opening PPTX can still use the lightweight fallback.
    });
}

function prunePresentationPreviewCache(cacheKey = null) {
  if (!officeConverterStatePromise) return;
  void officeConverterStatePromise
    .then(({ previewCache }) => previewCache?.prune({
      keepKeys: cacheKey ? [cacheKey] : [],
    }))
    .catch((error) => {
      console.warn("No se pudo limitar la caché de presentaciones", error);
    });
}

async function ensurePptxController() {
  if (!pptx) {
    const { PptxController } = await import("./pptx-controller.js");
    pptx = new PptxController(ui.pptxCanvas, ui.pptxViewer, updatePptxState);
  }
  return pptx;
}

function setMode(type = "none") {
  const hasDocument = type === "pdf" || type === "pptx";
  const isPdf = type === "pdf";
  const isPptx = type === "pptx";
  const usesPdfView = isPdf || (isPptx && activeDocument?.renderer === "pdf");
  const usesPptxView = isPptx && !usesPdfView;
  const isReadOnly = isPptx || (isPdf && activeDocument?.readOnly);
  ui.app.dataset.documentType = type;
  ui.welcome.hidden = hasDocument;
  ui.workspace.hidden = !hasDocument;
  ui.toolbar.hidden = !hasDocument;
  ui.pdfViewer.hidden = !usesPdfView;
  ui.pptxViewer.hidden = !usesPptxView;
  ui.readOnly.hidden = !isReadOnly;
  ui.readOnlyLabel.textContent = isPptx
    ? "Presentación · solo lectura"
    : isPdf && activeDocument?.readOnly
      ? "PDF protegido · solo lectura"
      : "Solo lectura";
  ui.saveButton.disabled = !isPdf || isReadOnly;
  ui.saveMenuButton.disabled = !isPdf || isReadOnly;
  ui.saveAsButton.disabled = !isPdf || isReadOnly;
  if (ui.saveMenuButton.disabled) closeSaveMenu();
  ui.convertButton.disabled = !(isPptx || (isPdf && !isReadOnly));
  ui.convertButton.setAttribute(
    "aria-label",
    isPptx ? "Convertir presentación a PDF" : "Convertir PDF",
  );
  ui.convertButton.title = isPptx
    ? "Convertir la presentación abierta a PDF"
    : "Convertir el PDF abierto";

  for (const element of [ui.editTools, ui.styleControls, ui.historyTools]) {
    if (element) element.hidden = !isPdf || isReadOnly;
  }
  if (ui.documentTools) ui.documentTools.hidden = !isPdf || isReadOnly;
  if (ui.searchControl) ui.searchControl.hidden = !usesPdfView;
  ui.searchInput.disabled = !usesPdfView;
}

async function disposeCurrentDocument() {
  const temporaryDirectory = activeDocument?.temporaryDirectory || null;
  resetWheelNavigation();
  await pdf.destroy();
  pptx?.destroy();
  activeDocument?.byteSource?.abort?.();
  activeDocument?.renderByteSource?.abort?.();
  activeDocument = null;
  setMode("none");
  setDocumentIdentity();
  if (temporaryDirectory) {
    try {
      await removeTemporaryDirectory(temporaryDirectory);
    } catch (error) {
      console.warn("No se pudo limpiar el directorio temporal", error);
    }
  }
}

function canDiscardChanges() {
  if (activeDocument?.type === "pdf") {
    pdf.commitTextEntry();
  }
  return (
    !activeDocument?.dirty ||
    window.confirm("Hay cambios sin guardar. ¿Quieres descartarlos?")
  );
}

async function openSource(source) {
  if (!source) return;
  await waitForDocumentRename();
  if (busy) return;
  if (!canDiscardChanges()) return;
  showLoading("Abriendo documento…");
  let replacedDocument = false;

  try {
    const descriptor = await readPath(source);
    if (descriptor.type === "pdf") {
      const initialBytes = new Uint8Array(descriptor.initialData);
      const header = new TextDecoder("ascii").decode(initialBytes.subarray(0, 1024));
      if (!header.includes("%PDF-")) {
        descriptor.byteSource?.abort?.();
        throw new Error("El archivo no tiene una cabecera PDF válida.");
      }
    }

    await disposeCurrentDocument();
    replacedDocument = true;
    activeDocument = {
      ...descriptor,
      data: descriptor.data ? toExactArrayBuffer(descriptor.data) : null,
      dirty: false,
      nameDirty: false,
      readOnly: false,
      renderer: descriptor.type === "pdf" ? "pdf" : null,
      renderByteSource: null,
      temporaryDirectory: null,
      savePath: descriptor.type === "pdf" && typeof descriptor.path === "string"
        ? descriptor.path
        : null,
    };
    setMode(descriptor.type);
    setDocumentIdentity();

    if (descriptor.type === "pdf") {
      const info = await pdf.load(activeDocument.byteSource, {
        initialData: activeDocument.initialData,
      });
      activeDocument.initialData = null;
      activeDocument.readOnly = Boolean(info.passwordProtected);
      setMode("pdf");
      const pageLabel = info.pageCount === 1 ? "página" : "páginas";
      const fieldLabel = info.formFieldCount === 1
        ? "campo rellenable"
        : "campos rellenables";
      ui.stats.textContent = info.formFieldCount
        ? `${info.pageCount} ${pageLabel} · ${info.formFieldCount} ${fieldLabel}`
        : `${info.pageCount} ${pageLabel}`;
      status(
        info.passwordProtected
          ? "PDF protegido abierto en modo de solo lectura"
          : info.formFieldCount
            ? "Formulario PDF listo para rellenar y editar"
            : "PDF listo para leer y editar",
      );
    } else {
      const presentationFormat = activeDocument.name.split(".").pop()?.toLocaleLowerCase() || "pptx";
      let route = null;
      if (isNative && typeof source === "string") {
        ui.loadingDetail.textContent = "Preparando una vista fiel con LibreOffice";
        activeDocument.temporaryDirectory = await createTemporaryDirectory("presentacion");
        const converter = await ensureOfficeConverter();
        route = await converter.preparePresentationForViewing(
          source,
          activeDocument.temporaryDirectory,
          {
            overwrite: true,
            allowPptxCanvasFallback: true,
          },
        );
        if (route?.cacheKey) prunePresentationPreviewCache(route.cacheKey);
      } else if (presentationFormat !== "pptx") {
        throw new Error(
          `${presentationFormat.toUpperCase()} necesita la aplicación de escritorio y LibreOffice instalado.`,
        );
      }

      if (route?.mode === "pdf") {
        const renderDescriptor = await readPath(route.path);
        activeDocument.renderer = "pdf";
        activeDocument.readOnly = true;
        activeDocument.renderByteSource = renderDescriptor.byteSource;
        activeDocument.renderPath = route.path;
        setMode("pptx");
        const info = await pdf.load(renderDescriptor.byteSource, {
          initialData: renderDescriptor.initialData,
        });
        ui.stats.textContent = `${info.pageCount} ${
          info.pageCount === 1 ? "diapositiva" : "diapositivas"
        } · vista fiel de LibreOffice`;
        status(`${presentationFormat.toUpperCase()} abierto en modo de solo lectura`);
      } else {
        const presentationBytes = activeDocument.data
          || await readBinarySource(route?.sourcePath || source);
        activeDocument.data = toExactArrayBuffer(presentationBytes);
        activeDocument.renderer = "pptx";
        activeDocument.readOnly = true;
        setMode("pptx");
        const pptxController = await ensurePptxController();
        const inspection = await pptxController.load(activeDocument.data);
        ui.stats.textContent = `${pptxController.slideCount} ${
          pptxController.slideCount === 1 ? "diapositiva" : "diapositivas"
        } · ${inspection.entryCount} elementos`;
        status("PPTX abierto en modo de solo lectura · visor ligero");
        if (activeDocument.temporaryDirectory) {
          const temporaryDirectory = activeDocument.temporaryDirectory;
          activeDocument.temporaryDirectory = null;
          try {
            await removeTemporaryDirectory(temporaryDirectory);
          } catch (error) {
            console.warn("No se pudo limpiar el directorio temporal", error);
          }
        }
      }
    }
    setDocumentIdentity();
  } catch (error) {
    const message = cleanErrorMessage(error);
    if (replacedDocument) {
      await disposeCurrentDocument();
    }
    if (!activeDocument) {
      setMode("none");
      status("No se pudo abrir el archivo", "error");
    } else {
      status("El documento no pudo abrirse", "error");
    }
    showToast(message, true);
    console.error(error);
  } finally {
    hideLoading();
  }
}

async function chooseAndOpen() {
  try {
    const source = await openDocumentDialog();
    if (source) await openSource(source);
  } catch (error) {
    showToast(cleanErrorMessage(error), true);
  }
}

function updatePdfStats(info) {
  const pageLabel = info.pageCount === 1 ? "página" : "páginas";
  const fieldLabel = info.formFieldCount === 1
    ? "campo rellenable"
    : "campos rellenables";
  ui.stats.textContent = info.formFieldCount
    ? `${info.pageCount} ${pageLabel} · ${info.formFieldCount} ${fieldLabel}`
    : `${info.pageCount} ${pageLabel}`;
}

async function materializeCurrentPdf() {
  if (!activeDocument || activeDocument.type !== "pdf") {
    throw new Error("Primero abre un archivo PDF.");
  }
  pdf.commitTextEntry();
  let bytes = pdf.hasFormChanges
    ? await pdf.saveFormDocument()
    : new Uint8Array(await readDescriptorBytes(activeDocument, {
      onProgress: (loaded, total) => {
        ui.loadingDetail.textContent = `Leyendo PDF… ${Math.round((loaded / total) * 100)}%`;
      },
    }));

  const editedTextFields = pdf.getEditedTextFieldNames();
  if (editedTextFields.length > 0) {
    try {
      const { refreshFormTextAppearances } = await import("./pdf-engine.js");
      bytes = await refreshFormTextAppearances(bytes, editedTextFields);
    } catch (error) {
      console.warn(
        "El formulario se preparó, pero no se pudieron regenerar todas sus apariencias.",
        error,
      );
    }
  }
  if (pdf.hasPageEdits) {
    const { createEditedPdf } = await import("./pdf-engine.js");
    bytes = await createEditedPdf(bytes, pdf.getChanges());
  }
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

async function activatePdfDescriptor(descriptor, {
  dirty = true,
  savePath = activeDocument?.savePath || null,
  pagePosition = 0,
} = {}) {
  const previousSource = activeDocument?.byteSource;
  Object.assign(activeDocument, descriptor, {
    dirty,
    readOnly: false,
    savePath,
  });
  const info = await pdf.load(activeDocument.byteSource, {
    initialData: activeDocument.initialData,
  });
  activeDocument.initialData = null;
  previousSource?.abort?.();
  if (pagePosition > 0 && info.pageCount > 1) {
    await pdf.goToPosition(Math.min(pagePosition, info.pageCount - 1));
  }
  updatePdfStats(info);
  setMode("pdf");
  setDocumentIdentity();
  return info;
}

async function replaceActivePdfBytes(bytes, {
  dirty = true,
  name = activeDocument?.name || "documento.pdf",
  savePath = activeDocument?.savePath || null,
  pagePosition = 0,
} = {}) {
  const buffer = toExactArrayBuffer(bytes);
  return activatePdfDescriptor({
    byteSource: createMemoryPdfByteSource(buffer, { name }),
    data: null,
    initialData: buffer.slice(0, Math.min(buffer.byteLength, 1024 * 1024)),
    name,
    path: null,
    size: buffer.byteLength,
    type: "pdf",
  }, { dirty, savePath, pagePosition });
}

async function savePdf(forceSaveAs = false) {
  if (!activeDocument || activeDocument.type !== "pdf") return;
  if (renamingDocument && !(await finishDocumentRename(true))) return;
  closeSaveMenu();
  pdf.commitTextEntry();
  if (activeDocument.readOnly || busy) return;
  const savedPagePosition = Math.max(0, pdf.getState().pagePosition - 1);
  showLoading("Preparando PDF…", "Aplicando las ediciones de forma local");
  let editedBytes = null;
  let originalPathToRemove = null;
  let allowDestinationOverwrite = false;

  try {
    editedBytes = await materializeCurrentPdf();
    const defaultName = activeDocument.nameDirty
      ? activeDocument.name
      : suggestedEditedName(activeDocument.name);
    let destination = !forceSaveAs ? activeDocument.savePath : null;
    allowDestinationOverwrite = Boolean(destination);

    if (
      !forceSaveAs
      && isNative
      && activeDocument.nameDirty
      && typeof destination === "string"
    ) {
      const originalPath = destination;
      const requestedPath = siblingDocumentPath(originalPath, activeDocument.name);
      const samePath = sameDocumentPath(originalPath, requestedPath, runtimePlatform());
      let overwrite = false;
      if (!samePath) {
        const requestedStats = await getPathStats(requestedPath);
        if (requestedStats) {
          if (!requestedStats.isFile) {
            throw new Error("La nueva ruta está ocupada por una carpeta.");
          }
          overwrite = window.confirm(
            `Ya existe "${activeDocument.name}". ¿Quieres reemplazar ese archivo?`,
          );
          if (!overwrite) {
            status("Guardado cancelado");
            return;
          }
        }
      }

      destination = requestedPath;
      allowDestinationOverwrite = samePath || overwrite;
      if (!samePath) originalPathToRemove = originalPath;
    }

    if (!destination) {
      destination = await savePdfDialog(defaultName);
      // The native Save dialog presents its own overwrite confirmation because
      // forceOverwrite is disabled in savePdfDialog().
      allowDestinationOverwrite = true;
    }
    if (!destination) {
      status("Guardado cancelado");
      return;
    }

    const writtenPath = isNative
      ? await writePathAtomic(destination, editedBytes, {
        overwrite: allowDestinationOverwrite,
      })
      : await writePath(destination, editedBytes, defaultName);
    let replacementDescriptor = null;
    if (isNative && typeof writtenPath === "string") {
      replacementDescriptor = await readPath(writtenPath);
    } else {
      const replacementBuffer = toExactArrayBuffer(editedBytes);
      replacementDescriptor = {
        byteSource: createMemoryPdfByteSource(replacementBuffer, {
          name: typeof writtenPath === "string" ? writtenPath : defaultName,
        }),
        data: null,
        initialData: replacementBuffer.slice(
          0,
          Math.min(replacementBuffer.byteLength, 1024 * 1024),
        ),
        name: typeof writtenPath === "string" ? writtenPath : defaultName,
        path: null,
        size: replacementBuffer.byteLength,
        type: "pdf",
      };
    }

    replacementDescriptor.nameDirty = false;
    await activatePdfDescriptor(replacementDescriptor, {
      dirty: false,
      savePath: isNative && typeof writtenPath === "string" ? writtenPath : null,
      pagePosition: savedPagePosition,
    });
    let oldNameRemoved = true;
    if (originalPathToRemove) {
      try {
        await removeFilePath(originalPathToRemove);
      } catch (error) {
        oldNameRemoved = false;
        console.warn("El PDF se guardó, pero el nombre anterior permanece", error);
      }
    }
    if (oldNameRemoved) {
      status("Cambios guardados");
      showToast(isNative ? "PDF guardado correctamente" : "PDF descargado");
    } else {
      status("PDF guardado · no se pudo quitar el nombre anterior", "error");
      showToast("El PDF se guardó con el nombre nuevo, pero el archivo anterior no pudo eliminarse.", true);
    }
  } catch (error) {
    status("No se pudo guardar el PDF", "error");
    showToast(cleanErrorMessage(error), true);
    console.error(error);
  } finally {
    hideLoading();
  }
}

function fileStem(name, fallback = "documento") {
  const value = baseName(String(name || fallback));
  return value.replace(/\.[^.]+$/u, "") || fallback;
}

async function saveGeneratedFile(bytes, {
  title,
  defaultName,
  extension,
  filterName,
  mimeType,
}) {
  const destination = await saveFileDialog({
    title,
    defaultName,
    extension,
    filterName,
  });
  if (!destination) return null;
  return writePath(destination, bytes, defaultName, mimeType);
}

async function availableGeneratedPath(folder, desiredName) {
  const dotIndex = desiredName.lastIndexOf(".");
  const stem = dotIndex > 0 ? desiredName.slice(0, dotIndex) : desiredName;
  const extension = dotIndex > 0 ? desiredName.slice(dotIndex) : "";
  for (let attempt = 1; attempt <= 10_000; attempt += 1) {
    const name = attempt === 1
      ? desiredName
      : `${stem}-${attempt}${extension}`;
    const path = await joinPath(folder, name);
    if (!(await getPathStats(path))) return { name, path };
  }
  throw new Error("No se encontró un nombre disponible para guardar las páginas.");
}

function renderReorderRows(container, items, labelFor, { allowDelete = true } = {}) {
  container.replaceChildren();
  for (let index = 0; index < items.length; index += 1) {
    const row = document.createElement("div");
    const label = document.createElement("span");
    row.className = "page-order-row";
    label.textContent = labelFor(items[index], index);
    row.append(label);

    const actions = [
      { label: "Subir", text: "↑", disabled: index === 0, offset: -1 },
      { label: "Bajar", text: "↓", disabled: index === items.length - 1, offset: 1 },
      { label: "Eliminar", text: "×", disabled: !allowDelete || items.length === 1, remove: true },
    ];
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.text;
      button.title = action.label;
      button.setAttribute("aria-label", `${action.label}: ${label.textContent}`);
      button.disabled = action.disabled;
      button.addEventListener("click", () => {
        if (action.remove) {
          items.splice(index, 1);
        } else {
          const [item] = items.splice(index, 1);
          items.splice(index + action.offset, 0, item);
        }
        renderReorderRows(container, items, labelFor, { allowDelete });
      });
      row.append(button);
    }
    container.append(row);
  }
}

async function mergePdfTool() {
  if (busy) return;
  try {
    const selected = await openFilesDialog({
      title: "Seleccionar PDF para unir",
      extensions: ["pdf"],
      multiple: true,
    });
    if (!selected.length) return;
    if (selected.length < 2) {
      showToast("Selecciona al menos dos archivos PDF.", true);
      return;
    }

    const ordered = [...selected];
    const confirmed = await showToolDialog({
      title: "Orden de los archivos",
      description: "El PDF final respetará este orden.",
      primaryLabel: "Unir PDF",
      render(body) {
        const list = document.createElement("div");
        list.className = "page-order-list";
        body.append(list);
        renderReorderRows(list, ordered, (source, index) => (
          `${index + 1}. ${sourceName(source)}`
        ));
      },
      collect: () => [...ordered],
    });
    if (!confirmed) return;

    showLoading("Uniendo archivos PDF…", "Los archivos se procesan solo en tu equipo");
    const inputs = [];
    for (let index = 0; index < confirmed.length; index += 1) {
      ui.loadingDetail.textContent = `Leyendo archivo ${index + 1} de ${confirmed.length}`;
      inputs.push(await readBinarySource(confirmed[index]));
    }
    const { mergePdfFiles } = await import("./pdf-tools.js");
    const output = await mergePdfFiles(inputs, {
      onProgress: ({ completed, total }) => {
        ui.loadingDetail.textContent = `Uniendo archivo ${completed} de ${total}`;
      },
    });
    const written = await saveGeneratedFile(output, {
      title: "Guardar PDF unido",
      defaultName: "documentos-unidos.pdf",
      extension: "pdf",
      filterName: "Documento PDF",
      mimeType: "application/pdf",
    });
    if (written) showToast("Los PDF se unieron correctamente.");
  } catch (error) {
    showToast(cleanErrorMessage(error), true);
    console.error(error);
  } finally {
    hideLoading();
  }
}

async function splitPdfTool() {
  if (busy) return;
  try {
    const [source] = await openFilesDialog({
      title: "Seleccionar PDF para dividir",
      extensions: ["pdf"],
    });
    if (!source) return;
    showLoading("Analizando PDF…");
    const bytes = await readBinarySource(source);
    const tools = await import("./pdf-tools.js");
    const features = await tools.inspectPdfFeatures(bytes);
    hideLoading();

    let previewSession = null;
    let previewPromise = null;
    let previewActive = true;
    let options;
    ui.toolDialog.classList.add("tool-dialog-wide");
    try {
      options = await showToolDialog({
      title: "Dividir PDF",
      description: `${features.pageCount} páginas disponibles`,
      primaryLabel: "Dividir",
      render(body) {
        const mode = document.createElement("label");
        const modeSelect = document.createElement("select");
        const range = document.createElement("label");
        const input = document.createElement("input");
        const note = document.createElement("p");
        mode.className = "dialog-field";
        mode.textContent = "Resultado";
        modeSelect.id = "split-mode";
        modeSelect.innerHTML = '<option value="range">Un PDF con las páginas elegidas</option><option value="pages">Un PDF independiente por página</option>';
        mode.append(modeSelect);
        range.className = "dialog-field";
        range.textContent = "Páginas o rangos";
        input.id = "split-range";
        input.value = `1-${features.pageCount}`;
        input.placeholder = "Ejemplo: 1-3, 5, 8-10";
        range.append(input);
        note.className = "dialog-note";
        note.textContent = "Usa comas para combinar varios rangos. Las páginas se indican desde 1.";
        const layout = document.createElement("div");
        const controls = document.createElement("div");
        const resultSummary = document.createElement("output");
        const previewPanel = document.createElement("section");
        const previewHeader = document.createElement("header");
        const totalPages = document.createElement("strong");
        const previewGrid = document.createElement("div");
        const previewLoading = document.createElement("p");
        layout.className = "split-dialog-layout";
        controls.className = "split-dialog-controls";
        resultSummary.className = "split-result-summary";
        resultSummary.setAttribute("aria-live", "polite");
        previewPanel.className = "split-preview-panel";
        previewPanel.setAttribute("aria-label", "Vista previa de la división");
        previewHeader.className = "split-preview-header";
        totalPages.textContent = `${features.pageCount} ${features.pageCount === 1 ? "página" : "páginas"}`;
        previewGrid.className = "split-preview-grid";
        previewGrid.setAttribute("aria-label", "Todas las páginas del PDF");
        previewLoading.className = "split-preview-loading";
        previewLoading.textContent = "Generando miniaturas…";
        previewGrid.append(previewLoading);
        previewHeader.append(totalPages, resultSummary);
        previewPanel.append(previewHeader, previewGrid);
        controls.append(mode, range, note);
        layout.append(controls, previewPanel);
        body.append(layout);

        const groupsForCurrentChoice = () => (
          modeSelect.value === "pages"
            ? Array.from({ length: features.pageCount }, (_, index) => [index])
            : [tools.parsePageRanges(input.value, features.pageCount)]
        );
        const updatePreviewPlan = () => {
          range.hidden = modeSelect.value === "pages";
          try {
            const groups = groupsForCurrentChoice();
            const selectedPages = groups.reduce((sum, group) => sum + group.length, 0);
            resultSummary.textContent = groups.length === 1
              ? `1 archivo · ${selectedPages} ${selectedPages === 1 ? "página" : "páginas"}`
              : `${groups.length} archivos · 1 página cada uno`;
            resultSummary.classList.remove("is-error");
            previewSession?.setGroups(groups);
          } catch (error) {
            resultSummary.textContent = cleanErrorMessage(error);
            resultSummary.classList.add("is-error");
          }
        };
        modeSelect.addEventListener("change", updatePreviewPlan);
        input.addEventListener("input", updatePreviewPlan);
        updatePreviewPlan();

        previewPromise = import("./pdf-split-preview.js")
          .then(({ createPdfSplitPreview }) => createPdfSplitPreview(bytes, previewGrid, {
            onError: (error) => console.warn("No se pudo crear una miniatura", error),
          }))
          .then(async (session) => {
            if (!previewActive) {
              await session.destroy();
              return null;
            }
            previewSession = session;
            updatePreviewPlan();
            return session;
          })
          .catch((error) => {
            if (previewActive) {
              previewGrid.replaceChildren();
              const failure = document.createElement("p");
              failure.className = "split-preview-loading is-error";
              failure.textContent = `No se pudieron generar las miniaturas: ${cleanErrorMessage(error)}`;
              previewGrid.append(failure);
            }
            return null;
          });
      },
      collect(body) {
        const mode = body.querySelector("#split-mode").value;
        return {
          mode,
          pages: mode === "pages"
            ? Array.from({ length: features.pageCount }, (_, index) => [index])
            : [tools.parsePageRanges(body.querySelector("#split-range").value, features.pageCount)],
        };
      },
      });
    } finally {
      previewActive = false;
      ui.toolDialog.classList.remove("tool-dialog-wide");
      if (previewSession) {
        await previewSession.destroy();
      } else {
        void previewPromise?.then((session) => session?.destroy()).catch(() => {});
      }
    }
    if (!options) return;

    let outputFolder = null;
    if (isNative && options.pages.length > 1) {
      outputFolder = await selectFolderDialog("Carpeta para los PDF divididos");
      if (!outputFolder) return;
    }
    showLoading("Dividiendo PDF…", "Creando cada resultado por separado");
    const outputs = tools.splitPdfSequential(bytes, options.pages, {
      onProgress: ({ completed, total }) => {
        ui.loadingDetail.textContent = `Creando archivo ${completed} de ${total}`;
      },
    });
    const stem = fileStem(sourceName(source));
    let outputCount = 0;
    if (options.pages.length === 1) {
      for await (const output of outputs) {
        const written = await saveGeneratedFile(output, {
          title: "Guardar PDF extraído",
          defaultName: `${stem}-extraido.pdf`,
          extension: "pdf",
          filterName: "Documento PDF",
          mimeType: "application/pdf",
        });
        if (!written) {
          status("División cancelada");
          return;
        }
        outputCount += 1;
      }
    } else if (isNative) {
      for await (const output of outputs) {
        const desiredName = `${stem}-pagina-${String(outputCount + 1).padStart(3, "0")}.pdf`;
        const { name, path } = await availableGeneratedPath(outputFolder, desiredName);
        await writePath(path, output, name);
        outputCount += 1;
      }
    } else {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      for await (const output of outputs) {
        outputCount += 1;
        zip.file(`${stem}-pagina-${String(outputCount).padStart(3, "0")}.pdf`, output);
      }
      const archive = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
      await writePath(`${stem}-paginas.zip`, archive, `${stem}-paginas.zip`, "application/zip");
    }
    showToast(`PDF dividido en ${outputCount} archivo${outputCount === 1 ? "" : "s"}.`);
  } catch (error) {
    showToast(cleanErrorMessage(error), true);
    console.error(error);
  } finally {
    hideLoading();
  }
}

async function compressPdfTool() {
  if (busy) return;
  try {
    const [source] = await openFilesDialog({
      title: "Seleccionar PDF para comprimir",
      extensions: ["pdf"],
    });
    if (!source) return;
    showLoading("Optimizando PDF…", "Compresión sin pérdida de calidad");
    const input = new Uint8Array(await readBinarySource(source));
    const { optimizePdf } = await import("./pdf-tools.js");
    const output = await optimizePdf(input);
    const stem = fileStem(sourceName(source));
    const written = await saveGeneratedFile(output, {
      title: "Guardar PDF optimizado",
      defaultName: `${stem}-comprimido.pdf`,
      extension: "pdf",
      filterName: "Documento PDF",
      mimeType: "application/pdf",
    });
    if (written) {
      const saved = Math.max(0, input.byteLength - output.byteLength);
      showToast(saved > 0
        ? `PDF optimizado: ${formatFileSize(saved)} menos.`
        : "El PDF ya estaba optimizado; se conservó su calidad original.");
    }
  } catch (error) {
    showToast(cleanErrorMessage(error), true);
    console.error(error);
  } finally {
    hideLoading();
  }
}

async function convertPdfA4Tool() {
  if (busy) return;
  let loadingTask = null;
  let sourceDescriptor = null;
  let rangeTransport = null;
  let passwordPromptCanceled = false;

  try {
    const [source] = await openFilesDialog({
      title: "Seleccionar PDF para convertir a PDF/A-4",
      extensions: ["pdf"],
      accept: ".pdf,application/pdf",
    });
    if (!source) return;

    const confirmed = await showToolDialog({
      title: "Convertir a PDF/A-4",
      description: "Se creará una copia visual independiente para conservación a largo plazo.",
      primaryLabel: "Crear copia PDF/A-4",
      render(body) {
        const heading = document.createElement("strong");
        const warning = document.createElement("ul");
        const note = document.createElement("p");
        heading.textContent = "Antes de continuar";
        warning.className = "pdfa-warning-list";
        for (const message of [
          "El texto conservará su apariencia, pero dejará de ser seleccionable o editable.",
          "Los formularios, enlaces, comentarios y contenido multimedia se aplanarán.",
          "Las firmas digitales y los archivos adjuntos del original no se transferirán.",
          "La copia se generará con un perfil de color sRGB incorporado.",
        ]) {
          const item = document.createElement("li");
          item.textContent = message;
          warning.append(item);
        }
        note.className = "dialog-note";
        note.textContent = "El archivo original no se modifica.";
        body.append(heading, warning, note);
      },
    });
    if (!confirmed) return;

    showLoading("Creando PDF/A-4…", "Leyendo el PDF seleccionado");
    sourceDescriptor = await readPath(source);
    if (sourceDescriptor.type !== "pdf" || !sourceDescriptor.byteSource) {
      throw new Error("El archivo seleccionado no es un PDF válido.");
    }
    rangeTransport = new PdfByteSourceRangeTransport(
      sourceDescriptor.byteSource,
      sourceDescriptor.initialData,
    );
    const { getDocument, PasswordResponses } = await import("pdfjs-dist");
    loadingTask = getDocument({
      range: rangeTransport,
      rangeChunkSize: PDF_RANGE_CHUNK_BYTES,
      disableStream: true,
      disableAutoFetch: true,
      ...PDFJS_ASSET_OPTIONS,
      useSystemFonts: true,
      enableXfa: false,
      isEvalSupported: false,
      stopAtErrors: false,
    });
    loadingTask.onPassword = (updatePassword, reason) => {
      const message = reason === PasswordResponses.INCORRECT_PASSWORD
        ? "La contraseña no es correcta. Inténtalo de nuevo:"
        : "Este PDF está protegido. Escribe la contraseña para convertirlo:";
      const password = window.prompt(message);
      if (password === null) {
        passwordPromptCanceled = true;
        void loadingTask.destroy();
        return;
      }
      updatePassword(password);
    };

    let documentProxy;
    try {
      documentProxy = await loadingTask.promise;
    } catch (error) {
      if (passwordPromptCanceled) {
        throw new Error("Conversión a PDF/A-4 cancelada.");
      }
      throw error;
    }

    ui.loadingDetail.textContent = `Preparando ${documentProxy.numPages} ${
      documentProxy.numPages === 1 ? "página" : "páginas"
    }`;
    const { convertPdfToPdfA4 } = await import("./pdfa-converter.js");
    const result = await convertPdfToPdfA4(documentProxy, {
      title: fileStem(sourceName(source)),
      date: new Date(),
      onProgress: ({ completed, total }) => {
        ui.loadingDetail.textContent = `Convirtiendo página ${completed} de ${total}`;
      },
    });
    const written = await saveGeneratedFile(result.bytes, {
      title: "Guardar copia PDF/A-4",
      defaultName: `${fileStem(sourceName(source))}-PDF-A-4.pdf`,
      extension: "pdf",
      filterName: "Documento PDF/A-4",
      mimeType: "application/pdf",
    });
    if (written) {
      showToast(
        `Copia visual PDF/A-4 creada con ${result.pageCount} ${
          result.pageCount === 1 ? "página" : "páginas"
        }.`,
      );
    }
  } catch (error) {
    const message = cleanErrorMessage(error);
    if (passwordPromptCanceled) {
      status("Conversión cancelada");
    } else {
      status("No se pudo crear el PDF/A-4", "error");
      showToast(message, true);
      console.error(error);
    }
  } finally {
    try {
      await loadingTask?.destroy();
    } catch {
      // El documento ya pudo haberse destruido al cancelar la contraseña.
    }
    rangeTransport?.abort();
    sourceDescriptor?.byteSource?.abort?.();
    hideLoading();
  }
}

async function organizeCurrentPdf() {
  if (!activeDocument || activeDocument.type !== "pdf" || busy) return;
  const sourceDocument = activeDocument;
  showLoading("Preparando organizador…", "Leyendo la estructura de páginas");
  try {
    const baseBytes = await materializeCurrentPdf();
    const tools = await import("./pdf-tools.js");
    const baseFeatures = await tools.inspectPdfFeatures(baseBytes);
    hideLoading();

    const sources = [baseBytes];
    const names = [activeDocument.name];
    const entries = Array.from({ length: baseFeatures.pageCount }, (_, pageIndex) => ({
      sourceIndex: 0,
      pageIndex,
    }));

    const plan = await showToolDialog({
      title: "Ordenar PDF",
      description: "Sube, baja, elimina o añade páginas antes de aplicar.",
      primaryLabel: "Aplicar orden",
      render(body) {
        const list = document.createElement("div");
        const add = document.createElement("button");
        list.className = "page-order-list";
        add.type = "button";
        add.className = "button button-secondary page-order-add";
        add.textContent = "Añadir otro PDF";
        const redraw = () => renderReorderRows(
          list,
          entries,
          (entry, index) => `${index + 1}. ${names[entry.sourceIndex]} · página ${entry.pageIndex + 1}`,
        );
        add.addEventListener("click", async () => {
          try {
            const selected = await openFilesDialog({
              title: "Añadir páginas de PDF",
              extensions: ["pdf"],
              multiple: true,
            });
            for (const source of selected) {
              const bytes = new Uint8Array(await readBinarySource(source));
              const features = await tools.inspectPdfFeatures(bytes);
              const sourceIndex = sources.length;
              sources.push(bytes);
              names.push(sourceName(source));
              for (let pageIndex = 0; pageIndex < features.pageCount; pageIndex += 1) {
                entries.push({ sourceIndex, pageIndex });
              }
            }
            redraw();
          } catch (error) {
            showToast(cleanErrorMessage(error), true);
          }
        });
        body.append(list, add);
        redraw();
      },
      collect: () => ({ sources: [...sources], order: entries.map((entry) => ({ ...entry })) }),
    });
    if (!plan) return;
    if (activeDocument !== sourceDocument) {
      throw new Error("El documento abierto cambió; vuelve a abrir el organizador.");
    }
    showLoading("Aplicando nuevo orden…", "Reconstruyendo las páginas localmente");
    const output = await tools.composePdfPages(plan.sources, plan.order, {
      onProgress: ({ completed, total }) => {
        ui.loadingDetail.textContent = `Procesando página ${completed} de ${total}`;
      },
    });
    await replaceActivePdfBytes(output, { dirty: true, name: activeDocument.name });
    status("Orden de páginas actualizado");
    showToast("Páginas organizadas. Guarda el PDF para conservar los cambios.");
  } catch (error) {
    showToast(cleanErrorMessage(error), true);
    console.error(error);
  } finally {
    hideLoading();
  }
}

function activateVisualSignature() {
  if (!activeDocument || activeDocument.type !== "pdf" || activeDocument.readOnly) return;
  ui.colorControl.value = "#20231f";
  syncAnnotationColorIndicator(ui.colorControl);
  ui.sizeControl.value = "3";
  ui.sizeValue.value = "3";
  ui.sizeValue.textContent = "3";
  pdf.setColor("#20231f");
  pdf.setToolSize(3);
  pdf.setTool("ink");
  showToast(
    "Dibuja tu firma sobre la hoja. Es una firma visual, no una firma digital criptográfica.",
  );
}

async function withPdfForConversion(action) {
  if (!activeDocument || activeDocument.type !== "pdf" || !pdf.document) {
    throw new Error("Primero abre un archivo PDF.");
  }
  // Current AcroForm values live in PDF.js annotationStorage and are painted by
  // the JPEG exporter. Visual page edits need a temporary, materialized PDF.
  if (!pdf.hasPageEdits) return action(pdf.document);

  const bytes = await materializeCurrentPdf();
  const { getDocument } = await import("pdfjs-dist");
  const loadingTask = getDocument({
    data: bytes.slice(),
    ...PDFJS_ASSET_OPTIONS,
    useSystemFonts: true,
    enableXfa: false,
    isEvalSupported: false,
    stopAtErrors: false,
  });
  const documentProxy = await loadingTask.promise;
  try {
    return await action(documentProxy);
  } finally {
    await loadingTask.destroy();
  }
}

async function exportPdfAsJpg() {
  const stem = fileStem(activeDocument.name);
  let folder = null;
  if (isNative) {
    folder = await selectFolderDialog("Carpeta para las imágenes JPG");
    if (!folder) return;
  }

  showLoading("Convirtiendo PDF a JPG…", "Renderizando una página a la vez");
  await withPdfForConversion(async (documentProxy) => {
    const { pdfToJpegPages } = await import("./conversion-tools.js");
    const images = [];
    for await (const image of pdfToJpegPages(documentProxy, {
      onProgress: ({ completed, total }) => {
        ui.loadingDetail.textContent = `Convirtiendo página ${completed} de ${total}`;
      },
    })) {
      const name = `${stem}-${image.name}`;
      if (isNative) {
        await writePath(
          await joinPath(folder, name),
          image.bytes,
          name,
          "image/jpeg",
        );
      } else {
        images.push({ ...image, name });
      }
    }

    if (!isNative && images.length === 1) {
      await writePath(images[0].name, images[0].bytes, images[0].name, "image/jpeg");
    } else if (!isNative && images.length > 1) {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      for (const image of images) zip.file(image.name, image.bytes);
      const archive = await zip.generateAsync({
        type: "uint8array",
        compression: "STORE",
      });
      await writePath(
        `${stem}-jpg.zip`,
        archive,
        `${stem}-jpg.zip`,
        "application/zip",
      );
    }
  });
  showToast("Conversión a JPG terminada.");
}

async function convertOpenPdf() {
  if (!activeDocument || activeDocument.type !== "pdf" || busy) return;
  const format = await chooseToolOption(
    "Convertir PDF",
    "Elige el formato de salida. Todo se procesa localmente.",
    [
      {
        value: "docx",
        label: "Word (.docx)",
        detail: "Texto editable; el diseño es aproximado y no incluye OCR.",
      },
      {
        value: "pptx",
        label: "PowerPoint (.pptx)",
        detail: "Una imagen fiel por diapositiva; contenido no editable.",
      },
      {
        value: "jpg",
        label: "Imágenes JPG",
        detail: "Una imagen de alta calidad por cada página.",
      },
    ],
  );
  if (!format) return;

  try {
    if (format === "jpg") {
      await exportPdfAsJpg();
      return;
    }

    const stem = fileStem(activeDocument.name);
    showLoading(
      format === "docx" ? "Convirtiendo PDF a Word…" : "Convirtiendo PDF a PowerPoint…",
      format === "docx"
        ? "Extrayendo texto editable página por página"
        : "Creando una diapositiva visual por página",
    );
    const output = await withPdfForConversion(async (documentProxy) => {
      const conversions = await import("./conversion-tools.js");
      return format === "docx"
        ? conversions.pdfToDocx(documentProxy)
        : conversions.pdfToPptx(documentProxy);
    });
    const written = await saveGeneratedFile(output, {
      title: format === "docx" ? "Guardar documento Word" : "Guardar presentación PowerPoint",
      defaultName: `${stem}.${format}`,
      extension: format,
      filterName: format === "docx" ? "Documento Word" : "Presentación PowerPoint",
      mimeType: format === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    if (written) {
      showToast(format === "docx"
        ? "Word creado. El texto es editable; revisa el diseño aproximado."
        : "PowerPoint creado con una imagen por diapositiva.");
    }
  } catch (error) {
    showToast(cleanErrorMessage(error), true);
    console.error(error);
  } finally {
    hideLoading();
  }
}

async function convertOpenPresentation() {
  if (!activeDocument || activeDocument.type !== "pptx") return;
  if (renamingDocument && !(await finishDocumentRename(true))) return;
  await waitForDocumentRename();
  if (!activeDocument || activeDocument.type !== "pptx" || busy) return;
  const sourceDocument = activeDocument;
  const stem = fileStem(sourceDocument.name, "presentacion");
  let conversionDirectory = null;
  showLoading(
    "Convirtiendo presentación a PDF…",
    sourceDocument.renderPath
      ? "Reutilizando la vista fiel ya generada"
      : "Usando LibreOffice de forma local",
  );

  try {
    let pdfPath = null;
    if (typeof sourceDocument.renderPath === "string") {
      const renderStats = await getPathStats(sourceDocument.renderPath);
      if (renderStats?.isFile && Number(renderStats.size) > 0) {
        pdfPath = sourceDocument.renderPath;
      }
    }

    if (!pdfPath) {
      if (!isNative || typeof sourceDocument.path !== "string") {
        throw new Error(
          "Convertir una presentación abierta necesita la aplicación de escritorio y LibreOffice instalado.",
        );
      }
      conversionDirectory = await createTemporaryDirectory("presentacion-a-pdf");
      const converter = await ensureOfficeConverter();
      const conversion = await converter.convertToPdf(
        sourceDocument.path,
        conversionDirectory,
        { overwrite: true },
      );
      pdfPath = conversion.path;
    }

    if (activeDocument !== sourceDocument) {
      throw new Error("La presentación activa cambió durante la conversión.");
    }
    ui.loadingDetail.textContent = "Preparando el PDF para guardar";
    const destination = await saveFileDialog({
      title: "Guardar presentación como PDF",
      defaultName: `${stem}.pdf`,
      extension: "pdf",
      filterName: "Documento PDF",
    });
    const written = destination
      ? await copyPath(pdfPath, destination, { overwrite: true })
      : null;
    if (written) showToast("La presentación se convirtió a PDF.");
  } catch (error) {
    showToast(cleanErrorMessage(error), true);
    console.error(error);
  } finally {
    if (conversionDirectory) {
      try {
        await removeTemporaryDirectory(conversionDirectory);
      } catch (error) {
        console.warn("No se pudo limpiar la conversión temporal", error);
      }
    }
    hideLoading();
  }
}

async function convertOpenDocument() {
  if (activeDocument?.type === "pptx") {
    await convertOpenPresentation();
  } else {
    await convertOpenPdf();
  }
}

function runtimePlatform() {
  const value = String(
    globalThis.window?.NL_OS
    || globalThis.navigator?.userAgentData?.platform
    || globalThis.navigator?.platform
    || "",
  ).toLocaleLowerCase();
  if (value.includes("win")) return "windows";
  if (value.includes("mac") || value.includes("darwin")) return "macos";
  return "linux";
}

async function convertToPdfTool() {
  if (busy) return;
  try {
    const selected = await openFilesDialog({
      title: "Seleccionar archivos para convertir a PDF",
      extensions: ["doc", "docx", "ppt", "pptx", "xls", "xlsx", "jpg", "jpeg"],
      accept: ".doc,.docx,.ppt,.pptx,.xls,.xlsx,.jpg,.jpeg",
      multiple: true,
    });
    if (!selected.length) return;

    const extensions = selected.map((source) => (
      sourceName(source).split(".").pop()?.toLocaleLowerCase() || ""
    ));
    const areImages = extensions.every((extension) => ["jpg", "jpeg"].includes(extension));
    const areOffice = extensions.every((extension) => (
      ["doc", "docx", "ppt", "pptx", "xls", "xlsx"].includes(extension)
    ));
    if (!areImages && !areOffice) {
      throw new Error("Convierte las imágenes JPG y los documentos Office por separado.");
    }

    if (areImages) {
      showLoading("Convirtiendo JPG a PDF…", "Creando una página por imagen");
      const images = [];
      for (let index = 0; index < selected.length; index += 1) {
        ui.loadingDetail.textContent = `Leyendo imagen ${index + 1} de ${selected.length}`;
        images.push(await readBinarySource(selected[index]));
      }
      const { jpgImagesToPdf } = await import("./pdf-tools.js");
      const output = await jpgImagesToPdf(images, { pageSize: "image" });
      const written = await saveGeneratedFile(output, {
        title: "Guardar PDF creado desde JPG",
        defaultName: `${fileStem(sourceName(selected[0]), "imagenes")}.pdf`,
        extension: "pdf",
        filterName: "Documento PDF",
        mimeType: "application/pdf",
      });
      if (written) showToast("Las imágenes JPG se convirtieron a PDF.");
      return;
    }

    if (!isNative || selected.some((source) => typeof source !== "string")) {
      throw new Error(
        "La conversión de Word, PowerPoint y Excel necesita la aplicación de escritorio y LibreOffice instalado.",
      );
    }
    const folder = await selectFolderDialog("Carpeta para los PDF convertidos");
    if (!folder) return;
    showLoading("Convirtiendo documentos a PDF…", "Usando LibreOffice de forma local");
    const converter = await ensureOfficeConverter();
    for (let index = 0; index < selected.length; index += 1) {
      ui.loadingDetail.textContent = `Convirtiendo archivo ${index + 1} de ${selected.length}`;
      await converter.convertToPdf(selected[index], folder);
    }
    showToast(`${selected.length} documento${selected.length === 1 ? "" : "s"} convertido${selected.length === 1 ? "" : "s"} a PDF.`);
  } catch (error) {
    showToast(cleanErrorMessage(error), true);
    console.error(error);
  } finally {
    hideLoading();
  }
}

function requestPassword({ mode }) {
  const protecting = mode === "protect";
  let passwordInput;
  let confirmationInput;
  return showToolDialog({
    title: protecting ? "Proteger PDF" : "Desbloquear PDF",
    description: protecting
      ? "Crea una contraseña para abrir el documento. El archivo se cifrará localmente con AES-256."
      : "Escribe la contraseña actual. Se utilizará solo en tu equipo y no se guardará.",
    primaryLabel: protecting ? "Proteger" : "Desbloquear",
    render(body) {
      const fields = document.createElement("div");
      const passwordLabel = document.createElement("label");
      const passwordCaption = document.createElement("span");
      passwordInput = document.createElement("input");
      fields.className = "dialog-field-stack";
      passwordLabel.className = "dialog-field";
      passwordCaption.textContent = protecting ? "Nueva contraseña" : "Contraseña del PDF";
      passwordInput.type = "password";
      passwordInput.autocomplete = protecting ? "new-password" : "current-password";
      passwordInput.maxLength = 127;
      passwordInput.spellcheck = false;
      if (protecting) {
        passwordInput.required = true;
        passwordInput.minLength = 8;
      }
      passwordLabel.append(passwordCaption, passwordInput);
      fields.append(passwordLabel);

      if (protecting) {
        const confirmationLabel = document.createElement("label");
        const confirmationCaption = document.createElement("span");
        const hint = document.createElement("small");
        confirmationInput = document.createElement("input");
        confirmationLabel.className = "dialog-field";
        confirmationCaption.textContent = "Confirmar contraseña";
        confirmationInput.type = "password";
        confirmationInput.autocomplete = "new-password";
        confirmationInput.maxLength = 127;
        confirmationInput.minLength = 8;
        confirmationInput.required = true;
        hint.className = "dialog-field-hint";
        hint.textContent = "Usa al menos 8 caracteres. Si la pierdes, el documento no podrá recuperarse desde TenjinReader.";
        confirmationLabel.append(confirmationCaption, confirmationInput, hint);
        fields.append(confirmationLabel);
      }

      body.append(fields);
      window.requestAnimationFrame(() => passwordInput.focus());
    },
    collect() {
      const password = passwordInput.value;
      if (protecting && password !== confirmationInput.value) {
        throw new Error("Las contraseñas no coinciden.");
      }
      return password;
    },
  });
}

async function unlockPdfTool() {
  if (busy) return;
  try {
    const [source] = await openFilesDialog({
      title: "Seleccionar PDF protegido",
      extensions: ["pdf"],
      accept: ".pdf,application/pdf",
    });
    if (!source) return;
    const password = await requestPassword({ mode: "unlock" });
    if (password === null) return;

    showLoading("Desbloqueando PDF…", "Quitando la protección sin alterar sus páginas");
    const bytes = await readBinarySource(source);
    const { unlockPdf } = await import("./pdf-security.js");
    const output = await unlockPdf(bytes, password);
    const written = await saveGeneratedFile(output, {
      title: "Guardar PDF desbloqueado",
      defaultName: `${fileStem(sourceName(source))}-desbloqueado.pdf`,
      extension: "pdf",
      filterName: "Documento PDF",
      mimeType: "application/pdf",
    });
    if (written) showToast("PDF desbloqueado correctamente.");
  } catch (error) {
    showToast(cleanErrorMessage(error), true);
    console.error(error);
  } finally {
    hideLoading();
  }
}

async function protectPdfTool() {
  if (busy) return;
  try {
    const [source] = await openFilesDialog({
      title: "Seleccionar PDF para proteger",
      extensions: ["pdf"],
      accept: ".pdf,application/pdf",
    });
    if (!source) return;
    const password = await requestPassword({ mode: "protect" });
    if (password === null) return;

    showLoading("Protegiendo PDF…", "Aplicando cifrado AES-256 en tu equipo");
    const bytes = await readBinarySource(source);
    const { protectPdf } = await import("./pdf-security.js");
    const output = await protectPdf(bytes, password);
    const written = await saveGeneratedFile(output, {
      title: "Guardar PDF protegido",
      defaultName: `${fileStem(sourceName(source))}-protegido.pdf`,
      extension: "pdf",
      filterName: "Documento PDF",
      mimeType: "application/pdf",
    });
    if (written) showToast("PDF protegido correctamente con AES-256.");
  } catch (error) {
    showToast(cleanErrorMessage(error), true);
    console.error(error);
  } finally {
    hideLoading();
  }
}

async function navigate(delta) {
  if (!activeDocument || busy) return;
  if (activeUsesPdfController()) {
    if (delta < 0) await pdf.previous();
    else await pdf.next();
  } else if (activeUsesPptxController()) {
    if (delta < 0) await pptx?.previous();
    else await pptx?.next();
  }
}

function isEditableTarget(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable
  );
}

function clearWheelGesture() {
  window.clearTimeout(wheelGestureTimer);
  wheelGestureTimer = 0;
  wheelGestureDirection = 0;
  wheelGestureDelta = 0;
  wheelGestureLatched = false;
}

function resetWheelNavigation() {
  clearWheelGesture();
  wheelNavigationInProgress = false;
}

function keepWheelGestureAlive() {
  window.clearTimeout(wheelGestureTimer);
  wheelGestureTimer = window.setTimeout(() => {
    wheelGestureTimer = 0;
    wheelGestureDirection = 0;
    wheelGestureDelta = 0;
    wheelGestureLatched = false;
  }, WHEEL_GESTURE_IDLE_MS);
}

function handleViewerWheel(event) {
  if (
    event.defaultPrevented ||
    !activeDocument ||
    (!activeUsesPdfController() && !activeUsesPptxController()) ||
    busy ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    !ui.textEditor.hidden ||
    pdf.pointerSession ||
    isEditableTarget(event.target) ||
    isEditableTarget(document.activeElement)
  ) {
    clearWheelGesture();
    return;
  }

  const verticalDelta = wheelDeltaToPixels(
    event.deltaY,
    event.deltaMode,
    ui.viewer.clientHeight,
  );
  const horizontalDelta = wheelDeltaToPixels(
    event.deltaX,
    event.deltaMode,
    ui.viewer.clientWidth,
  );

  if (
    verticalDelta === 0 ||
    Math.abs(verticalDelta) <= Math.abs(horizontalDelta)
  ) {
    clearWheelGesture();
    return;
  }

  keepWheelGestureAlive();
  const direction = verticalDelta < 0 ? -1 : 1;

  if (
    canScrollVertically(
      ui.viewer,
      direction,
      WHEEL_EDGE_TOLERANCE,
    )
  ) {
    wheelGestureDirection = 0;
    wheelGestureDelta = 0;
    return;
  }

  const usesPdfController = activeUsesPdfController();
  const pageCount = usesPdfController
    ? pdf.activePages.length
    : pptx?.slideCount || 0;
  const currentPosition = usesPdfController
    ? pdf.currentPosition
    : pptx?.slideIndex || 0;
  const canNavigate =
    direction < 0
      ? currentPosition > 0
      : currentPosition < pageCount - 1;
  if (!canNavigate) {
    wheelGestureDirection = 0;
    wheelGestureDelta = 0;
    return;
  }

  event.preventDefault();
  if (wheelGestureLatched || wheelNavigationInProgress) {
    return;
  }

  if (wheelGestureDirection !== direction) {
    wheelGestureDirection = direction;
    wheelGestureDelta = 0;
  }
  wheelGestureDelta += verticalDelta;

  if (Math.abs(wheelGestureDelta) < WHEEL_PAGE_THRESHOLD) {
    return;
  }

  wheelGestureDelta = 0;
  wheelGestureLatched = true;
  wheelNavigationInProgress = true;
  void runDocumentAction(async () => {
    await navigate(direction);
    ui.viewer.scrollTop =
      direction > 0
        ? 0
        : Math.max(
          0,
          ui.viewer.scrollHeight - ui.viewer.clientHeight,
        );
  }).finally(() => {
    wheelNavigationInProgress = false;
  });
}

async function goToEnteredPage() {
  const value = Number.parseInt(ui.pageInput.value, 10);
  if (!Number.isFinite(value) || !activeDocument) return;
  if (activeUsesPdfController()) await pdf.goToPosition(value - 1);
  else if (activeUsesPptxController()) await pptx?.goTo(value - 1);
}

async function changeZoom(multiplier) {
  if (!activeDocument) return;
  if (activeUsesPdfController()) await pdf.setZoom(pdf.scale * multiplier);
  else if (activeUsesPptxController() && pptx) await pptx.setZoom(pptx.zoom * multiplier);
}

async function fitDocument() {
  if (!activeDocument) return;
  if (activeUsesPdfController()) await pdf.fitToWindow();
  else if (activeUsesPptxController()) await pptx?.fitToWindow();
}

function bindInterface() {
  ui.openButton.addEventListener("click", chooseAndOpen);
  ui.fileInput.addEventListener("change", async () => {
    const [file] = ui.fileInput.files || [];
    ui.fileInput.value = "";
    if (file) await openSource(file);
  });
  ui.saveButton.addEventListener("click", () => {
    closeSaveMenu();
    void savePdf(false);
  });
  ui.saveMenuButton.addEventListener("click", toggleSaveMenu);
  ui.saveMenuButton.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      openSaveMenu({ focusLast: event.key === "ArrowUp" });
    } else if (event.key === "Escape" && saveMenuIsOpen()) {
      event.preventDefault();
      event.stopPropagation();
      closeSaveMenu({ restoreFocus: true });
    }
  });
  ui.saveMenu.addEventListener("keydown", (event) => {
    const items = [...ui.saveMenu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const currentIndex = items.indexOf(document.activeElement);
    let nextIndex = currentIndex;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSaveMenu({ restoreFocus: true });
      return;
    }
    if (event.key === "Tab") {
      closeSaveMenu();
      return;
    }
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
    else if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    items[nextIndex]?.focus();
  });
  ui.saveAsButton.addEventListener("click", () => {
    closeSaveMenu();
    void savePdf(true);
  });
  document.addEventListener("pointerdown", (event) => {
    if (saveMenuIsOpen() && !ui.saveSplit.contains(event.target)) {
      closeSaveMenu();
    }
  });

  ui.title.addEventListener("click", beginDocumentRename);
  ui.titleInput.addEventListener("keydown", async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (await finishDocumentRename(true)) ui.title.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      await finishDocumentRename(false);
      ui.title.focus();
    }
  });
  ui.titleInput.addEventListener("blur", () => {
    void finishDocumentRename(true);
  });
  ui.convertButton.addEventListener("click", () => runDocumentAction(convertOpenDocument));
  ui.organizeButton.addEventListener("click", () => runDocumentAction(organizeCurrentPdf));
  ui.signButton.addEventListener("click", activateVisualSignature);
  ui.mergePdfButton.addEventListener("click", mergePdfTool);
  ui.splitPdfButton.addEventListener("click", splitPdfTool);
  ui.compressPdfButton.addEventListener("click", compressPdfTool);
  ui.pdfA4Button.addEventListener("click", convertPdfA4Tool);
  ui.toPdfButton.addEventListener("click", convertToPdfTool);
  ui.unlockPdfButton.addEventListener("click", unlockPdfTool);
  ui.protectPdfButton.addEventListener("click", protectPdfTool);
  ui.toastClose.addEventListener("click", () => {
    ui.toast.hidden = true;
  });

  ui.dropZone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    ui.dropZone.classList.add("is-dragging");
  });
  ui.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  ui.dropZone.addEventListener("dragleave", (event) => {
    if (!ui.dropZone.contains(event.relatedTarget)) {
      ui.dropZone.classList.remove("is-dragging");
    }
  });
  ui.dropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    ui.dropZone.classList.remove("is-dragging");
    const [file] = event.dataTransfer.files || [];
    if (!file || !getDocumentType(file.name)) {
      showToast("Suelta un PDF, PPT, PPTX, ODP u ODF.", true);
      return;
    }
    await openSource(file);
  });
  ui.dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      ui.fileInput.click();
    }
  });

  const toolButtons = {
    select: ui.selectTool,
    text: ui.textTool,
    field: ui.fieldTool,
    highlight: ui.highlightTool,
    ink: ui.inkTool,
    eraser: ui.eraserTool,
  };
  for (const [tool, button] of Object.entries(toolButtons)) {
    button.addEventListener("click", () => pdf.setTool(tool));
  }
  ui.colorControl.addEventListener("input", () => {
    syncAnnotationColorIndicator(ui.colorControl);
    pdf.setColor(ui.colorControl.value);
  });
  ui.sizeControl.addEventListener("input", () => {
    ui.sizeValue.value = ui.sizeControl.value;
    ui.sizeValue.textContent = ui.sizeControl.value;
    pdf.setToolSize(ui.sizeControl.value);
  });
  ui.undoButton.addEventListener("click", () => runDocumentAction(() => pdf.undo()));
  ui.rotateButton.addEventListener("click", () =>
    runDocumentAction(() => pdf.rotateCurrentPage()));
  ui.deleteButton.addEventListener("click", () =>
    runDocumentAction(() => pdf.deleteCurrentPage()));

  ui.previousButton.addEventListener("click", () => runDocumentAction(() => navigate(-1)));
  ui.nextButton.addEventListener("click", () => runDocumentAction(() => navigate(1)));
  ui.viewer.addEventListener("wheel", handleViewerWheel, {
    passive: false,
  });
  ui.pageInput.addEventListener("change", () => runDocumentAction(goToEnteredPage));
  ui.pageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runDocumentAction(goToEnteredPage);
      ui.viewer.focus();
    }
  });
  ui.zoomOutButton.addEventListener("click", () =>
    runDocumentAction(() => changeZoom(1 / 1.15)));
  ui.zoomInButton.addEventListener("click", () =>
    runDocumentAction(() => changeZoom(1.15)));
  ui.fitButton.addEventListener("click", () => runDocumentAction(fitDocument));
  ui.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && activeUsesPdfController()) {
      event.preventDefault();
      runDocumentAction(() => pdf.search(ui.searchInput.value));
    }
  });
  ui.searchInput.addEventListener("search", () => {
    if (!ui.searchInput.value) runDocumentAction(() => pdf.search(""));
  });

  ui.textEditor.addEventListener("submit", (event) => {
    event.preventDefault();
    pdf.commitTextEntry();
  });
  ui.textCancel.addEventListener("click", () => pdf.hideTextEntry());

  document.addEventListener("keydown", (event) => {
    const modifier = event.ctrlKey || event.metaKey;
    const target = event.target;
    const typing = isEditableTarget(target);

    if (event.key === "Escape" && saveMenuIsOpen()) {
      event.preventDefault();
      closeSaveMenu({ restoreFocus: true });
      return;
    }

    if (busy) {
      const key = event.key.toLocaleLowerCase();
      if (modifier && (["o", "s"].includes(key) || (key === "z" && !typing))) {
        event.preventDefault();
      }
      return;
    }

    if (modifier && event.key.toLocaleLowerCase() === "o") {
      event.preventDefault();
      void chooseAndOpen();
      return;
    }
    if (modifier && event.key.toLocaleLowerCase() === "s") {
      event.preventDefault();
      void savePdf(event.shiftKey);
      return;
    }
    if (
      modifier &&
      event.key.toLocaleLowerCase() === "z" &&
      activeDocument?.type === "pdf"
    ) {
      event.preventDefault();
      runDocumentAction(() => pdf.undo());
      return;
    }
    if (typing || modifier || event.altKey || !activeDocument) return;

    if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      runDocumentAction(() => navigate(-1));
    } else if (event.key === "ArrowRight" || event.key === "PageDown") {
      event.preventDefault();
      runDocumentAction(() => navigate(1));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      runDocumentAction(() => changeZoom(1.15));
    } else if (event.key === "-") {
      event.preventDefault();
      runDocumentAction(() => changeZoom(1 / 1.15));
    } else if (event.key === "0") {
      event.preventDefault();
      runDocumentAction(fitDocument);
    } else if (event.key === "Escape" && activeDocument.type === "pdf") {
      pdf.setTool("select");
    } else if (activeDocument.type === "pdf") {
      if (event.key.toLocaleLowerCase() === "r") {
        event.preventDefault();
        runDocumentAction(() => pdf.rotateCurrentPage());
        return;
      }
      const shortcuts = {
        v: "select",
        t: "text",
        f: "field",
        h: "highlight",
        d: "ink",
        e: "eraser",
      };
      const tool = shortcuts[event.key.toLocaleLowerCase()];
      if (tool) pdf.setTool(tool);
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (activeDocument?.type === "pdf") {
      pdf.commitTextEntry();
    }
    if (activeDocument?.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  onWindowClose(async () => {
    await waitForDocumentRename();
    return canDiscardChanges();
  });

  const observer = new ResizeObserver(() => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (activeUsesPdfController()) runDocumentAction(() => pdf.resize());
      else if (activeUsesPptxController()) {
        runDocumentAction(() => pptx?.resize());
      }
    }, 120);
  });
  observer.observe(ui.viewer);
}

async function start() {
  setMode("none");
  setDocumentIdentity();
  bindInterface();
  syncAnnotationColorIndicator(ui.colorControl);
  pdf.setColor(ui.colorControl.value);
  pdf.setToolSize(ui.sizeControl.value);

  await initializeNative();
  warmOfficeConverter();
  status("");
  const launchPath = await getLaunchDocumentPath();
  if (launchPath) await openSource(launchPath);
}

start().catch((error) => {
  hideLoading();
  status("La aplicación no pudo iniciar", "error");
  showToast(cleanErrorMessage(error), true);
  console.error(error);
});
