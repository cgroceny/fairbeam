"""Uniform microstrip research control for Example 3.7 (p. 149).

Own thin-strip geometry, fixed before measurement. Native MSL excitations are
built inside Fairbeam's Simulation; independent closed current contours and
voltage probes separate propagation from launch effects. No gallery model,
production port API, design format or saved bundle is changed.
"""
import hashlib
import json
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

import numpy as np

from fairbeam import Simulation
from fairbeam import simulation as simulation_module
from fairbeam.analytic import microstrip_eps_eff, microstrip_z0
from openEMS.ports import UI_data
from openEMS.physical_constants import C0, EPS0, MUE0

H, W, ER, F0 = .5, .483, 9.9, 10e9
TAND, SIGMA, SHEET_T = .001, 5.8e7, .035
FREQUENCIES = np.linspace(.99*F0, 1.01*F0, 41)
KINDS = ('pec', 'dielectric', 'copper-sheet', 'both-sheet')
LENGTHS, RESOLUTIONS, STUDY_MESH = (4., 8.), (6, 8, 10, 12, 16), (6, 8, 10)
FEED_LENGTH, COMPARISON_LENGTH = 6., .00872
# Predeclared limits for these approximate thin-strip references, not all lines.
LIMITS = {'beta':(.03, .003, .002), 'z':(.02, .005, .002),
          'alpha':(.05, .02, .01)}


def reference(kind):
    if kind not in KINDS:
        raise ValueError('unknown loss case')
    eff, z0 = microstrip_eps_eff(ER, H, W), microstrip_z0(ER, H, W)
    k0 = 2*np.pi*FREQUENCIES/C0
    # The runtime's constant dielectric conductivity has this frequency-dependent
    # tangent. The approximate filling factor uses the quasi-static thin strip.
    tangent = TAND*F0/FREQUENCIES
    alpha_d = k0*ER*(eff-1)*tangent/(2*np.sqrt(eff)*(ER-1))
    resistance = np.sqrt(np.pi*FREQUENCIES*MUE0/SIGMA)
    alpha_c = resistance/(z0*W*1e-3)  # uniform-current, one-face approximation
    alpha = np.zeros_like(FREQUENCIES)
    if kind in ('dielectric', 'both-sheet'):
        alpha += alpha_d
    if kind in ('copper-sheet', 'both-sheet'):
        alpha += alpha_c
    return alpha+1j*k0*np.sqrt(eff), z0


def graded(span, first, maximum, ratio=1.25):
    """Capped geometric spacing; the final interval never exceeds the cap."""
    points, step = [0.], first
    while points[-1] < span:
        step = min(step, maximum)
        points.append(min(points[-1]+step, span))
        step *= ratio
    # Avoid an arbitrarily tiny remainder at the far boundary.
    if len(points) > 2 and points[-1]-points[-2] < first/2:
        points[-2] = (points[-3]+points[-1])/2
    return np.asarray(points)


def mesh_lines(n, length, air):
    dx, delta, maximum = 2/n, H/(6*n), 8*H/n
    x = dx*np.arange(int(-4/dx), int((length+16)/dx)+1)
    edge = W/2
    inner = edge-delta/3
    inside = inner-graded(inner, delta, maximum)[::-1]
    outside = edge+2*delta/3+graded(air-edge-2*delta/3, delta, maximum)
    positive = np.r_[inside, outside, air+maximum*np.arange(1, 9)]
    y = np.r_[-positive[:0:-1], positive]
    below = -graded(H, delta, H/n)[::-1]+H
    above = H+graded(air, delta, maximum)
    z = np.r_[-np.linspace(2., 0., 17)[:-1], below,
              above[1:], H+air+maximum*np.arange(1, 9)]
    return x, y, z


