"""Opt-in homogeneous-dielectric Elmer eigenmode qualification.

This bounded study exercises the experimental structured-mesh exporter and the native Elmer
Maxwell eigenmode solver. It covers only a rectangular, fully filled PEC cavity with eps_r=1 or 4
and two fixed mesh sizes. It does not solve driven ports or qualify antenna analysis.
"""

from __future__ import annotations

import datetime
from bisect import bisect_left
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
from typing import Callable

C0 = 299_792_458.0
DIMENSIONS_M = (0.1, 0.05, 0.2)
DIMENSIONS_MM = tuple(value * 1000.0 for value in DIMENSIONS_M)
EPS_R_VALUES = (1.0, 4.0)
MESH_SIZES_MM = (25.0, 12.5)
VACUUM_EIGEN_SHIFT = 1500.0
TIMEOUT_SECONDS = 55.0
MAX_LOG_BYTES = 8 * 1024 * 1024
MAX_EIGEN_FILE_BYTES = 1024 * 1024
MAX_VTU_BYTES = 16 * 1024 * 1024
MAX_VTU_POINTS = 10_000
MODE_COORDINATE_TOLERANCE_M = 1e-12

CRITERIA = {
    "coarse_relative_frequency_error_max": 0.03,
    "fine_relative_frequency_error_max": 0.01,
    "mode_shape_correlation_min_exclusive": 0.98,
    "same_mesh_eps4_to_eps1_ratio": 0.5,
    "same_mesh_ratio_relative_error_max_exclusive": 1e-6,
    "fine_error_less_than_coarse": True,
}


class FEMQualificationError(RuntimeError):
    """A bounded qualification input, execution, or result check failed."""


def digest(path: str | Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n",
                    encoding="utf-8", newline="\n")


def _source_provenance() -> dict:
    package = Path(__file__).resolve().parent
    files = {}
    for path in sorted(package.glob("*.py")):
        files[path.name] = {"sha256": digest(path), "bytes": path.stat().st_size}
    provenance = {
        "source_files": files,
        "source_file_count": len(files),
        "platform": {"system": platform.system(), "release": platform.release(),
                     "machine": platform.machine(), "platform": platform.platform()},
        "python_version": platform.python_version(),
        "captured_utc": _utc_now(),
    }
    repo_root = Path(__file__).resolve().parents[2]
    git = shutil.which("git")
    if not git:
        provenance["git"] = {"available": False}
        return provenance
    try:
        commit = subprocess.run([git, "rev-parse", "HEAD"], cwd=repo_root, check=True,
                                capture_output=True, text=True, timeout=5).stdout.strip()
        status = subprocess.run([git, "status", "--short", "--untracked-files=all"],
                                cwd=repo_root, check=True, capture_output=True,
                                text=True, timeout=5).stdout
        diff = subprocess.run([git, "diff", "--binary", "HEAD"], cwd=repo_root,
                              check=True, capture_output=True, timeout=5).stdout
        provenance["git"] = {
            "base_commit": commit,
            "dirty": bool(status.strip()),
            "status_sha256": hashlib.sha256(status.encode("utf-8")).hexdigest(),
            "tracked_diff_sha256": hashlib.sha256(diff).hexdigest(),
        }
    except (OSError, subprocess.SubprocessError):
        provenance["git"] = {"available": False}
    return provenance


def _case_key(eps_r: float, mesh_size_mm: float) -> str:
    return f"epsr-{int(eps_r)}-h-{str(mesh_size_mm).replace('.', 'p')}mm"


def _validate_case_values(eps_r: float, mesh_size_mm: float) -> None:
    try:
        eps_value = float(eps_r)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"eps_r must be one of {EPS_R_VALUES}") from None
    if isinstance(eps_r, bool) or not math.isfinite(eps_value) or eps_value not in EPS_R_VALUES:
        raise ValueError(f"eps_r must be one of {EPS_R_VALUES}")
    try:
        mesh_value = float(mesh_size_mm)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"mesh size must be one of {MESH_SIZES_MM} mm") from None
    if (isinstance(mesh_size_mm, bool) or not math.isfinite(mesh_value)
            or mesh_value not in MESH_SIZES_MM):
        raise ValueError(f"mesh size must be one of {MESH_SIZES_MM} mm")


