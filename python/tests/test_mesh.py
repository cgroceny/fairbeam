import unittest

import numpy as np

from fairbeam.mesh import merge_lines


def slivers(out, required, tol):
    """Cells narrower than ``tol`` that are not bounded by two required (geometry) lines."""
    req = set(np.asarray(required, dtype=float).tolist())
    return [(a, b) for a, b in zip(out[:-1], out[1:]) if b - a <= tol and not (a in req and b in req)]


class MergeLinesTest(unittest.TestCase):
    def test_keeps_all_required_lines(self):
        req = [0.0, 0.33, 1.7, 2.05, 5.0]
        out = merge_lines(req, np.arange(-1, 6.01, 0.5), 0.2)
        for r in req:
            self.assertIn(r, out)

    def test_no_slivers_between_uniform_and_required(self):
        req = [0.0, 0.33, 1.7, 2.05, 5.0]
        out = merge_lines(req, np.arange(-1, 6.01, 0.5), 0.2)
        self.assertEqual(slivers(out, req, 0.2), [])

    def test_sorted_unique(self):
        out = merge_lines([3.0, 1.0, 1.0, 2.0], [1.0, 1.05, 4.0, 4.0], 0.1)
        self.assertTrue(np.all(np.diff(out) > 0))
        np.testing.assert_allclose(out, [1.0, 2.0, 3.0, 4.0])

    def test_uniform_far_from_required_is_kept(self):
        out = merge_lines([0.0], [-2.0, -1.0, 1.0, 2.0], 0.5)
        np.testing.assert_allclose(out, [-2.0, -1.0, 0.0, 1.0, 2.0])

    def test_tolerance_is_strict(self):
        # a uniform line exactly at tol is dropped (strict '>'), just beyond it is kept
        self.assertNotIn(0.5, merge_lines([0.0], [0.5], 0.5))
        self.assertIn(0.51, merge_lines([0.0], [0.51], 0.5))

    def test_realistic_fractal_grid(self):
        rng = np.random.default_rng(1)
        req = np.round(rng.uniform(0, 40, 60), 4)
        cell = 0.8
        out = merge_lines(req, np.arange(0, 40.01, cell), 0.45 * cell)
        self.assertEqual(slivers(out, req, 0.45 * cell), [])
        self.assertTrue(set(req.tolist()) <= set(out.tolist()))
        # dropping a uniform line next to a required one widens a cell by at most tol on each side
        self.assertLessEqual(float(np.diff(out).max()), cell + 2 * 0.45 * cell + 1e-9)


if __name__ == "__main__":
    unittest.main()
