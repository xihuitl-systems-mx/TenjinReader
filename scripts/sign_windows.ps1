#requires -Version 5.1

<#
.SYNOPSIS
Firma un artefacto de Windows de TenjinReader con Authenticode.

.DESCRIPTION
Firma, mediante SignTool, el ejecutable de la aplicación O el instalador.
La firma usa SHA-256 y un sello de tiempo RFC 3161 con SHA-256.

El archivo original no se modifica hasta que la copia firmada supera todas
las verificaciones. Después del reemplazo atómico, el archivo final se vuelve
a verificar. El script restaura el original si esa comprobación final falla.

La huella selecciona un certificado ya instalado en el almacén de Windows.
Este script nunca recibe ni almacena contraseñas, PIN ni claves privadas.

.EXAMPLE
.\scripts\sign_windows.ps1 `
  -ApplicationExe .\dist\tenjinreader\tenjinreader-win_x64.exe `
  -SignToolPath 'C:\Program Files (x86)\Windows Kits\10\bin\<SDK>\x64\signtool.exe' `
  -CertificateThumbprint '<HUELLA_SHA1_DE_40_HEX>' `
  -TimestampUrl 'http://timestamp.digicert.com'

.EXAMPLE
.\scripts\sign_windows.ps1 `
  -InstallerExe ..\..\outputs\TenjinReader-1.6.1-Setup-x64.exe `
  -SignToolPath 'C:\Program Files (x86)\Windows Kits\10\bin\<SDK>\x64\signtool.exe' `
  -CertificateThumbprint '<HUELLA_SHA1_DE_40_HEX>' `
  -TimestampUrl 'http://timestamp.digicert.com'
#>

[CmdletBinding(SupportsShouldProcess = $true, DefaultParameterSetName = 'Application')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Application')]
    [ValidateNotNullOrEmpty()]
    [string] $ApplicationExe,

    [Parameter(Mandatory = $true, ParameterSetName = 'Installer')]
    [ValidateNotNullOrEmpty()]
    [string] $InstallerExe,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $SignToolPath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $CertificateThumbprint,

    [Parameter()]
    [ValidateSet('CurrentUser', 'LocalMachine')]
    [string] $CertificateStoreLocation = 'CurrentUser',

    [Parameter()]
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string] $CertificateStoreName = 'My',

    [Parameter()]
    [ValidateNotNull()]
    [uri] $TimestampUrl = 'http://timestamp.digicert.com',

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $ExpectedPublisher = 'Xihuitl Systems',

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $FileDescription = 'TenjinReader',

    [Parameter()]
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-SignTool {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Executable,

        [Parameter(Mandatory = $true)]
        [string[]] $Arguments,

        [Parameter(Mandatory = $true)]
        [string] $Operation
    )

    & $Executable @Arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "SignTool no pudo $Operation (código de salida $exitCode)."
    }
}

