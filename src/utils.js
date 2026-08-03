const DOCUMENT_TYPES = Object.freeze({
  pdf: "pdf",
  ppt: "pptx",
  pptx: "pptx",
  odp: "pptx",
  odf: "pptx",
});

const SIZE_UNITS = Object.freeze(["B", "KB", "MB", "GB", "TB", "PB"]);
const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Returns the supported document type for a local path or file name.
 * Presentation formats share one read-only viewer type. PPTX can use the
 * lightweight canvas fallback; legacy/OpenDocument formats use the native
 * high-fidelity conversion path.
 */
export function getDocumentType(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match = /\.([^.\\/]+)$/u.exec(value);
  if (!match) {
    return null;
  }

  return DOCUMENT_TYPES[match[1].toLowerCase()] ?? null;
}

export function isSupportedDocument(value) {
  return getDocumentType(value) !== null;
}

export function baseName(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }

  const withoutTrailingSeparators = value.replace(/[\\/]+$/u, "");
  if (withoutTrailingSeparators.length === 0) {
    return "";
  }

  const separatorIndex = Math.max(
    withoutTrailingSeparators.lastIndexOf("/"),
    withoutTrailingSeparators.lastIndexOf("\\"),
  );

  return withoutTrailingSeparators.slice(separatorIndex + 1);
}

export function formatFileSize(bytes, fractionDigits = 1) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }

  if (bytes === 0) {
    return "0 B";
  }

  const safeDigits = clamp(Math.trunc(fractionDigits), 0, 3);
  const unitIndex = Math.min(
    Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))),
    SIZE_UNITS.length - 1,
  );
  const amount = bytes / 1024 ** unitIndex;
  const formatted = Number(amount.toFixed(unitIndex === 0 ? 0 : safeDigits));

  return `${formatted} ${SIZE_UNITS[unitIndex]}`;
}

export function clamp(value, minimum, maximum) {
  const lower = Math.min(minimum, maximum);
  const upper = Math.max(minimum, maximum);
  return Math.min(upper, Math.max(lower, value));
}

/**
 * Converts WheelEvent deltas to CSS pixels so mouse wheels and trackpads can
 * share one navigation threshold.
 */
export function wheelDeltaToPixels(
  delta,
  deltaMode = 0,
  viewportHeight = 0,
) {
  const numericDelta = Number(delta);
  if (!Number.isFinite(numericDelta)) {
    return 0;
  }

  if (deltaMode === 1) {
    return numericDelta * 16;
  }
  if (deltaMode === 2) {
    return numericDelta * Math.max(1, Number(viewportHeight) || 0);
  }
  return numericDelta;
}

/**
 * Reports whether a scrollport still has room in the requested direction.
 */
export function canScrollVertically(
  scrollport,
  direction,
  tolerance = 1,
) {
  const scrollTop = Math.max(
    0,
    Number(scrollport?.scrollTop) || 0,
  );
  const scrollHeight = Math.max(
    0,
    Number(scrollport?.scrollHeight) || 0,
  );
  const clientHeight = Math.max(
    0,
    Number(scrollport?.clientHeight) || 0,
  );
  const maximum = Math.max(0, scrollHeight - clientHeight);
  const edgeTolerance = Math.max(
    0,
    Number(tolerance) || 0,
  );

  if (direction < 0) {
    return scrollTop > edgeTolerance;
  }
  if (direction > 0) {
    return scrollTop < maximum - edgeTolerance;
  }
  return false;
}

/**
 * Converts #RGB or #RRGGBB into the 0..1 channels expected by pdf-lib.
 */
export function hexToNormalizedRgb(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match = /^#?([\da-f]{3}|[\da-f]{6})$/iu.exec(value);
  if (!match) {
    return null;
  }

  const hex = match[1].length === 3
    ? [...match[1]].map((character) => character.repeat(2)).join("")
    : match[1];

  return {
    r: Number.parseInt(hex.slice(0, 2), 16) / 255,
    g: Number.parseInt(hex.slice(2, 4), 16) / 255,
    b: Number.parseInt(hex.slice(4, 6), 16) / 255,
  };
}

/**
 * Returns an ArrayBuffer that contains exactly the bytes represented by input.
 * This avoids leaking unrelated bytes from a pooled Buffer or sliced typed view.
 */
export function toExactArrayBuffer(input) {
  if (input instanceof ArrayBuffer) {
    return input;
  }

  if (!ArrayBuffer.isView(input)) {
    throw new TypeError("Expected an ArrayBuffer or an ArrayBuffer view.");
  }

  const exactBytes = new Uint8Array(input.byteLength);
  exactBytes.set(
    new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
  );
  return exactBytes.buffer;
}

/**
 * Returns a normalized external URL, or null when opening it would be unsafe.
 */
export function normalizeExternalUrl(value) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    return null;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (!SAFE_EXTERNAL_PROTOCOLS.has(url.protocol)) {
    return null;
  }

  if (url.protocol === "mailto:") {
    return (
      url.pathname.length > 0
      && !/%0[ad]/iu.test(url.href)
    ) ? url.href : null;
  }

  if (!url.hostname || url.username || url.password) {
    return null;
  }

  return url.href;
}

export function isSafeExternalUrl(value) {
  return normalizeExternalUrl(value) !== null;
}

/**
 * Maps an array with a fixed number of workers while retaining input order.
 * Keeping this primitive small and deterministic lets expensive PDF page work
 * overlap without scheduling the entire document at once.
 */
export async function mapWithConcurrency(items, mapper, concurrency = 2) {
  if (!Array.isArray(items)) {
    throw new TypeError("Los elementos concurrentes deben proporcionarse como arreglo.");
  }
  if (typeof mapper !== "function") {
    throw new TypeError("El procesador concurrente debe ser una función.");
  }
  const requestedConcurrency = Number(concurrency);
  if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1) {
    throw new RangeError("La concurrencia debe ser un entero mayor que cero.");
  }
  if (items.length === 0) return [];

  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  const workerCount = Math.min(requestedConcurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// Small aliases keep call sites readable without duplicating behavior.
export const basename = baseName;
export const formatBytes = formatFileSize;
export const hexToRgb = hexToNormalizedRgb;
export const exactArrayBuffer = toExactArrayBuffer;
