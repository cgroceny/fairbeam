"""Own nominal planar quadrature hybrid for Example 7.5 (p. 346).

The book's normalized circuit does not specify this board. Our frequency,
substrate and finite junctions are explicit assumptions, with no length trim.
Only raw magnitudes/relative output phase are tested against the ideal network;
individual launch factors and absolute junction-plane phase are not identified.
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

from fairbeam import Simulation, analytic, excitation, multiport, network
from tests.coax_resonator_fixture import runtime_identity as base_runtime, save, sha

ROOT = Path(__file__).resolve().parents[2]
C0, Z0, F0 = 299792458., 50., 2.4e9
ER, H, FEED, LONG_FEED = 3.38, .813, 10., 15.
FREQUENCIES = np.linspace(.5*F0, 1.5*F0, 201)
MESHES, DEFERRED_MESHES, CONTROL_MESH = (3, 4, 6), (8,), 4
LINE_LENGTHS = (20., 30.)
PAD, FAR_PAD, PML = 12., 20., 8
CAP_S, END_DB, THREADS = 16e-9, -80., 4
DT_FACTOR, CONTROL_DT_FACTOR = .7, .5
NATIVE_STEP_RATIO_MAX = .97
PROPAGATION_MARKER = "FAIRBEAM-BRANCHLINE-PROPAGATION-BEGIN"
PROTOCOL = "nominal-branchline-v5-native-bound"
LIMITS = dict(magnitude_target_abs=.05, relative_phase_target_deg=5.,
              complex_mesh_abs=.005, phase_mesh_deg=.5,
              complex_control_abs=.003, phase_control_deg=.2,
              reciprocity_abs=.005, singular_power_max=1.01,
              incident_condition_max=30., incident_floor_rel=.02)
SCOPE = "Untrimmed finite PEC microstrip hybrid; raw 50-ohm magnitudes and relative output phase, mesh/boundary/time/clock controls; no individual launch or absolute junction-phase certificate"


def identity():
    names = ("tests/branchline_fixture.py", "tests/test_branchline_fixture.py",
             "tests/coax_resonator_fixture.py", "tests/test_coax_resonator.py", "fairbeam/simulation.py",
             "fairbeam/excitation.py", "fairbeam/analytic.py", "fairbeam/multiport.py",
             "fairbeam/network.py", "fairbeam/procutil.py", "fairbeam/coax.py")
    return {name: sha(ROOT/"python"/name) for name in names}


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


def geometry():
    w50 = analytic.microstrip_width(Z0, ER, H)
    w35 = analytic.microstrip_width(Z0/np.sqrt(2), ER, H)
    def quarter(w):
        return C0/F0/np.sqrt(analytic.microstrip_eps_eff(ER,H,w))/4e-3
    lh, lv = quarter(w35), quarter(w50)
    return dict(w50_mm=w50, w35_mm=w35, horizontal_mm=lh, vertical_mm=lv,
                substrate_h_mm=H, epsilon_r=ER, tan_d=0., metal="PEC",
                metal_thickness_mm=0., scale=1., design_f_hz=F0,
                y_board_half_mm=lv/2+w35/2+6.)


def reference(freq=FREQUENCIES):
    """Independent four-node TL admittance, not the product's network solver."""
    freq = np.asarray(freq, float)
    if (freq.ndim != 1 or not freq.size or not np.isfinite(freq).all()
            or np.any(freq < .5*F0) or np.any(freq > 1.5*F0)):
        raise ValueError("finite declared normalized band required")
    theta = np.pi*freq/(2*F0)
    y = np.zeros((len(freq),4,4),complex)
    for a,b,z in ((0,1,Z0/np.sqrt(2)),(1,2,Z0),(2,3,Z0/np.sqrt(2)),(3,0,Z0)):
        diag, off = -1j/(z*np.tan(theta)), 1j/(z*np.sin(theta))
        y[:,a,a] += diag; y[:,b,b] += diag
        y[:,a,b] += off; y[:,b,a] += off
    return 2*np.linalg.inv(np.eye(4)+Z0*y)-np.eye(4)


