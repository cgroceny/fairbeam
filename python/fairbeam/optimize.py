"""Goal-driven parameter optimisation (a small optimizer).

    fairbeam optimize python/models/dipole.py --vary length=50:66 --goal f0=2.40 --engine gpu
    fairbeam optimize python/models/patch_antenna.py --vary patch_w=28:36 --vary feed_x=-12:-2 \\
        --goal f0=2.45 --goal "s11_max=-25@2.45" --engine gpu --max-evals 15

Bounded numeric parameters. Algorithms use numpy without scipy:

- ``secant``: for one parameter and a resonance goal only. A bracketed secant (Illinois false
  position once the target is bracketed) on f0(x) - target; the second point assumes f0 ∝ 1/x, the
  usual behaviour of a resonant length. Falls back to Nelder–Mead if it stops making progress.
- ``nelder-mead``: bounded Nelder–Mead on parameters scaled to [0, 1] (points are clipped to the
  box), restarted around the best point when the simplex stagnates.
- ``bayesian``: Gaussian-process expected-improvement search.
- ``cma-es``, ``particle-swarm``, ``genetic``: population searches.
- ``trust-region``: bounded finite-difference local search.

Goals, combinable with weights (``*w``):

- ``f0=<GHz>``: first resonance = centre of the first -10 dB band, else the first upward zero of
  Im(Zin), else the |S11| minimum. Cost ((f0 - target) / target / 1 %)²; met within ``--f0-tol`` %.
- ``s11_max=<dB>@<GHz>``: |S11| at a frequency below a level. Cost (excess / 3 dB)².
- ``bw_min=<MHz>``: -10 dB bandwidth of the band around f0 (or the first band). Cost (shortfall / 10 %)².
- ``dmax_min=<dBi>@<GHz>``: directivity at a frequency. Cost (shortfall / 0.5 dB)².
- Multi-port (``results.sparams``; port numbers as in the model):
  ``sij_max=<dB>@<GHz>:<i>,<j>`` |S_ij| at most (isolation, e.g. S23), cost (excess / 3 dB)²;
  ``sij_min=<dB>@<GHz>:<i>,<j>`` |S_ij| at least (transmission, e.g. S21), cost (shortfall / 0.5 dB)²;
  ``match_all=<dB>@<GHz>`` every S_ii at most, cost (worst excess / 3 dB)².
  Each evaluation of a multi-port model runs openEMS once per driven port; ``--excite auto``
  drives only the ports the goals need (S_ij needs port j driven, or port i by reciprocity;
  ``match_all`` needs every port).

The run stops when every goal is met, after ``--max-evals`` evaluations, or when the search
converges.

For a design (``.design.json``) each candidate is checked before it is simulated
(:func:`precheck`, fairbeam.design_checks): a point with check errors, or one that makes a metal
part overhang its substrate or float in the air (``metal-overhang`` / ``metal-floating`` that the
design at its own values does not have), is not simulated. It is recorded as a failed evaluation
(a cost of ``PENALTY`` or more, ``"skipped": <reason>``) and the search goes on; ``--no-precheck`` simulates
every candidate. Every evaluation is a normal simulation (cached by the rounded parameter tuple) whose
bundle is written to ``<out>/optimizations/<name>/`` (outside the main project index), and
``<out>/optimizations/<name>.json`` (schema ``fairbeam.optimization/1``) records the goals, every
evaluation with parameters, metrics and cost, the best point and why the run stopped. The file is
rewritten after every evaluation. Machine-readable progress lines (``fairbeam: optimize ...``)
let the run server show the run live.
"""

from __future__ import annotations

import json
import math
import os
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from .jsonutil import finite_json

OPT_SCHEMA = "fairbeam.optimization/1"
GOAL_KINDS = ("f0", "s11_max", "bw_min", "dmax_min", "sij_max", "sij_min", "match_all")
FREQ_GOALS = ("s11_max", "dmax_min", "sij_max", "sij_min", "match_all")
PAIR_GOALS = ("sij_max", "sij_min")
METHOD_CHOICES = ("auto", "secant", "nelder-mead", "bayesian", "cma-es", "particle-swarm", "genetic", "trust-region")


