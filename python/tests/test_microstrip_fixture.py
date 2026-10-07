"""Pure controls plus explicit, serial, bounded native microstrip acquisition.

From python/: python -m tests.test_microstrip_fixture --preflight
Native cases require --fdtd; ordinary unittest discovery never runs FDTD.
"""
import argparse
import hashlib
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
from fairbeam.network import two_line_calibration, shift_reference_planes
from tests import microstrip_fixture as f


class MicrostripControls(unittest.TestCase):
    def test_reflected_line_inversion_retains_signed_loss(self):
        gamma = -.08+1j*np.linspace(535., 550., 41)
        impedance, dx, reflection = 50+.04j, .00025, .3-.2j
        centre = .008
        v = np.asarray([np.exp(-gamma*x)+reflection*np.exp(gamma*x)
                        for x in (centre-dx, centre, centre+dx)])
        i = np.asarray([(np.exp(-gamma*x)-reflection*np.exp(gamma*x))/impedance
                        for x in (centre-dx/2, centre+dx/2)])
        measured, z, current = f.local_line(v, i, dx)
        np.testing.assert_allclose(measured, gamma, atol=2e-11, rtol=0)
        np.testing.assert_allclose(z, impedance, atol=2e-12, rtol=0)
        np.testing.assert_allclose(current, (np.exp(-gamma*centre)-reflection*np.exp(gamma*centre))/impedance,
                                   atol=1e-15, rtol=0)
        self.assertTrue(np.all(measured.real < 0))

    def test_phase_triplets_reject_nodes(self):
        gamma = .25+1j*np.linspace(535., 550., 41)
        x = np.arange(6., 12.)*1e-3
        v = (np.exp(-x[:, None]*gamma)+.2j*np.exp(x[:, None]*gamma))[:, None, :]
        np.testing.assert_allclose(f.triplets(np.repeat(v, 3, axis=1)), [gamma, gamma], atol=2e-12, rtol=0)
        v[2] = 0
        with self.assertRaisesRegex(ValueError, 'node'):
            f.triplets(np.repeat(v, 3, axis=1))

    def test_wave_matrix_removes_unintended_incident_waves(self):
        # Both columns contain an incoming wave at the nominally passive end.
        s = np.tile(np.array([[.01j, .92-.2j], [.92-.2j, -.01j]]), (41, 1, 1))
        incoming = np.tile(np.array([[1., .03j], [.02, .9-.1j]]), (41, 1, 1))
        outgoing = s@incoming
        v = (np.sqrt(50)*(incoming+outgoing)).transpose(2, 1, 0)
        i = ((incoming-outgoing)/np.sqrt(50)).transpose(2, 1, 0)
        np.testing.assert_allclose(f.scattering(v, i, 50), s, atol=5e-16, rtol=0)
        self.assertGreater(np.max(abs(outgoing[:, 0, 0]/incoming[:, 0, 0]-s[:, 0, 0])), .01)
        with self.assertRaises(ValueError):
            f.scattering(v, i, -50)

    def test_reference_and_geometry_units(self):
        gamma, z = f.reference('pec')
        # The explicit rounded width is retained; the approximate 50-ohm
        # design inversion is not silently fitted to the forward formula.
        self.assertAlmostEqual(z, 49.8004608, delta=1e-7)
        self.assertAlmostEqual(gamma[20].imag*f.COMPARISON_LENGTH*180/np.pi, 270., delta=.5)
        self.assertTrue(np.all(gamma.real == 0))
        self.assertAlmostEqual(f.reference('dielectric')[0][20].real, .255, delta=.001)
        self.assertAlmostEqual(f.reference('copper-sheet')[0][20].real, 1.08, delta=.01)

    def test_mesh_refines_outer_fields_and_preserves_interfaces(self):
        previous = None
        for n in f.RESOLUTIONS:
            x, y, z = f.mesh_lines(n, 4., 10.)
            self.assertTrue(all(np.all(np.diff(a) > 0) for a in (x, y, z)))
            self.assertIn(0., z)
            self.assertIn(f.H, z)
            self.assertLessEqual(np.max(np.diff(y)), 8*f.H/n+1e-12)
            if previous is not None:
                self.assertLess(np.max(np.diff(y)), previous)
            previous = np.max(np.diff(y))
        for args in ((True, 4.), (8, 5.), (8, 4., 'invalid'), (8, 4., 'pec', 3)):
            with self.assertRaises(ValueError):
                f.build(*args)

    def test_current_contours_are_on_actual_dual_grid(self):
        for n in f.STUDY_MESH:
            sim, centres = f.build(n, 4.)
            x = sim.mesh.GetLines('x')
            for p, centre in enumerate(centres):
                index = int(np.flatnonzero(x == centre)[0])
                expected = ((x[index-1]+x[index])/2, (x[index]+x[index+1])/2)
                for j, plane in enumerate(expected):
                    box = sim.csx.GetPropertiesByName(f'i{p}_{j}')[0].GetPrimitive(0)
                    self.assertEqual(box.GetStart()[0], plane)
                    self.assertEqual(box.GetStop()[0], plane)

    def test_last_pair_alone_cannot_establish_convergence(self):
        reference = np.full(41, 100.)
        values = np.array([reference, reference+1., reference+1.1])
        gate = convergence(values, reference, 0., (.03, .005, .002))
        self.assertLess(gate['mesh_changes_percent'][-1], .5)
        self.assertFalse(gate['passes'])
        with self.assertRaises(ValueError):
            convergence(np.full((3, 41), np.nan), reference, 0., (.03, .005, .002))

    def test_impedance_error_includes_reactance(self):
        # Matching resistance must not hide a stable, incorrect reactance.
        values = np.full((3, 41), 50.+5j)
        gate = convergence(values, 50., 0., f.LIMITS['z'])
        self.assertEqual(gate['target_error_percent'], 10.)
        self.assertFalse(gate['passes'])

    def test_dispersion_sensitivity_against_independent_difference(self):
        diagnostic = dispersive_diagnostic(f.ER)
        for step in (1e-4, 1e-5):
            difference = (dispersive_diagnostic(f.ER+step)['eps_eff']
                          - dispersive_diagnostic(f.ER-step)['eps_eff'])/(2*step)
            np.testing.assert_allclose(diagnostic['eps_r_derivative'], difference, rtol=2e-8)
        self.assertAlmostEqual(diagnostic['alpha_dielectric'][20], .26715465835, delta=1e-10)

    def test_timestep_limit_is_not_an_energy_stop(self):
        meta = {'run':dict(converged=True, exact_endcriteria=True, threads=4,
                          final_energy_db=None, final_energy_bound_db=-70.)}
        self.assertTrue(stopped(meta))
        meta['run']['hit_timestep_limit'] = True
        self.assertFalse(stopped(meta))
        meta['run']['hit_timestep_limit'] = False
        meta['run']['final_energy_bound_db'] = -69.9
        self.assertFalse(stopped(meta))

    def test_suspended_wall_clock_overrun_is_rejected_even_after_child_exit(self):
        process = Mock(args=['native-worker'])
        process.wait.return_value = 0
        # A Windows wait can exclude suspended time. Completion on resume
        # must not turn an over-budget acquisition into an accepted result.
        with patch.object(time, 'monotonic', side_effect=[0., 1., 2.]), \
             patch.object(time, 'time', side_effect=[100., 101., 1901.]):
            with self.assertRaises(subprocess.TimeoutExpired):
                wait_case(process)

    def test_over_budget_stored_run_is_not_accepted(self):
        meta = {'run':dict(converged=True, exact_endcriteria=True, threads=4,
                          final_energy_bound_db=-70., wall_time_s=1800.1)}
        self.assertFalse(stopped(meta))

    def test_case_guard_rejects_wrong_geometry_and_source(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'pec'/'n8'/'l4'/'e1'
            path.mkdir(parents=True)
            meta = dict(resolution=8, length_mm=4., kind='pec', excited_port=1,
                air_mm=5., width_mm=f.W, substrate_mm=f.H, eps_r=f.ER,
                geometry_thickness_mm=0., frequency_hz=f.FREQUENCIES.tolist(),
                fixture_sha256='wrong', run={})
            report = path/'report.json'
            report.write_text(json.dumps(meta), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'geometry|source'):
                load_case(root, 8, 4., 'pec', 1)
            meta['width_mm'] += .001
            report.write_text(json.dumps(meta), encoding='utf-8')
            with self.assertRaises(ValueError):
                load_case(root, 8, 4., 'pec', 1)

    def test_stored_probe_grid_corruption_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'pec'/'n8'/'l4'/'e1'
            path.mkdir(parents=True)
            centres = np.unique(np.r_[1., np.arange(6., 12.), 10., 15.])
            count, nf = len(centres), len(f.FREQUENCIES)
            data = dict(f=f.FREQUENCIES.copy(), centres=centres,
                v=np.ones((count, 3, nf)), i=np.ones((count, 2, nf)),
                z=np.ones((count, nf)), current=np.ones((count, nf)),
                gamma=np.ones((2, nf)), local_gamma=np.ones((count, nf)))
            meta = dict(resolution=8, length_mm=4., kind='pec', excited_port=1,
                air_mm=5., width_mm=f.W, substrate_mm=f.H, eps_r=f.ER,
                geometry_thickness_mm=0., frequency_hz=f.FREQUENCIES.tolist(),
                loss_tangent_at_f0=0., loss_reference_hz=f.F0,
                fixture_sha256=hashlib.sha256(Path(f.__file__).read_bytes()).hexdigest(),
                simulation_sha256=hashlib.sha256(Path(f.simulation_module.__file__).read_bytes()).hexdigest(),
                run=dict(converged=True, exact_endcriteria=True, threads=4, final_energy_db=-70.))
            (path/'report.json').write_text(json.dumps(meta), encoding='utf-8')
            np.savez(path/'data.npz', **data)
            load_case(root, 8, 4., 'pec', 1)
            data['centres'][3] += .25
            np.savez(path/'data.npz', **data)
            with self.assertRaisesRegex(ValueError, 'probe grid'):
                load_case(root, 8, 4., 'pec', 1)


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


def serial(out, n, length, kind, excite, air):
    if out.exists():
        raise ValueError('fresh native output directory required')
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.with_name(out.name+'.log').open('w', encoding='utf-8') as log:
        proc = popen_group([sys.executable, '-m', 'tests.test_microstrip_fixture', '--worker',
            '--out', str(out), '--mesh', str(n), '--length', str(length), '--kind', kind,
            '--excite', str(excite), '--air', str(air)], stdout=log, stderr=subprocess.STDOUT,
            env={**os.environ, 'OPENBLAS_NUM_THREADS':'1', 'OMP_NUM_THREADS':'1'})
        try:
            try:
                code = wait_case(proc)
            except subprocess.TimeoutExpired:
                if proc.poll() is None:
                    terminate_group(proc.pid, grace=0, job=proc.win_job)
                proc.wait(timeout=15)
                raise RuntimeError('30-minute case limit; over-budget output retained and excluded') from None
        finally:
            if proc.poll() is None:
                terminate_group(proc.pid, grace=0, job=proc.win_job)
                proc.wait(timeout=15)
            release_group(proc)
    if code:
        raise RuntimeError(f'native case failed: {out}')
    return json.loads((out/'report.json').read_text(encoding='utf-8'))


def stopped(meta):
    run = meta['run']
    energy = run.get('final_energy_db')
    if energy is None:
        energy = run.get('final_energy_bound_db', 0)
    return bool(run.get('converged') and run.get('exact_endcriteria')
                and not run.get('hit_timestep_limit', False) and energy <= -70
                and 0 <= run.get('wall_time_s', 0.) <= 1800
                and run.get('threads') == 4)


def load_case(root, n, length, kind, excite, source_sha=None):
    path = Path(root)/kind/f'n{n}'/f'l{int(length)}'/f'e{excite}'
    meta = json.loads((path/'report.json').read_text(encoding='utf-8'))
    expected = (n, length, kind, excite, 5., f.W, f.H, f.ER, 0.)
    actual = tuple(meta[k] for k in ('resolution', 'length_mm', 'kind', 'excited_port',
                    'air_mm', 'width_mm', 'substrate_mm', 'eps_r', 'geometry_thickness_mm'))
    expected_sha = source_sha or hashlib.sha256(Path(f.__file__).read_bytes()).hexdigest()
    if (actual != expected or not np.array_equal(meta['frequency_hz'], f.FREQUENCIES)
            or meta['fixture_sha256'] != expected_sha or not stopped(meta)):
        raise ValueError('wrong geometry, frequency, acquisition source or energy stop')
    # An explicitly named older PEC source can be inspected as a coarse
    # control. It cannot silently enter the default current-source mesh study.
    legacy_pec = source_sha is not None and kind == 'pec'
    tangent = meta.get('loss_tangent_at_f0', 0. if legacy_pec else None)
    loss_frequency = meta.get('loss_reference_hz', f.F0 if legacy_pec else None)
    sim_sha = hashlib.sha256(Path(f.simulation_module.__file__).read_bytes()).hexdigest()
    if (tangent != (f.TAND if kind in ('dielectric', 'both-sheet') else 0.)
            or loss_frequency != f.F0 or meta['simulation_sha256'] != sim_sha):
        raise ValueError('material or simulation-code identity mismatch')
    with np.load(path/'data.npz') as stored:
        data = {k: stored[k].copy() for k in stored.files}
    centres = np.unique(np.r_[1., np.arange(6., 12.), f.FEED_LENGTH+length, length+11.])
    count, nf = len(centres), len(f.FREQUENCIES)
    shapes = dict(v=(count, 3, nf), i=(count, 2, nf), z=(count, nf),
                  current=(count, nf), local_gamma=(count, nf), gamma=(2, nf))
    if (not np.array_equal(data.get('f'), f.FREQUENCIES)
            or not np.array_equal(data.get('centres'), centres)
            or any(key not in data or data[key].shape != shape for key, shape in shapes.items())
            or not all(np.isfinite(value).all() for value in data.values())):
        raise ValueError('invalid measured spectra or stored probe grid')
    return meta, data


def mode_indices(data):
    return [int(np.flatnonzero(data['centres'] == plane)[0]) for plane in np.arange(6., 12.)]


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


def dispersive_diagnostic(eps_r):
    """Post-hoc diagnostic, never a replacement for the declared static gates.

    Hammerstad-Jensen frequency formulas: Qucs Technical Documentation,
    https://qucs.sourceforge.net/tech/node75.html, equations 11.65--11.68.
    With fixed geometry, alpha_d follows the epsilon_r sensitivity of beta;
    the runtime's constant kappa gives tan_delta(f)=tan_delta(F0)*F0/f.
    """
    if not np.isfinite(eps_r) or eps_r <= 1:
        raise ValueError('diagnostic requires finite epsilon_r greater than one')
    e0 = f.microstrip_eps_eff(eps_r, f.H, f.W)
    z0 = f.microstrip_z0(eps_r, f.H, f.W)
    fp = z0/(2*f.MUE0*f.H*1e-3)
    g = np.pi**2/12*(eps_r-1)/e0*np.sqrt(2*np.pi*z0/(f.MUE0*f.C0))
    p = g*(f.FREQUENCIES/fp)**2
    effective = e0+(eps_r-e0)*p/(1+p)
    # e0 is affine in epsilon_r and z0 is proportional to e0**(-1/2).
    slope = (e0-1)/(eps_r-1)
    log_p_slope = 1/(eps_r-1)-slope/(4*e0)
    derivative = (slope+(1-slope)*p/(1+p)
                  +(eps_r-e0)*p*log_p_slope/(1+p)**2)
    k0 = 2*np.pi*f.FREQUENCIES/f.C0
    tangent = f.TAND*f.F0/f.FREQUENCIES
    return dict(eps_eff=effective, eps_r_derivative=derivative,
                beta=k0*np.sqrt(effective),
                z=z0*np.sqrt(e0/effective)*(effective-1)/(e0-1),
                alpha_dielectric=k0*eps_r*tangent*derivative/(2*np.sqrt(effective)))


def study_report(root):
    rows, betas, impedances, losses, beta_spreads, z_spreads, loss_spreads = [], [], [], [], [], [], []
    source_ids = set()
    for n in f.STUDY_MESH:
        pec_meta, pec = load_case(root, n, 4., 'pec', 1)
        diel_meta, diel = load_case(root, n, 4., 'dielectric', 1)
        source_ids.update(m['simulation_sha256'] for m in (pec_meta, diel_meta))
        beta = pec['gamma'].imag.mean(axis=0)
        z = pec['z'][mode_indices(pec)].mean(axis=0)
        paired_loss = diel['gamma'].real-pec['gamma'].real
        loss = paired_loss.mean(axis=0)
        beta_spread = float(np.max(abs(pec['gamma'].imag-beta)/beta))
        z_spread = float(np.max(abs(pec['z'][mode_indices(pec)]-z)/abs(z)))
        loss_spread = float(np.max(abs(paired_loss-loss)/f.reference('dielectric')[0].real))
        betas.append(beta); impedances.append(z); losses.append(loss)
        beta_spreads.append(beta_spread); z_spreads.append(z_spread); loss_spreads.append(loss_spread)
        rows.append(dict(n=n, beta_rad_m=float(beta[20]), z_ohm=[float(z[20].real), float(z[20].imag)],
            alpha_dielectric_np_m=float(loss[20]), alpha_pec_signed_np_m=float(pec['gamma'].real.mean(axis=0)[20]),
            beta_spread_percent=100*beta_spread, z_spread_percent=100*z_spread,
            loss_spread_percent=100*loss_spread,
            cases=[{k:m[k] for k in ('cells', 'dt_s', 'fixture_sha256', 'runtime_versions')}
                   | {'seconds':m['run']['wall_time_s']} for m in (pec_meta, diel_meta)]))
    if len(source_ids) != 1:
        raise ValueError('simulation code changed between paired mesh controls')
    gates = dict(beta=convergence(betas, f.reference('pec')[0].imag, beta_spreads[-1], f.LIMITS['beta']),
                 z=convergence(impedances, f.reference('pec')[1], z_spreads[-1], f.LIMITS['z']),
                 dielectric_loss=convergence(losses, f.reference('dielectric')[0].real, loss_spreads[-1], f.LIMITS['alpha']))
    diagnostic = dispersive_diagnostic(f.ER)
    notes = []
    changes = gates['dielectric_loss']['mesh_changes_percent']
    if changes[-1] > changes[0]:
        notes.append('Dielectric last mesh change increased; numeric gates alone do not establish asymptotic convergence')
    return dict(status='numeric gates only; no blanket validation',
        geometry='zero-thickness PEC strip; dielectric conductivity fixed at 10 GHz',
        limitation='No bulk-copper, port power normalization or de-embedding convergence claim',
        rows=rows, gates=gates, review_notes=notes, posthoc_diagnostic=dict(
            status='published approximate frequency model; not used by acceptance gates',
            source='https://qucs.sourceforge.net/tech/node75.html',
            values_10ghz={k:float(v[20]) for k, v in diagnostic.items()}))


def wave_matrix(cases, z_ref, planes):
    voltages, currents = [], []
    for _, data in cases:
        indices = [int(np.flatnonzero(data['centres'] == p)[0]) for p in planes]
        voltages.append(data['v'][indices, 1, :])
        currents.append(data['current'][indices]*np.array([1, -1])[:, None])
    return f.scattering(np.asarray(voltages), np.asarray(currents), z_ref)


def calibration_report(root, n=8, source_sha=None):
    controls = {length:[load_case(root, n, length, 'pec', excite, source_sha)
                       for excite in (1, 2)] for length in f.LENGTHS}
    cases = sum(controls.values(), [])
    z_mode = float(np.mean([data['z'][mode_indices(data)].real for _, data in cases]))
    record = dict(resolution=n, measured_vi_reference_ohm=z_mode,
        status='coarse control; no mesh or power-normalization validation', methods={})
    for z_ref, label in ((50., 'fixed50'), (z_mode, 'measured_vi')):
        results, arrays, calibrations = {}, {}, {}
        for family in ('raw', 'modal'):
            arrays[family] = [wave_matrix(controls[length], z_ref,
                (1., length+11.) if family == 'raw' else (6., length+6.)) for length in f.LENGTHS]
            lengths = np.asarray(f.LENGTHS)*1e-3 + (.010 if family == 'raw' else 0.)
            try:
                cal = two_line_calibration(f.FREQUENCIES, *arrays[family],
                    short_length_m=lengths[0], long_length_m=lengths[1],
                    beta_hint=f.reference('pec')[0].imag)
                calibrations[family] = cal
                gamma = cal['gamma_per_m'][20]
                launch = cal['launch_product'][20]
                results[family] = dict(status='calculated, not mesh qualified',
                    gamma_mid=[float(gamma.real), float(gamma.imag)],
                    match_max=float(cal['match_max']), reciprocity_max=float(cal['reciprocity_max']),
                    launch_mid=[float(launch.real), float(launch.imag)])
                if family == 'raw':
                    corrected = [shift_reference_planes(s, cal['gamma_per_m'], [.005, .005])
                                 for s in arrays[family]]
            except ValueError as error:
                results[family] = dict(status='rejected', reason=str(error))
        if results['raw']['status'].startswith('calculated'):
            results['raw']['feed_shift_delta_s_max'] = float(max(np.max(abs(a-b))
                for a, b in zip(corrected, arrays['modal'])))
        if all(results[family]['status'].startswith('calculated') for family in ('raw', 'modal')):
            differences = []
            for raw, modal in zip(arrays['raw'], arrays['modal']):
                # Two lines identify only the product g1*g2. It can remove
                # transmission launch response, but cannot fix S11 or S22.
                a = (raw[:, (1, 0), (0, 1)]
                     * np.exp(calibrations['raw']['gamma_per_m'][:, None]*.010)
                     / calibrations['raw']['launch_product'][:, None])
                b = modal[:, (1, 0), (0, 1)]/calibrations['modal']['launch_product'][:, None]
                differences.append(float(np.max(abs(a-b))))
            results['transmission_product_delta_s_max'] = max(differences)
            results['transmission_note'] = 'Product normalization only; no individual launch split or reflection correction'
        record['methods'][label] = results
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--preflight', action='store_true')
    actions.add_argument('--fdtd', action='store_true')
    actions.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    actions.add_argument('--study', action='store_true', help='six serial PEC/dielectric mesh cases')
    actions.add_argument('--control-sweep', action='store_true', help='four serial n8 two-line controls')
    actions.add_argument('--compare', action='store_true', help='offline per-quantity mesh gates')
    actions.add_argument('--calibrate', action='store_true', help='offline coarse two-excitation controls')
    parser.add_argument('--out', type=Path)
    parser.add_argument('--mesh', type=int, choices=f.RESOLUTIONS, default=8)
    parser.add_argument('--length', type=float, choices=f.LENGTHS, default=4.)
    parser.add_argument('--kind', choices=f.KINDS, default='pec')
    parser.add_argument('--excite', type=int, choices=(1, 2), default=1)
    parser.add_argument('--air', type=float, default=5.)
    parser.add_argument('--source-sha256', help='explicit older acquisition identity, only for --calibrate')
    args = parser.parse_args()
    if args.source_sha256 and (not args.calibrate or len(args.source_sha256) != 64
                              or any(c not in '0123456789abcdef' for c in args.source_sha256)):
        parser.error('--source-sha256 must be a lowercase SHA256 with --calibrate')
    if args.preflight:
        rows = []
        for n in f.STUDY_MESH:
            for length in f.LENGTHS:
                sim, centres = f.build(n, length, args.kind, args.excite, args.air)
                rows.append(dict(n=n, length_mm=length,
                    cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
                    centres_mm=centres.tolist()))
        print(json.dumps(rows, indent=2))
    elif args.worker:
        if args.out is None:
            parser.error('--out is required')
        print(json.dumps(f.acquire(args.out, args.mesh, args.length, args.kind, args.excite, args.air)))
    elif args.fdtd:
        if args.out is None:
            parser.error('--out is required')
        meta = serial(args.out, args.mesh, args.length, args.kind, args.excite, args.air)
        print(json.dumps({k:meta[k] for k in ('resolution', 'length_mm', 'kind', 'excited_port', 'air_mm', 'cells', 'dt_s')}))
        print(json.dumps({k:meta['run'].get(k) for k in ('wall_time_s', 'timesteps', 'converged', 'final_energy_db', 'final_energy_bound_db')}))
    elif args.study or args.control_sweep:
        if args.out is None:
            parser.error('--out is required')
        cases = ([(n, 4., kind, 1) for n in f.STUDY_MESH for kind in ('pec', 'dielectric')]
                 if args.study else [(8, length, 'pec', excite)
                                     for length in f.LENGTHS for excite in (1, 2)])
        frozen = hashlib.sha256(Path(f.__file__).read_bytes()).hexdigest()
        for n, length, kind, excite in cases:
            if hashlib.sha256(Path(f.__file__).read_bytes()).hexdigest() != frozen:
                raise RuntimeError('acquisition source changed during the serial study')
            out = args.out/kind/f'n{n}'/f'l{int(length)}'/f'e{excite}'
            meta = serial(out, n, length, kind, excite, 5.)
            print(json.dumps(dict(n=n, length_mm=length, kind=kind, excite=excite,
                cells=meta['cells'], dt_ps=meta['dt_s']*1e12,
                seconds=meta['run']['wall_time_s'], energy_stopped=stopped(meta))), flush=True)
    elif args.compare or args.calibrate:
        if args.out is None:
            parser.error('--out is required')
        report = (study_report(args.out) if args.compare else
                  calibration_report(args.out, args.mesh, args.source_sha256))
        path = args.out/('comparison.json' if args.compare else 'calibration.json')
        path.write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
        print(json.dumps(report, indent=2))
    else:
        unittest.main(argv=[sys.argv[0]])


if __name__ == '__main__':
    main()