def graded(span, first, maximum):
    points, step = [0.], first
    while points[-1] < span:
        step = min(step,maximum)
        points.append(min(points[-1]+step,span))
        step *= 1.25
    if len(points)>2 and points[-1]-points[-2]<first/2:
        points[-2]=(points[-3]+points[-1])/2
    return np.asarray(points)


def axis_lines(anchors, delta, padding, longitudinal_max=None):
    anchors=np.unique(anchors)
    pieces=[]
    for a,b in zip(anchors,anchors[1:]):
        if longitudinal_max is None or b-a<=4*delta:
            segment=np.linspace(a,b,max(1,int(np.ceil((b-a)/delta-1e-12)))+1)
        else:
            half=graded((b-a)/2,delta,longitudinal_max)
            segment=np.r_[a+half,b-half[-2::-1]]
        pieces.append(segment[:-1])
    interior=np.r_[np.concatenate(pieces),anchors[-1]]
    outside=graded(padding,delta,C0/FREQUENCIES[-1]/1e-3/20)
    end_step=outside[-1]-outside[-2]
    outside=np.r_[outside,outside[-1]+end_step*np.arange(1,PML+1)]
    return np.r_[anchors[0]-outside[:0:-1],interior,anchors[-1]+outside[1:]]


def edge_brackets(lower, upper, delta):
    """Keep one third of a cell inside each planar strip edge, two thirds out.

    This is a numerical placement, not a change of the physical strip width.
    Reference: https://wiki.openems.de/index.php/FDTD_Mesh.html
    """
    return [lower-2*delta/3, lower+delta/3, upper-delta/3, upper+2*delta/3]