def build(n, length, kind='pec', excite=1, air=5.):
    if isinstance(n, bool) or n not in RESOLUTIONS:
        raise ValueError('resolution must be 6, 8, 10, 12 or 16')
    if length not in LENGTHS or kind not in KINDS or excite not in (1, 2):
        raise ValueError('supported length, loss case and excitation required')
    if not np.isfinite(air) or not 5 <= air <= 15:
        raise ValueError('air margin must be in 5..15 mm')
    x, y, z = mesh_lines(n, length, air)
    cells = int(np.prod([len(a)-1 for a in (x, y, z)]))
    if cells > 4_000_000:
        raise ValueError('microstrip research cell budget exceeded')
    sim = Simulation(.1*F0, 1.9*F0, excitation='dgauss', end_criteria_db=-70,
                     max_timesteps=2_000_000, boundaries=['PML_8']*6)
    for axis, lines in zip('xyz', (x, y, z)):
        sim.mesh.AddLine(axis, lines)
    dielectric = kind in ('dielectric', 'both-sheet')
    sim.dielectric('substrate', ER, tan_d=TAND if dielectric else 0,
                   tan_d_freq=F0).AddBox([x[0], y[0], 0], [x[-1], y[-1], H], priority=1)
    lossy = kind in ('copper-sheet', 'both-sheet')
    # Diagnostic scalar sheet: sigma/4 changes the native two-sided Re(Z)=Rs/2
    # to Rs. Unequal currents on the strip's two faces prevent interpreting this
    # as an opaque bulk conductor. It is not a bulk-copper validation case.
    strip = sim.metal('strip', conductivity=SIGMA/4 if lossy else None, thickness=SHEET_T)
    strip.AddBox([x[0], -W/2, H], [x[-1], W/2, H], priority=10)
    ground = sim.metal('ground', conductivity=SIGMA/4 if lossy else None, thickness=SHEET_T)
    ground.AddBox([x[0], y[0], 0], [x[-1], y[-1], 0], priority=10)
    # The unexcited end remains a uniform line into PML, without a lumped load.
    # These native research ports are not registered as exportable model ports.
    middle = (x[0]+x[-1])/2
    for port, a, b in ((1, x[0], middle), (2, x[-1], middle)):
        sim.fdtd.AddMSLPort(port, strip, [a, -W/2, H], [b, W/2, 0], 'x', 'z',
            excite=-1 if port == excite else 0, FeedShift=4., MeasPlaneShift=10., priority=10)
    # Raw feed planes are 1 mm from either source, modal planes are 6 mm away.
    # Raw-to-modal reference shifts therefore remove 5 mm at each end. Raw
    # planes may fail the matched-launch assumptions; no guard is loosened.
    centres = np.unique(np.r_[1., np.arange(6., 12.), FEED_LENGTH+length, length+11.])
    metal = np.flatnonzero(abs(y) <= W/2)
    lo, hi = metal[0], metal[-1]
    loop_y = (y[lo]-(y[lo]-y[lo-1])/2, y[hi]+(y[hi+1]-y[hi])/2)
    iz = int(np.flatnonzero(z == H)[0])
    loop_z = ((z[iz-1]+H)/2, (H+z[iz+1])/2)
    for p, centre in enumerate(centres):
        index = int(np.argmin(abs(x-centre)))
        if not np.isclose(x[index], centre, rtol=0, atol=1e-12):
            raise ValueError('measurement plane missed the uniform grid')
        for j, plane in enumerate(x[index-1:index+2]):
            sim.csx.AddProbe(f'v{p}_{j}', p_type=0).AddBox([plane, 0, H], [plane, 0, 0])
        # Use actual neighbouring mesh coordinates, including nonbinary dx,
        # rather than a nominal offset that can miss the dual grid by an ULP.
        dual = ((x[index-1]+x[index])/2, (x[index]+x[index+1])/2)
        for j, plane in enumerate(dual):
            sim.csx.AddProbe(f'i{p}_{j}', p_type=1, norm_dir=0).AddBox(
                [plane, loop_y[0], loop_z[0]], [plane, loop_y[1], loop_z[1]])
    return sim, centres


def local_line(v, i, dx):
    """Reflected uniform-line inversion with spatial stagger bias removed."""
    v, i = np.asarray(v), np.asarray(i)
    if (v.shape[-2:] != (3, len(FREQUENCIES)) or i.shape[-2:] != (2, len(FREQUENCIES))
            or v.shape[:-2] != i.shape[:-2] or not np.isfinite(dx) or dx <= 0
            or not np.isfinite(v).all() or not np.isfinite(i).all()):
        raise ValueError('three finite voltages and two currents at a positive spacing required')
    u, current = v[..., 1, :], i.mean(axis=-2)
    dv, di = np.diff(v[..., ::2, :], axis=-2)[..., 0, :]/(2*dx), np.diff(i, axis=-2)[..., 0, :]/dx
    if (np.any(abs(u) < .01*np.max(abs(v), axis=-2)) or np.any(abs(current) < .01*np.max(abs(i), axis=-2))
            or np.any(u == 0) or np.any(current == 0) or np.any(di == 0)):
        raise ValueError('singular or standing-wave-node inversion')
    gamma = 2/dx*np.arcsinh(dx*np.sqrt(dv*di/(u*current))/2)
    gamma = np.where(gamma.imag < 0, -gamma, gamma)
    impedance = np.sqrt(u*dv/(current*di))
    impedance = np.where(impedance.real < 0, -impedance, impedance)
    aligned_current = current/np.cosh(gamma*dx/2)
    return gamma, impedance, aligned_current


