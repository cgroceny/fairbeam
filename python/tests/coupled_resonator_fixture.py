"""Own effective-TEM circuit realization, Example 6.6 (p. 302).

The example specifies line parameters, not a physical microstrip gap/substrate.
A shunt-inductor/shorted-line dual realizes the series-capacitor/open-line
circuit: Gamma_original = -Gamma_dual for the constant-Z0 line. Finite
conductivity is compared with its exact TEM reference separately. This does
not validate PCB gap fringing, a packaged capacitor, or the Designer ports.
"""
from datetime import datetime, timezone
import math
from pathlib import Path
import json
import re

import numpy as np
from openEMS.physical_constants import C0, EPS0, MUE0
from openEMS.ports import UI_data
import openEMS.ports as native_ports

from fairbeam.simulation import Simulation
from fairbeam.excitation import dgauss_duration_s
from tests.coax_resonator_fixture import runtime_identity, save, sha

LENGTH, ER, Z0 = .02175, 1.9, 50.
HEIGHT = .0005  # Own geometry, not a reconstructed microstrip substrate.
ETA = np.sqrt(MUE0/EPS0)
WIDTH = ETA*HEIGHT/(Z0*np.sqrt(ER))
ALPHA = np.log(10)/20  # 0.01 dB/cm = 1 dB/m.
KAPPA = float(2*ALPHA*np.sqrt(ER)/ETA)
F0 = C0/(2*LENGTH*np.sqrt(ER))
QU = np.pi/(2*ALPHA*LENGTH)
BC = np.sqrt(np.pi/(2*QU))
CAP_APPROX = BC/(2*np.pi*F0*Z0)
DELTA = .5*np.arccos(np.exp(-2*ALPHA*LENGTH))
F_CRITICAL = F0*(1-DELTA/np.pi)
CAP_CRITICAL = 1/(2*np.pi*F_CRITICAL*(Z0/np.tanh(ALPHA*LENGTH+1j*np.pi*F_CRITICAL/F0)).imag)
FREQUENCIES = np.linspace(4.7e9, 5.05e9, 401)
MESHES, COHORT, KINDS = (1, 2, 3, 4, 5, 6), (4, 5, 6), ('bare', 'approx', 'critical')
DT, THREADS, END_DB = .1e-12, 1, -70.
GATES = dict(gamma_target=.03, gamma_mesh=.005, gamma_control=.003,
             independent_current=.003, independent_plane=.003,
             f_target=.002, f_mesh=.0005, f_control=.0005,
             q_target=.05, q_mesh=.03, q_control=.02)
SCOPE = 'Own homogeneous PEC/PMC TEM circuit dual; physical microstrip gap unspecified'


def source_identity():
    root=Path(__file__).resolve().parents[1]
    names=('tests/coupled_resonator_fixture.py', 'tests/test_coupled_resonator.py',
           'tests/coax_resonator_fixture.py', 'fairbeam/simulation.py',
           'fairbeam/excitation.py', 'fairbeam/procutil.py')
    return {**{name:sha(root/name) for name in names},
            'native_ports.py':sha(native_ports.__file__)}


def line(freq, exact=True):
    """Passive TEM gamma/Zc; e^(+jwt), propagation e^(-gamma*x)."""
    freq=np.asarray(freq,float)
    if freq.ndim!=1 or not freq.size or not np.isfinite(freq).all() or np.any(freq<=0):
        raise ValueError('finite positive frequency vector required')
    omega=2*np.pi*freq
    if exact:
        lp=MUE0*HEIGHT/WIDTH
        cp=EPS0*ER*WIDTH/HEIGHT
        gp=KAPPA*WIDTH/HEIGHT
        gamma=np.sqrt(1j*omega*lp*(gp+1j*omega*cp))
        zc=np.sqrt(1j*omega*lp/(gp+1j*omega*cp))
    else:
        gamma=ALPHA+1j*omega*np.sqrt(ER)/C0
        zc=np.full(freq.shape,Z0,dtype=complex)
    return gamma,zc


