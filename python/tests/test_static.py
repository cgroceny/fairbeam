"""Same-origin serving of the built web app: path traversal, MIME types, SPA fallback, caching,
live /projects, and the API still answering under /api."""

import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from fairbeam import static  # noqa: E402
from fairbeam.jobs import JobManager  # noqa: E402
from fairbeam.server import App, make_server  # noqa: E402


def make_tree(root: Path):
    ui = root / "dist"
    (ui / "assets").mkdir(parents=True)
    (ui / "index.html").write_text("<!doctype html><title>Fairbeam</title>")
    (ui / "assets" / "index-Ddz6CWGE.js").write_text("console.log(1)")
    (ui / "assets" / "index-BN0aKoxC.css").write_text("body{}")
    (ui / "assets" / "plex-mono-latin-400.woff2").write_bytes(b"wOF2")
    (ui / "favicon.svg").write_text("<svg/>")
    (ui / ".env").write_text("SECRET=1")
    (ui / "docs").mkdir()
    (ui / "docs" / "note.txt").write_text("hello")
    (root / "outside.txt").write_text("outside")
    (ui / "link-out.txt").symlink_to(root / "outside.txt")
    projects = root / "projects"
    projects.mkdir()
    (projects / "dipole.json").write_text('{"schema": "fairbeam.project/1"}')
    (projects / "notes.txt").write_text("not a bundle")
    (ui / "projects").mkdir()
    (ui / "projects" / "stale.json").write_text("{}")  # the build-time copy must not be served
    return ui, projects


