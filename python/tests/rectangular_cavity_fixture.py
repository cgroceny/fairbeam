"""Own TE10l closed-cavity ring-down controls, Example 6.3 (p. 287).

All six wall losses belong in the reference. A sigma_bulk/4, 35 um sheet
backed by PEC is explicitly a symmetric-sheet diagnostic, not bulk copper.
There is no feed/coupling loss, production model or exportable port.
"""
from datetime import datetime, timezone
import json
import math
from pathlib import Path

import numpy as np
from openEMS.physical_constants import C0, EPS0, MUE0

from fairbeam.excitation import dgauss_duration_s
from fairbeam.simulation import Simulation
from tests.coax_resonator_fixture import energy_decay, runtime_identity, save, sha

A, B, ER, F0 = 47.55, 22.15, 2.25, 5e9
TAN_D, SIGMA, SHEET_T = .0004, 5.8e7, .035
MODES, MESHES = (1, 2), (18, 22, 26)
KINDS = ('pec', 'dielectric', 'copper_sheet', 'both_sheet')
THREADS, END_DB, MAX_CAP_S = 4, -70., 8e-6
WINDOWS = ((20e-9, 80e-9), (80e-9, 140e-9), (140e-9, 200e-9))
GATES = dict(f_target=.002, q_target=.03, f_mesh=.0005, q_mesh=.02,
             f_control=.0002, q_control=.01, f_probe=1e-5, q_probe=.003,
             f_window=1e-5, q_window=.005, residual=.002,
             energy_agreement=.03, energy_log_rms=.4, energy_span_db=30., energy_uncertainty=.03)
SCOPE = ('Homogeneous, closed TE101/TE102 cavity; no external coupling; '
         'dielectric loss separate from symmetric conducting-sheet diagnostics')


def identity():
    root = Path(__file__).resolve().parents[1]
    names = ('tests/rectangular_cavity_fixture.py', 'tests/test_rectangular_cavity.py',
             'tests/coax_resonator_fixture.py', 'tests/test_coax_resonator.py',
             'fairbeam/simulation.py', 'fairbeam/excitation.py', 'fairbeam/procutil.py')
    return {name: sha(root/name) for name in names}


def reference(mode, kind, frequency=F0):
    if isinstance(mode, bool) or not isinstance(mode, int) or mode not in MODES or kind not in KINDS:
        raise ValueError('TE101/102 and a supported loss case required')
    if not np.isfinite(frequency) or frequency <= 0:
        raise ValueError('positive reference frequency required')
    a, b = A*1e-3, B*1e-3
    kx, k = np.pi/a, 2*np.pi*F0*np.sqrt(ER)/C0
    kz = np.sqrt(k*k-kx*kx)
    d = mode*np.pi/kz
    # Own Hx/Hz volume and tangential-wall integrals for Ey=sin(kx*x)sin(kz*z).
    # Surface/volume ratio includes both x, y and z walls, including end caps.
    ratio = 4*kx*kx/(a*k*k)+2/b+4*kz*kz/(d*k*k)
    rs = np.sqrt(np.pi*frequency*MUE0/SIGMA)
    qc, qd = 2*np.pi*frequency*MUE0/(rs*ratio), frequency/(F0*TAN_D)
    dielectric = kind in ('dielectric', 'both_sheet')
    copper = kind in ('copper_sheet', 'both_sheet')
    inv_q = (1/qd if dielectric else 0.)+(1/qc if copper else 0.)
    return dict(a_mm=A, b_mm=B, length_mm=float(d*1e3), eps_r=ER, f_target_hz=F0,
                reference_frequency_hz=float(frequency), kx_rad_m=float(kx), kz_rad_m=float(kz),
                wall_volume_ratio_m_inv=float(ratio), rs_ohm=float(rs), qc=float(qc), qd=float(qd),
                q_unloaded=float(1/inv_q) if inv_q else None,
                sigma_dielectric_s_m=float(2*np.pi*F0*EPS0*ER*TAN_D),
                all_six_wall_losses_included=True, external_coupling=False)


class CavitySimulation(Simulation):
    def to_bundle(self, *args, **kwargs):
        raise ValueError('closed ring-down research fixture has no exportable ports')


