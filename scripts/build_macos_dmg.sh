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
Construye un bundle .app universal real y un DMG de Folentra PDF.

Uso:
  bash scripts/build_macos_dmg.sh

Variables generales:
  FOLENTRA_MACOS_BINARY Binario Neutralino universal.
  FOLENTRA_ICON_PNG     Icono PNG de la aplicación.
  FOLENTRA_OUTPUT_DIR   Carpeta de salida.
  MACOS_BUNDLE_ID       Identificador del bundle (com.folentrapdf.app).
  MACOS_BUNDLE_VERSION  CFBundleVersion; por defecto usa package.json.
  SOURCE_DATE_EPOCH     Época para normalizar el staging (por defecto, 0).

Firma opcional:
  MACOS_SIGN_IDENTITY   Identidad de Developer ID para codesign.
  MACOS_ENTITLEMENTS    Archivo de entitlements opcional.
  MACOS_DISABLE_TIMESTAMP=1
                         Omite el sello de tiempo de codesign.

Notarización opcional:
  MACOS_NOTARY_PROFILE  Perfil creado previamente con:
                         xcrun notarytool store-credentials NOMBRE

Sin MACOS_SIGN_IDENTITY se generan artefactos sin firma. Sin
MACOS_NOTARY_PROFILE no se afirma que estén notarizados.
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

[[ "$(uname -s)" == "Darwin" ]] \
  || die "Este script requiere macOS; el sistema actual es $(uname -s)."

need_command node
need_command cp
need_command date
need_command ditto
need_command find
need_command hdiutil
need_command iconutil
need_command lipo
need_command ln
need_command mkdir
need_command mktemp
need_command mv
need_command plutil
need_command shasum
need_command sips
need_command touch

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
DEFAULT_OUTPUT_DIR="$(CDPATH= cd -- "$PROJECT_ROOT/../.." && pwd)/outputs"
OUTPUT_DIR="${FOLENTRA_OUTPUT_DIR:-$DEFAULT_OUTPUT_DIR}"
BINARY="${FOLENTRA_MACOS_BINARY:-$PROJECT_ROOT/dist/folentra-pdf/folentra-pdf-mac_universal}"
ICON="${FOLENTRA_ICON_PNG:-$PROJECT_ROOT/public/icon.png}"
PDF_ICON="$PROJECT_ROOT/installer/PdfDocument.png"
PRESENTATION_ICON="$PROJECT_ROOT/installer/PptxDocument.png"
BUNDLE_ID="${MACOS_BUNDLE_ID:-com.folentrapdf.app}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"

[[ "$SOURCE_DATE_EPOCH" =~ ^[0-9]+$ ]] \
  || die "SOURCE_DATE_EPOCH debe ser un entero no negativo."
[[ "$BUNDLE_ID" =~ ^[A-Za-z0-9]+([.-][A-Za-z0-9]+)+$ ]] \
  || die "MACOS_BUNDLE_ID no es válido: $BUNDLE_ID"
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

SHORT_VERSION="$VERSION"
BUILD_VERSION="${MACOS_BUNDLE_VERSION:-$VERSION}"
[[ "$SHORT_VERSION" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || die \
  "La versión '$SHORT_VERSION' no sirve como CFBundleShortVersionString. Ajusta package.json."
[[ "$BUILD_VERSION" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || die \
  "MACOS_BUNDLE_VERSION debe contener de uno a tres componentes numéricos."
[[ -f "$BINARY" ]] \
  || die "No existe el binario Neutralino universal de macOS: $BINARY"
[[ -f "$ICON" ]] \
  || die "No existe el icono PNG: $ICON"
[[ -f "$PDF_ICON" ]] \
  || die "No existe el icono asociado de PDF: $PDF_ICON"
[[ -f "$PRESENTATION_ICON" ]] \
  || die "No existe el icono naranja asociado de presentaciones: $PRESENTATION_ICON"

MACHO_ARCHS="$(lipo -archs "$BINARY" 2>/dev/null)" \
  || die "El archivo indicado no es un binario Mach-O válido: $BINARY"
case " $MACHO_ARCHS " in
  *" x86_64 "*) ;;
  *) die "El binario de macOS no contiene la arquitectura x86_64: $MACHO_ARCHS" ;;
esac
case " $MACHO_ARCHS " in
  *" arm64 "*) ;;
  *) die "El binario de macOS no contiene la arquitectura arm64: $MACHO_ARCHS" ;;