function Assert-SignedArtifact {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path,

        [Parameter(Mandatory = $true)]
        [string] $ExpectedThumbprint,

        [Parameter(Mandatory = $true)]
        [string] $SignTool
    )

    Invoke-SignTool `
        -Executable $SignTool `
        -Arguments @('verify', '/pa', '/all', '/v', $Path) `
        -Operation "verificar '$Path'"

    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "La firma de '$Path' no es válida: $($signature.StatusMessage)"
    }
    if ($null -eq $signature.SignerCertificate) {
        throw "La firma de '$Path' no contiene un certificado de firmante."
    }

    $actualThumbprint = $signature.SignerCertificate.Thumbprint.ToUpperInvariant()
    if ($actualThumbprint -ne $ExpectedThumbprint) {
        throw (
            "El certificado de '$Path' no coincide con la huella solicitada. " +
            "Esperada: $ExpectedThumbprint; encontrada: $actualThumbprint."
        )
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        throw "La firma de '$Path' no contiene un sello de tiempo verificable."
    }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'La firma Authenticode con SignTool solo se puede ejecutar en Windows.'
}

$resolvedSignTool = (Resolve-Path -LiteralPath $SignToolPath).ProviderPath
if (-not (Test-Path -LiteralPath $resolvedSignTool -PathType Leaf)) {
    throw "No se encontró SignTool en '$SignToolPath'."
}
if ([IO.Path]::GetFileName($resolvedSignTool) -ine 'signtool.exe') {
    throw "El archivo indicado por -SignToolPath debe llamarse 'signtool.exe'."
}

$inputPath = if ($PSCmdlet.ParameterSetName -eq 'Application') {
    $ApplicationExe
}
else {
    $InstallerExe
}
$artifactKind = if ($PSCmdlet.ParameterSetName -eq 'Application') {
    'ejecutable de la aplicación'
}
else {
    'instalador'
}

$resolvedInput = (Resolve-Path -LiteralPath $inputPath).ProviderPath
if (-not (Test-Path -LiteralPath $resolvedInput -PathType Leaf)) {
    throw "No se encontró el $artifactKind en '$inputPath'."
}
if ([IO.Path]::GetExtension($resolvedInput) -ine '.exe') {
    throw "El $artifactKind debe ser un archivo .exe."
}
if ((Get-Item -LiteralPath $resolvedInput).Length -eq 0) {
    throw "El $artifactKind está vacío."
}

$normalizedThumbprint = ($CertificateThumbprint -replace '\s', '').ToUpperInvariant()
if ($normalizedThumbprint -notmatch '^[0-9A-F]{40}$') {
    throw (
        '-CertificateThumbprint debe ser la huella SHA-1 de 40 caracteres ' +
        'hexadecimales que identifica al certificado en el almacén de Windows.'
    )
}

if (
    -not $TimestampUrl.IsAbsoluteUri -or
    $TimestampUrl.Scheme -notin @([Uri]::UriSchemeHttp, [Uri]::UriSchemeHttps)
) {
    throw '-TimestampUrl debe ser una URL absoluta HTTP o HTTPS de sello RFC 3161.'
}

$storePath = "Cert:\$CertificateStoreLocation\$CertificateStoreName"
if (-not (Test-Path -LiteralPath $storePath)) {
    throw "No existe el almacén de certificados '$storePath'."
}

$matchingCertificates = @(
    Get-ChildItem -LiteralPath $storePath |
        Where-Object { $_.Thumbprint.ToUpperInvariant() -eq $normalizedThumbprint }
)
if ($matchingCertificates.Count -ne 1) {
    throw (
        "Se esperaba exactamente un certificado con huella $normalizedThumbprint " +
        "en '$storePath'; se encontraron $($matchingCertificates.Count)."
    )
}

$certificate = $matchingCertificates[0]
$now = Get-Date
if ($now -lt $certificate.NotBefore -or $now -gt $certificate.NotAfter) {
    throw (
        "El certificado no está vigente. Periodo: " +
        "$($certificate.NotBefore.ToString('u')) a $($certificate.NotAfter.ToString('u'))."
    )
}
if (-not $certificate.HasPrivateKey) {
    throw 'El certificado seleccionado no tiene acceso a su clave privada.'
}

$codeSigningOid = '1.3.6.1.5.5.7.3.3'
$hasCodeSigningUsage = @(
    $certificate.EnhancedKeyUsageList |
        Where-Object { $_.ObjectId.Value -eq $codeSigningOid }
).Count -gt 0
if (-not $hasCodeSigningUsage) {
    throw 'El certificado seleccionado no permite firma de código.'
}

$actualPublisher = $certificate.GetNameInfo(
    [Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
)
if (
    -not [string]::Equals(
        $actualPublisher.Trim(),
        $ExpectedPublisher.Trim(),
        [StringComparison]::OrdinalIgnoreCase
    )
) {
    throw (
        "El certificado publica '$actualPublisher', no '$ExpectedPublisher'. " +
        'Los metadatos del EXE no pueden cambiar el editor mostrado por Windows.'
    )
}

$existingSignature = Get-AuthenticodeSignature -LiteralPath $resolvedInput
if ($null -ne $existingSignature.SignerCertificate -and -not $Force) {
    throw (
        "'$resolvedInput' ya contiene una firma. Revísala o usa -Force " +
        'de forma explícita para reemplazarla.'
    )
}

if (-not $PSCmdlet.ShouldProcess(
    $resolvedInput,
    "Firmar el $artifactKind como '$actualPublisher' y verificarlo"
)) {
    return
}

$identifier = [Guid]::NewGuid().ToString('N')
$directory = [IO.Path]::GetDirectoryName($resolvedInput)
$baseName = [IO.Path]::GetFileNameWithoutExtension($resolvedInput)
$temporaryPath = Join-Path $directory ".$baseName.signing-$identifier.exe"
$backupPath = Join-Path $directory ".$baseName.unsigned-backup-$identifier.exe"
$replacementCompleted = $false
$restorationCompleted = $false

try {
    Copy-Item -LiteralPath $resolvedInput -Destination $temporaryPath

    $signArguments = @(
        'sign',
        '/v',
        '/fd', 'SHA256',
        '/sha1', $normalizedThumbprint,
        '/s', $CertificateStoreName,
        '/tr', $TimestampUrl.AbsoluteUri,
        '/td', 'SHA256',
        '/d', $FileDescription
    )
    if ($CertificateStoreLocation -eq 'LocalMachine') {
        $signArguments += '/sm'
    }
    $signArguments += $temporaryPath

    Invoke-SignTool `
        -Executable $resolvedSignTool `
        -Arguments $signArguments `
        -Operation "firmar '$resolvedInput'"

    Assert-SignedArtifact `
        -Path $temporaryPath `
        -ExpectedThumbprint $normalizedThumbprint `
        -SignTool $resolvedSignTool

    [IO.File]::Replace($temporaryPath, $resolvedInput, $backupPath, $true)
    $replacementCompleted = $true

    Assert-SignedArtifact `
        -Path $resolvedInput `
        -ExpectedThumbprint $normalizedThumbprint `
        -SignTool $resolvedSignTool

    Remove-Item -LiteralPath $backupPath -Force
    Write-Host (
        "Firma Authenticode y sello RFC 3161 verificados para el " +
        "${artifactKind}: $resolvedInput"
    )
}
catch {
    $signingError = $_

    if ($replacementCompleted -and (Test-Path -LiteralPath $backupPath)) {
        try {
            [IO.File]::Replace($backupPath, $resolvedInput, $null, $true)
            $restorationCompleted = $true
        }
        catch {
            throw (
                "Falló la firma y tampoco se pudo restaurar automáticamente el original. " +
                "La copia de seguridad permanece en '$backupPath'. Error inicial: " +
                "$($signingError.Exception.Message) Error de restauración: " +
                "$($_.Exception.Message)"
            )
        }
    }

    throw $signingError
}
finally {
    if (Test-Path -LiteralPath $temporaryPath) {
        Remove-Item -LiteralPath $temporaryPath -Force
    }
    if (
        (Test-Path -LiteralPath $backupPath) -and
        (-not $replacementCompleted -or $restorationCompleted)
    ) {
        Remove-Item -LiteralPath $backupPath -Force
    }
}
