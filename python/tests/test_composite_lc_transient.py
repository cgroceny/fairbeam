"""Independent frequency/energy/time checks; no FDTD is started."""
from copy import deepcopy
import unittest
import numpy as np
from tests import composite_lc_filter_fixture as f
from tests import composite_lc_transient as t


class CompositeTransientTests(unittest.TestCase):
    def test_all_three_graphs_match_nodal_and_lossless_terminal_power(self):
        for kind in f.KINDS:
            circuit = t.build(f.elements(kind))
            actual = circuit.scattering(f.FREQUENCIES)
            np.testing.assert_allclose(actual, f.reference(kind=kind), rtol=0, atol=2e-12)
            np.testing.assert_allclose(actual, actual.transpose(0, 2, 1), rtol=0, atol=2e-12)
            product = actual.conj().transpose(0, 2, 1) @ actual
            np.testing.assert_allclose(product, np.broadcast_to(np.eye(2), product.shape), rtol=0, atol=3e-12)
        mask = abs(f.FREQUENCIES-f.F_ZERO) > 1
        np.testing.assert_allclose(t.build(f.elements()).scattering(f.FREQUENCIES[mask]),
            f.independent_abcd(f.FREQUENCIES[mask])[0], rtol=0, atol=2e-12)

    def test_stored_energy_and_port_power_have_the_exact_passive_balance(self):
        circuit = t.build(f.elements())
        np.testing.assert_allclose(circuit.b, circuit.current_map.T, rtol=0, atol=0)
        scale = np.linalg.norm(circuit.a, 2)
        np.testing.assert_allclose(circuit.a+circuit.a.T,
            -2*circuit.resistance*circuit.current_map.T@circuit.current_map,
            rtol=0, atol=scale*1e-14)
        state = np.arange(1, len(circuit.a)+1, dtype=float)*1e-6
        source = np.array([.2, -.1]); current = circuit.current_map@state
        derivative = state@(circuit.a@state+circuit.b@source)
        self.assertAlmostEqual(derivative, (source-circuit.resistance*current)@current, places=16)

    def test_series_inductor_has_the_independent_RL_transfer(self):
        inductance, resistance = 2e-6, 75.
        circuit = t.build([dict(kind='L', a=0, b=6, value_si=inductance)])
        frequency = np.array([.5e6, 2e6, 3e6]); z = 2j*np.pi*frequency*inductance
        actual = circuit.scattering(frequency)
        np.testing.assert_allclose(actual[:, 0, 0], z/(2*resistance+z), rtol=0, atol=3e-15)
        np.testing.assert_allclose(actual[:, 1, 0], 2*resistance/(2*resistance+z), rtol=0, atol=3e-15)
        np.testing.assert_allclose(circuit.a, [[-2*resistance/inductance]], rtol=1e-14)

    def test_direct_through_has_zero_energy_and_exact_finite_window_waves(self):
        circuit = t.build([]); clock = np.arange(501)*10e-9
        result = t.window_s(circuit, clock, [.5e6, 2e6, 3e6])
        expected = np.broadcast_to([[0., 1.], [1., 0.]], (3, 2, 2))
        np.testing.assert_allclose(result['s'], expected, rtol=0, atol=2e-15)
        for row in result['records']:
            self.assertFalse(np.any(row['energy_j']))
        self.assertFalse(result['qualified'])

    def test_late_window_matches_transfer_and_finer_source_quadrature(self):
        circuit = t.build(f.elements()); frequency = np.array([.5e6, 1.5e6, 2.05e6, 3e6])
        # The slowest pole has a 4.22 us amplitude decay time. This is a
        # 130 us circuit calculation, not a request for a native long run.
        first = t.window_s(circuit, np.arange(13001)*10e-9, frequency)
        second = t.window_s(circuit, np.arange(26001)*5e-9, frequency)
        target = circuit.scattering(frequency)
        self.assertLess(abs(first['s']-target).max(), 1e-8)
        self.assertLess(abs(first['s']-second['s']).max(), 1e-8)
        for row in first['records']:
            self.assertTrue(np.isfinite(row['energy_j']).all())
            peak = row['energy_j'].max()
            self.assertGreater(peak, 0)
            self.assertLess(np.diff(row['energy_j'][row['time_s']>=4e-6]).max(), 1e-12*peak)
        self.assertFalse(first['qualified'])

    def test_a_short_record_keeps_the_missing_tail_error(self):
        circuit = t.build(f.elements())
        frequency = np.array([.5e6, 1.5e6, 2.05e6, 3e6])
        short = t.window_s(circuit, np.arange(2001)*10e-9, frequency)
        self.assertGreater(abs(short['s']-circuit.scattering(frequency)).max(), f.LIMITS['s_target_abs'])
        self.assertFalse(short['qualified'])

    def test_fourier_estimates_refuse_incomplete_source_or_unexcited_band(self):
        circuit = t.build([])
        with self.assertRaisesRegex(ValueError, 'complete source'):
            t.window_s(circuit, np.arange(101)*10e-9, [.5e6, 3e6])
        with self.assertRaisesRegex(ValueError, 'pulse band'):
            t.window_s(circuit, np.arange(501)*10e-9, [.5e6, 10e6])

    def test_causal_pulse_and_invalid_graphs_clocks_or_frequencies_are_refused(self):
        self.assertEqual(t.gaussian_derivative(-1.), 0.)
        for change in ({'value_si': -1.}, {'kind': 'R'}, {'b': 1}, {'a': 0}):
            cap = dict(kind='C', a=2, b=-1, value_si=1e-9); cap.update(change)
            with self.assertRaises(ValueError): t.build([cap])
        circuit = t.build(f.elements())
        for clock in ([1e-9, 2e-9], [0., 0.], [0., float('nan')], [0., 1e-6]):
            with self.assertRaises(ValueError): t.transient(circuit, clock)
        for frequency in ([0.], [float('nan')], [1+1j]):
            with self.assertRaises(ValueError): circuit.scattering(frequency)
        changed = deepcopy(f.elements()); changed[0]['value_si'] *= 1.01
        self.assertGreater(abs(t.build(changed).scattering(f.FREQUENCIES)-f.reference()).max(), .001)


if __name__ == '__main__':
    unittest.main()
