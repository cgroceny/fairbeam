"""Usage statistics of the run server (fairbeam.telemetry, docs/TELEMETRY.md): off by default,
closed key lists, the job counts. Uses the fake child process; no openEMS, no network."""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam import telemetry  # noqa: E402
from fairbeam.jobs import JobManager  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
SCHEMA = REPO / "api" / "_ping-schema.json"
FAKE = str(Path(__file__).resolve().parent / "fake_openems.py")
MODELS = REPO / "python" / "models"


def wait_for(pred, timeout=30.0, step=0.02):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pred():
            return True
        time.sleep(step)
    return False


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.dir = self.root / "telemetry"
        self.dir.mkdir()

    def state(self, **kw):
        (self.dir / "state.json").write_text(json.dumps(kw), encoding="utf-8")

    def counts(self) -> dict:
        path = self.dir / telemetry.FILE
        return json.loads(path.read_text(encoding="utf-8"))["days"] if path.exists() else {}

    def today(self) -> dict:
        return self.counts().get(telemetry.utc_day(), {})


class Schema(unittest.TestCase):
    @unittest.skipUnless(SCHEMA.exists(), "the repository's api/ folder is not here")
    def test_server_keys_are_the_schema_keys(self):
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
        keys = set(schema["keys"])
        self.assertLessEqual(telemetry.SERVER_KEYS, keys)
        # everything in the schema is counted somewhere: here, or by the shell (app.*)
        self.assertEqual(keys - telemetry.SERVER_KEYS, {k for k in keys if k.startswith("app.")})
        self.assertLessEqual(len(keys), schema["max_keys"])
        self.assertEqual(schema["max_value"], telemetry.MAX_VALUE)
        self.assertEqual(schema["max_age_days"], telemetry.MAX_AGE_DAYS)

    def test_keys_hold_no_free_text(self):
        for key in telemetry.SERVER_KEYS:
            self.assertRegex(key, r"^[a-z_]+(\.[a-z0-9_+-]+){1,3}$")


class Switch(Base):
    def test_off_without_the_shells_folder(self):
        self.assertIsNone(telemetry.from_env({}))
        self.assertIsNone(telemetry.from_env({"FAIRBEAM_TELEMETRY_DIR": str(self.dir), "FAIRBEAM_NO_TELEMETRY": "1"}))
        self.assertIsNotNone(telemetry.from_env({"FAIRBEAM_TELEMETRY_DIR": str(self.dir)}))
        telemetry.count(None, "monitor.far_field")  # no counters: a no-op, no error

    def test_nothing_is_written_without_consent(self):
        c = telemetry.Counters(self.dir, environ={})
        self.assertFalse(c.count("sim.started.cpu.design"))  # no state.json yet
        self.state(counting=False)
        self.assertFalse(c.count("sim.started.cpu.design"))
        self.assertFalse((self.dir / telemetry.FILE).exists())

    def test_opt_out_in_the_environment_wins(self):
        self.state(counting=True)
        c = telemetry.Counters(self.dir, environ={"FAIRBEAM_NO_TELEMETRY": "1"})
        self.assertFalse(c.count("sim.started.cpu.design"))
        self.assertFalse((self.dir / telemetry.FILE).exists())

    def test_turning_it_off_deletes_the_counts(self):
        self.state(counting=True)
        c = telemetry.Counters(self.dir, environ={})
        self.assertTrue(c.count("sim.started.cpu.design"))
        self.state(counting=False)
        self.assertFalse(c.count("sim.started.cpu.design"))
        self.assertFalse((self.dir / telemetry.FILE).exists())


