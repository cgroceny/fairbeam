"""Multi-port optimizer goals (sij_max, sij_min, match_all) on synthetic S-matrices (no openEMS):
parsing, metrics with reciprocity, costs, the ports each goal needs driven, and a synthetic
isolation-resistor optimisation."""

import math
import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from fairbeam.optimize import (Vary, bundle_metrics, goal_cost, needed_excite, optimize, parse_goal,  # noqa: E402
                               s_db_at, sparam_matrix, total_cost)


def synthetic_3port(driven=(1, 2, 3), s21_db=-3.1, s23_db=-30.0, sii_db=(-24.0, -26.0, -26.0)):
    """A bundle-like dict with a flat (frequency-independent) 3-port S-matrix; only the columns of
    the driven ports are stored, as fairbeam does."""
    f = [2.0e9, 2.4e9, 2.8e9]
    lin = lambda db: 10 ** (db / 20)  # noqa: E731
    full = np.array([[lin(sii_db[0]), lin(s21_db), lin(s21_db)],
                     [lin(s21_db), lin(sii_db[1]), lin(s23_db)],
                     [lin(s21_db), lin(s23_db), lin(sii_db[2])]])
    entries = {}
    for j in driven:
        for i in (1, 2, 3):
            entries[f"{i},{j}"] = {"re": [float(full[i - 1, j - 1])] * 3, "im": [0.0] * 3}
    return {"results": {"frequency": f, "ports": {"1": {"s11_re": [lin(sii_db[0])] * 3, "s11_im": [0.0] * 3,
                                                       "zin_re": [50.0] * 3, "zin_im": [0.0] * 3, "z_ref": 50}},
                        "bands": [], "sparams": {"ports": [1, 2, 3], "excited": list(driven), "s": entries}},
            "ports": [{"number": n, "excite": n == driven[0]} for n in (1, 2, 3)]}


class Parsing(unittest.TestCase):
    def test_forms(self):
        g = parse_goal("sij_max=-25@2.4:2,3")
        self.assertEqual((g.kind, g.target, g.at, g.ports, g.weight), ("sij_max", -25.0, 2.4, (2, 3), 1.0))
        self.assertEqual(g.label(), "|S23| ≤ -25 dB @ 2.4 GHz")
        g = parse_goal("sij_min=-3.2@2.4:2,1*2")
        self.assertEqual((g.ports, g.weight), ((2, 1), 2.0))
        g = parse_goal("match_all=-20@2.4")
        self.assertEqual((g.kind, g.ports), ("match_all", None))
        for bad in ("sij_max=-25@2.4", "sij_max=-25:2,3", "sij_min=3@2.4:2,1", "match_all=-20", "match_all=5@2.4",
                    "sij_max=-25@2.4:0,1"):
            with self.assertRaises(ValueError, msg=bad):
                parse_goal(bad)


