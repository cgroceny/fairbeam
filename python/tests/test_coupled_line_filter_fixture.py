"""Opt-in own coupled-line filter; discovery starts no propagation.

From python/ with the bundled openEMS environment:
python -m unittest tests.test_coupled_line_filter_fixture -q
python -m tests.test_coupled_line_filter_fixture --preflight --out C:/study/coupled-plan-fresh
"""
import argparse
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET
import numpy as np
from fairbeam.procutil import popen_group, release_group, terminate_group
from fairbeam.network import network_s
from tests.test_coax_resonator import wait_owned
from tests import coupled_line_filter_fixture as f

def configurations(include_diagnostics=False):
    cases = [(f'n{n}_{kind}_{loss}', n, kind, loss, 'ordinary')
        for n in f.MESHES for kind in f.KINDS for loss in f.LOSSES]+[
        (f'n2_filter_{loss}_{control}', 2, 'filter', loss, control)
        for loss in f.LOSSES for control in f.STUDY_CONTROLS]
    if include_diagnostics:
        cases += [(f'n1_through_pec_{control}', 1, 'through', 'pec', control) for control in f.DIAGNOSTIC_CONTROLS]
    return cases


def forecast(meta, rate):
    if not np.isfinite(rate) or rate <= 0: raise ValueError('positive conservative rate required')
    return 1.2*meta['native_cells']*meta['max_timesteps']/(rate*1e6)+45.


def freeze(out, n, kind, loss, control, cap_s=None):
    planned = []
    for port in (1, 2):
        holder = f.build(n, port, kind, loss, control, cap_s); sim, meta = holder[0], holder[2]
        path = out/f'planned-p{port}.xml'; sim.fdtd.Write2XML(str(path))
        sim.fdtd.SetTimeStep(0.); sim.fdtd.SetNumberOfTimeSteps(1024)
        operator = out/f'planned-p{port}-operator.xml'; sim.fdtd.Write2XML(str(operator))
        planned.append(dict(**meta, input_sha256=f.sha(path), operator_input_sha256=f.sha(operator)))
    plan = dict(source=f.identity(), runtime=f.runtime_identity(), ports=planned)
    f.save(out/'plan.json', plan)
    return plan


def preflight(out, rate):
    out = Path(out); out.mkdir(parents=True, exist_ok=False); rows = []
    for name, n, kind, loss, control in configurations(include_diagnostics=True):
        folder = out/name; folder.mkdir()
        plan = freeze(folder, n, kind, loss, control)
        for meta in plan['ports']:
            seconds = forecast(meta, rate)
            rows.append(dict(name=name, **meta, forecast_seconds=seconds, deferred=seconds > 1800.))
    result = dict(rows=rows, source=f.identity(), runtime=f.runtime_identity(),
        rate_mcps=rate, limits=f.LIMITS, dimensions=f.dimensions(), native_propagations=0, qualified=False)
    f.save(out/'preflight.json', result)
    return result