esac

SIGN_IDENTITY="${MACOS_SIGN_IDENTITY:-}"
NOTARY_PROFILE="${MACOS_NOTARY_PROFILE:-}"
ENTITLEMENTS="${MACOS_ENTITLEMENTS:-}"
DISABLE_TIMESTAMP="${MACOS_DISABLE_TIMESTAMP:-0}"

[[ "$DISABLE_TIMESTAMP" == "0" || "$DISABLE_TIMESTAMP" == "1" ]] \
  || die "MACOS_DISABLE_TIMESTAMP debe ser 0 o 1."
if [[ -n "$ENTITLEMENTS" && ! -f "$ENTITLEMENTS" ]]; then
  die "No existe el archivo MACOS_ENTITLEMENTS: $ENTITLEMENTS"
fi
if [[ -n "$SIGN_IDENTITY" ]]; then
  need_command codesign
fi
if [[ -n "$NOTARY_PROFILE" ]]; then
  [[ -n "$SIGN_IDENTITY" && "$SIGN_IDENTITY" != "-" ]] || die \
    "La notarización requiere MACOS_SIGN_IDENTITY con un certificado Developer ID; una firma vacía o ad hoc no es válida."
  [[ "$DISABLE_TIMESTAMP" == "0" ]] || die \
    "La notarización requiere un sello de tiempo; no uses MACOS_DISABLE_TIMESTAMP=1."
  need_command xcrun
fi

mkdir -p -- "$OUTPUT_DIR"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/folentra-pdf-macos.XXXXXX")"
trap 'rm -rf -- "$WORK_DIR"' EXIT

APP_NAME="Folentra PDF"
APP_BUNDLE="$WORK_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES_DIR="$CONTENTS/Resources"
APP_ICONSET="$WORK_DIR/FolentraPDF.iconset"
PDF_ICONSET="$WORK_DIR/PdfDocument.iconset"
PRESENTATION_ICONSET="$WORK_DIR/PptxDocument.iconset"
DMG_ROOT="$WORK_DIR/dmg-root"
TEMP_DMG="$WORK_DIR/Folentra-PDF-${VERSION}-universal.dmg"
APP_OUTPUT="$OUTPUT_DIR/Folentra PDF.app"
DMG_OUTPUT="$OUTPUT_DIR/Folentra-PDF-${VERSION}-universal.dmg"
DMG_NAME="$(basename -- "$DMG_OUTPUT")"

mkdir -p \
  "$MACOS_DIR" "$RESOURCES_DIR" "$APP_ICONSET" "$PDF_ICONSET" \
  "$PRESENTATION_ICONSET" "$DMG_ROOT"
cp -- "$BINARY" "$MACOS_DIR/$APP_NAME"
chmod 0755 "$MACOS_DIR/$APP_NAME"

make_icon() {
  local source="$1"
  local iconset="$2"
  local pixels="$3"
  local destination="$4"
  sips -s format png -z "$pixels" "$pixels" "$source" \
    --out "$iconset/$destination" >/dev/null
}

