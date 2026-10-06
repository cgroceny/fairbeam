"""Post-processing in Simulation.evaluate, driven by stub port / NF2FF objects (no FDTD run).

Covers S11 / Zin / accepted power, band detection wiring, and the PEC/PMC mirror correction of the
NF2FF result: openEMS integrates the mirrored recording surface, so its Prad is 2^m too large and its
Dmax 2^m too small for m mirror planes.
"""

import types
import unittest

import numpy as np

from fairbeam.simulation import Simulation, _pattern_directivity

Z0 = 50.0
GAMMA = 0.1           # |S11| = -20 dB, flat over frequency
ETA_RAD = 0.9         # radiation efficiency the stub NF2FF reproduces
D_TRUE = 1.64         # physical (half-space-corrected) directivity, linear


class StubPort:
    """Mimics openEMS' port after CalcPort with a constant reflection coefficient."""

    Z_ref = Z0

    def CalcPort(self, sim_path, f):
        n = len(f)
        self.uf_inc = np.ones(n, dtype=complex)
        self.uf_ref = np.full(n, GAMMA, dtype=complex)
        self.uf_tot = self.uf_inc + self.uf_ref
        self.if_tot = (self.uf_inc - self.uf_ref) / Z0
        t = np.linspace(0, 5e-9, 3000)
        self.u_time = t
        self.ut_inc = np.sin(t * 1e9)
        self.ut_ref = GAMMA * self.ut_inc
        self.ut_tot = self.ut_inc + self.ut_ref
        self.it_tot = (self.ut_inc - self.ut_ref) / Z0


class StubNF2FF:
    def __init__(self, mirrors):
        self.mirrors = mirrors
        self.calls = []

    def CalcNF2FF(self, sim_path, freqs, theta, phi, center):
        self.calls.append({"freqs": list(freqs), "center": np.asarray(center)})
        p_acc = (1 - GAMMA ** 2) / (2 * Z0)
        th, ph = np.meshgrid(np.deg2rad(theta), np.deg2rad(phi), indexing="ij")
        e = np.abs(np.sin(th)) + 1e-6  # dipole-like
        k = 2.0 ** self.mirrors
        return types.SimpleNamespace(E_norm=[e for _ in freqs], Dmax=[D_TRUE / k for _ in freqs],
                                     Prad=[ETA_RAD * p_acc * k for _ in freqs])


def make_sim(boundaries):
    sim = Simulation(1e9, 3e9, boundaries=boundaries)
    sim.ports = [{"number": 1, "type": "lumped", "R": Z0, "direction": "z", "start": [0, 0, 0],
                  "stop": [0, 0, 1], "excite": True}]
    sim._port_objs = [StubPort()]
    mirrors = sum(b in ("PEC", "PMC") for b in boundaries)
    sim.nf2ff = StubNF2FF(mirrors)
    sim.nf2ff_center = [0.0, 0.0, 5.0]
    sim.sim_path = "/nonexistent"
    return sim


