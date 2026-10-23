"""Pure model, serialization and fit controls. No CSXCAD, solver, browser or server."""
import ast
import copy
import json
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path

import numpy as np

from fairbeam.design import blank_design, check_design, evaluate, to_python, thin_metal_limit, thin_sheets
from fairbeam.design_checks import lint
from fairbeam.designer_dispersion import add_wideband_material, captured_material, resolved_input, static_permittivity_bound
from fairbeam.dispersion import DjordjevicSarkar, Dispersion, Lorentz, resolution_problems
from fairbeam.debye_fit import fit_model
from fairbeam.documents import design_digest
from fairbeam.usermaterials import clean_entry

FIXTURE = json.loads(Path(__file__).with_name("fixtures").joinpath("wideband_materials.json").read_text())


class RecordingSimulation:
    """Use the real fitter, with no native property or field propagation."""
    def __init__(self, band=(0.5e9, 5e9)):
        self.f_min, self.f_max = band
        self.materials, self.dispersions = {}, {}

    def dispersive(self, name, model, n_poles=None, **display):
        from dataclasses import replace
        disp, report = fit_model(model, self.f_min, self.f_max, n_poles=n_poles)
        self.dispersions[name] = replace(disp, source={**disp.source, "report": report})
        self.materials[name] = {"dispersion": self.dispersions[name].to_dict(), **display}
        return "recorded property"


