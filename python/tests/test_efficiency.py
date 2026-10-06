"""Efficiency over the band (bundle results.efficiency): the post-processing NF2FF call in
Simulation.evaluate (stubbed, no FDTD run), the per-port entries of multi-port runs, the design
format's monitors.efficiency (build, Python export, checks) and `fairbeam run --efficiency`."""

import contextlib
import io
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam import cli  # noqa: E402
from fairbeam.design import DesignError, blank_design, check_design, efficiency_points, module_for, to_python  # noqa: E402
from fairbeam.design_checks import lint  # noqa: E402
from fairbeam.model import resolve_params  # noqa: E402
from fairbeam.multiport import run_model  # noqa: E402
from fairbeam.simulation import (EFFICIENCY_OUTFILE, EFFICIENCY_PHI_STEP, EFFICIENCY_THETA_STEP,  # noqa: E402
                                 Simulation)

Z0 = 50.0
GAMMA = 0.1


class StubPort:
    Z_ref = Z0

    def CalcPort(self, sim_path, f):
        n = len(f)
        self.uf_inc = np.ones(n, dtype=complex)
        self.uf_ref = np.full(n, GAMMA, dtype=complex)
        self.uf_tot = self.uf_inc + self.uf_ref
        self.if_tot = (self.uf_inc - self.uf_ref) / Z0
        t = np.linspace(0, 5e-9, 300)
        self.u_time, self.ut_inc = t, np.sin(t * 1e9)
        self.ut_ref = GAMMA * self.ut_inc
        self.ut_tot, self.it_tot = self.ut_inc + self.ut_ref, (self.ut_inc - self.ut_ref) / Z0


P_ACC = (1 - GAMMA ** 2) / (2 * Z0)


class StubNF2FF:
    """Radiation efficiency eta(f) (image space: Prad 2^m too large, as openEMS reports it)."""

    def __init__(self, mirrors, eta=lambda f: 0.5 + 0.2 * f / 3e9):
        self.mirrors, self.eta = mirrors, eta
        self.calls = []

    def CalcNF2FF(self, sim_path, freqs, theta, phi, center, **kw):
        self.calls.append({"freqs": list(freqs), "theta": np.asarray(theta), "phi": np.asarray(phi), **kw})
        th, _ph = np.meshgrid(np.deg2rad(theta), np.deg2rad(phi), indexing="ij")
        e = np.abs(np.sin(th)) + 1e-6
        k = 2.0 ** self.mirrors
        return types.SimpleNamespace(E_norm=[e for _ in freqs], Dmax=[1.5 / k for _ in freqs],
                                     Prad=[self.eta(f) * P_ACC * k for f in freqs])


def make_sim(boundaries=("MUR",) * 6, **kw):
    sim = Simulation(1e9, 3e9, boundaries=list(boundaries))
    sim.ports = [{"number": 1, "type": "lumped", "R": Z0, "direction": "z", "start": [0, 0, 0],
                  "stop": [0, 0, 1], "excite": True}]
    sim._port_objs = [StubPort()]
    sim.nf2ff = StubNF2FF(sum(b in ("PEC", "PMC") for b in boundaries), **kw)
    sim.nf2ff_center = [0.0, 0.0, 5.0]
    sim.sim_path = "/nonexistent"
    return sim


def quiet(fn, *a, **kw):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
        return fn(*a, **kw), err.getvalue()