def analytic_frequency_per_m(eps_r: float) -> float:
    """Exact normalized TE101 frequency for the fixed homogeneous PEC cavity, in 1/m."""
    _validate_case_values(eps_r, MESH_SIZES_MM[0])
    a, _, d = DIMENSIONS_M
    return 0.5 * math.sqrt(a ** -2 + d ** -2) / math.sqrt(float(eps_r))


def _benchmark_design(eps_r: float) -> dict:
    from .design import blank_design

    design = blank_design("fem-homogeneous-dielectric-cavity", "FEM qualification cavity")
    design["materials"] = [{
        "name": "benchmark_fill", "kind": "dielectric", "eps_r": float(eps_r),
        "mu_r": 1.0, "tan_d": 0,
    }]
    design["parts"] = [{
        "name": "cavity_fill", "material": "benchmark_fill", "primitives": [{
            "kind": "box", "start": [0.0, 0.0, 0.0], "stop": list(DIMENSIONS_MM),
        }],
    }]
    design["ports"] = []
    design["resistors"] = []
    return design


def _build_sif(active_body_id: int, eps_r: float) -> str:
    if active_body_id != 2:
        raise FEMQualificationError(
            f"Expected the fully assigned dielectric to map to body 2, got {active_body_id}"
        )
    shift = VACUUM_EIGEN_SHIFT / float(eps_r)
    return f'''Header
  Mesh DB "." "mesh"
End
Simulation
  Coordinate System = "Cartesian"
  Simulation Type = Steady State
  Steady State Max Iterations = 1
  Max Output Level = 5
End
Constants
  Permittivity of Vacuum = 1
  Permeability of Vacuum = 1
End
Body 1
  Target Bodies(1) = {active_body_id}
  Equation = 1
  Material = 1
End
Material 1
  Relative Permittivity = {float(eps_r):.17g}
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
  Eigen System Shift = Real {shift:.17g}
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
  E {{e}} = Real 0
End
'''


def _new_study_directory(out: str | Path) -> Path:
    study = Path(out).expanduser().resolve()
    study.mkdir(parents=True, exist_ok=False)
    return study


def prepare_study(out: str | Path) -> dict:
    """Write four deterministic cases without locating or launching a solver."""
    study = _new_study_directory(out)
    manifest = {
        "schema": "fairbeam.elmer-fem-qualification/1",
        "backend": "elmer-experimental",
        "physics": "uniform_dielectric_pec_cavity_eigenmode",
        "status": "preparing_inputs",
        "solver_executed": False,
        "created_utc": _utc_now(),
        "dimensions_m": list(DIMENSIONS_M),
        "relative_permeability": 1.0,
        "eps_r_values": list(EPS_R_VALUES),
        "mesh_sizes_mm": list(MESH_SIZES_MM),
        "case_order": [],
        "criteria": CRITERIA,
        "driven_ports": False,
        "s_parameters": None,
        "qualifies_driven_antenna": False,
        "source_sha256": {
            "qualification_module": digest(__file__),
            "geometry_exporter": digest(Path(__file__).with_name("fem_geometry.py")),
        },
        "source_provenance": _source_provenance(),
    }
    manifest_path = study / "manifest.json"
    _write_json(manifest_path, manifest)
    cases = []
    try:
        from .fem_geometry import mesh_design, write_elmer_mesh

        for eps_r in EPS_R_VALUES:
            for mesh_size_mm in MESH_SIZES_MM:
                name = _case_key(eps_r, mesh_size_mm)
                case = study / name
                case.mkdir()
                mesh = mesh_design(
                    _benchmark_design(eps_r), domain_mm=(0.0, 0.0, 0.0, *DIMENSIONS_MM),
                    max_cell_mm=mesh_size_mm,
                )
                active_bodies = sorted({body_id for body_id, _ in mesh.elements})
                if active_bodies != [2]:
                    raise FEMQualificationError(
                        f"{name}: expected exactly active body ID 2, got {active_bodies}"
                    )
                mesh_metadata = write_elmer_mesh(mesh, case / "mesh")
                sif_path = case / "case.sif"
                sif_path.write_text(_build_sif(active_bodies[0], eps_r),
                                    encoding="ascii", newline="\n")
                case_manifest = {
                    "schema": "fairbeam.elmer-fem-qualification-case/1",
                    "status": "inputs_ready",
                    "solver_executed": False,
                    "stage_history": [{"stage": "inputs_ready", "utc": _utc_now()}],
                    "case": name,
                    "physics": manifest["physics"],
                    "eps_r": eps_r,
                    "mu_r": 1.0,
                    "dimensions_m": list(DIMENSIONS_M),
                    "mesh_size_mm": mesh_size_mm,
                    "active_body_ids": active_bodies,
                    "body_material_map": {str(body_id): 1 for body_id in active_bodies},
                    "sif_body_records": [{"sif_body_id": 1,
                                           "target_mesh_body_ids": active_bodies,
                                           "equation_id": 1, "material_id": 1}],
                    "mesh_summary": mesh.summary(),
                    "mesh_metadata_sha256": digest(case / "mesh" / "mesh.metadata.json"),
                    "input_sha256": {
                        "case.sif": digest(sif_path),
                        **{f"mesh/{file_name}": record["sha256"]
                           for file_name, record in mesh_metadata["files"].items()},
                    },
                }
                _write_json(case / "manifest.json", case_manifest)
                cases.append({"case": name, "path": name, "eps_r": eps_r,
                              "mesh_size_mm": mesh_size_mm,
                              "hexahedron_count": len(mesh.elements),
                              "node_count": len(mesh.nodes),
                              "active_body_ids": active_bodies})
                manifest["case_order"].append(name)
                manifest["cases"] = cases
                _write_json(manifest_path, manifest)
        manifest["status"] = "inputs_ready"
        _write_json(manifest_path, manifest)
        return manifest
    except BaseException as exc:
        manifest["status"] = "input_generation_failed"
        manifest["error"] = str(exc)
        manifest["cases"] = cases
        _write_json(manifest_path, manifest)
        raise