class Metrics(unittest.TestCase):
    def test_matrix_and_reciprocity(self):
        f, numbers, s = sparam_matrix(synthetic_3port(driven=(1, 2)))
        self.assertEqual(numbers, [1, 2, 3])
        self.assertAlmostEqual(s_db_at(f, numbers, s, 2, 1, 2.4), -3.1, places=3)
        self.assertAlmostEqual(s_db_at(f, numbers, s, 3, 2, 2.4), -30.0, places=3)  # column 2 stored
        self.assertAlmostEqual(s_db_at(f, numbers, s, 2, 3, 2.4), -30.0, places=3)  # via reciprocity
        self.assertIsNone(s_db_at(f, numbers, s, 3, 3, 2.4))  # port 3 never driven
        self.assertIsNone(s_db_at(f, numbers, s, 4, 1, 2.4))

    def test_metrics_and_costs(self):
        goals = [parse_goal("match_all=-20@2.4"), parse_goal("sij_max=-25@2.4:2,3"), parse_goal("sij_min=-3.2@2.4:2,1")]
        m = bundle_metrics(synthetic_3port(), goals)
        self.assertEqual(m["match_all_at"]["2.4"]["max"], -24.0)
        self.assertEqual(m["sij_at"]["2,3@2.4"], -30.0)
        total, parts, met = total_cost(goals, m)
        self.assertTrue(met)
        self.assertEqual(total, 0.0)
        # textbook-resistor-like: outputs matched only to -18 dB, isolation -22 dB, S21 -3.3 dB
        m = bundle_metrics(synthetic_3port(s21_db=-3.3, s23_db=-22.0, sii_db=(-24, -18, -18.4)), goals)
        total, parts, met = total_cost(goals, m)
        self.assertFalse(met)
        self.assertAlmostEqual(parts[0]["cost"], (2 / 3) ** 2, places=5)
        self.assertAlmostEqual(parts[1]["cost"], 1.0, places=5)
        self.assertAlmostEqual(parts[2]["cost"], (0.1 / 0.5) ** 2, places=5)
        # a column that was not driven cannot be evaluated: penalty, never "met"
        m = bundle_metrics(synthetic_3port(driven=(1,)), goals)
        c, met, v = goal_cost(goals[0], m)
        self.assertGreaterEqual(c, 1e4)
        self.assertIsNone(v)
        self.assertFalse(met)

    def test_single_port_bundle(self):
        b = synthetic_3port()
        del b["results"]["sparams"]
        m = bundle_metrics(b, [parse_goal("match_all=-20@2.4"), parse_goal("sij_max=-20@2.4:1,1")])
        self.assertEqual(m["match_all_at"]["2.4"]["max"], -24.0)  # S11 of the excited port
        self.assertEqual(m["sij_at"]["1,1@2.4"], -24.0)


class Excite(unittest.TestCase):
    def test_needed_excite(self):
        g = parse_goal
        self.assertEqual(needed_excite([g("sij_min=-3.2@2.4:2,1"), g("s11_max=-20@2.4")], [1, 2, 3]), [1])
        self.assertEqual(needed_excite([g("sij_max=-25@2.4:2,3")], [1, 2, 3]), [3])
        self.assertEqual(needed_excite([g("sij_min=-3.2@2.4:2,1"), g("sij_max=-25@2.4:2,3")], [1, 2, 3]), [1, 3])
        self.assertEqual(needed_excite([g("sij_max=-25@2.4:2,3"), g("sij_max=-25@2.4:3,2")], [1, 2, 3]), [3])
        self.assertEqual(needed_excite([g("match_all=-20@2.4"), g("sij_max=-25@2.4:2,3")], [1, 2, 3]), [1, 2, 3])
        self.assertEqual(needed_excite([g("f0=2.4")], [1]), [1])


class Search(unittest.TestCase):
    def test_optimizes_an_isolation_resistor(self):
        # S23 and S22 depend on R with the best isolation near 70 ohm (cf. docs/VALIDATION.md section 8)
        goals = [parse_goal("match_all=-20@2.4"), parse_goal("sij_max=-25@2.4:2,3")]

        def ev(p):
            r = p["r_iso"]
            s23 = -42 + 130 * abs(math.log10(r / 70))  # -22 dB at 100 ohm
            s22 = -26 + 37 * abs(math.log10(r / 62))  # -18.3 dB at 100 ohm
            return {"metrics": bundle_metrics(synthetic_3port(s23_db=s23, sii_db=(-24.2, s22, s22)), goals)}

        r = optimize([Vary("r_iso", 40, 160, start=100)], goals, ev, max_evals=12)
        self.assertEqual(r["method"], "nelder-mead")
        self.assertEqual(r["reason"], "goals met")
        self.assertLessEqual(len(r["history"]), 6)
        self.assertLess(r["best"]["params"]["r_iso"], 95)


if __name__ == "__main__":
    unittest.main()
