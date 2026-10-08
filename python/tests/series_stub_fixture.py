"""Ideal TEM series open-stub research fixture: Example 5.3, p. 238.

Two PEC blocks above a parallel-plate channel form the stub's vertical plates.
PMC side walls enforce y invariance; the top PMC is an ideal open termination.
The external R/L load is an ideal S-parameter termination, not a packaged load.
No gallery model, production port, design format or bundle field is changed.
"""
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
from tests.microstrip_fixture import graded

F0, Z0, LOAD_R, LOAD_X = 2e9, 50., 100., 80.
LOAD_L = LOAD_X/(2*np.pi*F0)
FREQUENCIES = np.linspace(1e9, 3e9, 101)
H = .2
W = np.sqrt(MUE0/EPS0)*H/Z0
MESHES, KINDS = (4, 6, 8), ('through', 'stub')
PROTOCOL, END_DB, THREADS = 'tem-series-stub-v3', -90., 1
BASE_STEPS, CASE_SECONDS = 400000, 1800.
LIMITS = dict(s_target_abs=.03, gamma_target_abs=.03, z_target_rel=.05,
    s_mesh_abs=.01, gamma_mesh_abs=.01, s_boundary_abs=.005,
    gamma_boundary_abs=.005, power_abs=.02, reciprocity_abs=.005,
    plane_spread_abs=.005, calibration_beta_rel=.01,
    calibration_z_rel=.01, calibration_spread_rel=.005, current_strip_spread_rel=.005)


def synthesis():
    """Solve Re(z(d))=1; cancel Im(z(d)) with the open stub -j*cot(l)."""
    r, x = LOAD_R/Z0, LOAD_X/Z0
    distances = np.mod(np.arctan(np.roots([r*r+x*x-r, -2*x, 1-r]).real), np.pi)
    solutions = []
    for theta in distances:
        zd = (r+1j*x+1j*np.tan(theta))/(1+1j*(r+1j*x)*np.tan(theta))
        length = np.mod(np.arctan2(1., zd.imag), np.pi)
        solutions.append((float(theta), float(length)))
    # Pick the shorter stub before measuring; no length is fitted to FDTD.
    return tuple(sorted(solutions, key=lambda s: s[1]))


THETA_D, THETA_STUB = synthesis()[0]
D = THETA_D*C0/F0/(2*np.pi)*1e3
STUB_LENGTH = THETA_STUB*C0/F0/(2*np.pi)*1e3
TARGETS = (0., H+D)
PLANES = ((-30., -25.), (H+D+25., H+D+30.))
SOURCES = (-50., H+D+50.)


def reference(kind, freq=FREQUENCIES):
    """ABCD to real-Z0 waves, scaled by sin(stub) to retain its open poles."""
    freq = np.asarray(freq, float)
    if kind not in KINDS or freq.ndim != 1 or not freq.size or not np.isfinite(freq).all() or np.any(freq <= 0):
        raise ValueError('known circuit and finite positive frequency vector required')
    beta = 2*np.pi*freq/C0
    if kind == 'through':
        transmission = np.exp(-1j*beta*(H+D)*1e-3)
        out = np.zeros((len(freq), 2, 2), complex)
        out[:, 0, 1] = out[:, 1, 0] = transmission
        return out
    sd, cd = np.sin(beta*D*1e-3), np.cos(beta*D*1e-3)
    sl, cl = np.sin(beta*STUB_LENGTH*1e-3), np.cos(beta*STUB_LENGTH*1e-3)
    a, b, c, d = sl*cd+cl*sd, 1j*(sl*sd-cl*cd), 1j*sl*sd, sl*cd
    den = a+b+c+d
    out = np.empty((len(freq), 2, 2), complex)
    out[:, 0, 0], out[:, 1, 1] = (a+b-c-d)/den, (-a+b-c+d)/den
    out[:, 0, 1] = out[:, 1, 0] = 2*sl/den
    return out


