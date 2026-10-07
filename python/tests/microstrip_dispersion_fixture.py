"""PEC microstrip phase-dispersion research fixture, Example 3.8 (p. 152).

Own geometry and measurement protocol, independent of gallery models and
other unmerged research fixtures. No production API or schema changes.
"""
import hashlib
import json
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

import numpy as np

from fairbeam import Simulation, simulation
from fairbeam.analytic import microstrip_eps_eff, microstrip_z0
from openEMS.ports import UI_data
from openEMS.physical_constants import C0, MUE0

H, W, ER, F0 = .65, 2., 10., 12.5e9
FREQUENCIES = np.linspace(5e9, 20e9, 61)
MESHES, LENGTH, AIR = (6, 8, 10), 4., 5.
PHASE_LENGTH_M = .01093
# Declared before acquisition; the phase reference is an approximation.
PHASE_LIMITS, BOUNDARY_LIMIT = (.03, .003, .002), .001


def reference(frequency=FREQUENCIES):
    """Getsinger approximation, SI units, Qucs equations 11.59--11.61.

    https://qucs.sourceforge.net/tech/node75.html
    epsilon(f)=er-(er-e0)/(1+G*(f/fp)**2), G=.6+.009*Z0,
    fp=Z0/(2*mu0*h). This is not an exact full-wave reference.
    """
    frequency = np.asarray(frequency, dtype=float)
    if frequency.ndim != 1 or not np.isfinite(frequency).all() or np.any(frequency < 0):
        raise ValueError('finite nonnegative one-dimensional frequencies required')
    e0, z0 = microstrip_eps_eff(ER, H, W), microstrip_z0(ER, H, W)
    fp = z0/(2*MUE0*H*1e-3)
    effective = ER-(ER-e0)/(1+(.6+.009*z0)*(frequency/fp)**2)
    beta = 2*np.pi*frequency/C0*np.sqrt(effective)
    return dict(eps_eff=effective, beta=beta, static_eps_eff=e0,
                static_z_ohm=z0, fp_hz=fp)


def graded(span, first, maximum):
    points, step = [0.], first
    while points[-1] < span:
        step = min(step, maximum)
        points.append(min(points[-1]+step, span))
        step *= 1.25
    if len(points) > 2 and points[-1]-points[-2] < first/2:
        points[-2] = (points[-3]+points[-1])/2
    return np.asarray(points)


def build(n, air=AIR):
    if isinstance(n, bool) or n not in MESHES or air not in (5., 10.):
        raise ValueError('supported dispersion mesh and air margin required')
    # Independent substrate light-line bound avoids aliasing of d=2 mm triplets.
    phase = 2*np.pi*FREQUENCIES/C0*np.sqrt(ER)*.002
    if np.any(phase >= np.pi) or np.any(abs(np.sin(reference()['beta']*.002)) < .05):
        raise ValueError('frequency protocol is ambiguous for 2 mm phase triplets')
    dx, delta, maximum = 2/n, H/(6*n), 8*H/n
    x = dx*np.arange(int(-4/dx), int((LENGTH+16)/dx)+1)
    edge = W/2
    inner = edge-delta/3
    inside = inner-graded(inner, delta, maximum)[::-1]
    outside = edge+2*delta/3+graded(air-edge-2*delta/3, delta, maximum)
    positive = np.r_[inside, outside, air+maximum*np.arange(1, 9)]
    y = np.r_[-positive[:0:-1], positive]
    below = -graded(H, delta, H/n)[::-1]+H
    above = H+graded(air, delta, maximum)
    z = np.r_[-np.linspace(2., 0., 17)[:-1], below, above[1:],
              H+air+maximum*np.arange(1, 9)]
    if int(np.prod([len(a)-1 for a in (x, y, z)])) > 4_000_000:
        raise ValueError('dispersion research cell budget exceeded')
    sim = Simulation(.1*F0, 1.9*F0, excitation='dgauss', end_criteria_db=-70,
                     max_timesteps=2_000_000, boundaries=['PML_8']*6)
    for axis, lines in zip('xyz', (x, y, z)):
        sim.mesh.AddLine(axis, lines)
    sim.dielectric('substrate', ER).AddBox([x[0], y[0], 0], [x[-1], y[-1], H], priority=1)
    strip = sim.metal('strip')
    strip.AddBox([x[0], -W/2, H], [x[-1], W/2, H], priority=10)
    sim.metal('ground').AddBox([x[0], y[0], 0], [x[-1], y[-1], 0], priority=10)
    middle = (x[0]+x[-1])/2
    for port, a, b in ((1, x[0], middle), (2, x[-1], middle)):
        sim.fdtd.AddMSLPort(port, strip, [a, -W/2, H], [b, W/2, 0], 'x', 'z',
            excite=-1 if port == 1 else 0, FeedShift=4., MeasPlaneShift=10., priority=10)
    centres = np.arange(6., 12.)
    for p, centre in enumerate(centres):
        if not np.any(np.isclose(x, centre, rtol=0, atol=1e-12)):
            raise ValueError('phase measurement plane missed the grid')
        sim.csx.AddProbe(f'phase{p}', p_type=0).AddBox([centre, 0, H], [centre, 0, 0])
    return sim, centres


def triplets(voltage):
    voltage = np.asarray(voltage)
    if voltage.shape != (6, len(FREQUENCIES)) or not np.isfinite(voltage).all():
        raise ValueError('six finite phase-plane spectra required')
    rows = []
    for offset in (0, 1):
        a, b, c = voltage[offset:offset+5:2]
        if np.any(b == 0) or np.any(abs(b) < .01*np.maximum(abs(a), abs(c))):
            raise ValueError('standing-wave node in phase triplet')
        gamma = np.arccosh((a+c)/(2*b))/.002
        rows.append(np.where(gamma.imag < 0, -gamma, gamma))
    return np.asarray(rows)


def identities():
    return {key: hashlib.sha256(Path(path).read_bytes()).hexdigest()
            for key, path in dict(dispersion_study_sha256=__file__,
                                  simulation_sha256=simulation.__file__).items()}


def acquire(out, n, air=AIR):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sim, centres = build(n, air)
    sim.run(str(out/'raw'), threads=4, exact=True, echo=True)
    voltage = np.asarray(UI_data([f'phase{p}' for p in range(6)],
                         str(out/'raw'), FREQUENCIES).ui_f_val)
    gamma = triplets(voltage)
    dt = float(np.diff(np.loadtxt(out/'raw/et', max_rows=2)[:, 0])[0])
    versions = {}
    for package in ('openEMS', 'CSXCAD'):
        try:
            versions[package] = version(package)
        except PackageNotFoundError:
            versions[package] = 'unavailable'
    np.savez_compressed(out/'data.npz', f=FREQUENCIES, centres=centres, v=voltage, gamma=gamma)
    meta = dict(resolution=n, length_mm=LENGTH, kind='pec', excited_port=1, air_mm=air,
        width_mm=W, substrate_mm=H, eps_r=ER, geometry_thickness_mm=0.,
        loss_tangent_at_f0=0., loss_reference_hz=F0, frequency_hz=FREQUENCIES.tolist(),
        cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
        dt_s=dt, run=sim.run_stats, excitation=sim.excitation, runtime_versions=versions,
        dispersion_protocol='microstrip-phase-5-to-20GHz-v2', **identities())
    (out/'report.json').write_text(json.dumps(meta, indent=2)+'\n', encoding='utf-8')
    return meta
