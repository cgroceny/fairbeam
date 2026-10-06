r"""Annular TE11 fixture tests and opt-in serial FDTD entry point.

python -m tests.test_coax_cutoff --fdtd --out C:\Temp\coax-cutoff
Default meshes 8/12/16; no FDTD during unittest discovery.
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

from tests import coax_cutoff_fixture as fixture
from fairbeam.procutil import popen_group, release_group, terminate_group


def acquire_serial(out, mesh):
    out = Path(out).resolve()
    if out.exists():
        raise ValueError(f"acquisition directory exists: {out}")
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-m", "tests.test_coax_cutoff", "--fdtd", "--mesh", str(mesh),
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


class CoaxCutoffTests(unittest.TestCase):
    def test_y_series_wronskian_and_differential_equation(self):
        x = np.linspace(.35, 1.8, 41)
        j, y = fixture.bessel_j(1, x), fixture.bessel_y(1, x)
        jp, yp = fixture.derivative("j", x), fixture.derivative("y", x)
        np.testing.assert_allclose(j * yp - jp * y, 2 / (np.pi * x), rtol=1e-12)
        step = 1e-4
        ypp = (fixture.bessel_y(1, x + step) - 2 * y + fixture.bessel_y(1, x - step)) / step ** 2
        np.testing.assert_allclose(ypp + yp / x + (1 - 1 / x ** 2) * y, 0, atol=1e-5)
        for value in (0, -1, float("nan"), 4):
            with self.assertRaises(ValueError):
                fixture.bessel_y(1, value)

    def test_both_neumann_walls_and_independent_rayleigh_quotient(self):
        for r in (fixture.INNER, fixture.OUTER):
            dr = 1e-9
            dh = (fixture.radial_h(r + dr) - fixture.radial_h(r - dr)) / (2 * dr)
            self.assertAlmostEqual(float(dh), 0, places=5)
        r = np.linspace(fixture.INNER, fixture.OUTER, 10001)
        h = fixture.radial_h(r)
        self.assertTrue(np.all(h > 0), "the first radial TE11 mode has no internal node")
        hp = np.gradient(h, r, edge_order=2)
        quotient = np.trapezoid(r * hp ** 2 + h ** 2 / r, r) / np.trapezoid(r * h ** 2, r)
        self.assertAlmostEqual(float(quotient / fixture.KC ** 2), 1, places=7)
        # Independent radial ODE shooting, no Bessel functions or fitted fields.
        def outer_slope(kc_a):
            step = (fixture.OUTER - fixture.INNER) / 4000
            radius, value, slope = fixture.INNER, 1., 0.
            kc = kc_a / fixture.INNER
            def rhs(r, h, dh):
                return dh, -dh / r - (kc * kc - 1 / r ** 2) * h
            for _ in range(4000):
                h1, d1 = rhs(radius, value, slope)
                h2, d2 = rhs(radius + step/2, value + step*h1/2, slope + step*d1/2)
                h3, d3 = rhs(radius + step/2, value + step*h2/2, slope + step*d2/2)
                h4, d4 = rhs(radius + step, value + step*h3, slope + step*d3)
                value += step * (h1 + 2*h2 + 2*h3 + h4) / 6
                slope += step * (d1 + 2*d2 + 2*d3 + d4) / 6
                radius += step
            return slope
        self.assertLess(abs(outer_slope(fixture.KC * fixture.INNER)), 1e-7)
        self.assertGreater(abs(outer_slope(.45)), 1)

    def test_annulus_and_all_exact_planes_without_gallery_export(self):
        for n in (8, 12, 16):
            sim = fixture.build(n)
            for plane in (6, 9, 12, 15, 18, 21):
                self.assertIn(plane, sim.mesh.GetLines("z"))
            self.assertGreater(sim.mesh.GetLines("x")[0], 0)
            self.assertIn(fixture.INNER / sim.unit, sim.mesh.GetLines("x"))
            self.assertIn(fixture.OUTER / sim.unit, sim.mesh.GetLines("x"))
            with self.assertRaisesRegex(ValueError, "Cartesian"):
                sim.to_bundle()
        for n in (True, 7, 10, 28):
            with self.assertRaises(ValueError):
                fixture.build(n)

    def test_mesh_and_energy_failures_do_not_validate_matching_cutoffs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for n in (8, 12, 16):
                gamma = .0001 + 1j * fixture.beta_reference()
                z = np.arange(2, 8)[:, None] * .003
                dest = root / f"n{n}"
                dest.mkdir()
                u = np.exp(-gamma * z) + .15j * np.exp(gamma * z)
                np.savez(dest / "data.npz", f=fixture.FREQUENCIES, u=u)
                (dest / "report.json").write_text(json.dumps({"radial_cells": n, "cells": 100,
                    "dt_s": 1e-12, "fixture_sha256": "synthetic-test",
                    "run": {"threads": 4, "converged": n != 8}}), encoding="utf-8")
            rows = fixture.analyse(root, [8, 12, 16])
            self.assertTrue(rows[-1]["matches"] and rows[-1]["mesh_pair_passes"])
            self.assertFalse(rows[-1]["validated_scope"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fdtd", action="store_true")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--meshes", default="8,12,16")
    parser.add_argument("--mesh", type=int)
    parser.add_argument("--analyse-only", action="store_true")
    parser.add_argument("--worker-case", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.mesh is not None:
        if not args.fdtd or args.analyse_only or args.mesh < 8 or args.mesh > 24 or args.mesh % 4:
            parser.error("single acquisition needs --fdtd --mesh in 8..24, multiple of four")
        print(json.dumps((fixture.acquire if args.worker_case else acquire_serial)(args.out, args.mesh), indent=2))
        return
    if args.worker_case:
        parser.error("internal worker requires a single mesh")
    meshes = [int(v) for v in args.meshes.split(",")]
    if len(meshes) < 3 or meshes != sorted(set(meshes)) or any(n < 8 or n > 24 or n % 4 for n in meshes):
        parser.error("three increasing meshes in 8..24, multiples of four")
    if not args.analyse_only:
        if not args.fdtd:
            parser.error("explicit --fdtd required")
        for n in meshes:
            print(json.dumps(acquire_serial(args.out / f"n{n}", n), indent=2), flush=True)
    print(json.dumps(fixture.analyse(args.out, meshes), indent=2))


if __name__ == "__main__":
    if len(sys.argv) == 1:
        unittest.main()
    else:
        main()
