"""Compact Subtract: a box minus a box must not be partitioned into many bricks.
Sheets give one polygon where possible, prisms on a common axis extruded polygons, and otherwise the brick stays whole
with the cutter as an exact vacuum cut-out. The result keeps a later Add or Subtract working. The designer's
booleanParts.ts gives the same shapes (boolean_parity.json has these cases)."""

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.design import DesignError, blank_design, boolean_primitives, check_design, resolve_parts, to_python  # noqa: E402
from fairbeam.polyclip import ring_area  # noqa: E402
from fairbeam.preview import build_preview  # noqa: E402


def box(a, b, **extra):
    return {"kind": "box", "start": a, "stop": b, **extra}


def part(name, prims, **extra):
    return {"name": name, "material": "copper", "primitives": prims, **extra}


def sub(a, b, op="subtract"):
    return {"operation": op, "A": a, "B": b}


def area(prims):
    """The area of flat shapes and the volume of solid ones (bricks, extruded polygons); cut-outs are not counted."""
    total = 0.0
    for p in prims:
        if p.get("void"):
            continue
        if p["kind"] == "box":
            d = [abs(p["stop"][k] - p["start"][k]) for k in range(3)]
            total += (d[0] * d[1] if d[2] == 0 else d[1] * d[2] if d[0] == 0 else d[0] * d[2] if d[1] == 0 else d[0] * d[1] * d[2])
        elif p["kind"] == "linpoly":
            total += ring_area(p["points"]) * p["length"]
        else:
            total += ring_area(p["points"])
    return total


