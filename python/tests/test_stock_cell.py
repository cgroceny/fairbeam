"""Stock-cell admission/queue/NRW contracts; SDK-free, native calls mocked.

Synthetic voltages establish only software normalization, never solver accuracy.
"""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import numpy as np

from fairbeam import stock_cell as sc, research
from fairbeam.analytic import C0, slab_s


def design():
    return {"schema": "fairbeam.design/1", "model": {"id": "slab", "name": "Slab"},
            "params": [], "simulation": {"f_min": 1, "f_max": 10},
            "materials": [{"name": "sample", "kind": "dielectric", "eps_r": 4, "tan_d": 0}],
            "parts": [{"name": "slab", "material": "sample", "primitives": [
                {"kind": "box", "start": [-3, -3, 0], "stop": [3, 3, 10]}]}],
            "ports": [], "mesh": {"mode": "auto"}}


def box(x0=-2, x1=2, y0=-2, y1=2):
    return {"material": "dielectric", "eps_r": 4, "start": [x0, y0, 0], "stop": [x1, y1, 10]}


class Admission(unittest.TestCase):
    def test_fixture_identity_bounds_and_no_periodic_boundary(self):
        for fixture in ("slab", "pec_sheet", "empty"):
            s = sc.validate_spec({"fixture": fixture})
            self.assertEqual(s, sc.validate_spec(s["input_settings"], s["source_design"]))
            self.assertEqual(s["layout"]["boundaries"], sc.BOUNDARIES)
            self.assertNotIn("PERIODIC_TEST", json.dumps(s))
            self.assertEqual(s["layout"]["timeout_per_case_s"], 180)
            self.assertEqual(s["layout"]["max_timesteps"], 80000)
            self.assertLessEqual(s["layout"]["cells"], 500000)

    def test_mirror_multiset_and_numeric_roundoff(self):
        self.assertEqual(len(sc.validate_spec({"boxes": [box(-3, -1), box(1, 3)]})["settings"]["boxes"]), 2)
        four = [box(x0, x1, y0, y1) for x0, x1 in ((-3, -1), (1, 3)) for y0, y1 in ((-3, -1), (1, 3))]
        self.assertEqual(len(sc.validate_spec({"boxes": four})["settings"]["boxes"]), 4)
        self.assertEqual(len(sc.validate_spec({"boxes": [box(-2, 2 + 1e-14)]})["settings"]["boxes"]), 1)
        for boxes in ([box(-2, 2 + 1e-10)], [box(-3, -1)], [box(-3, -1), {**box(1, 3), "eps_r": 3}],
                      [box(-3, -1), {**box(1, 3), "priority": 1}], [box(), box(-3, -1)]):
            with self.subTest(boxes=boxes), self.assertRaises(ValueError): sc.validate_spec({"boxes": boxes})

    def test_unsupported_physics_resource_and_ambiguous_overlap_refusal(self):
        for settings in ({"bloch_phase": 1}, {"polarization": "Ex"}, {"f_max_hz": float("nan")},
                         {"nrw_sin_floor": .1}, {"nrw": "true"}, {"period_x_mm": 30}, {"cpw": 10},
                         {"boxes": [box(), {**box(), "eps_r": 3}]},
                         {"boxes": [box(), {"material": "pec", "priority": 0, "start": [-2, -2, 0], "stop": [2, 2, 0]}]}):
            with self.subTest(settings=settings), self.assertRaises(ValueError): sc.validate_spec(settings)
        for change in ({"tan_d": .01}, {"conductivity": 5.8e7}, {"thickness": .035}, {"dispersion": {}}, {"mu_r": 2}):
            d = design(); d["materials"][0].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError): sc.validate_spec({}, d)
        d = design(); d["parts"][0]["transforms"] = [{"type": "move", "offset": [1, 0, 0]}]
        with self.assertRaises(ValueError): sc.validate_spec({}, d)
        for materials in (None, "PEC", [None], ["PEC"]):
            d = design(); d["materials"] = materials
            with self.subTest(materials=materials), self.assertRaises(ValueError): sc.validate_spec({}, d)

    def test_design_preserved_and_nrw_homogeneous_only(self):
        d = design(); before = copy.deepcopy(d)
        s = sc.validate_spec({"nrw": True}, d)
        self.assertEqual(d, before); self.assertEqual(s["source_design"], before)
        self.assertTrue(s["settings"]["nrw"])
        for settings in ({"fixture": "empty", "nrw": True}, {"fixture": "pec_sheet", "nrw": True},
                         {"boxes": [box()], "nrw": True}):
            with self.subTest(settings=settings), self.assertRaises(ValueError): sc.validate_spec(settings)

    def test_stock_probe_uses_help_not_custom_handshake(self):
        with tempfile.TemporaryDirectory() as td:
            executable = Path(td) / "openEMS.exe"; executable.write_bytes(b"mock native binary")
            with patch.object(sc, "_sdk_files", return_value=[]), patch.object(sc.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "openEMS --engine=basic", "")) as launch:
                self.assertTrue(sc.probe(str(executable))["available"])
                self.assertEqual(launch.call_args.args[0], [str(executable.resolve()), "--help"])
            with patch.object(sc, "_sdk_files", side_effect=ValueError("missing bindings")), patch.object(sc.subprocess, "run") as launch:
                self.assertFalse(sc.probe(str(executable))["available"]); launch.assert_not_called()

    def test_queue_admission_pins_stock_and_sdk_without_periodic_probe(self):
        with tempfile.TemporaryDirectory() as td:
            exe, sdk = Path(td) / "openEMS.exe", Path(td) / "openEMS.pyd"
            exe.write_bytes(b"synthetic binary"); sdk.write_bytes(b"synthetic bindings")
            with patch.object(sc, "probe", return_value={"available": True, "path": str(exe), "sdk_files": [str(sdk)]}), patch.object(sc.box_contract, "probe", side_effect=AssertionError("periodic probe forbidden")):
                admitted = research.prepare({"backend": "stock", "settings": {"nrw": True}})
            self.assertEqual(admitted["normalized"]["schema"], "fairbeam.stock-cell/1")
            self.assertIn(str(sdk.resolve()), admitted["binary_sha256"])

    def test_stock_xml_writer_refuses_periodic_or_changed_wall(self):
        import xml.etree.ElementTree as ET
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "model.xml"
            def write(values):
                root = ET.Element("openEMS")
                ET.SubElement(root, "BoundaryCond", dict(zip(("xmin", "xmax", "ymin", "ymax", "zmin", "zmax"), values)))
                ET.ElementTree(root).write(target)
            for values, valid in ((sc.BOUNDARIES, True), (["PERIODIC_TEST"] * 4 + sc.BOUNDARIES[4:], False),
                                  (["PEC"] * 4 + sc.BOUNDARIES[4:], False)):
                with patch("fairbeam.periodic_xml.write", side_effect=lambda sim, path: write(values)):
                    if valid: sc._write_xml(None, target)
                    else:
                        with self.assertRaises(ValueError): sc._write_xml(None, target)

    def test_real_builder_with_fake_sdk_has_identical_mesh_source_probes_and_dt(self):
        class Prop:
            def __init__(self, name, kind, kwargs): self.name, self.kind, self.kwargs, self.boxes = name, kind, kwargs, []
            def AddBox(self, lo, hi, **kwargs): self.boxes.append((list(lo), list(hi), kwargs))
        class CSX:
            def __init__(self): self.props = []
            def add(self, name, kind, kwargs):
                p = Prop(name, kind, kwargs); self.props.append(p); return p
            def AddExcitation(self, name, **kwargs): return self.add(name, "source", kwargs)
            def AddProbe(self, name, **kwargs): return self.add(name, "probe", kwargs)
            def AddMetal(self, name): return self.add(name, "pec", {})
            def AddMaterial(self, name, **kwargs): return self.add(name, "dielectric", kwargs)
        class Sim:
            def __init__(self, *args, **kwargs):
                self.csx, self.lines, self.dt, self.boundary = CSX(), {}, None, None
                self.fdtd = types.SimpleNamespace(SetBoundaryCond=lambda b: setattr(self, "boundary", b.copy()), SetTimeStep=lambda dt: setattr(self, "dt", dt))
                self.mesh = types.SimpleNamespace(AddLine=lambda axis, values: self.lines.update({axis: list(values)}))
        module = types.ModuleType("fairbeam.simulation"); module.Simulation = Sim
        spec = sc.validate_spec({})
        with patch.dict(sys.modules, {"fairbeam.simulation": module}):
            reference, ref_names, ref_planes = sc._build(spec, False)
            sample, sample_names, sample_planes = sc._build(spec, True)
        self.assertEqual(reference.lines, sample.lines)
        self.assertEqual(ref_names, sample_names); self.assertEqual(ref_planes, sample_planes)
        self.assertEqual(reference.dt, sample.dt); self.assertEqual(reference.boundary, sc.BOUNDARIES)
        signature = lambda sim: [(p.name, p.kind, p.kwargs, p.boxes) for p in sim.csx.props if p.kind in ("source", "probe")]
        self.assertEqual(signature(reference), signature(sample))
        source = next(p for p in reference.csx.props if p.kind == "source")
        self.assertEqual(source.kwargs, {"exc_type": 0, "exc_val": [0, 1, 0]})
        self.assertFalse(any(p.kind in ("pec", "dielectric") for p in reference.csx.props))
        self.assertEqual(sum(p.kind == "dielectric" for p in sample.csx.props), 1)


