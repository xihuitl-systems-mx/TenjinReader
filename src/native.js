import {
  app,
  events,
  filesystem,
  init as initNeutralino,
  os,
  window as neutralinoWindow,
} from "@neutralinojs/lib";

import {
  baseName,
  getDocumentType,
  normalizeExternalUrl,
  toExactArrayBuffer,
} from "./utils.js";
import {
  PDF_RANGE_CHUNK_BYTES,
  createPdfByteSource,
} from "./pdf-source.js";
import { replaceFileTransaction } from "./file-transaction.js";

const APP_TITLE = "TenjinReader";
const TEMP_DIRECTORY_PREFIX = "tenjinreader-";
const PRESENTATION_CACHE_DIRECTORY = "tenjinreader-presentation-previews-v1";
const PRESENTATION_CACHE_ENTRY = /^v1-[a-f\d]{16}$/iu;
const DOCUMENT_ACCEPT = [
  ".pdf",
  ".ppt",
  ".pptx",
  ".odp",
  ".odf",
  "application/pdf",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.formula",
].join(",");

let initializationPromise;
let initializationError = null;
let windowCloseHandler = null;

export function isNeutralinoRuntime() {
  return (
    typeof globalThis.window !== "undefined"
    && typeof globalThis.window.NL_APPID === "string"
    && typeof globalThis.window.NL_MODE === "string"
    && Number.isInteger(globalThis.window.NL_PORT)
    && Array.isArray(globalThis.window.NL_ARGS)
  );
}

export const isNative = isNeutralinoRuntime();

export function initializeNative() {
  if (!isNeutralinoRuntime()) {
    return Promise.resolve(false);
  }

  if (!initializationPromise) {
    initializationPromise = (async () => {
      initNeutralino({ exportCustomMethods: false });
      await events.on("windowClose", (event) => {
        void dispatchWindowClose(event);
      });
      return true;
    })().catch((error) => {
      initializationError = error;
      return false;
    });
  }

  return initializationPromise;
}

export function getNativeInitializationError() {
  return initializationError;
}

async function dispatchWindowClose(event) {
  try {
    if (windowCloseHandler) {
      const shouldExit = await windowCloseHandler(event);
      if (shouldExit === false) {
        return;
      }
    }

    await exitApp();
  } catch {
    // A failed confirmation must not close a document with unsaved changes.
  }
}

/**
 * Replaces the close guard. Return false (or reject) to keep the app open.
 */
export function onWindowClose(handler) {
  if (typeof handler !== "function") {
    throw new TypeError("El manejador de cierre debe ser una función.");
  }

  windowCloseHandler = handler;
  return () => {
    if (windowCloseHandler === handler) {
      windowCloseHandler = null;
    }
  };
}

async function requireNative() {
  if (!(await initializeNative())) {
    throw initializationError ?? new Error("Neutralino no está disponible.");
  }
}

export async function exitApp(exitCode = 0) {
  if (isNeutralinoRuntime()) {
    await requireNative();
    await app.exit(Number.isInteger(exitCode) ? exitCode : 0);
    return true;
  }

  if (typeof globalThis.window !== "undefined") {
    globalThis.window.close();
    return true;
  }

  return false;
}

function selectFilesInBrowser({ accept = DOCUMENT_ACCEPT, multiple = false } = {}) {
  if (typeof document === "undefined") {
    return Promise.resolve([]);
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    let settled = false;
    let focusTimer;

    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.hidden = true;

    const finish = (files) => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(focusTimer);
      globalThis.window?.removeEventListener("focus", onWindowFocus);
      input.remove();
      resolve(files);
    };

    const onWindowFocus = () => {
      // Older webviews do not emit the input "cancel" event.
      focusTimer = globalThis.setTimeout(() => {
        if (!input.files?.length) {
          finish([]);
        }
      }, 200);
    };

    input.addEventListener(
      "change",
      () => finish(Array.from(input.files || [])),
      { once: true },
    );
    input.addEventListener("cancel", () => finish([]), { once: true });
    globalThis.window?.addEventListener("focus", onWindowFocus, { once: true });

    document.body.append(input);
    input.click();
  });
}

