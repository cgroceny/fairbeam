"""Pure controls and explicit serial FDTD; discovery never starts a simulation.

From python/ with the bundled runtime, using fresh output outside the repository:
python -m tests.test_wilkinson_fixture --preflight --out C:\\Temp\\wilkinson-plan
python -m tests.test_wilkinson_fixture --fdtd --mesh 4 --rate-mcps 10 --out C:\\Temp\\wilkinson-n4
python -m tests.test_wilkinson_fixture --analyse --out C:\\Temp\\wilkinson-n4
Each excited-port worker has a suspend-inclusive 30-minute deadline.
"""
import argparse
from datetime import datetime, timezone
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

import numpy as np

from fairbeam.network import wilkinson_s
from fairbeam.procutil import popen_group, release_group, terminate_group
from tests import wilkinson_fixture as f


def forecast(meta, rate):
    if isinstance(rate, bool) or not np.isfinite(rate) or rate <= 0:
        raise ValueError("positive finite conservative throughput required")
    return 20+1.15*meta["native_cells"]*meta["max_timesteps"]/(rate*1e6)


def wait_owned(proc, seconds=1800.):
    start, wall = time.monotonic(), time.time()
    while True:
        left = seconds-max(time.monotonic()-start, time.time()-wall)
        if left <= 0:
            raise TimeoutError("owned port worker exceeded 30 minutes")
        try:
            code = proc.wait(timeout=min(1., left))
            if max(time.monotonic()-start, time.time()-wall) > seconds:
                raise TimeoutError("port worker returned after 30 minutes")
            return code
        except TimeoutError:
            raise
        except subprocess.TimeoutExpired:
            pass


def audit_header(text, meta):
    if re.search(r"forced timestep:.*larger than calculated timestep", text):
        raise ValueError("declared clock exceeds the native stability bound")
    version = re.search(r"openEMS 64bit -- version (\S+)", text)
    grid = re.search(r"FDTD simulation size: (\d+)x(\d+)x(\d+) --> (\d+) FDTD cells", text)
    interval = re.search(r"Exact-endcriteria: evaluating the end criteria every (\d+) timestep", text)
    if not version or version[1] != "v0.37.0-rc3" or not grid or not interval:
        raise ValueError("complete bundled-runtime grid and clock header required")
    if list(map(int, grid.groups()[:3])) != meta["native_lines"] or int(grid[4]) != meta["native_cells"]:
        raise ValueError("native grid differs from preflight")
    if f"fixed number of threads: {f.THREADS}" not in text:
        raise ValueError("declared serial native thread count required")
    if int(interval[1]) != int(1/(2*meta["f_max_hz"]*meta["native"]["dt_s"])):
        raise ValueError("native sampling interval differs from measured clock")
    return dict(version=version[1], threads=f.THREADS, nyquist_interval=int(interval[1]))


