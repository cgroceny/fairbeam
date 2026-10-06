"""Surface-current helpers (fairbeam.fields) without running openEMS."""

import base64
import unittest

import numpy as np

from fairbeam import Simulation
from fairbeam.fields import _inside, _phase_payload, _resample, attach, driven_port, section, sheet_planes
from fairbeam.geometry import read_structure
from fairbeam.simulation import excite_only


def patch_sim():
    sim = Simulation(1e9, 3e9)
    sub = sim.dielectric("sub", 3.38)
    sub.AddBox(priority=0, start=[-30, -30, 0], stop=[30, 30, 1.5])
    sim.metal("gnd").AddBox(priority=10, start=[-30, -30, 0], stop=[30, 30, 0])
    patch = sim.metal("patch")
    patch.AddBox(priority=10, start=[-16, -20, 1.5], stop=[16, 20, 1.5])
    tri = sim.metal("tri")
    tri.AddPolygon(np.array([[0, 10, 0], [0, 0, 10]], float), "y", 5.0, priority=10)  # (z, x) points
    sim.metal("solid").AddBox(start=[0, 0, 0], stop=[1, 1, 1])  # not a sheet
    return sim


class SheetPlanesTest(unittest.TestCase):
    def test_detects_sheets(self):
        planes = sheet_planes(patch_sim())
        keys = {(p["axis"], p["position"]) for p in planes}
        self.assertEqual(keys, {(2, 0.0), (2, 1.5), (1, 5.0)})
        by = {(p["axis"], p["position"]): p for p in planes}
        self.assertEqual(by[(2, 1.5)]["parts"], ["patch"])
        self.assertEqual(by[(2, 1.5)]["u_range"], [-16.0, 16.0])  # u = x, v = y for a z-normal plane
        self.assertEqual(by[(2, 1.5)]["v_range"], [-20.0, 20.0])
        self.assertEqual(by[(1, 5.0)]["u_range"], [0.0, 10.0])      # u = z for a y-normal plane
        # smallest sheets first, so a cap drops the big ground plane
        self.assertEqual(planes[-1]["parts"], ["gnd"])
        self.assertEqual(len(sheet_planes(patch_sim(), max_planes=2)), 2)

    def test_attach_adds_dumps_that_are_not_nf2ff(self):
        sim = patch_sim()
        planes = attach(sim, [2.4e9, 2.5e9])
        self.assertEqual(len(planes), 3)
        self.assertTrue(all(p["name"].startswith("fairbeam_J_") for p in planes))
        _, helpers, nf2ff = read_structure(sim.csx, sim.materials)
        self.assertEqual(sum(h["type"] == "DumpBox" for h in helpers), 3)
        self.assertIsNone(nf2ff)  # field dumps must not be mistaken for the NF2FF box
        self.assertEqual(sim.field_freqs, [2.4e9, 2.5e9])
        self.assertIsNone(sim.field_port)  # no port in this model: the excitation is unknown


def two_port_sim(first=1, second=2):
    sim = patch_sim()
    sim.lumped_port(first, 50, [-5, 0, 0], [-5, 0, 1.5], "z")
    sim.lumped_port(second, 50, [5, 0, 0], [5, 0, 1.5], "z")
    return sim


class DrivenPortTest(unittest.TestCase):
    """fields.port: the one port driven in the run that recorded the maps (#90)."""

    def test_the_one_excited_port_of_the_build(self):
        with excite_only(2):  # multiport rebuilds the model like this for each excited port
            sim = two_port_sim()
        attach(sim, [2.4e9])
        self.assertEqual(sim.field_port, 2)
        with excite_only(3):  # port numbers need not start at 1
            self.assertEqual(driven_port(two_port_sim(3, 4)), 3)

    def test_several_or_no_excited_ports_are_unknown(self):
        self.assertIsNone(driven_port(two_port_sim()))  # both excited as the model says: no single port
        with excite_only(9):
            self.assertIsNone(driven_port(two_port_sim()))

    def test_section_stores_the_port_only_when_known(self):
        plane = {"name": "fairbeam_J_z0", "frequencies": []}
        self.assertEqual(section([plane], 2)["port"], 2)
        self.assertNotIn("port", section([plane], None))
        self.assertEqual(section([plane], None)["planes"], [plane])


class MaskAndResampleTest(unittest.TestCase):
    def test_inside_rect_and_polygon(self):
        uu, vv = np.meshgrid(np.linspace(-1, 11, 13), np.linspace(-1, 11, 13))
        rect = {"kind": "rect", "u": [0, 4], "v": [0, 2]}
        m = _inside([rect], uu, vv)
        self.assertEqual(int(m.sum()), 5 * 3)
        tri = {"kind": "poly", "pts": np.array([[0, 0], [10, 0], [0, 10]], float)}
        m = _inside([tri], uu + 0.25, vv + 0.25)  # offset avoids points exactly on the hypotenuse
        self.assertTrue(m[1, 1] and not m[-1, -1])
        self.assertAlmostEqual(m.sum() / 55.0, 1.0, delta=0.2)  # ~ half of the 10 x 10 square

    def test_resample_linear_field_is_exact(self):
        lu = np.array([0.0, 0.5, 2.0, 3.0])
        lv = np.array([0.0, 1.0, 4.0])
        uu, vv = np.meshgrid(lu, lv, indexing="ij")
        values = 2 * uu + 3 * vv
        gu, gv = np.linspace(0, 3, 7), np.linspace(0, 4, 5)
        out = _resample(lu, lv, values, gu, gv)
        self.assertEqual(out.shape, (5, 7))
        np.testing.assert_allclose(out, 2 * gu[None, :] + 3 * gv[:, None])

    def test_phase_payload_shape_scaling_mask_and_quarter_cycle(self):
        # Inputs are (u, v), output bytes are (v, u, four components).
        lu = lv = np.array([0.0, 1.0])
        grid = np.array([0.0, 1.0])
        ju = np.full((2, 2), 1j, dtype=complex)
        jv = np.full((2, 2), 0.5 + 0j, dtype=complex)
        mask = np.array([[True, False], [True, True]])
        raw = base64.b64decode(_phase_payload(ju, jv, lu, lv, grid, grid, mask, 1.0))
        q = np.frombuffer(raw, dtype=np.int8).reshape(2, 2, 4)
        self.assertEqual(q.shape, (2, 2, 4))
        np.testing.assert_array_equal(q[0, 0], [0, 127, 64, 0])
        np.testing.assert_array_equal(q[0, 1], [0, 0, 0, 0])  # outside metal
        # Re{J exp(+j phase)} = re cos(phase) - im sin(phase).
        self.assertEqual(int(q[0, 0, 1] * -1), -127)  # at +90 degrees the value is -Im(J)

    def test_phase_payload_transposes_in_plane_axes(self):
        lu = lv = np.array([0.0, 1.0])
        grid = np.array([0.0, 1.0])
        # Simulate input axes ordered (v, u): distinct Ju real samples reveal transposition.
        ju = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=complex)
        zero = np.zeros((2, 2), dtype=complex)
        q = np.frombuffer(base64.b64decode(_phase_payload(
            ju, zero, lu, lv, grid, grid, np.ones((2, 2), bool), 4.0, transpose=True
        )), dtype=np.int8).reshape(2, 2, 4)
        np.testing.assert_array_equal(q[:, :, 0], [[32, 64], [95, 127]])


if __name__ == "__main__":
    unittest.main()
