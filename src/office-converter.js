const OFFICE_EXTENSIONS = Object.freeze({
  doc: "word",
  docx: "word",
  odf: "formula",
  odp: "powerpoint",
  ppt: "powerpoint",
  pptx: "powerpoint",
  xls: "excel",
  xlsx: "excel",
});

const OFFICE_PDF_FILTERS = Object.freeze({
  excel: "calc_pdf_Export",
  formula: "math_pdf_Export",
  powerpoint: "impress_pdf_Export",
  word: "writer_pdf_Export",
});

const PRESENTATION_EXTENSIONS = new Set(["odf", "odp", "ppt", "pptx"]);

const PLATFORM_ALIASES = Object.freeze({
  darwin: "macos",
  linux: "linux",
  mac: "macos",
  macos: "macos",
  win: "windows",
  win32: "windows",
  windows: "windows",
});

const COMMON_EXECUTABLES = Object.freeze({
  windows: Object.freeze([
    "C:\\Program Files\\LibreOffice\\program\\soffice.com",
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    "soffice.com",
    "soffice.exe",
  ]),
  linux: Object.freeze([
    "/usr/bin/libreoffice",
    "/usr/bin/soffice",
    "/usr/local/bin/libreoffice",
    "/usr/local/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
    "/opt/libreoffice/program/soffice",
    "/snap/bin/libreoffice",
    "libreoffice",
    "soffice",
  ]),
  macos: Object.freeze([
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/libreoffice",
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/libreoffice",
    "/usr/local/bin/soffice",
    "libreoffice",
    "soffice",
  ]),
});

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f\u2028\u2029]/u;
const WINDOWS_DOUBLE_QUOTE = /"/u;
const WINDOWS_EXPANSION = /[%!]/u;
const SAFE_COMMAND_NAME = /^[a-z\d._+-]+$/iu;

// Main may create a converter for each operation. Keep successful detection
// promises shared by dependency identity so reopening a deck does not launch
// another `soffice --version` process. WeakMaps do not retain old runtimes.
const SHARED_EXECUTABLE_DETECTIONS = new WeakMap();

export class LibreOfficeUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "LibreOfficeUnavailableError";
    this.code = "LIBREOFFICE_UNAVAILABLE";
  }
}

export class PresentationConversionRequiredError extends Error {
  constructor(format, options) {
    super(
      `Para abrir archivos .${format} con fidelidad se necesita LibreOffice instalado.`,
      options,
    );
    this.name = "PresentationConversionRequiredError";
    this.code = "PRESENTATION_CONVERSION_REQUIRED";
    this.format = format;
  }
}

export function normalizeOfficePlatform(platform) {
  const normalized = String(platform || "").trim().toLocaleLowerCase("en-US");
  const result = PLATFORM_ALIASES[normalized];
  if (!result) {
    throw new TypeError("La plataforma debe ser Windows, Linux o macOS.");
  }
  return result;
}

function assertSafeShellValue(value, label, platform) {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new TypeError(`${label} debe ser texto y no puede estar vacía.`);
  }
  if (CONTROL_CHARACTER.test(value)) {
    throw new TypeError(
      `${label} contiene caracteres de control o saltos de línea no permitidos.`,
    );
  }
  if (platform === "windows" && WINDOWS_DOUBLE_QUOTE.test(value)) {
    throw new TypeError(`${label} contiene comillas no permitidas por Windows.`);
  }
  if (platform === "windows" && WINDOWS_EXPANSION.test(value)) {
    throw new TypeError(
      `${label} contiene caracteres que Windows podría expandir de forma insegura.`,
    );
  }
  return value;
}

function isAbsolutePath(value, platform) {
  if (platform === "windows") {
    return /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/iu.test(value);
  }
  return value.startsWith("/");
}

function assertAbsolutePath(value, label, platform) {
  assertSafeShellValue(value, label, platform);
  if (!isAbsolutePath(value, platform)) {
    throw new TypeError(`${label} debe ser una ruta absoluta.`);
  }
  return value;
}

