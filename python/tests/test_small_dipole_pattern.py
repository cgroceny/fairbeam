"""Pattern-only checks and explicitly opt-in bounded FDTD acquisition."""
import argparse
from datetime import datetime,timezone
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock,patch

import numpy as np
from fairbeam.procutil import popen_group,release_group,terminate_group
from tests.test_coax_resonator import wait_owned
from tests import small_dipole_pattern_fixture as f


def forecast(meta,rate):
    if not np.isfinite(rate)or rate<=0:raise ValueError('positive conservative measured rate required')
    return float(1.2*meta['native_cells']*meta['max_timesteps']/(rate*1e6)+120.)


def freeze(out,n,control,cap=None):
    sim,_,m=f.build(n,control,cap);sim.fdtd.Write2XML(str(out/'planned.xml'))
    m.update(source=f.identity(),runtime=f.environment.runtime_identity(),input_sha256=f.sha(out/'planned.xml'))
    f.save(out/'plan.json',m);return m


def acquire(out,n,control='ordinary',rate=20.,pilot_s=None,max_wall_seconds=1800.):
    deadline=f.wall_limit(max_wall_seconds)
    out=Path(out).resolve()
    if out.exists():raise ValueError('fresh acquisition path required')
    if pilot_s is not None and (not np.isfinite(pilot_s)or not 0<pilot_s<=.5e-9):raise ValueError('pilot in 0..0.5 ns required')
    _,_,m=f.build(n,control,pilot_s);seconds=forecast(m,rate)
    if seconds>deadline:raise ValueError('forecast exceeds selected wall limit; defer acquisition')
    out.mkdir(parents=True,exist_ok=False);m=freeze(out,n,control,pilot_s)
    state=dict(status='prepared',started_utc=datetime.now(timezone.utc).isoformat(),source=m['source'],runtime=m['runtime'],
        driver_head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=f.ROOT,text=True).strip(),
        forecast_seconds=seconds,rate_mcps=rate,source_deadline_seconds=deadline,pilot=pilot_s is not None,active_launcher_pid=None,qualified=False)
    proc=None;start,wall=time.monotonic(),time.time();code=None;failure=None;command=[]
    try:
        command=[sys.executable,'-m','tests.test_small_dipole_pattern','--worker','--mesh',str(n),'--control',control,'--out',str(out/'capture')]
        if pilot_s is not None:command+=['--pilot-seconds',str(pilot_s)]
        with (out/'worker.log').open('x',encoding='utf-8')as log:
            proc=popen_group(command,cwd=f.ROOT/'python',stdout=log,stderr=subprocess.STDOUT)
            state.update(status='running',active_launcher_pid=proc.pid);f.save(out/'progress.json',state)
            class Watched:
                def __getattr__(self,name):return getattr(proc,name)
                def wait(self,timeout=None):
                    text=(out/'worker.log').read_text(encoding='utf-8',errors='replace')
                    if f.MARKER in text and re.search(r'Energy:\s*~\s*[+-]?(?:nan|inf)\b',text.split(f.MARKER)[-1],re.I):
                        raise ValueError('nonfinite native energy')
                    return proc.wait(timeout=timeout)
            try:code=wait_owned(Watched(),seconds=deadline)
            except BaseException as error:failure=repr(error);raise
            finally:
                if proc.poll()is None:terminate_group(proc.pid,grace=0,job=proc.win_job);proc.wait(timeout=15)
                release_group(proc)
                f.save(out/'worker.json',dict(command=command,pid=proc.pid,exit_code=code,failure=failure,
                    wall_seconds=time.time()-wall,monotonic_seconds=time.monotonic()-start,deadline_seconds=deadline,driver_head=state['driver_head']))
        if code:raise RuntimeError('native worker failed; raw prefix retained')
        report=json.loads((out/'capture/report.json').read_text());f.audit_header((out/'worker.log').read_text(),report)
        report.update(native_log_sha256=f.sha(out/'worker.log'),source_deadline_seconds=deadline,
            worker_receipt_sha256=f.sha(out/'worker.json'));f.save(out/'capture/report.json',report)
        if pilot_s is not None:
            q=f.quality(report)
            if not all(q[k]for k in ('grid','clock','time','operator','geometry','probes','engine'))or report['native']['timesteps']!=report['max_timesteps']:
                raise ValueError('invalid performance-only pilot')
            native=report['native'];state.update(status='performance_only',rate_measured_mcps=native['cells']*native['timesteps']/native['iteration_wall_s']/1e6)
            return state
        result=compare(out/'capture');state.update(status='complete',result=result);return result
    except BaseException as error:
        state.update(status='rejected',reason=repr(error));raise
    finally:
        state['active_launcher_pid']=None;f.save(out/'progress.json',state)


