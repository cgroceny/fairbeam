r"""Opt-in TE10 interface cohort; ordinary unittest discovery does not run FDTD.

python -m tests.test_waveguide_step --preflight
python -m tests.test_waveguide_step --study --out C:\Temp\waveguide-step
python -m tests.test_waveguide_step --compare --out C:\Temp\waveguide-step
"""
import argparse
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import numpy as np

from fairbeam.multiport import assemble_s
from fairbeam.procutil import popen_group, release_group, terminate_group
from tests import waveguide_step_fixture as f
from tests.test_coax_resonator import wait_owned


def serial(out, cpw, excited, padding=f.PADDING, *, pulse='gaussian', termination='PML_8', hold_seed=None):
    f.controls(pulse, termination)
    if termination == 'MUR':
        return serial_mur(out, cpw, excited, padding, hold_seed=hold_seed)
    if hold_seed is not None:
        raise ValueError('a continuation seed requires the MUR control')
    out = Path(out).resolve()
    if out.exists():
        raise ValueError('use a fresh acquisition directory')
    if pulse not in f.PULSES:
        raise ValueError('unsupported research source pulse')
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, '-m', 'tests.test_waveguide_step', '--fdtd', '--worker',
               '--mesh', str(cpw), '--excite', str(excited), '--padding', str(padding), '--out', str(out)]
    if pulse != 'gaussian':
        command += ['--pulse', pulse]
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


def serial_mur(out, cpw, excited, padding, *, hold_seed=None):
    """One owned worker per primary/continuation, each with its own deadline."""
    out = Path(out).resolve()
    receipt, log_path = (out.with_name(out.name+suffix) for suffix in ('.worker.json', '.log'))
    if any(p.exists() for p in (out, receipt, log_path)):
        raise ValueError('fresh MUR output/log/receipt paths required')
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, '-X', 'utf8', '-m', 'tests.test_waveguide_step', '--fdtd', '--worker',
               '--termination', 'MUR', '--mesh', str(cpw), '--excite', str(excited),
               '--padding', str(padding), '--out', str(out)]
    if hold_seed is not None:
        command += ['--hold-seed', str(Path(hold_seed).resolve())]
    source = f.mur_ids()
    start, wall = time.monotonic(), time.time()
    proc, code, failure, log, worker_error = None, None, None, None, None
    try:
        with log_path.open('x', encoding='utf-8') as log:
            proc = popen_group(command, cwd=Path(__file__).resolve().parents[1],
                stdout=log, stderr=subprocess.STDOUT,
                env={**os.environ, 'OPENBLAS_NUM_THREADS':'1', 'OMP_NUM_THREADS':'1'})
            code = wait_owned(proc, seconds=f.CASE_SECONDS)
        if code or max(time.monotonic()-start, time.time()-wall) > f.CASE_SECONDS:
            raise RuntimeError('MUR worker failed or exceeded its deadline')
    except BaseException as error:
        worker_error = error
        failure = repr(error)
        raise
    finally:
        cleanup_error = log_error = None
        binding = None
        try:
            if proc is not None:
                try:
                    if proc.poll() is None:
                        terminate_group(proc.pid, grace=0, job=proc.win_job)
                        proc.wait(timeout=15)
                finally:
                    release_group(proc)
        except BaseException as error:
            cleanup_error = repr(error)
        try:
            if proc is None or proc.poll() is None or log is None or not log.closed:
                raise ValueError('worker exit and stream closure required before log finalization')
            binding = f.finalized_mur_log(log_path)
        except Exception as error:
            log_error = repr(error)
        # Preserve failed attempts without replacing their original exception.
        try:
            f._save(receipt, dict(protocol=f.WORKER_PROTOCOL, command=command, source=source,
                exit_code=code, failure=failure or cleanup_error or log_error,
                cleanup_error=cleanup_error, log_finalization_error=log_error,
                log_finalized=binding is not None, log=binding,
                deadline_seconds=f.CASE_SECONDS, wall_seconds=time.time()-wall,
                monotonic_seconds=time.monotonic()-start))
        except Exception as error:
            if worker_error is None:
                raise
            worker_error.add_note(f'MUR failure receipt could not be saved: {error!r}')
        if failure is None and (cleanup_error is not None or log_error is not None):
            raise RuntimeError('MUR worker cleanup or finished-log finalization failed')
    if source != f.mur_ids():
        raise ValueError('MUR sources changed during worker execution')
    meta = json.loads((out/'report.json').read_text(encoding='utf-8'))
    meta['case_elapsed_s'] = max(time.monotonic()-start, time.time()-wall)
    meta['worker_receipt_sha256'] = f._sha(receipt)
    f._save(out/'report.json', meta)
    return meta


