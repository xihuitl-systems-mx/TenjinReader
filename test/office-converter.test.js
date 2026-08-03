import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLibreOfficeConvertCommand,
  convertOfficeToPdf,
  createOfficeConverter,
  detectLibreOffice,
  getLibreOfficeCandidates,
  getOfficeDocumentType,
  getOfficePdfFilter,
  getOfficePdfOutputPath,
  getIsolatedOfficeProfilePath,
  getPresentationDocumentInfo,
  normalizeOfficePlatform,
  officePathToFileUrl,
  preparePresentationForViewing,
  PresentationConversionRequiredError,
  quoteCommandArgument,
} from "../src/office-converter.js";

test("normaliza las plataformas compatibles", () => {
  assert.equal(normalizeOfficePlatform("win32"), "windows");
  assert.equal(normalizeOfficePlatform("WINDOWS"), "windows");
  assert.equal(normalizeOfficePlatform("linux"), "linux");
  assert.equal(normalizeOfficePlatform("darwin"), "macos");
  assert.throws(() => normalizeOfficePlatform("android"), /plataforma/u);
});

test("reconoce documentos de Word, PowerPoint y Excel", () => {
  assert.equal(getOfficeDocumentType("C:\\Docs\\Informe.DOCX"), "word");
  assert.equal(getOfficeDocumentType("/tmp/deck.pptx"), "powerpoint");
  assert.equal(getOfficeDocumentType("/tmp/deck.odp"), "powerpoint");
  assert.equal(getOfficeDocumentType("/tmp/formula.odf"), "formula");
  assert.equal(getOfficeDocumentType("/tmp/datos.xlsx"), "excel");
  assert.equal(getOfficeDocumentType("/tmp/legacy.xls"), "excel");
  assert.equal(getOfficeDocumentType("/tmp/falso.docx.exe"), null);
  assert.equal(getOfficeDocumentType("/tmp/documento.pdf"), null);
  assert.equal(getOfficeDocumentType("/tmp/foto.jpg"), null);
});

test("calcula el nombre PDF esperado en cada plataforma", () => {
  assert.equal(
    getOfficePdfOutputPath("C:\\Docs\\Informe final.docx", "D:\\Salida", "win32"),
    "D:\\Salida\\Informe final.pdf",
  );
  assert.equal(
    getOfficePdfOutputPath("/home/ana/ventas.2026.xlsx", "/tmp/salida/", "linux"),
    "/tmp/salida/ventas.2026.pdf",
  );
  assert.throws(
    () => getOfficePdfOutputPath("relativo.docx", "/tmp", "linux"),
    /ruta absoluta/u,
  );
});

test("cita argumentos y escapa apóstrofos POSIX sin permitir controles", () => {
  assert.equal(
    quoteCommandArgument("C:\\My Docs\\file.docx", "windows"),
    '"C:\\My Docs\\file.docx"',
  );
  assert.equal(
    quoteCommandArgument("/tmp/ventas; sin ejecutar nada.xlsx", "linux"),
    "'/tmp/ventas; sin ejecutar nada.xlsx'",
  );
  assert.equal(
    quoteCommandArgument("/tmp/archivo'válido.docx", "linux"),
    "'/tmp/archivo'\\''válido.docx'",
  );
  assert.equal(
    quoteCommandArgument("C:\\Docs\\presentación`final.pptx", "windows"),
    '"C:\\Docs\\presentación`final.pptx"',
  );
  assert.throws(
    () => quoteCommandArgument("C:\\Docs\\%TEMP%\\file.docx", "windows"),
    /insegura/u,
  );
  assert.throws(
    () => quoteCommandArgument("/tmp/file.docx\nmal", "linux"),
    /saltos de línea/u,
  );
  assert.throws(
    () => quoteCommandArgument("/tmp/file.docx\0mal", "linux"),
    /no permitidos/u,
  );
});

