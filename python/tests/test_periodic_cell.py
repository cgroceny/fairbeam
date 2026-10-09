"""Admission and normalization safeguards for the optional research backend."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from fairbeam import periodic_cell as pc


def design():
    return {"schema": "fairbeam.design/1", "model": {"id": "slab", "name": "Slab"},
            "params": [{"key": "height", "default": 10}],
            "simulation": {"f_min": 1, "f_max": 10},
            "materials": [{"name": "sample", "kind": "dielectric", "eps_r": 4, "tan_d": 0}],
            "parts": [{"name": "slab", "material": "sample", "primitives": [
                {"kind": "box", "start": [-3, -3, 0], "stop": [3, 3, "height"]}]}],
            "ports": [], "mesh": {"mode": "auto"}}


class PeriodicAdmissionTests(unittest.TestCase):
    def test_defaults_and_reproducible_normalization(self):
        s = pc.validate_spec({})
        self.assertEqual(s, pc.validate_spec(s["input_settings"], s["source_design"]))
        self.assertLessEqual(s["layout"]["cells"], pc.MAX_CELLS)
        self.assertEqual(s["settings"]["boxes"][0]["eps_r"], 4)
        self.assertEqual(s["layout"]["mesh_epsilon"], 4)
        json.dumps(s, allow_nan=False)

    def test_nonfinite_boolean_unknown_settings(self):
        for value in (float("nan"), float("inf"), True, "6", 10 ** 1000):
            with self.subTest(value=value), self.assertRaises(ValueError):
                pc.validate_spec({"period_x_mm": value})
        with self.assertRaises(ValueError):
            pc.validate_spec({"bloch_phase": 1})

    def test_no_subnormal_grid_or_excess_resource_allocation(self):
        for settings in ({"period_x_mm": 1e-320}, {"back_mm": 1e-320},
                         {"back_mm": 1000, "f_min_hz": 1e11, "f_max_hz": 1e12,
                          "period_x_mm": .1, "period_y_mm": .1, "cpw": 40}):
            with self.subTest(settings=settings), self.assertRaises(ValueError):
                pc.validate_spec(settings)

    def test_diffraction_and_frequency_contract(self):
        for settings in ({"period_x_mm": 30}, {"cpw": 21}, {"f_min_hz": 10e9},
                         {"f_min_hz": 1e6, "f_max_hz": 10e9}):
            with self.subTest(settings=settings), self.assertRaises(ValueError):
                pc.validate_spec(settings)

    def test_arbitrary_custom_boxes_retained_and_snapshot_independent(self):
        values = {"boxes": [{"material": "dielectric", "eps_r": 6,
                             "start": [-2, -2, 0], "stop": [1, 1, 2]}]}
        s = pc.validate_spec(values)
        values["boxes"][0]["eps_r"] = 99
        self.assertEqual(s["settings"]["boxes"][0]["eps_r"], 6)
        self.assertEqual(s["input_settings"]["boxes"][0]["eps_r"], 6)

    def test_box_loss_sheets_thickness_and_bounds(self):
        base = {"material": "dielectric", "eps_r": 4, "start": [-3, -3, 0], "stop": [3, 3, 10]}
        for change in ({"conductivity": 1}, {"eps_r": -1}, {"stop": [3, 3, 0]},
                       {"stop": [3, 3, .0001]}, {"stop": [4, 3, 10]},
                       {"start": [3, -3, 0], "stop": [-3, 3, 10]},
                       {"material": "pec", "eps_r": 1, "start": [-3, -3, .123], "stop": [3, 3, .123]}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                pc.validate_spec({"boxes": [{**base, **change}]})
        self.assertEqual(pc.validate_spec({"fixture": "pec_sheet"})["settings"]["boxes"][0]["material"], "pec")

    def test_design_expressions_preserved(self):
        d = design()
        s = pc.validate_spec({"params": {"height": 4}}, d)
        self.assertEqual(s["settings"]["boxes"][0]["stop"][2], 4)
        self.assertEqual(s["source_design"], d)
        self.assertIn("replace", s["design_reuse"])

    def test_design_does_not_drop_physics(self):
        for key in ("ports", "resistors", "lumped_elements", "excitations"):
            d = design()
            d[key] = [{"type": "lumped", "number": 1, "R": 50, "direction": "z",
                       "start": [0, 0, 0], "stop": [0, 0, 1]}]
            with self.subTest(key=key), self.assertRaises(ValueError):
                pc.validate_spec({}, d)
        for change in ({"tan_d": .02}, {"conductivity": 5.8e7}, {"dispersion": {}}, {"mu_r": 2}):
            d = design()
            d["materials"][0].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                pc.validate_spec({}, d)

    def test_design_rejects_transforms_curves_and_boolean(self):
        for key, value in (("transforms", [{"type": "move", "offset": [1, 0, 0]}]),
                           ("cuts", [{"start": [-1, -1, 0], "stop": [1, 1, 0]}]),
                           ("booleanHistory", {"live": True})):
            d = design()
            d["parts"][0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                pc.validate_spec({}, d)
        d = design()
        d["parts"][0]["primitives"][0] = {"kind": "sphere", "center": [0, 0, 1], "radius": 1}
        with self.assertRaises(ValueError):
            pc.validate_spec({}, d)

    def test_no_mixed_geometry_sources(self):
        for settings, d in (({"fixture": "slab"}, design()), ({"boxes": []}, design()),
                            ({"fixture": "empty", "boxes": []}, None)):
            with self.assertRaises(ValueError):
                pc.validate_spec(settings, d)


class PeriodicNativeBoundaryTests(unittest.TestCase):
    def test_handshake_missing_stock_and_wrong_revision(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "runtime"
            with patch.object(pc.subprocess, "run") as launch:
                self.assertFalse(pc.probe(file)["available"])
                launch.assert_not_called()
            file.touch()
            for reply in ("ordinary openEMS", json.dumps({**pc.CAPABILITIES, "revision": 3}), "[]"):
                with patch.object(pc.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, reply)):
                    self.assertFalse(pc.probe(file)["available"])
            with patch.object(pc.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(pc.CAPABILITIES))):
                self.assertTrue(pc.probe(file)["available"])

    def test_uniform_mesh_exact_source_and_identical_reference(self):
        s = pc.validate_spec({})
        a, na, za = pc._build(s, False)
        b, nb, zb = pc._build(s, True)
        self.assertEqual(na, nb)
        self.assertEqual(za, zb)
        population = 1
        for axis in "xyz":
            lines = np.asarray(a.mesh.GetLines(axis))
            np.testing.assert_array_equal(lines, b.mesh.GetLines(axis))
            np.testing.assert_allclose(np.diff(lines), np.diff(lines)[0], rtol=1e-12)
            population *= len(lines) - 1
        self.assertEqual(population, s["layout"]["cells"])
        with tempfile.TemporaryDirectory() as tmp:
            xml = Path(tmp) / "model.xml"
            pc._write_xml(b, xml)
            tree = pc.ET.parse(xml)
            self.assertEqual(tree.find(".//BoundaryCond").get("xmin"), "PERIODIC_TEST")
            source_z = float(tree.find(".//Excitation/Primitives/Box/P1").get("Z"))
            self.assertIn(source_z, b.mesh.GetLines("z"))

    def test_mutated_normalized_snapshot_rejected_before_runtime(self):
        s = pc.validate_spec({})
        s["settings"]["boxes"][0]["eps_r"] = 99
        with patch.object(pc, "probe") as probe, self.assertRaises(ValueError):
            pc.run(s, "unused")
        probe.assert_not_called()

    def test_timeout_retains_raw_failure_and_does_not_run_second_case(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "run"
            cap = {"available": True, "path": "explicit-native"}
            with patch.object(pc, "probe", return_value=cap), patch.object(pc.subprocess, "run", side_effect=subprocess.TimeoutExpired([], 180)) as native:
                with self.assertRaises(subprocess.TimeoutExpired):
                    pc.run(pc.validate_spec({}), out)
                self.assertEqual(native.call_count, 1)
                self.assertNotIn("start_new_session", native.call_args.kwargs)
            manifest = json.loads((out / "manifest.json").read_text())
            self.assertEqual(manifest["status"], "failed")
            self.assertTrue((out / "input.json").exists())
            self.assertTrue((out / "reference" / "model.xml").exists())
            self.assertFalse((out / "result.json").exists())


if __name__ == "__main__":
    unittest.main()
