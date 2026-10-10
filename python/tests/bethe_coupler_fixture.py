"""Own parallel air/PEC waveguides with a circular aperture, Example 7.3 (p. 336).

The comparison is with a leading small-aperture dipole approximation, not an
exact finite-hole solution. No guide, aperture or acceptance limit is fitted.
The 20 dB design has k0*r=0.782: higher-order aperture effects are not negligible
by assumption. Native convergence and approximation agreement are separate.
"""
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import sys

import numpy as np
import CSXCAD
from openEMS import ports as native_ports

from fairbeam import Simulation, excitation, multiport, simulation, wgport
from tests.coax_resonator_fixture import runtime_identity as base_runtime, save, sha

ROOT = Path(__file__).resolve().parents[2]
C0, ETA0 = 299792458., 376.730313668
A, B, F0 = 22.86, 10.16, 9e9  # own WR-90 cross-section, mm
FREQUENCIES = np.linspace(7e9, 11e9, 201)
MESHES = (24, 32, 48)
DISTANCE, FAR_DISTANCE, PML, DEEP_PML = 65., 85., 8, 12
CAP_S, END_DB, THREADS = 60e-9, -80., 4
PROTOCOL = "parallel-round-aperture-v1"
LIMITS = dict(coupled_target_abs=.01, isolated_target_abs=.005,
              complex_mesh_abs=.005, complex_control_abs=.003,
              reciprocity_abs=.005, singular_power_max=1.01,
              closed_wall_floor_abs=1e-5, incident_condition_max=30., incident_floor_rel=.02)
SCOPE = "TE10 coupling/isolation magnitudes in our zero-thickness PEC circular-aperture model; no infinite-directivity or practical-wall certificate"


def identity():
    names = ("tests/bethe_coupler_fixture.py", "tests/test_bethe_coupler.py",
             "tests/coax_resonator_fixture.py", "fairbeam/simulation.py",
             "fairbeam/excitation.py", "fairbeam/wgport.py", "fairbeam/multiport.py", "fairbeam/procutil.py")
    return {name: sha(ROOT / "python" / name) for name in names}


def runtime_identity():
    value = base_runtime()
    value.update(python=sys.version, executable=sys.executable, numpy=np.__version__)
    directory = Path(CSXCAD.__file__).parent
    value["csxcad_bindings"] = {str(p.resolve()): sha(p) for p in
        sorted(directory.glob("*.pyd"))+sorted(directory.glob("*.so"))+[Path(CSXCAD.__file__)]}
    value["port_helpers_sha256"] = sha(native_ports.__file__)
    if os.name == "nt":
        prefix = os.environ.get("OPENEMS_INSTALL_PATH")
        if not prefix:
            raise ValueError("explicit bundled runtime required")
        value["dependencies"] = {name:sha(Path(prefix)/name) for name in ("fparser.dll", "nf2ff.dll")}
    return value


def beta(freq=FREQUENCIES):
    freq = np.asarray(freq, float)
    if (freq.ndim != 1 or not freq.size or not np.isfinite(freq).all()
            or np.any(freq <= C0/(2*A*1e-3)) or np.any(freq >= C0/(A*1e-3))):
        raise ValueError("finite single-propagating-mode TE10 frequencies required")
    return np.sqrt((2*np.pi*freq/C0)**2-(np.pi/(A*1e-3))**2)


def design():
    """Cancel the leading forward dipole term; size the reverse term to 0.1.

    With u=sin²(pi*x/a), ae=2*r³/3, am=4*r³/3, the two dimensionless
    modal amplitudes are -j*[ae*k²*u +/- am*(beta²*u -/+ kc²*(1-u))]/(a*b*beta).
    These are our implementation of the electric/magnetic dipole projection.
    """
    k, kc = 2*np.pi*F0/C0, np.pi/(A*1e-3)
    u = 2*kc**2/(4*kc**2-k**2)
    x = A/np.pi*np.arcsin(np.sqrt(u))
    unit_reverse = 2*(3*k**2*u-2*kc**2)/(3*(A*1e-3)*(B*1e-3)*beta([F0])[0])
    radius = (.1/unit_reverse)**(1/3)*1e3
    return dict(hole_x_mm=float(x), radius_mm=float(radius), k0_radius=float(k*radius*1e-3),
                a_mm=A, b_mm=B, epsilon_r=1., mu_r=1., wall_thickness_mm=0., design_f_hz=F0)


