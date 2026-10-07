"""Progress parser and ETA estimate, checked against real openEMS output.

fixtures/dipole_run_timed.log: complete output of ``fairbeam run python/models/dipole.py --threads 2``
(recorded 2026-09-24, openEMS v0.37.0-rc3), one line per line as "<seconds since start>\\t<line>".
fixtures/sierpinski_log_tail.log: the openEMS log tail stored in the committed
sierpinski-monopole--iterations-3.json bundle (three energy samples).
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.progress import ProgressParser, estimate_eta, parse_clock  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures"


def dipole_lines():
    return [raw.partition("\t")[2] for raw in (FIX / "dipole_run_timed.log").read_text(encoding="utf-8").splitlines()]


def feed_all(lines, **kw):
    p = ProgressParser(**kw)
    events = []
    for line in lines:
        events += p.feed(line)
    return p, events


class ExcitationPulse(unittest.TestCase):
    """The live view says when the flat energy line is only the excitation still running."""

    LINES = ["fairbeam: Reported patch",
             "fairbeam: end criterion -50 dB, max timesteps 60000, engine cpu (threads 4 Auto)",
             "fairbeam: excitation pulse 1.8111e-09 s",
             "FDTD simulation size: 140x117x72 --> 1.17936e+06 FDTD cells ",
             "FDTD timestep is: 3.07733e-14 s; Nyquist rate: 4736 timesteps @3.43071e+09 Hz"]

    def test_pulse_end_timestep_and_not_a_label(self):
        p, events = feed_all(self.LINES)
        info = {k: v for e in events if e["type"] == "info" for k, v in e.items()}
        self.assertEqual(info["pulse_steps"], round(1.8111e-09 / 3.07733e-14))
        self.assertEqual(info["label"], "Reported patch")   # the pulse line is not taken for the run's name

    def test_either_order(self):
        _, events = feed_all([self.LINES[0], self.LINES[1], self.LINES[3], self.LINES[4], self.LINES[2]])
        self.assertIn(round(1.8111e-09 / 3.07733e-14), [e.get("pulse_steps") for e in events if e["type"] == "info"])


class ParseClock(unittest.TestCase):
    def test_formats(self):
        self.assertEqual(parse_clock("        4s"), 4)
        self.assertEqual(parse_clock("1m04s"), 64)
        self.assertEqual(parse_clock("2h03m04s"), 7384)
        self.assertIsNone(parse_clock("   "))


class DipoleLog(unittest.TestCase):
    def setUp(self):
        self.p, self.events = feed_all(dipole_lines())

    def test_phases_in_order(self):
        phases = [e["phase"] for e in self.events if e["type"] == "phase"]
        self.assertEqual(phases, ["setup", "running", "postprocessing", "exporting"])

    def test_notes_are_not_labels(self):
        # the efficiency-over-the-band lines (Simulation._band_efficiency, multiport.run_model)
        lines = dipole_lines()
        k = next(i for i, x in enumerate(lines) if "timesteps in" in x and x.startswith("fairbeam:"))
        lines[k:k] = ["fairbeam: note: radiation efficiency at 21 frequencies in 0.23 s (post-processing)",
                      "fairbeam: note: the model records no far field; adding the NF2FF box for the efficiency"]
        p, events = feed_all(lines)
        self.assertEqual(p.info["label"], "Half-wave dipole")
        phases = [e["phase"] for e in events if e["type"] == "phase"]
        self.assertEqual(phases, ["setup", "running", "postprocessing", "exporting"])

    def test_info(self):
        info = self.p.info
        self.assertEqual(info["label"], "Half-wave dipole")
        self.assertEqual(info["threads"], 2)
        self.assertEqual(info["grid"], [40, 39, 50])
        self.assertEqual(info["cells"], 78000)
        self.assertEqual(info["max_timesteps"], 60000)
        self.assertAlmostEqual(info["dt_s"], 2.91562e-12)
        self.assertEqual(info["openems"], "v0.37.0-rc3-11-g12cd91d")

    def test_progress(self):
        prog = [e for e in self.events if e["type"] == "progress"]
        self.assertEqual(len(prog), 1)
        e = prog[0]
        self.assertEqual(e["timestep"], 7272)
        self.assertAlmostEqual(e["speed_mcs"], 141.8)
        self.assertAlmostEqual(e["s_per_ts"], 5.501e-4)
        self.assertAlmostEqual(e["energy_db"], -97.91)
        self.assertEqual(e["solver_clock_s"], 4)
        self.assertEqual(e["energy_fraction"], 1.0)
        self.assertEqual(e["eta"]["basis"], "converged")
        self.assertEqual(e["eta"]["eta_s"], 0)
        self.assertTrue(e["eta"]["estimate"])

    def test_stats_and_result(self):
        s = self.p.stats
        self.assertEqual(s["timesteps"], 7272)
        self.assertEqual(s["solver_time_s"], 4.0)
        self.assertAlmostEqual(s["speed_mcells_s"], 141.78)
        self.assertTrue(s["converged"])
        self.assertEqual(s["final_energy_db"], -97.91)
        self.assertEqual(s["bands"][0]["f_lo_ghz"], 2.058)
        self.assertEqual(s["bands"][0]["f_hi_ghz"], 2.475)
        self.assertEqual(s["bands"][0]["f_center_ghz"], 2.245)
        self.assertEqual(s["farfield"][0]["dmax_dbi"], 2.06)
        self.assertEqual(s["farfield"][0]["rad_efficiency"], 0.9984)
        result = [e for e in self.events if e["type"] == "result"]
        self.assertEqual(result[0]["bundle"], "dipole.json")
        self.assertEqual(self.p.bundle_path, "/tmp/fairbeam-fixture/out/dipole.json")

    def test_run_settings_line(self):
        p = ProgressParser()
        ev = p.feed("fairbeam: end criterion -60 dB, max timesteps 30000, engine gpu")
        self.assertEqual(ev[0], {"type": "phase", "phase": "setup"})
        self.assertEqual(ev[1], {"type": "info", "end_criteria_db": -60.0, "max_timesteps": 30000, "engine": "gpu"})
        self.assertEqual(p.end_db, -60.0)
        self.assertNotIn("label", p.info)
        prog = p.feed("[@        4s] Timestep:         1000 || Speed:  100.0 MC/s (1.000e-03 s/TS) || "
                      "Energy: ~1e-20 (-30.00dB)")[-1]
        self.assertEqual(prog["energy_fraction"], 0.5)

    def test_timestep_limit_without_warning(self):
        p = ProgressParser()
        p.feed("fairbeam: end criterion -40 dB, max timesteps 5000, engine cpu")
        p.feed("Time for 5000 iterations with 78000.00 cells : 2.00 sec")
        p.feed("fairbeam: 5000 timesteps in 2.0 s, final energy -31.2 dB, converged=True")
        self.assertTrue(p.stats["hit_timestep_limit"])
        self.assertFalse(p.stats["converged"])

    def test_energy_bound_of_a_fast_run(self):
        # a run shorter than openEMS' ~4 s report interval logs no energy line: only a bound
        p = ProgressParser()
        p.feed("fairbeam: end criterion -60 dB, max timesteps 100000, engine gpu")
        ev = p.feed("fairbeam: 9519 timesteps in 0.652795 s, final energy <= -60.0 dB, converged=True")
        self.assertEqual(ev[-1]["final_energy_bound_db"], -60.0)
        self.assertNotIn("final_energy_db", p.stats)
        self.assertTrue(p.stats["converged"])
        p = ProgressParser()
        p.feed("fairbeam: None timesteps in None s, final energy ? dB, converged=None")  # not a summary line
        p.feed("fairbeam: 10 timesteps in 1.0 s, final energy ? dB, converged=False")
        self.assertFalse(p.stats["converged"])
        self.assertNotIn("final_energy_bound_db", p.stats)

    def test_errors_and_stderr(self):
        p = ProgressParser()
        ev = p.feed("fairbeam: error: unknown parameter(s): foo")
        self.assertEqual(ev, [{"type": "error", "message": "unknown parameter(s): foo"}])
        p.feed("ValueError: boom", stream="stderr")
        self.assertEqual(p.errors[-1], "ValueError: boom")


class SierpinskiLog(unittest.TestCase):
    def test_energy_trace_and_eta(self):
        lines = (FIX / "sierpinski_log_tail.log").read_text(encoding="utf-8").splitlines()
        p, events = feed_all(lines)
        prog = [e for e in events if e["type"] == "progress"]
        self.assertEqual([e["timestep"] for e in prog], [1615, 3264, 4930])
        self.assertEqual([e["energy_db"] for e in prog], [-13.57, -34.99, -52.89])
        self.assertEqual(p.info["max_timesteps"], 60000)
        first, second, third = (e["eta"] for e in prog)
        self.assertNotIn("eta_s", first)  # one sample: no decay rate yet, only the limit bound
        self.assertAlmostEqual(first["limit_s"], (60000 - 1615) * 2.481e-3, places=1)
        self.assertEqual(second["basis"], "energy-fit")
        # the run crossed -40 dB between 3264 and 4930 timesteps (~3730 by linear interpolation of
        # the samples); the two-point fit predicts ~3650
        self.assertAlmostEqual(second["target_timestep"], 3730, delta=150)
        self.assertGreater(second["eta_s"], 0)
        self.assertLess(second["eta_s"], 3)
        self.assertEqual(third["basis"], "converged")
        self.assertTrue(all(e["eta"]["estimate"] for e in prog))


class MultiPortLog(unittest.TestCase):
    """fixtures/multiport_2port.log: synthetic 2-port run in the format of multiport.run_model
    (one full openEMS log per driven port, the summary and bands once at the end)."""

    def setUp(self):
        lines = (FIX / "multiport_2port.log").read_text(encoding="utf-8").splitlines()
        self.p, self.events = feed_all(lines)

    def test_phases_restart_per_port(self):
        phases = [e["phase"] for e in self.events if e["type"] == "phase"]
        self.assertEqual(phases, ["setup", "running", "postprocessing", "setup", "running", "postprocessing", "exporting"])
        self.assertEqual(self.p.info["label"], "Wilkinson divider")  # the 'run k/n' lines are not labels
        self.assertEqual((self.p.info["port_run"], self.p.info["port_total"], self.p.info["port"]), (2, 2, 2))

    def test_progress_carries_the_port_and_resets_the_energy_trace(self):
        prog = [e for e in self.events if e["type"] == "progress"]
        self.assertEqual([(e["port_run"], e["timestep"]) for e in prog],
                         [(1, 4000), (1, 8000), (1, 12000), (2, 4000), (2, 8000), (2, 12000)])
        self.assertEqual(len(self.p.energy), 3)  # only the last port's samples
        first_port = prog[1]["eta"]  # -20, -40 dB: 4000 more timesteps to -60 dB = 4 s
        self.assertAlmostEqual(first_port["eta_s"], 4.0, places=2)
        self.assertEqual(first_port["ports_remaining"], 1)
        # + one more port, estimated as this port's projected total (8 s so far + 4 s)
        self.assertAlmostEqual(first_port["job_eta_s"], 4.0 + (8 + 4.0), places=1)
        second_port = prog[4]["eta"]  # the finished port took 12 s; nothing remains after this one
        self.assertEqual(second_port["ports_remaining"], 0)
        self.assertAlmostEqual(second_port["job_eta_s"], second_port["eta_s"])

    def test_stats_and_result_once(self):
        s = self.p.stats
        self.assertEqual(s["timesteps"], 12000)
        self.assertTrue(s["converged"])
        self.assertEqual(s["final_energy_db"], -62.0)
        self.assertEqual(len(s["bands"]), 1)
        self.assertEqual(self.p.port_times, [12.0, 12.1])
        self.assertEqual([e["bundle"] for e in self.events if e["type"] == "result"], ["wilkinson-divider.json"])


class Eta(unittest.TestCase):
    def test_linear_decay(self):
        pts = [(1000, -10.0), (2000, -20.0), (3000, -30.0)]
        eta = estimate_eta(pts, s_per_ts=1e-3, end_db=-40, max_timesteps=60000)
        self.assertEqual(eta["remaining_timesteps"], 1000)
        self.assertAlmostEqual(eta["eta_s"], 1.0)
        self.assertEqual(eta["confidence"], "medium")
        self.assertAlmostEqual(eta["limit_s"], 57.0)

    def test_window_uses_recent_points(self):
        pts = [(1000, -1.0), (2000, -2.0), (3000, -10.0), (4000, -20.0), (5000, -30.0), (6000, -35.0)]
        eta = estimate_eta(pts, 1e-3, -40, None, window=3)
        self.assertLess(eta["remaining_timesteps"], 1000)  # slope of the last three samples only

    def test_flat_energy_falls_back_to_limit(self):
        pts = [(1000, -12.0), (2000, -12.0)]
        eta = estimate_eta(pts, 2e-3, -40, 10000)
        self.assertEqual(eta["basis"], "timestep-limit")
        self.assertEqual(eta["remaining_timesteps"], 8000)
        self.assertAlmostEqual(eta["eta_s"], 16.0)

    def test_capped_by_limit(self):
        pts = [(1000, -1.0), (2000, -2.0)]
        eta = estimate_eta(pts, 1e-3, -40, 5000)
        self.assertEqual(eta["remaining_timesteps"], 3000)
        self.assertEqual(eta["basis"], "timestep-limit")

    def test_single_point_has_no_eta(self):
        eta = estimate_eta([(1000, -10.0)], 1e-3, -40, 60000)
        self.assertNotIn("eta_s", eta)
        self.assertAlmostEqual(eta["limit_s"], 59.0)
        self.assertEqual(estimate_eta([(1000, -50.0)], 1e-3, -40)["basis"], "converged")

    def test_no_points_and_no_speed(self):
        self.assertIsNone(estimate_eta([], 1e-3))
        eta = estimate_eta([(1000, -10.0), (2000, -20.0)], None, -40)
        self.assertEqual(eta["remaining_timesteps"], 2000)
        self.assertIsNone(eta["eta_s"])


if __name__ == "__main__":
    unittest.main()
