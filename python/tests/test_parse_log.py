"""Run statistics parsed from openEMS' log (Simulation._parse_log)."""

import unittest
from pathlib import Path

from fairbeam.excitation import dgauss_duration_s
from fairbeam.simulation import _aborted, _parse_log

FIXTURES = Path(__file__).resolve().parent / "fixtures"

HEAD = """Create FDTD operator (compressed SSE + multi-threading)
FDTD simulation size: 45x25x38 --> 42750 FDTD cells
FDTD timestep is: 3.94767e-13 s; Nyquist rate: 361 timesteps @3.50851e+09 Hz
Running FDTD engine... this may take a while... grab a cup of coffee?!?
"""

SLOW = HEAD + """[@        4s] Timestep:         4770 || Speed:   50.6 MC/s (8.448e-04 s/TS) || Energy: ~1.83e-15 (-19.65dB)
[@        8s] Timestep:         8640 || Speed:   41.3 MC/s (1.034e-03 s/TS) || Energy: ~2.68e-19 (-58.00dB)
Time for 8640 iterations with 42750.00 cells : 8.03 sec
Speed: 45.98 MCells/s
"""

# a run faster than openEMS' 4 s progress interval prints no energy line at all
FAST = HEAD + """Time for 3120 iterations with 42750.00 cells : 1.21 sec
Speed: 110.2 MCells/s
"""

# the custom (Gaussian-derivative) excitation hits the limit silently: no "Max. number" warning
LIMIT_SILENT = HEAD + """[@        4s] Timestep:        20000 || Speed:   50.6 MC/s (8.448e-04 s/TS) || Energy: ~1.83e-15 (-25.00dB)
Time for 30000 iterations with 42750.00 cells : 6.00 sec
Speed: 213.0 MCells/s
"""

# the GPU engine logs the energy every few thousand timesteps: the last line (-36.42 dB at 7680)
# predates the stop at 10800, which only the end criterion (-60 dB) can have caused
GPU_STALE = HEAD + """[@        4s] Timestep:         7680 || Speed: 2180.8 MC/s (5.211e-04 s/TS) || Energy: ~7.39e-19 (-36.42dB)
Time for 10800 iterations with 1136520.00 cells : 5.61 sec
Speed: 2186.70 MCells/s
"""

LIMIT_WARNED = LIMIT_SILENT + "RunFDTD: Warning: Max. number of timesteps was reached before the end-criteria\n"


class ParseLogTest(unittest.TestCase):
    def test_timestep(self):
        # the "Excitation signal length" line of a custom excitation is always max-timesteps long;
        # the pulse length comes from f max and this timestep instead (Simulation.run)
        self.assertEqual(_parse_log(SLOW, -40, 60000)["timestep_s"], 3.94767e-13)
        self.assertAlmostEqual(dgauss_duration_s(3e9) * 1e9, 2.071, places=3)

    def test_slow_converged_run(self):
        s = _parse_log(SLOW, -40, 60000)
        self.assertEqual(s["grid"], [45, 25, 38])
        self.assertEqual(s["timesteps"], 8640)
        self.assertEqual(s["solver_time_s"], 8.03)
        self.assertEqual(s["speed_mcells_s"], 45.98)
        self.assertEqual([e["db"] for e in s["energy_trace"]], [-19.65, -58.0])
        self.assertTrue(s["converged"])
        self.assertFalse(s["hit_timestep_limit"])
        self.assertEqual(s["final_energy_db"], -58.0)
        self.assertNotIn("final_energy_bound_db", s)

    def test_fast_run_without_energy_lines_is_converged(self):
        s = _parse_log(FAST, -40, 60000)
        self.assertTrue(s["converged"])
        self.assertFalse(s["hit_timestep_limit"])
        self.assertEqual(s["energy_trace"], [])
        self.assertNotIn("final_energy_db", s)
        self.assertEqual(s["final_energy_bound_db"], -40.0)

    def test_energy_line_before_the_stop_is_not_the_final_energy(self):
        s = _parse_log(GPU_STALE, -60, 60000)
        self.assertTrue(s["converged"])
        self.assertEqual(s["timesteps"], 10800)
        self.assertEqual(s["energy_trace"], [{"timestep": 7680, "db": -36.42}])
        self.assertNotIn("final_energy_db", s)
        self.assertEqual(s["final_energy_bound_db"], -60.0)

    def test_silent_timestep_limit_is_not_converged(self):
        s = _parse_log(LIMIT_SILENT, -40, 30000)
        self.assertFalse(s["converged"])
        self.assertTrue(s["hit_timestep_limit"])
        self.assertEqual(s["final_energy_db"], -25.0)
        self.assertNotIn("final_energy_bound_db", s)

    def test_warned_timestep_limit(self):
        s = _parse_log(LIMIT_WARNED, -40, 30000)
        self.assertFalse(s["converged"])
        self.assertTrue(s["hit_timestep_limit"])

    def test_no_timing_line(self):
        s = _parse_log(HEAD, -40, 60000)
        self.assertFalse(s["converged"])
        self.assertNotIn("timesteps", s)


# openEMS' own Ctrl+C handling: it stops early and Run returns normally (captured on Windows,
# where the run server's CTRL_BREAK triggers it; SIGINT prints the CheckAbortCond line on POSIX)
ABORTED = HEAD + """[@        4s] Timestep:         1200 || Speed:   28.1 MC/s (3.589e-03 s/TS) || Energy: ~1.23e-20 (- 0.00dB)
Signal::Win32GracefulExitHandler(): Gracefully aborting simulation now, this may take a few seconds...
Signal::Win32GracefulExitHandler(): To force-exit, send Ctrl-C again, but simulation results may be lost.
openEMS::CheckAbortCond(): Received SIGINT, aborting simulation gracefully...
Time for 5000 iterations with 100842.00 cells : 19.89 sec
Speed: 25.35 MCells/s
"""


class AbortedRunTest(unittest.TestCase):
    def test_aborted_runs_are_recognised(self):
        self.assertTrue(_aborted(ABORTED))
        self.assertTrue(_aborted(HEAD + "openEMS::CheckAbortCond(): Received SIGINT, aborting simulation gracefully...\n"))
        # would otherwise pass for converged: it stopped before the timestep limit
        self.assertTrue(_parse_log(ABORTED, -40, 60000)["converged"])

    def test_normal_runs_are_not(self):
        for text in (SLOW, FAST, LIMIT_SILENT, LIMIT_WARNED):
            self.assertFalse(_aborted(text))
        for fixture in (FIXTURES / "dipole_run_timed.log", FIXTURES / "multiport_2port.log",
                        FIXTURES / "sierpinski_log_tail.log"):
            self.assertFalse(_aborted(fixture.read_text(encoding="utf-8")), fixture.name)


if __name__ == "__main__":
    unittest.main()
