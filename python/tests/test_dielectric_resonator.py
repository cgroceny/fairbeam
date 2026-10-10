r"""Open dielectric-resonator controls; ordinary unittest starts no FDTD.

From python/ in the bundled openEMS environment, using fresh external paths:
python -m unittest tests.test_dielectric_resonator -q
python -m tests.test_dielectric_resonator --preflight --out C:\Temp\dr-plan
python -m tests.test_dielectric_resonator --fdtd --mesh 8 --case dielectric --cap-ns 190 --rate-mcps 20 --out C:\Temp\dr-pilot
python -m tests.test_dielectric_resonator --analyse --out C:\Temp\dr-pilot
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET

import numpy as np

from fairbeam.procutil import popen_group, release_group, terminate_group
from tests.test_coax_resonator import forecast, wait_owned
from tests import dielectric_resonator_fixture as fixture


def audit_header(text, meta):
    version = re.search(r'openEMS 64bit -- version (\S+)', text)
    grid = re.search(r'FDTD simulation size: (\d+)x(\d+)x(\d+) --> (\d+) FDTD cells', text)
    interval = re.search(r'Exact-endcriteria: evaluating the end criteria every (\d+) timestep', text)
    if not version or not grid or not interval:
        raise ValueError('native version/grid/sampling header missing')
    if version[1] != 'v0.37.0-rc3' or f'fixed number of threads: {fixture.THREADS}' not in text:
        raise ValueError('bundled rc3 and declared thread count required')
    if list(map(int, grid.groups()[:3])) != meta['reported_grid_lines'] or int(grid[4]) != meta['native_cells']:
        raise ValueError('native allocation differs')
    if int(interval[1]) != int(1/(2*meta['f_max_hz']*meta['native']['dt_s'])):
        raise ValueError('native sampling schedule differs')
    if not all(value in text for value in ('Create cylindrical FDTD operator', 'r=0 included...',
                                           'Alpha is a full 2*PI => closed Cylinder')):
        raise ValueError('native axis/closed cylindrical geometry not confirmed')
    if re.search(r'forced timestep:.*larger than calculated timestep', text, re.I):
        raise ValueError('native stability bound exceeded')
    if re.search(r'resetting to PEC|not compatible with cylinder', text, re.I):
        raise ValueError('native boundary/extension fallback')
    if 'Uniaxial PML Extension' not in text:
        raise ValueError('native PML extension missing')
    return dict(version=version[1], threads=fixture.THREADS, nyquist_interval=int(interval[1]),
                axis_included=True, closed_alpha=True, pml_enabled=True)


def acquire_serial(out, n, kind, angular, clearance, pml, cap_s, rate):
    out = Path(out).resolve()
    if out.exists():
        raise ValueError('retain existing acquisition; choose a fresh output')
    _, meta = fixture.build(n, kind, angular, clearance, pml, cap_s)
    estimate = forecast(meta, rate)
    if estimate > 1800:
        raise ValueError(f'forecast {estimate/60:.2f} minutes exceeds 30; defer before launch')
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, '-m', 'tests.test_dielectric_resonator', '--fdtd', '--worker-case',
        '--mesh', str(n), '--case', kind, '--angular', str(angular), '--clearance-mm', str(clearance),
        '--pml', str(pml), '--cap-ns', str(cap_s*1e9), '--out', str(out)]
    log_path, code = out.with_name(out.name+'.log'), None
    with log_path.open('w', encoding='utf-8') as log:
        process = popen_group(command, cwd=Path(__file__).resolve().parents[1], stdout=log,
            stderr=subprocess.STDOUT,
            env={**os.environ, 'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1'})
        start, wall = time.monotonic(), time.time()
        try:
            code = wait_owned(process)
        finally:
            if process.poll() is None:
                terminate_group(process.pid, grace=0, job=process.win_job)
                process.wait(timeout=15)
            release_group(process)
            fixture.save(out.with_name(out.name+'.worker.json'), dict(command=command, pid=process.pid,
                exit_code=code, estimated_seconds=estimate, rate_mcps=rate,
                monotonic_seconds=time.monotonic()-start, wall_seconds=time.time()-wall))
    if code:
        raise RuntimeError(f'native exit {code}; raw and log retained')
    report = json.loads((out/'report.json').read_text(encoding='utf-8'))
    report['native_header'] = audit_header(log_path.read_text(encoding='utf-8'), report)
    fixture.save(out/'report.json', report)
    return fixture.read(out)


class References(unittest.TestCase):
    def test_fundamental_reference_and_approximation_scope(self):
        value = fixture.reference()
        self.assertAlmostEqual(value['f_hz'], 3149338143.9852066, places=3)
        beta, alpha = value['axial_k_m'], value['decay_k_air_m']
        length = fixture.LENGTH_MM*1e-3
        self.assertLess(beta*length/2, np.pi/2)
        self.assertAlmostEqual(beta*np.sin(beta*length/2)/(alpha*np.cos(beta*length/2)), 1, places=12)
        self.assertFalse(value['side_fringing_included'])
        self.assertFalse(value['radiation_q_predicted'])
        self.assertEqual(value['qd_approximate'], 1000.)
        self.assertLess(fixture.reference(96.)['f_hz'], value['f_hz'])
        for er in (0., 2., np.nan, np.inf):
            with self.assertRaises(ValueError):
                fixture.reference(er)

    def test_fixed_geometry_clearance_and_serialized_boundaries(self):
        cases = [(n, 4, 30., 8) for n in fixture.MESHES]+[(16, 8, 30., 8), (16, 4, 40., 8), (16, 4, 30., 12)]
        for n, angular, clearance, pml in cases:
            sim, meta = fixture.build(n, 'dielectric', angular, clearance, pml)
            r, z = np.asarray(sim.mesh.GetLines('x')), np.asarray(sim.mesh.GetLines('z'))
            self.assertEqual(r[0], 0.)
            self.assertIn(fixture.RADIUS_MM, r)
            self.assertIn(-fixture.LENGTH_MM/2, z)
            self.assertIn(fixture.LENGTH_MM/2, z)
            self.assertAlmostEqual(r[-pml-1]-fixture.RADIUS_MM, clearance, places=12)
            self.assertAlmostEqual(z[-pml-1]-fixture.LENGTH_MM/2, clearance, places=12)
            self.assertEqual(meta['native_cells'], len(r)*(angular+2)*len(z))
            self.assertGreaterEqual(np.diff(r).min(), fixture.RADIUS_MM/n*.99)
            self.assertGreaterEqual(np.diff(z).min(), fixture.LENGTH_MM/(2*n)*.99)
            with tempfile.TemporaryDirectory() as directory:
                xml = Path(directory)/'input.xml'
                sim.fdtd.Write2XML(str(xml))
                tree = ET.parse(xml).getroot()
                self.assertEqual(tree.find('ContinuousStructure').get('CoordSystem'), '1')
                self.assertEqual(tree.find('FDTD').get('CylinderCoords'), '1')
                self.assertEqual(tree.find('FDTD/BoundaryCond').get('xmax'), f'PML_{pml}')
                self.assertEqual(tree.find('FDTD/BoundaryCond').get('zmin'), f'PML_{pml}')
            with self.assertRaisesRegex(ValueError, 'no Cartesian bundle'):
                sim.to_bundle()

    def test_independent_controls_keep_clock_probe_planes_and_loss(self):
        records = [fixture.build(16, 'dielectric', a, gap, p)[1]
                   for a, gap, p in ((4, 30., 8), (8, 30., 8), (4, 40., 8), (4, 30., 12))]
        for key in ('declared_dt_s', 'probes_mm', 'physical_dimensions_mm', 'sigma_dielectric_s_m'):
            self.assertTrue(all(row[key] == records[0][key] for row in records))
        self.assertEqual(fixture.build(16, 'lossless')[1]['sigma_dielectric_s_m'], 0.)
        self.assertGreater(records[0]['sigma_dielectric_s_m'], 0.)

    def test_invalid_model_and_duration(self):
        for values in ((True, 'dielectric', 4, 30., 8, 190e-9), (10, 'dielectric', 4, 30., 8, 190e-9),
                       (12, 'conductor', 4, 30., 8, 190e-9), (12, 'dielectric', 3, 30., 8, 190e-9),
                       (12, 'dielectric', 4, 10., 8, 190e-9), (12, 'dielectric', 4, 30., 4, 190e-9),
                       (12, 'dielectric', 4, 30., 8, 80e-9), (12, 'dielectric', 4, 30., 8, np.nan)):
            with self.assertRaises(ValueError):
                fixture.build(*values)


class Analysis(unittest.TestCase):
    def test_free_signed_pole_and_multimode_detection(self):
        t = np.arange(0, 50e-9, 20e-12)
        f, q = 3.383e9, 812.
        y = np.exp(-np.pi*f/q*t)*np.cos(2*np.pi*f*t+.3)+.002
        result = fixture.pole(t, y)
        self.assertAlmostEqual(result['f_hz']/f, 1, places=10)
        self.assertAlmostEqual(result['q']/q, 1, places=8)
        growth = fixture.pole(t, np.exp(1e6*t)*np.cos(2*np.pi*f*t))
        self.assertLess(growth['alpha_s'], 0)
        self.assertIsNone(growth['q'])
        with self.assertRaisesRegex(ValueError, 'unambiguous'):
            fixture.pole(t, y+.2*np.cos(2*np.pi*3.65e9*t))
        for clock, signal in ((t[::-1], y), (t, y*np.nan), (t, np.zeros_like(t)), (t[:20], y[:20])):
            with self.assertRaises(ValueError):
                fixture.pole(clock, signal)

    def test_out_of_band_mode_separated_without_a_frequency_target(self):
        t = np.arange(0, 40e-9, 30e-12)
        frequency, q = 3.321e9, 127.
        primary = np.exp(-np.pi*frequency/q*t)*np.cos(2*np.pi*frequency*t+.7)
        secondary = .08*np.exp(-5e7*t)*np.sin(2*np.pi*5.71e9*t)
        value = fixture.pole(t, primary+secondary+.003)
        self.assertEqual(value['fitted_order'], 4)
        self.assertAlmostEqual(value['f_hz']/frequency, 1, places=10)
        self.assertAlmostEqual(value['q']/q, 1, places=8)
        self.assertLess(value['relative_residual'], 1e-10)
        self.assertEqual(len(value['other_poles']), 1)
        self.assertAlmostEqual(value['other_poles'][0]['f_hz']/5.71e9, 1, places=10)
        with self.assertRaisesRegex(ValueError, 'unambiguous'):
            fixture.pole(t, np.cos(2*np.pi*5.71e9*t))

    def test_multiple_out_of_band_pairs_and_order_agreement(self):
        t = np.arange(0, 50e-9, 30e-12)
        f, q = 3.329e9, 127.
        primary = np.exp(-np.pi*f/q*t)*np.cos(2*np.pi*f*t+.3)
        other = (.02*np.exp(-6e7*t)*np.sin(2*np.pi*5.71e9*t)
                 + .005*np.exp(-1.5e8*t)*np.cos(2*np.pi*9.12e9*t+.2)
                 + .0001*np.exp(-2e9*t)*np.sin(2*np.pi*13.3e9*t))
        value = fixture.pole(t, primary+other+.001)
        self.assertEqual(value['fitted_order'], 8)
        self.assertAlmostEqual(value['f_hz']/f, 1, places=8)
        self.assertAlmostEqual(value['q']/q, 1, places=7)
        self.assertTrue(value['order_stable'])
        self.assertEqual(value['order_check']['lower_order'], 6)
        self.assertEqual(len(value['other_poles']), 3)

    def test_native_log_delegation_and_failure_restores_handle(self):
        sim, _ = fixture.build(8, 'lossless')
        sim.fdtd = native = Mock()
        def runner(*args, **kwargs):
            sim.fdtd.SetCSX('geometry')
            return sim.fdtd.Run('raw', verbose=0, numThreads=1, cleanup=True)
        with patch.object(fixture.Simulation, 'run', side_effect=runner):
            sim.run('raw')
        native.SetCSX.assert_called_once_with('geometry')
        native.Run.assert_called_once_with('raw', verbose=2, numThreads=1, cleanup=True)
        self.assertIs(sim.fdtd, native)
        with patch.object(fixture.Simulation, 'run', side_effect=RuntimeError('failed')):
            with self.assertRaises(RuntimeError):
                sim.run('raw')
        self.assertIs(sim.fdtd, native)

    def test_budget_refusal_before_any_worker(self):
        with tempfile.TemporaryDirectory() as directory, patch('tests.test_dielectric_resonator.popen_group') as launch:
            with self.assertRaisesRegex(ValueError, 'exceeds 30'):
                acquire_serial(Path(directory)/'case', 24, 'dielectric', 8, 40., 12, 5e-6, 20.)
            launch.assert_not_called()

    def test_header_rejects_fallback_and_missing_axis(self):
        _, meta = fixture.build(8, 'lossless')
        meta['native'] = dict(dt_s=meta['declared_dt_s'])
        a, b, c = meta['reported_grid_lines']
        interval = int(1/(2*meta['f_max_hz']*meta['declared_dt_s']))
        text = (f'openEMS 64bit -- version v0.37.0-rc3\nfixed number of threads: 1\n'
                f'FDTD simulation size: {a}x{b}x{c} --> {meta["native_cells"]} FDTD cells\n'
                f'Exact-endcriteria: evaluating the end criteria every {interval} timestep\n'
                'Create cylindrical FDTD operator\nr=0 included...\nAlpha is a full 2*PI => closed Cylinder\nUniaxial PML Extension')
        self.assertTrue(audit_header(text, meta)['axis_included'])
        for invalid in (text.replace('r=0 included', 'axis absent'), text+'\nresetting to PEC',
                        text+'\nforced timestep: 2s larger than calculated timestep', text.replace('rc3', 'rc4'),
                        text.replace('Uniaxial PML Extension', 'extension absent')):
            with self.assertRaises(ValueError):
                audit_header(invalid, meta)

    def test_numerical_cohort_never_certifies_the_approximate_reference(self):
        base = dict(kind='dielectric', angular=4, clearance_mm=30., pml=8,
                    f_hz=3.35e9, q=850., completed_pole_control=True)
        rows = [dict(base, n=n) for n in fixture.COHORT]
        rows += [dict(base, n=16, angular=8), dict(base, n=16, clearance_mm=40.), dict(base, n=16, pml=12)]
        with tempfile.TemporaryDirectory() as directory, patch.object(fixture, 'read', side_effect=rows):
            value = fixture.study(directory)
        self.assertTrue(value['pole_converged'])
        self.assertFalse(value['qualified'])
        for index, key, value in ((2, 'q', 950.), (3, 'f_hz', 3.4e9), (4, 'completed_pole_control', False)):
            changed = [dict(row) for row in rows]
            changed[index][key] = value
            with tempfile.TemporaryDirectory() as directory, patch.object(fixture, 'read', side_effect=changed):
                self.assertFalse(fixture.study(directory)['pole_converged'])
        changed = [dict(row) for row in rows]
        changed[5]['pml'] = 8
        with tempfile.TemporaryDirectory() as directory, patch.object(fixture, 'read', side_effect=changed):
            with self.assertRaisesRegex(ValueError, 'identity'):
                fixture.study(directory)
        for meshes in ((12, 12, 20), (16, 12, 20), (12, 16), (4, 8, 12)):
            with self.assertRaises(ValueError):
                fixture.study('unused', meshes=meshes)

    def test_record_requires_complete_windows_stop_clocks_and_pml(self):
        for stopped, wrong_clock, short, order_stable in ((True, False, False, True), (False, False, False, True),
                                          (True, True, False, True), (True, False, True, True),
                                          (True, False, False, False)):
            with tempfile.TemporaryDirectory() as directory:
                out = Path(directory)
                _, meta = fixture.build(8, 'dielectric')
                dt = meta['declared_dt_s']
                stride = dt*meta['probe_stride_steps']
                t = np.arange(meta['max_timesteps']//meta['probe_stride_steps']+1)*stride
                if wrong_clock:
                    t *= 2
                if short:
                    t = t[t < 65e-9]
                (out/'input.xml').write_text('<own-synthetic-input/>', encoding='utf-8')
                np.savez_compressed(out/'data.npz', t=t, u=np.array([np.cos(2*np.pi*3.35e9*t)]*2),
                    energy_t=np.linspace(35e-9, 180e-9, 60), energy=np.geomspace(1, 1e-5, 60))
                meta.update(source_sha256=fixture.identity(), runtime=fixture.runtime_identity(), gates=fixture.GATES,
                    input_sha256=fixture.sha(out/'input.xml'), data_sha256=fixture.sha(out/'data.npz'),
                    native=dict(cells=meta['native_cells'], dt_s=dt, numerical_time_s=190e-9,
                                timesteps=meta['max_timesteps']-(2 if stopped else 0)),
                    run=dict(grid=meta['reported_grid_lines'], converged=stopped, threads=1),
                    native_header=dict(version='v0.37.0-rc3', threads=1, axis_included=True, closed_alpha=True,
                        pml_enabled=True, nyquist_interval=int(1/(2*meta['f_max_hz']*dt))))
                fixture.save(out/'report.json', meta)
                with patch.object(fixture, 'pole', return_value=dict(f_hz=3.35e9, q=850., alpha_s=1., relative_residual=0., order_stable=order_stable)), \
                        patch.object(fixture, 'energy_decay', return_value=dict(q=850., fitted_span_db=50., log_rms=0., q_rel_95_uncertainty=.001)):
                    result = fixture.read(out)
                    self.assertEqual(result['completed_pole_control'], stopped and not wrong_clock and not short and order_stable)
                self.assertFalse(result['qualified'])
                if short:
                    self.assertTrue(any('incomplete' in error for error in result['extraction_errors']))
                if stopped and not wrong_clock and not short:
                    meta['native_header']['pml_enabled'] = False
                    fixture.save(out/'report.json', meta)
                    self.assertFalse(fixture.read(out)['header_ok'])
                    (out/'input.xml').write_text('<changed/>', encoding='utf-8')
                    with self.assertRaisesRegex(ValueError, 'input or data'):
                        fixture.read(out)

    def test_paired_loss_uses_signed_rates_and_rejects_different_geometry(self):
        base = dict(n=12, angular=4, clearance_mm=30., pml=8, f_hz=3.35e9,
                    field_stable=True, completed_pole_control=True)
        a = dict(base, kind='lossless', alpha_s=1e6)
        b = dict(base, kind='dielectric', alpha_s=11e6)
        with patch.object(fixture, 'read', side_effect=[a, b]):
            value = fixture.loss_pair('a', 'b')
        self.assertAlmostEqual(value['intrinsic_q_inferred'], np.pi*3.35e9/10e6)
        self.assertTrue(value['completed_pair'])
        self.assertFalse(value['qualified'])
        with patch.object(fixture, 'read', side_effect=[a, dict(b, alpha_s=.5e6)]):
            self.assertIsNone(fixture.loss_pair('a', 'b')['intrinsic_q_inferred'])
        with patch.object(fixture, 'read', side_effect=[a, dict(b, pml=12)]):
            with self.assertRaisesRegex(ValueError, 'geometry'):
                fixture.loss_pair('a', 'b')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    for action in ('preflight', 'fdtd', 'analyse', 'study'):
        actions.add_argument('--'+action, action='store_true')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--mesh', type=int, choices=fixture.MESHES, default=8)
    parser.add_argument('--case', choices=fixture.KINDS, default='dielectric')
    parser.add_argument('--angular', type=int, choices=(4, 8), default=4)
    parser.add_argument('--clearance-mm', type=float, choices=(30., 40.), default=30.)
    parser.add_argument('--pml', type=int, choices=(8, 12), default=8)
    parser.add_argument('--cap-ns', type=float, default=190.)
    parser.add_argument('--rate-mcps', type=float, default=20.)
    parser.add_argument('--meshes', type=int, nargs=3, default=fixture.COHORT)
    parser.add_argument('--worker-case', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    cap = args.cap_ns/1e9
    if args.preflight:
        args.out.mkdir(parents=True, exist_ok=False)
        rows = []
        cases = [(n, 4, 30., 8) for n in fixture.MESHES]+[(16, 8, 30., 8), (16, 4, 40., 8), (16, 4, 30., 12)]
        for n, angular, gap, pml in cases:
            for kind in fixture.KINDS:
                sim, meta = fixture.build(n, kind, angular, gap, pml, cap)
                xml = args.out/f'{kind}_n{n}_a{angular}_gap{gap:g}_pml{pml}.xml'
                sim.fdtd.Write2XML(str(xml))
                rows.append(dict(**meta, input_sha256=fixture.sha(xml), estimated_seconds=forecast(meta, args.rate_mcps)))
        fixture.save(args.out/'preflight.json', dict(rows=rows, source_sha256=fixture.identity(),
            runtime=fixture.runtime_identity(), gates=fixture.GATES, rate_mcps=args.rate_mcps, qualified=False))
        print(json.dumps(dict(cases=len(rows), deferred=sum(row['estimated_seconds'] > 1800 for row in rows), qualified=False)))
    elif args.analyse:
        print(json.dumps(fixture.read(args.out), indent=2))
    elif args.study:
        print(json.dumps(fixture.study(args.out, args.case, args.meshes), indent=2))
    elif args.worker_case:
        print(json.dumps(fixture.acquire(args.out, args.mesh, args.case, args.angular, args.clearance_mm, args.pml, cap), indent=2))
    else:
        print(json.dumps(acquire_serial(args.out, args.mesh, args.case, args.angular, args.clearance_mm, args.pml, cap, args.rate_mcps), indent=2))


if __name__ == '__main__':
    if len(sys.argv) == 1:
        unittest.main()
    else:
        main()
