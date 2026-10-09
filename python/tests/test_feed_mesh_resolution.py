"""A feed with fine axial cells still needs a resolved transverse neighborhood."""
import unittest

import numpy as np

from fairbeam import Simulation
from fairbeam.mesh_refinement import collect_features, measure_features


class FeedResolutionTest(unittest.TestCase):
    def feed(self, direction="z", start=None, stop=None):
        return collect_features([], [{"type": "lumped", "direction": direction,
                                      "start": start or [0, 0, 0],
                                      "stop": stop or [0, 0, 3]}], 20)

    def test_axial_resolution_does_not_hide_coarse_transverse_cells(self):
        report = measure_features(self.feed(), [[-10, 0, 10], [-1, 0, 1], [0, 1, 2, 3]])[0]
        self.assertEqual(report["axial_cells_across"], 3)
        self.assertEqual(report["transverse_cells_across"], {"x": .3, "y": 3})
        self.assertAlmostEqual(report["cells_across"], .3)
        self.assertFalse(report["resolved"])

    def test_both_sides_of_the_feed_must_be_resolved(self):
        for x in ([-1, 0, 10], [-10, 0, 1]):
            self.assertFalse(measure_features(self.feed(), [x, [-1, 0, 1], [0, 1, 2, 3]])[0]["resolved"])

    def test_transverse_domain_boundary_and_reversed_feed(self):
        feeds = self.feed(start=[0, 0, 3], stop=[0, 0, 0])
        report = measure_features(feeds, [[0, 1], [-1, 0], [0, 1, 2, 3]])[0]
        self.assertTrue(report["resolved"])

    def test_finite_port_must_resolve_its_whole_footprint(self):
        report = measure_features(self.feed(start=[-10, 0, 0], stop=[10, 0, 3]),
                                  [[-10, 0, 10], [-1, 0, 1], [0, 1, 2, 3]])[0]
        self.assertEqual(report["transverse_cells_across"], {"x": .3, "y": 3})
        self.assertFalse(report["resolved"])

    def test_finite_source_span_and_gap_both_set_transverse_scale(self):
        feeds = self.feed(start=[-1, 0, 0], stop=[1, 0, 3])
        report = measure_features(feeds, [[-1, 0, 1], [-1, 0, 1], [0, 1, 2, 3]])[0]
        self.assertEqual(report["transverse_cells_across"], {"x": 2, "y": 3})
        self.assertFalse(report["resolved"])

    def test_finite_source_refinement_resolves_both_transverse_axes(self):
        from tests.blade_feed_study import SOURCE, design
        from fairbeam.design import build
        import json
        sim = build(design(json.loads(SOURCE.read_text()), "auto", 4, 0), {})
        feed = next(f for f in sim.mesh_report["fine_features"] if f["kind"] == "feed")
        self.assertTrue(feed["resolved"], feed)
        self.assertEqual(set(feed["transverse_cells_across"]), {"x", "y"})
        x = np.asarray(sim.mesh.GetLines("x"))
        widths = np.diff(x)[(x[:-1] < 2) & (x[1:] > -2)]
        self.assertLessEqual(widths.max(), 2/3 + 1e-6)

    def test_axis_permutation(self):
        for axis in range(3):
            end = [0, 0, 0]
            end[axis] = 3
            lines = [[-10, 0, 10] for _ in range(3)]
            lines[axis] = [0, 1, 2, 3]
            report = measure_features(self.feed(direction="xyz"[axis], stop=end), lines)[0]
            self.assertFalse(report["resolved"])
            self.assertEqual(len(report["transverse_cells_across"]), 2)

    def test_missing_transverse_coverage_is_unresolved(self):
        report = measure_features(self.feed(), [[1, 2], [-1, 0, 1], [0, 1, 2, 3]])[0]
        self.assertEqual(report["cells_across"], 0)
        self.assertFalse(report["resolved"])

    def test_refinement_reaches_feed_with_already_fine_axial_lines(self):
        sim = Simulation(.7e9, 1.05e9)
        metal = sim.metal("plates")
        for z in (0, 3):
            metal.AddBox([-30, -30, z], [30, 30, z])
        sim.lumped_port(1, 50, [0, 0, 0], [0, 0, 3], "z")
        sim.mesh.AddLine("z", [0, 1, 2, 3])
        baseline = sim.auto_mesh(refine_features=False)
        feed = next(f for f in baseline["fine_features"] if f["kind"] == "feed")
        self.assertGreaterEqual(feed["axial_cells_across"], 3)
        self.assertFalse(feed["resolved"])
        # Preserve only the original requested axial lines, not the baseline's
        # optional mesh: these are the same inputs for the two builds.
        for a in "xy":
            sim.mesh.ClearLines(a)
        sim.mesh.SetLines("z", [0, 1, 2, 3])
        refined = sim.auto_mesh(refine_features=True)
        feed = next(f for f in refined["fine_features"] if f["kind"] == "feed")
        self.assertTrue(feed["resolved"], feed)
        for a in "xy":
            x = np.asarray(sim.mesh.GetLines(a))
            touching = np.diff(x)[(x[:-1] <= 1e-9) & (x[1:] >= -1e-9)]
            self.assertLessEqual(touching.max(), 1 + 1e-6)
        self.assertGreater(refined["total_cells"], baseline["total_cells"])


if __name__ == "__main__":
    unittest.main()
