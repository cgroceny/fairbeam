"""Real HTTP and CLI transfer paths without launching a solver."""
import copy
import hashlib
import http.client
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

from fairbeam import cli, nec
from fairbeam.jobs import JobManager
from fairbeam.server import App, make_server


class TransferApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        for name in ("models", "projects"):
            (cls.root / name).mkdir()
        manager = JobManager(cls.root / "jobs", cls.root / "projects", autostart=False)
        cls.app = App(models_dir=cls.root / "models", projects_dir=cls.root / "projects",
                      jobs_dir=cls.root / "jobs", manager=manager)
        cls.srv = make_server(cls.app, "127.0.0.1", 0, quiet=True)
        cls.port = cls.srv.server_address[1]
        cls.thread = threading.Thread(target=cls.srv.serve_forever, kwargs={"poll_interval": .1}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stopping = True
        cls.srv.shutdown()
        cls.thread.join(5)
        cls.app.close()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def post(self, body, origin=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Content-Type": "application/json"}
        if origin is not None:
            headers["Origin"] = origin
        try:
            conn.request("POST", "/api/nec/transfer", json.dumps(body), headers)
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_import_then_edit_preserves_explicit_model_without_workspace_changes(self):
        model = nec.dipole(475, .05, 31, [.3], 75)
        source = "\ufeff" + nec.deck(model).replace("\n", "\r\n")
        before = sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*"))
        with patch.object(nec, "solve", side_effect=AssertionError("must not solve")):
            status, result = self.post({"source": source, "reference_ohm": 75})
            self.assertEqual(status, 200)
            self.assertEqual(result["report"]["source_sha256"], hashlib.sha256(source.encode()).hexdigest())
            self.assertEqual(result["model"]["reference_ohm"], 75)
            self.assertIn("GW 1 31", result["deck"])
            edited = copy.deepcopy(result["model"])
            edited["wires"][0]["end_mm"][2] -= 1
            status, update = self.post({"model": edited, "pattern": True})
            self.assertEqual(status, 200)
            self.assertEqual(update["model"], edited)
            self.assertIsNone(update["report"])  # original-source hash cannot describe edited geometry
            self.assertIn("RP 0 19 37", update["deck"])
        self.assertEqual(before, sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*")))

    def test_dipole_creation_is_separate_explicit_round_wire_model(self):
        status, result = self.post({"dipole": {"length_mm": 475, "radius_mm": .05,
            "segments": 31, "frequency_ghz": [.3], "reference_ohm": 50}})
        self.assertEqual(status, 200)
        self.assertEqual(result["model"], nec.dipole(475, .05, 31, [.3]))
        self.assertEqual(result["manifest"]["deck_sha256"], hashlib.sha256(result["deck"].encode()).hexdigest())

    def test_rejects_unsupported_physics_types_and_ambiguous_requests(self):
        model = nec.dipole(475, .05, 31, [.3])
        requests = [
            {"source": nec.deck(model).replace("GN -1", "GN 1"), "reference_ohm": 50},
            {"source": nec.deck(model), "reference_ohm": True},
            {"model": model, "pattern": 1},
            {"model": model, "pattern": False, "solver": "anything"},
            {"model": {**model, "ground": True}, "pattern": False},
            {"dipole": []}, {"dipole": {"length_mm": 475}},
            {"source": None, "reference_ohm": 50}, [],
        ]
        for body in requests:
            with self.subTest(body=body):
                status, result = self.post(body)
                self.assertIn(status, (400, 422))
                self.assertIn("error", result)

    def test_foreign_origin_cannot_access_transfer(self):
        status, _ = self.post({"source": "EN", "reference_ohm": 50}, "https://untrusted.example")
        self.assertEqual(status, 403)


class TransferCli(unittest.TestCase):
    def test_actual_cli_captures_source_and_refuses_overwrite_without_solving(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "input.nec", root / "capture"
            raw = ("\ufeff"+nec.deck(nec.dipole(475, .05, 31, [.3]))).replace("\n", "\r\n").encode()
            source.write_bytes(raw)
            args = ["nec-import", str(source), "--out", str(output), "--reference-ohm", "75"]
            with patch.object(nec, "solve", side_effect=AssertionError("must not solve")):
                self.assertEqual(cli.main(args), 0)
                before = {p.name: p.read_bytes() for p in output.iterdir()}
                self.assertEqual(before["source.nec"], raw)
                self.assertEqual(json.loads(before["model.json"])["reference_ohm"], 75)
                with redirect_stderr(io.StringIO()):
                    self.assertEqual(cli.main(args), 2)
                self.assertEqual(before, {p.name: p.read_bytes() for p in output.iterdir()})

    def test_cli_rejects_bad_utf8_and_physics_before_creating_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "input.nec", root / "capture"
            for raw in (b"\xff", nec.deck(nec.dipole(475, .05, 31, [.3])).replace("EK 0", "EK -1").encode()):
                source.write_bytes(raw)
                with redirect_stderr(io.StringIO()):
                    self.assertEqual(cli.main(["nec-import", str(source), "--out", str(output)]), 2)
                self.assertFalse(output.exists())
