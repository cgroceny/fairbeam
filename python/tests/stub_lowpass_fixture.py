"""Own physical microstrip stub filter associated with Example 8.5, p. 419.

The ideal Richards/Kuroda circuit, quasi-static dimensions and finite native
layout are separate references. No dimensions are fitted to measured fields.
Research probes have no Designer/bundle representation; no gallery is changed.
"""
import json
import math
from pathlib import Path
import re
import sys

import numpy as np
from openEMS import ports as native_ports
from openEMS.ports import UI_data
from openEMS.physical_constants import C0

from fairbeam import Simulation, excitation, multiport
from fairbeam import simulation
from fairbeam.analytic import microstrip_eps_eff, microstrip_width
from fairbeam.network import network_s
from tests.coax_resonator_fixture import save, sha, runtime_identity as base_runtime
from tests.microstrip_fixture import graded

ROOT=Path(__file__).resolve().parents[2]
FC,Z0,RIPPLE,HEIGHT,ER=4e9,50.,3.,1.,2.2
FREQUENCIES=np.linspace(1e9,6e9,501)
MESHES=(2,3,4)
CONTROLS=('ordinary','time','dt','boundary','plane')
KINDS=('through','filter')
CAP_S,END_DB,OVERSAMPLING,THREADS=6e-9,-90.,4,4
OPERATOR_STEPS=1024
PROTOCOL='microstrip-stub-lowpass-v1'
PROPAGATION_MARKER='FAIRBEAM-STUB-LOWPASS-PROPAGATION-BEGIN'
LIMITS=dict(s_target_abs=.02,phase_target_deg=2.,s_mesh_abs=.005,phase_mesh_deg=.5,
    s_control_abs=.0025,phase_control_deg=.2,contour_s_abs=.0025,recurrence_rel=.005,
    incident_condition=30.,incident_floor=.02,reciprocity_abs=.005,singular_power_max=1.01,
    attenuation_db=.2,ripple_db=.1,edge_rel=.005,group_delay_rel=.02,
    terminal_tail_db=-70.,resolution_ratio=10.)
SCOPE=('Own zero-thickness PEC microstrip on lossless eps_r=2.2, h=1 mm; '
       'open stubs with uncompensated quasi-static electrical lengths, finite tees, '
       'graded Cartesian mesh, PML sides/top and PEC ground. No package, copper, '
       'fabricated-filter or ideal-junction equivalence claim.')


def identity():
    names=('tests/stub_lowpass_fixture.py','tests/test_stub_lowpass_fixture.py',
        'tests/coax_resonator_fixture.py','tests/test_coax_resonator.py',
        'tests/microstrip_fixture.py','fairbeam/simulation.py','fairbeam/analytic.py',
        'fairbeam/excitation.py','fairbeam/multiport.py','fairbeam/network.py','fairbeam/procutil.py')
    return {name:sha(ROOT/'python'/name) for name in names}


def runtime_identity():
    result=base_runtime()
    result.update(python=sys.version,executable=sys.executable,numpy=np.__version__,
                  native_ports_sha256=sha(native_ports.__file__))
    return result


def synthesis():
    eps=np.sqrt(10**(RIPPLE/10)-1)
    eta=np.sinh(np.arcsinh(1/eps)/3)
    a=np.sin((2*np.arange(1,4)-1)*np.pi/6)
    b=eta**2+np.sin(np.arange(1,4)*np.pi/3)**2
    g=[2*a[0]/eta]
    for k in (1,2):g.append(4*a[k-1]*a[k]/(b[k-1]*g[-1]))
    unit=Z0*(1+g[0]);outer=unit/g[0];middle=Z0/g[1]
    return dict(g=g,unit_ohm=float(unit),stub_ohm=[float(outer),float(middle),float(outer)],
                delay_s=1/(8*FC))


def dimensions():
    values=synthesis()
    def section(z):
        width=microstrip_width(z,ER,HEIGHT);ee=microstrip_eps_eff(ER,HEIGHT,width)
        return dict(impedance_ohm=float(z),width_mm=width,eps_eff=ee,
                    length_mm=float(C0*values['delay_s']/np.sqrt(ee)*1e3))
    return dict(unit=section(values['unit_ohm']),stubs=[section(z) for z in values['stub_ohm']],feed=section(Z0))