def acquire(out, n=1, kind='filter', loss='pec', control='ordinary', rate=15., pilot_s=None, allow_cap=False):
    out = Path(out).resolve()
    if out.exists(): raise ValueError('fresh output directory required')
    if pilot_s is not None and (not np.isfinite(pilot_s) or not 0 < pilot_s <= .5e-9):
        raise ValueError('performance pilot must be in 0..0.5 ns')
    holder = f.build(n, 1, kind, loss, control, pilot_s); meta = holder[2]
    estimate = forecast(meta, rate)
    if estimate > 1800.: raise ValueError('forecast exceeds 30 minutes; defer this cohort')
    out.mkdir(parents=True, exist_ok=False); plan = freeze(out, n, kind, loss, control, pilot_s)
    state = dict(started_utc=datetime.now(timezone.utc).isoformat(), status='prepared',
        source=plan['source'], runtime=plan['runtime'], active_launcher_pid=None, qualified=False,
        pilot=pilot_s is not None, capped_diagnostic_requested=allow_cap,
        driver_head=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=f.ROOT, text=True).strip(),
        forecast_seconds_per_source=estimate, rate_mcps=rate)
    progress = out/'progress.json'; f.save(progress, state)
    try:
        for port in ((1,) if pilot_s is not None else (1, 2)):
            if f.identity() != state['source'] or f.runtime_identity() != state['runtime']:
                raise ValueError('frozen source/runtime changed')
            command = [sys.executable, '-m', 'tests.test_coupled_line_filter_fixture', '--worker',
                '--mesh', str(n), '--kind', kind, '--loss', loss, '--control', control,
                '--port', str(port), '--out', str(out/f'port{port}')]
            if pilot_s is not None: command.extend(('--pilot-seconds', str(pilot_s)))
            start, wall = time.monotonic(), time.time(); code = None; failure = None
            with (out/f'port{port}.log').open('x', encoding='utf-8') as log:
                proc = popen_group(command, cwd=f.ROOT/'python', stdout=log, stderr=subprocess.STDOUT)
                state.update(status='running', active_port=port, active_launcher_pid=proc.pid); f.save(progress, state)
                try: code = wait_owned(proc, seconds=1800.)
                except BaseException as error: failure = repr(error); raise
                finally:
                    if proc.poll() is None:
                        terminate_group(proc.pid, grace=0, job=proc.win_job); proc.wait(timeout=15)
                    release_group(proc)
                    f.save(out/f'port{port}.worker.json', dict(command=command, pid=proc.pid, exit_code=code,
                        failure=failure, wall_seconds=time.time()-wall, monotonic_seconds=time.monotonic()-start,
                        deadline_seconds=1800., forecast_seconds=estimate, driver_head=state['driver_head']))
            if code: raise RuntimeError('native worker failed; partial records retained')
            folder = out/f'port{port}'; report = json.loads((folder/'report.json').read_text())
            report.update(native_header=f.audit_header((out/f'port{port}.log').read_text(), report),
                native_log_sha256=f.sha(out/f'port{port}.log')); f.save(folder/'report.json', report)
            checks = f.quality(report)
            if pilot_s is not None:
                required = ('grid', 'clock', 'time', 'operator', 'geometry', 'probes', 'header', 'engine')
                if (not all(checks[k] for k in required) or report['native']['iteration_wall_s'] <= 0
                        or report['native']['timesteps'] != report['max_timesteps']):
                    raise ValueError('incomplete/invalid timing pilot')
                native = report['native']
                state.update(status='performance_only', rate_measured_mcps=native['cells']*native['timesteps']/native['iteration_wall_s']/1e6)
                return state
            f.read(folder, allow_cap)
        _, result = f.matrix(out, allow_cap)
        state.update(status='complete' if result['native_complete'] else 'complete_with_known_deviation', result=result)
        return result
    except BaseException as error:
        state.update(status='rejected', reason=repr(error)); raise
    finally:
        state.update(active_port=None, active_launcher_pid=None); f.save(progress, state)


def align_plane(actual, loss):
    from fairbeam.network import shift_reference_planes
    gamma = 2j*np.pi*f.FREQUENCIES*np.sqrt(f.ER)/f.C0
    return shift_reference_planes(actual, gamma, [.003, .003])


def study(root):
    root = Path(root); missing = []; rejected = []; results = {}; rows = []
    for name, n, kind, loss, control in configurations():
        folder = root/name
        if not all((folder/f'port{p}/report.json').exists() for p in (1, 2)):
            missing.append(name); continue
        try:
            actual, row = f.matrix(folder)
            expected = dict(n=n, kind=kind, loss=loss, control=control)
            if any(row.get(key) != value for key, value in expected.items()):
                raise ValueError(f'cohort identity mismatch for {name}: expected {expected}')
        except (ValueError, AssertionError, FileNotFoundError) as error:
            rejected.append(dict(name=name, reason=repr(error))); continue
        results[name] = actual; rows.append(row)
    mesh = []; controls = []
    for kind in f.KINDS:
        for loss in f.LOSSES:
            for a, b in zip(f.MESHES[:-1], f.MESHES[1:]):
                first, second = f'n{a}_{kind}_{loss}', f'n{b}_{kind}_{loss}'
                if first in results and second in results:
                    change = f.difference(results[second], results[first])
                    mesh.append(dict(kind=kind, loss=loss, from_mesh=a, to_mesh=b, **change,
                        passes=change['s_abs'] <= f.LIMITS['mesh_s_abs'] and change['phase_deg'] <= f.LIMITS['mesh_phase_deg']))
    for loss in f.LOSSES:
        base = f'n2_filter_{loss}'
        for control in f.STUDY_CONTROLS:
            other = base+'_'+control
            if base not in results or other not in results: continue
            # Feed-plane changes have an independently specified analytical
            # phase shift; remove only that propagation, never fit a launch.
            actual = results[other]
            if control == 'plane':
                actual = align_plane(actual, loss)
            change = f.difference(actual, results[base])
            controls.append(dict(loss=loss, control=control, **change,
                passes=change['s_abs'] <= f.LIMITS['control_s_abs'] and change['phase_deg'] <= f.LIMITS['control_phase_deg']))
    qualified = (not missing and not rejected and len(mesh) == 6 and len(controls) == 5
        and all(r['passes'] for r in mesh+controls)
        and all(r['native_complete'] and r['measurement_passes'] and r['point_target_passes'] for r in rows))
    return dict(qualified=qualified, missing=missing, rejected=rejected, rows=rows, mesh_changes=mesh,
        controls=controls, native_copper_qualified=False,
        scope='Homogeneous thin PEC only; finite open ends/junctions are not ideal circuit elements; no fabricated-launch certificate')


