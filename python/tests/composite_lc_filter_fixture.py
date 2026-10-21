"""Own finite LC circuit realization: Example 8.2, p. 398.

The ideal positive-element circuit and the finite PEC geometry are separate
references. No component or layout is fitted to a measured response. Native
runs are opt-in; a physical enclosure is not an ideal circuit certificate.
"""
from datetime import datetime, timezone
from itertools import islice
import json
import math
from pathlib import Path
import re
import sys

import numpy as np
import CSXCAD
from openEMS import ports as native_ports

from fairbeam import Simulation, excitation, multiport
from fairbeam.network import network_s
from fairbeam.simulation import _parse_log
from tests.coax_resonator_fixture import save,sha,runtime_identity as base_runtime

ROOT=Path(__file__).resolve().parents[2]
R0, FC, F_ZERO, MATCH = 75.,2e6,2.05e6,.6
CELL=0.004
FREQUENCIES=np.linspace(.5e6,3e6,501)
MESHES=(1,2,3)
KINDS=('filter','through','open')
CONTROLS=('ordinary','time','dt','enclosure','scale')
THREAD_CHOICES=(1,4)
CAP_S, END_DB, OVERSAMPLING = 65e-6,-100.,16
OPERATOR_STEPS=1024
PROTOCOL='composite-lc-filter-v1'
PROPAGATION_MARKER='FAIRBEAM-COMPOSITE-LC-PROPAGATION-BEGIN'
SCOPE=('Own positive-L/C image-filter circuit in a finite PEC enclosure, '
       'two native 75-ohm terminal ports. Intrinsic finite-geometry parasitics '
       'remain; no component fitting, coils, packages or fabricated-filter claim.')
LIMITS=dict(s_target_abs=.005,phase_target_deg=.5,s_mesh_abs=.0025,phase_mesh_deg=.2,
    s_control_abs=.001,phase_control_deg=.1,probe_s_abs=.001,reciprocity_abs=.001,
    singular_power_max=1.005,incident_condition=30.,incident_floor=.02,
    attenuation_error_db=.2,ripple_error_db=.1,feature_frequency_rel=.005,
    group_delay_rel=.02,terminal_energy_end_db=-90.,blank_s_abs=.02,
    open_coupling_abs=.001,resolution_ratio=10.)


def identity():
    names=('tests/composite_lc_filter_fixture.py','tests/test_composite_lc_filter_fixture.py',
        'tests/coax_resonator_fixture.py','tests/test_coax_resonator.py',
        'fairbeam/simulation.py','fairbeam/excitation.py','fairbeam/multiport.py',
        'fairbeam/network.py','fairbeam/procutil.py')
    return {name:sha(ROOT/'python'/name) for name in names}


def runtime_identity():
    value=base_runtime();value.update(python=sys.version,executable=sys.executable,numpy=np.__version__,
        native_ports_sha256=sha(native_ports.__file__))
    value['csxcad_bindings']={str(p.resolve()):sha(p) for p in sorted(Path(CSXCAD.__file__).parent.glob('*.pyd'))+
        sorted(Path(CSXCAD.__file__).parent.glob('*.so'))+[Path(CSXCAD.__file__)]}
    return value


def elements(kind='filter'):
    """Own composite: matching half sections, constant-k T, finite-pole T."""
    if kind not in KINDS:raise ValueError('declared circuit kind required')
    if kind=='through':return []
    l,c=R0/(np.pi*FC),1/(np.pi*FC*R0)
    m=float(np.sqrt(1-(FC/F_ZERO)**2))
    rows=[dict(name=f'L{j}{j+1}',kind='L',a=j,b=j+1,value_si=float(v))
        for j,v in enumerate((MATCH*l/2,l/2,l/2,m*l/2,m*l/2,MATCH*l/2))]
    for node,other,mm,half in ((0,7,MATCH,True),(4,8,m,False),(6,9,MATCH,True)):
        rows.extend((dict(name=f'L{node}{other}',kind='L',a=node,b=other,
            value_si=float((1-mm*mm)*l/((2 if half else 4)*mm))),
            dict(name=f'C{other}g',kind='C',a=other,b=-1,value_si=float(mm*c/(2 if half else 1)))))
    rows.append(dict(name='C2g',kind='C',a=2,b=-1,value_si=float(c)))
    return [row for row in rows if kind!='open' or row['name']!='L34']


