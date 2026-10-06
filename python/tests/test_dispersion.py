"""Dispersive materials (fairbeam.dispersion): the Debye / Lorentz / Drude formulas against openEMS'
own (matlab CalcDebyeMaterial / CalcLorentzMaterial), the CSXCAD properties, the Djordjevic-Sarkar
laminate, the pole-resolution checks, Simulation.dispersive and the bundle record (no FDTD run)."""

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from fairbeam.analytic import layer_constants, slab_s
from fairbeam.dispersion import (EPS0, Debye, Dispersion, DjordjevicSarkar, Drude, Lorentz,
                                 resolution_problems)
from fairbeam.geometry import read_structure
from fairbeam.simulation import Simulation

F = np.linspace(1e9, 10e9, 91)
TWO_PI = 2 * np.pi


def tau(f_c):
    return 1 / (TWO_PI * f_c)


def calc_lorentz(f, eps_r, kappa, plasma, pole, t_relax):
    """openEMS matlab CalcLorentzMaterial, transcribed."""
    w = TWO_PI * f
    e = np.ones(len(f)) * eps_r - 1j * kappa / (TWO_PI * f) / EPS0
    for fp, fl, t in zip(plasma, pole, t_relax):
        w_r = 1 / t if t > 0 else 0
        e = e - eps_r * (TWO_PI * fp) ** 2 / (w ** 2 - (TWO_PI * fl) ** 2 - 2j * np.pi * f * w_r)
    return e


def calc_debye(f, eps_r, kappa, deltas, t_relax):
    """openEMS matlab CalcDebyeMaterial, transcribed."""
    e = np.ones(len(f)) * eps_r - 1j * kappa / (TWO_PI * f) / EPS0
    for d, t in zip(deltas, t_relax):
        e = e + d / (1 + 2j * np.pi * f * t)
    return e


class Formulas(unittest.TestCase):
    def test_lorentz_and_drude_match_openems(self):
        d = Dispersion(2.0, (Lorentz(3e9, 6e9, tau(0.6e9)), Drude(1e9, tau(0.2e9))), kappa=0.01)
        ref = calc_lorentz(F, 2.0, 0.01, [3e9, 1e9], [6e9, 0.0], [tau(0.6e9), tau(0.2e9)])
        np.testing.assert_allclose(d.eps(F), ref, rtol=1e-12)
        self.assertTrue(np.all(d.eps(F).imag < 0))                     # passive, e^{+j w t}

    def test_debye_matches_openems(self):
        d = Dispersion(3.0, (Debye(2.0, tau(3e9)),), kappa=0.002)
        np.testing.assert_allclose(d.eps(F), calc_debye(F, 3.0, 0.002, [2.0], [tau(3e9)]), rtol=1e-12)
        np.testing.assert_allclose(Dispersion(3.0, (Debye(2.0, 1e-9),)).eps([1.0]), [5.0], rtol=1e-6)  # DC limit

    def test_magnetic_lorentz(self):
        d = Dispersion(2.0, mu_inf=1.5, mu_poles=(Lorentz(2e9, 5e9, tau(0.5e9)),))
        np.testing.assert_allclose(d.mu(F), calc_lorentz(F, 1.5, 0.0, [2e9], [5e9], [tau(0.5e9)]), rtol=1e-12)
        np.testing.assert_allclose(d.eps(F), 2.0)

    def test_rules(self):
        # Debye poles describe the material; any number, also with Lorentz poles (realized by a fit)
        mixed = Dispersion(3.0, (Debye(1.0, 1e-10), Debye(1.0, 1e-11), Lorentz(1e9, 2e9, 1e-10)))
        self.assertEqual(mixed.model, "debye")
        with self.assertRaises(ValueError):
            Dispersion(3.0, mu_poles=(Debye(1.0, 1e-10),))                         # no magnetic Debye
        with self.assertRaises(ValueError):
            Dispersion(3.0, (Debye(-1.0, 1e-10),))                                 # active
        with self.assertRaises(ValueError):
            Dispersion(3.0, (Lorentz(1e9, 2e9, 0.0),))

    def test_round_trip(self):
        d = Dispersion(2.0, (Lorentz(3e9, 6e9, tau(0.6e9)),), kappa=0.01, mu_inf=1.2,
                       mu_poles=(Drude(1e9, 1e-10),), source={"model": "test"})
        back = Dispersion.from_dict(json.loads(json.dumps(d.to_dict())))
        self.assertEqual(back, d)
        self.assertEqual(back.source, {"model": "test"})
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(Dispersion.load(d.save(Path(tmp) / "m.dispersion.json")), d)


