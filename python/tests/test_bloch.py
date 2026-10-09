"""Analytical, phase, power, and Fourier controls; no native solver is used."""
import itertools
import math
import unittest

import numpy as np

from fairbeam import bloch as b


def coordinates(lattice, shape, origin=(0.0, 0.0)):
    u = np.arange(shape[0])[:, None, None] / shape[0]
    v = np.arange(shape[1])[None, :, None] / shape[1]
    return np.asarray(origin) + u * lattice.a1_m + v * lattice.a2_m


def maxwell_fields(mode, polarization, amplitude, direction):
    """Independent 3D Maxwell construction, using peak tangential E amplitudes."""
    te, tm = mode.tangential_basis()
    electric = np.asarray([*(te if polarization == "TE" else tm), 0], dtype=complex)
    kz = direction * mode.kz_rad_m
    if polarization == "TM":
        electric[2] = -math.hypot(mode.kx_rad_m, mode.ky_rad_m) / kz
    electric *= amplitude
    kvec = np.asarray([mode.kx_rad_m, mode.ky_rad_m, kz])
    magnetic = np.cross(kvec, electric) / (2 * math.pi * mode.frequency_hz *
                                            (b.ETA0 / b.C0) * mode.mu_r)
    return electric, magnetic


class LatticeTests(unittest.TestCase):
    def test_reciprocal_duality_and_phase_inverse_for_skew_and_left_handed_cells(self):
        for a1, a2 in (((.01, 0), (.003, .02)), ((.003, .02), (.01, 0)),
                       ((.003, -.004), (.009, .006))):
            with self.subTest(a1=a1, a2=a2):
                lattice = b.Lattice2D(a1, a2)
                np.testing.assert_allclose(np.asarray([a1, a2]) @
                                           np.asarray(lattice.reciprocal_rad_m).T,
                                           2 * math.pi * np.eye(2), atol=2e-15)
                kt = (123.0, -72.0)
                np.testing.assert_allclose(lattice.transverse_k_rad_m(lattice.phase_rad(kt)), kt)
                self.assertAlmostEqual(lattice.area_m2, abs(np.linalg.det([a1, a2])))

    def test_unwrapped_phases_and_positive_translation_sign(self):
        lattice = b.Lattice2D((.01, 0), (0, .02))
        phases = (7 * math.pi, -5 * math.pi)
        kt = lattice.transverse_k_rad_m(phases)
        np.testing.assert_allclose(lattice.phase_rad(kt), phases)
        position = (.003, -.008)
        initial = np.exp(1j * np.dot(kt, position))
        for vector, phase in zip((lattice.a1_m, lattice.a2_m), phases):
            translated = np.exp(1j * np.dot(kt, np.asarray(position) + vector))
            np.testing.assert_allclose(translated / initial, np.exp(1j * phase), atol=2e-15)
        # Reciprocal shifts preserve seam phases but relabel diffraction orders.
        shifted = np.asarray(kt) + lattice.reciprocal_rad_m[0]
        np.testing.assert_allclose(np.exp(1j * np.asarray(lattice.phase_rad(shifted))),
                                   np.exp(1j * np.asarray(phases)), atol=6e-15)

    def test_input_mutation_does_not_change_lattice(self):
        a1 = [.01, 0]
        lattice = b.Lattice2D(a1, [0, .02])
        a1[0] = 100
        self.assertEqual(lattice.a1_m, (.01, 0.0))

    def test_negative_temporal_dft_requires_conjugation_for_this_phasor_convention(self):
        # A real time trace with desired e^-iwt phasor A yields A* under the
        # negative temporal kernel used by openEMS UI_data/DFT_time2freq.
        amplitude = 1.2 + .7j
        samples = 256
        phases = 2 * math.pi * 5 * np.arange(samples) / samples
        trace = np.real(amplitude * np.exp(-1j * phases))
        opposite = 2 * np.mean(trace * np.exp(-1j * phases))
        self.assertAlmostEqual(abs(opposite - amplitude.conjugate()), 0, places=13)
        self.assertAlmostEqual(abs(opposite.conjugate() - amplitude), 0, places=13)

    def test_degenerate_nonfinite_complex_and_extreme_lattices_are_rejected(self):
        cases = [((0, 0), (0, 0)), ((1, 0), (2, 0)), ((1, 0), (1, 1e-14)),
                 ((True, 0), (0, 1)), ((float("nan"), 0), (0, 1)),
                 ((1j, 0), (0, 1)), ((1e200, 0), (0, 1e200)),
                 ((1e-200, 0), (0, 1e-200))]
        for a1, a2 in cases:
            with self.subTest(a1=a1, a2=a2), self.assertRaises(ValueError):
                b.Lattice2D(a1, a2)


