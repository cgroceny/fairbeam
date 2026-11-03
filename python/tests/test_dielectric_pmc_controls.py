"""Opt-in, separate PMC time/angle/axial-tail controls; never open-model qualification.

python -m unittest tests.test_dielectric_pmc_controls -q
python -m tests.test_dielectric_pmc_controls --plan --control time --baseline D:/study/pmc/n12 --out D:/study/pmc-controls/time
python -m tests.test_dielectric_pmc_controls --fdtd --pilot --control time --baseline D:/study/pmc/n12 --out D:/study/pmc-pilots/time
python -m tests.test_dielectric_pmc_controls --fdtd --control time --rate-mcps 35 --baseline D:/study/pmc/n12 --out D:/study/pmc-controls/time
python -m tests.test_dielectric_pmc_controls --compare --baseline D:/study/pmc/n12 --out D:/study/pmc-controls

Use fresh external paths and measured per-control pilot rates. Compare angle
against time at their common smaller step, not against the original clock.
Each full worker keeps the existing 45-minute owned wall deadline. Pilots and
all qualification flags remain false; no unittest starts native propagation.
"""
import argparse
from contextlib import contextmanager
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET

import numpy as np
from tests import dielectric_pmc_fixture as f

CONTROLS = ('time', 'angle', 'tail')
MESH = 12
TIME_FACTOR = .8


@contextmanager
def control_context(control):
    if control not in CONTROLS:
        raise ValueError('declared PMC independence control required')
    build, opened_build, identity, launch, dt = f.build, f.opened.build, f.identity, f.popen_group, f.DT_S
    def opened_model(n, kind, **kwargs):
        return opened_build(n, kind, **{**kwargs, 'angular': 8 if control == 'angle' else 4,
            'clearance': 40. if control == 'tail' else 30.})
    def model(n, cap_s=f.CAP_S):
        if isinstance(n, bool) or n != MESH:
            raise ValueError('middle-mesh PMC control required')
        sim, meta = build(n, cap_s)
        meta.update(angular=8 if control == 'angle' else 4,
            clearance_mm=40. if control == 'tail' else 30., independence_control=control)
        return sim, meta
    def source():
        return {**identity(), 'tests/test_dielectric_pmc_controls.py': f.opened.sha(__file__)}
    def route(command, **kwargs):
        command = list(command)
        command[command.index('tests.dielectric_pmc_fixture')] = 'tests.test_dielectric_pmc_controls'
        return launch([*command, '--control', control], **kwargs)
    try:
        f.opened.build = opened_model; f.build = model; f.identity = source; f.popen_group = route
        f.DT_S = dt*(TIME_FACTOR if control in ('time', 'angle') else 1.)
        yield
    finally:
        f.build, f.opened.build, f.identity, f.popen_group, f.DT_S = build, opened_build, identity, launch, dt


def comparable_input(path, change):
    root = ET.parse(path).getroot()
    for parent in root.iter():
        for child in list(parent):
            if child.tag in ('FillColor', 'EdgeColor'):
                parent.remove(child)
    if change == 'time':
        node = root.find('FDTD')
        for key in ('TimeStep', 'NumberOfTimesteps'):
            node.attrib.pop(key)
    else:
        tag = 'YLines' if change == 'angle' else 'ZLines'
        node = next(root.iter(tag)); node.text = ''; node.set('Qty', '0')
    return ET.tostring(root)


def paired_models(control, cap_s):
    if control == 'angle':
        with control_context('time'):
            reference = f.build(MESH, cap_s)
    else:
        reference = f.build(MESH, cap_s)
    with control_context(control):
        changed = f.build(MESH, cap_s)
    return reference, changed


def reference_passes(row):
    return bool(row.get('f_reference_rel', float('inf')) <= f.GATES['f_reference']
        and row.get('q_reference_rel', float('inf')) <= f.GATES['q_reference'])


