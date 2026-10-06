"""Round-trip coverage for the bundled Python examples."""

import math
import json
import re
import numpy as np
import unittest
from pathlib import Path

from fairbeam.example_design import ExampleConversionError, conversion_preview, convert_example
from fairbeam.geometry import read_structure
from fairbeam.model import load_model, resolve_params


MODELS = Path(__file__).resolve().parents[1] / "models"
EXPECTED_REFUSALS = {
    "helix_axial": "curve",
}


def cell_count(sim):
    return math.prod(max(len(sim.mesh.GetLines(axis)) - 1, 1) for axis in "xyz")


def _strings(value):
    if isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)
    elif isinstance(value, str):
        yield value


def _built_signature(sim):
    """Small, solver-free signature for changes that affect a constructed Design."""
    return (cell_count(sim), tuple(tuple(float(x) for x in sim.mesh.GetLines(a)) for a in "xyz"),
            sim.f_min, sim.f_max, sim.boundaries,
            tuple((p.get("start"), p.get("stop"), p.get("R")) for p in sim.ports),
            tuple((e.get("name"), e.get("R")) for e in sim.lumped_elements),
            tuple(sorted((k, m.get("tan_d"), m.get("tan_d_freq")) for k, m in sim.materials.items())),
            tuple((part["name"], part.get("material", {}).get("eps_r"),
                   tuple(tuple(p["bbox"][0]) + tuple(p["bbox"][1]) for p in part["primitives"]))
                  for part in read_structure(sim.csx, sim.materials)[0]))


