"""Model files edited from the app: create from a template, read, save with optimistic
concurrency, keep a version history.

Used by the run server (``server.py``); no openEMS import here. Model files live in one folder
(``python/models``); nothing outside it is ever written. The bundled examples' sources are
read-only in the editor (duplicate them to change them), and their ids are reserved: no new model
or design may take one.
"""

from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import shutil
import time
from pathlib import Path

ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,40}$")
# Windows device names: con.py or aux.design.json cannot be created there (also with an
# extension), so no platform accepts them as ids (a model folder may move between systems)
RESERVED_ID_RE = re.compile(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])$")
RESERVED_ID_MSG = "a name Windows reserves for devices (con, prn, aux, nul, com0–9, lpt0–9)"
# The sources of the bundled examples, copied into the workspace's models folder: Python models
# (python/models/<id>.py) and the 867 MHz example designs (examples/designs/<id>.design.json).
BUNDLED_MODELS = frozenset({
    "branchline_coupler", "dipole", "helix_axial", "inset_patch", "lowpass_stepped",
    "microstrip_line", "minkowski_patch", "patch_antenna", "patch_array_2x1",
    "patch_array_4x1", "pyramidal_horn", "sierpinski_monopole", "wilkinson_divider",
})
BUNDLED_DESIGNS = frozenset({
    "collinear_867", "meander_dipole_867", "sleeve_dipole_867", "wideband_dipole_867", "yagi_867",
})
# Every id a bundled example uses (src/lib/designId.ts BUNDLED_EXAMPLE_IDS mirrors it). A model and a
# design share one key space, so no new file of either kind may take one, whether or not the
# example's file is in the models folder at the moment (it comes back with the next start or update).
BUNDLED = BUNDLED_MODELS | BUNDLED_DESIGNS
RESERVED_EXAMPLE_MSG = "reserved for a bundled example"
BUNDLED_PROJECT_FILES = frozenset({
    "branchline-coupler.json", "dipole.json", "helix-axial.json", "inset-patch.json",
    "lowpass-stepped.json", "microstrip-line.json", "minkowski-patch.json", "patch-antenna.json",
    "patch-array-2x1.json", "patch-array-4x1.json", "pyramidal-horn.json",
    "sierpinski-monopole--iterations-0.json", "sierpinski-monopole--iterations-3.json",
    "wilkinson-divider.json",
    "collinear-867.json", "meander-dipole-867.json", "sleeve-dipole-867.json",
    "wideband-dipole-867.json", "yagi-867.json",
})
MAX_SOURCE = 256 * 1024
HISTORY_KEEP = 50
DESIGN_SUFFIX = ".design.json"  # fairbeam.design: a model described as data, edited in the designer
DELETED_PREFIX = "deleted-"  # a deleted design, kept in its history folder


class ModelFileError(Exception):
    """``status`` is the HTTP status the server answers with."""

    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra


def source_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def check_id(model_id) -> str:
    if not isinstance(model_id, str) or not ID_RE.match(model_id):
        raise ModelFileError(422, "invalid model id", fields={
            "id": "2–41 characters: a lowercase letter, then lowercase letters, digits or _"})
    if RESERVED_ID_RE.match(model_id):
        raise ModelFileError(422, "invalid model id", fields={"id": RESERVED_ID_MSG})
    return model_id


def model_path(models_dir: Path, model_id: str) -> Path:
    """Path of ``<models_dir>/<id>.py``, guaranteed to be directly inside the models folder."""
    check_id(model_id)
    root = Path(models_dir).resolve()
    path = (root / f"{model_id}.py").resolve()
    if path.parent != root:
        raise ModelFileError(422, "model path outside the models folder")
    return path


def design_path(models_dir: Path, model_id: str) -> Path:
    """Path of ``<models_dir>/<id>.design.json``, directly inside the models folder."""
    check_id(model_id)
    root = Path(models_dir).resolve()
    path = (root / f"{model_id}{DESIGN_SUFFIX}").resolve()
    if path.parent != root:
        raise ModelFileError(422, "model path outside the models folder")
    return path