def reference(freq=FREQUENCIES,kind='filter'):
    if np.iscomplexobj(freq):raise ValueError('real frequency vector required')
    f=np.asarray(freq,float)
    if f.ndim!=1 or not len(f) or not np.isfinite(f).all() or np.any((f<.5e6)|(f>3e6)):
        raise ValueError('finite frequencies in the declared 0.5..3 MHz band required')
    if kind=='through':
        s=np.zeros((len(f),2,2),complex);s[:,0,1]=s[:,1,0]=1.;return s
    rows=elements(kind)
    return network_s(f,[0,6],z_ref=R0,admittances=[(row['a'],row['b'],
        1/(2j*np.pi*f*row['value_si']) if row['kind']=='L' else 2j*np.pi*f*row['value_si']) for row in rows])


def independent_abcd(freq=FREQUENCIES):
    """Image-section impedance composition, independent of the nodal graph."""
    w=2*np.pi*np.asarray(freq,float);l=R0/(np.pi*FC);c=1/(np.pi*FC*R0)
    m=np.sqrt(1-(FC/F_ZERO)**2)
    def series(z):
        t=np.broadcast_to(np.eye(2,dtype=complex),(len(w),2,2)).copy();t[:,0,1]=z;return t
    def shunt(y):
        t=np.broadcast_to(np.eye(2,dtype=complex),(len(w),2,2)).copy();t[:,1,0]=y;return t
    # ABCD is evaluated away from the exact attenuation pole. The nodal
    # reference remains finite there and is used for the full complex S gate.
    if np.any(abs(w/(2*np.pi)-F_ZERO)<1e-6):raise ValueError('use nodal reference at the exact attenuation pole')
    def y(mm):return 1/(1j*w*(1-mm*mm)*l/(4*mm)+1/(1j*w*mm*c))
    a=shunt(y(MATCH)/2)@series(1j*w*MATCH*l/2)
    b=series(1j*w*l/2)@shunt(1j*w*c)@series(1j*w*l/2)
    d=series(1j*w*m*l/2)@shunt(y(m))@series(1j*w*m*l/2)
    e=series(1j*w*MATCH*l/2)@shunt(y(MATCH)/2)
    total=a@b@d@e
    aa,bb,cc,dd=(total[:,i,j] for i,j in ((0,0),(0,1),(1,0),(1,1)))
    den=aa+bb/R0+cc*R0+dd;s=np.empty_like(total)
    s[:,0,0],s[:,1,1]=(aa+bb/R0-cc*R0-dd)/den,(-aa+bb/R0-cc*R0+dd)/den
    s[:,1,0],s[:,0,1]=2/den,2*(aa*dd-bb*cc)/den
    return s,total


def _integer(value,choices,label):
    if isinstance(value,bool) or not isinstance(value,int) or value not in choices:
        raise ValueError('declared integer '+label+' required')


class CircuitSimulation(Simulation):
    def to_bundle(self,*args,**kwargs):
        raise ValueError('research circuit probes have no Designer bundle representation')


