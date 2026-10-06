"""POST /api/optimizations: validation, the optimize job (command line, per-evaluation events,
done summary) and cancel, with a fake child process (no openEMS)."""

import http.client
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from fairbeam.jobs import JobManager  # noqa: E402
from fairbeam.progress import ProgressParser  # noqa: E402
from fairbeam.server import App, make_server  # noqa: E402

MODELS = HERE.parent / "models"
FAKE = str(HERE / "fake_openems.py")


class Parser(unittest.TestCase):
    def test_optimize_lines(self):
        p = ProgressParser()
        ev = p.feed('fairbeam: optimize start {"name":"x","max_evals":5}')
        self.assertEqual([e["type"] for e in ev], ["phase", "opt_start"])
        ev = p.feed('fairbeam: optimize eval {"index":1,"params":{"a":1},"cost":2.5,"best_index":1,"best_cost":2.5}')
        self.assertEqual(ev[0]["type"], "opt_eval")
        self.assertEqual(ev[0]["params"], {"a": 1})
        p.feed('fairbeam: optimize done {"reason":"goals met","evaluations":1}')
        self.assertEqual(p.opt_done["reason"], "goals met")
        self.assertEqual(p.feed("fairbeam: optimization written to /x/y.json"), [])
        self.assertNotIn("label", p.info)


