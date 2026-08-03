import {
  PDF,
  PermissionDeniedError,
  SecurityError,
} from "@libpdf/core";

const AES_256 = "AES-256";
const PASSWORD_MAX_UTF8_BYTES = 127;
const PASSWORD_MIN_CHARACTERS = 8;
const PERMISSION_NAMES = Object.freeze([
  "print",
  "printHighQuality",
  "modify",
  "copy",
  "annotate",
  "fillForms",
  "accessibility",
  "assemble",
]);

export const PDF_SECURITY_ERROR_CODES = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  WEAK_PASSWORD: "WEAK_PASSWORD",
  ALREADY_PROTECTED: "ALREADY_PROTECTED",
  NOT_PROTECTED: "NOT_PROTECTED",
  INVALID_PASSWORD: "INVALID_PASSWORD",
  INSUFFICIENT_PERMISSIONS: "INSUFFICIENT_PERMISSIONS",
  SIGNED_PDF_UNSUPPORTED: "SIGNED_PDF_UNSUPPORTED",
  UNSUPPORTED_ENCRYPTION: "UNSUPPORTED_ENCRYPTION",
  OPERATION_FAILED: "OPERATION_FAILED",
});

export class PdfSecurityError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "PdfSecurityError";
    this.code = code;
  }
}

function normalizeBytes(value) {
  let bytes;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  if (!bytes || bytes.byteLength === 0) {
    throw new PdfSecurityError(
      PDF_SECURITY_ERROR_CODES.INVALID_INPUT,
      "Los datos del PDF deben ser binarios y no estar vacíos.",
    );
  }
  return bytes;
}

function normalizePassword(value, { allowEmpty = false, label = "contraseña" } = {}) {
  if (typeof value !== "string") {
    throw new PdfSecurityError(
      PDF_SECURITY_ERROR_CODES.WEAK_PASSWORD,
      `La ${label} debe ser texto.`,
    );
  }
  if (!allowEmpty && value.length < PASSWORD_MIN_CHARACTERS) {
    throw new PdfSecurityError(
      PDF_SECURITY_ERROR_CODES.WEAK_PASSWORD,
      `La ${label} debe tener al menos ${PASSWORD_MIN_CHARACTERS} caracteres.`,
    );
  }
  if (new TextEncoder().encode(value).byteLength > PASSWORD_MAX_UTF8_BYTES) {
    throw new PdfSecurityError(
      PDF_SECURITY_ERROR_CODES.WEAK_PASSWORD,
      `La ${label} no puede superar ${PASSWORD_MAX_UTF8_BYTES} bytes UTF-8.`,
    );
  }
  return value;
}

function normalizePermissions(value) {
  const permissions = Object.fromEntries(
    PERMISSION_NAMES.map((name) => [name, true]),
  );
  if (value === undefined) return permissions;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("permissions debe ser un objeto de permisos booleanos.");
  }

  for (const [name, allowed] of Object.entries(value)) {
    if (!PERMISSION_NAMES.includes(name)) {
      throw new TypeError(`El permiso PDF "${name}" no es válido.`);
    }
    if (typeof allowed !== "boolean") {
      throw new TypeError(`El permiso PDF "${name}" debe ser booleano.`);
    }
    permissions[name] = allowed;
  }
  return permissions;
}

function secureRandomOwnerPassword() {
  const randomValues = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
  if (!randomValues) {
    throw new PdfSecurityError(
      PDF_SECURITY_ERROR_CODES.OPERATION_FAILED,
      "El sistema no ofrece un generador criptográfico seguro.",
    );
  }

  const bytes = new Uint8Array(32);
  randomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasSignedSignature(pdf) {
  try {
    return Boolean(pdf.getForm()?.getFields().some(
      (field) => field.type === "signature" && field.isSigned(),
    ));
  } catch {
    // If a malformed form cannot be inspected, let the security engine attempt
    // its content-preserving rewrite instead of reporting a false signature.
    return false;
  }
}

function assertUnsigned(pdf) {
  if (hasSignedSignature(pdf)) {
    throw new PdfSecurityError(
      PDF_SECURITY_ERROR_CODES.SIGNED_PDF_UNSUPPORTED,
      "No se puede cambiar la protección de un PDF firmado digitalmente porque invalidaría su firma.",
    );
  }
}

function cleanLibraryMessage(error) {
  return String(error?.message || error || "error desconocido")
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, 240);
}

