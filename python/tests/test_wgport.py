"""Waveguide port power calibration (fairbeam.wgport, #12): the mode-matching probes' deficit at the
guide walls, computed from the mesh, and its use in Simulation.evaluate (stub ports, no FDTD run)."""

import unittest

import numpy as np

from fairbeam.simulation import Simulation
from fairbeam.wgport import mode_functions, probe_power_factor

# Mesh lines (mm) of the pyramidal horn's WR-90 feed guide (22.86 x 10.16 mm, walls at +-11.43 and
# +-5.08) as fairbeam.automesh generates them at 20 and 30 cells/lambda, from -a/2 - 2 to a/2 + 2
X20 = [-13.43, -13.0967, -12.7633, -12.43, -12.0967, -11.7633, -11.43, -11.0381, -10.4897, -9.7222,
       -8.6488, -7.4132, -6.1777, -4.9422, -3.7066, -2.4711, -1.2355, 0.0, 1.2355, 2.4711, 3.7066,
       4.9422, 6.1777, 7.4132, 8.6488, 9.7222, 10.4897, 11.0381, 11.43, 11.7633, 12.0967, 12.43,
       12.7633, 13.0967, 13.43]
Y20 = [-7.08, -6.7467, -6.4133, -6.08, -5.7467, -5.4133, -5.08, -4.6988, -4.1695, -3.4343, -2.4133,
       -1.2067, 0.0, 1.2067, 2.4133, 3.4343, 4.1695, 4.6988, 5.08, 5.4133, 5.7467, 6.08, 6.4133,
       6.7467, 7.08]
X30 = [-13.43, -12.7633, -12.0967, -11.43, -10.6257, -9.8084, -8.991, -8.1736, -7.3563, -6.5389,
       -5.7215, -4.9042, -4.0868, -3.2695, -2.4521, -1.6347, -0.8174, 0.0, 0.8174, 1.6347, 2.4521,
       3.2695, 4.0868, 4.9042, 5.7215, 6.5389, 7.3563, 8.1736, 8.991, 9.8084, 10.6257, 11.43,
       12.0967, 12.7633, 13.43]
Y30 = [-7.08, -6.4133, -5.7467, -5.08, -4.3094, -3.5259, -2.7424, -1.9588, -1.1753, -0.3918, 0.3918,
       1.1753, 1.9588, 2.7424, 3.5259, 4.3094, 5.08, 5.7467, 6.4133, 7.08]
A, B = 22.86, 10.16

# Measured on the GPU engine (docs/BUNDLE.md, horn power balance): the exact Yee-lattice Poynting
# flux through the feed guide over the accepted power the port reported, the mean of 8, 10, 12 GHz
# (1.0433, 1.0436, 1.0426 and 1.0856, 1.0866, 1.0842); the same flux, through the closed NF2FF
# box and through planes inside the horn, agreed to 0.1-0.4 %
MEASURED_20, MEASURED_30 = 1.0432, 1.0855


def factor(x, y, mode="TE10", a=A, b=B):
    return probe_power_factor(x, y, (-a / 2, -b / 2), (a / 2, b / 2), a, b, mode)


class ProbeFactorTest(unittest.TestCase):
    def test_reproduces_the_measured_deficit_of_the_horn_feed(self):
        self.assertAlmostEqual(factor(X20, Y20), MEASURED_20, delta=0.003)
        self.assertAlmostEqual(factor(X30, Y30), MEASURED_30, delta=0.003)

    def test_the_deficit_follows_the_wall_cells_not_the_frequency(self):
        # 30 cells/lambda puts 0.77 mm air cells next to the broad walls (0.38 mm at 20)
        self.assertGreater(factor(X30, Y30), factor(X20, Y20) + 0.03)

    def test_first_order_in_the_wall_cell_size(self):
        # the excess over 1 halves with the cell: it is a discretisation error of the probes, and
        # a uniform mesh of h-mm cells with the walls on lines leaves 5 % at h = 0.508 mm
        excess = {h: factor(*_grid(h)) - 1.0 for h in (0.508, 0.254, 0.127)}
        self.assertAlmostEqual(excess[0.508], 0.052, delta=0.004)
        self.assertAlmostEqual(excess[0.508] / excess[0.254], 2.0, delta=0.2)
        self.assertAlmostEqual(excess[0.254] / excess[0.127], 2.0, delta=0.2)

    def test_other_modes_and_orientations_are_finite(self):
        x, y = _grid(0.508)
        for mode in ("TE10", "TE20", "TE01", "TE11", "TE21"):
            f = factor(x, y, mode)
            self.assertTrue(0.95 < f < 1.3, (mode, f))

    def test_box_on_the_domain_boundary_drops_a_node(self):
        # ProcessModeMatch leaves out a box side on the first / last mesh line
        x, y = _grid(0.508)
        f_inside = factor(x, y)
        f_edge = probe_power_factor(x[6:-6], y[6:-6], (x[6], y[6]), (x[-7], y[-7]), A, B)
        self.assertTrue(np.isfinite(f_edge))
        self.assertNotAlmostEqual(f_inside, f_edge, places=3)

    def test_rejects_unsupported_input(self):
        x, y = _grid(0.508)
        with self.assertRaises(ValueError):
            factor(x, y, "TM11")
        with self.assertRaises(ValueError):
            probe_power_factor(x, y, (0.0, 0.0), (0.4, 0.4), A, B)   # under two cells

    def test_template_is_the_openems_te_mode(self):
        e_p, e_pp, h_p, h_pp = mode_functions(1, 0, A, B)
        x, y = np.array([[A / 2]]), np.array([[B / 2]])
        self.assertAlmostEqual(float(e_pp(x, y)[0, 0]), -1 / A)      # TE10: E along the b axis
        self.assertAlmostEqual(float(h_p(x, y)[0, 0]), 1 / A)
        self.assertEqual(float(e_p(x, y)[0, 0]), 0.0)


