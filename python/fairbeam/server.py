"""Local run server: ``fairbeam serve``.

A small stdlib HTTP server (``ThreadingHTTPServer``) that lets the viewer list models, preview
geometry while parameters are edited, queue simulations and follow them live. It binds to
127.0.0.1 only and is meant for a single local user.

Endpoints (all JSON unless noted)::

    GET  /api/health                versions, CPU count, folders
    GET  /api/models                MODEL + PARAMS of every python/models/*.py (or an error entry)
    POST /api/preview               {model, params} -> geometry-only bundle (nothing is written)
    POST /api/runs                  {model, params, threads?, engine?, name?, end_criteria_db?, points?, cells?} -> job
                                    (threads: a number or "auto"; cells: mesh size, for Auto and the memory preflight)
    POST /api/preflight             {cells?, engine?} -> {level: ok|warn|refuse|unknown, messages, ...}
    POST /api/sweeps                {..., sweep: [{key, values} | {key, start, stop, steps}]} -> jobs
    POST /api/sweeps/{id}/cancel    cancel the unfinished jobs of a sweep (also a mesh convergence study)
    POST /api/convergence           {model, params, densities?, tolerances?: {f_pct, s11_db, dmax_db}, max_runs?,
                                    max_density?, threads?, engine?, ...} -> {study, runs}: a mesh convergence
                                    study of a design, one run per density until the stopping rule holds
    GET  /api/convergence/{id}      the study: members with their metrics, steps and the verdict
    POST /api/optimizations         {model, params, vary: [{key, min, max, start?}], goals: [{kind, target,
                                    at?, weight?, ports?}], max_evals<=40, method?, excite?, engine?, threads?,
                                    name?, end_criteria_db?} -> job
    (end_criteria_db: the energy end criterion in dB, passed on as --end-db; absent or null keeps the
    model's or design's own)
    GET  /api/runs                  job history, newest first
    GET  /api/runs/{id}             one job
    GET  /api/runs/{id}/events      Server-Sent Events: replay, then live; heartbeat every 15 s
    GET  /api/runs/{id}/log         plain-text log
    POST /api/runs/{id}/cancel      SIGTERM the job's process group, SIGKILL after a grace period
    POST /api/runs/{id}/delete      {delete_bundle?} remove a finished job from the history (and its raw sim data)
    POST /api/queue/clear           cancel every queued job (the running one keeps running) -> {cancelled, runs}
    GET  /api/templates             python/templates/*.py: MODEL, PARAMS and the module docstring
    POST /api/models                {id, name?, template | from} create python/models/<id>.py
    GET  /api/models/{id}/source    {source, hash, readonly}
    PUT  /api/models/{id}/source    {source, base_hash} save (409 on a stale hash), then validate
    GET  /api/models/{id}/history   last 20 saved versions; .../history/{version} one of them
    POST /api/preview               {design, params?} -> the bundle of an unsaved design and its checks
    POST /api/designs               {id, name?, from? | template? | python?: {source_model, model?} | cst?: {source, filename?} | pcb?: {files, options?}}
                                    create python/models/<id>.design.json; {design, name?, id?}: a design file (fairbeam.design/1)
                                    as a new design, under a free id from its name when no id is given
    POST /api/import/cst            {source, filename?, name?} a CST-compatible VBA macro (.bas, .mcs, .txt) as a design
                                    (not saved): {design, report, checks}
    POST /api/import/pcb            {files: [{name, content_base64}], options?: {layer_map?, substrate?, thickness?, eps_r?,
                                    tan_d?, f0?, units?, chord_tol?, margin?, origin?}, name?} PCB artwork (DXF, Gerber,
                                    Excellon) as a design (not saved): {design, report, layers, checks}; at most 12 files,
                                    8 MB each and 16 MB together (413/422 beyond)
    GET  /api/designs/{id}          {design, hash}
    PUT  /api/designs/{id}          {design, base_hash} save (also with check errors; they come back in validation.checks)
    GET  /api/designs/{id}/python   the design as a Python model file
    POST /api/design/from-python    {source, model?} a model script built (never solved) in a child process, 20 s limit:
                                    {design, python, normalized, output}; a failure is a 422 with {error, line?, timeout?}
    POST /api/designs/{id}/delete   move the design into its history folder (recoverable, never removed)
    GET  /api/materials/user        {materials, skipped, file}: the user's material library ("My materials")
    PUT  /api/materials/user        {materials} validated, saved to <workspace>/materials.json
    POST /api/open-feedback         {url} open an issue form of the public tracker in the system browser

With ``--ui <dir>`` every other GET serves the built web app from that folder (``static.py``) and
``/projects/*.json`` from the projects folder, so the app and the API share one origin.

Request safety: the server refuses non-loopback peers, requires a loopback ``Host`` (defeats DNS
rebinding), rejects a non-loopback ``Origin`` or ``Sec-Fetch-Site: cross-site``, has no GET side
effects, sends no CORS headers and only accepts ``application/json`` bodies on POST (a cross-site
page can therefore not send them without a preflight that is never granted).
"""

from __future__ import annotations

import collections
import hashlib
import copy
import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .procutil import WINDOWS, popen_group, release_group
from ._meta import __version__
from . import blender_find, blender_job, modelfiles, renders, resources, static, usermaterials
from .jobs import PACKAGE_ROOT, JobManager, child_env

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}
LOOPBACK_PEERS = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
DEFAULT_PORT = 5320
MAX_BODY = 1 << 20
# PCB artwork import: the files travel base64-encoded in the JSON body (POST /api/import/pcb, and POST /api/designs
# with pcb), so these two routes take a larger body than the rest
MAX_PCB_FILES = 12
MAX_PCB_FILE = 8_000_000            # bytes per file, decoded
MAX_PCB_TOTAL = 16_000_000          # bytes of all files together, decoded
MAX_PCB_BODY = MAX_PCB_TOTAL * 4 // 3 + (1 << 20)   # base64 grows the files by a third
# one rendered PNG (POST /api/renders/<design>), base64 in the JSON body
MAX_RENDER_BODY = renders.MAX_PNG * 4 // 3 + (1 << 20)
# rendering through Blender (POST /api/render-jobs): the design's GLB travels base64-encoded in the JSON body
MAX_RENDER_JOB_BODY = blender_job.MAX_GLB * 4 // 3 + (1 << 20)
NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,120}$")
MAX_SWEEP_RUNS = 500
MAX_LEGACY_SWEEP_RUNS = 25
MAX_SWEEP_PARAMS = 2
MAX_SEQUENCE_AXES = 6
MAX_SEQUENCES = 100
MAX_OPT_EVALS = 40
KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


class ApiError(Exception):
    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra


# ---------------------------------------------------------------------- helpers

# the app's "Send feedback" links (src/components/FeedbackLink.tsx): the issue forms of the public
# tracker, prefilled with the version and the OS at most. The desktop webview cannot open a browser
# itself, so it asks the server; only these URLs are opened.
FEEDBACK_PATH = "/ismailakdag/fairbeam-releases/issues/new"
FEEDBACK_QUERY = {"template": re.compile(r"(bug|feature)\.yml"), "version": re.compile(r"[0-9][0-9A-Za-z.+-]{0,31}"),
                  "os": re.compile(r"macOS|Windows")}


def is_feedback_url(url) -> bool:
    """``https://github.com/ismailakdag/fairbeam-releases/issues/new/choose``, or ``.../issues/new``
    with a ``template`` and at most ``version`` and ``os`` (each once, of the expected form)."""
    if not isinstance(url, str) or len(url) > 300:
        return False
    u = urlsplit(url)
    if u.scheme != "https" or u.netloc != "github.com" or u.fragment:
        return False
    if u.path == FEEDBACK_PATH + "/choose":
        return not u.query
    if u.path != FEEDBACK_PATH:
        return False
    q = parse_qs(u.query, keep_blank_values=True)
    return "template" in q and all(k in FEEDBACK_QUERY and len(v) == 1 and FEEDBACK_QUERY[k].fullmatch(v[0])
                                   for k, v in q.items())


def default_threads(cpu: int | None = None) -> int:
    """What "Auto" means without a grid size (see fairbeam.resources.auto_threads)."""
    cpu = cpu or resources.available_cpus()
    return resources.auto_threads(cpu, resources.physical_cores(cpu))


def format_sse(event: dict) -> bytes:
    """One SSE frame: ``id``, ``event`` (the event type) and single-line JSON ``data``."""
    data = json.dumps(event, separators=(",", ":"), allow_nan=False, default=str)
    head = f"id: {event['seq']}\n" if "seq" in event else ""
    return f"{head}event: {event.get('type', 'message')}\ndata: {data}\n\n".encode()


def sse_comment(text: str = "keepalive") -> bytes:
    return f": {text}\n\n".encode()


_VERSIONS_SNIPPET = """
import json, sys
from importlib import metadata
out = {"python": sys.version.split()[0]}
for key, dist in (("openems", "openEMS"), ("csxcad", "CSXCAD")):
    try:
        out[key] = metadata.version(dist)
    except metadata.PackageNotFoundError:
        out[key] = None
print(json.dumps(out))
"""


def _versions(python: str) -> dict:
    """fairbeam version plus the openEMS/CSXCAD versions of the python that runs the jobs."""
    out = {"fairbeam": __version__, "python": None, "openems": None, "csxcad": None}
    try:
        r = subprocess.run([python, "-c", _VERSIONS_SNIPPET], capture_output=True, encoding="utf-8",
                           errors="replace", timeout=20, stdin=subprocess.DEVNULL, env=child_env())
        out.update(json.loads(r.stdout.strip().splitlines()[-1]))
    except (OSError, subprocess.TimeoutExpired, ValueError, IndexError):
        pass
    return out


def openems_executable(python: str) -> Path:
    """The openEMS binary that belongs to this python's CSXCAD/openEMS modules.

    POSIX: the build next to the venv (``<prefix>/venv/bin/python`` -> ``<prefix>/bin/openEMS``).
    Windows: the extracted official build, ``%OPENEMS_INSTALL_PATH%\\openEMS.exe`` (the wheels load
    their DLLs from there; see fairbeam/__init__.py), not a folder relative to ``Scripts\\python.exe``.
    """
    if WINDOWS:
        root = os.environ.get("OPENEMS_INSTALL_PATH") or os.environ.get("CSXCAD_INSTALL_PATH") or r"C:\opt\openEMS"
        return Path(root) / "openEMS.exe"
    return Path(python).parent.parent.parent / "bin" / "openEMS"  # no resolve(): venv python is a symlink


def detect_engines(python: str) -> list[str]:
    """FDTD engines ``fairbeam run --engine`` can use with this python: always "cpu", plus "gpu"
    when its openEMS build (``openems_executable``) lists a ``gpu`` engine in ``openEMS --help``
    (the Metal/CUDA build; the official Windows build is CPU only)."""
    engines = ["cpu"]
    exe = openems_executable(python)
    if exe.exists():
        try:
            r = subprocess.run([str(exe), "--help"], capture_output=True, encoding="utf-8", errors="replace",
                               timeout=10, stdin=subprocess.DEVNULL)
            if re.search(r"^\s+gpu:", r.stdout + r.stderr, re.M):
                engines.append("gpu")
        except (OSError, subprocess.TimeoutExpired):
            pass
    return engines


def _fmt_float(v: float) -> str:
    """Shortest exact text for a float, without a trailing ".0" (``80.0`` -> ``80``)."""
    text = repr(float(v))
    return text[:-2] if text.endswith(".0") else text


def validate_params(specs: list[dict], values: dict) -> tuple[dict, dict, dict]:
    """Check JSON parameter values against a model's PARAMS.

    Returns ``(resolved, overrides, errors)``: ``resolved`` has every key (defaults filled in),
    ``overrides`` only the values that differ from the default, formatted for ``--set``;
    ``errors`` maps a key to a message and is empty when everything is valid.
    """
    if not isinstance(values, dict):
        return {}, {}, {"_": "params must be an object"}
    by_key = {s["key"]: s for s in specs}
    errors: dict[str, str] = {}
    resolved: dict = {}
    overrides: dict[str, str] = {}
    for key in values:
        if key not in by_key:
            errors[key] = f"unknown parameter; available: {', '.join(by_key)}"
    for s in specs:
        key, kind, default = s["key"], s.get("type", "float"), s["default"]
        if key not in values or values[key] is None or values[key] == "":
            resolved[key] = default
            continue
        v = values[key]
        if kind in ("int", "float"):
            if isinstance(v, bool):
                errors[key] = "must be a number"
                continue
            if isinstance(v, str):
                try:
                    v = float(v.strip())
                except ValueError:
                    errors[key] = "must be a number"
                    continue
            if not isinstance(v, (int, float)) or not math.isfinite(v):
                errors[key] = "must be a finite number"
                continue
            if kind == "int":
                if float(v) != int(v):
                    errors[key] = "must be a whole number"
                    continue
                v = int(v)
            else:
                v = float(v)
            lo, hi = s.get("minimum"), s.get("maximum")
            unit = f" {s['unit']}" if s.get("unit") else ""
            if lo is not None and v < lo:
                errors[key] = f"must be at least {lo:g}{unit}"
                continue
            if hi is not None and v > hi:
                errors[key] = f"must be at most {hi:g}{unit}"
                continue
        elif kind == "bool":
            if not isinstance(v, bool):
                errors[key] = "must be true or false"
                continue
        else:
            v = str(v)
            if "\n" in v or len(v) > 500:
                errors[key] = "must be a single line of at most 500 characters"
                continue
        resolved[key] = v
        if v != default:
            overrides[key] = ("true" if v else "false") if kind == "bool" else _fmt_float(v) if kind == "float" else str(v)
    return resolved, overrides, errors


