"""Own full-cross-section dielectric interface, associated with Example 4.2 (p. 171).

The transverse TE10 profile is unchanged at this uniform interface. References
come from tangential E/H continuity, with real, frequency-dependent modal power
normalization. Higher modes are not excluded by cutoff in the filled half, but
orthogonality forbids their coupling in this ideal geometry. No probe, material
or port production code is changed. Data and generated inputs stay outside Git.
"""
from importlib.metadata import PackageNotFoundError, version
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

import numpy as np

from fairbeam import Simulation
from fairbeam import simulation as simulation_module
from fairbeam.simulation import excite_only

C0, ETA0 = 299792458., 376.730313668
A, B, ER, PLANE = 22.86, 10.16, 2.54, 20.  # mm, relative permittivity
FREQUENCIES = np.linspace(9.8e9, 10.2e9, 41)
MESHES, PADDING, CONTROL_PADDING = (40, 50, 60), 16, 24
CONTROL_MESH = MESHES[1]
LIMITS = dict(target_abs=.01, mesh_abs=.003, boundary_abs=.002,
              reciprocity_abs=.002, power_abs=.01)
PROTOCOL = 'uniform-te10-dielectric-step-v3'
CASE_SECONDS = 1800.
END_DB, PULSE_END_S = -90., 9/(np.pi*2e8)
PULSES = ('gaussian', 'zero-integral-rf')
TERMINATIONS = ('PML_8', 'MUR')
MUR_HOLD = dict(duration_s=60e-9, end_db=-150., late_energy_db=END_DB, wave_abs=.002)


def controls(pulse, termination):
    if pulse not in PULSES or termination not in TERMINATIONS:
        raise ValueError('unsupported research pulse or termination')
    if termination == 'MUR' and pulse != 'gaussian':
        raise ValueError('the MUR control currently requires the unchanged Gaussian source')


def physical_input_sha(path):
    """Exclude only randomly assigned display colors from the input identity."""
    root = ET.parse(path).getroot()
    for parent in root.iter():
        for child in list(parent):
            if child.tag in ('FillColor', 'EdgeColor'):
                parent.remove(child)
    return hashlib.sha256(ET.tostring(root)).hexdigest()


def rf_expression():
    """Finite RF pulse: d[w(t) sin(omega*(t-center))/omega]/dt.

    w and w' vanish at both endpoints, so the continuous integral is zero.
    This is a same-band control, not an assertion of exactly zero native DC.
    """
    center, alpha, omega = PULSE_END_S/2, (2*np.pi*2e8/3)**2, 2*np.pi*1e10
    edge = np.exp(-alpha*center**2)
    x = f'(t-{center:.17g})'
    g = f'exp(-{alpha:.17g}*{x}^2)'
    w = f'({g}-{edge:.17g}*(1+{alpha*center**2:.17g}-{alpha:.17g}*{x}^2))'
    prime = f'(-2*{alpha:.17g}*{x}*({g}-{edge:.17g}))'
    return (f'if(t>0,if(t<{PULSE_END_S:.17g},'
            f'{w}*cos({omega:.17g}*{x})+{prime}/{omega:.17g}*sin({omega:.17g}*{x}),0),0)')


def rf_values(t):
    t = np.asarray(t, float)
    center, alpha, omega = PULSE_END_S/2, (2*np.pi*2e8/3)**2, 2*np.pi*1e10
    x = t-center
    edge, g = np.exp(-alpha*center**2), np.exp(-alpha*x*x)
    w, prime = g-edge*(1+alpha*center**2-alpha*x*x), -2*alpha*x*(g-edge)
    return np.where((t > 0) & (t < PULSE_END_S), w*np.cos(omega*x)+prime/omega*np.sin(omega*x), 0.)


