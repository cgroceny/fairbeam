"""Synthetic complex storage/configuration controls; no native module import, build or propagation.

Load pure modules under a test-only package so fairbeam.__init__ cannot load the
native Simulation bindings. The actual evaluate method is AST-extracted and run
against explicitly synthetic port/NF2FF spies, not a simulated antenna.
"""
import ast
import base64
import copy
import importlib
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1] / "fairbeam"
PACKAGE = "_fairbeam_ludwig_pure_tests"
pkg = ModuleType(PACKAGE)
pkg.__path__ = [str(ROOT)]
sys.modules[PACKAGE] = pkg
fields = importlib.import_module(PACKAGE + ".farfield_fields")
design = importlib.import_module(PACKAGE + ".design")
checks = importlib.import_module(PACKAGE + ".design_checks")
capture = importlib.import_module(PACKAGE + ".example_design")
grid = importlib.import_module(PACKAGE + ".pattern_grid")


def encoded(et, ep, **overrides):
    shape = np.asarray(et).shape
    args = dict(frequency=2.4e9, theta=np.linspace(0, 90, shape[0]),
                phi=np.arange(shape[1]) * 360 / shape[1], e_theta=et, e_phi=ep,
                mirror_planes=1, phase_center_m=[.001, .002, .003], radius_m=1.)
    args.update(overrides)
    return fields.encode_farfield_fields(**args)


def evaluate_spy(enabled=True):
    tree = ast.parse((ROOT / "simulation.py").read_text(encoding="utf-8"))
    sim_class = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Simulation")
    method = next(n for n in sim_class.body if isinstance(n, ast.FunctionDef) and n.name == "evaluate")
    namespace = {"__package__": PACKAGE, "np": np, "sys": sys,
                 "_rf_values": lambda a: np.asarray(a).tolist(), "_zref_scalar": lambda z, _: z,
                 "_time_signals": lambda p: {}, "_bands": lambda *args: [],
                 "mirror_planes": lambda bounds: int(bounds[0] == "PEC"),
                 "_r": lambda a, digits: np.round(a, digits).tolist(),
                 "_pattern_directivity": lambda *args: None, "_efficiency_warning": lambda *args: None}
    exec(compile(ast.Module(body=[method], type_ignores=[]), "actual-evaluate-with-synthetic-spies", "exec"), namespace)
    p = SimpleNamespace(CalcPort=Mock(), Z_ref=50., uf_ref=np.full(5, .1 + 0j), uf_inc=np.ones(5),
                        uf_tot=np.ones(5), if_tot=np.full(5, .02))
    def calc(_path, frequencies, theta, phi, **kw):
        shape = (len(theta), len(phi))
        out = SimpleNamespace(E_norm=[np.full(shape, np.sqrt(2.)) for _ in frequencies],
                              Dmax=[2.] * len(frequencies), Prad=[.005] * len(frequencies), r=np.array([1.]))
        if enabled:
            out.E_theta = [np.ones(shape, complex) for _ in frequencies]
            out.E_phi = [np.full(shape, 1j) for _ in frequencies]
        return out
    sim = SimpleNamespace(sim_path="synthetic-only", f_min=2e9, f_max=3e9,
                          ports=[{"number": 1, "excite": True, "type": "lumped"}], _port_objs=[p],
                          _calibrate_waveguide_port=lambda *args: None, pattern_steps=(90., 90.),
                          pattern_freqs=[2.4e9], nf2ff_center=[1., 2., 3.], unit=.001,
                          nf2ff=SimpleNamespace(CalcNF2FF=Mock(side_effect=calc)),
                          boundaries=["PEC"] + ["PML_8"] * 5, _is_lossless=lambda: False,
                          _lossless_efficiency=lambda raw, *args: (raw, None), cp_outputs=False,
                          complex_field_outputs=enabled, efficiency_points=0)
    return sim, namespace["evaluate"]


