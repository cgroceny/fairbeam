"""Job lifecycle with a fake child process (tests/fake_openems.py); no openEMS is started."""

import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.jobs import Job, JobManager, process_info  # noqa: E402
from fairbeam.procutil import WINDOWS, kill_tree, new_group_kwargs, pid_alive  # noqa: E402

FAKE = str(Path(__file__).resolve().parent / "fake_openems.py")


def sleeper(seconds: int = 30) -> list[str]:
    """A harmless long-running command that exists everywhere (Windows has no `sleep`)."""
    return [sys.executable, "-c", f"import time; time.sleep({seconds})"]


def wait_for(pred, timeout=30.0, step=0.02):  # generous: CI and Windows runners are slower
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pred():
            return True
        time.sleep(step)
    return False


def alive(pid: int) -> bool:
    if WINDOWS:  # os.kill(pid, 0) would terminate the process there
        return pid_alive(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # a zombie still answers kill(0); check it is not a zombie
    try:
        import subprocess
        state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        return bool(state) and not state.startswith("Z")
    except OSError:
        return True


class JobLifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.finished = []
        self.managers = []

    def tearDown(self):
        for m in self.managers:
            m.shutdown(timeout=5)
        self.tmp.cleanup()

    def manager(self, mode_of=lambda job: job.params.get("mode", "ok"), **kw):
        m = JobManager(self.root / "jobs", self.root / "projects", grace_s=kw.pop("grace_s", 1.0),
                       command_factory=lambda job: [sys.executable, FAKE, mode_of(job), str(self.root / "projects")],
                       on_finished=self.finished.append, **kw)
        self.managers.append(m)
        return m

    def submit(self, m, mode="ok"):
        return m.submit(model="dipole", model_path="/nonexistent/dipole.py", model_id="dipole",
                        params={"mode": mode}, overrides={"length": "60"}, threads=2)

    def test_success(self):
        m = self.manager()
        job = self.submit(m)
        self.assertTrue(wait_for(lambda: job.terminal))
        self.assertEqual(job.status, "done", job.error)
        self.assertEqual(job.exit_code, 0)
        self.assertEqual(job.bundle, "fake-dipole.json")
        statuses = [e["status"] for e in job.events if e["type"] == "status"]
        self.assertEqual(statuses, ["queued", "running", "done"])
        phases = [e["phase"] for e in job.events if e["type"] == "phase"]
        self.assertEqual(phases, ["queued", "building", "setup", "running", "postprocessing", "exporting", "done"])
        seqs = [e["seq"] for e in job.events]
        self.assertEqual(seqs, list(range(1, len(seqs) + 1)))
        self.assertEqual(job.last_progress["timestep"], 7272)
        self.assertEqual(job.stats["timesteps"], 7272)
        self.assertEqual(job.stats["bands"][0]["f_center_ghz"], 2.245)
        self.assertEqual(job.stats["farfield"][0]["rad_efficiency"], 0.9984)
        self.assertEqual(job.info["cells"], 78000)
        self.assertEqual(job.info["engine"], "cpu")
        self.assertEqual(job.end_criteria_db, -50.0)  # taken from the run's settings line
        self.assertEqual(self.finished, [job])

        # persisted: job.json, log.txt, events.jsonl
        data = json.loads((job.dir / "job.json").read_text(encoding="utf-8"))
        self.assertEqual(data["status"], "done")
        self.assertEqual(data["command"][1:3], [FAKE, "ok"])  # to recognise the process after a crash
        self.assertEqual(data["proc_start"], job.proc_start)
        if os.name == "posix":
            self.assertRegex(data["proc_start"], r"^\w{3} \w{3} \d{1,2} \d\d:\d\d:\d\d \d{4}$")
        self.assertEqual(data["overrides"], {"length": "60"})
        log = (job.dir / "log.txt").read_text(encoding="utf-8")
        self.assertIn("Running FDTD engine", log)
        self.assertIn("[exit code 0]", log)
        self.assertEqual(len((job.dir / "events.jsonl").read_text(encoding="utf-8").splitlines()), len(job.events))

        # history survives a restart, events included
        m2 = self.manager()
        again = m2.get(job.id)
        self.assertEqual(again.status, "done")
        self.assertEqual(len(again.events), len(job.events))
        self.assertEqual(m2.list()[0]["id"], job.id)

    def test_default_command(self):
        m = JobManager(self.root / "jobs", self.root / "projects", python="/py", autostart=False)
        job = m.submit(model="dipole", model_path="/m/dipole.py", overrides={"length": 60}, threads=3, name="x")
        self.assertEqual(m.default_command(job), ["/py", "-m", "fairbeam", "run", "/m/dipole.py", "--threads", "3",
                                                  "--out", str(self.root / "projects"), "--set", "length=60",
                                                  "--name", "x"])
        gpu = m.submit(model="dipole", model_path="/m/dipole.py", threads=1, engine="gpu")
        self.assertEqual(m.default_command(gpu)[-2:], ["--engine", "gpu"])
        cpu = m.submit(model="dipole", model_path="/m/dipole.py", threads=1, engine="cpu")
        self.assertNotIn("--engine", m.default_command(cpu))
        self.assertNotIn("--points", m.default_command(cpu))
        pts = m.submit(model="dipole", model_path="/m/dipole.py", threads=1, points=201)
        self.assertEqual(m.default_command(pts)[-2:], ["--points", "201"])
        self.assertEqual(pts.to_dict()["points"], 201)
        # the result name typed in the Run dialog is the bundle's display name (--label); the file
        # name (--name) is its slug. A sweep point or a mesh-convergence run keeps its generated name.
        named = m.submit(model="dipole", model_path="/m/dipole.py", threads=1, name="my-run", label="My run")
        cmd = m.default_command(named)
        self.assertEqual(cmd[cmd.index("--label") + 1], "My run")
        self.assertEqual(cmd[cmd.index("--name") + 1], "my-run")
        self.assertNotIn("--label", m.default_command(cpu))
        swept = m.submit(model="dipole", model_path="/m/dipole.py", threads=1, label="Sweep", sweep={"id": "s", "index": 0, "total": 2})
        self.assertNotIn("--label", m.default_command(swept))

    def test_end_criterion_reaches_the_command_only_when_requested(self):
        m = JobManager(self.root / "jobs", self.root / "projects", python="/py", autostart=False)
        has_end_db = lambda cmd: any(a.startswith("--end-db") for a in cmd)  # noqa: E731
        omitted = m.submit(model="dipole", model_path="/m/dipole.py", threads=1, engine="gpu", points=11)
        self.assertIsNone(omitted.requested_end_criteria_db)
        self.assertIsNone(omitted.end_criteria_db)  # the model's own, reported by the run (not -40)
        self.assertFalse(has_end_db(m.default_command(omitted)))
        for db, arg in ((-10, "--end-db=-10.0"), (-60.0, "--end-db=-60.0"), (-12.5, "--end-db=-12.5"),
                        (-1e-5, "--end-db=-1e-05")):  # one token: argparse would read "-1e-05" as an option
            job = m.submit(model="dipole", model_path="/m/dipole.py", threads=1, engine="gpu", points=11,
                           end_criteria_db=db)
            cmd = m.default_command(job)
            self.assertEqual(cmd[-1], arg)
            self.assertEqual([a for a in cmd if a.startswith("--end-db")], [arg])
            self.assertEqual((job.requested_end_criteria_db, job.end_criteria_db), (float(db), float(db)))
            data = json.loads((job.dir / "job.json").read_text(encoding="utf-8"))
            self.assertEqual((data["requested_end_criteria_db"], data["end_criteria_db"]), (float(db), float(db)))
        sweep = {"id": "sw-1", "index": 0, "total": 2, "values": {"length": 58}}
        member = m.submit(model="dipole", model_path="/m/dipole.py", threads=1, sweep=sweep, end_criteria_db=-10)
        self.assertEqual(m.default_command(member)[-1], "--end-db=-10.0")
        self.assertFalse(has_end_db(m.default_command(m.submit(model="dipole", model_path="/m/dipole.py", sweep=sweep))))
        # optimize supports --end-db (every evaluation); absent keeps the model's own there too
        spec = {"vary": [{"key": "length", "min": 50.0, "max": 66.0, "start": None}],
                "goals": [{"kind": "f0", "target": 2.4, "at": None, "weight": 1.0}]}
        opt = m.submit(model="dipole", model_path="/m/dipole.py", kind="optimize", optimize=spec, end_criteria_db=-30)
        self.assertEqual([a for a in m.default_command(opt) if a.startswith("--end-db")], ["--end-db=-30.0"])
        opt_default = m.submit(model="dipole", model_path="/m/dipole.py", kind="optimize", optimize=spec)
        self.assertFalse(has_end_db(m.default_command(opt_default)))

        # the child's argument parsers read the exact value back from the built commands
        from fairbeam import cli

        seen = []
        with mock.patch.object(cli, "cmd_run", lambda args: seen.append(("run", args.end_db))), \
                mock.patch("fairbeam.optimize.run_optimization",
                           lambda *a, **kw: seen.append(("optimize", kw["end_db"])) or
                           {"best": None, "evaluations": [], "_path": "x"}), \
                redirect_stdout(io.StringIO()):
            for job in (omitted, member, opt, opt_default):
                cli.main(m.default_command(job)[3:])  # optimize: 1, the stub found no best point
            tiny = m.submit(model="dipole", model_path="/m/dipole.py", end_criteria_db=-1e-5)
            cli.main(m.default_command(tiny)[3:])
        self.assertEqual(seen, [("run", None), ("run", -10.0), ("optimize", -30.0), ("optimize", None), ("run", -1e-5)])

    def test_historical_jobs_keep_their_threshold_and_pass_none(self):
        """job.json written before requested_end_criteria_db existed: it loads, keeps its recorded
        (effective) end criterion, and would not pass --end-db (those runs never did)."""
        root = self.root / "jobs"
        records = {"20260101-000000-aaaaaa": {"end_criteria_db": -40.0},      # an omitted request, old server
                   "20260101-000001-bbbbbb": {"end_criteria_db": -60.0},      # replaced by the run's own line
                   "20260101-000002-cccccc": {},                               # older still: no field at all
                   "20260101-000003-dddddd": {"end_criteria_db": None}}
        for job_id, extra in records.items():
            (root / job_id).mkdir(parents=True)
            (root / job_id / "job.json").write_text(json.dumps({
                "id": job_id, "model": "dipole", "model_path": "/m/dipole.py", "status": "done", "phase": "done",
                "created": 1.0, "started": 1.0, "finished": 2.0, "threads": 2, "command": ["/py", "-m", "fairbeam"],
                "stats": {"bands": []}, **extra}), encoding="utf-8")
        m = JobManager(root, self.root / "projects", python="/py", autostart=False)
        got = {job_id: m.get(job_id) for job_id in records}
        self.assertEqual([j.end_criteria_db for j in got.values()], [-40.0, -60.0, None, None])
        self.assertTrue(all(j.requested_end_criteria_db is None for j in got.values()))
        self.assertFalse(any(a.startswith("--end-db") for j in got.values() for a in m.default_command(j)))
        listed = {d["id"]: d for d in m.list()}
        self.assertEqual(listed["20260101-000000-aaaaaa"]["end_criteria_db"], -40.0)
        self.assertIsNone(listed["20260101-000000-aaaaaa"]["requested_end_criteria_db"])

    def test_requested_threshold_reaches_the_child_and_its_report(self):
        """A stub child prints the settings line `fairbeam run` prints, from its own --end-db (else
        a model default of -60): the job's metadata, the log and the child agree."""
        stub = ("import pathlib, sys\n"
                "end = next((float(a.split('=', 1)[1]) for a in sys.argv[2:] if a.startswith('--end-db=')), -60.0)\n"
                "print('fairbeam: Stub model', flush=True)\n"
                "print(f'fairbeam: end criterion {end:g} dB, max timesteps 1000, engine cpu', flush=True)\n"
                "out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)\n"
                "p = out / f'stub{-end:g}.json'; p.write_text('{}', encoding='utf-8')\n"
                "print(f'fairbeam: wrote {p}', flush=True)\n")
        m = JobManager(self.root / "jobs", self.root / "projects", python="/py", grace_s=1.0)
        self.managers.append(m)
        m.command_factory = lambda job: [sys.executable, "-c", stub, str(self.root / "projects"),
                                         *m.default_command(job)[3:]]
        explicit = m.submit(model="dipole", model_path="/m/dipole.py", threads=1, name="explicit", end_criteria_db=-10)
        omitted = m.submit(model="dipole", model_path="/m/dipole.py", threads=1, name="omitted")
        self.assertTrue(wait_for(lambda: explicit.terminal and omitted.terminal))
        for job, expected, requested in ((explicit, -10.0, -10.0), (omitted, -60.0, None)):
            self.assertEqual(job.status, "done", job.error)
            self.assertEqual((job.end_criteria_db, job.info["end_criteria_db"]), (expected, expected))
            self.assertEqual(job.requested_end_criteria_db, requested)
            log = (job.dir / "log.txt").read_text(encoding="utf-8")
            self.assertIn(f"fairbeam: end criterion {expected:g} dB", log)
            self.assertEqual("--end-db=-10.0" in log, requested is not None)  # the "$ command" line
            saved = json.loads((job.dir / "job.json").read_text(encoding="utf-8"))
            self.assertEqual((saved["end_criteria_db"], saved["requested_end_criteria_db"]), (expected, requested))

    def test_default_designer_names_keep_each_submission(self):
        m = JobManager(self.root / "jobs", self.root / "projects", python="/py", autostart=False)
        a = m.submit(model="dipole", model_id="my-dipole", model_path="/m/dipole.design.json")
        b = m.submit(model="dipole", model_id="my-dipole", model_path="/m/dipole.design.json")
        self.assertNotEqual(a.name, b.name)
        self.assertTrue(a.name.startswith("my-dipole-"))
        self.assertEqual(m.default_command(a)[-2:], ["--name", a.name])
        self.assertEqual(json.loads((a.dir / "job.json").read_text())["name"], a.name)
        explicit = [m.submit(model="dipole", model_path="/m/dipole.design.json", name="baseline") for _ in range(2)]
        self.assertEqual([j.name for j in explicit], ["baseline", "baseline"])
        long = m.submit(model="x" * 150, model_path="/m/dipole.design.json")
        self.assertLessEqual(len(long.name), 100)
        self.assertTrue(long.name.endswith(long.id))

    def test_failure(self):
        m = self.manager()
        job = self.submit(m, "fail")
        self.assertTrue(wait_for(lambda: job.terminal))
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.exit_code, 3)
        self.assertEqual(job.error, "ValueError: gap must be smaller than length")
        final = job.events[-1]
        self.assertEqual(final["type"], "status")
        self.assertIn("Traceback (most recent call last):", final["stderr_tail"])
        self.assertIn("! ValueError: gap must be smaller than length", (job.dir / "log.txt").read_text(encoding="utf-8"))

    def test_cancel_kills_process_group(self):
        m = self.manager()
        job = self.submit(m, "hang")
        grandchild = {}

        def seen():
            for e in job.events:
                if e["type"] == "log" and e["line"].startswith("grandchild "):
                    grandchild["pid"] = int(e["line"].split()[1])
                    return True
            return False

        self.assertTrue(wait_for(seen))
        leader = job.pid
        self.assertTrue(alive(grandchild["pid"]))
        # The fake child prints its pid before the running line; the output pump
        # may not have processed that next line when seen() returns.
        self.assertTrue(wait_for(lambda: job.phase == "running"))
        m.cancel(job.id)
        self.assertTrue(wait_for(lambda: job.terminal))
        self.assertEqual(job.status, "cancelled")
        self.assertTrue(wait_for(lambda: not alive(grandchild["pid"]), timeout=5), "grandchild survived")
        self.assertTrue(wait_for(lambda: not alive(leader), timeout=5))

    def test_queue_runs_one_at_a_time_and_cancel_queued(self):
        m = self.manager()
        first = self.submit(m, "slow")
        second = self.submit(m, "ok")
        third = self.submit(m, "ok")
        self.assertTrue(wait_for(lambda: first.status == "running"))
        self.assertEqual(second.status, "queued")
        m.cancel(third.id)
        self.assertEqual(third.status, "cancelled")
        self.assertTrue(wait_for(lambda: second.status == "running", timeout=15))
        self.assertEqual(first.status, "done")
        self.assertLessEqual(first.finished, second.started)
        self.assertTrue(wait_for(lambda: second.terminal))
        self.assertIsNone(third.started)
        energy = [e["energy_db"] for e in first.events if e["type"] == "progress"]
        self.assertEqual(energy, [-8.0, -16.0, -24.0, -32.0, -97.91])
        etas = [e["eta"] for e in first.events if e["type"] == "progress"]
        self.assertEqual(etas[1]["basis"], "energy-fit")

    def test_restart_marks_running_jobs_interrupted(self):
        jobs = self.root / "jobs" / "20260101-000000-abcd"
        jobs.mkdir(parents=True)
        (jobs / "job.json").write_text(json.dumps({"id": "20260101-000000-abcd", "model": "dipole", "status": "running",
                                                   "phase": "running", "created": 1.0, "started": 2.0}))
        m = self.manager()
        job = m.get("20260101-000000-abcd")
        self.assertEqual(job.status, "interrupted")
        self.assertIn("server stopped", job.error)
        self.assertEqual(json.loads((jobs / "job.json").read_text(encoding="utf-8"))["status"], "interrupted")

    def test_history_backfills_band_stats_from_the_log(self):
        d = self.root / "jobs" / "20260101-000000-beef"
        d.mkdir(parents=True)
        (d / "job.json").write_text(json.dumps({"id": "20260101-000000-beef", "model": "dipole", "status": "done",
                                                "phase": "done", "created": 1.0, "started": 2.0, "finished": 9.0,
                                                "stats": {"timesteps": 10}}))
        (d / "log.txt").write_text("$ python -m fairbeam run dipole.py\n"
                                   "fairbeam: 7272 timesteps in 4.0 s, final energy -97.91 dB, converged=True\n"
                                   "  band 2.058-2.475 GHz, min S11 -38.4 dB @ 2.245 GHz\n"
                                   "  far field 2.245 GHz: Dmax 2.06 dBi, rad. efficiency 0.9984\n[exit code 0]\n")
        job = self.manager().get("20260101-000000-beef")
        self.assertEqual(job.stats["bands"][0]["s11_min_db"], -38.4)
        self.assertEqual(json.loads((d / "job.json").read_text(encoding="utf-8"))["stats"]["farfield"][0]["dmax_dbi"], 2.06)

    def test_shutdown_interrupts_running_job(self):
        m = self.manager()
        job = self.submit(m, "hang")
        self.assertTrue(wait_for(lambda: job.phase == "running"))
        m.shutdown(timeout=5)
        self.assertTrue(wait_for(lambda: job.terminal))
        self.assertEqual(job.status, "interrupted")


