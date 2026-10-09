"""Own half-wave microstrip ring-down fixture, Example 6.2 (p. 283).

The quasi-static line reference excludes open-end fringing and radiation.
PMC-end controls separate those assumptions from a finite open strip. The
boxed control has PEC transverse walls; PMC ends with transverse PML remain
a diagnostic and cannot qualify the distributed-loss reference.
PEC and dielectric loss are distinct from the diagnostic sigma_bulk/4
symmetric conducting-sheet surrogate; that surrogate is not bulk copper.
No feed port, gallery model or exported bundle is changed.
"""
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path

import numpy as np
import openEMS
from openEMS.physical_constants import C0, EPS0, MUE0

from fairbeam.analytic import microstrip_eps_eff, microstrip_width, microstrip_z0, patch_delta_l
from fairbeam.excitation import dgauss_duration_s
from fairbeam.simulation import Simulation
from tests.microstrip_fixture import graded
from tests.coax_resonator_fixture import energy_decay

H, ER, Z0, F0 = 1.59, 2.08, 50., 5e9
TAN_D, SIGMA, SHEET_T = .0004, 5.8e7, .035
KINDS = ("pec", "dielectric", "copper_sheet", "both_sheet")
ENDS, MESHES = ("open", "pmc", "boxed"), (4, 6, 8)
PULSES = ("auto", "narrow", "broad")
CAP_S, MAX_CAP_S, END_DB, THREADS = 60e-9, 1.6e-6, -70., 4
BROAD_WINDOWS = ((3e-9, 11e-9), (11e-9, 19e-9), (19e-9, 27e-9))
WINDOWS = ((22e-9, 28e-9), (28e-9, 34e-9), (34e-9, 40e-9))
PULSE_F, PULSE_TAU, PULSE_CENTER = 4.9e9, 2e-9, 10e-9
GATES = dict(f_target=.01, q_target=.05, f_mesh=.002, q_mesh=.03,
             f_control=.001, q_control=.03, f_probe=.0001, q_probe=.01,
             f_window=.0002, q_window=.02, ar_residual=.002,
             energy_agreement=.05, energy_log_rms=.4, energy_span_db=30., energy_uncertainty=.1)
SCOPE = ("Quarter-geometry symmetry of a half-wave microstrip; own thin strip, "
         "no external coupling; radiating open ends versus ideal PMC ends "
         "with either diagnostic transverse PML or a finite PEC enclosure; "
         "sheet loss is a surrogate, not bulk copper")


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False)+"\n", encoding="utf-8")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def identity():
    root = Path(__file__).resolve().parents[1]
    files = ("tests/microstrip_resonator_fixture.py", "tests/test_microstrip_resonator.py",
             "tests/microstrip_fixture.py", "tests/coax_resonator_fixture.py",
             "fairbeam/analytic.py", "fairbeam/simulation.py",
             "fairbeam/excitation.py", "fairbeam/procutil.py")
    return {name: sha(root/name) for name in files}


def runtime_identity():
    binding = Path(openEMS.__file__).parent
    files = list(binding.glob("*.pyd"))+list(binding.glob("*.so"))
    prefix = os.environ.get("OPENEMS_INSTALL_PATH") or os.environ.get("CSXCAD_INSTALL_PATH")
    if prefix:
        for folder in (Path(prefix), Path(prefix)/"bin", Path(prefix)/"lib", Path(prefix)/"lib64"):
            for pattern in ("*openEMS*.dll", "*CSXCAD*.dll", "*openEMS*.so*", "*CSXCAD*.so*", "*openEMS*.dylib", "*CSXCAD*.dylib"):
                files.extend(folder.glob(pattern))
    hashes = {str(p.resolve()): sha(p) for p in sorted(set(files)) if p.is_file()}
    if not hashes:
        raise ValueError("native runtime identity unavailable")
    return dict(binding_version=openEMS.__version__, files=hashes)


