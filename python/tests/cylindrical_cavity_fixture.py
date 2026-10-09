"""Own closed TE011 ring-down controls, Example 6.4 (p. 292).

The cylindrical axis is included. Both end-cap and curved-wall losses
belong in the reference. A sigma/4 symmetric sheet is diagnostic only;
no spatially resolved bulk conductor, external coupling or bundle export.
"""
from datetime import datetime, timezone
import json
import math
from pathlib import Path

import numpy as np
from CSXCAD import ContinuousStructure
from openEMS.physical_constants import C0, EPS0, MUE0

from fairbeam.excitation import dgauss_duration_s
from fairbeam.simulation import Simulation
from tests.circular_guide_fixture import bessel_j
from tests.coax_resonator_fixture import energy_decay, runtime_identity, save, sha

ER, F0, TAN_D, SIGMA, SHEET_T = 2.08, 5e9, .0004, 5.8e7, .035
MESHES, KINDS = (24, 28, 32), ('pec', 'dielectric', 'copper_sheet', 'both_sheet')
THREADS, END_DB, MAX_CAP_S = 1, -70., 16e-6
WINDOWS = ((20e-9, 80e-9), (80e-9, 140e-9), (140e-9, 200e-9))
GATES = dict(f_target=.002, q_target=.03, f_mesh=.0005, q_mesh=.02,
             f_control=.0002, q_control=.01, f_probe=1e-5, q_probe=.003,
             f_window=1e-5, q_window=.005, residual=.002,
             energy_agreement=.03, energy_log_rms=.4, energy_span_db=30., energy_uncertainty=.03)
SCOPE = 'Closed axisymmetric TE011 cavity, r=0 included, no external coupling; dielectric loss separate from symmetric sheets'


def root():
    """First positive J1 zero from a bracketed independent power series."""
    lo, hi = 3.7, 3.9
    for _ in range(54):
        mid = (lo+hi)/2
        if bessel_j(1, lo)*bessel_j(1, mid)<=0:
            hi = mid
        else:
            lo = mid
    return (lo+hi)/2


CHI = root()
RADIUS_MM = C0*np.sqrt(CHI*CHI+(np.pi/2)**2)/(2*np.pi*F0*np.sqrt(ER))*1e3
LENGTH_MM = 2*RADIUS_MM


def identity():
    base = Path(__file__).resolve().parents[1]
    names = ('tests/cylindrical_cavity_fixture.py', 'tests/test_cylindrical_cavity.py',
             'tests/circular_guide_fixture.py', 'tests/coax_resonator_fixture.py',
             'tests/test_coax_resonator.py', 'fairbeam/simulation.py',
             'fairbeam/excitation.py', 'fairbeam/procutil.py')
    return {name:sha(base/name) for name in names}


def reference(kind, frequency=F0):
    if kind not in KINDS or not np.isfinite(frequency) or frequency<=0:
        raise ValueError('supported case and finite positive reference frequency required')
    a, d = RADIUS_MM*1e-3, LENGTH_MM*1e-3
    kr, kz = CHI/a, np.pi/d
    k2 = kr*kr+kz*kz
    # Own Hr/Hz volume and tangential boundary integrals for
    # Ephi=J1(kr*r)sin(kz*z); curved wall and BOTH end caps are included.
    ratio = 2*kr*kr/(a*k2)+4*kz*kz/(d*k2)
    rs = np.sqrt(np.pi*frequency*MUE0/SIGMA)
    qc, qd = 2*np.pi*frequency*MUE0/(rs*ratio), frequency/(F0*TAN_D)
    inv_q = (1/qd if kind in ('dielectric','both_sheet') else 0.)
    inv_q += 1/qc if kind in ('copper_sheet','both_sheet') else 0.
    return dict(radius_mm=RADIUS_MM, length_mm=LENGTH_MM, eps_r=ER, j1_root=CHI,
                f_target_hz=F0, reference_frequency_hz=float(frequency),
                kr_rad_m=float(kr), kz_rad_m=float(kz), wall_volume_ratio_m_inv=float(ratio),
                rs_ohm=float(rs), qc=float(qc), qd=float(qd),
                q_unloaded=float(1/inv_q) if inv_q else None,
                sigma_dielectric_s_m=float(2*np.pi*F0*EPS0*ER*TAN_D),
                both_end_caps_included=True, external_coupling=False)