make_iconset() {
  local source="$1"
  local iconset="$2"
  local destination="$3"
  make_icon "$source" "$iconset" 16 icon_16x16.png
  make_icon "$source" "$iconset" 32 icon_16x16@2x.png
  make_icon "$source" "$iconset" 32 icon_32x32.png
  make_icon "$source" "$iconset" 64 icon_32x32@2x.png
  make_icon "$source" "$iconset" 128 icon_128x128.png
  make_icon "$source" "$iconset" 256 icon_128x128@2x.png
  make_icon "$source" "$iconset" 256 icon_256x256.png
  make_icon "$source" "$iconset" 512 icon_256x256@2x.png
  make_icon "$source" "$iconset" 512 icon_512x512.png
  make_icon "$source" "$iconset" 1024 icon_512x512@2x.png
  iconutil -c icns "$iconset" -o "$RESOURCES_DIR/$destination"
}

make_iconset "$ICON" "$APP_ICONSET" FolentraPDF.icns
make_iconset "$PDF_ICON" "$PDF_ICONSET" PdfDocument.icns
make_iconset "$PRESENTATION_ICON" "$PRESENTATION_ICONSET" PptxDocument.icns

cat >"$CONTENTS/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>es</string>
  <key>CFBundleDisplayName</key>
  <string>Folentra PDF</string>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeExtensions</key>
      <array><string>pdf</string></array>
      <key>CFBundleTypeName</key>
      <string>Documento PDF</string>
      <key>CFBundleTypeIconFile</key>
      <string>PdfDocument.icns</string>
      <key>CFBundleTypeRole</key>
      <string>Editor</string>
      <key>LSHandlerRank</key>
      <string>Alternate</string>
      <key>LSItemContentTypes</key>
      <array><string>com.adobe.pdf</string></array>
    </dict>
    <dict>
      <key>CFBundleTypeExtensions</key>
      <array>
        <string>ppt</string>
        <string>pptx</string>
        <string>odp</string>
        <string>odf</string>
      </array>
      <key>CFBundleTypeName</key>
      <string>Presentación de solo lectura</string>
      <key>CFBundleTypeIconFile</key>
      <string>PptxDocument.icns</string>
      <key>CFBundleTypeRole</key>
      <string>Viewer</string>
      <key>LSHandlerRank</key>
      <string>Alternate</string>
      <key>LSItemContentTypes</key>
      <array>
        <string>com.microsoft.powerpoint.ppt</string>
        <string>org.openxmlformats.presentationml.presentation</string>
        <string>org.oasis-open.opendocument.presentation</string>
        <string>org.oasis-open.opendocument.formula</string>
      </array>
    </dict>
  </array>
  <key>CFBundleExecutable</key>
  <string>Folentra PDF</string>
  <key>CFBundleIconFile</key>
  <string>FolentraPDF</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Folentra PDF</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$SHORT_VERSION</string>
  <key>CFBundleVersion</key>
  <string>$BUILD_VERSION</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

plutil -lint "$CONTENTS/Info.plist" >/dev/null \
  || die "Info.plist no pasó la validación de plutil."

TIMESTAMP="$(date -u -r "$SOURCE_DATE_EPOCH" '+%Y%m%d%H%M.%S')" \
  || die "No se pudo convertir SOURCE_DATE_EPOCH a una fecha de macOS."
find "$APP_BUNDLE" -exec touch -h -t "$TIMESTAMP" {} +

codesign_common_args=(--force --sign "$SIGN_IDENTITY")
if [[ "$DISABLE_TIMESTAMP" == "0" && "$SIGN_IDENTITY" != "-" ]]; then
  codesign_common_args+=(--timestamp)
fi

if [[ -n "$SIGN_IDENTITY" ]]; then
  app_sign_args=("${codesign_common_args[@]}" --options runtime)
  if [[ -n "$ENTITLEMENTS" ]]; then
    app_sign_args+=(--entitlements "$ENTITLEMENTS")
  fi
  codesign "${app_sign_args[@]}" "$APP_BUNDLE"
  codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"
  printf 'Firma del bundle: aplicada con "%s".\n' "$SIGN_IDENTITY"