def component(kind):
    if kind not in KINDS:
        raise ValueError('declared coupling case required')
    cap={'bare':None,'approx':CAP_APPROX,'critical':CAP_CRITICAL}[kind]
    return None if cap is None else cap*Z0**2


def reference(kind, freq=FREQUENCIES, exact=True):
    """Transform the physical lossy dual explicitly, never tune its parameters."""
    inductance=component(kind)
    gamma,zc=line(freq,exact)
    zd=zc*np.tanh(gamma*LENGTH)
    if inductance is not None:
        zd=1/(1/zd+1/(1j*2*np.pi*np.asarray(freq)*inductance))
    gd=(zd-Z0)/(zd+Z0)
    return -gd,Z0**2/zd


def deembed(v,i,distance,freq=FREQUENCIES):
    v,i=np.asarray(v),np.asarray(i)
    if v.shape!=i.shape or v.shape[-1]!=len(freq) or not np.isfinite(v).all() or not np.isfinite(i).all():
        raise ValueError('finite matching voltage/current spectra required')
    if not np.isfinite(distance) or distance<0:
        raise ValueError('finite nonnegative reference shift required')
    gamma,zc=line(freq)
    c,s=np.cosh(gamma*distance),np.sinh(gamma*distance)
    return v*c-zc*i*s,i*c-v/zc*s


def features(gamma,freq=FREQUENCIES):
    """Notch frequency and half-maximum accepted-power bandwidth, interpolated."""
    g=np.asarray(gamma)
    f=np.asarray(freq,float)
    if g.shape!=f.shape or len(f)<5 or not np.isfinite(g).all() or np.any(np.diff(f)<=0):
        raise ValueError('finite spectra on an increasing frequency grid required')
    power=1-abs(g)**2
    k=int(np.argmax(power))
    if not 0<k<len(f)-1 or power[k]<=0:
        raise ValueError('resolved interior passive absorption peak required')
    x=(f[k-1:k+2]-f[k])/(f[1]-f[0])
    a,b,c=np.polyfit(x,power[k-1:k+2],2)
    if a>=0 or abs(-b/(2*a))>1:
        raise ValueError('unresolved notch interpolation')
    peak_f=float(f[k]-b/(2*a)*(f[1]-f[0]))
    peak=float(c-b*b/(4*a))
    level=peak/2
    left=np.flatnonzero(power[:k]<level)
    right=np.flatnonzero(power[k+1:]<level)
    if not len(left) or not len(right):
        raise ValueError('half-power edges outside the sampled band')
    lo=int(left[-1]); hi=k+1+int(right[0])
    fl=float(f[lo]+(level-power[lo])/(power[lo+1]-power[lo])*(f[lo+1]-f[lo]))
    fr=float(f[hi-1]+(level-power[hi-1])/(power[hi]-power[hi-1])*(f[hi]-f[hi-1]))
    return dict(f_hz=peak_f,q_loaded=peak_f/(fr-fl),accepted_peak=peak,
                low_hz=fl,high_hz=fr)


class _NativeLog:
    def __init__(self,native):
        self.native=native
    def __getattr__(self,name):
        return getattr(self.native,name)
    def Run(self,*args,**kwargs):
        return self.native.Run(*args,**{**kwargs,'verbose':2})


class CoupledSimulation(Simulation):
    def run(self,*args,**kwargs):
        native=self.fdtd
        self.fdtd=_NativeLog(native)
        try:
            return super().run(*args,**kwargs)
        finally:
            self.fdtd=native
    def to_bundle(self,*args,**kwargs):
        raise ValueError('research probes and circuit dual have no Designer bundle')


