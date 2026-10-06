"""Rendered images of a design: the workspace folder, the file names, the server routes. No solver runs."""
import base64
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from fairbeam import renders
from fairbeam.jobs import JobManager
from fairbeam.renders import RenderError
from fairbeam.server import App, make_server

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


class RenderFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_saved_into_renders_design_folder(self):
        path = renders.save_png(self.ws, "patch_test", "patch_test_iso_20261004-153012.png", PNG)
        self.assertEqual(path, (self.ws / "renders" / "patch_test" / "patch_test_iso_20261004-153012.png").resolve())
        self.assertEqual(path.read_bytes(), PNG)

    def test_never_overwrites_a_taken_name(self):
        a = renders.save_png(self.ws, "d", "d_iso_1.png", PNG)
        b = renders.save_png(self.ws, "d", "d_iso_1.png", PNG + b"x")
        c = renders.save_png(self.ws, "d", "d_iso_1.png", PNG + b"y")
        self.assertEqual([a.name, b.name, c.name], ["d_iso_1.png", "d_iso_1-2.png", "d_iso_1-3.png"])
        self.assertEqual(a.read_bytes(), PNG)

    def test_refuses_what_is_not_a_png_or_a_safe_name(self):
        for bad in ("../x.png", "a/b.png", "a\\b.png", "x.jpg", "x.png.exe", ".png", "con.png", "a..b.png", "x" * 200 + ".png", ""):
            with self.assertRaises(RenderError, msg=bad):
                renders.save_png(self.ws, "d", bad, PNG)
        with self.assertRaises(RenderError):
            renders.save_png(self.ws, "d", "ok.png", b"not a png")
        self.assertFalse((self.ws / "renders" / "d").exists(), "nothing is created for a refused picture")

    def test_refuses_unsafe_design_ids(self):
        for bad in ("..", "../x", "a/b", "", "con", "x" * 90, ".hidden", "a b", None, 5):
            with self.assertRaises(RenderError, msg=str(bad)):
                renders.render_dir(self.ws, bad)

    def test_too_large(self):
        with mock.patch.object(renders, "MAX_PNG", 100):
            with self.assertRaises(RenderError) as cm:
                renders.save_png(self.ws, "d", "x.png", PNG + b"\x00" * 100)
        self.assertEqual(cm.exception.status, 413)

    def test_decode(self):
        self.assertEqual(renders.decode(base64.b64encode(PNG).decode()), PNG)
        for bad in ("***", None, 5):
            with self.assertRaises(RenderError):
                renders.decode(bad)

    def test_list_and_read(self):
        renders.save_png(self.ws, "d", "a.png", PNG)
        renders.save_png(self.ws, "d", "b.png", PNG + b"1")
        (self.ws / "renders" / "d" / "notes.txt").write_text("x")
        listing = renders.list_renders(self.ws, "d")
        self.assertEqual(sorted(f["name"] for f in listing["files"]), ["a.png", "b.png"], "only pictures are listed")
        self.assertEqual(renders.list_renders(self.ws, "none")["files"], [])
        self.assertEqual(renders.read_render(self.ws, "d", "b.png"), PNG + b"1")
        with self.assertRaises(RenderError) as cm:
            renders.read_render(self.ws, "d", "gone.png")
        self.assertEqual(cm.exception.status, 404)
        with self.assertRaises(RenderError):
            renders.read_render(self.ws, "d", "../../etc.png")

    def test_open_folder_creates_it_and_asks_the_system(self):
        with mock.patch("os.startfile", create=True) as startfile, mock.patch("subprocess.Popen"), \
             mock.patch.object(renders.sys, "platform", "win32"):
            folder = renders.open_folder(self.ws, "d")
            startfile.assert_called_once_with(str(folder))
        self.assertTrue(folder.is_dir())
        with mock.patch("subprocess.Popen") as popen, mock.patch.object(renders.sys, "platform", "darwin"):
            renders.open_folder(self.ws, "d")
            self.assertEqual(popen.call_args[0][0][0], "open")
        with mock.patch("subprocess.Popen") as popen, mock.patch.object(renders.sys, "platform", "linux"):
            renders.open_folder(self.ws, "d")
            self.assertEqual(popen.call_args[0][0][0], "xdg-open")


class RenderRoutes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "models").mkdir()
        manager = JobManager(root / "jobs", root / "projects", autostart=False)
        with mock.patch("fairbeam.server.detect_engines", return_value=["cpu"]), mock.patch("fairbeam.server._versions", return_value={}):
            self.app = App(models_dir=root / "models", projects_dir=root / "projects", jobs_dir=root / "jobs", manager=manager)
        self.root = root
        self.server = make_server(self.app, port=0, quiet=True)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.app.close()
        self.tmp.cleanup()

    def call(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Content-Type": "application/json"} if body is not None else {}
        conn.request(method, path, json.dumps(body) if body is not None else None, headers)
        r = conn.getresponse()
        data = r.read()
        conn.close()
        return r.status, r.getheader("Content-Type"), data

    def test_save_list_fetch(self):
        data = base64.b64encode(PNG).decode()
        status, _, raw = self.call("POST", "/api/renders/patch_test", {"name": "patch_test_top_1.png", "data": data})
        self.assertEqual(status, 201, raw)
        saved = json.loads(raw)
        self.assertEqual(saved["name"], "patch_test_top_1.png")
        self.assertEqual(Path(saved["path"]), (self.root / "renders" / "patch_test" / "patch_test_top_1.png").resolve(), "next to models/ and projects/")
        status, _, raw = self.call("POST", "/api/renders/patch_test", {"name": "patch_test_top_1.png", "data": data})
        self.assertEqual(json.loads(raw)["name"], "patch_test_top_1-2.png", "the second save keeps the first")
        status, _, raw = self.call("GET", "/api/renders/patch_test")
        self.assertEqual(sorted(f["name"] for f in json.loads(raw)["files"]), ["patch_test_top_1-2.png", "patch_test_top_1.png"])
        status, ctype, raw = self.call("GET", "/api/renders/patch_test/file/patch_test_top_1.png")
        self.assertEqual((status, ctype, raw), (200, "image/png", PNG))

    def test_refusals(self):
        data = base64.b64encode(PNG).decode()
        self.assertEqual(self.call("POST", "/api/renders/patch_test", {"name": "../x.png", "data": data})[0], 422)
        self.assertEqual(self.call("POST", "/api/renders/patch_test", {"name": "x.png", "data": base64.b64encode(b"nope").decode()})[0], 422)
        self.assertEqual(self.call("POST", "/api/renders/patch_test", {"name": "x.png"})[0], 422)
        self.assertEqual(self.call("POST", "/api/renders/con", {"name": "x.png", "data": data})[0], 422)
        self.assertEqual(self.call("GET", "/api/renders/patch_test/file/missing.png")[0], 404)
        self.assertFalse((self.root / "renders").exists() and any((self.root / "renders").rglob("*.png")))

    def test_open_folder_route(self):
        with mock.patch("fairbeam.renders.open_folder", return_value=self.root / "renders" / "d") as opened:
            status, _, raw = self.call("POST", "/api/renders/d/open", {})
        self.assertEqual(status, 200)
        opened.assert_called_once()
        self.assertEqual(json.loads(raw)["id"], "d")


if __name__ == "__main__":
    unittest.main()