def build(n, port, *, kind="hybrid", line_mm=20., feed=FEED, padding=PAD,
          end_db=END_DB, cap_s=CAP_S, dt_factor=DT_FACTOR):
    if (isinstance(n,bool) or not isinstance(n,int) or n not in MESHES+DEFERRED_MESHES
            or kind not in ("hybrid","line") or line_mm not in LINE_LENGTHS
            or isinstance(port,bool) or not isinstance(port,int)
            or port not in range(1,5 if kind=="hybrid" else 3)
            or isinstance(feed,bool) or feed not in (FEED,LONG_FEED)
            or isinstance(padding,bool) or padding not in (PAD,FAR_PAD)
            or end_db not in (-80.,-90.) or not np.isfinite(cap_s)
            or isinstance(dt_factor,bool) or dt_factor not in (DT_FACTOR,CONTROL_DT_FACTOR)
            or not CAP_S<=cap_s<=2*CAP_S):
        raise ValueError("declared mesh, device, port, geometry and time controls required")
    g=geometry(); w50,w35=g["w50_mm"],g["w35_mm"]
    xa,ya=g["horizontal_mm"]/2,g["vertical_mm"]/2
    xedge=xa+w50/2+feed if kind=="hybrid" else line_mm/2
    yh=g["y_board_half_mm"]
    sim=Simulation(FREQUENCIES[0],FREQUENCIES[-1],boundaries=[f"PML_{PML}"]*6,
                   end_criteria_db=end_db,excitation="dgauss")
    sim.dielectric("substrate",ER).AddBox(priority=0,start=[-xedge,-yh,0],stop=[xedge,yh,H])
    sim.metal("ground").AddBox(priority=10,start=[-xedge,-yh,0],stop=[xedge,yh,0])
    trace=sim.metal("traces")
    xdelta, ydelta = w50/n, w50/(n+2)
    # The two adjacent widths produce edge coordinates only (w35-w50)/2
    # apart. The smaller transverse step avoids near-colliding bracket lines
    # on the coarsest mesh; both spacings still shrink at every refinement.
    if kind=="hybrid":
        for sign in (-1,1):
            trace.AddBox(priority=10,start=[-xa-w50/2,sign*ya-w35/2,H],
                         stop=[xa+w50/2,sign*ya+w35/2,H])
            trace.AddBox(priority=10,start=[sign*xa-w50/2,-ya-w35/2,H],
                         stop=[sign*xa+w50/2,ya+w35/2,H])
        for sx,sy in ((-1,1),(1,1),(1,-1),(-1,-1)):
            trace.AddBox(priority=10,start=[sx*(xa+w50/2),sy*ya-w50/2,H],
                         stop=[sx*xedge,sy*ya+w50/2,H])
        corners=((1,-1,ya),(2,1,ya),(3,1,-ya),(4,-1,-ya))
        xanchors=[-xedge,xedge,0.,-xa,xa]
        yanchors=[-yh,yh,0.,-ya,ya]
        for sign in (-1,1):
            xanchors += edge_brackets(sign*xa-w50/2, sign*xa+w50/2, xdelta)
            for width in (w50,w35):
                yanchors += edge_brackets(sign*ya-width/2, sign*ya+width/2, ydelta)
    else:
        trace.AddBox(priority=10,start=[-xedge,-w50/2,H],stop=[xedge,w50/2,H])
        corners=((1,-1,0.),(2,1,0.))
        xanchors=[-xedge,xedge]; yanchors=[-yh,0.,yh]+edge_brackets(-w50/2,w50/2,ydelta)
    # Fine transverse cells bracket the strip edges. Along the
    # longer uniform sections, the maximum spacing is lambda_substrate/(10*n).
    # This refines propagation with n without meshing empty board regions at
    # the transverse strip resolution. Source x planes, sheet z planes and
    # physical lengths are fixed; geometric port y bounds remain continuous.
    longitudinal_max=C0/FREQUENCIES[-1]/np.sqrt(ER)/1e-3/(10*n)
    axes=dict(x=axis_lines(xanchors,xdelta,PAD,longitudinal_max),
              y=axis_lines(yanchors,ydelta,PAD,longitudinal_max),
              z=axis_lines([0.,H],H/n,PAD))
    extension={a:0. for a in axes}
    if padding==FAR_PAD:
        for a,lines in axes.items():
            step=float(lines[-1]-lines[-2])
            count=int(np.ceil((FAR_PAD-PAD)/step))
            extension[a]=count*step
            axes[a]=np.r_[lines[0]-step*np.arange(count,0,-1),lines,
                          lines[-1]+step*np.arange(1,count+1)]
    for a,lines in axes.items():
        sim.mesh.AddLine(a,lines)
    for number,sx,y in corners:
        # Use the exact node retained by the independent mesh construction.
        x=float(axes["x"][np.flatnonzero(axes["x"]==sx*xedge)[0]])
        sim.lumped_port(number,Z0,[x,y-w50/2,0.],[x,y+w50/2,H],"z",
                        excite=number==port,priority=5)
    dt=dt_factor/(C0*np.sqrt(sum((np.min(np.diff(v))*sim.unit)**-2 for v in axes.values())))
    steps=int(math.ceil(cap_s/dt))
    sim.max_timesteps=steps
    sim.fdtd.SetTimeStep(float(dt)); sim.fdtd.SetNumberOfTimeSteps(steps)
    sim.fdtd.SetOverSampling(4)
    errors=sim.csx.Update()
    if errors:
        raise ValueError(f"invalid native geometry: {errors}")
    meta=dict(protocol=PROTOCOL,n=n,kind=kind,line_mm=float(line_mm),feed_mm=float(feed),
        padding_mm=float(padding),excited_port=port,geometry=g,ports=sim.ports,
        boundary_extension_actual_mm=extension,
        end_db=float(end_db),cap_s=float(cap_s),threads=THREADS,scope=SCOPE,
        dt_factor=float(dt_factor),
        longitudinal_max_mm=float(longitudinal_max),
        edge_rule="thirds",edge_spacing_mm=dict(x=xdelta,y=ydelta),
        mesh_mm={a:v.tolist() for a,v in axes.items()},native_lines=[len(axes[a]) for a in "xyz"],
        native_cells=int(np.prod([len(axes[a]) for a in "xyz"])),declared_dt_s=float(dt),max_timesteps=steps,
        source_duration_s=excitation.dgauss_duration_s(FREQUENCIES[-1]),
        excitation=sim.excitation,f_max_hz=float(FREQUENCIES[-1]),boundaries=sim.boundaries)
    return sim,meta


