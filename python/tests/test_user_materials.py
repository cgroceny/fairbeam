"""The user's material library (fairbeam.usermaterials, GET/PUT /api/materials/user): validation pinned
to the fixture that src/designer/userMaterials.ts is checked against (scripts/check-designer.mjs)."""

import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam import usermaterials  # noqa: E402
from fairbeam.jobs import JobManager  # noqa: E402
from fairbeam.server import App, make_server  # noqa: E402

FIXTURE = json.loads((Path(__file__).resolve().parent / "fixtures" / "user_materials.json").read_text(encoding="utf-8"))


class Validation(unittest.TestCase):
    def test_fixture(self):
        kept, warnings = usermaterials.clean_list(FIXTURE["raw"])
        self.assertEqual(kept, FIXTURE["kept"])
        self.assertEqual(len(warnings), FIXTURE["skipped"])

    def test_not_a_list(self):
        self.assertEqual(usermaterials.clean_list({"materials": 3})[0], [])
        self.assertTrue(usermaterials.clean_list("x")[1])

    def test_missing_and_damaged_files(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "materials.json"
            self.assertEqual(usermaterials.load(path), ([], []))
            path.write_text("{oops", encoding="utf-8")
            items, warnings = usermaterials.load(path)
            self.assertEqual(items, [])
            self.assertEqual(len(warnings), 1)


class Endpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        (root / "models").mkdir()
        (root / "projects").mkdir()
        manager = JobManager(root / "jobs", root / "projects", grace_s=1.0, command_factory=lambda job: [sys.executable, "-c", ""])
        cls.app = App(models_dir=root / "models", projects_dir=root / "projects", jobs_dir=root / "jobs",
                      manager=manager, heartbeat_s=0.2)
        cls.root = root
        cls.srv = make_server(cls.app, "127.0.0.1", 0, quiet=True)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stopping = True
        cls.srv.shutdown()
        cls.app.close()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        h = {"Host": f"127.0.0.1:{self.port}"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=h)
        r = conn.getresponse()
        payload = r.read()
        conn.close()
        return r.status, json.loads(payload or b"null")

    def test_round_trip_validation_and_location(self):
        (self.root / "materials.json").unlink(missing_ok=True)
        status, body = self.request("GET", "/api/materials/user")
        self.assertEqual((status, body["materials"], body["skipped"]), (200, [], []))
        # the workspace is the parent of models/
        self.assertEqual(Path(body["file"]), (self.root / "materials.json").resolve())
        status, body = self.request("PUT", "/api/materials/user", FIXTURE["raw"])
        self.assertEqual(status, 200)
        self.assertEqual(body["materials"], FIXTURE["kept"])
        self.assertEqual(len(body["skipped"]), FIXTURE["skipped"])
        on_disk = json.loads((self.root / "materials.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk, {"version": 1, "materials": FIXTURE["kept"]})
        status, body = self.request("GET", "/api/materials/user")
        self.assertEqual((status, body["materials"], body["skipped"]), (200, FIXTURE["kept"], []))
        status, body = self.request("PUT", "/api/materials/user", {"materials": []})
        self.assertEqual((status, body["materials"]), (200, []))

    def test_body_must_carry_a_list(self):
        status, body = self.request("PUT", "/api/materials/user", {"materials": "x"})
        self.assertEqual(status, 422)
        self.assertIn("materials", body.get("fields", {}))

    def test_a_damaged_file_is_ignored_with_a_warning(self):
        (self.root / "materials.json").write_text("not json", encoding="utf-8")
        status, body = self.request("GET", "/api/materials/user")
        self.assertEqual((status, body["materials"]), (200, []))
        self.assertEqual(len(body["skipped"]), 1)


if __name__ == "__main__":
    unittest.main()
