"""Bounded stock-openEMS normal-incidence Ey/+z PEC/PMC symmetry-cell research.

The box admission and uniform mesh policy are shared with the periodic research
adapter, but its patched capability handshake and XML boundary rewrite are never
used. Source data are user assumptions; a successful pair is not mesh qualification.
"""
import copy
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

import numpy as np

from . import periodic_cell as box_contract
from .jsonutil import finite_json

C0 = 299792458.0
MAX_CELLS, MAX_STEPS, TIMEOUT_S = 500000, 80000, 180
BOUNDARIES = ["PMC", "PMC", "PEC", "PEC", "PML_16", "PML_16"]
LIMITATIONS = [
    "Stock CPU basic, normal +z incidence, Ey polarization; exact x/y mirror symmetry required.",
    "PEC/PMC symmetry walls, not periodic or Floquet ports; no oblique, cross-polar or multimode output.",
    "Axis-aligned PEC and lossless constant isotropic dielectric boxes only; no unsupported physics is dropped.",
    "Co-polar power is not a full passivity test; one run is not mesh or numerical qualification.",
    "NRW is restricted to one homogeneous full-cross-section slab; unreliable points remain unavailable.",
    "Stock PMC boundary discretization and structured-cell accuracy require separate native refinement controls.",
]
_sha = box_contract._sha
_save = box_contract._save
_stamp = box_contract._stamp


def _same_box(a, b, axis, tolerance):
    if any(a[k] != b[k] for k in ("material", "eps_r", "priority")):
        return False
    lo, hi = list(a["start"]), list(a["stop"])
    lo[axis], hi[axis] = -hi[axis], -lo[axis]
    return all(abs(x - y) <= tolerance for x, y in zip(lo + hi, b["start"] + b["stop"]))


def validate_spec(settings, design=None):
    """SDK-free admission; no native executable is imported or launched here."""
    if not isinstance(settings, dict):
        raise ValueError("Stock cell settings must be an object")
    source = copy.deepcopy(settings)
    retrieval = source.pop("nrw", False)
    floor = source.pop("nrw_sin_floor", .3)
    if type(retrieval) is not bool or isinstance(floor, bool) or floor not in (.3, .5):
        raise ValueError("nrw must be boolean; nrw_sin_floor must be 0.3 or 0.5")
    # The generic box subset deliberately allows display thickness metadata. This
    # adapter must not silently discard a sheet's finite physical thickness.
    if design is not None:
        if not isinstance(design, dict):
            raise ValueError("Stock cell Design must be an object")
        materials = design.get("materials", [])
        if not isinstance(materials, list) or not all(isinstance(m, dict) for m in materials):
            raise ValueError("Stock cell Design materials must be a list of objects")
        if any(m.get("thickness") not in (None, "") for m in materials):
            raise ValueError("Stock cell does not support material sheet thickness; model an explicit PEC box")
    spec = box_contract.validate_spec(source, design)
    s = spec["settings"]
    boxes = s["boxes"]
    # This is floating-point expression roundoff, not a geometric/mesh tolerance.
    magnitude = max([1.] + [abs(x) for b in boxes for x in b["start"] + b["stop"]])
    tolerance = 32 * math.ulp(magnitude)
    for axis in (0, 1):
        remaining = list(boxes)
        for box in boxes:
            match = next((i for i, candidate in enumerate(remaining) if _same_box(box, candidate, axis, tolerance)), None)
            if match is None:
                raise ValueError(f"Stock PEC/PMC cell requires matching material/priority mirror boxes about {'xy'[axis]} = 0")
            remaining.pop(match)
    # Equal-priority material overlaps can depend on source insertion order and
    # break the purported symmetry even when the box multiset is symmetric.
    for i, a in enumerate(boxes):
        for b in boxes[i + 1:]:
            overlap = [min(a["stop"][k], b["stop"][k]) - max(a["start"][k], b["start"][k]) for k in range(3)]
            has_sheet = any(start == stop for box in (a, b) for start, stop in zip(box["start"], box["stop"]))
            ambiguous = all(v >= 0 for v in overlap) and (all(v > 0 for v in overlap) or has_sheet and sum(v > 0 for v in overlap) >= 2)
            if (a["priority"] == b["priority"] and (a["material"], a["eps_r"]) != (b["material"], b["eps_r"]) and
                    ambiguous):
                raise ValueError("Stock cell refuses ambiguous equal-priority material overlaps")
    homogeneous = (len(boxes) == 1 and boxes[0]["material"] == "dielectric" and s["back_mm"] > s["front_mm"] and
                   boxes[0]["start"] == [-s["period_x_mm"] / 2, -s["period_y_mm"] / 2, s["front_mm"]] and
                   boxes[0]["stop"] == [s["period_x_mm"] / 2, s["period_y_mm"] / 2, s["back_mm"]])
    if retrieval and not homogeneous:
        raise ValueError("NRW requires one homogeneous full-cross-section dielectric slab between the selected faces")
    spec.update(schema="fairbeam.stock-cell/1", input_settings=copy.deepcopy(settings),
                symmetry={"axes": ["x", "y"], "coordinate_roundoff_mm": tolerance,
                          "method": "one-to-one reflected box multiset with identical material and priority"})
    s.update(nrw=retrieval, nrw_sin_floor=float(floor))
    spec["layout"].update(boundaries=BOUNDARIES.copy(), polarization="Ey", incidence="+z normal")
    if design is not None:
        spec["design_reuse"] = "Geometry/materials evaluated only; stock cell band, uniform mesh, Ey source, PEC/PMC walls and probes replace Design simulation settings and monitors."
    return spec


