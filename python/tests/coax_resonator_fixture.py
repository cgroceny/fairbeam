"""Own half-wave coaxial ring-down fixture, Example 6.1 (p. 280).

PMC ends describe an ideal open circuit: no end-cap, fringe, radiation or
external-coupling loss. Copper uses an explicit thick symmetric-sheet
half-space surrogate, sigma_bulk/4, NOT spatially resolved bulk copper.
Native full-conductivity sheets are a separate diagnostic. No bundle export.

Sheet implementation: github.com/thliebig/openEMS/blob/v0.37.0-rc3/FDTD/
extensions/operator_ext_conductingsheet.cpp. The native fast-energy proxy is
EPS0*sum(V**2)+MU0*sum(I**2), not a physical volume energy integral; see
FDTD/engine_interface_fdtd.cpp. et is the excitation signal, not energy.
"""
import hashlib
import json
import math
import os
from pathlib import Path
from datetime import datetime, timezone

import numpy as np
import openEMS
from CSXCAD import ContinuousStructure
from openEMS.physical_constants import C0, EPS0, MUE0

from fairbeam.excitation import dgauss_duration_s
from fairbeam.simulation import Simulation

A, B, F0 = .001, .004, 5e9
SIGMA, EPS_R, TAN_D = 5.8e7, 2.08, .0004
END_DB, CAP_S = -80., 1.6e-6
KINDS = ("air_copper", "ptfe_copper", "ptfe_dielectric", "ptfe_both")
WINDOWS = ((20e-9, 100e-9), (100e-9, 180e-9), (180e-9, 260e-9))
GATES = dict(f_target=.002, q_target=.03, f_mesh=.0005, q_mesh=.02,
             f_control=.0002, q_control=.01, f_probe=1e-5, q_probe=.003,
             q_window=.005, ar_residual=.002, energy_agreement=.03,
             energy_log_rms=.4, energy_q_uncertainty=.03)
SCOPE = ("Ideal axisymmetric half-wave TEM, opaque PEC backing, PMC open ends; "
         "unloaded Q, constant dielectric conductivity, declared sheet surrogate")


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def identity():
    root = Path(__file__).resolve().parents[1]
    names = ("tests/coax_resonator_fixture.py", "tests/test_coax_resonator.py",
             "fairbeam/simulation.py", "fairbeam/excitation.py", "fairbeam/procutil.py")
    return {name: sha(root / name) for name in names}


def runtime_identity():
    """Fingerprint the imported bindings and configured native libraries."""
    binding = Path(openEMS.__file__).parent
    files = list(binding.glob("*.pyd")) + list(binding.glob("*.so"))
    prefix = os.environ.get("OPENEMS_INSTALL_PATH")
    if prefix:
        for directory in (Path(prefix), Path(prefix) / "lib", Path(prefix) / "lib64", Path(prefix) / "bin"):
            for pattern in ("*openEMS*.dll", "*CSXCAD*.dll", "*openEMS*.so*", "*CSXCAD*.so*", "*openEMS*.dylib", "*CSXCAD*.dylib"):
                files.extend(directory.glob(pattern))
    hashes = {str(path.resolve()): sha(path) for path in sorted(set(files)) if path.is_file()}
    if not hashes:
        raise ValueError("native runtime identity is unavailable")
    return dict(binding_version=openEMS.__version__, files=hashes)