def reference(freq=FREQUENCIES,kind='filter',plane_mm=4.):
    f=np.asarray(freq,float)
    if (kind not in KINDS or f.ndim!=1 or not len(f) or not np.isfinite(f).all()
            or np.any(f<=0) or not np.isfinite(plane_mm) or plane_mm<=0):
        raise ValueError('declared kind, finite positive frequency vector and feed length required')
    values=synthesis();dims=dimensions();delay=values['delay_s'];length=dims['unit']['length_mm']
    feed_delay=plane_mm*1e-3*np.sqrt(dims['feed']['eps_eff'])/C0
    if kind=='through':
        total=(2*length+2*plane_mm)*1e-3*np.sqrt(dims['feed']['eps_eff'])/C0
        return network_s(f,[0,1],[(0,1,Z0,total)],z_ref=Z0)
    lines=[(0,1,values['unit_ohm'],delay),(1,2,values['unit_ohm'],delay),
           (0,3,values['stub_ohm'][0],delay),(1,4,values['stub_ohm'][1],delay),
           (2,5,values['stub_ohm'][2],delay),(6,0,Z0,feed_delay),(2,7,Z0,feed_delay)]
    return network_s(f,[6,7],lines,z_ref=Z0)


def independent_abcd(freq=FREQUENCIES,plane_mm=4.):
    f=np.asarray(freq,float);v=synthesis();theta=2*np.pi*f*v['delay_s'];n=len(f)
    def line(z,angle):
        t=np.zeros((n,2,2),complex);t[:,0,0]=t[:,1,1]=np.cos(angle)
        t[:,0,1]=1j*z*np.sin(angle);t[:,1,0]=1j*np.sin(angle)/z;return t
    def shunt(z):
        t=np.broadcast_to(np.eye(2,dtype=complex),(n,2,2)).copy();t[:,1,0]=1j*np.tan(theta)/z;return t
    feed=2*np.pi*f*plane_mm*1e-3*np.sqrt(dimensions()['feed']['eps_eff'])/C0
    t=line(Z0,feed)@shunt(v['stub_ohm'][0])@line(v['unit_ohm'],theta)@shunt(v['stub_ohm'][1])@line(v['unit_ohm'],theta)@shunt(v['stub_ohm'][2])@line(Z0,feed)
    a,b,c,d=(t[:,i,j] for i,j in ((0,0),(0,1),(1,0),(1,1)))
    den=a+b/Z0+c*Z0+d;s=np.empty_like(t)
    s[:,0,0]=(a+b/Z0-c*Z0-d)/den;s[:,1,1]=(-a+b/Z0-c*Z0+d)/den
    s[:,1,0]=2/den;s[:,0,1]=2*(a*d-b*c)/den;return s


def _axis(anchors,first,maximum):
    anchors=np.unique(np.asarray(anchors,float));pieces=[]
    for lo,hi in zip(anchors[:-1],anchors[1:]):
        if hi-lo<=2*first:part=[lo,hi]
        else:
            half=graded((hi-lo)/2,first,maximum)
            part=np.r_[lo+half,hi-half[-2::-1]]
        pieces.extend(part)
    return np.unique(pieces)


def _balanced_axis(anchors,maximum,ratio=2.):
    """Retain every physical anchor and split only oversized neighbouring cells."""
    anchors=np.unique(np.asarray(anchors,float))
    if len(anchors)<2 or not np.isfinite(anchors).all() or not np.isfinite(maximum) or maximum<=0 or not 1<ratio<=2:
        raise ValueError('finite distinct anchors, positive spacing and bounded growth required')
    pieces=[]
    for lo,hi in zip(anchors[:-1],anchors[1:]):
        pieces.extend(np.linspace(lo,hi,int(np.ceil((hi-lo)/maximum))+1))
    values=np.unique(pieces)
    for _ in range(10000):
        h=np.diff(values);growth=np.maximum(h[1:]/h[:-1],h[:-1]/h[1:])
        if not len(growth) or growth.max()<=ratio*(1+1e-12):return values
        j=int(growth.argmax());large=j if h[j]>h[j+1] else j+1
        count=int(np.ceil(h[large]/(ratio*min(h[j],h[j+1]))))
        values=np.sort(np.r_[values,np.linspace(values[large],values[large+1],count+1)[1:-1]])
    raise ValueError('mesh growth could not be bounded')


