import {
  getOfficePdfOutputPath,
  normalizeOfficePlatform,
} from "./office-converter.js";

const DEFAULT_CACHE_VERSION = "v1";
const CACHE_VERSION_PATTERN = /^[a-z\d._-]{1,32}$/iu;
const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;
const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

function assertDependency(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`Se necesita una función ${label} para usar la caché.`);
  }
}

async function tryGetStats(getStats, path) {
  try {
    return await getStats(path);
  } catch {
    return null;
  }
}

function joinPath(directory, name, platform) {
  const separator = platform === "windows" ? "\\" : "/";
  return /[\\/]$/u.test(directory)
    ? `${directory}${name}`
    : `${directory}${separator}${name}`;
}

function assertSafeCacheRoot(rootDirectory, platform) {
  const value = String(rootDirectory || "");
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("La carpeta raíz de la caché no es válida.");
  }
  const isSafeAbsolute = platform === "windows"
    ? /^(?:[a-z]:[\\/][^\\/]+|\\\\[^\\/]+[\\/][^\\/]+[\\/][^\\/]+)/iu.test(value)
    : /^\/[^/]+/u.test(value);
  if (!isSafeAbsolute) {
    throw new TypeError(
      "La caché debe estar dentro de una carpeta absoluta específica de la aplicación.",
    );
  }
  return value;
}

function normalizeSourcePath(sourcePath, platform) {
  const normalized = String(sourcePath).replaceAll("\\", "/");
  return platform === "windows"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function normalizeFingerprintNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`No se pudo determinar ${label} de la presentación.`);
  }
  return String(number);
}

function fnv1a64(value) {
  let hash = FNV_OFFSET_BASIS_64;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * FNV_PRIME_64) & UINT64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Creates a path-private cache key. A changed path, size, timestamp or cache
 * schema produces a different directory, so an old preview can never be used
 * for a modified source presentation.
 */
export function getPresentationPreviewCacheKey({
  sourcePath,
  size,
  modifiedAt,
  platform,
  cacheVersion = DEFAULT_CACHE_VERSION,
}) {
  const normalizedPlatform = normalizeOfficePlatform(platform);
  const version = String(cacheVersion || "").trim();
  if (!CACHE_VERSION_PATTERN.test(version)) {
    throw new TypeError("La versión de caché no es válida.");
  }
  const normalizedPath = normalizeSourcePath(sourcePath, normalizedPlatform);
  const normalizedSize = normalizeFingerprintNumber(size, "el tamaño");
  const normalizedModifiedAt = normalizeFingerprintNumber(
    modifiedAt,
    "la fecha de modificación",
  );
  const fingerprint = [
    version,
    normalizedPlatform,
    normalizedPath,
    normalizedSize,
    normalizedModifiedAt,
  ].join("\u0000");
  return `${version}-${fnv1a64(fingerprint)}`;
}

async function ensureDirectory(getStats, createDirectory, path) {
  const current = await tryGetStats(getStats, path);
  if (current?.isDirectory) return;
  if (current) {
    throw new Error("Una ruta de la caché está ocupada por un archivo.");
  }

  try {
    await createDirectory(path);
  } catch (error) {
    // Another conversion may have created the same deterministic directory.
    const raced = await tryGetStats(getStats, path);
    if (!raced?.isDirectory) throw error;
  }
}

function normalizePruneLimit(value, fallback, label, integer = false) {
  if (value === undefined) return fallback;
  if (value === Infinity) return Infinity;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number))) {
    throw new TypeError(`${label} debe ser un número no negativo.`);
  }
  return number;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function inspectCacheDirectory({
  directory,
  key,
  getStats,
  readDirectory,
  platform,
}) {
  const directoryStats = await tryGetStats(getStats, directory);
  if (!directoryStats?.isDirectory) return null;
  let children;
  try {
    children = await readDirectory(directory, { recursive: false });
  } catch {
    return null;
  }

  let bytes = 0;
  let modifiedAt = Number(directoryStats.modifiedAt) || 0;
  for (const child of Array.isArray(children) ? children : []) {
    const name = String(child?.entry || "");
    if (!name || /[\\/]/u.test(name)) continue;
    const childPath = joinPath(
      directory,
      name,
      platform,
    );
    const stats = await tryGetStats(getStats, childPath);
    if (!stats?.isFile) continue;
    bytes += Math.max(0, Number(stats.size) || 0);
    modifiedAt = Math.max(modifiedAt, Number(stats.modifiedAt) || 0);
  }
  return { key, directory, bytes, modifiedAt };
}

/**
 * Creates a persistent, content-invalidating preview cache. `rootDirectory`
 * should be a direct child of an OS data/cache directory; this module creates
 * it and one deterministic child per source fingerprint.
 */