class OrphanAfterCrash(unittest.TestCase):
    """The server was SIGKILLed while a job ran: on the next start its process group is stopped,
    but only when the recorded pid still is that job's process (Windows: its process tree, matched
    by creation time and command line the same way)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            if p.poll() is None:
                if WINDOWS:  # the venv python.exe is a launcher with the real interpreter as child
                    kill_tree(p.pid)
                else:
                    p.kill()
            p.wait()
        self.tmp.cleanup()

    def spawn(self, seconds: int = 30):
        """A harmless stand-in for an orphaned openEMS run, in its own group like a real job."""
        p = subprocess.Popen(sleeper(seconds), **new_group_kwargs())
        self.procs.append(p)
        self.assertTrue(wait_for(lambda: process_info(p.pid) is not None))
        return p

    def crashed_job(self, job_id, proc, events=None, **fields):
        d = self.root / "jobs" / job_id
        d.mkdir(parents=True)
        data = {"id": job_id, "model": "dipole", "status": "running", "phase": "running", "created": time.time() - 1,
                "started": time.time() - 0.5, "pid": proc.pid, **fields}
        (d / "job.json").write_text(json.dumps(data))
        if events:
            (d / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
        return d

    def start_manager(self):
        return JobManager(self.root / "jobs", self.root / "projects", grace_s=2.0, autostart=False,
                          command_factory=lambda job: [sys.executable, FAKE, "ok", str(self.root / "projects")])

    def test_matching_process_group_is_stopped(self):
        p = self.spawn()
        d = self.crashed_job("20260101-000000-aaaa01", p, command=sleeper(),
                             proc_start=process_info(p.pid)["lstart"])
        m = self.start_manager()
        self.assertIsNotNone(p.wait(timeout=5))  # SIGTERMed
        job = m.get("20260101-000000-aaaa01")
        self.assertEqual(job.status, "interrupted")
        self.assertIn(f"pid {p.pid}) was still running and has been stopped", job.error)
        log = (d / "log.txt").read_text(encoding="utf-8")
        self.assertIn(f"(pid {p.pid}) was still running; stopping its process group", log)
        self.assertTrue(any(e["type"] == "log" and "stopping its process group" in e["line"] for e in job.events))
        self.assertEqual(json.loads((d / "job.json").read_text(encoding="utf-8"))["status"], "interrupted")

    def test_older_job_matched_by_start_time_and_command_event(self):
        # recorded before proc_start/command were saved: started + the "running" status event
        p = self.spawn()
        self.crashed_job("20260101-000000-aaaa02", p, events=[
            {"seq": 1, "type": "status", "status": "queued"},
            {"seq": 2, "type": "status", "status": "running", "pid": p.pid, "command": sleeper()}])
        m = self.start_manager()
        self.assertIsNotNone(p.wait(timeout=5))
        job = m.get("20260101-000000-aaaa02")
        self.assertEqual([e["seq"] for e in job.events], list(range(1, len(job.events) + 1)))

    def test_unmatched_processes_are_left_alone(self):
        other_cmd = self.spawn()  # alive, right start time, but a different command line
        self.crashed_job("20260101-000000-bbbb01", other_cmd, command=sleeper(31),
                         proc_start=process_info(other_cmd.pid)["lstart"])
        recycled = self.spawn()  # alive, right command, but started at another time (a recycled pid)
        self.crashed_job("20260101-000000-bbbb02", recycled, command=sleeper(),
                         proc_start="Mon Jan  1 00:00:00 2024")
        old = self.spawn()  # no recorded start time and job.started long before the process began
        self.crashed_job("20260101-000000-bbbb03", old, command=sleeper(), started=time.time() - 3600)
        nocmd = self.spawn()  # nothing to compare the command line with
        self.crashed_job("20260101-000000-bbbb04", nocmd)
        m = self.start_manager()
        time.sleep(0.3)
        for p in (other_cmd, recycled, old, nocmd):
            self.assertIsNone(p.poll(), f"pid {p.pid} must not be killed")
        for job_id in ("20260101-000000-bbbb01", "20260101-000000-bbbb02", "20260101-000000-bbbb03",
                       "20260101-000000-bbbb04"):
            job = m.get(job_id)
            self.assertEqual(job.status, "interrupted")
            self.assertNotIn("has been stopped", job.error)
            self.assertIn("left alone", (job.dir / "log.txt").read_text(encoding="utf-8"))

    def test_process_already_gone(self):
        p = subprocess.Popen([sys.executable, "-c", ""])
        p.wait()
        d = self.crashed_job("20260101-000000-cccc01", p, command=[sys.executable, "-c", ""])
        job = self.start_manager().get("20260101-000000-cccc01")
        self.assertEqual(job.status, "interrupted")
        self.assertFalse((d / "log.txt").exists())


class OptimizationProgress(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_eval_stats_persist_and_replay(self):
        from fairbeam.progress import ProgressParser

        m = JobManager(self.root / "jobs", self.root / "projects", autostart=False)
        job = Job(self.root / "jobs", id="20260101-000000-eval01", kind="optimize", started=time.time() - 4)
        job.dir.mkdir(parents=True)
        parser = ProgressParser()
        lines = [
            'fairbeam: optimize start {"file":"optimizations/demo.json","max_evals":4}',
            'fairbeam: optimize eval {"index":1,"file":"optimizations/demo/e1.json","params":{"x":1},"cost":3,"goals":[],"metrics":{},"wall_time_s":1.0,"best_index":1,"best_cost":3,"max_evals":4}',
            'fairbeam: optimize eval {"index":2,"file":"optimizations/demo/e2.json","params":{"x":2},"cost":1,"goals":[],"metrics":{},"wall_time_s":1.2,"best_index":2,"best_cost":1,"max_evals":4}',
            'fairbeam: optimize done {"file":"optimizations/demo.json","evaluations":2,"reason":"done","best":{"index":2,"file":"optimizations/demo/e2.json","params":{"x":2},"cost":1},"wall_time_s":3.0}',
        ]
        for line in lines:
            m._handle(job, parser, line, "stdout")
        stats = job.to_dict()["stats"]
        self.assertEqual(stats["evaluations"], 2)
        self.assertEqual(stats["best_index"], 2)
        self.assertEqual(stats["best_cost"], 1)
        self.assertEqual(stats["best_params"], {"x": 2})
        self.assertEqual(stats["best_file"], "optimizations/demo/e2.json")
        self.assertEqual(stats["manifest_file"], "optimizations/demo.json")
        self.assertIsNotNone(stats["elapsed_s"])
        self.assertEqual(stats["eta_s"], 0.0)
        loaded = Job.load(self.root / "jobs", job.dir)
        self.assertEqual(loaded.to_dict()["stats"], stats)
        event_types = [e["type"] for e in loaded.events if e["type"].startswith("opt_")]
        self.assertEqual(event_types, ["opt_start", "opt_eval", "opt_eval", "opt_done"])
        live_evals = [e for e in loaded.events if e["type"] == "opt_eval"]
        self.assertEqual([e["evaluations"] for e in live_evals], [1, 2])
        self.assertEqual(live_evals[-1]["best_params"], {"x": 2})
        self.assertEqual(live_evals[-1]["best_file"], "optimizations/demo/e2.json")
        self.assertIsNotNone(live_evals[-1]["eta_s"])


class CancelledOptimizationManifest(unittest.TestCase):
    """A killed optimizer child leaves its manifest saying "running"; the job manager closes it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.projects = self.root / "projects"
        (self.projects / "optimizations").mkdir(parents=True)
        self.m = JobManager(self.root / "jobs", self.projects, autostart=False)

    def tearDown(self):
        self.tmp.cleanup()

    def _job(self, suffix: str, manifest: str, status: str = "running") -> Job:
        job = Job(self.root / "jobs", id=f"20260101-000000-{suffix}", kind="optimize", status=status,
                  started=time.time(), stats={"manifest_file": manifest})
        job.dir.mkdir(parents=True)
        return job

    def _manifest(self, name: str, reason: str = "running") -> Path:
        path = self.projects / "optimizations" / f"{name}.json"
        path.write_text(json.dumps({"name": name, "reason": reason, "finished": None, "evaluations": [{"index": 1}]}),
                        encoding="utf-8")
        return path

    def test_cancel_records_reason(self):
        path = self._manifest("demo")
        self.m._finish(self._job("canc01", "optimizations/demo.json"), "cancelled", error=None)
        doc = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(doc["reason"], "cancelled")
        self.assertIsNotNone(doc["finished"])
        self.assertEqual(doc["evaluations"], [{"index": 1}])  # the partial history stays

    def test_finished_reason_and_done_jobs_untouched(self):
        path = self._manifest("ended", reason="evaluation budget exhausted")
        self.m._finish(self._job("canc02", "optimizations/ended.json"), "cancelled", error=None)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["reason"], "evaluation budget exhausted")
        path = self._manifest("ok")
        self.m._finish(self._job("canc03", "optimizations/ok.json"), "done", error=None)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["reason"], "running")

    def test_manifest_outside_projects_ignored(self):
        outside = self.root / "outside.json"
        outside.write_text(json.dumps({"reason": "running"}), encoding="utf-8")
        self.m._finish(self._job("canc04", "../outside.json"), "cancelled", error=None)
        self.assertEqual(json.loads(outside.read_text(encoding="utf-8"))["reason"], "running")


