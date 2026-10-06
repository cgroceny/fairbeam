"""Raw simulation data: running markers, contained removal, `fairbeam clean-sim`, and the removal of
each optimization evaluation's raw folder (with a fake run_model; nothing is simulated)."""

import io
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

from fairbeam import simdata  # noqa: E402
from fairbeam.simdata import clean_sim, mark_running, marker_path, remove_inside  # noqa: E402

MODELS = Path(__file__).resolve().parents[1] / "models"
DAY = 86400.0


def make_run(path: Path, age_days: float = 0.0, size: int = 1000) -> Path:
    """A fake openEMS run folder: probe files and an NF2FF dump, all dated ``age_days`` ago."""
    path.mkdir(parents=True, exist_ok=True)
    for name in ("et", "ht", "port_ut_1", "port_it_1", "nf2ff_E_0.h5"):
        (path / name).write_bytes(b"x" * size)
    age(path, age_days)
    return path


def age(path: Path, days: float):
    t = time.time() - days * DAY
    # Windows cannot set the time of a link itself (and these fake runs contain none)
    nofollow = {"follow_symlinks": False} if os.utime in os.supports_follow_symlinks else {}
    for dirpath, dirnames, filenames in os.walk(path):
        for n in filenames:
            os.utime(os.path.join(dirpath, n), (t, t), **nofollow)
    for dirpath, dirnames, filenames in sorted(os.walk(path), key=lambda w: -len(w[0])):
        os.utime(dirpath, (t, t))


def dead_pid() -> int:
    p = subprocess.Popen([sys.executable, "-c", ""])  # `true` does not exist on Windows
    p.wait()
    return p.pid


class Markers(unittest.TestCase):
    def test_marker_next_to_the_folder_nested_and_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "sim" / "dipole"
            marker = marker_path(run)
            self.assertEqual(marker, Path(tmp) / "sim" / ".dipole.fairbeam-running")
            with mark_running(run):
                self.assertEqual(marker.read_text(encoding="utf-8").strip(), str(os.getpid()))
                with mark_running(str(run)):  # nested (cli.cmd_run around multiport.run_model)
                    pass
                self.assertTrue(marker.exists(), "the inner block must not remove the outer marker")
                self.assertTrue(simdata.in_use(run, Path(tmp) / "sim"))
            self.assertFalse(marker.exists())


