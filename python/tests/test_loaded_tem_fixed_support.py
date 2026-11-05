"""Opt-in fixed-support TEM controls; ordinary discovery runs no native fields.

From python/, use fresh output paths outside the checkout:
python -m unittest tests.test_loaded_tem_fixed_support -q
python -m tests.test_loaded_tem_fixed_support --plan --mesh 4 --out D:/study/fixed-plan
python -m tests.test_loaded_tem_fixed_support --pilot --mesh 4 --out D:/study/fixed-pilot
python -m tests.test_loaded_tem_fixed_support --fdtd --mesh 4 --rate-mcps 80 --out D:/study/fixed/n4_point
python -m tests.test_loaded_tem_fixed_support --study --out D:/study/fixed

Run native calls one at a time. The pilot is source-incomplete and never
supplies S parameters. Replace the example rate with a matching local pilot.
"""
import argparse
import ctypes
import json
import math
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
from fairbeam.simulation import _nonfinite_energy
from tests.test_coax_resonator import forecast, wait_owned
from tests.test_loaded_tem_cell_fixture import audit_header
from tests import loaded_tem_cell_fixture as f
from tests import loaded_tem_fixed_support_fixture as m


def save_once(path, value):
    path = Path(path).resolve()
    if path.is_relative_to(f.ROOT):
        raise ValueError('study output outside the checkout required')
    if path.exists():
        if json.loads(path.read_text()) != value:
            raise ValueError('retain the prior result; use a fresh analysis epoch')
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        f.save(path, value)


def prepare(out, n, control, rate=20., *, pilot=False, enforce_budget=True):
    out = Path(out).resolve()
    if out.exists() or out.is_relative_to(f.ROOT):
        raise ValueError('fresh output outside the checkout required')
    with m.model_context(pilot):
        _, meta = f.build(n, 1, 1, 'loaded', control)
        estimate = forecast(meta, rate)
        limit = m.PILOT_DEADLINE if pilot else m.DEADLINE
        if enforce_budget and estimate > limit:
            raise ValueError('forecast exceeds the owned worker budget; defer before launch')
        out.mkdir(parents=True)
        rows = []
        for port in ((1,) if pilot else (1, 2)):
            sim, actual = f.build(n, 1, port, 'loaded', control)
            path = out/f'port{port}.planned.xml'
            sim.fdtd.Write2XML(str(path))
            sim.fdtd.SetTimeStep(0.)
            op = out/f'port{port}.operator.xml'
            sim.fdtd.Write2XML(str(op))
            rows.append(dict(port=port, input_sha256=f.sha(path), operator_input_sha256=f.sha(op),
                             cells=actual['native_cells'], dt_s=actual['declared_dt_s']))
        record = dict(n=n, control=control, pilot_only=pilot, source=f.identity(), runtime=f.runtime_identity(),
            rows=rows, rate_mcps=rate, estimated_seconds_per_source=estimate, deadline_seconds=limit,
            over_budget=estimate > limit, scope=m.SCOPE, native_propagations=0, qualified=False)
        f.save(out/'protocol.json', record)
    return record


def loaded_windows_modules(runtime):
    if os.name != 'nt':
        return None  # Other platforms retain the existing file-fingerprint admission.
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetModuleHandleW.argtypes = (ctypes.c_wchar_p,)
    kernel.GetModuleHandleW.restype = ctypes.c_void_p
    kernel.GetModuleFileNameW.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint)
    kernel.GetModuleFileNameW.restype = ctypes.c_uint
    expected = {Path(path).resolve(): digest for path, digest in runtime['files'].items()}
    observed = {}
    for name in ('openEMS.dll', 'CSXCAD.dll'):
        handle = kernel.GetModuleHandleW(name)
        buffer = ctypes.create_unicode_buffer(32768)
        if not handle or not kernel.GetModuleFileNameW(handle, buffer, len(buffer)):
            raise ValueError('loaded native module path unavailable')
        path = Path(buffer.value).resolve()
        digest = f.sha(path)
        if path not in expected or expected[path] != digest:
            raise ValueError('loaded native module differs from its runtime fingerprint')
        observed[name] = dict(path=str(path), sha256=digest)
    return observed


