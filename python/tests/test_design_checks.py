"""Design checks (fairbeam.design_checks): each check, the shared cases, the expression parity
fixture, the mesh checks from a preview bundle and the server returning / enforcing them."""

import ast
import copy
import http.client
import json
import math
import os
import random
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import designer_fixture  # noqa: E402
from fairbeam.design import DesignError, blank_design, evaluate, prim_bbox  # noqa: E402
from fairbeam.design_checks import CHEAP, END_DB_MAX, END_DB_MIN, EXPLANATIONS, PLACEMENT, _Lint, _first_crossing, _segments_cross, errors, lint, polygon_problems, run_blockers  # noqa: E402
from fairbeam.jobs import JobManager  # noqa: E402
from fairbeam.preview import build_preview, design_checks as preview_checks  # noqa: E402
from fairbeam.server import App, make_server  # noqa: E402

TEMPLATES = Path(__file__).resolve().parents[1] / "templates"
keys = lambda checks: sorted(designer_fixture.key(c) for c in checks)  # noqa: E731


class SharedFixture(unittest.TestCase):
    """The cases scripts/check-designer.mjs also runs through expr.ts and checks.ts."""

    def test_expressions(self):
        fx = designer_fixture.load()
        for e in fx["expressions"]:
            with self.subTest(expr=e["expr"]):
                if e.get("error"):
                    with self.assertRaises(DesignError):
                        evaluate(e["expr"], fx["names"])
                elif e.get("exact"):
                    self.assertEqual(evaluate(e["expr"], fx["names"]), e["value"])
                else:
                    self.assertAlmostEqual(evaluate(e["expr"], fx["names"]), e["value"], delta=1e-9 * max(1, abs(e["value"])))

    def test_params(self):
        # parameter keys (__proto__, inherited object names, keywords) and in-order resolution
        for entry in designer_fixture.load()["params"]:
            with self.subTest(params=entry["name"]):
                r = designer_fixture.param_results(entry)
                if "key_error" in entry:
                    self.assertEqual(r, {"key_error": f"params[{entry['key_error']}].key"})
                    continue
                self.assertEqual(r["values"], entry["values"])
                self.assertEqual(r["errors"], entry.get("errors", []))
                if entry.get("errors"):
                    first = next(i for i, p in enumerate(entry["params"]) if p["key"] == entry["errors"][0])
                    self.assertEqual(r["resolve_error"], f"params[{first}].expr")
                else:
                    self.assertEqual(r["resolved"], entry["values"])

    def test_numbers(self):
        # plain numbers, NaN and Infinity included: refused by evaluate() and as a parameter default
        for n in designer_fixture.load()["numbers"]:
            with self.subTest(number=n["number"]):
                r = designer_fixture.number_results(n)
                if n.get("error"):
                    self.assertIn("error", r)
                    self.assertRegex(r.get("default_error", ""), r"^params\[\d+\]\.default: .* is not a finite number$")
                else:
                    self.assertEqual(r, {"value": n["value"]})

    def test_cases(self):
        for case in designer_fixture.load()["cases"]:
            with self.subTest(case=case["name"]):
                checks = lint(designer_fixture.case_design(case))
                self.assertEqual(keys(checks), sorted(case["expect"]))
                # the fix buttons the case expects, and no other
                self.assertEqual({designer_fixture.key(c): c["fix"] for c in checks if "fix" in c}, case.get("fixes", {}))

    def test_every_emitted_code_has_an_explanation(self):
        # Find check codes in emitter calls, polygon result pairs and server check dictionaries.
        # Scanning all server modules also catches the preview worker's build-error check.
        codes = set()
        for path in (Path(__file__).resolve().parents[1] / "fairbeam").glob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if (path.name == "design_checks.py" and isinstance(node, ast.Call)
                        and isinstance(node.func, ast.Attribute) and node.func.attr in {"error", "warn", "info", "add"}):
                    index = 2 if node.func.attr == "add" else 1
                    if len(node.args) > index and isinstance(node.args[index], ast.Constant):
                        codes.add(node.args[index].value)
                if isinstance(node, ast.Dict):
                    for key, value in zip(node.keys, node.values):
                        if isinstance(key, ast.Constant) and key.value == "code" and isinstance(value, ast.Constant):
                            codes.add(value.value)
                if path.name == "design_checks.py" and isinstance(node, ast.Return) and isinstance(node.value, ast.List):
                    for pair in node.value.elts:
                        if isinstance(pair, ast.Tuple) and len(pair.elts) == 2 and isinstance(pair.elts[0], ast.Constant):
                            codes.add(pair.elts[0].value)
        self.assertEqual(codes, set(EXPLANATIONS), "every emitted code needs guidance; remove obsolete guidance too")
        self.assertLessEqual(CHEAP, codes)
        checker = _Lint({}, None, None)
        for code in codes:
            with self.subTest(code=code):
                text = EXPLANATIONS[code]
                self.assertTrue(text.strip())
                self.assertGreaterEqual(len(text.split(". ")), 2)
                self.assertLessEqual(len(text.split(". ")), 4)
                checker.add("warning", "", code, "example")
                self.assertEqual(checker.out[-1]["explain"], text)
        self.assertEqual(lint(None)[0]["explain"], EXPLANATIONS["structure"])
        build = preview_checks(blank_design("t", "T"), {}, None, ValueError("unsupported geometry"))
        self.assertEqual(next(c for c in build if c["code"] == "build")["explain"], EXPLANATIONS["build"])

    def test_every_check_has_a_case_or_a_test(self):
        codes = {k.split("|")[1] for c in designer_fixture.load()["cases"] for k in c["expect"]}
        # covered by the tests below instead (they need a bundle or an odd design)
        codes |= {"part-empty", "tan-d-freq", "end-criterion", "resistor-r", "resistor-length", "mesh-cells",
                  "mesh-warning", "mesh-feature", "structure", "scale", "boolean-transform-angle", "sheet-transform-angle"}
        self.assertLessEqual(set(CHEAP), codes)


