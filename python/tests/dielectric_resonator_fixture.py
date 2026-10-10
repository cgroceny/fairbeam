"""Own open TE01delta controls, Example 6.5 (p. 297).

The magnetic side-wall frequency and 1/tan(delta) are approximate references.
The open model includes side fringing and radiation; neither is silently tuned
away. Research records only: no gallery changes, ports or Cartesian bundle.
"""
from datetime import datetime, timezone
import json
import math
from pathlib import Path

import numpy as np
from CSXCAD import ContinuousStructure
from openEMS.physical_constants import C0, EPS0

from fairbeam.excitation import dgauss_duration_s
from fairbeam.simulation import Simulation
from tests.circular_guide_fixture import TM01_ROOT
from tests.coax_resonator_fixture import energy_decay, runtime_identity, save, sha

RADIUS_MM, LENGTH_MM, ER, TAN_D = 4.13, 8.255, 95., .001
MESHES, COHORT = (8, 12, 16, 20, 24), (12, 16, 20)
KINDS, THREADS, END_DB = ('lossless', 'dielectric'), 1, -70.
WINDOWS = ((10e-9, 30e-9), (30e-9, 50e-9), (50e-9, 70e-9))
F_BAND = (2.8e9, 3.8e9)
GATES = dict(f_mesh=.002, q_mesh=.03, f_control=.001, q_control=.02,
             f_probe=1e-5, f_window=1e-5, q_probe=.005, q_window=.01,
             residual=.002, energy_span_db=30., energy_log_rms=.4,
             energy_uncertainty=.03, energy_agreement=.03)
SCOPE = ('Open isotropic cylindrical TE01delta resonator; intrinsic dielectric '
         'and radiation poles separate; magnetic side-wall reference approximate')


def reference(eps_r=ER):
    """Fundamental even axial root with a magnetic side wall, own SI constants.

    Match the dielectric axial standing wave to evanescent air tails, with
    transverse wavenumber J0's first zero / radius. Restrict to the first
    tangent branch; this is not the exact open lateral-boundary problem.
    """
    if not np.isfinite(eps_r) or eps_r <= 2:
        raise ValueError('finite relative permittivity above two required')
    a, length = RADIUS_MM*1e-3, LENGTH_MM*1e-3
    kr = TM01_ROOT/a
    lo = kr/np.sqrt(eps_r)*(1+1e-12)
    hi = min(kr, np.sqrt(kr*kr+(np.pi/length)**2)/np.sqrt(eps_r))*(1-1e-12)
    def residual(k):
        beta = np.sqrt(eps_r*k*k-kr*kr)
        alpha = np.sqrt(kr*kr-k*k)
        return beta*np.tan(beta*length/2)-alpha
    if not residual(lo) < 0 < residual(hi):
        raise ValueError('fundamental bound reference not bracketed')
    for _ in range(64):
        mid = (lo+hi)/2
        if residual(mid) > 0:
            hi = mid
        else:
            lo = mid
    k = (lo+hi)/2
    return dict(f_hz=float(C0*k/(2*np.pi)), qd_approximate=1/TAN_D,
                transverse_k_m=float(kr), axial_k_m=float(np.sqrt(eps_r*k*k-kr*kr)),
                decay_k_air_m=float(np.sqrt(kr*kr-k*k)), boundary_residual_m_inv=float(residual(k)),
                side_fringing_included=False, radiation_q_predicted=False)


F_REF = reference()['f_hz']


def identity():
    base = Path(__file__).resolve().parents[1]
    names = ('tests/dielectric_resonator_fixture.py', 'tests/test_dielectric_resonator.py',
             'tests/circular_guide_fixture.py', 'tests/coax_resonator_fixture.py',
             'tests/test_coax_resonator.py', 'fairbeam/simulation.py',
             'fairbeam/excitation.py', 'fairbeam/procutil.py')
    return {name: sha(base/name) for name in names}


def outside(dr, clearance, pml):
    """Graded air followed by uniform 3 mm PML cells; no material in PML."""
    increments, distance, step = [], 0., dr
    while distance < clearance-1e-12:
        step = min(step*1.25, 3.)
        take = min(step, clearance-distance)
        if 0 < clearance-distance-take < .5*dr:
            take = clearance-distance
        increments.append(take)
        distance += take
    return np.r_[0., np.cumsum(increments), clearance+np.arange(1, pml+1)*3.]


class _NativeLog:
    def __init__(self, native):
        self.native = native

    def __getattr__(self, name):
        return getattr(self.native, name)

    def Run(self, *args, **kwargs):
        return self.native.Run(*args, **{**kwargs, 'verbose': 2})