def build(n,port,kind='filter',control='ordinary',threads=1):
    _integer(n,MESHES,'mesh');_integer(port,(1,2),'source');_integer(threads,THREAD_CHOICES,'thread count')
    if kind not in KINDS or control not in CONTROLS or (control!='ordinary' and (n!=1 or kind!='filter')):
        raise ValueError('declared independent coarse-filter control required')
    cell=CELL*(.5 if control=='scale' else 1.)
    dx=cell/n;guard=2 if control=='enclosure' else 0
    coords=[np.arange(-(16+guard)*n,(16+guard)*n+1)*dx,
        np.arange(-(4+guard)*n,(4+guard)*n+1)*dx,
        np.arange(-(1+guard)*n,(5+guard)*n+1)*dx]
    dt=(.35 if control=='dt' else .5)*dx/(299792458.*np.sqrt(3.))
    cap=(8e-6 if kind=='through' else CAP_S)*(2 if control=='time' else 1.)
    steps=math.ceil(cap/dt);end=END_DB-10 if control=='time' else END_DB
    sim=CircuitSimulation(FREQUENCIES[0],FREQUENCIES[-1],excitation='dgauss',
        boundaries=['PEC']*6,end_criteria_db=end,max_timesteps=steps)
    for axis,values in zip('xyz',coords):sim.mesh.AddLine(axis,values/sim.unit)
    sim.fdtd.SetTimeStep(float(dt));sim.fdtd.SetOverSampling(OVERSAMPLING)
    if control=='time':sim.fdtd.SetEndCriteria(0.)  # An actual extended trace, not another early-stop threshold.
    solids=[];boxes={};probe_boxes={}
    def metal(name,a,b):
        p=sim.metal(name);p.AddBox(np.asarray(a)*cell/sim.unit,np.asarray(b)*cell/sim.unit,priority=10)
        solids.append(name)
    metal('ground',[-(16+guard),-(4+guard),0],[(16+guard),(4+guard),0])
    for node in range(7):
        x=4*(node-3);metal(f'node_{node}',[x-1,-2,2],[x+1,2,3])
    if kind!='through':
        for node,other in ((0,7),(4,8),(6,9)):
            x=4*(node-3);metal(f'node_{other}',[x-1,-2,1],[x+1,-1,1])
    else:
        for node in range(6):
            x=4*(node-3);metal(f'bridge_{node}',[x+1,-2,2],[x+3,2,3])
    for number,node in ((1,0),(2,6)):
        x=4*(node-3)
        sim.lumped_port(number,R0,np.array([x-1,1,0])*cell/sim.unit,
            np.array([x+1,2,2])*cell/sim.unit,'z',excite=number==port)
    records=elements(kind)
    for row in records:
        axis='x' if row['kind']=='L' and row['b']==row['a']+1 and row['a']<6 else 'z'
        if axis=='x':
            x=4*(row['a']-3);a,b=[x+1,-2,2],[x+3,2,3];weight=1
        else:
            node=row['a'] if row['a']<7 else {7:0,8:4,9:6}[row['a']]
            x=4*(node-3)
            a,b=([x-1,-2,1],[x+1,-1,2]) if row['kind']=='L' else (
                ([x-1,-2,0],[x+1,-1,2]) if row['name']=='C2g' else ([x-1,-2,0],[x+1,-1,1]))
            weight=-1
        a,b=np.asarray(a,float)*cell,np.asarray(b,float)*cell
        method=sim.lumped_inductor if row['kind']=='L' else sim.lumped_capacitor
        method(row['name'],row['value_si'],a/sim.unit,b/sim.unit,axis)
        boxes[row['name']]=dict(axis=axis,start_m=a.tolist(),stop_m=b.tolist())
        va,vb=(a+b)/2,(a+b)/2;ny='xyz'.index(axis);va[ny]=a[ny];vb[ny]=b[ny]
        vn='lc_v_'+row['name'];sim.csx.AddProbe(vn,p_type=0,weight=weight).AddBox(va/sim.unit,vb/sim.unit)
        ia,ib=a.copy(),b.copy();ia[ny]=ib[ny]=(a[ny]+b[ny])/2
        cn='lc_i_'+row['name'];sim.csx.AddProbe(cn,p_type=1,norm_dir=ny,weight=weight).AddBox(ia/sim.unit,ib/sim.unit)
        probe_boxes[vn]=dict(kind='voltage',start_m=va.tolist(),stop_m=vb.tolist(),weight=weight)
        probe_boxes[cn]=dict(kind='current',axis=ny,start_m=ia.tolist(),stop_m=ib.tolist(),weight=weight)
    port_names=[]
    for p in sim._port_objs:
        port_names.append(dict(voltage=p.U_filenames,current=p.I_filenames))
    for prop in sim.csx.GetAllProperties():prop.SetColor((128,128,128),alpha=prop.GetFillColor()[3])
    if sim.csx.Update():raise ValueError('invalid native finite-circuit geometry')
    meta=dict(protocol=PROTOCOL,n=n,kind=kind,control=control,excited_port=port,threads=threads,
        cell_m=cell,grid=[len(v) for v in coords],native_cells=int(np.prod([len(v) for v in coords])),
        mesh_mm={a:sim.mesh.GetLines(a).tolist() for a in 'xyz'},declared_dt_s=float(dt),
        max_timesteps=steps,cap_s=cap,requested_end_db=end,native_end_ratio=0. if control=='time' else 10**(end/10),
        forced_time_control=control=='time',operator_steps=OPERATOR_STEPS,source_duration_s=excitation.dgauss_duration_s(FREQUENCIES[-1]),
        reference_ohm=R0,elements=records,element_boxes=boxes,solids=solids,port_names=port_names,
        probe_boxes=probe_boxes,oversampling=OVERSAMPLING,scope=SCOPE)
    return sim,meta


