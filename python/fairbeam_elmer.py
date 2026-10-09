"""Opt-in external Elmer PEC-cavity research benchmark; no Fairbeam/openEMS imports."""
import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import struct
import subprocess
import sys
import time

C0 = 299792458.0
DIMENSIONS_M = (0.1, 0.05, 0.2)
MESH_SIZES_M = (0.025, 0.0125)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def discover(root=None):
    """Locate external native binaries without executing or installing anything."""
    root = root or os.environ.get("FAIRBEAM_ELMER_ROOT")
    suffix = ".exe" if os.name == "nt" else ""
    if root:
        directory = Path(root).expanduser().resolve()
        bindir = directory / "bin" if (directory / "bin").is_dir() else directory
        home = bindir.parent if bindir.name == "bin" else directory
        solver, grid = bindir / ("ElmerSolver" + suffix), bindir / ("ElmerGrid" + suffix)
    else:
        s, g = shutil.which("ElmerSolver" + suffix), shutil.which("ElmerGrid" + suffix)
        if not s or not g:
            raise FileNotFoundError("Set FAIRBEAM_ELMER_ROOT or --root to an external native Elmer package")
        solver, grid = Path(s).resolve(), Path(g).resolve()
        if solver.parent != grid.parent:
            raise ValueError("ElmerSolver and ElmerGrid must come from the same binary directory")
        home = solver.parent.parent if solver.parent.name == "bin" else solver.parent
    for p in (solver, grid):
        if not p.is_file() or (os.name != "nt" and not os.access(p, os.X_OK)):
            raise FileNotFoundError(f"Native executable unavailable: {p}")
    return home, solver, grid


def capabilities(root=None):
    result = {"backend": "elmer-experimental", "platform": platform.system(),
              "machine": platform.machine(), "physics": ["pec_rectangular_cavity_benchmark"],
              "driven_ports": False, "radiation": False, "s_parameters": False,
              "macos_qualified": False, "probe_executes_solver": False}
    try:
        home, solver, grid = discover(root)
        result.update(available=True, root=str(home), solver=str(solver), grid=str(grid),
                      solver_sha256=digest(solver), grid_sha256=digest(grid))
    except (OSError, ValueError) as exc:
        result.update(available=False, reason=str(exc))
    return result


def validate_case(mesh_size, dimensions=DIMENSIONS_M, physics="pec_rectangular_cavity_benchmark"):
    if physics != "pec_rectangular_cavity_benchmark" or tuple(dimensions) != DIMENSIONS_M:
        raise ValueError("Only the fixed lossless PEC rectangular cavity benchmark is supported")
    if not math.isfinite(mesh_size) or mesh_size not in MESH_SIZES_M:
        raise ValueError(f"mesh-size must be one of {MESH_SIZES_M} metres")


def inputs(mesh_size):
    """Generate bounded benchmark input, following Elmer's EMWaveBoxHexasEigen formulation."""
    validate_case(mesh_size)
    grid = f'''Version = 210903
Coordinate System = Cartesian 3D
Subcell Divisions in 3D = 1 1 1
Subcell Limits 1 = 0 0.1
Subcell Limits 2 = 0 0.05
Subcell Limits 3 = 0 0.2
Materials Interval = 1 1
Boundary Definitions
 1 -3 1 1
 2 -4 1 1
 3 -1 1 1
 4 -2 1 1
End
Numbering = Horizontal
Element Degree = 1
Element Innernodes = Logical False
Triangles = Logical False
Minimum Element Divisions = 1
Element Ratios 1 = 1
Element Ratios 2 = 1
Element Ratios 3 = 1
Element Densities 1 = 1
Element Densities 2 = 1
Element Densities 3 = 1
Reference Density = {mesh_size}
'''
    sif = '''Header
 Mesh DB "." "cavity"
End
Simulation
 Coordinate System = Cartesian
 Simulation Type = Steady State
 Steady State Max Iterations = 1
 Max Output Level = 5
End
Constants
 Permittivity of Vacuum = 1
 Permeability of Vacuum = 1
End
Body 1
 Equation = 1
 Material = 1
End
Material 1
 Relative Permittivity = 1
 Relative Permeability = 1
End
Equation 1
 Active Solvers(3) = 1 2 3
End
Solver 1
 Equation = VectorWave
 Variable = E
 Procedure = "EMWaveSolver" "EMWaveSolver"
 Linear System Solver = Direct
 Linear System Direct Method = umfpack
 Use Global Mass Matrix = Logical True
 Eigen Analysis = Logical True
 Eigen System Values = 2
 Eigen System Convergence Tolerance = 0
 Eigen System Select = smallest magnitude
 Eigen System Shift = Real 1.5e3
End
Solver 2
 Equation = calcfields
 Procedure = "EMWaveSolver" "EMWaveCalcFields"
 Calculate Elemental Fields = Logical False
 Calculate Nodal Fields = Logical True
 Linear System Solver = Direct
 Linear System Direct Method = umfpack
 Calculate Electric field derivatives = Logical True
 Exec Solver = String "before saving"
End
Solver 3
 Equation = save scalars
 Procedure = "SaveData" "SaveScalars"
 Save Eigenfrequencies = Logical True
 Filename = eigen.dat
 Exec Solver = String "after saving"
End
Solver 4
 Equation = result output
 Procedure = "ResultOutputSolve" "ResultOutputSolver"
 Output File Name = mode
 Vtu Format = Logical True
 Save Bulk Only = Logical True
 Eigen Analysis = Logical True
 Eigen Vector Component = String "complex"
 Exec Solver = String "after saving"
End
Boundary Condition 1
 Target Boundaries(6) = 1 2 3 4 5 6
 E {e} = Real 0
End
'''
    return grid, sif


