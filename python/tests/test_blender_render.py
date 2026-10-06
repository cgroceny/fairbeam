"""Rendering through Blender: discovery, the job file, progress parsing, cancel, output names and the HTTP routes.

Blender itself is replaced by a small fake (tests/fake_blender.py) that prints Blender's progress lines and writes
PNG files; the pure helpers of blender_render.py (look table, camera fit, SMA placement) are tested directly.
Real renders are covered by the end-to-end run in docs/RENDER-BLENDER.md.
"""

import base64
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from fairbeam import blender_find, blender_job, blender_render, renders  # noqa: E402
from fairbeam.server import App, make_server  # noqa: E402

FAKE = str(HERE / "fake_blender.py")
GLB = b"glTF" + b"\x02\x00\x00\x00" + b"\x00" * 16
GLB64 = base64.b64encode(GLB).decode()


class Discovery(unittest.TestCase):
    def test_version_parsing(self):
        v = blender_find.parse_version("TBBmalloc: skip\nBlender 4.2.3 LTS\n\tbuild date: 2024-10-15\n")
        self.assertEqual(v["tuple"], (4, 2, 3))
        self.assertEqual(v["label"], "4.2.3 LTS")
        self.assertEqual(blender_find.parse_version("Blender 3.6")["tuple"], (3, 6, 0))
        self.assertIsNone(blender_find.parse_version("Python 3.12"))

    def test_search_order(self):
        env = {"FAIRBEAM_BLENDER": "/env/blender"}
        found = blender_find.candidates("/set/blender", env, "linux", which=lambda n: "/path/blender")
        self.assertEqual([s for s, _ in found][:3], ["settings", "env", "path"])
        self.assertEqual(found[3][1], "/snap/bin/blender")
        mac = blender_find.candidates(None, {}, "darwin", which=lambda n: None)
        self.assertEqual(mac, [("install", "/Applications/Blender.app/Contents/MacOS/Blender")])

    def test_windows_picks_newest_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            for v in ("3.6", "4.2", "4.10", "4.0"):
                d = Path(tmp) / "Blender Foundation" / f"Blender {v}"
                d.mkdir(parents=True)
                (d / "blender.exe").write_text("x")
            found = blender_find.windows_candidates({"ProgramFiles": tmp})
            self.assertTrue(found[0].endswith(os.path.join("Blender 4.10", "blender.exe")))
            self.assertTrue(found[-1].endswith(os.path.join("Blender 3.6", "blender.exe")))

    def test_detect_prefers_configured_then_falls_through(self):
        ver = lambda p: {"version": "4.2.3", "tuple": (4, 2, 3), "label": "4.2.3 LTS"} if "good" in p else None
        r = blender_find.detect("/bad/blender", env={"FAIRBEAM_BLENDER": "/good/blender"}, platform="linux",
                                which=lambda n: None, version=ver, exists=lambda p: True)
        self.assertTrue(r["found"] and r["ok"])
        self.assertEqual((r["source"], r["path"]), ("env", os.path.normpath("/good/blender")))
        self.assertEqual(r["configured_error"], "not a Blender executable")
        r = blender_find.detect("/good/mine", env={}, platform="linux", which=lambda n: None, version=ver,
                                exists=lambda p: True)
        self.assertEqual(r["source"], "settings")

    def test_too_old_and_missing(self):
        old = lambda p: {"version": "2.93.0", "tuple": (2, 93, 0), "label": "2.93.0"}
        r = blender_find.detect(None, env={}, platform="linux", which=lambda n: "/usr/bin/blender", version=old,
                                exists=lambda p: True)
        self.assertTrue(r["found"])
        self.assertFalse(r["ok"])
        self.assertIn("older", r["message"])
        r = blender_find.detect(None, env={}, platform="linux", which=lambda n: None, version=old,
                                exists=lambda p: False)
        self.assertFalse(r["found"])
        self.assertEqual(r["download_url"], "https://www.blender.org/download/")

    def test_app_bundle_and_folder_are_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp) / "Blender.app"
            app.mkdir()
            self.assertEqual(blender_find.normalise_executable(str(app)), str(app / "Contents" / "MacOS" / "Blender"))
            exe = Path(tmp) / ("blender.exe" if sys.platform == "win32" else "blender")
            exe.write_text("x")
            self.assertEqual(blender_find.normalise_executable(tmp), str(exe))


