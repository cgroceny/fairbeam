"""Mesh convergence study of a design (an adaptive mesh check).

    fairbeam converge python/models/patch.design.json --densities 15,20,30,40 --max-runs 4

The same design runs at increasing automatic-mesh densities (``cells_per_wavelength`` at f max).
After each run the resonance (S11 minimum), |S11| there, Dmax (with a far field) and the input
impedance there are compared with the previous run. The study stops at the first step whose
changes are all below the tolerances ("converged at <the coarser density of that step>"), or when
the densities or the run budget are used up ("not converged").

It is a sweep over ``mesh.cells_per_wavelength`` with a stopping rule. The CLI runs it in one
process (``run_convergence``); the run server queues one normal run job per density and submits
the next one only when the stopping rule says so (``ServerStudies``). Both write the same study file
(``fairbeam.study/1``, kind ``mesh-convergence``). See docs/STUDIES.md and docs/MESHING.md.
"""

from __future__ import annotations

import copy
import json
import os
import re
import threading
import time
from pathlib import Path

import numpy as np

from .jsonutil import finite_json
from .legacy import current_schema, is_legacy_schema

DENSITY_KEY = "mesh.cells_per_wavelength"
KIND = "mesh-convergence"
DEFAULT_DENSITIES = (15, 20, 30, 40)
DEFAULT_TOL = {"f_pct": 0.5, "s11_db": 1.0, "dmax_db": 0.2}
DEFAULT_MAX_RUNS = 4
MAX_DENSITIES = 12
MIN_DENSITY, MAX_DENSITY = 4.0, 200.0

NOT_CONVERGED = "not converged: refine further or check the model"
# every step of a study whose runs have no resonance in the band (the |S11| minimum is at a band edge,
# which moves with nothing): the steps cannot be compared, so the study cannot converge
NOT_COMPARABLE = "not comparable: no resonance in the band (the minimum is at the band edge)"
NOT_VERIFIED = "not converged: energy decay or local mesh resolution is unverified"


# ---------------------------------------------------------------------------- the design's mesh

def mesh_mode(design: dict) -> str:
    return (design.get("mesh") or {}).get("mode") or "auto"


def unsupported(design: dict) -> str | None:
    """Why a design cannot run a mesh convergence study, or None."""
    if mesh_mode(design) == "manual":
        return ("A mesh convergence study needs the automatic mesh: this design uses manual mesh lines. "
                "Switch to the automatic mesh in Simulation settings › Mesh first.")
    return None