def terminate(s, freq=FREQUENCIES):
    """Terminate port 2 by an explicitly ideal series R/L reference."""
    s, freq = np.asarray(s, complex), np.asarray(freq, float)
    if s.shape != (len(freq), 2, 2) or not np.isfinite(s).all():
        raise ValueError('finite two-port spectrum required')
    load = LOAD_R+2j*np.pi*freq*LOAD_L
    gl = (load-Z0)/(load+Z0)
    den = 1-s[:, 1, 1]*gl
    if np.any(abs(den) < 1e-8):
        raise ValueError('ill-conditioned ideal load termination')
    gamma = s[:, 0, 0]+s[:, 0, 1]*s[:, 1, 0]*gl/den
    zin = Z0*(1+gamma)/(1-gamma)
    if not np.isfinite(zin).all():
        raise ValueError('singular terminated impedance')
    return zin, gamma


def _axis(anchors, delta, maximum):
    anchors, pieces = np.unique(anchors), []
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
    dx, maximum = H/n, 8/n
    margin = 100. if expanded else 80.
    anchors = [-margin, SOURCES[0], -10., 0., H, H+D+10., SOURCES[1], H+D+margin]
    for centres in PLANES:
        for centre in centres:
            anchors.extend((centre-dx, centre, centre+dx))
    x = _axis(anchors, dx, maximum)
    z = np.r_[np.linspace(0., H, n+1), H+graded(STUB_LENGTH, dx, maximum)[1:]]
    # Four transverse cells permit two independently sized interior contours.
    return x, np.linspace(0., W, 5), z


