"""Run server: parameter validation, SSE framing and the HTTP API.

The preview test uses the real geometry path on python/models/dipole.py (builds the model and
exports the bundle; openEMS is not run). Jobs use the fake child from tests/fake_openems.py.
"""

import http.client
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from fairbeam.jobs import JobManager  # noqa: E402
from fairbeam.procutil import WINDOWS  # noqa: E402
from fairbeam.server import (App, default_threads, detect_engines, expand_sweep, format_sse, make_server,  # noqa: E402
                             openems_executable, slugify, sse_comment, validate_params)

MODELS = HERE.parent / "models"
FAKE = str(HERE / "fake_openems.py")

SPECS = [
    {"key": "length", "default": 58.0, "type": "float", "unit": "mm", "minimum": 5, "maximum": 200},
    {"key": "iterations", "default": 3, "type": "int", "unit": "", "minimum": 0, "maximum": 5},
    {"key": "label", "default": "a", "type": "str", "unit": "", "minimum": None, "maximum": None},
]


class Validation(unittest.TestCase):
    def test_public_model_modified_time_does_not_expose_path(self):
        public = App._public({"key": "dipole", "path": "private/dipole.py", "mtime": 123.5})
        self.assertEqual(public, {"key": "dipole", "modified": 123.5})
        self.assertEqual(App._public({"key": "old", "mtime": None}), {"key": "old"})

    def test_defaults_and_overrides(self):
        resolved, overrides, errors = validate_params(SPECS, {"length": 60, "iterations": 3})
        self.assertEqual(errors, {})
        self.assertEqual(resolved, {"length": 60.0, "iterations": 3, "label": "a"})
        self.assertEqual(overrides, {"length": "60"})  # unchanged values are not overrides

    def test_float_text_is_exact(self):
        _, overrides, _ = validate_params(SPECS, {"length": 60.125})
        self.assertEqual(overrides, {"length": "60.125"})

    def test_errors_per_field(self):
        _, _, errors = validate_params(SPECS, {"length": 2, "iterations": 2.5, "nope": 1})
        self.assertEqual(errors["length"], "must be at least 5 mm")
        self.assertEqual(errors["iterations"], "must be a whole number")
        self.assertIn("unknown parameter", errors["nope"])
        _, _, errors = validate_params(SPECS, {"length": "abc", "iterations": 9})
        self.assertEqual(errors["length"], "must be a number")
        self.assertEqual(errors["iterations"], "must be at most 5")
        _, _, errors = validate_params(SPECS, {"length": True})
        self.assertEqual(errors["length"], "must be a number")
        _, _, errors = validate_params(SPECS, {"length": float("nan")})
        self.assertEqual(errors["length"], "must be a finite number")
        self.assertEqual(validate_params(SPECS, [1])[2], {"_": "params must be an object"})

    def test_numeric_strings_and_empty(self):
        resolved, overrides, errors = validate_params(SPECS, {"length": " 61.5 ", "iterations": "", "label": "b"})
        self.assertEqual(errors, {})
        self.assertEqual(resolved["length"], 61.5)
        self.assertEqual(resolved["iterations"], 3)
        self.assertEqual(overrides, {"length": "61.5", "label": "b"})

    def test_default_threads(self):
        with mock.patch("fairbeam.resources.physical_cores", side_effect=lambda n=None: n):
            self.assertEqual(default_threads(15), 4)
            self.assertEqual(default_threads(4), 3)
            self.assertEqual(default_threads(1), 1)


