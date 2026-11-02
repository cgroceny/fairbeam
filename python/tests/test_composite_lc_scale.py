"""Opt-in fixed-clock physical-size diagnostic; never mesh qualification.

python -m unittest tests.test_composite_lc_scale -q
python -m tests.test_composite_lc_scale --fdtd --allow-cap-diagnostic --baseline D:/study/baseline --out D:/study/size-fresh
python -m tests.test_composite_lc_scale --compare --allow-cap-diagnostic --baseline D:/study/baseline --out D:/study/size-fresh

Double all lengths, keep L/C, clock, window and source field amplitude fixed.
The integrated source voltage doubles; the measured full incident matrix
normalizes the linear S response. This changes a physical model assumption.
The existing serial worker owns each process tree and enforces 30 minutes.
No native fields run during unittest discovery; raw runs stay outside Git.
"""
import argparse
from contextlib import contextmanager
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET

import numpy as np
from tests import composite_lc_filter_fixture as f
from tests import test_composite_lc_filter_fixture as t


LENGTH_SCALE = 2.
SCOPE = ('Fixed-clock, doubled-length finite LC model; prescribed source field '
    'amplitude is unchanged, so its integrated drive voltage doubles. Full '
    'incident-wave normalization; no mesh convergence or application qualification.')


def normalized_input(path, length_scale):
    """Remove only uniform Box/grid coordinate scaling, retaining all physics."""
    root = ET.parse(path).getroot()
    for node in root.iter():
        if node.tag in ('XLines', 'YLines', 'ZLines'):
            values = np.fromstring(node.text, sep=',')/length_scale
            node.text = ','.join(f'{v:.12g}' for v in values)
        elif node.tag in ('P1', 'P2'):
            for axis in ('X', 'Y', 'Z'):
                node.set(axis, f'{float(node.get(axis))/length_scale:.12g}')
    return ET.tostring(root)


@contextmanager
def geometry_context():
    build, identity, launch = f.build, f.identity, t.popen_group
    cell = f.CELL
    def model(n, port, kind='filter', control='ordinary', threads=1):
        if n != 1 or kind != 'filter' or control != 'ordinary' or threads != 1:
            raise ValueError('one-thread coarse ordinary filter size control required')
        _, base = build(n, port, kind, control, threads)
        with patch.object(f, 'CELL', LENGTH_SCALE*cell):
            sim, meta = build(n, port, kind, control, threads)
        dt = base['declared_dt_s']; steps = math.ceil(base['cap_s']/dt)
        sim.fdtd.SetTimeStep(dt); sim.fdtd.SetNumberOfTimeSteps(steps)
        sim.max_timesteps = steps
        meta.update(declared_dt_s=dt, max_timesteps=steps, physical_length_scale=LENGTH_SCALE,
            source_amplitude_convention='Fixed prescribed field; integrated drive voltage scales with length', scope=SCOPE)
        return sim, meta
    def source():
        return {**identity(), 'tests/test_composite_lc_scale.py': f.sha(__file__)}
    def route(command, **kwargs):
        command = list(command)
        command[command.index('tests.test_composite_lc_filter_fixture')] = 'tests.test_composite_lc_scale'
        return launch(command, **kwargs)
    try:
        f.build = model; f.identity = source; t.popen_group = route
        yield
    finally:
        f.build = build; f.identity = identity; t.popen_group = launch


def prepare(out, baseline, rate=85., io=40., allow_cap_diagnostic=False):
    out, baseline = Path(out).resolve(), Path(baseline).resolve()
    side = out.with_name(out.name+'-protocol')
    if out.exists() or side.exists():
        raise ValueError('fresh size cohort and protocol required')
    with geometry_context():
        _, meta = f.build(1, 1)
    estimate = t.forecast(meta, rate, io)
    if estimate > 1800:
        raise ValueError('size-control forecast exceeds 30 minutes; defer before launch')
    _, nominal = f.matrix(baseline, allow_cap_diagnostic)
    if any(nominal[k] != v for k, v in dict(n=1, kind='filter', control='ordinary').items()):
        raise ValueError('coarse ordinary filter baseline required')
    base_meta = json.loads((baseline/'port1/report.json').read_text())
    if base_meta['threads'] != 1:
        raise ValueError('one-thread baseline required')
    side.mkdir(parents=True); rows = []
    for port in (1, 2):
        sim, base = f.build(1, port); old = side/f'baseline-p{port}.xml'
        sim.fdtd.Write2XML(str(old))
        if old.read_bytes() != (baseline/f'port{port}/input.xml').read_bytes():
            raise ValueError('baseline native input differs from the unchanged builder')
        with geometry_context():
            sim, meta = f.build(1, port); path = side/f'size-p{port}.xml'
            sim.fdtd.Write2XML(str(path))
            if normalized_input(old, 1.) != normalized_input(path, LENGTH_SCALE):
                raise ValueError('size control changed noncoordinate native input')
            sim.fdtd.SetTimeStep(0.); sim.fdtd.SetNumberOfTimeSteps(f.OPERATOR_STEPS)
            operator = side/f'operator-p{port}.xml'; sim.fdtd.Write2XML(str(operator))
            rows.append(dict(port=port, input_sha256=f.sha(path),
                operator_input_sha256=f.sha(operator), baseline_input_sha256=f.sha(old),
                native_cells=meta['native_cells'], dt_s=meta['declared_dt_s'],
                estimated_seconds=estimate, deadline_seconds=1800.))
    with geometry_context():
        source = f.identity()
    f.save(side/'protocol.json', dict(source=source, runtime=f.runtime_identity(), rows=rows,
        baseline=str(baseline), baseline_comparison=nominal,
        baseline_comparison_sha256=f.sha(baseline/('cap-diagnostic-comparison.json' if allow_cap_diagnostic else 'comparison.json')),
        allow_cap_diagnostic=allow_cap_diagnostic, physical_length_scale=LENGTH_SCALE,
        scope=SCOPE, native_propagations=0, qualified=False))
    return side