class Checks(unittest.TestCase):
    def lint(self, edit, bundle=None):
        d = blank_design("t", "T")
        edit(d)
        return lint(d, None, bundle)

    def test_scale_requires_positive_uniform_factors(self):
        for factors in ([2, 3, 2], [1, 0, 1]):
            with self.subTest(factors=factors):
                checks = self.lint(lambda d: d["parts"][2].update(transforms=[
                    {"type": "scale", "factors": factors, "origin": [0, 0, 0]}]))
                self.assertIn("scale", [item["code"] for item in checks])

    def test_severities(self):
        c = self.lint(lambda d: d.update(ports=[]))
        # without a port nothing is excited: an error, so the run is refused instead of crashing
        self.assertEqual([x["severity"] for x in c], ["error"])
        self.assertEqual([x["code"] for x in errors(c)], ["no-port"])

    def test_sheet_is_fine_and_min_equal_max_on_one_axis(self):
        self.assertEqual(self.lint(lambda d: None), [])   # the ground and the patch are sheets

    def test_arbitrary_rotations_keep_zero_thickness_metal_sheets_solver_safe(self):
        rotate = lambda axis, angle: {"type": "rotate", "axis": axis, "center": [0, 0, 0], "angle": angle, "copies": 0}

        def checks(transforms, lossy=False, primitive=None):
            def edit(d):
                if lossy:
                    d["materials"][0]["conductivity"] = "5.8e7"
                if primitive is not None:
                    d["parts"][2]["primitives"] = [primitive]
                d["parts"][2]["transforms"] = transforms
            return [c for c in self.lint(edit) if c["code"] == "sheet-transform-angle"]

        tilted_pec = checks([rotate("x", 45)])
        self.assertEqual([(c["severity"], c["path"]) for c in tilted_pec],
                         [("error", "parts[2].transforms[0].angle")])
        self.assertIn("tilted relative to the Yee grid", tilted_pec[0]["message"])

        # Rotation within a Z-plane sheet leaves its original normal and tangent plane intact.
        self.assertEqual(checks([rotate("z", 45)], lossy=True), [])
        # Two arbitrary rotations can land on an axis-aligned plane, but a ConductingSheet still
        # reads the original local bounds and cannot be trusted with the changed tangent axes.
        changed_lossy_normal = checks([rotate("x", 45), rotate("x", 45)], lossy=True)
        self.assertEqual([(c["severity"], c["path"]) for c in changed_lossy_normal],
                         [("error", "parts[2].transforms[1].angle")])
        self.assertIn("openEMS may select the wrong tangential conductivity direction",
                      changed_lossy_normal[0]["message"])
        # An intervening mirror changes the normal vector: the final geometry returns to the
        # original Z-plane, so it remains valid.
        self.assertEqual(checks([rotate("x", 45), {"type": "mirror", "plane": "y", "keep": False},
                                 rotate("x", 45)], lossy=True), [])
        # Legacy quarter-turn maps are baked into primitives and remain supported.
        self.assertEqual(checks([rotate("x", 90)], lossy=True), [])
        # A true volume can keep an arbitrary transform; only zero-thickness sheets are restricted.
        self.assertEqual(checks([rotate("x", 45)], primitive={"kind": "box", "start": [-2, -2, 0],
                                                               "stop": [2, 2, 0.2]}), [])

    def test_live_boolean_operand_requires_quarter_turn_rotation(self):
        history = json.loads((Path(__file__).parent / "fixtures" / "boolean_parity.json").read_text())[0]["history"]
        history["live"] = True
        history["A"]["transforms"][1]["angle"] = 45
        checks = [c for c in self.lint(lambda d: d["parts"][2].update(booleanHistory=history))
                  if c["code"] == "boolean-transform-angle"]
        self.assertEqual([(c["severity"], c["path"]) for c in checks],
                         [("error", "parts[2].booleanHistory.A.transforms[1].angle")])

    def test_part_empty_resistor_and_end_criterion(self):
        def edit(d):
            d["parts"].append({"name": "nothing", "material": "copper", "primitives": []})
            d["resistors"].append({"name": "r1", "R": "-5", "start": [0, 0, "h"], "stop": [0, 0, "h"], "direction": "y"})
            d["simulation"]["end_criteria_db"] = 3
            d["materials"][1]["tan_d_freq"] = "0"
        self.assertEqual(keys(self.lint(edit)), [
            "error|end-criterion|simulation.end_criteria_db", "error|resistor-length|resistors[0].stop[1]",
            "error|resistor-r|resistors[0].R", "error|tan-d-freq|materials.substrate.tan_d_freq",
            "warning|part-empty|parts[3]"])

    def test_structure_errors_stop_the_checks(self):
        c = self.lint(lambda d: d["parts"][0].update(material="gold"))
        self.assertEqual(keys(c), ["error|structure|parts[0].material"])

    def test_values_override_the_defaults(self):
        d = blank_design("t", "T")
        # a long patch overhangs the ground and the feed misses it: with feed = -30 the port's top
        # end is outside the patch (W = 32 -> |x| <= 16)
        self.assertEqual(lint(d, {"feed": -6.0}), [])
        self.assertEqual(keys(lint(d, {"feed": -30.0})), ["warning|port-floating|ports[0].stop"])

    def test_transformed_copies_count_for_the_geometry(self):
        # an array of patches, each fed: the ports touch the mirrored copies only
        def edit(d):
            d["parts"][2]["primitives"][0] = {"kind": "box", "start": [2, -5, "h"], "stop": [8, 5, "h"]}
            d["parts"][2]["transforms"] = [{"type": "mirror", "plane": "x", "keep": False}]
            d["ports"][0]["start"][0] = d["ports"][0]["stop"][0] = -5
            d["ports"][0]["start"][1] = d["ports"][0]["stop"][1] = 2   # off the patch's center (port-at-null)
        self.assertEqual(self.lint(edit), [])

        def floating(d):
            edit(d)
            d["parts"][2]["transforms"][0]["keep"] = True
            d["ports"][0]["start"][0] = d["ports"][0]["stop"][0] = 0
        self.assertEqual(keys(self.lint(floating)), ["warning|port-floating|ports[0].stop"])

    def test_pec_boundary_counts_as_metal(self):
        def edit(d):
            d["parts"].pop(1)   # no ground plane: the port's lower end is in the air ...
        self.assertEqual(keys(self.lint(edit)), ["warning|port-floating|ports[0].start"])

        def pec(d):
            edit(d)
            d["simulation"]["boundaries"] = ["MUR", "MUR", "MUR", "MUR", "PEC", "MUR"]
        d = blank_design("t", "T")
        pec(d)
        bundle = build_preview(None, {}, design=d)["bundle"]
        # ... unless it sits on a PEC domain face (an infinite ground)
        self.assertEqual(lint(d, None, bundle), [])

    def test_tube_wall_and_hidden_part(self):
        def edit(d):
            d["parts"].append({"name": "tube", "material": "copper", "primitives": [
                {"kind": "cylinder", "axis": "z", "center": [20, 20], "radius": 2, "inner_radius": 1, "range": [0, "h"]}]})
            # inside the bore: not hidden (a tube is not a solid container)
            d["parts"].append({"name": "core", "material": "substrate", "primitives": [
                {"kind": "cylinder", "axis": "z", "center": [20, 20], "radius": 0.5, "range": [0, "h"]}]})
            # inside a sphere of higher priority: hidden
            d["parts"].append({"name": "ball", "material": "copper", "primitives": [{"kind": "sphere", "center": [-20, 20, 5], "radius": 3}]})
            d["parts"].append({"name": "pip", "material": "copper", "primitives": [
                {"kind": "box", "start": [-20.5, 19.5, 4.5], "stop": [-19.5, 20.5, 5.5], "priority": 3}]})
        c = self.lint(edit)
        self.assertEqual(keys(c), ["warning|part-hidden|parts[4]", "warning|part-hidden|parts[6]"])
        # core is hidden inside the substrate (same priority 0), pip inside ball (10 >= 3); a solid is
        # named by its label, as the designer shows it
        self.assertIn("'Substrate'", c[0]["message"])
        self.assertIn("'ball'", c[1]["message"])

    def test_polygon_problems(self):
        self.assertEqual(polygon_problems([[0, 0], [1, 0], [0, 1]]), [])
        self.assertEqual(polygon_problems([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]), [])  # closing point repeated
        self.assertEqual(polygon_problems([[0, 0], [2, 0], [2, 2], [1, -1]])[0][0], "polygon-self-intersect")
        self.assertEqual(polygon_problems([[0, 0], [1, 0], [2, 0], [1, 0]])[0][0], "polygon-area")
        # a star (non-convex, simple) is fine
        star = [[0, 3], [1, 1], [3, 1], [1.5, -0.5], [2, -3], [0, -1.5], [-2, -3], [-1.5, -0.5], [-3, 1], [-1, 1]]
        self.assertEqual(polygon_problems(star), [])

    def test_first_crossing_matches_every_pair(self):
        def every_pair(pts):
            n = len(pts)
            for i in range(n):
                for j in range(i + 1, n):
                    if j == i + 1 or (i == 0 and j == n - 1):
                        continue
                    if _segments_cross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]):
                        return (i, j)
            return None

        rng = random.Random(5)
        for k in range(300):
            n = rng.randint(4, 40)
            grid = k % 3 == 0   # integer points: many collinear and touching edges
            pts = [[rng.randint(-5, 5), rng.randint(-5, 5)] if grid else [rng.uniform(-5, 5), rng.uniform(-5, 5)]
                   for _ in range(n)]
            self.assertEqual(_first_crossing(pts), every_pair(pts), pts)
        # a simple outline with many aligned edges (a Minkowski-like staircase) has none
        stair = [[i // 2 + (i % 2), i // 2] for i in range(60)] + [[30, -1], [0, -1]]
        self.assertIsNone(_first_crossing(stair))
        self.assertIsNone(every_pair(stair))


class MeshChecks(unittest.TestCase):
    def test_fine_refinement_cell_impact_from_preview(self):
        d = blank_design("t", "T")
        b = build_preview(None, {}, design=d)["bundle"]
        impact = {"baseline_cells": 100_000, "total_cells": 250_000,
                  "added_cells": 150_000, "ratio": 2.5}
        b["mesh"].setdefault("auto", {})["fine_feature_refinement"] = impact
        checks = [c for c in lint(d, None, b) if c["code"] == "mesh-fine-refinement"]
        self.assertEqual(keys(checks), ["info|mesh-fine-refinement|mesh"])
        self.assertEqual(checks[0]["message"],
                         "local fine-feature refinement adds 150,000 cells (100,000 → 250,000; 2.5×)")
        self.assertEqual(checks[0]["explain"], EXPLANATIONS["mesh-fine-refinement"])
        impact.update(total_cells=100_000, added_cells=0, ratio=1)
        self.assertFalse(any(c["code"] == "mesh-fine-refinement" for c in lint(d, None, b)))
        impact.update(skipped_cell_limit=True, cell_limit=40_000_000, required_cells_lower_bound=50_000_000)
        checks = [c for c in lint(d, None, b) if c["code"] == "mesh-fine-limit"]
        self.assertEqual(keys(checks), ["warning|mesh-fine-limit|mesh"])
        self.assertEqual(checks[0]["message"],
                         "local fine-feature refinement exceeds the 40,000,000 cell limit; unresolved features remain")
        self.assertEqual(checks[0]["explain"], EXPLANATIONS["mesh-fine-limit"])

    def test_underresolved_fine_features_from_preview(self):
        d = blank_design("t", "T")
        b = build_preview(None, {}, design=d)["bundle"]
        feature = {"kind": "strip", "width": 0.4, "cells_across": 1.25,
                   "required_cells": 3, "resolved": False}
        b["mesh"].setdefault("auto", {})["fine_features"] = [feature]
        checks = [c for c in lint(d, None, b) if c["code"] == "mesh-fine-feature"]
        self.assertEqual(keys(checks), ["warning|mesh-fine-feature|mesh"])
        self.assertEqual(checks[0]["message"],
                         "a fine feature 0.4 mm wide has 1.25 cells across; at least 3 are required")
        self.assertEqual(checks[0]["explain"], EXPLANATIONS["mesh-fine-feature"])
        # Numeric resolution remains authoritative if an older producer omits the flag.
        del feature["resolved"]
        self.assertTrue(any(c["code"] == "mesh-fine-feature" for c in lint(d, None, b)))
        feature.update(cells_across=3, resolved=True)
        self.assertFalse(any(c["code"] == "mesh-fine-feature" for c in lint(d, None, b)))
        # Legacy and manual previews without a fine-feature report remain valid inputs.
        del b["mesh"]["auto"]["fine_features"]
        self.assertFalse(any(c["code"] == "mesh-fine-feature" for c in lint(d, None, b)))

    def test_cell_limits_and_mesh_warnings(self):
        d = blank_design("t", "T")
        b = build_preview(None, {}, design=d)["bundle"]
        self.assertEqual(lint(d, None, b), [])
        big = copy.deepcopy(b)
        big["mesh"]["total_cells"] = 25_000_000
        big["mesh"]["auto"] = {**big["mesh"].get("auto", {}), "warnings": ["x: port 1 at 0 and metal edge at 1e-05 are only 1e-05 apart"]}
        self.assertEqual(keys(lint(d, None, big)), ["warning|mesh-cells|mesh", "warning|mesh-warning|mesh"])
        big["mesh"]["total_cells"] = 50_000_000
        self.assertEqual(errors(lint(d, None, big))[0]["code"], "mesh-cells")
        old = os.environ.get("FAIRBEAM_MAX_CELLS")
        os.environ["FAIRBEAM_MAX_CELLS"] = "60e6"
        try:
            self.assertEqual(errors(lint(d, None, big)), [])
        finally:
            if old is None:
                del os.environ["FAIRBEAM_MAX_CELLS"]
            else:
                os.environ["FAIRBEAM_MAX_CELLS"] = old

    def test_cell_limit_hint_names_the_cause(self):
        """Over the cell limit the hint follows the cause, without the server's environment variable:
        a very wide band asks to lower f max (with the cell size it sets) even though the domain is
        then mostly air too; a usual band in a box of air asks for a smaller boundary distance; a
        usual band without much air asks for coarser cells."""
        d = blank_design("t", "T")   # a patch in a domain that is mostly air
        b = build_preview(None, {}, design=d)["bundle"]
        big = copy.deepcopy(b)
        big["mesh"]["total_cells"] = 667_500_000
        big["mesh"]["min_cell"] = 0.0177
        wide = copy.deepcopy(d)
        wide["simulation"]["f_min"], wide["simulation"]["f_max"] = 1.68, 240
        msg = errors(lint(wide, None, big))[0]["message"]
        self.assertIn("over the server limit of 40 M cells", msg)
        self.assertNotIn("FAIRBEAM_MAX_CELLS", msg)
        self.assertIn("lower f max (cells of 0.0177 mm at 240 GHz): f max / f min = 143 is a very wide band", msg)
        self.assertNotIn("mostly air", msg, "the band is the cause; the air is its symptom")
        # the usual band of the same patch: the air around it is the cause
        msg = errors(lint(d, None, big))[0]["message"]
        self.assertIn("is mostly air: the open boundaries sit a quarter wavelength at f min", msg)
        self.assertNotIn("FAIRBEAM_MAX_CELLS", msg)
        # little air: the cells are the cause
        tight = copy.deepcopy(big)
        tight["domain"] = {"min": [-31.0, -31.0, -1.0], "max": [31.0, 31.0, 2.5]}
        msg = errors(lint(d, None, tight))[0]["message"]
        self.assertRegex(msg, r": lower f max or the cells per wavelength \(cells of 0\.0177 mm at [\d.]+ GHz\)$")
        # below the limit only a clear cause is added to the warning
        tight["mesh"]["total_cells"] = 25_000_000
        warning = [c for c in lint(d, None, tight) if c["code"] == "mesh-cells"][0]["message"]
        self.assertEqual(warning, "the mesh has 25.0 M cells: a long run and several GB of memory")
        big["mesh"]["total_cells"] = 25_000_000
        warning = [c for c in lint(wide, None, big) if c["code"] == "mesh-cells"][0]["message"]
        self.assertIn("; lower f max (cells of 0.0177 mm at 240 GHz)", warning)

    def test_feature_between_mesh_lines(self):
        d = blank_design("t", "T")
        # a 1 µm rod (a plate that thin would be built as a sheet, see ThinMetal below)
        d["parts"].append({"name": "sliver", "material": "copper", "primitives": [
            {"kind": "box", "start": [20, 20, "h + 1"], "stop": [20.001, 20.001, "h + 2"]}]})
        b = build_preview(None, {}, design=d)["bundle"]
        # the mesher keeps lines on both faces, 1 µm apart, and says so; the sliver is resolved (and
        # its 1 µm cells make the timestep so small that the pulse cannot fit into the limit)
        self.assertEqual(keys(lint(d, None, b)), ["error|run-too-long|simulation.max_timesteps", "info|smallest-cell|mesh",
                                                  "warning|mesh-warning|mesh", "warning|mesh-warning|mesh"])
        self.assertIn("only 0.001 apart", next(x for x in lint(d, None, b) if x["code"] == "mesh-warning")["message"])
        # a mesh with no line inside the sliver's z extent: FDTD would drop it
        coarse = copy.deepcopy(b)
        x = coarse["mesh"]["x"]
        coarse["mesh"]["x"] = [v for v in x if not 19.9 < v < 20.1]
        c = [x for x in lint(d, None, coarse) if x["code"] == "mesh-feature"]
        self.assertEqual(keys(c), ["warning|mesh-feature|parts[3].primitives[0]"])
        self.assertIn("along x", c[0]["message"])

    def test_cuts_that_cut_nothing_or_what_they_cannot(self):
        def edit(d):
            d["parts"][2]["cuts"] = [{"start": [-1, -5, "h"], "stop": [1, 5, "h"]},        # a slot: fine
                                     {"start": [-1, -5, 0], "stop": [1, 5, 0]},            # in the ground's plane, not the patch's
                                     {"start": [-40, -40, "h"], "stop": [40, 40, "h"]}]    # everything
            # a solid block: cuts remove area from flat sheets, so this one stays whole (the cut is reported);
            # a polygon sheet is cut like a rectangular one, and a round hole in it is fine too
            d["parts"].append({"name": "block", "material": "copper", "cuts": [{"start": [20, 20, "h"], "stop": [22, 22, "h"]}],
                               "primitives": [{"kind": "box", "start": [19, 19, "h"], "stop": [25, 25, "h + 1"]}]})
            d["parts"].append({"name": "tri", "material": "copper", "cuts": [{"start": [20, 20, "h"], "stop": [22, 22, "h"]},
                                                                           {"kind": "circle", "normal": "z", "elevation": "h", "center": [22, 21], "radius": 0.5}],
                               "primitives": [{"kind": "polygon", "normal": "z", "elevation": "h", "points": [[19, 19], [25, 19], [19, 25]]}]})
        d = blank_design("t", "T")
        edit(d)
        c = lint(d)
        self.assertEqual(keys(x for x in c if x["code"].startswith("cut")),
                         ["warning|cut-all|parts[2].primitives[0]", "warning|cut-unsupported|parts[3].cuts[0]",
                          "warning|cut-unused|parts[2].cuts[1]"])
        self.assertIn("primitives[0] (a brick with thickness at the cut's plane)", next(x for x in c if x["code"] == "cut-unsupported")["message"])

    def test_hidden_in_the_new_shapes(self):
        """A part inside a cone or a straight wire is hidden; the test does not trust non-convex
        containers (a torus, a bent wire)."""
        def hidden(container):
            d = blank_design("t", "T")
            d["parts"].append({"name": "outer", "material": "copper", "primitives": [container]})
            d["parts"].append({"name": "inner", "material": "copper", "primitives": [{"kind": "box", "start": [29.8, 29.8, 4], "stop": [30.2, 30.2, 5]}]})
            return [c["path"] for c in lint(d) if c["code"] == "part-hidden"]
        self.assertEqual(hidden({"kind": "cone", "axis": "z", "center": [30, 30], "bottom_radius": 3, "top_radius": 1, "range": [2, 8]}), ["parts[4]"])
        self.assertEqual(hidden({"kind": "wire", "points": [[30, 30, 2], [30, 30, 8]], "radius": 1}), ["parts[4]"])
        self.assertEqual(hidden({"kind": "wire", "points": [[30, 30, 2], [30, 30, 8], [40, 30, 8]], "radius": 1}), [])
        self.assertEqual(hidden({"kind": "torus", "axis": "x", "center": [30, 30, 4.5], "major_radius": 0.6, "minor_radius": 0.5}), [])

    def test_wire_thinner_than_the_mesh(self):
        d = blank_design("t", "T")
        d["parts"].append({"name": "mono", "material": "copper", "primitives": [
            {"kind": "wire", "points": [[20, 20, 0], [20, 20, 25]], "radius": 0.5}]})
        b = build_preview(None, {}, design=d)["bundle"]
        # the automatic mesh puts lines across the wire: resolved
        self.assertEqual([c for c in lint(d, None, b) if c["code"] == "wire-thin"], [])
        # a mesh with 3 mm cells around it, a line on its axis: the 1 mm thick wire is a line of cell edges
        coarse = copy.deepcopy(b)
        for ax in ("x", "y"):
            coarse["mesh"][ax] = sorted({v for v in coarse["mesh"][ax] if not 16.9 < v < 23.1} | {17, 20, 23})
        c = [x for x in lint(d, None, coarse) if x["code"] in ("wire-thin", "mesh-feature")]
        self.assertEqual(keys(c), ["warning|wire-thin|parts[3].primitives[0].radius"])
        self.assertIn("radius (0.5 mm)", c[0]["message"])


def pcb_design(thin_metal=None):
    """The blank patch with its ground and patch drawn as 35 µm copper, and the probe
    drawn from the bottom of the ground to the top of the patch."""
    d = blank_design("t", "T")
    d["parts"][1]["primitives"][0] = {"kind": "box", "start": ["-G/2", "-G/2", "-0.035"], "stop": ["G/2", "G/2", "0"]}
    d["parts"][2]["primitives"][0] = {"kind": "box", "start": ["-W/2", "-L/2", "h"], "stop": ["W/2", "L/2", "h + 0.035"]}
    d["ports"][0].update(start=["feed", "0", "-0.035"], stop=["feed", "0", "h + 0.035"])
    if thin_metal:
        d["mesh"]["thin_metal"] = thin_metal
    return d


def placement(d, values=None):
    """The metal placement checks of a design: (code, path, message)."""
    return [(c["code"], c["path"], c["message"]) for c in lint(d, values) if c["code"] in PLACEMENT]


def horn_design():
    """A free-standing pyramidal horn of metal plates in the air, fed by a waveguide port, with a
    dielectric window touching its mouth: nothing lies on a dielectric face."""
    d = blank_design("h", "Horn")
    d["simulation"].update(f_min="8", f_max="12", boundaries="MUR")
    d["params"] = [{"key": "a", "default": 22.86, "label": "a", "unit": "mm"}, {"key": "b", "default": 10.16, "label": "b", "unit": "mm"}]
    d["materials"][1]["tan_d_freq"] = "10"   # the blank design's "f0" is gone with its parameters
    d["materials"].append({"name": "ptfe", "kind": "dielectric", "eps_r": "2.1", "tan_d": "0.0002"})
    walls = [
        # the feed guide
        {"kind": "box", "start": ["-a/2", "-b/2", 0], "stop": ["a/2", "-b/2", 30]},
        {"kind": "box", "start": ["-a/2", "b/2", 0], "stop": ["a/2", "b/2", 30]},
        {"kind": "box", "start": ["-a/2", "-b/2", 0], "stop": ["-a/2", "b/2", 30]},
        {"kind": "box", "start": ["a/2", "-b/2", 0], "stop": ["a/2", "b/2", 30]},
        # a stepped flare: wider plates further out
        {"kind": "box", "start": [-20, -12, 30], "stop": [20, -12, 60]},
        {"kind": "box", "start": [-20, 12, 30], "stop": [20, 12, 60]},
        {"kind": "box", "start": [-20, -12, 30], "stop": [-20, 12, 60]},
        {"kind": "box", "start": [20, -12, 30], "stop": [20, 12, 60]},
        {"kind": "box", "start": [-20, -12, 30], "stop": [20, 12, 30]},
    ]
    d["parts"] = [{"name": "horn", "material": "copper", "primitives": walls},
                  {"name": "window", "material": "ptfe", "primitives": [{"kind": "box", "start": [-20, -12, 60], "stop": [20, 12, 62]}]}]
    d["ports"] = [{"type": "waveguide", "number": 1, "mode": "TE10", "a": "a", "b": "b", "start": ["-a/2", "-b/2", 2],
                   "stop": ["a/2", "b/2", 8], "direction": "z"}]
    d["far_field"]["frequencies"] = ["10"]
    return d


class MetalPlacement(unittest.TestCase):
    """metal-overhang and metal-floating on the resolved geometry (the blank design is a probe-fed
    patch W × L on a G × G substrate)."""

    def test_patch_on_its_substrate_is_fine(self):
        d = blank_design("t", "T")
        self.assertEqual(placement(d), [])
        self.assertEqual(placement(d, {"W": 60.0, "L": 60.0}), [])   # exactly as large as the substrate
        self.assertEqual(placement(pcb_design()), [])   # 35 µm copper on both faces

    def test_patch_wider_than_its_substrate(self):
        c = placement(blank_design("t", "T"), {"W": 70.0})
        self.assertEqual([(code, path) for code, path, _ in c], [("metal-overhang", "parts[2].primitives[0]")])
        self.assertIn("'patch' overhangs 'substrate' by 5 mm (x+) and 5 mm (x-)", c[0][2])
        # the explanation and the 3D framing come with the part's path
        check = next(x for x in lint(blank_design("t", "T"), {"W": 70.0}) if x["code"] == "metal-overhang")
        self.assertEqual(check["explain"], EXPLANATIONS["metal-overhang"])
        self.assertEqual(check["severity"], "warning")

    def test_one_sided_overhang_says_the_side(self):
        d = blank_design("t", "T")
        d["parts"][2]["primitives"][0] = {"kind": "box", "start": [10, "-L/2", "h"], "stop": [31.2, "L/2", "h"]}
        d["ports"][0]["start"][0] = d["ports"][0]["stop"][0] = 20
        self.assertEqual(placement(d), [("metal-overhang", "parts[2].primitives[0]",
                                         "'patch' overhangs 'substrate' by 1.2 mm (x+): the metal lies on the dielectric's "
                                         "face but reaches past its edge into the air")])

    def test_ground_larger_than_the_board_and_polygon_patches(self):
        d = blank_design("t", "T")
        d["parts"][1]["primitives"][0] = {"kind": "box", "start": [-30, -30, 0], "stop": [30, 34, 0]}
        self.assertEqual(placement(d), [("metal-overhang", "parts[1].primitives[0]",
                                         "'gnd' overhangs 'substrate' by 4 mm (y+): the metal lies on the dielectric's face "
                                         "but reaches past its edge into the air")])
        # a round patch drawn as a polygon: judged by its extreme vertices
        for r, expect in ((14, []), (32, ["metal-overhang"])):
            d = blank_design("t", "T")
            pts = [[r * math.cos(2 * math.pi * i / 32), r * math.sin(2 * math.pi * i / 32)] for i in range(32)]
            d["parts"][2]["primitives"][0] = {"kind": "polygon", "normal": "z", "elevation": "h", "points": pts}
            with self.subTest(radius=r):
                self.assertEqual([x[0] for x in placement(d)], expect)

    def test_what_is_not_an_overhang(self):
        cases = {}
        d = blank_design("t", "T")   # the substrate in two halves side by side
        d["parts"][0]["primitives"] = [{"kind": "box", "start": ["-G/2", "-G/2", 0], "stop": [0, "G/2", "h"]},
                                       {"kind": "box", "start": [0, "-G/2", 0], "stop": ["G/2", "G/2", "h"]}]
        cases["two substrate halves"] = d
        d = blank_design("t", "T")   # a line running off the board onto a connector body
        d["parts"].append({"name": "line", "material": "copper", "primitives": [{"kind": "box", "start": [20, -1, "h"], "stop": [32, 1, "h"]}]})
        d["parts"].append({"name": "sma", "material": "copper", "primitives": [{"kind": "box", "start": [30, -4, -3], "stop": [36, 4, 5]}]})
        cases["line onto a connector"] = d
        d = blank_design("t", "T")   # an air cavity in the substrate under the patch
        d["materials"].append({"name": "air", "kind": "dielectric", "eps_r": "1"})
        d["parts"].append({"name": "cavity", "material": "air", "primitives": [{"kind": "box", "start": [-10, -10, 0], "stop": [10, 10, "h"], "priority": 5}]})
        cases["air cavity"] = d
        d = blank_design("t", "T")   # a radome around everything
        d["materials"].append({"name": "abs", "kind": "dielectric", "eps_r": "2.8", "tan_d": "0.01"})
        d["parts"].insert(0, {"name": "radome", "material": "abs", "primitives": [{"kind": "box", "start": [-40, -40, -5], "stop": [40, 40, 10]}]})
        cases["radome"] = d
        d = blank_design("t", "T")   # a shorting via through the substrate
        d["parts"].append({"name": "via", "material": "copper", "primitives": [
            {"kind": "cylinder", "axis": "z", "center": [0, 0], "radius": 0.4, "range": [0, "h"]}]})
        cases["via"] = d
        d = blank_design("t", "T")   # the whole design turned a quarter turn about x
        for pt in d["parts"]:
            pt["transforms"] = [{"type": "rotate", "axis": "x", "angle": 90, "center": [0, 0, 0], "copies": 0}]
        d["ports"][0].update(start=["feed", "0", "0"], stop=["feed", "-h", "0"], direction="y")
        cases["rotated"] = d
        cases["free-standing horn"] = horn_design()
        for name, d in cases.items():
            with self.subTest(name):
                self.assertEqual(errors(lint(d)), [])   # else the placement checks would not run at all
                self.assertEqual(placement(d), [])

    def test_isolated_brick_is_floating(self):
        d = blank_design("t", "T")
        d["parts"].append({"name": "brick", "material": "copper", "primitives": [{"kind": "box", "start": [0, 0, 5], "stop": [3, 3, 8]}]})
        self.assertEqual(placement(d), [("metal-floating", "parts[3].primitives[0]",
                                         "'brick' touches no other metal, no dielectric and no port: it is a solid 3 × 3 × 3 mm "
                                         "block isolated in the air")])
        check = next(x for x in lint(d) if x["code"] == "metal-floating")
        self.assertEqual((check["severity"], check["explain"]), ("warning", EXPLANATIONS["metal-floating"]))
        # touching the patch, or resting on the substrate, it is part of the structure
        d["parts"][3]["primitives"][0] = {"kind": "box", "start": [0, 0, "h"], "stop": [3, 3, 8]}
        self.assertEqual(placement(d), [])
        d["parts"][3]["primitives"][0] = {"kind": "box", "start": [20, 20, "h"], "stop": [23, 23, 4]}
        self.assertEqual(placement(d), [])

    def test_patch_lifted_off_or_moved_off_its_substrate(self):
        d = blank_design("t", "T")
        d["parts"][2]["primitives"][0]["start"][2] = d["parts"][2]["primitives"][0]["stop"][2] = "1.524"
        self.assertEqual(placement(d), [])
        c = placement(d, {"h": 1.2})   # a thinner substrate leaves the patch hovering above it
        self.assertEqual([x[:2] for x in c], [("metal-floating", "parts[2].primitives[0]")])
        self.assertIn("it floats 0.324 mm off 'substrate', on its z+ side", c[0][2])
        d = blank_design("t", "T")
        d["parts"][2]["primitives"][0] = {"kind": "box", "start": [35, "-L/2", "h"], "stop": ["35 + W", "L/2", "h"]}
        c = placement(d)
        self.assertEqual([x[:2] for x in c], [("metal-floating", "parts[2].primitives[0]")])
        self.assertIn("in the plane of the z+ face of 'substrate' (z = 1.524) but 5 mm past its x+ edge", c[0][2])

    def test_parasitic_metal_in_the_air_is_not_floating(self):
        d = blank_design("t", "T")
        d["parts"].append({"name": "reflector", "material": "copper", "primitives": [{"kind": "box", "start": [-50, -50, -30], "stop": [50, 50, -30]}]})
        for i in range(3):   # directors: strips well away from the board
            d["parts"].append({"name": f"dir{i}", "material": "copper", "primitives": [
                {"kind": "box", "start": [-25, 40 + 20 * i, 10], "stop": [25, 42 + 20 * i, 10]}]})
        d["parts"].append({"name": "stacked", "material": "copper", "primitives": [
            {"kind": "box", "start": ["-W/2", "-L/2", "h + 6"], "stop": ["W/2", "L/2", "h + 6"]}]})
        d["parts"].append({"name": "ball", "material": "copper", "primitives": [{"kind": "sphere", "center": [0, 0, 40], "radius": 3}]})
        self.assertEqual(placement(d), [])

    def test_ports_resistors_and_pec_hold_metal(self):
        # a gap-fed dipole of two bricks in the air: the port joins the arms
        d = blank_design("t", "T")
        d["parts"] = [{"name": "arm1", "material": "copper", "primitives": [{"kind": "box", "start": [-1, -1, 1], "stop": [1, 1, 30]}]},
                      {"name": "arm2", "material": "copper", "primitives": [{"kind": "box", "start": [-1, -1, -30], "stop": [1, 1, -1]}]}]
        d["ports"][0].update(start=[0, 0, -1], stop=[0, 0, 1])
        self.assertEqual(placement(d), [])
        self.assertEqual(errors(lint(d)), [])
        # a second dipole beside it, joined only by a grouped port's member feed: every physical feed holds metal
        d["parts"] += [{"name": "arm3", "material": "copper", "primitives": [{"kind": "box", "start": [2, -1, 1], "stop": [4, 1, 30]}]},
                       {"name": "arm4", "material": "copper", "primitives": [{"kind": "box", "start": [2, -1, -30], "stop": [4, 1, -1]}]}]
        d["ports"][0]["group"] = {"connection": "parallel", "members": [{"start": [3, 0, -1], "stop": [3, 0, 1], "direction": "z", "polarity": 1}]}
        self.assertEqual(placement(d), [])
        # without the member feed the same two arms are metal floating 1 mm from the fed dipole
        del d["ports"][0]["group"]
        self.assertEqual([x[:2] for x in placement(d)], [("metal-floating", "parts[2].primitives[0]"), ("metal-floating", "parts[3].primitives[0]")])
        # a block under the board, isolated unless it rests on a PEC floor (the model's lowest point)
        d = blank_design("t", "T")
        d["parts"].append({"name": "block", "material": "copper", "primitives": [{"kind": "box", "start": [0, 0, -4], "stop": [3, 3, -1]}]})
        self.assertEqual([x[0] for x in placement(d)], ["metal-floating"])
        d["simulation"]["boundaries"] = ["MUR", "MUR", "MUR", "MUR", "PEC", "MUR"]
        self.assertEqual(placement(d), [])

    def test_not_judged_while_the_geometry_has_errors(self):
        # an inverted patch is an error; its bounding box is no reliable drawing to judge
        c = lint(blank_design("t", "T"), {"W": 70.0})
        self.assertIn("metal-overhang", [x["code"] for x in c])
        d = blank_design("t", "T")
        d["parts"][2]["primitives"][0]["start"][0] = "W"
        self.assertEqual(placement(d, {"W": 70.0}), [])

    def test_shipped_examples_are_clean(self):
        # the CST macros of every example (examples/cst) as imported designs, and the templates
        from fairbeam.cst_import import import_cst
        from fairbeam.design import empty_design

        macros = sorted((Path(__file__).resolve().parents[2] / "examples" / "cst").glob("*.bas"))
        self.assertGreaterEqual(len(macros), 10)
        for path in macros:
            with self.subTest(path.name):
                d = import_cst(path.read_text(encoding="utf-8", errors="replace"), model_id=path.stem, filename=path.name)["design"]
                self.assertEqual(placement(d), [])
        self.assertEqual(placement(empty_design("t", "T")), [])

    def test_run_blockers(self):
        ok = lint(blank_design("t", "T"))
        self.assertEqual(run_blockers(ok), [])
        wide = lint(blank_design("t", "T"), {"W": 70.0})
        self.assertEqual([c["code"] for c in run_blockers(wide)], ["metal-overhang"])
        self.assertEqual(run_blockers(wide, {("metal-overhang", "parts[2].primitives[0]")}), [])
        broken = lint(blank_design("t", "T") | {"ports": []})
        self.assertEqual([c["code"] for c in run_blockers(broken)], ["no-port"])


class ThinMetal(unittest.TestCase):
    """35 µm copper is built as sheets on the substrate side (design.thin_sheets); the checks around
    it: thin-metal, port-in-metal, port-at-null, excitation-too-long."""

    @classmethod
    def setUpClass(cls):
        cls.sheet = build_preview(None, {}, design=pcb_design())["bundle"]
        cls.volume = build_preview(None, {}, design=pcb_design("volume"))["bundle"]

    def test_sheets_on_the_substrate_faces_keep_the_drawn_thickness(self):
        prims = {p["name"]: p["primitives"][0] for p in self.sheet["parts"]}
        self.assertEqual(prims["gnd"]["sheet"], {"axis": "z", "at": 0.0, "thickness": 0.035})
        self.assertEqual(prims["patch"]["sheet"], {"axis": "z", "at": 1.524, "thickness": 0.035})
        self.assertEqual((prims["gnd"]["start"][2], prims["gnd"]["stop"][2]), (-0.035, 0.0))   # as drawn
        self.assertNotIn("sheet", prims["substrate"])
        # the probe now spans the substrate between the two sheets
        port = self.sheet["ports"][0]
        self.assertEqual((port["start"][2], port["stop"][2]), (0.0, 1.524))

    def test_the_mesh_no_longer_resolves_the_copper(self):
        self.assertGreater(self.sheet["mesh"]["min_cell"], 0.1)
        # "volume" would need 12 µm cells and a 50x smaller timestep: 35 µm copper stays a sheet there too
        self.assertGreater(self.volume["mesh"]["min_cell"], 0.1)
        self.assertAlmostEqual(self.volume["mesh"]["auto"]["timestep_s"], self.sheet["mesh"]["auto"]["timestep_s"])
        self.assertEqual(self.volume["mesh"]["total_cells"], self.sheet["mesh"]["total_cells"])

    def test_checks_with_sheets(self):
        c = lint(pcb_design(), None, self.sheet)
        self.assertEqual(keys(c), ["info|thin-metal|parts[1].primitives[0]", "info|thin-metal|parts[2].primitives[0]"])
        self.assertIn("35 µm metal is modeled as a sheet at z = 1.524 (on its z-min face)", c[1]["message"])
        self.assertEqual(errors(c), [])

    def test_checks_with_volumes(self):
        c = lint(pcb_design("volume"), None, self.volume)
        # the thin copper is still a sheet, and the warning says why the setting did not keep it
        self.assertNotIn("port-in-metal", {x["code"] for x in c})
        self.assertNotIn("thin-metal", {x["code"] for x in c})
        self.assertEqual([x["code"] for x in c if x["code"] == "thin-metal-volume"], ["thin-metal-volume"] * 2)
        self.assertEqual(errors(c), [])

    def test_excitation_longer_than_the_limit(self):
        b = copy.deepcopy(self.sheet)
        b["mesh"]["auto"]["timestep_s"] = 37.5e-15   # a 35 µm cell's timestep (openEMS takes 0.8 of it)
        limited = pcb_design()
        limited["simulation"]["max_timesteps"] = 60000   # an explicit limit: the build does not choose one
        c = [x for x in lint(limited, None, b) if x["code"] == "excitation-too-long"]
        # a setting makes the run useless, not the design: an error, the run is refused
        self.assertEqual(keys(c), ["error|excitation-too-long|simulation.max_timesteps"])
        self.assertIn("cannot converge", c[0]["message"])
        # the one-click fix sets max timesteps to room for the pulse (2.5 x, in tens of thousands)
        fix = c[0]["fix"]
        self.assertEqual(list(fix["set"]), ["simulation.max_timesteps"])
        self.assertGreater(fix["set"]["simulation.max_timesteps"], 60000)
        self.assertEqual(fix["label"], f"Set max timesteps to {fix['set']['simulation.max_timesteps']:,}")
        n = float(c[0]["message"].split("takes about ")[1].split(" timesteps")[0].replace(",", ""))
        self.assertGreaterEqual(fix["set"]["simulation.max_timesteps"], 2.5 * n)
        # times in a unit that keeps 1 to 999 in front, never 1.18e+03 fs
        self.assertIn("a timestep of 30 fs", c[0]["message"])
        b["mesh"]["auto"]["timestep_s"] = 1.475e-12    # a coarse mesh with a low limit, as a user might set
        d = pcb_design()
        d["simulation"]["max_timesteps"] = 1000
        c = [x for x in lint(d, None, b) if x["code"] == "excitation-too-long"]
        self.assertIn("a timestep of 1.18 ps", c[0]["message"])
        self.assertNotIn("e+", c[0]["message"])
        b["mesh"]["auto"]["timestep_s"] = 62e-15   # about 0.6 of the limit: may not converge
        c = [x for x in lint(limited, None, b) if x["code"] == "excitation-too-long"]
        self.assertEqual(c[0]["severity"], "warning")
        self.assertIn("little time", c[0]["message"])
        self.assertEqual([x for x in lint(limited, None, self.sheet) if x["code"] == "excitation-too-long"], [])
        # no explicit limit: the build chooses one, so the same fine mesh is judged by its cost, not by 60000
        b["mesh"]["auto"]["timestep_s"] = 37.5e-15
        self.assertEqual([x for x in lint(pcb_design(), None, b) if x["code"] in ("excitation-too-long", "run-too-long")], [])

    def test_port_at_the_patch_center(self):
        d = blank_design("t", "T")
        c = lint(d, {"feed": 0.0})
        self.assertEqual(keys(c), ["warning|port-at-null|ports[0].start"])
        self.assertIn("If this is a resonant patch", c[0]["message"])
        # the offer moves the feed through its parameter, 0.15 x the 32 mm side off the center
        self.assertEqual(c[0]["fix"]["set"], {"params[5].default": -4.8})
        self.assertEqual(c[0]["explain"], EXPLANATIONS["port-at-null"])
        self.assertEqual(lint(d, {"feed": -6.0}), [])
        d["ports"][0]["start"][0] = d["ports"][0]["stop"][0] = "0"   # plain coordinates: set them
        self.assertEqual(lint(d)[0]["fix"]["set"], {"ports[0].start[0]": "-4.8", "ports[0].stop[0]": "-4.8"})

    def test_center_feed_without_patch_stack_has_no_null_warning(self):
        d = blank_design("t", "T")
        d["parts"].pop(0)  # no dielectric substrate between the plates
        self.assertNotIn("port-at-null", {c["code"] for c in lint(d, {"feed": 0.0})})
        d = blank_design("t", "T")
        d["parts"].pop(1)  # no ground plane
        self.assertNotIn("port-at-null", {c["code"] for c in lint(d, {"feed": 0.0})})
        d = blank_design("t", "T")
        d["parts"][2]["primitives"][0]["stop"][2] = "h + 2"  # substantial metal brick
        self.assertNotIn("port-at-null", {c["code"] for c in lint(d, {"feed": 0.0})})

    def test_port_reaching_into_a_thick_block(self):
        d = blank_design("t", "T")
        d["parts"][1]["primitives"][0] = {"kind": "box", "start": ["-G/2", "-G/2", "-2"], "stop": ["G/2", "G/2", "0"]}
        d["ports"][0]["start"][2] = "-1"   # inside the 2 mm ground block
        self.assertEqual(keys(lint(d)), ["warning|port-in-metal|ports[0].start"])

    def test_port_inside_a_block_is_an_error(self):
        # the whole port inside one conductor: shorted, no result possible, so the run is refused
        d = blank_design("t", "T")
        d["parts"][1]["primitives"][0] = {"kind": "box", "start": ["-G/2", "-G/2", "-4"], "stop": ["G/2", "G/2", "0"]}
        d["ports"][0]["start"][2], d["ports"][0]["stop"][2] = "-3", "-1"
        c = [x for x in lint(d) if x["code"] == "port-in-metal"]
        self.assertEqual(keys(c), ["error|port-in-metal|ports[0].start"])
        self.assertIn("runs through", c[0]["message"])


class OneClickFixes(unittest.TestCase):
    """The checks that offer a fix button (``fix``: label and JSON paths to set): applying it to the
    design resolves the check and adds no new error or warning."""

    def apply(self, d, fix):
        d = copy.deepcopy(d)
        for path, value in fix["set"].items():
            designer_fixture.set_path(d, path, value)
        return d

    def fixed(self, d, code, values=None, path=None):
        """The check ``code`` of ``d`` with its fix, the design after the fix and the checks then."""
        c = [x for x in lint(d, values) if x["code"] == code and (path is None or x["path"] == path)]
        self.assertEqual(len(c), 1, keys(lint(d, values)))
        self.assertIn("fix", c[0])
        after = lint(self.apply(d, c[0]["fix"]), values)
        # the check is gone at that path, and nothing new appeared
        self.assertNotIn((code, c[0]["path"]), {(x["code"], x["path"]) for x in after})
        self.assertLessEqual(set(keys(after)), set(keys(lint(d, values))), keys(after))
        return c[0], self.apply(d, c[0]["fix"]), after

    def test_loss_tangent_at_f0(self):
        d = blank_design("t", "T")
        d["materials"][1]["tan_d_freq"] = "10"
        c, after, _ = self.fixed(d, "tan-d-band")
        self.assertEqual(c["fix"], {"label": "Give tan δ at f0", "set": {"materials[1].tan_d_freq": "f0"}})
        self.assertEqual(after["materials"][1]["tan_d_freq"], "f0")

    def test_loss_tangent_at_the_band_center_without_f0(self):
        # no f0 parameter, or an f0 outside the band: the band center
        d = blank_design("t", "T")
        d["materials"][1]["tan_d_freq"] = "10"
        d["params"] = [p for p in d["params"] if p["key"] != "f0"]
        d["simulation"]["f_min"], d["simulation"]["f_max"] = "1.5", "3"
        d["far_field"]["frequencies"] = ["2"]
        c, _, _ = self.fixed(d, "tan-d-band")
        self.assertEqual(c["fix"], {"label": "Give tan δ at the band center (2.25 GHz)", "set": {"materials[1].tan_d_freq": "2.25"}})
        d = blank_design("t", "T")
        d["materials"][1]["tan_d_freq"] = "10"
        d["simulation"]["f_min"], d["simulation"]["f_max"] = "3", "4"   # f0 = 2.45 is below the band
        d["far_field"]["frequencies"] = ["3.5"]
        c, _, _ = self.fixed(d, "tan-d-band")
        self.assertEqual(c["fix"]["set"], {"materials[1].tan_d_freq": "3.5"})

    def test_port_end_reaching_into_metal_moves_onto_the_face(self):
        d = blank_design("t", "T")
        d["parts"][1]["primitives"][0] = {"kind": "box", "start": ["-G/2", "-G/2", "-2"], "stop": ["G/2", "G/2", "0"]}
        d["ports"][0]["start"][2] = "-1"   # inside the 2 mm ground block
        c, after, _ = self.fixed(d, "port-in-metal")
        # the block's own top-face expression, so the port stays where the ground is if it is moved
        self.assertEqual(c["fix"]["set"], {"ports[0].start[2]": "0"})
        self.assertEqual(c["fix"]["label"], "Move the end onto the face of 'gnd' (z = 0 mm)")
        self.assertEqual(lint(after), [])
        # the stop end, in a thick patch: onto the patch's lower face, written as the patch's own expression
        d = blank_design("t", "T")
        d["parts"][2]["primitives"][0]["stop"][2] = "h + 2"
        d["ports"][0]["stop"][2] = "h + 1"
        c, after, _ = self.fixed(d, "port-in-metal")
        self.assertEqual(c["fix"]["set"], {"ports[0].stop[2]": "h"})
        self.assertEqual(lint(after), [])

    def test_no_face_fix_when_metal_covers_the_port(self):
        d = blank_design("t", "T")
        d["parts"][1]["primitives"][0] = {"kind": "box", "start": ["-G/2", "-G/2", "-4"], "stop": ["G/2", "G/2", "0"]}
        d["ports"][0]["start"][2], d["ports"][0]["stop"][2] = "-3", "-1"   # runs through the ground: an error
        c = [x for x in lint(d) if x["code"] == "port-in-metal"]
        self.assertEqual(keys(c), ["error|port-in-metal|ports[0].start"])
        self.assertNotIn("fix", c[0])
        # metal on both sides of the gap: moving the end would only move the short
        d = blank_design("t", "T")
        d["parts"][1]["primitives"][0] = {"kind": "box", "start": ["-G/2", "-G/2", "-2"], "stop": ["G/2", "G/2", "h / 2"]}
        d["ports"][0]["start"][2] = "-1"
        c = [x for x in lint(d) if x["code"] == "port-in-metal"]
        self.assertTrue(c and "fix" not in c[0])

    def test_floating_port_end_snaps_to_the_nearest_metal(self):
        d = blank_design("t", "T")
        d["ports"][0]["stop"][2] = "h + 0.5"   # above the patch
        c, after, _ = self.fixed(d, "port-floating")
        self.assertEqual(c["path"], "ports[0].stop")
        self.assertEqual(c["fix"], {"label": "Move the end onto the nearest metal face ('patch', z = 1.524 mm)", "set": {"ports[0].stop[2]": "h"}})
        self.assertEqual(lint(after), [])
        d = blank_design("t", "T")
        d["ports"][0]["start"][2] = "-0.4"   # under the ground
        c, after, _ = self.fixed(d, "port-floating")
        self.assertEqual(c["path"], "ports[0].start")
        self.assertEqual(c["fix"]["set"], {"ports[0].start[2]": "0"})
        self.assertEqual(lint(after), [])
        d = blank_design("t", "T")
        d["ports"][0]["stop"][2] = "h - 0.4"   # short of the patch, inside the substrate
        c, after, _ = self.fixed(d, "port-floating")
        self.assertEqual(c["fix"]["set"], {"ports[0].stop[2]": "h"})

    def dipole(self, angle=None, axis="y", gap=1.0, radius=1.0):
        """Two cylindrical arms along z with a 2 x gap between them and a lumped port across it; the
        arms are turned about `axis` through the origin by `angle` degrees when given (ports do not
        follow a transform: a rotated dipole)."""
        d = blank_design("t", "T")
        d["parts"] = [
            {"name": "arm_a", "material": "copper", "primitives": [
                {"kind": "cylinder", "axis": "z", "center": [0, 0], "radius": radius, "range": [gap, 75]}]},
            {"name": "arm_b", "material": "copper", "primitives": [
                {"kind": "cylinder", "axis": "z", "center": [0, 0], "radius": radius, "range": [-75, -gap]}]},
        ]
        if angle is not None:
            for part in d["parts"]:
                part["transforms"] = [{"type": "rotate", "axis": axis, "center": ["0", "0", "0"], "angle": str(angle), "copies": 0}]
        d["ports"] = [{"type": "lumped", "number": 1, "R": "50", "start": ["0", "0", str(-gap)], "stop": ["0", "0", str(gap)],
                       "direction": "z"}]
        return d

    def test_a_port_that_spans_the_gap_of_a_dipole_is_clean(self):
        self.assertEqual(lint(self.dipole()), [])
        # half a turn about y swaps the arms: the gap is where it was
        self.assertEqual(lint(self.dipole(180)), [])
        # a turn about the dipole's own axis changes nothing
        self.assertEqual(lint(self.dipole(30, axis="z")), [])

    def test_a_rotated_dipole_leaves_its_port_behind(self):
        # the geometry turns, the port keeps its coordinates: neither end lies on a metal face any more,
        # so the feed spans no gap between two conductors (S11 of about 0 dB and no radiation)
        for angle in (5, 30, 45, 90):
            for axis in "xy":
                with self.subTest(angle=angle, axis=axis):
                    d = self.dipole(angle, axis)
                    self.assertEqual(keys(lint(d)), ["warning|port-floating|ports[0].start", "warning|port-floating|ports[0].stop"])
                    # with the preview bundle too, as the server runs it for the designer
                    bundle = build_preview(None, {}, design=d)["bundle"]
                    refinement = ["info|mesh-fine-refinement|mesh"] if angle != 90 else []
                    self.assertEqual(keys(lint(d, None, bundle)),
                                     refinement + ["warning|port-floating|ports[0].start", "warning|port-floating|ports[0].stop"])
        # the arms mirrored (not kept) leave the port just as well
        d = self.dipole()
        d["parts"][0]["transforms"] = [{"type": "mirror", "plane": "y", "point": ["0", "3", "0"], "keep": False}]
        self.assertEqual(keys(lint(d)), ["warning|port-floating|ports[0].stop"], "the moved arm's end; the other arm stayed")
        d["parts"][1]["transforms"] = [{"type": "mirror", "plane": "y", "point": ["0", "3", "0"], "keep": False}]
        self.assertEqual(keys(lint(d)), ["warning|port-floating|ports[0].start", "warning|port-floating|ports[0].stop"])

    def test_both_ends_must_sit_on_metal_faces(self):
        # one end on a face and the other floating: only that end
        d = self.dipole()
        d["ports"][0]["stop"][2] = "0.5"   # short of the upper arm, in the air of the gap
        self.assertEqual(keys(lint(d)), ["warning|port-floating|ports[0].stop"])
        # an end that reaches into an arm is not "on its face" either (and nothing is floating)
        d = self.dipole()
        d["ports"][0]["stop"][2] = "1.5"
        self.assertEqual(keys(lint(d)), ["warning|port-in-metal|ports[0].stop"])
        # through the arm: the metal shorts the port
        d["ports"][0]["stop"][2] = "5"
        self.assertEqual(keys(lint(d)), ["error|port-in-metal|ports[0].start"])
        # an end on a face: clean; the transforms that keep the faces in place do not matter
        d = self.dipole()
        d["parts"][0]["transforms"] = [{"type": "move", "offset": [0, 0, 0]}]
        self.assertEqual(lint(d), [])

    def test_floating_port_end_far_from_any_metal_has_no_fix(self):
        d = blank_design("t", "T")
        d["ports"][0]["stop"][2] = "h + 5"   # farther off the patch than half the port
        c = [x for x in lint(d) if x["code"] == "port-floating"]
        self.assertEqual(keys(c), ["warning|port-floating|ports[0].stop"])
        self.assertNotIn("fix", c[0])
        d = blank_design("t", "T")
        d["ports"][0]["start"] = ["50", "0", "0"]   # off the ground and the patch in the plane too
        d["ports"][0]["stop"] = ["50", "0", "h"]
        self.assertTrue(all("fix" not in x for x in lint(d) if x["code"] == "port-floating"))

    def test_port_for_a_patch_over_a_ground(self):
        d = blank_design("t", "T")
        d["ports"] = []
        c, after, _ = self.fixed(d, "no-port")
        self.assertEqual(c["fix"]["label"], "Add a probe port between 'gnd' and 'patch'")
        port = after["ports"][0]
        # ground face to patch face, 0.15 x the 32 mm side off the center (as port-at-null offers)
        self.assertEqual((port["start"], port["stop"], port["direction"]), (["-4.8", "0", "0"], ["-4.8", "0", "h"], "z"))
        self.assertEqual(lint(after), [])
        self.assertEqual(lint(after, {"h": 3.0}), [])   # written with the design's own h

    def test_port_for_a_patch_over_a_ground_along_another_axis(self):
        # the same stack turned to x: patch at the top of the +x side
        d = blank_design("t", "T")
        d["ports"] = []
        for pt in d["parts"]:
            for pr in pt["primitives"]:
                pr["start"] = [pr["start"][2], pr["start"][0], pr["start"][1]]
                pr["stop"] = [pr["stop"][2], pr["stop"][0], pr["stop"][1]]
        c, after, _ = self.fixed(d, "no-port")
        self.assertEqual(after["ports"][0]["direction"], "x")
        self.assertEqual(after["ports"][0]["start"][0], "0")
        self.assertEqual(after["ports"][0]["stop"][0], "h")
        self.assertEqual(lint(after), [])

    def test_no_port_fix_only_when_unambiguous(self):
        def no_fix(d):
            c = [x for x in lint(d) if x["code"] == "no-port"]
            self.assertEqual(len(c), 1)
            self.assertNotIn("fix", c[0])

        d = blank_design("t", "T")
        d["ports"] = []
        d["parts"].append({"name": "strip", "material": "copper", "primitives": [
            {"kind": "box", "start": ["-2", "0", "h"], "stop": ["2", "-30", "h"]}]})   # a third metal part
        no_fix(d)
        d = blank_design("t", "T")
        d["ports"] = []
        d["parts"][2]["transforms"] = [{"type": "translate", "copies": 1, "step": ["40", 0, 0]}]   # two patches
        no_fix(d)
        d = blank_design("t", "T")
        d["ports"][0]["excite"] = False   # a port exists: the choice is the user's
        no_fix(d)
        d = blank_design("t", "T")
        d["ports"] = []
        d["parts"][2]["primitives"][0]["start"] = ["-G/2", "-G/2", "h"]   # as large as the ground: which is which?
        d["parts"][2]["primitives"][0]["stop"] = ["G/2", "G/2", "h"]
        no_fix(d)
        d = blank_design("t", "T")
        d["ports"] = []
        d["parts"][2]["primitives"][0]["start"][2] = d["parts"][2]["primitives"][0]["stop"][2] = "0"   # touching: no gap
        no_fix(d)

    def test_overhanging_metal_is_trimmed_to_the_substrate(self):
        d = blank_design("t", "T")
        c, after, _ = self.fixed(d, "metal-overhang", {"W": 70.0})
        self.assertEqual(c["fix"], {"label": "Trim the metal to 'substrate'", "set": {
            "parts[2].primitives[0].start[0]": "-G/2", "parts[2].primitives[0].stop[0]": "G/2"}})
        # the design's own expressions: the patch now follows the substrate's edge
        self.assertEqual(after["parts"][2]["primitives"][0]["start"][0], "-G/2")
        # a corner overhang: both axes, one side each
        d = blank_design("t", "T")
        d["parts"][2]["primitives"][0]["stop"][:2] = ["G/2 + 3", "G/2 + 1.5"]
        c, after, _ = self.fixed(d, "metal-overhang")
        self.assertEqual(set(c["fix"]["set"]), {"parts[2].primitives[0].stop[0]", "parts[2].primitives[0].stop[1]"})
        self.assertEqual(lint(after), [])
        # numbers where the substrate has none
        d = blank_design("t", "T")
        d["parts"][0]["primitives"][0] = {"kind": "box", "start": ["-25.5", "-30", "0"], "stop": ["25.5", "30", "h"]}
        d["parts"][1]["primitives"][0] = {"kind": "box", "start": ["-25.5", "-30", "0"], "stop": ["25.5", "30", "0"]}
        c, after, _ = self.fixed(d, "metal-overhang", {"W": 60.0})
        self.assertEqual(c["fix"]["set"], {"parts[2].primitives[0].start[0]": "-25.5", "parts[2].primitives[0].stop[0]": "25.5"})

    def test_overhang_fix_only_for_a_brick_drawn_as_it_is(self):
        def no_fix(d, values=None):
            c = [x for x in lint(d, values) if x["code"] == "metal-overhang"]
            self.assertEqual(len(c), 1)
            self.assertNotIn("fix", c[0])

        d = blank_design("t", "T")
        d["parts"][2]["transforms"] = [{"type": "translate", "copies": 1, "step": ["0", "0", "0"]}]
        no_fix(d, {"W": 70.0})   # an array: the source brick is not the copy that overhangs
        d = blank_design("t", "T")
        d["parts"][2]["primitives"][0] = {"kind": "polygon", "normal": "z", "elevation": "h",
                                          "points": [[-40, -10], [40, -10], [40, 10], [-40, 10]]}
        no_fix(d)
        d = blank_design("t", "T")
        # the trim would cut the metal off the port: no offer
        d["ports"][0]["start"][0] = d["ports"][0]["stop"][0] = "35"
        d["parts"][2]["primitives"][0]["stop"][0] = "40"
        no_fix(d)

    def test_air_padding_under_a_quarter_wavelength(self):
        d = blank_design("t", "T")
        d["mesh"]["pad"] = "10"
        c, after, _ = self.fixed(d, "air-pad")
        # f min = 0.6 f0 = 1.47 GHz: 299.79 / 1.47 / 4 = 51 mm
        self.assertEqual(c["fix"], {"label": "Set the air padding to λ/4 (51 mm)", "set": {"mesh.pad": "51"}})
        self.assertEqual(c["path"], "mesh.pad")
        self.assertEqual(lint(after), [])
        # in the adaptive mesh the override is the padding
        d = blank_design("t", "T")
        d["mesh"] = {"mode": "design", "overrides": {"pad": "10"}}
        c, after, _ = self.fixed(d, "air-pad")
        self.assertEqual(c["fix"]["set"], {"mesh.overrides.pad": "51"})
        # no far field: an eighth is what the automatic padding gives
        d = blank_design("t", "T")
        d["mesh"]["pad"] = "5"
        d["far_field"] = {"enabled": False}
        c, _, _ = self.fixed(d, "air-pad")
        self.assertEqual(c["fix"]["label"], "Set the air padding to λ/8 (25.5 mm)")

    def test_air_padding_left_alone(self):
        for pad in ("0", "26", "51", "100"):
            d = blank_design("t", "T")
            d["mesh"]["pad"] = pad
            self.assertNotIn("air-pad", {x["code"] for x in lint(d)}, pad)
        d = blank_design("t", "T")
        d["mesh"]["pad"] = "1"
        d["simulation"]["boundaries"] = "PEC"   # nothing open to be near
        self.assertNotIn("air-pad", {x["code"] for x in lint(d)})
        d = blank_design("t", "T")
        self.assertNotIn("air-pad", {x["code"] for x in lint(d)})   # the automatic padding
        d["mesh"] = {"mode": "manual", "lines": {"x": [0, 1], "y": [0, 1], "z": [0, 1]}, "pad": "1"}
        self.assertNotIn("air-pad", {x["code"] for x in lint(d)})


class ChecksApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        (root / "models").mkdir()
        (root / "projects").mkdir()
        manager = JobManager(root / "jobs", root / "projects", command_factory=lambda job: [sys.executable, "-c", "pass"])
        cls.app = App(models_dir=root / "models", projects_dir=root / "projects", jobs_dir=root / "jobs",
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

    def test_preview_validate_and_save(self):
        st, body = self.request("POST", "/api/designs", {"id": "chk", "name": "Checks"})
        self.assertEqual(st, 201, body)
        self.assertEqual(body["validation"]["checks"], [])
        d, h = body["design"], body["hash"]

        # preview: checks with the bundle, including the server-only ones
        air = copy.deepcopy(d)
        air["ports"][0]["start"][2], air["ports"][0]["stop"][2] = "h + 2", "h + 4"
        st, pv = self.request("POST", "/api/preview", {"design": air})
        self.assertEqual(st, 200, pv)
        self.assertTrue(all(c["explain"] == EXPLANATIONS[c["code"]] for c in pv["checks"]))
        self.assertEqual(keys(pv["checks"]), ["info|mesh-fine-refinement|mesh",
                                              "warning|port-floating|ports[0].start", "warning|port-floating|ports[0].stop"])

        # a design that does not build: 422, and the checks all the same
        broken = copy.deepcopy(d)
        broken["parts"][2]["primitives"][0]["stop"][1] = "L/2 +"
        st, err = self.request("POST", "/api/preview", {"design": broken})
        self.assertEqual(st, 422)
        self.assertIn("error|expr|parts[2].primitives[0].stop[1]", keys(err["checks"]))

        # a work in progress saves, errors and all; they come back with the validation
        bad = copy.deepcopy(d)
        bad["parts"][2]["primitives"][0]["start"][0] = "W"
        st, saved = self.request("PUT", "/api/designs/chk", {"design": bad, "base_hash": h})
        self.assertEqual(st, 200, saved)
        self.assertIn("error|brick-inverted|parts[2].primitives[0].stop[0]", keys(saved["validation"]["checks"]))

        # ...but it is not run: 422 with the list
        st, err = self.request("POST", "/api/runs", {"model": "chk", "params": {}, "threads": 1})
        self.assertEqual(st, 422, err)
        self.assertIn("error|brick-inverted|parts[2].primitives[0].stop[0]", keys(err["checks"]))
        self.assertIn("parts[2].primitives[0].stop[0]", err["fields"])

        # warnings neither block the save nor the run
        st, saved = self.request("PUT", "/api/designs/chk", {"design": air, "base_hash": saved["hash"]})
        self.assertEqual(st, 200, saved)
        self.assertEqual(keys(saved["validation"]["checks"]),
                         ["info|mesh-fine-refinement|mesh",
                          "warning|port-floating|ports[0].start", "warning|port-floating|ports[0].stop"])
        st, job = self.request("POST", "/api/runs", {"model": "chk", "params": {}, "threads": 1})
        self.assertEqual(st, 201, job)

        # an unfinished design that does not build saves too
        st, saved = self.request("PUT", "/api/designs/chk", {"design": broken, "base_hash": saved["hash"]})
        self.assertEqual(st, 200, saved)

        # a new empty project: saves, but has nothing to run yet
        st, empty = self.request("POST", "/api/designs", {"id": "chk_empty", "name": "Empty", "template": "empty"})
        self.assertEqual(st, 201, empty)
        self.assertEqual(empty["design"]["parts"], [])
        st, err = self.request("POST", "/api/runs", {"model": "chk_empty", "params": {}, "threads": 1})
        self.assertEqual(st, 422, err)
        st, err = self.request("POST", "/api/designs", {"id": "chk_x", "template": "nope"})
        self.assertEqual(st, 422, err)

    def test_end_criterion_policy_blocks_the_run(self):
        # one policy (END_DB_MIN..END_DB_MAX) for the Solver field, checks.ts and this check: -5 dB
        # is refused and does not run, -10 / -40 / -60 / -300 run
        st, body = self.request("POST", "/api/designs", {"id": "endc", "name": "End criterion"})
        self.assertEqual(st, 201, body)
        d, h = body["design"], body["hash"]
        for end, runs in [(-5, False), (0, False), (-301, False), (-10, True), (-40, True), (-60, True), (-300, True)]:
            with self.subTest(end=end):
                d["simulation"]["end_criteria_db"] = end
                st, saved = self.request("PUT", "/api/designs/endc", {"design": d, "base_hash": h})
                self.assertEqual(st, 200, saved)
                h = saved["hash"]
                found = keys(saved["validation"]["checks"])
                self.assertEqual("error|end-criterion|simulation.end_criteria_db" in found, not runs, found)
                st, job = self.request("POST", "/api/runs", {"model": "endc", "params": {}, "threads": 1})
                self.assertEqual(st, 201 if runs else 422, job)
                if not runs:
                    self.assertIn("simulation.end_criteria_db", job["fields"])
        # the bounds are the ones a run request accepts (server.py _settings)
        self.assertEqual((END_DB_MIN, END_DB_MAX), (-300, -10))
        errs: dict = {}
        self.app._settings({"end_criteria_db": END_DB_MIN}, errs)
        self.assertEqual(errs, {})
        self.app._settings({"end_criteria_db": END_DB_MIN - 1}, errs)
        self.assertIn("end_criteria_db", errs)

def overlaid_arrays(copies=999, priorities=(10, 10, 10), shifts=(0, 0, 0)):
    """The hidden-part profile: equal copper arrays of sheet squares, one per part,
    each copy on top of the same copy of the others."""
    d = blank_design("lint", "Overlaid arrays")
    for i, (prio, dx) in enumerate(zip(priorities, shifts)):
        d["parts"].append({"name": f"array{i}", "material": "copper", "primitives": [
            {"kind": "box", "start": [dx, 0, 2], "stop": [dx + 1, 1, 2], "priority": prio}],
            "transforms": [{"type": "translate", "copies": str(copies), "step": ["4", "0", "0"]}]})
    return d


def hidden_by_full_scan(part, parts, bbox=prim_bbox, containers=None):
    """_Lint._hidden_by before the bounding-box index: every primitive of every other part asked."""
    import fairbeam.design_checks as dc

    for other in parts:
        if other is part:
            continue
        if all(any(q["priority"] >= p["priority"] and dc._inside(p, q, bbox) for q in other["prims"]) for p in part["prims"]):
            return other["name"]
    return None


def random_array_design(rng):
    """Parts of 30-60 mixed primitives on a coarse grid (so shapes coincide, touch and nest)."""
    d = blank_design("r", "Random arrays")
    for i in range(rng.randint(2, 4)):
        x, y, z = (rng.randint(-4, 4) * 0.5 for _ in range(3))
        w, h = rng.choice([0.5, 1, 2, 4]), rng.choice([0.5, 1, 2])
        prims = rng.sample([
            {"kind": "box", "start": [x, y, z], "stop": [x + w, y + h, z + rng.choice([0, 0, 0.5, 1])]},
            {"kind": "box", "start": [x - 0.5, y - 0.5, z - 0.5], "stop": [x + w + 0.5, y + h + 0.5, z + 1.5]},
            {"kind": "cylinder", "axis": "z", "center": [x + w / 2, y + h / 2], "range": [z, z + 1], "radius": max(w, h)},
            {"kind": "cylinder", "axis": "z", "center": [x, y], "range": [z, z + 1], "radius": 1, "inner_radius": 0.5},
            {"kind": "sphere", "center": [x, y, z], "radius": rng.choice([0.5, 2, 4])},
            {"kind": "polygon", "normal": "z", "elevation": z, "points": [[x, y], [x + w, y], [x, y + h]]},
            {"kind": "polygon", "normal": "z", "elevation": z, "points": [[x, y], [x + 2, y], [x + 1, y + 0.5], [x + 2, y + 2], [x, y + 2]]},
        ], rng.randint(1, 3))
        for pr in prims:
            pr["priority"] = rng.choice([0, 5, 10])
        steps = [rng.choice([0.5, 1, 2, 4]), rng.choice([0, 0.5, 2])]
        d["parts"].append({"name": f"p{i}", "material": rng.choice(["copper", "substrate"]), "primitives": prims,
                           "transforms": [{"type": "translate", "copies": rng.randint(10, 20), "step": [steps[0], 0, 0]},
                                          {"type": "translate", "copies": rng.randint(0, 1), "step": [0, steps[1], 0]}]})
    return d


class HiddenParts(unittest.TestCase):
    """part-hidden asks only the primitives whose bounding box can hold a primitive's (#105)."""

    def test_three_overlaid_1000_copy_arrays(self):
        import fairbeam.design_checks as dc

        inside, calls = dc._inside, []

        def counting(p, q, bbox=prim_bbox):
            calls.append(1)
            return inside(p, q, bbox)

        with mock.patch.object(dc, "_inside", counting):
            c = lint(overlaid_arrays(), {})
        self.assertEqual(keys(c), ["warning|part-hidden|parts[3]", "warning|part-hidden|parts[4]", "warning|part-hidden|parts[5]"])
        self.assertEqual([x["message"].split(",")[0] for x in c], [
            "'array0' lies completely inside 'array1'", "'array1' lies completely inside 'array0'",
            "'array2' lies completely inside 'array0'"])
        # each copy is tested against the copies at its place, not against the whole array (the full
        # scan made about 1.5 million containment tests here)
        self.assertLess(len(calls), 30000)

    def test_priorities_and_offsets_as_the_full_scan(self):
        for prio, shifts in (((5, 10, 10), (0, 0, 0)), ((10, 10, 10), (0, 0.5, 4)), ((10, 5, 0), (0, 0, 0)),
                             ((0, 0, 10), (0, 4, 8))):
            d = overlaid_arrays(99, prio, shifts)
            with mock.patch.object(_Lint, "_hidden_by", staticmethod(hidden_by_full_scan)):
                expect = lint(d, {})
            self.assertEqual(lint(d, {}), expect, (prio, shifts))
        # a lower priority part is hidden by, never hides, the higher ones
        self.assertEqual([x["message"].split(",")[0] for x in lint(overlaid_arrays(99, (5, 10, 10)), {})], [
            "'array0' lies completely inside 'array1'", "'array1' lies completely inside 'array2'",
            "'array2' lies completely inside 'array1'"])

    def test_message_names_solids_by_their_label(self):
        # a duplicated patch: the designer shows "Patch" and "Patch copy", never the internal "patch2"
        d = blank_design("dup", "Duplicate")
        patch = next(p for p in d["parts"] if p["name"] == "patch")
        d["parts"].append({**copy.deepcopy(patch), "name": "patch2", "label": "Patch copy"})
        hidden = [c for c in lint(d, {}) if c["code"] == "part-hidden"]
        self.assertEqual([c["message"].split(",")[0] for c in hidden],
                         ["'Patch' lies completely inside 'Patch copy'", "'Patch copy' lies completely inside 'Patch'"])
        # without a label the name is what the designer shows
        del d["parts"][-1]["label"]
        self.assertEqual([c["message"].split(",")[0] for c in lint(d, {}) if c["code"] == "part-hidden"],
                         ["'Patch' lies completely inside 'patch2'", "'patch2' lies completely inside 'Patch'"])

    def test_random_arrays_as_the_full_scan(self):
        rng = random.Random(105)
        hidden = 0
        for k in range(40):
            d = random_array_design(rng)
            with mock.patch.object(_Lint, "_hidden_by", staticmethod(hidden_by_full_scan)):
                expect = lint(d, {})
            self.assertEqual(lint(d, {}), expect, k)
            hidden += sum(1 for c in expect if c["code"] == "part-hidden")
        self.assertGreater(hidden, 5)   # the cases do exercise the check

    def test_index_candidates_hold_every_container(self):
        from fairbeam.design_checks import EPS, _BoxIndex

        rng = random.Random(7)
        for _ in range(20):
            boxes = []
            for _ in range(rng.randint(32, 120)):
                lo = [rng.randint(-20, 20) * 0.25 for _ in range(3)]
                size = [rng.choice([0, 0.25, 1, 3, 40]) for _ in range(3)]
                boxes.append({"kind": "box", "start": lo, "stop": [lo[k] + size[k] for k in range(3)], "priority": 0})
            index = _BoxIndex(boxes)
            self.assertIsNotNone(index.cells)
            for p in boxes + [{"kind": "box", "start": [0, 0, 0], "stop": [0.1, 0.1, 0], "priority": 0}]:
                plo, phi = prim_bbox(p)
                found = {id(q) for q in index.candidates(plo)}
                for q in boxes:
                    qlo, qhi = prim_bbox(q)
                    if not any(plo[k] < qlo[k] - EPS or phi[k] > qhi[k] + EPS for k in range(3)):
                        self.assertIn(id(q), found)


class PortAtConductorEnds(unittest.TestCase):
    """A lumped port whose ends sit on the end faces of the conductors it feeds is the normal way to draw a
    dipole: only metal across the port itself is a short (port-in-metal)."""

    @staticmethod
    def dipole(arm, gap=1.0, length=27.0, radius=0.5):
        d = blank_design("t", "T")
        d["parts"] = [{"name": "arms", "material": "copper", "primitives": [arm(s, gap, length, radius) for s in (1, -1)]}]
        d["materials"] = [{"name": "copper", "kind": "metal"}]
        d["ports"] = [{"type": "lumped", "number": 1, "R": 50, "start": [0, 0, -gap / 2], "stop": [0, 0, gap / 2], "direction": "z"}]
        return d

    @staticmethod
    def codes(d):
        return [c["code"] for c in lint(d) if c["code"] in ("port-in-metal", "port-floating")]

    def test_wire_dipole_starting_at_the_port_ends(self):
        def wire(s, gap, length, r):
            return {"kind": "wire", "points": [[0, 0, s * gap / 2], [0, 0, s * (gap / 2 + length)]], "radius": r}
        self.assertEqual(self.codes(self.dipole(wire)), [])
        self.assertEqual(self.codes(self.dipole(wire, radius=0.05)), [])

    def test_wire_with_a_radius_builds_as_flat_ended_cylinders(self):
        d = self.dipole(lambda s, gap, length, r: {"kind": "wire", "points": [[0, 0, s * gap / 2], [0, 0, s * (gap / 2 + length)],
                                                                             [s * 5, 0, s * (gap / 2 + length)]], "radius": r})
        kinds = sorted(p["kind"] for part in build_preview(None, {}, design=d)["bundle"]["parts"] for p in part["primitives"])
        self.assertEqual(kinds, ["cylinder"] * 4 + ["sphere"] * 2)   # two segments and a joint per arm, no wire primitive

    def test_strip_dipole_on_the_port_ends(self):
        def strip(s, gap, length, r):
            a, b = sorted((s * gap / 2, s * (gap / 2 + length)))
            return {"kind": "box", "start": [-1, -0.1, a], "stop": [1, 0.1, b]}
        self.assertEqual(self.codes(self.dipole(strip)), [])

    def test_probe_feed_between_ground_and_patch(self):
        self.assertNotIn("port-in-metal", {c["code"] for c in lint(pcb_design())})

    def test_wire_across_the_port_is_a_short(self):
        def through(s, gap, length, r):
            return {"kind": "wire", "points": [[0, 0, -length], [0, 0, length]], "radius": r}
        d = self.dipole(through)
        d["parts"][0]["primitives"] = d["parts"][0]["primitives"][:1]
        self.assertEqual(keys([c for c in lint(d) if c["code"] == "port-in-metal"]), ["error|port-in-metal|ports[0].start"])

    def test_wire_reaching_into_the_port_is_flagged(self):
        def reaching(s, gap, length, r):
            return {"kind": "wire", "points": [[0, 0, s * gap / 4], [0, 0, s * (gap / 2 + length)]], "radius": r}
        self.assertIn("port-in-metal", self.codes(self.dipole(reaching)))


if __name__ == "__main__":
    unittest.main()
