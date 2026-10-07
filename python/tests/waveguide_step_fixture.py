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
PROTOCOL = 'uniform-te10-dielectric-step-v2'
CASE_SECONDS = 1800.


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


def build(cpw, excited, padding=PADDING):
    if (isinstance(cpw, bool) or not isinstance(cpw, int) or cpw not in range(10, 81, 10)
            or isinstance(excited, bool) or excited not in (1, 2)
            or isinstance(padding, bool) or not isinstance(padding, int) or padding < 16):
        raise ValueError('cpw=10..80 by ten, port=1/2 and padding>=16 required')
    sim = Simulation(FREQUENCIES[0], FREQUENCIES[-1], excitation='gauss',
        boundaries=['PEC']*4+['PML_8']*2, end_criteria_db=-70, max_timesteps=200000)
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


def acquire(out, cpw, excited, padding=PADDING):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sim = build(cpw, excited, padding)
    sim.run(str(out/'raw'), threads=4, exact=True, echo=True)
    sim.evaluate(n_freq=len(FREQUENCIES))
    ports = sim._port_objs
    z = np.array([np.broadcast_to(p.Z_ref, FREQUENCIES.shape) for p in ports])
    a = np.array([p.uf_inc for p in ports])/np.sqrt(z)
    b = np.array([p.uf_ref for p in ports])/np.sqrt(z)
    np.savez_compressed(out/'data.npz', f=FREQUENCIES, a=a, b=b, z_ref=z,
        voltage=np.array([p.uf_tot for p in ports]), current=np.array([p.if_tot for p in ports]))
    dt = float(np.diff(np.loadtxt(out/'raw/et', max_rows=2)[:, 0])[0])
    versions = {}
    for package in ('openEMS', 'CSXCAD'):
        try:
            versions[package] = version(package)
        except PackageNotFoundError:
            versions[package] = 'unavailable; see native log'
    meta = dict(protocol=PROTOCOL, geometry=geometry(), cpw=cpw, excited=excited,
        padding=padding, frequency_hz=FREQUENCIES.tolist(), limits=LIMITS,
        cells=int(np.prod([len(sim.mesh.GetLines(ax))-1 for ax in 'xyz'])),
        dt_s=dt, source_ids=source_ids(), excitation=sim.excitation,
        runtime_versions=versions, run=sim.run_stats)
    (out/'report.json').write_text(json.dumps(meta, indent=2)+'\n', encoding='utf-8')
    return meta
