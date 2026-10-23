"""Analytical/geometry contracts only: no solver, mesh build, browser or GUI.

--json supplies the same Python-resolved designs to the TypeScript instant
preview/export check. Reference synthesis is independent fairbeam.analytic.
"""
import ast
import itertools
import json
import math
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fairbeam import analytic
from fairbeam.design import (blank_design, check_design, evaluate, names_in, param_key_error,
                             resolve_names, resolve_parts, template_design, to_python)
from fairbeam.patch_seed import microstrip_width, patch_inset
from fairbeam.design_checks import lint


def cases():
    return [{}, *({"f0": f, "eps_r": er, "h": h}
                  for f, er, h in itertools.product((1, 3), (2, 6), (0.4, 1.6))),
            {"f0": 1.8, "eps_r": 3.38, "h": 0.8}]


def specimen(values):
    d = template_design("inset-patch", "inset-test", "Inset test")
    for p in d["params"]:
        if p["key"] in values:
            p["default"] = values[p["key"]]
    return d, resolve_names(d, {})


def export_calculations(d, values):
    """Execute the actual exported scalar prologue, stopping before Simulation.

    This deliberately does not validate solver/export execution. Geometry is
    checked by evaluating the actual exported AddBox/port argument expressions.
    """
    tree = ast.parse(to_python(d))
    build = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "build")
    prologue = []
    for statement in build.body:
        if isinstance(statement, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "sim" for t in statement.targets):
            break
        if isinstance(statement, ast.Assign):
            prologue.append(statement)
    ns = {"p": values, "__builtins__": __builtins__}
    for n in tree.body:
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            exec(compile(ast.Module(body=[n], type_ignores=[]), "export-import", "exec"), ns)
    ns["wavelength"] = lambda f: 299.792458 / f
    exec(compile(ast.Module(body=prologue, type_ignores=[]), "export-prologue", "exec"), ns)
    boxes, ports = [], []
    for n in ast.walk(build):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute):
            ev = lambda x: eval(compile(ast.Expression(x), "export-argument", "eval"), ns)
            if n.func.attr == "AddBox":
                boxes.append({k.arg: ev(k.value) for k in n.keywords})
            if n.func.attr == "lumped_port":
                ports.append([ev(x) for x in n.args])
    return ns, boxes, ports