def mesh_lines(n,control='ordinary'):
    if isinstance(n,bool) or n not in MESHES or not isinstance(n,int) or control not in CONTROLS:
        raise ValueError('declared integer mesh/control required')
    d=dimensions();delta=HEIGHT/n;maximum=2*delta;length=d['unit']['length_mm']
    air=(9 if control=='boundary' else 6)*HEIGHT
    xanchors=[-12*HEIGHT-8*maximum,-12*HEIGHT,-10*HEIGHT,0.,length,2*length,2*length+10*HEIGHT,
              2*length+12*HEIGHT,2*length+12*HEIGHT+8*maximum]
    for centre in (-6*HEIGHT,-4*HEIGHT,2*length+4*HEIGHT,2*length+6*HEIGHT):
        xanchors.extend((centre-delta,centre,centre+delta))
    for centre,stub in zip((0.,length,2*length),d['stubs']):
        edge=stub['width_mm']/2
        xanchors.extend((centre-edge-2*delta/3,centre-edge+delta/3,
                         centre+edge-delta/3,centre+edge+2*delta/3))
    # Keep eight equidistant normal cells for each PML. The physical box,
    # source/measurement planes and conductor anchors retain their positions.
    xbody=_axis([a for a in xanchors if -12*HEIGHT<=a<=2*length+12*HEIGHT],delta,maximum)
    x=np.r_[xbody[0]-maximum*np.arange(8,0,-1),xbody,xbody[-1]+maximum*np.arange(1,9)]
    yanchors=[-air-8*maximum,-air,0.,air,air+8*maximum]
    for width in [d['feed']['width_mm'],d['unit']['width_mm']]:
        edge=width/2;small=min(delta,width/n)
        for sign in (-1,1):yanchors.extend((sign*(edge-small/3),sign*(edge+2*small/3)))
    yanchors.extend(s['length_mm'] for s in d['stubs'])
    ymax=max(yanchors)+air+8*maximum
    inner_top=ymax-8*maximum
    ya=[a for a in yanchors if -air<=a<=inner_top]+[-air,inner_top]
    ybody=_balanced_axis(ya,maximum)
    y=np.r_[ybody[0]-maximum*np.arange(8,0,-1),ybody,ybody[-1]+maximum*np.arange(1,9)]
    z=np.r_[np.linspace(0.,HEIGHT,n+1),HEIGHT+graded(air,delta,maximum)[1:],
            HEIGHT+air+maximum*np.arange(1,9)]
    return x,y,z


class StubSimulation(Simulation):
    def to_bundle(self,*args,**kwargs):
        raise ValueError('research MSL/contour probes have no Designer bundle representation')


