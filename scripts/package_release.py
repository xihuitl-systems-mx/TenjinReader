from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import re
import tarfile
import zipfile
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
OUTPUTS = PROJECT.parents[1] / "outputs"
PACKAGE_METADATA = json.loads((PROJECT / "package.json").read_text(encoding="utf-8"))
VERSION = PACKAGE_METADATA["version"]
FIXED_ZIP_TIME = (2026, 7, 28, 12, 0, 0)

DOCUMENTS = [
    PROJECT / "LEEME.txt",
    PROJECT / "README.md",
    PROJECT / "LICENSE.txt",
    PROJECT / "THIRD_PARTY_NOTICES.md",
]

SOURCE_FILES = [
    PROJECT / "package.json",
    PROJECT / "package-lock.json",
    PROJECT / "neutralino.config.json",
    PROJECT / "vite.config.js",
    PROJECT / "index.html",
    *DOCUMENTS,
]

SOURCE_DIRECTORIES = [
    PROJECT / ".github",
    PROJECT / "docs",
    PROJECT / "src",
    PROJECT / "public",
    PROJECT / "test",
    PROJECT / "licenses",
    PROJECT / "installer",
    PROJECT / "scripts",
]

NATIVE_INSTALLERS = [
    OUTPUTS / f"Folentra-PDF-{VERSION}-x86_64.AppImage",
    OUTPUTS / f"Folentra-PDF-{VERSION}-universal.dmg",
]


def validate_release_metadata() -> None:
    neutralino = json.loads(
        (PROJECT / "neutralino.config.json").read_text(encoding="utf-8"),
    )
    if neutralino.get("version") != VERSION:
        raise RuntimeError(
            "package.json y neutralino.config.json no tienen la misma versión.",
        )

    installer_source = (PROJECT / "installer" / "PlumaReader.iss").read_text(
        encoding="utf-8",
    )
    expected_lines = [
        f'#define MyAppVersion "{VERSION}"',
        f'#define MySetupName "Folentra-PDF-{VERSION}-Setup-x64"',
        f"VersionInfoVersion={VERSION}.0",
    ]
    missing = [line for line in expected_lines if line not in installer_source]
    if missing:
        raise RuntimeError(
            "La versión del instalador no coincide con package.json: "
            + ", ".join(missing),
        )

    readme = (PROJECT / "README.md").read_text(encoding="utf-8")
    if not re.search(
        rf"Folentra-PDF-{re.escape(VERSION)}-Setup-x64\.exe",
        readme,
    ):
        raise RuntimeError("README.md no menciona el instalador de esta versión.")


def file_bytes(path: Path) -> bytes:
    if not path.is_file():
        raise FileNotFoundError(path)
    return path.read_bytes()


def zip_add_bytes(
    archive: zipfile.ZipFile,
    name: str,
    data: bytes,
    mode: int = 0o644,
) -> None:
    info = zipfile.ZipInfo(name.replace("\\", "/"), FIXED_ZIP_TIME)
    info.create_system = 3
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = mode << 16
    archive.writestr(info, data)


def add_release_documents_zip(archive: zipfile.ZipFile, root: str) -> None:
    for document in DOCUMENTS:
        zip_add_bytes(archive, f"{root}/{document.name}", file_bytes(document))
    for license_file in sorted((PROJECT / "licenses").iterdir()):
        zip_add_bytes(
            archive,
            f"{root}/licenses/{license_file.name}",
            file_bytes(license_file),
        )


def make_windows_zip() -> Path:
    binary = PROJECT / "dist" / "folentra-pdf" / "folentra-pdf-win_x64.exe"
    destination = OUTPUTS / f"Folentra-PDF-{VERSION}-Windows-x64.zip"
    root = "Folentra-PDF-Windows-x64"
    with zipfile.ZipFile(destination, "w") as archive:
        zip_add_bytes(
            archive,
            f"{root}/Folentra-PDF.exe",
            file_bytes(binary),
            0o755,
        )
        add_release_documents_zip(archive, root)
    return destination


def tar_add_bytes(
    archive: tarfile.TarFile,
    name: str,
    data: bytes,
    mode: int = 0o644,
) -> None:
    info = tarfile.TarInfo(name.replace("\\", "/"))
    info.size = len(data)
    info.mode = mode
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    archive.addfile(info, io.BytesIO(data))


