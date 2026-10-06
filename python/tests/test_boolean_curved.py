"""Booleans with curved shapes (python/fairbeam/design.py and boolean_curved.py): Add and Insert keep every
shape, Subtract adds cut-outs (void shapes; exact coaxial cases), Intersect is exact where it can be and
refuses the rest with the combination and what to do instead; plus an end-to-end build of a PEC block minus
a cylinder into CSXCAD. The designer's side is scripts/check-boolean-curved.mjs; the two are compared on
the shared cases in test_boolean_live.py (fixtures/boolean_parity.json)."""

import math
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.design import DesignError, blank_design, boolean_primitives, build, check_design, resolve_names, resolve_parts  # noqa: E402
from fairbeam.design_checks import lint  # noqa: E402
from fairbeam.polyclip import ring_area  # noqa: E402


def part(name, prims, material="copper", **extra):
    return {"name": name, "material": material, "primitives": prims, **extra}


def box(a, b, **extra):
    return {"kind": "box", "start": a, "stop": b, **extra}


def cyl(axis, center, r, rng, **extra):
    return {"kind": "cylinder", "axis": axis, "center": center, "radius": r, "range": rng, **extra}


TETRA = {"kind": "polyhedron", "vertices": [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], "faces": [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]]}
KINDS = {
    "cylinder": cyl("z", [5, 5], 1, [0, 3]),
    "tube": cyl("z", [5, 5], 1, [0, 3], inner_radius=0.5),
    "cone": {"kind": "cone", "axis": "z", "center": [5, 5], "bottom_radius": 1, "top_radius": 0.4, "range": [0, 3]},
    "sphere": {"kind": "sphere", "center": [5, 5, 2], "radius": 1},
    "torus": {"kind": "torus", "axis": "z", "center": [5, 5, 2], "major_radius": 2, "minor_radius": 0.5},
    "wire": {"kind": "wire", "points": [[5, 5, 0], [5, 5, 3], [6, 5, 4]], "radius": 0.2},
    "polyhedron": TETRA,
}


def run(op, a, b, values=None):
    return boolean_primitives({"operation": op, "A": a, "B": b}, values or {}, "h")


def base():
    return part("A", [box([0, 0, 0], [10, 10, 4])])


def cell_volume(p):
    return math.pi * (p["radius"] ** 2 - p.get("inner_radius", 0) ** 2) * abs(p["range"][1] - p["range"][0])


class AddAndInsert(unittest.TestCase):
    def test_add_keeps_every_kind(self):
        for name, shape in KINDS.items():
            with self.subTest(kind=name):
                out = run("add", base(), part("B", [shape]))
                self.assertEqual([p["kind"] for p in out], ["box", shape["kind"]])
                self.assertFalse(any(p.get("void") for p in out))

    def test_add_unites_bricks_and_keeps_the_priority(self):
        a = part("A", [box([0, 0, 0], [4, 4, 2], priority=7), cyl("z", [1, 1], 0.5, [2, 5], priority=7)])
        b = part("B", [box([3, 0, 0], [8, 4, 2], priority=7), {**KINDS["sphere"], "priority": 7}])
        out = run("add", a, b)
        self.assertEqual([p["kind"] for p in out], ["box", "cylinder", "sphere"])
        self.assertEqual([p["priority"] for p in out], [7, 7, 7])
        self.assertEqual((out[0]["start"], out[0]["stop"]), ([0, 0, 0], [8, 4, 2]))

    def test_add_needs_the_same_material_and_priority(self):
        with self.assertRaisesRegex(DesignError, "same material"):
            run("add", base(), part("B", [KINDS["sphere"]], material="fr4"))
        with self.assertRaisesRegex(DesignError, "same priority"):
            run("add", part("A", [box([0, 0, 0], [1, 1, 1], priority=3)]), part("B", [KINDS["sphere"]]))

    def test_insert_keeps_a_whole(self):
        for name, shape in KINDS.items():
            with self.subTest(kind=name):
                self.assertEqual(run("insert", base(), part("B", [shape])), [{"kind": "box", "start": [0, 0, 0], "stop": [10, 10, 4]}])
        # bricks only: the exact A - B stays
        self.assertGreater(len(run("insert", base(), part("B", [box([2, 2, 2], [4, 4, 6])]))), 1)