def rf_source_audit(raw, dt, max_steps=200000):
    """Check both native source caches, including the allocated zero tail.

    Custom caches span the allocation; active support is recorded separately.
    Text-cache rounding limits the measured DC statement to stored precision.
    """
    if not np.isfinite(dt) or dt <= 0 or max_steps*dt <= PULSE_END_S:
        raise ValueError('positive native clock and complete allocated RF support required')
    records = {}
    for name, offset in (('et', 0.), ('ht', .5)):
        path = Path(raw)/name
        a = np.loadtxt(path, ndmin=2)
        t = (np.arange(max_steps)+offset)*dt
        if (a.shape != (max_steps, 2) or not np.isfinite(a).all()
                or not np.allclose(a[:, 0], t, rtol=6e-6, atol=dt*1e-5)):
            raise ValueError('RF source cache is incomplete or has a changed clock')
        want = rf_values(t)
        want[0] = 0.  # Native E/H caches both initialize their first value to zero.
        error = float(abs(a[:, 1]-want).max()/abs(want).max())
        if error > 6e-6 or np.any(a[t >= PULSE_END_S, 1] != 0):
            raise ValueError('RF source waveform or allocated zero tail changed')
        frequencies = np.r_[0., 3.7e9, 6.56e9, FREQUENCIES]
        spectrum = np.array([abs(np.sum(a[:, 1]*np.exp(-2j*np.pi*freq*t))) for freq in frequencies])
        spectrum /= spectrum[23]  # 10 GHz, the center of the 41-point RF grid.
        if (not np.isfinite(spectrum).all() or spectrum[:3].max() > 1e-4
                or spectrum[3:].min() < .05 or np.argmax(spectrum[3:]) not in range(15, 26)):
            raise ValueError('RF source lacks the same-band spectrum')
        records[name] = dict(sha256=hashlib.sha256(path.read_bytes()).hexdigest(), samples=len(a),
            waveform_error_relative=error, signed_sum_over_l1=float(np.sum(a[:, 1])/np.sum(abs(a[:, 1]))),
            spectrum_relative_to_10ghz=spectrum.tolist())
    return dict(active_support_s=PULSE_END_S, complete_after_steps=int(np.ceil(PULSE_END_S/dt))+1,
                allocated_cache_steps=max_steps, records=records)


def source_ids():
    paths = dict(fixture=Path(__file__),
                 runner=Path(__file__).with_name('test_waveguide_step.py'),
                 simulation=Path(simulation_module.__file__))
    return {k: hashlib.sha256(v.read_bytes()).hexdigest() for k, v in paths.items()}


def geometry():
    return dict(a_mm=A, b_mm=B, right_eps_r=ER, mu_r=1.,
                measurement_planes_mm=[-PLANE, PLANE], interface_mm=0.)


def modes(f=FREQUENCIES, eps_r=ER):
    f = np.asarray(f, float)
    if (f.ndim != 1 or not len(f) or not np.isfinite(f).all()
            or not np.isfinite(eps_r) or eps_r <= 0):
        raise ValueError('finite frequency array and positive filling required')
    k0 = 2*np.pi*f/C0
    beta2 = np.stack([k0**2-(np.pi/(A*1e-3))**2,
                      eps_r*k0**2-(np.pi/(A*1e-3))**2])
    if np.any(f <= 0) or np.any(beta2 <= 0):
        raise ValueError('both TE10 references must be above cutoff')
    beta = np.sqrt(beta2)
    return beta, ETA0*k0/beta


def reference(f=FREQUENCIES, eps_r=ER):
    beta, z = modes(f, eps_r)
    rho = (z[1]-z[0])/(z[1]+z[0])
    tau = 2*np.sqrt(z[0]*z[1])/(z[0]+z[1])
    s = np.empty((len(beta[0]), 2, 2), complex)
    s[:, 0, 0] = rho*np.exp(-2j*beta[0]*PLANE*1e-3)
    s[:, 1, 1] = -rho*np.exp(-2j*beta[1]*PLANE*1e-3)
    s[:, 0, 1] = s[:, 1, 0] = tau*np.exp(-1j*beta.sum(axis=0)*PLANE*1e-3)
    return s