class Sweeps(unittest.TestCase):
    def test_values_and_range(self):
        combos, axes, errors = expand_sweep(SPECS, {}, [{"key": "length", "start": 50, "stop": 60, "steps": 3}])
        self.assertEqual(errors, {})
        self.assertEqual(combos, [{"length": 50.0}, {"length": 55.0}, {"length": 60.0}])
        combos, _, _ = expand_sweep(SPECS, {}, [{"key": "length", "start": 0.1 * 60, "stop": 0.3 * 60, "steps": 3}])
        self.assertEqual([c["length"] for c in combos], [6.0, 12.0, 18.0])  # no float noise
        combos, _, _ = expand_sweep(SPECS, {}, [{"key": "length", "values": [60, 58, 60]}])
        self.assertEqual(combos, [{"length": 60.0}, {"length": 58.0}])  # duplicates dropped, order kept

    def test_two_axes_cartesian(self):
        combos, axes, errors = expand_sweep(SPECS, {}, [{"key": "length", "values": [50, 60]},
                                                        {"key": "iterations", "start": 0, "stop": 2, "steps": 3}])
        self.assertEqual(errors, {})
        self.assertEqual(len(combos), 6)
        self.assertEqual(combos[0], {"length": 50.0, "iterations": 0})
        self.assertEqual(combos[3], {"length": 60.0, "iterations": 0})
        self.assertIsInstance(combos[1]["iterations"], int)

    def test_errors(self):
        self.assertIn("sweep", expand_sweep(SPECS, {}, [])[2])
        self.assertIn("sweep", expand_sweep(SPECS, {}, [{"key": "length", "values": [6]}] * 3)[2])
        self.assertEqual(expand_sweep(SPECS, {}, [{"key": "label", "values": ["a"]}])[2],
                         {"label": "only numeric parameters can be swept"})
        self.assertIn("sweep.0", expand_sweep(SPECS, {}, [{"key": "nope", "values": [1]}])[2])
        self.assertIn("at least 5", expand_sweep(SPECS, {}, [{"key": "length", "values": [2, 6]}])[2]["length"])
        combos, _, err = expand_sweep(SPECS, {}, [{"key": "length", "start": 10, "stop": 100, "steps": 13},
                                                  {"key": "iterations", "values": [0, 1]}])
        self.assertEqual(combos, [])
        self.assertIn("26 runs", err["sweep"])
        self.assertIn("steps", expand_sweep(SPECS, {}, [{"key": "length", "start": 10, "stop": 20, "steps": 0}])[2]["length"])

    def test_ordered_sequence_expansion(self):
        from fairbeam.server import expand_sequences
        combos, sequences, errors = expand_sequences(SPECS, [
            {"name": "coarse", "sweep": [{"key": "length", "values": [50, 60]},
                                            {"key": "iterations", "values": [0, 1]}]},
            {"name": "fine", "sweep": [{"key": "length", "start": 70, "stop": 80, "steps": 2}]},
        ])
        self.assertEqual(errors, {})
        self.assertEqual([c["sequence_name"] for c in combos], ["coarse"] * 4 + ["fine"] * 2)
        self.assertEqual([c["sequence_index"] for c in combos], [0] * 4 + [1] * 2)
        self.assertEqual([c["values"] for c in combos[:4]], [
            {"length": 50.0, "iterations": 0}, {"length": 50.0, "iterations": 1},
            {"length": 60.0, "iterations": 0}, {"length": 60.0, "iterations": 1}])
        self.assertEqual([s["total"] for s in sequences], [4, 2])
        self.assertTrue(expand_sequences(SPECS, [{"name": "", "sweep": [{"key": "length", "values": [50]}]}])[2])
        self.assertTrue(expand_sequences(SPECS, [{"name": "bad", "sweep": [{"key": "unknown", "values": [50]}]}])[2])
        six_specs = [{"key": f"p{i}", "default": 0, "type": "int", "minimum": 0, "maximum": 1}
                     for i in range(7)]
        six = [{"key": f"p{i}", "values": [0]} for i in range(6)]
        self.assertEqual(expand_sequences(six_specs, [{"name": "six axes", "sweep": six}])[2], {})
        self.assertTrue(expand_sequences(six_specs, [{"name": "seven axes", "sweep": six + [
            {"key": "p6", "values": [0]}]}])[2])
        over = [{"name": str(i), "sweep": [{"key": "length", "values": list(range(5, 105))}]} for i in range(6)]
        self.assertTrue(expand_sequences(SPECS, over)[2])

    def test_oversized_sequences_refused_before_expansion(self):
        from fairbeam.server import MAX_SEQUENCES, MAX_SWEEP_RUNS, expand_sequences
        big = {"key": "length", "start": 10, "stop": 100, "steps": MAX_SWEEP_RUNS}
        # many full sequences (about the size a 1 MB body allows): refused without building them all
        many = [{"name": f"s{i}", "sweep": [big]} for i in range(12000)]
        t0 = time.time()
        combos, _, errors = expand_sequences(SPECS, many)
        self.assertLess(time.time() - t0, 1.0)
        self.assertEqual(combos, [])
        self.assertIn(f"at most {MAX_SEQUENCES}", errors["sequences"])
        # within the sequence cap, expansion stops at the first sequence that crosses the run cap
        few = [{"name": f"s{i}", "sweep": [big]} for i in range(MAX_SEQUENCES)]
        t0 = time.time()
        combos, sequences, errors = expand_sequences(SPECS, few)
        self.assertLess(time.time() - t0, 1.0)
        self.assertEqual(combos, [])
        self.assertEqual(len(sequences), 1)
        self.assertIn(f"at most {MAX_SWEEP_RUNS}", errors["sequences"])

    def test_slugify(self):
        self.assertEqual(slugify("Dipole 60 mm"), "dipole-60-mm")
        self.assertEqual(slugify("../etc/passwd"), "etc-passwd")
        self.assertEqual(slugify("!!!"), "")


class Engines(unittest.TestCase):
    @unittest.skipIf(WINDOWS, "the stand-in openEMS is a shell script; the official Windows build has no GPU "
                              "engine (test_windows_install_layout covers Windows)")
    def test_detect_gpu_build(self):
        with tempfile.TemporaryDirectory() as d:
            prefix = Path(d)
            (prefix / "venv" / "bin").mkdir(parents=True)
            (prefix / "bin").mkdir()
            python = str(prefix / "venv" / "bin" / "python")
            self.assertEqual(detect_engines(python), ["cpu"])  # no openEMS binary
            exe = prefix / "bin" / "openEMS"
            exe.write_text("#!/bin/sh\necho '  --engine arg (=fastest)'\necho '      gpu: GPU engine on the best available'\n")
            exe.chmod(0o755)
            self.assertEqual(detect_engines(python), ["cpu", "gpu"])
            exe.write_text("#!/bin/sh\necho '      multithreaded: engine using compressed operator'\n")
            self.assertEqual(detect_engines(python), ["cpu"])

    @unittest.skipUnless(WINDOWS, "Windows install layout")
    def test_windows_install_layout(self):
        # <venv>\Scripts\python.exe; openEMS.exe lives in OPENEMS_INSTALL_PATH, not next to the venv
        # Only a controlled temporary install is used: the host may have the GPU build installed too (#237).
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"OPENEMS_INSTALL_PATH": d}):
            python = str(Path(d) / "venv" / "Scripts" / "python.exe")
            self.assertEqual(openems_executable(python), Path(d) / "openEMS.exe")
            self.assertEqual(detect_engines(python), ["cpu"])  # no openEMS.exe
            (Path(d) / "openEMS.exe").write_bytes(b"")
            for help_text, expected in (("      multithreaded: engine\n", ["cpu"]),
                                        ("      gpu: GPU engine\n", ["cpu", "gpu"])):
                fake = mock.Mock(stdout=help_text, stderr="")
                with mock.patch("fairbeam.server.subprocess.run", return_value=fake):
                    self.assertEqual(detect_engines(python), expected)


