const HEX_COLOR_PATTERN = /^#[\da-f]{6}$/i;

/**
 * Keeps the visible color swatch in sync with the hidden native color input.
 * The swatch is rendered by .color-picker::after, so its color is exposed as
 * a CSS custom property on the label instead of being painted by JavaScript.
 */
export function syncAnnotationColorIndicator(colorControl, color = colorControl?.value) {
  const normalizedColor = String(color || "").trim().toLowerCase();
  if (!HEX_COLOR_PATTERN.test(normalizedColor)) return false;

  const indicator = colorControl?.closest?.(".color-picker") || colorControl?.parentElement;
  if (typeof indicator?.style?.setProperty !== "function") return false;

  indicator.style.setProperty("--annotation-color", normalizedColor);
  return true;
}