/**
 * Returns a native path in Neutralino and a File object in a regular browser.
 */
export async function openDocumentDialog() {
  if (!isNeutralinoRuntime()) {
    const [file] = await selectFilesInBrowser();
    return file && getDocumentType(file.name) ? file : null;
  }

  await requireNative();
  const entries = await os.showOpenDialog("Abrir documento", {
    filters: [
      {
        name: "Documentos PDF y presentaciones",
        extensions: ["pdf", "ppt", "pptx", "odp", "odf"],
      },
    ],
    multiSelections: false,
  });
  const path = entries[0] ?? null;

  return path && getDocumentType(path) ? path : null;
}

/** Selects one or more arbitrary inputs for PDF tools. */
export async function openFilesDialog({
  title = "Seleccionar archivos",
  extensions = ["pdf"],
  accept = extensions.map((extension) => `.${extension}`).join(","),
  multiple = false,
} = {}) {
  const normalizedExtensions = extensions
    .map((extension) => String(extension).replace(/^\./u, "").toLowerCase())
    .filter(Boolean);

  if (!isNeutralinoRuntime()) {
    return selectFilesInBrowser({ accept, multiple });
  }

  await requireNative();
  const entries = await os.showOpenDialog(title, {
    filters: [{
      name: normalizedExtensions.map((value) => value.toUpperCase()).join(", "),
      extensions: normalizedExtensions,
    }],
    multiSelections: multiple,
  });
  return multiple ? entries : entries.slice(0, 1);
}

function isBrowserFile(value) {
  return (
    value !== null
    && typeof value === "object"
    && typeof value.name === "string"
    && typeof value.arrayBuffer === "function"
  );
}

function validateDocumentSize(size) {
  const byteLength = Number(size);
  if (!Number.isFinite(byteLength) || byteLength < 0) {
    throw new TypeError("No se pudo determinar el tamaño del documento.");
  }
  return byteLength;
}

/**
 * Reads a selected source and returns bytes plus the small metadata the UI needs.
 */
export async function readPath(source) {
  if (isBrowserFile(source)) {
    const type = getDocumentType(source.name);
    if (!type) {
      throw new TypeError("El archivo debe ser PDF o una presentación compatible.");
    }
    const size = validateDocumentSize(source.size);

    if (type === "pdf") {
      const byteSource = createPdfByteSource({
        length: size,
        name: source.name,
        modifiedAt: source.lastModified,
        readRange: (begin, end) => source.slice(begin, end).arrayBuffer(),
      });
      const initialData = await byteSource.readRange(
        0,
        Math.min(size, PDF_RANGE_CHUNK_BYTES),
      );
      return {
        byteSource,
        data: null,
        initialData,
        name: source.name,
        path: null,
        size,
        type,
      };
    }

    const data = toExactArrayBuffer(await source.arrayBuffer());
    return {
      data,
      name: source.name,
      path: null,
      size: Number.isFinite(source.size) ? source.size : data.byteLength,
      type,
    };
  }

  if (typeof source !== "string" || !getDocumentType(source)) {
    throw new TypeError("La ruta debe apuntar a un PDF o una presentación compatible.");
  }

  await requireNative();
  const stats = await filesystem.getStats(source);
  if (!stats.isFile) {
    throw new TypeError("La ruta seleccionada no es un archivo.");
  }
  const type = getDocumentType(source);
  const size = validateDocumentSize(stats.size);

  if (type === "pdf") {
    const byteSource = createPdfByteSource({
      length: size,
      name: baseName(source),
      path: source,
      modifiedAt: stats.modifiedAt,
      readRange: (begin, end) => filesystem.readBinaryFile(source, {
        pos: begin,
        size: end - begin,
      }),
    });
    const initialData = await byteSource.readRange(
      0,
      Math.min(size, PDF_RANGE_CHUNK_BYTES),
    );
    return {
      byteSource,
      data: null,
      initialData,
      name: baseName(source),
      path: source,
      size,
      type,
    };
  }

  return {
    // Native presentation viewing gives LibreOffice the original path and
    // only materializes bytes if the PPTX canvas fallback is actually needed.
    data: null,
    name: baseName(source),
    path: source,
    size,
    type,
  };
}