def build(n,port,kind='filter',control='ordinary',cap_s=None):
    if kind not in KINDS or isinstance(port,bool) or port not in (1,2):raise ValueError('declared source and kind required')
    x,y,z=mesh_lines(n,control);dims=dimensions();length=dims['unit']['length_mm']
    grid=[len(a) for a in (x,y,z)];cells=int(np.prod(grid))
    if cells>4000000:raise ValueError('research grid exceeds four million cells')
    dt=(.35 if control=='dt' else .5)/(C0*np.sqrt(sum(1/(np.diff(a).min()*1e-3)**2 for a in (x,y,z))))
    cap=CAP_S*(2 if control=='time' else 1) if cap_s is None else float(cap_s)
    if not np.isfinite(cap) or cap<=0:raise ValueError('positive finite cap required')
    steps=math.ceil(cap/dt);end=END_DB-(10 if control=='time' else 0)
    sim=StubSimulation(FREQUENCIES[0],FREQUENCIES[-1],boundaries=['PML_8']*4+['PEC','PML_8'],
        max_timesteps=steps,end_criteria_db=end,excitation='dgauss')
    for axis,values in zip('xyz',(x,y,z)):sim.mesh.AddLine(axis,values)
    sim.fdtd.SetTimeStep(float(dt));sim.fdtd.SetOverSampling(OVERSAMPLING)
    sim.dielectric('substrate',ER).AddBox([x[0],y[0],0.],[x[-1],y[-1],HEIGHT],priority=1)
    feed=sim.metal('feed');wf=dims['feed']['width_mm']
    plane=(6 if control=='plane' else 4)*HEIGHT;ports=[]
    for number,start,stop,centre in ((1,x[0],0.,-plane),(2,x[-1],2*length,2*length+plane)):
        direction=1 if number==1 else -1
        p=sim.fdtd.AddMSLPort(number,feed,[start,-wf/2,HEIGHT],[stop,wf/2,0.],'x','z',
            excite=-1 if number==port else 0,FeedShift=abs(start-(stop-direction*10*HEIGHT)),
            MeasPlaneShift=abs(start-centre),priority=10)
        if abs((start+direction*p.measplane_shift)-centre)>1e-10:raise ValueError('native MSL measurement plane missed mesh')
        ports.append(p)
    solids=['substrate','feed']
    if kind=='through':
        sim.metal('body').AddBox([0.,-wf/2,HEIGHT],[2*length,wf/2,HEIGHT],priority=10);solids.append('body')
    else:
        width=dims['unit']['width_mm']
        for j in range(2):
            name=f'unit{j}';sim.metal(name).AddBox([j*length,-width/2,HEIGHT],[(j+1)*length,width/2,HEIGHT],priority=10);solids.append(name)
        for j,stub in enumerate(dims['stubs']):
            name=f'stub{j}';centre=j*length;w=stub['width_mm']
            sim.metal(name).AddBox([centre-w/2,0.,HEIGHT],[centre+w/2,stub['length_mm'],HEIGHT],priority=10);solids.append(name)
    iy=np.flatnonzero(abs(y)<wf/2);iz=int(np.flatnonzero(z==HEIGHT)[0]);indices={}
    for endpoint,centre,direction in ((0,-plane,1),(1,2*length+plane,-1)):
        ix=int(np.argmin(abs(x-centre)))
        np.testing.assert_allclose(x[ix-1:ix+2],[centre-HEIGHT/n,centre,centre+HEIGHT/n],rtol=0,atol=1e-12)
        for j,sx in enumerate(x[ix-1:ix+2]):
            sim.csx.AddProbe(f'v{endpoint}_{j}',p_type=0).AddBox([sx,0.,HEIGHT],[sx,0.,0.])
        for contour,margin in (('inner',0),('outer',1)):
            lo,hi=int(iy[0]-margin),int(iy[-1]+margin)
            if lo<1 or hi+1>=len(y):raise ValueError('current contour outside grid')
            ly,hy=(y[lo-1]+y[lo])/2,(y[hi]+y[hi+1])/2
            lz,hz=(z[iz-1]+HEIGHT)/2,(HEIGHT+z[iz+1])/2
            for j,sx in enumerate(((x[ix-1]+centre)/2,(centre+x[ix+1])/2)):
                name=f'i{endpoint}_{contour}_{j}'
                sim.csx.AddProbe(name,p_type=1,norm_dir=0,weight=direction).AddBox([sx,ly,lz],[sx,hy,hz])
                indices[name]=[[ix+j-1,lo-1,iz-1],[ix+j-1,hi,iz]]
    for prop in sim.csx.GetAllProperties():prop.SetColor((128,128,128),alpha=prop.GetFillColor()[3])
    if sim.csx.Update():raise ValueError('invalid native geometry')
    meta=dict(protocol=PROTOCOL,n=n,excited_port=port,kind=kind,control=control,grid=grid,native_cells=cells,
        mesh_mm={a:v.tolist() for a,v in zip('xyz',(x,y,z))},dimensions=dims,plane_mm=plane,
        declared_dt_s=float(dt),max_timesteps=steps,cap_s=cap,end_db=end,threads=THREADS,solids=solids,
        source_duration_s=excitation.dgauss_duration_s(FREQUENCIES[-1]),expected_current_indices=indices,scope=SCOPE)
    return sim,ports,meta


def required_usage(sim,names):
    return {p.GetName():[bool(q.GetPrimitiveUsed()) for q in p.GetAllPrimitives()]
            for p in sim.csx.GetAllProperties() if p.GetName() in names}


def operator_preflight(out,n,port,kind,control,cap_s=None):
    sim,_,meta=build(n,port,kind,control,cap_s);sim.fdtd.SetTimeStep(0.)
    sim.fdtd.SetNumberOfTimeSteps(OPERATOR_STEPS);sim.fdtd.Write2XML(str(out/'operator-input.xml'))
    plan=json.loads((out.parent/'plan.json').read_text())
    row=next(r for r in plan['ports'] if r['excited_port']==port)
    if sha(out/'operator-input.xml')!=row['operator_input_sha256']:raise ValueError('operator input differs from pre-field plan')
    run=sim.run(str(out/'operator'),threads=THREADS,exact=True,echo=True,setup_only=True)
    result=dict(setup_only=True,input_sha256=sha(out/'operator-input.xml'),run=run,
                required_usage=required_usage(sim,meta['solids']))
    save(out/'operator.json',result)
    bound=run.get('timestep_s',0.)
    if (not isinstance(bound,(int,float)) or not 0<meta['declared_dt_s']<=.8*bound
            or run.get('grid')!=meta['grid'] or set(result['required_usage'])!=set(meta['solids'])
            or not all(all(v) and len(v)>0 for v in result['required_usage'].values())):
        raise ValueError('native operator stability or material usage admission failed')
    return result


