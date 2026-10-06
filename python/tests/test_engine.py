"""Engine / end-criterion options of Simulation.run (no openEMS run needed)."""

import unittest

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


if __name__ == "__main__":
    unittest.main()
