# TenjinReader

TenjinReader es una aplicación de escritorio portátil y ligera para Windows,
Linux y macOS. Lee PDF, permite añadir ediciones sencillas y abre PPT, PPTX,
ODP y ODF en modo de solo lectura. Todo el documento se procesa localmente.

## Funciones

- PDF: navegación, zoom, ajuste a ventana, búsqueda y selección de texto.
- PDF escaneados: decodificación local OpenJPEG para imágenes JPEG 2000
  (`JPXDecode`), incluidas digitalizaciones antiguas o no conformes.
- Formularios PDF: rellenar y modificar de forma nativa campos AcroForm de
  texto, casillas, opciones y listas, conservándolos interactivos al guardar.
- Creación de formularios: dibujar nuevos cuadros de texto rellenables con la
  herramienta **Campo AcroForm** y conservarlos interactivos en otros lectores.
- Edición PDF: añadir texto, resaltados y trazos; borrar anotaciones pendientes,
  girar o eliminar páginas y deshacer.
- El indicador circular junto al tamaño refleja siempre el color de edición
  seleccionado, incluida la herramienta de firma visible.
- Organización PDF: reordenar, añadir y eliminar páginas; unir, dividir y
  comprimir documentos con optimización sin pérdida. **Dividir PDF** muestra el
  total, la miniatura de todas las páginas y los archivos resultantes antes de
  ejecutar la división.
- Seguridad PDF: proteger documentos con una contraseña AES-256 o quitar la
  protección tras autenticarse, siempre mediante procesamiento local.
- Firma visible: dibujar una firma manuscrita sobre la página antes de guardar.
- Conversión del PDF abierto a Word, PowerPoint o imágenes JPG. Word conserva
  el texto extraíble para editarlo y PowerPoint conserva la apariencia como una
  imagen por diapositiva.
- Conversión local de Word, PowerPoint y Excel a PDF mediante LibreOffice, y de
  imágenes JPG a PDF directamente en TenjinReader.
- Conversión de PDF a PDF/A-4 desde la ventana inicial, como copia visual de
  archivo con perfil de color sRGB integrado.
- **Guardar** actualiza el archivo abierto en la aplicación de escritorio. La
  flecha contigua despliega **Guardar como** para crear otra copia y el nombre
  visible se puede editar haciendo clic sobre él. Al guardar un PDF renombrado,
  se cambia el nombre del mismo archivo; las presentaciones se renombran en su
  carpeta original al confirmar el nuevo nombre.
- PPT, PPTX, ODP y ODF: visualización fiel, navegación y zoom sin posibilidad de
  edición, y conversión del archivo abierto a PDF; todos usan el icono naranja
  de presentaciones al asociarse al sistema.
- Apertura con el selector, arrastrando un archivo o pasándolo como argumento al
  ejecutable.
- Sin telemetría, cuentas, servicios remotos ni conexión a Internet.

## Uso

### Windows

La opción recomendada es ejecutar
`TenjinReader-1.6.1-Setup-x64.exe`. Al comenzar puedes elegir entre instalar
para **todos los usuarios** o **solo para ti**. El primer modo solicita
permisos de administrador y usa `C:\Program Files\TenjinReader` por defecto; el
segundo no solicita permisos y usa la carpeta de programas del usuario.
Después, el asistente siempre permite cambiar la carpeta de destino. También
crea un desinstalador, y los accesos directos son opcionales.

Si ya tenías una instalación para un solo usuario y quieres cambiar al modo de
todos los usuarios, desinstala primero la copia anterior para evitar conservar
dos instalaciones.

En la última pantalla puedes marcar **Elegir TenjinReader como lector
predeterminado**. Windows abrirá su panel de aplicaciones predeterminadas para
que confirmes TenjinReader para `.pdf` y, si quieres, `.ppt`, `.pptx`, `.odp` u
`.odf`. El instalador registra todas esas opciones, pero nunca reemplaza tus
asociaciones actuales sin confirmación.

También puedes descomprimir el paquete portátil y ejecutar
`TenjinReader.exe`; esa versión no se instala.