def synthetic_records():
    """Cross-language codec/math controls, never antenna/solver measurements."""
    theta, phi = np.array([0., 45., 90., 180.]), np.array([0., 45., 90., 180., 270.])
    shape = (len(theta), len(phi))
    def record(name, et, ep, mirrors=0, amplitude=1., phase=0.):
        factor = amplitude * np.exp(1j * phase)
        et, ep = np.broadcast_to(np.asarray(et, complex), shape) * factor, np.broadcast_to(np.asarray(ep, complex), shape) * factor
        doc = encoded(et, ep, theta=theta, phi=phi, mirror_planes=mirrors)
        # Normalize before power to keep the synthetic extreme-amplitude controls finite.
        scale = doc["scale"] or 1.
        power = np.abs(et / scale) ** 2 + np.abs(ep / scale) ** 2
        peak = power.max()
        dmax = 10. + 10 * np.log10(2. ** mirrors)
        with np.errstate(divide="ignore", invalid="ignore"):
            d = np.maximum(dmax - 60, dmax + 10 * np.log10(power / peak)) if peak else np.full(shape, dmax - 60)
        return dict(name=name, f=2.4e9, theta=theta.tolist(), phi=phi.tolist(), directivity_dbi=d.tolist(),
                    dmax_dbi=dmax, prad_w=.1, pacc_w=.2, rad_efficiency=.5, mirror_planes=mirrors, fields=doc)
    radians = np.deg2rad(phi)
    x, y = np.cos(radians), -np.sin(radians)
    out = [record("linear-x", x, y), record("linear-y", -y, x), record("circular", 1, 1j),
           record("in-phase", 1, 1), record("zero", 0, 0), record("mirror", x, y, mirrors=1),
           record("complex", 1 + .4j, -.3 + .7j)]
    out += [record("phase", 1 + .4j, -.3 + .7j, phase=.37),
            record("tiny", 1 + .4j, -.3 + .7j, amplitude=1e-300),
            record("huge", 1 + .4j, -.3 + .7j, amplitude=1e300)]
    low = np.ones(shape); low[0] = [1, .101, .099, 0, 1e-4]
    out.append(record("low", low, 1j * low))
    ep = np.zeros(shape); ep[0] = 1
    out.append(record("croppable", np.ones(shape), ep))
    return out