def reference(kind):
    if kind not in KINDS + ("air_native_sheet",):
        raise ValueError("unknown loss case")
    eps = 1. if kind.startswith("air_") else EPS_R
    copper = kind != "ptfe_dielectric"
    td = TAN_D if kind in ("ptfe_dielectric", "ptfe_both") else 0.
    omega, length = 2 * np.pi * F0, C0 / (2 * F0 * np.sqrt(eps))
    rs = np.sqrt(np.pi * F0 * MUE0 / SIGMA)
    inductance = MUE0 * np.log(B / A) / (2 * np.pi)
    capacitance = 2 * np.pi * EPS0 * eps / np.log(B / A)
    resistance = rs * (1 / A + 1 / B) / (2 * np.pi)
    qc = omega * inductance / resistance
    inv_q = (1 / qc if copper else 0.) + td
    return dict(eps_r=eps, tan_d=td, length_m=float(length),
                zc_ohm=float(np.sqrt(inductance / capacitance)), rs_ohm=float(rs),
                skin_depth_m=float(np.sqrt(2 / (omega * MUE0 * SIGMA))),
                qc=float(qc), q_unloaded=float(1 / inv_q), f_hz=F0,
                sigma_dielectric=float(td * omega * EPS0 * eps), copper=copper,
                sheet_sigma=SIGMA if kind == "air_native_sheet" else SIGMA / 4,
                end_cap_loss_included=False)


class CoaxSimulation(Simulation):
    def to_bundle(self, *args, **kwargs):
        raise ValueError("raw cylindrical research geometry cannot be exported as a Cartesian bundle")


def build(n, kind, angular=4, margin=2, cap_s=CAP_S):
    if isinstance(n, bool) or not isinstance(n, int) or n not in (8, 12, 16):
        raise ValueError("radial mesh must be 8, 12 or 16")
    if angular not in (4, 8, 16) or margin not in (2, 3) or not 0 < cap_s <= CAP_S:
        raise ValueError("invalid angular/enclosure/cap control")
    ref = reference(kind)
    sim = CoaxSimulation(4.5e9, 5.5e9, boundaries=["PEC"] * 4 + ["PMC"] * 2,
                         end_criteria_db=END_DB)
    csx = ContinuousStructure(CoordSystem=1)
    sim.fdtd.SetCSX(csx)
    sim.csx, sim.mesh = csx, csx.GetGrid()
    sim.mesh.SetDeltaUnit(sim.unit)
    sim.mesh.SetMeshType(1)
    sim.fdtd.SetCoordSystem(1)
    a, b, length = A / sim.unit, B / sim.unit, ref["length_m"] / sim.unit
    dr = (b - a) / n
    radius = a + dr * np.arange(-margin, n + margin + 1)
    radius[margin], radius[margin + n] = a, b
    if radius[0] <= 0:
        raise ValueError("enclosure must not reach the cylindrical axis")
    angle = np.linspace(0, 2 * np.pi, angular + 1)
    dz = length / (10 * n)
    # Native PMC zeros H at dual indices 0 and numLines-2: place these planes
    # at physical z=0,L. See Operator::ApplyMagneticBC in the rc3 source.
    z = dz * (np.arange(10 * n + 2) - .5)
    for axis, lines in zip("xyz", (radius, angle, z)):
        sim.mesh.AddLine(axis, lines)
    # Conservative vacuum CFL including the smallest cylindrical arc, not
    # Simulation.cfl_timestep(), which is a Cartesian calculation.
    dt = .9 * sim.unit / (C0 * np.sqrt(dr ** -2 + (radius[0] * angle[1]) ** -2
                                     + (z[1] - z[0]) ** -2))
    # Keep the n12 angular comparisons at the same native timestep; avoid
    # confounding periodic seam sensitivity with temporal discretization.
    dt = min(dt, .38e-12)
    steps = int(math.ceil(cap_s / dt))
    sim.max_timesteps = steps
    sim.fdtd.SetNumberOfTimeSteps(steps)
    sim.fdtd.SetTimeStep(dt)
    fill = sim.dielectric("fill", ref["eps_r"], tan_d=ref["tan_d"], tan_d_freq=F0)
    fill.AddBox([radius[0], 0, z[0]], [radius[-1], 2 * np.pi, z[-1]], priority=1)
    # Finite PEC backing blocks exclude stray TEM cavities behind the sheets.
    sim.metal("inner_backing").AddBox([radius[0], 0, z[0]], [a, 2 * np.pi, z[-1]], priority=10)
    sim.metal("outer_backing").AddBox([b, 0, z[0]], [radius[-1], 2 * np.pi, z[-1]], priority=10)
    if ref["copper"]:
        for name, r in (("inner_sheet", a), ("outer_sheet", b)):
            sim.metal(name, conductivity=ref["sheet_sigma"], thickness=.035).AddBox(
                [r, 0, z[0]], [r, 2 * np.pi, z[-1]], priority=11)
    source = csx.AddExcitation("TEM_source", exc_type=0, exc_val=[1, 0, 0])
    source.SetWeightFunction([f"{a:.17g}/rho*cos(pi*z/{length:.17g})", "0", "0"])
    source.AddBox([a, 0, 0], [b, 2 * np.pi, length])
    for i, plane in enumerate((length / 4, 3 * length / 4)):
        csx.AddProbe(f"u{i}", p_type=10, mode_function=[f"{a:.17g}/rho", "0", "0"]).AddBox(
            [a, 0, plane], [b, 2 * np.pi, plane])
    # A closed 2pi mesh gets one native periodic ghost angular line.
    native_lines = [len(radius), len(angle) + 1, len(z)]
    meta = dict(n=n, kind=kind, angular=angular, margin=margin, cap_s=cap_s,
                declared_dt_s=float(dt), max_timesteps=steps,
                input_lines=[len(radius), len(angle), len(z)], native_lines=native_lines,
                reported_grid_lines=[len(radius), angular, len(z)],
                native_cells=int(np.prod(native_lines)), source_duration_s=dgauss_duration_s(sim.f_max),
                reference=ref, scope=SCOPE)
    return sim, meta


