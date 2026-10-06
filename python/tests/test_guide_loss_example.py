"""Independent weak-loss checks and the fixture's comparison invariants."""
import unittest
import runpy
import json
import tempfile
from pathlib import Path

import numpy as np

from fairbeam.model import load_model, resolve_params

EXAMPLE = Path(__file__).resolve().parents[1] / "examples/rectangular_guide_loss.py"


class GuideFixtureTests(unittest.TestCase):
    def setUp(self):
        self.model = load_model(EXAMPLE)
        self.values = resolve_params(self.model.PARAMS, {})

    def test_two_lengths_keep_transverse_mesh_and_longitudinal_spacing(self):
        short = self.model.build(self.values)
        long = self.model.build(self.values | {"length_sections": 3})
        for axis in "xy":
            np.testing.assert_array_equal(short.mesh.GetLines(axis), long.mesh.GetLines(axis))
        np.testing.assert_allclose(np.diff(short.mesh.GetLines("z")),
                                   np.diff(long.mesh.GetLines("z"))[0], rtol=1e-12)
        for sim, length in ((short, 30), (long, 90)):
            self.assertEqual(sim.ports[1]["stop"][2] - sim.ports[0]["stop"][2], length)
            for port in sim.ports:
                self.assertIn(port["start"][2], sim.mesh.GetLines("z"))
                self.assertIn(port["stop"][2], sim.mesh.GetLines("z"))

    def test_dielectric_loss_agrees_with_complex_dispersion(self):
        f = np.array([14.5e9, 15e9, 15.5e9])
        ref = self.model.analytical(f, self.values | {"wall_sigma": 0})
        k0 = 2 * np.pi * f / 299792458
        eps = 2.08 * (1 - 1j * .0004 * 15e9 / f)
        gamma = np.sqrt((np.pi / .0107) ** 2 - k0 ** 2 * eps)
        np.testing.assert_allclose(ref["alpha_d"], gamma.real, rtol=1e-6)
        np.testing.assert_allclose(ref["beta"], gamma.imag, rtol=1e-6)

    def test_conductor_reference_agrees_with_wall_field_integral(self):
        f = np.array([15e9])
        ref = self.model.analytical(f, self.values)
        a, b, mu0 = .0107, .0043, 4e-7 * np.pi
        kc, beta = np.pi / a, ref["beta"][0]
        x = np.linspace(0, a, 10001)
        ht_squared = np.cos(kc * x) ** 2 + (beta / kc * np.sin(kc * x)) ** 2
        boundary_integral = 2 * np.trapezoid(ht_squared, x) + 2 * b
        power = (2 * np.pi * f[0]) * mu0 * beta * a * b / (4 * kc ** 2)
        surface_r = np.sqrt(np.pi * f[0] * mu0 / 5.8e7)
        attenuation = surface_r * boundary_integral / (4 * power)
        self.assertAlmostEqual(ref["alpha_c"][0] / attenuation, 1, places=8)

    def test_invalid_mode_band_or_fractional_sections_are_refused(self):
        for values in ({"mode": "TM11"}, {"mode": "TE00"}, {"f_min": 8},
                       {"f_max": 14}, {"length_sections": 1.5}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.model.build(self.values | values)

    def test_one_sided_mapping_matches_resistive_halfspace_limit(self):
        p = self.values | {"wall_model": "halfspace"}
        sigma = self.model.sheet_conductivity(p)
        f, mu0 = 15e9, 4e-7 * np.pi
        gamma = np.sqrt(1j * 2 * np.pi * f * mu0 * sigma)
        admittance = 2 * sigma / gamma * np.tanh(gamma * p["sheet_thickness"] * 1e-3 / 2)
        halfspace_r = np.sqrt(np.pi * f * mu0 / p["wall_sigma"])
        self.assertAlmostEqual((1 / admittance).real / halfspace_r, 1, places=8)
        # A thin film is outside this mapping's scope, even if it can be meshed.
        with self.assertRaisesRegex(ValueError, "skin depths"):
            self.model.build(p | {"sheet_thickness": .001})
        sim = self.model.build(p)
        self.assertEqual(sim.materials["one_sided_wall_surrogate"]["conductivity"], sigma)

    def test_length_analysis_selects_branch_without_fitting_loss(self):
        propagation = runpy.run_path(str(EXAMPLE.with_name("guide_loss_compare.py")))["propagation"]
        beta = np.linspace(330, 360, 201)
        gamma = -.001 + 1j * beta  # diagnostic gain bias must remain negative
        short, long = np.exp(-gamma * .03), np.exp(-gamma * .09)
        measured = propagation(short, long, .06, beta * 1.005)
        np.testing.assert_allclose(measured, gamma, atol=1e-12)
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            propagation(short, long, .06, beta + np.pi / .06)

    def test_failed_coarse_energy_cannot_be_hidden_by_two_matching_mesh_pairs(self):
        compare = runpy.run_path(str(EXAMPLE.with_name("guide_loss_compare.py")))
        f = np.linspace(14.5e9, 15.5e9, 201)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for cpw in (20, 30, 40):
                for loss in compare["LOSSES"]:
                    for sections in (1, 3):
                        p = self.values | {"cpw": cpw, "length_sections": sections,
                            "tan_d": .0004 if loss in ("dielectric", "both") else 0,
                            "wall_sigma": 5.8e7 if loss in ("copper", "both", "native_sheet") else 0,
                            "wall_model": "halfspace" if loss in ("copper", "both") else "sheet"}
                        ref = self.model.analytical(f, p)
                        gamma = .0002 + ref["alpha"] + 1j * ref["beta"]
                        s = np.zeros((201, 2, 2), complex)
                        s[:, 1, 0] = s[:, 0, 1] = np.exp(-gamma * .03 * sections)
                        dest = root / f"m{cpw}-{sections}-{loss}"
                        dest.mkdir()
                        np.savez(dest / "data.npz", f=f, s=s, **ref)
                        meta = {"parameters": p, "run": {"converged": cpw != 20},
                                "excitation": "gaussian", "dt_s": 1e-12,
                                "cells": 1000 * sections}
                        (dest / "report.json").write_text(json.dumps(meta), encoding="utf-8")
            rows = compare["analyse"](root, [20, 30, 40])
            fine = [r for r in rows if r["cpw"] == 40]
            self.assertTrue(all(r["matches"] and r["mesh_pair_passes"] for r in fine))
            self.assertTrue(all(not r["validated_scope"] for r in fine))


if __name__ == "__main__":
    unittest.main()
