"""Sweep / convergence bookkeeping (no FDTD runs)."""

import contextlib
import io
import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from fairbeam.study import (cartesian, convergence_report, first_resonance, format_convergence, parse_axes,
                            reactance_zeros, summarize)

PROJECTS = Path(__file__).resolve().parents[2] / "public" / "projects"
BLANK_MODEL = Path(__file__).resolve().parents[1] / "templates" / "blank.py"


def fake_bundle(f_res, dmax, bands=True):
    f = np.linspace(1e9, 3e9, 201)
    # series RLC-like impedance around f_res: X crosses zero upward at f_res
    zin = 50 + 1j * 200 * (f / f_res - f_res / f)
    s11 = (zin - 50) / (zin + 50)
    band = [{"f_lo": f_res * 0.98, "f_hi": f_res * 1.02, "f_center": f_res, "s11_min_db": -30.0,
             "fractional_bw": 0.04, "edge_lo": False, "edge_hi": False}] if bands else []
    return {
        "ports": [{"number": 1, "excite": True}],
        "mesh": {"total_cells": 1000, "min_cell": 0.1, "max_cell": 5.0},
        "run": {"timesteps": 5000, "wall_time_s": 4.0, "converged": True},
        "results": {
            "frequency": f.tolist(),
            "ports": {"1": {"s11_re": s11.real.tolist(), "s11_im": s11.imag.tolist(),
                            "zin_re": zin.real.tolist(), "zin_im": zin.imag.tolist(), "z_ref": 50.0}},
            "bands": band,
            "farfield": [{"f": f_res, "dmax_dbi": dmax, "rad_efficiency": 0.98, "gain_dbi": dmax - 0.09}],
        },
    }


class AxesTest(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_axes(["a=1,2", "b = x"]), [("a", ["1", "2"]), ("b", ["x"])])

    def test_parse_errors(self):
        for bad in (["a"], ["a="], ["a=1", "a=2"]):
            with self.assertRaises(ValueError):
                parse_axes(bad)

    def test_cartesian(self):
        pts = cartesian([("a", ["1", "2"]), ("b", ["x", "y", "z"])])
        self.assertEqual(len(pts), 6)
        self.assertEqual(pts[0], {"a": "1", "b": "x"})
        self.assertEqual(pts[-1], {"a": "2", "b": "z"})


class MetricsTest(unittest.TestCase):
    def test_first_resonance_from_band(self):
        fr = first_resonance(fake_bundle(2.0e9, 2.1))
        self.assertEqual(fr, {"f": 2.0e9, "s11_db": -30.0, "matched": True})

    def test_first_resonance_without_band(self):
        fr = first_resonance(fake_bundle(2.0e9, 2.1, bands=False))
        self.assertFalse(fr["matched"])
        self.assertAlmostEqual(fr["f"], 2.0e9, delta=1e7)

    def test_reactance_zero(self):
        z = reactance_zeros(fake_bundle(2.2e9, 2.1))
        self.assertEqual(len(z), 1)
        self.assertAlmostEqual(z[0]["f"], 2.2e9, delta=1e6)
        self.assertAlmostEqual(z[0]["r"], 50.0, places=3)

    def test_summarize(self):
        s = summarize(fake_bundle(2.0e9, 2.1))
        self.assertEqual(s["dmax_dbi"], 2.1)
        self.assertEqual(s["rad_efficiency"], 0.98)
        self.assertEqual(s["cells"], 1000)
        self.assertEqual(len(s["bands"]), 1)
        json.dumps(s, allow_nan=False)

    def test_summarize_committed_bundles(self):
        for path in PROJECTS.glob("*.json"):
            if path.name == "index.json":
                continue
            with self.subTest(bundle=path.name):
                s = summarize(json.loads(path.read_text(encoding="utf-8")))
                json.dumps(s, allow_nan=False)


class CommittedStudiesTest(unittest.TestCase):
    def test_study_files(self):
        for path in sorted((PROJECTS / "studies").glob("*.json")):
            with self.subTest(study=path.name):
                study = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(study["schema"], "fairbeam.study/1")
                self.assertIn(study["kind"], ("sweep", "convergence"))
                n_points = int(np.prod([len(a["values"]) for a in study["axes"]]))
                self.assertEqual(len(study["members"]), n_points)
                for m in study["members"]:
                    member = PROJECTS / m["file"]
                    self.assertTrue(member.exists(), m["file"])
                    self.assertEqual(set(m["params"]), {a["key"] for a in study["axes"]})
                if study["kind"] == "convergence":
                    self.assertEqual(len(study["convergence"]["steps"]), len(study["members"]) - 1)