def build(n, mode, kind, margin=1, cap_s=None):
    if (isinstance(n, bool) or not isinstance(n, int) or n not in MESHES
            or isinstance(margin, bool) or not isinstance(margin, int) or margin not in (1, 2)):
        raise ValueError('supported mesh and backing margin required')
    ref = reference(mode, kind)
    if cap_s is None:
        cap_s = .23e-6 if kind=='pec' else (8e-6 if kind=='copper_sheet' else 1.6e-6)
    if not np.isfinite(cap_s) or not .23e-6 <= cap_s <= MAX_CAP_S:
        raise ValueError('cap must cover all windows (230 ns), at most 8000 ns')
    lengths = np.array([A, B, ref['length_mm']])
    counts = np.ceil(lengths/(lengths.min()/n)).astype(int)
    steps_mm = lengths/counts
    axes = [step*np.arange(-margin, count+margin+1) for step,count in zip(steps_mm,counts)]
    sim = CavitySimulation(4.5e9, 5.5e9, boundaries=['PEC']*6, end_criteria_db=END_DB)
    for axis, lines in zip('xyz', axes):
        sim.mesh.AddLine(axis, lines)
    dt = .5*sim.cfl_timestep()
    kx, kz = np.pi/A, mode*np.pi/lengths[2]
    lattice_k = np.sqrt((np.sin(kx*steps_mm[0]/2)/steps_mm[0])**2
                        +(np.sin(kz*steps_mm[2]/2)/steps_mm[2])**2)/sim.unit
    yee_frequency = np.arcsin(C0*dt*lattice_k/np.sqrt(ER))/(np.pi*dt)
    steps = int(math.ceil(cap_s/dt))
    sim.max_timesteps = steps
    sim.fdtd.SetNumberOfTimeSteps(steps)
    sim.fdtd.SetTimeStep(dt)
    sim.fdtd.SetOverSampling(4)
    lo, hi = np.array([v[0] for v in axes]), np.array([v[-1] for v in axes])
    dielectric = kind in ('dielectric', 'both_sheet')
    sim.dielectric('fill', ER, tan_d=TAN_D if dielectric else 0., tan_d_freq=F0).AddBox(lo, hi, priority=1)
    backing = sim.metal('wall_backing')
    copper = kind in ('copper_sheet', 'both_sheet')
    sheet = sim.metal('wall_sheet', conductivity=SIGMA/4, thickness=SHEET_T) if copper else None
    for axis, length in enumerate(lengths):
        for upper in (False, True):
            start, stop = lo.copy(), hi.copy()
            if upper:
                start[axis] = length
            else:
                stop[axis] = 0.
            backing.AddBox(start, stop, priority=10)
            if sheet:
                start, stop = np.zeros(3), lengths.copy()
                start[axis] = stop[axis] = length if upper else 0.
                sheet.AddBox(start, stop, priority=11)
    source = sim.csx.AddExcitation('mode_source', exc_type=0, exc_val=[0, 1, 0])
    source.SetWeightFunction(['0', f'sin(pi*x/{A:.17g})*sin({mode}*pi*z/{lengths[2]:.17g})', '0'])
    source.AddBox([0, 0, 0], lengths)
    probes = []
    for i, (px, pz) in enumerate(((A/2, lengths[2]/(2*mode)), (A/3, lengths[2]/(3*mode)))):
        x = float(axes[0][np.argmin(abs(axes[0]-px))])
        z = float(axes[2][np.argmin(abs(axes[2]-pz))])
        sim.csx.AddProbe(f'u{i}', p_type=0).AddBox([x, 0, z], [x, B, z])
        probes.append([x, z])
    lines = [len(v) for v in axes]
    meta = dict(n=n, mode=mode, kind=kind, margin=margin, cap_s=cap_s, reference=ref,
                declared_dt_s=dt, max_timesteps=steps, native_lines=lines,
                native_cells=int(np.prod(lines)), threads=THREADS, f_max_hz=sim.f_max,
                source_duration_s=dgauss_duration_s(sim.f_max), windows_s=WINDOWS,
                lossless_uniform_yee_frequency_hz=float(yee_frequency),
                probe_stride_steps=int(1/(2*sim.f_max*dt))//4, probes_mm=probes,
                physical_dimensions_mm=list(map(float,lengths)),
                sheet_sigma_s_m=SIGMA/4 if copper else None, sheet_thickness_mm=SHEET_T if copper else None,
                scope=SCOPE)
    return sim, meta


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


def acquire(out, n, mode, kind, margin, cap_s):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sim, meta = build(n, mode, kind, margin, cap_s)
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
    _, expected = build(meta['n'], meta['mode'], meta['kind'], meta['margin'], meta['cap_s'])
    expected = json.loads(json.dumps(expected))
    if any(meta[k]!=expected[k] for k in expected):
        raise ValueError('model parameter identity changed')
    native, run, header = meta['native'], meta['run'], meta.get('native_header', {})
    grid_ok = native['cells']==meta['native_cells'] and run.get('grid')==meta['native_lines']
    clock_ok = abs(native['dt_s']/meta['declared_dt_s']-1)<1e-8
    header_ok = (header.get('version')=='v0.37.0-rc3' and header.get('threads')==THREADS
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
    result = dict(n=meta['n'], mode=meta['mode'], kind=meta['kind'], margin=meta['margin'],
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
            target = reference(meta['mode'], meta['kind'], result['f_hz'])['q_unloaded']
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


def study(root, mode, kind='dielectric'):
    root = Path(root)
    rows = [read(root/f'n{n}') for n in MESHES]
    control = read(root/'n22_margin')
    for row, n in zip(rows, MESHES):
        if (row['n'],row['mode'],row['kind'],row['margin'])!=(n,mode,kind,1):
            raise ValueError('mesh cohort identity differs')
    if (control['n'],control['mode'],control['kind'],control['margin'])!=(22,mode,kind,2):
        raise ValueError('backing control identity differs')
    changes = [dict(f_rel=abs(b.get('f_hz',0)-a.get('f_hz',F0))/F0,
                    q_rel=abs(b['q']/a['q']-1) if b.get('q') and a.get('q') else None)
               for a,b in zip(rows,rows[1:])]
    boundary = dict(f_rel=abs(control.get('f_hz',0)-rows[1].get('f_hz',F0))/F0,
                    q_rel=abs(control['q']/rows[1]['q']-1) if control.get('q') and rows[1].get('q') else None)
    qualified = (all(r['matches'] for r in rows+[control])
                 and all(c['f_rel']<=GATES['f_mesh'] and c['q_rel'] is not None and c['q_rel']<=GATES['q_mesh'] for c in changes)
                 and boundary['f_rel']<=GATES['f_control'] and boundary['q_rel'] is not None
                 and boundary['q_rel']<=GATES['q_control'])
    result = dict(mode=mode, kind=kind, meshes=rows, control=control, mesh_changes=changes,
                  boundary_change=boundary, qualified=bool(qualified), scope=SCOPE)
    save(root/'comparison.json', result)
    return result