def evaluate(m,d):
    expected=(2,len(f.FREQUENCIES),len(f.THETA),len(f.PHI))
    if d['e_theta'].shape!=expected or d['e_phi'].shape!=expected:raise ValueError('full-sphere E arrays required')
    incident=d['v']+m['reference_ohm']*d['i']
    if abs(incident).min()<.02*abs(incident).max()or abs(incident).max()==0:raise ValueError('insufficient incident spectrum')
    pacc=.5*np.real(d['v']*np.conj(d['i']));z=d['v']/d['i'];rows=[]
    for box in range(2):
        for k,freq in enumerate(f.FREQUENCIES):
            e,h=d['e_theta'][box,k],d['e_phi'][box,k];power=abs(e)**2+abs(h)**2
            metrics=f.angular_metrics(power);metrics.pop('normalized_power')
            prad=float(d['prad_w'][box,k]);native_d=float(d['native_dmax'][box,k])
            if prad<=0 or native_d<=0:raise ValueError('positive native radiated power/directivity required')
            reconstruction=4*np.pi*.5*float(power.max())/np.sqrt(f.MUE0/f.EPS0)/prad
            balance=float(prad/pacc[k]-1)if pacc[k]>0 else None
            crosspol=float((abs(h)**2).max()/power.max())
            row=dict(surface=box,f_hz=float(freq),**metrics,native_directivity=native_d,
                native_reconstruction_relative_error=float(abs(reconstruction/native_d-1)),power_balance_error=balance,
                prad_w=prad,pacc_w=float(pacc[k]),crosspol_power=crosspol,r_ohm=float(z[k].real),x_ohm=float(z[k].imag),
                radiation_resistance_short_approx_ohm=float(20*np.pi**2*(f.LENGTH*1e-3*freq/f.C0)**2))
            row['point_passes']=bool(metrics['pattern_error_abs']<=f.LIMITS['pattern']and abs(metrics['directivity']-1.5)<=f.LIMITS['directivity']
                and abs(native_d-1.5)<=f.LIMITS['native_directivity']and max(abs(v-90)for v in metrics['hpbw_deg'])<=f.LIMITS['beamwidth_deg']
                and max(abs(v-90)for v in metrics['peak_theta_deg'])<=f.LIMITS['peak_deg']and crosspol<=f.LIMITS['crosspol']
                and balance is not None and abs(balance)<=f.LIMITS['power_balance']and row['native_reconstruction_relative_error']<=1e-4)
            rows.append(row)
    return dict(n=m['n'],control=m['control'],point_passes=all(r['point_passes']for r in rows),rows=rows,
        qualified=False,input_impedance_validated=False,full_antenna_validated=False,scope=f.SCOPE)


def compare(folder):
    m,d=f.read(folder);result=evaluate(m,d);path=Path(folder).parent/'comparison.json'
    if path.exists():
        if json.loads(path.read_text())!=result:raise ValueError('stored comparison changed')
    else:f.save(path,result)
    return result


def configurations():
    return [(f'n{n}',n,'ordinary')for n in f.MESHES]+[(f'n2_{c}',2,c)for c in f.STUDY_CONTROLS]


def changes(first,second):
    reports=[evaluate(m,d)['rows']for m,d in (first,second)];patterns=[]
    for _,d in (first,second):
        power=abs(d['e_theta'])**2+abs(d['e_phi'])**2;patterns.append(power/power.max(axis=(-1,-2),keepdims=True))
    dp=float(abs(patterns[1]-patterns[0]).max())
    dd=max(abs(a['directivity']-b['directivity'])for a,b in zip(*reports))
    db=max(max(abs(np.asarray(a['hpbw_deg'])-b['hpbw_deg']))for a,b in zip(*reports))
    balances=[r['power_balance_error']for report in reports for r in report]
    de=max(abs(a['power_balance_error']-b['power_balance_error'])for a,b in zip(*reports))if all(v is not None for v in balances)else None
    return dict(pattern_change_abs=dp,directivity_change=dd,beamwidth_change_deg=float(db),power_balance_change=de,
        passes=bool(dp<=f.LIMITS['change_pattern']and dd<=f.LIMITS['change_directivity']and db<=f.LIMITS['change_beamwidth_deg']
            and de is not None and de<=f.LIMITS['change_power_balance']))


