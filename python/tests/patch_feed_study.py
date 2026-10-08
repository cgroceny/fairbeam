"""Fixed square-port footprint: four refinements of the patch example.

python -m tests.patch_feed_study --out <new-directory>

This is a different, explicitly finite lumped-source model from the tutorial's
zero-width line feed. It does not represent a coaxial connector. The footprint
stays 1 x 1 mm while feed_cells and sub_cells increase together: 2, 4, 8, 16.
Source, boundaries, outer box, materials and geometry stay fixed. No NF2FF.
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
import platform
import subprocess
import sys

import numpy as np

from fairbeam.model import load_model, resolve_params
from tests.feed_resolution_study import save, digest, ROOT
from tests.native_gallery_xml import write as write_native_xml


def model(level):
    module = load_model(ROOT / "python/models/patch_antenna.py")
    cells = 2 ** (level + 1)
    params = resolve_params(module.PARAMS, {"feed_width": 1, "feed_cells": cells,
                                           "sub_cells": cells, "max_timesteps": 350000})
    sim = module.build(params)
    sim.remove_nf2ff_box()
    return sim, params


def run(level, out):
    folder = out / f"level-{level}"
    folder.mkdir()
    sim, params = model(level)
    save(folder / "settings.json", {"params": params, "ports": sim.ports,
        "mesh": {a: sim.mesh.GetLines(a).tolist() for a in "xyz"}, "boundaries": sim.boundaries,
        "source": sim.excitation, "cells": int(np.prod([len(sim.mesh.GetLines(a)) - 1 for a in "xyz"])),
        "analytic_dt_s": sim.cfl_timestep(), "model_sha256": digest(ROOT / "python/models/patch_antenna.py")})
    write_native_xml(sim, folder / "model.xml")
    stats = sim.run(str(folder / "raw"), threads=4)
    frequency = np.unique(np.r_[np.linspace(1e9, 3e9, 801), np.linspace(2.40e9, 2.52e9, 2401)])
    port = sim._port_objs[0]
    port.CalcPort(str(folder / "raw"), frequency)
    s11, zin = port.uf_ref / port.uf_inc, port.uf_tot / port.if_tot
    finite = bool(np.isfinite(s11).all() and np.isfinite(zin).all())
    if not finite:
        save(folder / "summary.json", {"run": stats, "finite": False})
        return 2
    np.savez(folder / "response.npz", frequency_hz=frequency, s11=s11, zin=zin)
    index = int(np.argmin(abs(s11)))
    passive = bool(abs(s11).max() <= 1.001)
    save(folder / "summary.json", {"run": stats, "finite": finite, "passive": passive,
        "min_frequency_hz": float(frequency[index]), "min_s11_db": float(20 * np.log10(abs(s11[index]))),
        "minimum_in_dense_window": bool(2.40e9 < frequency[index] < 2.52e9),
        "response_sha256": digest(folder / "response.npz")})
    return 0 if stats.get("converged") and passive else 2


def compare(out):
    rows = []
    previous = None
    for level in range(4):
        folder = out / f"level-{level}"
        if not (folder / "response.npz").exists():
            break
        data = np.load(folder / "response.npz")
        stats = json.loads((folder / "summary.json").read_text())
        row = {"level": level, "feed_cells": 2 ** (level + 1), **stats}
        if previous is not None:
            assert np.array_equal(previous[0]["frequency_hz"], data["frequency_hz"])
            df = 100 * (stats["min_frequency_hz"] / previous[1]["min_frequency_hz"] - 1)
            ds = stats["min_s11_db"] - previous[1]["min_s11_db"]
            difference = float(np.max(abs(data["s11"] - previous[0]["s11"])))
            row["change"] = {"frequency_pct": df, "depth_db": ds, "complex_max_abs": difference,
                "within_tolerances": bool(abs(df) < .5 and abs(ds) < 1 and difference < .01
                                          and stats["run"]["converged"] and previous[1]["run"]["converged"]
                                          and stats["passive"] and previous[1]["passive"]
                                          and stats["minimum_in_dense_window"] and previous[1]["minimum_in_dense_window"])}
        rows.append(row)
        previous = data, stats
    save(out / "comparison.json", {"rows": rows, "complete": len(rows) == 4,
        "two_successive_refinements_pass": bool(len(rows) == 4 and
            all(r.get("change", {}).get("within_tolerances", False) for r in rows[-2:]))})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--level", type=int, choices=range(4), help=argparse.SUPPRESS)
    args = parser.parse_args()
    out = args.out.resolve()
    if args.level is not None:
        return run(args.level, out)
    out.mkdir(parents=True, exist_ok=False)
    manifest = {"source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                "source_dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)),
                "generator_sha256": digest(Path(__file__)), "host": platform.platform(), "threads": 4, "runs": []}
    for level in range(4):
        record = {"level": level, "status": "solver_started", "started_utc": datetime.now(timezone.utc).isoformat()}
        manifest["runs"].append(record)
        save(out / "manifest.json", manifest)
        with (out / f"level-{level}.log").open("w", encoding="utf-8") as log:
            proc = subprocess.Popen([sys.executable, "-m", "tests.patch_feed_study", "--out", str(out), "--level", str(level)],
                                    cwd=ROOT / "python", stdout=log, stderr=subprocess.STDOUT)
            try:
                code = proc.wait(timeout=900)
            except subprocess.TimeoutExpired:
                proc.kill()  # Solver runs within this owned Python process.
                proc.wait()
                code = -1
        record.update(status="results_validated" if code == 0 else "interrupted" if code == -1 else "failed",
                      exit_code=code, ended_utc=datetime.now(timezone.utc).isoformat())
        save(out / "manifest.json", manifest)
        compare(out)
        print(level, record["status"], flush=True)
        if code:
            return code
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
