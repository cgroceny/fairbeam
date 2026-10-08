"""Nonuniform-line references, research measurement checks and opt-in FDTD."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import numpy as np

from fairbeam.network import network_s
from tests import taper_fixture as f


class UnqualifiedStop(ValueError):
    """Incomplete source or unconfirmed energy stop cannot qualify a result."""


def configurations():
    return [(n, False, f.DEFAULT_SLICES) for n in f.MESHES]+[
        (f.MESHES[1], True, f.DEFAULT_SLICES)]+[
        (f.MESHES[1], False, slices) for slices in f.SLICE_LEVELS[:-1]]


def cases(profiles=f.PROFILES):
    return [(n, profile, kind, c, expanded, slices) for profile in profiles
        for n, expanded, slices in configurations() for kind in f.KINDS for c in (0, 1)]


def case_path(root, n, profile, kind, column, expanded, slices=f.DEFAULT_SLICES):
    return Path(root)/profile/f'slices{slices}'/kind/f'n{n}'/('expanded' if expanded else 'nominal')/f'e{column+1}'


def read_case(path, n, profile, kind, column, expanded=False, slices=f.DEFAULT_SLICES):
    path = Path(path)
    meta = json.loads((path/'report.json').read_text(encoding='utf-8'))
    if any(meta.get(k) != v for k, v in f.identity(n, profile, kind, column, expanded, slices).items()):
        raise ValueError('acquisition source, model, references or protocol differ')
    sim = f.build(n, profile, kind, column, expanded, slices)
    run, dt = meta.get('run', {}), meta.get('dt_s')
    steps = run.get('timesteps')
    values = [dt, meta.get('pulse_end_s'), meta.get('case_elapsed_s'), run.get('wall_time_s')]
    energy = [run.get(k) for k in ('final_energy_db', 'final_energy_bound_db')]
    energy = [v for v in energy if isinstance(v, (int, float)) and not isinstance(v, bool) and np.isfinite(v)]
    if (any(isinstance(v, bool) or not isinstance(v, (int, float)) or not np.isfinite(v) or v <= 0 for v in values)
            or not energy or max(values[2:]) > f.CASE_SECONDS
            or isinstance(steps, bool) or not isinstance(steps, int) or not 0 < steps <= sim.max_timesteps
            or meta.get('cells') != int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz']))
            or run.get('threads') != f.THREADS or run.get('engine') != 'cpu'
            or run.get('exact_endcriteria') is not True
            or not np.isclose(dt, f.time_settings(n, profile, expanded, slices)[0], rtol=5e-6, atol=0)):
        raise ValueError('bounded finite metadata and declared native engine/timestep required')
    pulse = f.excitation.dgauss_duration_s(sim.f_max)
    if (run.get('converged') is not True or run.get('hit_timestep_limit') is not False
            or steps >= sim.max_timesteps or max(energy) > f.END_DB+1e-9
            or not np.isclose(values[1], pulse, rtol=1e-12, atol=0) or steps*dt < pulse):
        raise UnqualifiedStop('complete source and confirmed -90 dB stop required')
    if meta.get('input_sha256') != hashlib.sha256((path/'input.xml').read_bytes()).hexdigest():
        raise ValueError('stored native input changed')
    with np.load(path/'data.npz') as src:
        data = dict(src)
    size = len(f.FREQUENCIES)
    if (not np.array_equal(data.get('f'), f.FREQUENCIES)
            or any(k not in data or data[k].shape != shape or not np.isfinite(data[k]).all()
                   for k, shape in dict(v=(2, 2, 3, size), i=(2, 2, 2, size), i_check=(2, 2, 2, size)).items())):
        raise ValueError('finite spectra on the exact declared frequency grid required')
    return meta, data


def _line_calibration(columns, n, profile, ref, slices):
    """Two independent states/planes recover signed gamma and distinct Zc."""
    gammas, zs, residuals = [], [], []
    dx = f.H/n*1e-3
    for p in (0, 1):
        states = [np.asarray([[d['v'][p, q, 1]/np.sqrt(ref),
            d['i'][p, q].mean(axis=0)*np.sqrt(ref)] for d in columns]).transpose(2, 1, 0)
            for q in (0, 1)]
        if any(not np.isfinite(a).all() or np.max(np.linalg.cond(a)) > 10. for a in states):
            raise ValueError('ill-conditioned independent uniform-line states')
        transfer = np.linalg.solve(states[1].transpose(0, 2, 1), states[0].transpose(0, 2, 1)).transpose(0, 2, 1)
        length = (f.planes(profile, slices)[p][1]-f.planes(profile, slices)[p][0])*1e-3
        g = np.arccosh((transfer[:, 0, 0]+transfer[:, 1, 1])/2)/length
        g = np.where(g.imag < 0, -g, g)
        z = ref*np.sqrt(transfer[:, 0, 1]/transfer[:, 1, 0])*np.cosh(g*dx/2)
        z = np.where(z.real < 0, -z, z)
        if not np.isfinite(g).all() or not np.isfinite(z).all():
            raise ValueError('singular uniform-line inversion')
        gammas.append(g)
        zs.append(z)
        residuals.extend((np.max(abs(np.linalg.det(transfer)-1)),
                          np.max(abs(transfer[:, 0, 0]-transfer[:, 1, 1]))))
    gammas, zs = np.asarray(gammas), np.asarray(zs)
    g, z = gammas.mean(axis=0), zs.mean(axis=0)
    target = 2*np.pi*f.FREQUENCIES/f.C0*f.Z_LEFT/ref
    metrics = dict(calibration_beta_rel=float(np.max(abs(gammas.imag-target)/target)),
        calibration_z_rel=float(np.max(abs(zs-ref)/ref)),
        calibration_spread_rel=float(max(np.max(abs(gammas-g)/abs(g)), np.max(abs(zs-z)/abs(z)))),
        calibration_transfer_abs=float(max(residuals)))
    return g, z, metrics


def calibration(controls, n, profile, slices=f.DEFAULT_SLICES):
    gamma, zc, metrics = {}, {}, []
    for kind, ref in (('line100', f.Z_LEFT), ('line50', f.Z_RIGHT)):
        gamma[kind], zc[kind], row = _line_calibration(controls[kind], n, profile, ref, slices)
        metrics.append(row)
    return gamma, zc, {key: max(row[key] for row in metrics) for key in metrics[0]}


def measurement(columns, n, profile, kind, gamma, zc, slices=f.DEFAULT_SLICES):
    refs = f.port_spec(kind)
    control_kinds = ['line100' if z == f.Z_LEFT else 'line50' for z in refs]
    g, z = np.asarray([gamma[k] for k in control_kinds]), np.asarray([zc[k] for k in control_kinds])
    matrices, conditions = [], []
    dx = f.H/n*1e-3
    for q in (0, 1):
        a, b = [], []
        for data in columns:
            voltage = data['v'][:, q, 1]
            current = data['i'][:, q].mean(axis=1)/np.cosh(g*dx/2)
            current *= np.array([1., -1.])[:, None]
            distance = np.asarray([abs(f.planes(profile, slices)[p][q]-f.targets(profile, slices)[p])*1e-3
                                   for p in (0, 1)])[:, None]
            ch, sh = np.cosh(g*distance), np.sinh(g*distance)
            u, i = voltage*ch-z*current*sh, current*ch-voltage/z*sh
            a.append((u+refs[:, None]*i)/(2*np.sqrt(refs[:, None])))
            b.append((u-refs[:, None]*i)/(2*np.sqrt(refs[:, None])))
        a, b = np.asarray(a).transpose(2, 1, 0), np.asarray(b).transpose(2, 1, 0)
        condition = np.linalg.cond(a)
        if not np.isfinite(condition).all() or np.max(condition) > 10.:
            raise ValueError('ill-conditioned incident-wave excitation matrix')
        matrices.append(np.linalg.solve(a.transpose(0, 2, 1), b.transpose(0, 2, 1)).transpose(0, 2, 1))
        conditions.append(float(np.max(condition)))
    s = np.mean(matrices, axis=0)
    zin, reflection = f.input_impedance(s, kind)
    target = f.reference(profile, kind, slices)
    zt, rt = f.input_impedance(target, kind)
    metrics = dict(s_target_abs=float(np.max(abs(s-target))),
        gamma_target_abs=float(np.max(abs(reflection-rt))),
        z_target_rel=float(np.max(abs(zin-zt)/np.maximum(abs(zt), refs[0]))),
        power_abs=float(np.max(abs(s.conj().transpose(0, 2, 1)@s-np.eye(2)))),
        reciprocity_abs=float(np.max(abs(s[:, 0, 1]-s[:, 1, 0]))),
        plane_spread_abs=float(np.max(abs(matrices[0]-matrices[1]))),
        current_strip_spread_rel=float(max(np.max(abs(d['i'][p]-d['i_check'][p]))/np.max(abs(d['i'][p]))
            for d in columns for p in (0, 1))))
    if kind == 'taper':
        continuum = f.continuum_reference(profile)
        zc_ref, rc_ref = f.input_impedance(continuum, kind)
        metrics.update(continuum_s_target_abs=float(np.max(abs(s-continuum))),
            continuum_gamma_target_abs=float(np.max(abs(reflection-rc_ref))),
            continuum_z_target_rel=float(np.max(abs(zin-zc_ref)/np.maximum(abs(zc_ref), refs[0]))))
    return s, zin, reflection, None, metrics, max(conditions)


def differences(a, b, suffix, kind):
    metrics = {f's_{suffix}_abs': float(np.max(abs(a[1]-b[1]))),
        f'gamma_{suffix}_abs': float(np.max(abs(a[3]-b[3]))),
        f'z_{suffix}_rel': float(np.max(abs(a[2]-b[2])/np.maximum(abs(b[2]), f.port_spec(kind)[0])))}
    return metrics


def compare(root, profiles=f.PROFILES):
    records, missing, rejected = {}, [], []
    for key in cases(profiles):
        path = case_path(root, *key)
        if not (path/'report.json').is_file():
            missing.append(str(path.relative_to(root)))
            continue
        try:
            records[key] = read_case(path, *key)
        except UnqualifiedStop as error:
            rejected.append(dict(mesh=key[0], profile=key[1], kind=key[2], column=key[3],
                expanded=key[4], slices=key[5], reason=str(error)))
    evaluated, rows = {}, []
    for profile in profiles:
        for n, expanded, slices in configurations():
            control_keys = [(n, profile, kind, c, expanded, slices) for kind in f.KINDS[:2] for c in (0, 1)]
            if not all(k in records for k in control_keys):
                continue
            gamma, zc, cal = calibration({kind: [records[n, profile, kind, c, expanded, slices][1]
                for c in (0, 1)] for kind in f.KINDS[:2]}, n, profile, slices)
            for kind in f.KINDS:
                keys = [(n, profile, kind, c, expanded, slices) for c in (0, 1)]
                if not all(k in records for k in keys):
                    continue
                s, zin, reflection, edges, metrics, condition = measurement(
                    [records[k][1] for k in keys], n, profile, kind, gamma, zc, slices)
                quality = {**cal, **metrics}
                zt, _ = f.input_impedance(f.reference(profile, kind, slices), kind)
                row = dict(mesh=n, profile=profile, slices=slices, kind=kind, expanded=expanded,
                    metrics=quality, max_incident_condition=condition,
                    passes=bool(all(v <= f.LIMITS[k] for k, v in quality.items())),
                    samples=[dict(f_ghz=float(f.FREQUENCIES[k]/1e9), theta=float(f.THETA[k]),
                        z_ohm=[float(zin[k].real), float(zin[k].imag)],
                        target_ohm=[float(zt[k].real), float(zt[k].imag)],
                        gamma_abs=float(abs(reflection[k]))) for k in f.SAMPLE_INDICES])
                if kind == 'taper':
                    approximation = f.small_reflection(profile)
                    row.update(small_reflection_gamma_error=float(np.max(abs(reflection-approximation))),
                        continuum_small_reflection_gamma_error=float(np.max(abs(
                            f.continuum_reference(profile)[:, 0, 0]-approximation))),
                        sampled_passband_peak=float(np.max(abs(reflection[f.THETA >= f.A]))),
                        strict_sampled_klopfenstein_limit_met=(bool(np.all(abs(reflection[f.THETA >= f.A])
                            <= f.GAMMA_MAX)) if profile == 'klopfenstein' else None))
                evaluated[profile, n, kind, expanded, slices] = row, s, zin, reflection, edges
                rows.append(row)
    accepted, controls = [], []
    for profile in profiles:
        qualified = []
        for kind in f.KINDS:
            nominal = [(profile, n, kind, False, f.DEFAULT_SLICES) for n in f.MESHES]
            changes = [differences(evaluated[a], evaluated[b], 'mesh', kind)
                for a, b in zip(nominal[:-1], nominal[1:]) if a in evaluated and b in evaluated]
            a, b = (profile, f.MESHES[1], kind, False, f.DEFAULT_SLICES), (profile, f.MESHES[1], kind, True, f.DEFAULT_SLICES)
            boundary = differences(evaluated[a], evaluated[b], 'boundary', kind) if a in evaluated and b in evaluated else None
            slicing = [(profile, f.MESHES[1], kind, False, count) for count in f.SLICE_LEVELS]
            profile_changes = [differences(evaluated[a], evaluated[b], 'profile', kind)
                for a, b in zip(slicing[:-1], slicing[1:]) if a in evaluated and b in evaluated]
            required = [(profile, n, kind, expanded, slices) for n, expanded, slices in configurations()]
            passes = (all(k in evaluated and evaluated[k][0]['passes'] for k in required)
                and len(changes) == 2 and all(v <= f.LIMITS[k] for c in changes for k, v in c.items())
                and boundary is not None and all(v <= f.LIMITS[k] for k, v in boundary.items())
                and len(profile_changes) == 2 and all(v <= f.LIMITS[k] for c in profile_changes for k, v in c.items()))
            controls.append(dict(profile=profile, kind=kind, mesh_changes=changes,
                profile_changes=profile_changes, boundary=boundary, passes=bool(passes)))
            if passes:
                qualified.append(kind)
        if len(qualified) == len(f.KINDS):
            accepted.append(profile)
    return dict(protocol=f.PROTOCOL, rows=rows, controls=controls, missing_cases=missing, rejected_cases=rejected,
        qualified_profiles=accepted, qualified_scope=bool(profiles) and not missing and not rejected
            and len(accepted) == len(profiles),
        scope='sampled nonuniform scalar-dielectric PEC/PMC TEM numerical agreement; no strict ripple, PCB or Designer claim')


class TaperControls(unittest.TestCase):
    def test_profile_endpoint_steps_symmetry_and_bessel_integral(self):
        self.assertAlmostEqual(float(f.phi(1.)), (np.cosh(f.A)-1)/f.A**2, places=14)
        u = np.linspace(0, 1, 101)
        for profile in f.PROFILES:
            z = f.impedance(profile, u)
            self.assertTrue(np.all(np.diff(z) < 0))
            np.testing.assert_allclose(z*z[::-1], f.Z_LEFT*f.Z_RIGHT, rtol=2e-15)
            endpoints = [f.Z_LEFT, f.Z_RIGHT] if profile != 'klopfenstein' else [
                f.Z_LEFT*np.exp(-f.GAMMA_MAX), f.Z_RIGHT*np.exp(f.GAMMA_MAX)]
            np.testing.assert_allclose(z[[0,-1]], endpoints, rtol=2e-15)
            for count in f.SLICE_LEVELS:
                lengths, _ = f.dimensions(profile, count)
                np.testing.assert_allclose(lengths*1e-3*f.Z_LEFT/f.sections(profile,count)/f.C0,
                    f.DELAY/count, rtol=3e-15)

    def test_continuum_reference_against_closed_exponential_and_refinement(self):
        theta, a = f.THETA, np.log(f.Z_RIGHT/f.Z_LEFT)
        q = np.sqrt((theta*theta-a*a/4).astype(complex))
        ratio = np.sinc(q/np.pi)
        matrix = np.empty((len(theta),2,2), complex)
        matrix[:,0,0] = np.sqrt(f.Z_LEFT/f.Z_RIGHT)*(np.cos(q)+a*ratio/2)
        matrix[:,1,1] = np.sqrt(f.Z_RIGHT/f.Z_LEFT)*(np.cos(q)-a*ratio/2)
        matrix[:,0,1] = 1j*theta*ratio*np.sqrt(f.Z_LEFT*f.Z_RIGHT)
        matrix[:,1,0] = 1j*theta*ratio/np.sqrt(f.Z_LEFT*f.Z_RIGHT)
        np.testing.assert_allclose(f.continuum_reference('exponential'),
            f._power_waves(matrix,f.port_spec('taper')), atol=2e-10, rtol=0)
        for profile in f.PROFILES:
            exact = f.continuum_reference(profile)
            np.testing.assert_allclose(exact,f.continuum_reference(profile,4096),atol=2e-10,rtol=0)
            np.testing.assert_allclose(exact.conj().transpose(0,2,1)@exact,
                np.broadcast_to(np.eye(2),exact.shape),atol=1e-11,rtol=0)
            self.assertLess(np.max(abs(exact[:,0,1]-exact[:,1,0])),1e-11)
            discrete = [f.reference(profile,'taper',n) for n in f.SLICE_LEVELS]
            errors = [float(np.max(abs(s-exact))) for s in discrete]
            self.assertLess(errors[1], errors[0]/3)
            self.assertLess(errors[2], errors[1]/3)

    def test_piecewise_reference_against_independent_nodal_network(self):
        count = 32
        freq = f.FREQUENCIES[list(f.SAMPLE_INDICES)]
        for profile in f.PROFILES:
            z = f.sections(profile,count)
            actual = network_s(freq,[0,count],[(k,k+1,float(v),f.DELAY/count)
                for k,v in enumerate(z)],z_ref=[f.Z_LEFT,f.Z_RIGHT])
            np.testing.assert_allclose(actual,f.reference(profile,'taper',count,freq),atol=3e-14,rtol=0)

    def test_small_reflection_is_separate_from_exact_line_and_strict_limit(self):
        for profile in f.PROFILES:
            self.assertGreater(np.max(abs(f.small_reflection(profile)-f.continuum_reference(profile)[:,0,0])),.01)
        self.assertTrue(np.max(abs(f.small_reflection('klopfenstein')[f.THETA>=f.A])) <= f.GAMMA_MAX*(1+1e-14))
        self.assertGreater(np.max(abs(f.continuum_reference('klopfenstein')[f.THETA>=f.A,0,0])),f.GAMMA_MAX)
        self.assertLess(abs(f.small_reflection('exponential')[f.SAMPLE_INDICES[1]]),1e-15)
        self.assertLess(abs(f.small_reflection('triangular')[f.SAMPLE_INDICES[2]]),1e-15)

    def test_bad_inputs_and_immutable_design(self):
        for bad in (None,True,'other'):
            with self.assertRaises(ValueError):
                f.sections(bad)
        for bad in (True,32.,0,16):
            with self.assertRaises(ValueError):
                f.sections('exponential',bad)
        with self.assertRaises(ValueError):
            f.sections('exponential')[0]=1.
        with self.assertRaises(ValueError):
            f.build(True,'exponential','taper')

    def test_shared_mesh_scalar_dielectric_and_conservative_step(self):
        self.assertGreater(f.C0/(2*f.W*1e-3*2),f.FREQUENCIES[-1])
        for profile in f.PROFILES:
            for n,expanded,count in configurations():
                sims=[f.build(n,profile,kind,expanded=expanded,slices=count) for kind in f.KINDS]
                axes=[sims[0].mesh.GetLines(a) for a in 'xyz']
                for sim in sims[1:]:
                    for a,values in zip('xyz',axes):
                        np.testing.assert_array_equal(sim.mesh.GetLines(a),values)
                dt,steps=f.time_settings(n,profile,expanded,count)
                self.assertLess(dt,sims[0].cfl_timestep())
                self.assertGreaterEqual(dt*steps,f.CAP_NS*1e-9)
                for centres in f.planes(profile,count):
                    for centre in centres:
                        ix=int(np.flatnonzero(axes[0]==centre)[0])
                        np.testing.assert_allclose(np.diff(axes[0][ix-1:ix+2]),f.H/n,atol=3e-14,rtol=0)
                with tempfile.TemporaryDirectory() as temp:
                    path=Path(temp)/'input.xml'
                    sims[2].fdtd.Write2XML(str(path))
                    materials=ET.parse(path).getroot().findall('.//Properties/Material')
                self.assertEqual(len(materials),count+2)
                epsilon=np.r_[1.,(f.Z_LEFT/f.sections(profile,count))**2,(f.Z_LEFT/f.Z_RIGHT)**2]
                for material,er in zip(materials,epsilon):
                    self.assertEqual(material.attrib['Isotropy'],'1')
                    props=material.find('Property').attrib
                    np.testing.assert_allclose(float(props['Epsilon'].split(',')[0]),er,rtol=5e-7)
                    self.assertEqual(float(props['Mue'].split(',')[0]),1.)
                    np.testing.assert_array_equal([float(v) for v in props['Kappa'].split(',')],[0.,0.,0.])

    def test_two_distinct_speeds_signed_loss_and_independent_states(self):
        controls = {}
        for kind, ref in (('line100', f.Z_LEFT), ('line50', f.Z_RIGHT)):
            g, z = -.03+2j*np.pi*f.FREQUENCIES/f.C0*f.Z_LEFT/ref, ref*(1.001+.0001j)
            columns, dx = [], f.H/8*1e-3
            for forward, backward in ((1., .3-.2j), (.2+.1j, 1.2)):
                v, i = np.empty((2, 2, 3, len(f.FREQUENCIES)), complex), np.empty((2, 2, 2, len(f.FREQUENCIES)), complex)
                for p in (0, 1):
                    for q, centre in enumerate(f.planes('klopfenstein')[p]):
                        for j, shift in enumerate((-dx, 0., dx)):
                            x = centre*1e-3+shift
                            v[p, q, j] = forward*np.exp(-g*x)+backward*np.exp(g*x)
                        for j, shift in enumerate((-dx/2, dx/2)):
                            x = centre*1e-3+shift
                            i[p, q, j] = (forward*np.exp(-g*x)-backward*np.exp(g*x))/z
                columns.append(dict(v=v, i=i))
            controls[kind] = columns
        gamma, zc, _ = calibration(controls, 8, 'klopfenstein')
        for kind, ref in (('line100', f.Z_LEFT), ('line50', f.Z_RIGHT)):
            np.testing.assert_allclose(gamma[kind], -.03+2j*np.pi*f.FREQUENCIES/f.C0*f.Z_LEFT/ref, atol=5e-12, rtol=0)
            np.testing.assert_allclose(zc[kind], ref*(1.001+.0001j), atol=2e-12, rtol=0)
        with self.assertRaises(ValueError):
            calibration({k: [v[0], v[0]] for k, v in controls.items()}, 8, 'klopfenstein')


    def synthetic(self, root, profile='klopfenstein'):
        for n, profile, kind, c, expanded, slices in cases((profile,)):
            path = case_path(root, n, profile, kind, c, expanded, slices)
            path.mkdir(parents=True)
            sim = f.build(n, profile, kind, c, expanded, slices)
            refs, s, dx = f.port_spec(kind), f.reference(profile, kind, slices), f.H/n*1e-3
            g = 2j*np.pi*f.FREQUENCIES/f.C0*f.Z_LEFT/refs[:, None]
            ar = np.zeros((2, len(f.FREQUENCIES)), complex)
            ar[c], ar[1-c] = 1., .07+.02j
            br = np.einsum('fij,jf->if', s, ar)
            ur, ir = np.sqrt(refs[:, None])*(ar+br), (ar-br)/np.sqrt(refs[:, None])
            v, i = np.empty((2, 2, 3, len(f.FREQUENCIES)), complex), np.empty((2, 2, 2, len(f.FREQUENCIES)), complex)
            for p in (0, 1):
                for q, centre in enumerate(f.planes(profile,slices)[p]):
                    for j, shift in enumerate((-dx, 0., dx)):
                        dist = abs(centre*1e-3+shift-f.targets(profile,slices)[p]*1e-3)
                        v[p, q, j] = ur[p]*np.cosh(g[p]*dist)+refs[p]*ir[p]*np.sinh(g[p]*dist)
                    for j, shift in enumerate((-dx/2, dx/2)):
                        dist = abs(centre*1e-3+shift-f.targets(profile,slices)[p]*1e-3)
                        i[p, q, j] = (1 if p == 0 else -1)*(ir[p]*np.cosh(g[p]*dist)+ur[p]/refs[p]*np.sinh(g[p]*dist))
            np.savez(path/'data.npz', f=f.FREQUENCIES, v=v, i=i, i_check=i.copy())
            sim.fdtd.Write2XML(str(path/'input.xml'))
            pulse, dt = f.excitation.dgauss_duration_s(sim.f_max), f.time_settings(n, profile, expanded, slices)[0]
            meta = dict(**f.identity(n, profile, kind, c, expanded, slices), dt_s=dt, pulse_end_s=pulse,
                cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])), case_elapsed_s=1.,
                input_sha256=hashlib.sha256((path/'input.xml').read_bytes()).hexdigest(),
                run=dict(engine='cpu', threads=f.THREADS, wall_time_s=.5,
                    timesteps=int(np.ceil(pulse/dt))+100, converged=True, hit_timestep_limit=False,
                    exact_endcriteria=True, final_energy_bound_db=f.END_DB))
            (path/'report.json').write_text(json.dumps(meta), encoding='utf-8')


    def test_full_synthetic_cohort_mixed_incident_unequal_waves(self):
        with tempfile.TemporaryDirectory() as root:
            self.synthetic(root)
            result = compare(root, ('klopfenstein',))
            self.assertTrue(result['qualified_scope'])
            self.assertEqual(result['qualified_profiles'], ['klopfenstein'])
            self.assertLess(max(r['metrics']['s_target_abs'] for r in result['rows']), 3e-12)
            self.assertTrue(all(r['strict_sampled_klopfenstein_limit_met'] is False
                for r in result['rows'] if r['kind'] == 'taper'))
            self.assertFalse(compare(root)['qualified_scope'])

    def test_missing_profile_control_blocks_qualification(self):
        with tempfile.TemporaryDirectory() as root:
            self.synthetic(root)
            (case_path(root, 12, 'klopfenstein', 'line50', 0, False, 32)/'report.json').unlink()
            self.assertFalse(compare(root, ('klopfenstein',))['qualified_scope'])


    def test_source_energy_metadata_references_hash_and_deadline_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            self.synthetic(root)
            path = case_path(root, 8, 'klopfenstein', 'taper', 0, False)/'report.json'
            original = json.loads(path.read_text())
            for flaw in ('source', 'energy', 'dt', 'refs', 'hash', 'deadline'):
                bad = json.loads(json.dumps(original))
                if flaw == 'source':
                    bad['run']['timesteps'] = int(np.ceil(bad['pulse_end_s']/bad['dt_s']))-1
                elif flaw == 'energy':
                    bad['run']['converged'] = False
                elif flaw == 'dt':
                    bad['dt_s'] *= 1.01
                elif flaw == 'refs':
                    bad['reference_ohm'][1] = 100.
                elif flaw == 'hash':
                    bad['input_sha256'] = 'stale'
                else:
                    bad['case_elapsed_s'] = f.CASE_SECONDS+1
                path.write_text(json.dumps(bad), encoding='utf-8')
                with self.subTest(flaw=flaw), self.assertRaises(ValueError):
                    read_case(path.parent, 8, 'klopfenstein', 'taper', 0)
                if flaw in ('source', 'energy'):
                    self.assertFalse(compare(root, ('klopfenstein',))['qualified_scope'])
            path.write_text(json.dumps(original), encoding='utf-8')


    def test_missing_fine_and_nonreciprocal_column_block_acceptance(self):
        with tempfile.TemporaryDirectory() as root:
            self.synthetic(root)
            path = case_path(root, 12, 'klopfenstein', 'taper', 1, True)/'data.npz'
            with np.load(path) as src:
                data = dict(src)
            data['v'][0] *= 1.1
            data['i'][0] *= 1.1
            np.savez(path, **data)
            self.assertFalse(compare(root, ('klopfenstein',))['qualified_scope'])
            (case_path(root, 16, 'klopfenstein', 'line50', 0, False)/'report.json').unlink()
            self.assertFalse(compare(root, ('klopfenstein',))['qualified_scope'])


    def test_independent_current_contour_is_required(self):
        with tempfile.TemporaryDirectory() as root:
            self.synthetic(root)
            path = case_path(root, 12, 'klopfenstein', 'taper', 0, True)/'data.npz'
            with np.load(path) as src:
                data = dict(src)
            data['i_check'][0] *= 1.01
            np.savez(path, **data)
            self.assertFalse(compare(root, ('klopfenstein',))['qualified_scope'])


    def test_suspend_deadline_cleans_up_only_owned_worker(self):
        class Process:
            pid, win_job, running = 123, object(), True
            def wait(self, timeout):
                if self.running:
                    raise subprocess.TimeoutExpired('owned-worker', timeout)
                return 1
            def poll(self):
                return None if self.running else 1
        process = Process()
        def stop(*args, **kwargs):
            process.running = False
        with tempfile.TemporaryDirectory() as root, patch.object(f, 'popen_group', return_value=process), \
                patch.object(f, 'terminate_group', side_effect=stop) as terminate, \
                patch.object(f, 'release_group') as release, \
                patch.object(f, 'clocks', side_effect=[(0., 0.), (.1, f.CASE_SECONDS+1)]):
            with self.assertRaises(TimeoutError):
                f.serial(Path(root)/'case', 8, 'klopfenstein', 'taper')
            terminate.assert_called_once_with(process.pid, grace=0, job=process.win_job)
            release.assert_called_once_with(process)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    mode=parser.add_mutually_exclusive_group()
    for name in ('preflight','fdtd','study','compare'):
        mode.add_argument('--'+name,action='store_true')
    parser.add_argument('--out',type=Path)
    parser.add_argument('--mesh',type=int,choices=f.MESHES,default=f.MESHES[0])
    parser.add_argument('--profile',choices=f.PROFILES)
    parser.add_argument('--slices',type=int,choices=f.SLICE_LEVELS,default=f.DEFAULT_SLICES)
    parser.add_argument('--kind',choices=f.KINDS,default='taper')
    parser.add_argument('--column',type=int,choices=(0,1),default=0)
    parser.add_argument('--expanded',action='store_true')
    parser.add_argument('--coarse-only',action='store_true',help='partial nominal cohort; cannot qualify convergence')
    parser.add_argument('--worker',action='store_true',help=argparse.SUPPRESS)
    args=parser.parse_args()
    profile=args.profile or 'klopfenstein'
    profiles=(args.profile,) if args.profile else f.PROFILES
    if args.worker and not args.fdtd:
        parser.error('internal worker requires --fdtd')
    if args.coarse_only and not args.study:
        parser.error('--coarse-only requires --study')
    if args.preflight:
        for p in profiles:
            for n,expanded,count in configurations():
                sim=f.build(n,p,args.kind,args.column,expanded,count)
                dt,steps=f.time_settings(n,p,expanded,count)
                print(json.dumps(dict(profile=p,mesh=n,expanded=expanded,slices=count,
                    cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
                    native_grid_entries=int(np.prod([len(sim.mesh.GetLines(a)) for a in 'xyz'])),
                    requested_dt_ps=dt*1e12,cfl_dt_ps=sim.cfl_timestep()*1e12,max_steps=steps,
                    pulse_end_s=f.excitation.dgauss_duration_s(sim.f_max),length_mm=f.targets(p,count)[1])))
    elif args.fdtd or args.study or args.compare:
        if args.out is None:
            parser.error('--out is required')
        if args.compare:
            result=compare(args.out,profiles)
            (args.out/'comparison.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
            print(json.dumps(result,indent=2))
        elif args.fdtd:
            print(json.dumps((f.acquire if args.worker else f.serial)(args.out,args.mesh,profile,
                args.kind,args.column,args.expanded,args.slices)))
        else:
            frozen=f.source_ids()
            for key in cases(profiles):
                if args.coarse_only and (key[0]!=f.MESHES[0] or key[4] or key[5]!=f.DEFAULT_SLICES):
                    continue
                if f.source_ids()!=frozen:
                    raise RuntimeError('source changed during acquisition')
                path=case_path(args.out,*key)
                if not path.exists():
                    f.serial(path,*key)
                try:
                    read_case(path,*key)
                    print(json.dumps(dict(profile=key[1],mesh=key[0],kind=key[2],column=key[3],slices=key[5],complete=True)),flush=True)
                except UnqualifiedStop as error:
                    print(json.dumps(dict(profile=key[1],mesh=key[0],kind=key[2],column=key[3],slices=key[5],rejected=True,reason=str(error))),flush=True)
    else:
        unittest.main(argv=[__name__])


if __name__=='__main__':
    main()
