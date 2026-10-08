"""Pure references and explicit opt-in planar stub acquisition; no FDTD in discovery."""
import argparse
import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from fairbeam.network import network_s
from tests import shunt_stub_fixture as f


class UnqualifiedStop(ValueError):
    """Retained spectrum with incomplete source or unconfirmed energy decay."""


def cases():
    return [(n, kind, False) for n in f.MESHES for kind in f.KINDS]+[
        (f.MESHES[1], kind, True) for kind in f.KINDS]


def case_path(root, n, kind, expanded):
    return Path(root)/kind/f'n{n}'/('expanded' if expanded else 'nominal')


def read_case(path, n, kind, expanded=False):
    path = Path(path)
    meta = json.loads((path/'report.json').read_text(encoding='utf-8'))
    expected = f.identity(n, kind, expanded)
    if any(meta.get(k) != v for k, v in expected.items()):
        raise ValueError('model, acquisition source or protocol identity differs')
    sim, _ = f.build(n, kind, expanded)
    run = meta.get('run', {})
    steps = run.get('timesteps')
    numbers = [meta.get('dt_s'), meta.get('pulse_end_s'), meta.get('case_elapsed_s'), run.get('wall_time_s')]
    energy = [run.get(k) for k in ('final_energy_db', 'final_energy_bound_db')]
    energy = [x for x in energy if isinstance(x, (int, float)) and not isinstance(x, bool) and np.isfinite(x)]
    cells = int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz']))
    if (meta.get('cells') != cells or not energy
            or any(isinstance(x, bool) or not isinstance(x, (int, float)) or not np.isfinite(x) or x <= 0 for x in numbers)
            or max(numbers[2:]) > f.CASE_SECONDS
            or isinstance(steps, bool) or not isinstance(steps, int) or not 0 < steps <= sim.max_timesteps
            or run.get('threads') != f.THREADS or run.get('engine') != 'cpu'
            or run.get('exact_endcriteria') is not True):
        raise ValueError('finite native metadata and bounded declared engine required')
    pulse = f.excitation.dgauss_duration_s(sim.f_max)
    if (run.get('converged') is not True or run.get('hit_timestep_limit') is not False
            or steps >= sim.max_timesteps or max(energy) > f.END_DB+1e-9
            or not np.isclose(numbers[1], pulse, rtol=1e-12, atol=0) or steps*numbers[0] < pulse):
        raise UnqualifiedStop('complete source and confirmed -90 dB stop required')
    with np.load(path/'data.npz') as src:
        data = dict(src)
    shapes = dict(v=(2, 3, len(f.FREQUENCIES)), i=(2, 2, len(f.FREQUENCIES)),
                  vr=f.FREQUENCIES.shape, native_v=f.FREQUENCIES.shape, native_i=f.FREQUENCIES.shape)
    if (not np.array_equal(data.get('f'), f.FREQUENCIES)
            or any(k not in data or data[k].shape != shape or not np.isfinite(data[k]).all()
                   for k, shape in shapes.items())):
        raise ValueError('finite spectra on the declared exact frequency grid required')
    if meta.get('input_sha256') != hashlib.sha256((path/'input.xml').read_bytes()).hexdigest():
        raise ValueError('stored native input changed')
    return meta, data


def calibration(data, n):
    gamma, zc, _ = f.line_parameters(data['v'], data['i'], f.H/n*1e-3)
    g, z = gamma.mean(axis=0), zc.mean(axis=0)
    target_beta = 2*np.pi*f.FREQUENCIES/299792458.*np.sqrt(f.EPS_EFF)
    metrics = dict(calibration_beta_rel=float(np.max(abs(gamma.imag-target_beta)/target_beta)),
        calibration_z_rel=float(np.max(abs(zc-f.Z0)/f.Z0)),
        calibration_spread_rel=float(max(np.max(abs(gamma[1]-gamma[0])/abs(g)),
                                          np.max(abs(zc[1]-zc[0])/abs(z)))))
    return g, z, metrics