def _taken(models_dir: Path, model_id: str) -> bool:
    """A Python model and a design share one key space (the model key is the file name without
    its extension), so neither may reuse the other's id."""
    return model_path(models_dir, model_id).exists() or design_path(models_dir, model_id).exists()


def check_free(models_dir: Path, model_id: str) -> None:
    """Refuse an id for a new model or design (409): a bundled example's id, or one in use."""
    if model_id in BUNDLED:
        raise ModelFileError(409, f"{model_id} is {RESERVED_EXAMPLE_MSG}", fields={"id": RESERVED_EXAMPLE_MSG})
    if _taken(models_dir, model_id):
        raise ModelFileError(409, f"a model named {model_id} already exists", fields={"id": "already exists"})


def is_readonly(model_id: str, design: bool = False) -> bool:
    """A bundled example's own file: its Python model (``design`` False) or one of the example
    designs. A design made with a bundled model's id before the ids were reserved stays editable."""
    if design:
        return model_id in BUNDLED_DESIGNS
    return model_id in BUNDLED and model_id not in BUNDLED_DESIGNS


def is_readonly_file(name: str) -> bool:
    """is_readonly for a file name of the models folder (``dipole.py``, ``yagi_867.design.json``)."""
    design = name.endswith(DESIGN_SUFFIX)
    return is_readonly(name[: -len(DESIGN_SUFFIX)] if design else name.rsplit(".", 1)[0], design)


def set_model_identity(source: str, model_id: str, name: str | None) -> str:
    """Rewrite the ``"id"`` (and ``"name"``) string literals of the ``MODEL = {...}`` dict.

    Uses the AST positions, so comments and formatting are kept. If there is no literal MODEL dict
    the source is returned unchanged.
    """
    tree = ast.parse(source)
    lines = source.splitlines(keepends=True)
    edits: list[tuple[int, int, int, str]] = []  # (line, col, end_col, text), single-line literals only
    for node in tree.body:
        if not (isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "MODEL" for t in node.targets)):
            continue
        if not isinstance(node.value, ast.Dict):
            continue
        for k, v in zip(node.value.keys, node.value.values):
            if not (isinstance(k, ast.Constant) and isinstance(v, ast.Constant) and isinstance(v.value, str)):
                continue
            new = model_id.replace("_", "-") if k.value == "id" else name if k.value == "name" else None
            if new is None or v.lineno != v.end_lineno:
                continue
            edits.append((v.lineno, v.col_offset, v.end_col_offset, json.dumps(new, ensure_ascii=False)))
    for line, col, end, text in sorted(edits, reverse=True):
        raw = lines[line - 1].encode("utf-8")  # ast offsets are in UTF-8 bytes
        lines[line - 1] = (raw[:col] + text.encode("utf-8") + raw[end:]).decode("utf-8")
    return "".join(lines)


def _write_atomic(path: Path, text: str, exclusive: bool = False):
    # newline="\n": the same bytes on every platform (text mode on Windows would write CRLF)
    path.parent.mkdir(parents=True, exist_ok=True)
    if exclusive:
        # O_EXCL: fail instead of overwriting a file that appeared meanwhile
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        return
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    _replace(tmp, path)


def _retry_busy(action, tries: int = 40):
    """Run a rename-like ``action``. On Windows a rename fails with PermissionError (WinError 5 /
    32) while another process has the file open, for example the preview worker or a run reading
    it at that moment; such reads are short, so retry for up to 2 s."""
    for attempt in range(tries):
        try:
            return action()
        except PermissionError:
            if os.name != "nt" or attempt == tries - 1:
                raise
            time.sleep(0.05)


def _replace(tmp: Path, path: Path):
    """os.replace, retried while the target is busy (_retry_busy); the temporary file never stays."""
    try:
        _retry_busy(lambda: os.replace(tmp, path))
    except OSError:
        tmp.unlink(missing_ok=True)
        raise