class Evaluate(unittest.TestCase):
    def test_off_by_default(self):
        sim = make_sim()
        res = sim.evaluate(n_freq=11, pattern_freqs=[2e9])
        self.assertNotIn("efficiency", res)
        self.assertEqual(len(sim.nf2ff.calls), 1)   # the pattern only

    def test_frequency_grid_and_separate_file(self):
        sim = make_sim()
        res, _ = quiet(sim.evaluate, n_freq=11, pattern_freqs=[2e9], efficiency_points=21)
        pattern, band = sim.nf2ff.calls
        self.assertNotIn("outfile", pattern)                 # the pattern keeps nf2ff.h5
        self.assertEqual(band["outfile"], EFFICIENCY_OUTFILE)
        np.testing.assert_allclose(band["freqs"], np.linspace(1e9, 3e9, 21))
        np.testing.assert_allclose(band["theta"], np.arange(0, 180 + 1e-9, EFFICIENCY_THETA_STEP))
        np.testing.assert_allclose(band["phi"], np.arange(0, 360, EFFICIENCY_PHI_STEP))
        (entry,) = res["efficiency"]
        self.assertEqual(entry["f"], band["freqs"])
        self.assertEqual((entry["theta_step"], entry["phi_step"]), (EFFICIENCY_THETA_STEP, EFFICIENCY_PHI_STEP))
        self.assertEqual(len(entry["prad_w"]), 21)
        np.testing.assert_allclose(entry["pacc_w"], P_ACC)
        for f, eta in zip(entry["f"], entry["rad_efficiency"]):
            self.assertEqual(eta, round(0.5 + 0.2 * f / 3e9, 4))
        self.assertNotIn("qa_warnings", entry)
        self.assertEqual(len(res["farfield"]), 1)          # the pattern result is unchanged
        self.assertIn("directivity_dbi", res["farfield"][0])
        self.assertNotIn("directivity_dbi", entry)         # only powers are stored

    def test_attribute_default_and_override(self):
        sim = make_sim()
        sim.efficiency_points = 5
        res, _ = quiet(sim.evaluate, n_freq=11, pattern_freqs=[2e9])
        self.assertEqual(len(res["efficiency"][0]["f"]), 5)
        res, _ = quiet(sim.evaluate, n_freq=11, pattern_freqs=[2e9], efficiency_points=7)
        self.assertEqual(len(res["efficiency"][0]["f"]), 7)

    def test_mirror_correction(self):
        cases = {0: ["MUR"] * 6, 1: ["MUR"] * 4 + ["PEC", "MUR"], 2: ["PMC", "MUR", "MUR", "MUR", "PEC", "MUR"]}
        for m, bnd in cases.items():
            with self.subTest(mirrors=m):
                sim = make_sim(bnd, eta=lambda f: 0.8)
                res, _ = quiet(sim.evaluate, n_freq=11, pattern_freqs=[2e9], efficiency_points=3)
                entry = res["efficiency"][0]
                self.assertEqual(entry["mirror_planes"], m)
                np.testing.assert_allclose(entry["prad_w"], 0.8 * P_ACC)
                self.assertEqual(entry["rad_efficiency"], [0.8] * 3)
                # the same Prad and efficiency as the pattern at the same frequency
                self.assertAlmostEqual(entry["prad_w"][1], res["farfield"][0]["prad_w"])
                self.assertEqual(entry["rad_efficiency"][1], res["farfield"][0]["rad_efficiency"])

    def test_above_one_is_kept_with_one_summary_note(self):
        sim = make_sim(eta=lambda f: 1.1 if f > 2e9 else 0.9)
        res, err = quiet(sim.evaluate, n_freq=11, pattern_freqs=[1.5e9], efficiency_points=11)
        entry = res["efficiency"][0]
        self.assertEqual(entry["rad_efficiency"][-1], 1.1)            # kept, not clipped
        self.assertEqual(len(entry["qa_warnings"]), 1)
        self.assertIn("5 of 11 frequencies", entry["qa_warnings"][0])
        self.assertEqual(err.count("warning"), 1)                     # one line, not five

    def test_no_accepted_power(self):
        sim = make_sim()
        sim._port_objs[0].CalcPort = lambda path, f, p=sim._port_objs[0]: (
            StubPort.CalcPort(p, path, f), setattr(p, "if_tot", np.zeros(len(f), complex)))
        res, _ = quiet(sim.evaluate, n_freq=11, pattern_freqs=[2e9], efficiency_points=3)
        self.assertEqual(res["efficiency"][0]["rad_efficiency"], [None] * 3)

    def test_needs_the_far_field(self):
        sim = make_sim()
        sim.nf2ff = None
        res = sim.evaluate(n_freq=11, efficiency_points=21)
        self.assertNotIn("efficiency", res)


