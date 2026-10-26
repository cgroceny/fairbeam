"""Independent band/radiation optimizer controls on synthetic data; no solver runs."""
import contextlib
import copy
import io
import json
import math
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fairbeam.optimize import (PENALTY, Vary, band_metric, bundle_metrics, goal_cost,
                               make_goal, parse_goal, radiation_metric, run_optimization,
                               sampled_band, total_cost)


def bundle(db=(-20., -5., -20.)):
    """Synthetic three-point S11 with a violation hidden between passing edges."""
    # Independently construct a physical identity at the exact middle sample:
    # G_realized = D * (Prad / Pacc) * (1 - |S11|^2). Gain is deliberately 4 dBi.
    directivity = round(4 - 10*math.log10(.8*(1-10**(db[1]/10))), 3)
    return {
        'ports': [{'number': 1, 'excite': True}],
        'solver': {'end_criteria_db': -60.},
        'run': {'converged': True, 'hit_timestep_limit': False},
        'results': {'frequency': [2e9, 2.5e9, 3e9], 'bands': [],
                    'ports': {'1': {'s11_re': [10**(v/20) for v in db], 's11_im': [0., 0., 0.],
                                    'zin_re': [50., 50., 50.], 'zin_im': [-1., 0., 1.], 'z_ref': 50.}},
                    'farfield': [{'f': 2.5e9, 'pacc_w': 1., 'prad_w': .8,
                                  'rad_efficiency': .8, 'realized_gain_dbi': 4.,
                                  'dmax_dbi': directivity}]}}


def network():
    b = bundle((-20., -20., -20.))
    b['ports'].append({'number': 2, 'excite': False})
    b['results']['sparams'] = {'ports': [1, 2], 'excited': [1, 2], 's': {
        '1,1': {'re': [.1, .1, .1], 'im': [0., 0., 0.]},
        '2,2': {'re': [.1, .1, .1], 'im': [0., 0., 0.]},
        '1,2': {'re': [.5, .5, .5], 'im': [0., 0., 0.]},
        '2,1': {'re': [.5, .5, .5], 'im': [0., 0., 0.]}}}
    return b


