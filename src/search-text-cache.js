const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function textBytes(value) {
  // JavaScript strings are commonly stored as one or two bytes per code unit.
  // Using the conservative UTF-16 size keeps the configured ceiling honest.
  return value.length * 2;
}

/** A byte-bounded LRU for normalized PDF page text. */
export class SearchTextCache {
  constructor(maxBytes = DEFAULT_MAX_BYTES) {
    const limit = Number(maxBytes);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("El límite de la caché de búsqueda no es válido.");
    }
    this.maxBytes = limit;
    this.entries = new Map();
    this.bytes = 0;
  }

  get(pageIndex) {
    if (!this.entries.has(pageIndex)) return null;
    const entry = this.entries.get(pageIndex);
    this.entries.delete(pageIndex);
    this.entries.set(pageIndex, entry);
    return entry.text;
  }

  set(pageIndex, text) {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
      throw new RangeError("El índice de página de la caché no es válido.");
    }
    const normalizedText = String(text);
    const bytes = textBytes(normalizedText);
    const previous = this.entries.get(pageIndex);
    if (previous) {
      this.bytes -= previous.bytes;
      this.entries.delete(pageIndex);
    }
    if (bytes > this.maxBytes) return false;

    this.entries.set(pageIndex, { text: normalizedText, bytes });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next().value;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.bytes -= oldest.bytes;
    }
    return true;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  get size() {
    return this.entries.size;
  }
}

export const DEFAULT_SEARCH_TEXT_CACHE_BYTES = DEFAULT_MAX_BYTES;