class InsetPatchStarter(unittest.TestCase):
    def test_synthesis_matches_independent_reference_at_corners(self):
        for inputs in cases():
            with self.subTest(inputs=inputs):
                d, n = specimen(inputs)
                check_design(d)
                self.assertEqual([c for c in lint(d) if c["severity"] in ("error", "warning")], [])
                self.assertEqual(d["far_field"]["frequencies"], ["f0"])
                self.assertEqual([evaluate(v, n) for v in d["far_field"]["phase_center"]], [0, 0, n["h"]])
                reference = analytic.patch_design(n["f0"] * 1e9, n["h"], n["eps_r"])
                for key, ref_key in (("W", "width"), ("L", "length"), ("eps_eff", "eps_eff"), ("delta_l", "delta_l")):
                    self.assertAlmostEqual(n[key], reference[ref_key], delta=1e-10)
                self.assertAlmostEqual(n["feed_w"], analytic.microstrip_width(50, n["eps_r"], n["h"]), delta=1e-10)
                self.assertAlmostEqual(analytic.microstrip_z0(n["eps_r"], n["h"], n["feed_w"]), 50, delta=1e-10)
                reference_inset = analytic.inset_depth(50, n["L"], n["W"], n["f0"] * 1e9)
                self.assertAlmostEqual(n["inset"], reference_inset, delta=1e-9)
                # Inverting the same analytic model is not a measured resonance.
                self.assertAlmostEqual(analytic.patch_resonance(n["L"], n["W"], n["h"], n["eps_r"])["f_r"] / 1e9,
                                       n["f0"], delta=1e-10)

    def test_geometry_and_export_preserve_slots_and_contact(self):
        for inputs in cases():
            with self.subTest(inputs=inputs):
                d, n = specimen(inputs)
                self.assertTrue(0 < n["inset"] < n["L"] / 2)
                self.assertLess(n["feed_w"] + 2 * n["gap"], n["W"])
                self.assertTrue(n["x_feed"] < -n["L"] / 2 < n["x_in"] < n["L"] / 2)
                self.assertLess(n["h"] * math.sqrt(n["eps_r"]) / n["lam0"], 0.04)
                parts = resolve_parts(d, n)
                ground, patch = parts[1]["prims"][0], parts[2]["prims"]
                self.assertEqual(len(patch), 4)
                for box in patch:
                    self.assertEqual(box["start"][2], n["h"])
                    self.assertEqual(box["stop"][2], n["h"])
                    self.assertLess(box["start"][0], box["stop"][0])
                    self.assertLess(box["start"][1], box["stop"][1])
                port = d["ports"][0]
                start, stop = ([evaluate(v, n) for v in port[k]] for k in ("start", "stop"))
                self.assertEqual(start[0], patch[3]["start"][0])
                self.assertEqual(start[0], ground["start"][0])
                self.assertEqual(start[2], ground["start"][2])
                self.assertEqual(stop[2], patch[3]["start"][2])
                self.assertEqual(patch[3]["stop"][0], patch[0]["start"][0])
                self.assertAlmostEqual(patch[1]["start"][1] - patch[3]["stop"][1], n["gap"])
                self.assertAlmostEqual(patch[3]["start"][1] - patch[2]["stop"][1], n["gap"])
                p = {x["key"]: x["default"] for x in d["params"] if "default" in x}
                ns, boxes, ports = export_calculations(d, p)
                for key in ("W", "L", "feed_w", "inset", "gap", "margin"):
                    self.assertAlmostEqual(ns[key], n[key], delta=1e-10)
                expected = [box for part in parts for box in part["prims"]]
                self.assertEqual(len(boxes), len(expected))
                for got, want in zip(boxes, expected):
                    for key in ("start", "stop"):
                        for a, b in zip(got[key], want[key]):
                            self.assertAlmostEqual(a, b, delta=1e-10)
                self.assertEqual(ports[0][0:2], [1, 50])
                for a, b in zip(ports[0][2] + ports[0][3], start + stop):
                    self.assertAlmostEqual(a, b, delta=1e-10)

    def test_scaling_and_each_input_changes_geometry(self):
        _, a = specimen({"f0": 1.2, "h": 1.6})
        _, b = specimen({"f0": 2.4, "h": 0.8})
        for key in ("W", "L", "feed_w", "inset", "gap", "feed_len", "margin"):
            self.assertAlmostEqual(a[key] / 2, b[key], delta=1e-10)
        _, baseline = specimen({})
        for inputs in ({"f0": 1.5}, {"eps_r": 2.2}, {"h": 0.8}):
            _, changed = specimen(inputs)
            self.assertNotEqual(changed["L"], baseline["L"])
            self.assertNotEqual(changed["inset"], baseline["inset"])

    def test_invalid_and_unsupported_synthesis_inputs(self):
        for args in ((0, 4.4, 1.6), (50, 0.5, 1.6), (50, 21, 1.6), (50, 4.4, -1),
                     (1e9, 4.4, 1.6), (1e-9, 4.4, 1.6), (50, 4.4, math.inf)):
            with self.subTest(line=args), self.assertRaises(ValueError):
                microstrip_width(*args)
        for args in ((0, 30, 38, 2.4), (50, -30, 38, 2.4), (50, 30, 38, 0),
                     (50, 100, 38, 2.4), (50, 30, 100, 2.4), (1e9, 30, 38, 2.4),
                     (50, 30, math.nan, 2.4), (1e-300, 30, 38, 2.4)):
            with self.subTest(inset=args), self.assertRaises(ValueError):
                patch_inset(*args)

    def test_legacy_parameter_names_and_export_namespace(self):
        d, _ = specimen({})
        d["params"][0:0] = [{"key": "microstrip_width", "default": 7},
                            {"key": "patch_inset", "expr": "microstrip_width+1"},
                            {"key": "_patch_seed", "default": 2}]
        d["params"].append({"key": "combined", "expr": "microstrip_width+microstrip_width(50,eps_r,h)+patch_inset"})
        self.assertIsNone(param_key_error("microstrip_width"))
        self.assertIsNone(param_key_error("patch_inset"))
        self.assertEqual(names_in(d["params"][-1]["expr"]), {"microstrip_width", "eps_r", "h", "patch_inset"})
        n = resolve_names(d, {})
        p = {x["key"]: x["default"] for x in d["params"] if "default" in x}
        ns, _, _ = export_calculations(d, p)
        self.assertAlmostEqual(n["combined"], 15 + n["feed_w"])
        self.assertAlmostEqual(ns["combined"], n["combined"])
        old = template_design("patch", "old", "Old")
        self.assertEqual(old, blank_design("old", "Old"))
        self.assertEqual({p["key"]: p.get("default") for p in old["params"]}["W"], 32)

    def test_export_call_whitespace_and_piecewise_impedance_gap(self):
        d, _ = specimen({})
        for p in d["params"]:
            if p["key"] == "feed_w":
                p["expr"] = "(microstrip_width\t(50,eps_r,h))"
            if p["key"] == "inset":
                p["expr"] = "(patch_inset\n(50,L,W,f0))"
        n = resolve_names(d, {})
        ns, _, _ = export_calculations(d, {p["key"]: p["default"] for p in d["params"] if "default" in p})
        self.assertAlmostEqual(ns["feed_w"], n["feed_w"])
        self.assertAlmostEqual(ns["inset"], n["inset"])
        # The two textbook Z0 branches have a small jump at W/h=1. A target
        # inside the jump has no inverse; returning the boundary is misleading.
        a = analytic.microstrip_z0(4.4, 1, 1)
        b = analytic.microstrip_z0(4.4, 1, math.nextafter(1, 2))
        with self.assertRaises(ValueError):
            microstrip_width((a + b) / 2, 4.4, 1)

    def test_create_api_writes_template_without_scheduling_preview_or_run(self):
        from fairbeam.server import App
        from fairbeam import modelfiles
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fake = SimpleNamespace(models_dir=root,
                                   design_file=lambda mid: modelfiles.read_design_file(root, mid),
                                   _post_write_validation=Mock(return_value={"checks": []}))
            result = App.create_design(fake, {"id": "new_inset", "name": "New inset", "template": "inset-patch"})
            d = result["design"]
            self.assertEqual(d["model"]["id"], "new-inset")
            self.assertEqual(d["model"]["name"], "New inset")
            self.assertEqual(d["params"], template_design("inset-patch", "x", "X")["params"])
            fake._post_write_validation.assert_called_once_with("new_inset", design=True)
            check_design(d)


if __name__ == "__main__":
    if "--json" in sys.argv:
        out = []
        for inputs in cases():
            d, n = specimen(inputs)
            out.append({"design": d, "values": n, "parts": resolve_parts(d, n)})
        print(json.dumps(out))
    else:
        unittest.main()
