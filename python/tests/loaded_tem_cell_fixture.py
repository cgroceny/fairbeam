"""Own finite capacitively loaded TEM cell: Example 8.1, p. 386.

PEC plates and PMC sidewalls define a circuit dual, not a printed-stub or
Floquet-engine certificate. Nominal capacitance is never fitted to fields.
Native runs are opt-in; ordinary tests only construct geometry or use arrays.
"""
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
import sys

import numpy as np
import CSXCAD
from openEMS import ports as native_ports
from openEMS.ports import UI_data
from openEMS.physical_constants import EPS0, Z0 as ETA0

from fairbeam import Simulation, excitation, multiport
from tests.coax_resonator_fixture import save, sha, runtime_identity as base_runtime

ROOT=Path(__file__).resolve().parents[2]
C0, Z0, PERIOD, CAPACITANCE, HEIGHT = 299792458., 50., .01, 2.666e-12, .0005
WIDTH=ETA0*HEIGHT/Z0
FREQUENCIES=np.linspace(2.4e9,3.2e9,81)
MESHES, COUNTS, THREADS, CONTROL_MESH = (4,6,8), (1,2,3), 4, 4
ELEMENT_SCALES = (1,4,8)
CONTROLS=('ordinary','boundary','guard','backing','transverse','element','time','dt')
CAP_S, END_DB, NATIVE_STEP_RATIO_MAX = 12e-9, -100., .97
PROTOCOL='loaded-tem-cell-v3'
PROPAGATION_MARKER='FAIRBEAM-LOADED-TEM-PROPAGATION-BEGIN'
SCOPE=('Finite PEC/PMC parallel-plate TEM circuit dual, nominal separate native '
       'capacitors and midpoint voltage/current planes. No printed-stub, '
       'arbitrary launch, finite-conductor or Floquet-boundary certificate.')
LIMITS=dict(s_target_abs=.005,phase_target_deg=.5,s_mesh_abs=.0025,phase_mesh_deg=.2,
    s_control_abs=.001,phase_control_deg=.1,beta_target_rel=.005,z_target_rel=.01,
    beta_mesh_rel=.0025,z_mesh_rel=.005,beta_control_rel=.001,z_control_rel=.002,
    contour_s_abs=.001,recurrence_residual=.001,incident_condition=30.,
    incident_floor=.02,reciprocity_abs=.001,singular_power_max=1.005,
    cell_count_abs=.005)


def identity():
    names=('tests/loaded_tem_cell_fixture.py','tests/test_loaded_tem_cell_fixture.py',
        'tests/coax_resonator_fixture.py','tests/test_coax_resonator.py',
        'fairbeam/simulation.py','fairbeam/excitation.py','fairbeam/multiport.py',
        'fairbeam/network.py','fairbeam/procutil.py')
    return {name:sha(ROOT/'python'/name) for name in names}


def runtime_identity():
    value=base_runtime()
    value.update(python=sys.version,executable=sys.executable,numpy=np.__version__,
                 native_ports_sha256=sha(native_ports.__file__))
    value['csxcad_bindings']={str(p.resolve()):sha(p) for p in
        sorted(Path(CSXCAD.__file__).parent.glob('*.pyd'))+sorted(Path(CSXCAD.__file__).parent.glob('*.so'))+[Path(CSXCAD.__file__)]}
    return value


def _choice(value,choices,label):
    if isinstance(value,bool) or not isinstance(value,int) or value not in choices:
        raise ValueError('declared integer '+label+' required')


def reference(count=1,kind='loaded',freq=FREQUENCIES):
    """Independent symmetric line(d/2), shunt(C), line(d/2) ABCD cascade."""
    _choice(count,COUNTS,'cell count')
    if np.iscomplexobj(freq):raise ValueError('real frequencies required')
    f=np.asarray(freq,float)
    if kind not in ('loaded','unloaded') or f.ndim!=1 or not f.size or not np.isfinite(f).all() or np.any((f<2.4e9)|(f>3.2e9)):
        raise ValueError('declared kind and finite sampled frequencies in 2.4..3.2 GHz required')
    theta=2*np.pi*f*PERIOD/C0
    line=np.zeros((len(f),2,2),complex)
    line[:,0,0]=line[:,1,1]=np.cos(theta/2)
    line[:,0,1],line[:,1,0]=1j*Z0*np.sin(theta/2),1j*np.sin(theta/2)/Z0
    load=np.broadcast_to(np.eye(2,dtype=complex),line.shape).copy()
    if kind=='loaded':load[:,1,0]=2j*np.pi*f*CAPACITANCE
    cell=line@load@line
    total=np.linalg.matrix_power(cell,count)
    a,b,c,d=(total[:,j,k] for j,k in ((0,0),(0,1),(1,0),(1,1)))
    den=a+b/Z0+c*Z0+d
    s=np.empty_like(total)
    s[:,0,0],s[:,1,1]=(a+b/Z0-c*Z0-d)/den,(-a+b/Z0-c*Z0+d)/den
    s[:,1,0],s[:,0,1]=2/den,2*(a*d-b*c)/den
    return s,cell


