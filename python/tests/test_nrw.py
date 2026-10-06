"""Material extraction from S11/S21 (fairbeam.nrw) and its use in the material cell: NRW with the
group-delay branch choice and its half-wave mask, the NIST iterative eps-only method, the result
file fields, and Simulation.dielectric's mu_r (synthetic data from fairbeam.analytic.slab_s, no
FDTD run)."""

import json
import unittest

import numpy as np

from fairbeam.analytic import C0, layer_constants, slab_s
from fairbeam.jsonutil import finite_json
from fairbeam.material_cell import _material_json, extract_material
from fairbeam.nrw import SIN_FLOOR, compare_material, nist_eps, nrw, slab_s_single
from fairbeam.simulation import Simulation

F = np.linspace(1e9, 10e9, 401)


def sparams(layer, f=F):
    s = slab_s(f, [layer])
    return s[:, 0, 0], s[:, 1, 0]


def debye(f, eps_s=6.0, eps_inf=3.0, f_relax=4e9):
    return eps_inf + (eps_s - eps_inf) / (1 + 1j * f / f_relax)   # e^{+j w t}: Im < 0


def debye_sparams(d_mm, f=F):
    return slab_s_single(f, debye(f), d_mm)


class Nrw(unittest.TestCase):
    def check(self, layer, tol=1e-9):
        s11, s21 = sparams(layer)
        r = nrw(F, s11, s21, layer["thickness"])
        eps, mu = layer_constants(F, layer)
        d = compare_material(F, r, eps, mu, r["reliable"])
        for key in ("max_rel_eps_real", "max_abs_tan_d", "max_rel_mu_real", "max_abs_tan_d_mu"):
            self.assertLess(d[key], tol, (layer, key, d))
        return r

    def test_lossless_and_lossy_dielectric(self):
        self.check({"thickness": 10.0, "eps_r": 4.0})
        r = self.check({"thickness": 10.0, "eps_r": 4.0, "tan_d": 0.05, "tan_d_freq": 5.5e9})
        self.assertEqual(r["branch"], 0)
        self.assertAlmostEqual(float(r["tan_d"][np.argmin(np.abs(F - 5.5e9))]), 0.05, places=9)

    def test_magnetic_slab(self):
        r = self.check({"thickness": 10.0, "eps_r": 3.0, "mu_r": 2.0, "tan_d": 0.02})
        np.testing.assert_allclose(r["mu_r"].real[r["reliable"]], 2.0, rtol=1e-9)

    def test_group_delay_picks_the_branch_of_a_thick_sample(self):
        # 50 mm of eps_r 9 from 5 GHz: k0 n d = 15.7 rad at the lowest frequency, so the principal
        # branch (M = 0, |phase| <= pi) is several turns off and only the group delay can fix it
        f = np.linspace(5e9, 10e9, 201)
        layer = {"thickness": 50.0, "eps_r": 9.0, "tan_d": 0.01}
        s11, s21 = sparams(layer, f)
        r = nrw(f, s11, s21, 50.0)
        self.assertLessEqual(r["branch"], -2)
        eps, mu = layer_constants(f, layer)
        d = compare_material(f, r, eps, mu, r["reliable"])
        self.assertLess(d["max_rel_eps_real"], 1e-9)
        self.assertLess(d["max_rel_mu_real"], 1e-9)
        np.testing.assert_allclose(r["group_index"][r["reliable"]], 3.0, rtol=1e-3)
        np.testing.assert_allclose(r["n"][r["reliable"]], np.sqrt(eps * mu)[r["reliable"]], rtol=1e-9)

    def test_half_wave_frequencies_are_masked(self):
        layer = {"thickness": 10.0, "eps_r": 4.0}
        r = nrw(F, *sparams(layer), 10.0)
        beta_d = 2 * np.pi * F / C0 * 2.0 * 0.01
        expect = (beta_d > np.pi / 2) & (np.abs(np.sin(beta_d)) < SIN_FLOOR)
        np.testing.assert_array_equal(~r["reliable"], expect)
        self.assertTrue((~r["reliable"])[np.argmin(np.abs(F - 7.5e9))])      # beta d = pi at 7.5 GHz
        # low frequencies (thin compared with the wavelength) stay reliable
        self.assertTrue(r["reliable"][0])

    def test_dispersive_debye_material(self):
        s11, s21 = debye_sparams(5.0)
        r = nrw(F, s11, s21, 5.0)
        d = compare_material(F, r, debye(F), np.ones(len(F)), r["reliable"])
        self.assertLess(d["max_rel_eps_real"], 1e-9)
        self.assertLess(d["max_abs_tan_d"], 1e-9)

    def test_rejects_zero_thickness(self):
        with self.assertRaises(ValueError):
            nrw(F, *sparams({"thickness": 1.0, "eps_r": 2.0}), 0.0)


