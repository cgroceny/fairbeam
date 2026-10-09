"""Managed Elmer FEM runtime: an optional, pinned download for the experimental Elmer backend.

The package is the official portable Windows build (no GUI, no MPI) from the Elmer download mirror.
It is downloaded only when the person asks for it, checked against the pinned size and SHA-256,
unpacked into the app's per-user data folder (``appstate.state_dir()/elmer/<version>``) and then
found by ``fairbeam_elmer.discover`` like any other Elmer package. Nothing runs during install.
Elmer is GPL-2.0-or-later (the solver library is LGPL-2.1-or-later); the package carries its license
texts under ``share/elmersolver/license_texts``. Source: https://github.com/ElmerCSC/elmerfem
(tag ``release-26.1``).
"""
from __future__ import annotations

import hashlib
import os
import shutil
import sys
import tempfile
import threading
import urllib.request
import zipfile
from pathlib import Path

from . import appstate

PIN = {
    "version": "26.1",
    "platform": "win32",
    "url": "https://www.nic.funet.fi/pub/sci/physics/elmer/bin/windows/rel26.1/ElmerFEM-nogui-nompi-Windows-AMD64-rel26.1.zip",
    "size": 129530276,
    "sha256": "8ce866cc6ff16a842f01edc1dc56c9a801cdd758210ec02cf1353398e6839455",
    "top": "ElmerFEM-nogui-nompi-Windows-AMD64",
    "source": "https://github.com/ElmerCSC/elmerfem/tree/release-26.1",
    "license": "GPL-2.0-or-later (ElmerSolver library LGPL-2.1-or-later)",
}
CHUNK = 1 << 20

_lock = threading.Lock()
_progress = {"state": "idle", "received": 0, "total": PIN["size"], "error": ""}


def supported() -> bool:
    return sys.platform == PIN["platform"]


def home() -> Path:
    """Where the managed package lives once installed."""
    return appstate.state_dir() / "elmer" / PIN["version"]


def installed() -> bool:
    bindir = home() / "bin"
    return all((bindir / f"{name}.exe").is_file() for name in ("ElmerSolver", "ElmerGrid"))


def status() -> dict:
    with _lock:
        progress = dict(_progress)
    return {"supported": supported(), "installed": installed(), "path": str(home()),
            "version": PIN["version"], "size": PIN["size"], "license": PIN["license"],
            "source": PIN["source"], **progress}


def _set(**fields) -> None:
    with _lock:
        _progress.update(fields)


def _download(url: str, target: Path) -> None:
    digest = hashlib.sha256()
    received = 0
    with urllib.request.urlopen(url, timeout=60) as response, open(target, "wb") as out:
        while chunk := response.read(CHUNK):
            received += len(chunk)
            if received > PIN["size"]:
                raise ValueError("the Elmer download is larger than the pinned package")
            digest.update(chunk)
            out.write(chunk)
            _set(received=received)
    if received != PIN["size"]:
        raise ValueError(f"the Elmer download is incomplete ({received} of {PIN['size']} bytes)")
    if digest.hexdigest() != PIN["sha256"]:
        raise ValueError("the Elmer download does not match the pinned SHA-256; nothing was installed")


def _unpack(archive: Path, staging: Path) -> Path:
    with zipfile.ZipFile(archive) as zf:
        for member in zf.namelist():
            parts = Path(member).parts
            if Path(member).is_absolute() or ".." in parts or parts[:1] != (PIN["top"],):
                raise ValueError(f"unexpected path in the Elmer package: {member}")
        zf.extractall(staging)
    root = staging / PIN["top"]
    for name in ("ElmerSolver", "ElmerGrid"):
        if not (root / "bin" / f"{name}.exe").is_file():
            raise ValueError(f"the Elmer package has no bin/{name}.exe")
    return root


def install(url: str | None = None) -> dict:
    """Download, verify and unpack the pinned package (blocking). Safe to call again: an existing
    install is kept, and a failed attempt leaves nothing behind."""
    if not supported():
        raise OSError("The managed Elmer package is available on Windows x64 only; on other systems "
                      "install Elmer yourself and enter its folder.")
    if installed():
        _set(state="done", received=PIN["size"], error="")
        return status()
    target = home()
    target.parent.mkdir(parents=True, exist_ok=True)
    _set(state="downloading", received=0, error="")  # also when called directly (CLI, tests)
    with tempfile.TemporaryDirectory(dir=target.parent, prefix=".elmer-") as tmp:
        work = Path(tmp)
        try:
            archive = work / "elmer.zip"
            _download(url or PIN["url"], archive)
            _set(state="unpacking")
            root = _unpack(archive, work / "unpacked")
            if target.exists():
                shutil.rmtree(target)  # a partial earlier attempt: installed() was False
            os.replace(root, target)
        except Exception as exc:
            _set(state="failed", error=str(exc))
            raise
    _set(state="done", received=PIN["size"], error="")
    return status()


def start_install() -> dict:
    """Run install() in the background (one at a time); poll status() for progress."""
    if not supported():
        raise OSError("The managed Elmer package is available on Windows x64 only.")
    with _lock:
        start = _progress["state"] not in ("downloading", "unpacking") and not installed()
        if start:
            _progress.update(state="downloading", received=0, error="")
    if start:
        threading.Thread(target=_safe_install, name="elmer-install", daemon=True).start()
    return status()


def _safe_install() -> None:
    try:
        install()
    except Exception:  # the error is kept in status()
        pass