def acquire_serial(out, n, expanded, end_db, cap_s, rate):
    out = Path(out).resolve()
    if out.exists():
        raise ValueError("fresh output directory required")
    _, meta = f.build(n, 1, expanded, end_db, cap_s)
    estimate = forecast(meta, rate)
    if estimate > 1800:
        raise ValueError(f"forecast {estimate/60:.1f} minutes per port exceeds 30; defer")
    out.mkdir(parents=True)
    source, runtime = f.identity(), f.runtime_identity()
    progress = dict(status="prepared", source_sha256=source, runtime=runtime, limits=f.LIMITS,
                    n=n, expanded=expanded, end_db=end_db, cap_s=cap_s, threads=f.THREADS,
                    rate_assumption_mcps=rate, estimated_seconds_per_port=estimate,
                    started_utc=datetime.now(timezone.utc).isoformat(), ports=[])
    f.save(out/"progress.json", progress)
    for port in (1, 2, 3):
        if source != f.identity() or runtime != f.runtime_identity():
            raise RuntimeError("source/runtime changed between port excitations")
        destination = out/f"port{port}"
        command = [sys.executable, "-m", "tests.test_wilkinson_fixture", "--fdtd", "--worker-case",
                   "--mesh", str(n), "--port", str(port), "--end-db", str(end_db),
                   "--cap-ns", str(cap_s*1e9), "--out", str(destination)]
        if expanded:
            command.append("--expanded")
        log_path = out/f"port{port}.log"
        start, wall = time.monotonic(), time.time()
        code, failure = None, None
        with log_path.open("w", encoding="utf-8") as log:
            proc = popen_group(command, cwd=f.ROOT/"python", stdout=log, stderr=subprocess.STDOUT,
                               env={**os.environ, "OMP_NUM_THREADS": str(f.THREADS), "OPENBLAS_NUM_THREADS": "1"})
            progress.update(status="running", active_port=port, active_launcher_pid=proc.pid)
            f.save(out/"progress.json", progress)
            try:
                code = wait_owned(proc)
            except BaseException as exc:
                failure = repr(exc)
                raise
            finally:
                if proc.poll() is None:
                    terminate_group(proc.pid, grace=0, job=proc.win_job)
                    proc.wait(timeout=15)
                release_group(proc)
                f.save(out/f"port{port}.worker.json", dict(command=command, pid=proc.pid, exit_code=code,
                       failure=failure, wall_seconds=time.time()-wall, monotonic_seconds=time.monotonic()-start,
                       deadline_seconds=1800., estimated_seconds=estimate))
                if failure or code:
                    progress.update(status="failed", failure=failure or f"worker exit {code}")
                    f.save(out/"progress.json", progress)
        if code:
            raise RuntimeError(f"port {port} worker exit {code}; retained {log_path}")
        report = json.loads((destination/"report.json").read_text(encoding="utf-8"))
        report["native_header"] = audit_header(log_path.read_text(encoding="utf-8"), report)
        f.save(destination/"report.json", report)
        _, _, _, quality = f.read(destination)
        progress["ports"].append(dict(port=port, quality=quality, input_sha256=report["input_sha256"],
                                      waves_sha256=report["waves_sha256"]))
        f.save(out/"progress.json", progress)
    _, comparison = f.matrix(out)
    progress.update(status="complete", active_port=None, completed_utc=datetime.now(timezone.utc).isoformat())
    f.save(out/"progress.json", progress)
    return comparison