def measurement(data, n, kind, gamma, zc):
    current = data['i'].mean(axis=1)/np.cosh(gamma*f.H/n*1e-3/2)
    if np.any(abs(current) <= 1e-6*np.max(abs(current), axis=1, keepdims=True)):
        raise ValueError('current too small for stable V/I normalization')
    u = data['v'][:, 1]
    at_plane = u/current
    at_tee = np.array([f.move_plane(at_plane[p], gamma, zc, -x*1e-3)
                       for p, x in enumerate(f.MEAS_PLANES)])
    zin = at_tee.mean(axis=0)
    target = f.reference(kind)
    reflection = (zin-f.Z0)/(zin+f.Z0)
    target_r = (target-f.Z0)/(target+f.Z0)
    p_in = .5*(u*np.conj(current)).real
    if not np.isfinite(zin).all() or np.any(p_in <= 0):
        raise ValueError('finite impedance and positive input power required')
    metrics = dict(z_target_rel=float(np.max(abs(zin-target)/abs(target))),
        gamma_target_abs=float(np.max(abs(reflection-target_r))),
        z_plane_spread_rel=float(np.max(abs(at_tee[1]-at_tee[0])/abs(target))))
    if kind != 'uniform':
        resistance = f.Z0 if kind == 'matched' else f.LOAD_R
        p_load = .5*abs(data['vr'])**2/resistance
        metrics['power_rel'] = float(np.max(abs(p_in-p_load)/p_in))
    return zin, reflection, metrics


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
            rejected.append(dict(mesh=key[0], kind=key[1], expanded=key[2], reason=str(error)))
    evaluated, rows, controls = {}, [], []
    for n, kind, expanded in cases():
        key, calkey = (n, kind, expanded), (n, 'uniform', expanded)
        if key not in records or calkey not in records:
            continue
        g, z, cal_metrics = calibration(records[calkey][1], n)
        zin, reflection, metrics = measurement(records[key][1], n, kind, g, z)
        quality = {**cal_metrics, **metrics}
        passes = all(v <= f.LIMITS[k] for k, v in quality.items() if k in f.LIMITS)
        passes &= metrics['z_plane_spread_rel'] <= f.LIMITS['calibration_spread_rel']
        row = dict(mesh=n, kind=kind, expanded=expanded, metrics=quality, passes=bool(passes),
            samples=[dict(f_ghz=float(f.FREQUENCIES[k]/1e9),
                z_ohm=[float(zin[k].real), float(zin[k].imag)],
                target_ohm=[float(f.reference(kind)[k].real), float(f.reference(kind)[k].imag)],
                gamma_abs=float(abs(reflection[k]))) for k in (0, 25, 50, 75, 100)])
        evaluated[key] = row, zin, reflection
        if not expanded:
            rows.append(row)
    qualified = []
    for kind in f.KINDS:
        own_rows = [r for r in rows if r['kind'] == kind]
        changes = []
        for a, b in zip(f.MESHES[:-1], f.MESHES[1:]):
            ka, kb = (a, kind, False), (b, kind, False)
            if ka in evaluated and kb in evaluated:
                target = f.reference(kind)
                changes.append(dict(z_mesh_rel=float(np.max(abs(evaluated[ka][1]-evaluated[kb][1])/abs(target))),
                    gamma_mesh_abs=float(np.max(abs(evaluated[ka][2]-evaluated[kb][2])))))
        ka, kb = (f.MESHES[1], kind, False), (f.MESHES[1], kind, True)
        boundary = None
        if ka in evaluated and kb in evaluated:
            boundary = dict(z_boundary_rel=float(np.max(abs(evaluated[ka][1]-evaluated[kb][1])/abs(f.reference(kind)))),
                gamma_boundary_abs=float(np.max(abs(evaluated[ka][2]-evaluated[kb][2]))))
        passes = (len(own_rows) == 3 and all(r['passes'] for r in own_rows) and len(changes) == 2
            and all(v <= f.LIMITS[k] for c in changes for k, v in c.items())
            and boundary is not None and evaluated[kb][0]['passes']
            and all(v <= f.LIMITS[k] for k, v in boundary.items()))
        controls.append(dict(kind=kind, mesh_changes=changes, boundary=boundary, passes=bool(passes)))
        if passes:
            qualified.append(kind)
    # Every DUT correction depends on the same independently qualified line.
    if 'uniform' not in qualified:
        qualified = []
    return dict(protocol=f.PROTOCOL, rows=rows, controls=controls, missing_cases=missing,
        rejected_cases=rejected, qualified_kinds=qualified,
        qualified_scope=not missing and not rejected and len(qualified) == len(f.KINDS),
        scope='declared planar PEC shorted shunt stub; no packaged component or general PCB claim')


