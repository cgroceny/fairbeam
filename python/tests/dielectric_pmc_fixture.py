"""Own magnetic-sidewall calibration for Example 6.5 (p. 297).

The radial PMC implements the analytical boundary assumption. This separate
fixture does not qualify the open dielectric-resonator model. The constant-
conductivity pole follows our own complex extension of the separated equation.

From python/ in an openEMS environment (use fresh paths outside the checkout):
python -m tests.dielectric_pmc_fixture --plan --pilot --out D:/study/pmc-pilot
python -m tests.dielectric_pmc_fixture --fdtd --pilot --out D:/study/pmc-pilot
Use the pilot's conservative_rate_mcps as --rate-mcps for full --fdtd runs at
--mesh 8/12/16 --out D:/study/pmc/n8 (n12/n16). Then --analyse each capture
or --study --out D:/study/pmc. Pilots never qualify; fields are serial/one thread.
"""
import cmath
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

import numpy as np

from tests import dielectric_resonator_fixture as opened
from tests.test_coax_resonator import forecast, wait_owned
from tests.test_dielectric_resonator import audit_header
from fairbeam.procutil import popen_group, release_group, terminate_group

MESHES = (8, 12, 16)
DT_S, CAP_S, THREADS, END_DB = .38e-12, 1e-6, 1, -80.
WINDOWS = ((100e-9, 250e-9), (250e-9, 400e-9), (400e-9, 550e-9))
SIGMA = 2*np.pi*opened.F_REF*opened.EPS0*opened.ER*opened.TAN_D
GATES = {**opened.GATES, 'q_mesh': .02, 'f_reference': .002, 'q_reference': .02}
SCOPE = 'Radial PMC TE01delta calibration with evanescent axial vacuum tails'


def reference(sigma=SIGMA):
    """Separated constant-sigma pole, exp(+j*omega*t); Im(omega)>0 decays.

    kr is J0's first zero / radius. Match beta*tan(beta*L/2) to the axial
    evanescent alpha, with beta^2=(eps*omega^2-j*sigma*omega/eps0)/c^2-kr^2.
    This is a PMC-only reference, with no empirical frequency correction.
    """
    if isinstance(sigma, bool) or not np.isfinite(sigma) or sigma < 0:
        raise ValueError('finite nonnegative conductivity required')
    r = opened.reference()
    c, eps, length, kr = opened.C0, opened.ER, opened.LENGTH_MM*1e-3, r['transverse_k_m']
    omega = complex(2*np.pi*r['f_hz'], sigma/(2*opened.EPS0*eps))
    for _ in range(24):
        beta = cmath.sqrt((eps*omega*omega-1j*sigma*omega/opened.EPS0)/(c*c)-kr*kr)
        alpha = cmath.sqrt(kr*kr-omega*omega/(c*c))
        x = beta*length/2
        residual = beta*cmath.tan(x)-alpha
        db = (2*eps*omega-1j*sigma/opened.EPS0)/(2*beta*c*c)
        derivative = db*(cmath.tan(x)+beta*length/(2*cmath.cos(x)**2))+omega/(alpha*c*c)
        change = residual/derivative
        omega -= change
        if abs(change/omega) < 1e-14:
            break
    else:
        raise ValueError('fundamental constant-conductivity pole did not converge')
    beta = cmath.sqrt((eps*omega*omega-1j*sigma*omega/opened.EPS0)/(c*c)-kr*kr)
    alpha = cmath.sqrt(kr*kr-omega*omega/(c*c))
    residual = abs(beta*cmath.tan(beta*length/2)-alpha)
    frequency = omega.real/(2*np.pi)
    if (residual > 1e-8 or not opened.F_BAND[0] < frequency < opened.F_BAND[1]
            or (sigma > 0 and omega.imag <= 0)):
        raise ValueError('passive fundamental PMC pole is not established')
    b0, a0 = r['axial_k_m'], r['decay_k_air_m']
    inside = length/2+np.sin(b0*length)/(2*b0)
    outside = np.cos(b0*length/2)**2/a0
    participation = float(eps*inside/(eps*inside+outside))
    return dict(scope=SCOPE, f_hz=float(frequency), alpha_s=float(omega.imag),
        q=float(omega.real/(2*omega.imag)) if sigma else None, sigma_s_m=float(sigma),
        root_residual_m_inv=float(residual), analytic_electric_participation=participation,
        first_order_q=float(2*np.pi*r['f_hz']*opened.EPS0*eps/(sigma*participation)) if sigma else None,
        open_example_qualified=False)