La versión de Windows requiere Windows 10 u 11 de 64 bits y Microsoft Edge
WebView2 Runtime, que normalmente ya está instalado en esos sistemas.

### Linux x64

La opción recomendada es descargar `TenjinReader-1.6.1-x86_64.AppImage`,
marcarlo como ejecutable y abrirlo:

```sh
chmod +x TenjinReader-1.6.1-x86_64.AppImage
./TenjinReader-1.6.1-x86_64.AppImage
```

La aplicación usa WebKitGTK del sistema. En una distribución mínima puede ser
necesario instalar `libwebkit2gtk-4.1-0` o el paquete equivalente.

El paquete `.tar.gz` sigue disponible como alternativa portátil. En ese caso,
descomprímelo, marca `TenjinReader` como ejecutable y ejecútalo directamente.

### macOS

El proceso de publicación genera `TenjinReader-1.6.1-universal.dmg` en un host
macOS. El paquete incluye una aplicación universal para Apple Silicon e Intel.
Ábrelo y arrastra **TenjinReader** a **Applications**.

Un DMG creado sin una identidad **Developer ID Application** queda sin firma y
sin notarización. Gatekeeper puede bloquearlo. La distribución pública sin
esa advertencia requiere una cuenta vigente de Apple Developer, firma con
Hardened Runtime y notarización de Apple.

## Alcance de la edición

Los campos interactivos AcroForm se editan de forma nativa y permanecen
rellenables en la copia guardada. Para convertir un recuadro dibujado en el PDF
en un campo nuevo, elige **Campo AcroForm**, arrastra sobre la zona y guarda la
copia. El cuadro se convierte en un campo de texto real que puede rellenarse
en TenjinReader y en lectores PDF compatibles.

Las demás ediciones son visuales: al guardar, TenjinReader añade el texto, los
resaltados y los trazos al PDF y aplica los cambios de página. No sustituye ni
refluye el texto original del documento. Las anotaciones guardadas quedan
integradas en la copia resultante.

El visor de presentaciones prioriza la fidelidad y el funcionamiento local. En
la aplicación de escritorio, PPT, PPTX, ODP y ODF se convierten con LibreOffice
a una vista PDF de solo lectura, lo que mantiene la posición del texto y las
imágenes sin refluirlos al cambiar el tamaño o el zoom. La vista se reutiliza
solamente mientras coincidan la ruta, el tamaño y la fecha de modificación del
original; por eso una segunda apertura evita iniciar LibreOffice. La caché local
se poda a un máximo de 32 vistas o 1 GiB. El perfil de conversión temporal sí se
elimina al cerrar el documento. PPTX dispone además de un visor interno de
respaldo; PPT, ODP y ODF requieren una instalación local de LibreOffice.
**Convertir** guarda directamente esa vista fiel como PDF sin volver a
convertirla. Animaciones, vídeo, audio, macros y transiciones no se reproducen,
y nunca se habilitan herramientas de edición para estos formatos.

Los PDF no tienen un límite de tamaño fijado por TenjinReader. El visor solicita
rangos de 1 MiB según los necesita y no precarga automáticamente el archivo
completo, lo que acelera la primera apertura y reduce los picos de memoria. El
límite práctico sigue dependiendo de la memoria, el disco, el WebView y la
estructura interna del documento. Las operaciones que reescriben o convierten
un PDF sí necesitan materializarlo y pueden requerir más memoria que leerlo.
Los decodificadores OpenJPEG/JBIG2 necesarios para libros escaneados se incluyen
en la aplicación y no se descargan de Internet.

La búsqueda de texto procesa como máximo dos páginas simultáneas, conserva el
orden de resultados y reutiliza una caché LRU limitada a 16 MiB. Los recursos de
página se liberan después de extraer el texto y los cambios de tamaño que no
alteran el área visible no vuelven a renderizar el documento.

La compresión es estructural y sin pérdida: conserva texto, enlaces y
formularios, pero un PDF ya optimizado puede no reducirse. La firma incluida es
una marca manuscrita visible, no una firma digital criptográfica. Al unir o
añadir páginas externas, TenjinReader rechaza documentos con AcroForms, XFA o firmas
digitales para no dañarlos.