def scattering_reference(freq, plane_mm=6.):
    # Independent modal four-port networks, open unused ends, and connect
    # their scattering blocks directly rather than cascading ABCD matrices.
    q = np.array([[1,1,0,0],[0,0,1,1],[1,-1,0,0],[0,0,1,-1]])/np.sqrt(2)
    sections = []
    for ze, zo in f.modal_targets():
        mode = np.zeros((len(freq),4,4),complex)
        mode[:,:2,:2] = network_s(freq,[0,1],[(0,1,ze,1/(4*f.F0))],z_ref=f.Z0)
        mode[:,2:,2:] = network_s(freq,[0,1],[(0,1,zo,1/(4*f.F0))],z_ref=f.Z0)
        physical = q.T@mode@q
        a, o = [0,3], [1,2]
        aa, ao = physical[:,a,:][:,:,a], physical[:,a,:][:,:,o]
        oa, oo = physical[:,o,:][:,:,a], physical[:,o,:][:,:,o]
        sections.append(aa+ao@np.linalg.solve(np.eye(2)-oo,oa))
    blocks = np.zeros((len(freq),8,8),complex)
    for j, section in enumerate(sections): blocks[:,2*j:2*j+2,2*j:2*j+2] = section
    e, i = [0,7], list(range(1,7)); swap = np.zeros((6,6))
    for j in (0,2,4): swap[j,j+1] = swap[j+1,j] = 1
    ee, ei = blocks[:,e,:][:,:,e], blocks[:,e,:][:,:,i]
    ie, ii = blocks[:,i,:][:,:,e], blocks[:,i,:][:,:,i]
    result = ee+ei@np.linalg.solve(np.eye(6)-swap@ii,swap@ie)
    gamma = 2j*np.pi*freq*np.sqrt(f.ER)/f.C0
    return result*np.exp(-gamma*2*plane_mm*1e-3)[:,None,None]



