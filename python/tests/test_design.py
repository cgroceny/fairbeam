"""Design files (fairbeam.design): expressions, checks, build, the Python export and the server API."""

import copy
import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fairbeam.design import (DESIGN_SUFFIX, DesignError, blank_design, check_design, evaluate, module_for,  # noqa: E402
                             names_in, to_python)
from fairbeam.jobs import JobManager  # noqa: E402
from fairbeam.model import load_model  # noqa: E402
from fairbeam.preview import build_preview, describe_models  # noqa: E402
from fairbeam.server import App, make_server  # noqa: E402

TEMPLATES = Path(__file__).resolve().parents[1] / "templates"


class Expressions(unittest.TestCase):
    def test_fractional_rotation_copy_360_keeps_its_full_angle(self):
        import numpy as np

        from fairbeam.design import _pt, transform_maps

        tr = {"type": "rotate", "axis": "z", "center": [1, 2, 3], "angle": 0.5, "copies": 360}
        maps = transform_maps([tr], {}, "parts[0]")
        self.assertEqual(len(maps), 361)
        np.testing.assert_allclose(_pt(*maps[360], [3, 5, 7]), [-1, -1, 7], atol=1e-12)

    def test_scale_and_offset_mirror_match_export_maps(self):
        from fairbeam.design import IDENTITY, _pt, map_primitive, transform_maps

        d = blank_design("scale", "Scale")
        tr = [
            {"type": "scale", "factors": [2, 2, 2], "origin": [1, 0, 0], "copies": 2},
            {"type": "mirror", "plane": "x", "point": [10, 0, 0], "keep": False},
        ]
        d["parts"][2]["transforms"] = tr
        maps = transform_maps(tr, {}, "parts[2]")
        self.assertEqual(len(maps), 3)
        self.assertEqual([_pt(*m, [2, 0, 0])[0] for m in maps], [18, 17, 15])

        primitive = {"kind": "sphere", "center": [2, 0, 0], "radius": 1}
        scaled = map_primitive(primitive, *transform_maps([tr[0]], {}, "parts[2]")[1])
        self.assertEqual(scaled["center"], [3, 0, 0])
        self.assertEqual(scaled["radius"], 2)

        exported = {}
        exec(to_python(d), exported)
        exp_maps = exported["_scaling"]([IDENTITY], [2, 2, 2], [1, 0, 0], 2)
        exp_maps = [exported["_flip"](s, t, 0, 10) for s, t in exp_maps]
        self.assertEqual(exp_maps, maps)

    def test_scaled_curved_primitives_match_generated_python(self):
        d = blank_design("scaled_curves", "Scaled curves")
        d["parts"].append({"name": "curves", "material": "copper", "primitives": [
            {"kind": "cylinder", "axis": "z", "center": [2, 0], "range": [0, 3], "radius": 1},
            {"kind": "sphere", "center": [2, 0, 1], "radius": 1},
            {"kind": "cone", "axis": "z", "center": [2, 0], "range": [0, 3], "bottom_radius": 1, "top_radius": 0.5},
            {"kind": "torus", "axis": "z", "center": [2, 0, 1], "major_radius": 2, "minor_radius": 0.5},
            {"kind": "linpoly", "normal": "z", "elevation": 1, "length": 2,
             "points": [[0, 0], [1, 0], [0, 1]]},
        ], "transforms": [{"type": "scale", "factors": [2, 2, 2], "origin": [1, 0, 0]}]})
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "scaled_curves.py"
            path.write_text(to_python(d))
            direct = build_preview(None, {}, design=d)["bundle"]["parts"][-1]
            generated = build_preview(str(path), {})["bundle"]["parts"][-1]
        self.assertEqual(direct["primitives"], generated["primitives"])

    def test_scale_rejects_nonuniform_and_nonpositive_factors(self):
        from fairbeam.design import transform_maps

        for factors, message in (([2, 1, 2], "nonuniform scaling"), ([1, 0, 1], "must be positive")):
            with self.subTest(factors=factors), self.assertRaises(DesignError) as cm:
                transform_maps([{"type": "scale", "factors": factors, "origin": [0, 0, 0]}], {}, "parts[0]")
            self.assertEqual(cm.exception.where, "parts[0].transforms[0].factors")
            self.assertIn(message, cm.exception.detail)

    def test_numbers_and_arithmetic(self):
        self.assertEqual(evaluate(3, {}), 3.0)
        self.assertEqual(evaluate("W/2 + 1", {"W": 10}), 6.0)
        self.assertEqual(evaluate("-(a - b) ** 2", {"a": 1, "b": 3}), -4.0)
        self.assertAlmostEqual(evaluate("wavelength(f0) / 4", {"f0": 2.45}), 299.792458 / 2.45 / 4)
        self.assertAlmostEqual(evaluate("sqrt(2) * pi", {}), 2 ** 0.5 * 3.141592653589793)
        self.assertEqual(names_in("W/2 + sqrt(h) + pi"), {"W", "h"})

    def test_shared_number_rule(self):
        # every literal, name and step is a finite double, as in src/designer/expr.ts (#102)
        self.assertEqual(evaluate("9007199254740993 - 9007199254740992", {}), 0.0)
        self.assertEqual(evaluate("big - 9007199254740992", {"big": 9007199254740993}), 0.0)
        self.assertEqual(evaluate("round(1e300) + 1 - round(1e300)", {}), 0.0)
        self.assertEqual(evaluate("round(2.675, 2.0)", {}), 2.67)
        self.assertEqual(evaluate("1\n+ 2", {}), 3.0)
        for bad in ("1 / (1e308 * 10)", "atan(1e308 * 10)", "1 / 1e999", "round(1.5, 0.5)", "W # width", "07", "Ｗ"):
            with self.subTest(bad=bad), self.assertRaises(DesignError):
                evaluate(bad, {"W": 1, "w": 1})

    def test_rejected(self):
        for bad in ("__import__('os')", "a.b", "(1).real", "[1, 2]", "x if y else z", "lambda: 1", "sqrt",
                    "1/0", "unknown + 1", "", "sqrt(x=1)", True):
            with self.subTest(bad=bad), self.assertRaises(DesignError):
                evaluate(bad, {"x": 1, "y": 1, "z": 1, "a": 1})


class Checks(unittest.TestCase):
    def test_blank_is_valid(self):
        check_design(blank_design("t", "T"))

    def test_errors_point_at_the_field(self):
        cases = [
            (lambda d: d.update(schema="x"), "schema"),
            (lambda d: d["params"].append({"key": "W", "default": 1}), "params[6].key"),
            (lambda d: d["params"].append({"key": "sqrt", "default": 1}), "params[6].key"),
            (lambda d: d["params"].append({"key": "lambda", "default": 1}), "params[6].key"),
            (lambda d: d["params"].append({"key": "None", "default": 1}), "params[6].key"),
            (lambda d: d["params"].append({"key": "λ", "default": 1}), "params[6].key"),
            (lambda d: d["parts"][0].update(material="gold"), "parts[0].material"),
            (lambda d: d["parts"][1]["primitives"][0].update(kind="helix"), "parts[1].primitives[0].kind"),
            (lambda d: d["ports"].append(dict(d["ports"][0])), "ports[1].number"),
            (lambda d: d["simulation"].update(boundaries=["MUR"] * 5), "simulation.boundaries"),
        ]
        for edit, where in cases:
            d = blank_design("t", "T")
            edit(d)
            with self.subTest(where=where), self.assertRaises(DesignError) as cm:
                check_design(d)
            self.assertEqual(cm.exception.where, where)

    def test_object_and_soft_keyword_names_are_keys(self):
        d = blank_design("t", "T")
        d["params"] += [{"key": "__proto__", "default": 1}, {"key": "match", "expr": "__proto__ * 2"},
                        {"key": "constructor", "expr": "match + 1"}]
        check_design(d)
        from fairbeam.design import resolve_names
        names = resolve_names(d, {})
        self.assertEqual((names["__proto__"], names["match"], names["constructor"]), (1.0, 2.0, 3.0))


