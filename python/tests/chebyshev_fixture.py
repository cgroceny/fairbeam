"""Opt-in TEM Chebyshev-transformer research: Example 5.7, p. 259.

Our polynomial equal-ripple equations independently synthesize one through four
sections. Constant-height PEC/PMC plates and positive scalar permittivities
realize their impedances and quarter-wave delays. This is an ideal TEM fixture,
not a PCB implementation or a test of the default Designer measurement path.
"""
from functools import lru_cache
import hashlib
import json
from math import comb
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

F0, Z_LEFT, Z_RIGHT, Z_BASE, GAMMA_MAX = 10e9, 50., 100., 100., .05
ORDERS, MESHES = (1, 2, 3, 4), (8, 12, 16)
KINDS = ('line50', 'line100', 'transformer')
H = .75
W = np.sqrt(MUE0/EPS0)*H/Z_BASE
PROTOCOL, END_DB, THREADS = 'tem-chebyshev-v2', -90., 1
CAP_NS, CASE_SECONDS = 4., 1800.
LIMITS = dict(s_target_abs=.02, gamma_target_abs=.01, z_target_rel=.02,
    band_edge_target_rel=.005, s_mesh_abs=.003, gamma_mesh_abs=.002,
    z_mesh_rel=.005, band_edge_mesh_rel=.002, s_boundary_abs=.001,
    gamma_boundary_abs=.001, z_boundary_rel=.002, band_edge_boundary_rel=.001,
    ripple_target_abs=.001, ripple_mesh_abs=.0005, ripple_boundary_abs=.0002,
    power_abs=.01, reciprocity_abs=.002, plane_spread_abs=.002,
    calibration_beta_rel=.005, calibration_z_rel=.005,
    calibration_spread_rel=.002, calibration_transfer_abs=.002,
    current_strip_spread_rel=.002)


def order_check(order):
    if isinstance(order, bool) or not isinstance(order, int) or order not in ORDERS:
        raise ValueError('integer section count in 1..4 required')


def ripple_scale(order, *, small_reflection=False):
    order_check(order)
    if small_reflection:
        ratio = abs(.5*np.log(Z_RIGHT/Z_LEFT))/GAMMA_MAX
    else:
        g = GAMMA_MAX/np.sqrt(1-GAMMA_MAX**2)
        ratio = abs(Z_RIGHT-Z_LEFT)/(2*np.sqrt(Z_LEFT*Z_RIGHT)*g)
    return np.cosh(np.arccosh(ratio)/order)