class CohortIdentityTests(unittest.TestCase):
    """Study admission must bind replayed data to the requested cohort."""

    def test_replayed_identity_and_duplicate_mesh_admission(self):
        from unittest.mock import patch
        from contextlib import ExitStack
        fields = ['n', 'kind', 'loss', 'control']
        chosen = [c for c in configurations() if c[2] == 'filter'
                  and c[fields.index('control') + 1] == 'ordinary'
                  and ('loss' not in fields or c[fields.index('loss') + 1] == 'pec')][:2]
        self.assertEqual(len(chosen), 2)
        self.assertNotEqual(chosen[0][1], chosen[1][1])
        mutations = [('valid', None), ('duplicate mesh', 'n')]
        mutations += [('wrong ' + key, key) for key in fields if key != 'n']
        mutations += [('missing ' + key, key) for key in fields]
        for label, key in mutations:
            with self.subTest(case=label), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                metadata = {}
                for config in chosen:
                    folder = root / config[0]
                    folder.mkdir()
                    metadata[config[0]] = dict(zip(fields, config[1:]))
                    for port in (1, 2):
                        (folder / f'port{port}').mkdir()
                        (folder / f'port{port}' / 'report.json').write_text('{}')
                second = metadata[chosen[1][0]]
                if label == 'duplicate mesh':
                    second['n'] = chosen[0][1]
                elif label.startswith('missing '):
                    del second[key]
                elif key is not None:
                    second[key] = 'wrong-cohort'
                spectrum = np.zeros((len(f.FREQUENCIES), 2, 2), complex)
                spectrum[:, 0, 1] = spectrum[:, 1, 0] = 1

                def row_for(folder):
                    return dict(metadata[Path(folder).name], native_complete=True,
                                measurement_passes=True, point_target_passes=True,
                                point_passes=True, requested_spec_passes=True,
                                reference_spec_passes=True)

                with ExitStack() as stack:
                    stack.enter_context(patch(__name__ + '.configurations', return_value=chosen))
                    stack.enter_context(patch.object(f, 'matrix',
                        side_effect=lambda folder, *args: (spectrum, row_for(folder))))
                    report = study(root)
                changes = report.get('mesh_changes', report.get('changes',
                    report.get('by_order', {}).get('3', {}).get('mesh_changes', [])))
                if label == 'valid':
                    self.assertEqual(report['rejected'], [])
                    self.assertEqual(len(changes), 1)
                    self.assertTrue(changes[0]['passes'])
                else:
                    self.assertEqual([r['name'] for r in report['rejected']], [chosen[1][0]])
                    self.assertIn('cohort identity mismatch', report['rejected'][0]['reason'])
                    self.assertEqual(changes, [])
                    self.assertFalse(report['qualified'])

