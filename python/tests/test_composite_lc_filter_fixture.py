"""Pure reference/geometry controls; no native propagation during discovery."""
import tempfile
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET
import numpy as np
from tests import composite_lc_filter_fixture as f


class CompositeReferenceTests(unittest.TestCase):
    def test_independent_graph_and_image_sections(self):
        freq=f.FREQUENCIES[abs(f.FREQUENCIES-f.F_ZERO)>1.]
        expected,_=f.independent_abcd(freq)
        np.testing.assert_allclose(f.reference(freq),expected,rtol=0,atol=5e-13)

    def test_positive_elements_and_fixed_pole(self):
        values=f.elements();self.assertEqual(len(values),13)
        self.assertEqual(sum(e['kind']=='L' for e in values),9)
        self.assertTrue(all(e['value_si']>0 for e in values))
        by_name={e['name']:e['value_si'] for e in values}
        self.assertAlmostEqual(1/(2*np.pi*np.sqrt(by_name['L48']*by_name['C8g']))/f.F_ZERO,1.,places=13)

    def test_lossless_reciprocal_circuit_and_unresolved_exact_zero(self):
        s=f.reference();np.testing.assert_allclose(s,s.transpose(0,2,1),atol=3e-13)
        np.testing.assert_allclose(s.conj().transpose(0,2,1)@s,np.broadcast_to(np.eye(2),s.shape),atol=3e-13)
        index=int(np.argmin(abs(f.FREQUENCIES-f.F_ZERO)))
        self.assertLess(abs(s[index,1,0]),1e-12)
        with self.assertRaises(ValueError):f.independent_abcd([f.F_ZERO])

    def test_image_cutoff_is_not_forced_to_three_db_insertion_loss(self):
        s=f.reference(np.array([f.FC,2.2e6]));loss=-20*np.log10(abs(s[:,1,0]))
        np.testing.assert_allclose(loss,[8.898620221871708,28.758343765938923],atol=.0001)

    def test_open_graph_and_through_are_distinct_controls(self):
        s=f.reference(kind='open');np.testing.assert_allclose(s[:,1,0],0,atol=1e-14)
        np.testing.assert_allclose(abs(s[:,0,0]),1,atol=1e-13)
        self.assertEqual(len(f.elements('open')),12);self.assertFalse(f.elements('through'))
        np.testing.assert_array_equal(f.reference(kind='through')[:,1,0],np.ones(len(f.FREQUENCIES)))

    def test_invalid_inputs(self):
        for freq in ([0.],[float('nan')],[[2e6]],[4e6],[1e6+1j]):
            with self.assertRaises(ValueError):f.reference(freq)
        with self.assertRaises(ValueError):f.elements('unknown')


class CompositeGeometryTests(unittest.TestCase):
    def test_separate_native_elements_and_logical_ports(self):
        sim,meta=f.build(1,1)
        expected={e['name']:e for e in meta['elements']}
        actual={p.GetName():p for p in sim.csx.GetAllProperties() if p.GetName() in expected}
        self.assertEqual(set(actual),set(expected))
        for name,p in actual.items():
            self.assertEqual(p.GetLEtype(),0)
            value=p.GetInductance() if expected[name]['kind']=='L' else p.GetCapacity()
            self.assertEqual(value,expected[name]['value_si'])
        self.assertEqual([p['R'] for p in sim.ports],[75.,75.])
        self.assertEqual([p['excite'] for p in sim.ports],[True,False])
        self.assertEqual(len(meta['probe_boxes']),26)
        with self.assertRaises(ValueError):sim.to_bundle({},[])

    def test_physical_geometry_and_element_values_stay_fixed_across_meshes(self):
        _,base=f.build(1,1)
        for n in (2,3):
            _,meta=f.build(n,1)
            self.assertEqual(meta['elements'],base['elements']);self.assertEqual(meta['element_boxes'],base['element_boxes'])
            self.assertAlmostEqual(meta['declared_dt_s']*n,base['declared_dt_s'])
            for axis in 'xyz':np.testing.assert_allclose(np.array(meta['mesh_mm'][axis])[[0,-1]],np.array(base['mesh_mm'][axis])[[0,-1]])

    def test_source_and_branch_boxes_are_disjoint(self):
        sim,meta=f.build(1,1)
        for port,node in zip(sim.ports,(0,6)):
            for name in (f'L{node}'+('7' if node==0 else '9'),):
                box=meta['element_boxes'][name]
                self.assertLess(box['stop_m'][1],port['start'][1]*sim.unit)

    def test_actual_time_extension_disables_early_stop_explicitly(self):
        sim,meta=f.build(1,1,control='time')
        self.assertTrue(meta['forced_time_control']);self.assertEqual(meta['native_end_ratio'],0.)
        self.assertEqual(meta['cap_s'],2*f.CAP_S)
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'input.xml';sim.fdtd.Write2XML(str(path))
            self.assertEqual(float(ET.parse(path).find('FDTD').attrib['endCriteria']),0.)

    def test_geometry_changes_are_explicit_model_diagnostics(self):
        _,base=f.build(1,1)
        for control in ('scale','enclosure'):
            _,other=f.build(1,1,control=control)
            self.assertEqual(base['elements'],other['elements'])
        _,scaled=f.build(1,1,control='scale')
        self.assertEqual(scaled['cell_m'],base['cell_m']/2)
        self.assertAlmostEqual(scaled['declared_dt_s']/base['declared_dt_s'],.5)

    def test_invalid_choices_and_reproducible_native_xml(self):
        for args in ((True,1),(0,1),(1,3)):
            with self.assertRaises(ValueError):f.build(*args)
        with self.assertRaises(ValueError):f.build(1,1,threads=8)
        with tempfile.TemporaryDirectory() as tmp:
            paths=[Path(tmp)/str(j) for j in (1,2)]
            for p in paths:
                sim,_=f.build(1,2);sim.fdtd.Write2XML(str(p))
            self.assertEqual(paths[0].read_bytes(),paths[1].read_bytes())


if __name__=='__main__':unittest.main()
