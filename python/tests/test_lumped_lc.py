"""Ideal L/C helpers and an opt-in native-runtime circuit control."""
import gc
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from fairbeam import Simulation
from fairbeam.example_design import _read_design


class LumpedLCTests(unittest.TestCase):
    def test_native_values_and_axes(self):
        sim = Simulation(1e9, 2e9)
        for axis in "xyz":
            a, c = [0., 0., 0.], [1., 1., 1.]
            el = sim.lumped_inductor("L" + axis, 10e-9, a, c, axis, label="Coil", priority=7)
            self.assertEqual(el.GetDirection(), "xyz".index(axis))
            self.assertEqual(el.GetLEtype(), 0)
            self.assertAlmostEqual(el.GetInductance(), 10e-9)
            self.assertEqual(el.GetPrimitive(0).GetPriority(), 7)
            self.assertEqual(sim.lumped_elements[-1]["label"], "Coil")
            el = sim.lumped_capacitor("C" + axis, 1e-12, c, a, axis)
            self.assertAlmostEqual(el.GetCapacity(), 1e-12)
            self.assertEqual(el.GetLEtype(), 0)
            self.assertTrue(np.isnan(el.GetResistance()))

    def test_invalid_input_does_not_create_properties(self):
        sim = Simulation(1e9, 2e9)
        for method in (sim.lumped_inductor, sim.lumped_capacitor):
            for value in (0, -1, float("nan"), float("inf")):
                with self.subTest(method=method.__name__, value=value), self.assertRaises(ValueError):
                    method("bad", value, [0, 0, 0], [1, 1, 1], "z")
            for a, c, axis in (([0, 0, 0], [1, 1, 1], "bad"),
                               ([0, 0], [1, 1, 1], "z"),
                               ([0, 0, 0], [1, float("inf"), 1], "z"),
                               ([0, 0, 0], [1, 1, 0], "z")):
                with self.assertRaises(ValueError):
                    method("bad", 1e-9, a, c, axis)
        self.assertEqual(sim.csx.GetAllProperties(), [])
        self.assertEqual(sim.lumped_elements, [])

    def test_metadata_and_resistor_compatibility(self):
        sim = Simulation(1e9, 2e9)
        for axis in "xyz":
            sim.mesh.AddLine(axis, [-1, 0, 1])
        sim.lumped_resistor("R1", 50, [0, 0, 0], [1, 1, 1], "z")
        sim.lumped_inductor("L1", 10e-9, [0, 0, 0], [1, 1, 1], "z")
        sim.lumped_capacitor("C1", 1e-12, [0, 0, 0], [1, 1, 1], "z")
        elements = sim.to_bundle({"id": "lc", "name": "LC"}, [])["lumped_elements"]
        self.assertEqual(elements[0], {"name": "R1", "label": "R1", "type": "resistor", "R": 50.,
                                       "topology": "parallel", "direction": "z",
                                       "start": [0., 0., 0.], "stop": [1., 1., 1.]})
        # main's native R/L/C schema: one "rlc" entry per element, only the given branch
        for element, key, value in ((elements[1], "L", 10e-9), (elements[2], "C", 1e-12)):
            self.assertEqual((element["type"], element["topology"], element[key]), ("rlc", "parallel", value))
            self.assertFalse({"R", "L", "C"} - {key} & set(element))
        json.dumps(elements, allow_nan=False)

    def test_reactances_do_not_void_lossless_opt_in(self):
        sim = Simulation(1e9, 2e9)
        sim.lossless = True
        sim.lumped_inductor("L1", 10e-9, [0, 0, 0], [1, 1, 1], "z")
        sim.lumped_capacitor("C1", 1e-12, [0, 0, 0], [1, 1, 1], "z")
        self.assertTrue(sim._is_lossless())
        sim.lumped_resistor("R1", 50, [0, 0, 0], [1, 1, 1], "z")
        self.assertFalse(sim._is_lossless())
        sim = Simulation(1e9, 2e9)
        sim.lossless = True
        sim.lumped_element("RL", [0, 0, 0], [1, 1, 1], "z", R=50, L=1e-9)
        self.assertFalse(sim._is_lossless())   # an "rlc" element with R is lossy

    def test_design_conversion_keeps_the_components(self):
        sim = Simulation(1e9, 2e9)
        for axis in "xyz":
            sim.mesh.AddLine(axis, [-1, 0, 1])
        sim.lumped_port(1, 50, [0, 0, 0], [0, 0, 1], "z")
        sim.lumped_inductor("L1", 10e-9, [0, 0, 0], [1, 1, 1], "z")
        sim.lumped_capacitor("C1", 1e-12, [0, 0, 0], [1, 1, 1], "z")
        _, core = _read_design(SimpleNamespace(build=lambda p: sim), {}, Path("lc.py"))
        self.assertEqual([(r["name"], float(r.get("L", 0)), float(r.get("C", 0)), r["topology"])
                          for r in core["resistors"]],
                         [("L1", 10e-9, 0.0, "parallel"), ("C1", 0.0, 1e-12, "parallel")])


