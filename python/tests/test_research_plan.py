"""Preparation must be honest about capabilities and preserve immutable exports."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from fairbeam.research_plan import floquet_plan, export_floquet_plan, export_fem_mesh


class ResearchPlanTests(unittest.TestCase):
    def settings(self):
        return dict(period_x_mm=6, period_y_mm=6, reference_frequency_ghz=10,
                    theta_deg=30, phi_deg=0, frequencies_ghz=[4, 8, 10], order_radius=1)

    def test_fixed_kt_distinguishes_evanescent_band_and_angle(self):
        result = floquet_plan(**self.settings())
        self.assertFalse(result['solver_executed'])
        self.assertFalse(result['native_execution_supported'])
        low, middle, high = result['samples']
        self.assertEqual(low['incident_classification'], 'evanescent')
        self.assertIsNone(low['incident_angle_deg'])
        self.assertGreater(middle['incident_angle_deg'], high['incident_angle_deg'])
        self.assertAlmostEqual(high['incident_angle_deg'], 30)
        self.assertEqual(len(high['orders']), 9)
        json.dumps(result, allow_nan=False)

    def test_invalid_requests_do_not_create_output(self):
        for change in ({'theta_deg':90},{'frequencies_ghz':[10,8]}, {'order_radius':True},
                       {'period_x_mm':float('nan')}, {'frequencies_ghz':[True]},
                       {'period_x_mm':10**1000}, {'frequencies_ghz':[10**1000]}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as d:
                out=Path(d)/'case'
                with self.assertRaises(ValueError): export_floquet_plan(out, **(self.settings()|change))
                self.assertFalse(out.exists())

    def test_fresh_plan_has_source_and_output_hashes(self):
        with tempfile.TemporaryDirectory() as d:
            out=Path(d)/'case'
            export_floquet_plan(out, **self.settings())
            before=(out/'plan.json').read_bytes()
            manifest=json.loads((out/'manifest.json').read_text())
            self.assertEqual(manifest['plan_sha256'], hashlib.sha256(before).hexdigest())
            self.assertEqual(manifest['source_sha256']['bloch.py'],
                             hashlib.sha256((out/'source/bloch.py').read_bytes()).hexdigest())
            self.assertFalse(manifest['solver_executed'])
            with self.assertRaises(FileExistsError): export_floquet_plan(out, **self.settings())
            self.assertEqual((out/'plan.json').read_bytes(),before)

    def test_vacuum_mesh_preparation_has_no_solver_claim(self):
        with tempfile.TemporaryDirectory() as d:
            out=Path(d)/'mesh'
            value=export_fem_mesh(out,domain_mm=(0,0,0,100,50,200),max_cell_mm=25)
            self.assertFalse(value['solver_executed'])
            self.assertEqual(value['status'],'mesh_exported')
            self.assertTrue((out/'mesh.header').is_file())
            self.assertTrue((out/'mesh.nodes').is_file())
            with self.assertRaises(FileExistsError):
                export_fem_mesh(out,domain_mm=(0,0,0,100,50,200),max_cell_mm=25)
