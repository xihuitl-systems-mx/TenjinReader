import test from "node:test";
import assert from "node:assert/strict";

import { createOfficeConverter } from "../src/office-converter.js";
import {
  createPresentationPreviewCache,
  getPresentationPreviewCacheKey,
} from "../src/presentation-preview-cache.js";

test("la clave de caché es estable e invalida cambios del archivo", () => {
  const common = {
    size: 1200,
    modifiedAt: 5000,
    platform: "windows",
  };
  const original = getPresentationPreviewCacheKey({
    ...common,
    sourcePath: "C:\\Docs\\Deck.PPTX",
  });
  const equivalent = getPresentationPreviewCacheKey({
    ...common,
    sourcePath: "c:/docs/deck.pptx",
  });
  const modified = getPresentationPreviewCacheKey({
    ...common,
    sourcePath: "C:\\Docs\\Deck.PPTX",
    modifiedAt: 5001,
  });
  const resized = getPresentationPreviewCacheKey({
    ...common,
    sourcePath: "C:\\Docs\\Deck.PPTX",
    size: 1201,
  });

  assert.equal(original, equivalent);
  assert.notEqual(original, modified);
  assert.notEqual(original, resized);
  assert.match(original, /^v1-[a-f\d]{16}$/u);
});

test("crea una caché persistente y reutiliza un PDF no vacío", async () => {
  const rootDirectory = "/cache/folentra-presentations";
  const sourcePath = "/docs/deck.pptx";
  const entries = new Map([
    [sourcePath, {
      isFile: true,
      isDirectory: false,
      size: 1200,
      modifiedAt: 5000,
    }],
  ]);
  const created = [];
  const getStats = async (path) => {
    const stats = entries.get(path);
    if (!stats) throw new Error("No existe");
    return stats;
  };
  const cache = createPresentationPreviewCache({
    rootDirectory,
    platform: "linux",
    getStats,
    createDirectory: async (path) => {
      created.push(path);
      entries.set(path, { isDirectory: true, isFile: false, size: 0 });
    },
  });

  const miss = await cache.acquire(sourcePath);
  assert.equal(miss.hit, false);
  assert.equal(miss.outputDirectory, `${rootDirectory}/${miss.key}`);
  assert.equal(miss.outputPath, `${miss.outputDirectory}/deck.pdf`);
  assert.deepEqual(created, [rootDirectory, miss.outputDirectory]);

  entries.set(miss.outputPath, {
    isFile: true,
    isDirectory: false,
    size: 3210,
    modifiedAt: 6000,
  });
  const hit = await cache.acquire(sourcePath);
  assert.equal(hit.hit, true);
  assert.equal(hit.outputPath, miss.outputPath);
  assert.equal(hit.size, 3210);
  assert.deepEqual(created, [rootDirectory, miss.outputDirectory]);

  entries.set(sourcePath, {
    isFile: true,
    isDirectory: false,
    size: 1200,
    modifiedAt: 5001,
  });
  const invalidated = await cache.acquire(sourcePath);
  assert.equal(invalidated.hit, false);
  assert.notEqual(invalidated.key, miss.key);
  assert.notEqual(invalidated.outputPath, miss.outputPath);
});

test("poda solo hijos propios y respeta límites de cantidad y tamaño", async () => {
  const rootDirectory = "/cache/folentra-presentations";
  const keys = [
    "v1-0000000000000001",
    "v1-0000000000000002",
    "v1-0000000000000003",
  ];
  const entries = new Map([
    [rootDirectory, { isDirectory: true, modifiedAt: 0 }],
  ]);
  keys.forEach((key, index) => {
    const directory = `${rootDirectory}/${key}`;
    entries.set(directory, { isDirectory: true, modifiedAt: index + 1 });
    entries.set(`${directory}/deck.pdf`, {
      isFile: true,
      size: (index + 1) * 100,
      modifiedAt: index + 1,
    });
  });
  const removed = [];
  const cache = createPresentationPreviewCache({
    rootDirectory,
    platform: "linux",
    getStats: async (path) => {
      const stats = entries.get(path);
      if (!stats) throw new Error("No existe");
      return stats;
    },
    createDirectory: async () => {},
    readDirectory: async (path) => {
      if (path === rootDirectory) {
        return [
          ...keys.map((entry) => ({ entry, type: "DIRECTORY" })),
          { entry: "no-borrar", type: "DIRECTORY" },
          { entry: "v2-0000000000000001", type: "DIRECTORY" },
        ];
      }
      if (keys.some((key) => path === `${rootDirectory}/${key}`)) {
        return [{ entry: "deck.pdf", type: "FILE" }];
      }
      return [];
    },
    removeDirectory: async (path) => {
      removed.push(path);
    },
  });

  const result = await cache.prune({ maxEntries: 2, maxBytes: 350 });
  assert.deepEqual(result.removedKeys, keys.slice(0, 2));
  assert.deepEqual(removed, keys.slice(0, 2).map((key) => `${rootDirectory}/${key}`));
  assert.equal(result.remainingEntries, 1);
  assert.equal(result.remainingBytes, 300);
  assert.equal(removed.some((path) => path.includes("no-borrar")), false);
});