def reference(freq=FREQUENCIES):
    freq = np.asarray(freq, float)
    propagation = beta(freq)
    g = design()
    r, x = g["radius_mm"]*1e-3, g["hole_x_mm"]*1e-3
    a, b, kc = A*1e-3, B*1e-3, np.pi/(A*1e-3)
    k, u = 2*np.pi*freq/C0, np.sin(np.pi*x/a)**2
    ae, am = 2*r**3/3, 4*r**3/3
    coupled = -1j*(ae*k**2*u+am*(propagation**2*u-kc**2*(1-u)))/(a*b*propagation)
    isolated = -1j*(ae*k**2*u-am*(propagation**2*u+kc**2*(1-u)))/(a*b*propagation)
    return coupled, isolated


def build(n, port, *, closed=False, inset=True, distance=DISTANCE, pml=PML, end_db=END_DB, cap_s=CAP_S):
    if (isinstance(n, bool) or not isinstance(n, int) or n not in MESHES
            or isinstance(port, bool) or not isinstance(port, int) or port not in (1, 2, 3, 4)
            or not isinstance(closed, bool) or not isinstance(inset, bool)
            or isinstance(distance, bool) or distance not in (DISTANCE, FAR_DISTANCE)
            or isinstance(pml, bool) or pml not in (PML, DEEP_PML)
            or end_db not in (-80., -90.) or not np.isfinite(cap_s) or not CAP_S <= cap_s <= 2*CAP_S):
        raise ValueError("declared mesh, port, wall, probe, distance, PML and clock controls required")
    sim = Simulation(FREQUENCIES[0], FREQUENCIES[-1], boundaries=["PEC"]*4+[f"PML_{pml}"]*2,
                     end_criteria_db=end_db, excitation="gauss")
    dx = A/n
    ny = int(np.ceil(B/dx))
    dz = 2.5/int(np.ceil(2.5/dx))
    q = int(round(distance/dz))
    axes = dict(x=np.linspace(0, A, n+1), y=np.linspace(-B, B, 2*ny+1),
                z=dz*np.arange(-q-6-pml, q+6+pml+1))
    for axis, lines in axes.items():
        sim.mesh.AddLine(axis, lines)
    wall = sim.metal("common_wall")
    wall.AddBox(priority=10, start=[0, 0, axes["z"][0]], stop=[A, 0, axes["z"][-1]])
    g = design()
    if not closed:
        air = sim.csx.AddMaterial("aperture_air", epsilon=1., mue=1.)
        air.AddCylinder(priority=20, start=[g["hole_x_mm"], -dz, 0],
                        stop=[g["hole_x_mm"], dz, 0], radius=g["radius_mm"])
    center = len(axes["z"])//2
    for number, upper, side in ((1, False, -1), (2, False, 1), (3, True, -1), (4, True, 1)):
        low, high = (0, B) if upper else (-B, 0)
        # Zero-thickness excitation boxes require the exact stored mesh node.
        # Recomputing distance+2*dz missed it by one ULP and produced no field.
        source_z, probe_z = (float(axes["z"][center+side*offset]) for offset in (q+2, q))
        native = sim.waveguide_port(number, [0, low, source_z],
                    [A, high, probe_z], "z", A, B, excite=number == port)
        if inset:
            wgport.inset_mode_probes(native, cells=1)
    dt = .5/(C0*np.sqrt(sum((np.min(np.diff(v))*sim.unit)**-2 for v in axes.values())))
    steps = int(math.ceil(cap_s/dt))
    sim.max_timesteps = steps
    sim.fdtd.SetTimeStep(float(dt))
    sim.fdtd.SetNumberOfTimeSteps(steps)
    sim.fdtd.SetOverSampling(4)
    errors = sim.csx.Update()
    if errors:
        raise ValueError(f"invalid native geometry: {errors}")
    meta = dict(protocol=PROTOCOL, n=n, excited_port=port, closed=closed, inset=inset, distance_mm=distance,
                pml=pml, end_db=float(end_db), cap_s=float(cap_s), geometry=g, ports=sim.ports,
                mesh_mm={a:v.tolist() for a,v in axes.items()}, native_lines=[len(axes[a]) for a in "xyz"],
                native_cells=int(np.prod([len(axes[a]) for a in "xyz"])), declared_dt_s=float(dt),
                max_timesteps=steps, source_duration_s=9/(np.pi*(FREQUENCIES[-1]-FREQUENCIES[0])/2),
                excitation=sim.excitation,
                f_max_hz=float(FREQUENCIES[-1]), boundaries=sim.boundaries, scope=SCOPE, threads=THREADS)
    return sim, meta