def prepare(out, baseline, control, rate, pilot=False):
    out, baseline = Path(out).resolve(), Path(baseline).resolve()
    side = out.with_name(out.name+'-protocol')
    if out.exists() or side.exists() or out.is_relative_to(Path(__file__).resolve().parents[2]):
        raise ValueError('fresh external capture and protocol required')
    cap = 90e-9 if pilot else f.CAP_S
    (ref_sim, ref), (sim, meta) = paired_models(control, cap)
    estimate = f.forecast(meta, rate); limit = 600 if pilot else 2700
    if estimate > limit:
        raise ValueError('PMC control exceeds the owned budget; defer before launch')
    old = f.analyse(baseline)
    if old['n'] != MESH or not old['completed_pole_control'] or not reference_passes(old):
        raise ValueError('completed middle-mesh baseline required')
    side.mkdir(parents=True)
    default, _ = f.build(MESH); default.fdtd.Write2XML(str(side/'default-full.xml'))
    old_meta = json.loads((baseline/'field/report.json').read_text())
    if f.physics_sha(side/'default-full.xml') != old_meta['physics_sha256']:
        raise ValueError('unchanged baseline native input not reproduced')
    ref_sim.fdtd.Write2XML(str(side/'reference.xml')); sim.fdtd.Write2XML(str(side/'control.xml'))
    if comparable_input(side/'reference.xml', control) != comparable_input(side/'control.xml', control):
        raise ValueError('control changed more than its declared native input')
    if control == 'tail':
        core = lambda model: np.array(model.mesh.GetLines('z'))[abs(model.mesh.GetLines('z')) <= f.opened.LENGTH_MM/2+1e-12]
        np.testing.assert_array_equal(core(ref_sim), core(sim))
        for model in (ref_sim, sim):
            z = np.array(model.mesh.GetLines('z'))
            np.testing.assert_allclose(z[-1]-z[-17], 24., rtol=0, atol=1e-12)
    with control_context(control):
        source = f.identity()
    protocol = dict(control=control, source=source, runtime=f.runtime_identity(),
        baseline=str(baseline), baseline_admission_sha256=f.opened.sha(baseline/'admission.json'),
        input_physics_sha256=f.physics_sha(side/'control.xml'), cap_s=cap, pilot_only=pilot,
        native_cells=meta['native_cells'], declared_dt_s=meta['declared_dt_s'],
        estimated_seconds=estimate, deadline_seconds=limit, reference=meta['reference'], qualified=False)
    f.save(side/'protocol.json', protocol)
    return protocol


def worker(out, control, cap_s, setup):
    out = Path(out).resolve(); side = out.parent.with_name(out.parent.name+'-protocol')
    protocol = json.loads((side/'protocol.json').read_text())
    if protocol['control'] != control or protocol['cap_s'] != cap_s:
        raise ValueError('wrong control or acquisition window')
    with control_context(control):
        build = f.build
        def guarded_model(n, cap):
            sim, meta = build(n, cap); original = sim.run
            meta['control_protocol_sha256'] = f.opened.sha(side/'protocol.json')
            def guarded_run(sim_path, *args, **kwargs):
                if f.identity() != protocol['source'] or f.runtime_identity() != protocol['runtime']:
                    raise ValueError('control source/runtime changed before native execution')
                path = out/'before-native.xml'; sim.fdtd.Write2XML(str(path))
                if f.physics_sha(path) != protocol['input_physics_sha256']:
                    raise ValueError('control native input changed before execution')
                return original(sim_path, *args, **kwargs)
            sim.run = guarded_run
            return sim, meta
        try:
            f.build = guarded_model
            return f.worker(out, MESH, cap_s, setup=setup)
        finally:
            f.build = build