class ComplexStorage(unittest.TestCase):
    def test_multiport_public_codec_uses_identical_shared_encoding(self):
        # Compile only the real pure codec import and encoder, never simulation/native imports.
        tree = ast.parse((ROOT / "multiport.py").read_text(encoding="utf-8"))
        imports = [n for n in tree.body if isinstance(n, ast.ImportFrom) and n.module == "farfield_fields"]
        self.assertEqual(len(imports), 1)
        method = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "encode_pattern_fields")
        ns = {"__package__": PACKAGE, "np": np, "ENC_I16": "i16le-base64-scaled", "ENC_F32": "f32le-base64",
              "FIELD_KEYS": ("e_theta_re", "e_theta_im", "e_phi_re", "e_phi_im")}
        exec(compile(ast.Module(body=[*imports, method], type_ignores=[]), "actual-pure-multiport-encoder", "exec"), ns)
        self.assertIs(ns["encode_i16_scaled"], fields.encode_i16_scaled)
        et = np.array([[1+2j, -.5-1j], [0, 3j]])
        ep = np.array([[-3j, .25], [1-1j, 0]])
        single = encoded(et, ep)
        multi = ns["encode_pattern_fields"](2.4e9, et, ep)
        for key in ("scale", *ns["FIELD_KEYS"]):
            self.assertEqual(multi[key], single[key])

    def test_shared_codec_keeps_existing_int16_bytes(self):
        scale, texts = fields.encode_i16_scaled([np.array([[0., 1., -1., .5, -.5]])])
        self.assertEqual(scale, 1.)
        self.assertEqual(base64.b64decode(texts[0]), b"\x00\x00\xff\x7f\x01\x80\x00\x40\x00\xc0")
        self.assertEqual(fields.encode_i16_scaled([]), (0., []))

    def test_common_scale_roundtrip_phase_noncontiguous_and_extreme_amplitudes(self):
        rng = np.random.default_rng(246)
        et = (rng.normal(size=(4, 6)) + 1j * rng.normal(size=(4, 6)))[:, ::2]
        ep = (.3 + .7j) * et
        for amplitude in (1e-300, 1., 1e300):
            with self.subTest(amplitude=amplitude):
                doc = encoded(et * amplitude, ep * amplitude)
                values = [np.frombuffer(base64.b64decode(doc[k]), dtype="<i2").reshape(et.shape) / 32767
                          for k in fields.FIELD_KEYS]
                scale = doc["scale"]
                for actual, original in zip(values, (et.real, et.imag, ep.real, ep.imag)):
                    np.testing.assert_allclose(actual, original * amplitude / scale, atol=.50001 / 32767, rtol=0)
                self.assertEqual(doc["shape"], [4, 3])
                self.assertEqual(doc["mirror_planes"], 1)
                self.assertEqual(doc["phase_center_m"], [.001, .002, .003])
                self.assertGreaterEqual(doc["power_peak"], 1)
                self.assertLessEqual(doc["power_peak"], 4)
                json.dumps(doc, allow_nan=False)

    def test_zero_field_and_invalid_evidence(self):
        zero = np.zeros((2, 3), complex)
        self.assertEqual(encoded(zero, zero)["scale"], 0)
        self.assertEqual(encoded(zero, zero)["power_peak"], 0)
        cases = ({"e_theta": np.ones((2, 2))}, {"e_phi": np.full((2, 3), np.nan)},
                 {"e_theta": np.full((2, 3), np.inf)}, {"mirror_planes": 4},
                 {"mirror_planes": True}, {"phase_center_m": [0, 0, np.nan]},
                 {"radius_m": 0}, {"frequency": 0}, {"theta": [90, 0]},
                 {"theta": [0, 181]}, {"phi": [0, 90, 360]})
        for case in cases:
            with self.subTest(case=case), self.assertRaises(ValueError):
                encoded(zero, zero, **case)

    def test_limits_and_nondivisor_counts_match_actual_angular_grid(self):
        fields.check_field_budget(256, 256, 4)
        fields.check_field_budget(32, 32, 16)
        for args in ((257, 256, 1), (256, 256, 5), (32, 32, 17), (0, 2, 1), (True, 1, 1)):
            with self.subTest(args=args), self.assertRaises(ValueError):
                fields.check_field_budget(*args)
        for steps in ((3, 5), (7, 11), (.25, 90), (89.999999, 89.999999), (.25, .25)):
            t, p = grid.angular_grid(*steps)
            for n in (1, 4, 16):
                expected = len(t) * len(p) <= 65536 and len(t) * len(p) * n <= 262144
                try:
                    fields.field_budget_for_steps(*steps, n)
                    actual = True
                except ValueError:
                    actual = False
                self.assertEqual(actual, expected)

    def test_evaluate_disabled_never_accesses_complex_components(self):
        sim, evaluate = evaluate_spy(False)
        out = evaluate(sim, n_freq=5)
        self.assertNotIn("fields", out["farfield"][0])
        sim.nf2ff.CalcNF2FF.assert_called_once()

    def test_evaluate_enabled_metadata_and_mirror_correction_once(self):
        sim, evaluate = evaluate_spy()
        out = evaluate(sim, n_freq=5)
        ff = out["farfield"][0]
        self.assertEqual(ff["fields"]["f"], ff["f"])
        self.assertEqual(ff["fields"]["mirror_planes"], ff["mirror_planes"])
        self.assertEqual(ff["fields"]["phase_center_m"], [.001, .002, .003])
        self.assertEqual(ff["fields"]["radius_m"], 1)
        self.assertEqual(ff["fields"]["scale"], 1)  # native field is not doubled for the image plane
        self.assertAlmostEqual(ff["dmax_dbi"], 10 * np.log10(4), delta=.0005)
        self.assertEqual(ff["prad_w"], .0025)

    def test_evaluate_refuses_budget_before_nf2ff(self):
        for kwargs in ({"theta_step": .25, "phi_step": .25}, {"pattern_freqs": [2.4e9] * 17}):
            sim, evaluate = evaluate_spy()
            with self.assertRaises(ValueError):
                evaluate(sim, n_freq=5, **kwargs)
            sim.nf2ff.CalcNF2FF.assert_not_called()