export function createPresentationPreviewCache({
  rootDirectory,
  platform,
  getStats,
  createDirectory,
  readDirectory = null,
  removeDirectory = null,
  cacheVersion = DEFAULT_CACHE_VERSION,
}) {
  assertDependency(getStats, "getStats");
  assertDependency(createDirectory, "createDirectory");
  const normalizedPlatform = normalizeOfficePlatform(platform);
  const safeRootDirectory = assertSafeCacheRoot(rootDirectory, normalizedPlatform);
  const version = String(cacheVersion || "").trim();
  if (!CACHE_VERSION_PATTERN.test(version)) {
    throw new TypeError("La versión de caché no es válida.");
  }
  if ((readDirectory === null) !== (removeDirectory === null)) {
    throw new TypeError(
      "La poda necesita proporcionar juntas readDirectory y removeDirectory.",
    );
  }
  if (readDirectory !== null) assertDependency(readDirectory, "readDirectory");
  if (removeDirectory !== null) assertDependency(removeDirectory, "removeDirectory");
  const entryPattern = new RegExp(
    `^${escapeRegExp(version)}-[a-f\\d]{16}$`,
    "iu",
  );
  let lastAcquiredKey = null;

  // Reuse the converter's strict absolute-path validation. The source is
  // validated on every acquisition because its extension controls the PDF
  // filename emitted by LibreOffice.
  const describe = (sourcePath, sourceStats) => {
    const key = getPresentationPreviewCacheKey({
      sourcePath,
      size: sourceStats.size,
      modifiedAt: sourceStats.modifiedAt,
      platform: normalizedPlatform,
      cacheVersion: version,
    });
    const outputDirectory = joinPath(safeRootDirectory, key, normalizedPlatform);
    const outputPath = getOfficePdfOutputPath(
      sourcePath,
      outputDirectory,
      normalizedPlatform,
    );
    return { key, outputDirectory, outputPath };
  };

  return Object.freeze({
    rootDirectory: safeRootDirectory,
    async acquire(sourcePath) {
      const sourceStats = await tryGetStats(getStats, sourcePath);
      if (!sourceStats?.isFile) {
        throw new Error("No se encontró la presentación para crear su vista previa.");
      }

      const target = describe(sourcePath, sourceStats);
      const outputStats = await tryGetStats(getStats, target.outputPath);
      const hit = Boolean(outputStats?.isFile && Number(outputStats.size) > 0);
      if (!hit) {
        await ensureDirectory(getStats, createDirectory, safeRootDirectory);
        await ensureDirectory(getStats, createDirectory, target.outputDirectory);
      }
      lastAcquiredKey = target.key;

      return Object.freeze({
        ...target,
        hit,
        size: hit ? Number(outputStats.size) : 0,
        sourceSize: Number(sourceStats.size),
        sourceModifiedAt: Number(sourceStats.modifiedAt),
      });
    },
    async prune(options = {}) {
      const maxEntries = normalizePruneLimit(
        options.maxEntries,
        DEFAULT_MAX_ENTRIES,
        "El límite de vistas previas",
        true,
      );
      const maxBytes = normalizePruneLimit(
        options.maxBytes,
        DEFAULT_MAX_BYTES,
        "El límite de bytes de la caché",
      );
      if (!readDirectory || !removeDirectory) {
        return Object.freeze({
          supported: false,
          removedKeys: Object.freeze([]),
          failedKeys: Object.freeze([]),
          remainingEntries: null,
          remainingBytes: null,
        });
      }

      const rootStats = await tryGetStats(getStats, safeRootDirectory);
      if (!rootStats?.isDirectory) {
        return Object.freeze({
          supported: true,
          removedKeys: Object.freeze([]),
          failedKeys: Object.freeze([]),
          remainingEntries: 0,
          remainingBytes: 0,
        });
      }

      const listed = await readDirectory(safeRootDirectory, { recursive: false });
      const candidates = [];
      for (const item of Array.isArray(listed) ? listed : []) {
        const key = String(item?.entry || "");
        if (!entryPattern.test(key)) continue;
        const directory = joinPath(safeRootDirectory, key, normalizedPlatform);
        const inspected = await inspectCacheDirectory({
          directory,
          key,
          getStats,
          readDirectory,
          platform: normalizedPlatform,
        });
        if (inspected) candidates.push(inspected);
      }

      const keepKeys = new Set(
        (Array.isArray(options.keepKeys) ? options.keepKeys : [])
          .map((key) => String(key))
          .filter((key) => entryPattern.test(key)),
      );
      if (lastAcquiredKey) keepKeys.add(lastAcquiredKey);
      candidates.sort((left, right) => (
        left.modifiedAt - right.modifiedAt || left.key.localeCompare(right.key)
      ));

      let remainingEntries = candidates.length;
      let remainingBytes = candidates.reduce((total, item) => total + item.bytes, 0);
      const removedKeys = [];
      const failedKeys = [];
      for (const candidate of candidates) {
        if (remainingEntries <= maxEntries && remainingBytes <= maxBytes) break;
        if (keepKeys.has(candidate.key)) continue;
        try {
          // `candidate.directory` is always an immediate child assembled from
          // the fixed root and a strict version-hash name, never caller input.
          await removeDirectory(candidate.directory);
          removedKeys.push(candidate.key);
          remainingEntries -= 1;
          remainingBytes -= candidate.bytes;
        } catch {
          failedKeys.push(candidate.key);
        }
      }

      return Object.freeze({
        supported: true,
        removedKeys: Object.freeze(removedKeys),
        failedKeys: Object.freeze(failedKeys),
        remainingEntries,
        remainingBytes,
      });
    },
  });
}