def _number(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def with_density(design: dict, cpw: float) -> dict:
    """A copy of the design meshed at ``cpw`` cells per wavelength (at f max).

    ``auto`` mode sets ``mesh.cells_per_wavelength``; ``design`` mode sets the
    ``mesh.overrides.cells_per_wavelength`` override. An explicit air density is scaled by the same
    factor when both are plain numbers (and kept at most ``cpw``), else dropped so it follows the
    feature density. Manual mesh lines raise ValueError.
    """
    why = unsupported(design)
    if why:
        raise ValueError(why)
    cpw = float(cpw)
    if not cpw > 0:
        raise ValueError("cells per wavelength must be > 0")
    d = copy.deepcopy(design)
    m = d.setdefault("mesh", {})
    holder = m.setdefault("overrides", {}) if mesh_mode(d) == "design" else m
    if not isinstance(holder, dict):
        raise ValueError("mesh.overrides must be an object")
    old = _number(holder.get("cells_per_wavelength", 20 if holder is m else None))
    value = int(cpw) if cpw.is_integer() else cpw
    holder["cells_per_wavelength"] = value
    air = holder.get("air_cells_per_wavelength")
    if air is not None and air != "":
        a = _number(air)
        if a is not None and old:
            scaled = min(cpw, a * cpw / old)
            holder["air_cells_per_wavelength"] = round(scaled, 3)
        else:
            holder.pop("air_cells_per_wavelength", None)
    return d


def module_at_density(module, cpw: float):
    """The design module (``fairbeam.design.module_for``) rebuilt at another mesh density."""
    from .design import module_for

    design = getattr(module, "DESIGN", None)
    if design is None:
        raise ValueError("--mesh-density needs a design file (.design.json); a Python model sets its own mesh")
    return module_for(with_density(design, cpw), name=getattr(module, "__name__", None))


# ---------------------------------------------------------------------------- densities and tolerances

def check_densities(values) -> list[float]:
    """Densities as floats, coarse to fine. Raises ValueError with a readable message."""
    if isinstance(values, str):
        values = [s for s in values.replace(";", ",").split(",") if s.strip()]
    if not isinstance(values, (list, tuple)):
        raise ValueError("densities must be a list of numbers")
    out = []
    for v in values:
        x = _number(v)
        if x is None or not np.isfinite(x):
            raise ValueError(f"density {v!r} is not a number")
        if not MIN_DENSITY <= x <= MAX_DENSITY:
            raise ValueError(f"densities must be {MIN_DENSITY:g} to {MAX_DENSITY:g} cells per wavelength")
        out.append(x)
    if len(out) < 2:
        raise ValueError("give at least two densities")
    if len(out) > MAX_DENSITIES:
        raise ValueError(f"at most {MAX_DENSITIES} densities")
    if any(b <= a for a, b in zip(out, out[1:])):
        raise ValueError("densities must increase (coarse to fine)")
    return out


def check_tolerances(tol: dict | None) -> dict:
    out = dict(DEFAULT_TOL)
    for k, v in (tol or {}).items():
        if k not in DEFAULT_TOL:
            raise ValueError(f"unknown tolerance {k!r}")
        if v is None:
            continue
        x = _number(v)
        if x is None or not np.isfinite(x) or x <= 0:
            raise ValueError(f"tolerance {k} must be a positive number")
        out[k] = x
    return out


def plan(densities, max_runs: int | None = None, max_density: float | None = None) -> list[float]:
    """The densities that may run: up to ``max_density`` and at most ``max_runs`` of them."""
    ds = check_densities(densities)
    if max_density is not None:
        ds = [d for d in ds if d <= max_density + 1e-9]
    n = DEFAULT_MAX_RUNS if max_runs is None else int(max_runs)
    if n < 2:
        raise ValueError("max runs must be at least 2")
    ds = ds[:n]
    if len(ds) < 2:
        raise ValueError("fewer than two densities are left below the maximum density")
    return ds


def density_text(d: float) -> str:
    return f"{d:g} cells/λ"


# ---------------------------------------------------------------------------- metrics of one run

def _excited(bundle: dict):
    from .study import _excited_key

    key = _excited_key(bundle)
    if key is None:
        return None
    res = bundle["results"]
    pr = res["ports"][key]
    f = np.asarray(res["frequency"], dtype=float)
    s = np.asarray(pr["s11_re"], dtype=float) + 1j * np.asarray(pr["s11_im"], dtype=float)
    z = np.asarray(pr["zin_re"], dtype=float) + 1j * np.asarray(pr["zin_im"], dtype=float)
    return f, s, z


def _refine_min(f, db, k):
    """Parabolic refinement of a sampled minimum (sub-grid resonance frequency)."""
    if 0 < k < len(f) - 1:
        y0, y1, y2 = db[k - 1], db[k], db[k + 1]
        den = y0 - 2 * y1 + y2
        if den > 0 and np.all(np.isfinite([y0, y1, y2])):
            t = 0.5 * (y0 - y2) / den  # -0.5 .. 0.5 for a true minimum
            if -1 < t < 1:
                h = f[k + 1] - f[k] if t > 0 else f[k] - f[k - 1]
                return float(f[k] + t * h), float(y1 - 0.25 * (y0 - y2) * t)
    return float(f[k]), float(db[k])


def metrics(bundle: dict, *, network_criteria: dict | None = None) -> dict:
    """Resonance (S11 minimum of the first matched band, else the global one), |S11| and Zin
    there, Dmax at the far-field frequency closest to it, the cell count and the wall time.
    ``no_resonance`` is true when nothing is matched and the minimum lies at a band edge: it is
    not a resonance, only where the |S11| curve ends."""
    from .study import first_resonance, summarize

    s = summarize(bundle)
    out = {"f_res": None, "s11_db": None, "zin_re": None, "zin_im": None, "matched": None, "no_resonance": False,
           "dmax_dbi": s.get("dmax_dbi"), "cells": s.get("cells"), "timesteps": s.get("timesteps"),
           "wall_time_s": s.get("wall_time_s"), "solver_converged": s.get("converged")}
    out["fine_features_resolved"] = s.get("fine_features_resolved")
    if network_criteria:
        from .study import network_metrics
        out["network"] = network_metrics(bundle, network_criteria)
    ex = _excited(bundle)
    fr = first_resonance(bundle)
    if ex is None or fr is None:
        return out
    f, s11, z = ex
    db = 20 * np.log10(np.maximum(np.abs(s11), 1e-9))
    # the minimum of the band (or the global one) on the grid, refined between its neighbours
    k = int(np.argmin(np.abs(f - fr["f"])))
    while True:  # downhill to the sampled minimum next to it
        j = min((i for i in (k - 1, k + 1) if 0 <= i < len(f)), key=lambda i: db[i])
        if db[j] >= db[k]:
            break
        k = j
    f0, s0 = _refine_min(f, db, k)
    out.update(f_res=f0, s11_db=round(s0, 4), matched=bool(fr.get("matched")),
               no_resonance=not fr.get("matched") and k in (0, len(f) - 1),
               zin_re=round(float(np.interp(f0, f, z.real)), 4), zin_im=round(float(np.interp(f0, f, z.imag)), 4))
    return out


# ---------------------------------------------------------------------------- the stopping rule

def compare(a: dict, b: dict, tol: dict) -> dict:
    """One refinement step from metrics ``a`` (coarser) to ``b`` (finer). A step converges when
    every change is strictly below its tolerance; Dmax counts only when both runs have it. A step
    with a run that has no resonance in the band (``no_resonance``) is not comparable: its
    "resonance" is the band edge, so no tolerance can say anything and it never converges."""
    fa, fb = a.get("f_res"), b.get("f_res")
    df = 100.0 * (fb - fa) / fa if fa and fb else None
    ds = (b["s11_db"] - a["s11_db"]) if a.get("s11_db") is not None and b.get("s11_db") is not None else None
    dd = (b["dmax_dbi"] - a["dmax_dbi"]) if a.get("dmax_dbi") is not None and b.get("dmax_dbi") is not None else None
    dz = None
    if None not in (a.get("zin_re"), a.get("zin_im"), b.get("zin_re"), b.get("zin_im")):
        dz = float(abs(complex(b["zin_re"], b["zin_im"]) - complex(a["zin_re"], a["zin_im"])))
    ok = {"f": df is not None and abs(df) < tol["f_pct"],
          "s11": ds is not None and abs(ds) < tol["s11_db"],
          "dmax": None if dd is None else abs(dd) < tol["dmax_db"]}
    r = lambda x, n: None if x is None else round(float(x), n)  # noqa: E731
    comparable = not (a.get("no_resonance") or b.get("no_resonance"))
    quality = {"energy": all(m.get("solver_converged") is True for m in (a, b)),
               "local_mesh": all(m.get("fine_features_resolved") is not False for m in (a, b))}
    step = {"df_pct": r(df, 4), "ds11_db": r(ds, 4), "ddmax_db": r(dd, 4), "dzin_ohm": r(dz, 3),
            "ok": ok, "comparable": comparable, "quality": quality,
            "converged": comparable and all(quality.values()) and bool(ok["f"] and ok["s11"] and ok["dmax"] is not False)}
    if "network" in a or "network" in b:
        from .study import compare_network
        step["network"] = compare_network(a.get("network"), b.get("network"))
        step["converged"] &= step["network"]["converged"]
    return step


def evaluate(members: list[dict], planned: list[float], tol: dict | None = None) -> dict:
    """The study's state after these members (``{density, status, metrics}``, in run order).

    ``done`` says whether to stop; ``next`` is the density to run next otherwise. ``reason`` is
    ``converged``, ``exhausted`` (no density left: the maximum density or the run budget),
    ``failed``, ``cancelled`` or ``running``.
    """
    tol = check_tolerances(tol)
    steps = []
    converged_at = None
    for i in range(1, len(members)):
        a, b = members[i - 1], members[i]
        if a.get("status", "done") != "done" or b.get("status", "done") != "done":
            break
        st = {"from": a["density"], "to": b["density"], **compare(a["metrics"], b["metrics"], tol)}
        steps.append(st)
        if st["converged"]:
            converged_at = a["density"]
            break
    last = members[-1] if members else None
    if last is not None and last.get("status", "done") in ("failed", "cancelled", "interrupted"):
        reason = "cancelled" if last["status"] in ("cancelled", "interrupted") else "failed"
    elif converged_at is not None:
        reason = "converged"
    elif len(members) >= len(planned):
        reason = "exhausted"
    else:
        reason = "running"
    done = reason != "running"
    if reason == "converged":
        verdict = f"converged at {density_text(converged_at)}"
    elif reason == "exhausted":
        if steps and not all(steps[-1]["quality"].values()):
            verdict = NOT_VERIFIED
        else:
            verdict = NOT_COMPARABLE if steps and not any(st["comparable"] for st in steps) else NOT_CONVERGED
    elif reason == "failed":
        verdict = f"stopped: the run at {density_text(last['density'])} failed"
    elif reason == "cancelled":
        verdict = "stopped before it converged"
    else:
        verdict = f"running: {len(members)} of up to {len(planned)} runs"
    return {"tolerances": tol, "densities": list(planned), "max_runs": len(planned), "steps": steps,
            "converged": converged_at is not None, "converged_at": converged_at, "done": done,
            "reason": reason, "verdict": verdict,
            "next": None if done else planned[len(members)]}


def format_table(study: dict) -> str:
    """The study as a text table (CLI output, docs)."""
    conv = study["convergence"]
    rows = [f"{'cells/λ':>8}  {'cells':>9}  {'f_res GHz':>10}  {'df %':>7}  {'S11 dB':>7}  {'dS11':>6}  "
            f"{'Dmax dBi':>8}  {'dD dB':>6}  {'Zin ohm':>16}  {'time s':>7}  ok"]
    for i, m in enumerate(study["members"]):
        x = m.get("metrics") or {}
        st = conv["steps"][i - 1] if 0 < i <= len(conv["steps"]) else {}
        zin = (f"{x['zin_re']:.1f}{x['zin_im']:+.1f}j" if x.get("zin_re") is not None else "-")
        ok = "" if not st else ("yes" if st["converged"] else "n/a" if st.get("comparable") is False else "no")
        if m.get("status", "done") != "done":
            ok = m["status"]
        rows.append(f"{m['density']:>8g}  {x.get('cells') or 0:>9}  {_f(x.get('f_res'), 10, 4, 1e-9)}  "
                    f"{_f(st.get('df_pct'), 7, 3)}  {_f(x.get('s11_db'), 7, 2)}  {_f(st.get('ds11_db'), 6, 2)}  "
                    f"{_f(x.get('dmax_dbi'), 8, 2)}  {_f(st.get('ddmax_db'), 6, 3)}  {zin:>16}  "
                    f"{_f(x.get('wall_time_s'), 7, 1)}  {ok}")
    t = conv["tolerances"]
    rows.append(f"tolerances: |df| < {t['f_pct']:g} %, |dS11| < {t['s11_db']:g} dB, |dDmax| < {t['dmax_db']:g} dB")
    rows.append(conv["verdict"])
    from .study import format_network_steps
    rows.extend(format_network_steps(conv["steps"]))
    return "\n".join(rows)


def _f(v, width, nd, scale=1.0):
    return f"{'-':>{width}}" if v is None else f"{v * scale:>{width}.{nd}f}"


# ---------------------------------------------------------------------------- the study file

def new_study(*, name: str, model: dict, planned: list[float], tol: dict, design_path: str | None = None,
              settings: dict | None = None, study_id: str | None = None) -> dict:
    return {"schema": "fairbeam.study/1", "kind": KIND, "id": study_id or name, "name": name,
            "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "model": model,
            "design": Path(design_path).name if design_path else None,
            "axes": [{"key": DENSITY_KEY, "values": []}], "fixed": {}, **(settings or {}),
            "members": [], "convergence": evaluate([], planned, tol)}


def add_member(study: dict, member: dict) -> dict:
    study["members"].append(member)
    study["axes"][0]["values"] = [m["density"] for m in study["members"]]
    conv = study["convergence"]
    study["convergence"] = evaluate(study["members"], conv["densities"], conv["tolerances"])
    return study["convergence"]


def write_study(study: dict, path: Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(finite_json({k: v for k, v in study.items() if not k.startswith("_")}),
                              indent=1, allow_nan=False), encoding="utf-8", newline="\n")
    os.replace(tmp, path)
    return path


# ---------------------------------------------------------------------------- the CLI run

def run_convergence(design_path: str, *, densities=DEFAULT_DENSITIES, tol: dict | None = None,
                    max_runs: int = DEFAULT_MAX_RUNS, max_density: float | None = None, fixed: dict | None = None,
                    name: str | None = None, out: Path, sim_root: Path, threads: int = 4, points: int = 801,
                    pattern=None, echo: bool = False, end_db: float | None = None, exact: bool = True,
                    engine: str = "cpu", excite: str | None = None, log=print,
                    network_criteria: dict | None = None) -> dict:
    """Run the study in this process, one density at a time, and write
    ``<out>/studies/<name>.json`` plus one member bundle per run in ``<out>/studies/<name>/``."""
    from .cli import _slug
    from .model import load_model, resolve_params
    from .multiport import run_model
    from .study import _write_member, summarize

    module = load_model(design_path)
    design = getattr(module, "DESIGN", None)
    if design is None:
        raise ValueError("converge --densities needs a design file (.design.json); for a Python model "
                         "refine its own mesh parameter with --param")
    why = unsupported(design)
    if why:
        raise ValueError(why)
    planned = plan(densities, max_runs, max_density)
    tol = check_tolerances(tol)
    fixed = dict(fixed or {})
    values = resolve_params(module.PARAMS, fixed)  # validated before any solver time is spent
    for d in planned:  # every density must build (a too-fine mesh can exceed the cell limit)
        with_density(design, d)
    name = name or _slug(module.MODEL["id"] + "--mesh-convergence", {})
    study = new_study(name=name, model={"id": module.MODEL["id"], "name": module.MODEL["name"]},
                      planned=planned, tol=tol, design_path=design_path,
                      settings={"threads": threads, "end_criteria_db": end_db, "exact_endcriteria": exact,
                                "engine": engine})
    study["fixed"] = fixed
    if network_criteria:
        study["network_criteria"] = network_criteria
    member_dir = Path(out) / "studies" / name
    spath = Path(out) / "studies" / f"{name}.json"
    t_start = time.time()
    for i, d in enumerate(planned, 1):
        mod = module_at_density(module, d)
        params = [p.describe(values[p.key]) for p in mod.PARAMS]
        slug = _slug(module.MODEL["id"], {**fixed, "cpw": f"{d:g}"})
        label = f"{module.MODEL['name']} · {density_text(d)}"
        log(f"fairbeam converge [{i}/{len(planned)}] {density_text(d)}")
        try:
            sim = run_model(mod, values, excite=excite, sim_path=str(Path(sim_root) / name / slug),
                            threads=threads, echo=echo, engine=engine, exact=exact, end_db=end_db,
                            n_freq=points, pattern_freqs=pattern, element_patterns=False, log=log)
        except KeyboardInterrupt:
            add_member(study, {"density": d, "status": "cancelled", "file": None, "metrics": {}})
            write_study(study, spath)
            raise
        except Exception as e:  # noqa: BLE001 - recorded, the study stops with the reason
            log(f"    failed: {e}")
            add_member(study, {"density": d, "status": "failed", "error": str(e), "file": None, "metrics": {}})
            break
        bundle = sim.to_bundle(module.MODEL, params, name=label)
        path = _write_member(bundle, member_dir, slug)
        mx = metrics(bundle, network_criteria=network_criteria)
        conv = add_member(study, {"density": d, "status": "done", "file": str(path.relative_to(out)),
                                  "metrics": mx, "summary": summarize(bundle)})
        fr = mx["f_res"]
        log(f"    f_res {fr / 1e9:.4f} GHz, S11 {mx['s11_db']:.2f} dB" if fr else "    no port result",
            f"  Dmax {mx['dmax_dbi']} dBi  cells {mx['cells']}  {mx['wall_time_s']} s")
        write_study(study, spath)
        if conv["done"]:
            break
    study["wall_time_s"] = round(time.time() - t_start, 2)
    write_study(study, spath)
    study["_path"] = str(spath)
    return study


# ---------------------------------------------------------------------------- the run server

class ServerStudies:
    """Mesh convergence studies of the run server: a chain of normal run jobs.

    ``start`` queues the first density; ``on_finished`` (JobManager's hook) adds each finished job
    to its study file (``<projects>/studies/<id>.json``), applies the stopping rule and queues the
    next density or closes the study. Every job carries ``sweep`` metadata like a parameter sweep
    (``kind: "convergence"``), so the designer groups them in one folder of the run tree; on close
    the jobs' ``sweep.total`` becomes the number run and ``sweep.verdict`` the result.
    """

    def __init__(self, manager, projects_dir: Path):
        self.manager = manager
        self.dir = Path(projects_dir) / "studies"
        self.lock = threading.RLock()

    def path(self, study_id: str) -> Path:
        return self.dir / f"{study_id}.json"

    def load(self, study_id: str) -> dict | None:
        p = self.path(study_id)
        try:
            study = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if isinstance(study, dict) and is_legacy_schema(study.get("schema")):
            study["schema"] = current_schema(study["schema"])   # rewritten with the new id when the study goes on
        return study

    def start(self, *, study_id: str, name: str, model: dict, job_kw: dict, planned: list[float],
              tol: dict, settings: dict):
        study = new_study(name=name, model=model, planned=planned, tol=tol, study_id=study_id,
                          settings=settings)
        study["job_kw"] = job_kw  # how to queue the next density (removed from API answers)
        with self.lock:  # on_finished of a fast-failing first job waits for the file
            job = self._submit(study, job_kw, 0)
            write_study(study, self.path(study_id))
        return study, job

    def _submit(self, study: dict, job_kw: dict, index: int):
        planned = study["convergence"]["densities"]
        d = planned[index]
        stem = re.sub(r"[^a-z0-9_-]+", "-", str(job_kw.get("name") or job_kw.get("model_id") or "design").lower())
        stem = stem.strip("-_")[:48] or "design"
        return self.manager.submit(
            **{k: v for k, v in job_kw.items() if k != "name"}, mesh_density=d,
            name=f"{stem}--mesh-{d:g}".replace(".", "_"),
            sweep={"id": study["id"], "name": study["name"], "kind": "convergence", "index": index,
                   "total": len(planned), "values": {DENSITY_KEY: d},
                   "axes": [{"key": DENSITY_KEY, "values": planned}]})

    def on_finished(self, job):
        sw = job.sweep or {}
        if sw.get("kind") != "convergence":
            return
        with self.lock:
            study = self.load(sw["id"])
            if study is None or study["convergence"]["done"]:
                return
            if any(m.get("job") == job.id for m in study["members"]):
                return
            member = {"density": float(sw["values"][DENSITY_KEY]), "status": job.status, "job": job.id,
                      "file": job.bundle if job.status == "done" else None, "metrics": {}}
            if job.status == "done" and job.bundle:
                try:
                    from .study import summarize

                    bundle = json.loads((Path(self.manager.projects_dir) / job.bundle).read_text(encoding="utf-8"))
                    member["metrics"] = metrics(bundle)
                    member["summary"] = summarize(bundle)
                except (OSError, ValueError, KeyError) as e:
                    member.update(status="failed", error=f"could not read the result: {e}")
            elif job.error:
                member["error"] = job.error
            conv = add_member(study, member)
            if not conv["done"] and not self.manager._stopping:
                try:
                    self._submit(study, study["job_kw"], len(study["members"]))
                except Exception as e:  # noqa: BLE001 - close the study rather than leave it hanging
                    study["convergence"].update(done=True, reason="failed", verdict=f"stopped: {e}")
            if study["convergence"]["done"]:
                study["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
                self._close_jobs(study)
            write_study(study, self.path(study["id"]))

    def _close_jobs(self, study: dict):
        conv = study["convergence"]
        with self.manager.lock:
            jobs = [j for j in self.manager.jobs.values() if (j.sweep or {}).get("id") == study["id"]]
        for j in jobs:
            j.sweep = {**j.sweep, "total": len(study["members"]), "verdict": conv["verdict"],
                       "converged_at": conv["converged_at"], "reason": conv["reason"]}
            try:
                j.save()
            except OSError:
                pass

    def get(self, study_id: str) -> dict | None:
        study = self.load(study_id)
        if study is None:
            return None
        study.pop("job_kw", None)
        conv = study["convergence"]
        if not conv["done"]:
            with self.manager.lock:
                active = [j for j in self.manager.jobs.values()
                          if (j.sweep or {}).get("id") == study_id and not j.terminal]
            if not active:  # the server stopped in the middle of the study
                conv.update(done=True, reason="cancelled", verdict="stopped before it converged", next=None)
        return study
