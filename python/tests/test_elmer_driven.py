import copy
import math
import re
import unittest
import numpy as np
from fairbeam.design import blank_design
from fairbeam.elmer_driven import prepare, sif, huygens_pattern, C0, MU0, EPS0


class DrivenTests(unittest.TestCase):
    def test_shared_results_preserve_design_and_do_not_claim_gain_or_convergence(self):
        from fairbeam.elmer_bundle import result_bundle
        d=blank_design('p','Patch'); original=copy.deepcopy(d)
        settings=dict(analysis='driven',accept_finite_feed=True,approximate_metals=True,
                      cell_mm=12,padding_mm=40,feed_width_mm=1,f_min_hz=2e9,f_max_hz=3e9,
                      farfield_hz=2.5e9,points=3)
        result=dict(schema='fairbeam.elmer-driven-result/1',status='results_exported',
                    precision_converged=False,settings=settings,limitations=['Experimental'],
                    frequency_hz=[2e9,2.5e9,3e9],s11_real=[0,.2,0],s11_imag=[.1,0,-.1],
                    farfield=dict(frequency_hz=2.5e9,theta_deg=list(range(0,181,5)),
                       phi_deg=list(range(0,360,5)),directivity=np.ones((37,72)).tolist(),
                       gain_qualified=False,peak_directivity_dbi=0,radiated_power_w=1))
        b=result_bundle(d,result)
        self.assertEqual(d,original)
        self.assertEqual(b['model']['id'],'p')
        self.assertIsNone(b['run'])
        self.assertEqual(b['solver']['engine'],'Elmer')
        self.assertNotIn('preview',b)
        self.assertIsNone(b['results']['farfield'][0]['rad_efficiency'])
        self.assertIsNone(b['results']['farfield'][0]['pacc_w'])
        self.assertAlmostEqual(b['results']['ports']['1']['zin_re'][1],75)
        self.assertEqual(b['results']['ports']['1']['s11_im'],[-.1,0,.1])
        self.assertEqual(b['ports'][0]['stop'][0]-b['ports'][0]['start'][0],1)

    def test_pec_approximation_is_explicit_and_preserves_conductivity(self):
        d = blank_design('p', 'Patch')
        metal = next(m for m in d['materials'] if m['kind'] == 'metal')
        metal.update(conductivity=5.8e7, thickness=.035)
        original = copy.deepcopy(d)
        with self.assertRaises(ValueError):
            prepare(d)
        mesh = prepare(d, approximate_metals=True)
        reference = prepare(blank_design('p', 'Patch'))
        self.assertEqual(mesh['elements'], reference['elements'])
        self.assertEqual(d, original)

    def test_patch_preserves_input_and_loss(self):
        d=blank_design('p','Patch'); original=copy.deepcopy(d)
        m=prepare(d,cell_mm=15,padding_mm=35,feed_width_mm=1)
        self.assertEqual(d,original)
        self.assertEqual({b[0] for b in m['boundaries']},{1,2,3})
        expected=2*math.pi*2.45e9*EPS0*3.38*.0027
        self.assertTrue(any(math.isclose(mat[2],expected) for mat in m['materials']))
        self.assertTrue(all(len(e[1])==8 for e in m['elements']))

    def test_bad_inputs_and_resource_limits(self):
        for kwargs in ({'cell_mm':1e-12},{'padding_mm':float('nan')},{'feed_width_mm':0},{'dielectric_cells':1},{'dielectric_cells':True}):
            with self.assertRaises(ValueError):prepare(blank_design('p','Patch'),**kwargs)
        d=blank_design('p','Patch');d['ports'].append(copy.deepcopy(d['ports'][0]));d['ports'][1]['number']=2
        with self.assertRaises(ValueError):prepare(d)

    def test_vector_helmholtz_material_uses_inverse_permeability(self):
        # Check the emitted native contract, not just the internal material tuple.
        # The historical nonmagnetic patch still has inverse permeability one.
        for mu_r in (1., 2.5):
            with self.subTest(mu_r=mu_r):
                d=blank_design('p','Patch')
                dielectric=next(m for m in d['materials'] if m['kind']=='dielectric')
                dielectric['mu_r']=str(mu_r)
                original=copy.deepcopy(d)
                mesh=prepare(d,cell_mm=15,padding_mm=35,feed_width_mm=1)
                text=sif(mesh,2.45e9)
                blocks=re.findall(r'^Material \d+\n(.*?)^End$',text,re.M|re.S)
                self.assertEqual(len(blocks),2)
                materials=[dict((name.strip(),float(value)) for name,value in
                    re.findall(r'^\s*(.+?)\s*=\s*Real\s+(\S+)\s*$',block,re.M)) for block in blocks]
                self.assertEqual(materials[0],{'Relative Permittivity':1.,'Relative Reluctivity':1.,'Electric Conductivity':0.})
                self.assertEqual(set(materials[1]),set(materials[0]))
                self.assertEqual(materials[1]['Relative Reluctivity'],1/mu_r)
                self.assertEqual(materials[1]['Relative Permittivity'],3.38)
                self.assertAlmostEqual(materials[1]['Electric Conductivity'],2*math.pi*2.45e9*EPS0*3.38*.0027)
                self.assertNotIn('Relative Permeability',text)
                self.assertEqual(d,original)

    def test_nonfinite_inverse_permeability_is_not_written_to_native_input(self):
        mesh={'elements':[(1,())],'materials':[(1.,1e-320,0.)],'impedance':50.,'port_direction':3}
        with self.assertRaisesRegex(ValueError,'finite reciprocal'):
            sif(mesh,2.45e9)

    def test_huygens_matches_hertzian_dipole_power_and_pattern(self):
        frequency=2.45e9;k=2*math.pi*frequency/C0;eta=MU0*C0
        for radius in (.6*C0/frequency,1.3*C0/frequency):
            theta=(np.arange(36)+.5)*math.pi/36;phi=np.arange(72)*2*math.pi/72
            tt,pp=np.meshgrid(theta,phi,indexing='ij');tt=tt.ravel();pp=pp.ravel()
            n=np.array([np.sin(tt)*np.cos(pp),np.sin(tt)*np.sin(pp),np.cos(tt)]).T
            et=np.array([np.cos(tt)*np.cos(pp),np.cos(tt)*np.sin(pp),-np.sin(tt)]).T
            ep=np.array([-np.sin(pp),np.cos(pp),np.zeros_like(pp)]).T
            common=-1j*k*np.sin(tt)*np.exp(1j*k*radius)/(4*math.pi*radius)
            e=et*(eta*common*(1+1j/(k*radius)-1/(k*radius)**2))[:,None]
            h=ep*(common*(1+1j/(k*radius)))[:,None]
            areas=radius**2*np.sin(tt)*math.pi/36*2*math.pi/72
            ff=huygens_pattern(radius*n,n,areas,e,h,frequency)
            expected=eta*k*k/(12*math.pi)
            self.assertLess(abs(ff['radiated_power_w']/expected-1),.01)
            self.assertAlmostEqual(ff['peak_directivity_dbi'],10*math.log10(1.5),delta=.02)


if __name__=='__main__':unittest.main()
