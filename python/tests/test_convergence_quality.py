"""Stable numerical summaries cannot validate an unfinished or unresolved run."""
import copy
import unittest

from fairbeam import convergence as cv
from fairbeam.study import convergence_report, summarize
from test_convergence import fake_bundle


class ConvergenceQualityTest(unittest.TestCase):
    def pair(self, edit):
        a = fake_bundle(2.4e9)
        b = copy.deepcopy(a)
        edit(b)
        return a, b

    def test_energy_failure_or_missing_status_never_passes_either_path(self):
        for status in (False, None):
            a, b = self.pair(lambda b: b["run"].update(converged=status))
            for first, last in ((a, b), (b, a)):
                with self.subTest(status=status):
                    step = cv.compare(cv.metrics(first), cv.metrics(last), cv.DEFAULT_TOL)
                    self.assertTrue(all(v is not False for v in step["ok"].values()))
                    self.assertFalse(step["quality"]["energy"])
                    self.assertFalse(step["converged"])
                    self.assertFalse(convergence_report([summarize(first), summarize(last)])["converged"])

    def test_one_unfinished_port_invalidates_multiport_summary(self):
        a, b = self.pair(lambda b: b["run"].update(port_runs=[{"converged": True}, {"converged": False}]))
        self.assertFalse(summarize(b)["converged"])
        self.assertFalse(cv.compare(cv.metrics(a), cv.metrics(b), cv.DEFAULT_TOL)["converged"])

    def test_local_resolution_failure_cannot_be_hidden_by_same_resonance(self):
        a, b = self.pair(lambda b: b["mesh"].update(auto={"fine_features": [{"kind": "feed", "resolved": False}]}))
        step = cv.compare(cv.metrics(a), cv.metrics(b), cv.DEFAULT_TOL)
        self.assertTrue(step["quality"]["energy"])
        self.assertFalse(step["quality"]["local_mesh"])
        self.assertFalse(step["converged"])
        self.assertFalse(convergence_report([summarize(a), summarize(b)])["converged"])
        members = [{"density": 20 + 10*i, "status": "done", "metrics": cv.metrics(item)}
                   for i, item in enumerate((a, b))]
        result = cv.evaluate(members, [20, 30])
        self.assertFalse(result["converged"])
        self.assertEqual(result["verdict"], cv.NOT_VERIFIED)

    def test_good_runs_still_pass(self):
        a, b = self.pair(lambda b: b["mesh"].update(auto={"fine_features": [{"kind": "feed", "resolved": True}]}))
        self.assertTrue(cv.compare(cv.metrics(a), cv.metrics(b), cv.DEFAULT_TOL)["converged"])
        self.assertTrue(convergence_report([summarize(a), summarize(b)])["converged"])

    def test_invalid_pair_does_not_stop_before_a_later_valid_pair(self):
        bad = fake_bundle(2.4e9)
        bad["run"]["converged"] = False
        members = [{"density": d, "status": "done", "metrics": cv.metrics(b)}
                   for d, b in ((20, bad), (30, fake_bundle(2.4e9)), (40, fake_bundle(2.4e9)))]
        self.assertFalse(cv.evaluate(members[:2], [20, 30, 40])["done"])
        self.assertEqual(cv.evaluate(members, [20, 30, 40])["converged_at"], 30)


if __name__ == "__main__":
    unittest.main()
