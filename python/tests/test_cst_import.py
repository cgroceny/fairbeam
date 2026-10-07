"""CST macro import (fairbeam.cst_import): round trips through fairbeam's own CST export and
hand-written CST history in the forms CST records.

Round trips compare the built geometry (the preview bundle of the imported design) with the
original bundle: the same parts and primitives within 1e-6 mm, the same ports, band, boundaries and
materials. The committed macros in examples/cst/ are compared with public/projects/; designs (the
templates, a design with every shape and transform, the converted examples) go through the real
exporter with node (scripts/cst-export.mjs), skipped when node is not installed.
"""

import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from fairbeam.cst_import import CstImportError, _Refuse, import_cst, read_macro, translate  # noqa: E402
from fairbeam.design import blank_design, build, evaluate, resolve_names  # noqa: E402
from fairbeam.design_checks import lint  # noqa: E402
from fairbeam.preview import build_preview  # noqa: E402

REPO = HERE.parents[1]
MACROS = REPO / "examples" / "cst"
PROJECTS = REPO / "public" / "projects"
MODELS = REPO / "python" / "models"
NODE = shutil.which("node")
TOL = 1e-6
EXPORTED = ("box", "polygon", "linpoly", "cylinder", "cylindricalshell", "sphere", "rotpoly", "wire", "curve", "polyhedron")


def safe(name: str) -> str:
    """The exporter's solid name of a part (src/export/cst.ts safe)."""
    return re.sub(r"^_+|_+$", "", re.sub(r"[^A-Za-z0-9_]+", "_", name)) or "part"


def _clean(points):
    out = []
    for p in points:
        if not out or any(abs(p[k] - out[-1][k]) > 1e-9 for k in range(2)):
            out.append(list(p))
    while len(out) > 1 and all(abs(out[0][k] - out[-1][k]) <= 1e-9 for k in range(2)):
        out.pop()
    return out


def _area(pts):
    return sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts))) / 2


def canonical(p):
    """A primitive in one form per solid: sheets and extrusions of rectangles as boxes, extrusions
    as (lo, hi) along the normal, cylinders sorted along their axis, cones / tori by profile."""
    kind = p["kind"]
    if kind == "box":
        lo = [min(a, b) for a, b in zip(p["start"], p["stop"])]
        hi = [max(a, b) for a, b in zip(p["start"], p["stop"])]
        return ("box", lo + hi)
    if kind in ("polygon", "linpoly"):
        n = p["normal"]
        pts = _clean(p["points"])
        e0 = p["elevation"]
        e1 = e0 + (p.get("length", 0.0) if kind == "linpoly" else 0.0)
        us = sorted({round(q[0], 9) for q in pts})
        vs = sorted({round(q[1], 9) for q in pts})
        if len(pts) == 4 and len(us) == 2 and len(vs) == 2:
            lo, hi = [0.0] * 3, [0.0] * 3
            lo[n], hi[n] = min(e0, e1), max(e0, e1)
            lo[(n + 1) % 3], hi[(n + 1) % 3] = us
            lo[(n + 2) % 3], hi[(n + 2) % 3] = vs
            return ("box", lo + hi)
        # start the ring at its smallest vertex, counter-clockwise
        if _area(pts) < 0:
            pts = pts[::-1]
        k = min(range(len(pts)), key=lambda i: (round(pts[i][0], 9), round(pts[i][1], 9)))
        pts = pts[k:] + pts[:k]
        return ("prism", [n, min(e0, e1), max(e0, e1)] + [x for q in pts for x in q])
    if kind in ("cylinder", "cylindricalshell"):
        a, b = p["start"], p["stop"]
        ax = max(range(3), key=lambda k: abs(b[k] - a[k]))
        lo, hi = (a, b) if a[ax] <= b[ax] else (b, a)
        if kind == "cylinder":
            outer, inner = p["radius"], 0.0
        else:
            outer, inner = p["radius"] + p["shell_width"] / 2, p["radius"] - p["shell_width"] / 2
        return ("cylinder", [ax] + lo + hi + [outer, inner])
    if kind == "sphere":
        return ("sphere", p["center"] + [p["radius"]])
    if kind == "rotpoly":
        pts = sorted((round(r, 5), round(h, 5)) for r, h in p["points"])
        return ("rotpoly", [p["axis"]] + p["origin"] + [x for q in pts for x in q])
    if kind in ("wire", "curve"):
        # a thin curve wire comes back as a design wire (of a small radius): the path is what must agree
        return ("wire", [x for q in p["points"] for x in q])
    if kind == "polyhedron":
        # an STL has one triangle per fan triangle and no vertex order: the vertex set and the triangle count
        verts = sorted({tuple(round(c, 6) + 0.0 for c in v) for v in p["vertices"]})
        return ("polyhedron", [sum(len(f) - 2 for f in p["faces"])] + [c for v in verts for c in v])
    return (kind, [])


def same_numbers(a, b, tol=TOL, relative=False):
    """Equal within ``tol`` (absolute: 1e-6 mm for coordinates), or relative to the magnitude."""
    return len(a) == len(b) and all(abs(x - y) <= (tol * max(1.0, abs(x), abs(y)) if relative else tol * (1 + 1e-9))
                                    for x, y in zip(a, b))


class RoundTrip(unittest.TestCase):
    """Helpers shared by the round-trip cases."""

    def assert_same_build(self, original: dict, imported: dict, label: str, skipped_parts=()):
        """The imported design's bundle against the original bundle."""
        want = []
        for part in original["parts"]:
            if part["type"] not in ("Metal", "Material", "ConductingSheet"):
                continue
            prims = [canonical(p) for p in part["primitives"] if p["kind"] in EXPORTED]
            prims = [p for p in prims if not (p[0] == "prism" and len(p[1]) < 9)]
            if prims and part["name"] not in skipped_parts:
                want.append((safe(part["name"]), part, prims))
        got = {p["name"]: p for p in imported["parts"]}
        self.assertEqual(sorted(n for n, _p, _q in want), sorted(got), f"{label}: parts")
        for name, part, prims in want:
            mine = got[name]
            self.assertEqual(part["type"] == "Material", mine["type"] == "Material", f"{label}: {name} kind")
            if part["type"] == "Material":
                a, b = part["material"], mine["material"]
                self.assertTrue(same_numbers([a["eps_r"]], [b["eps_r"]], 1e-9, relative=True), f"{label}: {name} eps_r")
                self.assertTrue(math.isclose(a["kappa"], b["kappa"], rel_tol=1e-6, abs_tol=1e-15), f"{label}: {name} kappa {a['kappa']} {b['kappa']}")
            theirs = [canonical(p) for p in mine["primitives"]]
            self.assertEqual(len(prims), len(theirs), f"{label}: {name} primitive count")
            for i, (x, y) in enumerate(zip(prims, theirs)):
                self.assertEqual(x[0], y[0], f"{label}: {name} primitive {i} kind")
                self.assertTrue(same_numbers(x[1], y[1]), f"{label}: {name} primitive {i}: {x} != {y}")
        # ports, band, boundaries
        self.assertEqual(len(original["ports"]), len(imported["ports"]) + sum(1 for p in original["ports"] if p.get("skip")),
                         f"{label}: ports")
        for a in original["ports"]:
            b = next(p for p in imported["ports"] if p["number"] == a["number"])
            self.assertEqual((a["type"], a["direction"], a.get("excite", True)), (b["type"], b["direction"], b.get("excite", True)),
                             f"{label}: port {a['number']}")
            self.assertTrue(same_numbers(a["start"] + a["stop"], b["start"] + b["stop"]), f"{label}: port {a['number']} box")
            if a["type"] == "lumped":
                self.assertAlmostEqual(a["R"], b["R"], places=9)
            else:
                self.assertEqual((a["mode"],), (b["mode"],))
                self.assertTrue(same_numbers([a["a"], a["b"]], [b["a"], b["b"]]))
        ea, eb = original["solver"]["excitation"], imported["solver"]["excitation"]
        self.assertTrue(same_numbers([ea["f_min"], ea["f_max"]], [eb["f_min"], eb["f_max"]], 1e-9, relative=True), f"{label}: band")
        self.assertEqual(original["solver"]["boundaries"], imported["solver"]["boundaries"], f"{label}: boundaries")
        la, lb = original.get("lumped_elements", []), imported.get("lumped_elements", [])
        self.assertEqual(len(la), len(lb), f"{label}: resistors")
        for a, b in zip(la, lb):
            self.assertAlmostEqual(a["R"], b["R"], places=9)
            self.assertTrue(same_numbers(a["start"] + a["stop"], b["start"] + b["stop"]), f"{label}: resistor box")

    def assert_runnable(self, design: dict, label: str):
        """No check errors, and every flat port / resistor face on a mesh line."""
        values = {p["key"]: p["default"] for p in design["params"] if "expr" not in p}
        bundle = build_preview(None, {}, design=design)["bundle"]
        errors = [c for c in lint(design, values, bundle) if c["severity"] == "error"]
        self.assertEqual(errors, [], f"{label}: check errors")
        sim = build(design, values)
        lines = [list(sim.mesh.GetLines(a)) for a in "xyz"]
        for group in (sim.ports, sim.lumped_elements):
            for p in group:
                for k in range(3):
                    for v in {p["start"][k], p["stop"][k]}:
                        if p.get("type") == "waveguide":
                            continue
                        near = min(abs(v - x) for x in lines[k])
                        self.assertLess(near, 1e-9, f"{label}: port {p.get('number', p.get('name'))} {'xyz'[k]} = {v} is "
                                        f"{near:g} mm off the nearest mesh line")
        return bundle


class ExportedExamples(RoundTrip):
    """examples/cst/*.bas (fairbeam's exports of public/projects/) import back to the same model."""

    def test_every_committed_macro_round_trips(self):
        macros = sorted(MACROS.glob("*.bas"))
        self.assertGreaterEqual(len(macros), 14)
        for macro in macros:
            with self.subTest(macro=macro.name):
                original = json.loads((PROJECTS / f"{macro.stem}.json").read_text(encoding="utf-8"))
                stls = {f.name: f.read_text(encoding="utf-8") for f in MACROS.glob(f"{macro.stem}_*.stl")}
                res = import_cst(macro.read_text(encoding="utf-8"), filename=macro.name, files=stls)
                design, report = res["design"], res["report"]
                self.assertEqual(report["refused"], 0, [n for n in report["notes"] if n["severity"] == "refused"])
                self.assertEqual(design["model"]["name"], original["name"].replace("·", "-"))  # the macro is ASCII
                bundle = build_preview(None, {}, design=design)["bundle"]
                # what the exporter could not write is named in the report (a curve, polyhedra, a waveguide port)
                skipped = {p["name"] for p in original["parts"] if not any(q["kind"] in EXPORTED for q in p["primitives"])}
                for name in skipped:
                    self.assertTrue(any(safe(name) in n["message"] or name in n["message"] for n in report["notes"]),
                                    f"{macro.name}: {name} is not mentioned in the report")
                self.assert_same_build(original, bundle, macro.stem, skipped)
                # the same openEMS mesh as the exported model (a Python model's own lines, or its restored
                # automatic settings), within the bundle's 1e-4 mm rounding: not a re-fitted mesh of another size
                if bundle["parts"]:
                    for a in "xyz":
                        self.assertTrue(same_numbers(original["mesh"][a], bundle["mesh"][a], 1e-4),
                                        f"{macro.stem}: mesh lines along {a} ({len(original['mesh'][a])} vs {len(bundle['mesh'][a])})")
                if bundle["parts"] and bundle["ports"]:
                    self.assert_runnable(design, macro.stem)


def _export_all(bundle: dict) -> tuple[str, dict]:
    """``(macro text, {name: text of each companion .stl file})`` of the real exporter."""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "bundle.json"
        path.write_text(json.dumps(bundle), encoding="utf-8")
        out_dir = Path(tmp) / "out"
        out = subprocess.run([NODE, "--no-warnings", "--experimental-strip-types", str(REPO / "scripts" / "cst-export.mjs"), str(path), str(out_dir)],
                             capture_output=True, check=True, cwd=REPO)
        files = {f.name: f.read_text(encoding="utf-8") for f in out_dir.glob("*.stl")}
    return out.stdout.decode("utf-8"), files


def _export(bundle: dict) -> str:
    return _export_all(bundle)[0]