class ResonatorSimulation(Simulation):
    def run(self, *args, **kwargs):
        native = self.fdtd
        self.fdtd = _NativeLog(native)
        try:
            return super().run(*args, **kwargs)
        finally:
            self.fdtd = native

    def to_bundle(self, *args, **kwargs):
        raise ValueError('open cylindrical research geometry has no Cartesian bundle or ports')


def build(n, kind, angular=4, clearance=30., pml=8, cap_s=190e-9):
    if (isinstance(n, bool) or n not in MESHES or not isinstance(n, int)
            or kind not in KINDS or isinstance(angular, bool) or angular not in (4, 8)
            or not isinstance(angular, int) or clearance not in (30., 40.)
            or isinstance(pml, bool) or pml not in (8, 12) or not isinstance(pml, int)):
        raise ValueError('supported mesh, loss case and independent controls required')
    if not np.isfinite(cap_s) or not 90e-9 <= cap_s <= 5e-6:
        raise ValueError('cap must cover all windows with a tail (90 ns), at most 5000 ns')
    bc = ['PEC', f'PML_{pml}', 'PEC', 'PEC', f'PML_{pml}', f'PML_{pml}']
    sim = ResonatorSimulation(*F_BAND, boundaries=bc, end_criteria_db=END_DB)
    csx = ContinuousStructure(CoordSystem=1)
    sim.fdtd.SetCSX(csx)
    sim.csx, sim.mesh = csx, csx.GetGrid()
    sim.mesh.SetDeltaUnit(sim.unit)
    sim.mesh.SetMeshType(1)
    sim.fdtd.SetCoordSystem(1)
    dr, dz = RADIUS_MM/n, LENGTH_MM/(2*n)
    radius = np.r_[np.linspace(0, RADIUS_MM, n+1), RADIUS_MM+outside(dr, clearance, pml)[1:]]
    positive_z = np.r_[np.linspace(0, LENGTH_MM/2, n+1), LENGTH_MM/2+outside(dz, clearance, pml)[1:]]
    z = np.r_[-positive_z[:0:-1], positive_z]
    phi = np.linspace(0, 2*np.pi, angular+1)
    for axis, lines in zip('xyz', (radius, phi, z)):
        sim.mesh.AddLine(axis, lines)
    # Vacuum half-chord bound for the finer 8-sector control: same dt for
    # 4/8 sectors. Native calculated stability bound is audited independently.
    arc = dr*np.sin(np.pi/8)
    dt = .5*sim.unit/(C0*np.sqrt(dr**-2+arc**-2+dz**-2))
    steps = int(math.ceil(cap_s/dt))
    sim.max_timesteps = steps
    sim.fdtd.SetNumberOfTimeSteps(steps)
    sim.fdtd.SetTimeStep(dt)
    sim.fdtd.SetOverSampling(4)
    lo, hi = [0., 0., -LENGTH_MM/2], [RADIUS_MM, 2*np.pi, LENGTH_MM/2]
    sim.dielectric('resonator', ER, tan_d=TAN_D if kind == 'dielectric' else 0.,
                   tan_d_freq=F_REF).AddBox(lo, hi, priority=1)
    source = csx.AddExcitation('axisymmetric_source', exc_type=0, exc_val=[0, 1, 0])
    source.SetWeightFunction(['0', f'j1({TM01_ROOT/RADIUS_MM:.17g}*rho)*cos(pi*z/{LENGTH_MM:.17g})', '0'])
    source.AddBox(lo, hi)
    probes = []
    for i, (r, plane) in enumerate(((RADIUS_MM/2, 0.), (3*RADIUS_MM/4, LENGTH_MM/4))):
        phi0 = i*np.pi
        csx.AddProbe(f'u{i}', p_type=0).AddBox([r, phi0, plane], [r, phi0+np.pi/2, plane])
        probes.append([r, phi0, plane])
    native_lines = [len(radius), angular+2, len(z)]
    return sim, dict(n=n, kind=kind, angular=angular, clearance_mm=clearance, pml=pml,
        cap_s=cap_s, native_cells=int(np.prod(native_lines)), native_lines=native_lines,
        reported_grid_lines=[len(radius), angular, len(z)], declared_dt_s=float(dt),
        max_timesteps=steps, threads=THREADS, reference=reference(),
        f_max_hz=sim.f_max, source_duration_s=dgauss_duration_s(sim.f_max),
        windows_s=WINDOWS, pole_max_order=8, pole_order_check=6, pole_band_hz=F_BAND,
        probe_stride_steps=int(1/(2*sim.f_max*dt))//4,
        probes_mm=probes, physical_dimensions_mm=[RADIUS_MM, LENGTH_MM], eps_r=ER,
        sigma_dielectric_s_m=float(2*np.pi*F_REF*EPS0*ER*TAN_D) if kind == 'dielectric' else 0.,
        pml_start_mm=[float(radius[-pml-1]), float(z[pml]), float(z[-pml-1])],
        boundaries=bc, axis_included=True, scope=SCOPE)


