"""Offline replay of reduced measured TE10 data; NumPy only, no native run.

This recomputes arithmetic from contributor-reported samples. It does not
independently replay the private raw native fields or certify arbitrary times.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
import numpy as np
from tests.waveguide_step_admission import checked_trace, finite_real, late_energies, positive_integer

EVIDENCE=Path(__file__).parent/'fixtures/waveguide_step_mur_evidence.json'
LIMITS=dict(target_abs=.01,mesh_abs=.003,boundary_abs=.002,reciprocity_abs=.002,power_abs=.01)
HOLD=dict(duration_s=60e-9,end_db=-150.,late_energy_db=-90.,wave_abs=.002)
GRIDS=((40,16),(50,16),(60,16),(50,24))

def require(condition,message):
    if not condition:raise ValueError(message)

def load(path):
    path=Path(path)
    m=json.loads(path.read_text(encoding='utf-8'))
    name=m['samples']['filename']
    require(Path(name).name==name,'sample filename must stay beside the manifest')
    data=(path.parent/name).read_bytes()
    require(hashlib.sha256(data).hexdigest()==m['samples']['sha256'],'sample checksum changed')
    with np.load(path.parent/name,allow_pickle=False) as archive:arrays=dict(archive)
    return m,arrays

def reference(m,frequency):
    g=m['own_geometry']
    require(g==dict(a_mm=22.86,b_mm=10.16,right_eps_r=2.54,mu_r=1.,measurement_planes_mm=[-20.,20.],interface_mm=0.),
            'this evidence protocol fixes the own geometry')
    k=2*np.pi*frequency/299792458.
    beta=np.sqrt(np.stack([k*k-(np.pi/.02286)**2,2.54*k*k-(np.pi/.02286)**2]))
    z=376.730313668*k/beta
    rho=(z[1]-z[0])/(z[1]+z[0]);tau=2*np.sqrt(z[0]*z[1])/(z[0]+z[1])
    s=np.empty((len(frequency),2,2),complex)
    s[:,0,0]=rho*np.exp(-2j*beta[0]*.02)
    s[:,1,1]=-rho*np.exp(-2j*beta[1]*.02)
    s[:,0,1]=s[:,1,0]=tau*np.exp(-1j*(beta[0]+beta[1])*.02)
    return s,z

def execution(record,primary):
    native,run=record['native'],record['run']
    require(run['threads']==4 and run['engine']=='cpu' and run['exact_endcriteria'] is True,'native CPU/thread/stop identity')
    require(finite_real(native['dt_s']) and native['dt_s']>0 and positive_integer(native['timesteps'])
            and positive_integer(native['cells']) and positive_integer(record['max_timesteps'])
            and native['timesteps']<=record['max_timesteps'],'native clock/allocation')
    checked_trace(record['energy_trace'],native['timesteps'])
    require(np.isclose(native['numerical_time_s'],native['timesteps']*native['dt_s'],rtol=1e-8,atol=0),'native elapsed time')
    require(all(finite_real(v) and 0<v<=1800 for v in (record['case_elapsed_s'],run['wall_time_s'])),'native case deadline')
    for guard in ('worker','enclosing_guard'):
        receipt=record[guard]
        require(receipt['deadline_seconds']==1800 and type(receipt['exit_code']) is int and receipt['exit_code']==0,'guard deadline/exit')
        require(all(finite_real(receipt[k]) and 0<receipt[k]<=1800 for k in ('wall_seconds','monotonic_seconds')),'guard duration')
    require(record['worker']['failure'] is None and record['enclosing_guard']['timed_out'] is False,'failed worker')
    # This historical reduced schema uses null placeholders for absent stop data.
    # Every actual value must be finite before max(), whose NaN ordering can hide it.
    energy=[run[k] for k in ('final_energy_db','final_energy_bound_db') if run.get(k) is not None]
    require(all(finite_real(value) for value in energy),'finite non-Boolean native stop energy')
    if primary:
        require(run['converged'] is True and run['hit_timestep_limit'] is False and energy and max(energy)<=-90.,'primary exact energy stop')
        require(record['native_end_db']==-90. and record['max_timesteps']==200000,'primary native settings')
        require(native['timesteps']>=record['source_cache']['complete_after_steps'],'incomplete Gaussian source')
    else:
        require(record['native_end_db']==HOLD['end_db'] and native['timesteps']==record['max_timesteps'],'complete fixed continuation')
        require(abs(native['numerical_time_s']-HOLD['duration_s'])<=native['dt_s']*1.001,'continuation duration')

def analyze(m,arrays):
    require(m['format']=='fairbeam-te10-mur-measured-evidence-v1','evidence format')
    require(m['limits']==LIMITS and m['hold_limits']==HOLD and m['termination']=='MUR','frozen limits/termination')
    frequency=arrays['frequency_hz']
    require(np.array_equal(frequency,np.linspace(9.8e9,10.2e9,41)) and np.array_equal(frequency,m['frequency_hz']),'frequency grid')
    ref,z_reference=reference(m,frequency)
    require(np.allclose(arrays['reference'],ref,rtol=1e-13,atol=1e-14),'independent modal reference')
    require([(g['cpw'],g['padding']) for g in m['grids']]==list(GRIDS),'complete three-mesh/control cohort')
    spectra={};temporal=[]
    for grid in m['grids']:
        n,p=grid['cpw'],grid['padding'];prefix=grid['sample_prefix']
        waves={k:arrays[prefix+'_'+k] for k in ('a','b','voltage','current','z_ref','hold_a','hold_b')}
        require(all(v.shape==(2,2,41) and np.isfinite(v).all() for v in waves.values()),'finite source/port spectra')
        z=waves['z_ref']
        require(np.allclose(z,z_reference[None,:,:],rtol=1e-8,atol=0),'modal power references')
        a=(waves['voltage']+z*waves['current'])/(2*np.sqrt(z))
        b=(waves['voltage']-z*waves['current'])/(2*np.sqrt(z))
        scale=float(abs(a).max());require(scale>0,'incident spectrum')
        require(max(float(abs(a-waves['a']).max()),float(abs(b-waves['b']).max()))/scale<2e-12,'V/I power-wave reconstruction')
        s=[];conditions=[]
        for k in range(41):
            incoming,outgoing=a[:,:,k].T,b[:,:,k].T
            condition=float(np.linalg.cond(incoming));conditions.append(condition)
            require(np.isfinite(condition) and condition<=1e4,'incident conditioning')
            s.append(np.linalg.solve(incoming.T,outgoing.T).T)
        s=np.array(s)
        require(np.allclose(s,arrays[prefix+'_s'],rtol=1e-12,atol=1e-13),'independent two-column S assembly')
        spectra[n,p]=s
        require([r['excited'] for r in grid['records']]==[1,2],'both sources')
        for drive,record in enumerate(grid['records']):
            primary,hold=record['primary'],record['hold']
            execution(primary,True);execution(hold,False)
            require(primary['native']['dt_s']==hold['native']['dt_s'] and primary['native']['cells']==hold['native']['cells'],'same primary/hold native clock/grid')
            require(primary['source_cache']==hold['source_cache'],'same source caches')
            require(hold['seed_report_sha256']==primary['hashes']['report'],'continuation seed hash')
            late=late_energies(hold['energy_trace'],hold['native']['timesteps'],hold['native']['dt_s'],primary['native']['numerical_time_s'])
            require(len(late)>=3 and all(np.isfinite(v) and v<=-90. for v in late),'late energy rebound or missing samples')
            norm=abs(a[drive]).max(axis=0);require(np.all(norm>0),'primary incident normalization')
            changes={key:float((abs(waves['hold_'+key][drive]-before[drive])/norm).max()) for key,before in (('a',a),('b',b))}
            require(max(changes.values())<=HOLD['wave_abs'],'continuation spectral change')
            expected=record['temporal_check']
            require(expected['passes'] is True and abs(max(late)-expected['maximum_late_energy_db'])<1e-12,'recorded temporal verdict')
            require(all(abs(changes[k]-expected['wave_change'][k])<1e-12 for k in ('a','b')),'recorded wave change')
            temporal.append(dict(cpw=n,padding=p,excited=drive+1,maximum_late_energy_db=max(late),wave_change=changes))
    rows=[]
    for n in (40,50,60):
        s=spectra[n,16]
        row=dict(cpw=n,target_abs_max=float(abs(s-ref).max()),
            reciprocity_abs_max=float(abs(s[:,0,1]-s[:,1,0]).max()),power_error_max=float(abs(np.sum(abs(s)**2,axis=1)-1).max()),
            mesh_abs_max=None if n==40 else float(abs(s-spectra[n-10,16]).max()))
        require(row['target_abs_max']<=LIMITS['target_abs'] and row['reciprocity_abs_max']<=LIMITS['reciprocity_abs'] and row['power_error_max']<=LIMITS['power_abs'],'target/reciprocity/power')
        require(n==40 or row['mesh_abs_max']<=LIMITS['mesh_abs'],'mesh convergence')
        recorded=next(v for v in m['comparison']['rows'] if v['cpw']==n)
        require(all(recorded[k] is None if v is None else abs(recorded[k]-v)<1e-12 for k,v in row.items() if k!='cpw'),'recorded comparison values')
        rows.append(row)
    control=spectra[50,24]
    boundary=float(abs(spectra[50,16]-control).max())
    require(boundary<=LIMITS['boundary_abs'],'independent padding control')
    require(float(abs(control-ref).max())<=LIMITS['target_abs'] and float(abs(control[:,0,1]-control[:,1,0]).max())<=LIMITS['reciprocity_abs'] and float(abs(np.sum(abs(control)**2,axis=1)-1).max())<=LIMITS['power_abs'],'control own target/QA')
    require(m['comparison']['qualified_scope'] is True and abs(boundary-m['comparison']['boundary_abs_max'])<1e-12,'recorded full-cohort verdict')
    return dict(qualified_scope=True,native_captures=16,rows=rows,boundary_abs_max=boundary,temporal=temporal,
                scope=m['scope'],raw_native_replay=False)

class MeasuredMUR(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.manifest,cls.samples=load(EVIDENCE)
    def test_complete_measured_cohort(self):
        result=analyze(self.manifest,self.samples)
        self.assertTrue(result['qualified_scope']);self.assertEqual(result['native_captures'],16)
    def test_geometry_or_missing_spectra_cannot_qualify(self):
        bad=copy.deepcopy(self.manifest);bad['own_geometry']['right_eps_r']=2.6
        with self.assertRaises(ValueError):analyze(bad,self.samples)
        bad=dict(self.samples);bad.pop('n60_p16_hold_b')
        with self.assertRaises((ValueError,KeyError)):analyze(self.manifest,bad)
    def test_current_polarity_and_hold_wave_change_are_detected(self):
        for field in ('n50_p16_current','n60_p16_hold_b'):
            bad={k:v.copy() for k,v in self.samples.items()}
            if field.endswith('current'):bad[field]*=-1
            else:bad[field][0,0]+=.01*abs(bad['n60_p16_a']).max()
            with self.assertRaises(ValueError):analyze(self.manifest,bad)
    def test_late_growth_short_window_and_late_worker_are_detected(self):
        for kind in ('growth','short','deadline'):
            bad=copy.deepcopy(self.manifest);hold=bad['grids'][0]['records'][0]['hold']
            if kind=='growth':hold['energy_trace'][-1]['db']=-76.16
            elif kind=='short':hold['native']['timesteps']-=1
            else:hold['worker']['wall_seconds']=1801.
            with self.assertRaises(ValueError):analyze(bad,self.samples)
    def test_reduced_trace_cannot_count_duplicate_outside_or_invalid_observations(self):
        for kind in ('duplicate','outside','reverse','fractional','integer-float','boolean',
                     'nan-step','infinite-step','zero','negative','nan-energy','infinite-energy','boolean-energy','missing'):
            with self.subTest(kind=kind):
                bad=copy.deepcopy(self.manifest);hold=bad['grids'][0]['records'][0]['hold']
                rows=hold['energy_trace']
                if kind=='duplicate':hold['energy_trace']=[copy.deepcopy(rows[-1])]*3
                elif kind=='outside':hold['energy_trace']=[dict(timestep=hold['native']['timesteps']+n,db=-100.) for n in (1,2,3)]
                elif kind=='reverse':hold['energy_trace']=rows[::-1]
                elif kind=='fractional':rows[0]['timestep']+=.5
                elif kind=='integer-float':rows[0]['timestep']=float(rows[0]['timestep'])
                elif kind=='boolean':rows[0]['timestep']=True
                elif kind=='nan-step':rows[0]['timestep']=float('nan')
                elif kind=='infinite-step':rows[0]['timestep']=float('inf')
                elif kind=='zero':rows[0]['timestep']=0
                elif kind=='negative':rows[0]['timestep']=-1
                elif kind=='nan-energy':rows[0]['db']=float('nan')
                elif kind=='infinite-energy':rows[0]['db']=-float('inf')
                elif kind=='boolean-energy':rows[0]['db']=True
                else:rows[0].pop('timestep')
                with self.assertRaises(ValueError):analyze(bad,self.samples)
    def test_nonfinite_stop_energy_boolean_deadlines_exits_and_invalid_cells_are_rejected(self):
        for field in ('final_energy_db','final_energy_bound_db'):
            for value in (float('nan'),float('inf'),-float('inf'),True):
                with self.subTest(field=field,value=value):
                    bad=copy.deepcopy(self.manifest);run=bad['grids'][0]['records'][0]['primary']['run']
                    run.update(final_energy_db=-100.,final_energy_bound_db=None)
                    run[field]=value
                    with self.assertRaises(ValueError):analyze(bad,self.samples)
        for route in (('case_elapsed_s',),('run','wall_time_s'),
                      ('worker','wall_seconds'),('worker','monotonic_seconds'),
                      ('enclosing_guard','wall_seconds'),('enclosing_guard','monotonic_seconds')):
            for value in (True,float('nan'),float('inf')):
                with self.subTest(duration=route,value=value):
                    bad=copy.deepcopy(self.manifest);target=bad['grids'][0]['records'][0]['primary']
                    for key in route[:-1]:target=target[key]
                    target[route[-1]]=value
                    with self.assertRaises(ValueError):analyze(bad,self.samples)
        for guard in ('worker','enclosing_guard'):
            for value in (False,0.):
                with self.subTest(guard=guard,exit=value):
                    bad=copy.deepcopy(self.manifest)
                    bad['grids'][0]['records'][0]['primary'][guard]['exit_code']=value
                    with self.assertRaises(ValueError):analyze(bad,self.samples)
        for value in (True,0,-1,100.5,float('nan'),float('inf')):
            with self.subTest(cells=value):
                bad=copy.deepcopy(self.manifest);record=bad['grids'][0]['records'][0]
                for kind in ('primary','hold'):record[kind]['native']['cells']=value
                with self.assertRaises(ValueError):analyze(bad,self.samples)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence',type=Path,default=EVIDENCE)
    EVIDENCE=parser.parse_args().evidence
    result=unittest.main(argv=[sys.argv[0]],exit=False).result
    if result.wasSuccessful():print(json.dumps(analyze(*load(EVIDENCE)),indent=2))
    raise SystemExit(0 if result.wasSuccessful() else 1)