def triplets(v):
    u, rows, distance = np.asarray(v)[:6, 1, :], [], .002
    if u.shape != (6, len(FREQUENCIES)) or not np.isfinite(u).all():
        raise ValueError('six finite phase-plane spectra required')
    for offset in (0, 1):
        a, b, c = u[offset:offset+5:2]
        if np.any(b == 0) or np.any(abs(b) < .01*np.maximum(abs(a), abs(c))):
            raise ValueError('standing-wave node in phase triplet')
        g = np.arccosh((a+c)/(2*b))/distance
        rows.append(np.where(g.imag < 0, -g, g))
    return np.asarray(rows)


def scattering(v, current, z_ref):
    """Both excitation columns are needed; b/a is wrong if the other a != 0.

    v/current: (excitation, endpoint, frequency), currents positive into each
    end. A real common reference is explicit and unchanged between controls.
    """
    v, current = np.asarray(v), np.asarray(current)
    if (v.shape != (2, 2, len(FREQUENCIES)) or current.shape != v.shape
            or not np.isfinite(v).all() or not np.isfinite(current).all()
            or not np.isfinite(z_ref) or z_ref <= 0):
        raise ValueError('two finite excitation columns and real positive reference required')
    incoming = (v+z_ref*current)/(2*np.sqrt(z_ref))
    outgoing = (v-z_ref*current)/(2*np.sqrt(z_ref))
    a, b = incoming.transpose(2, 1, 0), outgoing.transpose(2, 1, 0)
    if np.any(np.linalg.cond(a) > 1e4):
        raise ValueError('ill-conditioned incoming-wave matrix')
    return np.linalg.solve(a.transpose(0, 2, 1), b.transpose(0, 2, 1)).transpose(0, 2, 1)


def acquire(out, n, length, kind, excite, air=5.):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sim, centres = build(n, length, kind, excite, air)
    sim.run(str(out/'raw'), threads=4, exact=True, echo=True)
    count = len(centres)
    v = np.asarray(UI_data([f'v{p}_{j}' for p in range(count) for j in range(3)],
                           str(out/'raw'), FREQUENCIES).ui_f_val).reshape(count, 3, -1)
    i = np.asarray(UI_data([f'i{p}_{j}' for p in range(count) for j in range(2)],
                           str(out/'raw'), FREQUENCIES).ui_f_val).reshape(count, 2, -1)
    local_gamma, impedance, current = local_line(v, i, 2/n*sim.unit)
    phase_planes = [int(np.flatnonzero(centres == p)[0]) for p in np.arange(6., 12.)]
    gamma = triplets(v[phase_planes])
    # Align raw and modal currents with the independently measured propagation
    # constant, rather than assuming local near-field curvature is a TEM mode.
    current = i.mean(axis=1)/np.cosh(gamma.mean(axis=0)*sim.unit/n)
    dt = float(np.diff(np.loadtxt(out/'raw/et', max_rows=2)[:, 0])[0])
    versions = {}
    for package in ('openEMS', 'CSXCAD'):
        try:
            versions[package] = version(package)
        except PackageNotFoundError:
            versions[package] = 'unavailable'
    np.savez_compressed(out/'data.npz', f=FREQUENCIES, centres=centres, v=v, i=i,
                        gamma=gamma, z=impedance, local_gamma=local_gamma, current=current)
    meta = dict(resolution=n, length_mm=length, kind=kind, excited_port=excite, air_mm=air,
                width_mm=W, substrate_mm=H, eps_r=ER, geometry_thickness_mm=0.,
                loss_tangent_at_f0=TAND if kind in ('dielectric', 'both-sheet') else 0.,
                loss_reference_hz=F0,
                sheet_thickness_mm=SHEET_T, conductivity_bulk_s_m=SIGMA,
                conductivity_sheet_s_m=SIGMA/4 if kind in ('copper-sheet', 'both-sheet') else None,
                frequency_hz=FREQUENCIES.tolist(), cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
                dt_s=dt, run=sim.run_stats, excitation=sim.excitation,
                runtime_versions=versions,
                simulation_sha256=hashlib.sha256(Path(simulation_module.__file__).read_bytes()).hexdigest(),
                fixture_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    (out/'report.json').write_text(json.dumps(meta, indent=2)+'\n', encoding='utf-8')
    return meta
