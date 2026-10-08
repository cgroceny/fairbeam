"""Opt-in ideal TEM tapered-line research: Example 5.8, p. 265.

Our exponential, triangular and Klopfenstein profiles are parameterized by
normalized travel time. Positive scalar dielectrics between fixed PEC/PMC
plates realize that coordinate, not a PCB taper or a Designer measurement.
The small-reflection formulas and full nonuniform-line reference stay separate.
Primary profile references (equations only, no third-party code):
https://rcvt.tu-sofia.bg/ICEST2006_12.pdf
https://qnn-rle.mit.edu/wp-content/uploads/2020/05/thesisPhDDi_Zhu_MIT.pdf
"""
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

import numpy as np
from openEMS import ports as native_ports
from openEMS.ports import UI_data
from openEMS.physical_constants import C0, EPS0, MUE0

from fairbeam import Simulation, excitation, simulation
from fairbeam.procutil import popen_group, release_group, terminate_group

F0, Z_LEFT, Z_RIGHT, GAMMA_MAX = 10e9, 100., 50., .02
DELAY = 1/F0
GAMMA_0 = .5*np.log(Z_RIGHT/Z_LEFT)
A = float(np.arccosh(abs(GAMMA_0)/GAMMA_MAX))
PROFILES = ('exponential', 'triangular', 'klopfenstein')
# Spatial meshes retain 128 slices; profile refinement is separate at n12.
MESHES, SLICE_LEVELS, DEFAULT_SLICES = (8, 12, 16), (64, 128, 256), 128
KINDS = ('line100', 'line50', 'taper')
landmarks = [A, *[k*np.pi for k in range(1, 5)],
    *[np.sqrt(A*A+(k*np.pi)**2) for k in range(1, 5)],
    *[np.sqrt(A*A+((k+.5)*np.pi)**2) for k in range(4)]]
THETA = np.unique(np.r_[np.linspace(.5, 4*np.pi, 401),
    [v for v in landmarks if .5 <= v <= 4*np.pi]])
FREQUENCIES = THETA/(2*np.pi*DELAY)
SAMPLE_INDICES = tuple(int(np.argmin(abs(THETA-v))) for v in (.5, np.pi, 2*np.pi, 3*np.pi, 4*np.pi))
H = .75
W = np.sqrt(MUE0/EPS0)*H/Z_LEFT
PROTOCOL, END_DB, THREADS = 'tem-taper-v2', -110., 1
CAP_NS, CASE_SECONDS = 4., 1800.
LIMITS = dict(s_target_abs=.02, gamma_target_abs=.01, z_target_rel=.02,
    continuum_s_target_abs=.002, continuum_gamma_target_abs=.001,
    continuum_z_target_rel=.005, s_mesh_abs=.003, gamma_mesh_abs=.002,
    z_mesh_rel=.005, s_boundary_abs=.001, gamma_boundary_abs=.001,
    z_boundary_rel=.002, s_profile_abs=.001, gamma_profile_abs=.0005,
    z_profile_rel=.002, power_abs=.01, reciprocity_abs=.002,
    plane_spread_abs=.002, calibration_beta_rel=.005, calibration_z_rel=.005,
    calibration_spread_rel=.002, calibration_transfer_abs=.002,
    current_strip_spread_rel=.002)


def profile_check(profile):
    if profile not in PROFILES:
        raise ValueError('declared exponential, triangular or Klopfenstein profile required')


def slice_check(slices):
    if isinstance(slices, bool) or not isinstance(slices, int) or slices not in SLICE_LEVELS:
        raise ValueError('declared integer profile slice count required')


def _i1_over_z(z):
    """Own convergent power series, including the removable singularity at zero."""
    z = np.asarray(z, float)
    term = np.full(z.shape, .5)
    total = term.copy()
    for k in range(1, 40):
        term = term*z*z/(4*k*(k+1))
        total += term
        if np.max(abs(term)) < 1e-17:
            return total
    raise ValueError('Bessel series failed to converge')


@lru_cache(maxsize=1)
def _quadrature():
    return np.polynomial.legendre.leggauss(32)