class Subtract(unittest.TestCase):
    def test_every_kind_becomes_a_cut_out(self):
        for name, shape in KINDS.items():
            with self.subTest(kind=name):
                out = run("subtract", base(), part("B", [shape]))
                self.assertEqual(out[0], {"kind": "box", "start": [0, 0, 0], "stop": [10, 10, 4]})
                self.assertEqual((out[1]["kind"], out[1].get("void"), "priority" in out[1]), (shape["kind"], True, False))

    def test_the_host_keeps_its_priority_and_cut_outs_add_up(self):
        a = part("A", [box([0, 0, 0], [10, 10, 4], priority=7)])
        first = run("subtract", a, part("B", [KINDS["sphere"]]))
        self.assertEqual((first[0]["priority"], "priority" in first[1]), (7, False))
        nested = {**a, "primitives": first, "booleanHistory": {"operation": "subtract", "live": True, "A": a, "B": part("B", [KINDS["sphere"]])}}
        both = run("subtract", nested, part("C", [cyl("z", [8, 8], 1, [-1, 5])]))
        self.assertEqual([bool(p.get("void")) for p in both], [False, True, True])

    def test_a_part_with_a_cut_out_cannot_be_subtracted_or_added(self):
        cut = part("C", [box([0, 0, 0], [1, 1, 1]), {**cyl("z", [1, 1], 0.5, [-1, 5]), "void": True}])
        with self.assertRaisesRegex(DesignError, "cut-out of its own"):
            run("subtract", base(), cut)
        with self.assertRaisesRegex(DesignError, "cut-out from an earlier Subtract"):
            run("add", cut, part("D", [cyl("z", [3, 3], 0.5, [0, 3])]))

    def test_a_sheet_is_cut_through(self):
        ground = part("G", [box([0, 0, 1.6], [20, 20, 1.6])])
        # a face on the sheet cuts it (measured with openEMS): kept, and made exact when it is off by rounding
        self.assertEqual(run("subtract", ground, part("V", [cyl("z", [5, 5], 1, [1.6, 5])]))[1]["range"], [1.6, 5])
        self.assertEqual(run("subtract", ground, part("V", [cyl("z", [5, 5], 1, [0, 3])]))[1]["range"], [0, 3])
        self.assertEqual(run("subtract", ground, part("V", [cyl("z", [5, 5], 1, [1.6 + 1e-12, 5])]))[1]["range"], [1.6, 5])
        self.assertEqual(run("subtract", ground, part("V", [cyl("z", [5, 5], 1, [-2, 1.6 - 1e-12])]))[1]["range"], [-2, 1.6])
        self.assertEqual(run("subtract", ground, part("V", [cyl("z", [5, 5], 1, [1.7, 5])]))[1]["range"], [1.7, 5], "a gap stays (the check says it cuts nothing)")
        with self.assertRaisesRegex(DesignError, "removes nothing"):
            run("subtract", part("A", [cyl("z", [0, 0], 3, [0, 3])]), part("B", [box([-1, -1, 1], [1, 1, 1])]))

    def test_cylinder_minus_a_coaxial_cylinder_is_a_tube(self):
        out = run("subtract", part("A", [cyl("z", [1, 2], 5, [0, 10])]), part("B", [cyl("z", [1, 2], 2, [-1, 20])]))
        self.assertEqual(out, [{"kind": "cylinder", "axis": "z", "center": [1, 2], "radius": 5, "inner_radius": 2, "range": [0, 10]}])
        blind = run("subtract", part("A", [cyl("x", [1, 2], 5, [0, 10])]), part("B", [cyl("x", [1, 2], 2, [-1, 6])]))
        self.assertAlmostEqual(sum(cell_volume(p) for p in blind), math.pi * (25 * 10 - 4 * 6), places=9)
        self.assertFalse(any(p.get("void") for p in blind))
        off = run("subtract", part("A", [cyl("z", [1, 2], 5, [0, 10])]), part("B", [cyl("z", [1.5, 2], 2, [-1, 20])]))
        self.assertEqual([bool(p.get("void")) for p in off], [False, True])