def every_shape_design() -> dict:
    """A design with every exportable shape, transforms, a resistor and a waveguide port."""
    d = blank_design("shapes", "Every shape")
    d["materials"].append({"name": "ptfe", "kind": "dielectric", "eps_r": "2.1", "tan_d": "0.0002", "tan_d_freq": "10"})
    d["parts"] += [
        {"name": "post", "material": "copper", "primitives": [
            {"kind": "cylinder", "axis": "z", "center": ["feed", "0"], "radius": 0.65, "range": ["h", "h + 4"]}]},
        {"name": "tube", "material": "ptfe", "primitives": [
            {"kind": "cylinder", "axis": "x", "center": [5, 12], "radius": 1.5, "inner_radius": 0.75, "range": [-25, -20]}]},
        {"name": "ball", "material": "copper", "primitives": [{"kind": "sphere", "center": [20, 20, 8], "radius": 2}]},
        {"name": "cone", "material": "copper", "primitives": [
            {"kind": "cone", "axis": "y", "center": [6, -20], "bottom_radius": 3, "top_radius": 1, "range": [22, 26]}]},
        {"name": "ring", "material": "copper", "primitives": [
            {"kind": "torus", "axis": "z", "center": [-20, 20, 6], "major_radius": 3, "minor_radius": 0.5}]},
        {"name": "tri", "material": "copper", "primitives": [
            {"kind": "polygon", "normal": "z", "elevation": "h", "points": [[20, -25], [26, -25], [23, -20]]},
            {"kind": "linpoly", "normal": "x", "elevation": 27, "length": -2, "points": [[-5, 2], [5, 2], [0, 7]]},
            {"kind": "linpoly", "normal": "y", "elevation": -28, "length": 1.5, "points": [[2, -25], [4, -25], [4, -22], [2, -22]]}]},
        {"name": "array", "material": "copper", "primitives": [
            {"kind": "box", "start": [-26, 24, "h"], "stop": [-24, 26, "h"]}],
         "transforms": [{"type": "translate", "copies": 2, "step": [4, 0, 0]}, {"type": "mirror", "plane": "y", "keep": True}]},
    ]
    d["resistors"] = [{"name": "load", "R": "75", "start": [10, -1, 0], "stop": [10, 1, 0], "direction": "y"}]
    return d


def waveguide_design() -> dict:
    return {"schema": "fairbeam.design/1", "model": {"id": "wg", "name": "Waveguide section"},
            "params": [], "simulation": {"f_min": 8, "f_max": 12, "boundaries": "PEC"},
            "materials": [{"name": "pec", "kind": "metal"}],
            "parts": [{"name": "walls", "material": "pec", "primitives": [
                {"kind": "box", "start": [-12.43, -6.08, 0], "stop": [12.43, -5.08, 60]},
                {"kind": "box", "start": [-12.43, 5.08, 0], "stop": [12.43, 6.08, 60]},
                {"kind": "box", "start": [-12.43, -5.08, 0], "stop": [-11.43, 5.08, 60]},
                {"kind": "box", "start": [11.43, -5.08, 0], "stop": [12.43, 5.08, 60]}]}],
            "ports": [{"type": "waveguide", "number": 1, "mode": "TE10", "a": 22.86, "b": 10.16,
                       "start": [-11.43, -5.08, 2], "stop": [11.43, 5.08, 4], "direction": "z"},
                      {"type": "waveguide", "number": 2, "mode": "TE10", "a": 22.86, "b": 10.16,
                       "start": [-11.43, -5.08, 58], "stop": [11.43, 5.08, 56], "direction": "z", "excite": False}],
            "resistors": [], "mesh": {"mode": "auto", "cells_per_wavelength": 12}, "far_field": {"enabled": False}}