class DesignerDispersion(unittest.TestCase):
    def test_shared_inputs(self):
        for case in FIXTURE["cases"]:
            with self.subTest(case=case["name"]):
                material = {**copy.deepcopy(FIXTURE["base"]), **case["patch"]}
                call = lambda: resolved_input(material, lambda v: evaluate(v, FIXTURE["names"]))
                if case["valid"]:
                    value = call()
                    d = value["dispersion"]
                    model = DjordjevicSarkar.from_datasheet([(value["tan_d_freq"] * 1e9, value["eps_r"], value["tan_d"])], m1=d["m1"], m2=d["m2"])
                    at = model.eps(value["tan_d_freq"] * 1e9)
                    self.assertAlmostEqual(at.real, value["eps_r"], places=10)
                    self.assertAlmostEqual(-at.imag / at.real, value["tan_d"], places=10)
                else:
                    with self.assertRaises(ValueError): call()

    def test_input_fit_capture_and_band_identity(self):
        original = copy.deepcopy(FIXTURE["base"])
        original["dispersion"]["n_poles"] = 8
        original["eps_r"] = "er"
        resolved = resolved_input(original, lambda v: evaluate(v, FIXTURE["names"]))
        records = []
        for band in [(0.5e9, 5e9), (1e9, 10e9)]:
            sim = RecordingSimulation(band)
            self.assertEqual(add_wideband_material(sim, "Laminate", resolved, intent=original), "recorded property")
            saved = json.loads(json.dumps(sim.materials["Laminate"]["dispersion"]))
            records.append(saved)
            self.assertEqual(saved["source"]["designer_material"]["input"], original)
            self.assertEqual(captured_material(saved), resolved)
            self.assertEqual(saved["source"]["fit"]["f_min"], band[0])
            self.assertEqual(saved["source"]["report"]["f_max"], band[1])
            self.assertEqual(saved["source"]["report"]["poles"], len(saved["eps_poles"]))
            poles = Dispersion.from_dict(saved)
            self.assertTrue(all(isinstance(p, Lorentz) and p.f_plasma >= 0 and p.tau > 0 for p in poles.eps_poles))
            f = np.geomspace(band[0] / 100, band[1] * 100, 121)
            self.assertTrue(np.all(poles.eps(f).imag <= 1e-14))
            self.assertEqual(resolution_problems(poles, saved["source"]["report"]["dt"]), [])
            self.assertTrue(resolution_problems(poles, 1.0), "unresolved poles remain blocked")
        self.assertNotEqual(records[0], records[1])
        self.assertEqual(original["eps_r"], "er", "resolution does not mutate input")

    def test_analytic_passive_causal_control(self):
        model = DjordjevicSarkar.from_datasheet([(1e9, 4.3, 0.02)])
        f = np.geomspace(1, 1e15, 200)
        eps = model.eps(f)
        self.assertGreater(model.eps_inf, 0)
        self.assertGreater(model.delta, 0)
        self.assertTrue(np.all(eps.imag <= 0))
        self.assertTrue(np.all(np.diff(eps.real) <= 1e-12))
        self.assertAlmostEqual(eps[0].real, model.eps_inf + model.delta, places=5)
        self.assertAlmostEqual(eps[-1].real, model.eps_inf, places=5)
        # Causality here follows the existing positive continuous relaxation model;
        # this does not assert EM accuracy or perform a finite-band KK inversion.

    def test_static_bound_and_thin_metal_classification(self):
        for m1, m2, fref, tan in [(4, 12, 1, .02), (2, 14, .01, .02), (6, 11, 30, .001), (9, 13, .2, .00001), (4, 12, 1, 0)]:
            material = {**copy.deepcopy(FIXTURE["base"]), "tan_d_freq": fref, "tan_d": tan,
                        "dispersion": {"model": "djordjevic-sarkar", "m1": m1, "m2": m2}}
            model = DjordjevicSarkar.from_datasheet([(fref * 1e9, 4.3, tan)], m1=m1, m2=m2)
            bound = static_permittivity_bound(material)
            self.assertAlmostEqual(bound, model.eps_inf + model.delta, delta=1e-10 * bound)
            self.assertGreaterEqual(bound + 1e-12, 4.3)
            self.assertTrue(np.all(model.eps(np.r_[0, np.geomspace(1, 1e16, 200)]).real <= bound + 1e-10))
            d = blank_design("wideband", "Wideband")
            d["simulation"].update(f_min=.5, f_max=5)
            d["materials"] = [material]
            d["parts"] = [{"material": "Laminate"}]
            limit = thin_metal_limit(d, {})
            constant = copy.deepcopy(d); del constant["materials"][0]["dispersion"]
            old_limit = thin_metal_limit(constant, {})
            self.assertLessEqual(limit, old_limit + 1e-12)
            if old_limit > limit + 1e-12:
                thick = (limit + old_limit) / 2
                parts = [{"metal": True, "prims": [{"kind": "box", "start": [0, 0, 0], "stop": [1, 1, thick]}]}]
                self.assertEqual(thin_sheets(parts, limit), [], "the old point-based threshold would prematurely flatten this volume")
                self.assertEqual(len(thin_sheets(parts, old_limit)), 1)
            self.assertEqual(thin_metal_limit(constant, {}), old_limit, "constant dielectric path remains unchanged")

    def test_plain_native_material_keeps_zero_pole_model_identity(self):
        from fairbeam.geometry import read_structure
        material = copy.deepcopy(FIXTURE["base"]); material["tan_d"] = 0
        sim = RecordingSimulation()
        add_wideband_material(sim, "Laminate", material)
        metadata = sim.materials["Laminate"]
        prop = SimpleNamespace(GetName=lambda: "Laminate", GetTypeString=lambda: "Material",
                               GetMaterialProperty=lambda key: {"epsilon": 4.3, "mue": 1, "kappa": 0}[key])
        prim = SimpleNamespace(GetProperty=lambda: prop)
        csx = SimpleNamespace(GetAllPrimitives=lambda: [prim])
        with patch("fairbeam.geometry._primitive", return_value={"kind": "box", "start": [0, 0, 0], "stop": [1, 1, 1], "bbox": [[0, 0, 0], [1, 1, 1]]}):
            parts, _, _ = read_structure(csx, {"Laminate": metadata})
        self.assertEqual(parts[0]["material"]["dispersion"], metadata["dispersion"])
        self.assertEqual(captured_material(parts[0]["material"]["dispersion"])["tan_d"], 0)

    def test_library_roundtrip_and_unknown_capture(self):
        raw = {"id": "laminate", **copy.deepcopy(FIXTURE["base"])}
        entry, why = clean_entry(raw)
        self.assertEqual(why, "")
        self.assertEqual(entry["dispersion"], {"model": "djordjevic-sarkar", "m1": 4, "m2": 12})
        self.assertEqual(clean_entry(json.loads(json.dumps(entry)))[0], entry)
        for unknown in [{"model": "drude"}, {"model": "lorentz", "source": {}}, {"model": "djordjevic-sarkar"}]:
            with self.assertRaises(ValueError): captured_material(unknown)
        raw["dispersion"]["m1"] = "er"
        self.assertIsNone(clean_entry(raw)[0], "library cannot invent parameter values")

    def test_capture_material_route_and_parameter_slots(self):
        from fairbeam.example_design import _read_design, _slot_paths, ExampleConversionError
        material = copy.deepcopy(FIXTURE["base"])
        material["dispersion"].update(m1=5, m2=13, n_poles=8)
        sim = RecordingSimulation()
        add_wideband_material(sim, "Laminate", material)
        sim.unit, sim.csx = 1e-3, object()
        sim.excitation = {"type": "gaussian-derivative"}
        sim.ports, sim.lumped_elements, sim.current_freqs = [], [], []
        sim.boundaries, sim.end_criteria_db, sim.max_timesteps = ["PML_8"] * 6, -40, 1000
        entry = {"name": "Laminate", "type": "Material", "material": sim.materials["Laminate"],
                 "primitives": [{"kind": "box", "exact": True, "priority": 0, "start": [0, 0, 0], "stop": [1, 2, 3]}]}
        module = SimpleNamespace(build=lambda _values: sim)
        # Isolate material capture from native port/geometry admission, which this
        # pure test neither exercises nor claims to validate.
        with patch("fairbeam.example_design._check_reconstructible_ports"), \
                patch("fairbeam.example_design.read_structure", return_value=([entry], [], None)):
            _, core = _read_design(module, {}, Path("synthetic.py"))
            self.assertEqual(core["materials"], [{"name": "Laminate", **resolved_input(material)}])
            self.assertIn(("materials", 0, "dispersion", "m1"), _slot_paths(core))
            self.assertIn(("materials", 0, "dispersion", "m2"), _slot_paths(core))
            entry["material"]["dispersion"] = {"model": "drude"}
            with self.assertRaisesRegex(ExampleConversionError, "refusing to discard dispersion"):
                _read_design(module, {}, Path("synthetic.py"))

    def test_export_and_document_identity(self):
        d = blank_design("wideband", "Wideband")
        m = copy.deepcopy(FIXTURE["base"])
        d["materials"].append(m)
        d["parts"].append({"name": "Laminate", "material": "Laminate", "primitives": [{"kind": "box", "start": [0, 0, 0], "stop": [1, 2, 3]}]})
        check_design(d)
        text = to_python(d)
        ast.parse(text)
        self.assertIn("add_wideband_material(sim, 'Laminate'", text)
        self.assertNotIn("sim.dielectric('Laminate'", text)
        self.assertIn("intent=", text)
        # Execute only the generated material assignment against a recording
        # fitter: no generated build, native import, geometry or solver runs.
        tree = ast.parse(text)
        assignments = [node for node in ast.walk(tree) if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call)
                       and isinstance(node.value.func, ast.Name) and node.value.func.id == "add_wideband_material"]
        self.assertEqual(len(assignments), 1)
        sim = RecordingSimulation()
        exec(compile(ast.Module(body=assignments, type_ignores=[]), "exported material", "exec"),
             {"sim": sim, "add_wideband_material": add_wideband_material, "p": {}})
        self.assertEqual(captured_material(sim.materials["Laminate"]["dispersion"]), resolved_input(m))
        digest = design_digest(d)
        for mutate in [lambda q: q["materials"][-1]["dispersion"].update(m1=5), lambda q: q["simulation"].update(f_max=8)]:
            other = copy.deepcopy(d); mutate(other)
            self.assertNotEqual(digest, design_digest(other))
        self.assertEqual(design_digest(json.loads(json.dumps(d))), digest)

    def test_outside_reference_warns_without_constant_loss_fix(self):
        d = blank_design("wideband", "Wideband")
        d["simulation"].update(f_min=2, f_max=3)
        d["materials"].append(copy.deepcopy(FIXTURE["base"]))
        checks = [c for c in lint(d) if c["path"].startswith("materials.Laminate")]
        self.assertEqual([c["code"] for c in checks], ["dispersion-band"])
        self.assertNotIn("fix", checks[0], "do not rewrite the measured reference point")

    def test_study_identity_and_optimizer_checks(self):
        from fairbeam.convergence import with_density
        from fairbeam.optimize import precheck
        d = blank_design("wideband", "Wideband")
        d["materials"].append(copy.deepcopy(FIXTURE["base"]))
        d["params"].append({"key": "loss", "default": 0.02})
        d["materials"][-1]["tan_d"] = "loss"
        refined = with_density(d, 30)
        self.assertEqual(refined["materials"], d["materials"])
        refined["materials"][-1]["dispersion"]["m1"] = 5
        self.assertNotEqual(refined["materials"], d["materials"])
        reason = precheck(d, {"loss": 0.02})({"loss": 10})
        self.assertIsNotNone(reason, "invalid calibration cannot become a valid optimizer candidate")
        self.assertIn("eps_inf", reason[0])

    def test_unsupported_backend_guards(self):
        from fairbeam.coax import resolved_coax
        from fairbeam.fem_geometry import _material_properties
        from fairbeam.periodic_cell import _design_boxes
        from fairbeam.elmer_driven import prepare as driven_prepare
        m = copy.deepcopy(FIXTURE["base"])
        with self.assertRaisesRegex(ValueError, "dispersion"):
            _material_properties(m, {})
        design = blank_design("wideband", "Wideband")
        design.update(materials=[m], parts=[], ports=[], resistors=[], far_field={"enabled": False}, monitors={})
        with self.assertRaisesRegex(ValueError, "dispersion"):
            _design_boxes(design, {})
        driven = copy.deepcopy(design)
        driven["parts"] = [{"name": "Laminate", "material": "Laminate", "primitives": [{"kind": "box", "start": [0, 0, 0], "stop": [2, 2, 2]}]}]
        driven["ports"] = [{"type": "lumped", "number": 1, "R": 50, "start": [0, 0, 0], "stop": [0, 0, 1], "direction": "z"}]
        with self.assertRaisesRegex(ValueError, "Unsupported material"):
            driven_prepare(driven)
        port = {"type": "coaxial", "direction": "z", "start": [0, 0, 0], "stop": [0, 0, 10],
                "r_i": 1, "r_o": 3, "r_os": 4, "feed_shift": 0, "measurement_shift": 5,
                "conductor": "PEC", "dielectric": "Laminate"}
        with self.assertRaisesRegex(ValueError, "nondispersive"):
            resolved_coax(port, [m, {"name": "PEC", "kind": "metal"}], lambda v, _key: v)


if __name__ == "__main__":
    unittest.main()
