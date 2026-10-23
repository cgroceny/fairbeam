"""Angular sampling propagation and storage; stubbed NF2FF/FDTD, no solver execution."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np

from fairbeam.design import DesignError, blank_design, module_for, to_python
from fairbeam.example_design import _read_design
from fairbeam.model import resolve_params
from fairbeam.multiport import decode_pattern_fields, element_pattern_section, merge, run_model
from fairbeam.pattern_grid import angular_grid, pattern_steps
from test_efficiency import FakeModelSim, make_sim, quiet


class AngularGrid(unittest.TestCase):
    def test_defaults_and_nondivisors_keep_poles_without_duplicate_seam(self):
        for steps in ((3, 5), (7, 11), (89.999999, 89.999999), (0.25, 90)):
            with self.subTest(steps=steps):
                theta, phi = angular_grid(*steps)
                self.assertEqual((theta[0], theta[-1], phi[0]), (0, 180, 0))
                self.assertTrue(np.all(np.diff(theta) > 0))
                self.assertTrue(np.all(np.diff(phi) > 0))
                self.assertLess(phi[-1], 360)
                self.assertLessEqual(np.max(np.diff(theta)), steps[0] + 1e-9)
        theta, phi = angular_grid()
        self.assertEqual((len(theta), len(phi)), (61, 72))

    def test_invalid_steps_are_rejected(self):
        for value in (0, -1, 0.249, 90.01, True, None, "3", float("nan"), float("inf")):
            for axis in (0, 1):
                with self.subTest(value=value, axis=axis), self.assertRaises(ValueError):
                    steps = [3, 5]
                    steps[axis] = value
                    pattern_steps(*steps)

    def test_evaluate_uses_model_steps_and_axis_override(self):
        sim = make_sim()
        sim.pattern_steps = (7, 11)
        result, _ = quiet(sim.evaluate, n_freq=5, pattern_freqs=[2e9])
        theta, phi = angular_grid(7, 11)
        np.testing.assert_array_equal(sim.nf2ff.calls[0]["theta"], theta)
        np.testing.assert_array_equal(sim.nf2ff.calls[0]["phi"], phi)
        self.assertEqual(result["farfield"][0]["requested_steps"], [7, 11])
        result, _ = quiet(sim.evaluate, n_freq=5, pattern_freqs=[2e9], theta_step=89.999999)
        stored = json.loads(json.dumps(result["farfield"][0], allow_nan=False))
        self.assertTrue(np.all(np.diff(stored["theta"]) > 0))
        self.assertEqual(stored["theta"][-1], 180)
        self.assertEqual(stored["requested_steps"], [89.999999, 11])
        self.assertEqual(sim._nf2ff["requested_steps"], [89.999999, 11])


class DesignSampling(unittest.TestCase):
    def test_design_export_and_readback_preserve_expression_result(self):
        d = blank_design("angular", "Angular")
        d["far_field"].update(theta_step="f0 / 2", phi_step="f0")
        module = module_for(d)
        namespace = {}
        exec(compile(to_python(d), "angular-export.py", "exec"), namespace)
        for override in ({}, {"f0": 4.0}):
            values = resolve_params(module.PARAMS, override)
            with contextlib.redirect_stdout(io.StringIO()):
                direct = module.build(values)  # in-memory geometry only; never sim.run()
                exported = namespace["build"](values)
                _, captured = _read_design(SimpleNamespace(build=lambda _: exported), values, Path("angular-export.py"))
            expected = (values["f0"] / 2, values["f0"])
            self.assertEqual(direct.pattern_steps, expected)
            self.assertEqual(exported.pattern_steps, expected)
            self.assertEqual((captured["far_field"]["theta_step"], captured["far_field"]["phi_step"]), expected)

    def test_invalid_default_and_parameter_override_cannot_reach_evaluation(self):
        d = blank_design("angular", "Angular")
        d["far_field"]["theta_step"] = 0
        with self.assertRaises(DesignError):
            to_python(d)
        d["far_field"]["theta_step"] = "f0"
        module = module_for(d)
        namespace = {}
        exec(compile(to_python(d), "angular-export.py", "exec"), namespace)
        values = resolve_params(module.PARAMS, {})
        values["f0"] = 100
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(DesignError):
                module.build(values)
            with self.assertRaises(ValueError):
                namespace["build"](values)


class MultiportSampling(unittest.TestCase):
    def test_every_port_gets_model_steps_or_explicit_override(self):
        for override in (None, (2, 4)):
            built = []

            class Fake(FakeModelSim):
                pattern_steps = (7, 11)

                def evaluate(self, n_freq, pattern_freqs, **angular):
                    self.angular = angular
                    super().evaluate(n_freq, pattern_freqs)

            def build(_):
                sim = Fake(run=len(built) - 1)
                built.append(sim)
                return sim

            with tempfile.TemporaryDirectory() as tmp:
                run_model(SimpleNamespace(build=build), {}, excite="all", sim_path=tmp,
                          n_freq=5, log=lambda *_: None, pattern_steps=override)
            expected = override or (7, 11)
            self.assertEqual([s.angular for s in built[1:]],
                             [{"theta_step": expected[0], "phi_step": expected[1]}] * 2)

    def test_invalid_override_prevents_even_stub_run(self):
        module = SimpleNamespace(build=lambda _: FakeModelSim())
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(FakeModelSim, "run") as run:
            with self.assertRaises(ValueError):
                run_model(module, {}, sim_path=tmp, pattern_steps=(0, 5))
            run.assert_not_called()


class PatternStorage(unittest.TestCase):
    def sims(self, steps=(7, 11)):
        theta, phi = angular_grid(*steps)
        f = np.linspace(1e9, 2e9, 5)

        def make(n):
            field = np.cos(np.deg2rad(theta))[:, None] * np.ones(len(phi)) + 0j
            res = SimpleNamespace(E_theta=[field], E_phi=[0.5j * field], r=1.0)
            ports = [SimpleNamespace(uf_inc=np.full(len(f), np.sqrt(50) if j == n else 0j),
                                     uf_ref=np.zeros(len(f)), Z_ref=50.0) for j in (1, 2)]
            return SimpleNamespace(_nf2ff={"theta": theta, "phi": phi, "freqs": [1.5e9],
                                          "res": res, "requested_steps": list(steps)}, _port_objs=ports,
                                   ports=[{"number": j, "start": [j, 0, 0], "stop": [j, 0, 1]} for j in (1, 2)],
                                   boundaries=["MUR"] * 6, nf2ff_center=[0, 0, 0])
        return [(1, make(1)), (2, make(2))], f

    def test_reduction_retains_pole_counts_budget_and_preserves_field_samples(self):
        sims, f = self.sims()
        section = element_pattern_section(sims[0][1], sims, f, max_bytes=600)
        self.assertGreater(section["decimation"], 1)
        self.assertEqual(section["source_shape"], [27, 33])
        self.assertEqual(section["requested_steps"], [7, 11])
        self.assertEqual((section["theta"][0], section["theta"][-1]), (0, 180))
        self.assertLess(section["phi"][-1], 360)
        self.assertLessEqual(np.prod(section["shape"]) * 4 * 4 * 4 / 3 * 2, 600)
        theta = np.asarray(section["theta"])
        for port in section["ports"]:
            et, ep = decode_pattern_fields(section, port["fields"][0])
            self.assertEqual(list(et.shape), section["shape"])
            np.testing.assert_allclose(et[:, 0].real, np.cos(np.deg2rad(theta)), atol=1 / 32767)
            np.testing.assert_allclose(ep[:, 0].imag, 0.5 * np.cos(np.deg2rad(theta)), atol=1 / 32767)

    def test_unreduced_coordinates_and_too_small_budget(self):
        sims, f = self.sims((89.999999, 89.999999))
        section = json.loads(json.dumps(element_pattern_section(sims[0][1], sims, f)))
        self.assertEqual(section["decimation"], 1)
        self.assertTrue(np.all(np.diff(section["theta"]) > 0))
        self.assertTrue(np.all(np.diff(section["phi"]) > 0))
        for budget in (1, 0, float("inf")):
            with self.subTest(budget=budget), self.assertRaises(ValueError):
                element_pattern_section(sims[0][1], sims, f, max_bytes=budget)

    def test_merge_reports_reduction_only_when_storage_really_reduces_grid(self):
        for budget, reduced in ((600, True), (2.5e6, False)):
            sims, f = self.sims()
            for _, sim in sims:
                sim.results = {"frequency": f.tolist(), "ports": {"1": {}, "2": {}}, "farfield": []}
                sim.run_stats = {"converged": True}
            err = io.StringIO()
            with mock.patch("fairbeam.multiport.element_pattern_section",
                            side_effect=lambda primary, sims, freq: element_pattern_section(primary, sims, freq, max_bytes=budget)):
                with contextlib.redirect_stderr(err):
                    merge(sims[0][1], sims, [1, 2], True)
            self.assertEqual("uses this coarser grid" in err.getvalue(), reduced)
            self.assertEqual(sims[0][1].results["element_patterns"]["decimation"] > 1, reduced)


if __name__ == "__main__":
    unittest.main()