class SseFraming(unittest.TestCase):
    def test_frame(self):
        frame = format_sse({"seq": 7, "type": "progress", "timestep": 10, "line": "a\nb"})
        text = frame.decode()
        self.assertTrue(text.endswith("\n\n"))
        lines = text[:-2].split("\n")
        self.assertEqual(lines[0], "id: 7")
        self.assertEqual(lines[1], "event: progress")
        self.assertTrue(lines[2].startswith("data: "))
        self.assertEqual(len(lines), 3)  # the newline inside a value is escaped by JSON
        self.assertEqual(json.loads(lines[2][6:])["line"], "a\nb")
        self.assertEqual(sse_comment(), b": keepalive\n\n")


def parse_sse(raw: str) -> tuple[list[dict], list[str]]:
    events, comments = [], []
    for block in raw.split("\n\n"):
        fields = {}
        for line in block.split("\n"):
            if line.startswith(":"):
                comments.append(line[1:].strip())
            elif ": " in line:
                k, v = line.split(": ", 1)
                fields[k] = v
        if "data" in fields:
            ev = json.loads(fields["data"])
            ev["_event"], ev["_id"] = fields.get("event"), fields.get("id")
            events.append(ev)
    return events, comments


class ShellShutdown(unittest.TestCase):
    """POST /api/shutdown from the desktop shell stops serve_forever, also when the answer cannot
    be written. The shell reads only the status line and closes; on Windows that resets the
    connection, and the stop used to be skipped (the shell then killed the server after 8 s)."""

    def serve(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "projects").mkdir()
        app = App(models_dir=MODELS, projects_dir=root / "projects", jobs_dir=root / "jobs",
                  manager=JobManager(root / "jobs", root / "projects", autostart=False))
        self.addCleanup(app.close)
        srv = make_server(app, "127.0.0.1", 0, quiet=True)
        self.addCleanup(srv.server_close)
        t = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        t.start()
        return srv, t

    def post_shutdown(self, port, timeout=10):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
        conn.request("POST", "/api/shutdown", body=b"{}", headers={
            "Host": f"127.0.0.1:{port}", "Content-Type": "application/json", "X-Fairbeam-Token": "s3cret"})
        try:
            return conn.getresponse().status
        except (http.client.HTTPException, OSError):
            return None  # no answer: the write failed
        finally:
            conn.close()

    def test_stops(self):
        srv, t = self.serve()
        with mock.patch.dict(os.environ, {"FAIRBEAM_SHUTDOWN_TOKEN": "s3cret"}):
            self.assertEqual(self.post_shutdown(srv.server_address[1]), 202)
        t.join(5)
        self.assertFalse(t.is_alive(), "serve_forever did not return")

    def test_stops_when_the_answer_cannot_be_written(self):
        from fairbeam.server import Handler

        srv, t = self.serve()
        original = Handler._json

        def reset(handler, status, obj):
            if status == 202:  # the shell has already closed the connection
                raise ConnectionResetError(10054, "An existing connection was forcibly closed by the remote host")
            return original(handler, status, obj)

        with mock.patch.dict(os.environ, {"FAIRBEAM_SHUTDOWN_TOKEN": "s3cret"}), \
                mock.patch.object(Handler, "_json", reset), redirect_stdout(io.StringIO()):
            # no answer ever comes back here, so do not wait out the default 10 s client timeout
            self.post_shutdown(srv.server_address[1], timeout=1)
            t.join(5)
        self.assertFalse(t.is_alive(), "serve_forever did not return after a failed answer")