class Nist(unittest.TestCase):
    def test_whole_band_including_the_half_wave_resonance(self):
        for layer in ({"thickness": 10.0, "eps_r": 4.0},
                      {"thickness": 10.0, "eps_r": 4.0, "tan_d": 0.05, "tan_d_freq": 5.5e9},
                      {"thickness": 50.0, "eps_r": 9.0, "tan_d": 0.01}):
            n = nist_eps(F, *sparams(layer), layer["thickness"])
            self.assertTrue(n["converged"].all(), layer)
            d = compare_material(F, n, layer_constants(F, layer)[0])
            self.assertEqual(d["points"], len(F))
            self.assertLess(d["max_rel_eps_real"], 1e-9, layer)
            self.assertLess(d["max_abs_tan_d"], 1e-9, layer)

    def test_debye(self):
        n = nist_eps(F, *debye_sparams(5.0), 5.0)
        d = compare_material(F, n, debye(F))
        self.assertLess(d["max_rel_eps_real"], 1e-9)

    def test_noise_is_not_amplified_at_the_resonance(self):
        layer = {"thickness": 10.0, "eps_r": 4.0}
        s11, s21 = sparams(layer)
        rng = np.random.default_rng(7)
        noise = 1e-3 * (rng.standard_normal((2, len(F))) + 1j * rng.standard_normal((2, len(F))))
        a, b = s11 + noise[0], s21 + noise[1]
        eps = layer_constants(F, layer)[0]
        nist = compare_material(F, nist_eps(F, a, b, 10.0), eps)
        nrw_all = compare_material(F, nrw(F, a, b, 10.0), eps)
        self.assertLess(nist["max_rel_eps_real"], 0.01)
        self.assertGreater(nrw_all["max_rel_eps_real"], 10 * nist["max_rel_eps_real"])   # NRW unmasked

    def test_closed_form_matches_the_transfer_matrix(self):
        eps = 4.0 * (1 - 0.05j)
        a, b = slab_s_single(F, eps, 7.0, mu=1.5)
        s = slab_s(F, [{"thickness": 7.0, "eps_r": 4.0, "tan_d": 0.05, "mu_r": 1.5}])
        np.testing.assert_allclose(a, s[:, 0, 0], atol=1e-12)
        np.testing.assert_allclose(b, s[:, 1, 0], atol=1e-12)


class CellIntegration(unittest.TestCase):
    def result(self, layer):
        s11, s21 = sparams(layer)
        return {"f": F, "s11": s11, "s21": s21}

    def test_extract_and_json(self):
        layer = {"thickness": 10.0, "eps_r": 3.0, "mu_r": 2.0, "tan_d": 0.02, "tan_d_freq": 5.5e9}
        m = extract_material(self.result(layer), 10.0, nist=True, expected=layer)
        self.assertLess(m["deviation"]["nrw"]["max_rel_mu_real"], 1e-9)
        self.assertIn("nist", m["deviation"])          # computed, though it does not apply (mu_r = 2)
        doc = json.loads(json.dumps(finite_json(_material_json(m)), allow_nan=False))
        self.assertEqual(doc["thickness"], 10.0)
        self.assertEqual(len(doc["nrw"]["eps_r"]["re"]), len(F))
        self.assertEqual(len(doc["nrw"]["reliable"]), len(F))
        self.assertIn("0.3", doc["nrw"]["criterion"])
        self.assertEqual(set(doc["nist"]), {"method", "eps_r", "tan_d", "iterations", "converged", "residual"})
        self.assertAlmostEqual(doc["expected"]["mu_r"]["re"][0], 2.0)

    def test_without_nist_or_expected(self):
        m = extract_material(self.result({"thickness": 10.0, "eps_r": 4.0}), 10.0)
        self.assertNotIn("nist", m)
        self.assertNotIn("deviation", m)
        self.assertNotIn("nist", _material_json(m))

    def test_sin_floor_is_passed_through(self):
        res = self.result({"thickness": 10.0, "eps_r": 4.0})
        loose = extract_material(res, 10.0, sin_floor=0.05)["nrw"]["reliable"].sum()
        strict = extract_material(res, 10.0, sin_floor=0.5)["nrw"]["reliable"].sum()
        self.assertGreater(loose, strict)


class DielectricMu(unittest.TestCase):
    def test_mu_r_reaches_openems_and_is_recorded_only_when_not_one(self):
        sim = Simulation(1e9, 10e9)
        plain = sim.dielectric("plain", 4.0, 0.01)
        magnetic = sim.dielectric("magnetic", 3.0, 0.02, mu_r=2.0)
        self.assertNotIn("mu_r", sim.materials["plain"])          # existing bundles stay as they are
        self.assertEqual(sim.materials["magnetic"]["mu_r"], 2.0)
        self.assertAlmostEqual(plain.GetMaterialProperty("mue"), 1.0)
        self.assertAlmostEqual(magnetic.GetMaterialProperty("mue"), 2.0)
        self.assertAlmostEqual(magnetic.GetMaterialProperty("epsilon"), 3.0)


if __name__ == "__main__":
    unittest.main()
