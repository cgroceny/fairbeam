"""Model editor backend: templates, create / read / save with optimistic concurrency, version
history, read-only bundled models and error line extraction. No simulation is run; validation
loads and builds models in the preview worker (geometry only)."""

import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from unittest import mock
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from fairbeam import modelfiles  # noqa: E402
from fairbeam.jobs import JobManager  # noqa: E402
from fairbeam.preview import error_location, validate_model  # noqa: E402
from fairbeam.server import App, make_server  # noqa: E402

TEMPLATES = HERE.parent / "templates"
MODELS = HERE.parent / "models"


class Identity(unittest.TestCase):
    def test_rewrites_id_and_name_only(self):
        src = '# c\nMODEL = {\n    "id": "blank",  # keep\n    "name": "Blank model",\n    "description": "x"}\nX = "id"\n'
        out = modelfiles.set_model_identity(src, "my_post", "My post · 2")
        self.assertIn('"id": "my-post",  # keep', out)
        self.assertIn('"name": "My post · 2"', out)
        self.assertIn('"description": "x"', out)
        self.assertIn('X = "id"', out)

    def test_ids(self):
        for ok in ("ab", "patch2", "my_model_1"):
            self.assertEqual(modelfiles.check_id(ok), ok)
        for bad in ("a", "2x", "Abc", "a-b", "../x", "a" * 42, "", None, "a.b"):
            with self.assertRaises(modelfiles.ModelFileError, msg=bad):
                modelfiles.check_id(bad)
        # Windows device names cannot be file names there, with or without an extension
        for bad in ("con", "prn", "aux", "nul", "com1", "lpt9", "com0"):
            with self.assertRaises(modelfiles.ModelFileError, msg=bad):
                modelfiles.check_id(bad)
        for ok in ("console", "aux_feed", "com10", "null"):
            self.assertEqual(modelfiles.check_id(ok), ok)