class _GeometryLog:
    """Keep the production runner; expose native cylindrical setup evidence."""
    def __init__(self, native):
        self.native = native

    def __getattr__(self, name):
        return getattr(self.native, name)

    def Run(self, *args, **kwargs):
        kwargs['verbose'] = 1
        return self.native.Run(*args, **kwargs)


class CavitySimulation(Simulation):
    def run(self, *args, **kwargs):
        native = self.fdtd
        self.fdtd = _GeometryLog(native)
        try:
            return super().run(*args, **kwargs)
        finally:
            self.fdtd = native

    def to_bundle(self, *args, **kwargs):
        raise ValueError('closed cylindrical research geometry has no Cartesian bundle or ports')


def build(n, kind, angular=8, margin=1, cap_s=None):
    if (isinstance(n,bool) or not isinstance(n,int) or n not in MESHES
            or isinstance(angular,bool) or not isinstance(angular,int) or angular not in (8,16)
            or isinstance(margin,bool) or not isinstance(margin,int) or margin not in (1,2)):
        raise ValueError('supported radial mesh, angular count and backing margin required')
    ref = reference(kind)
    if cap_s is None:
        cap_s = .23e-6 if kind=='pec' else (16e-6 if kind=='copper_sheet' else 1.6e-6)
    if not np.isfinite(cap_s) or not .23e-6<=cap_s<=MAX_CAP_S:
        raise ValueError('cap must cover all windows (230 ns), at most 16000 ns')
    sim = CavitySimulation(4.5e9,5.5e9,boundaries=['PEC']*6,end_criteria_db=END_DB)
    csx = ContinuousStructure(CoordSystem=1)
    sim.fdtd.SetCSX(csx)
    sim.csx,sim.mesh = csx,csx.GetGrid()
    sim.mesh.SetDeltaUnit(sim.unit)
    sim.mesh.SetMeshType(1)
    sim.fdtd.SetCoordSystem(1)
    dr,dz = RADIUS_MM/n,LENGTH_MM/(2*n)
    radius = dr*np.arange(n+margin+1)
    radius[n] = RADIUS_MM
    angle = np.linspace(0,2*np.pi,angular+1)
    z = dz*np.arange(-margin,2*n+margin+1)
    z[margin],z[margin+2*n] = 0.,LENGTH_MM
    for axis,lines in zip('xyz',(radius,angle,z)):
        sim.mesh.AddLine(axis,lines)
    # Vacuum bound using the smallest half-cell cylindrical chord, including
    # the axis control volume. Never use the Cartesian cfl_timestep here.
    # Same clock at each radial mesh for 8/16 angular cells; isolate the
    # periodic/azimuth control from temporal dispersion.
    arc = dr*np.sin(np.pi/16)
    dt = .5*sim.unit/(C0*np.sqrt(dr**-2+arc**-2+dz**-2))
    steps = int(math.ceil(cap_s/dt))
    sim.max_timesteps = steps
    sim.fdtd.SetNumberOfTimeSteps(steps)
    sim.fdtd.SetTimeStep(dt)
    sim.fdtd.SetOverSampling(4)
    lo,hi = [0,0,z[0]],[radius[-1],2*np.pi,z[-1]]
    sim.dielectric('fill',ER,tan_d=TAN_D if kind in ('dielectric','both_sheet') else 0.,tan_d_freq=F0).AddBox(lo,hi,priority=1)
    backing = sim.metal('wall_backing')
    backing.AddBox([RADIUS_MM,0,z[0]],hi,priority=10)
    backing.AddBox(lo,[radius[-1],2*np.pi,0],priority=10)
    backing.AddBox([0,0,LENGTH_MM],hi,priority=10)
    copper = kind in ('copper_sheet','both_sheet')
    if copper:
        sheet=sim.metal('wall_sheet',conductivity=SIGMA/4,thickness=SHEET_T)
        sheet.AddBox([RADIUS_MM,0,0],[RADIUS_MM,2*np.pi,LENGTH_MM],priority=11)
        for plane in (0.,LENGTH_MM):
            sheet.AddBox([0,0,plane],[RADIUS_MM,2*np.pi,plane],priority=11)
    source=csx.AddExcitation('mode_source',exc_type=0,exc_val=[0,1,0])
    source.SetWeightFunction(['0',f'j1({CHI:.17g}*rho/{RADIUS_MM:.17g})*sin(pi*z/{LENGTH_MM:.17g})','0'])
    source.AddBox([0,0,0],[RADIUS_MM,2*np.pi,LENGTH_MM])
    probes=[]
    for i,(r_frac,z_frac) in enumerate(((.5,.5),(.65,1/3))):
        r=float(radius[np.argmin(abs(radius-r_frac*RADIUS_MM))])
        plane=float(z[np.argmin(abs(z-z_frac*LENGTH_MM))])
        alpha0=0. if i==0 else np.pi
        csx.AddProbe(f'u{i}',p_type=0).AddBox([r,alpha0,plane],[r,alpha0+np.pi/2,plane])
        probes.append([r,alpha0,plane])
    native_lines=[len(radius),len(angle)+1,len(z)]
    meta=dict(n=n,kind=kind,angular=angular,margin=margin,cap_s=cap_s,reference=ref,
        declared_dt_s=float(dt),max_timesteps=steps,threads=THREADS,
        input_lines=[len(radius),len(angle),len(z)],native_lines=native_lines,
        reported_grid_lines=[len(radius),angular,len(z)],native_cells=int(np.prod(native_lines)),
        f_max_hz=sim.f_max,source_duration_s=dgauss_duration_s(sim.f_max),windows_s=WINDOWS,
        probe_stride_steps=int(1/(2*sim.f_max*dt))//4,probes_mm=probes,
        physical_dimensions_mm=[RADIUS_MM,LENGTH_MM],axis_included=True,
        sheet_sigma_s_m=SIGMA/4 if copper else None,sheet_thickness_mm=SHEET_T if copper else None,scope=SCOPE)
    return sim,meta


