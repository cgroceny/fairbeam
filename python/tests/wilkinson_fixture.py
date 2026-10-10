"""Own untrimmed microstrip realization associated with Example 7.2 (p. 331).

The gallery generator is read only. Absolute phase at a calibrated launch plane
is outside this fixture's scope. Raw magnitudes, output phase balance, complex
mesh changes and independent boundary/time controls are measured separately.
"""
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import sys

import numpy as np
from openEMS.physical_constants import C0

from fairbeam import analytic, excitation, mesh, model, multiport, simulation

ROOT = Path(__file__).resolve().parents[2]
GALLERY = ROOT / "python/models/wilkinson_divider.py"
F0, Z0 = 1e9, 50.
FREQUENCIES = np.linspace(.5*F0, 1.5*F0, 401)
MESHES = (4, 6, 8)
CAP_S, END_DB, THREADS = 20e-9, -80., 1
PROTOCOL = "untrimmed-wilkinson-v2"
LIMITS = dict(magnitude_target_abs=.05, complex_mesh_abs=.005,
              complex_control_abs=.003, phase_balance_target_deg=.5,
              phase_mesh_deg=.5, phase_control_deg=.2,
              reciprocity_abs=.005, singular_power_max=1.01,
              incident_condition_max=20., incident_floor_rel=.02)
SCOPE = ("Raw 50-ohm port magnitudes and output phase balance of our finite PEC "
         "microstrip realization; complex mesh and independent padding/time "
         "controls. No individually calibrated launch or complete ideal-network certification.")


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False)+"\n", encoding="utf-8")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def identity():
    paths = dict(fixture=Path(__file__), runner=Path(__file__).with_name("test_wilkinson_fixture.py"),
                 gallery=GALLERY, model=Path(model.__file__), simulation=Path(simulation.__file__),
                 excitation=Path(excitation.__file__), multiport=Path(multiport.__file__),
                 analytic=Path(analytic.__file__), mesh=Path(mesh.__file__))
    return {k: sha(p) for k, p in paths.items()}


def runtime_identity():
    import CSXCAD
    import openEMS
    result = dict(python=sys.version, executable=sys.executable, numpy=np.__version__,
                  openems_module=str(Path(openEMS.__file__).resolve()),
                  csxcad_module=str(Path(CSXCAD.__file__).resolve()), dlls={}, bindings_sha256={})
    for package in (openEMS, CSXCAD):
        directory = Path(package.__file__).resolve().parent
        for path in sorted(directory.glob("*.pyd")) + [Path(package.__file__)] + sorted(directory.glob("ports.py")):
            result["bindings_sha256"][str(path.resolve())] = sha(path)
    prefix = os.environ.get("OPENEMS_INSTALL_PATH")
    if os.name == "nt":
        if not prefix:
            raise ValueError("explicit bundled native runtime required on Windows")
        for name in ("openEMS.dll", "CSXCAD.dll", "fparser.dll", "nf2ff.dll"):
            path = Path(prefix)/name
            result["dlls"][name] = dict(path=str(path.resolve()), sha256=sha(path))
    return result


def reference(f=FREQUENCIES):
    """Independent even/odd-mode solution, with no nodal-network solver."""
    f = np.asarray(f, float)
    if f.ndim != 1 or not f.size or not np.isfinite(f).all() or np.any(f <= 0):
        raise ValueError("finite positive frequency vector required")
    theta, arm = np.pi*f/(2*F0), np.sqrt(2)*Z0
    c, s = np.cos(theta), np.sin(theta)
    branch = arm*(Z0*c+1j*arm*s)/(arm*c+1j*Z0*s)
    zin = branch/2
    s11 = (zin-Z0)/(zin+Z0)
    s21 = (1+s11)/(c+1j*arm/Z0*s)
    even = arm*(2*Z0*c+1j*arm*s)/(arm*c+2j*Z0*s)
    # The odd input node is a virtual short; half the isolation resistor
    # terminates each output in parallel with its shorted quarter-wave arm.
    odd_gamma = -Z0*c/(Z0*c+2j*arm*s)
    even_gamma = (even-Z0)/(even+Z0)
    out = np.zeros((len(f), 3, 3), complex)
    out[:, 0, 0] = s11
    out[:, 0, 1] = out[:, 0, 2] = out[:, 1, 0] = out[:, 2, 0] = s21
    out[:, 1, 1] = out[:, 2, 2] = (even_gamma+odd_gamma)/2
    out[:, 1, 2] = out[:, 2, 1] = (even_gamma-odd_gamma)/2
    return out


