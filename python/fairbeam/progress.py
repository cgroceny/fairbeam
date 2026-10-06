"""Live progress parsing for ``fairbeam run`` output.

The run server feeds every line a job prints (fairbeam's own messages plus the openEMS C++ output
that :func:`fairbeam.simulation._capture_output` echoes to stdout) into a :class:`ProgressParser`.
The parser turns them into structured events: phase changes, solver info, periodic progress with an
ETA estimate, final statistics and the written bundle. It uses the same line formats as
``simulation._parse_log``, which parses the complete log after the run.

Pure Python, no openEMS import, so it can be unit tested with recorded logs.
"""

from __future__ import annotations

import json
import re

# Ordered phases of a job. "done", "failed", "cancelled" and "interrupted" are terminal.
PHASES = ("queued", "building", "setup", "running", "postprocessing", "exporting", "done")
TERMINAL = ("done", "failed", "cancelled", "interrupted")

_NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"

RE = {
    "label": re.compile(r"^fairbeam: (?!wrote |error: |warning: |note: |end criterion |excitation pulse |optimize |optimization written |best of |run \d+/\d+: |\d+ timesteps in )(.+)$"),
    # printed by `fairbeam run` before openEMS starts (cli.cmd_run)
    "settings": re.compile(rf"^fairbeam: end criterion ({_NUM}) dB, max timesteps (\d+)(?:, engine (\S+))?"),
    # printed by `fairbeam run` next to the settings line: the excitation pulse's length (s)
    "pulse": re.compile(rf"^fairbeam: excitation pulse ({_NUM}) s"),
    "threads": re.compile(r"openEMS - fixed number of threads: (\d+)"),
    "version": re.compile(r"\| openEMS \S+ -- version (\S+)"),
    "operator": re.compile(r"^Create FDTD operator"),
    "size": re.compile(rf"FDTD simulation size: (\d+)x(\d+)x(\d+) --> ({_NUM}) FDTD cells"),
    "dt": re.compile(rf"FDTD timestep is: ({_NUM}) s; Nyquist rate: (\d+) timesteps @({_NUM}) Hz"),
    "max_ts": re.compile(r"Max\. number of timesteps: (\d+)"),
    "engine": re.compile(r"^Running FDTD engine"),
    "progress": re.compile(
        rf"\[@\s*(?P<clock>[^\]]*)\]\s*Timestep:\s*(?P<ts>\d+)\s*\|\|\s*Speed:\s*(?P<speed>{_NUM})\s*MC/s"
        rf"(?:\s*\((?P<spts>{_NUM})\s*s/TS\))?"
        rf"(?:\s*\|\|\s*Energy:\s*~\s*(?P<energy>{_NUM})\s*\(\s*(?P<db>-?\s*{_NUM}|-?inf)\s*dB\))?"),
    "time": re.compile(rf"Time for (\d+) iterations with ({_NUM}) cells : ({_NUM}) sec"),
    "speed": re.compile(rf"^Speed: ({_NUM}) MCells/s"),
    "limit": re.compile(r"Max\. number of timesteps was reached"),
    # "final energy <= -60.0 dB" when openEMS logged no energy line (runs shorter than ~4 s)
    "summary": re.compile(rf"^fairbeam: (\d+|None) timesteps in ({_NUM}|None) s, final energy (<= )?({_NUM}|None|\?) dB, "
                          r"converged=(True|False)"),
    "band": re.compile(rf"^\s+band ({_NUM})-({_NUM}) GHz, min S11 ({_NUM}) dB @ ({_NUM}) GHz"),
    "farfield": re.compile(rf"^\s+far field ({_NUM}) GHz: Dmax ({_NUM}) dBi(?:, rad\. efficiency ({_NUM}|None))?"),
    "wrote": re.compile(r"^fairbeam: wrote (.+?)\s*$"),
    # multi-port runs (multiport.run_model): openEMS runs once per driven port
    "port_run": re.compile(r"^fairbeam: run (\d+)/(\d+): port (\d+) excited"),
    # fairbeam optimize (optimize.py): one JSON object per line
    "optimize": re.compile(r"^fairbeam: optimize (start|eval|done) (\{.*\})\s*$"),
    "error": re.compile(r"^fairbeam: error: (.+)$"),
}