function isBareCommand(value) {
  return SAFE_COMMAND_NAME.test(value);
}

function assertExecutable(value, platform) {
  assertSafeShellValue(value, "La ruta de LibreOffice", platform);
  if (!isBareCommand(value) && !isAbsolutePath(value, platform)) {
    throw new TypeError(
      "La ruta de LibreOffice debe ser absoluta o un nombre de comando seguro.",
    );
  }
  return value;
}

function quoteWindowsArgument(value) {
  let result = '"';
  let backslashes = 0;

  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    result += "\\".repeat(backslashes);
    backslashes = 0;
    result += character;
  }

  // CommandLineToArgvW requires trailing backslashes to be doubled before the
  // closing quote. Quotes inside values are rejected before reaching here.
  result += "\\".repeat(backslashes * 2);
  return `${result}"`;
}

function quotePosixArgument(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function quoteCommandArgument(value, platform) {
  const normalizedPlatform = normalizeOfficePlatform(platform);
  const safeValue = assertSafeShellValue(
    value,
    "El argumento del comando",
    normalizedPlatform,
  );
  return normalizedPlatform === "windows"
    ? quoteWindowsArgument(safeValue)
    : quotePosixArgument(safeValue);
}

function baseName(value) {
  return String(value || "").replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() || "";
}

export function getOfficeDocumentType(sourcePath) {
  const name = baseName(sourcePath);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return OFFICE_EXTENSIONS[name.slice(dot + 1).toLocaleLowerCase("en-US")] || null;
}

function getExtension(sourcePath) {
  const name = baseName(sourcePath);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLocaleLowerCase("en-US");
}

export function getOfficePdfFilter(sourcePath) {
  const documentType = getOfficeDocumentType(sourcePath);
  return documentType ? OFFICE_PDF_FILTERS[documentType] : null;
}

/**
 * Describes local presentation-viewer formats. ODF is LibreOffice Math's
 * OpenDocument Formula format, so it intentionally has no canvas fallback.
 */
export function getPresentationDocumentInfo(sourcePath) {
  const extension = getExtension(sourcePath);
  if (!PRESENTATION_EXTENSIONS.has(extension)) return null;
  const documentType = getOfficeDocumentType(sourcePath);
  return Object.freeze({
    extension,
    documentType,
    pdfFilter: OFFICE_PDF_FILTERS[documentType],
    canvasFallback: extension === "pptx",
  });
}

export function getOfficePdfOutputPath(sourcePath, outputDirectory, platform) {
  const normalizedPlatform = normalizeOfficePlatform(platform);
  assertAbsolutePath(sourcePath, "La ruta del documento", normalizedPlatform);
  assertAbsolutePath(outputDirectory, "La carpeta de salida", normalizedPlatform);

  if (!getOfficeDocumentType(sourcePath)) {
    throw new TypeError(
      "El archivo debe ser un documento Word, PowerPoint o Excel compatible.",
    );
  }

  const name = baseName(sourcePath);
  const stem = name.slice(0, name.lastIndexOf("."));
  if (!stem || stem === "." || stem === "..") {
    throw new TypeError("El documento no tiene un nombre válido para crear el PDF.");
  }

  const separator = normalizedPlatform === "windows" ? "\\" : "/";
  const prefix = /[\\/]$/u.test(outputDirectory)
    ? outputDirectory
    : `${outputDirectory}${separator}`;
  return `${prefix}${stem}.pdf`;
}

export function getLibreOfficeCandidates(platform, libreOfficePath = null) {
  const normalizedPlatform = normalizeOfficePlatform(platform);
  if (libreOfficePath !== null && libreOfficePath !== undefined) {
    assertAbsolutePath(
      libreOfficePath,
      "La ruta de LibreOffice",
      normalizedPlatform,
    );
    return [libreOfficePath];
  }
  return [...COMMON_EXECUTABLES[normalizedPlatform]];
}

function buildCommand(
  executable,
  args,
  platform,
  { userProfileDirectory = null } = {},
) {
  const normalizedPlatform = normalizeOfficePlatform(platform);
  assertExecutable(executable, normalizedPlatform);
  const parts = [quoteCommandArgument(executable, normalizedPlatform)];
  if (userProfileDirectory) {
    const profileArgument = `-env:UserInstallation=${officePathToFileUrl(
      userProfileDirectory,
      normalizedPlatform,
    )}`;
    // Percent escapes in this argument are generated by encodeURIComponent,
    // never accepted from the original Windows path (which was validated).
    parts.push(
      normalizedPlatform === "windows"
        ? quoteWindowsArgument(profileArgument)
        : quotePosixArgument(profileArgument),
    );
  }
  parts.push(
    ...args.map((value) => quoteCommandArgument(value, normalizedPlatform)),
  );
  return parts.join(" ");
}

function joinAbsolutePath(directory, name, platform) {
  const separator = platform === "windows" ? "\\" : "/";
  return /[\\/]$/u.test(directory)
    ? `${directory}${name}`
    : `${directory}${separator}${name}`;
}

function createProfileSuffix() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.replaceAll("-", "");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
    .replace(/[^a-z\d]/giu, "")
    .slice(0, 32);
}