def build(n,kind,feed=1,backing=1,cap_s=400e-9,cell_map=False):
    if (isinstance(n,bool) or n not in MESHES or not isinstance(n,int)
            or kind not in KINDS or isinstance(feed,bool) or feed not in (1,2) or not isinstance(feed,int)
            or isinstance(backing,bool) or backing not in (1,2) or not isinstance(backing,int)
            or not isinstance(cell_map,bool)):
        raise ValueError('declared integer mesh, case, feed and backing required')
    if not np.isfinite(cap_s) or not 100e-9<=cap_s<=1e-6:
        raise ValueError('cap must be 100 to 1000 ns')
    dx=LENGTH/(44*n)
    feed_length=feed*LENGTH/11
    # Native lower-PMC current coefficients vanish on its first dual plane.
    # Keep the source one axial node inside, at the same physical feed plane.
    x=np.arange(-4*n*feed-1,44*n+1)*dx
    y=np.linspace(0,WIDTH,4*n+1)
    z=np.r_[np.linspace(0,HEIGHT,2*n+1),HEIGHT+np.arange(1,backing+1)*HEIGHT/(2*n)]
    sim=CoupledSimulation(FREQUENCIES[0],FREQUENCIES[-1],end_criteria_db=END_DB,
        max_timesteps=math.ceil(cap_s/DT),boundaries=['PMC','PEC','PMC','PMC','PEC','PEC'])
    for axis,grid in zip('xyz',(x,y,z)):
        sim.mesh.AddLine(axis,grid/sim.unit)
    if DT>=sim.cfl_timestep():
        raise ValueError('declared clock exceeds vacuum CFL')
    sim.fdtd.SetTimeStep(DT)
    sim.fdtd.SetOverSampling(4)
    material=sim.csx.AddMaterial('effective_tem',epsilon=ER,kappa=KAPPA)
    material.AddBox([x[0]/sim.unit,0,0],[x[-1]/sim.unit,WIDTH/sim.unit,HEIGHT/sim.unit],priority=1)
    metal=sim.metal('top_backing')
    metal.AddBox([x[0]/sim.unit,0,HEIGHT/sim.unit],[x[-1]/sim.unit,WIDTH/sim.unit,z[-1]/sim.unit],priority=10)
    sim.lumped_port(1,Z0,[-feed_length/sim.unit,0,0],[-feed_length/sim.unit,WIDTH/sim.unit,HEIGHT/sim.unit],'z')
    inductance=component(kind)
    # A native full-width primitive distributes over N+1 transverse nodes.
    # Our TEM current represents the N-cell physical span. This optional
    # geometric map fixes that density; it never uses a measured spectrum.
    native_inductance=None if inductance is None else inductance*((len(y)-1)/len(y) if cell_map else 1.)
    if inductance is not None:
        sim.lumped_inductor('dual_coupling_L',native_inductance,[0,0,0],[0,WIDTH/sim.unit,HEIGHT/sim.unit],'z')
    planes=(-3*feed_length/4,-feed_length/4)
    dual_y=(y[:-1]+y[1:])/2
    # Current boxes enclose dual nodes. Exact endpoints can expand after
    # XML rounding, so request a small interior margin while normalizing
    # by the actual enclosed dual-node span, never the requested box width.
    margin=.01*(y[1]-y[0])
    contours={label:dict(lo=float(dual_y[a]),hi=float(dual_y[b]),
                        requested_lo=float(dual_y[a]+margin),
                        requested_hi=float(dual_y[b]-margin),
                        weight=float(WIDTH/(dual_y[b]-dual_y[a])))
              for label,a,b in (('i',0,4*n-1),('j',n,3*n-1))}
    current_indices={}
    zlo=(z[2*n-1]+HEIGHT)/2+.01*(HEIGHT-z[2*n-1])
    zhi=(HEIGHT+z[2*n+1])/2-.01*(z[2*n+1]-HEIGHT)
    for p,centre in enumerate(planes):
        ix=int(np.argmin(abs(x-centre)))
        for j,plane in enumerate(x[ix-1:ix+2]):
            sim.csx.AddProbe(f'v{p}_{j}',p_type=0).AddBox([plane/sim.unit,WIDTH/(2*sim.unit),HEIGHT/sim.unit],
                [plane/sim.unit,WIDTH/(2*sim.unit),0])
        for j,plane in enumerate(((x[ix-1]+x[ix])/2,(x[ix]+x[ix+1])/2)):
            for label,a,b in (('i',0,4*n-1),('j',n,3*n-1)):
                contour=contours[label]
                name=f'{label}{p}_{j}'
                sim.csx.AddProbe(name,p_type=1,norm_dir=0,weight=contour['weight']).AddBox(
                    [plane/sim.unit,contour['requested_lo']/sim.unit,zlo/sim.unit],
                    [plane/sim.unit,contour['requested_hi']/sim.unit,zhi/sim.unit])
                current_indices[name]=[[ix-1+j,a,2*n-1],[ix-1+j,b,2*n]]
    for prop in sim.csx.GetAllProperties():
        prop.SetColor((128,128,128),alpha=prop.GetFillColor()[3])
    return sim,dict(n=n,kind=kind,feed=feed,backing=backing,cap_s=cap_s,
        declared_dt_s=DT,max_timesteps=math.ceil(cap_s/DT),native_cells=int(np.prod([len(a) for a in (x,y,z)])),
        grid=[len(a) for a in (x,y,z)],dx_m=dx,planes_m=list(planes),threads=THREADS,
        source_plane_m=-feed_length,mesh_lower_x_m=float(x[0]),
        current_contours=contours,expected_current_indices=current_indices,
        cell_map=cell_map,native_shunt_l_h=native_inductance,
        physical_length_m=LENGTH,height_m=HEIGHT,width_m=WIDTH,epsilon_r=ER,kappa_s_m=KAPPA,
        dual_shunt_l_h=inductance,original_series_c_f=None if inductance is None else inductance/Z0**2,
        source_duration_s=dgauss_duration_s(sim.f_max),source_max_hz=sim.f_max,
        scope=SCOPE,frequency_hz=FREQUENCIES.tolist(),gates=GATES)


