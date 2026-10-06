"""Simulation job queue for the run server.

A job is one ``python -m fairbeam run <model> --set ... --threads N --out <projects>`` child
process. Jobs run one at a time (a queue with concurrency 1): an FDTD run already uses the threads
it is given, and a second run would only make both slower and the machine hotter.

Every job lives in ``<root>/<id>/``:

- ``job.json``      metadata (model, params, status, timestamps, bundle, last progress, stats)
- ``log.txt``       the complete output, one line per line printed (stderr lines prefixed ``! ``)
- ``events.jsonl``  every structured event, so an SSE client can replay the whole run later

History survives server restarts; a job that was queued or running when the server stopped is
marked ``interrupted`` on the next start. If the server was killed outright (SIGKILL, a crash),
the job's process group may still be running: it is stopped on the next start, but only when the
recorded pid still belongs to the same process (same start time and command line).

Memory: a running job keeps all its events in memory (live SSE clients replay from there); a
finished one keeps only the last ``Job.MEMORY_EVENTS`` plus every event that is not a log line or
a progress sample. Older events are read back from ``events.jsonl`` when a client asks for them.

Raw data: with a ``sim_root`` every job writes its raw openEMS output to ``<sim_root>/runs/<id>/``,
which is removed together with the job.
"""

from __future__ import annotations

import json
import hashlib
import os
import queue
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable

from .jsonutil import finite_json
from .procutil import WINDOWS, kill_tree, popen_group, release_group, terminate_group, windows_process_info
from .progress import TERMINAL, ProgressParser
from .simdata import remove_inside

PACKAGE_ROOT = Path(__file__).resolve().parent.parent  # the folder that contains fairbeam/


def now_iso(t: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(t if t is not None else time.time()))


def child_env(extra: dict | None = None) -> dict:
    """Environment for child processes: unbuffered, and importing *this* fairbeam package."""
    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    # the run server decodes child output as UTF-8; Windows would otherwise encode it in the ANSI
    # code page (cp1252): non-ASCII text (the "·" in run titles) arrives garbled, and a
    # character outside that code page ends the run with UnicodeEncodeError
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = os.pathsep.join([str(PACKAGE_ROOT)] + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else []))
    if extra:
        env.update(extra)
    return env


def process_info(pid: int | None) -> dict | None:
    """``{"stat", "lstart", "command"}`` of a running process, else None. POSIX: from ``ps``.
    Windows: from the process itself (procutil.windows_process_info); ``lstart`` is its creation
    time in the ``ps -o lstart`` format and ``command`` the command line it was started with."""
    if not pid or int(pid) <= 0:
        return None
    if WINDOWS:
        info = windows_process_info(int(pid))
        if info is None:
            return None
        lstart = time.strftime("%a %b %d %H:%M:%S %Y", time.localtime(info["start"]))
        return {"stat": "R", "lstart": " ".join(lstart.split()), "command": info["command"]}
    if os.name != "posix":
        return None
    try:
        out = subprocess.run(["ps", "-ww", "-o", "stat=", "-o", "lstart=", "-o", "command=", "-p", str(int(pid))],
                             capture_output=True, text=True, timeout=5,
                             env={**os.environ, "LC_ALL": "C"}).stdout
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    line = out.strip().splitlines()[0] if out.strip() else ""
    parts = line.split(None, 6)
    if len(parts) < 6:
        return None
    return {"stat": parts[0], "lstart": " ".join(parts[1:6]), "command": parts[6].strip() if len(parts) > 6 else ""}


def parse_lstart(text: str) -> float | None:
    """``ps -o lstart`` (``Thu Sep 25 10:00:00 2026``, C locale) as epoch seconds."""
    try:
        return time.mktime(time.strptime(re.sub(r"\s+", " ", text.strip()), "%a %b %d %H:%M:%S %Y"))
    except (ValueError, OverflowError):
        return None