def worker(out, port):
    out = Path(out).resolve(); side = out.parent.with_name(out.parent.name+'-protocol')
    protocol = json.loads((side/'protocol.json').read_text())
    row = next(x for x in protocol['rows'] if x['port'] == port)
    original = f.CircuitSimulation.run
    def guarded(self, sim_path, *args, **kwargs):
        operator = bool(kwargs.get('setup_only')); folder = Path(sim_path).parent
        path = folder/('operator-before-native.xml' if operator else 'scientific-before-native.xml')
        if f.identity() != protocol['source'] or f.runtime_identity() != protocol['runtime']:
            raise ValueError('size-control source/runtime changed')
        self.fdtd.Write2XML(str(path))
        if f.sha(path) != row['operator_input_sha256' if operator else 'input_sha256']:
            raise ValueError('size-control native input changed before execution')
        return original(self, sim_path, *args, **kwargs)
    with geometry_context():
        try:
            f.CircuitSimulation.run = guarded
            f.acquire(out, 1, port)
        finally:
            f.CircuitSimulation.run = original


def compare(out, baseline, allow_cap_diagnostic=False):
    out, baseline = Path(out).resolve(), Path(baseline).resolve()
    side = out.with_name(out.name+'-protocol')
    protocol = json.loads((side/'protocol.json').read_text())
    name = 'cap-diagnostic-comparison.json' if allow_cap_diagnostic else 'comparison.json'
    if (str(baseline) != protocol['baseline'] or allow_cap_diagnostic != protocol['allow_cap_diagnostic']
            or f.sha(baseline/name) != protocol['baseline_comparison_sha256']):
        raise ValueError('baseline or cap-diagnostic admission changed')
    nominal, old = f.matrix(baseline, allow_cap_diagnostic)
    with geometry_context():
        if f.identity() != protocol['source'] or f.runtime_identity() != protocol['runtime']:
            raise ValueError('size-control source/runtime changed')
        actual, new = f.matrix(out, allow_cap_diagnostic)
    difference = f.response_difference(actual, nominal, abs(f.reference()[:,1,0]) >= .01)
    result = dict(scope=SCOPE, physical_length_scale=LENGTH_SCALE, baseline=old, scaled=new,
        **difference, qualified=False, original_example_reclassified=False)
    path = out/'size-comparison.json'
    if path.exists() and json.loads(path.read_text()) != result:
        raise ValueError('changed stored size comparison')
    if not path.exists():
        f.save(path, result)
    return result