def chain(s):
    s=np.asarray(s,complex)
    if s.shape!=(len(FREQUENCIES),2,2) or not np.isfinite(s).all() or np.any(abs(s[:,1,0])<.02):
        raise ValueError('finite full-rank two-port transfer required')
    a,b,c,d=s[:,0,0],s[:,0,1],s[:,1,0],s[:,1,1]
    t=np.empty_like(s)
    t[:,0,0]=((1+a)*(1-d)+b*c)/(2*c)
    t[:,0,1]=Z0*((1+a)*(1+d)-b*c)/(2*c)
    t[:,1,0]=((1-a)*(1-d)-b*c)/(2*Z0*c)
    t[:,1,1]=((1-a)*(1+d)+b*c)/(2*c)
    return t


def spread_reference(spacing_m,freq=FREQUENCIES):
    """Separate C/3 shunts at -spacing, 0, +spacing; fixed total C.

    This describes the three native voltage columns, not a replacement for
    the original point target. At zero spacing it reduces to that target.
    """
    if isinstance(spacing_m,bool) or not np.isfinite(spacing_m) or not 0<=spacing_m<PERIOD/2:
        raise ValueError('finite nonnegative column spacing below half a period required')
    reference(1,'loaded',freq)  # Keep the same frequency-domain admission.
    f=np.asarray(freq,float)
    def line(length):
        theta=2*np.pi*f*length/C0;t=np.empty((len(f),2,2),complex)
        t[:,0,0]=t[:,1,1]=np.cos(theta)
        t[:,0,1],t[:,1,0]=1j*Z0*np.sin(theta),1j*np.sin(theta)/Z0
        return t
    shunt=np.broadcast_to(np.eye(2,dtype=complex),(len(f),2,2)).copy()
    shunt[:,1,0]=2j*np.pi*f*CAPACITANCE/3
    outer,inner=line(PERIOD/2-spacing_m),line(spacing_m)
    t=outer@shunt@inner@shunt@inner@shunt@outer
    a,b,c,d=(t[:,j,k] for j,k in ((0,0),(0,1),(1,0),(1,1)))
    den=a+b/Z0+c*Z0+d;s=np.empty_like(t)
    s[:,0,0],s[:,1,1]=(a+b/Z0-c*Z0-d)/den,(-a+b/Z0-c*Z0+d)/den
    s[:,1,0],s[:,0,1]=2/den,2*(a*d-b*c)/den
    return s,t


def bloch(t):
    """Only a calibrated SINGLE midpoint cell; signed attenuation is retained."""
    t=np.asarray(t,complex)
    if t.shape!=(len(FREQUENCIES),2,2) or not np.isfinite(t).all() or np.any(abs(t[:,1,0])<1e-10):
        raise ValueError('finite calibrated single-cell transfer required')
    g=np.arccosh((t[:,0,0]+t[:,1,1])/2)/PERIOD
    g=np.where(g.imag<0,-g,g)
    z=np.sqrt(t[:,0,1]/t[:,1,0]);z=np.where(z.real<0,-z,z)
    if np.any((g.imag*PERIOD<=0)|(g.imag*PERIOD>=np.pi)) or not np.isfinite(g).all() or not np.isfinite(z).all():
        raise ValueError('declared first pass-band branch required')
    return g,z


def phase_change(a,b):
    return float(np.max(abs(np.angle(a[:,1,0]*np.conj(b[:,1,0]),deg=True))))


def normalize_chain(t):
    return np.asarray(t)*np.array([[1.,1/Z0],[Z0,1.]])


class TEMSimulation(Simulation):
    def to_bundle(self,*args,**kwargs):
        raise ValueError('research TEM probes have no Designer bundle representation')