class CoupledFilterTests(unittest.TestCase):
    def test_independent_scattering_network_agrees_with_impedance_abcd(self):
        np.testing.assert_allclose(f.reference(),scattering_reference(f.FREQUENCIES),atol=4e-12,rtol=0)

    def test_reciprocal_and_lossless_ideal_reference(self):
        s = f.reference()
        np.testing.assert_allclose(s,s.transpose(0,2,1),atol=1e-12)
        np.testing.assert_allclose(s.conj().transpose(0,2,1)@s,
            np.broadcast_to(np.eye(2),s.shape),atol=2e-12)

    def test_prototype_and_distributed_prediction_stay_distinct(self):
        frequency = np.array([1.8e9])
        exact = -20*np.log10(abs(f.reference(frequency)[0,1,0]))
        self.assertAlmostEqual(exact,19.4148371030121,places=10)
        self.assertAlmostEqual(float(f.prototype_loss(frequency)[0]),20.8118119654694,places=10)
        self.assertGreater(abs(exact-f.prototype_loss(frequency)[0]),1.)

    def test_geometry_recovers_the_declared_modal_impedances(self):
        for section in f.dimensions()['sections']:
            np.testing.assert_allclose(f.cohn.impedances(section['width_mm'],section['gap_mm']),
                [section['even_ohm'],section['odd_ohm']],atol=2e-12,rtol=0)

    def test_physical_quarter_lengths_and_exact_mirror(self):
        d = f.dimensions()
        self.assertEqual(len(d['sections']),4)
        self.assertAlmostEqual(d['quarter_length_mm']*1e-3*np.sqrt(f.ER)/f.C0,1/(4*f.F0))
        for left, right in zip(d['sections'],d['sections'][::-1]):
            self.assertAlmostEqual(left['input_y_mm'],-right['output_y_mm'])
            self.assertAlmostEqual(left['output_y_mm'],-right['input_y_mm'])
        np.testing.assert_allclose(d['feed_centres_mm'],[-d['feed_centres_mm'][1],d['feed_centres_mm'][1]])

    def test_actual_width_junctions_do_not_short_the_other_open_end(self):
        d = f.dimensions(); rectangles = []
        for k, s in enumerate(d['sections']):
            for owner, key in ((k,'input_y_mm'),(k+1,'output_y_mm')):
                rectangles.append((owner,d['junctions_mm'][k],d['junctions_mm'][k+1],
                    s[key]-s['width_mm']/2,s[key]+s['width_mm']/2))
        for owner, x0, x1, cy in ((0,-30.,0.,d['feed_centres_mm'][0]),
                (4,d['junctions_mm'][-1],d['junctions_mm'][-1]+30.,d['feed_centres_mm'][1])):
            rectangles.append((owner,x0,x1,cy-d['feed_width_mm']/2,cy+d['feed_width_mm']/2))
        for j, a in enumerate(rectangles):
            for b in rectangles[j+1:]:
                if a[0] == b[0]: continue
                overlap_x = min(a[2],b[2])-max(a[1],b[1])
                overlap_y = min(a[4],b[4])-max(a[3],b[3])
                self.assertFalse(overlap_x >= -1e-12 and overlap_y >= -1e-12,(a,b))
        for owner in (1,2,3):
            a,b = [r for r in rectangles if r[0] == owner]
            self.assertGreater(min(a[4],b[4])-max(a[3],b[3]),0.)

    def test_mesh_interfaces_symmetry_and_growth(self):
        boundaries = []
        for n in f.MESHES:
            x,y,z = f.mesh_lines(n)
            boundaries.append([x[8],x[-9],y[0],y[-1],z[0],z[-1]])
            np.testing.assert_allclose(y,-y[::-1],atol=1e-12,rtol=0)
            np.testing.assert_allclose(z,-z[::-1],atol=1e-12,rtol=0)
            for axis in (x,y,z):
                h = np.diff(axis); self.assertTrue(np.all(h>0))
                self.assertLessEqual(max(np.max(h[1:]/h[:-1]),np.max(h[:-1]/h[1:])),2+1e-10)
        np.testing.assert_allclose(boundaries,np.broadcast_to(boundaries[0],(len(f.MESHES),6)),atol=1e-12,rtol=0)

    def test_invalid_reference_and_mesh_are_rejected(self):
        for n in (True,-1,4,1.):
            with self.assertRaises(ValueError): f.mesh_lines(n)
            with self.assertRaises(ValueError): f.build(n,1)
        for frequency in ([],[0],[4e9],[np.nan],[2e9+1j]):
            with self.assertRaises(ValueError): f.reference(np.array(frequency))

    def test_native_feed_resistance_and_signed_excitation(self):
        for source in (1,2):
            sim,ports,meta = f.build(1,source)
            self.assertEqual(len(sim.ports),2)
            self.assertEqual(len(ports),2)
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp)/'input.xml'; sim.fdtd.Write2XML(str(path))
                root = ET.parse(path).getroot()
            elements = root.findall('.//LumpedElement')
            self.assertEqual(len(elements),4)
            self.assertEqual([float(e.get('R')) for e in elements],[100.]*4)
            sources = root.findall('.//Excitation')
            # The FDTD waveform and two opposite ground-half excitations.
            physical = [e for e in sources if e.get('Name')]
            self.assertEqual(len(physical),2)
            self.assertEqual(sorted(float(e.get('Excite').split(',')[2]) for e in physical),[-.625,.625])
            self.assertTrue(all(f'group_{source}_' in e.get('Name') for e in physical))
            for group in meta['grouped_feeds']:
                self.assertEqual(group['group']['connection'],'parallel')
                self.assertEqual(group['group']['members'][0]['polarity'],-1)

    def test_zero_width_sources_use_exact_mesh_coordinates(self):
        for n in f.MESHES:
            for source in (1,2):
                _,_,meta = f.build(n,source)
                x = np.asarray(meta['mesh_mm']['x'])
                for feed in meta['grouped_feeds']:
                    self.assertTrue(np.any(x==feed['start'][0]))
                    self.assertEqual(feed['start'][0],feed['stop'][0])
                names=meta['required_properties']
                self.assertEqual(sum('_port_excite_' in v for v in names),2)
                self.assertEqual(sum('_port_resist_' in v for v in names),4)
                self.assertTrue(set(meta['solids']).issubset(names))

    def test_unused_source_is_refused_before_propagation(self):
        _,_,meta = f.build(0,1,kind='through')
        used = {name:[True] for name in meta['required_properties']}
        source = next(name for name in used if '_port_excite_' in name)
        used[source] = [False]
        operator = dict(timestep_s=meta['declared_dt_s']/.72,grid=meta['grid'])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); freeze(root,0,'through','pec','ordinary')
            with patch.object(f.CoupledFilterSimulation,'run',return_value=operator) as run, \
                    patch.object(f,'usage',return_value=used):
                with self.assertRaisesRegex(ValueError,'operator CFL/material-usage'):
                    f.capture(root/'port1',0,1,kind='through')
                self.assertEqual(run.call_count,1)
                self.assertTrue(run.call_args.kwargs['setup_only'])
                self.assertFalse((root/'port1/raw').exists())

    def test_source_and_plane_controls_preserve_physical_mesh_and_clock(self):
        ordinary = f.build(1,1)[2]
        for control in ('source','plane'):
            other = f.build(1,1,control=control)[2]
            for key in ('dimensions','mesh_mm','declared_dt_s','cap_s','solids'):
                self.assertEqual(ordinary[key],other[key])
        self.assertEqual(f.build(1,1,control='source')[2]['source_distance_mm'],12.)
        self.assertEqual(f.build(1,1,control='plane')[2]['plane_mm'],9.)
        reduced = f.build(1,1,control='dt')[2]
        self.assertAlmostEqual(reduced['declared_dt_s']/ordinary['declared_dt_s'],.75)
        self.assertEqual(reduced['cap_s'],ordinary['cap_s'])

    def test_extended_time_control_keeps_geometry_and_tightens_stopping(self):
        ordinary = f.build(0,1)[2]; extended = f.build(0,1,control='time')[2]
        for key in ('dimensions','mesh_mm','declared_dt_s','required_properties','grouped_feeds'):
            self.assertEqual(ordinary[key],extended[key])
        self.assertAlmostEqual(extended['cap_s'],144e-9,places=20)
        self.assertEqual(extended['end_db'],-90.)
        self.assertEqual(ordinary['cap_s'],48e-9)
        # A longer window never bypasses the measured-rate budget gate.
        self.assertGreater(forecast(extended,50.),1800.)
        self.assertLess(forecast(extended,70.),1800.)

    def test_probe_geometry_surrounds_the_single_feed_conductor(self):
        for kind in f.KINDS:
            sim,_,meta = f.build(1,1,kind=kind)
            y,z = (np.asarray(meta['mesh_mm'][a]) for a in 'yz')
            my,mz = (y[:-1]+y[1:])/2,(z[:-1]+z[1:])/2
            for endpoint in (0,1):
                feed = meta['grouped_feeds'][endpoint]
                for loop in (0,1):
                    a,b = meta['expected_current_indices'][f'i{endpoint}_{loop}_0']
                    self.assertLess(my[a[1]],feed['start'][1])
                    self.assertGreater(my[b[1]],feed['stop'][1])
                    self.assertLess(mz[a[2]],0.)
                    self.assertGreater(mz[b[2]],0.)
            self.assertEqual(len(f.probe_names()[0]),12)
            self.assertEqual(len(f.probe_names()[1]),8)
            with self.assertRaises(ValueError): sim.to_bundle()

    def test_plane_alignment_removes_only_the_declared_feed_length(self):
        original = f.reference(plane_mm=6.)
        other = f.reference(plane_mm=9.)
        np.testing.assert_allclose(align_plane(other,'pec'),original,atol=1e-13,rtol=0)

    def test_stopband_reference_planes_preserve_reciprocity(self):
        # Exercise the full admitted band, including the high-rejection edges
        # where subtracting the large ABCD determinant products loses digits.
        from fairbeam.network import shift_reference_planes
        frequency = np.linspace(1e9, 3e9, 1001)
        gamma = 2j*np.pi*frequency*np.sqrt(f.ER)/f.C0
        original = f.reference(frequency, plane_mm=6.)
        for plane in (9., 30.):
            with self.subTest(plane_mm=plane):
                other = f.reference(frequency, plane_mm=plane)
                np.testing.assert_allclose(other, other.transpose(0, 2, 1), atol=1e-13, rtol=0)
                aligned = shift_reference_planes(other, gamma, [(plane-6.)*1e-3]*2)
                np.testing.assert_allclose(aligned, original, atol=1e-13, rtol=0)
                # An independent modal scattering connection checks every
                # matrix entry; reciprocity alone would not certify a value.
                np.testing.assert_allclose(other, scattering_reference(frequency, plane),
                                           atol=4e-12, rtol=0)

    def test_through_reference_matches_an_independent_matched_line(self):
        frequency = np.linspace(1e9, 3e9, 101)
        for plane in (6., 9., 30.):
            length_m = (f.dimensions()['junctions_mm'][-1]+2*plane)*1e-3
            expected = network_s(frequency, [0, 1],
                [(0, 1, f.Z0, length_m*np.sqrt(f.ER)/f.C0)], z_ref=f.Z0)
            np.testing.assert_allclose(f.reference(frequency, kind='through', plane_mm=plane),
                                       expected, atol=1e-13, rtol=0)


    def test_full_wave_matrix_with_cross_incident_waves(self):
        target = f.reference(); a = np.broadcast_to(np.array([[1., .2j], [.1, .9]]), target.shape)
        b = target@a
        v = (np.sqrt(f.Z0)*(a+b)).transpose(2, 1, 0)
        i = ((a-b)/np.sqrt(f.Z0)).transpose(2, 1, 0)
        np.testing.assert_allclose(f.scattering(v, i), target, atol=3e-14)
        with self.assertRaises(ValueError): f.scattering(v[[0, 0]], i[[0, 0]])

    def test_two_contours_and_spatial_stagger_are_independent_checks(self):
        target = f.reference(); a = np.broadcast_to(np.eye(2), target.shape); b = target@a
        v = (np.sqrt(f.Z0)*(a+b)).transpose(2, 1, 0)
        i = ((a-b)/np.sqrt(f.Z0)).transpose(2, 1, 0); phase = .04
        vv = np.stack((v*np.exp(1j*phase), v, v*np.exp(-1j*phase)), axis=2)
        ii = np.broadcast_to(i[:, :, None, None, :]*np.cos(phase/2), (2, 2, 2, 2, len(f.FREQUENCIES))).copy()
        actual, qa = f.extract(vv, ii); np.testing.assert_allclose(actual, target, atol=3e-14)
        self.assertLess(qa['contour_s_abs'], 1e-13)
        ii[:, :, 1] *= 1.03
        self.assertGreater(f.extract(vv, ii)[1]['contour_s_abs'], f.LIMITS['contour_s_abs'])

    def test_cap_admission_is_explicit_and_never_repairs_other_failures(self):
        meta = dict(native=dict(timesteps=10, numerical_time_s=1.), max_timesteps=10, cap_s=1.)
        q = dict(source=True, clock=True, tail=True, stopping=False)
        self.assertFalse(f.admissible(meta, q)); self.assertTrue(f.admissible(meta, q, True))
        for key in ('source', 'clock', 'tail'):
            self.assertFalse(f.admissible(meta, dict(q, **{key: False}), True))
        bad = deepcopy(meta); bad['native']['timesteps'] = 9
        self.assertFalse(f.admissible(bad, q, True)); self.assertFalse(q['stopping'])

    def test_perfect_capped_matrix_still_cannot_be_qualified(self):
        target = f.reference(); a = np.broadcast_to(np.eye(2), target.shape)
        v = (np.sqrt(f.Z0)*(a+target)).transpose(2, 1, 0)
        current = ((a-target)/np.sqrt(f.Z0)).transpose(2, 1, 0); phase = .04
        vv = np.stack((v*np.exp(1j*phase), v, v*np.exp(-1j*phase)), axis=2)
        ii = np.broadcast_to(current[:, :, None, None, :]*np.cos(phase/2), (2, 2, 2, 2, len(f.FREQUENCIES)))
        def source(path, allow_cap):
            self.assertTrue(allow_cap); port = int(path.name[-1])
            meta = dict(n=1, kind='filter', loss='pec', control='ordinary', cap_s=8e-9,
                mesh_mm={}, plane_mm=6., excited_port=port)
            return meta, dict(v=vv[port-1], i=ii[port-1]), dict(source=True, stopping=False)
        with tempfile.TemporaryDirectory() as tmp, patch.object(f, 'read', side_effect=source):
            _, result = f.matrix(tmp, True)
            self.assertTrue(result['point_target_passes']); self.assertTrue(result['measurement_passes'])
            self.assertFalse(result['native_complete']); self.assertFalse(result['qualified'])
            self.assertFalse((Path(tmp)/'matrix.npz').exists())
            path = Path(tmp)/'cap-diagnostic-comparison.json'
            changed = json.loads(path.read_text()); changed['qualified'] = True; f.save(path, changed)
            with self.assertRaises(ValueError): f.matrix(tmp, True)

    def test_electric_and_half_step_magnetic_clocks(self):
        dt = 1e-13; stride = int(1/(2*f.FREQUENCIES[-1]*dt))//f.OVERSAMPLING
        meta = dict(native=dict(dt_s=dt, numerical_time_s=3*stride*dt))
        e = np.column_stack((np.arange(4)*stride*dt, np.ones(4)))
        h = e+np.array([dt/2, 0.]); f.trace_clock(e, meta); f.trace_clock(h, meta, True)
        with self.assertRaises(ValueError): f.trace_clock(h, meta)
        with self.assertRaises(ValueError): f.trace_clock(e[:-1], meta)

    def test_long_forecast_refused_before_launch_or_output(self):
        with tempfile.TemporaryDirectory() as tmp, patch(__name__+'.popen_group') as launch:
            out = Path(tmp)/'absent'
            with self.assertRaises(ValueError): acquire(out, rate=.01)
            self.assertFalse(out.exists()); launch.assert_not_called()
        for rate in (0., -1., np.nan):
            with self.assertRaises(ValueError): forecast(dict(native_cells=1, max_timesteps=1), rate)

    def test_pilot_is_bounded_before_launch(self):
        with tempfile.TemporaryDirectory() as tmp, patch(__name__+'.popen_group') as launch:
            for cap in (0., 1e-9, np.nan):
                with self.assertRaises(ValueError): acquire(Path(tmp)/'absent', pilot_s=cap)
            launch.assert_not_called()

    def test_failed_worker_leaves_receipt_and_no_active_pid(self):
        proc = Mock(pid=123, win_job=None); proc.poll.return_value = 2
        with tempfile.TemporaryDirectory() as tmp, patch(__name__+'.popen_group', return_value=proc), \
                patch(__name__+'.wait_owned', return_value=2), patch(__name__+'.release_group'):
            out = Path(tmp)/'failed'
            with self.assertRaises(RuntimeError): acquire(out, rate=1000.)
            self.assertIsNone(json.loads((out/'progress.json').read_text())['active_launcher_pid'])
            self.assertEqual(json.loads((out/'port1.worker.json').read_text())['exit_code'], 2)

    def test_missing_mesh_and_controls_cannot_qualify(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = study(tmp); self.assertFalse(result['qualified'])
            self.assertEqual(len(result['missing']), 13)

def main():
    p = argparse.ArgumentParser(description=__doc__); mode = p.add_mutually_exclusive_group(required=True)
    for name in ('preflight', 'fdtd', 'compare', 'study', 'worker'): mode.add_argument('--'+name, action='store_true')
    p.add_argument('--out', type=Path, required=True); p.add_argument('--mesh', type=int, choices=f.MESHES, default=1)
    p.add_argument('--kind', choices=f.KINDS, default='filter'); p.add_argument('--loss', choices=f.LOSSES, default='pec')
    p.add_argument('--control', choices=f.CONTROLS, default='ordinary'); p.add_argument('--port', type=int, choices=(1, 2), default=1)
    p.add_argument('--rate-mcps', type=float, default=15.); p.add_argument('--pilot-seconds', type=float)
    p.add_argument('--allow-capped-diagnostic', action='store_true')
    args = p.parse_args()
    if args.allow_capped_diagnostic and not (args.fdtd or args.compare): p.error('capped diagnostics are separate from strict study')
    if args.worker:
        f.capture(args.out, args.mesh, args.port, args.kind, args.loss, args.control, args.pilot_seconds); return
    if args.preflight: result = preflight(args.out, args.rate_mcps)
    elif args.fdtd: result = acquire(args.out, args.mesh, args.kind, args.loss, args.control, args.rate_mcps, args.pilot_seconds, args.allow_capped_diagnostic)
    elif args.compare: result = f.matrix(args.out, args.allow_capped_diagnostic)[1]
    else: result = study(args.out)
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == '__main__':
    if any('--'+s in sys.argv for s in ('preflight', 'fdtd', 'compare', 'study', 'worker')): main()
    else: unittest.main()