class Stop(Exception):
    """Raised by the objective to end the search (goals met, evaluation budget used)."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


# ---------------------------------------------------------------------------- problem definition

@dataclass
class Goal:
    kind: str
    target: float
    at: float | None = None  # GHz, for the frequency goals
    weight: float = 1.0
    ports: tuple[int, int] | None = None  # (i, j) for sij_max / sij_min

    def label(self) -> str:
        unit = {"f0": " GHz", "s11_max": " dB", "bw_min": " MHz", "dmax_min": " dBi", "sij_max": " dB",
                "sij_min": " dB", "match_all": " dB"}[self.kind]
        at = f" @ {self.at:g} GHz" if self.at is not None else ""
        w = f" ×{self.weight:g}" if self.weight != 1 else ""
        if self.kind in PAIR_GOALS:
            i, j = self.ports
            return f"|S{i}{j}| {'≤' if self.kind == 'sij_max' else '≥'} {self.target:g}{unit}{at}{w}"
        if self.kind == "match_all":
            return f"all |Sii| ≤ {self.target:g}{unit}{at}{w}"
        return f"{self.kind} {self.target:g}{unit}{at}{w}"


@dataclass
class Vary:
    key: str
    lo: float
    hi: float
    start: float | None = None
    resolution: float | None = None  # parameter values are rounded to this step (cache key)

    def __post_init__(self):
        if not (math.isfinite(self.lo) and math.isfinite(self.hi)) or self.hi <= self.lo:
            raise ValueError(f"{self.key}: need finite bounds with min < max")
        if self.start is not None and not self.lo <= self.start <= self.hi:
            raise ValueError(f"{self.key}: start {self.start} outside [{self.lo}, {self.hi}]")
        if self.resolution is None:  # a power of ten about 1/1000 of the range (58.0 stays 58.0)
            self.resolution = 10.0 ** math.floor(math.log10((self.hi - self.lo) / 1000))

    def snap(self, x: float) -> float:
        x = min(self.hi, max(self.lo, x))
        r = self.resolution or 0
        v = round(round(x / r) * r, 10) if r > 0 else x
        return float(f"{min(self.hi, max(self.lo, v)):.10g}")


def parse_goal(text: str) -> Goal:
    """``f0=2.45``, ``s11_max=-25@2.45``, ``bw_min=150*2``, ``dmax_min=5@2.4``, ``sij_max=-25@2.4:2,3``,
    ``sij_min=-3.2@2.4:2,1``, ``match_all=-20@2.4``."""
    m = re.fullmatch(r"\s*(\w+)\s*=\s*([-+0-9.eE]+)\s*(?:@\s*([-+0-9.eE]+))?\s*(?::\s*(\d+)\s*,\s*(\d+))?"
                     r"\s*(?:\*\s*([0-9.eE]+))?\s*", text or "")
    if not m or m.group(1) not in GOAL_KINDS:
        raise ValueError(f"goal '{text}': expected one of {', '.join(k + '=...' for k in GOAL_KINDS)}")
    kind = m.group(1)
    target = float(m.group(2))
    at = float(m.group(3)) if m.group(3) else None
    ports = (int(m.group(4)), int(m.group(5))) if m.group(4) else None
    weight = float(m.group(6)) if m.group(6) else 1.0
    return make_goal(kind, target, at, weight, ports)


def make_goal(kind: str, target: float, at: float | None = None, weight: float = 1.0,
              ports: tuple[int, int] | None = None) -> Goal:
    if kind not in GOAL_KINDS:
        raise ValueError(f"unknown goal {kind!r}")
    if not math.isfinite(target):
        raise ValueError(f"{kind}: target must be a number")
    if at is not None and not math.isfinite(at):
        raise ValueError(f"{kind}: frequency must be a finite number of GHz")
    if kind in FREQ_GOALS and (at is None or not at > 0):
        raise ValueError(f"{kind} needs a frequency: {kind}=<value>@<GHz>")
    if kind in PAIR_GOALS:
        if ports is None or len(ports) != 2 or min(ports) < 1:
            raise ValueError(f"{kind} needs two port numbers: {kind}=<dB>@<GHz>:<i>,<j>")
        ports = (int(ports[0]), int(ports[1]))
        if target > 0:
            raise ValueError(f"{kind}: target must be a level in dB (<= 0)")
    else:
        ports = None
    if kind in ("sij_max", "match_all") and target >= 0:
        raise ValueError(f"{kind}: target must be negative dB")
    if kind in ("f0", "bw_min") and not target > 0:
        raise ValueError(f"{kind}: target must be positive")
    if kind == "s11_max" and target >= 0:
        raise ValueError("s11_max: target must be negative dB")
    if not (weight > 0 and math.isfinite(weight)):
        raise ValueError(f"{kind}: weight must be positive")
    return Goal(kind, float(target), None if at is None else float(at), float(weight), ports)


def needed_excite(goals: list[Goal], port_numbers: list[int]) -> list[int]:
    """Ports to drive so that every goal can be evaluated (one openEMS run per driven port).

    Single-port goals use the first port. S_ij is known when port j is driven, or port i (the
    network is reciprocal). ``match_all`` needs every S_ii, hence every port."""
    if len(port_numbers) <= 1:
        return list(port_numbers)
    driven: set[int] = set()
    if any(g.kind == "match_all" for g in goals):
        return sorted(port_numbers)
    if any(g.kind not in PAIR_GOALS for g in goals):
        driven.add(port_numbers[0])
    for g in goals:
        if g.kind in PAIR_GOALS:
            i, j = g.ports
            if i not in driven and j not in driven:
                driven.add(j)
    return sorted(driven)


def sparam_matrix(bundle: dict):
    """(frequency GHz, port numbers, (nf, N, N) complex S with NaN where unknown) of a bundle; the
    excited port's S11 for single-port bundles."""
    from .study import _excited_key

    res = bundle.get("results") or {}
    f = np.asarray(res.get("frequency") or [], float) / 1e9
    sp = res.get("sparams")
    if sp and sp.get("s"):
        from .multiport import s_from_section

        numbers = sp.get("port_numbers") or sp.get("ports") or []
        return f, [int(n) for n in numbers], s_from_section(sp)
    key = _excited_key(bundle)
    if key is None:
        return f, [], np.zeros((len(f), 0, 0), complex)
    pr = res["ports"][key]
    s = (np.asarray(pr["s11_re"]) + 1j * np.asarray(pr["s11_im"])).reshape(-1, 1, 1)
    return f, [int(key)], s


def s_db_at(f, numbers, s, i: int, j: int, f_ghz: float) -> float | None:
    """|S_ij| in dB at f_ghz (linear interpolation of the magnitude); S_ji when S_ij was not
    measured (reciprocity); None when neither is known or a port does not exist."""
    if i not in numbers or j not in numbers or not len(f):
        return None
    if not f[0] - 1e-9 <= f_ghz <= f[-1] + 1e-9:
        return None  # outside the simulated band: never extrapolate (np.interp would clamp)
    a, b = numbers.index(i), numbers.index(j)
    col = s[:, a, b]
    if np.isnan(col).any():
        col = s[:, b, a]
    if np.isnan(col).any():
        return None
    mag = float(np.interp(f_ghz, f, np.abs(col)))
    return round(20 * math.log10(max(mag, 1e-9)), 3)


def parse_vary(text: str) -> Vary:
    """``length=50:66`` or ``length=50:66:58`` (start) or ``length=50:66:58:0.1`` (resolution)."""
    m = re.fullmatch(r"\s*(\w+)\s*=\s*([-+0-9.eE]+)\s*:\s*([-+0-9.eE]+)(?:\s*:\s*([-+0-9.eE]*))?(?:\s*:\s*([0-9.eE]+))?\s*", text or "")
    if not m:
        raise ValueError(f"--vary '{text}': expected key=min:max[:start[:resolution]]")
    start = float(m.group(4)) if m.group(4) else None
    res = float(m.group(5)) if m.group(5) else None
    return Vary(m.group(1), float(m.group(2)), float(m.group(3)), start, res)


# ---------------------------------------------------------------------------- metrics and cost

