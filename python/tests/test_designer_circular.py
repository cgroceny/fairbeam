"""Pure CP configuration/export/capture and synthetic field controls.

No Simulation is constructed, no mesh/model/solver is built, and no UI is opened.
--json exports the synthetic FarField records for the TypeScript mask controls.
"""
import ast
import copy
import json
import math
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fairbeam.design import (DesignError, _configure_far_field, _evaluator, blank_design,
                             check_design, resolve_names, to_python)
from fairbeam.design_checks import lint
from fairbeam.example_design import _read_design
from fairbeam.jsonutil import finite_json
from fairbeam.simulation import _circular


THETA = np.array([0., 45., 90.])
PHI = np.array([0., 90., 180., 270.])
SHAPE = (len(THETA), len(PHI))


def record(name, et, ep, directivity=None, *, theta=None):
    theta = THETA if theta is None else np.asarray(theta, float)
    shape = (len(theta), len(PHI))
    et = np.broadcast_to(np.asarray(et, complex), shape).copy()
    ep = np.broadcast_to(np.asarray(ep, complex), shape).copy()
    d = np.full(shape, 10.) if directivity is None else np.asarray(directivity, float)
    finite = d[np.isfinite(d)]
    return {"name": name, "f": 2.4e9, "theta": theta.tolist(), "phi": PHI.tolist(),
            "directivity_dbi": d.tolist(), "dmax_dbi": float(finite.max()) if len(finite) else math.nan,
            "rad_efficiency": None, "prad_w": 1., "pacc_w": None,
            "cp": _circular(SimpleNamespace(E_theta=[et], E_phi=[ep]), 0, d, theta, PHI)}


def synthetic_records():
    out = [record("rhcp", 1, -1j), record("lhcp", 1, 1j),
           record("linear", 1, 0), record("elliptical", 1, -0.5j)]
    et, ep = np.ones(SHAPE, complex), np.full(SHAPE, -1j)
    et[0, :] = ep[0, :] = 0
    d = np.full(SHAPE, 10.)
    d[0, :] = -50.
    out.append(record("null-boresight", et, ep, d))
    et[0, 0], ep[0, 1], et[0, 2] = complex(math.inf, 0), complex(math.nan, 0), 1
    d[0, 2] = math.nan
    out.append(record("nonfinite", et, ep, d))
    out.append(record("zero", 0, 0))
    d = np.array([[10., -10., -10.01, -9.99], [0., -20., -30., -50.], [10., 5., -5., -15.]])
    amplitude = 10 ** ((d - 10) / 20)
    out.append(record("low-directivity", amplitude, -1j * amplitude, d))
    out.append(record("off-boresight", 1, -0.5j, theta=[5., 45., 90.]))
    return out


def spy_sim():
    return SimpleNamespace(cp_outputs=False, pattern_freqs=None, add_nf2ff_box=Mock())


def exported_settings(d):
    """Execute only the actual generated far-field statements on a spy.

    Imports, Simulation construction and every geometry/mesh/solver call are
    excluded. This checks code generation without pretending to build a model.
    """
    tree = ast.parse(to_python(d))
    build = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "build")
    statements = []
    for n in build.body:
        if isinstance(n, ast.Assign) and any(isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name)
                and t.value.id == "sim" and t.attr in ("cp_outputs", "pattern_freqs") for t in n.targets):
            statements.append(n)
        if (isinstance(n, ast.Expr) and isinstance(n.value, ast.Call)
                and isinstance(n.value.func, ast.Attribute) and isinstance(n.value.func.value, ast.Name)
                and n.value.func.value.id == "sim" and n.value.func.attr == "add_nf2ff_box"):
            statements.append(n)
    sim = spy_sim()
    names = resolve_names(d, {})
    exec(compile(ast.Module(body=statements, type_ignores=[]), "exported-cp-settings", "exec"),
         {"sim": sim, "p": names, **names})
    return sim