def trace_clock(data,native):
    data=np.asarray(data,float)
    stride=int(1/(2*FREQUENCIES[-1]*native["dt_s"]*4))
    if (data.ndim!=2 or len(data)<3 or data.shape[1]<2 or not np.isfinite(data).all() or stride<1
            or np.any(np.diff(data[:,0])<=0)
            or not np.allclose(np.diff(data[:,0]),stride*native["dt_s"],rtol=2e-5,atol=native["dt_s"]*1e-5)
            or data[-1,0]>native["numerical_time_s"]+stride*native["dt_s"]):
        raise ValueError("finite traces with the measured native sampling clock required")
    return dict(samples=len(data),first_s=float(data[0,0]),last_s=float(data[-1,0]),stride_steps=stride)


def native_bound_ok(meta):
    """Recompute the setup-only admission check rather than trust its flag."""
    record=meta.get("operator_preflight",{})
    run=record.get("run",{})
    bound=run.get("timestep_s",0.)
    if not isinstance(bound,(int,float)) or not np.isfinite(bound) or bound<=0:
        return False
    return bool(record.get("setup_only") is True
        and record.get("ratio_limit")==NATIVE_STEP_RATIO_MAX
        and record.get("planned_dt_s")==meta["declared_dt_s"]
        and record.get("planned_dt_s")/bound<=NATIVE_STEP_RATIO_MAX
        and run.get("grid")==meta["native_lines"]
        and run.get("threads")==THREADS and run.get("engine")=="cpu"
        and run.get("exact_endcriteria") is True
        and run.get("converged") is False and run.get("energy_trace")==[]
        and "timesteps" not in run)


def operator_preflight(out,n,port,**options):
    """Ask the identical native operator for its unforced stability bound.

    This creates the operator only. No field propagation or qualified result
    is produced; a separate Simulation performs the admitted acquisition.
    """
    out=Path(out)
    setup,meta=build(n,port,**options)
    setup.fdtd.SetTimeStep(0.)
    setup.fdtd.Write2XML(str(out/"operator-input.xml"))
    run=setup.run(str(out/"operator"),threads=THREADS,exact=True,echo=True,setup_only=True)
    record=dict(setup_only=True,planned_dt_s=meta["declared_dt_s"],
        ratio_limit=NATIVE_STEP_RATIO_MAX,input_sha256=sha(out/"operator-input.xml"),run=run)
    meta["operator_preflight"]=record
    record["passes"]=native_bound_ok(meta)
    save(out/"operator.json",record)
    if not record["passes"]:
        raise ValueError("planned timestep exceeds the native setup-only stability admission bound")
    return record


def record_quality(meta):
    native,run,header=meta["native"],meta["run"],meta.get("native_header",{})
    return {k:bool(v) for k,v in dict(
        grid_ok=native["cells"]==meta["native_cells"] and run.get("grid")==meta["native_lines"],
        clock_ok=abs(native["dt_s"]/meta["declared_dt_s"]-1)<1e-8,
        native_bound_ok=native_bound_ok(meta),
        native_time_ok=native["timesteps"]>0 and abs(native["numerical_time_s"]/(native["timesteps"]*native["dt_s"])-1)<1e-8,
        header_ok=header.get("version")=="v0.37.0-rc3" and header.get("threads")==THREADS
            and header.get("nyquist_interval")==int(1/(2*meta["f_max_hz"]*native["dt_s"]))
            and header.get("excitation_timesteps")==meta["max_timesteps"],
        source_completed=native["numerical_time_s"]>meta["source_duration_s"],
        native_stop=run.get("converged") and run.get("exact_endcriteria") and not run.get("hit_timestep_limit")
            and run.get("threads")==THREADS and native["timesteps"]<meta["max_timesteps"]).items()}


