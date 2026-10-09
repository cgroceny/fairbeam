"""Mesh convergence studies (fairbeam.convergence) with the simulation mocked: the design at another
density, the densities and tolerances, the stopping rule, the CLI study and the run server's chain."""

import contextlib
import io
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from fairbeam import convergence as cv  # noqa: E402
from fairbeam.design import template_design  # noqa: E402
from fairbeam.jobs import JobManager  # noqa: E402


def fake_bundle(f_res, s11_db=-25.0, dmax=6.5, cells=1000, farfield=True):
    """A one-port result with a resonance at f_res of depth s11_db (Zin real there)."""
    f = np.linspace(1e9, 3e9, 801)
    rho = 10 ** (s11_db / 20)
    r = 50 * (1 + rho) / (1 - rho)
    zin = r + 1j * 300 * (f / f_res - f_res / f)
    s11 = (zin - 50) / (zin + 50)
    db = 20 * np.log10(np.abs(s11))
    k = int(np.argmin(db))
    return {
        "ports": [{"number": 1, "excite": True}],
        "mesh": {"total_cells": cells, "min_cell": 0.1, "max_cell": 5.0},
        "run": {"timesteps": 5000, "wall_time_s": 4.0, "converged": True},
        "results": {
            "frequency": f.tolist(),
            "ports": {"1": {"s11_re": s11.real.tolist(), "s11_im": s11.imag.tolist(),
                            "zin_re": zin.real.tolist(), "zin_im": zin.imag.tolist(), "z_ref": 50.0}},
            "bands": [{"f_lo": f_res * 0.99, "f_hi": f_res * 1.01, "f_center": float(f[k]), "s11_min_db": float(db[k]),
                       "fractional_bw": 0.02, "edge_lo": False, "edge_hi": False}] if s11_db < -10 else [],
            "farfield": [{"f": f_res, "dmax_dbi": dmax, "rad_efficiency": 0.9}] if farfield else [],
        },
    }


def m(f=2.4e9, s11=-20.0, dmax=6.0, z=(50.0, 0.0), no_resonance=False):
    return {"f_res": f, "s11_db": s11, "dmax_dbi": dmax, "zin_re": z[0], "zin_im": z[1],
            "no_resonance": no_resonance, "solver_converged": True}


class DensityTest(unittest.TestCase):
    def design(self):
        return template_design("patch", "patch-cv", "Patch")

    def test_auto_mode_sets_cells_per_wavelength(self):
        d = self.design()
        out = cv.with_density(d, 30)
        self.assertEqual(out["mesh"]["cells_per_wavelength"], 30)
        self.assertEqual(d["mesh"]["cells_per_wavelength"], 20, "the original design is unchanged")
        self.assertEqual(cv.with_density(d, 17.5)["mesh"]["cells_per_wavelength"], 17.5)

    def test_design_mode_sets_the_override(self):
        d = self.design()
        d["mesh"] = {"mode": "design", "overrides": {"max_ratio": 1.3}}
        out = cv.with_density(d, 40)
        self.assertEqual(out["mesh"]["overrides"], {"max_ratio": 1.3, "cells_per_wavelength": 40})
        self.assertNotIn("cells_per_wavelength", out["mesh"])

    def test_air_density_scales_with_the_feature_density(self):
        d = self.design()
        d["mesh"]["air_cells_per_wavelength"] = 10
        self.assertEqual(cv.with_density(d, 40)["mesh"]["air_cells_per_wavelength"], 20)
        d["mesh"]["air_cells_per_wavelength"] = "f0 * 2"  # an expression: dropped, air follows the density
        self.assertNotIn("air_cells_per_wavelength", cv.with_density(d, 40)["mesh"])

    def test_manual_mesh_is_refused(self):
        d = self.design()
        d["mesh"] = {"mode": "manual", "lines": {"x": [0, 1], "y": [0, 1], "z": [0, 1]}}
        self.assertIn("manual mesh lines", cv.unsupported(d))
        with self.assertRaises(ValueError):
            cv.with_density(d, 20)

    def test_module_at_density_builds_the_design_at_that_density(self):
        from fairbeam.design import module_for

        mod = cv.module_at_density(module_for(self.design()), 25)
        self.assertEqual(mod.DESIGN["mesh"]["cells_per_wavelength"], 25)
        with self.assertRaises(ValueError):
            cv.module_at_density(object(), 25)  # a Python model has no DESIGN


