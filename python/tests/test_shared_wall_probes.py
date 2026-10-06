"""Shared PEC-wall TE10 probes; optional physical regression on the installed openEMS runtime.

Run the FDTD control explicitly with FAIRBEAM_TEST_FDTD=1. It builds two sealed WR-90 guides,
uses four serial excitations per placement, and keeps raw output in a temporary directory.
"""
import gc
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

import numpy as np

from fairbeam.multiport import run_model, s_from_section
from fairbeam.simulation import Simulation
from fairbeam.wgport import inset_mode_probes, probe_power_factor


def sealed_guides(inset=False, direction="z", reverse=False):
    a, b, h = 22.86, 10.16, 4.15 / 5
    z = np.arange(-20 - 20 * h, 20 + 20 * h + 1e-9, h)
    axes = [("xyz".index(direction) + k) % 3 for k in (1, 2, 0)]

    def point(x, y, zz):
        p = np.zeros(3)
        p[axes] = [x, y, zz]
        return p

    boundaries = ["PEC"] * 6
    boundaries[axes[2] * 2:axes[2] * 2 + 2] = ["PML_8"] * 2
    sim = Simulation(7e9, 11e9, boundaries=boundaries, max_timesteps=100000)
    sim.mesh.AddLine(axes[0], np.linspace(-a / 2, a / 2, int(np.ceil(a / h)) + 1))
    yy = np.linspace(0, b, int(np.ceil(b / h)) + 1)
    sim.mesh.AddLine(axes[1], np.unique(np.r_[-yy, yy]))
    sim.mesh.AddLine(axes[2], z)
    wall = sim.metal("partition")
    wall.AddBox(start=point(-a / 2, 0, z[0]), stop=point(a / 2, 0, z[-1]), priority=10)
    for number, (left, upper) in enumerate(((True, False), (False, False), (True, True), (False, True)), 1):
        y0, y1 = (0, b) if upper else (-b, 0)
        if reverse:
            y0, y1 = y1, y0
        zz = z[12] if left else z[-13]
        port = sim.waveguide_port(number, point(-a / 2, y0, zz),
                                 point(a / 2, y1, zz + (2 * h if left else -2 * h)),
                                 direction, a, b)
        if inset:
            inset_mode_probes(port)
    return sim


def boxes(port, kind):
    return [(p.GetPrimitive(0).GetStart().tolist(), p.GetPrimitive(0).GetStop().tolist())
            for p in port.port_props if p.GetTypeString() == kind]


class ProbePlacementTest(unittest.TestCase):
    def test_only_mode_probes_move_for_each_direction_and_corner_order(self):
        for direction in "xyz":
            for reverse in (False, True):
                with self.subTest(direction=direction, reverse=reverse):
                    sim = sealed_guides(direction=direction, reverse=reverse)
                    mesh_before = [sim.mesh.GetLines(k) for k in range(3)]
                    metadata = json.dumps(sim.ports)
                    for port in sim._port_objs:
                        axis = port.ny_PP
                        source = boxes(port, "Excitation")
                        before = boxes(port, "ProbeBox")
                        self.assertIs(inset_mode_probes(port), port)
                        self.assertEqual(source, boxes(port, "Excitation"))
                        for (old_lo, old_hi), (lo, hi) in zip(before, boxes(port, "ProbeBox")):
                            other = [k for k in range(3) if k != axis]
                            np.testing.assert_array_equal(np.array(old_lo)[other], np.array(lo)[other])
                            np.testing.assert_array_equal(np.array(old_hi)[other], np.array(hi)[other])
                            self.assertGreater(min(lo[axis], hi[axis]), min(old_lo[axis], old_hi[axis]))
                            self.assertLess(max(lo[axis], hi[axis]), max(old_lo[axis], old_hi[axis]))
                        once = boxes(port, "ProbeBox")
                        inset_mode_probes(port)
                        self.assertEqual(once, boxes(port, "ProbeBox"))
                    self.assertEqual(metadata, json.dumps(sim.ports))
                    for k in range(3):
                        np.testing.assert_array_equal(mesh_before[k], sim.mesh.GetLines(k))

    def test_default_keeps_full_width_and_adds_no_inset_attribute(self):
        sim = sealed_guides()
        for port in sim._port_objs:
            self.assertFalse(hasattr(port, "_fairbeam_probe_inset_cells"))
            for lo, hi in boxes(port, "ProbeBox"):
                self.assertEqual(sorted((lo[port.ny_PP], hi[port.ny_PP])),
                                 sorted((port.start[port.ny_PP], port.stop[port.ny_PP])))

    def test_bad_inputs_leave_every_probe_unchanged(self):
        for cells in (0, -1, True, 1.5, 100):
            sim = sealed_guides()
            port = sim._port_objs[0]
            before = boxes(port, "ProbeBox")
            with self.subTest(cells=cells), self.assertRaises(ValueError):
                inset_mode_probes(port, cells=cells)
            self.assertEqual(before, boxes(port, "ProbeBox"))
        sim = sealed_guides()
        port = sim._port_objs[0]
        port.WG_mode = "TE11"
        with self.assertRaisesRegex(ValueError, "TE10"):
            inset_mode_probes(port)

    def test_nonuniform_mesh_uses_the_actual_neighboring_lines(self):
        sim = sealed_guides()
        sim.mesh.AddLine("y", [-10.0, -0.1])
        port = sim._port_objs[0]
        inset_mode_probes(port)
        for lo, hi in boxes(port, "ProbeBox"):
            self.assertEqual((lo[1], hi[1]), (-10.0, -0.1))

    def test_power_factor_preserves_default_and_rejects_unsupported_insets(self):
        sim = sealed_guides()
        args = (sim.mesh.GetLines("x"), sim.mesh.GetLines("y"), (-11.43, -10.16), (11.43, 0), 22.86, 10.16)
        self.assertEqual(probe_power_factor(*args), probe_power_factor(*args, inset_cells=0))
        self.assertTrue(np.isfinite(probe_power_factor(*args, inset_cells=1)))
        for cells in (-1, True, 0.5):
            with self.assertRaises(ValueError):
                probe_power_factor(*args, inset_cells=cells)
        with self.assertRaisesRegex(ValueError, "TE10"):
            probe_power_factor(*args, mode="TE11", inset_cells=1)


