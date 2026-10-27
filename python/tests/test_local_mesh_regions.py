"""Actual-array controls for explicit regions. No field propagation."""
import copy
import math
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from fairbeam.design import evaluate
from fairbeam.local_mesh import (LocalMeshError, apply_regions, captured_regions, capture_design_regions,
                                 finalize_regions, interval_union, region_checks, resolve_regions)


def box(ident="r", start=(.4, .4, .4), stop=(.6, .6, .6), cap=.25):
    return dict(id=ident, name=ident, start=list(start), stop=list(stop), cell_size=cap)


class Grid:
    def __init__(self, axes):
        self.axes = [np.asarray(x, float).copy() for x in axes]
    def GetLines(self, a):
        return self.axes["xyz".index(a) if isinstance(a, str) else a]
    def SetLines(self, a, lines):
        self.axes["xyz".index(a) if isinstance(a, str) else a] = np.asarray(lines, float).copy()


def fixture(lines=(0, 1, 2), unit=.001):
    return SimpleNamespace(mesh=Grid([lines] * 3), unit=unit, mesh_report={})


def request(sim, regions, ratio=1.4):
    protected = [x.copy() for x in sim.mesh.axes]
    apply_regions(sim, regions, ratio, protected)
    return sim.mesh_report.get("local_refinement")


