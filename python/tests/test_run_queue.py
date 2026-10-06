"""Runs the open app did not start: the queue state /api/health reports
(running, queued, a change counter, runs started from a terminal), clearing the queue, the CLI's
default folders in the packaged runtime, and `fairbeam run --server`, which queues a run on the
app's server. Jobs use the fake child from tests/fake_openems.py; no openEMS is started."""

import contextlib
import http.client
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from fairbeam import appstate, cli  # noqa: E402
from fairbeam.jobs import JobManager  # noqa: E402
from fairbeam.resources import GiB, preflight  # noqa: E402
from fairbeam.server import App, make_server  # noqa: E402
from fairbeam.simdata import MARKER_SUFFIX, live_runs, mark_running  # noqa: E402

MODELS = HERE.parent / "models"
FAKE = str(HERE / "fake_openems.py")


def wait_for(pred, timeout=30.0, step=0.02):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pred():
            return True
        time.sleep(step)
    return False


def sleeper() -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])


class QueueState(unittest.TestCase):
    """JobManager: what /api/health's queue reports, and clearing the queue."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        # the first job hangs until cancelled, so the others stay queued behind it
        self.m = JobManager(self.root / "jobs", self.root / "projects", grace_s=1.0,
                            command_factory=lambda job: [sys.executable, FAKE, job.params.get("mode", "ok"),
                                                         str(self.root / "projects")])

    def tearDown(self):
        self.m.shutdown(timeout=5)
        self.tmp.cleanup()

    def submit(self, mode="ok"):
        return self.m.submit(model="dipole", model_path="/nonexistent/dipole.py", model_id="dipole",
                             params={"mode": mode}, overrides={}, threads=1)

    def test_version_counts_every_change_of_the_queue(self):
        v0 = self.m.version
        job = self.submit("ok")
        self.assertGreater(self.m.version, v0, "a submitted run changes the queue")
        self.assertTrue(wait_for(lambda: job.terminal))
        # added, started, ended: a window polling the health sees a run that came and went between polls
        self.assertGreaterEqual(self.m.version, v0 + 3)
        before = self.m.version
        self.m.delete(job.id)
        self.assertGreater(self.m.version, before, "removing a run from the history changes the list")

    def test_queued_count_leaves_out_cancelled_runs(self):
        hang = self.submit("hang")
        self.assertTrue(wait_for(lambda: hang.status == "running"))
        a, b = self.submit(), self.submit()
        self.assertEqual(self.m.queued_count(), 2)
        self.m.cancel(a.id)
        self.assertEqual(a.status, "cancelled")
        # the id is still in the worker's queue (it is skipped when its turn comes), but it no longer waits
        self.assertEqual(self.m.queue.qsize(), 2)
        self.assertEqual(self.m.queued_count(), 1)
        self.m.cancel(b.id)
        self.m.cancel(hang.id)
        self.assertTrue(wait_for(lambda: hang.terminal))

    def test_clear_queue_cancels_the_waiting_runs_only(self):
        hang = self.submit("hang")
        self.assertTrue(wait_for(lambda: hang.status == "running"))
        waiting = [self.submit(), self.submit(), self.submit()]
        version = self.m.version
        cleared = self.m.clear_queue()
        self.assertEqual([j.id for j in cleared], [j.id for j in waiting])
        self.assertTrue(all(j.status == "cancelled" for j in waiting))
        self.assertEqual(hang.status, "running", "the running run is not part of the queue")
        self.assertEqual(self.m.queued_count(), 0)
        self.assertGreater(self.m.version, version)
        self.assertEqual(self.m.clear_queue(), [], "nothing left to clear")
        self.m.cancel(hang.id)
        self.assertTrue(wait_for(lambda: hang.terminal))
        self.assertEqual(hang.status, "cancelled")


class ExternalRuns(unittest.TestCase):
    """`fairbeam run` started outside the server: its running marker under the sim root."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_live_markers_at_the_top_of_the_sim_root(self):
        proc = sleeper()
        try:
            (self.root / f".patch-cli{MARKER_SUFFIX}").write_text(f"{proc.pid}\n", encoding="utf-8")
            (self.root / f".old-run{MARKER_SUFFIX}").write_text("999999\n", encoding="utf-8")  # gone
            (self.root / f".garbled{MARKER_SUFFIX}").write_text("not a pid\n", encoding="utf-8")
            # a server job's own run marks below runs/<id>/: not an outside run
            (self.root / "runs" / "job1").mkdir(parents=True)
            (self.root / "runs" / "job1" / f".dipole{MARKER_SUFFIX}").write_text(f"{proc.pid}\n", encoding="utf-8")
            self.assertEqual(live_runs(self.root), [{"name": "patch-cli", "pid": proc.pid}])
        finally:
            proc.kill()
            proc.wait()
        self.assertEqual(live_runs(self.root), [])
        self.assertEqual(live_runs(self.root / "missing"), [])

    def test_a_reused_pid_does_not_count(self):
        # a crashed run left its marker; the system later gave the pid to a process that started
        # after the marker was written: no outside run (else a permanent note and a busy preflight)
        proc = sleeper()
        try:
            marker = self.root / f".crashed{MARKER_SUFFIX}"
            marker.write_text(f"{proc.pid}\n", encoding="utf-8")
            self.assertEqual(live_runs(self.root), [{"name": "crashed", "pid": proc.pid}], "written after it started")
            hour_ago = time.time() - 3600
            os.utime(marker, (hour_ago, hour_ago))
            self.assertEqual(live_runs(self.root), [], "the process started an hour after the marker")
        finally:
            proc.kill()
            proc.wait()

    def test_this_process_does_not_count_itself(self):
        with mark_running(self.root / "here"):
            self.assertEqual(live_runs(self.root), [])

    def test_preflight_names_outside_runs(self):
        r = preflight(1e5, "cpu", 16 * GiB, external=1)
        self.assertEqual(r["level"], "warn")
        self.assertIn("1 run started outside the app (fairbeam run in a terminal) is using the CPU", r["messages"][-1])
        r = preflight(1e5, "cpu", 16 * GiB, external=2)
        self.assertIn("2 runs started outside the app", r["messages"][-1])
        self.assertIn("does not wait for them", r["messages"][-1])
        self.assertEqual(preflight(1e5, "cpu", 16 * GiB)["level"], "ok")


