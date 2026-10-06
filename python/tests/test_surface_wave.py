r"""Explicit grounded-surface-wave FDTD study (ordinary discovery is pure).

python -m tests.test_surface_wave --fdtd --out C:\Temp\surface-waves
Default: twelve mode/thickness cases, three meshes, serial four-thread runs.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

from tests import surface_wave_fixture as fixture
from fairbeam.procutil import popen_group, release_group, terminate_group


def acquire_serial(out, mesh, mode, ratio, air_decays=6):
    out = Path(out).resolve()
    if out.exists():
        raise ValueError(f"acquisition directory exists: {out}")
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-m", "tests.test_surface_wave", "--fdtd", "--mesh", str(mesh),
           "--mode", mode, "--ratio", str(ratio), "--air-decays", str(air_decays),
           "--out", str(out), "--worker-case"]
    with out.with_name(out.name + ".log").open("w", encoding="utf-8") as log:
        proc = popen_group(cmd, stdout=log, stderr=subprocess.STDOUT,
            cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"})
        try:
            try:
                code = proc.wait(timeout=1800)
            except subprocess.TimeoutExpired:
                terminate_group(proc.pid, grace=0, job=proc.win_job)
                proc.wait(timeout=15)
                raise RuntimeError(f"30-minute case limit; incomplete data: {out}") from None
        finally:
            if proc.poll() is None:
                terminate_group(proc.pid, grace=0, job=proc.win_job)
                proc.wait(timeout=15)
            release_group(proc)
    if code:
        raise RuntimeError(f"acquisition failed; see {out.name}.log")
    return json.loads((out / "report.json").read_text(encoding="utf-8"))


class SurfaceWaveTests(unittest.TestCase):
    def test_ground_and_interface_boundary_conditions(self):
        for mode, ratio in fixture.CASES:
            beta, h, q = fixture.parameters(mode, ratio, fixture.FREQUENCIES)
            k0 = 2 * np.pi * fixture.FREQUENCIES / fixture.C0
            d = ratio * fixture.C0 / fixture.F0
            np.testing.assert_allclose(h*h + q*q, (fixture.EPS_R-1)*k0*k0, rtol=1e-12)
            self.assertTrue(np.all(beta > k0) and np.all(beta < np.sqrt(fixture.EPS_R)*k0))
            if mode.startswith("TM"):
                np.testing.assert_allclose(-h*np.sin(h*d)/fixture.EPS_R,
                                          -q*np.cos(h*d), atol=1e-10)
            else:
                np.testing.assert_allclose(h*np.cos(h*d), -q*np.sin(h*d), atol=1e-10)

    def test_cutoff_branches_do_not_silently_select_another_mode(self):
        for mode, ratio in (("TE1", .1), ("TM1", .3)):
            with self.assertRaisesRegex(ValueError, "cutoff"):
                fixture.parameters(mode, ratio, fixture.F0)
        self.assertTrue(np.isfinite(fixture.parameters("TM0", .01, fixture.F0)[0]))
        for mode, ratio, f in (("TE0", .5, 1e10), ("TM0", 0, 1e10), ("TM0", .1, -1)):
            with self.assertRaises(ValueError):
                fixture.parameters(mode, ratio, f)

    def test_exact_interface_and_phase_planes_with_uniform_transverse_symmetry(self):
        for mode in fixture.MODES:
            for n in (8, 12, 16):
                sim = fixture.build(n, mode, .6)
                for x in (24, 28, 32, 36, 40, 44):
                    self.assertIn(x, sim.mesh.GetLines("x"))
                self.assertIn(.6*fixture.C0/fixture.F0/sim.unit, sim.mesh.GetLines("z"))
                self.assertIn(0., sim.mesh.GetLines("z"))
                self.assertLess(sim.mesh.GetLines("z")[0], 0.)
                self.assertEqual(len(sim.mesh.GetLines("y")), 5)
        for n, air in ((7, 6), (8, 5), (36, 6)):
            with self.assertRaises(ValueError):
                fixture.build(n, "TM0", .3, air)
        with self.assertRaisesRegex(ValueError, "cell budget"):
            fixture.build(8, "TM0", .001)

    def test_failed_coarse_energy_stop_prevents_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            root, mode, ratio = Path(folder), "TM0", .3
            beta, _, _ = fixture.parameters(mode, ratio, fixture.FREQUENCIES)
            z = np.arange(6, 12)[:, None] * .004
            u = np.exp(-(.0001 + 1j*beta)*z) + .1j*np.exp((.0001+1j*beta)*z)
            for n in (8, 12, 16):
                dest = root / fixture.case_name(mode, ratio) / f"n{n}"
                dest.mkdir(parents=True)
                np.savez(dest / "data.npz", f=fixture.FREQUENCIES, u=u)
                meta = {"layer_cells": n, "mode": mode, "ratio": ratio, "air_decays": 6,
                    "fixture_sha256": "synthetic-test", "cells": 100, "dt_s": 1e-12,
                    "run": {"threads": 4, "converged": n != 8}}
                (dest / "report.json").write_text(json.dumps(meta), encoding="utf-8")
            rows = fixture.analyse(root, [8, 12, 16], [(mode, ratio)])
            self.assertTrue(rows[-1]["matches"] and rows[-1]["mesh_pair_passes"])
            self.assertFalse(rows[-1]["validated_scope"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fdtd", action="store_true")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--meshes", default="8,12,16")
    parser.add_argument("--mesh", type=int)
    parser.add_argument("--mode", choices=fixture.MODES)
    parser.add_argument("--ratio", type=float)
    parser.add_argument("--air-decays", type=float, default=6)
    parser.add_argument("--analyse-only", action="store_true")
    parser.add_argument("--worker-case", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    partial = any(v is not None for v in (args.mesh, args.mode, args.ratio))
    if partial:
        if not args.fdtd or args.analyse_only or any(v is None for v in (args.mesh, args.mode, args.ratio)):
            parser.error("one-case acquisition requires --fdtd --mesh --mode --ratio")
        run = fixture.acquire if args.worker_case else acquire_serial
        meta = run(args.out, args.mesh, args.mode, args.ratio, args.air_decays)
        print(json.dumps({k:v for k,v in meta.items() if k != "run"} | {
            "energy_stopped": meta["run"].get("converged"), "seconds": meta["run"].get("wall_time_s")}, indent=2))
        return
    if args.worker_case or args.air_decays != 6:
        parser.error("internal worker or air-domain control requires a single case")
    meshes = [int(v) for v in args.meshes.split(",")]
    if len(meshes) < 3 or meshes != sorted(set(meshes)) or any(n < 8 or n > 32 or n % 4 for n in meshes):
        parser.error("three increasing multiples of four in 8..32")
    if not args.analyse_only:
        if not args.fdtd:
            parser.error("explicit --fdtd required")
        for mode, ratio in fixture.CASES:
            for n in meshes:
                meta = acquire_serial(args.out / fixture.case_name(mode, ratio) / f"n{n}", n, mode, ratio)
                print(json.dumps({"mode":mode, "ratio":ratio, "mesh":n,
                    "energy_stopped":meta["run"].get("converged"),
                    "seconds":meta["run"].get("wall_time_s")}), flush=True)
    print(json.dumps(fixture.analyse(args.out, meshes), indent=2))


if __name__ == "__main__":
    if len(sys.argv) == 1:
        unittest.main()
    else:
        main()