def worker(out, n, control, port, pilot):
    out = Path(out).resolve()
    if out != out.parent/f'port{port}':
        raise ValueError('declared per-port worker output required')
    protocol_path = out.parent/'protocol.json'
    protocol = json.loads(protocol_path.read_text())
    limit = m.PILOT_DEADLINE if pilot else m.DEADLINE
    estimate = protocol['estimated_seconds_per_source']
    if (protocol['n'] != n or protocol['control'] != control or protocol['pilot_only'] != pilot
            or protocol['over_budget'] or protocol['deadline_seconds'] != limit
            or not isinstance(estimate, (int, float)) or isinstance(estimate, bool)
            or not np.isfinite(estimate) or not 0 < estimate <= limit):
        raise ValueError('worker differs from its prospective protocol')
    row = next(x for x in protocol['rows'] if x['port'] == port)
    original_run = f.TEMSimulation.run
    own_run = 'run' in f.TEMSimulation.__dict__
    with m.model_context(pilot):
        if f.identity() != protocol['source'] or f.runtime_identity() != protocol['runtime']:
            raise ValueError('source/runtime changed before native setup')
        loaded = loaded_windows_modules(protocol['runtime'])
        # Check the scientific input as well as the setup input before either
        # native call; repeat the check on the actual object at each boundary.
        sim, meta = f.build(n, 1, port, 'loaded', control)
        for operator in (False, True):
            if operator:
                sim.fdtd.SetTimeStep(0.)
            path = out.parent/f"port{port}.worker-{'operator' if operator else 'planned'}.xml"
            sim.fdtd.Write2XML(str(path))
            if f.sha(path) != row['operator_input_sha256' if operator else 'input_sha256']:
                raise ValueError('prospective input changed before native setup')
        def guarded(sim, path, *args, **kwargs):
            operator = bool(kwargs.get('setup_only'))
            xml = Path(path).parent/('before-operator.xml' if operator else 'before-fields.xml')
            if f.identity() != protocol['source'] or f.runtime_identity() != protocol['runtime']:
                raise ValueError('source/runtime changed before a native call')
            sim.fdtd.Write2XML(str(xml))
            if f.sha(xml) != row['operator_input_sha256' if operator else 'input_sha256']:
                raise ValueError('native XML differs from its prospective hash')
            return original_run(sim, path, *args, **kwargs)
        try:
            f.TEMSimulation.run = guarded
            meta = f.acquire(out, n, 1, port, 'loaded', control)
            if loaded_windows_modules(protocol['runtime']) != loaded:
                raise ValueError('loaded native modules changed during the worker')
            meta.update(fixed_support_protocol_sha256=f.sha(protocol_path), loaded_native_modules=loaded,
                        worker_pid=os.getpid(), worker_parent_pid=os.getppid())
            f.save(out/'report.json', meta)
        finally:
            if own_run:
                f.TEMSimulation.run = original_run
            else:
                del f.TEMSimulation.run
    return meta


def wait_finite(proc, log_path, seconds):
    original = proc.wait
    def checked(*args, **kwargs):
        try:
            return original(*args, **kwargs)
        finally:
            if line := _nonfinite_energy(Path(log_path).read_text(encoding='utf-8')):
                raise RuntimeError('nonfinite native linear energy: '+line)
    proc.wait = checked
    try:
        return wait_owned(proc, seconds=seconds)
    finally:
        proc.wait = original


