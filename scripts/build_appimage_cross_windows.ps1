[CmdletBinding()]
param(
    [string]$ProjectRoot = "",
    [string]$MksquashfsPath = "",
    [string]$RuntimePath = "",
    [string]$OutputDirectory = "",
    [string]$MsysBinPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Resolve-RequiredFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "No se encontró $Description`: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Convert-ToMsysPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $absolute = [IO.Path]::GetFullPath($Path)
    if ($absolute -notmatch "^([A-Za-z]):\\(.*)$") {
        throw "No se puede convertir a una ruta MSYS2: $absolute"
    }
    $drive = $Matches[1].ToLowerInvariant()
    $tail = $Matches[2].Replace("\", "/")
    return "/$drive/$tail"
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $encoding = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, $Content, $encoding)
}

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Join-Path $PSScriptRoot ".."
}
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$projectParent = Split-Path -Parent $ProjectRoot
$workspaceRoot = Split-Path -Parent $projectParent

if ([string]::IsNullOrWhiteSpace($MksquashfsPath)) {
    $MksquashfsPath = Join-Path $projectParent "tools\squashfs-msys2\usr\bin\mksquashfs.exe"
}
if ([string]::IsNullOrWhiteSpace($RuntimePath)) {
    $RuntimePath = Join-Path $projectParent "tools\runtime-x86_64-75849dc"
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $workspaceRoot "outputs"
}
if ([string]::IsNullOrWhiteSpace($MsysBinPath)) {
    $MsysBinPath = Join-Path $env:ProgramFiles "Git\usr\bin"
}

$MksquashfsPath = Resolve-RequiredFile $MksquashfsPath "mksquashfs"
$RuntimePath = Resolve-RequiredFile $RuntimePath "el runtime de AppImage"
if (-not (Test-Path -LiteralPath $MsysBinPath -PathType Container)) {
    throw "No se encontró la carpeta de runtime MSYS2/Git: $MsysBinPath"
}
$MsysBinPath = (Resolve-Path -LiteralPath $MsysBinPath).Path

$packagePath = Resolve-RequiredFile (Join-Path $ProjectRoot "package.json") "package.json"
$package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch "^[0-9A-Za-z][0-9A-Za-z.+-]*$") {
    throw "La versión de package.json no es válida: $version"
}

$binary = Resolve-RequiredFile `
    (Join-Path $ProjectRoot "dist\tenjinreader\tenjinreader-linux_x64") `
    "el binario Neutralino Linux x86_64"
$icon = Resolve-RequiredFile (Join-Path $ProjectRoot "public\icon.png") "el icono PNG"
$pdfIcon = Resolve-RequiredFile `
    (Join-Path $ProjectRoot "installer\PdfDocument.png") `
    "el icono asociado de PDF"
$presentationIcon = Resolve-RequiredFile `
    (Join-Path $ProjectRoot "installer\PptxDocument.png") `
    "el icono naranja asociado de presentaciones"

$binaryMagic = [IO.File]::ReadAllBytes($binary)
if (
    $binaryMagic.Length -lt 20 -or
    $binaryMagic[0] -ne 0x7f -or
    $binaryMagic[1] -ne 0x45 -or
    $binaryMagic[2] -ne 0x4c -or
    $binaryMagic[3] -ne 0x46 -or
    $binaryMagic[4] -ne 0x02 -or
    $binaryMagic[18] -ne 0x3e -or
    $binaryMagic[19] -ne 0x00
) {
    throw "El binario indicado no es ELF64 x86_64: $binary"
}

$runtimeBytes = [IO.File]::ReadAllBytes($RuntimePath)
if (
    $runtimeBytes.Length -lt 16 -or
    $runtimeBytes[0] -ne 0x7f -or
    $runtimeBytes[1] -ne 0x45 -or
    $runtimeBytes[2] -ne 0x4c -or
    $runtimeBytes[3] -ne 0x46 -or
    $runtimeBytes[8] -ne 0x41 -or
    $runtimeBytes[9] -ne 0x49 -or
    $runtimeBytes[10] -ne 0x02
) {
    throw "El archivo indicado no es un runtime AppImage tipo 2: $RuntimePath"
}

$buildRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "build\folentra-appimage-cross-windows"))
$projectPrefix = $ProjectRoot.TrimEnd("\") + "\"
if (-not $buildRoot.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "La carpeta temporal quedó fuera del proyecto: $buildRoot"
}
if (Test-Path -LiteralPath $buildRoot) {
    Remove-Item -LiteralPath $buildRoot -Recurse -Force
}

$appDir = Join-Path $buildRoot "TenjinReader.AppDir"
$binaryDirectory = Join-Path $appDir "usr\bin"
$applicationsDirectory = Join-Path $appDir "usr\share\applications"
$iconsDirectory = Join-Path $appDir "usr\share\icons\hicolor\512x512\apps"
$mimeIconsDirectory = Join-Path $appDir "usr\share\icons\hicolor\512x512\mimetypes"
New-Item -ItemType Directory -Force -Path `
    $binaryDirectory, $applicationsDirectory, $iconsDirectory, $mimeIconsDirectory | Out-Null

$desktopName = "io.tenjinreader.app.desktop"
$iconName = "io.tenjinreader.app.png"
Copy-Item -LiteralPath $binary -Destination (Join-Path $binaryDirectory "TenjinReader")
Copy-Item -LiteralPath $icon -Destination (Join-Path $appDir $iconName)
Copy-Item -LiteralPath $icon -Destination (Join-Path $appDir ".DirIcon")
Copy-Item -LiteralPath $icon -Destination (Join-Path $iconsDirectory $iconName)
Copy-Item -LiteralPath $pdfIcon -Destination `
    (Join-Path $mimeIconsDirectory "application-pdf.png")
Copy-Item -LiteralPath $presentationIcon -Destination `
    (Join-Path $mimeIconsDirectory "application-vnd.ms-powerpoint.png")
Copy-Item -LiteralPath $presentationIcon -Destination `
    (Join-Path $mimeIconsDirectory "application-vnd.openxmlformats-officedocument.presentationml.presentation.png")
Copy-Item -LiteralPath $presentationIcon -Destination `
    (Join-Path $mimeIconsDirectory "application-vnd.oasis.opendocument.presentation.png")
Copy-Item -LiteralPath $presentationIcon -Destination `
    (Join-Path $mimeIconsDirectory "application-vnd.oasis.opendocument.formula.png")

$appRun = @'
#!/bin/sh
set -eu
HERE="${APPDIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"
exec "$HERE/usr/bin/TenjinReader" "$@"
'@
Write-Utf8NoBom (Join-Path $appDir "AppRun") ($appRun + "`n")

$desktop = @"
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
X-AppImage-Version=$version
"@
$desktopPath = Join-Path $appDir $desktopName
Write-Utf8NoBom $desktopPath ($desktop + "`n")
Copy-Item -LiteralPath $desktopPath -Destination (Join-Path $applicationsDirectory $desktopName)

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$outputName = "TenjinReader-$version-x86_64.AppImage"
$outputPath = [IO.Path]::GetFullPath((Join-Path $OutputDirectory $outputName))
$temporaryOutput = Join-Path $buildRoot $outputName
$squashfsPath = Join-Path $buildRoot "tenjinreader.squashfs"

$oldPath = $env:Path
try {
    $env:Path = "$(Split-Path -Parent $MksquashfsPath);$MsysBinPath;$oldPath"
    $arguments = @(
        (Convert-ToMsysPath $appDir),
        (Convert-ToMsysPath $squashfsPath),
        "-noappend",
        "-comp", "gzip",
        "-b", "131072",
        "-all-root",
        "-no-xattrs",
        "-repro-time", "0",
        "-p", "AppRun m 0755 0 0",
        "-p", "usr/bin/TenjinReader m 0755 0 0"
    )
    & $MksquashfsPath @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "mksquashfs terminó con el código $LASTEXITCODE."
    }
}
finally {
    $env:Path = $oldPath
}

# mksquashfs puede truncar un archivo preexistente al usar -offset en Windows.
# Generar SquashFS por separado y concatenarlo conserva exactamente el runtime
# ELF oficial al comienzo del AppImage tipo 2.
$outputStream = [IO.File]::Create($temporaryOutput)
try {
    $runtimeStream = [IO.File]::OpenRead($RuntimePath)
    try {
        $runtimeStream.CopyTo($outputStream)
    }
    finally {
        $runtimeStream.Dispose()
    }

    $squashfsStream = [IO.File]::OpenRead($squashfsPath)
    try {
        $squashfsStream.CopyTo($outputStream)
    }
    finally {
        $squashfsStream.Dispose()
    }
}
finally {
    $outputStream.Dispose()
}

$resultBytes = [IO.File]::ReadAllBytes($temporaryOutput)
if ($resultBytes.Length -le $runtimeBytes.Length + 4) {
    throw "El AppImage generado está vacío o truncado."
}
for ($index = 0; $index -lt 11; $index++) {
    if ($resultBytes[$index] -ne $runtimeBytes[$index]) {
        throw "El runtime ELF del AppImage fue alterado en el byte $index."
    }
}
$offset = $runtimeBytes.Length
if (
    $resultBytes[$offset] -ne 0x68 -or
    $resultBytes[$offset + 1] -ne 0x73 -or
    $resultBytes[$offset + 2] -ne 0x71 -or
    $resultBytes[$offset + 3] -ne 0x73
) {
    throw "No se encontró la cabecera SquashFS en el offset esperado $offset."
}

if (Test-Path -LiteralPath $outputPath) {
    Remove-Item -LiteralPath $outputPath -Force
}
Move-Item -LiteralPath $temporaryOutput -Destination $outputPath

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash.ToLowerInvariant()
$hashPath = "$outputPath.sha256"
Write-Utf8NoBom $hashPath "$hash  $outputName`n"

Write-Output "AppImage creado desde Windows: $outputPath"
Write-Output "Offset SquashFS verificado: $offset"
Write-Output "SHA-256: $hash"
Write-Warning "La firma GPG/AppImage no se aplicó; este archivo no es Authenticode ni Developer ID."