def parameters(n):
    if isinstance(n, bool) or not isinstance(n, int) or n not in MESHES:
        raise ValueError("declared integer mesh required")
    return dict(f0=F0/1e9, f_min=FREQUENCIES[0]/1e9, f_max=FREQUENCIES[-1]/1e9,
                sub_h=1.59, eps_r=2.08, tan_d=0., r_iso=2*Z0, gap=0.,
                offset=5., clearance=3., arm_scale=1., feed_len=10.,
                strip_cells=n, sub_cells=n, mesh_div=5*n)


def build(n, port, expanded=False, end_db=END_DB, cap_s=CAP_S):
    if (isinstance(port, bool) or not isinstance(port, int) or port not in (1, 2, 3)
            or not isinstance(expanded, bool) or end_db not in (-80., -100.)
            or not np.isfinite(cap_s) or not CAP_S <= cap_s <= 2*CAP_S):
        raise ValueError("declared port, padding, native stop and time cap required")
    generator = model.load_model(GALLERY)
    p = model.resolve_params(generator.PARAMS, parameters(n))
    with simulation.excite_only(port):
        sim = generator.build(p)
    original = {a: sim.mesh.GetLines(a).copy() for a in "xyz"}
    if expanded:
        for a in "xyz":
            lines = original[a]
            sim.mesh.AddLine(a, [lines[0]-8., lines[-1]+8.])
        sim.smooth_mesh(C0/FREQUENCIES[-1]/sim.unit/(5*n), 1.3)
        for a in "xyz":
            lines = sim.mesh.GetLines(a)
            np.testing.assert_array_equal(lines[(lines >= original[a][0]) & (lines <= original[a][-1])], original[a])
    sim.remove_nf2ff_box()
    axes = {a: sim.mesh.GetLines(a) for a in "xyz"}
    dt = .5/(C0*np.sqrt(sum((np.min(np.diff(v))*sim.unit)**-2 for v in axes.values())))
    steps = int(math.ceil(cap_s/dt))
    sim.max_timesteps, sim.end_criteria_db = steps, float(end_db)
    sim.fdtd.SetTimeStep(float(dt))
    sim.fdtd.SetOverSampling(4)
    sim.fdtd.SetNumberOfTimeSteps(steps)
    sim.fdtd.SetEndCriteria(10**(end_db/10))
    active = [p["number"] for p in sim.ports if p["excite"]]
    if active != [port]:
        raise ValueError("exactly one declared port must be excited")
    from fairbeam.analytic import microstrip_eps_eff, microstrip_width
    w50 = round(microstrip_width(Z0, p["eps_r"], p["sub_h"]), 3)
    w70 = round(microstrip_width(np.sqrt(2)*Z0, p["eps_r"], p["sub_h"]), 3)
    length = C0/F0/np.sqrt(microstrip_eps_eff(p["eps_r"], p["sub_h"], w70))/4
    meta = dict(protocol=PROTOCOL, n=n, excited_port=port, expanded=expanded,
                end_db=float(end_db), cap_s=float(cap_s), params=p, ports=sim.ports,
                boundaries=sim.boundaries, excitation=sim.excitation,
                source_duration_s=excitation.dgauss_duration_s(FREQUENCIES[-1]),
                f_min_hz=sim.f_min, f_max_hz=sim.f_max, declared_dt_s=float(dt), max_timesteps=steps,
                native_lines=[len(axes[a]) for a in "xyz"],
                native_cells=int(np.prod([len(axes[a]) for a in "xyz"])),
                mesh_mm={a:v.tolist() for a,v in axes.items()}, threads=THREADS,
                geometry=dict(strip_50_mm=w50, strip_70_mm=w70, arm_prescribed_m=float(length),
                              isolation_resistor_ohm=2*Z0, substrate_h_mm=p["sub_h"],
                              epsilon_r=p["eps_r"], tan_d=0., metal="PEC", arm_scale=1.,
                              extra_boundary_padding_mm=8. if expanded else 0.,
                              reference_planes="raw lumped ports at board edges; no launch de-embedding"),
                scope=SCOPE)
    return sim, meta


