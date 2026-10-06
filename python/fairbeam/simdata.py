"""Raw simulation data under the sim root (``.sim/`` by default): markers, safe removal, cleanup.

Every openEMS run writes a folder of raw output (probe time series, NF2FF and field dumps, often
hundreds of MB). The bundle is the product; the raw folder is only needed until the bundle is
written. This module finds such folders, protects the ones still in use and removes the others,
never touching anything outside the sim root.

- ``mark_running(path)``  context manager that leaves ``.<name>.fairbeam-running`` (with our pid)
  next to a raw folder while a run and its post-processing use it
- ``live_runs(root)``  the CLI runs (``fairbeam run`` outside the server) marked directly under ``root``
- ``remove_inside(root, target)``  rmtree ``target`` only when it lies strictly inside ``root``
- ``clean_sim(root, older_than_days, dry_run)``  what ``fairbeam clean-sim`` does
"""

from __future__ import annotations

import fnmatch
import os
import shutil
import time
from contextlib import contextmanager
from pathlib import Path

MARKER_SUFFIX = ".fairbeam-running"
# folders directly under the sim root that hold history, not raw openEMS output
RESERVED = {"jobs", "model-history"}
# files openEMS writes into a run folder (see openEMS.Run's cleanup whitelist)
OPENEMS_OUTPUT = ("et", "ht", "port_ut*", "port_it*", "nf2ff*.h5", "openEMS_run_stats.txt", "openEMS_stats.txt")
RECENT_S = 600.0  # a folder written to in the last 10 minutes may belong to a run in progress


def keep_sim_requested() -> bool:
    """``FAIRBEAM_KEEP_SIM=1`` keeps raw folders that would otherwise be removed automatically."""
    return os.environ.get("FAIRBEAM_KEEP_SIM", "").strip().lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------------- running markers

def marker_path(path: str | Path) -> Path:
    p = Path(path)
    return p.parent / f".{p.name}{MARKER_SUFFIX}"


def pid_alive(pid: int) -> bool:
    # never os.kill(pid, 0) here: on Windows that terminates the process
    from .procutil import pid_alive as alive
    try:
        return bool(pid) and alive(int(pid))
    except OSError:
        return False


@contextmanager
def mark_running(path: str | Path):
    """Mark the raw folder ``path`` as in use by this process for the duration of the block.

    The marker sits next to the folder (openEMS may wipe the folder itself when a run starts).
    Nested use for the same folder is fine: only the outermost block removes the marker."""
    marker = marker_path(os.path.abspath(path))
    mine = str(os.getpid())
    try:
        owned = marker.read_text(encoding="utf-8").strip() == mine
    except OSError:
        owned = False
    created = False
    if not owned:
        try:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(mine + "\n", encoding="utf-8")
            created = True
        except OSError:
            pass
    try:
        yield
    finally:
        if created:
            try:
                marker.unlink()
            except OSError:
                pass


def _marker_live(marker: Path) -> bool:
    try:
        return pid_alive(int(marker.read_text(encoding="utf-8").strip() or 0))
    except (OSError, ValueError):
        return False


def _drop_stale_markers(folder: Path):
    """Remove markers in ``folder`` whose run folder is gone and whose process is dead."""
    try:
        names = [e.name for e in os.scandir(folder) if e.is_file(follow_symlinks=False)]
    except OSError:
        return
    for name in names:
        if name.startswith(".") and name.endswith(MARKER_SUFFIX):
            m = folder / name
            if not (folder / name[1:-len(MARKER_SUFFIX)]).exists() and not _marker_live(m):
                try:
                    m.unlink()
                except OSError:
                    pass


def live_runs(root: str | Path) -> list[dict]:
    """Runs of ``fairbeam run`` started outside the run server (a terminal, a script) that are
    still going and write their raw data directly under ``root``: ``[{"name", "pid"}]``.

    The CLI marks ``<sim-root>/<slug>`` while it runs (``mark_running``); the server's own jobs
    write below ``<sim-root>/runs/<id>/`` and are therefore not listed. A marker a crashed run left
    behind does not count once its pid belongs to a process that started later (pid reuse). Only
    the top level of ``root`` is read, so this is cheap enough for every /api/health."""
    out = []
    try:
        entries = [e for e in os.scandir(root) if e.is_file(follow_symlinks=False)]
    except OSError:
        return out
    for e in entries:
        if not (e.name.startswith(".") and e.name.endswith(MARKER_SUFFIX)):
            continue
        name = e.name[1:-len(MARKER_SUFFIX)]
        if not name or name in RESERVED:
            continue
        try:
            pid = int(Path(e.path).read_text(encoding="utf-8").strip() or 0)
            written = e.stat().st_mtime
        except (OSError, ValueError):
            continue
        if pid and pid != os.getpid() and pid_alive(pid) and not _started_after(pid, written):
            out.append({"name": name, "pid": pid})
    return sorted(out, key=lambda r: r["name"])


def _started_after(pid: int, when: float) -> bool:
    """The process ``pid`` started after ``when`` (epoch seconds), so it cannot have written a marker
    then: the run that did ended without removing it (a crash, a kill) and the system gave its pid
    to another process. False when the start time is unknown (the marker then counts, as before)."""
    from .procutil import WINDOWS, windows_process_info

    if WINDOWS:
        info = windows_process_info(pid)
        start = info["start"] if info else None
    else:
        from .jobs import parse_lstart, process_info

        info = process_info(pid)
        start = parse_lstart(info["lstart"]) if info else None
    return start is not None and start > when + 2.0  # ps reports whole seconds; a clock step


