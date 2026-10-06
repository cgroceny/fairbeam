"""Flat circles (a cylinder of zero length is a polygon sheet) and cuts beyond rectangular sheets
(polygon parts, round and polygon holes): the build, the checks, the Python export and the guards."""

import copy
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.design import (boolean_primitives, DISC_MAX_SEGMENTS, DISC_MIN_SEGMENTS, DISC_SAG_MM, DesignError, apply_cuts,  # noqa: E402
                             blank_design, check_design, disc_halves, disc_ring, disc_segments, module_for,
                             polygon_ring_area, resolve_cuts, resolve_names, resolve_parts, to_python)
from fairbeam.design_checks import lint  # noqa: E402
from fairbeam.preview import build_preview  # noqa: E402


def area(p):
    return abs(polygon_ring_area(p["points"]))


def parts_of(d, values=None):
    return {p["name"]: p for p in resolve_parts(d, resolve_names(d, values or {}))}


def design(*parts):
    d = blank_design("t", "T")
    d["parts"] += [copy.deepcopy(p) for p in parts]
    return d


def disc_part(name="disc", r=10, ri=0, at="h", center=(0, 0), **extra):
    return {"name": name, "material": "copper", **extra, "primitives": [
        {"kind": "cylinder", "axis": "z", "center": list(center), "radius": r, "inner_radius": ri, "range": [at, at]}]}