else
  printf 'Firma macOS: omitida (MACOS_SIGN_IDENTITY no está definida).\n' >&2
fi

if [[ -n "$NOTARY_PROFILE" ]]; then
  APP_NOTARY_ZIP="$WORK_DIR/Folentra-PDF-notary.zip"
  ditto -c -k --sequesterRsrc --keepParent "$APP_BUNDLE" "$APP_NOTARY_ZIP"
  xcrun notarytool submit "$APP_NOTARY_ZIP" \
    --keychain-profile "$NOTARY_PROFILE" \
    --wait
  xcrun stapler staple "$APP_BUNDLE"
  xcrun stapler validate "$APP_BUNDLE"
  printf 'Bundle .app: firmado, notarizado y grapado.\n'
else
  if [[ -n "$SIGN_IDENTITY" ]]; then
    printf 'Notarización del bundle: omitida (MACOS_NOTARY_PROFILE no está definida).\n' >&2
  else
    printf 'Bundle .app: SIN FIRMA y SIN NOTARIZACIÓN.\n' >&2
  fi
fi

ditto "$APP_BUNDLE" "$DMG_ROOT/$APP_NAME.app"
ln -s /Applications "$DMG_ROOT/Applications"
find "$DMG_ROOT" -exec touch -h -t "$TIMESTAMP" {} +

hdiutil create \
  -quiet \
  -fs HFS+ \
  -format UDZO \
  -ov \
  -volname "Folentra PDF" \
  -srcfolder "$DMG_ROOT" \
  "$TEMP_DMG"

[[ -s "$TEMP_DMG" ]] \
  || die "hdiutil terminó sin crear un DMG válido."

if [[ -n "$SIGN_IDENTITY" ]]; then
  codesign "${codesign_common_args[@]}" "$TEMP_DMG"
  codesign --verify --verbose=2 "$TEMP_DMG"
  printf 'Firma del DMG: aplicada con "%s".\n' "$SIGN_IDENTITY"
else
  printf 'DMG: SIN FIRMA.\n' >&2
fi

if [[ -n "$NOTARY_PROFILE" ]]; then
  xcrun notarytool submit "$TEMP_DMG" \
    --keychain-profile "$NOTARY_PROFILE" \
    --wait
  xcrun stapler staple "$TEMP_DMG"
  xcrun stapler validate "$TEMP_DMG"
  printf 'DMG: firmado, notarizado y grapado.\n'
else
  printf 'Notarización del DMG: omitida (MACOS_NOTARY_PROFILE no está definida).\n' >&2
fi

# Reemplazar únicamente los dos artefactos de salida con nombres conocidos.
rm -rf -- "$APP_OUTPUT"
rm -f -- "$DMG_OUTPUT" "${DMG_OUTPUT}.sha256"
ditto "$APP_BUNDLE" "$APP_OUTPUT"
mv -- "$TEMP_DMG" "$DMG_OUTPUT"

(
  cd -- "$OUTPUT_DIR"
  shasum -a 256 "$DMG_NAME" >"${DMG_NAME}.sha256"
)

if [[ -n "$SIGN_IDENTITY" ]]; then
  codesign --verify --deep --strict --verbose=2 "$APP_OUTPUT"
  codesign --verify --verbose=2 "$DMG_OUTPUT"
fi

printf 'Bundle creado: %s\n' "$APP_OUTPUT"
printf 'DMG creado: %s\n' "$DMG_OUTPUT"
printf 'SHA-256: %s\n' "${DMG_OUTPUT}.sha256"
if [[ -z "$SIGN_IDENTITY" ]]; then
  printf 'Resultado final: artefactos sin firma y sin notarización.\n' >&2
elif [[ -z "$NOTARY_PROFILE" ]]; then
  printf 'Resultado final: artefactos firmados, pero NO notarizados.\n' >&2
else
  printf 'Resultado final: artefactos firmados y notarizados.\n'
fi