def in_use(path: Path, root: Path) -> bool:
    """A live marker for ``path`` or any of its ancestors below ``root``."""
    p = path
    while p != root and root in p.parents:
        if _marker_live(marker_path(p)):
            return True
        p = p.parent
    return False


# ---------------------------------------------------------------------------- safe removal

def inside(root: Path, target: Path) -> Path | None:
    """``target`` resolved (symlinks followed) if it lies strictly inside ``root``, else None."""
    try:
        r = Path(root).resolve()
        t = Path(target)
        if not t.is_absolute():
            return None
        t = t.resolve()
    except (OSError, RuntimeError):
        return None
    if t == r or r not in t.parents:
        return None
    return t


def tree_size(path: Path) -> int:
    total = 0
    for dirpath, dirnames, filenames in os.walk(path, followlinks=False):
        for name in filenames:
            try:
                total += os.lstat(os.path.join(dirpath, name)).st_size
            except OSError:
                pass
    return total


def newest_mtime(path: Path) -> float:
    newest = 0.0
    for dirpath, dirnames, filenames in os.walk(path, followlinks=False):
        for name in [None] + filenames:
            try:
                newest = max(newest, os.lstat(dirpath if name is None else os.path.join(dirpath, name)).st_mtime)
            except OSError:
                pass
    return newest


def remove_inside(root: Path, target: Path, protect: tuple[Path, ...] = ()) -> int | None:
    """Remove the folder ``target`` if it lies strictly inside ``root`` (after resolving symlinks),
    is not itself a symlink and neither is nor contains a ``protect`` folder. Returns the bytes
    freed, or None when nothing was removed."""
    t = inside(root, target)
    if t is None or Path(target).is_symlink() or not t.is_dir():
        return None
    for p in protect:
        try:
            pr = Path(p).resolve()
        except (OSError, RuntimeError):
            return None
        if t == pr or t in pr.parents or pr in t.parents:
            return None
    size = tree_size(t)
    shutil.rmtree(t, ignore_errors=True)
    try:
        marker_path(t).unlink()
    except OSError:
        pass
    return size


def prune_empty_parents(root: Path, start: Path):
    """Remove empty folders from ``start`` upwards, stopping below ``root`` and at reserved folders."""
    r = Path(root).resolve()
    p = Path(start).resolve()
    while p != r and r in p.parents and not (p.parent == r and p.name in RESERVED):
        _drop_stale_markers(p)
        try:
            p.rmdir()  # fails unless empty
        except OSError:
            return
        p = p.parent


# ---------------------------------------------------------------------------- clean-sim

def is_run_dir(path: Path) -> bool:
    """A folder that directly holds openEMS output files."""
    try:
        names = [e.name for e in os.scandir(path) if e.is_file(follow_symlinks=False)]
    except OSError:
        return False
    return any(fnmatch.fnmatchcase(n, pat) for n in names for pat in OPENEMS_OUTPUT)


def find_run_dirs(root: Path) -> list[Path]:
    """Raw run folders under ``root`` (not descending into one once found; symlinks and the
    reserved history folders are skipped)."""
    root = Path(root).resolve()
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        here = Path(dirpath)
        if here == root:
            dirnames[:] = [d for d in dirnames if d not in RESERVED]
        keep = []
        for d in sorted(dirnames):
            sub = here / d
            if sub.is_symlink():
                continue
            if is_run_dir(sub):
                found.append(sub)
            else:
                keep.append(d)
        dirnames[:] = keep
    return found


def clean_sim(root: str | Path, older_than_days: float = 7.0, dry_run: bool = False,
              now: float | None = None) -> dict:
    """Remove raw run folders under ``root`` whose newest file is older than ``older_than_days``.

    Folders with a live running marker (for themselves or an ancestor) or written to in the last
    ten minutes are skipped as in use. Returns ``{"removed": [(path, bytes)], "skipped": [(path,
    reason)], "freed": bytes}``; with ``dry_run`` nothing is deleted and ``removed`` lists what
    would be."""
    root = Path(root).resolve()
    out = {"removed": [], "skipped": [], "freed": 0}
    if not root.is_dir():
        return out
    now = time.time() if now is None else now
    cutoff = now - float(older_than_days) * 86400.0
    for d in find_run_dirs(root):
        if inside(root, d) is None:
            continue
        if in_use(d, root):
            out["skipped"].append((d, "running"))
            continue
        newest = newest_mtime(d)
        if newest > now - RECENT_S:
            out["skipped"].append((d, "written in the last 10 minutes"))
            continue
        if newest > cutoff:
            continue
        if dry_run:
            size = tree_size(d)
        else:
            size = remove_inside(root, d)
            if size is None:
                continue
            prune_empty_parents(root, d.parent)
        out["removed"].append((d, size))
        out["freed"] += size
    if not dry_run:  # markers left behind by runs that were killed
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            if Path(dirpath) == root:
                dirnames[:] = [d for d in dirnames if d not in RESERVED]
            if any(n.endswith(MARKER_SUFFIX) for n in filenames):
                _drop_stale_markers(Path(dirpath))
    return out


def human_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"
