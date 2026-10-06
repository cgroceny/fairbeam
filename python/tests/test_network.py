"""Circuit references checked against independent analytic identities."""
import unittest
import numpy as np
from fairbeam.network import branchline_s, network_s, wilkinson_s


def _line_abcd(f, delay, z, r1, r2):
    theta = 2 * np.pi * f * delay
    a = d = np.cos(theta)
    b, c = 1j * z * np.sin(theta), 1j * np.sin(theta) / z
    den = a * r2 + b + c * r1 * r2 + d * r1
    out = np.empty((len(f), 2, 2), complex)
    out[:, 0, 0] = (a * r2 + b - c * r1 * r2 - d * r1) / den
    out[:, 1, 1] = (-a * r2 + b - c * r1 * r2 + d * r1) / den
    out[:, 0, 1] = out[:, 1, 0] = 2 * np.sqrt(r1 * r2) / den
    return out


class NetworkReferenceTests(unittest.TestCase):
    def test_matched_line_at_quarter_half_and_full_wave(self):
        f = np.array([1, 2, 4]) * 1e9
        s = network_s(f, [0, 1], [(0, 1, 50, .25e-9)])
        np.testing.assert_allclose(s[:, 0, 0], 0, atol=1e-14)
        np.testing.assert_allclose(s[:, 1, 0], [-1j, -1, 1], atol=1e-14)
        np.testing.assert_allclose(s, s.transpose(0, 2, 1), atol=1e-14)

    def test_unequal_reference_impedances_against_abcd(self):
        f = np.linspace(.1e9, 4e9, 37)
        s = network_s(f, [0, 1], [(0, 1, 40, .25e-9)], z_ref=[33, 75])
        np.testing.assert_allclose(s, _line_abcd(f, .25e-9, 40, 33, 75), atol=1e-14)
        transformer = network_s([1e9], [0, 1], [(0, 1, np.sqrt(50 * 100), .25e-9)], z_ref=[50, 100])[0]
        np.testing.assert_allclose(transformer, [[0, -1j], [-1j, 0]], atol=1e-14)

    def test_series_short_and_resistor(self):
        short = network_s([1e9], [0, 1], impedances=[(0, 1, 0)])[0]
        resistor = network_s([1e9], [0, 1], impedances=[(0, 1, 50)])[0]
        np.testing.assert_allclose(short, [[0, 1], [1, 0]], atol=1e-14)
        np.testing.assert_allclose(resistor, [[1/3, 2/3], [2/3, 1/3]], atol=1e-14)

    def test_grounded_load_and_frequency_dependent_admittance(self):
        f = np.array([1, 2, 3]) * 1e9
        z = 1j * 2 * np.pi * f * 10e-9
        a = network_s(f, [0], impedances=[(0, -1, z)])
        b = network_s(f, [0], admittances=[(-1, 0, 1 / z)])
        target = (z - 50) / (z + 50)
        np.testing.assert_allclose(a[:, 0, 0], target, atol=1e-14)
        np.testing.assert_allclose(a, b, atol=1e-14)

    def test_resonant_series_lc_is_an_exact_short(self):
        w = 2 * np.pi * 1e9
        l, c = 1e-9, 1 / (w * w * 1e-9)
        s = network_s([1e9], [0, 1], impedances=[(0, 1, 1j * w * l + 1 / (1j * w * c))])[0]
        np.testing.assert_allclose(s, [[0, 1], [1, 0]], atol=1e-14)

    def test_butterworth_ladder_against_power_polynomial(self):
        fc, z0 = 2.5e9, 50
        f = np.array([.1, .7, 1, 1.6, 3]) * fc
        w, wc = 2 * np.pi * f, 2 * np.pi * fc
        s = network_s(f, [0, 2], impedances=[(0, 1, 1j * w * z0 / wc), (1, 2, 1j * w * z0 / wc)],
                      admittances=[(1, -1, 1j * w * 2 / (wc * z0))])
        np.testing.assert_allclose(abs(s[:, 1, 0]) ** 2, 1 / (1 + (f / fc) ** 6), atol=1e-14)
        np.testing.assert_allclose(np.sum(abs(s[:, :, 0]) ** 2, axis=1), 1, atol=1e-14)

    def test_wilkinson_against_even_and_odd_mode_reference(self):
        f0, z0 = 2.4e9, 50
        f = np.array([.25, .5, .7, 1, 1.5, 2, 4]) * f0
        s = wilkinson_s(f, f0, z0)
        even = _line_abcd(f, 1 / (4 * f0), z0 / np.sqrt(2), z0, z0 / 2)
        theta = 2 * np.pi * f / (4 * f0)
        odd = (1j * np.cos(theta) / np.sqrt(2)) / (2 * np.sin(theta) - 1j * np.cos(theta) / np.sqrt(2))
        target = np.zeros_like(s)
        target[:, 0, 0] = even[:, 0, 0]
        target[:, 1, 0] = target[:, 2, 0] = target[:, 0, 1] = target[:, 0, 2] = even[:, 1, 0] / np.sqrt(2)
        target[:, 1, 1] = target[:, 2, 2] = (even[:, 1, 1] + odd) / 2
        target[:, 1, 2] = target[:, 2, 1] = (even[:, 1, 1] - odd) / 2
        np.testing.assert_allclose(s, target, atol=2e-14)
        center = wilkinson_s([f0], f0)[0]
        np.testing.assert_allclose(center[:, 0], [0, -1j / np.sqrt(2), -1j / np.sqrt(2)], atol=1e-14)
        np.testing.assert_allclose(center @ np.array([0, 1, -1]) / np.sqrt(2), 0, atol=1e-14)
        self.assertAlmostEqual(np.sum(abs(center @ np.array([0, 1, 1]) / np.sqrt(2)) ** 2), 1, places=14)

    def test_branchline_power_reciprocity_and_quadrature(self):
        f = np.linspace(.2e9, 4.8e9, 53)
        s = branchline_s(f, 2.4e9)
        np.testing.assert_allclose(s.conj().transpose(0, 2, 1) @ s, np.broadcast_to(np.eye(4), s.shape), atol=2e-13)
        np.testing.assert_allclose(s, s.transpose(0, 2, 1), atol=2e-13)
        ss = branchline_s([2.4e9], 2.4e9)[0]
        np.testing.assert_allclose(ss[:, 0], [0, -1j / np.sqrt(2), -1 / np.sqrt(2), 0], atol=1e-14)

    def test_port_order_and_internal_nodes(self):
        elements = [(0, 1, 25), (1, 2, 25)]
        s = network_s([1e9], [0, 2], impedances=elements, z_ref=[50, 75])
        swapped = network_s([1e9], [2, 0], impedances=elements, z_ref=[75, 50])
        np.testing.assert_allclose(swapped, s[:, ::-1, ::-1], atol=1e-14)

    def test_invalid_inputs(self):
        cases = [dict(f=[0], ports=[0]), dict(f=[np.nan], ports=[0]), dict(f=[1+0j], ports=[0]),
                 dict(f=[1], ports=[]), dict(f=[1], ports=[0, 0]), dict(f=[1], ports=[0, 2]),
                 dict(f=[1], ports=[0, 10**9]), dict(f=[1], ports=[False]), dict(f=[1], ports=[.5]),
                 dict(f=[1], ports=[-1]), dict(f=[1], ports=[np.inf]), dict(f=[1], ports=["0"]),
                 dict(f=[1], ports=[0], z_ref=0), dict(f=[1], ports=[0], z_ref=50+1j),
                 dict(f=[1], ports=[0, 1], z_ref=[50, 50, 50]),
                 dict(f=[1], ports=[0, 1], lines=[(0, 1, -50, 1)]),
                 dict(f=[1], ports=[0, 1], lines=[(0, 1, 50+1j, 1)]),
                 dict(f=[1], ports=[0, 1], lines=[(0, 1, 50, 0)]),
                 dict(f=[1], ports=[0], admittances=[(0, 0, 1)]),
                 dict(f=[1], ports=[0], admittances=[(0, -1, [1, 2])]),
                 dict(f=[1], ports=[0], impedances=[(0, -1, np.inf)])]
        for args in cases:
            with self.subTest(args=args), self.assertRaises(ValueError):
                network_s(**args)
        for helper in (wilkinson_s, branchline_s):
            for f0, z0 in ((0, 50), (np.inf, 50), (1e9, 0), (1e9, 50+1j), (None, 50)):
                with self.assertRaises(ValueError):
                    helper([1e9], f0, z0)

    def test_singular_floating_network_is_not_regularized(self):
        with self.assertRaises(np.linalg.LinAlgError):
            network_s([1e9], [0], admittances=[(1, 2, 1)])


if __name__ == "__main__":
    unittest.main()