class Build(unittest.TestCase):
    def test_arbitrary_rotation_native_build_and_generated_python(self):
        import numpy as np

        from fairbeam.geometry import read_structure

        d = blank_design("free-rotation", "Free rotation")
        d["far_field"]["enabled"] = False
        d["parts"].append({"name": "rotated", "material": "substrate", "transforms": [
            {"type": "rotate", "axis": "y", "center": [1, 2, 3], "angle": 37}],
            "primitives": [
                {"kind": "box", "start": [-2, -1, 0], "stop": [2, 1, 0]},
                {"kind": "cylinder", "axis": "z", "center": [2, 0], "range": [0, 3], "radius": 0.5},
                {"kind": "sphere", "center": [2, 0, 1], "radius": 0.5},
                {"kind": "polygon", "normal": "z", "elevation": 1, "points": [[0, 0], [2, 0], [1, 1]]},
                {"kind": "linpoly", "normal": "z", "elevation": 1, "length": 2, "points": [[0, 0], [2, 0], [1, 1]]},
                {"kind": "wire", "points": [[0, 0, 0], [0, 0, 2]], "radius": 0.1},
                {"kind": "polyhedron", "vertices": [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
                 "faces": [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]]},
                {"kind": "cone", "axis": "z", "center": [3, 0], "range": [0, 2], "bottom_radius": 0.5, "top_radius": 0.2},
                {"kind": "torus", "axis": "z", "center": [3, 0, 1], "major_radius": 0.75, "minor_radius": 0.25},
            ]})
        module = module_for(d)
        values = {p.key: p.default for p in module.PARAMS}
        direct = module.build(values)
        source = to_python(d)
        generated_namespace = {}
        exec(source, generated_namespace)
        generated = generated_namespace["build"](values)
        direct_prims = next(p["primitives"] for p in read_structure(direct.csx, direct.materials, direct.unit)[0]
                            if p["name"] == "rotated")
        generated_prims = next(p["primitives"] for p in read_structure(generated.csx, generated.materials, generated.unit)[0]
                               if p["name"] == "rotated")
        self.assertEqual(len(direct_prims), 9)
        self.assertEqual([p["kind"] for p in direct_prims], ["transformed"] * 9)
        self.assertEqual([p["primitive"]["kind"] for p in direct_prims],
                         ["box", "cylinder", "sphere", "polygon", "linpoly", "cylinder", "polyhedron", "rotpoly", "rotpoly"])
        for a, b in zip(direct_prims, generated_prims):
            self.assertEqual(a["kind"], b["kind"])
            self.assertEqual(a["primitive"]["kind"], b["primitive"]["kind"])
            np.testing.assert_allclose(a["matrix"], b["matrix"], atol=1e-9)
            np.testing.assert_allclose(a["bbox"], b["bbox"], atol=1e-6)

    def test_native_build_and_python_export_refuse_unsupported_zero_thickness_sheet(self):
        from fairbeam.design import build

        d = blank_design("tilted-sheet", "Tilted sheet")
        d["far_field"]["enabled"] = False
        d["parts"][2]["transforms"] = [
            {"type": "rotate", "axis": "x", "center": [0, 0, 0], "angle": 45, "copies": 0}]
        values = {p.key: p.default for p in module_for(d).PARAMS}
        for action in (lambda: build(d, values), lambda: to_python(d)):
            with self.assertRaises(DesignError) as raised:
                action()
            self.assertEqual(raised.exception.where, "parts[2].transforms[0].angle")
            self.assertIn("tilted relative to the Yee grid", raised.exception.detail)

        # A 45° rotation in the XY sheet plane retains its original Z normal and is still exact.
        d["parts"][2]["transforms"][0].update(axis="z")
        self.assertIsNotNone(build(d, values))
        self.assertTrue(to_python(d))

    def test_generated_python_rechecks_parameterized_sheet_rotation(self):
        from fairbeam.design import build

        d = blank_design("parameterized-sheet", "Parameterized sheet")
        d["far_field"]["enabled"] = False
        d["params"].append({"key": "tilt", "default": 0})
        d["parts"][2]["transforms"] = [
            {"type": "rotate", "axis": "x", "center": [0, 0, 0], "angle": "tilt", "copies": 0}]
        source = to_python(d)  # the default angle is safe
        namespace = {}
        exec(source, namespace)
        values = {p.key: p.default for p in module_for(d).PARAMS}
        values["tilt"] = 45
        for action in (lambda: build(d, values), lambda: namespace["build"](values)):
            with self.assertRaises(DesignError) as raised:
                action()
            self.assertEqual(raised.exception.where, "parts[2].transforms[0].angle")
            self.assertIn("tilted relative to the Yee grid", raised.exception.detail)

    def test_arbitrary_rotation_of_finite_thickness_metal_remains_supported(self):
        from fairbeam.design import build

        d = blank_design("rotated-volume", "Rotated volume")
        d["far_field"]["enabled"] = False
        d["parts"][2]["primitives"][0] = {
            "kind": "box", "start": [-2, -2, 0], "stop": [2, 2, 0.2]}
        d["parts"][2]["transforms"] = [
            {"type": "rotate", "axis": "x", "center": [0, 0, 0], "angle": 45, "copies": 0}]
        values = {p.key: p.default for p in module_for(d).PARAMS}
        self.assertIsNotNone(build(d, values))
        self.assertTrue(to_python(d))

    def test_manual_mesh_expression_lines_export_and_metadata(self):
        d = blank_design("manual", "Manual")
        d["far_field"]["enabled"] = False
        d["mesh"] = {"mode": "manual", "lines": {"x": ["-G/2", "feed", "G/2"],
                    "y": ["-G/2", "0", "G/2"], "z": ["-1", "0", "h", "h + 1"]},
                     "automatic": {"mode": "design", "overrides": {"pad": 999}}}
        values = {p.key: p.default for p in module_for(d).PARAMS}
        sim = module_for(d).build(values)
        self.assertEqual(sim.mesh_report["settings"]["mode"], "manual")
        self.assertEqual(sim.mesh_report["cells"], [2, 2, 3])
        source = to_python(d)
        self.assertIn("sim.mesh.AddLine('x', [-p['G'] / 2, p['feed'], p['G'] / 2])", source)
        self.assertNotIn("sim.auto_mesh(", source)
        ns = {}
        exec(source, ns)
        exported = ns["build"](values)
        self.assertEqual([list(exported.mesh.GetLines(a)) for a in range(3)],
                         [list(sim.mesh.GetLines(a)) for a in range(3)])

    def test_manual_mesh_rejects_bad_lines_and_unaligned_ports(self):
        d = blank_design("manual-invalid", "Manual invalid")
        d["far_field"]["enabled"] = False
        d["mesh"] = {"mode": "manual", "lines": {"x": [-100, 100], "y": [-100, 100], "z": [-100, 100]}}
        values = {p.key: p.default for p in module_for(d).PARAMS}
        for bad in ([0], [0, 1, 1], [1, 0], [0, float("inf")]):
            dd = copy.deepcopy(d)
            dd["mesh"]["lines"]["x"] = bad
            with self.subTest(lines=bad), self.assertRaises(DesignError):
                module_for(dd).build(values)
        d["mesh"]["lines"]["z"] = [-100, -1, 100]
        with self.assertRaises(DesignError) as cm:
            module_for(d).build(values)
        self.assertIn("ports[0]", cm.exception.where)

    def test_design_mesh_mode_and_overrides(self):
        from fairbeam.simulation import Simulation
        d = blank_design("adaptive", "Adaptive")
        d["far_field"]["enabled"] = False
        d["mesh"] = {"mode": "design", "overrides": {"cells_per_wavelength": 27, "edge_rule": "thirds"}}
        # Stale legacy keys may be present in imported JSON; design mode reads only overrides.
        d["mesh"].update(pad=999, air_cells_per_wavelength=200, max_ratio=3)
        with mock.patch.object(Simulation, "auto_mesh", autospec=True) as auto_mesh:
            module = module_for(d)
            module.build({p.key: p.default for p in module.PARAMS})
            kw = auto_mesh.call_args.kwargs
            self.assertEqual(kw["cells_per_wavelength"], 27)
            self.assertEqual(kw["edge_rule"], "thirds")
            self.assertEqual(kw["dielectric_cells"], 5)
            self.assertLess(kw["pad"], 999)
            self.assertLess(kw["air_cells_per_wavelength"], 200)
            self.assertEqual(kw["max_ratio"], 1.4)
        d["mesh"]["overrides"] = {"bogus": 1}
        with mock.patch.object(Simulation, "auto_mesh", autospec=True), self.assertRaises(DesignError) as cm:
            module_for(d).build({p.key: p.default for p in module_for(d).PARAMS})
        self.assertEqual(cm.exception.where, "mesh.overrides.bogus")

    def test_design_mesh_auto_air_follows_fixed_feature_density_and_export(self):
        d = blank_design("adaptive-export", "Adaptive export")
        d["far_field"]["enabled"] = False
        d["mesh"] = {"mode": "design", "overrides": {"cells_per_wavelength": 10}}
        module = module_for(d)
        values = {p.key: p.default for p in module.PARAMS}
        original = module.build(values).mesh_report
        exported = {}
        exec(to_python(d), exported)
        generated = exported["build"](values).mesh_report
        self.assertEqual(original["settings"]["air_cells_per_wavelength"], 8)
        for key in ("cells_per_wavelength", "air_cells_per_wavelength", "edge_rule", "pad"):
            self.assertEqual(original["settings"][key], generated["settings"][key])

    def test_design_mesh_copies_export_parity_and_ignored_legacy_density(self):
        d = blank_design("adaptive-copies", "Adaptive copies")
        d["far_field"]["enabled"] = False
        d["mesh"] = {"mode": "design", "overrides": {"dielectric_cells": "2 + 3"}}
        d["parts"][0]["transforms"] = [{"type": "translate", "copies": 2, "step": [80, 0, 0]}]
        values = {p.key: p.default for p in module_for(d).PARAMS}
        original = module_for(d).build(values)
        namespace = {}
        exec(to_python(d), namespace)
        exported = namespace["build"](values)
        self.assertEqual(original.mesh_report["settings"], exported.mesh_report["settings"])
        d["mesh"]["cells_per_wavelength"] = 0  # ignored in adaptive mode, including sheet conversion
        stale = module_for(d).build(values)
        self.assertEqual(original.mesh_report["settings"], stale.mesh_report["settings"])
        self.assertEqual(original.mesh_report["cells"], stale.mesh_report["cells"])

    def test_mesh_options_forward_and_export_with_defaults_unchanged(self):
        from fairbeam.simulation import Simulation

        d = blank_design("mesh-options", "Mesh options")
        d["far_field"]["enabled"] = False
        baseline = to_python(d)
        self.assertIn("sim.auto_mesh(cells_per_wavelength=20)", baseline)
        d["mesh"].update(edge_rule="edge", max_ratio="1 + 0.5", air_cells_per_wavelength="10", pad="sqrt(4)")
        source = to_python(d)
        self.assertIn("edge_rule='edge', max_ratio=1 + 0.5, air_cells_per_wavelength=10, pad=np.sqrt(4)", source)
        with mock.patch.object(Simulation, "auto_mesh", autospec=True) as auto_mesh:
            module_for(d).build({p.key: p.default for p in module_for(d).PARAMS})
            self.assertEqual(auto_mesh.call_args.kwargs,
                             {"cells_per_wavelength": 20.0, "edge_rule": "edge", "max_ratio": 1.5,
                              "air_cells_per_wavelength": 10.0, "pad": 2.0})
            exported = {}
            exec(source, exported)
            exported["build"]({p.key: p.default for p in exported["PARAMS"]})
            self.assertEqual(auto_mesh.call_args.kwargs,
                             {"cells_per_wavelength": 20.0, "edge_rule": "edge", "max_ratio": 1.5,
                              "air_cells_per_wavelength": 10.0, "pad": 2.0})

    def test_mesh_option_validation_paths(self):
        from fairbeam.simulation import Simulation

        cases = [("edge_rule", "bad", "mesh.edge_rule"), ("max_ratio", "1", "mesh.max_ratio"),
                 ("max_ratio", "1 / 0", "mesh.max_ratio"), ("pad", "-1", "mesh.pad"),
                 ("air_cells_per_wavelength", "0", "mesh.air_cells_per_wavelength"),
                 ("air_cells_per_wavelength", "21", "mesh.air_cells_per_wavelength")]
        for key, value, where in cases:
            d = blank_design("mesh-options", "Mesh options")
            d["far_field"]["enabled"] = False
            d["mesh"][key] = value
            with self.subTest(key=key, value=value), mock.patch.object(Simulation, "auto_mesh", autospec=True), \
                    self.assertRaises(DesignError) as cm:
                module = module_for(d)
                module.build({p.key: p.default for p in module.PARAMS})
            self.assertEqual(cm.exception.where, where)

    def test_quarter_turns_build_exactly_and_match_python_export(self):
        from fairbeam.design import resolve_names, resolve_parts
        d = blank_design("rotate", "Rotate")
        d["params"].append({"key": "turn", "default": 90})
        d["parts"].append({"name": "rotating", "material": "copper", "primitives": [
            {"kind": "box", "start": [1, 2, 3], "stop": [2, 4, 5]},
            {"kind": "cylinder", "axis": "z", "center": [1, 2], "range": [3, 5], "radius": 0.4},
            {"kind": "sphere", "center": [1, 2, 3], "radius": 0.4},
            {"kind": "polygon", "normal": "z", "elevation": 3, "points": [[1, 2], [2, 2], [1, 4]]},
            {"kind": "linpoly", "normal": "y", "elevation": 3, "length": 1, "points": [[1, 2], [2, 2], [1, 4]]},
            {"kind": "cone", "axis": "z", "center": [1, 2], "range": [3, 5], "bottom_radius": 1, "top_radius": 0},
            {"kind": "torus", "axis": "x", "center": [1, 2, 3], "major_radius": 1, "minor_radius": 0.2},
            {"kind": "wire", "points": [[1, 2, 3], [2, 4, 5]], "radius": 0.2},
        ]})
        # Independent expected points also establish right-handed direction and the pivot.
        expected = {"x": [1, 0, 3], "y": [2, 2, 2], "z": [0, 1, 3]}
        with tempfile.TemporaryDirectory() as tmp:
            pp = Path(tmp) / "rotate.py"
            for axis in "xyz":
                d["parts"][-1]["transforms"] = [{"type": "rotate", "axis": axis, "center": [1, 1, 2], "angle": "turn"}]
                resolved = resolve_parts(d, resolve_names(d, {}))[-1]
                self.assertEqual(resolved["copies"], 1)
                self.assertEqual(resolved["prims"][0]["start"], expected[axis])
                for angle, copies in ((90, 0), (-90, 0), (180, 2), (270, 0), (360, 0)):
                    with self.subTest(axis=axis, angle=angle, copies=copies):
                        d["parts"][-1]["transforms"][0]["copies"] = copies
                        pp.write_text(to_python(d))
                        a = build_preview(None, {"turn": str(angle)}, design=d)["bundle"]
                        b = build_preview(str(pp), {"turn": str(angle)})["bundle"]
                        self.assertEqual(a["parts"], b["parts"])
                        shapes = a["parts"][-1]["primitives"]
                        self.assertEqual(len(shapes), 8 * (copies + 1))
                        self.assertFalse(any(p.get("transformed") for p in shapes))
                d["parts"][-1]["transforms"] += [
                    {"type": "move", "offset": [2, 3, 4]},
                    {"type": "mirror", "plane": "x"},
                    {"type": "translate", "copies": 1, "step": [0, 10, 0]},
                    {"type": "rotate", "axis": "y", "center": [0, 1, 0], "angle": -90}]
                pp.write_text(to_python(d))
                self.assertEqual(build_preview(None, {}, design=d)["bundle"]["parts"],
                                 build_preview(str(pp), {})["bundle"]["parts"])

    def test_export_builds_arbitrary_rotation_at_runtime(self):
        import numpy as np

        d = blank_design("rotate", "Rotate")
        d["params"].append({"key": "turn", "default": 90})
        d["parts"][2]["transforms"] = [{"type": "rotate", "axis": "z", "center": [0, 0, 0], "angle": "turn"}]
        with tempfile.TemporaryDirectory() as tmp:
            pp = Path(tmp) / "rotate.py"
            pp.write_text(to_python(d))
            model = load_model(pp)
            sim = model.build({p.key: (45 if p.key == "turn" else p.default) for p in model.PARAMS})
        transformed = [p for p in sim.csx.GetAllPrimitives() if p.GetProperty().GetName() == "patch"]
        self.assertTrue(transformed)
        self.assertTrue(all(p.HasTransform() for p in transformed))
        self.assertTrue(all(np.asarray(p.GetTransform().GetMatrix()).shape == (4, 4) for p in transformed))

    def test_huge_rotation_angle_stays_finite_for_circular_copies(self):
        from fairbeam.design import IDENTITY, _pt, to_python, transform_maps
        d = blank_design("rotate", "Rotate")
        tr = {"type": "rotate", "axis": "z", "center": [1, 2, 3], "angle": 1e308, "copies": 1000}
        d["parts"][2]["transforms"] = [tr]
        maps = transform_maps([tr], {}, "parts[2]")
        self.assertEqual(len(maps), 1001)
        self.assertTrue(all(_pt(s, t, [4, 5, 6]) == [4, 5, 6] for s, t in maps))
        exported = {}
        exec(to_python(d), exported)
        self.assertEqual(exported["_rotation"]([IDENTITY], 2, tr["center"], tr["angle"], 1000), maps)

    def test_move_preserves_count_and_matches_export_for_every_kind(self):
        from fairbeam.design import resolve_parts, resolve_names
        d = blank_design("move", "Move")
        primitives = [
            {"kind": "box", "start": [1, 2, 3], "stop": [2, 4, 5]},
            {"kind": "cylinder", "axis": "z", "center": [1, 2], "range": [3, 5], "radius": 0.4},
            {"kind": "sphere", "center": [1, 2, 3], "radius": 0.4},
            {"kind": "polygon", "normal": "z", "elevation": 3, "points": [[1, 2], [2, 2], [1, 4]]},
            {"kind": "linpoly", "normal": "y", "elevation": 3, "length": 1, "points": [[1, 2], [2, 2], [1, 4]]},
            {"kind": "cone", "axis": "z", "center": [1, 2], "range": [3, 5], "bottom_radius": 1, "top_radius": 0},
            {"kind": "torus", "axis": "x", "center": [1, 2, 3], "major_radius": 1, "minor_radius": 0.2},
            {"kind": "wire", "points": [[1, 2, 3], [2, 4, 5]], "radius": 0.2},
        ]
        d["parts"].append({"name": "moving", "material": "copper", "primitives": primitives,
                           "transforms": [{"type": "translate", "copies": 1, "step": [10, 0, 0]},
                                          {"type": "move", "offset": ["W/4", -3, "h"]},
                                          {"type": "mirror", "plane": "x", "keep": False}]})
        check_design(d)
        resolved = resolve_parts(d, resolve_names(d, {}))[-1]
        self.assertEqual(resolved["copies"], 2)
        self.assertEqual(len(resolved["prims"]), len(primitives) * 2)
        self.assertEqual(resolved["prims"][0]["start"], [-9, -1, 4.524])
        self.assertEqual(resolved["prims"][8]["start"], [-19, -1, 4.524])
        with tempfile.TemporaryDirectory() as tmp:
            pp = Path(tmp) / "move.py"
            pp.write_text(to_python(d))
            for values in ({}, {"W": "24", "h": "2"}):
                with self.subTest(values=values):
                    a = build_preview(None, values, design=d)["bundle"]
                    b = build_preview(str(pp), values)["bundle"]
                    self.assertEqual(a["parts"], b["parts"])

    def test_move_checks_use_the_moved_geometry(self):
        from fairbeam.design_checks import lint
        d = blank_design("move", "Move")
        d["parts"][2]["transforms"] = [{"type": "move", "offset": ["W", 0, 0]}]
        self.assertIn("port-floating", [c["code"] for c in lint(d)])
        d["parts"][2]["transforms"][0]["offset"] = [0, 0, 0]
        self.assertEqual(lint(d), [])

    def test_blank_builds_and_matches_its_python_export(self):
        d = blank_design("my-patch", "My patch")
        with tempfile.TemporaryDirectory() as tmp:
            dp = Path(tmp) / f"my_patch{DESIGN_SUFFIX}"
            dp.write_text(json.dumps(d))
            pp = Path(tmp) / "my_patch_py.py"
            pp.write_text(to_python(d))
            a = build_preview(str(dp), {"W": "30", "h": "0.8"})["bundle"]
            b = build_preview(str(pp), {"W": "30", "h": "0.8"})["bundle"]
            self.assertEqual(json.dumps(a["parts"], sort_keys=True), json.dumps(b["parts"], sort_keys=True))
            self.assertEqual(a["ports"], b["ports"])
            self.assertEqual(a["mesh"]["x"], b["mesh"]["x"])
            self.assertEqual(a["mesh"]["z"], b["mesh"]["z"])
            names = [p["name"] for p in a["parts"]]
            self.assertEqual(names, ["substrate", "gnd", "patch"])
            patch = a["parts"][2]["primitives"][0]
            self.assertEqual(patch["start"], [-15.0, -20.0, 0.8])
            # the CLI, preview, jobs and the registry all load it through load_model
            m = load_model(dp)
            self.assertEqual([p.key for p in m.PARAMS], ["f0", "W", "L", "h", "G", "feed"])
            desc = describe_models(tmp)
            self.assertEqual([(e["key"], e["kind"]) for e in desc], [("my_patch", "design"), ("my_patch_py", "python")])

    def test_thin_copper_export_builds_the_same_sheets(self):
        # 35 µm copper and a probe drawn through it: the export must give the solver what the design
        # gives it (sheets, the probe between them), not the full-thickness copper
        d = blank_design("t", "T")
        d["parts"][1]["primitives"][0] = {"kind": "box", "start": ["-G/2", "-G/2", "-0.035"], "stop": ["G/2", "G/2", "0"]}
        d["parts"][2]["primitives"][0] = {"kind": "box", "start": ["-W/2", "-L/2", "h"], "stop": ["W/2", "L/2", "h + 0.035"]}
        d["ports"][0].update(start=["feed", "0", "-0.035"], stop=["feed", "0", "h + 0.035"])
        a = build_preview(None, {"h": "0.8"}, design=d)["bundle"]
        src = to_python(d)
        self.assertIn("thin metal, built as a sheet", src)
        self.assertIn("[p[feed], 0, 0], [p[feed], 0, p[h]]", src.replace("'", ""))   # the probe keeps its parameters
        with tempfile.TemporaryDirectory() as tmp:
            pp = Path(tmp) / "t.py"
            pp.write_text(src)
            b = build_preview(str(pp), {"h": "0.8"})["bundle"]
        for axis in "xyz":
            self.assertEqual(a["mesh"][axis], b["mesh"][axis])
        self.assertEqual(a["mesh"]["auto"]["timestep_s"], b["mesh"]["auto"]["timestep_s"])
        self.assertEqual(a["ports"], b["ports"])
        # the design's bundle shows the drawn thickness; flattened, it is the export's sheet
        for p in (q for part in a["parts"] for q in part["primitives"] if "sheet" in q):
            n, at = "xyz".index(p["sheet"]["axis"]), p.pop("sheet")["at"]
            p["start"][n] = p["stop"][n] = p["bbox"][0][n] = p["bbox"][1][n] = at
        strip = lambda parts: [{k: v for k, v in part.items() if k != "bbox"} for part in parts]  # noqa: E731
        self.assertEqual(json.dumps(strip(a["parts"]), sort_keys=True), json.dumps(strip(b["parts"]), sort_keys=True))

    def test_rotated_thin_copper_export_builds_the_same_sheets(self):
        # Exercise both drawn faces and the midpoint after each world-axis permutation.
        # Rotate the substrate with the copper so contact survives, including mirrored copies.
        with tempfile.TemporaryDirectory() as tmp:
            pp = Path(tmp) / "thin_rotate.py"
            for axis in "xyz":
                for side, z in (("start", ["h", "h + 0.035"]),
                                ("stop", ["-0.035", 0]),
                                ("middle", ["h + 1", "h + 1.035"])):
                    for angle, copies in ((90, 0), (-90, 0), (90, 3)):
                        with self.subTest(axis=axis, side=side, angle=angle, copies=copies):
                            d = blank_design("thin-rotate", "Thin rotated copper")
                            d["ports"] = []
                            d["parts"] = [d["parts"][0], d["parts"][2]]
                            d["parts"][1]["primitives"][0].update(
                                start=["-W/2", "-L/2", z[0]], stop=["W/2", "L/2", z[1]])
                            for part in d["parts"]:
                                part["transforms"] = [
                                    {"type": "mirror", "plane": "z", "keep": False},
                                    {"type": "rotate", "axis": axis, "center": [1, 2, 3],
                                     "angle": angle, "copies": copies},
                                    {"type": "move", "offset": [4, -5, 6]}]
                            src = to_python(d)
                            self.assertIn("thin metal, built as a sheet", src)
                            self.assertIn("p['h']", src)
                            pp.write_text(src)
                            a = build_preview(None, {}, design=d)["bundle"]
                            b = build_preview(str(pp), {})["bundle"]
                            drawn = a["parts"][1]["primitives"]
                            exported = b["parts"][1]["primitives"]
                            self.assertEqual(len(drawn), copies + 1)
                            self.assertEqual(len(drawn), len(exported))
                            for p, q in zip(drawn, exported):
                                n = "xyz".index(p["sheet"]["axis"])
                                at = p["sheet"]["at"]
                                for key in ("start", "stop"):
                                    expected = list(p[key])
                                    expected[n] = at
                                    for actual, value in zip(q[key], expected):
                                        self.assertAlmostEqual(actual, value)

    def test_every_primitive_kind(self):
        d = blank_design("t", "T")
        d["params"].append({"key": "r", "expr": "h / 2", "label": "derived"})
        d["parts"].append({"name": "post", "material": "copper", "primitives": [
            {"kind": "cylinder", "start": [10, 10, 0], "stop": [10, 10, "h"], "radius": "r"}]})
        d["parts"].append({"name": "tri", "material": "copper", "primitives": [
            {"kind": "polygon", "normal": "z", "elevation": "h", "points": [[20, 20], [25, 20], [20, 25]]}]})
        d["parts"].append({"name": "block", "material": "substrate", "primitives": [
            {"kind": "linpoly", "normal": "z", "elevation": 0, "length": "2*h",
             "points": [[-25, 20], [-20, 20], [-20, 25], [-25, 25]]}]})
        b = build_preview(None, {}, design=d)["bundle"]
        kinds = {p["name"]: p["primitives"][0]["kind"] for p in b["parts"]}
        self.assertEqual(kinds["post"], "cylinder")
        self.assertEqual(kinds["tri"], "polygon")
        self.assertEqual(kinds["block"], "linpoly")
        post = next(p for p in b["parts"] if p["name"] == "post")["primitives"][0]
        self.assertAlmostEqual(post["radius"], 1.524 / 2)
        # and the export still matches
        with tempfile.TemporaryDirectory() as tmp:
            pp = Path(tmp) / "t.py"
            pp.write_text(to_python(d))
            b2 = build_preview(str(pp), {})["bundle"]
        self.assertEqual(json.dumps(b["parts"], sort_keys=True), json.dumps(b2["parts"], sort_keys=True))

    def test_cst_shapes_and_transforms_match_the_python_export(self):
        """Every new form and transform: the design and its Python export build the same parts."""
        d = blank_design("t", "T")
        d["params"] += [{"key": "N", "default": 4, "label": "Elements"}, {"key": "pitch", "expr": "W / 4"}]
        d["parts"].append({"name": "tube", "material": "copper", "primitives": [
            {"kind": "cylinder", "axis": "z", "center": ["feed", 5], "radius": 1.2, "inner_radius": "0.4", "range": [0, "h"]}]})
        d["parts"].append({"name": "rod", "material": "copper", "primitives": [
            {"kind": "cylinder", "axis": "y", "center": ["h + 2", 3], "radius": 0.5, "range": [-5, 5]}]})
        d["parts"].append({"name": "ball", "material": "copper", "primitives": [{"kind": "sphere", "center": [10, 10, "h + 3"], "radius": 1.5}]})
        d["parts"].append({"name": "arr", "material": "copper", "transforms": [
            {"type": "translate", "copies": "N - 1", "step": ["pitch", 0, 0]}, {"type": "mirror", "plane": "y"}],
            "primitives": [
                {"kind": "box", "start": [0, 22, "h"], "stop": [2, 25, "h"]},
                {"kind": "polygon", "normal": "z", "elevation": "h", "points": [[0, 26], [2, 26], [1, 28]]},
                {"kind": "linpoly", "normal": "y", "elevation": 29, "length": 1, "points": [["h", 0], ["h + 1", 0], ["h + 1", 1]]},
                {"kind": "cylinder", "axis": "z", "center": [1, 31], "radius": 0.5, "inner_radius": 0.2, "range": ["h", "h + 2"]},
                {"kind": "cylinder", "start": [1, 32, "h"], "stop": [1, 32, "h + 1"], "radius": 0.2},
                {"kind": "sphere", "center": [1, 33, "h + 1"], "radius": 0.5}]})
        d["parts"].append({"name": "under", "material": "substrate",
                           "transforms": [{"type": "mirror", "plane": "z", "keep": False}],
                           "primitives": [{"kind": "linpoly", "normal": "z", "elevation": 1, "length": 2,
                                           "points": [[-25, 20], [-20, 20], [-20, 25]]}]})
        b = build_preview(None, {}, design=d)["bundle"]
        parts = {p["name"]: p for p in b["parts"]}
        tube = parts["tube"]["primitives"][0]
        self.assertEqual(tube["kind"], "cylindricalshell")
        self.assertAlmostEqual(tube["radius"], 0.8)          # the middle of the wall
        self.assertAlmostEqual(tube["shell_width"], 0.8)
        self.assertEqual(tube["start"], [-6.0, 5.0, 0.0])
        rod = parts["rod"]["primitives"][0]
        # axis y: center = [z, x] (CSXCAD's in-plane order)
        self.assertEqual((rod["kind"], rod["start"], rod["stop"]), ("cylinder", [3.0, -5.0, 3.524], [3.0, 5.0, 3.524]))
        self.assertEqual(parts["ball"]["primitives"][0]["kind"], "sphere")
        arr = parts["arr"]["primitives"]
        self.assertEqual(len(arr), 6 * 4 * 2)                # 6 shapes, 4 along x, mirrored across y = 0
        boxes = [p for p in arr if p["kind"] == "box"]
        self.assertEqual(sorted({p["bbox"][0][0] for p in boxes}), [0.0, 8.0, 16.0, 24.0])
        self.assertEqual(sorted({p["bbox"][0][1] for p in boxes}), [-25.0, 22.0])
        under = parts["under"]["primitives"][0]
        self.assertEqual((under["elevation"], under["length"]), (-3.0, 2.0))   # z in [-3, -1]
        with tempfile.TemporaryDirectory() as tmp:
            pp = Path(tmp) / "t.py"
            src = to_python(d)
            pp.write_text(src)
            for values in ({}, {"N": "2", "W": "28"}):
                with self.subTest(values=values):
                    a = build_preview(None, values, design=d)["bundle"]
                    b2 = build_preview(str(pp), values)["bundle"]
                    self.assertEqual(json.dumps(a["parts"], sort_keys=True), json.dumps(b2["parts"], sort_keys=True))
        self.assertIn("def _pt(s, t, p):", src)
        self.assertIn("add_primitive(", src)   # cylinders and tubes are resolved and added with the build's own functions (flat ones become polygons)

    def test_cone_and_torus(self):
        """Cones and tori are CSXCAD rotational polygons, exported exactly (rotpoly), transformed like
        every shape, and the Python export builds the same."""
        d = blank_design("t", "T")
        d["params"].append({"key": "R", "default": 6, "label": "Torus radius"})
        d["parts"].append({"name": "horn", "material": "copper", "primitives": [
            {"kind": "cone", "axis": "z", "center": ["feed", 2], "bottom_radius": 3, "top_radius": 0, "range": ["h", "h + 6"]},
            {"kind": "cone", "axis": "y", "center": [4, 5], "bottom_radius": 0.5, "top_radius": 2, "range": [-3, 1]}]})
        d["parts"].append({"name": "ring", "material": "copper", "primitives": [
            {"kind": "torus", "axis": "x", "center": [0, 0, 20], "major_radius": "R", "minor_radius": 1}]})
        d["parts"].append({"name": "pair", "material": "copper",
                           "transforms": [{"type": "mirror", "plane": "z"}, {"type": "translate", "copies": 1, "step": [0, 30, 0]}],
                           "primitives": [{"kind": "cone", "axis": "z", "center": [20, 0], "bottom_radius": 2, "top_radius": 1, "range": [2, 5]},
                                          {"kind": "torus", "axis": "z", "center": [-20, 0, 3], "major_radius": 3, "minor_radius": 0.5}]})
        check_design(d)
        b = build_preview(None, {}, design=d)["bundle"]
        parts = {p["name"]: p for p in b["parts"]}
        cone, ycone = parts["horn"]["primitives"]
        self.assertEqual((cone["kind"], cone["axis"], cone["origin"]), ("rotpoly", 2, [-6.0, 2.0, 0.0]))
        self.assertEqual(cone["points"], [[0.0, 1.524], [3.0, 1.524], [0.0, 7.524]])
        self.assertEqual(cone["bbox"], [[-9.0, -1.0, 1.524], [-3.0, 5.0, 7.524]])
        # axis y: center = [z, x]
        self.assertEqual((ycone["axis"], ycone["origin"], ycone["points"]), (1, [5.0, 0.0, 4.0], [[0.0, -3.0], [0.5, -3.0], [2.0, 1.0], [0.0, 1.0]]))
        ring = parts["ring"]["primitives"][0]
        self.assertEqual((ring["axis"], ring["origin"], len(ring["points"])), (0, [0.0, 0.0, 20.0], 64))
        self.assertEqual(ring["bbox"], [[-1.0, -7.0, 13.0], [1.0, 7.0, 27.0]])
        pair = parts["pair"]["primitives"]
        self.assertEqual(len(pair), 8)
        mirrored = [q for q in pair if q["axis"] == 2 and len(q["points"]) == 4 and q["points"][0][1] < 0]
        self.assertEqual(len(mirrored), 2)                       # both translated copies of the flipped cone
        self.assertEqual(mirrored[0]["points"], [[0.0, -2.0], [2.0, -2.0], [1.0, -5.0], [0.0, -5.0]])
        with tempfile.TemporaryDirectory() as tmp:
            pp = Path(tmp) / "t.py"
            src = to_python(d)
            pp.write_text(src)
            for values in ({}, {"R": "8"}):
                with self.subTest(values=values):
                    a = build_preview(None, values, design=d)["bundle"]
                    b2 = build_preview(str(pp), values)["bundle"]
                    self.assertEqual(json.dumps(a["parts"], sort_keys=True), json.dumps(b2["parts"], sort_keys=True))
        self.assertIn("def _rotpoly(", src)
        self.assertIn("def _torus(", src)

    def test_wire(self):
        """A thin wire (a monopole over the patch's ground, a bent one in an array): CSXCAD Wire with
        its radius, transformed exactly, and the Python export builds the same."""
        d = blank_design("t", "T")
        d["params"].append({"key": "r", "default": 0.4, "label": "Wire radius"})
        d["parts"].append({"name": "mono", "material": "copper", "primitives": [
            {"kind": "wire", "points": [["feed", 0, "h"], ["feed", 0, "h + 30"]], "radius": "r"}]})
        d["parts"].append({"name": "bent", "material": "copper",
                           "transforms": [{"type": "mirror", "plane": "x"}, {"type": "translate", "copies": 1, "step": [0, 0, 5]}],
                           "primitives": [{"kind": "wire", "points": [[10, 20, 2], [15, 20, 2], [15, 25, 8]], "radius": 0.3}]})
        check_design(d)
        b = build_preview(None, {}, design=d)["bundle"]
        parts = {p["name"]: p for p in b["parts"]}
        mono = parts["mono"]["primitives"][0]
        # a wire with a radius is built as a solid: a flat-ended cylinder per segment, a sphere at each bend
        self.assertEqual((mono["kind"], mono["radius"]), ("cylinder", 0.4))
        self.assertEqual(mono["bbox"], [[-6.4, -0.4, 1.524], [-5.6, 0.4, 31.524]])
        bent = parts["bent"]["primitives"]
        self.assertEqual(len(bent), 4)   # a slanted segment: stays a CSXCAD wire (four copies)
        self.assertIn([[-10.0, 20.0, 7.0], [-15.0, 20.0, 7.0], [-15.0, 25.0, 13.0]], [q["points"] for q in bent])
        # the automatic mesh resolves the monopole: lines through its axis and across its diameter
        xs = [x for x in b["mesh"]["x"] if -6.5 < x < -5.5]
        self.assertIn(-6.0, xs)
        with tempfile.TemporaryDirectory() as tmp:
            pp = Path(tmp) / "t.py"
            pp.write_text(to_python(d))
            for values in ({}, {"r": "0.6"}):
                with self.subTest(values=values):
                    a = build_preview(None, values, design=d)["bundle"]
                    b2 = build_preview(str(pp), values)["bundle"]
                    self.assertEqual(json.dumps(a["parts"], sort_keys=True), json.dumps(b2["parts"], sort_keys=True))

    def test_waveguide_port(self):
        """A rectangular waveguide port in a design: Simulation.waveguide_port, the same in the export."""
        d = blank_design("t", "T")
        d["params"].append({"key": "wa", "default": 120, "label": "Guide width"})
        d["ports"].append({"type": "waveguide", "number": 2, "mode": "TE10", "a": "wa", "b": "wa / 2",
                           "start": ["-wa/2", "-wa/4", 50], "stop": ["wa/2", "wa/4", 55], "direction": "z", "excite": False})
        check_design(d)
        b = build_preview(None, {}, design=d)["bundle"]
        wg = b["ports"][1]
        self.assertEqual((wg["type"], wg["mode"], wg["a"], wg["b"], wg["excite"]), ("waveguide", "TE10", 120.0, 60.0, False))
        self.assertAlmostEqual(wg["f_cutoff"], 299792458 / 2 / 0.120, delta=1)
        self.assertEqual((wg["start"], wg["stop"]), ([-60.0, -30.0, 50.0], [60.0, 30.0, 55.0]))
        with tempfile.TemporaryDirectory() as tmp:
            pp = Path(tmp) / "t.py"
            src = to_python(d)
            pp.write_text(src)
            self.assertIn("sim.waveguide_port(2, ", src)
            for values in ({}, {"wa": "130"}):
                with self.subTest(values=values):
                    a = build_preview(None, values, design=d)["bundle"]
                    b2 = build_preview(str(pp), values)["bundle"]
                    self.assertEqual(a["ports"], b2["ports"])
        bad = [({"mode": "TM11"}, "ports[1].mode"), ({"mode": "TE00"}, "ports[1].mode"), ({"b": 0}, "ports[1].b"),
               ({"excite": True, "stop": ["wa/2", "wa/4", 50]}, "ports[1].stop[2]")]
        for change, where in bad:
            dd = copy.deepcopy(d)
            dd["ports"][1].update(change)
            with self.subTest(where=where), self.assertRaises(DesignError) as cm:
                module_for(dd).build({p.key: p.default for p in module_for(dd).PARAMS})
            self.assertEqual(cm.exception.where, where)
        dd = copy.deepcopy(d)
        dd["ports"][1]["type"] = "floquet"
        with self.assertRaises(DesignError) as cm:
            check_design(dd)
        self.assertEqual(cm.exception.where, "ports[1].type")

    def test_cuts(self):
        """Cuts in metal sheets: the exact difference as disjoint rectangles (CSXCAD polygons have no
        holes), before the part's transforms; the Python export builds the same pieces."""
        from fairbeam.design import _sheet_minus

        area = lambda rects: sum((b[0] - a[0]) * (b[1] - a[1]) for a, b in rects)  # noqa: E731
        sheet = ([-10, -5, 1], [10, 5, 1])
        slot = _sheet_minus(*sheet, [([-1, -3, 1], [1, 3, 1])])
        self.assertEqual(len(slot), 4)                                   # a centre slot: 4 rectangles
        self.assertAlmostEqual(area(slot), 200 - 12)
        e_shape = _sheet_minus(*sheet, [([-6, -9, 1], [-2, 3, 1]), ([2, -9, 1], [6, 3, 1])])
        self.assertEqual((len(e_shape), area(e_shape)), (4, 200 - 2 * 4 * 8))
        u_slot = _sheet_minus(*sheet, [([-6, -3, 1], [-5, 3, 1]), ([5, -3, 1], [6, 3, 1]), ([-6, -3, 1], [6, -2, 1])])
        self.assertAlmostEqual(area(u_slot), 200 - 6 - 6 - 10)
        notch = _sheet_minus(*sheet, [([-12, -1, 1], [-7, 1, 1])])      # an inset notch from the edge
        self.assertAlmostEqual(area(notch), 200 - 3 * 2)
        for rects in (slot, e_shape, u_slot, notch):
            # disjoint: no two pieces overlap with positive area
            for i, (a, b) in enumerate(rects):
                for c, e in rects[i + 1:]:
                    self.assertLessEqual(min(b[0], e[0]) - max(a[0], c[0]) <= 1e-12 or min(b[1], e[1]) - max(a[1], c[1]) <= 1e-12, True)
        self.assertEqual(_sheet_minus(*sheet, [([20, 0, 1], [30, 2, 1])]), [([-10, -5, 1], [10, 5, 1])])   # misses
        self.assertEqual(_sheet_minus(*sheet, [([-20, -9, 1], [20, 9, 1])]), [])                           # removes all

        d = blank_design("t", "T")
        d["params"] += [{"key": "ws", "default": 2, "label": "Slot width"}, {"key": "ls", "default": 20, "label": "Slot length"}]
        d["parts"][2]["cuts"] = [{"start": ["-ws/2", "-ls/2", "h"], "stop": ["ws/2", "ls/2", "h"]},
                                 {"start": ["W/2 - 3", -1, "h"], "stop": ["W/2 + 1", 1, "h"]}]
        d["parts"].append({"name": "arr", "material": "copper", "transforms": [{"type": "translate", "copies": 1, "step": [0, 50, 0]}],
                           "cuts": [{"start": [0, 60, "h"], "stop": [2, 62, "h"]}],
                           "primitives": [{"kind": "box", "start": [-4, 56, "h"], "stop": [4, 64, "h"]},
                                          {"kind": "box", "start": [-4, 56, 0], "stop": [4, 64, "h"]}]})
        check_design(d)
        b = build_preview(None, {}, design=d)["bundle"]
        parts = {p["name"]: p for p in b["parts"]}
        pieces = parts["patch"]["primitives"]
        self.assertTrue(all(q["kind"] == "box" and q["exact"] for q in pieces))
        self.assertAlmostEqual(sum((q["stop"][0] - q["start"][0]) * (q["stop"][1] - q["start"][1]) for q in pieces), 32 * 40 - 2 * 20 - 3 * 2)
        arr = parts["arr"]["primitives"]
        self.assertEqual(len(arr), 2 * (4 + 1))                            # the sheet in 4 pieces and the solid, twice
        with tempfile.TemporaryDirectory() as tmp:
            pp = Path(tmp) / "t.py"
            src = to_python(d)
            pp.write_text(src)
            for values in ({}, {"ws": "4", "ls": "10"}):
                with self.subTest(values=values):
                    a = build_preview(None, values, design=d)["bundle"]
                    b2 = build_preview(str(pp), values)["bundle"]
                    self.assertEqual(json.dumps(a["parts"], sort_keys=True), json.dumps(b2["parts"], sort_keys=True))
        self.assertIn("def _sheet_minus(", src)
        d["parts"][2]["cuts"][0]["stop"][2] = "h + 1"
        with self.assertRaises(DesignError) as cm:
            module_for(d).build({p.key: p.default for p in module_for(d).PARAMS})
        self.assertEqual(cm.exception.where, "parts[2].cuts[0].stop")

    def test_components_are_folders_only(self):
        """A part's component path groups it in the designer's tree; the build ignores it."""
        d = blank_design("t", "T")
        plain = build_preview(None, {}, design=d)["bundle"]
        d["parts"][1]["component"] = "board"
        d["parts"][2]["component"] = "antenna/radiator"
        check_design(d)
        filed = build_preview(None, {}, design=d)["bundle"]
        self.assertEqual(json.dumps(plain["parts"], sort_keys=True), json.dumps(filed["parts"], sort_keys=True))
        self.assertIn("# component 'antenna/radiator'", to_python(d))
        d["parts"][2]["component"] = ["antenna"]
        with self.assertRaises(DesignError) as cm:
            check_design(d)
        self.assertEqual(cm.exception.where, "parts[2].component")

    def test_transform_and_shape_errors(self):
        cases = [
            ({"kind": "sphere", "center": [0, 0, 0], "radius": 1}, [{"type": "move"}], "parts[3].transforms[0]"),
            ({"kind": "sphere", "center": [0, 0, 0], "radius": 1}, [{"type": "move", "offset": [1, 2]}], "parts[3].transforms[0].offset"),
            ({"kind": "sphere", "center": [0, 0, 0], "radius": 1}, [{"type": "move", "offset": [0, "missing", 0]}], "parts[3].transforms[0].offset[1]"),
            ({"kind": "cylinder", "axis": "w", "center": [0, 0], "radius": 1, "range": [0, 1]}, None, "parts[3].primitives[0].axis"),
            ({"kind": "cylinder", "axis": "z", "center": [0, 0], "radius": 1, "inner_radius": 1, "range": [0, 1]}, None,
             "parts[3].primitives[0].inner_radius"),
            ({"kind": "sphere", "center": [0, 0, 0], "radius": 0}, None, "parts[3].primitives[0].radius"),
            ({"kind": "sphere", "center": [0, 0, 0], "radius": 1}, [{"type": "rotate"}], "parts[3].transforms[0].axis"),
            ({"kind": "sphere", "center": [0, 0, 0], "radius": 1}, [{"type": "rotate", "axis": "z", "center": [0, 0, 0], "angle": "missing"}], "parts[3].transforms[0].angle"),
            ({"kind": "sphere", "center": [0, 0, 0], "radius": 1}, [{"type": "rotate", "axis": "z", "center": [0, 0], "angle": 90}], "parts[3].transforms[0].center"),
            ({"kind": "sphere", "center": [0, 0, 0], "radius": 1}, [{"type": "rotate", "axis": "z", "center": [0, 0, 0], "angle": 90, "copies": 0.5}], "parts[3].transforms[0].copies"),
            ({"kind": "cone", "axis": "q", "center": [0, 0], "bottom_radius": 1, "top_radius": 0, "range": [0, 1]}, None, "parts[3].primitives[0].axis"),
            ({"kind": "cone", "axis": "z", "center": [0, 0], "bottom_radius": 0, "top_radius": 0, "range": [0, 1]}, None,
             "parts[3].primitives[0].bottom_radius"),
            ({"kind": "cone", "axis": "z", "center": [0, 0], "bottom_radius": 1, "top_radius": 0, "range": [1, 1]}, None, "parts[3].primitives[0].range[1]"),
            ({"kind": "torus", "axis": "z", "center": [0, 0, 0], "major_radius": 1, "minor_radius": 1}, None, "parts[3].primitives[0].minor_radius"),
            ({"kind": "torus", "axis": "z", "center": [0, 0, 0], "major_radius": 0, "minor_radius": 1}, None, "parts[3].primitives[0].major_radius"),
            ({"kind": "wire", "points": [[0, 0, 0]], "radius": 1}, None, "parts[3].primitives[0].points"),
            ({"kind": "wire", "points": [[0, 0, 0], [0, 0, 0]], "radius": 1}, None, "parts[3].primitives[0].points"),
            ({"kind": "wire", "points": [[0, 0, 0], [0, 0, 1]], "radius": 0}, None, "parts[3].primitives[0].radius"),
            ({"kind": "sphere", "center": [0, 0, 0], "radius": 1}, [{"type": "mirror", "plane": "q"}], "parts[3].transforms[0].plane"),
            ({"kind": "sphere", "center": [0, 0, 0], "radius": 1}, [{"type": "translate", "copies": 2.5, "step": [1, 0, 0]}],
             "parts[3].transforms[0].copies"),
            ({"kind": "sphere", "center": [0, 0, 0], "radius": 1}, [{"type": "translate", "copies": 5000, "step": [1, 0, 0]}],
             "parts[3].transforms[0].copies"),
            ({"kind": "sphere", "center": [0, 0, 0], "radius": 1}, [{"type": "translate", "copies": 2, "step": [1, 0]}],
             "parts[3].transforms[0].step"),
        ]
        for prim, transforms, where in cases:
            d = blank_design("t", "T")
            d["parts"].append({"name": "x", "material": "copper", "primitives": [prim], **({"transforms": transforms} if transforms else {})})
            with self.subTest(where=where), self.assertRaises(DesignError) as cm:
                module_for(d).build({p.key: p.default for p in module_for(d).PARAMS})
            self.assertEqual(cm.exception.where, where)

    def test_build_errors_carry_the_path(self):
        d = blank_design("t", "T")
        d["parts"][2]["primitives"][0]["stop"][1] = "L/2 + nope"
        with self.assertRaises(DesignError) as cm:
            module_for(d).build({p.key: p.default for p in module_for(d).PARAMS})
        self.assertEqual(cm.exception.where, "parts[2].primitives[0].stop[1]")


