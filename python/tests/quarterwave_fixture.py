"""Ideal TEM quarter-wave transformer research fixture: Example 5.5, p. 249.

PEC blocks form a parallel-plate height step. PMC side walls enforce transverse
invariance; physical step fringing remains. Two uniform-height controls calibrate
the unequal port impedances independently. This is not a PCB or packaged load.
Only explicitly requested research acquisition starts the native engine.
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

F0, Z_LEFT, Z_RIGHT = 3e9, 50., 10.
ZT = np.sqrt(Z_LEFT*Z_RIGHT)
D = C0/(4*F0)*1e3
H_LEFT, H_RIGHT = .5, .1
H_TRANSFORMER = H_LEFT*ZT/Z_LEFT
W = np.sqrt(MUE0/EPS0)*H_LEFT/Z_LEFT
FREQUENCIES = np.linspace(1.5e9, 4.5e9, 151)
MESHES, KINDS = (4, 6, 8), ('line50', 'line10', 'transformer')
PROTOCOL, END_DB, THREADS = 'tem-quarterwave-v1', -90., 4
CAP_NS, CASE_SECONDS, SWR_MAX = 8., 1800., 1.5
GAMMA_MAX = (SWR_MAX-1)/(SWR_MAX+1)
TARGETS = (0., D)
PLANES = ((-30., -25.), (D+25., D+30.))
SOURCES = (-50., D+50.)
LIMITS = dict(s_target_abs=.03, gamma_target_abs=.03, z_target_rel=.05,
    band_edge_target_rel=.01, s_mesh_abs=.003, gamma_mesh_abs=.003,
    z_mesh_rel=.005, band_edge_mesh_rel=.002, s_boundary_abs=.001,
    gamma_boundary_abs=.001, z_boundary_rel=.002, band_edge_boundary_rel=.001,
    power_abs=.01, reciprocity_abs=.002, plane_spread_abs=.002,
    calibration_beta_rel=.005, calibration_z_rel=.005,
    calibration_spread_rel=.002, calibration_transfer_abs=.002,
    current_strip_spread_rel=.002)


def port_spec(kind):
    if kind == 'line50':
        return np.array([Z_LEFT, Z_LEFT]), np.array([H_LEFT, H_LEFT])
    if kind == 'line10':
        return np.array([Z_RIGHT, Z_RIGHT]), np.array([H_RIGHT, H_RIGHT])
    if kind == 'transformer':
        return np.array([Z_LEFT, Z_RIGHT]), np.array([H_LEFT, H_RIGHT])
    raise ValueError('declared uniform control or transformer required')


def reference(kind, freq=FREQUENCIES):
    """ABCD to unequal real-reference power waves, not a common-50-ohm S."""
    freq = np.asarray(freq, float)
    refs, _ = port_spec(kind)
    if (freq.ndim != 1 or not freq.size or not np.isfinite(freq).all()
            or np.any(freq <= 0)):
        raise ValueError('finite positive frequency vector required')
    theta = 2*np.pi*freq*D*1e-3/C0
    z = ZT if kind == 'transformer' else refs[0]
    a = d = np.cos(theta)
    b, c = 1j*z*np.sin(theta), 1j*np.sin(theta)/z
    zl, zr = refs
    den = a*zr+b+c*zl*zr+d*zl
    s = np.empty((len(freq), 2, 2), complex)
    s[:, 0, 0] = (a*zr+b-c*zl*zr-d*zl)/den
    s[:, 1, 1] = (-a*zr+b-c*zl*zr+d*zl)/den
    s[:, 0, 1] = s[:, 1, 0] = 2*np.sqrt(zl*zr)/den
    return s


def input_impedance(s, kind):
    """Port 2 is matched to its own reference, 10 ohms for the transformer."""
    s = np.asarray(s, complex)
    refs, _ = port_spec(kind)
    if s.shape != (len(FREQUENCIES), 2, 2) or not np.isfinite(s).all():
        raise ValueError('finite complete two-port spectrum required')
    reflection = s[:, 0, 0]
    if np.any(abs(1-reflection) < 1e-8):
        raise ValueError('singular terminated input impedance')
    return refs[0]*(1+reflection)/(1-reflection), reflection


def analytic_band():
    theta = np.arccos(2*np.sqrt(Z_LEFT*Z_RIGHT)*GAMMA_MAX/
        (abs(Z_LEFT-Z_RIGHT)*np.sqrt(1-GAMMA_MAX**2)))
    return F0*np.array([2*theta/np.pi, 2-2*theta/np.pi])


def band_edges(reflection):
    """Interpolate the connected SWR passband containing the design frequency."""
    value = np.asarray(reflection, complex)
    if value.shape != FREQUENCIES.shape or not np.isfinite(value).all():
        raise ValueError('finite reflection on the declared grid required')
    margin = abs(value)-GAMMA_MAX
    centre = int(np.flatnonzero(FREQUENCIES == F0)[0])
    if margin[centre] >= 0:
        raise ValueError('design frequency does not meet the SWR threshold')
    left, right = centre, centre
    while left > 0 and margin[left-1] < 0:
        left -= 1
    while right < len(value)-1 and margin[right+1] < 0:
        right += 1
    if left == 0 or right == len(value)-1:
        raise ValueError('both SWR crossings must lie inside the recorded band')
    out = []
    for a, b in ((left-1, left), (right, right+1)):
        out.append(FREQUENCIES[a]-margin[a]*(FREQUENCIES[b]-FREQUENCIES[a])/
                   (margin[b]-margin[a]))
    return np.asarray(out)


def _axis(anchors, delta, maximum):
    anchors, pieces = np.unique(anchors), []
    for lo, hi in zip(anchors[:-1], anchors[1:]):
        if hi-lo <= 2*delta*(1+1e-12):
            part = [lo, hi]
        else:
            half = graded((hi-lo)/2, delta, maximum)
            # A mirrored short remainder can accidentally refine the middle
            # twice and hide the requested mesh family in the global timestep.
            while len(half) > 2 and half[-1]-half[-2] < delta*(1-1e-12):
                half = np.delete(half, -2)
            if half[-1]-half[-2] > maximum*(1+1e-12):
                count = int(np.ceil((half[-1]-half[-2])/maximum))
                half = np.r_[half[:-1], np.linspace(half[-2], half[-1], count+1)[1:]]
            part = np.r_[lo+half, hi-half[-2::-1]]
        # Remove roundoff duplicates at the mirrored midpoint, keeping anchors.
        for point in part:
            if not pieces or point-pieces[-1] > 1e-11:
                pieces.append(float(point))
            elif abs(point-hi) < 1e-12:
                pieces[-1] = float(hi)
    return np.asarray(pieces)


def mesh_lines(n, expanded=False):
    if isinstance(n, bool) or not isinstance(n, int) or n not in MESHES or not isinstance(expanded, bool):
        raise ValueError('declared integer mesh and boolean enclosure required')
    dx, maximum = H_RIGHT/n, 8/n
    margin = 110. if expanded else 80.
    anchors = [-margin, SOURCES[0], -10., 0., D, D+10., SOURCES[1], D+margin]
    for centre in (0., D):
        anchors.extend((centre-dx, centre+dx))
    for centres in PLANES:
        for centre in centres:
            anchors.extend((centre-dx, centre, centre+dx))
    x = _axis(anchors, dx, maximum)
    z = [0., H_LEFT+.2]
    for height in (H_RIGHT, H_TRANSFORMER, H_LEFT):
        z.extend((height-dx, height, height+dx))
    return x, np.linspace(0., W, 5), _axis(z, dx, 4*dx)


def time_settings(n, expanded=False):
    axes = mesh_lines(n, expanded)
    # Explicit conservative step: < the 3-D CFL bound for every grid interval.
    dt = min(float(np.min(np.diff(a))) for a in axes)*1e-3/(4*C0)
    return dt, int(np.ceil(CAP_NS*1e-9/dt))


def build(n, kind, column=0, expanded=False):
    refs, heights = port_spec(kind)
    if isinstance(column, bool) or column not in (0, 1):
        raise ValueError('declared excitation column required')
    x, y, z = mesh_lines(n, expanded)
    if np.prod([len(a)-1 for a in (x, y, z)]) > 1500000:
        raise ValueError('research cell budget exceeded')
    dt, steps = time_settings(n, expanded)
    sim = Simulation(1e9, 5e9, boundaries=['PML_8', 'PML_8', 'PMC', 'PMC', 'PEC', 'PEC'],
                     end_criteria_db=END_DB, max_timesteps=steps)
    for axis, lines in zip('xyz', (x, y, z)):
        sim.mesh.AddLine(axis, lines)
    sim.fdtd.SetTimeStep(dt)
    metal = sim.metal('conductors')
    metal.AddBox([x[0], 0., 0.], [x[-1], W, 0.], priority=10)
    if kind == 'transformer':
        regions = ((x[0], 0., H_LEFT), (0., D, H_TRANSFORMER), (D, x[-1], H_RIGHT))
    else:
        regions = ((x[0], x[-1], heights[0]),)
    for lo, hi, height in regions:
        metal.AddBox([lo, 0., height], [hi, W, z[-1]], priority=10)
    for p in (0, 1):
        start, stop = (x[0], -10.) if p == 0 else (x[-1], D+10.)
        height = heights[p]
        iz = int(np.flatnonzero(z == height)[0])
        sim.fdtd.AddMSLPort(p+1, metal, [start, 0., height], [stop, W, 0.], 'x', 'z',
            excite=-1 if p == column else 0, FeedShift=abs(start-SOURCES[p]),
            MeasPlaneShift=abs(start-PLANES[p][0]), priority=10)
        for q, centre in enumerate(PLANES[p]):
            ix = int(np.flatnonzero(x == centre)[0])
            for j, plane in enumerate(x[ix-1:ix+2]):
                sim.csx.AddProbe(f'v{p}_{q}_{j}', p_type=0).AddBox([plane, W/2, height], [plane, W/2, 0.])
            for j, plane in enumerate(((x[ix-1]+centre)/2, (centre+x[ix+1])/2)):
                # Two different interior contour widths independently integrate
                # the y-invariant current. The weights are geometric, not fitted.
                for label, lo, hi in (('i', 1/8, 7/8), ('j', 3/8, 5/8)):
                    sim.csx.AddProbe(f'{label}{p}_{q}_{j}', p_type=1, norm_dir=0,
                        weight=1/(hi-lo)).AddBox([plane, lo*W, (z[iz-1]+height)/2],
                                               [plane, hi*W, (height+z[iz+1])/2])
    for prop in sim.csx.GetAllProperties():
        prop.SetColor((128, 128, 128), alpha=prop.GetFillColor()[3])
    return sim


def source_ids():
    paths = [Path(__file__), Path(__file__).with_name('test_quarterwave.py'),
        Path(__file__).with_name('microstrip_fixture.py'), Path(simulation.__file__),
        Path(excitation.__file__), Path(native_ports.__file__)]
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def identity(n, kind, column, expanded):
    refs, heights = port_spec(kind)
    dt, steps = time_settings(n, expanded)
    return dict(protocol=PROTOCOL, source_ids=source_ids(), mesh=n, kind=kind,
        column=column, expanded=expanded, frequency_hz=FREQUENCIES.tolist(), limits=LIMITS,
        reference_ohm=refs.tolist(), port_heights_mm=heights.tolist(), width_mm=W,
        transformer_height_mm=H_TRANSFORMER, length_mm=D, transformer_ohm=float(ZT),
        design_hz=F0, swr_max=SWR_MAX, analytic_band_hz=analytic_band().tolist(),
        end_db=END_DB, threads=THREADS, requested_dt_s=dt, max_steps=steps)


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
    requested, _ = time_settings(n, expanded)
    if not np.isclose(dt, requested, rtol=5e-6, atol=0):
        raise RuntimeError('native timestep differs from the declared conservative step')
    meta = dict(**identity(n, kind, column, expanded), run=sim.run_stats, dt_s=dt,
        cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
        pulse_end_s=excitation.dgauss_duration_s(sim.f_max),
        input_sha256=hashlib.sha256((out/'input.xml').read_bytes()).hexdigest())
    (out/'report.json').write_text(json.dumps(meta, indent=2)+'\n', encoding='utf-8')
    return meta


def clocks():
    return time.monotonic(), time.time()


def serial(out, n, kind, column=0, expanded=False):
    """Bound a single owned worker with a suspend-inclusive wall deadline."""
    out = Path(out).resolve()
    if out.exists():
        raise ValueError('fresh acquisition directory required')
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, '-m', 'tests.test_quarterwave', '--fdtd', '--worker',
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
