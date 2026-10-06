"""Rectangular-waveguide material fixture (fairbeam.waveguide_fixture) and the guided forms of the
analytic slab and the NRW / NIST inversions: closed-form guided slab, recovery from synthetic
S-parameters, de-embedding, fixture setup and the runner (no FDTD run)."""

import contextlib
import io
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from fairbeam import waveguide_fixture
from fairbeam.analytic import C0, ETA0, layer_constants, slab_s
from fairbeam.material_cell import GRADING, PML_CELLS, PML_MARGIN_CELLS, _print_material, run_cell, to_json
from fairbeam.model import load_model, resolve_params
from fairbeam.nrw import nist_eps, nrw, slab_s_single
from fairbeam.simulation import Simulation
from fairbeam.waveguide_fixture import (FIXTURE_BOUNDARIES, GAP_MIN_CELLS, HIGHER_MODE_DECAY_DB, PORT_PROBE_CELLS,
                                        PORT_PROBE_FILE, WR90, WaveguideFixture, _transverse_lines, analytic_beta,
                                        _eplane_residual, band_warnings, cutoffs, deembed, gap_correction, gap_modes,
                                        measured_beta, mode_decay_db)

EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "wr90_fixture.py"
A, B = WR90
KC = np.pi / (A * 1e-3)
F = np.linspace(8.2e9, 12.4e9, 43)