class Intersect(unittest.TestCase):
    def test_coaxial_cylinders_and_tubes(self):
        a = part("A", [cyl("y", [0, 0], 5, [0, 10]), cyl("y", [0, 0], 8, [0, 10], inner_radius=6)])
        b = part("B", [cyl("y", [0, 0], 7, [3, 20], inner_radius=2)])
        self.assertAlmostEqual(sum(cell_volume(p) for p in run("intersect", a, b)), math.pi * ((25 - 4) * 7 + (49 - 36) * 7), places=9)

    def test_tube_and_cone_trimmed_across_their_axis(self):
        tube = run("intersect", part("A", [cyl("z", [2, 3], 4, [0, 10], inner_radius=1)]), part("B", [box([-5, -5, 2], [10, 10, 7])]))
        self.assertEqual(tube, [cyl("z", [2, 3], 4, [2, 7], inner_radius=1)])
        cone = run("intersect", part("A", [{"kind": "cone", "axis": "x", "center": [0, 0], "bottom_radius": 4, "top_radius": 1, "range": [0, 12]}]),
                   part("B", [box([3, -9, -9], [8, 9, 9])]))
        self.assertEqual(cone, [{"kind": "cone", "axis": "x", "center": [0, 0], "bottom_radius": 3.25, "top_radius": 2, "range": [3, 8]}])

    def test_cylinder_along_the_polygon_axis_is_faceted_or_kept(self):
        whole = run("intersect", part("A", [cyl("z", [5, 5], 3, [0, 4])]), part("B", [box([-9, -9, 1], [19, 19, 3])]))
        self.assertEqual(whole, [cyl("z", [5, 5], 3, [1, 3])])
        clip = {"kind": "linpoly", "normal": "z", "elevation": 1, "length": 2, "points": [[4, 0], [10, 0], [10, 6], [4, 6]]}
        cut = run("intersect", part("A", [cyl("z", [5, 5], 3, [0, 4])]), part("B", [clip]))
        self.assertTrue(all(p["kind"] == "linpoly" for p in cut))
        area = sum(ring_area(p["points"]) for p in cut)
        exact = sum((min(6, 5 + math.sqrt(9 - (4 + 4 * (i + 0.5) / 40000 - 5) ** 2)) - (5 - math.sqrt(9 - (4 + 4 * (i + 0.5) / 40000 - 5) ** 2))) * 4 / 40000
                    for i in range(40000))
        self.assertTrue(exact * 0.996 < area < exact, (area, exact))
        self.assertTrue(all((x - 5) ** 2 + (y - 5) ** 2 <= 9 + 1e-9 for p in cut for x, y in p["points"]))

    def test_shapes_inside_or_away_from_a_brick(self):
        for name in ("sphere", "torus", "wire", "polyhedron", "cone"):
            shape = KINDS[name]
            with self.subTest(kind=name):
                inside = run("intersect", part("A", [shape]), part("B", [box([-1, -1, -1], [11, 11, 11])]))
                self.assertEqual([p["kind"] for p in inside], [shape["kind"]])
                with self.assertRaisesRegex(DesignError, "empty"):
                    run("intersect", part("A", [shape]), part("B", [box([20, 20, 20], [30, 30, 30])]))

    def test_refusals_name_the_combination_and_what_to_do(self):
        def refuse(a, b):
            with self.assertRaises(DesignError) as err:
                run("intersect", part("A", [a]), part("B", [b]))
            return err.exception.detail
        m = refuse(KINDS["sphere"], cyl("z", [5, 5], 1, [-3, 8]))
        self.assertIn("Intersect of A (a sphere) and B (a cylinder) is not supported", m)
        self.assertIn("Subtract the part you do not want", m)
        self.assertIn("do not share one axis", refuse(cyl("z", [0, 0], 2, [-3, 3]), cyl("x", [0, 0], 1, [-3, 3])))
        self.assertIn("general solid intersection", refuse(KINDS["sphere"], box([5, 0, 0], [20, 20, 20])))
        self.assertIn("a polyhedron) and B (a cone)", refuse(TETRA, {"kind": "cone", "axis": "z", "center": [0.3, 0.3], "bottom_radius": 1, "top_radius": 0.2, "range": [0, 3]}))
        self.assertIn("a tube", refuse(KINDS["tube"], KINDS["sphere"]))
        with self.assertRaisesRegex(DesignError, "sheet with a volume"):
            run("intersect", part("A", [cyl("z", [5, 5], 3, [0, 4])]), part("B", [box([0, 0, 1], [10, 10, 1])]))


