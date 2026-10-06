"""Fairbeam managed runtime, stage 2 (see docs/DESKTOP.md).

Runs with the runtime's own venv Python, created by stage 1 (setup-runtime.sh / setup-runtime.ps1),
and uses only the standard library. It
  1. downloads the pinned openEMS build for this platform (runtime/pins.json), verifies its SHA-256,
     and unpacks it to <root>/openEMS,
  2. installs the pinned Python dependencies (runtime/requirements.txt, hashes required) and the
     openEMS / CSXCAD wheels shipped with that build into <root>/venv, with the runtime's uv,
  3. copies the bundled fairbeam package to <root>/app and points the venv at it (fairbeam.pth),
  4. checks that `import CSXCAD, openEMS, fairbeam` works, and writes <root>/manifest.json.

Progress goes to stdout as lines ``FAIRBEAM-PROGRESS {"step": ..., "fraction": 0..1, "message": ...}``;
errors go to stderr with a non-zero exit code.

    python install.py --runtime-root R --resources RES [--engine cpu|gpu] [--repair] [--app-only] [--openems-archive FILE]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import traceback
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

MARKER = "fairbeam runtime v1"
STAMP = ".fairbeam-openems.json"  # in <root>/openEMS: which archive it was unpacked from


def progress(step: str, fraction: float | None = None, message: str = "") -> None:
    ev = {"step": step, "message": message}
    if fraction is not None:
        ev["fraction"] = round(max(0.0, min(1.0, fraction)), 4)
    print("FAIRBEAM-PROGRESS " + json.dumps(ev), flush=True)


def fail(msg: str, code: int = 1):
    print(f"Fairbeam runtime: error: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def platform_key() -> str:
    m = platform.machine().lower()
    if sys.platform == "win32" and m in ("amd64", "x86_64"):
        return "windows-x64"
    if sys.platform == "darwin" and m == "arm64":
        return "macos-arm64"
    fail(f"unsupported platform: {sys.platform}/{m} (supported: windows-x64, macos-arm64)")


def venv_python(root: Path) -> Path:
    return root / "venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def uv_exe(root: Path) -> Path:
    return root / "uv" / ("uv.exe" if sys.platform == "win32" else "uv")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _retry_windows_file_operation(operation, *, attempts=21, delay=0.1):
    """Retry a file operation briefly when Windows reports a transient lock."""
    if attempts < 1:
        raise ValueError("attempts must be at least 1")
    for attempt in range(attempts):
        try:
            return operation()
        except OSError as e:
            if (sys.platform != "win32" or getattr(e, "winerror", None) not in (5, 32, 33)
                    or attempt == attempts - 1):
                raise
            time.sleep(delay)


def download(url: str, dest: Path, digest: str, size: int | None, step: str) -> Path:
    """Download to ``dest`` (resumable only by re-downloading); keep a verified copy for retries.
    A cached file with the wrong hash (truncated, corrupted) is downloaded again."""
    if dest.exists():
        if sha256(dest) == digest:
            progress(step, 1.0, f"{dest.name} already downloaded")
            return dest
        progress(step, 0.0, f"{dest.name} in the download cache is damaged; downloading it again")
        _retry_windows_file_operation(dest.unlink)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "fairbeam-runtime"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r, _retry_windows_file_operation(
                lambda: open(part, "wb")) as f:
            total = int(r.headers.get("Content-Length") or size or 0)
            done, last = 0, 0.0
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if time.time() - last > 0.25:
                    last = time.time()
                    progress(step, done / total if total else None, f"{done / 1e6:.0f} / {total / 1e6:.0f} MB")
    except (urllib.error.URLError, OSError, TimeoutError) as e:  # HTTPError is a URLError
        _retry_windows_file_operation(lambda: part.unlink(missing_ok=True))
        reason = getattr(e, "reason", None) or e
        fail(f"could not download {url}: {reason}. Check the internet connection (or proxy) and retry.")
    got = sha256(part)
    if got != digest:
        _retry_windows_file_operation(lambda: part.unlink(missing_ok=True))
        fail(f"{url}: SHA-256 mismatch (expected {digest}, got {got})")
    _retry_windows_file_operation(lambda: os.replace(part, dest))
    progress(step, 1.0, f"{dest.name} verified")
    return dest


def _in_use(path: Path, e: OSError):
    fail(f"cannot replace {path}: {e.strerror or e}. A file in it is in use: quit Fairbeam "
         "(or stop `fairbeam serve`) and retry.")


def unpack_openems(archive: Path, kind: str, root: Path, digest: str) -> Path:
    """Unpack to <root>/openEMS so that the openEMS binaries sit directly in it. Skipped when that
    folder already holds this archive (``STAMP``), so a re-run does not unpack 150 MB again."""
    target = root / "openEMS"
    stamp = target / STAMP
    try:
        if json.loads(stamp.read_text(encoding="utf-8")).get("sha256") == digest:
            progress("unpack-openems", 1.0, f"{target} is up to date")
            return target
    except (OSError, ValueError):
        pass
    progress("unpack-openems", None, archive.name)
    tmp = Path(tempfile.mkdtemp(prefix="openEMS-", dir=root))
    try:
        if kind == "msvc-zip":
            with zipfile.ZipFile(archive) as z:
                z.extractall(tmp)
            exe = next(tmp.rglob("openEMS.exe"), None)
            if exe is None:
                fail(f"{archive.name}: openEMS.exe not found in the archive")
            top = exe.parent
        elif kind == "macos-pack":
            with tarfile.open(archive) as t:
                t.extractall(tmp, filter="data")
            marker = next(tmp.rglob("openems-pack.json"), None)
            if marker is None:
                fail(f"{archive.name}: not a Fairbeam macOS openEMS pack (openems-pack.json missing)")
            top = marker.parent
        else:
            fail(f"unknown openEMS artifact kind {kind!r}")
        if target.exists():
            try:
                _retry_windows_file_operation(lambda: shutil.rmtree(target))
            except OSError as e:  # Windows: a running server has the openEMS DLLs loaded
                _in_use(target, e)
        _retry_windows_file_operation(lambda: os.replace(top, target))
        _retry_windows_file_operation(
            lambda: (target / STAMP).write_text(json.dumps({"archive": archive.name, "sha256": digest}),
                                                 encoding="utf-8"))
    finally:
        try:
            _retry_windows_file_operation(lambda: shutil.rmtree(tmp))
        except OSError:
            pass
    progress("unpack-openems", 1.0, str(target))
    return target


def run(cmd: list, step: str, root: Path) -> None:
    progress(step, None, " ".join(str(c) for c in cmd[:4]) + (" ..." if len(cmd) > 4 else ""))
    r = subprocess.run([str(c) for c in cmd], capture_output=True, encoding="utf-8", errors="replace",
                       env=child_env(root), stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        fail(f"{step} failed ({r.returncode}):\n{(r.stdout + r.stderr)[-4000:]}")
    progress(step, 1.0, "")


def site_packages(py: Path, root: Path) -> Path:
    out = subprocess.run([str(py), "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
                         capture_output=True, encoding="utf-8", env=child_env(root), check=True).stdout.strip()
    return Path(out)


def install_app(root: Path, resources: Path, py: Path) -> str:
    """Copy the bundled fairbeam package to <root>/app and point the venv at it."""
    src = resources / "python" / "fairbeam"
    if not (src / "__init__.py").exists():
        fail(f"bundled Fairbeam package not found at {src}")
    app = root / "app"
    new = root / "app.new"
    try:
        _retry_windows_file_operation(lambda: shutil.rmtree(new))
    except FileNotFoundError:
        pass
    except OSError as e:
        _in_use(new, e)
    shutil.copytree(src, new / "fairbeam", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    try:
        _retry_windows_file_operation(lambda: shutil.rmtree(app))
    except FileNotFoundError:
        pass
    except OSError as e:
        _in_use(app, e)
    _retry_windows_file_operation(lambda: os.replace(new, app))
    # site.py reads .pth files as UTF-8 first (3.13), so non-ASCII profile paths work
    pth = site_packages(py, root) / "fairbeam.pth"
    _retry_windows_file_operation(lambda: pth.write_text(str(app) + "\n", encoding="utf-8"))
    meta = {}
    exec((app / "fairbeam" / "_meta.py").read_text(encoding="utf-8"), meta)
    return str(meta.get("__version__", "?"))


def child_env(root: Path) -> dict:
    """Environment for the runtime's own tools: nothing of the user's Python/uv setup leaks in
    (a PYTHONPATH to another fairbeam, a uv.toml index, a global uv cache), and output is UTF-8."""
    env = {k: v for k, v in os.environ.items()
           if not k.upper().startswith("UV_") and k.upper() not in ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV")}
    env["OPENEMS_INSTALL_PATH"] = str(root / "openEMS")  # DLL lookup on Windows (fairbeam/__init__.py)
    env["PYTHONIOENCODING"] = "utf-8"
    env["UV_NO_CONFIG"] = "1"
    env["UV_CACHE_DIR"] = str(root / "cache")
    env["UV_PYTHON_INSTALL_DIR"] = str(root / "python")
    return env


def verify(py: Path, root: Path) -> dict:
    code = ("import json, CSXCAD, openEMS, fairbeam; from importlib import metadata as m; "
            "print(json.dumps({'openems': m.version('openEMS'), 'csxcad': m.version('CSXCAD'), "
            "'fairbeam': fairbeam.__version__}))")
    r = subprocess.run([str(py), "-c", code], capture_output=True, encoding="utf-8", errors="replace",
                       env=child_env(root), stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        fail("the runtime does not import openEMS/CSXCAD/fairbeam:\n" + r.stderr[-4000:])
    progress("verify", 1.0, "")
    return json.loads(r.stdout.strip().splitlines()[-1])


def gpu_engine_listed(output: str) -> bool:
    """Whether openEMS --help advertises the GPU engine used by the Windows CUDA package."""
    return any(line.lstrip().startswith("gpu:") for line in output.splitlines())


def select_openems_pin(pins: dict, key: str, engine: str) -> tuple[dict, dict]:
    """Select the CPU or optional GPU artifact without changing the CPU pin."""
    group = pins["openems_gpu"] if engine == "gpu" else pins["openems"]
    return group, group.get(key) or {}


def verify_gpu_engine(root: Path) -> None:
    exe = root / "openEMS" / "openEMS.exe"
    try:
        result = subprocess.run([str(exe), "--help"], capture_output=True, encoding="utf-8", errors="replace",
                                env=child_env(root), stdin=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as e:
        fail(f"could not check the GPU openEMS engine: {e}")
    if not gpu_engine_listed(result.stdout + result.stderr):
        fail(f"{exe} does not advertise the GPU engine; the GPU runtime was not published")


def write_manifest(root: Path, manifest: dict) -> None:
    tmp = root / "manifest.json.tmp"
    _retry_windows_file_operation(lambda: tmp.write_text(json.dumps(manifest, indent=2), encoding="utf-8"))
    target = root / "manifest.json"
    _retry_windows_file_operation(lambda: os.replace(tmp, target))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--runtime-root", required=True)
    ap.add_argument("--resources", required=True, help="folder with runtime/, python/ (the app's bundled resources)")
    ap.add_argument("--repair", action="store_true", help="re-download and reinstall openEMS and the packages")
    ap.add_argument("--app-only", action="store_true", help="only refresh the Fairbeam package (app update)")
    ap.add_argument("--engine", choices=("cpu", "gpu"), default="cpu",
                    help="install the CPU runtime or the optional Windows GPU runtime")
    ap.add_argument("--openems-archive", help="use this local openEMS archive instead of downloading it")
    a = ap.parse_args()

    root = Path(a.runtime_root).resolve()
    res = Path(a.resources).resolve()
    pins = json.loads((res / "runtime" / "pins.json").read_text(encoding="utf-8"))
    key = platform_key()
    if a.engine == "gpu" and key != "windows-x64":
        fail("the managed GPU runtime is only available for Windows x64")
    if a.engine == "gpu" and not root.name.lower().startswith("gpu-runtime"):
        fail("the GPU runtime must use a dedicated folder named 'gpu-runtime'")
    if a.engine == "gpu" and (root / "manifest.json").exists():
        try:
            existing_manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            existing_manifest = None
        if existing_manifest and existing_manifest.get("marker") == MARKER and existing_manifest.get("engine") != "gpu":
            fail(f"refusing to replace a non-GPU runtime at {root}; choose a dedicated gpu-runtime folder")
    py = venv_python(root)
    uv = uv_exe(root)
    if not py.exists() or not uv.exists():
        fail(f"stage 1 incomplete: {py} or {uv} missing (run setup-runtime first)")

    if a.app_only:
        try:
            manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            fail(f"{root / 'manifest.json'} is missing or damaged: run the full install (setup-runtime)")
        progress("install-app", None, "fairbeam")
        version = install_app(root, res, py)
        manifest.update(fairbeam=version, updated=time.strftime("%Y-%m-%dT%H:%M:%S%z"))
        write_manifest(root, manifest)
        progress("done", 1.0, f"fairbeam {version}")
        return

    pin_group, pin = select_openems_pin(pins, key, a.engine)
    build_version = pin_group.get("version", "unknown")
    if a.openems_archive:
        archive = Path(a.openems_archive).resolve()
        if not archive.is_file():
            fail(f"{archive}: no such file")
        digest = sha256(archive)
        if pin.get("sha256") and digest != pin["sha256"]:
            fail(f"{archive}: SHA-256 does not match the pinned {a.engine} openEMS {build_version} "
                 f"(expected {pin['sha256']}, got {digest})")
    else:
        if not pin.get("url"):
            fail(f"no prebuilt {a.engine} openEMS for {key} yet ({pin.get('note', 'not pinned')}); "
                 "choose an existing openEMS installation in the app instead")
        archive = root / "downloads" / pin["url"].rsplit("/", 1)[-1]
        if a.repair:
            _retry_windows_file_operation(lambda: archive.unlink(missing_ok=True))
        download(pin["url"], archive, pin["sha256"], pin.get("size"), "download-openems")
        digest = pin["sha256"]
    # Keep a previously working runtime available when a download or hash check fails. Once a
    # verified archive is ready, remove the manifest before replacing files so startup cannot
    # select a half-installed runtime.
    manifest_path = root / "manifest.json"
    _retry_windows_file_operation(lambda: manifest_path.unlink(missing_ok=True))
    if a.repair:
        stamp = root / "openEMS" / STAMP
        _retry_windows_file_operation(lambda: stamp.unlink(missing_ok=True))

    try:
        unpacked_before = json.loads((root / "openEMS" / STAMP).read_text(encoding="utf-8")).get("sha256") == digest
    except (OSError, ValueError):
        unpacked_before = False
    oems = unpack_openems(archive, pin.get("kind", "msvc-zip" if key == "windows-x64" else "macos-pack"), root,
                          digest)

    tag = f"cp{sys.version_info.major}{sys.version_info.minor}"
    wheels = sorted(p for p in oems.rglob("*.whl") if tag in p.name)
    names = {w.name.split("-")[0].lower() for w in wheels}
    if not {"csxcad", "openems"} <= names:
        fail(f"no {tag} CSXCAD/openEMS wheels in the openEMS build (found: {[w.name for w in wheels]})")

    run([uv, "pip", "install", "--python", py, "--require-hashes", "-r", res / "runtime" / "requirements.txt"],
        "install-packages", root)
    # reinstall only when the build is new (or on repair): rewriting the wheels' 66 native libraries
    # makes macOS scan each of them again on the next import (seconds); otherwise uv skips them
    reinstall = ["--reinstall"] if a.repair or not unpacked_before else []
    run([uv, "pip", "install", "--python", py, "--no-deps", *reinstall, *wheels], "install-openems-wheels", root)
    progress("install-app", None, "fairbeam")
    version = install_app(root, res, py)
    progress("install-app", 1.0, f"fairbeam {version}")

    progress("verify", None, "import CSXCAD, openEMS, fairbeam")
    versions = verify(py, root)
    if a.engine == "gpu":
        if "+gpu" not in versions["openems"]:
            fail(f"the installed openEMS package is not the pinned GPU build ({versions['openems']})")
        verify_gpu_engine(root)
    manifest = {
        "marker": MARKER, "platform": key, "python": platform.python_version(),
        "engine": a.engine, "openems_build": build_version, **versions, "fairbeam": version,
        "installed": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    write_manifest(root, manifest)
    progress("done", 1.0, f"openEMS {versions['openems']}, fairbeam {version}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        fail("interrupted", 130)
    except Exception as e:  # noqa: BLE001 - the shell shows the last stderr line; keep the details above it
        traceback.print_exc()
        fail(f"unexpected {type(e).__name__}: {e}", 2)
