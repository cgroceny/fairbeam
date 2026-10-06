"""Filter design formulas and geometry-only builds of the circuit models (no FDTD runs)."""

import unittest
from pathlib import Path

import numpy as np

from fairbeam import analytic as an
from fairbeam.model import load_model, resolve_params

MODELS = Path(__file__).resolve().parents[1] / "models"


class PrototypeTest(unittest.TestCase):
    def test_chebyshev_table(self):
        # Pozar Table 8.4, 0.5 dB ripple
        np.testing.assert_allclose(an.lowpass_prototype(5, 0.5), [1.7058, 1.2296, 2.5408, 1.2296, 1.7058, 1.0], atol=2e-4)
        np.testing.assert_allclose(an.lowpass_prototype(4, 0.5), [1.6703, 1.1926, 2.3661, 0.8419, 1.9841], atol=2e-4)
        np.testing.assert_allclose(an.lowpass_prototype(3, 3.0), [3.3487, 0.7117, 3.3487, 1.0], atol=5e-4)

    def test_butterworth_table(self):
        np.testing.assert_allclose(an.lowpass_prototype(5, 0), [0.618, 1.618, 2.0, 1.618, 0.618, 1.0], atol=1e-3)

    def test_prototype_response(self):
        f = np.array([0.5, 1.0, 2.0]) * 1e9
        cheb = 20 * np.log10(an.lowpass_prototype_s21(f, 1e9, 5, 0.5))
        self.assertAlmostEqual(cheb[1], -0.5, places=6)                  # ripple edge at fc
        self.assertGreaterEqual(cheb[0], -0.5 - 1e-9)
        butter = 20 * np.log10(an.lowpass_prototype_s21(f, 1e9, 5, 0))
        self.assertAlmostEqual(butter[1], -3.0103, places=3)
        self.assertAlmostEqual(butter[2], -10 * np.log10(1 + 2 ** 10), places=6)


class SteppedImpedanceTest(unittest.TestCase):
    def test_design_rules(self):
        secs = an.stepped_impedance_lowpass(2.5e9, 5, 0.5, 50, 110, 20, 3.38, 0.813)
        self.assertEqual([s["kind"] for s in secs], ["C", "L", "C", "L", "C"])
        self.assertAlmostEqual(secs[0]["beta_l"], 1.7058 * 20 / 50, places=3)
        self.assertAlmostEqual(secs[1]["beta_l"], 1.2296 * 50 / 110, places=3)
        self.assertTrue(all(s["beta_l"] < np.pi / 3 for s in secs))     # short-line approximation holds
        self.assertAlmostEqual(an.microstrip_z0(3.38, 0.813, secs[0]["width"]), 20.0, places=4)

    def test_cascade_limits(self):
        # a matched 50 ohm line is transparent; a quarter-wave 100 ohm line mismatches as expected
        line = [{"z": 50.0, "eps_eff": 2.7, "length": 30.0}]
        s = an.cascade_lines_s([1e9, 3e9], line)
        np.testing.assert_allclose(np.abs(s[:, 1, 0]), 1.0, atol=1e-12)
        np.testing.assert_allclose(np.abs(s[:, 0, 0]), 0.0, atol=1e-12)
        f = 2e9
        q = [{"z": 100.0, "eps_eff": 1.0, "length": an.C0 / f / 4 * 1e3}]
        g = abs(an.cascade_lines_s([f], q)[0, 0, 0])
        self.assertAlmostEqual(g, (200 - 50) / (200 + 50), places=9)    # 100^2 / 50 = 200 ohm load

    def test_cascade_is_reciprocal_and_lossless(self):
        secs = an.stepped_impedance_lowpass(2.5e9, 5, 0.5, 50, 110, 20, 3.38, 0.813)
        s = an.cascade_lines_s(np.linspace(0.5e9, 6e9, 7), secs)
        np.testing.assert_allclose(s[:, 0, 1], s[:, 1, 0], atol=1e-12)
        np.testing.assert_allclose(np.abs(s[:, 0, 0]) ** 2 + np.abs(s[:, 1, 0]) ** 2, 1.0, atol=1e-9)


class CircuitModelsTest(unittest.TestCase):
    def build(self, name, **kw):
        m = load_model(MODELS / name)
        return m.build(resolve_params(m.PARAMS, {k: str(v) for k, v in kw.items()}))

    def test_branchline(self):
        sim = self.build("branchline_coupler.py")
        self.assertEqual([p["number"] for p in sim.ports], [1, 2, 3, 4])
        r = sim.mesh_report
        self.assertLess(r["total_cells"], 500_000)
        self.assertEqual(r["warnings"], [])
        y = np.asarray(sim.mesh.GetLines("y"))
        np.testing.assert_allclose(np.sort(-y), y, atol=1e-6)            # symmetric layout, symmetric mesh

    def test_lowpass(self):
        sim = self.build("lowpass_stepped.py")
        self.assertEqual(len(sim.ports), 2)
        self.assertEqual(len(sim.design), 5)
        self.assertLess(sim.mesh_report["total_cells"], 500_000)
        sim3 = self.build("lowpass_stepped.py", order=3, ripple=0)
        self.assertEqual([s["kind"] for s in sim3.design], ["C", "L", "C"])


if __name__ == "__main__":
    unittest.main()