def _db_or_none(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def end_db_arg(value: float) -> str:
    """``--end-db=<value>`` as one token: argparse would take a separate ``-1e-05`` for an option."""
    return f"--end-db={float(value)!r}"


class Job:
    PUBLIC = ("id", "model", "model_id", "model_path", "params", "overrides", "threads", "name", "status",
              "phase", "created", "started", "finished", "exit_code", "bundle", "error", "end_criteria_db",
              "requested_end_criteria_db", "engine", "label", "sweep", "kind", "optimize", "last_progress",
              "stats", "info", "pid", "proc_start", "command", "sim_dir", "points", "mesh_density", "input_snapshot")
    MEMORY_EVENTS = 500  # events a finished job keeps in memory (the file keeps all of them)
    TRIMMED_TYPES = ("log", "progress")  # the bulky kinds; every other event is always kept

    def __init__(self, root: Path, **kw):
        self.id: str = kw["id"]
        self.dir = Path(root) / self.id
        self.model: str = kw.get("model", "")
        self.model_id: str | None = kw.get("model_id")
        self.model_path: str = kw.get("model_path", "")
        self.input_snapshot: dict | None = kw.get("input_snapshot")
        self.params: dict = kw.get("params") or {}
        self.overrides: dict = kw.get("overrides") or {}
        self.threads: int = int(kw.get("threads") or 1)
        self.name: str | None = kw.get("name")
        self.status: str = kw.get("status", "queued")
        self.phase: str = kw.get("phase", "queued")
        self.created: float = kw.get("created") or time.time()
        self.started: float | None = kw.get("started")
        self.finished: float | None = kw.get("finished")
        self.exit_code: int | None = kw.get("exit_code")
        self.bundle: str | None = kw.get("bundle")
        self.error: str | None = kw.get("error")
        # The stopping threshold asked for in the request (`fairbeam run --end-db`); None: the
        # model's/design's own. Jobs recorded before this field existed never passed one.
        self.requested_end_criteria_db: float | None = _db_or_none(kw.get("requested_end_criteria_db"))
        # The effective threshold: the requested one, replaced by the value the run itself reports
        # ("fairbeam: end criterion ..."); None until then when the model's default applies.
        self.end_criteria_db: float | None = _db_or_none(kw.get("end_criteria_db", self.requested_end_criteria_db))
        self.engine: str | None = kw.get("engine")
        self.points: int | None = kw.get("points")  # frequency points (`fairbeam run --points`)
        # a design's automatic mesh density for this run (`fairbeam run --mesh-density`, mesh convergence)
        self.mesh_density: float | None = kw.get("mesh_density")
        self.label: str | None = kw.get("label")  # display name given by the user
        # {id, name, index, total, values: {key: value}} when the job is part of a sweep
        self.sweep: dict | None = kw.get("sweep")
        self.kind: str = kw.get("kind") or "run"  # "run" or "optimize"
        # optimize: {vary: [{key, min, max, start}], goals: [{kind, target, at, weight}], max_evals, method}
        self.optimize: dict | None = kw.get("optimize")
        self.last_progress: dict | None = kw.get("last_progress")
        self.stats: dict = kw.get("stats") or {}
        self.info: dict = kw.get("info") or {}
        self.pid: int | None = kw.get("pid")
        # identify the child process after a server crash: its start time as `ps -o lstart` prints it
        # and the command line it was started with
        self.proc_start: str | None = kw.get("proc_start")
        self.command: list[str] | None = kw.get("command")
        self.sim_dir: str | None = kw.get("sim_dir")  # raw openEMS output of this job

        self._events: list[dict] | None = []  # None: not read from events.jsonl yet
        self._last_seq = 0
        self._memory_floor = 0  # every event with seq > memory_floor is in memory
        self.proc: subprocess.Popen | None = None
        self.cancel_requested = False
        self.lock = threading.RLock()
        self.cond = threading.Condition(self.lock)

    # ------------------------------------------------------------------ persistence

    def to_dict(self, events: bool = False) -> dict:
        d = {k: getattr(self, k) for k in self.PUBLIC}
        for k in ("created", "started", "finished"):
            d[k + "_iso"] = now_iso(d[k]) if d[k] else None
        d["duration_s"] = self.duration()
        if events:
            d["events"] = list(self.events)
        return d

    @property
    def events_file(self) -> Path:
        return self.dir / "events.jsonl"

    def duration(self) -> float | None:
        if not self.started:
            return None
        return round((self.finished or time.time()) - self.started, 2)

    def save(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.dir / "job.json.tmp"
        tmp.write_text(json.dumps(self.to_dict(), indent=2, allow_nan=False, default=str), encoding="utf-8", newline="\n")
        os.replace(tmp, self.dir / "job.json")

    @classmethod
    def load(cls, root: Path, job_dir: Path) -> "Job":
        data = json.loads((job_dir / "job.json").read_text(encoding="utf-8"))
        job = cls(root, **{k: v for k, v in data.items() if k in cls.PUBLIC})
        if job.events_file.exists():
            job._events = None  # read (trimmed) on first use, not for every job at startup
        return job

    # ------------------------------------------------------------------ events

    def _read_events(self):
        """Load the tail of events.jsonl (plus the always-kept kinds), never the whole file."""
        from collections import deque

        tail: deque = deque(maxlen=self.MEMORY_EVENTS)
        kept: list[dict] = []
        last = 0
        try:
            with open(self.events_file, encoding="utf-8", errors="replace") as f:
                for line in f:
                    try:
                        ev = json.loads(line)
                        seq = int(ev["seq"])
                    except (ValueError, TypeError, KeyError):
                        continue
                    last = max(last, seq)
                    if len(tail) == tail.maxlen and tail[0].get("type") not in self.TRIMMED_TYPES:
                        kept.append(tail[0])
                    tail.append(ev)
        except OSError:
            pass
        self._events = kept + list(tail)
        self._last_seq = last
        self._memory_floor = tail[0]["seq"] - 1 if tail else last

    @property
    def events(self) -> list[dict]:
        """The events in memory, in ``seq`` order (all of them while the job runs)."""
        with self.lock:
            if self._events is None:
                self._read_events()
            return self._events

    @property
    def last_seq(self) -> int:
        with self.lock:
            if self._events is None:
                self._read_events()
            return self._last_seq

    @property
    def memory_floor(self) -> int:
        """Every event with a ``seq`` above this is in memory; older ones may only be on disk."""
        with self.lock:
            if self._events is None:
                self._read_events()
            return self._memory_floor

    def publish(self, event: dict) -> dict:
        with self.cond:
            now = time.time()
            event = {"seq": self.last_seq + 1, "at": round(now, 3),
                     "t": round(now - (self.started or self.created), 3), **event}
            self.events.append(event)
            self._last_seq = event["seq"]
            try:
                with open(self.events_file, "a", encoding="utf-8", newline="\n") as f:
                    f.write(json.dumps(event, allow_nan=False, default=str) + "\n")
            except (OSError, ValueError):
                pass
            self.cond.notify_all()
            return event

    def trim_events(self):
        """Drop old log lines and progress samples from memory (a finished job only)."""
        with self.cond:
            events = self.events
            if len(events) <= self.MEMORY_EVENTS:
                return
            head, tail = events[:-self.MEMORY_EVENTS], events[-self.MEMORY_EVENTS:]
            self._events = [e for e in head if e.get("type") not in self.TRIMMED_TYPES] + tail
            self._memory_floor = tail[0]["seq"] - 1

    def events_after(self, seq: int, timeout: float | None = None) -> list[dict]:
        """Events with ``seq`` greater than ``seq``; waits up to ``timeout`` for new ones. Events
        that were trimmed from memory are read back from events.jsonl."""
        with self.cond:
            if self.last_seq <= seq and timeout and self.status not in TERMINAL:
                self.cond.wait(timeout)
            if seq >= self.memory_floor:
                events = self.events
                lo, hi = 0, len(events)  # binary search: events are sorted by seq
                while lo < hi:
                    mid = (lo + hi) // 2
                    if events[mid]["seq"] <= seq:
                        lo = mid + 1
                    else:
                        hi = mid
                return events[lo:]
        return [e for batch in self.iter_disk_events(seq) for e in batch]

    def iter_disk_events(self, seq: int, batch: int = 500):
        """Events with ``seq`` greater than ``seq`` read from events.jsonl, in lists of ``batch``."""
        out: list[dict] = []
        try:
            with open(self.events_file, encoding="utf-8", errors="replace") as f:
                for line in f:
                    try:
                        ev = json.loads(line)
                        if int(ev["seq"]) <= seq:
                            continue
                    except (ValueError, TypeError, KeyError):
                        continue
                    out.append(ev)
                    if len(out) >= batch:
                        yield out
                        out = []
        except OSError:
            pass
        if out:
            yield out

    @property
    def terminal(self) -> bool:
        return self.status in TERMINAL


CommandFactory = Callable[[Job], list[str]]


class JobManager:
    """Queue with concurrency 1, persistent history and cancellation by process group."""

    def __init__(self, root: str | Path, projects_dir: str | Path, *, python: str | None = None,
                 command_factory: CommandFactory | None = None, grace_s: float = 5.0,
                 on_finished: Callable[[Job], None] | None = None, autostart: bool = True,
                 sim_root: str | Path | None = None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.projects_dir = Path(projects_dir)
        # raw openEMS output: <sim_root>/runs/<job id>/ (None: the child's default, not cleaned up)
        self.sim_root = Path(sim_root).absolute() if sim_root else None
        self.python = python or sys.executable
        self.command_factory = command_factory or self.default_command
        self.grace_s = grace_s
        self.on_finished = on_finished
        # called once a job's process has started (usage statistics, fairbeam.telemetry)
        self.on_started: Callable[[Job], None] | None = None
        self.jobs: dict[str, Job] = {}
        self.queue: "queue.Queue[str | None]" = queue.Queue()
        self.lock = threading.RLock()
        self.current: Job | None = None
        self._stopping = False
        # bumped whenever a job is added, starts, ends or is removed: /api/health reports it, so a
        # window that polls the health sees every change of the queue, also a run another client
        # submitted that started and ended between two polls
        self.version = 0
        self._version_lock = threading.Lock()
        self._load_history()
        self.worker = threading.Thread(target=self._work, name="fairbeam-jobs", daemon=True)
        if autostart:
            self.worker.start()

    # ------------------------------------------------------------------ history

    def _load_history(self):
        for d in sorted(self.root.iterdir()) if self.root.exists() else []:
            if not (d / "job.json").exists():
                continue
            try:
                job = Job.load(self.root, d)
            except (OSError, ValueError, KeyError, TypeError):
                continue
            if job.status not in TERMINAL:
                was = job.status
                stopped = self._stop_orphan(job) if job.pid else False
                job.status, job.phase = "interrupted", "interrupted"
                job.finished = job.finished or time.time()
                job.error = job.error or f"The server stopped while this job was {was}." + (
                    f" Its process (pid {job.pid}) was still running and has been stopped." if stopped else "")
                job.publish({"type": "status", "status": "interrupted", "error": job.error})
                job.save()
                job.trim_events()
            if job.status == "done" and "bands" not in job.stats:
                self._backfill_stats(job)
            self.jobs[job.id] = job

    def _note(self, job: Job, text: str):
        """A line for the job's log and event stream (shown like stderr output)."""
        try:
            with open(job.dir / "log.txt", "a", encoding="utf-8", newline="\n") as f:
                f.write("! " + text + "\n")
        except OSError:
            pass
        job.publish({"type": "log", "stream": "stderr", "line": text})

    def _stop_orphan(self, job: Job) -> bool:
        """The server died while ``job`` ran: if its process group is still alive, stop it so it
        cannot overlap the next run. Only a process that positively matches the job (the recorded
        start time, or one within seconds of ``job.started``, and the recorded command line) is
        touched; anything else is left alone. Returns True when the group was stopped.

        Windows: the same match (creation time and command line of the pid), then the process tree
        is force-stopped with ``taskkill /T /F``; a CTRL_BREAK would not reach it from this new
        server, which does not share the orphan's console."""
        info = process_info(job.pid)
        if info is None or info["stat"].startswith("Z"):
            return False  # gone (or only a zombie waiting for its parent)
        if not self._same_process(job, info):
            self._note(job, f"fairbeam serve: pid {job.pid} is running but is not this job's process "
                            "(different start time or command); it was left alone.")
            return False
        if WINDOWS:
            self._note(job, f"fairbeam serve: the server stopped while this job was running and its process "
                            f"(pid {job.pid}) was still running; stopping its process group.")
            kill_tree(job.pid)
            deadline = time.time() + self.grace_s
            while time.time() < deadline and process_info(job.pid) is not None:
                time.sleep(0.05)
            return True
        try:
            pgid = os.getpgid(job.pid)
        except OSError:
            return False
        if pgid != job.pid:  # jobs start in their own session, so the job's pid leads its group
            self._note(job, f"fairbeam serve: pid {job.pid} no longer leads its own process group; left alone.")
            return False
        self._note(job, f"fairbeam serve: the server stopped while this job was running and its process "
                        f"(pid {job.pid}) was still running; stopping its process group.")
        try:
            os.killpg(pgid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            return False
        deadline = time.time() + self.grace_s
        while time.time() < deadline:
            info = process_info(job.pid)
            if info is None or info["stat"].startswith("Z"):
                break
            time.sleep(0.05)
        try:  # stragglers of the group (and a leader that ignored SIGTERM)
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        return True

    def _same_process(self, job: Job, info: dict) -> bool:
        if job.proc_start:
            if " ".join(job.proc_start.split()) != info["lstart"]:
                return False
        else:  # recorded before start times were: the child starts right after job.started
            t = parse_lstart(info["lstart"])
            if t is None or not job.started or not -2.0 <= t - job.started <= 10.0:
                return False
        cmd = job.command
        if not cmd:  # older jobs: the command is in the "running" status event
            cmd = next((e.get("command") for e in job.events
                        if e.get("type") == "status" and e.get("status") == "running" and e.get("command")), None)
        if not cmd:
            return False
        # argv[0] may be shown differently (interpreter re-exec); the arguments must all be there.
        # Windows keeps the command line exactly as Popen quoted it (subprocess.list2cmdline).
        args = [str(a) for a in (cmd[1:] if len(cmd) > 1 else cmd)]
        signature = subprocess.list2cmdline(args) if WINDOWS else " ".join(args)
        return bool(signature.strip()) and signature in info["command"]

    @staticmethod
    def _backfill_stats(job: Job):
        """Jobs recorded before band/far-field lines were published as stats: re-parse the log."""
        log = job.dir / "log.txt"
        if not log.exists():
            return
        parser = ProgressParser(-40.0 if job.end_criteria_db is None else job.end_criteria_db)
        for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
            if not line.startswith(("$ ", "[exit code")):
                parser.feed(line[2:] if line.startswith("! ") else line, "stderr" if line.startswith("! ") else "stdout")
        if parser.stats:
            job.stats = parser.stats
            try:
                job.save()
            except OSError:
                pass

    def _changed(self):
        with self._version_lock:
            self.version += 1

    def queued_count(self) -> int:
        """Jobs waiting for their turn. A cancelled job's id stays in ``queue`` until the worker
        skips it, so the queue's size would still count it."""
        with self.lock:
            return sum(1 for j in self.jobs.values() if j.status == "queued")

    def list(self) -> list[dict]:
        with self.lock:
            jobs = sorted(self.jobs.values(), key=lambda j: j.created, reverse=True)
            return [j.to_dict() for j in jobs]

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    # ------------------------------------------------------------------ submit / cancel

    def input_path(self, job: Job) -> str:
        """Resolve admitted declarative input; legacy/Python jobs retain their original path."""
        if job.input_snapshot is None:
            return job.model_path
        meta = job.input_snapshot
        name = meta.get("source_name")
        if not isinstance(name, str) or not name.endswith(".design.json") or "/" in name or "\\" in name or Path(name).name != name:
            raise ValueError("invalid admitted design input filename")
        if job.dir.resolve().parent != self.root.resolve():
            raise ValueError("admitted design input job directory escapes jobs root")
        snapshot = job.dir / "input" / name
        try:
            if snapshot.resolve().parent != (job.dir.resolve() / "input") or snapshot.is_symlink() or snapshot.parent.is_symlink():
                raise ValueError("snapshot path escapes job input directory")
            data = snapshot.read_bytes()
            if meta.get("format") != "design-json-v1" or hashlib.sha256(data).hexdigest() != meta.get("sha256"):
                raise ValueError("snapshot checksum mismatch")
            if json.loads(data).get("model", {}).get("id") != meta.get("model_id"):
                raise ValueError("snapshot model identity mismatch")
        except (OSError, ValueError, AttributeError) as e:
            raise ValueError(f"admitted design input unavailable or changed: {e}") from e
        return str(snapshot)

    def default_command(self, job: Job) -> list[str]:
        if job.kind == "optimize":
            return self.optimize_command(job)
        cmd = [self.python, "-m", "fairbeam", "run", self.input_path(job), "--threads", str(job.threads),
               "--out", str(self.projects_dir)]
        if job.sim_dir:
            cmd += ["--sim-root", job.sim_dir]
        for k, v in job.overrides.items():
            cmd += ["--set", f"{k}={v}"]
        if job.label and not job.sweep and not job.mesh_density:  # the result name typed in the Run dialog: the bundle's display name
            cmd += ["--label", job.label]
        if job.name:
            cmd += ["--name", job.name]
        if job.engine and job.engine != "cpu":  # `fairbeam run --engine` (GPU build of openEMS)
            cmd += ["--engine", job.engine]
        if job.points:
            cmd += ["--points", str(job.points)]
        if job.mesh_density:
            cmd += ["--mesh-density", f"{float(job.mesh_density):g}"]
        if job.requested_end_criteria_db is not None:  # absent: the model's/design's own threshold
            cmd.append(end_db_arg(job.requested_end_criteria_db))
        return cmd

    def optimize_command(self, job: Job) -> list[str]:
        o = job.optimize or {}
        cmd = [self.python, "-m", "fairbeam", "optimize", self.input_path(job), "--threads", str(job.threads),
               "--out", str(self.projects_dir), "--max-evals", str(o.get("max_evals", 12)),
               "--method", o.get("method", "auto"), "--engine", job.engine or "cpu"]
        if job.sim_dir:
            cmd += ["--sim-root", job.sim_dir]
        for v in o.get("vary", []):
            spec = f"{v['key']}={v['min']!r}:{v['max']!r}"
            if v.get("start") is not None:
                spec += f":{v['start']!r}"
            cmd += ["--vary", spec]
        for g in o.get("goals", []):
            text = f"{g['kind']}={g['target']!r}"
            if g.get("at") is not None:
                text += f"@{g['at']!r}"
            if g.get("ports"):
                text += f":{int(g['ports'][0])},{int(g['ports'][1])}"
            if g.get("weight", 1) != 1:
                text += f"*{g['weight']!r}"
            cmd += ["--goal", text]
        if o.get("excite") and o["excite"] != "auto":
            cmd += ["--excite", o["excite"]]
        if job.requested_end_criteria_db is not None:  # `fairbeam optimize --end-db`, every evaluation
            cmd.append(end_db_arg(job.requested_end_criteria_db))
        for k, v in job.overrides.items():
            cmd += ["--set", f"{k}={v}"]
        if job.name:
            cmd += ["--name", job.name]
        return cmd

    def submit(self, *, model: str, model_path: str, model_id: str | None = None, params: dict | None = None,
               overrides: dict | None = None, threads: int = 1, name: str | None = None,
               end_criteria_db: float | None = None, engine: str | None = None, label: str | None = None,
               sweep: dict | None = None, kind: str = "run", optimize: dict | None = None,
               points: int | None = None, mesh_density: float | None = None, design_input: str | None = None) -> Job:
        snapshot_bytes = None
        if design_input is not None:
            if not str(model_path).endswith(".design.json"):
                raise ValueError("design input snapshots require a .design.json model")
            parsed = json.loads(design_input)
            if not isinstance(parsed, dict) or not isinstance(parsed.get("model"), dict):
                raise ValueError("invalid declarative design input")
            if model_id and parsed.get("model", {}).get("id") != model_id:
                raise ValueError("design input model identity changed; refresh before submitting")
            model_id = model_id or parsed["model"].get("id")
            snapshot_bytes = design_input.encode("utf-8")
        job_id = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
        if not name and kind == "run" and not sweep and str(model_path).endswith(".design.json"):
            # Persist the default before queuing: retries/restarts use the same bundle, while
            # every new designer submission keeps its own result.
            stem = re.sub(r"[^a-z0-9_-]+", "-", (model_id or model).lower()).strip("-_") or "run"
            name = f"{stem[:60]}-{job_id}"
        job = Job(self.root, id=job_id, model=model, model_id=model_id, model_path=str(model_path),
                  params=params or {}, overrides={k: str(v) for k, v in (overrides or {}).items()},
                  threads=threads, name=name, requested_end_criteria_db=end_criteria_db, engine=engine,
                  label=label, sweep=sweep, kind=kind, optimize=optimize, points=points, mesh_density=mesh_density,
                  sim_dir=str(self.sim_root / "runs" / job_id) if self.sim_root else None)
        job.dir.mkdir(parents=True, exist_ok=True)
        if snapshot_bytes is not None:
            # A fixed relative filename avoids trusting paths loaded from persisted job JSON.
            snapshot = job.dir / "input" / Path(model_path).name
            snapshot.parent.mkdir()
            snapshot.write_bytes(snapshot_bytes)
            job.input_snapshot = {"sha256": hashlib.sha256(snapshot_bytes).hexdigest(),
                                  "model_id": model_id, "source_name": Path(model_path).name, "format": "design-json-v1"}
        job.save()  # no queued events or record are published if serialization fails
        job.publish({"type": "status", "status": "queued"})
        job.publish({"type": "phase", "phase": "queued"})
        with self.lock:
            self.jobs[job.id] = job
        self.queue.put(job.id)
        self._changed()
        return job

    def cancel(self, job_id: str) -> Job | None:
        job = self.jobs.get(job_id)
        if job is None:
            return None
        with job.lock:
            if job.terminal:
                return job
            job.cancel_requested = True
            if job.proc is None:  # still queued: the worker will skip it
                self._finish(job, "cancelled", error=None)
                return job
            proc = job.proc
        self._terminate(proc)
        return job

    def clear_queue(self) -> list[Job]:
        """Cancel every job that waits in the queue; the running one is left alone (stop it with
        ``cancel``). Returns the jobs that were cancelled."""
        with self.lock:
            waiting = [j for j in self.jobs.values() if j.status == "queued"]
        cancelled = []
        for j in sorted(waiting, key=lambda j: j.created):
            with j.lock:
                if j.status != "queued" or j.proc is not None:
                    continue  # it started meanwhile: not part of the queue any more
            self.cancel(j.id)
            cancelled.append(j)
        return cancelled

    def cancel_sweep(self, sweep_id: str) -> list[Job]:
        """Cancel every job of a sweep that has not finished (queued ones first, then the running one)."""
        with self.lock:
            jobs = [j for j in self.jobs.values() if (j.sweep or {}).get("id") == sweep_id]
        for j in sorted(jobs, key=lambda j: j.status == "running"):
            if not j.terminal:
                self.cancel(j.id)
        return jobs

    def delete(self, job_id: str, delete_bundle: bool = False) -> dict:
        """Remove a finished job from the history (its folder under ``root``) and its raw openEMS
        output (``sim_dir``, only when it lies inside ``sim_root``). With ``delete_bundle`` the
        bundle it wrote is removed too, but only a ``*.json`` file directly inside the projects
        folder. Raises KeyError / ValueError."""
        job = self.jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        with job.lock:  # _finish holds it while it rebuilds the index from the bundle and saves the job:
            terminal = job.terminal  # Windows cannot delete a file another thread still has open
        if not terminal:
            raise ValueError("only finished, failed, cancelled or interrupted runs can be deleted")
        removed_bundle = None
        if delete_bundle and job.bundle:
            projects = self.projects_dir.resolve()
            target = (projects / job.bundle).resolve()
            if target.parent != projects or target.suffix != ".json" or target.name == "index.json":
                raise ValueError(f"refusing to delete {job.bundle}: not a bundle in the projects folder")
            if target.exists():
                target.unlink()
                removed_bundle = target.name
        root = self.root.resolve()
        folder = job.dir.resolve()
        if folder.parent != root:
            raise ValueError("job folder is outside the jobs folder")
        freed = None
        if job.sim_dir and self.sim_root is not None:
            freed = remove_inside(self.sim_root, Path(job.sim_dir), protect=(self.root, self.projects_dir))
        with self.lock:
            self.jobs.pop(job_id, None)
        self._changed()
        shutil.rmtree(folder, ignore_errors=True)
        return {"deleted": job_id, "bundle_deleted": removed_bundle,
                "sim_deleted": job.sim_dir if freed is not None else None, "sim_freed_bytes": freed or 0}

    def _terminate(self, proc: subprocess.Popen):
        """SIGTERM the whole process group, SIGKILL it after the grace period (Windows:
        CTRL_BREAK to the group, then the job object for the whole tree; see procutil)."""
        if WINDOWS:
            def win_reaper():
                def exited(t):
                    try:
                        proc.wait(timeout=t)
                        return True
                    except subprocess.TimeoutExpired:
                        return False
                terminate_group(proc.pid, self.grace_s, wait=exited, job=getattr(proc, "win_job", None))
            threading.Thread(target=win_reaper, daemon=True).start()
            return
        try:
            pgid = os.getpgid(proc.pid)
        except ProcessLookupError:
            return
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            return

        def reaper():
            try:
                proc.wait(timeout=self.grace_s)
            except subprocess.TimeoutExpired:
                pass
            try:  # kill stragglers of the group even if the leader already exited
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass

        threading.Thread(target=reaper, daemon=True).start()

    def shutdown(self, timeout: float = 10.0):
        """Stop the worker; a running job is killed and marked interrupted."""
        self._stopping = True
        job = self.current
        if job is not None and job.proc is not None and not job.terminal:
            job.cancel_requested = True
            job.error = "The server was stopped while this job was running."
            self._terminate(job.proc)
        self.queue.put(None)
        if self.worker.is_alive():
            self.worker.join(timeout)

    # ------------------------------------------------------------------ worker

    def _work(self):
        while True:
            job_id = self.queue.get()
            if job_id is None or self._stopping:
                break
            job = self.jobs.get(job_id)
            if job is None or job.terminal:
                continue
            self.current = job
            try:
                self._run(job)
            except Exception as e:  # never let one job kill the worker
                self._finish(job, "failed", error=f"internal error: {e}")
            finally:
                self.current = None

    def _name_run(self, job: Job):
        if job.kind != "run":
            return
        from .cli import _slug

        # Resolve at execution time: an earlier queued run may just have written this file.
        # This also covers an explicit run/sweep name matching a shipped example bundle.
        stem = job.name or _slug(job.model_id or job.model, job.overrides)
        candidate = stem
        suffix = 1
        while (self.projects_dir / f"{candidate}.json").exists() or (self.projects_dir / f"{candidate}.json").is_symlink():
            candidate = f"{stem}-{job.id}" if suffix == 1 else f"{stem}-{job.id}-{suffix}"
            suffix += 1
        job.name = candidate
        job.save()

    def _run(self, job: Job):
        parser = ProgressParser(-40.0 if job.end_criteria_db is None else job.end_criteria_db)
        with job.lock:
            if job.cancel_requested:
                return
            job.started = time.time()
            job.status = "running"
            job.phase = "building"
            self._name_run(job)
            self.input_path(job)  # verify before any custom factory or child launch
            cmd = self.command_factory(job)
            log = open(job.dir / "log.txt", "a", buffering=1, encoding="utf-8", errors="replace", newline="\n")
            log.write("$ " + " ".join(cmd) + "\n")
            try:
                job.proc = popen_group(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       stdin=subprocess.DEVNULL, env=child_env(), cwd=str(PACKAGE_ROOT.parent))
            except OSError as e:
                log.close()
                self._finish(job, "failed", error=f"could not start: {e}")
                return
            job.pid = job.proc.pid
            job.command = [str(c) for c in cmd]
            info = process_info(job.pid)  # to recognise the process after a server crash
            job.proc_start = info["lstart"] if info else None
        job.publish({"type": "status", "status": "running", "pid": job.pid, "command": cmd})
        job.publish({"type": "phase", "phase": "building"})
        job.save()
        self._changed()
        if self.on_started is not None:
            try:
                self.on_started(job)
            except Exception:  # noqa: BLE001 - a hook never stops a run
                pass

        stderr_tail: list[str] = []
        write_lock = threading.Lock()

        def pump(stream, name):
            # keep draining whatever happens (a full disk, a parser bug): a pipe nobody reads
            # would block the child and leave the job "running" forever
            for raw in iter(stream.readline, b""):
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                with write_lock:
                    try:
                        log.write(("! " if name == "stderr" else "") + line + "\n")
                    except (OSError, ValueError):
                        pass
                    if name == "stderr" and line.strip():
                        stderr_tail.append(line)
                        del stderr_tail[:-40]
                    try:
                        self._handle(job, parser, line, name)
                    except Exception as e:  # noqa: BLE001 - report once, keep the pipe flowing
                        if not getattr(job, "_handle_error", None):
                            job._handle_error = f"{type(e).__name__}: {e}"
                            stderr_tail.append(f"fairbeam: progress handling failed: {job._handle_error}")
            stream.close()

        threads = [threading.Thread(target=pump, args=(job.proc.stdout, "stdout"), daemon=True),
                   threading.Thread(target=pump, args=(job.proc.stderr, "stderr"), daemon=True)]
        for t in threads:
            t.start()
        code = job.proc.wait()
        release_group(job.proc)  # Windows: whatever the run left behind goes with its job object
        for t in threads:
            t.join(timeout=5)
        log.write(f"[exit code {code}]\n")
        log.close()
        job.exit_code = code

        if job.cancel_requested:
            status = "interrupted" if self._stopping else "cancelled"
            self._finish(job, status, error=job.error if self._stopping else None)
        elif code == 0 and (parser.bundle_path or parser.opt_done):
            self._finish(job, "done", error=None)
        else:
            err = (parser.errors[-1] if parser.errors else None) or (stderr_tail[-1] if stderr_tail else None)
            if code == 0 and not err:
                err = "the run exited without writing a bundle"
            self._finish(job, "failed", error=err or f"exit code {code}", stderr_tail=stderr_tail[-20:])

    def _handle(self, job: Job, parser: ProgressParser, line: str, stream: str):
        job.publish({"type": "log", "stream": stream, "line": line})
        for ev in parser.feed(line, stream):
            kind = ev["type"]
            if kind == "phase":
                job.phase = ev["phase"]
            elif kind == "progress":
                job.last_progress = ev
            elif kind == "info":
                job.info.update({k: v for k, v in ev.items() if k != "type"})
                if "end_criteria_db" in ev:  # the run's own criterion replaces the requested one
                    job.end_criteria_db = ev["end_criteria_db"]
            elif kind == "stats":
                solver_stats = {k: v for k, v in ev.items() if k != "type"}
                if job.kind == "optimize":
                    job.stats.update(solver_stats)
                else:
                    job.stats = solver_stats
            elif kind == "result":
                job.bundle = ev["bundle"]
            elif kind == "opt_start":
                job.stats.update(evaluations=0, max_evals=ev.get("max_evals"),
                                 best_index=None, best_cost=None, best_params=None, best_file=None,
                                 manifest_file=ev.get("file"), elapsed_s=0.0, eta_s=None)
            elif kind == "opt_eval":
                count = int(ev.get("index", job.stats.get("evaluations", 0)))
                max_evals = ev.get("max_evals", job.stats.get("max_evals"))
                evals = [e for e in job.events if e.get("type") == "opt_eval"] + [ev]
                best_eval = next((e for e in reversed(evals) if e.get("index") == ev.get("best_index")), ev)
                elapsed = round(time.time() - (job.started or time.time()), 2)
                completed_s = [float(e["wall_time_s"]) for e in evals
                               if isinstance(e.get("wall_time_s"), (int, float)) and e["wall_time_s"] >= 0]
                eta = (round(sum(completed_s) / len(completed_s) * max(0, max_evals - count), 2)
                       if completed_s and max_evals is not None else None)
                job.stats.update(evaluations=count, max_evals=max_evals,
                                 best_index=ev.get("best_index"), best_cost=ev.get("best_cost"),
                                 best_params=best_eval.get("params"), best_file=best_eval.get("file"),
                                 elapsed_s=elapsed, eta_s=eta)
                ev.update(evaluations=count, best_params=best_eval.get("params"),
                          best_file=best_eval.get("file"), elapsed_s=elapsed, eta_s=eta)
            elif kind == "opt_done":
                best = ev.get("best") or {}
                job.stats.update(evaluations=ev.get("evaluations"), reason=ev.get("reason"),
                                 best_index=best.get("index"), best_cost=best.get("cost"),
                                 best_params=best.get("params"), best_file=best.get("file"),
                                 manifest_file=ev.get("file"), wall_time_s=ev.get("wall_time_s"),
                                 elapsed_s=round(time.time() - (job.started or time.time()), 2), eta_s=0.0)
            job.publish(ev)
            if kind in ("phase", "result", "opt_start", "opt_eval", "opt_done"):
                job.save()

    def _close_optimization(self, job: Job, status: str):
        """A cancelled (or killed) optimizer child cannot record how it ended: SIGTERM / TerminateProcess
        stop it before its own handler runs. Its manifest then still says "running"; record the job's
        final status there (the child has exited, so nothing else writes the file)."""
        rel = job.stats.get("manifest_file") if isinstance(job.stats, dict) else None
        if not isinstance(rel, str) or not rel:
            return
        try:
            root = self.projects_dir.resolve()
            path = (root / rel).resolve()
            if root not in path.parents or path.suffix != ".json" or not path.is_file():
                return
            doc = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(doc, dict) or doc.get("reason") != "running":
                return
            doc["reason"] = status
            doc["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(json.dumps(finite_json(doc), indent=1, allow_nan=False), encoding="utf-8")
            os.replace(tmp, path)
        except (OSError, ValueError):
            pass  # the job's own record is what matters; the manifest is best effort

    def _finish(self, job: Job, status: str, error: str | None, stderr_tail: list[str] | None = None):
        with job.lock:
            if job.terminal:
                return
            job.status = status
            job.phase = status
            job.finished = time.time()
            job.error = error
            job.proc = None
            if job.kind == "optimize" and status != "done":
                self._close_optimization(job, status)
            if self.on_finished is not None:  # before the terminal event, so clients see a fresh index
                try:
                    self.on_finished(job)
                except Exception:
                    pass
            ev = {"type": "status", "status": status, "exit_code": job.exit_code, "bundle": job.bundle,
                  "duration_s": job.duration()}
            if error:
                ev["error"] = error
            if stderr_tail:
                ev["stderr_tail"] = stderr_tail
            job.publish({"type": "phase", "phase": status})
            job.publish(ev)
            job.save()
            job.trim_events()  # SSE clients that are behind read the rest from events.jsonl
        self._changed()