def build(cpw, excited, padding=PADDING, *, pulse='gaussian', termination='PML_8'):
    if (isinstance(cpw, bool) or not isinstance(cpw, int) or cpw not in range(10, 81, 10)
            or isinstance(excited, bool) or excited not in (1, 2)
            or isinstance(padding, bool) or not isinstance(padding, int) or padding < 16):
        raise ValueError('cpw=10..80 by ten, port=1/2 and padding>=16 required')
    controls(pulse, termination)
    sim = Simulation(FREQUENCIES[0], FREQUENCIES[-1], excitation='gauss',
        boundaries=['PEC']*4+[termination]*2, end_criteria_db=END_DB, max_timesteps=200000)
    if pulse == 'zero-integral-rf':
        expression = rf_expression()
        sim.fdtd.SetCustomExcite(expression, 1e10, float(FREQUENCIES[-1]))
        sim.excitation = dict(type=pulse, f0=1e10, fc=2e8, active_support_s=PULSE_END_S,
                              expression=expression, f_min=float(FREQUENCIES[0]), f_max=float(FREQUENCIES[-1]))
    step = C0/FREQUENCIES[-1]/np.sqrt(ER)/sim.unit/cpw
    for axis, size in (('x', A), ('y', B)):
        count = 2*int(np.ceil(size/step/2))
        sim.mesh.AddLine(axis, np.linspace(-size/2, size/2, count+1))
    count = int(np.ceil(PLANE/step))
    z = PLANE/count*np.arange(-count-padding, count+padding+1)
    z[padding], z[-padding-1] = -PLANE, PLANE
    sim.mesh.AddLine('z', z)
    right = sim.dielectric('right_filling', ER)
    right.AddBox([-A/2, -B/2, 0], [A/2, B/2, z[-1]], priority=1)
    with excite_only(excited):
        for pn, source, plane, eps in ((1, z[padding-2], -PLANE, 1.),
                                       (2, z[-padding+1], PLANE, ER)):
            sim.waveguide_port(pn, [-A/2, -B/2, source], [A/2, B/2, plane],
                               'z', A, B, eps_r=eps)
    return sim


def acquire(out, cpw, excited, padding=PADDING, *, pulse='gaussian', termination='PML_8', hold_seed=None):
    controls(pulse, termination)
    if termination == 'MUR':
        return acquire_mur(out, cpw, excited, padding, hold_seed=hold_seed)
    if hold_seed is not None:
        raise ValueError('a continuation seed requires the MUR control')
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sim = build(cpw, excited, padding, pulse=pulse)
    if pulse != 'gaussian':
        sim.fdtd.Write2XML(str(out/'input.xml'))
    sim.run(str(out/'raw'), threads=4, exact=True, echo=True,
            **({'dump_statistics': True} if pulse != 'gaussian' else {}))
    sim.evaluate(n_freq=len(FREQUENCIES))
    ports = sim._port_objs
    z = np.array([np.broadcast_to(p.Z_ref, FREQUENCIES.shape) for p in ports])
    a = np.array([p.uf_inc for p in ports])/np.sqrt(z)
    b = np.array([p.uf_ref for p in ports])/np.sqrt(z)
    np.savez_compressed(out/'data.npz', f=FREQUENCIES, a=a, b=b, z_ref=z,
        voltage=np.array([p.uf_tot for p in ports]), current=np.array([p.if_tot for p in ports]))
    excitation = np.loadtxt(out/'raw/et')
    dt = float(np.diff(excitation[:2, 0])[0])
    versions = {}
    for package in ('openEMS', 'CSXCAD'):
        try:
            versions[package] = version(package)
        except PackageNotFoundError:
            versions[package] = 'unavailable; see native log'
    meta = dict(protocol=PROTOCOL, geometry=geometry(), cpw=cpw, excited=excited,
        padding=padding, frequency_hz=FREQUENCIES.tolist(), limits=LIMITS,
        cells=int(np.prod([len(sim.mesh.GetLines(ax))-1 for ax in 'xyz'])),
        dt_s=dt, excitation_timesteps=len(excitation), source_ids=source_ids(), excitation=sim.excitation,
        runtime_versions=versions, run=sim.run_stats)
    if pulse != 'gaussian':
        stats = np.loadtxt(out/'raw/openEMS_stats.txt', comments='%')
        dt = float(stats[1])
        meta.update(dt_s=dt, pulse=pulse, input_sha256=hashlib.sha256((out/'input.xml').read_bytes()).hexdigest(),
            physical_input_sha256=physical_input_sha(out/'input.xml'),
            data_sha256=hashlib.sha256((out/'data.npz').read_bytes()).hexdigest(),
            native_stats_sha256=hashlib.sha256((out/'raw/openEMS_stats.txt').read_bytes()).hexdigest(),
            native=dict(cells=int(stats[0]), dt_s=dt, timesteps=int(stats[2]),
                        numerical_time_s=float(stats[3]), iteration_wall_s=float(stats[4])),
            source_audit=rf_source_audit(out/'raw', dt))
    (out/'report.json').write_text(json.dumps(meta, indent=2)+'\n', encoding='utf-8')
    return meta


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _save(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False)+'\n', encoding='utf-8')