def make_linux_tar(architecture: str) -> Path:
    source_name = f"folentra-pdf-linux_{architecture}"
    binary = PROJECT / "dist" / "folentra-pdf" / source_name
    label = "x64" if architecture == "x64" else "ARM64"
    root = f"Folentra-PDF-Linux-{label}"
    destination = OUTPUTS / f"Folentra-PDF-{VERSION}-Linux-{label}.tar.gz"
    with destination.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as archive:
                tar_add_bytes(
                    archive,
                    f"{root}/Folentra-PDF",
                    file_bytes(binary),
                    0o755,
                )
                for document in DOCUMENTS:
                    tar_add_bytes(
                        archive,
                        f"{root}/{document.name}",
                        file_bytes(document),
                    )
                for license_file in sorted((PROJECT / "licenses").iterdir()):
                    tar_add_bytes(
                        archive,
                        f"{root}/licenses/{license_file.name}",
                        file_bytes(license_file),
                    )
    return destination


def iter_source_files():
    for path in SOURCE_FILES:
        yield path, path.name
    for directory in SOURCE_DIRECTORIES:
        for path in sorted(directory.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                yield path, path.relative_to(PROJECT).as_posix()


def make_source_zip() -> Path:
    destination = OUTPUTS / f"Folentra-PDF-{VERSION}-Source.zip"
    root = "Folentra-PDF-Source"
    with zipfile.ZipFile(destination, "w") as archive:
        for path, relative_name in iter_source_files():
            zip_add_bytes(
                archive,
                f"{root}/{relative_name}",
                file_bytes(path),
                0o755 if path.suffix == ".py" else 0o644,
            )
    return destination


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def checked_installer() -> Path | None:
    installer = OUTPUTS / f"Folentra-PDF-{VERSION}-Setup-x64.exe"
    if not installer.is_file():
        return None

    installer_inputs = [
        PROJECT / "dist" / "folentra-pdf" / "folentra-pdf-win_x64.exe",
        PROJECT / "installer" / "PlumaReader.iss",
        PROJECT / "installer" / "FolentraPDF.ico",
        PROJECT / "installer" / "PdfDocument.ico",
        PROJECT / "installer" / "PdfDocument.png",
        PROJECT / "installer" / "PptxDocument.ico",
        PROJECT / "installer" / "PptxDocument.png",
        PROJECT / "installer" / "PdfDocument-original.png",
        PROJECT / "public" / "icon.png",
        PROJECT / "public" / "icon.svg",
        PROJECT / "scripts" / "make_installer_icon.mjs",
        *DOCUMENTS,
        *sorted((PROJECT / "licenses").iterdir()),
    ]
    newest_input = max(installer_inputs, key=lambda path: path.stat().st_mtime_ns)
    if installer.stat().st_mtime_ns < newest_input.stat().st_mtime_ns:
        raise RuntimeError(
            "El instalador existente está desactualizado. Vuelve a compilar "
            f"{PROJECT / 'installer' / 'PlumaReader.iss'} antes de empaquetar."
        )
    return installer


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Empaqueta Folentra PDF y genera sus sumas SHA-256.",
    )
    parser.add_argument(
        "--require-native-installers",
        action="store_true",
        help="Falla si el AppImage o el DMG de la versión no están en outputs.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    validate_release_metadata()
    OUTPUTS.mkdir(parents=True, exist_ok=True)
    artifacts = [
        make_windows_zip(),
        make_linux_tar("x64"),
        make_linux_tar("arm64"),
        make_source_zip(),
    ]
    installer = checked_installer()
    if installer is not None:
        artifacts.insert(1, installer)

    missing_native = [path for path in NATIVE_INSTALLERS if not path.is_file()]
    if args.require_native_installers and missing_native:
        raise RuntimeError(
            "Faltan instaladores nativos: "
            + ", ".join(path.name for path in missing_native),
        )
    artifacts.extend(path for path in NATIVE_INSTALLERS if path.is_file())

    checksum_path = OUTPUTS / "SHA256SUMS.txt"
    checksum_path.write_text(
        "".join(f"{sha256(path)}  {path.name}\n" for path in artifacts),
        encoding="utf-8",
        newline="\n",
    )
    for path in [*artifacts, checksum_path]:
        print(f"{path.name}\t{path.stat().st_size}\t{sha256(path)}")


if __name__ == "__main__":
    main()
