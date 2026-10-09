"""Air-microstrip double open-stub research fixture: Example 5.4, p. 243.

Fixed ideal line synthesis is compared with physical open tips and tee junctions.
The series R/C load is an ideal external S-parameter termination; no element
contact geometry is implied. A separate uniform-line control removes feed lines.
No gallery, production port, schema, CLI or bundle field is changed.
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
from fairbeam.analytic import microstrip_width
from fairbeam.procutil import popen_group, release_group, terminate_group
from tests.microstrip_fixture import graded

F0, Z0, LOAD_R, LOAD_X = 2e9, 50., 60., -80.
LOAD_C = -1/(2*np.pi*F0*LOAD_X)
FREQUENCIES = np.linspace(1e9, 3e9, 101)
H, ER = 1., 1.
W = microstrip_width(Z0, ER, H)
MESHES, KINDS = (4, 6, 8), ('through', 'stub')
PROTOCOL, END_DB, THREADS = 'planar-double-stub-v1', -90., 4
BASE_STEPS, CASE_SECONDS = 60000, 1800.
LIMITS = dict(s_target_abs=.05, gamma_target_abs=.05, z_target_rel=.10,
    s_mesh_abs=.01, gamma_mesh_abs=.01, s_boundary_abs=.005,
    gamma_boundary_abs=.005, power_abs=.05, reciprocity_abs=.005,
    plane_spread_abs=.005, calibration_beta_rel=.01,
    calibration_z_rel=.03, calibration_spread_rel=.005,
    calibration_transfer_abs=.005, current_strip_spread_rel=.01)


def synthesis():
    """At d=lambda/8, solve Re(y_in)=1, then cancel its susceptance.

    The first stub is at the load (port 2); the second is at port 1.
    Both stubs are open, so their normalized admittance is j*tan(theta).
    """
    y = Z0/complex(LOAD_R, LOAD_X)
    g, b, t = y.real, y.imag, 1.
    radicand = g*(1+t*t)-g*g*t*t
    if radicand < 0:
        raise ValueError('load is in the double-stub forbidden region')
    solutions = []
    for sign in (-1., 1.):
        q = (1+sign*np.sqrt(radicand))/t
        transformed = (g+1j*q+1j*t)/(1+1j*(g+1j*q)*t)
        angles = np.mod(np.arctan([q-b, -transformed.imag]), np.pi)
        solutions.append(tuple(float(v) for v in angles))
    # Shortest total length is selected before FDTD, with no fitted end shift.
    return tuple(sorted(solutions, key=sum))


D = C0/F0/8*1e3
THETA_LOAD, THETA_INPUT = synthesis()[0]
STUB_LOAD, STUB_INPUT = np.asarray(synthesis()[0])*C0/F0/(2*np.pi)*1e3
TARGETS = (0., D)
PLANES = ((-30., -25.), (D+25., D+30.))
SOURCES = (-50., D+50.)


def reference(kind, freq=FREQUENCIES):
    """Two shunts and a line, scaled by cosines to retain open-stub poles."""
    freq = np.asarray(freq, float)
    if (kind not in KINDS or freq.ndim != 1 or not freq.size
            or not np.isfinite(freq).all() or np.any(freq <= 0)):
        raise ValueError('known circuit and finite positive frequency vector required')
    beta = 2*np.pi*freq/C0
    if kind == 'through':
        transmission = np.exp(-1j*beta*D*1e-3)
        out = np.zeros((len(freq), 2, 2), complex)
        out[:, 0, 1] = out[:, 1, 0] = transmission
        return out
    sd, cd = np.sin(beta*D*1e-3), np.cos(beta*D*1e-3)
    si, ci = np.sin(beta*STUB_INPUT*1e-3), np.cos(beta*STUB_INPUT*1e-3)
    sl, cl = np.sin(beta*STUB_LOAD*1e-3), np.cos(beta*STUB_LOAD*1e-3)
    # Normalized ABCD: shunt(input) @ line(d) @ shunt(load).
    a = ci*(cd*cl-sd*sl)
    b = 1j*ci*sd*cl
    c = 1j*(si*(cd*cl-sd*sl)+ci*(sd*cl+cd*sl))
    d = (ci*cd-si*sd)*cl
    den = a+b+c+d
    out = np.empty((len(freq), 2, 2), complex)
    out[:, 0, 0], out[:, 1, 1] = (a+b-c-d)/den, (-a+b-c+d)/den
    out[:, 0, 1] = out[:, 1, 0] = 2*ci*cl/den
    return out


def terminate(s, freq=FREQUENCIES):
    """Terminate port 2 by the explicitly ideal series R/C reference."""
    s, freq = np.asarray(s, complex), np.asarray(freq, float)
    if s.shape != (len(freq), 2, 2) or not np.isfinite(s).all():
        raise ValueError('finite two-port spectrum required')
    load = LOAD_R+1/(2j*np.pi*freq*LOAD_C)
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
    dx, maximum = H/n, 12/n
    air, margin = (30., 100.) if expanded else (20., 80.)
    anchors = [-margin, SOURCES[0], -10., 0., D, D+10., SOURCES[1], D+margin]
    for centres in PLANES:
        for centre in centres:
            anchors.extend((centre-dx, centre, centre+dx))
    for centre in (0., D):
        anchors.extend((centre-W/2-2*dx/3, centre-W/2+dx/3,
                        centre+W/2-dx/3, centre+W/2+2*dx/3))
    x = _axis(anchors, dx, maximum)
    x = np.r_[x[0]-maximum*np.arange(8, 0, -1), x, x[-1]+maximum*np.arange(1, 9)]
    end = max(STUB_INPUT, STUB_LOAD)
    y = _axis([-air, -W/2-2*dx/3, -W/2+dx/3, 0., W/2-dx/3, W/2+2*dx/3,
               STUB_INPUT-dx/3, STUB_INPUT+2*dx/3,
               STUB_LOAD-dx/3, STUB_LOAD+2*dx/3, end+air], dx, maximum)
    y = np.r_[y[0]-maximum*np.arange(8, 0, -1), y, y[-1]+maximum*np.arange(1, 9)]
    z = np.r_[np.linspace(0., H, n+1), H+graded(air, dx, maximum)[1:],
              H+air+maximum*np.arange(1, 9)]
    return x, y, z


def build(n, kind, column=0, expanded=False):
    if kind not in KINDS or isinstance(column, bool) or column not in (0, 1):
        raise ValueError('declared circuit and excitation column required')
    x, y, z = mesh_lines(n, expanded)
    if np.prod([len(a)-1 for a in (x, y, z)]) > 6000000:
        raise ValueError('research cell budget exceeded')
    sim = Simulation(.5e9, 3.5e9, boundaries=['PML_8']*4+['PEC', 'PML_8'],
                     end_criteria_db=END_DB, max_timesteps=BASE_STEPS*n//MESHES[0])
    for axis, lines in zip('xyz', (x, y, z)):
        sim.mesh.AddLine(axis, lines)
    metal = sim.metal('conductors')
    metal.AddBox([x[0], y[0], 0.], [x[-1], y[-1], 0.], priority=10)
    metal.AddBox([x[0], -W/2, H], [x[-1], W/2, H], priority=10)
    if kind == 'stub':
        for centre, length in ((0., STUB_INPUT), (D, STUB_LOAD)):
            metal.AddBox([centre-W/2, 0., H], [centre+W/2, length, H], priority=10)
    inside = np.flatnonzero(abs(y) < W/2)
    lo, hi, iz = inside[0], inside[-1], n
    contours = [('i', (y[lo-1]+y[lo])/2, (y[hi]+y[hi+1])/2,
                 (z[iz-1]+H)/2, (H+z[iz+1])/2),
                ('j', (y[lo-2]+y[lo-1])/2, (y[hi+1]+y[hi+2])/2,
                 (z[iz-2]+z[iz-1])/2, (z[iz+1]+z[iz+2])/2)]
    for p in (0, 1):
        start = x[0] if p == 0 else x[-1]
        stop = -10. if p == 0 else D+10.
        sim.fdtd.AddMSLPort(p+1, metal, [start, -W/2, H], [stop, W/2, 0.], 'x', 'z',
            excite=-1 if p == column else 0, FeedShift=abs(start-SOURCES[p]),
            MeasPlaneShift=abs(start-PLANES[p][0]), priority=10)
        for q, centre in enumerate(PLANES[p]):
            ix = int(np.flatnonzero(x == centre)[0])
            for j, plane in enumerate(x[ix-1:ix+2]):
                sim.csx.AddProbe(f'v{p}_{q}_{j}', p_type=0).AddBox([plane, 0., H], [plane, 0., 0.])
            for j, plane in enumerate(((x[ix-1]+centre)/2, (centre+x[ix+1])/2)):
                for label, yl, yh, zl, zh in contours:
                    sim.csx.AddProbe(f'{label}{p}_{q}_{j}', p_type=1, norm_dir=0).AddBox(
                        [plane, yl, zl], [plane, yh, zh])
    # Make preview and worker input byte-identical; colors do not affect physics.
    for prop in sim.csx.GetAllProperties():
        prop.SetColor((128, 128, 128), alpha=prop.GetFillColor()[3])
    return sim


def source_ids():
    paths = [Path(__file__), Path(__file__).with_name('test_double_stub.py'),
        Path(__file__).with_name('microstrip_fixture.py'), Path(simulation.__file__),
        Path(excitation.__file__), Path(native_ports.__file__)]
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def identity(n, kind, column, expanded):
    return dict(protocol=PROTOCOL, source_ids=source_ids(), mesh=n, kind=kind,
        column=column, expanded=expanded, frequency_hz=FREQUENCIES.tolist(), limits=LIMITS,
        h_mm=H, width_mm=W, d_mm=D, stub_load_mm=float(STUB_LOAD), stub_input_mm=float(STUB_INPUT),
        load_r_ohm=LOAD_R, ideal_external_load_c_f=LOAD_C, end_db=END_DB,
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
    command = [sys.executable, '-m', 'tests.test_double_stub', '--fdtd', '--worker',
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
