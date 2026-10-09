"""Reproduce the patch feed-mesh control, sequentially, in a new output directory.

From python/: python -m tests.feed_resolution_study --out <new-directory>
The before case uses the mesh detector from --baseline-ref; all four cases use
the same current model, solver, materials, source, boundaries and 50-ohm port.
The half/quarter cases subdivide the new grid within 3 mm of the feed center.
They test local sensitivity, not physical accuracy or global mesh convergence.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
from datetime import datetime, timezone
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def save(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save_detail(port, run):
    """Resolve narrow minima from saved probes without another time-domain solve."""
    f = np.linspace(2.43e9, 2.49e9, 1201)
    port.CalcPort(str(run / "raw"), f)
    s11, zin = port.uf_ref / port.uf_inc, port.uf_tot / port.if_tot
    np.savez(run / "response-detail.npz", frequency_hz=f, s11=s11, zin=zin)
    return {"finite": bool(np.isfinite(s11).all() and np.isfinite(zin).all()),
            "samples": len(f), "frequency_step_hz": float(f[1] - f[0]),
            "response_sha256": digest(run / "response-detail.npz")}


def run_case(folder, name):
    from fairbeam import Simulation, mesh_refinement
    from fairbeam.model import load_model, resolve_params

    old = {"__name__": "fairbeam.baseline_refinement", "__package__": "fairbeam"}
    exec((folder / "baseline-mesh-refinement.py").read_text(encoding="utf-8"), old)
    original = Simulation.auto_mesh

    def automatic(sim, **kw):
        return original(sim, **{**kw, "refine_features": True})

    model = load_model(ROOT / "python/models/patch_antenna.py")
    params = resolve_params(model.PARAMS, {"mesh": "auto", "auto_cpw": "20"})
    measure = old["measure_features"] if name == "before" else mesh_refinement.measure_features
    with patch.object(Simulation, "auto_mesh", automatic), patch.object(mesh_refinement, "measure_features", measure):
        sim = model.build(params)
    sim.remove_nf2ff_box()
    sim.max_timesteps = 350000
    sim.fdtd.SetNumberOfTimeSteps(sim.max_timesteps)
    for axis, center in enumerate((-6, 0, .762)):
        lines = np.asarray(sim.mesh.GetLines(axis))
        for _ in range({"before": 0, "after": 0, "half": 1, "quarter": 2}[name]):
            mid = (lines[:-1] + lines[1:]) / 2
            lines = np.sort(np.r_[lines, mid[(mid >= center - 3) & (mid <= center + 3)]])
        sim.mesh.SetLines(axis, lines)
    run = folder / name
    lines = {a: sim.mesh.GetLines(a).tolist() for a in "xyz"}
    save(run / "settings.json", {"params": params, "mesh": lines, "boundaries": sim.boundaries,
        "ports": sim.ports, "excitation": sim.excitation, "end_db": sim.end_criteria_db,
        "cells": int(np.prod([len(x)-1 for x in lines.values()])), "analytic_dt_s": sim.cfl_timestep()})
    sim.fdtd.Write2XML(str(run / "model.xml"))
    stats = sim.run(str(run / "raw"), threads=4)
    f = np.linspace(sim.f_min, sim.f_max, 801)
    port = sim._port_objs[0]
    port.CalcPort(str(run / "raw"), f)
    s11 = port.uf_ref / port.uf_inc
    zin = port.uf_tot / port.if_tot
    np.savez(run / "response.npz", frequency_hz=f, s11=s11, zin=zin)
    finite = bool(np.isfinite(s11).all() and np.isfinite(zin).all())
    passive = bool(np.max(abs(s11)) <= 1.001)
    detail = save_detail(port, run)
    save(run / "summary.json", {"run": stats, "finite": finite, "passive": passive,
        "frequency_ordered": bool(np.all(np.diff(f) > 0)), "samples": len(f),
        "detail": detail,
        "mesh_convergence": "not established; compare both further refinements",
        "response_sha256": digest(run / "response.npz")})
    return 0 if finite and detail["finite"] and passive and stats.get("converged") else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--baseline-ref", default="ba48e5a7c691d47924f558f16e3ebfa48258f61c")
    parser.add_argument("--timeout", type=float, default=900, help="Maximum seconds per case")
    parser.add_argument("--case", choices=["before", "after", "half", "quarter"], help=argparse.SUPPRESS)
    args = parser.parse_args()
    folder = args.out.resolve()
    if args.case:
        return run_case(folder, args.case)
    if not np.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("timeout must be finite and positive")
    baseline = subprocess.check_output(["git", "show", f"{args.baseline_ref}:python/fairbeam/mesh_refinement.py"], cwd=ROOT)
    folder.mkdir(parents=True, exist_ok=False)
    (folder / "baseline-mesh-refinement.py").write_bytes(baseline)
    (folder / "runner.py").write_bytes(Path(__file__).read_bytes())
    manifest = {"evidence_domain": "synthetic", "host": platform.platform(), "threads": 4,
        "baseline_ref": args.baseline_ref, "baseline_sha256": hashlib.sha256(baseline).hexdigest(),
        "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source_dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)),
        "model_sha256": digest(ROOT / "python/models/patch_antenna.py"),
        "mesher_sha256": digest(ROOT / "python/fairbeam/mesh_refinement.py"),
        "generator_sha256": digest(Path(__file__)), "runs": []}
    for name in ("before", "after", "half", "quarter"):
        run = folder / name
        run.mkdir()
        record = {"case": name, "status": "solver_started", "started_utc": datetime.now(timezone.utc).isoformat()}
        manifest["runs"].append(record)
        save(folder / "manifest.json", manifest)
        start = time.monotonic()
        with (run / "solver.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen([sys.executable, "-m", "tests.feed_resolution_study", "--out", str(folder), "--case", name],
                cwd=ROOT / "python", stdout=log, stderr=subprocess.STDOUT,
                env={**os.environ, "PYTHONUTF8": "1"})
            try:
                code = process.wait(timeout=args.timeout)
            except subprocess.TimeoutExpired:
                process.kill()  # The native solver runs in this owned Python process.
                process.wait()
                code = -1
        record.update(status="results_validated" if code == 0 else "interrupted" if code == -1 else "failed",
                      exit_code=code, wall_s=time.monotonic()-start,
                      ended_utc=datetime.now(timezone.utc).isoformat())
        save(folder / "manifest.json", manifest)
        print(name, record["status"], flush=True)
        if code:
            return code
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
