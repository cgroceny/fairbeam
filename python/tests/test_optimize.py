"""Optimizer: goal parsing and costs, both algorithms on synthetic analytic models (no openEMS),
bounds handling, caching and the evaluation budget; metrics from a real committed bundle."""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from fairbeam.optimize import (Driver, Stop, Vary, bundle_metrics, goal_cost, make_goal, optimize,  # noqa: E402
                               parse_goal, parse_vary, total_cost)

REPO = HERE.parents[1]


def dipole_like(calls):
    """f0 = 139.2 / length GHz (a resonant length: f0 ∝ 1/L; 58 mm -> 2.40 GHz)."""
    def ev(p):
        calls.append(dict(p))
        f0 = 139.2 / p["length"]
        return {"metrics": {"f0_ghz": round(f0, 6), "s11_at": {}, "bw_mhz": 400.0}, "wall_time_s": 0.01}
    return ev


def patch_like(calls):
    """f0 = 78.4 / w GHz (w = 32 -> 2.45); match depends on the feed: |S11|(f0) = -40 + 2 (x + 7)² dB,
    detuned by the f0 error at 2.45 GHz."""
    def ev(p):
        calls.append(dict(p))
        f0 = 78.4 / p["patch_w"]
        s11_f0 = -40 + 2 * (p["feed_x"] + 7) ** 2
        s11_at = min(-0.5, s11_f0 + 900 * abs(f0 - 2.45))
        return {"metrics": {"f0_ghz": round(f0, 6), "s11_at": {"2.45": round(s11_at, 3)}, "bw_mhz": 60.0}}
    return ev


class Parsing(unittest.TestCase):
    def test_goals(self):
        g = parse_goal("f0=2.45")
        self.assertEqual((g.kind, g.target, g.at, g.weight), ("f0", 2.45, None, 1.0))
        g = parse_goal("s11_max=-25@2.45*2")
        self.assertEqual((g.kind, g.target, g.at, g.weight), ("s11_max", -25.0, 2.45, 2.0))
        self.assertEqual(parse_goal("dmax_min=5@2.4").at, 2.4)
        for bad in ("f0", "gain=3", "s11_max=-25", "s11_max=3@2", "bw_min=-5", "f0=2*0"):
            with self.assertRaises(ValueError, msg=bad):
                parse_goal(bad)

    def test_vary(self):
        v = parse_vary("patch_w=28:36")
        self.assertEqual((v.key, v.lo, v.hi, v.start), ("patch_w", 28.0, 36.0, None))
        self.assertEqual(v.resolution, 0.001)
        self.assertEqual(parse_vary("length=52.2:63.8").snap(58.0), 58.0)
        v = parse_vary("length=50:66:58:0.5")
        self.assertEqual((v.start, v.resolution), (58.0, 0.5))
        self.assertEqual(v.snap(57.8), 58.0)
        self.assertEqual(v.snap(99), 66.0)  # clipped to the bounds
        for bad in ("x=5:1", "x=1", "x=1:2:9"):
            with self.assertRaises(ValueError, msg=bad):
                parse_vary(bad)

    def test_costs(self):
        m = {"f0_ghz": 2.4048, "s11_at": {"2.45": -20.0}, "bw_mhz": 90.0, "dmax_at": {"2.4": 2.0}}
        c, met, v = goal_cost(make_goal("f0", 2.40), m)
        self.assertAlmostEqual(c, 0.04, places=6)  # 0.2 % -> (0.2)^2
        self.assertTrue(met)
        self.assertFalse(goal_cost(make_goal("f0", 2.40), m, f0_tol_pct=0.1)[1])
        c, met, _ = goal_cost(make_goal("s11_max", -25, 2.45), m)
        self.assertAlmostEqual(c, (5 / 3) ** 2)
        self.assertFalse(met)
        c, met, _ = goal_cost(make_goal("bw_min", 100), m)
        self.assertAlmostEqual(c, 1.0)
        c, met, _ = goal_cost(make_goal("dmax_min", 2.1, 2.4), m)
        self.assertAlmostEqual(c, (0.1 / 0.5) ** 2)
        c, met, _ = goal_cost(make_goal("f0", 2.4), {"f0_ghz": None})
        self.assertGreaterEqual(c, 1e4)
        total, parts, all_met = total_cost([make_goal("f0", 2.4), make_goal("bw_min", 100, weight=2)], m)
        self.assertAlmostEqual(total, 0.04 + 2.0, places=5)
        self.assertEqual([p["met"] for p in parts], [True, False])
        self.assertFalse(all_met)