def acquire(out,n,port,**options):
    out=Path(out);out.mkdir(parents=True,exist_ok=False)
    sim,meta=build(n,port,**options)
    source,runtime=identity(),runtime_identity()
    sim.fdtd.Write2XML(str(out/"input.xml"))
    meta.update(source_sha256=source,runtime=runtime,limits=LIMITS,input_sha256=sha(out/"input.xml"),
                started_utc=datetime.now(timezone.utc).isoformat())
    save(out/"declared.json",meta)
    meta["operator_preflight"]=operator_preflight(out,n,port,**options)
    meta["operator_sha256"]=sha(out/"operator.json")
    if source!=identity() or runtime!=runtime_identity():
        raise RuntimeError("source/runtime changed during operator preflight")
    save(out/"declared.json",meta)
    print(PROPAGATION_MARKER,flush=True)
    sim.run(str(out/"raw"),threads=THREADS,exact=True,echo=True,dump_statistics=True)
    stats=np.loadtxt(out/"raw/openEMS_stats.txt",comments="%")
    native=dict(cells=int(stats[0]),dt_s=float(stats[1]),timesteps=int(stats[2]),
                numerical_time_s=float(stats[3]),iteration_wall_s=float(stats[4]))
    v,i,traces=[],[],{}
    for p in sim._port_objs:
        p.CalcPort(str(out/"raw"),FREQUENCIES)
        v.append(p.uf_tot);i.append(p.if_tot)
        for name in p.U_filenames+p.I_filenames:
            path=out/"raw"/name
            traces[name]=dict(sha256=sha(path),**trace_clock(np.loadtxt(path,comments="%",ndmin=2),native))
    np.savez_compressed(out/"waves.npz",frequency_hz=FREQUENCIES,v=v,i=i)
    if source!=identity() or runtime!=runtime_identity():
        raise RuntimeError("source/runtime changed during acquisition")
    meta.update(native=native,run=sim.run_stats,waves_sha256=sha(out/"waves.npz"),raw_traces=traces,
                completed_utc=datetime.now(timezone.utc).isoformat())
    save(out/"report.json",meta)
    return meta


def read(out):
    out=Path(out);meta=json.loads((out/"report.json").read_text(encoding="utf-8"))
    if meta["source_sha256"]!=identity() or meta["runtime"]!=runtime_identity() or meta["limits"]!=LIMITS:
        raise ValueError("source/runtime/limits changed; keep acquisition epochs separate")
    if sha(out/"input.xml")!=meta["input_sha256"] or sha(out/"waves.npz")!=meta["waves_sha256"]:
        raise ValueError("native input or wave data changed")
    if (sha(out/"operator.json")!=meta["operator_sha256"]
            or json.loads((out/"operator.json").read_text(encoding="utf-8"))!=meta["operator_preflight"]
            or sha(out/"operator-input.xml")!=meta["operator_preflight"]["input_sha256"]
            or not native_bound_ok(meta)):
        raise ValueError("changed or failed native operator stability preflight")
    _,expected=build(meta["n"],meta["excited_port"],kind=meta["kind"],line_mm=meta["line_mm"],
        feed=meta["feed_mm"],padding=meta["padding_mm"],end_db=meta["end_db"],cap_s=meta["cap_s"],dt_factor=meta["dt_factor"])
    if any(meta[k]!=value for k,value in json.loads(json.dumps(expected)).items()):
        raise ValueError("different declared geometry or acquisition settings")
    count=4 if meta["kind"]=="hybrid" else 2
    if set(meta["raw_traces"])!={f"port_{k}t_{p}" for k in ("u","i") for p in range(1,count+1)}:
        raise ValueError("all native voltage/current traces required")
    for name,record in meta["raw_traces"].items():
        path=out/"raw"/name
        if dict(sha256=sha(path),**trace_clock(np.loadtxt(path,comments="%",ndmin=2),meta["native"]))!=record:
            raise ValueError("changed native trace or clock")
    with np.load(out/"waves.npz") as data:
        np.testing.assert_array_equal(data["frequency_hz"],FREQUENCIES)
        v,i=data["v"].copy(),data["i"].copy()
    if v.shape!=(count,len(FREQUENCIES)) or v.shape!=i.shape or not np.isfinite(v).all() or not np.isfinite(i).all():
        raise ValueError("complete finite native waves required")
    active=meta["excited_port"]-1
    if not np.any(abs(v[active])+Z0*abs(i[active])>0):
        raise ValueError("zero excited-port fields; reject the source plane before further runs")
    return meta,v,i,record_quality(meta)