def study(root):
    root=Path(root);missing=[];rejected=[];rows=[];data={};pairs=[];surfaces=[]
    for name,n,c in configurations():
        path=root/name/'progress.json'
        if not path.exists():missing.append(name);continue
        state=json.loads(path.read_text())
        if state['status']!='complete':rejected.append(dict(name=name,status=state['status'],reason=state.get('reason')));continue
        try:
            m,d=f.read(root/name/'capture')
            if (m['n'],m['control'])!=(n,c):raise ValueError('stored cohort does not match its declared mesh/control')
            row=compare(root/name/'capture')
        except (ValueError,AssertionError,FileNotFoundError)as error:rejected.append(dict(name=name,reason=repr(error)));continue
        receipt=json.loads((root/name/'worker.json').read_text())
        data[name]=(m,d);rows.append(dict(name=name,capture_source_head=receipt['driver_head'],
            source_deadline_seconds=receipt['deadline_seconds'],**row))
        a={k:(np.repeat(v[:1],2,axis=0)if k in ('e_theta','e_phi','prad_w','native_dmax')else v)for k,v in d.items()}
        b={k:(np.repeat(v[1:],2,axis=0)if k in ('e_theta','e_phi','prad_w','native_dmax')else v)for k,v in d.items()}
        surfaces.append(dict(name=name,**changes((m,a),(m,b))))
    names=[('n1','n2'),('n2','n3')]+[('n2',f'n2_{c}')for c in f.STUDY_CONTROLS]
    for first,second in names:
        if first not in data or second not in data:continue
        row=dict(first=first,second=second,**changes(data[first],data[second]))
        if second=='n2_feed':
            z=[v[1]['v']/v[1]['i']for v in (data[first],data[second])];delta=float((abs(z[1]-z[0])/abs(z[0])).max())
            row.update(feed_z_change_relative=delta);row['passes']&=delta<=f.LIMITS['feed_z_relative']
        pairs.append(row)
    qualified=bool(not missing and not rejected and len(rows)==7 and len(pairs)==6 and len(surfaces)==7
        and all(r['point_passes']for r in rows)and all(r['passes']for r in pairs+surfaces))
    return dict(pattern_scope_qualified=qualified,qualified=qualified,input_impedance_validated=False,full_antenna_validated=False,
        scope=f.SCOPE,missing=missing,rejected=rejected,rows=rows,changes=pairs,surface_changes=surfaces)