def read_mode(path):
    """Read only Elmer's uncompressed little-endian raw-appended Float64 VTU layout."""
    path = Path(path)
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Benchmark VTU exceeds 16 MiB limit")
    raw = path.read_bytes()
    marker = b'<AppendedData encoding="raw">'
    start = raw.find(marker)
    if start < 0:
        raise ValueError("Unsupported VTU: raw appended data required")
    offset = raw.find(b"_", start) + 1
    head = raw[:start].decode("utf-8")
    if 'byte_order="LittleEndian"' not in head or "compressor=" in head or 'header_type="UInt64"' in head:
        raise ValueError("Unsupported VTU byte order, compression or header width")
    count_match = re.search(r'NumberOfPoints="(\d+)"', head)
    if not count_match:
        raise ValueError("Missing VTU point count")
    count = int(count_match[1])
    if count < 1 or count > 10000:
        raise ValueError("Invalid benchmark point count")
    fields = {}
    for tag in re.findall(r"<DataArray[^>]+>", head):
        if 'type="Float64"' not in tag:
            continue
        if 'format="appended"' not in tag or 'NumberOfComponents="3"' not in tag:
            raise ValueError("Unsupported VTU field layout")
        match = re.search(r'offset="(\d+)"', tag)
        if not match:
            raise ValueError("Missing VTU array offset")
        location = offset + int(match[1])
        if location + 4 > len(raw):
            raise ValueError("Truncated VTU header")
        size = struct.unpack_from("<I", raw, location)[0]
        if size != count * 3 * 8 or location + 4 + size > len(raw):
            raise ValueError("Truncated or inconsistent VTU array")
        values = struct.unpack_from("<" + "d" * (size // 8), raw, location + 4)
        if not all(math.isfinite(v) for v in values):
            raise ValueError("Non-finite VTU values")
        name = re.search(r'Name="([^"]+)"', tag)
        fields[name[1] if name else "points"] = values
    if not {"points", "elfield", "elfield Im"}.issubset(fields):
        raise ValueError("Missing cavity coordinates or complex electric field")
    return fields


def assess(frequencies, fields):
    if len(frequencies) != 2 or any(not math.isfinite(f) or f <= 0 for f in frequencies):
        raise ValueError("Expected two finite positive geometric eigenfrequencies")
    if frequencies[0] >= frequencies[1]:
        raise ValueError("Unordered cavity eigenfrequencies")
    a, _, d = DIMENSIONS_M
    expected = .5 * math.sqrt(a ** -2 + d ** -2)
    target = []
    points = fields["points"]
    for x, y, z in zip(points[0::3], points[1::3], points[2::3]):
        if not (-1e-12 <= x <= a + 1e-12 and -1e-12 <= y <= .05 + 1e-12 and -1e-12 <= z <= d + 1e-12):
            raise ValueError("Coordinates fall outside the specified cavity")
        target.extend((0., math.sin(math.pi * x / a) * math.sin(math.pi * z / d), 0.))
    if not target or sum(v*v for v in target) == 0:
        raise ValueError("No interior samples to validate mode shape")
    correlations = {}
    for name in ("elfield", "elfield Im"):
        field = fields[name]
        if len(field) != len(target) or any(not math.isfinite(v) for v in field):
            raise ValueError("Invalid electric field samples")
        norm = math.sqrt(sum(v*v for v in field) * sum(v*v for v in target))
        correlations[name] = abs(sum(v*t for v, t in zip(field, target))) / norm if norm else 0.
    error = abs(frequencies[0] / expected - 1)
    real, imag = fields["elfield"], fields["elfield Im"]
    total = math.sqrt((sum(v*v for v in real) + sum(v*v for v in imag)) * sum(v*v for v in target))
    projection = math.hypot(sum(v*t for v, t in zip(real, target)), sum(v*t for v, t in zip(imag, target)))
    complex_correlation = projection / total if total else 0.
    passed = error < .03 and complex_correlation > .98
    return {"status": "results_validated" if passed else "validation_failed",
            "frequency_hz": [f*C0 for f in frequencies], "geometric_frequency_per_m": frequencies,
            "mode1": {"family": "TE101 (z axis)", "analytic_frequency_hz": expected*C0,
                      "relative_frequency_error": error, "field_shape_correlation": correlations,
                      "complex_field_shape_correlation": complex_correlation},
            "criteria": {"relative_frequency_error_max": .03, "field_shape_correlation_min": .98},
            "precision_converged": False, "s_parameters": None, "qualifies_driven_antenna": False}


def parse_results(case):
    case = Path(case)
    values = (case / "eigen.dat").read_text().split()
    return assess([float(v.replace("D", "E")) for v in values], read_mode(case / "cavity/mode_t0001.vtu"))


def run_cavity(out, *, root=None, mesh_size=.025, experimental=False):
    if not experimental:
        raise ValueError("Explicit --experimental opt-in is required")
    validate_case(mesh_size)
    home, solver, grid = discover(root)
    case = Path(out).expanduser().resolve()
    case.mkdir(parents=True, exist_ok=False)
    manifest = {"schema": "fairbeam-elmer-benchmark-1", "backend": "elmer-experimental",
                "physics": "pec_rectangular_cavity_benchmark", "dimensions_m": DIMENSIONS_M,
                "mesh_size_m": mesh_size, "threads": 1, "status": "inputs_generated",
                "created_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "input_provenance": "assumed vacuum PEC box; derived analytic TE101 control",
                "normalization": "epsilon0=mu0=1; sqrt(lambda)/(2*pi) in 1/m; multiply by c0 for Hz",
                "solver": str(solver), "solver_sha256": digest(solver), "grid_sha256": digest(grid),
                "generator_sha256": digest(__file__)}
    def save():
        (case / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    grd, sif = inputs(mesh_size)
    (case / "cavity.grd").write_text(grd, encoding="utf-8")
    (case / "case.sif").write_text(sif, encoding="utf-8")
    manifest["input_sha256"] = {p: digest(case / p) for p in ("cavity.grd", "case.sif")}
    save()
    env = os.environ.copy()
    env.update(ELMER_HOME=str(home), OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1",
               PATH=str(solver.parent) + os.pathsep + env.get("PATH", ""))
    try:
        for executable, arguments, name in ((grid, ["1", "2", "cavity.grd"], "mesh"),
                                             (solver, ["case.sif"], "solver")):
            manifest["status"] = name + "_started"
            save()
            start = time.monotonic()
            flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            try:
                process = subprocess.run([str(executable), *arguments], cwd=case, env=env,
                                         stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT, text=True, timeout=55,
                                         creationflags=flags)
            except subprocess.TimeoutExpired as exc:
                output = exc.stdout or ""
                if isinstance(output, bytes):
                    output = output.decode("utf-8", "replace")
                (case / (name + ".log")).write_text(output, encoding="utf-8")
                raise RuntimeError(f"{name} exceeded 55 second limit") from exc
            (case / (name + ".log")).write_text(process.stdout, encoding="utf-8")
            manifest[name + "_seconds"] = time.monotonic() - start
            manifest[name + "_exit_code"] = process.returncode
            if process.returncode or (name == "solver" and "ALL DONE" not in process.stdout):
                raise RuntimeError(f"{name} failed; inspect {name}.log")
            if name == "solver" and re.search(r"WARNING::.*FAILED|FATAL|ERROR::", process.stdout):
                raise RuntimeError("Solver reported a failure despite successful exit")
            if name == "solver":
                version = re.search(r"MAIN: Version: (.+)", process.stdout)
                manifest["solver_version"] = version[1].strip() if version else "unreported"
            manifest["status"] = "model_built" if name == "mesh" else "solver_returned"
            save()
        result = parse_results(case)
        result["raw_sha256"] = {p: digest(case / p) for p in ("eigen.dat", "cavity/mode_t0001.vtu")}
        (case / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        manifest["status"] = result["status"]
        save()
        if result["status"] != "results_validated":
            raise ValueError("Cavity reference criteria failed; raw output retained")
        return result
    except BaseException as exc:
        if manifest["status"] != "validation_failed":
            manifest["status"] = "interrupted" if isinstance(exc, KeyboardInterrupt) else "failed"
        manifest["error"] = str(exc)
        save()
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", help="external native Elmer installation root (or FAIRBEAM_ELMER_ROOT)")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("capabilities", help="discover binaries without running them")
    cavity = commands.add_parser("cavity", help="run the fixed vacuum PEC cavity benchmark")
    cavity.add_argument("--experimental", action="store_true", help="explicitly opt into research execution")
    cavity.add_argument("--out", type=Path, required=True, help="fresh output directory")
    cavity.add_argument("--mesh-size", type=float, choices=MESH_SIZES_M, default=.025, metavar="METRES")
    args = parser.parse_args(argv)
    try:
        result = capabilities(args.root) if args.command == "capabilities" else run_cavity(
            args.out, root=args.root, mesh_size=args.mesh_size, experimental=args.experimental)
    except (OSError, ValueError, RuntimeError) as exc:
        parser.exit(2, f"fairbeam-elmer: {exc}\n")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
