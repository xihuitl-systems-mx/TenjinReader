/**
 * Stages bytes beside the destination and swaps them in while retaining the
 * previous file as a recoverable backup until the replacement succeeds.
 */
export async function replaceFileTransaction({
  destination,
  byteLength,
  overwrite = false,
  getStats,
  temporaryPath,
  writeStagedFile,
  moveFile,
  removeFile,
}) {
  const existing = await getStats(destination);
  if (existing && !existing.isFile) {
    throw new Error("La ruta de destino está ocupada por una carpeta.");
  }
  if (existing?.isFile && !overwrite) {
    const error = new Error("Ya existe un archivo con ese nombre.");
    error.code = "FILE_EXISTS";
    throw error;
  }

  const stagedPath = await temporaryPath(destination);
  let backupPath = null;
  try {
    await writeStagedFile(stagedPath);
    const stagedStats = await getStats(stagedPath);
    if (!stagedStats?.isFile || Number(stagedStats.size) !== Number(byteLength)) {
      throw new Error("No se pudo verificar la escritura temporal completa.");
    }

    if (existing?.isFile) {
      backupPath = await temporaryPath(destination);
      await moveFile(destination, backupPath);
    }

    try {
      await moveFile(stagedPath, destination);
    } catch (error) {
      if (backupPath) {
        try {
          await moveFile(backupPath, destination);
          backupPath = null;
        } catch {
          // The backup remains on disk and retains the complete original.
        }
      }
      throw error;
    }

    if (backupPath) {
      try {
        await removeFile(backupPath);
      } catch {
        // Replacement succeeded; retaining a backup is safer than failing it.
      }
    }
    return destination;
  } catch (error) {
    try {
      if (await getStats(stagedPath)) await removeFile(stagedPath);
    } catch {
      // A complete staged file is recoverable and must not mask the root error.
    }
    throw error;
  }
}