class Resolution(unittest.TestCase):
    def test_poles_against_the_timestep(self):
        dt = 1.6e-12
        self.assertEqual(resolution_problems(Dispersion(3.0, (Debye(2.0, tau(3e9)),)), dt), [])
        short = resolution_problems(Dispersion(3.0, (Debye(2.0, 1e-13),)), dt)
        self.assertEqual(len(short), 1)
        self.assertIn("tau", short[0])
        fast = resolution_problems(Dispersion(2.0, (Lorentz(3e9, 80e9, tau(1e9)),)), dt)
        self.assertTrue(any("pole frequency" in m for m in fast))


class DjordjevicSarkarModel(unittest.TestCase):
    def test_one_datasheet_point_is_exact(self):
        ds = DjordjevicSarkar.from_datasheet([(1e9, 4.4, 0.02)])
        e = ds.eps(1e9)
        self.assertAlmostEqual(e.real, 4.4, places=12)
        self.assertAlmostEqual(-e.imag / e.real, 0.02, places=12)

    def test_nearly_constant_loss_and_falling_permittivity(self):
        ds = DjordjevicSarkar.from_datasheet([(1e9, 4.4, 0.02)])
        td = ds.tan_d(F)
        self.assertLess(np.ptp(td), 0.0015)                     # 0.0190-0.0201 over 1-10 GHz
        self.assertTrue(np.all(np.diff(ds.eps(F).real) < 0))    # causal: eps' falls with f
        # a constant conductivity (Simulation.dielectric) would change tan d tenfold over the band
        self.assertGreater((0.02 * 5.5e9 / F).max() / (0.02 * 5.5e9 / F).min(), 9.9)

    def test_two_points_least_squares(self):
        exact = DjordjevicSarkar(4.1, 1.0)
        pts = [(f, exact.eps(f).real, exact.tan_d(f)) for f in (1e9, 10e9)]
        back = DjordjevicSarkar.from_datasheet(pts)
        self.assertAlmostEqual(back.eps_inf, 4.1, places=9)
        self.assertAlmostEqual(back.delta, 1.0, places=9)

    def test_limits(self):
        ds = DjordjevicSarkar(4.0, 1.0)
        self.assertAlmostEqual(ds.eps(1e-3).real, 5.0, places=3)      # w << w1: eps_inf + delta
        self.assertAlmostEqual(ds.eps(1e15).real, 4.0, places=3)      # w >> w2: eps_inf
        with self.assertRaises(ValueError):
            DjordjevicSarkar(4.0, 1.0, m1=12, m2=4)


