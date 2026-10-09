"""Sequential, bounded Blade source/mesh study; numerical evidence, not antenna validation.

From python/: python -m tests.blade_feed_study --out <new-folder> --phase feed --width 4
Use --phase boundary with --width 0 for the boundary-distance control, or --phase auto
to check the actual gallery automatic mesh at 20, 30 and 40 cells per wavelength.
The frozen input is retained so historical runs do not depend on later mesh changes.
"""
import argparse
import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

import numpy as np

from tests.feed_resolution_study import ROOT, digest, save

SOURCE = Path(__file__).parent / "fixtures/blade_feed_base.design.json"
LIMITS = {"frequency_pct": .5, "depth_db": .5, "at_867_db": .5, "complex_max": .01}


def design(source, phase, width, level, densities=(20, 30, 40), air_density=None):
    d = copy.deepcopy(source)
    d["simulation"].update(boundaries="PML_8", end_criteria_db=-60, max_timesteps=350000)
    d["far_field"] = {"enabled": False}
    d.pop("monitors", None)
    # Width is a fraction of the tab, so the port remains connected when wf changes.
    d["ports"][0].update(start=[f"-wf*{width / 4:.17g}/2", 0, 0],
                         stop=[f"wf*{width / 4:.17g}/2", 0, "g"])
    if phase == "auto":
        d["mesh"] = {"mode": "auto", "cells_per_wavelength": densities[level], "refine_features": True}
        if air_density is not None:
            d["mesh"]["air_cells_per_wavelength"] = air_density
        return d
    for axis, values in d["mesh"]["lines"].items():
        x = np.array(values)
        if phase == "boundary" and level:
            n = level * 8
            x = np.r_[x[0]-np.arange(n, 0, -1)*(x[1]-x[0]), x,
                      x[-1]+np.arange(1, n+1)*(x[-1]-x[-2])]
        if phase == "feed":
            lo, hi = (-4, 4) if axis in "xy" else (-2, 6)
            for _ in range(level):
                mid = (x[:-1]+x[1:])/2
                x = np.sort(np.r_[x, mid[(mid >= lo) & (mid <= hi)]])
        d["mesh"]["lines"][axis] = x.tolist()
    return d


def metrics(f, s):
    from fairbeam.convergence import _refine_min
    if (len(f) != len(s) or len(f) < 3 or not np.isfinite(f).all()
            or not np.isfinite(s).all() or not np.all(np.diff(f) > 0)
            or f[0] > .7e9 or f[-1] < 1.05e9):
        raise ValueError("Incomplete, nonfinite or unordered complex response")
    db = 20*np.log10(np.maximum(abs(s), 1e-15))
    indices = np.flatnonzero((f >= .85e9) & (f <= 1e9))
    if len(indices) < 3:
        raise ValueError("Insufficient samples in the minimum-tracking window")
    k = int(indices[np.argmin(db[indices])])
    fm, depth = _refine_min(f, db, k)
    g = np.interp(.867e9, f, s.real) + 1j*np.interp(.867e9, f, s.imag)
    return {"frequency_hz": fm, "depth_db": depth, "at_867_db": float(20*np.log10(max(abs(g), 1e-15))),
            "window_interior": k not in (indices[0], indices[-1]),
            "passive": bool(np.max(abs(s)**2) <= 1.001), "max_reflected_power": float(np.max(abs(s)**2))}


def compare(left, right):
    if not np.array_equal(left["f"], right["f"]):
        raise ValueError("Frequency axes differ")
    a, b = metrics(left["f"], left["s"]), metrics(right["f"], right["s"])
    changes = {"frequency_pct": abs(b["frequency_hz"]/a["frequency_hz"]-1)*100,
               "depth_db": abs(b["depth_db"]-a["depth_db"]),
               "at_867_db": abs(b["at_867_db"]-a["at_867_db"]),
               "complex_max": float(np.max(abs(right["s"]-left["s"])))}
    passed = (all(changes[k] < limit for k, limit in LIMITS.items())
              and all(r["converged"] is True for r in (left, right))
              and all(m["passive"] and m["window_interior"] for m in (a, b)))
    return {**changes, "passed": bool(passed)}