test("duplica barras finales antes de cerrar comillas en Windows", () => {
  assert.equal(
    quoteCommandArgument("C:\\Salida\\", "windows"),
    '"C:\\Salida\\\\"',
  );
});

test("crea perfiles aislados de LibreOffice con URL local segura", () => {
  assert.equal(
    officePathToFileUrl("C:\\Temp\\Perfil con espacio", "windows"),
    "file:///C:/Temp/Perfil%20con%20espacio",
  );
  assert.equal(
    officePathToFileUrl("/tmp/Perfil con espacio", "linux"),
    "file:///tmp/Perfil%20con%20espacio",
  );
  assert.match(
    getIsolatedOfficeProfilePath("/tmp/salida", "linux"),
    /^\/tmp\/salida\/\.pluma-reader-lo-[a-z\d]+$/u,
  );
});

test("construye el comando headless requerido", () => {
  const command = buildLibreOfficeConvertCommand({
    executable: "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    sourcePath: "/Users/ana/Informe final.docx",
    outputDirectory: "/Users/ana/Salida",
    platform: "darwin",
  });
  assert.equal(
    command,
    "'/Applications/LibreOffice.app/Contents/MacOS/soffice' "
      + "'--headless' '--nologo' '--nodefault' '--nofirststartwizard' "
      + "'--norestore' '--convert-to' 'pdf:writer_pdf_Export' '--outdir' "
      + "'/Users/ana/Salida' '/Users/ana/Informe final.docx'",
  );
});

test("inyecta un perfil aislado sin aceptar expansión de rutas Windows", () => {
  const command = buildLibreOfficeConvertCommand({
    executable: "C:\\Program Files\\LibreOffice\\program\\soffice.com",
    sourcePath: "C:\\Docs\\Deck.pptx",
    outputDirectory: "C:\\Salida",
    userProfileDirectory: "C:\\Temp\\Perfil con espacio",
    platform: "windows",
  });
  assert.match(
    command,
    /"-env:UserInstallation=file:\/\/\/C:\/Temp\/Perfil%20con%20espacio"/u,
  );
  assert.match(command, /"pdf:impress_pdf_Export"/u);
  assert.throws(
    () => buildLibreOfficeConvertCommand({
      executable: "soffice.com",
      sourcePath: "C:\\Docs\\Deck.pptx",
      outputDirectory: "C:\\Salida",
      userProfileDirectory: "C:\\Temp\\%TEMP%",
      platform: "windows",
    }),
    /insegura/u,
  );
});

test("selecciona filtros PDF específicos y rutas de visor fieles", () => {
  assert.equal(getOfficePdfFilter("/docs/deck.ppt"), "impress_pdf_Export");
  assert.equal(getOfficePdfFilter("/docs/deck.odp"), "impress_pdf_Export");
  assert.equal(getOfficePdfFilter("/docs/formula.odf"), "math_pdf_Export");

  assert.deepEqual(getPresentationDocumentInfo("/docs/deck.pptx"), {
    extension: "pptx",
    documentType: "powerpoint",
    pdfFilter: "impress_pdf_Export",
    canvasFallback: true,
  });
  assert.deepEqual(getPresentationDocumentInfo("/docs/deck.odp"), {
    extension: "odp",
    documentType: "powerpoint",
    pdfFilter: "impress_pdf_Export",
    canvasFallback: false,
  });
  assert.deepEqual(getPresentationDocumentInfo("/docs/formula.odf"), {
    extension: "odf",
    documentType: "formula",
    pdfFilter: "math_pdf_Export",
    canvasFallback: false,
  });
  assert.equal(getPresentationDocumentInfo("/docs/documento.pdf"), null);
});

test("enumera ubicaciones comunes de LibreOffice", () => {
  assert.ok(
    getLibreOfficeCandidates("windows")
      .includes("C:\\Program Files\\LibreOffice\\program\\soffice.com"),
  );
  assert.ok(getLibreOfficeCandidates("linux").includes("/usr/bin/libreoffice"));
  assert.ok(
    getLibreOfficeCandidates("macos")
      .includes("/Applications/LibreOffice.app/Contents/MacOS/soffice"),
  );
});

