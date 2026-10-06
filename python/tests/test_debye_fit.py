"""Pole fitting (fairbeam.debye_fit): NNLS, fits to Djordjevic-Sarkar laminates, to known pole
models and to measured / NRW-extracted eps_r(f) (CSV, .cell.json), the timestep bound on the
poles, and the ``fairbeam debye-fit`` command (no FDTD run)."""

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from fairbeam.cli import main
from fairbeam.debye_fit import (DS_SPAN, default_dt, fit, fit_ds, fit_model, nnls, pole_limits, read_eps)
from fairbeam.dispersion import Debye, Dispersion, DjordjevicSarkar, Drude, Lorentz, resolution_problems

TWO_PI = 2 * np.pi
FR4 = DjordjevicSarkar.from_datasheet([(1e9, 4.4, 0.02)])


class Nnls(unittest.TestCase):
    def test_against_brute_force(self):
        rng = np.random.default_rng(3)
        for _ in range(20):
            a, b = rng.standard_normal((12, 4)), rng.standard_normal(12)
            x = nnls(a, b)
            self.assertTrue(np.all(x >= 0))
            best = np.inf
            for mask in range(16):                 # every active set: the true optimum
                cols = [k for k in range(4) if mask >> k & 1]
                if not cols:
                    best = min(best, np.linalg.norm(b))
                    continue
                z = np.linalg.lstsq(a[:, cols], b, rcond=None)[0]
                if np.all(z >= 0):
                    best = min(best, np.linalg.norm(a[:, cols] @ z - b))
            self.assertAlmostEqual(np.linalg.norm(a @ x - b), best, places=9)

    def test_exact_non_negative_solution(self):
        a = np.array([[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]])
        np.testing.assert_allclose(nnls(a, a @ [2.0, 0.5]), [2.0, 0.5], atol=1e-12)


class LaminateFit(unittest.TestCase):
    def test_fr4_over_the_band(self):
        dt = 1.0e-12
        disp, rep = fit_ds(FR4, 1e9, 10e9, dt=dt)
        self.assertEqual(disp.model, "lorentz")
        self.assertLess(rep["max_rel_eps_real"], 0.001)
        self.assertLess(rep["max_abs_tan_d"], 0.0005)
        self.assertEqual(rep["resolution_problems"], [])
        band = np.linspace(1e9, 10e9, 50)
        self.assertLess(np.ptp(disp.tan_d(band)), 0.002)            # nearly constant, as the laminate
        np.testing.assert_allclose(disp.eps(band).real, FR4.eps(band).real, rtol=1e-3)
        self.assertEqual(disp.source["model"], "djordjevic-sarkar")
        self.assertEqual(disp.source["fit"]["span"], DS_SPAN)

    def test_poles_respect_the_timestep(self):
        for dt in (0.6e-12, 1.0e-12, 2.0e-12, 3.0e-12):
            disp, rep = fit_ds(FR4, 1e9, 10e9, dt=dt)
            self.assertEqual(resolution_problems(disp, dt), [], dt)
            _, f_cap = pole_limits(dt)
            for p in disp.eps_poles:
                f_relax = (TWO_PI * p.f_pole) ** 2 * p.tau / TWO_PI    # wL^2 / gamma
                self.assertLessEqual(f_relax, f_cap * (1 + 1e-9))
                self.assertLessEqual(f_relax, 10e9 * DS_SPAN * (1 + 1e-9))
        # a finer timestep allows the relaxations above the band, so the fit gets better
        coarse = fit_ds(FR4, 1e9, 10e9, dt=3e-12)[1]["max_abs_tan_d"]
        fine = fit_ds(FR4, 1e9, 10e9, dt=0.6e-12)[1]["max_abs_tan_d"]
        self.assertLess(fine, coarse)

    def test_default_timestep(self):
        self.assertAlmostEqual(default_dt(10e9), 1 / (20 * np.sqrt(3) * 10e9))
        self.assertAlmostEqual(default_dt(10e9, 4.0), default_dt(10e9) / 2)
        self.assertEqual(fit_ds(FR4, 1e9, 10e9)[1]["dt"], default_dt(10e9, float(FR4.eps(1e8).real)))

    def test_too_coarse_a_timestep_is_refused(self):
        with self.assertRaises(ValueError):
            fit_ds(FR4, 1e9, 10e9, dt=1e-9)

    def test_debye_with_lorentz_or_drude_poles_keeps_them(self):
        # Overdamped poles cannot represent a resonance or eps' < 1: only the Debye part is fitted,
        # the Lorentz / Drude poles pass through, rescaled to the fitted eps_inf
        dt = 1e-12
        band = np.linspace(1e9, 10e9, 200)
        for extra in (Drude(3e9, 1 / (TWO_PI * 0.5e9)), Lorentz(3e9, 6e9, 1 / (TWO_PI * 0.6e9))):
            model = Dispersion(3.0, (Debye(2.0, 1 / (TWO_PI * 3e9)), extra), kappa=0.01)
            disp, rep = fit_model(model, 1e9, 10e9, dt=dt)
            self.assertEqual(disp.model, "lorentz")
            self.assertEqual(disp.kappa, 0.01)
            kept = disp.eps_poles[-1]
            self.assertEqual((kept.f_pole, kept.tau), (extra.f_pole, extra.tau))
            self.assertAlmostEqual(disp.eps_inf * kept.f_plasma ** 2, model.eps_inf * extra.f_plasma ** 2,
                                   delta=1e-9 * model.eps_inf * extra.f_plasma ** 2)
            self.assertLess(rep["max_rel_eps"], 0.01)
            np.testing.assert_allclose(disp.eps(band), model.eps(band), rtol=0.01)
            self.assertEqual(resolution_problems(disp, dt), [])