class Options(unittest.TestCase):
    def test_defaults_and_aliases(self):
        o = blender_job.normalise_options({"angles": ["Iso", "top"], "width": 800, "height": 600, "background": "light",
                                           "ports": "sma", "solderMask": True})
        self.assertEqual(o["angles"], ["iso", "top"])
        self.assertEqual((o["background"], o["ports"], o["solderMask"]), ("studio", "connector", "green"))
        self.assertEqual((o["quality"], o["projection"], o["groundShadow"]), ("preview", "perspective", False))
        self.assertEqual(blender_job.normalise_options({})["angles"], ["iso"])

    def test_errors(self):
        bad = [{"angles": []}, {"angles": ["sideways"]}, {"width": 4}, {"height": 99999}, {"background": "red"},
               {"ports": "x"}, {"quality": "ultra"}, {"projection": "fisheye"}, {"angles": [{"direction": [0, 0, 0]}]},
               {"angles": ["iso"] * 13}]
        for raw in bad:
            with self.assertRaises(blender_job.RenderError, msg=str(raw)):
                blender_job.normalise_options(raw)

    def test_current_view_and_repeated_angles(self):
        o = blender_job.normalise_options({"angles": ["current", {"name": "My View!", "direction": [1, 2, 3]}, "iso"]})
        self.assertEqual(o["angles"][0], "iso")
        self.assertEqual(o["angles"][1]["name"], "my-view")
        self.assertEqual(o["angles"][2]["name"], "iso-2")           # a repeated view keeps a distinct file name
        self.assertEqual(o["angles"][2]["direction"], [1.0, -1.0, 0.8])

    def test_output_names(self):
        names = blender_job.output_names("my design/../x", ["iso", {"name": "current", "direction": [1, 0, 0]}], "20261004-120000")
        self.assertTrue(all(renders.NAME_RE.match(n) for n in names))
        self.assertTrue(names[0].endswith("_iso_20261004-120000.png"))
        self.assertEqual(blender_job.blend_name("patch", "20261004-120000"), "patch_20261004-120000.blend")
        self.assertEqual(blender_job.safe_name("../../etc"), "etc")
        self.assertEqual(blender_job.safe_name(""), "design")

    def test_job_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, out = Path(tmp) / "w", Path(tmp) / "o"
            work.mkdir()
            opts = blender_job.normalise_options({"angles": ["iso"], "quality": "final"})
            f = blender_job.write_job_file(
                work, glb=GLB, options=opts, device="gpu", stamp="s", out_dir=out, names=["a_iso_s.png"],
                blend=out / "a_s.blend",
                parts=[{"name": "p", "kind": "metal", "color": "#b87333", "junk": 1}, {"nope": 1}],
                ports=[{"number": 1, "type": "lumped", "direction": "z", "start": [0, 0, 0], "stop": [0, 0, 1e-3]},
                       {"direction": "q", "start": [0, 0, 0], "stop": [1, 1, 1]}],
                lumped=[{"name": "R1", "type": "resistor", "direction": "x", "start": [0, 0, 0], "stop": [1e-3, 0, 0], "R": 100}])
            job = json.loads(f.read_text(encoding="utf-8"))
            self.assertEqual(job["parts"], [{"name": "p", "kind": "metal", "color": "#b87333"}])
            self.assertEqual(len(job["ports"]), 1)
            self.assertEqual(job["lumped"][0]["R"], 100)
            self.assertEqual(job["outputs"], [str(out / "a_iso_s.png")])
            self.assertEqual(job["device"], "gpu")
            self.assertEqual((work / "model.glb").read_bytes(), GLB)
            cmd = blender_job.blender_command("blender", f)
            self.assertEqual(cmd[:3], ["blender", "-b", "--factory-startup"])
            self.assertEqual(cmd[-2:], ["--", str(f)])