def compare(out, baseline):
    out, baseline = Path(out).resolve(), Path(baseline).resolve()
    old = f.analyse(baseline); rows = {}; missing = []; rejected = []
    if old['n'] != MESH or not old['completed_pole_control'] or not reference_passes(old):
        raise ValueError('completed middle-mesh baseline required')
    for control in CONTROLS:
        folder = out/control
        if not (folder/'admission.json').is_file():
            missing.append(control); continue
        try:
            protocol = json.loads(folder.with_name(folder.name+'-protocol').joinpath('protocol.json').read_text())
            if (protocol['control'] != control or protocol['baseline'] != str(baseline)
                    or protocol['pilot_only'] or protocol['baseline_admission_sha256'] != f.opened.sha(baseline/'admission.json')):
                raise ValueError('mixed baseline/control/pilot evidence')
            with control_context(control):
                if f.identity() != protocol['source'] or f.runtime_identity() != protocol['runtime']:
                    raise ValueError('control protocol source/runtime changed')
                meta = json.loads((folder/'field/report.json').read_text())
                if meta.get('control_protocol_sha256') != f.opened.sha(folder.with_name(folder.name+'-protocol')/'protocol.json'):
                    raise ValueError('control protocol changed after acquisition')
                row = f.analyse(folder)
            if row['n'] != MESH or not row['completed_pole_control']:
                raise ValueError('control pole admission failed')
            row['reference_passes'] = reference_passes(row)
            rows[control] = row
        except (ValueError, OSError) as exc:
            rejected.append(dict(control=control, reason=str(exc)))
    changes = []
    for control, reference_name in (('time', 'baseline'), ('angle', 'time'), ('tail', 'baseline')):
        if control not in rows or (reference_name != 'baseline' and reference_name not in rows):
            continue
        a, b = old if reference_name == 'baseline' else rows[reference_name], rows[control]
        df, dq = abs(b['f_hz']/a['f_hz']-1), abs(b['q']/a['q']-1)
        changes.append(dict(control=control, reference=reference_name, f_rel=df, q_rel=dq,
            passes=df <= f.GATES['f_control'] and dq <= f.GATES['q_control']))
    return dict(baseline=old, controls=rows, changes=changes, missing=missing, rejected=rejected,
        independence_controls_pass=not missing and not rejected and len(changes) == 3
            and all(x['passes'] for x in changes) and all(x['reference_passes'] for x in rows.values()),
        qualified=False, open_example_qualified=False,
        limitation='Middle-mesh independence only; the old coarse reference failure and all qualification flags remain unchanged.')