def phi(y):
    """Integral of I1(A sqrt(1-t²))/(A sqrt(1-t²)), from 0 to y."""
    y = np.asarray(y, float)
    if not np.isfinite(y).all() or np.any(abs(y) > 1):
        raise ValueError('finite integral coordinates inside [-1,1] required')
    nodes, weights = _quadrature()
    t = y[..., None]*(nodes+1)/2
    return y/2*np.sum(weights*_i1_over_z(A*np.sqrt(1-t*t)), axis=-1)


def impedance(profile, u):
    """Continuous interior impedance; Klopfenstein endpoint steps are retained."""
    profile_check(profile)
    u = np.asarray(u, float)
    if not np.isfinite(u).all() or np.any((u < 0) | (u > 1)):
        raise ValueError('finite normalized travel-time coordinates in [0,1] required')
    if profile == 'klopfenstein':
        return np.sqrt(Z_LEFT*Z_RIGHT)*np.exp(GAMMA_0*A*A/np.cosh(A)*phi(2*u-1))
    shape = u if profile == 'exponential' else np.where(u <= .5, 2*u*u, 1-2*(1-u)**2)
    return Z_LEFT*np.exp(np.log(Z_RIGHT/Z_LEFT)*shape)


@lru_cache(maxsize=9, typed=True)
def sections(profile, slices=DEFAULT_SLICES):
    profile_check(profile)
    slice_check(slices)
    values = impedance(profile, (np.arange(slices)+.5)/slices)
    values.setflags(write=False)
    return values


def dimensions(profile, slices=DEFAULT_SLICES):
    lengths = C0*DELAY*1e3*sections(profile, slices)/(Z_LEFT*slices)
    return lengths, np.r_[0., np.cumsum(lengths)]


def targets(profile, slices=DEFAULT_SLICES):
    return np.array([0., dimensions(profile, slices)[1][-1]])


def planes(profile, slices=DEFAULT_SLICES):
    return ((-8., -6.), tuple(targets(profile, slices)[1]+np.array([6., 8.])))


def sources(profile, slices=DEFAULT_SLICES):
    return (-15., targets(profile, slices)[1]+15.)


def port_spec(kind):
    if kind == 'line100':
        return np.array([Z_LEFT, Z_LEFT])
    if kind == 'line50':
        return np.array([Z_RIGHT, Z_RIGHT])
    if kind == 'taper':
        return np.array([Z_LEFT, Z_RIGHT])
    raise ValueError('declared uniform control or taper required')


def _power_waves(matrix, refs):
    a, b, c, d = (matrix[:, i, j] for i, j in ((0, 0), (0, 1), (1, 0), (1, 1)))
    zl, zr = refs
    den = a*zr+b+c*zl*zr+d*zl
    s = np.empty_like(matrix)
    s[:, 0, 0] = (a*zr+b-c*zl*zr-d*zl)/den
    s[:, 1, 1] = (-a*zr+b-c*zl*zr+d*zl)/den
    s[:, 0, 1] = 2*np.sqrt(zl*zr)*(a*d-b*c)/den
    s[:, 1, 0] = 2*np.sqrt(zl*zr)/den
    return s


def reference(profile, kind, slices=DEFAULT_SLICES, freq=FREQUENCIES):
    """Exact cascade for the declared piecewise-constant physical realization."""
    profile_check(profile)
    freq = np.asarray(freq, float)
    if freq.ndim != 1 or not freq.size or not np.isfinite(freq).all() or np.any(freq <= 0):
        raise ValueError('finite positive frequency vector required')
    refs = port_spec(kind)
    if kind == 'taper':
        impedances, delays = sections(profile, slices), np.full(slices, DELAY/slices)
    else:
        impedances = [refs[0]]
        delays = [targets(profile, slices)[1]*1e-3/C0*Z_LEFT/refs[0]]
    matrix = np.broadcast_to(np.eye(2, dtype=complex), (len(freq), 2, 2)).copy()
    for z, delay in zip(impedances, delays):
        theta = 2*np.pi*freq*delay
        step = np.empty_like(matrix)
        step[:, 0, 0] = step[:, 1, 1] = np.cos(theta)
        step[:, 0, 1], step[:, 1, 0] = 1j*z*np.sin(theta), 1j*np.sin(theta)/z
        matrix = matrix@step
    return _power_waves(matrix, refs)