def parse_clock(text: str) -> float | None:
    """openEMS wall clock prefix, e.g. ``"       4s"``, ``"1m04s"`` or ``"2h03m04s"`` -> seconds."""
    text = text.strip()
    if not text:
        return None
    total, found = 0.0, False
    for value, unit in re.findall(r"(\d+(?:\.\d+)?)\s*([dhms])", text):
        total += float(value) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[unit]
        found = True
    return total if found else None


def _db(text: str | None) -> float | None:
    if text is None:
        return None
    t = text.replace(" ", "")
    if t in ("-inf", "inf"):
        return float("-inf")
    try:
        return float(t)
    except ValueError:
        return None


def estimate_eta(points: list[tuple[int, float]], s_per_ts: float | None, end_db: float = -40.0,
                 max_timesteps: int | None = None, window: int = 4) -> dict | None:
    """Estimate the remaining solver time from the energy decay.

    ``points`` are ``(timestep, energy_db)`` samples, oldest first. The energy in dB is fitted
    linearly against the timestep over the last ``window`` samples; the fit is extrapolated to the
    end criterion. At least two samples are needed (openEMS prints one about every 4 s of wall
    time, so short runs may never get there); with fewer, only the timestep-limit bound
    ``limit_s`` is reported and ``eta_s`` is absent. The result is capped by the timestep limit and
    is always an estimate: the decay is not exactly exponential, especially early in the run.
    """
    if not points:
        return None
    ts, db = points[-1]
    finite = [(t, d) for t, d in points if d is not None and d != float("-inf")]
    out: dict = {"estimate": True, "end_db": end_db, "points": len(finite), "timestep": ts}
    limit_left = None
    if max_timesteps:
        limit_left = max(0, max_timesteps - ts)
        out["limit_s"] = round(limit_left * s_per_ts, 2) if s_per_ts else None
    if db is not None and db <= end_db:
        out.update(eta_s=0.0, remaining_timesteps=0, basis="converged", confidence="high")
        return out

    recent = finite[-window:]
    slope = None
    if len(recent) >= 2:
        n = len(recent)
        mx = sum(t for t, _ in recent) / n
        my = sum(d for _, d in recent) / n
        sxx = sum((t - mx) ** 2 for t, _ in recent)
        if sxx > 0:
            slope = sum((t - mx) * (d - my) for t, d in recent) / sxx
        basis, confidence = "energy-fit", "medium" if n >= 3 else "low"
    else:
        return out  # one sample: no decay rate yet

    remaining = None
    if slope is not None and slope < -1e-12 and db is not None:
        remaining = (end_db - db) / slope
        if limit_left is not None and remaining > limit_left:
            remaining, basis = limit_left, "timestep-limit"
    elif limit_left is not None:  # energy not decaying: the run will stop at the limit
        remaining, basis, confidence = limit_left, "timestep-limit", "bound"
    if remaining is None:
        return out
    out.update(remaining_timesteps=int(round(remaining)), target_timestep=int(round(ts + remaining)),
               basis=basis, confidence=confidence, slope_db_per_kts=round(slope * 1000, 4) if slope else None,
               eta_s=round(remaining * s_per_ts, 2) if s_per_ts else None)
    return out