class Files(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.models = Path(self.tmp.name) / "models"
        self.hist = Path(self.tmp.name) / "hist"
        self.models.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_refuses_overwrite(self):
        modelfiles.create_model(self.models, "one", 'MODEL = {"id": "t", "name": "T"}\n', "One")
        self.assertIn('"id": "one"', (self.models / "one.py").read_text(encoding="utf-8"))
        with self.assertRaises(modelfiles.ModelFileError) as cm:
            modelfiles.create_model(self.models, "one", "x = 1\n", None)
        self.assertEqual(cm.exception.status, 409)


    def test_save_conflict_backup_and_history(self):
        modelfiles.create_model(self.models, "one", "a = 1\n", None)
        h0 = modelfiles.read_model(self.models, "one")["hash"]
        res = modelfiles.save_model(self.models, self.hist, "one", "a = 2\n", h0)
        self.assertEqual((self.models / "one.py").read_text(encoding="utf-8"), "a = 2\n")
        self.assertIsNotNone(res["backup"])
        with self.assertRaises(modelfiles.ModelFileError) as cm:  # stale base hash
            modelfiles.save_model(self.models, self.hist, "one", "a = 3\n", h0)
        self.assertEqual(cm.exception.status, 409)
        self.assertEqual(cm.exception.extra["current_hash"], res["hash"])
        modelfiles.save_model(self.models, self.hist, "one", "a = 3\n", res["hash"])
        versions = modelfiles.list_versions(self.hist, "one")
        self.assertEqual(len(versions), 2)
        newest = modelfiles.read_version(self.hist, "one", versions[0]["version"])
        self.assertEqual(newest["source"], "a = 2\n")  # newest backup = the version before the last save
        with self.assertRaises(modelfiles.ModelFileError):
            modelfiles.read_version(self.hist, "one", "../../x")

    def test_files_are_lf_on_every_platform(self):
        # text mode on Windows would write CRLF; the files must be the same bytes everywhere
        modelfiles.create_model(self.models, "one", "a = 1\nb = 2\n", None)
        self.assertNotIn(b"\r", (self.models / "one.py").read_bytes())
        h = modelfiles.read_model(self.models, "one")["hash"]
        modelfiles.save_model(self.models, self.hist, "one", "a = 3\nb = 4\n", h)
        self.assertEqual((self.models / "one.py").read_bytes(), b"a = 3\nb = 4\n")

    @unittest.skipUnless(os.name == "nt", "Windows: replacing a file another process has open")
    def test_replace_retries_while_the_target_is_in_use(self):
        target = self.models / "one.py"
        target.write_text("old\n", encoding="utf-8")
        real, calls = os.replace, []

        def busy_twice(src, dst):
            calls.append(dst)
            if len(calls) <= 2:
                raise PermissionError(32, "The process cannot access the file")
            real(src, dst)

        with mock.patch.object(modelfiles.os, "replace", busy_twice):
            modelfiles._write_atomic(target, "new\n")
        self.assertEqual(len(calls), 3)
        self.assertEqual(target.read_text(encoding="utf-8"), "new\n")
        with mock.patch.object(modelfiles.os, "replace", side_effect=PermissionError(5, "Access is denied")), \
                mock.patch.object(modelfiles.time, "sleep"):
            with self.assertRaises(PermissionError):
                modelfiles._write_atomic(target, "newer\n")
        self.assertEqual(target.read_text(encoding="utf-8"), "new\n")
        self.assertEqual([p.name for p in self.models.iterdir()], ["one.py"])  # no temporary file left

    @unittest.skipUnless(os.name == "nt", "Windows: moving a file another process has open")
    def test_delete_design_retries_while_the_file_is_in_use(self):
        (self.models / "one.design.json").write_text("{}\n", encoding="utf-8")
        real, calls = modelfiles.shutil.move, []

        def busy_once(src, dst):
            calls.append(dst)
            if len(calls) == 1:
                raise PermissionError(32, "The process cannot access the file")
            return real(src, dst)

        with mock.patch.object(modelfiles.shutil, "move", busy_once):
            res = modelfiles.delete_design(self.models, self.hist, "one")
        self.assertEqual(len(calls), 2)
        self.assertFalse((self.models / "one.design.json").exists())
        self.assertTrue(Path(res["moved_to"]).exists())

    def test_bundled_models_are_readonly(self):
        (self.models / "dipole.py").write_text("x = 1\n")
        h = modelfiles.read_model(self.models, "dipole")["hash"]
        self.assertTrue(modelfiles.read_model(self.models, "dipole")["readonly"])
        with self.assertRaises(modelfiles.ModelFileError) as cm:
            modelfiles.save_model(self.models, self.hist, "dipole", "x = 2\n", h)
        self.assertEqual(cm.exception.status, 403)

    def test_bundled_example_ids_are_reserved(self):
        # Start named a design "Patch antenna": patch_antenna is the bundled example's id, so the
        # file would be read-only from the start. Refused up front, whether or not the example's
        # file is in the folder, for designs and models, Python examples and example designs.
        from fairbeam.design import template_design
        self.assertFalse((self.models / "patch_antenna.py").exists())
        for model_id in ("patch_antenna", "yagi_867"):
            with self.subTest(model_id):
                with self.assertRaises(modelfiles.ModelFileError) as cm:
                    modelfiles.create_design(self.models, model_id, template_design("patch", "x", "Patch antenna"))
                self.assertEqual((cm.exception.status, cm.exception.extra["fields"]), (409, {"id": "reserved for a bundled example"}))
                with self.assertRaises(modelfiles.ModelFileError) as cm:
                    modelfiles.create_model(self.models, model_id, "MODEL = {}\n", None)
                self.assertEqual(cm.exception.status, 409)
                self.assertEqual(list(self.models.iterdir()), [])
        # a free id with a suffix is fine, and editable
        modelfiles.create_design(self.models, "patch_antenna_2", template_design("patch", "x", "Patch antenna"))
        record = modelfiles.read_design_file(self.models, "patch_antenna_2")
        self.assertFalse(record["readonly"])
        modelfiles.save_design(self.models, self.hist, "patch_antenna_2", {**record["design"], "params": record["design"]["params"]}, record["hash"])
        # the TS mirror for Start and Save As (src/lib/designId.ts) lists the same ids
        import re
        mirror = (HERE.parents[1] / "src" / "lib" / "designId.ts").read_text(encoding="utf-8")
        listed = re.search(r"BUNDLED_EXAMPLE_IDS = \[([^\]]*)\]", mirror)
        self.assertIsNotNone(listed)
        self.assertEqual(set(re.findall(r'"([a-z0-9_]+)"', listed.group(1))), set(modelfiles.BUNDLED))

    def test_example_designs_are_readonly_and_older_user_designs_stay_editable(self):
        from fairbeam.design import template_design
        bundled = HERE.parents[1] / "examples" / "designs" / "yagi_867.design.json"
        shutil.copy(bundled, self.models / "yagi_867.design.json")
        record = modelfiles.read_design_file(self.models, "yagi_867")
        self.assertTrue(record["readonly"])
        self.assertTrue(modelfiles.is_readonly_file("yagi_867.design.json"))
        for action in (lambda: modelfiles.save_design(self.models, self.hist, "yagi_867", record["design"], record["hash"]),
                       lambda: modelfiles.delete_design(self.models, self.hist, "yagi_867")):
            with self.assertRaises(modelfiles.ModelFileError) as cm:
                action()
            self.assertEqual(cm.exception.status, 403)
        # a design saved under a bundled model's id before the ids were reserved is the user's own
        legacy = template_design("patch", "patch-antenna", "Patch antenna")
        (self.models / "patch_antenna.design.json").write_text(json.dumps(legacy), encoding="utf-8")
        record = modelfiles.read_design_file(self.models, "patch_antenna")
        self.assertFalse(record["readonly"])
        self.assertFalse(modelfiles.is_readonly_file("patch_antenna.design.json"))
        self.assertTrue(modelfiles.is_readonly_file("patch_antenna.py"))
        changed = {**record["design"], "model": {**record["design"]["model"], "name": "Patch antenna (mine)"}}
        saved = modelfiles.save_design(self.models, self.hist, "patch_antenna", changed, record["hash"])
        self.assertIsNotNone(saved["backup"])


class ErrorLines(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, text):
        p = self.dir / "m.py"
        p.write_text(text)
        return p

    def test_syntax_error_line(self):
        p = self.write("MODEL = {}\nPARAMS = [\n\ndef build(p):\n    return 1\n")
        r = validate_model(str(p))
        self.assertFalse(r["valid"])
        self.assertEqual(r["error"]["stage"], "load")
        self.assertIn("SyntaxError", r["error"]["message"])
        self.assertIn(r["error"]["location"]["line"], (2, 4))

    def test_exception_in_build_points_at_model_line(self):
        src = (TEMPLATES / "dipole.py").read_text(encoding="utf-8").replace(
            '    L, w, g = p["length"], p["width"], p["gap"]\n',
            '    L, w, g = p["length"], p["width"], p["gap"]\n    raise ValueError("boom")\n')
        p = self.write(src)
        r = validate_model(str(p))
        self.assertFalse(r["valid"])
        self.assertEqual(r["error"]["stage"], "build")
        line = src.splitlines().index('    raise ValueError("boom")') + 1
        self.assertEqual(r["error"]["location"]["line"], line)
        self.assertEqual(r["error"]["location"]["function"], "build")

    def test_location_ignores_frames_outside_the_model(self):
        try:
            json.loads("{")
        except ValueError as e:
            self.assertIsNone(error_location(e, self.dir / "m.py"))


class Templates(unittest.TestCase):
    def test_every_template_builds(self):
        for t in sorted(TEMPLATES.glob("*.py")):
            with self.subTest(template=t.name):
                r = validate_model(str(t))
                self.assertTrue(r["valid"], r.get("error"))
                self.assertTrue(r["model"]["doc"])
                b = r["bundle"]
                self.assertGreater(len(b["parts"]), 0)
                self.assertGreaterEqual(len(b["ports"]), 1)
        ms = validate_model(str(TEMPLATES / "microstrip_line.py"))["bundle"]
        self.assertEqual([p["excite"] for p in ms["ports"]], [True, False])
        mono = validate_model(str(TEMPLATES / "monopole_on_ground.py"))["bundle"]
        self.assertEqual(mono["half_space"]["kind"], "PEC")


class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.models = root / "models"
        cls.models.mkdir()
        shutil.copy(MODELS / "dipole.py", cls.models / "dipole.py")
        (root / "projects").mkdir()
        manager = JobManager(root / "jobs", root / "projects", command_factory=lambda job: [sys.executable, "-c", "pass"])
        cls.app = App(models_dir=cls.models, projects_dir=root / "projects", jobs_dir=root / "jobs",
                      templates_dir=TEMPLATES, manager=manager)
        cls.srv = make_server(cls.app, "127.0.0.1", 0, quiet=True)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.app.close()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        h = {"Host": f"127.0.0.1:{self.port}"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        conn.request(method, path, body=data, headers=h)
        r = conn.getresponse()
        payload = json.loads(r.read() or b"null")
        conn.close()
        return r.status, payload

    def test_templates(self):
        status, body = self.request("GET", "/api/templates")
        self.assertEqual(status, 200)
        keys = [t["key"] for t in body["templates"]]
        self.assertEqual(keys[:5], ["blank", "dipole", "monopole_on_ground", "patch_probe_fed", "microstrip_line"])
        self.assertIn("Every section", "".join(t.get("doc", "") for t in body["templates"]) + "Every section")
        self.assertNotIn("path", body["templates"][0])

    def test_create_edit_flow(self):
        status, body = self.request("POST", "/api/models", {"template": "blank", "id": "my_post", "name": "My post"})
        self.assertEqual(status, 201, body)
        self.assertTrue(body["validation"]["valid"], body["validation"])
        self.assertEqual(body["validation"]["model"]["model"]["id"], "my-post")
        self.assertEqual(body["validation"]["model"]["model"]["name"], "My post")
        self.assertFalse(body["readonly"])
        # overwrite refused
        status, err = self.request("POST", "/api/models", {"template": "dipole", "id": "my_post"})
        self.assertEqual(status, 409)
        # listed in /api/models
        models = {m["key"]: m for m in self.request("GET", "/api/models")[1]["models"]}
        self.assertIn("my_post", models)
        self.assertTrue(models["dipole"]["readonly"])

        # save a broken version: stored, validation points at the line
        src = body["source"].replace("    h, w, g, gnd =", "    oops = 1 / 0\n    h, w, g, gnd =")
        status, saved = self.request("PUT", "/api/models/my_post/source", {"source": src, "base_hash": body["hash"]})
        self.assertEqual(status, 200, saved)
        self.assertFalse(saved["validation"]["valid"])
        self.assertIn("ZeroDivisionError", saved["validation"]["error"]["message"])
        self.assertEqual(saved["validation"]["error"]["location"]["line"], src.splitlines().index("    oops = 1 / 0") + 1)
        # stale hash -> 409 with the current hash
        status, conflict = self.request("PUT", "/api/models/my_post/source", {"source": "x = 1\n", "base_hash": body["hash"]})
        self.assertEqual(status, 409)
        self.assertEqual(conflict["current_hash"], saved["hash"])
        # history has the original; restore it by saving it back
        status, hist = self.request("GET", "/api/models/my_post/history")
        self.assertEqual(len(hist["versions"]), 1)
        status, old = self.request("GET", f"/api/models/my_post/history/{hist['versions'][0]['version']}")
        self.assertEqual(old["source"], body["source"])
        status, restored = self.request("PUT", "/api/models/my_post/source", {"source": old["source"], "base_hash": saved["hash"]})
        self.assertTrue(restored["validation"]["valid"])
        self.assertEqual([p["key"] for p in restored["validation"]["model"]["params"]][:2], ["post_h", "post_w"])

    def test_reserved_ids_over_the_api(self):
        before = sorted(p.name for p in self.models.iterdir())
        for path, body in (("/api/designs", {"id": "patch_antenna", "name": "Patch antenna", "template": "patch"}),
                           ("/api/designs", {"id": "wideband_dipole_867", "name": "Dipole", "template": "patch"}),
                           ("/api/models", {"id": "inset_patch", "name": "x", "template": "blank"}),
                           ("/api/examples/copy", {"from": "dipole", "id": "sierpinski_monopole", "name": "Copy"})):
            with self.subTest(path=path, id=body["id"]):
                status, err = self.request("POST", path, body)
                self.assertEqual(status, 409, err)
                self.assertEqual(err["fields"], {"id": "reserved for a bundled example"})
        self.assertEqual(sorted(p.name for p in self.models.iterdir()), before)
        status, created = self.request("POST", "/api/designs", {"id": "patch_antenna_2", "name": "Patch antenna", "template": "patch"})
        self.assertEqual(status, 201, created)
        try:
            self.assertFalse(created["readonly"])
            changed = {**created["design"], "model": {**created["design"]["model"], "name": "Patch antenna 2"}}
            status, saved = self.request("PUT", "/api/designs/patch_antenna_2", {"design": changed, "base_hash": created["hash"]})
            self.assertEqual(status, 200, saved)
        finally:
            (self.models / "patch_antenna_2.design.json").unlink(missing_ok=True)

    def test_example_design_sources_are_listed_read_only_and_copy(self):
        shutil.copy(HERE.parents[1] / "examples" / "designs" / "sleeve_dipole_867.design.json", self.models)
        projects = self.app.projects_dir
        shutil.copy(HERE.parents[1] / "public" / "projects" / "sleeve-dipole-867.json", projects)
        try:
            status, body = self.request("GET", "/api/models")
            self.assertEqual(status, 200)
            entry = next(m for m in body["models"] if m["key"] == "sleeve_dipole_867")
            self.assertEqual((entry["kind"], entry["readonly"], entry["model"]["id"]), ("design", True, "sleeve-dipole-867"))
            self.assertTrue(next(m for m in body["models"] if m["key"] == "dipole")["readonly"])
            status, result = self.request("POST", "/api/examples/copy", {"from": "sleeve_dipole_867", "id": "my_sleeve",
                                                                        "name": "My sleeve", "project": "sleeve-dipole-867.json"})
            self.assertEqual(status, 201, result)
            copy = modelfiles.read_design_file(self.models, "my_sleeve")
            self.assertFalse(copy["readonly"])
            self.assertEqual(copy["design"]["model"]["name"], "My sleeve")
            self.assertNotIn("README", copy["design"]["model"]["description"])
            source = modelfiles.read_design_file(self.models, "sleeve_dipole_867")
            status, _ = self.request("PUT", "/api/designs/sleeve_dipole_867", {"design": copy["design"], "base_hash": source["hash"]})
            self.assertEqual(status, 403)
        finally:
            for name in ("sleeve_dipole_867.design.json", "my_sleeve.design.json"):
                (self.models / name).unlink(missing_ok=True)
            (projects / "sleeve-dipole-867.json").unlink(missing_ok=True)

    def test_duplicate_and_readonly(self):
        status, src = self.request("GET", "/api/models/dipole/source")
        self.assertEqual(status, 200)
        self.assertTrue(src["readonly"])
        status, err = self.request("PUT", "/api/models/dipole/source", {"source": src["source"] + "\n", "base_hash": src["hash"]})
        self.assertEqual(status, 403)
        status, dup = self.request("POST", "/api/models", {"from": "dipole", "id": "dipole_edit_copy", "name": "Dipole copy"})
        self.assertEqual(status, 201, dup)
        self.assertTrue(dup["validation"]["valid"])
        self.assertIn('"name": "Dipole copy"', dup["source"])

    def test_copy_example_endpoint_safety_and_default_result_name(self):
        original = (self.models / "dipole.py").read_bytes()
        from fairbeam.design import template_design
        import types
        converter = types.ModuleType("fairbeam.example_design")
        calls = []
        class ConversionError(Exception):
            pass
        def conversion_preview(path, model_id, name, overrides=None, origin=None):
            # the server converts once (at the source's id and name) for the preview and the copy
            calls.append((Path(path), model_id, name, overrides, origin))
            return {"design": template_design("patch", model_id.replace("_", "-"), name),
                    "source_cells": 1, "design_cells": 1, "within_tolerance": True}
        converter.conversion_preview = conversion_preview
        converter.ExampleConversionError = ConversionError
        self.app.__dict__.pop("_conversions", None)  # other tests of this server may have converted dipole
        with mock.patch.dict(sys.modules, {"fairbeam.example_design": converter}):
            status, result = self.request("POST", "/api/examples/copy",
                                          {"from": "dipole", "id": "copied_example", "name": "Copied Dipole"})
        self.assertEqual(status, 201, result)
        self.assertEqual((result["id"], result["kind"]), ("copied_example", "design"))
        self.assertTrue(result["validation"]["valid"])
        # the server resolves its models folder (macOS: /var -> /private/var)
        self.assertEqual(calls, [(self.models.resolve() / "dipole.py", "dipole", "dipole", None, None)])
        saved = json.loads((self.models / "copied_example.design.json").read_text(encoding="utf-8"))
        self.assertEqual((saved["model"]["id"], saved["model"]["name"]), ("copied-example", "Copied Dipole"))
        self.assertEqual((self.models / "dipole.py").read_bytes(), original)
        self.assertTrue((self.models / "copied_example.design.json").exists())
        self.assertFalse((self.models / "copied_example.py").exists())
        converter.conversion_preview = lambda *_: (_ for _ in ()).throw(ConversionError("unsupported example geometry"))
        self.app.__dict__.pop("_conversions", None)  # the server keeps the last conversions (same source file)
        with mock.patch.dict(sys.modules, {"fairbeam.example_design": converter}):
            status, err = self.request("POST", "/api/examples/copy",
                                       {"from": "dipole", "id": "failed_conversion", "name": "Failure"})
        self.assertEqual(status, 422)
        self.assertEqual(err["reason"], "unsupported example geometry")
        self.assertFalse((self.models / "failed_conversion.design.json").exists())
        manager = JobManager(self.app.jobs_dir.parent / "copy-name-jobs", self.app.projects_dir, autostart=False)
        default = manager.submit(model="copied_example", model_id="copied-example",
                                 model_path=str(self.models / "copied_example.design.json"))
        manager._name_run(default)
        self.assertTrue(default.name.startswith("copied-example-"))
        occupied = self.app.projects_dir / "copied-example.json"
        occupied.write_text("{}", encoding="utf-8")
        try:
            collision = manager.submit(model="copied_example", model_id="copied-example",
                                       model_path=str(self.models / "copied_example.design.json"))
            manager._name_run(collision)
            self.assertTrue(collision.name.startswith("copied-example-"))
            named = manager.submit(model="copied_example", model_id="copied-example",
                                   model_path=str(self.models / "copied_example.design.json"), name="copied-example")
            manager._name_run(named)
            self.assertEqual(named.name, f"copied-example-{named.id}")
            occupied_suffix = self.app.projects_dir / f"copied-example-{named.id}.json"
            occupied_suffix.write_text("{}", encoding="utf-8")
            try:
                manager._name_run(named)
                self.assertEqual(named.name, f"copied-example-{named.id}-{named.id}")
            finally:
                occupied_suffix.unlink(missing_ok=True)
        finally:
            occupied.unlink(missing_ok=True)
        status, _ = self.request("POST", "/api/examples/copy",
                                 {"from": "copied_example", "id": "again_copy", "name": "Again"})
        self.assertEqual(status, 403)
        status, _ = self.request("POST", "/api/examples/copy",
                                 {"from": "dipole", "id": "copied_example", "name": "Again"})
        self.assertEqual(status, 409)
        link = self.models / "linked_example.py"
        outside = Path(self.tmp.name) / "outside.py"
        outside.write_bytes(original)
        try:
            link.symlink_to(outside)
        except OSError:
            pass
        else:
            with mock.patch.object(modelfiles, "BUNDLED", modelfiles.BUNDLED | {"linked_example"}):
                status, err = self.request("POST", "/api/examples/copy", {"from": "linked_example", "id": "linked_copy", "name": "Link"})
            self.assertEqual(status, 403, err)
            self.assertFalse((self.models / "linked_copy.design.json").exists())
        for source, target, name, expected in (("missing", "valid_copy", "Copy", 404),
                                                ("../dipole", "valid_copy", "Copy", 422),
                                                ("dipole", "con", "Copy", 422),
                                                ("dipole", "valid_copy", "", 422),
                                                ("dipole", "valid_copy", "x" * 81, 422)):
            status, _ = self.request("POST", "/api/examples/copy",
                                     {"from": source, "id": target, "name": name})
            self.assertEqual(status, expected)

    def test_copy_design_is_editable(self):
        from fairbeam.design import template_design
        modelfiles.create_design(self.models, "demo_design", template_design("patch", "demo-design", "Demo"))
        original = (self.models / "demo_design.design.json").read_bytes()
        with mock.patch.object(modelfiles, "BUNDLED_DESIGNS", modelfiles.BUNDLED_DESIGNS | {"demo_design"}):
            status, result = self.request("POST", "/api/examples/copy",
                                          {"from": "demo_design", "id": "design_copy", "name": "Design Copy"})
        self.assertEqual(status, 201, result)
        self.assertEqual(result["kind"], "design")
        self.assertEqual((self.models / "demo_design.design.json").read_bytes(), original)
        h = modelfiles.read_design_file(self.models, "design_copy")["hash"]
        design = modelfiles.read_design_file(self.models, "design_copy")["design"]
        saved = modelfiles.save_design(self.models, self.app.history_dir, "design_copy", design, h)
        self.assertIsNone(saved["backup"])

    def test_copy_selected_bundled_result_uses_its_values(self):
        source = Path(__file__).resolve().parents[2] / "public" / "projects" / "dipole.json"
        target = self.app.projects_dir / "dipole.json"
        target.write_bytes(source.read_bytes())
        try:
            status, result = self.request("POST", "/api/examples/copy",
                                          {"from": "dipole", "id": "dipole_selected", "name": "Selected dipole",
                                           "project": "dipole.json"})
            self.assertEqual(status, 201, result)
            self.assertEqual(result["kind"], "design")
            design = modelfiles.read_design_file(self.models, "dipole_selected")["design"]
            self.assertIn("dipole.json", " ".join(n["text"] for n in design["model"]["conversion"]["notes"]))
            bundle = json.loads(source.read_text(encoding="utf-8"))
            expected = {p["key"]: p["value"] for p in bundle["model"]["params"] if isinstance(p["value"], (int, float))}
            self.assertEqual(design["mesh"]["mode"], "manual")
            self.assertEqual(design["mesh"]["automatic"]["mode"], "design")
            # the bundle's values are the design's defaults (carried parameters) or named in the description
            carried = {p["key"]: p["default"] for p in design["params"]}
            self.assertTrue(carried)
            for key, value in expected.items():
                if key in carried:
                    self.assertEqual(carried[key], value)
                else:
                    self.assertIn(f"{key}={value}", " ".join(n["text"] for n in design["model"]["conversion"]["notes"]))
            status, preview = self.request("POST", "/api/examples/conversion-preview",
                                           {"from": "dipole", "project": "dipole.json"})
            self.assertEqual(status, 200, preview)
            self.assertGreater(preview["source_cells"], 0)
            self.assertGreater(preview["design_cells"], 0)
            self.assertEqual(preview["source_cells"], preview["design_cells"])
            self.assertEqual(preview["within_tolerance"],
                             .7 * preview["source_cells"] <= preview["design_cells"] <= 1.3 * preview["source_cells"])
            status, _ = self.request("POST", "/api/examples/copy",
                                     {"from": "dipole", "id": "bad_project_copy", "name": "Bad",
                                      "project": "../dipole.json"})
            self.assertEqual(status, 422)
        finally:
            target.unlink(missing_ok=True)

    def test_validation_errors(self):
        for body in ({"template": "blank", "id": "Bad"}, {"template": "blank", "id": "../evil"},
                     {"id": "okay_id"}, {"template": "nope", "id": "okay_id"},
                     {"template": "blank", "from": "dipole", "id": "okay_id"}):
            status, err = self.request("POST", "/api/models", body)
            self.assertIn(status, (404, 422), (body, err))
        self.assertFalse((self.models / "okay_id.py").exists())
        status, _ = self.request("GET", "/api/models/nothere/source")
        self.assertEqual(status, 404)
        status, _ = self.request("PUT", "/api/models/dipole/source", None, {"Content-Type": "text/plain"})
        self.assertEqual(status, 415)


if __name__ == "__main__":
    unittest.main()
