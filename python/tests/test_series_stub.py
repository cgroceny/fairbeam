"""Pure TEM references and explicitly opt-in native two-port acquisition."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from fairbeam.network import network_s
from tests import series_stub_fixture as f


class UnqualifiedStop(ValueError):
    """Incomplete source or unconfirmed energy stop; never accepted as data."""


def cases():
    return [(n, kind, c, False) for n in f.MESHES for kind in f.KINDS for c in (0, 1)]+[
        (f.MESHES[1], kind, c, True) for kind in f.KINDS for c in (0, 1)]


def case_path(root, n, kind, column, expanded):
    return Path(root)/kind/f'n{n}'/('expanded' if expanded else 'nominal')/f'e{column+1}'


def read_case(path, n, kind, column, expanded=False):
    path = Path(path)
    meta = json.loads((path/'report.json').read_text(encoding='utf-8'))
    if any(meta.get(k) != v for k, v in f.identity(n, kind, column, expanded).items()):
        raise ValueError('acquisition source, model or protocol differs')
    sim = f.build(n, kind, column, expanded)
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
            or run.get('exact_endcriteria') is not True):
        raise ValueError('bounded finite native metadata and declared engine required')
    pulse = f.excitation.dgauss_duration_s(sim.f_max)
    if (run.get('converged') is not True or run.get('hit_timestep_limit') is not False
            or steps >= sim.max_timesteps or max(energy) > f.END_DB+1e-9
            or not np.isclose(values[1], pulse, rtol=1e-12, atol=0) or steps*dt < pulse):
        raise UnqualifiedStop('complete source and confirmed -90 dB stop required')
    if meta.get('input_sha256') != hashlib.sha256((path/'input.xml').read_bytes()).hexdigest():
        raise ValueError('stored native input changed')
    with np.load(path/'data.npz') as src:
        data = dict(src)
    if (not np.array_equal(data.get('f'), f.FREQUENCIES)
            or any(k not in data or data[k].shape != shape or not np.isfinite(data[k]).all()
                   for k, shape in dict(v=(2, 2, 3, 101), i=(2, 2, 2, 101), i_check=(2, 2, 2, 101)).items())):
        raise ValueError('finite spectra on the exact declared frequency grid required')
    return meta, data


def calibration(columns, n):
    values = [f.line_parameters(d['v'], d['i'], f.H/n*1e-3) for d in columns]
    gammas, zs = np.asarray([v[0] for v in values]), np.asarray([v[1] for v in values])
    g, z = gammas.mean(axis=(0, 1, 2)), zs.mean(axis=(0, 1, 2))
    target = 2*np.pi*f.FREQUENCIES/299792458.
    metrics = dict(calibration_beta_rel=float(np.max(abs(gammas.imag-target)/target)),
        calibration_z_rel=float(np.max(abs(zs-f.Z0)/f.Z0)),
        calibration_spread_rel=float(max(np.max(abs(gammas-g)/abs(g)), np.max(abs(zs-z)/abs(z)))))
    return g, z, metrics


def measurement(columns, n, kind, gamma, zc):
    """General ABCD plane inversion and B @ inv(A), with two incident columns."""
    matrices, conditions = [], []
    for q in (0, 1):
        a, b = [], []
        for data in columns:
            voltage = data['v'][:, q, 1]
            current = data['i'][:, q].mean(axis=1)/np.cosh(gamma*f.H/n*1e-3/2)
            current = current*np.array([1., -1.])[:, None]
            distance = np.asarray([abs(f.PLANES[p][q]-f.TARGETS[p])*1e-3 for p in (0, 1)])[:, None]
            ch, sh = np.cosh(gamma*distance), np.sinh(gamma*distance)
            u = voltage*ch-zc*current*sh
            i = current*ch-voltage/zc*sh
            a.append((u+f.Z0*i)/(2*np.sqrt(f.Z0)))
            b.append((u-f.Z0*i)/(2*np.sqrt(f.Z0)))
        a, b = np.asarray(a).transpose(2, 1, 0), np.asarray(b).transpose(2, 1, 0)
        condition = np.linalg.cond(a)
        if not np.isfinite(condition).all() or np.max(condition) > 10.:
            raise ValueError('ill-conditioned incident-wave excitation matrix')
        matrices.append(np.linalg.solve(a.transpose(0, 2, 1), b.transpose(0, 2, 1)).transpose(0, 2, 1))
        conditions.append(float(np.max(condition)))
    s = np.mean(matrices, axis=0)
    zin, reflection = f.terminate(s)
    target = f.reference(kind)
    zt, rt = f.terminate(target)
    balance = s.conj().transpose(0, 2, 1) @ s-np.eye(2)
    metrics = dict(s_target_abs=float(np.max(abs(s-target))),
        gamma_target_abs=float(np.max(abs(reflection-rt))),
        z_target_rel=float(np.max(abs(zin-zt)/np.maximum(abs(zt), f.Z0))),
        power_abs=float(np.max(abs(balance))),
        reciprocity_abs=float(np.max(abs(s[:, 0, 1]-s[:, 1, 0]))),
        plane_spread_abs=float(np.max(abs(matrices[0]-matrices[1]))),
        current_strip_spread_rel=float(max(np.max(abs(d['i']-d['i_check']))/np.max(abs(d['i'])) for d in columns)))
    return s, zin, reflection, metrics, max(conditions)


def compare(root):
    records, missing, rejected = {}, [], []
    for key in cases():
        path = case_path(root, *key)
        if not (path/'report.json').is_file():
            missing.append(str(path.relative_to(root)))
            continue
        try:
            records[key] = read_case(path, *key)
        except UnqualifiedStop as error:
            rejected.append(dict(mesh=key[0], kind=key[1], column=key[2], expanded=key[3], reason=str(error)))
    evaluated, rows = {}, []
    for n, expanded in [(n, False) for n in f.MESHES]+[(f.MESHES[1], True)]:
        controls = [(n, 'through', c, expanded) for c in (0, 1)]
        if not all(k in records for k in controls):
            continue
        g, z, cal = calibration([records[k][1] for k in controls], n)
        for kind in f.KINDS:
            keys = [(n, kind, c, expanded) for c in (0, 1)]
            if not all(k in records for k in keys):
                continue
            s, zin, reflection, metrics, cond = measurement([records[k][1] for k in keys], n, kind, g, z)
            quality = {**cal, **metrics}
            row = dict(mesh=n, kind=kind, expanded=expanded, metrics=quality,
                max_incident_condition=cond, passes=bool(all(v <= f.LIMITS[k] for k, v in quality.items())),
                samples=[dict(f_ghz=float(f.FREQUENCIES[k]/1e9),
                    z_ohm=[float(zin[k].real), float(zin[k].imag)],
                    target_ohm=[float(v) for v in (f.terminate(f.reference(kind))[0][k].real,
                                                  f.terminate(f.reference(kind))[0][k].imag)],
                    gamma_abs=float(abs(reflection[k]))) for k in (0, 25, 50, 75, 100)])
            evaluated[n, kind, expanded] = row, s, reflection
            rows.append(row)
    qualified, controls = [], []
    for kind in f.KINDS:
        nominal = [(n, kind, False) for n in f.MESHES]
        changes = []
        for a, b in zip(nominal[:-1], nominal[1:]):
            if a in evaluated and b in evaluated:
                changes.append(dict(s_mesh_abs=float(np.max(abs(evaluated[a][1]-evaluated[b][1]))),
                    gamma_mesh_abs=float(np.max(abs(evaluated[a][2]-evaluated[b][2])))))
        a, b = (f.MESHES[1], kind, False), (f.MESHES[1], kind, True)
        boundary = None
        if a in evaluated and b in evaluated:
            boundary = dict(s_boundary_abs=float(np.max(abs(evaluated[a][1]-evaluated[b][1]))),
                gamma_boundary_abs=float(np.max(abs(evaluated[a][2]-evaluated[b][2]))))
        passes = (all(k in evaluated and evaluated[k][0]['passes'] for k in nominal)
            and len(changes) == 2 and all(v <= f.LIMITS[k] for c in changes for k, v in c.items())
            and boundary is not None and evaluated[b][0]['passes']
            and all(v <= f.LIMITS[k] for k, v in boundary.items()))
        controls.append(dict(kind=kind, mesh_changes=changes, boundary=boundary, passes=bool(passes)))
        if passes:
            qualified.append(kind)
    if 'through' not in qualified:
        qualified = []
    return dict(protocol=f.PROTOCOL, rows=rows, controls=controls, missing_cases=missing,
        rejected_cases=rejected, qualified_kinds=qualified,
        qualified_scope=not missing and not rejected and len(qualified) == len(f.KINDS),
        scope='sampled ideal PEC/PMC TEM series stub and ideal external R/L termination; no PCB or packaged-load claim')


class SeriesStubControls(unittest.TestCase):
    def test_synthesis_and_independent_network_stamping(self):
        for theta, stub in f.synthesis():
            z = complex(f.LOAD_R, f.LOAD_X)/f.Z0
            zd = (z+1j*np.tan(theta))/(1+1j*z*np.tan(theta))
            np.testing.assert_allclose(zd-1j/np.tan(stub), 1., atol=2e-15)
        zs = -1j*f.Z0/np.tan(2*np.pi*f.FREQUENCIES*f.STUB_LENGTH*1e-3/299792458.)
        independent = network_s(f.FREQUENCIES, [0, 2], [(1, 2, f.Z0, f.D*1e-3/299792458.)],
                                impedances=[(0, 1, zs)])
        np.testing.assert_allclose(independent, f.reference('stub'), atol=3e-15)
        np.testing.assert_allclose(f.terminate(f.reference('stub'))[0][50], f.Z0, atol=1e-12)

    def test_open_pole_and_reciprocal_lossless_power(self):
        pole = 299792458./(2*f.STUB_LENGTH*1e-3)
        s = f.reference('stub', [pole])
        self.assertLess(abs(s[0, 1, 0]), 1e-14)
        self.assertAlmostEqual(abs(s[0, 0, 0]), 1.)
        for kind in f.KINDS:
            s = f.reference(kind)
            np.testing.assert_allclose(s.conj().transpose(0, 2, 1)@s, np.broadcast_to(np.eye(2), s.shape), atol=8e-16)
        with self.assertRaises(ValueError):
            f.reference('stub', [np.nan])

    def test_reflected_line_inversion_keeps_signed_loss(self):
        g, z, dx = -.03+2j*np.pi*f.FREQUENCIES/299792458., 50.1+.01j, .00005
        v = np.asarray([np.exp(-g*x)+.2j*np.exp(g*x) for x in (-dx, 0., dx)])
        i = np.asarray([(np.exp(-g*x)-.2j*np.exp(g*x))/z for x in (-dx/2, dx/2)])
        measured, zc = f.line_parameters(v, i, dx)
        np.testing.assert_allclose(measured, g, atol=1e-10, rtol=0)
        np.testing.assert_allclose(zc, z, atol=4e-11, rtol=0)

    def test_mesh_geometry_and_dual_contours(self):
        previous = 0
        for n in f.MESHES:
            sim = f.build(n, 'stub')
            axes = [sim.mesh.GetLines(a) for a in 'xyz']
            self.assertTrue(all(np.all(np.diff(a) > 0) for a in axes))
            cells = int(np.prod([len(a)-1 for a in axes]))
            self.assertGreater(cells, previous)
            previous = cells
            self.assertEqual(len(axes[1]), 5)
            self.assertEqual(axes[2][-1], f.H+f.STUB_LENGTH)
            for p in (0, 1):
                for q, centre in enumerate(f.PLANES[p]):
                    ix = int(np.flatnonzero(axes[0] == centre)[0])
                    np.testing.assert_allclose(np.diff(axes[0][ix-1:ix+2]), f.H/n, atol=2e-14, rtol=0)
                    for j, x in enumerate(((axes[0][ix-1]+centre)/2, (centre+axes[0][ix+1])/2)):
                        box = sim.csx.GetPropertiesByName(f'i{p}_{q}_{j}')[0].GetPrimitive(0)
                        self.assertEqual(box.GetStart()[0], x)
                        for label, fraction in (('i', .75), ('j', .25)):
                            prop = sim.csx.GetPropertiesByName(f'{label}{p}_{q}_{j}')[0]
                            box = prop.GetPrimitive(0)
                            self.assertAlmostEqual(box.GetStop()[1]-box.GetStart()[1], fraction*f.W)
                            self.assertAlmostEqual(prop.GetWeighting(), 1/fraction)
                            self.assertGreater(box.GetStart()[1], axes[1][0])
                            self.assertLess(box.GetStop()[1], axes[1][-1])
        with self.assertRaises(ValueError):
            f.build(True, 'stub')

    def synthetic(self, root):
        gamma = 2j*np.pi*f.FREQUENCIES/299792458.
        for n, kind, c, expanded in cases():
            path = case_path(root, n, kind, c, expanded)
            path.mkdir(parents=True)
            sim = f.build(n, kind, c, expanded)
            s, dx = f.reference(kind), f.H/n*1e-3
            ar = np.zeros((2, 101), complex)
            ar[c] = 1.
            br = s[:, :, c].T
            ur, ir = np.sqrt(f.Z0)*(ar+br), (ar-br)/np.sqrt(f.Z0)
            v, i = np.empty((2, 2, 3, 101), complex), np.empty((2, 2, 2, 101), complex)
            for p in (0, 1):
                sign = 1 if p == 0 else -1
                for q, centre in enumerate(f.PLANES[p]):
                    for j, shift in enumerate((-dx, 0., dx)):
                        dist = abs(centre*1e-3+shift-f.TARGETS[p]*1e-3)
                        v[p, q, j] = ur[p]*np.cosh(gamma*dist)+f.Z0*ir[p]*np.sinh(gamma*dist)
                    for j, shift in enumerate((-dx/2, dx/2)):
                        dist = abs(centre*1e-3+shift-f.TARGETS[p]*1e-3)
                        i[p, q, j] = sign*(ir[p]*np.cosh(gamma*dist)+ur[p]/f.Z0*np.sinh(gamma*dist))
            np.savez(path/'data.npz', f=f.FREQUENCIES, v=v, i=i, i_check=i.copy())
            sim.fdtd.Write2XML(str(path/'input.xml'))
            pulse, dt = f.excitation.dgauss_duration_s(sim.f_max), sim.cfl_timestep()
            meta = dict(**f.identity(n, kind, c, expanded), dt_s=dt, pulse_end_s=pulse,
                cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])), case_elapsed_s=1.,
                input_sha256=hashlib.sha256((path/'input.xml').read_bytes()).hexdigest(),
                run=dict(engine='cpu', threads=f.THREADS, wall_time_s=.5,
                    timesteps=int(np.ceil(pulse/dt))+100, converged=True, hit_timestep_limit=False,
                    exact_endcriteria=True, final_energy_bound_db=f.END_DB))
            (path/'report.json').write_text(json.dumps(meta), encoding='utf-8')

    def test_full_synthetic_cohort_and_two_port_plane_inversion(self):
        with tempfile.TemporaryDirectory() as root:
            self.synthetic(root)
            result = compare(root)
            self.assertTrue(result['qualified_scope'])
            self.assertEqual(result['qualified_kinds'], list(f.KINDS))
            self.assertLess(max(r['metrics']['s_target_abs'] for r in result['rows']), 2e-12)
            path = case_path(root, 6, 'stub', 0, True)/'data.npz'
            with np.load(path) as src:
                data = dict(src)
            data['i_check'] *= 1.01
            np.savez(path, **data)
            self.assertNotIn('stub', compare(root)['qualified_kinds'])

    def test_incomplete_source_energy_stale_source_and_deadline_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            self.synthetic(root)
            path = case_path(root, 4, 'through', 0, False)/'report.json'
            original = json.loads(path.read_text())
            for flaw in ('source', 'energy', 'hash', 'deadline'):
                bad = json.loads(json.dumps(original))
                if flaw == 'source':
                    bad['run']['timesteps'] = int(np.ceil(bad['pulse_end_s']/bad['dt_s']))-1
                elif flaw == 'energy':
                    bad['run']['converged'] = False
                elif flaw == 'hash':
                    bad['source_ids']['series_stub_fixture.py'] = 'stale'
                else:
                    bad['case_elapsed_s'] = f.CASE_SECONDS+1
                path.write_text(json.dumps(bad), encoding='utf-8')
                with self.subTest(flaw=flaw), self.assertRaises(ValueError):
                    read_case(path.parent, 4, 'through', 0)
                if flaw in ('source', 'energy'):
                    result = compare(root)
                    self.assertFalse(result['qualified_scope'])
                    self.assertFalse(result['qualified_kinds'])
            path.write_text(json.dumps(original), encoding='utf-8')

    def test_nonreciprocal_column_and_missing_fine_block_acceptance(self):
        with tempfile.TemporaryDirectory() as root:
            self.synthetic(root)
            path = case_path(root, 6, 'stub', 1, True)/'data.npz'
            with np.load(path) as src:
                data = dict(src)
            data['v'][0] *= 1.1
            data['i'][0] *= 1.1
            np.savez(path, **data)
            result = compare(root)
            self.assertNotIn('stub', result['qualified_kinds'])
            (case_path(root, 8, 'through', 0, False)/'report.json').unlink()
            self.assertFalse(compare(root)['qualified_scope'])

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
                f.serial(Path(root)/'case', 4, 'stub')
            terminate.assert_called_once_with(process.pid, grace=0, job=process.win_job)
            release.assert_called_once_with(process)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    for name in ('preflight', 'fdtd', 'study', 'compare'):
        mode.add_argument('--'+name, action='store_true')
    parser.add_argument('--out', type=Path)
    parser.add_argument('--mesh', type=int, choices=f.MESHES, default=f.MESHES[0])
    parser.add_argument('--kind', choices=f.KINDS, default='stub')
    parser.add_argument('--column', type=int, choices=(0, 1), default=0)
    parser.add_argument('--expanded', action='store_true')
    parser.add_argument('--coarse-only', action='store_true', help='partial nominal cohort; cannot qualify convergence')
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker and not args.fdtd:
        parser.error('internal worker requires --fdtd')
    if args.coarse_only and not args.study:
        parser.error('--coarse-only requires --study')
    if args.preflight:
        for n in f.MESHES:
            sim = f.build(n, args.kind, args.column, args.expanded)
            print(json.dumps(dict(mesh=n, cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
                dt_ps=sim.cfl_timestep()*1e12, width_mm=f.W, d_mm=f.D, stub_length_mm=f.STUB_LENGTH,
                max_steps=sim.max_timesteps, pulse_end_s=f.excitation.dgauss_duration_s(sim.f_max))))
    elif args.fdtd or args.study or args.compare:
        if args.out is None:
            parser.error('--out is required')
        if args.compare:
            result = compare(args.out)
            (args.out/'comparison.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
            print(json.dumps(result, indent=2))
        elif args.fdtd:
            print(json.dumps((f.acquire if args.worker else f.serial)(args.out, args.mesh, args.kind, args.column, args.expanded)))
        else:
            frozen = f.source_ids()
            for key in cases():
                if args.coarse_only and (key[0] != f.MESHES[0] or key[3]):
                    continue
                if f.source_ids() != frozen:
                    raise RuntimeError('source changed during acquisition')
                path = case_path(args.out, *key)
                if not path.exists():
                    f.serial(path, *key)
                try:
                    read_case(path, *key)
                    print(json.dumps(dict(mesh=key[0], kind=key[1], column=key[2], complete=True)), flush=True)
                except UnqualifiedStop as error:
                    print(json.dumps(dict(mesh=key[0], kind=key[1], column=key[2], rejected=True, reason=str(error))), flush=True)
    else:
        unittest.main(argv=[__name__])


if __name__ == '__main__':
    main()