class Progress(unittest.TestCase):
    LINE = "Fra:1 Mem:227.14M (Peak 366.56M) | Time:00:01.94 | Remaining:00:01.84 | Mem:592.86M, Peak:592.86M | Scene, ViewLayer | Sample %d/%d"

    def test_samples_and_markers(self):
        p = blender_job.ProgressParser(2)
        p.feed("@AL stage import")
        self.assertLess(p.progress, 0.04)
        p.feed("@AL device optix:NVIDIA GeForce RTX 3060")
        p.feed("@AL count 2")
        p.feed("@AL angle 1 2 iso")
        self.assertEqual((p.angle, p.angle_name), (1, "iso"))
        seen = []
        for k in (1, 8, 16, 31):
            ev = p.feed(self.LINE % (k, 32))
            self.assertEqual(ev, {"event": "sample", "sample": k, "samples": 32})
            seen.append(p.progress)
        self.assertEqual(seen, sorted(seen))
        self.assertLess(p.progress, 0.52)
        p.feed(self.LINE % (32, 32))
        self.assertTrue(p.denoising)
        ev = p.feed("@AL done 1 2 C:\\out dir\\a_iso.png 4.5")
        self.assertEqual(ev, {"event": "image", "index": 1, "path": "C:\\out dir\\a_iso.png", "seconds": 4.5})
        self.assertAlmostEqual(p.progress, 0.04 + 0.96 / 2, places=3)
        p.feed("@AL angle 2 2 top")
        p.feed(self.LINE % (16, 32))
        self.assertGreater(p.progress, 0.52)
        p.feed("@AL done 2 2 b.png 4.0")
        p.feed("@AL finished 9.0")
        self.assertEqual(p.progress, 1.0)
        self.assertEqual(p.device, "optix:NVIDIA GeForce RTX 3060")

    def test_noise_lines_are_ignored(self):
        p = blender_job.ProgressParser(1)
        for line in ("", "TBBmalloc: skip", "Fra:1 Mem:14M | Time:00:01 | Updating Meshes", "Blender quit",
                     "Fra:1 Mem:78M | Loading denoising kernels (may take a few minutes the first time)"):
            self.assertIsNone(p.feed(line))
        self.assertLess(p.progress, 0.04)
        p.feed("@AL error RuntimeError: boom")
        self.assertEqual(p.error, "RuntimeError: boom")


def wait_for(job, timeout=30.0):
    end = time.time() + timeout
    while time.time() < end and not job.terminal:
        time.sleep(0.05)
    return job