def bundle_metrics(bundle: dict, goals: list[Goal]) -> dict:
    """The quantities the goals need, from a result bundle."""
    from .study import _excited_key, first_resonance, reactance_zeros

    res = bundle.get("results") or {}
    out: dict = {"f0_ghz": None, "f0_source": None, "s11_min_db": None, "bw_mhz": None,
                 "s11_at": {}, "dmax_at": {}, "dmax_dbi": None}
    key = _excited_key(bundle)
    if key is None:
        return out
    f = np.asarray(res["frequency"]) / 1e9
    pr = res["ports"][key]
    s = np.hypot(np.asarray(pr["s11_re"]), np.asarray(pr["s11_im"]))
    sdb = 20 * np.log10(np.maximum(s, 1e-9))
    out["s11_min_db"] = round(float(sdb.min()), 3)
    bands = res.get("bands") or []
    if bands:
        out["f0_ghz"], out["f0_source"] = bands[0]["f_center"] / 1e9, "band"
    else:
        zeros = reactance_zeros(bundle)
        if zeros:
            out["f0_ghz"], out["f0_source"] = zeros[0]["f"] / 1e9, "reactance"
        else:
            fr = first_resonance(bundle)
            if fr:
                out["f0_ghz"], out["f0_source"] = fr["f"] / 1e9, "s11_min"
    if out["f0_ghz"] is not None:
        out["f0_ghz"] = round(out["f0_ghz"], 6)
        out["s11_f0_db"] = round(float(np.interp(out["f0_ghz"], f, sdb)), 3)
    if bands:
        f0 = out["f0_ghz"]
        band = next((b for b in bands if b["f_lo"] / 1e9 <= f0 <= b["f_hi"] / 1e9), bands[0])
        out["bw_mhz"] = round((band["f_hi"] - band["f_lo"]) / 1e6, 3)
    else:
        out["bw_mhz"] = 0.0
    ffs = res.get("farfield") or []
    if any(g.kind in PAIR_GOALS or g.kind == "match_all" for g in goals):
        sf, numbers, smat = sparam_matrix(bundle)
        out["sij_at"], out["match_all_at"] = {}, {}
        for g in goals:
            if g.kind in PAIR_GOALS:
                i, j = g.ports
                out["sij_at"][f"{i},{j}@{g.at:g}"] = s_db_at(sf, numbers, smat, i, j, g.at)
            elif g.kind == "match_all":
                vals = [s_db_at(sf, numbers, smat, n, n, g.at) for n in numbers]
                out["match_all_at"][f"{g.at:g}"] = (None if not vals or any(v is None for v in vals)
                                                    else {"max": max(vals), "ports": dict(zip(map(str, numbers), vals))})
    for g in goals:
        if g.kind == "s11_max":
            inside = len(f) and f[0] - 1e-9 <= g.at <= f[-1] + 1e-9
            out["s11_at"][f"{g.at:g}"] = round(float(np.interp(g.at, f, sdb)), 3) if inside else None
        if g.kind == "dmax_min" and ffs:
            ff = min(ffs, key=lambda e: abs(e["f"] / 1e9 - g.at))
            # a pattern more than 2 % away from the goal frequency does not answer the goal
            out["dmax_at"][f"{g.at:g}"] = ff["dmax_dbi"] if abs(ff["f"] / 1e9 - g.at) <= 0.02 * g.at else None
    if ffs:
        out["dmax_dbi"] = ffs[0]["dmax_dbi"]
    run = bundle.get("run") or {}
    out["timesteps"] = run.get("timesteps")
    out["converged"] = run.get("converged")
    out["wall_time_s"] = run.get("wall_time_s")
    out["engine"] = run.get("engine")
    return out


PENALTY = 1e4  # a goal that cannot be evaluated (no resonance, no far field)


def goal_cost(g: Goal, m: dict, f0_tol_pct: float = 0.25) -> tuple[float, bool, float | None]:
    """(cost, met, value) of one goal for the metrics ``m``."""
    if g.kind == "f0":
        v = m.get("f0_ghz")
        if v is None:
            return PENALTY, False, None
        err_pct = 100.0 * (v - g.target) / g.target
        return err_pct ** 2, abs(err_pct) <= f0_tol_pct, v
    if g.kind == "s11_max":
        v = (m.get("s11_at") or {}).get(f"{g.at:g}")
        if v is None:
            return PENALTY, False, None
        excess = max(0.0, v - g.target)
        return (excess / 3.0) ** 2, excess == 0.0, v
    if g.kind == "bw_min":
        v = m.get("bw_mhz") or 0.0
        short = max(0.0, (g.target - v) / g.target)
        return (short / 0.1) ** 2, short == 0.0, v
    if g.kind == "dmax_min":
        v = (m.get("dmax_at") or {}).get(f"{g.at:g}")
        if v is None:
            return PENALTY, False, None
        short = max(0.0, g.target - v)
        return (short / 0.5) ** 2, short == 0.0, v
    if g.kind in PAIR_GOALS:
        v = (m.get("sij_at") or {}).get(f"{g.ports[0]},{g.ports[1]}@{g.at:g}")
        if v is None:
            return PENALTY, False, None
        if g.kind == "sij_max":
            excess = max(0.0, v - g.target)
            return (excess / 3.0) ** 2, excess == 0.0, v
        short = max(0.0, g.target - v)
        return (short / 0.5) ** 2, short == 0.0, v
    if g.kind == "match_all":
        entry = (m.get("match_all_at") or {}).get(f"{g.at:g}")
        if not entry:
            return PENALTY, False, None
        v = entry["max"]
        excess = max(0.0, v - g.target)
        return (excess / 3.0) ** 2, excess == 0.0, v
    raise ValueError(g.kind)


def total_cost(goals: list[Goal], m: dict, f0_tol_pct: float = 0.25) -> tuple[float, list[dict], bool]:
    parts, total, all_met = [], 0.0, True
    for g in goals:
        c, met, v = goal_cost(g, m, f0_tol_pct)
        total += g.weight * c
        all_met = all_met and met
        parts.append({"goal": g.label(), "kind": g.kind, "value": v, "cost": round(c, 6), "met": met})
    return round(total, 6), parts, all_met


# ---------------------------------------------------------------------------- the search

Evaluator = Callable[[dict], dict]  # {key: value} -> {"metrics": {...}, "file": ..., "wall_time_s": ...}


