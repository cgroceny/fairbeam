"""Build the relocatable macOS arm64 openEMS pack for the managed runtime (docs/DESKTOP.md).

There is no official openEMS binary for macOS (and none on PyPI or conda-forge). This script turns
a local source build (scripts/install-openems-macos.sh: ~/opt/openEMS with its venv) into
``openems-macos-arm64-<version>.tar.gz`` containing three cp313 wheels:

  CSXCAD-...-cp313-cp313-macosx_<min>_arm64.whl     the CSXCAD Python package
  openEMS-...-cp313-cp313-macosx_<min>_arm64.whl    the openEMS Python package (incl. nf2ff)
  fairbeam_openems_libs-...whl                      every non-system dylib they load, once

Both packages load the same library copies from site-packages/fairbeam_openems_libs (a single
libCSXCAD shared by CSXCAD and openEMS, as they pass C++ objects to each other). Install names are
rewritten to @loader_path, the binaries are thinned to arm64 and ad-hoc signed.

    python3 scripts/build-openems-macos-pack.py [--prefix ~/opt/openEMS] [--out dist-runtime]

Only file copying and Mach-O edits: nothing is compiled.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

LIBS_PKG = "fairbeam_openems_libs"
SYSTEM = ("/usr/lib/", "/System/")


def sh(*args: str) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def deps(binary: Path) -> list[str]:
    """Load commands (LC_LOAD_DYLIB) of the arm64 slice, without the binary's own id."""
    out = sh("otool", "-arch", "arm64", "-L", str(binary)).splitlines()[1:]
    names = [line.strip().split(" (")[0] for line in out if line.strip()]
    own = sh("otool", "-arch", "arm64", "-D", str(binary)).splitlines()[1:]
    return [n for n in names if n not in [o.strip() for o in own]]


def rpaths(binary: Path) -> list[str]:
    out = sh("otool", "-arch", "arm64", "-l", str(binary))
    return re.findall(r"cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (.+?) \(offset", out)


def resolve(name: str, loader: Path, loader_rpaths: list[str]) -> Path | None:
    if name.startswith("@loader_path/"):
        p = loader.parent / name[len("@loader_path/"):]
        return p.resolve() if p.exists() else None
    if name.startswith("@rpath/"):
        for rp in loader_rpaths:
            base = Path(rp.replace("@loader_path", str(loader.parent)))
            p = base / name[len("@rpath/"):]
            if p.exists():
                return p.resolve()
        return None
    p = Path(name)
    return p.resolve() if p.exists() else None


def is_system(name: str) -> bool:
    return name.startswith(SYSTEM)


def collect(roots: list[Path]) -> dict[str, Path]:
    """All non-system dylibs reachable from `roots`: {file name: real path}."""
    found: dict[str, Path] = {}
    todo = list(roots)
    seen: set[Path] = set()
    while todo:
        b = todo.pop()
        if b in seen:
            continue
        seen.add(b)
        rps = rpaths(b)
        for name in deps(b):
            if is_system(name):
                continue
            real = resolve(name, b, rps)
            if real is None:
                raise SystemExit(f"cannot resolve {name} (needed by {b})")
            base = Path(name).name
            if base in found and found[base] != real:
                raise SystemExit(f"two different libraries named {base}: {found[base]} and {real}")
            found[base] = real
            todo.append(real)
    return found


def thin(path: Path) -> None:
    archs = sh("lipo", "-archs", str(path)).split()
    if archs != ["arm64"]:
        sh("lipo", str(path), "-thin", "arm64", "-output", str(path))


def rewrite(binary: Path, mapping: dict[str, str]) -> None:
    """Point every non-system load command at mapping[file name]; drop absolute rpaths."""
    os.chmod(binary, 0o755)
    for name in deps(binary):
        if is_system(name):
            continue
        sh("install_name_tool", "-change", name, mapping[Path(name).name], str(binary))
    for rp in rpaths(binary):
        if not rp.startswith("@"):
            sh("install_name_tool", "-delete_rpath", rp, str(binary))