def probe_layout(meta):
    layout=dict(meta['probe_boxes']);cell=meta['cell_m']
    for p,node in zip(meta['port_names'],(0,6)):
        x=4*(node-3)
        for key,kind,a,b in (
            ('voltage','voltage',[x,1,0],[x,1,2]),
            ('current','current',[x-1,1,1],[x+1,2,1])):
            if len(p[key])!=1:raise ValueError('one native terminal probe per kind required')
            layout[p[key][0]]=dict(kind=kind,axis=2,start_m=(np.array(a)*cell).tolist(),stop_m=(np.array(b)*cell).tolist())
    return layout


def expected_indices(meta,box):
    """Declared uniform-grid E nodes / lower H dual indices, before fields."""
    result=[[],[]]
    for axis,label in enumerate('xyz'):
        grid=np.array(meta['mesh_mm'][label])*1e-3;a,b=box['start_m'][axis],box['stop_m'][axis]
        # Remove floating roundoff when choosing the lower of equal-distance nodes.
        nearest=lambda value:int(np.flatnonzero(abs(grid-value)<=abs(grid-value).min()+1e-12)[0])
        if box['kind']=='current':
            if axis==box['axis']:
                low=high=int(np.searchsorted(grid,a-1e-12))-1
            else:low,high=nearest(a)-1,nearest(b)
        else:low,high=nearest(a),nearest(b)
        if not 0<=low<=high<len(grid):raise ValueError('probe escapes declared native grid')
        result[0].append(low);result[1].append(high)
    return result


def trace_clock(data,meta,magnetic=False):
    data=np.asarray(data,float);native=meta['native'];dt=native['dt_s']
    stride=int(1/(2*FREQUENCIES[-1]*dt))//OVERSAMPLING;offset=.5 if magnetic else 0.
    if (data.ndim!=2 or data.shape[1]!=2 or len(data)<3 or not np.isfinite(data).all() or stride<1
        or len(data)!=round(native['numerical_time_s']/dt)//stride+1
        or not np.allclose(data[:,0],(np.arange(len(data))*stride+offset)*dt,rtol=2e-10,atol=dt*1e-5)):
        raise ValueError('finite complete staggered native probe trace required')
    return dict(samples=len(data),stride_steps=stride,offset_steps=offset)