@dataclass
class Driver:
    """Objective with caching, history, budget and goal checks."""

    vary: list[Vary]
    goals: list[Goal]
    evaluate: Evaluator
    max_evals: int = 12
    f0_tol_pct: float = 0.25
    on_eval: Callable[[dict], None] | None = None
    history: list[dict] = field(default_factory=list)
    cache: dict = field(default_factory=dict)
    best: dict | None = None

    def point(self, x) -> dict:
        return {v.key: v.snap(float(xi)) for v, xi in zip(self.vary, x)}

    def __call__(self, x) -> float:
        p = self.point(x)
        key = tuple(p[v.key] for v in self.vary)
        if key in self.cache:
            return self.cache[key]["cost"]
        if len(self.history) >= self.max_evals:
            raise Stop("max evaluations")
        t0 = time.time()
        try:
            r = self.evaluate(dict(p))
        except Stop:
            raise
        except Exception as e:  # the model rejected the point, or the run failed: penalise, go on
            r = {"metrics": {}, "error": f"{type(e).__name__}: {e}", "wall_time_s": time.time() - t0}
        m = r.get("metrics") or {}
        if r.get("error"):
            cost, parts, met = max(PENALTY, float(r.get("cost") or PENALTY)), [], False
        else:
            cost, parts, met = total_cost(self.goals, m, self.f0_tol_pct)
        entry = {"index": len(self.history) + 1, "params": p, "metrics": m, "cost": cost, "goals": parts,
                 "met": met, "file": r.get("file"), "wall_time_s": round(r.get("wall_time_s", time.time() - t0), 3)}
        if r.get("error"):
            entry["error"] = r["error"]
        if r.get("skipped"):
            entry["skipped"] = r["skipped"]   # not simulated: the design checks refused the point
        self.history.append(entry)
        self.cache[key] = entry
        if self.best is None or cost < self.best["cost"]:
            self.best = entry
        if self.on_eval:
            self.on_eval(entry)
        if met:
            raise Stop("goals met")
        return cost

    # scaled coordinates u in [0, 1]^n
    def to_u(self, p: dict) -> np.ndarray:
        return np.array([(p[v.key] - v.lo) / (v.hi - v.lo) for v in self.vary])

    def from_u(self, u) -> list[float]:
        return [v.lo + min(1.0, max(0.0, ui)) * (v.hi - v.lo) for v, ui in zip(self.vary, u)]

    def cost_u(self, u) -> float:
        return self(self.from_u(u))


def nelder_mead(d: Driver, u0: np.ndarray, step: float = 0.15, tol: float = 2e-3, restarts: int = 2,
                max_iter: int = 400) -> str:
    """Bounded Nelder–Mead in [0, 1]^n; returns the stop reason (``Stop`` is raised through)."""
    n = len(u0)
    alpha, gamma, rho, sigma = 1.0, 2.0, 0.5, 0.5
    clip = lambda u: np.clip(u, 0.0, 1.0)  # noqa: E731
    for attempt in range(restarts + 1):
        simplex = [clip(np.array(u0, dtype=float))]
        for i in range(n):
            e = np.zeros(n)
            e[i] = step if u0[i] + step <= 1.0 else -step
            simplex.append(clip(simplex[0] + e))
        vals = [d.cost_u(u) for u in simplex]
        stall, last_best = 0, min(vals)
        for _ in range(max_iter):
            order = np.argsort(vals)
            simplex = [simplex[i] for i in order]
            vals = [vals[i] for i in order]
            size = max(np.max(np.abs(u - simplex[0])) for u in simplex[1:])
            if vals[0] < last_best - 1e-9:
                last_best, stall = vals[0], 0
            else:
                stall += 1
            if size < tol or stall > 4 * (n + 1):
                break
            c = np.mean(simplex[:-1], axis=0)
            xr = clip(c + alpha * (c - simplex[-1]))
            fr = d.cost_u(xr)
            if fr < vals[0]:
                xe = clip(c + gamma * (xr - c))
                fe = d.cost_u(xe)
                simplex[-1], vals[-1] = (xe, fe) if fe < fr else (xr, fr)
            elif fr < vals[-2]:
                simplex[-1], vals[-1] = xr, fr
            else:
                outside = fr < vals[-1]
                xc = clip(c + rho * ((xr if outside else simplex[-1]) - c))
                fc = d.cost_u(xc)
                if fc < (fr if outside else vals[-1]):
                    simplex[-1], vals[-1] = xc, fc
                else:  # shrink toward the best vertex
                    for i in range(1, n + 1):
                        simplex[i] = clip(simplex[0] + sigma * (simplex[i] - simplex[0]))
                        vals[i] = d.cost_u(simplex[i])
        if attempt < restarts:  # restart around the best point with a smaller simplex
            u0 = d.to_u(d.best["params"])
            step *= 0.5
    return "simplex converged"


def _sample(d: Driver, rng: np.random.Generator) -> np.ndarray:
    return rng.random(len(d.vary))


def bayesian(d: Driver, u0: np.ndarray, rng: np.random.Generator) -> str:
    """Small numpy-only GP expected-improvement search with an RBF kernel."""
    x, y = [u0.copy()], [d.cost_u(u0)]
    attempts = 0
    while len(d.history) < d.max_evals and attempts < 20*d.max_evals:
        attempts += 1
        candidates = rng.random((max(128, 32 * len(u0)), len(u0)))
        X = np.asarray(x); Y = np.asarray(y)
        scale = np.maximum(np.std(X, axis=0), 0.2)
        delta = (X[:, None, :] - X[None, :, :]) / scale
        K = np.exp(-0.5 * np.sum(delta * delta, axis=2)) + np.eye(len(X)) * 1e-8
        try:
            alpha = np.linalg.solve(K, Y - Y.mean())
            dc = (candidates[:, None, :] - X[None, :, :]) / scale
            cross = np.exp(-0.5 * np.sum(dc * dc, axis=2))
            mu = Y.mean() + cross @ alpha
            var = np.maximum(1e-12, 1.0 - np.sum(cross * np.linalg.solve(K, cross.T).T, axis=1))
            sigma = np.sqrt(var); z = (Y.min() - mu) / sigma
            cdf = 0.5 * (1.0 + np.vectorize(math.erf)(z / math.sqrt(2)))
            pdf = np.exp(-0.5 * z * z) / math.sqrt(2 * math.pi)
            ei = (Y.min() - mu) * cdf + sigma * pdf
        except np.linalg.LinAlgError:
            ei = rng.random(len(candidates))
        idx = int(np.argmax(ei)); u = candidates[idx]
        before = len(d.history); val = d.cost_u(u)
        if len(d.history) > before:
            x.append(u); y.append(val)
    return "evaluation budget exhausted"