def sign(path: Path) -> None:
    sh("codesign", "--force", "--sign", "-", str(path))


def record_line(root: Path, f: Path) -> str:
    data = f.read_bytes()
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"{f.relative_to(root).as_posix()},sha256={digest},{len(data)}"


def build_wheel(stage: Path, dist: str, version: str, tag: str, out: Path) -> Path:
    """Zip `stage` (package dirs + <dist>-<version>.dist-info) into a wheel with a fresh RECORD."""
    info = stage / f"{dist}-{version}.dist-info"
    info.mkdir(exist_ok=True)
    if not (info / "METADATA").exists():
        (info / "METADATA").write_text(f"Metadata-Version: 2.1\nName: {dist}\nVersion: {version}\n", encoding="utf-8")
    (info / "WHEEL").write_text(f"Wheel-Version: 1.0\nGenerator: fairbeam build-openems-macos-pack\n"
                                f"Root-Is-Purelib: false\nTag: {tag}\n", encoding="utf-8")
    for junk in ("RECORD", "INSTALLER", "REQUESTED", "direct_url.json"):
        (info / junk).unlink(missing_ok=True)
    files = sorted(p for p in stage.rglob("*") if p.is_file() and "__pycache__" not in p.parts)
    lines = [record_line(stage, f) for f in files] + [f"{info.name}/RECORD,,"]
    (info / "RECORD").write_text("\n".join(lines) + "\n", encoding="utf-8")
    whl = out / f"{dist}-{version}-{tag}.whl"
    with zipfile.ZipFile(whl, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files + [info / "RECORD"]:
            z.write(f, f.relative_to(stage).as_posix())
    return whl


BSL_1_0 = """Boost Software License - Version 1.0 - August 17th, 2003

Permission is hereby granted, free of charge, to any person or organization
obtaining a copy of the software and accompanying documentation covered by
this license (the "Software") to use, reproduce, display, distribute,
execute, and transmit the Software, and to prepare derivative works of the
Software, and to permit third-parties to whom the Software is furnished to
do so, all subject to the following:

The copyright notices in the Software and this entire statement, including
the above license grant, this restriction and the following disclaimer,
must be included in all copies of the Software, in whole or in part, and
all derivative works of the Software, unless such copies or derivative
works are solely in the form of machine-executable object code generated by
a source language processor.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT. IN NO EVENT
SHALL THE COPYRIGHT HOLDERS OR ANYONE DISTRIBUTING THE SOFTWARE BE LIABLE
FOR ANY DAMAGES OR OTHER LIABILITY, WHETHER IN CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
"""


NATIVE_CPU_PATCHES = (
    "macos/openems-cpu-phase-dispatch-12cd91de2.patch",
    "openems-cpu-upml-cursor.patch",
    "openems-cpu-upml-rows.patch",
)
NATIVE_CPU_MARK = b"OPENEMS_EXPERIMENTAL_CPU_PHASE_DISPATCH"


def native_cpu_info(libs: dict[str, Path]) -> dict | None:
    """The fairbeam native CPU patches (scripts/native-cpu, docs/CPU-OPTIMIZATION.md) when the
    libopenEMS being packed carries them (it contains their environment variable names), else None.
    Their SHA-256 values are the ones scripts/native-cpu/apply-macos.sh verified before the build."""
    lib = next((p for n, p in libs.items() if n.startswith("libopenEMS.")), None)
    if lib is None or NATIVE_CPU_MARK not in lib.read_bytes():
        return None
    base = Path(__file__).resolve().parent / "native-cpu"
    return {"patches": {name: hashlib.sha256((base / name).read_bytes()).hexdigest() for name in NATIVE_CPU_PATCHES},
            "default_on": "fairbeam sets the OPENEMS_EXPERIMENTAL_CPU_* variables on macOS unless FAIRBEAM_NATIVE_CPU=0"}


def git_head(repo: Path) -> str | None:
    try:
        return sh("git", "-C", str(repo), "rev-parse", "HEAD").strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def brew_version(formula: str) -> str | None:
    receipt = Path("/opt/homebrew/opt") / formula / "INSTALL_RECEIPT.json"
    try:
        return json.loads(receipt.read_text())["source"]["versions"]["stable"]
    except (OSError, KeyError, ValueError):
        return None


def write_licenses(dest: Path, src: Path, vtk_src: Path | None, libs: dict[str, Path], meta: dict) -> str:
    """Copy the license texts of everything in the pack to `dest` and return NOTICE.md text
    (components, versions, licenses, where the corresponding source is)."""
    dest.mkdir(parents=True, exist_ok=True)
    brew = Path("/opt/homebrew/opt")
    rows = []

    def add(name: str, version: str | None, license_: str, source: str, files: list[tuple[Path, str]], text: str | None = None):
        copied = []
        for f, as_name in files:
            if f.is_file():
                shutil.copy2(f, dest / as_name)
                copied.append(as_name)
        if text is not None:
            (dest / f"{name}-LICENSE.txt").write_text(text, encoding="utf-8")
            copied.append(f"{name}-LICENSE.txt")
        rows.append((name, version or "?", license_, source, copied))

    oems, csx, fp = git_head(src / "openEMS"), git_head(src / "CSXCAD"), git_head(src / "fparser")
    add("openEMS", f"{meta['openEMS']} (commit {oems})", "GPL-3.0-or-later",
        f"https://github.com/thliebig/openEMS/tree/{oems}", [(src / "openEMS" / "COPYING", "openEMS-COPYING.txt")])
    add("CSXCAD", f"{meta['CSXCAD']} (commit {csx})", "LGPL-3.0-or-later",
        f"https://github.com/thliebig/CSXCAD/tree/{csx}", [(src / "CSXCAD" / "COPYING", "CSXCAD-COPYING.txt")])
    add("fparser", f"4.5.1 (commit {fp})", "LGPL-3.0-or-later",
        f"https://github.com/thliebig/fparser/tree/{fp}",
        [(src / "fparser" / "docs" / "lgpl.txt", "fparser-lgpl.txt"), (src / "fparser" / "docs" / "gpl.txt", "fparser-gpl.txt")])
    add("TinyXML", "2.6.2 (openEMS-Project patches)", "Zlib", "https://sourceforge.net/projects/tinyxml/ and openEMS-Project/scripts/build_tinyxml.sh",
        [(src / "build-tinyxml" / "tinyxml" / "readme.txt", "tinyxml-readme.txt")])
    if any(n.startswith("libvtk") for n in libs):
        add("VTK", "9.7.0 (minimal build)", "BSD-3-Clause", "https://vtk.org/download/ (VTK-9.7.0.tar.gz)",
            [(vtk_src / "Copyright.txt", "VTK-Copyright.txt")] if vtk_src else [])
    add("HDF5", brew_version("hdf5"), "BSD-3-Clause (HDF5 license)", "https://github.com/HDFGroup/hdf5",
        [(brew / "hdf5" / "LICENSE", "HDF5-LICENSE.txt")])
    add("libaec", brew_version("libaec"), "BSD-2-Clause", "https://gitlab.dkrz.de/k202009/libaec",
        [(brew / "libaec" / "LICENSE.txt", "libaec-LICENSE.txt")])
    add("Boost", brew_version("boost"), "BSL-1.0", "https://www.boost.org/users/download/", [], text=BSL_1_0)
    add("GMP", brew_version("gmp"), "LGPL-3.0-or-later / GPL-2.0-or-later", "https://gmplib.org/",
        [(brew / "gmp" / "COPYING.LESSERv3", "GMP-COPYING.LESSERv3.txt"), (brew / "gmp" / "COPYING", "GMP-COPYING.txt")])
    add("MPFR", brew_version("mpfr"), "LGPL-3.0-or-later", "https://www.mpfr.org/",
        [(brew / "mpfr" / "COPYING.LESSER", "MPFR-COPYING.LESSER.txt"), (brew / "mpfr" / "COPYING", "MPFR-COPYING.txt")])

    ncpu = meta.get("native_cpu")
    if ncpu:
        provenance = [
            "This pack redistributes binaries built from the sources below (macOS arm64). openEMS carries",
            "three source patches from the fairbeam project (GPL-3.0-or-later like openEMS): extension-phase",
            "dispatch, a UPML SSE cursor and UPML row pointers. They change the schedule and the memory",
            "addressing of the CPU engine, not its arithmetic, and are active only while the",
            "`OPENEMS_EXPERIMENTAL_CPU_*` environment variables are set (fairbeam sets them on macOS unless",
            "`FAIRBEAM_NATIVE_CPU=0`). The patches are in `scripts/native-cpu/` of the fairbeam project and",
            "are covered by the written offer of source below. They are applied to the openEMS commit",
            "below by `scripts/native-cpu/apply-macos.sh`; their SHA-256 values:",
            *[f"`{n}` {h}" for n, h in ncpu["patches"].items()], "",
            "The other changes to the binaries are that their library install names point inside the pack",
        ]
    else:
        provenance = [
            "This pack redistributes binaries built from the unmodified sources below (macOS arm64). The only",
            "changes to the binaries are that their library install names point inside the pack",
        ]
    lines = [
        "# Third-party software in this openEMS pack", "",
        *provenance,
        "(`@loader_path`), they are thinned to arm64, and they carry an ad-hoc signature. Every library is",
        "a separate, replaceable dynamic library in `fairbeam_openems_libs/`. The license texts are in",
        "`licenses/`.", "",
        "**Corresponding source:** each component's source is available at the location listed, at the",
        "exact version or commit given. On request, the fairbeam maintainers also provide the complete",
        "corresponding source of the GPL and LGPL components for at least three years from this release.",
        "Contact them through https://github.com/ismailakdag/fairbeam-releases/issues.", "",
        "The build scripts are in the fairbeam project: `scripts/install-openems-macos.sh` builds the",
        "components, and `scripts/build-openems-macos-pack.py` makes this pack.", "",
        "| Component | Version | License | Source | License files |", "|---|---|---|---|---|",
    ]
    for name, version, lic, source, files in rows:
        lines.append(f"| {name} | {version} | {lic} | {source} | {', '.join(files) or '(see source)'} |")
    lines += ["", f"Libraries in this pack: {', '.join(sorted(libs))}", ""]
    notice = "\n".join(lines)
    (dest.parent / "NOTICE.md").write_text(notice, encoding="utf-8")
    return notice


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--prefix", default=str(Path.home() / "opt" / "openEMS"))
    ap.add_argument("--out", default="dist-runtime")
    ap.add_argument("--source", default=str(Path.home() / "opt" / "openems-src" / "openEMS-Project"),
                    help="the openEMS-Project checkout the build came from (license files, commits)")
    ap.add_argument("--vtk-source", default=str(Path.home() / "opt" / "openems-src" / "VTK-9.7.0"))
    a = ap.parse_args()
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise SystemExit("run this on macOS arm64")
    prefix = Path(a.prefix).expanduser().resolve()
    py = prefix / "venv" / "bin" / "python"
    site = Path(sh(str(py), "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])").strip())
    pyver = sh(str(py), "-c", "import sys; print(f'{sys.version_info[0]}{sys.version_info[1]}')").strip()
    tag_py = f"cp{pyver}"
    meta = json.loads(sh(str(py), "-c", "import json; from importlib import metadata as m; "
                                        "print(json.dumps({d: m.version(d) for d in ('CSXCAD', 'openEMS')}))"))
    macos_min = platform.mac_ver()[0].split(".")[0]  # Homebrew libraries target this macOS
    tag = f"{tag_py}-{tag_py}-macosx_{macos_min}_0_arm64"
    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    work = Path(tempfile.mkdtemp(prefix="oems-pack-"))
    try:
        wheels = []
        stages: dict[str, Path] = {}
        exts: list[tuple[Path, Path]] = []  # (extension module, its stage root)
        for dist, pkg in (("CSXCAD", "CSXCAD"), ("openEMS", "openEMS")):
            stage = work / dist
            shutil.copytree(site / pkg, stage / pkg, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            info = next(d for d in site.iterdir() if d.name.lower().startswith(dist.lower() + "-") and d.name.endswith(".dist-info"))
            shutil.copytree(info, stage / f"{dist}-{meta[dist]}.dist-info")
            stages[dist] = stage
            exts += [(so, stage) for so in sorted((stage / pkg).rglob("*.so"))]
        libs = collect([site / so.relative_to(stage) for so, stage in exts])
        print(f"{len(exts)} extension modules, {len(libs)} libraries:", ", ".join(sorted(libs)))

        lib_stage = work / "libs"
        lib_dir = lib_stage / LIBS_PKG
        lib_dir.mkdir(parents=True)
        (lib_dir / "__init__.py").write_text('"""Shared native libraries of the openEMS pack (fairbeam)."""\n', encoding="utf-8")
        for base, real in libs.items():
            dst = lib_dir / base
            shutil.copy2(real, dst)
            thin(dst)
            rewrite(dst, {b: f"@loader_path/{b}" for b in libs})
            sh("install_name_tool", "-id", f"@loader_path/{base}", str(dst))
            sign(dst)
        for so, stage in exts:
            thin(so)
            # site-packages/<pkg>/[sub/]x.so -> @loader_path/../[../]fairbeam_openems_libs/<lib>
            up = "/".join([".."] * (len(so.relative_to(stage).parts) - 1))
            rewrite(so, {b: f"@loader_path/{up}/{LIBS_PKG}/{b}" for b in libs})
            sign(so)

        ncpu = native_cpu_info(libs)
        if ncpu:
            meta["native_cpu"] = ncpu
        print("native CPU patches:", "yes (default on in fairbeam on macOS)" if ncpu else "no (unmodified openEMS)")
        vtk = Path(a.vtk_source).expanduser()
        notice = write_licenses(lib_dir / "licenses", Path(a.source).expanduser(), vtk if vtk.is_dir() else None, libs, meta)
        for dist, stage in stages.items():
            wheels.append(build_wheel(stage, dist, meta[dist], tag, work))
        wheels.append(build_wheel(lib_stage, LIBS_PKG, meta["openEMS"], tag, work))

        # no "+" (local version) in the release asset name
        v = meta["openEMS"]
        base = re.split(r"\.post|\.dev|\+", v)[0]
        local = v.split("+", 1)[1] if "+" in v else ""
        name = f"openems-macos-arm64-{base}" + (f"-{local}" if local else "") + ("-ncpu1" if ncpu else "")
        root = work / name
        root.mkdir()
        for w in wheels:
            shutil.move(str(w), root / w.name)
        shutil.copytree(lib_dir / "licenses", root / "licenses")
        (root / "NOTICE.md").write_text(notice, encoding="utf-8")
        (root / "openems-pack.json").write_text(json.dumps({
            "kind": "macos-pack", "openems": meta["openEMS"], "csxcad": meta["CSXCAD"], "python": tag_py,
            "macos_min": macos_min, "libraries": sorted(libs), "wheels": sorted(w.name for w in wheels),
            **({"native_cpu": ncpu} if ncpu else {}),
        }, indent=2), encoding="utf-8")
        archive = out / f"{name}.tar.gz"
        with tarfile.open(archive, "w:gz") as t:
            t.add(root, arcname=name)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        print(f"{archive}  {archive.stat().st_size / 1e6:.1f} MB  sha256 {digest}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