def approximate(order):
    """Own small-reflection Chebyshev expansion, distinct from exact synthesis."""
    order_check(order)
    coefficients = np.polynomial.chebyshev.cheb2poly([0.]*order+[1.])
    increments = np.zeros(order+1)
    scale = ripple_scale(order, small_reflection=True)
    for j, value in enumerate(coefficients):
        for k in range(j+1):
            increments[(order-j)//2+k] += GAMMA_MAX*value*scale**j*comb(j,k)/2**j
    return Z_LEFT*np.exp(2*np.cumsum(increments[:-1]))


def desired_polynomial(order):
    """Transform T_N(s*cos(theta)) to an own polynomial in cot(theta)."""
    order_check(order)
    coefficients = np.polynomial.chebyshev.cheb2poly([0.]*order+[1.])
    scale, q = ripple_scale(order), np.zeros(order+1)
    for j, value in enumerate(coefficients):
        if not value:
            continue
        power = (order-j)//2
        for k in range(power+1):
            q[j+2*k] += value*scale**j*comb(power,k)
    return q/q[-1]*(Z_RIGHT-Z_LEFT)/np.sqrt(Z_LEFT*Z_RIGHT)


def ripple_frequencies(order):
    order_check(order)
    result = F0*2/np.pi*np.arccos(np.cos(np.pi*np.arange(order+1)/order)/ripple_scale(order))
    result[np.isclose(result,F0,rtol=1e-14,atol=0)] = F0
    return result


# Include exact ripple extrema and outer edges, not only a uniform scan.
FREQUENCIES = np.unique(np.r_[F0*(1+np.arange(-200,201)/300),
    np.concatenate([ripple_frequencies(order) for order in ORDERS])])
CENTRE = int(np.flatnonzero(FREQUENCIES == F0)[0])


def numerator(z):
    """Own ABCD reflection polynomial in x=cot(theta), with scaled impedances."""
    z = np.asarray(z, float)
    if z.ndim != 1 or not z.size or not np.isfinite(z).all() or np.any(z <= 0):
        raise ValueError('finite positive section impedances required')
    middle = np.sqrt(Z_LEFT*Z_RIGHT)
    matrix = [[np.array([1.+0j]), np.array([0j])],
              [np.array([0j]), np.array([1.+0j])]]
    add, multiply = np.polynomial.polynomial.polyadd, np.polynomial.polynomial.polymul
    for value in z:
        step = [[np.array([0j, 1.]), np.array([1j*value/middle])],
                [np.array([1j*middle/value]), np.array([0j, 1.])]]
        matrix = [[add(multiply(matrix[i][0], step[0][j]),
                       multiply(matrix[i][1], step[1][j])) for j in (0, 1)] for i in (0, 1)]
    a, b = matrix[0]
    c, d = matrix[1]
    return add(add(a*(Z_RIGHT/middle), b), -add(c*(Z_LEFT*Z_RIGHT/middle**2), d*(Z_LEFT/middle)))


@lru_cache(maxsize=4, typed=True)
def sections(order):
    """Match the exact equal-ripple polynomial; no copied impedance table."""
    order_check(order)
    def residual(logz):
        p = numerator(np.exp(logz))-desired_polynomial(order)
        return np.array([p[k].real if k % 2 == order % 2 else p[k].imag for k in range(order)])
    x = np.log(approximate(order))
    for _ in range(30):
        value = residual(x)
        if np.max(abs(value)) < 1e-12:
            result = np.exp(x)
            result.setflags(write=False)
            return result
        h = 1e-5
        jacobian = np.column_stack([(residual(x+np.eye(order)[k]*h)-
            residual(x-np.eye(order)[k]*h))/(2*h) for k in range(order)])
        step = np.linalg.solve(jacobian, -value)
        damping = 1.
        while damping > 1e-6 and np.linalg.norm(residual(x+damping*step)) >= np.linalg.norm(value):
            damping *= .5
        if damping <= 1e-6:
            raise ValueError('equal-ripple synthesis did not make progress')
        x += damping*step
    raise ValueError('equal-ripple synthesis did not converge')


def dimensions(order):
    lengths = C0/(4*F0)*1e3*sections(order)/Z_BASE
    return lengths, np.r_[0., np.cumsum(lengths)]


def targets(order):
    return np.array([0., dimensions(order)[1][-1]])


def planes(order):
    return ((-8., -6.), tuple(targets(order)[1]+np.array([6., 8.])))


def sources(order):
    return (-15., targets(order)[1]+15.)


def port_spec(kind):
    if kind == 'line50':
        return np.array([Z_LEFT, Z_LEFT])
    if kind == 'line100':
        return np.array([Z_RIGHT, Z_RIGHT])
    if kind == 'transformer':
        return np.array([Z_LEFT, Z_RIGHT])
    raise ValueError('declared uniform control or transformer required')


def reference(order, kind, freq=FREQUENCIES):
    """Exact ABCD cascade converted to unequal real-reference power waves."""
    order_check(order)
    freq = np.asarray(freq, float)
    if freq.ndim != 1 or not freq.size or not np.isfinite(freq).all() or np.any(freq <= 0):
        raise ValueError('finite positive frequency vector required')
    refs = port_spec(kind)
    if kind == 'transformer':
        impedances, delays = sections(order), np.full(order, 1/(4*F0))
    else:
        impedances = [refs[0]]
        delays = [targets(order)[1]*1e-3/C0*Z_BASE/refs[0]]
    matrix = np.broadcast_to(np.eye(2, dtype=complex), (len(freq), 2, 2)).copy()
    for z, delay in zip(impedances, delays):
        theta = 2*np.pi*freq*delay
        step = np.empty_like(matrix)
        step[:, 0, 0] = step[:, 1, 1] = np.cos(theta)
        step[:, 0, 1], step[:, 1, 0] = 1j*z*np.sin(theta), 1j*np.sin(theta)/z
        matrix = matrix@step
    a, b, c, d = (matrix[:, i, j] for i, j in ((0, 0), (0, 1), (1, 0), (1, 1)))
    zl, zr = refs
    den = a*zr+b+c*zl*zr+d*zl
    s = np.empty_like(matrix)
    s[:, 0, 0] = (a*zr+b-c*zl*zr-d*zl)/den
    s[:, 1, 1] = (-a*zr+b-c*zl*zr+d*zl)/den
    s[:, 0, 1] = s[:, 1, 0] = 2*np.sqrt(zl*zr)/den
    return s


def input_impedance(s, kind):
    s = np.asarray(s, complex)
    refs = port_spec(kind)
    if s.shape != (len(FREQUENCIES), 2, 2) or not np.isfinite(s).all():
        raise ValueError('finite complete two-port spectrum required')
    reflection = s[:, 0, 0]
    if np.any(abs(1-reflection) < 1e-8):
        raise ValueError('singular terminated input impedance')
    return refs[0]*(1+reflection)/(1-reflection), reflection


def analytic_band(order, *, small_reflection=False):
    if not small_reflection:
        # Reuse the stored extrema exactly: an independently rounded upper
        # edge could otherwise exclude its own sample from a strict test.
        return ripple_frequencies(order)[[0, -1]]
    theta = np.arccos(1/ripple_scale(order,small_reflection=small_reflection))
    return F0*np.array([2*theta/np.pi,2-2*theta/np.pi])


def ripple_peaks(order, reflection):
    value = np.asarray(reflection,complex)
    if value.shape != FREQUENCIES.shape or not np.isfinite(value).all():
        raise ValueError('finite reflection on the declared grid required')
    indices = [int(np.argmin(abs(FREQUENCIES-frequency))) for frequency in ripple_frequencies(order)]
    return abs(value[indices])


def band_edges(order, reflection):
    """Outer threshold crossings in fixed analytical brackets, not gap-filled bands."""
    value = np.asarray(reflection,complex)
    if value.shape != FREQUENCIES.shape or not np.isfinite(value).all():
        raise ValueError('finite reflection on the declared grid required')
    edges = analytic_band(order)
    zero = F0*2/np.pi*np.arccos(np.cos(np.pi/(2*order))/ripple_scale(order))
    radius = (zero-edges[0])/2
    result = []
    for side, edge in enumerate(edges):
        indices = np.flatnonzero((FREQUENCIES >= edge-radius)&(FREQUENCIES <= edge+radius))
        margin = abs(value[indices])-GAMMA_MAX
        outside = margin > 0
        if len(indices)<2 or outside[0] != (side==0) or outside[-1] != (side==1):
            raise ValueError('outer crossing must lie inside its fixed bracket')
        transitions = np.flatnonzero((outside[:-1]!=outside[1:])&(outside[:-1] == (side==0)))
        if len(transitions) != 1:
            raise ValueError('one outer threshold crossing required per fixed bracket')
        a,b = indices[transitions[0]:transitions[0]+2]
        ma,mb = abs(value[[a,b]])-GAMMA_MAX
        result.append(FREQUENCIES[a]-ma*(FREQUENCIES[b]-FREQUENCIES[a])/(mb-ma))
    return np.asarray(result)


def mesh_lines(n, order, expanded=False):
    order_check(order)
    if isinstance(n, bool) or not isinstance(n, int) or n not in MESHES or not isinstance(expanded, bool):
        raise ValueError('declared integer mesh and boolean enclosure required')
    delta, length = H/n, targets(order)[1]
    margin = 35. if expanded else 25.
    anchors = [-margin, *sources(order), -1., length+1., length+margin, *dimensions(order)[1]]
    for centres in planes(order):
        for centre in centres:
            anchors.extend((centre-delta, centre, centre+delta))
    anchors = np.unique(anchors)
    x = np.concatenate([np.linspace(lo, hi, max(1, int(np.ceil((hi-lo)/delta-1e-11)))+1)[:-1]
        for lo, hi in zip(anchors[:-1], anchors[1:])]+[anchors[-1:]])
    return x, np.linspace(0., W, 5), delta*np.arange(n+2)


def time_settings(n, order, expanded=False):
    axes = mesh_lines(n, order, expanded)
    dt = min(float(np.min(np.diff(a))) for a in axes)*1e-3/(2*C0)
    return dt, int(np.ceil(CAP_NS*1e-9/dt))


def build(n, order, kind, column=0, expanded=False):
    refs = port_spec(kind)
    if isinstance(column, bool) or column not in (0, 1):
        raise ValueError('declared excitation column required')
    x, y, z = mesh_lines(n, order, expanded)
    if np.prod([len(a)-1 for a in (x, y, z)]) > 500000:
        raise ValueError('research cell budget exceeded')
    dt, steps = time_settings(n, order, expanded)
    sim = Simulation(2e9, 20e9, boundaries=['PML_8', 'PML_8', 'PMC', 'PMC', 'PEC', 'PEC'],
                     end_criteria_db=END_DB, max_timesteps=steps)
    for axis, lines in zip('xyz', (x, y, z)):
        sim.mesh.AddLine(axis, lines)
    sim.fdtd.SetTimeStep(dt)
    metal = sim.metal('plates')
    metal.AddBox([x[0], 0., 0.], [x[-1], W, 0.], priority=10)
    metal.AddBox([x[0], 0., H], [x[-1], W, z[-1]], priority=10)
    if kind == 'transformer':
        edges = dimensions(order)[1]
        lo, hi = np.r_[x[0], edges[:-1], edges[-1]], np.r_[edges[0], edges[1:], x[-1]]
        epsilon = np.r_[(Z_BASE/Z_LEFT)**2, (Z_BASE/sections(order))**2, (Z_BASE/Z_RIGHT)**2]
    else:
        lo, hi, epsilon = [x[0]], [x[-1]], [(Z_BASE/refs[0])**2]
    for j, (start, stop, er) in enumerate(zip(lo, hi, epsilon)):
        sim.dielectric(f'dielectric{j}', float(er)).AddBox([start, 0., 0.], [stop, W, H], priority=1)
    for p in (0, 1):
        start, stop = (x[0], -1.) if p == 0 else (x[-1], targets(order)[1]+1.)
        sim.fdtd.AddMSLPort(p+1, metal, [start, 0., H], [stop, W, 0.], 'x', 'z',
            excite=-1 if p == column else 0, FeedShift=abs(start-sources(order)[p]),
            MeasPlaneShift=abs(start-planes(order)[p][0]), priority=10)
        for q, centre in enumerate(planes(order)[p]):
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
    paths = [Path(__file__), Path(__file__).with_name('test_chebyshev.py'),
             Path(simulation.__file__), Path(excitation.__file__), Path(native_ports.__file__)]
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def identity(n, order, kind, column, expanded):
    dt, steps = time_settings(n, order, expanded)
    lengths, edges = dimensions(order)
    return dict(protocol=PROTOCOL, source_ids=source_ids(), mesh=n, sections=order, kind=kind,
        column=column, expanded=expanded, frequency_hz=FREQUENCIES.tolist(), limits=LIMITS,
        reference_ohm=port_spec(kind).tolist(), height_mm=H, width_mm=W,
        section_ohm=sections(order).tolist(), approximate_section_ohm=approximate(order).tolist(),
        section_eps_r=((Z_BASE/sections(order))**2).tolist(), section_length_mm=lengths.tolist(),
        length_mm=float(edges[-1]), design_hz=F0, reflection_limit=GAMMA_MAX,
        ripple_scale=float(ripple_scale(order)), ripple_frequency_hz=ripple_frequencies(order).tolist(),
        analytic_band_hz=analytic_band(order).tolist(),
        approximate_band_hz=analytic_band(order, small_reflection=True).tolist(),
        end_db=END_DB, threads=THREADS, requested_dt_s=dt, max_steps=steps)


def acquire(out, n, order, kind, column=0, expanded=False):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sim = build(n, order, kind, column, expanded)
    sim.fdtd.Write2XML(str(out/'input.xml'))
    (out/'protocol.json').write_text(json.dumps(identity(n, order, kind, column, expanded), indent=2)+'\n', encoding='utf-8')
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
    if not np.isclose(dt, time_settings(n, order, expanded)[0], rtol=5e-6, atol=0):
        raise RuntimeError('native timestep differs from the declared conservative step')
    meta = dict(**identity(n, order, kind, column, expanded), run=sim.run_stats, dt_s=dt,
        cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
        pulse_end_s=excitation.dgauss_duration_s(sim.f_max),
        input_sha256=hashlib.sha256((out/'input.xml').read_bytes()).hexdigest())
    (out/'report.json').write_text(json.dumps(meta, indent=2)+'\n', encoding='utf-8')
    return meta


def clocks():
    return time.monotonic(), time.time()


def serial(out, n, order, kind, column=0, expanded=False):
    """Bound one owned worker; the deadline includes machine suspend time."""
    out = Path(out).resolve()
    if out.exists():
        raise ValueError('fresh acquisition directory required')
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, '-m', 'tests.test_chebyshev', '--fdtd', '--worker',
        '--mesh', str(n), '--sections', str(order), '--kind', kind, '--column', str(column), '--out', str(out)]
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