def reference(kind, frequency=F0):
    if kind not in KINDS or not np.isfinite(frequency) or frequency <= 0:
        raise ValueError("supported loss case and positive frequency required")
    width = microstrip_width(Z0, ER, H)
    eff = microstrip_eps_eff(ER, H, width)
    beta = 2*np.pi*frequency*np.sqrt(eff)/C0
    rs = np.sqrt(np.pi*frequency*MUE0/SIGMA)
    # Fixed dielectric conductivity: tan(delta) scales inversely with frequency.
    tangent = TAN_D*F0/frequency
    alpha_d = 2*np.pi*frequency/C0*ER*(eff-1)*tangent/(2*np.sqrt(eff)*(ER-1))
    alpha_c = rs/(Z0*width*1e-3)  # uniform-current, one-face approximation
    alpha = (alpha_d if kind in ("dielectric", "both_sheet") else 0.)
    alpha += alpha_c if kind in ("copper_sheet", "both_sheet") else 0.
    length = C0/(2*F0*np.sqrt(eff))*1e3
    fringe = patch_delta_l(eff,H,width)
    # Independent Getsinger approximation, fixed geometry, not fitted to FDTD.
    # Qucs technical documentation: https://qucs.sourceforge.net/tech/node75.html
    fp = Z0/(2*MUE0*H*1e-3)
    def dispersed(f):
        return ER-(ER-eff)/(1+(0.6+0.009*Z0)*(f/fp)**2)
    lo,hi = .8*F0,F0
    for _ in range(60):
        mid = (lo+hi)/2
        if 2*mid*np.sqrt(dispersed(mid))*length*1e-3/C0 > 1:
            hi = mid
        else:
            lo = mid
    return dict(width_mm=float(width), eps_eff=float(eff), z_ohm=float(microstrip_z0(ER,H,width)),
                length_mm=float(length), f_hz=float(frequency),
                fringe_extension_mm=float(fringe), fringe_frequency_hz=float(F0*length/(length+2*fringe)),
                guide_frequency_hz=float((lo+hi)/2), guide_dispersion="Getsinger approximation",
                beta_rad_m=float(beta), alpha_d_np_m=float(alpha_d), alpha_c_np_m=float(alpha_c),
                q_distributed=float(beta/(2*alpha)) if alpha else None,
                qd=float(beta/(2*alpha_d)), qc=float(beta/(2*alpha_c)),
                sigma_dielectric_s_m=float(TAN_D*2*np.pi*F0*EPS0*ER),
                conductor_reference="Approximate uniform-current bulk surface resistance",
                end_fringe_radiation_in_reference=False)


def edge_axis(edge, delta, air):
    inner, outer = edge-delta/3, edge+2*delta/3
    core = np.linspace(delta/2, inner, max(2, int(math.ceil(inner/delta)))+1)
    tail = outer+graded(air-2*delta/3, delta, H)
    return np.r_[-delta/2, core, tail, tail[-1]+H*np.arange(1,9)]


class MicrostripResonatorSimulation(Simulation):
    def to_bundle(self, *args, **kwargs):
        raise ValueError("symmetry ring-down research fixture has no exportable model ports")


def narrow_expression():
    """Derivative of a Gaussian-modulated cosine; zero integral and no DC."""
    u = f"(t-{PULSE_CENTER:.17g})"
    tau,omega = PULSE_TAU,2*np.pi*PULSE_F
    return (f"exp(-({u}/{tau:.17g})^2)*(-2*{u}/{tau*tau*omega:.17g}"
            f"*cos({omega:.17g}*{u})-sin({omega:.17g}*{u}))")


def narrow_signal(t):
    u = np.asarray(t)-PULSE_CENTER
    omega = 2*np.pi*PULSE_F
    return np.exp(-(u/PULSE_TAU)**2)*(-2*u/(PULSE_TAU**2*omega)*np.cos(omega*u)-np.sin(omega*u))