def acquire(out, n, control, rate, *, pilot=False):
    protocol = prepare(out, n, control, rate, pilot=pilot)
    out = Path(out).resolve()
    progress = dict(status='running', source=protocol['source'], pilot_only=pilot, ports=[], qualified=False)
    try:
        for row in protocol['rows']:
            port = row['port']
            command = [sys.executable, '-m', m.WORKER_MODULE, '--worker', '--mesh', str(n),
                       '--control', control, '--port', str(port), '--out', str(out/f'port{port}')]
            log_path = out/f'port{port}.log'
            start, wall = time.monotonic(), time.time()
            code = failure = None
            with log_path.open('x', encoding='utf-8') as log:
                proc = popen_group(command, cwd=f.ROOT/'python', stdout=log, stderr=subprocess.STDOUT,
                    env={**os.environ, 'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1'})
                progress.update(active_port=port, active_launcher_pid=proc.pid)
                f.save(out/'progress.json', progress)
                try:
                    code = wait_finite(proc, log_path, protocol['deadline_seconds'])
                except BaseException as error:
                    failure = repr(error)
                    raise
                finally:
                    if proc.poll() is None:
                        terminate_group(proc.pid, grace=0, job=proc.win_job)
                        proc.wait(timeout=15)
                    release_group(proc)
                    f.save(out/f'port{port}.worker.json', dict(command=command, pid=proc.pid, exit_code=code,
                        failure=failure, wall_seconds=time.time()-wall, monotonic_seconds=time.monotonic()-start,
                        deadline_seconds=protocol['deadline_seconds'],
                        estimated_seconds=protocol['estimated_seconds_per_source']))
            if code != 0:
                raise RuntimeError('native source failed; retain its output and closing receipt')
            report_path = out/f'port{port}/report.json'
            meta = json.loads(report_path.read_text())
            text = log_path.read_text(encoding='utf-8')
            meta.update(native_header=audit_header(text, meta), native_log_sha256=f.sha(log_path))
            f.save(report_path, meta)
            with m.model_context(pilot):
                meta, _, _, quality = f.read(report_path.parent)
            expected = {key for key, value in quality.items() if not value}
            if expected != ({'source', 'energy'} if pilot else set()):
                raise ValueError('native source quality admission failed: '+repr(quality))
            progress['ports'].append(dict(port=port, quality=quality))
        if pilot:
            native = meta['native']
            if native['timesteps'] != meta['max_timesteps'] or native['iteration_wall_s'] <= 0:
                raise ValueError('fixed-window timing pilot incomplete')
            result = dict(pilot_only=True, source_complete=False, qualified=False, native=native,
                conservative_rate_mcps=.8*native['cells']*native['timesteps']/native['iteration_wall_s']/1e6)
        else:
            with m.model_context():
                m.admit_closing(out, n, control)
                _, result = f.matrix(out)
        progress.update(status='complete', result=result)
    except BaseException as error:
        progress.update(status='rejected', reason=repr(error))
        raise
    finally:
        progress.update(active_port=None, active_launcher_pid=None)
        f.save(out/'progress.json', progress)
    return result