def pole(t, signal):
    """Free signed AR8 poles; require one identifiable pole in the source band.

    Up to four damped pairs separate out-of-band modes from the pole of
    interest. Identifiable lower ranks use AR6/4/2. Two in-band pairs are
    rejected, never selected by proximity to the formula. Full AR8 fits
    must also agree with independent AR6 fits under the existing probewise
    frequency and damping tolerances; residual reduction alone is not enough.
    """
    t, y = np.asarray(t, float), np.asarray(signal, float)
    if t.ndim != 1 or y.shape != t.shape or len(t) < 100 or not np.isfinite(t).all() or not np.isfinite(y).all():
        raise ValueError('finite matching field trace with 100 samples required')
    dt = (t[-1]-t[0])/(len(t)-1)
    if dt <= 0 or np.any(np.diff(t) <= 0) or max(abs(np.diff(t)/dt-1)) > .01:
        raise ValueError('nonuniform field clock')
    scale = np.sqrt(np.mean(y*y))
    if not scale > 0:
        raise ValueError('zero signal')
    y = y/scale
    def fit(degree):
        x = np.column_stack([y[degree-j-1:len(y)-j-1] for j in range(degree)]
                            + [np.ones(len(y)-degree)])
        coeff, _, rank, _ = np.linalg.lstsq(x, y[degree:], rcond=None)
        return x, coeff, rank
    for order in (8, 6, 4, 2):
        x, coeff, rank = fit(order)
        if rank == order+1 or order == 2:
            break
    roots = np.roots(np.r_[1., -coeff[:-1]])
    oscillatory = [value for value in roots if value.imag > 0 and abs(value) > 0]
    candidates = [value for value in oscillatory
                  if F_BAND[0] < np.angle(value)/dt/(2*np.pi) < F_BAND[1]]
    if len(candidates) != 1:
        raise ValueError('one unambiguous oscillatory pole in the source band required')
    value = candidates[0]
    alpha, omega = -np.log(abs(value))/dt, np.angle(value)/dt
    order_check, order_stable = None, True
    if order == 8:
        _, lower, _ = fit(6)
        lower_roots = np.roots(np.r_[1., -lower[:-1]])
        lower_band = [v for v in lower_roots if v.imag > 0 and abs(v) > 0
                      and F_BAND[0] < np.angle(v)/dt/(2*np.pi) < F_BAND[1]]
        order_stable = False
        if len(lower_band) == 1:
            v = lower_band[0]
            lower_alpha, lower_omega = -np.log(abs(v))/dt, np.angle(v)/dt
            order_check = dict(f_rel=float(abs(lower_omega/omega-1)),
                alpha_rel=float(abs(lower_alpha-alpha)/max(abs(alpha), 1.)), lower_order=6)
            order_stable = (order_check['f_rel'] <= GATES['f_probe']
                            and order_check['alpha_rel'] <= GATES['q_probe'])
    return dict(f_hz=float(omega/(2*np.pi)), alpha_s=float(alpha),
        q=float(omega/(2*alpha)) if alpha > 0 else None,
        relative_residual=float(np.linalg.norm(x@coeff-y[order:])/np.linalg.norm(y[order:])),
        fitted_order=order, order_stable=bool(order_stable), order_check=order_check,
        other_poles=[dict(f_hz=float(np.angle(v)/dt/(2*np.pi)), alpha_s=float(-np.log(abs(v))/dt))
                     for v in oscillatory if v != value])