def slugify(text: str) -> str:
    """File-safe bundle name for a run name ("Dipole 60 mm" -> "dipole-60-mm")."""
    return re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-.").lower()[:100]


def _nice(v: float) -> float:
    """Round away float noise from a linear range (0.1 + 0.2 -> 0.3), keeping 10 significant digits."""
    return float(f"{v:.10g}")


def expand_sweep(specs: list[dict], base: dict, sweep, *, max_axes: int = MAX_SWEEP_PARAMS,
                 max_runs: int = MAX_LEGACY_SWEEP_RUNS) -> tuple[list[dict], list[dict], dict]:
    """Cartesian expansion of a parameter sweep.

    ``sweep`` is a list of one or two axes, each ``{"key", "values": [...]}`` or
    ``{"key", "start", "stop", "steps"}``. Returns ``(combos, axes, errors)``: ``combos`` are the
    swept values per run (``{key: value}``, first axis varying slowest), ``axes`` the normalised
    ``{key, values}``, and ``errors`` per field. Values are checked like any parameter.
    """
    errors: dict[str, str] = {}
    if not isinstance(sweep, list) or not 1 <= len(sweep) <= max_axes:
        return [], [], {"sweep": f"give one to {max_axes} parameters to sweep"}
    by_key = {s["key"]: s for s in specs}
    axes: list[dict] = []
    for i, ax in enumerate(sweep):
        field = f"sweep.{i}"
        if not isinstance(ax, dict) or ax.get("key") not in by_key:
            errors[field] = "unknown parameter"
            continue
        key = ax["key"]
        spec = by_key[key]
        if spec.get("type") not in ("int", "float"):
            errors[key] = "only numeric parameters can be swept"
            continue
        if any(a["key"] == key for a in axes):
            errors[key] = "swept twice"
            continue
        if "values" in ax:
            values = ax["values"]
            if not isinstance(values, list) or not values:
                errors[key] = "give at least one value"
                continue
        else:
            start, stop, steps = ax.get("start"), ax.get("stop"), ax.get("steps")
            nums = all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (start, stop))
            if not nums or isinstance(steps, bool) or not isinstance(steps, int) or not 1 <= steps <= max_runs:
                errors[key] = f"start and stop must be numbers and steps a whole number from 1 to {max_runs}"
                continue
            values = [start] if steps == 1 else [_nice(start + (stop - start) * k / (steps - 1)) for k in range(steps)]
        clean = []
        for v in values:
            _, _, err = validate_params([spec], {key: v})
            if err:
                errors[key] = f"{v}: {err[key]}"
                break
            v = int(round(float(v))) if spec.get("type") == "int" else float(v)
            if v not in clean:
                clean.append(v)
        else:
            axes.append({"key": key, "values": clean})
    if errors:
        return [], axes, errors
    total = 1
    for ax in axes:
        total *= len(ax["values"])
    if total > max_runs:
        return [], axes, {"sweep": f"{total} runs; a sweep may have at most {max_runs}"}
    combos: list[dict] = [{}]
    for ax in axes:
        combos = [{**c, ax["key"]: v} for c in combos for v in ax["values"]]
    return combos, axes, {}


def expand_sequences(specs: list[dict], sequences) -> tuple[list[dict], list[dict], dict]:
    """Expand named independent grids in order; return flattened combos with sequence metadata."""
    if not isinstance(sequences, list) or not sequences:
        return [], [], {"sequences": "give at least one sequence"}
    if len(sequences) > MAX_SEQUENCES:  # checked before any expansion: each sequence costs work
        return [], [], {"sequences": f"{len(sequences)} sequences; a sweep may have at most {MAX_SEQUENCES}"}
    combos, clean_sequences, errors = [], [], {}
    names = set()
    for i, sequence in enumerate(sequences):
        field = f"sequences.{i}"
        if not isinstance(sequence, dict):
            errors[field] = "must be an object with name and sweep"
            continue
        name = sequence.get("name")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 80 or any(ord(c) < 32 for c in name):
            errors[f"{field}.name"] = "must be a non-empty single-line name of at most 80 characters"
            continue
        name = name.strip()
        if name in names:
            errors[f"{field}.name"] = "sequence names must be unique"
            continue
        names.add(name)
        grid, axes, grid_errors = expand_sweep(specs, {}, sequence.get("sweep"), max_axes=MAX_SEQUENCE_AXES,
                                                max_runs=MAX_SWEEP_RUNS)
        if grid_errors:
            errors.update({f"{field}.{key}": value for key, value in grid_errors.items()})
            continue
        # the running total is checked before this sequence's runs are added, and expansion stops there:
        # an oversized request never builds more than MAX_SWEEP_RUNS combinations
        if len(combos) + len(grid) > MAX_SWEEP_RUNS:
            errors["sequences"] = (f"at least {len(combos) + len(grid)} runs; "
                                   f"a sweep may have at most {MAX_SWEEP_RUNS}")
            break
        clean_sequences.append({"name": name, "axes": axes, "total": len(grid)})
        combos.extend({"sequence_index": i, "sequence_name": name, "values": values} for values in grid)
    if errors:
        return [], clean_sequences, errors
    return combos, clean_sequences, {}


# ---------------------------------------------------------------------- model registry

class ModelRegistry:
    """Describes the model files in a child process; cached until a file changes.

    With a ``worker`` (the server's PreviewWorker) the files are described there when it is idle:
    the same code in the same kind of child, without starting a new Python that imports CSXCAD
    (~0.5 s on every change of a model file, e.g. after each save). Otherwise, or when the worker
    fails, a one-shot ``python -m fairbeam.preview describe`` child does it."""

    def __init__(self, models_dir: Path, python: str, timeout: float = 60.0, worker: "PreviewWorker | None" = None):
        self.models_dir = Path(models_dir)
        self.python = python
        self.timeout = timeout
        self.worker = worker
        self._key = None
        self._models: list[dict] = []
        self._lock = threading.Lock()

    def _stamp(self):
        return tuple(sorted((p.name, p.stat().st_mtime) for p in self._files()))

    def _files(self) -> list[Path]:
        """``*.py`` models and ``*.design.json`` designs (see fairbeam.preview.model_files)."""
        return sorted(p for p in [*self.models_dir.glob("*.py"), *self.models_dir.glob("*.design.json")]
                      if not p.name.startswith("_"))

    def list(self) -> list[dict]:
        with self._lock:
            stamp = self._stamp()
            if stamp != self._key:
                self._models = self._describe()
                self._key = stamp
            return self._models

    def get(self, key: str) -> dict | None:
        if not isinstance(key, str) or not KEY_RE.match(key):
            return None
        return next((m for m in self.list() if m["key"] == key), None)

    def _describe(self) -> list[dict]:
        if self.worker is not None and not self.worker.busy():
            try:
                resp = self.worker.request({"op": "describe", "models_dir": str(self.models_dir)})
                if resp.get("ok") and isinstance(resp.get("result"), list):
                    return resp["result"]
            except (ApiError, OSError, ValueError):
                pass   # the worker died or hung (it restarts on the next request): describe in a new child
        cmd = [self.python, "-m", "fairbeam.preview", "describe", str(self.models_dir)]
        try:
            r = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace", timeout=self.timeout,
                               env=child_env(), stdin=subprocess.DEVNULL, cwd=str(PACKAGE_ROOT.parent))
            if r.returncode == 0 and r.stdout.strip():
                return json.loads(r.stdout.strip().splitlines()[-1])
            err = (r.stderr.strip().splitlines() or [f"exit code {r.returncode}"])[-1]
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as e:
            err = str(e)
        # the describe child itself crashed (e.g. a segfault in one model): describe one by one
        out = []
        for p in self._files():
            out.append(self._describe_one(p, err))
        return out

    def _describe_one(self, path: Path, batch_error: str) -> dict:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            link = Path(tmp) / path.name
            try:
                link.symlink_to(path.resolve())
            except OSError:  # Windows: symlinks need admin rights or developer mode
                shutil.copyfile(path, link)
            cmd = [self.python, "-m", "fairbeam.preview", "describe", tmp]
            try:
                r = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace",
                                   timeout=self.timeout, env=child_env(), stdin=subprocess.DEVNULL,
                                   cwd=str(PACKAGE_ROOT.parent))
                if r.returncode == 0 and r.stdout.strip():
                    entry = json.loads(r.stdout.strip().splitlines()[-1])[0]
                    entry["path"] = str(path.resolve())
                    return entry
                err = (r.stderr.strip().splitlines() or [f"exit code {r.returncode}"])[-1]
            except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, IndexError) as e:
                err = str(e) or batch_error
        key = path.name[: -len(".design.json")] if path.name.endswith(".design.json") else path.stem
        return {"key": key, "file": path.name, "path": str(path.resolve()), "error": err}


# ---------------------------------------------------------------------- preview worker

