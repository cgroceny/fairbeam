"""Single-gap vs signed series-group dipole control, without using the gallery.

Run from python/: python examples/grouped_dipole_equivalence.py --out <outside-repo-dir>
Use --prepare-only to inspect the common mesh without starting FDTD. The two CPU
runs are serial and share a 540-second wall-time budget; a timeout is an error,
not evidence of convergence. This is a port equivalence control, not a mesh study.
"""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fairbeam import Simulation
from fairbeam.procutil import popen_group, release_group, terminate_group

FREQUENCIES = np.array([1.8, 2.2, 2.5, 2.8, 3.2]) * 1e9
TIME_STEP = 5e-13


def build(case):
    sim = Simulation(1.5e9, 3.5e9, boundaries=["PML_8"] * 6,
                     end_criteria_db=-60, max_timesteps=40000)
    sim.fdtd.SetTimeStep(TIME_STEP)
    # Own fixed geometry: 58 mm PEC strip, 1 mm wide, 1 mm central gap.
    arm = sim.metal("arms")
    arm.AddBox([-0.5, 0, -29], [0.5, 0, -0.5], priority=10)
    arm.AddBox([-0.5, 0, 0.5], [0.5, 0, 29], priority=10)
    if case == "single":
        sim.lumped_port(1, 73, [-0.5, 0, -0.5], [0.5, 0, 0.5], "z")
    elif case == "series":
        sim.lumped_port(1, 73, [-0.5, 0, -0.5], [0.5, 0, 0], "z", group={
            "connection": "series", "members": [{"start": [-0.5, 0, 0.5],
            "stop": [0.5, 0, 0], "direction": "z", "polarity": -1}]})
    else:
        raise ValueError(case)
    sim.mesh.AddLine("x", [-80, -0.5, 0, 0.5, 80])
    sim.mesh.AddLine("y", [-80, -0.5, 0, 0.5, 80])
    sim.mesh.AddLine("z", np.r_[-110, np.arange(-29, 29.01, 1),
                              -0.5, -0.25, 0, 0.25, 0.5, 110])
    sim.smooth_mesh(4, 1.4)
    return sim


def mesh_record(sim):
    lines = [np.asarray(sim.mesh.GetLines(a), dtype="<f8") for a in "xyz"]
    dims = [len(v) - 1 for v in lines]
    minimum = [float(np.min(np.diff(v))) for v in lines]
    cfl = sim.unit / (299792458 * np.sqrt(np.sum(1 / np.square(minimum))))
    if TIME_STEP > cfl:
        raise ValueError("requested time step exceeds the vacuum CFL bound")
    return {"intervals": dims, "cells": int(np.prod(dims)), "min_cell_mm": minimum,
            "mesh_sha256": hashlib.sha256(b"".join(v.tobytes() for v in lines)).hexdigest(),
            "timestep_s": TIME_STEP, "vacuum_cfl_s": float(cfl)}


def run_case(case, out, threads):
    sim = build(case)
    stats = sim.run(str(out / case), threads=threads, echo=True)
    port = sim._port_objs[0]
    port.CalcPort(sim.sim_path, FREQUENCIES)
    zin = port.uf_tot / port.if_tot
    s11 = port.uf_ref / port.uf_inc
    import openEMS
    record = {"runtime": openEMS.__version__, "mesh": mesh_record(sim), "run": stats,
              "frequency_hz": FREQUENCIES.tolist(), "zin_re": zin.real.tolist(),
              "zin_im": zin.imag.tolist(), "s11_re": s11.real.tolist(), "s11_im": s11.imag.tolist()}
    (out / (case + ".json")).write_text(json.dumps(record, indent=2), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--threads", type=int, choices=range(1, 5), default=4)
    ap.add_argument("--prepare-only", action="store_true")
    ap.add_argument("--case", choices=["single", "series"], help=argparse.SUPPRESS)
    args = ap.parse_args()
    meshes = [mesh_record(build(case)) for case in ("single", "series")]
    if meshes[0] != meshes[1]:
        raise ValueError("the two cases do not have the same mesh/time step")
    print(json.dumps(meshes[0]), flush=True)
    if args.prepare_only:
        return
    if args.out is None:
        ap.error("--out is required for FDTD; use a directory outside the repository")
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    if args.case:
        run_case(args.case, out, args.threads)
        return
    deadline = time.monotonic() + 540
    for case in ("single", "series"):
        with (out / (case + ".log")).open("w", encoding="utf-8") as log:
            command = [sys.executable, str(Path(__file__).resolve()), "--case", case,
                       "--out", str(out), "--threads", str(args.threads)]
            proc = popen_group(command, stdout=log, stderr=subprocess.STDOUT,
                              creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
            try:
                code = proc.wait(timeout=max(1, deadline - time.monotonic()))
                if code:
                    raise subprocess.CalledProcessError(code, command)
            finally:
                # The Windows venv executable is a launcher: stop its owned tree,
                # not just the launcher PID, on timeout or interruption.
                if proc.poll() is None:
                    terminate_group(proc.pid, grace=0, job=proc.win_job)
                    proc.wait()
                release_group(proc)
        print(case + " finished", flush=True)
    a, b = [json.loads((out / (case + ".json")).read_text(encoding="utf-8"))
            for case in ("single", "series")]
    if a["mesh"] != b["mesh"] or a["run"]["timestep_s"] != b["run"]["timestep_s"]:
        raise ValueError("actual mesh/time steps differ")
    print("f/GHz | Zin single/ohm | Zin series/ohm | abs delta Zin/ohm | delta abs S11")
    rows = []
    for i, f in enumerate(FREQUENCIES):
        za, zb = [complex(r["zin_re"][i], r["zin_im"][i]) for r in (a, b)]
        sa, sb = [complex(r["s11_re"][i], r["s11_im"][i]) for r in (a, b)]
        rows.append({"frequency_hz": float(f), "delta_zin_abs_ohm": abs(zb - za),
                     "delta_zin_relative": abs(zb - za) / abs(za),
                     "delta_s11_abs": abs(sb) - abs(sa)})
        print(f"{f/1e9:.2f} | {za.real:.6f}{za.imag:+.6f}j | {zb.real:.6f}{zb.imag:+.6f}j | "
              f"{abs(zb-za):.6f} | {abs(sb)-abs(sa):+.8f}")
    (out / "comparison.json").write_text(json.dumps({"mesh_converged": False,
        "ringdown_finished": all(r["run"]["converged"] for r in (a, b)), "rows": rows}, indent=2),
        encoding="utf-8")


if __name__ == "__main__":
    main()