@unittest.skipUnless(NODE, "node is needed for the exporter (scripts/cst-export.mjs)")
class ExportedDesigns(RoundTrip):
    """design -> bundle -> src/export/cst.ts -> import -> the same bundle."""

    def round_trip(self, design: dict, label: str):
        original = build_preview(None, {}, design=design)["bundle"]
        macro, stls = _export_all(original)
        res = import_cst(macro, filename=f"{label}.bas", files=stls)
        self.assertEqual(res["report"]["refused"], 0, [n for n in res["report"]["notes"] if n["severity"] == "refused"])
        imported = build_preview(None, {}, design=res["design"])["bundle"]
        self.assert_same_build(original, imported, label)
        # the fairbeam data restores the automatic mesh and the far-field box: the same openEMS model
        self.assertEqual(bool(original.get("nf2ff_box")), bool(imported.get("nf2ff_box")), f"{label}: far field")
        if (original.get("mesh") or {}).get("auto") and not design.get("mesh", {}).get("mode") == "design":
            for a in "xyz":
                self.assertTrue(same_numbers(original["mesh"][a], imported["mesh"][a]), f"{label}: mesh lines along {a}")
        return res

    def test_templates(self):
        from fairbeam.design import template_design
        res = self.round_trip(template_design("patch", "patch", "Patch"), "patch-template")
        self.assert_runnable(res["design"], "patch-template")
        empty = import_cst(_export(build_preview(None, {}, design={**template_design("empty", "e", "Empty"), "parts": [
            {"name": "p", "material": "copper", "primitives": [{"kind": "box", "start": [0, 0, 0], "stop": [1, 1, 1]}]}]})["bundle"]))
        self.assertEqual(len(empty["design"]["parts"]), 1)

    def test_every_shape_and_transform(self):
        res = self.round_trip(every_shape_design(), "every-shape")
        kinds = {p["kind"] for pt in res["design"]["parts"] for p in pt["primitives"]}
        self.assertEqual(kinds, {"box", "cylinder", "sphere", "cone", "torus", "polygon", "linpoly"})
        tube = next(p for p in res["design"]["parts"] if p["name"] == "tube")["primitives"][0]
        self.assertEqual((tube["radius"], tube["inner_radius"]), (1.5, 0.75))
        self.assertEqual(res["design"]["resistors"][0]["name"], "load")

    def test_polyhedron_and_its_transforms_round_trip_through_stl(self):
        """A polyhedron, a mirrored copy and a rotated copy come back from the .stl files as the same solids."""
        cube = {"kind": "polyhedron",
                "vertices": [[1, 2, 3], [3, 2, 3], [3, 4, 3], [1, 4, 3], [1, 2, 7], [3, 2, 7], [3, 4, 7], [1, 4, 7]],
                "faces": [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]}
        d = blank_design("poly", "Poly")
        d["parts"].append({"name": "block", "material": "copper", "primitives": [cube],
                           "transforms": [{"type": "mirror", "plane": "y", "keep": True},
                                          {"type": "rotate", "axis": "z", "center": [0, 0, 0], "angle": 90, "copies": 1}]})
        original = build_preview(None, {}, design=d)["bundle"]
        macro, stls = _export_all(original)
        self.assertEqual(len(stls), 4, sorted(stls))          # the block, its mirror image, and the rotated pair
        self.assertNotIn("skipped", macro)
        for name, text in stls.items():                      # every file: closed, outward (positive volume), 12 triangles
            v = [[float(c) for c in m.groups()] for m in re.finditer(r"vertex (\S+) (\S+) (\S+)", text)]
            self.assertEqual(len(v), 36, name)
            vol = sum(sum(a[i] * (b[(i + 1) % 3] * c[(i + 2) % 3] - b[(i + 2) % 3] * c[(i + 1) % 3]) for i in range(3)) / 6
                      for a, b, c in zip(v[0::3], v[1::3], v[2::3]))
            self.assertAlmostEqual(vol, 2 * 2 * 4, places=6, msg=name)
        res = import_cst(macro, filename="poly.bas", files=stls)
        self.assertEqual(res["report"]["refused"], 0, res["report"]["notes"])
        got = sorted(tuple(sorted(tuple(v) for v in p["vertices"])) for pt in res["design"]["parts"] for p in pt["primitives"]
                     if p["kind"] == "polyhedron")
        want = []
        for part in original["parts"]:
            for pr in part["primitives"]:
                M = pr["matrix"] if pr["kind"] == "transformed" else [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
                src = pr["primitive"] if pr["kind"] == "transformed" else pr
                if src["kind"] == "polyhedron":
                    want.append(tuple(sorted(tuple(round(sum(M[i][j] * v[j] for j in range(3)) + M[i][3], 6) + 0.0 for i in range(3))
                                             for v in src["vertices"])))
        self.assertEqual(len(want), 4)
        self.assertEqual(len(got), 4)
        for a, b in zip(sorted(want), got):
            self.assertTrue(same_numbers([c for v in a for c in v], [c for v in b for c in v]), f"{a} != {b}")

    def test_rotations_wire_rlc_and_circle(self):
        """Arbitrary-angle Transform blocks, a solid wire, a circle sheet and R / L / C elements round trip."""
        n = 64
        d = blank_design("rot", "Rotations")
        d["parts"] += [
            {"name": "brick30", "material": "copper", "primitives": [{"kind": "box", "start": [3, -1, 1], "stop": [13, 1, 3]}],
             "transforms": [{"type": "rotate", "axis": "z", "center": [0, 0, 0], "angle": 30, "copies": 0}]},
            {"name": "cyl20", "material": "copper", "primitives": [
                {"kind": "cylinder", "axis": "z", "center": [8, 0], "radius": 1, "range": [1, 4]}],
             "transforms": [{"type": "rotate", "axis": "y", "center": [0, 0, 0], "angle": -20, "copies": 2}]},
            {"name": "disk", "material": "copper", "primitives": [{"kind": "polygon", "normal": "z", "elevation": 2, "points": [
                [3 * math.cos(2 * math.pi * k / n) + 10, 3 * math.sin(2 * math.pi * k / n)] for k in range(n)]}]},
            {"name": "tri", "material": "copper", "primitives": [
                {"kind": "linpoly", "normal": "x", "elevation": 5, "length": 1, "points": [[0, 0], [3, 0], [0, 4]]}],
             "transforms": [{"type": "rotate", "axis": "x", "center": [0, 0, 0], "angle": 45, "copies": 0},
                            {"type": "mirror", "plane": "y", "keep": True}]},
            {"name": "coil", "material": "copper", "primitives": [
                {"kind": "wire", "points": [[0, 0, 5], [0, 3, 8], [3, 3, 9]], "radius": 0.3}]},
        ]
        d["resistors"] = [
            {"name": "rlc1", "R": "10", "L": "2e-9", "C": "1e-12", "topology": "series", "start": [10, -1, 0], "stop": [10, 1, 0], "direction": "y"},
            {"name": "par", "R": "50", "L": "5e-9", "topology": "parallel", "start": [12, -1, 0], "stop": [12, 1, 0], "direction": "y"},
            {"name": "cc", "C": "1e-12", "start": [14, -1, 0], "stop": [14, 1, 0], "direction": "y"},
            {"name": "ll", "L": "3e-9", "start": [16, -1, 0], "stop": [16, 1, 0], "direction": "y"}]
        original = build_preview(None, {}, design=d)["bundle"]
        res = import_cst(_export(original), filename="rot.bas")
        self.assertEqual(res["report"]["refused"], 0, [x for x in res["report"]["notes"] if x["severity"] == "refused"])
        imported = build_preview(None, {}, design=res["design"])["bundle"]
        # the exporter writes each primitive of a part as its own solid (name, name_2, ...)
        base = lambda b: {re.sub(r"_\d+$", "", p["name"]) for p in b["parts"]}  # noqa: E731
        self.assertEqual(base(original), base(imported))

        def transformed(bundle):
            out = []
            for part in bundle["parts"]:
                for p in part["primitives"]:
                    if p["kind"] == "transformed":
                        out.append((round(sum(abs(x) for row in p["matrix"] for x in row), 6),
                                    [round(x, 9) for row in p["matrix"] for x in row], p["primitive"]["kind"]))
            return sorted(out)
        want, got = transformed(original), transformed(imported)
        self.assertEqual(len(want), 5)
        self.assertEqual([w[2] for w in want], [g[2] for g in got])
        for a, b in zip(want, got):
            self.assertTrue(same_numbers(a[1], b[1], 1e-9), (a, b))
        # R, L, C and the connection come back exactly (SI values), including the single-branch elements
        self.assertEqual(imported["lumped_elements"], original["lumped_elements"])
        coil = next(p for pt in res["design"]["parts"] if pt["name"] == "coil" for p in pt["primitives"])
        self.assertEqual((coil["kind"], coil["radius"], len(coil["points"])), ("wire", 0.3, 3))
        self.assert_runnable(res["design"], "rot")

    def test_waveguide_ports(self):
        res = self.round_trip(waveguide_design(), "waveguide")
        self.assertEqual([p["type"] for p in res["design"]["ports"]], ["waveguide", "waveguide"])
        self.assertIs(res["design"]["ports"][1]["excite"], False)
        self.assert_runnable(res["design"], "waveguide")

    def test_converted_examples(self):
        from fairbeam.example_design import ExampleConversionError, convert_example

        done = 0
        for source in sorted(MODELS.glob("*.py")):
            with self.subTest(model=source.stem):
                try:
                    design = convert_example(source, source.stem, source.stem)
                except ExampleConversionError:
                    continue  # the Python example itself has no design form (helix, horn)
                res = self.round_trip(design, source.stem)
                # the example's own (manual) mesh lines come back as manual lines, not a re-fitted automatic mesh
                self.assertEqual(res["design"]["mesh"].get("mode"), design["mesh"].get("mode"), f"{source.stem}: mesh mode")
                self.assert_runnable(res["design"], source.stem)
                done += 1
        self.assertGreaterEqual(done, 10)


# ---------------------------------------------------------------------------- History List macro

CST_HISTORY = r"""'# MWS Version: Version 2023.0 - Sep 01 2022 - ACIS 32.0.1 -

'@ use template: Antenna - Planar_1.cfg

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
MakeSureParameterExists "fc", "2.45"
MakeSureParameterExists "W", "Sqr(2) * 20"
MakeSureParameterExists "L", "W - 8"
MakeSureParameterExists "h", "1.6"
MakeSureParameterExists "gap", "0.5^2 * 4"
StoreParameterWithDescription "Wg", "2 * W", "ground width"
MakeSureParameterExists "n", "3"

'@ define units

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
With Units
    .SetUnit "Length", "mm"
    .SetUnit "Frequency", "GHz"
    .SetUnit "Time", "ns"
    .SetUnit "Temperature", "degC"
End With

'@ define frequency range

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
Solver.FrequencyRange "fc - 1", "fc + 1"

'@ define boundaries

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
With Boundary
     .Xmin "expanded open"
     .Xmax "expanded open"
     .Ymin "expanded open"
     .Ymax "expanded open"
     .Zmin "electric"
     .Zmax "expanded open"
     .Xsymmetry "none"
     .Ysymmetry "none"
     .Zsymmetry "none"
     .ApplyInAllDirections "False"
     .OpenAddSpaceFactor "0.5"
End With

'@ define material: FR-4 (lossy)

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
With Material
     .Reset
     .Name "FR-4 (lossy)"
     .Folder ""
     .FrqType "all"
     .Type "Normal"
     .SetMaterialUnit "GHz", "mm"
     .Epsilon "4.3"
     .Mu "1.0"
     .Kappa "0.0"
     .TanD "0.025"
     .TanDFreq "10.0"
     .TanDGiven "True"
     .TanDModel "ConstTanD"
     .Rho "0.0"
     .ThermalType "Normal"
     .ThermalConductivity "0.3"
     .Colour "0.94", "0.82", "0.76"
     .Create
End With

'@ define material: Copper (annealed)

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
With Material
     .Reset
     .Name "Copper (annealed)"
     .Folder ""
     .FrqType "static"
     .Type "Normal"
     .SetMaterialUnit "Hz", "mm"
     .Epsilon "1"
     .Mu "1.0"
     .Kappa "5.8e+007"
     .Create
End With
With Material
     .Reset
     .Name "Copper (annealed)"
     .Folder ""
     .FrqType "hf"
     .Type "Lossy metal"
     .SetMaterialUnit "GHz", "mm"
     .Mu "1.0"
     .Kappa "5.8e+007"
     .Rho "8930.0"
     .Colour "1", "1", "0"
     .Create
End With

'@ define material: Copper (lossy metal)

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
With Material
     .Reset
     .Name "Copper"
     .Folder "Metals"
     .Type "Lossy metal"
     .Mu "1.0"
     .Sigma "5.8e+007"
     .Create
End With

'@ define brick: component1:substrate

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
With Brick
     .Reset
     .Name "substrate"
     .Component "component1"
     .Material "FR-4 (lossy)"
     .Xrange "-Wg/2", "Wg/2"
     .Yrange "-Wg/2", "Wg/2"
     .Zrange "0", "h"
     .Create
End With

'@ define brick: component1:ground

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
With Brick
     .Reset
     .Name "ground"
     .Component "component1"
     .Material "PEC"
     .Xrange "-Wg/2", "Wg/2"
     .Yrange "-Wg/2", "Wg/2"
     .Zrange "0", "0"
     .Create
End With

'@ define brick: component1:solid1

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
With Brick
     .Reset
     .Name "solid1"
     .Component "component1"
     .Material "Metals/Copper"
     .Xrange "-W/2", "W/2"
     .Yrange "-L/2", "L/2"
     .Zrange "h", "h"
     .Create
End With

'@ define brick: component1:slot

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
With Brick
     .Reset
     .Name "slot"
     .Component "component1"
     .Material "PEC"
     .Xrange "-gap/2", "gap/2"
     .Yrange "-L/4", "L/4"
     .Zrange "h", "h"
     .Create
End With

'@ boolean subtract shapes: component1:solid1, component1:slot

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
Solid.Subtract "component1:solid1", "component1:slot"

'@ define cylinder: feed:pin

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
Component.New "feed"
With Cylinder
     .Reset
     .Name "pin"
     .Component "feed"
     .Material "PEC"
     .OuterRadius "0.635"
     .InnerRadius "0.0"
     .Axis "z"
     .Zrange "h", "h + 3"
     .Xcenter "-W/4"
     .Ycenter "0"
     .Segments "0"
     .Create
End With

'@ define brick: component1:stub

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
With Brick
     .Reset
     .Name "stub"
     .Component "component1"
     .Material "PEC"
     .Xrange "W/2 + 2", "W/2 + 3"
     .Yrange "-1", "1"
     .Zrange "h", "h"
     .Create
End With

'@ transform: translate component1:stub

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
With Transform
     .Reset
     .Name "component1:stub"
     .Vector "2", "0", "0"
     .UsePickedPoints "False"
     .InvertPickedPoints "False"
     .MultipleObjects "True"
     .GroupObjects "True"
     .Repetitions "n - 1"
     .MultipleSelection "False"
     .Destination ""
     .Material ""
     .AutoDestination "True"
     .Transform "Shape", "Translate"
End With

'@ transform: rotate component1:stub

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
With Transform
     .Reset
     .Name "component1:stub"
     .Origin "Free"
     .Center "0", "0", "h"
     .Angle "0", "0", "180"
     .MultipleObjects "True"
     .GroupObjects "True"
     .Repetitions "1"
     .MultipleSelection "False"
     .Transform "Shape", "Rotate"
End With

'@ define discrete port: 1

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
With DiscretePort
     .Reset
     .PortNumber "1"
     .Type "SParameter"
     .Label ""
     .Folder ""
     .Impedance "50.0"
     .Voltage "1.0"
     .Current "1.0"
     .Monitor "True"
     .Radius "0.0"
     .SetP1 "False", "-W/4", "0", "0"
     .SetP2 "False", "-W/4", "0", "h"
     .InvertDirection "False"
     .LocalCoordinates "False"
     .Wire ""
     .Position "end1"
     .Create
End With

'@ define monitor: farfield (f=fc)

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
With Monitor
     .Reset
     .Name "farfield (f=fc)"
     .Domain "Frequency"
     .FieldType "Farfield"
     .MonitorValue "fc"
     .ExportFarfieldSource "False"
     .UseSubvolume "False"
     .Create
End With

'@ define time domain solver parameters

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
Mesh.SetCreator "High Frequency"

With Solver
     .Method "Hexahedral"
     .CalculationType "TD-S"
     .StimulationPort "All"
     .StimulationMode "All"
     .SteadyStateLimit "-40"
     .MeshAdaption "False"
     .AutoNormImpedance "False"
     .NormingImpedance "50"
End With

'@ set mesh properties (Hexahedral)

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
With Mesh
     .MeshType "PBA"
     .SetCreator "High Frequency"
End With
With MeshSettings
     .SetMeshType "Hex"
     .Set "Version", 1%
     .Set "StepsPerWaveNear", "15"
     .Set "StepsPerWaveFar", "15"
     .Set "StepsPerBoxNear", "20"
End With

'@ pick edge

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
Pick.PickEdgeFromId "component1:substrate", "1", "1"

'@ define wedge

'[VERSION]2023.0|32.0.1|20220901[/VERSION]
With Wedge
     .Reset
     .Name "w1"
     .Component "component1"
     .Material "PEC"
     .Create
End With
"""


class CstHistory(unittest.TestCase):
    """A history list in the form CST records it (the History List's text, '@ titles)."""

    @classmethod
    def setUpClass(cls):
        cls.res = import_cst(CST_HISTORY, filename="planar.txt")
        cls.d = cls.res["design"]
        cls.notes = cls.res["report"]["notes"]

    def part(self, name):
        return next(p for p in self.d["parts"] if p["name"] == name)

    def test_parameters_keep_their_expressions(self):
        params = {p["key"]: p for p in self.d["params"]}
        self.assertEqual(params["fc"]["default"], 2.45)
        self.assertEqual(params["h"]["default"], 1.6)
        self.assertEqual(params["W"]["default"], math.sqrt(2) * 20)   # constant expression: evaluated
        self.assertEqual(params["L"]["expr"], "W - 8")
        self.assertEqual(params["Wg"]["expr"], "2 * W")
        self.assertEqual(params["Wg"]["description"], "ground width")
        self.assertEqual(params["gap"]["default"], 1.0)             # 0.5^2 * 4
        keys = [p["key"] for p in self.d["params"]]
        self.assertLess(keys.index("W"), keys.index("L"))          # derived after what they use
        self.assertLess(keys.index("L"), keys.index("Wg") if "Wg" in keys else 99)

    def test_geometry(self):
        sub = self.part("substrate")
        self.assertEqual(sub["component"], "component1")
        self.assertEqual(sub["primitives"][0], {"kind": "box", "start": ["-Wg / 2", "-Wg / 2", 0.0], "stop": ["Wg / 2", "Wg / 2", "h"]})
        pin = self.part("pin")["primitives"][0]
        self.assertEqual(pin, {"kind": "cylinder", "axis": "z", "center": ["-W / 4", 0.0], "radius": 0.635, "range": ["h", "h + 3"]})
        self.assertEqual(self.part("pin")["component"], "feed")

    def test_boolean_subtract_is_a_live_boolean(self):
        patch = self.part("solid1")
        h = patch["booleanHistory"]
        self.assertEqual((h["operation"], h["A"]["name"], h["B"]["name"], h["live"]), ("subtract", "solid1", "slot", True))
        self.assertEqual(len(patch["primitives"]), 2)   # the sheet around the slot, as few pieces as stay exact
        self.assertNotIn("slot", [p["name"] for p in self.d["parts"]])

    def test_transforms(self):
        stub = self.part("stub")
        self.assertEqual(stub["transforms"], [
            {"type": "translate", "copies": "n - 1", "step": [2.0, 0.0, 0.0]},
            {"type": "rotate", "axis": "z", "center": [0.0, 0.0, "h"], "angle": 180.0, "copies": 1.0}])

    def test_materials(self):
        mats = {m["name"]: m for m in self.d["materials"]}
        self.assertEqual(mats["FR-4 (lossy)"], {"name": "FR-4 (lossy)", "kind": "dielectric", "eps_r": 4.3, "tan_d": 0.025,
                                                 "tan_d_freq": 10.0, "color": "#f0d1c2"})
        self.assertEqual(mats["Metals/Copper"]["kind"], "metal")
        self.assertEqual(mats["PEC"]["kind"], "metal")
        # The CST library copper: a static definition (ignored) and the high-frequency lossy metal
        # its conductivity (.Kappa here, .Sigma in newer macros) makes it a lossy metal, not PEC
        self.assertEqual(mats["Copper (annealed)"], {"name": "Copper (annealed)", "kind": "metal", "conductivity": 5.8e7,
                                                     "color": "#ffff00"})
        self.assertEqual(mats["Metals/Copper"]["conductivity"], 5.8e7)
        self.assertFalse(any("perfect conductor" in n["message"] and "Copper (annealed)" in n["message"] for n in self.notes))

    def test_ports_band_monitors_mesh(self):
        self.assertEqual(self.d["ports"], [{"type": "lumped", "number": 1, "R": 50.0, "start": ["-W / 4", 0.0, 0.0],
                                            "stop": ["-W / 4", 0.0, "h"], "direction": "z"}])
        self.assertEqual(self.d["simulation"]["f_min"], "fc - 1")
        self.assertEqual(self.d["simulation"]["f_max"], "fc + 1")
        self.assertEqual(self.d["simulation"]["boundaries"], ["MUR", "MUR", "MUR", "MUR", "PEC", "MUR"])
        self.assertEqual(self.d["simulation"]["end_criteria_db"], -40)
        self.assertEqual(self.d["far_field"], {"enabled": True, "frequencies": ["fc"]})
        self.assertEqual(self.d["mesh"]["cells_per_wavelength"], 15)

    def test_unsupported_items_are_reported(self):
        refused = [n for n in self.notes if n["severity"] == "refused"]
        text = " ".join(n["message"] for n in refused)
        self.assertIn("Wedge", text)
        self.assertNotIn("Pick.PickEdgeFromId", text)   # a selection, not a model item: a note
        self.assertTrue(any("Pick.PickEdgeFromId" in n["message"] and n["severity"] == "info" for n in self.notes))
        self.assertTrue(all(n["where"] and n["line"] for n in refused), refused)
        self.assertTrue(any("Temperature" in n["message"] or "StepsPerBoxNear" in n["message"] for n in self.notes))

    def test_builds_without_check_errors(self):
        values = {p["key"]: p["default"] for p in self.d["params"] if "expr" not in p}
        bundle = build_preview(None, {}, design=self.d)["bundle"]
        errors = [c for c in lint(self.d, values, bundle) if c["severity"] == "error"]
        self.assertEqual(errors, [])
        # the parameters drive the geometry: a wider patch widens the substrate (Wg = 2 W)
        names = resolve_names(self.d, {**values, "W": 30.0})
        self.assertEqual(evaluate(self.part("substrate")["primitives"][0]["stop"][0], names), 30.0)


VBA_MACRO = r'''' A macro in the form the CST macro recorder writes
Option Explicit
Sub Main ()
    Dim sCommand As String
    StoreParameter "r", "3"
    StoreParameter "arm", "4*r"
    sCommand = ""
    sCommand = sCommand & "With Units" & vbCrLf
    sCommand = sCommand & "     .Geometry ""cm""" & vbCrLf
    sCommand = sCommand & "     .Frequency ""MHz""" & vbCrLf
    sCommand = sCommand & "End With"
    AddToHistory "define units", sCommand
    AddToHistory "define frequency range", "Solver.FrequencyRange ""800"", ""1200"""
    sCommand = "WCS.ActivateWCS ""local""" + vbLf + "WCS.SetNormal ""1"", ""0"", ""0""" + vbLf + _
               "WCS.SetOrigin ""1"", ""0"", ""0""" + vbLf + "WCS.SetUVector ""0"", ""1"", ""0"""
    AddToHistory "align wcs", sCommand
    sCommand = ""
    sCommand = sCommand + "Curve.NewCurve ""curve1""" + vbLf
    sCommand = sCommand + "With Polygon" + vbLf
    sCommand = sCommand + " .Reset" + vbLf
    sCommand = sCommand + " .Name ""tri""" + vbLf
    sCommand = sCommand + " .Curve ""curve1""" + vbLf
    sCommand = sCommand + " .Point ""0"", ""0""" + vbLf
    sCommand = sCommand + " .LineTo ""arm"", ""0""" + vbLf
    sCommand = sCommand + " .RLine ""-r"", ""r""" + vbLf
    sCommand = sCommand + " .LineTo ""0"", ""0""" + vbLf
    sCommand = sCommand + " .Create" + vbLf
    sCommand = sCommand + "End With" + vbLf
    sCommand = sCommand + "With ExtrudeCurve" + vbLf
    sCommand = sCommand + " .Reset" + vbLf
    sCommand = sCommand + " .Name ""prism""" + vbLf
    sCommand = sCommand + " .Component ""c1""" + vbLf
    sCommand = sCommand + " .Material ""PEC""" + vbLf
    sCommand = sCommand + " .Thickness ""0.5""" + vbLf
    sCommand = sCommand + " .Curve ""curve1:tri""" + vbLf
    sCommand = sCommand + " .Create" + vbLf
    sCommand = sCommand + "End With" + vbLf
    sCommand = sCommand + "WCS.ActivateWCS ""global"""
    AddToHistory "define extrudeprofile: c1:prism", sCommand
    With Sphere
        .Reset
        .Name "ball"
        .Component "c1"
        .Material "PEC"
        .Axis "z"
        .CenterRadius "r/3"
        .TopRadius "0"
        .BottomRadius "0"
        .Center "0", "0", "5"
        .Create
    End With
    With Transform
        .Reset
        .Name "c1:ball"
        .Origin "Free"
        .Center "0", "0", "0"
        .Angle "0", "45", "0"
        .MultipleObjects "False"
        .Transform "Shape", "Rotate"
    End With
    Dim i As Integer
    For i = 1 To 3
    Next i
End Sub
'''


class VbaMacro(unittest.TestCase):
    def test_strings_units_wcs_and_refusals(self):
        res = import_cst(VBA_MACRO, filename="recorded.bas")
        d, notes = res["design"], res["report"]["notes"]
        # cm -> mm, MHz -> GHz; parameters keep CST values and are scaled where used
        self.assertEqual(d["simulation"]["f_min"], 0.8)
        self.assertEqual(d["simulation"]["f_max"], 1.2)
        prism = next(p for p in d["parts"] if p["name"] == "prism")["primitives"][0]
        # the local plane x = 1 cm with u = y: an extrusion along +x from x = 10 mm, 5 mm thick
        self.assertEqual((prism["kind"], prism["normal"], prism["elevation"], prism["length"]), ("linpoly", "x", 10.0, 5.0))
        self.assertEqual(prism["points"], [[0.0, 0.0], ["arm * 10", 0.0], ["arm * 10 - r * 10", "r * 10"]])
        ball = next(p for p in d["parts"] if p["name"] == "ball")
        self.assertEqual(ball["primitives"][0]["radius"], "r / 3 * 10")
        # a 45 degree rotation is a design rotation now (it used to be refused)
        self.assertEqual(ball["transforms"], [{"type": "rotate", "axis": "y", "center": [0.0, 0.0, 0.0], "angle": 45.0, "copies": 0.0}])
        text = " ".join(n["message"] for n in notes)
        self.assertNotIn("multiples of 90", text)
        self.assertIn("control flow", text)
        self.assertIn("cm", text)

    def test_not_a_macro(self):
        with self.assertRaises(CstImportError):
            import_cst("hello world\n1, 2, 3\n")
        with self.assertRaises(CstImportError):
            import_cst("' only a comment\n")


def _with(obj, *props):
    return [f"With {obj}", " .Reset", *[f" .{p}" for p in props], " .Create", "End With"]


def _brick(name, x, y, z, comp="c", mat="PEC"):
    return _with("Brick", f'Name "{name}"', f'Component "{comp}"', f'Material "{mat}"',
                 f'Xrange "{x[0]}", "{x[1]}"', f'Yrange "{y[0]}", "{y[1]}"', f'Zrange "{z[0]}", "{z[1]}"')


class MoreCommands(unittest.TestCase):
    def imp(self, lines):
        res = import_cst("\n".join(lines), filename="t.txt")
        return res["design"], res["report"]["notes"]

    def part(self, d, name):
        return next(p for p in d["parts"] if p["name"] == name)

    def test_wcs_rotation_and_move(self):
        d, notes = self.imp([
            'WCS.ActivateWCS "local"', 'WCS.MoveWCS "local", "0", "0", "5"', 'WCS.RotateWCS "u", "90"',
            *_brick("b", (0, 2), (0, 3), (0, 1)),
            'WCS.ActivateWCS "global"', *_brick("g", (0, 1), (0, 1), (0, 1))])
        # rotating about u by 90 degrees: v -> +z, w -> -y
        b = self.part(d, "b")["primitives"][0]
        self.assertEqual((b["start"], b["stop"]), ([0.0, -1.0, 5.0], [2.0, 0.0, 8.0]))
        self.assertEqual(self.part(d, "g")["primitives"][0]["start"], [0.0, 0.0, 0.0])
        d, notes = self.imp(['WCS.ActivateWCS "local"', 'WCS.RotateWCS "w", "30"', *_brick("b", (0, 1), (0, 1), (0, 1))])
        self.assertEqual(d["parts"], [])
        self.assertTrue(any("not usable" in n["message"] for n in notes))

    def test_curves_cones_tori_and_extrude(self):
        d, notes = self.imp([
            'Curve.NewCurve "c1"',
            *_with("Circle", 'Name "disk"', 'Curve "c1"', 'Radius "2"', 'Xcenter "1"', 'Ycenter "0"', 'Segments "0"'),
            *_with("ExtrudeCurve", 'Name "rod"', 'Component "c"', 'Material "PEC"', 'Thickness "-3"', 'Curve "c1:disk"'),
            *_with("Rectangle", 'Name "r"', 'Curve "c1"', 'Xrange "0", "4"', 'Yrange "0", "2"'),
            *_with("CoverCurve", 'Name "sheet"', 'Component "c"', 'Material "PEC"', 'Curve "c1:r"'),
            *_with("Cone", 'Name "cone"', 'Component "c"', 'Material "PEC"', 'BottomRadius "3"', 'TopRadius "1"', 'Axis "x"',
                   'Xrange "0", "4"', 'Ycenter "1"', 'Zcenter "2"', 'Segments "0"'),
            *_with("Torus", 'Name "ring"', 'Component "c"', 'Material "PEC"', 'OuterRadius "5"', 'InnerRadius "3"', 'Axis "y"',
                   'Xcenter "0"', 'Ycenter "1"', 'Zcenter "0"', 'Segments "0"'),
            *_with("Extrude", 'Name "wedge"', 'Component "c"', 'Material "PEC"', 'Mode "Pointlist"', 'Height "2"', 'Twist "0.0"',
                   'Taper "0.0"', 'Origin "0.0", "0.0", "10.0"', 'Uvector "0.0", "1.0", "0.0"', 'Vvector "0.0", "0.0", "1.0"',
                   'Point "0", "0"', 'LineTo "3", "0"', 'LineTo "0", "3"'),
        ])
        self.assertEqual(self.part(d, "rod")["primitives"][0],
                         {"kind": "cylinder", "axis": "z", "center": [1.0, 0.0], "radius": 2.0, "range": [-3.0, 0.0]})
        self.assertEqual(self.part(d, "sheet")["primitives"][0], {"kind": "box", "start": [0.0, 0.0, 0.0], "stop": [4.0, 2.0, 0.0]})
        self.assertEqual(self.part(d, "cone")["primitives"][0], {"kind": "cone", "axis": "x", "center": [1.0, 2.0], "bottom_radius": 3.0,
                                                                 "top_radius": 1.0, "range": [0.0, 4.0]})
        self.assertEqual(self.part(d, "ring")["primitives"][0], {"kind": "torus", "axis": "y", "center": [0.0, 1.0, 0.0],
                                                                 "major_radius": 4.0, "minor_radius": 1.0})
        # u = y, v = z: the plane x = 0 at z offset 10, extruded along u x v = +x
        self.assertEqual(self.part(d, "wedge")["primitives"][0], {"kind": "linpoly", "normal": "x", "elevation": 0.0, "length": 2.0,
                                                                  "points": [[0.0, 10.0], [3.0, 10.0], [0.0, 13.0]]})

    def test_booleans_transforms_and_components(self):
        d, notes = self.imp([
            *_brick("a", (0, 10), (0, 10), (0, 1)), *_brick("b", (2, 4), (2, 4), (0, 1)), 'Solid.Insert "c:a", "c:b"',
            *_brick("i1", (0, 4), (0, 4), (0, 1)), *_brick("i2", (2, 6), (2, 6), (0, 1)), 'Solid.Intersect "c:i1", "c:i2"',
            *_brick("m", (1, 2), (0, 1), (5, 6)),
            *_with("Transform", 'Name "c:m"', 'Origin "Free"', 'Center "0", "0", "0"', 'PlaneNormal "1", "0", "0"',
                   'MultipleObjects "True"', 'GroupObjects "False"', 'Repetitions "1"', 'Transform "Shape", "Mirror"')[:-2]
            + [" .Transform \"Shape\", \"Mirror\"", "End With"],
            'Solid.Delete "c:m_1"',
            *_brick("s", (1, 2), (1, 2), (1, 2)),
            *_with("Transform", 'Name "c:s"', 'Origin "ShapeCenter"', 'ScaleFactor "2", "2", "2"', 'MultipleObjects "False"')[:-2]
            + [" .Transform \"Shape\", \"Scale\"", "End With"],
            'Component.New "gone"', *_brick("x", (0, 1), (0, 1), (0, 1), comp="gone"), 'Component.Delete "gone"',
            *_brick("old", (0, 1), (0, 1), (3, 4)), 'Solid.Rename "c:old", "new"',
        ])
        names = [p["name"] for p in d["parts"]]
        self.assertEqual(names, ["a", "b", "i1", "m", "s", "new"])
        self.assertEqual(self.part(d, "a")["booleanHistory"]["operation"], "insert")
        self.assertEqual(self.part(d, "i1")["primitives"], [{"kind": "box", "start": [2.0, 2.0, 0.0], "stop": [4.0, 4.0, 1.0]}])
        self.assertEqual(self.part(d, "m")["transforms"], [{"type": "mirror", "plane": "x", "point": [0.0, 0.0, 0.0], "keep": True}])
        self.assertEqual(self.part(d, "s")["transforms"], [{"type": "scale", "factors": [2.0, 2.0, 2.0], "origin": [1.5, 1.5, 1.5], "copies": 0.0}])
        refused = [n["message"] for n in notes if n["severity"] == "refused"]
        self.assertTrue(any("m_1" in m and "copy made by a transform" in m for m in refused), refused)

    def test_direct_setting_calls(self):
        d, _notes = self.imp(['Units.SetUnit "Length", "cm"', 'Mesh.LinesPerWavelength "12"', 'Solver.SteadyStateLimit "-50"',
                              *_brick("b", (0, 1), (0, 1), (0, 1))])
        self.assertEqual(d["parts"][0]["primitives"][0]["stop"], [10.0, 10.0, 10.0])
        self.assertEqual((d["mesh"]["cells_per_wavelength"], d["simulation"]["end_criteria_db"]), (12, -50))

    def test_ports_elements_units(self):
        d, notes = self.imp([
            *_with("Units", 'SetUnit "Length", "um"', 'SetUnit "Frequency", "MHz"', 'SetUnit "Resistance", "kOhm"')[:-2] + ["End With"],
            'StoreParameter "g", "500"',
            *_brick("b", ("-g", "g"), (0, 100), (0, 0)),
            *_with("DiscretePort", 'PortNumber "2"', 'Type "SParameter"', 'Impedance "0.05"', 'SetP1 "False", "0", "0", "0"',
                   'SetP2 "False", "0", "0", "g"', 'InvertDirection "True"', 'LocalCoordinates "False"'),
            *_with("LumpedElement", 'SetName "r1"', 'SetType "RLCSerial"', 'SetR "0.1"', 'SetL "0"', 'SetC "0"',
                   'SetP1 "False", "0", "0", "0"', 'SetP2 "False", "0", "100", "0"'),
            *_with("WaveguidePort", 'PortNumber "1"', 'NumberOfModes "1"', 'Coordinates "Free"', 'Orientation "zmin"',
                   'Xrange "-11430", "11430"', 'Yrange "-5080", "5080"', 'Zrange "0", "0"'),
            *_with("DiscretePort", 'PortNumber "3"', 'Type "SParameter"', 'Impedance "50"', 'SetP1 "True", "0", "0", "0"',
                   'SetP2 "False", "0", "0", "1"'),
            'Solver.FrequencyRange "8000", "12000"',
        ])
        self.assertEqual(self.part(d, "b")["primitives"][0]["start"], ["-g * 0.001", 0.0, 0.0])
        ports = {p["number"]: p for p in d["ports"]}
        self.assertEqual(ports[2], {"type": "lumped", "number": 2, "R": 50.0, "start": [0.0, 0.0, "g * 0.001"], "stop": [0.0, 0.0, 0.0],
                                    "direction": "z"})
        self.assertEqual((ports[1]["type"], ports[1]["a"], ports[1]["b"], ports[1]["start"][2], ports[1]["stop"][2]),
                         ("waveguide", 22.86, 10.16, 0.0, 2.286))
        self.assertNotIn(3, ports)
        self.assertEqual(d["resistors"], [{"name": "r1", "R": 100.0, "start": [0.0, 0.0, 0.0], "stop": [0.0, 0.1, 0.0], "direction": "y"}])
        self.assertEqual((d["simulation"]["f_min"], d["simulation"]["f_max"]), (8.0, 12.0))
        self.assertTrue(any("picked point" in n["message"] for n in notes))


def _transform(name, angle, axis="z", center=("0", "0", "0"), copies=None):
    ang = {"x": (angle, "0", "0"), "y": ("0", angle, "0"), "z": ("0", "0", angle)}[axis]
    props = [f'Name "c:{name}"', 'Origin "Free"', 'Center ' + ", ".join(f'"{c}"' for c in center),
             'Angle ' + ", ".join(f'"{a}"' for a in ang)]
    if copies:
        props += ['MultipleObjects "True"', f'Repetitions "{copies}"', 'GroupObjects "False"']
    else:
        props += ['MultipleObjects "False"']
    return _with("Transform", *props, 'Transform "Shape", "Rotate"')[:-2] + ["End With"]


class RotationAnyAngle(RoundTrip):
    """Transform / Rotate by any angle (the design format rotates by any angle), and the lumped R / L / C element."""

    BASE = [*_brick("g", (-30, 30), (-30, 30), (0, 0)), *_brick("s", (-1, 1), (-1, 1), (1, 3)),
            *_with("DiscretePort", 'PortNumber "1"', 'Type "SParameter"', 'Impedance "50"', 'SetP1 "False", "0", "0", "0"',
                   'SetP2 "False", "0", "0", "1"')]
    TAIL = ['Solver.FrequencyRange "1", "3"']

    def imp(self, lines):
        res = import_cst("\n".join([*self.BASE, *lines, *self.TAIL]), filename="t.txt")
        return res["design"], res["report"]["notes"], res

    def part(self, d, name):
        return next(p for p in d["parts"] if p["name"] == name)

    def refused(self, notes):
        return [n["message"] for n in notes if n["severity"] == "refused"]

    def mapped(self, d, name, point):
        """Where a point of the part's own frame ends up (every copy), through the design's own transform maps."""
        from fairbeam.design import _pt, transform_maps
        values = {p["key"]: p["default"] for p in d["params"] if "expr" not in p}
        return [_pt(s, t, point) for s, t in transform_maps(self.part(d, name)["transforms"], values, "t")]

    def test_arbitrary_angles_of_a_brick(self):
        for angle in (30, 45, -20, 135, 90, 180, 360, 0.5):
            with self.subTest(angle=angle):
                d, notes, _ = self.imp([*_brick("arm", (3, 13), (-1, 1), (1, 3)), *_transform("arm", angle)])
                self.assertEqual(self.refused(notes), [])
                self.assertEqual(self.part(d, "arm")["transforms"],
                                 [{"type": "rotate", "axis": "z", "center": [0.0, 0.0, 0.0], "angle": float(angle), "copies": 0.0}])
                self.assertEqual(self.part(d, "arm")["primitives"][0]["stop"], [13.0, 1.0, 3.0])   # the shape stays as drawn
                (x, y, z), = self.mapped(d, "arm", [8.0, 0.0, 2.0])
                c, s = math.cos(math.radians(angle)), math.sin(math.radians(angle))
                self.assertTrue(same_numbers([x, y, z], [8 * c, 8 * s, 2.0]), (angle, x, y, z))
                self.assert_runnable(d, f"brick {angle}")

    def test_arbitrary_angle_about_x_and_y_and_a_centre(self):
        d, notes, _ = self.imp([*_brick("a", (3, 13), (-1, 1), (1, 3)), *_transform("a", "30", "x", ("1", "2", "3")),
                                *_brick("b", (3, 13), (-1, 1), (1, 3)), *_transform("b", "-20", "y")])
        self.assertEqual(self.refused(notes), [])
        self.assertEqual(self.part(d, "a")["transforms"], [{"type": "rotate", "axis": "x", "center": [1.0, 2.0, 3.0], "angle": 30.0, "copies": 0.0}])
        self.assertEqual(self.part(d, "b")["transforms"][0]["axis"], "y")
        self.assertEqual(self.part(d, "b")["transforms"][0]["angle"], -20.0)
        self.assert_runnable(d, "x / y rotations")

    def test_angle_from_a_parameter_and_quarter_turn_unchanged(self):
        d, notes, _ = self.imp(['StoreParameter "ang", "25"', *_brick("arm", (3, 13), (-1, 1), (1, 3)), *_transform("arm", "ang * 2"),
                                *_brick("q", (3, 13), (-1, 1), (1, 3)), *_transform("q", "90")])
        self.assertEqual(self.refused(notes), [])
        tr = self.part(d, "arm")["transforms"][0]
        self.assertEqual((tr["type"], tr["axis"], tr["copies"]), ("rotate", "z", 0.0))
        self.assertEqual(evaluate(tr["angle"], {"ang": 25.0}), 50.0)
        self.assertEqual(self.part(d, "q")["transforms"][0]["angle"], 90.0)
        (x, y, _z), = self.mapped(d, "q", [8.0, 0.0, 2.0])
        self.assertTrue(same_numbers([x, y], [0.0, 8.0]))
        self.assert_runnable(d, "parameter angle")

    def test_arbitrary_angle_of_polygon_cylinder_and_sphere(self):
        wedge = _with("Extrude", 'Name "wedge"', 'Component "c"', 'Material "PEC"', 'Mode "Pointlist"', 'Height "2"', 'Twist "0.0"',
                      'Taper "0.0"', 'Origin "0.0", "0.0", "10.0"', 'Uvector "0.0", "1.0", "0.0"', 'Vvector "0.0", "0.0", "1.0"',
                      'Point "0", "0"', 'LineTo "3", "0"', 'LineTo "0", "3"')
        rod = _with("Cylinder", 'Name "rod"', 'Component "c"', 'Material "PEC"', 'Axis "z"', 'OuterRadius "1"', 'InnerRadius "0"',
                    'Xcenter "8"', 'Ycenter "0"', 'Zrange "1", "4"', 'Segments "0"')
        ball = _with("Sphere", 'Name "ball"', 'Component "c"', 'Material "PEC"', 'Axis "z"', 'CenterRadius "1.5"', 'TopRadius "0"',
                     'BottomRadius "0"', 'Center "-8", "0", "5"')
        d, notes, _ = self.imp([*wedge, *_transform("wedge", "33", "x", ("0", "0", "10")), *rod, *_transform("rod", "45"),
                                *ball, *_transform("ball", "30", "y")])
        self.assertEqual(self.refused(notes), [])
        self.assertEqual(self.part(d, "wedge")["primitives"][0]["kind"], "linpoly")
        self.assertEqual(self.part(d, "rod")["primitives"][0]["kind"], "cylinder")
        for name, angle in (("wedge", 33.0), ("rod", 45.0), ("ball", 30.0)):
            self.assertEqual(self.part(d, name)["transforms"][0]["angle"], angle, name)
        self.assert_runnable(d, "polygon / cylinder / sphere")

    def test_rotation_with_copies(self):
        d, notes, _ = self.imp([*_brick("arm", (3, 13), (-1, 1), (1, 3)), *_transform("arm", 30, copies=3)])
        self.assertEqual(self.refused(notes), [])
        self.assertEqual(self.part(d, "arm")["transforms"],
                         [{"type": "rotate", "axis": "z", "center": [0.0, 0.0, 0.0], "angle": 30.0, "copies": 3.0}])
        pts = self.mapped(d, "arm", [8.0, 0.0, 2.0])
        self.assertEqual(len(pts), 4)
        for k, (x, y, z) in enumerate(pts):
            a = math.radians(30 * k)
            self.assertTrue(same_numbers([x, y, z], [8 * math.cos(a), 8 * math.sin(a), 2.0]), k)
        self.assert_runnable(d, "copies")
        # a CST copy made by a transform is named <solid>_<n>, and the design has it as part of the same part
        d2, notes2, _ = self.imp([*_brick("arm", (3, 13), (-1, 1), (1, 3)), *_transform("arm", 45, copies=2),
                                  'Solid.Subtract "c:arm", "c:arm_1"'])
        self.assertTrue(any("arm_1" in m and "copy made by a transform" in m for m in self.refused(notes2)), self.refused(notes2))
        # a second rotation of the same part composes after the first
        d3, notes3, _ = self.imp([*_brick("arm", (3, 13), (-1, 1), (1, 3)), *_transform("arm", 30), *_transform("arm", 15, copies=1)])
        self.assertEqual(self.refused(notes3), [])
        self.assertEqual(len(self.part(d3, "arm")["transforms"]), 2)
        self.assert_runnable(d3, "two rotations")

    def test_sheet_turned_off_the_grid_axes_is_refused(self):
        sheet = _brick("sh", (3, 13), (-1, 1), (2, 2))
        # about its own normal the sheet stays on the grid
        d, notes, _ = self.imp([*sheet, *_transform("sh", 30, "z")])
        self.assertEqual(self.refused(notes), [])
        self.assert_runnable(d, "sheet about its normal")
        # tilted: no design equivalent (the build refuses it), so the import says so and keeps the sheet unrotated
        d, notes, _ = self.imp([*sheet, *_transform("sh", 30, "x")])
        msgs = self.refused(notes)
        self.assertTrue(any("'sh'" in m and "tilted relative to the Yee grid" in m for m in msgs), msgs)
        self.assertNotIn("transforms", self.part(d, "sh"))
        self.assert_runnable(d, "refused sheet")
        # a quarter turn is exact and stays fine
        d, notes, _ = self.imp([*sheet, *_transform("sh", 90, "x")])
        self.assertEqual(self.refused(notes), [])
        self.assert_runnable(d, "quarter-turned sheet")

    def lumped(self, *props, units=()):
        lines = [*(_with("Units", *units)[:-2] + ["End With"] if units else []), *_brick("b", (-5, 5), (-5, 5), (0, 0)),
                 *_with("LumpedElement", 'SetName "e1"', *props, 'SetP1 "False", "5", "0", "0"', 'SetP2 "False", "5", "2", "0"')]
        d, notes, res = self.imp(lines)
        return d, notes

    def test_lumped_resistor_only(self):
        d, notes = self.lumped('SetType "RLCSerial"', 'SetR "100"', 'SetL "0"', 'SetC "0"')
        self.assertEqual(self.refused(notes), [])
        self.assertEqual(d["resistors"], [{"name": "e1", "R": 100.0, "start": [5.0, 0.0, 0.0], "stop": [5.0, 2.0, 0.0], "direction": "y"}])
        self.assert_runnable(d, "R only")
        d, notes = self.lumped('SetType "RLCParallel"', 'SetR "75"')        # L and C not given at all
        self.assertEqual(d["resistors"][0]["R"], 75.0)
        self.assertNotIn("topology", d["resistors"][0])

    def test_lumped_series_rlc(self):
        d, notes = self.lumped('SetType "RLCSerial"', 'SetR "10"', 'SetL "2"', 'SetC "0.5"')       # default units nH and pF
        self.assertEqual(self.refused(notes), [])
        r = d["resistors"][0]
        self.assertEqual((r["topology"], r["R"]), ("series", 10.0))
        self.assertAlmostEqual(r["L"] / 2e-9, 1.0, places=9)
        self.assertAlmostEqual(r["C"] / 0.5e-12, 1.0, places=9)
        self.assertEqual(r["direction"], "y")
        self.assert_runnable(d, "series RLC")

    def test_lumped_parallel_rlc(self):
        d, notes = self.lumped('SetType "RLCParallel"', 'SetR "50"', 'SetL "5"', 'SetC "1"')
        self.assertEqual(self.refused(notes), [])
        r = d["resistors"][0]
        self.assertEqual(r["topology"], "parallel")
        self.assertEqual(sorted(k for k in r if k in "RLC"), ["C", "L", "R"])
        self.assert_runnable(d, "parallel RLC")

    def test_lumped_capacitor_only_and_inductor_only(self):
        d, notes = self.lumped('SetType "RLCSerial"', 'SetR "0"', 'SetL "0"', 'SetC "2"')
        self.assertEqual(self.refused(notes), [])
        r = d["resistors"][0]
        self.assertEqual(sorted(k for k in r if k in "RLC"), ["C"])
        self.assertAlmostEqual(r["C"] / 2e-12, 1.0, places=9)
        self.assertNotIn("topology", r)
        self.assert_runnable(d, "C only")
        d, notes = self.lumped('SetType "RLCSerial"', 'SetR "0"', 'SetL "3"', 'SetC "0"')
        r = d["resistors"][0]
        self.assertEqual(sorted(k for k in r if k in "RLC"), ["L"])
        self.assertAlmostEqual(r["L"] / 3e-9, 1.0, places=9)
        self.assert_runnable(d, "L only")
        # R + C in parallel, and the unit commands
        d, notes = self.lumped('SetType "RLCParallel"', 'SetR "1"', 'SetL "0"', 'SetC "4"', units=('SetUnit "Capacitance", "fF"',
                                                                                                    'SetUnit "Resistance", "kOhm"'))
        r = d["resistors"][0]
        self.assertEqual((r["R"], r["topology"]), (1000.0, "parallel"))
        self.assertAlmostEqual(r["C"] / 4e-15, 1.0, places=9)
        self.assert_runnable(d, "R || C")

    def test_lumped_parameter_values(self):
        lines = ['StoreParameter "cc", "3"', *_brick("b", (-5, 5), (-5, 5), (0, 0)),
                 *_with("LumpedElement", 'SetName "e1"', 'SetType "RLCSerial"', 'SetR "0"', 'SetL "0"', 'SetC "cc / 2"',
                        'SetP1 "False", "5", "0", "0"', 'SetP2 "False", "5", "2", "0"')]
        d, notes, _ = self.imp(lines)
        self.assertEqual(self.refused(notes), [])
        self.assertEqual(evaluate(d["resistors"][0]["C"], {"cc": 3.0}), 1.5e-12)

    def test_wire_from_a_curve(self):
        pts = ['Point "0", "0", "5"', 'Point "0", "3", "8"', 'Point "3", "3", "9"']
        curve = ['Curve.NewCurve "w_curve"', *_with("Polygon3D", 'Name "w"', 'Curve "w_curve"', *pts)]
        # a solid wire: .Add then .ConvertToSolidShape, named by .SolidName
        d, notes, _ = self.imp([*curve, *_with("Wire", 'Name "w_wire"', 'Type "Curvewire"', 'Curve "w_curve:w"', 'Radius "0.4"',
                                               'SolidWireModel "True"', 'Material "PEC"', 'Termination "natural"', 'Add')[:-2], "End With",
                                *_with("Wire", 'Name "w_wire"', 'SolidName "comp:coil"', 'Material "PEC"', 'KeepWire "False"',
                                       'ConvertToSolidShape')[:-2], "End With"])
        self.assertEqual(self.refused(notes), [])
        coil = self.part(d, "coil")
        self.assertEqual(coil["component"], "comp")
        self.assertEqual(coil["primitives"], [{"kind": "wire", "points": [[0.0, 0.0, 5.0], [0.0, 3.0, 8.0], [3.0, 3.0, 9.0]], "radius": 0.4}])
        self.assert_runnable(d, "solid wire")
        # a curve wire with no radius becomes a thin design wire (named after the curve item), with a warning
        d, notes, _ = self.imp([*curve, *_with("Wire", 'Name "w_wire"', 'Type "Curvewire"', 'Curve "w_curve:w"', 'Radius "0.0"',
                                               'SolidWireModel "False"', 'Material "PEC"', 'Add')[:-2], "End With"])
        self.assertEqual(self.refused(notes), [])
        thin = self.part(d, "w")["primitives"][0]
        self.assertEqual((thin["kind"], thin["radius"]), ("wire", 0.01))
        self.assertTrue(any("no thickness" in n["message"] and n["severity"] == "warning" for n in notes), notes)
        self.assert_runnable(d, "thin wire")
        # a non-flat Polygon3D is still no profile
        d, notes, _ = self.imp([*curve, *_with("CoverCurve", 'Name "sh"', 'Component "c"', 'Material "PEC"', 'Curve "w_curve:w"')])
        self.assertTrue(any("not flat" in m and "path of a wire" in m for m in self.refused(notes)), self.refused(notes))

    def test_revolve_and_matrix_refusals(self):
        d, notes, _ = self.imp([*_with("Rotate", 'Name "rev"', 'Component "c"', 'Material "PEC"', 'Mode "Pointlist"', 'Angle "360.0"',
                                       'Origin "0", "0", "0"', 'Point "1", "0"', 'LineTo "2", "0"', 'LineTo "1", "3"', 'LineTo "1", "0"'),
                                *_brick("b", (3, 4), (3, 4), (1, 2)),
                                *_with("Transform", 'Name "c:b"', 'Matrix "1", "0", "0", "0.5", "1", "0", "0", "0", "1"',
                                       'Vector "0", "0", "0"', 'MultipleObjects "False"', 'Transform "Shape", "Matrix"')[:-2], "End With"])
        msgs = self.refused(notes)
        self.assertTrue(any("'rev'" in m and "solid of revolution" in m for m in msgs), msgs)
        self.assertTrue(any("Matrix" in m and "shear" in m for m in msgs), msgs)
        self.assertNotIn("transforms", self.part(d, "b"))

    def test_lumped_refusals(self):
        d, notes = self.lumped('SetType "Diode"', 'SetR "1"')
        self.assertEqual(d["resistors"], [])
        self.assertEqual(self.refused(notes), ["not imported: lumped element 'e1': the type 'Diode' has no design equivalent "
                                               "(only RLCSerial and RLCParallel elements are imported)"])
        d, notes = self.lumped('SetType "RLCSerial"', 'SetR "0"', 'SetL "0"', 'SetC "0"')
        self.assertEqual(self.refused(notes), ["not imported: lumped element 'e1': R, L and C are all zero, so there is no component to build"])
        d, notes = self.lumped('SetType "RLCSerial"', 'SetR "1"', 'SetL "-1"')
        self.assertEqual(self.refused(notes), ["not imported: lumped element 'e1': a negative L has no design equivalent (R, L and C must be > 0)"])


class Expressions(unittest.TestCase):
    NAMES = {"w": "W", "len": "len_", "h": "h"}

    def t(self, text):
        return translate(text, self.NAMES)

    def test_operators_and_functions(self):
        self.assertEqual(self.t("W^2"), "W**2")
        self.assertEqual(self.t("2^3^2"), 64.0)                    # VBA: left associative
        self.assertEqual(self.t("w^2^h"), "(W**2)**h")
        self.assertEqual(self.t("-W^2"), "-W**2")
        self.assertEqual(self.t("Sqr(W) + Atn(h)"), "sqrt(W) + atan(h)")
        self.assertEqual(self.t("W Mod 3"), "W % 3")
        self.assertEqual(self.t("W \\ 2"), "W // 2")
        self.assertEqual(self.t("pi*W/180"), "pi * W / 180")
        self.assertEqual(self.t("clight/h"), "c0 / h")
        self.assertEqual(self.t("W - (h - 1)"), "W - (h - 1)")
        self.assertEqual(self.t("W / (h * 2)"), "W / (h * 2)")
        self.assertEqual(self.t("LEN + 1"), "len_ + 1")               # CST names are case-insensitive
        self.assertEqual(self.t("1.5E-3"), 0.0015)
        self.assertEqual(self.t("Int(W)"), "floor(W)")
        for bad in ("W > 1", "IIf(W, 1, 2)", "foo + 1", "Sgn(W)", "W And h", "1 +"):
            with self.assertRaises(_Refuse, msg=bad):
                self.t(bad)

    def test_translated_values_evaluate_like_vba(self):
        names = {"W": 3.0, "h": 2.0, "len_": 1.0}
        for vba, value in (("W^2", 9), ("-W^2", -9), ("2^-1", 0.5), ("W Mod 2", 1), ("7 \\ 2", 3), ("W^h^2", 81)):
            out = self.t(vba)
            self.assertAlmostEqual(evaluate(out, names) if isinstance(out, str) else out, value, msg=vba)


class Report(unittest.TestCase):
    def test_every_statement_is_accounted_for(self):
        text = "\n".join([
            'With Brick', ' .Reset', ' .Name "b"', ' .Component "c"', ' .Material "PEC"',
            ' .Xrange "0", "1"', ' .Yrange "0", "1"', ' .Zrange "0", "1"', ' .Create', 'End With',
            'With Sphere', ' .Reset', ' .Name "s"', ' .Component "c"', ' .Material "PEC"', ' .CenterRadius "1"',
            ' .TopRadius "0.5"', ' .BottomRadius "0"', ' .Center "0", "0", "0"', ' .Create', 'End With',
            'Solid.Subtract "c:b", "c:missing"',
            'With LumpedElement', ' .Reset', ' .SetName "c1"', ' .SetType "Diode"', ' .SetR "0"', ' .SetL "0"',
            ' .SetC "1e-12"', ' .SetP1 "False", "0", "0", "0"', ' .SetP2 "False", "0", "0", "1"', ' .Create', 'End With',
            'Solid.SliceShape "c:b", "x"',
        ])
        res = import_cst(text, filename="x.txt")
        refused = [n["message"] for n in res["report"]["notes"] if n["severity"] == "refused"]
        self.assertTrue(any("sphere segment" in m for m in refused), refused)
        self.assertTrue(any("unknown solid 'c:missing'" in m for m in refused), refused)
        self.assertTrue(any("'c1'" in m and "'Diode'" in m and "no design equivalent" in m for m in refused), refused)
        self.assertTrue(any("SliceShape" in m for m in refused), refused)
        self.assertEqual([p["name"] for p in res["design"]["parts"]], ["b"])

    def test_read_macro_blocks(self):
        blocks, meta, notes, name = read_macro('Sub Main\nAddToHistory "t", "With Brick" & vbLf & ".Reset" & vbLf & "End With"\nEnd Sub\n')
        self.assertEqual([(b.title, [s for _l, s in b.stmts]) for b in blocks], [("t", ["With Brick", ".Reset", "End With"])])


class ReportGaps(unittest.TestCase):
    """The report lists each gap once, and says what fairbeam's own export left out."""

    def horn(self):
        stls = {f.name: f.read_text(encoding="utf-8") for f in MACROS.glob("pyramidal-horn_*.stl")}
        return import_cst((MACROS / "pyramidal-horn.bas").read_text(encoding="utf-8"), filename="pyramidal-horn.bas", files=stls)["report"]

    def legacy_horn(self):
        """The horn macro as older exports wrote it: the polyhedra are 'skipped' warnings, not STL imports."""
        text = (MACROS / "pyramidal-horn.bas").read_text(encoding="utf-8").replace("\r\n", "\n")
        blocks = [b for b in text.split("\n\n") if "import polyhedron" not in b and "change material: fairbeam:horn_" not in b]
        text = re.sub(r'    sCommand = sCommand \+ "Solid\.Add ""fairbeam:horn_1"", ""fairbeam:horn_[5-8]""" \+ vbLf\n', "", "\n\n".join(blocks))
        warn = "    ' WARNING: horn: polyhedron (12 faces) skipped; not exported to CST (rebuild it, e.g. as a loft)\n"
        i = text.index("End Sub")
        return import_cst(text[:i] + warn * 4 + text[i:], filename="pyramidal-horn.bas")["report"]

    def test_repeated_warning_is_one_row(self):
        report = self.legacy_horn()
        gaps = [n for n in report["notes"] if n["severity"] != "info"]
        self.assertEqual(len(gaps), 1, gaps)
        flare = gaps[0]
        self.assertEqual((flare["count"], len(flare["lines"]), flare["kind"]), (4, 4, "missing"))
        self.assertEqual(flare["line"], flare["lines"][0])
        self.assertIn("flare", flare["message"])
        self.assertIn("not in this macro", flare["message"])
        self.assertNotIn("the macro notes", flare["message"])
        self.assertEqual((report["refused"], report["warnings"]), (0, 1))

    def test_horn_flare_is_imported_from_its_stl_files(self):
        report = self.horn()
        self.assertEqual([n for n in report["notes"] if n["severity"] != "info"], [])
        self.assertEqual((report["refused"], report["warnings"]), (0, 0))

    def test_missing_stl_files_are_reported_not_fatal(self):
        text = (MACROS / "pyramidal-horn.bas").read_text(encoding="utf-8")
        for files in (None, {}, {"other.stl": "solid x\nendsolid x\n"}):
            report = import_cst(text, filename="pyramidal-horn.bas", files=files)["report"]
            refused = [n for n in report["notes"] if n["severity"] == "refused"]
            missing = [n for n in refused if "was not supplied" in n["message"]]
            dependent = [n for n in refused if "dependent shape" in n["message"]]
            self.assertEqual(len(missing), 4, refused)
            self.assertTrue(all(".stl" in n["message"] for n in missing), missing)
            self.assertEqual(len(dependent), 8, refused)  # material changes and Boolean operands
            self.assertEqual(len(refused), len(missing) + len(dependent))
            for suffix in range(5, 9):
                self.assertEqual(sum(f"fairbeam:horn_{suffix}" in n["message"] for n in dependent), 2)
            self.assertEqual(report["counts"]["part"], 1)   # the rest of the horn is still imported

    def test_unreadable_stl_is_refused(self):
        text = (MACROS / "pyramidal-horn.bas").read_text(encoding="utf-8")
        bad = {f.name: "solid x\n  vertex 1 2\nendsolid x\n" for f in MACROS.glob("pyramidal-horn_*.stl")}
        report = import_cst(text, filename="pyramidal-horn.bas", files=bad)["report"]
        self.assertEqual(sum(1 for n in report["notes"] if n["severity"] == "refused" and "cannot be read" in n["message"]), 4)

    def test_restored_waveguide_port_is_not_a_gap(self):
        report = self.horn()
        self.assertFalse(any(n["where"] == "port 1" for n in report["notes"]), report["notes"])
        self.assertTrue(any("waveguide port 1 restored" in n["message"] for n in report["notes"]))

    def test_identical_notes_of_a_hand_written_macro_merge(self):
        text = "StoreParameter \"a\", \"1\"\n" + "Solver.Frequency \"1\"\n" * 3
        res = import_cst(text + '''With Brick
     .Reset
     .Name "b"
     .Component "c"
     .Material "PEC"
     .Xrange "0", "1"
     .Yrange "0", "1"
     .Zrange "0", "1"
     .Create
End With
''')
        keys = [(n["severity"], n["where"], n["message"]) for n in res["report"]["notes"]]
        self.assertEqual(len(keys), len(set(keys)), keys)
        self.assertTrue(all(n["count"] >= 1 for n in res["report"]["notes"]))


class ImportApi(unittest.TestCase):
    """POST /api/import/cst (a report before creating) and POST /api/designs with cst."""

    @classmethod
    def setUpClass(cls):
        import threading

        from fairbeam.jobs import JobManager
        from fairbeam.server import App, make_server

        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.models = root / "models"
        cls.models.mkdir()
        (root / "projects").mkdir()
        manager = JobManager(root / "jobs", root / "projects", command_factory=lambda job: [sys.executable, "-c", "pass"])
        cls.app = App(models_dir=cls.models, projects_dir=root / "projects", jobs_dir=root / "jobs",
                      templates_dir=REPO / "python" / "templates", manager=manager)
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
        import http.client

        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=120)
        h = {"Host": f"127.0.0.1:{self.port}", "Content-Type": "application/json"}
        conn.request(method, path, body=json.dumps(body).encode(), headers=h)
        r = conn.getresponse()
        payload = json.loads(r.read() or b"null")
        conn.close()
        return r.status, payload

    def test_preview_then_create(self):
        source = (MACROS / "patch-antenna.bas").read_text(encoding="utf-8")
        st, body = self.request("POST", "/api/import/cst", {"source": source, "filename": "C:\\macros\\patch-antenna.bas"})
        self.assertEqual(st, 200, body)
        self.assertEqual(body["report"]["counts"]["part"], 3)
        self.assertEqual([c for c in body["checks"] if c["severity"] == "error"], [])
        self.assertIn("patch-antenna.bas", body["design"]["model"]["description"])
        self.assertNotIn("C:", body["design"]["model"]["description"])

        st, made = self.request("POST", "/api/designs", {"id": "cst_patch", "name": "CST patch",
                                                         "cst": {"source": source, "filename": "patch-antenna.bas"}})
        self.assertEqual(st, 201, made)
        self.assertTrue(made["validation"]["valid"], made["validation"])
        self.assertEqual(made["design"]["model"], {**made["design"]["model"], "id": "cst-patch", "name": "CST patch"})
        self.assertEqual(made["import_report"]["counts"]["port"], 1)
        self.assertTrue((self.models / "cst_patch.design.json").is_file())
        st, again = self.request("POST", "/api/designs", {"id": "cst_patch", "cst": {"source": source}})
        self.assertEqual(st, 409, again)

    def test_refusals(self):
        st, err = self.request("POST", "/api/import/cst", {"source": ""})
        self.assertEqual(st, 422)
        st, err = self.request("POST", "/api/import/cst", {"source": "hello\nworld"})
        self.assertEqual(st, 422)
        self.assertIn("no CST history commands", err["error"])
        st, err = self.request("POST", "/api/designs", {"id": "Bad Id", "cst": {"source": "With Brick\nEnd With"}})
        self.assertEqual(st, 422)
        self.assertIn("id", err["fields"])
        st, err = self.request("POST", "/api/designs", {"id": "ok_id", "cst": "With Brick"})
        self.assertEqual(st, 422)

    def test_a_mesh_over_the_limit_starts_coarser(self):
        # a band from 0 Hz (the CST default start) and no mesh settings: a huge air box at 20 cells/λ
        import os

        from fairbeam.jobs import JobManager
        from fairbeam.server import App

        text = CST_HISTORY.replace('Solver.FrequencyRange "fc - 1", "fc + 1"', 'Solver.FrequencyRange "0", "40"')
        root = Path(self.tmp.name) / "limit"
        root.mkdir()
        old = os.environ.get("FAIRBEAM_MAX_CELLS")
        os.environ["FAIRBEAM_MAX_CELLS"] = "3000000"   # the preview worker starts with this limit
        app = App(models_dir=self.models, projects_dir=root, jobs_dir=root / "jobs", templates_dir=REPO / "python" / "templates",
                  manager=JobManager(root / "jobs", root, command_factory=lambda job: [sys.executable, "-c", "pass"]))
        try:
            body = app.import_cst({"source": text, "filename": "wide.txt"})
        finally:
            app.close()
            if old is None:
                del os.environ["FAIRBEAM_MAX_CELLS"]
            else:
                os.environ["FAIRBEAM_MAX_CELLS"] = old
        self.assertLess(body["design"]["mesh"]["cells_per_wavelength"], 15)
        self.assertIn("cells per wavelength", body["report"]["notes"][0]["message"])
        self.assertEqual([c["code"] for c in body["checks"] if c["severity"] == "error"], [])