export function getIsolatedOfficeProfilePath(outputDirectory, platform) {
  const normalizedPlatform = normalizeOfficePlatform(platform);
  assertAbsolutePath(outputDirectory, "La carpeta de salida", normalizedPlatform);
  return joinAbsolutePath(
    outputDirectory,
    `.pluma-reader-lo-${createProfileSuffix()}`,
    normalizedPlatform,
  );
}

export function officePathToFileUrl(path, platform) {
  const normalizedPlatform = normalizeOfficePlatform(platform);
  assertAbsolutePath(path, "La carpeta de perfil de LibreOffice", normalizedPlatform);
  const normalized = path.replaceAll("\\", "/");
  if (normalizedPlatform === "windows") {
    if (normalized.startsWith("//")) {
      const [host, ...parts] = normalized.slice(2).split("/");
      return `file://${host}/${parts.map(encodeURIComponent).join("/")}`;
    }
    const drive = normalized.slice(0, 2);
    const rest = normalized.slice(2).split("/").map(encodeURIComponent).join("/");
    return `file:///${drive}${rest}`;
  }
  return `file://${normalized.split("/").map(encodeURIComponent).join("/")}`;
}

export function buildLibreOfficeConvertCommand({
  executable,
  sourcePath,
  outputDirectory,
  platform,
  userProfileDirectory = null,
}) {
  const normalizedPlatform = normalizeOfficePlatform(platform);
  assertAbsolutePath(sourcePath, "La ruta del documento", normalizedPlatform);
  assertAbsolutePath(outputDirectory, "La carpeta de salida", normalizedPlatform);
  const pdfFilter = getOfficePdfFilter(sourcePath);
  if (!pdfFilter) {
    throw new TypeError(
      "El archivo debe ser un documento Office u OpenDocument compatible.",
    );
  }
  return buildCommand(
    executable,
    [
      "--headless",
      "--nologo",
      "--nodefault",
      "--nofirststartwizard",
      "--norestore",
      "--convert-to",
      `pdf:${pdfFilter}`,
      "--outdir",
      outputDirectory,
      sourcePath,
    ],
    normalizedPlatform,
    { userProfileDirectory },
  );
}

function validateDependencies(execCommand, getStats) {
  if (typeof execCommand !== "function") {
    throw new TypeError("Se necesita una función execCommand para usar LibreOffice.");
  }
  if (typeof getStats !== "function") {
    throw new TypeError("Se necesita una función getStats para verificar los archivos.");
  }
}

async function tryGetStats(getStats, path) {
  try {
    return await getStats(path);
  } catch {
    return null;
  }
}