/** Materializes a descriptor only for operations that must rewrite it. */
export async function readDescriptorBytes(descriptor, options) {
  if (descriptor?.data) return toExactArrayBuffer(descriptor.data);
  if (descriptor?.byteSource?.readAll) {
    return descriptor.byteSource.readAll(options);
  }
  throw new TypeError("No se puede leer el contenido completo del documento.");
}

function pdfName(value) {
  const candidate = baseName(
    typeof value === "string" && value.length > 0 ? value : "documento.pdf",
  ) || "documento.pdf";

  if (/\.pdf$/iu.test(candidate)) {
    return candidate;
  }

  return candidate.replace(/\.(?:pptx?|odp|odf)$/iu, "") + ".pdf";
}

/**
 * Returns a filesystem path natively and a download filename in the browser.
 */
export async function savePdfDialog(defaultName = "documento.pdf") {
  const suggestedName = pdfName(defaultName);

  if (!isNeutralinoRuntime()) {
    return suggestedName;
  }

  await requireNative();
  const selectedPath = await os.showSaveDialog("Guardar PDF", {
    defaultPath: suggestedName,
    filters: [{ name: "Documento PDF", extensions: ["pdf"] }],
    forceOverwrite: false,
  });

  if (!selectedPath) {
    return null;
  }

  return /\.pdf$/iu.test(selectedPath) ? selectedPath : `${selectedPath}.pdf`;
}

export async function saveFileDialog({
  title = "Guardar archivo",
  defaultName = "archivo",
  extension = "",
  filterName = "Archivo",
} = {}) {
  const cleanExtension = String(extension).replace(/^\./u, "").toLowerCase();
  const suggestedName = cleanExtension && !new RegExp(`\\.${cleanExtension}$`, "iu").test(defaultName)
    ? `${defaultName}.${cleanExtension}`
    : defaultName;

  if (!isNeutralinoRuntime()) return baseName(suggestedName) || suggestedName;

  await requireNative();
  const selectedPath = await os.showSaveDialog(title, {
    defaultPath: suggestedName,
    filters: cleanExtension
      ? [{ name: filterName, extensions: [cleanExtension] }]
      : [],
    forceOverwrite: false,
  });
  if (!selectedPath) return null;
  return cleanExtension && !new RegExp(`\\.${cleanExtension}$`, "iu").test(selectedPath)
    ? `${selectedPath}.${cleanExtension}`
    : selectedPath;
}

export async function selectFolderDialog(title = "Seleccionar carpeta") {
  if (!isNeutralinoRuntime()) return null;
  await requireNative();
  return (await os.showFolderDialog(title)) || null;
}

export async function readBinarySource(source) {
  if (isBrowserFile(source)) return toExactArrayBuffer(await source.arrayBuffer());
  if (typeof source !== "string") {
    throw new TypeError("No se pudo leer el archivo seleccionado.");
  }
  await requireNative();
  return toExactArrayBuffer(await filesystem.readBinaryFile(source));
}

export function sourceName(source) {
  return isBrowserFile(source) ? source.name : baseName(source);
}

/**
 * Writes an exact binary buffer or triggers a browser download.
 */
export async function writePath(
  destination,
  data,
  fallbackName = "documento.pdf",
  mimeType = "application/pdf",
) {
  const buffer = toExactArrayBuffer(data);

  if (isNeutralinoRuntime()) {
    if (typeof destination !== "string" || destination.length === 0) {
      throw new TypeError("Se necesita una ruta para guardar el archivo.");
    }

    await requireNative();
    await filesystem.writeBinaryFile(destination, buffer);
    return destination;
  }

  if (
    typeof document === "undefined"
    || typeof Blob === "undefined"
    || typeof globalThis.URL?.createObjectURL !== "function"
  ) {
    throw new Error("Este navegador no permite descargar el archivo.");
  }

  const filename = baseName(
    typeof destination === "string" ? destination : fallbackName,
  ) || fallbackName;
  const objectUrl = globalThis.URL.createObjectURL(
    new Blob([buffer], { type: mimeType }),
  );
  const anchor = document.createElement("a");

  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(objectUrl), 0);

  return filename;
}