def create_model(models_dir: Path, model_id: str, source: str, name: str | None) -> Path:
    path = model_path(models_dir, model_id)
    check_free(models_dir, model_id)
    try:
        text = set_model_identity(source, model_id, name)
    except SyntaxError:
        text = source  # a template with a syntax error is copied as is; validation reports it
    try:
        _write_atomic(path, text, exclusive=True)
    except FileExistsError:
        raise ModelFileError(409, f"a model named {model_id} already exists", fields={"id": "already exists"})
    return path



def read_model(models_dir: Path, model_id: str) -> dict:
    path = model_path(models_dir, model_id)
    if not path.exists():
        raise ModelFileError(404, f"no model {model_id}")
    text = path.read_text(encoding="utf-8")
    return {"id": model_id, "file": path.name, "source": text, "hash": source_hash(text),
            "readonly": is_readonly(model_id)}


def save_model(models_dir: Path, history_dir: Path, model_id: str, source, base_hash) -> dict:
    """Write new source if ``base_hash`` matches the file on disk; back up the previous version."""
    path = model_path(models_dir, model_id)
    if not path.exists():
        raise ModelFileError(404, f"no model {model_id}")
    if is_readonly(model_id):
        raise ModelFileError(403, f"{model_id} is a bundled example and read-only; duplicate it to edit")
    if not isinstance(source, str) or len(source.encode("utf-8")) > MAX_SOURCE:
        raise ModelFileError(422, f"source must be text of at most {MAX_SOURCE // 1024} KB")
    current = path.read_text(encoding="utf-8")
    current_hash = source_hash(current)
    if base_hash != current_hash:
        raise ModelFileError(409, "the file changed on disk since it was opened", current_hash=current_hash)
    if source == current:
        return {"hash": current_hash, "backup": None}
    backup = backup_version(history_dir, model_id, current)
    _write_atomic(path, source)
    return {"hash": source_hash(source), "backup": backup}


def _version_key(path: Path):
    parts = path.stem.split("-")
    if len(parts) < 2:
        return (path.stem, "", 0)
    return (parts[0], parts[1], int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 1)


def _versions(folder: Path) -> list[Path]:
    """Backups oldest first ("20260924-234501.py", "20260924-234501-2.py", ...)."""
    return sorted(folder.glob("*.py"), key=_version_key)


def backup_version(history_dir: Path, model_id: str, text: str, suffix: str = ".py") -> str:
    folder = Path(history_dir) / check_id(model_id)
    folder.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = f"{stamp}{suffix}"
    n = 1
    while (folder / name).exists():
        n += 1
        name = f"{stamp}-{n}{suffix}"
    _write_atomic(folder / name, text)
    # deleted designs ("deleted-<stamp>.design.json", see delete_design) are never pruned
    kept = _versions(folder) if suffix == ".py" else sorted(f for f in folder.glob(f"*{suffix}") if not f.name.startswith(DELETED_PREFIX))
    for old in kept[:-HISTORY_KEEP]:
        old.unlink(missing_ok=True)
    return name


def list_versions(history_dir: Path, model_id: str, limit: int = 20) -> list[dict]:
    folder = Path(history_dir) / check_id(model_id)
    out = []
    for f in list(reversed(_versions(folder)))[:limit] if folder.exists() else []:
        text = f.read_text(encoding="utf-8", errors="replace")
        out.append({"version": f.stem, "saved": f.stat().st_mtime, "bytes": len(text.encode("utf-8")),
                    "lines": text.count("\n") + 1, "hash": source_hash(text)})
    return out


def read_version(history_dir: Path, model_id: str, version: str) -> dict:
    if not re.fullmatch(r"\d{8}-\d{6}(-\d+)?", version or ""):
        raise ModelFileError(422, "invalid version")
    f = Path(history_dir) / check_id(model_id) / f"{version}.py"
    if not f.exists():
        raise ModelFileError(404, f"no version {version} of {model_id}")
    text = f.read_text(encoding="utf-8")
    return {"id": model_id, "version": version, "source": text, "hash": source_hash(text)}