@lru_cache(maxsize=6, typed=True)
def continuum_reference(profile, steps=2048):
    """Own RK4 integration of M'=M j theta [[0,Z],[1/Z,0]], M(0)=I."""
    profile_check(profile)
    if isinstance(steps, bool) or not isinstance(steps, int) or steps < 128:
        raise ValueError('integer integration step count >=128 required')
    z = impedance(profile, np.linspace(0., 1., 2*steps+1))
    h, phase = 1/steps, 1j*THETA
    matrix = np.broadcast_to(np.eye(2, dtype=complex), (len(THETA), 2, 2)).copy()
    def derivative(value, value_z):
        out = np.empty_like(value)
        out[:, :, 0] = value[:, :, 1]*(phase/value_z)[:, None]
        out[:, :, 1] = value[:, :, 0]*(phase*value_z)[:, None]
        return out
    for k in range(steps):
        a = derivative(matrix, z[2*k])
        b = derivative(matrix+h*a/2, z[2*k+1])
        c = derivative(matrix+h*b/2, z[2*k+1])
        d = derivative(matrix+h*c, z[2*k+2])
        matrix += h*(a+2*b+2*c+d)/6
    s = _power_waves(matrix, port_spec('taper'))
    s.setflags(write=False)
    return s


def small_reflection(profile):
    """Approximate formulas, never used as exact nonlinear-line targets."""
    profile_check(profile)
    if profile == 'exponential':
        shape = np.sinc(THETA/np.pi)
    elif profile == 'triangular':
        shape = np.sinc(THETA/(2*np.pi))**2
    else:
        shape = np.cos(np.sqrt((THETA*THETA-A*A).astype(complex)))/np.cosh(A)
    return GAMMA_0*np.exp(-1j*THETA)*shape


def input_impedance(s, kind):
    s = np.asarray(s, complex)
    refs = port_spec(kind)
    if s.shape != (len(FREQUENCIES), 2, 2) or not np.isfinite(s).all():
        raise ValueError('finite complete two-port spectrum required')
    reflection = s[:, 0, 0]
    if np.any(abs(1-reflection) < 1e-8):
        raise ValueError('singular terminated input impedance')
    return refs[0]*(1+reflection)/(1-reflection), reflection


def mesh_lines(n, profile, expanded=False, slices=DEFAULT_SLICES):
    profile_check(profile)
    slice_check(slices)
    if isinstance(n, bool) or not isinstance(n, int) or n not in MESHES or not isinstance(expanded, bool):
        raise ValueError('declared integer mesh and boolean enclosure required')
    delta, length = H/n, targets(profile, slices)[1]
    margin = 35. if expanded else 25.
    anchors = [-margin, *sources(profile, slices), -1., length+1., length+margin, *dimensions(profile, slices)[1]]
    for centres in planes(profile, slices):
        for centre in centres:
            anchors.extend((centre-delta, centre, centre+delta))
    anchors = np.unique(anchors)
    x = np.concatenate([np.linspace(lo, hi, max(1, int(np.ceil((hi-lo)/delta-1e-11)))+1)[:-1]
        for lo, hi in zip(anchors[:-1], anchors[1:])]+[anchors[-1:]])
    return x, np.linspace(0., W, 5), delta*np.arange(n+2)


def time_settings(n, profile, expanded=False, slices=DEFAULT_SLICES):
    axes = mesh_lines(n, profile, expanded, slices)
    dt = min(float(np.min(np.diff(a))) for a in axes)*1e-3/(2*C0)
    return dt, int(np.ceil(CAP_NS*1e-9/dt))


