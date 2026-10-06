"""Geometry export conventions (docs/BUNDLE.md, "In-plane coordinate convention")."""

import unittest

import numpy as np
from CSXCAD import ContinuousStructure

from fairbeam.geometry import read_structure


def to_3d(normal, elevation, a, b):
    """3D point of in-plane point (a, b) as documented in BUNDLE.md."""
    p = [0.0, 0.0, 0.0]
    p[normal] = elevation
    p[(normal + 1) % 3] = a
    p[(normal + 2) % 3] = b
    return p


class PolygonConventionTest(unittest.TestCase):
    # an asymmetric (non-convex) outline so that swapped axes would change the bounding box
    PTS = [(0.0, 0.0), (4.0, 0.0), (4.0, 1.0), (1.0, 1.0), (1.0, 7.0), (0.0, 7.0)]

    def _export(self, normal, elevation, linpoly_length=None):
        csx = ContinuousStructure()
        metal = csx.AddMetal("m")
        coords = np.array(self.PTS).T  # shape (2, N): first row -> axis (n+1)%3
        if linpoly_length is None:
            metal.AddPolygon(coords, normal, elevation, priority=3)
        else:
            metal.AddLinPoly(coords, normal, elevation, linpoly_length, priority=3)
        parts, helpers, nf2ff = read_structure(csx, {})
        self.assertEqual(len(parts), 1)
        self.assertEqual(helpers, [])
        self.assertIsNone(nf2ff)
        return parts[0]["primitives"][0]

    def test_polygon_round_trip_all_normals(self):
        for normal in (0, 1, 2):
            with self.subTest(normal=normal):
                prim = self._export(normal, 2.5)
                self.assertEqual(prim["kind"], "polygon")
                self.assertEqual(prim["normal"], normal)
                self.assertEqual(prim["elevation"], 2.5)
                self.assertEqual(prim["priority"], 3)
                self.assertTrue(prim["exact"])
                self.assertEqual([tuple(p) for p in prim["points"]], self.PTS)
                # CSXCAD's own 3D bounding box must agree with the documented mapping
                xyz = np.array([to_3d(normal, 2.5, a, b) for a, b in prim["points"]])
                np.testing.assert_allclose(prim["bbox"][0], xyz.min(axis=0), atol=1e-6)
                np.testing.assert_allclose(prim["bbox"][1], xyz.max(axis=0), atol=1e-6)

    def test_linpoly_extrusion(self):
        for normal in (0, 1, 2):
            with self.subTest(normal=normal):
                prim = self._export(normal, 1.0, linpoly_length=0.5)
                self.assertEqual(prim["kind"], "linpoly")
                self.assertEqual(prim["length"], 0.5)
                self.assertAlmostEqual(prim["bbox"][0][normal], 1.0)
                self.assertAlmostEqual(prim["bbox"][1][normal], 1.5)