class ProgressParser:
    """Feed lines with :meth:`feed`; each call returns a (possibly empty) list of event dicts.

    Event types (``type`` key): ``phase``, ``info``, ``progress``, ``stats``, ``result``, ``error``.
    The job manager adds ``seq`` and ``t`` and publishes them.
    """

    def __init__(self, end_db: float = -40.0):
        self.end_db = float(end_db)
        self.phase = "building"
        self.info: dict = {}
        self.energy: list[tuple[int, float]] = []
        self.last_progress: dict | None = None
        self.stats: dict = {}
        self.bundle_path: str | None = None
        self.opt_done: dict | None = None  # final summary of an optimization run
        self.errors: list[str] = []
        self._prev: tuple[int, float] | None = None  # (timestep, clock) of the previous progress line
        # multi-port: current run k of n (port p); solver times of the finished port runs
        self.port_run: tuple[int, int, int] | None = None
        self.port_times: list[float] = []

    def _phase(self, phase: str, out: list):
        if phase != self.phase and PHASES.index(phase) > PHASES.index(self.phase):
            self.phase = phase
            out.append({"type": "phase", "phase": phase})

    def _pulse_steps(self, out: list):
        """The timestep the excitation pulse ends at, once both its length and the timestep are known:
        the energy stays flat until then (the live view says so)."""
        dt = self.info.get("dt_s")
        pulse = getattr(self, "pulse_s", None)
        if dt and pulse:
            self._info(out, pulse_steps=int(round(pulse / dt)))

    def _info(self, out: list, **kw):
        self.info.update(kw)
        out.append({"type": "info", **kw})

    def feed(self, line: str, stream: str = "stdout") -> list[dict]:
        line = line.rstrip("\r\n")
        out: list[dict] = []
        if not line.strip():
            return out
        if m := RE["progress"].search(line):
            self._phase("running", out)
            out.append(self._progress(m))
            return out
        if m := RE["error"].match(line):
            self.errors.append(m.group(1))
            out.append({"type": "error", "message": m.group(1)})
            return out
        if m := RE["port_run"].match(line):
            k, n, port = int(m.group(1)), int(m.group(2)), int(m.group(3))
            self.port_run = (k, n, port)
            self.energy, self._prev, self.last_progress = [], None, None  # openEMS starts over
            if k > 1 and self.phase != "setup":
                self.phase = "setup"  # back to operator setup for the next port (not monotonic here)
                out.append({"type": "phase", "phase": "setup", "port_run": k, "port_total": n})
            else:
                self._phase("setup", out)
            self._info(out, port_run=k, port_total=n, port=port)
            return out
        if m := RE["optimize"].match(line):
            try:
                payload = json.loads(m.group(2))
            except ValueError:
                return out
            kind = m.group(1)
            if kind == "start":
                self._phase("running", out)
            elif kind == "done":
                self.opt_done = payload
                self._phase("exporting", out)
            out.append({"type": f"opt_{kind}", **payload})
            return out
        if m := RE["wrote"].match(line):
            self.bundle_path = m.group(1)
            name = re.split(r"[\\/]", self.bundle_path)[-1]
            out.append({"type": "result", "bundle": name, "path": self.bundle_path})
            return out
        if m := RE["summary"].match(line):
            self._phase("postprocessing", out)
            conv = m.group(5) == "True" and not self.stats.get("hit_timestep_limit")
            self.stats.update(converged=conv)
            if m.group(4) not in ("None", "?"):
                key, other = (("final_energy_bound_db", "final_energy_db") if m.group(3)
                              else ("final_energy_db", "final_energy_bound_db"))
                self.stats[key] = float(m.group(4))
                self.stats.pop(other, None)
            out.append({"type": "stats", **self.stats})
            return out
        if RE["band"].match(line) or RE["farfield"].match(line):
            self._phase("exporting", out)
            if m := RE["band"].match(line):
                self.stats.setdefault("bands", []).append(
                    {"f_lo_ghz": float(m.group(1)), "f_hi_ghz": float(m.group(2)),
                     "s11_min_db": float(m.group(3)), "f_center_ghz": float(m.group(4))})
            elif m := RE["farfield"].match(line):
                eff = m.group(3)
                self.stats.setdefault("farfield", []).append(
                    {"f_ghz": float(m.group(1)), "dmax_dbi": float(m.group(2)),
                     "rad_efficiency": float(eff) if eff and eff != "None" else None})
            out.append({"type": "stats", **self.stats})
            return out
        if m := RE["settings"].match(line):
            self._phase("setup", out)
            self.end_db = float(m.group(1))
            kw = {"end_criteria_db": self.end_db, "max_timesteps": int(m.group(2))}
            if m.group(3):
                kw["engine"] = m.group(3)
            self._info(out, **kw)
            return out
        if m := RE["pulse"].match(line):
            self.pulse_s = float(m.group(1))
            self._pulse_steps(out)
            return out
        if m := RE["label"].match(line):
            self._phase("setup", out)
            self._info(out, label=m.group(1))
            return out
        if m := RE["threads"].search(line):
            self._info(out, threads=int(m.group(1)))
        elif m := RE["version"].search(line):
            self._info(out, openems=m.group(1))
        elif RE["operator"].match(line):
            self._phase("setup", out)
        elif m := RE["size"].search(line):
            self._info(out, grid=[int(m.group(i)) for i in (1, 2, 3)], cells=int(float(m.group(4))))
        elif m := RE["dt"].search(line):
            self._info(out, dt_s=float(m.group(1)), nyquist_timesteps=int(m.group(2)))
            self._pulse_steps(out)
        elif m := RE["max_ts"].search(line):
            self._info(out, max_timesteps=int(m.group(1)))
        elif RE["engine"].match(line):
            self._phase("running", out)
        elif m := RE["time"].search(line):
            self.stats.update(timesteps=int(m.group(1)), solver_time_s=float(m.group(3)))
            if self.port_run:
                self.port_times.append(float(m.group(3)))
            # the DC-free custom excitation suppresses openEMS' "Max. number of timesteps was
            # reached" warning, so compare with the limit instead
            max_ts = self.info.get("max_timesteps")
            if max_ts and self.stats["timesteps"] >= max_ts:
                self.stats["hit_timestep_limit"] = True
            self._phase("postprocessing", out)
            out.append({"type": "stats", **self.stats})
        elif m := RE["speed"].match(line):
            self.stats["speed_mcells_s"] = float(m.group(1))
            out.append({"type": "stats", **self.stats})
        elif RE["limit"].search(line):
            self.stats["hit_timestep_limit"] = True
            out.append({"type": "stats", **self.stats})
        elif stream == "stderr" and line.strip():
            self.errors.append(line.strip())
        return out

    def _progress(self, m: re.Match) -> dict:
        ts = int(m.group("ts"))
        clock = parse_clock(m.group("clock"))
        s_per_ts = float(m.group("spts")) if m.group("spts") else None
        db = _db(m.group("db"))
        if s_per_ts is None and self._prev and clock is not None and clock > self._prev[1] and ts > self._prev[0]:
            s_per_ts = (clock - self._prev[1]) / (ts - self._prev[0])  # measured over the interval
        if clock is not None:
            self._prev = (ts, clock)
        ev: dict = {"type": "progress", "timestep": ts, "speed_mcs": float(m.group("speed")),
                    "s_per_ts": s_per_ts, "solver_clock_s": clock}
        if db is not None:
            ev["energy_db"] = db if db != float("-inf") else None
            if db != float("-inf"):
                self.energy.append((ts, db))
        max_ts = self.info.get("max_timesteps")
        if max_ts:
            ev["timestep_fraction"] = round(min(1.0, ts / max_ts), 4)
        if db is not None and db != float("-inf") and self.end_db < 0:
            ev["energy_fraction"] = round(max(0.0, min(1.0, db / self.end_db)), 4)
        ev["eta"] = estimate_eta(self.energy, s_per_ts, self.end_db, max_ts)
        if self.port_run:
            k, n, port = self.port_run
            ev.update(port_run=k, port_total=n, port=port)
            eta = ev["eta"]
            if eta is not None and eta.get("eta_s") is not None and clock is not None:
                # the whole job: this port's remaining time plus the remaining ports, each taking
                # the mean of the finished ports (or this port's projected total)
                per_port = (sum(self.port_times) / len(self.port_times)) if self.port_times else clock + eta["eta_s"]
                eta["ports_remaining"] = n - k
                eta["job_eta_s"] = round(eta["eta_s"] + (n - k) * per_port, 2)
        self.last_progress = ev
        return ev
