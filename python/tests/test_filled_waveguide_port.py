"""Homogeneous rectangular TE references; FDTD control is opt-in, not part of discovery.

python tests/test_filled_waveguide_port.py --fdtd --out <outside-repo-dir> --cpw 20
"""
import argparse
import json
import unittest
from pathlib import Path

import numpy as np

from fairbeam import Simulation
from fairbeam.multiport import assemble_s
from fairbeam.simulation import excite_only
from fairbeam.wgport import _FilledRectWGPort
from openEMS.ports import RectWGPort

C0, ETA0 = 299792458.0, 376.730313668


def reference(f, a, eps_r, mu_r):
    k0 = 2 * np.pi * np.asarray(f) / C0
    beta = np.sqrt(k0 * k0 * eps_r * mu_r - (np.pi / a) ** 2)
    return beta, ETA0 * mu_r * k0 / beta


class ReferenceTests(unittest.TestCase):
    def make_port(self, eps_r=1.0, mu_r=1.0, direction="z"):
        sim = Simulation(14.5e9, 15.5e9)
        port = sim.waveguide_port(1, [-5.35, -2.15, -1], [5.35, 2.15, 0],
                                 direction, 10.7, 4.3, eps_r=eps_r, mu_r=mu_r)
        return sim, port

    def install_travelling_wave(self, port, z):
        def read(*args):
            port.uf_tot = np.ones(len(z), dtype=complex)
            port.if_tot = 1 / z
            port.ut_tot = np.ones(len(z))
            port.it_tot = 1 / z
        port.ReadUIData = read

    def test_default_air_uses_native_class_and_metadata(self):
        sim, port = self.make_port()
        self.assertIs(type(port), RectWGPort)
        self.assertNotIn("eps_r", sim.ports[0])
        self.assertNotIn("mu_r", sim.ports[0])
        self.assertAlmostEqual(sim.ports[0]["f_cutoff"] / (C0 / .0214), 1)

    def test_filling_changes_cutoff_impedance_and_wave_split(self):
        f = np.array([14.5e9, 15e9, 15.5e9])
        for eps_r, mu_r in ((2.08, 1), (4, 3), (1, 2)):
            with self.subTest(eps_r=eps_r, mu_r=mu_r):
                sim, port = self.make_port(eps_r, mu_r)
                self.assertIsInstance(port, _FilledRectWGPort)
                beta, z = reference(f, .0107, eps_r, mu_r)
                self.install_travelling_wave(port, z)
                port.CalcPort("unused", f)
                np.testing.assert_allclose(port.beta, beta, rtol=1e-12)
                np.testing.assert_allclose(port.Z_ref, z, rtol=1e-8)
                np.testing.assert_allclose(port.uf_ref, 0, atol=1e-8)
                np.testing.assert_allclose(port.P_acc, 1 / (2 * z), rtol=1e-8)
                self.assertAlmostEqual(sim.ports[0]["f_cutoff"] /
                                       (C0 / (.0214 * np.sqrt(eps_r * mu_r))), 1)
                self.assertAlmostEqual(sim.ports[0]["R"], z[1], delta=.00051)
                self.assertEqual((sim.ports[0]["eps_r"], sim.ports[0]["mu_r"]), (eps_r, mu_r))

    def test_reference_override_and_shift_use_filled_beta(self):
        f = np.array([14.8e9, 15.2e9])
        _, port = self.make_port(2.08)
        beta, z = reference(f, .0107, 2.08, 1)
        self.install_travelling_wave(port, z)
        port.CalcPort("unused", f, ref_plane_shift=3)
        # Native shift includes the source-to-probe separation of 1 mm.
        np.testing.assert_allclose(port.uf_tot, np.exp(-1j * beta * .002), rtol=1e-8)
        port.CalcPort("unused", f, ref_impedance=50)
        self.assertEqual(port.Z_ref, 50)
        np.testing.assert_allclose(port.uf_ref / port.uf_inc, (z - 50) / (z + 50), rtol=1e-10)
        port.CalcPort("unused", f, ref_impedance=50, ref_plane_shift=3)
        np.testing.assert_allclose(port.uf_tot, np.exp(-1j * beta * .002), rtol=1e-8)
        np.testing.assert_allclose(port.if_tot, port.uf_tot / z, rtol=1e-8)
        np.testing.assert_allclose(port.uf_ref / port.uf_inc, (z - 50) / (z + 50), rtol=1e-8)

    def test_below_cutoff_is_rejected_before_reading_files(self):
        _, port = self.make_port(2.08)
        for f in ([8e9], [-15e9], [np.nan], [np.inf]):
            with self.subTest(f=f), self.assertRaisesRegex(ValueError, "above the mode cutoff"):
                port.CalcPort("unused", f)

    def test_invalid_filling_is_rejected_without_creating_a_port(self):
        for value in (0, -1, np.inf, np.nan, True, [2], "2", 2 + 0j, 2 + 1j):
            for name in ("eps_r", "mu_r"):
                sim = Simulation(14.5e9, 15.5e9)
                with self.subTest(value=value, name=name), self.assertRaises(ValueError):
                    sim.waveguide_port(1, [-5, -2, -1], [5, 2, 0], "z", 10, 4, **{name: value})
                self.assertFalse(sim.ports)
                self.assertFalse(sim._port_objs)


