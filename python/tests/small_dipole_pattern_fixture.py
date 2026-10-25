"""Own finite-strip pattern scope associated with Example 14.2 (p. 664).

No gallery import, impedance certificate or complete antenna validation.
The finite model is compared with independently integrated sin-squared power.
"""
import math
from pathlib import Path
import re
import tempfile

import h5py
import numpy as np
from CSXCAD.SmoothMeshLines import SmoothMeshLines
from openEMS import _nf2ff
from openEMS.nf2ff import nf2ff, nf2ff_results
from openEMS.physical_constants import C0, EPS0, MUE0
from openEMS.ports import UI_data
from fairbeam import Simulation, excitation
from tests.coax_resonator_fixture import save, sha
from tests import coupled_stripline_fixture as environment

ROOT=Path(__file__).resolve().parents[2]
FREQUENCIES=np.array([.9,1.,1.1])*1e9
THETA=np.arange(0.,181.,2.);PHI=np.arange(0.,360.,10.)
MESHES=(1,2,3);CONTROLS=('ordinary','time','dt','domain','feed','td','fd1')
STUDY_CONTROLS=('time','dt','domain','feed')
END_DB,CAP_S,THREADS,OVERSAMPLING=-90.,13.5e-9,4,8
LENGTH,WIDTH,GAP=15.,.6,.4
SURFACES=(30.,45.)
MARKER='FAIRBEAM-SMALL-DIPOLE-PROPAGATION-BEGIN'
LIMITS=dict(pattern=.01,directivity=.01,native_directivity=.02,beamwidth_deg=1.,
    peak_deg=1.,power_balance=.05,crosspol=.001,tail_db=-70.,
    change_pattern=.002,change_directivity=.003,change_beamwidth_deg=.2,
    change_power_balance=.02,feed_z_relative=.005)
SCOPE='Finite PEC-strip radiation pattern; input impedance is recorded but is outside pattern qualification'
PREVIOUS_HEAD='2647318c915550c0af617e6c5e054dad6c0dc87b'
PREVIOUS_SOURCE={
    'tests/small_dipole_pattern_fixture.py':'77bda0bcee9a61530a739cc5920287ebc02c9654c734f8e87f9a4f17c03b564f',
    'tests/test_small_dipole_pattern.py':'767db5a343e471f31000fdc3667832e5b3a0d09303fb009cf47c8fb96fc728af'}


def identity():
    names=('tests/small_dipole_pattern_fixture.py','tests/test_small_dipole_pattern.py',
        'tests/coax_resonator_fixture.py','tests/coupled_stripline_fixture.py',
        'tests/test_coax_resonator.py','fairbeam/simulation.py','fairbeam/excitation.py','fairbeam/procutil.py')
    return {name:sha(ROOT/'python'/name)for name in names}


def wall_limit(value):
    if isinstance(value,bool)or not isinstance(value,(int,float))or not np.isfinite(value)or not 0<value<=2700.:
        raise ValueError('finite wall limit in 0..2700 seconds required; default is 1800')
    return float(value)


def audit_capture_provenance(out,m,sim):
    """Keep original receipts; admit only the pinned pre-wall-option source."""
    import json
    out=Path(out);receipt_path=out.parent/'worker.json'
    receipt=json.loads(receipt_path.read_text());current=identity()
    previous=dict(current,**PREVIOUS_SOURCE);legacy=m['source']!=current
    if legacy and (m['source']!=previous or receipt['driver_head']!=PREVIOUS_HEAD):
        raise ValueError('stored source changed')
    deadline=wall_limit(receipt['deadline_seconds'])
    times=[receipt['wall_seconds'],receipt['monotonic_seconds']]
    if (receipt['exit_code']!=0 or receipt['failure']is not None
        or any(isinstance(v,bool)or not isinstance(v,(int,float))or not np.isfinite(v)or v<0 or v>deadline for v in times)):
        raise ValueError('process receipt rejected')
    if legacy:
        if deadline!=1800.:raise ValueError('original capture must retain its 1800-second receipt')
    elif m.get('source_deadline_seconds')!=deadline or m.get('worker_receipt_sha256')!=sha(receipt_path):
        raise ValueError('process receipt changed')
    # Changing the supervisor cannot silently change the native physical model.
    with tempfile.TemporaryDirectory()as tmp:
        path=Path(tmp)/'input.xml';sim.fdtd.Write2XML(str(path))
        if sha(path)!=m['input_sha256']:raise ValueError('rebuilt native input changed')
    return receipt