class Secant(unittest.TestCase):
    def test_tunes_f0_in_few_evaluations(self):
        calls = []
        r = optimize([Vary("length", 40, 80, start=66)], [make_goal("f0", 2.40)], dipole_like(calls), max_evals=12)
        self.assertEqual(r["method"], "secant")
        self.assertEqual(r["reason"], "goals met")
        self.assertLessEqual(len(r["history"]), 4)
        self.assertAlmostEqual(r["best"]["params"]["length"], 58.0, delta=0.15)

    def test_target_outside_the_bounds(self):
        calls = []
        r = optimize([Vary("length", 60, 70)], [make_goal("f0", 2.40)], dipole_like(calls), max_evals=12)
        self.assertIn(r["reason"], ("target outside the parameter bounds", "parameter resolution reached"))
        self.assertEqual(r["best"]["params"]["length"], 60.0)  # the closest reachable point
        self.assertTrue(all(60 <= c["length"] <= 70 for c in calls))

    def test_non_monotonic_falls_back(self):
        # f0 has a flat region: secant stalls and hands over to Nelder–Mead, still within budget
        def ev(p):
            x = p["length"]
            return {"metrics": {"f0_ghz": 2.0 + 0.01 * round((x - 50) / 4) ** 2}}
        r = optimize([Vary("length", 40, 80, start=50)], [make_goal("f0", 2.36)], ev, max_evals=10)
        self.assertLessEqual(len(r["history"]), 10)
        self.assertLess(r["best"]["cost"], r["start"]["cost"])


class NelderMead(unittest.TestCase):
    def test_two_parameters_meet_both_goals(self):
        calls = []
        goals = [make_goal("f0", 2.45), make_goal("s11_max", -25, 2.45)]
        vary = [Vary("patch_w", 28, 36, start=33.0), Vary("feed_x", -12, -2, start=-3.0)]
        r = optimize(vary, goals, patch_like(calls), max_evals=40)
        self.assertEqual(r["method"], "nelder-mead")
        self.assertEqual(r["reason"], "goals met", r["best"])
        self.assertLessEqual(len(r["history"]), 40)
        self.assertAlmostEqual(r["best"]["params"]["patch_w"], 32.0, delta=0.1)
        self.assertLess(r["best"]["metrics"]["s11_at"]["2.45"], -25)

    def test_bounds_are_respected(self):
        calls = []
        # the optimum (w = 32) lies outside [34, 36]: every point stays inside, best sits on the bound
        vary = [Vary("patch_w", 34, 36), Vary("feed_x", -12, -2)]
        r = optimize(vary, [make_goal("f0", 2.45)], patch_like(calls), max_evals=15)
        self.assertTrue(all(34 <= c["patch_w"] <= 36 and -12 <= c["feed_x"] <= -2 for c in calls))
        self.assertAlmostEqual(r["best"]["params"]["patch_w"], 34.0, delta=0.05)
        self.assertEqual(len(calls), len(r["history"]))

    def test_budget(self):
        calls = []
        vary = [Vary("patch_w", 28, 36), Vary("feed_x", -12, -2)]
        r = optimize(vary, [make_goal("f0", 2.45), make_goal("s11_max", -60, 2.45)], patch_like(calls), max_evals=6)
        self.assertEqual(r["reason"], "max evaluations")
        self.assertEqual(len(r["history"]), 6)


class Caching(unittest.TestCase):
    def test_same_rounded_point_is_evaluated_once(self):
        calls = []
        d = Driver([Vary("length", 40, 80, resolution=0.1)], [make_goal("f0", 1.0)], dipole_like(calls), max_evals=5)
        c1 = d([58.01])
        c2 = d([58.04])  # rounds to the same 58.0
        self.assertEqual(c1, c2)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(d.history), 1)
        d([59.0])
        self.assertEqual(len(calls), 2)

    def test_goal_met_stops(self):
        d = Driver([Vary("length", 40, 80)], [make_goal("f0", 2.40)], dipole_like([]), max_evals=5)
        with self.assertRaises(Stop) as cm:
            d([58.0])
        self.assertEqual(cm.exception.reason, "goals met")