class Counting(Base):
    def test_known_keys_per_utc_day(self):
        self.state(counting=True)
        c = telemetry.Counters(self.dir, environ={})
        self.assertTrue(c.count("sim.started.gpu.python"))
        self.assertTrue(c.count("sim.started.gpu.python", 2))
        for bad in ("patch_antenna", "/Users/me/x.design.json", "param.W", "sim.started.cpu.design.extra", ""):
            self.assertFalse(c.count(bad), bad)
        self.assertEqual(self.today(), {"sim.started.gpu.python": 3})
        c.count("monitor.efficiency", 10 ** 9)
        self.assertEqual(self.today()["monitor.efficiency"], telemetry.MAX_VALUE)

    def test_sent_and_old_days_are_dropped(self):
        now = time.time()
        yesterday = telemetry.utc_day(now - 86400)
        old = telemetry.utc_day(now - 40 * 86400)
        (self.dir / telemetry.FILE).write_text(json.dumps({"days": {
            old: {"sim.started.cpu.design": 1}, yesterday: {"sim.started.cpu.design": 1}}}), encoding="utf-8")
        self.state(counting=True, sent_through=yesterday)
        telemetry.Counters(self.dir, environ={}).count("sim.started.cpu.design")
        self.assertEqual(set(self.counts()), {telemetry.utc_day(now)})

    def test_day_rollover(self):
        self.state(counting=True)
        t = [1_790_553_599.0]  # 2026-09-27 23:59:59 UTC
        c = telemetry.Counters(self.dir, clock=lambda: t[0], environ={})
        c.count("sim.started.cpu.design")
        t[0] += 1
        c.count("sim.started.cpu.design")
        self.assertEqual(self.counts(), {"2026-09-27": {"sim.started.cpu.design": 1},
                                         "2026-09-28": {"sim.started.cpu.design": 1}})


class Buckets(unittest.TestCase):
    def test_sources(self):
        self.assertEqual(telemetry.source_of("/w/models/my_patch.design.json"), "design")
        self.assertEqual(telemetry.source_of("/w/models/my_model.py"), "python")
        self.assertEqual(telemetry.source_of("/w/models/patch_antenna.py"), "example")
        self.assertEqual(telemetry.source_of("/w/models/dipole.design.json"), "example")

    def test_ranges(self):
        self.assertEqual([telemetry.duration_bucket(s) for s in (0, 9.9, 10, 59, 60, 599, 600, 1e6)],
                         ["lt10s", "lt10s", "10-60s", "10-60s", "1-10min", "1-10min", "gt10min", "gt10min"])
        self.assertEqual([telemetry.cells_bucket(n) for n in (None, True, 0, 78000, 100_000, 1_000_000, 2_000_000)],
                         [None, None, None, "lt100k", "100k-1m", "100k-1m", "gt1m"])
        self.assertEqual([telemetry.sweep_bucket(n) for n in (1, 5, 6, 20, 21, 100, 101, 500)],
                         ["1-5", "1-5", "6-20", "6-20", "21-100", "21-100", "gt100", "gt100"])

    def test_failure_categories_are_codes(self):
        cases = {
            ("failed", "could not start: [Errno 2] No such file: '/Users/me/python'", 1): "start",
            ("failed", "internal error: KeyError: 'x'", None): "server",
            ("failed", "MemoryError", 1): "memory",
            ("failed", "std::bad_alloc", -6): "memory",
            ("failed", "CUDA error: out of resources", 1): "gpu",
            ("failed", "the mesh has 40000000 cells, over the limit", 1): "mesh-cells",
            ("failed", "DesignError: parts[2].size: W/0", 1): "design",
            ("failed", "the run exited without writing a bundle", 0): "no-result",
            ("failed", "exit code -11", -11): "crash",
            ("failed", "openEMS: error in FDTD engine", 1): "solver",
            ("failed", "something else about my_secret_design", 1): "other",
            ("interrupted", "server stopped", None): "interrupted",
        }
        for (status, error, code), want in cases.items():
            got = telemetry.failure_category(status, error, code)
            self.assertEqual(got, want, error)
            self.assertIn(got, telemetry.FAILURES)

    def test_refusals(self):
        self.assertEqual(telemetry.refusal_category([{"code": "mesh-cells", "severity": "error"}]), "mesh-cells")
        self.assertEqual(telemetry.refusal_category([{"code": "port-outside", "severity": "error"}]), "design-check")

    def test_design_monitors(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "x.design.json"
            path.write_text(json.dumps({"monitors": {"currents": ["f0"], "efficiency": {"points": 21},
                                                     "field_planes": [{"quantity": "E"}]}}), encoding="utf-8")
            self.assertEqual(telemetry.design_monitors(str(path)),
                             ["far_field", "surface_current", "efficiency", "field_planes"])
            path.write_text(json.dumps({"far_field": {"enabled": False}}), encoding="utf-8")
            self.assertEqual(telemetry.design_monitors(str(path)), [])
            self.assertEqual(telemetry.design_monitors(str(Path(tmp) / "missing.json")), [])

    def test_optimizer_jobs_count_as_optimizer_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "state.json").write_text('{"counting": true}', encoding="utf-8")
            c = telemetry.Counters(d, environ={})
            job = SimpleNamespace(kind="optimize", status="done", engine="cpu", model_path="/w/m.py")
            telemetry.job_started(c, job)
            telemetry.job_finished(c, job)
            job.status = "failed"
            telemetry.job_finished(c, job)
            days = json.loads((d / telemetry.FILE).read_text(encoding="utf-8"))["days"]
            self.assertEqual(days[telemetry.utc_day()], {"optimize.finished": 1, "optimize.failed": 1})


