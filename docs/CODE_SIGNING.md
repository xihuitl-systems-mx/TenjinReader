# Firma de código de Folentra PDF

## Lo que significa «Editor» en Windows

El texto **Editor** que muestra el Control de cuentas de usuario (UAC) procede
del certificado Authenticode y de su cadena de confianza. `CompanyName`,
`AppPublisher` y los demás metadatos del ejecutable no convierten a una
aplicación en un editor verificado.

Para que el instalador muestre exactamente **Xihuitl Systems**, el certificado
debe:

1. Ser de firma de código y estar encadenado a una autoridad pública que
   Windows confíe.
2. Haber validado legalmente a Xihuitl Systems.
3. Contener `Xihuitl Systems` como nombre de editor. Si el certificado usa una
   razón social más larga, Windows puede mostrar esa razón social completa.
4. Tener una clave privada disponible en hardware, en un servicio remoto o en
   otro mecanismo admitido por el proveedor.

Una firma válida elimina «Editor desconocido». Microsoft Defender SmartScreen
puede seguir avisando temporalmente a causa de la reputación de un archivo o
editor nuevo; firma y reputación no son la misma comprobación.

Fuentes oficiales de Microsoft:

- [Introducción a Authenticode](https://learn.microsoft.com/windows-hardware/drivers/install/authenticode)
- [Opciones para firmar aplicaciones de Windows](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options)
- [Referencia oficial de SignTool](https://learn.microsoft.com/windows/win32/seccrypto/signtool)

## Opciones reales

| Opción | Coste y requisitos | Editor visible | ¿Sirve para el instalador EXE actual? |
| --- | --- | --- | --- |
| Certificado OV/EV de organización | Es de pago. Requiere que una autoridad certificadora valide la organización y que la clave se custodie del modo exigido por ella. | El nombre legal validado; puede ser Xihuitl Systems solo si el certificado lo contiene. | Sí. Es la vía directa para el nombre propio en Authenticode. |
| [SignPath Foundation](https://signpath.org/) | Gratuito únicamente para proyectos de código abierto que [soliciten y obtengan aprobación](https://signpath.org/apply.html). Exige repositorio y compilación públicos, trazabilidad, controles de acceso, MFA, políticas y revisión de lanzamientos. La firma es remota; no entrega un certificado local. | **SignPath Foundation**, porque la fundación es el editor del proyecto bajo [sus condiciones](https://signpath.org/terms.html). | Puede producir un EXE confiable tras la aprobación, pero no muestra Xihuitl Systems. No se usa mediante este script local. |
| Certum Open Source Code Signing | El [producto vigente de Certum](https://www.certum.eu/en/code-signing-certificates/) no es gratuito. Requiere compra y [validación de identidad y del proyecto OSS](https://support.certum.eu/en/code-signing-required-documents/). | Identidad personal con la designación «Open Source Developer», no una marca empresarial elegida libremente. | Puede firmar Authenticode después de comprarlo y validarlo, pero no resuelve el nombre exacto Xihuitl Systems. |
| Certificado autofirmado | Crear el certificado es gratuito, pero cada equipo debe instalarlo manualmente como raíz de confianza. | Puede mostrar el CN elegido únicamente en equipos que ya confían en ese certificado. | Solo es apropiado para pruebas o equipos internos administrados. No proporciona confianza pública. |
| Microsoft Store con MSIX | Microsoft vuelve a firmar el MSIX aceptado. Requiere cuenta, verificación del editor, empaquetado MSIX y certificación de la aplicación. | El editor validado en Microsoft Store. | Es otra vía de distribución; no firma ni corrige el instalador Inno Setup EXE existente. |

No existe una firma pública, gratuita y local que permita escribir
arbitrariamente **Xihuitl Systems** como editor verificado. Tampoco existe en
este repositorio un certificado, una cuenta aprobada o una firma ya emitida.
No se deben incluir certificados, PIN, contraseñas ni tokens en el código
fuente.

## Prerrequisitos para la firma local de Windows

- Windows 10 u 11.
- `signtool.exe`, instalado con Windows SDK.
- Un certificado Authenticode público, vigente y con uso extendido de firma de
  código (`1.3.6.1.5.5.7.3.3`).
- El certificado visible en `Cert:\CurrentUser\My` o
  `Cert:\LocalMachine\My`, con acceso a su clave privada.
- Una URL RFC 3161 indicada por la autoridad certificadora.
- Acceso al token, HSM o proveedor criptográfico del certificado. El script no
  solicita ni conserva su PIN.

El flujo de GitHub incluido admite un PFX solo cuando el proveedor permite
exportarlo. Los certificados públicos OV nuevos suelen custodiar la clave en
un HSM, token o servicio remoto; en ese caso hay que sustituir ese paso por la
integración oficial del proveedor. Una publicación etiquetada falla si no
puede comprobar una firma Authenticode válida, para impedir que se publique un
instalador con «Editor desconocido».

Para inspeccionar certificados disponibles sin revelar secretos:

```powershell
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
    Select-Object Subject, Thumbprint, NotBefore, NotAfter, HasPrivateKey
```

La huella del certificado no es una clave privada, pero se configura
explícitamente para evitar que SignTool elija otro certificado por accidente.

## Uso seguro de `scripts/sign_windows.ps1`

El script firma un artefacto por ejecución. Trabaja sobre una copia temporal,
usa SHA-256 para el archivo y el sello RFC 3161, ejecuta
`signtool verify /pa /all /v` y comprueba también:

- que el certificado seleccionado está vigente;
- que permite firma de código y tiene una clave privada;
- que su nombre simple es exactamente el de `-ExpectedPublisher`;
- que la firma final usa la huella solicitada;
- que existe un certificado de sello de tiempo;
- que el archivo original se conserva si algo falla.

No se sobrescribe una firma existente salvo que se indique `-Force`.
`-WhatIf` permite validar todos los prerrequisitos sin firmar.

### 1. Leer la versión y fijar las variables

Desde la raíz del proyecto:

```powershell
$version = (Get-Content -LiteralPath .\package.json -Raw |
    ConvertFrom-Json).version

$signTool = 'C:\Program Files (x86)\Windows Kits\10\bin\<VERSION_SDK>\x64\signtool.exe'
$thumbprint = '<HUELLA_SHA1_DE_40_HEX>'
$timestamp = 'http://timestamp.digicert.com'
$application = '.\dist\folentra-pdf\folentra-pdf-win_x64.exe'
$installer = "..\..\outputs\Folentra-PDF-$version-Setup-x64.exe"
```

La URL anterior es solo un ejemplo conocido. En producción se debe usar la
URL RFC 3161 indicada por el proveedor del certificado.

### 2. Firmar el ejecutable de la aplicación

```powershell
.\scripts\sign_windows.ps1 `
    -ApplicationExe $application `
    -SignToolPath $signTool `
    -CertificateThumbprint $thumbprint `
    -TimestampUrl $timestamp `
    -ExpectedPublisher 'Xihuitl Systems'
```

### 3. Compilar el instalador

El instalador debe compilarse **después** de firmar la aplicación. De ese modo,
el ejecutable que Inno Setup incorpora ya contiene su firma. Si se vuelve a
compilar la aplicación, hay que repetir la firma antes de recrear el
instalador.

La firma del desinstalador generado por Inno Setup requiere además configurar
el SignTool nombrado por la receta de Inno para que use el mismo certificado.

### 4. Firmar el instalador final

Para la versión leída de `package.json` (actualmente 1.6.1):

```powershell
.\scripts\sign_windows.ps1 `
    -InstallerExe $installer `
    -SignToolPath $signTool `
    -CertificateThumbprint $thumbprint `
    -TimestampUrl $timestamp `
    -ExpectedPublisher 'Xihuitl Systems'
```

Si el certificado está en el almacén del equipo, se agrega:

```powershell
-CertificateStoreLocation LocalMachine
```

El acceso a una clave privada del almacén `LocalMachine` puede requerir una
terminal elevada, dependiendo del proveedor.

### 5. Verificación independiente

```powershell
& $signTool verify /pa /all /v $application
& $signTool verify /pa /all /v $installer

Get-AuthenticodeSignature -LiteralPath $application |
    Select-Object Status, SignerCertificate, TimeStamperCertificate
Get-AuthenticodeSignature -LiteralPath $installer |
    Select-Object Status, SignerCertificate, TimeStamperCertificate
```

No se debe publicar un artefacto si alguna verificación falla.

## macOS: Developer ID es un sistema distinto

`signtool.exe` y Authenticode no firman aplicaciones de macOS. Para distribuir
fuera de Mac App Store sin advertencias de Gatekeeper se necesita:

1. Una membresía vigente del Apple Developer Program; no es gratuita.
2. Un certificado **Developer ID Application** emitido al equipo validado.
3. Firmar con `codesign`, usando Hardened Runtime y los permisos mínimos.
4. Enviar el artefacto a notarización con `notarytool`, esperar la aprobación y
   adjuntar el ticket cuando corresponda.

El nombre de equipo o entidad lo controla la cuenta validada por Apple; no se
puede sustituir por una marca arbitraria desde los metadatos de la aplicación.

Fuentes oficiales de Apple:

- [Developer ID](https://developer.apple.com/developer-id/)
- [Comparación de membresías](https://developer.apple.com/support/compare-memberships/)
- [Crear certificados Developer ID](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [Notarizar software para macOS](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
