"""Tests and explicit manual FDTD entry point (never run by discovery).

From python/: python -m tests.test_circular_guide_loss --fdtd --out <outside-repo-dir>
Use --mesh 16 --loss none to acquire just one case. Default comparison:
8/12/16 radial intervals, one fixed multigrid layer, serial runs; two
workers total. --analyse-only rereads the retained full-precision spectra.
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

from tests import circular_guide_fixture as fixture
from fairbeam.procutil import popen_group, release_group, terminate_group


def acquire_serial(out, mesh, loss):
    """Fresh native engine per case; a 30-minute cap owns the entire child tree.

    A raw native call cannot be interrupted safely from a Python timer thread.
    Preserve incomplete files, but never analyse them as completed acquisitions.
    """
    out = Path(out).resolve()
    if out.exists():
        raise ValueError(f"acquisition directory already exists: {out}")
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, "-m", "tests.test_circular_guide_loss", "--fdtd",
               "--mesh", str(mesh), "--loss", loss, "--out", str(out), "--worker-case"]
    log_path = out.with_name(out.name + ".log")
    with log_path.open("w", encoding="utf-8") as log:
        proc = popen_group(command, stdout=log, stderr=subprocess.STDOUT,
            cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"})
        try:
            try:
                code = proc.wait(timeout=1800)
            except subprocess.TimeoutExpired:
                terminate_group(proc.pid, grace=0, job=proc.win_job)
                proc.wait(timeout=15)
                raise RuntimeError(f"30-minute case limit reached; incomplete data: {out}") from None
        finally:
            if proc.poll() is None:
                terminate_group(proc.pid, grace=0, job=proc.win_job)
                proc.wait(timeout=15)
            release_group(proc)
    if code:
        raise RuntimeError(f"acquisition failed (exit {code}); see {log_path}")
    return json.loads((out / "report.json").read_text(encoding="utf-8"))


class CircularGuideTests(unittest.TestCase):
    def test_cutoffs_from_independent_bessel_boundary_conditions(self):
        x = fixture.TE11_ROOT
        step = 1e-5
        derivative = (fixture.bessel_j(1, x + step) - fixture.bessel_j(1, x - step)) / (2 * step)
        self.assertAlmostEqual(float(derivative), 0, places=9)
        self.assertAlmostEqual(float(fixture.bessel_j(0, fixture.TM01_ROOT)), 0, places=12)
        self.assertLess(fixture.TE11_ROOT, fixture.TM01_ROOT)

    def test_conductor_loss_matches_numerical_wall_field_integral(self):
        f = np.array([14e9])
        ref = fixture.reference(f, "gold")
        radius, kc = fixture.RADIUS, fixture.TE11_ROOT / fixture.RADIUS
        beta = ref["beta"][0]
        r = np.linspace(0, radius, 10001)
        radial_integral = np.trapezoid(fixture.bessel_j(1, kc * r) ** 2 * r, r)
        power = 2 * np.pi * f[0] * fixture.MU0 * beta / (2 * kc * kc) * np.pi * radial_integral
        wall = radius * np.pi * fixture.bessel_j(1, kc * radius) ** 2 * (1 + (beta / (kc * kc * radius)) ** 2)
        rs = np.sqrt(np.pi * f[0] * fixture.MU0 / fixture.CONDUCTIVITY)
        self.assertAlmostEqual(ref["alpha_c"][0] / (rs * wall / (4 * power)), 1, places=8)

    def test_dielectric_loss_matches_complex_dispersion(self):
        f = fixture.FREQUENCIES
        eps = fixture.EPS_R * (1 - 1j * fixture.TAN_DELTA * fixture.REFERENCE_F / f)
        gamma = np.sqrt((fixture.TE11_ROOT / fixture.RADIUS) ** 2 - (2 * np.pi * f / fixture.C0) ** 2 * eps)
        ref = fixture.reference(f, "dielectric")
        np.testing.assert_allclose(ref["alpha_d"], gamma.real, rtol=2e-6)
        np.testing.assert_allclose(ref["beta"], gamma.imag, rtol=2e-6)

    def test_standing_waves_cancel_without_fitting_or_clipping_attenuation(self):
        beta = fixture.reference(fixture.FREQUENCIES, "none")["beta"]
        gamma = -.0003 + 1j * beta
        z = (np.arange(6)[:, None] + 2) * .005
        u = np.exp(-gamma * z) + (.31 + .13j) * np.exp(gamma * z)
        measured = fixture.propagation(u, beta * 1.004)
        np.testing.assert_allclose(measured, np.tile(gamma, (2, 1)), atol=1e-12)
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            fixture.propagation(u, np.full_like(beta, np.pi / .01))
        with self.assertRaisesRegex(ValueError, "node"):
            fixture.propagation(u * 0, beta)

    def test_fixed_probe_planes_raw_export_and_multigrid_load_limit(self):
        for n in (8, 12, 16):
            sim = fixture.build(n, "none")
            for z in (10, 15, 20, 25, 30, 35):
                self.assertIn(z, sim.mesh.GetLines("z"))
            self.assertAlmostEqual(sim.mesh.GetLines("y")[-1], 2 * np.pi)
            with self.assertRaisesRegex(ValueError, "Cartesian"):
                sim.to_bundle()
        for n, levels in ((8, 2), (16, 3), (32, 4)):
            with self.assertRaises(ValueError):
                fixture.build(n, "none", levels)

    def test_halfspace_mapping_is_resistive_not_an_undisclosed_fit(self):
        sigma = fixture.CONDUCTIVITY / 4
        gamma = np.sqrt(1j * 2 * np.pi * 14e9 * fixture.MU0 * sigma)
        sheet_y = 2 * sigma / gamma * np.tanh(gamma * fixture.SHEET_M / 2)
        bulk_r = np.sqrt(np.pi * 14e9 * fixture.MU0 / fixture.CONDUCTIVITY)
        self.assertAlmostEqual((1 / sheet_y).real / bulk_r, 1, places=8)
        sim = fixture.build(16, "gold")
        self.assertEqual(sim.materials["one_sided_wall_surrogate"]["conductivity"], sigma)
        control = fixture.build(16, "native_sheet")
        self.assertEqual(control.materials["native_sheet"]["conductivity"], fixture.CONDUCTIVITY)

    def test_coarse_stop_failure_prevents_validation_despite_matching_meshes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for n in (8, 12, 16):
                for loss in fixture.LOSSES:
                    ref = fixture.reference(fixture.FREQUENCIES, loss)
                    gamma = .0002 + ref["alpha"] + 1j * ref["beta"]
                    z = (np.arange(6)[:, None] + 2) * .005
                    dest = root / f"n{n}-{loss}"
                    dest.mkdir()
                    np.savez(dest / "data.npz", f=fixture.FREQUENCIES, u=np.exp(-gamma * z))
                    meta = {"radial_cells": n, "loss": loss, "multigrid_levels": 1,
                            "compute_workers": 2, "cells": 1000, "dt_s": 1e-12,
                            "run": {"converged": n != 8, "threads": 1}}
                    (dest / "report.json").write_text(json.dumps(meta), encoding="utf-8")
            rows = fixture.analyse(root, [8, 12, 16])
            fine = [r for r in rows if r["radial_cells"] == 16]
            self.assertTrue(all(r["matches"] and r["mesh_pair_passes"] for r in fine))
            self.assertTrue(all(not r["validated_scope"] for r in fine))

    def test_matching_total_cannot_hide_a_failed_conductor_component(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for n in (8, 12, 16):
                for loss in fixture.LOSSES:
                    ref = fixture.reference(fixture.FREQUENCIES, loss)
                    gamma = .0002 + ref["alpha_d"] + .93 * ref["alpha_c"] + 1j * ref["beta"]
                    z = (np.arange(6)[:, None] + 2) * .005
                    dest = root / f"n{n}-{loss}"
                    dest.mkdir()
                    np.savez(dest / "data.npz", f=fixture.FREQUENCIES, u=np.exp(-gamma * z))
                    meta = {"radial_cells": n, "loss": loss, "multigrid_levels": 1,
                            "compute_workers": 2, "cells": 1000, "dt_s": 1e-12,
                            "run": {"converged": True, "threads": 1}}
                    (dest / "report.json").write_text(json.dumps(meta), encoding="utf-8")
            rows = fixture.analyse(root, [8, 12, 16])
            fine = {r["loss"]: r for r in rows if r["radial_cells"] == 16}
            self.assertTrue(fine["both"]["matches"] and fine["both"]["mesh_pair_passes"])
            self.assertTrue(fine["dielectric"]["validated_scope"])
            self.assertFalse(fine["gold"]["validated_scope"])
            self.assertFalse(fine["both"]["validated_scope"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fdtd", action="store_true")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--meshes", default="8,12,16")
    parser.add_argument("--mesh", type=int)
    parser.add_argument("--loss", choices=fixture.LOSSES)
    parser.add_argument("--analyse-only", action="store_true")
    parser.add_argument("--worker-case", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.mesh is not None or args.loss is not None:
        if not args.fdtd or args.mesh is None or args.loss is None or args.analyse_only:
            parser.error("one-case acquisition needs --fdtd --mesh N --loss CASE")
        if args.mesh < 8 or args.mesh > 24 or args.mesh % 4:
            parser.error("one-case mesh must be a multiple of four in 8..24")
        run = fixture.acquire if args.worker_case else acquire_serial
        print(json.dumps(run(args.out, args.mesh, args.loss), indent=2))
        return
    if args.worker_case:
        parser.error("internal worker requires a single mesh and loss case")
    meshes = [int(v) for v in args.meshes.split(",")]
    if len(meshes) < 3 or meshes != sorted(set(meshes)) or any(n < 8 or n > 24 or n % 4 for n in meshes):
        parser.error("use three or more increasing multiples of four in 8..24")
    if not args.analyse_only:
        if not args.fdtd:
            parser.error("explicit --fdtd required to run the solver")
        for n in meshes:
            for loss in fixture.LOSSES:
                print(json.dumps(acquire_serial(args.out / f"n{n}-{loss}", n, loss), indent=2), flush=True)
    print(json.dumps(fixture.analyse(args.out, meshes), indent=2))


if __name__ == "__main__":
    if len(sys.argv) == 1:
        unittest.main()
    else:
        main()