class PreviewWorker:
    """A persistent ``python -m fairbeam.preview worker`` child; restarted when it dies or hangs."""

    def __init__(self, python: str, timeout: float = 30.0):
        self.python = python
        self.timeout = timeout
        self.proc: subprocess.Popen | None = None
        self.stderr_tail: collections.deque[str] = collections.deque(maxlen=40)
        self._lock = threading.Lock()
        self._seq = 0

    def _start(self):
        # its own group (and, on Windows, a job object that dies with the server, launcher child included)
        self.proc = popen_group([self.python, "-m", "fairbeam.preview", "worker"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=child_env(),
                                cwd=str(PACKAGE_ROOT.parent), bufsize=0)
        proc = self.proc

        def drain():
            for raw in iter(proc.stderr.readline, b""):
                self.stderr_tail.append(raw.decode("utf-8", errors="replace").rstrip())

        threading.Thread(target=drain, daemon=True).start()

    def busy(self) -> bool:
        """A request is running (a model build can take long; the registry does not wait for it)."""
        return self._lock.locked()

    def stop(self):
        proc, self.proc = self.proc, None
        if proc is None:
            return
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
        release_group(proc)  # Windows: proc was the venv launcher; this also ends the interpreter it started
        for f in (proc.stdin, proc.stdout, proc.stderr):
            try:
                f.close()
            except OSError:
                pass

    def request(self, payload: dict) -> dict:
        with self._lock:
            if self.proc is None or self.proc.poll() is not None:
                self._start()
            self._seq += 1
            payload = {**payload, "id": self._seq}
            proc = self.proc
            result: dict = {}

            def read():
                try:
                    proc.stdin.write((json.dumps(payload) + "\n").encode())
                    proc.stdin.flush()
                    line = proc.stdout.readline()
                    result["line"] = line
                except (BrokenPipeError, OSError) as e:
                    result["error"] = str(e)

            t = threading.Thread(target=read, daemon=True)
            t.start()
            t.join(self.timeout)
            if t.is_alive():
                self.stop()
                raise ApiError(504, f"geometry build did not finish within {self.timeout:.0f} s")
            line = result.get("line")
            if not line:
                tail = list(self.stderr_tail)[-5:]
                self.stop()
                raise ApiError(500, "the preview worker exited" + (": " + tail[-1] if tail else ""),
                               log_tail=tail)
            return json.loads(line)


# ---------------------------------------------------------------------- application

def backup_scope_for(models_dir: Path) -> str:
    """Opaque identity of the canonical design storage root, stable across server restarts.

    Scope the actual models resource rather than jobs/projects directories or a display name.
    Windows case aliases and filesystem aliases must not manufacture a second identity.
    """
    canonical = os.path.normcase(str(Path(models_dir).resolve()))
    digest = hashlib.sha256(("fairbeam:models-backup:v1\0" + canonical).encode("utf-8")).hexdigest()
    return "models-v1:" + digest


class App:
    def __init__(self, *, models_dir: Path, projects_dir: Path, jobs_dir: Path, python: str | None = None,
                 manager: JobManager | None = None, heartbeat_s: float = 15.0, port: int = DEFAULT_PORT,
                 templates_dir: Path | None = None, history_dir: Path | None = None, ui_dir: Path | None = None,
                 sim_root: Path | None = None, materials_file: Path | None = None):
        from .cli import rebuild_index

        self.models_dir = Path(models_dir).resolve()
        self.backup_scope = backup_scope_for(self.models_dir)
        self.projects_dir = Path(projects_dir).resolve()
        self.jobs_dir = Path(jobs_dir).resolve()
        # raw openEMS output of the jobs goes to <sim_root>/runs/<job id>/ (removed with the job)
        self.sim_root = Path(sim_root).resolve() if sim_root else self.jobs_dir.parent
        self.python = python or sys.executable
        self.heartbeat_s = heartbeat_s
        self.port = port
        self.cpu = resources.available_cpus()
        self.physical = resources.physical_cores(self.cpu)
        self.ui_dir = Path(ui_dir).resolve() if ui_dir else None
        self.preview = PreviewWorker(self.python)
        self.registry = ModelRegistry(self.models_dir, self.python, worker=self.preview)
        self.design_name_lock = threading.Lock()
        self.templates_dir = Path(templates_dir or self.models_dir.parent / "templates").resolve()
        self.templates = ModelRegistry(self.templates_dir, self.python, worker=self.preview)
        self.history_dir = Path(history_dir or self.jobs_dir.parent / "model-history").resolve()
        # the user's material library sits in the workspace next to models/ (docs/RUN-SERVER.md)
        self.materials_file = Path(materials_file or self.models_dir.parent / usermaterials.FILE_NAME).resolve()
        # both render engines save into <workspace>/renders/<design id>/ (python/fairbeam/renders.py);
        # the Blender jobs (docs/RENDER-BLENDER.md) run through this manager
        self.render_jobs = blender_job.RenderManager(self.models_dir.parent)

        def finished(job):
            if job.kind == "research":
                return  # research results never become antenna viewer bundles
            if self.projects_dir.exists():
                rebuild_index(self.projects_dir)
            self.studies.on_finished(job)  # a mesh convergence study queues its next density

        self.manager = manager or JobManager(self.jobs_dir, self.projects_dir, python=self.python,
                                             sim_root=self.sim_root)
        from .convergence import ServerStudies
        self.studies = ServerStudies(self.manager, self.projects_dir)
        self.engines = detect_engines(self.python)
        previous = self.manager.on_finished

        def chained(job):
            finished(job)
            if previous is not None:
                previous(job)

        self.manager.on_finished = chained
        self.versions = _versions(self.python)

    def close(self):
        self.render_jobs.shutdown()
        self.manager.shutdown()
        self.preview.stop()

    # ---- endpoint implementations (return JSON-able objects or raise ApiError)

    def health(self) -> dict:
        return {"ok": True, "api": 1, "research": True, **self.versions, "cpu_count": self.cpu,
                "physical_cores": self.physical, "host_cpu": resources.host_cpu_name(),
                "default_threads": resources.auto_threads(self.cpu, self.physical),
                "throughput": resources.measured_throughput(self.projects_dir, resources.host_cpu_name()),
                "memory_free_bytes": resources.free_memory_bytes(), "engines": self.engines,
                "python_executable": self.python, "models_dir": str(self.models_dir), "backup_scope": self.backup_scope,
                "projects_dir": str(self.projects_dir), "jobs_dir": str(self.jobs_dir),
                # running/queued: the server's own queue; version: bumped on every change of it (a run
                # added, started, ended or removed), so a window that polls this sees runs another
                # client submitted; external: `fairbeam run` processes started outside the server
                "queue": {"running": cur.id if (cur := self.manager.current) else None,
                          "queued": self.manager.queued_count(), "version": self.manager.version,
                          "external": len(self.external_runs())},
                # the desktop shell starts the server with a shutdown token (Server::spawn)
                "desktop": bool(os.environ.get("FAIRBEAM_SHUTDOWN_TOKEN"))}

    # ---- rendering through Blender

    def blender_info(self, path: str | None = None) -> dict:
        return blender_find.detect(path or None)

    def open_blender_download(self) -> dict:
        """Open blender.org/download in the system browser (a fixed address, nothing else is ever opened)."""
        import webbrowser

        try:
            return {"opened": bool(webbrowser.open(blender_find.DOWNLOAD_URL))}
        except webbrowser.Error:
            return {"opened": False}

    def submit_render(self, body: dict) -> dict:
        try:
            return self.render_jobs.submit(body).to_dict()
        except blender_job.RenderError as e:
            raise ApiError(e.status, e.message)

    def render_job(self, job_id: str):
        job = self.render_jobs.get(job_id)
        if job is None:
            raise ApiError(404, f"no render {job_id}")
        return job

    def user_materials(self) -> dict:
        items, skipped = usermaterials.load(self.materials_file)
        return {"materials": items, "skipped": skipped, "file": str(self.materials_file)}

    def save_user_materials(self, body: dict) -> dict:
        if not isinstance(body, dict) or not isinstance(body.get("materials"), list):
            raise ApiError(422, "materials must be a list", fields={"materials": "must be a list"})
        items, skipped = usermaterials.save(self.materials_file, body)
        return {"materials": items, "skipped": skipped, "file": str(self.materials_file)}

    def open_feedback(self, body: dict) -> dict:
        """Open an issue form of the public tracker in the system browser (the desktop app's
        "Send feedback"; its webview opens no windows). Any other URL is refused."""
        import webbrowser

        url = body.get("url")
        if not is_feedback_url(url):
            raise ApiError(422, "not a feedback link", fields={"url": "only the fairbeam-releases issue forms"})
        try:
            opened = bool(webbrowser.open(url))
        except webbrowser.Error:
            opened = False
        return {"opened": opened}

    @staticmethod
    def _public(m: dict) -> dict:
        public = {k: v for k, v in m.items() if k not in ("path", "mtime")}
        # Expose a sortable modification time, never the private filesystem path.
        modified = m.get("mtime")
        if isinstance(modified, (int, float)) and not isinstance(modified, bool):
            public["modified"] = modified
        return public

    def models(self) -> dict:
        items = []
        for m in self.registry.list():
            public = self._public(m) | {"readonly": modelfiles.is_readonly_file(m.get("file") or m["key"])}
            if m.get("kind") == "design":
                # The Python model remains editable after conversion. Tell the Home screen which
                # Design already came from each source so “Open as Design” reuses it instead of
                # creating another copy every time.
                try:
                    linked = modelfiles.read_design_file(self.models_dir, m["key"])["design"].get("python_source_model")
                except (modelfiles.ModelFileError, OSError, KeyError, TypeError):
                    linked = None
                if isinstance(linked, str):
                    public["python_source_model"] = linked
            items.append(public)
        return {"models": items}

    # ---- model files (editor)

    def templates_list(self) -> dict:
        if not self.templates_dir.is_dir():
            return {"templates": []}
        order = ["blank", "dipole", "monopole_on_ground", "patch_probe_fed", "microstrip_line"]
        items = [self._public(t) for t in self.templates.list()]
        items.sort(key=lambda t: (order.index(t["key"]) if t["key"] in order else len(order), t["key"]))
        return {"templates": items}

    def _validate_file(self, model_id: str) -> dict:
        """Load the saved file in the preview worker: PARAMS, or the error with its line."""
        path = modelfiles.model_path(self.models_dir, model_id)
        resp = self.preview.request({"op": "validate", "model_path": str(path)})
        if not resp.get("ok"):
            return {"valid": False, "error": {"message": resp.get("error"), "location": resp.get("location"),
                                              "stage": "load"}}
        r = resp["result"]
        out = {"valid": r["valid"], "model": self._public(r["model"]) | {"readonly": modelfiles.is_readonly(model_id)}}
        if not r["valid"]:
            out["error"] = r["error"]
        else:
            out["build_s"] = r.get("build_s")
        return out

    def create_model(self, body: dict) -> dict:
        model_id = modelfiles.check_id(body.get("id"))
        modelfiles.check_free(self.models_dir, model_id)
        name = body.get("name")
        if name is not None and (not isinstance(name, str) or "\n" in name or not name.strip() or len(name) > 80):
            raise ApiError(422, "invalid name", fields={"name": "a single line of 1–80 characters"})
        template, origin = body.get("template"), body.get("from")
        if bool(template) == bool(origin):
            raise ApiError(422, "give either template or from", fields={"template": "choose a template or a model to duplicate"})
        if template:
            t = self.templates.get(template)
            if t is None:
                raise ApiError(404, f"unknown template {template!r}", fields={"template": "unknown template"})
            source = Path(t["path"]).read_text(encoding="utf-8")
        else:
            source = modelfiles.read_model(self.models_dir, origin)["source"]
        modelfiles.create_model(self.models_dir, model_id, source, name.strip() if name else None)
        return {**modelfiles.read_model(self.models_dir, model_id), "validation": self._validate_file(model_id)}

    def _example_source(self, source_id: str, project: str | None):
        source_id = modelfiles.check_id(source_id)
        root = self.models_dir.resolve()
        source_paths = (root / f"{source_id}.py", root / f"{source_id}{modelfiles.DESIGN_SUFFIX}")
        found = [p for p in source_paths if p.exists() or p.is_symlink()]
        if not found:
            raise modelfiles.ModelFileError(404, f"no model {source_id}")
        if len(found) != 1:
            raise modelfiles.ModelFileError(409, f"ambiguous model key {source_id}")
        source = found[0]
        if source.is_symlink() or source.resolve().parent != root or not source.is_file():
            raise modelfiles.ModelFileError(403, "source must be a regular file inside the models folder")
        if not modelfiles.is_readonly_file(source.name):
            raise modelfiles.ModelFileError(403, "source must be a bundled, read-only example")
        overrides = None
        if project is not None:
            if not isinstance(project, str) or project not in modelfiles.BUNDLED_PROJECT_FILES:
                raise ApiError(422, "project must be a bundled example")
            project_path = self.projects_dir / project
            if project_path.is_symlink() or not project_path.is_file() or project_path.resolve().parent != self.projects_dir:
                raise ApiError(404, f"bundled example {project} is unavailable")
            try:
                result = json.loads(project_path.read_text(encoding="utf-8"))
                if result["model"]["id"] != source_id.replace("_", "-"):
                    raise ValueError("project model does not match the source")
                overrides = {p["key"]: str(p["value"]) for p in result["model"]["params"]}
            except (KeyError, TypeError, ValueError, UnicodeError, json.JSONDecodeError) as e:
                raise ApiError(422, f"invalid bundled example: {e}") from None
        return source, root, overrides

    def _converted_example(self, source: Path, source_id: str, overrides, project) -> dict:
        """conversion_preview of a bundled Python example, kept for the Copy that follows the
        dialog's preview (the conversion's mesh search takes 0.2-3 s). Only model.id and model.name
        depend on the new design's id and name; copy_example sets those. Keyed on the file's mtime,
        the overrides and the project; a few entries at most."""
        from .example_design import ExampleConversionError, conversion_preview
        key = (str(source), source.stat().st_mtime_ns, json.dumps(overrides, sort_keys=True), project)
        cache = self.__dict__.setdefault("_conversions", collections.OrderedDict())
        if key in cache:
            cache.move_to_end(key)
            return copy.deepcopy(cache[key])
        try:
            preview = conversion_preview(source, source_id, source.stem, overrides, project)
        except ExampleConversionError as e:
            raise ApiError(422, str(e), reason=str(e)) from None
        cache[key] = preview
        while len(cache) > 4:
            cache.popitem(last=False)
        return copy.deepcopy(preview)

    def preview_example_conversion(self, body: dict) -> dict:
        source_id = modelfiles.check_id(body.get("from"))
        source, _, overrides = self._example_source(source_id, body.get("project"))
        if source.suffix != ".py":
            return {"source_cells": None, "design_cells": None, "within_tolerance": None}
        preview = self._converted_example(source, source_id, overrides, body.get("project"))
        # the counts of parameters and expressions are absent from a stand-in converter (tests)
        return {key: preview[key] for key in ("source_cells", "design_cells", "within_tolerance", "params_carried",
                                              "params_total", "params_partial", "expressions") if key in preview}

    def copy_example(self, body: dict) -> dict:
        model_id = modelfiles.check_id(body.get("id"))
        name = body.get("name")
        if not isinstance(name, str) or "\n" in name or "\r" in name or not 1 <= len(name.strip()) <= 80:
            raise ApiError(422, "invalid name", fields={"name": "a single line of 1–80 characters"})
        source_id = modelfiles.check_id(body.get("from"))
        source, root, overrides = self._example_source(source_id, body.get("project"))
        modelfiles.check_free(root, model_id)
        project = body.get("project")
        if source.suffix == ".py":
            # the same conversion as the preview (without a project, overrides and origin are None
            # on both paths), then the new design's own id and name
            design = self._converted_example(source, source_id, overrides, project)["design"]
            design["model"] = {**design["model"], "id": model_id.replace("_", "-"), "name": name.strip()}
        else:
            try:
                design = json.loads(source.read_text(encoding="utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as e:
                raise ApiError(422, f"invalid Design source: {e}", reason=str(e)) from None
            if not isinstance(design, dict) or not isinstance(design.get("model"), dict):
                raise ApiError(422, "design model metadata is invalid", reason="design model metadata is invalid")
            design = {**design, "model": {**design["model"], "id": model_id.replace("_", "-"), "name": name.strip()}}
        modelfiles.create_design(root, model_id, design)
        return {"id": model_id, "kind": "design", "validation": self._validate_design(model_id)}
    # ---- design files (designer)

    def _validate_design(self, model_id: str) -> dict:
        path = modelfiles.design_path(self.models_dir, model_id)
        resp = self.preview.request({"op": "validate", "model_path": str(path)})
        if not resp.get("ok"):
            return {"valid": False, "error": {"message": resp.get("error"), "location": resp.get("location"),
                                              "stage": "load"}}
        r = resp["result"]
        out = {"valid": r["valid"], "model": self._public(r["model"]) | {"readonly": modelfiles.is_readonly(model_id, design=True)},
               "checks": r.get("checks", [])}
        if not r["valid"]:
            out["error"] = r["error"]
        else:
            out["build_s"] = r.get("build_s")
        return out

    def _design_checks(self, design) -> list:
        """The checks of an unsaved design (fairbeam.design_checks), with its preview bundle when
        the preview worker builds it; without the build-dependent ones if the worker cannot."""
        from .design_checks import lint

        try:
            resp = self.preview.request({"op": "preview_design", "design": design, "overrides": {}})
        except ApiError:
            return lint(design)
        if resp.get("ok"):
            return resp["result"].get("checks", [])
        return resp.get("checks") if resp.get("checks") is not None else lint(design)

    def _free_design_id(self, name: str) -> str:
        """A free model id for a design named ``name`` (an imported design file): the name in lower case with "_"
        between words, as the Start page derives it, then _2, _3 ... until the id is free. Never a bundled
        example's id (those are read-only) nor a name Windows reserves for devices."""
        import unicodedata

        base = unicodedata.normalize("NFKD", name.lower().replace("ı", "i"))
        base = "".join(c for c in base if not unicodedata.combining(c))
        base = re.sub(r"_+$", "", re.sub(r"^[^a-z]+", "", re.sub(r"[^a-z0-9]+", "_", base)))[:41]
        if not modelfiles.ID_RE.match(base or ""):
            base = "imported_design"

        def free(candidate: str) -> bool:
            return (modelfiles.ID_RE.match(candidate) is not None and not modelfiles.RESERVED_ID_RE.match(candidate)
                    and not modelfiles.is_readonly(candidate) and not modelfiles._taken(self.models_dir, candidate))

        if free(base):
            return base
        for n in range(2, 1000):
            candidate = f"{base[:41 - len(str(n)) - 1]}_{n}"
            if free(candidate):
                return candidate
        raise ApiError(409, f"no free file name for {name!r}", fields={"id": "choose another name"})

    def create_design(self, body: dict) -> dict:
        from .design import DesignError, template_design

        name = body.get("name")
        if name is not None and (not isinstance(name, str) or "\n" in name or not name.strip() or len(name) > 80):
            raise ApiError(422, "invalid name", fields={"name": "a single line of 1–80 characters"})
        imported = body.get("design")
        if imported is not None:
            # a design file (fairbeam.design/1, e.g. Export > Current design JSON) opened or dropped in the app: a new
            # design under a free id from its name unless the request names one; the design validator checks it
            if not isinstance(imported, dict) or not isinstance(imported.get("model"), dict):
                raise ApiError(422, "design must be a design file object", fields={"design": "not a fairbeam.design/1 object"})
            label = name or imported["model"].get("name") or imported["model"].get("id") or "Imported design"
            model_id = modelfiles.check_id(body["id"]) if body.get("id") is not None else self._free_design_id(str(label))
        else:
            model_id = modelfiles.check_id(body.get("id"))
        modelfiles.check_free(self.models_dir, model_id)
        origin = body.get("from")
        report = None
        if imported is not None:
            design = copy.deepcopy(imported)
            if name:
                design["model"]["name"] = name.strip()
        elif body.get("cst") is not None:
            cst = body["cst"]
            if not isinstance(cst, dict):
                raise ApiError(422, "cst must be an object with the macro source", fields={"cst": "not an object"})
            imported = self._import_cst(cst.get("source"), cst.get("filename"), name, model_id.replace("_", "-"))
            design, report = imported["design"], imported["report"]
            self._fit_imported_mesh(design, report)
        elif body.get("pcb") is not None:
            pcb = body["pcb"]
            if not isinstance(pcb, dict):
                raise ApiError(422, "pcb must be an object with the files", fields={"pcb": "not an object"})
            imported = self._import_pcb(pcb.get("files"), pcb.get("options"), name, model_id.replace("_", "-"))
            design, report = imported["design"], imported["report"]
            self._fit_imported_mesh(design, report)
        elif body.get("python") is not None:
            python = body["python"]
            if not isinstance(python, dict) or set(python) - {"source_model", "model"}:
                raise ApiError(422, "python must name a source model", fields={"python": "use {source_model, model?}"})
            source_model = python.get("source_model")
            if not isinstance(source_model, str):
                raise ApiError(422, "python source_model is required", fields={"python.source_model": "a Python model id"})
            try:
                source_model = modelfiles.check_id(source_model)
                source = modelfiles.read_model(self.models_dir, source_model)
            except modelfiles.ModelFileError as e:
                raise ApiError(e.status, e.message, **e.extra) from None
            converted = self.design_from_python({"source": source["source"], "model": python.get("model")})
            # Keep the conversion and its origin in one atomic design-file creation. The editable
            # Python model remains the source of truth shown in the Design Python panel until the
            # user edits the Design or applies another script.
            latest = modelfiles.read_model(self.models_dir, source_model)
            if latest["hash"] != source["hash"]:
                raise ApiError(409, "the Python model changed while its Design was being created; try again",
                               current_hash=latest["hash"])
            design = converted["design"]
            design["python_source_model"] = source_model
            design["python_source_hash"] = source["hash"]
            if name:
                design["model"]["name"] = name.strip()
        elif origin:
            design = modelfiles.read_design_file(self.models_dir, modelfiles.check_id(origin))["design"]
            if name:
                design = {**design, "model": {**design["model"], "name": name.strip()}}
        else:
            template = body.get("template") or "patch"
            try:
                design = template_design(template, model_id.replace("_", "-"), (name or model_id).strip())
            except DesignError as e:
                raise ApiError(422, str(e), fields={"template": e.detail}) from None
        modelfiles.create_design(self.models_dir, model_id, design)
        out = {**self.design_file(model_id), "validation": self._validate_design(model_id)}
        if report is not None:
            out["import_report"] = report
        return out

    @staticmethod
    def _import_cst(source, filename, name, model_id: str = "imported-cst") -> dict:
        from .cst_import import CstImportError, import_cst

        if not isinstance(source, str) or not source.strip():
            raise ApiError(422, "the CST macro is empty", fields={"source": "choose a .bas, .mcs or .txt macro file"})
        if filename is not None and (not isinstance(filename, str) or len(filename) > 255 or "\n" in filename):
            raise ApiError(422, "invalid file name", fields={"filename": "a file name of at most 255 characters"})
        if name is not None and (not isinstance(name, str) or "\n" in name or not name.strip() or len(name) > 80):
            raise ApiError(422, "invalid name", fields={"name": "a single line of 1–80 characters"})
        short = filename.replace("\\", "/").rsplit("/", 1)[-1] if filename else None
        try:
            return import_cst(source, model_id=model_id, name=name.strip() if name else None, filename=short)
        except CstImportError as e:
            raise ApiError(422, str(e), fields={"source": str(e)}) from None

    def import_cst(self, body: dict) -> dict:
        """A CST macro as a design, not saved: the design, the import report and the design checks
        (the Start page shows them before the design is named and created)."""
        imported = self._import_cst(body.get("source"), body.get("filename"), body.get("name"), "imported-cst")
        return {**imported, "checks": self._fit_imported_mesh(imported["design"], imported["report"])}

    PCB_OPTIONS = {"layer_map", "substrate", "thickness", "eps_r", "tan_d", "f0", "units", "chord_tol", "margin", "origin"}

    @staticmethod
    def _pcb_files(files) -> list:
        """``[(name, bytes)]`` of the request's ``files`` (``[{name, content_base64}]``), strictly checked."""
        import base64
        import binascii

        if not isinstance(files, list) or not files:
            raise ApiError(422, "no files to import", fields={"files": "choose at least one .dxf, Gerber or Excellon file"})
        if len(files) > MAX_PCB_FILES:
            raise ApiError(422, f"{len(files)} files; at most {MAX_PCB_FILES} can be imported together",
                           fields={"files": f"at most {MAX_PCB_FILES} files"})
        out, names, total = [], set(), 0
        for i, f in enumerate(files):
            where = f"files[{i}]"
            if not isinstance(f, dict) or set(f) - {"name", "content_base64"}:
                raise ApiError(422, f"{where} must be {{name, content_base64}}", fields={"files": f"{where}: not {{name, content_base64}}"})
            name, data = f.get("name"), f.get("content_base64")
            if not isinstance(name, str) or not name.strip() or len(name) > 255 or any(ord(c) < 32 for c in name):
                raise ApiError(422, f"{where}: invalid file name", fields={"files": f"{where}: a file name of 1–255 characters"})
            name = name.replace("\\", "/").rsplit("/", 1)[-1].strip()
            if not name or name in (".", ".."):
                raise ApiError(422, f"{where}: invalid file name", fields={"files": f"{where}: a file name of 1–255 characters"})
            if name.lower() in names:
                raise ApiError(422, f"{name} is listed twice", fields={"files": f"{name} is listed twice"})
            names.add(name.lower())
            if not isinstance(data, str):
                raise ApiError(422, f"{name}: content_base64 must be a string", fields={"files": f"{name}: no content"})
            # the size before the decode: 4 characters carry 3 bytes
            if len(data) * 3 // 4 > MAX_PCB_FILE + 3:
                raise ApiError(413, f"{name} is larger than {MAX_PCB_FILE // 1_000_000} MB",
                               fields={"files": f"{name}: larger than {MAX_PCB_FILE // 1_000_000} MB"})
            try:
                raw = base64.b64decode(data, validate=True)
            except (binascii.Error, ValueError):
                raise ApiError(422, f"{name}: content_base64 is not valid base64", fields={"files": f"{name}: not base64"}) from None
            if not raw.strip():
                raise ApiError(422, f"{name} is empty", fields={"files": f"{name} is empty"})
            if len(raw) > MAX_PCB_FILE:
                raise ApiError(413, f"{name} is larger than {MAX_PCB_FILE // 1_000_000} MB",
                               fields={"files": f"{name}: larger than {MAX_PCB_FILE // 1_000_000} MB"})
            total += len(raw)
            if total > MAX_PCB_TOTAL:
                raise ApiError(413, f"the files together are larger than {MAX_PCB_TOTAL // 1_000_000} MB",
                               fields={"files": f"together larger than {MAX_PCB_TOTAL // 1_000_000} MB"})
            out.append((name, raw))
        return out

    @classmethod
    def _pcb_options(cls, options) -> dict:
        """The keyword arguments of ``import_pcb`` from the request's ``options`` (numbers finite and in range)."""
        from .pcb_import import ROLES

        if options is None:
            return {}
        if not isinstance(options, dict):
            raise ApiError(422, "options must be an object", fields={"options": "not an object"})
        unknown = sorted(set(options) - cls.PCB_OPTIONS)
        if unknown:
            raise ApiError(422, f"unknown option {unknown[0]!r}", fields={"options": f"unknown option {unknown[0]!r}"})
        kw: dict = {}

        def number(key, lo, hi, *, lo_open=False, allow_none=False):
            v = options.get(key)
            if v is None and allow_none:
                return
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) \
                    or v < lo or v > hi or (lo_open and v == lo):
                raise ApiError(422, f"{key} must be a number {'above' if lo_open else 'from'} {lo:g} to {hi:g}",
                               fields={key: f"a number {'above' if lo_open else 'from'} {lo:g} to {hi:g}"})
            kw[key] = float(v)

        for key, lo, hi, opened, none_ok in (("thickness", 0, 100, True, False), ("eps_r", 1, 200, False, True),
                                             ("tan_d", 0, 1, False, True), ("f0", 0, 1000, True, False),
                                             ("chord_tol", 1e-4, 5, False, False), ("margin", 0, 1000, False, False)):
            if key in options:
                number(key, lo, hi, lo_open=opened, allow_none=none_ok)
        if options.get("substrate") is not None:
            sub = options["substrate"]
            if not isinstance(sub, str) or not sub.strip() or len(sub) > 40 or any(ord(c) < 32 for c in sub):
                raise ApiError(422, "invalid substrate", fields={"substrate": "a library id or a name of 1–40 characters"})
            kw["substrate"] = sub.strip()
        for key, allowed in (("units", ("auto", "mm", "inch")), ("origin", ("center", "keep"))):
            if options.get(key) is not None:
                if options[key] not in allowed:
                    raise ApiError(422, f"{key} must be one of {', '.join(allowed)}",
                                   fields={key: f"one of {', '.join(allowed)}"})
                kw[key] = options[key]
        lmap = options.get("layer_map")
        if lmap is not None:
            if not isinstance(lmap, dict) or len(lmap) > 200:
                raise ApiError(422, "layer_map must be an object of layer name to role (at most 200 entries)",
                               fields={"layer_map": "an object of layer name to role"})
            for k, v in lmap.items():
                if not isinstance(k, str) or not k or len(k) > 255 or not isinstance(v, str) or v.strip().lower() not in ROLES:
                    raise ApiError(422, f"layer_map entry {str(k)[:60]!r}: the role must be one of {', '.join(ROLES)}",
                                   fields={"layer_map": f"the role must be one of {', '.join(ROLES)}"})
            kw["layer_map"] = {k: v.strip().lower() for k, v in lmap.items()}
        return kw

    @classmethod
    def _import_pcb(cls, files, options, name, model_id: str = "imported-pcb") -> dict:
        from .pcb_import import PcbImportError, import_pcb

        if name is not None and (not isinstance(name, str) or "\n" in name or not name.strip() or len(name) > 80):
            raise ApiError(422, "invalid name", fields={"name": "a single line of 1–80 characters"})
        sources = cls._pcb_files(files)
        kw = cls._pcb_options(options)
        try:
            return import_pcb(sources, model_id=model_id, name=name.strip() if name else None, **kw)
        except PcbImportError as e:
            # with the layers that were read, when the files parse but nothing is copper yet (the dialog
            # lists them so that the copper can be chosen)
            extra = {"layers": e.detected} if e.detected is not None else {}
            raise ApiError(422, str(e), fields={"files": str(e)}, **extra) from None
        except (ValueError, ArithmeticError, LookupError, TypeError, RecursionError) as e:
            # an unforeseen shape of a file must not become a 500 with a traceback
            raise ApiError(422, f"the files could not be imported ({type(e).__name__}); export them again or report them",
                           fields={"files": type(e).__name__}) from None

    def import_pcb(self, body: dict) -> dict:
        """PCB artwork as a design, not saved: the design, the import report, its layers (role and why) and the design
        checks (the import dialog shows them before the design is named and created)."""
        unknown = sorted(set(body) - {"files", "options", "name"})
        if unknown:
            raise ApiError(422, f"unknown field {unknown[0]!r}", fields={unknown[0]: "not a field of the request"})
        imported = self._import_pcb(body.get("files"), body.get("options"), body.get("name"))
        checks = self._fit_imported_mesh(imported["design"], imported["report"])
        return {**imported, "layers": imported["report"]["detected"], "checks": checks}

    def _fit_imported_mesh(self, design: dict, report: dict) -> list:
        """The checks of an imported design; a mesh over the cell limit (a macro without mesh
        settings, a band starting near 0 Hz) starts coarser, as a converted example does."""
        def too_big(checks):
            return any(c.get("code") == "mesh-cells" and c.get("severity") == "error" for c in checks)

        checks = self._design_checks(design)
        mesh = design.get("mesh") or {}
        if mesh.get("mode") == "manual":
            # the exported model's own lines: a coarser density would not change them (and a stray
            # cells_per_wavelength would be saved with them); the checks report a mesh over the limit
            return checks
        target = mesh.setdefault("overrides", {}) if mesh.get("mode") == "design" else mesh
        start = target.get("cells_per_wavelength", 20)
        if not too_big(checks) or not isinstance(start, (int, float)):
            if mesh.get("mode") == "design" and not mesh["overrides"]:
                del mesh["overrides"]
            return checks
        for cpw in (16, 14, 12, 10, 8):
            if cpw >= start:
                continue
            target["cells_per_wavelength"] = cpw
            air = target.get("air_cells_per_wavelength")
            if isinstance(air, (int, float)) and air > cpw:
                target["air_cells_per_wavelength"] = cpw
            checks = self._design_checks(design)
            if not too_big(checks):
                break
        report["notes"].insert(0, {"severity": "warning", "where": "mesh", "line": 0, "message":
                                   f"the mesh starts at {target['cells_per_wavelength']} cells per wavelength (from {start}) to stay "
                                   "under the cell limit; refine it for a convergence study"})
        report["warnings"] = report.get("warnings", 0) + 1
        return checks

    def design_file(self, model_id: str) -> dict:
        return {**modelfiles.read_design_file(self.models_dir, model_id), "backup_scope": self.backup_scope}

    def _require_backup_scope(self, body: dict) -> None:
        # Omission preserves old clients. A supplied unknown/mismatched scope is never a fallback.
        if "backup_scope" in body and body["backup_scope"] != self.backup_scope:
            raise ApiError(409, "the workspace changed; reopen the design before changing or deleting it",
                           workspace_error="scope_mismatch")

    def save_design(self, model_id: str, body: dict) -> dict:
        """Save a design, finished or not: a work in progress may have check errors (they come
        back in validation.checks). Only a structurally broken file is refused (422); errors
        block running it instead (_refuse_broken_design)."""
        self._require_backup_scope(body)
        res = modelfiles.save_design(self.models_dir, self.history_dir, model_id, body.get("design"), body.get("base_hash"))
        return {"id": model_id, **res, "backup_scope": self.backup_scope, "validation": self._validate_design(model_id)}

    def rename_design(self, model_id: str, body: dict) -> dict:
        """Change display metadata only, preserving file id and all result associations."""
        self._require_backup_scope(body)
        name = body.get("name")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 80 or any(ord(c) < 32 for c in name):
            raise ApiError(422, "use a non-empty single-line name of at most 80 characters", name_error="invalid")
        name = name.strip()
        with self.design_name_lock:
            record = modelfiles.read_design_file(self.models_dir, model_id)
            for path in self.models_dir.glob("*.design.json"):
                # the bundled example designs are not the user's: a design may share a name with one
                if path.name == record["file"] or modelfiles.is_readonly_file(path.name):
                    continue
                try:
                    other = json.loads(path.read_text(encoding="utf-8"))
                    other_name = other.get("model", {}).get("name")
                except (ValueError, OSError, AttributeError):
                    continue
                if isinstance(other_name, str) and other_name.strip().casefold() == name.casefold():
                    raise ApiError(409, "another design already has this display name", name_error="duplicate")
            design = record["design"]
            previous = design["model"]["name"]
            design["model"]["name"] = name
            result = modelfiles.save_design(self.models_dir, self.history_dir, model_id, design, body.get("base_hash"))
        return {"id": model_id, "file": record["file"], "name": name, "previous_name": previous, "backup_scope": self.backup_scope, **result}

    # ---- rendered images: <workspace>/renders/<design id>/ (python/fairbeam/renders.py)

    @property
    def workspace(self) -> Path:
        return self.models_dir.parent

    def save_render(self, design_id: str, body: dict) -> dict:
        data = renders.decode(body.get("data"))
        path = renders.save_png(self.workspace, design_id, body.get("name"), data)
        return {"id": design_id, "name": path.name, "path": str(path), "size": len(data)}

    def open_renders(self, design_id: str, body: dict | None = None) -> dict:
        """Show the design's renders folder (default), or launch Blender (GUI) on one of its saved .blend files."""
        body = body or {}
        what = body.get("what", "folder")
        if what == "folder":
            return {"id": design_id, "dir": str(renders.open_folder(self.workspace, design_id))}
        if what == "blend":
            blend = renders.render_path(self.workspace, design_id, str(body.get("file") or ""))
            if blend.suffix != ".blend":
                raise ApiError(422, "file must be a .blend")
            info = blender_find.detect(body.get("blender") if isinstance(body.get("blender"), str) else None)
            if not info["found"]:
                raise ApiError(409, "Blender was not found")
            blender_job.open_in_blender(info["path"], blend)
            return {"id": design_id, "ok": True}
        raise ApiError(422, "what must be folder or blend")

    def design_location(self, model_id: str) -> dict:
        # design_path validates the id, containment and symlinks before exposing a local location.
        path = modelfiles.design_path(self.models_dir, model_id)
        if not path.is_file():
            raise ApiError(404, "design file no longer exists")
        return {"id": model_id, "path": str(path)}

    def delete_design(self, model_id: str, body: dict | None = None) -> dict:
        """Move a design out of the models folder into its history (modelfiles.delete_design); not
        while one of its runs is queued or running."""
        from .progress import TERMINAL

        self._require_backup_scope(body or {})
        modelfiles.check_id(model_id)
        busy = [j for j in self.manager.list() if j.get("model") == model_id and j.get("status") not in TERMINAL]
        if busy:
            raise ApiError(409, f"{model_id} has a run in progress; cancel it or wait for it to finish first")
        return {**modelfiles.delete_design(self.models_dir, self.history_dir, model_id), "backup_scope": self.backup_scope}

    def _refuse_broken_design(self, m: dict, *, overrides: dict | None = None,
                              require_mesh: bool = False) -> int | None:
        """Refuse check errors; single-run admission also returns the exact built mesh count.

        Save/batch validation retains its existing default-parameter checks and fallback.
        A single-run resource estimate must come from a successful admitted-input build.
        """
        if m.get("kind") != "design":
            return
        try:
            admitted_text = m.get("_queued_design") or Path(m["path"]).read_bytes().decode("utf-8")
            design = json.loads(admitted_text)
        except (OSError, json.JSONDecodeError) as e:
            raise ApiError(422, f"the design file cannot be read: {e}")
        result = None
        if require_mesh:
            resp = self.preview.request({"op": "preview_design", "design": design,
                                         "overrides": overrides or {}})
            result = resp.get("result") if resp.get("ok") else None
            checks = result.get("checks", []) if isinstance(result, dict) else resp.get("checks") or []
            if not resp.get("ok") and not any(c.get("severity") == "error" for c in checks):
                raise ApiError(422 if resp.get("kind") == "validation" else 500,
                               resp.get("error") or "the admitted design mesh could not be built")
        else:
            checks = self._design_checks(design)
        errs = [c for c in checks if c["severity"] == "error"]
        if errs:
            fields: dict = {}
            for c in errs:
                fields.setdefault(c["path"] or "_", c["message"])
            more = f" (and {len(errs) - 1} more)" if len(errs) > 1 else ""
            raise ApiError(422, f"fix the design before running it: {errs[0]['message']}{more}", fields=fields, checks=checks)

        m["_queued_design"] = admitted_text
        if require_mesh:
            cells = ((result or {}).get("bundle") or {}).get("mesh", {}).get("total_cells")
            if isinstance(cells, bool) or not isinstance(cells, int) or cells <= 0:
                raise ApiError(422, "the admitted design mesh cell count is unavailable; the run was not queued")
            return cells

    def design_python(self, model_id: str) -> dict:
        from .design import DesignError, to_python

        d = modelfiles.read_design_file(self.models_dir, model_id)["design"]
        try:
            return {"id": model_id, "source": to_python(d)}
        except DesignError as e:
            raise ApiError(422, str(e), fields={e.where or "_": e.detail}) from None

    def design_from_python(self, body: dict) -> dict:
        """A Python model script as a design, not saved (the designer's Python panel, Apply)."""
        from .python_design import ScriptError, apply_script

        source = body.get("source")
        if not isinstance(source, str):
            raise ApiError(422, "the script is missing", fields={"source": "a string"})
        model = body.get("model")
        if model is not None and not (isinstance(model, dict) and all(isinstance(k, str) and isinstance(v, str) and len(v) < 4000 for k, v in model.items())):
            raise ApiError(422, "invalid model", fields={"model": "an object of strings"})
        lock = self.__dict__.setdefault("_script_lock", threading.Lock())
        if not lock.acquire(blocking=False):
            raise ApiError(429, "another script is being applied; try again in a moment")
        try:
            return apply_script(source, model=model)
        except ScriptError as e:
            extra = {"line": e.line} if e.line else {}
            raise ApiError(422, e.message, timeout=e.timeout, **extra) from None
        finally:
            lock.release()

    def model_source(self, model_id: str) -> dict:
        return modelfiles.read_model(self.models_dir, model_id)

    def save_source(self, model_id: str, body: dict) -> dict:
        res = modelfiles.save_model(self.models_dir, self.history_dir, model_id, body.get("source"), body.get("base_hash"))
        return {"id": model_id, **res, "validation": self._validate_file(model_id)}

    def _model(self, body: dict) -> dict:
        key = body.get("model")
        m = self.registry.get(key) if isinstance(key, str) else None
        if m is None:
            raise ApiError(404, f"unknown model {key!r}", fields={"model": "unknown model"})
        if "error" in m:
            raise ApiError(422, f"model {key} does not load: {m['error']}", fields={"model": m["error"]})
        return m

    def _validated(self, body: dict):
        m = dict(self._model(body))
        if m.get("kind") == "design":
            from .design import design_params
            from .preview import param_spec
            try:
                text = Path(m["path"]).read_bytes().decode("utf-8")
                design = json.loads(text)
                if design.get("model", {}).get("id") != (m.get("model") or {}).get("id"):
                    raise ValueError("design identity changed; refresh before submitting")
                m["params"] = [param_spec(p) for p in design_params(design)]
                m["_queued_design"] = text
            except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
                raise ApiError(422, f"the design file cannot be read: {e}") from None
        resolved, overrides, errors = validate_params(m["params"], body.get("params") or {})
        if errors:
            raise ApiError(422, "invalid parameters", fields=errors)
        return m, resolved, overrides

    def do_preview(self, body: dict) -> dict:
        if "design" in body:
            return self._preview_design(body)
        m, resolved, overrides = self._validated(body)
        t0 = time.time()
        request = {"op": "preview", "model_path": m["path"], "overrides": overrides}
        if m.get("_queued_design") is not None:
            request = {"op": "preview_design", "design": json.loads(m["_queued_design"]), "overrides": overrides}
        resp = self.preview.request(request)
        if not resp.get("ok"):
            status = 422 if resp.get("kind") == "validation" else 500
            raise ApiError(status, resp.get("error") or "preview failed",
                           **({"fields": {"_": resp["error"]}} if status == 422 else {}),
                           **({"traceback": resp["traceback"]} if resp.get("traceback") else {}))
        r = resp["result"]
        return {"model": m["key"], "params": resolved, "overrides": overrides, "build_s": r["build_s"],
                "elapsed_s": round(time.time() - t0, 3), "bundle": r["bundle"]}

    def _preview_design(self, body: dict) -> dict:
        """Geometry of an unsaved design (the designer's current state), with optional overrides."""
        design = body.get("design")
        if not isinstance(design, dict):
            raise ApiError(422, "design must be a JSON object", fields={"design": "not an object"})
        overrides = body.get("params") or {}
        if not isinstance(overrides, dict):
            raise ApiError(422, "params must be an object", fields={"params": "not an object"})
        t0 = time.time()
        resp = self.preview.request({"op": "preview_design", "design": design,
                                     "overrides": {str(k): str(v) for k, v in overrides.items()}})
        if not resp.get("ok"):
            status = 422 if resp.get("kind") == "validation" else 500
            loc = resp.get("location") or {}
            raise ApiError(status, resp.get("error") or "preview failed",
                           **({"fields": {loc.get("path") or "_": resp.get("detail") or resp.get("error")}} if status == 422 else {}),
                           **({"traceback": resp["traceback"]} if resp.get("traceback") else {}),
                           checks=resp.get("checks") or [])
        r = resp["result"]
        return {"model": design.get("model", {}).get("id"), "build_s": r["build_s"],
                "elapsed_s": round(time.time() - t0, 3), "bundle": r["bundle"], "checks": r.get("checks", [])}

    def _settings(self, body: dict, errors: dict) -> dict:
        """threads / engine / end criterion / run name, shared by runs and sweeps."""
        threads = body.get("threads")
        cells = body.get("cells")
        if threads is None or threads == "auto":  # Auto: physical cores, capped by the grid size
            threads = resources.auto_threads(self.cpu, self.physical, cells if isinstance(cells, (int, float)) else None)
        elif isinstance(threads, bool) or not isinstance(threads, int) or not 1 <= threads <= self.cpu:
            errors["threads"] = f"must be a whole number from 1 to {self.cpu}"
        # absent or null: the model's/design's own threshold (the child gets no --end-db)
        end_db = body.get("end_criteria_db")
        if end_db is not None and (isinstance(end_db, bool) or not isinstance(end_db, (int, float))
                                   or not -300 <= end_db < 0):
            errors["end_criteria_db"] = "must be a negative number of dB"
        engine = body.get("engine") or "cpu"
        if engine not in self.engines:
            errors["engine"] = f"must be one of {', '.join(self.engines)}"
        elif engine == "gpu":
            threads = 1
            errors.pop("threads", None)
        points = body.get("points")
        if points is not None and (isinstance(points, bool) or not isinstance(points, int) or not 11 <= points <= 20001):
            errors["points"] = "must be a whole number from 11 to 20001"
        label = body.get("name") or None
        slug = None
        if label is not None:
            if not isinstance(label, str) or "\n" in label or len(label.strip()) > 80:
                errors["name"] = "a single line of at most 80 characters"
            else:
                label = label.strip()
                slug = slugify(label) if label else None
                label = label or None
                if label and (not slug or slug == "index" or not NAME_RE.match(slug)):
                    errors["name"] = "needs at least one letter or digit"
        return {"threads": threads,
                "end_criteria_db": float(end_db) if end_db is not None and not errors.get("end_criteria_db") else None,
                "engine": engine, "label": label, "name": slug, "points": points if not errors.get("points") else None}

    def _refuse_by_preflight(self, body: dict, st: dict) -> None:
        """Memory and CPU check for a batch (sweep, convergence, optimization) from the largest
        expected cell count the client sends as ``cells``; refuses like a single run does."""
        pre = self.preflight({"cells": body.get("cells"), "engine": st["engine"]})
        if pre["level"] == "refuse":
            raise ApiError(422, pre["messages"][0], preflight=pre)

    def submit(self, body: dict) -> dict:
        m, resolved, overrides = self._validated(body)
        cells = self._refuse_broken_design(m, overrides=overrides, require_mesh=True)
        admission_body = {**body, "cells": cells} if cells is not None else body
        errors: dict = {}
        st = self._settings(admission_body, errors)
        if errors:
            raise ApiError(422, "invalid run settings", fields=errors)
        pre = self.preflight({"cells": admission_body.get("cells"), "engine": st["engine"]})
        if cells is not None:
            pre = {**pre, "cells": cells, "source": "admitted-design-preview",
                   "input_sha256": hashlib.sha256(m["_queued_design"].encode("utf-8")).hexdigest(),
                   "overrides": dict(overrides)}
        if pre["level"] == "refuse":
            raise ApiError(422, pre["messages"][0], preflight=pre)
        job = self.manager.submit(model=m["key"], model_id=(m.get("model") or {}).get("id"), model_path=m["path"], design_input=m.get("_queued_design"),
                                  params=resolved, overrides=overrides, **st)
        return {**job.to_dict(), "preflight": pre}

    def external_runs(self) -> list[dict]:
        """``fairbeam run`` processes started outside this server (a terminal, a script) that write
        their raw data into this server's sim root (simdata.live_runs)."""
        from .simdata import live_runs

        root = getattr(self, "sim_root", None)  # an App assembled without __init__ (tests) has none
        return live_runs(root) if root is not None else []

    def clear_queue(self) -> dict:
        """Cancel every queued job; the running one keeps running (POST /api/runs/{id}/cancel)."""
        cancelled = self.manager.clear_queue()
        return {"cancelled": [j.id for j in cancelled], "runs": [j.to_dict() for j in cancelled]}

    def preflight(self, body: dict) -> dict:
        """Memory and CPU-contention check before a run (fairbeam.resources.preflight)."""
        engine = body.get("engine") or "cpu"
        if engine not in self.engines:
            raise ApiError(422, "invalid preflight", fields={"engine": f"must be one of {', '.join(self.engines)}"})
        return resources.preflight(body.get("cells"), engine, resources.free_memory_bytes(),
                                   busy=self.manager.current is not None, load=resources.host_load(), cpus=self.cpu,
                                   external=len(self.external_runs()))

    def submit_sweep(self, body: dict) -> dict:
        m, base, _ = self._validated(body)
        self._refuse_broken_design(m)
        errors: dict = {}
        st = self._settings(body, errors)
        if "sequences" in body:
            combos, sequences, sweep_errors = expand_sequences(m["params"], body.get("sequences"))
        else:
            axes_combos, axes, sweep_errors = expand_sweep(m["params"], base, body.get("sweep"))
            sequences = [{"name": "Sweep", "axes": axes, "total": len(axes_combos)}]
            combos = [{"sequence_index": 0, "sequence_name": "Sweep", "values": values}
                      for values in axes_combos]
        errors.update(sweep_errors)
        if errors:
            raise ApiError(422, "invalid sweep", fields=errors)
        self._refuse_by_preflight(body, st)
        sweep_id = "sw-" + time.strftime("%Y%m%d-%H%M%S") + "-" + os.urandom(2).hex()
        model_name = (m.get("model") or {}).get("name") or m["key"]
        name = st["label"] or f"{model_name} · sweep " + ", ".join(s["name"] for s in sequences)
        jobs = []
        used_names: set[str] = set()
        prepared = []
        for i, item in enumerate(combos):
            combo = item["values"]
            resolved, overrides, errs = validate_params(m["params"], {**base, **combo})
            if errs:
                raise ApiError(422, "invalid sweep", fields=errs)
            file_name = None
            if st["name"]:
                # the combination must survive slugify's length cap, or runs overwrite each other
                combo_part = slugify("--".join(f"{k}-{_fmt_float(v) if isinstance(v, float) else v}" for k, v in combo.items()))
                file_name = f"{slugify(st['name'])[:40]}--{combo_part[:56]}"
                if file_name in used_names:
                    file_name = f"{file_name}-{i + 1:03d}"
                used_names.add(file_name)
            prepared.append((resolved, overrides, file_name, item))
        # All validation is complete before anything is queued.
        for i, (resolved, overrides, file_name, item) in enumerate(prepared):
            job = self.manager.submit(
                model=m["key"], model_id=(m.get("model") or {}).get("id"), model_path=m["path"], design_input=m.get("_queued_design"), params=resolved,
                overrides=overrides, threads=st["threads"], engine=st["engine"],
                end_criteria_db=st["end_criteria_db"], name=file_name, label=st["label"],
                sweep={"id": sweep_id, "name": name, "index": i, "total": len(combos),
                       "values": item["values"], "axes": sequences[item["sequence_index"]]["axes"],
                       "sequence_index": item["sequence_index"], "sequence_name": item["sequence_name"]})
            jobs.append(job.to_dict())
        return {"sweep": {"id": sweep_id, "name": name, "sequences": sequences,
                           "axes": sequences[0]["axes"], "total": len(combos)}, "runs": jobs}

    def submit_convergence(self, body: dict) -> dict:
        """A mesh convergence study of a saved design (fairbeam.convergence): the first density is
        queued now, each next one when the previous run is done and the stopping rule says so."""
        from . import convergence as cv

        m, resolved, overrides = self._validated(body)
        if m.get("kind") != "design":
            raise ApiError(422, "a mesh convergence study needs a design made in the designer",
                           fields={"model": "not a design"})
        try:
            why = cv.unsupported(json.loads(m["_queued_design"]))
        except (OSError, ValueError) as e:
            raise ApiError(422, f"the design file cannot be read: {e}") from None
        if why:  # before the checks: manual lines are the reason, whatever else the checks find
            raise ApiError(422, why, fields={"mesh": why})
        self._refuse_broken_design(m)
        errors: dict = {}
        st = self._settings(body, errors)
        max_runs = body.get("max_runs", cv.DEFAULT_MAX_RUNS)
        max_density = body.get("max_density")
        if isinstance(max_runs, bool) or not isinstance(max_runs, int) or not 2 <= max_runs <= cv.MAX_DENSITIES:
            errors["max_runs"] = f"a whole number from 2 to {cv.MAX_DENSITIES}"
        elif max_density is not None and (isinstance(max_density, bool) or not isinstance(max_density, (int, float))):
            errors["max_density"] = "a number of cells per wavelength"
        else:
            try:
                planned = cv.plan(body.get("densities", list(cv.DEFAULT_DENSITIES)), max_runs, max_density)
            except ValueError as e:
                errors["densities"] = str(e)
        tolerances = body.get("tolerances") or {}
        try:
            if not isinstance(tolerances, dict):
                raise ValueError("tolerances must be an object")
            tol = cv.check_tolerances(tolerances)
        except ValueError as e:
            errors["tolerances"] = str(e)
        if errors:
            raise ApiError(422, "invalid convergence study", fields=errors)
        self._refuse_by_preflight(body, st)
        study_id = "cv-" + time.strftime("%Y%m%d-%H%M%S") + "-" + os.urandom(2).hex()
        model = {"id": (m.get("model") or {}).get("id") or m["key"], "name": (m.get("model") or {}).get("name") or m["key"]}
        name = st["label"] or f"{model['name']} · mesh convergence"
        job_kw = {"model": m["key"], "model_id": (m.get("model") or {}).get("id"), "model_path": m["path"], "design_input": m.get("_queued_design"),
                  "params": resolved, "overrides": overrides, "threads": st["threads"], "engine": st["engine"],
                  "end_criteria_db": st["end_criteria_db"], "label": st["label"], "points": st["points"],
                  "name": st["name"]}
        _, job = self.studies.start(study_id=study_id, name=name, model=model, job_kw=job_kw, planned=planned,
                                    tol=tol, settings={"threads": st["threads"], "engine": st["engine"],
                                                       "end_criteria_db": st["end_criteria_db"]})
        return {"study": self.studies.get(study_id), "runs": [job.to_dict()]}

    def convergence(self, study_id: str) -> dict:
        study = self.studies.get(study_id)
        if study is None:
            raise ApiError(404, f"no convergence study {study_id}")
        return study

    def submit_optimization(self, body: dict) -> dict:
        from .optimize import GOAL_KINDS, make_goal

        m, resolved, overrides = self._validated(body)
        self._refuse_broken_design(m)
        errors: dict = {}
        st = self._settings(body, errors)
        specs = {s["key"]: s for s in m["params"]}
        vary = body.get("vary")
        clean_vary: list[dict] = []
        if not isinstance(vary, list) or not vary:
            errors["vary"] = "vary at least one parameter"
        else:
            for i, v in enumerate(vary):
                spec = specs.get(v.get("key")) if isinstance(v, dict) else None
                field = f"vary.{i}"
                if spec is None or spec.get("type") not in ("int", "float"):
                    errors[field] = "choose a numeric parameter"
                    continue
                lo, hi, start = v.get("min"), v.get("max"), v.get("start")
                nums = all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in (lo, hi))
                if not nums or not lo < hi:
                    errors[field] = "min and max must be numbers with min < max"
                    continue
                if (spec.get("minimum") is not None and lo < spec["minimum"]) or (spec.get("maximum") is not None and hi > spec["maximum"]):
                    errors[field] = f"stay within the parameter's limits [{spec.get('minimum')}, {spec.get('maximum')}]"
                    continue
                if start is not None and (isinstance(start, bool) or not isinstance(start, (int, float)) or not lo <= start <= hi):
                    errors[field] = "start must lie between min and max"
                    continue
                if any(c["key"] == spec["key"] for c in clean_vary):
                    errors[field] = "varied twice"
                    continue
                clean_vary.append({"key": spec["key"], "min": float(lo), "max": float(hi),
                                   "start": None if start is None else float(start)})
        goals = body.get("goals")
        clean_goals: list[dict] = []
        if not isinstance(goals, list) or not 1 <= len(goals) <= 4:
            errors["goals"] = "give 1 to 4 goals"
        else:
            for i, g in enumerate(goals):
                try:
                    if not isinstance(g, dict) or g.get("kind") not in GOAL_KINDS:
                        raise ValueError(f"kind must be one of {', '.join(GOAL_KINDS)}")
                    num = lambda x: None if x is None else float(x)  # noqa: E731
                    ports = g.get("ports")
                    if ports is not None and (not isinstance(ports, list) or len(ports) != 2 or
                                              not all(isinstance(n, int) and not isinstance(n, bool) and 1 <= n <= 64
                                                      for n in ports)):
                        raise ValueError("ports must be two port numbers [i, j]")
                    goal = make_goal(g["kind"], num(g.get("target")), num(g.get("at")), num(g.get("weight", 1.0)) or 1.0,
                                     tuple(ports) if ports else None)
                    clean_goals.append({"kind": goal.kind, "target": goal.target, "at": goal.at, "weight": goal.weight,
                                        "ports": list(goal.ports) if goal.ports else None})
                except (TypeError, ValueError) as e:
                    errors[f"goals.{i}"] = str(e)
        max_evals = body.get("max_evals", 12)
        if isinstance(max_evals, bool) or not isinstance(max_evals, int) or not 1 <= max_evals <= MAX_OPT_EVALS:
            errors["max_evals"] = f"a whole number from 1 to {MAX_OPT_EVALS}"
        excite = body.get("excite", "auto")
        if not isinstance(excite, str) or not re.fullmatch(r"auto|all|\d+(,\d+)*", excite):
            errors["excite"] = "auto, all or port numbers such as 1,3"
        method = body.get("method", "auto")
        methods = ("auto", "secant", "nelder-mead", "bayesian", "cma-es", "particle-swarm", "genetic", "trust-region")
        if not isinstance(method, str) or method not in methods:
            errors["method"] = ", ".join(methods)
        elif method == "secant" and not (len(clean_vary) == 1 and any(g["kind"] == "f0" for g in clean_goals)):
            errors["method"] = "secant needs one parameter and an f0 goal"
        if errors:
            raise ApiError(422, "invalid optimization", fields=errors)
        self._refuse_by_preflight(body, st)
        # fixed parameters: everything the user changed except the varied ones
        fixed = {k: v for k, v in overrides.items() if k not in {c["key"] for c in clean_vary}}
        model_id = (m.get("model") or {}).get("id") or m["key"]
        name = st["name"] or slugify(f"{model_id}-opt-" + time.strftime("%Y%m%d-%H%M%S"))
        if (self.projects_dir / "optimizations" / f"{name}.json").exists():
            name = slugify(f"{name}-" + time.strftime("%H%M%S"))
        label = st["label"] or "Optimize " + ", ".join(c["key"] for c in clean_vary)
        job = self.manager.submit(model=m["key"], model_id=model_id, model_path=m["path"], design_input=m.get("_queued_design"), params=resolved,
                                  overrides=fixed, threads=st["threads"], engine=st["engine"],
                                  end_criteria_db=st["end_criteria_db"], name=name, label=label, kind="optimize",
                                  optimize={"vary": clean_vary, "goals": clean_goals, "max_evals": max_evals,
                                            "method": method, "excite": excite})
        return job.to_dict()

    def research_probe(self, body: dict) -> dict:
        from .research import probe
        try:
            return probe(body)
        except (ValueError, TypeError) as exc:
            raise ApiError(400, str(exc)) from exc
        except OSError as exc:
            return {"backend": body.get("backend"), "available": False, "reason": str(exc)}

    def research_submit(self, body: dict) -> dict:
        try:
            return self.manager.submit_research(body).to_dict()
        except (ValueError, TypeError) as exc:
            raise ApiError(400, str(exc)) from exc
        except OSError as exc:
            raise ApiError(409, str(exc)) from exc

    def research_runs(self) -> dict:
        return {"runs": [row for row in self.manager.list() if row.get("kind") == "research"]}

    def research_job(self, job_id: str):
        job = self.job(job_id)
        if job.kind != "research":
            raise ApiError(404, f"no research job {job_id}")
        if job.dir.resolve().parent != self.manager.root.resolve():
            raise ApiError(409, "research job directory escapes jobs root")
        return job

    def research_detail(self, job_id: str) -> dict:
        job = self.research_job(job_id)
        if job.result is not None:
            from .research import load_result
            try:
                result, checksum = load_result(job)
                if checksum != job.research.get("result_sha256") or result.get("input_sha256") != job.research.get("snapshot_sha256"):
                    raise ValueError("research output checksum/input identity mismatch")
            except (OSError, ValueError, TypeError) as exc:
                raise ApiError(409, f"research result changed or unavailable: {exc}") from exc
        return job.to_dict()

    def job(self, job_id: str):
        job = self.manager.get(job_id)
        if job is None:
            raise ApiError(404, f"no job {job_id}")
        return job

    def save_best(self, job_id: str) -> dict:
        from .cli import rebuild_index

        job = self.job(job_id)
        if job.kind != "optimize" or not job.terminal or not job.stats.get("best_file"):
            raise ApiError(409, "optimization is unfinished or has no best evaluation")
        source_rel = job.stats["best_file"]
        source_root = self.projects_dir.resolve()
        source = (source_root / source_rel).resolve()
        if source_root not in source.parents or not source.is_file() or source.suffix != ".json":
            raise ApiError(409, "best evaluation bundle is unavailable")
        stem = f"{job.name or job.id}-best"
        target = self.projects_dir / f"{stem}.json"
        n = 2
        while target.exists():
            target = self.projects_dir / f"{stem}-{n}.json"
            n += 1
        shutil.copy2(source, target)
        rebuild_index(self.projects_dir)
        return {"file": target.name}


# ---------------------------------------------------------------------- HTTP layer

def _host_ok(value: str | None) -> bool:
    if not value:
        return False
    host = value.strip().lower()
    if host.startswith("["):
        host = host[: host.find("]") + 1] if "]" in host else host
    else:
        host = host.split(":")[0]
    return host in LOOPBACK_HOSTS


def _origin_ok(value: str | None) -> bool:
    if value is None:
        return True
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and (parts.hostname or "").lower() in LOOPBACK_HOSTS


class Handler(BaseHTTPRequestHandler):
    server_version = f"fairbeam/{__version__}"
    protocol_version = "HTTP/1.1"
    app: App  # set on the server class

    def log_message(self, fmt, *args):  # quieter than the default; skip SSE/health noise
        if getattr(self.server, "quiet", False):
            return
        msg = fmt % args
        if "/api/health" in msg:
            return
        sys.stderr.write(f"fairbeam serve: {self.address_string()} {msg}\n")

    # ---- plumbing

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        extra = dict(extra or {})
        self.send_header("Cache-Control", extra.pop("Cache-Control", "no-store"))
        self.send_header("X-Content-Type-Options", "nosniff")
        self._no_framing()
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _no_framing(self):
        """The workbench must not render inside another page's frame: a page on another localhost
        port is same-site, and could overlay the app's buttons (clickjacking)."""
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        self.send_header("X-Frame-Options", "DENY")

    def _json(self, status: int, obj):
        self._send(status, json.dumps(obj, allow_nan=False, default=str, separators=(",", ":")).encode(),
                   "application/json; charset=utf-8")

    def _error(self, status: int, message: str, **extra):
        self.close_connection = True  # an unread request body must not leak into the next request
        self._send(status, json.dumps({"error": message, "status": status, **extra}, default=str).encode(),
                   "application/json; charset=utf-8", {"Connection": "close"})

    def _guard(self) -> bool:
        peer = self.client_address[0] if self.client_address else ""
        if peer not in LOOPBACK_PEERS:
            self._error(403, "only local connections are accepted")
            return False
        if not _host_ok(self.headers.get("Host")):
            self._error(403, "Host header must be a loopback address")
            return False
        if not _origin_ok(self.headers.get("Origin")):
            self._error(403, "cross-origin requests are not accepted")
            return False
        if (self.headers.get("Sec-Fetch-Site") or "").lower() == "cross-site":
            self._error(403, "cross-site requests are not accepted")
            return False
        return True

    def _body(self, limit: int = MAX_BODY) -> dict:
        """JSON object body of a POST or PUT (anything else is refused, which also blocks CSRF)."""
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise ApiError(415, "Content-Type must be application/json")
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "bad Content-Length")
        if n < 0:
            raise ApiError(400, "bad Content-Length")
        if n > limit:
            raise ApiError(413, "request body too large")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ApiError(400, "body is not valid JSON")
        if not isinstance(body, dict):
            raise ApiError(400, "body must be a JSON object")
        return body

    def _dispatch(self, routes):
        path = urlsplit(self.path).path.rstrip("/") or "/"
        path_matched = False
        for method, pattern, fn in routes:
            m = re.fullmatch(pattern, path)
            if m and method == self.command:
                return fn(*m.groups())
            path_matched = path_matched or bool(m)
        if path_matched:
            raise ApiError(405, f"{self.command} not allowed on {path}")
        raise ApiError(404, f"no route {path}")

    def _static(self):
        """GET/HEAD outside /api when the server was started with --ui."""
        if self.command not in ("GET", "HEAD"):
            return self._error(405, "method not allowed")
        target, cache = static.resolve(self.app.ui_dir, self.app.projects_dir, self.path)
        if target is None:
            body = b"Not found\n"
            self.close_connection = True
            return self._send(404, body, "text/plain; charset=utf-8", {"Connection": "close"})
        try:
            data = target.read_bytes()
        except OSError:
            return self._error(404, "not found")
        self._send(200, data, static.content_type(target), {"Cache-Control": cache})

    def _handle(self):
        if not self._guard():
            return
        app = self.app
        path = urlsplit(self.path).path
        if app.ui_dir is not None and not (path == "/api" or path.startswith("/api/")):
            try:
                return self._static()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return
        routes = [
            ("GET", r"/api/health", lambda: self._json(200, app.health())),
            ("POST", r"/api/preflight", lambda: self._json(200, app.preflight(self._body()))),
            ("POST", r"/api/shutdown", self._shutdown),
            ("GET", r"/api/blender", lambda: self._json(200, app.blender_info((parse_qs(urlsplit(self.path).query).get("path") or [""])[0]))),
            ("POST", r"/api/blender/open-download", lambda: (self._body(), self._json(200, app.open_blender_download()))[1]),
            ("POST", r"/api/render-jobs", lambda: self._json(201, app.submit_render(self._body(MAX_RENDER_JOB_BODY)))),
            ("GET", r"/api/render-jobs/(rb-[0-9a-f]+)", lambda i: self._json(200, app.render_job(i).to_dict())),
            ("POST", r"/api/render-jobs/(rb-[0-9a-f]+)/cancel", self._cancel_render),
            ("GET", r"/api/models", lambda: self._json(200, app.models())),
            ("POST", r"/api/preview", lambda: self._json(200, app.do_preview(self._body()))),
            ("POST", r"/api/research/probe", lambda: self._json(200, app.research_probe(self._body()))),
            ("POST", r"/api/research/runs", lambda: self._json(201, app.research_submit(self._body()))),
            ("GET", r"/api/research/runs", lambda: self._json(200, app.research_runs())),
            ("GET", r"/api/research/runs/([\w.-]+)", lambda i: self._json(200, app.research_detail(i))),
            ("POST", r"/api/research/runs/([\w.-]+)/cancel", self._cancel_research),
            ("GET", r"/api/runs", lambda: self._json(200, {"runs": app.manager.list()})),
            ("POST", r"/api/runs", lambda: self._json(201, app.submit(self._body()))),
            ("GET", r"/api/runs/([\w.-]+)", lambda i: self._json(200, app.job(i).to_dict())),
            ("GET", r"/api/runs/([\w.-]+)/events", self._events),
            ("GET", r"/api/runs/([\w.-]+)/log", self._log),
            ("POST", r"/api/runs/([\w.-]+)/cancel", self._cancel),
            ("POST", r"/api/runs/([\w.-]+)/delete", self._delete),
            ("POST", r"/api/queue/clear", self._clear_queue),
            ("POST", r"/api/sweeps", lambda: self._json(201, app.submit_sweep(self._body()))),
            ("POST", r"/api/sweeps/([\w.-]+)/cancel", self._cancel_sweep),
            ("POST", r"/api/convergence", lambda: self._json(201, app.submit_convergence(self._body()))),
            ("GET", r"/api/convergence/(cv-[\w-]+)", lambda i: self._json(200, app.convergence(i))),
            ("POST", r"/api/optimizations", lambda: self._json(201, app.submit_optimization(self._body()))),
            ("POST", r"/api/optimizations/([\w.-]+)/save-best", self._save_best),
            ("GET", r"/api/templates", lambda: self._json(200, app.templates_list())),
            ("POST", r"/api/models", lambda: self._json(201, app.create_model(self._body()))),
            ("POST", r"/api/examples/conversion-preview", lambda: self._json(200, app.preview_example_conversion(self._body()))),
            ("POST", r"/api/examples/copy", lambda: self._json(201, app.copy_example(self._body()))),
            ("GET", r"/api/models/([a-z][a-z0-9_]*)/source", lambda i: self._json(200, app.model_source(i))),
            ("PUT", r"/api/models/([a-z][a-z0-9_]*)/source", lambda i: self._json(200, app.save_source(i, self._body()))),
            ("POST", r"/api/designs", lambda: self._json(201, app.create_design(self._body(MAX_PCB_BODY)))),
            ("POST", r"/api/design/from-python", lambda: self._json(200, app.design_from_python(self._body()))),
            ("POST", r"/api/import/cst", lambda: self._json(200, app.import_cst(self._body()))),
            ("POST", r"/api/import/pcb", lambda: self._json(200, app.import_pcb(self._body(MAX_PCB_BODY)))),
            ("GET", r"/api/designs/([a-z][a-z0-9_]*)",
             lambda i: self._json(200, app.design_file(i))),
            ("PUT", r"/api/designs/([a-z][a-z0-9_]*)", lambda i: self._json(200, app.save_design(i, self._body()))),
            ("GET", r"/api/designs/([a-z][a-z0-9_]*)/python", lambda i: self._json(200, app.design_python(i))),
            ("POST", r"/api/designs/([a-z][a-z0-9_]*)/delete", self._delete_design),
            ("POST", r"/api/designs/([a-z][a-z0-9_]*)/rename", lambda i: self._json(200, app.rename_design(i, self._body()))),
            ("GET", r"/api/designs/([a-z][a-z0-9_]*)/location", lambda i: self._json(200, app.design_location(i))),
            ("GET", r"/api/renders/([A-Za-z0-9_-]+)", lambda i: self._json(200, renders.list_renders(app.workspace, i))),
            ("POST", r"/api/renders/([A-Za-z0-9_-]+)", lambda i: self._json(201, app.save_render(i, self._body(MAX_RENDER_BODY)))),
            ("POST", r"/api/renders/([A-Za-z0-9_-]+)/open", lambda i: self._json(200, app.open_renders(i, self._body()))),
            ("GET", r"/api/renders/([A-Za-z0-9_-]+)/file/([A-Za-z0-9._-]+)",
             self._render_file),
            ("GET", r"/api/materials/user", lambda: self._json(200, app.user_materials())),
            ("PUT", r"/api/materials/user", lambda: self._json(200, app.save_user_materials(self._body()))),
            ("POST", r"/api/open-feedback", lambda: self._json(200, app.open_feedback(self._body()))),
            ("GET", r"/api/models/([a-z][a-z0-9_]*)/history",
             lambda i: self._json(200, {"versions": modelfiles.list_versions(app.history_dir, i)})),
            ("GET", r"/api/models/([a-z][a-z0-9_]*)/history/([\w-]+)",
             lambda i, v: self._json(200, modelfiles.read_version(app.history_dir, i, v))),
        ]
        try:
            self._dispatch(routes)
        except (ApiError, modelfiles.ModelFileError, renders.RenderError) as e:
            self._error(e.status, e.message, **e.extra)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):  # Windows: 10054, 10053
            pass
        except Exception as e:  # noqa: BLE001
            self._error(500, f"internal error: {type(e).__name__}: {e}")

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def do_HEAD(self):
        self._handle()

    def do_PUT(self):
        self._handle()

    def do_DELETE(self):
        self._error(405, "method not allowed")

    do_PATCH = do_DELETE

    def do_OPTIONS(self):  # no CORS: preflights are never granted
        self._error(405, "method not allowed")

    # ---- desktop shell

    def _shutdown(self):
        """Clean stop requested by the desktop shell, which started us with FAIRBEAM_SHUTDOWN_TOKEN
        and sends it back as X-Fairbeam-Token. Without that variable the route does not exist. The
        shell has no console on Windows, so it cannot send CTRL_BREAK; this is its graceful path."""
        import hmac

        token = os.environ.get("FAIRBEAM_SHUTDOWN_TOKEN") or ""
        if not token:
            raise ApiError(404, "no route /api/shutdown")
        self._body()  # a JSON POST only (CSRF)
        if not hmac.compare_digest(self.headers.get("X-Fairbeam-Token") or "", token):
            raise ApiError(403, "bad shutdown token")
        try:
            self._json(202, {"stopping": True})
        finally:
            # stop even when the answer could not be written: shells up to 0.2.0 read only the
            # status line and close, and on Windows closing with unread data resets the
            # connection, so the rest of this write can fail (ConnectionResetError). Before, that
            # skipped the lines below and the shell had to kill the server after its 8 s grace
            # period. Newer shells read the answer to the end.
            # logged, so a slow stop can be told apart from a request that never arrived
            print("fairbeam serve: shutdown requested by the desktop shell", flush=True)
            # stop serve_forever from another thread: no signal involved (interrupt_main does
            # nothing when SIGINT is ignored, as it is for background processes of a
            # non-interactive shell)
            threading.Thread(target=self.server.shutdown, name="fairbeam-shutdown", daemon=True).start()

    # ---- runs

    def _log(self, job_id: str):
        job = self.app.job(job_id)
        path = job.dir / "log.txt"
        text = path.read_bytes() if path.exists() else b""
        self._send(200, text, "text/plain; charset=utf-8")

    def _render_file(self, design: str, name: str):
        path = renders.render_path(self.app.workspace, design, name)
        if path.suffix == ".png":
            self._send(200, path.read_bytes(), "image/png", {"Cache-Control": "no-cache"})
        else:
            self._send(200, path.read_bytes(), "application/octet-stream",
                       {"Cache-Control": "no-cache", "Content-Disposition": f'attachment; filename="{path.name}"'})

    def _cancel_render(self, job_id: str):
        self._body()
        job = self.app.render_jobs.cancel(job_id)
        if job is None:
            raise ApiError(404, f"no render {job_id}")
        self._json(202, job.to_dict())

    def _cancel_research(self, job_id: str):
        self._body()  # same JSON/CSRF restriction as ordinary jobs
        self.app.research_job(job_id)  # do not alias ordinary job cancellation
        job = self.app.manager.cancel(job_id)
        self._json(202, job.to_dict())

    def _cancel(self, job_id: str):
        self._body()  # enforce a JSON POST (CSRF)
        job = self.app.manager.cancel(job_id)
        if job is None:
            raise ApiError(404, f"no job {job_id}")
        self._json(202, job.to_dict())

    def _delete(self, job_id: str):
        body = self._body()
        try:
            result = self.app.manager.delete(job_id, delete_bundle=bool(body.get("delete_bundle")))
        except KeyError:
            raise ApiError(404, f"no job {job_id}")
        except ValueError as e:
            raise ApiError(409, str(e))
        if result["bundle_deleted"]:
            from .cli import rebuild_index

            rebuild_index(self.app.projects_dir)
        self._json(200, result)

    def _save_best(self, job_id: str):
        self._body()
        self._json(201, self.app.save_best(job_id))

    def _delete_design(self, model_id: str):
        # a JSON POST only (CSRF). Reading the body also matters on a kept-alive connection: an
        # unread "{}" would prefix the next request ("{}GET /api/models" -> 501), and the start
        # screen then kept listing the deleted design.
        body = self._body()
        self._json(200, self.app.delete_design(model_id, body))

    def _clear_queue(self):
        self._body()  # enforce a JSON POST (CSRF)
        self._json(202, self.app.clear_queue())

    def _cancel_sweep(self, sweep_id: str):
        self._body()
        jobs = self.app.manager.cancel_sweep(sweep_id)
        if not jobs:
            raise ApiError(404, f"no sweep {sweep_id}")
        self._json(202, {"runs": [j.to_dict() for j in jobs]})

    def _events(self, job_id: str):
        job = self.app.job(job_id)
        q = parse_qs(urlsplit(self.path).query)
        try:
            last = int(self.headers.get("Last-Event-ID") or (q.get("after") or ["0"])[0])
        except ValueError:
            last = 0
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self._no_framing()
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(b"retry: 3000\n\n")
            self.wfile.flush()
            if last < job.memory_floor:  # a finished job keeps only its newest events in memory
                for batch in job.iter_disk_events(last):
                    if getattr(self.server, "stopping", False):
                        return
                    self.wfile.write(b"".join(format_sse(e) for e in batch))
                    last = batch[-1]["seq"]
                self.wfile.flush()
            while not getattr(self.server, "stopping", False):
                events = job.events_after(last, timeout=self.app.heartbeat_s)
                if events:
                    self.wfile.write(b"".join(format_sse(e) for e in events))
                    last = events[-1]["seq"]
                elif not job.terminal:
                    self.wfile.write(sse_comment())
                self.wfile.flush()
                with job.cond:  # _finish sets the status before publishing its last events
                    finished = job.terminal and last >= job.last_seq
                if finished:
                    self.wfile.write(sse_comment("end"))
                    self.wfile.flush()
                    break
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, ValueError):
            pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    stopping = False
    quiet = False


