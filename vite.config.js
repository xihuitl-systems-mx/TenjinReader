import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const projectPath = fileURLToPath(new URL(".", import.meta.url));

export const PDFJS_RUNTIME_ASSET_DIRECTORIES = ["cmaps", "standard_fonts", "wasm"];

function copyPdfJsAssets() {
  const assetDirectories = PDFJS_RUNTIME_ASSET_DIRECTORIES;

  return {
    name: "copy-pdfjs-runtime-assets",
    apply: "build",
    async writeBundle() {
      await Promise.all(
        assetDirectories.map((directory) => cp(
          `${projectPath}node_modules/pdfjs-dist/${directory}`,
          `${projectPath}dist-web/${directory}`,
          { recursive: true, force: true },
        )),
      );
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [copyPdfJsAssets()],
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2020",
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
