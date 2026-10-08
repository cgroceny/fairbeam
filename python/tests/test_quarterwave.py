"""Unequal-reference TEM transformer checks and opt-in native acquisition."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from fairbeam.network import network_s
from tests import quarterwave_fixture as f


class UnqualifiedStop(ValueError):
    """Incomplete source or unconfirmed energy stop; never accepted as data."""


def cases():
    return [(n, kind, c, False) for n in f.MESHES for kind in f.KINDS for c in (0, 1)]+[
        (f.MESHES[1], kind, c, True) for kind in f.KINDS for c in (0, 1)]


def case_path(root, n, kind, column, expanded):
    return Path(root)/kind/f'n{n}'/('expanded' if expanded else 'nominal')/f'e{column+1}'


def read_case(path, n, kind, column, expanded=False):
    path = Path(path)
    meta = json.loads((path/'report.json').read_text(encoding='utf-8'))
    if any(meta.get(k) != v for k, v in f.identity(n, kind, column, expanded).items()):
        raise ValueError('acquisition source, model, references or protocol differ')
    sim = f.build(n, kind, column, expanded)
    run, dt = meta.get('run', {}), meta.get('dt_s')
    steps = run.get('timesteps')
    values = [dt, meta.get('pulse_end_s'), meta.get('case_elapsed_s'), run.get('wall_time_s')]
    energy = [run.get(k) for k in ('final_energy_db', 'final_energy_bound_db')]
    energy = [v for v in energy if isinstance(v, (int, float)) and not isinstance(v, bool) and np.isfinite(v)]
    if (any(isinstance(v, bool) or not isinstance(v, (int, float)) or not np.isfinite(v) or v <= 0 for v in values)
            or not energy or max(values[2:]) > f.CASE_SECONDS
            or isinstance(steps, bool) or not isinstance(steps, int) or not 0 < steps <= sim.max_timesteps
            or meta.get('cells') != int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz']))
            or run.get('threads') != f.THREADS or run.get('engine') != 'cpu'
            or run.get('exact_endcriteria') is not True
            or not np.isclose(dt, f.time_settings(n, expanded)[0], rtol=5e-6, atol=0)):
        raise ValueError('bounded finite metadata and the declared native engine/timestep required')
    pulse = f.excitation.dgauss_duration_s(sim.f_max)
    if (run.get('converged') is not True or run.get('hit_timestep_limit') is not False
            or steps >= sim.max_timesteps or max(energy) > f.END_DB+1e-9
            or not np.isclose(values[1], pulse, rtol=1e-12, atol=0) or steps*dt < pulse):
        raise UnqualifiedStop('complete source and confirmed -90 dB stop required')
    if meta.get('input_sha256') != hashlib.sha256((path/'input.xml').read_bytes()).hexdigest():
        raise ValueError('stored native input changed')
    with np.load(path/'data.npz') as src:
        data = dict(src)
    if (not np.array_equal(data.get('f'), f.FREQUENCIES)
            or any(k not in data or data[k].shape != shape or not np.isfinite(data[k]).all()
                   for k, shape in dict(v=(2, 2, 3, 151), i=(2, 2, 2, 151), i_check=(2, 2, 2, 151)).items())):
        raise ValueError('finite spectra on the exact declared frequency grid required')
    return meta, data


def _line_calibration(columns, n, ref):
    """Two independent states and two planes recover signed gamma and Zc."""
    gammas, zs, transfer_errors = [], [], []
    dx = f.H_RIGHT/n*1e-3
    for p in (0, 1):
        states = []
        for q in (0, 1):
            states.append(np.asarray([[d['v'][p, q, 1]/np.sqrt(ref),
                d['i'][p, q].mean(axis=0)*np.sqrt(ref)] for d in columns]).transpose(2, 1, 0))
        if any(not np.isfinite(a).all() or np.max(np.linalg.cond(a)) > 10. for a in states):
            raise ValueError('ill-conditioned independent uniform-line states')
        transfer = np.linalg.solve(states[1].transpose(0, 2, 1), states[0].transpose(0, 2, 1)).transpose(0, 2, 1)
        length = (f.PLANES[p][1]-f.PLANES[p][0])*1e-3
        g = np.arccosh((transfer[:, 0, 0]+transfer[:, 1, 1])/2)/length
        g = np.where(g.imag < 0, -g, g)
        # The averaged dual currents introduce cosh(gamma*dx/2).
        z = ref*np.sqrt(transfer[:, 0, 1]/transfer[:, 1, 0])*np.cosh(g*dx/2)
        z = np.where(z.real < 0, -z, z)
        if not np.isfinite(g).all() or not np.isfinite(z).all():
            raise ValueError('singular uniform-line inversion')
        gammas.append(g)
        zs.append(z)
        transfer_errors.extend((np.max(abs(np.linalg.det(transfer)-1)),
                                np.max(abs(transfer[:, 0, 0]-transfer[:, 1, 1]))))
    gammas, zs = np.asarray(gammas), np.asarray(zs)
    g, z = gammas.mean(axis=0), zs.mean(axis=0)
    target = 2*np.pi*f.FREQUENCIES/f.C0
    metrics = dict(calibration_beta_rel=float(np.max(abs(gammas.imag-target)/target)),
        calibration_z_rel=float(np.max(abs(zs-ref)/ref)),
        calibration_spread_rel=float(max(np.max(abs(gammas-g)/abs(g)), np.max(abs(zs-z)/abs(z)))),
        calibration_transfer_abs=float(max(transfer_errors)))
    return g, z, metrics


def calibration(controls, n):
    gamma, zc, metrics = {}, {}, []
    for kind, ref in (('line50', f.Z_LEFT), ('line10', f.Z_RIGHT)):
        gamma[kind], zc[kind], row = _line_calibration(controls[kind], n, ref)
        metrics.append(row)
    return gamma, zc, {key: max(row[key] for row in metrics) for key in metrics[0]}


def measurement(columns, n, kind, gamma, zc):
    """Independent unequal-reference power waves and general ABCD plane inversion."""
    refs, _ = f.port_spec(kind)
    control_kinds = ['line50' if z == f.Z_LEFT else 'line10' for z in refs]
    g, z = np.asarray([gamma[k] for k in control_kinds]), np.asarray([zc[k] for k in control_kinds])
    matrices, conditions = [], []
    dx = f.H_RIGHT/n*1e-3
    for q in (0, 1):
        a, b = [], []
        for data in columns:
            voltage = data['v'][:, q, 1]
            current = data['i'][:, q].mean(axis=1)/np.cosh(g*dx/2)
            current *= np.array([1., -1.])[:, None]
            distance = np.asarray([abs(f.PLANES[p][q]-f.TARGETS[p])*1e-3 for p in (0, 1)])[:, None]
            ch, sh = np.cosh(g*distance), np.sinh(g*distance)
            u, i = voltage*ch-z*current*sh, current*ch-voltage/z*sh
            a.append((u+refs[:, None]*i)/(2*np.sqrt(refs[:, None])))
            b.append((u-refs[:, None]*i)/(2*np.sqrt(refs[:, None])))
        a, b = np.asarray(a).transpose(2, 1, 0), np.asarray(b).transpose(2, 1, 0)
        condition = np.linalg.cond(a)
        if not np.isfinite(condition).all() or np.max(condition) > 10.:
            raise ValueError('ill-conditioned incident-wave excitation matrix')
        matrices.append(np.linalg.solve(a.transpose(0, 2, 1), b.transpose(0, 2, 1)).transpose(0, 2, 1))
        conditions.append(float(np.max(condition)))
    s = np.mean(matrices, axis=0)
    zin, reflection = f.input_impedance(s, kind)
    target = f.reference(kind)
    zt, rt = f.input_impedance(target, kind)
    metrics = dict(s_target_abs=float(np.max(abs(s-target))),
        gamma_target_abs=float(np.max(abs(reflection-rt))),
        z_target_rel=float(np.max(abs(zin-zt)/np.maximum(abs(zt), refs[0]))),
        power_abs=float(np.max(abs(s.conj().transpose(0, 2, 1)@s-np.eye(2)))),
        reciprocity_abs=float(np.max(abs(s[:, 0, 1]-s[:, 1, 0]))),
        plane_spread_abs=float(np.max(abs(matrices[0]-matrices[1]))),
        current_strip_spread_rel=float(max(np.max(abs(d['i'][p]-d['i_check'][p]))/np.max(abs(d['i'][p]))
            for d in columns for p in (0, 1))))
    edges = f.band_edges(reflection) if kind == 'transformer' else None
    if edges is not None:
        metrics['band_edge_target_rel'] = float(np.max(abs(edges-f.analytic_band()))/f.F0)
    return s, zin, reflection, edges, metrics, max(conditions)


def differences(a, b, suffix, kind):
    metrics = {f's_{suffix}_abs': float(np.max(abs(a[1]-b[1]))),
        f'gamma_{suffix}_abs': float(np.max(abs(a[3]-b[3]))),
        f'z_{suffix}_rel': float(np.max(abs(a[2]-b[2])/np.maximum(abs(b[2]), f.port_spec(kind)[0][0])))}
    if kind == 'transformer':
        metrics[f'band_edge_{suffix}_rel'] = float(np.max(abs(a[4]-b[4]))/f.F0)
    return metrics


def compare(root):
    records, missing, rejected = {}, [], []
    for key in cases():
        path = case_path(root, *key)
        if not (path/'report.json').is_file():
            missing.append(str(path.relative_to(root)))
            continue
        try:
            records[key] = read_case(path, *key)
        except UnqualifiedStop as error:
            rejected.append(dict(mesh=key[0], kind=key[1], column=key[2], expanded=key[3], reason=str(error)))
    evaluated, rows = {}, []
    for n, expanded in [(n, False) for n in f.MESHES]+[(f.MESHES[1], True)]:
        control_keys = [(n, kind, c, expanded) for kind in f.KINDS[:2] for c in (0, 1)]
        if not all(k in records for k in control_keys):
            continue
        gamma, zc, cal = calibration({kind: [records[n, kind, c, expanded][1] for c in (0, 1)]
            for kind in f.KINDS[:2]}, n)
        for kind in f.KINDS:
            keys = [(n, kind, c, expanded) for c in (0, 1)]
            if not all(k in records for k in keys):
                continue
            s, zin, reflection, edges, metrics, condition = measurement(
                [records[k][1] for k in keys], n, kind, gamma, zc)
            quality = {**cal, **metrics}
            zt, _ = f.input_impedance(f.reference(kind), kind)
            row = dict(mesh=n, kind=kind, expanded=expanded, metrics=quality,
                band_edges_hz=None if edges is None else edges.tolist(),
                max_incident_condition=condition,
                passes=bool(all(v <= f.LIMITS[k] for k, v in quality.items())),
                samples=[dict(f_ghz=float(f.FREQUENCIES[k]/1e9),
                    z_ohm=[float(zin[k].real), float(zin[k].imag)],
                    target_ohm=[float(zt[k].real), float(zt[k].imag)],
                    gamma_abs=float(abs(reflection[k]))) for k in (0, 37, 75, 113, 150)])
            evaluated[n, kind, expanded] = row, s, zin, reflection, edges
            rows.append(row)
    qualified, controls = [], []
    for kind in f.KINDS:
        nominal = [(n, kind, False) for n in f.MESHES]
        changes = [differences(evaluated[a], evaluated[b], 'mesh', kind)
            for a, b in zip(nominal[:-1], nominal[1:]) if a in evaluated and b in evaluated]
        a, b = (f.MESHES[1], kind, False), (f.MESHES[1], kind, True)
        boundary = differences(evaluated[a], evaluated[b], 'boundary', kind) if a in evaluated and b in evaluated else None
        passes = (all(k in evaluated and evaluated[k][0]['passes'] for k in nominal)
            and len(changes) == 2 and all(v <= f.LIMITS[k] for c in changes for k, v in c.items())
            and boundary is not None and evaluated[b][0]['passes']
            and all(v <= f.LIMITS[k] for k, v in boundary.items()))
        controls.append(dict(kind=kind, mesh_changes=changes, boundary=boundary, passes=bool(passes)))
        if passes:
            qualified.append(kind)
    if not all(kind in qualified for kind in f.KINDS[:2]):
        qualified = []
    return dict(protocol=f.PROTOCOL, rows=rows, controls=controls, missing_cases=missing,
        rejected_cases=rejected, qualified_kinds=qualified,
        qualified_scope=not missing and not rejected and len(qualified) == len(f.KINDS),
        scope='sampled ideal PEC/PMC TEM height-step transformer and matched real 50/10-ohm references; no PCB or packaged-load claim')


class QuarterwaveControls(unittest.TestCase):
    def test_unequal_reference_against_independent_line_stamping(self):
        for kind in f.KINDS:
            refs, _ = f.port_spec(kind)
            z = f.ZT if kind == 'transformer' else refs[0]
            independent = network_s(f.FREQUENCIES, [0, 1], [(0, 1, z, 1/(4*f.F0))], z_ref=refs)
            np.testing.assert_allclose(independent, f.reference(kind), atol=2e-15)
        zin, reflection = f.input_impedance(f.reference('transformer'), 'transformer')
        self.assertAlmostEqual(zin[75].real, 50.)
        self.assertLess(abs(reflection[75]), 1e-15)
        wrong = network_s(f.FREQUENCIES, [0, 1], [(0, 1, f.ZT, 1/(4*f.F0))], z_ref=50.)
        self.assertGreater(abs(wrong[75, 0, 0]), .6)

    def test_swr_band_and_closed_form_reflection(self):
        s = f.reference('transformer')
        theta = 2*np.pi*f.FREQUENCIES/(4*f.F0)
        expected = (f.Z_LEFT-f.Z_RIGHT)**2*np.cos(theta)**2/(
            4*f.Z_LEFT*f.Z_RIGHT+(f.Z_LEFT-f.Z_RIGHT)**2*np.cos(theta)**2)
        np.testing.assert_allclose(abs(s[:, 0, 0])**2, expected, atol=3e-16)
        np.testing.assert_allclose(f.band_edges(s[:, 0, 0]), f.analytic_band(), rtol=5e-5)
        self.assertAlmostEqual(f.analytic_band().sum(), 2*f.F0)
        for bad in (np.zeros(151), np.ones(151), np.full(151, np.nan)):
            with self.assertRaises(ValueError):
                f.band_edges(bad)

    def test_reciprocal_lossless_power_and_references(self):
        for kind in f.KINDS:
            s = f.reference(kind)
            np.testing.assert_allclose(s[:, 0, 1], s[:, 1, 0], atol=0)
            np.testing.assert_allclose(s.conj().transpose(0, 2, 1)@s,
                np.broadcast_to(np.eye(2), s.shape), atol=8e-16)
        with self.assertRaises(ValueError):
            f.reference('transformer', [np.nan])

    def test_uniform_calibration_keeps_distinct_impedances_and_signed_loss(self):
        controls = {}
        g = -.03+2j*np.pi*f.FREQUENCIES/f.C0
        dx = f.H_RIGHT/4*1e-3
        for kind, z in (('line50', 50.1+.01j), ('line10', 10.02+.002j)):
            columns = []
            for forward, backward in ((1., .3-.2j), (.2+.1j, 1.2)):
                v, i = np.empty((2, 2, 3, 151), complex), np.empty((2, 2, 2, 151), complex)
                for p in (0, 1):
                    for q, centre in enumerate(f.PLANES[p]):
                        for j, shift in enumerate((-dx, 0., dx)):
                            x = centre*1e-3+shift
                            v[p, q, j] = forward*np.exp(-g*x)+backward*np.exp(g*x)
                        for j, shift in enumerate((-dx/2, dx/2)):
                            x = centre*1e-3+shift
                            i[p, q, j] = (forward*np.exp(-g*x)-backward*np.exp(g*x))/z
                columns.append(dict(v=v, i=i))
            controls[kind] = columns
        gamma, zc, _ = calibration(controls, 4)
        for kind, z in (('line50', 50.1+.01j), ('line10', 10.02+.002j)):
            np.testing.assert_allclose(gamma[kind], g, atol=2e-12, rtol=0)
            np.testing.assert_allclose(zc[kind], z, atol=2e-12, rtol=0)
        with self.assertRaises(ValueError):
            calibration({k: [v[0], v[0]] for k, v in controls.items()}, 4)

    def test_physical_steps_conservative_timestep_and_independent_contours(self):
        previous = 0
        for n in f.MESHES:
            for kind in f.KINDS:
                sim = f.build(n, kind)
                axes = [sim.mesh.GetLines(a) for a in 'xyz']
                self.assertTrue(all(np.min(np.diff(a)) >= f.H_RIGHT/n*.9 for a in axes))
                refs, heights = f.port_spec(kind)
                np.testing.assert_allclose(np.sqrt(f.MUE0/f.EPS0)*heights/f.W, refs, atol=1e-14)
                dt, steps = f.time_settings(n)
                self.assertLess(dt, sim.cfl_timestep())
                self.assertGreaterEqual(dt*steps, f.CAP_NS*1e-9)
                self.assertEqual(sim.boundaries, ['PML_8', 'PML_8', 'PMC', 'PMC', 'PEC', 'PEC'])
                cells = int(np.prod([len(a)-1 for a in axes]))
                if kind == 'transformer':
                    self.assertGreater(cells, previous)
                    previous = cells
                self.assertEqual(len(sim.csx.GetPropertiesByName('conductors')[0].GetAllPrimitives()),
                                 6 if kind == 'transformer' else 4)
                for p in (0, 1):
                    for q, centre in enumerate(f.PLANES[p]):
                        ix = int(np.flatnonzero(axes[0] == centre)[0])
                        np.testing.assert_allclose(np.diff(axes[0][ix-1:ix+2]), f.H_RIGHT/n, atol=3e-14, rtol=0)
                        for j in (0, 1):
                            boxes = [sim.csx.GetPropertiesByName(f'{label}{p}_{q}_{j}')[0].GetPrimitive(0)
                                     for label in ('i', 'j')]
                            self.assertGreater(boxes[0].GetStart()[1], 0.)
                            self.assertLess(boxes[0].GetStop()[1], f.W)
                            self.assertGreater(boxes[1].GetStart()[1], boxes[0].GetStart()[1])
                            self.assertLess(boxes[1].GetStop()[1], boxes[0].GetStop()[1])
                            for box in boxes:
                                self.assertLess(box.GetStart()[2], heights[p])
                                self.assertGreater(box.GetStop()[2], heights[p])
        with self.assertRaises(ValueError):
            f.build(True, 'transformer')

    def synthetic(self, root):
        gamma = 2j*np.pi*f.FREQUENCIES/f.C0
        for n, kind, c, expanded in cases():
            path = case_path(root, n, kind, c, expanded)
            path.mkdir(parents=True)
            sim = f.build(n, kind, c, expanded)
            refs, _ = f.port_spec(kind)
            s, dx = f.reference(kind), f.H_RIGHT/n*1e-3
            ar = np.zeros((2, 151), complex)
            ar[c], ar[1-c] = 1., .07+.02j
            br = np.einsum('fij,jf->if', s, ar)
            ur, ir = np.sqrt(refs[:, None])*(ar+br), (ar-br)/np.sqrt(refs[:, None])
            v, i = np.empty((2, 2, 3, 151), complex), np.empty((2, 2, 2, 151), complex)
            for p in (0, 1):
                sign = 1 if p == 0 else -1
                for q, centre in enumerate(f.PLANES[p]):
                    for j, shift in enumerate((-dx, 0., dx)):
                        dist = abs(centre*1e-3+shift-f.TARGETS[p]*1e-3)
                        v[p, q, j] = ur[p]*np.cosh(gamma*dist)+refs[p]*ir[p]*np.sinh(gamma*dist)
                    for j, shift in enumerate((-dx/2, dx/2)):
                        dist = abs(centre*1e-3+shift-f.TARGETS[p]*1e-3)
                        i[p, q, j] = sign*(ir[p]*np.cosh(gamma*dist)+ur[p]/refs[p]*np.sinh(gamma*dist))
            np.savez(path/'data.npz', f=f.FREQUENCIES, v=v, i=i, i_check=i.copy())
            sim.fdtd.Write2XML(str(path/'input.xml'))
            pulse, dt = f.excitation.dgauss_duration_s(sim.f_max), f.time_settings(n, expanded)[0]
            meta = dict(**f.identity(n, kind, c, expanded), dt_s=dt, pulse_end_s=pulse,
                cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])), case_elapsed_s=1.,
                input_sha256=hashlib.sha256((path/'input.xml').read_bytes()).hexdigest(),
                run=dict(engine='cpu', threads=f.THREADS, wall_time_s=.5,
                    timesteps=int(np.ceil(pulse/dt))+100, converged=True, hit_timestep_limit=False,
                    exact_endcriteria=True, final_energy_bound_db=f.END_DB))
            (path/'report.json').write_text(json.dumps(meta), encoding='utf-8')

    def test_full_synthetic_cohort_unequal_waves_and_bandwidth(self):
        with tempfile.TemporaryDirectory() as root:
            self.synthetic(root)
            result = compare(root)
            self.assertTrue(result['qualified_scope'])
            self.assertEqual(result['qualified_kinds'], list(f.KINDS))
            self.assertLess(max(r['metrics']['s_target_abs'] for r in result['rows']), 3e-12)

    def test_stop_source_timestep_references_hash_and_deadline_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            self.synthetic(root)
            path = case_path(root, 4, 'transformer', 0, False)/'report.json'
            original = json.loads(path.read_text())
            for flaw in ('source', 'energy', 'dt', 'refs', 'hash', 'deadline'):
                bad = json.loads(json.dumps(original))
                if flaw == 'source':
                    bad['run']['timesteps'] = int(np.ceil(bad['pulse_end_s']/bad['dt_s']))-1
                elif flaw == 'energy':
                    bad['run']['converged'] = False
                elif flaw == 'dt':
                    bad['dt_s'] *= 1.01
                elif flaw == 'refs':
                    bad['reference_ohm'][1] = 50.
                elif flaw == 'hash':
                    bad['input_sha256'] = 'stale'
                else:
                    bad['case_elapsed_s'] = f.CASE_SECONDS+1
                path.write_text(json.dumps(bad), encoding='utf-8')
                with self.subTest(flaw=flaw), self.assertRaises(ValueError):
                    read_case(path.parent, 4, 'transformer', 0)
                if flaw in ('source', 'energy'):
                    self.assertFalse(compare(root)['qualified_scope'])
            path.write_text(json.dumps(original), encoding='utf-8')

    def test_missing_fine_and_nonreciprocal_column_block_acceptance(self):
        with tempfile.TemporaryDirectory() as root:
            self.synthetic(root)
            path = case_path(root, 6, 'transformer', 1, True)/'data.npz'
            with np.load(path) as src:
                data = dict(src)
            data['v'][0] *= 1.1
            data['i'][0] *= 1.1
            np.savez(path, **data)
            result = compare(root)
            self.assertNotIn('transformer', result['qualified_kinds'])
            (case_path(root, 8, 'line10', 0, False)/'report.json').unlink()
            self.assertFalse(compare(root)['qualified_scope'])

    def test_independent_current_contour_is_required(self):
        with tempfile.TemporaryDirectory() as root:
            self.synthetic(root)
            path = case_path(root, 6, 'transformer', 0, True)/'data.npz'
            with np.load(path) as src:
                data = dict(src)
            data['i_check'][0] *= 1.01
            np.savez(path, **data)
            self.assertNotIn('transformer', compare(root)['qualified_kinds'])

    def test_suspend_deadline_cleans_up_only_owned_worker(self):
        class Process:
            pid, win_job, running = 123, object(), True
            def wait(self, timeout):
                if self.running:
                    raise subprocess.TimeoutExpired('owned-worker', timeout)
                return 1
            def poll(self):
                return None if self.running else 1
        process = Process()
        def stop(*args, **kwargs):
            process.running = False
        with tempfile.TemporaryDirectory() as root, patch.object(f, 'popen_group', return_value=process), \
                patch.object(f, 'terminate_group', side_effect=stop) as terminate, \
                patch.object(f, 'release_group') as release, \
                patch.object(f, 'clocks', side_effect=[(0., 0.), (.1, f.CASE_SECONDS+1)]):
            with self.assertRaises(TimeoutError):
                f.serial(Path(root)/'case', 4, 'transformer')
            terminate.assert_called_once_with(process.pid, grace=0, job=process.win_job)
            release.assert_called_once_with(process)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    for name in ('preflight', 'fdtd', 'study', 'compare'):
        mode.add_argument('--'+name, action='store_true')
    parser.add_argument('--out', type=Path)
    parser.add_argument('--mesh', type=int, choices=f.MESHES, default=f.MESHES[0])
    parser.add_argument('--kind', choices=f.KINDS, default='transformer')
    parser.add_argument('--column', type=int, choices=(0, 1), default=0)
    parser.add_argument('--expanded', action='store_true')
    parser.add_argument('--coarse-only', action='store_true', help='partial nominal cohort; cannot qualify convergence')
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker and not args.fdtd:
        parser.error('internal worker requires --fdtd')
    if args.coarse_only and not args.study:
        parser.error('--coarse-only requires --study')
    if args.preflight:
        for n in f.MESHES:
            sim = f.build(n, args.kind, args.column, args.expanded)
            dt, steps = f.time_settings(n, args.expanded)
            print(json.dumps(dict(mesh=n, cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
                requested_dt_ps=dt*1e12, cfl_dt_ps=sim.cfl_timestep()*1e12, max_steps=steps,
                pulse_end_s=f.excitation.dgauss_duration_s(sim.f_max), refs=f.port_spec(args.kind)[0].tolist(),
                length_mm=f.D, transformer_height_mm=float(f.H_TRANSFORMER), analytic_band_hz=f.analytic_band().tolist())))
    elif args.fdtd or args.study or args.compare:
        if args.out is None:
            parser.error('--out is required')
        if args.compare:
            result = compare(args.out)
            (args.out/'comparison.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
            print(json.dumps(result, indent=2))
        elif args.fdtd:
            print(json.dumps((f.acquire if args.worker else f.serial)(args.out, args.mesh, args.kind, args.column, args.expanded)))
        else:
            frozen = f.source_ids()
            for key in cases():
                if args.coarse_only and (key[0] != f.MESHES[0] or key[3]):
                    continue
                if f.source_ids() != frozen:
                    raise RuntimeError('source changed during acquisition')
                path = case_path(args.out, *key)
                if not path.exists():
                    f.serial(path, *key)
                try:
                    read_case(path, *key)
                    print(json.dumps(dict(mesh=key[0], kind=key[1], column=key[2], complete=True)), flush=True)
                except UnqualifiedStop as error:
                    print(json.dumps(dict(mesh=key[0], kind=key[1], column=key[2], rejected=True, reason=str(error))), flush=True)
    else:
        unittest.main(argv=[__name__])


if __name__ == '__main__':
    main()
