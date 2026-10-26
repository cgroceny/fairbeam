"""Clock-only TE10 controls; native propagation is explicitly opt-in."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import numpy as np
from fairbeam.procutil import popen_group, release_group, terminate_group
from tests.test_coax_resonator import wait_owned
from tests import waveguide_step_clock_fixture as f


def serial(out, cpw, excited, padding=f.base.PADDING, *, factor=1.):
    f.max_steps(factor)
    out = Path(out).resolve()
    if out.exists() or out.with_name(out.name+'.worker.json').exists() or out.with_name(out.name+'.log').exists():
        raise ValueError('fresh capture/log/receipt paths required')
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, '-m', 'tests.test_waveguide_step_clock', '--fdtd', '--worker',
               '--mesh', str(cpw), '--excite', str(excited), '--padding', str(padding),
               '--factor', str(factor), '--out', str(out)]
    source = f.identity()
    start, wall = time.monotonic(), time.time()
    proc, code, failure = None, None, None
    try:
        with out.with_name(out.name+'.log').open('x', encoding='utf-8') as log:
            proc = popen_group(command, cwd=f.ROOT/'python', stdout=log, stderr=subprocess.STDOUT)
            code = wait_owned(proc, seconds=f.base.CASE_SECONDS)
        if code:
            raise RuntimeError('native worker failed; incomplete prefix retained')
    except BaseException as error:
        failure = repr(error)
        raise
    finally:
        if proc is not None:
            if proc.poll() is None:
                terminate_group(proc.pid, grace=0, job=proc.win_job)
                proc.wait(timeout=15)
            release_group(proc)
        elapsed = max(time.monotonic()-start, time.time()-wall)
        f.save(out.with_name(out.name+'.worker.json'), dict(command=command, source=source, exit_code=code, failure=failure,
            wall_seconds=time.time()-wall, monotonic_seconds=time.monotonic()-start, deadline_seconds=f.base.CASE_SECONDS))
    if elapsed > f.base.CASE_SECONDS or f.identity() != source:
        raise ValueError('source changed or worker returned after its deadline')
    m = json.loads((out/'report.json').read_text(encoding='utf-8'))
    m['case_elapsed_s'] = elapsed
    f.save(out/'report.json', m)
    return m


class ClockTests(unittest.TestCase):
    def test_only_clock_and_step_budget_change(self):
        with tempfile.TemporaryDirectory() as folder:
            original = Path(folder)/'original.xml'
            f.base.build(50, 2, 24).fdtd.Write2XML(str(original))
            for factor in f.FACTORS:
                sim = f.build(50, 2, 24, factor=factor)
                path = Path(folder)/'controlled.xml'
                f.write_input(sim, path)
                if factor == 1.:
                    self.assertEqual(f.physical_sha(path), f.physical_sha(original))
                    continue
                self.assertGreaterEqual(f.max_steps(factor)*factor, 200000)
                self.assertLess(f.max_steps(factor)*factor, 200000+factor)
                a, b = [ET.parse(p).getroot() for p in (original, path)]
                self.assertEqual(float(b.find('FDTD').attrib.pop('TimeStepFactor')), factor)
                self.assertEqual(int(b.find('FDTD').attrib['NumberOfTimesteps']), f.max_steps(factor))
                b.find('FDTD').attrib['NumberOfTimesteps'] = a.find('FDTD').attrib['NumberOfTimesteps']
                for root in (a, b):
                    for parent in root.iter():
                        for child in list(parent):
                            if child.tag in ('FillColor', 'EdgeColor'):
                                parent.remove(child)
                self.assertEqual(ET.tostring(a), ET.tostring(b))
        for factor in (True, 0., -1., .5, .8, float('nan'), float('inf'), '.9'):
            with self.subTest(factor=factor), self.assertRaises(ValueError):
                f.build(50, 2, 24, factor=factor)

    def test_actual_operator_clocks_are_required(self):
        def operator(dt, steps):
            return dict(max_timesteps=steps, run=dict(timestep_s=dt, threads=4, engine='cpu',
                exact_endcriteria=True, converged=False, grid=[63, 29, 159]))
        for factor in (.9, .75):
            audit = dict(factor=factor, reference=operator(7e-13, 200000), selected=operator(factor*7e-13, f.max_steps(factor)))
            self.assertTrue(f.clock_quality(audit, factor*7e-13))
            self.assertFalse(f.clock_quality(audit, 7e-13))
            audit['selected']['run']['timestep_s'] = 7e-13
            self.assertFalse(f.clock_quality(audit, factor*7e-13))
            audit['selected']['run']['timestep_s'] = factor*7e-13
            audit['selected']['max_timesteps'] = 200000
            self.assertFalse(f.clock_quality(audit, factor*7e-13))
            audit['selected']['max_timesteps'] = f.max_steps(factor)
            audit['reference']['run']['timesteps'] = 1
            self.assertFalse(f.clock_quality(audit, factor*7e-13))
        self.assertFalse(f.clock_quality({}, 1e-12))

    def test_native_gaussian_cache_clocks_and_support(self):
        dt = 1e-12
        steps = int(np.ceil(f.base.PULSE_END_S/dt))
        with tempfile.TemporaryDirectory() as folder:
            raw = Path(folder)
            arrays = {}
            for name, offset in (('et', 0.), ('ht', .5)):
                t = (np.arange(steps)+offset)*dt
                arrays[name] = np.column_stack((t, np.cos(2*np.pi*1e10*t)))
                np.savetxt(raw/name, arrays[name], fmt='%.6g')
            self.assertEqual(f.source_cache(raw, dt)['complete_after_steps'], steps+1)
            a = arrays['ht'].copy()
            a[:, 0] += dt
            np.savetxt(raw/'ht', a, fmt='%.6g')
            with self.assertRaises(ValueError):
                f.source_cache(raw, dt)
            np.savetxt(raw/'ht', arrays['ht'], fmt='%.6g')
            np.savetxt(raw/'et', arrays['et'][:-3], fmt='%.6g')
            with self.assertRaises(ValueError):
                f.source_cache(raw, dt)

    def test_full_cohort_and_boundary_own_target_are_required(self):
        reference = f.base.reference()
        def perfect(root, cpw, padding, factor):
            return reference.copy()
        with patch.object(f, 'read_pair', side_effect=perfect):
            result = f.compare(Path('synthetic'), .9)
            self.assertTrue(result['numerical_checks_pass'])
            self.assertTrue(result['diagnostic_only'])
            self.assertFalse(result['qualified_scope'])
        def bad_control(root, cpw, padding, factor):
            s = reference.copy()
            phase = s[:, 0, 0]/abs(s[:, 0, 0])
            s[:, 0, 0] += 1j*phase*(.0105 if padding == f.base.CONTROL_PADDING else .0095)
            return s
        with patch.object(f, 'read_pair', side_effect=bad_control):
            result = f.compare(Path('synthetic'), .9)
            self.assertTrue(all(r['passes'] for r in result['rows']))
            self.assertLess(result['boundary_abs_max'], f.base.LIMITS['boundary_abs'])
            self.assertFalse(result['boundary_control']['passes'])
            self.assertFalse(result['qualified_scope'])
        with patch.object(f, 'read_pair', side_effect=ValueError('unconverged native source')):
            self.assertFalse(f.compare(Path('synthetic'), .9)['qualified_scope'])

    def test_singular_incidence_cannot_form_a_matrix(self):
        data = dict(a=np.ones((2, len(f.base.FREQUENCIES))), b=np.ones((2, len(f.base.FREQUENCIES))))
        with patch.object(f, 'read_source', return_value=({}, data)), self.assertRaises(ValueError):
            f.read_pair(Path('synthetic'), 50, 24, .9)

    def test_real_waiter_suspend_path_owns_cleanup_and_receipt(self):
        clock = dict(monotonic=0., wall=0.)
        class Process:
            pid, win_job, running = 123, object(), True
            def wait(self, timeout):
                if self.running:
                    clock['wall'] = f.base.CASE_SECONDS+1
                    raise subprocess.TimeoutExpired('worker', timeout)
                return 1
            def poll(self):
                return None if self.running else 1
        proc = Process()
        def stop(*args, **kwargs):
            proc.running = False
        with tempfile.TemporaryDirectory() as folder, patch(__name__+'.popen_group', return_value=proc), \
                patch(__name__+'.terminate_group') as outer_terminated, \
                patch('tests.test_coax_resonator.terminate_group', side_effect=stop) as terminated, \
                patch(__name__+'.release_group') as released, \
                patch('time.monotonic', side_effect=lambda: clock['monotonic']), \
                patch('time.time', side_effect=lambda: clock['wall']):
            out = Path(folder)/'new'
            with self.assertRaises(TimeoutError):
                serial(out, 50, 2, 24, factor=.9)
            terminated.assert_called_once_with(proc.pid, grace=0, job=proc.win_job)
            outer_terminated.assert_not_called()
            released.assert_called_once_with(proc)
            receipt = json.loads(out.with_name('new.worker.json').read_text(encoding='utf-8'))
            self.assertEqual(receipt['deadline_seconds'], f.base.CASE_SECONDS)
            self.assertIsNotNone(receipt['failure'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    for name in ('preflight', 'fdtd', 'compare'):
        mode.add_argument('--'+name, action='store_true')
    parser.add_argument('--mesh', type=int, choices=range(10, 81, 10), default=f.base.MESHES[0])
    parser.add_argument('--padding', type=int, choices=(f.base.PADDING, f.base.CONTROL_PADDING), default=f.base.PADDING)
    parser.add_argument('--excite', type=int, choices=(1, 2), default=1)
    parser.add_argument('--factor', type=float, choices=f.FACTORS, default=1.)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker and not args.fdtd:
        parser.error('worker requires --fdtd')
    if args.preflight:
        sim = f.build(args.mesh, args.excite, args.padding, factor=args.factor)
        print(json.dumps(dict(cpw=args.mesh, padding=args.padding, factor=args.factor,
            max_timesteps=f.max_steps(args.factor), grid_points=[len(sim.mesh.GetLines(a)) for a in 'xyz'],
            geometry=f.base.geometry(), limits=f.base.LIMITS)))
    elif args.fdtd or args.compare:
        if args.out is None:
            parser.error('--out is required')
        if args.compare:
            result = f.compare(args.out, args.factor)
            f.save(args.out/'comparison.json', result)
        else:
            result = (f.acquire if args.worker else serial)(args.out, args.mesh, args.excite, args.padding, factor=args.factor)
        print(json.dumps(result, indent=2))
    else:
        unittest.main(argv=[sys.argv[0]])


if __name__ == '__main__':
    main()