def acquire(out,n,kind,feed,backing,cap_s,cell_map=False):
    out=Path(out)
    out.mkdir(parents=True,exist_ok=False)
    sim,meta=build(n,kind,feed,backing,cap_s,cell_map)
    source,runtime=source_identity(),runtime_identity()
    sim.fdtd.Write2XML(str(out/'input.xml'))
    meta.update(source_sha256=source,runtime=runtime,input_sha256=sha(out/'input.xml'),
        started_utc=datetime.now(timezone.utc).isoformat())
    save(out/'declared.json',meta)
    sim.run(str(out/'raw'),threads=THREADS,exact=True,echo=True,dump_statistics=True)
    stats=np.loadtxt(out/'raw/openEMS_stats.txt',comments='%')
    v=np.asarray(UI_data([f'v{p}_{j}' for p in range(2) for j in range(3)],str(out/'raw'),FREQUENCIES).ui_f_val).reshape(2,3,-1)
    i=np.asarray(UI_data([f'i{p}_{j}' for p in range(2) for j in range(2)],str(out/'raw'),FREQUENCIES).ui_f_val).reshape(2,2,-1)
    check=np.asarray(UI_data([f'j{p}_{j}' for p in range(2) for j in range(2)],str(out/'raw'),FREQUENCIES).ui_f_val).reshape(2,2,-1)
    clocks={}
    for name in ('et',*[f'v{p}_{j}' for p in range(2) for j in range(3)],
                  *[f'{label}{p}_{j}' for label in ('i','j') for p in range(2) for j in range(2)]):
        t=np.loadtxt(out/'raw'/name,comments='%',ndmin=2)[:,0]
        clocks[name]=dict(samples=len(t),first_s=float(t[0]),last_s=float(t[-1]),
            stride_s=float((t[-1]-t[0])/(len(t)-1)),
            uniform_rel=float(np.max(abs(np.diff(t)/((t[-1]-t[0])/(len(t)-1))-1))))
    np.savez_compressed(out/'data.npz',f=FREQUENCIES,v=v,i=i,i_check=check)
    actual_indices={}
    for name in meta['expected_current_indices']:
        header=(out/'raw'/name).read_text(encoding='utf-8').splitlines()[:3]
        indices=[list(map(int,match)) for line in header
                 for match in re.findall(r'-> \[(\d+),(\d+),(\d+)\]',line)]
        if len(indices)!=2:
            raise ValueError('native current-probe index headers missing')
        actual_indices[name]=indices
    if source_identity()!=source or runtime_identity()!=runtime:
        raise RuntimeError('source or runtime changed during acquisition')
    meta.update(run=sim.run_stats,native=dict(cells=int(stats[0]),dt_s=float(stats[1]),
        timesteps=int(stats[2]),numerical_time_s=float(stats[3]),iteration_wall_s=float(stats[4])),
        probe_clocks=clocks,actual_current_indices=actual_indices,
        data_sha256=sha(out/'data.npz'),completed_utc=datetime.now(timezone.utc).isoformat())
    save(out/'report.json',meta)
    return meta