class OpenEms(unittest.TestCase):
    def test_csxcad_properties(self):
        sim = Simulation(1e9, 10e9)
        with self.assertRaisesRegex(ValueError, "unstable"):                     # never a native DebyeMaterial
            Dispersion(3.0, (Debye(2.0, tau(3e9)),)).add_to(sim.csx, "deb")
        lor = Dispersion(2.0, (Lorentz(3e9, 6e9, tau(0.6e9)), Drude(1e9, tau(0.2e9))),
                         mu_inf=1.5, mu_poles=(Lorentz(2e9, 5e9, tau(0.5e9)),)).add_to(sim.csx, "lor")
        self.assertEqual(lor.GetTypeString(), "LorentzMaterial")
        self.assertEqual(lor.GetDispersionOrder(), 2)
        self.assertAlmostEqual(lor.GetDispersiveMaterialProperty("eps_plasma", 1), 1e9)
        self.assertAlmostEqual(lor.GetDispersiveMaterialProperty("eps_pole_freq", 0), 6e9)
        self.assertAlmostEqual(lor.GetDispersiveMaterialProperty("mue_pole_freq", 0), 5e9)
        self.assertAlmostEqual(lor.GetMaterialProperty("mue"), 1.5)
        plain = Dispersion(4.0).add_to(sim.csx, "plain")
        self.assertEqual(plain.GetTypeString(), "Material")

    def test_simulation_dispersive_records_and_exports(self):
        sim = Simulation(1e9, 10e9)
        d = Dispersion(2.0, (Lorentz(3e9, 6e9, tau(0.6e9)),))
        sim.dispersive("lor", d, label="Lorentz slab").AddBox([0, 0, 0], [1, 1, 1])
        sim.dielectric("plain", 4.0, 0.01).AddBox([2, 0, 0], [3, 1, 1])
        self.assertIs(sim.dispersions["lor"], d)
        rec = sim.materials["lor"]
        e = d.eps(5.5e9)
        self.assertAlmostEqual(rec["eps_r"], e.real)
        self.assertAlmostEqual(rec["tan_d"], -e.imag / e.real)
        self.assertEqual(rec["tan_d_freq"], 5.5e9)
        # the band-centre loss as a conductivity, as for a constant dielectric (the CST export
        # writes kappa as Sigma); the model's own static conductivity (0 here) stays in dispersion
        self.assertAlmostEqual(rec["kappa"], rec["tan_d"] * 2 * np.pi * 5.5e9 * EPS0 * rec["eps_r"],
                               delta=1e-9 * rec["kappa"])          # openEMS' eps0 differs in the 10th digit
        self.assertGreater(rec["kappa"], 0)
        self.assertEqual(rec["dispersion"]["kappa"], 0.0)
        self.assertEqual(rec["dispersion"]["model"], "lorentz")
        parts, _, _ = read_structure(sim.csx, sim.materials)
        by = {p["name"]: p for p in parts}
        self.assertEqual(by["lor"]["type"], "Material")          # a dielectric for the viewer and exporters
        self.assertEqual(by["lor"]["label"], "Lorentz slab")
        self.assertAlmostEqual(by["lor"]["material"]["eps_r"], e.real)
        self.assertAlmostEqual(by["lor"]["material"]["kappa"], rec["kappa"])
        self.assertEqual(by["lor"]["material"]["dispersion"]["eps_poles"][0]["f_pole"], 6e9)
        self.assertNotIn("dispersion", by["plain"]["material"])  # existing bundles are unchanged

    def test_simulation_dispersive_fits_a_laminate_to_the_mesh_timestep(self):
        sim = Simulation(1e9, 10e9)
        for axis in "xyz":
            sim.mesh.AddLine(axis, np.linspace(-5, 5, 11))
        dt = sim.cfl_timestep()
        self.assertAlmostEqual(dt, 1 / (299792458 * np.sqrt(3 / 1e-3 ** 2)), delta=1e-18)
        ds = DjordjevicSarkar.from_datasheet([(1e9, 4.4, 0.02)])
        sim.dispersive("fr4", ds)
        disp = sim.dispersions["fr4"]
        self.assertEqual(disp.model, "lorentz")
        self.assertEqual(resolution_problems(disp, dt), [])
        rep = sim.materials["fr4"]["dispersion"]["source"]["report"]
        self.assertAlmostEqual(rep["dt"], dt)
        self.assertLess(rep["max_rel_eps_real"], 0.002)
        self.assertLess(rep["max_abs_tan_d"], 0.001)

    def test_simulation_dispersive_realizes_debye_poles_as_lorentz(self):
        sim = Simulation(1e9, 10e9)
        for axis in "xyz":
            sim.mesh.AddLine(axis, np.linspace(-5, 5, 21))
        debye = Dispersion(3.0, (Debye(2.0, tau(3e9)), Debye(0.5, tau(20e9))), kappa=0.01,
                           mu_inf=1.2, mu_poles=(Drude(1e9, 1e-10),))
        prop = sim.dispersive("deb", debye)
        self.assertEqual(prop.GetTypeString(), "LorentzMaterial")
        real = sim.dispersions["deb"]
        self.assertEqual(real.model, "lorentz")
        self.assertEqual(real.kappa, 0.01)                         # kept, not fitted
        self.assertEqual(real.mu_poles, debye.mu_poles)            # mu poles pass through
        self.assertEqual(resolution_problems(real, sim.cfl_timestep()), [])
        src = sim.materials["deb"]["dispersion"]["source"]
        self.assertEqual(src["model"], "debye")
        self.assertEqual(len(src["eps_poles"]), 2)                 # the requested poles are kept as metadata
        self.assertLess(src["report"]["max_rel_eps_real"], 0.01)
        np.testing.assert_allclose(real.eps(F), debye.eps(F), rtol=0.02)

    def test_dispersive_rejects_other_models(self):
        with self.assertRaises(TypeError):
            Simulation(1e9, 10e9).dispersive("x", 4.0)


