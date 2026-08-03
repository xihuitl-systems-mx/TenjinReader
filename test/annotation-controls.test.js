import test from "node:test";
import assert from "node:assert/strict";

import { syncAnnotationColorIndicator } from "../src/annotation-controls.js";

function createColorControl(value = "#efb933") {
  const properties = new Map();
  const indicator = {
    style: {
      setProperty(name, propertyValue) {
        properties.set(name, propertyValue);
      },
    },
  };

  return {
    control: {
      value,
      closest(selector) {
        assert.equal(selector, ".color-picker");
        return indicator;
      },
    },
    properties,
  };
}

test("el indicador refleja el color seleccionado", () => {
  const { control, properties } = createColorControl("#3A7BD5");

  assert.equal(syncAnnotationColorIndicator(control), true);
  assert.equal(properties.get("--annotation-color"), "#3a7bd5");

  control.value = "#d9485f";
  assert.equal(syncAnnotationColorIndicator(control), true);
  assert.equal(properties.get("--annotation-color"), "#d9485f");
});

test("el indicador ignora colores invalidos sin alterar su estado", () => {
  const { control, properties } = createColorControl("amarillo");

  assert.equal(syncAnnotationColorIndicator(control), false);
  assert.equal(properties.size, 0);
});