def trace_clock(data,meta,magnetic=False):
    data=np.asarray(data,float);native=meta['native'];dt=native['dt_s']
    stride=int(1/(2*FREQUENCIES[-1]*dt))//OVERSAMPLING;offset=.5 if magnetic else 0.
    count=round(native['numerical_time_s']/dt)//stride+1
    expected=(np.arange(count)*stride+offset)*dt
    if (stride<1 or data.shape!=(count,2) or count<3 or not np.isfinite(data).all()
            or not np.allclose(data[:,0],expected,rtol=2e-10,atol=dt*1e-5)):
        raise ValueError('finite complete native observation clock required')
    return dict(samples=count,stride_steps=stride,offset_steps=offset)


def source_info(path,meta):
    data=np.loadtxt(path,comments='%',ndmin=2);dt=meta['native']['dt_s']
    if data.shape not in ((meta['max_timesteps'],2),(meta['max_timesteps']+1,2)) or not np.isfinite(data).all():
        raise ValueError('complete allocated source trace required')
    clock=np.arange(len(data))*dt
    if not np.allclose(data[:,0],clock,rtol=6e-6,atol=dt*1e-6):raise ValueError('source clock changed')
    tau=1/(np.sqrt(2)*np.pi*FREQUENCIES[-1]/2.76);t0=float(f'{5*tau:.6e}');tau=float(f'{tau:.6e}')
    q=(clock-t0)/tau;expected=-float(f'{np.sqrt(2*np.e):.8f}')*q*np.exp(-q*q)
    error=float(np.max(abs(data[:,1]-expected))/max(np.max(abs(expected)),np.finfo(float).tiny))
    if error>6e-6:raise ValueError('native source waveform changed')
    return dict(samples=len(data),waveform_error_rel=error,sha256=sha(path))


def probe_names():
    return ([f'v{p}_{j}' for p in range(2) for j in range(3)],
            [f'i{p}_{c}_{j}' for p in range(2) for c in ('inner','outer') for j in range(2)])


def audit_header(text,meta):
    marker=text.count(PROPAGATION_MARKER)
    version=re.findall(r'openEMS 64bit -- version (\S+)',text.split(PROPAGATION_MARKER)[-1])
    grid=re.search(r'FDTD simulation size: (\d+)x(\d+)x(\d+) --> (\d+) FDTD cells',text.split(PROPAGATION_MARKER)[-1])
    threads=f'fixed number of threads: {THREADS}' in text.split(PROPAGATION_MARKER)[-1]
    if marker!=1 or version!=['v0.37.0-rc3'] or not grid or not threads:
        raise ValueError('native propagation version/thread/header required')
    if list(map(int,grid.groups()[:3]))!=meta['grid'] or int(grid[4])!=meta['native_cells']:
        raise ValueError('native grid changed')
    return dict(version=version[0],threads=THREADS)


def quality(meta):
    native,run,op=meta['native'],meta['run'],meta['operator_preflight']
    energy=[run.get(k) for k in ('final_energy_db','final_energy_bound_db')]
    energy=[v for v in energy if isinstance(v,(int,float)) and not isinstance(v,bool) and np.isfinite(v)]
    return {k:bool(v) for k,v in dict(grid=native['cells']==meta['native_cells'] and run.get('grid')==meta['grid'],
        clock=abs(native['dt_s']/meta['declared_dt_s']-1)<1e-8,
        time=native['timesteps']>0 and abs(native['numerical_time_s']/(native['timesteps']*native['dt_s'])-1)<1e-8,
        source=native['numerical_time_s']>=meta['source_duration_s'],
        stopping=run.get('converged') is True and run.get('hit_timestep_limit') is False and bool(energy) and max(energy)<=meta['end_db']+1e-7,
        operator=op.get('setup_only') is True and 0<meta['declared_dt_s']<=.8*op['run'].get('timestep_s',0),
        geometry=meta.get('required_usage')==op.get('required_usage') and set(meta.get('required_usage',{}))==set(meta['solids']) and all(all(v) and len(v)>0 for v in meta.get('required_usage',{}).values()),
        probes=meta.get('actual_current_indices')==meta['expected_current_indices'],
        header=meta.get('native_header',{})==dict(version='v0.37.0-rc3',threads=THREADS),
        engine=run.get('threads')==THREADS and run.get('engine')=='cpu' and run.get('exact_endcriteria') is True,
        tail=meta.get('terminal_tail_db',0.)<=LIMITS['terminal_tail_db']).items()}


