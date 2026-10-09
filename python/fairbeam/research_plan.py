"""Bounded research preparation; this command never launches a solver."""
from __future__ import annotations

import argparse
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sys


def _json_value(value):
    if is_dataclass(value):
        return _json_value(asdict(value))
    if isinstance(value, complex):
        return {"real": value.real, "imag": value.imag}
    if isinstance(value, dict):
        return {str(k): _json_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(v) for v in value]
    if hasattr(value, "tolist"):
        return _json_value(value.tolist())
    return value


def _write(path, value):
    raw = (json.dumps(_json_value(value), indent=2, allow_nan=False) + "\n").encode("utf-8")
    path.write_bytes(raw)
    return hashlib.sha256(raw).hexdigest()


def _sources(out, names):
    directory = out / "source"
    directory.mkdir()
    hashes = {}
    for name in names:
        raw = Path(__file__).with_name(name).read_bytes()
        (directory / name).write_bytes(raw)
        hashes[name] = hashlib.sha256(raw).hexdigest()
    return hashes


def _finite_number(value):
    try:
        return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
    except OverflowError:
        return False


def floquet_plan(*, period_x_mm, period_y_mm, reference_frequency_ghz,
                 theta_deg, phi_deg, frequencies_ghz, order_radius=1):
    """Plan fixed transverse k across a band, explicitly distinguishing it from fixed angle."""
    from .bloch import Lattice2D, diffraction_orders, fixed_kt_angle_rad, transverse_k_from_angles
    scalar = (period_x_mm, period_y_mm, reference_frequency_ghz, theta_deg, phi_deg)
    if not all(_finite_number(v) for v in scalar):
        raise ValueError("geometry, reference frequency and angles must be finite numbers")
    if not all(1e-6 <= v <= 1000 for v in (period_x_mm, period_y_mm)):
        raise ValueError("periods must be 0.000001..1000 mm")
    if not 0 < reference_frequency_ghz <= 1000 or not 0 <= theta_deg < 90 or not -360 <= phi_deg <= 360:
        raise ValueError("reference frequency must be positive and <=1000 GHz; theta in [0,90), phi in [-360,360]")
    if isinstance(order_radius, bool) or not isinstance(order_radius, int) or not 0 <= order_radius <= 4:
        raise ValueError("order radius must be an integer from 0 to 4")
    if not isinstance(frequencies_ghz, (list, tuple)) or not 1 <= len(frequencies_ghz) <= 101:
        raise ValueError("provide 1..101 frequency samples")
    if any(not _finite_number(f) or not 0 < f <= 1000 for f in frequencies_ghz):
        raise ValueError("frequencies must be finite and in (0,1000] GHz")
    if any(b <= a for a, b in zip(frequencies_ghz, frequencies_ghz[1:])):
        raise ValueError("frequency samples must be strictly increasing")
    lattice = Lattice2D((period_x_mm * 1e-3, 0), (0, period_y_mm * 1e-3))
    kt = transverse_k_from_angles(reference_frequency_ghz * 1e9, math.radians(theta_deg), math.radians(phi_deg))
    orders = [(m, n) for m in range(-order_radius, order_radius + 1) for n in range(-order_radius, order_radius + 1)]
    samples = []
    for ghz in frequencies_ghz:
        modes = diffraction_orders(lattice, kt, ghz * 1e9, orders)
        fundamental = next(mode for mode in modes if mode.m == mode.n == 0)
        angle = fixed_kt_angle_rad(kt, ghz * 1e9) if fundamental.classification == "propagating" else None
        samples.append({"frequency_hz": ghz * 1e9,
                        "incident_classification": fundamental.classification,
                        "incident_angle_deg": None if angle is None else math.degrees(angle),
                        "orders": modes})
    return _json_value({"schema": "fairbeam.floquet-plan/1", "status": "plan_created",
        "solver_executed": False, "native_execution_supported": False,
        "convention": "exp(-i omega t), field(r+a)=exp(+i kt dot a) field(r)",
        "period_m": [period_x_mm * 1e-3, period_y_mm * 1e-3],
        "reference_frequency_hz": reference_frequency_ghz * 1e9,
        "reference_theta_deg": theta_deg, "reference_phi_deg": phi_deg,
        "transverse_k_rad_m": kt, "bloch_phase_rad": lattice.phase_rad(kt),
        "medium": {"eps_r": 1, "mu_r": 1}, "samples": samples,
        "limitations": ["Analytical channel plan only; not simulated S parameters.",
            "Transverse wavevector is fixed across this band, so incidence angle generally changes with frequency.",
            "The existing native periodic backend still accepts zero phase only.",
            "Only the requested finite set of diffraction orders is listed; omitted orders may propagate."]})