**Proteger PDF** cifra el contenido con AES-256 y exige una contraseña de al
menos ocho caracteres. **Desbloquear PDF** elimina el cifrado cuando se
proporciona una contraseña con permisos suficientes; algunos archivos requieren
la contraseña de propietario. Estas operaciones conservan páginas y AcroForms,
pero necesitan cargar el PDF completo en memoria. No se admite cifrado mediante
certificados y se rechazan PDF firmados digitalmente, porque cambiar su cifrado
invalidaría la firma. TenjinReader no almacena la contraseña ni puede recuperar
un archivo si se pierde.

La conversión a Word usa texto extraíble y no incluye OCR; la conversión a
PowerPoint crea diapositivas visualmente fieles pero rasterizadas. Convertir
Word, PowerPoint o Excel a PDF requiere una instalación local de LibreOffice.
El texto añadido al PDF usa una fuente latina ligera; si contiene emoji,
cirílico o CJK, el guardado se detiene con un aviso en lugar de cambiar los
caracteres silenciosamente.

La conversión a PDF/A-4 rasteriza cada página para crear una copia visual PDF
2.0 independiente, declara PDF/A-4 y embebe el perfil sRGB. Por diseño, el texto
deja de ser seleccionable o editable; formularios, enlaces, comentarios y
multimedia se aplanan; y las firmas digitales y los adjuntos del original no se
transfieren. Esta salida se comprobó con el perfil PDF/A-4 de veraPDF durante el
desarrollo; un flujo de archivo regulado debe validar también cada documento
final con sus propias políticas.

## Atajos

- `Ctrl+O`: abrir
- `Ctrl+S`: guardar
- `Ctrl+Mayús+S`: guardar como
- `Ctrl+Z`: deshacer
- `V`, `T`, `F`, `H`, `D`, `E`: seleccionar, texto, campo AcroForm,
  resaltado, dibujo y borrador
- `R`: rotar la página actual 90° a la derecha
- Flechas o `RePág`/`AvPág`: página anterior/siguiente
- `+`, `-`, `0`: ampliar, reducir, ajustar

## Desarrollo

Requiere Node.js 20.19 o posterior.

```sh
npm ci
npm test
npx --no-install neu update
npm run build:app
```

`npm run build:app` crea binarios portátiles mediante Neutralinojs. Las
dependencias que se ejecutan dentro de la aplicación pasan
`npm audit --omit=dev` sin vulnerabilidades conocidas en esta versión.

El instalador de Windows requiere Inno Setup 7. Genera primero el icono y
compila el script:

```powershell
node scripts\make_installer_icon.mjs
ISCC.exe installer\TenjinReader.iss
```

Para que Windows muestre **Editor: Xihuitl Systems**, tanto el ejecutable como
el instalador deben firmarse con un certificado Authenticode de confianza cuyo
titular sea Xihuitl Systems. El script de Inno activa la firma del instalador y
del desinstalador al compilar con `SIGN_RELEASE` y un SignTool llamado
`xihuitl`; el ejecutable de la aplicación debe firmarse antes de compilar el
instalador.

Los paquetes nativos de Linux y macOS se crean en sus sistemas correspondientes:

```sh
bash scripts/build_appimage.sh
bash scripts/build_macos_dmg.sh
```

El flujo `.github/workflows/release.yml` compila y valida los tres formatos en
Windows, Ubuntu y macOS. La firma solo se activa cuando se proporcionan
credenciales válidas mediante secretos; los paquetes sin credenciales se
identifican expresamente como no firmados en compilaciones manuales. Una
publicación etiquetada se detiene si Windows no tiene Authenticode válido o si
macOS no tiene Developer ID y notarización. Consulta `docs/CODE_SIGNING.md`
para los requisitos, incluidos los certificados con HSM o firma remota.

## Licencia

El código propio se distribuye bajo la licencia MIT. Consulta
`THIRD_PARTY_NOTICES.md` para las dependencias incluidas.