def acquire(out,n,port,kind='filter',control='ordinary',cap_s=None):
    out=Path(out);out.mkdir(parents=True,exist_ok=False)
    source,runtime=identity(),runtime_identity()
    sim,ports,meta=build(n,port,kind,control,cap_s);sim.fdtd.Write2XML(str(out/'input.xml'))
    plan=json.loads((out.parent/'plan.json').read_text())
    planned=next(r for r in plan['ports'] if r['excited_port']==port)
    if (plan['source']!=source or plan['runtime']!=runtime or any(planned.get(k)!=v for k,v in meta.items())
            or planned['input_sha256']!=sha(out/'input.xml')):
        raise ValueError('scientific input/source/runtime differs from pre-field plan')
    meta.update(source=source,runtime=runtime,input_sha256=sha(out/'input.xml'))
    save(out/'declared.json',meta)
    op=operator_preflight(out,n,port,kind,control,cap_s)
    if identity()!=source or runtime_identity()!=runtime:raise ValueError('source/runtime changed before fields')
    print(PROPAGATION_MARKER,flush=True)
    sim.run(str(out/'raw'),threads=THREADS,exact=True,echo=True,engine='cpu',dump_statistics=True)
    stats=np.loadtxt(out/'raw/openEMS_stats.txt',comments='%')
    native=dict(cells=int(stats[0]),dt_s=float(stats[1]),timesteps=int(stats[2]),
                numerical_time_s=float(stats[3]),iteration_wall_s=float(stats[4]))
    meta.update(run=sim.run_stats,native=native,operator_preflight=op,required_usage=required_usage(sim,meta['solids']))
    vn,cn=probe_names();v=np.asarray(UI_data(vn,str(out/'raw'),FREQUENCIES).ui_f_val).reshape(2,3,-1)
    current=np.asarray(UI_data(cn,str(out/'raw'),FREQUENCIES).ui_f_val).reshape(2,2,2,-1)
    nv=[];ni=[];tails=[];indices={};clocks={}
    for name in vn+cn:
        data=np.loadtxt(out/'raw'/name,comments='%',ndmin=2);clocks[name]=trace_clock(data,meta,name.startswith('i'))
        mask=data[:,0]>=native['numerical_time_s']-.5e-9
        tails.append(float(10*np.log10(max(np.mean(data[mask,1]**2),np.finfo(float).tiny)/max(np.max(data[:,1]**2),np.finfo(float).tiny))))
        if name in cn:
            header='\n'.join((out/'raw'/name).read_text().splitlines()[:3])
            indices[name]=[list(map(int,row)) for row in re.findall(r'-> \[(\d+),(\d+),(\d+)\]',header)]
            if len(indices[name])!=2:raise ValueError('current contour index missing')
    for port_obj in ports:
        port_obj.CalcPort(str(out/'raw'),FREQUENCIES,ref_impedance=Z0)
        nv.append(port_obj.uf_tot);ni.append(port_obj.if_tot)
    if identity()!=source or runtime_identity()!=runtime:raise ValueError('source/runtime changed during fields')
    meta.update(actual_current_indices=indices,terminal_tail_db=max(tails),observation_clocks=clocks,
                source_trace=source_info(out/'raw/et',meta))
    np.savez_compressed(out/'data.npz',frequency_hz=FREQUENCIES,v=v,i=current,native_v=nv,native_i=ni)
    meta.update(data_sha256=sha(out/'data.npz'),operator_sha256=sha(out/'operator.json'),
                raw_sha256={name:sha(out/'raw'/name) for name in vn+cn})
    save(out/'report.json',meta)
    return meta