def acquire(out, n, kind, angular, clearance, pml, cap_s):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sim, meta = build(n, kind, angular, clearance, pml, cap_s)
    source, runtime = identity(), runtime_identity()
    sim.fdtd.Write2XML(str(out/'input.xml'))
    meta.update(source_sha256=source, runtime=runtime, gates=GATES,
        input_sha256=sha(out/'input.xml'), started_utc=datetime.now(timezone.utc).isoformat())
    save(out/'declared.json', meta)
    sim.run(str(out/'raw'), threads=THREADS, echo=True, exact=True, dump_statistics=True)
    stats = np.loadtxt(out/'raw/openEMS_stats.txt', comments='%')
    energy = np.loadtxt(out/'raw/openEMS_run_stats.txt', comments='%', ndmin=2)
    trace = [np.loadtxt(out/f'raw/u{i}', comments='%', ndmin=2) for i in range(2)]
    np.testing.assert_array_equal(trace[0][:, 0], trace[1][:, 0])
    interval = int(1/(2*sim.f_max*stats[1]))
    np.savez_compressed(out/'data.npz', t=trace[0][:, 0], u=np.array([row[:, 1] for row in trace]),
        energy_t=np.floor(energy[:, 1]/interval)*interval*stats[1], energy=energy[:, 3])
    if source != identity() or runtime != runtime_identity():
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
    if meta['source_sha256'] != identity() or meta['runtime'] != runtime_identity() or meta['gates'] != GATES:
        raise ValueError('source, runtime or acceptance protocol changed; retain old epochs')
    if sha(out/'input.xml') != meta['input_sha256'] or sha(out/'data.npz') != meta['data_sha256']:
        raise ValueError('input or data changed')
    _, expected = build(meta['n'], meta['kind'], meta['angular'], meta['clearance_mm'], meta['pml'], meta['cap_s'])
    expected = json.loads(json.dumps(expected))
    if any(meta[key] != expected[key] for key in expected):
        raise ValueError('model parameter identity changed')
    native, run, header = meta['native'], meta['run'], meta.get('native_header', {})
    grid_ok = native['cells'] == meta['native_cells'] and run.get('grid') == meta['reported_grid_lines']
    clock_ok = abs(native['dt_s']/meta['declared_dt_s']-1) < 1e-8
    header_ok = (header.get('version') == 'v0.37.0-rc3' and header.get('threads') == THREADS
        and header.get('axis_included') is True and header.get('closed_alpha') is True
        and header.get('pml_enabled') is True
        and header.get('nyquist_interval') == int(1/(2*meta['f_max_hz']*native['dt_s'])))
    stopped = bool(run.get('converged') and native['timesteps'] < meta['max_timesteps']
        and native['numerical_time_s'] > meta['source_duration_s'] and run.get('threads') == THREADS)
    poles, errors, proxy = [], [], None
    with np.load(out/'data.npz') as data:
        t, stride = data['t'], native['dt_s']*meta['probe_stride_steps']
        probe_clock_ok = bool(t.ndim == 1 and len(t) > 1 and np.isfinite(t).all()
            and np.all(np.diff(t) > 0) and abs((t[-1]-t[0])/(len(t)-1)/stride-1) < 1e-6
            and t[-1] <= native['numerical_time_s']+2*native['dt_s'])
        for i, signal in enumerate(data['u']):
            for j, (lo, hi) in enumerate(WINDOWS):
                try:
                    if t[0] > lo or t[-1] < hi-stride:
                        raise ValueError('incomplete post-source window')
                    mask = (t >= lo) & (t < hi)
                    poles.append(dict(probe=i, window=j, **pole(t[mask], signal[mask])))
                except ValueError as exc:
                    errors.append(f'probe{i}/window{j}: {exc}')
        if len(poles) == 6:
            frequency = float(np.mean([value['f_hz'] for value in poles]))
            energy = data['energy']
            db = 10*np.log10(energy/energy.max()) if len(energy) else np.array([])
            mask = (data['energy_t'] > WINDOWS[0][0]) & (db <= -10) & (db >= -60)
            try:
                proxy = energy_decay(data['energy_t'][mask], energy[mask], frequency, phase_corrected=True)
                proxy['physical_energy'] = False
            except ValueError as exc:
                errors.append(str(exc))
    result = dict(n=meta['n'], kind=meta['kind'], angular=meta['angular'],
        clearance_mm=meta['clearance_mm'], pml=meta['pml'], grid_ok=grid_ok, clock_ok=clock_ok,
        header_ok=header_ok, probe_clock_ok=probe_clock_ok, stopped=stopped,
        poles=poles, energy_proxy=proxy, extraction_errors=errors, completed_pole_control=False,
        qualified=False, reference=meta['reference'])
    if len(poles) == 6:
        fs = np.array([value['f_hz'] for value in poles]).reshape(2, 3)
        result.update(f_hz=float(fs.mean()), alpha_s=float(np.mean([value['alpha_s'] for value in poles])),
            approximate_frequency_difference_rel=float(fs.mean()/F_REF-1),
            qd_approximate_at_pole=float(fs.mean()/F_REF/TAN_D),
            f_probe_rel=float(max(abs(fs[0]-fs[1]))/fs.mean()),
            f_window_rel=float(max(np.ptp(fs, axis=1))/fs.mean()))
        if all(value['q'] is not None for value in poles):
            qs = np.array([value['q'] for value in poles]).reshape(2, 3)
            q = float(qs.mean())
            q_probe = float(max(abs(qs[0]/qs[1]-1)))
            q_window = float(max(np.ptp(qs, axis=1))/q)
            stable = (result['f_probe_rel'] <= GATES['f_probe'] and result['f_window_rel'] <= GATES['f_window']
                and q_probe <= GATES['q_probe'] and q_window <= GATES['q_window']
                and max(value['relative_residual'] for value in poles) <= GATES['residual']
                and all(value.get('order_stable', False) for value in poles))
            proxy_ok = bool(proxy and proxy['fitted_span_db'] >= GATES['energy_span_db']
                and proxy['log_rms'] <= GATES['energy_log_rms']
                and proxy['q_rel_95_uncertainty'] <= GATES['energy_uncertainty']
                and abs(proxy['q']/q-1) <= GATES['energy_agreement'])
            result.update(q=q, q_probe_rel=q_probe, q_window_rel=q_window,
                field_stable=bool(stable), energy_proxy_passes=proxy_ok,
                completed_pole_control=bool(stopped and grid_ok and clock_ok and header_ok
                    and probe_clock_ok and stable and proxy_ok))
    save(out/'comparison.json', result)
    return result


