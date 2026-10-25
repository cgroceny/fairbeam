"""Stop at the completion/admission boundaries, with real jobs and no solver process."""
import json
from pathlib import Path
import tempfile
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam import convergence as cv
from fairbeam.jobs import JobManager
from fairbeam.server import Handler
from test_convergence import fake_bundle


class ConvergenceCancellationTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.manager = JobManager(self.root / "jobs", self.root, autostart=False)
        self.studies = cv.ServerStudies(self.manager, self.root)
        self.manager.on_finished = self.studies.on_finished

    def start(self, study_id="study", *, planned=None, network_criteria=None):
        return self.studies.start(study_id=study_id, name="Mesh", model={"id": "patch"},
            job_kw={"model": "patch", "model_path": "patch.design.json", "threads": 1},
            planned=planned or [15, 20, 30], tol=dict(cv.DEFAULT_TOL), settings={},
            network_criteria=network_criteria)[1]

    def result(self, job, f_res=2.4e9):
        job.bundle = f"{job.id}.json"
        (self.root / job.bundle).write_text(json.dumps(fake_bundle(f_res)), encoding="utf-8")

    def stop_via_handler(self, study_id="study"):
        responses = []
        handler = SimpleNamespace(app=SimpleNamespace(manager=self.manager, studies=self.studies),
                                  _body=lambda: {}, _json=lambda code, data: responses.append((code, data)))
        Handler._cancel_sweep(handler, study_id)
        self.assertEqual(responses[0][0], 202)
        return responses[0][1]["runs"]

    def thread(self, fn):
        errors = []
        def run():
            try:
                fn()
            except BaseException as exc:
                errors.append(exc)
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread, errors

    def join(self, *tasks):
        # Join every participant before reporting an error, so a failed completion
        # cannot leave cancellation writing into a temporary directory being removed.
        failures = []
        for task in tasks:
            if task is None:
                continue
            thread, errors = task
            thread.join(5)
            if thread.is_alive():
                failures.append(AssertionError("Stop/completion must not deadlock"))
            failures.extend(errors)
        if failures:
            raise failures[0]

    def test_stop_after_terminal_status_before_finished_hook_does_not_admit_next_density(self):
        first = self.start()
        self.result(first)
        terminal, resume = threading.Event(), threading.Event()
        def finished(job):
            terminal.set()
            if not resume.wait(5):
                raise TimeoutError("test completion barrier")
            self.studies.on_finished(job)
        self.manager.on_finished = finished
        task = self.thread(lambda: self.manager._finish(first, "done", error=None))
        try:
            self.assertTrue(terminal.wait(5))
            self.assertTrue(first.terminal)
            self.stop_via_handler()
        finally:
            resume.set()
            self.join(task)
        self.assertEqual(len(self.manager.jobs), 1, "Stop must cover jobs a delayed hook would enqueue")
        study = self.studies.get("study")
        self.assertEqual(study["convergence"]["reason"], "cancelled")
        self.assertIsNone(study["convergence"]["next"])
        self.assertEqual(study["members"][0]["status"], "done", "keep the completed result")
        self.assertEqual(study["members"][0]["file"], first.bundle)
        self.assertTrue(self.studies.load("study")["stop_requested"])
        self.assertEqual(first.sweep["reason"], "cancelled")

    def test_stop_is_seen_while_result_metrics_hold_the_study_lock(self):
        self.assert_stop_during_metrics(None)

    def test_network_stop_is_seen_while_result_metrics_hold_the_study_lock(self):
        from fairbeam.study import parse_network_criteria
        self.assert_stop_during_metrics(parse_network_criteria(["s11:1:0.2"], 2.4))

    def assert_stop_during_metrics(self, network_criteria):
        first = self.start(network_criteria=network_criteria)
        self.result(first)
        reading, resume, requested = threading.Event(), threading.Event(), threading.Event()
        class ObservedSet(set):
            def add(self, value):
                super().add(value)
                requested.set()
        self.studies._stop_requested = ObservedSet()
        original = cv.metrics
        def metrics(bundle, *, network_criteria=None):
            reading.set()
            if not resume.wait(5):
                raise TimeoutError("test metrics barrier")
            return original(bundle, network_criteria=network_criteria)
        with mock.patch.object(cv, "metrics", side_effect=metrics) as measured:
            completing = self.thread(lambda: self.manager._finish(first, "done", error=None))
            stopping = None
            try:
                self.assertTrue(reading.wait(5))
                stopping = self.thread(self.stop_via_handler)
                self.assertTrue(requested.wait(5))
            finally:
                resume.set()
                self.join(completing, stopping)
            self.assertEqual(measured.call_args.kwargs, {"network_criteria": network_criteria})
        self.assertEqual(len(self.manager.jobs), 1)
        self.assertEqual(self.studies.get("study")["convergence"]["reason"], "cancelled")

    def test_submission_already_admitted_is_included_in_cancellation(self):
        first = self.start()
        self.result(first)
        admitted, resume, stopping = threading.Event(), threading.Event(), threading.Event()
        submit = self.manager.submit
        def slow_submit(**kwargs):
            admitted.set()
            if not resume.wait(5):
                raise TimeoutError("test admission barrier")
            return submit(**kwargs)
        def stop():
            stopping.set()
            self.stop_via_handler()
        with mock.patch.object(self.manager, "submit", side_effect=slow_submit):
            completing = self.thread(lambda: self.manager._finish(first, "done", error=None))
            cancelling = None
            try:
                self.assertTrue(admitted.wait(5))
                cancelling = self.thread(stop)
                self.assertTrue(stopping.wait(5))
            finally:
                resume.set()
                self.join(completing, cancelling)
        self.assertEqual(len(self.manager.jobs), 2)
        self.assertEqual([j.status for j in self.manager.jobs.values()], ["done", "cancelled"])
        self.assertEqual(self.studies.get("study")["convergence"]["reason"], "cancelled")

    def test_stop_is_idempotent_persisted_and_does_not_cancel_another_study(self):
        first = self.start()
        other = self.start("other")
        self.stop_via_handler()
        self.stop_via_handler()
        self.assertEqual(first.status, "cancelled")
        self.assertEqual(other.status, "queued")
        reloaded = cv.ServerStudies(self.manager, self.root)
        reloaded.on_finished(first)
        self.assertEqual(len(self.manager.jobs), 2)
        self.assertEqual(reloaded.get("study")["convergence"]["reason"], "cancelled")
        self.assertEqual(len(reloaded.get("study")["members"]), 1)
        self.assertEqual(self.studies._stop_requested, set())
        self.assertEqual(self.studies.cancel("unknown"), [])
        self.assertEqual(self.studies._stop_requested, set())

    def test_completed_verdict_and_ordinary_sweep_are_unchanged(self):
        first = self.start()
        self.result(first)
        self.manager._finish(first, "done", error=None)
        second = list(self.manager.jobs.values())[-1]
        self.result(second)
        self.manager._finish(second, "done", error=None)
        before = self.studies.load("study")
        self.assertEqual(before["convergence"]["reason"], "converged")
        self.stop_via_handler()
        self.assertEqual(self.studies.load("study"), before)
        job = self.manager.submit(model="plain", model_path="plain.py", sweep={"id": "ordinary"})
        self.stop_via_handler("ordinary")
        self.assertEqual(job.status, "cancelled")

    def assert_terminal_verdict_survives_stop(self, reason, *, planned=None, final_status="done",
                                            final_frequency=2.4e9, during_metrics=False):
        planned = planned or [15, 20, 30]
        first = self.start(planned=planned)
        self.result(first)
        self.manager._finish(first, "done", error=None)
        second = list(self.manager.jobs.values())[-1]
        self.assertIsNot(second, first)
        if final_status == "done":
            self.result(second, final_frequency)
        before = [(self.root / job.bundle).read_bytes() for job in (first, second) if job.bundle]
        expected = cv.evaluate([
            {"density": 15, "status": "done", "metrics": cv.metrics(fake_bundle(2.4e9))},
            {"density": 20, "status": final_status,
             "metrics": cv.metrics(fake_bundle(final_frequency)) if final_status == "done" else {}},
        ], planned, cv.DEFAULT_TOL)
        self.assertEqual(expected["reason"], reason, "the fixture must reach its own terminal verdict")
        terminal, resume, requested = threading.Event(), threading.Event(), threading.Event()
        def wait_at_terminal():
            terminal.set()
            if not resume.wait(5):
                raise TimeoutError("test terminal-verdict barrier")
        original_metrics = cv.metrics
        def paused_metrics(bundle, *, network_criteria=None):
            wait_at_terminal()
            return original_metrics(bundle, network_criteria=network_criteria)
        def finished(job):
            if not during_metrics:
                wait_at_terminal()
            self.studies.on_finished(job)
        class ObservedSet(set):
            def add(self, value):
                super().add(value)
                requested.set()
        self.studies._stop_requested = ObservedSet()
        self.manager.on_finished = finished
        with mock.patch.object(cv, "metrics", side_effect=paused_metrics if during_metrics else original_metrics):
            completing = self.thread(lambda: self.manager._finish(
                second, final_status, error="solver failed" if final_status == "failed" else None))
            stopping = None
            try:
                self.assertTrue(terminal.wait(5))
                self.assertTrue(second.terminal)
                if during_metrics:
                    # The completion holds the study lock, so Stop must first latch its intent.
                    stopping = self.thread(self.stop_via_handler)
                    self.assertTrue(requested.wait(5))
                else:
                    self.stop_via_handler()
            finally:
                resume.set()
                self.join(completing, stopping)
        study = self.studies.load("study")
        self.assertEqual(study["convergence"], expected)
        self.assertEqual(len(self.manager.jobs), 2, "Stop must never admit another density")
        self.assertEqual([member["status"] for member in study["members"]], ["done", final_status])
        self.assertEqual([member["file"] for member in study["members"]], [first.bundle, second.bundle])
        self.assertEqual([(self.root / job.bundle).read_bytes() for job in (first, second) if job.bundle], before)
        for job in (first, second):
            saved = json.loads((job.dir / "job.json").read_text(encoding="utf-8"))
            self.assertEqual(saved["sweep"]["reason"], reason)
            self.assertEqual(saved["sweep"]["verdict"], expected["verdict"])
            self.assertEqual(saved["sweep"]["converged_at"], expected["converged_at"])

    def test_stop_before_delayed_converging_second_hook_preserves_converged_verdict(self):
        self.assert_terminal_verdict_survives_stop("converged")

    def test_stop_before_delayed_last_hook_preserves_exhausted_verdict(self):
        self.assert_terminal_verdict_survives_stop("exhausted", planned=[15, 20], final_frequency=2.6e9)

    def test_stop_before_delayed_failed_hook_preserves_failed_verdict(self):
        self.assert_terminal_verdict_survives_stop("failed", final_status="failed")

    def test_stop_during_converging_metrics_preserves_converged_verdict(self):
        self.assert_terminal_verdict_survives_stop("converged", during_metrics=True)

    def test_unreadable_or_malformed_study_does_not_block_stopping_existing_jobs(self):
        for index, data in enumerate(("[1, 2]", "null", "{}", "{not json}")):
            with self.subTest(data=data):
                study_id = f"malformed-{index}"
                first = self.start(study_id)
                self.studies.path(study_id).write_text(data, encoding="utf-8")
                self.stop_via_handler(study_id)
                self.assertEqual(first.status, "cancelled")
                self.assertIn(study_id, self.studies._stop_requested)

    def test_write_failure_still_stops_queued_jobs_and_retains_the_stop(self):
        first = self.start()
        with mock.patch.object(cv, "write_study", side_effect=PermissionError("read-only study folder")):
            with self.assertLogs("fairbeam.convergence", level="WARNING"):
                self.stop_via_handler()
        self.assertEqual(first.status, "cancelled")
        self.assertTrue(first.cancel_requested)
        self.assertIn("study", self.studies._stop_requested)
        self.assertEqual(len(self.manager.jobs), 1)
        # Retrying once the folder is writable persists the intent and clears memory.
        self.stop_via_handler()
        self.assertTrue(self.studies.load("study")["stop_requested"])
        self.assertNotIn("study", self.studies._stop_requested)

    def test_write_failure_cannot_reenable_a_delayed_completion_hook(self):
        first = self.start()
        self.result(first)
        self.manager.on_finished = None
        self.manager._finish(first, "done", error=None)
        with mock.patch.object(cv, "write_study", side_effect=OSError("disk full")):
            with self.assertLogs("fairbeam.convergence", level="WARNING"):
                self.stop_via_handler()
        self.studies.on_finished(first)
        self.assertEqual(len(self.manager.jobs), 1)
        self.assertEqual(self.studies.load("study")["convergence"]["reason"], "cancelled")
        self.assertEqual(self.studies.load("study")["members"][0]["file"], first.bundle)

    def test_transient_read_failure_cannot_reenable_a_delayed_completion_hook(self):
        first = self.start()
        self.result(first)
        self.manager.on_finished = None
        self.manager._finish(first, "done", error=None)
        with mock.patch.object(self.studies, "load", return_value=None):
            self.stop_via_handler()
        self.studies.on_finished(first)
        self.assertEqual(len(self.manager.jobs), 1)
        self.assertEqual(self.studies.load("study")["convergence"]["reason"], "cancelled")


if __name__ == "__main__":
    unittest.main()