def _fixture(case):
    sim = Simulation(.8e9, 2.4e9, boundaries=["PEC"] * 6, max_timesteps=250000)
    for axis, extent in (("x", 6), ("y", 4), ("z", 3)):
        sim.mesh.AddLine(axis, np.arange(-extent, extent + 1) * .02)
    plates = sim.metal("plates")
    for z in (-.04, .04):
        plates.AddBox([-.08, -.04, z], [.08, .04, z], priority=10)
    sim.lumped_port(1, 50, [-.08, -.04, -.04], [-.04, .04, .04], "z")
    if case == "series":
        plates.AddBox([.04, -.04, 0], [.08, .04, 0], priority=10)
        sim.lumped_inductor("L", 10e-9, [.04, -.04, -.04], [.08, .04, 0], "z")
        sim.lumped_capacitor("C", 1e-12, [.04, -.04, 0], [.08, .04, .04], "z")
    elif case == "parallel":
        sim.lumped_inductor("L", 10e-9, [.02, -.04, -.04], [.04, .04, .04], "z")
        sim.lumped_capacitor("C", 1e-12, [.06, -.04, -.04], [.08, .04, .04], "z")
    elif case == "L":
        sim.lumped_inductor("L", 10e-9, [.04, -.04, -.04], [.08, .04, .04], "z")
    else:
        sim.lumped_capacitor("C", 1e-12, [.04, -.04, -.04], [.08, .04, .04], "z")
    return sim


@unittest.skipUnless(os.environ.get("FAIRBEAM_TEST_FDTD") == "1", "opt-in native FDTD control")
class NativeRuntimeLCTests(unittest.TestCase):
    def test_lc_circuit_controls(self):
        reports = []
        for case in ("series", "parallel", "L", "C"):
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix="fairbeam-lc-") as folder:
                sim = _fixture(case)
                try:
                    sim.end_criteria_db = -60
                    sim.fdtd.SetEndCriteria(1e-6)
                    sim.run(folder, threads=1, exact=True, echo=False, engine="cpu")
                    sim.evaluate(n_freq=1601)
                    self.assertTrue(sim.run_stats.get("converged"), sim.run_stats)
                    f = np.asarray(sim.results["frequency"])
                    port = sim._port_objs[0]
                    z = port.uf_tot / port.if_tot
                    zl, zc = 1j * 2 * np.pi * f * 10e-9, 1 / (1j * 2 * np.pi * f * 1e-12)
                    target = zl + zc if case == "series" else 1 / (1 / zl + 1 / zc) if case == "parallel" else zl if case == "L" else zc
                    median_error = float(np.median(abs(z - target) / np.maximum(abs(target), 1)))
                    self.assertLess(median_error, .05)
                    report = {"case": case, "median_relative_z_error": median_error,
                              "energy_converged": True, "grid": sim.run_stats["grid"]}
                    widths = np.concatenate([np.diff(sim.mesh.GetLines(axis)) for axis in "xyz"]) * sim.unit
                    report.update(
                        mesh_cells=int(np.prod(np.asarray(sim.run_stats["grid"]) - 1)),
                        mesh_min_cell_m=float(widths.min()), mesh_max_cell_m=float(widths.max()),
                        timestep_s=sim.run_stats["timestep_s"], timesteps=sim.run_stats["timesteps"],
                        max_timesteps=sim.max_timesteps, end_criteria_db=sim.end_criteria_db,
                        threads=sim.run_stats["threads"], wall_time_s=sim.run_stats["wall_time_s"],
                    )
                    if case in ("series", "parallel"):
                        # At a parallel resonance the admittance crosses zero smoothly.
                        x = z.imag if case == "series" else (1 / z).imag
                        crossings = np.where(x[:-1] * x[1:] <= 0)[0]
                        analytic = 1 / (2 * np.pi * np.sqrt(10e-9 * 1e-12))
                        self.assertGreater(len(crossings), 0)
                        k = int(crossings[np.argmin(abs(f[crossings] - analytic))])
                        measured = float(f[k] - x[k] * (f[k + 1] - f[k]) / (x[k + 1] - x[k]))
                        self.assertLess(abs(measured / analytic - 1), .01)
                        report.update(analytic_frequency_hz=analytic, measured_frequency_hz=measured)
                    reports.append(report)
                finally:
                    del sim
                    gc.collect()
        report_path = os.environ.get("FAIRBEAM_LC_TEST_REPORT")
        if report_path:
            Path(report_path).write_text(json.dumps(reports, indent=2) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    unittest.main()