class SmallDipolePatternTests(unittest.TestCase):
    def test_independent_solid_angle_integral_and_half_power(self):
        p=np.repeat((np.sin(np.deg2rad(f.THETA))**2)[:,None],len(f.PHI),axis=1)
        m=f.angular_metrics(p)
        self.assertAlmostEqual(m['directivity'],1.5,places=6);np.testing.assert_allclose(m['hpbw_deg'],90,atol=1e-12)
        self.assertLess(m['pattern_error_abs'],1e-14)

    def test_pattern_amplitude_does_not_change_metrics(self):
        p=np.repeat((np.sin(np.deg2rad(f.THETA))**2)[:,None],len(f.PHI),axis=1)
        for scale in (1e-15,1e15):self.assertAlmostEqual(f.angular_metrics(p*scale)['directivity'],1.5,places=6)

    def test_perfect_normalized_pattern_cannot_hide_failed_power_balance(self):
        shape=(2,3,len(f.THETA),len(f.PHI));e=np.broadcast_to(np.sin(np.deg2rad(f.THETA))[None,None,:,None],shape).copy()
        prad=4*np.pi/(3*np.sqrt(f.MUE0/f.EPS0))
        d=dict(e_theta=e,e_phi=np.zeros_like(e),prad_w=np.full((2,3),prad),native_dmax=np.full((2,3),1.5),v=np.ones(3),i=np.full(3,2*prad))
        self.assertTrue(evaluate(dict(n=1,control='ordinary',reference_ohm=50),d)['point_passes'])
        d['prad_w']*=.5
        result=evaluate(dict(n=1,control='ordinary',reference_ohm=50),d)
        self.assertFalse(result['point_passes']);self.assertLess(result['rows'][0]['pattern_error_abs'],1e-14)

    def test_crosspolarization_is_checked_separately_from_pattern_shape(self):
        shape=(2,3,len(f.THETA),len(f.PHI));e=np.broadcast_to(np.sin(np.deg2rad(f.THETA))[None,None,:,None],shape).copy()
        prad=1.01*4*np.pi/(3*np.sqrt(f.MUE0/f.EPS0))
        d=dict(e_theta=e,e_phi=.1*e,prad_w=np.full((2,3),prad),native_dmax=np.full((2,3),1.5),v=np.ones(3),i=np.full(3,2*prad))
        result=evaluate(dict(n=1,control='ordinary',reference_ohm=50),d)
        self.assertFalse(result['point_passes']);self.assertGreater(result['rows'][0]['crosspol_power'],f.LIMITS['crosspol'])

    def test_transform_bounds_threads_and_requires_every_face_pair(self):
        with tempfile.TemporaryDirectory()as tmp:
            raw=Path(tmp)
            for face in range(6):
                for key in ('E','H'):(raw/f'box_{key}_{face}.h5').touch()
            calc=Mock();calc.AnalyseFile.return_value=True
            with patch.object(f._nf2ff,'_nf2ff',return_value=calc)as factory,patch.object(f,'nf2ff_results',return_value='read'):
                self.assertEqual(f.transform(raw,'box',raw/'far.h5'),'read');self.assertEqual(factory.call_args.kwargs['numThreads'],4)
                self.assertEqual(calc.AnalyseFile.call_count,6)
            (raw/'box_H_5.h5').unlink()
            with patch.object(f._nf2ff,'_nf2ff',return_value=calc),patch.object(f,'nf2ff_results'):
                with self.assertRaises(ValueError):f.transform(raw,'box',raw/'far.h5')

    def test_bad_spheres_and_missing_crossings_are_rejected(self):
        for p in (np.zeros((91,36)),np.full((91,36),np.nan),np.ones((91,36)),np.ones((90,36))):
            with self.assertRaises(ValueError):f.angular_metrics(p)

    def test_all_meshes_keep_geometry_surfaces_and_physical_pml(self):
        for n in f.MESHES:
            sim,boxes,m=f.build(n)
            self.assertEqual(len(boxes),2);self.assertEqual(m['reference_ohm'],50.)
            for axis in 'xy':self.assertIn(0.,m['mesh_mm'][axis])
            for lines in m['mesh_mm'].values():
                np.testing.assert_allclose(np.diff(lines[-9:]),8.,atol=1e-12)
                self.assertEqual(lines[-9],100.)
                for value in (-45.,-30.,30.,45.):self.assertIn(value,lines)
            for name in m['surface_names']:
                self.assertEqual(len(sim.csx.GetPropertiesByName(name+'_E')[0].GetAllPrimitives()),6)
            with self.assertRaises(ValueError):sim.to_bundle()
        dt=[f.build(n)[2]['declared_dt_s']for n in f.MESHES]
        self.assertTrue(all(b<a for a,b in zip(dt,dt[1:])))

    def test_controls_are_explicit_and_json_safe(self):
        _,_,base=f.build(2)
        for c in f.CONTROLS:
            _,_,m=f.build(2,c);self.assertEqual(m,json.loads(json.dumps(m,allow_nan=False)))
            self.assertEqual(m['length_mm'],base['length_mm']);self.assertEqual(m['surfaces_mm'],base['surfaces_mm'])
        self.assertEqual(f.build(2,'feed')[2]['mesh_mm'],base['mesh_mm'])
        self.assertEqual(f.build(2,'time')[2]['mesh_mm'],base['mesh_mm'])
        self.assertGreater(f.build(2,'time')[2]['cap_s'],base['cap_s'])
        self.assertLess(f.build(2,'dt')[2]['declared_dt_s'],base['declared_dt_s'])

    def test_current_contour_encloses_the_zero_thickness_sheet_coordinate(self):
        _,_,m=f.build(1)
        # Captured rc3 header: y=0 must be enclosed by both dual boundaries.
        self.assertEqual(m['expected_probe_indices']['port_it_1'],[[26,27,32],[29,28,32]])
        self.assertEqual(m['expected_probe_indices']['port_ut_1'],[[28,28,32],[28,28,33]])

    def test_native_surface_inventory_checks_planes_and_finite_fields(self):
        with tempfile.TemporaryDirectory()as tmp:
            raw=Path(tmp);m=dict(surface_names=['a','b'],surfaces_mm=[30.,45.])
            for box,radius in zip(m['surface_names'],m['surfaces_mm']):
                for face in range(6):
                    for field in ('E','H'):
                        with f.h5py.File(raw/f'{box}_{field}_{face}.h5','w')as h:
                            for k,axis in enumerate('xyz'):
                                value=[(-1 if face%2==0 else 1)*radius*1e-3]if k==face//2 else [-radius*1e-3,0,radius*1e-3]
                                h.create_dataset('Mesh/'+axis,data=value)
                            h.create_dataset('FieldData/FD/f0',data=np.ones((3,3,1),complex))
            self.assertEqual(len(f.surface_inventory(raw,m)),24)
            with f.h5py.File(raw/'b_H_5.h5','a')as h:h['Mesh/z'][0]=1.
            with self.assertRaises(ValueError):f.surface_inventory(raw,m)
            with f.h5py.File(raw/'b_H_5.h5','a')as h:
                h['Mesh/z'][0]=.045;h['FieldData/FD/f0'][0,0,0]=np.nan
            with self.assertRaises(ValueError):f.surface_inventory(raw,m)

    def test_farfield_native_axes_cannot_be_relabelled(self):
        r=Mock(freq=f.FREQUENCIES,theta=np.deg2rad(f.THETA).astype(np.float32),phi=np.deg2rad(f.PHI).astype(np.float32),r=np.array([1.]))
        f.farfield_axes(r);r.freq=f.FREQUENCIES*2
        with self.assertRaises(AssertionError):f.farfield_axes(r)

    def test_recording_domain_control_keeps_the_same_physical_model(self):
        _,a,first=f.build(1);_,b,second=f.build(1,'td')
        for key in ('mesh_mm','declared_dt_s','reference_ohm','length_mm','width_mm','gap_mm','surfaces_mm','expected_probe_indices'):
            self.assertEqual(first[key],second[key])
        self.assertEqual(first['recording_domain'],'frequency');self.assertEqual(second['recording_domain'],'time')
        self.assertEqual(a[0].dump_type,10);self.assertEqual(b[0].dump_type,0)

    def test_per_box_sampling_protects_fd_from_plain_nyquist_aliasing(self):
        for control,value in (('ordinary',8),('td',8),('fd1',1)):
            _,boxes,m=f.build(1,control)
            self.assertEqual(m['recording_over_sampling'],value)
            for box in boxes:
                self.assertEqual(box.e_dump.GetOverSampling(),value);self.assertEqual(box.h_dump.GetOverSampling(),value)

    def test_diagnostic_cohort_cannot_be_relabelled_as_qualification_data(self):
        with tempfile.TemporaryDirectory()as tmp:
            path=Path(tmp)/'n1';path.mkdir();f.save(path/'progress.json',dict(status='complete'))
            with patch.object(f,'read',return_value=(dict(n=1,control='fd1'),{})):
                result=study(tmp)
            self.assertFalse(result['qualified']);self.assertIn('cohort',result['rejected'][0]['reason'])

    def test_invalid_models_and_requests_do_not_dispatch(self):
        for n in (True,0,4,1.5):
            with self.assertRaises(ValueError):f.build(n)
        with tempfile.TemporaryDirectory()as tmp,patch(__name__+'.popen_group')as launch:
            out=Path(tmp)/'absent'
            with self.assertRaises(ValueError):acquire(out,1,rate=.001)
            with self.assertRaises(ValueError):acquire(out,1,pilot_s=1e-9)
            self.assertFalse(out.exists());launch.assert_not_called()

    def test_electric_and_magnetic_clock_alignment(self):
        dt=1e-13;stride=int(1/(2*1.2e9*dt))//f.OVERSAMPLING
        m=dict(native=dict(dt_s=dt,numerical_time_s=3*stride*dt));a=np.column_stack((np.arange(4)*stride*dt,np.ones(4)))
        f.trace_clock(a,m);f.trace_clock(a+np.array([dt/2,0]),m,True)
        for bad in (a[:-1],a+np.array([dt/2,0])):
            with self.assertRaises(ValueError):f.trace_clock(bad,m)

    def test_missing_study_cannot_qualify_pattern_or_impedance(self):
        with tempfile.TemporaryDirectory()as tmp:
            r=study(tmp);self.assertEqual(len(r['missing']),7);self.assertFalse(r['qualified'])
            self.assertFalse(r['input_impedance_validated']);self.assertFalse(r['full_antenna_validated'])

    def test_failed_worker_retains_receipt_without_comparison(self):
        proc=Mock(pid=123,win_job=None);proc.poll.return_value=2
        with tempfile.TemporaryDirectory()as tmp,patch(__name__+'.popen_group',return_value=proc),patch(__name__+'.wait_owned',return_value=2),patch(__name__+'.release_group'):
            out=Path(tmp)/'failed'
            with self.assertRaises(RuntimeError):acquire(out,1,rate=1000.)
            self.assertEqual(json.loads((out/'worker.json').read_text())['exit_code'],2)
            self.assertFalse((out/'comparison.json').exists());self.assertIsNone(json.loads((out/'progress.json').read_text())['active_launcher_pid'])

    def test_selected_wall_limit_is_opt_in_and_records_the_actual_waiter(self):
        for deadline in (1800.,2700.):
            proc=Mock(pid=123,win_job=None);proc.poll.return_value=2
            with tempfile.TemporaryDirectory()as tmp,patch(__name__+'.popen_group',return_value=proc),patch(__name__+'.wait_owned',return_value=2)as wait,patch(__name__+'.release_group'):
                out=Path(tmp)/'failed';kwargs={}if deadline==1800. else dict(max_wall_seconds=deadline)
                with self.assertRaises(RuntimeError):acquire(out,2,'dt',rate=1000.,**kwargs)
                self.assertEqual(wait.call_args.kwargs['seconds'],deadline)
                self.assertEqual(json.loads((out/'worker.json').read_text())['deadline_seconds'],deadline)
                self.assertEqual(json.loads((out/'progress.json').read_text())['source_deadline_seconds'],deadline)

    def test_invalid_wall_limits_never_dispatch_or_create_output(self):
        with tempfile.TemporaryDirectory()as tmp,patch(__name__+'.popen_group')as launch:
            out=Path(tmp)/'absent'
            for limit in (True,0,-1,2701,float('nan'),float('inf'),'2700'):
                with self.assertRaises(ValueError):acquire(out,1,max_wall_seconds=limit)
            self.assertFalse(out.exists());launch.assert_not_called()

    def test_forecast_uses_selected_limit_without_changing_measured_rate(self):
        proc=Mock(pid=123,win_job=None);proc.poll.return_value=2
        with tempfile.TemporaryDirectory()as tmp,patch(__name__+'.forecast',return_value=1900.),patch(__name__+'.popen_group',return_value=proc)as launch,patch(__name__+'.wait_owned',return_value=2),patch(__name__+'.release_group'):
            out=Path(tmp)/'bounded'
            with self.assertRaises(ValueError):acquire(out,2,'dt',rate=23.592156395443137)
            self.assertFalse(out.exists());launch.assert_not_called()
            with self.assertRaises(RuntimeError):acquire(out,2,'dt',rate=23.592156395443137,max_wall_seconds=2700.)
            state=json.loads((out/'progress.json').read_text())
            self.assertEqual(state['rate_mcps'],23.592156395443137);self.assertEqual(state['forecast_seconds'],1900.)

    def test_pinned_old_capture_keeps_its_source_receipt_and_native_input(self):
        with tempfile.TemporaryDirectory()as tmp:
            out=Path(tmp)/'capture';out.mkdir();receipt_path=out.parent/'worker.json'
            sim=Mock();sim.fdtd.Write2XML.side_effect=lambda p:Path(p).write_bytes(b'unchanged native input')
            current=dict(f.identity());source=dict(current,**f.PREVIOUS_SOURCE)
            native=out/'input.xml';native.write_bytes(b'unchanged native input')
            m=dict(source=source,input_sha256=f.sha(native))
            receipt=dict(driver_head=f.PREVIOUS_HEAD,deadline_seconds=1800.,wall_seconds=1200.,monotonic_seconds=1200.,exit_code=0,failure=None)
            f.save(receipt_path,receipt);before=receipt_path.read_bytes()
            f.audit_capture_provenance(out,m,sim);self.assertEqual(receipt_path.read_bytes(),before)
            for key,value in (('driver_head','unrelated'),('deadline_seconds',2700.),('wall_seconds',1801.)):
                f.save(receipt_path,dict(receipt,**{key:value}))
                with self.assertRaises(ValueError):f.audit_capture_provenance(out,m,sim)
            f.save(receipt_path,receipt)
            for name in ('tests/coax_resonator_fixture.py','tests/small_dipole_pattern_fixture.py'):
                with self.assertRaises(ValueError):f.audit_capture_provenance(out,dict(m,source=dict(source,**{name:'changed'})),sim)
            sim.fdtd.Write2XML.side_effect=lambda p:Path(p).write_bytes(b'changed native input')
            with self.assertRaises(ValueError):f.audit_capture_provenance(out,m,sim)

    def test_new_receipt_hash_deadline_and_elapsed_times_are_checked(self):
        with tempfile.TemporaryDirectory()as tmp:
            out=Path(tmp)/'capture';out.mkdir();receipt_path=out.parent/'worker.json'
            sim=Mock();sim.fdtd.Write2XML.side_effect=lambda p:Path(p).write_bytes(b'native input')
            native=out/'input.xml';native.write_bytes(b'native input')
            receipt=dict(driver_head='new',deadline_seconds=2700.,wall_seconds=1900.,monotonic_seconds=1900.,exit_code=0,failure=None)
            f.save(receipt_path,receipt)
            m=dict(source=f.identity(),input_sha256=f.sha(native),source_deadline_seconds=2700.,worker_receipt_sha256=f.sha(receipt_path))
            f.audit_capture_provenance(out,m,sim)
            for key,value in (('deadline_seconds',1800.),('wall_seconds',2701.),('monotonic_seconds',float('nan')),('failure','timeout')):
                changed=dict(receipt,**{key:value});receipt_path.write_text(json.dumps(changed))
                # Even when rehashed, a mismatched/overrun receipt is rejected.
                with self.assertRaises(ValueError):f.audit_capture_provenance(out,dict(m,worker_receipt_sha256=f.sha(receipt_path)),sim)


