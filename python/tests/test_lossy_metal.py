"""Metals of finite conductivity (design material "conductivity"): the build (conducting sheets,
conductive volumes, PEC wires), the bundle's parts[].conductor, the Python export, and that a metal
without a conductivity is built exactly as before (PEC)."""

import sys
import types
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.design import DesignError, blank_design, module_for, to_python  # noqa: E402
from fairbeam.geometry import read_structure  # noqa: E402
from fairbeam.model import resolve_params  # noqa: E402
from fairbeam.simulation import (EFFICIENCY_MAX_ERROR, LossyMetal, Simulation,  # noqa: E402
                                 _unreliable_warning)


def build(d):
    m = module_for(d)
    return m.build(resolve_params(m.PARAMS, {}))


def props(sim):
    """{property name: (type, primitive type names)} of the physical structure."""
    out: dict = {}
    for prim in sim.csx.GetAllPrimitives():
        p = prim.GetProperty()
        if p.GetTypeString() in ("ProbeBox", "DumpBox", "Excitation"):
            continue
        out.setdefault(p.GetName(), (p.GetTypeString(), []))[1].append(prim.GetTypeName())
    return out


class LossyBuild(unittest.TestCase):
    def test_pec_is_unchanged(self):
        sim = build(blank_design("t", "T"))
        p = props(sim)
        self.assertEqual(p["patch"][0], "Metal")
        self.assertEqual(p["gnd"][0], "Metal")
        self.assertNotIn("conductor", {k for part in read_structure(sim.csx, sim.materials)[0] for k in part})

    def test_copper_sheets_volumes_and_wires(self):
        d = blank_design("t", "T")
        d["materials"][0]["conductivity"] = 5.8e7
        d["parts"].append({"name": "via", "material": "copper", "primitives": [
            {"kind": "cylinder", "axis": "z", "center": [5, 5], "radius": 0.4, "range": [0, "h"]},
            {"kind": "wire", "points": [[10, 10, 0], [10, 10, "h"]], "radius": 0.1}]})
        # a 35 µm brick: built as a sheet, which keeps its drawn thickness
        d["parts"].append({"name": "strip", "material": "copper", "primitives": [
            {"kind": "box", "start": [-20, 15, "h"], "stop": [-10, 18, "h + 0.035"]}]})
        d["materials"][0]["thickness"] = "0.018"
        sim = build(d)
        p = props(sim)
        self.assertEqual(p["patch"], ("ConductingSheet", ["Box"]))
        self.assertEqual(p["gnd"], ("ConductingSheet", ["Box"]))
        self.assertEqual(p["via"][0], "Material")            # the cylinder: a conductive volume
        self.assertEqual(p["via__wire"][0], "Metal")          # the wire stays PEC
        self.assertEqual(p["strip"][0], "ConductingSheet")
        self.assertEqual(sim.materials["patch"]["thickness"], 0.018)     # the material's thickness
        self.assertAlmostEqual(sim.materials["strip"]["thickness"], 0.035)  # its own drawn thickness
        parts = {e["name"]: e for e in read_structure(sim.csx, sim.materials)[0]}
        self.assertEqual(parts["patch"]["conductor"], {"conductivity": 5.8e7, "thickness": 0.018})
        self.assertEqual(parts["via"]["conductor"], {"conductivity": 5.8e7, "thickness": None})
        self.assertNotIn("conductor", parts["via__wire"])
        self.assertNotIn("conductor", parts["substrate"])

    def test_thin_extrusion_is_a_sheet(self):
        sim = Simulation(1e9, 3e9)
        m = sim.metal("trace", conductivity=5.8e7)
        self.assertIsInstance(m, LossyMetal)
        m.sheet_limit = 0.1
        m.AddLinPoly(np.array([[0, 0], [5, 0], [5, 1]], float).T, 2, 1.0, 0.035, priority=10)
        m.AddLinPoly(np.array([[0, 0], [5, 0], [5, 1]], float).T, 2, 2.0, 1.0, priority=10)
        p = props(sim)
        self.assertEqual(p["trace"], ("ConductingSheet", ["Polygon"]))
        self.assertEqual(p["trace__volume"], ("Material", ["LinPoly"]))
        self.assertAlmostEqual(sim.materials["trace"]["thickness"], 0.035)

    def test_refused_values(self):
        d = blank_design("t", "T")
        d["materials"][0]["conductivity"] = "0"
        with self.assertRaises(DesignError) as e:
            build(d)
        self.assertEqual(e.exception.where, "materials.copper.conductivity")
        d["materials"][0].update(conductivity="5.8e7", thickness="-1")
        with self.assertRaises(DesignError) as e:
            build(d)
        self.assertEqual(e.exception.where, "materials.copper.thickness")
        d["materials"][0].update(conductivity="", thickness="-1")   # empty: PEC, the thickness is unused
        self.assertEqual(props(build(d))["patch"][0], "Metal")

    def test_python_export(self):
        d = blank_design("t", "T")
        d["materials"][0].update(conductivity="5.8e7", thickness="0.035")
        src = to_python(d)
        self.assertIn("sim.metal('patch', label='Patch', conductivity=58000000.0, thickness=0.035)", src)
        ns: dict = {}
        exec(compile(src, "export.py", "exec"), ns)  # noqa: S102 - our own generated source
        sim = ns["build"](resolve_params(ns["PARAMS"], {}))
        self.assertEqual(props(sim)["patch"][0], "ConductingSheet")


class EfficiencyReliability(unittest.TestCase):
    """Simulation._pacc_error: the tail of the port signals estimates the truncation error of Pacc."""

    def port(self, t_end, f0=2e9, tau=2e-9):
        t = np.arange(0.0, t_end, 2e-11)
        env = np.exp(-t / tau)
        u = env * np.cos(2 * np.pi * f0 * t)
        i = env * np.cos(2 * np.pi * f0 * t + 0.3) / 50
        return types.SimpleNamespace(u_time=t, ut_tot=u, i_time=t + 1e-12, it_tot=i)

    def test_decayed_and_truncated(self):
        sim = Simulation(1e9, 3e9, excitation="gauss")
        fe = np.linspace(1e9, 3e9, 5)
        done = sim._pacc_error(self.port(60e-9), fe)    # 30 time constants: nothing left
        cut = sim._pacc_error(self.port(6e-9), fe)      # 3 time constants: still ringing
        self.assertLess(float(np.max(done)), 1e-3)
        self.assertGreater(float(np.max(cut)), EFFICIENCY_MAX_ERROR)
        self.assertIsNone(sim._pacc_error(types.SimpleNamespace(), fe))   # no time signals

    def test_warning(self):
        f = np.array([1e9, 2e9, 3e9])
        self.assertIsNone(_unreliable_warning(f, [True, True, True], [0.1, 0.9, 0.1], -50))
        w = _unreliable_warning(f, [False, True, False], [0.01, 0.9, 0.03], -50)
        self.assertIn("2 of 3 frequencies at 1.000, 3.000 GHz are unreliable", w)
        self.assertIn("1.0-3.0 %", w)
        self.assertIn("(-60 dB)", w)


if __name__ == "__main__":
    unittest.main()