class Retrieval(unittest.TestCase):
    def test_slab_retrieval_masks_halfwaves_and_preserves_branch(self):
        s = sc.validate_spec({"nrw": True})["settings"]
        f = np.linspace(1e9, 10e9, 301)
        analytic = slab_s(f, [{"thickness": 10, "eps_r": 4}])
        m = sc.material_result(f, analytic[:, 0, 0], analytic[:, 1, 0], s)
        json.dumps(m, allow_nan=False)
        self.assertTrue(m["available"]); self.assertFalse(m["qualified"])
        self.assertTrue(m["segments"]); self.assertTrue(all("branch_resolved" in x for x in m["segments"]))
        self.assertIn(False, m["reliable"])
        for reliable, eps, mu in zip(m["reliable"], m["eps_real"], m["mu_real"]):
            if reliable:
                self.assertAlmostEqual(eps, 4, places=8); self.assertAlmostEqual(mu, 1, places=8)
            else: self.assertIsNone(eps); self.assertIsNone(mu)

    def test_opaque_and_unrequested_are_unavailable(self):
        f = np.linspace(1e9, 10e9, 301)
        for requested in (False, True):
            s = sc.validate_spec({"nrw": requested})["settings"]
            m = sc.material_result(f, np.full(len(f), -1 + 0j), np.zeros(len(f), complex), s)
            self.assertFalse(m["available"]); self.assertFalse(m["qualified"])
            json.dumps(m, allow_nan=False)