def read_pair(root, cpw, padding, *, pulse='gaussian', termination='PML_8'):
    f.controls(pulse, termination)
    incoming, outgoing = [], []
    for pn in (1, 2):
        path = Path(root)/f'cpw{cpw}'/f'pad{padding}'/f'e{pn}'
        if termination == 'MUR':
            _, data = f.read_mur_source(path, cpw, pn, padding)
            incoming.append(data['a'])
            outgoing.append(data['b'])
            continue
        meta = json.loads((path/'report.json').read_text(encoding='utf-8'))
        expected = dict(protocol=f.PROTOCOL, geometry=f.geometry(), cpw=cpw, padding=padding,
                        excited=pn, frequency_hz=f.FREQUENCIES.tolist(),
                        limits=f.LIMITS, source_ids=f.source_ids())
        if any(meta.get(k) != v for k, v in expected.items()):
            raise ValueError('case source, geometry, frequency or protocol identity mismatch')
        if meta.get('termination', 'PML_8') != termination:
            raise ValueError('termination cohort mismatch')
        stats = meta.get('run', {})
        energy = [stats.get(k) for k in ('final_energy_db', 'final_energy_bound_db')]
        energy = [x for x in energy if isinstance(x, (int, float)) and not isinstance(x, bool) and np.isfinite(x)]
        durations = [stats.get('wall_time_s'), meta.get('case_elapsed_s')]
        if (stats.get('converged') is not True or stats.get('threads') != 4
                or stats.get('exact_endcriteria') is not True or stats.get('engine') != 'cpu'
                or stats.get('hit_timestep_limit') is not False
                or not isinstance(stats.get('timesteps'), int) or not 0 < stats['timesteps'] < 200000
                or not energy or max(energy) > f.END_DB+1e-9
                or any(isinstance(t, bool) or not isinstance(t, (int, float))
                       or not np.isfinite(t) or not 0 < t <= f.CASE_SECONDS for t in durations)
                or isinstance(meta.get('dt_s'), bool) or not isinstance(meta.get('dt_s'), (int, float))
                or not np.isfinite(meta['dt_s']) or meta['dt_s'] <= 0):
            raise ValueError('case is incomplete, over budget or lacks a confirmed exact energy stop')
        if pulse == 'gaussian':
            pulse_steps = meta.get('excitation_timesteps')
            if (meta.get('pulse', 'gaussian') != pulse
                    or isinstance(pulse_steps, bool) or not isinstance(pulse_steps, int)
                    or abs(pulse_steps-int(np.ceil(f.PULSE_END_S/meta['dt_s']))) > 1
                    or stats['timesteps'] < pulse_steps):
                raise ValueError('simulation stopped before the native Gaussian excitation completed')
        else:
            sim = f.build(cpw, pn, padding, pulse=pulse)
            if meta.get('pulse') != pulse or meta.get('excitation') != sim.excitation:
                raise ValueError('RF source identity mismatch')
            with tempfile.TemporaryDirectory() as folder:
                planned = Path(folder)/'input.xml'
                sim.fdtd.Write2XML(str(planned))
                if f.physical_input_sha(planned) != meta.get('physical_input_sha256'):
                    raise ValueError('rebuilt RF native input changed')
            for rel, key in (('input.xml', 'input_sha256'), ('data.npz', 'data_sha256'),
                             ('raw/openEMS_stats.txt', 'native_stats_sha256')):
                if hashlib.sha256((path/rel).read_bytes()).hexdigest() != meta.get(key):
                    raise ValueError('RF input/data/native statistics changed')
            audit = f.rf_source_audit(path/'raw', meta['dt_s'])
            native = meta.get('native', {})
            raw_stats = np.loadtxt(path/'raw/openEMS_stats.txt', comments='%')
            actual_native = dict(cells=int(raw_stats[0]), dt_s=float(raw_stats[1]), timesteps=int(raw_stats[2]),
                                 numerical_time_s=float(raw_stats[3]), iteration_wall_s=float(raw_stats[4]))
            if (meta.get('source_audit') != audit or stats['timesteps'] < audit['complete_after_steps']
                    or meta.get('excitation_timesteps') != audit['allocated_cache_steps']
                    or native != actual_native
                    or native.get('timesteps') != stats['timesteps'] or native.get('dt_s') != meta['dt_s']
                    or native.get('cells') != int(np.prod(stats['grid']))
                    or not np.isclose(native.get('numerical_time_s', 0), native['timesteps']*native['dt_s'], rtol=1e-8, atol=0)):
                raise ValueError('RF active support or native statistics mismatch')
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


def compare(root, *, pulse='gaussian', termination='PML_8'):
    f.controls(pulse, termination)
    root, rows, spectra, missing = Path(root), [], {}, []
    for cpw, padding in [(n, f.PADDING) for n in f.MESHES]+[(f.CONTROL_MESH, f.CONTROL_PADDING)]:
        paths = [root/f'cpw{cpw}'/f'pad{padding}'/f'e{pn}'/'report.json' for pn in (1, 2)]
        if not all(p.is_file() for p in paths):
            missing.extend(str(p.relative_to(root)) for p in paths if not p.is_file())
            continue
        spectra[cpw, padding] = read_pair(root, cpw, padding, pulse=pulse, termination=termination)
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
    result = dict(protocol=f.PROTOCOL, limits=f.LIMITS, rows=rows, missing_cases=missing,
                boundary_abs_max=boundary, boundary_control=control, qualified_scope=bool(passed),
                scope='complex TE10 power-wave S matrix on the fixed measurement planes only')
    if pulse != 'gaussian':
        result['pulse'] = pulse
    if termination != 'PML_8':
        result.update(termination=termination, hold_limits=f.MUR_HOLD,
                      scope='complex TE10 power-wave S matrix on fixed planes, with recorded 60 ns MUR controls')
    return result