def build(n, kind, end="open", air_h=6, cap_s=CAP_S, pulse="auto"):
    if isinstance(n,bool) or not isinstance(n,int) or n not in MESHES:
        raise ValueError("mesh must be 4, 6 or 8")
    if kind not in KINDS or end not in ENDS or air_h not in (6,8) or pulse not in PULSES:
        raise ValueError("unsupported loss/end/air control")
    if pulse=="auto":
        pulse="broad" if end=="open" else "narrow"
    minimum = 45e-9 if pulse=="narrow" else 30e-9
    if not np.isfinite(cap_s) or not minimum <= cap_s <= MAX_CAP_S:
        raise ValueError("cap must cover post-source windows (45 ns narrow / 30 ns broad), at most 1600 ns")
    ref = reference(kind)
    half, width, delta, air = ref["length_mm"]/2, ref["width_mm"], H/n, air_h*H
    if end != "open":
        count = int(math.ceil(half/delta))
        dx = half/(count+.5)
        # Native PMC zeros the last tangential H dual plane; its midpoint
        # between the final two x-lines must be the physical open-end plane.
        x = dx*np.arange(count+2)
    else:
        inner, outer = half-delta/3, half+2*delta/3
        core = np.linspace(0,inner,int(math.ceil(inner/delta))+1)
        tail = outer+graded(air-2*delta/3,delta,H)
        x = np.r_[core,tail,tail[-1]+H*np.arange(1,9)]
    y = edge_axis(width/2,delta,air)
    top = H+graded(air,delta,H)
    z = np.r_[-delta,np.linspace(0,H,n+1),top[1:],top[-1]+H*np.arange(1,9)]
    transverse = "PEC" if end=="boxed" else "PML_8"
    boundaries = ["PEC", "PMC" if end!="open" else "PML_8", "PMC", transverse, "PEC", transverse]
    sim = MicrostripResonatorSimulation(4e9 if pulse=="narrow" else 2e9,
                                      6e9 if pulse=="narrow" else 8e9,
                                      boundaries=boundaries,end_criteria_db=END_DB)
    if pulse=="narrow":
        expression = narrow_expression()
        # rc3 CalcCustomExcitation replaces m_f_max by f0 for Nyquist sampling.
        # The carrier is in the expression; both engine arguments declare the
        # sampling ceiling, not the carrier (FDTD/excitation.cpp:222-250).
        sim.fdtd.SetCustomExcite(expression,sim.f_max,sim.f_max)
        sim.excitation = dict(type="research-modulated-derivative",expression=expression,dc_free=True,
                              f_min=sim.f_min,f_max=sim.f_max,duration_s=20e-9,
                              carrier_hz=PULSE_F,tau_s=PULSE_TAU,center_s=PULSE_CENTER)
    for axis,lines in zip("xyz",(x,y,z)):
        sim.mesh.AddLine(axis,lines)
    # The vacuum grid estimate is not the native Rennings stability bound.
    # Stay below both in the measured symmetry/edge mesh, and audit warnings.
    dt = .5*sim.cfl_timestep()
    if pulse=="broad":
        dt = min(dt,.30e-12)  # retain the original broad diagnostic clock
    steps = int(math.ceil(cap_s/dt))
    sim.max_timesteps = steps
    sim.fdtd.SetNumberOfTimeSteps(steps)
    sim.fdtd.SetTimeStep(dt)
    sim.fdtd.SetOverSampling(4)
    dielectric = kind in ("dielectric","both_sheet")
    sim.dielectric("substrate",ER,tan_d=TAN_D if dielectric else 0,tan_d_freq=F0).AddBox(
        [x[0],y[0],0],[x[-1],y[-1],H],priority=1)
    sim.metal("ground_backing").AddBox([x[0],y[0],z[0]],[x[-1],y[-1],0],priority=10)
    lossy = kind in ("copper_sheet","both_sheet")
    strip = sim.metal("strip",conductivity=SIGMA/4 if lossy else None,thickness=SHEET_T)
    strip.AddBox([0,y[0],H],[x[-1] if end!="open" else half,width/2,H],priority=11)
    if lossy:
        sim.metal("ground_sheet",conductivity=SIGMA/4,thickness=SHEET_T).AddBox(
            [x[0],y[0],0],[x[-1],y[-1],0],priority=11)
    # Odd longitudinal voltage / even transverse voltage are selected by the
    # PEC/PMC symmetry planes. This soft source adds no resistive feed loading.
    source = sim.csx.AddExcitation("source",exc_type=0,exc_val=[0,0,1])
    source.SetWeightFunction(["0","0",f"sin(pi*x/{2*half:.17g})"])
    source.AddBox([0,y[1],0],[half,width/2,H])
    probes=[]
    for i, target in enumerate((half/2,3*half/4)):
        plane = float(x[np.argmin(abs(x-target))])
        sim.csx.AddProbe(f"u{i}",p_type=0).AddBox([plane,y[1],H],[plane,y[1],0])
        probes.append([plane,float(y[1])])
    lines = [len(v) for v in (x,y,z)]
    if np.prod(lines)>500_000:
        raise ValueError("research cell budget exceeded")
    meta = dict(n=n,kind=kind,end=end,air_h=air_h,cap_s=cap_s,pulse=pulse,
                f_max_hz=sim.f_max,excitation=sim.excitation,
                windows_s=WINDOWS if pulse=="narrow" else BROAD_WINDOWS,
                declared_dt_s=dt,max_timesteps=steps,native_lines=lines,native_cells=int(np.prod(lines)),
                threads=THREADS,probe_oversampling=4,probe_stride_steps=int(1/(2*sim.f_max*dt))//4,
                physical_half_length_mm=half,physical_symmetry_y_mm=0.,probes_mm=probes,
                source_duration_s=20e-9 if pulse=="narrow" else dgauss_duration_s(sim.f_max),reference=ref,scope=SCOPE,
                sheet_sigma_s_m=SIGMA/4 if lossy else None,sheet_thickness_mm=SHEET_T if lossy else None,
                conductor_model="symmetric-sheet diagnostic" if lossy else "PEC")
    return sim,meta


