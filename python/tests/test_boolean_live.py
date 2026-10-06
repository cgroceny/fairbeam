"""Live Boolean results (#80): design.py recomputes them from the operands exactly like the
designer (src/designer/booleanParts.ts), so builds, sweeps and optimisation follow parameters."""

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.design import DesignError, blank_design, boolean_primitives, check_design, resolve_parts  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "boolean_parity.json"


def boxes(prims):
    return [(p.get("priority"), [float(x) for x in p["start"]], [float(x) for x in p["stop"]]) for p in prims]


def numbers(x):
    """Every number as a float (JSON from the designer writes 2.0 as 2): exact comparison."""
    if isinstance(x, dict):
        return {k: numbers(v) for k, v in x.items()}
    if isinstance(x, list):
        return [numbers(v) for v in x]
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else x


def close(a, b, tol):
    """Equal up to ``tol`` in every number (the faceted rings use cos and sin, which differ in the last bit between runtimes)."""
    if isinstance(a, dict):
        return isinstance(b, dict) and a.keys() == b.keys() and all(close(a[k], b[k], tol) for k in a)
    if isinstance(a, list):
        return isinstance(b, list) and len(a) == len(b) and all(close(x, y, tol) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and not isinstance(a, bool):
        return abs(a - b) <= tol
    return a == b


class BooleanLive(unittest.TestCase):
    def test_parity_with_the_designer(self):
        for case in json.loads(FIXTURE.read_text()):
            for values, expected in zip(case["values"], case["expected"]):
                with self.subTest(case=case["name"], values=values):
                    got = numbers(boolean_primitives(case["history"], values, "h"))
                    # the same kinds, points and floats; the last bit of a cos or sin differs between libm builds (macOS, Windows, Linux)
                    tol = case.get("tol", 1e-12)
                    self.assertTrue(close(got, numbers(expected), tol), f"{got} != {expected}")

    def test_refusals_say_the_same_as_the_designer(self):
        for case in json.loads((Path(__file__).parent / "fixtures" / "boolean_refusals.json").read_text()):
            with self.subTest(case=case["name"]):
                self.assertIsNotNone(case["message"], "the designer refuses it")
                with self.assertRaises(DesignError) as err:
                    boolean_primitives(case["history"], case["values"], "h")
                self.assertEqual(err.exception.detail.rstrip("."), case["message"].rstrip("."))

    def test_build_recomputes_at_the_build_values(self):
        # sheets united: boxes (a subtraction gives polygons, or a cut-out, where that is fewer shapes)
        case = next(c for c in json.loads(FIXTURE.read_text()) if c["name"] == "sheet copies united with a strip")
        design = blank_design("live", "Live")
        design["params"] = [{"key": "s", "default": 3}]
        result = {"name": "A", "material": "copper", "primitives": case["expected"][0],
                  "booleanHistory": {**case["history"], "live": True}}
        design["parts"] = [result]
        check_design(design)
        at = lambda values: [(p["start"], p["stop"]) for p in resolve_parts(design, values)[0]["prims"]]  # noqa: E731
        self.assertEqual(at({"s": 2.5}), [(b[1], b[2]) for b in boxes(case["expected"][1])])
        # not live: the stored boxes, whatever the values
        frozen = copy.deepcopy(design)
        frozen["parts"][0]["booleanHistory"]["live"] = False
        self.assertEqual([(p["start"], p["stop"]) for p in resolve_parts(frozen, {"s": 2.5})[0]["prims"]],
                         [(b[1], b[2]) for b in boxes(case["expected"][0])])

    def test_unbuildable_values_name_the_history(self):
        case = json.loads(FIXTURE.read_text())[0]
        with self.assertRaises(DesignError) as err:
            # H = -3 puts the brick below the slab (they only touch): the intersection is empty
            boolean_primitives({**case["history"], "operation": "intersect"}, {"W": 4, "H": -3}, "parts[0].booleanHistory")
        self.assertTrue(err.exception.where.startswith("parts[0].booleanHistory"))


if __name__ == "__main__":
    unittest.main()