def build(n, cap_s=CAP_S):
    if isinstance(n, bool) or not isinstance(n, int) or n not in MESHES:
        raise ValueError('supported PMC mesh required')
    if not np.isfinite(cap_s) or not 90e-9 <= cap_s <= 5e-6:
        raise ValueError('finite cap from 90 to 5000 ns required')
    sim, _ = opened.build(n, 'dielectric', cap_s=cap_s, air_refinement=2, pml_refinement=2)
    # ApplyMagneticBC sets transverse H at index numLines-2. Its Yee radius is
    # midway between the last two primary lines, so place that plane at R.
    dr = opened.RADIUS_MM/(n-.5)
    radius = np.arange(n+1)*dr
    sim.mesh.ClearLines('x')
    sim.mesh.AddLine('x', radius)
    bc = ['PEC', 'PMC', 'PEC', 'PEC', 'PML_16', 'PML_16']
    sim.boundaries = bc
    sim.fdtd.SetBoundaryCond(bc)
    steps = math.ceil(cap_s/DT_S)
    sim.fdtd.SetTimeStep(DT_S)
    sim.fdtd.SetNumberOfTimeSteps(steps)
    sim.end_criteria_db = END_DB
    sim.fdtd.SetEndCriteria(10**(END_DB/10))
    sim.max_timesteps = steps
    nr, ny, nz = [len(sim.mesh.GetLines(axis)) for axis in 'xyz']
    meta = dict(scope=SCOPE, n=n, radius_mm=opened.RADIUS_MM, length_mm=opened.LENGTH_MM,
        magnetic_wall_radius_mm=float((radius[-2]+radius[-1])/2),
        last_primary_radius_mm=float(radius[-1]), eps_r=opened.ER, sigma_s_m=float(SIGMA),
        loss_reference_hz=opened.F_REF, boundaries=bc, angular=4, clearance_mm=30.,
        axial_pml_cells=16, axial_pml_width_mm=24., air_refinement=2,
        reported_grid_lines=[nr, ny-1, nz], native_cells=nr*(ny+1)*nz,
        declared_dt_s=DT_S, max_timesteps=steps, cap_s=cap_s, threads=THREADS, end_db=END_DB,
        f_max_hz=sim.f_max, source_duration_s=opened.dgauss_duration_s(sim.f_max),
        probe_stride_steps=int(1/(2*sim.f_max*DT_S))//4, windows_s=WINDOWS,
        reference=reference(), open_example_qualified=False)
    return sim, meta


def identity():
    root = Path(__file__).resolve().parents[1]
    return {**opened.identity(), **{name: opened.sha(root/name) for name in
        ('tests/dielectric_pmc_fixture.py', 'tests/test_dielectric_pmc.py')}}


