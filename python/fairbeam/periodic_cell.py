"""Opt-in, bounded zero-phase periodic CPU research runs.

The native revision-4 capability handshake is mandatory. This module does not
select or modify Fairbeam's ordinary openEMS runtime. Lengths are mm, frequencies
Hz, and output amplitudes are the co-polar fundamental at the sample faces.
"""
import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
import xml.etree.ElementTree as ET

import numpy as np

C0 = 299792458.0
CAPABILITIES = {"schema": 1, "backend": "fairbeam-periodic-cpu", "revision": 4,
                "boundary": "PERIODIC_TEST", "phase": "zero", "axes": "xy",
                "engine": "basic", "geometry": "axis-aligned-boxes"}
MAX_CELLS, MAX_STEPS, TIMEOUT_S = 500000, 80000, 180
LIMITATIONS = [
    "Experimental CPU basic, normal incidence, zero-phase periodic x/y only.",
    "Co-polar fundamental amplitudes only; no Floquet modal ports or cross-polar output.",
    "Axis-aligned PEC and lossless, constant, isotropic dielectric boxes only.",
    "Co-polar power is not a full multimode passivity test; no mesh-convergence claim from one run.",
    "Custom structures require independent validation and refinement at 20, 30 and 40 cells per wavelength.",
]