export async function joinPath(...parts) {
  const safeParts = parts.map((part) => String(part || ""));
  if (isNeutralinoRuntime()) {
    await requireNative();
    return filesystem.getJoinedPath(...safeParts);
  }
  return safeParts.filter(Boolean).join("/");
}

export async function executeCommand(command, options = {}) {
  if (!isNeutralinoRuntime()) {
    throw new Error("Esta conversión necesita la aplicación de escritorio.");
  }
  await requireNative();
  return os.execCommand(command, options);
}

export async function getPathStats(path) {
  if (!isNeutralinoRuntime()) return null;
  await requireNative();
  try {
    return await filesystem.getStats(path);
  } catch {
    return null;
  }
}

function cacheRelativePath(root, candidate) {
  const normalize = (value) => String(value || "")
    .replace(/\\/gu, "/")
    .replace(/\/+$/gu, "");
  const windows = String(globalThis.window?.NL_OS || "")
    .toLocaleLowerCase()
    .includes("win");
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  const comparableRoot = windows
    ? normalizedRoot.toLocaleLowerCase("en-US")
    : normalizedRoot;
  const comparableCandidate = windows
    ? normalizedCandidate.toLocaleLowerCase("en-US")
    : normalizedCandidate;
  if (comparableCandidate === comparableRoot) return "";
  if (!comparableCandidate.startsWith(`${comparableRoot}/`)) return null;
  return normalizedCandidate.slice(normalizedRoot.length + 1);
}

function assertPresentationCachePath(root, candidate, { allowRoot = false } = {}) {
  const relative = cacheRelativePath(root, candidate);
  if ((allowRoot && relative === "") || PRESENTATION_CACHE_ENTRY.test(relative || "")) {
    return;
  }
  throw new Error("Se rechazó una ruta que no pertenece a la caché de presentaciones.");
}

/**
 * Returns a narrowly-scoped native backend for persistent presentation previews.
 * Deletion is limited to immediate versioned children owned by TenjinReader.
 */
export async function getPresentationPreviewCacheBackend() {
  if (!isNeutralinoRuntime()) {
    throw new Error("La caché de presentaciones necesita la aplicación de escritorio.");
  }
  await requireNative();
  const cacheRoot = await os.getPath("cache");
  const rootDirectory = await filesystem.getJoinedPath(
    cacheRoot,
    PRESENTATION_CACHE_DIRECTORY,
  );
  return Object.freeze({
    rootDirectory,
    async createDirectory(path) {
      assertPresentationCachePath(rootDirectory, path, { allowRoot: true });
      await filesystem.createDirectory(path);
    },
    async readDirectory(path) {
      assertPresentationCachePath(rootDirectory, path, { allowRoot: true });
      return filesystem.readDirectory(path, { recursive: false });
    },
    async removeDirectory(path) {
      assertPresentationCachePath(rootDirectory, path);
      await filesystem.remove(path);
    },
  });
}