class FakeModelSim:
    """What run_model and merge need of a Simulation, for a 2-port model."""

    def __init__(self, far_field=True, run=0):
        self.run_index = run   # the port this build excites (0-based); the probe's value is never used
        self.ports = [{"number": 1, "excite": True}, {"number": 2, "excite": True}]
        self.nf2ff = object() if far_field else None
        self.efficiency_points = None
        self.end_criteria_db = -40
        self.added_box = False

    def add_nf2ff_box(self):
        self.added_box = True
        self.nf2ff = object()

    def run(self, path, **kw):
        self.run_stats = {"timesteps": 10, "solver_time_s": 1.0, "wall_time_s": 1.0, "final_energy_db": -40,
                          "converged": True, "engine": "cpu"}

    def evaluate(self, n_freq, pattern_freqs):
        f = np.linspace(1e9, 3e9, n_freq)
        # the driven port sees the full incident wave, the other one a fraction: the incident-wave matrix of
        # the runs must be invertible (identical waves made it exactly singular, and LAPACK builds differ
        # in whether solve() reports that)
        self._port_objs = [types.SimpleNamespace(Z_ref=50.0, uf_inc=np.full(n_freq, 1.0 if i == self.run_index else 0.2),
                                                 uf_ref=np.full(n_freq, 0.1))
                           for i in range(len(self.ports))]
        self.results = {"frequency": f.tolist(), "ports": {"1": {}, "2": {}}, "bands": [], "signals": {},
                        "farfield": [{"f": 2e9}]}
        if self.efficiency_points and self.nf2ff is not None:
            self.results["efficiency"] = [{"f": [1e9, 3e9], "rad_efficiency": [0.5, 0.6], "points": self.efficiency_points}]


class MultiPort(unittest.TestCase):
    def run_fake(self, far_field=True, **kw):
        built = []

        def build(values):
            built.append(FakeModelSim(far_field, run=len(built) - 1))
            return built[-1]

        module = types.SimpleNamespace(build=build)
        with tempfile.TemporaryDirectory() as tmp:
            primary = run_model(module, {}, excite="all", sim_path=str(Path(tmp) / "run"), n_freq=5,
                                log=lambda *a: None, **kw)
        return primary, built[1:]   # built[0] is run_model's probe

    def test_one_entry_per_driven_port(self):
        primary, sims = self.run_fake(efficiency_points=9)
        self.assertEqual([s.efficiency_points for s in sims], [9, 9])
        eff = primary.results["efficiency"]
        self.assertEqual([e["port"] for e in eff], [1, 2])
        self.assertEqual([e["points"] for e in eff], [9, 9])
        self.assertEqual([ff["port"] for ff in primary.results["farfield"]], [1, 2])   # the same convention

    def test_off_without_request(self):
        primary, sims = self.run_fake()
        self.assertNotIn("efficiency", primary.results)
        self.assertEqual([s.efficiency_points for s in sims], [None, None])

    def test_request_adds_the_far_field_box(self):
        primary, sims = self.run_fake(far_field=False, efficiency_points=21)
        self.assertTrue(all(s.added_box for s in sims))
        self.assertEqual(len(primary.results["efficiency"]), 2)
        primary, sims = self.run_fake(far_field=False)
        self.assertFalse(any(s.added_box for s in sims))


def build(d):
    m = module_for(d)
    return m.build(resolve_params(m.PARAMS, {}))


def codes(d):
    return [(c["severity"], c["code"], c["path"]) for c in lint(d) if c["code"] == "monitor-efficiency"]


