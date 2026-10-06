"""Find the user's Blender and report its version (rendering through Blender, docs/RENDER-BLENDER.md).

Search order: the path chosen in General settings, the FAIRBEAM_BLENDER environment variable, PATH, then the
platform's usual install folder (Windows: the newest ``%ProgramFiles%\\Blender Foundation\\Blender *``;
macOS: /Applications/Blender.app; Linux: ``blender`` on PATH, /snap/bin, /usr/local/bin). Blender 3.6 or newer is
required, 4.x preferred. Blender is only ever started in the background (``-b``); a Blender window the user has
open is never touched.
"""

from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

MIN_VERSION = (3, 6)
DOWNLOAD_URL = "https://www.blender.org/download/"
VERSION_RE = re.compile(r"Blender\s+(\d+)\.(\d+)(?:\.(\d+))?([^\r\n]*)")


def parse_version(text: str) -> dict | None:
    """``{"version": "4.2.3", "tuple": (4, 2, 3), "label": "4.2.3 LTS"}`` from the output of ``blender -v``."""
    m = VERSION_RE.search(text or "")
    if not m:
        return None
    major, minor, patch = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
    suffix = m.group(4).strip()
    version = f"{major}.{minor}.{patch}"
    return {"version": version, "tuple": (major, minor, patch), "label": f"{version} {suffix}".strip()}


def _version_key(path: str) -> tuple:
    """Sort key for ``Blender 4.2`` style folder names (newest last)."""
    m = re.search(r"Blender\s+(\d+)(?:\.(\d+))?", path)
    return (int(m.group(1)), int(m.group(2) or 0)) if m else (0, 0)


def windows_candidates(env: dict | None = None) -> list[str]:
    env = os.environ if env is None else env
    found: list[str] = []
    for var in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"):
        base = env.get(var)
        if base:
            found += glob.glob(os.path.join(base, "Blender Foundation", "Blender *", "blender.exe"))
    unique = sorted(set(os.path.normpath(p) for p in found), key=_version_key, reverse=True)
    return unique


def candidates(configured: str | None = None, env: dict | None = None, platform: str | None = None,
               which=shutil.which) -> list[tuple[str, str]]:
    """``[(source, path), ...]`` in search order (not yet checked for existence or version)."""
    env = os.environ if env is None else env
    platform = platform or sys.platform
    out: list[tuple[str, str]] = []
    if configured and configured.strip():
        out.append(("settings", configured.strip().strip('"')))
    if env.get("FAIRBEAM_BLENDER", "").strip():
        out.append(("env", env["FAIRBEAM_BLENDER"].strip().strip('"')))
    on_path = which("blender")
    if on_path:
        out.append(("path", on_path))
    if platform == "win32":
        out += [("install", p) for p in windows_candidates(env)]
    elif platform == "darwin":
        out.append(("install", "/Applications/Blender.app/Contents/MacOS/Blender"))
    else:
        out += [("install", p) for p in ("/snap/bin/blender", "/usr/local/bin/blender", "/usr/bin/blender")]
    return out


def normalise_executable(path: str) -> str:
    """A folder or a macOS .app bundle is accepted too: the executable inside is used."""
    p = Path(path)
    if p.is_dir():
        if p.suffix == ".app":
            return str(p / "Contents" / "MacOS" / "Blender")
        for name in ("blender.exe", "blender", "Blender"):
            if (p / name).is_file():
                return str(p / name)
    return str(p)


def query_version(path: str, timeout: float = 30.0) -> dict | None:
    """Run ``blender -v`` (no window, no scene) and parse the version; None if it does not look like Blender."""
    try:
        proc = subprocess.run([path, "-v"], capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return None
    text = (proc.stdout or b"").decode("utf-8", "replace") + (proc.stderr or b"").decode("utf-8", "replace")
    return parse_version(text)


def detect(configured: str | None = None, *, env: dict | None = None, platform: str | None = None,
           which=shutil.which, version=query_version, exists=os.path.isfile) -> dict:
    """The first usable Blender: ``{"found": bool, "path", "source", "version", "label", "ok", "message", ...}``.

    ``ok`` is False when a Blender was found but is older than 3.6 (``found`` stays True so the UI can say
    which version it is). ``configured`` that does not work is reported (``configured_error``) and the search goes on.
    """
    tried: list[dict] = []
    first_old: dict | None = None
    for source, raw in candidates(configured, env, platform, which):
        path = normalise_executable(raw)
        if not exists(path):
            tried.append({"source": source, "path": raw, "error": "not found"})
            continue
        info = version(path)
        if not info:
            tried.append({"source": source, "path": path, "error": "not a Blender executable"})
            continue
        result = {"found": True, "path": path, "source": source, "version": info["version"],
                  "label": info["label"], "major": info["tuple"][0], "minor": info["tuple"][1],
                  "ok": tuple(info["tuple"][:2]) >= MIN_VERSION, "download_url": DOWNLOAD_URL, "tried": tried}
        if result["ok"]:
            if configured and source != "settings":
                result["configured_error"] = next((t["error"] for t in tried if t["source"] == "settings"), None)
            return result
        first_old = first_old or result
    if first_old:
        first_old["message"] = f"Blender {first_old['version']} is older than {MIN_VERSION[0]}.{MIN_VERSION[1]}"
        return first_old
    return {"found": False, "path": None, "source": None, "version": None, "label": None, "ok": False,
            "message": "Blender was not found", "download_url": DOWNLOAD_URL, "tried": tried}
