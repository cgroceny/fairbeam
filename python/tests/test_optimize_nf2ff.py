"""Optimizer NF2FF recording choices, without running an RF solver."""

import contextlib
import io
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest import mock

from fairbeam.model import Param
from fairbeam.optimize import parse_goal, parse_vary, run_optimization


class FakeModel:
    MODEL = {"id": "nf2ff-test", "name": "NF2FF test"}
    PARAMS = [Param("x", 0.5, "x", minimum=0, maximum=1)]

    @staticmethod
    def build(_values):
        return SimpleNamespace(ports=[{"number": 1}], f_min=2e9, f_max=3e9)


class FakeSimulation:
    def __init__(self, can_remove=True, efficiency_points=None):
        self.nf2ff = object()
        self.efficiency_points = efficiency_points
        self.can_remove = can_remove
        self.remove_calls = 0

    def remove_nf2ff_box(self):
        self.remove_calls += 1
        if not self.can_remove:
            return False
        self.nf2ff = None
        return True

    def to_bundle(self, *_args, **_kwargs):
        return {}


class OptimizerNF2FFChoices(unittest.TestCase):
    def run_case(self, goal="s11_max=-20@2.5", *, farfield=None, efficiency=None, can_remove=True):
        seen = []
        messages = []

        def fake_run(_module, _values, *, before_run, **_kwargs):
            sim = FakeSimulation(can_remove, efficiency)
            before_run(sim)
            seen.append((sim.nf2ff is not None, sim.remove_calls))
            return sim

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch("fairbeam.model.load_model", return_value=FakeModel), \
                    mock.patch("fairbeam.multiport.run_model", fake_run), \
                    mock.patch("fairbeam.optimize.bundle_metrics", return_value={
                        "f0_ghz": 2.5, "s11_at": {"2.5": -20}, "bw_mhz": 1,
                        "dmax_at": {"2.5": 1},
                    }):
                with contextlib.redirect_stdout(io.StringIO()):
                    result = run_optimization(
                        "fake_model.py", [parse_vary("x=0:1:0.5:1")], [parse_goal(goal)],
                        out=root / "out", sim_root=root / "sim", max_evals=1,
                        keep_sim=True, farfield=farfield, log=messages.append,
                    )
        self.assertEqual(len(result["evaluations"]), 1)
        self.assertEqual(len(seen), 1)
        return seen[0], messages

    def test_s11_only_removes_unused_recordings(self):
        self.assertEqual(self.run_case()[0], (False, 1))

    def test_requested_farfield_is_preserved(self):
        self.assertEqual(self.run_case(farfield=True)[0], (True, 0))

    def test_farfield_goal_wins_over_disabled_extra_output(self):
        self.assertEqual(self.run_case("dmax_min=1@2.5", farfield=False)[0], (True, 0))

    def test_model_efficiency_monitor_is_preserved(self):
        self.assertEqual(self.run_case(efficiency=21)[0], (True, 0))

    def test_legacy_binding_falls_back_to_reference_only_behavior(self):
        seen, messages = self.run_case(can_remove=False)
        self.assertEqual(seen, (False, 1))
        notes = [message for message in messages if "cannot remove unused NF2FF recordings" in message]
        self.assertEqual(len(notes), 1)


if __name__ == "__main__":
    unittest.main()