async function loadPdf(bytes, credentials) {
  try {
    return await PDF.load(
      bytes,
      credentials === undefined ? undefined : { credentials },
    );
  } catch (error) {
    const message = cleanLibraryMessage(error);
    if (
      credentials !== undefined
      && /(?:invalid|incorrect|wrong|bad).{0,24}(?:password|credential)|(?:password|credential).{0,24}(?:invalid|incorrect|wrong|bad)|authentication failed/iu.test(message)
    ) {
      throw new PdfSecurityError(
        PDF_SECURITY_ERROR_CODES.INVALID_PASSWORD,
        "La contraseña del PDF es incorrecta.",
        { cause: error },
      );
    }
    if (error instanceof SecurityError || /password|credential|decrypt|encrypt/iu.test(message)) {
      throw new PdfSecurityError(
        PDF_SECURITY_ERROR_CODES.UNSUPPORTED_ENCRYPTION,
        "El método de cifrado o las credenciales de este PDF no son compatibles.",
        { cause: error },
      );
    }
    throw new PdfSecurityError(
      PDF_SECURITY_ERROR_CODES.INVALID_INPUT,
      `No se pudo leer el PDF: ${message}`,
      { cause: error },
    );
  }
}

function publicSecurityInfo(pdf) {
  const security = pdf.getSecurity();
  return {
    isEncrypted: pdf.isEncrypted,
    isAuthenticated: pdf.isAuthenticated,
    hasOwnerAccess: pdf.hasOwnerAccess(),
    pageCount: pdf.getPageCount(),
    algorithm: security.algorithm,
    keyLength: security.keyLength,
    revision: security.revision,
    authenticatedAs: security.authenticatedAs,
    permissions: { ...security.permissions },
    encryptMetadata: security.encryptMetadata,
  };
}

/** Inspects encryption without modifying the PDF or exposing credentials. */
export async function inspectPdfSecurity(input, password) {
  const bytes = normalizeBytes(input);
  const credentials = password === undefined
    ? undefined
    : normalizePassword(password, { allowEmpty: true });
  const pdf = await loadPdf(bytes, credentials);
  return publicSecurityInfo(pdf);
}

/** Protects an unencrypted PDF locally with AES-256 (revision 6). */
export async function protectPdf(input, password, options = {}) {
  const bytes = normalizeBytes(input);
  const userPassword = normalizePassword(password);
  const permissions = normalizePermissions(options.permissions);
  const ownerPassword = options.ownerPassword === undefined
    ? secureRandomOwnerPassword()
    : normalizePassword(options.ownerPassword, { label: "contraseña de propietario" });
  if (ownerPassword === userPassword) {
    throw new PdfSecurityError(
      PDF_SECURITY_ERROR_CODES.WEAK_PASSWORD,
      "La contraseña de propietario debe ser diferente de la contraseña de apertura.",
    );
  }

  const pdf = await loadPdf(bytes);
  if (pdf.isEncrypted) {
    throw new PdfSecurityError(
      PDF_SECURITY_ERROR_CODES.ALREADY_PROTECTED,
      "El PDF ya está protegido. Desbloquéalo antes de cambiar su contraseña.",
    );
  }
  assertUnsigned(pdf);

  try {
    pdf.setProtection({
      userPassword,
      ownerPassword,
      permissions,
      algorithm: AES_256,
      encryptMetadata: options.encryptMetadata !== false,
    });
    const output = await pdf.save();
    const verified = await loadPdf(output, userPassword);
    if (!verified.isEncrypted || !verified.isAuthenticated) {
      throw new Error("la verificación criptográfica del resultado falló");
    }
    return output;
  } catch (error) {
    if (error instanceof PdfSecurityError) throw error;
    throw new PdfSecurityError(
      PDF_SECURITY_ERROR_CODES.OPERATION_FAILED,
      `No se pudo proteger el PDF: ${cleanLibraryMessage(error)}`,
      { cause: error },
    );
  }
}

/** Removes password encryption after authenticating locally. */
export async function unlockPdf(input, password) {
  const bytes = normalizeBytes(input);
  const credentials = normalizePassword(password, { allowEmpty: true });
  const pdf = await loadPdf(bytes, credentials);
  if (!pdf.isEncrypted) {
    throw new PdfSecurityError(
      PDF_SECURITY_ERROR_CODES.NOT_PROTECTED,
      "El PDF no está protegido con contraseña.",
    );
  }
  if (!pdf.isAuthenticated) {
    throw new PdfSecurityError(
      PDF_SECURITY_ERROR_CODES.INVALID_PASSWORD,
      "La contraseña del PDF es incorrecta.",
    );
  }
  assertUnsigned(pdf);

  try {
    pdf.removeProtection();
    const output = await pdf.save();
    const verified = await loadPdf(output);
    if (verified.isEncrypted) {
      throw new Error("el resultado todavía contiene cifrado");
    }
    return output;
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      throw new PdfSecurityError(
        PDF_SECURITY_ERROR_CODES.INSUFFICIENT_PERMISSIONS,
        "Se necesita la contraseña de propietario para desbloquear este PDF.",
        { cause: error },
      );
    }
    if (error instanceof PdfSecurityError) throw error;
    throw new PdfSecurityError(
      PDF_SECURITY_ERROR_CODES.OPERATION_FAILED,
      `No se pudo desbloquear el PDF: ${cleanLibraryMessage(error)}`,
      { cause: error },
    );
  }
}