def mur_ids():
    root = Path(__file__).resolve().parents[1]
    names = ('fairbeam/multiport.py', 'fairbeam/procutil.py',
             'tests/coupled_stripline_fixture.py', 'tests/test_coax_resonator.py')
    return dict(**source_ids(), **{n: _sha(root/n) for n in names})


def _mur_runtime():
    from tests.coupled_stripline_fixture import runtime_identity
    return runtime_identity()


def _native_stats(raw):
    values = np.loadtxt(Path(raw)/'openEMS_stats.txt', comments='%')
    if values.shape != (6,) or not np.isfinite(values).all():
        raise ValueError('complete finite native statistics required')
    return dict(cells=int(values[0]), dt_s=float(values[1]), timesteps=int(values[2]),
                numerical_time_s=float(values[3]), iteration_wall_s=float(values[4]))


def _gaussian_cache(raw, dt):
    if not np.isfinite(dt) or dt <= 0:
        raise ValueError('positive Gaussian native clock required')
    records = {}
    for name, offset in (('et', 0.), ('ht', .5)):
        path = Path(raw)/name
        values = np.loadtxt(path, ndmin=2)
        if (values.shape[1] != 2 or not np.isfinite(values).all() or not np.any(values[:, 1])
                or abs(len(values)-int(np.ceil(PULSE_END_S/dt))) > 1
                or not np.allclose(values[:, 0], (np.arange(len(values))+offset)*dt,
                                   rtol=6e-6, atol=dt*1e-5)):
            raise ValueError('incomplete Gaussian cache or changed clock')
        records[name] = dict(sha256=_sha(path), samples=len(values))
    return dict(records=records, complete_after_steps=int(np.ceil(PULSE_END_S/dt))+1)


def _mur_data(sim, raw):
    sim.sim_path = str(raw)
    sim.evaluate(n_freq=len(FREQUENCIES))
    ports = sim._port_objs
    z = np.array([np.broadcast_to(p.Z_ref, FREQUENCIES.shape) for p in ports])
    return dict(f=FREQUENCIES, z_ref=z, a=np.array([p.uf_inc for p in ports])/np.sqrt(z),
                b=np.array([p.uf_ref for p in ports])/np.sqrt(z),
                voltage=np.array([p.uf_tot for p in ports]), current=np.array([p.if_tot for p in ports]))


def _mur_sim(cpw, excited, padding, seed=None):
    sim = build(cpw, excited, padding, termination='MUR')
    if seed is not None:
        if seed['native']['numerical_time_s'] >= MUR_HOLD['duration_s']:
            raise ValueError('the fixed continuation window does not extend beyond the primary run')
        steps = int(np.ceil(MUR_HOLD['duration_s']/seed['native']['dt_s']))
        sim.fdtd.SetNumberOfTimeSteps(steps)
        sim.max_timesteps = steps
        sim.fdtd.SetEndCriteria(10**(MUR_HOLD['end_db']/10))
        sim.end_criteria_db = MUR_HOLD['end_db']
    return sim