def read(out):
    out=Path(out);meta=json.loads((out/'report.json').read_text())
    _,_,expected=build(meta['n'],meta['excited_port'],meta['kind'],meta['control'],meta['cap_s'])
    if any(meta.get(k)!=v for k,v in expected.items()) or meta['source']!=identity() or meta['runtime']!=runtime_identity():
        raise ValueError('source/runtime/model identity differs')
    if sha(out/'input.xml')!=meta['input_sha256'] or sha(out/'operator-input.xml')!=meta['operator_preflight']['input_sha256']:
        raise ValueError('stored native input changed')
    if sha(out/'data.npz')!=meta['data_sha256'] or sha(out/'operator.json')!=meta['operator_sha256']:
        raise ValueError('stored numerical/operator record changed')
    checks=quality(meta)
    if not all(checks.values()):raise ValueError(f'rejected source: {checks}')
    vn,cn=probe_names();actual=[]
    for name in vn+cn:
        if sha(out/'raw'/name)!=meta['raw_sha256'][name]:raise ValueError('raw native trace changed')
        data=np.loadtxt(out/'raw'/name,comments='%',ndmin=2);trace_clock(data,meta,name.startswith('i'))
        time=data[:,0];df=time[1]-time[0]
        actual.append(2*df*(np.exp(-2j*np.pi*np.outer(FREQUENCIES,time))@data[:,1]))
    with np.load(out/'data.npz') as stored:data=dict(stored)
    if not np.array_equal(data['frequency_hz'],FREQUENCIES):raise ValueError('changed frequency grid')
    vv=np.asarray(actual[:len(vn)]).reshape(2,3,-1);ii=np.asarray(actual[len(vn):]).reshape(2,2,2,-1)
    np.testing.assert_allclose(vv,data['v'],rtol=3e-13,atol=1e-23);np.testing.assert_allclose(ii,data['i'],rtol=3e-13,atol=1e-23)
    if source_info(out/'raw/et',meta)!=meta['source_trace']:raise ValueError('source trace changed')
    return meta,data


def assemble(v,i):
    v,i=np.asarray(v,complex),np.asarray(i,complex)
    if v.shape!=(2,2,len(FREQUENCIES)) or i.shape!=v.shape or not np.isfinite(v).all() or not np.isfinite(i).all():
        raise ValueError('two complete finite excitation columns required')
    a,b=(v+Z0*i)/(2*np.sqrt(Z0)),(v-Z0*i)/(2*np.sqrt(Z0))
    singular=np.linalg.svd(a.transpose(2,1,0),compute_uv=False)
    condition=float(np.max(singular[:,0]/np.maximum(singular[:,-1],np.finfo(float).tiny)))
    floor=float(singular[:,-1].min()/max(singular[:,0].max(),np.finfo(float).tiny))
    if condition>LIMITS['incident_condition'] or floor<LIMITS['incident_floor']:raise ValueError('ill-conditioned incoming waves')
    return multiport.assemble_s(a,b,[1,2],2),dict(incident_condition=condition,incident_floor=floor)


def extract(v,i):
    v,i=np.asarray(v),np.asarray(i);nf=len(FREQUENCIES)
    if v.shape!=(2,2,3,nf) or i.shape!=(2,2,2,2,nf):raise ValueError('three voltages and two dual currents/contours required')
    u=v[:,:,1];denom=2*np.sum(abs(u)**2,axis=0)
    if np.any(denom<.01*np.max(np.sum(abs(v)**2,axis=0),axis=1)) or np.any(denom==0):raise ValueError('voltage node in feed recurrence')
    recurrence=np.sum(np.conj(u)*(v[:,:,0]+v[:,:,2]),axis=0)/denom
    half=np.sqrt((recurrence+1)/2)
    if not np.isfinite(half).all() or np.any((abs(half)<.5)|(abs(half)>1.5)):raise ValueError('invalid spatial stagger correction')
    residual=float(abs(v[:,:,0]+v[:,:,2]-2*recurrence[None]*u).max()/abs(v).max())
    rows=[];qa=[]
    for loop in (0,1):
        s,q=assemble(u,i[:,:,loop].mean(axis=2)/half);rows.append(s);qa.append(q)
    return rows[0],dict(contour_s_abs=float(abs(rows[0]-rows[1]).max()),recurrence_rel=residual,
        incident_condition=max(q['incident_condition'] for q in qa),incident_floor=min(q['incident_floor'] for q in qa),
        alternate_contour_s=rows[1],current_half_factor=half)


def difference(a,b):
    mask=abs(b[:,1,0])>=.01
    return dict(s_abs=float(abs(a-b).max()),phase_deg=float(np.max(abs(np.angle(a[mask,1,0]/b[mask,1,0],deg=True)))))