class JsonRoundTrips(unittest.TestCase):
    """A model written to JSON and read back keeps its frequency dependence on every path (#284 review)."""

    FR4 = DjordjevicSarkar.from_datasheet([(1e9, 4.4, 0.02)])
    MODELS = {
        "djordjevic-sarkar": FR4,
        "lorentz": Dispersion(2.0, (Lorentz(3e9, 6e9, tau(0.6e9)), Drude(1e9, tau(0.2e9))), kappa=0.01,
                              mu_inf=1.2, mu_poles=(Lorentz(2e9, 5e9, tau(0.5e9)),)),
        "debye": Dispersion(3.0, (Debye(2.0, tau(3e9)), Debye(0.5, tau(20e9)))),
        "constant": Dispersion(4.0, kappa=0.001),
    }

    @staticmethod
    def through_json(obj):
        return json.loads(json.dumps(obj))

    def test_model_from_dict_restores_every_model(self):
        from fairbeam.dispersion import model_from_dict

        for name, model in self.MODELS.items():
            back = model_from_dict(self.through_json(model.to_dict()))
            self.assertIs(type(back), type(model), name)
            self.assertEqual(back, model, name)                         # the same poles / parameters
            np.testing.assert_allclose(back.eps(F), model.eps(F), rtol=1e-14, err_msg=name)
        with self.assertRaisesRegex(ValueError, "unknown pole type|not a pole model"):
            model_from_dict({"model": "havriliak-negami", "eps_inf": 3.0})
        with self.assertRaisesRegex(ValueError, "not a pole model"):
            Dispersion.from_dict(self.FR4.to_dict())                    # no silent loss of delta, m1, m2

    def test_layer_constants_and_slab_s_object_vs_dictionary(self):
        # the reviewer's case: DjordjevicSarkar.to_dict() gave the same real 4.114830 at 1 and 10 GHz
        f = np.array([1e9, 10e9])
        eps, _ = layer_constants(f, {"thickness": 5.0, "dispersion": self.FR4.to_dict()})
        np.testing.assert_allclose(eps, [4.4 - 0.088j, self.FR4.eps(10e9)], rtol=1e-12)
        for name, model in self.MODELS.items():
            obj = {"thickness": 7.0, "dispersion": model}
            dic = {"thickness": 7.0, "dispersion": self.through_json(model.to_dict())}
            e1, m1 = layer_constants(F, obj)
            e2, m2 = layer_constants(F, dic)
            np.testing.assert_allclose(e2, e1, rtol=1e-14, err_msg=name)
            np.testing.assert_allclose(m2, m1, rtol=1e-14, err_msg=name)
            np.testing.assert_allclose(slab_s(F, [dic]), slab_s(F, [obj]), rtol=1e-12, atol=1e-15, err_msg=name)

    def test_simulation_dispersive_takes_the_dictionary(self):
        for name in ("djordjevic-sarkar", "lorentz", "debye"):
            model = self.MODELS[name]
            sims = []
            for m in (model, self.through_json(model.to_dict())):
                sim = Simulation(1e9, 10e9)
                for axis in "xyz":
                    sim.mesh.AddLine(axis, np.linspace(-5, 5, 21))
                sim.dispersive("m", m)
                sims.append(sim.dispersions["m"])
            self.assertEqual(sims[1], sims[0], name)                     # the same simulated poles
            self.assertEqual(sims[1].eps_poles, sims[0].eps_poles, name)

    def test_bundle_and_cell_record_round_trip(self):
        # parts[].material.dispersion (bundle) and materials[name].dispersion (bundle, .cell.json)
        sim = Simulation(1e9, 10e9)
        for axis in "xyz":
            sim.mesh.AddLine(axis, np.linspace(-5, 5, 21))
        sim.dispersive("fr4", self.FR4).AddBox([0, 0, 0], [1, 1, 1])
        sim.dispersive("lor", self.MODELS["lorentz"]).AddBox([2, 0, 0], [3, 1, 1])
        parts, _, _ = read_structure(sim.csx, sim.materials)
        by = {p["name"]: p for p in self.through_json(parts)}
        records = self.through_json(sim.materials)
        from fairbeam.dispersion import model_from_dict

        for name in ("fr4", "lor"):
            for d in (by[name]["material"]["dispersion"], records[name]["dispersion"]):
                back = model_from_dict(d)
                self.assertEqual(back, sim.dispersions[name])            # the simulated poles, exactly
                np.testing.assert_allclose(back.eps(F), sim.dispersions[name].eps(F), rtol=1e-14)
        # the laminate the poles were fitted to is restored from the record's source as well
        laminate = model_from_dict(records["fr4"]["dispersion"]["source"])
        self.assertEqual(laminate, self.FR4)

    def test_dispersion_file_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("lorentz", "debye", "constant"):
                model = self.MODELS[name]
                back = Dispersion.load(model.save(Path(tmp) / f"{name}.dispersion.json"))
                self.assertEqual(back, model, name)
                np.testing.assert_allclose(back.eps(F), model.eps(F), rtol=1e-14)

    def test_design_conversion_refuses_a_dispersive_material(self):
        # a Design has no dispersive dielectric yet (PR 3b): converting must not make it constant
        from fairbeam.example_design import ExampleConversionError, convert_example

        src = '''
import numpy as np
from fairbeam import Param, Simulation
from fairbeam.dispersion import DjordjevicSarkar
MODEL = {"id": "disp-board", "name": "Dispersive board", "description": "test", "reference": "test"}
PARAMS = [Param("h", 1.6, "Height", "mm")]
def build(p):
    sim = Simulation(1e9, 3e9, boundaries=["PML_8"] * 6)
    sim.metal("gnd").AddBox([-10, -10, 0], [10, 10, 0], priority=10)
    sim.metal("top").AddBox([-2, -2, p["h"]], [2, 2, p["h"]], priority=10)
    sim.dispersive("fr4", DjordjevicSarkar.from_datasheet([(1e9, 4.4, 0.02)])).AddBox([-10, -10, 0], [10, 10, p["h"]])
    sim.lumped_port(1, 50, [0, 0, 0], [0, 0, p["h"]], "z", priority=5)
    sim.auto_mesh(cells_per_wavelength=10)
    return sim
'''
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "disp_board.py"
            path.write_text(src, encoding="utf-8")
            with self.assertRaisesRegex(ExampleConversionError, "dispersive"):
                convert_example(path, "disp-board", "Dispersive board")


class AnalyticLayers(unittest.TestCase):
    def test_dispersion_layers(self):
        d = Dispersion(2.0, (Lorentz(3e9, 6e9, tau(0.6e9)),))
        for layer in ({"thickness": 5.0, "dispersion": d}, {"thickness": 5.0, "dispersion": d.to_dict()},
                      {"thickness": 5.0, "eps": d.eps}):
            eps, mu = layer_constants(F, layer)
            np.testing.assert_allclose(eps, d.eps(F))
            np.testing.assert_allclose(mu, 1.0)
        # constant layers are unchanged
        eps, _ = layer_constants(F, {"thickness": 5.0, "eps_r": 4.0, "tan_d": 0.02, "tan_d_freq": 5e9})
        np.testing.assert_allclose(eps, 4.0 * (1 - 0.02j * 5e9 / F))
        s = slab_s(F, [{"thickness": 5.0, "dispersion": d}])
        np.testing.assert_allclose(np.abs(s[:, 0, 0]) ** 2 + np.abs(s[:, 1, 0]) ** 2 <= 1 + 1e-12, True)


if __name__ == "__main__":
    unittest.main()