class StepTests(unittest.TestCase):
    def test_mur_study_command_reports_structured_native_results_and_runs_all_holds(self):
        meta = dict(native=dict(cells=123, dt_s=1e-12), run=dict(wall_time_s=1., converged=True))
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as folder, \
                patch.object(sys, 'argv', ['study', '--study', '--termination', 'MUR', '--out', folder]), \
                patch(__name__+'.serial', return_value=meta) as worker, \
                patch.object(f, 'read_mur_source') as checked, contextlib.redirect_stdout(output):
            main()
        rows = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(rows), 8)
        self.assertTrue(all(row['cells'] == 123 and row['dt_s'] == 1e-12 for row in rows))
        self.assertEqual(worker.call_count, 16)
        self.assertEqual(checked.call_count, 8)
        self.assertEqual(sum(c.kwargs.get('hold_seed') is not None for c in worker.call_args_list), 8)

    def test_native_statistics_include_the_runtime_speed_row(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'openEMS_stats.txt'
            values = np.array([100., 1e-12, 60000., 60e-9, 1., 6e6])
            np.savetxt(path, values)
            self.assertEqual(f._native_stats(folder)['timesteps'], 60000)
            invalid = [values[:-1], np.r_[values[:5], np.nan]]
            for index, value in ((0, 100.5), (2, 60000.5), (1, 0.), (4, -1.)):
                broken = values.copy()
                broken[index] = value
                invalid.append(broken)
            for broken in invalid:
                np.savetxt(path, broken)
                with self.assertRaises(ValueError):
                    f._native_stats(folder)

    def test_mur_changes_only_end_boundaries_and_is_explicitly_opt_in(self):
        with tempfile.TemporaryDirectory() as folder:
            for cpw, padding in [(n, f.PADDING) for n in f.MESHES]+[(f.CONTROL_MESH, f.CONTROL_PADDING)]:
                for pn in (1, 2):
                    paths = [Path(folder)/f'{k}.xml' for k in range(3)]
                    sims = (f.build(cpw, pn, padding), f.build(cpw, pn, padding, termination='PML_8'),
                            f.build(cpw, pn, padding, termination='MUR'))
                    for sim, path in zip(sims, paths):
                        sim.fdtd.Write2XML(str(path))
                    self.assertEqual(f.physical_input_sha(paths[0]), f.physical_input_sha(paths[1]))
                    control = ET.parse(paths[2])
                    bc = control.getroot().find('FDTD/BoundaryCond')
                    self.assertEqual(bc.attrib, dict(xmin='PEC', xmax='PEC', ymin='PEC', ymax='PEC', zmin='MUR', zmax='MUR'))
                    bc.set('zmin', 'PML_8')
                    bc.set('zmax', 'PML_8')
                    control.write(paths[2], encoding='utf-8')
                    self.assertEqual(f.physical_input_sha(paths[0]), f.physical_input_sha(paths[2]))
        for pulse, termination in (('wrong', 'PML_8'), ('gaussian', 'wrong'), ('zero-integral-rf', 'MUR')):
            with self.subTest(pulse=pulse, termination=termination), tempfile.TemporaryDirectory() as folder:
                target = Path(folder)/'new'
                with self.assertRaises(ValueError):
                    f.acquire(target, 40, 1, pulse=pulse, termination=termination)
                self.assertFalse(target.exists())

    def hold_records(self):
        cache = dict(records={'et':{'sha256':'e'}, 'ht':{'sha256':'h'}}, complete_after_steps=15000)
        primary = dict(native=dict(dt_s=1e-12, timesteps=20000, cells=100, numerical_time_s=20e-9), cache=cache)
        hold = dict(native=dict(dt_s=1e-12, timesteps=60000, cells=100, numerical_time_s=60e-9),
            max_timesteps=60000, cache=cache, run=dict(energy_trace=[
                dict(timestep=30000, db=-100.), dict(timestep=45000, db=-105.), dict(timestep=60000, db=-110.)]))
        before = dict(a=np.ones((2, len(f.FREQUENCIES)), complex), b=np.ones((2, len(f.FREQUENCIES)), complex)*.2)
        return primary, before, hold, {k:v.copy() for k,v in before.items()}

    def test_mur_first_crossing_needs_a_complete_stable_continuation(self):
        primary, before, hold, after = self.hold_records()
        self.assertTrue(f.mur_hold_checks(primary, before, hold, after)['passes'])
        for failure in ('late-growth', 'short-window', 'clock', 'grid', 'cache', 'too-few-samples', 'wave-change'):
            with self.subTest(failure=failure):
                primary, before, hold, after = self.hold_records()
                if failure == 'late-growth':
                    hold['run']['energy_trace'][-1]['db'] = -76.16
                elif failure == 'short-window':
                    hold['native']['timesteps'] -= 1
                    hold['run']['energy_trace'][-1]['timestep'] -= 1
                elif failure == 'clock':
                    hold['native']['dt_s'] *= .99
                elif failure == 'grid':
                    hold['native']['cells'] += 1
                elif failure == 'cache':
                    hold['cache'] = {}
                elif failure == 'too-few-samples':
                    hold['run']['energy_trace'] = []
                else:
                    after['b'][0] += f.MUR_HOLD['wave_abs']*1.01
                self.assertFalse(f.mur_hold_checks(primary, before, hold, after)['passes'])
        before['a'] *= 0
        with self.assertRaises(ValueError):
            f.mur_hold_checks(primary, before, hold, after)
        with patch.object(f, 'load_mur_record', side_effect=[(primary, before), FileNotFoundError('no hold')]):
            with self.assertRaises(FileNotFoundError):
                f.read_mur_source(Path('synthetic'), 40, 1, f.PADDING)

    def test_mur_record_rejects_foreign_identity_before_reading_native_data(self):
        header = dict(protocol=f.MUR_PROTOCOL, native_log_contract=f.LOG_CONTRACT,
            kind='primary', termination='MUR', pulse='gaussian',
            cpw=40, excited=1, padding=f.PADDING, geometry=f.geometry(), frequency_hz=f.FREQUENCIES.tolist(),
            limits=f.LIMITS, hold_limits=f.MUR_HOLD, source_ids=f.source_ids(), mur_source_ids=f.mur_ids(),
            runtime=f._mur_runtime(), seed_report_sha256=None)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'report.json'
            for key, value in (('protocol', 'te10-mur-control-v1'), ('native_log_contract', None),
                               ('termination', 'PML_8'), ('pulse', 'zero-integral-rf'), ('kind', 'hold60ns'),
                               ('geometry', {}), ('frequency_hz', []), ('limits', {}), ('hold_limits', {}),
                               ('source_ids', {}), ('mur_source_ids', {}), ('runtime', {}), ('seed_report_sha256', 'wrong')):
                with self.subTest(key=key):
                    path.write_text(json.dumps({**header, key:value}), encoding='utf-8')
                    with self.assertRaisesRegex(ValueError, 'identity mismatch'):
                        f.load_mur_record(folder, 40, 1, f.PADDING)

    def test_mur_trace_rejects_false_distinct_observations_and_invalid_rows(self):
        primary, before, valid, after = self.hold_records()
        traces = [
            [dict(timestep=30000, db=-100.)]*3,
            [dict(timestep=n, db=-100.) for n in (70000, 70001, 70002)],
            valid['run']['energy_trace'][::-1],
        ]
        for step in (45000.5, 45000., True, float('nan'), float('inf'), 0, -1, '45000', None):
            rows = copy.deepcopy(valid['run']['energy_trace'])
            rows[1]['timestep'] = step
            traces.append(rows)
        for db in (float('nan'), float('inf'), -float('inf'), True, '-105', None):
            rows = copy.deepcopy(valid['run']['energy_trace'])
            rows[1]['db'] = db
            traces.append(rows)
        traces += [[{'db': -100.}], [None], {'timestep': 30000, 'db': -100.}]
        # Even a corrupt row before the primary stop invalidates the complete trace.
        traces.append([dict(timestep=0, db=-100.)]+valid['run']['energy_trace'])
        for rows in traces:
            with self.subTest(rows=rows):
                hold = copy.deepcopy(valid)
                hold['run']['energy_trace'] = rows
                with self.assertRaises(ValueError):
                    f.mur_hold_checks(primary, before, hold, after)
        for step in (True, 60000., float('nan')):
            with self.subTest(final_timestep=step):
                hold = copy.deepcopy(valid)
                hold['native']['timesteps'] = step
                with self.assertRaises(ValueError):
                    f.mur_hold_checks(primary, before, hold, after)
        valid['run']['energy_trace'].insert(0, dict(timestep=10000, db=-20.))
        self.assertTrue(f.mur_hold_checks(primary, before, valid, after)['passes'])
        valid['run']['energy_trace'].pop()
        self.assertFalse(f.mur_hold_checks(primary, before, valid, after)['passes'])

    def synthetic_mur_log(self, folder, *, primary=False):
        """Synthetic parser control, never a native acquisition/qualification."""
        path = Path(folder)/'case'
        path.mkdir()
        steps = 20000 if primary else 60000
        body = 'FDTD simulation size: 5x4x5\nFDTD timestep is: 1e-12 s\n'
        if not primary:
            body += ''.join(f'Timestep: {n} Energy: ~ 1e-10 (-{db}dB)\n'
                            for n, db in ((30000, 100), (45000, 105), (60000, 110)))
        body += f'Time for {steps} iterations with 1e+02 cells : 1.00 sec\n'
        maximum, end_db = (200000, -90.) if primary else (60000, -150.)
        run = f.simulation_module._parse_log(body, end_db, maximum)
        meta = dict(protocol=f.MUR_PROTOCOL, native_log_contract=f.LOG_CONTRACT,
            native=dict(cells=100, dt_s=1e-12, timesteps=steps, numerical_time_s=steps*1e-12),
            run=run, max_timesteps=maximum, native_end_db=end_db)
        # Deliberately repeat every energy line inside the worker's final JSON.
        text = f'{f.NATIVE_BEGIN}\n{body}{f.NATIVE_END}\n'+json.dumps(meta)+'\n'
        self.bind_synthetic_mur_log(path, meta, text)
        return path, meta, text

    def bind_synthetic_mur_log(self, path, meta, text):
        log = path.with_name(path.name+'.log')
        log.write_text(text, encoding='utf-8')
        receipt = dict(protocol=f.WORKER_PROTOCOL, log_finalized=True,
            log_finalization_error=None, cleanup_error=None, log=f.finalized_mur_log(log))
        receipt_path = path.with_name(path.name+'.worker.json')
        f._save(receipt_path, receipt)
        meta['worker_receipt_sha256'] = f._sha(receipt_path)
        return receipt

    def test_mur_log_replay_excludes_json_tail_and_handles_unsampled_primary_stop(self):
        for primary in (False, True):
            with self.subTest(primary=primary), tempfile.TemporaryDirectory() as folder:
                path, meta, text = self.synthetic_mur_log(folder, primary=primary)
                receipt = json.loads(path.with_name('case.worker.json').read_text(encoding='utf-8'))
                parsed = f.verify_mur_log(path, meta, receipt)
                self.assertEqual(len(parsed['energy_trace']), 0 if primary else 3)
                if primary:
                    self.assertEqual(parsed['final_energy_bound_db'], -90.)
                    self.assertTrue(parsed['converged'])
                else:
                    self.assertGreater(len(f.simulation_module._parse_log(text, -150., 60000)['energy_trace']), 3)
                    self.assertFalse(parsed['converged'])

    def test_mur_log_replay_rejects_changed_finished_bytes_or_receipt(self):
        for kind in ('bytes', 'receipt', 'unfinalized'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                path, meta, text = self.synthetic_mur_log(folder)
                receipt_path = path.with_name('case.worker.json')
                receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
                if kind == 'bytes':
                    with path.with_name('case.log').open('a', encoding='utf-8') as stream:
                        stream.write('late bytes after finalization\n')
                elif kind == 'receipt':
                    with receipt_path.open('a', encoding='utf-8') as stream:
                        stream.write('\n')
                else:
                    receipt['log_finalized'] = False
                    f._save(receipt_path, receipt)
                    meta['worker_receipt_sha256'] = f._sha(receipt_path)
                with self.assertRaises(ValueError):
                    f.verify_mur_log(path, meta, receipt)

    def test_mur_log_replay_rejects_ambiguous_frames_abort_and_malformed_energy(self):
        for kind in ('missing', 'repeated', 'reversed', 'inline', 'two-runs', 'abort', 'malformed'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                path, meta, text = self.synthetic_mur_log(folder)
                if kind == 'missing': text = text.replace(f.NATIVE_END, '')
                elif kind == 'repeated': text += f.NATIVE_BEGIN+'\n'
                elif kind == 'reversed': text = text.replace(f.NATIVE_BEGIN, 'TEMP').replace(f.NATIVE_END, f.NATIVE_BEGIN).replace('TEMP', f.NATIVE_END)
                elif kind == 'inline': text = text.replace(f.NATIVE_BEGIN, 'prefix '+f.NATIVE_BEGIN)
                elif kind == 'two-runs': text = text.replace(f.NATIVE_END, 'FDTD simulation size: 5x4x5\n'+f.NATIVE_END)
                elif kind == 'abort': text = text.replace(f.NATIVE_END, 'Gracefully aborting simulation now\n'+f.NATIVE_END)
                else: text = text.replace('Timestep: 45000 Energy: ~ 1e-10 (-105dB)', 'Timestep: 45000.5 Energy: ~ 1e-10 (-105dB)', 1)
                receipt = self.bind_synthetic_mur_log(path, meta, text)
                with self.assertRaises(ValueError):
                    f.verify_mur_log(path, meta, receipt)

    def test_mur_log_replay_rejects_report_trace_stop_grid_and_clock_changes(self):
        changes = [('energy_trace', [dict(timestep=n, db=-100.) for n in (30000, 45000, 60000)]),
            ('grid', [4, 5, 5]), ('timesteps', 59000), ('timesteps', True),
            ('timestep_s', 2e-12), ('solver_time_s', 2.), ('converged', True),
            ('hit_timestep_limit', False), ('final_energy_db', -120.), ('final_energy_db', float('nan')),
            ('final_energy_bound_db', -150.)]
        for key, value in changes:
            with self.subTest(key=key, value=value), tempfile.TemporaryDirectory() as folder:
                path, meta, text = self.synthetic_mur_log(folder)
                receipt = json.loads(path.with_name('case.worker.json').read_text(encoding='utf-8'))
                meta['run'][key] = value
                with self.assertRaises(ValueError):
                    f.verify_mur_log(path, meta, receipt)
        for key, value in (('cells', 101), ('dt_s', 2e-12)):
            with self.subTest(native=key), tempfile.TemporaryDirectory() as folder:
                path, meta, text = self.synthetic_mur_log(folder)
                receipt = json.loads(path.with_name('case.worker.json').read_text(encoding='utf-8'))
                meta['native'][key] = value
                with self.assertRaises(ValueError):
                    f.verify_mur_log(path, meta, receipt)

    def test_mur_native_tokens_reject_prefix_parsing_and_accept_real_log_layout(self):
        for token in ('45000.5', '45000.0', '45000e0', '45000x', '45000,5',
                      '+45000', '-45000', 'True', 'nan', 'inf'):
            with self.subTest(timestep=token), tempfile.TemporaryDirectory() as folder:
                path, meta, text = self.synthetic_mur_log(folder)
                text = text.replace('Timestep: 45000 ', f'Timestep: {token} ', 1)
                receipt = self.bind_synthetic_mur_log(path, meta, text)
                with self.assertRaises(ValueError):
                    f.verify_mur_log(path, meta, receipt)
        for token in ('5x4x5.5', '5x4x5e0', '5x4x5x2', '5x4xTrue'):
            with self.subTest(grid=token), tempfile.TemporaryDirectory() as folder:
                path, meta, text = self.synthetic_mur_log(folder)
                text = text.replace('FDTD simulation size: 5x4x5', f'FDTD simulation size: {token}', 1)
                receipt = self.bind_synthetic_mur_log(path, meta, text)
                with self.assertRaises(ValueError):
                    f.verify_mur_log(path, meta, receipt)
        with tempfile.TemporaryDirectory() as folder:
            path, meta, text = self.synthetic_mur_log(folder)
            # Native layout observed in retained CI logs, with synthetic values.
            text = text.replace('FDTD simulation size: 5x4x5\n',
                                'FDTD simulation size: 5x4x5 --> 100 FDTD cells \n', 1)
            text = text.replace('Timestep: 45000 Energy:',
                                '[@        4s] Timestep:         45000 || Speed: 37.7 MC/s || Energy:', 1)
            receipt = self.bind_synthetic_mur_log(path, meta, text)
            self.assertEqual(len(f.verify_mur_log(path, meta, receipt)['energy_trace']), 3)

    def test_mur_matrix_requires_both_sources_and_their_hold_evidence(self):
        reference = f.reference()
        a = np.broadcast_to(np.array([[1, .02j], [.03, .9]]), reference.shape).copy()
        b = reference@a
        def admitted(path, cpw, pn, padding):
            return {}, dict(a=a[:, :, pn-1].T, b=b[:, :, pn-1].T)
        with patch.object(f, 'read_mur_source', side_effect=admitted) as reader:
            np.testing.assert_allclose(read_pair(Path('synthetic'), 40, f.PADDING, termination='MUR'), reference, atol=4e-16)
            self.assertEqual(reader.call_count, 2)
        with patch.object(f, 'read_mur_source', side_effect=ValueError('missing or unstable hold')):
            with self.assertRaises(ValueError):
                read_pair(Path('synthetic'), 40, f.PADDING, termination='MUR')
        with tempfile.TemporaryDirectory() as folder:
            path = self.synthetic(folder)/'report.json'
            meta = json.loads(path.read_text(encoding='utf-8'))
            path.write_text(json.dumps({**meta, 'termination':'MUR'}), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'termination cohort'):
                read_pair(folder, 40, f.PADDING)

    def test_mur_real_waiter_deadline_writes_receipt_and_owns_cleanup(self):
        clock = dict(wall=0.)
        class Process:
            pid, win_job, running = 123, object(), True
            def wait(self, timeout):
                if self.running:
                    clock['wall'] = f.CASE_SECONDS+1
                    raise subprocess.TimeoutExpired('worker', timeout)
                return 1
            def poll(self):
                return None if self.running else 1
        proc = Process()
        def stop(*args, **kwargs):
            proc.running = False
        with tempfile.TemporaryDirectory() as folder, patch(__name__+'.popen_group', return_value=proc), \
                patch(__name__+'.terminate_group') as outer_stop, patch(__name__+'.release_group') as released, \
                patch('tests.test_coax_resonator.terminate_group', side_effect=stop) as owned_stop, \
                patch('time.monotonic', return_value=0.), patch('time.time', side_effect=lambda: clock['wall']):
            out = Path(folder)/'new'
            with self.assertRaises(TimeoutError):
                serial(out, 40, 1, termination='MUR')
            owned_stop.assert_called_once_with(proc.pid, grace=0, job=proc.win_job)
            outer_stop.assert_not_called()
            released.assert_called_once_with(proc)
            receipt = json.loads(out.with_name('new.worker.json').read_text(encoding='utf-8'))
            self.assertIsNotNone(receipt['failure'])
            self.assertEqual(receipt['deadline_seconds'], f.CASE_SECONDS)

    def test_mur_parent_finalizes_after_exit_stream_close_and_final_json(self):
        state = dict(released=False)
        class Process:
            pid, win_job, running = 123, object(), True
            def poll(self): return None if self.running else 0
        proc = Process()
        original_finalizer = f.finalized_mur_log
        def spawn(command, **kwargs):
            state['stream'] = kwargs['stdout']
            state['stream'].write('synthetic native output\n')
            out = Path(command[command.index('--out')+1])
            out.mkdir()
            f._save(out/'report.json', dict(protocol=f.MUR_PROTOCOL))
            return proc
        def finish(worker, seconds):
            self.assertEqual(seconds, 1800.)
            state['stream'].write('{"final_worker_json": true}\n')
            proc.running = False
            return 0
        def finalize(path):
            self.assertFalse(proc.running)
            self.assertTrue(state['stream'].closed)
            self.assertTrue(state['released'])
            self.assertTrue(Path(path).read_bytes().endswith(b'{"final_worker_json": true}\r\n')
                            or Path(path).read_bytes().endswith(b'{"final_worker_json": true}\n'))
            return original_finalizer(path)
        with tempfile.TemporaryDirectory() as folder, patch(__name__+'.popen_group', side_effect=spawn), \
                patch(__name__+'.wait_owned', side_effect=finish), \
                patch(__name__+'.release_group', side_effect=lambda p: state.update(released=True)), \
                patch.object(f, 'finalized_mur_log', side_effect=finalize) as finalized:
            out = Path(folder)/'new'
            result = serial(out, 40, 1, termination='MUR')
            finalized.assert_called_once()
            receipt_path = out.with_name('new.worker.json')
            receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
            self.assertEqual(result['worker_receipt_sha256'], f._sha(receipt_path))
            self.assertEqual(receipt['log'], original_finalizer(out.with_name('new.log')))
            self.assertTrue(receipt['log_finalized'])
            self.assertIsNone(receipt['failure'])

    def test_mur_finalization_failure_preserves_original_worker_exception(self):
        class Process:
            pid, win_job = 123, object()
            def poll(self): return 1
        original = TimeoutError('original owned-worker deadline')
        with tempfile.TemporaryDirectory() as folder, patch(__name__+'.popen_group', return_value=Process()), \
                patch(__name__+'.wait_owned', side_effect=original), patch(__name__+'.release_group'), \
                patch.object(f, 'finalized_mur_log', side_effect=OSError('synthetic log read failure')):
            out = Path(folder)/'new'
            with self.assertRaises(TimeoutError) as raised:
                serial(out, 40, 1, termination='MUR')
            self.assertIs(raised.exception, original)
            receipt = json.loads(out.with_name('new.worker.json').read_text(encoding='utf-8'))
            self.assertFalse(receipt['log_finalized'])
            self.assertIn('original owned-worker deadline', receipt['failure'])
            self.assertIn('synthetic log read failure', receipt['log_finalization_error'])

    def test_mur_successful_exit_with_unreadable_log_is_not_finalized(self):
        class Process:
            pid, win_job = 123, object()
            def poll(self): return 0
        with tempfile.TemporaryDirectory() as folder, patch(__name__+'.popen_group', return_value=Process()), \
                patch(__name__+'.wait_owned', return_value=0), patch(__name__+'.release_group'), \
                patch.object(f, 'finalized_mur_log', side_effect=OSError('synthetic missing log')):
            out = Path(folder)/'new'
            with self.assertRaisesRegex(RuntimeError, 'finalization failed'):
                serial(out, 40, 1, termination='MUR')
            receipt = json.loads(out.with_name('new.worker.json').read_text(encoding='utf-8'))
            self.assertEqual(receipt['exit_code'], 0)
            self.assertFalse(receipt['log_finalized'])
            self.assertIsNotNone(receipt['failure'])

    def test_mur_unwritable_failure_receipt_keeps_the_original_error(self):
        class Process:
            pid, win_job = 123, object()
            def poll(self): return 1
        original = TimeoutError('original owned-worker deadline')
        with tempfile.TemporaryDirectory() as folder, patch(__name__+'.popen_group', return_value=Process()), \
                patch(__name__+'.wait_owned', side_effect=original), patch(__name__+'.release_group'), \
                patch.object(f, '_save', side_effect=OSError('synthetic unwritable receipt')):
            with self.assertRaises(TimeoutError) as raised:
                serial(Path(folder)/'new', 40, 1, termination='MUR')
            self.assertIs(raised.exception, original)
            self.assertIn('synthetic unwritable receipt', original.__notes__[0])

    def test_finite_rf_pulse_has_zero_continuous_area_and_keeps_the_rf_band(self):
        t = np.linspace(0, f.PULSE_END_S, 40001)
        values = f.rf_values(t)
        self.assertTrue(np.isfinite(values).all())
        np.testing.assert_array_equal(f.rf_values([-1., 0., f.PULSE_END_S, 1.]), 0)
        self.assertLess(abs(np.trapezoid(values, x=t))/np.trapezoid(abs(values), x=t), 1e-7)
        frequencies = np.array([0., 3.7e9, 6.56e9, 9.8e9, 1e10, 10.2e9])
        spectrum = np.array([abs(np.sum(values*np.exp(-2j*np.pi*freq*t))) for freq in frequencies])
        spectrum /= spectrum[4]
        self.assertLess(spectrum[:3].max(), 1e-4)
        self.assertGreater(spectrum[[3, 5]].min(), .05)
        self.assertLess(spectrum[[3, 5]].max(), .2)

    def test_rf_control_preserves_native_geometry_clock_and_default_source(self):
        with tempfile.TemporaryDirectory() as folder:
            paths = [Path(folder)/f'{k}.xml' for k in range(3)]
            for n in f.MESHES:
                for pn in (1, 2):
                    sims = (f.build(n, pn), f.build(n, pn, pulse='gaussian'),
                            f.build(n, pn, pulse='zero-integral-rf'))
                    for sim, path in zip(sims, paths):
                        sim.fdtd.Write2XML(str(path))
                    self.assertEqual(f.physical_input_sha(paths[0]), f.physical_input_sha(paths[1]))
                    ordinary, control = [ET.parse(p).getroot() for p in (paths[0], paths[2])]
                    # SetCustomExcite requires an explicit spectral upper bound;
                    # the Gaussian infers its native bound from its own pulse.
                    self.assertEqual(float(control.find('FDTD').attrib.pop('f_max')), f.FREQUENCIES[-1])
                    for root in (ordinary, control):
                        root.find('FDTD').remove(root.find('FDTD/Excitation'))
                        for parent in root.iter():
                            for child in list(parent):
                                if child.tag in ('FillColor', 'EdgeColor'):
                                    parent.remove(child)
                    self.assertEqual(ET.tostring(ordinary), ET.tostring(control))
                    self.assertEqual(sims[2].excitation['type'], 'zero-integral-rf')
            with self.assertRaises(ValueError):
                f.build(40, 1, pulse='wrong')

    def test_rf_cache_checks_both_clocks_complete_support_waveform_and_zero_tail(self):
        dt, steps = 1e-12, 16000
        with tempfile.TemporaryDirectory() as folder:
            raw = Path(folder)
            original = {}
            for name, offset in (('et', 0.), ('ht', .5)):
                t = (np.arange(steps)+offset)*dt
                values = f.rf_values(t)
                values[0] = 0
                a = np.column_stack((t, values))
                np.savetxt(raw/name, a, fmt='%.6g')
                original[name] = a
            audit = f.rf_source_audit(raw, dt, steps)
            self.assertEqual(audit['allocated_cache_steps'], steps)
            self.assertLess(audit['complete_after_steps'], steps)
            for name, corruption in (('et', 'tail'), ('ht', 'clock'), ('ht', 'missing'), ('et', 'pulse')):
                with self.subTest(name=name, corruption=corruption):
                    a = original[name].copy()
                    if corruption == 'tail':
                        a[-1, 1] = 1e-3
                    elif corruption == 'clock':
                        a[:, 0] += dt
                    elif corruption == 'missing':
                        a = a[:-1]
                    else:
                        a[:, 1] = np.sin(2*np.pi*3.7e9*a[:, 0])
                    np.savetxt(raw/name, a, fmt='%.6g')
                    with self.assertRaises(ValueError):
                        f.rf_source_audit(raw, dt, steps)
                    np.savetxt(raw/name, original[name], fmt='%.6g')
            for clock, cap in ((0., steps), (float('nan'), steps), (dt, 1000)):
                with self.assertRaises(ValueError):
                    f.rf_source_audit(raw, clock, cap)

    def test_gaussian_and_rf_cohorts_cannot_be_interchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.synthetic(folder)/'report.json'
            with self.assertRaisesRegex(ValueError, 'RF source identity'):
                read_pair(folder, 40, f.PADDING, pulse='zero-integral-rf')
            meta = json.loads(path.read_text(encoding='utf-8'))
            meta['pulse'] = 'zero-integral-rf'
            path.write_text(json.dumps(meta), encoding='utf-8')
            with self.assertRaises(ValueError):
                read_pair(folder, 40, f.PADDING)

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
                    dt_s=1e-12, case_elapsed_s=2., excitation_timesteps=int(np.ceil(f.PULSE_END_S/1e-12)),
                    run=dict(converged=True, threads=4, exact_endcriteria=True, engine='cpu',
                             hit_timestep_limit=False, timesteps=30000,
                             final_energy_bound_db=f.END_DB, wall_time_s=1.))
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
                               ('case_elapsed_s', f.CASE_SECONDS+1), ('case_elapsed_s', True),
                               ('excitation_timesteps', 1)):
                path.write_text(json.dumps({**original, key:value}), encoding='utf-8')
                with self.assertRaises(ValueError):
                    read_pair(folder, 40, f.PADDING)
            for key, value in (('converged', False), ('final_energy_bound_db', -60),
                               ('wall_time_s', None), ('wall_time_s', float('nan')), ('threads', 8),
                               ('timesteps', 1000)):
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
    parser.add_argument('--pulse', choices=f.PULSES, default='gaussian', help='opt-in same-band research source control')
    parser.add_argument('--termination', choices=f.TERMINATIONS, default='PML_8', help='opt-in research end termination')
    parser.add_argument('--hold-seed', type=Path, help='MUR primary source to reconstruct for the fixed 60 ns diagnostic')
    args = parser.parse_args()
    try:
        f.controls(args.pulse, args.termination)
    except ValueError as error:
        parser.error(str(error))
    if args.worker and not args.fdtd:
        parser.error('internal worker requires --fdtd')
    if args.hold_seed is not None and (not args.fdtd or args.termination != 'MUR'):
        parser.error('--hold-seed requires --fdtd --termination MUR')
    if args.preflight:
        for n in f.MESHES:
            sim = f.build(n, 1, pulse=args.pulse, termination=args.termination)
            print(json.dumps(dict(cpw=n, geometry=f.geometry(),
                cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])), limits=f.LIMITS)))
    elif args.study or args.fdtd or args.compare:
        if args.out is None:
            parser.error('--out is required')
        if args.compare:
            result = compare(args.out, pulse=args.pulse, termination=args.termination)
            (args.out/'comparison.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
            print(json.dumps(result, indent=2))
        elif args.fdtd:
            print(json.dumps((f.acquire if args.worker else serial)(args.out, args.mesh, args.excite, args.padding,
                pulse=args.pulse, termination=args.termination, hold_seed=args.hold_seed)))
        else:
            frozen = f.source_ids()
            for n, padding in [(n, f.PADDING) for n in f.MESHES]+[(f.CONTROL_MESH, f.CONTROL_PADDING)]:
                for pn in (1, 2):
                    if f.source_ids() != frozen:
                        raise RuntimeError('acquisition sources changed during cohort')
                    target = args.out/f'cpw{n}'/f'pad{padding}'/f'e{pn}'
                    meta = serial(target, n, pn, padding, pulse=args.pulse, termination=args.termination)
                    if args.termination == 'MUR':
                        serial(target/'hold60ns', n, pn, padding, termination='MUR', hold_seed=target)
                        f.read_mur_source(target, n, pn, padding)
                    dimensions = meta['native'] if args.termination == 'MUR' else meta
                    print(json.dumps(dict(cpw=n, padding=padding, port=pn, cells=dimensions['cells'],
                        dt_s=dimensions['dt_s'], seconds=meta['run']['wall_time_s'], energy_stopped=meta['run'].get('converged'))), flush=True)
    else:
        unittest.main(argv=[sys.argv[0]])


if __name__ == '__main__':
    main()