class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        (root / "projects").mkdir()
        cls.commands = []

        def factory(job):
            cls.commands.append(cls.manager.optimize_command(job) if job.kind == "optimize" else None)
            mode = "hang" if job.params.get("gap") == 0.5 else ("opt" if job.kind == "optimize" else "ok")
            return [sys.executable, FAKE, mode, str(root / "projects")]

        cls.manager = JobManager(root / "jobs", root / "projects", python="/py", grace_s=1.0, command_factory=factory)
        cls.app = App(models_dir=MODELS, projects_dir=root / "projects", jobs_dir=root / "jobs", manager=cls.manager)
        cls.srv = make_server(cls.app, "127.0.0.1", 0, quiet=True)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
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
        conn.close()
        return r.status, (payload.decode() if raw else json.loads(payload or b"null"))

    def wait(self, job_id, timeout=15):
        t0 = time.time()
        while time.time() - t0 < timeout:
            j = self.manager.get(job_id)
            if j.terminal:
                return j
            time.sleep(0.05)
        self.fail("job did not finish")

    BODY = {"model": "dipole", "params": {"width": 1.5}, "threads": 2, "max_evals": 10,
            "vary": [{"key": "length", "min": 50, "max": 66}], "goals": [{"kind": "f0", "target": 2.4}]}

    def test_validation(self):
        bad = [
            ({"vary": []}, "vary"),
            ({"vary": [{"key": "boundary", "min": 1, "max": 2}]}, "vary.0"),
            ({"vary": [{"key": "length", "min": 66, "max": 50}]}, "vary.0"),
            ({"vary": [{"key": "length", "min": 1, "max": 50}]}, "vary.0"),  # below the parameter minimum (5)
            ({"vary": [{"key": "length", "min": 50, "max": 66, "start": 70}]}, "vary.0"),
            ({"goals": [{"kind": "s11_max", "target": -20}]}, "goals.0"),  # needs a frequency
            ({"goals": [{"kind": "gain", "target": 3}]}, "goals.0"),
            ({"max_evals": 41}, "max_evals"),
            ({"method": "secant", "vary": [{"key": "length", "min": 50, "max": 66}, {"key": "gap", "min": 0.5, "max": 2}]},
             "method"),
        ]
        for patch, field in bad:
            status, body = self.request("POST", "/api/optimizations", {**self.BODY, **patch})
            self.assertEqual(status, 422, (patch, body))
            self.assertIn(field, body["fields"], (patch, body))

    def test_run_events_and_command(self):
        status, job = self.request("POST", "/api/optimizations", {**self.BODY, "name": "Length for 2.4 GHz", "engine": "cpu",
                                                                  "goals": [{"kind": "f0", "target": 2.4},
                                                                            {"kind": "s11_max", "target": -20, "at": 2.4, "weight": 2}]})
        self.assertEqual(status, 201, job)
        self.assertEqual(job["kind"], "optimize")
        self.assertEqual(job["optimize"]["max_evals"], 10)
        done = self.wait(job["id"])
        self.assertEqual(done.status, "done", done.error)
        self.assertEqual(done.stats["reason"], "max evaluations")
        self.assertEqual(done.stats["best_params"], {"length": 58.36})
        self.assertIsNone(done.bundle)  # optimization members stay out of the project index
        cmd = self.commands[-1]
        self.assertEqual(cmd[:5], ["/py", "-m", "fairbeam", "optimize", str((MODELS / "dipole.py").resolve())])
        self.assertIn("--vary", cmd)
        self.assertEqual(cmd[cmd.index("--vary") + 1], "length=50.0:66.0")
        goals = [cmd[i + 1] for i, a in enumerate(cmd) if a == "--goal"]
        self.assertEqual(goals, ["f0=2.4", "s11_max=-20.0@2.4*2.0"])
        self.assertEqual(cmd[cmd.index("--set") + 1], "width=1.5")
        self.assertEqual(cmd[cmd.index("--name") + 1], "length-for-2.4-ghz")
        status, raw = self.request("GET", f"/api/runs/{job['id']}/events", raw=True)
        types = [json.loads(line[6:])["type"] for line in raw.splitlines() if line.startswith("data: ")]
        self.assertEqual(types.count("opt_eval"), 3)
        self.assertIn("opt_start", types)
        self.assertIn("opt_done", types)
        self.assertEqual(types[-1], "status")

    def test_end_criterion(self):
        for extra, expected in (({"end_criteria_db": -30}, ["--end-db=-30.0"]), ({}, [])):
            status, job = self.request("POST", "/api/optimizations", {**self.BODY, **extra})
            self.assertEqual(status, 201, job)
            self.wait(job["id"])
            self.assertEqual([a for a in self.commands[-1] if a.startswith("--end-db")], expected, extra)
        status, body = self.request("POST", "/api/optimizations", {**self.BODY, "end_criteria_db": 0})
        self.assertEqual(status, 422, body)
        self.assertIn("end_criteria_db", body["fields"])

    def test_multiport_goals(self):
        body = {**self.BODY, "excite": "1,3", "goals": [
            {"kind": "sij_max", "target": -25, "at": 2.4, "ports": [2, 3]},
            {"kind": "match_all", "target": -20, "at": 2.4}]}
        status, job = self.request("POST", "/api/optimizations", body)
        self.assertEqual(status, 201, job)
        self.assertEqual(job["optimize"]["goals"][0]["ports"], [2, 3])
        self.wait(job["id"])
        cmd = self.commands[-1]
        goals = [cmd[i + 1] for i, a in enumerate(cmd) if a == "--goal"]
        self.assertEqual(goals, ["sij_max=-25.0@2.4:2,3", "match_all=-20.0@2.4"])
        self.assertEqual(cmd[cmd.index("--excite") + 1], "1,3")
        for bad in ({"goals": [{"kind": "sij_max", "target": -25, "at": 2.4}]},
                    {"goals": [{"kind": "sij_max", "target": -25, "at": 2.4, "ports": [2]}]},
                    {"goals": [{"kind": "sij_min", "target": -3, "at": 2.4, "ports": [0, 1]}]},
                    {"excite": "ports 1"}):
            status, err = self.request("POST", "/api/optimizations", {**self.BODY, **bad})
            self.assertEqual(status, 422, (bad, err))

    def test_cancel(self):
        status, job = self.request("POST", "/api/optimizations", {**self.BODY, "params": {"gap": 0.5}})
        self.assertEqual(status, 201, job)
        t0 = time.time()
        while self.manager.get(job["id"]).status != "running" and time.time() - t0 < 10:
            time.sleep(0.05)
        self.request("POST", f"/api/runs/{job['id']}/cancel", {})
        self.assertEqual(self.wait(job["id"]).status, "cancelled")


if __name__ == "__main__":
    unittest.main()