def build(n, profile, kind, column=0, expanded=False, slices=DEFAULT_SLICES):
    refs = port_spec(kind)
    if isinstance(column, bool) or column not in (0, 1):
        raise ValueError('declared excitation column required')
    x, y, z = mesh_lines(n, profile, expanded, slices)
    if np.prod([len(a)-1 for a in (x, y, z)]) > 500000:
        raise ValueError('research cell budget exceeded')
    dt, steps = time_settings(n, profile, expanded, slices)
    sim = Simulation(float(FREQUENCIES[0]), float(FREQUENCIES[-1]), boundaries=['PML_8', 'PML_8', 'PMC', 'PMC', 'PEC', 'PEC'],
                     end_criteria_db=END_DB, max_timesteps=steps)
    for axis, lines in zip('xyz', (x, y, z)):
        sim.mesh.AddLine(axis, lines)
    sim.fdtd.SetTimeStep(dt)
    metal = sim.metal('plates')
    metal.AddBox([x[0], 0., 0.], [x[-1], W, 0.], priority=10)
    metal.AddBox([x[0], 0., H], [x[-1], W, z[-1]], priority=10)
    if kind == 'taper':
        edges = dimensions(profile, slices)[1]
        lo, hi = np.r_[x[0], edges[:-1], edges[-1]], np.r_[edges[0], edges[1:], x[-1]]
        epsilon = np.r_[1., (Z_LEFT/sections(profile, slices))**2, (Z_LEFT/Z_RIGHT)**2]
    else:
        lo, hi, epsilon = [x[0]], [x[-1]], [(Z_LEFT/refs[0])**2]
    for j, (start, stop, er) in enumerate(zip(lo, hi, epsilon)):
        sim.dielectric(f'dielectric{j}', float(er)).AddBox([start, 0., 0.], [stop, W, H], priority=1)
    for p in (0, 1):
        start, stop = (x[0], -1.) if p == 0 else (x[-1], targets(profile, slices)[1]+1.)
        sim.fdtd.AddMSLPort(p+1, metal, [start, 0., H], [stop, W, 0.], 'x', 'z',
            excite=-1 if p == column else 0, FeedShift=abs(start-sources(profile, slices)[p]),
            MeasPlaneShift=abs(start-planes(profile, slices)[p][0]), priority=10)
        for q, centre in enumerate(planes(profile, slices)[p]):
            ix = int(np.flatnonzero(x == centre)[0])
            for j, plane in enumerate(x[ix-1:ix+2]):
                sim.csx.AddProbe(f'v{p}_{q}_{j}', p_type=0).AddBox([plane, W/2, H], [plane, W/2, 0.])
            for j, plane in enumerate(((x[ix-1]+centre)/2, (centre+x[ix+1])/2)):
                for label, low, high in (('i', 1/8, 7/8), ('j', 3/8, 5/8)):
                    sim.csx.AddProbe(f'{label}{p}_{q}_{j}', p_type=1, norm_dir=0,
                        weight=1/(high-low)).AddBox([plane, low*W, H-H/(2*n)],
                            [plane, high*W, H+H/(2*n)])
    for prop in sim.csx.GetAllProperties():
        prop.SetColor((128, 128, 128), alpha=prop.GetFillColor()[3])
    return sim


def source_ids():
    paths = [Path(__file__), Path(__file__).with_name('test_taper.py'),
             Path(simulation.__file__), Path(excitation.__file__), Path(native_ports.__file__)]
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def identity(n, profile, kind, column, expanded, slices=DEFAULT_SLICES):
    dt, steps = time_settings(n, profile, expanded, slices)
    lengths, edges = dimensions(profile, slices)
    return dict(protocol=PROTOCOL, source_ids=source_ids(), mesh=n, profile=profile,
        slices=slices, kind=kind, column=column, expanded=expanded,
        frequency_hz=FREQUENCIES.tolist(), theta=THETA.tolist(), limits=LIMITS,
        reference_ohm=port_spec(kind).tolist(), height_mm=H, width_mm=W,
        section_ohm=sections(profile, slices).tolist(),
        section_eps_r=((Z_LEFT/sections(profile, slices))**2).tolist(),
        section_length_mm=lengths.tolist(), length_mm=float(edges[-1]),
        delay_s=DELAY, nominal_hz=F0, klopfenstein_a=A, reflection_limit=GAMMA_MAX,
        end_db=END_DB, threads=THREADS, requested_dt_s=dt, max_steps=steps)


