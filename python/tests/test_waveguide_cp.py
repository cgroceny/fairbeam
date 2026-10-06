"""Waveguide ports, circular-polarisation outputs, NF2FF face selection and model pattern
frequencies (stub port / NF2FF objects, no FDTD run)."""

import types
import unittest

import numpy as np

from fairbeam.simulation import Simulation, _circular, _zref_scalar

GAMMA = 0.2


class StubWGPort:
    """A waveguide port after CalcPort: frequency-dependent Z_ref (the TE10 wave impedance)."""

    def CalcPort(self, sim_path, f):
        fc = 6.557e9
        self.Z_ref = 376.73 / np.sqrt(1 - (fc / f) ** 2)
        n = len(f)
        self.uf_inc = np.ones(n, dtype=complex)
        self.uf_ref = np.full(n, GAMMA, dtype=complex)
        self.uf_tot = self.uf_inc + self.uf_ref
        self.if_tot = (self.uf_inc - self.uf_ref) / self.Z_ref


class StubCPNF2FF:
    """Far field with a given (E_theta, E_phi) everywhere."""

    def __init__(self, et, ep):
        self.et, self.ep = et, ep
        self.calls = []

    def CalcNF2FF(self, sim_path, freqs, theta, phi, center):
        self.calls.append(list(freqs))
        shape = (len(theta), len(phi))
        th = np.deg2rad(theta)[:, None] * np.ones(shape)
        e = np.cos(th / 2) ** 4 + 1e-3        # a broad beam toward +z
        return types.SimpleNamespace(
            E_norm=[e for _ in freqs], Dmax=[10.0 for _ in freqs], Prad=[1e-3 for _ in freqs],
            E_theta=[self.et * e for _ in freqs], E_phi=[self.ep * e for _ in freqs])


def wg_sim():
    sim = Simulation(8e9, 12e9, boundaries=["PML_8"] * 6)
    sim.ports = [{"number": 1, "type": "waveguide", "mode": "TE10", "R": 499.0, "direction": "z",
                  "start": [0, 0, 0], "stop": [0, 0, 1], "excite": True}]
    sim._port_objs = [StubWGPort()]
    sim.sim_path = "/nonexistent"
    return sim