class Controls(unittest.TestCase):
    def test_declared_changes_are_separate_and_angular_clock_is_matched(self):
        with tempfile.TemporaryDirectory() as temp:
            for control in CONTROLS:
                (a, am), (b, bm) = paired_models(control, f.CAP_S)
                pa, pb = Path(temp)/'a.xml', Path(temp)/'b.xml'
                a.fdtd.Write2XML(str(pa)); b.fdtd.Write2XML(str(pb))
                self.assertEqual(comparable_input(pa, control), comparable_input(pb, control))
                self.assertEqual(am['reference'], bm['reference'])
                self.assertEqual(am['magnetic_wall_radius_mm'], bm['magnetic_wall_radius_mm'])
                if control == 'angle':
                    self.assertEqual(am['declared_dt_s'], bm['declared_dt_s'])
                    self.assertEqual((am['angular'], bm['angular']), (4, 8))
                if control == 'time':
                    self.assertEqual(am['reported_grid_lines'], bm['reported_grid_lines'])
                    self.assertEqual(bm['declared_dt_s'], TIME_FACTOR*am['declared_dt_s'])
                if control == 'tail':
                    self.assertEqual(am['declared_dt_s'], bm['declared_dt_s'])
                    self.assertEqual((am['clearance_mm'], bm['clearance_mm']), (30., 40.))

    def test_context_restores_original_reader_builder_clock_and_worker_route(self):
        original = f.build, f.opened.build, f.identity, f.popen_group, f.DT_S
        with self.assertRaises(ValueError):
            with control_context('angle'):
                self.assertIn('tests/test_dielectric_pmc_controls.py', f.identity())
                f.build(16)
        self.assertEqual((f.build, f.opened.build, f.identity, f.popen_group, f.DT_S), original)
        with self.assertRaises(ValueError):
            with control_context('unknown'): pass

    def test_default_physics_is_unchanged_after_control(self):
        with tempfile.TemporaryDirectory() as temp:
            a, b = Path(temp)/'before.xml', Path(temp)/'after.xml'
            sim, meta = f.build(12); sim.fdtd.Write2XML(str(a)); source = f.identity()
            for control in CONTROLS:
                with control_context(control): f.build(12)
            sim, again = f.build(12); sim.fdtd.Write2XML(str(b))
            self.assertEqual(f.physics_sha(a), f.physics_sha(b))
            self.assertEqual(meta, again); self.assertEqual(source, f.identity())

    def test_worker_routing_preserves_owned_arguments_and_adds_control(self):
        command = ['python','-m','tests.dielectric_pmc_fixture','--worker','field',
            '--mesh','12','--cap-ns','1000','--out','fresh/field']
        with patch.object(f, 'popen_group', return_value=Mock(pid=123)) as launch:
            with control_context('tail'): f.popen_group(command)
            actual = launch.call_args.args[0]
            self.assertEqual(actual[2], 'tests.test_dielectric_pmc_controls')
            self.assertEqual(actual[3:-2], command[3:])
            self.assertEqual(actual[-2:], ['--control','tail'])

    def test_overbudget_refuses_before_baseline_or_files(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(f, 'analyse') as read:
            out = Path(temp)/'fresh'
            with self.assertRaisesRegex(ValueError, 'defer'):
                prepare(out, Path(temp)/'missing', 'angle', .001)
            read.assert_not_called(); self.assertFalse(out.exists())
            self.assertFalse(out.with_name('fresh-protocol').exists())

    def test_missing_controls_cannot_pass_or_qualify(self):
        row = dict(n=12, completed_pole_control=True, f_reference_rel=.0001, q_reference_rel=.0001)
        with tempfile.TemporaryDirectory() as temp, patch.object(f, 'analyse', return_value=row):
            result = compare(temp, Path(temp)/'baseline')
        self.assertEqual(result['missing'], list(CONTROLS))
        self.assertFalse(result['independence_controls_pass'])
        self.assertFalse(result['qualified']); self.assertFalse(result['open_example_qualified'])

    def test_failed_or_missing_absolute_reference_cannot_pass(self):
        self.assertTrue(reference_passes(dict(f_reference_rel=.0001, q_reference_rel=.001)))
        self.assertFalse(reference_passes(dict(f_reference_rel=.003, q_reference_rel=.001)))
        self.assertFalse(reference_passes(dict(f_reference_rel=.0001, q_reference_rel=.03)))
        self.assertFalse(reference_passes({}))

    def test_changed_worker_protocol_refuses_before_propagation(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)/'time/field'; side = Path(temp)/'time-protocol'; side.mkdir()
            with control_context('time'):
                source = f.identity()
            f.save(side/'protocol.json', dict(control='time', cap_s=f.CAP_S,
                source=source, runtime={}, input_physics_sha256='0'*64))
            def acquisition(folder, n, cap, setup):
                folder.mkdir(parents=True)
                sim, _ = f.build(n, cap)
                sim.run(str(folder/'raw'))
            with patch.object(f, 'worker', side_effect=acquisition), patch.object(f.opened.ResonatorSimulation, 'run') as native:
                with self.assertRaisesRegex(ValueError, 'source/runtime changed'):
                    worker(out, 'time', f.CAP_S, False)
                native.assert_not_called()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    action = p.add_mutually_exclusive_group(required=True)
    for flag in ('plan','fdtd','compare'): action.add_argument('--'+flag, action='store_true')
    action.add_argument('--worker', choices=('setup','field'))
    p.add_argument('--control', choices=CONTROLS); p.add_argument('--baseline', type=Path)
    p.add_argument('--out', type=Path, required=True); p.add_argument('--mesh', type=int, choices=(MESH,), default=MESH)
    p.add_argument('--cap-ns', type=float, default=1000., help=argparse.SUPPRESS)
    p.add_argument('--rate-mcps', type=float, default=10.); p.add_argument('--pilot', action='store_true')
    a = p.parse_args()
    if a.worker:
        if a.control is None: p.error('--control required')
        worker(a.out, a.control, a.cap_ns/1e9, a.worker == 'setup'); return
    if a.baseline is None: p.error('--baseline required')
    if a.compare:
        result = compare(a.out, a.baseline)
    else:
        if a.control is None: p.error('--control required')
        result = prepare(a.out, a.baseline, a.control, a.rate_mcps, a.pilot)
        if a.fdtd:
            with control_context(a.control):
                result = f.acquire_serial(a.out, MESH, a.rate_mcps, a.pilot)
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == '__main__':
    if any('--'+flag in sys.argv for flag in ('plan','fdtd','compare','worker')): main()
    else: unittest.main()