class BandGoals(unittest.TestCase):
    def test_cli_round_trip_range_pair_weight_and_point_compatibility(self):
        g = parse_goal('sij_min=-3.2@2.40..2.48:2,1*2')
        self.assertEqual((g.kind, g.at, g.at_hi, g.ports, g.weight),
                         ('sij_min', 2.4, 2.48, (2, 1), 2.))
        self.assertIn('2.4..2.48 GHz', g.label())
        self.assertIsNone(parse_goal('s11_max=-20@2.4').at_hi)
        for text in ('s11_max=-20@2.5..2.4', 's11_max=-20@2.4..2.4',
                     's11_max=-20@2.4..1e309', 'dmax_min=3@2.4..2.5',
                     'realized_gain_min=3@2.4..2.5', 'efficiency_min=90@2.4..2.5'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_goal(text)

    def test_internal_violation_is_not_hidden_by_passing_edges(self):
        g = parse_goal('s11_max=-10@2..3')
        m = bundle_metrics(bundle(), [g])
        c, met, worst = goal_cost(g, m)
        self.assertFalse(met)
        self.assertAlmostEqual(worst, -5.)
        self.assertAlmostEqual(c, (5/3)**2)
        self.assertEqual(len(m['band_goals'][g.metric_key()]['values']), 3)

    def test_edges_interpolate_and_outside_band_never_clamps(self):
        g = parse_goal('s11_max=-10@2.25..2.75')
        m = band_metric(bundle(), g)
        np.testing.assert_allclose(m['values'], [-12.5, -5, -12.5], atol=1e-12)
        for lo, hi in ((1.9, 2.5), (2.5, 3.1)):
            self.assertIsNone(band_metric(bundle(), make_goal('s11_max', -10, lo, at_hi=hi))['values'])

    def test_band_requires_ordered_grid_and_finite_bracketing_samples(self):
        for frequencies in ([2, 2, 3], [3, 2.5, 2], [2, float('nan'), 3], [2]):
            with self.subTest(frequencies=frequencies):
                self.assertIsNone(sampled_band(frequencies, [-20]*len(frequencies), 2.1, 2.9))
        for bad in (float('nan'), float('inf'), -float('inf')):
            self.assertIsNone(sampled_band([2, 2.5, 3], [-20, bad, -20], 2.1, 2.9))
        # Irrelevant samples outside both interpolation brackets do not poison this band.
        self.assertEqual(sampled_band([1, 2, 3, 4], [float('nan'), -20, -10, float('nan')], 2, 3), [-20, -10])

    def test_transmission_uses_worst_minimum_and_interpolated_magnitude(self):
        b = network()
        b['results']['sparams']['s']['2,1']['re'] = [.8, .2, .8]
        g = parse_goal('sij_min=-6@2.25..2.75:2,1')
        metric = band_metric(b, g)
        np.testing.assert_allclose(metric['values'], 20*np.log10([.5, .2, .5]), atol=1e-12)
        c, met, worst = goal_cost(g, {'band_goals': {g.metric_key(): metric}})
        self.assertFalse(met)
        self.assertAlmostEqual(worst, 20*math.log10(.2))
        self.assertAlmostEqual(c, ((-6-worst)/.5)**2)

    def test_match_all_requires_every_diagonal_and_checks_every_frequency(self):
        b = network()
        g = parse_goal('match_all=-10@2..3')
        b['results']['sparams']['s']['2,2']['re'][1] = .6
        m = band_metric(b, g)
        self.assertEqual(len(m['sources']), 2)
        self.assertFalse(goal_cost(g, {'band_goals': {g.metric_key(): m}})[1])
        del b['results']['sparams']['s']['2,2']
        self.assertIsNone(band_metric(b, g)['values'])

    def test_reciprocity_is_explicit_and_does_not_patch_partial_corruption(self):
        b = network()
        g = parse_goal('sij_max=-3@2..3:2,1')
        del b['results']['sparams']['s']['2,1']
        m = band_metric(b, g)
        self.assertTrue(m['sources'][0]['reciprocal'])
        self.assertTrue(goal_cost(g, {'band_goals': {g.metric_key(): m}})[1])
        b['results']['sparams']['s']['2,1'] = {'re': [.5, None, .5], 'im': [0., 0., 0.]}
        self.assertIsNone(band_metric(b, g)['values'])
        b['results']['sparams']['s']['2,1']['re'][1] = float('inf')
        self.assertIsNone(band_metric(b, g)['values'])
        b['results']['sparams']['s']['2,1'] = {'re': [float('nan')]*3, 'im': [float('nan')]*3}
        self.assertIsNone(band_metric(b, g)['values'])
        self.assertIsNone(band_metric(b, parse_goal('sij_max=-3@2..3:3,1'))['values'])

    def test_incomplete_band_has_explicit_unavailable_cost_without_point_fallback(self):
        b = network()
        g = parse_goal('sij_max=-3@2..3:2,1')
        b['results']['sparams']['s']['2,1'] = {'re': [.5, None, .5], 'im': [0., 0., 0.]}
        m = bundle_metrics(b, [g])
        self.assertIsNone(m['band_goals'][g.metric_key()]['values'])
        cost, parts, met = total_cost([g], m)
        self.assertGreaterEqual(cost, PENALTY)
        self.assertFalse(met)
        self.assertIsNone(parts[0]['value'])

    def test_sparse_physical_port_numbers_distinguish_missing_and_corrupt_columns(self):
        b = network()
        b['ports'] = [{'number': 2, 'excite': True}, {'number': 4, 'excite': False}]
        b['results']['ports'] = {'2': b['results']['ports']['1']}
        b['results']['sparams']['port_numbers'] = [2, 4]
        g = make_goal('sij_max', -3, 2, ports=(4, 2), at_hi=3)
        # Serialized section indices 1,2 represent physical port numbers 2,4.
        del b['results']['sparams']['s']['2,1']
        self.assertTrue(band_metric(b, g)['sources'][0]['reciprocal'])
        b['results']['sparams']['s']['2,1'] = {'re': [float('nan')]*3, 'im': [float('nan')]*3}
        self.assertIsNone(band_metric(b, g)['values'])

    def test_weight_and_band_identity_are_retained(self):
        a = parse_goal('s11_max=-10@2..3*2')
        b = parse_goal('s11_max=-10@2..2.25')
        m = bundle_metrics(bundle(), [a, b])
        cost, parts, met = total_cost([a, b], m)
        self.assertAlmostEqual(cost, 2*(5/3)**2, places=6)
        self.assertEqual([part['met'] for part in parts], [False, True])
        self.assertFalse(met)

    def test_display_rounding_cannot_merge_distinct_frequency_requests(self):
        a = make_goal('s11_max', -10, 2.00000011, at_hi=2.25)
        b = make_goal('s11_max', -10, 2.00000012, at_hi=2.25)
        self.assertEqual(a.label(), b.label())  # Cosmetic display rounds this pair.
        self.assertNotEqual(a.metric_key(), b.metric_key())
        m = bundle_metrics(bundle(), [a, b])
        self.assertEqual(len(m['band_goals']), 2)
        self.assertNotEqual(m['band_goals'][a.metric_key()]['values'][0],
                            m['band_goals'][b.metric_key()]['values'][0])
        # Target/weight affect cost, not the sampled quantity's identity.
        c = make_goal('s11_max', -12, a.at, at_hi=a.at_hi, weight=3)
        self.assertEqual(a.metric_key(), c.metric_key())


class RadiationGoals(unittest.TestCase):
    def test_exact_field_admission_and_percent_cost(self):
        for kind, target, value, scale in (('realized_gain_min', 5, 4, .5), ('efficiency_min', 90, 80, 5)):
            g = make_goal(kind, target, 2.5)
            m = bundle_metrics(bundle(), [g])
            detail = m['radiation_goals'][g.metric_key()]
            self.assertEqual(detail['frequency_hz'], 2.5e9)
            c, met, actual = goal_cost(g, m)
            self.assertEqual(actual, value)
            self.assertEqual(c, ((target-value)/scale)**2)
            self.assertFalse(met)

    def test_no_nearest_frequency_or_duplicate_frequency_substitution(self):
        g = make_goal('realized_gain_min', 3, 2.5)
        b = bundle()
        b['results']['farfield'][0]['f'] = 2.49e9
        self.assertIsNone(radiation_metric(b, g)['value'])
        b = bundle()
        b['results']['farfield'].append(copy.deepcopy(b['results']['farfield'][0]))
        self.assertIsNone(radiation_metric(b, g)['value'])

    def test_field_from_another_driven_port_cannot_substitute(self):
        g = make_goal('realized_gain_min', 3, 2.5)
        b = bundle()
        b['ports'].append({'number': 2, 'excite': False})
        primary = b['results']['farfield'][0]
        primary['port'] = 1
        other = {**primary, 'port': 2, 'realized_gain_dbi': 20.}
        b['results']['farfield'] = [other, primary]
        detail = radiation_metric(b, g)
        self.assertEqual(detail['port'], 1)
        self.assertEqual(detail['value'], 4.)
        b['results']['farfield'] = [other]
        self.assertIsNone(radiation_metric(b, g)['value'])

    def test_power_convergence_and_sampling_omissions_cannot_meet_goal(self):
        g = make_goal('efficiency_min', 50, 2.5)
        mutations = [
            ('unconverged', lambda b: b['run'].update(converged=False)),
            ('cap', lambda b: b['run'].update(hit_timestep_limit=True)),
            ('one bad port', lambda b: b['run'].update(port_runs=[{'converged': True}, {'converged': False}])),
            ('shallow stop', lambda b: b['solver'].update(end_criteria_db=-40)),
            ('unknown stop', lambda b: b['solver'].pop('end_criteria_db')),
            ('missing power', lambda b: b['results']['farfield'][0].pop('pacc_w')),
            ('negative power', lambda b: b['results']['farfield'][0].update(prad_w=-.1)),
            ('nonphysical power', lambda b: b['results']['farfield'][0].update(prad_w=1.01)),
            ('invalid efficiency', lambda b: b['results']['farfield'][0].update(rad_efficiency=1.01)),
            ('missing efficiency', lambda b: b['results']['farfield'][0].update(rad_efficiency=None)),
            ('nonfinite power', lambda b: b['results']['farfield'][0].update(prad_w=float('nan'))),
            ('unqualified field', lambda b: b['results']['farfield'][0].update(qa_warnings=['tail not settled'])),
        ]
        for name, alter in mutations:
            with self.subTest(name=name):
                b = bundle()
                alter(b)
                detail = radiation_metric(b, g)
                self.assertIsNone(detail['value'])
                c, met, value = goal_cost(g, {'radiation_goals': {g.metric_key(): detail}})
                self.assertGreaterEqual(c, PENALTY)
                self.assertFalse(met)
                self.assertIsNone(value)

    def test_boolean_fields_and_inconsistent_power_are_not_measurements(self):
        g = make_goal('efficiency_min', 50, 2.5)
        for field in ('rad_efficiency', 'pacc_w', 'prad_w'):
            with self.subTest(field=field):
                b = bundle()
                b['results']['farfield'][0][field] = True
                self.assertIsNone(radiation_metric(b, g)['value'])
        b = bundle()
        b['results']['farfield'][0]['rad_efficiency'] = .95
        self.assertIsNone(radiation_metric(b, g)['value'])

    def test_nonfinite_gain_and_efficiency_targets_are_refused(self):
        for target in (0, -1, 100.1, float('nan'), float('inf')):
            with self.subTest(target=target), self.assertRaises(ValueError):
                make_goal('efficiency_min', target, 2.5)
        g = make_goal('realized_gain_min', 3, 2.5)
        for value in (None, float('nan'), float('inf')):
            b = bundle()
            b['results']['farfield'][0]['realized_gain_dbi'] = value
            self.assertIsNone(radiation_metric(b, g)['value'])

    def test_gain_must_obey_directivity_power_and_mismatch_identity(self):
        g = make_goal('realized_gain_min', 3, 2.5)
        b = bundle()
        self.assertEqual(radiation_metric(b, g)['value'], 4.)
        b['results']['farfield'][0]['realized_gain_dbi'] = 4.1
        self.assertIsNone(radiation_metric(b, g)['value'])
        b = bundle()
        b['results']['ports']['1']['s11_re'][1] = 1.01
        self.assertIsNone(radiation_metric(b, g)['value'])

    def test_efficiency_requires_a_valid_grid_containing_requested_frequency(self):
        g = make_goal('efficiency_min', 70, 2.5)
        for grid in ([2e9, 2.1e9, 2.2e9], [3e9, 2.5e9, 2e9],
                     [2e9, 2e9, 3e9], [2e9, float('nan'), 3e9], []):
            with self.subTest(grid=grid):
                b = bundle()
                b['results']['frequency'] = grid
                self.assertIsNone(radiation_metric(b, g)['value'])


class Pipeline(unittest.TestCase):
    def run_fake(self, goals, *, end_db=-60, model_end=-60, converged=True):
        from fairbeam.model import Param
        calls = []
        class FakeSim:
            f_min, f_max = 2e9, 3e9
            end_criteria_db = model_end
            ports = [{'number': 1}]
            efficiency_points = 0
            nf2ff = object()
            removed = False
            def __init__(self):
                self.fdtd = SimpleNamespace(SetEndCriteria=Mock())
            def remove_nf2ff_box(self):
                self.removed = True
                self.nf2ff = None
                return True
            def to_bundle(self, *args, **kwargs):
                b = bundle((-20., -20., -20.))
                b['run']['converged'] = converged
                b['solver']['end_criteria_db'] = self.end_criteria_db
                return b
        module = SimpleNamespace(MODEL={'id': 'control', 'name': 'Synthetic'},
            PARAMS=[Param('x', 1., 'x', minimum=0, maximum=2)], build=lambda _: FakeSim())
        def run_model(_module, _values, **kwargs):
            sim = FakeSim()
            if kwargs['end_db'] is not None:
                sim.end_criteria_db = kwargs['end_db']
            kwargs['before_run'](sim)
            calls.append({**kwargs, 'removed_nf2ff': sim.removed,
                          'effective_end_db': sim.end_criteria_db,
                          'fdtd_end_ratios': [c.args[0] for c in sim.fdtd.SetEndCriteria.call_args_list]})
            return sim
        with tempfile.TemporaryDirectory() as folder, patch('fairbeam.model.load_model', return_value=module), \
                patch('fairbeam.multiport.run_model', side_effect=run_model), contextlib.redirect_stdout(io.StringIO()):
            doc = run_optimization('synthetic.py', [Vary('x', 0, 2)], goals, out=Path(folder)/'out',
                sim_root=Path(folder)/'raw', max_evals=1, end_db=end_db, keep_sim=True, log=lambda *args: None)
            stored = json.loads(Path(doc['_path']).read_text(encoding='utf-8'))
        return doc, stored, calls

    def test_exact_radiation_frequencies_preserve_nf2ff_and_history(self):
        goals = [make_goal('realized_gain_min', 3, 2.5), make_goal('efficiency_min', 70, 2.5),
                 parse_goal('s11_max=-10@2.2..2.8')]
        doc, stored, calls = self.run_fake(goals)
        self.assertEqual(calls[0]['pattern_freqs'], [2.5e9])
        self.assertFalse(calls[0]['removed_nf2ff'])
        self.assertEqual(stored['goals'][2]['at_hi'], 2.8)
        self.assertEqual(stored['goals'][2]['at'], 2.2)
        self.assertTrue(doc['best']['met'])

    def test_unconverged_candidate_cannot_be_best_despite_matching_fields(self):
        doc, _, calls = self.run_fake([make_goal('realized_gain_min', 3, 2.5)], converged=False)
        self.assertEqual(len(calls), 1)
        self.assertIsNone(doc['best'])
        self.assertIn('convergence', doc['evaluations'][0]['error'])
        self.assertGreaterEqual(doc['evaluations'][0]['cost'], PENALTY)

    def test_band_only_avoids_farfield_and_preserves_upper_bound(self):
        _, stored, calls = self.run_fake([parse_goal('s11_max=-10@2.2..2.8')])
        self.assertIsNone(calls[0]['pattern_freqs'])
        self.assertTrue(calls[0]['removed_nf2ff'])
        self.assertEqual(stored['goals'][0]['at_hi'], 2.8)

    def test_outside_band_is_refused_before_dispatch(self):
        with self.assertRaises(ValueError):
            self.run_fake([parse_goal('s11_max=-10@2.5..3.1')])

    def test_shallow_radiation_request_is_refused_before_dispatch(self):
        with self.assertRaises(ValueError):
            self.run_fake([make_goal('efficiency_min', 80, 2.5)], end_db=-40)
        _, _, calls = self.run_fake([make_goal('efficiency_min', 80, 2.5)], end_db=None, model_end=-40)
        self.assertEqual(calls[0]['effective_end_db'], -60)
        self.assertEqual(calls[0]['fdtd_end_ratios'], [1e-6])

    def test_default_radiation_stop_preserves_stricter_model_criterion(self):
        _, _, calls = self.run_fake([make_goal('efficiency_min', 80, 2.5)], end_db=None, model_end=-90)
        self.assertEqual(calls[0]['effective_end_db'], -90)
        self.assertEqual(calls[0]['fdtd_end_ratios'], [1e-9])


class ApiAndJobs(unittest.TestCase):
    def test_invalid_goal_numerics_and_shallow_radiation_stop_cannot_enqueue(self):
        from fairbeam.server import ApiError, App
        app = App.__new__(App)
        submit = Mock(side_effect=AssertionError('invalid goals must not be queued'))
        app.manager, app.projects_dir = SimpleNamespace(submit=submit), Path('unused')
        model = {'key': 'synthetic', 'path': 'synthetic.py', 'model': {'id': 'synthetic'},
                 'params': [{'key': 'x', 'type': 'float', 'minimum': 0, 'maximum': 2}]}
        settings = {'threads': 1, 'engine': 'cpu', 'end_criteria_db': -60, 'name': 'check', 'label': 'Synthetic'}
        invalid = [
            {'kind': 'efficiency_min', 'target': True, 'at': 2.5},
            {'kind': 'efficiency_min', 'target': 80, 'at': True},
            {'kind': 's11_max', 'target': -10, 'at': .5, 'at_hi': True},
            {'kind': 's11_max', 'target': -10, 'at': 2.5, 'weight': True},
            {'kind': 's11_max', 'target': -10, 'at': 2.5, 'weight': 0},
        ]
        with patch.object(app, '_validated', return_value=(model, {'x': 1.}, {})), \
                patch.object(app, '_refuse_broken_design'), patch.object(app, '_settings', return_value=settings), \
                patch.object(app, '_refuse_by_preflight'):
            for goal in invalid:
                with self.subTest(goal=goal), self.assertRaises(ApiError) as caught:
                    app.submit_optimization({'vary': [{'key': 'x', 'min': 0, 'max': 2}],
                                             'goals': [goal], 'max_evals': 1})
                self.assertEqual(caught.exception.status, 422)
            settings['end_criteria_db'] = -40
            with self.assertRaises(ApiError) as caught:
                app.submit_optimization({'vary': [{'key': 'x', 'min': 0, 'max': 2}],
                    'goals': [{'kind': 'efficiency_min', 'target': 80, 'at': 2.5}], 'max_evals': 1})
            self.assertEqual(caught.exception.status, 422)
        submit.assert_not_called()

    def test_api_job_command_and_history_preserve_range_and_radiation_goal(self):
        from fairbeam.jobs import JobManager
        from fairbeam.server import App
        from fairbeam import cli
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manager = JobManager(root/'jobs', root/'projects', python='/python', autostart=False)
            self.addCleanup(manager.shutdown)
            app = App.__new__(App)
            app.manager, app.projects_dir = manager, root/'projects'
            model = {'key': 'synthetic', 'path': str(root/'model.py'), 'model': {'id': 'synthetic'},
                     'params': [{'key': 'x', 'type': 'float', 'minimum': 0, 'maximum': 2}]}
            settings = {'threads': 1, 'engine': 'cpu', 'end_criteria_db': -60, 'name': 'check', 'label': 'Synthetic'}
            with patch.object(app, '_validated', return_value=(model, {'x': 1.}, {})), \
                    patch.object(app, '_refuse_broken_design'), patch.object(app, '_settings', return_value=settings), \
                    patch.object(app, '_refuse_by_preflight'):
                record = app.submit_optimization({'vary': [{'key': 'x', 'min': 0, 'max': 2}], 'goals': [
                    {'kind': 'sij_max', 'target': -10, 'at': 2.2, 'at_hi': 2.8, 'ports': [2, 1], 'weight': 2},
                    {'kind': 'efficiency_min', 'target': 80, 'at': 2.5}], 'max_evals': 1})
            job = manager.get(record['id'])
            self.assertEqual(job.optimize['goals'][0]['at_hi'], 2.8)
            command = manager.default_command(job)
            seen = []
            with patch('fairbeam.optimize.run_optimization', side_effect=lambda _path, _vary, goals, **kwargs:
                       seen.append(goals) or {'best': None, 'evaluations': [], '_path': 'synthetic'}), \
                    contextlib.redirect_stdout(io.StringIO()):
                cli.main(command[3:])
            self.assertEqual(seen[0][0].at_hi, 2.8)
            self.assertEqual(seen[0][0].ports, (2, 1))
            self.assertEqual(seen[0][0].weight, 2)
            self.assertEqual(seen[0][1].kind, 'efficiency_min')
            saved = json.loads((job.dir/'job.json').read_text(encoding='utf-8'))
            self.assertEqual(saved['optimize']['goals'], job.optimize['goals'])


if __name__ == '__main__':
    unittest.main()