class WaveguidePortTest(unittest.TestCase):
    def test_zref_scalar(self):
        f = np.linspace(8e9, 12e9, 5)
        self.assertEqual(_zref_scalar(50, f), 50.0)
        self.assertAlmostEqual(_zref_scalar(np.linspace(600, 400, 5), f), 500.0, places=6)

    def test_evaluate_with_frequency_dependent_zref(self):
        res = wg_sim().evaluate(n_freq=9)
        port = res["ports"]["1"]
        np.testing.assert_allclose(port["s11_re"], GAMMA)
        self.assertEqual(len(port["z_ref_f"]), 9)
        self.assertAlmostEqual(port["z_ref"], port["z_ref_f"][4], places=2)   # band centre
        self.assertGreater(port["z_ref_f"][0], port["z_ref_f"][-1])            # falls with frequency
        self.assertEqual(res["signals"], {})                                   # no scalar Z_ref

    def test_accepted_power_is_openems_p_inc_minus_p_ref(self):
        # pacc_w = 0.5 Re(U I*) must equal openEMS' own port power P_inc - P_ref (Port.CalcPort)
        # for the frequency-dependent TE10 wave impedance, and does not depend on Z_ref at all
        f0 = 10e9
        sim = wg_sim()
        sim.nf2ff = StubCPNF2FF(1.0, 0.0)
        sim.nf2ff_center = None
        ff = sim.evaluate(n_freq=5, pattern_freqs=[f0])["farfield"][0]
        z = 376.73 / np.sqrt(1 - (6.557e9 / f0) ** 2)
        p_inc, p_ref = 0.5 / z, 0.5 * GAMMA ** 2 / z
        self.assertAlmostEqual(ff["pacc_w"] / (p_inc - p_ref), 1.0, places=6)

    def test_efficiency_above_one_is_flagged(self):
        f0 = 10e9
        z = 376.73 / np.sqrt(1 - (6.557e9 / f0) ** 2)
        pacc = 0.5 * (1 - GAMMA ** 2) / z
        for eff, flagged in ((0.97, False), (1.0, False), (1.04, True)):
            with self.subTest(eff=eff):
                sim = wg_sim()
                sim.nf2ff = StubCPNF2FF(1.0, 0.0)
                sim.nf2ff_center = None
                calc = sim.nf2ff.CalcNF2FF
                sim.nf2ff.CalcNF2FF = lambda *a, **k: types.SimpleNamespace(
                    **{**vars(calc(*a, **k)), "Prad": [eff * pacc]})
                ff = sim.evaluate(n_freq=5, pattern_freqs=[f0])["farfield"][0]
                self.assertAlmostEqual(ff["rad_efficiency"], eff, places=4)
                self.assertEqual("qa_warnings" in ff, flagged)
                if flagged:
                    self.assertIn("104.0 %", ff["qa_warnings"][0])
                    self.assertGreater(ff["gain_dbi"], ff["dmax_dbi"])   # kept as computed, flagged

    def test_lossless_model_reports_unit_efficiency_within_the_tolerance(self):
        # a model marked lossless (all PEC, loss-free materials): efficiency 1 while the measured
        # Prad / Pacc is within LOSSLESS_TOLERANCE, which stays as rad_efficiency_raw; beyond it,
        # the measured value with a warning. The powers themselves are never altered (#12, #162).
        from fairbeam.simulation import LOSSLESS_TOLERANCE
        f0 = 10e9
        z = 376.73 / np.sqrt(1 - (6.557e9 / f0) ** 2)
        pacc = 0.5 * (1 - GAMMA ** 2) / z
        for ratio, unit in ((1.037, True), (0.97, True), (1 + LOSSLESS_TOLERANCE + 0.03, False)):
            with self.subTest(ratio=ratio):
                sim = wg_sim()
                sim.lossless = True
                sim.nf2ff = StubCPNF2FF(1.0, 0.0)
                sim.nf2ff_center = None
                calc = sim.nf2ff.CalcNF2FF
                sim.nf2ff.CalcNF2FF = lambda *a, **k: types.SimpleNamespace(
                    **{**vars(calc(*a, **k)), "Prad": [ratio * pacc]})
                ff = sim.evaluate(n_freq=5, pattern_freqs=[f0])["farfield"][0]
                self.assertAlmostEqual(ff["pacc_w"], pacc, places=12)          # the port's own value
                self.assertAlmostEqual(ff["prad_w"], ratio * pacc, places=12)
                self.assertAlmostEqual(ff["rad_efficiency_raw"], ratio, places=4)
                self.assertEqual(ff["rad_efficiency"], 1.0 if unit else round(ratio, 4))
                self.assertIn("lossless model", ff["qa_warnings"][0])
                if unit:
                    self.assertEqual(ff["gain_dbi"], ff["dmax_dbi"])
                else:
                    self.assertIn("beyond the 5 % tolerance", ff["qa_warnings"][0])

    def test_lossless_opt_in_is_checked(self):
        sim = wg_sim()
        sim.lossless = True
        self.assertTrue(sim._is_lossless())
        sim.dielectric("sub", 3.38, tan_d=0.002)
        self.assertFalse(sim._is_lossless())   # a lossy material: reported as measured

    def test_touchstone_keeps_the_native_reference(self):
        from fairbeam.touchstone import reflection
        res = wg_sim().evaluate(n_freq=9)
        bundle = {"ports": [{"number": 1, "excite": True, "type": "waveguide"}], "results": res}
        f, s, z, key = reflection(bundle, z_ref=50.0)      # a 50 ohm request is ignored
        np.testing.assert_allclose(s.real, GAMMA)
        self.assertEqual(z, res["ports"]["1"]["z_ref"])

    def test_port_record(self):
        sim = Simulation(8e9, 12e9, boundaries=["PML_8"] * 6)
        sim.waveguide_port(1, [-11.43, -5.08, 0], [11.43, 5.08, 2], "z", 22.86, 10.16, "TE10")
        p = sim.ports[0]
        self.assertEqual((p["type"], p["mode"], p["a"], p["b"]), ("waveguide", "TE10", 22.86, 10.16))
        self.assertAlmostEqual(p["f_cutoff"] / 1e9, 6.557, places=3)
        self.assertAlmostEqual(p["R"], 376.73 / np.sqrt(1 - (6.557 / 10) ** 2), delta=0.5)