class CompositeSizeTests(unittest.TestCase):
    def test_only_coordinates_change_and_clock_circuit_source_are_fixed(self):
        with tempfile.TemporaryDirectory() as tmp:
            for port in (1, 2):
                a, b = Path(tmp)/'base', Path(tmp)/'size'
                sim, base = f.build(1, port); sim.fdtd.Write2XML(str(a))
                with geometry_context():
                    sim, size = f.build(1, port); sim.fdtd.Write2XML(str(b))
                self.assertEqual(normalized_input(a, 1.), normalized_input(b, LENGTH_SCALE))
                for key in ('elements','grid','native_cells','declared_dt_s','max_timesteps','cap_s','reference_ohm'):
                    self.assertEqual(base[key], size[key])
                for axis in 'xyz':
                    np.testing.assert_allclose(size['mesh_mm'][axis], LENGTH_SCALE*np.array(base['mesh_mm'][axis]))
                for key in base['element_boxes']:
                    for end in ('start_m','stop_m'):
                        np.testing.assert_allclose(size['element_boxes'][key][end], LENGTH_SCALE*np.array(base['element_boxes'][key][end]))
                for key, box in f.probe_layout(base).items():
                    self.assertEqual(f.expected_indices(base, box), f.expected_indices(size, f.probe_layout(size)[key]))
                self.assertEqual(size['physical_length_scale'], LENGTH_SCALE)

    def test_normalization_retains_component_and_time_step_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp)/'base', Path(tmp)/'mutant'
            sim, _ = f.build(1, 1); sim.fdtd.Write2XML(str(a))
            expected = normalized_input(a, 1.)
            for tag, key, value in (('LumpedElement','L','1e-6'), ('FDTD','TimeStep','1e-12')):
                root = ET.parse(a); node = next(x for x in root.iter(tag) if key in x.attrib)
                node.set(key, value); root.write(b)
                self.assertNotEqual(expected, normalized_input(b, 1.))

    def test_context_restores_defaults_even_on_failure(self):
        build, identity, launch, cell = f.build, f.identity, t.popen_group, f.CELL
        with self.assertRaises(ValueError):
            with geometry_context():
                self.assertIn('tests/test_composite_lc_scale.py', f.identity())
                f.build(2, 1)
        self.assertIs(f.build, build); self.assertIs(f.identity, identity)
        self.assertIs(t.popen_group, launch); self.assertEqual(f.CELL, cell)

    def test_default_xml_is_unchanged_after_control(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp)/'before', Path(tmp)/'after'
            sim, _ = f.build(1, 2); sim.fdtd.Write2XML(str(a))
            with geometry_context():
                f.build(1, 2)
            sim, _ = f.build(1, 2); sim.fdtd.Write2XML(str(b))
            self.assertEqual(a.read_bytes(), b.read_bytes())

    def test_worker_route_preserves_existing_source_and_budget_arguments(self):
        command = ['python','-m','tests.test_composite_lc_filter_fixture','--worker',
            '--mesh','1','--kind','filter','--control','ordinary','--threads','1','--port','2','--out','fresh/port2']
        with patch.object(t, 'popen_group', return_value=Mock(pid=123)) as launch:
            with geometry_context():
                t.popen_group(command, cwd=f.ROOT/'python')
            actual = launch.call_args.args[0]
            self.assertEqual(actual[2], 'tests.test_composite_lc_scale')
            self.assertEqual(actual[3:], command[3:])

    def test_long_forecast_refuses_before_output_or_baseline_read(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(f, 'matrix') as matrix:
            folder = Path(tmp)/'fresh'
            with self.assertRaisesRegex(ValueError, 'exceeds 30'):
                prepare(folder, Path(tmp)/'missing-baseline', rate=.01)
            matrix.assert_not_called()
            self.assertFalse(folder.exists()); self.assertFalse(folder.with_name('fresh-protocol').exists())

    def test_changed_worker_input_or_runtime_refuses_before_native_run(self):
        for changed in ('input', 'runtime'):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp)/'size/port1'; side = Path(tmp)/'size-protocol'; side.mkdir()
                with geometry_context():
                    sim, _ = f.build(1, 1); source = f.identity()
                xml = side/'expected.xml'; sim.fdtd.Write2XML(str(xml))
                runtime = f.runtime_identity()
                protocol = dict(source=source, runtime=runtime, rows=[dict(port=1,
                    input_sha256=f.sha(xml), operator_input_sha256='unused')])
                if changed == 'runtime':
                    protocol['runtime'] = {}
                else:
                    protocol['rows'][0]['input_sha256'] = '0'*64
                f.save(side/'protocol.json', protocol)
                def acquisition(folder, n, port):
                    folder.mkdir(parents=True)
                    sim, _ = f.build(n, port)
                    sim.run(str(folder/'raw'))
                with patch.object(f.CircuitSimulation, 'run') as native, patch.object(f, 'acquire', side_effect=acquisition):
                    with self.assertRaisesRegex(ValueError, 'native input changed|source/runtime changed'):
                        worker(out, 1)
                    native.assert_not_called()
                    self.assertIs(f.CircuitSimulation.run, native)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group(required=True)
    for name in ('fdtd','compare','worker'):
        mode.add_argument('--'+name, action='store_true')
    p.add_argument('--out', type=Path, required=True); p.add_argument('--baseline', type=Path)
    p.add_argument('--mesh', type=int, choices=(1,), default=1)
    p.add_argument('--kind', choices=('filter',), default='filter')
    p.add_argument('--control', choices=('ordinary',), default='ordinary')
    p.add_argument('--threads', type=int, choices=(1,), default=1)
    p.add_argument('--port', type=int, choices=(1,2), default=1)
    p.add_argument('--rate-mcps', type=float, default=85.)
    p.add_argument('--io-s-per-mstep', type=float, default=40.)
    p.add_argument('--allow-cap-diagnostic', action='store_true', help='Keep only cap-stopping deviations; never qualifies them')
    a = p.parse_args()
    if a.worker:
        worker(a.out, a.port); return
    if a.baseline is None:
        p.error('--baseline required')
    if a.fdtd:
        prepare(a.out, a.baseline, a.rate_mcps, a.io_s_per_mstep, a.allow_cap_diagnostic)
        with geometry_context():
            t.acquire_serial(a.out, rate=a.rate_mcps, io=a.io_s_per_mstep, allow_cap_diagnostic=a.allow_cap_diagnostic)
    print(json.dumps(compare(a.out, a.baseline, a.allow_cap_diagnostic), indent=2, allow_nan=False))


if __name__ == '__main__':
    if any('--'+name in sys.argv for name in ('fdtd','compare','worker')):
        main()
    else:
        unittest.main()