class DataFit(unittest.TestCase):
    def test_recovers_a_model_of_its_own_form(self):
        # overdamped Lorentz poles with the fit's damping, relaxing inside the band
        dt = 1e-12
        gamma, _ = pole_limits(dt)
        eps_inf = 3.0

        def pole(f_relax, strength):
            f_pole = np.sqrt(f_relax * gamma / TWO_PI)
            return Lorentz(f_pole * np.sqrt(strength / eps_inf), f_pole, 1 / gamma)

        f = np.linspace(1e9, 10e9, 200)
        truth = Dispersion(eps_inf, (pole(2e9, 0.8), pole(6e9, 0.4)))
        disp, rep = fit(f, truth.eps(f), dt=dt)
        self.assertLess(rep["max_rel_eps_real"], 0.002)
        self.assertLess(rep["max_abs_tan_d"], 0.002)
        self.assertEqual(resolution_problems(disp, dt), [])

    def test_single_debye_pole_data(self):
        f = np.linspace(0.5e9, 20e9, 300)
        truth = Dispersion(3.0, (Debye(2.0, 1 / (TWO_PI * 3e9)),))
        disp, rep = fit(f, truth.eps(f), dt=0.5e-12)
        self.assertLess(rep["max_rel_eps_real"], 0.01)       # a Debye pole from Lorentz-form poles
        self.assertGreaterEqual(disp.eps_inf, 1.0)
        self.assertTrue(np.all(disp.eps(f).imag <= 1e-12))          # passive

    def test_conductivity(self):
        f = np.linspace(1e9, 10e9, 100)
        eps = 4.0 - 1j * 0.05 / (TWO_PI * f * 8.8541878128e-12)
        disp, rep = fit(f, eps, dt=1e-12, fit_kappa=True)
        self.assertAlmostEqual(disp.kappa, 0.05, delta=0.005)

    def test_noisy_data_stays_passive(self):
        f = np.linspace(1e9, 10e9, 200)
        rng = np.random.default_rng(5)
        eps = FR4.eps(f) * (1 + 0.003 * rng.standard_normal(len(f)))
        disp, rep = fit(f, eps, dt=1e-12)
        self.assertTrue(np.all(disp.eps(f).imag < 0))
        self.assertLess(rep["max_rel_eps_real"], 0.02)


