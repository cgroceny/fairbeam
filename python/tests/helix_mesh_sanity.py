"""Sequential coarse CPU sanity comparison of the reference and current helix meshes.

Run from python/: python -m tests.helix_mesh_sanity --reference-revision origin/main
Solver scratch output is temporary and removed after each run. This is not convergence validation.
"""
import argparse
import json
import subprocess
import sys
import tempfile
import types

import fairbeam
import fairbeam.automesh
from fairbeam.model import load_model, resolve_params


def compare(revision):
    current = fairbeam.automesh
    reference = types.ModuleType("fairbeam.automesh")
    reference.__package__ = "fairbeam"
    source = subprocess.check_output(["git", "show", f"{revision}:python/fairbeam/automesh.py"], text=True)
    exec(compile(source, "<reference automesh>", "exec"), reference.__dict__)
    rows = {}
    try:
        for name, mesher in (("before", reference), ("after", current)):
            sys.modules["fairbeam.automesh"] = fairbeam.automesh = mesher
            module = load_model("models/helix_axial.py")
            sim = module.build(resolve_params(module.PARAMS, {"cpw": 20}))
            sim.end_criteria_db = -30
            sim.fdtd.SetEndCriteria(1e-3)
            with tempfile.TemporaryDirectory(prefix="fairbeam-helix-", dir="/tmp") as scratch:
                stats = sim.run(scratch, threads=4, engine="cpu", echo=False)
                result = sim.evaluate(n_freq=121, pattern_freqs=[2.4e9], theta_step=5, phi_step=10,
                                      efficiency_points=0)
                ff = result["farfield"][0]
                row = {"cells": sim.mesh_report["total_cells"], "stats": {k: stats[k] for k in ("timesteps", "converged", "final_energy_bound_db", "threads", "engine")},
                       "dmax_dbi": ff["dmax_dbi"], "boresight_ar_db": ff["cp"]["boresight"]["axial_ratio_db"],
                       "r_in_ohm": result["ports"]["1"]["zin_re"][60]}
                rows[name] = row
                print(json.dumps({name: row}), flush=True)
    finally:
        sys.modules["fairbeam.automesh"] = fairbeam.automesh = current
    return rows


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference-revision", required=True)
    compare(parser.parse_args().reference_revision)
