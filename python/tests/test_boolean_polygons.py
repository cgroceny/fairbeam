"""Booleans of extruded polygons, polygon sheets and bricks (fairbeam.polyclip and design.py): exact
2D clipping per slab, holes as simple polygons, live recomputation, the build and the Python export."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.design import DesignError, blank_design, boolean_primitives, check_design, resolve_parts, to_python  # noqa: E402
from fairbeam.polyclip import clip_polygons, ring_area  # noqa: E402
from fairbeam.preview import build_preview  # noqa: E402


def sq(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def linpoly(name, points, elevation, length, normal="z"):
    return {"name": name, "material": "copper", "primitives": [
        {"kind": "linpoly", "normal": normal, "elevation": elevation, "length": length, "points": points}]}


def volume(prims):
    return sum(ring_area(p["points"]) * p["length"] for p in prims)


class PolygonClip(unittest.TestCase):
    def test_hole_splits_into_simple_polygons(self):
        rings = clip_polygons([sq(0, 0, 10, 10)], [sq(3, 3, 6, 6)], "subtract")
        self.assertGreaterEqual(len(rings), 2)
        self.assertAlmostEqual(sum(ring_area(r) for r in rings), 91, places=12)
        self.assertTrue(all(ring_area(r) > 0 for r in rings))

    def test_notch_and_shared_edges(self):
        notch = clip_polygons([[[0, 0], [10, 0], [5, 8]]], [sq(4, -1, 6, 2)], "subtract")
        self.assertEqual(len(notch), 1)
        self.assertAlmostEqual(ring_area(notch[0]), 36, places=12)
        self.assertEqual(clip_polygons([sq(0, 0, 1, 1)], [sq(1, 0, 2, 1)], "union"), [sq(0, 0, 2, 1)])
        self.assertEqual(clip_polygons([sq(0, 0, 1, 1)], [sq(0, 0, 1, 1)], "subtract"), [])


class PolygonBooleans(unittest.TestCase):
    def history(self, op="subtract"):
        return {"operation": op, "A": linpoly("P", [[0, 0], ["W", 0], ["W", 10], [0, 10]], 0, 4),
                "B": {"name": "B", "material": "copper", "primitives": [{"kind": "box", "start": [5, 5, 1], "stop": [15, 15, 3]}]}}

    def test_slabs_and_volumes(self):
        # a brick partway up is a pocket: the polygon whole and the brick as a cut-out (2 shapes, fewer than 3 slabs)
        out = boolean_primitives(self.history(), {"W": 10}, "h")
        self.assertEqual([(p["kind"], p.get("void")) for p in out], [("linpoly", None), ("box", True)])
        self.assertEqual((out[1]["start"], out[1]["stop"]), ([5, 5, 1], [10, 10, 3]))   # trimmed to the polygon's box
        # through its whole height it is a notch: one extruded polygon
        through = self.history()
        through["B"]["primitives"][0].update(start=[5, 5, -2], stop=[15, 15, 6])
        out = boolean_primitives(through, {"W": 10}, "h")
        self.assertEqual([p["kind"] for p in out], ["linpoly"])
        self.assertAlmostEqual(volume(out), 400 - 100, places=9)
        self.assertAlmostEqual(volume(boolean_primitives(self.history("intersect"), {"W": 10}, "h")), 50, places=9)
        self.assertAlmostEqual(volume(boolean_primitives(self.history("add"), {"W": 10}, "h")), 550, places=9)

    def test_live_build_and_export(self):
        design = blank_design("poly", "Poly")
        h = {**self.history(), "live": True}  # at W = 32, blank_design's default
        h["B"]["primitives"][0].update(start=[5, 5, -2], stop=[15, 15, 6])
        design["parts"] = [{"name": "P", "material": "copper", "primitives": boolean_primitives(h, {"W": 32}, "h"), "booleanHistory": h}]
        check_design(design)
        # the build recomputes the result at its own values
        at = resolve_parts(design, {"W": 8})[0]["prims"]
        self.assertAlmostEqual(sum(ring_area(p["points"]) * p["length"] for p in at), 8 * 10 * 4 - 3 * 5 * 4, places=9)
        direct = build_preview(None, {}, design=design)["bundle"]["parts"]
        self.assertEqual({p["kind"] for p in direct[0]["primitives"]}, {"linpoly"})
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "poly.py"
            script.write_text(to_python(design))
            exported = build_preview(str(script), {})["bundle"]["parts"]
        self.assertEqual(json.dumps(direct, sort_keys=True), json.dumps(exported, sort_keys=True))

    def test_refusals_name_the_reason(self):
        """Polygons along different axes and a sheet with a volume are refused with the reason."""
        a = linpoly("P", sq(0, 0, 10, 10), 0, 2)
        cyl = {"name": "C", "material": "copper", "primitives": [{"kind": "cylinder", "axis": "z", "center": [0, 0], "radius": 1, "range": [0, 1]}]}
        # a curved shape is cut out of the polygon as a cut-out (test_boolean_curved.py)
        out = boolean_primitives({"operation": "subtract", "A": a, "B": cyl}, {}, "h")
        self.assertEqual([(p["kind"], p.get("void")) for p in out], [("linpoly", None), ("cylinder", True)])
        with self.assertRaisesRegex(DesignError, "one common extrusion axis"):
            boolean_primitives({"operation": "subtract", "A": a, "B": linpoly("X", [[0, 0], [2, 0], [2, 2]], 0, 3, "x")}, {}, "h")
        sheet = {"name": "S", "material": "copper", "primitives": [{"kind": "polygon", "normal": "z", "elevation": 1, "points": [[0, 0], [8, 0], [4, 7]]}]}
        # a sheet minus a volume is cut with the volume's cross-section at its plane (a volume beside it cuts nothing) ...
        out = boolean_primitives({"operation": "subtract", "A": sheet, "B": linpoly("V", sq(4, -1, 10, 3), 0, 2)}, {}, "h")
        self.assertEqual([p["kind"] for p in out], ["polygon"])
        self.assertAlmostEqual(ring_area(out[0]["points"]), 28 - (3 * (8 - 12 / 7 - 4) + 0.875 * (12 / 7) ** 2), places=9)
        out = boolean_primitives({"operation": "subtract", "A": sheet, "B": linpoly("V", sq(4, -1, 10, 3), 2, 2)}, {}, "h")
        self.assertEqual([p["kind"] for p in out], ["polygon"])
        self.assertAlmostEqual(ring_area(out[0]["points"]), 28, places=9)
        # ... and every refusal names the operation the user chose
        for op, word in (("add", "Add cannot"), ("intersect", "Intersect cannot")):
            with self.assertRaisesRegex(DesignError, f"{word} combine a sheet with a volume"):
                boolean_primitives({"operation": op, "A": sheet, "B": a}, {}, "h")
        with self.assertRaisesRegex(DesignError, "removes nothing from"):
            boolean_primitives({"operation": "subtract", "A": a, "B": sheet}, {}, "h")


if __name__ == "__main__":
    unittest.main()