def trace_clock(data, native):
    data = np.asarray(data, float)
    stride = int(1/(2*FREQUENCIES[-1]*native["dt_s"]*4))
    if data.ndim != 2 or data.shape[0] < 3 or not np.isfinite(data).all() or stride < 1:
        raise ValueError("finite native traces required")
    t = data[:, 0]
    if (np.any(np.diff(t) <= 0) or not np.allclose(np.diff(t), stride*native["dt_s"], rtol=2e-5, atol=native["dt_s"]*1e-5)
            or t[-1] > native["numerical_time_s"]+stride*native["dt_s"]):
        raise ValueError("incorrect native probe clock")
    return dict(samples=len(t), first_s=float(t[0]), last_s=float(t[-1]), stride_steps=stride)


def stopped(meta):
    native, run = meta["native"], meta["run"]
    return bool(run.get("converged") and run.get("exact_endcriteria") and not run.get("hit_timestep_limit")
                and run.get("threads") == THREADS and native["timesteps"] < meta["max_timesteps"]
                and native["numerical_time_s"] > meta["source_duration_s"])


def record_quality(meta):
    native, run, header = meta["native"], meta["run"], meta.get("native_header", {})
    quality = dict(grid_ok=native["cells"] == meta["native_cells"] and run.get("grid") == meta["native_lines"],
        clock_ok=abs(native["dt_s"]/meta["declared_dt_s"]-1) < 1e-8,
        native_time_ok=native["timesteps"] > 0 and abs(native["numerical_time_s"]/(native["dt_s"]*native["timesteps"])-1) < 1e-8,
        header_ok=header.get("version") == "v0.37.0-rc3" and header.get("threads") == THREADS
                  and header.get("nyquist_interval") == int(1/(2*FREQUENCIES[-1]*native["dt_s"]))
                  and abs(header.get("excitation_timesteps", -2)-math.ceil(meta["source_duration_s"]/native["dt_s"])) <= 1,
        source_completed=native["numerical_time_s"] > meta["source_duration_s"], native_stop=stopped(meta))
    return {k:bool(value) for k,value in quality.items()}


def acquire(out, n, port, **options):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sim, meta = build(n, port, **options)
    source, runtime = identity(), runtime_identity()
    sim.fdtd.Write2XML(str(out/"input.xml"))
    meta.update(source_sha256=source, runtime=runtime, limits=LIMITS, input_sha256=sha(out/"input.xml"),
                started_utc=datetime.now(timezone.utc).isoformat())
    save(out/"declared.json", meta)
    sim.run(str(out/"raw"), threads=THREADS, exact=True, echo=True, dump_statistics=True)
    stats = np.loadtxt(out/"raw/openEMS_stats.txt", comments="%")
    native = dict(cells=int(stats[0]), dt_s=float(stats[1]), timesteps=int(stats[2]),
                  numerical_time_s=float(stats[3]), iteration_wall_s=float(stats[4]))
    v, i, traces = [], [], {}
    for p in sim._port_objs:
        p.CalcPort(str(out/"raw"), FREQUENCIES)
        v.append(p.uf_tot)
        i.append(p.if_tot)
        for name in p.U_filenames+p.I_filenames:
            path = out/"raw"/name
            traces[name] = dict(sha256=sha(path), **trace_clock(np.loadtxt(path, comments="%", ndmin=2), native))
    np.savez_compressed(out/"waves.npz", frequency_hz=FREQUENCIES, v=v, i=i)
    if source != identity() or runtime != runtime_identity():
        raise RuntimeError("source/runtime changed during acquisition; reject this cohort")
    meta.update(native=native, run=sim.run_stats, waves_sha256=sha(out/"waves.npz"), raw_traces=traces,
                completed_utc=datetime.now(timezone.utc).isoformat())
    save(out/"report.json", meta)
    return meta