def cma_es(d: Driver, u0: np.ndarray, rng: np.random.Generator) -> str:
    n = len(u0); lam = max(6, 4 + int(3 * math.log(n + 1))); mu = lam // 2
    weights = np.log(mu + 0.5) - np.log(np.arange(1, mu + 1)); weights /= weights.sum()
    mean = u0.copy(); sigma = 0.25; cov = np.eye(n)
    while len(d.history) < d.max_evals:
        previous_best = d.best["cost"] if d.best else math.inf
        z = rng.multivariate_normal(np.zeros(n), cov, size=min(lam, d.max_evals-len(d.history)))
        pop = np.clip(mean + sigma*z, 0, 1); scored=[]
        for u in pop:
            old=len(d.history); f=d.cost_u(u)
            if len(d.history)>old: scored.append((f,u))
        if not scored: break
        scored.sort(key=lambda a:a[0]); elite=np.asarray([a[1] for a in scored[:mu]])
        elite_weights = weights[:len(elite)] / weights[:len(elite)].sum()
        old=mean.copy(); mean=np.sum(elite*elite_weights[:,None],axis=0)
        centered=elite-old; cov=0.7*cov+0.3*(centered.T@centered/max(1,len(elite)))+np.eye(n)*1e-6
        sigma=min(0.5,max(0.015,sigma*(1.05 if scored[0][0] < previous_best else 0.9)))
    return "evaluation budget exhausted"


def particle_swarm(d: Driver, u0: np.ndarray, rng: np.random.Generator) -> str:
    n=len(u0); count=min(max(8, 4*n), d.max_evals); X=rng.random((count,n)); X[0]=u0
    V=np.zeros_like(X); P=X.copy(); F=np.full(count,np.inf); G=u0.copy(); gf=math.inf
    attempts=0
    while len(d.history)<d.max_evals and attempts<20*d.max_evals:
        attempts+=1
        for i in range(count):
            old=len(d.history); f=d.cost_u(X[i])
            if len(d.history)>old and f<F[i]: F[i]=f; P[i]=X[i].copy()
            if f<gf: gf=f; G=X[i].copy()
            if len(d.history)>=d.max_evals: break
        V=.65*V+1.4*rng.random(V.shape)*(P-X)+1.4*rng.random(V.shape)*(G-X)
        X=np.clip(X+V,0,1)
    return "evaluation budget exhausted"


