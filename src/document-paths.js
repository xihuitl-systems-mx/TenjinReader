/** Returns a sibling path without guessing the host separator. */
export function siblingDocumentPath(sourcePath, fileName) {
  const source = String(sourcePath || "");
  const name = String(fileName || "");
  if (!source || !name || /[\\/]/u.test(name)) {
    throw new TypeError("No se pudo calcular la nueva ruta del documento.");
  }

  const separatorIndex = Math.max(source.lastIndexOf("/"), source.lastIndexOf("\\"));
  if (separatorIndex < 0) {
    throw new TypeError("El documento no tiene una carpeta de origen valida.");
  }
  return `${source.slice(0, separatorIndex + 1)}${name}`;
}

/** Compares document paths using the case rules of the active platform. */
export function sameDocumentPath(left, right, platform = "") {
  const normalize = (value) => String(value || "")
    .replace(/\\/gu, "/")
    .replace(/\/+$/gu, "");
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return String(platform).toLocaleLowerCase().includes("win")
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}
