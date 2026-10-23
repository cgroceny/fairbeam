"""Designer network criteria admission, immutable queued jobs and persisted verdicts; no solver."""
import json
from pathlib import Path
import tempfile
import unittest

from fairbeam import convergence as cv
from fairbeam.jobs import Job
from fairbeam.server import ApiError
from fairbeam.study import network_criteria_request
import test_convergence as fixtures
from test_network_convergence import bundle, config


class NetworkRequestTest(unittest.TestCase):
    def test_canonical_criteria_reuse_cli_and_physical_port_numbers(self):
        result = network_criteria_request({"frequency_ghz": 2.4, "metrics": ["phase:30,20,10:1"]}, [10, 20, 30])
        self.assertEqual(result["frequency_hz"], 2.4e9)
        self.assertEqual(result["criteria"], [{"key": "phase:30,20,10", "kind": "phase", "ports": [30, 20, 10], "tolerance": 1, "unit": "deg"}])

    def test_malformed_requests_fail_closed(self):
        valid = {"frequency_ghz": 2.4, "metrics": ["coupling:2,1:0.2"]}
        for value in (None, [], {}, {**valid, "extra": True}, {**valid, "frequency_ghz": True},
                      {**valid, "frequency_ghz": 10 ** 400}, {**valid, "frequency_ghz": float("nan")},
                      {**valid, "metrics": "coupling:2,1:0.2"}, {**valid, "metrics": []},
                      {**valid, "metrics": [None]}, {**valid, "metrics": valid["metrics"] * 13},
                      {**valid, "metrics": ["coupling:3,1:0.2"]},
                      {**valid, "metrics": ["phase:2,2,1:1"]}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                network_criteria_request(value, [1, 2])


class NetworkApiTest(unittest.TestCase):
    setUp = fixtures.ApiTest.setUp

    def test_request_and_jobs_round_trip_without_mutating_design(self):
        path = self.models / "patch_cv.design.json"
        original = path.read_bytes()
        body = {"model": "patch_cv", "threads": 1, "densities": [15, 20], "max_runs": 2,
                "network_criteria": {"frequency_ghz": 2.4, "metrics": ["s11:1:0.2"]}}
        response = self.app.submit_convergence(body)
        study = response["study"]
        self.assertEqual(study["network_criteria"]["frequency_hz"], 2.4e9)
        self.assertEqual(study["excite"], "all")
        self.assertNotIn("job_kw", study)
        job = self.manager.jobs[response["runs"][0]["id"]]
        restored = Job.load(self.manager.root, job.dir)
        self.assertEqual(restored.excite, "all")
        cmd = self.manager.default_command(restored)
        self.assertEqual(cmd[cmd.index("--excite") + 1], "all")
        self.assertEqual(path.read_bytes(), original)
        disk = json.loads(self.app.studies.path(study["id"]).read_text(encoding="utf-8"))
        self.assertEqual(disk["network_criteria"], study["network_criteria"])
        self.assertEqual(disk["job_kw"]["excite"], "all")
        self.assertEqual(Path(self.manager.input_path(restored)).read_bytes(), original)

    def test_opt_out_leaves_legacy_study_and_command_unchanged(self):
        response = self.app.submit_convergence({"model": "patch_cv", "threads": 1})
        self.assertNotIn("network_criteria", response["study"])
        self.assertNotIn("excite", response["study"])
        job = self.manager.jobs[response["runs"][0]["id"]]
        self.assertNotIn("--excite", self.manager.default_command(job))

    def test_invalid_network_request_admits_no_jobs(self):
        for request in (None, {"frequency_ghz": 2.4, "metrics": ["coupling:9,1:1"]},
                        {"frequency_ghz": -1, "metrics": ["s11:1:1"]}):
            with self.subTest(request=request), self.assertRaises(ApiError) as error:
                self.app.submit_convergence({"model": "patch_cv", "network_criteria": request})
            self.assertEqual(error.exception.status, 422)
            self.assertIn("network_criteria", error.exception.extra["fields"])
        self.assertEqual(self.manager.list(), [])


class NetworkStudyTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.manager = fixtures.FakeManager(self.root)
        self.studies = cv.ServerStudies(self.manager, self.root)

    def start(self):
        return self.studies.start(study_id="cv-network", name="Network", model={"id": "network"},
                                  job_kw={"model": "network", "name": "network", "excite": "all"},
                                  planned=[15, 20, 30], tol=dict(cv.DEFAULT_TOL), settings={}, network_criteria=config())

    def finish(self, job, result):
        job.status, job.terminal, job.bundle = "done", True, f"{job.kw['name']}.json"
        (self.root / job.bundle).write_text(json.dumps(result), encoding="utf-8")
        self.studies.on_finished(job)

    def test_network_changes_control_serial_chain_and_survive_reload(self):
        _, first = self.start()
        self.finish(first, bundle())
        self.studies = cv.ServerStudies(self.manager, self.root)
        self.finish(self.manager.submitted[1], bundle(coupling=21))
        self.assertEqual(len(self.manager.submitted), 3, "stable legacy metrics cannot hide coupling drift")
        self.assertTrue(all(job.kw["excite"] == "all" for job in self.manager.submitted))
        self.finish(self.manager.submitted[2], bundle(coupling=21.01))
        report = self.studies.get("cv-network")
        self.assertTrue(report["convergence"]["converged"])
        self.assertEqual(report["convergence"]["converged_at"], 20)
        self.assertFalse(report["convergence"]["steps"][0]["network"]["converged"])
        self.assertAlmostEqual(report["members"][1]["metrics"]["network"]["values"][0]["value"], 21, delta=0.01)

    def test_unavailable_or_unconverged_measurement_cannot_pass(self):
        for failure in ("column", "precision", "frequency", "energy"):
            with self.subTest(failure=failure):
                result, criteria = bundle(), config()
                if failure == "column":
                    result["results"]["sparams"]["s"].pop("3,1")
                elif failure == "precision":
                    v = result["results"]["sparams"]["s"]["3,1"]
                    v["re"], v["im"] = [0] * len(v["re"]), [0] * len(v["im"])
                elif failure == "frequency":
                    criteria["frequency_hz"] = 99e9
                else:
                    result["run"]["converged"] = False
                metrics = cv.metrics(result, network_criteria=criteria)
                report = cv.evaluate([{"density": d, "metrics": metrics} for d in (15, 20)], [15, 20], network_criteria=criteria)
                self.assertFalse(report["converged"])
                self.assertFalse(report["steps"][0]["network"]["converged"])

    def test_declared_criteria_cannot_disappear_or_reuse_stale_cached_pass(self):
        metrics = cv.metrics(bundle())
        members = [{"density": d, "metrics": metrics} for d in (15, 20)]
        self.assertTrue(cv.evaluate(members, [15, 20])["converged"])
        self.assertFalse(cv.evaluate(members, [15, 20], network_criteria=config())["converged"])
        report = cv.new_study(name="Network", model={}, planned=[15, 20], tol=dict(cv.DEFAULT_TOL), study_id="cv-stale")
        report.update(network_criteria=config(), members=members, convergence=cv.evaluate(members, [15, 20]))
        cv.write_study(report, self.studies.path("cv-stale"))
        before = self.studies.path("cv-stale").read_bytes()
        loaded = self.studies.get("cv-stale")
        self.assertFalse(loaded["convergence"]["converged"])
        self.assertEqual(loaded["convergence"]["reason"], "unverified")
        self.assertIn("network measurements", loaded["convergence"]["verdict"])
        self.assertEqual(self.studies.path("cv-stale").read_bytes(), before)

    def test_reopened_report_rechecks_requested_frequency_and_measured_values(self):
        for failure in ("frequency", "criteria", "values", "missing-values", "null-entry", "empty-entry",
                        "string-value", "bool-value", "energy"):
            with self.subTest(failure=failure):
                metrics = cv.metrics(bundle(), network_criteria=config())
                members = [{"density": d, "metrics": metrics} for d in (15, 20)]
                report = cv.new_study(name="Network", model={}, planned=[15, 20], tol=dict(cv.DEFAULT_TOL), study_id="cv-cached")
                report.update(network_criteria=config(), members=members,
                              convergence=cv.evaluate(members, [15, 20], network_criteria=config()))
                self.assertTrue(report["convergence"]["converged"])
                if failure == "frequency":
                    report["network_criteria"]["frequency_hz"] = 2.5e9
                elif failure == "criteria":
                    report["network_criteria"]["criteria"][0]["tolerance"] = 0.01
                elif failure == "values":
                    metrics["network"]["values"] = []
                elif failure == "missing-values":
                    del metrics["network"]["values"]
                elif failure == "null-entry":
                    metrics["network"]["values"] = [None]
                elif failure == "empty-entry":
                    metrics["network"]["values"] = [{}]
                elif failure == "string-value":
                    metrics["network"]["values"] = [{"value": "20 dB"}]
                elif failure == "bool-value":
                    metrics["network"]["values"] = [{"value": True}]
                else:
                    metrics["network"]["solver_converged"] = False
                cv.write_study(report, self.studies.path("cv-cached"))
                before = self.studies.path("cv-cached").read_bytes()
                loaded = self.studies.get("cv-cached")
                self.assertFalse(loaded["convergence"]["converged"])
                self.assertFalse(loaded["convergence"]["steps"][0]["network"]["converged"])
                self.assertEqual(self.studies.path("cv-cached").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