def source_trace_info(path,meta):
    """Check every allocated source row in bounded chunks, including unused tail."""
    count=0;peak=0.;error=0.;dt=meta['native']['dt_s']
    tau=1/(np.sqrt(2)*np.pi*FREQUENCIES[-1]/2.76)
    t0,tau=float(f'{5*tau:.6e}'),float(f'{tau:.6e}');scale=float(f'{np.sqrt(2*np.e):.8f}')
    with Path(path).open() as stream:
        while block:=list(islice(stream,65536)):
            data=np.loadtxt(block,comments='%',ndmin=2)
            if data.shape[1]!=2 or not len(data) or not np.isfinite(data).all():raise ValueError('invalid allocated source rows')
            t=np.arange(count,count+len(data))*dt
            if not np.allclose(data[:,0],t,rtol=6e-6,atol=dt*1e-6):raise ValueError('wrong native source clock')
            x=(t-t0)/tau;expected=-scale*x*np.exp(-x*x)
            peak=max(peak,float(abs(expected).max()));error=max(error,float(abs(data[:,1]-expected).max()));count+=len(data)
    if count not in (meta['max_timesteps'],meta['max_timesteps']+1) or peak==0 or error/peak>6e-6:
        raise ValueError('incomplete or incorrect allocated source waveform')
    return dict(sha256=sha(path),samples=count,waveform_error_rel=error/peak)


def required_usage(sim,meta):
    names=set(meta['solids'])|{e['name'] for e in meta['elements']}|{
        p.port_props[0].GetName() for p in sim._port_objs}|{f"port_excite_{meta['excited_port']}"}
    usage={p.GetName():[bool(x.GetPrimitiveUsed()) for x in p.GetAllPrimitives()]
        for p in sim.csx.GetAllProperties() if p.GetName() in names}
    if set(usage)!=names:raise ValueError('missing declared operator primitive')
    return usage


def operator_preflight(out,n,port,kind,control,threads):
    out=Path(out);sim,meta=build(n,port,kind,control,threads)
    sim.fdtd.SetTimeStep(0.);sim.fdtd.SetNumberOfTimeSteps(OPERATOR_STEPS)
    sim.fdtd.Write2XML(str(out/'operator-input.xml'))
    run=sim.run(str(out/'operator'),threads=threads,exact=True,echo=True,setup_only=True)
    record=dict(setup_only=True,run=run,planned_dt_s=meta['declared_dt_s'],
        input_sha256=sha(out/'operator-input.xml'),required_usage=required_usage(sim,meta))
    save(out/'operator.json',record)
    if not native_bound_ok(meta,record):raise ValueError('native stability/primitive admission failed')
    return record


def native_bound_ok(meta,record):
    run=record.get('run',{});bound=run.get('timestep_s',0.)
    expected=set(meta['solids'])|{e['name'] for e in meta['elements']}|{'port_resist_1','port_resist_2',f"port_excite_{meta['excited_port']}"}
    usage=record.get('required_usage',{})
    return bool(record.get('setup_only') is True and record.get('planned_dt_s')==meta['declared_dt_s']
        and isinstance(bound,(int,float)) and not isinstance(bound,bool) and np.isfinite(bound) and bound>0
        and meta['declared_dt_s']/bound<=.97 and run.get('grid')==meta['grid'] and run.get('threads')==meta['threads']
        and set(usage)==expected and all(x==[True] for x in usage.values()))


def raw_probes(raw,meta):
    raw=Path(raw);traces={};records={}
    for name,box in probe_layout(meta).items():
        path=raw/name;data=np.loadtxt(path,comments='%',ndmin=2)
        clock=trace_clock(data,meta,box['kind']=='current')
        with path.open() as stream:header=''.join(islice(stream,3))
        indices=[list(map(int,x)) for x in re.findall(r'-> \[(\d+),(\d+),(\d+)\]',header)]
        if indices!=expected_indices(meta,box):raise ValueError(f'changed native probe placement: {name}: {indices}')
        traces[name]=data;records[name]=dict(sha256=sha(path),indices=indices,**clock)
    return traces,records


def spectra(raw,meta):
    """Native port postprocessing, cross-checked against direct raw-trace DFT."""
    sim,_=build(meta['n'],meta['excited_port'],meta['kind'],meta['control'],meta['threads'])
    v=[];i=[]
    for p in sim._port_objs:
        p.CalcPort(str(raw),FREQUENCIES,ref_impedance=R0);v.append(p.uf_tot);i.append(p.if_tot)
    return np.array(v),np.array(i)