def field_pole(t, y):
    """Free complex-pole AR(2) fit, without prescribing frequency or damping."""
    t, y = np.asarray(t, float), np.asarray(y, float)
    if len(t) != len(y) or len(t) < 100 or not np.all(np.isfinite(y)) or not np.all(np.isfinite(t)):
        raise ValueError("finite, matching, sufficiently long field trace required")
    dt = (t[-1] - t[0]) / (len(t) - 1)
    if dt <= 0 or np.any(np.diff(t) <= 0) or np.max(abs(np.diff(t) / dt - 1)) > .01:
        raise ValueError("field clock is not uniform within printed precision")
    scale = np.sqrt(np.mean(y ** 2))
    if not scale > 0:
        raise ValueError("zero field trace")
    y = y / scale
    x = np.column_stack((y[1:-1], y[:-2], np.ones(len(y) - 2)))
    coefficients = np.linalg.lstsq(x, y[2:], rcond=None)[0]
    roots = np.roots([1., -coefficients[0], -coefficients[1]])
    root = roots[np.argmax(roots.imag)]
    if root.imag <= 0 or not 0 < abs(root) < 1:
        raise ValueError("not an oscillatory decaying pole; signed damping is not clipped")
    omega, alpha = np.angle(root) / dt, -np.log(abs(root)) / dt
    residual = np.linalg.norm(x @ coefficients - y[2:]) / np.linalg.norm(y[2:])
    return dict(f_hz=float(omega / (2 * np.pi)), q=float(omega / (2 * alpha)),
                alpha_s=float(alpha), relative_residual=float(residual), sample_dt_s=float(dt))