def detailed_array(level=3, copies=3):
    """A small version of the review's large-preview fixture (#105): a copies+1 square array of
    35 µm copper squares, each topped by a Koch outline, over a substrate and a ground plane."""
    from test_automesh import koch

    d = blank_design("array", "Detailed array")
    edge = 22 * copies + 20
    d["parts"] = [
        {"name": "substrate", "material": "substrate", "primitives": [{"kind": "box", "start": [-20, -20, 0], "stop": [edge, edge, 1.6]}]},
        {"name": "array", "material": "copper", "primitives": [
            {"kind": "box", "start": [-9, -9, 1.6], "stop": [9, 9, 1.635]},
            {"kind": "polygon", "normal": "z", "elevation": 1.635, "points": [[x - 12, y - 7] for x, y in koch(level)]}],
         "transforms": [{"type": "translate", "copies": copies, "step": [22, 0, 0]},
                        {"type": "translate", "copies": copies, "step": [0, 22, 0]}]},
        {"name": "ground", "material": "copper", "primitives": [{"kind": "box", "start": [-20, -20, 0], "stop": [edge, edge, 0]}]}]
    d["ports"] = [{"type": "lumped", "number": 1, "R": 50, "start": [0, 0, 1.6], "stop": [0, 0, 1.635], "direction": "z"}]
    return d


