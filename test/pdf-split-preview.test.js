import test from "node:test";
import assert from "node:assert/strict";

import { describeSplitGroups } from "../src/pdf-split-preview.js";

test("describeSplitGroups summarizes one extracted PDF and excluded pages", () => {
  const result = describeSplitGroups([[0, 2, 3]], 5);
  assert.equal(result.fileCount, 1);
  assert.equal(result.selectedPageCount, 3);
  assert.equal(result.summary, "1 archivo · 3 páginas");
  assert.deepEqual(result.membership.get(0), [0]);
  assert.equal(result.membership.has(1), false);
  assert.deepEqual(result.outputOrder, [0, 2, 3]);
});

test("describeSplitGroups maps every one-page output to its file", () => {
  const result = describeSplitGroups([[0], [1], [2]], 3);
  assert.equal(result.fileCount, 3);
  assert.equal(result.summary, "3 archivos · 3 páginas en total");
  assert.deepEqual(result.membership.get(2), [2]);
  assert.deepEqual(result.outputOrder, [0, 1, 2]);
});

test("describeSplitGroups rejects empty and out-of-range plans", () => {
  assert.throws(() => describeSplitGroups([], 3), /al menos un archivo/i);
  assert.throws(() => describeSplitGroups([[3]], 3), /fuera del documento/i);
  assert.throws(() => describeSplitGroups([[]], 3), /no contiene páginas/i);
});