def energy_decay(t, energy, f_hz, *, phase_corrected=False):
    """Independent native fast-energy trend, not et or a physical energy integral.

    Whole-domain proxy can oscillate with E/H phase and has sparse wall-clock
    sampling. Retain log-fit residual, slope uncertainty and insufficient-data
    failure instead of treating every fitted number as a Q measurement.
    """
    t, energy = np.asarray(t, float), np.asarray(energy, float)
    if (len(t) != len(energy) or len(t) < 20 or not np.all(np.isfinite(t))
            or not np.all(np.isfinite(energy)) or np.any(energy <= 0) or np.any(np.diff(t) <= 0)):
        raise ValueError("at least 20 positive native energy samples on an increasing clock required")
    x = t - t.mean()
    y = np.log(energy)
    slope = float(np.dot(x, y - y.mean()) / np.dot(x, x))
    if slope >= 0:
        raise ValueError("energy does not decay")
    residual = y - (y.mean() + slope * x)
    rms = float(np.sqrt(np.mean(residual ** 2)))
    stderr = np.sqrt(np.dot(residual, residual) / (len(t) - 2) / np.dot(x, x))
    result = dict(q=float(-2 * np.pi * f_hz / slope), log_rms=rms,
                q_rel_95_uncertainty=float(1.96 * stderr / abs(slope)), samples=len(t),
                fitted_span_db=float(-slope * np.ptp(t) * 10 / np.log(10)))
    if not phase_corrected:
        return result
    # Whole-domain single-mode proxy: exp(-beta*t)*(c0+c1*cos(2wt)+c2*sin(2wt)).
    # Use the measured field frequency, not an analytical damping target.
    phase = 4 * np.pi * f_hz * t
    basis = np.column_stack((np.ones(len(t)), np.cos(phase), np.sin(phase)))
    e = energy / np.max(energy)
    def fit(beta):
        design = basis * (np.exp(-beta * x) / e)[:, None]
        coeff = np.linalg.lstsq(design, np.ones(len(t)), rcond=None)[0]
        pred = design @ coeff
        if coeff[0] <= np.hypot(coeff[1], coeff[2]) or np.any(pred <= 0):
            return np.inf, coeff, pred
        return float(np.mean(np.log(pred) ** 2)), coeff, pred
    grid = np.geomspace(-slope / 4, -slope * 4, 81)
    losses = [fit(beta)[0] for beta in grid]
    i = int(np.argmin(losses))
    if i in (0, len(grid) - 1) or not np.isfinite(losses[i]):
        raise ValueError("energy damping minimum is not bracketed by the measured trend")
    lo, hi = grid[i-1], grid[i+1]
    for _ in range(60):
        left, right = lo + (hi - lo) * .38196601125, lo + (hi - lo) * .61803398875
        if fit(left)[0] < fit(right)[0]:
            hi = right
        else:
            lo = left
    beta = (lo + hi) / 2
    loss, _, pred = fit(beta)
    design = basis * (np.exp(-beta * x) / e)[:, None]
    # Dimensionless log-damping coordinate avoids losing the small seconds
    # column below the covariance matrix's numerical rank tolerance.
    jac = np.column_stack((design / pred[:, None], -beta * x))
    covariance = loss * len(t) / (len(t) - 4) * np.linalg.pinv(jac.T @ jac)
    return dict(q=float(2 * np.pi * f_hz / beta), log_rms=float(np.sqrt(loss)),
                q_rel_95_uncertainty=float(1.96 * np.sqrt(covariance[-1, -1])), samples=len(t),
                fitted_span_db=float(beta * np.ptp(t) * 10 / np.log(10)),
                plain_log_fit=result, phase_corrected=True, frequency_from_field_hz=float(f_hz))