def acquire(out, n, profile, kind, column=0, expanded=False, slices=DEFAULT_SLICES):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sim = build(n, profile, kind, column, expanded, slices)
    sim.fdtd.Write2XML(str(out/'input.xml'))
    (out/'protocol.json').write_text(json.dumps(identity(n, profile, kind, column, expanded, slices), indent=2)+'\n', encoding='utf-8')
    sim.run(str(out/'raw'), threads=THREADS, exact=True, echo=True, engine='cpu')
    if not sim.run_stats.get('timesteps'):
        raise RuntimeError('native acquisition did not start; inspect retained log')
    v = np.asarray(UI_data([f'v{p}_{q}_{j}' for p in range(2) for q in range(2) for j in range(3)],
                          str(out/'raw'), FREQUENCIES).ui_f_val).reshape(2, 2, 3, -1)
    i = np.asarray(UI_data([f'i{p}_{q}_{j}' for p in range(2) for q in range(2) for j in range(2)],
                          str(out/'raw'), FREQUENCIES).ui_f_val).reshape(2, 2, 2, -1)
    check = np.asarray(UI_data([f'j{p}_{q}_{j}' for p in range(2) for q in range(2) for j in range(2)],
                              str(out/'raw'), FREQUENCIES).ui_f_val).reshape(2, 2, 2, -1)
    np.savez_compressed(out/'data.npz', f=FREQUENCIES, v=v, i=i, i_check=check)
    dt = float(np.diff(np.loadtxt(out/'raw/et', max_rows=2)[:, 0])[0])
    if not np.isclose(dt, time_settings(n, profile, expanded, slices)[0], rtol=5e-6, atol=0):
        raise RuntimeError('native timestep differs from the declared conservative step')
    meta = dict(**identity(n, profile, kind, column, expanded, slices), run=sim.run_stats, dt_s=dt,
        cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
        pulse_end_s=excitation.dgauss_duration_s(sim.f_max),
        input_sha256=hashlib.sha256((out/'input.xml').read_bytes()).hexdigest())
    (out/'report.json').write_text(json.dumps(meta, indent=2)+'\n', encoding='utf-8')
    return meta


def clocks():
    return time.monotonic(), time.time()


def serial(out, n, profile, kind, column=0, expanded=False, slices=DEFAULT_SLICES):
    """Bound one owned worker; the deadline includes machine suspend time."""
    out = Path(out).resolve()
    if out.exists():
        raise ValueError('fresh acquisition directory required')
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, '-m', 'tests.test_taper', '--fdtd', '--worker',
        '--mesh', str(n), '--profile', profile, '--kind', kind, '--column', str(column), '--slices', str(slices), '--out', str(out)]
    if expanded:
        command.append('--expanded')
    start = clocks()
    elapsed = lambda: max(a-b for a, b in zip(clocks(), start))
    with out.with_name(out.name+'.log').open('w', encoding='utf-8') as log:
        proc = popen_group(command, stdout=log, stderr=subprocess.STDOUT, cwd=Path(__file__).resolve().parents[1])
        try:
            while True:
                remaining = CASE_SECONDS-elapsed()
                if remaining <= 0:
                    raise TimeoutError('30-minute case deadline including suspend')
                try:
                    code = proc.wait(timeout=min(1., remaining))
                    break
                except subprocess.TimeoutExpired:
                    pass
            seconds = elapsed()
            if code or seconds > CASE_SECONDS:
                raise RuntimeError('native case failed or exceeded deadline; retained log')
        finally:
            if proc.poll() is None:
                terminate_group(proc.pid, grace=0, job=proc.win_job)
                proc.wait(timeout=15)
            release_group(proc)
    path = out/'report.json'
    meta = json.loads(path.read_text(encoding='utf-8'))
    meta['case_elapsed_s'] = seconds
    path.write_text(json.dumps(meta, indent=2)+'\n', encoding='utf-8')
    return meta