class DesignMonitor(unittest.TestCase):
    def test_build(self):
        d = blank_design("t", "T")
        self.assertIsNone(build(d).efficiency_points)
        d["monitors"] = {"efficiency": {"points": 31}}
        self.assertEqual(build(d).efficiency_points, 31)
        d["monitors"] = {"efficiency": {}}
        self.assertEqual(build(d).efficiency_points, 21)
        d["monitors"] = {"currents": ["f0"], "efficiency": {"points": 5}}
        sim = build(d)
        self.assertEqual((sim.efficiency_points, sim.current_freqs), (5, [2.45e9]))

    def test_build_skips_what_the_checks_refuse(self):
        d = blank_design("t", "T")
        d["monitors"] = {"efficiency": {"points": 500}}
        sim, err = quiet(build, d)
        self.assertIsNone(sim.efficiency_points)
        self.assertIn("monitors.efficiency ignored", err)
        d["monitors"] = {"efficiency": {"points": 21}}
        d["far_field"]["enabled"] = False
        self.assertIsNone(build(d).efficiency_points)

    def test_points_value(self):
        d = blank_design("t", "T")
        self.assertIsNone(efficiency_points(d))
        for ok, n in [(3, 3), (201, 201), (21.0, 21)]:
            d["monitors"] = {"efficiency": {"points": ok}}
            self.assertEqual(efficiency_points(d), n)
        for bad in [2, 202, 20.5, "21", True, None]:
            d["monitors"] = {"efficiency": {"points": bad}}
            with self.subTest(points=bad), self.assertRaises(DesignError) as e:
                efficiency_points(d)
            self.assertEqual(e.exception.where, "monitors.efficiency.points")

    def test_python_export(self):
        d = blank_design("t", "T")
        d["monitors"] = {"efficiency": {"points": 41}}
        src = to_python(d)
        self.assertIn("sim.efficiency_points = 41", src)
        ns: dict = {}
        exec(compile(src, "export.py", "exec"), ns)  # noqa: S102 - our own generated source
        self.assertEqual(ns["build"](resolve_params(ns["PARAMS"], {})).efficiency_points, 41)
        self.assertNotIn("efficiency_points", to_python(blank_design("t", "T")))

    def test_structure(self):
        d = blank_design("t", "T")
        d["monitors"] = {"efficiency": 21}
        with self.assertRaises(DesignError) as e:
            check_design(d)
        self.assertEqual(e.exception.where, "monitors.efficiency")

    def test_checks(self):
        d = blank_design("t", "T")
        d["monitors"] = {"efficiency": {"points": 21}}
        self.assertEqual(codes(d), [])
        d["monitors"] = {"efficiency": {"points": 1}}
        self.assertEqual(codes(d), [("error", "monitor-efficiency", "monitors.efficiency.points")])
        d["monitors"] = {"efficiency": {"points": 21}}
        d["far_field"]["enabled"] = False
        self.assertEqual(codes(d), [("error", "monitor-efficiency", "monitors.efficiency")])
        self.assertTrue(all(c.get("explain") for c in lint(d) if c["code"] == "monitor-efficiency"))


class Cli(unittest.TestCase):
    def parse(self, *argv):
        with mock.patch.object(cli, "cmd_run") as run:
            cli.main(["run", "model.py", *argv])
        return run.call_args.args[0]

    def test_flag(self):
        self.assertIsNone(self.parse().efficiency)
        self.assertEqual(self.parse("--efficiency").efficiency, 21)
        self.assertEqual(self.parse("--efficiency", "51").efficiency, 51)
        self.assertEqual(self.parse("--efficiency", "3").efficiency, 3)
        for bad in ["2", "202", "ten", "20.5"]:
            with self.subTest(n=bad), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.parse("--efficiency", bad)

    def test_passed_to_run_model(self):
        args = self.parse("--efficiency", "11", "--quiet", "--threads", "4")
        seen = {}

        def fake_run_model(module, values, **kw):
            seen.update(kw)
            raise RuntimeError("stop here")

        module = types.SimpleNamespace(PARAMS=[], MODEL={"id": "m", "name": "M"})
        sim = types.SimpleNamespace(end_criteria_db=-40, max_timesteps=100, current_freqs=None)
        with mock.patch("fairbeam.multiport.run_model", fake_run_model), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError):
            cli._run(args, module, sim, [], "m", "M", "/nonexistent")
        self.assertEqual(seen["efficiency_points"], 11)


if __name__ == "__main__":
    unittest.main()
