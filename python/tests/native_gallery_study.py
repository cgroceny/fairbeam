"""Compare the example gallery with an independently installed native openEMS CLI.

From python/: python -m tests.native_gallery_study --out <new-directory>
    --native <official-openEMS-executable> [--models dipole,blade_867]

This is an equal-input port-response control, not a physical accuracy certificate.
It retains exact solver inputs, raw probes and complete complex S matrices. Each
multiport model is excited once per port. All solves run sequentially (four CPU
threads by default); NF2FF is omitted. A new output directory is required.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import shutil
import subprocess
import sys
import time

import numpy as np

from fairbeam.model import load_model, resolve_params
from fairbeam.simulation import excite_only, _parse_log
from tests.native_gallery_xml import write as write_native_xml

ROOT = Path(__file__).resolve().parents[2]


def save(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def catalog():
    paths = sorted((ROOT / "python/models").glob("*.py")) + sorted((ROOT / "examples/designs").glob("*.design.json"))
    rows = [{"id": p.name.split(".")[0], "source": str(p.relative_to(ROOT)), "overrides": {}} for p in paths]
    rows.append({"id": "sierpinski_monopole_0", "source": "python/models/sierpinski_monopole.py", "overrides": {"iterations": 0}})
    return rows


def build(case, port=None):
    module = load_model(ROOT / case["source"])
    params = resolve_params(module.PARAMS, case["overrides"])
    with excite_only(port):
        sim = module.build(params)
    sim.remove_nf2ff_box()
    sim.max_timesteps, sim.end_criteria_db = 300000, -60
    sim.fdtd.SetNumberOfTimeSteps(300000)
    sim.fdtd.SetEndCriteria(1e-6)
    return sim, params


def waves(sim, folder):
    frequency = np.linspace(sim.f_min, sim.f_max, 801)
    incident, reflected = [], []
    for port in sim._port_objs:
        port.CalcPort(str(folder), frequency)
        incident.append(port.uf_inc / np.sqrt(port.Z_ref))
        reflected.append(port.uf_ref / np.sqrt(port.Z_ref))
    a, b = np.asarray(incident), np.asarray(reflected)
    if not np.isfinite(a).all() or not np.isfinite(b).all():
        raise ValueError("non-finite port data")
    np.savez(folder / "waves.npz", frequency_hz=frequency, a=a, b=b)
    return a, b


def run_pair(case, pn, out, native, timeout, threads=4):
    folder = out / case["id"] / f"port-{pn}"
    folder.mkdir(parents=True, exist_ok=False)
    sim, params = build(case, pn)
    shutil.copyfile(ROOT / case["source"], folder / Path(case["source"]).name)
    save(folder / "settings.json", {
        "params": params, "ports": sim.ports, "source": sim.excitation, "boundaries": sim.boundaries,
        "mesh": {a: sim.mesh.GetLines(a).tolist() for a in "xyz"}, "source_sha256": digest(ROOT / case["source"]),
        "threads": threads, "end_criteria_db": -60, "max_timesteps": 300000, "nf2ff": False,
    })
    write_native_xml(sim, folder / "model.xml")
    progress = {"status": "model_built", "started_utc": datetime.now(timezone.utc).isoformat(),
                "xml_sha256": digest(folder / "model.xml")}
    save(folder / "progress.json", progress)
    progress["status"] = "solver_started"
    save(folder / "progress.json", progress)
    stats = sim.run(str(folder / "fairbeam"), threads=threads)
    save(folder / "fairbeam-stats.json", stats)
    a, b = waves(sim, folder / "fairbeam")
    # Exercise the app's rounded result extraction, not only native CalcPort.
    extracted = sim.evaluate(n_freq=801)["ports"][str(pn)]
    gamma = np.asarray(extracted["s11_re"]) + 1j * np.asarray(extracted["s11_im"])
    excited_index = next(i for i, p in enumerate(sim.ports) if p["number"] == pn)
    rounding = float(np.max(abs(gamma - b[excited_index] / a[excited_index])))
    route = folder / "native"
    route.mkdir()
    command = [str(native), str(folder / "model.xml"), "--engine=multithreaded", f"--numThreads={threads}", "--exact-endcriteria"]
    with (route / "solver.log").open("w", encoding="utf-8") as log:
        result = subprocess.run(command, cwd=route, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"native solver exit {result.returncode}")
    text = (route / "solver.log").read_text(encoding="utf-8", errors="replace")
    native_stats = _parse_log(text, -60, 300000)
    save(route / "stats.json", native_stats)
    waves(sim, route)
    save(folder / "summary.json", {
        **progress, "status": "results_exported", "ended_utc": datetime.now(timezone.utc).isoformat(),
        "fairbeam_energy": stats.get("converged"), "native_energy": native_stats.get("converged"),
        "timesteps": [stats.get("timesteps"), native_stats.get("timesteps")], "bundle_rounding_max_abs": rounding,
    })


def summarize(folder):
    from fairbeam.multiport import assemble_s
    ports = sorted((p for p in folder.glob("port-*") if p.is_dir()), key=lambda p: int(p.name.split("-")[-1]))
    matrices = []
    assembly_error = 0.0
    for route in ("fairbeam", "native"):
        runs = [np.load(p / route / "waves.npz") for p in ports]
        frequencies = runs[0]["frequency_hz"]
        if any(not np.array_equal(r["frequency_hz"], frequencies) for r in runs):
            raise ValueError("port frequency axes differ")
        a = np.stack([r["a"] for r in runs])
        b = np.stack([r["b"] for r in runs])
        A, B = a.transpose(2, 1, 0), b.transpose(2, 1, 0)
        # Independent batch inverse control against Fairbeam's transposed solve.
        s = B @ np.linalg.inv(A)
        library_s = assemble_s(a, b, list(range(1, len(ports) + 1)), len(ports))
        assembly_error = max(assembly_error, float(np.max(abs(s - library_s))))
        if not np.isfinite(s).all():
            raise ValueError("non-finite S matrix")
        np.savez(folder / (route + "-matrix.npz"), frequency_hz=frequencies, s=s)
        matrices.append(s)
    delta = abs(matrices[0] - matrices[1])
    peak = float(delta.max())
    singular_power = float(np.max(np.linalg.svd(matrices[0], compute_uv=False)[..., 0] ** 2))
    records = [json.loads((p / "summary.json").read_text()) for p in ports]
    rounding = max(r["bundle_rounding_max_abs"] for r in records)
    energy_all = all(r["fairbeam_energy"] is True and r["native_energy"] is True for r in records)
    passive = singular_power <= 1.01
    equal = peak <= 1e-5 and assembly_error <= 1e-12 and rounding <= 8.1e-6
    result = {"status": "results_validated" if equal and energy_all and passive else "validation_failed",
              "equal_input_pass": equal,
              "complex_max_abs": peak, "complex_rmse": float(np.sqrt(np.mean(delta ** 2))), "ports": len(ports),
              "matrix_assembly_max_abs": assembly_error, "bundle_rounding_max_abs": rounding,
              "energy_all": energy_all,
              "passivity_max_singular_power": singular_power, "passive": passive,
              "mesh_convergence": "not tested by equal-input control"}
    save(folder / "summary.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--models", help="Comma-separated catalog IDs; omit to run the entire gallery")
    parser.add_argument("--timeout", type=float, default=900, help="Native solver timeout, seconds; pair limit is twice this plus 50")
    parser.add_argument("--threads", type=int, default=4, help="CPU threads in both routes (default 4)")
    parser.add_argument("--case", help=argparse.SUPPRESS)
    parser.add_argument("--port", type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    out, native = args.out.resolve(), args.native.resolve()
    if not native.is_file() or not np.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("native executable must exist and timeout must be finite and positive")
    if not 1 <= args.threads <= (os.cpu_count() or 1):
        parser.error("threads must be between 1 and the host's logical CPU count")
    cases = catalog()
    if args.port:
        run_pair(next(c for c in cases if c["id"] == args.case), args.port, out, native, args.timeout, args.threads)
        return 0
    if args.models:
        names = set(args.models.split(","))
        if names - {c["id"] for c in cases}:
            parser.error("unknown model ID")
        cases = [c for c in cases if c["id"] in names]
    out.mkdir(parents=True, exist_ok=False)
    manifest = {"status": "created", "scope": "equal-input native CLI port control; no far-field validation",
                "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                "source_dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)),
                "generator_sha256": digest(Path(__file__)), "native_sha256": digest(native),
                "xml_adapter_sha256": digest(Path(__file__).with_name("native_gallery_xml.py")),
                "host": platform.platform(), "python": sys.version, "numpy": np.__version__,
                "threads": args.threads,
                "native_dll_sha256": digest(native.with_name("openEMS.dll")) if native.with_name("openEMS.dll").exists() else None,
                "cases": cases, "results": []}
    save(out / "manifest.json", manifest)
    for case in cases:
        folder = out / case["id"]
        folder.mkdir()
        start = time.monotonic()
        try:
            sim, _ = build(case)
            case["ports"] = [p["number"] for p in sim.ports]
            case["source_sha256"] = digest(ROOT / case["source"])
            case["cells"] = int(np.prod([len(sim.mesh.GetLines(a)) - 1 for a in "xyz"]))
            if case["ports"] != list(range(1, len(case["ports"]) + 1)):
                raise ValueError("gallery control expects contiguous port numbers")
            save(out / "manifest.json", manifest)
            for pn in case["ports"]:
                with (folder / f"port-{pn}.log").open("w", encoding="utf-8") as log:
                    command = [sys.executable, "-m", "tests.native_gallery_study", "--out", str(out), "--native", str(native),
                               "--case", case["id"], "--port", str(pn), "--timeout", str(args.timeout),
                               "--threads", str(args.threads)]
                    proc = subprocess.Popen(command, cwd=ROOT / "python", stdout=log, stderr=subprocess.STDOUT,
                                            start_new_session=os.name != "nt")
                    try:
                        code = proc.wait(timeout=2 * args.timeout + 50)
                    except subprocess.TimeoutExpired:
                        if os.name == "nt":
                            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
                        else:
                            os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait()
                        raise RuntimeError("pair timeout; incomplete outputs retained")
                if code:
                    raise RuntimeError(f"port {pn} exit {code}; inspect its retained log")
            result = summarize(folder)
        except Exception as error:
            result = {"status": "failed", "error": str(error)}
        manifest["results"].append({"id": case["id"], "wall_s": time.monotonic() - start, **result})
        save(out / "manifest.json", manifest)
        print(case["id"], result["status"], flush=True)
    manifest["status"] = "completed"
    save(out / "manifest.json", manifest)
    return int(any(r["status"] != "results_validated" for r in manifest["results"]))


if __name__ == "__main__":
    raise SystemExit(main())