def write_probe(path, dt: float, stride: int = 3, n: int = 200):
    """An openEMS probe file (``%`` header, time and value columns) sampled every ``stride`` steps."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    t = np.arange(n) * stride * dt
    np.savetxt(path, np.c_[t, np.sin(t / dt / 50)], header="time value", comments="% ")


def guided_slab(f, d_mm, eps, mu=1.0, kc=KC):
    """Closed-form S11, S21 of one sample filling a guide (TE mode of cut-off wavenumber kc)."""
    k0 = 2 * np.pi * np.asarray(f) / C0
    b0 = np.sqrt(k0 ** 2 - kc ** 2)
    bs = np.sqrt(eps * mu * k0 ** 2 - kc ** 2 + 0j)
    bs = np.where(bs.imag > 0, -bs, bs)
    z0, zs = ETA0 * k0 / b0, ETA0 * mu * k0 / bs
    r = (zs - z0) / (zs + z0)
    h = np.exp(-1j * bs * d_mm * 1e-3)
    return r * (1 - h ** 2) / (1 - r ** 2 * h ** 2), (1 - r ** 2) * h / (1 - r ** 2 * h ** 2)


def layer(eps_r, tan_d=0.0, mu_r=1.0, d=10.0):
    return {"thickness": d, "eps_r": eps_r, "tan_d": tan_d, "mu_r": mu_r}


class GuidedSlab(unittest.TestCase):
    def test_matches_closed_form(self):
        for eps, mu in ((4.0, 1.0), (4.0 - 0.08j, 1.0), (3.0, 2.0)):
            s = slab_s(F, [layer(eps.real, -eps.imag / eps.real, mu)], kc=KC)
            s11, s21 = guided_slab(F, 10.0, eps, mu)
            np.testing.assert_allclose(s[:, 0, 0], s11, atol=1e-12)
            np.testing.assert_allclose(s[:, 1, 0], s21, atol=1e-12)
            np.testing.assert_allclose(s[:, 0, 1], s[:, 1, 0], atol=1e-12)

    def test_dispersive_layer(self):
        from fairbeam.dispersion import Debye, Dispersion, Lorentz

        disp = Dispersion(3.0, (Debye(1.5, 1 / (2 * np.pi * 10e9)), Lorentz(2e9, 14e9, 1e-10)))
        for layer_ in ({"thickness": 10.0, "dispersion": disp}, {"thickness": 10.0, "dispersion": disp.to_dict()}):
            s = slab_s(F, [layer_], kc=KC)
            s11, s21 = guided_slab(F, 10.0, disp.eps(F))
            np.testing.assert_allclose(s[:, 0, 0], s11, atol=1e-12)
            np.testing.assert_allclose(s[:, 1, 0], s21, atol=1e-12)

    def test_kc_zero_is_the_free_space_slab(self):
        lay = [layer(4.0, 0.02), layer(2.0, 0.0, 1.5, d=3.0)]
        np.testing.assert_array_equal(slab_s(F, lay, kc=0.0), slab_s(F, lay))

    def test_empty_guide_is_a_guided_delay_and_lossless_conserves_power(self):
        s = slab_s(F, [layer(1.0)], kc=KC)
        np.testing.assert_allclose(s[:, 0, 0], 0, atol=1e-12)
        np.testing.assert_allclose(s[:, 1, 0], np.exp(-1j * analytic_beta(F, KC) * 10e-3), atol=1e-12)
        s = slab_s(F, [layer(4.0)], kc=KC)
        np.testing.assert_allclose(np.abs(s[:, 0, 0]) ** 2 + np.abs(s[:, 1, 0]) ** 2, 1, atol=1e-12)

    def test_single_slab_model_agrees(self):
        """fairbeam.nrw.slab_s_single (the NIST forward model) with kc is the same guided slab."""
        eps = 4.0 * (1 - 0.02j)
        s11, s21 = slab_s_single(F, eps, 10.0, kc=KC)
        r11, r21 = guided_slab(F, 10.0, eps)
        np.testing.assert_allclose(s11, r11, atol=1e-12)
        np.testing.assert_allclose(s21, r21, atol=1e-12)


class GuidedInversion(unittest.TestCase):
    def check(self, eps, mu=1.0, beta0=None, nist=True):
        if beta0 is None:
            s11, s21 = guided_slab(F, 10.0, eps, mu)
        else:
            s11, s21 = slab_s_single(F, eps, 10.0, mu=mu, kc=KC, beta0=beta0)
        r = nrw(F, s11, s21, 10.0, kc=KC, beta0=beta0)
        ok = r["reliable"]
        self.assertGreater(ok.sum(), len(F) // 2)
        np.testing.assert_allclose(r["eps_r"][ok], eps, rtol=1e-9)
        np.testing.assert_allclose(r["mu_r"][ok], mu, rtol=1e-9)
        if nist:
            n = nist_eps(F, s11, s21, 10.0, kc=KC, beta0=beta0)
            self.assertTrue(n["converged"].all())
            np.testing.assert_allclose(n["eps_r"], eps, rtol=1e-6)
        return r

    def test_lossless_lossy_and_magnetic_samples(self):
        self.check(4.0)
        r = self.check(4.0 * (1 - 0.02j))
        np.testing.assert_allclose(r["tan_d"][r["reliable"]], 0.02, rtol=1e-9)
        self.check(3.0, 2.0, nist=False)

    def test_measured_beta0_of_a_dispersive_mesh(self):
        """With the empty guide's numerical beta0 (here 0.5 % slow) the inversion that uses it
        recovers the sample exactly; using the analytic beta0 instead biases eps_r."""
        b0 = analytic_beta(F, KC) * 1.005
        self.check(4.0 * (1 - 0.02j), beta0=b0)
        s11, s21 = slab_s_single(F, 4.0, 10.0, kc=KC, beta0=b0)
        r = nrw(F, s11, s21, 10.0, kc=KC)
        self.assertGreater(np.max(np.abs(r["eps_r"][r["reliable"]].real / 4 - 1)), 1e-3)

    def test_free_space_form_unchanged(self):
        """kc = 0 without beta0 is the plane-wave inversion: no guided term anywhere."""
        k0 = 2 * np.pi * F / C0
        s11, s21 = slab_s_single(F, 4.0, 10.0)
        a, b = nrw(F, s11, s21, 10.0), nrw(F, s11, s21, 10.0, kc=0.0, beta0=k0)
        for key in ("eps_r", "mu_r", "reliable"):
            np.testing.assert_allclose(a[key], b[key], rtol=1e-12)


class DeEmbedding(unittest.TestCase):
    def test_measured_beta_unwraps_a_long_guide(self):
        b = analytic_beta(F, KC) * 1.002
        L = 180.0                                     # many wavelengths: the phase wraps
        got = measured_beta(F, 0.999 * np.exp(-1j * b * L * 1e-3), L, KC)
        np.testing.assert_allclose(got, b, rtol=1e-12)

    def test_recovers_the_sample_at_its_faces(self):
        b = analytic_beta(F, KC) * 0.997
        l1, d, l2 = 24.0, 10.0, 26.5                  # mm: plane 1 to front face, sample, back face to plane 2
        s11, s21 = slab_s_single(F, 4.0 * (1 - 0.02j), d, kc=KC, beta0=b)
        port = 0.98 * np.exp(0.1j)                    # the ports' common transmission
        delay = lambda x: np.exp(-1j * b * x * 1e-3)   # noqa: E731
        s21_e = port * delay(l1 + d + l2)
        res = deembed(F, s11 * delay(2 * l1), port * delay(l1) * s21 * delay(l2), s21_e, b, l1, d)
        np.testing.assert_allclose(res["s11"], s11, atol=1e-12)
        np.testing.assert_allclose(res["s21"], s21, atol=1e-12)
        np.testing.assert_allclose(res["absorption"], 1 - res["R2"] - res["T2"])


class CutOffs(unittest.TestCase):
    def test_wr90(self):
        c = cutoffs(A, B)
        self.assertAlmostEqual(c["TE10"], C0 / (2 * A * 1e-3))
        self.assertAlmostEqual(c["TE20"], C0 / (A * 1e-3))
        self.assertAlmostEqual(c["TE01"], C0 / (2 * B * 1e-3))
        filled = cutoffs(A, B, eps_mu=4.0)
        self.assertAlmostEqual(filled["TE10"], c["TE10"] / 2)

    def test_band_check_on_the_empty_guide(self):
        c = cutoffs(A, B)
        self.assertEqual(band_warnings(8.2e9, 12.4e9, c), [])
        w = band_warnings(8.2e9, 14e9, c)
        self.assertEqual(len(w), 1)
        self.assertIn("TE20", w[0])
        with self.assertRaises(ValueError):
            band_warnings(6e9, 12e9, c)

    def test_filled_cut_offs_are_reported_not_warned(self):
        """eps_r 4: the filled section's TE20 (6.56 GHz) is inside the band, which is fine."""
        fx = WaveguideFixture(Simulation(8.2e9, 12.4e9, excitation="gauss"), 0.0, 10.0, eps_max=4.0)
        self.assertEqual(fx.warnings, [])
        d = fx.describe()
        self.assertAlmostEqual(d["cutoffs_filled"]["TE20"], d["cutoffs_empty"]["TE20"] / 2)
        self.assertEqual(d["cutoffs_filled"]["eps_r_mu_r"], 4.0)

    def test_warns_for_a_pulse_down_to_dc_with_a_filled_sample(self):
        fx = WaveguideFixture(Simulation(8.2e9, 12.4e9), 0.0, 10.0, eps_max=4.0)
        self.assertEqual(len(fx.warnings), 1)
        self.assertIn("trapped", fx.warnings[0])
        self.assertEqual(WaveguideFixture(Simulation(8.2e9, 12.4e9), 0.0, 10.0).warnings, [])