async function canRunLibreOffice(execCommand, executable, platform) {
  const command = buildCommand(
    executable,
    ["--headless", "--version"],
    platform,
  );
  try {
    const result = await execCommand(command);
    return Number(result?.exitCode) === 0;
  } catch {
    return false;
  }
}

export async function detectLibreOffice({
  execCommand,
  getStats,
  platform,
  libreOfficePath = null,
}) {
  validateDependencies(execCommand, getStats);
  const normalizedPlatform = normalizeOfficePlatform(platform);
  const candidates = getLibreOfficeCandidates(normalizedPlatform, libreOfficePath);
  const explicit = libreOfficePath !== null && libreOfficePath !== undefined;

  for (const executable of candidates) {
    const isPath = isAbsolutePath(executable, normalizedPlatform);
    if (isPath) {
      const stats = await tryGetStats(getStats, executable);
      if (!stats?.isFile) {
        if (explicit) {
          throw new LibreOfficeUnavailableError(
            "No se encontró LibreOffice en la ruta configurada.",
          );
        }
        continue;
      }
    }

    if (await canRunLibreOffice(execCommand, executable, normalizedPlatform)) {
      return executable;
    }
    if (explicit) {
      throw new LibreOfficeUnavailableError(
        "Se encontró LibreOffice, pero no se pudo ejecutar desde la ruta configurada.",
      );
    }
  }

  throw new LibreOfficeUnavailableError(
    "No se encontró LibreOffice. Instálalo o configura manualmente la ruta de su ejecutable.",
  );
}

function getSharedExecutableDetection({
  execCommand,
  getStats,
  platform,
  libreOfficePath,
}) {
  let statsCaches = SHARED_EXECUTABLE_DETECTIONS.get(execCommand);
  if (!statsCaches) {
    statsCaches = new WeakMap();
    SHARED_EXECUTABLE_DETECTIONS.set(execCommand, statsCaches);
  }
  let detections = statsCaches.get(getStats);
  if (!detections) {
    detections = new Map();
    statsCaches.set(getStats, detections);
  }

  const key = `${platform}\u0000${libreOfficePath ?? "<auto>"}`;
  let detection = detections.get(key);
  if (!detection) {
    detection = detectLibreOffice({
      execCommand,
      getStats,
      platform,
      libreOfficePath,
    }).catch((error) => {
      // An installation can appear later in the same session. Only cache a
      // successful probe; failed probes remain retryable.
      if (detections.get(key) === detection) detections.delete(key);
      throw error;
    });
    detections.set(key, detection);
  }
  return detection;
}

async function prepareConversion({
  sourcePath,
  outputDirectory,
  getStats,
  platform,
  overwrite,
}) {
  const normalizedPlatform = normalizeOfficePlatform(platform);
  assertAbsolutePath(sourcePath, "La ruta del documento", normalizedPlatform);
  assertAbsolutePath(outputDirectory, "La carpeta de salida", normalizedPlatform);
  const documentType = getOfficeDocumentType(sourcePath);
  if (!documentType) {
    throw new TypeError(
      "El archivo debe ser un documento Word, PowerPoint o Excel compatible.",
    );
  }

  const sourceStats = await tryGetStats(getStats, sourcePath);
  if (!sourceStats?.isFile) {
    throw new Error("No se encontró el documento que se desea convertir.");
  }
  const directoryStats = await tryGetStats(getStats, outputDirectory);
  if (!directoryStats?.isDirectory) {
    throw new Error("La carpeta de salida no existe o no es accesible.");
  }

  const outputPath = getOfficePdfOutputPath(
    sourcePath,
    outputDirectory,
    normalizedPlatform,
  );
  const previousOutputStats = await tryGetStats(getStats, outputPath);
  if (previousOutputStats && !previousOutputStats.isFile) {
    throw new Error("La ruta de salida ya está ocupada por una carpeta.");
  }
  if (previousOutputStats?.isFile && !overwrite) {
    throw new Error(
      "Ya existe un PDF con ese nombre. Elige otra carpeta o permite reemplazarlo.",
    );
  }

  return {
    documentType,
    normalizedPlatform,
    outputPath,
    previousOutputStats,
  };
}