def acquire(out, n, kind, angular=4, margin=2, cap_s=CAP_S):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    source = identity()
    runtime = runtime_identity()
    sim, meta = build(n, kind, angular, margin, cap_s)
    sim.fdtd.Write2XML(str(out / "input.xml"))
    meta.update(source_sha256=source, runtime=runtime, input_sha256=sha(out / "input.xml"), gates=GATES,
                started_at_utc=datetime.now(timezone.utc).isoformat())
    save(out / "declared.json", meta)
    sim.run(str(out / "raw"), threads=1, echo=True, exact=True, dump_statistics=True)
    stats = np.loadtxt(out / "raw/openEMS_stats.txt", comments="%")
    run_energy = np.loadtxt(out / "raw/openEMS_run_stats.txt", comments="%", ndmin=2)
    traces = [np.loadtxt(out / f"raw/u{i}", comments="%", ndmin=2) for i in range(2)]
    for trace in traces[1:]:
        np.testing.assert_array_equal(trace[:, 0], traces[0][:, 0])
    # currE is the last fixed-Nyquist evaluation, not the progress timestep.
    nyquist = int(1 / (2 * sim.f_max * stats[1]))
    energy_steps = np.floor(run_energy[:, 1] / nyquist) * nyquist
    np.savez_compressed(out / "data.npz", t=traces[0][:, 0], u=np.array([v[:, 1] for v in traces]),
                        energy_t=energy_steps * stats[1], energy=run_energy[:, 3],
                        progress_t=run_energy[:, 1] * stats[1])
    if source != identity() or runtime != runtime_identity():
        raise RuntimeError("source/runtime changed during acquisition")
    meta.update(run=sim.run_stats, native=dict(cells=int(stats[0]), dt_s=float(stats[1]),
                timesteps=int(stats[2]), numerical_time_s=float(stats[3]), iteration_wall_s=float(stats[4])),
                data_sha256=sha(out / "data.npz"), completed_at_utc=datetime.now(timezone.utc).isoformat())
    save(out / "report.json", meta)
    return meta


def read(out):
    out = Path(out)
    meta = json.loads((out / "report.json").read_text(encoding="utf-8"))
    if meta["source_sha256"] != identity() or meta["gates"] != GATES:
        raise ValueError("source/protocol identity changed; old cohorts must remain separate")
    if meta["runtime"] != runtime_identity():
        raise ValueError("native runtime identity changed")
    if meta.get("native_header", {}).get("version") != "v0.37.0-rc3":
        raise ValueError("audited native engine header required")
    if sha(out / "input.xml") != meta["input_sha256"] or sha(out / "data.npz") != meta["data_sha256"]:
        raise ValueError("input/data identity changed")
    _, expected = build(meta["n"], meta["kind"], meta["angular"], meta["margin"], meta["cap_s"])
    if any(meta[k] != expected[k] for k in expected):
        raise ValueError("case parameters do not match their recorded protocol")
    native, run = meta["native"], meta["run"]
    clock_ok = abs(native["dt_s"] / meta["declared_dt_s"] - 1) < 1e-8
    grid_ok = run.get("grid") == meta["reported_grid_lines"] and native["cells"] == meta["native_cells"]
    stopped = bool(run.get("converged") and native["timesteps"] < meta["max_timesteps"]
                   and native["numerical_time_s"] > meta["source_duration_s"] and run.get("threads") == 1)
    poles, energy_fit, errors = [], None, []
    with np.load(out / "data.npz") as data:
        for i, signal in enumerate(data["u"]):
            for j, (lo, hi) in enumerate(WINDOWS):
                mask = (data["t"] >= lo) & (data["t"] < hi)
                try:
                    poles.append(dict(probe=i, window=j, **field_pole(data["t"][mask], signal[mask])))
                except ValueError as exc:
                    errors.append(f"probe {i}, window {j}: {exc}")
        if len(poles) == 6:
            fs, qs = np.array([p["f_hz"] for p in poles]), np.array([p["q"] for p in poles])
            energy = data["energy"]
            if energy.size:
                db = 10 * np.log10(energy / energy.max())
                mask = ((data["energy_t"] > WINDOWS[0][0]) & (db <= -10) & (db >= -60))
                try:
                    energy_fit = energy_decay(data["energy_t"][mask], energy[mask], fs.mean(), phase_corrected=True)
                except ValueError as exc:
                    errors.append(str(exc))
        else:
            fs, qs = np.array([]), np.array([])
    ref = meta["reference"]
    result = dict(kind=meta["kind"], n=meta["n"], angular=meta["angular"], margin=meta["margin"],
                  source_complete=native["numerical_time_s"] > meta["source_duration_s"],
                  stopped=stopped, clock_ok=clock_ok, grid_ok=grid_ok, poles=poles,
                  energy_proxy=energy_fit, extraction_errors=errors, qualified=False)
    if len(poles) == 6:
        freq, q = float(fs.mean()), float(qs.mean())
        f_probe = float(max(abs(fs.reshape(2, 3)[0] - fs.reshape(2, 3)[1])) / F0)
        q_probe = float(max(abs(qs.reshape(2, 3)[0] / qs.reshape(2, 3)[1] - 1)))
        q_window = float(max(np.ptp(qs.reshape(2, 3), axis=1)) / q)
        result.update(f_hz=freq, q=q, f_target_rel=abs(freq / F0 - 1),
                      q_target_rel=abs(q / ref["q_unloaded"] - 1), f_probe_rel=f_probe,
                      q_probe_rel=q_probe, q_window_rel=q_window)
        field_ok = (result["f_target_rel"] <= GATES["f_target"] and result["q_target_rel"] <= GATES["q_target"]
                    and f_probe <= GATES["f_probe"] and q_probe <= GATES["q_probe"]
                    and q_window <= GATES["q_window"]
                    and max(p["relative_residual"] for p in poles) <= GATES["ar_residual"])
        energy_ok = bool(energy_fit and energy_fit["fitted_span_db"] >= 30
                         and energy_fit["log_rms"] <= GATES["energy_log_rms"]
                         and energy_fit["q_rel_95_uncertainty"] <= GATES["energy_q_uncertainty"]
                         and abs(energy_fit["q"] / q - 1) <= GATES["energy_agreement"])
        result.update(field_passes=bool(field_ok), energy_proxy_passes=energy_ok,
                      matches=bool(stopped and clock_ok and grid_ok and field_ok and energy_ok))
    else:
        result["matches"] = False
    save(out / "comparison.json", result)
    return result


