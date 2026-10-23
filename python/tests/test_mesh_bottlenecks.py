"""Mesh report locations from synthetic line arrays; no geometry or solver execution."""
import json
import unittest
from pathlib import Path
from types import SimpleNamespace

from fairbeam.automesh import axis_bottleneck, mesh_report


class MeshBottlenecks(unittest.TestCase):
    def test_shared_typescript_python_location_fixtures(self):
        cases = json.loads((Path(__file__).parent / "fixtures/mesh_bottlenecks.json").read_text())
        for case in cases:
            with self.subTest(lines=case["lines"]):
                result = axis_bottleneck(case["lines"])
                self.assertEqual(result["min_interval_index"], case["min_index"])
                self.assertEqual(result["min_interval"], case["min_interval"])
                self.assertEqual(result["max_neighbour_ratio_index"], case["ratio_index"])
                self.assertEqual(result["max_neighbour_ratio_coordinates"], case["ratio_coordinates"])
                self.assertAlmostEqual(result["max_neighbour_ratio"], case["ratio"])

    def test_report_locations_use_original_coordinates_and_indices(self):
        lines = [[0, 0.035, 1], [-2, -1, 0, 2], [0, 1]]
        sim = SimpleNamespace(unit=1e-3, mesh=SimpleNamespace(GetLines=lambda axis: lines[axis]))
        report = mesh_report(sim, 1, 0.5, 0.01, [], {})
        self.assertEqual(report["axis_bottlenecks"]["x"]["max_neighbour_ratio_coordinates"], [0, 0.035, 1])
        self.assertEqual(report["axis_bottlenecks"]["y"]["min_interval_index"], 0)
        self.assertIsNone(report["axis_bottlenecks"]["z"]["max_neighbour_ratio_index"])
        self.assertEqual(report["total_cells"], 6)
        self.assertEqual(report["max_neighbour_ratio"], round(0.965 / 0.035, 3))

    def test_invalid_lines_fail_closed(self):
        for lines in ([], [1], [0, 0], [1, 0], [0, float("nan")], [0, float("inf")], [[0, 1]]):
            with self.subTest(lines=lines), self.assertRaises(ValueError):
                axis_bottleneck(lines)


if __name__ == "__main__":
    unittest.main()
