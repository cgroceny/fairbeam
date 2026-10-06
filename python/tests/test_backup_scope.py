"""Authoritative design storage identity and optional mutation guards; no solver runs."""
import http.client
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
from fairbeam import modelfiles
from fairbeam.jobs import JobManager
from fairbeam.server import App, ApiError, backup_scope_for, make_server

class BackupScope(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.apps = []
        for label in ("a", "b"):
            root = self.root / label
            models = root / "models"
            models.mkdir(parents=True)
            manager = JobManager(root / "jobs", root / "projects", autostart=False)
            with mock.patch("fairbeam.server.detect_engines", return_value=["cpu"]), \
                 mock.patch("fairbeam.server._versions", return_value={}):
                app = App(models_dir=models, projects_dir=root / "projects", jobs_dir=root / "jobs", manager=manager)
            app._validate_design = mock.Mock(return_value={"valid": True, "checks": []})
            app.create_design({"id": "same", "name": "Original", "template": "empty"})
            self.apps.append(app)
    def tearDown(self):
        for app in self.apps: app.close()
        self.tmp.cleanup()
    def test_same_id_and_content_distinct_workspaces(self):
        a, b = (app.design_file("same") for app in self.apps)
        self.assertEqual(a["hash"], b["hash"])
        self.assertEqual(a["id"], b["id"])
        self.assertNotEqual(a["backup_scope"], b["backup_scope"])
        self.assertRegex(a["backup_scope"], r"^models-v1:[a-f0-9]{64}$")
        self.assertNotIn(str(self.root), a["backup_scope"])
    def test_canonical_path_alias_and_restart_stable(self):
        app = self.apps[0]
        self.assertEqual(app.backup_scope, backup_scope_for(app.models_dir / ".." / "models"))
        self.assertEqual(app.backup_scope, backup_scope_for(app.models_dir))
    @unittest.skipUnless(os.name == "nt", "native Windows case aliases")
    def test_windows_case_alias(self):
        app = self.apps[0]
        self.assertEqual(app.backup_scope, backup_scope_for(Path(str(app.models_dir).upper())))
    def test_symlink_alias(self):
        link = self.root / "models-link"
        try: link.symlink_to(self.apps[0].models_dir, target_is_directory=True)
        except OSError: self.skipTest("symlink creation unavailable")
        self.assertEqual(backup_scope_for(link), self.apps[0].backup_scope)
    def test_get_create_health_and_delete_consistent(self):
        app = self.apps[0]
        created = app.create_design({"id": "new", "name": "New", "template": "empty"})
        self.assertEqual(created["backup_scope"], app.design_file("new")["backup_scope"])
        self.assertEqual(created["backup_scope"], app.health()["backup_scope"])
        deleted = app.delete_design("new", {"backup_scope": created["backup_scope"]})
        self.assertEqual(deleted["backup_scope"], created["backup_scope"])
    def test_wrong_unknown_scope_blocks_all_mutations_before_io(self):
        app = self.apps[0]
        record = app.design_file("same")
        for scope in (self.apps[1].backup_scope, "", None, "unknown", {}):
            body = {"backup_scope": scope, "design": record["design"], "base_hash": record["hash"], "name": "Renamed"}
            for action in (app.save_design, app.rename_design, app.delete_design):
                with mock.patch.object(modelfiles, "save_design") as save, \
                     mock.patch.object(modelfiles, "delete_design") as delete, \
                     mock.patch.object(modelfiles, "read_design_file") as read:
                    with self.assertRaises(ApiError) as caught: action("same", body)
                    self.assertEqual(caught.exception.status, 409)
                    self.assertEqual(caught.exception.extra["workspace_error"], "scope_mismatch")
                    save.assert_not_called(); delete.assert_not_called(); read.assert_not_called()
        self.assertEqual(app.design_file("same")["hash"], record["hash"])
    def test_wrong_scope_also_refuses_rename_noop_or_undo(self):
        app = self.apps[0]
        record = app.design_file("same")
        for name in ("Original", "Undo name"):
            with self.assertRaises(ApiError):
                app.rename_design("same", {"name": name, "base_hash": record["hash"],
                                         "backup_scope": self.apps[1].backup_scope})
        self.assertEqual(app.design_file("same")["hash"], record["hash"])
    def test_matching_scope_and_legacy_omission_preserve_existing_guards(self):
        app = self.apps[0]
        record = app.design_file("same")
        record["design"]["model"]["description"] = "Saved"
        saved = app.save_design("same", {"design": record["design"], "base_hash": record["hash"],
                                        "backup_scope": app.backup_scope})
        self.assertEqual(saved["backup_scope"], app.backup_scope)
        renamed = app.rename_design("same", {"name": "Legacy rename", "base_hash": saved["hash"]})
        self.assertEqual(renamed["backup_scope"], app.backup_scope)
        record = app.design_file("same")
        app.save_design("same", {"design": record["design"], "base_hash": record["hash"]})
        app.delete_design("same")
        self.assertFalse((app.models_dir / "same.design.json").exists())
    def test_http_get_and_mutation_handlers_forward_scope(self):
        app = self.apps[0]
        srv = make_server(app, "127.0.0.1", 0, quiet=True)
        thread = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        def request(method, path, body=None):
            conn = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=5)
            try:
                conn.request(method, path, body=json.dumps(body) if body is not None else None,
                             headers={"Content-Type": "application/json"} if body is not None else {})
                response = conn.getresponse()
                return response.status, json.loads(response.read())
            finally: conn.close()
        try:
            status, loaded = request("GET", "/api/designs/same")
            self.assertEqual(status, 200)
            self.assertEqual(loaded["backup_scope"], app.backup_scope)
            for method, path, body in (("PUT", "/api/designs/same", {"design": loaded["design"], "base_hash": loaded["hash"]}),
                                      ("POST", "/api/designs/same/rename", {"name": "Renamed", "base_hash": loaded["hash"]}),
                                      ("POST", "/api/designs/same/delete", {})):
                status, error = request(method, path, {**body, "backup_scope": self.apps[1].backup_scope})
                self.assertEqual(status, 409, error)
                self.assertEqual(error["workspace_error"], "scope_mismatch")
            self.assertEqual(app.design_file("same")["hash"], loaded["hash"])
        finally:
            srv.shutdown(); thread.join(2); srv.server_close()

if __name__ == "__main__": unittest.main()