def loss_pair(lossless_out, dielectric_out):
    """Weak-loss pole subtraction; no unmeasured energy participation claim."""
    a, b = read(lossless_out), read(dielectric_out)
    if a['kind'] != 'lossless' or b['kind'] != 'dielectric':
        raise ValueError('lossless and dielectric records in that order required')
    if any(a[key] != b[key] for key in ('n', 'angular', 'clearance_mm', 'pml')):
        raise ValueError('paired geometry differs')
    result = dict(lossless=a, dielectric=b, qualified=False, intrinsic_q_inferred=None,
        completed_pair=bool(a['completed_pole_control'] and b['completed_pole_control']),
        reason='Subtract signed damping rates; assumes radiation damping unchanged to first order. Electric-energy participation is not independently measured.')
    if all(row.get('field_stable') for row in (a, b)):
        delta = b['alpha_s']-a['alpha_s']
        result['added_damping_s'] = delta
        if delta > 0:
            result['intrinsic_q_inferred'] = float(np.pi*b['f_hz']/delta)
    return result


def study(out, kind='dielectric', meshes=COHORT):
    """Numerical convergence is separate from an exact analytical validation.

    Even a converged open pole is not an exact check of the side-wall formula.
    A lossless pole measures radiation damping; 1/tan(delta) is not total Q.
    """
    meshes = tuple(meshes)
    if len(meshes) != 3 or sorted(set(meshes)) != list(meshes) or any(n not in MESHES for n in meshes):
        raise ValueError('three distinct increasing supported meshes required')
    out = Path(out)
    rows = [read(out/f'n{n}') for n in meshes]
    middle = meshes[1]
    controls = [read(out/f'n{middle}_{suffix}') for suffix in ('angular', 'clearance', 'pml')]
    for row, n in zip(rows, meshes):
        if (row['n'], row['kind'], row['angular'], row['clearance_mm'], row['pml']) != (n, kind, 4, 30., 8):
            raise ValueError('radial cohort identity differs')
    for row, values in zip(controls, ((middle, kind, 8, 30., 8), (middle, kind, 4, 40., 8), (middle, kind, 4, 30., 12))):
        if (row['n'], row['kind'], row['angular'], row['clearance_mm'], row['pml']) != values:
            raise ValueError('independent control identity differs')
    def change(a, b):
        return dict(f_rel=abs(b.get('f_hz', 0)/a.get('f_hz', F_REF)-1),
                    q_rel=abs(b['q']/a['q']-1) if b.get('q') and a.get('q') else None)
    changes = [change(a, b) for a, b in zip(rows, rows[1:])]
    independent = [change(rows[1], value) for value in controls]
    converged = (all(row['completed_pole_control'] for row in rows+controls)
        and all(value['f_rel'] <= GATES['f_mesh'] and value['q_rel'] is not None
                and value['q_rel'] <= GATES['q_mesh'] for value in changes)
        and all(value['f_rel'] <= GATES['f_control'] and value['q_rel'] is not None
                and value['q_rel'] <= GATES['q_control'] for value in independent))
    result = dict(kind=kind, meshes=rows, controls=controls, mesh_changes=changes,
        independent_changes=independent, pole_converged=bool(converged), qualified=False,
        reason='Magnetic side-wall and 1/tan(delta) references are approximations; total open Q includes radiation and energy outside the dielectric.',
        scope=SCOPE)
    save(out/'comparison.json', result)
    return result