def direct_spectra(traces,meta):
    def transform(name):
        data=traces[name];t,value=data[:,0],data[:,1]
        return np.array([2*(t[1]-t[0])*np.sum(value*np.exp(-2j*np.pi*f*t)) for f in FREQUENCIES])
    return tuple(np.array([sum(transform(name) for name in p[k]) for p in meta['port_names']]) for k in ('voltage','current'))


def terminal_energy(traces,meta):
    """LC-terminal indicator, not a volume integral of electromagnetic energy."""
    if not meta['elements']:return dict(available=False,end_db=None,tail_window_s=1e-6)
    clock=next(iter(traces.values()))[:,0];energy=np.zeros(len(clock)-1);clock=clock[:-1]
    for e in meta['elements']:
        row=traces[('lc_v_' if e['kind']=='C' else 'lc_i_')+e['name']]
        value=np.interp(clock,row[:,0],row[:,1])
        energy+=.5*e['value_si']*value**2
    tail=energy[clock>=clock[-1]-1e-6];peak=float(energy.max())
    if peak<=0 or clock[-1]<meta['source_duration_s']+1e-6:raise ValueError('unexcited or truncated LC terminal energy trace')
    return dict(available=True,end_db=float(10*np.log10(max(float(tail.max())/peak,np.finfo(float).tiny))),
        tail_window_s=1e-6,peak_j=peak,scope='LC-terminal indicator only; geometric displacement currents remain')


def quality(meta):
    native,run=meta['native'],meta['run'];dt=meta['declared_dt_s'];op=meta['operator_preflight'];h=meta.get('native_header',{})
    forced=meta['forced_time_control'];energy=meta['terminal_energy']
    stopped=(not run.get('converged') and native['timesteps']==meta['max_timesteps']) if forced else (
        run.get('converged') is True and 0<native['timesteps']<meta['max_timesteps'])
    return {k:bool(v) for k,v in dict(grid=native['cells']==meta['native_cells'] and run.get('grid')==meta['grid'],
        clock=abs(native['dt_s']/dt-1)<1e-8 and abs(native['numerical_time_s']/(native['timesteps']*dt)-1)<1e-8,
        operator=native_bound_ok(meta,op),geometry=meta['required_usage']==op['required_usage'],
        header=h.get('version')=='v0.37.0-rc3' and h.get('threads')==meta['threads'] and h.get('nyquist_interval')==int(1/(2*FREQUENCIES[-1]*dt)),
        source=native['numerical_time_s']>meta['source_duration_s'],stopping=stopped,
        terminal_energy=not meta['elements'] or energy['available'] and energy['end_db']<=LIMITS['terminal_energy_end_db']).items()}


def native_statistics(raw):
    stats=np.loadtxt(Path(raw)/'openEMS_stats.txt',comments='%')
    return dict(cells=int(stats[0]),dt_s=float(stats[1]),timesteps=int(stats[2]),
        numerical_time_s=float(stats[3]),iteration_wall_s=float(stats[4]))


def audit_header(text,meta):
    if text.count(PROPAGATION_MARKER)!=1:raise ValueError('one marked native propagation required')
    text=text.split(PROPAGATION_MARKER,1)[1]
    version=re.search(r'openEMS 64bit -- version (\S+)',text)
    grid=re.search(r'FDTD simulation size: (\d+)x(\d+)x(\d+) --> (\S+) FDTD cells',text)
    interval=re.search(r'Exact-endcriteria: evaluating the end criteria every (\d+) timestep',text)
    if (not version or not grid or not interval or version[1]!='v0.37.0-rc3'
        or f"fixed number of threads: {meta['threads']}" not in text
        or list(map(int,grid.groups()[:3]))!=meta['grid'] or float(grid[4])!=float(f"{meta['native_cells']:.6g}")
        or int(interval[1])!=int(1/(2*FREQUENCIES[-1]*meta['native']['dt_s']))):
        raise ValueError('native version/grid/threads/end-criterion schedule mismatch')
    return dict(version=version[1],threads=meta['threads'],nyquist_interval=int(interval[1]))


