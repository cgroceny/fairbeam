"""Where the desktop app's run server keeps its data, for the command line.

The desktop shell starts ``fairbeam serve`` with the folders of the workspace it shows
(src-tauri/src/main.rs: ``--models``, ``--projects``, ``--jobs``, ``--sim-root``). A CLI started by
hand (``python -m fairbeam run`` with the runtime's Python) does not get them: its defaults are
folders next to the fairbeam package it imports, which in the packaged runtime is the runtime
folder, not the workspace the app shows. A result written there never appears in the app.

So a server the desktop shell started (it passes ``FAIRBEAM_SHUTDOWN_TOKEN``) records its address
and folders in ``server.json`` in the app's per-user data folder, next to the runtime and the logs.
The CLI reads that record for its ``--out`` / ``--sim-root`` defaults outside a source checkout,
and for ``fairbeam run --server auto``. A server that itself runs from a source checkout (a debug
``tauri dev`` shell, whose workspace is the repository) marks its record ``"checkout": true``: the
packaged CLI does not take that repository's folders for its defaults (``--server`` still finds it).

- ``state_dir()``            the app's per-user data folder (``FAIRBEAM_STATE_DIR`` overrides it)
- ``write_server_record()``  what ``fairbeam serve`` writes when the desktop shell started it
- ``read_server_record()``   the last record, or None
- ``cli_defaults(repo)``     the CLI's output folders and where they come from
- ``running_bundle_names()`` the bundle names the app server's running runs will write
- ``resolve_server(value)``  the base URL of the run server ``fairbeam run --server`` submits to
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

IDENTIFIER = "org.fairbeam.desktop"  # src-tauri/tauri.conf.json "identifier": Tauri's app data folder
RECORD = "server.json"
SCHEMA = "fairbeam.server/1"


def state_dir() -> Path:
    """The desktop app's per-user data folder (Tauri's app_local_data_dir: it holds runtime/ and
    logs/), or ``FAIRBEAM_STATE_DIR``."""
    env = os.environ.get("FAIRBEAM_STATE_DIR")
    if env:
        return Path(env)
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / IDENTIFIER


def record_path() -> Path:
    return state_dir() / RECORD


def is_checkout(repo: str | Path) -> bool:
    """A source checkout (the repository layout, where ``npm run serve`` and the CLI share
    ``public/projects`` and ``.sim``): the CLI keeps its repository defaults there."""
    repo = Path(repo)
    return (repo / "package.json").is_file() and (repo / "python" / "fairbeam").is_dir()


def write_server_record(*, url: str, pid: int, models: Path, projects: Path, jobs: Path, sim_root: Path,
                        version: str | None = None, checkout: bool = False) -> Path | None:
    """Record the server the desktop shell started; None when the folder cannot be written.
    ``checkout``: the server runs from a source checkout (a ``tauri dev`` shell)."""
    rec = {"schema": SCHEMA, "url": url, "pid": int(pid), "fairbeam": version,
           "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "checkout": bool(checkout),
           "models": str(models), "projects": str(projects), "jobs": str(jobs), "sim_root": str(sim_root)}
    path = record_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{RECORD}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(rec, indent=2) + "\n", encoding="utf-8", newline="\n")
        os.replace(tmp, path)
    except OSError:
        return None
    return path


def read_server_record(path: str | Path | None = None) -> dict | None:
    """The last server record, or None (missing, unreadable, or not a record)."""
    try:
        data = json.loads(Path(path or record_path()).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        return None
    for key in ("url", "projects", "sim_root"):
        if not isinstance(data.get(key), str) or not data[key]:
            return None
    return data


def server_alive(rec: dict) -> bool:
    """The recorded server process is still running (the record outlives it)."""
    from .procutil import pid_alive

    pid = rec.get("pid")
    try:
        return isinstance(pid, int) and not isinstance(pid, bool) and pid > 0 and bool(pid_alive(pid))
    except OSError:
        return False


def cli_defaults(repo: str | Path) -> dict:
    """``{"out", "sim", "source", "record"}``: the CLI's default bundle folder and raw-data folder.

    source "checkout": a source checkout, the repository's ``public/projects`` and ``.sim`` (as
    always); "app": the workspace of the desktop app's server (its record); "package": neither, the
    folders next to the package (in the packaged runtime: inside the runtime, which the app does
    not show; the CLI says so). The record of a server that runs from a source checkout (a debug
    ``tauri dev`` shell: its folders are that repository's) is not used."""
    repo = Path(repo)
    if not is_checkout(repo):
        rec = read_server_record()
        if rec is not None and rec.get("checkout") is not True:
            return {"out": Path(rec["projects"]), "sim": Path(rec["sim_root"]), "source": "app",
                    "record": record_path()}
    return {"out": repo / "public" / "projects", "sim": repo / ".sim",
            "source": "checkout" if is_checkout(repo) else "package", "record": None}


def _same_folder(a: str | Path, b: str | Path) -> bool:
    try:
        return os.path.normcase(str(Path(a).resolve())) == os.path.normcase(str(Path(b).resolve()))
    except OSError:
        return False


def running_bundle_names(projects: str | Path) -> set[str]:
    """The bundle names (without ``.json``) the runs the app's server is running will write into
    ``projects``: a run takes its file name when it starts (``jobs.JobManager._name_run``) and writes
    it when it ends, whatever is there by then. Empty when ``projects`` is not the recorded
    workspace's, or the jobs folder cannot be read."""
    rec = read_server_record()
    if rec is None or not isinstance(rec.get("jobs"), str) or not _same_folder(rec["projects"], projects):
        return set()
    names: set[str] = set()
    try:
        folders = [e.path for e in os.scandir(rec["jobs"]) if e.is_dir(follow_symlinks=False)]
    except OSError:
        return names
    for folder in folders:
        try:
            job = json.loads(Path(folder, "job.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if (isinstance(job, dict) and job.get("status") == "running" and job.get("kind", "run") == "run"
                and isinstance(job.get("name"), str) and job["name"]):
            names.add(job["name"])
    return names


def resolve_server(value: str) -> str:
    """The base URL (``http://127.0.0.1:<port>``) of the run server to submit to: ``value`` itself,
    a bare port, or "auto" for the desktop app's server from its record. Raises ValueError."""
    value = (value or "").strip()
    if value in ("", "auto"):
        rec = read_server_record()
        if rec is None:
            raise ValueError(f"no running Fairbeam app found (no {record_path()}); start the app, "
                             "or pass the server's address: --server http://127.0.0.1:<port>")
        if not server_alive(rec):
            raise ValueError(f"the Fairbeam app's server ({rec['url']}) is not running; start the app, "
                             "or pass the server's address: --server http://127.0.0.1:<port>")
        return rec["url"].rstrip("/")
    if value.isdigit():
        return f"http://127.0.0.1:{int(value)}"
    if not value.startswith(("http://", "https://")):
        value = "http://" + value
    return value.rstrip("/").removesuffix("/api")
