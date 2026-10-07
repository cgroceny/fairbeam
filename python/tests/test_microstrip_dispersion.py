"""Pure tests; native phase study requires an explicit --fdtd or --study.

From python/: python -m tests.test_microstrip_dispersion --preflight
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
from unittest.mock import Mock, patch

import numpy as np

from fairbeam.procutil import popen_group, release_group, terminate_group
from tests import microstrip_dispersion_fixture as f


class DispersionControls(unittest.TestCase):
    def test_reference_limits_units_and_monotonicity(self):
        result = f.reference(np.array([0., 10e9, 1e15]))
        self.assertEqual(result['eps_eff'][0], result['static_eps_eff'])
        self.assertAlmostEqual(result['eps_eff'][-1], f.ER, delta=1e-8)
        self.assertTrue(np.all(np.diff(result['eps_eff']) > 0))
        # Independent substitution uses H converted from mm to metres.
        parameter = 2*f.MUE0*.00065*10e9/result['static_z_ohm']
        expected = f.ER-(f.ER-result['static_eps_eff'])/(1+(.6+.009*result['static_z_ohm'])*parameter**2)
        self.assertAlmostEqual(result['eps_eff'][1], expected, places=13)
        self.assertEqual(result['beta'][0], 0.)
        for frequency in ([-1.], [np.nan], [[1.]]):
            with self.assertRaises(ValueError):
                f.reference(frequency)

    def test_phase_probes_are_actual_grid_planes_inside_the_uniform_line(self):
        for n in f.MESHES:
            sim, centres = f.build(n)
            for p, centre in enumerate(centres):
                self.assertIn(centre, sim.mesh.GetLines('x'))
                box = sim.csx.GetPropertiesByName(f'phase{p}')[0].GetPrimitive(0)
                self.assertEqual(box.GetStart()[0], centre)
                self.assertEqual(box.GetStop()[0], centre)
                self.assertEqual(box.GetStart()[2], f.H)
                self.assertEqual(box.GetStop()[2], 0.)
        for n, air in ((True, 5.), (0, 5.), (6, 3.)):
            with self.assertRaises(ValueError):
                f.build(n, air)

    def test_reflected_dispersive_phase_inversion_over_the_whole_band(self):
        gamma = -.04+1j*f.reference()['beta']
        x = np.arange(6., 12.)*1e-3
        v = np.exp(-x[:, None]*gamma)+.27j*np.exp(x[:, None]*gamma)
        measured = f.triplets(v)
        np.testing.assert_allclose(measured, [gamma, gamma], atol=1e-11, rtol=0)
        np.testing.assert_allclose((measured.imag*f.C0/(2*np.pi*f.FREQUENCIES))**2,
                                   [f.reference()['eps_eff']]*2, atol=2e-13, rtol=0)

    def test_mesh_material_and_unaliased_phase_protocol(self):
        for n in f.MESHES:
            sim, _ = f.build(n)
            self.assertIn(f.H, sim.mesh.GetLines('z'))
            self.assertLess(int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])), 4_000_000)
            substrate = sim.csx.GetPropertiesByName('substrate')[0]
            np.testing.assert_array_equal(substrate.GetMaterialProperty('epsilon'), [f.ER]*3)
            np.testing.assert_array_equal(substrate.GetMaterialProperty('kappa'), [0.]*3)
        self.assertLess(np.max(2*np.pi*f.FREQUENCIES/f.C0*np.sqrt(f.ER)*.002), np.pi)

    def test_full_band_target_and_boundary_are_required(self):
        beta = f.reference()['beta']
        curves = np.tile(beta, (3, 1))
        self.assertFalse(assessment(curves, 0., None)['passes'])
        self.assertTrue(assessment(curves, 0., 0.)['passes'])
        self.assertFalse(assessment(curves[:2], 0., 0.)['passes'])
        curves[-1, -1] *= 1.04
        self.assertFalse(assessment(curves, 0., 0.)['passes'])
        self.assertFalse(assessment(np.tile(beta, (3, 1)), 0., .002)['passes'])

    def test_record_source_geometry_and_frequency_guards(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            centres = np.arange(6., 12.)
            nf, count = len(f.FREQUENCIES), len(centres)
            meta = dict(resolution=6, length_mm=f.LENGTH, kind='pec', excited_port=1,
                air_mm=f.AIR, width_mm=f.W, substrate_mm=f.H, eps_r=f.ER,
                geometry_thickness_mm=0., loss_tangent_at_f0=0., loss_reference_hz=f.F0,
                frequency_hz=f.FREQUENCIES.tolist(), dt_s=1e-14,
                dispersion_protocol='microstrip-phase-5-to-20GHz-v2', **f.identities(),
                run=dict(converged=True, exact_endcriteria=True, threads=4,
                         final_energy_bound_db=-70., wall_time_s=1.))
            data = dict(f=f.FREQUENCIES, centres=centres, gamma=np.ones((2, nf)),
                        v=np.ones((count, nf)))
            report = path/'report.json'
            report.write_text(json.dumps(meta), encoding='utf-8')
            np.savez(path/'data.npz', **data)
            load_case(path, 6)
            for key, value in (('dispersion_study_sha256', 'wrong'), ('width_mm', 1.999),
                               ('frequency_hz', [1.])):
                wrong = {**meta, key: value}
                report.write_text(json.dumps(wrong), encoding='utf-8')
                with self.assertRaises(ValueError):
                    load_case(path, 6)
            report.write_text(json.dumps(meta), encoding='utf-8')
            data['gamma'][0, -1] = np.nan
            np.savez(path/'data.npz', **data)
            with self.assertRaises(ValueError):
                load_case(path, 6)


    def test_suspend_deadline_and_over_budget_record_are_rejected(self):
        process = Mock(args=['native-worker'])
        process.wait.return_value = 0
        with patch.object(time, 'monotonic', side_effect=[0., 1., 2.]), \
             patch.object(time, 'time', side_effect=[100., 101., 1901.]):
            with self.assertRaises(subprocess.TimeoutExpired):
                wait_case(process)
        self.assertFalse(stopped(dict(run=dict(converged=True, exact_endcriteria=True,
            threads=4, final_energy_bound_db=-70., wall_time_s=1800.1))))
        for wall in (None, float('nan'), True):
            self.assertFalse(stopped(dict(run=dict(converged=True, exact_endcriteria=True,
                threads=4, final_energy_bound_db=-70., wall_time_s=wall))))


def wait_case(process, seconds=1800.):
    """Include both active and suspended time in the research case budget."""
    started, wall_started = time.monotonic(), time.time()
    while True:
        elapsed = max(time.monotonic()-started, time.time()-wall_started)
        remaining = seconds-elapsed
        if remaining <= 0:
            raise subprocess.TimeoutExpired(process.args, seconds)
        try:
            code = process.wait(timeout=min(1., remaining))
        except subprocess.TimeoutExpired:
            continue
        if max(time.monotonic()-started, time.time()-wall_started) > seconds:
            raise subprocess.TimeoutExpired(process.args, seconds)
        return code


def stopped(meta):
    run = meta['run']
    wall = run.get('wall_time_s')
    energy = run.get('final_energy_db')
    if energy is None:
        energy = run.get('final_energy_bound_db', 0)
    return bool(run.get('converged') and run.get('exact_endcriteria')
                and not run.get('hit_timestep_limit', False) and energy <= -70
                and type(wall) in (int, float) and np.isfinite(wall) and 0 <= wall <= 1800
                and run.get('threads') == 4)


def convergence(values, reference, spread, limits):
    values = np.asarray(values)
    reference = np.broadcast_to(reference, values.shape[1:])
    if (values.shape[0] != 3 or np.any(reference <= 0)
            or not np.isfinite(values).all() or not np.isfinite(reference).all()
            or not np.isfinite(spread) or spread < 0):
        raise ValueError('three mesh levels and a positive reference required')
    error = float(np.max(abs(values[-1]-reference)/reference))
    changes = [float(np.max(abs(b-a)/reference)) for a, b in zip(values[:-1], values[1:])]
    return dict(target_error_percent=100*error,
        mesh_changes_percent=[100*c for c in changes], spread_percent=100*spread,
        passes=bool(error <= limits[0] and max(changes) <= limits[1] and spread <= limits[2]))


def serial(out, n, air=f.AIR):
    if out.exists():
        raise ValueError('fresh native output directory required')
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.with_name(out.name+'.log').open('w', encoding='utf-8') as log:
        process = popen_group([sys.executable, '-m', 'tests.test_microstrip_dispersion',
            '--worker', '--out', str(out), '--mesh', str(n), '--air', str(air)],
            stdout=log, stderr=subprocess.STDOUT,
            env={**os.environ, 'OPENBLAS_NUM_THREADS':'1', 'OMP_NUM_THREADS':'1'})
        try:
            try:
                code = wait_case(process)
            except subprocess.TimeoutExpired:
                raise RuntimeError('30-minute case limit; retained output is excluded') from None
        finally:
            if process.poll() is None:
                terminate_group(process.pid, grace=0, job=process.win_job)
                process.wait(timeout=15)
            release_group(process)
    if code:
        raise RuntimeError(f'native case failed: {out}')
    return load_case(out, n, air)[0]


def load_case(path, n, air=f.AIR):
    meta = json.loads((path/'report.json').read_text(encoding='utf-8'))
    expected = dict(resolution=n, length_mm=f.LENGTH, kind='pec', excited_port=1,
        air_mm=air, width_mm=f.W, substrate_mm=f.H, eps_r=f.ER, geometry_thickness_mm=0.,
        loss_tangent_at_f0=0., loss_reference_hz=f.F0, frequency_hz=f.FREQUENCIES.tolist(),
        dispersion_protocol='microstrip-phase-5-to-20GHz-v2', **f.identities())
    if (any(meta.get(key) != value for key, value in expected.items()) or not stopped(meta)
            or not np.isfinite(meta.get('dt_s', np.nan)) or meta['dt_s'] <= 0):
        raise ValueError('dispersion geometry, frequency, source or completed-run mismatch')
    with np.load(path/'data.npz') as stored:
        data = {key:stored[key].copy() for key in stored.files}
    centres = np.arange(6., 12.)
    count, nf = len(centres), len(f.FREQUENCIES)
    shapes = dict(gamma=(2, nf), v=(count, nf))
    if (not np.array_equal(data.get('f'), f.FREQUENCIES)
            or not np.array_equal(data.get('centres'), centres)
            or any(key not in data or data[key].shape != shape for key, shape in shapes.items())
            or not all(np.isfinite(value).all() for value in data.values())):
        raise ValueError('invalid dispersion spectra or probe grid')
    return meta, data


def assessment(betas, spread, boundary_change):
    if not len(betas):
        raise ValueError('at least one completed mesh required')
    if len(betas) == 3:
        gate = convergence(betas, f.reference()['beta'], spread, f.PHASE_LIMITS)
    else:
        target = f.reference()['beta']
        gate = dict(target_error_percent=100*float(np.max(abs(betas[-1]-target)/target)),
            mesh_changes_percent=[100*float(np.max(abs(b-a)/target)) for a,b in zip(betas[:-1], betas[1:])],
            spread_percent=100*spread, passes=False,
            reason='All three predeclared meshes and both consecutive pairs are required')
    boundary_pass = (boundary_change is not None and np.isfinite(boundary_change)
                     and 0 <= boundary_change <= f.BOUNDARY_LIMIT)
    return dict(phase=gate, boundary_change_percent=None if boundary_change is None else 100*boundary_change,
                boundary_limit_percent=100*f.BOUNDARY_LIMIT,
                passes=bool(gate['passes'] and boundary_pass))


def compare(root, boundary_out=None):
    betas, spreads, rows, missing = [], [], [], []
    coarse_beta = None
    for n in f.MESHES:
        if not (root/f'n{n}'/'report.json').exists():
            missing.append(n)
            continue
        meta, data = load_case(root/f'n{n}', n)
        beta = data['gamma'].imag.mean(axis=0)
        if n == f.MESHES[0]:
            coarse_beta = beta
        if np.any(beta <= 0):
            raise ValueError('positive propagation phase required')
        spread = float(np.max(abs(data['gamma'].imag-beta)/beta))
        betas.append(beta); spreads.append(spread)
        epsilon = (beta*f.C0/(2*np.pi*f.FREQUENCIES))**2
        rows.append(dict(n=n, cells=meta['cells'], dt_ps=meta['dt_s']*1e12,
            seconds=meta['run']['wall_time_s'], beta_spread_percent=100*spread,
            samples=[dict(f_ghz=f.FREQUENCIES[i]*1e-9, beta_rad_m=float(beta[i]),
                eps_eff=float(epsilon[i]), reference_eps_eff=float(f.reference()['eps_eff'][i]),
                phase_degrees=float(beta[i]*f.PHASE_LENGTH_M*180/np.pi)) for i in (0, 20, 40, 60)]))
    boundary = None
    if boundary_out is not None and coarse_beta is not None:
        _, data = load_case(boundary_out, f.MESHES[0], 10.)
        boundary = float(np.max(abs(data['gamma'].imag.mean(axis=0)-coarse_beta)/coarse_beta))
    if not rows:
        raise ValueError('no completed dispersion mesh records')
    gate = assessment(betas, spreads[-1], boundary)
    return dict(status='limited PEC phase comparison; no loss, impedance or calibration validation',
                reference='Getsinger approximation; Qucs equations 11.59--11.61',
                limits=f.PHASE_LIMITS, rows=rows, missing_meshes=missing, gates=gate)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--preflight', action='store_true')
    actions.add_argument('--fdtd', action='store_true')
    actions.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    actions.add_argument('--study', action='store_true')
    actions.add_argument('--compare', action='store_true')
    parser.add_argument('--out', type=Path)
    parser.add_argument('--mesh', type=int, choices=f.MESHES, default=6)
    parser.add_argument('--air', type=float, choices=(5., 10.), default=f.AIR)
    parser.add_argument('--boundary-out', type=Path)
    args = parser.parse_args()
    if args.preflight:
        rows = []
        for n in f.MESHES:
            for air in (5., 10.):
                sim, _ = f.build(n, air)
                rows.append(dict(n=n, air_mm=air,
                    cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz']))))
        print(json.dumps(rows, indent=2))
    elif args.worker or args.fdtd or args.study or args.compare:
        if args.out is None:
            parser.error('--out is required')
        if args.worker:
            print(json.dumps(f.acquire(args.out, args.mesh, args.air)))
        elif args.fdtd:
            meta = serial(args.out, args.mesh, args.air)
            print(json.dumps(dict(n=args.mesh, air_mm=args.air, cells=meta['cells'],
                dt_ps=meta['dt_s']*1e12, seconds=meta['run']['wall_time_s'], energy_stopped=stopped(meta))))
        elif args.study:
            frozen = f.identities()
            for n in f.MESHES:
                if f.identities() != frozen:
                    raise RuntimeError('study source changed during acquisition')
                meta = serial(args.out/f'n{n}', n)
                print(json.dumps(dict(n=n, cells=meta['cells'], seconds=meta['run']['wall_time_s'])), flush=True)
        else:
            report = compare(args.out, args.boundary_out)
            (args.out/'comparison.json').write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
            print(json.dumps(report, indent=2))
    else:
        unittest.main(argv=[sys.argv[0]])


if __name__ == '__main__':
    main()