def build(n, kind, column=0, expanded=False):
    if kind not in KINDS or isinstance(column, bool) or column not in (0, 1):
        raise ValueError('declared circuit and excitation column required')
    x, y, z = mesh_lines(n, expanded)
    if np.prod([len(a)-1 for a in (x, y, z)]) > 500000:
        raise ValueError('research cell budget exceeded')
    sim = Simulation(.5e9, 3.5e9, boundaries=['PML_8', 'PML_8', 'PMC', 'PMC', 'PEC', 'PMC'],
                     end_criteria_db=END_DB, max_timesteps=BASE_STEPS*n//MESHES[0])
    for axis, lines in zip('xyz', (x, y, z)):
        sim.mesh.AddLine(axis, lines)
    metal = sim.metal('conductors')
    metal.AddBox([x[0], 0., 0.], [x[-1], W, 0.], priority=10)
    if kind == 'through':
        metal.AddBox([x[0], 0., H], [x[-1], W, z[-1]], priority=10)
    else:
        metal.AddBox([x[0], 0., H], [0., W, z[-1]], priority=10)
        metal.AddBox([H, 0., H], [x[-1], W, z[-1]], priority=10)
    for p in (0, 1):
        start = x[0] if p == 0 else x[-1]
        stop = -10. if p == 0 else H+D+10.
        sim.fdtd.AddMSLPort(p+1, metal, [start, 0., H], [stop, W, 0.], 'x', 'z',
            excite=-1 if p == column else 0, FeedShift=abs(start-SOURCES[p]),
            MeasPlaneShift=abs(start-PLANES[p][0]), priority=10)
        for q, centre in enumerate(PLANES[p]):
            ix, iz = int(np.flatnonzero(x == centre)[0]), n
            for j, plane in enumerate(x[ix-1:ix+2]):
                sim.csx.AddProbe(f'v{p}_{q}_{j}', p_type=0).AddBox([plane, W/2, H], [plane, W/2, 0.])
            for j, plane in enumerate(((x[ix-1]+centre)/2, (centre+x[ix+1])/2)):
                # In this y-invariant model I_ref = W*H_y. Interior dual-grid
                # strips avoid the inactive terminal current lines at the PMC
                # domain faces. Their fixed geometric fractions set the weights;
                # no measured impedance is used to choose a normalization.
                for label, lo, hi in (('i', 1/8, 7/8), ('j', 3/8, 5/8)):
                    sim.csx.AddProbe(f'{label}{p}_{q}_{j}', p_type=1, norm_dir=0,
                        weight=1/(hi-lo)).AddBox([plane, lo*W, (z[iz-1]+H)/2],
                                               [plane, hi*W, (H+z[iz+1])/2])
    # CSXCAD otherwise assigns process-global random display colors. Explicit
    # colors keep preview and worker XML byte-identical without altering physics.
    for prop in sim.csx.GetAllProperties():
        prop.SetColor((128, 128, 128), alpha=prop.GetFillColor()[3])
    return sim


def line_parameters(v, current, dx):
    """Reflected-line derivative inversion, with spatial stagger removed."""
    v, current = np.asarray(v), np.asarray(current)
    if v.shape[-2:] != (3, len(FREQUENCIES)) or current.shape != v.shape[:-2]+(2, len(FREQUENCIES)):
        raise ValueError('voltage triplets and dual currents required')
    if not np.isfinite(v).all() or not np.isfinite(current).all() or not np.isfinite(dx) or dx <= 0:
        raise ValueError('finite spectra and positive spacing required')
    u, ih = v[..., 1, :], current.mean(axis=-2)
    dv, di = (v[..., 2, :]-v[..., 0, :])/(2*dx), (current[..., 1, :]-current[..., 0, :])/dx
    if any(np.any(abs(a) < 1e-10*np.max(abs(a), axis=-1, keepdims=True)) for a in (u, ih, dv, di)):
        raise ValueError('standing-wave node in line inversion')
    gamma = 2/dx*np.arcsinh(dx*np.sqrt(dv*di/(u*ih))/2)
    gamma = np.where(gamma.imag < 0, -gamma, gamma)
    zc = np.sqrt(u*dv/(ih*di))
    zc = np.where(zc.real < 0, -zc, zc)
    return gamma, zc


def source_ids():
    paths = [Path(__file__), Path(__file__).with_name('test_series_stub.py'),
        Path(__file__).with_name('microstrip_fixture.py'), Path(simulation.__file__),
        Path(excitation.__file__), Path(native_ports.__file__)]
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def identity(n, kind, column, expanded):
    return dict(protocol=PROTOCOL, source_ids=source_ids(), mesh=n, kind=kind,
        column=column, expanded=expanded, frequency_hz=FREQUENCIES.tolist(), limits=LIMITS,
        h_mm=H, width_mm=W, d_mm=D, stub_length_mm=STUB_LENGTH,
        load_r_ohm=LOAD_R, ideal_external_load_l_h=LOAD_L, end_db=END_DB,
        threads=THREADS, max_steps=BASE_STEPS*n//MESHES[0])


def acquire(out, n, kind, column=0, expanded=False):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sim = build(n, kind, column, expanded)
    sim.fdtd.Write2XML(str(out/'input.xml'))
    (out/'protocol.json').write_text(json.dumps(identity(n, kind, column, expanded), indent=2)+'\n', encoding='utf-8')
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
    meta = dict(**identity(n, kind, column, expanded), run=sim.run_stats, dt_s=dt,
        cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
        pulse_end_s=excitation.dgauss_duration_s(sim.f_max),
        input_sha256=hashlib.sha256((out/'input.xml').read_bytes()).hexdigest())
    (out/'report.json').write_text(json.dumps(meta, indent=2)+'\n', encoding='utf-8')
    return meta


def clocks():
    return time.monotonic(), time.time()


def serial(out, n, kind, column=0, expanded=False):
    """A suspend-inclusive deadline stops only this owned worker process group."""
    out = Path(out).resolve()
    if out.exists():
        raise ValueError('fresh acquisition directory required')
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, '-m', 'tests.test_series_stub', '--fdtd', '--worker',
        '--mesh', str(n), '--kind', kind, '--column', str(column), '--out', str(out)]
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