class PairedMockRun(unittest.TestCase):
    def run_mock(self, root, failure=None):
        spec = sc.validate_spec({"nrw": True})
        f = np.linspace(1e9, 10e9, 301)
        response = slab_s(f, [{"thickness": 10, "eps_r": 4}])
        names = [["probe1"], ["probe2"], ["probe3"]]
        planes = [-15., 25., -7.5]
        k = 2 * np.pi * f / C0 * 1e-3
        incident = [np.exp(-1j * k * z) for z in planes]
        sample = [incident[0] + response[:, 0, 0] * np.exp(1j * k * planes[0]),
                  incident[1] * response[:, 1, 0] * np.exp(1j * k * 10), incident[2]]
        if failure == "reflection": incident[2] *= 1.1
        if failure == "incident": incident[0] *= 0
        launches = []
        def build(spec, sample):
            mesh = types.SimpleNamespace(GetLines=lambda axis: [-3., 0., 3.])
            sim = types.SimpleNamespace(mesh=mesh, boundaries=sc.BOUNDARIES.copy())
            if failure == "mesh" and sample: sim.mesh.GetLines = lambda axis: [-3., 1., 3.]
            return sim, names, planes
        def launch(command, **kw):
            launches.append(Path(kw["cwd"]).name)
            if failure == "cancel": raise KeyboardInterrupt("synthetic cancellation")
            if failure == "timeout": raise subprocess.TimeoutExpired(command, 180)
            if failure == "exit": return subprocess.CompletedProcess(command, 2)
            for name in ("probe1", "probe2", "probe3"):
                (Path(kw["cwd"]) / name).write_text("synthetic probe bytes", encoding="utf-8")
            return subprocess.CompletedProcess(command, 0)
        def ui(group, directory, frequencies):
            values = incident if Path(directory).name == "reference" else sample
            return types.SimpleNamespace(ui_f_val=[values[int(group[0][-1]) - 1]])
        constants = types.ModuleType("openEMS.physical_constants"); constants.C0 = C0; constants.Z0 = 376.730313668
        ports = types.ModuleType("openEMS.ports"); ports.UI_data = ui
        simulation = types.ModuleType("fairbeam.simulation")
        simulation._parse_log = lambda *args: {"converged": failure != "energy", "timesteps": 10}
        fake_sdk = types.ModuleType("openEMS"); fake_sdk.__path__ = []
        # The real material_cell postprocessor is imported with constants only;
        # no SDK or native Simulation implementation is loaded by these tests.
        with patch.dict(sys.modules, {"openEMS": fake_sdk, "openEMS.ports": ports, "openEMS.physical_constants": constants,
                                      "fairbeam.simulation": simulation}), patch.object(sc, "probe", return_value={"available": True, "path": "synthetic-only"}), \
             patch.object(sc, "_build", side_effect=build), patch.object(sc, "_write_xml", side_effect=lambda sim, path: Path(path).write_text("synthetic stock XML")), \
             patch.object(sc.subprocess, "run", side_effect=launch), patch("fairbeam.material_cell.probe_timestep", return_value=spec["layout"]["dt_s"]):
            if failure:
                with self.assertRaises((ValueError, RuntimeError, KeyboardInterrupt, subprocess.TimeoutExpired)):
                    sc.run(spec, root)
                self.assertEqual(launches, ["reference"])
                self.assertEqual(json.loads((root / "manifest.json").read_text())["status"], "failed")
                return None
            result = sc.run(spec, root)
        self.assertEqual(launches, ["reference", "sample"])
        self.assertEqual(result["status"], "results_exported")
        self.assertEqual(result["qa"]["paired_mesh_pass"], True)
        self.assertEqual(result["qa"]["paired_timestep_pass"], True)
        self.assertLess(result["qa"]["analytic_max_complex_error"], 1e-12)
        self.assertTrue(research.completed_result(result))
        return result

    def test_pair_normalization_phase_nrw_and_csv(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "output"; result = self.run_mock(root)
            self.assertEqual(json.loads((root / "result.json").read_text())["material"], result["material"])
            self.assertIn("reflection_phase_deg,nrw_reliable", (root / "sparameters.csv").read_text())

    def test_queue_execution_dispatch_and_changed_binary_refusal(self):
        with tempfile.TemporaryDirectory() as td:
            directory = Path(td)
            result = self.run_mock(directory / "synthetic-pair")
            exe = directory / "mock-openEMS.exe"; exe.write_bytes(b"synthetic only")
            spec = {"schema": "fairbeam-research-input-1", "backend": "stock", "path": str(exe),
                    "normalized": sc.validate_spec({"nrw": True}), "binary_sha256": {str(exe): research.digest(exe)}}
            snapshot = directory / "snapshot.json"; snapshot.write_bytes(research.encode(spec))
            out = directory / "dispatch"; out.mkdir()
            with patch.object(sc, "run", return_value=result) as run, patch.object(sc.box_contract, "run", side_effect=AssertionError("periodic run forbidden")):
                research.execute(snapshot, out, research.digest(snapshot))
                run.assert_called_once_with(spec["normalized"], out, executable=str(exe))
                admitted = json.loads((out / "result.json").read_text())
                self.assertEqual(admitted["input_sha256"], research.digest(snapshot))
                self.assertTrue(research.completed_result(admitted))
            exe.write_bytes(b"changed after queue admission")
            with patch.object(sc, "run") as run, self.assertRaisesRegex(ValueError, "changed before launch"):
                research.execute(snapshot, out, research.digest(snapshot))
            run.assert_not_called()

    def test_failure_cancel_or_mesh_change_never_starts_sample(self):
        for failure in ("exit", "energy", "cancel", "timeout", "mesh", "reflection", "incident"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as td:
                self.run_mock(Path(td) / "output", failure)

    def test_reload_refuses_changed_basis_qa_phase_and_retrieval(self):
        with tempfile.TemporaryDirectory() as td:
            result = self.run_mock(Path(td) / "output")
        for change in (lambda r: r.update(status="results_validated"), lambda r: r["layout"]["boundaries"].__setitem__(0, "PERIODIC_TEST"),
                       lambda r: r["reflection_phase_deg"].__setitem__(0, 123.), lambda r: r["qa"].update(paired_mesh_pass=False),
                       lambda r: r["material"].update(qualified=True), lambda r: r["provenance"].update(phasor_convention="other"),
                       lambda r: r["qa"].update(co_polar_power_max=100), lambda r: r["material"].update(thickness_mm=11)):
            bad = copy.deepcopy(result); change(bad)
            bad.update(research_schema="fairbeam-research-result-1")
            with self.assertRaises(ValueError): research.validate_result(bad, "stock")
        bad = copy.deepcopy(result)
        index = bad["material"]["reliable"].index(False); bad["material"]["eps_real"][index] = 4
        with self.assertRaisesRegex(ValueError, "Unreliable"): sc.validate_result(bad)
        bad = copy.deepcopy(result)
        for segment in bad["material"]["segments"]: segment["branch_resolved"] = False
        with self.assertRaisesRegex(ValueError, "Unresolved"): sc.validate_result(bad)
        bad = copy.deepcopy(result); bad["material"]["available"] = False
        with self.assertRaisesRegex(ValueError, "availability"): sc.validate_result(bad)
        bad = copy.deepcopy(result); bad["material"]["reliable"] = [False] * len(bad["frequency_hz"])
        with self.assertRaisesRegex(ValueError, "availability"): sc.validate_result(bad)
        bad["material"]["available"] = False
        with self.assertRaisesRegex(ValueError, "Unreliable"): sc.validate_result(bad)
        for key in ("eps_real", "eps_imag", "mu_real", "mu_imag"): bad["material"][key] = [None] * len(bad["frequency_hz"])
        self.assertIs(sc.validate_result(bad), bad)  # all-unavailable data can be retained truthfully


if __name__ == "__main__": unittest.main()