class ConvergenceTest(unittest.TestCase):
    def test_report(self):
        sums = [summarize(fake_bundle(f, d)) for f, d in ((2.00e9, 2.40), (2.10e9, 2.20), (2.105e9, 2.15))]
        rep = convergence_report(sums)
        self.assertEqual(len(rep["steps"]), 2)
        self.assertAlmostEqual(rep["steps"][0]["df_pct"], 5.0, places=3)
        self.assertAlmostEqual(rep["steps"][0]["d_dmax_db"], -0.2, places=6)
        self.assertFalse(rep["steps"][0]["converged"])
        self.assertTrue(rep["steps"][1]["converged"])  # 0.24 %, -0.05 dB
        self.assertTrue(rep["converged"])

    def test_dmax_tolerance(self):
        sums = [summarize(fake_bundle(2.0e9, d)) for d in (2.0, 2.3)]
        self.assertFalse(convergence_report(sums)["converged"])
        self.assertTrue(convergence_report(sums, tol_d_db=0.5)["converged"])

    def test_format(self):
        members = [{"params": {"cell": c}, "summary": summarize(fake_bundle(f, 2.1))}
                   for c, f in (("1.0", 2.0e9), ("0.5", 2.001e9))]
        study = {"axes": [{"key": "cell", "values": [1.0, 0.5]}], "members": members,
                 "convergence": convergence_report([m["summary"] for m in members])}
        text = format_convergence(study)
        self.assertIn("YES", text)
        self.assertIn("2.0010", text)


class StudyJsonTest(unittest.TestCase):
    """#57: a run with an essentially zero far field (-inf dB) still writes strict JSON study files."""

    def run_cli(self, command, *extra):
        from fairbeam.cli import main

        class FakeSim:
            def to_bundle(self, model, params, name):
                b = fake_bundle(2.0e9, -math.inf)
                ff = b["results"]["farfield"][0]
                ff["rad_efficiency"] = math.nan
                ff["directivity_dbi"] = np.array([[-np.inf, 1.5], [np.nan, np.float64(2.5)]])
                return {**b, "name": name}

        with tempfile.TemporaryDirectory() as tmp,                 mock.patch("fairbeam.multiport.run_model", return_value=FakeSim()),                 contextlib.redirect_stdout(io.StringIO()):
            rc = main([command, str(BLANK_MODEL), "--param", "post_h=20,25", "--name", "inf-study",
                       "--out", tmp, "--sim-root", str(Path(tmp) / "sim"), *extra])
            self.assertEqual(rc, 0)
            files = sorted((Path(tmp) / "studies").rglob("*.json"))
            self.assertEqual(len(files), 3)  # the study summary and two members
            self.assertEqual(list(Path(tmp).rglob("*.tmp")), [])
            texts = {f.name: f.read_text(encoding="utf-8") for f in files}
        for name, text in texts.items():
            with self.subTest(file=name):
                self.assertNotIn("Infinity", text)
                self.assertNotIn("NaN", text)
                json.loads(text, parse_constant=lambda c: self.fail(f"non-standard JSON constant {c}"))
        study = json.loads(texts["inf-study.json"])
        member = json.loads(next(t for n, t in texts.items() if n != "inf-study.json"))
        return study, member

    def test_sweep_writes_strict_json(self):
        study, member = self.run_cli("sweep")
        self.assertIsNone(study["members"][0]["summary"]["dmax_dbi"])
        self.assertIsNone(study["members"][0]["summary"]["rad_efficiency"])
        self.assertEqual(member["results"]["farfield"][0]["directivity_dbi"], [[None, 1.5], [None, 2.5]])
        self.assertIsNone(member["results"]["farfield"][0]["dmax_dbi"])

    def test_converge_writes_strict_json(self):
        study, _ = self.run_cli("converge")
        self.assertEqual(len(study["convergence"]["steps"]), 1)
        self.assertIsNone(study["convergence"]["steps"][0]["d_dmax_db"])


if __name__ == "__main__":
    unittest.main()