def field_pole(t,y):
    """Free AR(2) complex pole and DC offset; no analytical f or Q in the fit."""
    t,y=np.asarray(t,float),np.asarray(y,float)
    if (t.ndim!=1 or y.shape!=t.shape or len(t)<100 or not np.isfinite(t).all()
            or not np.isfinite(y).all()):
        raise ValueError("finite matching field trace with at least 100 samples required")
    dt=(t[-1]-t[0])/(len(t)-1)
    if dt<=0 or np.any(np.diff(t)<=0) or np.max(abs(np.diff(t)/dt-1))>.01:
        raise ValueError("nonuniform field clock")
    scale=np.sqrt(np.mean(y*y))
    if not scale>0:
        raise ValueError("zero field signal")
    v=y/scale
    design=np.column_stack((v[1:-1],v[:-2],np.ones(len(v)-2)))
    coefficients=np.linalg.lstsq(design,v[2:],rcond=None)[0]
    roots=np.roots([1.,-coefficients[0],-coefficients[1]])
    root=roots[np.argmax(roots.imag)]
    if root.imag<=0 or not abs(root)>0:
        raise ValueError("not an oscillatory pole")
    alpha=-np.log(abs(root))/dt
    omega=np.angle(root)/dt
    return dict(f_hz=float(omega/(2*np.pi)),alpha_s=float(alpha),decaying=bool(alpha>0),
                q=float(omega/(2*alpha)) if alpha>0 else None,
                relative_residual=float(np.linalg.norm(design@coefficients-v[2:])/np.linalg.norm(v[2:])))


def energy_trend(t,energy,f_hz):
    """Sparse native fast-proxy slope, explicitly not physical volume energy."""
    t,energy=np.asarray(t,float),np.asarray(energy,float)
    if (t.ndim!=1 or energy.shape!=t.shape or len(t)<20 or not np.isfinite(t).all()
            or not np.isfinite(energy).all() or np.any(energy<=0) or np.any(np.diff(t)<=0)):
        raise ValueError("20 positive proxy samples on an increasing clock required")
    x=t-t.mean()
    y=np.log(energy)
    slope=float(np.dot(x,y-y.mean())/np.dot(x,x))
    if slope>=0:
        raise ValueError("proxy does not decay")
    residual=y-(y.mean()+slope*x)
    return dict(q=float(-2*np.pi*f_hz/slope),log_rms=float(np.sqrt(np.mean(residual**2))),
                span_db=float(-slope*np.ptp(t)*10/np.log(10)),samples=len(t),physical_energy=False)


def acquire(out,n,kind,end,air_h,cap_s,pulse="auto"):
    out=Path(out)
    out.mkdir(parents=True,exist_ok=False)
    sim,meta=build(n,kind,end,air_h,cap_s,pulse)
    source,runtime=identity(),runtime_identity()
    sim.fdtd.Write2XML(str(out/"input.xml"))
    meta.update(source_sha256=source,runtime=runtime,input_sha256=sha(out/"input.xml"),gates=GATES,
                started_utc=datetime.now(timezone.utc).isoformat())
    save(out/"declared.json",meta)
    sim.run(str(out/"raw"),threads=THREADS,echo=True,exact=True,dump_statistics=True)
    stats=np.loadtxt(out/"raw/openEMS_stats.txt",comments="%")
    proxy=np.loadtxt(out/"raw/openEMS_run_stats.txt",comments="%",ndmin=2)
    traces=[np.loadtxt(out/f"raw/u{i}",comments="%",ndmin=2) for i in range(2)]
    np.testing.assert_array_equal(traces[0][:,0],traces[1][:,0])
    interval=int(1/(2*sim.f_max*stats[1]))
    np.savez_compressed(out/"data.npz",t=traces[0][:,0],u=np.array([v[:,1] for v in traces]),
                        energy_t=np.floor(proxy[:,1]/interval)*interval*stats[1],energy=proxy[:,3])
    if source!=identity() or runtime!=runtime_identity():
        raise RuntimeError("source/runtime changed during acquisition")
    meta.update(run=sim.run_stats,data_sha256=sha(out/"data.npz"),
                native=dict(cells=int(stats[0]),dt_s=float(stats[1]),timesteps=int(stats[2]),
                            numerical_time_s=float(stats[3]),iteration_wall_s=float(stats[4])),
                completed_utc=datetime.now(timezone.utc).isoformat())
    save(out/"report.json",meta)
    return meta


