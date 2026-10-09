"""Discrete checks for the isolated paired-quadrature Bloch seam reference."""

import unittest

import numpy as np

from fairbeam.bloch_reference import FieldQuadratures, bloch_yee_curl_1d


class BlochYeeReferenceTests(unittest.TestCase):
    def test_quadrature_stencil_matches_independent_complex_reference(self):
        rng = np.random.default_rng(461)
        e = rng.normal(size=19) + 1j * rng.normal(size=19)
        h = rng.normal(size=19) + 1j * rng.normal(size=19)
        phase = -1.13
        spacing = 0.0027

        curl = bloch_yee_curl_1d(
            FieldQuadratures(e.real, e.imag),
            FieldQuadratures(h.real, h.imag),
            phase_rad=phase,
            spacing_m=spacing,
        )

        e_next = np.concatenate((e[1:], [e[0] * np.exp(1j * phase)]))
        h_prev = np.concatenate(([h[-1] * np.exp(-1j * phase)], h[:-1]))
        np.testing.assert_allclose(curl.d_electric_dx_at_h.complex, (e_next - e) / spacing,
                                   rtol=1e-13, atol=1e-13)
        np.testing.assert_allclose(curl.d_magnetic_dx_at_e.complex, (h - h_prev) / spacing,
                                   rtol=1e-13, atol=1e-13)

    def test_zero_phase_matches_ordinary_periodic_yee_stencil(self):
        rng = np.random.default_rng(462)
        e_real, e_imag, h_real, h_imag = (rng.normal(size=23) for _ in range(4))
        spacing = 0.004

        curl = bloch_yee_curl_1d(
            FieldQuadratures(e_real, e_imag),
            FieldQuadratures(h_real, h_imag),
            phase_rad=0.0,
            spacing_m=spacing,
        )

        np.testing.assert_allclose(curl.d_electric_dx_at_h.real,
                                   (np.roll(e_real, -1) - e_real) / spacing)
        np.testing.assert_allclose(curl.d_electric_dx_at_h.imag,
                                   (np.roll(e_imag, -1) - e_imag) / spacing)
        np.testing.assert_allclose(curl.d_magnetic_dx_at_e.real,
                                   (h_real - np.roll(h_real, 1)) / spacing)
        np.testing.assert_allclose(curl.d_magnetic_dx_at_e.imag,
                                   (h_imag - np.roll(h_imag, 1)) / spacing)

    def test_single_plane_wave_has_the_discrete_derivative_symbol(self):
        cells = 37
        spacing = 0.003
        length = cells * spacing
        # Keep an unwrapped phase so this also checks that theta is not folded.
        phase = 2 * np.pi + 0.41
        wave_number = phase / length
        e_x = np.arange(cells) * spacing
        h_x = (np.arange(cells) + 0.5) * spacing
        e = np.exp(1j * wave_number * e_x)
        h = np.exp(1j * wave_number * h_x)

        curl = bloch_yee_curl_1d(
            FieldQuadratures(e.real, e.imag),
            FieldQuadratures(h.real, h.imag),
            phase_rad=phase,
            spacing_m=spacing,
        )

        symbol = 2 * np.sin(wave_number * spacing / 2) / spacing
        np.testing.assert_allclose(curl.d_electric_dx_at_h.complex, 1j * symbol * h,
                                   rtol=2e-12, atol=2e-12)
        np.testing.assert_allclose(curl.d_magnetic_dx_at_e.complex, 1j * symbol * e,
                                   rtol=2e-12, atol=2e-12)

    def test_forward_and_backward_stencils_obey_lossless_adjoint_identity(self):
        rng = np.random.default_rng(463)
        e = rng.normal(size=31) + 1j * rng.normal(size=31)
        h = rng.normal(size=31) + 1j * rng.normal(size=31)

        curl = bloch_yee_curl_1d(
            FieldQuadratures(e.real, e.imag),
            FieldQuadratures(h.real, h.imag),
            phase_rad=0.73,
            spacing_m=0.0019,
        )
        power_exchange = (np.vdot(e, curl.d_magnetic_dx_at_e.complex)
                          + np.vdot(h, curl.d_electric_dx_at_h.complex))

        self.assertAlmostEqual(power_exchange.real, 0.0, places=10)

    def test_invalid_mesh_and_phase_inputs_are_rejected(self):
        e = FieldQuadratures([1.0, 2.0], [0.0, 0.0])
        h = FieldQuadratures([0.0, 1.0], [1.0, 0.0])
        for phase, spacing in ((float("nan"), 1.0), (0.0, 0.0), (0.0, float("inf"))):
            with self.subTest(phase=phase, spacing=spacing), self.assertRaises(ValueError):
                bloch_yee_curl_1d(e, h, phase_rad=phase, spacing_m=spacing)
        with self.assertRaises(ValueError):
            FieldQuadratures([1.0 + 1j], [0.0])


if __name__ == "__main__":
    unittest.main()
