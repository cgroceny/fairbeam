r"""Opt-in current-probe FDTD; unittest discovery runs pure controls only.

python -m tests.test_waveguide_probe --preflight
python -m tests.test_waveguide_probe --study --out C:\Temp\fairbeam-current-probe
python -m tests.test_waveguide_probe --compare --out C:\Temp\fairbeam-current-probe
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
from tests import waveguide_probe_fixture as f


def read_case(path, cpw, padding):
    path = Path(path)
    meta = json.loads((path/'report.json').read_text(encoding='utf-8'))
    identity = dict(protocol=f.PROTOCOL, geometry=f.geometry(), cpw=cpw, padding=padding,
                    frequency_hz=f.FREQUENCIES.tolist(), limits=f.LIMITS, source_ids=f.source_ids())
    if any(meta.get(k) != v for k, v in identity.items()):
        raise ValueError('case protocol, source, geometry or frequency identity differs')
    sim = f.build(cpw, padding)
    expected_area = np.diff(sim.mesh.GetLines('x'))[0]*np.diff(sim.mesh.GetLines('z'))[0]*sim.unit**2
    expected_cells = int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz']))
    run = meta.get('run', {})
    energy = [run.get(k) for k in ('final_energy_db', 'final_energy_bound_db')]
    energy = [x for x in energy if isinstance(x, (int, float)) and not isinstance(x, bool) and np.isfinite(x)]
    positive = [meta.get('dt_s'), meta.get('area_m2'), meta.get('case_elapsed_s'), run.get('wall_time_s')]
    if (run.get('converged') is not True or run.get('exact_endcriteria') is not True
            or run.get('hit_timestep_limit') is not False or run.get('threads') != 4
            or run.get('engine') != 'cpu' or not energy or max(energy) > f.END_DB+1e-9
            or not isinstance(run.get('timesteps'), int) or not 0 < run['timesteps'] < 300000
            or any(isinstance(x, bool) or not isinstance(x, (int, float)) or not np.isfinite(x) or x <= 0 for x in positive)
            or max(positive[2:]) > f.CASE_SECONDS):
        raise ValueError('missing confirmed stop, finite measurements or suspend-inclusive deadline')
    pulse_steps = meta.get('excitation_timesteps')
    if (isinstance(pulse_steps, bool) or not isinstance(pulse_steps, int)
            or abs(pulse_steps-int(np.ceil(f.PULSE_END_S/meta['dt_s']))) > 1
            or run['timesteps'] < pulse_steps):
        raise ValueError('simulation stopped before the native Gaussian excitation completed')
    if meta.get('cells') != expected_cells or not np.isclose(meta['area_m2'], expected_area, rtol=1e-12, atol=0):
        raise ValueError('dual source area or mesh size differs from the declared geometry')
    with np.load(path/'data.npz') as src:
        data = dict(src)
    shapes = dict(v=(2, 4, len(f.FREQUENCIES)), current=(3, len(f.FREQUENCIES)),
                  voltage=f.FREQUENCIES.shape, contour=f.FREQUENCIES.shape)
    if (not np.array_equal(data['f'], f.FREQUENCIES)
            or any(data[k].shape != shape or not np.isfinite(data[k]).all() for k, shape in shapes.items())):
        raise ValueError('finite spectra on the exact frequency grid required')
    ij = f.source_current(data['voltage'], data['contour'], meta['area_m2'], meta['dt_s'])
    if (not np.isfinite(ij).all() or np.max(abs(ij)) == 0
            or np.any(abs(ij) < 1e-3*np.max(abs(ij))) or np.any(abs(data['contour']) == 0)):
        raise ValueError('source current too small for stable normalization')
    gamma, out, incoming = f.waves(data['v'])
    transfer = out/ij
    beta, zte, target = f.reference()
    resistance = (data['voltage']/ij).real
    raw_resistance = (data['voltage']/data['contour']).real
    radiated = f.A/(2*f.B*zte)*np.sum(abs(out)**2-abs(incoming)**2, axis=1)/abs(ij)**2
    metrics = dict(amplitude_rel=float(np.max(abs(transfer-target)/target)),
        resistance_rel=float(np.max(abs(resistance-target)/target)),
        beta_rel=float(np.max(abs(gamma.imag-beta)/beta)),
        plane_rel=float(np.max(abs(transfer[0]-transfer[1])/target)),
        symmetry_rel=float(np.max(abs(transfer[:, 0]-transfer[:, 1])/target)),
        current_uniform_rel=float(np.max(abs(data['current']-data['contour'])/abs(ij))),
        power_rel=float(np.max(abs(radiated-resistance)/target)))
    samples = [dict(f_ghz=float(f.FREQUENCIES[k]/1e9), target_ohm=float(target[k]),
        resistance_ohm=float(resistance[k]), raw_contour_resistance_ohm=float(raw_resistance[k]),
        transfer_ohm=[[float(z.real), float(z.imag)] for z in transfer[0, :, k]],
        reactance_ohm=float((data['voltage']/ij).imag[k])) for k in (0, 10, 20, 30, 40)]
    passes = (max(metrics['amplitude_rel'], metrics['resistance_rel']) <= f.LIMITS['target_rel']
              and all(metrics[k] <= f.LIMITS[k] for k in metrics if k not in ('amplitude_rel', 'resistance_rel')))
    return dict(cpw=cpw, cells=meta['cells'], dt_ps=meta['dt_s']*1e12,
                metrics=metrics, matches_and_qa=bool(passes), samples=samples), transfer, resistance


def compare(root):
    root, cases, missing = Path(root), {}, []
    for n, padding in [(n, f.PADDING) for n in f.MESHES]+[(f.MESHES[1], f.CONTROL_PADDING)]:
        path = root/f'cpw{n}'/f'pad{padding}'
        if not (path/'report.json').is_file():
            missing.append(str(path.relative_to(root)))
            continue
        cases[n, padding] = read_case(path, n, padding)
    rows, previous = [], None
    _, _, target = f.reference()
    for n in f.MESHES:
        if (n, f.PADDING) not in cases:
            continue
        row, transfer, resistance = cases[n, f.PADDING]
        change = None if previous is None else float(max(
            np.max(abs(transfer-previous[0])/target), np.max(abs(resistance-previous[1])/target)))
        rows.append({**row, 'mesh_rel':change, 'mesh_pair_passes':change is not None and change <= f.LIMITS['mesh_rel']})
        previous = transfer, resistance
    boundary = None
    middle = f.MESHES[1]
    if (middle, f.PADDING) in cases and (middle, f.CONTROL_PADDING) in cases:
        a, b = cases[middle, f.PADDING], cases[middle, f.CONTROL_PADDING]
        boundary = float(max(np.max(abs(a[1]-b[1])/target), np.max(abs(a[2]-b[2])/target)))
    qualified = (not missing and len(rows) == 3 and all(r['matches_and_qa'] for r in rows)
                 and all(r['mesh_pair_passes'] for r in rows[1:])
                 and boundary is not None and boundary <= f.LIMITS['boundary_rel']
                 and cases[middle, f.CONTROL_PADDING][0]['matches_and_qa'])
    return dict(protocol=f.PROTOCOL, limits=f.LIMITS, rows=rows, missing_cases=missing,
                boundary_rel=boundary, qualified_scope=bool(qualified),
                scope='ideal uniform-current TE10 outgoing amplitudes and input resistance only; no filament reactance target')


class ProbeTests(unittest.TestCase):
    def test_modal_power_and_reciprocity_overlap_reference(self):
        beta, z, r = f.reference()
        x = np.linspace(-f.A/2, f.A/2, 10001)*1e-3
        norm = np.trapezoid(np.cos(np.pi*x/(f.A*1e-3))**2, x)*f.B*1e-3
        amplitude = (f.B*1e-3)/(2*norm/z)  # reciprocity overlap for unit current
        np.testing.assert_allclose(amplitude, z/(f.A*1e-3), rtol=1e-14)
        np.testing.assert_allclose(2*norm*amplitude**2/z, r, rtol=1e-14)
        self.assertTrue(np.all(beta > 0))
        for band in ([], [1e9], [-10e9], [14e9], [np.nan]):
            with self.assertRaises(ValueError):
                f.reference(band)

    def test_discrete_displacement_subtraction_against_time_derivative(self):
        dt, freq, area = 1e-12, np.array([1e9, 10e9]), 1e-6
        voltage = np.array([1+2j, 3-4j])
        derivative = (voltage*np.exp(1j*np.pi*freq*dt)-voltage*np.exp(-1j*np.pi*freq*dt))/dt
        source = np.array([.1+.2j, .3-.4j])
        contour = source-f.EPS0*area*derivative/(f.B*1e-3)
        np.testing.assert_allclose(f.source_current(voltage, contour, area, dt, freq), source, atol=1e-16)
        for a, t in ((0, dt), (area, float('nan')), (-area, dt)):
            with self.assertRaises(ValueError):
                f.source_current(voltage, contour, a, t, freq)

    def test_outgoing_fit_keeps_reflections_and_two_triplets(self):
        beta = f.reference()[0]
        gamma = (0.03+1j*beta)[None, None, :]
        out = np.array([1.+.2j, .9-.1j])[:, None, None]
        incoming = .02j*out
        distance = f.PLANES[None, :, None]*1e-3
        v = out*np.exp(-gamma*distance)+incoming*np.exp(gamma*distance)
        g, o, i = f.waves(v)
        np.testing.assert_allclose(g, np.broadcast_to(gamma[:, 0], g.shape), atol=3e-12)
        np.testing.assert_allclose(o, np.broadcast_to(out[:, 0], o.shape), atol=3e-14)
        np.testing.assert_allclose(i, np.broadcast_to(incoming[:, 0], i.shape), atol=3e-14)
        with self.assertRaises(ValueError):
            f.waves(np.zeros_like(v))

    def test_build_keeps_filament_and_reference_planes_fixed(self):
        for n in f.MESHES:
            sim = f.build(n)
            for axis in 'xyz':
                lines = sim.mesh.GetLines(axis)
                np.testing.assert_allclose(lines, -lines[::-1], atol=2e-14)
            self.assertEqual(sim.ports[0]['start'], [0, -f.B/2, 0])
            self.assertEqual(sim.ports[0]['stop'], [0, f.B/2, 0])
            for p in f.PLANES:
                self.assertTrue(np.min(abs(sim.mesh.GetLines('z')-p)) < 1e-12)
        for args in ((True,), (21,), (40, 8)):
            with self.assertRaises(ValueError):
                f.build(*args)

    def synthetic(self, root):
        beta, _, target = f.reference()
        source = np.full(len(f.FREQUENCIES), .001+0j)
        voltage = source*(target+100j)
        for n, padding in [(n, f.PADDING) for n in f.MESHES]+[(f.MESHES[1], f.CONTROL_PADDING)]:
            path = Path(root)/f'cpw{n}'/f'pad{padding}'
            path.mkdir(parents=True)
            sim = f.build(n, padding)
            area = np.diff(sim.mesh.GetLines('x'))[0]*np.diff(sim.mesh.GetLines('z'))[0]*sim.unit**2
            dt = 1e-12
            contour = source-f.source_current(voltage, np.zeros_like(source), area, dt)
            v = np.broadcast_to((source*target)[None, None, :]
                *np.exp(-1j*beta[None, None, :]*f.PLANES[None, :, None]*1e-3),
                (2, 4, len(f.FREQUENCIES))).copy()
            meta = dict(protocol=f.PROTOCOL, geometry=f.geometry(), cpw=n, padding=padding,
                frequency_hz=f.FREQUENCIES.tolist(), limits=f.LIMITS, source_ids=f.source_ids(),
                cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
                area_m2=float(area), dt_s=dt, case_elapsed_s=2.,
                excitation_timesteps=int(np.ceil(f.PULSE_END_S/dt)),
                run=dict(converged=True, exact_endcriteria=True, hit_timestep_limit=False,
                    threads=4, engine='cpu', timesteps=30000, final_energy_bound_db=f.END_DB, wall_time_s=1.))
            (path/'report.json').write_text(json.dumps(meta), encoding='utf-8')
            np.savez(path/'data.npz', f=f.FREQUENCIES, v=v,
                current=np.broadcast_to(contour, (3, len(source))), voltage=voltage, contour=contour)
        return Path(root)/f'cpw{f.MESHES[0]}'/f'pad{f.PADDING}'

    def test_complete_cohort_guards_and_failed_data_never_qualify(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.synthetic(folder)
            self.assertTrue(compare(folder)['qualified_scope'])
            control = Path(folder)/f'cpw{f.MESHES[1]}'/f'pad{f.CONTROL_PADDING}'/'data.npz'
            with np.load(control) as src:
                control_data = dict(src)
            bad_control = {**control_data, 'current':control_data['current']+.01}
            np.savez(control, **bad_control)
            self.assertFalse(compare(folder)['qualified_scope'])
            np.savez(control, **control_data)
            report = path/'report.json'
            original = json.loads(report.read_text(encoding='utf-8'))
            for key, value in (('source_ids', {}), ('case_elapsed_s', f.CASE_SECONDS+1),
                               ('area_m2', original['area_m2']*2), ('cells', 1),
                               ('excitation_timesteps', 1)):
                report.write_text(json.dumps({**original, key:value}), encoding='utf-8')
                with self.assertRaises(ValueError):
                    compare(folder)
            for key, value in (('converged', False), ('wall_time_s', float('nan')),
                               ('final_energy_bound_db', -60.), ('threads', 8), ('timesteps', 1000)):
                report.write_text(json.dumps({**original, 'run':{**original['run'], key:value}}), encoding='utf-8')
                with self.assertRaises(ValueError):
                    compare(folder)
            report.write_text(json.dumps(original), encoding='utf-8')
            with np.load(path/'data.npz') as src:
                data = dict(src)
            data['v'] *= 1.1
            np.savez(path/'data.npz', **data)
            self.assertFalse(compare(folder)['qualified_scope'])
            data['contour'][0] = 0
            np.savez(path/'data.npz', **data)
            with self.assertRaises(ValueError):
                compare(folder)
            data['voltage'][0] = np.nan
            np.savez(path/'data.npz', **data)
            with self.assertRaises(ValueError):
                compare(folder)
            report.unlink()
            self.assertFalse(compare(folder)['qualified_scope'])

    def test_suspend_deadline_terminates_only_its_worker(self):
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
                patch.object(f.time, 'time', side_effect=[0., 1., f.CASE_SECONDS+1]):
            with self.assertRaises(TimeoutError):
                f.serial(Path(folder)/'new', 40)
            terminated.assert_called_once_with(proc.pid, grace=0, job=proc.win_job)
            released.assert_called_once_with(proc)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    for name in ('preflight', 'study', 'fdtd', 'compare'):
        mode.add_argument('--'+name, action='store_true')
    parser.add_argument('--out', type=Path)
    parser.add_argument('--mesh', type=int, choices=range(20, 121, 20), default=f.MESHES[0])
    parser.add_argument('--padding', type=int, choices=(f.PADDING, f.CONTROL_PADDING), default=f.PADDING)
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker and not args.fdtd:
        parser.error('internal worker requires --fdtd')
    if args.preflight:
        for n in f.MESHES:
            sim = f.build(n)
            print(json.dumps(dict(cpw=n, cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
                                 geometry=f.geometry(), limits=f.LIMITS)))
    elif args.fdtd or args.study or args.compare:
        if args.out is None:
            parser.error('--out is required')
        if args.compare:
            result = compare(args.out)
            (args.out/'comparison.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
            print(json.dumps(result, indent=2))
        elif args.fdtd:
            print(json.dumps((f.acquire if args.worker else f.serial)(args.out, args.mesh, args.padding)))
        else:
            frozen = f.source_ids()
            for n, padding in [(n, f.PADDING) for n in f.MESHES]+[(f.MESHES[1], f.CONTROL_PADDING)]:
                if f.source_ids() != frozen:
                    raise RuntimeError('acquisition sources changed during cohort')
                meta = f.serial(args.out/f'cpw{n}'/f'pad{padding}', n, padding)
                print(json.dumps(dict(cpw=n, padding=padding, cells=meta['cells'], run=meta['run'])), flush=True)
    else:
        unittest.main(argv=[sys.argv[0]])


if __name__ == '__main__':
    main()