def read(out):
    out=Path(out)
    meta=json.loads((out/"report.json").read_text(encoding="utf-8"))
    if meta["source_sha256"]!=identity() or meta["gates"]!=GATES or meta["runtime"]!=runtime_identity():
        raise ValueError("source/protocol/runtime changed; preserve previous cohorts")
    if sha(out/"input.xml")!=meta["input_sha256"] or sha(out/"data.npz")!=meta["data_sha256"]:
        raise ValueError("input/data hash changed")
    _,expected=build(meta["n"],meta["kind"],meta["end"],meta["air_h"],meta["cap_s"],meta["pulse"])
    expected=json.loads(json.dumps(expected))
    if any(meta[k]!=expected[k] for k in expected):
        raise ValueError("case parameter identity changed")
    native,run=meta["native"],meta["run"]
    header=meta.get("native_header",{})
    header_ok=(header.get("version")=="v0.37.0-rc3" and header.get("threads")==THREADS
               and header.get("nyquist_interval")==int(1/(2*meta["f_max_hz"]*native["dt_s"])))
    clock_ok=abs(native["dt_s"]/meta["declared_dt_s"]-1)<1e-8
    grid_ok=native["cells"]==meta["native_cells"] and run.get("grid")==meta["native_lines"]
    stopped=bool(run.get("converged") and native["timesteps"]<meta["max_timesteps"]
                 and native["numerical_time_s"]>meta["source_duration_s"] and run.get("threads")==THREADS)
    poles,errors,energy_fit=[],[],None
    with np.load(out/"data.npz") as data:
        t=data["t"]
        probe_clock_ok=bool(t.ndim==1 and len(t)>1 and np.isfinite(t).all()
                            and np.all(np.diff(t)>0)
                            and abs((t[-1]-t[0])/(len(t)-1)/(native["dt_s"]*meta["probe_stride_steps"])-1)<1e-6
                            and t[-1]<=native["numerical_time_s"]+2*native["dt_s"])
        for i,u in enumerate(data["u"]):
            for j,(lo,hi) in enumerate(meta["windows_s"]):
                mask=(data["t"]>=lo)&(data["t"]<hi)
                try:
                    if t[0]>lo or t[-1]<hi-native["dt_s"]*meta["probe_stride_steps"]:
                        raise ValueError("incomplete post-source window")
                    poles.append(dict(probe=i,window=j,**field_pole(data["t"][mask],u[mask])))
                except ValueError as exc:
                    errors.append(f"probe{i}/window{j}: {exc}")
        if len(poles)==6:
            f=float(np.mean([p["f_hz"] for p in poles]))
            e=data["energy"]
            db=10*np.log10(e/e.max()) if e.size else np.array([])
            mask=(data["energy_t"]>meta["windows_s"][0][0])&(db<=-10)&(db>=-60)
            try:
                energy_fit=energy_decay(data["energy_t"][mask],e[mask],f,phase_corrected=True)
                energy_fit["physical_energy"]=False
            except ValueError as exc:
                errors.append(str(exc))
    result=dict(n=meta["n"],kind=meta["kind"],end=meta["end"],air_h=meta["air_h"],pulse=meta["pulse"],
                stopped=stopped,clock_ok=clock_ok,grid_ok=grid_ok,header_ok=header_ok,
                probe_clock_ok=probe_clock_ok,
                poles=poles,energy_proxy=energy_fit,extraction_errors=errors,qualified=False,matches=False)
    if len(poles)==6:
        fs=np.asarray([p["f_hz"] for p in poles]).reshape(2,3)
        result.update(f_hz=float(fs.mean()),f_target_rel=float(abs(fs.mean()/F0-1)),
                      guide_frequency_rel=float(abs(fs.mean()/meta["reference"]["guide_frequency_hz"]-1)),
                      fringe_frequency_rel=float(abs(fs.mean()/meta["reference"]["fringe_frequency_hz"]-1)),
                      f_probe_rel=float(max(abs(fs[0]-fs[1]))/F0),
                      f_window_rel=float(max(np.ptp(fs,axis=1))/F0))
        if all(p["decaying"] for p in poles):
            qs=np.asarray([p["q"] for p in poles]).reshape(2,3)
            q=float(qs.mean())
            ref_at_f=reference(meta["kind"],result["f_hz"])
            result.update(q=q,q_probe_rel=float(max(abs(qs[0]/qs[1]-1))),
                          q_window_rel=float(max(np.ptp(qs,axis=1))/q),
                          distributed_q_reference=ref_at_f["q_distributed"])
            if ref_at_f["q_distributed"]:
                result["q_target_rel"]=abs(q/ref_at_f["q_distributed"]-1)
            stable=(result["f_probe_rel"]<=GATES["f_probe"] and result["f_window_rel"]<=GATES["f_window"]
                    and result["q_probe_rel"]<=GATES["q_probe"] and result["q_window_rel"]<=GATES["q_window"]
                    and max(p["relative_residual"] for p in poles)<=GATES["ar_residual"])
            proxy_ok=bool(energy_fit and energy_fit["fitted_span_db"]>=GATES["energy_span_db"]
                          and energy_fit["log_rms"]<=GATES["energy_log_rms"]
                          and energy_fit["q_rel_95_uncertainty"]<=GATES["energy_uncertainty"]
                          and abs(energy_fit["q"]/q-1)<=GATES["energy_agreement"])
            # The finite open strip has a different analytical model. Even a
            # mesh-stable result cannot qualify the no-fringe line reference.
            target_ok=(meta["end"]=="boxed" and meta["kind"]=="dielectric"
                       and result["f_target_rel"]<=GATES["f_target"]
                       and result.get("q_target_rel",1)<=GATES["q_target"])
            result.update(field_stable=bool(stable),energy_proxy_passes=proxy_ok,
                          matches=bool(stopped and clock_ok and probe_clock_ok and grid_ok and header_ok and stable and proxy_ok and target_ok))
    save(out/"comparison.json",result)
    return result