def study(root, meshes=(8, 12, 16), kinds=KINDS):
    root = Path(root)
    if len(meshes) != 3 or list(meshes) != sorted(set(meshes)) or any(n not in (8, 12, 16) for n in meshes):
        raise ValueError("three distinct increasing meshes required")
    if not kinds or len(kinds) != len(set(kinds)) or any(k not in KINDS for k in kinds):
        raise ValueError("distinct supported loss cases required")
    result = {}
    for kind in kinds:
        rows = [read(root / f"n{n}" / kind) for n in meshes]
        controls = [read(root / f"n{meshes[1]}_{name}" / kind) for name in ("angular", "enclosure")]
        for row, expected in zip(rows + controls, [(n, 4, 2) for n in meshes] +
                                 [(meshes[1], 8, 2), (meshes[1], 4, 3)]):
            if (row["n"], row["angular"], row["margin"]) != expected:
                raise ValueError("mesh/control identity does not match the study layout")
        for i, row in enumerate(rows):
            if i and all("q" in r for r in rows[i-1:i+1]):
                row.update(f_mesh_rel=abs(row["f_hz"] - rows[i-1]["f_hz"]) / F0,
                           q_mesh_rel=abs(row["q"] / rows[i-1]["q"] - 1))
        changes = [dict(f_control_rel=abs(c.get("f_hz", 0) - rows[1].get("f_hz", F0)) / F0,
                        q_control_rel=abs(c.get("q", 0) / rows[1].get("q", 1) - 1)) for c in controls]
        qualified = (all(r["matches"] for r in rows + controls)
                     and all(r.get("f_mesh_rel", 1) <= GATES["f_mesh"]
                             and r.get("q_mesh_rel", 1) <= GATES["q_mesh"] for r in rows[1:])
                     and all(c["f_control_rel"] <= GATES["f_control"]
                             and c["q_control_rel"] <= GATES["q_control"] for c in changes))
        result[kind] = dict(meshes=rows, controls=controls, control_changes=changes,
                            qualified=bool(qualified), scope=SCOPE)
    save(root / "comparison.json", result)
    return result