def _number(value, label):
    try:
        valid = not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
    except OverflowError:
        valid = False
    if not valid:
        raise ValueError(f"{label} must be a finite number")
    return float(value)


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _save(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def _stamp():
    return datetime.now(timezone.utc).isoformat()


def probe(path=None):
    """Bounded native-library handshake, without a simulation. Fail closed."""
    selected = path or os.environ.get("FAIRBEAM_PERIODIC_EXECUTABLE")
    result = {"available": False, "path": str(selected) if selected else None,
              "backend": "periodic", "limitations": LIMITATIONS.copy()}
    try:
        if not selected:
            raise ValueError("Set an explicit revision-4 experimental openEMS executable path")
        executable = Path(selected).resolve(strict=True)
        if not executable.is_file():
            raise ValueError("Periodic runtime path must name an executable file")
        result["path"] = str(executable)
        response = subprocess.run([str(executable), "--fairbeam-periodic-capabilities"],
                                  capture_output=True, text=True, timeout=10,
                                  creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if response.returncode:
            raise ValueError("Periodic native capability handshake failed")
        value = json.loads(response.stdout)
        if not isinstance(value, dict) or any(value.get(k) != v for k, v in CAPABILITIES.items()):
            raise ValueError("Revision-4 periodic CPU native capabilities required; no fallback")
        result.update(available=True, capabilities=value, executable_sha256=_sha(executable))
        dll = executable.parent / "openEMS.dll"
        if dll.is_file():
            result["native_library_sha256"] = _sha(dll)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        result["reason"] = str(exc)
    return result


def _design_boxes(design, values):
    from .design import check_design, evaluate, resolve_names, resolve_parts
    check_design(design)
    for key in ("ports", "resistors", "lumped_elements", "excitations"):
        if design.get(key):
            raise ValueError(f"Periodic design reuse does not support {key}; remove them explicitly")
    names = resolve_names(design, values)
    for name, value in names.items():
        _number(value, f"parameter {name}")
    if len(design.get("parts", [])) > 64:
        raise ValueError("At most 64 box parts are supported")
    for part in design.get("parts", []):
        if any(part.get(k) for k in ("transforms", "cuts", "booleanHistory")):
            raise ValueError("Periodic design reuse rejects transforms, cuts and Boolean history")
        for primitive in part["primitives"]:
            if primitive.get("kind") != "box" or primitive.get("void"):
                raise ValueError("Periodic design reuse supports solid axis-aligned boxes only")
            if set(primitive) - {"kind", "start", "stop", "priority", "void"}:
                raise ValueError("Unsupported box primitive attributes")
    material_values = {}
    for material in design.get("materials", []):
        allowed = {"name", "kind", "color", "library", "eps_r", "tan_d", "tan_d_freq", "conductivity", "thickness"}
        if set(material) - allowed:
            raise ValueError(f"Unsupported material properties on {material['name']}; dispersion is not supported")
        if evaluate(material.get("tan_d", 0), names) != 0:
            raise ValueError("Lossy dielectric design materials are not supported")
        conductivity = material.get("conductivity")
        if conductivity not in (None, ""):
            raise ValueError("Finite-conductivity metal is not supported; select PEC explicitly")
        material_values[material["name"]] = ("pec", 1.) if material["kind"] == "metal" else (
            "dielectric", evaluate(material.get("eps_r", 1), names))
    boxes = []
    for part in resolve_parts(design, names):
        kind, epsilon = material_values[part["material"]["name"]]
        for primitive in part["prims"]:
            boxes.append({"name": part["name"], "material": kind, "eps_r": epsilon,
                          "start": primitive["start"], "stop": primitive["stop"],
                          "priority": primitive["priority"]})
    return boxes


def validate_spec(settings, design=None):
    """Validate before queue admission; return an immutable JSON-ready specification.

    ``boxes`` is a list of {material: 'pec'|'dielectric', eps_r, start, stop}.
    A design is evaluated at defaults plus ``params`` and must pass the explicit
    box-only subset. Its simulation/mesh/monitor settings are replaced by this
    research setup, recorded in ``design_reuse``. Without boxes/design, choose
    fixture 'slab' (default, epsilon=4), 'pec_sheet', or 'empty'.
    """
    if not isinstance(settings, dict):
        raise ValueError("Periodic settings must be an object")
    allowed = {"period_x_mm", "period_y_mm", "front_mm", "back_mm", "f_min_hz", "f_max_hz",
               "cpw", "boxes", "fixture", "params"}
    if set(settings) - allowed:
        raise ValueError("Unsupported periodic settings: " + ", ".join(sorted(set(settings) - allowed)))
    defaults = {"period_x_mm": 6, "period_y_mm": 6, "front_mm": 0, "back_mm": 10,
                "f_min_hz": 1e9, "f_max_hz": 10e9, "cpw": 20}
    s = {key: _number(settings.get(key, default), key) for key, default in defaults.items()}
    if not all(1e-6 <= s[k] <= 1000 for k in ("period_x_mm", "period_y_mm")):
        raise ValueError("Periods must be within 0.000001..1000 mm")
    if not (abs(s["front_mm"]) <= 1000 and s["front_mm"] <= s["back_mm"] <= s["front_mm"] + 1000):
        raise ValueError("Sample faces must satisfy front <= back and a maximum 1000 mm depth")
    if 0 < s["back_mm"] - s["front_mm"] < 1e-6:
        raise ValueError("Nonzero sample depth must be at least 0.000001 mm")
    if not (1e6 <= s["f_min_hz"] < s["f_max_hz"] <= 1e12 and s["f_max_hz"] / s["f_min_hz"] <= 100):
        raise ValueError("Band must be ordered, within 1 MHz..1 THz, with ratio at most 100")
    if s["cpw"] not in (20, 30, 40):
        raise ValueError("cpw must be 20, 30 or 40")
    s["cpw"] = int(s["cpw"])
    if s["f_max_hz"] >= C0 / (max(s["period_x_mm"], s["period_y_mm"]) * 1e-3):
        raise ValueError("Band reaches the first vacuum diffraction order; fundamental-only output is unsupported")
    params = settings.get("params", {})
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    for k, v in params.items():
        _number(v, f"params.{k}")
    if design is not None:
        if "boxes" in settings or "fixture" in settings:
            raise ValueError("Choose design reuse or explicit boxes/fixture, not both")
        boxes = _design_boxes(design, params)
        source = "design"
    elif "boxes" in settings:
        if "fixture" in settings:
            raise ValueError("Choose boxes or a fixture, not both")
        boxes, source = settings["boxes"], "boxes"
    else:
        source = settings.get("fixture", "slab")
        if source not in ("slab", "pec_sheet", "empty"):
            raise ValueError("fixture must be slab, pec_sheet or empty")
        boxes = [] if source == "empty" else [{"name": source,
            "material": "pec" if source == "pec_sheet" else "dielectric", "eps_r": 4 if source == "slab" else 1,
            "start": [-s["period_x_mm"] / 2, -s["period_y_mm"] / 2, s["front_mm"]],
            "stop": [s["period_x_mm"] / 2, s["period_y_mm"] / 2,
                     s["front_mm"] if source == "pec_sheet" else s["back_mm"]]}]
    if not isinstance(boxes, list) or len(boxes) > 64:
        raise ValueError("boxes must be a list of at most 64 boxes")
    normalized = []
    for index, box in enumerate(boxes):
        if not isinstance(box, dict) or set(box) - {"name", "material", "eps_r", "start", "stop", "priority"}:
            raise ValueError(f"Unsupported box {index} properties")
        kind = box.get("material")
        if kind not in ("pec", "dielectric"):
            raise ValueError("Box material must be pec or dielectric")
        epsilon = _number(box.get("eps_r", 1), "eps_r")
        if not 1 <= epsilon <= 100 or (kind == "pec" and epsilon != 1):
            raise ValueError("Dielectric eps_r must be 1..100; PEC eps_r must be omitted or 1")
        vectors = []
        for key in ("start", "stop"):
            v = box.get(key)
            if not isinstance(v, list) or len(v) != 3:
                raise ValueError(f"box.{key} needs three coordinates")
            vectors.append([_number(x, f"box.{key}") for x in v])
        lo, hi = vectors
        if any(a > b for a, b in zip(lo, hi)):
            raise ValueError("Box start must not exceed stop")
        zeros = sum(a == b for a, b in zip(lo, hi))
        if zeros > (1 if kind == "pec" else 0):
            raise ValueError("Dielectrics need volume; PEC may have one zero-thickness axis")
        lower = [-s["period_x_mm"] / 2, -s["period_y_mm"] / 2, s["front_mm"]]
        upper = [s["period_x_mm"] / 2, s["period_y_mm"] / 2, s["back_mm"]]
        if any(a < l or b > u for a, b, l, u in zip(lo, hi, lower, upper)):
            raise ValueError("Boxes must fit inside the centered unit cell and sample faces; split seam-crossing boxes explicitly")
        priority = _number(box.get("priority", 10 if kind == "pec" else 0), "priority")
        if not priority.is_integer() or not 0 <= priority <= 100:
            raise ValueError("Box priority must be a whole number from 0 to 100")
        normalized.append({"name": str(box.get("name", f"box_{index}")), "material": kind,
                           "eps_r": epsilon, "start": lo, "stop": hi, "priority": int(priority)})
    s["boxes"] = normalized
    layout = _layout(s)
    steps = [layout[k] for k in ("dx_mm", "dy_mm", "dz_mm")]
    for box in normalized:
        origins = [-s["period_x_mm"] / 2, -s["period_y_mm"] / 2, s["front_mm"]]
        for a, b, step, origin in zip(box["start"], box["stop"], steps, origins):
            if 0 < b - a < step * (1 - 1e-9):
                raise ValueError(f"Box {box['name']} has a nonzero thickness below one mesh cell; increase cpw or change the geometry explicitly")
            if a == b and abs((a - origin) / step - round((a - origin) / step)) > 1e-8:
                raise ValueError(f"PEC sheet {box['name']} must lie on a uniform mesh plane; change its position explicitly")
    result = {"schema": "fairbeam.periodic-cell/1", "settings": s, "source": source, "layout": layout,
              "input_settings": copy.deepcopy(settings), "source_design": copy.deepcopy(design)}
    if design is not None:
        result["design_reuse"] = "Geometry/materials evaluated only; research band, uniform mesh, source, boundaries and probes replace design simulation settings and monitors."
    json.dumps(result, allow_nan=False)
    return result


def _layout(s):
    # Keep the air/PEC controls at least as fine as the eps=4 slab control.
    # A vacuum-only cpw20 grid failed the independent empty-reflection gate.
    mesh_epsilon = max([b["eps_r"] for b in s["boxes"]] + [4])
    dense = C0 / s["f_max_hz"] / 1e-3 / s["cpw"] / math.sqrt(mesh_epsilon)
    depth = s["back_mm"] - s["front_mm"]
    nz_sample = max(1, math.ceil(depth / dense)) if depth else 0
    dz = depth / nz_sample if depth else dense
    nx, ny = [max(6, math.ceil(s[k] / dense)) for k in ("period_x_mm", "period_y_mm")]
    gap = max(s["period_x_mm"], s["period_y_mm"], C0 / s["f_max_hz"] / 1e-3 / 2)
    ng = max(4, math.ceil(gap / dz))
    nz = nz_sample + 2 * ng + 44
    cells = nx * ny * nz
    if cells > MAX_CELLS or max(nx, ny, nz) > 20000:
        raise ValueError(f"Uniform mesh requires {cells} cells; research cap is {MAX_CELLS}")
    dx, dy = s["period_x_mm"] / nx, s["period_y_mm"] / ny
    dt = .8 / (C0 * math.sqrt(sum(1 / (h * 1e-3) ** 2 for h in (dx, dy, dz))))
    # Bound nominal work as well as memory. A native timeout is an additional gate.
    if cells * MAX_STEPS > 40_000_000_000:
        raise ValueError("Periodic mesh exceeds the cell-timestep work cap")
    return {"nx": nx, "ny": ny, "nz": nz, "sample_steps": nz_sample, "gap_steps": ng,
            "dx_mm": dx, "dy_mm": dy, "dz_mm": dz, "cells": cells, "dt_s": dt,
            "pml_cells": 16, "max_timesteps": MAX_STEPS, "timeout_per_case_s": TIMEOUT_S,
            "end_criteria_db": -70, "uniform_mesh": True, "mesh_epsilon": mesh_epsilon}


def _build(spec, sample):
    from .simulation import Simulation
    s, l = spec["settings"], spec["layout"]
    sim = Simulation(s["f_min_hz"], s["f_max_hz"], max_timesteps=MAX_STEPS, end_criteria_db=-70)
    sim.boundaries = ["PMC", "PMC", "PEC", "PEC", "PML_16", "PML_16"]
    sim.fdtd.SetBoundaryCond(sim.boundaries)
    xs = np.linspace(-s["period_x_mm"] / 2, s["period_x_mm"] / 2, l["nx"] + 1)
    ys = np.linspace(-s["period_y_mm"] / 2, s["period_y_mm"] / 2, l["ny"] + 1)
    zs = s["front_mm"] + np.arange(-l["gap_steps"] - 24, l["sample_steps"] + l["gap_steps"] + 21) * l["dz_mm"]
    for axis, lines in zip("xyz", (xs, ys, zs)):
        sim.mesh.AddLine(axis, lines)
    front_index = l["gap_steps"] + 24
    z1, z2 = zs[24], zs[front_index + l["sample_steps"] + l["gap_steps"]]
    zcheck = zs[24 + max(1, l["gap_steps"] // 2)]
    exc = sim.csx.AddExcitation("periodic_source", exc_type=0, exc_val=[0, 1, 0])
    exc.AddBox([xs[0], ys[0], zs[20]], [xs[-1], ys[-1], zs[20]])
    names = []
    for plane, z in enumerate((z1, z2, zcheck)):
        group = []
        for i, x in enumerate(xs[:-1]):
            name = f"avg_{plane}_{i}"
            sim.csx.AddProbe(name, p_type=0).AddBox([x, ys[0], z], [x, ys[-1], z])
            group.append(name)
        names.append(group)
    if sample:
        for index, box in enumerate(s["boxes"]):
            prop = sim.csx.AddMetal(f"sample_{index}") if box["material"] == "pec" else sim.csx.AddMaterial(f"sample_{index}", epsilon=box["eps_r"])
            prop.AddBox(box["start"], box["stop"], priority=box["priority"])
    sim.fdtd.SetTimeStep(l["dt_s"])
    return sim, names, [float(z1), float(z2), float(zcheck)]


def _write_xml(sim, path):
    # The stock CSXCAD writer rounds boxes more than grids. Replay getter values
    # at full precision so the zero-thickness source stays exactly on its plane.
    from .periodic_xml import write
    write(sim, path)
    tree = ET.parse(path)
    for axis in ("xmin", "xmax", "ymin", "ymax"):
        tree.find(".//BoundaryCond").set(axis, "PERIODIC_TEST")
    tree.write(path, encoding="utf-8", xml_declaration=True)


def run(spec, outdir, executable=None):
    """Run sequential empty/sample cases in a fresh directory. Caller serializes jobs.

    Native subprocesses inherit the worker process group / Windows Job Object so
    queue cancellation kills the entire tree. Partial evidence is always retained.
    """
    from .simulation import _parse_log
    from .material_cell import cell_sparams, probe_timestep
    from openEMS.ports import UI_data
    if not isinstance(spec, dict) or spec.get("schema") != "fairbeam.periodic-cell/1":
        raise ValueError("run requires a validate_spec result")
    checked = validate_spec(spec["input_settings"], spec.get("source_design"))
    if checked != spec:
        raise ValueError("Normalized periodic specification changed; revalidate before running")
    capability = probe(executable)
    if not capability["available"]:
        raise ValueError(capability["reason"])
    out = Path(outdir).resolve()
    out.mkdir(parents=True, exist_ok=False)
    _save(out / "input.json", spec)
    shutil.copy2(__file__, out / "periodic_cell-source.py")
    shutil.copy2(Path(__file__).with_name("periodic_xml.py"), out / "periodic_xml.py")
    s, layout = spec["settings"], spec["layout"]
    manifest = {"schema": 1, "backend": "periodic", "status": "model_built", "started_utc": _stamp(),
                "evidence_domain": "synthetic", "acceleration": "CPU basic", "threads": 1,
                "capability": capability, "generator_sha256": _sha(__file__),
                "xml_writer_sha256": _sha(Path(__file__).with_name("periodic_xml.py")),
                "input_sha256": _sha(out / "input.json"), "platform": platform.platform(),
                "python_version": sys.version, "numpy_version": np.__version__,
                "support_source_sha256": {name: _sha(Path(__file__).with_name(name))
                                          for name in ("simulation.py", "material_cell.py", "analytic.py")},
                "input_provenance": "User-provided design/boxes or assumed synthetic fixture; no measured material claim.",
                "layout": layout, "cases": [], "limitations": LIMITATIONS.copy()}
    _save(out / "manifest.json", manifest)
    frequencies = np.linspace(s["f_min_hz"], s["f_max_hz"], 301)
    waves, stats = [], []
    try:
        for role in ("reference", "sample"):
            case = out / role
            case.mkdir()
            sim, names, planes = _build(spec, role == "sample")
            xml = case / "model.xml"
            _write_xml(sim, xml)
            command = [capability["path"], str(xml), "--engine=basic"]
            record = {"role": role, "status": "model_built", "xml_sha256": _sha(xml), "command": command}
            manifest["cases"].append(record)
            record.update(status="solver_started", started_utc=_stamp())
            manifest["status"] = "solver_started"
            _save(out / "manifest.json", manifest)
            print(f"Periodic {role}: {layout['cells']} cells, CPU basic", flush=True)
            start = time.monotonic()
            with (case / "solver.log").open("w", encoding="utf-8") as log:
                process = subprocess.run(command, cwd=case, stdout=log, stderr=subprocess.STDOUT,
                                         timeout=TIMEOUT_S, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            record.update(exit_code=process.returncode, wall_s=time.monotonic() - start, finished_utc=_stamp())
            if process.returncode:
                raise RuntimeError(f"Periodic {role} solver exited with {process.returncode}; see {case / 'solver.log'}")
            record["status"] = "solver_returned"
            record["stats"] = _parse_log((case / "solver.log").read_text(encoding="utf-8", errors="replace"), -70, MAX_STEPS)
            vals = [np.mean(UI_data(group, str(case), frequencies).ui_f_val, axis=0) for group in names]
            if not all(np.isfinite(v).all() for v in vals):
                raise ValueError("Nonfinite periodic probe amplitudes")
            actual_dt = probe_timestep(case / names[0][0], layout["dt_s"])
            if abs(actual_dt / layout["dt_s"] - 1) > 1e-5:
                raise ValueError("Native probe time axis does not match the explicit timestep")
            record.update(status="results_exported", probe_timestep_s=actual_dt,
                          probe_sha256={name: _sha(case / name) for group in names for name in group})
            _save(out / "manifest.json", manifest)
            waves.append(vals)
            stats.append(record["stats"])
        for incident in waves[0][:2]:
            if np.max(abs(incident)) <= 0 or np.min(abs(incident)) < np.max(abs(incident)) * 1e-8:
                raise ValueError("Incident spectrum is too small for stable normalization across the requested band")
        result = cell_sparams(frequencies, waves[0][:2], waves[1][:2], planes[0], planes[1], s["front_mm"], s["back_mm"])
        s11, s21 = result["s11"], result["s21"]
        if not np.isfinite(s11).all() or not np.isfinite(s21).all():
            raise ValueError("Nonfinite normalized periodic response")
        phase = np.exp(-2j * np.pi * frequencies / C0 * (planes[2] - planes[0]) * 1e-3)
        denominator = 1 / phase - phase
        if np.min(abs(denominator)) < 1e-5:
            raise ValueError("Empty-reference decomposition planes are degenerate within this band")
        backward = (waves[0][2] - waves[0][0] * phase) / denominator
        forward = waves[0][0] - backward
        if np.min(abs(forward)) <= np.max(abs(forward)) * 1e-8:
            raise ValueError("Empty-reference forward wave is too small")
        reflection = float(np.max(abs(backward / forward)))
        power = abs(s11) ** 2 + abs(s21) ** 2
        qa = {"energy_converged": all(bool(t.get("converged")) for t in stats),
              "empty_reference_max_reflection": reflection, "empty_reference_pass": reflection <= .001,
              "co_polar_power_max": float(np.max(power)), "co_polar_power_upper_bound_pass": bool(np.max(power) <= 1.01),
              "mesh_convergence_checked": False}
        passed = qa["energy_converged"] and qa["empty_reference_pass"] and qa["co_polar_power_upper_bound_pass"]
        if spec["source"] in ("slab", "empty", "pec_sheet"):
            from .analytic import slab_s
            if spec["source"] == "pec_sheet":
                error = max(np.max(abs(s11 + 1)), np.max(abs(s21)))
            else:
                analytic = slab_s(frequencies, [{"thickness": s["back_mm"] - s["front_mm"],
                                               "eps_r": 4 if spec["source"] == "slab" else 1}], unit=1e-3)
                error = max(np.max(abs(s11 - analytic[:, 0, 0])), np.max(abs(s21 - analytic[:, 1, 0])))
            qa.update(analytic_max_complex_error=float(error), analytic_pass=bool(error <= .02))
            passed = passed and qa["analytic_pass"]
        np.savez(out / "complex.npz", frequency_hz=frequencies, s11=s11, s21=s21)
        np.savez(out / "empty-reference-waves.npz", frequency_hz=frequencies, forward=forward, backward=backward)
        np.savetxt(out / "sparameters.csv", np.column_stack([frequencies, s11.real, s11.imag, s21.real, s21.imag]),
                   delimiter=",", header="frequency_hz,s11_real,s11_imag,s21_real,s21_imag", comments="")
        output = {"schema": "fairbeam.periodic-result/1", "backend": "periodic",
                  "status": "results_validated" if passed else "results_exported",
                  "validation_scope": "Single-run numerical QA only; arbitrary geometry accuracy and mesh convergence are not established.",
                  "frequency_hz": frequencies.tolist(), "s11_real": s11.real.tolist(), "s11_imag": s11.imag.tolist(),
                  "s21_real": s21.real.tolist(), "s21_imag": s21.imag.tolist(), "qa": qa,
                  "settings": s, "layout": layout, "limitations": LIMITATIONS.copy(),
                  "provenance": {"input": "input.json", "manifest": "manifest.json", "raw_cases": ["reference", "sample"],
                                 "complex_sha256": _sha(out / "complex.npz"), "csv_sha256": _sha(out / "sparameters.csv"),
                                 "capabilities": capability, "reference_planes_mm": planes[:2],
                                 "s_parameter_planes_mm": [s["front_mm"], s["back_mm"]],
                                 "polarization": "Ey", "incidence": "+z normal", "normalization": "empty reference/sample pair"}}
        _save(out / "result.json", output)
        manifest.update(status=output["status"], finished_utc=_stamp(), qa=qa)
        _save(out / "manifest.json", manifest)
        return output
    except BaseException as exc:
        manifest.update(status="failed", failure=str(exc), finished_utc=_stamp())
        _save(out / "manifest.json", manifest)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--outdir", type=Path, required=True)
    parser.add_argument("--executable", required=True)
    args = parser.parse_args()
    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    result = run(spec, args.outdir, executable=args.executable)
    print(json.dumps({"status": result["status"], "result": str(args.outdir / "result.json")}))


if __name__ == "__main__":
    main()