class Manager(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self.tmp.name)
        self.root = self.workspace / "renders"
        self.mgr = blender_job.RenderManager(self.workspace)
        info = {"found": True, "ok": True, "path": sys.executable, "version": "4.2.3", "label": "4.2.3 LTS",
                "source": "env", "download_url": ""}
        self.patches = [
            mock.patch.object(blender_find, "detect", lambda *a, **k: info),
            mock.patch.object(blender_job, "blender_command",
                              lambda blender, job_file, script=None: [sys.executable, FAKE, str(job_file), self.mode]),
        ]
        for p in self.patches:
            p.start()
        self.mode = "ok"

    def tearDown(self):
        self.mgr.shutdown()
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def body(self, **extra):
        return {"design_id": "patch", "options": {"angles": ["iso", "top"], "width": 64, "height": 48},
                "glb_base64": GLB64, "parts": [], "ports": [], **extra}

    def test_runs_to_done_and_names_files(self):
        job = wait_for(self.mgr.submit(self.body()))
        self.assertEqual(job.status, "done", job.error)
        d = job.to_dict()
        self.assertEqual([i["angle"] for i in d["images"]], ["iso", "top"])
        folder = self.root / "patch"
        self.assertTrue(all((folder / i["name"]).is_file() for i in d["images"]))
        self.assertRegex(d["images"][0]["name"], r"^patch_iso_\d{8}-\d{6}\.png$")
        self.assertEqual(d["images"][0]["url"], f"/api/renders/patch/file/{d['images'][0]['name']}")
        self.assertTrue(d["blend"] and (folder / d["blend"]).is_file())
        self.assertEqual(d["progress"], 1.0)
        self.assertEqual(d["device"], "fake gpu")
        self.assertFalse((self.root / ".work" / job.id).exists())          # the work folder is cleaned up

    def test_no_blend_when_not_asked(self):
        job = wait_for(self.mgr.submit(self.body(save_blend=False)))
        self.assertEqual(job.status, "done", job.error)
        self.assertIsNone(job.to_dict()["blend"])

    def test_failure_reports_the_script_error_and_keeps_a_log(self):
        self.mode = "fail"
        job = wait_for(self.mgr.submit(self.body()))
        self.assertEqual(job.status, "failed")
        self.assertIn("ValueError: no mesh", job.error)
        self.assertTrue(list((self.root / "patch").glob("rb-*-failed.log")))

    def test_cancel_kills_only_that_process_and_drops_partial_output(self):
        self.mode = "hang"
        job = self.mgr.submit(self.body())
        end = time.time() + 20
        while time.time() < end and not (job.proc and job.parser.angle):
            time.sleep(0.05)
        self.assertIsNotNone(job.proc)
        pid = job.proc.pid
        self.mgr.cancel(job.id)
        wait_for(job, 20)
        self.assertEqual(job.status, "cancelled")
        self.assertIsNotNone(job.proc.poll())
        self.assertEqual(job.images, [])
        self.assertEqual(list((self.root / "patch").glob("*.png")), [])
        self.assertNotEqual(pid, os.getpid())

    def test_cancel_while_queued(self):
        self.mode = "hang"
        first = self.mgr.submit(self.body())
        second = self.mgr.submit(self.body())
        time.sleep(0.3)
        self.assertEqual(second.status, "queued")
        self.mgr.cancel(second.id)
        self.mgr.cancel(first.id)
        wait_for(first, 20)
        wait_for(second, 20)
        self.assertEqual((first.status, second.status), ("cancelled", "cancelled"))

    def test_validation(self):
        for patch in ({"design_id": "../x"}, {"design_id": ""}, {"glb_base64": "!!"}, {"glb_base64": ""},
                      {"glb_base64": base64.b64encode(b"nope").decode()}, {"options": {"width": 1}}):
            with self.assertRaises(blender_job.RenderError, msg=str(patch)):
                self.mgr.submit({**self.body(), **patch})

    def test_refuses_without_blender(self):
        with mock.patch.object(blender_find, "detect", lambda *a, **k: {"found": False, "ok": False}):
            with self.assertRaises(blender_job.RenderError) as ctx:
                self.mgr.submit(self.body())
        self.assertEqual(ctx.exception.status, 409)
        self.assertIn("blender.org", ctx.exception.message)

    def test_file_access_stays_inside_the_design_folder(self):
        job = wait_for(self.mgr.submit(self.body()))
        name = job.to_dict()["images"][0]["name"]
        self.assertTrue(renders.render_path(self.workspace, "patch", name).is_file())
        self.assertTrue(renders.render_path(self.workspace, "patch", job.to_dict()["blend"]).is_file())
        (self.root / "secret.png").write_bytes(b"x")
        (self.root / "other").mkdir()
        (self.root / "other" / "o.png").write_bytes(b"x")
        for design, file in (("patch", "../secret.png"), ("..", "secret.png"), ("patch", "..\\secret.png"),
                             ("other/../patch", name), ("patch", "x.txt"), ("patch", "missing.png"), ("", name),
                             ("patch", name + "/..")):
            with self.assertRaises(renders.RenderError, msg=(design, file)):
                renders.render_path(self.workspace, design, file)
        self.assertTrue(renders.render_path(self.workspace, "other", "o.png").is_file())   # another design's own folder is its own

    def test_a_second_render_in_the_same_second_keeps_the_first(self):
        with mock.patch.object(blender_job, "timestamp", lambda t=None: "20261004-120000"):
            first = wait_for(self.mgr.submit(self.body()))
            second = wait_for(self.mgr.submit(self.body()))
        a, b = first.to_dict()["images"][0]["name"], second.to_dict()["images"][0]["name"]
        self.assertNotEqual(a, b)
        self.assertTrue((self.root / "patch" / a).is_file() and (self.root / "patch" / b).is_file())