def waves_to_s(v, i):
    v, i = np.asarray(v, complex), np.asarray(i, complex)
    if (v.shape != i.shape or v.ndim != 3 or v.shape[:2] != (3, 3)
            or not v.shape[2] or not np.isfinite(v).all() or not np.isfinite(i).all()):
        raise ValueError("complete finite run/port/frequency voltage and current arrays required")
    a, b = (v+Z0*i)/(2*np.sqrt(Z0)), (v-Z0*i)/(2*np.sqrt(Z0))
    incoming = a.transpose(2, 1, 0)
    singular = np.linalg.svd(incoming, compute_uv=False)
    condition = singular[:, 0]/np.maximum(singular[:, -1], np.finfo(float).tiny)
    scale = float(np.max(singular[:, 0]))
    floor = float(np.min(singular[:, -1])/scale) if scale else 0.
    if not np.isfinite(condition).all() or np.max(condition) > LIMITS["incident_condition_max"] or floor < LIMITS["incident_floor_rel"]:
        raise ValueError("incident-wave matrix is singular, poorly conditioned or outside its excited band")
    s = multiport.assemble_s(a, b, [1, 2, 3], 3)
    inverse_control = b.transpose(2, 1, 0)@np.linalg.inv(incoming)
    residual = float(np.max(abs(s-inverse_control)))
    return s, dict(incident_condition_max=float(condition.max()), incident_floor_rel=floor,
                   independent_inverse_residual_abs=residual)


def phase_balance(s):
    s = np.asarray(s, complex)
    if s.ndim != 3 or s.shape[1:] != (3, 3) or not np.isfinite(s).all():
        raise ValueError("complete finite three-port S matrix required")
    if np.any(abs(s[:, (1, 2), 0]) < .1):
        raise ValueError("output phase is undefined near a transmission null")
    return np.angle(s[:, 1, 0]*np.conj(s[:, 2, 0]), deg=True)


def metrics(s):
    s = np.asarray(s, complex)
    if s.shape != (len(FREQUENCIES), 3, 3) or not np.isfinite(s).all():
        raise ValueError("declared complete frequency/port matrix required")
    target = reference()
    result = dict(magnitude_target_abs=float(np.max(abs(abs(s)-abs(target)))),
                  phase_balance_max_deg=float(np.max(abs(phase_balance(s)))),
                  reciprocity_max_abs=float(np.max(abs(s-s.transpose(0, 2, 1)))),
                  singular_power_max=float(np.max(np.linalg.svd(s, compute_uv=False)[:, 0]**2)),
                  raw_complex_target_diagnostic_abs=float(np.max(abs(s-target))),
                  absolute_launch_phase_qualified=False)
    result["target_passes"] = bool(
        result["magnitude_target_abs"] <= LIMITS["magnitude_target_abs"]
        and result["phase_balance_max_deg"] <= LIMITS["phase_balance_target_deg"]
        and result["reciprocity_max_abs"] <= LIMITS["reciprocity_abs"]
        and result["singular_power_max"] <= LIMITS["singular_power_max"])
    return result


def trace_clock(data, native, f_max):
    data = np.asarray(data, float)
    if data.ndim != 2 or data.shape[0] < 3 or data.shape[1] < 2 or not np.isfinite(data).all():
        raise ValueError("finite native probe samples required")
    t = data[:, 0]
    stride = int(1/(2*f_max*native["dt_s"]*4))
    measured = (t[-1]-t[0])/(len(t)-1)
    if (stride < 1 or not np.all(np.diff(t) > 0)
            or not np.allclose(np.diff(t), measured, rtol=2e-5, atol=native["dt_s"]*1e-4)
            or abs(measured/(stride*native["dt_s"])-1) > 1e-6
            or t[-1] > native["numerical_time_s"]+stride*native["dt_s"]):
        raise ValueError("native probe clock differs from its declared sampling schedule")
    return dict(samples=len(t), first_s=float(t[0]), last_s=float(t[-1]), stride_steps=stride,
                clock_ok=True, peak_abs=float(np.max(abs(data[:, 1]))))