def discover_solver(root: str | Path | None = None) -> tuple[Path, Path]:
    """Locate one existing native ElmerSolver without running or installing it."""
    root = root or os.environ.get("FAIRBEAM_ELMER_ROOT")
    suffix = ".exe" if os.name == "nt" else ""
    if root:
        directory = Path(root).expanduser().resolve()
        bindir = directory / "bin" if (directory / "bin").is_dir() else directory
        home = bindir.parent if bindir.name.lower() == "bin" else directory
        solver = bindir / ("ElmerSolver" + suffix)
    else:
        found = shutil.which("ElmerSolver" + suffix)
        if not found:
            raise FileNotFoundError(
                "Set FAIRBEAM_ELMER_ROOT or --root to an existing native Elmer package"
            )
        solver = Path(found).resolve()
        home = solver.parent.parent if solver.parent.name.lower() == "bin" else solver.parent
    if not solver.is_file() or (os.name != "nt" and not os.access(solver, os.X_OK)):
        raise FileNotFoundError(f"Native ElmerSolver unavailable: {solver}")
    return home, solver


def capabilities(root: str | Path | None = None) -> dict:
    result = {
        "backend": "elmer-experimental",
        "platform": platform.system(),
        "machine": platform.machine(),
        "physics": ["uniform_dielectric_pec_cavity_eigenmode"],
        "driven_ports": False,
        "radiation": False,
        "s_parameters": False,
        "solver_executed": False,
    }
    try:
        home, solver = discover_solver(root)
        result.update(available=True, root=str(home), solver=str(solver),
                      solver_sha256=digest(solver))
    except (OSError, ValueError) as exc:
        result.update(available=False, reason=str(exc))
    return result


def _read_eigenvalues(path: Path) -> list[float]:
    if not path.is_file() or path.stat().st_size > MAX_EIGEN_FILE_BYTES:
        raise FEMQualificationError("eigen.dat is missing or exceeds the 1 MiB limit")
    try:
        tokens = path.read_text(encoding="ascii").replace("D", "E").split()
        values = [float(token) for token in tokens]
    except (UnicodeError, ValueError):
        raise FEMQualificationError("eigen.dat contains an invalid numeric value") from None
    if len(values) != 2 or any(not math.isfinite(value) or value <= 0 for value in values):
        raise FEMQualificationError("expected exactly two finite positive eigenfrequency values")
    if values[0] >= values[1]:
        raise FEMQualificationError("eigenfrequency values are not strictly increasing")
    return values


