#!/usr/bin/env bash

set -Eeuo pipefail
export LC_ALL=C
umask 022

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 \
    || die "Falta la herramienta requerida '$1'."
}

show_help() {
  cat <<'EOF'
Construye el AppImage x86_64 de TenjinReader a partir del binario Neutralino.

Uso:
  bash scripts/build_appimage.sh

Variables opcionales:
  APPIMAGETOOL          Ruta a appimagetool-x86_64.AppImage o appimagetool.
  APPIMAGE_GPG_KEY      Identidad GPG para crear una firma ASCII separada.
  TENJINREADER_LINUX_BINARY Binario ELF x86_64 de Neutralino.
  TENJINREADER_ICON_PNG     Icono PNG de la aplicación.
  TENJINREADER_OUTPUT_DIR   Carpeta de salida.
  SOURCE_DATE_EPOCH     Época usada para normalizar fechas (por defecto, 0).

La firma GPG es opcional y separada. Si APPIMAGE_GPG_KEY no está definida, el
script declara expresamente que el AppImage queda sin firma.
EOF
}

if [[ $# -gt 0 ]]; then
  case "$1" in
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      die "Argumento desconocido: $1. Usa --help para ver las opciones."
      ;;
  esac
fi

[[ "$(uname -s)" == "Linux" ]] \
  || die "Este script debe ejecutarse en Linux; el sistema actual es $(uname -s)."

need_command node
need_command cp
need_command find
need_command grep
need_command mkdir
need_command mktemp
need_command mv
need_command od
need_command readelf
need_command sha256sum
need_command touch
need_command tr

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
DEFAULT_OUTPUT_DIR="$(CDPATH= cd -- "$PROJECT_ROOT/../.." && pwd)/outputs"
OUTPUT_DIR="${TENJINREADER_OUTPUT_DIR:-$DEFAULT_OUTPUT_DIR}"
BINARY="${TENJINREADER_LINUX_BINARY:-$PROJECT_ROOT/dist/tenjinreader/tenjinreader-linux_x64}"
ICON="${TENJINREADER_ICON_PNG:-$PROJECT_ROOT/public/icon.png}"
PDF_ICON="$PROJECT_ROOT/installer/PdfDocument.png"
PRESENTATION_ICON="$PROJECT_ROOT/installer/PptxDocument.png"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"

[[ "$SOURCE_DATE_EPOCH" =~ ^[0-9]+$ ]] \
  || die "SOURCE_DATE_EPOCH debe ser un entero no negativo."
[[ -f "$PROJECT_ROOT/package.json" ]] \
  || die "No se encontró $PROJECT_ROOT/package.json."

VERSION="$(
  node -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (typeof data.version !== "string" || !data.version) process.exit(2);
    process.stdout.write(data.version);
  ' "$PROJECT_ROOT/package.json"
)" || die "No se pudo leer la versión desde package.json."

[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]] \
  || die "La versión '$VERSION' no es válida para el nombre del AppImage."
[[ -f "$BINARY" ]] \
  || die "No existe el binario Neutralino de Linux x86_64: $BINARY"
[[ -f "$ICON" ]] \
  || die "No existe el icono PNG: $ICON"
[[ -f "$PDF_ICON" ]] \
  || die "No existe el icono asociado de PDF: $PDF_ICON"
[[ -f "$PRESENTATION_ICON" ]] \
  || die "No existe el icono naranja asociado de presentaciones: $PRESENTATION_ICON"

ELF_MAGIC="$(od -An -tx1 -N4 "$BINARY" | tr -d '[:space:]')"
[[ "$ELF_MAGIC" == "7f454c46" ]] \
  || die "El archivo indicado no es un ejecutable ELF: $BINARY"
readelf -h "$BINARY" | grep -Eq 'Class:[[:space:]]+ELF64' \
  || die "El binario de Linux no es ELF de 64 bits."
readelf -h "$BINARY" | grep -Eq 'Machine:[[:space:]]+Advanced Micro Devices X86-64' \
  || die "El binario de Linux no es x86_64."

if [[ -n "${APPIMAGETOOL:-}" ]]; then
  APPIMAGE_TOOL="$APPIMAGETOOL"
else
  APPIMAGE_TOOL="$(command -v appimagetool 2>/dev/null || true)"
  if [[ -z "$APPIMAGE_TOOL" ]]; then
    APPIMAGE_TOOL="$(command -v appimagetool-x86_64.AppImage 2>/dev/null || true)"
  fi
fi

[[ -n "$APPIMAGE_TOOL" ]] || die \
  "No se encontró appimagetool. Define APPIMAGETOOL con la ruta a una versión x86_64 verificada."
[[ -f "$APPIMAGE_TOOL" && -x "$APPIMAGE_TOOL" ]] || die \
  "APPIMAGETOOL no apunta a un archivo ejecutable: $APPIMAGE_TOOL"

mkdir -p -- "$OUTPUT_DIR"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tenjinreader-appimage.XXXXXX")"
trap 'rm -rf -- "$WORK_DIR"' EXIT

APPDIR="$WORK_DIR/TenjinReader.AppDir"
DESKTOP_NAME="io.tenjinreader.app.desktop"
ICON_NAME="io.tenjinreader.app.png"
OUTPUT_NAME="TenjinReader-${VERSION}-x86_64.AppImage"
OUTPUT_PATH="$OUTPUT_DIR/$OUTPUT_NAME"
TEMP_OUTPUT="$WORK_DIR/$OUTPUT_NAME"

