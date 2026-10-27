"""Engine / end-criterion options of Simulation.run (no openEMS run needed)."""

from contextlib import nullcontext
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from fairbeam.simulation import Simulation, _parse_log


class EngineOptions(unittest.TestCase):
    def test_default_end_criterion_is_minus_60(self):
        self.assertEqual(Simulation(1e9, 2e9).end_criteria_db, -60.0)

    def test_unknown_engine_rejected_before_running(self):
        sim = Simulation(1e9, 2e9)
        with self.assertRaises(ValueError):
            sim.run("/nonexistent/should-not-be-created", engine="quantum")

    def test_parse_log_convergence_from_timesteps(self):
        log = "Time for 1200 iterations with 1000.00 cells : 0.10 sec\nSpeed: 12.0 MCells/s\n"
        s = _parse_log(log, -60.0, 60000)
        self.assertTrue(s["converged"])
        s = _parse_log(log.replace("1200", "60000"), -60.0, 60000)
        self.assertFalse(s["converged"])


class NonfiniteNativeEnergy(unittest.TestCase):
    # Reduced from our Windows openEMS 0.37.0rc3 L/C control. The native
    # calculation returns normally; port loading then fails on '-nan(ind)'.
    SAMPLE = ("[@        4s] Timestep:       178464 || Speed:   36.0 MC/s "
              "(2.277e-05 s/TS) || Energy: ~-nan(ind) (- 0.00dB)\n")
    TIMING = "Time for 2000000 iterations with 819.00 cells : 45.62 sec\n"

    def simulation(self):
        sim = Simulation.__new__(Simulation)
        sim.mesh = SimpleNamespace(GetLines=lambda axis: [0., 1.])
        sim.fdtd = SimpleNamespace(Run=mock.Mock())
        sim.ports = []
        sim.excitation = {"type": "gaussian"}
        sim.end_criteria_db, sim.max_timesteps = -90., 2000000
        sim.dispersions = {}
        sim.run_stats = {"converged": True, "timesteps": 123}
        return sim

    def run_logged(self, sim, text):
        # Split the native token across captured chunks, as the pipe may do.
        offset = text.find("nan") + 1
        chunks = [text[:offset].encode(), text[offset:].encode()]
        with tempfile.TemporaryDirectory() as root, \
                mock.patch("fairbeam.simulation._capture_output", return_value=nullcontext(chunks)), \
                mock.patch("fairbeam.resources.free_memory_bytes", return_value=2**30), \
                mock.patch("fairbeam.simulation._cpu_name", return_value="test CPU"):
            return sim.run(root, threads=1, echo=False)

    def test_native_nan_is_rejected_and_previous_statistics_are_cleared(self):
        sim = self.simulation()
        with self.assertRaisesRegex(RuntimeError, "non-finite.*energy") as caught:
            self.run_logged(sim, self.SAMPLE + self.TIMING)
        self.assertIn("-nan(ind)", str(caught.exception))
        self.assertEqual(sim.run_stats, {})
        sim.fdtd.Run.assert_called_once()

    def test_portable_nonfinite_linear_values_are_rejected(self):
        for token in ("nan", "NaN", "+nan", "-nan(ind)", "inf", "+Inf", "-Infinity"):
            with self.subTest(token=token), self.assertRaisesRegex(RuntimeError, "non-finite.*energy"):
                self.run_logged(self.simulation(), self.SAMPLE.replace("-nan(ind)", token) + self.TIMING)

    def test_later_finite_sample_does_not_hide_invalid_energy(self):
        finite = self.SAMPLE.replace("-nan(ind)", "2.67e-26").replace("0.00dB", "81.35dB")
        with self.assertRaisesRegex(RuntimeError, "non-finite.*energy"):
            self.run_logged(self.simulation(), self.SAMPLE + finite + self.TIMING)

    def test_finite_and_zero_linear_energy_keep_existing_results(self):
        for energy in ("2.67e-26 (-81.35dB)", "0.00e+00 (-infdB)"):
            text = self.SAMPLE.replace("-nan(ind) (- 0.00dB)", energy) + self.TIMING
            with self.subTest(energy=energy):
                stats = self.run_logged(self.simulation(), text)
                self.assertFalse(stats["converged"])
                self.assertTrue(stats["hit_timestep_limit"])
                self.assertEqual(stats["timesteps"], 2000000)

    def test_material_names_are_not_native_energy_samples(self):
        text = "Loaded material 'Energy: ~nan', output nanotube-inf.txt\n" + self.TIMING
        stats = self.run_logged(self.simulation(), text)
        self.assertEqual(stats["timesteps"], 2000000)

    def test_user_abort_keeps_precedence_over_numerical_failure(self):
        text = self.SAMPLE + "openEMS::CheckAbortCond(): Received SIGINT, aborting simulation gracefully...\n" + self.TIMING
        with self.assertRaises(KeyboardInterrupt):
            self.run_logged(self.simulation(), text)


if __name__ == "__main__":
    unittest.main()