def angular_metrics(power,theta=THETA,phi=PHI):
    p=np.asarray(power,float);theta=np.asarray(theta,float);phi=np.asarray(phi,float)
    if (p.shape!=(len(theta),len(phi)) or len(theta)<5 or len(phi)<4
        or not np.isfinite(p).all() or np.any(p<0) or p.max()<=0
        or theta[0]!=0 or theta[-1]!=180 or phi[0]!=0 or phi[-1]>=360
        or np.any(np.diff(theta)<=0) or np.any(np.diff(phi)<=0)):
        raise ValueError('finite nonnegative full-sphere samples required')
    norm=p/p.max();periodic=np.column_stack((norm,norm[:,0]))
    azimuth=np.trapezoid(periodic,x=np.deg2rad(np.r_[phi,360.]),axis=1)
    integral=np.trapezoid(azimuth*np.sin(np.deg2rad(theta)),x=np.deg2rad(theta))
    if not np.isfinite(integral) or integral<=0:raise ValueError('positive angular integral required')
    widths=[];peaks=[]
    for cut in norm.T:
        k=int(np.argmax(cut));peaks.append(float(theta[k]))
        crossings=np.flatnonzero((cut[:-1]-.5)*(cut[1:]-.5)<=0)
        left=crossings[crossings<k];right=crossings[crossings>=k]
        if not len(left) or not len(right):raise ValueError('two half-power crossings required')
        def cross(j):
            if cut[j+1]==cut[j]:raise ValueError('ambiguous half-power crossing')
            return theta[j]+(.5-cut[j])*(theta[j+1]-theta[j])/(cut[j+1]-cut[j])
        widths.append(float(cross(right[0])-cross(left[-1])))
    target=np.sin(np.deg2rad(theta))[:,None]**2
    return dict(directivity=float(4*np.pi/integral),hpbw_deg=widths,peak_theta_deg=peaks,
        pattern_error_abs=float(abs(norm-target).max()),normalized_power=norm)


class PatternSimulation(Simulation):
    def to_bundle(self,*args,**kwargs):raise ValueError('research pattern fixture has no Designer bundle representation')


def probe_bounds(mesh,start,stop,current=False):
    low=[];high=[]
    for axis,a,b in zip('xyz',start,stop):
        g=np.asarray(mesh[axis]);dual=(g[:-1]+g[1:])/2
        if current:
            lo,hi=[int(np.searchsorted(g,v,side='left'))-1 for v in (a,b)]
            # Containment also spans a collapsed transverse sheet coordinate.
            if dual[lo]>a:lo-=1
            if dual[hi]<b:hi+=1
        else:lo,hi=[int(np.searchsorted(dual,v,side='left'))for v in (a,b)]
        if not 0<=lo<=hi<len(g)-(1 if current else 0):raise ValueError('probe outside grid')
        low.append(lo);high.append(hi)
    return [low,high]


