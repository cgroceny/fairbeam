"""Design/native in-memory integration for #238; never runs field propagation."""
import copy
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from fairbeam import Simulation
from fairbeam.design import build, check_design, empty_design, resolve_names, to_python
from fairbeam.design_checks import lint
from fairbeam.example_design import conversion_preview
from fairbeam.local_mesh import LocalMeshError, apply_regions, capture_design_regions
from fairbeam.preview import design_checks


def design():
    d = empty_design("local-regions", "Local regions")
    d["materials"] = [{"name": "pec", "kind": "metal"}]
    d["parts"] = [{"name": "cube", "material": "pec", "primitives": [{"kind": "box", "start": [-1] * 3, "stop": [1] * 3}]}]
    d["ports"] = []
    d["simulation"].update(f_min=1, f_max=2, max_timesteps=1000, boundaries="MUR")
    d["far_field"] = {"enabled": False}
    d["mesh"] = {"mode": "auto", "pad": 2, "edge_rule": "edge", "cells_per_wavelength": 20}
    return d


def region(cap=.5):
    return {"id": "region_1", "name": "Local box", "start": [-.1] * 3, "stop": [.1] * 3, "cell_size": cap}


def arrays(sim):
    return [np.asarray(sim.mesh.GetLines(a), float) for a in "xyz"]