def read(out):
    out=Path(out)
    meta=json.loads((out/'report.json').read_text(encoding='utf-8'))
    if meta['source_sha256']!=source_identity() or meta['runtime']!=runtime_identity() or meta['gates']!=GATES:
        raise ValueError('source/runtime/acceptance epoch changed')
    if sha(out/'input.xml')!=meta['input_sha256'] or sha(out/'data.npz')!=meta['data_sha256']:
        raise ValueError('input or data changed')
    _,expected=build(meta['n'],meta['kind'],meta['feed'],meta['backing'],meta['cap_s'],meta['cell_map'])
    if any(meta[key]!=value for key,value in expected.items()):
        raise ValueError('model identity changed')
    native=meta['native']
    grid_ok=native['cells']==meta['native_cells'] and meta['run'].get('grid')==meta['grid']
    clock_ok=abs(native['dt_s']/DT-1)<1e-8
    header=meta.get('native_header',{})
    header_ok=(header.get('version')=='v0.37.0-rc3' and header.get('threads')==THREADS
        and header.get('nyquist_interval')==int(1/(2*meta['source_max_hz']*DT)))
    stride=int(1/(2*meta['source_max_hz']*DT))//4*DT
    names={'et',*[f'v{p}_{j}' for p in range(2) for j in range(3)],
           *[f'{label}{p}_{j}' for label in ('i','j') for p in range(2) for j in range(2)]}
    probes_ok=set(meta['probe_clocks'])==names and all(c['samples']>10 and c['uniform_rel']<1e-6 and abs(c['stride_s']/stride-1)<1e-6
        and 0<=native['numerical_time_s']-c['last_s']<stride+2*DT
        for name,c in meta['probe_clocks'].items() if name!='et')
    stopped=bool(meta['run'].get('converged') and native['timesteps']<meta['max_timesteps']
        and native['numerical_time_s']>meta['source_duration_s'] and meta['run'].get('threads')==THREADS)
    geometry_ok=meta.get('actual_current_indices')==meta['expected_current_indices']
    with np.load(out/'data.npz') as data:
        np.testing.assert_array_equal(data['f'],FREQUENCIES)
        v=data['v'][:,1]
        gamma,_=line(FREQUENCIES)
        currents=[data[name].mean(axis=1)/np.cosh(gamma*meta['dx_m']/2) for name in ('i','i_check')]
        spectra=[]
        for current in currents:
            planes=[]
            for j,distance in enumerate(meta['planes_m']):
                vv,ii=deembed(v[j],current[j],-distance)
                denominator=vv+Z0*ii
                scale=float(np.max(abs(denominator)))
                if not np.isfinite(scale) or scale<=0 or np.any(abs(denominator)<=1e-10*scale):
                    raise ValueError('singular incident spectrum')
                planes.append(-(vv-Z0*ii)/denominator)
            spectra.append(np.array(planes))
    target,_=reference(meta['kind'])
    original=spectra[0].mean(axis=0)
    plane_error=float(np.max(abs(spectra[0][0]-spectra[0][1])))
    contour_error=float(np.max(abs(spectra[0]-spectra[1])))
    target_error=float(np.max(abs(original-target)))
    quality=bool(grid_ok and clock_ok and header_ok and probes_ok and geometry_ok and stopped
        and plane_error<=GATES['independent_plane'] and contour_error<=GATES['independent_current'])
    result=dict(n=meta['n'],kind=meta['kind'],feed=meta['feed'],backing=meta['backing'],cell_map=meta['cell_map'],
        grid_ok=grid_ok,clock_ok=clock_ok,header_ok=header_ok,probe_clocks_ok=probes_ok,
        probe_geometry_ok=geometry_ok,stopped=stopped,
        gamma_target_abs=target_error,independent_plane_abs=plane_error,
        independent_current_abs=contour_error,quality_ok=quality,
        target_passes=bool(quality and target_error<=GATES['gamma_target']),qualified=False)
    if meta['kind']!='bare':
        result.update(measured=features(original),target=features(target),
            approximate_reference=features(reference(meta['kind'],exact=False)[0]))
        result['f_target_rel']=abs(result['measured']['f_hz']/result['target']['f_hz']-1)
        result['q_target_rel']=abs(result['measured']['q_loaded']/result['target']['q_loaded']-1)
        result['target_passes'] &= result['f_target_rel']<=GATES['f_target'] and result['q_target_rel']<=GATES['q_target']
    save(out/'comparison.json',result)
    return result,original


