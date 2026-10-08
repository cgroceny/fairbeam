"""Scientific acceptance gates must reject apparently stable but invalid runs."""
import json
import unittest

import numpy as np

from tests.blade_feed_study import SOURCE, compare, design, metrics


class BladeStudy(unittest.TestCase):
    def response(self, shift=0, scale=1, converged=True):
        f = np.linspace(.7e9, 1.05e9, 3501)
        s = scale*(.1 + ((f-920e6-shift)/300e6)**2) + 0j
        return {"f": f, "s": s, "converged": converged}

    def test_identical_valid_responses_pass(self):
        self.assertTrue(compare(self.response(), self.response())["passed"])

    def test_energy_failure_cannot_be_hidden_by_curve_agreement(self):
        self.assertFalse(compare(self.response(), self.response(converged=False))["passed"])

    def test_depth_change_fails_even_with_stable_frequency(self):
        result = compare(self.response(), self.response(scale=1.1))
        self.assertLess(result["frequency_pct"], .01)
        self.assertGreater(result["depth_db"], .5)
        self.assertFalse(result["passed"])

    def test_complex_phase_change_fails_even_with_identical_magnitude(self):
        right = self.response()
        right["s"] *= np.exp(.2j)
        result = compare(self.response(), right)
        self.assertLess(result["depth_db"], 1e-8)
        self.assertGreater(result["complex_max"], .01)
        self.assertFalse(result["passed"])

    def test_passivity_failure_cannot_pass(self):
        r = self.response(scale=12)
        self.assertFalse(compare(r, r)["passed"])

    def test_window_edge_does_not_establish_resonance_stability(self):
        r = self.response(shift=200e6)
        self.assertFalse(compare(r, r)["passed"])

    def test_invalid_response_or_axis_is_rejected(self):
        for defect in ("nan", "unordered", "band", "different"):
            with self.subTest(defect=defect):
                a, b = self.response(), self.response()
                if defect == "nan":
                    b["s"][100] = complex(float("nan"), 0)
                elif defect == "unordered":
                    b["f"][100] = b["f"][99]
                    a["f"] = b["f"].copy()
                elif defect == "band":
                    b["f"][0] = .70001e9
                    a["f"] = b["f"].copy()
                else:
                    b["f"][100] += 1
                with self.assertRaises(ValueError):
                    compare(a, b)

    def test_refinement_preserves_geometry_source_and_old_mesh_lines(self):
        base = json.loads(SOURCE.read_text())
        snapshots = [design(base, "feed", 4, n) for n in range(3)]
        for d in snapshots:
            self.assertEqual(d["parts"], base["parts"])
            self.assertEqual(d["materials"], base["materials"])
            self.assertEqual(d["ports"], snapshots[0]["ports"])
            for axis in "xyz":
                self.assertTrue(set(base["mesh"]["lines"][axis]) <= set(d["mesh"]["lines"][axis]))
        self.assertEqual(base, json.loads(SOURCE.read_text()))

    def test_boundary_extension_preserves_interior_and_pml_width(self):
        base = json.loads(SOURCE.read_text())
        for level in (1, 2):
            d = design(base, "boundary", 0, level)
            n = 8*level
            for axis in "xyz":
                x, y = np.array(base["mesh"]["lines"][axis]), np.array(d["mesh"]["lines"][axis])
                np.testing.assert_array_equal(y[n:-n], x)
                np.testing.assert_allclose(np.diff(y[:9]), x[1]-x[0])
                np.testing.assert_allclose(np.diff(y[-9:]), x[-1]-x[-2])

    def test_global_refinement_keeps_source_and_geometry_fixed(self):
        base = json.loads(SOURCE.read_text())
        cases = [design(base, "auto", 4, n, (40, 50, 60), 20) for n in range(3)]
        self.assertEqual([d["mesh"]["cells_per_wavelength"] for d in cases], [40, 50, 60])
        for d in cases:
            self.assertTrue(d["mesh"]["refine_features"])
            self.assertEqual(d["mesh"]["air_cells_per_wavelength"], 20)
            for key in ("parts", "materials", "ports", "simulation"):
                self.assertEqual(d[key], cases[0][key])


if __name__ == "__main__":
    unittest.main()