# ---------------------------------------------------------------------------- design files

def _design_text(design) -> str:
    from .design import DesignError, check_design

    if not isinstance(design, dict):
        raise ModelFileError(422, "design must be a JSON object")
    try:
        check_design(design)
    except DesignError as e:
        raise ModelFileError(422, str(e), fields={e.where or "_": e.detail}) from None
    # a design the previous app wrote (its schema id in fairbeam.legacy) is read as it is; saving writes the current id
    from .legacy import current_schema

    design = {**design, "schema": current_schema(design.get("schema"))}
    text = json.dumps(design, indent=2, ensure_ascii=False) + "\n"
    if len(text.encode("utf-8")) > MAX_SOURCE:
        raise ModelFileError(422, f"a design is at most {MAX_SOURCE // 1024} KB")
    return text


def create_design(models_dir: Path, model_id: str, design: dict) -> Path:
    path = design_path(models_dir, model_id)
    check_free(models_dir, model_id)
    design = {**design, "model": {**design.get("model", {}), "id": model_id.replace("_", "-")}}
    try:
        _write_atomic(path, _design_text(design), exclusive=True)
    except FileExistsError:
        raise ModelFileError(409, f"a model named {model_id} already exists", fields={"id": "already exists"})
    return path


def read_design_file(models_dir: Path, model_id: str) -> dict:
    path = design_path(models_dir, model_id)
    if not path.exists():
        raise ModelFileError(404, f"no design {model_id}")
    text = path.read_text(encoding="utf-8")
    try:
        design = json.loads(text)
    except json.JSONDecodeError as e:
        raise ModelFileError(422, f"{path.name} is not valid JSON: {e.msg} (line {e.lineno})") from None
    return {"id": model_id, "file": path.name, "design": design, "hash": source_hash(text),
            "readonly": is_readonly(model_id, design=True)}


def save_design(models_dir: Path, history_dir: Path, model_id: str, design, base_hash) -> dict:
    """Write the design if ``base_hash`` matches the file on disk; back up the previous version."""
    path = design_path(models_dir, model_id)
    if not path.exists():
        raise ModelFileError(404, f"no design {model_id}")
    if is_readonly(model_id, design=True):
        raise ModelFileError(403, f"{model_id} is a bundled example and read-only; duplicate it to edit")
    text = _design_text(design)
    current = path.read_text(encoding="utf-8")
    current_hash = source_hash(current)
    if base_hash != current_hash:
        raise ModelFileError(409, "the file changed on disk since it was opened", current_hash=current_hash)
    if text == current:
        return {"hash": current_hash, "backup": None}
    backup = backup_version(history_dir, model_id, current, suffix=DESIGN_SUFFIX)
    _write_atomic(path, text)
    return {"hash": source_hash(text), "backup": backup}


def delete_design(models_dir: Path, history_dir: Path, model_id: str) -> dict:
    """"Delete" a design: move the file into its history folder as ``deleted-<stamp>.design.json``,
    next to its saved versions. Nothing is removed for good; moving it back restores it."""
    path = design_path(models_dir, model_id)
    if not path.exists():
        raise ModelFileError(404, f"no design {model_id}")
    if is_readonly(model_id, design=True):
        raise ModelFileError(403, f"{model_id} is a bundled example and read-only")
    folder = Path(history_dir) / check_id(model_id)
    folder.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = f"{DELETED_PREFIX}{stamp}{DESIGN_SUFFIX}"
    n = 1
    while (folder / name).exists():
        n += 1
        name = f"{DELETED_PREFIX}{stamp}-{n}{DESIGN_SUFFIX}"
    # a rename (a copy first when the folders are on different disks), retried while the preview
    # worker or a run has the file open on Windows
    _retry_busy(lambda: shutil.move(str(path), str(folder / name)))
    return {"id": model_id, "file": path.name, "moved_to": str(folder / name)}