class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        (root / "projects").mkdir()
        manager = JobManager(root / "jobs", root / "projects", grace_s=1.0,
                             command_factory=lambda job: [sys.executable, FAKE, job.params.get("gap") == 0.5
                                                          and "hang" or "ok", str(root / "projects")])
        cls.app = App(models_dir=MODELS, projects_dir=root / "projects", jobs_dir=root / "jobs",
                      manager=manager, heartbeat_s=0.2)
        cls.srv = make_server(cls.app, "127.0.0.1", 0, quiet=True)
        cls.port = cls.srv.server_address[1]
        cls.thread = threading.Thread(target=cls.srv.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stopping = True
        cls.srv.shutdown()
        cls.app.close()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None, headers=None, raw=False):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        h = {"Host": f"127.0.0.1:{self.port}"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        conn.request(method, path, body=data, headers=h)
        r = conn.getresponse()
        payload = r.read()
        conn.close()
        return r.status, (payload.decode() if raw else json.loads(payload or b"null"))

    def test_shutdown_needs_the_shell_token(self):
        # without FAIRBEAM_SHUTDOWN_TOKEN the route does not exist; with it, only the token works
        # (a successful call would interrupt this test process, so only refusals are exercised)
        os.environ.pop("FAIRBEAM_SHUTDOWN_TOKEN", None)
        status, _ = self.request("POST", "/api/shutdown", {})
        self.assertEqual(status, 404)
        os.environ["FAIRBEAM_SHUTDOWN_TOKEN"] = "s3cret"
        try:
            status, _ = self.request("POST", "/api/shutdown", {}, headers={"X-Fairbeam-Token": "wrong"})
            self.assertEqual(status, 403)
            status, _ = self.request("POST", "/api/shutdown", None, headers={"X-Fairbeam-Token": "s3cret"})
            self.assertEqual(status, 415)  # a JSON POST only
        finally:
            os.environ.pop("FAIRBEAM_SHUTDOWN_TOKEN", None)

    def test_open_feedback_opens_only_the_issue_forms(self):
        base = "https://github.com/ismailakdag/fairbeam-releases/issues/new"
        good = [base + "/choose", base + "?template=bug.yml&version=0.3.0&os=macOS", base + "?template=feature.yml",
                base + "?template=bug.yml&os=Windows"]
        bad = ["http://github.com/ismailakdag/fairbeam-releases/issues/new/choose",
               "https://github.com.evil.example/ismailakdag/fairbeam-releases/issues/new/choose",
               "https://user@github.com/ismailakdag/fairbeam-releases/issues/new/choose",
               "https://github.com/ismailakdag/fairbeam/issues/new/choose",
               base, base + "/choose?x=1", base + "?template=other.yml", base + "?template=bug.yml&email=a@b.c",
               base + "?template=bug.yml&os=Linux", base + "?template=bug.yml&version=0.3.0&version=0.2.0",
               base + "?template=bug.yml#x", "file:///etc/passwd", 42, None]
        with mock.patch("webbrowser.open", return_value=True) as opener:
            for url in good:
                status, body = self.request("POST", "/api/open-feedback", {"url": url})
                self.assertEqual((status, body), (200, {"opened": True}), url)
            self.assertEqual([c.args[0] for c in opener.call_args_list], good)
            opener.reset_mock()
            for url in bad:
                status, _ = self.request("POST", "/api/open-feedback", {"url": url})
                self.assertEqual(status, 422, url)
            opener.assert_not_called()
            status, _ = self.request("GET", "/api/open-feedback")
            self.assertEqual(status, 405)  # no GET side effects
            opener.assert_not_called()

    def test_health_says_whether_the_desktop_shell_started_the_server(self):
        os.environ.pop("FAIRBEAM_SHUTDOWN_TOKEN", None)
        self.assertFalse(self.request("GET", "/api/health")[1]["desktop"])
        with mock.patch.dict(os.environ, {"FAIRBEAM_SHUTDOWN_TOKEN": "s3cret"}):
            self.assertTrue(self.request("GET", "/api/health")[1]["desktop"])

    def test_health(self):
        status, h = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        from fairbeam._meta import __version__
        self.assertEqual(h["fairbeam"], __version__)
        self.assertIn("openems", h)
        self.assertGreaterEqual(h["cpu_count"], 1)
        self.assertEqual(h["models_dir"], str(MODELS.resolve()))
        self.assertIn("cpu", h["engines"])
        self.assertEqual(h["python_executable"], sys.executable)

    def test_models(self):
        status, body = self.request("GET", "/api/models")
        self.assertEqual(status, 200)
        dipole = next(m for m in body["models"] if m["key"] == "dipole")
        self.assertEqual(dipole["model"]["id"], "dipole")
        length = next(p for p in dipole["params"] if p["key"] == "length")
        self.assertEqual(length, {"key": "length", "default": 58.0, "label": "Total length", "unit": "mm",
                                  "description": "", "minimum": 5, "maximum": 1000, "type": "float"})
        self.assertNotIn("path", dipole)

    def test_broken_model_is_an_error_entry(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "good.py").write_text((MODELS / "dipole.py").read_text(encoding="utf-8"))
            (Path(d) / "broken.py").write_text("import sys\nsys.exit('nope')\n")
            (Path(d) / "incomplete.py").write_text("MODEL = {}\n")
            from fairbeam.server import ModelRegistry
            models = {m["key"]: m for m in ModelRegistry(Path(d), sys.executable).list()}
            self.assertIn("params", models["good"])
            self.assertIn("SystemExit", models["broken"]["error"])
            self.assertIn("does not define PARAMS", models["incomplete"]["error"])

    def test_registry_describes_in_the_preview_worker(self):
        from fairbeam.server import ModelRegistry, PreviewWorker
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "good.py").write_text((MODELS / "dipole.py").read_text(encoding="utf-8"))
            (Path(d) / "broken.py").write_text("import sys\nsys.exit('nope')\n")
            worker = PreviewWorker(sys.executable)
            try:
                via_worker = ModelRegistry(Path(d), sys.executable, worker=worker).list()
                self.assertIsNotNone(worker.proc)   # described there, not in a new child
                self.assertEqual(via_worker, ModelRegistry(Path(d), sys.executable).list())
                self.assertIn("SystemExit", {m["key"]: m for m in via_worker}["broken"]["error"])
            finally:
                worker.stop()

    def test_preview_real_geometry(self):
        t0 = time.time()
        status, a = self.request("POST", "/api/preview", {"model": "dipole", "params": {"length": 58}})
        self.assertEqual(status, 200, a)
        status, b = self.request("POST", "/api/preview", {"model": "dipole", "params": {"length": 80}})
        self.assertEqual(status, 200, b)
        self.assertLess(time.time() - t0, 10)
        self.assertLess(b["elapsed_s"], 1.0)
        self.assertEqual(b["overrides"], {"length": "80"})
        bundle = b["bundle"]
        self.assertEqual(bundle["schema"], "fairbeam.project/1")
        self.assertTrue(bundle["preview"])
        self.assertIsNone(bundle["results"])
        self.assertIsNone(bundle["run"])
        z_extent = lambda bb: max(p["bbox"][1][2] for p in bb["parts"]) - min(p["bbox"][0][2] for p in bb["parts"])
        self.assertAlmostEqual(z_extent(a["bundle"]), 58.0)
        self.assertAlmostEqual(z_extent(bundle), 80.0)
        self.assertEqual(list(Path(self.app.projects_dir).glob("dipole*")), [])  # nothing written

    def test_preview_validation(self):
        status, body = self.request("POST", "/api/preview", {"model": "dipole", "params": {"length": 1, "x": 2}})
        self.assertEqual(status, 422)
        self.assertEqual(body["fields"]["length"], "must be at least 5 mm")
        self.assertIn("x", body["fields"])
        status, body = self.request("POST", "/api/preview", {"model": "../etc/passwd", "params": {}})
        self.assertEqual(status, 404)

    def test_guards(self):
        status, body = self.request("GET", "/api/health", headers={"Host": "evil.example:5320"})
        self.assertEqual(status, 403)
        status, _ = self.request("POST", "/api/runs", {"model": "dipole"}, headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        status, _ = self.request("GET", "/api/health", headers={"Origin": "http://localhost:5313"})
        self.assertEqual(status, 200)
        status, _ = self.request("POST", "/api/runs", {"model": "dipole"}, headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)
        status, body = self.request("POST", "/api/runs", None, headers={"Content-Type": "text/plain"})
        self.assertEqual(status, 415)
        status, _ = self.request("OPTIONS", "/api/runs")
        self.assertEqual(status, 405)
        status, _ = self.request("GET", "/api/preview")
        self.assertEqual(status, 405)
        status, _ = self.request("GET", "/api/nothing")
        self.assertEqual(status, 404)

    def test_run_settings_validation(self):
        status, body = self.request("POST", "/api/runs", {"model": "dipole", "params": {}, "threads": 0,
                                                          "name": "!!!", "end_criteria_db": 5, "engine": "warp",
                                                          "points": 3})
        self.assertEqual(status, 422)
        self.assertEqual(set(body["fields"]), {"threads", "name", "end_criteria_db", "engine", "points"})

    def test_gpu_settings_normalize_threads(self):
        original = self.app.engines
        self.app.engines = ["cpu", "gpu"]
        try:
            errors = {}
            settings = self.app._settings({"engine": "gpu", "threads": 0}, errors)
            self.assertEqual(settings["threads"], 1)
            self.assertNotIn("threads", errors)
        finally:
            self.app.engines = original

    def test_auto_threads_setting(self):
        a = self.app
        saved = (a.cpu, a.physical)
        try:
            a.cpu, a.physical = 64, 32
            for body, expected in (({"threads": "auto"}, 4), ({}, 4), ({"threads": 64}, 64), ({"threads": None, "cells": 1_000_000}, 8),
                                   ({"threads": "auto", "cells": 20e6}, 12), ({"threads": 6}, 6)):
                errors = {}
                self.assertEqual(a._settings(body, errors)["threads"], expected, body)
                self.assertEqual(errors, {})
            errors = {}
            a._settings({"threads": 65}, errors)
            self.assertIn("threads", errors)
            errors = {}
            a._settings({"threads": "many"}, errors)
            self.assertIn("threads", errors)
            a.cpu, a.physical = 2, 1  # restricted affinity
            self.assertEqual(a._settings({"threads": "auto", "cells": 20e6}, {})["threads"], 1)
        finally:
            a.cpu, a.physical = saved

    def test_health_reports_resources(self):
        h = self.request("GET", "/api/health")[1]
        self.assertGreaterEqual(h["physical_cores"], 1)
        self.assertLessEqual(h["physical_cores"], h["cpu_count"])
        self.assertIn("throughput", h)
        self.assertIn("memory_free_bytes", h)

    def test_preflight_endpoint_and_refusal(self):
        with mock.patch("fairbeam.resources.free_memory_bytes", return_value=2 * 2 ** 30), \
                mock.patch("fairbeam.resources.host_load", return_value=0.1):
            status, pre = self.request("POST", "/api/preflight", {"cells": 1e6, "engine": "cpu"})
            self.assertEqual(status, 200)
            self.assertIn(pre["level"], ("ok", "warn"))  # warn only if another test's job is still running
            self.assertFalse(any("GiB" in m for m in pre["messages"]))
            status, pre = self.request("POST", "/api/preflight", {"cells": 30e6})
            self.assertEqual((status, pre["level"]), (200, "refuse"))
            before = len(self.app.manager.list())
            status, body = self.request("POST", "/api/runs", {"model": "dipole", "params": {}, "threads": 1, "cells": 30e6})
            self.assertEqual(status, 422)
            self.assertEqual(body["preflight"]["level"], "refuse")
            self.assertEqual(len(self.app.manager.list()), before, "a refused run is never queued")
        with mock.patch("fairbeam.resources.free_memory_bytes", return_value=None):
            self.assertEqual(self.request("POST", "/api/preflight", {"cells": 1e6})[1]["level"], "unknown")
        status, _ = self.request("POST", "/api/preflight", {"engine": "warp"})
        self.assertEqual(status, 422)

    def test_run_end_criterion_request_to_job(self):
        """An explicit end criterion reaches the child as --end-db; absent or null leaves the model's
        own (no --end-db, and no -40 substituted); an invalid one is refused before queuing."""
        end_db_args = lambda job_id: [a for a in self.app.manager.default_command(self.app.manager.get(job_id))  # noqa: E731
                                      if a.startswith("--end-db")]
        cases = (({"end_criteria_db": -10}, -10.0), ({"end_criteria_db": -60.0}, -60.0), ({}, None),
                 ({"end_criteria_db": None}, None))
        for extra, requested in cases:
            status, job = self.request("POST", "/api/runs", {"model": "dipole", "params": {"length": 61}, "threads": 1,
                                                             **extra})
            self.assertEqual(status, 201, (extra, job))
            self.assertEqual(job["requested_end_criteria_db"], requested, extra)
            self.assertEqual(job["end_criteria_db"], requested, extra)
            self.assertEqual(end_db_args(job["id"]), [f"--end-db={requested!r}"] if requested is not None else [], extra)
            self.wait_terminal(job["id"])
        before = len(self.app.manager.list())
        for bad in (0, 5, -301, -1e400, True, "-30", [-30]):
            status, body = self.request("POST", "/api/runs", {"model": "dipole", "params": {}, "threads": 1,
                                                              "end_criteria_db": bad})
            self.assertEqual(status, 422, (bad, body))
            self.assertEqual(set(body["fields"]), {"end_criteria_db"}, bad)
        self.assertEqual(len(self.app.manager.list()), before)
        # every run of a sweep carries it, or none does
        for extra, expected in (({"end_criteria_db": -10}, ["--end-db=-10.0"]), ({}, [])):
            status, body = self.request("POST", "/api/sweeps", {"model": "dipole", "params": {}, "threads": 1,
                                                                "sweep": [{"key": "length", "values": [57, 59]}],
                                                                **extra})
            self.assertEqual(status, 201, body)
            for r in body["runs"]:
                self.assertEqual(end_db_args(r["id"]), expected, extra)
                self.wait_terminal(r["id"], timeout=30)

    def test_run_and_events_stream(self):
        status, job = self.request("POST", "/api/runs", {"model": "dipole", "params": {"length": 60}, "threads": 1})
        self.assertEqual(status, 201, job)
        self.assertEqual(job["status"], "queued")
        self.assertEqual(job["overrides"], {"length": "60"})
        status, raw = self.request("GET", f"/api/runs/{job['id']}/events", raw=True)
        self.assertEqual(status, 200)
        events, _ = parse_sse(raw)
        self.assertEqual([e["seq"] for e in events], list(range(1, len(events) + 1)))
        self.assertEqual(events[-1]["type"], "status")
        self.assertEqual(events[-1]["status"], "done")
        self.assertEqual(events[-1]["bundle"], "fake-dipole.json")
        self.assertTrue(all(e["_event"] == e["type"] and e["_id"] == str(e["seq"]) for e in events))
        self.assertIn("progress", {e["type"] for e in events})
        # replay after a given event id (EventSource reconnect)
        status, raw = self.request("GET", f"/api/runs/{job['id']}/events", headers={"Last-Event-ID": "5"}, raw=True)
        replay, _ = parse_sse(raw)
        self.assertEqual(replay[0]["seq"], 6)
        status, runs = self.request("GET", "/api/runs")
        self.assertIn(job["id"], [r["id"] for r in runs["runs"]])
        status, log = self.request("GET", f"/api/runs/{job['id']}/log", raw=True)
        self.assertIn("fairbeam: wrote", log)
        index = json.loads((Path(self.app.projects_dir) / "index.json").read_text(encoding="utf-8"))
        self.assertIn("fake-dipole.json", [p["file"] for p in index["projects"]])

    def test_save_best_optimization_bundle(self):
        from fairbeam.jobs import Job

        source = Path(self.app.projects_dir) / "optimizations" / "saved" / "eval.json"
        source.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"schema": "fairbeam.project/1", "name": "best", "model": {"id": "dipole"},
                              "created": "today", "results": {"bands": []}, "mesh": {}}).encode()
        source.write_bytes(payload)
        job = Job(self.app.manager.root, id="20260101-000000-best01", kind="optimize", name="save-test",
                  status="done", finished=time.time(), stats={"best_file": "optimizations/saved/eval.json"})
        job.save()
        self.app.manager.jobs[job.id] = job
        status, result = self.request("POST", f"/api/optimizations/{job.id}/save-best", {})
        self.assertEqual(status, 201, result)
        copied = Path(self.app.projects_dir) / result["file"]
        self.assertEqual(copied.read_bytes(), payload)
        index = json.loads((Path(self.app.projects_dir) / "index.json").read_text(encoding="utf-8"))
        self.assertIn(result["file"], [item["file"] for item in index["projects"]])

    def test_save_best_rejects_unfinished_optimization(self):
        from fairbeam.jobs import Job

        job = Job(self.app.manager.root, id="20260101-000000-open01", kind="optimize", status="running")
        job.save()
        self.app.manager.jobs[job.id] = job
        status, body = self.request("POST", f"/api/optimizations/{job.id}/save-best", {})
        self.assertEqual(status, 409, body)

    def test_events_of_a_trimmed_finished_job(self):
        status, job = self.request("POST", "/api/runs", {"model": "dipole", "params": {"length": 63}, "threads": 1})
        job = self.wait_terminal(job["id"])
        job.MEMORY_EVENTS = 8  # the fake run is short: keep only its last 8 events in memory
        job.trim_events()
        total = job.last_seq
        self.assertEqual(job.memory_floor, total - 8)
        self.assertLess(len(job.events), total)
        # a fresh client gets the whole run, read back from events.jsonl, then the end marker
        status, raw = self.request("GET", f"/api/runs/{job.id}/events", raw=True)
        events, comments = parse_sse(raw)
        self.assertEqual([e["seq"] for e in events], list(range(1, total + 1)))
        self.assertEqual(comments[-1], "end")
        self.assertEqual(events[-1]["status"], "done")
        # reconnects before and inside the in-memory tail
        for last in (3, total - 4, total):
            status, raw = self.request("GET", f"/api/runs/{job.id}/events", headers={"Last-Event-ID": str(last)},
                                       raw=True)
            events, comments = parse_sse(raw)
            self.assertEqual([e["seq"] for e in events], list(range(last + 1, total + 1)), last)
            self.assertEqual(comments[-1], "end")
        status, body = self.request("GET", f"/api/runs/{job.id}")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "done")
        self.assertNotIn("events", body)

    def wait_terminal(self, job_id, timeout=15):
        t0 = time.time()
        while time.time() - t0 < timeout:
            job = self.app.manager.get(job_id)
            if job is not None and job.terminal:
                return job
            time.sleep(0.05)
        self.fail(f"job {job_id} did not finish")

    def test_unnamed_run_names_preserve_parameters_until_collision(self):
        manager = JobManager(self.app.manager.root / "naming", self.app.manager.projects_dir, autostart=False)
        for model_path, sweep in (("dipole.py", None),
                                  ("dipole.py", {"id": "sw-test", "index": 0, "total": 1}),
                                  ("dipole.design.json", {"id": "sw-design", "index": 0, "total": 1})):
            job = manager.submit(model="dipole", model_path=model_path, model_id="dipole",
                                 overrides={"length": "58"}, sweep=sweep)
            manager._name_run(job)
            self.assertEqual(job.name, "dipole--length-58")
            target = manager.projects_dir / f"{job.name}.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("{}", encoding="utf-8")
            try:
                other = manager.submit(model="dipole", model_path=model_path, model_id="dipole",
                                       overrides={"length": "58"}, sweep=sweep)
                manager._name_run(other)
                self.assertEqual(other.name, f"dipole--length-58-{other.id}")
            finally:
                target.unlink()

    def test_unnamed_designer_runs_get_distinct_names(self):
        jobs = [self.app.manager.submit(model="patch", model_path="patch.design.json") for _ in range(2)]
        self.assertNotEqual(jobs[0].name, jobs[1].name)
        self.assertTrue(all(j.name.startswith("patch-") for j in jobs))

    def test_named_run(self):
        status, job = self.request("POST", "/api/runs", {"model": "dipole", "params": {}, "threads": 1,
                                                         "name": "Dipole baseline 58 mm"})
        self.assertEqual(status, 201, job)
        self.assertEqual(job["label"], "Dipole baseline 58 mm")
        self.assertEqual(job["name"], "dipole-baseline-58-mm")
        cmd = self.app.manager.default_command(self.app.manager.get(job["id"]))
        self.assertEqual(cmd[-2:], ["--name", "dipole-baseline-58-mm"])
        self.assertEqual(cmd[cmd.index("--label") + 1], "Dipole baseline 58 mm", "the typed name is the bundle's name")
        self.wait_terminal(job["id"])

    def test_sweep_endpoint(self):
        status, body = self.request("POST", "/api/sweeps", {
            "model": "dipole", "params": {"width": 1.5}, "threads": 1, "name": "Len",
            "sweep": [{"key": "length", "values": [56, 60]}, {"key": "gap", "start": 1, "stop": 2, "steps": 2}]})
        self.assertEqual(status, 201, body)
        sweep = body["sweep"]
        self.assertEqual(sweep["total"], 4)
        runs = body["runs"]
        self.assertEqual([r["sweep"]["index"] for r in runs], [0, 1, 2, 3])
        self.assertTrue(all(r["sweep"]["id"] == sweep["id"] for r in runs))
        self.assertEqual(runs[1]["sweep"]["values"], {"length": 56.0, "gap": 2.0})
        self.assertEqual({r["sweep"]["sequence_index"] for r in runs}, {0})
        self.assertEqual({r["sweep"]["sequence_name"] for r in runs}, {"Sweep"})
        self.assertEqual(runs[1]["overrides"], {"length": "56", "gap": "2", "width": "1.5"})
        self.assertEqual(runs[1]["name"], "len--length-56--gap-2")
        for r in runs:
            self.wait_terminal(r["id"], timeout=30)
        status, body = self.request("POST", "/api/sweeps", {"model": "dipole", "params": {},
                                                            "sweep": [{"key": "length", "start": 6, "stop": 60, "steps": 26}]})
        self.assertEqual(status, 422)
        self.assertIn("length", body["fields"])

    def test_ordered_sweep_sequences_endpoint_and_atomic_validation(self):
        status, body = self.request("POST", "/api/sweeps", {
            "model": "dipole", "params": {}, "threads": 1,
            "sequences": [{"name": "short", "sweep": [{"key": "length", "values": [56, 58]}]},
                          {"name": "long", "sweep": [{"key": "length", "start": 60, "stop": 62, "steps": 2}]}]})
        self.assertEqual(status, 201, body)
        self.assertEqual(body["sweep"]["total"], 4)
        self.assertEqual([s["name"] for s in body["sweep"]["sequences"]], ["short", "long"])
        self.assertEqual([r["sweep"]["sequence_index"] for r in body["runs"]], [0, 0, 1, 1])
        self.assertEqual([r["sweep"]["sequence_name"] for r in body["runs"]], ["short", "short", "long", "long"])
        before = len(self.app.manager.list())
        status, err = self.request("POST", "/api/sweeps", {
            "model": "dipole", "params": {},
            "sequences": [{"name": "valid", "sweep": [{"key": "length", "values": [56]}]},
                          {"name": "invalid", "sweep": [{"key": "missing", "values": [1]}]}]})
        self.assertEqual(status, 422, err)
        self.assertEqual(len(self.app.manager.list()), before)
        # an oversized request (many 25-run sequences, under the 1 MB body limit) is refused fast
        many = [{"name": f"s{i}", "sweep": [{"key": "length", "start": 50, "stop": 70, "steps": 25}]}
                for i in range(5000)]
        t0 = time.time()
        status, err = self.request("POST", "/api/sweeps", {"model": "dipole", "params": {}, "sequences": many})
        self.assertLess(time.time() - t0, 2.0)
        self.assertEqual(status, 422, err)
        self.assertIn("sequences", err["fields"])
        status, err = self.request("POST", "/api/sweeps", {"model": "dipole", "params": {}, "sequences": many[:30]})
        self.assertEqual(status, 422, err)
        self.assertIn("at most 500", err["fields"]["sequences"])
        self.assertEqual(len(self.app.manager.list()), before)

    def test_cancel_sweep_and_delete(self):
        status, body = self.request("POST", "/api/sweeps", {
            "model": "dipole", "params": {"gap": 0.5}, "threads": 1,  # gap=0.5 -> the fake child hangs
            "sweep": [{"key": "length", "values": [56, 58, 60]}]})
        self.assertEqual(status, 201, body)
        ids = [r["id"] for r in body["runs"]]
        t0 = time.time()
        while self.app.manager.get(ids[0]).status != "running" and time.time() - t0 < 10:
            time.sleep(0.05)
        status, res = self.request("POST", f"/api/sweeps/{body['sweep']['id']}/cancel", {})
        self.assertEqual(status, 202)
        for i in ids:
            self.assertEqual(self.wait_terminal(i).status, "cancelled")
        status, _ = self.request("POST", "/api/sweeps/sw-nope/cancel", {})
        self.assertEqual(status, 404)

        # delete removes the history entry only
        folder = self.app.manager.get(ids[0]).dir
        status, res = self.request("POST", f"/api/runs/{ids[0]}/delete", {})
        self.assertEqual(status, 200, res)
        self.assertEqual(res, {"deleted": ids[0], "bundle_deleted": None, "sim_deleted": None, "sim_freed_bytes": 0})
        self.assertFalse(folder.exists())
        self.assertNotIn(ids[0], [r["id"] for r in self.request("GET", "/api/runs")[1]["runs"]])
        status, _ = self.request("POST", f"/api/runs/{ids[0]}/delete", {})
        self.assertEqual(status, 404)

    def test_delete_bundle_rules(self):
        status, job = self.request("POST", "/api/runs", {"model": "dipole", "params": {"length": 61}, "threads": 1})
        job = self.wait_terminal(job["id"])
        bundle = Path(self.app.projects_dir) / job.bundle
        self.assertTrue(bundle.exists())
        status, res = self.request("POST", f"/api/runs/{job.id}/delete", {"delete_bundle": True})
        self.assertEqual(status, 200, res)
        self.assertEqual(res["bundle_deleted"], "fake-dipole.json")
        self.assertFalse(bundle.exists())
        # a job whose bundle points outside the projects folder: refused, history kept
        status, job = self.request("POST", "/api/runs", {"model": "dipole", "params": {"length": 62}, "threads": 1})
        job = self.wait_terminal(job["id"])
        outside = Path(self.tmp.name) / "outside.json"
        outside.write_text("{}")
        job.bundle = "../outside.json"
        status, res = self.request("POST", f"/api/runs/{job.id}/delete", {"delete_bundle": True})
        self.assertEqual(status, 409)
        self.assertTrue(outside.exists())
        self.assertIsNotNone(self.app.manager.get(job.id))

    def test_delete_running_is_refused(self):
        status, job = self.request("POST", "/api/runs", {"model": "dipole", "params": {"gap": 0.5}, "threads": 1})
        t0 = time.time()
        while self.app.manager.get(job["id"]).status != "running" and time.time() - t0 < 10:
            time.sleep(0.05)
        status, res = self.request("POST", f"/api/runs/{job['id']}/delete", {})
        self.assertEqual(status, 409)
        self.request("POST", f"/api/runs/{job['id']}/cancel", {})
        self.wait_terminal(job["id"])

    def test_heartbeat_and_cancel(self):
        status, job = self.request("POST", "/api/runs", {"model": "dipole", "params": {"gap": 0.5}, "threads": 1})
        self.assertEqual(status, 201)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", f"/api/runs/{job['id']}/events", headers={"Host": f"127.0.0.1:{self.port}"})
        r = conn.getresponse()
        self.assertEqual(r.getheader("Content-Type"), "text/event-stream; charset=utf-8")
        buf = b""
        t0 = time.time()
        while b": keepalive" not in buf and time.time() - t0 < 8:
            buf += r.read1(4096)
        self.assertIn(b": keepalive", buf)
        status, body = self.request("POST", f"/api/runs/{job['id']}/cancel", {})
        self.assertEqual(status, 202)
        while b'"status":"cancelled"' not in buf and time.time() - t0 < 15:
            chunk = r.read1(4096)
            if not chunk:
                break
            buf += chunk
        conn.close()
        self.assertIn(b'"status":"cancelled"', buf)
        status, body = self.request("POST", f"/api/runs/{job['id']}/cancel", None, headers={"Content-Type": "text/plain"})
        self.assertEqual(status, 415)  # cancel needs a JSON POST, too


if __name__ == "__main__":
    unittest.main()