class DensitiesTest(unittest.TestCase):
    def test_parse_and_order(self):
        self.assertEqual(cv.check_densities("15, 20,30,40"), [15.0, 20.0, 30.0, 40.0])
        self.assertEqual(cv.check_densities([10, 12.5]), [10.0, 12.5])
        for bad in ("20,15", "15,15,20", "15", "", "a,b", [15, 1000], [2, 10]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                cv.check_densities(bad)
        with self.assertRaises(ValueError):
            cv.check_densities(list(range(10, 10 + cv.MAX_DENSITIES + 1)))

    def test_plan_caps_runs_and_density(self):
        self.assertEqual(cv.plan([15, 20, 30, 40]), [15, 20, 30, 40])
        self.assertEqual(cv.plan([15, 20, 30, 40], max_runs=3), [15, 20, 30])
        self.assertEqual(cv.plan([15, 20, 30, 40, 60], max_density=40), [15, 20, 30, 40])
        with self.assertRaises(ValueError):
            cv.plan([15, 20, 30], max_runs=1)
        with self.assertRaises(ValueError):
            cv.plan([15, 20, 30], max_density=18)  # one density left

    def test_tolerances(self):
        self.assertEqual(cv.check_tolerances(None), {"f_pct": 0.5, "s11_db": 1.0, "dmax_db": 0.2})
        self.assertEqual(cv.check_tolerances({"f_pct": 1, "s11_db": None})["f_pct"], 1.0)
        for bad in ({"f_pct": 0}, {"f_pct": -1}, {"nope": 1}, {"s11_db": "x"}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                cv.check_tolerances(bad)


class StoppingRuleTest(unittest.TestCase):
    tol = dict(cv.DEFAULT_TOL)

    def test_all_below_converges(self):
        st = cv.compare(m(2.40e9, -20.0, 6.0), m(2.405e9, -20.5, 6.1), self.tol)
        self.assertAlmostEqual(st["df_pct"], 0.2083, places=3)
        self.assertEqual(st["ok"], {"f": True, "s11": True, "dmax": True})
        self.assertTrue(st["converged"])

    def test_tolerance_edges_are_strict(self):
        # exactly at the tolerance is not below it
        self.assertFalse(cv.compare(m(2.0e9), m(2.01e9), self.tol)["ok"]["f"])  # 0.5 %
        self.assertTrue(cv.compare(m(2.0e9), m(2.0099e9), self.tol)["ok"]["f"])
        self.assertFalse(cv.compare(m(s11=-20.0), m(s11=-21.0), self.tol)["ok"]["s11"])
        self.assertTrue(cv.compare(m(s11=-20.0), m(s11=-20.99), self.tol)["ok"]["s11"])
        self.assertFalse(cv.compare(m(dmax=6.0), m(dmax=6.25), self.tol)["converged"])
        self.assertTrue(cv.compare(m(dmax=6.0), m(dmax=5.85), self.tol)["converged"])
        # negative changes count by their size
        self.assertFalse(cv.compare(m(2.0e9), m(1.98e9), self.tol)["ok"]["f"])

    def test_dmax_without_far_field_is_ignored(self):
        st = cv.compare(m(dmax=None), m(dmax=None), self.tol)
        self.assertIsNone(st["ok"]["dmax"])
        self.assertTrue(st["converged"])
        self.assertIsNone(cv.compare(m(dmax=6.0), m(dmax=None), self.tol)["ddmax_db"])

    def test_missing_resonance_never_converges(self):
        st = cv.compare({"f_res": None}, m(), self.tol)
        self.assertFalse(st["converged"])
        self.assertIsNone(st["df_pct"])

    def test_a_band_edge_minimum_is_not_comparable(self):
        # two runs with no resonance in the band: the "resonance" is the band edge (the same value, a
        # tiny change), which every tolerance would call converged. It is not comparable instead.
        edge = dict(f=1.0e9, s11=-3.0, no_resonance=True)
        st = cv.compare(m(**edge), m(**edge), self.tol)
        self.assertEqual(st["ok"], {"f": True, "s11": True, "dmax": True}, "the numbers alone would pass")
        self.assertFalse(st["comparable"])
        self.assertFalse(st["converged"])
        # one run with a real resonance and one without: still not comparable
        self.assertFalse(cv.compare(m(), m(**edge), self.tol)["comparable"])
        self.assertFalse(cv.compare(m(**edge), m(), self.tol)["converged"])
        self.assertTrue(cv.compare(m(), m(), self.tol)["comparable"])

    def test_a_study_without_a_resonance_never_converges(self):
        planned = [15, 20, 30]
        edge = dict(f=1.0e9, s11=-3.0, no_resonance=True)
        ev = cv.evaluate(self.members((15, m(**edge)), (20, m(**edge)), (30, m(**edge))), planned)
        self.assertEqual((ev["done"], ev["reason"], ev["converged"], ev["converged_at"]), (True, "exhausted", False, None))
        self.assertEqual(ev["verdict"], cv.NOT_COMPARABLE)
        self.assertIn("no resonance in the band", ev["verdict"])
        self.assertFalse(any(st["comparable"] for st in ev["steps"]))
        # a study that did find a resonance in some steps keeps the ordinary verdict
        ev = cv.evaluate(self.members((15, m(2.30e9)), (20, m(2.36e9)), (30, m(**edge))), planned)
        self.assertEqual(ev["verdict"], cv.NOT_CONVERGED)
        self.assertIn("n/a", cv.format_table({"members": self.members((15, m(**edge)), (20, m(**edge))), "convergence": cv.evaluate(
            self.members((15, m(**edge)), (20, m(**edge))), [15, 20])}))

    def test_impedance_change_is_reported(self):
        st = cv.compare(m(z=(50, 0)), m(z=(53, 4)), self.tol)
        self.assertAlmostEqual(st["dzin_ohm"], 5.0)

    def members(self, *specs):
        return [{"density": d, "status": "done", "metrics": x} for d, x in specs]

    def test_stops_at_the_first_converged_step(self):
        planned = [15, 20, 30, 40]
        ms = self.members((15, m(2.30e9)), (20, m(2.36e9)), (30, m(2.39e9)), (40, m(2.392e9)))
        for n, (done, reason) in {1: (False, "running"), 2: (False, "running"), 3: (False, "running"),
                                  4: (True, "converged")}.items():
            with self.subTest(runs=n):
                ev = cv.evaluate(ms[:n], planned)
                self.assertEqual((ev["done"], ev["reason"]), (done, reason))
                self.assertEqual(ev["next"], None if done else planned[n])
        ev = cv.evaluate(ms, planned)
        self.assertEqual(ev["converged_at"], 30, "the coarser density of the converged step")
        self.assertEqual(ev["verdict"], "converged at 30 cells/λ")
        self.assertEqual([(s["from"], s["to"]) for s in ev["steps"]], [(15, 20), (20, 30), (30, 40)])

    def test_early_convergence_stops_before_the_budget(self):
        ev = cv.evaluate(self.members((15, m(2.40e9)), (20, m(2.401e9))), [15, 20, 30, 40])
        self.assertTrue(ev["done"])
        self.assertEqual(ev["converged_at"], 15)
        self.assertEqual(len(ev["steps"]), 1)

    def test_not_converged_when_densities_run_out(self):
        ev = cv.evaluate(self.members((15, m(2.30e9)), (20, m(2.36e9)), (30, m(2.42e9))), [15, 20, 30])
        self.assertEqual((ev["done"], ev["reason"], ev["converged"]), (True, "exhausted", False))
        self.assertEqual(ev["verdict"], "not converged: refine further or check the model")

    def test_failed_and_cancelled_runs_stop(self):
        ms = self.members((15, m(2.30e9))) + [{"density": 20, "status": "failed", "metrics": {}}]
        ev = cv.evaluate(ms, [15, 20, 30])
        self.assertEqual((ev["done"], ev["reason"]), (True, "failed"))
        self.assertIn("20 cells/λ failed", ev["verdict"])
        ms[-1]["status"] = "cancelled"
        self.assertEqual(cv.evaluate(ms, [15, 20, 30])["reason"], "cancelled")

    def test_result_shape_is_strict_json(self):
        ev = cv.evaluate(self.members((15, m()), (20, m(dmax=None))), [15, 20])
        self.assertEqual(set(ev), {"tolerances", "densities", "max_runs", "steps", "converged", "converged_at",
                                   "done", "reason", "verdict", "next"})
        self.assertEqual(set(ev["steps"][0]), {"from", "to", "df_pct", "ds11_db", "ddmax_db", "dzin_ohm", "ok",
                                           "comparable", "converged", "quality"})
        json.dumps(ev, allow_nan=False)


class MetricsTest(unittest.TestCase):
    def test_resonance_depth_impedance_and_dmax(self):
        x = cv.metrics(fake_bundle(2.4e9, s11_db=-25.0, dmax=6.5, cells=1234))
        self.assertAlmostEqual(x["f_res"] / 1e9, 2.4, delta=0.0005)  # grid step 2.5 MHz, refined
        self.assertAlmostEqual(x["s11_db"], -25.0, delta=0.6)
        self.assertAlmostEqual(x["zin_im"], 0.0, delta=2.0)
        self.assertEqual((x["dmax_dbi"], x["cells"], x["matched"]), (6.5, 1234, True))

    def test_unmatched_and_no_far_field(self):
        x = cv.metrics(fake_bundle(2.0e9, s11_db=-6.0, farfield=False))
        self.assertFalse(x["matched"])
        self.assertAlmostEqual(x["f_res"] / 1e9, 2.0, delta=0.002)
        self.assertIsNone(x["dmax_dbi"])

    def test_no_port_result(self):
        x = cv.metrics({"results": {}})
        self.assertIsNone(x["f_res"])

    def test_a_minimum_at_the_band_edge_is_flagged(self):
        # a resonance well below the band: |S11| falls monotonically to the lowest frequency
        x = cv.metrics(fake_bundle(0.5e9, s11_db=-6.0, farfield=False))
        self.assertFalse(x["matched"])
        self.assertTrue(x["no_resonance"], x)
        # above the band: the minimum is the last sample
        self.assertTrue(cv.metrics(fake_bundle(5.0e9, s11_db=-6.0, farfield=False))["no_resonance"])
        # a real resonance, matched or not, inside the band is not flagged
        self.assertFalse(cv.metrics(fake_bundle(2.4e9, s11_db=-25.0))["no_resonance"])
        self.assertFalse(cv.metrics(fake_bundle(2.0e9, s11_db=-6.0, farfield=False))["no_resonance"])


class FakeSim:
    """What run_model returns: a bundle whose resonance moves less and less as the mesh refines."""
    F = {15: 2.30e9, 20: 2.36e9, 30: 2.390e9, 40: 2.392e9}

    def __init__(self, cpw):
        self.cpw = cpw

    def to_bundle(self, model, params, name):
        return {**fake_bundle(self.F[self.cpw], cells=int(self.cpw ** 3)), "name": name, "model": model}


def fake_run_model(calls):
    def run(module, values, **kw):
        cpw = module.DESIGN["mesh"]["cells_per_wavelength"]
        calls.append(cpw)
        return FakeSim(cpw)
    return run


class CliStudyTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.design = self.root / "patch-cv.design.json"
        self.design.write_text(json.dumps(template_design("patch", "patch-cv", "Patch")), encoding="utf-8")

    def converge(self, *extra):
        from fairbeam.cli import main

        calls = []
        out = io.StringIO()
        with mock.patch("fairbeam.multiport.run_model", side_effect=fake_run_model(calls)), \
                contextlib.redirect_stdout(out):
            rc = main(["converge", str(self.design), "--out", str(self.root / "out"),
                       "--sim-root", str(self.root / "sim"), "--name", "cv", *extra])
        return rc, calls, out.getvalue(), json.loads((self.root / "out" / "studies" / "cv.json").read_text(encoding="utf-8"))

    def test_runs_coarse_to_fine_and_stops_when_converged(self):
        rc, calls, text, study = self.converge()
        self.assertEqual(rc, 0)
        self.assertEqual(calls, [15, 20, 30, 40])
        self.assertEqual(study["kind"], "mesh-convergence")
        self.assertEqual(study["axes"], [{"key": "mesh.cells_per_wavelength", "values": [15, 20, 30, 40]}])
        self.assertEqual(study["convergence"]["verdict"], "converged at 30 cells/λ")
        self.assertEqual(len(study["members"]), 4)
        for mem in study["members"]:
            self.assertTrue((self.root / "out" / mem["file"]).exists())
            self.assertEqual(set(mem["metrics"]) >= {"f_res", "s11_db", "dmax_dbi", "zin_re", "zin_im", "cells"}, True)
        self.assertIn("converged at 30 cells/λ", text)
        self.assertIn("cells/λ", text.splitlines()[0])

    def test_max_runs_caps_the_study(self):
        rc, calls, _, study = self.converge("--max-runs", "3", "--tol-f", "0.5")
        self.assertEqual(calls, [15, 20, 30])
        self.assertEqual(study["convergence"]["reason"], "exhausted")
        self.assertEqual(rc, 0)

    def test_loose_tolerance_stops_early(self):
        _, calls, _, study = self.converge("--tol-f", "5", "--densities", "15,20,30")
        self.assertEqual(calls, [15, 20])
        self.assertEqual(study["convergence"]["converged_at"], 15)

    def test_bad_densities_run_nothing(self):
        from fairbeam.cli import main

        with mock.patch("fairbeam.multiport.run_model") as run, contextlib.redirect_stderr(io.StringIO()):
            rc = main(["converge", str(self.design), "--densities", "30,20", "--out", str(self.root / "o")])
        self.assertEqual(rc, 2)
        run.assert_not_called()

    def test_run_mesh_density_flag(self):
        from fairbeam.cli import _build

        args = mock.Mock(model=str(self.design), set=None, name=None, mesh_density=32.0)
        module, sim, _, _, label = _build(args)
        self.assertEqual(module.DESIGN["mesh"]["cells_per_wavelength"], 32)
        self.assertEqual(sim.mesh_report["settings"]["cells_per_wavelength"], 32)
        self.assertTrue(label.endswith("· 32 cells/λ"))

    def test_run_label_flag_names_the_result(self):
        # the Run dialog's "Result name": the bundle's display name (the tree and the Runs table list it)
        from fairbeam.cli import _build

        args = mock.Mock(model=str(self.design), set=None, label="  Wide gap, 2 mm  ", mesh_density=None)
        args.name = "my-slug"   # Mock(name=...) names the mock itself
        _, _, _, slug, label = _build(args)
        self.assertEqual((slug, label), ("my-slug", "Wide gap, 2 mm"))
        args = mock.Mock(model=str(self.design), set=None, name=None, label=None, mesh_density=None)
        self.assertNotEqual(_build(args)[4], "")


class FakeJob:
    def __init__(self, jid, sweep, status="done", bundle=None):
        self.id, self.sweep, self.status, self.bundle, self.error = jid, sweep, status, bundle, None
        self.terminal = status != "queued"
        self.saved = 0

    def save(self):
        self.saved += 1


class FakeManager:
    def __init__(self, projects):
        self.projects_dir = projects
        self.jobs = {}
        self.lock = threading.RLock()
        self._stopping = False
        self.submitted = []

    def submit(self, **kw):
        job = FakeJob(f"j{len(self.submitted)}", kw["sweep"], status="queued")
        job.kw = kw
        self.submitted.append(job)
        self.jobs[job.id] = job
        return job


class ServerStudiesTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.projects = Path(tmp.name)
        self.manager = FakeManager(self.projects)
        self.studies = cv.ServerStudies(self.manager, self.projects)

    def start(self, planned=(15, 20, 30, 40), name=None):
        kw = {"model": "patch_cv", "model_id": "patch-cv", "model_path": "x.design.json", "params": {},
              "overrides": {}, "threads": 1, "engine": "gpu", "end_criteria_db": None, "label": None,
              "points": None, "name": name}
        return self.studies.start(study_id="cv-1", name="Patch · mesh convergence", model={"id": "patch-cv"},
                                  job_kw=kw, planned=list(planned), tol=dict(cv.DEFAULT_TOL), settings={})

    def finish(self, job, f=None, status="done"):
        job.status, job.terminal = status, True
        if f is not None:
            job.bundle = f"{job.kw['name']}.json"
            (self.projects / job.bundle).write_text(json.dumps(fake_bundle(f)), encoding="utf-8")
        self.studies.on_finished(job)

    def test_chain_queues_one_density_at_a_time_and_closes(self):
        _, first = self.start()
        self.assertEqual(first.kw["mesh_density"], 15)
        self.assertEqual(first.kw["name"], "patch-cv--mesh-15")
        self.assertEqual(first.sweep["kind"], "convergence")
        self.assertEqual(first.sweep["values"], {"mesh.cells_per_wavelength": 15})
        for i, f in enumerate([2.30e9, 2.36e9, 2.39e9]):
            self.finish(self.manager.submitted[i], f)
            self.assertEqual(len(self.manager.submitted), i + 2, "the next density is queued")
        self.assertEqual([j.kw["mesh_density"] for j in self.manager.submitted], [15, 20, 30, 40])
        self.finish(self.manager.submitted[3], 2.392e9)
        self.assertEqual(len(self.manager.submitted), 4)
        study = self.studies.get("cv-1")
        self.assertNotIn("job_kw", study)
        self.assertEqual(study["convergence"]["verdict"], "converged at 30 cells/λ")
        for j in self.manager.submitted:  # the tree folder shows the verdict
            self.assertEqual((j.sweep["total"], j.sweep["verdict"]), (4, "converged at 30 cells/λ"))
        self.finish(self.manager.submitted[3], 2.392e9)  # a repeated hook changes nothing
        self.assertEqual(len(self.studies.get("cv-1")["members"]), 4)

    def test_cancel_stops_the_chain(self):
        _, first = self.start()
        self.finish(first, status="cancelled")
        self.assertEqual(len(self.manager.submitted), 1)
        study = self.studies.get("cv-1")
        self.assertEqual(study["convergence"]["reason"], "cancelled")
        self.assertEqual(first.sweep["total"], 1)

    def test_other_jobs_are_ignored(self):
        self.studies.on_finished(FakeJob("x", {"id": "sw-1", "total": 2}))
        self.studies.on_finished(FakeJob("y", None))
        self.assertEqual(self.manager.submitted, [])

    def test_server_stopped_mid_study_reads_as_stopped(self):
        _, first = self.start()
        first.terminal = True  # interrupted without a hook call
        self.assertEqual(self.studies.get("cv-1")["convergence"]["reason"], "cancelled")


class JobCommandTest(unittest.TestCase):
    def test_mesh_density_reaches_the_run_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = JobManager(Path(tmp) / "jobs", Path(tmp) / "projects", autostart=False)
            job = manager.submit(model="patch", model_path="patch.design.json", mesh_density=30.0,
                                 sweep={"id": "cv-x", "kind": "convergence", "index": 0, "total": 2})
            cmd = manager.default_command(job)
            self.assertEqual(cmd[cmd.index("--mesh-density") + 1], "30")
            self.assertEqual(job.to_dict()["mesh_density"], 30.0)
            plain = manager.submit(model="patch", model_path="patch.design.json")
            self.assertNotIn("--mesh-density", manager.default_command(plain))


class ApiTest(unittest.TestCase):
    def setUp(self):
        from fairbeam.server import App

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "models").mkdir()
        (root / "projects").mkdir()
        self.models = root / "models"
        design = template_design("patch", "patch-cv", "Patch")
        (self.models / "patch_cv.design.json").write_text(json.dumps(design), encoding="utf-8")
        design["mesh"] = {"mode": "manual", "lines": {"x": [-60, 60], "y": [-60, 60], "z": [-30, 30]}}
        design["model"]["id"] = "patch-manual"
        (self.models / "patch_manual.design.json").write_text(json.dumps(design), encoding="utf-8")
        self.manager = JobManager(root / "jobs", root / "projects", autostart=False)
        self.app = App(models_dir=self.models, projects_dir=root / "projects", jobs_dir=root / "jobs",
                       manager=self.manager)
        self.addCleanup(self.app.close)

    def test_submit_queues_the_first_density(self):
        from fairbeam.server import ApiError

        res = self.app.submit_convergence({"model": "patch_cv", "params": {}, "threads": 1, "densities": [15, 20, 30],
                                           "tolerances": {"f_pct": 1}, "max_runs": 3})
        self.assertEqual(res["study"]["convergence"]["densities"], [15, 20, 30])
        self.assertEqual(res["study"]["convergence"]["tolerances"]["f_pct"], 1.0)
        self.assertEqual(len(res["runs"]), 1)
        self.assertEqual(res["runs"][0]["mesh_density"], 15)
        self.assertEqual(self.app.convergence(res["study"]["id"])["id"], res["study"]["id"])
        with self.assertRaises(ApiError):
            self.app.convergence("cv-nope")

    def test_refusals(self):
        from fairbeam.server import ApiError

        cases = [({"model": "patch_cv", "densities": [30, 20]}, "densities"),
                 ({"model": "patch_cv", "max_runs": 1}, "max_runs"),
                 ({"model": "patch_cv", "tolerances": {"f_pct": -1}}, "tolerances"),
                 ({"model": "patch_manual"}, "mesh")]
        for body, field in cases:
            with self.subTest(field=field), self.assertRaises(ApiError) as ctx:
                self.app.submit_convergence({"params": {}, "threads": 1, **body})
            self.assertIn(field, ctx.exception.extra.get("fields", {}))
        self.assertEqual(self.manager.list(), [])


if __name__ == "__main__":
    unittest.main()
