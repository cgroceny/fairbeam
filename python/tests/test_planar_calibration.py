"""Matched-feed calibration against independent ABCD and nodal circuits; no FDTD."""
import unittest

import numpy as np

from fairbeam.network import (branchline_s, network_s, shift_reference_planes,
                              two_line_calibration)


def abcd_s(m, z=50):
    a, b, c, d = (m[:, i, j] for i, j in ((0, 0), (0, 1), (1, 0), (1, 1)))
    den = a + b/z + c*z + d
    s = np.empty_like(m)
    s[:, 0, 0] = (a + b/z - c*z - d) / den
    s[:, 1, 1] = (-a + b/z - c*z + d) / den
    s[:, 1, 0], s[:, 0, 1] = 2/den, 2*(a*d-b*c)/den
    return s


def line_abcd(electrical_length, z=50):
    v = np.asarray(electrical_length)
    m = np.empty((len(v), 2, 2), complex)
    m[:, 0, 0] = m[:, 1, 1] = np.cosh(v)
    m[:, 0, 1], m[:, 1, 0] = z*np.sinh(v), np.sinh(v)/z
    return m


class PlanarCalibrationTests(unittest.TestCase):
    def setUp(self):
        self.f = np.linspace(.5e9, 9.5e9, 57)
        self.gamma = 4*np.sqrt(self.f/1e9) + 2j*np.pi*self.f/1.9e8
        self.launch = .85*np.exp(-2j*np.pi*self.f*30e-12)
        self.short = abcd_s(line_abcd(self.gamma*.02 - np.log(self.launch)))
        self.long = abcd_s(line_abcd(self.gamma*.08 - np.log(self.launch)))

    def calibrate(self, **kw):
        args = dict(short_length_m=.02, long_length_m=.08, beta_hint=self.gamma.imag*.99)
        args.update(kw)
        return two_line_calibration(self.f, self.short, self.long, **args)

    def test_loss_dispersion_and_wrapped_phase_against_abcd(self):
        cal = self.calibrate()
        np.testing.assert_allclose(cal['gamma_per_m'], self.gamma, atol=3e-12)
        np.testing.assert_allclose(cal['launch_product'], self.launch, atol=3e-14)
        self.assertGreater(np.max(cal['branch']), 2)  # many physical wraps
        self.assertLess(cal['match_max'], 1e-14)
        self.assertLess(cal['reciprocity_max'], 1e-12)

    def test_positive_shift_removes_unequal_feeds_in_nodal_twoport(self):
        delays = np.array([71e-12, 113e-12])
        dut = network_s(self.f, [0, 1], impedances=[(0, 1, 33)])
        measured = network_s(self.f, [0, 3], [(0, 1, 50, delays[0]), (2, 3, 50, delays[1])],
                             impedances=[(1, 2, 33)])
        gamma = 2j*np.pi*self.f/2e8
        before = measured.copy()
        corrected = shift_reference_planes(measured, gamma, delays*2e8)
        np.testing.assert_allclose(corrected, dut, atol=1e-14)
        np.testing.assert_array_equal(measured, before)  # no mutation
        np.testing.assert_allclose(shift_reference_planes(corrected, gamma, -delays*2e8),
                                   measured, atol=1e-14)

    def test_multiport_hybrid_against_independent_nodal_feed_network(self):
        f0, c = 2.4e9, 2e8
        delays = np.array([37, 51, 79, 93])*1e-12
        t = 1/(4*f0)
        arms = [(4, 5, 50/np.sqrt(2), t), (5, 6, 50, t),
                (6, 7, 50/np.sqrt(2), t), (7, 4, 50, t)]
        measured = network_s(self.f, [0, 1, 2, 3],
                             [(i, i+4, 50, delay) for i, delay in enumerate(delays)] + arms)
        corrected = shift_reference_planes(measured, 2j*np.pi*self.f/c, c*delays)
        np.testing.assert_allclose(corrected, branchline_s(self.f, f0), atol=3e-14)

    def test_two_line_gamma_removes_lossy_feeds_using_abcd_cascade(self):
        dut_m = np.broadcast_to(np.array([[1, 33], [0, 1]], complex), (len(self.f), 2, 2))
        measured = abcd_s(line_abcd(self.gamma*.012) @ dut_m @ line_abcd(self.gamma*.021))
        corrected = shift_reference_planes(measured, self.calibrate()['gamma_per_m'], [.012, .021])
        np.testing.assert_allclose(corrected, abcd_s(dut_m), atol=1e-13)

    def test_independently_known_launches_and_per_port_gamma(self):
        # ABCD cascade with two different matched line media and known attenuators.
        g = np.column_stack([self.gamma, self.gamma*1.1])
        launch = np.column_stack([np.full(len(self.f), .9*np.exp(-.1j)),
                                 np.full(len(self.f), .8*np.exp(-.2j))])
        dut_m = np.broadcast_to(np.array([[1, 17], [0, 1]], complex), (len(self.f), 2, 2))
        measured = abcd_s(line_abcd(g[:, 0]*.01 - np.log(launch[:, 0])) @ dut_m @
                          line_abcd(g[:, 1]*.03 - np.log(launch[:, 1])))
        corrected = shift_reference_planes(measured, g, [.01, .03], launch_factors=launch)
        np.testing.assert_allclose(corrected, abcd_s(dut_m), atol=1e-13)

    def test_one_port_reflection_double_distance_and_zero_identity(self):
        f = np.linspace(.5e9, 3e9, 31)
        gamma = 2j*np.pi*f/2e8
        # Input impedance of a lossless line terminated in 100 ohms.
        theta, z0, load = (gamma*.013).imag, 50, 100
        zin = z0*(load + 1j*z0*np.tan(theta))/(z0 + 1j*load*np.tan(theta))
        measured = ((zin-z0)/(zin+z0))[:, None, None]
        np.testing.assert_allclose(shift_reference_planes(measured, gamma, .013), 1/3, atol=1e-14)
        np.testing.assert_array_equal(shift_reference_planes(measured, gamma, 0), measured)

    def test_negative_measured_loss_is_preserved(self):
        self.gamma = -.1 + 1j*self.gamma.imag
        self.short = abcd_s(line_abcd(self.gamma*.02))
        self.long = abcd_s(line_abcd(self.gamma*.08))
        np.testing.assert_allclose(self.calibrate()['gamma_per_m'].real, -.1, atol=1e-12)

    def test_bad_controls_mismatch_missing_column_and_transmission_null(self):
        for change in ('reflection', 'reciprocity', 'nan', 'zero'):
            s = self.long.copy()
            if change == 'reflection':
                s[:, 0, 0] = .1
            elif change == 'reciprocity':
                s[:, 0, 1] *= .9
            elif change == 'nan':
                s[:, :, 1] = np.nan
            else:
                s[:, 1, 0] = 0
            with self.subTest(change=change), self.assertRaises(ValueError):
                two_line_calibration(self.f, self.short, s, short_length_m=.02,
                                     long_length_m=.08, beta_hint=self.gamma.imag)

    def test_invalid_calibration_parameters(self):
        for change in (dict(short_length_m=-1), dict(long_length_m=.02), dict(long_length_m=1j),
                       dict(short_length_m=True), dict(beta_hint=1), dict(beta_hint=self.gamma),
                       dict(beta_hint=[np.nan]*len(self.f)), dict(match_tol=1),
                       dict(reciprocity_tol=-1), dict(transmission_floor=0)):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.calibrate(**change)
        for f in (self.f[::-1], self.f*0, self.f.astype(complex), self.f[:-1], [np.nan]):
            with self.assertRaises(ValueError):
                two_line_calibration(f, self.short, self.long, short_length_m=.02,
                                     long_length_m=.08, beta_hint=self.gamma.imag)

    def test_phase_branch_tie_is_not_silently_chosen(self):
        s = np.zeros((1, 2, 2), complex)
        s[:, 0, 1] = s[:, 1, 0] = 1
        with self.assertRaisesRegex(ValueError, 'branch tie'):
            two_line_calibration([1e9], s, s, short_length_m=0, long_length_m=.1,
                                 beta_hint=[np.pi/.1])

    def test_noisy_directional_branch_ambiguity_is_refused(self):
        short = np.zeros((1, 2, 2), complex)
        short[:, 0, 1] = short[:, 1, 0] = 1
        long = short.copy()
        long[:, 1, 0], long[:, 0, 1] = np.exp(-1j*(np.pi-.001)), np.exp(1j*(np.pi-.001))
        with self.assertRaisesRegex(ValueError, 'incompatible.*branches'):
            two_line_calibration([1e9], short, long, short_length_m=0, long_length_m=.1,
                                 beta_hint=[0])

    def test_small_transmission_phase_does_not_underflow(self):
        short, long = [np.zeros((1, 2, 2), complex) for _ in range(2)]
        short[:, 0, 1] = short[:, 1, 0] = 1e-200*np.exp(-3j)
        long[:, 0, 1] = long[:, 1, 0] = 1e-200*np.exp(-4j)
        cal = two_line_calibration([1e9], short, long, short_length_m=.01, long_length_m=.03,
                                   beta_hint=[50], transmission_floor=1e-250)
        np.testing.assert_allclose(cal['gamma_per_m'], [50j], atol=1e-12)

    def test_unsafe_launch_products_are_refused(self):
        for value in (1e-200, 1e200):
            with self.assertRaisesRegex(ValueError, 'launch product'):
                shift_reference_planes(self.short, self.gamma, 0,
                                       launch_factors=np.full((len(self.f), 2), value))

    def test_invalid_plane_shifts_and_amplification_overflow(self):
        for args in ((self.gamma, [1, 2, 3]), (self.gamma[:-1], [0, 0]),
                     (self.gamma, [1j, 0]), ([np.inf]*len(self.f), 0),
                     (np.full(len(self.f), 1000), 1)):
            with self.subTest(args=args), self.assertRaises(ValueError):
                shift_reference_planes(self.short, *args)
        for launch in (np.ones(2), np.zeros((len(self.f), 2)), np.full((len(self.f), 2), np.nan)):
            with self.assertRaises(ValueError):
                shift_reference_planes(self.short, self.gamma, 0, launch_factors=launch)
        with self.assertRaises(ValueError):
            shift_reference_planes(self.short[:, :, 0], self.gamma, 0)


if __name__ == '__main__':
    unittest.main()
