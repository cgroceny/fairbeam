"""Synthetic stored-grid array integration; no FDTD, process launch or network use."""
import copy
import unittest

import numpy as np

from fairbeam.array import ETA0, combine
from fairbeam.multiport import ENC_F32, encode_pattern_fields


def bundle(theta, phi, intensity):
    """One unit-driven synthetic element; float32 storage exercises the real decode path."""
    theta, phi = np.asarray(theta, float), np.asarray(phi, float)
    intensity = np.broadcast_to(np.asarray(intensity, float), (len(theta), len(phi)))
    field = np.sqrt(intensity).astype(complex)
    return {"results": {"element_patterns": {
        "radius_m": 1.0, "encoding": ENC_F32, "shape": list(field.shape),
        "theta": theta.tolist(), "phi": phi.tolist(), "frequencies": [1e9],
        "mirror_planes": 0, "ports": [{"port": 1, "position": [0, 0, 0],
            "fields": [encode_pattern_fields(1e9, field, np.zeros_like(field), ENC_F32)]}],
    }}}


class ArrayAngularGrid(unittest.TestCase):
    def test_constant_power_has_same_normalization_on_irregular_and_single_phi(self):
        # With theta 0, 90, 180, the retained theta trapezoid of sin(theta) is pi/2,
        # not the exact continuous integral 2. This test does not silently change that policy.
        for phi in ([0], [0, 60, 180, 300], [10, 25, 201, 359], np.arange(0, 360, 11)):
            with self.subTest(phi=list(phi)):
                b = bundle([0, 90, 180], phi, 1)
                before = copy.deepcopy(b)
                result = combine(b, {1: 1})
                self.assertAlmostEqual(result["p_rad_w"], np.pi ** 2 / (2 * ETA0), places=12)
                self.assertAlmostEqual(result["dmax_dbi"], 10 * np.log10(4 / np.pi), places=12)
                self.assertEqual(result["theta"], b["results"]["element_patterns"]["theta"])
                self.assertEqual(result["phi"], list(phi))
                self.assertEqual(b, before)

    def test_asymmetric_periodic_piecewise_linear_integral(self):
        # Independent segment areas in degree*intensity:
        # 0..60:120, 60..180:240, 180..300:60, 300..360:30 => 450 = 2.5*pi radians.
        # Pole rows are constant so the synthetic spherical field is single-valued there.
        b = bundle([0, 90, 180], [0, 60, 180, 300], [[1] * 4, [1, 3, 1, 0], [1] * 4])
        result = combine(b, {1: 1})
        expected_integral = 2.5 * np.pi * (np.pi / 2)
        self.assertAlmostEqual(result["p_rad_w"], expected_integral / (2 * ETA0), delta=2e-9)
        self.assertAlmostEqual(result["dmax_dbi"], 10 * np.log10(12 * np.pi / expected_integral), delta=1e-6)
        self.assertAlmostEqual(result["total_efficiency"], expected_integral / ETA0, delta=4e-9)
        b["results"]["element_patterns"]["mirror_planes"] = 1
        mirrored = combine(b, {1: 1})
        self.assertAlmostEqual(mirrored["p_rad_w"], result["p_rad_w"] / 2, places=12)
        self.assertAlmostEqual(mirrored["dmax_dbi"] - result["dmax_dbi"], 10 * np.log10(2), places=12)

    def test_nondivisor_and_near_seam_cosine_do_not_double_count_the_seam(self):
        theta = np.arange(0, 181, 1.0)
        # U = 2 + sin(theta) cos(phi) has exact continuous sphere integral 8*pi.
        # At four quadrants the phi trapezoid integrates cos(phi) to zero exactly; the
        # near-360 fifth sample must not give phi=0 a second equal share of the sphere.
        for step in (11.0, 89.999999):
            phi = np.arange(0, 360, step)
            intensity = 2 + np.sin(np.deg2rad(theta))[:, None] * np.cos(np.deg2rad(phi))
            result = combine(bundle(theta, phi, intensity), {1: 1})
            with self.subTest(step=step):
                integral = result["p_rad_w"] * (2 * ETA0)
                self.assertAlmostEqual(integral, 8 * np.pi, delta=0.002)
                self.assertAlmostEqual(result["dmax_dbi"], 10 * np.log10(1.5), delta=0.001)

    def test_uniform_phi_keeps_previous_theta_quadrature(self):
        theta = np.arange(0, 181, 3.0)
        phi = np.arange(0, 360, 5.0)
        intensity = 2 + np.sin(np.deg2rad(theta))[:, None] * np.cos(np.deg2rad(phi))
        b = bundle(theta, phi, intensity)
        result = combine(b, {1: 1})
        # The analytic cosine mean is zero on this uniform periodic grid.
        expected = 4 * np.pi * np.trapezoid(np.sin(np.deg2rad(theta)), np.deg2rad(theta))
        self.assertAlmostEqual(result["p_rad_w"] * (2 * ETA0), expected, delta=2e-6)

    def test_invalid_coordinates_and_shape_gaps_are_rejected(self):
        good = bundle([0, 90, 180], [0, 90, 180, 270], 1)
        for axis, coordinates in (
                ("phi", []), ("phi", [0, 90, 90, 270]), ("phi", [0, 180, 90, 270]),
                ("phi", [0, 90, 180, 360]), ("phi", [-1, 90, 180, 270]),
                ("phi", [0, 90, float("nan"), 270]), ("phi", [0, 90, float("inf"), 270]),
                ("phi", [[0, 90], [180, 270]]), ("phi", [0, 90, 180]),
                ("theta", [0, 180]), ("theta", [0, 90, 90]), ("theta", [0, 180, 90]),
                ("theta", [1, 90, 180]), ("theta", [0, 90, 179]),
                ("theta", [0, float("nan"), 180]), ("theta", [0, float("inf"), 180])):
            with self.subTest(axis=axis, coordinates=coordinates):
                bad = copy.deepcopy(good)
                bad["results"]["element_patterns"][axis] = coordinates
                with self.assertRaises(ValueError):
                    combine(bad, {1: 1})

    def test_nonfinite_fields_weights_and_zero_radiation_do_not_report_results(self):
        for value in (float("nan"), float("inf")):
            with self.subTest(field=value):
                data = np.ones((3, 4), complex)
                data[1, 2] = value
                bad = bundle([0, 90, 180], [0, 90, 180, 270], 1)
                bad["results"]["element_patterns"]["ports"][0]["fields"] = [
                    encode_pattern_fields(1e9, data, np.zeros_like(data), ENC_F32)]
                with self.assertRaisesRegex(ValueError, "fields must be finite"):
                    combine(bad, {1: 1})
            with self.subTest(weight=value), self.assertRaisesRegex(ValueError, "weights must be finite"):
                combine(bundle([0, 90, 180], [0, 90, 180, 270], 1), {1: value})
        with self.assertRaisesRegex(ValueError, "radiation power cannot be determined"):
            combine(bundle([0, 90, 180], [0, 90, 180, 270], 0), {1: 1})


if __name__ == "__main__":
    unittest.main()
