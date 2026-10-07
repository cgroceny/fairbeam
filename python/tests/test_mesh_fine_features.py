"""Mesh-only regression coverage for a swept blade's narrow geometric features."""

import json
import unittest

from fairbeam.design_checks import lint
from fairbeam.preview import handle
from tests.mesh_feature_measurements import FIXTURE, blade_measurements, build_blade, example_measurements


class BladeFineFeaturesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.design = json.loads(FIXTURE.read_text())
        cls.sim = build_blade()
        cls.measured = blade_measurements(cls.sim)

    def test_notches_feed_and_slanted_strip_are_resolved(self):
        for across in self.measured["notch_cells_across"]:
            self.assertGreaterEqual(across, 3)
        self.assertGreaterEqual(self.measured["feed_cells_across"], 3)
        self.assertGreaterEqual(self.measured["strip_cells_across"], 1)
        self.assertEqual(self.measured["strip_midpoint_components"], 1)
        self.assertLess(self.measured["total_cells"], 3_000_000)
        self.assertLessEqual(self.measured["max_neighbour_ratio"], 1.4)

    def test_preview_reports_cell_impact_and_resolved_features(self):
        response = handle({"op": "preview_design", "design": self.design, "overrides": {}})
        self.assertTrue(response["ok"], response)
        bundle = response["result"]["bundle"]
        self.assertTrue(bundle["preview"])
        report = bundle["mesh"]["auto"]
        impact = report["fine_feature_refinement"]
        before = json.loads((FIXTURE.parent / "automesh_fine_features_before.json").read_text())["blade"]
        self.assertEqual(impact["baseline_cells"], before["total_cells"])
        self.assertEqual(impact["total_cells"], self.measured["total_cells"])
        self.assertEqual(impact["added_cells"], impact["total_cells"] - impact["baseline_cells"])
        self.assertTrue(report["fine_features"])
        self.assertTrue(all(f["resolved"] for f in report["fine_features"]))
        checks = response["result"]["checks"]
        self.assertTrue(any(c["code"] == "mesh-fine-refinement" and c["severity"] == "info" for c in checks), checks)
        self.assertFalse(any(c["code"] == "mesh-fine-feature" for c in checks))
        self.assertFalse(any(c["code"] == "mesh-cells" and c["severity"] == "error" for c in checks))

    def test_requested_grading_ratios(self):
        for ratio in (1.2, 1.6):
            with self.subTest(max_ratio=ratio):
                sim = build_blade()
                baseline = sim.auto_mesh(max_ratio=ratio, keep_existing=False, refine_features=False)
                sim.auto_mesh(max_ratio=ratio, keep_existing=False)
                self.assertLessEqual(sim.mesh_report["max_neighbour_ratio"],
                                     max(ratio, baseline["max_neighbour_ratio"]))
                self.assertTrue(all(f["resolved"] for f in sim.mesh_report["fine_features"]))

    def test_explicit_minimum_cell_reports_unresolved_strip(self):
        sim = build_blade()
        sim.auto_mesh(min_cell=1.0, keep_existing=False)
        features = sim.mesh_report["fine_features"]
        self.assertTrue(any(not f["resolved"] and f["width"] < 0.41 for f in features))
        bundle = sim.to_bundle(self.design["model"], [], name="Fine-feature diagnostics")
        checks = lint(self.design, {}, bundle)
        self.assertTrue(any(c["code"] == "mesh-fine-feature" and c["severity"] == "warning" for c in checks))


class ExampleMeshPreservationTest(unittest.TestCase):
    def test_already_resolved_examples_keep_their_automatic_mesh(self):
        before = json.loads((FIXTURE.parent / "automesh_fine_features_before.json").read_text())["examples"]
        after = example_measurements()
        unchanged = ("branchline-coupler", "lowpass-stepped", "microstrip-line", "minkowski-patch",
                     "patch-antenna", "patch-array-2x1", "patch-array-4x1", "pyramidal-horn",
                     "wilkinson-divider", "yagi-867")
        for name, measured in after.items():
            with self.subTest(baseline=name):
                self.assertEqual(measured["fine_feature_refinement"]["baseline_cells"],
                                 before[name]["total_cells"])
                # Legacy untouched axes can already exceed the requested ratio.
                self.assertLessEqual(measured["max_neighbour_ratio"],
                                     max(1.4, before[name]["max_neighbour_ratio"]) + 0.005)
        for name in unchanged:
            with self.subTest(example=name):
                self.assertEqual(after[name]["cells"], before[name]["cells"])
                self.assertAlmostEqual(after[name]["min_cell"], before[name]["min_cell"], places=5)


if __name__ == "__main__":
    unittest.main()