def energy_proxy(rows, dt, frequency, field_q):
    """Use the native cache clock, coalescing identical repeated ticks only."""
    if (rows.ndim != 2 or rows.shape[1] < 4 or len(rows) < 20
            or not np.isfinite(rows).all() or np.any(rows[:, 3] <= 0)):
        raise ValueError('positive finite native energy rows required')
    nyquist = int(1/(2*opened.F_BAND[1]*dt))
    ticks = np.floor(rows[:, 1]/nyquist).astype(np.int64)
    if np.any(np.diff(ticks) < 0):
        raise ValueError('cached-energy clock reversed')
    repeated = np.flatnonzero(np.r_[False, np.diff(ticks) == 0])
    if any(rows[i, 3] != rows[i-1, 3] for i in repeated):
        raise ValueError('different energies at the same cache tick')
    keep = np.r_[True, np.diff(ticks) > 0]
    t, energy = ticks[keep]*nyquist*dt, rows[keep, 3]
    db = 10*np.log10(energy/energy.max())
    mask = (t > WINDOWS[0][0]) & (db <= -10) & (db >= -60)
    fit = opened.energy_decay(t[mask], energy[mask], frequency, phase_corrected=True)
    difference = abs(fit['q']/field_q-1)
    passed = bool(fit['fitted_span_db'] >= GATES['energy_span_db']
        and fit['log_rms'] <= GATES['energy_log_rms']
        and fit['q_rel_95_uncertainty'] <= GATES['energy_uncertainty']
        and difference <= GATES['energy_agreement'])
    return dict(fit=fit, q_difference_rel=float(difference), passed=passed,
        identical_repeat_count=len(repeated), physical_energy_integral=False)


def save(path, value):
    def native(item):
        if isinstance(item, np.generic):
            return item.item()
        raise TypeError(type(item).__name__)
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False, default=native)+'\n', encoding='utf-8')


def runtime_identity():
    result = opened.runtime_identity()
    if sys.platform == 'win32':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.GetModuleHandleW.argtypes = (wintypes.LPCWSTR,)
        kernel.GetModuleHandleW.restype = wintypes.HMODULE
        kernel.GetModuleFileNameW.argtypes = (wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD)
        path = ctypes.create_unicode_buffer(32768)
        handle = kernel.GetModuleHandleW('openEMS.dll')
        length = kernel.GetModuleFileNameW(handle, path, len(path)) if handle else 0
        if not 0 < length < len(path):
            raise ValueError('actual loaded openEMS.dll is unavailable')
        actual = str(Path(path.value).resolve())
        if result['files'].get(actual) != opened.sha(actual):
            raise ValueError('loaded openEMS.dll differs from the configured runtime')
        result['loaded_openems'] = actual
    return result


def physics_sha(path):
    """CSXCAD assigns display colors; exclude those from physical identity."""
    root = ET.parse(path).getroot()
    for parent in root.iter():
        for child in list(parent):
            if child.tag in ('FillColor', 'EdgeColor'):
                parent.remove(child)
    return hashlib.sha256(ET.tostring(root)).hexdigest()