class FixedSupportTests(unittest.TestCase):
    def test_fixed_physical_support_planes_pml_clock_and_capacitance(self):
        witnesses = {}
        with patch.object(f.Simulation, 'run', side_effect=AssertionError('no native runs')) as run:
            for n in f.MESHES:
                for control in ('ordinary', 'element'):
                    sim, meta = m.build(n, 1, 1, control=control)
                    x = np.array(meta['mesh_mm']['x'])*sim.unit
                    np.testing.assert_allclose(x[:9], np.linspace(-.02, -.019, 9), rtol=0, atol=1e-14)
                    np.testing.assert_allclose(x[-9:], np.linspace(.019, .02, 9), rtol=0, atol=1e-14)
                    np.testing.assert_allclose(meta['planes_m'], [-.005, .005], rtol=0, atol=1e-14)
                    np.testing.assert_allclose(meta['source_planes_m'], [-.015, .015], rtol=0, atol=1e-14)
                    np.testing.assert_allclose(meta['physical_pmc_planes_m'], [0, f.WIDTH], rtol=0, atol=1e-17)
                    cap = meta['native_capacitors'][0]
                    radius = 1 if control == 'element' else 0
                    self.assertEqual(cap['start_x_m'], -radius*m.PITCH)
                    self.assertEqual(cap['stop_x_m'], radius*m.PITCH)
                    self.assertEqual(cap['capacitance_f'], f.CAPACITANCE)
                    declared = next(p for p in sim.lumped_elements if p['name'] == 'cell_C1')
                    self.assertEqual(declared['C'], cap['native_capacitance_f'])
                    self.assertEqual(declared['start'][0]*sim.unit, cap['start_x_m'])
                    self.assertEqual(declared['stop'][0]*sim.unit, cap['stop_x_m'])
                    witness = (cap['native_capacitance_f'], cap['replaced_air_capacitance_f'], meta['declared_dt_s'])
                    if control in witnesses:
                        self.assertEqual(witness, witnesses[control])
                    witnesses[control] = witness
                    self.assertEqual(meta['native_cells'], math.prod(meta['grid']))
            run.assert_not_called()

    def test_fixed_patch_has_no_interleaved_slivers_and_clock_fits_actual_grid(self):
        with patch.object(f.Simulation, 'run', side_effect=AssertionError('no native runs')) as run:
            for n in f.MESHES:
                for control in ('ordinary', 'element'):
                    sim, meta = m.build(n, 1, 1, control=control)
                    spacing = [float(np.diff(meta['mesh_mm'][axis]).min())*sim.unit for axis in 'xyz']
                    self.assertGreaterEqual(min(spacing), m.PITCH*(1-1e-9))
                    cfl = 1/(f.C0*np.sqrt(sum(1/step**2 for step in spacing)))
                    self.assertLessEqual(meta['declared_dt_s'], .5*cfl)
            run.assert_not_called()

    def test_point_reference_matches_independent_original_abcd_and_spread_is_lossless(self):
        np.testing.assert_allclose(m.reference('ordinary'), f.reference()[0], rtol=0, atol=3e-14)
        s = m.reference('element')
        np.testing.assert_allclose(s.conj().transpose(0, 2, 1)@s,
                                  np.broadcast_to(np.eye(2), s.shape), rtol=0, atol=3e-12)
        self.assertGreater(abs(s-m.reference('ordinary')).max(), 1e-4)
        with self.assertRaises(ValueError):
            m.reference('unknown')
        with self.assertRaises(ValueError):
            m.reference('element', np.array([2.4e9+1j]))

    def test_context_restores_legacy_builder_identity_and_default_xml(self):
        builder, identity = f.build, f.identity
        with tempfile.TemporaryDirectory() as tmp:
            before, after = Path(tmp)/'before.xml', Path(tmp)/'after.xml'
            sim, _ = f.build(4, 1, 2)
            sim.fdtd.Write2XML(str(before))
            with self.assertRaisesRegex(RuntimeError, 'synthetic'):
                with m.model_context():
                    self.assertIn('tests/loaded_tem_fixed_support_fixture.py', f.identity())
                    f.build(6, 1, 1)
                    raise RuntimeError('synthetic exit')
            self.assertIs(f.build, builder)
            self.assertIs(f.identity, identity)
            sim, _ = f.build(4, 1, 2)
            sim.fdtd.Write2XML(str(after))
            self.assertEqual(before.read_bytes(), after.read_bytes())

    def test_invalid_cases_and_nested_context_refuse(self):
        for args in ((True, 1, 1), (5, 1, 1), (4, 2, 1), (4, 1, True)):
            with self.assertRaises(ValueError):
                m.build(*args)
        for kwargs in (dict(kind='unloaded'), dict(control='time'), dict(pilot=1), dict(element_scale=8)):
            with self.assertRaises(ValueError):
                m.build(4, 1, 1, **kwargs)
        with m.model_context():
            with self.assertRaises(ValueError):
                with m.model_context():
                    pass

    def test_pilot_preserves_geometry_but_cannot_qualify_the_source(self):
        _, full = m.build(4, 1, 1)
        sim, pilot = m.build(4, 1, 1, pilot=True)
        for key in ('mesh_mm', 'native_capacitors', 'declared_dt_s', 'planes_m', 'source_planes_m'):
            self.assertEqual(full[key], pilot[key])
        self.assertTrue(pilot['pilot_only'])
        self.assertLess(pilot['cap_s'], pilot['source_duration_s'])
        self.assertEqual(pilot['max_timesteps'], sim.max_timesteps)

    def test_over_budget_and_invalid_rates_refuse_before_output_or_native_calls(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(f.Simulation, 'run') as run:
            out = Path(tmp)/'fresh'
            for rate in (0., float('nan'), 1e-9):
                with self.assertRaises(ValueError):
                    prepare(out, 8, 'element', rate)
                self.assertFalse(out.exists())
            run.assert_not_called()

    def test_prospective_plan_has_two_columns_and_cannot_be_reused(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(f.Simulation, 'run') as run:
            out = Path(tmp)/'fresh'
            plan = prepare(out, 4, 'ordinary', 100.)
            self.assertEqual([x['port'] for x in plan['rows']], [1, 2])
            self.assertEqual(plan['native_propagations'], 0)
            self.assertFalse(plan['qualified'])
            for row in plan['rows']:
                self.assertEqual(f.sha(out/f"port{row['port']}.planned.xml"), row['input_sha256'])
            with self.assertRaises(ValueError):
                prepare(out, 4, 'ordinary', 100.)
            run.assert_not_called()

    def test_missing_and_failed_native_sources_do_not_pass_a_study(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = m.study(Path(tmp))
            self.assertEqual(len(result['missing']), 6)
            self.assertFalse(result['fixed_geometry_mesh_passes'])
            self.assertFalse(result['qualified'])
        with patch.object(m, 'admit_closing', side_effect=ValueError('failed source')):
            result = m.study('absent')
            self.assertEqual(len(result['rejected']), 6)
            self.assertFalse(result['fixed_geometry_mesh_passes'])

    def test_study_cli_creates_missing_external_parent_and_preserves_prior_result(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(f.Simulation, 'run') as run, \
                patch('builtins.print'):
            out = Path(tmp)/'not-yet-created'
            with patch.object(sys, 'argv', ['fixture', '--study', '--out', str(out)]):
                main()
                saved = out/'fixed-support-study.json'
                result = json.loads(saved.read_text())
                before = saved.read_bytes()
                self.assertEqual(len(result['missing']), 6)
                self.assertFalse(result['qualified'])
                self.assertFalse(result['fixed_geometry_mesh_passes'])
                main()
                self.assertEqual(saved.read_bytes(), before)
            with self.assertRaisesRegex(ValueError, 'retain the prior result'):
                save_once(saved, {**result, 'qualified': True})
            self.assertEqual(saved.read_bytes(), before)
            forbidden = f.ROOT/'_fixed_support_forbidden_test_output'
            self.assertFalse(forbidden.exists())
            with self.assertRaisesRegex(ValueError, 'outside the checkout'):
                save_once(forbidden/'fixed-support-study.json', result)
            self.assertFalse(forbidden.exists())
            run.assert_not_called()

    def test_complete_synthetic_mesh_family_is_still_not_whole_example_qualification(self):
        def matrix(folder):
            name = Path(folder).name
            n = int(name.split('_')[0][1:])
            control = 'element' if name.endswith('spread') else 'ordinary'
            return m.reference(control), dict(n=n, count=1, kind='loaded', control=control,
                all_native_complete=True, target_passes=True, qualified=False)
        with patch.object(m, 'admit_closing'), patch.object(f, 'matrix', side_effect=matrix):
            result = m.study('synthetic-only')
        self.assertTrue(result['fixed_geometry_mesh_passes'])
        self.assertEqual(len(result['mesh_changes']), 4)
        self.assertEqual(len(result['point_spread_controls']), 3)
        self.assertFalse(result['qualified'])
        self.assertFalse(result['original_study_reclassified'])

    def test_tampered_scientific_input_refuses_before_any_native_setup(self):
        module = sys.modules[__name__]
        with tempfile.TemporaryDirectory() as tmp, patch.object(f.Simulation, 'run') as run:
            out = Path(tmp)/'fresh'
            plan = prepare(out, 4, 'ordinary', 100.)
            plan['rows'][0]['input_sha256'] = '0'*64
            f.save(out/'protocol.json', plan)
            with patch.object(module, 'loaded_windows_modules', return_value=None):
                with self.assertRaisesRegex(ValueError, 'before native setup'):
                    worker(out/'port1', 4, 'ordinary', 1, False)
            run.assert_not_called()
            self.assertFalse((out/'port1').exists())

    def test_zero_cli_rate_does_not_silently_select_the_planning_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)/'fresh'
            with patch.object(sys, 'argv', ['fixture', '--plan', '--out', str(out), '--rate-mcps', '0']):
                with self.assertRaises(ValueError):
                    main()
            self.assertFalse(out.exists())

    def test_worker_failure_restores_the_inherited_native_run_hook(self):
        module = sys.modules[__name__]
        own_before = f.TEMSimulation.__dict__.get('run')
        builder, identity = f.build, f.identity
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)/'fresh'
            prepare(out, 4, 'ordinary', 100.)
            with patch.object(module, 'loaded_windows_modules', return_value=None), \
                    patch.object(f, 'acquire', side_effect=RuntimeError('synthetic source failure')):
                with self.assertRaisesRegex(RuntimeError, 'synthetic source failure'):
                    worker(out/'port1', 4, 'ordinary', 1, False)
        self.assertIs(f.TEMSimulation.__dict__.get('run'), own_before)
        self.assertIs(f.build, builder)
        self.assertIs(f.identity, identity)

    def test_failed_owned_worker_is_retained_and_only_its_job_is_cleaned_up(self):
        module = sys.modules[__name__]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)/'fresh'
            proc = Mock(pid=17, win_job=object())
            proc.poll.return_value = None
            proc.wait.return_value = 1
            with patch.object(module, 'popen_group', return_value=proc), \
                    patch.object(module, 'wait_finite', side_effect=RuntimeError('synthetic nonfinite')), \
                    patch.object(module, 'terminate_group') as stop, patch.object(module, 'release_group') as release:
                with self.assertRaisesRegex(RuntimeError, 'synthetic nonfinite'):
                    acquire(out, 4, 'ordinary', 100.)
                stop.assert_called_once_with(proc.pid, grace=0, job=proc.win_job)
                release.assert_called_once_with(proc)
            closing = json.loads((out/'port1.worker.json').read_text())
            self.assertIsNone(closing['exit_code'])
            self.assertIn('nonfinite', closing['failure'])
            progress = json.loads((out/'progress.json').read_text())
            self.assertEqual(progress['status'], 'rejected')
            self.assertIsNone(progress['active_launcher_pid'])
            self.assertFalse((out/'matrix.npz').exists())

    def test_closing_admission_refuses_failed_overdue_wrong_owner_and_pilot_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)/'synthetic-envelope-only'
            plan = prepare(out, 4, 'ordinary', 100.)
            originals = []
            for port in (1, 2):
                folder = out/f'port{port}'
                folder.mkdir()
                (folder/'input.xml').write_bytes((out/f'port{port}.planned.xml').read_bytes())
                (folder/'operator-input.xml').write_bytes((out/f'port{port}.operator.xml').read_bytes())
                log = out/f'port{port}.log'
                log.write_text('Synthetic envelope test; no native fields.\n')
                meta = dict(pilot_only=False, worker_pid=101+port, worker_parent_pid=17,
                    native=dict(iteration_wall_s=1.), native_log_sha256=f.sha(log),
                    fixed_support_protocol_sha256=f.sha(out/'protocol.json'))
                command = [sys.executable, '-m', m.WORKER_MODULE, '--worker', '--mesh', '4',
                           '--control', 'ordinary', '--port', str(port), '--out', str(folder.resolve())]
                closing = dict(command=command, pid=17, exit_code=0, failure=None,
                    deadline_seconds=m.DEADLINE, wall_seconds=2., monotonic_seconds=2.)
                f.save(folder/'report.json', meta)
                f.save(out/f'port{port}.worker.json', closing)
                originals.append(closing)
            m.admit_closing(out, 4, 'ordinary')
            for changes in (dict(exit_code=1), dict(failure='interrupted'), dict(pid=999),
                            dict(wall_seconds=m.DEADLINE+1), dict(monotonic_seconds=float('nan'))):
                # Inject malformed external input directly; the ordinary
                # result writer already refuses non-JSON NaN values.
                (out/'port1.worker.json').write_text(json.dumps({**originals[0], **changes}), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'admission|ownership'):
                    m.admit_closing(out, 4, 'ordinary')
            f.save(out/'port1.worker.json', originals[0])
            plan['pilot_only'] = True
            f.save(out/'protocol.json', plan)
            with self.assertRaisesRegex(ValueError, 'full fixed-support'):
                m.admit_closing(out, 4, 'ordinary')

    def test_owned_wait_rejects_linear_nan_but_preserves_zero_negative_infinity_db(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp)/'worker.log'
            proc = Mock(pid=17, win_job=None)
            original = proc.wait
            original.return_value = 0
            log.write_text('[@ 4s] Timestep: 16 || Energy: ~0 (-inf dB)\n')
            self.assertEqual(wait_finite(proc, log, 1.), 0)
            original.side_effect = subprocess.TimeoutExpired('worker', 1.)
            log.write_text('[@ 4s] Timestep: 16 || Energy: ~-nan(ind) (-0.00dB)\n')
            with self.assertRaisesRegex(RuntimeError, 'nonfinite'):
                wait_finite(proc, log, 1.)
            self.assertIs(proc.wait, original)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    for name in ('plan', 'pilot', 'fdtd', 'study', 'worker'):
        actions.add_argument('--'+name, action='store_true')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--mesh', type=int, choices=f.MESHES, default=4)
    parser.add_argument('--control', choices=('ordinary', 'element'), default='ordinary')
    parser.add_argument('--port', type=int, choices=(1, 2), default=1)
    parser.add_argument('--rate-mcps', type=float)
    args = parser.parse_args()
    if args.worker:
        # The worker takes its pilot flag from the frozen protocol, not a second
        # mutually exclusive action flag.
        protocol = json.loads((args.out.resolve().parent/'protocol.json').read_text())
        return worker(args.out, args.mesh, args.control, args.port, protocol['pilot_only'])
    if args.study:
        result = m.study(args.out)
        save_once(args.out/'fixed-support-study.json', result)
    elif args.plan:
        result = prepare(args.out, args.mesh, args.control,
                         20. if args.rate_mcps is None else args.rate_mcps, enforce_budget=False)
    else:
        if args.fdtd and args.rate_mcps is None:
            parser.error('--fdtd requires a conservative rate from a matching pilot')
        result = acquire(args.out, args.mesh, args.control,
                         20. if args.rate_mcps is None else args.rate_mcps, pilot=args.pilot)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    if any(x in sys.argv for x in ('--plan', '--pilot', '--fdtd', '--study', '--worker')):
        main()
    else:
        unittest.main()