class FixtureSetup(unittest.TestCase):
    def build(self, **kw):
        sim = Simulation(8.2e9, 12.4e9)
        return sim, WaveguideFixture(sim, 0.0, 10.0, **kw)

    def test_boundaries_mesh_and_planes(self):
        sim, fx = self.build(eps_max=4.0, cells_per_wavelength=20)
        self.assertEqual(sim.boundaries, list(FIXTURE_BOUNDARIES))
        self.assertIs(sim.waveguide_fixture, fx)
        z = np.asarray(sim.mesh.GetLines("z"))
        for v in (fx.front, fx.back, fx.z_ref1, fx.z_ref2, *fx._planes):
            self.assertLess(np.min(np.abs(z - v)), 1e-9, v)
        self.assertLessEqual(fx.z_ref1, fx.front - fx.gap + 1e-9)
        self.assertGreaterEqual(fx.z_ref2, fx.back + fx.gap - 1e-9)
        self.assertEqual(fx.gap, A)
        # excitation planes PORT_PROBE_CELLS outside the reference planes, clear of the PML
        i_exc1, i_ref1 = (int(np.argmin(np.abs(z - v))) for v in fx._planes[:2])
        self.assertEqual(i_ref1 - i_exc1, PORT_PROBE_CELLS)
        self.assertEqual(i_exc1, PML_CELLS + PML_MARGIN_CELLS)
        dz = np.diff(z)
        inside = dz[(z[:-1] >= 0) & (z[1:] <= 10 + 1e-9)]
        self.assertLessEqual(inside.max(), C0 / 12.4e9 * 1e3 / 20 / 2 + 1e-9)
        x, y = np.asarray(sim.mesh.GetLines("x")), np.asarray(sim.mesh.GetLines("y"))
        self.assertEqual((x[0], x[-1], y[0], y[-1]), (-A / 2, A / 2, -B / 2, B / 2))

    def test_ports(self):
        sim, fx = self.build()
        self.assertEqual([p["number"] for p in sim.ports], [1, 2])
        self.assertEqual([p["excite"] for p in sim.ports], [True, False])
        for p, (exc, ref) in zip(sim.ports, ((fx._planes[0], fx.z_ref1), (fx._planes[2], fx.z_ref2))):
            self.assertEqual((p["type"], p["mode"], p["a"], p["b"]), ("waveguide", "TE10", A, B))
            self.assertEqual((p["start"][2], p["stop"][2]), (exc, ref))   # probes in the reference plane
        self.assertAlmostEqual(fx.kc, KC)

    def test_reference_is_the_empty_guide_on_the_same_mesh(self):
        sim, fx = self.build(eps_max=4.0)
        sim.dielectric("sample", 4.0).AddBox(*fx.span(0.0, 10.0))
        ref = fx.reference()
        for axis in "xyz":
            np.testing.assert_array_equal(ref.mesh.GetLines(axis), sim.mesh.GetLines(axis))
        self.assertEqual(ref.ports, sim.ports)
        self.assertEqual(ref.boundaries, sim.boundaries)
        self.assertEqual(ref.excitation, sim.excitation)
        self.assertEqual(ref.csx.GetPropertiesByName("sample"), [])

    def test_rejects_bad_geometry(self):
        with self.assertRaises(ValueError):
            self.build(eps_max=0.5)
        with self.assertRaises(ValueError):
            WaveguideFixture(Simulation(8.2e9, 12.4e9), 3.0, 1.0)
        with self.assertRaises(ValueError):
            WaveguideFixture(Simulation(5e9, 12.4e9), 0.0, 1.0)    # below the TE10 cut-off