def acquire_mur(out, cpw, excited, padding=PADDING, *, hold_seed=None):
    seed_path = None if hold_seed is None else Path(hold_seed)
    seed = None if seed_path is None else load_mur_record(seed_path, cpw, excited, padding)[0]
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    ids, runtime = mur_ids(), _mur_runtime()
    sim = _mur_sim(cpw, excited, padding, seed)
    sim.fdtd.Write2XML(str(out/'input.xml'))
    sim.run(str(out/'raw'), threads=4, exact=True, echo=True, dump_statistics=True)
    native = _native_stats(out/'raw')
    data = _mur_data(sim, out/'raw')
    if not all(np.isfinite(v).all() for v in data.values()):
        raise ValueError('finite native port spectra required')
    np.savez_compressed(out/'data.npz', **data)
    probe_names = {n for p in sim._port_objs for n in tuple(p.U_filenames)+tuple(p.I_filenames)}
    meta = dict(protocol='te10-mur-control-v1', kind='primary' if seed is None else 'hold60ns',
        termination='MUR', pulse='gaussian', cpw=cpw, excited=excited, padding=padding,
        geometry=geometry(), frequency_hz=FREQUENCIES.tolist(), limits=LIMITS, hold_limits=MUR_HOLD,
        source_ids=source_ids(), mur_source_ids=ids, runtime=runtime, native=native, run=sim.run_stats,
        max_timesteps=sim.max_timesteps, native_end_db=sim.end_criteria_db,
        cache=_gaussian_cache(out/'raw', native['dt_s']),
        input_sha256=_sha(out/'input.xml'), physical_input_sha256=physical_input_sha(out/'input.xml'),
        data_sha256=_sha(out/'data.npz'), native_stats_sha256=_sha(out/'raw/openEMS_stats.txt'),
        probe_sha256={n: _sha(out/'raw'/n) for n in sorted(probe_names)},
        seed_report_sha256=None if seed_path is None else _sha(seed_path/'report.json'),
        qualified_scope=False)
    if ids != mur_ids() or runtime != _mur_runtime():
        raise ValueError('capture source/runtime changed')
    _save(out/'report.json', meta)
    return meta