def worker(out, n, cap_s, setup=False):
    out = Path(out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    sim, meta = build(n, cap_s)
    source, runtime = identity(), runtime_identity()
    sim.fdtd.Write2XML(str(out/'input.xml'))
    meta.update(source_sha256=source, runtime=runtime, gates=GATES,
        physics_sha256=physics_sha(out/'input.xml'), input_sha256=opened.sha(out/'input.xml'),
        started_utc=datetime.now(timezone.utc).isoformat())
    save(out/'declared.json', meta)
    sim.run(str(out/'raw'), threads=THREADS, engine='cpu', echo=True, exact=True,
            setup_only=setup, dump_statistics=True)
    if source != identity() or runtime != runtime_identity():
        raise ValueError('source or loaded runtime changed during acquisition')
    meta.update(run=sim.run_stats, setup_only=setup,
                completed_utc=datetime.now(timezone.utc).isoformat())
    if not setup:
        stats = np.loadtxt(out/'raw/openEMS_stats.txt', comments='%')
        traces = [np.loadtxt(out/f'raw/u{i}', comments='%', ndmin=2) for i in range(2)]
        np.testing.assert_array_equal(traces[0][:, 0], traces[1][:, 0])
        energy = np.loadtxt(out/'raw/openEMS_run_stats.txt', comments='%', ndmin=2)
        np.savez_compressed(out/'data.npz', t=traces[0][:, 0],
            u=np.array([v[:, 1] for v in traces]), energy_rows=energy)
        meta.update(native=dict(cells=int(stats[0]), dt_s=float(stats[1]), timesteps=int(stats[2]),
            numerical_time_s=float(stats[3]), iteration_wall_s=float(stats[4])),
            data_sha256=opened.sha(out/'data.npz'),
            raw_sha256={name: opened.sha(out/'raw'/name) for name in
                        ('u0', 'u1', 'openEMS_stats.txt', 'openEMS_run_stats.txt')})
    save(out/'report.json', meta)
    return meta


def run_owned(out, n, cap_s, setup, seconds):
    """Only this child job may be terminated; retain every partial epoch."""
    command = [sys.executable, '-m', 'tests.dielectric_pmc_fixture', '--worker',
        'setup' if setup else 'field', '--mesh', str(n), '--cap-ns', str(cap_s*1e9), '--out', str(out)]
    log_path = out.with_suffix('.log')
    code, error = None, None
    with log_path.open('x', encoding='utf-8') as log:
        process = popen_group(command, cwd=Path(__file__).resolve().parents[1], stdout=log,
            stderr=subprocess.STDOUT,
            env={**os.environ, 'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1'})
        start, wall = time.monotonic(), time.time()
        try:
            code = wait_owned(process, seconds=seconds)
        except BaseException as exc:
            error = type(exc).__name__+': '+str(exc)
            raise
        finally:
            if process.poll() is None:
                terminate_group(process.pid, grace=0, job=process.win_job)
                process.wait(timeout=15)
            release_group(process)
            save(out.with_suffix('.runner.json'), dict(command=command, pid=process.pid,
                exit_code=code, error=error, limit_seconds=seconds,
                monotonic_seconds=time.monotonic()-start, wall_seconds=time.time()-wall))
    if code != 0:
        raise RuntimeError(f'worker exit {code}; raw epoch retained at {out}')
    return json.loads((out/'report.json').read_text(encoding='utf-8'))


def audit_setup(text, meta):
    cfl = re.search(r'Timestep \(s\)\s*:\s*([\d.eE+-]+)\s*\(([\d.eE+-]+)\)', text)
    if (not cfl or abs(float(cfl[1])/meta['declared_dt_s']-1) > 1e-8
            or meta['declared_dt_s'] > .95*float(cfl[2])):
        raise ValueError('native CFL admission failed')
    if (meta['run'].get('grid') != meta['reported_grid_lines']
            or meta['run'].get('timesteps') not in (None, 0)
            or text.count('--- Uniaxial PML Extension ---') != 2
            or 'r=0 included...' not in text or 'closed Cylinder' not in text
            or re.search(r'resetting to PEC|not compatible with cylinder', text, re.I)):
        raise ValueError('native PMC setup/axis/axial PML admission failed')
    return dict(native_cfl_s=float(cfl[2]), native_propagations=0)


def acquire_serial(out, n, rate_mcps, pilot=False):
    out = Path(out).resolve()
    if out.exists() or out.is_relative_to(Path(__file__).resolve().parents[2]):
        raise ValueError('use a fresh capture path outside the checkout')
    cap = 90e-9 if pilot else CAP_S
    _, meta = build(n, cap)
    estimate, limit = forecast(meta, rate_mcps), 600 if pilot else 2700
    if estimate > limit:
        raise ValueError(f'forecast {estimate/60:.2f} min exceeds {limit/60:g}; defer before launch')
    print(f'{meta["native_cells"]} cells, forecast {estimate/60:.2f} min, '
          f'one thread, hard deadline {limit/60:g} min', flush=True)
    out.mkdir(parents=True, exist_ok=False)
    setup = run_owned(out/'setup', n, cap, True, 300)
    admission = audit_setup((out/'setup.log').read_text(encoding='utf-8'), setup)
    field = run_owned(out/'field', n, cap, False, limit)
    if (field['physics_sha256'] != setup['physics_sha256']
            or field['source_sha256'] != setup['source_sha256'] or field['runtime'] != setup['runtime']):
        raise ValueError('field/source/runtime differs from admitted operator')
    header = audit_header((out/'field.log').read_text(encoding='utf-8'), field)
    admission.update(native_header=header, pilot_only=pilot, estimated_seconds=estimate,
        report_sha256=opened.sha(out/'field/report.json'),
        setup_sha256=opened.sha(out/'setup/report.json'), log_sha256=opened.sha(out/'field.log'),
        runner_sha256=opened.sha(out/'field.runner.json'))
    save(out/'admission.json', admission)
    return dict(out=str(out), pilot_only=pilot, native=field['native'],
        conservative_rate_mcps=.8*field['native']['cells']*field['native']['timesteps']
                               /field['native']['iteration_wall_s']/1e6,
        qualified=False, open_example_qualified=False)


def extract(t, signals):
    """Free two-probe, three-window pole fits; never choose by target proximity."""
    result = dict(poles=[], errors=[], field_stable=False)
    if signals.shape != (2, len(t)) or len(t) < 2:
        raise ValueError('two matching probe traces required')
    for i, signal in enumerate(signals):
        for j, (lo, hi) in enumerate(WINDOWS):
            try:
                if t[0] > lo or t[-1] < hi-(t[1]-t[0]):
                    raise ValueError('incomplete post-source window')
                mask = (t >= lo) & (t < hi)
                result['poles'].append(dict(probe=i, window=j, **opened.pole(t[mask], signal[mask])))
            except ValueError as exc:
                result['errors'].append(f'probe{i}/window{j}: {exc}')
    poles = result['poles']
    if len(poles) == 6 and all(v['q'] is not None for v in poles):
        fs = np.array([v['f_hz'] for v in poles]).reshape(2, 3)
        qs = np.array([v['q'] for v in poles]).reshape(2, 3)
        result.update(f_hz=float(fs.mean()), q=float(qs.mean()),
            f_probe_rel=float(max(abs(fs[0]-fs[1]))/fs.mean()),
            f_window_rel=float(max(np.ptp(fs, axis=1))/fs.mean()),
            q_probe_rel=float(max(abs(qs[0]/qs[1]-1))),
            q_window_rel=float(max(np.ptp(qs, axis=1))/qs.mean()))
        result['field_stable'] = bool(all(result[key+'_rel'] <= GATES[key] for key in
            ('f_probe', 'f_window', 'q_probe', 'q_window'))
            and max(v['relative_residual'] for v in poles) <= GATES['residual']
            and all(v['order_stable'] for v in poles))
    return result


def analyse(out):
    """Read-only replay; a passed pole is not whole-example qualification."""
    out = Path(out)
    admission = json.loads((out/'admission.json').read_text(encoding='utf-8'))
    capture = out/'field'
    meta = json.loads((capture/'report.json').read_text(encoding='utf-8'))
    for path, key in ((capture/'report.json', 'report_sha256'),
                      (out/'field.log', 'log_sha256'), (out/'field.runner.json', 'runner_sha256'),
                      (out/'setup/report.json', 'setup_sha256')):
        if opened.sha(path) != admission[key]:
            raise ValueError('closing report/log/receipt changed')
    if admission['pilot_only']:
        raise ValueError('timing pilot cannot qualify a pole')
    if (meta['source_sha256'] != identity() or meta['runtime'] != runtime_identity()
            or meta['gates'] != GATES):
        raise ValueError('source/runtime/protocol changed; retain separate epochs')
    _, expected = build(meta['n'], meta['cap_s'])
    expected = json.loads(json.dumps(expected))
    if any(meta[k] != expected[k] for k in expected):
        raise ValueError('model parameters changed')
    for name, digest in {**meta['raw_sha256'], '../input.xml': meta['input_sha256'],
                          '../data.npz': meta['data_sha256']}.items():
        if opened.sha(capture/'raw'/name) != digest:
            raise ValueError('raw/input/data changed')
    native, run = meta['native'], meta['run']
    receipt = json.loads((out/'field.runner.json').read_text(encoding='utf-8'))
    with np.load(capture/'data.npz') as data:
        t = data['t']
        result = extract(t, data['u'])
        stride = native['dt_s']*meta['probe_stride_steps']
        result['probe_clock_ok'] = bool(np.isfinite(t).all() and np.all(np.diff(t) > 0)
            and np.max(abs(np.diff(t)/stride-1)) < 1e-6
            and t[-1] <= native['numerical_time_s']+2*native['dt_s'])
        proxy = None
        if result['field_stable']:
            try:
                proxy = energy_proxy(data['energy_rows'], native['dt_s'], result['f_hz'], result['q'])
            except ValueError as exc:
                result['errors'].append(str(exc))
    result.update(n=meta['n'], scope=SCOPE, reference=meta['reference'], energy_proxy=proxy,
        natural_stop=bool(run.get('converged') and native['timesteps'] < meta['max_timesteps']
                          and native['numerical_time_s'] > meta['source_duration_s']),
        grid_clock_ok=bool(native['cells'] == meta['native_cells']
                          and abs(native['dt_s']/DT_S-1) < 1e-8),
        owned_deadline_ok=bool(receipt['exit_code'] == 0 and receipt['error'] is None
            and max(receipt['monotonic_seconds'], receipt['wall_seconds']) <= receipt['limit_seconds'] <= 2700),
        qualified=False, open_example_qualified=False)
    result['completed_pole_control'] = bool(result['field_stable'] and result['probe_clock_ok']
        and result['natural_stop'] and result['grid_clock_ok'] and result['owned_deadline_ok']
        and proxy and proxy['passed'])
    if result.get('q'):
        result.update(f_reference_rel=float(abs(result['f_hz']/meta['reference']['f_hz']-1)),
                      q_reference_rel=float(abs(result['q']/meta['reference']['q']-1)))
    return result


def study(out):
    rows = [analyse(Path(out)/f'n{n}') for n in MESHES]
    changes = [dict(f_rel=abs(b['f_hz']/a['f_hz']-1), q_rel=abs(b['q']/a['q']-1))
               for a, b in zip(rows, rows[1:])] if all(v.get('q') for v in rows) else []
    passed = bool(len(changes) == 2 and all(v['completed_pole_control'] for v in rows)
        and all(v['f_reference_rel'] <= GATES['f_reference']
                and v['q_reference_rel'] <= GATES['q_reference'] for v in rows)
        and all(v['f_rel'] <= GATES['f_mesh'] and v['q_rel'] <= GATES['q_mesh'] for v in changes)
        and all(changes[1][key] <= changes[0][key] for key in ('f_rel', 'q_rel')))
    return dict(scope=SCOPE, meshes=rows, changes=changes, pmc_mesh_and_reference_pass=passed,
        qualified=False, open_example_qualified=False,
        limitation='Axial-tail, angle and time-step independence are not established by this mesh cohort.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    for name in ('plan', 'fdtd', 'analyse', 'study'):
        action.add_argument('--'+name, action='store_true')
    action.add_argument('--worker', choices=('setup', 'field'), help=argparse.SUPPRESS)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--mesh', type=int, choices=MESHES, default=16)
    parser.add_argument('--rate-mcps', type=float, default=10.)
    parser.add_argument('--cap-ns', type=float, default=1000., help=argparse.SUPPRESS)
    parser.add_argument('--pilot', action='store_true')
    args = parser.parse_args()
    if args.worker:
        worker(args.out, args.mesh, args.cap_ns/1e9, setup=args.worker == 'setup')
        return
    if args.plan:
        _, meta = build(args.mesh, 90e-9 if args.pilot else CAP_S)
        result = dict(**meta, estimated_seconds=forecast(meta, args.rate_mcps), qualified=False)
    elif args.fdtd:
        result = acquire_serial(args.out, args.mesh, args.rate_mcps, args.pilot)
    elif args.analyse:
        result = analyse(args.out)
    else:
        result = study(args.out)
    print(json.dumps(result, indent=2, allow_nan=False), flush=True)


if __name__ == '__main__':
    main()
