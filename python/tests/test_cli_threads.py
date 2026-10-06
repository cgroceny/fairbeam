"""CLI Auto thread selection uses the built mesh and leaves explicit counts alone."""

import contextlib
import io
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fairbeam import cli, resources  # noqa: E402
from fairbeam.progress import ProgressParser  # noqa: E402


class Mesh:
    def __init__(self, cells_per_axis):
        self.cells_per_axis = cells_per_axis

    def GetLines(self, axis):
        return range(self.cells_per_axis + 1)


class CliThreadSelection(unittest.TestCase):
    def parse_threads(self, extra=()):
        seen = []
        with mock.patch.object(cli, "cmd_run", side_effect=lambda args: seen.append(args.threads)):
            cli.main(["run", "model.py", *extra])
        self.assertEqual(len(seen), 1)
        return seen[0]

    def test_default_and_auto_flag(self):
        self.assertEqual(self.parse_threads(), "auto")
        self.assertEqual(self.parse_threads(("--threads", "auto")), "auto")

    def test_explicit_zero_and_positive_counts_are_preserved(self):
        self.assertEqual(self.parse_threads(("--threads", "0")), 0)
        self.assertEqual(self.parse_threads(("--threads", "4")), 4)

    def test_auto_uses_actual_mesh_size_and_host_limits(self):
        with mock.patch.object(resources, "available_cpus", return_value=24), \
                mock.patch.object(resources, "physical_cores", return_value=12):
            self.assertEqual(cli._resolve_run_threads("auto", SimpleNamespace(mesh=Mesh(70))), 4)
            self.assertEqual(cli._resolve_run_threads("auto", SimpleNamespace(mesh=Mesh(100))), 8)

    def test_explicit_counts_do_not_query_or_change_host_policy(self):
        sim = SimpleNamespace(mesh=Mesh(100))
        with mock.patch.object(resources, "available_cpus", side_effect=AssertionError("unexpected Auto")):
            self.assertEqual(cli._resolve_run_threads(0, sim), 0)
            self.assertEqual(cli._resolve_run_threads(2, sim), 2)

    def test_run_settings_header_keeps_engine_parseable(self):
        class StopBeforeSolver(Exception):
            pass

        sim = SimpleNamespace(mesh=Mesh(70), end_criteria_db=-60, max_timesteps=30000)
        module = SimpleNamespace(PARAMS=[])
        args = SimpleNamespace(threads="auto", end_db=None, engine="cpu", set=[], fields=None,
                               field_plane=None, pattern=None, quiet=True, excite=None, no_exact=False,
                               points=801, element_patterns=None, efficiency=None)
        output = io.StringIO()
        with mock.patch.object(resources, "available_cpus", return_value=24), \
                mock.patch.object(resources, "physical_cores", return_value=12), \
                mock.patch.object(cli, "_field_request", return_value=(None, None)), \
                mock.patch.object(cli, "_field_plane_request", return_value=None), \
                mock.patch("fairbeam.multiport.run_model", side_effect=StopBeforeSolver):
            with contextlib.redirect_stdout(output), self.assertRaises(StopBeforeSolver):
                cli._run(args, module, sim, [], "test", "Test", "unused")

        settings_line = next(line for line in output.getvalue().splitlines()
                             if line.startswith("fairbeam: end criterion "))
        self.assertIn("engine cpu (threads 4 Auto)", settings_line)
        parser = ProgressParser()
        events = parser.feed(settings_line)
        self.assertIn({"type": "info", "end_criteria_db": -60.0, "max_timesteps": 30000,
                       "engine": "cpu"}, events)


if __name__ == "__main__":
    unittest.main()
