"""Rendered images of a design (the app's "Render image..." dialog): where they are saved and how.

The folder is ``<workspace>/renders/<design id>/``, next to ``models/`` and ``projects/``. The app
sends one PNG at a time (base64 in a JSON body); the server checks the name and the bytes, never
overwrites an existing file (a taken name gets ``-2``, ``-3``, ...), and can open the folder in the
system file manager. Nothing outside the renders folder is ever touched.

The Blender renderer (blender_job.py, ``/api/render-jobs``) writes its pictures and its optional
``.blend`` into the same folder (``render_dir``), with the same names, so both engines' results sit
together and one list / file / open-folder API serves them.
"""

from __future__ import annotations

import base64
import binascii
import os
import re
import subprocess
import sys
from pathlib import Path

RENDERS = "renders"
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.png$")
# a .blend saved next to the Blender pictures is listed and served too
BLEND_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.blend$")
RESERVED_RE = re.compile(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])$", re.I)
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
MAX_PNG = 48 * 1024 * 1024
MAX_LISTED = 200


class RenderError(Exception):
    """``status`` is the HTTP status the server answers with."""

    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra


def check_id(design_id) -> str:
    if not isinstance(design_id, str) or not ID_RE.match(design_id) or RESERVED_RE.match(design_id):
        raise RenderError(422, "invalid design id for a renders folder")
    return design_id


def check_name(name) -> str:
    stem = name[:-4] if isinstance(name, str) else ""
    if not isinstance(name, str) or not NAME_RE.match(name) or ".." in name or RESERVED_RE.match(stem.split(".")[0]):
        raise RenderError(422, "a render's file name uses letters, digits, . _ - and ends in .png")
    return name


def check_file(name) -> str:
    """A PNG or .blend name inside a renders folder (no separators, no dots-only parts, no reserved device names)."""
    if isinstance(name, str) and name.endswith(".blend"):
        if not BLEND_RE.match(name) or ".." in name or RESERVED_RE.match(name[:-6].split(".")[0]):
            raise RenderError(422, "a .blend file name uses letters, digits, . _ - and ends in .blend")
        return name
    return check_name(name)


def render_dir(workspace: Path, design_id: str, *, create: bool = False) -> Path:
    """``<workspace>/renders/<design id>``, refusing anything that would leave the workspace."""
    check_id(design_id)
    root = Path(workspace).resolve()
    folder = root / RENDERS / design_id
    if create:
        folder.mkdir(parents=True, exist_ok=True)
    resolved = folder.resolve()
    if root not in resolved.parents:
        raise RenderError(422, "the renders folder must be inside the workspace")
    return resolved


def unique_path(folder: Path, name: str) -> Path:
    """``name`` in ``folder``, or ``stem-2.png``, ``stem-3.png``... when it is taken."""
    target = folder / name
    n = 2
    stem = name[:-4]
    while target.exists():
        target = folder / f"{stem}-{n}.png"
        n += 1
    return target


def save_png(workspace: Path, design_id: str, name: str, data: bytes) -> Path:
    """Write a PNG into the design's renders folder, never over an existing file."""
    check_name(name)
    if not data.startswith(PNG_MAGIC):
        raise RenderError(422, "the data is not a PNG image")
    if len(data) > MAX_PNG:
        raise RenderError(413, "the image is too large")
    folder = render_dir(workspace, design_id, create=True)
    # exclusive create: two renders saved in the same instant cannot take the same name
    n = 1
    while True:
        target = folder / (name if n == 1 else f"{name[:-4]}-{n}.png")
        try:
            with open(target, "xb") as f:
                f.write(data)
            return target
        except FileExistsError:
            n += 1


def decode(data) -> bytes:
    if not isinstance(data, str):
        raise RenderError(422, "data must be the base64 of a PNG")
    try:
        return base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise RenderError(422, "data is not valid base64")


def list_renders(workspace: Path, design_id: str) -> dict:
    folder = render_dir(workspace, design_id)
    files = []
    if folder.is_dir():
        for p in folder.iterdir():
            if p.is_file() and (NAME_RE.match(p.name) or BLEND_RE.match(p.name)):
                st = p.stat()
                files.append({"name": p.name, "kind": "blend" if p.suffix == ".blend" else "png", "size": st.st_size, "mtime": st.st_mtime})
    files.sort(key=lambda f: f["mtime"], reverse=True)
    return {"id": design_id, "dir": str(folder), "files": files[:MAX_LISTED]}


def render_path(workspace: Path, design_id: str, name: str) -> Path:
    """An existing PNG or .blend directly inside the design's renders folder (404 otherwise)."""
    check_file(name)
    folder = render_dir(workspace, design_id)
    path = (folder / name).resolve()
    if path.parent != folder or not path.is_file():
        raise RenderError(404, "no such render")
    return path


def read_render(workspace: Path, design_id: str, name: str) -> bytes:
    return render_path(workspace, design_id, name).read_bytes()


def open_folder(workspace: Path, design_id: str) -> Path:
    """Open the design's renders folder in the system file manager (it is created when missing)."""
    folder = render_dir(workspace, design_id, create=True)
    if sys.platform == "win32":
        os.startfile(str(folder))  # noqa: S606 - a folder this module just validated
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(folder)])
    else:
        subprocess.Popen(["xdg-open", str(folder)])
    return folder