def _grid(h):
    """Uniform mesh with lines on the walls (h divides a and b) plus one metal cell each side."""
    x = -A / 2 + h * np.arange(-1, int(round(A / h)) + 2)
    y = -B / 2 + h * np.arange(-1, int(round(B / h)) + 2)
    return x, y


class StubWG:
    def CalcPort(self, sim_path, f):
        n = len(f)
        self.Z_ref = np.full(n, 500.0)
        self.uf_inc = np.ones(n, dtype=complex)
        self.uf_ref = np.full(n, 0.2, dtype=complex)
        self.uf_tot = self.uf_inc + self.uf_ref
        self.if_inc = self.uf_inc / self.Z_ref
        self.if_ref = self.uf_ref / self.Z_ref
        self.if_tot = self.if_inc - self.if_ref
        self.P_inc = 0.5 * np.real(self.uf_inc * np.conj(self.if_inc))
        self.P_ref = 0.5 * np.real(self.uf_ref * np.conj(self.if_ref))
        self.P_acc = self.P_inc - self.P_ref


def sim_with_guide(x=X20, y=Y20):
    sim = Simulation(8e9, 12e9, boundaries=["PML_8"] * 6)
    sim.mesh.AddLine("x", x)
    sim.mesh.AddLine("y", y)
    sim.mesh.AddLine("z", [-20.0, -10.0, 0.0, 10.0])
    sim.ports = [{"number": 1, "type": "waveguide", "mode": "TE10", "a": A, "b": B, "R": 499.0,
                  "direction": "z", "start": [-A / 2, -B / 2, -10.0], "stop": [A / 2, B / 2, 0.0], "excite": True}]
    sim._port_objs = [StubWG()]
    sim.sim_path = "/nonexistent"
    return sim


class CalibrationTest(unittest.TestCase):
    def test_powers_scale_by_the_factor_and_s11_does_not(self):
        sim = sim_with_guide()
        c = factor(X20, Y20)
        res = sim.evaluate(n_freq=5)
        port = res["ports"]["1"]
        self.assertAlmostEqual(port["probe_power_factor"], c, places=4)
        np.testing.assert_allclose(port["s11_re"], 0.2, atol=1e-4)
        p = sim._port_objs[0]
        # 0.5 Re(U I*) of the total wave is P_inc - P_ref = c * (the stub's raw value)
        raw_acc = 0.5 * (1 - 0.2 ** 2) / 500.0
        self.assertAlmostEqual(float(0.5 * np.real(p.uf_tot[0] * np.conj(p.if_tot[0]))) / raw_acc, c, places=6)
        self.assertAlmostEqual(float(p.P_acc[0]) / raw_acc, c, places=6)
        self.assertAlmostEqual(float(p.P_inc[0]) / (0.5 / 500.0), c, places=6)

    def test_can_be_switched_off(self):
        sim = sim_with_guide()
        sim.wg_probe_correction = False
        port = sim.evaluate(n_freq=5)["ports"]["1"]
        self.assertNotIn("probe_power_factor", port)
        self.assertAlmostEqual(float(0.5 * np.real(sim._port_objs[0].uf_tot[0] * np.conj(sim._port_objs[0].if_tot[0]))),
                               0.5 * (1 - 0.2 ** 2) / 500.0, places=12)

    def test_opt_in_inset_uses_its_own_power_factor(self):
        sim = sim_with_guide()
        sim._port_objs[0]._fairbeam_probe_inset_cells = 1
        c = probe_power_factor(X20, Y20, (-A / 2, -B / 2), (A / 2, B / 2), A, B, inset_cells=1)
        self.assertNotAlmostEqual(c, factor(X20, Y20), places=3)
        port = sim.evaluate(n_freq=5)["ports"]["1"]
        self.assertAlmostEqual(port["probe_power_factor"], c, places=4)
        self.assertAlmostEqual(float(sim._port_objs[0].P_acc[0]), c * 0.5 * (1 - 0.2 ** 2) / 500.0, places=12)
        self.assertAlmostEqual(port["s11_re"][0], 0.2, places=4)

    def test_lumped_ports_are_untouched(self):
        sim = sim_with_guide()
        sim.ports[0] = {"number": 1, "type": "lumped", "R": 50.0, "direction": "z",
                        "start": [0, 0, 0], "stop": [0, 0, 1], "excite": True}
        sim._port_objs = [StubWG()]
        port = sim.evaluate(n_freq=5)["ports"]["1"]
        self.assertNotIn("probe_power_factor", port)
        p = sim._port_objs[0]
        self.assertAlmostEqual(float(p.P_acc[0]), 0.5 * (1 - 0.2 ** 2) / 500.0, places=12)

    def test_a_port_without_geometry_is_left_alone(self):
        # ports assembled by hand (tests, older callers) have no a, b, start, stop: no correction
        sim = sim_with_guide()
        for k in ("a", "b"):
            del sim.ports[0][k]
        self.assertNotIn("probe_power_factor", sim.evaluate(n_freq=5)["ports"]["1"])

    def test_an_implausible_factor_is_not_applied(self):
        # a box far larger than the mesh resolves as a guide (two-cell mesh): outside the bounds
        sim = sim_with_guide(x=[-13.43, -11.43, 0.0, 11.43, 13.43], y=[-7.08, -5.08, 0.0, 5.08, 7.08])
        port = sim.evaluate(n_freq=5)["ports"]["1"]
        self.assertNotIn("probe_power_factor", port)


if __name__ == "__main__":
    unittest.main()