def application_errors(actual,target):
    """Prospective point/derivative metrics; no dynamic-range certificate."""
    a,b=np.asarray(actual),np.asarray(target)
    shape=(len(FREQUENCIES),2,2)
    if a.shape!=shape or b.shape!=shape or not np.isfinite(a).all() or not np.isfinite(b).all():
        raise ValueError('complete finite sampled matrices required')
    magnitude_a,magnitude_b=abs(a[:,1,0]),abs(b[:,1,0]);domain=magnitude_b>=.01
    if not domain.any() or np.any(magnitude_a[domain]<=0):raise ValueError('finite nonzero transmission domain required')
    loss_a=-20*np.log10(np.maximum(magnitude_a,np.finfo(float).tiny));loss_b=-20*np.log10(np.maximum(magnitude_b,np.finfo(float).tiny))
    band=FREQUENCIES<=FC
    ripple=float(abs(np.ptp(loss_a[band])-np.ptp(loss_b[band])))
    def edge(loss):
        candidates=[]
        for j in range(len(loss)-1):
            if .9*FC<=FREQUENCIES[j] and FREQUENCIES[j+1]<=1.1*FC and loss[j]<=RIPPLE<loss[j+1]:
                fraction=(RIPPLE-loss[j])/(loss[j+1]-loss[j])
                candidates.append(float(FREQUENCIES[j]+fraction*(FREQUENCIES[j+1]-FREQUENCIES[j])))
        return candidates[-1] if candidates else None
    ea,eb=edge(loss_a),edge(loss_b)
    gd_a=-np.gradient(np.unwrap(np.angle(a[:,1,0])),FREQUENCIES)/(2*np.pi)
    gd_b=-np.gradient(np.unwrap(np.angle(b[:,1,0])),FREQUENCIES)/(2*np.pi)
    gd_domain=domain.copy();gd_domain[[0,-1]]=False;gd_domain&=abs(gd_b)>1e-12
    gd=float(np.max(abs(gd_a[gd_domain]-gd_b[gd_domain])/abs(gd_b[gd_domain]))) if gd_domain.any() else None
    return dict(attenuation_db=float(np.max(abs(loss_a[domain]-loss_b[domain]))),ripple_db=ripple,
        edge_rel=float(abs(ea-eb)/eb) if ea is not None and eb is not None else None,
        native_edge_hz=ea,reference_edge_hz=eb,group_delay_rel=gd,finite_db_domain_points=int(domain.sum()),
        independent_resolution_confirmed=False)


def matrix(root):
    root=Path(root);records=[read(root/f'port{p}') for p in (1,2)];metas=[m for m,_ in records]
    if any(m['excited_port']!=p or m['n']!=metas[0]['n'] or m['kind']!=metas[0]['kind'] or m['control']!=metas[0]['control'] for p,m in enumerate(metas,1)):
        raise ValueError('same mesh/model/control and distinct source columns required')
    data=[d for _,d in records];s,diag=extract(np.array([d['v'] for d in data]),np.array([d['i'] for d in data]))
    target=reference(kind=metas[0]['kind'],plane_mm=metas[0]['plane_mm']);err=difference(s,target)
    apps=application_errors(s,target) if metas[0]['kind']=='filter' else None
    reciprocity=float(abs(s-s.transpose(0,2,1)).max());power=float((np.linalg.svd(s,compute_uv=False)[:,0]**2).max())
    result=dict(n=metas[0]['n'],kind=metas[0]['kind'],control=metas[0]['control'],**err,
        contour_s_abs=diag['contour_s_abs'],recurrence_rel=diag['recurrence_rel'],reciprocity_abs=reciprocity,singular_power_max=power,
        incident_condition=diag['incident_condition'],incident_floor=diag['incident_floor'],qualified=False,
        application_errors=apps,
        target_passes=err['s_abs']<=LIMITS['s_target_abs'] and err['phase_deg']<=LIMITS['phase_target_deg'],
        measurement_passes=diag['contour_s_abs']<=LIMITS['contour_s_abs'] and diag['recurrence_rel']<=LIMITS['recurrence_rel'] and reciprocity<=LIMITS['reciprocity_abs'] and power<=LIMITS['singular_power_max'])
    values=dict(frequency_hz=FREQUENCIES,s=s,reference=target,**diag)
    if (root/'comparison.json').exists():
        if json.loads((root/'comparison.json').read_text())!=result:raise ValueError('changed stored comparison')
        with np.load(root/'matrix.npz') as saved:
            if set(saved)!=set(values):raise ValueError('changed matrix arrays')
            for key,val in values.items():np.testing.assert_array_equal(saved[key],val)
    else:np.savez_compressed(root/'matrix.npz',**values);save(root/'comparison.json',result)
    return s,result
