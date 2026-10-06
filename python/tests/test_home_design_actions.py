"""Metadata-only saved-design actions, no native construction or solver."""
import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from fairbeam.design import blank_design
from fairbeam import modelfiles
from fairbeam.server import App, ApiError, backup_scope_for

class HomeDesignActions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.models = self.root / "models"
        self.models.mkdir()
        self.app = object.__new__(App)
        self.app.models_dir = self.models
        self.app.backup_scope = backup_scope_for(self.models)
        self.app.history_dir = self.root / "history"
        self.app.design_name_lock = threading.Lock()
        self.design = blank_design("empty_design", "Empty Design")
        modelfiles.create_design(self.models, "empty_design", self.design)
    def tearDown(self): self.tmp.cleanup()
    def test_rename_reopen_and_undo_keep_identity_file_and_result_links(self):
        before = modelfiles.read_design_file(self.models, "empty_design")
        results = self.root / "projects"
        results.mkdir()
        result = results / "existing-run.json"
        result.write_text(json.dumps({"model":{"id":before["design"]["model"]["id"]},"name":"Existing run"}))
        result_bytes = result.read_bytes()
        renamed = self.app.rename_design("empty_design", {"name":"  New display name  ","base_hash":before["hash"]})
        self.assertEqual(renamed["backup_scope"], self.app.backup_scope)
        opened = modelfiles.read_design_file(self.models, "empty_design")
        expected = copy.deepcopy(before["design"]); expected["model"]["name"] = "New display name"
        self.assertEqual(opened["design"], expected)
        self.assertEqual(opened["file"], before["file"])
        self.assertEqual(result.read_bytes(), result_bytes)
        self.assertTrue(renamed["backup"])
        self.app.rename_design("empty_design", {"name":renamed["previous_name"],"base_hash":renamed["hash"]})
        self.assertEqual(modelfiles.read_design_file(self.models,"empty_design")["design"],before["design"])
    def test_invalid_duplicate_and_stale_hash_leave_file_unchanged(self):
        before = modelfiles.read_design_file(self.models,"empty_design")
        modelfiles.create_design(self.models,"other_design",blank_design("other_design","Other Name"))
        for name, kind in [("", "invalid"),("\n", "invalid"),("a"*81,"invalid"),("OTHER NAME","duplicate")]:
            with self.subTest(name=name):
                with self.assertRaises(ApiError) as caught: self.app.rename_design("empty_design",{"name":name,"base_hash":before["hash"]})
                self.assertEqual(caught.exception.extra["name_error"],kind)
                self.assertEqual(modelfiles.read_design_file(self.models,"empty_design")["hash"],before["hash"])
        with self.assertRaises(modelfiles.ModelFileError) as caught:
            self.app.rename_design("empty_design",{"name":"Changed","base_hash":"stale"})
        self.assertEqual(caught.exception.status,409)
        self.assertEqual(modelfiles.read_design_file(self.models,"empty_design")["hash"],before["hash"])
    def test_imported_model_identity_is_not_normalized_on_rename(self):
        path = self.models / "empty_design.design.json"
        design = json.loads(path.read_text(encoding="utf-8"))
        design["model"]["id"] = "original_result_model"
        path.write_text(json.dumps(design), encoding="utf-8")
        before = modelfiles.read_design_file(self.models, "empty_design")
        self.app.rename_design("empty_design", {"name":"Renamed import", "base_hash":before["hash"]})
        opened = modelfiles.read_design_file(self.models, "empty_design")
        self.assertEqual(opened["design"]["model"]["id"], "original_result_model")
    def test_location_requires_existing_design_in_models(self):
        expected=modelfiles.design_path(self.models,"empty_design")
        self.assertEqual(Path(self.app.design_location("empty_design")["path"]),expected)
        for bad in ["../secret","missing_design"]:
            with self.assertRaises((ApiError,modelfiles.ModelFileError)): self.app.design_location(bad)