class Resolve(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.ui, self.projects = make_tree(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def r(self, path):
        f, cache = static.resolve(self.ui, self.projects, path)
        return (f.relative_to(self.root).as_posix() if f else None), cache

    def test_files_and_cache(self):
        self.assertEqual(self.r("/"), ("dist/index.html", static.REVALIDATE))
        self.assertEqual(self.r("/assets/index-Ddz6CWGE.js"), ("dist/assets/index-Ddz6CWGE.js", static.IMMUTABLE))
        self.assertEqual(self.r("/favicon.svg"), ("dist/favicon.svg", static.REVALIDATE))
        self.assertEqual(self.r("/docs/")[0], "dist/index.html")  # directory without index -> app, never a listing

    def test_traversal_and_hidden(self):
        for bad in ("/../outside.txt", "/%2e%2e/outside.txt", "/assets/../../outside.txt", "/.env", "/%2Eenv",
                    "/assets/..%2F..%2Foutside.txt", "/link-out.txt", "/a%00b.js", "/..\\outside.txt"):
            self.assertIsNone(self.r(bad)[0], bad)

    def test_spa_fallback(self):
        self.assertEqual(self.r("/projects-view/dipole")[0], "dist/index.html")
        self.assertEqual(self.r("/some/route?x=1")[0], "dist/index.html")
        self.assertIsNone(self.r("/assets/missing-12345678.js")[0])  # missing asset: 404, not HTML

    def test_projects_come_from_the_projects_folder(self):
        self.assertEqual(self.r("/projects/dipole.json")[0], "projects/dipole.json")
        self.assertIsNone(self.r("/projects/stale.json")[0])
        self.assertIsNone(self.r("/projects/notes.txt")[0])
        self.assertIsNone(self.r("/projects/../outside.txt")[0])

    def test_mime(self):
        self.assertEqual(static.content_type(Path("a.js")), "text/javascript; charset=utf-8")
        self.assertEqual(static.content_type(Path("a.css")), "text/css; charset=utf-8")
        self.assertEqual(static.content_type(Path("a.svg")), "image/svg+xml")
        self.assertEqual(static.content_type(Path("a.woff2")), "font/woff2")
        self.assertEqual(static.content_type(Path("a.html")), "text/html; charset=utf-8")
        self.assertEqual(static.content_type(Path("a.unknownext")), "application/octet-stream")


class Http(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.ui, cls.projects = make_tree(root)
        (root / "models").mkdir()
        manager = JobManager(root / "jobs", cls.projects, command_factory=lambda job: [sys.executable, "-c", "pass"])
        cls.app = App(models_dir=root / "models", projects_dir=cls.projects, jobs_dir=root / "jobs",
                      manager=manager, ui_dir=cls.ui)
        cls.srv = make_server(cls.app, "127.0.0.1", 0, quiet=True)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.app.close()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def get(self, path, method="GET", headers=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        h = {"Host": f"127.0.0.1:{self.port}", **(headers or {})}
        conn.request(method, path, body=body, headers=h)
        r = conn.getresponse()
        data = r.read()
        conn.close()
        return r, data

    def test_index_and_assets(self):
        r, data = self.get("/")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("Content-Type"), "text/html; charset=utf-8")
        self.assertEqual(r.getheader("Cache-Control"), "no-cache")
        self.assertIn(b"Fairbeam", data)
        r, data = self.get("/assets/index-Ddz6CWGE.js")
        self.assertEqual(r.getheader("Content-Type"), "text/javascript; charset=utf-8")
        self.assertEqual(r.getheader("Cache-Control"), static.IMMUTABLE)
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        r, _ = self.get("/assets/index-Ddz6CWGE.js", method="HEAD")
        self.assertEqual(r.status, 200)

    def test_no_response_can_be_framed(self):
        # a page on another localhost port is same-site: without these it could frame the app and
        # overlay its buttons (clickjacking). Pages, the SPA fallback, 404s and the API all say so.
        for path in ("/", "/editor/some/route", "/missing.js", "/api/health", "/api/no-such-route"):
            with self.subTest(path=path):
                r, _ = self.get(path)
                self.assertEqual(r.getheader("Content-Security-Policy"), "frame-ancestors 'none'")
                self.assertEqual(r.getheader("X-Frame-Options"), "DENY")

    def test_fallback_404_and_traversal(self):
        r, data = self.get("/editor/some/route")
        self.assertEqual(r.status, 200)
        self.assertIn(b"<title>Fairbeam", data)
        for bad in ("/missing.js", "/../outside.txt", "/%2e%2e/outside.txt", "/.env", "/link-out.txt"):
            r, data = self.get(bad)
            self.assertEqual(r.status, 404, bad)
            self.assertNotIn(b"outside", data)
            self.assertNotIn(b"SECRET", data)

    def test_projects_and_api_share_the_origin(self):
        r, data = self.get("/projects/dipole.json")
        self.assertEqual(r.status, 200)
        self.assertEqual(json.loads(data)["schema"], "fairbeam.project/1")
        r, data = self.get("/api/health")
        self.assertEqual(r.status, 200)
        self.assertTrue(json.loads(data)["ok"])
        r, _ = self.get("/api/nope")
        self.assertEqual(r.status, 404)
        # same-origin requests pass the Origin check; other origins and hosts do not
        r, _ = self.get("/api/health", headers={"Origin": f"http://127.0.0.1:{self.port}"})
        self.assertEqual(r.status, 200)
        r, _ = self.get("/", headers={"Host": "evil.example"})
        self.assertEqual(r.status, 403)

    def test_writes_are_refused_outside_the_api(self):
        r, _ = self.get("/index.html", method="POST", headers={"Content-Type": "application/json"}, body=b"{}")
        self.assertEqual(r.status, 405)
        r, _ = self.get("/index.html", method="PUT", headers={"Content-Type": "application/json"}, body=b"{}")
        self.assertEqual(r.status, 405)


class Cli(unittest.TestCase):
    def test_app_without_a_build_explains_how_to_build(self):
        from fairbeam import cli

        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit) as cm:
                cli.main(["app", "--ui", d, "--no-browser"])
            self.assertIn("npm run build", str(cm.exception.code))


if __name__ == "__main__":
    unittest.main()
