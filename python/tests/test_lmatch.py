r"""Pure circuit/acceptance controls; native FDTD is explicitly opt-in.

python -m tests.test_lmatch --preflight
python -m tests.test_lmatch --study --out C:\Temp\fairbeam-lmatch
python -m tests.test_lmatch --compare --out C:\Temp\fairbeam-lmatch
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from fairbeam.network import network_s
from tests import lmatch_fixture as f


def read_case(path, refinement, kind, expanded=False):
    path = Path(path)
    meta = json.loads((path/'report.json').read_text(encoding='utf-8'))
    if any(meta.get(k) != v for k, v in f.identity(refinement, kind, expanded).items()):
        raise ValueError('case source, protocol, geometry or frequency identity differs')
    sim = f.build(refinement, kind, expanded)
    expected_cells = int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz']))
    run = meta.get('run', {})
    positive = [meta.get('dt_s'), meta.get('pulse_end_s'), meta.get('case_elapsed_s'), run.get('wall_time_s')]
    energy = [run.get(k) for k in ('final_energy_db', 'final_energy_bound_db')]
    energy = [x for x in energy if isinstance(x, (int, float)) and not isinstance(x, bool) and np.isfinite(x)]
    steps = run.get('timesteps')
    if (meta.get('cells') != expected_cells or run.get('converged') is not True
            or run.get('exact_endcriteria') is not True or run.get('hit_timestep_limit') is not False
            or run.get('engine') != 'cpu' or run.get('threads') != f.THREADS
            or not energy or max(energy) > f.END_DB+1e-9
            or isinstance(steps, bool) or not isinstance(steps, int) or not 0 < steps < f.MAX_STEPS
            or any(isinstance(x, bool) or not isinstance(x, (int, float)) or not np.isfinite(x) or x <= 0 for x in positive)
            or max(positive[2:]) > f.CASE_SECONDS):
        raise ValueError('confirmed stop, finite metadata and bounded owned process required')
    pulse = f.excitation.dgauss_duration_s(f.FREQUENCIES[-1])
    if (not np.isclose(meta['pulse_end_s'], pulse, rtol=1e-12, atol=0)
            or steps*meta['dt_s'] < pulse):
        raise ValueError('source pulse did not finish')
    with np.load(path/'data.npz') as src:
        data = dict(src)
    if (not np.array_equal(data['f'], f.FREQUENCIES)
            or any(data[k].shape != f.FREQUENCIES.shape or not np.isfinite(data[k]).all()
                   for k in ('v', 'i', 'vr', 'gamma'))):
        raise ValueError('finite spectra on the exact frequency grid required')
    v, i, vr = (data[k] for k in ('v', 'i', 'vr'))
    if np.max(abs(i)) == 0 or np.any(abs(i) < 1e-3*np.max(abs(i))):
        raise ValueError('current too small for stable normalization')
    zin = v/i
    gamma = (zin-f.Z0)/(zin+f.Z0)
    if not np.allclose(gamma, data['gamma'], rtol=1e-10, atol=1e-12):
        raise ValueError('native S11 and raw V/I definitions disagree')
    p_in, p_load = .5*(v*np.conj(i)).real, .5*abs(vr)**2/f.LOAD_R
    if np.any(p_in <= 0):
        raise ValueError('positive accepted power required')
    target = f.reference(kind)[0]
    target_gamma = (target-f.Z0)/(target+f.Z0)
    metrics = dict(z_target_rel=float(np.max(abs(zin-target)/abs(target))),
        gamma_target_abs=float(np.max(abs(gamma-target_gamma))),
        power_rel=float(np.max(abs(p_in-p_load)/p_in)))
    samples = [dict(f_mhz=float(f.FREQUENCIES[k]/1e6), zin_ohm=[float(zin[k].real),float(zin[k].imag)],
        target_ohm=[float(target[k].real),float(target[k].imag)],
        gamma_magnitude=float(abs(gamma[k])), gamma_error=float(abs(gamma[k]-target_gamma[k])))
        for k in (0, 50, 100, 150, 200)]
    row = dict(refinement=refinement, kind=kind, expanded=expanded, cells=meta['cells'],
        dt_ps=meta['dt_s']*1e12, steps=steps, source_steps=int(np.ceil(pulse/meta['dt_s'])),
        seconds=run['wall_time_s'], metrics=metrics, samples=samples,
        matches_and_qa=all(metrics[k] <= f.LIMITS[k] for k in metrics))
    return row, zin, gamma


def cases():
    return [(n, kind, False) for n in f.MESHES for kind in f.KINDS]+[
        (f.MESHES[1], kind, True) for kind in f.KINDS]


def case_path(root, n, kind, expanded):
    return Path(root)/kind/f'n{n}'/('expanded' if expanded else 'nominal')


def compare(root):
    records, missing = {}, []
    for key in cases():
        path = case_path(root, *key)
        if not (path/'report.json').is_file():
            missing.append(str(path.relative_to(root)))
        else:
            records[key] = read_case(path, *key)
    rows, boundaries = [], []
    for kind in f.KINDS:
        previous = None
        target = f.reference(kind)[0]
        for n in f.MESHES:
            if (n, kind, False) not in records:
                continue
            row, z, g = records[n, kind, False]
            changes = None if previous is None else dict(
                z_mesh_rel=float(np.max(abs(z-previous[0])/abs(target))),
                gamma_mesh_abs=float(np.max(abs(g-previous[1]))))
            rows.append({**row, 'mesh_changes':changes,
                         'mesh_passes':changes is not None and all(changes[k] <= f.LIMITS[k] for k in changes)})
            previous = z, g
        a, b = (f.MESHES[1], kind, False), (f.MESHES[1], kind, True)
        if a in records and b in records:
            change = dict(z_boundary_rel=float(np.max(abs(records[a][1]-records[b][1])/abs(target))),
                          gamma_boundary_abs=float(np.max(abs(records[a][2]-records[b][2]))))
            boundaries.append(dict(kind=kind, changes=change, control=records[b][0],
                passes=records[b][0]['matches_and_qa'] and all(change[k] <= f.LIMITS[k] for k in change)))
    qualified = (not missing and len(rows) == 9 and len(boundaries) == 3
        and all(r['matches_and_qa'] for r in rows)
        and all(r['mesh_passes'] for r in rows if r['refinement'] != f.MESHES[0])
        and all(b['passes'] for b in boundaries))
    return dict(protocol=f.PROTOCOL, limits=f.LIMITS, rows=rows, boundaries=boundaries,
        missing_cases=missing, qualified_scope=bool(qualified),
        scope='ideal single-branch lumped-element L matching, Z and complex S11; no packaged components or PCB')


class LMatchTests(unittest.TestCase):
    def test_closed_reference_against_nodal_stamping_and_power(self):
        w = 2*np.pi*f.FREQUENCIES
        load = f.LOAD_R+1/(1j*w*f.LOAD_C)
        for kind in f.KINDS:
            z, _, voltage_ratio = f.reference(kind)
            c = f.COMPONENTS[kind]
            zs, yp = np.zeros_like(z), np.zeros_like(z)
            if kind == 'series-l':
                zs, yp = 1j*w*c['series_L'], 1j*w*c['shunt_C']
            elif kind == 'series-c':
                zs, yp = 1/(1j*w*c['series_C']), 1/(1j*w*c['shunt_L'])
            s = network_s(f.FREQUENCIES, [0], z_ref=f.Z0,
                impedances=[(0, 1, zs), (1, -1, load)], admittances=[(1, -1, yp)])[:, 0, 0]
            np.testing.assert_allclose(s, (z-f.Z0)/(z+f.Z0), atol=1e-15, rtol=1e-13)
            np.testing.assert_allclose((1/z).real, abs(voltage_ratio/load)**2*f.LOAD_R, rtol=1e-14)
            if kind != 'bare':
                np.testing.assert_allclose(z[100], f.Z0, atol=5e-13)
        self.assertAlmostEqual(abs((load[100]-f.Z0)/(load[100]+f.Z0)), np.sqrt(.2))

    def test_fixed_geometry_and_separate_native_branches(self):
        for n in f.MESHES:
            for kind in f.KINDS:
                sim = f.build(n, kind)
                self.assertEqual(int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])), 576*n**3)
                self.assertEqual(sim.ports[0]['start'], f.BOXES['source'][0])
                for el in sim.lumped_elements:
                    self.assertEqual(el['topology'], 'parallel')
                    self.assertEqual(len(set(el)&{'R', 'L', 'C'}), 1)
        for args in ((True, 'bare'), (0, 'bare'), (2, 'unknown'), (1, 'bare', 1)):
            with self.assertRaises(ValueError):
                f.build(*args)

    def synthetic(self, root):
        for n, kind, expanded in cases():
            path = case_path(root, n, kind, expanded)
            path.mkdir(parents=True)
            sim = f.build(n, kind, expanded)
            z, _, ratio = f.reference(kind)
            v = np.ones_like(z)
            load = f.LOAD_R+1/(2j*np.pi*f.FREQUENCIES*f.LOAD_C)
            vr = ratio/load*f.LOAD_R
            np.savez(path/'data.npz', f=f.FREQUENCIES, v=v, i=v/z, vr=vr, gamma=(z-f.Z0)/(z+f.Z0))
            pulse = f.excitation.dgauss_duration_s(f.FREQUENCIES[-1])
            dt = sim.cfl_timestep()
            meta = dict(**f.identity(n, kind, expanded),
                cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
                dt_s=dt, pulse_end_s=pulse, case_elapsed_s=1.,
                run=dict(converged=True, exact_endcriteria=True, hit_timestep_limit=False,
                    threads=f.THREADS, engine='cpu', final_energy_bound_db=f.END_DB,
                    timesteps=int(np.ceil(pulse/dt))+100, wall_time_s=.5))
            (path/'report.json').write_text(json.dumps(meta), encoding='utf-8')

    def test_incomplete_source_and_stale_records_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            self.synthetic(folder)
            self.assertTrue(compare(folder)['qualified_scope'])
            key = f.MESHES[0], 'series-l', False
            path = case_path(folder, *key)/'report.json'
            original = json.loads(path.read_text())
            for field in ('source', 'energy', 'identity', 'deadline'):
                m = json.loads(json.dumps(original))
                if field == 'source':
                    m['run']['timesteps'] = int(np.ceil(m['pulse_end_s']/m['dt_s']))-1
                elif field == 'energy':
                    m['run']['final_energy_bound_db'] = -89.
                elif field == 'identity':
                    m['source_ids']['fixture'] = 'stale'
                else:
                    m['case_elapsed_s'] = f.CASE_SECONDS+1
                path.write_text(json.dumps(m), encoding='utf-8')
                with self.subTest(field=field), self.assertRaises(ValueError):
                    compare(folder)
            path.write_text(json.dumps(original), encoding='utf-8')

    def test_boundary_control_requires_its_own_power_qa(self):
        with tempfile.TemporaryDirectory() as folder:
            self.synthetic(folder)
            path = case_path(folder, f.MESHES[1], 'series-c', True)/'data.npz'
            with np.load(path) as src:
                data = dict(src)
            data['vr'] *= np.sqrt(1.02)
            np.savez(path, **data)
            result = compare(folder)
            self.assertFalse(result['qualified_scope'])
            boundary = next(b for b in result['boundaries'] if b['kind'] == 'series-c')
            self.assertEqual(boundary['changes']['z_boundary_rel'], 0.)
            self.assertGreater(boundary['control']['metrics']['power_rel'], f.LIMITS['power_rel'])

    def test_partial_or_wrong_frequency_cohort_never_qualifies(self):
        with tempfile.TemporaryDirectory() as folder:
            self.synthetic(folder)
            path = case_path(folder, f.MESHES[-1], 'bare', False)
            (path/'report.json').unlink()
            self.assertFalse(compare(folder)['qualified_scope'])
            key = f.MESHES[0], 'bare', False
            path = case_path(folder, *key)/'data.npz'
            with np.load(path) as src:
                data = dict(src)
            data['f'] = data['f']+1
            np.savez(path, **data)
            with self.assertRaises(ValueError):
                read_case(path.parent, *key)

    def test_coarse_target_and_both_mesh_pairs_are_required(self):
        with tempfile.TemporaryDirectory() as folder:
            self.synthetic(folder)
            path = case_path(folder, f.MESHES[0], 'series-l', False)/'data.npz'
            with np.load(path) as src:
                data = dict(src)
            z = data['v']/data['i']*1.03
            data['i'] = data['v']/z
            data['gamma'] = (z-f.Z0)/(z+f.Z0)
            data['vr'] /= np.sqrt(1.03)  # keep independent power QA exact
            np.savez(path, **data)
            result = compare(folder)
            self.assertFalse(result['qualified_scope'])
            rows = [r for r in result['rows'] if r['kind'] == 'series-l']
            self.assertFalse(rows[0]['matches_and_qa'])
            self.assertFalse(rows[1]['mesh_passes'])
            self.assertTrue(rows[2]['mesh_passes'])

    def test_suspend_deadline_stops_only_the_owned_worker_group(self):
        class Process:
            pid, win_job, running = 123, object(), True
            def wait(self, timeout):
                if self.running:
                    raise subprocess.TimeoutExpired('worker', timeout)
                return 1
            def poll(self):
                return None if self.running else 1
        proc = Process()
        def stop(*args, **kw):
            proc.running = False
        with tempfile.TemporaryDirectory() as folder, patch.object(f, 'popen_group', return_value=proc), \
                patch.object(f, 'terminate_group', side_effect=stop) as terminated, \
                patch.object(f, 'release_group') as released, \
                patch.object(f.time, 'monotonic', side_effect=[0., .1, .2]), \
                patch.object(f.time, 'time', side_effect=[0., .1, f.CASE_SECONDS+1]):
            with self.assertRaises(TimeoutError):
                f.serial(Path(folder)/'new', 1, 'bare')
            terminated.assert_called_once_with(proc.pid, grace=0, job=proc.win_job)
            released.assert_called_once_with(proc)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    for option in ('preflight', 'study', 'fdtd', 'compare'):
        mode.add_argument('--'+option, action='store_true')
    parser.add_argument('--out', type=Path)
    parser.add_argument('--mesh', type=int, choices=f.MESHES, default=f.MESHES[0])
    parser.add_argument('--kind', choices=f.KINDS, default='series-l')
    parser.add_argument('--expanded', action='store_true')
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker and not args.fdtd:
        parser.error('internal worker requires --fdtd')
    if args.preflight:
        for n, kind, expanded in cases():
            sim = f.build(n, kind, expanded)
            print(json.dumps(dict(refinement=n, kind=kind, expanded=expanded,
                cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
                cfl_dt_ps=sim.cfl_timestep()*1e12, geometry=f.geometry(kind, expanded), limits=f.LIMITS)))
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
                if f.source_ids() != frozen:
                    raise RuntimeError('acquisition sources changed during cohort')
                path = case_path(args.out, *key)
                if not path.exists():
                    f.serial(path, *key)
                row, _, _ = read_case(path, *key)  # existing cases need the same strict identity/QA read
                print(json.dumps(row), flush=True)
    else:
        unittest.main(argv=[sys.argv[0]])


if __name__ == '__main__':
    main()
