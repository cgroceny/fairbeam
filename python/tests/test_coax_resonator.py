r"""Unloaded coaxial resonator checks; native runs are explicitly opt-in.

From python/ with the openEMS environment:
python -m unittest tests.test_coax_resonator -q
python -m tests.test_coax_resonator --preflight --out C:\Temp\coax-preflight
python -m tests.test_coax_resonator --fdtd --case air_copper --cap-ns 300 --out C:\Temp\coax-pilot
python -m tests.test_coax_resonator --fdtd --rate-mcps 100 --out C:\Temp\coax-study
python -m tests.test_coax_resonator --analyse --out C:\Temp\coax-study
python -m tests.test_coax_resonator --fdtd --cases ptfe_dielectric --rate-mcps 70 --out C:\Temp\coax-dielectric

The rate is a conservative measured throughput, not a permission override.
Every owned native worker has a 30-minute, suspend-inclusive deadline. No
ordinary unittest starts FDTD. Results and raw geometry stay outside Git.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import numpy as np

from fairbeam.procutil import popen_group, release_group, terminate_group
from tests import coax_resonator_fixture as fixture


def configurations():
    return [(f"n{n}", n, 4, 2) for n in (8, 12, 16)] + [
        ("n12_angular", 12, 8, 2), ("n12_enclosure", 12, 4, 3)]


def forecast(meta, rate_mcps):
    if not np.isfinite(rate_mcps) or rate_mcps <= 0:
        raise ValueError("positive conservative measured throughput required")
    return 1.15 * meta["native_cells"] * meta["max_timesteps"] / (rate_mcps * 1e6) + 20


def cap_seconds(cap_ns):
    # Division preserves the default CAP_S exactly through the CLI round trip;
    # multiplication by the rounded binary literal 1e-9 overshoots the bound.
    return cap_ns / 1e9


def preflight(out, rate_mcps, kinds=fixture.KINDS):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    rows = []
    for name, n, angular, margin in configurations():
        for kind in kinds:
            sim, meta = fixture.build(n, kind, angular, margin)
            path = out / f"{name}_{kind}.xml"
            sim.fdtd.Write2XML(str(path))
            rows.append(dict(config=name, **meta, xml_sha256=fixture.sha(path),
                             estimated_seconds=forecast(meta, rate_mcps)))
    record = dict(source_sha256=fixture.identity(), gates=fixture.GATES,
                  rate_mcps=rate_mcps, rows=rows, qualified=False)
    fixture.save(out / "preflight.json", record)
    return record


def wait_owned(proc, seconds=1800):
    """The wall clock includes laptop suspend; never terminate unrelated PIDs."""
    start, wall = time.monotonic(), time.time()
    while True:
        remaining = seconds - max(time.monotonic() - start, time.time() - wall)
        if remaining <= 0:
            if proc.poll() is None:
                terminate_group(proc.pid, grace=0, job=proc.win_job)
            proc.wait(timeout=15)
            raise TimeoutError("owned FDTD worker exceeded its 30-minute deadline")
        try:
            code = proc.wait(timeout=min(1., remaining))
            if max(time.monotonic() - start, time.time() - wall) > seconds:
                raise TimeoutError("owned FDTD worker returned after its 30-minute deadline")
            return code
        except subprocess.TimeoutExpired:
            pass


def audit_header(text, meta):
    version = re.search(r"openEMS 64bit -- version (\S+)", text)
    grid = re.search(r"FDTD simulation size: (\d+)x(\d+)x(\d+) --> (\d+) FDTD cells", text)
    interval = re.search(r"Exact-endcriteria: evaluating the end criteria every (\d+) timestep", text)
    if not version or not grid or not interval:
        raise ValueError("native version/grid/end-criterion header missing")
    if version[1] != "v0.37.0-rc3" or "fixed number of threads: 1" not in text:
        raise ValueError("bundled rc3 engine and one native thread required")
    if list(map(int, grid.groups()[:3])) != meta["reported_grid_lines"] or int(grid[4]) != meta["native_cells"]:
        raise ValueError("native grid does not match the declared cylindrical allocation")
    if int(interval[1]) != int(1 / (2 * 5.5e9 * meta["native"]["dt_s"])):
        raise ValueError("native energy schedule does not match its recorded clock")
    return dict(version=version[1], nyquist_interval=int(interval[1]), threads=1)


def acquire_serial(out, n, kind, angular, margin, cap_s, rate_mcps):
    out = Path(out).resolve()
    if out.exists():
        raise ValueError(f"acquisition already exists: {out}")
    _, meta = fixture.build(n, kind, angular, margin, cap_s)
    estimate = forecast(meta, rate_mcps)
    if estimate > 1800:
        raise ValueError(f"forecast {estimate / 60:.1f} minutes exceeds 30; defer this case")
    out.parent.mkdir(parents=True, exist_ok=True)
    log_path = out.with_name(out.name + ".log")
    command = [sys.executable, "-m", "tests.test_coax_resonator", "--fdtd", "--worker-case",
               "--case", kind, "--mesh", str(n), "--angular", str(angular), "--margin", str(margin),
               "--cap-ns", str(cap_s * 1e9), "--out", str(out)]
    with log_path.open("w", encoding="utf-8") as log:
        proc = popen_group(command, cwd=Path(__file__).resolve().parents[1],
                           stdout=log, stderr=subprocess.STDOUT,
                           env={**os.environ, "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1"})
        started, wall = time.monotonic(), time.time()
        code = None
        try:
            code = wait_owned(proc)
        finally:
            if proc.poll() is None:
                terminate_group(proc.pid, grace=0, job=proc.win_job)
                proc.wait(timeout=15)
            release_group(proc)
            fixture.save(out.with_name(out.name + ".worker.json"),
                         dict(command=command, pid=proc.pid, exit_code=code,
                              estimated_seconds=estimate, rate_mcps=rate_mcps,
                              monotonic_seconds=time.monotonic() - started,
                              wall_seconds=time.time() - wall))
    if code:
        raise RuntimeError(f"FDTD worker exit {code}; retained {log_path}")
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    report["native_header"] = audit_header(log_path.read_text(encoding="utf-8"), report)
    fixture.save(out / "report.json", report)
    return fixture.read(out)


class CoaxResonatorTests(unittest.TestCase):
    def test_distributed_loss_dimensions(self):
        ref = fixture.reference("air_copper")
        self.assertAlmostEqual(ref["length_m"] * 1e3, 29.9792458, places=7)
        self.assertAlmostEqual(ref["q_unloaded"], 2373.309112, places=5)
        self.assertAlmostEqual(ref["zc_ohm"], 83.1201188, places=6)
        self.assertAlmostEqual(ref["skin_depth_m"] * 1e6, .934590006, places=7)
        # Integrate an independent radial TEM field-energy / wall-loss model.
        r = np.geomspace(fixture.A, fixture.B, 20001)
        radial = np.trapezoid(1 / r, r)
        q = (2 * np.pi * fixture.F0 * fixture.MUE0 * radial /
             (ref["rs_ohm"] * (1 / fixture.A + 1 / fixture.B)))
        self.assertLess(abs(q / ref["q_unloaded"] - 1), 1e-8)

    def test_reciprocal_q_and_constant_dielectric_conductivity(self):
        air = fixture.reference("air_copper")
        copper = fixture.reference("ptfe_copper")
        dielectric = fixture.reference("ptfe_dielectric")
        both = fixture.reference("ptfe_both")
        self.assertEqual(air["qc"], copper["qc"])
        self.assertEqual(dielectric["q_unloaded"], 2500.)
        self.assertAlmostEqual(1 / both["q_unloaded"], 1 / copper["q_unloaded"] + 1 / dielectric["q_unloaded"])
        self.assertAlmostEqual(both["sigma_dielectric"], .000231431211659, places=14)
        self.assertFalse(both["end_cap_loss_included"])

    def test_sheet_surrogate_is_explicit_and_not_fitted(self):
        surrogate = fixture.reference("air_copper")
        native = fixture.reference("air_native_sheet")
        self.assertEqual(surrogate["sheet_sigma"], fixture.SIGMA / 4)
        self.assertEqual(native["sheet_sigma"], fixture.SIGMA)
        self.assertEqual(surrogate["q_unloaded"], native["q_unloaded"])

    def test_free_pole_against_known_damped_oscillator(self):
        t = np.arange(0, 200e-9, 2e-12)
        for q in (1200., 2400.):
            alpha, omega = np.pi * 5e9 / q, 2 * np.pi * 5e9
            y = np.exp(-alpha * t) * np.cos(omega * t + .23) + .013
            result = fixture.field_pole(t, y)
            self.assertLess(abs(result["f_hz"] / 5e9 - 1), 1e-9)
            self.assertLess(abs(result["q"] / q - 1), 1e-7)
            self.assertLess(result["relative_residual"], 1e-12)

    def test_pole_rejects_growth_dc_and_bad_clock(self):
        t = np.arange(2000) * 2e-12
        for y in (np.zeros(len(t)), np.exp(1e7 * t) * np.cos(2 * np.pi * 5e9 * t)):
            with self.assertRaises(ValueError):
                fixture.field_pole(t, y)
        bad = t.copy()
        bad[100] += .8e-12
        with self.assertRaisesRegex(ValueError, "clock"):
            fixture.field_pole(bad, np.cos(2 * np.pi * 5e9 * t))

    def test_mixed_modes_expose_fit_residual(self):
        t = np.arange(6000) * 5e-12
        y = np.exp(-1e7 * t) * (np.cos(2 * np.pi * 5e9 * t) + .5 * np.cos(2 * np.pi * 8e9 * t))
        result = fixture.field_pole(t, y)
        self.assertGreater(result["relative_residual"], fixture.GATES["ar_residual"])

    def test_independent_energy_slope_and_growth_rejection(self):
        t = np.linspace(10e-9, 1e-6, 100)
        f, q = 5e9, 2400.
        result = fixture.energy_decay(t, 3 * np.exp(-2 * np.pi * f * t / q), f)
        self.assertLess(abs(result["q"] / q - 1), 1e-12)
        self.assertGreater(result["fitted_span_db"], 30)
        self.assertLess(result["log_rms"], 1e-12)
        for energy in (np.ones(100), np.exp(t * 1e7), np.zeros(100)):
            with self.assertRaises(ValueError):
                fixture.energy_decay(t, energy, f)
        with self.assertRaisesRegex(ValueError, "20"):
            fixture.energy_decay(t[:19], np.exp(-t[:19] * 1e7), f)

    def test_sparse_noisy_energy_is_not_silently_qualified(self):
        t = np.linspace(10e-9, 1e-6, 40)
        energy = np.exp(-2 * np.pi * 5e9 * t / 2400) * np.exp(np.sin(np.arange(40)) * 2)
        result = fixture.energy_decay(t, energy, 5e9)
        self.assertGreater(result["log_rms"], fixture.GATES["energy_log_rms"])

    def test_phase_corrected_energy_envelope_without_target_q(self):
        rng = np.random.default_rng(31)
        t = np.sort(rng.uniform(20e-9, 1.4e-6, 101))
        f, q = 4.993e9, 1903.
        energy = np.exp(-2 * np.pi * f * t / q) * (1 + .73 * np.cos(4 * np.pi * f * t + .31))
        result = fixture.energy_decay(t, energy, f, phase_corrected=True)
        self.assertLess(abs(result["q"] / q - 1), 1e-7)
        self.assertLess(result["log_rms"], 1e-7)
        self.assertGreater(result["plain_log_fit"]["log_rms"], .4)

    def test_geometry_and_exact_anchors(self):
        sim, meta = fixture.build(12, "ptfe_both")
        radius, angle, z = [np.asarray(sim.mesh.GetLines(axis)) for axis in "xyz"]
        self.assertIn(1., radius)
        self.assertIn(4., radius)
        self.assertGreater(radius[0], 0)
        self.assertEqual(angle[-1], 2 * np.pi)
        self.assertAlmostEqual((z[0] + z[1]) / 2, 0.)
        self.assertAlmostEqual((z[-2] + z[-1]) / 2, meta["reference"]["length_m"] / sim.unit)
        self.assertEqual(sim.boundaries, ["PEC"] * 4 + ["PMC"] * 2)
        self.assertEqual(meta["native_lines"], [17, 6, 122])
        self.assertEqual(meta["reported_grid_lines"], [17, 4, 122])
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "input.xml"
            sim.fdtd.Write2XML(str(path))
            xml = ET.parse(path).getroot()
            self.assertEqual(xml.find("FDTD").get("CylinderCoords"), "1")
            properties = xml.find("ContinuousStructure/Properties")
            sheets = properties.findall("ConductingSheet")
            self.assertEqual(len(sheets), 2)
            self.assertTrue(all(float(s.get("Conductivity")) == fixture.SIGMA / 4 for s in sheets))
            metals = properties.findall("Metal")
            self.assertEqual(len(metals), 2)
            self.assertTrue(all(len(m.find("Primitives").findall("Box")) == 1 for m in metals))
        with self.assertRaisesRegex(ValueError, "Cartesian"):
            sim.to_bundle()

    def test_independent_angular_and_enclosure_controls(self):
        sims = [fixture.build(12, "air_copper", angular, margin) for angular, margin in ((4, 2), (8, 2), (4, 3))]
        for _, meta in sims:
            self.assertEqual(meta["reference"], sims[0][1]["reference"])
        self.assertEqual(sims[1][1]["native_lines"][1], 10)
        self.assertEqual(sims[2][1]["native_lines"][0], 19)
        self.assertEqual(sims[0][1]["native_lines"][2], sims[2][1]["native_lines"][2])
        clock = fixture.build(12, "air_copper", angular=16)[1]["declared_dt_s"]
        self.assertEqual(clock, sims[0][1]["declared_dt_s"])
        self.assertEqual(clock, sims[1][1]["declared_dt_s"])

    def test_invalid_mesh_and_budget_rejected_before_run(self):
        for n in (True, 0, 8., 10, 20):
            with self.assertRaises(ValueError):
                fixture.build(n, "air_copper")
        with self.assertRaises(ValueError):
            fixture.build(8, "air_copper", margin=3)
        _, meta = fixture.build(16, "air_copper")
        self.assertGreater(forecast(meta, 1), 1800)
        with tempfile.TemporaryDirectory() as temp:
            with patch(__name__ + ".popen_group") as spawn:
                with self.assertRaisesRegex(ValueError, "defer"):
                    acquire_serial(Path(temp) / "unstarted", 16, "air_copper", 4, 2, fixture.CAP_S, 1)
                spawn.assert_not_called()

    def test_suspend_inclusive_owned_worker_deadline(self):
        class Process:
            pid, win_job = 12345, object()
            def poll(self):
                return None
            def wait(self, timeout):
                return 1
        proc = Process()
        with patch(__name__ + ".time.monotonic", side_effect=[10., 10.1]), \
             patch(__name__ + ".time.time", side_effect=[100., 2000.]), \
             patch(__name__ + ".terminate_group") as stop:
            with self.assertRaises(TimeoutError):
                wait_owned(proc)
            stop.assert_called_once_with(proc.pid, grace=0, job=proc.win_job)

    def test_finished_worker_cannot_hide_suspend_elapsed_time(self):
        class Process:
            def wait(self, timeout):
                return 0
        with patch(__name__ + ".time.monotonic", side_effect=[10., 10.1, 10.2]), \
             patch(__name__ + ".time.time", side_effect=[100., 100.1, 2000.]):
            with self.assertRaisesRegex(TimeoutError, "returned after"):
                wait_owned(Process())

    def test_native_header_audit_rejects_different_engine_grid_and_clock(self):
        meta = dict(reported_grid_lines=[13, 4, 82], native_cells=6396,
                    native=dict(dt_s=6.595721063542681e-13))
        text = ("openEMS 64bit -- version v0.37.0-rc3\nfixed number of threads: 1\n"
                "FDTD simulation size: 13x4x82 --> 6396 FDTD cells\n"
                "Exact-endcriteria: evaluating the end criteria every 137 timestep(s)")
        self.assertEqual(audit_header(text, meta)["nyquist_interval"], 137)
        for old, new in (("0.37.0-rc3", "0.38"), ("13x4", "13x6"), ("every 137", "every 138"),
                         ("threads: 1", "threads: 4")):
            with self.assertRaises(ValueError):
                audit_header(text.replace(old, new), meta)

    def test_study_rejects_duplicate_or_diagnostic_loss_cohorts(self):
        for kinds in ((), ("air_copper", "air_copper"), ("air_native_sheet",)):
            with self.assertRaises(ValueError):
                fixture.study("unused", kinds=kinds)

    def test_default_cap_round_trips_through_worker_nanoseconds(self):
        cap = cap_seconds(float(str(fixture.CAP_S * 1e9)))
        self.assertEqual(cap, fixture.CAP_S)
        _, original = fixture.build(8, "ptfe_dielectric")
        _, worker = fixture.build(8, "ptfe_dielectric", cap_s=cap)
        self.assertEqual(original, worker)
        with self.assertRaises(ValueError):
            fixture.build(8, "ptfe_dielectric", cap_s=cap_seconds(1600.001))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--preflight", action="store_true")
    actions.add_argument("--fdtd", action="store_true")
    actions.add_argument("--analyse", action="store_true")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--case", choices=fixture.KINDS + ("air_native_sheet",))
    parser.add_argument("--cases", nargs="+", choices=fixture.KINDS, default=list(fixture.KINDS),
                        help="loss families for the complete mesh/angular/enclosure study")
    parser.add_argument("--mesh", type=int, default=8)
    parser.add_argument("--angular", type=int, default=4)
    parser.add_argument("--margin", type=int, default=2)
    parser.add_argument("--cap-ns", type=float, default=fixture.CAP_S * 1e9)
    parser.add_argument("--rate-mcps", type=float, default=20.)
    parser.add_argument("--worker-case", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.preflight:
        record = preflight(args.out, args.rate_mcps, args.cases)
        print(json.dumps(dict(cases=len(record["rows"]),
                              max_forecast_seconds=max(r["estimated_seconds"] for r in record["rows"]))))
    elif args.analyse:
        print(json.dumps(fixture.read(args.out) if args.case else fixture.study(args.out, kinds=args.cases), indent=2))
    elif args.worker_case:
        if not args.case:
            parser.error("worker requires a case")
        print(json.dumps(fixture.acquire(args.out, args.mesh, args.case, args.angular, args.margin,
                                         cap_seconds(args.cap_ns)), indent=2))
    elif args.case:
        print(json.dumps(acquire_serial(args.out, args.mesh, args.case, args.angular, args.margin,
                                        cap_seconds(args.cap_ns), args.rate_mcps), indent=2))
    else:
        preflight(args.out / "preflight", args.rate_mcps, args.cases)
        for name, n, angular, margin in configurations():
            for kind in args.cases:
                print(json.dumps(acquire_serial(args.out / name / kind, n, kind, angular, margin,
                                                fixture.CAP_S, args.rate_mcps)), flush=True)
        print(json.dumps(fixture.study(args.out, kinds=args.cases), indent=2))


if __name__ == "__main__":
    if len(sys.argv) == 1:
        unittest.main()
    else:
        main()