class Robustness(unittest.TestCase):
    def test_a_failed_evaluation_is_penalised_not_fatal(self):
        """A point the model rejects (or a failed run) costs PENALTY; the search goes on."""
        calls = []
        ok = patch_like(calls)

        def ev(p):
            if p["feed_x"] > -4:  # e.g. "inset must be shorter than the patch"
                raise ValueError("infeasible geometry")
            return ok(p)
        vary = [Vary("patch_w", 28, 36, start=33.0), Vary("feed_x", -12, -2, start=-3.0)]
        r = optimize(vary, [make_goal("f0", 2.45), make_goal("s11_max", -25, 2.45)], ev, max_evals=25)
        self.assertIn(r["reason"], ("goals met", "max evaluations"))
        failed = [h for h in r["history"] if h.get("error")]
        self.assertTrue(failed)
        self.assertTrue(all(h["cost"] >= 1e4 and not h["met"] for h in failed))
        self.assertLess(r["best"]["cost"], 1e4)

    def test_non_finite_goal_frequency_is_refused(self):
        for at in (float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                make_goal("s11_max", -10, at)

    def test_goal_outside_the_band_is_not_extrapolated(self):
        b = json.loads((REPO / "public" / "projects" / "dipole.json").read_text(encoding="utf-8"))
        f = b["results"]["frequency"]
        above = f[-1] / 1e9 * 1.5
        m = bundle_metrics(b, [make_goal("s11_max", -20, above)])
        self.assertIsNone(m["s11_at"][f"{above:g}"])


class Metrics(unittest.TestCase):
    def test_from_a_committed_bundle(self):
        path = REPO / "public" / "projects" / "dipole.json"
        bundle = json.loads(path.read_text(encoding="utf-8"))
        m = bundle_metrics(bundle, [make_goal("s11_max", -10, 2.3), make_goal("dmax_min", 2, 2.25)])
        self.assertEqual(m["f0_source"], "band")
        self.assertAlmostEqual(m["f0_ghz"], bundle["results"]["bands"][0]["f_center"] / 1e9, places=5)
        self.assertGreater(m["bw_mhz"], 0)
        self.assertIn("2.3", m["s11_at"])
        self.assertLess(m["s11_f0_db"], -10)
        self.assertIn("2.25", m["dmax_at"])


class DesignPrecheck(unittest.TestCase):
    """A design's candidates go through the design checks before openEMS: a patch wider than its
    substrate (metal-overhang) or a check error is skipped with a reason, not simulated. openEMS is
    mocked: run_model records the points it would simulate."""

    def run_opt(self, vary, goals, design, **kw):
        import fairbeam.multiport as multiport
        import fairbeam.optimize as opt

        simulated = []

        class FakeSim:
            def __init__(self, values):
                self.values = values

            def to_bundle(self, model, params, name=None):
                return {"schema": "fake", "W": self.values["W"]}

        def fake_run(module, values, **_):
            simulated.append(dict(values))
            return FakeSim(values)

        def metrics(bundle, goals):
            return {"f0_ghz": round(78.4 / bundle["W"], 6), "s11_at": {}, "bw_mhz": 60.0}

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "t.design.json"
            path.write_text(json.dumps(design), encoding="utf-8")
            lines = []
            with mock.patch.object(multiport, "run_model", fake_run), mock.patch.object(opt, "bundle_metrics", metrics):
                doc = opt.run_optimization(str(path), vary, goals, out=Path(tmp) / "out", sim_root=Path(tmp) / "sim",
                                           keep_sim=True, log=lines.append, **kw)
        return doc, simulated, lines

    def test_overhanging_candidates_are_skipped_and_the_search_goes_on(self):
        from fairbeam.design import blank_design
        from fairbeam.optimize import PENALTY

        vary = [Vary("W", 20, 80, start=70.0)]   # the substrate is 60 mm wide: W > 60 overhangs it
        with contextlib.redirect_stdout(io.StringIO()):
            doc, simulated, lines = self.run_opt(vary, [make_goal("f0", 2.45)], blank_design("t", "T"),
                                                 method="nelder-mead", max_evals=25)
        evals = doc["evaluations"]
        skipped = [e for e in evals if e.get("skipped")]
        self.assertTrue(skipped)
        self.assertEqual(skipped[0]["params"], {"W": 70.0})
        self.assertIn("'patch' overhangs 'substrate' by 5 mm (x+) and 5 mm (x-)", skipped[0]["skipped"])
        self.assertTrue(all(e["cost"] >= PENALTY and not e["met"] and e["error"].startswith("skipped: ")
                            and e["file"] is None for e in skipped))
        self.assertTrue(all(e["params"]["W"] > 60 for e in skipped))
        # no simulation for a skipped point; the other points were simulated and the goal was reached
        self.assertTrue(simulated)
        self.assertTrue(all(v["W"] <= 60 for v in simulated))
        self.assertEqual(len(simulated), len(evals) - len(skipped))
        self.assertEqual(doc["reason"], "goals met")
        self.assertLess(doc["best"]["cost"], PENALTY)
        self.assertTrue(any("skipped: 'patch' overhangs 'substrate'" in line for line in lines))

    def test_precheck_can_be_turned_off(self):
        from fairbeam.design import blank_design

        vary = [Vary("W", 20, 80, start=70.0)]
        with contextlib.redirect_stdout(io.StringIO()):
            doc, simulated, _ = self.run_opt(vary, [make_goal("f0", 2.45)], blank_design("t", "T"),
                                             method="nelder-mead", max_evals=3, check_candidates=False)
        self.assertEqual(simulated[0]["W"], 70.0)
        self.assertFalse(any(e.get("skipped") for e in doc["evaluations"]))

    def test_what_the_precheck_refuses(self):
        from fairbeam.design import blank_design
        from fairbeam.optimize import PENALTY, precheck

        d = blank_design("t", "T")
        base = {"f0": 2.45, "W": 32.0, "L": 40.0, "h": 1.524, "G": 60.0, "feed": -6.0}
        check = precheck(d, base)
        self.assertIsNone(check(base))
        self.assertIsNone(check({**base, "W": 50.0}))
        why, cost = check({**base, "W": 64.0})
        self.assertIn("'patch' overhangs 'substrate' by 2 mm", why)
        self.assertAlmostEqual(cost, PENALTY * 1.2)   # graded: 10 % per mm of overhang
        self.assertGreater(check({**base, "W": 70.0})[1], cost)
        self.assertIn("overhangs", check({**base, "G": 30.0})[0])   # the substrate shrinks under the patch
        # a check error is refused too, at PENALTY (a patch drawn from -W/2 to W - 20: inverted for W < 40/3)
        d2 = blank_design("t", "T")
        d2["parts"][2]["primitives"][0]["stop"][0] = "W - 20"
        self.assertIsNone(precheck(d2, base)(base))
        why, cost = precheck(d2, base)({**base, "W": 12.0})
        self.assertIn("is above", why)
        self.assertEqual(cost, PENALTY)
        # a patch that already overhangs in the drawn design is meant: the same overhang is allowed,
        # but a floating patch that a candidate creates is not (the patch is drawn at a fixed height)
        d3 = blank_design("t", "T")
        d3["parts"][2]["primitives"][0]["start"][2] = d3["parts"][2]["primitives"][0]["stop"][2] = "1.524"
        wide = {**base, "W": 64.0}
        check = precheck(d3, wide)
        self.assertIsNone(check(wide))
        self.assertIsNone(check({**wide, "W": 70.0}))
        self.assertIn("'patch' touches no other metal", check({**wide, "h": 1.2})[0])
        # a failing check never stops the optimizer: the candidate is simulated
        with mock.patch("fairbeam.design_checks.lint", side_effect=RuntimeError("bug")):
            self.assertIsNone(precheck(d, base)({**base, "W": 64.0}))


if __name__ == "__main__":
    unittest.main()