class CircularPolarisationTest(unittest.TestCase):
    def _cp(self, et, ep):
        theta = np.arange(0, 181, 3.0)
        phi = np.arange(0, 360, 5.0)
        res = types.SimpleNamespace(E_theta=[et * np.ones((len(theta), len(phi)))],
                                    E_phi=[ep * np.ones((len(theta), len(phi)))])
        d = np.full((len(theta), len(phi)), 10.0)
        return _circular(res, 0, d, theta, phi)

    def test_rhcp(self):
        # IEEE / e^{jwt}: RHCP along +z is theta_hat - j phi_hat at the pole
        cp = self._cp(1.0, -1j)
        self.assertAlmostEqual(cp["boresight"]["rhcp_dbi"], 10.0, places=3)
        self.assertLessEqual(cp["boresight"]["lhcp_dbi"], -40)
        self.assertAlmostEqual(cp["boresight"]["axial_ratio_db"], 0.0, places=3)

    def test_lhcp_and_linear(self):
        cp = self._cp(1.0, 1j)
        self.assertAlmostEqual(cp["boresight"]["lhcp_dbi"], 10.0, places=3)
        lin = self._cp(1.0, 0.0)
        self.assertAlmostEqual(lin["boresight"]["rhcp_dbi"], 10 - 3.0103, places=3)
        self.assertAlmostEqual(lin["boresight"]["lhcp_dbi"], 10 - 3.0103, places=3)
        self.assertEqual(lin["boresight"]["axial_ratio_db"], 60.0)          # capped

    def test_elliptical_axial_ratio(self):
        cp = self._cp(1.0, -0.5j)        # axes 1 and 0.5: AR = 2 = 6.02 dB
        self.assertAlmostEqual(cp["boresight"]["axial_ratio_db"], 20 * np.log10(2), places=3)

    def test_evaluate_emits_cp_only_when_enabled(self):
        for on in (False, True):
            sim = wg_sim()
            sim.nf2ff = StubCPNF2FF(1.0, -1j)
            sim.nf2ff_center = None
            sim.cp_outputs = on
            ff = sim.evaluate(n_freq=5, pattern_freqs=[10e9])["farfield"][0]
            self.assertEqual("cp" in ff, on)
            if on:
                self.assertEqual(len(ff["cp"]["axial_ratio_db"]), len(ff["theta"]))
                self.assertLess(ff["cp"]["peak"]["axial_ratio_db"], 0.01)

    def test_model_pattern_frequencies(self):
        sim = wg_sim()
        sim.nf2ff = StubCPNF2FF(1.0, 0.0)
        sim.nf2ff_center = None
        sim.pattern_freqs = [9e9, 11e9]
        sim.evaluate(n_freq=5)
        self.assertEqual(sim.nf2ff.calls[0], [9e9, 11e9])
        sim.evaluate(n_freq=5, pattern_freqs=[10e9])              # an explicit request wins
        self.assertEqual(sim.nf2ff.calls[1], [10e9])


class NF2FFFacesTest(unittest.TestCase):
    def test_skipped_face_and_placement(self):
        sim = Simulation(8e9, 12e9, boundaries=["PML_8", "PML_8", "MUR", "MUR", "PML_8", "PEC"])
        for a in "xyz":
            sim.mesh.AddLine(a, np.arange(-20.0, 20.5, 1.0))
        nf = sim.add_nf2ff_box(directions=[1, 1, 1, 1, 0, 1])
        self.assertEqual(nf.directions, [True, True, True, True, False, False])   # PEC face: mirror
        self.assertEqual(nf.mirror, [0, 0, 0, 0, 0, 1])
        np.testing.assert_allclose(nf.start, [-11, -18, -11])    # PML_8: 9 lines in; MUR: 2
        np.testing.assert_allclose(nf.stop, [11, 18, 20])
        self.assertEqual(sim.nf2ff_faces, [True, True, True, True, False, True])


if __name__ == "__main__":
    unittest.main()