def apparent_eps(eps, gap_x, gap_y, a=A, b=B):
    """The capacitor model forward: what a sample of ``eps`` with the air gaps appears to be."""
    column = b / ((b - 2 * gap_y) / np.asarray(eps, complex) + 2 * gap_y)   # series: sample and two gaps
    w = 2 * gap_x / a - np.sin(2 * np.pi * gap_x / a) / np.pi
    return w + (1 - w) * column


def resonance_apparent(eps_s, gap_y, f, b=B):
    """The transverse-resonance forward (TN 1355-R eq. C.1): the eps a sample of ``eps_s`` with a
    gap ``gap_y`` (mm) to each broad wall appears to have at f, by Newton from the capacitor value."""
    k0, d, g = 2 * np.pi * f / C0, (b / 2 - gap_y) * 1e-3, gap_y * 1e-3
    e = complex(apparent_eps(eps_s, 0.0, gap_y, b=b))
    for _ in range(60):
        r = _eplane_residual(eps_s, e, k0, d, g)
        step = -r / ((_eplane_residual(eps_s, e + 1e-7, k0, d, g) - r) / 1e-7)
        e += step
        if abs(step) < 1e-14:
            return e
    raise AssertionError("forward Newton did not converge")


class AirGap(unittest.TestCase):
    def test_capacitor_correction_inverts_the_capacitor_model(self):
        eps = np.array([4.0, 4 - 0.08j, 10 - 1j])
        np.testing.assert_allclose(gap_correction(eps, 0.0, 0.0, A, B), eps, rtol=1e-15)
        for gx, gy in ((0.0, 0.05), (0.5, 0.0), (0.3, 0.2)):
            np.testing.assert_allclose(gap_correction(apparent_eps(eps, gx, gy), gx, gy, A, B, model="capacitor"), eps,
                                       rtol=1e-12)

    def test_capacitor_model_is_tn1355_c23_c24(self):
        """TN 1355-R eqs. (C.23)-(C.24) give the corrected eps' and eps'' for a total gap b - d (air
        in the gap) in real arithmetic; our gap_y is per side, so b - d = 2 gap_y."""
        for eps_m, gy in ((3.9 - 0.08j, 0.05), (3.6 - 0.07j, 0.2), (8.5 - 1.2j, 0.1)):
            d = B - 2 * gy
            e1, e2, mag = eps_m.real, -eps_m.imag, abs(eps_m) ** 2
            den = B ** 2 * (mag - 2 * e1 + 1) - 2 * B * d * (mag - e1) + d ** 2 * mag
            tn_real = d * (B * (e1 - mag) + d * mag) / den                       # (C.23)
            tn_imag = d * B * e2 / den                                           # (C.24), eps'' (> 0)
            got = gap_correction(eps_m, 0.0, gy, A, B, model="capacitor")
            self.assertAlmostEqual(got.real, tn_real, places=12)
            self.assertAlmostEqual(-got.imag, tn_imag, places=12)

    def test_resonance_is_the_capacitor_at_low_frequency(self):
        eps_m = np.array([3.9 - 0.08j, 3.6 - 0.07j])
        res = gap_correction(eps_m, 0.0, 0.2, A, B, f=1e6)
        np.testing.assert_allclose(res, gap_correction(eps_m, 0.0, 0.2, A, B, model="capacitor"), rtol=1e-7)

    def test_resonance_inverts_its_forward_model(self):
        """Lossless and lossy samples, also a high-eps one with a large gap (where the equation has
        more roots): the correction returns the sample, on the fundamental root, with Im eps <= 0."""
        f = np.linspace(8.2e9, 12.4e9, 9)
        for eps_s, gy in ((4.0, 0.025), (4.0 - 0.08j, 0.2), (10.0 - 1.0j, 0.2), (4.0 - 0.08j, 1.0)):
            obs = np.array([resonance_apparent(eps_s, gy, fi) for fi in f])
            got = gap_correction(obs, 0.0, gy, A, B, f)
            np.testing.assert_allclose(got, eps_s, rtol=1e-10)
            self.assertTrue(np.all(got.imag <= 1e-12))
            k1d = 2 * np.pi * f / C0 * np.sqrt(got - obs) * (B / 2 - gy) * 1e-3
            self.assertTrue(np.all(np.abs(k1d) < np.pi / 2))

    def test_resonance_residual_does_not_depend_on_the_square_roots(self):
        """Even in k1 and kappa: flipping either square root's sign changes nothing, so the
        principal branches cannot pick a wrong root."""
        k0, d, g, es, eo = 250.0, 4.98e-3, 0.1e-3, 4.0 - 0.08j, 3.8 - 0.07j
        k1, ka = k0 * np.sqrt(es - eo), k0 * np.sqrt(eo - 1)
        f = lambda k1, ka: k1 * np.sin(k1 * d) - es * ka * np.tanh(ka * g) * np.cos(k1 * d)   # noqa: E731
        ref = _eplane_residual(es, eo, k0, d, g)
        for s1, s2 in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
            self.assertAlmostEqual(abs(f(s1 * k1, s2 * ka) - ref), 0.0, places=9)

    def test_resonance_band_means_for_wr90(self):
        """The forward model's band-mean drop for an eps 4 sample (8.2-12.4 GHz, 43 points)."""
        f = np.linspace(8.2e9, 12.4e9, 43)
        for gy, mean in ((0.025, -1.42), (0.05, -2.75), (0.1, -5.15), (0.2, -9.24)):
            obs = np.array([resonance_apparent(4.0, gy, fi) for fi in f])
            self.assertAlmostEqual(100 * (obs.real.mean() / 4 - 1), mean, delta=0.006)

    def test_model_choice(self):
        with self.assertRaises(ValueError):
            gap_correction(3.9, 0.0, 0.1, A, B)                       # resonance needs f
        with self.assertRaises(ValueError):
            gap_correction(3.9, 0.0, 0.1, A, B, 1e10, model="westphal")
        self.assertEqual(gap_correction(3.9, 0.1, 0.0, A, B), gap_correction(3.9, 0.1, 0.0, A, B, model="capacitor"))

    def test_broad_wall_gap_is_a_series_capacitor(self):
        # 0.05 mm on each side of an eps 4 sample in a 10.16 mm high guide: b / (d / 4 + 2 g)
        self.assertAlmostEqual(abs(apparent_eps(4.0, 0.0, 0.05)), 10.16 / (10.06 / 4 + 0.1), places=12)
        self.assertLess(apparent_eps(4.0, 0.0, 0.05).real, 3.9)          # 2.9 % low

    def test_narrow_wall_gap_is_weighted_by_the_te10_field(self):
        gx = 0.5
        x = np.linspace(0, A, 200001)
        energy = np.sin(np.pi * x / A) ** 2
        in_gap = (x < gx) | (x > A - gx)
        w_num = np.trapezoid(energy * in_gap, x) / np.trapezoid(energy, x)
        w = 1 - (apparent_eps(4.0, gx, 0.0).real - 1) / 3                  # eps = w + (1 - w) 4
        self.assertAlmostEqual(w, w_num, places=6)
        self.assertAlmostEqual(w, 4 / 3 * np.pi ** 2 * (gx / A) ** 3, delta=0.02 * w)   # thin-gap limit
        self.assertLess(4 - apparent_eps(4.0, gx, 0.0).real, 0.001)      # 0.5 mm: under 0.03 %

    def test_modes_a_symmetric_gap_excites(self):
        self.assertEqual(gap_modes(A, B, 0.0, 0.0), [])
        self.assertEqual([m["mode"] for m in gap_modes(A, B, 0.1, 0.0)], ["TE30"])
        self.assertEqual([m["mode"] for m in gap_modes(A, B, 0.0, 0.1)], ["TE12", "TM12"])
        self.assertEqual(len(gap_modes(A, B, 0.1, 0.1)), 5)
        te30 = gap_modes(A, B, 0.1, 0.0)[0]["f_cutoff"]
        self.assertAlmostEqual(te30, 3 * C0 / (2 * A * 1e-3))
        self.assertAlmostEqual(gap_modes(A, B, 0.0, 0.1)[0]["f_cutoff"] / 1e9, 30.2, delta=0.05)
        self.assertEqual(mode_decay_db(20e9, 19e9, 10.0), 0.0)            # propagating
        alpha = 2 * np.pi / C0 * np.sqrt(te30 ** 2 - 12.4e9 ** 2)
        self.assertAlmostEqual(mode_decay_db(12.4e9, te30, A), 20 * np.log10(np.e) * alpha * A * 1e-3)

    def test_transverse_mesh(self):
        np.testing.assert_array_equal(_transverse_lines(A, 0.0, 1.2, 4), np.linspace(-A / 2, A / 2, 20 + 1))
        for width, gap, cell in ((B, 0.025, 1.2), (B, 0.2, 1.2), (A, 0.1, 0.8), (A, 3.0, 0.8)):
            lines = _transverse_lines(width, gap, cell, 2)
            d = np.diff(lines)
            self.assertTrue(np.all(d > 0))
            np.testing.assert_allclose(lines, -lines[::-1], atol=1e-12)                       # symmetric
            for edge in (-width / 2 + gap, width / 2 - gap):
                self.assertLess(np.min(np.abs(lines - edge)), 1e-12)
            self.assertGreaterEqual(int(np.sum(lines <= -width / 2 + gap + 1e-12)) - 1, GAP_MIN_CELLS)
            self.assertLessEqual(np.max(np.maximum(d[1:] / d[:-1], d[:-1] / d[1:])), GRADING + 1e-9)
            self.assertLessEqual(d.max(), cell + 1e-12)

    def test_fixture_without_a_gap_is_unchanged(self):
        sim = Simulation(8.2e9, 12.4e9, excitation="gauss")
        fx = WaveguideFixture(sim, 0.0, 10.0, eps_max=4.0)
        air = C0 / 12.4e9 * 1e3 / 20
        np.testing.assert_array_equal(sim.mesh.GetLines("x"), np.linspace(-A / 2, A / 2, int(np.ceil(A / air)) + 1))
        np.testing.assert_array_equal(sim.mesh.GetLines("y"), np.linspace(-B / 2, B / 2, int(np.ceil(B / air)) + 1))
        self.assertEqual(fx.sample_span(0.0, 10.0), fx.span(0.0, 10.0))
        self.assertEqual((fx.higher_modes, fx.warnings), ([], []))

    def test_fixture_with_a_gap(self):
        sim = Simulation(8.2e9, 12.4e9, excitation="gauss")
        fx = WaveguideFixture(sim, 0.0, 10.0, eps_max=4.0, gap_x=0.1, gap_y=0.05)
        lo, hi = fx.sample_span(0.0, 10.0)
        self.assertEqual((lo[0], lo[1], hi[0], hi[1]), (-A / 2 + 0.1, -B / 2 + 0.05, A / 2 - 0.1, B / 2 - 0.05))
        for axis, v in (("x", hi[0]), ("y", hi[1])):
            self.assertLess(np.min(np.abs(np.asarray(sim.mesh.GetLines(axis)) - v)), 1e-12)
        self.assertEqual(fx.gap, A)                                       # TE30 decays 64 dB over a: enough
        self.assertTrue(all(m["decay_db"] >= HIGHER_MODE_DECAY_DB for m in fx.higher_modes))
        d = fx.describe()["air_gap"]
        self.assertEqual((d["gap_x"], d["gap_y"]), (0.1, 0.05))

    def test_reference_planes_move_out_for_the_higher_modes(self):
        sim = Simulation(8.2e9, 12.4e9, excitation="gauss")
        fx = WaveguideFixture(sim, 0.0, 10.0, eps_max=4.0, gap=5.0, gap_x=0.1)
        self.assertGreater(fx.gap, 5.0)
        self.assertAlmostEqual(min(m["decay_db"] for m in fx.higher_modes), HIGHER_MODE_DECAY_DB, places=6)
        self.assertTrue(any("reference planes moved" in w for w in fx.warnings))
        z = np.asarray(sim.mesh.GetLines("z"))
        self.assertLessEqual(fx.z_ref1, -fx.gap + 1e-9)
        self.assertLess(np.min(np.abs(z - fx.z_ref1)), 1e-9)

    def test_rejects_gaps_that_leave_no_sample(self):
        for kw in ({"gap_x": A / 2}, {"gap_y": B / 2}, {"gap_y": -0.1}):
            with self.assertRaises(ValueError):
                WaveguideFixture(Simulation(8.2e9, 12.4e9, excitation="gauss"), 0.0, 10.0, **kw)