def make_server(app: App, host: str = "127.0.0.1", port: int = DEFAULT_PORT, quiet: bool = False) -> Server:
    if host not in ("127.0.0.1", "localhost"):  # the server socket is IPv4
        raise ValueError("fairbeam serve only binds to 127.0.0.1 (loopback)")
    handler = type("BoundHandler", (Handler,), {"app": app})
    srv = Server(("127.0.0.1" if host == "localhost" else host, port), handler)
    srv.quiet = quiet
    return srv


def free_port() -> int:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _watch_parent(stop):
    """Stop the server (``stop()``: ``srv.shutdown``) when the process that started us goes away,
    e.g. the desktop shell crashed. POSIX: we are re-parented and getppid() changes. Windows:
    there is no re-parenting, so poll whether the parent pid is still alive. No signal is used:
    SIGINT may be ignored, and os.kill(self, SIGTERM) is TerminateProcess on Windows."""
    from .procutil import WINDOWS, pid_alive

    parent = os.getppid()

    def gone() -> bool:
        return not pid_alive(parent) if WINDOWS else os.getppid() != parent

    def loop():
        while True:
            time.sleep(1.0)
            if gone():
                stop()
                return

    threading.Thread(target=loop, name="fairbeam-parent-watch", daemon=True).start()


def record_desktop_server(app: App, host: str, port: int) -> Path | None:
    """Started by the desktop shell (it passes FAIRBEAM_SHUTDOWN_TOKEN): record the address and the
    workspace's folders, so a CLI started by hand finds them (its --out/--sim-root defaults in the
    packaged runtime, `fairbeam run --server`; fairbeam.appstate). None otherwise."""
    if not os.environ.get("FAIRBEAM_SHUTDOWN_TOKEN"):
        return None
    from .appstate import is_checkout, write_server_record

    # a debug `tauri dev` shell runs the server from the checkout: its record says so, and the
    # packaged CLI does not take that repository's folders for its defaults
    return write_server_record(url=f"http://{host}:{port}", pid=os.getpid(), models=app.models_dir,
                               projects=app.projects_dir, jobs=app.jobs_dir, sim_root=app.sim_root,
                               version=__version__, checkout=is_checkout(Path(__file__).resolve().parents[2]))


