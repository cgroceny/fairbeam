import unittest

import numpy as np

from fairbeam.simulation import _bands


def db_curve(f, dips):
    """Sum of Lorentzian-shaped dips ``(f0, depth_db, width)`` on a 0 dB baseline."""
    s = np.zeros_like(f)
    for f0, depth, w in dips:
        s += depth / (1 + ((f - f0) / w) ** 2)
    return s


class BandDetectionTest(unittest.TestCase):
    def setUp(self):
        self.f = np.linspace(1e9, 3e9, 201)

    def test_no_band(self):
        self.assertEqual(_bands(self.f, db_curve(self.f, [(2e9, -6, 0.1e9)]), -10), [])

    def test_single_interior_band(self):
        bands = _bands(self.f, db_curve(self.f, [(2e9, -30, 0.05e9)]), -10)
        self.assertEqual(len(bands), 1)
        b = bands[0]
        self.assertAlmostEqual(b["f_center"], 2e9, delta=1e7)
        self.assertLess(b["f_lo"], 2e9)
        self.assertGreater(b["f_hi"], 2e9)
        self.assertFalse(b["edge_lo"] or b["edge_hi"])
        self.assertAlmostEqual(b["fractional_bw"], (b["f_hi"] - b["f_lo"]) / b["f_center"], places=4)
        self.assertAlmostEqual(b["s11_min_db"], -30, delta=0.1)

    def test_multiple_bands_in_order(self):
        s = db_curve(self.f, [(1.5e9, -20, 0.03e9), (2.5e9, -25, 0.03e9)])
        bands = _bands(self.f, s, -10)
        self.assertEqual(len(bands), 2)
        self.assertLess(bands[0]["f_hi"], bands[1]["f_lo"])
        self.assertAlmostEqual(bands[0]["f_center"], 1.5e9, delta=1e7)
        self.assertAlmostEqual(bands[1]["f_center"], 2.5e9, delta=1e7)

    def test_band_touching_low_edge(self):
        bands = _bands(self.f, db_curve(self.f, [(0.95e9, -30, 0.1e9)]), -10)
        self.assertEqual(len(bands), 1)
        self.assertTrue(bands[0]["edge_lo"])
        self.assertFalse(bands[0]["edge_hi"])
        self.assertEqual(bands[0]["f_lo"], self.f[0])

    def test_band_touching_high_edge(self):
        bands = _bands(self.f, db_curve(self.f, [(3.05e9, -30, 0.1e9)]), -10)
        self.assertEqual(len(bands), 1)
        self.assertTrue(bands[0]["edge_hi"])
        self.assertFalse(bands[0]["edge_lo"])
        self.assertEqual(bands[0]["f_hi"], self.f[-1])

    def test_whole_range_matched(self):
        bands = _bands(self.f, np.full_like(self.f, -15.0), -10)
        self.assertEqual(len(bands), 1)
        self.assertTrue(bands[0]["edge_lo"] and bands[0]["edge_hi"])

    def test_single_sample_band(self):
        s = np.zeros_like(self.f)
        s[100] = -12
        bands = _bands(self.f, s, -10)
        self.assertEqual(len(bands), 1)
        self.assertEqual(bands[0]["f_lo"], bands[0]["f_hi"])
        self.assertEqual(bands[0]["fractional_bw"], 0.0)

    def test_threshold_is_strict(self):
        self.assertEqual(_bands(self.f, np.full_like(self.f, -10.0), -10), [])


if __name__ == "__main__":
    unittest.main()


class MirrorPlanes(unittest.TestCase):
    """openEMS' NF2FF keeps one image plane per axis: PEC on both faces of an axis mirrors once."""

    def test_count(self):
        from fairbeam.simulation import mirror_planes
        self.assertEqual(mirror_planes(["MUR"] * 6), 0)
        self.assertEqual(mirror_planes(["MUR"] * 4 + ["PEC", "MUR"]), 1)          # ground plane
        self.assertEqual(mirror_planes(["PEC", "PEC"] + ["MUR"] * 4), 1)          # both x faces
        self.assertEqual(mirror_planes(["PMC", "MUR", "MUR", "MUR", "PEC", "MUR"]), 2)
        self.assertEqual(mirror_planes([0, "MUR", "MUR", "MUR", "MUR", "MUR"]), 1)  # integer code
