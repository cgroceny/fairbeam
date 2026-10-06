"""Opt-in network criteria: fixed-frequency interpolation, phase wrapping and both CLI paths."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import numpy as np

from fairbeam import convergence as cv
from fairbeam.multiport import sparams_section
from fairbeam.study import compare_network, convergence_report, network_metrics, parse_network_criteria, summarize
from test_convergence import fake_bundle


def bundle(coupling=20, isolation=40, phase=90):
    b = fake_bundle(2.4e9)
    f = np.asarray(b["results"]["frequency"])
    s = np.broadcast_to(np.eye(4) * 0.1, (len(f), 4, 4)).astype(complex).copy()
    s[:, 1, 0] = 0.9
    s[:, 2, 0] = 10 ** (-coupling / 20) * np.exp(1j * np.radians(phase))
    s[:, 3, 0] = 10 ** (-isolation / 20)
    b["results"]["sparams"] = sparams_section(f, s, [1, 2, 3, 4], [50] * 4, "synthetic")
    return b


def config(*items):
    return parse_network_criteria(items or ["coupling:3,1:0.2"], 2.4)


class NetworkCriteriaTest(unittest.TestCase):
    def test_default_and_invalid_options(self):
        self.assertIsNone(parse_network_criteria(None, None))
        for items, frequency in ((None, 2.4), (["coupling:3,1:0.2"], None), (["x:1,2:1"], 2),
                                 (["phase:1,1,2:1"], 2), (["isolation:0,1:1"], 2),
                                 (["s11:1:nan"], 2), (["s11:1:0"], 2), (["s11:1:1"], float("inf")),
                                 (["s11:1:1", "s11:1:1"], 2)):
            with self.subTest(items=items, frequency=frequency), self.assertRaises(ValueError):
                parse_network_criteria(items, frequency)

    def test_all_metrics_and_relative_phase(self):
        c = config("coupling:3,1:0.2", "isolation:4,1:0.2", "directivity:3,4,1:0.2",
                   "phase:3,1:1", "phase:2,3,1:1", "s11:1:1")
        p = network_metrics(bundle(), c)
        np.testing.assert_allclose([x["value"] for x in p["values"]], [20, 40, 20, 90, -90, -20], atol=0.001)
        self.assertTrue(compare_network(p, p)["converged"])
        json.dumps(p, allow_nan=False)

    def test_circular_phase_and_strict_tolerance(self):
        c = config("phase:3,1:3")
        step = compare_network(network_metrics(bundle(phase=179), c), network_metrics(bundle(phase=-179), c))
        self.assertAlmostEqual(step["checks"][0]["delta"], 2, delta=0.01)  # five-decimal bundle storage
        self.assertTrue(step["converged"])
        a = network_metrics(bundle(), config())
        b = copy.deepcopy(a)
        b["values"][0]["value"] = a["values"][0]["value"] + 1
        b["criteria"][0]["tolerance"] = 1
        a["criteria"][0]["tolerance"] = 1
        self.assertFalse(compare_network(a, b)["converged"])

    def test_missing_null_nan_and_out_of_band_never_pass(self):
        for bad in ("missing", "null", "nan", "out-of-band", "energy"):
            b = bundle()
            c = config()
            if bad == "missing":
                b["results"]["sparams"]["s"].pop("3,1")
            elif bad in ("null", "nan"):
                v = b["results"]["sparams"]["s"]["3,1"]
                v["re"] = [0 if bad == "null" else float("nan")] * len(v["re"])
                v["im"] = [0] * len(v["im"])
            elif bad == "out-of-band":
                c["frequency_hz"] = 4e9
            else:
                b["run"]["port_runs"] = [{"converged": False}]
            p = network_metrics(b, c)
            with self.subTest(bad=bad):
                self.assertFalse(compare_network(p, p)["converged"])

    def test_interpolation_and_physical_port_ids(self):
        b = bundle()
        b["results"]["frequency"] = [2e9, 3e9]
        b["results"]["sparams"]["port_numbers"] = [10, 20, 30, 40]
        b["results"]["sparams"]["s"]["3,1"] = {"re": [0.1, 0.2], "im": [0, 0]}
        p = network_metrics(b, parse_network_criteria(["coupling:30,10:0.2"], 2.5))
        self.assertAlmostEqual(p["values"][0]["value"], -20 * np.log10(0.15))

    def test_legacy_pass_cannot_hide_a_network_deviation(self):
        a, b = bundle(), bundle(coupling=21)
        sa, sb = summarize(a), summarize(b)
        self.assertTrue(convergence_report([sa, sb])["converged"])
        sa["network"], sb["network"] = network_metrics(a, config()), network_metrics(b, config())
        self.assertFalse(convergence_report([sa, sb])["converged"])
        ma, mb = cv.metrics(a, network_criteria=config()), cv.metrics(b, network_criteria=config())
        self.assertFalse(cv.compare(ma, mb, cv.DEFAULT_TOL)["converged"])
        self.assertFalse(compare_network(ma["network"], None)["converged"])


class NetworkCliTest(unittest.TestCase):
    def test_both_paths_write_criteria_and_unconverged_verdict(self):
        from fairbeam.cli import main
        from fairbeam.design import template_design
        blank = Path(__file__).resolve().parents[1] / "templates" / "blank.py"
        for parameter_study in (False, True):
            with self.subTest(parameter_study=parameter_study), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                design = root / "fixture.design.json"
                design.write_text(json.dumps(template_design("patch", "fixture", "Fixture")), encoding="utf-8")
                sim = mock.Mock()
                sim.to_bundle.side_effect = [bundle(), bundle(coupling=21)]
                text = io.StringIO()
                axis = ["--param", "post_h=20,25"] if parameter_study else ["--densities", "15,20"]
                with mock.patch("fairbeam.multiport.run_model", return_value=sim), contextlib.redirect_stdout(text):
                    rc = main(["converge", str(blank if parameter_study else design), *axis, "--name", "net",
                               "--out", str(root / "out"), "--sim-root", str(root / "sim"),
                               "--network-frequency", "2.4", "--network-metric", "coupling:3,1:0.2"])
                self.assertEqual(rc, 0)  # existing exit-code contract: a numerical verdict is not a run failure
                study = json.loads((root / "out/studies/net.json").read_text(encoding="utf-8"))
                self.assertFalse(study["convergence"]["converged"])
                self.assertEqual(study["network_criteria"]["frequency_hz"], 2.4e9)
                self.assertIn("coupling:3,1", text.getvalue())
                self.assertIn("network", study["convergence"]["steps"][0])

    def test_invalid_configuration_runs_nothing(self):
        from fairbeam.cli import main
        with mock.patch("fairbeam.multiport.run_model") as run, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(main(["converge", "missing.py", "--network-metric", "phase:2,1:1"]), 2)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
