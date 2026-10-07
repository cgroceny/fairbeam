"""Own ideal full-height current probe, associated with Example 4.8 (p. 214).

Only TE10 modal amplitudes and radiation/input resistance are compared. An
infinitesimal filament has no finite-wire reactance target. The impressed plus
resistor current is reconstructed from Ampere's law, subtracting the local
displacement current from the native H contour. This is fixture-only analysis,
not a change to the definition of a product port current.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

import numpy as np
from openEMS.ports import UI_data

from fairbeam import Simulation
from fairbeam import simulation as simulation_module
from fairbeam.procutil import popen_group, release_group, terminate_group

C0, ETA0, EPS0 = 299792458., 376.730313668, 8.8541878128e-12
A, B = 22.86, 10.16  # mm; our air-filled PEC guide
FREQUENCIES = np.linspace(9.8e9, 10.2e9, 41)
PLANES = np.array([20., 25., 30., 35.])  # outward distances, mm
MESHES, PADDING, CONTROL_PADDING = (40, 60, 80), 16, 24
PROTOCOL, CASE_SECONDS = 'uniform-current-te10-v2', 1800.
LIMITS = dict(target_rel=.02, mesh_rel=.005, boundary_rel=.002,
              beta_rel=.005, plane_rel=.002, symmetry_rel=.002,
              current_uniform_rel=.001, power_rel=.01)


def source_ids():
    paths = dict(fixture=Path(__file__), runner=Path(__file__).with_name('test_waveguide_probe.py'),
                 simulation=Path(simulation_module.__file__))
    return {k: hashlib.sha256(v.read_bytes()).hexdigest() for k, v in paths.items()}


def geometry():
    return dict(a_mm=A, b_mm=B, epsilon_r=1., mu_r=1., source_xz_mm=[0., 0.],
                source_y_mm=[-B/2, B/2], planes_mm=PLANES.tolist(), source_resistance_ohm=50.)


def reference(freq=FREQUENCIES):
    freq = np.asarray(freq, float)
    k0 = 2*np.pi*freq/C0
    beta2 = k0**2-(np.pi/(A*1e-3))**2
    # TE20 is the next cutoff, even though the centered source cannot excite it.
    if (freq.ndim != 1 or not freq.size or not np.isfinite(freq).all()
            or np.any(freq <= 0) or np.any(beta2 <= 0) or np.any(freq >= C0/(A*1e-3))):
        raise ValueError('finite frequencies in the single-propagating-mode band required')
    beta = np.sqrt(beta2)
    zte = ETA0*k0/beta
    return beta, zte, B/A*zte


def build(cpw, padding=PADDING):
    if (isinstance(cpw, bool) or not isinstance(cpw, int) or cpw not in range(20, 121, 20)
            or isinstance(padding, bool) or padding not in (PADDING, CONTROL_PADDING)):
        raise ValueError('cpw=20..120 by twenty and declared padding required')
    sim = Simulation(FREQUENCIES[0], FREQUENCIES[-1], excitation='gauss',
        boundaries=['PEC']*4+['PML_8']*2, end_criteria_db=-70, max_timesteps=300000)
    step = C0/FREQUENCIES[-1]/sim.unit/cpw
    for axis, size in (('x', A), ('y', B)):
        count = 2*int(np.ceil(size/step/2))
        sim.mesh.AddLine(axis, np.linspace(-size/2, size/2, count+1))
    n = int(np.ceil(5/step))
    sim.mesh.AddLine('z', 5/n*np.arange(-9*n-padding, 9*n+padding+1))
    sim.lumped_port(1, 50., [0, -B/2, 0], [0, B/2, 0], 'y', priority=5)
    for side, sign in enumerate((-1, 1)):
        for j, distance in enumerate(PLANES):
            sim.csx.AddProbe(f'v{side}_{j}', p_type=0, weight=-1).AddBox(
                [0, -B/2, sign*distance], [0, B/2, sign*distance])
    for j, height in enumerate((-B/4, 0., B/4)):
        sim.csx.AddProbe(f'i{j}', p_type=1, norm_dir=1).AddBox(
            [0, height, 0], [0, height, 0])
    return sim


def source_current(voltage, contour, area_m2, dt_s, freq=FREQUENCIES):
    """V=-integral(Ey dy); I_J=I_H+j omega_Yee eps0 area V/b.

    H contours are time-stamped half a step after E. The centered discrete
    derivative is 2j*sin(omega*dt/2)/dt, not an extra empirical phase correction.
    See openEMS Common/processcurrent.cpp, Common/processintegral.cpp and the
    type-1 dual-time setup in openems.cpp. No measured fit coefficient is used.
    """
    if (not np.isfinite([area_m2, dt_s]).all() or area_m2 <= 0 or dt_s <= 0):
        raise ValueError('positive dual-cell area and native time step required')
    omega = 2*np.sin(np.pi*np.asarray(freq)*dt_s)/dt_s
    return contour+1j*omega*EPS0*area_m2*voltage/(B*1e-3)


def waves(v):
    """Fit outgoing/incoming TE10 waves using two overlapping triplets per side."""
    v = np.asarray(v, complex)
    if v.shape != (2, 4, len(FREQUENCIES)) or not np.isfinite(v).all():
        raise ValueError('two sides, four planes and finite spectra required')
    gammas, outgoing, incoming = [], [], []
    for offset in (0, 1):
        a, b, c = (v[:, offset+j, :] for j in range(3))
        if np.any(abs(b) == 0) or np.any(abs(b) < .01*np.maximum(abs(a), abs(c))):
            raise ValueError('standing-wave node makes propagation inversion ill-conditioned')
        gamma = np.arccosh((a+c)/(2*b))/.005
        gamma = np.where(gamma.imag < 0, -gamma, gamma)
        if (not np.isfinite(gamma).all() or np.any(gamma.imag <= 0)
                or np.any(gamma.imag*.005 >= np.pi)):
            raise ValueError('invalid or ambiguous propagation branch')
        d1, d2 = PLANES[offset:offset+2]*1e-3
        m = np.stack([np.stack([np.exp(-gamma*d1), np.exp(gamma*d1)], -1),
                      np.stack([np.exp(-gamma*d2), np.exp(gamma*d2)], -1)], -2)
        if np.any(np.linalg.cond(m) > 100):
            raise ValueError('ill-conditioned outgoing/incoming fit')
        rhs = np.stack([a, b], -1)
        coefficients = np.linalg.solve(m, rhs[..., None])[..., 0]
        gammas.append(gamma)
        outgoing.append(coefficients[..., 0])
        incoming.append(coefficients[..., 1])
    return np.asarray(gammas), np.asarray(outgoing), np.asarray(incoming)


def acquire(out, cpw, padding=PADDING):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sim = build(cpw, padding)
    sim.run(str(out/'raw'), threads=4, exact=True, echo=True)
    sim.evaluate(n_freq=len(FREQUENCIES))
    port = sim._port_objs[0]
    v = np.asarray(UI_data([f'v{s}_{j}' for s in range(2) for j in range(4)],
                          str(out/'raw'), FREQUENCIES).ui_f_val).reshape(2, 4, -1)
    current = np.asarray(UI_data([f'i{j}' for j in range(3)],
                                str(out/'raw'), FREQUENCIES).ui_f_val)
    dt = float(np.diff(np.loadtxt(out/'raw/et', max_rows=2)[:, 0])[0])
    area = np.diff(sim.mesh.GetLines('x'))[0]*np.diff(sim.mesh.GetLines('z'))[0]*sim.unit**2
    np.savez_compressed(out/'data.npz', f=FREQUENCIES, v=v, current=current,
                        voltage=port.uf_tot, contour=port.if_tot)
    meta = dict(protocol=PROTOCOL, geometry=geometry(), cpw=cpw, padding=padding,
        frequency_hz=FREQUENCIES.tolist(), limits=LIMITS, source_ids=source_ids(),
        cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
        area_m2=float(area), dt_s=dt, run=sim.run_stats)
    (out/'report.json').write_text(json.dumps(meta, indent=2)+'\n', encoding='utf-8')
    return meta


def serial(out, cpw, padding=PADDING):
    out = Path(out).resolve()
    if out.exists():
        raise ValueError('use a fresh acquisition directory')
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, '-m', 'tests.test_waveguide_probe', '--fdtd', '--worker',
               '--mesh', str(cpw), '--padding', str(padding), '--out', str(out)]
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
