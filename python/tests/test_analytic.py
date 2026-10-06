"""Closed-form estimates against published reference values (Balanis, Antenna Theory, 4th ed.)."""

import unittest

import numpy as np

from fairbeam import analytic as an


class SpecialFunctionsTest(unittest.TestCase):
    def test_si_ci(self):
        self.assertAlmostEqual(an.si(np.pi), 1.851937052, places=7)
        self.assertAlmostEqual(an.si(10.0), 1.658347594, places=7)
        self.assertAlmostEqual(an.ci(2 * np.pi), -0.022560575, places=5)
        self.assertAlmostEqual(an.ci(1.0), 0.337403923, places=7)

    def test_j0(self):
        self.assertAlmostEqual(an.bessel_j0(0.0), 1.0, places=9)
        self.assertAlmostEqual(an.bessel_j0(1.0), 0.765197687, places=8)
        self.assertAlmostEqual(an.bessel_j0(2.404825557695773), 0.0, places=8)


class DipoleTest(unittest.TestCase):
    def test_half_wave_impedance(self):
        # Balanis eq. 4-93: Z_in = 73 + j42.5 ohm for an infinitely thin half-wave dipole
        z = an.dipole_impedance(50.0, 1e-4, an.C0 / 0.1)
        self.assertAlmostEqual(z.real, 73.08, delta=0.05)
        self.assertAlmostEqual(z.imag, 42.51, delta=0.05)

    def test_half_wave_directivity(self):
        d = an.dipole_directivity(50.0, an.C0 / 0.1)
        self.assertAlmostEqual(10 * np.log10(d), 2.15, delta=0.01)

    def test_short_dipole_directivity(self):
        self.assertAlmostEqual(an.dipole_directivity(1.0, an.C0 / 1.0), 1.5, delta=0.01)

    def test_resonance_is_slightly_short_of_half_wave(self):
        r = an.dipole_resonance(58.0, 0.25, 1.5e9, 3.5e9)
        self.assertTrue(0.46 < r["length_over_lambda"] < 0.49)
        self.assertTrue(55 < r["r_in"] < 73)
        self.assertLess(abs(an.dipole_impedance(58.0, 0.25, r["f_r"]).imag), 0.01)

    def test_moment_method_reference(self):
        # thin half-wave dipole: close to the induced-EMF 73 + j42.5 ohm
        z = an.dipole_impedance_mom(50.0, 1e-3, an.C0 / 0.1, n_seg=240)
        self.assertTrue(70 < z.real < 82, z)
        self.assertTrue(30 < z.imag < 50, z)
        # the validation dipole (58 mm, strip 1 mm -> a = 0.25 mm) resonates near 2.44 GHz
        f = np.linspace(2.35e9, 2.55e9, 21)
        x = an.dipole_impedance_mom(58.0, 0.25, f, n_seg=100).imag
        i = np.where(np.diff(np.sign(x)) > 0)[0]
        self.assertEqual(len(i), 1)
        self.assertTrue(2.42e9 < f[i[0]] < 2.47e9, f[i[0]])
        with self.assertRaises(ValueError):
            an.dipole_impedance_mom(58.0, 0.25, 2e9, n_seg=11)

    def test_thicker_dipole_resonates_lower(self):
        thin = an.dipole_resonance(58.0, 0.05, 1.5e9, 3.5e9)["f_r"]
        thick = an.dipole_resonance(58.0, 1.0, 1.5e9, 3.5e9)["f_r"]
        self.assertLess(thick, thin)


