"""Static file serving for ``fairbeam serve --ui <dir>`` (the built web app, Vite ``dist/``).

The web app and the API then share one origin, which is what the desktop shell and
``fairbeam app`` load. Rules:

- only files inside the UI folder are served (resolved paths, no ``..``, no dot-files, no NUL);
- no directory listings: a directory serves its ``index.html`` or nothing;
- unknown paths without a file extension fall back to ``index.html`` (single-page app);
  unknown paths *with* an extension are 404, so a missing script never turns into HTML;
- hashed build assets (``/assets/...``) are cacheable for a year, everything else revalidates;
- ``/projects/...`` is served from the live projects folder (runs write there), not from the
  copy Vite made at build time.
"""

from __future__ import annotations

import mimetypes
import re
from pathlib import Path
from urllib.parse import unquote

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
    ".bas": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
}
IMMUTABLE = "public, max-age=31536000, immutable"
REVALIDATE = "no-cache"
_HASHED = re.compile(r"[-.][A-Za-z0-9_-]{8,}\.[a-z0-9]+$")


def content_type(path: Path) -> str:
    return MIME.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _inside(root: Path, rel: str) -> Path | None:
    """``root/rel`` if it is a regular file (or directory) inside ``root``; ``None`` otherwise."""
    if "\x00" in rel or "\\" in rel:
        return None
    parts = [p for p in rel.split("/") if p]
    if any(p in (".", "..") or p.startswith(".") for p in parts):
        return None
    try:
        target = root.joinpath(*parts).resolve()
    except (OSError, ValueError):
        return None
    if target != root and root not in target.parents:
        return None
    return target


def resolve(ui_root: Path, projects_root: Path | None, url_path: str) -> tuple[Path | None, str]:
    """Map a URL path to a file. Returns ``(file, cache_control)``; ``file`` is ``None`` for 404."""
    path = unquote(url_path.split("?", 1)[0].split("#", 1)[0])
    if not path.startswith("/"):
        return None, REVALIDATE
    ui_root = ui_root.resolve()
    if projects_root is not None and (path == "/projects" or path.startswith("/projects/")):
        target = _inside(projects_root.resolve(), path[len("/projects"):])
        if target is not None and target.is_file() and target.suffix.lower() == ".json":
            return target, REVALIDATE
        return None, REVALIDATE
    target = _inside(ui_root, path)
    if target is not None and target.is_dir():
        target = target / "index.html"
    if target is not None and target.is_file():
        rel = path.lstrip("/")
        cache = IMMUTABLE if rel.startswith("assets/") and _HASHED.search(rel) else REVALIDATE
        return target, cache
    last = path.rstrip("/").rsplit("/", 1)[-1]
    if "." in last:  # a missing asset, not an app route
        return None, REVALIDATE
    index = ui_root / "index.html"
    return (index if index.is_file() else None), REVALIDATE