def _merged_block_macro() -> str:
    """A macro in the form CST writes merged history blocks ('## Merged Block, version bookkeeping):
    a traced 35 um copper outline on FR4 fed by an SMA connector whose body has a cylindrical bore, a
    coax waveguide port on the connector face, an E-field monitor."""
    blob = [(12 * math.cos(t) * (1 + 0.08 * math.sin(7 * t)), 20 + 9 * math.sin(t)) for t in
            (2 * math.pi * i / 90 for i in range(90))]
    pts = "\n".join(f" .{'Point' if i == 0 else 'LineTo'} {x:.4f}, {y:.4f}" for i, (x, y) in enumerate(blob))
    v = 'StartVersionStringOverrideMode "2026.2|35.0.0|20251128"\n'
    block = lambda title, body: f"'## Merged Block - {title}\n{v}{body}\n"
    return "Sub Main ()\n" + "".join([
        block("units", 'With Units\n .Geometry "mm"\n .Frequency "GHz"\nEnd With'),
        block("frequency range", 'Solver.FrequencyRange "1.5", "6.5"'),
        block("material FR4", 'With Material\n .Reset\n .Name "FR4"\n .Type "Normal"\n .Epsilon "4.3"\n .TanD "0.025"\n'
                              ' .TanDFreq "2.45"\n .TanDGiven "True"\n .Create\nEnd With'),
        block("material Cu", 'With Material\n .Reset\n .Name "Cu"\n .Type "Lossy metal"\n .Sigma "58000000.0"\n .Create\nEnd With'),
        block("substrate", 'With Brick\n .Reset\n .Name "substrate"\n .Component "board"\n .Material "FR4"\n'
                           ' .Xrange "-15", "15"\n .Yrange "0", "32"\n .Zrange "-1.6", "0"\n .Create\nEnd With'),
        block("radiator", f'With Polygon\n .Reset\n .Name "p_rad"\n .Curve "c_rad"\n{pts}\n .LineTo {blob[0][0]:.4f}, {blob[0][1]:.4f}\n'
                          ' .Create\nEnd With\nWith ExtrudeCurve\n .Reset\n .Name "radiator"\n .Component "copper"\n'
                          ' .Material "Cu"\n .Thickness "0.035"\n .Curve "c_rad:p_rad"\n .Create\nEnd With'),
        # a feed line whose outline rounds the same corner two ways (2.0000 / 1.9999, 0.0000 / 0.0001)
        block("feed", 'With Polygon\n .Reset\n .Name "p_feed"\n .Curve "c_feed"\n .Point 2.0000, 0.0000\n .LineTo 1.9999, 11.2\n'
                      ' .LineTo -2.0000, 11.2\n .LineTo -2.0000, 0.0001\n .LineTo 2.0000, 0.0000\n .Create\nEnd With\n'
                      'With ExtrudeCurve\n .Reset\n .Name "feed"\n .Component "copper"\n .Material "Cu"\n .Thickness "0.035"\n'
                      ' .Curve "c_feed:p_feed"\n .Create\nEnd With'),
        block("body", 'With Brick\n .Reset\n .Name "body"\n .Component "sma"\n .Material "PEC"\n .Xrange "-4.75", "4.75"\n'
                      ' .Yrange "-6.3", "-0.3"\n .Zrange "-4.115", "5.385"\n .Create\nEnd With'),
        block("bore", 'With Cylinder\n .Reset\n .Name "bore"\n .Component "sma"\n .Material "PEC"\n .OuterRadius "2.1"\n'
                      ' .InnerRadius "0"\n .Axis "y"\n .Yrange "-6.3", "-0.3"\n .Xcenter "0"\n .Zcenter "0.635"\n .Create\nEnd With'),
        block("subtract bore", 'Solid.Subtract "sma:body", "sma:bore"'),
        block("ptfe", 'With Material\n .Reset\n .Name "PTFE"\n .Type "Normal"\n .Epsilon "2.1"\n .Create\nEnd With\n'
                      'With Cylinder\n .Reset\n .Name "ptfe"\n .Component "sma"\n .Material "PTFE"\n .OuterRadius "2.1"\n'
                      ' .InnerRadius "0.635"\n .Axis "y"\n .Yrange "-6.3", "-0.3"\n .Xcenter "0"\n .Zcenter "0.635"\n .Create\nEnd With'),
        block("pin", 'With Cylinder\n .Reset\n .Name "pin"\n .Component "sma"\n .Material "PEC"\n .OuterRadius "0.635"\n'
                     ' .InnerRadius "0"\n .Axis "y"\n .Yrange "-6.3", "1.5"\n .Xcenter "0"\n .Zcenter "0.635"\n .Create\nEnd With'),
        block("port1", 'With Port\n .Reset\n .PortNumber "1"\n .NumberOfModes "1"\n .Coordinates "Free"\n .Orientation "ymin"\n'
                       ' .Xrange "-4.5", "4.5"\n .Yrange "-6.3", "-6.3"\n .Zrange "-3.865", "5.135"\n .Create\nEnd With'),
        block("e-field", 'With Monitor\n .Reset\n .Name "e-field (f=2.45)"\n .Domain "Frequency"\n .FieldType "Efield"\n'
                         ' .MonitorValue "2.45"\n .Create\nEnd With'),
        block("boundaries", 'With Boundary\n .Xmin "expanded open"\n .Xmax "expanded open"\n .Ymin "expanded open"\n'
                            ' .Ymax "expanded open"\n .Zmin "expanded open"\n .Zmax "expanded open"\nEnd With'),
    ]) + "StopVersionStringOverrideMode\nEnd Sub\n"


