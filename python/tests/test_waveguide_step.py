r"""Opt-in TE10 interface cohort; ordinary unittest discovery does not run FDTD.

python -m tests.test_waveguide_step --preflight
python -m tests.test_waveguide_step --study --out C:\Temp\waveguide-step
python -m tests.test_waveguide_step --compare --out C:\Temp\waveguide-step
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import numpy as np

from fairbeam.multiport import assemble_s
from fairbeam.procutil import popen_group, release_group, terminate_group
from tests import waveguide_step_fixture as f


def serial(out, cpw, excited, padding=f.PADDING):
    out = Path(out).resolve()
    if out.exists():
        raise ValueError('use a fresh acquisition directory')
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, '-m', 'tests.test_waveguide_step', '--fdtd', '--worker',
               '--mesh', str(cpw), '--excite', str(excited), '--padding', str(padding), '--out', str(out)]
    started, wall = time.monotonic(), time.time()
    with out.with_name(out.name+'.log').open('w', encoding='utf-8') as log:
        proc = popen_group(command, stdout=log, stderr=subprocess.STDOUT,
            cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, 'OPENBLAS_NUM_THREADS':'1', 'OMP_NUM_THREADS':'1'})
        try:
            while True:
                remaining = f.CASE_SECONDS-max(time.monotonic()-started, time.time()-wall)
                if remaining <= 0:
                    raise TimeoutError('30-minute case limit, including suspend; incomplete data retained')
                try:
                    code = proc.wait(timeout=min(1., remaining))
                    break
                except subprocess.TimeoutExpired:
                    pass
            elapsed = max(time.monotonic()-started, time.time()-wall)
            if code or elapsed > f.CASE_SECONDS:
                raise RuntimeError('case failed or exceeded its deadline; inspect retained log')
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


def read_pair(root, cpw, padding):
    incoming, outgoing = [], []
    for pn in (1, 2):
        path = Path(root)/f'cpw{cpw}'/f'pad{padding}'/f'e{pn}'
        meta = json.loads((path/'report.json').read_text(encoding='utf-8'))
        expected = dict(protocol=f.PROTOCOL, geometry=f.geometry(), cpw=cpw, padding=padding,
                        excited=pn, frequency_hz=f.FREQUENCIES.tolist(),
                        limits=f.LIMITS, source_ids=f.source_ids())
        if any(meta.get(k) != v for k, v in expected.items()):
            raise ValueError('case source, geometry, frequency or protocol identity mismatch')
        stats = meta.get('run', {})
        energy = [stats.get(k) for k in ('final_energy_db', 'final_energy_bound_db')]
        energy = [x for x in energy if isinstance(x, (int, float)) and not isinstance(x, bool) and np.isfinite(x)]
        durations = [stats.get('wall_time_s'), meta.get('case_elapsed_s')]
        if (stats.get('converged') is not True or stats.get('threads') != 4
                or stats.get('exact_endcriteria') is not True or stats.get('engine') != 'cpu'
                or stats.get('hit_timestep_limit') is not False
                or not isinstance(stats.get('timesteps'), int) or not 0 < stats['timesteps'] < 200000
                or not energy or max(energy) > -70+1e-9
                or any(isinstance(t, bool) or not isinstance(t, (int, float))
                       or not np.isfinite(t) or not 0 < t <= f.CASE_SECONDS for t in durations)
                or isinstance(meta.get('dt_s'), bool) or not isinstance(meta.get('dt_s'), (int, float))
                or not np.isfinite(meta['dt_s']) or meta['dt_s'] <= 0):
            raise ValueError('case is incomplete, over budget or lacks a confirmed exact energy stop')
        with np.load(path/'data.npz') as data:
            if (not np.array_equal(data['f'], f.FREQUENCIES)
                    or any(data[k].shape != (2, len(f.FREQUENCIES)) or not np.isfinite(data[k]).all()
                           for k in ('a', 'b', 'z_ref'))
                    or not np.allclose(data['z_ref'], f.modes()[1], rtol=1e-8, atol=0)):
                raise ValueError('finite spectra on the exact grid and modal references required')
            incoming.append(data['a'])
            outgoing.append(data['b'])
    a = np.array(incoming)
    if np.any(np.linalg.cond(a.transpose(2, 1, 0)) > 1e4):
        raise ValueError('incoming-wave matrix is ill-conditioned')
    return assemble_s(a, np.array(outgoing), [1, 2], 2)


def compare(root):
    root, rows, spectra, missing = Path(root), [], {}, []
    for cpw, padding in [(n, f.PADDING) for n in f.MESHES]+[(f.CONTROL_MESH, f.CONTROL_PADDING)]:
        paths = [root/f'cpw{cpw}'/f'pad{padding}'/f'e{pn}'/'report.json' for pn in (1, 2)]
        if not all(p.is_file() for p in paths):
            missing.extend(str(p.relative_to(root)) for p in paths if not p.is_file())
            continue
        spectra[cpw, padding] = read_pair(root, cpw, padding)
    for cpw in f.MESHES:
        if (cpw, f.PADDING) not in spectra:
            continue
        s = spectra[cpw, f.PADDING]
        error = float(np.max(abs(s-f.reference())))
        reciprocity = float(np.max(abs(s[:, 0, 1]-s[:, 1, 0])))
        power = float(np.max(abs(np.sum(abs(s)**2, axis=1)-1)))
        previous = spectra.get((cpw-10, f.PADDING))
        change = None if previous is None else float(np.max(abs(s-previous)))
        beta = f.modes()[0][0]
        rho = s[:, 0, 0]*np.exp(2j*beta*f.PLANE*1e-3)
        samples = [dict(f_ghz=float(f.FREQUENCIES[i]/1e9),
            interface_rho=[float(rho[i].real), float(rho[i].imag)],
            s21_abs=float(abs(s[i, 1, 0])), s21_phase_deg=float(np.angle(s[i, 1, 0], deg=True)))
            for i in (0, 10, 20, 30, 40)]
        rows.append(dict(cpw=cpw, target_abs_max=error, mesh_abs_max=change,
            reciprocity_abs_max=reciprocity, power_error_max=power,
            matches=error <= f.LIMITS['target_abs'],
            mesh_pair_passes=change is not None and change <= f.LIMITS['mesh_abs'],
            qa_passes=reciprocity <= f.LIMITS['reciprocity_abs'] and power <= f.LIMITS['power_abs'], samples=samples))
    boundary, control = None, None
    if (f.CONTROL_MESH, f.PADDING) in spectra and (f.CONTROL_MESH, f.CONTROL_PADDING) in spectra:
        s = spectra[f.CONTROL_MESH, f.CONTROL_PADDING]
        boundary = float(np.max(abs(spectra[f.CONTROL_MESH, f.PADDING]-s)))
        control = dict(target_abs_max=float(np.max(abs(s-f.reference()))),
            reciprocity_abs_max=float(np.max(abs(s[:, 0, 1]-s[:, 1, 0]))),
            power_error_max=float(np.max(abs(np.sum(abs(s)**2, axis=1)-1))))
        control['passes'] = (control['target_abs_max'] <= f.LIMITS['target_abs']
            and control['reciprocity_abs_max'] <= f.LIMITS['reciprocity_abs']
            and control['power_error_max'] <= f.LIMITS['power_abs'])
    passed = (not missing and len(rows) == 3 and all(r['matches'] and r['qa_passes'] for r in rows)
              and all(r['mesh_pair_passes'] for r in rows[1:])
              and boundary is not None and boundary <= f.LIMITS['boundary_abs']
              and control is not None and control['passes'])
    return dict(protocol=f.PROTOCOL, limits=f.LIMITS, rows=rows, missing_cases=missing,
                boundary_abs_max=boundary, boundary_control=control, qualified_scope=bool(passed),
                scope='complex TE10 power-wave S matrix on the fixed measurement planes only')


class StepTests(unittest.TestCase):
    def test_reference_against_independent_tangential_boundary_solve(self):
        beta, z = f.modes()
        for k in range(len(f.FREQUENCIES)):
            rho, voltage_t = np.linalg.solve([[1, -1], [-1/z[0, k], -1/z[1, k]]], [-1, -1/z[0, k]])
            s = f.reference()[k]
            self.assertAlmostEqual(abs(s[0, 0]), abs(rho), places=13)
            self.assertAlmostEqual(abs(s[1, 0]), voltage_t*np.sqrt(z[0, k]/z[1, k]), places=13)
            np.testing.assert_allclose(s.conj().T@s, np.eye(2), atol=1e-14)
            np.testing.assert_allclose(s, s.T, atol=0)
        uniform = f.reference(eps_r=1.)
        np.testing.assert_array_equal(uniform[:, 0, 0], 0)
        np.testing.assert_allclose(uniform[:, 1, 0], np.exp(-2j*beta[0]*f.PLANE*1e-3))
        for band in ([0.], [1e9], [np.nan], []):
            with self.assertRaises(ValueError):
                f.reference(band)

    def test_fixed_planes_interface_and_symmetric_refinement(self):
        for cpw in f.MESHES:
            sim = f.build(cpw, 1)
            z = np.asarray(sim.mesh.GetLines('z'))
            self.assertIn(0., z)
            self.assertIn(-f.PLANE, z)
            self.assertIn(f.PLANE, z)
            np.testing.assert_allclose(np.diff(z), np.diff(z)[0], rtol=1e-12)
            for axis in 'xy':
                lines = sim.mesh.GetLines(axis)
                np.testing.assert_allclose(lines, -lines[::-1], atol=1e-14)
            self.assertNotIn('eps_r', sim.ports[0])
            self.assertEqual(sim.ports[1]['eps_r'], f.ER)
            self.assertEqual([p['excite'] for p in sim.ports], [True, False])
            self.assertEqual([p['stop'][2] for p in sim.ports], [-f.PLANE, f.PLANE])
        sim = f.build(f.CONTROL_MESH, 2, f.CONTROL_PADDING)
        normal = f.build(f.CONTROL_MESH, 1)
        np.testing.assert_array_equal(sim.mesh.GetLines('x'), normal.mesh.GetLines('x'))
        self.assertEqual([p['excite'] for p in sim.ports], [False, True])
        for args in ((True, 1), (20.5, 1), (20, 0), (20, True), (20, 1, 8)):
            with self.assertRaises(ValueError):
                f.build(*args)

    def synthetic(self, root):
        a = np.broadcast_to(np.array([[1, .02j], [.03, .9]]), (len(f.FREQUENCIES), 2, 2)).copy()
        b = f.reference()@a
        for cpw, padding in [(n, f.PADDING) for n in f.MESHES]+[(f.CONTROL_MESH, f.CONTROL_PADDING)]:
            for pn in (1, 2):
                path = Path(root)/f'cpw{cpw}'/f'pad{padding}'/f'e{pn}'
                path.mkdir(parents=True)
                meta = dict(protocol=f.PROTOCOL, geometry=f.geometry(), cpw=cpw, padding=padding, excited=pn,
                    frequency_hz=f.FREQUENCIES.tolist(), limits=f.LIMITS, source_ids=f.source_ids(),
                    dt_s=1e-12, case_elapsed_s=2.,
                    run=dict(converged=True, threads=4, exact_endcriteria=True, engine='cpu',
                             hit_timestep_limit=False, timesteps=1000,
                             final_energy_bound_db=-70., wall_time_s=1.))
                (path/'report.json').write_text(json.dumps(meta), encoding='utf-8')
                np.savez(path/'data.npz', f=f.FREQUENCIES, a=a[:, :, pn-1].T, b=b[:, :, pn-1].T, z_ref=f.modes()[1])
        return Path(root)/'cpw40'/f'pad{f.PADDING}'/'e1'

    def test_two_excitation_assembly_and_full_cohort_requirement(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.synthetic(folder)
            np.testing.assert_allclose(read_pair(folder, 40, f.PADDING), f.reference(), atol=4e-16)
            self.assertTrue(compare(folder)['qualified_scope'])
            (path/'report.json').unlink()
            self.assertFalse(compare(folder)['qualified_scope'])

    def test_metadata_stop_and_elapsed_time_guards(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.synthetic(folder)/'report.json'
            original = json.loads(path.read_text(encoding='utf-8'))
            for key, value in (('protocol', 'wrong'), ('source_ids', {}), ('geometry', {}),
                               ('case_elapsed_s', f.CASE_SECONDS+1), ('case_elapsed_s', True)):
                path.write_text(json.dumps({**original, key:value}), encoding='utf-8')
                with self.assertRaises(ValueError):
                    read_pair(folder, 40, f.PADDING)
            for key, value in (('converged', False), ('final_energy_bound_db', -60),
                               ('wall_time_s', None), ('wall_time_s', float('nan')), ('threads', 8)):
                path.write_text(json.dumps({**original, 'run':{**original['run'], key:value}}), encoding='utf-8')
                with self.assertRaises(ValueError):
                    read_pair(folder, 40, f.PADDING)

    def test_target_and_spectrum_failures_cannot_qualify(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.synthetic(folder)/'data.npz'
            with np.load(path) as src:
                data = dict(src)
            data['b'][0] += .03*data['a'][0]
            np.savez(path, **data)
            self.assertFalse(compare(folder)['qualified_scope'])
            data['a'][0, 0] = np.nan
            np.savez(path, **data)
            with self.assertRaises(ValueError):
                compare(folder)

    def test_boundary_control_must_pass_its_own_target_and_qa(self):
        reference = f.reference()
        phase = reference[:, 0, 0]/abs(reference[:, 0, 0])
        for failure in ('reciprocity', 'power', 'target'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                self.synthetic(folder)
                self.assertTrue(compare(folder)['qualified_scope'])
                for cpw, padding in [(n, f.PADDING) for n in f.MESHES]+[(f.CONTROL_MESH, f.CONTROL_PADDING)]:
                    control = padding == f.CONTROL_PADDING
                    s = reference.copy()
                    if failure == 'power':
                        s *= 1.0055 if control else 1.004
                    elif failure == 'target':
                        s[:, 0, 0] += 1j*phase*(.0105 if control else .0095)
                    elif control:
                        s[:, 0, 1] += .0015
                        s[:, 1, 0] -= .0015
                    for pn in (1, 2):
                        path = Path(folder)/f'cpw{cpw}'/f'pad{padding}'/f'e{pn}'/'data.npz'
                        with np.load(path) as src:
                            data = dict(src)
                        data['b'] = np.einsum('fij,jf->if', s, data['a'])
                        np.savez(path, **data)
                result = compare(folder)
                self.assertTrue(all(row['matches'] and row['qa_passes'] for row in result['rows']))
                self.assertLess(result['boundary_abs_max'], f.LIMITS['boundary_abs'])
                self.assertFalse(result['boundary_control']['passes'])
                self.assertFalse(result['qualified_scope'])

    def test_suspend_deadline_stops_only_the_owned_process(self):
        class Process:
            pid, win_job = 123, object()
            running = True
            def wait(self, timeout):
                if self.running:
                    raise subprocess.TimeoutExpired('worker', timeout)
                return 1
            def poll(self):
                return None if self.running else 1
        proc = Process()
        def stop(*args, **kw):
            proc.running = False
        with tempfile.TemporaryDirectory() as folder, patch(__name__+'.popen_group', return_value=proc), \
                patch(__name__+'.terminate_group', side_effect=stop) as terminated, \
                patch(__name__+'.release_group') as released, \
                patch(__name__+'.time.monotonic', side_effect=[0., .1, .2]), \
                patch(__name__+'.time.time', side_effect=[0., 1., f.CASE_SECONDS+1]):
            with self.assertRaises(TimeoutError):
                serial(Path(folder)/'new', 20, 1)
            terminated.assert_called_once_with(proc.pid, grace=0, job=proc.win_job)
            released.assert_called_once_with(proc)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    for option in ('preflight', 'study', 'fdtd', 'compare'):
        mode.add_argument('--'+option, action='store_true')
    parser.add_argument('--out', type=Path)
    parser.add_argument('--mesh', type=int, choices=range(10, 81, 10), default=f.MESHES[0])
    parser.add_argument('--excite', type=int, choices=(1, 2), default=1)
    parser.add_argument('--padding', type=int, choices=(f.PADDING, f.CONTROL_PADDING), default=f.PADDING)
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker and not args.fdtd:
        parser.error('internal worker requires --fdtd')
    if args.preflight:
        for n in f.MESHES:
            sim = f.build(n, 1)
            print(json.dumps(dict(cpw=n, geometry=f.geometry(),
                cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])), limits=f.LIMITS)))
    elif args.study or args.fdtd or args.compare:
        if args.out is None:
            parser.error('--out is required')
        if args.compare:
            result = compare(args.out)
            (args.out/'comparison.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
            print(json.dumps(result, indent=2))
        elif args.fdtd:
            print(json.dumps((f.acquire if args.worker else serial)(args.out, args.mesh, args.excite, args.padding)))
        else:
            frozen = f.source_ids()
            for n, padding in [(n, f.PADDING) for n in f.MESHES]+[(f.CONTROL_MESH, f.CONTROL_PADDING)]:
                for pn in (1, 2):
                    if f.source_ids() != frozen:
                        raise RuntimeError('acquisition sources changed during cohort')
                    meta = serial(args.out/f'cpw{n}'/f'pad{padding}'/f'e{pn}', n, pn, padding)
                    print(json.dumps(dict(cpw=n, padding=padding, port=pn, cells=meta['cells'],
                        dt_s=meta['dt_s'], seconds=meta['run']['wall_time_s'], energy_stopped=meta['run'].get('converged'))), flush=True)
    else:
        unittest.main(argv=[sys.argv[0]])


if __name__ == '__main__':
    main()