class Runner(unittest.TestCase):
    """run_cell on a waveguide model without openEMS: the runs write their port probe, and the
    port evaluation and the port waves are replaced by the guided slab between ideal ports, with a
    0.3 % slow numerical beta0."""

    def run_example(self, overrides=None, ran=None, module=None, waves_eps=None):
        """``ran``: the (reference, sample) steps the two runs use (default: the forced one);
        ``waves_eps``: maps the sample's eps to the one its S-parameters show (an air gap)."""
        module = module or load_model(EXAMPLE)
        values = resolve_params(module.PARAMS, overrides or {})
        own, fixtures = {}, []

        def fake_run(sim, sim_path, threads=0, setup_only=False, **kw):
            sim.sim_path = sim_path
            label = Path(sim_path).name
            if setup_only:
                own[label] = 1.0e-12 if label == "sample" else 1.2e-12
                return {"timestep_s": own[label]}
            dt = (ran or (min(own.values()),) * 2)[1 if label == "sample" else 0]
            write_probe(Path(sim_path) / PORT_PROBE_FILE, dt)
            return {"timestep_s": 0.0, "timesteps": 10, "solver_time_s": 0.0, "converged": True}

        def fake_evaluate(sim, n_freq=801, **kw):
            sim.results = {"frequency": list(np.linspace(sim.f_min, sim.f_max, n_freq))}
            return sim.results

        def fake_waves(sim):
            f = np.asarray(sim.results["frequency"])
            fx = fixtures[0]
            b = analytic_beta(f, fx.kc) * 1.003
            delay = lambda x: np.exp(-1j * b * x * 1e-3)   # noqa: E731
            l1, d, l2 = fx.front - fx.z_ref1, fx.back - fx.front, fx.z_ref2 - fx.back
            if sim is not fx.sim:
                return f, np.zeros(len(f), complex), delay(l1 + d + l2)
            eps, mu = layer_constants(f, module.analytic_layers(values)[0])
            if waves_eps is not None:
                eps = waves_eps(eps, f)
            s11, s21 = slab_s_single(f, eps, d, mu=mu, kc=fx.kc, beta0=b)
            return f, s11 * delay(2 * l1), delay(l1) * s21 * delay(l2)

        def recording_build(p):
            sim = module.build(p)
            fixtures.append(sim.waveguide_fixture)
            return sim

        wrapped = types.SimpleNamespace(build=recording_build, analytic_layers=module.analytic_layers)
        logged = []
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(Simulation, "run", fake_run), \
                mock.patch.object(Simulation, "evaluate", fake_evaluate), \
                mock.patch.object(waveguide_fixture, "two_port_s", fake_waves):
            out = run_cell(wrapped, values, sim_path=str(Path(tmp) / "wg"), threads=2, n_freq=41, nist=True,
                           log=logged.append)
        return out, own, logged

    def test_lossy_sample_is_recovered(self):
        out, own, _ = self.run_example({"tan_d": 0.02})
        self.assertEqual(out["setup"], "waveguide")
        self.assertEqual(out["run_stats"]["timestep_forced_s"], min(own.values()))
        self.assertLess(out["beta0"]["max_rel_difference"], 0.0031)
        self.assertGreater(out["beta0"]["max_rel_difference"], 0.0029)
        # the analytic comparison uses the analytic beta0, so it sees the numerical dispersion
        self.assertLess(out["analytic"]["deviation"]["max_abs_ds11"], 0.05)
        m = out["material"]
        self.assertLess(m["deviation"]["nrw"]["max_rel_eps_real"], 1e-6)
        self.assertLess(m["deviation"]["nrw"]["max_abs_tan_d"], 1e-6)
        self.assertLess(m["deviation"]["nist"]["max_rel_eps_real"], 1e-6)

    def test_result_file_fields(self):
        out, _, _ = self.run_example({})
        doc = to_json(out, {"id": "wr90-fixture"}, [], "wr90")
        self.assertEqual(doc["setup"], "waveguide")
        self.assertEqual(doc["cell"]["setup"], "waveguide")
        self.assertEqual(len(doc["z_ref"]), 41)
        k0 = 2 * np.pi * np.asarray(doc["frequency"]) / C0
        np.testing.assert_allclose(doc["z_ref"], ETA0 * k0 / analytic_beta(doc["frequency"], KC))
        self.assertEqual(len(doc["beta0"]["measured"]), 41)
        self.assertIn("s21_faces", doc["empty"])
        self.assertIn("guided", doc["analytic"]["method"])

    def test_air_gap_is_corrected(self):
        """S-parameters of the apparent eps a 0.1 mm broad-wall gap gives: the result keeps the
        apparent values and adds the corrected ones, which recover the sample."""
        gx, gy = 0.2, 0.1

        def waves(eps, f):      # the resonance model's broad-wall gap, then the narrow-wall weighting
            col = np.array([resonance_apparent(e, gy, fi) for e, fi in zip(eps, f)])
            return apparent_eps(col, gx, 0.0)

        out, _, _ = self.run_example({"tan_d": 0.02, "gap_x": gx, "gap_y": gy}, waves_eps=waves)
        m = out["material"]
        self.assertGreater(m["deviation"]["nist"]["max_rel_eps_real"], 0.04)        # apparent: ~5 % low
        g = m["gap_correction"]
        self.assertEqual((g["gap_x"], g["gap_y"]), (gx, gy))
        self.assertLess(g["deviation"]["nist"]["max_rel_eps"], 1e-6)
        self.assertLess(g["deviation"]["nrw"]["max_rel_eps"], 1e-6)
        self.assertGreater(g["capacitor"]["deviation"]["nist"]["max_rel_eps"], 0.002)  # quasi-static: overshoots
        doc = to_json(out, {"id": "wr90-fixture"}, [], "wr90")
        self.assertEqual(set(doc["material"]["gap_correction"]),
                         {"gap_x", "gap_y", "model", "deviation", "nrw", "nist", "capacitor"})
        self.assertEqual(set(doc["material"]["gap_correction"]["capacitor"]), {"model", "deviation", "nrw", "nist"})
        self.assertEqual(len(doc["material"]["gap_correction"]["nist"]["eps_r"]["re"]), 41)
        self.assertEqual(doc["cell"]["air_gap"]["gap_y"], gy)
        self.assertIn("air gap is not in it", doc["analytic"]["method"])
        with contextlib.redirect_stdout(io.StringIO()) as printed, contextlib.redirect_stderr(io.StringIO()):
            status = _print_material(m, out["result"]["f"], 1e-3)   # checks the corrected values only
        self.assertEqual(status, 0)
        self.assertIn("corrected for the air gap", printed.getvalue())

    def test_refuses_runs_at_different_timesteps(self):
        with self.assertRaises(RuntimeError):
            self.run_example(ran=(1.0e-12, 1.01e-12))

    def test_the_step_comes_from_the_port_probe(self):
        out, own, _ = self.run_example()
        for label in ("reference", "sample"):
            self.assertAlmostEqual(out["run_stats"][label]["timestep_s"] / min(own.values()), 1.0, places=9)
            self.assertIn(PORT_PROBE_FILE, out["run_stats"][label]["timestep_source"])

    def dispersive_module(self, model):
        """A WR-90 model with a dispersive sample (Simulation.dispersive; a Debye pole is fitted to
        Lorentz poles there) and its simulated poles as the analytic layer."""
        def build(p):
            sim = Simulation(8.2e9, 12.4e9, excitation="gauss")
            fx = WaveguideFixture(sim, 0.0, 10.0, eps_max=5.0)
            sim.dispersive("sample", model).AddBox(*fx.span(0.0, 10.0))
            return sim

        return types.SimpleNamespace(PARAMS=[], build=build, analytic_layers=lambda p: [
            {"thickness": 10.0, "dispersion": build(p).dispersions["sample"]}])

    def test_dispersive_debye_sample(self):
        """A Debye sample (relaxation at 10 GHz, in the band) against the guided slab of its
        simulated poles: NRW and NIST recover eps(f) from the guided S-parameters."""
        from fairbeam.dispersion import Debye, Dispersion

        out, _, _ = self.run_example(module=self.dispersive_module(Dispersion(3.0, (Debye(1.5, 1 / (2 * np.pi * 10e9)),))))
        m = out["material"]
        eps = m["expected"]["eps_r"]
        self.assertGreater(np.ptp(eps.real), 0.1)                 # dispersive across the band
        self.assertGreater(np.max(-eps.imag / eps.real), 0.1)
        self.assertLess(m["deviation"]["nrw"]["max_rel_eps"], 1e-6)
        self.assertLess(m["deviation"]["nist"]["max_rel_eps"], 1e-6)

    def test_unresolved_dispersive_poles_are_refused_in_the_guide(self):
        from fairbeam.dispersion import Dispersion, Lorentz

        with self.assertRaises(ValueError) as ctx:   # tau 0.1 ps is far below the 1 ps step
            self.run_example(module=self.dispersive_module(Dispersion(3.0, (Lorentz(2e9, 4e9, 1e-13),))))
        self.assertIn("does not resolve", str(ctx.exception))

    def test_plane_wave_result_keeps_its_setup(self):
        out = {"result": {"f": F, "s11": F * 0j, "s21": F * 0j + 1, "R2": F * 0, "T2": F * 0 + 1,
                          "absorption": F * 0}, "cell": {}, "run_stats": {}, "wall_time_total_s": 0.0,
               "sim": Simulation(1e9, 10e9)}
        doc = to_json(out, {"id": "x"}, [], "x")
        self.assertEqual(doc["setup"], "plane-wave")
        self.assertIsInstance(doc["z_ref"], float)


class ExampleModel(unittest.TestCase):
    def test_wr90_example_builds(self):
        module = load_model(EXAMPLE)
        values = resolve_params(module.PARAMS, {})
        sim = module.build(values)
        fx = sim.waveguide_fixture
        self.assertIsInstance(fx, WaveguideFixture)
        self.assertEqual(fx.warnings, [])
        self.assertEqual(module.analytic_layers(values)[0]["thickness"], fx.back - fx.front)
        self.assertIn("sample", sim.materials)
        self.assertIsNone(getattr(sim, "material_cell", None))


if __name__ == "__main__":
    unittest.main()