class ShuntStubControls(unittest.TestCase):
    def test_two_independent_solutions_match(self):
        load = complex(f.LOAD_R, f.LOAD_X)
        y = f.Z0/load
        for theta, stub in f.synthesis():
            line = (y+1j*np.tan(theta))/(1+1j*y*np.tan(theta))
            np.testing.assert_allclose(line-1j/np.tan(stub), 1., atol=2e-15)
        self.assertAlmostEqual(f.reference('stub')[50].real, f.Z0, delta=1e-12)
        self.assertAlmostEqual(f.reference('stub')[50].imag, 0., delta=1e-12)

    def test_reference_against_independently_stamped_lines(self):
        delay = lambda length: length*1e-3*np.sqrt(f.EPS_EFF)/299792458.
        load = f.LOAD_R+1/(2j*np.pi*f.FREQUENCIES*f.LOAD_C)
        for kind in ('bare', 'stub'):
            lines = [(0, 1, f.Z0, delay(f.D))]
            impedances = [(1, -1, load)]
            if kind == 'stub':
                lines.append((0, 2, f.Z0, delay(f.STUB_LENGTH)))
                impedances.append((2, -1, 0.))
            s = network_s(f.FREQUENCIES, [0], lines, impedances=impedances)[:, 0, 0]
            z = f.reference(kind)
            np.testing.assert_allclose(s, (z-f.Z0)/(z+f.Z0), atol=2e-14)

    def test_complex_line_plane_inversion(self):
        g = .02+2j*np.pi*f.FREQUENCIES/1.1e8
        zc, load = 51.+.15j, 60.-25j
        t = np.tanh(g*.008)
        at_feed = zc*(load+zc*t)/(zc+load*t)
        np.testing.assert_allclose(f.move_plane(at_feed, g, zc, .008), load, atol=8e-14)

    def test_reflected_calibration_keeps_loss_and_spatial_stagger(self):
        g = -.02+2j*np.pi*f.FREQUENCIES/1.1e8
        zc, dx, r = 51.+.02j, .0001, .3+.2j
        v = np.array([np.exp(-g*x)+r*np.exp(g*x) for x in (-dx, 0., dx)])
        i = np.array([(np.exp(-g*x)-r*np.exp(g*x))/zc for x in (-dx/2, dx/2)])
        measured, z, aligned = f.line_parameters(v, i, dx)
        np.testing.assert_allclose(measured, g, atol=2e-10, rtol=0)
        np.testing.assert_allclose(z, zc, atol=3e-11, rtol=0)
        np.testing.assert_allclose(aligned, (1-r)/zc, atol=1e-15)
        with self.assertRaises(ValueError):
            f.line_parameters(v, i, 0.)

    def test_mesh_geometry_and_actual_dual_current_contours(self):
        old_cells = 0
        for n in f.MESHES:
            sim, _ = f.build(n, 'stub')
            axes = [sim.mesh.GetLines(a) for a in 'xyz']
            self.assertTrue(all(np.all(np.diff(a) > 0) for a in axes))
            cells = int(np.prod([len(a)-1 for a in axes]))
            self.assertGreater(cells, old_cells)
            old_cells = cells
            self.assertIn(f.H, axes[2])
            self.assertIn(f.STUB_LENGTH, axes[1])
            for p, centre in enumerate(f.MEAS_PLANES):
                x = axes[0]
                ix = int(np.flatnonzero(x == centre)[0])
                np.testing.assert_allclose(np.diff(x[ix-1:ix+2]), f.H/n, rtol=1e-12)
                for j, plane in enumerate(((x[ix-1]+centre)/2, (centre+x[ix+1])/2)):
                    box = sim.csx.GetPropertiesByName(f'i{p}_{j}')[0].GetPrimitive(0)
                    self.assertEqual(box.GetStart()[0], plane)
                    self.assertEqual(box.GetStop()[0], plane)
        with self.assertRaises(ValueError):
            f.build(True, 'stub')

    def synthetic(self, root):
        gamma = 2j*np.pi*f.FREQUENCIES/299792458.*np.sqrt(f.EPS_EFF)
        for n, kind, expanded in cases():
            path = case_path(root, n, kind, expanded)
            path.mkdir(parents=True)
            sim, _ = f.build(n, kind, expanded)
            load = f.reference(kind)
            r = (load-f.Z0)/(load+f.Z0)
            dx = f.H/n*1e-3
            v = np.array([[np.exp(-gamma*x)+r*np.exp(gamma*x)
                           for x in (centre*1e-3-dx, centre*1e-3, centre*1e-3+dx)]
                          for centre in f.MEAS_PLANES])
            i = np.array([[(np.exp(-gamma*x)-r*np.exp(gamma*x))/f.Z0
                           for x in (centre*1e-3-dx/2, centre*1e-3+dx/2)]
                          for centre in f.MEAS_PLANES])
            pin = ((1+r)*np.conj((1-r)/f.Z0)).real/2
            resistance = f.Z0 if kind == 'matched' else f.LOAD_R
            vr = np.sqrt(2*pin*resistance).astype(complex)
            np.savez(path/'data.npz', f=f.FREQUENCIES, v=v, i=i, vr=vr,
                     native_v=v[0, 1], native_i=i[0].mean(axis=0))
            pulse = f.excitation.dgauss_duration_s(sim.f_max)
            dt = sim.cfl_timestep()
            sim.fdtd.Write2XML(str(path/'input.xml'))
            meta = dict(**f.identity(n, kind, expanded), cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
                dt_s=dt, pulse_end_s=pulse, case_elapsed_s=1.,
                input_sha256=hashlib.sha256((path/'input.xml').read_bytes()).hexdigest(),
                run=dict(engine='cpu', threads=f.THREADS, wall_time_s=.5,
                    timesteps=int(np.ceil(pulse/dt))+100, exact_endcriteria=True,
                    converged=True, hit_timestep_limit=False, final_energy_bound_db=f.END_DB))
            (path/'report.json').write_text(json.dumps(meta), encoding='utf-8')

    def test_full_synthetic_cohort_and_rejected_stops(self):
        with tempfile.TemporaryDirectory() as root:
            self.synthetic(root)
            self.assertTrue(compare(root)['qualified_scope'])
            path = case_path(root, 4, 'uniform', False)/'report.json'
            original = json.loads(path.read_text())
            for flaw in ('source', 'energy', 'hash', 'deadline'):
                bad = json.loads(json.dumps(original))
                if flaw == 'source':
                    bad['run']['timesteps'] = int(np.ceil(bad['pulse_end_s']/bad['dt_s']))-1
                elif flaw == 'energy':
                    bad['run']['converged'] = False
                elif flaw == 'hash':
                    bad['source_ids']['shunt_stub_fixture.py'] = 'stale'
                else:
                    bad['case_elapsed_s'] = f.CASE_SECONDS+1
                path.write_text(json.dumps(bad), encoding='utf-8')
                with self.subTest(flaw=flaw), self.assertRaises(ValueError):
                    read_case(path.parent, 4, 'uniform')
                if flaw in ('source', 'energy'):
                    result = compare(root)
                    self.assertFalse(result['qualified_scope'])
                    self.assertFalse(result['qualified_kinds'])
            path.write_text(json.dumps(original), encoding='utf-8')

    def test_boundary_power_and_missing_fine_mesh_block_acceptance(self):
        with tempfile.TemporaryDirectory() as root:
            self.synthetic(root)
            path = case_path(root, 6, 'stub', True)/'data.npz'
            with np.load(path) as src:
                data = dict(src)
            data['vr'] *= np.sqrt(1.04)
            np.savez(path, **data)
            result = compare(root)
            self.assertNotIn('stub', result['qualified_kinds'])
            (case_path(root, 8, 'bare', False)/'report.json').unlink()
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
    mode.add_argument('--preflight', action='store_true')
    mode.add_argument('--fdtd', action='store_true')
    mode.add_argument('--study', action='store_true')
    mode.add_argument('--compare', action='store_true')
    parser.add_argument('--out', type=Path)
    parser.add_argument('--mesh', type=int, choices=f.MESHES, default=f.MESHES[0])
    parser.add_argument('--kind', choices=f.KINDS, default='stub')
    parser.add_argument('--expanded', action='store_true')
    parser.add_argument('--coarse-only', action='store_true', help='partial nominal cohort; never qualifies a mesh study')
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker and not args.fdtd:
        parser.error('internal worker requires --fdtd')
    if args.coarse_only and not args.study:
        parser.error('--coarse-only requires --study')
    if args.preflight:
        for n in f.MESHES:
            sim, _ = f.build(n, 'stub', args.expanded)
            print(json.dumps(dict(mesh=n, cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
                dt_ps=sim.cfl_timestep()*1e12, w_mm=f.W, d_mm=f.D, stub_length_mm=f.STUB_LENGTH,
                pulse_end_s=f.excitation.dgauss_duration_s(sim.f_max), max_steps=sim.max_timesteps)))
    elif args.fdtd or args.study or args.compare:
        if args.out is None:
            parser.error('--out is required')
        if args.compare:
            result = compare(args.out)
            (args.out/'comparison.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
            print(json.dumps(result, indent=2))
        elif args.fdtd:
            print(json.dumps((f.acquire if args.worker else f.serial)(args.out, args.mesh, args.kind, args.expanded)))
        else:
            frozen = f.source_ids()
            for key in cases():
                if args.coarse_only and (key[0] != f.MESHES[0] or key[2]):
                    continue
                if f.source_ids() != frozen:
                    raise RuntimeError('source changed during acquisition')
                path = case_path(args.out, *key)
                if not path.exists():
                    f.serial(path, *key)
                try:
                    meta, _ = read_case(path, *key)
                    print(json.dumps(dict(mesh=key[0], kind=key[1], complete=True)), flush=True)
                except UnqualifiedStop as error:
                    print(json.dumps(dict(mesh=key[0], kind=key[1], rejected=True, reason=str(error))), flush=True)
    else:
        unittest.main(argv=[__name__])


if __name__ == '__main__':
    main()
