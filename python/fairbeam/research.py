"""Research admission, immutable inputs and worker dispatch through the ordinary job queue."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sys

MAX_SNAPSHOT_BYTES = 1024 * 1024
MAX_RESULT_BYTES = 4 * 1024 * 1024
BACKENDS = ("periodic", "elmer")


def encode(value):
    try:
        return (json.dumps(value, sort_keys=True, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
    except (ValueError, TypeError) as exc:
        raise ValueError("research inputs/results must be finite JSON") from exc


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def binary_pins(executables, extra=()):
    paths = set(Path(p).resolve() for p in executables)
    for directory in {p.parent for p in paths}:
        for pattern in ("*.dll", "*.dylib", "*.so", "*.so.*"):
            paths.update(p.resolve() for p in directory.glob(pattern) if p.is_file())
    paths.update(Path(p).resolve() for p in extra if Path(p).is_file())
    if len(paths) > 128 or sum(p.stat().st_size for p in paths) > 256 * 1024 * 1024:
        raise ValueError("research native dependency snapshot exceeds bounds")
    return {str(p): digest(p) for p in sorted(paths)}


def backend_name(value):
    if value not in BACKENDS:
        raise ValueError("backend must be periodic or elmer")
    return value


def requested_path(value):
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 4096 or "\x00" in value:
        raise ValueError("path must be a native executable/package path")
    return value.strip() or None


def elmer_root(path):
    """The Elmer package to use: the given folder, FAIRBEAM_ELMER_ROOT, Elmer on PATH, and last the
    package Fairbeam installs on request (elmer_runtime). fairbeam_elmer itself stays standalone."""
    if path or os.environ.get("FAIRBEAM_ELMER_ROOT"):
        return path
    suffix = ".exe" if os.name == "nt" else ""
    if shutil.which("ElmerSolver" + suffix) and shutil.which("ElmerGrid" + suffix):
        return path
    from . import elmer_runtime
    return str(elmer_runtime.home()) if elmer_runtime.installed() else path


def probe(body):
    if not isinstance(body, dict) or set(body) - {"backend", "path"}:
        raise ValueError("probe expects only backend and path")
    backend = backend_name(body.get("backend"))
    path = requested_path(body.get("path"))
    if backend == "elmer":
        import fairbeam_elmer
        result = fairbeam_elmer.capabilities(elmer_root(path))
    else:
        from . import periodic_cell
        result = periodic_cell.probe(path)
    return {**result, "backend": backend}


def prepare(body):
    """Validate and pin selected binaries before publishing anything to the queue."""
    if not isinstance(body, dict) or set(body) - {"backend", "path", "settings", "design"}:
        raise ValueError("research run expects backend, path, settings and optional design")
    backend = backend_name(body.get("backend"))
    path = requested_path(body.get("path"))
    settings = body.get("settings", {})
    if not isinstance(settings, dict):
        raise ValueError("settings must be an object")
    encode(body)
    if len(encode(body)) > MAX_SNAPSHOT_BYTES:
        raise ValueError("research input snapshot exceeds 1 MiB")
    if backend == "elmer":
        import fairbeam_elmer
        if set(settings) - {"mesh_size"} or body.get("design") is not None:
            raise ValueError("Elmer supports only the fixed PEC cavity and mesh_size")
        mesh = settings.get("mesh_size", .025)
        if isinstance(mesh, bool) or not isinstance(mesh, (int, float)):
            raise ValueError("mesh_size must be a number")
        fairbeam_elmer.validate_case(mesh)
        home, solver, grid = fairbeam_elmer.discover(elmer_root(path))
        settings = {"mesh_size": mesh}
        path = str(home)
        module_dir = home / "share/elmersolver/lib"
        extra = [module_dir / (name + ext) for name in ("EMWaveSolver", "ResultOutputSolve", "SaveData")
                 for ext in (".dll", ".so", ".dylib")]
        pins = binary_pins((solver, grid), extra)
        normalized = settings
    else:
        from . import periodic_cell
        normalized = periodic_cell.validate_spec(settings, body.get("design"))
        capability = periodic_cell.probe(path)
        if not capability.get("available"):
            raise FileNotFoundError(capability.get("reason", "periodic executable unavailable"))
        selected = capability.get("path")
        if not isinstance(selected, str) or not Path(selected).is_file():
            raise FileNotFoundError("periodic probe did not select a native executable")
        path = str(Path(selected).resolve())
        pins = binary_pins((path,))
    spec = {"schema": "fairbeam-research-input-1", "backend": backend, "path": path,
            "settings": settings, "design": body.get("design"), "normalized": normalized,
            "binary_sha256": pins,
            "pin_scope": "selected native executables and adjacent libraries; system dependencies unpinned"}
    raw = encode(spec)
    if len(raw) > MAX_SNAPSHOT_BYTES:
        raise ValueError("normalized research snapshot exceeds 1 MiB")
    return json.loads(raw)  # detach the immutable admission from request-owned dicts


def load_snapshot(job):
    meta = job.research
    if not isinstance(meta, dict) or not isinstance(meta.get("snapshot_sha256"), str):
        raise ValueError("research input metadata missing")
    target = job.dir / "input/research.json"
    if target.is_symlink() or target.parent.is_symlink() or target.resolve().parent != job.dir.resolve() / "input":
        raise ValueError("research snapshot escapes job input directory")
    if target.stat().st_size > MAX_SNAPSHOT_BYTES:
        raise ValueError("research snapshot exceeds size limit")
    raw = target.read_bytes()
    if hashlib.sha256(raw).hexdigest() != meta["snapshot_sha256"]:
        raise ValueError("research snapshot checksum mismatch")
    spec = json.loads(raw)
    if spec.get("backend") != meta.get("backend") or spec.get("schema") != "fairbeam-research-input-1":
        raise ValueError("research snapshot identity mismatch")
    encode(spec)
    for name, expected in spec.get("binary_sha256", {}).items():
        if digest(name) != expected:
            raise ValueError("selected research executable changed after admission")
    return target, spec


def validate_result(value, backend):
    if not isinstance(value, dict) or value.get("backend") != backend or value.get("research_schema") != "fairbeam-research-result-1":
        raise ValueError("research result backend identity mismatch")
    raw = encode(value)
    if len(raw) > MAX_RESULT_BYTES:
        raise ValueError("research result exceeds 4 MiB")
    frequencies = value.get("frequency_hz")
    if not isinstance(frequencies, list) or not frequencies or len(frequencies) > 10001:
        raise ValueError("research result has no bounded frequency axis")
    if any(isinstance(f, bool) or not isinstance(f, (int, float)) or not math.isfinite(f) or f <= 0 for f in frequencies):
        raise ValueError("research result frequency values invalid")
    if any(b <= a for a, b in zip(frequencies, frequencies[1:])):
        raise ValueError("research result frequencies are not ordered")
    if backend == "periodic":
        if value.get("schema") != "fairbeam.periodic-result/1":
            raise ValueError("unsupported periodic research result schema")
        for key in ("s11_real", "s11_imag", "s21_real", "s21_imag"):
            values = value.get(key)
            if not isinstance(values, list) or len(values) != len(frequencies) or any(isinstance(v, bool) or not isinstance(v, (float, int)) for v in values):
                raise ValueError("research result complex trace is incomplete")
        qa = value.get("qa")
        required = ("energy_converged", "empty_reference_pass", "co_polar_power_upper_bound_pass")
        if not isinstance(qa, dict) or any(type(qa.get(key)) is not bool for key in required):
            raise ValueError("periodic result numerical checks missing")
        if value.get("status") == "results_validated" and (not all(qa[key] for key in required)
                or qa.get("analytic_pass", True) is not True):
            raise ValueError("periodic validated status contradicts numerical checks")
    else:
        if value.get("qualifies_driven_antenna") is not False or value.get("s_parameters") is not None or not isinstance(value.get("mode1"), dict):
            raise ValueError("Elmer cavity result scope invalid")
        mode = value["mode1"]
        expected = 299792458.0 * .5 * math.sqrt(.1 ** -2 + .2 ** -2)
        analytic = mode.get("analytic_frequency_hz")
        error = mode.get("relative_frequency_error")
        correlation = mode.get("complex_field_shape_correlation")
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in (analytic, error, correlation)):
            raise ValueError("Elmer cavity reference metrics missing")
        if mode.get("family") != "TE101 (z axis)" or abs(analytic - expected) > 1e-5 or abs(error - abs(frequencies[0] / expected - 1)) > 1e-8:
            raise ValueError("Elmer cavity reference identity/units mismatch")
        if not 0 <= correlation <= 1 + 1e-12 or error < 0:
            raise ValueError("Elmer cavity reference metrics invalid")
        if value.get("status") == "results_validated" and (error >= .03 or correlation <= .98):
            raise ValueError("Elmer validated status contradicts reference criteria")
    if value.get("status") not in ("results_validated", "results_exported", "validation_failed"):
        raise ValueError("research result validation state missing")
    return value


def load_result(job):
    target = job.dir / "research/result.json"
    if target.is_symlink() or target.parent.is_symlink() or target.resolve().parent != job.dir.resolve() / "research":
        raise ValueError("research result escapes job output directory")
    if target.stat().st_size > MAX_RESULT_BYTES:
        raise ValueError("research result exceeds size limit")
    raw = target.read_bytes()
    value = validate_result(json.loads(raw), job.research["backend"])
    return value, hashlib.sha256(raw).hexdigest()


def execute(snapshot, outdir, checksum):
    """Called only by the JobManager-owned worker process, never in HTTP request threads."""
    snapshot, outdir = Path(snapshot), Path(outdir)
    raw = snapshot.read_bytes()
    if hashlib.sha256(raw).hexdigest() != checksum:
        raise ValueError("research snapshot changed before execution")
    spec = json.loads(raw)
    if spec.get("schema") != "fairbeam-research-input-1":
        raise ValueError("unsupported research input schema")
    # Recheck pins immediately before importing and launching the selected native backend.
    for name, expected in spec["binary_sha256"].items():
        if digest(name) != expected:
            raise ValueError("selected research executable changed before launch")
    backend = backend_name(spec["backend"])
    print('fairbeam-research: {"type":"phase","phase":"simulating"}', flush=True)
    if backend == "elmer":
        import fairbeam_elmer
        result = fairbeam_elmer.run_cavity(outdir, root=spec["path"], mesh_size=spec["normalized"]["mesh_size"], experimental=True)
    else:
        from . import periodic_cell
        result = periodic_cell.run(spec["normalized"], outdir, executable=spec["path"])
    value = validate_result({**result, "backend": backend, "research_schema": "fairbeam-research-result-1"}, backend)
    value["input_sha256"] = hashlib.sha256(raw).hexdigest()
    target = outdir / "result.json"
    tmp = target.with_suffix(".json.tmp")
    tmp.write_bytes(encode(value))
    os.replace(tmp, target)
    print('fairbeam-research: {"type":"phase","phase":"results_exported"}', flush=True)
    if value["status"] != "results_validated":
        raise ValueError("research result did not pass its backend validation gates")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--sha256", required=True)
    args = parser.parse_args(argv)
    try:
        execute(args.snapshot, args.outdir, args.sha256)
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"fairbeam-research: {exc}", file=sys.stderr, flush=True)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
