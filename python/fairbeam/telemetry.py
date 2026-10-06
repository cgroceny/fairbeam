"""Anonymous, opt-in usage counts of the run server (docs/TELEMETRY.md).

Off unless the desktop shell, built with its telemetry switch, passes ``FAIRBEAM_TELEMETRY_DIR``.
Even then the server counts only while the shell's ``state.json`` there says ``"counting": true``
(the user said yes), and never with ``FAIRBEAM_NO_TELEMETRY=1``. The server never sends anything:
it only adds to ``counters-server.json`` (its own file; the shell reads it and sends whole
previous days once a day).

A count is a fixed key and an integer per UTC day. No file name, path, model or parameter name,
parameter value or error message is ever recorded: the keys come from the closed lists below,
which must match ``api/_ping-schema.json`` (python/tests/test_telemetry.py checks it).
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

ENV_DIR = "FAIRBEAM_TELEMETRY_DIR"
ENV_OFF = "FAIRBEAM_NO_TELEMETRY"
FILE = "counters-server.json"
STATE = "state.json"
MAX_VALUE = 10000
MAX_AGE_DAYS = 31

ENGINES = ("cpu", "gpu")
SOURCES = ("design", "example", "python")
FAILURES = ("start", "server", "no-result", "solver", "memory", "gpu", "timeout", "mesh-cells", "design",
            "crash", "interrupted", "other")
REFUSALS = ("mesh-cells", "design-check")
DURATIONS = ("lt10s", "10-60s", "1-10min", "gt10min")
CELLS = ("lt100k", "100k-1m", "gt1m")
MONITORS = ("far_field", "surface_current", "efficiency", "field_planes")
SWEEP_POINTS = ("1-5", "6-20", "21-100", "gt100")
OPT_METHODS = ("auto", "secant", "nelder-mead", "bayesian", "cma-es", "particle-swarm", "genetic", "trust-region")
FEATURES = ("cst_import", "cst_export", "touchstone_export", "pdf_report")

# every key this server may write (the shell's app.* keys are its own)
SERVER_KEYS = frozenset(
    [f"sim.{k}.{e}.{s}" for k in ("started", "finished") for e in ENGINES for s in SOURCES]
    + [f"sim.failed.{e}.{f}" for e in ENGINES for f in FAILURES]
    + [f"sim.cancelled.{e}" for e in ENGINES]
    + [f"sim.refused.{r}" for r in REFUSALS]
    + [f"sim.duration.{d}" for d in DURATIONS]
    + [f"sim.cells.{c}" for c in CELLS]
    + [f"monitor.{m}" for m in MONITORS]
    + [f"sweep.started.{b}" for b in SWEEP_POINTS]
    + [f"optimize.started.{m}" for m in OPT_METHODS]
    + ["optimize.finished", "optimize.failed"]
    + [f"feature.{f}" for f in FEATURES])


def _off(environ) -> bool:
    return str(environ.get(ENV_OFF, "")).strip().lower() not in ("", "0", "false", "no")


def utc_day(t: float | None = None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() if t is None else t))


class Counters:
    """Adds to ``<dir>/counters-server.json`` while the shell says so; thread-safe."""

    def __init__(self, directory: str | Path, *, clock=time.time, environ=None):
        self.dir = Path(directory)
        self.clock = clock
        self.environ = os.environ if environ is None else environ
        self.lock = threading.Lock()

    def _state(self) -> dict:
        try:
            state = json.loads((self.dir / STATE).read_text(encoding="utf-8"))
            return state if isinstance(state, dict) else {}
        except (OSError, ValueError):
            return {}

    def active(self) -> bool:
        return not _off(self.environ) and self._state().get("counting") is True

    def _read(self) -> dict:
        try:
            data = json.loads((self.dir / FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        days = data.get("days") if isinstance(data, dict) else None
        return days if isinstance(days, dict) else {}

    def count(self, key: str, n: int = 1) -> bool:
        """Count ``key`` today (UTC). An unknown key is refused; nothing is written while off (and
        the file of earlier counts is deleted, as the user turned counting off)."""
        if key not in SERVER_KEYS or not isinstance(n, int) or n <= 0:
            return False
        with self.lock:
            state = self._state()
            if _off(self.environ) or state.get("counting") is not True:
                try:
                    (self.dir / FILE).unlink()
                except OSError:
                    pass
                return False
            today = utc_day(self.clock())
            oldest = utc_day(self.clock() - MAX_AGE_DAYS * 86400)
            sent = state.get("sent_through") if isinstance(state.get("sent_through"), str) else ""
            days = {d: c for d, c in self._read().items()
                    if isinstance(c, dict) and oldest <= d and d > sent and len(d) == 10}
            day = days.setdefault(today, {})
            day[key] = min(MAX_VALUE, int(day.get(key, 0)) + n)
            try:
                self.dir.mkdir(parents=True, exist_ok=True)
                tmp = self.dir / (FILE + ".tmp")
                tmp.write_text(json.dumps({"days": days}, indent=1, sort_keys=True), encoding="utf-8")
                os.replace(tmp, self.dir / FILE)
            except OSError:
                return False
            return True


def from_env(environ=None) -> Counters | None:
    """The server's counters, or None: no folder from the shell (every build without the telemetry
    switch, ``fairbeam serve`` on its own) or ``FAIRBEAM_NO_TELEMETRY``."""
    environ = os.environ if environ is None else environ
    folder = environ.get(ENV_DIR)
    if not folder or _off(environ):
        return None
    return Counters(folder, environ=environ)


def count(counters: Counters | None, key: str, n: int = 1) -> None:
    """Count, never raising: usage statistics must not break a run."""
    if counters is None:
        return
    try:
        counters.count(key, n)
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- buckets and categories

def engine_of(job) -> str:
    return job.engine if getattr(job, "engine", None) in ENGINES else "cpu"


def source_of(model_path: str) -> str:
    """``design`` (a user design), ``example`` (a bundled model or design) or ``python``."""
    from .modelfiles import BUNDLED, DESIGN_SUFFIX

    name = Path(str(model_path or "")).name
    is_design = name.endswith(DESIGN_SUFFIX)
    stem = name[: -len(DESIGN_SUFFIX)] if is_design else name.rsplit(".", 1)[0]
    if stem in BUNDLED:
        return "example"
    return "design" if is_design else "python"


def duration_bucket(seconds: float) -> str:
    if seconds < 10:
        return "lt10s"
    if seconds < 60:
        return "10-60s"
    if seconds < 600:
        return "1-10min"
    return "gt10min"


def cells_bucket(cells) -> str | None:
    if isinstance(cells, bool) or not isinstance(cells, (int, float)) or cells <= 0:
        return None
    if cells < 100_000:
        return "lt100k"
    if cells <= 1_000_000:
        return "100k-1m"
    return "gt1m"


def sweep_bucket(points: int) -> str:
    if points <= 5:
        return "1-5"
    if points <= 20:
        return "6-20"
    if points <= 100:
        return "21-100"
    return "gt100"


def failure_category(status: str, error: str | None, exit_code: int | None) -> str:
    """A code for why a job failed; the message itself is never recorded."""
    if status == "interrupted":
        return "interrupted"
    e = (error or "").lower()
    if e.startswith("could not start"):
        return "start"
    if e.startswith("internal error"):
        return "server"
    if "memoryerror" in e or "bad_alloc" in e or "out of memory" in e or "cannot allocate" in e:
        return "memory"
    if "timed out" in e or "timeout" in e:
        return "timeout"
    if "cuda" in e or "gpu" in e:
        return "gpu"
    if "mesh" in e and "cell" in e:
        return "mesh-cells"
    if re.search(r"\bdesign(error)?\b", e):
        return "design"
    if "without writing a bundle" in e:
        return "no-result"
    if isinstance(exit_code, int) and exit_code < 0:
        return "crash"
    if "openems" in e or "fdtd" in e or "nf2ff" in e or "csxcad" in e:
        return "solver"
    return "other"


def refusal_category(checks: list) -> str:
    codes = {c.get("code") for c in checks if isinstance(c, dict) and c.get("severity") == "error"}
    return "mesh-cells" if "mesh-cells" in codes else "design-check"


def design_monitors(model_path: str) -> list[str]:
    """The monitors a design run records (a Python model's are not known here)."""
    try:
        d = json.loads(Path(model_path).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return []
    if not isinstance(d, dict):
        return []
    mon = d.get("monitors") if isinstance(d.get("monitors"), dict) else {}
    ff = d.get("far_field") if isinstance(d.get("far_field"), dict) else {}
    out = []
    if ff.get("enabled", True) is not False:
        out.append("far_field")
    if isinstance(mon.get("currents"), list) and mon["currents"]:
        out.append("surface_current")
    if isinstance(mon.get("efficiency"), dict):
        out.append("efficiency")
    if isinstance(mon.get("field_planes"), list) and mon["field_planes"]:
        out.append("field_planes")
    return out


# ---------------------------------------------------------------- job hooks (jobs.JobManager)

def job_started(counters: Counters | None, job) -> None:
    """JobManager.on_started: a simulation's process started (optimizer jobs count on their own)."""
    if counters is None or getattr(job, "kind", "run") != "run":
        return
    count(counters, f"sim.started.{engine_of(job)}.{source_of(job.model_path)}")
    if str(job.model_path).endswith(".design.json"):
        for m in design_monitors(job.model_path):
            count(counters, f"monitor.{m}")


def job_finished(counters: Counters | None, job) -> None:
    """JobManager.on_finished: done, failed, cancelled or interrupted."""
    if counters is None:
        return
    status = getattr(job, "status", "")
    if getattr(job, "kind", "run") == "optimize":
        if status == "done":
            count(counters, "optimize.finished")
        elif status in ("failed", "interrupted"):
            count(counters, "optimize.failed")
        return
    engine = engine_of(job)
    if status == "done":
        count(counters, f"sim.finished.{engine}.{source_of(job.model_path)}")
        duration = job.duration() if callable(getattr(job, "duration", None)) else None
        if isinstance(duration, (int, float)):
            count(counters, f"sim.duration.{duration_bucket(duration)}")
        bucket = cells_bucket((getattr(job, "info", None) or {}).get("cells"))
        if bucket:
            count(counters, f"sim.cells.{bucket}")
    elif status == "cancelled":
        count(counters, f"sim.cancelled.{engine}")
    elif status in ("failed", "interrupted"):
        count(counters, f"sim.failed.{engine}.{failure_category(status, job.error, job.exit_code)}")