def export_floquet_plan(outdir, **settings):
    plan = floquet_plan(**settings)
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=False)
    manifest = {"schema": "fairbeam.research-preparation/1", "status": "created",
                "created_utc": datetime.now(timezone.utc).isoformat(), "solver_executed": False,
                "evidence_domain": "synthetic", "settings": settings, "source_sha256": {}}
    try:
        manifest["source_sha256"] = _sources(out, ("research_plan.py", "bloch.py"))
        manifest["plan_sha256"] = _write(out / "plan.json", plan)
        manifest["status"] = "plan_created"
    except Exception as exc:
        manifest.update(status="failed", failure=str(exc))
        raise
    finally:
        _write(out / "manifest.json", manifest)
    return plan


def export_fem_mesh(outdir, *, design=None, domain_mm=None, max_cell_mm=25):
    from .fem_geometry import mesh_design, write_elmer_mesh
    inputs = {"design": design, "domain_mm": domain_mm, "max_cell_mm": max_cell_mm}
    json.dumps(_json_value(inputs), allow_nan=False)  # refuse nonfinite snapshots before creating files
    mesh = mesh_design(design, domain_mm=domain_mm, max_cell_mm=max_cell_mm)
    # The mesh writer refuses an existing output folder. Preparation is never a solve.
    metadata = write_elmer_mesh(mesh, outdir)
    out = Path(outdir)
    manifest = {"schema": "fairbeam.research-preparation/1", "status": "mesh_exported",
                "created_utc": datetime.now(timezone.utc).isoformat(), "solver_executed": False,
                "evidence_domain": "synthetic", "inputs": inputs, "mesh": metadata,
                "source_sha256": _sources(out, ("research_plan.py", "fem_geometry.py")),
                "limitations": ["Geometry/mesh preparation only; no FEM equation, ports, radiation or S parameters solved.",
                                "Material and boundary maps require explicit solver setup; mesh export is not physical validation."]}
    _write(out / "preparation.json", manifest)
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    floquet = commands.add_parser("floquet", help="export a fixed-kt vacuum channel plan, without simulation")
    floquet.add_argument("--period-x-mm", type=float, required=True)
    floquet.add_argument("--period-y-mm", type=float, required=True)
    floquet.add_argument("--reference-frequency-ghz", type=float, required=True)
    floquet.add_argument("--theta-deg", type=float, default=0)
    floquet.add_argument("--phi-deg", type=float, default=0)
    floquet.add_argument("--frequencies-ghz", type=float, nargs="+", required=True)
    floquet.add_argument("--order-radius", type=int, default=1)
    floquet.add_argument("--out", type=Path, required=True)
    fem = commands.add_parser("fem-mesh", help="export a bounded box-based Elmer mesh, without simulation")
    fem.add_argument("--design", type=Path, help="optional Fairbeam design JSON; vacuum domain if omitted")
    fem.add_argument("--domain-mm", type=float, nargs=6, required=True,
                     metavar=("XMIN", "YMIN", "ZMIN", "XMAX", "YMAX", "ZMAX"))
    fem.add_argument("--max-cell-mm", type=float, default=25)
    fem.add_argument("--out", type=Path, required=True)
    args = vars(parser.parse_args(argv))
    command = args.pop("command")
    out = args.pop("out")
    try:
        if command == "floquet":
            result = export_floquet_plan(out, **args)
        else:
            design_path = args.pop("design")
            if design_path is not None and design_path.stat().st_size > 1024 * 1024:
                raise ValueError("design input exceeds 1 MiB")
            design = None if design_path is None else json.loads(design_path.read_text(encoding="utf-8"))
            result = export_fem_mesh(out, design=design, **args)
    except (OSError, ValueError) as exc:
        parser.exit(2, f"fairbeam-research-plan: {exc}\n")
    print(json.dumps({"status": result["status"], "solver_executed": False, "directory": str(out)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