class EventMemory(unittest.TestCase):
    """Finished jobs keep only their newest events in memory; the rest is read from events.jsonl."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def big_job(self, n_logs=1200):
        job = Job(self.root / "jobs", id="20260101-000000-dddd01", model="dipole")
        job.dir.mkdir(parents=True)
        job.publish({"type": "status", "status": "queued"})
        job.publish({"type": "status", "status": "running"})
        for i in range(n_logs):
            job.publish({"type": "log", "stream": "stdout", "line": f"line {i}"})
            if i % 100 == 0:
                job.publish({"type": "progress", "timestep": i})
            if i == 300:
                job.publish({"type": "phase", "phase": "running"})
        job.publish({"type": "status", "status": "done"})
        job.status = "done"
        job.save()
        return job

    def check_trimmed(self, job, total):
        self.assertEqual(job.last_seq, total)
        seqs = [e["seq"] for e in job.events]
        self.assertEqual(seqs, sorted(seqs))
        tail = seqs[-Job.MEMORY_EVENTS:]
        self.assertEqual(tail, list(range(total - Job.MEMORY_EVENTS + 1, total + 1)))
        self.assertEqual(job.memory_floor, total - Job.MEMORY_EVENTS)
        kinds = {e["type"] for e in job.events if e["seq"] <= job.memory_floor}
        self.assertEqual(kinds, {"status", "phase"})  # summary events survive, logs/progress do not
        self.assertLess(len(job.events), Job.MEMORY_EVENTS + 10)
        # a client asking for older events still gets the complete, contiguous sequence
        self.assertEqual([e["seq"] for e in job.events_after(0)], list(range(1, total + 1)))
        self.assertEqual([e["seq"] for e in job.events_after(10)], list(range(11, total + 1)))
        self.assertEqual([e["seq"] for e in job.events_after(total - 3)], [total - 2, total - 1, total])
        self.assertEqual(job.events_after(total), [])
        batches = list(job.iter_disk_events(0, batch=500))
        self.assertEqual([len(b) for b in batches][:2], [500, 500])

    def test_trim_on_finish_and_lazy_reload(self):
        job = self.big_job()
        total = job.last_seq
        self.assertEqual(len(job.events), total)  # all of them while it runs
        self.assertEqual(len((job.dir / "events.jsonl").read_text(encoding="utf-8").splitlines()), total)
        job.trim_events()
        self.check_trimmed(job, total)
        self.assertEqual(len((job.dir / "events.jsonl").read_text(encoding="utf-8").splitlines()), total)  # file stays complete

        loaded = Job.load(self.root / "jobs", job.dir)
        self.assertIsNone(loaded._events)  # not read at startup
        self.check_trimmed(loaded, total)
        ev = loaded.publish({"type": "log", "line": "after reload"})
        self.assertEqual(ev["seq"], total + 1)

    def test_manager_trims_finished_and_interrupted_jobs(self):
        job = self.big_job()
        total = job.last_seq
        m = JobManager(self.root / "jobs", self.root / "projects", autostart=False)
        again = m.get(job.id)
        self.assertIsNone(again._events)  # finished jobs are loaded lazily
        self.check_trimmed(again, total)
        # a job that was running when the server died is trimmed after it is marked interrupted
        data = json.loads((job.dir / "job.json").read_text(encoding="utf-8"))
        data["status"] = "running"
        (job.dir / "job.json").write_text(json.dumps(data))
        again = JobManager(self.root / "jobs", self.root / "projects", autostart=False).get(job.id)
        self.assertEqual(again.status, "interrupted")
        self.assertEqual(again.last_seq, total + 1)
        self.assertLessEqual(len(again.events), Job.MEMORY_EVENTS + 10)
        self.assertEqual(len(again.events_after(0)), total + 1)

    def test_finished_run_is_trimmed(self):
        m = JobManager(self.root / "jobs", self.root / "projects", grace_s=1.0,
                       command_factory=lambda job: [sys.executable, FAKE, "ok", str(self.root / "projects")])
        self.addCleanup(m.shutdown, 5)
        m_job = m.submit(model="dipole", model_path="/nonexistent/dipole.py", threads=1)
        m_job.MEMORY_EVENTS = 10  # the fake run has fewer than 500 events
        self.assertTrue(wait_for(lambda: m_job.terminal))
        self.assertTrue(wait_for(lambda: m_job.memory_floor > 0))
        total = m_job.last_seq
        self.assertEqual([e["seq"] for e in m_job.events][-10:], list(range(total - 9, total + 1)))
        self.assertEqual([e["seq"] for e in m_job.events_after(0)], list(range(1, total + 1)))


class RawSimData(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.sim = self.root / ".sim"

    def tearDown(self):
        self.tmp.cleanup()

    def manager(self):
        return JobManager(self.sim / "jobs", self.root / "projects", python="/py", autostart=False, sim_root=self.sim)

    def finished_job(self, m, **kw):
        job = m.submit(model="dipole", model_path="/m/dipole.py", threads=1, **kw)
        m.cancel(job.id)  # still queued: cancelled at once
        return job

    def raw(self, path: Path):
        path.mkdir(parents=True, exist_ok=True)
        (path / "port_ut_1").write_bytes(b"x" * 100)
        (path / "nf2ff_E_0.h5").write_bytes(b"x" * 900)
        return path

    def test_job_writes_to_its_own_folder_and_delete_removes_it(self):
        m = self.manager()
        job = self.finished_job(m)
        self.assertEqual(job.sim_dir, str(self.sim.absolute() / "runs" / job.id))
        cmd = m.default_command(job)
        self.assertEqual(cmd[cmd.index("--sim-root") + 1], job.sim_dir)
        opt = self.finished_job(m, kind="optimize", optimize={"vary": [], "goals": []})
        self.assertIn(opt.sim_dir, m.default_command(opt))
        self.raw(Path(job.sim_dir) / "dipole--length-60")
        res = m.delete(job.id)
        self.assertEqual(res["sim_deleted"], job.sim_dir)
        self.assertEqual(res["sim_freed_bytes"], 1000)
        self.assertFalse(Path(job.sim_dir).exists())
        self.assertTrue((self.sim / "runs").exists() and (self.sim / "jobs").exists())
        # the raw folder is recorded in job.json, so it is found after a restart too
        self.raw(Path(opt.sim_dir) / "x")
        again = self.manager()
        self.assertEqual(again.get(opt.id).sim_dir, opt.sim_dir)
        self.assertEqual(again.delete(opt.id)["sim_freed_bytes"], 1000)

    def test_never_deletes_outside_the_sim_root(self):
        m = self.manager()
        outside = self.raw(self.root / "elsewhere")
        link_target = self.raw(self.root / "linked-target")
        (self.sim / "runs").mkdir(parents=True)
        (self.sim / "runs" / "link").symlink_to(link_target, target_is_directory=True)
        cases = [str(outside), str(self.sim / "runs" / ".." / ".." / "elsewhere"), str(self.sim),
                 str(self.sim / "runs" / "link"), str(self.sim / "jobs"), "relative/path"]
        for sim_dir in cases:
            job = self.finished_job(m)
            job.sim_dir = sim_dir
            res = m.delete(job.id)
            self.assertIsNone(res["sim_deleted"], sim_dir)
            self.assertEqual(res["sim_freed_bytes"], 0)
        self.assertTrue((outside / "port_ut_1").exists())
        self.assertTrue((link_target / "port_ut_1").exists())
        self.assertTrue((self.sim / "runs" / "link").is_symlink())
        self.assertTrue((self.sim / "jobs").is_dir())

    def test_without_sim_root_nothing_changes(self):
        m = JobManager(self.root / "jobs", self.root / "projects", python="/py", autostart=False)
        job = self.finished_job(m)
        self.assertIsNone(job.sim_dir)
        self.assertNotIn("--sim-root", m.default_command(job))
        self.assertIsNone(m.delete(job.id)["sim_deleted"])


if __name__ == "__main__":
    unittest.main()