class DetailedArrayPreview(unittest.TestCase):
    """The preview of a detailed array (#105): the automatic mesh computes the gaps of a fill pass
    together and asks only nearby polygon edges, with the same result as one gap at a time and
    every edge."""

    def outputs(self, d):
        from fairbeam.design import module_for
        from fairbeam.preview import design_checks

        module = module_for(copy.deepcopy(d))
        values = {p.key: p.default for p in module.PARAMS}
        sim = module.build(values)
        bundle = sim.to_bundle(module.MODEL, [p.describe(values[p.key]) for p in module.PARAMS], name="preview")
        bundle.pop("created")
        return {"lines": [list(sim.mesh.GetLines(a)) for a in range(3)], "report": sim.mesh_report,
                "bundle": json.dumps(bundle, sort_keys=True), "checks": design_checks(d, {}, bundle)}

    def test_same_mesh_bundle_and_checks_as_the_plain_algorithms(self):
        import fairbeam.automesh as am
        from test_automesh import ScanIndex, fill_per_gap

        for d in (detailed_array(), detailed_array(level=2, copies=5)):
            fast = self.outputs(d)
            with mock.patch.object(am, "fill", fill_per_gap), mock.patch.object(am, "_EdgeIndex", ScanIndex):
                plain = self.outputs(d)
            self.assertGreater(len(fast["lines"][0]), 100)
            self.assertEqual(fast["lines"], plain["lines"])
            self.assertEqual(fast["report"], plain["report"])
            self.assertEqual(fast["bundle"], plain["bundle"])
            self.assertEqual(fast["checks"], plain["checks"])

    def test_an_edit_changes_the_mesh(self):
        # nothing is kept between builds: moving the array moves its mesh lines
        d = detailed_array(level=2, copies=1)
        before = self.outputs(d)["lines"][0]
        d["parts"][1]["transforms"][0]["step"] = [23, 0, 0]
        after = self.outputs(d)["lines"][0]
        self.assertNotEqual(before, after)


class DesignApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.models = root / "models"
        cls.models.mkdir()
        (root / "projects").mkdir()
        manager = JobManager(root / "jobs", root / "projects", command_factory=lambda job: [sys.executable, "-c", "pass"])
        cls.app = App(models_dir=cls.models, projects_dir=root / "projects", jobs_dir=root / "jobs",
                      templates_dir=TEMPLATES, manager=manager)
        cls.srv = make_server(cls.app, "127.0.0.1", 0, quiet=True)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.app.close()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        h = {"Host": f"127.0.0.1:{self.port}"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=h)
        r = conn.getresponse()
        payload = json.loads(r.read() or b"null")
        conn.close()
        return r.status, payload

    def test_create_edit_preview_flow(self):
        st, body = self.request("POST", "/api/designs", {"id": "my_patch", "name": "My patch"})
        self.assertEqual(st, 201, body)
        self.assertTrue(body["validation"]["valid"], body["validation"])
        self.assertEqual(body["design"]["model"]["id"], "my-patch")
        h = body["hash"]

        st, models = self.request("GET", "/api/models")
        entry = next(m for m in models["models"] if m["key"] == "my_patch")
        self.assertEqual(entry["kind"], "design")
        self.assertEqual([p["key"] for p in entry["params"]], ["f0", "W", "L", "h", "G", "feed"])

        # a Python model may not take a design's id, and the other way round
        st, err = self.request("POST", "/api/models", {"id": "my_patch", "template": "blank"})
        self.assertEqual(st, 409, err)

        d = copy.deepcopy(body["design"])
        d["params"][1]["default"] = 30
        st, saved = self.request("PUT", "/api/designs/my_patch", {"design": d, "base_hash": h})
        self.assertEqual(st, 200, saved)
        self.assertTrue(saved["validation"]["valid"])
        self.assertIsNotNone(saved["backup"])
        st, stale = self.request("PUT", "/api/designs/my_patch", {"design": d, "base_hash": h})
        self.assertEqual(st, 409)

        bad = copy.deepcopy(d)
        bad["parts"][0]["material"] = "gold"
        st, err = self.request("PUT", "/api/designs/my_patch", {"design": bad, "base_hash": saved["hash"]})
        self.assertEqual(st, 422)
        self.assertIn("parts[0].material", err["fields"])

        # unsaved state: preview the dict directly
        st, pv = self.request("POST", "/api/preview", {"design": d, "params": {"L": "36"}})
        self.assertEqual(st, 200, pv)
        patch = next(p for p in pv["bundle"]["parts"] if p["name"] == "patch")["primitives"][0]
        self.assertEqual(patch["start"][:2], [-15.0, -18.0])
        negative_r = copy.deepcopy(d)
        negative_r["ports"][0]["R"] = -1
        st, err = self.request("POST", "/api/preview", {"design": negative_r})
        self.assertEqual(st, 422, err)
        self.assertIn("ports[0].R", err["fields"])
        self.assertIn({"severity": "error", "path": "ports[0].R", "code": "port-r"},
                      [{k: c[k] for k in ("severity", "path", "code")} for c in err["checks"]])
        self.assertNotIn("build", {c["code"] for c in err["checks"]})
        broken = copy.deepcopy(d)
        broken["ports"][0]["stop"][2] = "h +"
        st, err = self.request("POST", "/api/preview", {"design": broken})
        self.assertEqual(st, 422)
        self.assertIn("ports[0].stop[2]", err["fields"])

        st, py = self.request("GET", "/api/designs/my_patch/python")
        self.assertEqual(st, 200)
        self.assertIn("def build(p: dict) -> Simulation:", py["source"])

        st, dup = self.request("POST", "/api/designs", {"id": "my_patch_2", "from": "my_patch", "name": "Copy"})
        self.assertEqual(st, 201, dup)
        self.assertEqual(dup["design"]["model"], {**d["model"], "id": "my-patch-2", "name": "Copy"})

    def test_preview_builds_despite_non_fatal_check_errors(self):
        # only the checks that would crash the openEMS build refuse the preview; the rest preview the
        # fresh geometry and list their errors
        base = blank_design("lint-preview", "Lint preview")
        st, pv = self.request("POST", "/api/preview", {"design": base})
        self.assertEqual(st, 200, pv)
        self.assertEqual([c for c in pv["checks"] if c["severity"] == "error"], [])

        dielectric_only = copy.deepcopy(base)
        dielectric_only["parts"] = [p for p in dielectric_only["parts"] if p["material"] != "copper"]
        weak_end = copy.deepcopy(base)
        weak_end["simulation"]["end_criteria_db"] = -1
        monitor_out = copy.deepcopy(base)
        monitor_out["monitors"] = {"currents": ["f0 * 3"]}
        ff_out = copy.deepcopy(base)
        ff_out["far_field"]["frequencies"] = ["f0 * 3"]
        cases = [(dielectric_only, "no-metal", "parts"),
                 (weak_end, "end-criterion", "simulation.end_criteria_db"),
                 (monitor_out, "monitor-band", "monitors.currents[0]"),
                 (ff_out, "ff-band", "far_field.frequencies[0]")]
        for design, code, path in cases:
            with self.subTest(code=code):
                st, pv = self.request("POST", "/api/preview", {"design": design})
                self.assertEqual(st, 200, pv)
                self.assertTrue(pv["bundle"]["parts"])
                self.assertIn({"severity": "error", "path": path, "code": code},
                              [{k: c[k] for k in ("severity", "path", "code")} for c in pv["checks"]])

    def test_preview_refuses_build_fatal_resistance(self):
        base = blank_design("fatal-preview", "Fatal preview")
        for r in (0, -1):
            with self.subTest(port_r=r):
                d = copy.deepcopy(base)
                d["ports"][0]["R"] = r
                st, err = self.request("POST", "/api/preview", {"design": d})
                self.assertEqual(st, 422, err)
                self.assertEqual(err["fields"], {"ports[0].R": "the port impedance must be > 0 Ω"})
                self.assertEqual(err["error"], "ports[0].R: the port impedance must be > 0 Ω")
                self.assertIn("port-r", {c["code"] for c in err["checks"]})
                self.assertNotIn("build", {c["code"] for c in err["checks"]})
        d = copy.deepcopy(base)
        d["resistors"] = [{"name": "r1", "R": "0", "start": ["W/2", "-1", "0"], "stop": ["W/2", "-1", "h"],
                           "direction": "z"}]
        st, err = self.request("POST", "/api/preview", {"design": d})
        self.assertEqual(st, 422, err)
        self.assertEqual(err["error"], "resistors[0].R: the resistance must be > 0 Ω")
        self.assertIn("resistors[0].R", err["fields"])

    def test_python_export_of_rotated_thin_copper(self):
        st, body = self.request("POST", "/api/designs", {"id": "thin_rotate"})
        self.assertEqual(st, 201, body)
        d, h = body["design"], body["hash"]
        d["parts"][2]["primitives"][0]["stop"][2] = "h + 0.035"
        for axis in "xyz":
            with self.subTest(axis=axis):
                for part in d["parts"]:
                    part["transforms"] = [{"type": "rotate", "axis": axis, "center": [0, 0, 0], "angle": 90}]
                st, saved = self.request("PUT", "/api/designs/thin_rotate", {"design": d, "base_hash": h})
                self.assertEqual(st, 200, saved)
                h = saved["hash"]
                st, py = self.request("GET", "/api/designs/thin_rotate/python")
                self.assertEqual(st, 200, py)
                self.assertIn("thin metal, built as a sheet", py["source"])

    def test_delete_moves_the_design_into_its_history(self):
        st, body = self.request("POST", "/api/designs", {"id": "to_delete", "template": "empty"})
        self.assertEqual(st, 201, body)
        path = self.models / "to_delete.design.json"
        text = path.read_text(encoding="utf-8")
        # a save first, so the history folder also holds a backup that must survive
        d = copy.deepcopy(body["design"])
        d["model"]["name"] = "Renamed"
        st, saved = self.request("PUT", "/api/designs/to_delete", {"design": d, "base_hash": body["hash"]})
        self.assertEqual(st, 200, saved)
        text = path.read_text(encoding="utf-8")

        st, res = self.request("POST", "/api/designs/to_delete/delete", {})
        self.assertEqual(st, 200, res)
        self.assertFalse(path.exists())
        history = self.app.history_dir / "to_delete"
        deleted = sorted(history.glob("deleted-*.design.json"))
        self.assertEqual(len(deleted), 1)
        self.assertEqual(deleted[0].read_text(encoding="utf-8"), text)  # moved as is, not rewritten
        self.assertEqual(Path(res["moved_to"]), deleted[0])
        self.assertEqual(len([f for f in history.glob("*.design.json") if not f.name.startswith("deleted-")]), 1)

        st, _ = self.request("GET", "/api/designs/to_delete")
        self.assertEqual(st, 404)
        st, models = self.request("GET", "/api/models")
        self.assertNotIn("to_delete", [m["key"] for m in models["models"]])
        st, again = self.request("POST", "/api/designs/to_delete/delete", {})
        self.assertEqual(st, 404, again)

        # the id is free again; a second delete keeps both copies
        st, body = self.request("POST", "/api/designs", {"id": "to_delete", "template": "empty"})
        self.assertEqual(st, 201, body)
        st, res = self.request("POST", "/api/designs/to_delete/delete", {})
        self.assertEqual(st, 200, res)
        self.assertEqual(len(list(history.glob("deleted-*.design.json"))), 2)

    def test_delete_on_a_kept_alive_connection(self):
        # the browser (WebView2) reuses the connection: the next request must not see the delete's
        # unread body ("{}GET /api/models" -> 501, and the start screen kept the deleted design)
        st, body = self.request("POST", "/api/designs", {"id": "keep_alive", "template": "empty"})
        self.assertEqual(st, 201, body)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        h = {"Host": f"127.0.0.1:{self.port}", "Content-Type": "application/json"}
        try:
            conn.request("POST", "/api/designs/keep_alive/delete", body=b"{}", headers=h)
            r = conn.getresponse()
            self.assertEqual(r.status, 200, r.read())
            r.read()
            conn.request("GET", "/api/models", headers={"Host": h["Host"]})
            r = conn.getresponse()
            payload = r.read()
            self.assertEqual(r.status, 200, payload)
            self.assertNotIn("keep_alive", [m["key"] for m in json.loads(payload)["models"]])
        finally:
            conn.close()

    def test_delete_refuses_bad_ids_and_python_models(self):
        st, _ = self.request("POST", "/api/designs/Bad-Id/delete", {})
        self.assertEqual(st, 404)
        st, body = self.request("POST", "/api/models", {"id": "py_model", "template": "blank"})
        self.assertEqual(st, 201, body)
        st, err = self.request("POST", "/api/designs/py_model/delete", {})
        self.assertEqual(st, 404, err)  # only designs; a Python model stays
        self.assertTrue((self.models / "py_model.py").exists())


if __name__ == "__main__":
    unittest.main()