class MergedBlocks(unittest.TestCase):
    """Merged-block macros: an SMA-fed printed antenna comes in whole and runnable."""

    @classmethod
    def setUpClass(cls):
        cls.res = import_cst(_merged_block_macro(), filename="merged.bas")
        cls.d, cls.report = cls.res["design"], cls.res["report"]

    def part(self, name):
        return next(p for p in self.d["parts"] if p["name"] == name)

    def test_blocks_and_bookkeeping(self):
        self.assertEqual(self.report["history_items"], 15)
        self.assertEqual(self.report["refused"], 0, [n["message"] for n in self.report["notes"] if n["severity"] == "refused"])
        self.assertFalse(any("VersionStringOverrideMode" in n["message"] and n["severity"] != "info" for n in self.report["notes"]))
        self.assertTrue(any("e-field" in n["message"] and n["severity"] == "info" for n in self.report["notes"]))

    def test_bore_cut_by_priority(self):
        self.assertEqual({q.get("priority") for q in self.part("body")["primitives"]}, {1})
        cut = self.part("bore_cut")
        self.assertEqual(cut["material"], "Vacuum")
        self.assertEqual(cut["primitives"][0]["priority"], 2)
        self.assertEqual(self.part("ptfe")["primitives"][0]["priority"], 3)
        self.assertNotIn("priority", self.part("pin")["primitives"][0])   # metal: 10, above all of them

    def test_coax_port(self):
        self.assertEqual(self.d["ports"], [{"type": "lumped", "number": 1, "R": 50.0, "start": [-2.1, -6.3, 0.635],
                                            "stop": [-0.635, -6.3, 0.635], "direction": "x"}])
        self.assertTrue(any("coaxial line" in n["message"] and "49.5 ohm" in n["message"] for n in self.report["notes"]))

    def test_thin_copper_and_outline_tidy(self):
        rad, feed = self.part("radiator")["primitives"][0], self.part("feed")["primitives"][0]
        self.assertEqual((rad["kind"], rad["elevation"]), ("polygon", 0.0))   # the copper sits on the FR4 face
        self.assertEqual(feed["points"], [[2.0, 0.0], [2.0, 11.2], [-2.0, 11.2], [-2.0, 0.0]])

    def test_runnable_mesh(self):
        values = {p["key"]: p["default"] for p in self.d["params"] if "expr" not in p}
        bundle = build_preview(None, {}, design=self.d)["bundle"]
        self.assertEqual([c["message"] for c in lint(self.d, values, bundle) if c["severity"] in ("error", "warning")
                          and c.get("code") != "mesh-warning"], [])
        m = bundle["mesh"]
        cells = (len(m["x"]) - 1) * (len(m["y"]) - 1) * (len(m["z"]) - 1)
        # hard lines at each of the 90 traced vertices (and at the 1e-4 mm rounding steps) gave cells of
        # micrometres and tens of millions of cells
        self.assertLess(cells, 8_000_000)
        for a in "xyz":
            self.assertGreater(min(y - x for x, y in zip(m[a], m[a][1:])), 0.01, a)
        sim = build(self.d, values)
        lines = [list(sim.mesh.GetLines(a)) for a in "xyz"]
        for k in range(3):
            for v in (self.d["ports"][0]["start"][k], self.d["ports"][0]["stop"][k]):
                self.assertLess(min(abs(v - x) for x in lines[k]), 1e-9, f"port {'xyz'[k]} = {v} off the mesh")