def serve(*, port: int, models_dir: Path, projects_dir: Path, jobs_dir: Path, host: str = "127.0.0.1",
          python: str | None = None, ui_dir: Path | None = None, exit_with_parent: bool = False,
          on_ready=None, sim_root: Path | None = None):
    from .jobs_owner import JobsOwner

    # Refuse before App's JobManager can recover another live server's jobs.
    with JobsOwner(jobs_dir) as owner:
        return _serve_owned(port=port, models_dir=models_dir, projects_dir=projects_dir,
                            jobs_dir=owner.root, host=host, python=python, ui_dir=ui_dir,
                            exit_with_parent=exit_with_parent, on_ready=on_ready, sim_root=sim_root)


def _serve_owned(*, port, models_dir, projects_dir, jobs_dir, host, python, ui_dir,
                 exit_with_parent, on_ready, sim_root):
    import signal as _signal

    app = App(models_dir=models_dir, projects_dir=projects_dir, jobs_dir=jobs_dir, port=port, python=python,
              ui_dir=ui_dir, sim_root=sim_root)
    srv = None
    try:
        srv = make_server(app, host, port)
        port = srv.server_address[1]

        def on_term(signum, frame):  # SIGTERM from the desktop shell: shut down like Ctrl-C
            raise KeyboardInterrupt

        _signal.signal(_signal.SIGTERM, on_term)
        if exit_with_parent:
            _watch_parent(srv.shutdown)
        print(f"fairbeam serve: http://{host}:{port}/api  (Fairbeam {__version__}, openEMS "
              f"{app.versions.get('openems')}, {app.cpu} CPUs)", flush=True)
        print(f"  models   {app.models_dir}\n  projects {app.projects_dir}\n  jobs     {app.jobs_dir}\n"
              f"  raw data {app.sim_root / 'runs'}\n"
              f"  python   {app.python} (engines: {', '.join(app.engines)})", flush=True)
        if app.ui_dir:
            print(f"  ui       {app.ui_dir}  ->  http://{host}:{port}/", flush=True)
        record = record_desktop_server(app, host, port)
        if record is not None:
            print(f"  record   {record}", flush=True)
        if on_ready is not None:
            threading.Thread(target=on_ready, args=(f"http://{host}:{port}/",), daemon=True).start()

        def prewarm():
            # start the preview worker now (it imports CSXCAD/openEMS, ~0.15 s) instead of on the first
            # preview, and let the model list find a live worker; a failure here surfaces on first use
            try:
                app.preview.request({"op": "ping"})
            except Exception:  # noqa: BLE001
                pass

        threading.Thread(target=prewarm, daemon=True).start()
        try:
            srv.serve_forever(poll_interval=0.5)  # returns after srv.shutdown() (shell request, parent gone)
        except KeyboardInterrupt:
            pass
    finally:
        if srv is not None:
            print("\nfairbeam serve: stopping", flush=True)
            srv.stopping = True
        try:
            app.close()
        finally:
            # Retain ownership even when close raises or its initial join times out.
            app.manager.worker.join()
            if srv is not None:
                srv.server_close()
