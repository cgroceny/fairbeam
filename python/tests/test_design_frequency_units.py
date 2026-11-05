"""HF Empty designs and the existing annotation-only parameter unit contract (releases #4)."""

import copy
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import designer_fixture  # noqa: E402
from fairbeam.design import DesignError, build, check_design, evaluate, resolve_names, resolve_parts, template_design  # noqa: E402
from fairbeam.design_checks import lint  # noqa: E402


class FrequencyUnits(unittest.TestCase):
    def hf_design(self):
        case = next(c for c in designer_fixture.load()["geometry"] if c["name"].startswith("HF empty design"))
        return designer_fixture.case_design(case)

    def test_empty_design_accepts_hf_without_rewriting_existing_limits(self):
        design = template_design("empty", "hf", "HF")
        design["params"][0]["default"] = 0.05
        check_design(design)
        self.assertNotIn("param-range", {c["code"] for c in lint(design)})
        # A saved project's explicit constraints still apply; loading must not silently erase them.
        design["params"][0].update(min=0.1, max=100)
        reopened = json.loads(json.dumps(design))
        self.assertIn("param-range", {c["code"] for c in lint(reopened)})
        self.assertEqual(reopened["params"][0]["min"], 0.1)
        self.assertEqual(template_design("patch", "patch", "Patch")["params"][0]["min"], 0.5)

    def test_two_to_fifty_mhz_reaches_native_constructor_in_hz(self):
        design = self.hf_design()
        check_design(design)
        names = resolve_names(design, {})
        self.assertAlmostEqual(evaluate(design["simulation"]["f_min"], names), 0.002)
        self.assertAlmostEqual(evaluate(design["simulation"]["f_max"], names), 0.05)
        self.assertFalse(any(c["code"] in {"param-range", "f-min", "f-order"} for c in lint(design)))
        # Observe the real design builder's unit conversion without meshing or running a solver.
        with mock.patch("fairbeam.simulation.Simulation", side_effect=RuntimeError("constructor reached")) as constructor:
            with self.assertRaisesRegex(RuntimeError, "constructor reached"):
                build(design, {})
        self.assertAlmostEqual(constructor.call_args.args[0], 2e6)
        self.assertAlmostEqual(constructor.call_args.args[1], 50e6)

    def test_nonpositive_and_reversed_bands_stay_invalid(self):
        for low, high, code in [(0, 0.05, "f-min"), (-0.002, 0.05, "f-min"), (0.05, 0.002, "f-order")]:
            with self.subTest(low=low, high=high):
                design = self.hf_design()
                design["simulation"].update(f_min=low, f_max=high)
                self.assertIn(code, {c["code"] for c in lint(design)})
                with self.assertRaises(DesignError):
                    build(design, {})

    def test_unit_annotations_preserve_numeric_geometry_on_reopen(self):
        for annotation in ("mm", "cm", ""):
            with self.subTest(annotation=annotation):
                design = self.hf_design()
                design["params"].append({"key": "w", "default": 1, "unit": annotation})
                primitive = design["parts"][0]["primitives"][0]
                primitive["start"][0], primitive["stop"][0] = "-w/2", "w/2"
                reopened = json.loads(json.dumps(design))
                before = copy.deepcopy(reopened)
                shape = resolve_parts(reopened, resolve_names(reopened, {}))[0]["prims"][0]
                self.assertEqual(shape["stop"][0] - shape["start"][0], 1)
                self.assertEqual(reopened, before)
                reopened["params"][-1]["default"] = 10
                shape = resolve_parts(reopened, resolve_names(reopened, {}))[0]["prims"][0]
                self.assertEqual(shape["stop"][0] - shape["start"][0], 10)