def _default_executable():
    if os.name == "nt":
        return Path(os.environ.get("OPENEMS_INSTALL_PATH") or os.environ.get("CSXCAD_INSTALL_PATH") or r"C:\opt\openEMS") / "openEMS.exe"
    candidate = Path(sys.executable).parent.parent.parent / "bin/openEMS"
    return candidate if candidate.is_file() else Path(shutil.which("openEMS") or candidate)


def _sdk_files():
    files = []
    for name in ("openEMS", "CSXCAD"):
        module = importlib.util.find_spec(name)
        if module is None or not module.origin:
            raise ValueError(f"Stock cell requires the installed {name} Python bindings")
        root = Path(module.origin).parent
        files.append(str(Path(module.origin).resolve()))
        for pattern in ("*.pyd", "*.so", "*.dll", "*.dylib"):
            files.extend(str(p.resolve()) for p in root.rglob(pattern))
    return sorted(set(files))


def probe(path=None):
    """Check normal stock CLI/bindings; no periodic handshake and no simulation."""
    result = {"backend": "stock", "available": False, "path": None, "limitations": LIMITATIONS.copy()}
    try:
        selected = Path(path) if path else _default_executable()
        executable = selected.resolve(strict=True)
        if not executable.is_file():
            raise ValueError("Stock runtime path must name an openEMS executable")
        result["path"] = str(executable)
        sdk = _sdk_files()
        response = subprocess.run([str(executable), "--help"], capture_output=True, text=True, timeout=10,
                                  creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        help_text = response.stdout + response.stderr
        if response.returncode or "openems" not in help_text.lower() or "basic" not in help_text.lower():
            raise ValueError("Stock openEMS CPU basic CLI was not identified")
        result.update(available=True, executable_sha256=_sha(executable), sdk_files=sdk,
                      capabilities={"boundary": "PEC/PMC", "engine": "basic", "polarization": "Ey", "incidence": "+z normal"})
    except (OSError, ValueError, ImportError, subprocess.SubprocessError) as exc:
        result["reason"] = str(exc)
    return result


def _write_xml(sim, path):
    # The precision writer only replays native getters; it does not rewrite BCs.
    from .periodic_xml import write
    write(sim, path)
    tree = ET.parse(path)
    boundary = tree.find(".//BoundaryCond")
    values = [boundary.get(k) for k in ("xmin", "xmax", "ymin", "ymax", "zmin", "zmax")] if boundary is not None else []
    if values != BOUNDARIES:
        raise ValueError("Stock cell XML boundaries do not match the admitted PEC/PMC/PML contract")


def material_result(frequencies, s11, s21, settings):
    """Preserve raw NRW inversion but mask unreliable values in presentation/export."""
    thickness = settings["back_mm"] - settings["front_mm"]
    base = {"requested": settings["nrw"], "thickness_mm": thickness, "qualified": False,
            "assumptions": "Homogeneous isotropic nonmagnetic slab in vacuum; exp(+j omega t); sample-face S parameters.",
            "method": "Nicolson-Ross-Weir; automatic group-delay branch with explicit mu_r=1 constraint",
            "sin_floor": settings["nrw_sin_floor"]}
    if not settings["nrw"]:
        return {**base, "available": False, "reason": "not_requested"}
    from .nrw import nrw, S21_FLOOR
    try:
        raw = nrw(frequencies, s11, s21, thickness, sin_floor=settings["nrw_sin_floor"], nonmagnetic=True)
        reliable = np.asarray(raw["reliable"], bool) & np.isfinite(raw["eps_r"]) & np.isfinite(raw["mu_r"])
        def masked(values):
            return [float(v) if ok and np.isfinite(v) else None for v, ok in zip(values, reliable)]
        return finite_json({**base, "available": bool(reliable.any()), "reason": None if reliable.any() else "no_reliable_points",
                            "s21_floor": S21_FLOOR, "reliable": reliable, "branch": raw["branch"], "segments": raw["segments"],
                            "eps_real": masked(raw["eps_r"].real), "eps_imag": masked(raw["eps_r"].imag),
                            "mu_real": masked(raw["mu_r"].real), "mu_imag": masked(raw["mu_r"].imag),
                            "raw_inversion": {key: {"re": value.real, "im": value.imag} if np.iscomplexobj(value) else value
                                              for key, value in raw.items()}})
    except ValueError as exc:
        return {**base, "available": False, "reason": str(exc)}


def _reference_waves(frequencies, values, planes):
    for incident in values[:2]:
        if np.max(abs(incident)) <= 0 or np.min(abs(incident)) < np.max(abs(incident)) * 1e-8:
            raise ValueError("Incident spectrum is too small for stable normalization across the requested band")
    phase = np.exp(-2j * np.pi * frequencies / C0 * (planes[2] - planes[0]) * 1e-3)
    denominator = 1 / phase - phase
    if np.min(abs(denominator)) < 1e-5:
        raise ValueError("Empty-reference decomposition planes are degenerate within this band")
    backward = (values[2] - values[0] * phase) / denominator
    forward = values[0] - backward
    if np.min(abs(forward)) <= np.max(abs(forward)) * 1e-8:
        raise ValueError("Empty-reference forward wave is too small")
    return forward, backward, float(np.max(abs(backward / forward)))


def validate_result(value):
    """Stock-specific immutable result admission, after generic finite JSON checks."""
    if value.get("schema") != "fairbeam.stock-result/1" or value.get("status") not in ("results_exported", "validation_failed"):
        raise ValueError("Stock cell result schema/status invalid; results are never mesh-qualified")
    count = len(value["frequency_hz"])
    checked = validate_spec(value.get("settings"))
    if value.get("layout") != checked["layout"]:
        raise ValueError("Stock cell layout does not match its settings")
    settings = checked["settings"]
    if value["frequency_hz"] != np.linspace(settings["f_min_hz"], settings["f_max_hz"], 301).tolist():
        raise ValueError("Stock cell frequency sweep does not match its settings")
    for key in ("s11_real", "s11_imag", "s21_real", "s21_imag"):
        vals = value.get(key)
        if not isinstance(vals, list) or len(vals) != count or any(type(v) not in (int, float) or not math.isfinite(v) for v in vals):
            raise ValueError("Stock cell complex trace missing or invalid")
    phase = value.get("reflection_phase_deg")
    if not isinstance(phase, list) or len(phase) != count:
        raise ValueError("Stock reflection phase axis invalid")
    if value.get("reflection_phase_floor") != 1e-3:
        raise ValueError("Stock reflection phase floor changed")
    for re, im, angle in zip(value["s11_real"], value["s11_imag"], phase):
        expected = math.degrees(math.atan2(im, re)) if math.hypot(re, im) >= 1e-3 else None
        if (expected is None and angle is not None) or (expected is not None and (type(angle) not in (int, float) or abs(angle - expected) > 1e-10)):
            raise ValueError("Stock reflection phase does not match its complex trace/floor")
    qa = value.get("qa", {})
    required = ("energy_converged", "empty_reference_pass", "co_polar_power_upper_bound_pass", "paired_mesh_pass", "paired_timestep_pass")
    if any(type(qa.get(k)) is not bool for k in required) or qa.get("mesh_convergence_checked") is not False:
        raise ValueError("Stock cell pair/QA provenance missing")
    if value["status"] == "results_exported" and not all(qa[k] for k in required):
        raise ValueError("Stock exported completion contradicts numerical checks")
    power = max(re * re + im * im + tr * tr + ti * ti for re, im, tr, ti in
                zip(value["s11_real"], value["s11_imag"], value["s21_real"], value["s21_imag"]))
    if type(qa.get("co_polar_power_max")) not in (int, float) or abs(qa["co_polar_power_max"] - power) > 1e-10 or qa["co_polar_power_upper_bound_pass"] != (power <= 1.01):
        raise ValueError("Stock power check contradicts complex traces")
    reflection = qa.get("empty_reference_max_reflection")
    if type(reflection) not in (int, float) or not math.isfinite(reflection) or reflection < 0 or qa["empty_reference_pass"] != (reflection <= .001):
        raise ValueError("Stock reference check invalid")
    if value["status"] == "results_exported" and qa.get("analytic_pass", True) is not True:
        raise ValueError("Stock completion contradicts analytic control")
    if value.get("layout", {}).get("boundaries") != BOUNDARIES:
        raise ValueError("Stock cell boundary identity missing")
    material = value.get("material", {})
    if type(material.get("requested")) is not bool or type(material.get("available")) is not bool or material.get("qualified") is not False:
        raise ValueError("Stock NRW scope missing")
    if material["requested"] != settings["nrw"] or material.get("thickness_mm") != settings["back_mm"] - settings["front_mm"] or material.get("sin_floor") != settings["nrw_sin_floor"]:
        raise ValueError("Stock NRW thickness/settings identity mismatch")
    provenance = value.get("provenance", {})
    hashes, timesteps = provenance.get("mesh_and_probe_sha256"), provenance.get("measured_timesteps_s")
    if (not isinstance(hashes, list) or len(hashes) != 2 or hashes[0] != hashes[1] or
            any(not isinstance(h, str) or len(h) != 64 or any(c not in "0123456789abcdef" for c in h) for h in hashes) or
            not isinstance(timesteps, list) or len(timesteps) != 2 or
            any(type(dt) not in (int, float) or not math.isfinite(dt) or dt <= 0 or abs(dt / checked["layout"]["dt_s"] - 1) > 1e-5 for dt in timesteps) or
            abs(timesteps[1] / timesteps[0] - 1) > 1e-6):
        raise ValueError("Stock paired mesh/time provenance invalid")
    if (provenance.get("polarization") != "Ey" or provenance.get("incidence") != "+z normal" or
            provenance.get("phasor_convention") != "exp(+j omega t)" or provenance.get("reflection_phase_reference") != "front sample face" or
            provenance.get("s_parameter_planes_mm") != [settings["front_mm"], settings["back_mm"]]):
        raise ValueError("Stock phase/source reference invalid")
    material_fields = ("reliable", "eps_real", "eps_imag", "mu_real", "mu_imag")
    if material["available"] or any(key in material for key in material_fields):
        flags = material.get("reliable")
        if not material["requested"] or not isinstance(flags, list) or len(flags) != count or not all(type(v) is bool for v in flags):
            raise ValueError("Stock NRW reliable-point mask invalid")
        if material["available"] != any(flags):
            raise ValueError("Stock NRW availability contradicts its reliable-point mask")
        for key in ("eps_real", "eps_imag", "mu_real", "mu_imag"):
            vals = material.get(key)
            if not isinstance(vals, list) or len(vals) != count or any((type(v) not in (int, float) or not math.isfinite(v)) if ok else v is not None for v, ok in zip(vals, flags)):
                raise ValueError("Unreliable NRW points must remain unavailable")
        segments = material.get("segments")
        if any(flags) and (not isinstance(segments, list) or not segments):
            raise ValueError("NRW branch provenance missing")
        for f, reliable in zip(value["frequency_hz"], flags):
            if reliable and not any(isinstance(segment, dict) and segment.get("branch_resolved") is True and
                                    type(segment.get("f_min")) in (int, float) and type(segment.get("f_max")) in (int, float) and
                                    segment["f_min"] <= f <= segment["f_max"] for segment in segments):
                raise ValueError("Unresolved NRW branches cannot supply reliable points")
    return value


def _build(spec, sample):
    from .simulation import Simulation
    s, l = spec["settings"], spec["layout"]
    sim = Simulation(s["f_min_hz"], s["f_max_hz"], max_timesteps=MAX_STEPS, end_criteria_db=-70)
    sim.boundaries = BOUNDARIES.copy()
    sim.fdtd.SetBoundaryCond(sim.boundaries)
    xs = np.linspace(-s["period_x_mm"] / 2, s["period_x_mm"] / 2, l["nx"] + 1)
    ys = np.linspace(-s["period_y_mm"] / 2, s["period_y_mm"] / 2, l["ny"] + 1)
    zs = s["front_mm"] + np.arange(-l["gap_steps"] - 24, l["sample_steps"] + l["gap_steps"] + 21) * l["dz_mm"]
    for axis, lines in zip("xyz", (xs, ys, zs)):
        sim.mesh.AddLine(axis, lines)
    front_index = l["gap_steps"] + 24
    z1, z2 = zs[24], zs[front_index + l["sample_steps"] + l["gap_steps"]]
    zcheck = zs[24 + max(1, l["gap_steps"] // 2)]
    exc = sim.csx.AddExcitation("stock_source", exc_type=0, exc_val=[0, 1, 0])
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



def run(spec, outdir, executable=None):
    """Run sequential empty/sample cases in a fresh directory. Caller serializes jobs.

    Native subprocesses inherit the worker process group / Windows Job Object so
    queue cancellation kills the entire tree. Partial evidence is always retained.
    """
    from .simulation import _parse_log
    from .material_cell import cell_sparams, probe_timestep
    from openEMS.ports import UI_data
    if not isinstance(spec, dict) or spec.get("schema") != "fairbeam.stock-cell/1":
        raise ValueError("run requires a validate_spec result")
    checked = validate_spec(spec["input_settings"], spec.get("source_design"))
    if checked != spec:
        raise ValueError("Normalized stock specification changed; revalidate before running")
    capability = probe(executable)
    if not capability["available"]:
        raise ValueError(capability["reason"])
    out = Path(outdir).resolve()
    out.mkdir(parents=True, exist_ok=False)
    _save(out / "input.json", spec)
    shutil.copy2(__file__, out / "stock_cell-source.py")
    shutil.copy2(Path(__file__).with_name("periodic_xml.py"), out / "periodic_xml.py")
    s, layout = spec["settings"], spec["layout"]
    manifest = {"schema": 1, "backend": "stock", "status": "model_built", "started_utc": _stamp(),
                "evidence_domain": "synthetic", "acceleration": "CPU basic", "threads": 1,
                "capability": capability, "generator_sha256": _sha(__file__),
                "xml_writer_sha256": _sha(Path(__file__).with_name("periodic_xml.py")),
                "input_sha256": _sha(out / "input.json"), "platform": platform.platform(),
                "python_version": sys.version, "numpy_version": np.__version__,
                "support_source_sha256": {name: _sha(Path(__file__).with_name(name))
                                          for name in ("simulation.py", "material_cell.py", "analytic.py", "nrw.py", "periodic_cell.py")},
                "input_provenance": "User-provided design/boxes or assumed synthetic fixture; no measured material claim.",
                "layout": layout, "cases": [], "limitations": LIMITATIONS.copy()}
    _save(out / "manifest.json", manifest)
    frequencies = np.linspace(s["f_min_hz"], s["f_max_hz"], 301)
    waves, stats, mesh_hashes, used_timesteps = [], [], [], []
    try:
        for role in ("reference", "sample"):
            case = out / role
            case.mkdir()
            sim, names, planes = _build(spec, role == "sample")
            mesh_payload = {axis: [float(v) for v in sim.mesh.GetLines(axis)] for axis in "xyz"}
            mesh_payload.update(probes=names, reference_planes_mm=planes, boundaries=sim.boundaries, timestep_s=layout["dt_s"])
            mesh_hash = hashlib.sha256(json.dumps(mesh_payload, sort_keys=True, allow_nan=False).encode()).hexdigest()
            if mesh_hashes and mesh_hash != mesh_hashes[0]:
                raise ValueError("Reference/sample mesh, source/probe layout or timestep changed before sample launch")
            mesh_hashes.append(mesh_hash)
            xml = case / "model.xml"
            _write_xml(sim, xml)
            command = [capability["path"], str(xml), "--engine=basic"]
            record = {"role": role, "status": "model_built", "xml_sha256": _sha(xml), "command": command,
                      "mesh_and_probe_sha256": mesh_hash, "timestep_forced_s": layout["dt_s"]}
            manifest["cases"].append(record)
            record.update(status="solver_started", started_utc=_stamp())
            manifest["status"] = "solver_started"
            _save(out / "manifest.json", manifest)
            print(f"Stock cell {role}: {layout['cells']} cells, CPU basic", flush=True)
            start = time.monotonic()
            with (case / "solver.log").open("w", encoding="utf-8") as log:
                process = subprocess.run(command, cwd=case, stdout=log, stderr=subprocess.STDOUT,
                                         timeout=TIMEOUT_S, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            record.update(exit_code=process.returncode, wall_s=time.monotonic() - start, finished_utc=_stamp())
            if process.returncode:
                raise RuntimeError(f"Stock cell {role} solver exited with {process.returncode}; see {case / 'solver.log'}")
            record["status"] = "solver_returned"
            record["stats"] = _parse_log((case / "solver.log").read_text(encoding="utf-8", errors="replace"), -70, MAX_STEPS)
            if role == "reference" and record["stats"].get("converged") is not True:
                raise ValueError("Empty reference did not reach the energy target; sample was not launched")
            vals = [np.mean(UI_data(group, str(case), frequencies).ui_f_val, axis=0) for group in names]
            if not all(np.isfinite(v).all() for v in vals):
                raise ValueError("Nonfinite stock probe amplitudes")
            if role == "reference":
                forward, backward, reflection = _reference_waves(frequencies, vals, planes)
                record["empty_reference_max_reflection"] = reflection
                if reflection > .001:
                    raise ValueError("Empty-reference reflection gate failed; sample was not launched")
            actual_dt = probe_timestep(case / names[0][0], layout["dt_s"])
            if abs(actual_dt / layout["dt_s"] - 1) > 1e-5:
                raise ValueError("Native probe time axis does not match the explicit timestep")
            if used_timesteps and abs(actual_dt / used_timesteps[0] - 1) > 1e-6:
                raise ValueError("Reference/sample measured timesteps differ")
            used_timesteps.append(actual_dt)
            record.update(status="results_exported", probe_timestep_s=actual_dt,
                          probe_sha256={name: _sha(case / name) for group in names for name in group})
            _save(out / "manifest.json", manifest)
            waves.append(vals)
            stats.append(record["stats"])
        result = cell_sparams(frequencies, waves[0][:2], waves[1][:2], planes[0], planes[1], s["front_mm"], s["back_mm"])
        s11, s21 = result["s11"], result["s21"]
        if not np.isfinite(s11).all() or not np.isfinite(s21).all():
            raise ValueError("Nonfinite normalized stock response")
        power = abs(s11) ** 2 + abs(s21) ** 2
        qa = {"energy_converged": all(bool(t.get("converged")) for t in stats),
              "empty_reference_max_reflection": reflection, "empty_reference_pass": reflection <= .001,
              "co_polar_power_max": float(np.max(power)), "co_polar_power_upper_bound_pass": bool(np.max(power) <= 1.01),
              "mesh_convergence_checked": False,
              "paired_mesh_pass": mesh_hashes[0] == mesh_hashes[1],
              "paired_timestep_pass": abs(used_timesteps[1] / used_timesteps[0] - 1) <= 1e-6}
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
        phase = [float(np.degrees(np.angle(v))) if abs(v) >= 1e-3 else None for v in s11]
        material = material_result(frequencies, s11, s21, s)
        _save(out / "material.json", material)
        import csv
        with (out / "sparameters.csv").open("w", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream)
            writer.writerow(["frequency_hz", "s11_real", "s11_imag", "s21_real", "s21_imag", "reflection_phase_deg",
                             "nrw_reliable", "eps_real", "eps_imag", "mu_real", "mu_imag"])
            for k, frequency in enumerate(frequencies):
                writer.writerow([frequency, s11[k].real, s11[k].imag, s21[k].real, s21[k].imag, phase[k],
                                 material.get("reliable", [False] * len(frequencies))[k],
                                 *[material.get(key, [None] * len(frequencies))[k] for key in ("eps_real", "eps_imag", "mu_real", "mu_imag")]])
        output = {"schema": "fairbeam.stock-result/1", "backend": "stock",
                  "status": "results_exported" if passed else "validation_failed",
                  "validation_scope": "Paired-run numerical gates only; no mesh-convergence or material-retrieval qualification.",
                  "frequency_hz": frequencies.tolist(), "s11_real": s11.real.tolist(), "s11_imag": s11.imag.tolist(),
                  "s21_real": s21.real.tolist(), "s21_imag": s21.imag.tolist(), "qa": qa,
                  "reflection_phase_deg": phase, "reflection_phase_floor": 1e-3, "material": material,
                  "settings": s, "layout": layout, "limitations": LIMITATIONS.copy(),
                  "provenance": {"input": "input.json", "manifest": "manifest.json", "raw_cases": ["reference", "sample"],
                                 "complex_sha256": _sha(out / "complex.npz"), "csv_sha256": _sha(out / "sparameters.csv"),
                                 "material_sha256": _sha(out / "material.json"), "mesh_and_probe_sha256": mesh_hashes,
                                 "measured_timesteps_s": used_timesteps, "symmetry": spec["symmetry"],
                                 "capabilities": capability, "reference_planes_mm": planes[:2],
                                 "s_parameter_planes_mm": [s["front_mm"], s["back_mm"]],
                                 "polarization": "Ey", "incidence": "+z normal", "normalization": "empty reference/sample pair",
                                 "phasor_convention": "exp(+j omega t)", "reflection_phase_reference": "front sample face"}}
        validate_result(output)
        _save(out / "result.json", output)
        manifest.update(status=output["status"], finished_utc=_stamp(), qa=qa)
        _save(out / "manifest.json", manifest)
        return output
    except BaseException as exc:
        manifest.update(status="failed", failure=str(exc), finished_utc=_stamp())
        _save(out / "manifest.json", manifest)
        raise
