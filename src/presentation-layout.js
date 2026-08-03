const REFERENCE_LONG_EDGE = 1600;
const MAX_BACKING_DIMENSION = 4096;

export function calculateReferenceRenderSize(
  aspectRatio,
  devicePixelRatio = 1,
) {
  const aspect = Number(aspectRatio);
  if (!Number.isFinite(aspect) || aspect <= 0) {
    throw new RangeError("La relación de aspecto de la diapositiva no es válida.");
  }
  const logicalWidth = aspect >= 1
    ? REFERENCE_LONG_EDGE
    : Math.max(1, Math.round(REFERENCE_LONG_EDGE * aspect));
  const logicalHeight = aspect >= 1
    ? Math.max(1, Math.round(REFERENCE_LONG_EDGE / aspect))
    : REFERENCE_LONG_EDGE;
  const requestedRatio = Math.max(1, Math.min(2, Number(devicePixelRatio) || 1));
  const pixelRatio = Math.min(
    requestedRatio,
    MAX_BACKING_DIMENSION / Math.max(logicalWidth, logicalHeight),
  );
  return Object.freeze({ logicalWidth, logicalHeight, pixelRatio });
}

export function calculateSlideDisplaySize({
  hostWidth,
  hostHeight,
  aspectRatio,
  zoom = 1,
  padding = 48,
}) {
  const aspect = Number(aspectRatio);
  if (!Number.isFinite(aspect) || aspect <= 0) {
    throw new RangeError("La relación de aspecto de la diapositiva no es válida.");
  }
  const numericPadding = Number.isFinite(Number(padding)) ? Number(padding) : 48;
  const numericHostWidth = Number.isFinite(Number(hostWidth)) ? Number(hostWidth) : 1;
  const numericHostHeight = Number.isFinite(Number(hostHeight)) ? Number(hostHeight) : 1;
  const availableWidth = Math.max(1, numericHostWidth - numericPadding);
  const availableHeight = Math.max(1, numericHostHeight - numericPadding);
  let width = availableWidth;
  let height = width / aspect;
  if (height > availableHeight) {
    height = availableHeight;
    width = height * aspect;
  }
  const safeZoom = Math.max(0.35, Math.min(3, Number(zoom) || 1));
  return Object.freeze({
    width: Math.max(1, width * safeZoom),
    height: Math.max(1, height * safeZoom),
  });
}
