"""Surface-current monitors of design files (monitors.currents): build, Python export, checks and
the `fairbeam run` hook that records them without a --fields flag."""

import argparse
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.cli import _field_request  # noqa: E402
from fairbeam.design import DesignError, blank_design, check_design, module_for, to_python  # noqa: E402
from fairbeam.design_checks import lint  # noqa: E402
from fairbeam.model import resolve_params  # noqa: E402


def build(d):
    m = module_for(d)
    return m.build(resolve_params(m.PARAMS, {}))


class Monitors(unittest.TestCase):
    def test_build_sets_current_freqs(self):
        d = blank_design("t", "T")
        self.assertIsNone(build(d).current_freqs)  # no monitors: nothing recorded
        d["monitors"] = {"currents": ["f0", 2.0]}
        self.assertEqual(build(d).current_freqs, [2.45e9, 2.0e9])
        d["monitors"] = {"currents": []}
        self.assertIsNone(build(d).current_freqs)

    def test_python_export_keeps_them(self):
        d = blank_design("t", "T")
        d["monitors"] = {"currents": ["f0"]}
        src = to_python(d)
        self.assertIn("sim.current_freqs = [", src)
        ns: dict = {}
        exec(compile(src, "export.py", "exec"), ns)  # noqa: S102 - our own generated source
        sim = ns["build"](resolve_params(ns["PARAMS"], {}))
        self.assertEqual(sim.current_freqs, [2.45e9])

    def test_structure_and_band_checks(self):
        d = blank_design("t", "T")
        d["monitors"] = "f0"
        with self.assertRaises(DesignError) as e:
            check_design(d)
        self.assertEqual(e.exception.where, "monitors")
        d["monitors"] = {"currents": "f0"}
        with self.assertRaises(DesignError) as e:
            check_design(d)
        self.assertEqual(e.exception.where, "monitors.currents")
        d["monitors"] = {"currents": ["f0", "f0 * 3"]}
        bad = [c for c in lint(d) if c["severity"] == "error"]
        self.assertEqual([(c["path"], c["code"]) for c in bad], [("monitors.currents[1]", "monitor-band")])

    def test_run_honours_the_model_monitors(self):
        own = types.SimpleNamespace(current_freqs=[2.4e9], f_min=1e9, f_max=3e9)
        plain = types.SimpleNamespace(f_min=1e9, f_max=3e9)
        no_flag = argparse.Namespace(fields=None, pattern=None)
        self.assertEqual(_field_request(no_flag, own), ([2.4e9], [2.4e9]))
        self.assertEqual(_field_request(no_flag, plain), (None, None))
        # --fields wins: its own frequencies, stored at the far-field frequencies (None)
        flag = argparse.Namespace(fields="2.0,2.5", pattern=None)
        self.assertEqual(_field_request(flag, own), ([2.0e9, 2.5e9], None))


if __name__ == "__main__":
    unittest.main()