def waves_to_s(v,i):
    v,i=np.asarray(v,complex),np.asarray(i,complex)
    if (v.shape!=i.shape or v.ndim!=3 or v.shape[0]!=v.shape[1] or v.shape[0] not in (2,4)
            or v.shape[2]!=len(FREQUENCIES) or not np.isfinite(v).all() or not np.isfinite(i).all()):
        raise ValueError("complete finite two-/four-source port arrays required")
    a,b=(v+Z0*i)/(2*np.sqrt(Z0)),(v-Z0*i)/(2*np.sqrt(Z0))
    incoming=a.transpose(2,1,0)
    singular=np.linalg.svd(incoming,compute_uv=False)
    with np.errstate(over="ignore",invalid="ignore"):
        condition=singular[:,0]/np.maximum(singular[:,-1],np.finfo(float).tiny)
    scale=float(singular[:,0].max())
    floor=float(singular[:,-1].min()/scale) if scale else 0.
    if not np.isfinite(condition).all() or condition.max()>LIMITS["incident_condition_max"] or floor<LIMITS["incident_floor_rel"]:
        raise ValueError("poorly conditioned or unexcited incident-wave matrix")
    count=v.shape[0]
    s=multiport.assemble_s(a,b,list(range(1,count+1)),count)
    residual=float(abs(s-b.transpose(2,1,0)@np.linalg.inv(incoming)).max())
    return s,dict(incident_condition_max=float(condition.max()),incident_floor_rel=floor,inverse_residual_abs=residual)


def relative_phase(s):
    s=np.asarray(s,complex)
    if s.shape!=(len(FREQUENCIES),4,4) or not np.isfinite(s).all() or np.any(abs(s[:,(1,2),0])<.1):
        raise ValueError("relative phase needs finite non-null hybrid outputs")
    return np.angle(s[:,1,0]*np.conj(s[:,2,0]),deg=True)


def phase_delta(a,b):
    return (relative_phase(a)-relative_phase(b)+180)%360-180


def matrix(root):
    root=Path(root);first=json.loads((root/"port1/report.json").read_text(encoding="utf-8"))
    count=4 if first["kind"]=="hybrid" else 2
    records=[read(root/f"port{p}") for p in range(1,count+1)]
    keys=("n","kind","line_mm","feed_mm","padding_mm","end_db","cap_s","dt_factor","geometry","mesh_mm")
    if any(r[0]["excited_port"]!=p or any(r[0][k]!=first[k] for k in keys) for p,r in enumerate(records,1)):
        raise ValueError("mixed cohort settings")
    s,quality=waves_to_s(np.array([r[1] for r in records]),np.array([r[2] for r in records]))
    result={k:first[k] for k in keys if k!="mesh_mm"}
    result.update(wave_quality=quality,quality=[r[3] for r in records],
        all_native_complete=all(all(r[3].values()) for r in records),qualified=False,
        absolute_launch_phase_qualified=False,
        reciprocity_max_abs=float(abs(s-s.transpose(0,2,1)).max()),
        singular_power_max=float((np.linalg.svd(s,compute_uv=False)[:,0]**2).max()))
    if count==4:
        target=reference()
        result.update(magnitude_target_abs=float(abs(abs(s)-abs(target)).max()),
            relative_phase_target_deg=float(abs(phase_delta(s,target)).max()),
            raw_complex_target_diagnostic_abs=float(abs(s-target).max()))
        result["target_passes"]=bool(result["magnitude_target_abs"]<=LIMITS["magnitude_target_abs"]
            and result["relative_phase_target_deg"]<=LIMITS["relative_phase_target_deg"]
            and result["reciprocity_max_abs"]<=LIMITS["reciprocity_abs"]
            and result["singular_power_max"]<=LIMITS["singular_power_max"])
    np.savez_compressed(root/"matrix.npz",frequency_hz=FREQUENCIES,s=s)
    save(root/"comparison.json",result)
    return s,result


