import test from "node:test";
import assert from "node:assert/strict";

import { SearchTextCache } from "../src/search-text-cache.js";

test("caches normalized page text with a strict LRU memory ceiling", () => {
  const cache = new SearchTextCache(14);
  assert.equal(cache.set(0, "uno"), true); // 6 bytes
  assert.equal(cache.set(1, "dos"), true); // 6 bytes
  assert.equal(cache.get(0), "uno"); // page 0 becomes most recent
  assert.equal(cache.set(2, "tres"), true); // evicts page 1
  assert.equal(cache.get(1), null);
  assert.equal(cache.get(0), "uno");
  assert.equal(cache.get(2), "tres");
  assert.ok(cache.bytes <= cache.maxBytes);
});

test("does not retain a page larger than the whole search cache", () => {
  const cache = new SearchTextCache(4);
  assert.equal(cache.set(0, "texto muy largo"), false);
  assert.equal(cache.size, 0);
  cache.set(1, "ok");
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
  assert.throws(() => new SearchTextCache(0), RangeError);
});