mkdir -p \
  "$APPDIR/usr/bin" \
  "$APPDIR/usr/share/applications" \
  "$APPDIR/usr/share/icons/hicolor/512x512/apps" \
  "$APPDIR/usr/share/icons/hicolor/512x512/mimetypes"

cp -- "$BINARY" "$APPDIR/usr/bin/TenjinReader"
cp -- "$ICON" "$APPDIR/$ICON_NAME"
cp -- "$ICON" \
  "$APPDIR/usr/share/icons/hicolor/512x512/apps/$ICON_NAME"
cp -- "$PDF_ICON" \
  "$APPDIR/usr/share/icons/hicolor/512x512/mimetypes/application-pdf.png"
cp -- "$PRESENTATION_ICON" \
  "$APPDIR/usr/share/icons/hicolor/512x512/mimetypes/application-vnd.ms-powerpoint.png"
cp -- "$PRESENTATION_ICON" \
  "$APPDIR/usr/share/icons/hicolor/512x512/mimetypes/application-vnd.openxmlformats-officedocument.presentationml.presentation.png"
cp -- "$PRESENTATION_ICON" \
  "$APPDIR/usr/share/icons/hicolor/512x512/mimetypes/application-vnd.oasis.opendocument.presentation.png"
cp -- "$PRESENTATION_ICON" \
  "$APPDIR/usr/share/icons/hicolor/512x512/mimetypes/application-vnd.oasis.opendocument.formula.png"

cat >"$APPDIR/AppRun" <<'EOF'
#!/bin/sh
set -eu
HERE="${APPDIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"
exec "$HERE/usr/bin/TenjinReader" "$@"
EOF

cat >"$APPDIR/$DESKTOP_NAME" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=TenjinReader
Comment=Lector y editor PDF ligero con visor de presentaciones
Exec=TenjinReader %F
Icon=io.tenjinreader.app
Terminal=false
Categories=Office;Viewer;
MimeType=application/pdf;application/vnd.ms-powerpoint;application/vnd.openxmlformats-officedocument.presentationml.presentation;application/vnd.oasis.opendocument.presentation;application/vnd.oasis.opendocument.formula;
X-AppImage-Version=$VERSION
EOF

cp -- "$APPDIR/$DESKTOP_NAME" \
  "$APPDIR/usr/share/applications/$DESKTOP_NAME"

chmod 0755 "$APPDIR/AppRun" "$APPDIR/usr/bin/TenjinReader"
chmod 0644 \
  "$APPDIR/$DESKTOP_NAME" \
  "$APPDIR/$ICON_NAME" \
  "$APPDIR/usr/share/applications/$DESKTOP_NAME" \
  "$APPDIR/usr/share/icons/hicolor/512x512/apps/$ICON_NAME" \
  "$APPDIR/usr/share/icons/hicolor/512x512/mimetypes/application-pdf.png" \
  "$APPDIR/usr/share/icons/hicolor/512x512/mimetypes/application-vnd.ms-powerpoint.png" \
  "$APPDIR/usr/share/icons/hicolor/512x512/mimetypes/application-vnd.openxmlformats-officedocument.presentationml.presentation.png" \
  "$APPDIR/usr/share/icons/hicolor/512x512/mimetypes/application-vnd.oasis.opendocument.presentation.png" \
  "$APPDIR/usr/share/icons/hicolor/512x512/mimetypes/application-vnd.oasis.opendocument.formula.png"

# appimagetool y mksquashfs respetan SOURCE_DATE_EPOCH. Normalizar también el
# AppDir evita que fechas del checkout entren accidentalmente en la imagen.
find "$APPDIR" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

printf 'Creando %s con %s...\n' "$OUTPUT_NAME" "$APPIMAGE_TOOL"
ARCH=x86_64 \
SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
APPIMAGE_EXTRACT_AND_RUN=1 \
  "$APPIMAGE_TOOL" "$APPDIR" "$TEMP_OUTPUT"

[[ -s "$TEMP_OUTPUT" ]] \
  || die "appimagetool terminó sin crear un AppImage válido."
chmod 0755 "$TEMP_OUTPUT"
mv -f -- "$TEMP_OUTPUT" "$OUTPUT_PATH"

# Nunca se conserva una firma antigua al reemplazar el AppImage.
rm -f -- "${OUTPUT_PATH}.asc"
if [[ -n "${APPIMAGE_GPG_KEY:-}" ]]; then
  need_command gpg
  gpg --batch --yes --armor --detach-sign \
    --local-user "$APPIMAGE_GPG_KEY" \
    --output "${OUTPUT_PATH}.asc" \
    "$OUTPUT_PATH"
  printf 'Firma GPG separada creada: %s\n' "${OUTPUT_PATH}.asc"
else
  printf 'Firma AppImage: omitida (APPIMAGE_GPG_KEY no está definida).\n' >&2
fi

(
  cd -- "$OUTPUT_DIR"
  sha256sum "$OUTPUT_NAME" >"${OUTPUT_NAME}.sha256"
)

printf 'AppImage creado: %s\n' "$OUTPUT_PATH"
printf 'SHA-256: %s\n' "${OUTPUT_PATH}.sha256"