def read(out):
    out = Path(out)
    meta = json.loads((out/"report.json").read_text(encoding="utf-8"))
    if meta["source_sha256"] != identity() or meta["runtime"] != runtime_identity() or meta["limits"] != LIMITS:
        raise ValueError("changed source/runtime/limits; keep epochs separate")
    if sha(out/"input.xml") != meta["input_sha256"] or sha(out/"waves.npz") != meta["waves_sha256"]:
        raise ValueError("changed native input or wave data")
    options = dict(closed=meta["closed"], inset=meta["inset"], distance=meta["distance_mm"],
                   pml=meta["pml"], end_db=meta["end_db"], cap_s=meta["cap_s"])
    _, expected = build(meta["n"], meta["excited_port"], **options)
    expected = json.loads(json.dumps(expected))
    if any(meta[k] != value for k, value in expected.items()):
        raise ValueError("different physical geometry or acquisition settings")
    native, run = meta["native"], meta["run"]
    if set(meta["raw_traces"]) != {f"port_{k}t_{p}" for k in ("u", "i") for p in range(1, 5)}:
        raise ValueError("all eight native port traces required")
    for name, recorded in meta["raw_traces"].items():
        path = out/"raw"/name
        if dict(sha256=sha(path), **trace_clock(np.loadtxt(path, comments="%", ndmin=2), native)) != recorded:
            raise ValueError("changed native trace or sampling clock")
    with np.load(out/"waves.npz") as data:
        np.testing.assert_array_equal(data["frequency_hz"], FREQUENCIES)
        v, i = data["v"].copy(), data["i"].copy()
    if v.shape != (4, len(FREQUENCIES)) or v.shape != i.shape or not np.isfinite(v).all() or not np.isfinite(i).all():
        raise ValueError("complete finite native waves required")
    active = meta["excited_port"]-1
    if not np.any(abs(v[active])+abs(i[active]) > 0):
        raise ValueError("native excited port has zero fields; reject the source plane before more runs")
    return meta, v, i, record_quality(meta)


def waves_to_s(v, i):
    v, i = np.asarray(v, complex), np.asarray(i, complex)
    if v.shape != (4, 4, len(FREQUENCIES)) or v.shape != i.shape or not np.isfinite(v).all() or not np.isfinite(i).all():
        raise ValueError("complete four-run/four-port finite waves required")
    z = ETA0*(2*np.pi*FREQUENCIES/C0)/beta()
    a, b = (v+z*i)/(2*np.sqrt(z)), (v-z*i)/(2*np.sqrt(z))
    incoming = a.transpose(2, 1, 0)
    singular = np.linalg.svd(incoming, compute_uv=False)
    with np.errstate(over="ignore", invalid="ignore"):
        condition = singular[:, 0]/np.maximum(singular[:, -1], np.finfo(float).tiny)
    scale = float(np.max(singular[:, 0]))
    floor = float(np.min(singular[:, -1])/scale) if scale else 0.
    if not np.isfinite(condition).all() or condition.max() > LIMITS["incident_condition_max"] or floor < LIMITS["incident_floor_rel"]:
        raise ValueError("poorly conditioned or unexcited incident-wave matrix")
    s = multiport.assemble_s(a, b, [1, 2, 3, 4], 4)
    residual = float(np.max(abs(s-b.transpose(2, 1, 0)@np.linalg.inv(incoming))))
    return s, dict(incident_condition_max=float(condition.max()), incident_floor_rel=floor, inverse_residual_abs=residual)


