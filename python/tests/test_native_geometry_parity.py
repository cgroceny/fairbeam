"""Independent CSXCAD construction of the blade example, with a frozen common mesh.

XML parity runs normally. Set FAIRBEAM_TEST_FDTD=1 for the two sequential CPU
solves. This isolates the design builder and S11 postprocessing; it is not a
mesh-convergence test or a comparison of independent openEMS binary builds.
"""
import json
import gc
import math
import os
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

import numpy as np
from CSXCAD import ContinuousStructure
from openEMS import openEMS

from fairbeam.design import build
from fairbeam.simulation import _capture_output, _parse_log


class NativeGeometryParityTest(unittest.TestCase):
    def models(self, feed_fraction=0):
        root = Path(__file__).resolve().parents[2]
        design = json.loads((root / "examples/designs/blade_867.design.json").read_text())
        design["far_field"] = {"enabled": False}
        design.pop("monitors", None)
        design["simulation"].update(end_criteria_db=-60, max_timesteps=350000)
        sim = build(design, {"feed_fraction": feed_fraction})
        fdtd = openEMS(NrTS=350000, EndCriteria=1e-6)
        tau = 1 / (math.sqrt(2) * math.pi * (1.05e9 / 2.76))
        expression = (f"-{math.sqrt(2*math.e):.8f}*((t-{5*tau:.6e})/{tau:.6e})"
                      f"*exp(-((t-{5*tau:.6e})/{tau:.6e})^2)")
        fdtd.SetCustomExcite(expression, 1.05e9, 1.05e9)
        fdtd.SetBoundaryCond(["MUR"] * 6)
        csx = ContinuousStructure()
        fdtd.SetCSX(csx)
        mesh = csx.GetGrid()
        mesh.SetDeltaUnit(1e-3)
        csx.AddMetal("ground").AddBox([-150, -150, 0], [150, 150, 0], priority=10)
        # A y-normal CSXCAD polygon takes z,x coordinate pairs.
        points = np.array([[2, -2], [2, 2], [14, 30], [82, 40], [82, 10], [14, -30]])
        csx.AddMetal("blade").AddPolygon(points.T, "y", 0, priority=10)
        port = fdtd.AddLumpedPort(1, 50, [0-2.0*feed_fraction, 0, 0], [2.0*feed_fraction, 0, 2], "z", 1.0, priority=5)
        for a in "xyz":
            mesh.SetLines(a, sim.mesh.GetLines(a))
        return sim, fdtd, port

    def test_independent_native_geometry_produces_identical_solver_input(self):
        for fraction in (0, .5, 1):
            with self.subTest(feed_fraction=fraction):
                self.check_xml(fraction)

    def check_xml(self, fraction):
        sim, fdtd, _ = self.models(fraction)
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp) / "design.xml", Path(tmp) / "native.xml"
            sim.fdtd.Write2XML(str(a))
            fdtd.Write2XML(str(b))
            def physical_xml(path):
                tree = ET.parse(path)
                # CSXCAD assigns random display colors to properties. These
                # are not material parameters or part of the FDTD equations.
                for parent in tree.iter():
                    for child in list(parent):
                        if child.tag in ("FillColor", "EdgeColor"):
                            parent.remove(child)
                return ET.tostring(tree.getroot())
            self.assertEqual(physical_xml(a), physical_xml(b))

    @unittest.skipUnless(os.environ.get("FAIRBEAM_TEST_FDTD") == "1", "opt-in native FDTD control")
    def test_complex_s11_and_bundle_rounding(self):
        cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            sim, fdtd, port = self.models()
            p = None
            a, b = str(Path(tmp) / "design"), str(Path(tmp) / "native")
            try:
                stats = sim.run(a, threads=4, echo=False)
                self.assertTrue(stats["converged"])
                try:
                    with _capture_output(False) as log:
                        fdtd.Run(b, cleanup=True, numThreads=4, verbose=0,
                                 **({"exact_endcriteria": True} if stats.get("exact_endcriteria") else {}))
                finally:
                    os.chdir(cwd)
                self.assertTrue(_parse_log(b"".join(log).decode(errors="replace"), -60, 350000)["converged"])
                f = np.linspace(.7e9, 1.05e9, 801)
                port.CalcPort(b, f)
                native_s11 = port.uf_ref / port.uf_inc
                p = sim._port_objs[0]
                p.CalcPort(a, f)
                design_s11 = p.uf_ref / p.uf_inc
                self.assertTrue(np.isfinite(native_s11).all())
                self.assertLessEqual(float(np.max(abs(native_s11))), 1.001)
                np.testing.assert_allclose(design_s11, native_s11, rtol=0, atol=1e-6)
                stored = sim.evaluate(n_freq=801)["ports"]["1"]
                rounded = np.array(stored["s11_re"]) + 1j*np.array(stored["s11_im"])
                np.testing.assert_allclose(rounded, native_s11, rtol=0, atol=8.1e-6)
            finally:
                os.chdir(cwd)
                # Native FDTD objects hold probe streams open on Windows.
                del sim, fdtd, port, p
                gc.collect()


if __name__ == "__main__":
    unittest.main()
