"""Own ideal-element realization associated with Example 5.1 (p. 231).

Separate native single-branch L/C elements are connected geometrically. This is
an electrically small circuit fixture, not a packaged-component or PCB model.
All dimensions, references and acceptance gates are declared before acquisition.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

import numpy as np
from openEMS.ports import UI_data

from fairbeam import Simulation, excitation, simulation
from fairbeam.procutil import popen_group, release_group, terminate_group

F0, Z0, LOAD_R = 500e6, 100., 200.
LOAD_C = 1/(2*np.pi*F0*100.)
FREQUENCIES = np.linspace(400e6, 600e6, 201)
MESHES, KINDS = (1, 2, 3), ('bare', 'series-l', 'series-c')
PROTOCOL = 'ideal-lmatch-v2'
END_DB, BASE_STEPS, CASE_SECONDS, THREADS = -90., 2000000, 1800., 1
LIMITS = dict(z_target_rel=.02, gamma_target_abs=.01, z_mesh_rel=.005,
              gamma_mesh_abs=.005, z_boundary_rel=.002, gamma_boundary_abs=.002,
              power_rel=.01)
G = (1/complex(LOAD_R, -100.)).real
B = np.sqrt(G/Z0-G**2)
COMPONENTS = {
    'bare': {},
    'series-l': dict(series_L=B/(G**2+B**2)/(2*np.pi*F0),
                     shunt_C=(B-.002)/(2*np.pi*F0)),
    'series-c': dict(series_C=(G**2+B**2)/(2*np.pi*F0*B),
                     shunt_L=1/(2*np.pi*F0*(B+.002))),
}
BOXES = dict(
    ground=[[-.08, -.04, -.06], [.08, .04, -.04]],
    input_pad=[[-.08, -.04, .02], [-.04, .04, .04]],
    output_pad=[[.04, -.04, .02], [.08, .04, .04]],
    source=[[-.08, -.04, -.04], [-.04, .04, .02]],
    series=[[-.04, -.04, .02], [.04, .04, .04]],
    shunt=[[.04, -.04, -.04], [.08, -.02, .02]],
    load_r=[[.04, .02, -.04], [.08, .04, -.02]],
    load_c=[[.04, .02, -.02], [.08, .04, .02]],
    mid_pad=[[.04, .02, -.02], [.08, .04, -.02]])


def source_ids():
    paths = dict(fixture=Path(__file__), runner=Path(__file__).with_name('test_lmatch.py'),
                 simulation=Path(simulation.__file__), excitation=Path(excitation.__file__))
    return {k: hashlib.sha256(p.read_bytes()).hexdigest() for k, p in paths.items()}


def max_steps(refinement):
    # A fixed count would reduce the physical time budget as the mesh is refined.
    return BASE_STEPS*refinement


def geometry(kind, expanded=False):
    return dict(unit_m=.001, boxes_mm=BOXES, load_R_ohm=LOAD_R, load_C_f=LOAD_C,
                source_R_ohm=Z0, components=COMPONENTS[kind],
                enclosure_mm=[[-.16, -.12, -.06], [.16, .12, .10]] if expanded else
                             [[-.12, -.08, -.06], [.12, .08, .06]])


def reference(kind, freq=FREQUENCIES):
    freq = np.asarray(freq, float)
    if (kind not in KINDS or freq.ndim != 1 or not freq.size
            or not np.isfinite(freq).all() or np.any(freq <= 0)):
        raise ValueError('declared circuit and finite positive frequency vector required')
    w = 2*np.pi*freq
    load = LOAD_R+1/(1j*w*LOAD_C)
    if kind == 'bare':
        return load, np.zeros_like(load), np.ones_like(load)
    c = COMPONENTS[kind]
    zs = 1j*w*c['series_L'] if 'series_L' in c else 1/(1j*w*c['series_C'])
    yp = 1j*w*c['shunt_C'] if 'shunt_C' in c else 1/(1j*w*c['shunt_L'])
    parallel = 1/(yp+1/load)
    zin = zs+parallel
    return zin, zs, parallel/zin  # output/input voltage


def build(refinement, kind, expanded=False):
    if (isinstance(refinement, bool) or refinement not in MESHES
            or not isinstance(refinement, int) or kind not in KINDS
            or not isinstance(expanded, bool)):
        raise ValueError('declared integer refinement, circuit and enclosure required')
    sim = Simulation(FREQUENCIES[0], FREQUENCIES[-1], boundaries=['PEC']*6,
                     excitation='dgauss', end_criteria_db=END_DB, max_timesteps=max_steps(refinement))
    lo, hi = geometry(kind, expanded)['enclosure_mm']
    for k, axis in enumerate('xyz'):
        count = int(round((hi[k]-lo[k])/(.02/refinement)))
        sim.mesh.AddLine(axis, np.linspace(lo[k], hi[k], count+1))
    metal = sim.metal('nodes')
    for name in ('ground', 'input_pad', 'output_pad', 'mid_pad'):
        metal.AddBox(*BOXES[name], priority=10)
    sim.lumped_port(1, Z0, *BOXES['source'], 'z', priority=5)
    sim.lumped_resistor('load_R', LOAD_R, *BOXES['load_r'], 'z')
    sim.lumped_capacitor('load_C', LOAD_C, *BOXES['load_c'], 'z')
    if kind == 'bare':
        metal.AddBox(*BOXES['series'], priority=10)
    else:
        c = COMPONENTS[kind]
        if kind == 'series-l':
            sim.lumped_inductor('series_L', c['series_L'], *BOXES['series'], 'x')
            sim.lumped_capacitor('shunt_C', c['shunt_C'], *BOXES['shunt'], 'z')
        else:
            sim.lumped_capacitor('series_C', c['series_C'], *BOXES['series'], 'x')
            sim.lumped_inductor('shunt_L', c['shunt_L'], *BOXES['shunt'], 'z')
    # Independent load dissipation, rather than another use of the input S11.
    sim.csx.AddProbe('load_voltage', p_type=0, weight=-1).AddBox(
        [.06, .04, -.04], [.06, .04, -.02])
    return sim


def identity(refinement, kind, expanded):
    return dict(protocol=PROTOCOL, geometry=geometry(kind, expanded), kind=kind,
                refinement=refinement, expanded=expanded, limits=LIMITS,
                max_timesteps=max_steps(refinement), frequency_hz=FREQUENCIES.tolist(), source_ids=source_ids())


def acquire(out, refinement, kind, expanded=False):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sim = build(refinement, kind, expanded)
    sim.fdtd.Write2XML(str(out/'input.xml'))
    sim.run(str(out/'raw'), threads=THREADS, exact=True, echo=True, engine='cpu')
    port = sim._port_objs[0]
    port.CalcPort(str(out/'raw'), FREQUENCIES)
    vr = np.asarray(UI_data(['load_voltage'], str(out/'raw'), FREQUENCIES).ui_f_val)[0]
    times = np.loadtxt(out/'raw/et', max_rows=2)[:, 0]
    dt = float(times[1]-times[0])
    np.savez_compressed(out/'data.npz', f=FREQUENCIES, v=port.uf_tot, i=port.if_tot, vr=vr,
                        gamma=port.uf_ref/port.uf_inc)
    meta = dict(**identity(refinement, kind, expanded),
        cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
        dt_s=dt, pulse_end_s=excitation.dgauss_duration_s(sim.f_max), run=sim.run_stats,
        input_sha256=hashlib.sha256((out/'input.xml').read_bytes()).hexdigest())
    (out/'report.json').write_text(json.dumps(meta, indent=2)+'\n', encoding='utf-8')
    return meta


def serial(out, refinement, kind, expanded=False):
    out = Path(out).resolve()
    if out.exists():
        raise ValueError('use a fresh acquisition directory')
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, '-m', 'tests.test_lmatch', '--fdtd', '--worker',
               '--mesh', str(refinement), '--kind', kind, '--out', str(out)]
    if expanded:
        command.append('--expanded')
    start, wall = time.monotonic(), time.time()
    with out.with_name(out.name+'.log').open('w', encoding='utf-8') as log:
        proc = popen_group(command, stdout=log, stderr=subprocess.STDOUT,
                           cwd=Path(__file__).resolve().parents[1])
        try:
            while True:
                remaining = CASE_SECONDS-max(time.monotonic()-start, time.time()-wall)
                if remaining <= 0:
                    raise TimeoutError('30-minute case limit including suspend')
                try:
                    code = proc.wait(timeout=min(1., remaining))
                    break
                except subprocess.TimeoutExpired:
                    pass
            elapsed = max(time.monotonic()-start, time.time()-wall)
            if code or elapsed > CASE_SECONDS:
                raise RuntimeError('case failed or exceeded its deadline; see retained log')
        finally:
            if proc.poll() is None:
                terminate_group(proc.pid, grace=0, job=proc.win_job)
                proc.wait(timeout=15)
            release_group(proc)
    path = out/'report.json'
    meta = json.loads(path.read_text(encoding='utf-8'))
    meta['case_elapsed_s'] = elapsed
    path.write_text(json.dumps(meta, indent=2)+'\n', encoding='utf-8')
    return meta
