"""Analytic regressions from the Windows PR284 review; no FDTD runs."""
import unittest
import contextlib
import io
import numpy as np
from fairbeam.dispersion import Debye, Dispersion, Drude, Lorentz, DjordjevicSarkar, resolution_problems
from fairbeam.debye_fit import fit, fit_model
from fairbeam.nrw import BRANCH_MU_TOL, nrw, slab_s_single, compare_material
from fairbeam.simulation import Simulation
from fairbeam.material_cell import extract_material, _print_material

class RetrievalValidation(unittest.TestCase):
    f = np.linspace(1e9, 10e9, 101)

    def test_initial_opaque_drude_is_never_trusted_without_constraint(self):
        model = Dispersion(2, (Drude(6e9, 1e-9),))
        for thickness in (60, 100):
            s11, s21 = slab_s_single(self.f, model.eps(self.f), thickness)
            self.assertLess(abs(s21[0]), 1e-3)
            unconstrained = nrw(self.f, s11, s21, thickness)
            self.assertTrue(unconstrained["segments"][0]["after_opaque"])
            self.assertFalse(unconstrained["reliable"].any())
            constrained = nrw(self.f, s11, s21, thickness, nonmagnetic=True)
            mask = constrained["reliable"]
            self.assertTrue(mask.any())
            np.testing.assert_allclose(constrained["eps_r"][mask], model.eps(self.f)[mask], rtol=1e-8)
            self.assertFalse(constrained["reliable"][abs(s21) < 1e-3].any())

    def test_all_opaque_and_singletons_have_no_retrieval(self):
        for thickness, alternate in ((300, False), (10, True)):
            s11, s21 = slab_s_single(self.f, 4-10j if not alternate else 4-.01j, thickness)
            if alternate: s21[1::2] = 1e-5
            result = nrw(self.f, s11, s21, thickness)
            self.assertEqual(result["segments"], [])
            self.assertIsNone(result["branch"])
            self.assertFalse(result["reliable"].any())
            self.assertTrue(np.isnan(result["eps_r"]).all())
            self.assertEqual(compare_material(self.f, result, np.full(len(self.f), 4), mask=result["reliable"])["points"], 0)

    def test_empty_retrieval_cli_reports_failure(self):
        s11, s21 = slab_s_single(self.f, 4-10j, 300)
        material = extract_material({"f": self.f, "s11": s11, "s21": s21}, 300)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(_print_material(material, self.f, None), 1)

    def test_false_nonmagnetic_declaration_cannot_resolve_a_branch(self):
        # above an opaque band the unit-mu branch is the only one: a magnetic sample stays untrusted,
        # also on a stretch of only 10 % above a Drude band (fp 9 GHz, 200 mm)
        for f_plasma, thickness in ((6e9, 60), (9e9, 200)):
            model = Dispersion(2, (Drude(f_plasma, 1e-9),))
            s11, s21 = slab_s_single(self.f, model.eps(self.f), thickness, mu=2)
            self.assertLess(abs(s21[0]), 1e-3)
            result = nrw(self.f, s11, s21, thickness, nonmagnetic=True)
            self.assertTrue(result["segments"][0]["after_opaque"])
            self.assertFalse(result["reliable"].any())
            self.assertFalse(result["segments"][0]["branch_resolved"])

    def test_thick_magnetic_sample_in_a_narrow_band_is_not_taken_for_mu_1(self):
        # 9.5-10 GHz, 100 mm, eps 3, mu 2: one wrong branch keeps mu_r within BRANCH_MU_TOL of 1 over
        # the whole band (an eps 1.5, mu 1 slab one 2 pi turn off); only the group delay rejects it
        f = np.linspace(9.5e9, 10e9, 51)
        eps, mu, d = 3 - .03j, 2.0, 100.0
        s11, s21 = slab_s_single(f, eps, d, mu=mu)
        bd = np.sqrt(eps * mu) * 2 * np.pi * f / 299792458.0 * d * 1e-3
        self.assertTrue(any(np.max(np.abs(mu * (bd - 2 * np.pi * k) / bd - 1)) <= BRANCH_MU_TOL for k in range(1, 50)))
        declared = nrw(f, s11, s21, d, nonmagnetic=True)
        self.assertFalse(declared["reliable"].any())
        self.assertIn("disagree", declared["segments"][0]["method"])
        plain = nrw(f, s11, s21, d)
        self.assertTrue(plain["reliable"].any())
        np.testing.assert_allclose(plain["mu_r"][plain["reliable"]], mu, rtol=1e-9)

    def test_false_declaration_at_the_band_start_keeps_the_group_delay(self):
        # from the band's first sample the group delay holds without the declaration, so a magnetic
        # sample under --nist still gets its NRW result (and the command warns that NIST does not apply)
        s11, s21 = slab_s_single(self.f, 3-.06j, 10, mu=2)
        result = nrw(self.f, s11, s21, 10, nonmagnetic=True)
        seg = result["segments"][0]
        self.assertTrue(seg["branch_resolved"])
        self.assertIn("mu_r = 1 unresolved", seg["method"])
        mask = result["reliable"]
        self.assertTrue(mask.any())
        np.testing.assert_allclose(result["mu_r"][mask], 2, rtol=1e-9)
        np.testing.assert_allclose(result["eps_r"][mask], 3-.06j, rtol=1e-9)

    def test_declared_nonmagnetic_takes_the_unit_mu_branch_from_the_band_start(self):
        s11, s21 = slab_s_single(self.f, 4-.08j, 10)
        result = nrw(self.f, s11, s21, 10, nonmagnetic=True)
        self.assertEqual(result["segments"][0]["method"], "mu_r = 1")
        self.assertEqual(result["branch"], nrw(self.f, s11, s21, 10)["branch"])

    def test_frequency_and_geometry_validation(self):
        for frequency in ([1e9], [2e9, 1e9], [0, 1e9], [1e9, np.nan]):
            with self.assertRaises(ValueError): nrw(frequency, np.full(len(frequency), .1), np.full(len(frequency), .5), 10)
        for thickness in (np.nan, np.inf, -1, 0):
            with self.assertRaises(ValueError): nrw(self.f, np.full(len(self.f), .1), np.full(len(self.f), .5), thickness)