def pole(t, signal):
    """Free signed AR2 pole; growth is recorded, never clipped into a valid Q."""
    t, y = np.asarray(t, float), np.asarray(signal, float)
    if t.ndim!=1 or y.shape!=t.shape or len(t)<100 or not np.isfinite(t).all() or not np.isfinite(y).all():
        raise ValueError('finite matching trace with at least 100 samples required')
    dt = (t[-1]-t[0])/(len(t)-1)
    if dt<=0 or np.any(np.diff(t)<=0) or max(abs(np.diff(t)/dt-1))>.01:
        raise ValueError('nonuniform field clock')
    rms = np.sqrt(np.mean(y*y))
    if not rms>0:
        raise ValueError('zero signal')
    y = y/rms
    x = np.column_stack((y[1:-1], y[:-2], np.ones(len(y)-2)))
    coeff = np.linalg.lstsq(x, y[2:], rcond=None)[0]
    roots = np.roots([1., -coeff[0], -coeff[1]])
    root = roots[np.argmax(roots.imag)]
    if root.imag<=0 or not abs(root)>0:
        raise ValueError('not an oscillatory pole')
    alpha, omega = -np.log(abs(root))/dt, np.angle(root)/dt
    return dict(f_hz=float(omega/(2*np.pi)), alpha_s=float(alpha),
                q=float(omega/(2*alpha)) if alpha>0 else None,
                relative_residual=float(np.linalg.norm(x@coeff-y[2:])/np.linalg.norm(y[2:])))