class Http(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        for d in ("models", "projects"):
            (root / d).mkdir()
        cls.app = App(models_dir=root / "models", projects_dir=root / "projects", jobs_dir=root / "jobs", heartbeat_s=0.2)
        cls.srv = make_server(cls.app, "127.0.0.1", 0, quiet=True)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()
        cls.root = root

    @classmethod
    def tearDownClass(cls):
        cls.srv.stopping = True
        cls.srv.shutdown()
        cls.app.close()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None, raw=False):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        h = {"Host": f"127.0.0.1:{self.port}"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=h)
        r = conn.getresponse()
        payload = r.read()
        headers = dict(r.getheaders())
        conn.close()
        return r.status, (payload if raw else json.loads(payload or b"null")), headers

    def test_blender_endpoint(self):
        with mock.patch.object(blender_find, "detect", lambda p=None, **k: {"found": False, "ok": False, "path": p,
                                                                          "download_url": blender_find.DOWNLOAD_URL}):
            status, data, _ = self.request("GET", "/api/blender?path=C%3A%5Cx%5Cblender.exe")
        self.assertEqual(status, 200)
        self.assertFalse(data["found"])
        self.assertEqual(data["path"], "C:\\x\\blender.exe")

    def test_render_roundtrip_and_traversal(self):
        info = {"found": True, "ok": True, "path": sys.executable, "version": "4.2.3", "label": "4.2.3", "source": "env",
                "download_url": ""}
        with mock.patch.object(blender_find, "detect", lambda *a, **k: info), mock.patch.object(
                blender_job, "blender_command",
                lambda blender, job_file, script=None: [sys.executable, FAKE, str(job_file), "ok"]):
            status, job, _ = self.request("POST", "/api/render-jobs", {
                "design_id": "demo", "options": {"angles": ["iso"], "width": 32, "height": 32}, "glb_base64": GLB64})
            self.assertEqual(status, 201, job)
            end = time.time() + 30
            while time.time() < end:
                _, job, _ = self.request("GET", f"/api/render-jobs/{job['id']}")
                if job["status"] in ("done", "failed", "cancelled"):
                    break
                time.sleep(0.1)
        self.assertEqual(job["status"], "done", job)
        url = job["images"][0]["url"]
        status, png, headers = self.request("GET", url, raw=True)
        self.assertEqual((status, headers["Content-Type"]), (200, "image/png"))
        self.assertTrue(png.startswith(b"\x89PNG"))
        status, blend, headers = self.request("GET", f"/api/renders/demo/file/{job['blend']}", raw=True)
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers["Content-Disposition"])
        (self.root / "secret.png").write_bytes(b"x")
        status, listing, _ = self.request("GET", "/api/renders/demo")      # the one thumbnails list: PNGs and the .blend
        self.assertEqual(status, 200)
        self.assertEqual({f["name"] for f in listing["files"]}, {job["images"][0]["name"], job["blend"]})
        for bad in ("/api/renders/demo/file/..%2Fsecret.png", "/api/renders/demo/file/..\\" + "secret.png",
                    "/api/renders/demo/file/nope.png", "/api/renders/demo/file/a.txt", "/api/renders/%2e%2e/file/secret.png",
                    "/api/renders/../secret.png/file/x.png"):
            status, _, _ = self.request("GET", bad, raw=True)
            self.assertIn(status, (404, 405, 422), bad)
        status, data, _ = self.request("POST", "/api/renders/demo/open", {"what": "nothing"})
        self.assertEqual(status, 422)
        status, data, _ = self.request("POST", "/api/render-jobs", {"design_id": "demo", "options": {"width": 1}, "glb_base64": GLB64})
        self.assertEqual(status, 422)
        status, data, _ = self.request("GET", "/api/render-jobs/rb-00000000")
        self.assertEqual(status, 404)


    def test_open_folder_and_blend_launch_only_known_files(self):
        folder = self.root / "renders" / "openme"
        folder.mkdir(parents=True)
        (folder / "openme_x.blend").write_bytes(b"BLENDER")
        (folder / "a.png").write_bytes(b"x")
        info = {"found": True, "ok": True, "path": "C:/B/blender.exe", "download_url": ""}
        with mock.patch.object(renders, "open_folder", return_value=folder.resolve()) as of, mock.patch.object(blender_job, "open_in_blender") as ob,                 mock.patch.object(blender_find, "detect", lambda *a, **k: info):
            status, _, _ = self.request("POST", "/api/renders/openme/open", {"what": "folder"})
            self.assertEqual(status, 200)
            of.assert_called_once_with(self.app.workspace, "openme")
            status, _, _ = self.request("POST", "/api/renders/openme/open", {"what": "blend", "file": "openme_x.blend"})
            self.assertEqual(status, 200)
            self.assertEqual(ob.call_args[0][0], "C:/B/blender.exe")
            self.assertEqual(ob.call_args[0][1], (folder / "openme_x.blend").resolve())
            for file, expected in (("a.png", 422), ("../x.blend", 422), ("missing.blend", 404), ("", 422)):
                status, _, _ = self.request("POST", "/api/renders/openme/open", {"what": "blend", "file": file})
                self.assertEqual(status, expected, file)
            self.assertEqual(ob.call_count, 1)
            status, _, _ = self.request("POST", "/api/renders/..%2Fx/open", {"what": "folder"})
            self.assertIn(status, (404, 422))

    def test_open_download_page_opens_one_fixed_address(self):
        with mock.patch("webbrowser.open", return_value=True) as wb:
            status, data, _ = self.request("POST", "/api/blender/open-download", {"url": "https://evil.example"})
        self.assertEqual((status, data), (200, {"opened": True}))
        wb.assert_called_once_with("https://www.blender.org/download/")


