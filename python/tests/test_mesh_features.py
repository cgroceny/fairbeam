"""Polygon feature geometry, without solver execution."""

import unittest

import numpy as np

from fairbeam.automesh import Shape
from fairbeam.mesh_features import detect_features


def polygon(points, normal=2, thickness=0):
    points = np.asarray(points, float)
    lo, hi = np.zeros(3), np.zeros(3)
    u, v = (normal + 1) % 3, (normal + 2) % 3
    lo[u], lo[v] = points.min(axis=0)
    hi[u], hi[v] = points.max(axis=0)
    hi[normal] = thickness
    return Shape("linpoly" if thickness else "polygon", None, lo, hi,
                 normal=normal, pts=points, elevation=0, length=thickness)


class PolygonFeaturesTest(unittest.TestCase):
    def test_bounding_prefilter_matches_unbounded_edge_search(self):
        shapes = [polygon([[x, 0], [x + .4, 0], [x + .4, 4], [x, 4]])
                  for x in (0, .6, 1.2, 20)]
        # Include a buried edge and a remote conductor; containment filtering
        # must agree with the full search as well as the edge-pair filter.
        shapes.append(polygon([[0, 1], [.8, 1], [.8, 2], [0, 2]]))
        expected = [f for f in detect_features(shapes) if f.width <= .25]
        self.assertEqual(detect_features(shapes, max_width=.25), expected)

    def test_slanted_strip_perpendicular_width_and_extent(self):
        tangent, normal = np.array([0.6, 0.8]), np.array([-0.8, 0.6])
        points = [np.zeros(2), 20 * tangent, 20 * tangent + 0.4 * normal, 0.4 * normal]
        for winding in (points, points[::-1]):
            shape = polygon(winding, normal=1)
            features = detect_features([shape], max_width=2)
            self.assertEqual(len(features), 1)
            feature = features[0]
            self.assertEqual(feature.kind, "strip")
            self.assertEqual(feature.axes, (2, 0))
            self.assertAlmostEqual(feature.width, 0.4)
            np.testing.assert_allclose(feature.lo, shape.lo, atol=1e-12)
            np.testing.assert_allclose(feature.hi, shape.hi, atol=1e-12)
            self.assertEqual(feature.shape_indices, (0, 0))

    def test_very_thin_strip_is_available_for_allocation_preflight(self):
        tangent, normal = np.array([0.6, 0.8]), np.array([-0.8, 0.6])
        shape = polygon([np.zeros(2), 100 * tangent,
                         100 * tangent + 1e-7 * normal, 1e-7 * normal])
        features = detect_features([shape], max_width=2)
        self.assertEqual(len(features), 1)
        self.assertAlmostEqual(features[0].width, 1e-7, delta=1e-13)

    def test_notch_width_does_not_use_whole_polygon_bounds(self):
        shape = polygon([[0, 0], [20, 0], [20, 20], [11, 20],
                         [11, 10], [10, 10], [10, 20], [0, 20]], thickness=0.035)
        features = detect_features([shape], max_width=2)
        self.assertEqual(len(features), 1)
        self.assertEqual(features[0].kind, "notch")
        self.assertAlmostEqual(features[0].width, 1)
        np.testing.assert_allclose(features[0].lo, [10, 10, 0])
        np.testing.assert_allclose(features[0].hi, [11, 20, 0.035])

    def test_coplanar_air_gap_with_sheet_box(self):
        a = polygon([[0, 0], [10, 0], [10, 20], [0, 20]])
        b = Shape("box", None, [10.5, 0, 0], [20, 20, 0])
        features = detect_features([a, b], max_width=2)
        self.assertEqual(len(features), 1)
        self.assertEqual(features[0].kind, "gap")
        self.assertAlmostEqual(features[0].width, 0.5)
        self.assertEqual(features[0].shape_indices, (0, 1))

    def test_no_gap_between_overlapping_touching_or_stacked_sheets(self):
        a = polygon([[0, 0], [10, 0], [10, 20], [0, 20]])
        for lo, hi in (([9.5, 0, 0], [20, 20, 0]), ([10, 0, 0], [20, 20, 0]),
                       ([10.5, 0, 1], [20, 20, 1])):
            self.assertEqual(detect_features([a, Shape("box", None, lo, hi)], max_width=2), [])

    def test_near_vertices_and_short_beveled_corner_are_not_widths(self):
        triangle = polygon([[0, 0], [20, 0], [0, 20]])
        bevel = polygon([[0, 0], [19.9, 0], [20, 0.1], [20, 20], [0, 20]])
        self.assertEqual(detect_features([triangle], max_width=2), [])
        self.assertEqual(detect_features([bevel], max_width=2), [])

    def test_a_filled_notch_is_not_an_air_gap(self):
        shape = polygon([[0, 0], [20, 0], [20, 20], [11, 20],
                         [11, 10], [10, 10], [10, 20], [0, 20]])
        fill = Shape("box", None, [9, 9, 0], [12, 21, 0])
        self.assertEqual(detect_features([shape, fill], max_width=2), [])

    def test_strip_buried_in_another_sheet_has_no_free_width(self):
        strip = polygon([[0, 0], [0.4, 0], [0.4, 20], [0, 20]])
        cover = Shape("box", None, [-1, -1, 0], [2, 21, 0])
        self.assertEqual(detect_features([strip, cover], max_width=2), [])


if __name__ == "__main__":
    unittest.main()