class ModeTests(unittest.TestCase):
    def setUp(self):
        self.lattice = b.Lattice2D((.03, 0), (0, .04))

    def mode(self, kt=(0, 0), *, frequency=10e9, eps_r=1, mu_r=1):
        return b.diffraction_orders(self.lattice, kt, frequency, [(0, 0)],
                                    eps_r=eps_r, mu_r=mu_r)[0]

    def test_angles_use_radians_and_fixed_kt_angle_varies_with_frequency(self):
        kt = b.transverse_k_from_angles(10e9, math.pi / 6, math.pi / 3)
        k = 2 * math.pi * 10e9 / b.C0
        np.testing.assert_allclose(kt, (.25 * k, math.sqrt(3) / 4 * k))
        self.assertAlmostEqual(b.fixed_kt_angle_rad(kt, 10e9), math.pi / 6)
        self.assertAlmostEqual(b.fixed_kt_angle_rad(kt, 20e9), math.asin(.25))
        self.assertAlmostEqual(b.fixed_kt_angle_rad(kt, 5e9), math.pi / 2)
        with self.assertRaises(ValueError):
            b.fixed_kt_angle_rad(kt, 4e9)

    def test_outgoing_branch_dispersion_and_orders_on_skew_lattice(self):
        lattice = b.Lattice2D((.02, .005), (.003, .03))
        orders = list(itertools.product(range(-2, 3), repeat=2))
        kt = b.transverse_k_from_angles(12e9, .37, -.82, eps_r=2, mu_r=1.3)
        modes = b.diffraction_orders(lattice, kt, 12e9, orders, eps_r=2, mu_r=1.3)
        k2 = (2 * math.pi * 12e9 / b.C0) ** 2 * 2 * 1.3
        self.assertEqual([(m.m, m.n) for m in modes], orders)
        self.assertEqual({m.classification for m in modes}, {"propagating", "evanescent"})
        for mode in modes:
            self.assertGreaterEqual(mode.kz_rad_m.real, 0)
            self.assertGreaterEqual(mode.kz_rad_m.imag, 0)
            self.assertAlmostEqual((mode.kx_rad_m ** 2 + mode.ky_rad_m ** 2 +
                                    mode.kz_rad_m ** 2).real / k2, 1, places=13)
            factor = np.exp(1j * mode.kz_rad_m * .02)
            self.assertLessEqual(abs(factor), 1 + 1e-15)

    def test_rayleigh_cutoff_is_separate_and_normalization_fails_closed(self):
        lattice = b.Lattice2D((.03, 0), (0, .03))
        f = b.C0 / .03
        for factor, expected in ((1 - 1e-5, "evanescent"), (1, "cutoff"),
                                 (1 + 1e-5, "propagating")):
            mode = b.diffraction_orders(lattice, (0, 0), f * factor, [(1, 0)])[0]
            self.assertEqual(mode.classification, expected)
            if expected == "cutoff":
                self.assertEqual(mode.kz_rad_m, 0j)
                for pol in ("TE", "TM"):
                    with self.assertRaises(ValueError):
                        mode.admittance_siemens(pol)
                    with self.assertRaises(ValueError):
                        mode.power_watts(1, pol, lattice.area_m2)
            if expected != "propagating":
                with self.assertRaises(ValueError):
                    mode.power_normalized_amplitude(1, "TE", lattice.area_m2)

    def test_te_tm_basis_and_admittance_against_oblique_plane_wave(self):
        for eps, mu in ((1, 1), (4, 2)):
            kt = b.transverse_k_from_angles(10e9, .6, -.8, eps_r=eps, mu_r=mu)
            mode = self.mode(kt, eps_r=eps, mu_r=mu)
            te, tm = mode.tangential_basis()
            np.testing.assert_allclose(np.asarray([te, tm]) @ np.asarray([te, tm]).T,
                                       np.eye(2), atol=2e-16)
            eta = b.ETA0 * math.sqrt(mu / eps)
            self.assertAlmostEqual(mode.admittance_siemens("TE").real, math.cos(.6) / eta)
            self.assertAlmostEqual(mode.admittance_siemens("TM").real, 1 / (eta * math.cos(.6)))
        self.assertEqual(self.mode().tangential_basis(), ((-0.0, 1.0), (1.0, 0.0)))
        self.assertAlmostEqual(self.mode().admittance_siemens("TE").real, 1 / b.ETA0)
        self.assertAlmostEqual(self.mode().admittance_siemens("TM").real, 1 / b.ETA0)

    def test_peak_amplitude_power_equals_direct_poynting_and_normalized_magnitude(self):
        kt = b.transverse_k_from_angles(10e9, .72, .35, eps_r=3, mu_r=1.5)
        mode = self.mode(kt, eps_r=3, mu_r=1.5)
        for pol, direction in itertools.product(("TE", "TM"), (-1, 1)):
            e, h = maxwell_fields(mode, pol, 2 + 3j, direction)
            flux = .5 * self.lattice.area_m2 * np.cross(e, h.conj())[2].real
            power = mode.power_watts(2 + 3j, pol, self.lattice.area_m2)
            self.assertAlmostEqual(flux / power, direction, places=13)
            normalized = mode.power_normalized_amplitude(2 + 3j, pol, self.lattice.area_m2)
            self.assertAlmostEqual(abs(normalized) ** 2 / power, 1, places=13)
            self.assertAlmostEqual(np.angle(normalized), np.angle(2 + 3j))

    def test_evanescent_admittance_sign_and_isolated_power(self):
        k = 2 * math.pi * 10e9 / b.C0
        mode = self.mode((2 * k, 0))
        self.assertEqual(mode.classification, "evanescent")
        self.assertAlmostEqual(mode.kz_rad_m.imag, math.sqrt(3) * k)
        self.assertGreater(mode.admittance_siemens("TE").imag, 0)
        self.assertLess(mode.admittance_siemens("TM").imag, 0)
        for pol in ("TE", "TM"):
            self.assertEqual(mode.power_watts(1 + 2j, pol, self.lattice.area_m2), 0)

    def test_dielectric_interface_fresnel_power_balance_and_tm_brewster_zero(self):
        for theta in (0.0, .4, math.atan(2.0)):
            kt = b.transverse_k_from_angles(10e9, theta, .2)
            incident, transmitted = self.mode(kt), self.mode(kt, eps_r=4)
            for pol in ("TE", "TM"):
                y1, y2 = incident.admittance_siemens(pol), transmitted.admittance_siemens(pol)
                reflection = (y1 - y2) / (y1 + y2)
                transmission = 1 + reflection
                self.assertAlmostEqual(abs(reflection) ** 2 +
                                       y2.real / y1.real * abs(transmission) ** 2, 1, places=13)
                if pol == "TM" and theta == math.atan(2.0):
                    self.assertAlmostEqual(abs(reflection), 0, places=13)

    def test_total_internal_reflection_retains_evanescent_transmitted_mode(self):
        kt = b.transverse_k_from_angles(10e9, .9, 0, eps_r=4)
        incident, transmitted = self.mode(kt, eps_r=4), self.mode(kt)
        self.assertEqual(transmitted.classification, "evanescent")
        for pol in ("TE", "TM"):
            y1, y2 = incident.admittance_siemens(pol), transmitted.admittance_siemens(pol)
            self.assertAlmostEqual(abs((y1 - y2) / (y1 + y2)), 1, places=13)

    def test_invalid_scalars_orders_and_normalization_are_rejected(self):
        for bad in (True, float("nan"), float("inf"), "10", 1 + 0j, 10 ** 1000):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.mode(frequency=bad)
        for orders in ([], [(0, 0), (0, 0)], [(0, True)], [(1.0, 0)], [1],
                       [(2 ** 53, 0)], itertools.repeat((1, 0))):
            with self.subTest(orders=orders), self.assertRaises(ValueError):
                b.diffraction_orders(self.lattice, (0, 0), 10e9, orders)
        for kwargs in ({"eps_r": 0}, {"eps_r": -1}, {"eps_r": 1 + 1j},
                       {"mu_r": False}, {"mu_r": float("nan")}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.mode(**kwargs)
        for theta in (-1e-6, math.pi, True, float("inf")):
            with self.subTest(theta=theta), self.assertRaises(ValueError):
                b.transverse_k_from_angles(10e9, theta, 0)
        for amplitude, area, pol in ((float("nan"), 1, "TE"), (1, -1, "TE"),
                                     (1, True, "TE"), (1, 1, "te"), (1e308, 1, "TM")):
            with self.subTest(amplitude=amplitude, area=area, pol=pol), self.assertRaises(ValueError):
                self.mode().power_watts(amplitude, pol, area)
        with self.assertRaises(ValueError):
            b.diffraction_orders(self.lattice, (0, 0), 10e9,
                                  ((i, 0) for i in range(b.MAX_ORDERS + 1)))


class ProjectionTests(unittest.TestCase):
    def synthesize(self, lattice, kt, orders, amplitudes, *, origin=(0, 0), shape=(17, 19)):
        modes = b.diffraction_orders(lattice, kt, 10e9, orders, eps_r=2, mu_r=1.3)
        points = coordinates(lattice, shape, origin)
        e = np.zeros((*shape, 2), dtype=complex)
        h = np.zeros_like(e)
        for mode, values in zip(modes, amplitudes):
            spatial = np.exp(1j * (mode.kx_rad_m * points[..., 0] +
                                   mode.ky_rad_m * points[..., 1]))[..., None]
            for value, (pol, sign) in zip(values, (("TE", 1), ("TE", -1), ("TM", 1), ("TM", -1))):
                electric, magnetic = maxwell_fields(mode, pol, value, sign)
                e += electric[:2] * spatial
                h += magnetic[:2] * spatial
        return modes, e, h

    def test_multimode_cross_polar_and_bidirectional_complex_projection(self):
        lattice = b.Lattice2D((.028, .005), (-.006, .036))
        kt = b.transverse_k_from_angles(10e9, .4, .7, eps_r=2, mu_r=1.3)
        orders = [(0, 0), (1, 0), (-1, 1), (3, -2), (0, -1)]
        rng = np.random.default_rng(731)
        amplitudes = rng.normal(size=(5, 4)) + 1j * rng.normal(size=(5, 4))
        for origin in ((0, 0), (.004, -.003), lattice.a1_m):
            modes, e, h = self.synthesize(lattice, kt, orders, amplitudes, origin=origin)
            self.assertEqual({m.classification for m in modes}, {"propagating", "evanescent"})
            projected = b.project_tangential_fields(lattice, kt, 10e9, orders, e, h,
                                                     eps_r=2, mu_r=1.3, origin_m=origin)
            for values, output in zip(amplitudes, projected):
                np.testing.assert_allclose([output.te_plus_v_m, output.te_minus_v_m,
                                            output.tm_plus_v_m, output.tm_minus_v_m], values,
                                           atol=8e-15, rtol=8e-15)

    def test_order_orthogonality_and_exact_complex_phase_not_magnitude_only(self):
        lattice = b.Lattice2D((.03, 0), (0, .04))
        orders = list(itertools.product(range(-2, 3), repeat=2))
        amplitudes = np.zeros((len(orders), 4), dtype=complex)
        selected = orders.index((-1, 2))
        amplitudes[selected, 0] = np.exp(1j * .83)
        kt = (29.0, -31.0)
        _, e, h = self.synthesize(lattice, kt, orders, amplitudes)
        outputs = b.project_tangential_fields(lattice, kt, 10e9, orders, e, h, eps_r=2, mu_r=1.3)
        actual = np.array([[x.te_plus_v_m, x.te_minus_v_m, x.tm_plus_v_m, x.tm_minus_v_m]
                           for x in outputs])
        np.testing.assert_allclose(actual, amplitudes, atol=2e-15)

    def test_propagating_modal_signed_power_sum_matches_direct_cell_flux(self):
        lattice = b.Lattice2D((.1, 0), (.02, .1))
        kt = (31, -19)
        orders = [(0, 0), (1, 0), (0, -1), (-1, 1)]
        values = np.asarray([[1 + 2j, .2 + .3j, -.4j, .2], [.4, .2j, .1, -.5j],
                             [.3j, -.2, .7j, .1], [-.5, .2j, 1j, -.3]])
        modes, e, h = self.synthesize(lattice, kt, orders, values)
        outputs = b.project_tangential_fields(lattice, kt, 10e9, orders, e, h, eps_r=2, mu_r=1.3)
        flux = .5 * lattice.area_m2 * np.mean((e[..., 0] * h[..., 1].conj() -
                                             e[..., 1] * h[..., 0].conj()).real)
        total = 0
        for mode, coefficients in zip(modes, outputs):
            self.assertEqual(mode.classification, "propagating")
            total += mode.power_watts(coefficients.te_plus_v_m, "TE", lattice.area_m2)
            total -= mode.power_watts(coefficients.te_minus_v_m, "TE", lattice.area_m2)
            total += mode.power_watts(coefficients.tm_plus_v_m, "TM", lattice.area_m2)
            total -= mode.power_watts(coefficients.tm_minus_v_m, "TM", lattice.area_m2)
        self.assertAlmostEqual(total / flux, 1, places=13)

    def test_evanescent_pair_interference_can_carry_flux(self):
        lattice = b.Lattice2D((.01, 0), (0, .01))
        values = [[1, 1j, 0, 0]]
        modes, e, h = self.synthesize(lattice, (0, 0), [(1, 0)], values)
        self.assertEqual(modes[0].classification, "evanescent")
        flux = .5 * lattice.area_m2 * np.mean((e[..., 0] * h[..., 1].conj() -
                                             e[..., 1] * h[..., 0].conj()).real)
        self.assertGreater(abs(flux), 1e-8)
        self.assertEqual(modes[0].power_watts(1, "TE", lattice.area_m2), 0)
        self.assertEqual(modes[0].power_watts(1j, "TE", lattice.area_m2), 0)

    def test_even_grid_negative_nyquist_order_and_odd_grid_positive_edge(self):
        lattice = b.Lattice2D((.03, 0), (0, .04))
        for shape, order in (((8, 10), (-4, -5)), ((9, 11), (4, 5))):
            _, e, h = self.synthesize(lattice, (0, 0), [order], [[1j, 0, 0, 0]], shape=shape)
            output = b.project_tangential_fields(lattice, (0, 0), 10e9, [order], e, h,
                                                   eps_r=2, mu_r=1.3)[0]
            self.assertAlmostEqual(abs(output.te_plus_v_m - 1j), 0, places=13)

    def test_invalid_grid_alias_cutoff_and_resource_bounds(self):
        lattice = b.Lattice2D((.03, 0), (0, .04))
        e = np.zeros((8, 10, 2), dtype=complex)
        for orders in ([(4, 0)], [(0, 5)], [(-5, 0)]):
            with self.subTest(orders=orders), self.assertRaises(ValueError):
                b.project_tangential_fields(lattice, (0, 0), 10e9, orders, e, e)
        for bad in (np.zeros((8, 10)), np.zeros((8, 10, 3)), np.zeros((1, 10, 2)),
                    np.full((8, 10, 2), np.nan), np.full((8, 10, 2), "x"),
                    np.zeros((8, 10, 2), dtype=bool), np.zeros((4, 10, 2))):
            with self.subTest(shape=bad.shape), self.assertRaises(ValueError):
                b.project_tangential_fields(lattice, (0, 0), 10e9, [(0, 0)], bad, e)
        with self.assertRaises(ValueError):
            b.project_tangential_fields(lattice, (0, 0), b.C0 / .03, [(1, 0)], e, e)
        oversized = np.broadcast_to(np.zeros(2), (1025, 1025, 2))
        with self.assertRaises(ValueError):
            b.project_tangential_fields(lattice, (0, 0), 10e9, [(0, 0)], oversized, oversized)


if __name__ == "__main__":
    unittest.main()