class MaterialValidation(unittest.TestCase):
    def test_nonfinite_constants_and_poles_rejected(self):
        for value in (np.nan, np.inf, -np.inf):
            for constructor in (lambda: Dispersion(value), lambda: Dispersion(kappa=value),
                                lambda: Debye(value, 1e-9), lambda: Debye(1, value),
                                lambda: Lorentz(value, 0, 1e-9), lambda: Lorentz(1e9, value, 1e-9),
                                lambda: Lorentz(1e9, 0, value), lambda: DjordjevicSarkar(4, value),
                                lambda: resolution_problems(Dispersion(4), value)):
                with self.assertRaises(ValueError): constructor()
        zero = Dispersion(1, (Debye(0, 1e-9), Drude(0, 1e-9)))
        self.assertEqual(zero.eps(0), 1)
        for value in (np.nan, np.inf, -1):
            with self.assertRaises(ValueError): zero.eps(value)

    def test_zero_band_center_permittivity_is_serializable(self):
        center = 2e9
        model = Dispersion(1, (Drude(np.sqrt(2)*center, 1/(2*np.pi*center)),))
        self.assertEqual(model.eps(center).real, 0)
        sim = Simulation(1e9, 3e9)
        prop = sim.dispersive("zero", model)
        self.assertEqual(prop.GetTypeString(), "LorentzMaterial")
        self.assertIsNone(sim.materials["zero"].get("tan_d"))
        self.assertEqual(sim.materials["zero"]["eps_r"], 0)

    def test_fit_control_and_datasheet_validation(self):
        f = np.linspace(1e9, 10e9, 30)
        for kw in ({"dt": -1}, {"dt": 0}, {"dt": np.nan}, {"n_poles": -1}, {"n_poles": 1.5}, {"f_lo": np.inf}):
            with self.assertRaises(ValueError): fit(f, np.full(len(f), 4-.1j), **kw)
        for point in ((0, 4, .02), (1e9, np.nan, .02), (1e9, 4, -.02)):
            with self.assertRaises(ValueError): DjordjevicSarkar.from_datasheet([point])
        with self.assertRaises(ValueError): fit_model(Dispersion(4), 10e9, 1e9)