class PatchTest(unittest.TestCase):
    def test_balanis_example_14_1(self):
        # 10 GHz, eps_r 2.2, h 0.1588 cm -> W 1.186 cm, eps_eff 1.972, dL 0.081 cm, L 0.906 cm
        d = an.patch_design(10e9, 1.588, 2.2)
        self.assertAlmostEqual(d["width"], 11.86, delta=0.02)
        self.assertAlmostEqual(d["eps_eff"], 1.972, delta=0.002)
        self.assertAlmostEqual(d["delta_l"], 0.81, delta=0.01)
        self.assertAlmostEqual(d["length"], 9.06, delta=0.02)

    def test_design_and_resonance_are_inverse(self):
        d = an.patch_design(2.4e9, 1.6, 4.4)
        r = an.patch_resonance(d["length"], d["width"], 1.6, 4.4)
        self.assertAlmostEqual(r["f_r"] / 2.4e9, 1.0, places=9)

    def test_balanis_example_14_3_edge_resistance(self):
        # W 1.186 cm, L 0.906 cm at 10 GHz: G1 = 0.00157 S, R_in(0) ~ 228 ohm with mutual G12
        self.assertAlmostEqual(an.patch_edge_resistance(9.06, 11.86, 10e9), 228.0, delta=3)

    def test_inset_depth(self):
        L, W, f = 29.0, 38.0, 2.4e9
        r0 = an.patch_edge_resistance(L, W, f)
        y0 = an.inset_depth(50.0, L, W, f)
        self.assertAlmostEqual(r0 * np.cos(np.pi * y0 / L) ** 2, 50.0, places=6)
        self.assertEqual(an.inset_depth(r0 + 1, L, W, f), 0.0)

    def test_microstrip_50_ohm_fr4(self):
        # 50 ohm on FR4 (eps_r 4.4, h 1.6 mm) is about 3.0-3.1 mm wide
        w = an.microstrip_width(50.0, 4.4, 1.6)
        self.assertTrue(2.9 < w < 3.2, w)
        self.assertAlmostEqual(an.microstrip_z0(4.4, 1.6, w), 50.0, places=6)

    def test_eps_eff_limits(self):
        self.assertTrue(1.0 < an.microstrip_eps_eff(4.4, 1.6, 3.0) < 4.4)
        # very wide strip -> eps_eff approaches eps_r
        self.assertAlmostEqual(an.microstrip_eps_eff(4.4, 1.6, 1e5), 4.4, delta=0.01)


class HornHelixTest(unittest.TestCase):
    def test_optimum_horn_design(self):
        d = an.pyramidal_horn_design(16.0, 10e9, 22.86, 10.16)
        lam = 299.792458 / 10
        self.assertAlmostEqual(d["length"], d["length_h"], places=6)             # realisable horn
        self.assertAlmostEqual(d["B"], np.sqrt(2 * lam * d["rho_e"]), places=6)  # E-plane optimum
        self.assertAlmostEqual(d["A"], np.sqrt(3 * lam * d["rho_h"]), places=6)  # H-plane optimum
        self.assertAlmostEqual(d["aperture_efficiency"], 0.51, delta=0.01)
        self.assertAlmostEqual((d["A"], d["B"], d["length"])[0], 86.2, delta=0.1)
        est = an.horn_estimates(d["A"], d["B"], 10e9)
        self.assertAlmostEqual(est["gain_dbi"], 16.0, delta=0.05)

    def test_horn_aperture_limits(self):
        lam = 29.9792458
        # no phase error: uniform (E) x cosine (H) aperture, efficiency 8/pi^2, textbook beamwidths
        ap = an.horn_aperture(10 * lam, 8 * lam, 1e9, 1e9, 10e9)
        self.assertAlmostEqual(ap["aperture_efficiency"], 8 / np.pi ** 2, places=3)
        self.assertAlmostEqual(ap["hpbw_e_deg"], 50.8 / 8, delta=0.05)
        self.assertAlmostEqual(ap["hpbw_h_deg"], 68.8 / 10, delta=0.1)   # exact cosine: 68.1 lambda/A
        # optimum phase errors (s = 1/4, t = 3/8) cost ~1.9 dB of the 8/pi^2 aperture: eff ~0.51
        A, B = 10 * lam, 8 * lam
        ap = an.horn_aperture(A, B, B ** 2 / (2 * lam), A ** 2 / (3 * lam), 10e9)
        self.assertAlmostEqual(ap["aperture_efficiency"], 0.51, delta=0.015)

    def test_kraus_helix(self):
        lam = 299.792458 / 2.4
        k = an.helix_axial_mode(lam, lam * np.tan(np.radians(13)), 7, 2.4e9)
        self.assertAlmostEqual(k["directivity_dbi"], 13.85, delta=0.01)
        self.assertAlmostEqual(k["r_in"], 140.0, places=6)
        self.assertAlmostEqual(k["axial_ratio_db"], 20 * np.log10(15 / 14), places=6)
        self.assertAlmostEqual(k["pitch_angle_deg"], 13.0, places=6)
        self.assertAlmostEqual(k["hpbw_deg"], 52 / np.sqrt(7 * np.tan(np.radians(13))), places=6)


if __name__ == "__main__":
    unittest.main()