def run(args):
    from fairbeam.design import build
    from tests.native_gallery_xml import write
    folder = args.out / f"level-{args.level}"
    folder.mkdir()
    states = []

    def record(status):
        states.append({"status": status, "utc": datetime.now(timezone.utc).isoformat()})
        save(folder / "state.json", {"status": status, "history": states})

    record("created")
    source = json.loads((args.out / "source.design.json").read_text(encoding="utf-8"))
    d = design(source, args.phase, args.width, args.level, args.densities, args.air_density)
    save(folder / "design.json", d)
    sim = build(d, {})
    sim.remove_nf2ff_box()
    lines = {a: sim.mesh.GetLines(a).tolist() for a in "xyz"}
    cells = int(np.prod([len(v)-1 for v in lines.values()]))
    if cells > 8_000_000:
        raise ValueError("Case exceeds the eight-million-cell resource limit")
    write(sim, folder / "model.xml")
    save(folder / "settings.json", {"cells": cells, "mesh": lines, "ports": sim.ports,
         "source": sim.excitation, "boundaries": sim.boundaries,
         "design_sha256": digest(folder / "design.json"), "xml_sha256": digest(folder / "model.xml")})
    record("model_built")
    record("solver_started")
    stats = sim.run(str(folder / "raw"), threads=args.threads)
    save(folder / "solver-stats.json", stats)
    record("solver_returned")
    f = np.linspace(.7e9, 1.05e9, 3501)
    port = sim._port_objs[0]
    port.CalcPort(str(folder / "raw"), f)
    s, z = port.uf_ref/port.uf_inc, port.uf_tot/port.if_tot
    m = metrics(f, s)
    if not np.isfinite(z).all():
        raise ValueError("Nonfinite impedance")
    np.savez(folder / "response.npz", frequency_hz=f, s11=s, zin=z)
    np.savetxt(folder / "s11.csv", np.column_stack([f, s.real, s.imag]), delimiter=",",
               header="frequency_Hz,S11_real,S11_imag", comments="", fmt="%.17g")
    record("results_exported")
    valid = m["passive"] and stats.get("converged") is True
    save(folder / "summary.json", {"status": "results_validated" if valid else "results_exported",
         "run": stats, "metrics": m, "response_sha256": digest(folder / "response.npz"),
         "csv_sha256": digest(folder / "s11.csv")})
    if valid:
        record("results_validated")
    return 0 if valid else 2


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--phase", choices=("feed", "boundary", "auto"), default="feed")
    p.add_argument("--width", type=float, choices=(0, 4), default=4, help="Ideal line (0) or full 4 mm tab (4)")
    p.add_argument("--threads", type=int, default=4)
    p.add_argument("--timeout", type=int, default=5400)
    p.add_argument("--densities", type=int, nargs=3, default=(20, 30, 40),
                   help="Three increasing automatic mesh densities (cells per wavelength)")
    p.add_argument("--air-density", type=int, help="Hold the outer air mesh density fixed")
    p.add_argument("--level", type=int, choices=range(3), help=argparse.SUPPRESS)
    args = p.parse_args()
    args.out = args.out.resolve()
    if args.threads < 1 or args.timeout < 1:
        p.error("threads and timeout must be positive")
    if not 0 < args.densities[0] < args.densities[1] < args.densities[2]:
        p.error("densities must be positive and strictly increasing")
    if args.air_density is not None and not 0 < args.air_density <= args.densities[0]:
        p.error("air density must be positive and no greater than the lowest feature density")
    if args.level is not None:
        return run(args)
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / "source.design.json").write_bytes(SOURCE.read_bytes())
    (args.out / "runner.py").write_bytes(Path(__file__).read_bytes())
    from fairbeam import Simulation  # Load the configured native runtime before importing its bindings.
    import openEMS
    import CSXCAD
    manifest = {"evidence_domain": "synthetic", "phase": args.phase, "width_mm": args.width,
        "source_assumption": "Ideal line" if args.width == 0 else "Planar gap source across the existing tab; not a connector",
        "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source_dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)),
        "generator_sha256": digest(Path(__file__)), "source_sha256": digest(SOURCE),
        "implementation_sha256": {name: digest(ROOT / "python/fairbeam" / name)
                                  for name in ("design.py", "automesh.py", "mesh_refinement.py")},
        "host": platform.platform(), "engine": "cpu", "threads": args.threads,
        "openems_version": openEMS.__version__, "csxcad_version": CSXCAD.__version__,
        "criteria": LIMITS, "energy_db": -60, "passivity_power_limit": 1.001,
        "automatic_densities": args.densities if args.phase == "auto" else None,
        "air_density": args.air_density,
        "limits": "No physical, far-field or connector validation; two successive changes required. Different widths are different models.",
        "runs": []}
    responses, steps = [], []
    for level in range(3):
        row = {"level": level, "status": "solver_started", "started_utc": datetime.now(timezone.utc).isoformat()}
        manifest["runs"].append(row)
        save(args.out / "manifest.json", manifest)
        with (args.out / f"level-{level}.log").open("w", encoding="utf-8") as log:
            child = subprocess.Popen([sys.executable, "-m", "tests.blade_feed_study", "--out", str(args.out),
                "--phase", args.phase, "--width", str(args.width), "--threads", str(args.threads), "--level", str(level),
                "--densities", *map(str, args.densities),
                *(["--air-density", str(args.air_density)] if args.air_density is not None else [])],
                cwd=ROOT / "python", stdout=log, stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            try:
                code = child.wait(timeout=args.timeout)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"], capture_output=True, check=False)
                else:
                    child.kill()
                child.wait()
                code = -1
        row.update(status="results_validated" if code == 0 else "interrupted" if code == -1 else "failed",
                   exit_code=code, ended_utc=datetime.now(timezone.utc).isoformat())
        save(args.out / "manifest.json", manifest)
        if code:
            return 2
        data = np.load(args.out / f"level-{level}/response.npz")
        result = json.loads((args.out / f"level-{level}/summary.json").read_text())
        responses.append({"f": data["frequency_hz"], "s": data["s11"], "converged": result["run"]["converged"]})
        if level:
            steps.append(compare(responses[-2], responses[-1]))
        save(args.out / "comparison.json", {"completed": level+1, "steps": steps,
             "two_successive_passes": len(steps) == 2 and all(s["passed"] for s in steps)})
    print(json.dumps(steps, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