def study(out,kind,meshes=(1,2,3),cell_map=False):
    """Two successive mesh differences and two independent physical controls."""
    out=Path(out)
    meshes=tuple(meshes)
    if len(meshes)!=3 or sorted(set(meshes))!=list(meshes) or any(n not in MESHES for n in meshes) or not isinstance(cell_map,bool):
        raise ValueError('three increasing supported meshes and a boolean cell map required')
    rows=[read(out/f'n{n}'/kind) for n in meshes]
    middle=meshes[1]
    controls=[read(out/name/kind) for name in (f'n{middle}_feed',f'n{middle}_backing')]
    for n,(r,_) in zip(meshes,rows):
        if (r['n'],r['kind'],r['feed'],r['backing'],r['cell_map'])!=(n,kind,1,1,cell_map):
            raise ValueError('mesh cohort identity differs')
    for (r,_),fb in zip(controls,((2,1),(1,2))):
        if (r['n'],r['kind'],r['feed'],r['backing'],r['cell_map'])!=(middle,kind,*fb,cell_map):
            raise ValueError('control cohort identity differs')
    def change(a,b):
        value=dict(gamma_abs=float(np.max(abs(a[1]-b[1]))))
        if kind!='bare':
            value.update(f_rel=abs(a[0]['measured']['f_hz']/b[0]['measured']['f_hz']-1),
                q_rel=abs(a[0]['measured']['q_loaded']/b[0]['measured']['q_loaded']-1))
        return value
    mesh=[change(a,b) for a,b in zip(rows[:-1],rows[1:])]
    independent=[change(rows[1],control) for control in controls]
    passes=all(r['target_passes'] for r,_ in rows+controls)
    for values,role in ((mesh,'mesh'),(independent,'control')):
        passes &= all(r['gamma_abs']<=GATES['gamma_'+role] and (kind=='bare' or
            r['f_rel']<=GATES['f_'+role] and r['q_rel']<=GATES['q_'+role]) for r in values)
    result=dict(kind=kind,meshes=list(meshes),cell_map=cell_map,mesh_changes=mesh,independent_changes=independent,
        numerical_circuit_scope_passes=bool(passes),qualified_physical_microstrip_gap=False,scope=SCOPE)
    save(out/(kind+'-cohort.json'),result)
    return result
