"""Void carvers (a Boolean Subtract of a curved shape): resolve_parts, the build's vacuum property and
priority ranking, the Python export, the checks and the bundle's ``void`` marker."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.design import blank_design, build, check_design, resolve_names, resolve_parts, to_python  # noqa: E402
from fairbeam.design_checks import EXPLANATIONS, lint  # noqa: E402
from fairbeam.preview import build_preview  # noqa: E402


def box(a, b, **extra):
    return {"kind": "box", "start": a, "stop": b, **extra}


def cyl(r, lo, hi, **extra):
    return {"kind": "cylinder", "axis": "z", "center": [0, 0], "radius": r, "range": [lo, hi], **extra}


def design(parts, ports=(), resistors=()):
    d = blank_design("void", "Void")
    d["materials"] = [{"name": "copper", "kind": "metal"}, {"name": "fr4", "kind": "dielectric", "eps_r": "4.3", "tan_d": "0.02"}]
    d["parts"] = parts
    d["ports"] = list(ports)
    d["resistors"] = list(resistors)
    return d


def plate():
    """A PEC block with a cylindrical cut-out through it."""
    return {"name": "plate", "material": "copper", "primitives": [
        box([-10, -10, 0], [10, 10, 2]), cyl(3, -1, 3, void=True)]}


def sub(priority=None, name="sub"):
    pr = box([-12, -12, -1], [12, 12, 3])
    if priority is not None:
        pr["priority"] = priority
    return {"name": name, "material": "fr4", "primitives": [pr]}


def resolved(d):
    return resolve_parts(d, resolve_names(d, {}))


def csx_priorities(sim):
    out = {}
    for prim in sim.csx.GetAllPrimitives():
        out.setdefault(prim.GetProperty().GetName(), []).append(int(prim.GetPriority()))
    return out


def codes(d, code):
    return [c for c in lint(d) if c["code"] == code]


class Resolve(unittest.TestCase):
    def test_voids_split_out_with_host_priority_plus_half(self):
        metal, dielectric = resolved(design([plate(), {"name": "air", "material": "fr4", "primitives": [
            box([0, 0, 0], [1, 1, 1]), cyl(0.2, 0, 1, void=True)]}]))
        self.assertEqual([p["kind"] for p in metal["prims"]], ["box"])
        self.assertEqual([(p["kind"], p["priority"], p.get("void")) for p in metal["voids"]], [("cylinder", 10.5, True)])
        self.assertEqual([p["priority"] for p in dielectric["voids"]], [0.5])
        self.assertEqual(dielectric["prims"][0]["priority"], 0)

    def test_highest_solid_priority_and_explicit_priority(self):
        part = {"name": "p", "material": "copper", "primitives": [
            box([0, 0, 0], [1, 1, 1], priority=12), box([0, 0, 0], [2, 2, 2]),
            cyl(0.3, 0, 1, void=True), cyl(0.2, 0, 1, void=True, priority=20), cyl(0.1, 0, 1, void=True, priority=11.5)]}
        voids = resolved(design([part]))[0]["voids"]
        self.assertEqual([p["priority"] for p in voids], [12.5, 20, 11.5])

    def test_fractional_priority_of_an_ordinary_shape_and_whole_floats(self):
        part = {"name": "p", "material": "copper", "primitives": [
            box([0, 0, 0], [1, 1, 1], priority=10.5), box([0, 0, 0], [2, 2, 2], priority=11.0), box([0, 0, 0], [2, 2, 2], priority=3)]}
        prims = resolved(design([part]))[0]["prims"]
        self.assertEqual([p["priority"] for p in prims], [10.5, 11, 3])
        self.assertEqual([type(p["priority"]) for p in prims], [float, int, int])

    def test_part_with_only_voids_is_harmless(self):
        d = design([plate(), {"name": "only", "material": "copper", "primitives": [cyl(1, 0, 1, void=True)]}])
        check_design(d)
        part = resolved(d)[1]
        self.assertEqual((part["prims"], [p["priority"] for p in part["voids"]]), ([], [10.5]))

    def test_transforms_apply_to_voids_and_sheet_cuts_do_not(self):
        part = {"name": "s", "material": "copper", "primitives": [box([-5, -5, 0], [5, 5, 0]), cyl(1, -1, 1, void=True)],
                "transforms": [{"type": "move", "offset": [20, 0, 0]}],
                "cuts": [{"start": [-1, -1, 0], "stop": [1, 1, 0]}]}
        got = resolved(design([part]))[0]
        self.assertEqual(got["voids"][0]["start"][0], 20)    # moved with the part
        self.assertGreater(len(got["prims"]), 1)             # the sheet is cut into pieces ...
        self.assertEqual(len(got["voids"]), 1)               # ... the carver is not


class Build(unittest.TestCase):
    def ported(self, parts):
        return design(parts, ports=[{"number": 1, "R": 50, "start": [-9, 0, 0], "stop": [-9, 0, 2], "direction": "z"}],
                      resistors=[{"name": "R1", "R": 50, "start": [9, 0, 0], "stop": [9, 0, 2], "direction": "z"}])

    def test_vacuum_property_and_ranked_priorities(self):
        sim = build(self.ported([plate(), sub()]), {})
        prio = csx_priorities(sim)
        meta = sim.materials["plate (cut)"]
        self.assertTrue(meta["void"])
        self.assertEqual(meta["kind"], "dielectric")
        # priorities {0 sub, 5 ports, 10 plate, 10.5 carver} -> 0..3, order kept
        self.assertEqual((prio["sub"], prio["plate"], prio["plate (cut)"]), ([0], [2], [3]))
        others = {k: v for k, v in prio.items() if k in ("port_resist_1", "port_excite_1", "R1")}
        self.assertTrue(others)
        self.assertTrue(all(set(v) == {1} for v in others.values()), others)   # port and resistor between

    def test_no_ranking_without_fractions(self):
        sim = build(self.ported([{"name": "plate", "material": "copper", "primitives": [box([-10, -10, 0], [10, 10, 2])]}, sub()]), {})
        prio = csx_priorities(sim)
        self.assertEqual((prio["sub"], prio["plate"]), ([0], [10]))
        others = {k: v for k, v in prio.items() if k in ("port_resist_1", "port_excite_1", "R1")}
        self.assertTrue(others)
        self.assertTrue(all(set(v) == {5} for v in others.values()), others)
        self.assertNotIn("plate (cut)", prio)

    def test_bundle_marks_the_carver(self):
        bundle = build_preview(None, {}, design=self.ported([plate(), sub()]))["bundle"]
        by = {p["name"]: p for p in bundle["parts"]}
        cut = by["plate (cut)"]
        self.assertTrue(cut["void"])
        self.assertEqual(cut["type"], "Material")
        self.assertEqual((cut["material"]["eps_r"], cut["material"]["mu_r"], cut["material"]["kappa"]), (1.0, 1.0, 0.0))
        self.assertGreater(cut["primitives"][0]["priority"], by["plate"]["primitives"][0]["priority"])
        self.assertNotIn("void", by["plate"])
        self.assertNotIn("void", by["sub"])

    def same_as_export(self, d):
        direct = build_preview(None, {}, design=d)["bundle"]["parts"]
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "void.py"
            script.write_text(to_python(d))
            exported = build_preview(str(script), {})["bundle"]["parts"]
        self.assertEqual(json.dumps(direct, sort_keys=True), json.dumps(exported, sort_keys=True))
        return direct

    def test_python_export_equals_direct_build(self):
        parts = self.same_as_export(self.ported([plate(), sub()]))
        self.assertIn("plate (cut)", [p["name"] for p in parts])

    def test_python_export_with_an_array_of_carvers(self):
        moved = plate()
        moved["transforms"] = [{"type": "translate", "step": [30, 0, 0], "copies": 1}]
        parts = self.same_as_export(self.ported([moved, sub()]))
        cut = next(p for p in parts if p["name"] == "plate (cut)")
        self.assertEqual(len(cut["primitives"]), 2)

    def test_python_export_ranks_only_with_a_fraction(self):
        plain = self.ported([{"name": "plate", "material": "copper", "primitives": [box([-10, -10, 0], [10, 10, 2])]}, sub()])
        self.assertIn("priority=5", to_python(plain))
        self.assertNotIn("(cut)", to_python(plain))
        carved = to_python(self.ported([plate(), sub()]))
        self.assertIn("(cut)", carved)
        self.assertIn("priority=1", carved)
        self.assertNotIn("priority=5", carved)


class Checks(unittest.TestCase):
    def test_no_false_findings_for_a_carver(self):
        d = design([plate()], ports=[{"number": 1, "R": 50, "start": [-9, 0, 0], "stop": [-9, 0, 2], "direction": "z"}])
        found = {c["code"] for c in lint(d)}
        self.assertFalse(found & {"part-hidden", "metal-floating", "metal-overhang", "mesh-feature", "part-empty",
                                  "boolean-cut-erases", "boolean-cut-reach"}, found)

    def test_port_end_in_a_hole_is_not_touching_metal(self):
        sheet = {"name": "sheet", "material": "copper", "primitives": [box([-10, -10, 2], [10, 10, 2])]}
        gnd = {"name": "gnd", "material": "copper", "primitives": [box([-10, -10, 0], [10, 10, 0])]}
        port = [{"number": 1, "R": 50, "start": [0, 0, 0], "stop": [0, 0, 2], "direction": "z"}]
        self.assertEqual(codes(design([gnd, sheet], port), "port-floating"), [])
        sheet["primitives"].append(cyl(3, 1, 3, void=True))
        floating = codes(design([gnd, sheet], port), "port-floating")
        self.assertEqual([c["path"] for c in floating], ["ports[0].stop"])

    def test_cut_erases_fires_for_a_lower_priority_part_and_not_for_a_higher_one(self):
        found = codes(design([plate(), sub()]), "boolean-cut-erases")
        self.assertEqual([c["path"] for c in found], ["parts[0]"])
        self.assertEqual(found[0]["severity"], "warning")
        self.assertEqual(found[0]["message"],
                         "the cut-out in 'plate' also erases part of 'sub', which has the same or a lower priority: "
                         "give 'sub' a higher priority (above 'plate') to keep it")
        self.assertEqual(found[0]["explain"], EXPLANATIONS["boolean-cut-erases"])
        self.assertEqual(codes(design([plate(), sub(priority=11)]), "boolean-cut-erases"), [])
        far = {"name": "far", "material": "fr4", "primitives": [box([30, 30, 0], [40, 40, 1])]}   # out of reach
        self.assertEqual(codes(design([plate(), far]), "boolean-cut-erases"), [])

    def test_cut_reach(self):
        def sheet(lo, hi):
            return {"name": "sheet", "material": "copper", "primitives": [box([-10, -10, 0], [10, 10, 0]), cyl(2, lo, hi, void=True)]}
        found = codes(design([sheet(0.5, 2)]), "boolean-cut-reach")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["severity"], "warning")
        self.assertEqual(found[0]["message"], "the cut-out in 'sheet' does not reach the zero-thickness sheet in 'sheet': "
                         "it removes nothing there (a gap, or no thickness: let it touch or cross the sheet)")
        self.assertEqual(codes(design([sheet(-1, 1)]), "boolean-cut-reach"), [])
        self.assertEqual(codes(design([sheet(0, 2)]), "boolean-cut-reach"), [], "a face on the sheet cuts it (measured with openEMS)")
        self.assertEqual(codes(design([sheet(-2, 0)]), "boolean-cut-reach"), [])
        polygon = {"name": "poly", "material": "copper", "primitives": [
            {"kind": "polygon", "normal": "z", "elevation": 0, "points": [[-5, -5], [5, -5], [5, 5], [-5, 5]]},
            cyl(1, 0.2, 1, void=True)]}
        self.assertEqual(len(codes(design([polygon]), "boolean-cut-reach")), 1)
        beside = {"name": "s2", "material": "copper", "primitives": [box([-10, -10, 0], [-5, -5, 0]), cyl(1, 0.2, 1, void=True)]}
        self.assertEqual(codes(design([beside]), "boolean-cut-reach"), [])   # no overlap in the plane


if __name__ == "__main__":
    unittest.main()