@unittest.skipUnless(os.environ.get("FAIRBEAM_TEST_FDTD") == "1", "explicit FDTD opt-in required")
class SealedWallFDTDTest(unittest.TestCase):
    def test_cross_guide_leakage_is_removed(self):
        measurements = {}
        with tempfile.TemporaryDirectory(prefix="fairbeam-shared-wall-") as tmp:
            for name, inset in (("before", False), ("after", True)):
                model = SimpleNamespace(build=lambda p: sealed_guides(p["inset"]))
                # A sealed, unexcited guide has exactly zero signals: its individual U/I and
                # reflected/incident ratios are undefined; the assembled four-port S-matrix is not.
                with np.errstate(divide="ignore", invalid="ignore"):
                    sim = run_model(model, {"inset": inset}, excite="all", sim_path=str(Path(tmp) / name),
                                    threads=4, exact=True, end_db=-60, n_freq=201, element_patterns=False,
                                    log=lambda message: None)
                s = s_from_section(sim.results["sparams"])
                self.assertTrue(np.all(np.isfinite(s)))
                self.assertTrue(sim.run_stats["converged"])
                cross = max(np.max(np.abs(s[:, 2:, :2])), np.max(np.abs(s[:, :2, 2:])))
                k = int(np.argmin(np.abs(np.asarray(sim.results["frequency"]) - 9e9)))
                measurements[name] = {"cross_guide_max": float(cross),
                                      "cross_guide_at_9ghz_max": float(max(np.max(abs(s[k, 2:, :2])),
                                                                         np.max(abs(s[k, :2, 2:])))),
                                      "reciprocity_max": sim.results["sparams"]["qa"]["reciprocity_max"],
                                      "cells": int(np.prod([len(sim.mesh.GetLines(k)) - 1 for k in range(3)])),
                                      "wall_time_s": sim.run_stats["wall_time_total_s"]}
                # Release native probe writers before TemporaryDirectory cleans up on Windows.
                del sim
                gc.collect()
        destination = os.environ.get("FAIRBEAM_PROBE_TEST_REPORT")
        if destination:
            Path(destination).write_text(json.dumps(measurements, indent=2) + "\n", encoding="utf-8")
        self.assertGreater(measurements["before"]["cross_guide_max"], 0.001)
        self.assertGreater(measurements["before"]["reciprocity_max"], 0.02)
        self.assertLess(measurements["after"]["cross_guide_max"], 1e-8)
        self.assertLess(measurements["after"]["reciprocity_max"], 1e-6)


if __name__ == "__main__":
    unittest.main()