def build(n,control='ordinary',cap_s=None):
    if isinstance(n,bool) or not isinstance(n,int) or n not in MESHES or control not in CONTROLS:
        raise ValueError('declared mesh/control required')
    edge,arms,res=((2,8,10.),(4,12,8.),(6,16,6.))[n-1]
    free=140. if control=='domain'else 100.
    fine=np.linspace(-WIDTH/2,WIDTH/2,edge+1)
    fine[edge//2]=0.  # Preserve the physical sheet/voltage-probe plane at every level.
    step=(LENGTH-GAP)/(2*arms);tip=LENGTH/2
    z=np.r_[GAP/2+np.arange(arms)*step,tip-step/3,tip+2*step/3]
    anchors={'x':fine,'y':fine,'z':np.r_[-z,z]}
    mesh={}
    for axis in 'xyz':
        inner=SmoothMeshLines(np.unique(np.r_[-free,-np.array(SURFACES),anchors[axis],SURFACES,free]),res,1.4)
        pml=free+np.arange(1,9)*8.
        mesh[axis]=np.unique(np.r_[-pml,inner,pml]).tolist()
    dt=(.375 if control=='dt'else .5)/(C0*np.sqrt(sum(1/(np.diff(mesh[a]).min()*1e-3)**2 for a in 'xyz')))
    cap=CAP_S*(1.5 if control=='time'else 1.)if cap_s is None else float(cap_s)
    if not np.isfinite(cap) or cap<=0:raise ValueError('positive finite allocation required')
    sim=PatternSimulation(.8e9,1.2e9,boundaries=['PML_8']*6,end_criteria_db=END_DB,
        max_timesteps=math.ceil(cap/dt),excitation='dgauss')
    for axis,lines in mesh.items():sim.mesh.AddLine(axis,lines)
    sim.fdtd.SetTimeStep(float(dt));sim.fdtd.SetOverSampling(OVERSAMPLING)
    arm=sim.metal('arms')
    arm.AddBox([-WIDTH/2,0,-tip],[WIDTH/2,0,-GAP/2],priority=10)
    arm.AddBox([-WIDTH/2,0,GAP/2],[WIDTH/2,0,tip],priority=10)
    reference=100. if control=='feed'else 50.
    sim.lumped_port(1,reference,[-WIDTH/2,0,-GAP/2],[WIDTH/2,0,GAP/2],'z')
    recording={}if control=='td'else dict(frequency=FREQUENCIES.tolist())
    boxes=[nf2ff(sim.csx,f'pattern_{k}',[-r]*3,[r]*3,**recording)for k,r in enumerate(SURFACES)]
    field_sampling=1 if control=='fd1'else OVERSAMPLING
    for box in boxes:
        for dump in (box.e_dump,box.h_dump):
            if not hasattr(dump,'SetOverSampling'):raise RuntimeError('per-box sampling requires a supporting native runtime')
            dump.SetOverSampling(field_sampling)
    for p in sim.csx.GetAllProperties():p.SetColor((128,128,128),alpha=p.GetFillColor()[3])
    if sim.csx.Update():raise ValueError('invalid geometry')
    required=[p.GetName()for p in sim.csx.GetAllProperties()if p.GetTypeString()in('Metal','LumpedElement','Excitation')]
    port=sim._port_objs[0];indices={}
    for name in port.U_filenames+port.I_filenames:
        box=sim.csx.GetPropertiesByName(name)[0].GetAllPrimitives()[0]
        indices[name]=probe_bounds(mesh,box.GetStart(),box.GetStop(),name in port.I_filenames)
    return sim,boxes,dict(n=n,control=control,mesh_mm=mesh,grid=[len(mesh[a])for a in 'xyz'],
        native_cells=int(np.prod([len(mesh[a])for a in 'xyz'])),declared_dt_s=float(dt),cap_s=cap,
        max_timesteps=math.ceil(cap/dt),end_db=END_DB,reference_ohm=reference,free_half_mm=free,
        pml_cells=8,pml_cell_mm=8.,length_mm=LENGTH,width_mm=WIDTH,gap_mm=GAP,
        surfaces_mm=list(SURFACES),surface_names=[v.name for v in boxes],recording_domain='time'if control=='td'else'frequency',
        recording_over_sampling=field_sampling,required_properties=required,
        expected_probe_indices=indices,voltage_names=list(port.U_filenames),current_names=list(port.I_filenames),
        source_duration_s=excitation.dgauss_duration_s(1.2e9),threads=THREADS,nf2ff_threads=THREADS,
        frequencies_hz=FREQUENCIES.tolist(),theta_deg=THETA.tolist(),phi_deg=PHI.tolist(),
        scope=SCOPE,input_impedance_validated=False,full_antenna_validated=False)


def used(sim,names):
    return {p.GetName():[bool(v.GetPrimitiveUsed())for v in p.GetAllPrimitives()]
        for p in sim.csx.GetAllProperties()if p.GetName()in names}


def trace_clock(data,m,magnetic=False):
    dt=m['native']['dt_s'];stride=int(1/(2*1.2e9*dt))//OVERSAMPLING
    count=round(m['native']['numerical_time_s']/dt)//stride+1
    expected=(np.arange(count)*stride+(.5 if magnetic else 0))*dt
    if data.shape!=(count,2) or not np.isfinite(data).all() or not np.allclose(data[:,0],expected,rtol=2e-10,atol=dt*1e-5):
        raise ValueError('incomplete or changed native clock')


def source_info(path,m):
    a=np.loadtxt(path,comments='%',ndmin=2);dt=m['native']['dt_s'];t=np.arange(len(a))*dt
    if a.shape not in ((m['max_timesteps'],2),(m['max_timesteps']+1,2)) or not np.isfinite(a).all():
        raise ValueError('incomplete allocated source')
    if not np.allclose(a[:,0],t,rtol=6e-6,atol=dt*1e-6):raise ValueError('source clock changed')
    tau=1/(np.sqrt(2)*np.pi*1.2e9/2.76);t0=float(f'{5*tau:.6e}');tau=float(f'{tau:.6e}')
    q=(t-t0)/tau;want=-float(f'{np.sqrt(2*np.e):.8f}')*q*np.exp(-q*q)
    error=float(abs(a[:,1]-want).max()/abs(want).max())
    if error>6e-6:raise ValueError('source waveform changed')
    return dict(sha256=sha(path),waveform_error_relative=error)


def quality(m):
    run,native,op=m['run'],m['native'],m['operator'];energy=[run.get(k)for k in ('final_energy_db','final_energy_bound_db')]
    energy=[v for v in energy if isinstance(v,(int,float))and np.isfinite(v)]
    return {k:bool(v)for k,v in dict(grid=native['cells']==m['native_cells']and run.get('grid')==m['grid'],
        clock=abs(native['dt_s']/m['declared_dt_s']-1)<1e-8,
        time=native['timesteps']>0 and abs(native['numerical_time_s']/(native['timesteps']*native['dt_s'])-1)<1e-8,
        source=native['numerical_time_s']>=m['source_duration_s'],
        stopping=run.get('converged')is True and run.get('hit_timestep_limit')is False and bool(energy)and max(energy)<=END_DB+1e-7,
        operator=0<m['declared_dt_s']<=.8*op['run'].get('timestep_s',0),
        geometry=m['required_usage']==op['required_usage']and set(m['required_usage'])==set(m['required_properties'])and all(v and all(v)for v in m['required_usage'].values()),
        probes=m.get('actual_probe_indices')==m['expected_probe_indices'],
        engine=run.get('engine')=='cpu'and run.get('threads')==THREADS and run.get('exact_endcriteria')is True,
        tail=m['terminal_tail_db']<=LIMITS['tail_db']).items()}


def audit_header(text,m):
    body=text.split(MARKER)[-1];grid=re.search(r'FDTD simulation size: (\d+)x(\d+)x(\d+) --> (\S+) FDTD cells',body)
    if (text.count(MARKER)!=1 or re.findall(r'openEMS 64bit -- version (\S+)',body)!=['v0.37.0-rc3']
        or f'fixed number of threads: {THREADS}'not in body or not grid or list(map(int,grid.groups()[:3]))!=m['grid']
        or float(grid[4])!=float(format(m['native_cells'],'.6g'))):raise ValueError('native header mismatch')


def transform(raw,name,outfile):
    # The public convenience wrapper omits numThreads; bound the native transform too.
    calc=_nf2ff._nf2ff(FREQUENCIES.tolist(),np.deg2rad(THETA).tolist(),np.deg2rad(PHI).tolist(),[0.,0.,0.],numThreads=THREADS)
    calc.SetRadius(1.)
    for face in range(6):
        e,h=[raw/f'{name}_{key}_{face}.h5'for key in ('E','H')]
        if not e.is_file()or not h.is_file()or not calc.AnalyseFile(str(e),str(h)):
            raise ValueError('missing or rejected NF2FF surface')
    calc.Write2HDF5(str(outfile));return nf2ff_results(str(outfile))


def surface_inventory(raw,m):
    inventory={}
    def finite(a):
        if a.dtype.names:return all(finite(a[name])for name in a.dtype.names)
        return a.dtype.kind in 'bifuc'and bool(np.isfinite(a).all())
    for box,radius in zip(m['surface_names'],m['surfaces_mm']):
        for face in range(6):
            pair=[]
            for field in ('E','H'):
                path=Path(raw)/f'{box}_{field}_{face}.h5';arrays=[];mesh={}
                with h5py.File(path,'r')as handle:
                    for axis in 'xyz':
                        a=np.asarray(handle['Mesh'][axis])
                        if a.ndim!=1 or not a.size or not finite(a):raise ValueError('invalid HDF5 surface mesh')
                        mesh[axis]=a.tolist()
                    normal='xyz'[face//2];want=(-1 if face%2==0 else 1)*radius*1e-3
                    if len(mesh[normal])!=1 or abs(mesh[normal][0]-want)>2e-7:raise ValueError('HDF5 surface position differs from declared SI plane')
                    def visit(name,obj):
                        if isinstance(obj,h5py.Dataset)and name.startswith('FieldData/'):
                            a=np.asarray(obj)
                            if not a.size or not finite(a):raise ValueError('empty or nonfinite HDF5 field')
                            arrays.append(dict(path=name,shape=list(a.shape),dtype=str(a.dtype)))
                    handle.visititems(visit)
                if not arrays:raise ValueError('no native HDF5 field samples')
                inventory[path.name]=dict(mesh_m=mesh,arrays=arrays);pair.append(mesh)
            if pair[0]!=pair[1]:raise ValueError('E/H surfaces are not colocated')
    return inventory


def farfield_axes(result):
    np.testing.assert_allclose(result.freq,FREQUENCIES,rtol=1e-6,atol=0)
    # The native constructor stores float32 radians; avoid a second float32
    # rounding in rad2deg, which can exceed a degree-space tolerance by one ULP.
    np.testing.assert_array_equal(result.theta,np.deg2rad(THETA).astype(np.float32))
    np.testing.assert_array_equal(result.phi,np.deg2rad(PHI).astype(np.float32))
    if abs(float(np.asarray(result.r).ravel()[0])-1)>1e-6:raise ValueError('far-field radius changed')


def capture(out,n,control='ordinary',pilot_s=None):
    out=Path(out);out.mkdir(parents=True,exist_ok=False);sim,boxes,m=build(n,control,pilot_s)
    m.update(source=identity(),runtime=environment.runtime_identity());sim.fdtd.Write2XML(str(out/'input.xml'));m['input_sha256']=sha(out/'input.xml')
    if m!=__import__('json').loads((out.parent/'plan.json').read_text()):raise ValueError('pre-field model changed')
    setup,_,_=build(n,control,pilot_s);setup.fdtd.SetTimeStep(0.);setup.fdtd.SetNumberOfTimeSteps(1024)
    setup.fdtd.Write2XML(str(out/'operator-input.xml'))
    op=dict(run=setup.run(str(out/'operator'),threads=THREADS,exact=True,echo=True,setup_only=True),
        required_usage=used(setup,m['required_properties']),input_sha256=sha(out/'operator-input.xml'))
    save(out/'operator.json',op)
    if not 0<m['declared_dt_s']<=.8*op['run'].get('timestep_s',0)or not all(v and all(v)for v in op['required_usage'].values()):
        raise ValueError('operator admission failed')
    if identity()!=m['source']or environment.runtime_identity()!=m['runtime']:raise ValueError('source/runtime changed')
    print(MARKER,flush=True);sim.run(str(out/'raw'),threads=THREADS,exact=True,echo=True,dump_statistics=True)
    stats=np.loadtxt(out/'raw/openEMS_stats.txt',comments='%')
    m.update(native=dict(cells=int(stats[0]),dt_s=float(stats[1]),timesteps=int(stats[2]),numerical_time_s=float(stats[3]),iteration_wall_s=float(stats[4])),run=sim.run_stats,
        operator=op,required_usage=used(sim,m['required_properties']))
    values=[];tails=[];indices={};hashes={}
    for name in m['voltage_names']+m['current_names']:
        path=out/'raw'/name;a=np.loadtxt(path,comments='%',ndmin=2);trace_clock(a,m,name in m['current_names'])
        values.append(np.asarray(UI_data([name],str(out/'raw'),FREQUENCIES).ui_f_val)[0])
        tail=a[:,0]>=m['native']['numerical_time_s']-.5e-9
        tails.append(float(10*np.log10(max(np.mean(a[tail,1]**2),np.finfo(float).tiny)/max(np.max(a[:,1]**2),np.finfo(float).tiny))))
        hashes[name]=sha(path);indices[name]=[list(map(int,v))for v in re.findall(r'-> \[(\d+),(\d+),(\d+)\]','\n'.join(path.read_text().splitlines()[:3]))]
    m.update(terminal_tail_db=max(tails),actual_probe_indices=indices,raw_sha256=hashes,source_trace=source_info(out/'raw/et',m))
    m['surface_inventory']=surface_inventory(out/'raw',m)
    port=sim._port_objs[0];port.CalcPort(str(out/'raw'),FREQUENCIES)
    for actual,want in zip((port.uf_tot,port.if_tot),values):np.testing.assert_allclose(actual,want,rtol=3e-13,atol=1e-23)
    data=dict(frequency_hz=FREQUENCIES,v=values[0],i=values[1]);save(out/'report.json',m)
    if pilot_s is None:
        if not all(quality(m).values()):raise ValueError(f'rejected native source: {quality(m)}')
        outputs=[]
        for box in boxes:
            result=transform(out/'raw',box.name,out/f'{box.name}-farfield.h5');farfield_axes(result);outputs.append(result)
        data.update(theta_deg=THETA,phi_deg=PHI,e_theta=np.asarray([v.E_theta for v in outputs]),e_phi=np.asarray([v.E_phi for v in outputs]),
            native_dmax=np.asarray([v.Dmax for v in outputs]),prad_w=np.asarray([v.Prad for v in outputs]))
        m['field_sha256']={str(p.relative_to(out)):sha(p)for p in sorted((out/'raw').glob('pattern_*.h5'))}
        if len(m['field_sha256'])!=24:raise ValueError('all twelve E/H face pairs required')
        m['farfield_sha256']={p.name:sha(p)for p in sorted(out.glob('pattern_*-farfield.h5'))}
    np.savez_compressed(out/'data.npz',**data);m.update(data_sha256=sha(out/'data.npz'),operator_sha256=sha(out/'operator.json'))
    if identity()!=m['source']or environment.runtime_identity()!=m['runtime']:raise ValueError('source/runtime changed during acquisition')
    save(out/'report.json',m)


def read(out):
    import json
    out=Path(out);m=json.loads((out/'report.json').read_text());sim,_,expected=build(m['n'],m['control'],m['cap_s'])
    if any(m.get(k)!=v for k,v in expected.items())or m['runtime']!=environment.runtime_identity():
        raise ValueError('stored model/source/runtime changed')
    audit_capture_provenance(out,m,sim)
    if not all(quality(m).values()):raise ValueError('native source not admitted')
    for path,want in [('input.xml',m['input_sha256']),('operator-input.xml',m['operator']['input_sha256']),('operator.json',m['operator_sha256']),
        ('data.npz',m['data_sha256']),*m['field_sha256'].items(),*m['farfield_sha256'].items()]:
        if sha(out/path)!=want:raise ValueError('stored input/data changed')
    log=out.parent/'worker.log';audit_header(log.read_text(),m)
    if sha(log)!=m['native_log_sha256']:raise ValueError('native log changed')
    if json.loads((out.parent/'plan.json').read_text())!=dict(expected,source=m['source'],runtime=environment.runtime_identity(),input_sha256=m['input_sha256']):
        raise ValueError('pre-field plan changed')
    stats=np.loadtxt(out/'raw/openEMS_stats.txt',comments='%')
    if m['native']!=dict(cells=int(stats[0]),dt_s=float(stats[1]),timesteps=int(stats[2]),numerical_time_s=float(stats[3]),iteration_wall_s=float(stats[4])):
        raise ValueError('native statistics changed')
    with np.load(out/'data.npz')as record:data=dict(record)
    np.testing.assert_array_equal(data['frequency_hz'],FREQUENCIES);np.testing.assert_array_equal(data['theta_deg'],THETA);np.testing.assert_array_equal(data['phi_deg'],PHI)
    tails=[]
    for name,key in zip(m['voltage_names']+m['current_names'],('v','i')):
        path=out/'raw'/name
        if sha(path)!=m['raw_sha256'][name]:raise ValueError('raw probe changed')
        a=np.loadtxt(path,comments='%',ndmin=2);trace_clock(a,m,key=='i');t,x=a.T
        dft=np.asarray([2*(t[1]-t[0])*np.sum(x*np.exp(-2j*np.pi*f*t))for f in FREQUENCIES])
        np.testing.assert_allclose(data[key],dft,rtol=3e-13,atol=1e-23)
        indices=[list(map(int,v))for v in re.findall(r'-> \[(\d+),(\d+),(\d+)\]','\n'.join(path.read_text().splitlines()[:3]))]
        if indices!=m['expected_probe_indices'][name]:raise ValueError('probe indices changed')
        mask=t>=m['native']['numerical_time_s']-.5e-9
        tails.append(float(10*np.log10(max(np.mean(x[mask]**2),np.finfo(float).tiny)/max(np.max(x*x),np.finfo(float).tiny))))
    if max(tails)!=m['terminal_tail_db']or source_info(out/'raw/et',m)!=m['source_trace']:raise ValueError('tail/source changed')
    if surface_inventory(out/'raw',m)!=m['surface_inventory']:raise ValueError('native surface metadata changed')
    for j,name in enumerate(m['surface_names']):
        r=nf2ff_results(str(out/f'{name}-farfield.h5'));farfield_axes(r)
        for actual,key in ((r.E_theta,'e_theta'),(r.E_phi,'e_phi'),(r.Dmax,'native_dmax'),(r.Prad,'prad_w')):
            np.testing.assert_array_equal(np.asarray(actual),data[key][j])
    if not all(np.isfinite(v).all()for v in data.values()):raise ValueError('nonfinite field data')
    return m,data