def genetic(d: Driver, u0: np.ndarray, rng: np.random.Generator) -> str:
    n=len(u0); count=min(max(8,4*n),d.max_evals); pop=rng.random((count,n)); pop[0]=u0
    attempts=0
    while len(d.history)<d.max_evals and attempts<20*d.max_evals:
        attempts+=1
        ranked=[]
        for u in pop:
            old=len(d.history); f=d.cost_u(u)
            if len(d.history)>old: ranked.append((f,u.copy()))
            if len(d.history)>=d.max_evals: break
        if not ranked: break
        ranked.sort(key=lambda p:p[0]); elite=[p[1] for p in ranked[:max(1,len(ranked)//2)]]
        pop=np.asarray([np.clip((elite[rng.integers(len(elite))]+elite[rng.integers(len(elite))])/2 + rng.normal(0,.12,n),0,1) for _ in range(count)])
    return "evaluation budget exhausted"


def trust_region(d: Driver, u0: np.ndarray) -> str:
    x=u0.copy(); f=d.cost_u(x); radius=.2; n=len(x)
    while len(d.history)<d.max_evals:
        eps=max(1e-5,min(1e-2,radius*.1)); g=np.zeros(n)
        for i in range(n):
            q=x.copy(); q[i]=min(1,q[i]+eps); old=len(d.history); fp=d.cost_u(q)
            q2=x.copy(); q2[i]=max(0,q2[i]-eps); fm=d.cost_u(q2)
            g[i]=(fp-fm)/max(1e-12,min(1,x[i]+eps)-max(0,x[i]-eps))
            if len(d.history)>=d.max_evals: break
        if len(d.history)>=d.max_evals: break
        norm=np.linalg.norm(g)
        if not np.isfinite(norm) or norm<1e-10: break
        step=-radius*g/norm; q=np.clip(x+step,0,1); old=len(d.history); fq=d.cost_u(q)
        if fq<f: x,f=q,fq; radius=min(.5,radius*1.5)
        else: radius*=.5
        if radius<1e-4: break
    return "trust region converged"


def tune_f0(d: Driver, goal: Goal, x0: float, max_steps: int = 40) -> str:
    """Bracketed secant on f0(x) - target for one parameter; returns the stop reason."""
    v = d.vary[0]

    def err(x):
        d([x])
        e = d.cache[(v.snap(x),)]
        f0 = e["metrics"].get("f0_ghz")
        return None if f0 is None else f0 - goal.target, f0

    xa = v.snap(x0)
    fa, f0a = err(xa)
    if fa is None:  # no resonance at the start: probe the middle of the range
        xa = v.snap((v.lo + v.hi) / 2)
        fa, f0a = err(xa)
        if fa is None:
            raise Stop("no resonance in the frequency range")
    guess = xa * f0a / goal.target if xa != 0 else None  # f0 ∝ 1/x
    if guess is None or not v.lo <= guess <= v.hi or v.snap(guess) == xa:
        guess = xa + (0.1 if fa > 0 else -0.1) * (v.hi - v.lo)
    xb = v.snap(guess)
    fb, _ = err(xb)
    at_bound, stale, best_abs = 0, 0, min(abs(fa), abs(fb) if fb is not None else math.inf)
    side = 0  # Illinois bookkeeping
    for _ in range(max_steps):
        if fb is None:  # lost the resonance: go back halfway
            xb = v.snap((xa + xb) / 2)
            fb, _ = err(xb)
            continue
        if fa * fb < 0:  # bracketed: Illinois false position
            x = xb - fb * (xb - xa) / (fb - fa)
        else:
            x = xb - fb * (xb - xa) / (fb - fa) if fb != fa else xb + 0.1 * (v.hi - v.lo)
        xc = v.snap(x)
        if xc in (v.lo, v.hi) and xc == xb:
            at_bound += 1
            if at_bound >= 2:
                return "target outside the parameter bounds"
        if xc in (xa, xb):  # resolution reached
            return "parameter resolution reached"
        fc, _ = err(xc)
        if fc is None:
            xb = v.snap((xb + xc) / 2)
            fb, _ = err(xb)
            continue
        if fa * fb < 0:
            if fc * fb < 0:
                xa, fa = xb, fb
                side = 0
            else:
                side += 1
                if side >= 2:
                    fa /= 2  # Illinois: halve the stale end
            xb, fb = xc, fc
        else:
            xa, fa, xb, fb = xb, fb, xc, fc
        if abs(fb) < best_abs - 1e-12:
            best_abs, stale = abs(fb), 0
        else:
            stale += 1
            if stale >= 3:
                return nelder_mead(d, d.to_u(d.best["params"]), step=0.05)
    return "secant steps exhausted"


def optimize(vary: list[Vary], goals: list[Goal], evaluate: Evaluator, *, method: str = "auto", seed: int = 0,
             max_evals: int = 12, start: dict | None = None, f0_tol_pct: float = 0.25,
             on_eval: Callable[[dict], None] | None = None) -> dict:
    """Run the search; returns ``{method, history, best, start, reason}``."""
    if not vary:
        raise ValueError("vary at least one parameter")
    if not goals:
        raise ValueError("give at least one goal")
    if method not in METHOD_CHOICES:
        raise ValueError(f"unknown method {method!r}")
    if method == "auto":
        method = "secant" if len(vary) == 1 and [g.kind for g in goals] == ["f0"] else "nelder-mead"
    if method == "secant" and (len(vary) != 1 or not any(g.kind == "f0" for g in goals)):
        raise ValueError("secant needs one parameter and an f0 goal")
    d = Driver(vary, goals, evaluate, max_evals=max_evals, f0_tol_pct=f0_tol_pct, on_eval=on_eval)
    x0 = [v.snap(v.start if v.start is not None else (start or {}).get(v.key, (v.lo + v.hi) / 2)) for v in vary]
    rng=np.random.default_rng(seed)
    try:
        d.cost_u(d.to_u(dict(zip([v.key for v in vary], x0))))
        if method == "secant":
            reason = tune_f0(d, next(g for g in goals if g.kind == "f0"), x0[0])
        elif method == "nelder-mead":
            reason = nelder_mead(d, d.to_u(dict(zip([v.key for v in vary], x0))))
        elif method == "bayesian": reason=bayesian(d,d.to_u(dict(zip([v.key for v in vary],x0))),rng)
        elif method == "cma-es": reason=cma_es(d,d.to_u(dict(zip([v.key for v in vary],x0))),rng)
        elif method == "particle-swarm": reason=particle_swarm(d,d.to_u(dict(zip([v.key for v in vary],x0))),rng)
        elif method == "genetic": reason=genetic(d,d.to_u(dict(zip([v.key for v in vary],x0))),rng)
        elif method == "trust-region": reason=trust_region(d,d.to_u(dict(zip([v.key for v in vary],x0))))
        else:
            raise ValueError(f"unknown method {method!r}")
    except Stop as s:
        reason = s.reason
    return {"method": method, "history": d.history, "best": d.best,
            "start": d.history[0] if d.history else None, "reason": reason}


# ---------------------------------------------------------------------------- running real models

def precheck(design: dict, base: dict) -> Callable[[dict], tuple[str, float] | None]:
    """For a design: a function of a candidate's parameter values that returns why the candidate
    should not be simulated (its check errors, or a metal placement warning that the design at
    ``base`` does not have) and its cost, or None. The cost is ``PENALTY`` for check errors and
    grows from it with the overhang or gap of misplaced metal (10 % per mm, at most 10 ×), so a
    search that starts among such points is led back towards the feasible ones. The checks never
    stop the optimizer: if they fail, the candidate is simulated."""
    from .design_checks import PLACEMENT, lint, run_blockers

    try:
        allowed = frozenset((c["code"], c["path"]) for c in lint(design, base) if c["code"] in PLACEMENT)
    except Exception:  # noqa: BLE001 - a bug in a check must not stop the run
        allowed = None

    def check(values: dict) -> tuple[str, float] | None:
        if allowed is None:
            return None
        try:
            found = run_blockers(lint(design, values), allowed)
        except Exception:  # noqa: BLE001
            return None
        if not found:
            return None
        more = f" (and {len(found) - 1} more)" if len(found) > 1 else ""
        if any(c["severity"] == "error" for c in found):
            first, cost = next(c for c in found if c["severity"] == "error"), PENALTY
        else:
            first = found[0]
            excess = max(c.get("excess_mm", 0.0) for c in found)
            cost = PENALTY * (1 + min(excess, 90.0) / 10)
        return f"{first['message']}{more}", cost

    return check


def _atomic_json(path: Path, obj, indent=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(finite_json(obj), indent=indent, separators=None if indent else (",", ":"), allow_nan=False),
                   encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def _emit(kind: str, payload: dict):
    print(f"fairbeam: optimize {kind} {json.dumps(payload, separators=(',', ':'), allow_nan=False, default=str)}",
          flush=True)


def run_optimization(model_path: str, vary: list[Vary], goals: list[Goal], *, fixed: dict | None = None,
                     name: str | None = None, out: Path, sim_root: Path, method: str = "auto", seed: int = 0, max_evals: int = 12,
                     threads: int = 4, engine: str = "cpu", end_db: float | None = None, points: int = 801,
                     f0_tol_pct: float = 0.25, farfield: bool | None = None, excite: str = "auto",
                     keep_sim: bool | None = None, check_candidates: bool = True, log=print) -> dict:
    """``keep_sim``: keep every evaluation's raw openEMS folder (default: ``FAIRBEAM_KEEP_SIM``);
    otherwise it is removed as soon as the evaluation's bundle is written. ``check_candidates``:
    for a design, skip the candidates the design checks refuse (:func:`precheck`) instead of
    simulating them."""
    from .cli import _slug
    from .model import load_model, resolve_params
    from .simdata import keep_sim_requested, prune_empty_parents, remove_inside

    module = load_model(model_path)
    fixed = {k: str(v) for k, v in (fixed or {}).items()}
    specs = {p.key: p for p in module.PARAMS}
    for v in vary:
        p = specs.get(v.key)
        if p is None or isinstance(p.default, (bool, str)):
            raise ValueError(f"{v.key}: not a numeric parameter of {Path(model_path).name}")
        if p.minimum is not None and v.lo < p.minimum or p.maximum is not None and v.hi > p.maximum:
            raise ValueError(f"{v.key}: bounds [{v.lo}, {v.hi}] exceed the parameter's [{p.minimum}, {p.maximum}]")
        if isinstance(p.default, int):
            v.resolution = max(1.0, round(v.resolution or 1.0))
    base = resolve_params(module.PARAMS, fixed)
    from .multiport import parse_excite, run_model

    probe = module.build(base)
    port_numbers = [p["number"] for p in probe.ports]
    f_lo, f_hi = probe.f_min / 1e9, probe.f_max / 1e9
    del probe
    for g in goals:
        if g.at is not None and not f_lo - 1e-9 <= g.at <= f_hi + 1e-9:
            raise ValueError(f"goal {g.label()}: {g.at:g} GHz is outside the simulated band {f_lo:g}-{f_hi:g} GHz")
    for g in goals:
        for n in (g.ports or ()):
            if n not in port_numbers:
                raise ValueError(f"goal {g.label()}: the model has ports {port_numbers}")
    if excite in (None, "", "auto"):
        drive = needed_excite(goals, port_numbers)
    else:
        drive = parse_excite(excite, port_numbers)
    excite_spec = ",".join(str(n) for n in drive) if len(port_numbers) > 1 else None
    name = name or _slug(module.MODEL["id"] + "--opt", {v.key: f"{v.lo:g}-{v.hi:g}" for v in vary})
    opt_dir = Path(out) / "optimizations"
    member_dir = opt_dir / name
    pattern = sorted({g.at * 1e9 for g in goals if g.kind == "dmax_min"})
    want_ff = bool(pattern) or bool(farfield)
    keep = keep_sim_requested() if keep_sim is None else keep_sim
    raw_dir = Path(sim_root).absolute() / "optimizations" / name
    design = getattr(module, "DESIGN", None)
    refuse = precheck(design, base) if check_candidates and isinstance(design, dict) else None
    warned_legacy_nf2ff = False

    def evaluate(point: dict) -> dict:
        overrides = {**fixed, **{k: repr(float(val)) if not isinstance(specs[k].default, int) else str(int(round(val)))
                                 for k, val in point.items()}}
        values = resolve_params(module.PARAMS, overrides)
        slug = _slug(module.MODEL["id"], {k: f"{v:g}" for k, v in point.items()})
        t0 = time.time()
        if refuse is not None and (refused := refuse(values)):
            # no openEMS run for a point the checks refuse: a failed evaluation, and the search goes on
            why, cost = refused
            return {"metrics": {}, "error": f"skipped: {why}", "skipped": why, "cost": cost,
                    "wall_time_s": time.time() - t0}

        def before_run(sim):
            nonlocal warned_legacy_nf2ff
            if not want_ff and not sim.efficiency_points:
                if not sim.remove_nf2ff_box():
                    # Older CSXCAD bindings can still skip the transform, but retain the dumps.
                    sim.nf2ff = None
                    if not warned_legacy_nf2ff:
                        log("fairbeam: note: this CSXCAD binding cannot remove unused NF2FF recordings; "
                            "skipping only the transform (update the runtime to avoid field-file writes)")
                        warned_legacy_nf2ff = True

        sim = run_model(module, values, excite=excite_spec, sim_path=str(raw_dir / slug),
                        threads=threads, echo=False, engine=engine, end_db=end_db, n_freq=points,
                        pattern_freqs=pattern or None, element_patterns=False, before_run=before_run, log=lambda *a: None)
        params = [p.describe(values[p.key]) for p in module.PARAMS]
        label = module.MODEL["name"] + " · " + ", ".join(f"{k}={v:g}" for k, v in point.items())
        bundle = sim.to_bundle(module.MODEL, params, name=label)
        bundle["optimization"] = {"name": name, "point": point}
        _atomic_json(member_dir / f"{slug}.json", bundle)
        if not keep:  # the bundle is the product; the far field is already computed from the raw data
            remove_inside(Path(sim_root).absolute(), raw_dir / slug)
            prune_empty_parents(Path(sim_root).absolute(), raw_dir)
        return {"metrics": bundle_metrics(bundle, goals), "file": f"optimizations/{name}/{slug}.json",
                "wall_time_s": time.time() - t0}

    doc = {
        "schema": OPT_SCHEMA, "name": name, "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "model": {"id": module.MODEL["id"], "name": module.MODEL["name"], "file": Path(model_path).name},
        "method": method, "vary": [asdict(v) | {"unit": specs[v.key].unit} for v in vary],
        "goals": [asdict(g) | {"label": g.label()} for g in goals], "fixed": fixed,
        "engine": engine, "threads": threads, "max_evals": max_evals, "f0_tol_pct": f0_tol_pct,
        "ports": port_numbers, "excite": drive,
        "evaluations": [], "best": None, "start": None, "reason": "running", "finished": None,
    }
    doc_path = opt_dir / f"{name}.json"
    t_start = time.time()
    _emit("start", {"name": name, "file": f"optimizations/{name}.json", "vary": doc["vary"], "goals": doc["goals"],
                    "max_evals": max_evals, "engine": engine, "ports": port_numbers, "excite": drive})

    def on_eval(e: dict):
        doc["evaluations"].append(e)
        best = min(doc["evaluations"], key=lambda x: x["cost"])
        doc["best"], doc["start"] = best, doc["evaluations"][0]
        doc["wall_time_s"] = round(time.time() - t_start, 2)
        _atomic_json(doc_path, doc, indent=1)
        m = e["metrics"]
        point = ", ".join(f"{k}={v:g}" for k, v in e["params"].items())
        if e.get("skipped"):
            log(f"fairbeam optimize [{e['index']}/{max_evals}] {point}  skipped: {e['skipped']}  cost {e['cost']:.4g}")
        else:
            log(f"fairbeam optimize [{e['index']}/{max_evals}] {point}"
                f"  f0 {m.get('f0_ghz')} GHz  S11(f0) {m.get('s11_f0_db')} dB  cost {e['cost']:.4g}"
                + ("  (goals met)" if e["met"] else ""))
        _emit("eval", {**e, "best_index": best["index"], "best_cost": best["cost"], "max_evals": max_evals})

    base_start = {v.key: float(base[v.key]) for v in vary}
    try:
        result = optimize(vary, goals, evaluate, method=method, seed=seed, max_evals=max_evals,
                          start={k: min(v.hi, max(v.lo, base_start[k])) for k, v in zip(base_start, vary)},
                          f0_tol_pct=f0_tol_pct, on_eval=on_eval)
    except BaseException as e:
        # never leave the document saying "running": record how it ended, then re-raise
        doc.update(reason=f"error: {type(e).__name__}: {e}" if isinstance(e, Exception) else "interrupted",
                   finished=time.strftime("%Y-%m-%dT%H:%M:%S%z"), wall_time_s=round(time.time() - t_start, 2))
        _atomic_json(doc_path, doc, indent=1)
        raise
    doc.update(method=result["method"], reason=result["reason"], best=result["best"], start=result["start"],
               finished=time.strftime("%Y-%m-%dT%H:%M:%S%z"), wall_time_s=round(time.time() - t_start, 2))
    _atomic_json(doc_path, doc, indent=1)
    _emit("done", {"name": name, "file": f"optimizations/{name}.json", "reason": result["reason"],
                   "method": result["method"], "evaluations": len(result["history"]),
                   "best": result["best"], "start": result["start"], "wall_time_s": doc["wall_time_s"]})
    doc["_path"] = str(doc_path)
    return doc


# ---------------------------------------------------------------------------- CLI

def add_command(sub, defaults: dict):
    p = sub.add_parser("optimize", help="tune bounded parameters towards goals (f0, S11, bandwidth, Dmax)")
    p.add_argument("model", help="path to a model .py file")
    p.add_argument("--vary", action="append", required=True, metavar="KEY=MIN:MAX[:START[:RES]]",
                   help="parameter to vary within bounds (repeat)")
    p.add_argument("--goal", action="append", required=True, metavar="GOAL",
                   help="f0=<GHz> | s11_max=<dB>@<GHz> | bw_min=<MHz> | dmax_min=<dBi>@<GHz> | sij_max=<dB>@<GHz>:<i>,<j>"
                        " | sij_min=<dB>@<GHz>:<i>,<j> | match_all=<dB>@<GHz>, optional *weight")
    p.add_argument("--set", action="append", metavar="KEY=VALUE", help="fixed parameter override")
    p.add_argument("--method", choices=METHOD_CHOICES, default="auto")
    p.add_argument("--seed", type=int, default=0, help="random seed for stochastic methods (default 0)")
    p.add_argument("--max-evals", type=int, default=12, help="evaluation budget (default 12)")
    p.add_argument("--f0-tol", type=float, default=0.25, help="f0 goal tolerance in %% (default 0.25)")
    p.add_argument("--name", help="optimization name (default derived from model and parameters)")
    p.add_argument("--out", default=str(defaults["out"]), help="projects folder; results go to <out>/optimizations")
    p.add_argument("--sim-root", default=str(defaults["sim"]), help="folder for raw openEMS output")
    p.add_argument("--threads", type=int, default=4)
    p.add_argument("--engine", choices=["cpu", "gpu"], default=os.environ.get("FAIRBEAM_ENGINE", "cpu"))
    p.add_argument("--end-db", type=float, help="energy end criterion in dB (default: the model's)")
    p.add_argument("--points", type=int, default=801, help="frequency points")
    p.add_argument("--farfield", action="store_true", help="compute the far field for every evaluation")
    p.add_argument("--excite", default="auto", metavar="auto|all|1,3",
                   help="ports to drive in each evaluation of a multi-port model (default: those the goals need)")
    p.add_argument("--no-precheck", action="store_true",
                   help="for a design, simulate every candidate, also one with check errors or with metal that overhangs "
                        "its substrate or floats in the air (by default such candidates are skipped)")
    p.add_argument("--keep-sim", action="store_true",
                   help="keep each evaluation's raw openEMS folder (also FAIRBEAM_KEEP_SIM=1); "
                        "by default it is removed once the evaluation's bundle is written")
    p.set_defaults(func=_cmd)


def _cmd(args):
    from .cli import _overrides

    vary = [parse_vary(t) for t in args.vary]
    if len({v.key for v in vary}) != len(vary):
        raise ValueError("--vary: a parameter is given twice")
    goals = [parse_goal(t) for t in args.goal]
    if not 1 <= args.max_evals <= 200:
        raise ValueError("--max-evals: 1 to 200")
    doc = run_optimization(args.model, vary, goals, fixed=_overrides(args.set), name=args.name, out=Path(args.out),
                           sim_root=Path(args.sim_root), method=args.method, seed=args.seed, max_evals=args.max_evals,
                           threads=args.threads, engine=args.engine, end_db=args.end_db, points=args.points,
                           f0_tol_pct=args.f0_tol, farfield=True if args.farfield else None, excite=args.excite,
                           keep_sim=True if args.keep_sim else None, check_candidates=not args.no_precheck)
    b = doc["best"]
    if b:
        print(f"fairbeam: best of {len(doc['evaluations'])} evaluations ({doc['reason']}, {doc['wall_time_s']} s): "
              + ", ".join(f"{k}={v:g}" for k, v in b["params"].items())
              + f"  cost {b['cost']:.4g}  f0 {b['metrics'].get('f0_ghz')} GHz")
    print(f"fairbeam: optimization written to {doc['_path']}")
    return 0 if b else 1
