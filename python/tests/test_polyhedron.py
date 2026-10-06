"""The design schema's ``polyhedron`` primitive: validation, build, transforms, export, the horn."""

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.design import (DesignError, blank_design, check_design, polyhedron_triangles, prim_bbox,  # noqa: E402
                             prim_contains, resolve_names, resolve_parts, to_python)
from fairbeam.design_checks import lint  # noqa: E402
from fairbeam.example_design import convert_example  # noqa: E402
from fairbeam.geometry import read_structure  # noqa: E402
from fairbeam.preview import build_preview  # noqa: E402

MODELS = Path(__file__).resolve().parents[1] / "models"
# a cuboid with quad faces (fanned into 12 triangles) at x 1..3, y 2..4, z 3..h+4
CUBOID = {"kind": "polyhedron",
          "vertices": [[1, 2, 3], [3, 2, 3], [3, 4, 3], [1, 4, 3], [1, 2, "h + 4"], [3, 2, "h + 4"], [3, 4, "h + 4"], [1, 4, "h + 4"]],
          "faces": [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]}


def design_with(prim, transforms=None):
    d = blank_design("poly", "Poly")
    part = {"name": "solid", "material": "copper", "primitives": [copy.deepcopy(prim)]}
    if transforms:
        part["transforms"] = transforms
    d["parts"].append(part)
    return d


def _cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


class PolyhedronSchema(unittest.TestCase):
    def test_validation(self):
        check_design(design_with(CUBOID))
        bad = {
            "three vertices": {**CUBOID, "vertices": CUBOID["vertices"][:3], "faces": [[0, 1, 2]] * 4},
            "three faces": {**CUBOID, "faces": CUBOID["faces"][:3]},
            "index out of range": {**CUBOID, "faces": CUBOID["faces"][:5] + [[0, 1, 8]]},
            "negative index": {**CUBOID, "faces": CUBOID["faces"][:5] + [[0, 1, -1]]},
            "two-vertex face": {**CUBOID, "faces": CUBOID["faces"][:5] + [[0, 1]]},
            "repeated vertex": {**CUBOID, "faces": CUBOID["faces"][:5] + [[0, 0, 1]]},
            "not lists": {"kind": "polyhedron", "vertices": "x", "faces": 3},
        }
        for name, prim in bad.items():
            d = design_with(prim)
            check_design(d)   # the structure is read; the shape is refused where it is built and by the checks
            with self.subTest(name), self.assertRaises(DesignError):
                resolve_parts(d, resolve_names(d, {}))
            with self.subTest(name):
                self.assertIn("polyhedron", [c["code"] for c in lint(d)])

    def test_checks_and_geometry(self):
        d = design_with(CUBOID)
        prim = resolve_parts(d, resolve_names(d, {}))[-1]["prims"][0]
        self.assertEqual(prim["vertices"][4], [1, 2, 5.524])
        self.assertEqual(prim_bbox(prim), ([1, 2, 3], [3, 4, 5.524]))
        self.assertEqual(len(polyhedron_triangles(prim["vertices"], prim["faces"])), 12)
        self.assertTrue(prim_contains(prim, [2, 3, 4]))
        self.assertTrue(prim_contains(prim, [1, 3, 4]))   # on a face
        self.assertFalse(prim_contains(prim, [0.5, 3, 4]))
        self.assertFalse(prim_contains(prim, [2, 3, 8]))
        # a flat one has no volume
        flat = design_with({**CUBOID, "vertices": [[x, y, 3] for x, y, _ in CUBOID["vertices"]]})
        self.assertIn("polyhedron-flat", [c["code"] for c in lint(flat)])
        self.assertEqual([c for c in lint(d) if c["code"].startswith("polyhedron")], [])

    def test_triangles_are_outward_after_a_mirror(self):
        d = design_with(CUBOID, [{"type": "mirror", "plane": "x", "keep": False}])
        prim = resolve_parts(d, resolve_names(d, {}))[-1]["prims"][0]
        self.assertEqual(prim["vertices"][0], [-1, 2, 3])
        v = prim["vertices"]
        vol = sum(sum(a * b for a, b in zip(v[i], _cross(v[j], v[k])))
                  for i, j, k in polyhedron_triangles(v, prim["faces"]))
        self.assertGreater(vol, 0)

    def test_build_transforms_and_python_export_agree(self):
        d = design_with(CUBOID, [{"type": "rotate", "axis": "z", "center": [0, 0, 0], "angle": 90},
                                 {"type": "move", "offset": [2, 3, 4]},
                                 {"type": "mirror", "plane": "y"},
                                 {"type": "translate", "copies": 1, "step": [0, 0, 10]}])
        with tempfile.TemporaryDirectory() as tmp:
            pp = Path(tmp) / "poly.py"
            pp.write_text(to_python(d))
            self.assertIn("add_polyhedron(", pp.read_text())
            for values in ({}, {"h": "3"}):
                with self.subTest(values=values):
                    a = build_preview(None, values, design=d)["bundle"]
                    b = build_preview(str(pp), values)["bundle"]
                    self.assertEqual(a["parts"], b["parts"])
                    shapes = a["parts"][-1]["primitives"]
                    self.assertEqual(len(shapes), 4)
                    self.assertTrue(all(s["kind"] == "polyhedron" and s["exact"] for s in shapes))
                    # 12 triangles per solid
                    self.assertEqual({len(s["faces"]) for s in shapes}, {12})


class HornExample(unittest.TestCase):
    def test_horn_converts_round_trips_and_builds(self):
        source = MODELS / "pyramidal_horn.py"
        design = convert_example(source, "horn_copy", "Horn copy")
        kinds = [p["kind"] for part in design["parts"] for p in part["primitives"]]
        self.assertEqual(kinds.count("polyhedron"), 4)
        self.assertEqual(design["far_field"]["faces"], [True, True, True, True, False, True])
        again = json.loads(json.dumps(design))
        self.assertEqual(again, design)
        check_design(again)
        self.assertEqual([c for c in lint(again) if c["severity"] == "error"], [])
        from fairbeam.design import build
        values = {p["key"]: p["default"] for p in again["params"]}
        sim = build(again, values)
        parts, _, _ = read_structure(sim.csx, sim.materials)
        built = [p for part in parts for p in part["primitives"] if p["kind"] == "polyhedron"]
        self.assertEqual(len(built), 4)
        self.assertTrue(all(len(p["faces"]) == 12 and len(p["vertices"]) == 8 for p in built))
        self.assertEqual(sim.nf2ff_faces, [True, True, True, True, False, True])
        # the Python export builds the same model
        with tempfile.TemporaryDirectory() as tmp:
            pp = Path(tmp) / "horn.py"
            pp.write_text(to_python(again))
            a = build_preview(None, {}, design=again)["bundle"]
            b = build_preview(str(pp), {})["bundle"]
            self.assertEqual(a["parts"], b["parts"])


if __name__ == "__main__":
    unittest.main()
