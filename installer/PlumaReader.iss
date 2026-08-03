#define MyAppName "Folentra PDF"
#define MyAppVersion "1.6.1"
#define MyAppPublisher "Xihuitl Systems"
#define MyAppExeName "Folentra-PDF.exe"
#define MySetupName "Folentra-PDF-1.6.1-Setup-x64"

[Setup]
AppId={{B6406115-8466-4D92-B8C8-F27044F24423}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppComments=Lector y editor PDF ligero con visor de presentaciones de solo lectura.
AppCopyright=Copyright (c) 2026 Xihuitl Systems
AppReadmeFile={app}\LEEME.txt
DefaultDirName={autopf}\Folentra PDF
DefaultGroupName=Folentra PDF
DisableDirPage=no
DisableProgramGroupPage=yes
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
UsePreviousPrivileges=no
MinVersion=10.0
SetupArchitecture=x64
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\..\outputs
OutputBaseFilename={#MySetupName}
SetupIconFile=FolentraPDF.ico
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
LicenseFile=..\LICENSE.txt
InfoBeforeFile=..\LEEME.txt
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
CloseApplicationsFilter={#MyAppExeName}
RestartApplications=no
ChangesAssociations=yes
ChangesEnvironment=no
VersionInfoVersion=1.6.1.0
VersionInfoProductVersion={#MyAppVersion}
VersionInfoProductName={#MyAppName}
VersionInfoDescription=Instalador de Folentra PDF
VersionInfoCompany={#MyAppPublisher}
#ifdef SIGN_RELEASE
SignTool=xihuitl
SignedUninstaller=yes
#endif

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "startmenu"; Description: "Crear accesos directos en el menú Inicio"; GroupDescription: "Accesos directos:"; Flags: checkedonce
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "Accesos directos:"; Flags: unchecked

[Files]
Source: "..\dist\folentra-pdf\folentra-pdf-win_x64.exe"; DestDir: "{app}"; DestName: "{#MyAppExeName}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LEEME.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\THIRD_PARTY_NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "PdfDocument.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "PptxDocument.ico"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
; Registra Folentra PDF como opción compatible sin sustituir las preferencias
; actuales. Windows conserva el control del lector predeterminado y confirma.
Root: HKA; Subkey: "Software\Folentra PDF"; Flags: uninsdeletekeyifempty
Root: HKA; Subkey: "Software\Folentra PDF\Capabilities"; ValueType: string; ValueName: "ApplicationName"; ValueData: "{#MyAppName}"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Folentra PDF\Capabilities"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "Lector y editor PDF ligero con visor de presentaciones de solo lectura."
Root: HKA; Subkey: "Software\Folentra PDF\Capabilities"; ValueType: string; ValueName: "ApplicationIcon"; ValueData: """{app}\{#MyAppExeName}"",0"
Root: HKA; Subkey: "Software\Folentra PDF\Capabilities\FileAssociations"; ValueType: string; ValueName: ".pdf"; ValueData: "FolentraPDF.PDF"
Root: HKA; Subkey: "Software\Folentra PDF\Capabilities\FileAssociations"; ValueType: string; ValueName: ".ppt"; ValueData: "FolentraPDF.PPTX"
Root: HKA; Subkey: "Software\Folentra PDF\Capabilities\FileAssociations"; ValueType: string; ValueName: ".pptx"; ValueData: "FolentraPDF.PPTX"
Root: HKA; Subkey: "Software\Folentra PDF\Capabilities\FileAssociations"; ValueType: string; ValueName: ".odp"; ValueData: "FolentraPDF.PPTX"
Root: HKA; Subkey: "Software\Folentra PDF\Capabilities\FileAssociations"; ValueType: string; ValueName: ".odf"; ValueData: "FolentraPDF.PPTX"
Root: HKA; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "{#MyAppName}"; ValueData: "Software\Folentra PDF\Capabilities"; Flags: uninsdeletevalue

Root: HKA; Subkey: "Software\Classes\FolentraPDF.PDF"; ValueType: string; ValueData: "Documento PDF de Folentra PDF"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\FolentraPDF.PDF\DefaultIcon"; ValueType: string; ValueData: """{app}\PdfDocument.ico"",0"
Root: HKA; Subkey: "Software\Classes\FolentraPDF.PDF\shell\open\command"; ValueType: string; ValueData: """{app}\{#MyAppExeName}"" ""%1"""

Root: HKA; Subkey: "Software\Classes\FolentraPDF.PPTX"; ValueType: string; ValueData: "Presentación de Folentra PDF"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\FolentraPDF.PPTX\DefaultIcon"; ValueType: string; ValueData: """{app}\PptxDocument.ico"",0"
Root: HKA; Subkey: "Software\Classes\FolentraPDF.PPTX\shell\open\command"; ValueType: string; ValueData: """{app}\{#MyAppExeName}"" ""%1"""

Root: HKA; Subkey: "Software\Classes\Applications\{#MyAppExeName}"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "{#MyAppName}"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\Applications\{#MyAppExeName}\SupportedTypes"; ValueType: string; ValueName: ".pdf"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\{#MyAppExeName}\SupportedTypes"; ValueType: string; ValueName: ".ppt"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\{#MyAppExeName}\SupportedTypes"; ValueType: string; ValueName: ".pptx"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\{#MyAppExeName}\SupportedTypes"; ValueType: string; ValueName: ".odp"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\{#MyAppExeName}\SupportedTypes"; ValueType: string; ValueName: ".odf"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\{#MyAppExeName}\shell\open\command"; ValueType: string; ValueData: """{app}\{#MyAppExeName}"" ""%1"""

Root: HKA; Subkey: "Software\Classes\.pdf\OpenWithProgids"; ValueType: string; ValueName: "FolentraPDF.PDF"; ValueData: ""; Flags: uninsdeletevalue uninsdeletekeyifempty
Root: HKA; Subkey: "Software\Classes\.ppt\OpenWithProgids"; ValueType: string; ValueName: "FolentraPDF.PPTX"; ValueData: ""; Flags: uninsdeletevalue uninsdeletekeyifempty
Root: HKA; Subkey: "Software\Classes\.pptx\OpenWithProgids"; ValueType: string; ValueName: "FolentraPDF.PPTX"; ValueData: ""; Flags: uninsdeletevalue uninsdeletekeyifempty
Root: HKA; Subkey: "Software\Classes\.odp\OpenWithProgids"; ValueType: string; ValueName: "FolentraPDF.PPTX"; ValueData: ""; Flags: uninsdeletevalue uninsdeletekeyifempty
Root: HKA; Subkey: "Software\Classes\.odf\OpenWithProgids"; ValueType: string; ValueName: "FolentraPDF.PPTX"; ValueData: ""; Flags: uninsdeletevalue uninsdeletekeyifempty

; Alias de compatibilidad: conserva archivos que ya apuntaban a los ProgID de
; Pluma Reader mientras Windows migra la preferencia al nuevo nombre.
Root: HKA; Subkey: "Software\Classes\PlumaReader.PDF"; ValueType: string; ValueData: "Documento PDF de Folentra PDF"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\PlumaReader.PDF\DefaultIcon"; ValueType: string; ValueData: """{app}\PdfDocument.ico"",0"
Root: HKA; Subkey: "Software\Classes\PlumaReader.PDF\shell\open\command"; ValueType: string; ValueData: """{app}\{#MyAppExeName}"" ""%1"""
Root: HKA; Subkey: "Software\Classes\PlumaReader.PPTX"; ValueType: string; ValueData: "Presentación de Folentra PDF"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\PlumaReader.PPTX\DefaultIcon"; ValueType: string; ValueData: """{app}\PptxDocument.ico"",0"
Root: HKA; Subkey: "Software\Classes\PlumaReader.PPTX\shell\open\command"; ValueType: string; ValueData: """{app}\{#MyAppExeName}"" ""%1"""

; Retira las entradas de descubrimiento antiguas, sin romper un UserChoice que
; todavía conserve el ProgID anterior (los alias de arriba lo siguen atendiendo).
Root: HKA; Subkey: "Software\RegisteredApplications"; ValueType: none; ValueName: "Pluma Reader"; Flags: deletevalue
Root: HKA; Subkey: "Software\Pluma Reader"; ValueType: none; Flags: deletekey
Root: HKA; Subkey: "Software\Classes\.pdf\OpenWithProgids"; ValueType: none; ValueName: "PlumaReader.PDF"; Flags: deletevalue
Root: HKA; Subkey: "Software\Classes\.pptx\OpenWithProgids"; ValueType: none; ValueName: "PlumaReader.PPTX"; Flags: deletevalue
Root: HKA; Subkey: "Software\Classes\Applications\Pluma-Reader.exe"; ValueType: none; Flags: deletekey

[Icons]
Name: "{group}\Folentra PDF"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: startmenu
Name: "{group}\Desinstalar Folentra PDF"; Filename: "{uninstallexe}"; Tasks: startmenu
Name: "{autodesktop}\Folentra PDF"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Ejecutar Folentra PDF"; WorkingDir: "{app}"; Flags: nowait postinstall runasoriginaluser skipifsilent
Filename: "ms-settings:defaultapps?registeredAppMachine=Folentra%20PDF"; Description: "Elegir Folentra PDF como lector predeterminado"; Flags: shellexec nowait postinstall runasoriginaluser skipifsilent unchecked; MinVersion: 10.0.22000; Check: IsAdminInstallMode
Filename: "ms-settings:defaultapps?registeredAppUser=Folentra%20PDF"; Description: "Elegir Folentra PDF como lector predeterminado"; Flags: shellexec nowait postinstall runasoriginaluser skipifsilent unchecked; MinVersion: 10.0.22000; Check: not IsAdminInstallMode
Filename: "ms-settings:defaultapps"; Description: "Elegir Folentra PDF como lector predeterminado"; Flags: shellexec nowait postinstall runasoriginaluser skipifsilent unchecked; OnlyBelowVersion: 10.0.22000

[InstallDelete]
Type: files; Name: "{app}\Pluma-Reader.exe"
Type: files; Name: "{autoprograms}\Pluma Reader\Pluma Reader.lnk"
Type: files; Name: "{autoprograms}\Pluma Reader\Desinstalar Pluma Reader.lnk"
Type: files; Name: "{autodesktop}\Pluma Reader.lnk"

[UninstallDelete]
Type: files; Name: "{app}\.tmp\window_state.config.json"
Type: dirifempty; Name: "{app}\.tmp"