def load_mur_record(path, cpw, excited, padding, *, seed_path=None):
    """Replay one source-pinned MUR record; a primary stop alone is insufficient."""
    path = Path(path)
    meta = json.loads((path/'report.json').read_text(encoding='utf-8'))
    seed = None if seed_path is None else load_mur_record(seed_path, cpw, excited, padding)[0]
    expected = dict(protocol='te10-mur-control-v1', kind='primary' if seed is None else 'hold60ns',
        termination='MUR', pulse='gaussian', cpw=cpw, excited=excited, padding=padding,
        geometry=geometry(), frequency_hz=FREQUENCIES.tolist(), limits=LIMITS, hold_limits=MUR_HOLD,
        source_ids=source_ids(), mur_source_ids=mur_ids(), runtime=_mur_runtime(),
        seed_report_sha256=None if seed is None else _sha(Path(seed_path)/'report.json'))
    if any(meta.get(k) != v for k, v in expected.items()):
        raise ValueError('MUR record source/runtime/model/seed identity mismatch')
    native, run = _native_stats(path/'raw'), meta['run']
    if meta.get('native') != native:
        raise ValueError('MUR native statistics changed')
    durations = [run.get('wall_time_s'), meta.get('case_elapsed_s')]
    if (run.get('threads') != 4 or run.get('engine') != 'cpu' or run.get('exact_endcriteria') is not True
            or native['timesteps'] != run.get('timesteps') or native['cells'] != int(np.prod(run.get('grid', [])))
            or not 0 < native['dt_s'] or not 0 < native['timesteps'] <= meta['max_timesteps']
            or any(isinstance(t, bool) or not isinstance(t, (int, float)) or not np.isfinite(t)
                   or not 0 < t <= CASE_SECONDS for t in durations)
            or not np.isclose(native['numerical_time_s'], native['timesteps']*native['dt_s'], rtol=1e-8, atol=0)):
        raise ValueError('MUR native execution or deadline mismatch')
    if seed is None:
        energy = [run[k] for k in ('final_energy_db', 'final_energy_bound_db')
                  if isinstance(run.get(k), (int, float)) and not isinstance(run[k], bool) and np.isfinite(run[k])]
        if (run.get('converged') is not True or run.get('hit_timestep_limit') is not False
                or native['timesteps'] >= 200000 or not energy or max(energy) > END_DB+1e-9):
            raise ValueError('MUR primary lacks an exact native stop')
    sim = _mur_sim(cpw, excited, padding, seed)
    if meta.get('max_timesteps') != sim.max_timesteps or meta.get('native_end_db') != sim.end_criteria_db:
        raise ValueError('MUR time allocation or criterion changed')
    import tempfile
    with tempfile.TemporaryDirectory() as folder:
        rebuilt = Path(folder)/'input.xml'
        sim.fdtd.Write2XML(str(rebuilt))
        if physical_input_sha(rebuilt) != meta.get('physical_input_sha256'):
            raise ValueError('rebuilt MUR physical input changed')
    for rel, key in (('input.xml', 'input_sha256'), ('data.npz', 'data_sha256'),
                     ('raw/openEMS_stats.txt', 'native_stats_sha256')):
        if _sha(path/rel) != meta.get(key):
            raise ValueError('MUR input/data/statistics hash changed')
    receipt = json.loads(path.with_name(path.name+'.worker.json').read_text(encoding='utf-8'))
    if (receipt.get('exit_code') != 0 or receipt.get('failure') is not None
            or receipt.get('deadline_seconds') != CASE_SECONDS or receipt.get('source') != meta['mur_source_ids']
            or any(not isinstance(receipt.get(k), (int, float)) or isinstance(receipt[k], bool)
                   or not np.isfinite(receipt[k]) or not 0 < receipt[k] <= CASE_SECONDS
                   for k in ('wall_seconds', 'monotonic_seconds'))):
        raise ValueError('MUR owned-worker receipt changed or exceeded its deadline')
    replay = _mur_data(sim, path/'raw')
    names = {n for p in sim._port_objs for n in tuple(p.U_filenames)+tuple(p.I_filenames)}
    if meta.get('probe_sha256') != {n: _sha(path/'raw'/n) for n in sorted(names)}:
        raise ValueError('MUR raw port probes changed')
    with np.load(path/'data.npz') as archive:
        if set(archive.files) != set(replay) or any(not np.array_equal(archive[k], v) for k, v in replay.items()):
            raise ValueError('MUR raw-port replay differs from stored spectra')
    cache = _gaussian_cache(path/'raw', native['dt_s'])
    if cache != meta.get('cache') or native['timesteps'] < cache['complete_after_steps']:
        raise ValueError('MUR native Gaussian cache is incomplete or changed')
    return meta, replay


def mur_hold_checks(primary, before, hold, after):
    """Require the complete fixed window and no rebound after the primary stop."""
    native = hold['native']
    late = [r['db'] for r in hold['run']['energy_trace']
            if r['timestep']*native['dt_s'] > primary['native']['numerical_time_s']]
    scale = abs(before['a']).max(axis=0)
    if np.any(scale <= 0):
        raise ValueError('nonzero primary incident spectrum required')
    change = {k: float((abs(after[k]-before[k])/scale).max()) for k in ('a', 'b')}
    passed = (native['timesteps'] == hold['max_timesteps']
        and abs(native['numerical_time_s']-MUR_HOLD['duration_s']) <= native['dt_s']*1.001
        and native['dt_s'] == primary['native']['dt_s'] and native['cells'] == primary['native']['cells']
        and hold['cache'] == primary['cache'] and len(late) >= 3
        and all(np.isfinite(v) and v <= MUR_HOLD['late_energy_db']+1e-9 for v in late)
        and all(np.isfinite(v) and v <= MUR_HOLD['wave_abs'] for v in change.values()))
    return dict(passes=bool(passed), maximum_late_energy_db=max(late) if late else None,
                wave_change=change, limits=MUR_HOLD)


def read_mur_source(path, cpw, excited, padding):
    primary, before = load_mur_record(path, cpw, excited, padding)
    hold, after = load_mur_record(Path(path)/'hold60ns', cpw, excited, padding, seed_path=path)
    check = mur_hold_checks(primary, before, hold, after)
    if not check['passes']:
        raise ValueError('MUR continuation lacks complete, stable late-time evidence')
    return dict(primary=primary, hold=hold, temporal_check=check), before