class ExampleDesignTests(unittest.TestCase):
    def test_conversion_preview_checks_all_convertible_examples(self):
        files = sorted(p for p in MODELS.glob("*.py") if p.stem not in EXPECTED_REFUSALS)
        self.assertEqual(len(files), 12)
        from fairbeam.design import build

        for source in files:
            with self.subTest(model=source.stem):
                module = load_model(source)
                overrides = {}
                # The public iteration-0 bundle is the source configuration represented by this example.
                if source.stem == "sierpinski_monopole":
                    bundle_path = MODELS.parents[1] / "public" / "projects" / "sierpinski-monopole--iterations-0.json"
                    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
                    overrides = {p["key"]: str(p["value"]) for p in bundle["model"]["params"]}
                preview = conversion_preview(source, source.stem, module.MODEL["name"], overrides or None)
                design = preview["design"]
                source_values = resolve_params(module.PARAMS, overrides)
                source_sim = module.build(source_values)
                self.assertEqual(preview["source_cells"], cell_count(source_sim))
                source_lines = {axis: [round(float(v), 6) for v in source_sim.mesh.GetLines(axis)] for axis in "xyz"}
                self.assertEqual(design["mesh"]["mode"], "manual")
                # a line that follows a parameter is an expression; at the defaults it is the source's line
                self.assertEqual({a: len(v) for a, v in design["mesh"]["lines"].items()},
                                 {a: len(v) for a, v in source_lines.items()}, source.stem)
                self.assertEqual(design["mesh"]["automatic"]["mode"], "design")
                self.assertIn("example's own mesh lines", design["model"]["description"])
                values = {p["key"]: p["default"] for p in design["params"]}
                built = build(design, values)
                self.assertEqual(preview["design_cells"], cell_count(built))
                self.assertEqual(preview["source_cells"], preview["design_cells"], source.stem)
                for axis in "xyz":
                    np.testing.assert_allclose(built.mesh.GetLines(axis), source_lines[axis], rtol=0, atol=1e-9)
                if preview["within_tolerance"]:
                    self.assertGreaterEqual(preview["design_cells"], 0.7 * preview["source_cells"])
                    self.assertLessEqual(preview["design_cells"], 1.3 * preview["source_cells"])
                else:
                    description = design["model"]["description"]
                    self.assertIn(f"{preview['source_cells']:,}", description)
                    self.assertIn(f"{preview['design_cells']:,}", description)

                # Every exposed numeric parameter must occur in a live Design expression and
                # survive an altered-value build. Compare complete mesh/port/frequency signatures.
                live_design = {key: design.get(key) for key in
                               ("simulation", "materials", "parts", "ports", "resistors", "mesh", "far_field", "monitors")}
                expressions = list(_strings(live_design))
                for param in design["params"]:
                    key = param["key"]
                    token = re.compile(rf"\b{re.escape(key)}\b")
                    self.assertTrue(any(token.search(expression) for expression in expressions), key)
                    default = float(param["default"])
                    candidate = default * 1.07 if default else 0.13
                    if "min" in param:
                        candidate = max(candidate, float(param["min"]) + 0.001)
                    if "max" in param:
                        candidate = min(candidate, float(param["max"]) - 0.001)
                    if candidate == default:
                        candidate = default + 0.17
                    changed = dict(values)
                    changed[key] = candidate
                    if (source.stem, key) == ("pyramidal_horn", "f0"):
                        continue   # f0 only sets the pattern frequency here: the horn's size follows the gain
                    self.assertTrue(_built_signature(build(design, changed)) != _built_signature(built),
                                    f"{source.stem}: changing {key} changes nothing")

                # Preserve the example's phase centre through the converted Design build.
                if getattr(source_sim, "nf2ff", None):
                    expected = getattr(source_sim, "nf2ff_center", None)
                    # a coordinate that follows a parameter is an expression that gives the same centre
                    self.assertEqual(len(design["far_field"].get("phase_center") or []), len(expected or []), source.stem)
                    np.testing.assert_allclose(getattr(built, "nf2ff_center", None), expected, rtol=0, atol=1e-9)

    def test_patch_antenna_keeps_its_parameters(self):
        source = MODELS / "patch_antenna.py"
        module = load_model(source)
        preview = conversion_preview(source, "patch_antenna", "Patch copy")
        design = preview["design"]
        keys = [p["key"] for p in design["params"]]
        # every numeric parameter that reaches the geometry, materials, port or band; the mesh-only ones stay out
        self.assertEqual(keys, ["patch_w", "patch_l", "sub_size", "sub_h", "eps_r", "tan_d", "feed_x", "f_min", "f_max"])
        self.assertEqual((preview["params_carried"], preview["params_total"]), (9, len(module.PARAMS)))
        self.assertEqual(preview["params_partial"], [])
        self.assertGreaterEqual(preview["expressions"], 20)
        patch = next(p for p in design["parts"] if p["name"] == "patch")["primitives"][0]
        self.assertEqual(patch["start"], ["-patch_w/2", "-patch_l/2", "sub_h"])
        self.assertEqual(patch["stop"], ["patch_w/2", "patch_l/2", "sub_h"])
        self.assertEqual(design["ports"][0]["start"], ["feed_x", 0.0, 0.0])
        sub = next(m for m in design["materials"] if m["kind"] == "dielectric")
        self.assertEqual((sub["eps_r"], sub["tan_d"], sub["tan_d_freq"]), ("eps_r", "tan_d", "f_min/2 + f_max/2"))
        # the parameter's range and label come along
        by_key = {p["key"]: p for p in design["params"]}
        self.assertEqual((by_key["sub_h"]["unit"], by_key["sub_h"]["min"], by_key["sub_h"]["default"]), ("mm", 0.05, 1.524))
        self.assertIn("mesh_div=30", design["model"]["description"])
        # one metal material for the patch and the ground plane, as in the source
        self.assertEqual([m["kind"] for m in design["materials"]], ["metal", "dielectric"])
        self.assertEqual({p["material"] for p in design["parts"] if p["name"] in ("patch", "gnd")}, {"metal"})

    def test_a_changed_parameter_moves_the_design_like_the_model(self):
        from fairbeam.design import build

        for source in sorted(p for p in MODELS.glob("*.py") if p.stem not in EXPECTED_REFUSALS):
            with self.subTest(model=source.stem):
                module = load_model(source)
                overrides = {}
                if source.stem == "sierpinski_monopole":
                    bundle = json.loads((MODELS.parents[1] / "public" / "projects" / "sierpinski-monopole--iterations-0.json").read_text(encoding="utf-8"))
                    overrides = {p["key"]: str(p["value"]) for p in bundle["model"]["params"]}
                preview = conversion_preview(source, source.stem, "Copy", overrides or None)
                design, partial = preview["design"], set(preview["params_partial"])
                defaults = {p["key"]: p["default"] for p in design["params"]}
                base = resolve_params(module.PARAMS, overrides)
                for param in design["params"]:
                    key, p0 = param["key"], defaults[param["key"]]
                    value = p0 + 1 if isinstance(p0, int) else p0 * 1.1 if p0 else 0.5
                    if "max" in param and value > param["max"]:
                        value = p0 * 0.9
                    changed = build(design, {**defaults, key: value})      # must build: mesh and ports follow
                    if key in partial:
                        continue
                    want = module.build({**base, key: value})
                    got_parts = read_structure(changed.csx, changed.materials)[0]
                    want_parts = read_structure(want.csx, want.materials)[0]
                    self.assertEqual([p["name"] for p in got_parts], [p["name"] for p in want_parts])
                    for a, b in zip(got_parts, want_parts):
                        for u, w in zip(a["primitives"], b["primitives"]):
                            np.testing.assert_allclose(u["bbox"], w["bbox"], rtol=0, atol=2e-6, err_msg=f"{source.stem}: {key}")
                        if a["type"] == "Material":
                            self.assertAlmostEqual(a["material"]["eps_r"], b["material"]["eps_r"], places=8)
                    for got, wanted in zip(changed.ports, want.ports):
                        np.testing.assert_allclose(got["start"], wanted["start"], rtol=0, atol=2e-6, err_msg=f"{source.stem}: {key}")
                        np.testing.assert_allclose(got["stop"], wanted["stop"], rtol=0, atol=2e-6, err_msg=f"{source.stem}: {key}")
                    self.assertAlmostEqual(changed.f_min, want.f_min, delta=1)
                    self.assertAlmostEqual(changed.f_max, want.f_max, delta=1)

    def test_expression_text(self):
        from fairbeam.example_design import _expression, _steps
        from fairbeam.model import Param
        p0 = {"a": 32.0, "b": 1.524}
        self.assertEqual(_expression({"a": -0.5}, p0, -16.0), "-a/2")
        self.assertEqual(_expression({"a": 0.5, "b": 1.0}, p0, 17.524), "a/2 + b")
        self.assertEqual(_expression({"a": 0.75}, p0, 25.0), "3*a/4 + 1")
        self.assertEqual(_expression({"a": 1.0}, p0, 31.5), "a - 0.5")
        self.assertEqual(_expression({"a": -1.0}, p0, 0.0), "-a + 32")
        # a coefficient that is no small fraction is written out
        self.assertEqual(_expression({"a": 0.577350269190}, {"a": 48.0}, 27.712813), "0.57735026919*a + 0.00000007888")
        self.assertEqual(_steps(Param("x", 10.0, "x", minimum=9.5), 10.0), (11.0, 12.0))
        self.assertEqual(_steps(Param("n", 4, "n", minimum=1, maximum=16), 4), (5, 3))
        self.assertIsNone(_steps(Param("n", 4, "n", minimum=4, maximum=4), 4))

    def test_selected_example_values_are_built(self):
        file = "sierpinski-monopole--iterations-0.json"
        bundle = json.loads((MODELS.parents[1] / "public" / "projects" / file).read_text(encoding="utf-8"))
        overrides = {p["key"]: str(p["value"]) for p in bundle["model"]["params"]}
        design = convert_example(MODELS / "sierpinski_monopole.py", "sierpinski_copy", "Sierpinski copy", overrides, file)
        # structural parameters (iterations, ...) are frozen at the selected values and named in the description
        self.assertEqual([p["key"] for p in design["params"]], ["height", "gap", "f_min", "f_max"])
        self.assertIn("iterations=0", design["model"]["description"])
        model = load_model(MODELS / "sierpinski_monopole.py")
        original = model.build(resolve_params(model.PARAMS, overrides))
        self.assertEqual(sum(len(p["primitives"]) for p in design["parts"]),
                         sum(len(p["primitives"]) for p in read_structure(original.csx, original.materials)[0]))
        self.assertIn(file, design["model"]["description"])

    def test_all_bundled_models_build_or_refuse_specifically(self):
        files = sorted(MODELS.glob("*.py"))
        self.assertEqual(len(files), 13)
        outcomes = []
        for source in files:
            with self.subTest(model=source.stem):
                module = load_model(source)
                original = module.build(resolve_params(module.PARAMS, {}))
                physical, _, _ = read_structure(original.csx, original.materials)
                original_geometry = sum(len(part["primitives"]) for part in physical)
                original_cells = cell_count(original)
                try:
                    design = convert_example(source, source.stem, module.MODEL["name"])
                except ExampleConversionError as exc:
                    self.assertTrue(str(exc).strip(), "refusal needs a specific reason")
                    outcomes.append(f"{source.stem}: refused ({exc}); source geometry={original_geometry}, cells={original_cells}")
                    self.assertIn(source.stem, EXPECTED_REFUSALS)
                    self.assertIn(EXPECTED_REFUSALS[source.stem], str(exc))
                    continue
                from fairbeam.design import build
                from fairbeam.design_checks import lint
                values = {p["key"]: p["default"] for p in design["params"]}
                # a converted example must open in Design without errors (e.g. reversed box corners)
                # with the preview bundle, as the app lints it (the bundle rounds its mesh arrays)
                from fairbeam.preview import build_preview
                preview = build_preview(None, {}, design=design)["bundle"]
                errors = [c for c in lint(design, values, preview) if c.get("severity") == "error"]
                self.assertEqual(errors, [], f"{source.stem}: {[c.get('message') for c in errors]}")
                rebuilt = build(design, values)
                # every port sheet must sit exactly on mesh lines, or openEMS drops it as unused
                for port in rebuilt.ports:
                    for axis, name in enumerate("xyz"):
                        if abs(port["start"][axis] - port["stop"][axis]) < 1e-12:
                            lines = rebuilt.mesh.GetLines(name)
                            gap = min(abs(float(v) - port["start"][axis]) for v in lines)
                            self.assertLess(gap, 1e-9, f"{source.stem}: port {port['number']} is {gap} mm off the {name} lines")
                converted_geometry = sum(len(part["primitives"]) for part in design["parts"])
                converted_cells = cell_count(rebuilt)
                self.assertEqual(converted_geometry, original_geometry, source.stem)
                rebuilt_parts, _, _ = read_structure(rebuilt.csx, rebuilt.materials)
                # coordinates are rounded to the mesh precision (1e-6 mm); everything else must match exactly
                self.assertEqual(len(rebuilt.ports), len(original.ports))
                for got, want in zip(rebuilt.ports, original.ports):
                    for key in set(got) | set(want):
                        a, b = got.get(key), want.get(key)
                        if isinstance(a, list) and isinstance(b, list):
                            self.assertTrue(np.allclose(a, b, atol=1e-6), f"{source.stem}: port {key} {a} != {b}")
                        else:
                            self.assertEqual(a, b, f"{source.stem}: port {key}")
                self.assertEqual(rebuilt.boundaries, original.boundaries)
                self.assertEqual((rebuilt.f_min, rebuilt.f_max), (original.f_min, original.f_max))
                self.assertEqual([p["name"] for p in rebuilt_parts], [p["name"] for p in physical])
                for before, after in zip(physical, rebuilt_parts):
                    self.assertEqual(before["type"], after["type"])
                    if before["type"] == "Material":
                        for key in ("eps_r", "kappa", "mu_r"):
                            self.assertAlmostEqual(before["material"][key], after["material"][key], places=8)
                    self.assertEqual([p["kind"] for p in before["primitives"]],
                                     [p["kind"] for p in after["primitives"]])
                    for old, new in zip(before["primitives"], after["primitives"]):
                        np.testing.assert_allclose(old["bbox"], new["bbox"], rtol=0, atol=1e-8)
                self.assertIn(source.name, design["model"]["description"])
                self.assertIn("frozen at example defaults", design["model"]["description"])
                self.assertEqual(design["model"]["id"], source.stem.replace("_", "-"))
                outcomes.append(f"{source.stem}: built; geometry {original_geometry}->{converted_geometry}, "
                                f"cells {original_cells}->{converted_cells}")
        print("\nExample conversion observations:\n" + "\n".join(outcomes))


if __name__ == "__main__":
    unittest.main()
