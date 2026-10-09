"""Own planar shorted-shunt-stub fixture associated with Example 5.2, p. 235.

The ideal transmission-line synthesis is fixed before FDTD. A uniform-line
control and a bare load separate feed/cross-section effects from the tee/stub.
No gallery geometry, production port or bundle schema is changed.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

import numpy as np
from openEMS.ports import UI_data
from openEMS import ports as native_ports
from openEMS.physical_constants import C0

from fairbeam import Simulation, excitation, simulation
from fairbeam.analytic import microstrip_eps_eff, microstrip_width
from fairbeam.procutil import popen_group, release_group, terminate_group
from tests.microstrip_fixture import graded

F0, Z0, LOAD_R, LOAD_X = 2e9, 50., 60., -80.
LOAD_C = -1/(2*np.pi*F0*LOAD_X)
FREQUENCIES = np.linspace(1e9, 3e9, 101)
H, ER = .5, 9.9
W = microstrip_width(Z0, ER, H)
EPS_EFF = microstrip_eps_eff(ER, H, W)
WAVELENGTH_MM = C0/F0/np.sqrt(EPS_EFF)*1e3
MESHES, KINDS = (4, 6, 8), ('uniform', 'bare', 'stub', 'matched')
PROTOCOL, END_DB, THREADS = 'planar-shunt-stub-v2', -90., 4
BASE_STEPS, CASE_SECONDS = 200000, 1800.
MEAS_PLANES = (-8., -6.)
LIMITS = dict(z_target_rel=.03, gamma_target_abs=.02, z_mesh_rel=.01,
              gamma_mesh_abs=.01, z_boundary_rel=.005,
              gamma_boundary_abs=.005, power_rel=.02,
              calibration_beta_rel=.02, calibration_z_rel=.03,
              calibration_spread_rel=.005)


def synthesis():
    """Solve Re(y(d))=1 and cancel Im(y(d)) with -j*cot(beta*l)."""
    y = Z0/complex(LOAD_R, LOAD_X)
    g, b = y.real, y.imag
    roots = np.roots([g*g+b*b-g, -2*b, 1-g])
    distances = np.mod(np.arctan(roots.real), np.pi)
    solutions = []
    for theta in sorted(distances):
        yd = (y+1j*np.tan(theta))/(1+1j*y*np.tan(theta))
        stub = np.mod(np.arctan2(1., yd.imag), np.pi)
        solutions.append((float(theta), float(stub)))
    return tuple(solutions)


THETA_D, THETA_STUB = synthesis()[0]
D = THETA_D/(2*np.pi)*WAVELENGTH_MM
STUB_LENGTH = THETA_STUB/(2*np.pi)*WAVELENGTH_MM


def reference(kind, freq=FREQUENCIES, *, gamma=None, zc=Z0, load=None):
    freq = np.asarray(freq, float)
    if (kind not in KINDS or freq.ndim != 1 or not freq.size
            or not np.isfinite(freq).all() or np.any(freq <= 0)):
        raise ValueError('known circuit and finite positive frequency vector required')
    if gamma is None:
        gamma = 2j*np.pi*freq/C0*np.sqrt(EPS_EFF)
    gamma = np.broadcast_to(np.asarray(gamma, complex), freq.shape)
    zc = np.broadcast_to(np.asarray(zc, complex), freq.shape)
    if not np.isfinite(gamma).all() or not np.isfinite(zc).all() or np.any(zc.real <= 0):
        raise ValueError('finite propagation and positive-real line impedance required')
    if kind == 'uniform':
        return zc.copy()
    if load is None:
        load = np.full(freq.shape, Z0, complex) if kind == 'matched' else LOAD_R+1/(2j*np.pi*freq*LOAD_C)
    load = np.broadcast_to(np.asarray(load, complex), freq.shape)
    t = np.tanh(gamma*D*1e-3)
    zin = zc*(load+zc*t)/(zc+load*t)
    if kind == 'stub':
        zin = 1/(1/zin+1/(zc*np.tanh(gamma*STUB_LENGTH*1e-3)))
    if not np.isfinite(zin).all():
        raise ValueError('singular transmission-line reference')
    return zin


def move_plane(zin, gamma, zc, distance_m):
    """Invert a line ABCD section; permits a measured complex Zc, no refit."""
    t = np.tanh(np.asarray(gamma)*distance_m)
    return zc*(zin-zc*t)/(zc-zin*t)


def _axis(anchors, delta, maximum):
    anchors = np.unique(np.asarray(anchors, float))
    pieces = []
    for lo, hi in zip(anchors[:-1], anchors[1:]):
        if hi-lo <= 2*delta*(1+1e-12):
            part = [lo, hi]
        else:
            half = graded((hi-lo)/2, delta, maximum)
            part = np.r_[lo+half, hi-half[-2::-1]]
        pieces.extend(part)
    return np.unique(pieces)


def mesh_lines(n, expanded=False):
    if isinstance(n, bool) or not isinstance(n, int) or n not in MESHES or not isinstance(expanded, bool):
        raise ValueError('declared integer mesh and boolean enclosure required')
    delta, maximum = H/n, 4*H/n
    air = 6. if expanded else 3.
    left, right = -18., D+air+8*maximum
    edge = W/2
    xanchors = [left, -14., -2., 0., D-edge, D+edge, right]
    for centre in MEAS_PLANES:
        xanchors.extend((centre-delta, centre, centre+delta))
    for centre in (0., D):
        xanchors.extend((centre-edge-delta*2/3, centre-edge+delta/3,
                         centre+edge-delta/3, centre+edge+delta*2/3))
    x = _axis(xanchors, delta, maximum)
    y = _axis([-air-8*maximum, -edge-2*delta/3, -edge+delta/3, 0.,
               edge-delta/3, edge+2*delta/3, STUB_LENGTH,
               STUB_LENGTH+air+8*maximum], delta, maximum)
    z = np.r_[np.linspace(0., H, n+1), H+graded(air, delta, maximum)[1:],
              H+air+maximum*np.arange(1, 9)]
    return x, y, z


def build(n, kind, expanded=False):
    if kind not in KINDS:
        raise ValueError('unknown circuit')
    x, y, z = mesh_lines(n, expanded)
    cells = int(np.prod([len(a)-1 for a in (x, y, z)]))
    if cells > 2000000:
        raise ValueError('research cell budget exceeded')
    sim = Simulation(.5e9, 3.5e9, boundaries=['PML_8']*4+['PEC', 'PML_8'],
        end_criteria_db=END_DB, max_timesteps=BASE_STEPS*n//MESHES[0])
    for axis, lines in zip('xyz', (x, y, z)):
        sim.mesh.AddLine(axis, lines)
    sim.dielectric('substrate', ER).AddBox([x[0], y[0], 0.], [x[-1], y[-1], H], priority=1)
    metal = sim.metal('conductors')
    metal.AddBox([x[0], y[0], 0.], [x[-1], y[-1], 0.], priority=10)
    end = x[-1] if kind == 'uniform' else D+W/2
    metal.AddBox([x[0], -W/2, H], [end, W/2, H], priority=10)
    if kind == 'stub':
        metal.AddBox([-W/2, 0., H], [W/2, STUB_LENGTH, H], priority=10)
        metal.AddBox([-W/2, STUB_LENGTH, 0.], [W/2, STUB_LENGTH, H], priority=10)
    if kind != 'uniform':
        if kind == 'matched':
            sim.lumped_resistor('load_R', Z0, [D-W/2, -W/2, 0.], [D+W/2, W/2, H], 'z')
            rtop = H
        else:
            sim.lumped_resistor('load_R', LOAD_R, [D-W/2, -W/2, 0.], [D+W/2, W/2, H/2], 'z')
            sim.lumped_capacitor('load_C', LOAD_C, [D-W/2, -W/2, H/2], [D+W/2, W/2, H], 'z')
            metal.AddBox([D-W/2, -W/2, H/2], [D+W/2, W/2, H/2], priority=10)
            rtop = H/2
        sim.csx.AddProbe('load_voltage', p_type=0, weight=-1).AddBox([D, 0., 0.], [D, 0., rtop])
    port = sim.fdtd.AddMSLPort(1, metal, [x[0], -W/2, H], [-2., W/2, 0.],
        'x', 'z', excite=-1, FeedShift=4., MeasPlaneShift=10., priority=10)
    iy = np.flatnonzero(abs(y) < W/2)
    loop_y = ((y[iy[0]-1]+y[iy[0]])/2, (y[iy[-1]]+y[iy[-1]+1])/2)
    iz = int(np.flatnonzero(z == H)[0])
    loop_z = ((z[iz-1]+H)/2, (H+z[iz+1])/2)
    for p, centre in enumerate(MEAS_PLANES):
        ix = int(np.flatnonzero(x == centre)[0])
        for j, plane in enumerate(x[ix-1:ix+2]):
            sim.csx.AddProbe(f'v{p}_{j}', p_type=0).AddBox([plane, 0., H], [plane, 0., 0.])
        for j, plane in enumerate(((x[ix-1]+centre)/2, (centre+x[ix+1])/2)):
            sim.csx.AddProbe(f'i{p}_{j}', p_type=1, norm_dir=0).AddBox(
                [plane, loop_y[0], loop_z[0]], [plane, loop_y[1], loop_z[1]])
    return sim, port


def line_parameters(v, current, dx):
    """Independent reflected-line derivative inversion, spatial stagger removed."""
    v, current = np.asarray(v), np.asarray(current)
    if (v.shape[-2:] != (3, len(FREQUENCIES))
            or current.shape != v.shape[:-2]+(2, len(FREQUENCIES))
            or not np.isfinite(v).all() or not np.isfinite(current).all()
            or not np.isfinite(dx) or dx <= 0):
        raise ValueError('finite voltage/current triplets and positive spacing required')
    u, ih = v[..., 1, :], current.mean(axis=-2)
    dv = (v[..., 2, :]-v[..., 0, :])/(2*dx)
    di = (current[..., 1, :]-current[..., 0, :])/dx
    if any(np.any(abs(a) <= 1e-10*np.max(abs(a), axis=-1, keepdims=True)) for a in (u, ih, dv, di)):
        raise ValueError('line inversion at a standing-wave node')
    gamma = 2/dx*np.arcsinh(dx*np.sqrt(dv*di/(u*ih))/2)
    gamma = np.where(gamma.imag < 0, -gamma, gamma)
    zc = np.sqrt(u*dv/(ih*di))
    zc = np.where(zc.real < 0, -zc, zc)
    return gamma, zc, ih/np.cosh(gamma*dx/2)


def source_ids():
    paths = [Path(__file__), Path(__file__).with_name('test_shunt_stub.py'),
             Path(__file__).with_name('microstrip_fixture.py'),
             Path(simulation.__file__), Path(excitation.__file__), Path(native_ports.__file__)]
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def identity(n, kind, expanded):
    return dict(protocol=PROTOCOL, source_ids=source_ids(), mesh=n, kind=kind,
        expanded=expanded, frequency_hz=FREQUENCIES.tolist(), limits=LIMITS,
        h_mm=H, width_mm=W, eps_r=ER, d_mm=D, stub_length_mm=STUB_LENGTH,
        load_r_ohm=LOAD_R, load_c_f=LOAD_C, end_db=END_DB, threads=THREADS,
        max_steps=BASE_STEPS*n//MESHES[0])


def acquire(out, n, kind, expanded=False):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sim, port = build(n, kind, expanded)
    sim.fdtd.Write2XML(str(out/'input.xml'))
    (out/'protocol.json').write_text(json.dumps(identity(n, kind, expanded), indent=2)+'\n', encoding='utf-8')
    sim.run(str(out/'raw'), threads=THREADS, exact=True, echo=True, engine='cpu')
    v = np.asarray(UI_data([f'v{p}_{j}' for p in range(2) for j in range(3)],
                          str(out/'raw'), FREQUENCIES).ui_f_val).reshape(2, 3, -1)
    i = np.asarray(UI_data([f'i{p}_{j}' for p in range(2) for j in range(2)],
                          str(out/'raw'), FREQUENCIES).ui_f_val).reshape(2, 2, -1)
    vr = np.zeros(len(FREQUENCIES), complex) if kind == 'uniform' else np.asarray(
        UI_data(['load_voltage'], str(out/'raw'), FREQUENCIES).ui_f_val)[0]
    port.CalcPort(str(out/'raw'), FREQUENCIES, ref_impedance=Z0)
    np.savez_compressed(out/'data.npz', f=FREQUENCIES, v=v, i=i, vr=vr,
                        native_v=port.uf_tot, native_i=port.if_tot)
    dt = float(np.diff(np.loadtxt(out/'raw/et', max_rows=2)[:, 0])[0])
    meta = dict(**identity(n, kind, expanded), run=sim.run_stats, dt_s=dt,
        cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
        pulse_end_s=excitation.dgauss_duration_s(sim.f_max),
        input_sha256=hashlib.sha256((out/'input.xml').read_bytes()).hexdigest())
    (out/'report.json').write_text(json.dumps(meta, indent=2)+'\n', encoding='utf-8')
    return meta


def clocks():
    return time.monotonic(), time.time()


def serial(out, n, kind, expanded=False):
    """Only the owned worker group is stopped at the suspend-inclusive deadline."""
    out = Path(out).resolve()
    if out.exists():
        raise ValueError('fresh acquisition directory required')
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, '-m', 'tests.test_shunt_stub', '--fdtd', '--worker',
               '--mesh', str(n), '--kind', kind, '--out', str(out)]
    if expanded:
        command.append('--expanded')
    start = clocks()
    elapsed = lambda: max(a-b for a, b in zip(clocks(), start))
    with out.with_name(out.name+'.log').open('w', encoding='utf-8') as log:
        proc = popen_group(command, stdout=log, stderr=subprocess.STDOUT,
                           cwd=Path(__file__).resolve().parents[1])
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
                raise RuntimeError('native case failed or exceeded its deadline; retained log')
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