def main():
    p=argparse.ArgumentParser(description=__doc__);mode=p.add_mutually_exclusive_group(required=True)
    for name in ('prepare','fdtd','worker','compare','study'):mode.add_argument('--'+name,action='store_true')
    p.add_argument('--out',type=Path,required=True);p.add_argument('--mesh',type=int,choices=f.MESHES,default=1)
    p.add_argument('--control',choices=f.CONTROLS,default='ordinary');p.add_argument('--rate-mcps',type=float,default=20.)
    p.add_argument('--max-wall-seconds',type=float,default=1800.,help='opt-in source guard, at most 2700 seconds; default 1800')
    p.add_argument('--pilot-seconds',type=float);a=p.parse_args()
    if a.pilot_seconds is not None and (not(a.fdtd or a.worker)or not np.isfinite(a.pilot_seconds)or not 0<a.pilot_seconds<=.5e-9):p.error('performance-only pilot in 0..0.5 ns required')
    if a.worker:f.capture(a.out,a.mesh,a.control,a.pilot_seconds);return
    if a.fdtd:r=acquire(a.out,a.mesh,a.control,a.rate_mcps,a.pilot_seconds,a.max_wall_seconds)
    elif a.compare:r=compare(a.out/'capture')
    elif a.study:r=study(a.out)
    else:
        a.out.mkdir(parents=True,exist_ok=False);r=freeze(a.out,a.mesh,a.control);r=dict(r,forecast_seconds=forecast(r,a.rate_mcps),native_propagations=0)
    print(json.dumps(r,indent=2,allow_nan=False))


if __name__=='__main__':
    if any('--'+name in sys.argv for name in ('prepare','fdtd','worker','compare','study')):main()
    else:unittest.main()
