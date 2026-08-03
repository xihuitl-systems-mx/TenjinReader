import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateReferenceRenderSize,
  calculateSlideDisplaySize,
} from "../src/presentation-layout.js";

test("usa una resolución de referencia estable para no mover contenido PPTX", () => {
  assert.deepEqual(calculateReferenceRenderSize(16 / 9, 2), {
    logicalWidth: 1600,
    logicalHeight: 900,
    pixelRatio: 2,
  });
  assert.deepEqual(calculateReferenceRenderSize(3 / 4, 1.5), {
    logicalWidth: 1200,
    logicalHeight: 1600,
    pixelRatio: 1.5,
  });
  assert.throws(() => calculateReferenceRenderSize(0), /aspecto/u);
});

test("ajusta la diapositiva al host conservando su relación de aspecto", () => {
  const landscape = calculateSlideDisplaySize({
    hostWidth: 1000,
    hostHeight: 800,
    aspectRatio: 16 / 9,
  });
  assert.equal(landscape.width, 952);
  assert.equal(landscape.height, 535.5);

  const portrait = calculateSlideDisplaySize({
    hostWidth: 1000,
    hostHeight: 600,
    aspectRatio: 3 / 4,
    zoom: 2,
  });
  assert.equal(portrait.height, 1104);
  assert.equal(portrait.width, 828);
  assert.throws(
    () => calculateSlideDisplaySize({ hostWidth: 10, hostHeight: 10, aspectRatio: NaN }),
    /aspecto/u,
  );
});