def acquire(out,n,port,kind='filter',control='ordinary',threads=1):
    out=Path(out);out.mkdir(parents=True,exist_ok=False);sim,meta=build(n,port,kind,control,threads)
    source,runtime=identity(),runtime_identity();sim.fdtd.Write2XML(str(out/'input.xml'))
    meta.update(source_sha256=source,runtime=runtime,input_sha256=sha(out/'input.xml'),limits=LIMITS,
        started_utc=datetime.now(timezone.utc).isoformat())
    save(out/'declared.json',meta)
    meta['operator_preflight']=operator_preflight(out,n,port,kind,control,threads)
    meta['operator_sha256']=sha(out/'operator.json');save(out/'declared.json',meta)
    if identity()!=source or runtime_identity()!=runtime:raise RuntimeError('source/runtime changed during setup')
    print(PROPAGATION_MARKER,flush=True);sim.run(str(out/'raw'),threads=threads,exact=True,echo=True,dump_statistics=True)
    meta.update(native=native_statistics(out/'raw'),native_stats_sha256=sha(out/'raw/openEMS_stats.txt'),
        run=sim.run_stats,required_usage=required_usage(sim,meta))
    traces,meta['raw_traces']=raw_probes(out/'raw',meta);v,i=spectra(out/'raw',meta)
    dv,di=direct_spectra(traces,meta)
    np.testing.assert_allclose(v,dv,rtol=2e-13,atol=1e-25);np.testing.assert_allclose(i,di,rtol=2e-13,atol=1e-27)
    np.savez_compressed(out/'waves.npz',frequency_hz=FREQUENCIES,v=v,i=i)
    meta.update(waves_sha256=sha(out/'waves.npz'),source_trace=source_trace_info(out/'raw/et',meta),
        terminal_energy=terminal_energy(traces,meta),completed_utc=datetime.now(timezone.utc).isoformat())
    if identity()!=source or runtime_identity()!=runtime:raise RuntimeError('source/runtime changed during fields')
    save(out/'report.json',meta);return meta


def read(out):
    out=Path(out);meta=json.loads((out/'report.json').read_text())
    if meta['source_sha256']!=identity() or meta['runtime']!=runtime_identity() or meta['limits']!=LIMITS:
        raise ValueError('source/runtime/limits changed; retain separate data epochs')
    for name,key in (('input.xml','input_sha256'),('operator.json','operator_sha256'),('waves.npz','waves_sha256')):
        if sha(out/name)!=meta[key]:raise ValueError('changed native input/operator/waves')
    if sha(out/'raw/openEMS_stats.txt')!=meta['native_stats_sha256'] or native_statistics(out/'raw')!=meta['native']:
        raise ValueError('changed native statistics')
    log_path=out.parent/(out.name+'.log');text=log_path.read_text()
    if sha(log_path)!=meta['native_log_sha256'] or audit_header(text,meta)!=meta['native_header']:raise ValueError('changed native header/log')
    parsed=_parse_log(text.split(PROPAGATION_MARKER,1)[1],meta['requested_end_db'],meta['max_timesteps'])
    if any(meta['run'].get(k)!=v for k,v in parsed.items() if k!='log_tail'):raise ValueError('native stopping record differs from raw log')
    op=json.loads((out/'operator.json').read_text())
    if op!=meta['operator_preflight'] or sha(out/'operator-input.xml')!=op['input_sha256']:raise ValueError('changed operator admission')
    _,declared=build(meta['n'],meta['excited_port'],meta['kind'],meta['control'],meta['threads'])
    if any(meta[k]!=v for k,v in declared.items()):raise ValueError('changed physical geometry')
    traces,records=raw_probes(out/'raw',meta)
    if records!=meta['raw_traces'] or source_trace_info(out/'raw/et',meta)!=meta['source_trace'] or terminal_energy(traces,meta)!=meta['terminal_energy']:
        raise ValueError('changed raw source/probes/energy indicator')
    with np.load(out/'waves.npz') as data:
        np.testing.assert_array_equal(data['frequency_hz'],FREQUENCIES);v,i=data['v'].copy(),data['i'].copy()
    dv,di=direct_spectra(traces,meta)
    np.testing.assert_allclose(v,dv,rtol=2e-13,atol=1e-25);np.testing.assert_allclose(i,di,rtol=2e-13,atol=1e-27)
    return meta,v,i,quality(meta)


