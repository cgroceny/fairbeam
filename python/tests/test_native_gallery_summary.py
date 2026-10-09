"""The native control must check transmission, coherent gain and completion too."""
import tempfile
from pathlib import Path
import unittest

import numpy as np
from tests.native_gallery_study import save, summarize


class NativeGallerySummaryTest(unittest.TestCase):
    def comparison(self, s, *, transmission_error=0, energy=True):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            # Nonzero incident waves at terminated ports exercise full B @ inv(A),
            # rather than the approximation of dividing each outgoing column.
            a = np.array([[1, .1j], [.05, 1]], complex)
            for j in range(2):
                port = folder / f"port-{j+1}"
                port.mkdir()
                save(port / "summary.json", {"fairbeam_energy": energy, "native_energy": True,
                                             "bundle_rounding_max_abs": 0})
                for route in ("fairbeam", "native"):
                    path = port / route
                    path.mkdir()
                    matrix = s.copy()
                    if route == "native":
                        matrix[0, 1] += transmission_error
                    b = matrix @ a
                    np.savez(path / "waves.npz", frequency_hz=[1e9, 2e9],
                             a=np.repeat(a[:, j, None], 2, axis=1),
                             b=np.repeat(b[:, j, None], 2, axis=1))
            return summarize(folder)

    @staticmethod
    def unitary():
        return np.array([[1, 1j], [1j, 1]], complex) / np.sqrt(2)

    def test_full_matrix_reconstructs_coupled_incident_waves(self):
        result = self.comparison(self.unitary())
        self.assertEqual(result["status"], "results_validated")
        self.assertLess(result["matrix_assembly_max_abs"], 1e-12)

    def test_transmission_mismatch_is_caught_when_reflections_match(self):
        result = self.comparison(self.unitary(), transmission_error=.01)
        self.assertFalse(result["equal_input_pass"])
        self.assertEqual(result["status"], "validation_failed")
        self.assertAlmostEqual(result["complex_max_abs"], .01)

    def test_equal_responses_do_not_validate_unfinished_energy(self):
        result = self.comparison(self.unitary(), energy=False)
        self.assertTrue(result["equal_input_pass"])
        self.assertEqual(result["status"], "validation_failed")

    def test_coherent_gain_is_rejected_even_when_each_column_power_is_below_one(self):
        result = self.comparison(np.full((2, 2), .7, complex))
        self.assertAlmostEqual(result["passivity_max_singular_power"], 1.96)
        self.assertFalse(result["passive"])
        self.assertEqual(result["status"], "validation_failed")


if __name__ == "__main__":
    unittest.main()