class ServerQueueApi(unittest.TestCase):
    """/api/health's queue and POST /api/queue/clear over HTTP; `fairbeam run --server` against it."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.root = root
        (root / "projects").mkdir()
        cls.sim = root / "sim"
        cls.sim.mkdir()
        manager = JobManager(root / "jobs", root / "projects", grace_s=1.0,
                             command_factory=lambda job: [sys.executable, FAKE,
                                                          "hang" if job.params.get("length") == 61 else "ok",
                                                          str(root / "projects")])
        cls.app = App(models_dir=MODELS, projects_dir=root / "projects", jobs_dir=root / "jobs",
                      manager=manager, heartbeat_s=0.2, sim_root=cls.sim)
        cls.srv = make_server(cls.app, "127.0.0.1", 0, quiet=True)
        cls.port = cls.srv.server_address[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.srv.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stopping = True
        cls.srv.shutdown()
        cls.app.close()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        headers = {"Host": f"127.0.0.1:{self.port}"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=headers)
        r = conn.getresponse()
        payload = r.read()
        conn.close()
        return r.status, json.loads(payload or b"null")

    def queue(self):
        return self.request("GET", "/api/health")[1]["queue"]

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.main(["run", *argv])
        return rc, out.getvalue(), err.getvalue()

    def test_health_queue_and_clear(self):
        q0 = self.queue()
        self.assertEqual(set(q0), {"running", "queued", "version", "external"})
        status, hang = self.request("POST", "/api/runs", {"model": "dipole", "params": {"length": 61}, "threads": 1})
        self.assertEqual(status, 201, hang)
        self.assertTrue(wait_for(lambda: self.queue()["running"] == hang["id"]))
        ids = [self.request("POST", "/api/runs", {"model": "dipole", "params": {}, "threads": 1})[1]["id"] for _ in range(2)]
        q = self.queue()
        self.assertEqual(q["queued"], 2)
        self.assertGreater(q["version"], q0["version"])
        # a run from a terminal writing into this server's sim root counts as busy in the preflight
        proc = sleeper()
        try:
            (self.sim / f".cli-run{MARKER_SUFFIX}").write_text(f"{proc.pid}\n", encoding="utf-8")
            self.assertEqual(self.queue()["external"], 1)
            status, pre = self.request("POST", "/api/preflight", {"cells": 1e5})
            self.assertEqual(status, 200)
            self.assertTrue(any("outside the app" in m for m in pre["messages"]), pre)
        finally:
            proc.kill()
            proc.wait()
        self.assertEqual(self.queue()["external"], 0)
        status, body = self.request("POST", "/api/queue/clear", {})
        self.assertEqual(status, 202)
        self.assertEqual(sorted(body["cancelled"]), sorted(ids))
        self.assertEqual(self.queue()["queued"], 0)
        self.assertEqual(self.queue()["running"], hang["id"], "Clear queue leaves the running run alone")
        status, _ = self.request("POST", f"/api/runs/{hang['id']}/cancel", {})
        self.assertEqual(status, 202)
        self.assertTrue(wait_for(lambda: self.queue()["running"] is None))

    def test_only_a_desktop_started_server_records_itself(self):
        from fairbeam.server import record_desktop_server

        with tempfile.TemporaryDirectory() as state, mock.patch.dict(os.environ, {"FAIRBEAM_STATE_DIR": state}):
            os.environ.pop("FAIRBEAM_SHUTDOWN_TOKEN", None)
            self.assertIsNone(record_desktop_server(self.app, "127.0.0.1", self.port), "npm run serve writes no record")
            self.assertFalse((Path(state) / "server.json").exists())
            with mock.patch.dict(os.environ, {"FAIRBEAM_SHUTDOWN_TOKEN": "s3cret"}):
                path = record_desktop_server(self.app, "127.0.0.1", self.port)
            rec = appstate.read_server_record(path)
            self.assertEqual((rec["url"], rec["pid"]), (self.base, os.getpid()))
            self.assertEqual((rec["projects"], rec["sim_root"]), (str(self.app.projects_dir), str(self.app.sim_root)))
            self.assertEqual(rec["jobs"], str(self.app.jobs_dir))
            self.assertIs(rec["checkout"], True, "the tests run from a checkout, like a `tauri dev` shell")
            self.assertEqual(appstate.resolve_server("auto"), self.base)

    def test_run_server_queues_and_follows_the_run(self):
        rc, out, err = self.run_cli("dipole", "--server", self.base, "--label", "From a terminal", "--threads", "1")
        self.assertEqual(rc, 0, out + err)
        self.assertIn("queued on " + self.base, out)
        self.assertIn("Running FDTD engine", out, "the run's log is printed while following it")
        self.assertRegex(out, r"fairbeam: run \S+ done: \S+\.json")
        runs = self.request("GET", "/api/runs")[1]["runs"]
        job = next(j for j in runs if j["label"] == "From a terminal")
        self.assertEqual((job["model"], job["status"], job["threads"]), ("dipole", "done", 1))

    def test_run_server_detach_and_model_file(self):
        rc, out, _ = self.run_cli(str(MODELS / "dipole.py"), "--server", str(self.port), "--detach",
                                  "--set", "length=60", "--quiet")
        self.assertEqual(rc, 0)
        job_id = out.split("fairbeam: run ")[1].split()[0]
        status, job = self.request("GET", f"/api/runs/{job_id}")
        self.assertEqual(status, 200)
        self.assertEqual(job["overrides"], {"length": "60"})
        self.assertTrue(wait_for(lambda: self.request("GET", f"/api/runs/{job_id}")[1]["status"] == "done"))

    def test_run_server_refusals(self):
        rc, _, err = self.run_cli("no_such_model", "--server", self.base)
        self.assertEqual(rc, 2)
        self.assertIn("the server has no model 'no_such_model'", err)
        with tempfile.TemporaryDirectory() as d:
            other = Path(d) / "dipole.py"
            other.write_text((MODELS / "dipole.py").read_text(encoding="utf-8"), encoding="utf-8")
            rc, _, err = self.run_cli(str(other), "--server", self.base)
            self.assertEqual(rc, 2)
            self.assertIn("is not in the server's models folder", err)
        rc, _, err = self.run_cli("dipole", "--server", self.base, "--out", "x", "--pattern", "2.4")
        self.assertEqual(rc, 2)
        self.assertIn("not available with --server", err)
        self.assertIn("--out, --pattern", err)
        rc, _, err = self.run_cli("dipole", "--server", self.base, "--set", "length=1")
        self.assertEqual(rc, 2)
        self.assertIn("invalid parameters", err)
        rc, _, err = self.run_cli("dipole", "--server", "http://127.0.0.1:9")
        self.assertEqual(rc, 2)
        self.assertIn("does not answer", err)


class CliFolders(unittest.TestCase):
    """The CLI's --out/--sim-root defaults: the repository in a checkout, the app's workspace in the
    packaged runtime (from the record the desktop-started server writes), else a warning."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.state = self.root / "state"
        self.env = mock.patch.dict(os.environ, {"FAIRBEAM_STATE_DIR": str(self.state)})
        self.env.start()
        # the managed runtime: <runtime>/app/fairbeam (runtime/install.py), no package.json
        self.runtime = self.root / "runtime"
        (self.runtime / "app" / "fairbeam").mkdir(parents=True)
        self.checkout = self.root / "repo"
        (self.checkout / "python" / "fairbeam").mkdir(parents=True)
        (self.checkout / "package.json").write_text("{}", encoding="utf-8")
        self.ws = self.root / "Documents" / "fairbeam"

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def record(self, pid=None):
        return appstate.write_server_record(url="http://127.0.0.1:5320", pid=pid or os.getpid(),
                                            models=self.ws / "models", projects=self.ws / "projects",
                                            jobs=self.ws / "jobs", sim_root=self.ws / ".sim", version="0.6.8")

    def test_checkout_keeps_the_repository_folders(self):
        self.record()
        d = appstate.cli_defaults(self.checkout)
        self.assertEqual((d["out"], d["sim"], d["source"]), (self.checkout / "public" / "projects", self.checkout / ".sim", "checkout"))
        self.assertTrue(appstate.is_checkout(cli.REPO), "the tests run from a checkout: its defaults stay as they were")

    def test_runtime_uses_the_app_workspace(self):
        self.assertEqual(appstate.cli_defaults(self.runtime)["source"], "package")
        path = self.record()
        self.assertEqual(path, self.state / "server.json")
        d = appstate.cli_defaults(self.runtime)
        self.assertEqual((d["out"], d["sim"], d["source"], d["record"]),
                         (self.ws / "projects", self.ws / ".sim", "app", path))
        # the record outlives the app: the workspace stays the default while the app is closed
        self.record(pid=999999)
        self.assertEqual(appstate.cli_defaults(self.runtime)["out"], self.ws / "projects")
        (self.state / "server.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(appstate.cli_defaults(self.runtime)["source"], "package")

    def test_a_debug_shell_record_is_not_a_workspace(self):
        # `tauri dev` starts the checkout's server with the repository's folders: the installed
        # (packaged) CLI must not write into that repository
        appstate.write_server_record(url="http://127.0.0.1:5320", pid=os.getpid(), models=self.checkout / "python" / "models",
                                     projects=self.checkout / "public" / "projects", jobs=self.checkout / ".sim" / "jobs",
                                     sim_root=self.checkout / ".sim", checkout=True)
        self.assertEqual(appstate.cli_defaults(self.runtime)["source"], "package")
        self.assertEqual(appstate.resolve_server("auto"), "http://127.0.0.1:5320", "--server still finds it")
        self.record()  # an older record without the flag: an installed app's
        rec = json.loads((self.state / "server.json").read_text(encoding="utf-8"))
        rec.pop("checkout")
        (self.state / "server.json").write_text(json.dumps(rec), encoding="utf-8")
        self.assertEqual(appstate.cli_defaults(self.runtime)["source"], "app")

    def write_cli_result(self, args, slug, name="CLI result"):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            path = cli._write({"schema": "fairbeam.bundle/1", "name": name}, Path(args.out), slug,
                              keep_existing=cli._keeps_existing(args))
        return path, out.getvalue()

    def test_a_cli_result_never_replaces_a_bundle_of_the_workspace(self):
        # the packaged CLI writing into the app's workspace: a seeded example, or
        # the app's own first run of the same model and parameters, has the CLI's file name
        self.record()
        folders = appstate.cli_defaults(self.runtime)
        projects = self.ws / "projects"
        projects.mkdir(parents=True)
        slug = cli._slug("sierpinski-monopole", {"iterations": "3"})
        self.assertEqual(slug, "sierpinski-monopole--iterations-3")
        example = projects / f"{slug}.json"
        example.write_text('{"name": "the seeded example"}', encoding="utf-8")
        args = SimpleNamespace(out=None, sim_root=None, name=None, folders=folders)
        with contextlib.redirect_stdout(io.StringIO()):
            cli._default_folders(args)
        self.assertEqual(args.out, str(projects))
        self.assertTrue(cli._keeps_existing(args))
        path, said = self.write_cli_result(args, slug)
        self.assertEqual(example.read_text(encoding="utf-8"), '{"name": "the seeded example"}', "the example is untouched")
        self.assertRegex(path.name, rf"^{slug}-\d{{8}}-\d{{6}}\.json$", "the server's naming: stem-<stamp>")
        self.assertIn("writing " + path.name + " instead", said)
        again, _ = self.write_cli_result(args, slug)
        self.assertNotIn(again, (example, path), "a second run keeps the first one too")
        self.assertEqual(len(list(projects.glob(f"{slug}*.json"))), 3)
        self.assertTrue((projects / "index.json").is_file(), "the index is rebuilt as before")
        # a free name is used as it is
        path, said = self.write_cli_result(args, "patch-antenna")
        self.assertEqual((path.name, said), ("patch-antenna.json", ""))
        # --out given explicitly, still the packaged runtime with a record: the same care
        args = SimpleNamespace(out=str(projects), sim_root=None, name=None, folders=folders)
        path, _ = self.write_cli_result(args, slug)
        self.assertNotEqual(path, example)
        self.assertEqual(example.read_text(encoding="utf-8"), '{"name": "the seeded example"}')

    def test_a_run_the_app_is_running_keeps_its_name(self):
        # a run of the app's server took its name when it started and writes it when it ends: the CLI
        # does not take that name meanwhile, although the file is not there yet
        self.record()
        folders = appstate.cli_defaults(self.runtime)
        (self.ws / "projects").mkdir(parents=True)
        for job_id, status, name in (("j1", "running", "dipole"), ("j2", "done", "patch-antenna"), ("j3", "queued", "yagi-867")):
            (self.ws / "jobs" / job_id).mkdir(parents=True)
            (self.ws / "jobs" / job_id / "job.json").write_text(
                json.dumps({"id": job_id, "status": status, "name": name, "kind": "run"}), encoding="utf-8")
        (self.ws / "jobs" / "broken").mkdir()
        (self.ws / "jobs" / "broken" / "job.json").write_text("{", encoding="utf-8")
        self.assertEqual(appstate.running_bundle_names(self.ws / "projects"), {"dipole"})
        self.assertEqual(appstate.running_bundle_names(self.root / "elsewhere"), set(), "another folder: nothing reserved")
        args = SimpleNamespace(out=str(self.ws / "projects"), sim_root=None, name=None, folders=folders)
        path, _ = self.write_cli_result(args, "dipole")
        self.assertNotEqual(path.name, "dipole.json")
        path, _ = self.write_cli_result(args, "yagi-867")
        self.assertEqual(path.name, "yagi-867.json", "a queued run picks its name when it starts (it then sees this file)")

    def test_explicit_name_and_checkout_replace_as_before(self):
        self.record()
        projects = self.ws / "projects"
        projects.mkdir(parents=True)
        (projects / "mine.json").write_text("{}", encoding="utf-8")
        args = SimpleNamespace(out=str(projects), sim_root=None, name="mine", folders=appstate.cli_defaults(self.runtime))
        self.assertFalse(cli._keeps_existing(args), "--name: the user chose the file")
        path, _ = self.write_cli_result(args, "mine", name="new")
        self.assertEqual(path, projects / "mine.json")
        self.assertIn('"new"', path.read_text(encoding="utf-8"))
        # a checkout: the same command replaces its own result (unchanged behaviour)
        args = SimpleNamespace(out=str(projects), sim_root=None, name=None, folders=appstate.cli_defaults(self.checkout))
        self.assertFalse(cli._keeps_existing(args))
        path, _ = self.write_cli_result(args, "mine", name="newer")
        self.assertEqual(path, projects / "mine.json")
        # the package without a record (it writes inside the runtime): as before too
        (self.state / "server.json").unlink()
        self.assertFalse(cli._keeps_existing(SimpleNamespace(name=None, folders=appstate.cli_defaults(self.runtime))))

    def test_free_names(self):
        d = self.root / "names"
        d.mkdir()
        self.assertEqual(cli._free_name(d, "a"), "a")
        (d / "a.json").write_text("{}", encoding="utf-8")
        with mock.patch.object(cli.time, "strftime", return_value="20261005-120000"):
            self.assertEqual(cli._free_name(d, "a"), "a-20261005-120000")
            (d / "a-20261005-120000.json").write_text("{}", encoding="utf-8")
            self.assertEqual(cli._free_name(d, "a"), "a-20261005-120000-2")
            self.assertEqual(cli._free_name(d, "b", {"b"}), "b-20261005-120000")

    def test_geometry_and_run_keep_the_workspace_bundles(self):
        # end to end through the commands (a fake build and solver): `fairbeam geometry` and
        # `fairbeam run` from the packaged runtime, no --out, no --name
        self.record()
        projects = self.ws / "projects"
        projects.mkdir(parents=True)
        (projects / "toy.json").write_text('{"name": "app result"}', encoding="utf-8")
        (projects / "toy--geometry.json").write_text('{"name": "app geometry"}', encoding="utf-8")
        sim = mock.Mock()
        sim.to_bundle.return_value = {"schema": "fairbeam.bundle/1", "name": "toy"}
        built = (mock.Mock(MODEL={"id": "toy", "name": "Toy"}), sim, [], "toy", "Toy")
        with mock.patch.object(cli, "REPO", self.runtime), mock.patch.object(cli, "_build", return_value=built), \
                mock.patch.object(cli, "_run", side_effect=lambda a, m, s, p, slug, label, sp: print(
                    "wrote", cli._write(s.to_bundle(), Path(a.out), slug, keep_existing=cli._keeps_existing(a)))), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(["geometry", "toy.py"]), 0)
            self.assertEqual(cli.main(["run", "toy.py"]), 0)
        self.assertEqual(json.loads((projects / "toy.json").read_text(encoding="utf-8"))["name"], "app result")
        self.assertEqual(json.loads((projects / "toy--geometry.json").read_text(encoding="utf-8"))["name"], "app geometry")
        self.assertEqual(len(list(projects.glob("toy-2*.json"))), 1, "the run's result beside it")
        self.assertEqual(len(list(projects.glob("toy--geometry-2*.json"))), 1, "the geometry beside it")

    def test_default_folders_fill_in_and_tell(self):
        def args(**kw):
            base = {"out": None, "sim_root": None}
            base.update(kw)
            return mock.Mock(**base)

        a = args(folders={"out": self.ws / "projects", "sim": self.ws / ".sim", "source": "app", "record": self.state / "server.json"})
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            cli._default_folders(a)
        self.assertEqual((a.out, a.sim_root), (str(self.ws / "projects"), str(self.ws / ".sim")))
        self.assertIn("writing to the Fairbeam app's workspace", out.getvalue())

        a = args(folders={"out": self.runtime / "public" / "projects", "sim": self.runtime / ".sim", "source": "package", "record": None})
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            cli._default_folders(a)
        self.assertIn("inside the Fairbeam runtime", err.getvalue())
        self.assertIn("--server", err.getvalue())

        a = args(out="mine", sim_root="raw", folders={"out": self.runtime, "sim": self.runtime, "source": "package", "record": None})
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            cli._default_folders(a)
        self.assertEqual((a.out, a.sim_root, err.getvalue()), ("mine", "raw", ""), "explicit folders: nothing to say")

    def test_run_parser_defaults_follow_the_record(self):
        seen = []
        self.record()
        with mock.patch.object(cli, "REPO", self.runtime), \
                mock.patch.object(cli, "cmd_run", side_effect=lambda a: seen.append(a)):
            cli.main(["run", "model.py"])
        a = seen[0]
        self.assertIsNone(a.out, "filled in when the run starts, so an explicit --out is told apart")
        self.assertEqual(a.folders["out"], self.ws / "projects")
        self.assertIsNone(a.server)

    def test_resolve_server(self):
        self.assertEqual(appstate.resolve_server("http://127.0.0.1:5320/"), "http://127.0.0.1:5320")
        self.assertEqual(appstate.resolve_server("5433"), "http://127.0.0.1:5433")
        self.assertEqual(appstate.resolve_server("127.0.0.1:5320/api"), "http://127.0.0.1:5320")
        with self.assertRaisesRegex(ValueError, "no running Fairbeam app found"):
            appstate.resolve_server("auto")
        self.record(pid=999999)
        with self.assertRaisesRegex(ValueError, "is not running"):
            appstate.resolve_server("auto")
        self.record()
        self.assertEqual(appstate.resolve_server("auto"), "http://127.0.0.1:5320")


if __name__ == "__main__":
    unittest.main()
