"""Engine / end-criterion options of Simulation.run (no openEMS run needed)."""

from contextlib import nullcontext
import os
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


class NativeSetupStatus(unittest.TestCase):
    MESSAGE = "openEMS::SetupFDTD: rejected unsupported native setup\nRun: Setup failed, error code: 2\n"

    def simulation(self, code):
        sim = Simulation.__new__(Simulation)
        sim.mesh = SimpleNamespace(GetLines=lambda axis: [0., 1.])
        sim.fdtd = SimpleNamespace(Run=mock.Mock(return_value=code))
        sim.ports = []
        sim.excitation = {"type": "gaussian"}
        sim.end_criteria_db, sim.max_timesteps = -60., 60000
        sim.dispersions = {}
        sim.run_stats = {"converged": True, "timesteps": 1200}
        return sim

    def run_logged(self, sim, text=None, **kwargs):
        with tempfile.TemporaryDirectory() as root, \
                mock.patch("fairbeam.simulation._capture_output", return_value=nullcontext([(self.MESSAGE if text is None else text).encode()])), \
                mock.patch("fairbeam.resources.free_memory_bytes", return_value=2**30), \
                mock.patch("fairbeam.simulation._cpu_name", return_value="test CPU"):
            return sim.run(root, threads=1, echo=False, **kwargs)

    def test_failed_setup_clears_success_and_prevents_postprocessing(self):
        sim = self.simulation(2)
        cwd = os.getcwd()
        with self.assertRaisesRegex(RuntimeError, "setup failed.*code 2") as caught:
            self.run_logged(sim)
        self.assertIn("rejected unsupported native setup", str(caught.exception))
        self.assertEqual(sim.run_stats, {})
        self.assertIsNone(sim.sim_path)
        self.assertEqual(os.getcwd(), cwd)
        with self.assertRaisesRegex(RuntimeError, r"run\(\) first"):
            sim.evaluate()
        sim.fdtd.Run.assert_called_once()

    def test_nonzero_codes_fail_in_field_and_setup_only_modes(self):
        for code in (1, 2, 3):
            for setup_only in (False, True):
                with self.subTest(code=code, setup_only=setup_only):
                    with self.assertRaisesRegex(RuntimeError, f"code {code}"):
                        self.run_logged(self.simulation(code), setup_only=setup_only)

    def test_normal_run_none_keeps_native_convergence(self):
        sim = self.simulation(None)
        stats = self.run_logged(sim, "Time for 1200 iterations with 1000.00 cells : 0.10 sec\n")
        self.assertTrue(stats["converged"])
        self.assertEqual(stats["timesteps"], 1200)

    def test_zero_setup_only_status_remains_allowed(self):
        sim = self.simulation(0)
        self.run_logged(sim, "Create FDTD operator\n", setup_only=True)
        self.assertTrue(sim.fdtd.Run.call_args.kwargs["setup_only"])

    def test_exact_criterion_retry_checks_the_second_status(self):
        sim = self.simulation(None)
        sim.fdtd.Run.side_effect = [RuntimeError("unknown option --exact-endcriteria"), 2]
        with self.assertRaisesRegex(RuntimeError, "setup failed.*code 2"):
            self.run_logged(sim)
        self.assertEqual(sim.fdtd.Run.call_count, 2)
        self.assertNotIn("exact_endcriteria", sim.fdtd.Run.call_args.kwargs)
        self.assertIsNone(sim.sim_path)

    def test_unrelated_native_exception_is_not_retried_or_replaced(self):
        sim = self.simulation(None)
        sim.fdtd.Run.side_effect = RuntimeError("invalid native dimension")
        with self.assertRaisesRegex(RuntimeError, "^invalid native dimension$"):
            self.run_logged(sim)
        sim.fdtd.Run.assert_called_once()

    def test_error_log_context_is_bounded(self):
        with self.assertRaises(RuntimeError) as caught:
            self.run_logged(self.simulation(2), "x"*5000+"\n"+self.MESSAGE)
        self.assertLess(len(str(caught.exception)), 2100)
        self.assertIn("rejected unsupported native setup", str(caught.exception))

    def test_user_abort_still_takes_precedence(self):
        text = self.MESSAGE + "openEMS::CheckAbortCond(): Received SIGINT, aborting simulation gracefully...\n"
        with self.assertRaises(KeyboardInterrupt):
            self.run_logged(self.simulation(2), text)


if __name__ == "__main__":
    unittest.main()
