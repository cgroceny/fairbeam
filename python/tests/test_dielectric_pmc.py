"""Reference and input checks; ordinary unittest performs no FDTD."""
import math
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
import tempfile
from unittest.mock import patch

import numpy as np

from tests import dielectric_pmc_fixture as fixture


class Reference(unittest.TestCase):
    def test_lossless_limit_matches_independent_real_bisection(self):
        actual = fixture.reference(0.)
        self.assertAlmostEqual(actual['f_hz']/fixture.opened.F_REF, 1., places=13)
        self.assertEqual(actual['alpha_s'], 0.)
        self.assertIsNone(actual['q'])

    def test_passive_complex_pole_matches_independent_energy_perturbation(self):
        actual = fixture.reference()
        self.assertGreater(actual['alpha_s'], 0.)
        self.assertLess(actual['root_residual_m_inv'], 1e-8)
        self.assertLess(abs(actual['q']/actual['first_order_q']-1), 2e-7)
        self.assertGreater(actual['analytic_electric_participation'], .99)
        self.assertLess(actual['analytic_electric_participation'], 1.)
        doubled = fixture.reference(2*fixture.SIGMA)
        self.assertLess(abs(2*doubled['q']/actual['q']-1), 1e-6)
        self.assertFalse(actual['open_example_qualified'])

    def test_invalid_conductivity_is_rejected(self):
        for value in (True, -1., float('nan'), float('inf')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                fixture.reference(value)


class Geometry(unittest.TestCase):
    def test_physical_pmc_plane_and_material_survive_mesh_refinement(self):
        previous = 0
        for n in fixture.MESHES:
            sim, meta = fixture.build(n)
            radius = np.asarray(sim.mesh.GetLines('x'))
            self.assertAlmostEqual((radius[-2]+radius[-1])/2, fixture.opened.RADIUS_MM, places=13)
            self.assertGreater(radius[-1], fixture.opened.RADIUS_MM)
            self.assertEqual(len(radius), n+1)
            self.assertGreater(meta['native_cells'], previous)
            previous = meta['native_cells']
            self.assertEqual(meta['declared_dt_s'], fixture.DT_S)
            self.assertEqual(meta['max_timesteps'], math.ceil(fixture.CAP_S/fixture.DT_S))
            self.assertEqual(meta['reference'], fixture.reference())
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory)/'input.xml'
                sim.fdtd.Write2XML(str(path))
                root = ET.parse(path).getroot()
                self.assertAlmostEqual(float(root.find('FDTD').get('endCriteria')), 1e-8)
                bc = root.find('FDTD/BoundaryCond')
                self.assertEqual(bc.get('xmax'), 'PMC')
                self.assertEqual(bc.get('zmin'), 'PML_16')
                self.assertEqual(bc.get('zmax'), 'PML_16')
                material = root.find("ContinuousStructure/Properties/Material[@Name='resonator']")
                self.assertEqual(material.get('Isotropy'), '1')
                properties = material.find('Property')
                self.assertEqual(float(properties.get('Epsilon').split(',')[0]), fixture.opened.ER)
                self.assertAlmostEqual(float(properties.get('Kappa').split(',')[0]), fixture.SIGMA, places=7)
            self.assertFalse(meta['open_example_qualified'])

    def test_invalid_mesh_and_caps_are_rejected(self):
        for n in (True, 0, 10, 16.):
            with self.subTest(n=n), self.assertRaises(ValueError):
                fixture.build(n)
        for cap in (0, 89e-9, float('nan'), 6e-6):
            with self.subTest(cap=cap), self.assertRaises(ValueError):
                fixture.build(8, cap)


class Measurements(unittest.TestCase):
    def test_free_late_field_poles_recover_signed_analytic_decay(self):
        reference = fixture.reference()
        t = np.arange(0., 600e-9, 40e-12)
        envelope = np.exp(-reference['alpha_s']*t)
        phase = 2*np.pi*reference['f_hz']*t
        signal = np.array([envelope*np.sin(phase), .7*envelope*np.sin(phase+.3)])
        actual = fixture.extract(t, signal)
        self.assertTrue(actual['field_stable'], actual)
        self.assertEqual(len(actual['poles']), 6)
        self.assertLess(abs(actual['f_hz']/reference['f_hz']-1), 1e-7)
        self.assertLess(abs(actual['q']/reference['q']-1), 1e-5)
        short = t < 400e-9
        incomplete = fixture.extract(t[short], signal[:, short])
        self.assertFalse(incomplete['field_stable'])
        self.assertTrue(any('incomplete' in error for error in incomplete['errors']))

    def test_two_in_band_poles_are_rejected_without_target_selection(self):
        t = np.arange(0., 600e-9, 40e-12)
        y = np.exp(-1e7*t)*(np.sin(2*np.pi*3.1e9*t)+.6*np.sin(2*np.pi*3.5e9*t))
        actual = fixture.extract(t, np.array([y, y]))
        self.assertFalse(actual['field_stable'])
        self.assertTrue(any('unambiguous' in error for error in actual['errors']))

    def test_cached_energy_clock_coalesces_only_identical_repeated_samples(self):
        ref = fixture.reference()
        interval = int(1/(2*fixture.opened.F_BAND[1]*fixture.DT_S))
        ticks = np.arange(0, 6000)
        steps = ticks*interval
        t = steps*fixture.DT_S
        energy = np.exp(-2*ref['alpha_s']*t)*(1+.2*np.cos(4*np.pi*ref['f_hz']*t))
        rows = np.column_stack((ticks, steps, ticks, energy))
        rows = np.insert(rows, 2000, rows[1999], axis=0)
        actual = fixture.energy_proxy(rows, fixture.DT_S, ref['f_hz'], ref['q'])
        self.assertTrue(actual['passed'], actual)
        self.assertEqual(actual['identical_repeat_count'], 1)
        self.assertLess(actual['q_difference_rel'], 1e-6)
        rows[2000, 3] *= .99
        with self.assertRaisesRegex(ValueError, 'same cache tick'):
            fixture.energy_proxy(rows, fixture.DT_S, ref['f_hz'], ref['q'])

    def test_overbudget_and_existing_paths_never_launch_workers(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(fixture, 'run_owned') as launch:
            with self.assertRaisesRegex(ValueError, 'defer'):
                fixture.acquire_serial(Path(temp)/'absent', 16, .001)
            self.assertFalse((Path(temp)/'absent').exists())
            with self.assertRaisesRegex(ValueError, 'fresh capture'):
                fixture.acquire_serial(Path(temp), 8, 100.)
            launch.assert_not_called()

    def test_mesh_pass_does_not_qualify_open_example_or_failed_reference(self):
        rows = [dict(f_hz=f, q=q, completed_pole_control=True,
                     f_reference_rel=.0001, q_reference_rel=.0001)
                for f, q in ((3.15e9, 1000.), (3.151e9, 1001.), (3.1512e9, 1001.2))]
        with patch.object(fixture, 'analyse', side_effect=rows):
            actual = fixture.study(Path('not-read'))
        self.assertTrue(actual['pmc_mesh_and_reference_pass'])
        self.assertFalse(actual['qualified'])
        self.assertFalse(actual['open_example_qualified'])
        rows[-1]['q_reference_rel'] = .03
        with patch.object(fixture, 'analyse', side_effect=rows):
            self.assertFalse(fixture.study(Path('not-read'))['pmc_mesh_and_reference_pass'])


if __name__ == '__main__':
    unittest.main()