class FlatCircles(unittest.TestCase):
    def test_segments_follow_the_sag_tolerance(self):
        self.assertEqual(disc_segments(0.5), DISC_MIN_SEGMENTS)            # small circles: the minimum
        self.assertEqual(disc_segments(1e-6), DISC_MIN_SEGMENTS)
        for r in (0.5, 3, 10, 40, 150, 1000):
            n = disc_segments(r)
            self.assertEqual(n % 2, 0)
            self.assertGreaterEqual(n, DISC_MIN_SEGMENTS)
            self.assertLessEqual(n, DISC_MAX_SEGMENTS)
            if n < DISC_MAX_SEGMENTS:
                self.assertLessEqual(r * (1 - math.cos(math.pi / n)), DISC_SAG_MM * (1 + 1e-9), f"sag at r={r}")
        self.assertGreater(disc_segments(100), disc_segments(10))          # larger circles get more sides

    def test_a_zero_length_cylinder_is_a_polygon_sheet(self):
        d = design(disc_part(r=10, center=(3, -2)))
        check_design(d)
        self.assertEqual([c["code"] for c in lint(d) if c["severity"] == "error"], [])
        disc = parts_of(d)["disc"]["prims"]
        self.assertEqual(len(disc), 1)
        p = disc[0]
        self.assertEqual((p["kind"], p["normal"]), ("polygon", 2))
        self.assertAlmostEqual(p["elevation"], 1.524)
        self.assertEqual(len(p["points"]), disc_segments(10))
        for u, v in p["points"]:                                           # vertices on the circle
            self.assertAlmostEqual(math.hypot(u - 3, v + 2), 10, places=9)
        self.assertAlmostEqual(area(p), 0.5 * len(p["points"]) * 100 * math.sin(2 * math.pi / len(p["points"])), places=6)
        self.assertNotIn("disc", p)                                        # nothing but a polygon is built
        self.assertGreater(polygon_ring_area(p["points"]), 0)              # counter-clockwise

    def test_a_ring_is_two_half_rings(self):
        d = design(disc_part("ring", r=8, ri=5))
        pieces = parts_of(d)["ring"]["prims"]
        self.assertEqual([p["kind"] for p in pieces], ["polygon", "polygon"])
        n = disc_segments(8)
        full = lambda r: 0.5 * n * r * r * math.sin(2 * math.pi / n)  # noqa: E731
        self.assertAlmostEqual(sum(area(p) for p in pieces), full(8) - full(5), places=6)
        for p in pieces:
            self.assertGreater(polygon_ring_area(p["points"]), 0)
            self.assertEqual(len(p["points"]), n + 2)
        h = disc_halves(0, 0, 8, 5)
        self.assertAlmostEqual(h[0][n // 2][0], -8)
        self.assertAlmostEqual(h[1][0][0], -8)

    def test_a_length_keeps_a_real_cylinder_and_inverted_ranges_stay_errors(self):
        d = design({"name": "post", "material": "copper", "primitives": [
            {"kind": "cylinder", "axis": "z", "center": [0, 0], "radius": 1, "range": [0, 0.5]}]})
        self.assertEqual(parts_of(d)["post"]["prims"][0]["kind"], "cylinder")
        d["parts"][-1]["primitives"][0]["range"] = [1, 0]
        self.assertIn("cylinder-length", [c["code"] for c in lint(d)])
        with self.assertRaises(DesignError):
            resolve_parts(d, resolve_names(d, {}))
        d["parts"][-1]["primitives"][0]["range"] = [0, 0]                  # a flat circle: fine
        self.assertNotIn("cylinder-length", [c["code"] for c in lint(d)])

    def test_the_old_axis_start_stop_cylinder_still_needs_a_length(self):
        d = design({"name": "pin", "material": "copper", "primitives": [
            {"kind": "cylinder", "start": [0, 0, 1], "stop": [0, 0, 1], "radius": 1}]})
        with self.assertRaises(DesignError):
            resolve_parts(d, resolve_names(d, {}))
        self.assertIn("cylinder-length", [c["code"] for c in lint(d)])

    def test_parametric_circle_follows_its_radius(self):
        d = design(disc_part(r="R"))
        d["params"].append({"key": "R", "default": 5, "label": "Radius", "unit": "mm"})
        small = parts_of(d, {"R": 5})["disc"]["prims"][0]
        large = parts_of(d, {"R": 60})["disc"]["prims"][0]
        self.assertEqual(len(small["points"]), DISC_MIN_SEGMENTS)
        self.assertGreater(len(large["points"]), DISC_MIN_SEGMENTS)
        self.assertAlmostEqual(max(u for u, _ in large["points"]), 60)

    def test_the_build_makes_a_polygon_not_a_cylinder(self):
        d = design(disc_part(r=10, center=(3, 4)), disc_part("ring", r=6, ri=3, center=(-20, 0)))
        bundle = build_preview(None, {}, design=d)["bundle"]
        parts = {p["name"]: p for p in bundle["parts"]}
        self.assertEqual([q["kind"] for q in parts["disc"]["primitives"]], ["polygon"])
        self.assertEqual([q["kind"] for q in parts["ring"]["primitives"]], ["polygon", "polygon"])
        self.assertTrue(all(q["exact"] for q in parts["disc"]["primitives"] + parts["ring"]["primitives"]))
        self.assertEqual(len(parts["disc"]["primitives"][0]["points"]), disc_segments(10))

    def test_the_mesh_sees_the_sheet(self):
        d = design(disc_part(r=10, center=(3, 4)))
        bundle = build_preview(None, {}, design=d)["bundle"]
        mesh = bundle["mesh"]
        for axis, lo, hi in (("x", -7, 13), ("y", -6, 14)):
            self.assertTrue(any(abs(v - lo) < 0.8 for v in mesh[axis]) and any(abs(v - hi) < 0.8 for v in mesh[axis]),
                            f"no mesh lines at the circle's {axis} extent")

    def test_a_flat_circle_survives_transforms(self):
        d = design(disc_part(r=4, center=(2, 0), transforms=[
            {"type": "mirror", "plane": "x", "keep": True}, {"type": "translate", "copies": 1, "step": [0, 20, 0]},
            {"type": "rotate", "axis": "z", "center": [0, 0, 0], "angle": 30}]))
        prims = parts_of(d)["disc"]["prims"]
        self.assertEqual(len(prims), 4)
        for p in prims:
            self.assertEqual(p["kind"], "polygon")
            self.assertAlmostEqual(area(p) / (math.pi * 16), 1, delta=0.01)

    def test_a_circle_in_another_plane(self):
        d = design({"name": "wall", "material": "copper", "primitives": [
            {"kind": "cylinder", "axis": "x", "center": [1, 2], "radius": 3, "inner_radius": 0, "range": [5, 5]}]})
        p = parts_of(d)["wall"]["prims"][0]
        self.assertEqual((p["kind"], p["normal"], round(p["elevation"], 9)), ("polygon", 0, 5))
        # in-plane coordinates follow CSXCAD: the centre of an x-axis cylinder is (y, z)
        self.assertAlmostEqual(sum(u for u, _ in p["points"]) / len(p["points"]), 1)
        self.assertAlmostEqual(sum(v for _, v in p["points"]) / len(p["points"]), 2)


class Cuts(unittest.TestCase):
    def test_a_round_hole_in_a_rectangular_sheet(self):
        d = design({"name": "plate", "material": "copper",
                    "cuts": [{"kind": "circle", "normal": "z", "elevation": "h", "center": [2, 1], "radius": 3}],
                    "primitives": [{"kind": "box", "start": [-10, -8, "h"], "stop": [10, 8, "h"]}]})
        check_design(d)
        pieces = parts_of(d)["plate"]["prims"]
        self.assertTrue(len(pieces) >= 2)
        self.assertTrue(all(p["kind"] == "polygon" and p["normal"] == 2 for p in pieces))
        n = disc_segments(3)
        hole = 0.5 * n * 9 * math.sin(2 * math.pi / n)
        self.assertAlmostEqual(sum(area(p) for p in pieces), 20 * 16 - hole, places=6)
        # no piece contains the hole's centre
        from fairbeam.design import point_in_polygon
        self.assertFalse(any(point_in_polygon(2, 1, p["points"]) for p in pieces))
        self.assertTrue(any(point_in_polygon(-8, 0, p["points"]) for p in pieces))

    def test_rectangles_still_give_exact_boxes(self):
        d = design({"name": "plate", "material": "copper",
                    "cuts": [{"start": [-1, -3, "h"], "stop": [1, 3, "h"]}],
                    "primitives": [{"kind": "box", "start": [-10, -5, "h"], "stop": [10, 5, "h"]}]})
        pieces = parts_of(d)["plate"]["prims"]
        self.assertEqual({p["kind"] for p in pieces}, {"box"})
        self.assertEqual(len(pieces), 4)

    def test_a_polygon_part_is_cut_by_a_rectangle(self):
        d = design({"name": "tri", "material": "copper",
                    "cuts": [{"start": [20, 20, "h"], "stop": [22, 22, "h"]}],
                    "primitives": [{"kind": "polygon", "normal": "z", "elevation": "h", "points": [[19, 19], [31, 19], [19, 31]]}]})
        check_design(d)
        pieces = parts_of(d)["tri"]["prims"]
        self.assertTrue(all(p["kind"] == "polygon" for p in pieces))
        self.assertAlmostEqual(sum(area(p) for p in pieces), 72 - 4, places=9)
        # the codes of the checks: nothing is unsupported or unused any more
        self.assertEqual([c["code"] for c in lint(d) if c["code"].startswith("cut")], [])

    def test_a_cut_that_misses_a_polygon_keeps_it_as_drawn(self):
        pts = [[19, 19], [31, 19], [19, 31]]
        d = design({"name": "tri", "material": "copper",
                    "cuts": [{"start": [0, 0, "h"], "stop": [1, 1, "h"]}],
                    "primitives": [{"kind": "polygon", "normal": "z", "elevation": "h", "points": pts}]})
        pieces = parts_of(d)["tri"]["prims"]
        self.assertEqual([p["points"] for p in pieces], [pts])
        self.assertEqual([c["code"] for c in lint(d) if c["code"].startswith("cut")], ["cut-unused"])

    def test_a_round_hole_in_a_polygon_and_in_a_flat_circle(self):
        d = design(
            {"name": "tri", "material": "copper",
             "cuts": [{"kind": "circle", "normal": "z", "elevation": "h", "center": [24, 24], "radius": 2}],
             "primitives": [{"kind": "polygon", "normal": "z", "elevation": "h", "points": [[19, 19], [41, 19], [19, 41]]}]},
            disc_part("pad", r=10, center=(-30, 0), cuts=[{"kind": "circle", "normal": "z", "elevation": "h", "center": [-30, 0], "radius": 3}]))
        parts = parts_of(d)
        n = disc_segments(2)
        self.assertAlmostEqual(sum(area(p) for p in parts["tri"]["prims"]), 242 - 0.5 * n * 4 * math.sin(2 * math.pi / n), places=6)
        pad = sum(area(p) for p in parts["pad"]["prims"])
        a = lambda r: 0.5 * disc_segments(r) * r * r * math.sin(2 * math.pi / disc_segments(r))  # noqa: E731
        self.assertAlmostEqual(pad, a(10) - a(3), places=6)
        self.assertEqual([c["code"] for c in lint(d) if c["code"].startswith("cut")], [])

    def test_a_ring_with_a_slot_and_a_polygon_cut(self):
        d = design(disc_part("ring", r=10, ri=6, cuts=[
            {"start": [-1, -12, "h"], "stop": [1, 12, "h"]},
            {"kind": "polygon", "normal": "z", "elevation": "h", "points": [[6, 6], [12, 6], [12, 12]]}]))
        pieces = parts_of(d)["ring"]["prims"]
        self.assertTrue(len(pieces) >= 3)
        self.assertTrue(all(p["kind"] == "polygon" for p in pieces))
        total = sum(area(p) for p in pieces)
        self.assertLess(total, math.pi * (100 - 36))
        self.assertGreater(total, 0.5 * math.pi * (100 - 36) - 20)

    def test_a_cut_in_another_plane_does_not_touch_the_sheet(self):
        d = design({"name": "plate", "material": "copper",
                    "cuts": [{"kind": "circle", "normal": "x", "elevation": 0, "center": [0, 1], "radius": 1}],
                    "primitives": [{"kind": "box", "start": [-10, -8, "h"], "stop": [10, 8, "h"]}]})
        self.assertEqual(len(parts_of(d)["plate"]["prims"]), 1)
        self.assertEqual([c["code"] for c in lint(d) if c["code"].startswith("cut")], ["cut-unused"])

    def test_cuts_that_remove_everything(self):
        d = design(disc_part(r=5, cuts=[{"kind": "circle", "normal": "z", "elevation": "h", "center": [0, 0], "radius": 9}]))
        self.assertEqual(parts_of(d)["disc"]["prims"], [])
        self.assertIn("cut-all", [c["code"] for c in lint(d)])

    def test_a_cut_through_a_solid_is_the_one_refusal_left(self):
        d = design({"name": "block", "material": "copper",
                    "cuts": [{"kind": "circle", "normal": "z", "elevation": "h + 0.5", "center": [0, 0], "radius": 2}],
                    "primitives": [{"kind": "box", "start": [-5, -5, "h"], "stop": [5, 5, "h + 1"]}]})
        found = [c for c in lint(d) if c["code"] == "cut-unsupported"]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["path"], "parts[3].cuts[0]")
        self.assertIn("primitives[0] (a brick with thickness at the cut's plane)", found[0]["message"])
        self.assertIn("not from a solid", found[0]["message"])
        self.assertEqual(len(parts_of(d)["block"]["prims"]), 1)           # the solid is left whole
        # a sheet in another plane is only crossed along a line: no warning
        d = design({"name": "walls", "material": "copper",
                    "cuts": [{"start": [-2, -2, "h"], "stop": [2, 2, "h"]}],
                    "primitives": [{"kind": "box", "start": [-5, -5, "h"], "stop": [5, 5, "h"]},
                                   {"kind": "box", "start": [0, -5, 0], "stop": [0, 5, "h"]}]})
        self.assertEqual([c["code"] for c in lint(d) if c["code"].startswith("cut")], [])

    def test_cut_field_errors(self):
        d = design({"name": "p", "material": "copper",
                    "cuts": [{"kind": "circle", "normal": "z", "elevation": 0, "center": [0, 0], "radius": -1},
                             {"kind": "polygon", "normal": "z", "elevation": 0, "points": [[0, 0], [1, 1]]},
                             {"kind": "polygon", "normal": "z", "elevation": 0, "points": [[0, 0], [2, 2], [4, 4]]},
                             {"start": [0, 0, 0], "stop": [1, 1, 1]}],
                    "primitives": [{"kind": "box", "start": [-5, -5, 0], "stop": [5, 5, 0]}]})
        got = {(c["code"], c["path"]) for c in lint(d) if c["severity"] == "error"}
        self.assertIn(("radius", "parts[3].cuts[0].radius"), got)
        self.assertIn(("polygon-points", "parts[3].cuts[1].points"), got)
        self.assertIn(("polygon-area", "parts[3].cuts[2].points"), got)
        self.assertIn(("cut-sheet", "parts[3].cuts[3].stop"), got)
        for bad, where in (({"kind": "blob"}, "parts[0].cuts[0].kind"),
                           ({"kind": "circle", "normal": "w", "center": [0, 0], "radius": 1}, "parts[0].cuts[0].normal"),
                           ({"kind": "circle", "radius": 1}, "parts[0].cuts[0]")):
            dd = design({"name": "p", "material": "copper", "cuts": [bad],
                         "primitives": [{"kind": "box", "start": [0, 0, 0], "stop": [1, 1, 0]}]})
            dd["parts"] = dd["parts"][3:]
            with self.assertRaises(DesignError) as cm:
                check_design(dd)
            self.assertTrue(cm.exception.where.startswith(where), (cm.exception.where, where))

    def test_resolve_cuts_and_apply_cuts_directly(self):
        pt = {"cuts": [{"kind": "circle", "normal": "y", "elevation": 2, "center": [1, 1], "radius": 0.5}]}
        cut = resolve_cuts(pt, {}, "p")[0]
        self.assertEqual((cut["axis"], cut["plane"], cut["shape"]), (1, 2, "circle"))
        sheet = {"kind": "box", "priority": 10, "where": "x", "start": [0, 2, 0], "stop": [3, 2, 3]}
        pieces = apply_cuts([sheet], [cut])
        self.assertTrue(all(p["kind"] == "polygon" and p["normal"] == 1 and p["elevation"] == 2 for p in pieces))
        self.assertTrue(all("start" not in p for p in pieces))
        solid = {"kind": "box", "priority": 10, "where": "x", "start": [0, 1, 0], "stop": [3, 3, 3]}
        self.assertEqual(apply_cuts([solid], [cut]), [solid])

    def test_a_live_boolean_of_bricks_takes_a_round_cut_on_an_operand(self):
        """A round cut on an operand of a Boolean of bricks is folded in first (the sheet becomes polygons): the design
        checks accept it and the result is the cut sheet united with the other."""
        operand = lambda name, x: {"name": name, "material": "copper", "primitives": [  # noqa: E731
            {"kind": "box", "start": [x, 0, 0], "stop": [x + 4, 4, 0]}]}
        a = operand("a", 0)
        a["cuts"] = [{"kind": "circle", "normal": "z", "elevation": 0, "center": [2, 2], "radius": 1}]
        h = {"operation": "add", "live": True, "A": a, "B": operand("b", 3)}
        out = boolean_primitives(h, {}, "h")
        self.assertTrue(out and all(p["kind"] == "polygon" for p in out))
        disc = math.pi
        self.assertAlmostEqual(sum(area(p) for p in out), 16 + 16 - 4 - disc, delta=0.03)
        d = blank_design("t", "T")
        d["parts"] = [{**copy.deepcopy(operand("r", 0)), "booleanHistory": h}]
        check_design(d)


class ExportedPython(unittest.TestCase):
    def check_same(self, d, value_sets=({},)):
        check_design(d)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "t.py"
            path.write_text(to_python(d))
            for values in value_sets:
                with self.subTest(values=values):
                    a = build_preview(None, values, design=d)["bundle"]["parts"]
                    b = build_preview(str(path), values)["bundle"]["parts"]
                    self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))

    def test_flat_circles_rings_and_cuts(self):
        d = design(
            disc_part(r="R", center=(0, 0), cuts=[{"kind": "circle", "normal": "z", "elevation": "h", "center": [1, 1], "radius": 1.5},
                                                   {"start": [-1, -12, "h"], "stop": [1, -8, "h"]}]),
            disc_part("ring", r=6, ri=3, center=(-30, 0), transforms=[{"type": "translate", "copies": 1, "step": [0, 25, 0]},
                                                                      {"type": "rotate", "axis": "z", "center": [0, 0, 0], "angle": 30}]),
            {"name": "tri", "material": "copper", "transforms": [{"type": "mirror", "plane": "y"}],
             "cuts": [{"kind": "polygon", "normal": "z", "elevation": "h", "points": [[21, 21], [24, 21], [24, 24]]}],
             "primitives": [{"kind": "polygon", "normal": "z", "elevation": "h", "points": [[19, 19], [31, 19], [19, 31]]}]},
            {"name": "post", "material": "copper", "primitives": [
                {"kind": "cylinder", "axis": "z", "center": [40, 40], "radius": 1, "inner_radius": 0.5, "range": [0, "h"]}]})
        d["params"].append({"key": "R", "default": 10, "label": "Radius", "unit": "mm"})
        self.check_same(d, ({}, {"R": 25}))

    def test_a_cylinder_that_becomes_flat_at_other_values(self):
        d = design({"name": "post", "material": "copper", "primitives": [
            {"kind": "cylinder", "axis": "z", "center": [40, 40], "radius": 2, "range": [0, "t"]}]})
        d["params"].append({"key": "t", "default": 3, "label": "Thickness", "unit": "mm"})
        self.check_same(d, ({}, {"t": 0}))
        flat = build_preview(None, {"t": 0}, design=d)["bundle"]["parts"][-1]["primitives"]
        self.assertEqual([p["kind"] for p in flat], ["polygon"])

    def test_module_build_runs(self):
        d = design(disc_part(r=10))
        module = module_for(d)
        sim = module.build({p.key: p.default for p in module.PARAMS})
        self.assertIsNotNone(sim)


if __name__ == "__main__":
    unittest.main()
