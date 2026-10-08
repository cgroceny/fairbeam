"""Parameter sweeps and mesh-convergence studies.

    fairbeam sweep python/models/dipole.py --param length=54,58,62 --threads 4
    fairbeam converge python/models/dipole.py --param mesh_div=10,15,20,30 --threads 4

Points run sequentially (one openEMS process at a time). Each point is written as a normal bundle
under ``<out>/studies/<name>/`` and a small study file ``<out>/studies/<name>.json``
(schema ``fairbeam.study/1``) lists the members with summary metrics. See docs/STUDIES.md.
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import time
from pathlib import Path

import numpy as np

from .jsonutil import finite_json

STUDY_SCHEMA = "fairbeam.study/1"


# ---------------------------------------------------------------------------- metrics

def first_resonance(bundle: dict) -> dict | None:
    """First resonance of the excited port: the centre (min S11) of the first matched band, or the
    global S11 minimum when nothing is matched (``matched: false``)."""
    res = bundle.get("results") or {}
    if not res.get("ports"):
        return None
    if res.get("bands"):
        b = res["bands"][0]
        return {"f": b["f_center"], "s11_db": b["s11_min_db"], "matched": True}
    f, s = _excited_s11(bundle)
    k = int(np.argmin(np.abs(s)))
    return {"f": float(f[k]), "s11_db": round(float(20 * np.log10(max(np.abs(s[k]), 1e-6))), 3), "matched": False}


def reactance_zeros(bundle: dict) -> list[dict]:
    """Frequencies where Im(Zin) crosses zero upward (series resonances), with Re(Zin) there."""
    res = bundle.get("results") or {}
    key = _excited_key(bundle)
    if key is None:
        return []
    pr = res["ports"][key]
    f = np.asarray(res["frequency"])
    r, x = np.asarray(pr["zin_re"]), np.asarray(pr["zin_im"])
    out = []
    for i in np.where((x[:-1] < 0) & (x[1:] >= 0))[0]:
        t = -x[i] / (x[i + 1] - x[i])
        out.append({"f": float(f[i] + t * (f[i + 1] - f[i])), "r": round(float(r[i] + t * (r[i + 1] - r[i])), 3)})
    return out


def summarize(bundle: dict) -> dict:
    """Compact metrics used by study files and the convergence report."""
    res = bundle.get("results") or {}
    run = bundle.get("run") or {}
    features = ((bundle.get("mesh") or {}).get("auto") or {}).get("fine_features")
    fr = first_resonance(bundle)
    ff_list = res.get("farfield", [])
    ff = None
    if ff_list:
        target = fr["f"] if fr else ff_list[0]["f"]
        ff = min(ff_list, key=lambda e: abs(e["f"] - target))
    sp_summary = None
    sp = res.get("sparams")
    if sp and len(sp["ports"]) > 1 and fr:
        f = np.asarray(res["frequency"])
        k = int(np.argmin(np.abs(f - fr["f"])))
        sp_summary = {"f": float(f[k]), "db": {key: round(float(20 * np.log10(max(np.hypot(v["re"][k], v["im"][k]), 1e-12))), 3)
                                               for key, v in sp["s"].items()},
                      "reciprocity_max": sp["qa"]["reciprocity_max"], "passive": sp["qa"]["passive"]}
    return {
        "sparams": sp_summary,
        "bands": [{k: b[k] for k in ("f_lo", "f_hi", "f_center", "s11_min_db", "edge_lo", "edge_hi")}
                  for b in res.get("bands", [])],
        "first_resonance": fr,
        "reactance_zeros": reactance_zeros(bundle),
        "farfield": [{"f": e["f"], "dmax_dbi": e["dmax_dbi"], "dmax_pattern_dbi": e.get("dmax_pattern_dbi"),
                      "rad_efficiency": e["rad_efficiency"],
                      "gain_dbi": e.get("gain_dbi"), "realized_gain_dbi": e.get("realized_gain_dbi")}
                     for e in ff_list],
        "dmax_dbi": ff["dmax_dbi"] if ff else None,
        "rad_efficiency": ff["rad_efficiency"] if ff else None,
        "cells": (bundle.get("mesh") or {}).get("total_cells"),
        "min_cell": (bundle.get("mesh") or {}).get("min_cell"),
        "max_cell": (bundle.get("mesh") or {}).get("max_cell"),
        "timesteps": run.get("timesteps"),
        "wall_time_s": run.get("wall_time_s"),
        "converged": (run.get("converged") if all(p.get("converged") is True
                                                for p in run.get("port_runs", [])) else False),
        "fine_features_resolved": (None if features is None else all(f.get("resolved") is True for f in features)),
    }


def parse_network_criteria(items, frequency_ghz) -> dict | None:
    """Opt-in ``KIND:PORTS:TOL`` criteria at a fixed frequency; port numbers are physical IDs."""
    if not items and frequency_ghz is None:
        return None
    if not items or frequency_ghz is None:
        raise ValueError("--network-metric and --network-frequency must be supplied together")
    frequency = float(frequency_ghz) * 1e9
    if not np.isfinite(frequency) or frequency <= 0:
        raise ValueError("network frequency must be finite and positive")
    specs = []
    for item in items:
        try:
            kind, ports, tol = item.split(":")
            ports = [int(p) for p in ports.split(",")]
            tol = float(tol)
        except (ValueError, TypeError):
            raise ValueError("network metric must be KIND:PORTS:TOL") from None
        counts = {"coupling": (2,), "isolation": (2,), "directivity": (3,), "phase": (2, 3), "s11": (1,)}
        if kind not in counts or len(ports) not in counts[kind] or any(p < 1 for p in ports):
            raise ValueError("network metric has an unknown kind or invalid port list")
        if kind in ("directivity", "phase") and len(ports) == 3 and ports[0] == ports[1]:
            raise ValueError("the two output ports must differ")
        if not np.isfinite(tol) or tol <= 0:
            raise ValueError("network tolerance must be finite and positive")
        key = f"{kind}:{','.join(map(str, ports))}"
        if any(s["key"] == key for s in specs):
            raise ValueError(f"duplicate network metric {key}")
        specs.append({"key": key, "kind": kind, "ports": ports, "tolerance": tol,
                      "unit": "deg" if kind == "phase" else "dB"})
    return {"frequency_hz": frequency, "criteria": specs}


def network_metrics(bundle: dict, config: dict) -> dict:
    """Selected complex S-parameters interpolated at the fixed frequency, without extrapolation.

    Samples at/below 1e-4 amplitude are too close to the bundle's five-decimal storage floor. Missing
    columns, invalid data, and phase at a null produce an unavailable criterion, never a pass.
    """
    res = bundle.get("results") or {}
    sp = res.get("sparams") or {}
    f = np.asarray(res.get("frequency", []), float)
    ids = sp.get("port_numbers", sp.get("ports", []))
    frequency = config["frequency_hz"]

    def sample(out, inp):
        if (f.ndim != 1 or len(f) < 2 or not np.all(np.isfinite(f)) or np.any(np.diff(f) <= 0)
                or not f[0] <= frequency <= f[-1]):
            raise ValueError("frequency is outside the valid sampled band")
        if out not in ids or inp not in ids:
            raise ValueError("requested port is absent")
        entry = (sp.get("s") or {}).get(f"{ids.index(out) + 1},{ids.index(inp) + 1}")
        if entry is None:
            raise ValueError("requested excitation column is absent")
        re, im = np.asarray(entry.get("re"), float), np.asarray(entry.get("im"), float)
        if re.shape != f.shape or im.shape != f.shape or not np.all(np.isfinite(re + im)):
            raise ValueError("invalid complex S-parameter samples")
        z = complex(np.interp(frequency, f, re), np.interp(frequency, f, im))
        if abs(z) <= 1e-4:
            raise ValueError("response is too close to stored precision (amplitude <= 1e-4)")
        return z

    values = []
    for spec in config["criteria"]:
        kind, ports = spec["kind"], spec["ports"]
        try:
            z = sample(ports[0], ports[-1])
            if kind == "directivity" or (kind == "phase" and len(ports) == 3):
                z /= sample(ports[1], ports[-1])
            value = float(np.angle(z, deg=True) if kind == "phase" else 20 * np.log10(abs(z)))
            if kind in ("coupling", "isolation"):
                value = -value
            values.append({"value": value, "reason": None})
        except (ValueError, TypeError, IndexError) as e:
            values.append({"value": None, "reason": str(e)})
    run = bundle.get("run") or {}
    energy_ok = run.get("converged") is True and all(p.get("converged") is True for p in run.get("port_runs", []))
    return {**config, "values": values, "solver_converged": energy_ok}


def compare_network(a: dict | None, b: dict | None) -> dict:
    """Strict per-criterion change, including circular phase distance and solver completion."""
    if not a or not b or any(a.get(k) != b.get(k) for k in ("frequency_hz", "criteria")):
        return {"checks": [], "converged": False, "reason": "network measurements missing or inconsistent"}
    checks = []
    for spec, va, vb in zip(b["criteria"], a["values"], b["values"]):
        before, after = va.get("value"), vb.get("value")
        delta = None if before is None or after is None else after - before
        if delta is not None and spec["kind"] == "phase":
            delta = (delta + 180) % 360 - 180
        ok = delta is not None and np.isfinite(delta) and abs(delta) < spec["tolerance"]
        checks.append({**spec, "before": before, "after": after, "delta": delta, "ok": bool(ok),
                       "reason": vb.get("reason") or va.get("reason")})
    energy_ok = a.get("solver_converged") is True and b.get("solver_converged") is True
    ok = len(checks) == len(b["criteria"]) and bool(checks) and all(c["ok"] for c in checks) and energy_ok
    return {"checks": checks, "converged": bool(ok), "reason": None if energy_ok else "energy convergence missing"}


def format_network_steps(steps) -> list[str]:
    lines = []
    for i, step in enumerate(steps, 1):
        net = step.get("network")
        if net is None:
            continue
        for c in net["checks"]:
            delta = "unavailable" if c["delta"] is None else f"{c['delta']:.4g} {c['unit']}"
            lines.append(f"network step {i} {c['key']}: delta {delta}, tolerance {c['tolerance']:g} "
                         f"{c['unit']}: {'yes' if c['ok'] else 'no'}" + (f" ({c['reason']})" if c['reason'] else ""))
        if net.get("reason"):
            lines.append(f"network step {i}: {net['reason']}")
    return lines


def convergence_report(summaries: list[dict], tol_f_pct: float = 0.5, tol_d_db: float = 0.1,
                       tol_s11_db: float = 1.0) -> dict:
    """Change of first resonance and Dmax between successive refinements (listed coarse -> fine).

    A step needs stable resonance, S11 depth, available Dmax, energy and local mesh checks. The study is
    converged when its last step is.
    """
    steps = []
    if not np.isfinite(tol_s11_db) or tol_s11_db <= 0:
        raise ValueError("S11 tolerance must be finite and positive")
    for a, b in zip(summaries, summaries[1:]):
        fa, fb = (a.get("first_resonance") or {}).get("f"), (b.get("first_resonance") or {}).get("f")
        da, db = a.get("dmax_dbi"), b.get("dmax_dbi")
        df = None if not (fa and fb) else 100.0 * (fb - fa) / fa
        dd = None if da is None or db is None else db - da
        sa, sb = (a.get("first_resonance") or {}).get("s11_db"), (b.get("first_resonance") or {}).get("s11_db")
        ds = None if sa is None or sb is None else sb - sa
        energy_ok = a.get("converged") is True and b.get("converged") is True
        local_ok = all(m.get("fine_features_resolved") is not False for m in (a, b))
        ok = (energy_ok and local_ok and df is not None and abs(df) < tol_f_pct
              and ds is not None and abs(ds) < tol_s11_db and (dd is None or abs(dd) < tol_d_db))
        step = {"df_pct": None if df is None else round(df, 4),
                "d_dmax_db": None if dd is None else round(dd, 4), "converged": bool(ok),
                "ds11_db": None if ds is None else round(ds, 4),
                "solver_converged": energy_ok, "fine_features_resolved": local_ok}
        if "network" in a or "network" in b:
            step["network"] = compare_network(a.get("network"), b.get("network"))
            step["converged"] &= step["network"]["converged"]
        steps.append(step)
    return {"tol_f_pct": tol_f_pct, "tol_d_db": tol_d_db, "tol_s11_db": tol_s11_db, "steps": steps,
            "converged": bool(steps and steps[-1]["converged"])}


# ---------------------------------------------------------------------------- helpers

def _excited_key(bundle):
    res = bundle.get("results") or {}
    if not res.get("ports"):
        return None
    excited = [str(p["number"]) for p in bundle.get("ports", []) if p.get("excite")]
    return excited[0] if excited and excited[0] in res["ports"] else sorted(res["ports"])[0]


def _excited_s11(bundle):
    res = bundle["results"]
    pr = res["ports"][_excited_key(bundle)]
    return np.asarray(res["frequency"]), np.asarray(pr["s11_re"]) + 1j * np.asarray(pr["s11_im"])


def parse_axes(items: list[str]) -> list[tuple[str, list[str]]]:
    """``["a=1,2", "b=x"]`` -> ``[("a", ["1", "2"]), ("b", ["x"])]`` (order preserved)."""
    axes = []
    for item in items or []:
        if "=" not in item:
            raise ValueError(f"--param expects key=v1,v2,..., got '{item}'")
        k, v = item.split("=", 1)
        values = [s.strip() for s in v.split(",") if s.strip()]
        if not values:
            raise ValueError(f"--param {k}: no values")
        if k.strip() in dict(axes):
            raise ValueError(f"--param {k} given twice")
        axes.append((k.strip(), values))
    return axes


def cartesian(axes: list[tuple[str, list[str]]]) -> list[dict]:
    keys = [k for k, _ in axes]
    return [dict(zip(keys, combo)) for combo in itertools.product(*[v for _, v in axes])]


# ---------------------------------------------------------------------------- running

def run_study(model_path: str, axes, *, kind: str = "sweep", fixed: dict | None = None,
              name: str | None = None, out: Path, sim_root: Path, threads: int = 4, points: int = 801,
              pattern=None, echo: bool = False, tol_f_pct: float = 0.5, tol_d_db: float = 0.1, tol_s11_db: float = 1.0,
              end_db: float | None = None, exact: bool = True, engine: str = "cpu",
              excite: str | None = None, log=print, network_criteria: dict | None = None) -> dict:
    from .cli import _slug
    from .model import load_model, resolve_params
    from .multiport import run_model

    if kind == "convergence":
        convergence_report([], tol_f_pct, tol_d_db, tol_s11_db)  # validate before any solver work
    module = load_model(model_path)
    fixed = dict(fixed or {})
    grid = cartesian(axes)
    for point in grid:  # validate every point before spending any solver time
        resolve_params(module.PARAMS, {**fixed, **point})
    name = name or _slug(module.MODEL["id"] + "--" + kind, {k: "-".join(v) for k, v in axes})
    study_dir = Path(out) / "studies"
    member_dir = study_dir / name
    members = []
    t_start = time.time()
    for i, point in enumerate(grid, 1):
        overrides = {**fixed, **point}
        values = resolve_params(module.PARAMS, overrides)
        params = [p.describe(values[p.key]) for p in module.PARAMS]
        slug = _slug(module.MODEL["id"], overrides)
        label = module.MODEL["name"] + " · " + ", ".join(f"{k}={v}" for k, v in sorted(overrides.items()))
        log(f"fairbeam {kind} [{i}/{len(grid)}] {', '.join(f'{k}={v}' for k, v in point.items())}")
        sim = run_model(module, values, excite=excite, sim_path=str(Path(sim_root) / name / slug),
                        threads=threads, echo=echo, engine=engine, exact=exact, end_db=end_db,
                        n_freq=points, pattern_freqs=pattern, element_patterns=False, log=log)
        bundle = sim.to_bundle(module.MODEL, params, name=label)
        path = _write_member(bundle, member_dir, slug)
        s = summarize(bundle)
        if network_criteria:
            s["network"] = network_metrics(bundle, network_criteria)
        fr = s["first_resonance"]
        log(f"    f_res {fr['f'] / 1e9:.4f} GHz ({fr['s11_db']:.1f} dB)" if fr else "    no port result",
            f"  Dmax {s['dmax_dbi']} dBi  eff {s['rad_efficiency']}  cells {s['cells']}  "
            f"{s['wall_time_s']} s  converged={s['converged']}")
        members.append({"file": str(path.relative_to(out)), "params": point, "summary": s})

    study = {
        "schema": STUDY_SCHEMA, "kind": kind, "name": name,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "model": {"id": module.MODEL["id"], "name": module.MODEL["name"], "file": Path(model_path).name},
        "axes": [{"key": k, "values": [_num(v) for v in vals]} for k, vals in axes],
        "fixed": fixed, "threads": threads, "end_criteria_db": end_db, "exact_endcriteria": exact, "engine": engine,
        "wall_time_s": round(time.time() - t_start, 2),
        "members": members,
    }
    if kind == "convergence":
        study["convergence"] = convergence_report([m["summary"] for m in members], tol_f_pct, tol_d_db, tol_s11_db)
        if network_criteria:
            study["network_criteria"] = network_criteria
    study_dir.mkdir(parents=True, exist_ok=True)
    spath = study_dir / f"{name}.json"
    tmp = spath.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(finite_json(study), indent=1, allow_nan=False), encoding="utf-8", newline="\n")
    os.replace(tmp, spath)
    study["_path"] = str(spath)
    return study


def _write_member(bundle, folder: Path, slug: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{slug}.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(finite_json(bundle), separators=(",", ":"), allow_nan=False), encoding="utf-8")
    os.replace(tmp, path)
    return path


def _num(v: str):
    for cast in (int, float):
        try:
            return cast(v)
        except ValueError:
            pass
    return v


def format_convergence(study: dict) -> str:
    key = study["axes"][0]["key"]
    rows = [f"{key:>10}  {'cells':>9}  {'f_res GHz':>10}  {'df %':>8}  {'dS11 dB':>8}  {'Dmax dBi':>8}  {'dD dB':>7}  ok"]
    rep = study["convergence"]
    for i, m in enumerate(study["members"]):
        s = m["summary"]
        fr = (s["first_resonance"] or {}).get("f")
        step = rep["steps"][i - 1] if i else {}
        rows.append(f"{str(m['params'][key]):>10}  {s['cells'] or 0:>9}  "
                    f"{(fr or 0) / 1e9:>10.4f}  {_fmt(step.get('df_pct'), 8, 3)}  "
                    f"{_fmt(step.get('ds11_db'), 8, 3)}  "
                    f"{_fmt(s['dmax_dbi'], 8, 2)}  {_fmt(step.get('d_dmax_db'), 7, 3)}  "
                    f"{'' if not i else ('yes' if step['converged'] else 'no')}")
    rows.append(f"converged (last step |df| < {rep['tol_f_pct']} %, "
                f"|dS11| < {rep.get('tol_s11_db', 1.0)} dB, |dD| < {rep['tol_d_db']} dB): "
                f"{'YES' if rep['converged'] else 'NO'}")
    rows.extend(format_network_steps(rep["steps"]))
    return "\n".join(rows)


def _fmt(v, width, nd):
    return f"{'-':>{width}}" if v is None else f"{v:>{width}.{nd}f}"


# ---------------------------------------------------------------------------- CLI

def add_commands(sub, defaults: dict):
    """Register ``sweep``, ``converge`` and ``touchstone`` on the fairbeam argparse subparsers."""

    def common(p, required=True):
        p.add_argument("model", help="path to a model .py file" + ("" if required else " or a .design.json design"))
        p.add_argument("--param", action="append", required=required, metavar="KEY=V1,V2,...",
                       help="parameter axis (repeat for a cartesian sweep)" if required else
                       "refine this model parameter instead of the design's mesh density (listed coarse to fine)")
        p.add_argument("--set", action="append", metavar="KEY=VALUE", help="fixed parameter override")
        p.add_argument("--name", help="study name (default derived from model and axes)")
        p.add_argument("--out", default=str(defaults["out"]), help="projects folder; the study goes to <out>/studies")
        p.add_argument("--sim-root", default=str(defaults["sim"]), help="folder for raw openEMS output")
        p.add_argument("--threads", type=int, default=4, help="FDTD threads (default 4)")
        p.add_argument("--points", type=int, default=801, help="frequency points")
        p.add_argument("--pattern", help="far-field frequencies in GHz (default: band centres)")
        p.add_argument("--verbose", action="store_true", help="echo openEMS output")
        p.add_argument("--excite", metavar="all|1,3",
                       help="ports to excite per point (default: all ports for <= 4 ports, else port 1)")
        p.add_argument("--end-db", type=float, help="energy end criterion in dB (default: the model's, -60 unless set)")
        p.add_argument("--exact", action="store_true", help=argparse.SUPPRESS)  # now the default; kept for scripts
        p.add_argument("--no-exact", action="store_true",
                       help="check the end criterion every ~4 s of wall time instead of every Nyquist period")
        p.add_argument("--engine", choices=["cpu", "gpu"], default=os.environ.get("FAIRBEAM_ENGINE", "cpu"),
                       help="FDTD engine; gpu needs the openEMS GPU build")

    p = sub.add_parser("sweep", help="run a cartesian parameter sweep and write a study file")
    common(p)
    p.set_defaults(func=lambda a: _cmd_study(a, "sweep"))

    from .convergence import DEFAULT_MAX_RUNS, DEFAULT_TOL

    p = sub.add_parser("converge", help="mesh convergence study: a design at increasing mesh densities, "
                                        "or a model parameter refined (--param)")
    common(p, required=False)
    p.add_argument("--densities", default="15,20,30,40", metavar="C1,C2,...",
                   help="designs: automatic mesh densities in cells per wavelength, coarse to fine "
                        "(default 15,20,30,40)")
    p.add_argument("--tol-f", type=float, default=DEFAULT_TOL["f_pct"],
                   help="resonance tolerance in %% (default 0.5)")
    p.add_argument("--tol-s11", type=float, default=DEFAULT_TOL["s11_db"],
                   help="tolerance of |S11| at the resonance in dB (default 1)")
    p.add_argument("--tol-dmax", "--tol-d", dest="tol_d", type=float,
                   help="Dmax tolerance in dB (default 0.2 for a design, 0.1 with --param)")
    p.add_argument("--max-runs", type=int, default=DEFAULT_MAX_RUNS,
                   help="designs: stop after this many runs (default 4)")
    p.add_argument("--max-density", type=float, help="designs: leave out densities above this")
    p.add_argument("--network-metric", action="append", metavar="KIND:PORTS:TOL",
                   help="opt-in convergence criterion: coupling/isolation OUT,IN; directivity COUPLED,ISOLATED,IN; "
                        "phase OUT,IN or OUT1,OUT2,IN; s11 PORT. Tolerance in dB, or degrees for phase")
    p.add_argument("--network-frequency", type=float, metavar="GHZ",
                   help="fixed frequency for --network-metric (required together)")
    p.set_defaults(func=_cmd_converge)

    p = sub.add_parser("touchstone", help="write a bundle's S-parameters as Touchstone (.s1p, .s2p, ...)")
    p.add_argument("bundle", help="bundle .json")
    p.add_argument("-o", "--output", help="output path (default: <bundle>.s<N>p next to the bundle)")
    p.add_argument("--port", help="write only this port's reflection as .s1p (default: all ports of the S-matrix)")
    p.add_argument("--ref", type=float, default=50.0,
                   help="reference impedance in ohm (default 50; 0 keeps the port's own impedance)")
    p.set_defaults(func=_cmd_touchstone)


def _cmd_converge(args):
    """``converge --param`` refines a model parameter (the older study); without it the design's
    automatic mesh density is refined (fairbeam.convergence)."""
    args.network_criteria = parse_network_criteria(args.network_metric, args.network_frequency)
    if args.param:
        if args.tol_d is None:
            args.tol_d = 0.1
        return _cmd_study(args, "convergence")
    from .cli import _overrides
    from .convergence import format_table, run_convergence

    pattern = [float(x) * 1e9 for x in args.pattern.split(",")] if args.pattern else None
    tol = {"f_pct": args.tol_f, "s11_db": args.tol_s11, "dmax_db": 0.2 if args.tol_d is None else args.tol_d}
    study = run_convergence(args.model, densities=args.densities, tol=tol, max_runs=args.max_runs,
                            max_density=args.max_density, fixed=_overrides(args.set), name=args.name,
                            out=Path(args.out), sim_root=Path(args.sim_root), threads=args.threads,
                            points=args.points, pattern=pattern, echo=args.verbose, end_db=args.end_db,
                            exact=not args.no_exact, engine=args.engine, excite=args.excite,
                            network_criteria=args.network_criteria)
    print(format_table(study))
    print(f"fairbeam: wrote {study['_path']} ({len(study['members'])} runs, {study['wall_time_s']} s)")
    return 0 if study["convergence"]["reason"] in ("converged", "exhausted") else 1


def _cmd_study(args, kind):
    from .cli import _overrides

    axes = parse_axes(args.param)
    if kind == "convergence" and len(axes) != 1:
        raise ValueError("converge takes exactly one --param (listed from coarse to fine)")
    if kind == "convergence" and len(axes[0][1]) < 2:
        raise ValueError("converge needs at least two values")
    pattern = [float(x) * 1e9 for x in args.pattern.split(",")] if args.pattern else None
    kw = {"tol_f_pct": args.tol_f, "tol_d_db": args.tol_d, "tol_s11_db": args.tol_s11,
          "network_criteria": getattr(args, "network_criteria", None)} if kind == "convergence" else {}
    study = run_study(args.model, axes, kind=kind, fixed=_overrides(args.set), name=args.name,
                      out=Path(args.out), sim_root=Path(args.sim_root), threads=args.threads,
                      points=args.points, pattern=pattern, echo=args.verbose, end_db=args.end_db,
                      exact=not args.no_exact, engine=args.engine, excite=args.excite, **kw)
    if kind == "convergence":
        print(format_convergence(study))
    print(f"fairbeam: wrote {study['_path']} ({len(study['members'])} members, {study['wall_time_s']} s)")


def _cmd_touchstone(args):
    from .touchstone import write_s1p, write_snp

    path = Path(args.bundle)
    bundle = json.loads(path.read_text(encoding="utf-8"))
    sp = (bundle.get("results") or {}).get("sparams")
    n = len(sp["ports"]) if sp else 1
    z = None if args.ref == 0 else args.ref
    if n == 1 or args.port:
        out = Path(args.output) if args.output else path.with_suffix(".s1p")
        write_s1p(bundle, out, port=args.port, z_ref=z)
    else:
        out = Path(args.output) if args.output else path.with_suffix(f".s{n}p")
        write_snp(bundle, out, z_ref=z)
    print(f"fairbeam: wrote {out}")