class WilkinsonControls(unittest.TestCase):
    def test_independent_even_odd_reference_agrees_with_nodal_network(self):
        np.testing.assert_allclose(f.reference(), wilkinson_s(f.FREQUENCIES, f.F0), atol=2e-14, rtol=0)
        center = f.reference([f.F0])[0]
        np.testing.assert_allclose(center[[0, 1, 2, 1], [0, 1, 2, 2]], 0, atol=2e-16)
        np.testing.assert_allclose(center[0, 1:], -1j/np.sqrt(2), atol=2e-16)

    def test_power_split_and_dissipation_are_not_full_three_port_unitarity(self):
        center = f.reference([f.F0])[0]
        self.assertAlmostEqual(float(np.sum(abs(center[:, 0])**2)), 1.)
        self.assertAlmostEqual(float(np.sum(abs(center[:, 1])**2)), .5)
        self.assertLessEqual(float(np.linalg.svd(center, compute_uv=False)[0]), 1.+1e-15)

    def test_complete_wave_inverse_removes_unintended_incoming_waves(self):
        s = f.reference()
        incoming = np.broadcast_to(np.eye(3)+.12j*np.ones((3, 3)), s.shape)
        outgoing = s@incoming
        v = (np.sqrt(f.Z0)*(incoming+outgoing)).transpose(2, 1, 0)
        i = ((incoming-outgoing)/np.sqrt(f.Z0)).transpose(2, 1, 0)
        measured, quality = f.waves_to_s(v, i)
        np.testing.assert_allclose(measured, s, atol=5e-16, rtol=0)
        self.assertLess(quality["independent_inverse_residual_abs"], 5e-16)
        self.assertGreater(float(np.max(abs(outgoing[:, 1, 0]/incoming[:, 0, 0]-s[:, 1, 0]))), .02)

    def test_singular_unexcited_or_nonfinite_waves_are_rejected(self):
        for v in (np.zeros((3, 3, 401)), np.ones((3, 3, 401)), np.full((3, 3, 401), np.nan)):
            with self.assertRaises(ValueError):
                f.waves_to_s(v, v)
        with self.assertRaises(ValueError):
            f.waves_to_s(np.ones((2, 3, 401)), np.ones((2, 3, 401)))

    def test_phase_changes_wrap_and_reject_transmission_nulls(self):
        a, b = f.reference(), f.reference()
        for s, angle in ((a, 179.), (b, -179.)):
            s[:, 1, 0] = .7*np.exp(1j*np.deg2rad(angle))
            s[:, 2, 0] = .7
        self.assertAlmostEqual(f.changes(a, b, mesh=True)["phase_balance_change_deg"], 2.)
        b[:, 1, 0] = 0
        with self.assertRaises(ValueError):
            f.phase_balance(b)

    def test_raw_launch_phase_is_not_an_ideal_phase_certificate(self):
        s = f.reference()*np.exp(.4j)
        result = f.metrics(s)
        self.assertTrue(result["target_passes"])
        self.assertFalse(result["absolute_launch_phase_qualified"])
        self.assertGreater(result["raw_complex_target_diagnostic_abs"], .25)

    def test_reciprocity_and_singular_passivity_gate_nonphysical_results(self):
        s = f.reference()
        s[:, 0, 1] += .02
        self.assertFalse(f.metrics(s)["target_passes"])
        self.assertFalse(f.metrics(f.reference()*1.02)["target_passes"])

    def test_mesh_preserves_physical_geometry_and_one_excited_port(self):
        geometry = []
        for n in f.MESHES:
            for port in (1, 2, 3):
                sim, meta = f.build(n, port)
                self.assertEqual([p["number"] for p in sim.ports if p["excite"]], [port])
                self.assertEqual(meta["params"]["arm_scale"], 1.)
                self.assertEqual(meta["params"]["tan_d"], 0.)
                self.assertEqual(meta["threads"], 1)
                geometry.append(meta["geometry"])
        self.assertTrue(all(g == geometry[0] for g in geometry))

    def test_padding_preserves_every_interior_mesh_node_and_clock(self):
        for n in f.MESHES:
            sim, base = f.build(n, 1)
            enlarged, control = f.build(n, 1, True)
            self.assertEqual(base["declared_dt_s"], control["declared_dt_s"])
            self.assertGreater(control["native_cells"], base["native_cells"])
            for axis in "xyz":
                original, actual = sim.mesh.GetLines(axis), enlarged.mesh.GetLines(axis)
                np.testing.assert_array_equal(actual[(actual >= original[0]) & (actual <= original[-1])], original)

    def test_invalid_mesh_port_cap_and_forecast_are_refused(self):
        for args in ((True, 1), (5, 1), (4, True), (4, 4), (4, 1, "yes"), (4, 1, False, -70.), (4, 1, False, -80., 1e-9)):
            with self.assertRaises(ValueError):
                f.build(*args)
        for rate in (True, 0, -1, np.nan):
            with self.assertRaises(ValueError):
                forecast(dict(native_cells=10, max_timesteps=100), rate)

    def test_over_budget_refuses_before_process_or_output_is_created(self):
        with tempfile.TemporaryDirectory() as temp, patch(__name__+".popen_group") as start:
            out = Path(temp)/"unstarted"
            with self.assertRaisesRegex(ValueError, "exceeds 30"):
                acquire_serial(out, 8, False, f.END_DB, f.CAP_S, .01)
            self.assertFalse(out.exists())
            start.assert_not_called()

    def test_last_mesh_pair_does_not_hide_a_failed_first_pair(self):
        matrices = {f"n{n}": f.reference() for n in f.MESHES}
        matrices["n4"][:, 0, 0] += .02
        def fake(path):
            name = path.name
            n = int(name[1:].split("_")[0])
            return matrices.get(name, f.reference()), dict(n=n, expanded=name.endswith("expanded"),
                end_db=-100. if name.endswith("time") else f.END_DB,
                cap_s=2*f.CAP_S if name.endswith("time") else f.CAP_S,
                all_native_complete=True, target_passes=True)
        with tempfile.TemporaryDirectory() as temp, patch.object(f, "matrix", side_effect=fake):
            result = f.study(temp)
        self.assertFalse(result["qualified"])
        self.assertFalse(result["mesh_changes"][0]["passes"])
        self.assertTrue(result["mesh_changes"][1]["passes"])

    def test_clock_header_rejects_engine_stability_warning(self):
        with self.assertRaisesRegex(ValueError, "stability"):
            audit_header("forced timestep: 1 ps larger than calculated timestep", {})

    def test_actual_native_grid_counts_include_boundary_nodes(self):
        _, meta = f.build(4, 1)
        meta["native"] = dict(dt_s=meta["declared_dt_s"])
        text = ("openEMS 64bit -- version v0.37.0-rc3\n"
                "fixed number of threads: 1\n"
                "FDTD simulation size: 37x29x14 --> 15022 FDTD cells\n"
                "Exact-endcriteria: evaluating the end criteria every 662 timestep\n")
        self.assertEqual(meta["native_lines"], [37, 29, 14])
        self.assertEqual(meta["native_cells"], 15022)
        self.assertEqual(audit_header(text, meta)["nyquist_interval"], 662)
        meta["native_cells"] = 13104
        with self.assertRaisesRegex(ValueError, "grid"):
            audit_header(text, meta)

    def test_probe_clock_rejects_repeats_wrong_stride_and_nonfinite_samples(self):
        native = dict(dt_s=1e-12, numerical_time_s=1e-9)
        t = np.arange(12)*83e-12  # floor(1/(2*1.5GHz*1ps*4))
        data = np.column_stack((t, np.sin(np.arange(12))))
        self.assertEqual(f.trace_clock(data, native, 1.5e9)["stride_steps"], 83)
        for bad in (data*[2, 1], data*np.nan, np.vstack((data[:5], data[4:]))):
            with self.assertRaises(ValueError):
                f.trace_clock(bad, native, 1.5e9)

    def test_native_cap_or_incomplete_source_never_qualifies(self):
        meta = dict(native=dict(timesteps=100, numerical_time_s=10e-9), max_timesteps=101,
                    source_duration_s=5e-9,
                    run=dict(converged=True, exact_endcriteria=True, threads=f.THREADS))
        self.assertTrue(f.stopped(meta))
        meta["run"]["hit_timestep_limit"] = True
        self.assertFalse(f.stopped(meta))
        meta["run"]["hit_timestep_limit"] = False
        meta["native"]["numerical_time_s"] = 4e-9
        self.assertFalse(f.stopped(meta))
        meta["native"]["numerical_time_s"] = 10e-9
        meta["native"]["timesteps"] = 101
        self.assertFalse(f.stopped(meta))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    for name in ("preflight", "fdtd", "analyse", "study"):
        action.add_argument("--"+name, action="store_true")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--mesh", type=int, choices=f.MESHES, default=f.MESHES[0])
    parser.add_argument("--expanded", action="store_true")
    parser.add_argument("--end-db", type=float, choices=(-80., -100.), default=f.END_DB)
    parser.add_argument("--cap-ns", type=float, default=f.CAP_S*1e9)
    parser.add_argument("--rate-mcps", type=float, default=10.)
    parser.add_argument("--worker-case", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--port", type=int, choices=(1, 2, 3), default=1, help=argparse.SUPPRESS)
    args = parser.parse_args()
    cap = args.cap_ns*1e-9
    if args.preflight:
        args.out.mkdir(parents=True, exist_ok=False)
        rows = []
        for n in f.MESHES:
            for expanded in (False, True):
                sim, meta = f.build(n, 1, expanded, args.end_db, cap)
                path = args.out/f"n{n}-expanded{int(expanded)}.xml"
                sim.fdtd.Write2XML(str(path))
                rows.append(dict(**meta, input_sha256=f.sha(path), estimated_seconds_per_port=forecast(meta, args.rate_mcps)))
        f.save(args.out/"preflight.json", dict(protocol=f.PROTOCOL, limits=f.LIMITS,
               source_sha256=f.identity(), runtime=f.runtime_identity(), rows=rows, qualified=False))
        print(json.dumps(rows, indent=2))
    elif args.analyse:
        print(json.dumps(f.matrix(args.out)[1], indent=2))
    elif args.study:
        print(json.dumps(f.study(args.out), indent=2))
    elif args.worker_case:
        print(json.dumps(f.acquire(args.out, args.mesh, args.port, args.expanded, args.end_db, cap), indent=2))
    else:
        print(json.dumps(acquire_serial(args.out, args.mesh, args.expanded, args.end_db, cap, args.rate_mcps), indent=2))


if __name__ == "__main__":
    if len(sys.argv) == 1:
        unittest.main()
    else:
        main()
