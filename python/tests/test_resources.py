"""Auto threads, memory preflight and measured throughput (fairbeam.resources)."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fairbeam import resources  # noqa: E402
from fairbeam.resources import GiB, auto_threads, measured_throughput, preflight  # noqa: E402


class AutoThreads(unittest.TestCase):
    def test_windows_process_affinity_and_fallback(self):
        with mock.patch.object(resources.os, "sched_getaffinity", side_effect=AttributeError, create=True), \
                mock.patch.object(resources.sys, "platform", "win32"), \
                mock.patch.object(resources.os, "cpu_count", return_value=24), \
                mock.patch.object(resources, "_windows_available_cpus", return_value=2):
            self.assertEqual(resources.available_cpus(), 2)
            self.assertEqual(auto_threads(resources.available_cpus(), 12), 1)
        with mock.patch.object(resources.os, "sched_getaffinity", side_effect=OSError, create=True), \
                mock.patch.object(resources.sys, "platform", "win32"), \
                mock.patch.object(resources.os, "cpu_count", return_value=24), \
                mock.patch.object(resources, "_windows_available_cpus", return_value=None):
            self.assertEqual(resources.available_cpus(), 24)

    def test_cpu_counts(self):
        self.assertEqual(auto_threads(1, 1), 1)
        self.assertEqual(auto_threads(2, 2), 1)
        self.assertEqual(auto_threads(4, 4), 3)
        self.assertEqual(auto_threads(8, 4), 3, "hyperthreads are not counted")
        self.assertEqual(auto_threads(24, 12), 4, "small or unknown grid is capped at 4")
        self.assertEqual(auto_threads(64, 32), 4)

    def test_grid_size_raises_the_cap(self):
        self.assertEqual(auto_threads(24, 12, 100_000), 4)
        self.assertEqual(auto_threads(24, 12, 1_000_000), 8)
        self.assertEqual(auto_threads(64, 32, 10_000_000), 12)
        self.assertEqual(auto_threads(4, 4, 10_000_000), 3)

    def test_the_table_shared_with_the_run_dialog(self):
        # scripts/check-run-threads.mjs runs the same cases through src/lib/autoThreads.ts: the Run
        # dialog's "Auto uses N threads" is the number the server uses for the same grid
        table = json.loads((Path(__file__).resolve().parent / "fixtures" / "auto_threads.json").read_text("utf-8"))
        for logical, physical, cells, expected in table["cases"]:
            with self.subTest(logical=logical, physical=physical, cells=cells):
                self.assertEqual(auto_threads(logical, physical, cells), expected)

    def test_never_above_usable_cpus(self):
        self.assertEqual(auto_threads(2, 16, 10_000_000), 1)
        self.assertLessEqual(auto_threads(3, 8), 3)

    def test_affinity_and_fallbacks(self):
        with mock.patch("os.sched_getaffinity", return_value={0, 1}, create=True):
            self.assertEqual(resources.available_cpus(), 2)
        with mock.patch("os.sched_getaffinity", side_effect=OSError, create=True), mock.patch("os.cpu_count", return_value=6), \
                mock.patch.object(resources, "_windows_available_cpus", return_value=None):
            self.assertEqual(resources.available_cpus(), 6)
        with mock.patch("os.sched_getaffinity", side_effect=AttributeError, create=True), mock.patch("os.cpu_count", return_value=None), \
                mock.patch.object(resources, "_windows_available_cpus", return_value=None):
            self.assertEqual(resources.available_cpus(), 1)

    def test_physical_unknown_falls_back(self):
        with mock.patch("sys.platform", "freebsd"):
            self.assertEqual(resources.physical_cores(8), 4)
            self.assertEqual(resources.physical_cores(2), 2)
            self.assertEqual(resources.physical_cores(1), 1)


class Preflight(unittest.TestCase):
    def test_levels(self):
        cells = 10e6  # 0.84 GiB estimated
        est = cells * resources.BYTES_PER_CELL
        self.assertEqual(preflight(cells, "cpu", int(est * 10))["level"], "ok")
        self.assertEqual(preflight(cells, "cpu", int(est / 0.7))["level"], "warn")
        r = preflight(cells, "cpu", int(est))
        self.assertEqual(r["level"], "refuse")
        self.assertIn("GiB", r["messages"][0])

    def test_unknown_states_are_not_safe(self):
        self.assertEqual(preflight(None)["level"], "unknown")
        self.assertEqual(preflight(1e6, "cpu", None)["level"], "unknown")
        with mock.patch("sys.platform", "linux"):
            self.assertEqual(preflight(1e6, "gpu", 8 * GiB)["level"], "unknown", "CUDA memory is not read")
        with mock.patch("sys.platform", "darwin"):
            self.assertEqual(preflight(1e6, "gpu", 8 * GiB)["level"], "ok", "Metal: unified memory checked once")
            self.assertEqual(preflight(100e6, "gpu", 8 * GiB)["level"], "refuse")

    def test_busy_cpu_and_load_warn(self):
        r = preflight(1e5, "cpu", 16 * GiB, busy=True)
        self.assertEqual(r["level"], "warn")
        self.assertTrue(any("another run" in m for m in r["messages"]))
        self.assertEqual(preflight(1e5, "cpu", 16 * GiB, load=7.5, cpus=8)["level"], "warn")
        self.assertEqual(preflight(1e5, "cpu", 16 * GiB, load=1.0, cpus=8)["level"], "ok")


class Throughput(unittest.TestCase):
    def test_median_of_this_hosts_runs(self):
        rows = [{"engine": "CPU", "speed_mcells_s": s, "host_cpu": "X", "created": f"2026-01-0{i}"}
                for i, s in enumerate((100, 200, 300), 1)]
        rows += [{"engine": "CPU", "speed_mcells_s": 999, "host_cpu": "Other", "created": "2026-01-09"},
                 {"engine": "Metal", "speed_mcells_s": 800, "host_cpu": "X", "created": "2026-01-05"},
                 {"engine": "CPU", "created": "2026-01-06"}]
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(measured_throughput(Path(d), "X"), {})
            (Path(d) / "index.json").write_text(json.dumps({"projects": rows}))
            self.assertEqual(measured_throughput(Path(d), "X"),
                             {"cpu": {"mcells_s": 200.0, "runs": 3}, "gpu": {"mcells_s": 800.0, "runs": 1}})
            (Path(d) / "index.json").write_text("{bad")
            self.assertEqual(measured_throughput(Path(d), "X"), {})


if __name__ == "__main__":
    unittest.main()
