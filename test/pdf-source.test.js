import test from "node:test";
import assert from "node:assert/strict";

import {
  createMemoryPdfByteSource,
  createPdfByteSource,
} from "../src/pdf-source.js";

test("reads exact PDF ranges and clamps the final range", async () => {
  const source = createMemoryPdfByteSource(new Uint8Array([1, 2, 3, 4, 5]));
  assert.deepEqual([...new Uint8Array(await source.readRange(1, 4))], [2, 3, 4]);
  assert.deepEqual([...new Uint8Array(await source.readRange(3, 20))], [4, 5]);
});

test("deduplicates simultaneous identical range reads", async () => {
  let reads = 0;
  const source = createPdfByteSource({
    length: 4,
    readRange: async (begin, end) => {
      reads += 1;
      await Promise.resolve();
      return new Uint8Array(end - begin).fill(7).buffer;
    },
  });
  await Promise.all([source.readRange(0, 4), source.readRange(0, 4)]);
  assert.equal(reads, 1);
});

test("materializes a PDF only when readAll is requested", async () => {
  const ranges = [];
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const source = createPdfByteSource({
    length: bytes.length,
    readRange(begin, end) {
      ranges.push([begin, end]);
      return bytes.slice(begin, end).buffer;
    },
  });

  assert.deepEqual(ranges, []);
  assert.deepEqual(
    [...new Uint8Array(await source.readAll({ chunkSize: 2 }))],
    [...bytes],
  );
  // The implementation enforces a practical minimum chunk size.
  assert.deepEqual(ranges, [[0, 6]]);
});

test("rejects invalid ranges and further reads after abort", async () => {
  const source = createMemoryPdfByteSource(new Uint8Array([1, 2, 3]));
  await assert.rejects(source.readRange(-1, 2), RangeError);
  await assert.rejects(source.readRange(2, 2), RangeError);
  source.abort();
  await assert.rejects(source.readRange(0, 1), { name: "AbortError" });
});