def matrix(root):
    rows = [read(Path(root)/f"port{p}") for p in range(1, 5)]
    first = rows[0][0]
    for p, (meta, _, _, _) in enumerate(rows, 1):
        if meta["excited_port"] != p or any(meta[k] != first[k] for k in
                ("n", "closed", "inset", "distance_mm", "pml", "end_db", "cap_s", "geometry", "mesh_mm")):
            raise ValueError("cannot combine different physical records")
    s, wave_quality = waves_to_s(np.array([r[1] for r in rows]), np.array([r[2] for r in rows]))
    c, isolated = reference()
    floor = float(max(np.max(abs(s[:, :2, 2:])), np.max(abs(s[:, 2:, :2])))) if first["closed"] else None
    result = dict(n=first["n"], closed=first["closed"], inset=first["inset"], distance_mm=first["distance_mm"],
                  pml=first["pml"], end_db=first["end_db"], cap_s=first["cap_s"], quality=[r[3] for r in rows],
                  all_native_complete=all(all(r[3].values()) for r in rows), wave_quality=wave_quality,
                  coupled_target_abs=float(np.max(abs(abs(s[:, 2, 0])-abs(c)))),
                  isolated_target_abs=float(np.max(abs(abs(s[:, 3, 0])-abs(isolated)))),
                  reciprocity_max_abs=float(np.max(abs(s-s.transpose(0, 2, 1)))),
                  singular_power_max=float(np.max(np.linalg.svd(s, compute_uv=False)[:, 0]**2)),
                  closed_wall_floor_abs=floor, infinite_directivity_qualified=False, qualified=False)
    result["target_passes"] = bool(result["coupled_target_abs"] <= LIMITS["coupled_target_abs"]
        and result["isolated_target_abs"] <= LIMITS["isolated_target_abs"]
        and result["reciprocity_max_abs"] <= LIMITS["reciprocity_abs"]
        and result["singular_power_max"] <= LIMITS["singular_power_max"])
    np.savez_compressed(Path(root)/"matrix.npz", frequency_hz=FREQUENCIES, s=s)
    save(Path(root)/"comparison.json", result)
    return s, result


def study(root):
    root = Path(root)
    ordinary = [matrix(root/f"n{n}") for n in MESHES]
    for n, (_, row) in zip(MESHES, ordinary):
        if (row["n"], row["closed"], row["inset"], row["distance_mm"], row["pml"], row["end_db"], row["cap_s"]) != (n, False, True, DISTANCE, PML, END_DB, CAP_S):
            raise ValueError("incorrect main mesh-cohort identity")
    controls = {}
    for name, expected in (("far", (FAR_DISTANCE, PML, END_DB, CAP_S)),
                           ("pml", (DISTANCE, DEEP_PML, END_DB, CAP_S)),
                           ("time", (DISTANCE, PML, -90., 2*CAP_S))):
        actual, row = matrix(root/f"n32_{name}")
        if (row["n"], row["closed"], row["inset"]) != (32, False, True) or tuple(row[k] for k in ("distance_mm", "pml", "end_db", "cap_s")) != expected:
            raise ValueError("incorrect independent control identity")
        main = ordinary[1][0]
        if name == "far":
            actual = actual*np.exp(2j*beta()*(FAR_DISTANCE-DISTANCE)*1e-3)[:, None, None]
        change = float(np.max(abs(actual-main)))
        controls[name] = dict(complex_max_abs=change, passes=change <= LIMITS["complex_control_abs"], native=row)
    closed, row = matrix(root/"n32_closed")
    if (row["n"], row["closed"], row["inset"], row["distance_mm"], row["pml"], row["end_db"], row["cap_s"]) != (32, True, True, DISTANCE, PML, END_DB, CAP_S):
        raise ValueError("incorrect sealed-wall identity")
    mesh_changes = [float(np.max(abs(b[0]-a[0]))) for a,b in zip(ordinary, ordinary[1:])]
    qualified = bool(all(r["all_native_complete"] and r["target_passes"] for _,r in ordinary)
        and all(v <= LIMITS["complex_mesh_abs"] for v in mesh_changes)
        and all(r["passes"] and r["native"]["all_native_complete"] for r in controls.values())
        and row["all_native_complete"] and row["closed_wall_floor_abs"] <= LIMITS["closed_wall_floor_abs"])
    result = dict(protocol=PROTOCOL, limits=LIMITS, meshes=[r for _,r in ordinary], mesh_changes=mesh_changes,
                  controls=controls, closed_wall=row, qualified=qualified, scope=SCOPE, infinite_directivity_qualified=False)
    save(root/"comparison.json", result)
    return result
