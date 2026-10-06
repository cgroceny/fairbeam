"""Behaviour that differs between operating systems unless the code pins it down: line endings and
encodings of the files fairbeam writes, child output decoding, and process identification."""

import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.cli import rebuild_index  # noqa: E402
from fairbeam.jobs import JobManager, process_info  # noqa: E402
from fairbeam.procutil import (WINDOWS, kill_tree, new_group_kwargs, pid_alive, popen_group,  # noqa: E402
                               release_group, terminate_group, windows_process_info)

TEXT = "Dipole · 50 Ω µm → ok"  # middle dot, Omega (not in cp1252), micro, arrow


def wait_for(pred, timeout=30.0, step=0.02):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pred():
            return True
        time.sleep(step)
    return False


class FilesWritten(unittest.TestCase):
    def test_index_json_is_utf8_with_lf(self):
        # index.json is committed: CRLF on Windows would show up as a change to every line
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "a.json").write_text(json.dumps({"schema": "fairbeam.project/1", "name": TEXT,
                                                        "model": {"id": "dipole"}}), encoding="utf-8")
            rebuild_index(Path(d))
            raw = (Path(d) / "index.json").read_bytes()
            self.assertNotIn(b"\r\n", raw)
            self.assertEqual(json.loads(raw.decode("utf-8"))["projects"][0]["name"], TEXT)

    def test_index_tells_runs_of_one_model_apart(self):
        # the viewer's pickers (src/lib/projectLabels.ts) add the engine / changed parameters to
        # names that repeat; bundles without a run or with default parameters get no extra fields
        def bundle(run, params):
            return {"schema": "fairbeam.project/1", "name": "Win patch", "results": {"bands": []},
                    "model": {"id": "patch", "params": params}, "run": run}
        p = [{"key": "L", "default": 29.5, "value": 29.5}, {"key": "W", "default": 38.0, "value": 40.0}]
        files = {
            "win-cpu.json": bundle({"engine": "cpu", "host": {"os": "Windows"}}, p[:1]),
            "win-cuda.json": bundle({"engine": "gpu", "host": {"os": "Windows"},
                                     "log_tail": ["Create FDTD engine (GPU, backend: CUDA (RTX 4070))"]}, p),
            "mac-gpu.json": bundle({"engine": "gpu", "host": {"os": "Darwin"}}, []),
            "old.json": bundle({"threads": 4}, []),
            "geometry.json": {"schema": "fairbeam.project/1", "name": "Win patch", "model": {"id": "patch"}},
        }
        with tempfile.TemporaryDirectory() as d:
            for name, b in files.items():
                (Path(d) / name).write_text(json.dumps(b), encoding="utf-8")
            rebuild_index(Path(d))
            rows = {e["file"]: e for e in json.loads((Path(d) / "index.json").read_text("utf-8"))["projects"]}
        self.assertEqual(rows["win-cpu.json"]["engine"], "CPU")
        self.assertNotIn("params", rows["win-cpu.json"])
        self.assertEqual(rows["win-cuda.json"]["engine"], "CUDA")
        self.assertEqual(rows["win-cuda.json"]["params"], {"W": 40.0})
        self.assertEqual(rows["mac-gpu.json"]["engine"], "Metal")
        self.assertEqual(rows["old.json"]["engine"], "CPU")  # bundles from before the GPU engine
        self.assertNotIn("engine", rows["geometry.json"])


class ChildOutput(unittest.TestCase):
    def test_non_ascii_output_of_a_job(self):
        # the child prints characters outside the Windows ANSI code page; the job must see them intact
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            code = f"print({TEXT!r}); import sys; print({TEXT!r}, file=sys.stderr)"
            m = JobManager(root / "jobs", root / "projects", grace_s=1.0,
                           command_factory=lambda job: [sys.executable, "-c", code])
            self.addCleanup(m.shutdown, 5)
            job = m.submit(model="dipole", model_path="/nonexistent/dipole.py", threads=1)
            self.assertTrue(wait_for(lambda: job.terminal))
            lines = [e["line"] for e in job.events if e["type"] == "log"]
            self.assertEqual(lines.count(TEXT), 2, lines)
            log = (job.dir / "log.txt").read_bytes().decode("utf-8")
            self.assertIn(TEXT + "\n", log)
            self.assertIn("! " + TEXT + "\n", log)
            self.assertNotIn("\r\n", log)


@unittest.skipUnless(WINDOWS, "Windows process queries")
class WindowsProcesses(unittest.TestCase):
    def test_process_info_of_a_child(self):
        cmd = [sys.executable, "-c", "import time; time.sleep(30)"]
        before = time.time()
        p = subprocess.Popen(cmd, **new_group_kwargs())
        self.addCleanup(p.wait)
        self.addCleanup(kill_tree, p.pid)
        self.assertTrue(wait_for(lambda: windows_process_info(p.pid) is not None))
        info = windows_process_info(p.pid)
        self.assertLess(abs(info["start"] - before), 5.0)
        self.assertEqual(info["command"], subprocess.list2cmdline(cmd))
        self.assertIn(subprocess.list2cmdline(cmd[1:]), process_info(p.pid)["command"])
        self.assertTrue(pid_alive(p.pid))
        kill_tree(p.pid)
        p.wait(timeout=10)
        self.assertFalse(pid_alive(p.pid))
        self.assertIsNone(windows_process_info(p.pid))

    def test_job_object_takes_the_whole_tree(self):
        # the leader starts a grandchild and exits: releasing its group must stop the grandchild,
        # which neither CTRL_BREAK (sent to a dead leader) nor taskkill /T (no parent left) reaches
        code = ("import subprocess, sys; "
                "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); print(p.pid)")
        proc = popen_group([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
        self.assertIsNotNone(proc.win_job)
        grandchild = int(proc.stdout.readline())
        proc.wait(timeout=30)
        proc.stdout.close()
        self.assertTrue(pid_alive(grandchild))
        release_group(proc)
        self.assertTrue(wait_for(lambda: not pid_alive(grandchild), timeout=10), "grandchild survived")

    def test_terminate_stops_what_ignores_ctrl_break(self):
        stubborn = "import signal, time; signal.signal(signal.SIGBREAK, signal.SIG_IGN); time.sleep(60)"
        code = ("import subprocess, sys, time; "
                f"p = subprocess.Popen([sys.executable, '-c', {stubborn!r}]); print(p.pid, flush=True); "
                "time.sleep(60)")
        proc = popen_group([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
        self.addCleanup(release_group, proc)
        grandchild = int(proc.stdout.readline())
        time.sleep(1.0)  # let the grandchild install its handler

        def waited(t):
            try:
                proc.wait(timeout=t)
                return True
            except subprocess.TimeoutExpired:
                return False

        terminate_group(proc.pid, grace=5.0, wait=waited, job=proc.win_job)
        self.assertTrue(waited(10))
        proc.stdout.close()
        self.assertTrue(wait_for(lambda: not pid_alive(grandchild), timeout=10), "grandchild survived")

    def test_no_such_process(self):
        self.assertIsNone(windows_process_info(0))
        self.assertIsNone(process_info(0))


if __name__ == "__main__":
    unittest.main()