class BoxAndPartsTest(unittest.TestCase):
    def test_box_sheet_and_solid(self):
        csx = ContinuousStructure()
        patch = csx.AddMetal("patch")
        patch.AddBox(priority=10, start=[-16, -20, 1.524], stop=[16, 20, 1.524])
        sub = csx.AddMaterial("sub", epsilon=3.38, kappa=1e-3)
        sub.AddBox(priority=0, start=[-30, -30, 0], stop=[30, 30, 1.524])
        parts, _, _ = read_structure(csx, {"sub": {"tan_d": 1e-3, "tan_d_freq": 2e9, "label": "Substrate"}})
        by_name = {p["name"]: p for p in parts}
        sheet = by_name["patch"]["primitives"][0]
        self.assertEqual(sheet["kind"], "box")
        self.assertEqual(sheet["start"][2], sheet["stop"][2])  # zero thickness in z
        self.assertEqual(by_name["patch"]["bbox"], [[-16, -20, 1.524], [16, 20, 1.524]])
        mat = by_name["sub"]["material"]
        self.assertAlmostEqual(mat["eps_r"], 3.38)
        self.assertAlmostEqual(mat["kappa"], 1e-3)
        self.assertEqual(mat["tan_d"], 1e-3)
        self.assertTrue(mat["isotropic"])
        self.assertEqual(by_name["sub"]["label"], "Substrate")

    def test_part_bbox_is_union(self):
        csx = ContinuousStructure()
        m = csx.AddMetal("m")
        m.AddBox(start=[0, 0, 0], stop=[1, 1, 0])
        m.AddBox(start=[-2, 3, 0], stop=[-1, 4, 5])
        parts, _, _ = read_structure(csx, {})
        self.assertEqual(parts[0]["bbox"], [[-2, 0, 0], [1, 4, 5]])
        self.assertEqual(len(parts[0]["primitives"]), 2)

    def test_cylinder(self):
        csx = ContinuousStructure()
        csx.AddMetal("wire").AddCylinder(start=[0, 0, 0], stop=[0, 0, 10], radius=0.5)
        prim = read_structure(csx, {})[0][0]["primitives"][0]
        self.assertEqual(prim["kind"], "cylinder")
        self.assertEqual(prim["radius"], 0.5)
        self.assertEqual(prim["stop"], [0, 0, 10])

    def test_cylindrical_shell(self):
        # a tube: CSXCAD's radius is the middle of the wall (outer 1.5, inner 0.5 here)
        csx = ContinuousStructure()
        csx.AddMetal("tube").AddCylindricalShell([1, 2, 0], [1, 2, 4], 1.0, 1.0, priority=7)
        prim = read_structure(csx, {})[0][0]["primitives"][0]
        self.assertEqual(prim["kind"], "cylindricalshell")
        self.assertEqual((prim["radius"], prim["shell_width"], prim["priority"]), (1.0, 1.0, 7))
        self.assertEqual((prim["start"], prim["stop"]), ([1, 2, 0], [1, 2, 4]))
        self.assertTrue(prim["exact"])
        # CSXCAD's bounding box is the outer one
        self.assertEqual(prim["bbox"], [[-0.5, 0.5, 0], [2.5, 3.5, 4]])

    def test_sphere(self):
        csx = ContinuousStructure()
        csx.AddMetal("ball").AddSphere([1, -2, 3], 0.5, priority=4)
        prim = read_structure(csx, {})[0][0]["primitives"][0]
        self.assertEqual((prim["kind"], prim["center"], prim["radius"], prim["priority"]), ("sphere", [1, -2, 3], 0.5, 4))
        self.assertTrue(prim["exact"])
        self.assertEqual(prim["bbox"], [[0.5, -2.5, 2.5], [1.5, -1.5, 3.5]])

    def test_curve_and_wire(self):
        csx = ContinuousStructure()
        pts = [[0, 1, 2], [0, 0, 1], [0, 5, 10]]      # (3, N): x, y, z rows
        csx.AddMetal("c").AddCurve(pts)
        csx.AddMetal("w").AddWire(pts, radius=0.25)
        parts = {p["name"]: p["primitives"][0] for p in read_structure(csx, {})[0]}
        self.assertEqual(parts["c"]["kind"], "curve")
        self.assertEqual(parts["c"]["points"], [[0, 0, 0], [1, 0, 5], [2, 1, 10]])
        self.assertNotIn("radius", parts["c"])
        self.assertEqual(parts["w"]["kind"], "wire")
        self.assertEqual(parts["w"]["radius"], 0.25)
        self.assertTrue(parts["w"]["exact"])

    def test_polyhedron(self):
        csx = ContinuousStructure()
        ph = csx.AddMetal("t").AddPolyhedron()
        for v in ([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]):
            ph.AddVertex(*v)
        for f in ([0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]):
            ph.AddFace(f)
        prim = read_structure(csx, {})[0][0]["primitives"][0]
        self.assertEqual(prim["kind"], "polyhedron")
        self.assertEqual(len(prim["vertices"]), 4)
        self.assertEqual(prim["faces"][1], [0, 1, 3])

    def test_rotational_polygon(self):
        """A full-turn RotPoly (the designer's cone and torus), translated: the exact kind rotpoly with
        (radial, axial) points and the true bounding box (CSXCAD's own ignores the rotation)."""
        csx = ContinuousStructure()
        m = csx.AddMetal("cone")
        # a frustum about z: the polygon in the plane normal to x, coordinates (y, z) = (radial, axial)
        rp = m.AddRotPoly(np.array([[0, 3, 1, 0], [0, 0, 5, 5]], float), 0, 0.0, 2, [0, 2 * np.pi], priority=10)
        rp.AddTransform("Translate", [10, -4, 1])
        # about x: normal y, coordinates (z, x) = (radial, axial)
        csx.AddMetal("xcone").AddRotPoly(np.array([[0, 2, 0], [1, 1, 4]], float), 1, 0.0, 0, [0, 2 * np.pi])
        # the axis first in the plane (normal z, axis x, coordinates (x, y) = (axial, radial))
        csx.AddMetal("swapped").AddRotPoly(np.array([[1, 1, 4], [0, 2, 0]], float), 2, 0.0, 0, [0, 2 * np.pi])
        parts = {p["name"]: p["primitives"][0] for p in read_structure(csx, {})[0]}
        c = parts["cone"]
        self.assertEqual((c["kind"], c["axis"], c["origin"], c["priority"], c["exact"]), ("rotpoly", 2, [10, -4, 1], 10, True))
        self.assertEqual(c["points"], [[0, 0], [3, 0], [1, 5], [0, 5]])
        self.assertEqual(c["bbox"], [[7, -7, 1], [13, -1, 6]])
        for name in ("xcone", "swapped"):
            with self.subTest(name=name):
                q = parts[name]
                self.assertEqual((q["kind"], q["axis"], q["origin"]), ("rotpoly", 0, [0, 0, 0]))
                self.assertEqual(q["points"], [[0, 1], [2, 1], [0, 4]])
                self.assertEqual(q["bbox"], [[1, -2, -2], [4, 2, 2]])

    def test_rotational_polygon_fallbacks(self):
        """What the viewer could not rebuild exactly stays a bounding box: a partial turn, a rotated
        one, a polygon crossing the axis, one off the axis plane."""
        csx = ContinuousStructure()
        pts = np.array([[0, 3, 0], [0, 0, 5]], float)
        csx.AddMetal("half").AddRotPoly(pts, 0, 0.0, 2, [0, np.pi])
        csx.AddMetal("rotated").AddRotPoly(pts, 0, 0.0, 2, [0, 2 * np.pi]).AddTransform("RotateAxis", "x", 30)
        csx.AddMetal("crossing").AddRotPoly(np.array([[-1, 3, 0], [0, 0, 5]], float), 0, 0.0, 2, [0, 2 * np.pi])
        csx.AddMetal("offplane").AddRotPoly(pts, 0, 2.0, 2, [0, 2 * np.pi])
        for p in read_structure(csx, {})[0]:
            with self.subTest(name=p["name"]):
                q = p["primitives"][0]
                if p["name"] == "rotated":
                    self.assertEqual((q["kind"], q["primitive"]["kind"], q["exact"]), ("transformed", "rotpoly", True))
                else:
                    self.assertEqual((q["kind"], q["source_kind"], q["exact"]), ("bbox", "RotPoly", False))

    def test_transformed_box_keeps_exact_shape_and_world_bounds(self):
        csx = ContinuousStructure()
        box = csx.AddMetal("r").AddBox(start=[0, 0, 0], stop=[1, 2, 0])
        box.AddTransform("RotateAxis", "z", 45)
        prim = read_structure(csx, {})[0][0]["primitives"][0]
        self.assertEqual((prim["kind"], prim["primitive"]["kind"], prim["exact"]), ("transformed", "box", True))
        self.assertEqual(prim["primitive"]["start"], [0, 0, 0])
        self.assertEqual(prim["primitive"]["stop"], [1, 2, 0])
        np.testing.assert_allclose(prim["bbox"][0], [-np.sqrt(2), 0, 0], atol=1e-6)
        np.testing.assert_allclose(prim["bbox"][1], [np.sqrt(0.5), 3 / np.sqrt(2), 0], atol=1e-6)
        self.assertAlmostEqual(prim["matrix"][0][0], np.sqrt(0.5), places=6)
        self.assertAlmostEqual(prim["matrix"][1][0], np.sqrt(0.5), places=6)

    def test_transformed_curve_and_nonuniform_sphere_bounds(self):
        csx = ContinuousStructure()
        csx.AddMetal("curve").AddCurve(np.array([[0, 2], [0, 0], [0, 1]], float)) \
            .AddTransform("RotateAxis", "z", 45)
        sphere = csx.AddMetal("sphere").AddSphere([0, 0, 0], 1)
        sphere.AddTransform("Matrix", np.diag([2.0, 1.0, 1.0, 1.0]))
        parts = {p["name"]: p["primitives"][0] for p in read_structure(csx, {})[0]}
        curve = parts["curve"]
        self.assertEqual((curve["kind"], curve["primitive"]["kind"]), ("transformed", "curve"))
        self.assertEqual(curve["bbox"], [[0, 0, 0], [1.414214, 1.414214, 1]])
        scaled = parts["sphere"]
        self.assertEqual((scaled["kind"], scaled["primitive"]["kind"]), ("transformed", "sphere"))
        self.assertEqual(scaled["bbox"], [[-2, -1, -1], [2, 1, 1]])

    def test_rotpoly_matrix_keeps_translation_once(self):
        csx = ContinuousStructure()
        prim = csx.AddMetal("rot").AddRotPoly(np.array([[0, 2, 0], [0, 0, 3]], float), 0, 0.0, 2,
                                                [0, 2 * np.pi])
        prim.AddTransform("Translate", [4, 5, 6])
        prim.AddTransform("RotateAxis", "z", 90)
        out = read_structure(csx, {})[0][0]["primitives"][0]
        self.assertEqual((out["kind"], out["primitive"]["kind"]), ("transformed", "rotpoly"))
        self.assertEqual(out["primitive"]["origin"], [0, 0, 0])
        # Rotation is applied after the profile translation: its center moves to (-5, 4, 6).
        np.testing.assert_allclose(out["matrix"][:3], [[0, -1, 0, -5], [1, 0, 0, 4], [0, 0, 1, 6]], atol=1e-6)
        np.testing.assert_allclose(out["bbox"], [[-7, 2, 6], [-3, 6, 9]], atol=1e-6)

    def test_dump_boxes_are_helpers_and_define_nf2ff_box(self):
        csx = ContinuousStructure()
        csx.AddMetal("m").AddBox(start=[0, 0, 0], stop=[1, 1, 0])
        d = csx.AddDump("nf2ff_E_xn")
        d.AddBox(start=[-5, -6, -7], stop=[-5, 6, 7])
        d2 = csx.AddDump("nf2ff_E_xp")
        d2.AddBox(start=[5, -6, -7], stop=[5, 6, 7])
        parts, helpers, nf2ff = read_structure(csx, {})
        self.assertEqual([p["name"] for p in parts], ["m"])
        self.assertEqual({h["type"] for h in helpers}, {"DumpBox"})
        self.assertEqual(nf2ff, {"min": [-5, -6, -7], "max": [5, 6, 7]})


if __name__ == "__main__":
    unittest.main()
