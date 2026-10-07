"""A design file (fairbeam.design/1, e.g. Export > Current design JSON) opened in the app becomes a new design: POST
/api/designs with the design, under a free id derived from its name; the design validator refuses a broken one."""
import copy
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fairbeam import modelfiles
from fairbeam.design import blank_design, template_design
from fairbeam.jobs import JobManager
from fairbeam.server import App, ApiError


class DesignFileImport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.models = root / "models"
        self.models.mkdir()
        manager = JobManager(root / "jobs", root / "projects", autostart=False)
        with mock.patch("fairbeam.server.detect_engines", return_value=["cpu"]), \
                mock.patch("fairbeam.server._versions", return_value={}):
            self.app = App(models_dir=self.models, projects_dir=root / "projects", jobs_dir=root / "jobs", manager=manager)
        self.app._validate_design = mock.Mock(return_value={"valid": True, "checks": []})
        self.design = template_design("patch", "export-patch", "Export patch")

    def tearDown(self):
        self.app.close()
        self.tmp.cleanup()

    def test_a_design_file_becomes_a_new_design_named_after_it(self):
        out = self.app.create_design({"design": copy.deepcopy(self.design)})
        self.assertEqual(out["id"], "export_patch")
        self.assertEqual(out["file"], "export_patch.design.json")
        saved = modelfiles.read_design_file(self.models, "export_patch")["design"]
        self.assertEqual(saved["model"]["name"], "Export patch")
        self.assertEqual(saved["model"]["id"], "export-patch")
        self.assertEqual(saved["parts"], self.design["parts"])

    def test_the_same_file_twice_gets_a_free_id(self):
        self.app.create_design({"design": copy.deepcopy(self.design)})
        again = self.app.create_design({"design": copy.deepcopy(self.design)})
        self.assertEqual(again["id"], "export_patch_2")
        self.assertEqual(modelfiles.read_design_file(self.models, "export_patch_2")["design"]["model"]["id"], "export-patch-2")

    def test_never_a_bundled_example_or_a_reserved_name(self):
        named = lambda name: {**copy.deepcopy(self.design), "model": {**self.design["model"], "name": name}}
        self.assertEqual(self.app.create_design({"design": named("Patch antenna")})["id"], "patch_antenna_2")
        self.assertEqual(self.app.create_design({"design": named("CON")})["id"], "con_2")
        self.assertEqual(self.app.create_design({"design": named("Çift kutuplu ıslak")})["id"], "cift_kutuplu_islak")
        self.assertEqual(self.app.create_design({"design": named("42")})["id"], "imported_design")

    def test_a_given_name_or_id_wins(self):
        out = self.app.create_design({"design": copy.deepcopy(self.design), "name": "Colleague's patch"})
        self.assertEqual(out["id"], "colleague_s_patch")
        self.assertEqual(modelfiles.read_design_file(self.models, out["id"])["design"]["model"]["name"], "Colleague's patch")
        self.assertEqual(self.app.create_design({"design": copy.deepcopy(self.design), "id": "chosen"})["id"], "chosen")
        with self.assertRaises(modelfiles.ModelFileError) as taken:
            self.app.create_design({"design": copy.deepcopy(self.design), "id": "chosen"})
        self.assertEqual(taken.exception.status, 409)

    def test_a_broken_design_is_refused_and_nothing_is_written(self):
        broken = copy.deepcopy(self.design)
        broken["parts"][0]["material"] = "no such material"
        with self.assertRaises(modelfiles.ModelFileError) as caught:
            self.app.create_design({"design": broken})
        self.assertEqual(caught.exception.status, 422)
        with self.assertRaises(ApiError):
            self.app.create_design({"design": "not an object"})
        with self.assertRaises(ApiError):
            self.app.create_design({"design": {"schema": "fairbeam.design/1"}})
        self.assertEqual(list(self.models.glob("*.design.json")), [])

    def test_the_designer_template_ids_are_untouched(self):
        # the other kinds of create still require their id
        with self.assertRaises(modelfiles.ModelFileError):
            self.app.create_design({"template": "empty"})
        # a name too short for an id: a generic one
        self.assertEqual(self.app.create_design({"design": blank_design("x", "X")})["id"], "imported_design")


if __name__ == "__main__":
    unittest.main()