def acquire(out, n, kind, angular, margin, cap_s):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sim, meta = build(n, kind, angular, margin, cap_s)
    source, runtime = identity(), runtime_identity()
    sim.fdtd.Write2XML(str(out/'input.xml'))
    meta.update(source_sha256=source, runtime=runtime, gates=GATES,
                input_sha256=sha(out/'input.xml'), started_utc=datetime.now(timezone.utc).isoformat())
    save(out/'declared.json', meta)
    sim.run(str(out/'raw'), threads=THREADS, echo=True, exact=True, dump_statistics=True)
    stats = np.loadtxt(out/'raw/openEMS_stats.txt', comments='%')
    energy = np.loadtxt(out/'raw/openEMS_run_stats.txt', comments='%', ndmin=2)
    trace = [np.loadtxt(out/f'raw/u{i}', comments='%', ndmin=2) for i in range(2)]
    np.testing.assert_array_equal(trace[0][:,0], trace[1][:,0])
    interval = int(1/(2*sim.f_max*stats[1]))
    np.savez_compressed(out/'data.npz', t=trace[0][:,0], u=np.array([v[:,1] for v in trace]),
                        energy_t=np.floor(energy[:,1]/interval)*interval*stats[1], energy=energy[:,3])
    if source!=identity() or runtime!=runtime_identity():
        raise RuntimeError('source or runtime changed during acquisition')
    meta.update(run=sim.run_stats, data_sha256=sha(out/'data.npz'),
                native=dict(cells=int(stats[0]), dt_s=float(stats[1]), timesteps=int(stats[2]),
                            numerical_time_s=float(stats[3]), iteration_wall_s=float(stats[4])),
                completed_utc=datetime.now(timezone.utc).isoformat())
    save(out/'report.json', meta)
    return meta


def read(out):
    out = Path(out)
    meta = json.loads((out/'report.json').read_text(encoding='utf-8'))
    if meta['source_sha256']!=identity() or meta['runtime']!=runtime_identity() or meta['gates']!=GATES:
        raise ValueError('source, runtime or acceptance protocol changed; retain old epochs')
    if sha(out/'input.xml')!=meta['input_sha256'] or sha(out/'data.npz')!=meta['data_sha256']:
        raise ValueError('input or data changed')
    _, expected = build(meta['n'], meta['kind'], meta['angular'], meta['margin'], meta['cap_s'])
    expected = json.loads(json.dumps(expected))
    if any(meta[k]!=expected[k] for k in expected):
        raise ValueError('model parameter identity changed')
    native, run, header = meta['native'], meta['run'], meta.get('native_header', {})
    grid_ok = native['cells']==meta['native_cells'] and run.get('grid')==meta['reported_grid_lines']
    clock_ok = abs(native['dt_s']/meta['declared_dt_s']-1)<1e-8
    header_ok = (header.get('version')=='v0.37.0-rc3' and header.get('threads')==THREADS
                 and header.get('axis_included') is True and header.get('closed_alpha') is True
                 and header.get('nyquist_interval')==int(1/(2*meta['f_max_hz']*native['dt_s'])))
    stopped = bool(run.get('converged') and native['timesteps']<meta['max_timesteps']
                   and native['numerical_time_s']>meta['source_duration_s'] and run.get('threads')==THREADS)
    poles, errors, proxy = [], [], None
    with np.load(out/'data.npz') as data:
        t = data['t']
        stride = native['dt_s']*meta['probe_stride_steps']
        probe_clock_ok = bool(t.ndim==1 and len(t)>1 and np.isfinite(t).all() and np.all(np.diff(t)>0)
                              and abs((t[-1]-t[0])/(len(t)-1)/stride-1)<1e-6
                              and t[-1]<=native['numerical_time_s']+2*native['dt_s'])
        for i, signal in enumerate(data['u']):
            for j, (lo, hi) in enumerate(WINDOWS):
                try:
                    if t[0]>lo or t[-1]<hi-stride:
                        raise ValueError('incomplete post-source window')
                    mask = (t>=lo)&(t<hi)
                    poles.append(dict(probe=i, window=j, **pole(t[mask], signal[mask])))
                except ValueError as exc:
                    errors.append(f'probe{i}/window{j}: {exc}')
        if len(poles)==6:
            freq = float(np.mean([p['f_hz'] for p in poles]))
            energy = data['energy']
            db = 10*np.log10(energy/energy.max()) if len(energy) else np.array([])
            mask = (data['energy_t']>WINDOWS[0][0])&(db<=-10)&(db>=-60)
            try:
                proxy = energy_decay(data['energy_t'][mask], energy[mask], freq, phase_corrected=True)
                proxy['physical_energy'] = False
            except ValueError as exc:
                errors.append(str(exc))
    result = dict(n=meta['n'], angular=meta['angular'], kind=meta['kind'], margin=meta['margin'],
                  grid_ok=grid_ok, clock_ok=clock_ok, header_ok=header_ok, probe_clock_ok=probe_clock_ok,
                  stopped=stopped, poles=poles, energy_proxy=proxy, extraction_errors=errors,
                  matches=False, qualified=False)
    if len(poles)==6:
        fs = np.array([p['f_hz'] for p in poles]).reshape(2,3)
        result.update(f_hz=float(fs.mean()), f_target_rel=float(abs(fs.mean()/F0-1)),
                      f_probe_rel=float(max(abs(fs[0]-fs[1]))/F0),
                      f_window_rel=float(max(np.ptp(fs, axis=1))/F0),
                      alpha_s=float(np.mean([p['alpha_s'] for p in poles])))
        if all(p['q'] is not None for p in poles):
            qs = np.array([p['q'] for p in poles]).reshape(2,3)
            q = float(qs.mean())
            target = reference(meta['kind'], result['f_hz'])['q_unloaded']
            q_probe, q_window = float(max(abs(qs[0]/qs[1]-1))), float(max(np.ptp(qs,axis=1))/q)
            stable = (result['f_probe_rel']<=GATES['f_probe'] and result['f_window_rel']<=GATES['f_window']
                      and q_probe<=GATES['q_probe'] and q_window<=GATES['q_window']
                      and max(p['relative_residual'] for p in poles)<=GATES['residual'])
            proxy_ok = bool(proxy and proxy['fitted_span_db']>=GATES['energy_span_db']
                            and proxy['log_rms']<=GATES['energy_log_rms']
                            and proxy['q_rel_95_uncertainty']<=GATES['energy_uncertainty']
                            and abs(proxy['q']/q-1)<=GATES['energy_agreement'])
            result.update(q=q, q_reference=target, q_probe_rel=q_probe, q_window_rel=q_window,
                          q_target_rel=abs(q/target-1) if target else None,
                          field_stable=bool(stable), energy_proxy_passes=proxy_ok,
                          matches=bool(meta['kind']=='dielectric' and target and stopped and grid_ok and clock_ok
                                       and probe_clock_ok and header_ok and stable and proxy_ok
                                       and result['f_target_rel']<=GATES['f_target']
                                       and abs(q/target-1)<=GATES['q_target']))
    save(out/'comparison.json', result)
    return result