class LocalMeshRegions(unittest.TestCase):
    def test_internal_insertion_validation_does_not_clear_external_pending_guard(self):
        sim = fixture()
        sim._mesh_generation_error = "mesh generation has not completed"
        report = request(sim, [box()])
        self.assertGreater(report["insertion"]["added_cells"], 0)
        self.assertEqual(sim._mesh_generation_error, "mesh generation has not completed")
        with self.assertRaisesRegex(LocalMeshError, "has not completed"):
            finalize_regions(sim)
        # Only the successful outer generator removes its lifecycle guard.
        del sim._mesh_generation_error
        finalize_regions(sim)

    def assert_caps(self, sim, regions):
        for r in regions:
            for a, x in enumerate(sim.mesh.axes):
                widths = np.diff(x)[(x[:-1] < r["stop"][a]) & (x[1:] > r["start"][a])]
                self.assertGreater(len(widths), 0)
                self.assertTrue(np.all(widths <= math.nextafter(r["cell_size"], math.inf)))

    def test_empty_preserves_axes_report_and_private_state(self):
        sim = fixture()
        sim.mesh_report = {"legacy": {"rounded": 1.23}}
        before = copy.deepcopy(sim.mesh_report)
        request(sim, [])
        self.assertEqual(sim.mesh_report, before)
        self.assertFalse(hasattr(sim, "_local_mesh_state"))
        for x in sim.mesh.axes:
            np.testing.assert_array_equal(x, [0, 1, 2])

    def test_coarse_box_inserts_no_endpoints_and_zero_cost(self):
        sim = fixture()
        r = box(start=(.00001,) * 3, stop=(.00002,) * 3, cap=1)
        report = request(sim, [r])
        self.assertEqual(report["insertion"]["added_cells"], 0)
        self.assertEqual(report["insertion"]["ratio"], 1)
        self.assertEqual(report["insertion"]["before"], report["insertion"]["after"])
        for x in sim.mesh.axes:
            np.testing.assert_array_equal(x, [0, 1, 2])

    def test_tiny_off_sampling_box_is_not_lost(self):
        sim = fixture((0, 1))
        regions = [box(start=(.123451,) * 3, stop=(.123452,) * 3, cap=.1)]
        report = request(sim, regions)
        self.assert_caps(sim, regions)
        self.assertGreater(report["insertion"]["added_cells"], 0)
        self.assertTrue(all(np.any(x == 0) and np.any(x == 1) for x in sim.mesh.axes))

    def test_touching_face_alone_has_no_cap(self):
        sim = fixture((0, 1, 2))
        r = box(start=(1,) * 3, stop=(2,) * 3, cap=.5)
        request(sim, [r], ratio=2)
        for x in sim.mesh.axes:
            # With a ceiling of 2, the unrequested [0,1] remains intact.
            np.testing.assert_array_equal(x, [0, 1, 1.5, 2])

    def test_overlap_nested_disjoint_and_order_independent(self):
        regions = [box("wide", (.2,) * 3, (1.3,) * 3, .5),
                   box("small", (.4,) * 3, (.7,) * 3, .25),
                   box("far", (1.6,) * 3, (1.8,) * 3, .4)]
        a, b = fixture(), fixture()
        request(a, regions)
        request(b, list(reversed(regions)))
        self.assert_caps(a, regions)
        for x, y in zip(a.mesh.axes, b.mesh.axes):
            np.testing.assert_array_equal(x, y)
        self.assertEqual(interval_union(regions, 0), interval_union(list(reversed(regions)), 0))
        self.assertIn((.4, .7, .25), interval_union(regions, 0))

    def test_baseline_grading_ceiling_is_honest(self):
        sim = fixture((0, .1, 1))
        report = request(sim, [box(cap=1)])
        self.assertAlmostEqual(report["grading"]["baseline_max_ratio"], 9)
        self.assertAlmostEqual(report["grading"]["admission_ceiling"], 9)
        self.assertEqual(report["insertion"]["added_cells"], 0)

    def test_grading_propagation_preserves_every_original_plane(self):
        sim = fixture((0, 1, 2, 3, 4))
        regions = [box(start=(1.2,) * 3, stop=(1.4,) * 3, cap=.2)]
        report = request(sim, regions)
        self.assert_caps(sim, regions)
        self.assertLessEqual(report["grading"]["insertion_max_ratio"], math.nextafter(1.4, math.inf))
        for x in sim.mesh.axes:
            self.assertTrue(set([0., 1., 2., 3., 4.]).issubset(x))

    def test_budget_refused_before_dense_allocation_and_no_partial_mutation(self):
        sim = fixture((0, 1))
        with patch.dict("os.environ", {"FAIRBEAM_MAX_CELLS": "100"}), patch("numpy.linspace", side_effect=AssertionError("allocated")):
            with self.assertRaises(LocalMeshError) as caught:
                request(sim, [box(cap=.1)])
        self.assertEqual(caught.exception.code, "mesh-local-limit")
        for x in sim.mesh.axes:
            np.testing.assert_array_equal(x, [0, 1])

    def test_extreme_ratio_refused_before_overflow_or_allocation(self):
        sim = fixture((0, 1))
        with patch("numpy.linspace", side_effect=AssertionError("allocated")):
            with self.assertRaises(LocalMeshError) as caught:
                request(sim, [box(cap=1e-300)])
        self.assertEqual(caught.exception.code, "mesh-local-limit")

    def test_unrepresentable_large_coordinate_cap_is_refused(self):
        sim = fixture((1e16, 1e16 + 2))
        with self.assertRaises(LocalMeshError) as caught:
            request(sim, [box(start=(1e16,) * 3, stop=(1e16 + 2,) * 3, cap=1)])
        self.assertEqual(caught.exception.code, "mesh-local-grid")

    def test_domain_is_not_clipped_or_expanded(self):
        for key, value in (("start", [-.1, .4, .4]), ("stop", [.6, 2.1, .6])):
            sim, r = fixture(), box()
            r[key] = value
            with self.subTest(key=key), self.assertRaises(LocalMeshError) as caught:
                request(sim, [r])
            self.assertEqual(caught.exception.where, f"mesh.local_regions[0].{key}[{0 if key == 'start' else 1}]")
            for x in sim.mesh.axes:
                np.testing.assert_array_equal(x, [0, 1, 2])

    def test_units_change_cfl_not_drawing_coordinate_grid(self):
        a, b = fixture(unit=.001), fixture(unit=.01)
        ar, br = request(a, [box()]), request(b, [box()])
        for x, y in zip(a.mesh.axes, b.mesh.axes):
            np.testing.assert_array_equal(x, y)
        self.assertAlmostEqual(br["final"]["timestep_s"] / ar["final"]["timestep_s"], 10)

    def test_exact_translation_preserves_intervals(self):
        a, b = fixture(), fixture((8, 9, 10))
        request(a, [box(start=(.25,) * 3, stop=(.75,) * 3, cap=.25)])
        request(b, [box(start=(8.25,) * 3, stop=(8.75,) * 3, cap=.25)])
        for x, y in zip(a.mesh.axes, b.mesh.axes):
            np.testing.assert_array_equal(x + 8, y)

    def test_final_refresh_is_idempotent_and_retains_same_stage_cost(self):
        sim = fixture()
        report = request(sim, [box(cap=1)])
        insertion = copy.deepcopy(report["insertion"])
        sim.mesh.SetLines(0, [0, .5, 1, 2])
        finalize_regions(sim)
        updated = copy.deepcopy(sim.mesh_report)
        self.assertEqual(updated["local_refinement"]["insertion"], insertion)
        self.assertEqual(updated["local_refinement"]["final"]["cells"], [3, 2, 2])
        self.assertEqual(updated["local_refinement"]["grading"]["final_max_ratio"], 2)
        self.assertEqual(updated["local_refinement"]["grading"]["insertion_max_ratio"], 1)
        finalize_regions(sim)
        self.assertEqual(sim.mesh_report, updated)

    def test_finalizer_cannot_remove_protected_line_or_violate_cap(self):
        for changed in ([0, .5, 2], [0, 1, 2, 3]):
            sim = fixture()
            request(sim, [box(cap=1)])
            sim.mesh.SetLines(0, changed)
            with self.subTest(changed=changed), self.assertRaises(LocalMeshError):
                finalize_regions(sim)
        sim = fixture()
        request(sim, [box(cap=.25)])
        sim.mesh.SetLines(0, [0, 1, 2])
        with self.assertRaisesRegex(LocalMeshError, "exceeds the requested"):
            finalize_regions(sim)

    def test_finalizer_checks_current_budget_and_invalid_axes(self):
        sim = fixture()
        request(sim, [box(cap=1)])
        with patch.dict("os.environ", {"FAIRBEAM_MAX_CELLS": "7"}), self.assertRaises(LocalMeshError) as caught:
            finalize_regions(sim)
        self.assertEqual(caught.exception.code, "mesh-local-limit")
        for lines in ([0, 1, 1, 2], [0, math.nan, 2], [0, 2, 1]):
            sim.mesh.SetLines(0, lines)
            with self.subTest(lines=lines), self.assertRaises(LocalMeshError):
                finalize_regions(sim)

    def test_schema_manual_inactive_does_not_evaluate_or_apply_numeric_rules(self):
        r = box(start=("undefined", 4, 4), stop=(0, 0, 0), cap=-1)
        self.assertEqual(resolve_regions([r], active=False), [r])
        _, errors = region_checks([r], lambda v, _p: evaluate(v, {}))
        self.assertEqual({e.where for e in errors}, {"mesh.local_regions[0].start[0]", "mesh.local_regions[0].stop[1]", "mesh.local_regions[0].stop[2]", "mesh.local_regions[0].cell_size"})

    def test_schema_rejects_invalid_shapes_ids_names_and_nonfinite_or_bool(self):
        cases = [(None, "mesh.local_regions"), ({}, "mesh.local_regions"), ([1], "mesh.local_regions[0]"),
                 ([box(str(i)) for i in range(33)], "mesh.local_regions"),
                 ([box(), box()], "mesh.local_regions[1].id")]
        for key, value in (("id", "bad id"), ("name", " \t"), ("name", "a" * 81), ("start", [1, 2]),
                           ("cell_size", True), ("cell_size", float("inf")), ("cell_size", "")):
            r = box(); r[key] = value
            cases.append(([r], "mesh.local_regions[0]." + key))
        for raw, path in cases:
            with self.subTest(raw=raw), self.assertRaises(LocalMeshError) as caught:
                resolve_regions(raw, active=False)
            self.assertEqual(caught.exception.where, path)

    def test_symbolic_capture_is_verified_and_tampering_refused(self):
        sim = fixture()
        raw = box(cap="h/2")
        params, names = [{"key": "h", "default": .5}], {"h": .5}
        resolved = resolve_regions([raw], lambda v, _p: evaluate(v, names))
        request(sim, resolved)
        capture_design_regions(sim, {"local_regions": [raw]}, params, names)
        self.assertEqual(captured_regions(sim)["local_regions"][0]["cell_size"], "h/2")
        sim._design_local_mesh["local_regions"][0]["cell_size"] = "h"
        with self.assertRaisesRegex(LocalMeshError, "differ"):
            captured_regions(sim)

    def test_generic_capture_only_claims_numeric_regions(self):
        sim = fixture(); r = box()
        request(sim, [r])
        capture = captured_regions(sim)
        self.assertEqual(capture["local_regions"], [r])
        self.assertEqual(capture["params"], [])
        self.assertEqual(capture["names"], {})


if __name__ == "__main__":
    unittest.main()