function outputWasUpdated(before, after) {
  if (!before) return true;
  const comparable = [];
  if (Number.isFinite(Number(before.size)) && Number.isFinite(Number(after.size))) {
    comparable.push(Number(before.size) !== Number(after.size));
  }
  if (
    Number.isFinite(Number(before.modifiedAt))
    && Number.isFinite(Number(after.modifiedAt))
  ) {
    comparable.push(Number(before.modifiedAt) !== Number(after.modifiedAt));
  }
  return comparable.some(Boolean);
}

async function runConversion({
  sourcePath,
  outputDirectory,
  execCommand,
  getStats,
  platform,
  executable,
  overwrite,
  userProfileDirectory = null,
  preparedConversion = null,
}) {
  // Callers that already validated the source/output can pass that result and
  // avoid repeating four native filesystem round trips before every export.
  const prepared = preparedConversion || await prepareConversion({
    sourcePath,
    outputDirectory,
    getStats,
    platform,
    overwrite,
  });
  const command = buildLibreOfficeConvertCommand({
    executable,
    sourcePath,
    outputDirectory,
    platform: prepared.normalizedPlatform,
    userProfileDirectory,
  });

  let result;
  try {
    result = await execCommand(command);
  } catch (cause) {
    throw new Error("No se pudo iniciar LibreOffice para convertir el documento.", {
      cause,
    });
  }
  if (Number(result?.exitCode) !== 0) {
    const exitCode = Number.isFinite(Number(result?.exitCode))
      ? Number(result.exitCode)
      : "desconocido";
    throw new Error(`LibreOffice no pudo convertir el documento (código ${exitCode}).`);
  }

  const outputStats = await tryGetStats(getStats, prepared.outputPath);
  if (!outputStats?.isFile || !(Number(outputStats.size) > 0)) {
    throw new Error(
      "LibreOffice terminó, pero no generó un PDF válido en la carpeta seleccionada.",
    );
  }
  if (!outputWasUpdated(prepared.previousOutputStats, outputStats)) {
    throw new Error(
      "LibreOffice terminó, pero no se pudo verificar que haya actualizado el PDF existente.",
    );
  }

  return Object.freeze({
    path: prepared.outputPath,
    name: baseName(prepared.outputPath),
    size: Number(outputStats.size),
    sourceType: prepared.documentType,
    executable,
  });
}

export async function convertOfficeToPdf({
  sourcePath,
  outputDirectory,
  execCommand,
  getStats,
  platform,
  libreOfficePath = null,
  overwrite = false,
  userProfileDirectory = null,
}) {
  validateDependencies(execCommand, getStats);
  const prepared = await prepareConversion({
    sourcePath,
    outputDirectory,
    getStats,
    platform,
    overwrite: Boolean(overwrite),
  });
  const executable = await detectLibreOffice({
    execCommand,
    getStats,
    platform: prepared.normalizedPlatform,
    libreOfficePath,
  });
  return runConversion({
    sourcePath,
    outputDirectory,
    execCommand,
    getStats,
    platform: prepared.normalizedPlatform,
    executable,
    overwrite: Boolean(overwrite),
    userProfileDirectory,
    preparedConversion: prepared,
  });
}

function requirePresentationInfo(sourcePath) {
  const info = getPresentationDocumentInfo(sourcePath);
  if (!info) {
    throw new TypeError("El archivo debe ser PPT, PPTX, ODP u ODF.");
  }
  return info;
}

function pdfPresentationView(conversion, info, temporaryProfilePath = null) {
  return Object.freeze({
    mode: "pdf",
    renderer: "pdfjs",
    fidelity: "libreoffice",
    originalFormat: info.extension,
    temporaryProfilePath,
    ...conversion,
  });
}

