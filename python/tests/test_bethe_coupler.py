"""Pure controls; native acquisition is explicit and serial.

From python/ using the bundled environment and fresh output outside Git:
python -m tests.test_bethe_coupler --preflight --out C:\\study\\bethe-plan
python -m tests.test_bethe_coupler --fdtd --mesh 24 --out C:\\study\\bethe\\n24
python -m tests.test_bethe_coupler --study --out C:\\study\\bethe
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

from fairbeam.procutil import popen_group, release_group, terminate_group
from tests import bethe_coupler_fixture as f


def forecast(meta, rate):
    if isinstance(rate, bool) or not np.isfinite(rate) or rate <= 0:
        raise ValueError("positive finite conservative throughput required")
    return 20+1.15*meta["native_cells"]*meta["max_timesteps"]/(rate*1e6)


def audit_header(text, meta):
    if re.search(r"forced timestep:.*larger than calculated timestep", text):
        raise ValueError("native stability bound exceeded")
    grid = re.search(r"FDTD simulation size: (\d+)x(\d+)x(\d+) --> (\d+) FDTD cells", text)
    interval = re.search(r"Exact-endcriteria: evaluating the end criteria every (\d+) timestep", text)
    pulse = re.search(r"Excitation signal length is: (\d+) timesteps", text)
    if ("openEMS 64bit -- version v0.37.0-rc3" not in text or not grid or not interval or not pulse
            or f"fixed number of threads: {f.THREADS}" not in text):
        raise ValueError("complete bundled-runtime grid/clock/thread header required")
    if list(map(int, grid.groups()[:3])) != meta["native_lines"] or int(grid[4]) != meta["native_cells"]:
        raise ValueError("native grid differs from preflight")
    if int(interval[1]) != int(1/(2*f.FREQUENCIES[-1]*meta["native"]["dt_s"])):
        raise ValueError("native sampling interval differs from declared clock")
    if abs(int(pulse[1])-int(np.ceil(meta["source_duration_s"]/meta["native"]["dt_s"]))) > 1:
        raise ValueError("native Gaussian pulse length differs from preflight")
    return dict(version="v0.37.0-rc3", nyquist_interval=int(interval[1]), threads=f.THREADS,
                excitation_timesteps=int(pulse[1]))


def wait_owned(proc, seconds=1800.):
    start, wall = time.monotonic(), time.time()
    while True:
        left = seconds-max(time.monotonic()-start, time.time()-wall)
        if left <= 0:
            raise TimeoutError("owned worker exceeded 30 minutes including suspend")
        try:
            code = proc.wait(timeout=min(1., left))
            if max(time.monotonic()-start, time.time()-wall) > seconds:
                raise TimeoutError("worker returned after deadline")
            return code
        except subprocess.TimeoutExpired:
            pass


def acquire_serial(out, n, rate=10., **options):
    out = Path(out).resolve()
    if out.exists():
        raise ValueError("fresh output required")
    _, meta = f.build(n, 1, **options)
    estimate = forecast(meta, rate)
    if estimate > 1800:
        raise ValueError(f"forecast {estimate/60:.1f} min exceeds 30; defer before launch")
    out.mkdir(parents=True)
    source, runtime = f.identity(), f.runtime_identity()
    progress = dict(status="prepared", options=options, n=n, estimated_seconds_per_port=estimate,
                    source_sha256=source, runtime=runtime, limits=f.LIMITS, ports=[])
    f.save(out/"progress.json", progress)
    for port in range(1, 5):
        if f.identity() != source or f.runtime_identity() != runtime:
            raise RuntimeError("source/runtime changed between ports")
        destination = out/f"port{port}"
        command = [sys.executable, "-m", "tests.test_bethe_coupler", "--fdtd", "--worker-case",
                   "--mesh", str(n), "--port", str(port), "--out", str(destination)]
        for name in ("closed", "inset", "distance", "pml", "end_db", "cap_s"):
            value = options.get(name)
            if name == "closed" and value:
                command.append("--closed")
            elif name == "inset" and value is False:
                command.append("--full-probes")
            elif name in ("distance", "pml", "end_db", "cap_s") and value is not None:
                flag = "--cap-ns" if name == "cap_s" else "--"+name.replace("_", "-")
                command += [flag, str(value*1e9 if name == "cap_s" else value)]
        start, wall = time.monotonic(), time.time()
        code, failure = None, None
        log_path = out/f"port{port}.log"
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
                f.save(out/f"port{port}.worker.json", dict(pid=proc.pid, command=command, exit_code=code,
                    failure=failure, deadline_seconds=1800., wall_seconds=time.time()-wall,
                    monotonic_seconds=time.monotonic()-start))
        if code:
            raise RuntimeError(f"port {port} failed; preserve {log_path}")
        report = json.loads((destination/"report.json").read_text(encoding="utf-8"))
        report["native_header"] = audit_header(log_path.read_text(encoding="utf-8"), report)
        f.save(destination/"report.json", report)
        _, _, _, quality = f.read(destination)
        progress["ports"].append(dict(port=port, quality=quality))
        f.save(out/"progress.json", progress)
    _, result = f.matrix(out)
    progress.update(status="complete", active_port=None, completed_utc=datetime.now(timezone.utc).isoformat())
    f.save(out/"progress.json", progress)
    return result


class BetheControls(unittest.TestCase):
    def test_independent_cancellation_and_cubic_radius_design(self):
        c, isolated = f.reference([f.F0])
        self.assertAlmostEqual(float(abs(c[0])), .1, places=14)
        self.assertLess(abs(isolated[0]), 2e-16)
        g = f.design()
        self.assertAlmostEqual(g["k0_radius"], .7822523951698644)
        self.assertGreater(g["hole_x_mm"], g["radius_mm"])
        self.assertLess(g["hole_x_mm"]+g["radius_mm"], f.A)
        beta = f.beta([f.F0])[0]
        kc = np.pi/(f.A*1e-3)
        k = 2*np.pi*f.F0/f.C0
        independent = 16*(g["radius_mm"]*1e-3)**3*kc**2*beta/(3*(f.A*f.B*1e-6)*(4*kc**2-k**2))
        self.assertAlmostEqual(independent, .1, places=14)

    def test_frequency_dependence_and_cutoff_refusal(self):
        c, isolated = f.reference([7e9, 9e9, 11e9])
        self.assertGreater(abs(isolated[0]), .01)
        self.assertGreater(abs(isolated[2]), .01)
        self.assertGreater(abs(c[-1]), abs(c[0]))
        for values in ([1e9], [14e9], [np.nan], []):
            with self.assertRaises(ValueError):
                f.reference(values)

    def test_geometry_and_probe_planes_do_not_move_with_mesh(self):
        for n in f.MESHES:
            for port in range(1, 5):
                sim, meta = f.build(n, port)
                self.assertEqual(meta["geometry"], f.design())
                self.assertEqual([p["number"] for p in sim.ports if p["excite"]], [port])
                self.assertEqual([abs(p["stop"][2]) for p in sim.ports], [f.DISTANCE]*4)
                self.assertTrue(all(p._fairbeam_probe_inset_cells == 1 for p in sim._port_objs))

    def test_pml_and_distance_controls_preserve_interior_grid_and_clock(self):
        for n in f.MESHES:
            _, original = f.build(n, 1)
            for options in (dict(pml=f.DEEP_PML), dict(distance=f.FAR_DISTANCE)):
                _, control = f.build(n, 1, **options)
                self.assertEqual(control["declared_dt_s"], original["declared_dt_s"])
                for axis in "xyz":
                    a, b = np.array(original["mesh_mm"][axis]), np.array(control["mesh_mm"][axis])
                    np.testing.assert_array_equal(b[(b >= a[0]) & (b <= a[-1])], a)

    def test_real_material_query_opens_only_the_declared_circle(self):
        g = f.design()
        inside = [g["hole_x_mm"], 0, 0]
        outside = [g["hole_x_mm"]+g["radius_mm"]+.5, 0, 0]
        for n in f.MESHES:
            sim, _ = f.build(n, 1)
            self.assertEqual(sim.csx.GetPropertyByCoordPriority(inside).GetName(), "aperture_air")
            self.assertEqual(sim.csx.GetPropertyByCoordPriority(outside).GetName(), "common_wall")
            sim, _ = f.build(n, 1, closed=True)
            self.assertEqual(sim.csx.GetPropertyByCoordPriority(inside).GetName(), "common_wall")

    def test_every_zero_thickness_source_uses_the_exact_stored_mesh_node(self):
        for n in f.MESHES:
            for distance in (f.DISTANCE, f.FAR_DISTANCE):
                _, meta = f.build(n, 1, distance=distance)
                z = meta["mesh_mm"]["z"]
                for port in meta["ports"]:
                    self.assertIn(port["start"][2], z)
                    self.assertIn(port["stop"][2], z)

    def test_invalid_geometry_controls_are_refused(self):
        for n, port, options in ((True, 1, {}), (24., 1, {}), (30, 1, {}), (24, True, {}), (24, 5, {}),
                (24, 1, dict(pml=10)), (24, 1, dict(distance=70)), (24, 1, dict(inset=1)), (24, 1, dict(cap_s=1e-9))):
            with self.assertRaises(ValueError):
                f.build(n, port, **options)

    def test_full_wave_inverse_handles_unintended_incident_modes(self):
        rng = np.random.default_rng(314)
        s = .15*(rng.normal(size=(201, 4, 4))+1j*rng.normal(size=(201, 4, 4)))
        incoming = np.broadcast_to(np.eye(4)+.1j*np.ones((4, 4)), s.shape)
        outgoing = s@incoming
        z = f.ETA0*(2*np.pi*f.FREQUENCIES/f.C0)/f.beta()
        v = (np.sqrt(z)[:, None, None]*(incoming+outgoing)).transpose(2, 1, 0)
        i = ((incoming-outgoing)/np.sqrt(z)[:, None, None]).transpose(2, 1, 0)
        actual, quality = f.waves_to_s(v, i)
        np.testing.assert_allclose(actual, s, atol=5e-16, rtol=0)
        self.assertLess(quality["inverse_residual_abs"], 5e-16)
        self.assertGreater(float(np.max(abs(outgoing[:, 2, 0]/incoming[:, 0, 0]-s[:, 2, 0]))), .02)

    def test_singular_and_nonfinite_waves_are_rejected(self):
        for data in (np.zeros((4, 4, 201)), np.ones((4, 4, 201)), np.full((4, 4, 201), np.nan)):
            with self.assertRaises(ValueError):
                f.waves_to_s(data, data)

    def test_wrong_trace_clock_repeated_time_and_nonfinite_data_are_refused(self):
        native = dict(dt_s=1e-12, numerical_time_s=200e-12)
        data = np.column_stack((np.arange(12)*11e-12, np.sin(np.arange(12))))
        self.assertEqual(f.trace_clock(data, native)["stride_steps"], 11)
        for bad in (data*[2, 1], data*np.nan, np.vstack((data[:5], data[4:]))):
            with self.assertRaises(ValueError):
                f.trace_clock(bad, native)

    def test_native_header_uses_node_count_and_measured_clock(self):
        _, meta = f.build(24, 1)
        meta["native"] = dict(dt_s=meta["declared_dt_s"])
        lines = "x".join(str(n) for n in meta["native_lines"])
        interval = int(1/(2*f.FREQUENCIES[-1]*meta["declared_dt_s"]))
        text = (f"openEMS 64bit -- version v0.37.0-rc3\nfixed number of threads: 4\n"
                f"FDTD simulation size: {lines} --> {meta['native_cells']} FDTD cells\n"
                f"Excitation signal length is: {int(np.ceil(meta['source_duration_s']/meta['declared_dt_s']))} timesteps\n"
                f"Exact-endcriteria: evaluating the end criteria every {interval} timestep\n")
        self.assertEqual(audit_header(text, meta)["nyquist_interval"], interval)
        meta["native_cells"] -= 1
        with self.assertRaisesRegex(ValueError, "grid"):
            audit_header(text, meta)
        with self.assertRaisesRegex(ValueError, "stability"):
            audit_header("forced timestep: 1 ps larger than calculated timestep", {})

    def test_capped_or_source_incomplete_native_runs_do_not_pass(self):
        meta = dict(native=dict(timesteps=100, numerical_time_s=10e-9), max_timesteps=101,
                    source_duration_s=1e-9, run=dict(converged=True, exact_endcriteria=True, threads=4))
        self.assertTrue(f.stopped(meta))
        meta["run"]["hit_timestep_limit"] = True
        self.assertFalse(f.stopped(meta))
        meta["run"]["hit_timestep_limit"] = False
        meta["native"]["numerical_time_s"] = .5e-9
        self.assertFalse(f.stopped(meta))

    def test_record_quality_requires_consistent_native_grid_clock_and_header(self):
        _, meta = f.build(24, 1)
        steps = int(np.ceil(2*meta["source_duration_s"]/meta["declared_dt_s"]))
        meta["native"] = dict(cells=meta["native_cells"], dt_s=meta["declared_dt_s"],
                              timesteps=steps, numerical_time_s=steps*meta["declared_dt_s"])
        meta["run"] = dict(grid=meta["native_lines"], converged=True, exact_endcriteria=True, threads=f.THREADS)
        meta["native_header"] = dict(version="v0.37.0-rc3", threads=f.THREADS,
                                     nyquist_interval=int(1/(2*f.FREQUENCIES[-1]*meta["declared_dt_s"])),
                                     excitation_timesteps=int(np.ceil(meta["source_duration_s"]/meta["declared_dt_s"])))
        self.assertTrue(all(f.record_quality(meta).values()))
        meta["native"]["numerical_time_s"] *= 2
        self.assertFalse(f.record_quality(meta)["native_time_ok"])
        meta["native"]["numerical_time_s"] /= 2
        meta["native"]["cells"] -= 1
        self.assertFalse(f.record_quality(meta)["grid_ok"])
        meta["native"]["cells"] += 1
        meta["native_header"]["threads"] = 1
        self.assertFalse(f.record_quality(meta)["header_ok"])
        del meta["native_header"]
        self.assertFalse(f.record_quality(meta)["header_ok"])

    def test_over_budget_refuses_without_starting_worker_or_creating_outputs(self):
        with tempfile.TemporaryDirectory() as temp, patch(__name__+".popen_group") as start:
            out = Path(temp)/"not-started"
            with self.assertRaisesRegex(ValueError, "exceeds 30"):
                acquire_serial(out, 48, .01)
            self.assertFalse(out.exists())
            start.assert_not_called()
        for rate in (True, 0, -1, np.nan):
            with self.assertRaises(ValueError):
                forecast({}, rate)

    def test_passing_last_pair_does_not_hide_failed_earlier_mesh(self):
        matrices = {f"n{n}": np.zeros((201, 4, 4), complex) for n in f.MESHES}
        matrices["n24"][:, 0, 0] = .02
        def fake(path):
            name = path.name
            n = int(name[1:].split("_")[0])
            row = dict(n=n, closed=name.endswith("closed"), inset=True,
                distance_mm=f.FAR_DISTANCE if name.endswith("far") else f.DISTANCE,
                pml=f.DEEP_PML if name.endswith("pml") else f.PML,
                end_db=-90. if name.endswith("time") else f.END_DB,
                cap_s=2*f.CAP_S if name.endswith("time") else f.CAP_S,
                target_passes=True, all_native_complete=True, closed_wall_floor_abs=0.)
            return matrices.get(name, np.zeros((201, 4, 4), complex)), row
        with tempfile.TemporaryDirectory() as temp, patch.object(f, "matrix", side_effect=fake):
            result = f.study(temp)
        self.assertFalse(result["qualified"])
        self.assertGreater(result["mesh_changes"][0], f.LIMITS["complex_mesh_abs"])
        self.assertEqual(result["mesh_changes"][1], 0.)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    for name in ("preflight", "fdtd", "analyse", "study"):
        action.add_argument("--"+name, action="store_true")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--mesh", type=int, choices=f.MESHES, default=f.MESHES[0])
    parser.add_argument("--closed", action="store_true")
    parser.add_argument("--full-probes", action="store_true")
    parser.add_argument("--distance", type=float, choices=(f.DISTANCE, f.FAR_DISTANCE), default=f.DISTANCE)
    parser.add_argument("--pml", type=int, choices=(f.PML, f.DEEP_PML), default=f.PML)
    parser.add_argument("--end-db", type=float, choices=(-80., -90.), default=f.END_DB)
    parser.add_argument("--cap-ns", type=float, default=f.CAP_S*1e9)
    parser.add_argument("--rate-mcps", type=float, default=10.)
    parser.add_argument("--worker-case", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--port", type=int, choices=(1, 2, 3, 4), default=1, help=argparse.SUPPRESS)
    args = parser.parse_args()
    options = dict(closed=args.closed, inset=not args.full_probes, distance=args.distance,
                   pml=args.pml, end_db=args.end_db, cap_s=args.cap_ns/1e9)
    if args.preflight:
        args.out.mkdir(parents=True, exist_ok=False)
        rows = []
        for n in f.MESHES:
            sim, meta = f.build(n, 1, **options)
            path = args.out/f"n{n}.xml"
            sim.fdtd.Write2XML(str(path))
            rows.append(dict(meta=meta, input_sha256=f.sha(path), forecast_seconds=forecast(meta, args.rate_mcps)))
        f.save(args.out/"plan.json", dict(rows=rows, source=f.identity(), runtime=f.runtime_identity(), limits=f.LIMITS))
        print(json.dumps(rows, indent=2))
    elif args.analyse:
        print(json.dumps(f.matrix(args.out)[1], indent=2))
    elif args.study:
        print(json.dumps(f.study(args.out), indent=2))
    elif args.worker_case:
        print(json.dumps(f.acquire(args.out, args.mesh, args.port, **options), indent=2))
    else:
        print(json.dumps(acquire_serial(args.out, args.mesh, args.rate_mcps, **options), indent=2))


if __name__ == "__main__":
    if len(sys.argv) == 1:
        unittest.main()
    else:
        main()