def build(n,count,port,kind='loaded',control='ordinary',*,element_scale=1):
    _choice(n,MESHES,'mesh');_choice(count,COUNTS,'cell count');_choice(port,(1,2),'source')
    _choice(element_scale,ELEMENT_SCALES,'element spacing factor')
    if element_scale!=1 and (n!=CONTROL_MESH or count!=1 or kind!='loaded' or control not in ('ordinary','element')):
        raise ValueError('local element refinement is limited to the paired single loaded cell')
    if kind not in ('loaded','unloaded') or control not in CONTROLS or (control!='ordinary' and (count!=1 or kind!='loaded')):
        raise ValueError('declared kind and independent single-loaded-cell control required')
    dx=HEIGHT/n;ny=(8 if control=='transverse' else 4)*n
    extent=(10*count+(40 if control=='boundary' else 30))*n
    x=np.arange(-extent,extent+1)*dx
    base_x=x
    pitch=dx/element_scale
    if element_scale!=1:x=np.unique(np.r_[x,np.arange(-element_scale,element_scale+1)*pitch])
    # PMC walls sit on the first/last H dual planes, not the end E nodes.
    # Keep their physical separation WIDTH at every mesh; E rows 1..ny-1
    # each represent one full dual strip. The end rows are outside the TEM.
    y=(np.arange(ny+1)-.5)*(WIDTH/(ny-1))
    z=np.r_[np.linspace(0.,HEIGHT,n+1),HEIGHT+np.arange(1,3 if control=='backing' else 2)*dx]
    # Every spatial control at a mesh shares its prospective worst clock.
    dt=(.35 if control=='dt' else .5)/(C0*np.sqrt((element_scale**2+1)/dx**2+(8*n/WIDTH)**2))
    cap=CAP_S*(2 if control=='time' else 1);end=END_DB-(10 if control=='time' else 0)
    steps=math.ceil(cap/dt)
    sim=TEMSimulation(FREQUENCIES[0],FREQUENCIES[-1],excitation='dgauss',
        end_criteria_db=end,max_timesteps=steps,boundaries=['PML_8','PML_8','PMC','PMC','PEC','PEC'])
    for axis,values in zip('xyz',(x,y,z)):sim.mesh.AddLine(axis,values/sim.unit)
    sim.fdtd.SetTimeStep(float(dt));sim.fdtd.SetOverSampling(4)
    metal=sim.metal('upper_conductor')
    metal.AddBox([x[0]/sim.unit,y[0]/sim.unit,HEIGHT/sim.unit],[x[-1]/sim.unit,y[-1]/sim.unit,z[-1]/sim.unit],priority=10)
    mesh_x=np.asarray(sim.mesh.GetLines('x'))
    def index(base_index):
        return int(np.argmin(abs(mesh_x-base_x[base_index]/sim.unit)))
    sources=[]
    guard=(25 if control=='guard' else 20)*n
    for number,sign in ((1,-1),(2,1)):
        ix=index(extent+sign*(10*count*n+guard));sx=float(mesh_x[ix]);sources.append(sx*sim.unit)
        sim.lumped_port(number,Z0,[sx,y[1]/sim.unit,0.],
            [sx,y[-2]/sim.unit,HEIGHT/sim.unit],'z',excite=number==port)
    native_c=[]
    if kind=='loaded':
        for j in range(count):
            ix=index(extent+(2*j-count+1)*10*n)
            radius=1 if control=='element' else 0
            a,b=float(mesh_x[ix-radius]),float(mesh_x[ix+radius])
            # The native parallel RC operator REPLACES each included edge C.
            # Include the known vacuum capacitance of its (2r+1) dual columns
            # so the incremental physical load is CAPACITANCE. Only active E
            # rows are included: no response fit or ghost-row renormalization.
            air=EPS0*WIDTH*(2*radius+1)*pitch/HEIGHT
            native=CAPACITANCE+air
            sim.lumped_capacitor(f'cell_C{j+1}',native,[a,y[1]/sim.unit,0.],
                [b,y[-2]/sim.unit,HEIGHT/sim.unit],'z')
            native_c.append(dict(capacitance_f=CAPACITANCE,native_capacitance_f=float(native),
                replaced_air_capacitance_f=float(air),active_voltage_rows=ny-1,
                longitudinal_voltage_columns=2*radius+1,start_x_m=a*sim.unit,stop_x_m=b*sim.unit))
    dual_y=(y[:-1]+y[1:])/2;margin=.01*(y[1]-y[0])
    contours={label:dict(a=a,b=b,lo=float(dual_y[a]+margin),hi=float(dual_y[b]-margin),
        enclosed_span_m=float(dual_y[b]-dual_y[a]),weight=float(WIDTH/(dual_y[b]-dual_y[a])))
        for label,a,b in (('outer',0,ny-1),('inner',ny//4,3*ny//4-1))}
    zlo=HEIGHT-dx/2+.01*dx;zhi=HEIGHT+dx/2-.01*dx
    indices={};planes=[]
    for p,sign in enumerate((-1,1)):
        ix=index(extent+sign*10*count*n);planes.append(float(mesh_x[ix]*sim.unit))
        for j in range(3):
            sx=float(mesh_x[ix+j-1])
            sim.csx.AddProbe(f'v{p}_{j}',p_type=0).AddBox([sx,WIDTH/(2*sim.unit),HEIGHT/sim.unit],[sx,WIDTH/(2*sim.unit),0.])
        for j in range(2):
            sx=float((mesh_x[ix+j-1]+mesh_x[ix+j])/2)
            for label,c in contours.items():
                name=f'i{p}_{label}_{j}'
                sim.csx.AddProbe(name,p_type=1,norm_dir=0,weight=c['weight']).AddBox(
                    [sx,c['lo']/sim.unit,zlo/sim.unit],[sx,c['hi']/sim.unit,zhi/sim.unit])
                indices[name]=[[ix+j-1,c['a'],n-1],[ix+j-1,c['b'],n]]
    for prop in sim.csx.GetAllProperties():prop.SetColor((128,128,128),alpha=prop.GetFillColor()[3])
    if sim.csx.Update():raise ValueError('invalid native TEM geometry')
    meta=dict(protocol=PROTOCOL,n=n,count=count,excited_port=port,kind=kind,control=control,
        mesh_mm={a:sim.mesh.GetLines(a).tolist() for a in 'xyz'},grid=[len(x),len(y),len(z)],
        native_cells=int(len(x)*len(y)*len(z)),declared_dt_s=float(dt),max_timesteps=steps,
        cap_s=cap,end_db=end,threads=THREADS,planes_m=planes,source_planes_m=sources,
        period_m=PERIOD,height_m=HEIGHT,width_m=float(WIDTH),reference_ohm=Z0,
        physical_pmc_planes_m=[float(dual_y[0]),float(dual_y[-1])],
        native_capacitors=native_c,current_contours=contours,expected_current_indices=indices,
        source_duration_s=excitation.dgauss_duration_s(FREQUENCIES[-1]),scope=SCOPE)
    if element_scale!=1:meta['element_scale']=element_scale
    return sim,meta


def assemble(v,i):
    a,b=(v+Z0*i)/(2*np.sqrt(Z0)),(v-Z0*i)/(2*np.sqrt(Z0))
    incoming=a.transpose(2,1,0);sv=np.linalg.svd(incoming,compute_uv=False)
    condition=float(np.max(sv[:,0]/np.maximum(sv[:,-1],np.finfo(float).tiny)))
    floor=float(sv[:,-1].min()/max(sv[:,0].max(),np.finfo(float).tiny))
    if condition>LIMITS['incident_condition'] or floor<LIMITS['incident_floor']:
        raise ValueError('unexcited or ill-conditioned incoming waves')
    return multiport.assemble_s(a,b,[1,2],2),dict(incident_condition=condition,incident_floor=floor)


def extract(v,i):
    v,i=np.asarray(v,complex),np.asarray(i,complex);nf=len(FREQUENCIES)
    if v.shape!=(2,2,3,nf) or i.shape!=(2,2,2,2,nf) or not np.isfinite(v).all() or not np.isfinite(i).all():
        raise ValueError('finite complete two-source voltage/current arrays required')
    u=v[:,:,1];denom=2*np.sum(abs(u)**2,axis=0)
    if np.any(denom<.01*np.max(np.sum(abs(v)**2,axis=0),axis=1)) or np.any(denom==0):
        raise ValueError('missing voltage or standing-wave node')
    r=np.sum(np.conj(u)*(v[:,:,0]+v[:,:,2]),axis=0)/denom
    half=np.sqrt((r+1)/2)
    if not np.isfinite(half).all() or np.any((abs(half)<.5)|(abs(half)>1.5)):
        raise ValueError('invalid measured local current staggering')
    residual=float(abs(v[:,:,0]+v[:,:,2]-2*r[None]*u).max()/abs(v).max())
    spectra=[];quality=[]
    for loop in range(2):
        current=i[:,:,loop].mean(axis=2)/half
        s,q=assemble(u,current*np.array([1.,-1.])[None,:,None])
        spectra.append(s);quality.append(q)
    return spectra[0],dict(contour_s_abs=float(abs(spectra[0]-spectra[1]).max()),
        recurrence_residual=residual,incident_condition=max(q['incident_condition'] for q in quality),
        incident_floor=min(q['incident_floor'] for q in quality),current_half_factor=half,
        alternate_contour_s=spectra[1])


def required_usage(sim):
    names={'upper_conductor'}|{p.GetName() for p in sim.csx.GetAllProperties() if p.GetName().startswith('cell_C')}
    return {p.GetName():[bool(x.GetPrimitiveUsed()) for x in p.GetAllPrimitives()]
            for p in sim.csx.GetAllProperties() if p.GetName() in names}


def operator_preflight(out,n,count,port,kind='loaded',control='ordinary',*,element_scale=1):
    out=Path(out);sim,meta=build(n,count,port,kind,control,element_scale=element_scale)
    sim.fdtd.SetTimeStep(0.);sim.fdtd.Write2XML(str(out/'operator-input.xml'))
    run=sim.run(str(out/'operator'),threads=THREADS,exact=True,echo=True,setup_only=True)
    record=dict(setup_only=True,planned_dt_s=meta['declared_dt_s'],run=run,
        ratio_limit=NATIVE_STEP_RATIO_MAX,input_sha256=sha(out/'operator-input.xml'),required_usage=required_usage(sim))
    save(out/'operator.json',record)
    if not native_bound_ok({**meta,'operator_preflight':record}):
        raise ValueError('native stability or required material admission failed')
    return record


def native_bound_ok(meta):
    record=meta.get('operator_preflight',{});run=record.get('run',{})
    bound=run.get('timestep_s',0.);usage=record.get('required_usage',{})
    expected={'upper_conductor'}|({f'cell_C{j+1}' for j in range(meta['count'])} if meta['kind']=='loaded' else set())
    return bool(isinstance(bound,(int,float)) and not isinstance(bound,bool) and np.isfinite(bound) and bound>0 and record.get('setup_only') is True
        and record.get('ratio_limit')==NATIVE_STEP_RATIO_MAX and record.get('planned_dt_s')==meta['declared_dt_s']
        and meta['declared_dt_s']/bound<=NATIVE_STEP_RATIO_MAX and run.get('grid')==meta['grid']
        and run.get('threads')==THREADS and set(usage)==expected and all(values==[True] for values in usage.values()))


def probe_names():
    return ([f'v{p}_{j}' for p in range(2) for j in range(3)],
            [f'i{p}_{label}_{j}' for p in range(2) for label in ('outer','inner') for j in range(2)])


def probe_spectra(raw):
    vn,cn=probe_names()
    v=np.asarray(UI_data(vn,str(raw),FREQUENCIES).ui_f_val).reshape(2,3,-1)
    i=np.asarray(UI_data(cn,str(raw),FREQUENCIES).ui_f_val).reshape(2,2,2,-1)
    return v,i


def trace_clock(data,meta,*,magnetic=False):
    data=np.asarray(data,float)
    if data.ndim!=2 or len(data)<3 or data.shape[1]!=2 or not np.isfinite(data).all():
        raise ValueError('finite complete native probe clock required')
    native=meta['native'];dt=native['dt_s'];stride=int(1/(2*FREQUENCIES[-1]*dt))//4
    if stride<1:raise ValueError('finite complete native probe clock required')
    # Native H probes are timestamped dt/2 after E probes. At an exact
    # scheduled stop their last stamp can therefore exceed the E stop time.
    offset=.5 if magnetic else 0.
    expected=(np.arange(len(data))*stride+offset)*dt
    tolerance=dt*1e-5
    gap=native['numerical_time_s']-(data[-1,0]-offset*dt)
    count=round(native['numerical_time_s']/dt)//stride+1
    if (len(data)!=count
            or np.any(np.diff(data[:,0])<=0)
            or not np.allclose(data[:,0],expected,rtol=2e-10,atol=tolerance)
            or not -tolerance<=gap<stride*dt+tolerance):
        raise ValueError('finite complete native probe clock required')
    return dict(samples=len(data),first_s=float(data[0,0]),last_s=float(data[-1,0]),stride_steps=stride,offset_steps=offset)


def source_trace_info(path,meta):
    data=np.loadtxt(path,comments='%',ndmin=2);dt=meta['native']['dt_s']
    if data.ndim!=2 or data.shape[1]!=2 or len(data) not in (meta['max_timesteps'],meta['max_timesteps']+1) or not np.isfinite(data).all():
        raise ValueError('finite complete allocated source trace required')
    time=np.arange(len(data))*dt
    if not np.allclose(data[:,0],time,rtol=6e-6,atol=dt*1e-6):raise ValueError('wrong source clock')
    tau=1/(np.sqrt(2)*np.pi*FREQUENCIES[-1]/2.76)
    t0=float(f'{5*tau:.6e}');tau=float(f'{tau:.6e}');scale=float(f'{np.sqrt(2*np.e):.8f}')
    x=(time-t0)/tau;expected=-scale*x*np.exp(-x*x)
    error=float(abs(data[:,1]-expected).max()/max(abs(expected).max(),np.finfo(float).tiny))
    if error>6e-6:raise ValueError('native source differs from independently computed derivative Gaussian')
    return dict(sha256=sha(path),samples=len(data),waveform_error_rel=error)


def quality(meta):
    native,run=meta['native'],meta['run'];dt=meta['declared_dt_s'];h=meta.get('native_header',{})
    return {k:bool(v) for k,v in dict(grid=native['cells']==meta['native_cells'] and run.get('grid')==meta['grid'],
        clock=abs(native['dt_s']/dt-1)<1e-8,operator=native_bound_ok(meta),
        geometry=meta.get('required_usage')==meta.get('operator_preflight',{}).get('required_usage') and native_bound_ok(meta),
        probes=meta.get('actual_current_indices')==meta['expected_current_indices'],
        time=native['timesteps']>0 and abs(native['numerical_time_s']/(native['timesteps']*dt)-1)<1e-8,
        header=h.get('version')=='v0.37.0-rc3' and h.get('threads')==THREADS and h.get('nyquist_interval')==int(1/(2*FREQUENCIES[-1]*dt)),
        source=native['numerical_time_s']>meta['source_duration_s'],
        energy=run.get('converged') and native['timesteps']<meta['max_timesteps'] and run.get('threads')==THREADS).items()}


def acquire(out,n,count,port,kind='loaded',control='ordinary',*,element_scale=1):
    out=Path(out);out.mkdir(parents=True,exist_ok=False)
    sim,meta=build(n,count,port,kind,control,element_scale=element_scale);source,runtime=identity(),runtime_identity()
    sim.fdtd.Write2XML(str(out/'input.xml'))
    meta.update(source_sha256=source,runtime=runtime,input_sha256=sha(out/'input.xml'),limits=LIMITS,
        started_utc=datetime.now(timezone.utc).isoformat())
    save(out/'declared.json',meta)
    meta['operator_preflight']=operator_preflight(out,n,count,port,kind,control,element_scale=element_scale)
    meta['operator_sha256']=sha(out/'operator.json')
    if identity()!=source or runtime_identity()!=runtime:raise RuntimeError('source/runtime changed during setup')
    save(out/'declared.json',meta);print(PROPAGATION_MARKER,flush=True)
    sim.run(str(out/'raw'),threads=THREADS,exact=True,echo=True,dump_statistics=True)
    stats=np.loadtxt(out/'raw/openEMS_stats.txt',comments='%')
    meta.update(native=dict(cells=int(stats[0]),dt_s=float(stats[1]),timesteps=int(stats[2]),
        numerical_time_s=float(stats[3]),iteration_wall_s=float(stats[4])),run=sim.run_stats,required_usage=required_usage(sim))
    v,i=probe_spectra(out/'raw');vn,cn=probe_names()
    np.savez_compressed(out/'waves.npz',frequency_hz=FREQUENCIES,v=v,i=i)
    raw={name:dict(sha256=sha(out/'raw'/name),**trace_clock(np.loadtxt(out/'raw'/name,comments='%',ndmin=2),meta,magnetic=name in cn)) for name in vn+cn}
    actual={}
    for name in cn:
        header='\n'.join((out/'raw'/name).read_text().splitlines()[:3])
        actual[name]=[list(map(int,x)) for x in re.findall(r'-> \[(\d+),(\d+),(\d+)\]',header)]
    if identity()!=source or runtime_identity()!=runtime:raise RuntimeError('source/runtime changed during fields')
    meta.update(waves_sha256=sha(out/'waves.npz'),raw_traces=raw,actual_current_indices=actual,
        source_trace=source_trace_info(out/'raw/et',meta),completed_utc=datetime.now(timezone.utc).isoformat())
    save(out/'report.json',meta)
    return meta


def read(out):
    out=Path(out);meta=json.loads((out/'report.json').read_text())
    if meta['source_sha256']!=identity() or meta['runtime']!=runtime_identity() or meta['limits']!=LIMITS:
        raise ValueError('source/runtime/limits changed; preserve separate acquisition epochs')
    for name,key in (('input.xml','input_sha256'),('operator.json','operator_sha256'),('waves.npz','waves_sha256')):
        if sha(out/name)!=meta[key]:raise ValueError('changed native input/operator/waves')
    operator=json.loads((out/'operator.json').read_text())
    if operator!=meta['operator_preflight'] or sha(out/'operator-input.xml')!=operator['input_sha256']:
        raise ValueError('changed operator admission')
    _,expected=build(meta['n'],meta['count'],meta['excited_port'],meta['kind'],meta['control'],element_scale=meta.get('element_scale',1))
    if any(meta[k]!=v for k,v in expected.items()):raise ValueError('changed physical model or sampling planes')
    vn,cn=probe_names()
    if set(meta['raw_traces'])!=set(vn+cn) or source_trace_info(out/'raw/et',meta)!=meta['source_trace']:
        raise ValueError('changed or missing native source/probes')
    for name,record in meta['raw_traces'].items():
        if dict(sha256=sha(out/'raw'/name),**trace_clock(np.loadtxt(out/'raw'/name,comments='%',ndmin=2),meta,magnetic=name in cn))!=record:
            raise ValueError('changed native probe trace or clock')
    with np.load(out/'waves.npz') as data:
        np.testing.assert_array_equal(data['frequency_hz'],FREQUENCIES);v,i=data['v'].copy(),data['i'].copy()
    rv,ri=probe_spectra(out/'raw');np.testing.assert_array_equal(v,rv);np.testing.assert_array_equal(i,ri)
    return meta,v,i,quality(meta)


def matrix(root):
    root=Path(root);rows=[read(root/f'port{p}') for p in (1,2)];meta=rows[0][0]
    keys=('n','count','kind','control','mesh_mm','declared_dt_s','cap_s','end_db','planes_m','native_capacitors')
    if any(row[0]['excited_port']!=p or any(row[0][k]!=meta[k] for k in keys) for p,row in enumerate(rows,1)):
        raise ValueError('mixed or reordered acquisition columns')
    if not all(all(row[3].values()) for row in rows):raise ValueError('refuse a matrix from rejected native sources')
    actual,diag=extract(np.array([x[1] for x in rows]),np.array([x[2] for x in rows]));target,cell=reference(meta['count'],meta['kind'])
    metrics=dict(s_target_abs=float(abs(actual-target).max()),phase_target_deg=phase_change(actual,target),
        reciprocity_abs=float(abs(actual-actual.transpose(0,2,1)).max()),
        singular_power_max=float((np.linalg.svd(actual,compute_uv=False)[:,0]**2).max()),
        **{k:v for k,v in diag.items() if np.isscalar(v)})
    t=chain(actual)
    if meta['count']==1:
        gamma,z=bloch(t);expected_g,expected_z=bloch(cell)
        metrics.update(beta_target_rel=float(abs(gamma.imag/expected_g.imag-1).max()),
                       z_target_rel=float(abs(z/expected_z-1).max()))
    lower=('incident_floor',)
    passes=all(all(x[3].values()) for x in rows) and all(v>=LIMITS[k] if k in lower else v<=LIMITS[k] for k,v in metrics.items())
    result=dict(n=meta['n'],count=meta['count'],kind=meta['kind'],control=meta['control'],
        all_native_complete=all(all(x[3].values()) for x in rows),native_quality=[x[3] for x in rows],
        **metrics,target_passes=bool(passes),qualified=False)
    matrix_path,comparison_path=root/'matrix.npz',root/'comparison.json'
    values=dict(frequency_hz=FREQUENCIES,s=actual,reference=target,chain=t,**diag)
    if matrix_path.exists() or comparison_path.exists():
        if not matrix_path.exists() or not comparison_path.exists():raise ValueError('retain incomplete prior matrix analysis')
        with np.load(matrix_path) as stored:
            if set(stored)!=set(values):raise ValueError('changed stored matrix contents')
            for key,value in values.items():np.testing.assert_array_equal(stored[key],value)
        if json.loads(comparison_path.read_text())!=result:raise ValueError('changed stored comparison')
    else:
        np.savez_compressed(matrix_path,**values);save(comparison_path,result)
    return actual,result


def configurations():
    return [(f'n{n}_N{count}_{kind}',n,count,kind,'ordinary')
        for n in MESHES for kind,counts in (('loaded',COUNTS),('unloaded',(1,))) for count in counts]+[
        (f'n{CONTROL_MESH}_N1_loaded_{c}',CONTROL_MESH,1,'loaded',c) for c in CONTROLS[1:]]


def study(root):
    """All prescribed meshes, cell counts and controls; missing data stays false."""
    root=Path(root);data={};cohorts=[];missing=[];rejected=[]
    for name,n,count,kind,control in configurations():
        folder=root/name
        if not all((folder/f'port{p}/report.json').is_file() for p in (1,2)):
            missing.append(name);continue
        try:s,result=matrix(folder)
        except (ValueError,AssertionError,FileNotFoundError) as error:
            rejected.append(dict(name=name,reason=repr(error)));continue
        cohorts.append(dict(name=name,**result));data[name]=s
    meshes=[];controls={};counts=[]
    for kind,cell_counts in (('loaded',COUNTS),('unloaded',(1,))):
        for count in cell_counts:
            for a,b in zip(MESHES,MESHES[1:]):
                names=(f'n{a}_N{count}_{kind}',f'n{b}_N{count}_{kind}')
                if not all(name in data for name in names):continue
                first,second=(data[name] for name in names)
                ds,dp=float(abs(second-first).max()),phase_change(second,first)
                row=dict(meshes=[a,b],kind=kind,count=count,s_abs=ds,phase_deg=dp,
                         passes=ds<=LIMITS['s_mesh_abs'] and dp<=LIMITS['phase_mesh_deg'])
                if count==1:
                    ga,za=bloch(chain(first));gb,zb=bloch(chain(second))
                    row.update(beta_rel=float(abs(gb.imag/ga.imag-1).max()),z_rel=float(abs(zb/za-1).max()))
                    row['passes'] &= row['beta_rel']<=LIMITS['beta_mesh_rel'] and row['z_rel']<=LIMITS['z_mesh_rel']
                meshes.append(row)
    base=f'n{CONTROL_MESH}_N1_loaded'
    if base in data:
        nominal=data[base];ga,za=bloch(chain(nominal))
        for control in CONTROLS[1:]:
            name=base+'_'+control
            if name not in data:continue
            other=data[name];gb,zb=bloch(chain(other))
            ds,dp=float(abs(other-nominal).max()),phase_change(other,nominal)
            db,dz=float(abs(gb.imag/ga.imag-1).max()),float(abs(zb/za-1).max())
            controls[control]=dict(s_abs=ds,phase_deg=dp,beta_rel=db,z_rel=dz,
                passes=ds<=LIMITS['s_control_abs'] and dp<=LIMITS['phase_control_deg'] and db<=LIMITS['beta_control_rel'] and dz<=LIMITS['z_control_rel'])
    for n in MESHES:
        if not all(f'n{n}_N{c}_loaded' in data for c in COUNTS):continue
        single=chain(data[f'n{n}_N1_loaded'])
        errors=[float(abs(normalize_chain(chain(data[f'n{n}_N{count}_loaded']))-
            normalize_chain(np.linalg.matrix_power(single,count))).max()) for count in (2,3)]
        counts.append(dict(mesh=n,errors=errors,passes=max(errors)<=LIMITS['cell_count_abs']))
    qualified=(not missing and not rejected and len(meshes)==8 and len(controls)==7 and len(counts)==3
        and all(x['target_passes'] for x in cohorts) and all(x['passes'] for x in meshes)
        and all(x['passes'] for x in controls.values()) and all(x['passes'] for x in counts))
    return dict(protocol=PROTOCOL,scope=SCOPE,limits=LIMITS,cohorts=cohorts,missing=missing,rejected=rejected,
        mesh_changes=meshes,controls=controls,cell_count_checks=counts,qualified=bool(qualified))


def element_configurations():
    return [(f'scale{scale}'+('_element' if control=='element' else ''),CONTROL_MESH,1,'loaded',control,scale)
            for scale in ELEMENT_SCALES for control in ('ordinary','element')]


def element_study(root):
    """A shrinking-support diagnostic, never a replacement for study()."""
    root=Path(root);rows=[];missing=[];rejected=[]
    for scale in ELEMENT_SCALES:
        matrices={};records={}
        for control in ('ordinary','element'):
            folder=root/(f'scale{scale}'+('_element' if control=='element' else ''))
            try:
                for port in (1,2):
                    receipt=json.loads((folder/f'port{port}.worker.json').read_text())
                    limit=receipt['deadline_seconds']
                    times=(receipt['wall_seconds'],receipt['monotonic_seconds'])
                    if (receipt['exit_code']!=0 or receipt.get('failure') is not None
                            or limit not in (1800,2700)
                            or not all(isinstance(v,(int,float)) and not isinstance(v,bool) and np.isfinite(v) and v>=0 for v in times)
                            or max(times)>limit):
                        raise ValueError('owned source deadline/closing receipt failed')
                matrices[control],records[control]=matrix(folder)
                record=records[control]
                measurement=('contour_s_abs','recurrence_residual','incident_condition',
                             'incident_floor','reciprocity_abs','singular_power_max')
                if (not record['all_native_complete'] or not all(np.isfinite(record[k])
                        and (record[k]>=LIMITS[k] if k=='incident_floor' else record[k]<=LIMITS[k]) for k in measurement)):
                    raise ValueError('native or measurement-quality gate failed')
            except FileNotFoundError:
                missing.append(str(folder));continue
            except (ValueError,AssertionError,KeyError) as error:
                rejected.append(dict(path=str(folder),reason=repr(error)));continue
        if len(matrices)!=2:continue
        a,b=matrices['ordinary'],matrices['element']
        ga,za=bloch(chain(a));gb,zb=bloch(chain(b))
        diff=dict(s_abs=float(abs(b-a).max()),phase_deg=phase_change(b,a),
                  beta_rel=float(abs(gb.imag/ga.imag-1).max()),z_rel=float(abs(zb/za-1).max()))
        spread,_=spread_reference(HEIGHT/CONTROL_MESH/scale)
        row=dict(n=CONTROL_MESH,element_scale=scale,column_spacing_mm=HEIGHT/CONTROL_MESH/scale*1e3,point=records['ordinary'],
            element=records['element'],difference=diff,
            spread_s_error=float(abs(b-spread).max()),spread_phase_error_deg=phase_change(b,spread))
        row['spread_reference_passes']=bool(row['spread_s_error']<=LIMITS['s_target_abs']
            and row['spread_phase_error_deg']<=LIMITS['phase_target_deg'])
        row['point_control_passes']=bool(all(diff[k]<=LIMITS[gate] for k,gate in
            (('s_abs','s_control_abs'),('phase_deg','phase_control_deg'),
             ('beta_rel','beta_control_rel'),('z_rel','z_control_rel'))))
        rows.append(row)
    decreasing=bool(len(rows)==3 and all(b['difference'][key]<a['difference'][key]
        for a,b in zip(rows,rows[1:]) for key in ('s_abs','phase_deg','beta_rel','z_rel')))
    passed=bool(not missing and not rejected and decreasing and rows[-1]['point_control_passes']
        and all(v['point']['target_passes'] and v['spread_reference_passes'] for v in rows))
    return dict(scope='Fixed-C three-column longitudinal regularization; separate from the original study',
        meshes=rows,missing=missing,rejected=rejected,control_differences_decrease=decreasing,
        regularization_passes=passed,original_study_reclassified=False,qualified=False,
        limits=LIMITS,reason='Physical support shrinks with spacing; this is not a same-geometry mesh-convergence or full-example certificate.')