def stopped(meta):
    native, run = meta["native"], meta["run"]
    return bool(run.get("converged") and run.get("exact_endcriteria")
                and not run.get("hit_timestep_limit") and run.get("threads") == THREADS
                and native["timesteps"] < meta["max_timesteps"]
                and native["numerical_time_s"] > meta["source_duration_s"])


def acquire(out, n, port, expanded=False, end_db=END_DB, cap_s=CAP_S):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sim, meta = build(n, port, expanded, end_db, cap_s)
    source, runtime = identity(), runtime_identity()
    sim.fdtd.Write2XML(str(out/"input.xml"))
    meta.update(source_sha256=source, runtime=runtime, limits=LIMITS, input_sha256=sha(out/"input.xml"),
                started_utc=datetime.now(timezone.utc).isoformat())
    save(out/"declared.json", meta)
    sim.run(str(out/"raw"), threads=THREADS, exact=True, echo=True, dump_statistics=True)
    stats = np.loadtxt(out/"raw/openEMS_stats.txt", comments="%")
    native = dict(cells=int(stats[0]), dt_s=float(stats[1]), timesteps=int(stats[2]),
                  numerical_time_s=float(stats[3]), iteration_wall_s=float(stats[4]))
    v, i = [], []
    raw_traces = {}
    for p in sim._port_objs:
        p.CalcPort(str(out/"raw"), FREQUENCIES)
        v.append(p.uf_tot)
        i.append(p.if_tot)
        for name in p.U_filenames+p.I_filenames:
            path = out/"raw"/name
            clock = trace_clock(np.loadtxt(path, comments="%", ndmin=2), native, sim.f_max)
            raw_traces[name] = dict(sha256=sha(path), **clock)
    np.savez_compressed(out/"waves.npz", frequency_hz=FREQUENCIES, v=v, i=i)
    if source != identity() or runtime != runtime_identity():
        raise RuntimeError("source/runtime changed during acquisition; retain the failed cohort")
    meta.update(run=sim.run_stats, waves_sha256=sha(out/"waves.npz"), native=native, raw_traces=raw_traces,
                completed_utc=datetime.now(timezone.utc).isoformat())
    save(out/"report.json", meta)
    return meta


def read(out):
    out = Path(out)
    meta = json.loads((out/"report.json").read_text(encoding="utf-8"))
    if meta["source_sha256"] != identity() or meta["runtime"] != runtime_identity() or meta["limits"] != LIMITS:
        raise ValueError("source/runtime/protocol changed; previous records are separate cohorts")
    if sha(out/"input.xml") != meta["input_sha256"] or sha(out/"waves.npz") != meta["waves_sha256"]:
        raise ValueError("native input or raw wave hash changed")
    _, expected = build(meta["n"], meta["excited_port"], meta["expanded"], meta["end_db"], meta["cap_s"])
    expected = json.loads(json.dumps(expected))
    if any(meta[k] != expected[k] for k in expected):
        raise ValueError("declared physical geometry or acquisition settings differ")
    with np.load(out/"waves.npz") as data:
        np.testing.assert_array_equal(data["frequency_hz"], FREQUENCIES)
        v, i = data["v"].copy(), data["i"].copy()
        if v.shape != (3, len(FREQUENCIES)) or v.shape != i.shape or not np.isfinite(v).all() or not np.isfinite(i).all():
            raise ValueError("complete finite waves required")
    native, run, header = meta["native"], meta["run"], meta.get("native_header", {})
    if sorted(meta["raw_traces"]) != sorted(f"port_{kind}t_{p}" for p in (1, 2, 3) for kind in ("u", "i")):
        raise ValueError("all six native port traces are required")
    for name, expected_trace in meta["raw_traces"].items():
        path = out/"raw"/name
        actual = dict(sha256=sha(path), **trace_clock(np.loadtxt(path, comments="%", ndmin=2), native, meta["f_max_hz"]))
        if actual != expected_trace:
            raise ValueError("native probe data or clock changed")
    quality = dict(grid_ok=bool(native["cells"] == meta["native_cells"] and run.get("grid") == meta["native_lines"]),
                   clock_ok=bool(abs(native["dt_s"]/meta["declared_dt_s"]-1) < 1e-8),
                   header_ok=bool(header.get("version") == "v0.37.0-rc3" and header.get("threads") == THREADS),
                   native_stop=stopped(meta), raw_clock_ok=True,
                   source_completed=bool(native["numerical_time_s"] > meta["source_duration_s"]))
    return meta, v, i, quality


