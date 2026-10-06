"""Plane-wave material cell (fairbeam.material_cell) and the analytic slab (fairbeam.analytic.slab_s):
cell setup, probe post-processing on synthetic voltages, the transfer-matrix slab against the
closed-form Fresnel slab (no FDTD run)."""

import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from fairbeam import material_cell
from fairbeam.analytic import C0, slab_s
from fairbeam.material_cell import (CELL_BOUNDARIES, EXCITATION_NAME, GRADING, PML_CELLS, PML_MARGIN_CELLS,
                                    PROBE_NAMES, PlaneWaveCell, cell_sparams, compare, higher_mode_frequencies,
                                    mode_warnings, probe_timestep, run_cell)
from fairbeam.model import load_model, resolve_params
from fairbeam.simulation import Simulation

EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "slab_cell.py"
F = np.linspace(1e9, 10e9, 46)


def write_probe(path, dt: float, stride: int = 3, n: int = 200):
    """An openEMS probe file (``%`` header, time and value columns) sampled every ``stride`` steps."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    t = np.arange(n) * stride * dt
    np.savetxt(path, np.c_[t, np.sin(t / dt / 50)], header="time value", comments="% ")


def fresnel_slab(f, d_mm, eps, mu=1.0):
    """Closed-form S11, S21 of one slab in vacuum (Orfanidis eq. 6.4.x)."""
    k0 = 2 * np.pi * np.asarray(f) / C0
    n, eta = np.sqrt(eps * mu), np.sqrt(mu / eps)
    r = (eta - 1) / (eta + 1)
    h = np.exp(-1j * k0 * n * d_mm * 1e-3)            # one pass through the slab
    e = h ** 2
    s11 = r * (1 - e) / (1 - r ** 2 * e)
    s21 = (1 - r ** 2) * h / (1 - r ** 2 * e)
    return s11, s21


class AnalyticSlab(unittest.TestCase):
    def test_matches_fresnel(self):
        for eps, mu in ((4.0, 1.0), (2.2 - 0.3j, 1.0), (3.0, 2.0)):
            s = slab_s(F, [{"thickness": 7.0, "eps_r": eps.real, "tan_d": -eps.imag / eps.real, "mu_r": mu}])
            s11, s21 = fresnel_slab(F, 7.0, eps, mu)
            np.testing.assert_allclose(s[:, 0, 0], s11, atol=1e-12)
            np.testing.assert_allclose(s[:, 1, 0], s21, atol=1e-12)
            np.testing.assert_allclose(s[:, 0, 1], s[:, 1, 0], atol=1e-12)   # reciprocal
            np.testing.assert_allclose(s[:, 1, 1], s[:, 0, 0], atol=1e-12)   # symmetric slab

    def test_lossless_conserves_power_and_half_wave_is_transparent(self):
        d, eps = 10.0, 4.0
        f0 = C0 / (2 * d * 1e-3 * np.sqrt(eps))          # 7.5 GHz
        s = slab_s(np.r_[F, f0], [{"thickness": d, "eps_r": eps}])
        np.testing.assert_allclose(np.abs(s[:, 0, 0]) ** 2 + np.abs(s[:, 1, 0]) ** 2, 1, atol=1e-12)
        self.assertLess(abs(s[-1, 0, 0]), 1e-12)
        # strongest reflection at the quarter-wave frequency: |S11| = (eps - 1) / (eps + 1)
        q = slab_s([f0 / 2], [{"thickness": d, "eps_r": eps}])
        self.assertAlmostEqual(abs(q[0, 0, 0]), 0.6, places=12)

    def test_vacuum_layer_is_a_delay_and_layers_cascade(self):
        s = slab_s(F, [{"thickness": 5.0, "eps_r": 1.0}])
        np.testing.assert_allclose(s[:, 0, 0], 0, atol=1e-12)
        np.testing.assert_allclose(s[:, 1, 0], np.exp(-2j * np.pi * F / C0 * 5e-3), atol=1e-12)
        one = slab_s(F, [{"thickness": 6.0, "eps_r": 3.0}])
        two = slab_s(F, [{"thickness": 2.5, "eps_r": 3.0}, {"thickness": 3.5, "eps_r": 3.0}])
        np.testing.assert_allclose(one, two, atol=1e-12)

    def test_conductivity_loss_follows_the_simulation(self):
        """tan_d at tan_d_freq from a constant conductivity: the loss tangent falls as 1 / f."""
        f_ref = 5e9
        s = slab_s(F, [{"thickness": 7.0, "eps_r": 4.0, "tan_d": 0.05, "tan_d_freq": f_ref}])
        s11, s21 = fresnel_slab(F, 7.0, 4.0 * (1 - 0.05j * f_ref / F))
        np.testing.assert_allclose(s[:, 0, 0], s11, atol=1e-12)
        np.testing.assert_allclose(s[:, 1, 0], s21, atol=1e-12)
        self.assertTrue(np.all(np.abs(s[:, 0, 0]) ** 2 + np.abs(s[:, 1, 0]) ** 2 < 1))


class PostProcessing(unittest.TestCase):
    def test_recovers_s_from_synthetic_probe_voltages(self):
        front, back, z1, z2 = 2.0, 12.0, -6.5, 21.25          # mm
        s = slab_s(F, [{"thickness": back - front, "eps_r": 4.0, "tan_d": 0.02, "tan_d_freq": 5e9}])
        k0 = 2 * np.pi * F / C0 * 1e-3                         # per mm
        a = (1 + 0.3j) * np.exp(-((F - 5e9) / 4e9) ** 2)       # excitation spectrum at z = 0
        inc = (a * np.exp(-1j * k0 * z1), a * np.exp(-1j * k0 * z2))
        at_front = a * np.exp(-1j * k0 * front)
        tot = (inc[0] + s[:, 0, 0] * at_front * np.exp(-1j * k0 * (front - z1)),
               s[:, 1, 0] * at_front * np.exp(-1j * k0 * (z2 - back)))
        res = cell_sparams(F, inc, tot, z1, z2, front, back)
        np.testing.assert_allclose(res["s11"], s[:, 0, 0], atol=1e-12)
        np.testing.assert_allclose(res["s21"], s[:, 1, 0], atol=1e-12)
        np.testing.assert_allclose(res["absorption"], 1 - res["R2"] - res["T2"])
        dev = compare(res, s)
        self.assertLess(max(dev.values()), 1e-9)

    def test_empty_cell_gives_no_reflection_and_unit_transmission(self):
        k0 = 2 * np.pi * F / C0 * 1e-3
        inc = (np.exp(-1j * k0 * -4.0), np.exp(-1j * k0 * 9.0))
        res = cell_sparams(F, inc, inc, -4.0, 9.0, 0.0, 0.0)
        np.testing.assert_allclose(res["s11"], 0, atol=1e-15)
        np.testing.assert_allclose(res["s21"], 1, atol=1e-12)


class CellSetup(unittest.TestCase):
    def build(self, **kw):
        sim = Simulation(1e9, 10e9)
        cell = PlaneWaveCell(sim, 5.0, 4.0, 0.0, 10.0, **kw)
        return sim, cell

    def test_boundaries_mesh_and_planes(self):
        sim, cell = self.build(eps_max=4.0, interfaces=(3.0,))
        self.assertEqual(sim.boundaries, list(CELL_BOUNDARIES))
        self.assertIs(sim.material_cell, cell)
        z = np.asarray(sim.mesh.GetLines("z"))
        for v in (cell.front, cell.back, 3.0, cell.z1, cell.z2, cell.z_source):
            self.assertLess(np.min(np.abs(z - v)), 1e-9, v)
        self.assertLessEqual(cell.z1, cell.front - cell.gap + 1e-9)
        self.assertGreaterEqual(cell.z2, cell.back + cell.gap - 1e-9)
        self.assertLess(cell.z_source, cell.z1)
        # source and probe planes stay clear of the PMLs
        clear = PML_CELLS + PML_MARGIN_CELLS
        self.assertEqual(int(np.argmin(np.abs(z - cell.z_source))), clear)
        self.assertEqual(len(z) - 1 - int(np.argmin(np.abs(z - cell.z2))), clear)
        dz = np.diff(z)
        self.assertTrue(np.all(dz > 0))
        self.assertLessEqual(max(np.max(dz[1:] / dz[:-1]), np.max(dz[:-1] / dz[1:])), GRADING + 1e-9)
        # inside the slab: lambda / 20 at f_max in eps_r 4
        inside = dz[(z[:-1] >= 0) & (z[1:] <= 10 + 1e-9)]
        self.assertLessEqual(inside.max(), C0 / 10e9 * 1e3 / 20 / 2 + 1e-9)
        x, y = np.asarray(sim.mesh.GetLines("x")), np.asarray(sim.mesh.GetLines("y"))
        self.assertEqual((x[0], x[-1], y[0], y[-1]), (-2.5, 2.5, -2.0, 2.0))

    def test_source_and_probes(self):
        sim, cell = self.build()
        exc = sim.csx.GetPropertiesByName(EXCITATION_NAME)
        self.assertEqual(len(exc), 1)
        self.assertEqual(list(exc[0].GetExcitation()), [0, 1, 0])
        for name in PROBE_NAMES:
            probes = sim.csx.GetPropertiesByName(name)
            self.assertEqual(len(probes), 1)
            self.assertEqual(probes[0].GetProbeType(), 0)   # voltage

    def test_reference_is_the_empty_cell_on_the_same_mesh(self):
        sim, cell = self.build(eps_max=4.0, transverse_cells=3)    # x lines +-0.83 and +-2.5
        sim.dielectric("slab", 4.0).AddBox(*cell.span(0.0, 10.0))
        sim.mesh.AddLine("x", [0.3])                     # a line the model adds after the cell
        ref = cell.reference()
        for axis in "xyz":
            np.testing.assert_array_equal(ref.mesh.GetLines(axis), sim.mesh.GetLines(axis))
        for name in PROBE_NAMES:                         # the probes stay where the sample run has them
            a, b = (s.csx.GetPropertiesByName(name)[0].GetPrimitive(0).GetStart() for s in (sim, ref))
            np.testing.assert_allclose(a, b)
            self.assertAlmostEqual(a[0], cell.probe_x)
            self.assertAlmostEqual(abs(cell.probe_x), 5.0 / 6)
        self.assertEqual(ref.boundaries, sim.boundaries)
        self.assertEqual(ref.excitation, sim.excitation)
        self.assertEqual((ref.end_criteria_db, ref.max_timesteps), (sim.end_criteria_db, sim.max_timesteps))
        self.assertEqual(ref.csx.GetPropertiesByName("slab"), [])
        self.assertEqual(len(ref.csx.GetPropertiesByName(PROBE_NAMES[1])), 1)

    def test_thin_sheet_sample(self):
        sim = Simulation(1e9, 10e9)
        cell = PlaneWaveCell(sim, 5.0, 5.0, 1.0, 1.0)
        self.assertLess(cell.z1, 1.0)
        self.assertGreater(cell.z2, 1.0)

    def test_rejects_bad_geometry(self):
        with self.assertRaises(ValueError):
            self.build(eps_max=0.5)
        with self.assertRaises(ValueError):
            PlaneWaveCell(Simulation(1e9, 10e9), 5.0, 5.0, 3.0, 1.0)
        with self.assertRaises(ValueError):
            PlaneWaveCell(Simulation(1e9, 10e9), 0.0, 5.0, 0.0, 1.0)

    def test_runner_refuses_a_model_without_a_cell(self):
        module = types.SimpleNamespace(build=lambda p: Simulation(1e9, 2e9))
        with self.assertRaises(ValueError):
            run_cell(module, {}, sim_path="unused")


class HigherModes(unittest.TestCase):
    def test_cut_off_frequencies(self):
        f_any, f_centred = higher_mode_frequencies(20.0, 10.0)       # mm: the larger side counts
        self.assertAlmostEqual(f_any, C0 / 0.04)                       # c / (2 max(a, b)), 7.49 GHz
        self.assertAlmostEqual(f_centred, C0 / 0.02)                   # c / max(a, b), 14.99 GHz
        self.assertEqual(higher_mode_frequencies(10.0, 20.0), (f_any, f_centred))

    def test_warnings_by_band(self):
        f_any, f_centred = 7.5e9, 15e9
        self.assertEqual(mode_warnings(5e9, f_any, f_centred), [])
        odd = mode_warnings(10e9, f_any, f_centred)
        self.assertEqual(len(odd), 1)
        self.assertIn("mirror-symmetric", odd[0])
        both = mode_warnings(20e9, f_any, f_centred)
        self.assertEqual(len(both), 1)
        self.assertIn("even for a sample centred", both[0])

    def test_cell_records_the_cut_offs_and_warns_for_a_large_cell(self):
        small = PlaneWaveCell(Simulation(1e9, 10e9), 5.0, 4.0, 0.0, 10.0)     # 30 GHz: no warning
        self.assertEqual(small.warnings, [])
        self.assertAlmostEqual(small.describe()["f_higher_mode"]["any"], C0 / 0.01)
        large = PlaneWaveCell(Simulation(1e9, 10e9), 20.0, 20.0, 0.0, 10.0)   # 7.5 / 15 GHz
        self.assertEqual(len(large.warnings), 1)
        self.assertEqual(large.describe()["warnings"], large.warnings)


class Runner(unittest.TestCase):
    """run_cell without openEMS: Simulation.run and the probe read-out are replaced."""

    def run_example(self, threads, own=(1e-12, 1e-12), ran=None, build_fn=None):
        """``own``: the (reference, sample) steps openEMS reports at setup; ``ran``: the steps the
        two real runs report (default: both the smaller own step)."""
        module = load_model(EXAMPLE)
        values = resolve_params(module.PARAMS, {})
        seen, builds = [], []
        build = build_fn or module.build
        ran = ran or (min(own),) * 2

        def counting_build(p):
            builds.append(1)
            return build(p)

        def fake_run(sim, sim_path, threads=0, **kw):
            sample = hasattr(sim, "material_cell")     # the reference cell carries no back-reference
            sim.sim_path = sim_path
            seen.append((threads, "setup" if kw.get("setup_only") else "run", "sample" if sample else "reference"))
            if kw.get("setup_only"):
                return {"timestep_s": own[1 if sample else 0]}
            write_probe(Path(sim_path) / PROBE_NAMES[0], ran[1 if sample else 0])
            return {"timestep_s": 0.0, "timesteps": 10, "solver_time_s": 0.0, "converged": True}

        ones = lambda path, f: (np.ones(len(f), complex), np.ones(len(f), complex))  # noqa: E731
        module = types.SimpleNamespace(build=counting_build, analytic_layers=module.analytic_layers)
        logged = []
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(Simulation, "run", fake_run), \
                mock.patch.object(material_cell, "_probe_voltages", ones), \
                mock.patch("fairbeam.cli._resolve_run_threads", return_value=3):
            out = run_cell(module, values, sim_path=str(Path(tmp) / "cell"), threads=threads, n_freq=11,
                           log=logged.append)
        return out, seen, builds, logged

    def test_auto_threads_resolve_once_from_the_built_cell(self):
        out, seen, builds, logged = self.run_example("auto")
        self.assertEqual(seen, [(3, "setup", "reference"), (3, "setup", "sample"),
                                (3, "run", "reference"), (3, "run", "sample")])
        self.assertEqual(len(builds), 1)               # the model is built once
        self.assertIn("fairbeam: threads 3 (auto)", logged)
        self.assertEqual(len(out["result"]["f"]), 11)

    def test_fixed_threads_pass_through(self):
        _, seen, builds, logged = self.run_example(2)
        self.assertEqual([s[0] for s in seen], [2, 2, 2, 2])
        self.assertEqual(len(builds), 1)
        self.assertFalse(any("threads" in line for line in logged))

    def test_both_runs_at_the_smaller_own_timestep(self):
        # a sample that needs a shorter step than vacuum (a Drude eps' < 1): the reference follows it
        out, *_ = self.run_example(2, own=(1.0e-12, 0.8e-12))
        stats = out["run_stats"]
        self.assertEqual(stats["timestep_own_s"], {"reference": 1.0e-12, "sample": 0.8e-12})
        self.assertEqual(stats["timestep_forced_s"], 0.8e-12)
        out, *_ = self.run_example(2, own=(1.0e-12, 1.3e-12))          # an ordinary dielectric
        self.assertEqual(out["run_stats"]["timestep_forced_s"], 1.0e-12)

    def test_unequal_steps_after_the_runs_are_refused(self):
        with self.assertRaises(RuntimeError):
            self.run_example(2, own=(1e-12, 1e-12), ran=(1e-12, 1.1e-12))
        with self.assertRaises(RuntimeError):                          # both off the forced step
            self.run_example(2, own=(1e-12, 1e-12), ran=(1.1e-12, 1.1e-12))

    def test_the_step_is_read_from_the_probe_not_the_log(self):
        """The fake runs log "0.00 s", as openEMS does after a run long enough to print progress."""
        out, *_ = self.run_example(2, own=(1.0e-12, 0.8e-12))
        for label in ("reference", "sample"):
            self.assertAlmostEqual(out["run_stats"][label]["timestep_s"] / 0.8e-12, 1.0, places=9)
            self.assertIn(PROBE_NAMES[0], out["run_stats"][label]["timestep_source"])

    def test_unresolved_dispersive_poles_are_refused_before_running(self):
        from fairbeam.dispersion import Dispersion, Lorentz

        def build(p):   # a Lorentz pole goes to openEMS as given: tau 0.1 ps is far below the step
            sim = Simulation(1e9, 10e9)
            cell = PlaneWaveCell(sim, 5.0, 5.0, 0.0, 10.0, eps_max=5.0)
            sim.dispersive("slab", Dispersion(3.0, (Lorentz(2e9, 4e9, 1e-13),))).AddBox(*cell.span(0.0, 10.0))
            return sim

        with self.assertRaises(ValueError) as ctx:
            self.run_example(2, own=(1e-12, 1e-12), build_fn=build)
        self.assertIn("does not resolve", str(ctx.exception))


class ProbeTimestep(unittest.TestCase):
    def test_divides_out_the_sampling_stride(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "probe"
            write_probe(path, 2.5e-12, stride=3)
            self.assertAlmostEqual(probe_timestep(path, 2.5e-12) / 2.5e-12, 1.0, places=9)
            self.assertAlmostEqual(probe_timestep(path, 2.6e-12) / 2.5e-12, 1.0, places=9)
            write_probe(path, 2.5e-12, stride=1)
            self.assertAlmostEqual(probe_timestep(path, 2.5e-12) / 2.5e-12, 1.0, places=9)
            path.write_text("% time value\n0 0\n")
            with self.assertRaises(RuntimeError):
                probe_timestep(path, 2.5e-12)


class ExampleModel(unittest.TestCase):
    def test_slab_cell_example_builds(self):
        module = load_model(EXAMPLE)
        values = resolve_params(module.PARAMS, {})
        sim = module.build(values)
        self.assertIsInstance(sim.material_cell, PlaneWaveCell)
        layers = module.analytic_layers(values)
        self.assertEqual(layers[0]["thickness"], sim.material_cell.back - sim.material_cell.front)
        self.assertIn("slab", sim.materials)


if __name__ == "__main__":
    unittest.main()