test("detecta una instalación de Windows y verifica que sea ejecutable", async () => {
  const expected = "C:\\Program Files\\LibreOffice\\program\\soffice.com";
  const commands = [];
  const result = await detectLibreOffice({
    platform: "win32",
    getStats: async (path) => {
      if (path === expected) return { isFile: true };
      throw new Error("No existe");
    },
    execCommand: async (command) => {
      commands.push(command);
      return { exitCode: 0, stdOut: "LibreOffice", stdErr: "" };
    },
  });

  assert.equal(result, expected);
  assert.equal(commands.length, 1);
  assert.match(commands[0], /--version/u);
});

test("usa el comando disponible en PATH cuando no hay rutas conocidas", async () => {
  const result = await detectLibreOffice({
    platform: "linux",
    getStats: async () => {
      throw new Error("No existe");
    },
    execCommand: async (command) => ({
      exitCode: command.startsWith("'libreoffice'") ? 0 : 1,
      stdOut: "",
      stdErr: "",
    }),
  });
  assert.equal(result, "libreoffice");
});

test("acepta una ruta configurada con apóstrofo POSIX de forma escapada", async () => {
  let executions = 0;
  const executable = await detectLibreOffice({
    platform: "linux",
    libreOfficePath: "/opt/Libre'Office/soffice",
    getStats: async () => ({ isFile: true }),
    execCommand: async (command) => {
      executions += 1;
      assert.match(command, /^'\/opt\/Libre'\\''Office\/soffice'/u);
      return { exitCode: 0 };
    },
  });
  assert.equal(executable, "/opt/Libre'Office/soffice");
  assert.equal(executions, 1);
});

test("convierte un DOCX y verifica el PDF generado", async () => {
  const sourcePath = "/docs/informe final.docx";
  const outputDirectory = "/salida";
  const outputPath = "/salida/informe final.pdf";
  const executable = "/usr/bin/libreoffice";
  const commands = [];
  let generated = false;

  const result = await convertOfficeToPdf({
    sourcePath,
    outputDirectory,
    platform: "linux",
    libreOfficePath: executable,
    getStats: async (path) => {
      if (path === sourcePath) return { isFile: true, size: 100 };
      if (path === outputDirectory) return { isDirectory: true };
      if (path === executable) return { isFile: true };
      if (path === outputPath && generated) {
        return { isFile: true, size: 321, modifiedAt: 20 };
      }
      throw new Error("No existe");
    },
    execCommand: async (command) => {
      commands.push(command);
      if (command.includes("'--convert-to'")) generated = true;
      return { exitCode: 0, stdOut: "", stdErr: "" };
    },
  });

  assert.deepEqual(result, {
    path: outputPath,
    name: "informe final.pdf",
    size: 321,
    sourceType: "word",
    executable,
  });
  assert.equal(commands.length, 2);
  assert.match(
    commands[1],
    /'--headless'.*'--convert-to' 'pdf:writer_pdf_Export' '--outdir'/u,
  );
  assert.match(commands[1], /'\/docs\/informe final\.docx'$/u);
});

test("el factory reutiliza una detección válida", async () => {
  const executable = "/usr/bin/libreoffice";
  let versionChecks = 0;
  const converter = createOfficeConverter({
    platform: "linux",
    libreOfficePath: executable,
    getStats: async (path) => {
      if (path === executable) return { isFile: true };
      throw new Error("No existe");
    },
    execCommand: async () => {
      versionChecks += 1;
      return { exitCode: 0 };
    },
  });

  assert.equal(await converter.detectLibreOffice(), executable);
  assert.equal(await converter.detectLibreOffice(), executable);
  assert.equal(versionChecks, 1);
});

test("no ejecuta la conversión si el PDF ya existe", async () => {
  let executions = 0;
  await assert.rejects(
    convertOfficeToPdf({
      sourcePath: "/docs/datos.xlsx",
      outputDirectory: "/salida",
      platform: "linux",
      getStats: async (path) => {
        if (path === "/docs/datos.xlsx") return { isFile: true, size: 10 };
        if (path === "/salida") return { isDirectory: true };
        if (path === "/salida/datos.pdf") return { isFile: true, size: 20 };
        throw new Error("No existe");
      },
      execCommand: async () => {
        executions += 1;
        return { exitCode: 0 };
      },
    }),
    /Ya existe un PDF/u,
  );
  assert.equal(executions, 0);
});

test("informa un fallo de LibreOffice y una salida ausente", async () => {
  const executable = "/usr/bin/libreoffice";
  const common = {
    sourcePath: "/docs/deck.pptx",
    outputDirectory: "/salida",
    platform: "linux",
    libreOfficePath: executable,
  };
  const createStats = () => async (path) => {
    if (path === common.sourcePath) return { isFile: true, size: 10 };
    if (path === common.outputDirectory) return { isDirectory: true };
    if (path === executable) return { isFile: true };
    throw new Error("No existe");
  };

  let invocation = 0;
  await assert.rejects(
    convertOfficeToPdf({
      ...common,
      getStats: createStats(),
      execCommand: async () => {
        invocation += 1;
        return { exitCode: invocation === 1 ? 0 : 7 };
      },
    }),
    /código 7/u,
  );

  await assert.rejects(
    convertOfficeToPdf({
      ...common,
      getStats: createStats(),
      execCommand: async () => ({ exitCode: 0 }),
    }),
    /no generó un PDF válido/u,
  );
});

test("prepara PDF de LibreOffice y limita el fallback canvas a PPTX", async () => {
  const outputDirectory = "/salida";
  const executable = "/usr/bin/libreoffice";
  let generated = false;
  const result = await preparePresentationForViewing({
    sourcePath: "/docs/deck.odp",
    outputDirectory,
    platform: "linux",
    libreOfficePath: executable,
    getStats: async (path) => {
      if (path === "/docs/deck.odp") return { isFile: true, size: 100 };
      if (path === outputDirectory) return { isDirectory: true };
      if (path === executable) return { isFile: true };
      if (path === "/salida/deck.pdf" && generated) {
        return { isFile: true, size: 500, modifiedAt: 2 };
      }
      throw new Error("No existe");
    },
    execCommand: async (command) => {
      if (command.includes("'--convert-to'")) generated = true;
      return { exitCode: 0 };
    },
  });

  assert.equal(result.mode, "pdf");
  assert.equal(result.renderer, "pdfjs");
  assert.equal(result.fidelity, "libreoffice");
  assert.equal(result.originalFormat, "odp");
  assert.equal(result.path, "/salida/deck.pdf");
  assert.match(
    result.temporaryProfilePath,
    /^\/salida\/\.pluma-reader-lo-[a-z\d]+$/u,
  );

  const missingLibreOffice = {
    outputDirectory,
    platform: "linux",
    getStats: async (path) => {
      if (path.startsWith("/docs/")) return { isFile: true, size: 100 };
      if (path === outputDirectory) return { isDirectory: true };
      throw new Error("No existe");
    },
    execCommand: async () => ({ exitCode: 1 }),
  };
  const fallback = await preparePresentationForViewing({
    ...missingLibreOffice,
    sourcePath: "/docs/deck.pptx",
  });
  assert.equal(fallback.mode, "pptx-canvas");
  assert.equal(fallback.renderer, "pptxviewjs");

  await assert.rejects(
    preparePresentationForViewing({
      ...missingLibreOffice,
      sourcePath: "/docs/deck.ppt",
    }),
    (error) => error instanceof PresentationConversionRequiredError
      && error.code === "PRESENTATION_CONVERSION_REQUIRED"
      && error.format === "ppt",
  );
});