function pptxCanvasView(sourcePath, info, reason) {
  return Object.freeze({
    mode: "pptx-canvas",
    renderer: "pptxviewjs",
    fidelity: "fallback",
    originalFormat: info.extension,
    sourcePath,
    reason,
  });
}

function handlePresentationConversionUnavailable(
  error,
  sourcePath,
  info,
  allowPptxCanvasFallback,
) {
  if (!(error instanceof LibreOfficeUnavailableError)) throw error;
  if (info.canvasFallback && allowPptxCanvasFallback) {
    return pptxCanvasView(sourcePath, info, error.message);
  }
  throw new PresentationConversionRequiredError(info.extension, { cause: error });
}

function assertPreviewCache(previewCache) {
  if (
    previewCache !== null
    && previewCache !== undefined
    && typeof previewCache.acquire !== "function"
  ) {
    throw new TypeError(
      "La caché de presentaciones debe proporcionar una función acquire.",
    );
  }
  return previewCache || null;
}

function comparablePath(value, platform) {
  const normalized = String(value || "").replaceAll("\\", "/");
  return platform === "windows"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function validatePreviewCacheEntry(entry, sourcePath, platform) {
  if (!entry || typeof entry !== "object") {
    throw new TypeError("La caché no devolvió un destino de previsualización válido.");
  }
  const expectedOutputPath = getOfficePdfOutputPath(
    sourcePath,
    entry.outputDirectory,
    platform,
  );
  if (
    comparablePath(expectedOutputPath, platform)
    !== comparablePath(entry.outputPath, platform)
  ) {
    throw new TypeError("La caché devolvió una ruta PDF que no corresponde al documento.");
  }
  return entry;
}

async function acquirePreviewCache(
  previewCache,
  sourcePath,
  platform,
  onPreviewCacheError,
) {
  const cache = assertPreviewCache(previewCache);
  if (!cache) return null;
  try {
    const entry = await cache.acquire(sourcePath);
    return validatePreviewCacheEntry(entry, sourcePath, platform);
  } catch (error) {
    if (typeof onPreviewCacheError === "function") {
      try {
        onPreviewCacheError(error);
      } catch {
        // Cache diagnostics must never prevent opening a presentation.
      }
    }
    return null;
  }
}

function cachedPresentationConversion(entry, info) {
  return Object.freeze({
    path: entry.outputPath,
    name: baseName(entry.outputPath),
    size: Number(entry.size),
    sourceType: info.documentType,
    executable: null,
    cacheHit: true,
    cacheKey: entry.key,
  });
}

function annotatePreviewConversion(conversion, entry) {
  if (!entry) return conversion;
  return Object.freeze({
    ...conversion,
    cacheHit: false,
    cacheKey: entry.key,
  });
}

/**
 * Chooses the fidelity-first local viewing route. LibreOffice PDF export is
 * preferred for every supported format; only PPTX can fall back to the
 * browser canvas parser when LibreOffice is not installed.
 */
export async function preparePresentationForViewing({
  sourcePath,
  outputDirectory,
  execCommand,
  getStats,
  platform,
  libreOfficePath = null,
  overwrite = false,
  allowPptxCanvasFallback = true,
  userProfileDirectory = null,
  previewCache = null,
  onPreviewCacheError = null,
}) {
  const info = requirePresentationInfo(sourcePath);
  const normalizedPlatform = normalizeOfficePlatform(platform);
  const isolatedProfile = userProfileDirectory || getIsolatedOfficeProfilePath(
    outputDirectory,
    normalizedPlatform,
  );
  const cacheEntry = await acquirePreviewCache(
    previewCache,
    sourcePath,
    normalizedPlatform,
    onPreviewCacheError,
  );
  if (cacheEntry?.hit) {
    return pdfPresentationView(
      cachedPresentationConversion(cacheEntry, info),
      info,
      null,
    );
  }
  try {
    const conversion = annotatePreviewConversion(await convertOfficeToPdf({
      sourcePath,
      outputDirectory: cacheEntry?.outputDirectory || outputDirectory,
      execCommand,
      getStats,
      platform: normalizedPlatform,
      libreOfficePath,
      overwrite: cacheEntry ? true : overwrite,
      userProfileDirectory: isolatedProfile,
    }), cacheEntry);
    return pdfPresentationView(conversion, info, isolatedProfile);
  } catch (error) {
    return handlePresentationConversionUnavailable(
      error,
      sourcePath,
      info,
      Boolean(allowPptxCanvasFallback),
    );
  }
}

export function createOfficeConverter({
  execCommand,
  getStats,
  platform,
  libreOfficePath = null,
  previewCache = null,
  onPreviewCacheError = null,
}) {
  validateDependencies(execCommand, getStats);
  const normalizedPlatform = normalizeOfficePlatform(platform);
  const configuredPreviewCache = assertPreviewCache(previewCache);
  let executablePromise = null;

  const resolveExecutable = () => {
    if (!executablePromise) {
      executablePromise = getSharedExecutableDetection({
        execCommand,
        getStats,
        platform: normalizedPlatform,
        libreOfficePath,
      }).catch((error) => {
        executablePromise = null;
        throw error;
      });
    }
    return executablePromise;
  };

  return Object.freeze({
    detectLibreOffice: resolveExecutable,
    warmUp: resolveExecutable,
    async convertToPdf(sourcePath, outputDirectory, options = {}) {
      const overwrite = Boolean(options.overwrite);
      const prepared = await prepareConversion({
        sourcePath,
        outputDirectory,
        getStats,
        platform: normalizedPlatform,
        overwrite,
      });
      const executable = await resolveExecutable();
      return runConversion({
        sourcePath,
        outputDirectory,
        execCommand,
        getStats,
        platform: prepared.normalizedPlatform,
        executable,
        overwrite,
        userProfileDirectory: options.userProfileDirectory || null,
        preparedConversion: prepared,
      });
    },
    async preparePresentationForViewing(sourcePath, outputDirectory, options = {}) {
      const info = requirePresentationInfo(sourcePath);
      const overwrite = Boolean(options.overwrite);
      const allowPptxCanvasFallback = options.allowPptxCanvasFallback !== false;
      const userProfileDirectory = options.userProfileDirectory
        || getIsolatedOfficeProfilePath(outputDirectory, normalizedPlatform);
      const operationCache = Object.hasOwn(options, "previewCache")
        ? assertPreviewCache(options.previewCache)
        : configuredPreviewCache;
      const cacheEntry = await acquirePreviewCache(
        operationCache,
        sourcePath,
        normalizedPlatform,
        options.onPreviewCacheError || onPreviewCacheError,
      );
      if (cacheEntry?.hit) {
        return pdfPresentationView(
          cachedPresentationConversion(cacheEntry, info),
          info,
          null,
        );
      }
      try {
        const prepared = await prepareConversion({
          sourcePath,
          outputDirectory: cacheEntry?.outputDirectory || outputDirectory,
          getStats,
          platform: normalizedPlatform,
          overwrite: cacheEntry ? true : overwrite,
        });
        const executable = await resolveExecutable();
        const conversion = annotatePreviewConversion(await runConversion({
          sourcePath,
          outputDirectory: cacheEntry?.outputDirectory || outputDirectory,
          execCommand,
          getStats,
          platform: prepared.normalizedPlatform,
          executable,
          overwrite: cacheEntry ? true : overwrite,
          userProfileDirectory,
          preparedConversion: prepared,
        }), cacheEntry);
        return pdfPresentationView(conversion, info, userProfileDirectory);
      } catch (error) {
        return handlePresentationConversionUnavailable(
          error,
          sourcePath,
          info,
          allowPptxCanvasFallback,
        );
      }
    },
  });
}