class Jobs(Base):
    """The hooks on a real JobManager with the fake child."""

    def manager(self, mode):
        m = JobManager(self.root / "jobs", self.root / "projects", grace_s=1.0,
                       command_factory=lambda job: [sys.executable, FAKE, mode, str(self.root / "projects")])
        self.addCleanup(m.shutdown, 5)
        c = telemetry.Counters(self.dir, environ={})
        self.counted = threading.Event()

        def finished(job):
            telemetry.job_finished(c, job)
            self.counted.set()

        m.on_started = lambda job: telemetry.job_started(c, job)
        m.on_finished = finished  # runs after job.terminal turns true: wait for it, not for that
        return m

    def run_one(self, mode, engine="cpu"):
        m = self.manager(mode)
        job = m.submit(model="dipole", model_path="/nonexistent/dipole.py", model_id="dipole",
                       params={}, overrides={"length": "60"}, threads=2, engine=engine)
        self.assertTrue(wait_for(lambda: job.terminal))
        self.assertTrue(self.counted.wait(30))
        return job

    def test_finished_run(self):
        self.state(counting=True)
        job = self.run_one("ok")
        self.assertEqual(job.status, "done", job.error)
        self.assertEqual(self.today(), {"sim.started.cpu.example": 1, "sim.finished.cpu.example": 1,
                                        "sim.duration.lt10s": 1, "sim.cells.lt100k": 1})

    def test_failed_run(self):
        self.state(counting=True)
        job = self.run_one("fail", engine="gpu")
        self.assertEqual(job.status, "failed")
        counts = self.today()
        self.assertEqual(counts.pop("sim.started.gpu.example"), 1)
        (key, n), = counts.items()
        self.assertEqual(n, 1)
        self.assertRegex(key, r"^sim\.failed\.gpu\.[a-z-]+$")
        self.assertIn(key.rsplit(".", 1)[1], telemetry.FAILURES)
        # what is stored is keys and numbers only: nothing of the job's error or paths
        text = (self.dir / telemetry.FILE).read_text(encoding="utf-8")
        self.assertNotIn("nonexistent", text)
        self.assertNotIn(job.error or "\0", text)

    def test_no_counts_while_off(self):
        self.state(counting=False)
        self.run_one("ok")
        self.assertEqual(self.counts(), {})


class AppWiring(Base):
    def app(self, env):
        from fairbeam.server import App

        (self.root / "projects").mkdir(exist_ok=True)
        with mock.patch.dict(os.environ, env):
            app = App(models_dir=MODELS, projects_dir=self.root / "projects", jobs_dir=self.root / "jobs",
                      manager=JobManager(self.root / "jobs", self.root / "projects", autostart=False))
        self.addCleanup(app.close)
        return app

    def test_off_by_default(self):
        env = {k: v for k, v in os.environ.items() if k != telemetry.ENV_DIR}
        with mock.patch.dict(os.environ, env, clear=True):
            app = self.app({})
        self.assertIsNone(app.usage)
        self.assertIsNone(app.manager.on_started)

    def test_on_with_the_shells_folder(self):
        app = self.app({telemetry.ENV_DIR: str(self.dir), telemetry.ENV_OFF: "0"})
        self.assertIsNotNone(app.usage)
        self.assertIsNotNone(app.manager.on_started)


if __name__ == "__main__":
    unittest.main()