class DesignerComplexFields(unittest.TestCase):
    def test_flags_are_strict_and_optional_even_when_monitor_disabled(self):
        for enabled in (True, False):
            for value in (None, 0, 1, "true", [], {}):
                d = design.blank_design("fields", "Fields")
                d["far_field"] = {"enabled": enabled, "complex_fields": value}
                with self.subTest(enabled=enabled, value=value), self.assertRaises(design.DesignError):
                    design.check_design(d)
                self.assertEqual([(c["path"], c["code"]) for c in checks.lint(d)], [("far_field.complex_fields", "expr")])
        self.assertNotIn("complex_fields", design.blank_design("old", "Old")["far_field"])

    def test_configuration_export_and_disabled_monitor_preserve_request(self):
        for enabled in (False, True):
            for value in (None, False, True):
                d = design.blank_design("fields", "Fields")
                d["far_field"] = {"enabled": enabled, "frequencies": ["f0"]}
                if value is not None:
                    d["far_field"]["complex_fields"] = value
                before = copy.deepcopy(d)
                sim = SimpleNamespace(add_nf2ff_box=Mock(), complex_field_outputs=False)
                design._configure_far_field(sim, d["far_field"], *design._evaluator(design.resolve_names(d, {})))
                self.assertIs(sim.complex_field_outputs, value is True)
                self.assertEqual(sim.add_nf2ff_box.call_count, int(enabled))
                generated = ast.parse(design.to_python(d))
                assignments = [n for n in ast.walk(generated) if isinstance(n, ast.Assign)
                               and any(isinstance(t, ast.Attribute) and t.attr == "complex_field_outputs" for t in n.targets)]
                self.assertEqual(len(assignments), int(value is not None))
                if assignments:
                    self.assertIs(ast.literal_eval(assignments[0].value), value)
                self.assertEqual(d, before)

    def test_design_lint_and_export_reject_excessive_enabled_request(self):
        for options in ({"theta_step": .25, "phi_step": .25}, {"frequencies": ["f0"] * 17}):
            d = design.blank_design("budget", "Budget")
            d["far_field"].update(complex_fields=True, **options)
            self.assertIn(("far_field.complex_fields", "ff-field-budget"), [(c["path"], c["code"]) for c in checks.lint(d)])
            with self.assertRaises(design.DesignError):
                design.to_python(d)
            d["far_field"]["enabled"] = False
            self.assertFalse(any(c["path"] == "far_field.complex_fields" for c in checks.lint(d)))
            design.to_python(d)

    def test_export_checks_budget_after_runtime_parameter_override(self):
        d = design.blank_design("runtime-budget", "Runtime budget")
        d["far_field"].update(complex_fields=True, theta_step="f0", phi_step="f0")
        generated = ast.parse(design.to_python(d))
        build = next(n for n in generated.body if isinstance(n, ast.FunctionDef) and n.name == "build")
        wanted = {"complex_field_outputs", "pattern_steps", "pattern_freqs"}
        statements = [n for n in build.body if
            (isinstance(n, ast.Assign) and any(isinstance(t, ast.Attribute) and t.attr in wanted for t in n.targets))
            or (isinstance(n, ast.Expr) and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Name)
                and n.value.func.id == "field_budget_for_steps")]
        program = compile(ast.Module(body=statements, type_ignores=[]), "generated-field-settings-only", "exec")
        for f0 in (2.45, .25):
            namespace = {"sim": SimpleNamespace(pattern_freqs=None), "p": {"f0": f0}, "f0": f0,
                         "pattern_steps": grid.pattern_steps, "field_budget_for_steps": fields.field_budget_for_steps}
            if f0 == .25:
                with self.assertRaises(ValueError):
                    exec(program, namespace)
            else:
                exec(program, namespace)
                self.assertEqual(namespace["sim"].pattern_steps, (f0, f0))

    def test_capture_preserves_opt_in_without_native_geometry(self):
        for enabled in (True, False):
            for value in (True, False):
                sim = SimpleNamespace(unit=.001, excitation={"type": "gaussian-derivative"},
                    nf2ff=object() if enabled else None, complex_field_outputs=value, cp_outputs=False,
                    nf2ff_faces=None, nf2ff_center=None, pattern_freqs=[2.4e9], csx=None, materials={}, ports=[],
                    lumped_elements=[], current_freqs=None, f_min=2e9, f_max=3e9,
                    boundaries=["PML_8"] * 6, end_criteria_db=-60, max_timesteps=100)
                with patch.object(capture, "_check_reconstructible_ports"), patch.object(capture, "_coaxial_generated", return_value={}), \
                        patch.object(capture, "read_structure", return_value=([], [], None)):
                    _, got = capture._read_design(SimpleNamespace(build=lambda _: sim), {}, Path("synthetic.py"))
                self.assertIs(got["far_field"].get("complex_fields", False), value)
                self.assertEqual(got["far_field"]["enabled"], enabled)


if __name__ == "__main__":
    if sys.argv[1:] == ["--json"]:
        print(json.dumps(synthetic_records(), allow_nan=False))
    else:
        unittest.main()
