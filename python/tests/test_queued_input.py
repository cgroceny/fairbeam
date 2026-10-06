"""Immutable admitted design inputs; no solver is launched."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from fairbeam.jobs import Job, JobManager

class QueuedInput(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.m = JobManager(self.root / "jobs", self.root / "projects", autostart=False)
        self.source = self.root / "original.design.json"
        self.text = json.dumps({"model": {"id": "patch"}, "geometry": {"length": 32}})
        self.source.write_text(self.text)
    def tearDown(self):
        self.m.shutdown()
        self.tmp.cleanup()
    def admit(self, **kw):
        return self.m.submit(model="patch", model_id="patch", model_path=str(self.source),
                             params={"length": 32}, overrides={"length": 32}, design_input=self.text, **kw)
    def test_edit_does_not_change_run_or_optimization(self):
        for kind in ("run", "optimize"):
            j = self.admit(kind=kind)
            self.source.write_text('{"model":{"id":"other"}}')
            path = Path(self.m.default_command(j)[4])
            self.assertEqual(path.read_text(), self.text)
            self.assertEqual(j.model_path, str(self.source))
            self.assertEqual(j.model_id, "patch")
            self.assertEqual(j.overrides, {"length": "32"})
            self.assertEqual(j.input_snapshot["sha256"], hashlib.sha256(self.text.encode()).hexdigest())
    def test_tamper_and_missing_fail_before_custom_child(self):
        for missing in (False, True):
            j = self.admit()
            p = Path(self.m.input_path(j))
            if missing: p.unlink()
            else: p.write_text("{}")
            with mock.patch.object(self.m, "command_factory") as factory:
                with self.assertRaisesRegex(ValueError, "admitted design input"):
                    self.m._run(j)
                factory.assert_not_called()
    def test_persisted_paths_are_not_trusted(self):
        j = self.admit()
        j.input_snapshot["path"] = str(self.source)
        self.assertNotEqual(self.m.input_path(j), str(self.source))
        restored = Job(self.m.root, **j.to_dict())
        self.assertEqual(self.m.input_path(restored), self.m.input_path(j))
    def test_malicious_job_id_and_snapshot_filename_refused(self):
        j = self.admit()
        escaped = Job(self.m.root, **{**j.to_dict(), "id": "../../outside"})
        with self.assertRaisesRegex(ValueError, "escapes jobs root"):
            self.m.input_path(escaped)
        j.input_snapshot["source_name"] = "../original.design.json"
        with self.assertRaisesRegex(ValueError, "filename"):
            self.m.input_path(j)
    def test_symlink_snapshot_refused(self):
        j = self.admit()
        path = Path(self.m.input_path(j))
        path.unlink()
        try:
            path.symlink_to(self.source)
        except OSError:
            self.skipTest("symlink creation unavailable on this host")
        with self.assertRaisesRegex(ValueError, "snapshot path"):
            self.m.input_path(j)
    def test_invalid_admission_not_queued(self):
        for text in ("{", "[]", '{"model":{"id":"changed"}}'):
            with self.assertRaises(ValueError):
                self.m.submit(model="patch", model_id="patch", model_path=str(self.source), design_input=text)
        self.assertEqual(self.m.list(), [])
        self.assertTrue(self.m.queue.empty())
        self.assertEqual(list(self.m.root.glob("*/job.json")), [])
    def test_legacy_and_python_paths_unchanged(self):
        for path in (str(self.source), "relative/model.py"):
            j = self.m.submit(model="patch", model_path=path)
            self.assertIsNone(j.input_snapshot)
            self.assertEqual(self.m.default_command(j)[4], path)
    def test_sweep_members_share_content_not_mutable_original(self):
        jobs = [self.admit(sweep={"id":"s", "index": i}) for i in range(3)]
        self.source.unlink()
        self.assertEqual({j.input_snapshot["sha256"] for j in jobs}, {hashlib.sha256(self.text.encode()).hexdigest()})
        self.assertEqual(len({self.m.input_path(j) for j in jobs}), 3)
    def test_request_capture_uses_current_defaults_and_checked_text(self):
        from fairbeam.server import App
        app = object.__new__(App)
        design = {"model": {"id": "patch"}, "params": [{"key": "W", "default": 30}]}
        self.source.write_text(json.dumps(design))
        registry = {"kind": "design", "key": "patch", "model": {"id": "patch"},
                    "path": str(self.source), "params": [{"key": "W", "default": 20, "type": "float"}]}
        app._model = lambda body: registry
        m, resolved, overrides = app._validated({})
        self.assertEqual(resolved, {"W": 30.0})
        self.assertEqual(overrides, {})
        self.source.write_text("{}")
        app._design_checks = lambda d: [] if d == design else self.fail("checked changed source")
        app._refuse_broken_design(m)
        self.assertEqual(json.loads(m["_queued_design"]), design)
        self.assertNotIn("_queued_design", registry)
    def test_http_run_sweep_optimization_forward_checked_input(self):
        from fairbeam.server import App
        app = object.__new__(App)
        app.manager = self.m
        app.projects_dir = self.m.projects_dir
        app.usage = None
        design = {"model": {"id": "patch"}, "params": [{"key": "W", "default": 30}]}
        text = json.dumps(design)
        registry = {"kind": "design", "key": "patch", "model": {"id": "patch"},
                    "path": str(self.source), "params": []}
        app._model = lambda body: registry
        app._design_checks = lambda d: []
        app.preview = mock.Mock()
        app.preview.request.return_value = {"ok": True, "result": {"checks": [], "bundle": {"mesh": {"total_cells": 100}}}}
        app._settings = lambda body, errors: dict(threads=1, engine="cpu", end_criteria_db=None,
                                                  label=None, points=None, name=None)
        app.preflight = lambda body: {"level": "ok", "messages": []}
        app._refuse_by_preflight = lambda body, st: self.source.write_text("{}")
        for call, body in ((app.submit, {}),
                           (app.submit_sweep, {"sweep": [{"key": "W", "values": [20, 40]}]}),
                           (app.submit_optimization, {"vary": [{"key": "W", "min": 20, "max": 40}],
                                                      "goals": [{"kind": "f0", "target": 2.4}]})):
            self.source.write_text(text)
            before = set(self.m.jobs)
            call(body)
            added = [j for key, j in self.m.jobs.items() if key not in before]
            self.assertTrue(added)
            for j in added:
                self.assertEqual(Path(self.m.input_path(j)).read_text(), text)
                self.assertEqual(j.model_id, "patch")
    def test_convergence_refinements_reuse_admitted_text(self):
        from fairbeam.convergence import ServerStudies
        studies = ServerStudies(self.m, self.m.projects_dir)
        kw = dict(model="patch", model_id="patch", model_path=str(self.source), design_input=self.text)
        study = {"id": "cv", "name": "study", "convergence": {"densities": [1, 2]}}
        first = studies._submit(study, kw, 0)
        self.source.write_text("{}")
        second = studies._submit(study, kw, 1)
        self.assertEqual(first.input_snapshot, second.input_snapshot)
        self.assertEqual(Path(self.m.input_path(second)).read_text(), self.text)
    def test_serialization_failure_has_no_queued_record(self):
        with mock.patch.object(Job, "save", side_effect=OSError("disk full")), self.assertRaises(OSError):
            self.m.submit(model="patch", model_path=str(self.source), params={"bad": object()}, design_input=self.text)
        self.assertEqual(self.m.list(), [])
        self.assertTrue(self.m.queue.empty())
        self.assertEqual(list(self.m.root.glob("*/events.jsonl")), [])

if __name__ == "__main__": unittest.main()