def study(root):
    root=Path(root)
    ordinary=[matrix(root/f"n{n}") for n in MESHES]
    for n,(_,r) in zip(MESHES,ordinary):
        if (r["n"],r["kind"],r["feed_mm"],r["padding_mm"],r["end_db"],r["cap_s"],r["dt_factor"])!=(n,"hybrid",FEED,PAD,END_DB,CAP_S,DT_FACTOR):
            raise ValueError("incorrect ordinary cohort identity")
    mesh=[float(abs(b[0]-a[0]).max()) for a,b in zip(ordinary,ordinary[1:])]
    phase=[float(abs(phase_delta(b[0],a[0])).max()) for a,b in zip(ordinary,ordinary[1:])]
    control=ordinary[MESHES.index(CONTROL_MESH)][0]
    controls={}
    for name,expected in (("pad",(FEED,FAR_PAD,END_DB,CAP_S,DT_FACTOR)),
                          ("time",(FEED,PAD,-90.,2*CAP_S,DT_FACTOR)),
                          ("dt",(FEED,PAD,END_DB,CAP_S,CONTROL_DT_FACTOR))):
        s,r=matrix(root/f"n{CONTROL_MESH}_{name}")
        if (r["n"],r["kind"])!=(CONTROL_MESH,"hybrid") or tuple(r[k] for k in ("feed_mm","padding_mm","end_db","cap_s","dt_factor"))!=expected:
            raise ValueError("incorrect independent control identity")
        change,pchange=float(abs(s-control).max()),float(abs(phase_delta(s,control)).max())
        controls[name]=dict(complex_max_abs=change,relative_phase_max_deg=pchange,native=r,
            passes=change<=LIMITS["complex_control_abs"] and pchange<=LIMITS["phase_control_deg"])
    # No invented split of g1*g2. This removes only the added feed propagation,
    # conditional on the explicitly matched, reciprocal control-line model.
    short,sr=matrix(root/f"n{CONTROL_MESH}_line20");long,lr=matrix(root/f"n{CONTROL_MESH}_line30")
    for length,r in ((20.,sr),(30.,lr)):
        if (r["n"],r["kind"],r["line_mm"],r["feed_mm"],r["padding_mm"],r["end_db"],r["cap_s"],r["dt_factor"])!=(CONTROL_MESH,"line",length,FEED,PAD,END_DB,CAP_S,DT_FACTOR):
            raise ValueError("incorrect calibration-line identity")
    extended,er=matrix(root/f"n{CONTROL_MESH}_feed")
    if (er["n"],er["kind"],er["feed_mm"],er["padding_mm"],er["end_db"],er["cap_s"],er["dt_factor"])!=(CONTROL_MESH,"hybrid",LONG_FEED,PAD,END_DB,CAP_S,DT_FACTOR):
        raise ValueError("incorrect extended-feed identity")
    try:
        hint=2*np.pi*FREQUENCIES/C0*np.sqrt(analytic.microstrip_eps_eff(ER,H,geometry()["w50_mm"]))
        cal=network.two_line_calibration(FREQUENCIES,short,long,short_length_m=.020,long_length_m=.030,beta_hint=hint)
        shifted=network.shift_reference_planes(extended,cal["gamma_per_m"],(LONG_FEED-FEED)*1e-3)
        change,pchange=float(abs(shifted-control).max()),float(abs(phase_delta(shifted,control)).max())
        controls["feed"]=dict(complex_max_abs=change,relative_phase_max_deg=pchange,
            raw_complex_change=float(abs(extended-control).max()),
            calibration_match_max=cal["match_max"],calibration_reciprocity_max=cal["reciprocity_max"],
            native=er,calibration_native_complete=sr["all_native_complete"] and lr["all_native_complete"],
            passes=change<=LIMITS["complex_control_abs"] and pchange<=LIMITS["phase_control_deg"])
    except ValueError as error:
        controls["feed"]=dict(passes=False,reason=str(error),native=er,
            calibration_native_complete=sr["all_native_complete"] and lr["all_native_complete"])
    qualified=bool(all(r["all_native_complete"] and r["target_passes"] for _,r in ordinary)
        and all(v<=LIMITS["complex_mesh_abs"] for v in mesh) and all(v<=LIMITS["phase_mesh_deg"] for v in phase)
        and all(r["passes"] and r["native"]["all_native_complete"] for r in controls.values())
        and controls["feed"]["calibration_native_complete"])
    result=dict(protocol=PROTOCOL,limits=LIMITS,scope=SCOPE,meshes=[r for _,r in ordinary],
        mesh_changes=mesh,relative_phase_mesh_deg=phase,controls=controls,qualified=qualified,
        absolute_launch_phase_qualified=False)
    save(root/"comparison.json",result)
    return result