test("la poda es opcional y rechaza una raíz demasiado amplia", async () => {
  assert.throws(
    () => createPresentationPreviewCache({
      rootDirectory: "/",
      platform: "linux",
      getStats: async () => null,
      createDirectory: async () => {},
    }),
    /carpeta absoluta específica/u,
  );

  const cache = createPresentationPreviewCache({
    rootDirectory: "/cache/folentra-presentations",
    platform: "linux",
    getStats: async () => null,
    createDirectory: async () => {},
  });
  const result = await cache.prune();
  assert.equal(result.supported, false);
  assert.deepEqual(result.removedKeys, []);
});

test("una vista en caché evita por completo iniciar LibreOffice", async () => {
  let executions = 0;
  const converter = createOfficeConverter({
    platform: "linux",
    getStats: async () => {
      throw new Error("No debería consultar el conversor");
    },
    execCommand: async () => {
      executions += 1;
      return { exitCode: 0 };
    },
    previewCache: {
      acquire: async () => ({
        key: "v1-cached",
        outputDirectory: "/cache/v1-cached",
        outputPath: "/cache/v1-cached/deck.pdf",
        hit: true,
        size: 800,
      }),
    },
  });

  const route = await converter.preparePresentationForViewing(
    "/docs/deck.pptx",
    "/tmp/open",
  );
  assert.equal(route.mode, "pdf");
  assert.equal(route.path, "/cache/v1-cached/deck.pdf");
  assert.equal(route.cacheHit, true);
  assert.equal(route.temporaryProfilePath, null);
  assert.equal(executions, 0);
});

test("una falta de caché convierte allí y mantiene aislado el perfil", async () => {
  const sourcePath = "/docs/deck.pptx";
  const temporaryDirectory = "/tmp/open";
  const cacheDirectory = "/cache/v1-new";
  const outputPath = `${cacheDirectory}/deck.pdf`;
  const executable = "/usr/bin/libreoffice";
  let generated = false;
  const commands = [];
  const converter = createOfficeConverter({
    platform: "linux",
    libreOfficePath: executable,
    previewCache: {
      acquire: async () => ({
        key: "v1-new",
        outputDirectory: cacheDirectory,
        outputPath,
        hit: false,
        size: 0,
      }),
    },
    getStats: async (path) => {
      if (path === sourcePath) return { isFile: true, size: 100, modifiedAt: 1 };
      if (path === temporaryDirectory || path === cacheDirectory) {
        return { isDirectory: true };
      }
      if (path === executable) return { isFile: true };
      if (path === outputPath && generated) {
        return { isFile: true, size: 900, modifiedAt: 2 };
      }
      throw new Error("No existe");
    },
    execCommand: async (command) => {
      commands.push(command);
      if (command.includes("'--convert-to'")) generated = true;
      return { exitCode: 0 };
    },
  });

  const route = await converter.preparePresentationForViewing(
    sourcePath,
    temporaryDirectory,
  );
  assert.equal(route.path, outputPath);
  assert.equal(route.cacheHit, false);
  assert.equal(route.cacheKey, "v1-new");
  assert.match(route.temporaryProfilePath, /^\/tmp\/open\/\.pluma-reader-lo-/u);
  assert.equal(commands.length, 2);
  assert.match(commands[1], /'--outdir' '\/cache\/v1-new'/u);
  assert.match(commands[1], /-env:UserInstallation=file:\/\/\/tmp\/open\//u);
});

test("distintos converters comparten una detección concurrente", async () => {
  const executable = "/usr/bin/libreoffice";
  let versionChecks = 0;
  const getStats = async (path) => {
    if (path === executable) return { isFile: true };
    throw new Error("No existe");
  };
  const execCommand = async () => {
    versionChecks += 1;
    await Promise.resolve();
    return { exitCode: 0 };
  };
  const dependencies = {
    platform: "linux",
    libreOfficePath: executable,
    getStats,
    execCommand,
  };
  const first = createOfficeConverter(dependencies);
  const second = createOfficeConverter(dependencies);

  const [one, two] = await Promise.all([
    first.warmUp(),
    second.detectLibreOffice(),
  ]);
  assert.equal(one, executable);
  assert.equal(two, executable);
  assert.equal(versionChecks, 1);
});