def read_mode(path: str | Path) -> dict[str, tuple[float, ...]]:
    """Read the uncompressed little-endian Float64 raw-appended VTU output used by Elmer."""
    path = Path(path)
    if not path.is_file() or path.stat().st_size > MAX_VTU_BYTES:
        raise FEMQualificationError("VTU mode file is missing or exceeds the 16 MiB limit")
    raw = path.read_bytes()
    marker = b'<AppendedData encoding="raw">'
    start = raw.find(marker)
    if start < 0:
        raise FEMQualificationError("unsupported VTU output: raw appended data is required")
    underscore = raw.find(b"_", start + len(marker))
    if underscore < 0:
        raise FEMQualificationError("VTU raw appended data marker is missing")
    try:
        header = raw[:start].decode("utf-8")
    except UnicodeDecodeError:
        raise FEMQualificationError("VTU XML header is invalid UTF-8") from None
    if ("byte_order=\"LittleEndian\"" not in header or "compressor=" in header
            or 'header_type="UInt64"' in header):
        raise FEMQualificationError("unsupported VTU byte order, compression, or header width")
    count_match = re.search(r'NumberOfPoints="(\d+)"', header)
    if not count_match:
        raise FEMQualificationError("VTU is missing its point count")
    count = int(count_match[1])
    if count < 1 or count > MAX_VTU_POINTS:
        raise FEMQualificationError("VTU point count is outside the 1..10000 limit")
    fields: dict[str, tuple[float, ...]] = {}
    for tag in re.findall(r"<DataArray[^>]+>", header):
        if 'type="Float64"' not in tag:
            continue
        if 'format="appended"' not in tag or 'NumberOfComponents="3"' not in tag:
            raise FEMQualificationError("unsupported VTU field layout")
        offset_match = re.search(r'offset="(\d+)"', tag)
        if not offset_match:
            raise FEMQualificationError("VTU array is missing its offset")
        location = underscore + 1 + int(offset_match[1])
        if location + 4 > len(raw):
            raise FEMQualificationError("VTU array header is truncated")
        size = struct.unpack_from("<I", raw, location)[0]
        if size != count * 3 * 8 or location + 4 + size > len(raw):
            raise FEMQualificationError("VTU field array size is inconsistent or truncated")
        values = struct.unpack_from("<" + "d" * (size // 8), raw, location + 4)
        if any(not math.isfinite(value) for value in values):
            raise FEMQualificationError("VTU field contains a non-finite value")
        name_match = re.search(r'Name="([^"]+)"', tag)
        name = name_match[1] if name_match else "points"
        fields[name] = values
    if not {"points", "elfield", "elfield Im"}.issubset(fields):
        raise FEMQualificationError("VTU mode is missing coordinates or complex electric field")
    return fields


def assess_case(eigenvalues: list[float], fields: dict[str, tuple[float, ...]],
                eps_r: float, mesh_size_mm: float) -> dict:
    """Compare one case's lowest eigenmode with the analytic TE101 cavity solution."""
    _validate_case_values(eps_r, mesh_size_mm)
    if len(eigenvalues) != 2 or any(not math.isfinite(v) or v <= 0 for v in eigenvalues):
        raise FEMQualificationError("expected exactly two finite positive eigenfrequency values")
    if eigenvalues[0] >= eigenvalues[1]:
        raise FEMQualificationError("eigenfrequency values are not strictly increasing")
    required = {"points", "elfield", "elfield Im"}
    if not required.issubset(fields):
        raise FEMQualificationError("mode fields are missing coordinates or complex electric field")
    points, real, imag = fields["points"], fields["elfield"], fields["elfield Im"]
    if (not points or len(points) % 3 or len(real) != len(points) or len(imag) != len(points)
            or any(not math.isfinite(v) for values in (points, real, imag) for v in values)):
        raise FEMQualificationError("mode coordinates and fields have invalid or non-finite values")
    a, b, d = DIMENSIONS_M
    target = []
    for x, y, z in zip(points[0::3], points[1::3], points[2::3]):
        if not (-1e-12 <= x <= a + 1e-12 and -1e-12 <= y <= b + 1e-12
                and -1e-12 <= z <= d + 1e-12):
            raise FEMQualificationError("VTU coordinates fall outside the specified cavity")
        target.extend((0.0, math.sin(math.pi * x / a) * math.sin(math.pi * z / d), 0.0))
    target_norm_squared = math.fsum(value * value for value in target)
    field_norm_squared = math.fsum(value * value for value in real) + math.fsum(value * value for value in imag)
    if target_norm_squared <= 0 or field_norm_squared <= 0:
        raise FEMQualificationError("mode or analytic TE101 field has zero norm")
    projection_real = math.fsum(value * expected for value, expected in zip(real, target))
    projection_imag = math.fsum(value * expected for value, expected in zip(imag, target))
    correlation = math.hypot(projection_real, projection_imag) / math.sqrt(
        field_norm_squared * target_norm_squared
    )

    expected_per_m = analytic_frequency_per_m(eps_r)
    relative_error = abs(eigenvalues[0] / expected_per_m - 1.0)
    error_limit = (CRITERIA["coarse_relative_frequency_error_max"] if mesh_size_mm == 25.0
                   else CRITERIA["fine_relative_frequency_error_max"])
    passed = (relative_error < error_limit
              and correlation > CRITERIA["mode_shape_correlation_min_exclusive"])
    return {
        "schema": "fairbeam.elmer-fem-qualification-case-result/1",
        "status": "case_validated" if passed else "validation_failed",
        "physics": "uniform_dielectric_pec_cavity_eigenmode",
        "mode_family": "TE101 (z axis)",
        "eps_r": float(eps_r),
        "mu_r": 1.0,
        "mesh_size_mm": float(mesh_size_mm),
        "geometric_frequency_per_m": list(eigenvalues),
        "frequency_hz": [value * C0 for value in eigenvalues],
        "analytic_frequency_hz": expected_per_m * C0,
        "relative_frequency_error": relative_error,
        "complex_field_shape_correlation": correlation,
        "criteria": {"relative_frequency_error_max_exclusive": error_limit,
                     "complex_field_shape_correlation_min_exclusive":
                         CRITERIA["mode_shape_correlation_min_exclusive"]},
        "precision_converged": False,
        "s_parameters": None,
        "qualifies_driven_antenna": False,
    }


def validate_mode_coverage(fields: dict[str, tuple[float, ...]], mesh_nodes_path: str | Path,
                           expected_node_count: int) -> dict:
    """Require the complete prepared node set, allowing output order and SI roundoff."""
    points = fields.get("points", ())
    if (not 1 <= expected_node_count <= MAX_VTU_POINTS
            or len(points) != 3 * expected_node_count
            or any(not math.isfinite(value) for value in points)):
        raise FEMQualificationError("VTU point count does not match the prepared mesh or is non-finite")
    node_path = Path(mesh_nodes_path)
    if not node_path.is_file() or node_path.stat().st_size > MAX_VTU_BYTES:
        raise FEMQualificationError("prepared mesh.nodes is missing or exceeds the size limit")
    try:
        rows = [line.split() for line in node_path.read_text(encoding="ascii").splitlines()]
        if len(rows) != expected_node_count or any(len(row) != 5 for row in rows):
            raise FEMQualificationError("prepared mesh.nodes does not match its node count")
        expected = [tuple(float(value) for value in row[2:]) for row in rows]
    except (UnicodeError, ValueError):
        raise FEMQualificationError("prepared mesh.nodes contains invalid coordinates") from None
    if (any(not math.isfinite(value) for point in expected for value in point)
            or len(set(expected)) != expected_node_count):
        raise FEMQualificationError("prepared mesh.nodes has non-finite or duplicate coordinates")

    # Canonicalize to the nearest prepared axis coordinate before sorting. This
    # avoids changing lexicographic order when equal coordinates differ only by
    # roundoff, while refusing duplicates within the declared tolerance.
    axes = [sorted({point[axis] for point in expected}) for axis in range(3)]
    actual = []
    for offset in range(0, len(points), 3):
        canonical = []
        for axis, value in enumerate(points[offset:offset + 3]):
            values = axes[axis]
            index = bisect_left(values, value)
            candidates = values[max(0, index - 1):min(len(values), index + 1)]
            nearest = min(candidates, key=lambda candidate: abs(value - candidate))
            if abs(value - nearest) > MODE_COORDINATE_TOLERANCE_M:
                raise FEMQualificationError("VTU coordinates do not match the prepared mesh")
            canonical.append(nearest)
        actual.append(tuple(canonical))
    if len(set(actual)) != expected_node_count:
        raise FEMQualificationError("VTU contains duplicate prepared-node coordinates")
    if sorted(actual) != sorted(expected):
        raise FEMQualificationError("VTU coordinate set does not match the prepared mesh")
    return {"point_count": expected_node_count,
            "coordinate_tolerance_m": MODE_COORDINATE_TOLERANCE_M,
            "matches_prepared_mesh": True}


def assess_study(case_results: list[dict]) -> dict:
    expected_keys = {_case_key(eps_r, mesh_size) for eps_r in EPS_R_VALUES
                     for mesh_size in MESH_SIZES_MM}
    if len(case_results) != len(expected_keys):
        raise FEMQualificationError("study result must contain exactly four cases")
    keys = [_case_key(float(result["eps_r"]), float(result["mesh_size_mm"]))
            for result in case_results]
    if len(set(keys)) != len(keys):
        raise FEMQualificationError("study result contains duplicate cases")
    by_key = dict(zip(keys, case_results))
    if set(by_key) != expected_keys:
        raise FEMQualificationError("study result does not contain the four required unique cases")

    scaling = []
    for mesh_size in MESH_SIZES_MM:
        vacuum = by_key[_case_key(1.0, mesh_size)]["geometric_frequency_per_m"][0]
        dielectric = by_key[_case_key(4.0, mesh_size)]["geometric_frequency_per_m"][0]
        ratio = dielectric / vacuum
        ratio_error = abs(ratio / CRITERIA["same_mesh_eps4_to_eps1_ratio"] - 1.0)
        scaling.append({"mesh_size_mm": mesh_size, "eps4_to_eps1_frequency_ratio": ratio,
                        "expected_ratio": 0.5, "relative_ratio_error": ratio_error,
                        "passed": ratio_error <
                                 CRITERIA["same_mesh_ratio_relative_error_max_exclusive"]})

    refinement = []
    for eps_r in EPS_R_VALUES:
        coarse_error = by_key[_case_key(eps_r, MESH_SIZES_MM[0])]["relative_frequency_error"]
        fine_error = by_key[_case_key(eps_r, MESH_SIZES_MM[1])]["relative_frequency_error"]
        refinement.append({"eps_r": eps_r, "coarse_relative_error": coarse_error,
                           "fine_relative_error": fine_error,
                           "error_decreased": fine_error < coarse_error})
    cases_passed = all(result["status"] == "case_validated" for result in case_results)
    passed = (cases_passed and all(record["passed"] for record in scaling)
              and all(record["error_decreased"] for record in refinement))
    return {
        "schema": "fairbeam.elmer-fem-qualification-result/1",
        "status": "study_validated" if passed else "validation_failed",
        "physics": "uniform_dielectric_pec_cavity_eigenmode",
        "case_count": len(case_results),
        "case_results": case_results,
        "same_mesh_scaling": scaling,
        "refinement": refinement,
        "criteria": CRITERIA,
        "precision_converged": False,
        "driven_ports": False,
        "radiation": False,
        "s_parameters": None,
        "qualifies_driven_antenna": False,
    }


def _terminate(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=2.0)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2.0)


def _run_solver(solver: Path, home: Path, case: Path, *, timeout_seconds: float = TIMEOUT_SECONDS,
                max_log_bytes: int = MAX_LOG_BYTES,
                on_started: Callable[[], None] | None = None) -> tuple[int, float, str]:
    """Run one solver case with bounded wall time and log size, retaining its log on all exits."""
    log_path = case / "solver.log"
    env = os.environ.copy()
    env.update(ELMER_HOME=str(home), OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1",
               MKL_NUM_THREADS="1", NUMEXPR_NUM_THREADS="1",
               PATH=str(solver.parent) + os.pathsep + env.get("PATH", ""))
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    start = time.monotonic()
    with log_path.open("wb") as stream:
        process = subprocess.Popen([str(solver), "case.sif"], cwd=case, env=env,
                                   stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT,
                                   creationflags=flags)
        try:
            if on_started is not None:
                on_started()
            while process.poll() is None:
                stream.flush()
                if log_path.stat().st_size > max_log_bytes:
                    _terminate(process)
                    raise FEMQualificationError(
                        f"solver log exceeded {max_log_bytes} byte limit; inspect solver.log"
                    )
                elapsed = time.monotonic() - start
                if elapsed > timeout_seconds:
                    _terminate(process)
                    raise FEMQualificationError(
                        f"solver exceeded {timeout_seconds:g} second limit; inspect solver.log"
                    )
                time.sleep(min(0.1, max(0.001, timeout_seconds - elapsed)))
            stream.flush()
            if log_path.stat().st_size > max_log_bytes:
                raise FEMQualificationError(
                    f"solver log exceeded {max_log_bytes} byte limit; inspect solver.log"
                )
        except BaseException:
            _terminate(process)
            stream.flush()
            raise
    text = log_path.read_text(encoding="utf-8", errors="replace")
    return process.returncode, time.monotonic() - start, text


def run_study(out: str | Path, *, root: str | Path | None = None,
              experimental: bool = False) -> dict:
    """Run the four bounded cases sequentially; explicit research opt-in is required."""
    if not experimental:
        raise ValueError("Explicit --experimental opt-in is required")
    home, solver = discover_solver(root)
    study = _new_study_directory(out)
    manifest_path = study / "manifest.json"
    manifest = {
        "schema": "fairbeam.elmer-fem-qualification/1",
        "backend": "elmer-experimental",
        "physics": "uniform_dielectric_pec_cavity_eigenmode",
        "status": "preparing_inputs",
        "solver_executed": False,
        "created_utc": _utc_now(),
        "stage_history": [{"stage": "preparing_inputs", "utc": _utc_now()}],
        "dimensions_m": list(DIMENSIONS_M),
        "relative_permeability": 1.0,
        "eps_r_values": list(EPS_R_VALUES),
        "mesh_sizes_mm": list(MESH_SIZES_MM),
        "case_order": [],
        "criteria": CRITERIA,
        "solver": str(solver),
        "solver_sha256": digest(solver),
        "solver_timeout_seconds": TIMEOUT_SECONDS,
        "max_solver_log_bytes": MAX_LOG_BYTES,
        "threads": 1,
        "driven_ports": False,
        "s_parameters": None,
        "qualifies_driven_antenna": False,
        "source_sha256": {
            "qualification_module": digest(__file__),
            "geometry_exporter": digest(Path(__file__).with_name("fem_geometry.py")),
        },
        "source_provenance": _source_provenance(),
        "cases": [],
    }
    _write_json(manifest_path, manifest)
    result_records = []
    try:
        prepared = prepare_study(study / "inputs")
        manifest["status"] = "inputs_ready"
        manifest["case_order"] = list(prepared["case_order"])
        manifest["cases"] = list(prepared.get("cases", []))
        _write_json(manifest_path, manifest)
        for case_info in prepared["cases"]:
            name = case_info["case"]
            case = study / "inputs" / name
            case_manifest_path = case / "manifest.json"
            case_manifest = json.loads(case_manifest_path.read_text(encoding="utf-8"))
            case_manifest.update(solver=str(solver), solver_sha256=digest(solver),
                                 solver_timeout_seconds=TIMEOUT_SECONDS, threads=1,
                                 status="launch_requested", solver_executed=False,
                                 launch_requested_utc=_utc_now())
            case_manifest.setdefault("stage_history", []).append(
                {"stage": "launch_requested", "utc": case_manifest["launch_requested_utc"]}
            )
            _write_json(case_manifest_path, case_manifest)
            manifest["status"] = "launch_requested"
            manifest["active_case"] = name
            manifest["stage_history"].append(
                {"stage": "launch_requested", "case": name,
                 "utc": case_manifest["launch_requested_utc"]}
            )
            _write_json(manifest_path, manifest)

            def record_solver_started() -> None:
                started_utc = _utc_now()
                case_manifest.update(status="solver_started", solver_executed=True,
                                     solver_started_utc=started_utc)
                case_manifest["stage_history"].append(
                    {"stage": "solver_started", "utc": started_utc}
                )
                manifest.update(status="solver_started", solver_executed=True)
                manifest["stage_history"].append(
                    {"stage": "solver_started", "case": name, "utc": started_utc}
                )
                _write_json(case_manifest_path, case_manifest)
                _write_json(manifest_path, manifest)

            try:
                exit_code, elapsed, output = _run_solver(solver, home, case,
                                                       on_started=record_solver_started)
                case_manifest.update(solver_exit_code=exit_code, solver_seconds=elapsed)
                case_manifest["solver_returned_utc"] = _utc_now()
                if (case / "solver.log").is_file():
                    case_manifest["solver_log_sha256"] = digest(case / "solver.log")
                    case_manifest["solver_log_bytes"] = (case / "solver.log").stat().st_size
                version = re.search(r"MAIN: Version: (.+)", output)
                case_manifest["solver_version"] = version[1].strip() if version else "unreported"
                case_manifest["status"] = "solver_returned"
                case_manifest["stage_history"].append(
                    {"stage": "solver_returned", "utc": case_manifest["solver_returned_utc"]}
                )
                _write_json(case_manifest_path, case_manifest)
                manifest["stage_history"].append(
                    {"stage": "solver_returned", "case": name,
                     "utc": case_manifest["solver_returned_utc"]}
                )
                _write_json(manifest_path, manifest)
                if exit_code != 0 or "ALL DONE" not in output:
                    raise FEMQualificationError(
                        f"{name}: solver returned an invalid completion; inspect solver.log"
                    )
                if re.search(r"WARNING::.*FAILED|FATAL|ERROR::", output):
                    raise FEMQualificationError(f"{name}: solver reported a failure; inspect solver.log")
                eigenvalues = _read_eigenvalues(case / "eigen.dat")
                mode = read_mode(case / "mesh" / "mode_t0001.vtu")
                coverage = validate_mode_coverage(mode, case / "mesh" / "mesh.nodes",
                                                  case_info["node_count"])
                result = assess_case(eigenvalues, mode, case_info["eps_r"],
                                     case_info["mesh_size_mm"])
                result["mode_coverage"] = coverage
                result["raw_sha256"] = {
                    "eigen.dat": digest(case / "eigen.dat"),
                    "mesh/mode_t0001.vtu": digest(case / "mesh" / "mode_t0001.vtu"),
                }
                case_manifest["result"] = result
                case_manifest["status"] = result["status"]
                case_manifest["results_exported_utc"] = _utc_now()
                case_manifest["stage_history"].append(
                    {"stage": "results_exported", "utc": case_manifest["results_exported_utc"]}
                )
                case_manifest["raw_sha256"] = result["raw_sha256"]
                _write_json(case / "result.json", result)
                result_records.append(result)
                case_manifest["result_sha256"] = digest(case / "result.json")
                case_manifest["stage_history"].append(
                    {"stage": result["status"], "utc": _utc_now()}
                )
                _write_json(case_manifest_path, case_manifest)
                manifest["completed_cases"] = [
                    _case_key(record["eps_r"], record["mesh_size_mm"])
                    for record in result_records
                ]
                _write_json(manifest_path, manifest)
            except BaseException as exc:
                case_manifest["status"] = (
                    "interrupted" if isinstance(exc, KeyboardInterrupt) else "failed"
                )
                case_manifest["error"] = str(exc)
                case_manifest.setdefault("stage_history", []).append(
                    {"stage": case_manifest["status"], "utc": _utc_now()}
                )
                if (case / "solver.log").is_file():
                    case_manifest["solver_log_sha256"] = digest(case / "solver.log")
                    case_manifest["solver_log_bytes"] = (case / "solver.log").stat().st_size
                _write_json(case_manifest_path, case_manifest)
                raise
        study_result = assess_study(result_records)
        _write_json(study / "result.json", study_result)
        manifest["stage_history"].append(
            {"stage": study_result["status"], "utc": _utc_now()}
        )
        manifest.update(status=study_result["status"], result_sha256=digest(study / "result.json"),
                        result_path="result.json")
        _write_json(manifest_path, manifest)
        return study_result
    except BaseException as exc:
        if manifest.get("status") != "validation_failed":
            manifest["status"] = "interrupted" if isinstance(exc, KeyboardInterrupt) else "failed"
        manifest["error"] = str(exc)
        if manifest.get("active_case"):
            manifest["failed_case"] = manifest["active_case"]
        _write_json(manifest_path, manifest)
        raise


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    caps = commands.add_parser("capabilities", help="discover ElmerSolver without running it")
    caps.add_argument("--root", help="existing native Elmer package root (or FAIRBEAM_ELMER_ROOT)")
    prepare = commands.add_parser("prepare", help="write four qualification cases without solving")
    prepare.add_argument("--out", type=Path, required=True, help="new study directory")
    run = commands.add_parser("run", help="run the bounded four-case qualification study")
    run.add_argument("--experimental", action="store_true",
                     help="explicitly opt in to native research execution")
    run.add_argument("--root", help="existing native Elmer package root (or FAIRBEAM_ELMER_ROOT)")
    run.add_argument("--out", type=Path, required=True, help="new study directory")
    args = parser.parse_args(argv)
    try:
        if args.command == "capabilities":
            result = capabilities(args.root)
        elif args.command == "prepare":
            result = prepare_study(args.out)
        else:
            result = run_study(args.out, root=args.root, experimental=args.experimental)
    except (OSError, ValueError, FEMQualificationError) as exc:
        parser.exit(2, f"fairbeam-fem-qualification: {exc}\n")
    print(json.dumps(result, indent=2, allow_nan=False))
    return 0 if result.get("status") not in ("validation_failed", "failed") else 1


if __name__ == "__main__":
    sys.exit(main())