class Build(unittest.TestCase):
    """A PEC block minus a cylinder, built with design.py into CSXCAD."""

    def design(self, host, cutter, op="subtract"):
        d = blank_design("curved", "Curved")
        d["materials"] = [{"name": "copper", "kind": "metal"}]
        h = {"operation": op, "A": host, "B": cutter, "live": True}
        d["parts"] = [{**host, "primitives": boolean_primitives(h, resolve_names(d, {}), "h"), "booleanHistory": h}]
        d["ports"] = [{"number": 1, "R": 50, "start": [-9, 0, 0], "stop": [-9, 0, 2], "direction": "z"}]
        return d

    def test_pec_box_minus_cylinder(self):
        host = part("block", [box([-10, -10, 0], [10, 10, 2])])
        d = self.design(host, part("hole", [cyl("z", [0, 0], 3, [-1, 3])]))
        check_design(d)
        sim = build(d, {})
        prims = {}
        for p in sim.csx.GetAllPrimitives():
            prims.setdefault(p.GetProperty().GetName(), []).append(p)
        # the carver exists, as vacuum, above the block
        self.assertTrue({"block", "block (cut)", "port_excite_1"} <= set(prims), sorted(prims))
        self.assertEqual(len(prims["block (cut)"]), 1)
        carver, block = prims["block (cut)"][0], prims["block"][0]
        self.assertGreater(carver.GetPriority(), block.GetPriority())
        self.assertEqual(carver.GetProperty().GetTypeString(), "Material")
        self.assertEqual((float(np.atleast_1d(carver.GetProperty().GetMaterialProperty("epsilon"))[0]), float(np.atleast_1d(carver.GetProperty().GetMaterialProperty("mue"))[0])), (1.0, 1.0))
        self.assertEqual(float(np.atleast_1d(carver.GetProperty().GetMaterialProperty("kappa"))[0]), 0.0)
        self.assertEqual(sim.materials["block (cut)"]["void"], True)
        # the lumped port stays between the (default) dielectrics and the metal
        port = prims["port_excite_1"][0].GetPriority()
        self.assertLess(port, block.GetPriority())
        # the carver is the cylinder of the cut, at the right place and size
        self.assertEqual(carver.GetTypeName(), "Cylinder")
        self.assertEqual((list(carver.GetStart()), list(carver.GetStop())), ([0.0, 0.0, -1.0], [0.0, 0.0, 3.0]))
        self.assertEqual(carver.GetBoundBox().tolist(), [[-3.0, -3.0, -1.0], [3.0, 3.0, 3.0]])
        # the bundle marks the carver
        parts = {p["name"]: p for p in sim.to_bundle({"id": "x", "name": "x"}, [])["parts"]}
        self.assertTrue(parts["block (cut)"]["void"])
        self.assertNotIn("void", parts["block"])

    def test_pec_sheet_minus_a_cylinder_standing_on_it(self):
        host = part("ground", [box([-10, -10, 0], [10, 10, 0])])
        d = self.design(host, part("hole", [cyl("z", [0, 0], 3, [0, 2])]))
        carver = resolve_parts(d, resolve_names(d, {}))[0]["voids"][0]
        self.assertEqual((carver["start"][2], carver["stop"][2]), (0, 2))   # its face lies on the sheet: that cuts it
        codes = [c["code"] for c in lint(d)]
        self.assertNotIn("boolean-cut-reach", codes)

    def test_live_result_follows_the_parameter(self):
        d = blank_design("curved", "Curved")
        d["materials"] = [{"name": "copper", "kind": "metal"}]
        d["params"] = [{"key": "r", "default": 3}]
        host = part("block", [box([-10, -10, 0], [10, 10, 2])])
        h = {"operation": "subtract", "A": host, "B": part("hole", [cyl("z", [0, 0], "r", [-1, 3])]), "live": True}
        d["parts"] = [{**host, "primitives": boolean_primitives(h, {"r": 3}, "h"), "booleanHistory": h}]
        self.assertEqual(resolve_parts(d, {"r": 3})[0]["voids"][0]["radius"], 3)
        self.assertEqual(resolve_parts(d, {"r": 4.5})[0]["voids"][0]["radius"], 4.5)


if __name__ == "__main__":
    unittest.main()