class Inputs(unittest.TestCase):
    def test_csv_both_layouts(self):
        f = np.linspace(1e9, 10e9, 20)
        e = FR4.eps(f)
        with tempfile.TemporaryDirectory() as tmp:
            a = Path(tmp) / "a.csv"
            a.write_text("# measured\nf,eps_re,eps_im\n" + "".join(f"{x},{v.real},{v.imag}\n" for x, v in zip(f, e)))
            b = Path(tmp) / "b.csv"
            b.write_text("frequency,eps_r,tan_d\n" + "".join(f"{x},{v.real},{-v.imag / v.real}\n" for x, v in zip(f, e)))
            for p in (a, b):
                ff, ee, info = read_eps(p)
                np.testing.assert_allclose(ff, f)
                np.testing.assert_allclose(ee, e, rtol=1e-12)
                self.assertEqual((info["points"], info["used"]), (20, 20))

    def test_csv_non_finite_rows_are_left_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "c.csv"
            p.write_text("f,eps_r,tan_d\n1e9,4.4,0.02\n2e9,nan,0.02\n3e9,4.3,inf\n4e9,4.3,0.02\n")
            ff, ee, info = read_eps(p)
            np.testing.assert_allclose(ff, [1e9, 4e9])
            self.assertEqual(info["dropped"], {"non_finite": 2})

    def cell_json(self, tmp, with_nist=True, converged=None, s21=None, name="x"):
        f = np.linspace(1e9, 10e9, 30)
        e = FR4.eps(f)
        rel = [True] * 30
        rel[5] = False
        eps = {"re": list(e.real), "im": list(e.imag)}
        bad = dict(eps, re=[None if i == 5 else v for i, v in enumerate(e.real)])
        mat = {"thickness": 10.0, "nrw": {"eps_r": bad, "reliable": rel}}
        if with_nist:
            mat["nist"] = {"eps_r": eps}
            if converged is not None:
                mat["nist"]["converged"] = converged
        doc = {"kind": "fairbeam.material-cell", "frequency": list(f), "material": mat}
        if s21 is not None:
            doc["s21"] = {"re": list(np.real(s21)), "im": list(np.imag(s21))}
        p = Path(tmp) / f"{name}.cell.json"
        p.write_text(json.dumps(doc))
        return p, f, e

    def test_cell_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            p, f, e = self.cell_json(tmp)
            ff, ee, info = read_eps(p)                            # nist when present
            self.assertEqual(len(ff), 30)
            self.assertEqual(info["method"], "nist")
            ff, ee, info = read_eps(p, "nrw")                     # only reliable, finite NRW points
            self.assertEqual(len(ff), 29)
            self.assertNotIn(f[5], ff)
            self.assertEqual(info["dropped"], {"non_finite": 1, "unreliable": 0})
            p2, *_ = self.cell_json(tmp, with_nist=False, name="y")
            self.assertEqual(len(read_eps(p2)[0]), 29)            # auto falls back to nrw
            with self.assertRaises(ValueError):
                read_eps(p2, "nist")

    def test_unconverged_nist_points_are_left_out(self):
        # #284 review: finite last iterates of a non-converged NIST solve must not be fitted
        with tempfile.TemporaryDirectory() as tmp:
            conv = [k % 2 == 0 for k in range(30)]
            p, f, e = self.cell_json(tmp, converged=conv)
            ff, ee, info = read_eps(p)
            np.testing.assert_allclose(ff, f[::2])
            self.assertEqual((info["used"], info["dropped"]["not_converged"]), (15, 15))
            # four finite samples, two of them unconverged: only two are left, too few to fit
            p4 = Path(tmp) / "four.cell.json"
            doc = json.loads(p.read_text())
            doc["frequency"] = doc["frequency"][:4]
            nist = doc["material"]["nist"]
            nist["eps_r"] = {"re": nist["eps_r"]["re"][:4], "im": nist["eps_r"]["im"][:4]}
            nist["converged"] = [True, False, True, False]
            doc["material"].pop("nrw")
            p4.write_text(json.dumps(doc))
            ff, ee, info = read_eps(p4)
            self.assertEqual(len(ff), 2)
            with self.assertRaisesRegex(ValueError, "valid samples"):
                fit(ff, ee, dt=1e-12)

    def test_low_transmission_points_are_left_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            s21 = np.full(30, 0.5 + 0j)
            s21[10:14] = 1e-4                                     # below -60 dB: opaque
            s21[20] = np.nan
            p, f, e = self.cell_json(tmp, s21=s21)
            ff, ee, info = read_eps(p)
            self.assertEqual(info["dropped"]["low_s21"], 5)
            self.assertNotIn(f[11], ff)
            self.assertEqual(len(ff), 25)

    def test_masks_are_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            p, *_ = self.cell_json(tmp, converged=[True] * 29)    # one short
            with self.assertRaisesRegex(ValueError, "converged"):
                read_eps(p)
            p, *_ = self.cell_json(tmp, converged=[1] * 30, name="ints")
            with self.assertRaisesRegex(ValueError, "booleans"):
                read_eps(p)
            p, *_ = self.cell_json(tmp, s21=np.ones(29), name="s21")
            with self.assertRaisesRegex(ValueError, "s21"):
                read_eps(p)

    def test_too_few_samples_for_the_poles(self):
        f = np.linspace(1e9, 10e9, 6)
        with self.assertRaisesRegex(ValueError, "only 6 valid samples for 8 candidate poles"):
            fit(f, FR4.eps(f), dt=1e-12, n_poles=8)
        disp, _ = fit(f, FR4.eps(f), dt=1e-12, n_poles=5)          # 6 unknowns: enough
        self.assertGreater(disp.eps_inf, 1)


class Command(unittest.TestCase):
    def test_datasheet(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "fr4.dispersion.json"
            rc = main(["debye-fit", "--datasheet", "1e9:4.4:0.02", "--f-min", "1e9", "--f-max", "10e9",
                       "--dt", "1e-12", "-o", str(out)])
            self.assertEqual(rc, 0)
            disp = Dispersion.load(out)
            self.assertEqual(disp.model, "lorentz")
            self.assertLess(disp.source["report"]["max_abs_tan_d"], 0.0005)
            self.assertAlmostEqual(disp.source["eps_inf"], FR4.eps_inf)

    def test_input_file_and_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            p, f, e = Inputs().cell_json(tmp, converged=[k != 3 for k in range(30)])
            self.assertEqual(main(["debye-fit", str(p), "--dt", "1e-12"]), 0)
            out = Path(tmp) / "x.dispersion.json"
            self.assertTrue(out.exists())
            samples = Dispersion.load(out).source["samples"]          # what was left out is recorded
            self.assertEqual((samples["used"], samples["dropped"]["not_converged"]), (29, 1))
            self.assertEqual(main(["debye-fit"]), 2)                                  # nothing to fit
            self.assertEqual(main(["debye-fit", "--datasheet", "1e9:4.4:0.02"]), 2)    # no band


if __name__ == "__main__":
    unittest.main()