class Limits(unittest.TestCase):
    """A broken or hostile macro is refused item by item (or as a whole, CstImportError) quickly and
    with bounded memory: never a crash, a hang or an exponential string."""

    BRICK = "\n".join(_brick("b", (0, 1), (0, 1), (0, 1)))

    def notes(self, text):
        return " ".join(n["message"] for n in import_cst(text)["report"]["notes"])

    def test_expressions(self):
        for bad in ("(" * 5000 + "1" + ")" * 5000, "-" * 20000 + "1", "+".join(["1"] * 200000)):
            text = self.notes(f'StoreParameter "a", "{bad}"\n' + self.BRICK.replace('"1"', f'"{bad}"', 1))
            self.assertIn("parameter a", text)
            self.assertTrue("too long" in text or "too deeply" in text, text[:300])

    def test_strings(self):
        doubling = 'v0 = "With Brick" + vbLf\n' + "".join(f"v{i} = v{i - 1} + v{i - 1}\n" for i in range(1, 60))
        with self.assertRaises(CstImportError):
            import_cst(doubling + 'AddToHistory "t", v59\n')
        # s = s + "..." grows in place: 100k lines stay fast
        lines = 's = ""\n' + "".join(f's = s + "StoreParameter ""p{i}"", ""{i}""" + vbLf\n' for i in range(3000))
        res = import_cst(lines + 'AddToHistory "t", s\n' + self.BRICK)
        self.assertEqual(len(res["design"]["params"]), 3000)
        self.assertIn("not a plain string", self.notes('AddToHistory "t", Chr(99999999999) + "x"\n' + self.BRICK))
        self.assertIn("not valid JSON", self.notes("' fairbeam-data: " + '{"a":' * 50_000 + "1" + "}" * 50_000 + "\n" + self.BRICK))
        # a long chain of line continuations is read in one pass
        design = import_cst("With Brick _\n" + " _\n" * 200_000 + "\n" + self.BRICK)["design"]
        self.assertEqual(len(design["parts"]), 1)

    def test_shapes(self):
        nested = "\n".join(line for i in range(80) for line in _brick(f"b{i}", (0, 10 - i * 0.01), (0, 1), (0, 1)))
        nested += "\n" + "\n".join(f'Solid.Subtract "c:b0", "c:b{i}"' for i in range(1, 80))
        self.assertIn("nested Boolean operations", self.notes(nested))
        rotate = self.BRICK + ('\nWith Transform\n .Name "c:b"\n .Origin "Free"\n .Center "0","0","0"\n .Angle "0","0","90"\n'
                               ' .Transform "Shape", "Rotate"\nEnd With') * 70
        self.assertIn("transforms of one shape", self.notes(rotate))
        res = import_cst('StoreParameter "çap", "2"\n' + self.BRICK.replace('"1"', '"çap"', 1))
        self.assertEqual(res["design"]["params"][0]["key"], "cap")

    def test_mesh_records(self):
        # the exported mesh lines come in short comment lines (the VBA editor takes at most 1023 characters)
        for macro in sorted(MACROS.glob("*.bas")):
            longest = max(len(line) for line in macro.read_text(encoding="utf-8").splitlines())
            self.assertLess(longest, 1000, macro.name)
        # absurd automatic settings next to the lines are not rebuilt in the importer: the lines are kept
        text = ("' fairbeam-data: {\"mesh\": {\"cells_per_wavelength\": 1e9}}\n"
                "' fairbeam-data: {\"mesh_lines\": {\"x\": [-1, 2], \"y\": [-1, 2]}}\n"
                "' fairbeam-data: {\"mesh_lines\": {\"z\": [-1, 2]}}\n" + self.BRICK)
        mesh = import_cst(text)["design"]["mesh"]
        self.assertEqual(mesh["mode"], "manual")
        self.assertEqual(mesh["lines"], {"x": [-1.0, 2.0], "y": [-1.0, 2.0], "z": [-1.0, 2.0]})


class BinaryInput(unittest.TestCase):
    def test_binary_content_is_not_a_macro(self):
        with self.assertRaisesRegex(CstImportError, "not a text macro.*History List"):
            import_cst("PK\x03\x04\x00\x00 binary", filename="project.bin")

    def test_cli_rejects_binary_file(self):
        import tempfile
        from fairbeam.cli import read_macro_file
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "binary.bin"
            p.write_bytes(b"PK\x03\x04\x00\x00 binary")
            with self.assertRaisesRegex(ValueError, "not a text macro.*History List"):
                read_macro_file(p)


if __name__ == "__main__":
    unittest.main()