def fdtd_build(cpw, corrected):
    a, b, length, eps_r = 10.7, 4.3, 30.0, 2.08
    sim = Simulation(14.5e9, 15.5e9, boundaries=["PEC"] * 4 + ["PML_8"] * 2,
                     max_timesteps=60000, end_criteria_db=-70)
    step = C0 / 15.5e9 / np.sqrt(eps_r) / 1e-3 / cpw
    nz = int(np.ceil(length / step))
    dz = length / nz
    for axis, size in (("x", a), ("y", b)):
        sim.mesh.AddLine(axis, np.linspace(-size / 2, size / 2, int(np.ceil(size / step)) + 1))
    z = dz * np.arange(-16, nz + 17)
    sim.mesh.AddLine("z", z)
    mat = sim.dielectric("filling", eps_r)
    mat.AddBox([-a / 2, -b / 2, z[0]], [a / 2, b / 2, z[-1]], priority=1)
    kw = {"eps_r": eps_r} if corrected else {}
    # Use actual mesh coordinates for the zero-thickness source planes. A
    # separately recomputed L + 2*dz can differ by an ulp and miss the plane.
    sim.waveguide_port(1, [-a / 2, -b / 2, z[14]], [a / 2, b / 2, z[16]], "z", a, b, **kw)
    sim.waveguide_port(2, [-a / 2, -b / 2, z[-15]], [a / 2, b / 2, z[-17]], "z", a, b, **kw)
    return sim


def fdtd_control():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fdtd", action="store_true")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--cpw", type=int, choices=(20, 30, 40, 60), default=20)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    f = np.linspace(14.5e9, 15.5e9, 201)
    before_a, before_b, after_a, after_b, runs = [], [], [], [], []
    for pn in (1, 2):
        with excite_only(pn):
            sim = fdtd_build(args.cpw, False)
        shape = np.array([len(sim.mesh.GetLines(ax)) for ax in "xyz"])
        print(json.dumps({"port": pn, "cells": int(np.prod(shape - 1)), "threads": 4}), flush=True)
        sim.run(str(args.out / f"excite-{pn}"), threads=4, exact=True, echo=False)
        stats = dict(sim.run_stats)
        # Some runtime builds leave C++ log formatting in fixed notation after
        # a run. The recorded excitation samples retain the actual time step.
        samples = np.loadtxt(Path(sim.sim_path) / "et", comments="%", max_rows=2)
        stats["timestep_from_excitation_s"] = float(samples[1, 0] - samples[0, 0])
        (args.out / f"run-{pn}.json").write_text(json.dumps(stats, indent=2) + "\n", encoding="utf-8")
        if not sim.run_stats.get("converged"):
            raise RuntimeError(f"port {pn} did not meet the energy stop; recorded in run-{pn}.json")
        sim.evaluate(n_freq=len(f))
        runs.append(stats)
        before_a.append([p.uf_inc / np.sqrt(p.Z_ref) for p in sim._port_objs])
        before_b.append([p.uf_ref / np.sqrt(p.Z_ref) for p in sim._port_objs])
        # Source profile and mesh are identical: only post-processing the same files changes.
        with excite_only(pn):
            corrected = fdtd_build(args.cpw, True)
        corrected.sim_path = sim.sim_path
        corrected.evaluate(n_freq=len(f))
        after_a.append([p.uf_inc / np.sqrt(p.Z_ref) for p in corrected._port_objs])
        after_b.append([p.uf_ref / np.sqrt(p.Z_ref) for p in corrected._port_objs])
    s0 = assemble_s(np.array(before_a), np.array(before_b), [1, 2], 2)
    s1 = assemble_s(np.array(after_a), np.array(after_b), [1, 2], 2)
    beta, z = reference(f, .0107, 2.08, 1)
    ideal = np.exp(-1j * beta * .03)
    j = len(f) // 2
    def metrics(s):
        return {"s11_db_at_15GHz": float(20 * np.log10(abs(s[j, 0, 0]))),
                "s21_db_at_15GHz": float(20 * np.log10(abs(s[j, 1, 0]))),
                "phase_error_deg_at_15GHz": float(np.angle(s[j, 1, 0] / ideal[j], deg=True)),
                "max_complex_s21_error": float(np.max(abs(s[:, 1, 0] - ideal)))}
    report = {"cpw": args.cpw, "cells": int(np.prod(shape - 1)), "runs": runs,
              "parameters": {"a_mm": 10.7, "b_mm": 4.3, "plane_distance_mm": 30,
                             "eps_r": 2.08, "mu_r": 1, "end_db": -70},
              "before": metrics(s0), "after": metrics(s1),
              "z_te_ohm_at_15GHz": float(z[j]),
              "scope": "Same recorded fields; not a mesh-convergence or loss validation."}
    np.savez_compressed(args.out / "sparams.npz", f=f, before=s0, after=s1, ideal=ideal)
    (args.out / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    import sys
    fdtd_control() if "--fdtd" in sys.argv else unittest.main()