class ScriptHelpers(unittest.TestCase):
    def test_look_table(self):
        c = blender_render.classify_part
        self.assertEqual(c({"kind": "metal", "material": "copper"})["colour"], "#B87333")
        self.assertEqual(c({"kind": "metal", "material": "PEC"})["look"], "copper")
        self.assertEqual(c({"kind": "metal", "material": "Gold finish"})["roughness"], 0.2)
        self.assertEqual(c({"kind": "metal", "name": "ground_Al"})["look"], "aluminium")
        self.assertEqual(c({"kind": "metal", "material": "tin"})["look"], "silver")
        self.assertEqual(c({"kind": "metal", "material": "copper", "color": "#112233"})["colour"], "#112233")
        self.assertEqual(c({"kind": "metal", "material": "copper", "color": "red"})["colour"], "#B87333")
        self.assertEqual(c({"kind": "dielectric", "material": "FR-4", "eps_r": 4.3})["look"], "fr4")
        self.assertEqual(c({"kind": "dielectric", "library": "ro4003c"})["look"], "rogers")
        self.assertEqual(c({"kind": "dielectric", "material": "Teflon"})["colour"], "#EDE6D6")
        self.assertEqual(c({"kind": "dielectric", "material": "alumina", "eps_r": 9.8})["look"], "ceramic")
        self.assertEqual(c({"kind": "dielectric", "material": "foam"})["look"], "dielectric")
        self.assertEqual(c({"kind": "dielectric", "material": "air", "eps_r": 1})["look"], "void")
        self.assertEqual(c({"kind": "dielectric", "void": True})["look"], "void")

    def test_colours(self):
        self.assertAlmostEqual(blender_render.linear_colour("#FFFFFF")[0], 1.0)
        self.assertAlmostEqual(blender_render.linear_colour("#808080")[0], 0.2159, places=3)
        with self.assertRaises(ValueError):
            blender_render.hex_to_rgb("blue")

    def test_camera_fit_frames_every_point(self):
        import math
        pts = [(x, y, z) for x in (-30e-3, 30e-3) for y in (-30e-3, 30e-3) for z in (0.0, 1.5e-3)]
        aspect, fov = 1600 / 1000, math.radians(30)
        for name in ("iso", "top", "front", "bottom"):
            _n, d, up = blender_render.angle_view(name)
            fit = blender_render.fit_camera(pts, d, up, aspect, fov_y=fov)
            worst = 0.0
            for p in pts:
                rel = [p[i] - fit["location"][i] for i in range(3)]
                depth = -sum(rel[i] * d[i] for i in range(3))
                self.assertGreater(depth, 0)
                x = sum(rel[i] * fit["right"][i] for i in range(3)) / depth / (math.tan(fov / 2) * aspect)
                y = sum(rel[i] * fit["up"][i] for i in range(3)) / depth / math.tan(fov / 2)
                worst = max(worst, abs(x), abs(y))
            self.assertLessEqual(worst, 1.0 + 1e-9, name)       # inside the frame
            self.assertGreater(worst, 0.8, name)                  # but not wasting the picture
        fit = blender_render.fit_camera(pts, (0, 0, 1), (0, 1, 0), aspect, ortho=True)
        self.assertGreater(fit["ortho_scale"], 60e-3)

    def test_angles(self):
        self.assertEqual(blender_render.angle_view("front")[1], (0.0, -1.0, 0.0))
        name, d, up = blender_render.angle_view({"name": "My view", "direction": [0, 0, 5], "up": [0, 0, 1]})
        self.assertEqual(name, "my-view")
        self.assertNotAlmostEqual(abs(sum(a * b for a, b in zip(d, up))), 1.0)       # a degenerate up is repaired
        with self.assertRaises(ValueError):
            blender_render.angle_view("diagonal")

    def sheet(self, lo, hi):
        ax = blender_render._flat_axis(lo, hi, 1e-9)
        return {"lo": lo, "hi": hi, "axis": ax}

    def test_sma_probe_on_a_ground_plane(self):
        gnd = self.sheet((-30e-3, -30e-3, 0), (30e-3, 30e-3, 0))
        patch = self.sheet((-16e-3, -20e-3, 1.5e-3), (16e-3, 20e-3, 1.5e-3))
        port = {"direction": "z", "start": [-6e-3, 0, 0], "stop": [-6e-3, 0, 1.5e-3]}
        m = blender_render.plan_port_mount(port, [gnd, patch], 1e-8)
        self.assertEqual(m["mode"], "probe")
        self.assertEqual(m["axis"], (0.0, 0.0, -1.0))              # body under the ground plane
        self.assertEqual(m["pin_to"], (-6e-3, 0, 1.5e-3))

    def test_sma_edge_launch(self):
        gnd = self.sheet((-25e-3, -15e-3, 0), (25e-3, 15e-3, 0))
        line = self.sheet((-25e-3, -1.5e-3, 1.6e-3), (25e-3, 1.5e-3, 1.6e-3))
        left = {"direction": "z", "start": [-25e-3, 0, 0], "stop": [-25e-3, 0, 1.6e-3]}
        m = blender_render.plan_port_mount(left, [gnd, line], 1e-8)
        self.assertEqual((m["mode"], m["axis"]), ("edge", (-1.0, 0.0, 0.0)))
        right = {"direction": "z", "start": [25e-3, 0, 0], "stop": [25e-3, 0, 1.6e-3]}
        self.assertEqual(blender_render.plan_port_mount(right, [gnd, line], 1e-8)["axis"], (1.0, 0.0, 0.0))
        self.assertAlmostEqual(m["origin"][2], 0.8e-3)           # the flange is centred on the board thickness
        self.assertAlmostEqual(m["origin"][0], -25e-3)           # ... and sits flush against the board edge
        self.assertEqual(m["origin"][1], 0.0)                    # ... and on the strip's centre line
        self.assertAlmostEqual(m["trace"][2], 1.6e-3)

    def test_edge_launch_pin_lies_on_the_trace_top(self):
        gnd = self.sheet((-25e-3, -15e-3, 0), (25e-3, 15e-3, 0))
        line = self.sheet((-25e-3, -1.55e-3, 1.6e-3), (25e-3, 1.55e-3, 1.6e-3))
        for sx, x in ((-1, -25e-3), (1, 25e-3)):
            m = blender_render.plan_port_mount({"direction": "z", "start": [x, -1.55e-3, 0], "stop": [x, 1.55e-3, 1.6e-3]},
                                               [gnd, line], 1e-8)
            self.assertEqual(m["axis"], (float(sx), 0.0, 0.0))
            self.assertEqual(m["up"], (0.0, 0.0, 1.0))
            ex = blender_render.edge_launch_extras(m)
            blade, tab = ex["blade"], ex["tab"]
            self.assertAlmostEqual(blade["lo"][2], 1.6e-3)                       # the blade rests on the trace top
            self.assertGreater(blade["hi"][2], blade["lo"][2])
            self.assertLess(blade["hi"][2] - blade["lo"][2], 0.5e-3)             # a thin foil, not a block
            self.assertAlmostEqual(blade["lo"][1], -blade["hi"][1])              # centred on the strip
            self.assertLess(blade["hi"][1] - blade["lo"][1], 3.1e-3)             # narrower than the 3.1 mm strip
            inward = -sx
            self.assertAlmostEqual(abs(blade["lo"][0] - blade["hi"][0]), 3.5e-3)       # 3.5 mm along the strip
            self.assertAlmostEqual(max(blade["lo"][0] * -inward, blade["hi"][0] * -inward), 25e-3)    # starting at the edge
            self.assertAlmostEqual(abs(ex["post"]["a"][0]), 25e-3)               # the pin starts at the board edge
            self.assertAlmostEqual(ex["post"]["a"][2], 0.8e-3)                   # on the flange axis (mid thickness)
            self.assertAlmostEqual(ex["post"]["b"][2], blade["hi"][2])           # and rises to the blade
            self.assertAlmostEqual(tab["hi"][2], 0.0)                            # the ground tab is under the board
            self.assertLess(tab["lo"][2], 0.0)
            f = ex["fillet"]["centre"]
            self.assertAlmostEqual(f[2], 1.6e-3 + 0.1e-3)                        # the fillet sits on the blade tip
            self.assertAlmostEqual(abs(f[0]), 25e-3 - 3.5e-3)

    def test_free_feed_coax_never_puts_a_flange_over_the_feed(self):
        top = self.sheet((-0.5e-3, 0, 0.5e-3), (0.5e-3, 0, 28e-3))
        bottom = self.sheet((-0.5e-3, 0, -28e-3), (0.5e-3, 0, -0.5e-3))
        port = {"direction": "z", "start": [-0.5e-3, 0, -0.5e-3], "stop": [0.5e-3, 0, 0.5e-3]}
        m = blender_render.plan_port_mount(port, [top, bottom], 1e-8)
        self.assertEqual(m["mode"], "free")
        self.assertEqual(m["axis"], (0.0, 1.0, 0.0))                  # behind the dipole as seen from the iso camera
        lay = blender_render.free_feed_layout(m)
        j = lay["jacket"]
        self.assertAlmostEqual(j["r"] * 2, 2.19e-3)                   # semi-rigid, about 2.2 mm
        self.assertLess(max(j["a"][2], j["b"][2]) + j["r"], -0.5e-3 + 1e-9)    # the jacket rests on the lower arm, off the gap
        self.assertAlmostEqual(j["b"][1] - j["a"][1], 28e-3)
        self.assertAlmostEqual(lay["centre"]["a"][1], 0.0)            # the centre conductor reaches the arms' plane ...
        self.assertGreater(lay["bridge"]["b"][2], 0.5e-3)             # ... and a wire bridges to the upper arm
        self.assertEqual(lay["axis"], (0.0, 1.0, 0.0))

    def test_sma_free_gap_and_fallbacks(self):
        top = self.sheet((-0.5e-3, 0, 0.5e-3), (0.5e-3, 0, 28e-3))
        bottom = self.sheet((-0.5e-3, 0, -28e-3), (0.5e-3, 0, -0.5e-3))
        port = {"direction": "z", "start": [-0.5e-3, 0, -0.5e-3], "stop": [0.5e-3, 0, 0.5e-3]}
        m = blender_render.plan_port_mount(port, [top, bottom], 1e-8)
        self.assertEqual((m["mode"], m["axis"]), ("free", (0.0, 1.0, 0.0)))      # perpendicular to the dipole's plane (y)
        # nothing metallic near the port, or a bad direction: no connector (the marker is drawn instead)
        far = {"direction": "x", "start": [1, 1, 1], "stop": [1.001, 1, 1]}
        self.assertIsNone(blender_render.plan_port_mount(far, [top, bottom], 1e-8))
        self.assertIsNone(blender_render.plan_port_mount({**port, "direction": "w"}, [top, bottom], 1e-8))
        self.assertIsNone(blender_render.plan_port_mount(port, [], 1e-8))


if __name__ == "__main__":
    unittest.main()