def study(root,kind,end):
    root=Path(root)
    rows=[read(root/f"n{n}") for n in MESHES]
    control=read(root/"n6_air")
    for row,n in zip(rows,MESHES):
        if (row["n"],row["kind"],row["end"],row["air_h"])!=(n,kind,end,6):
            raise ValueError("wrong mesh cohort identity")
    if (control["n"],control["kind"],control["end"],control["air_h"])!=(6,kind,end,8):
        raise ValueError("wrong boundary control identity")
    if len({r["pulse"] for r in rows+[control]})!=1:
        raise ValueError("pulse cohort identity differs")
    def q_change(a,b):
        return abs(b["q"]/a["q"]-1) if a.get("q") and b.get("q") else None
    changes=[]
    for a,b in zip(rows,rows[1:]):
        changes.append(dict(f_mesh_rel=abs(b.get("f_hz",0)-a.get("f_hz",F0))/F0,
                            q_mesh_rel=q_change(a,b)))
    boundary=dict(f_control_rel=abs(control.get("f_hz",0)-rows[1].get("f_hz",F0))/F0,
                  q_control_rel=q_change(rows[1],control))
    qualified=(all(r["matches"] for r in rows+[control]) and
               all(c["f_mesh_rel"]<=GATES["f_mesh"] and c["q_mesh_rel"] is not None and c["q_mesh_rel"]<=GATES["q_mesh"] for c in changes)
               and boundary["f_control_rel"]<=GATES["f_control"] and boundary["q_control_rel"] is not None
               and boundary["q_control_rel"]<=GATES["q_control"])
    result=dict(kind=kind,end=end,meshes=rows,control=control,mesh_changes=changes,
                boundary_change=boundary,qualified=bool(qualified),scope=SCOPE)
    save(root/"comparison.json",result)
    return result
