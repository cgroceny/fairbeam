"""Resolution bounds are computed before allocating fine mesh lines."""

import unittest
from unittest.mock import patch

import numpy as np

from fairbeam import Simulation
from fairbeam.automesh import fill

from fairbeam.mesh_refinement import refinement_caps, refinement_cell_lower_bound


class RefinementBoundTest(unittest.TestCase):
    def test_clips_intervals_to_domain_and_does_not_sum_overlaps(self):
        domain = ([0, 0, 0], [10, 20, 30])
        caps = [[(-10, 5, 1), (2, 30, 1)], [(0, 20, 2)], []]
        # x: max(floor(5/1.1), floor(8/1.1)) = 7; y: floor(20/2.2) = 9.
        self.assertEqual(refinement_cell_lower_bound(caps, domain), 63)
        self.assertEqual(refinement_cell_lower_bound([[], [], []], domain), 1)

    def test_very_thin_slanted_strip_exceeds_limit_without_allocating_grid(self):
        feature = {"width": 1e-7, "lo": [0, 0, 0], "hi": [60, 80, 0],
                   "normal": [-0.8, 0.6, 0]}
        caps = refinement_caps([feature])
        required = refinement_cell_lower_bound(caps, ([-100] * 3, [200] * 3))
        self.assertGreater(required, 40_000_000)
        self.assertGreater(required, 2**63)  # Python integers avoid overflowing the product.

    def test_fill_refuses_excess_lines_before_allocation(self):
        with self.assertRaises(OverflowError):
            fill([0, 100], lambda x: np.full(np.shape(x), 1e-9), 1.4,
                 monotone=True, max_cells=1000)

    def test_tiny_strip_keeps_baseline_without_allocating_refinement(self):
        sim = Simulation(0.6e9, 1.2e9, boundaries=["MUR"] * 6)
        tangent, normal = np.array([0.6, 0.8]), np.array([-0.8, 0.6])
        points = np.array([np.zeros(2), 100 * tangent, 100 * tangent + 1e-7 * normal, 1e-7 * normal])
        sim.metal("strip").AddPolygon(points.T, "z", 0, priority=10)
        with patch("fairbeam.automesh.fill", wraps=fill) as calls:
            report = sim.auto_mesh()
        self.assertEqual(calls.call_count, 3)  # Baseline only; the bound rejects refinement.
        impact = report["fine_feature_refinement"]
        self.assertTrue(impact["skipped_cell_limit"])
        self.assertEqual(impact["baseline_cells"], report["total_cells"])
        self.assertTrue(any(not f["resolved"] for f in report["fine_features"]))

    def test_cell_limit_drops_largest_refinement_and_keeps_smaller_ones(self):
        from tests.mesh_feature_measurements import build_blade
        with patch.dict("os.environ", {"FAIRBEAM_MAX_CELLS": "1000000"}):
            sim = build_blade()
        report = sim.mesh_report
        impact = report["fine_feature_refinement"]
        self.assertTrue(impact["skipped_cell_limit"])
        self.assertGreater(impact["dropped_features"], 0)
        self.assertGreater(impact["retained_features"], 0)
        self.assertGreater(report["total_cells"], impact["baseline_cells"])
        self.assertLessEqual(report["total_cells"], impact["cell_limit"])
        self.assertTrue(any(f["kind"] == "strip" and not f["resolved"] for f in report["fine_features"]))
        self.assertTrue(any(f["kind"] == "feed" and f["resolved"] for f in report["fine_features"]))

    def test_no_refinement_fits_keeps_exact_baseline(self):
        from tests.mesh_feature_measurements import build_blade
        sim = build_blade()
        sim.auto_mesh(keep_existing=False, refine_features=False)
        baseline = [np.asarray(sim.mesh.GetLines(a)) for a in range(3)]
        with patch.dict("os.environ", {"FAIRBEAM_MAX_CELLS": "213696"}):
            report = sim.auto_mesh(keep_existing=False)
        self.assertEqual(report["fine_feature_refinement"]["retained_features"], 0)
        for a in range(3):
            np.testing.assert_array_equal(sim.mesh.GetLines(a), baseline[a])

    def test_helix_refinement_does_not_spread_down_wire_cover(self):
        from fairbeam.model import load_model, resolve_params
        from pathlib import Path
        module = load_model(Path(__file__).parents[1] / "models" / "helix_axial.py")
        sim = module.build(resolve_params(module.PARAMS, {}))
        refined = [np.asarray(sim.mesh.GetLines(a)) for a in range(3)]
        report = sim.mesh_report
        sim.auto_mesh(cells_per_wavelength=30, keep_existing=False, refine_features=False)
        baseline = [np.asarray(sim.mesh.GetLines(a)) for a in range(3)]
        self.assertLess(report["total_cells"], 1.2 * sim.mesh_report["total_cells"])
        self.assertLessEqual(report["max_neighbour_ratio"], 1.4)
        np.testing.assert_array_equal(refined[2][refined[2] > 25], baseline[2][baseline[2] > 25])
        self.assertLess(np.count_nonzero((np.diff(refined[2]) >= .7) & (np.diff(refined[2]) <= 1)), 15)


if __name__ == "__main__":
    unittest.main()