def study(out, kind='dielectric'):
    out=Path(out)
    rows=[read(out/f'n{n}') for n in MESHES]
    controls=[read(out/'n28_margin'),read(out/'n24_angular')]
    for row,n in zip(rows,MESHES):
        if (row['n'],row['kind'],row['angular'],row['margin'])!=(n,kind,8,1):
            raise ValueError('radial mesh cohort identity differs')
    for row,values in zip(controls,((28,kind,8,2),(24,kind,16,1))):
        if (row['n'],row['kind'],row['angular'],row['margin'])!=values:
            raise ValueError('independent control identity differs')
    def change(a,b):
        return dict(f_rel=abs(b.get('f_hz',0)-a.get('f_hz',F0))/F0,
                    q_rel=abs(b['q']/a['q']-1) if b.get('q') and a.get('q') else None)
    changes=[change(a,b) for a,b in zip(rows,rows[1:])]
    independent=[change(rows[1],controls[0]),change(rows[0],controls[1])]
    qualified=(all(r['matches'] for r in rows+controls)
        and all(c['f_rel']<=GATES['f_mesh'] and c['q_rel'] is not None and c['q_rel']<=GATES['q_mesh'] for c in changes)
        and all(c['f_rel']<=GATES['f_control'] and c['q_rel'] is not None and c['q_rel']<=GATES['q_control'] for c in independent))
    result=dict(kind=kind,meshes=rows,controls=controls,mesh_changes=changes,
                independent_changes=independent,qualified=bool(qualified),scope=SCOPE)
    save(out/'comparison.json',result)
    return result