function nativePathsMatch(left, right) {
  const normalize = (value) => String(value || "")
    .replace(/\\/gu, "/")
    .replace(/\/+$/gu, "");
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  const windowsPath = /^[a-z]:\//iu.test(normalizedLeft)
    || String(globalThis.window?.NL_OS || "").toLocaleLowerCase().includes("win");
  return windowsPath
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

async function unusedSiblingPath(destination) {
  const token = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const candidate = `${destination}.folentra-${token}.tmp`;
  if (await getPathStats(candidate)) {
    throw new Error("No se pudo reservar una ruta temporal para cambiar el nombre.");
  }
  return candidate;
}

/**
 * Renames or moves a file. Existing destinations are rejected unless the
 * caller explicitly confirms replacement. A same-directory backup makes a
 * confirmed replacement recoverable if the second move fails.
 */
export async function movePath(source, destination, { overwrite = false } = {}) {
  if (!isNeutralinoRuntime()) {
    throw new Error("Cambiar el nombre en disco necesita la aplicacion de escritorio.");
  }
  if (typeof source !== "string" || !source || typeof destination !== "string" || !destination) {
    throw new TypeError("Se necesitan rutas validas para cambiar el nombre.");
  }
  await requireNative();
  if (source === destination) return destination;

  const sourceStats = await getPathStats(source);
  if (!sourceStats?.isFile) throw new Error("No se encontro el archivo original.");
  const destinationStats = await getPathStats(destination);

  // Windows needs an intermediate path for case-only renames.
  if (destinationStats?.isFile && nativePathsMatch(source, destination)) {
    const intermediate = await unusedSiblingPath(destination);
    await filesystem.move(source, intermediate);
    try {
      await filesystem.move(intermediate, destination);
    } catch (error) {
      try {
        await filesystem.move(intermediate, source);
      } catch {
        // Preserve the original failure; the temporary file still contains all data.
      }
      throw error;
    }
    return destination;
  }

  if (destinationStats && !destinationStats.isFile) {
    throw new Error("La ruta de destino esta ocupada por una carpeta.");
  }
  if (destinationStats?.isFile && !overwrite) {
    const error = new Error("Ya existe un archivo con ese nombre.");
    error.code = "FILE_EXISTS";
    throw error;
  }

  let backupPath = null;
  if (destinationStats?.isFile) {
    backupPath = await unusedSiblingPath(destination);
    await filesystem.move(destination, backupPath);
  }

  try {
    await filesystem.move(source, destination);
  } catch (error) {
    if (backupPath) {
      try {
        await filesystem.move(backupPath, destination);
      } catch {
        // Keep the backup on disk rather than deleting recoverable user data.
      }
    }
    throw error;
  }

  if (backupPath) {
    try {
      await filesystem.remove(backupPath);
    } catch {
      // The requested rename succeeded; a harmless hidden backup may remain.
    }
  }
  return destination;
}

/** Copies a file natively without materializing it in the webview process. */
export async function copyPath(source, destination, { overwrite = false } = {}) {
  if (!isNeutralinoRuntime()) {
    throw new Error("Copiar archivos necesita la aplicación de escritorio.");
  }
  if (typeof source !== "string" || !source || typeof destination !== "string" || !destination) {
    throw new TypeError("Se necesitan rutas válidas para copiar el archivo.");
  }
  await requireNative();
  if (nativePathsMatch(source, destination)) return destination;
  const sourceStats = await getPathStats(source);
  if (!sourceStats?.isFile) throw new Error("No se encontró el archivo que se va a copiar.");
  const destinationStats = await getPathStats(destination);
  if (destinationStats && !destinationStats.isFile) {
    throw new Error("La ruta de destino está ocupada por una carpeta.");
  }
  if (destinationStats?.isFile && !overwrite) {
    const error = new Error("Ya existe un archivo con ese nombre.");
    error.code = "FILE_EXISTS";
    throw error;
  }
  await filesystem.copy(source, destination, {
    recursive: false,
    overwrite: Boolean(overwrite),
    skip: false,
  });
  return destination;
}

/** Replaces a native file through a verified sibling staging file. */
export async function writePathAtomic(destination, data, { overwrite = false } = {}) {
  if (!isNeutralinoRuntime()) {
    throw new Error("La escritura transaccional necesita la aplicación de escritorio.");
  }
  if (typeof destination !== "string" || !destination) {
    throw new TypeError("Se necesita una ruta válida para guardar el archivo.");
  }
  const buffer = toExactArrayBuffer(data);
  await requireNative();
  return replaceFileTransaction({
    destination,
    byteLength: buffer.byteLength,
    overwrite,
    getStats: getPathStats,
    temporaryPath: unusedSiblingPath,
    writeStagedFile: (path) => filesystem.writeBinaryFile(path, buffer),
    moveFile: (source, target) => filesystem.move(source, target),
    removeFile: (path) => filesystem.remove(path),
  });
}

/** Removes one exact file path; directories are always rejected. */
export async function removeFilePath(path) {
  if (!isNeutralinoRuntime()) {
    throw new Error("Eliminar el nombre anterior necesita la aplicación de escritorio.");
  }
  if (typeof path !== "string" || !path) {
    throw new TypeError("Se necesita una ruta válida para eliminar el archivo.");
  }
  await requireNative();
  const stats = await getPathStats(path);
  if (!stats) return false;
  if (!stats.isFile) throw new Error("Se rechazó eliminar una ruta que no es un archivo.");
  await filesystem.remove(path);
  if (await getPathStats(path)) {
    throw new Error("No se pudo eliminar el nombre anterior del archivo.");
  }
  return true;
}

/** Creates an isolated per-operation directory below the OS temporary folder. */
export async function createTemporaryDirectory(purpose = "trabajo") {
  if (!isNeutralinoRuntime()) {
    throw new Error("Esta operación necesita la aplicación de escritorio.");
  }
  await requireNative();
  const tempRoot = await os.getPath("temp");
  const safePurpose = String(purpose)
    .normalize("NFKD")
    .replace(/[^a-z0-9_-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32) || "trabajo";
  const token = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const path = await filesystem.getJoinedPath(
    tempRoot,
    `${TEMP_DIRECTORY_PREFIX}${safePurpose}-${token}`,
  );
  await filesystem.createDirectory(path);
  return path;
}

/** Removes only immediate Folentra-owned children of the OS temporary folder. */
export async function removeTemporaryDirectory(path) {
  if (!isNeutralinoRuntime()) return false;
  await requireNative();
  const tempRoot = await os.getPath("temp");
  const normalize = (value) => String(value)
    .replace(/\\/gu, "/")
    .replace(/\/+$/gu, "")
    .toLocaleLowerCase("en-US");
  const normalizedRoot = normalize(tempRoot);
  const normalizedPath = normalize(path);
  const relative = normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : "";
  if (!relative.startsWith(TEMP_DIRECTORY_PREFIX) || relative.includes("/")) {
    throw new Error("Se rechazó una ruta temporal que no pertenece a TenjinReader.");
  }
  try {
    await filesystem.remove(path);
  } catch (error) {
    const stats = await getPathStats(path);
    if (stats) throw error;
  }
  return true;
}

export async function openExternal(value) {
  const url = normalizeExternalUrl(value);
  if (!url) {
    return false;
  }

  if (isNeutralinoRuntime()) {
    await requireNative();
    await os.open(url);
    return true;
  }

  if (typeof document === "undefined") {
    return false;
  }

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.rel = "noopener noreferrer";
  anchor.target = "_blank";
  anchor.click();
  return true;
}

export async function setTitle(value = APP_TITLE) {
  const title = String(value || APP_TITLE)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, 160) || APP_TITLE;

  if (isNeutralinoRuntime()) {
    await requireNative();
    await neutralinoWindow.setTitle(title);
  } else if (typeof document !== "undefined") {
    document.title = title;
  }

  return title;
}

function unquoteArgument(value) {
  if (typeof value !== "string") {
    return "";
  }

  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

/**
 * Finds a supported document passed to the process (for "Open with" flows).
 */
export async function getLaunchDocumentPath() {
  if (!isNeutralinoRuntime() || !(await initializeNative())) {
    return null;
  }

  try {
    // Also confirms the native connection before probing launch arguments.
    await app.getConfig();
  } catch {
    return null;
  }

  const args = globalThis.window.NL_ARGS;
  for (const argument of args) {
    const candidate = unquoteArgument(argument);
    if (!getDocumentType(candidate)) {
      continue;
    }

    try {
      const stats = await filesystem.getStats(candidate);
      if (stats.isFile) {
        return candidate;
      }
    } catch {
      // Ignore stale or inaccessible launch arguments.
    }
  }

  return null;
}

if (isNeutralinoRuntime()) {
  void initializeNative();
}