class DesignLocalRegions(unittest.TestCase):
    def test_same_simulation_replacement_and_empty_clear_old_capture(self):
        d = design(); d["mesh"]["local_regions"] = [region()]
        sim = build(d, {})
        self.assertTrue(hasattr(sim, "_design_local_mesh"))
        sim._mesh_axis_precision = True
        replacement = region(.75); replacement["id"] = "replacement"
        sim.auto_mesh(pad=2, edge_rule="edge", keep_existing=False, local_regions=[replacement])
        self.assertEqual(sim._local_mesh_state["regions"][0]["id"], "replacement")
        self.assertFalse(hasattr(sim, "_design_local_mesh"))
        self.assertFalse(hasattr(sim, "_mesh_axis_precision"))
        sim.auto_mesh(pad=2, edge_rule="edge", keep_existing=False, local_regions=[])
        self.assertFalse(hasattr(sim, "_local_mesh_state"))
        self.assertNotIn("local_refinement", sim.mesh_report)
        self.assertNotIn("axis_precision", sim.to_bundle({}, [])["mesh"])

    def test_generation_failure_blocks_partial_grid_export_until_fresh_success(self):
        sim = build(design(), {})
        bad = region(); bad["start"][0] = -1000
        with self.assertRaises(LocalMeshError):
            sim.auto_mesh(pad=2, edge_rule="edge", local_regions=[bad])
        with self.assertRaisesRegex(LocalMeshError, "generation failed"):
            sim.to_bundle({}, [])
        sim.auto_mesh(pad=2, edge_rule="edge", keep_existing=False)
        self.assertNotIn("local_refinement", sim.to_bundle({}, [])["mesh"]["auto"])

    def test_empty_list_matches_legacy_exact_arrays_and_report(self):
        old, new = design(), design()
        new["mesh"]["local_regions"] = []
        a, b = build(old, {}), build(new, {})
        for x, y in zip(arrays(a), arrays(b)):
            np.testing.assert_array_equal(x, y)
        self.assertEqual(a.mesh_report, b.mesh_report)
        self.assertEqual(a.to_bundle({}, [])["mesh"], b.to_bundle({}, [])["mesh"])

    def test_active_direct_and_generated_python_have_exact_arrays(self):
        d = design()
        d["params"] = [{"key": "h", "default": 1}, {"key": "half", "expr": "h/2"}]
        d["mesh"]["local_regions"] = [region("half")]
        direct = build(d, {})
        self.assertFalse(hasattr(direct, "_mesh_generation_error"))
        module = {}
        exec(compile(to_python(d), "generated-local-regions.py", "exec"), module)
        generated = module["build"]({"h": 1})
        for x, y in zip(arrays(direct), arrays(generated)):
            np.testing.assert_array_equal(x, y)
        self.assertEqual(direct.mesh_report["local_refinement"], generated.mesh_report["local_refinement"])
        self.assertEqual(generated._design_local_mesh["local_regions"], d["mesh"]["local_regions"])
        for x in arrays(direct):
            widths = np.diff(x)[(x[:-1] < .1) & (x[1:] > -.1)]
            self.assertTrue(np.all(widths <= math.nextafter(.5, math.inf)))

    def test_automatic_timesteps_uses_finalized_local_cfl_in_both_paths(self):
        d = design(); d["simulation"]["max_timesteps"] = "auto"
        d["mesh"]["local_regions"] = [region()]
        a = build(d, {})
        module = {}; exec(compile(to_python(d), "generated-local-auto.py", "exec"), module)
        b = module["build"]({})
        self.assertEqual(a.max_timesteps, b.max_timesteps)
        self.assertEqual(a.mesh_report["timestep_s"], a.mesh_report["local_refinement"]["final"]["timestep_s"])

    def test_inactive_manual_preserves_expressions_without_evaluation(self):
        d = design()
        d["mesh"] = {"mode": "manual", "lines": dict.fromkeys("xyz", [-3, -1, 0, 1, 3]),
                     "local_regions": [region("missing_parameter")], "axis_precision": "float64"}
        d["mesh"]["local_regions"][0]["stop"] = [-2] * 3
        check_design(d)
        a = build(d, {})
        module = {}; exec(compile(to_python(d), "inactive.py", "exec"), module)
        b = module["build"]({})
        self.assertNotIn("local_refinement", a.mesh_report)
        self.assertEqual(a._design_local_mesh["local_regions"], d["mesh"]["local_regions"])
        for x, y in zip(arrays(a), arrays(b)):
            np.testing.assert_array_equal(x, y)
        self.assertFalse(any(c["code"] == "mesh-local-region" for c in lint(d)))

    def test_active_domain_and_schema_failures_keep_precise_preview_fields(self):
        d = design(); d["mesh"]["local_regions"] = [region()]
        d["mesh"]["local_regions"][0]["start"][0] = -1000
        with self.assertRaises(LocalMeshError) as caught:
            build(d, {})
        checks = design_checks(d, {}, None, caught.exception)
        self.assertTrue(any(c["code"] == "mesh-local-region" and c["path"] == "mesh.local_regions[0].start[0]" for c in checks))
        d["mesh"]["local_regions"][0]["cell_size"] = True
        checks = lint(d)
        self.assertTrue(any(c["code"] == "mesh-local-region" and c["path"].endswith(".cell_size") for c in checks))

    def test_budget_preview_mapping_and_ordinary_build_error_unchanged(self):
        d = design()
        failure = LocalMeshError("explicit local regions exceed the cell limit", code="mesh-local-limit")
        checks = design_checks(d, {}, None, failure)
        self.assertTrue(any(c["code"] == "mesh-local-limit" and c["path"] == "mesh.local_regions" for c in checks))
        checks = design_checks(d, {}, None, RuntimeError("ordinary"))
        self.assertTrue(any(c["code"] == "build" and c["message"] == "does not build: RuntimeError: ordinary" for c in checks))

    def test_post_build_mutation_refused_at_export_and_before_native_run(self):
        d = design(); d["mesh"]["local_regions"] = [region()]
        for boundary in ("export", "run"):
            sim = build(d, {})
            x = arrays(sim)[0]
            sim.mesh.SetLines("x", [x[0], -1, 1, x[-1]])
            with self.subTest(boundary=boundary), self.assertRaises(LocalMeshError):
                if boundary == "export":
                    sim.to_bundle({}, [])
                else:
                    # Refusal happens before a simulation directory or Run exists.
                    with tempfile.TemporaryDirectory() as tmp, patch.object(sim, "fdtd", wraps=sim.fdtd) as native:
                        native.Run.side_effect = AssertionError("native propagation must never start")
                        sim.run(str(Path(tmp) / "must-not-be-created"))

    def test_lumped_feed_planes_survive_region_insertion_and_export(self):
        d = design()
        d["ports"] = [{"number": 1, "type": "lumped", "R": 50, "start": [-1, -.5, 0], "stop": [1, .5, 0], "direction": "x", "excite": True}]
        d["mesh"]["local_regions"] = [region()]
        sim = build(d, {})
        bundle = sim.to_bundle({}, [])
        self.assertEqual(bundle["ports"][0]["number"], 1)
        for axis, points in enumerate(([-1, 1], [-.5, .5], [0])):
            for point in points:
                self.assertIn(point, arrays(sim)[axis])
        self.assertEqual(bundle["mesh"]["cells"], bundle["mesh"]["auto"]["local_refinement"]["final"]["cells"])

    def test_known_native_planar_and_coax_finalizers_are_revalidated(self):
        from tests.test_planar_ports import design as planar_design
        from tests.test_coaxial_port import design as coax_design
        # Existing manual fixtures isolate native port construction, with a
        # coarse no-op explicit cap installed before probes are attached.
        for kind, d, method in (("microstrip", planar_design(), "finalize_planar_ports"),
                                ("cpw", planar_design("cpw"), "finalize_planar_ports"),
                                ("coaxial", coax_design(), "finalize_coaxial_ports")):
            with self.subTest(kind=kind):
                with patch.object(Simulation, method, return_value=None):
                    sim = build(d, {})
                self.assertIsNone(sim._port_objs[0])
                before = arrays(sim)
                r = region(1000)
                apply_regions(sim, [r], 1.4, before)
                getattr(sim, method)()
                self.assertIsNotNone(sim._port_objs[0])
                sim.finalize_local_regions()
                bundle = sim.to_bundle({}, [])
                self.assertEqual(bundle["mesh"]["auto"]["local_refinement"]["insertion"]["added_cells"], 0)
                self.assertEqual(bundle["mesh"]["cells"], bundle["mesh"]["auto"]["local_refinement"]["final"]["cells"])
                final = copy.deepcopy(sim.mesh_report)
                getattr(sim, method)(); sim.finalize_local_regions()
                self.assertEqual(sim.mesh_report, final)

    def test_sub_rounding_grid_bundle_json_and_marked_manual_reopen(self):
        sim = Simulation(1e9, 2e9, boundaries=["MUR"] * 6)
        sim.metal("cube").AddBox(start=[0] * 3, stop=[1e-6] * 3, priority=10)
        for axis in "xyz":
            sim.mesh.SetLines(axis, [0, 1e-6])
        sim.mesh_report = {"settings": {}, "warnings": []}
        r = {"id": "tiny", "name": "Tiny", "start": [4e-7] * 3, "stop": [6e-7] * 3, "cell_size": 1e-7}
        apply_regions(sim, [r], 1.4, [[0, 1e-6]] * 3)
        bundle = json.loads(json.dumps(sim.to_bundle({}, [])))
        self.assertEqual(bundle["mesh"]["axis_precision"], "float64")
        for axis, original in zip("xyz", arrays(sim)):
            np.testing.assert_array_equal(bundle["mesh"][axis], original)
            self.assertTrue(np.all(np.diff(bundle["mesh"][axis]) > 0))
        d = design()
        d["parts"][0]["primitives"][0].update(start=[0] * 3, stop=[1e-6] * 3)
        d["mesh"] = {"mode": "manual", "axis_precision": "float64", "lines": {a: bundle["mesh"][a] for a in "xyz"}, "local_regions": [r]}
        reopened = build(json.loads(json.dumps(d)), {})
        for axis, original in zip("xyz", arrays(sim)):
            np.testing.assert_array_equal(reopened.to_bundle({}, [])["mesh"][axis], original)

    def test_generated_symbolic_regions_survive_python_to_design_conversion(self):
        d = design()
        d["params"] = [{"key": "h", "default": 1}, {"key": "half", "expr": "h/2"}]
        d["mesh"]["local_regions"] = [region("half")]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "local_region_export.py"
            path.write_text(to_python(d), encoding="utf-8")
            result = conversion_preview(path, "local_regions", "Local regions")
        converted = result["design"]
        self.assertEqual(converted["mesh"]["mode"], "manual")
        self.assertEqual(converted["mesh"]["axis_precision"], "float64")
        self.assertEqual(converted["mesh"]["local_regions"], d["mesh"]["local_regions"])
        self.assertEqual(resolve_names(converted, {})["half"], .5)
        direct, reopened = build(d, {}), build(converted, {})
        for x, y in zip(arrays(direct), arrays(reopened)):
            np.testing.assert_array_equal(x, y)
        self.assertEqual(result["source_cells"], result["design_cells"])
        self.assertTrue(any(n["code"] == "meshRegionExpressions" for n in converted["model"]["conversion"]["notes"]))

    def test_marker_rejects_unknown_value_and_ordinary_manual_retains_legacy_rounding(self):
        d = design(); d["mesh"]["axis_precision"] = "float32"
        with self.assertRaisesRegex(ValueError, "axis precision must be float64"):
            check_design(d)
        d["mesh"] = {"mode": "manual", "lines": dict.fromkeys("xyz", [-3, -1, .123456789, 1, 3]), "local_regions": [region("not_available")]}
        sim = build(d, {})
        bundle = sim.to_bundle({}, [])
        self.assertNotIn("axis_precision", bundle["mesh"])
        self.assertIn(.1235, bundle["mesh"]["x"])


if __name__ == "__main__":
    unittest.main()