class CompactSubtract(unittest.TestCase):
    def kinds(self, prims):
        return [(p["kind"], bool(p.get("void"))) for p in prims]

    def test_l_notch_in_a_sheet_is_one_polygon(self):
        out = boolean_primitives(sub(part("A", [box([0, 0, 1], [10, 6, 1])]), part("B", [box([6, 3, 1], [12, 8, 1])])), {}, "h")
        self.assertEqual(self.kinds(out), [("polygon", False)])
        self.assertAlmostEqual(area(out), 60 - 4 * 3, places=9)

    def test_centred_hole_in_a_sheet_is_two_shapes(self):
        out = boolean_primitives(sub(part("A", [box([0, 0, 1], [10, 10, 1])]), part("B", [box([4, 4, 1], [6, 6, 1])])), {}, "h")
        self.assertEqual(len(out), 2)
        self.assertAlmostEqual(area(out), 100 - 4, places=9)
        self.assertTrue(all(p["label"].startswith("A (part ") for p in out), "pieces are named after A")

    def test_centred_hole_through_a_thick_plate(self):
        out = boolean_primitives(sub(part("A", [box([0, 0, 0], [10, 10, 2])]), part("B", [box([4, 4, -1], [6, 6, 5])])), {}, "h")
        self.assertEqual(len(out), 2)
        self.assertAlmostEqual(area(out), 200 - 8, places=9)

    def test_pocket_keeps_the_brick_whole_and_a_cutout(self):
        out = boolean_primitives(sub(part("A", [box([0, 0, 0], [10, 10, 4])]), part("B", [box([3, 3, 2], [7, 7, 5])])), {}, "h")
        self.assertEqual(self.kinds(out), [("box", False), ("box", True)])
        self.assertEqual(out[0]["start"] + out[0]["stop"], [0, 0, 0, 10, 10, 4])
        self.assertEqual((out[1]["start"], out[1]["stop"], out[1]["label"]), ([3, 3, 2], [7, 7, 4], "B (cut-out)"))

    def test_slit_cuts_a_brick_in_two(self):
        out = boolean_primitives(sub(part("A", [box([0, 0, 0], [10, 6, 2])]), part("B", [box([4, -1, -1], [5, 7, 3])])), {}, "h")
        self.assertEqual(self.kinds(out), [("box", False)] * 2)
        self.assertAlmostEqual(area(out), 120 - 12, places=9)

    def test_a_brick_that_is_not_touched_stays_one(self):
        out = boolean_primitives(sub(part("A", [box([0, 0, 0], [4, 4, 2])]), part("B", [box([6, 0, 0], [12, 4, 2])])), {}, "h")
        self.assertEqual(len(out), 1)

    def test_add_a_filler_back_gives_one_shape(self):
        pocketed = part("A", [box([0, 0, 0], [10, 10, 4]), {**box([3, 3, 2], [7, 7, 5]), "void": True}])
        out = boolean_primitives(sub(pocketed, part("B", [box([3, 3, 2], [7, 7, 4])]), "add"), {}, "h")
        self.assertEqual(len(out), 1)
        self.assertAlmostEqual(area(out), 400, places=9)
        # an L-notch on a sheet, filled again
        notched = part("A", boolean_primitives(sub(part("S", [box([0, 0, 1], [10, 6, 1])]), part("N", [box([6, 3, 1], [12, 8, 1])])), {}, "h"))
        back = boolean_primitives(sub(notched, part("F", [box([6, 3, 1], [10, 6, 1])]), "add"), {}, "h")
        self.assertEqual(len(back), 1)
        self.assertAlmostEqual(area(back), 60, places=9)

    def test_a_later_subtract_keeps_the_cutouts(self):
        pocketed = part("A", [box([0, 0, 0], [10, 10, 4]), {**box([3, 3, 2], [7, 7, 5]), "void": True}])
        out = boolean_primitives(sub(pocketed, part("B2", [box([8, 8, -1], [12, 12, 2])])), {}, "h")
        self.assertEqual(self.kinds(out), [("box", False), ("box", True), ("box", True)])

    def test_a_sheet_minus_a_thick_brick_uses_its_cross_section(self):
        sheet = part("A", [box([0, 0, 1], [10, 10, 1])])
        out = boolean_primitives(sub(sheet, part("B", [box([3, 3, 0], [6, 6, 2])])), {}, "h")
        self.assertAlmostEqual(area(out), 100 - 9, places=9)
        self.assertTrue(all(p["kind"] in ("polygon", "box") and not p.get("void") for p in out))
        # a brick that does not reach the sheet cuts nothing
        out = boolean_primitives(sub(sheet, part("B", [box([3, 3, 2], [6, 6, 3])])), {}, "h")
        self.assertEqual(len(out), 1)
        self.assertAlmostEqual(area(out), 100, places=9)

    def test_refusals_say_the_operation(self):
        sheet, brick = part("S", [box([0, 0, 1], [4, 4, 1])]), part("V", [box([1, 1, 0], [3, 3, 2])])
        with self.assertRaisesRegex(DesignError, "Add cannot combine a sheet with a volume"):
            boolean_primitives(sub(sheet, brick, "add"), {}, "h")
        with self.assertRaisesRegex(DesignError, "F has a sheet .*removes nothing from S"):
            boolean_primitives(sub(part("S", [box([0, 0, 0], [4, 4, 4])]), part("F", [box([1, 1, 1], [3, 3, 1])])), {}, "h")

    def test_the_build_and_the_python_export_agree(self):
        """A pocketed brick (a cut-out) and a notched sheet build, check and export like any other design."""
        h = {**sub(part("A", [box([0, 0, 0], [10, 10, 4])]), part("B", [box([3, 3, 2], [7, 7, 5])])), "live": True}
        design = blank_design("compact", "Compact")
        design["parts"] = [part("A", boolean_primitives(h, {}, "h"), booleanHistory=h)]
        check_design(design)
        built = resolve_parts(design, {})
        self.assertTrue(built)
        direct = build_preview(None, {}, design=copy.deepcopy(design))["bundle"]["parts"]
        self.assertTrue(any(p.get("void") for p in direct), "the cut-out is a vacuum part of the bundle")
        self.assertIn("booleanHistory", to_python(design))
        json.dumps(direct)


if __name__ == "__main__":
    unittest.main()