def assemble(v,i):
    v,i=np.asarray(v,complex),np.asarray(i,complex)
    if v.shape!=(2,2,len(FREQUENCIES)) or i.shape!=v.shape or not np.isfinite(v).all() or not np.isfinite(i).all():
        raise ValueError('complete finite two-source terminal waves required')
    a,b=(v+R0*i)/(2*np.sqrt(R0)),(v-R0*i)/(2*np.sqrt(R0))
    sv=np.linalg.svd(a.transpose(2,1,0),compute_uv=False)
    condition=float(np.max(sv[:,0]/np.maximum(sv[:,-1],np.finfo(float).tiny)))
    floor=float(sv[:,-1].min()/max(sv[:,0].max(),np.finfo(float).tiny))
    if condition>LIMITS['incident_condition'] or floor<LIMITS['incident_floor']:raise ValueError('unexcited or singular terminal waves')
    return multiport.assemble_s(a,b,[1,2],2),dict(incident_condition=condition,incident_floor=floor)


def response_difference(a,b,mask):
    if not np.isfinite(a).all() or not np.isfinite(b).all():raise ValueError('finite matrices required')
    return dict(s_abs=float(abs(a-b).max()),phase_deg=float(abs(np.angle(a[mask,1,0]*b[mask,1,0].conj(),deg=True)).max()) if np.any(mask) else None)


def matrix(root):
    root=Path(root);rows=[read(root/f'port{p}') for p in (1,2)];meta=rows[0][0]
    keys=('n','kind','control','mesh_mm','declared_dt_s','cap_s','threads','elements')
    if any(row[0]['excited_port']!=p or any(row[0][k]!=meta[k] for k in keys) for p,row in enumerate(rows,1)):
        raise ValueError('mixed or reordered source columns')
    if not all(all(row[3].values()) for row in rows):raise ValueError('refuse S matrix from rejected native sources')
    s,diag=assemble(np.array([r[1] for r in rows]),np.array([r[2] for r in rows]));target=reference(kind=meta['kind'])
    mask=abs(target[:,1,0])>=.01;difference=response_difference(s,target,mask)
    metrics=dict(s_target_abs=difference['s_abs'],**diag,
        reciprocity_abs=float(abs(s-s.transpose(0,2,1)).max()),singular_power_max=float((np.linalg.svd(s,compute_uv=False)[:,0]**2).max()))
    if difference['phase_deg'] is not None:metrics['phase_target_deg']=difference['phase_deg']
    result=dict(n=meta['n'],kind=meta['kind'],control=meta['control'],native_quality=[r[3] for r in rows],**metrics,
        phase_domain_points=int(mask.sum()),
        target_passes=all(v>=LIMITS[k] if k=='incident_floor' else v<=LIMITS[k] for k,v in metrics.items()),qualified=False)
    values=dict(frequency_hz=FREQUENCIES,s=s,reference=target)
    mp,cp=root/'matrix.npz',root/'comparison.json'
    if mp.exists() or cp.exists():
        if not mp.exists() or not cp.exists():raise ValueError('incomplete previous matrix analysis')
        with np.load(mp) as prior:
            if set(prior)!=set(values):raise ValueError('changed stored matrix keys')
            for k,v in values.items():np.testing.assert_array_equal(prior[k],v)
        if json.loads(cp.read_text())!=result:raise ValueError('changed stored comparison')
    else:np.savez_compressed(mp,**values);save(cp,result)
    return s,result