class RemoveInside(unittest.TestCase):
    def test_containment(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            root = tmp / ".sim"
            run = make_run(root / "runs" / "job1" / "dipole")
            outside = make_run(tmp / "elsewhere")
            self.assertIsNone(remove_inside(root, outside))  # outside the root
            self.assertIsNone(remove_inside(root, root))  # the root itself
            self.assertIsNone(remove_inside(root, root / "runs" / ".." / ".." / "elsewhere"))
            self.assertIsNone(remove_inside(root, Path("runs/job1")))  # relative: refused
            (root / "runs" / "link").symlink_to(outside, target_is_directory=True)
            self.assertIsNone(remove_inside(root, root / "runs" / "link"))  # symlink out of the root
            self.assertIsNone(remove_inside(root, root / "runs", protect=(root / "runs" / "job1" / "dipole",)))
            self.assertTrue((outside / "et").exists())
            freed = remove_inside(root, root / "runs" / "job1")
            self.assertEqual(freed, 5000)
            self.assertFalse(run.exists())
            self.assertTrue(root.exists() and (outside / "et").exists())


class CleanSim(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.root = base / ".sim"
        self.old = make_run(self.root / "patch-antenna", 10)
        (self.old / ".sim").mkdir()  # nested leftovers go with their run folder
        (self.old / ".sim" / "x").write_text("x")
        age(self.old, 10)
        self.recent = make_run(self.root / "dipole", 1)
        self.study_a = make_run(self.root / "my-study" / "dipole--length-50", 9)
        self.study_b = make_run(self.root / "my-study" / "dipole--length-60", 9)
        self.multi = self.root / "runs" / "20260101-000000-abcdef" / "coupler"
        make_run(self.multi / "excite-1", 8)
        make_run(self.multi / "excite-2", 8)
        marker_path(self.multi).write_text(f"{dead_pid()}\n")  # left by a run that was killed
        self.running = make_run(self.root / "runs" / "20260101-000000-beef00" / "patch", 30)
        marker_path(self.running).write_text(f"{os.getpid()}\n")  # a live process uses it
        self.fresh = make_run(self.root / "fresh", 0)
        # history folders are never touched, even when they look like run output
        self.jobs = make_run(self.root / "jobs" / "20250101-000000-aaaaaa", 100)
        (self.jobs / "job.json").write_text("{}")
        self.history = self.root / "model-history" / "dipole"
        self.history.mkdir(parents=True)
        (self.history / "20250101-000000.py").write_text("# old")
        age(self.root / "model-history", 100)
        self.outside = make_run(base / "outside", 100)
        try:  # a link out of the sim folder must not be followed
            (self.root / "linked").symlink_to(self.outside, target_is_directory=True)
        except OSError:  # Windows without developer mode or admin rights: no symlinks to test
            pass
        (self.root / "serve.log").write_text("log")

    def tearDown(self):
        self.tmp.cleanup()

    def test_dry_run_lists_and_keeps_everything(self):
        res = clean_sim(self.root, older_than_days=7, dry_run=True)
        removed = sorted(p.relative_to(self.root.resolve()).as_posix() for p, _ in res["removed"])
        self.assertEqual(removed, ["my-study/dipole--length-50", "my-study/dipole--length-60", "patch-antenna",
                                   "runs/20260101-000000-abcdef/coupler/excite-1",
                                   "runs/20260101-000000-abcdef/coupler/excite-2"])
        self.assertEqual(res["freed"], 5 * 5000 + 1)
        self.assertTrue(self.old.exists() and self.study_a.exists())
        self.assertIn((self.running.resolve(), "running"), res["skipped"])

    def test_removes_old_runs_only(self):
        res = clean_sim(self.root, older_than_days=7)
        self.assertEqual(len(res["removed"]), 5)
        self.assertEqual(res["freed"], 5 * 5000 + 1)
        for gone in (self.old, self.study_a, self.study_b, self.multi):
            self.assertFalse(gone.exists(), gone)
        self.assertFalse((self.root / "my-study").exists(), "emptied parent folders are pruned")
        self.assertFalse((self.root / "runs" / "20260101-000000-abcdef").exists())
        self.assertFalse(marker_path(self.multi).exists(), "stale marker removed")
        for kept in (self.recent, self.running, self.fresh, self.jobs / "job.json", self.history,
                     self.outside / "et", self.root / "serve.log", self.root / "runs"):
            self.assertTrue(kept.exists(), kept)
        self.assertTrue(marker_path(self.running).exists())

        # --older-than 0: everything not in use; a folder written in the last 10 minutes is in use
        res = clean_sim(self.root, older_than_days=0)
        self.assertFalse(self.recent.exists())
        self.assertTrue(self.fresh.exists() and self.running.exists())
        reasons = dict((str(p), r) for p, r in res["skipped"])
        self.assertEqual(reasons[str(self.fresh.resolve())], "written in the last 10 minutes")
        self.assertTrue((self.outside / "et").exists())

    def test_cli(self):
        from fairbeam.cli import main

        out = io.StringIO()
        with redirect_stdout(out):
            rc = main(["clean-sim", "--sim-root", str(self.root), "--older-than", "7", "--dry-run"])
        self.assertEqual(rc, 0)
        text = out.getvalue()
        self.assertIn("would remove", text)
        self.assertIn(f"would free 24.4 KB ({5 * 5000 + 1} bytes)", text)
        self.assertTrue(self.old.exists())
        out = io.StringIO()
        with redirect_stdout(out):
            main(["clean-sim", "--sim-root", str(self.root)])
        self.assertIn("freed 24.4 KB", out.getvalue())
        self.assertFalse(self.old.exists())
        self.assertTrue(self.recent.exists())
        out = io.StringIO()
        with redirect_stdout(out):
            main(["clean-sim", "--sim-root", str(Path(self.tmp.name) / "missing")])
        self.assertIn("no sim folder", out.getvalue())


class FakeSim:
    def to_bundle(self, model, params, name=None):
        return {"schema": "fairbeam.project/1", "name": name, "model": {"id": model["id"]}, "results": {}}


class OptimizationRawData(unittest.TestCase):
    """Each evaluation's raw folder is removed as soon as its bundle is written."""

    def run_opt(self, tmp: Path, **kw):
        from fairbeam.optimize import Vary, make_goal, run_optimization

        seen = []

        def fake_run_model(module, values, *, sim_path, **_):
            make_run(Path(sim_path))
            seen.append(Path(sim_path))
            return FakeSim()

        def metrics(bundle, goals):
            length = bundle["optimization"]["point"]["length"]
            return {"f0_ghz": round(139.2 / length, 6), "s11_at": {}, "bw_mhz": 400.0}

        with mock.patch("fairbeam.multiport.run_model", fake_run_model), \
                mock.patch("fairbeam.optimize.bundle_metrics", metrics):
            doc = run_optimization(str(MODELS / "dipole.py"), [Vary("length", 50, 70)], [make_goal("f0", 2.4)],
                                   name="t-opt", out=tmp / "projects", sim_root=tmp / ".sim", max_evals=3,
                                   log=lambda *a: None, **kw)
        return doc, seen

    def test_raw_folders_removed_after_each_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / ".sim").mkdir()
            with mock.patch.dict(os.environ, {"FAIRBEAM_KEEP_SIM": ""}), redirect_stdout(io.StringIO()):
                doc, seen = self.run_opt(tmp)
            self.assertTrue(seen)
            self.assertTrue(all(tmp / ".sim" / "optimizations" / "t-opt" in p.parents for p in seen))
            self.assertFalse(any(p.exists() for p in seen))
            self.assertFalse((tmp / ".sim" / "optimizations").exists(), "empty parents pruned")
            self.assertTrue((tmp / ".sim").exists())
            self.assertEqual(len(list((tmp / "projects" / "optimizations" / "t-opt").glob("*.json"))), len(seen))

    def test_keep_sim(self):
        for kw, env in (({"keep_sim": True}, ""), ({}, "1")):
            with tempfile.TemporaryDirectory() as tmp:
                tmp = Path(tmp)
                with mock.patch.dict(os.environ, {"FAIRBEAM_KEEP_SIM": env}), redirect_stdout(io.StringIO()):
                    doc, seen = self.run_opt(tmp, **kw)
                self.assertTrue(seen and all((p / "et").exists() for p in seen), (kw, env))


if __name__ == "__main__":
    unittest.main()