class EvaluateTest(unittest.TestCase):
    def test_port_quantities(self):
        res = make_sim(["MUR"] * 6).evaluate(n_freq=11, pattern_freqs=[2e9])
        port = res["ports"]["1"]
        np.testing.assert_allclose(port["s11_re"], GAMMA)
        np.testing.assert_allclose(port["zin_re"], Z0 * (1 + GAMMA) / (1 - GAMMA), rtol=1e-4)
        self.assertEqual(len(res["frequency"]), 11)
        self.assertEqual(len(res["bands"]), 1)  # -20 dB everywhere: one band over the whole range
        self.assertTrue(res["bands"][0]["edge_lo"] and res["bands"][0]["edge_hi"])
        self.assertLessEqual(len(res["signals"]["time_ns"]), 1500)
        self.assertEqual(res["signals"]["samples"], 3000)

    def test_mirror_correction(self):
        cases = {
            0: ["MUR"] * 6,
            1: ["MUR", "MUR", "MUR", "MUR", "PEC", "MUR"],
            2: ["PMC", "MUR", "MUR", "MUR", "PEC", "MUR"],
            3: ["PMC", "MUR", "PMC", "MUR", "PEC", "MUR"],
        }
        for m, bnd in cases.items():
            with self.subTest(mirrors=m):
                res = make_sim(bnd).evaluate(n_freq=11, pattern_freqs=[2e9])
                ff = res["farfield"][0]
                self.assertEqual(ff["mirror_planes"], m)
                self.assertAlmostEqual(ff["dmax_dbi"], 10 * np.log10(D_TRUE), places=3)
                self.assertAlmostEqual(ff["rad_efficiency"], ETA_RAD, places=4)
                self.assertAlmostEqual(ff["gain_dbi"], 10 * np.log10(ETA_RAD * D_TRUE), places=3)
                self.assertAlmostEqual(ff["realized_gain_dbi"],
                                       10 * np.log10(ETA_RAD * D_TRUE * (1 - GAMMA ** 2)), places=3)

    def test_pattern_directivity(self):
        # the stub pattern is |sin(theta)|: a short dipole, D = 1.5 over the full sphere
        for m, bnd in {0: ["MUR"] * 6, 1: ["MUR", "MUR", "MUR", "MUR", "PEC", "MUR"]}.items():
            with self.subTest(mirrors=m):
                ff = make_sim(bnd).evaluate(n_freq=5, pattern_freqs=[2e9])["farfield"][0]
                self.assertAlmostEqual(ff["dmax_pattern_dbi"], 10 * np.log10(1.5 * 2 ** m), delta=0.01)

    def test_pattern_directivity_helper(self):
        theta = np.arange(0, 181, 3.0)
        phi = np.arange(0, 360, 5.0)
        iso = np.ones((len(theta), len(phi)))
        self.assertAlmostEqual(_pattern_directivity(iso, theta, phi), 1.0, places=3)
        self.assertIsNone(_pattern_directivity(iso[:31], theta[:31], phi))      # half sphere only
        self.assertIsNone(_pattern_directivity(iso[:, :36], theta, phi[:36]))   # half circle only

    def test_mur_boundaries_are_not_mirrors(self):
        res = make_sim(["MUR", "MUR", "PML_8", "PML_8", "MUR", "MUR"]).evaluate(n_freq=5, pattern_freqs=[2e9])
        self.assertEqual(res["farfield"][0]["mirror_planes"], 0)

    def test_directivity_grid(self):
        res = make_sim(["MUR"] * 6).evaluate(n_freq=11, pattern_freqs=[1.5e9, 2.5e9])
        self.assertEqual(len(res["farfield"]), 2)
        for ff in res["farfield"]:
            grid = np.array(ff["directivity_dbi"])
            self.assertEqual(grid.shape, (len(ff["theta"]), len(ff["phi"])))
            self.assertAlmostEqual(float(grid.max()), ff["dmax_dbi"], delta=0.01)
            self.assertGreaterEqual(float(grid.min()), ff["dmax_dbi"] - 60 - 0.01)
            self.assertEqual(ff["theta"][0], 0.0)
            self.assertEqual(ff["theta"][-1], 180.0)
            self.assertNotIn(360.0, ff["phi"])

    def test_phase_centre_in_metres(self):
        sim = make_sim(["MUR"] * 6)
        sim.evaluate(n_freq=5, pattern_freqs=[2e9])
        np.testing.assert_allclose(sim.nf2ff.calls[0]["center"], [0, 0, 5e-3])

    def test_default_pattern_frequencies_are_band_centres(self):
        sim = make_sim(["MUR"] * 6)
        res = sim.evaluate(n_freq=11)
        self.assertEqual(sim.nf2ff.calls[0]["freqs"], [b["f_center"] for b in res["bands"]])


if __name__ == "__main__":
    unittest.main()
