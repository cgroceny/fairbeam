"""Server-owned single design admission; geometry worker is mocked, no solver runs."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from fairbeam import resources
from fairbeam.jobs import JobManager
from fairbeam.server import App, ApiError

class AdmittedPreflight(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root / "patch.design.json"
        self.design = {"model": {"id": "patch"}, "params": [{"key": "W", "default": 2}]}
        self.source.write_text(json.dumps(self.design))
        self.manager = JobManager(self.root / "jobs", self.root / "projects", autostart=False)
        self.app = object.__new__(App)
        self.app.manager = self.manager
        self.app.cpu = self.app.physical = 8
        self.app.engines = ["cpu"]
        self.app.usage = None
        self.registry = {"kind": "design", "key": "patch", "model": {"id": "patch"},
                         "path": str(self.source), "params": []}
        self.app._model = lambda body: self.registry
        self.app._design_checks = mock.Mock(side_effect=AssertionError("duplicate default build"))
        self.app.preview = SimpleNamespace(request=mock.Mock(side_effect=self.preview))
        self.free = mock.patch.object(resources, "free_memory_bytes", return_value=10 * resources.GiB)
        self.free.start()
        self.load = mock.patch.object(resources, "host_load", return_value=0)
        self.load.start()
    def tearDown(self):
        self.load.stop()
        self.free.stop()
        self.manager.shutdown()
        self.tmp.cleanup()
    def preview(self, req):
        self.assertEqual(req["op"], "preview_design")
        width = float(req["overrides"].get("W", req["design"]["params"][0]["default"]))
        # Editing the original while the geometry worker builds cannot alter admission.
        self.source.write_text("{}")
        return {"ok": True, "result": {"checks": [], "bundle": {"mesh": {"total_cells": int(width * 100_000)}}}}
    def test_saved_edit_ignores_fake_client_count_and_hash(self):
        self.design["params"][0]["default"] = 30
        self.source.write_text(json.dumps(self.design))
        result = self.app.submit({"cells": 1, "input_sha256": "fake", "threads": "auto"})
        self.assertEqual(result["preflight"]["cells"], 3_000_000)
        self.assertEqual(result["threads"], 7)
        self.assertEqual(result["params"], {"W": 30.0})
        self.assertEqual(result["preflight"]["input_sha256"], result["input_snapshot"]["sha256"])
        self.assertEqual(result["preflight"]["source"], "admitted-design-preview")
        self.app.preview.request.assert_called_once()
        self.app._design_checks.assert_not_called()
    def test_override_changes_mesh_and_auto_threads(self):
        small = self.app.submit({"cells": 100_000_000})
        self.assertEqual(small["threads"], 4)
        self.assertEqual(small["preflight"]["cells"], 200_000)
        self.source.write_text(json.dumps(self.design))
        large = self.app.submit({"params": {"W": 30}, "cells": 1})
        self.assertEqual(large["threads"], 7)
        self.assertEqual(large["preflight"]["cells"], 3_000_000)
        self.assertEqual(large["preflight"]["overrides"], {"W": "30"})
    def test_exact_estimate_refuses_before_queue(self):
        with mock.patch.object(resources, "free_memory_bytes", return_value=100_000_000):
            with self.assertRaises(ApiError) as caught:
                self.app.submit({"params": {"W": 30}, "cells": 1})
        self.assertEqual(caught.exception.status, 422)
        self.assertEqual(self.manager.list(), [])
    def test_worker_timeout_and_failed_build_do_not_fallback(self):
        for response in (ApiError(504, "geometry build timed out"),
                         {"ok": False, "kind": "validation", "error": "invalid geometry"}):
            self.source.write_text(json.dumps(self.design))
            with mock.patch.object(self.app.preview, "request", side_effect=response if isinstance(response, Exception) else None,
                                   return_value=response):
                with self.assertRaises(ApiError): self.app.submit({"cells": 1})
        self.assertEqual(self.manager.list(), [])
    def test_invalid_or_missing_mesh_never_uses_client_count(self):
        for cells in (None, False, 0, -1, "123", 1.5):
            with mock.patch.object(self.app.preview, "request", return_value={"ok": True, "result": {
                    "checks": [], "bundle": {"mesh": {"total_cells": cells}}}}):
                with self.assertRaises(ApiError) as caught: self.app.submit({"cells": 1})
                self.assertEqual(caught.exception.status, 422)
        self.assertEqual(self.manager.list(), [])
    def test_check_errors_preserve_fields_and_refusal(self):
        checks = [{"severity": "error", "path": "geometry", "code": "build", "message": "invalid shape"}]
        with mock.patch.object(self.app.preview, "request", return_value={"ok": True, "result": {
                "checks": checks, "bundle": {"mesh": {"total_cells": 100}}}}):
            with self.assertRaises(ApiError) as caught: self.app.submit({})
        self.assertEqual(caught.exception.status, 422)
        self.assertIn("fix the design before running it", str(caught.exception))
        self.assertEqual(caught.exception.extra["fields"], {"geometry": "invalid shape"})
        self.assertEqual(caught.exception.extra["checks"], checks)
        self.assertEqual(self.manager.list(), [])
    def test_real_geometry_preview_supplies_count_without_solver(self):
        from fairbeam.design import template_design
        from fairbeam.preview import handle
        design = template_design("dipole", "patch", "Geometry admission test")
        self.source.write_text(json.dumps(design))
        self.app.preview.request = mock.Mock(side_effect=handle)
        with mock.patch("fairbeam.simulation.Simulation.run", side_effect=AssertionError("must not solve")):
            result = self.app.submit({"cells": 1, "threads": 1})
        self.assertGreater(result["preflight"]["cells"], 1)
        self.assertEqual(result["preflight"]["input_sha256"], result["input_snapshot"]["sha256"])
        self.app.preview.request.assert_called_once()
    def test_python_admission_preserves_existing_client_advisory(self):
        self.registry.update(kind="python", params=[])
        result = self.app.submit({"cells": 100, "threads": 2})
        self.assertEqual(result["threads"], 2)
        self.assertNotIn("source", result["preflight"])
        self.app.preview.request.assert_not_called()

if __name__ == "__main__": unittest.main()