def matrix(root):
    rows = [read(Path(root)/f"port{p}") for p in (1, 2, 3)]
    first = rows[0][0]
    for p, (meta, _, _, _) in enumerate(rows, 1):
        if meta["excited_port"] != p or any(meta[k] != first[k] for k in ("n", "expanded", "end_db", "cap_s", "mesh_mm", "geometry")):
            raise ValueError("different native geometries cannot assemble one S matrix")
    s, wave_quality = waves_to_s(np.array([r[1] for r in rows]), np.array([r[2] for r in rows]))
    result = dict(n=first["n"], expanded=first["expanded"], end_db=first["end_db"], cap_s=first["cap_s"],
                  quality=[r[3] for r in rows], wave_quality=wave_quality, **metrics(s),
                  all_native_complete=all(all(r[3].values()) for r in rows), qualified=False, scope=SCOPE)
    np.savez_compressed(Path(root)/"matrix.npz", frequency_hz=FREQUENCIES, s=s)
    save(Path(root)/"comparison.json", result)
    return s, result


def changes(a, b, *, mesh):
    phase = np.angle(np.exp(1j*np.deg2rad(phase_balance(b)-phase_balance(a))), deg=True)
    transmission = [(1, 0), (2, 0), (0, 1), (0, 2)]
    before = np.array([a[:, i, j] for i, j in transmission])
    after = np.array([b[:, i, j] for i, j in transmission])
    if np.any(abs(before) < .1) or np.any(abs(after) < .1):
        raise ValueError("phase convergence is undefined near a transmission null")
    transmission_phase = np.angle(after*np.conj(before), deg=True)
    result = dict(complex_max_abs=float(np.max(abs(b-a))),
                  magnitude_max_abs=float(np.max(abs(abs(b)-abs(a)))),
                  phase_balance_change_deg=float(np.max(abs(phase))),
                  transmission_phase_change_deg=float(np.max(abs(transmission_phase))))
    result["passes"] = bool(
        result["complex_max_abs"] <= LIMITS["complex_mesh_abs" if mesh else "complex_control_abs"]
        and max(result["phase_balance_change_deg"], result["transmission_phase_change_deg"])
        <= LIMITS["phase_mesh_deg" if mesh else "phase_control_deg"])
    return result


def study(root):
    root = Path(root)
    rows = [matrix(root/f"n{n}") for n in MESHES]
    padding, time = matrix(root/"n6_expanded"), matrix(root/"n6_time")
    for n, (_, r) in zip(MESHES, rows):
        if (r["n"], r["expanded"], r["end_db"], r["cap_s"]) != (n, False, END_DB, CAP_S):
            raise ValueError("wrong ordinary mesh-cohort identity")
    if (padding[1]["n"], padding[1]["expanded"], padding[1]["end_db"], padding[1]["cap_s"]) != (6, True, END_DB, CAP_S):
        raise ValueError("wrong independent padding control")
    if (time[1]["n"], time[1]["expanded"], time[1]["end_db"], time[1]["cap_s"]) != (6, False, -100., 2*CAP_S):
        raise ValueError("wrong independent native-stop time control")
    mesh_changes = [changes(a[0], b[0], mesh=True) for a, b in zip(rows, rows[1:])]
    controls = dict(padding=changes(rows[1][0], padding[0], mesh=False),
                    time=changes(rows[1][0], time[0], mesh=False))
    result = dict(protocol=PROTOCOL, limits=LIMITS, meshes=[r[1] for r in rows],
                  padding_control=padding[1], time_control=time[1], mesh_changes=mesh_changes,
                  independent_changes=controls, scope=SCOPE,
                  qualified=bool(all(r[1]["all_native_complete"] and r[1]["target_passes"] for r in rows+[padding, time])
                                 and all(c["passes"] for c in mesh_changes+list(controls.values()))),
                  absolute_launch_phase_qualified=False)
    save(root/"comparison.json", result)
    return result