class DesignerCircular(unittest.TestCase):
    def test_default_and_explicit_flags_preserve_existing_schema(self):
        for value in (None, False, True):
            d = blank_design("cp-test", "CP test")
            if value is not None:
                d["far_field"]["circular"] = value
            original = copy.deepcopy(d)
            check_design(d)
            self.assertEqual(d, original)
            self.assertEqual(d["schema"], "fairbeam.design/1")
            self.assertFalse(any(c["path"] == "far_field.circular" for c in lint(d)))
        self.assertNotIn("circular", blank_design("old", "Old")["far_field"])

    def test_invalid_flags_fail_even_when_far_field_disabled(self):
        for enabled in (False, True):
            for value in (None, 0, 1, "true", "false", [], {}):
                with self.subTest(enabled=enabled, value=value):
                    d = blank_design("bad-cp", "Bad CP")
                    d["far_field"] = {"enabled": enabled, "circular": value}
                    with self.assertRaises(DesignError) as failure:
                        check_design(d)
                    self.assertEqual(failure.exception.where, "far_field.circular")
                    checks = lint(d)
                    self.assertEqual([(c["severity"], c["path"], c["code"]) for c in checks],
                                     [("error", "far_field.circular", "expr")])

    def test_model_and_export_settings_do_not_enable_a_disabled_monitor(self):
        for enabled in (False, True):
            for value in (None, False, True):
                with self.subTest(enabled=enabled, value=value):
                    d = blank_design("cp-settings", "CP settings")
                    ff = {"enabled": enabled, "frequencies": ["f0"], "phase_center": [1, 2, "h"],
                          "faces": [True, True, True, True, True, False]}
                    if value is not None:
                        ff["circular"] = value
                    d["far_field"] = ff
                    sim = spy_sim()
                    num, vec = _evaluator(resolve_names(d, {}))
                    _configure_far_field(sim, ff, num, vec)
                    exported = exported_settings(d)
                    for got in (sim, exported):
                        self.assertIs(got.cp_outputs, value is True)
                        self.assertEqual(got.add_nf2ff_box.call_count, int(enabled))
                        if enabled:
                            self.assertEqual(got.pattern_freqs, [2.45e9])
                            got.add_nf2ff_box.assert_called_once_with(center=[1, 2, 1.524], directions=ff["faces"])
                        else:
                            self.assertIsNone(got.pattern_freqs)

    def test_capture_preserves_cp_request_without_building_native_geometry(self):
        for enabled in (False, True):
            for value in (False, True):
                with self.subTest(enabled=enabled, value=value):
                    sim = SimpleNamespace(unit=1e-3, excitation={"type": "gaussian-derivative"},
                        nf2ff=object() if enabled else None, cp_outputs=value, nf2ff_faces=None,
                        nf2ff_center=None, pattern_freqs=[2.4e9], csx=None, materials={}, ports=[],
                        lumped_elements=[], current_freqs=None, f_min=2e9, f_max=3e9,
                        boundaries=["PML_8"] * 6, end_criteria_db=-60, max_timesteps=100)
                    module = SimpleNamespace(build=lambda _values: sim)
                    # These native geometry/port readers are outside this flag contract.
                    with patch("fairbeam.example_design._check_reconstructible_ports"), \
                            patch("fairbeam.example_design._coaxial_generated", return_value={}), \
                            patch("fairbeam.example_design.read_structure", return_value=([], [], None)):
                        _, captured = _read_design(module, {}, Path("synthetic.py"))
                    self.assertEqual(captured["far_field"]["enabled"], enabled)
                    self.assertIs(captured["far_field"].get("circular", False), value)
                    if not value:
                        self.assertNotIn("circular", captured["far_field"])

    def test_ieee_handedness_linear_and_elliptical_controls(self):
        fixtures = {x["name"]: x for x in synthetic_records()}
        for name, dominant in (("rhcp", "rhcp_dbi"), ("lhcp", "lhcp_dbi")):
            cp = fixtures[name]["cp"]
            self.assertEqual(cp["boresight"][dominant], 10)
            self.assertEqual(cp["boresight"]["axial_ratio_db"], 0)
            self.assertEqual(cp["axial_ratio_db"], np.zeros(SHAPE).tolist())
        linear = fixtures["linear"]["cp"]["boresight"]
        self.assertAlmostEqual(linear["rhcp_dbi"], 10 - 10 * math.log10(2), delta=0.001)
        self.assertEqual(linear["rhcp_dbi"], linear["lhcp_dbi"])
        self.assertEqual(linear["axial_ratio_db"], 60)
        elliptical = fixtures["elliptical"]["cp"]
        self.assertAlmostEqual(elliptical["boresight"]["axial_ratio_db"], 20 * math.log10(2), delta=0.001)
        point = elliptical["boresight"]
        self.assertAlmostEqual(10 ** (point["rhcp_dbi"] / 10) + 10 ** (point["lhcp_dbi"] / 10), 10, delta=0.002)
        conjugated = record("conjugated", 1, 0.5j)["cp"]
        self.assertEqual(conjugated["rhcp_dbi"], elliptical["lhcp_dbi"])
        self.assertEqual(conjugated["axial_ratio_db"], elliptical["axial_ratio_db"])

    def test_zero_nonfinite_and_invalid_directivity_remain_missing(self):
        fixtures = {x["name"]: x for x in synthetic_records()}
        for name in ("null-boresight", "nonfinite", "zero"):
            cp = finite_json(fixtures[name]["cp"])
            for key in ("rhcp_dbi", "lhcp_dbi", "axial_ratio_db"):
                self.assertIsNone(cp["boresight"][key])
                self.assertIsNone(cp[key][0][0])
            if name != "zero":
                self.assertEqual(cp["axial_ratio_db"][1][0], 0)
                self.assertEqual(cp["peak"]["axial_ratio_db"], 0)
        all_invalid = record("all-invalid", 1, -1j, np.full(SHAPE, math.nan))
        self.assertTrue(all(v is None for row in finite_json(all_invalid)["cp"]["axial_ratio_db"] for v in row))
        for name in ("nonfinite", "all-invalid"):
            doc = fixtures[name] if name in fixtures else all_invalid
            json.dumps(finite_json(doc), allow_nan=False)

    def test_cp_is_invariant_to_common_phase_and_extreme_amplitude(self):
        baseline = record("base", 1, -0.5j)["cp"]
        for amplitude in (1e-300, 1, 1e300):
            for phase in (0., 0.37, -2.1):
                with self.subTest(amplitude=amplitude, phase=phase):
                    w = amplitude * np.exp(1j * phase)
                    cp = record("scaled", w, -0.5j * w)["cp"]
                    self.assertEqual(cp, baseline)

    def test_boresight_requires_an_actual_zero_theta_sample(self):
        off = next(x for x in synthetic_records() if x["name"] == "off-boresight")
        self.assertEqual(off["theta"], [5., 45., 90.])
        cp = off["cp"]
        for key in ("rhcp_dbi", "lhcp_dbi", "axial_ratio_db"):
            self.assertTrue(math.isnan(cp["boresight"][key]))
            self.assertIsNone(finite_json(cp)["boresight"][key])
            self.assertTrue(all(math.isfinite(v) for row in cp[key] for v in row))
            self.assertTrue(math.isfinite(cp["peak"][key]))
        json.dumps(finite_json(off), allow_nan=False)
        # Deliberately put the actual +z sample after a different polarization.
        ep = np.full(SHAPE, -0.5j)
        ep[1, :] = -1j
        reordered = record("reordered", 1, ep, theta=[45., 0., 90.])["cp"]
        self.assertEqual(reordered["axial_ratio_db"][0][0], 6.02)
        self.assertEqual(reordered["boresight"]["axial_ratio_db"], 0)
        self.assertEqual(reordered["boresight"]["rhcp_dbi"], 10)

    def test_json_fixtures_cover_mask_boundary_without_changing_stored_ar(self):
        fixtures = json.loads(json.dumps(finite_json(synthetic_records()), allow_nan=False))
        low = next(x for x in fixtures if x["name"] == "low-directivity")
        self.assertEqual(low["directivity_dbi"][0], [10, -10, -10.01, -9.99])
        self.assertEqual(low["cp"]["axial_ratio_db"], np.zeros(SHAPE).tolist())
        self.assertEqual({x["name"] for x in fixtures},
                         {"rhcp", "lhcp", "linear", "elliptical", "null-boresight", "nonfinite", "zero", "low-directivity", "off-boresight"})


if __name__ == "__main__":
    if "--json" in sys.argv:
        print(json.dumps(finite_json(synthetic_records()), allow_nan=False))
    else:
        unittest.main()
