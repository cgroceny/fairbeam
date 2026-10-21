"""Pure checks plus explicit, fresh-output native acquisition. No FDTD in discovery.

From python/ in an openEMS environment:
python -m unittest tests.test_stub_lowpass_fixture -q
python -m tests.test_stub_lowpass_fixture --preflight --out C:/study/stub-plan-fresh
python -m tests.test_stub_lowpass_fixture --fdtd --kind through --out C:/study/stub-fresh/n2_through
python -m tests.test_stub_lowpass_fixture --fdtd --out C:/study/stub-fresh/n2_filter
python -m tests.test_stub_lowpass_fixture --study --out C:/study/stub-fresh

Native admission uses a conservative explicit rate and a 30-minute owned
deadline including suspend. Short performance pilots never establish S data.
"""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock,patch
import xml.etree.ElementTree as ET

import numpy as np
from fairbeam.procutil import popen_group,release_group,terminate_group
from tests.test_coax_resonator import wait_owned
from tests import stub_lowpass_fixture as f


def configurations():
    return [(f'n{n}_{kind}',n,kind,'ordinary') for n in f.MESHES for kind in f.KINDS]+[
        (f'n2_filter_{control}',2,'filter',control) for control in f.CONTROLS[1:]]


def forecast(meta,rate):
    if not np.isfinite(rate) or rate<=0:raise ValueError('positive finite conservative rate required')
    return 1.2*meta['native_cells']*meta['max_timesteps']/(rate*1e6)+45


def preflight(out,rate=20.):
    out=Path(out);out.mkdir(parents=True,exist_ok=False);rows=[]
    for name,n,kind,control in configurations():
        for port in (1,2):
            sim,_,meta=f.build(n,port,kind,control);p=out/f'{name}_p{port}.xml';sim.fdtd.Write2XML(str(p))
            sim.fdtd.SetTimeStep(0.);sim.fdtd.SetNumberOfTimeSteps(f.OPERATOR_STEPS)
            op=out/f'{name}_p{port}_operator.xml';sim.fdtd.Write2XML(str(op))
            estimate=forecast(meta,rate)
            rows.append(dict(name=name,**meta,input_sha256=f.sha(p),operator_input_sha256=f.sha(op),
                             estimated_seconds=estimate,deferred=estimate>1800))
    result=dict(source=f.identity(),runtime=f.runtime_identity(),rows=rows,limits=f.LIMITS,rate_mcps=rate,
                native_propagations=0,qualified=False)
    f.save(out/'preflight.json',result);return result


def acquire_serial(out,n=2,kind='filter',control='ordinary',rate=20.,pilot_s=None):
    out=Path(out).resolve()
    if out.exists():raise ValueError('fresh cohort directory required')
    if pilot_s is not None and (not np.isfinite(pilot_s) or not 0<pilot_s<=.5e-9):
        raise ValueError('performance pilot cap must be positive and at most 0.5 ns')
    _,_,meta=f.build(n,1,kind,control,pilot_s);estimate=forecast(meta,rate)
    if estimate>1800:raise ValueError(f'forecast {estimate/60:.2f} min exceeds 30; defer this cohort')
    out.mkdir(parents=True,exist_ok=False)
    record=dict(status='prepared',source=f.identity(),runtime=f.runtime_identity(),ports=[],qualified=False,
                pilot=pilot_s is not None,estimated_seconds_per_source=estimate,rate_mcps=rate,active_launcher_pid=None)
    planned=[]
    for port in ((1,) if pilot_s is not None else (1,2)):
        sim,_,m=f.build(n,port,kind,control,pilot_s)
        inp=out/f'planned-p{port}.xml';sim.fdtd.Write2XML(str(inp))
        sim.fdtd.SetTimeStep(0.);sim.fdtd.SetNumberOfTimeSteps(f.OPERATOR_STEPS)
        op=out/f'planned-p{port}-operator.xml';sim.fdtd.Write2XML(str(op))
        planned.append(dict(**m,input_sha256=f.sha(inp),operator_input_sha256=f.sha(op)))
    f.save(out/'plan.json',dict(source=record['source'],runtime=record['runtime'],ports=planned))
    f.save(out/'progress.json',record)
    try:
        for port in ((1,) if pilot_s is not None else (1,2)):
            if f.identity()!=record['source'] or f.runtime_identity()!=record['runtime']:raise ValueError('source/runtime changed')
            command=[sys.executable,'-m','tests.test_stub_lowpass_fixture','--worker','--mesh',str(n),
                     '--port',str(port),'--kind',kind,'--control',control,'--out',str(out/f'port{port}')]
            if pilot_s is not None:command.extend(('--pilot-seconds',str(pilot_s)))
            start,wall=time.monotonic(),time.time();code=None;failure=None
            with (out/f'port{port}.log').open('w',encoding='utf-8') as log:
                proc=popen_group(command,cwd=f.ROOT/'python',stdout=log,stderr=subprocess.STDOUT)
                record.update(status='running',active_port=port,active_launcher_pid=proc.pid);f.save(out/'progress.json',record)
                try:code=wait_owned(proc,seconds=1800.)
                except BaseException as error:failure=repr(error);raise
                finally:
                    if proc.poll() is None:terminate_group(proc.pid,grace=0,job=proc.win_job);proc.wait(timeout=15)
                    release_group(proc)
                    f.save(out/f'port{port}.worker.json',dict(command=command,pid=proc.pid,exit_code=code,failure=failure,
                        wall_seconds=time.time()-wall,monotonic_seconds=time.monotonic()-start,deadline_seconds=1800.,estimated_seconds=estimate))
            if code:raise RuntimeError(f'native worker exit {code}; partial evidence retained')
            folder=out/f'port{port}';report=json.loads((folder/'report.json').read_text())
            report.update(native_header=f.audit_header((out/f'port{port}.log').read_text(),report),native_log_sha256=f.sha(out/f'port{port}.log'))
            f.save(folder/'report.json',report);checks=f.quality(report)
            record['ports'].append(dict(port=port,quality=checks))
            if pilot_s is not None:
                native=report['native']
                if native['timesteps']!=meta['max_timesteps'] or native['iteration_wall_s']<=0 or not checks['grid'] or not checks['clock'] or not checks['geometry'] or not checks['operator'] or not checks['probes']:
                    raise ValueError('incomplete/invalid performance pilot; rate is not admissible')
                record.update(status='performance_only',rate_measured_mcps=native['cells']*native['timesteps']/native['iteration_wall_s']/1e6)
                return record
            if not all(checks.values()):raise ValueError(f'rejected native source: {checks}')
            f.read(folder)
        _,result=f.matrix(out);record.update(status='complete',result=result)
    except BaseException as error:record.update(status='rejected',reason=repr(error));raise
    finally:record.update(active_port=None,active_launcher_pid=None);f.save(out/'progress.json',record)
    return result


def study(root):
    root=Path(root);rows=[];missing=[];rejected=[];spectra={}
    for name,n,kind,control in configurations():
        folder=root/name
        if not all((folder/f'port{p}/report.json').is_file() for p in (1,2)):missing.append(name);continue
        try:s,row=f.matrix(folder)
        except (ValueError,AssertionError,FileNotFoundError) as error:rejected.append(dict(name=name,reason=repr(error)));continue
        spectra[name]=s;rows.append(dict(name=name,**row))
    meshes=[]
    for kind in f.KINDS:
        for a,b in zip(f.MESHES[:-1],f.MESHES[1:]):
            an,bn=f'n{a}_{kind}',f'n{b}_{kind}'
            if an not in spectra or bn not in spectra:continue
            delta=f.difference(spectra[bn],spectra[an]);meshes.append(dict(kind=kind,from_mesh=a,to_mesh=b,**delta,
                passes=delta['s_abs']<=f.LIMITS['s_mesh_abs'] and delta['phase_deg']<=f.LIMITS['phase_mesh_deg']))
    # Application attenuation/ripple/edge/delay resolution needs independent
    # background/time controls. Point S/phase or missing cohorts never certify it.
    result=dict(cohorts=rows,mesh_changes=meshes,missing=missing,rejected=rejected,qualified=False,
        note='Physical target, both mesh transitions, source/operator/probe checks, and all independent application/time/boundary controls are required. Point comparison alone is insufficient.')
    f.save(root/'study.json',result);return result


class StubReferenceTests(unittest.TestCase):
    def test_exact_nodal_vs_independent_abcd(self):
        np.testing.assert_allclose(f.reference(),f.independent_abcd(),atol=2e-13,rtol=0)

    def test_richards_magnitude_and_added_unit_phase(self):
        actual=f.reference();theta=np.pi*f.FREQUENCIES/(4*f.FC)
        omega=np.tan(theta);t3=4*omega**3-3*omega
        expected=1/np.sqrt(1+(10**(f.RIPPLE/10)-1)*t3**2)
        np.testing.assert_allclose(abs(actual[:,1,0]),expected,atol=3e-14)
        np.testing.assert_allclose(actual.conj().transpose(0,2,1)@actual,np.eye(2)[None]+np.zeros_like(actual),atol=3e-13)
        k=np.flatnonzero(f.FREQUENCIES==f.FC)[0]
        self.assertAlmostEqual(-20*np.log10(abs(actual[k,1,0])),3.,places=10)

    def test_circuit_and_dimensions_not_fitted_or_mesh_dependent(self):
        values=f.synthesis();d=f.dimensions()
        self.assertEqual(len(values['g']),3);self.assertTrue(all(g>0 for g in values['g']))
        self.assertAlmostEqual(d['unit']['width_mm'],.07425723702858214,places=12)
        for n in f.MESHES:
            _,_,meta=f.build(n,1);self.assertEqual(meta['dimensions'],d)

    def test_through_keeps_its_physical_feed_length(self):
        s=f.reference(kind='through');d=f.dimensions()
        delay=(2*d['unit']['length_mm']+8)*1e-3*np.sqrt(d['feed']['eps_eff'])/299792458.
        np.testing.assert_allclose(s[:,1,0],np.exp(-2j*np.pi*f.FREQUENCIES*delay),atol=2e-14)
        self.assertGreater(abs(s[:,1,0]-1).max(),1.)

    def test_invalid_reference_rejected(self):
        for values in ([0.],[-1.],[np.nan],[]):
            with self.assertRaises(ValueError):f.reference(values)
        with self.assertRaises(ValueError):f.reference(kind='invented')

    def test_application_metrics_do_not_infer_resolution_from_point_agreement(self):
        target=f.reference();row=f.application_errors(target,target)
        self.assertEqual(row['attenuation_db'],0.);self.assertEqual(row['group_delay_rel'],0.)
        self.assertFalse(row['independent_resolution_confirmed']);self.assertAlmostEqual(row['edge_rel'],0.)
        changed=target.copy();changed[:,1,0]*=.9;bad=f.application_errors(changed,target)
        self.assertGreater(bad['attenuation_db'],f.LIMITS['attenuation_db'])


class StubGeometryTests(unittest.TestCase):
    def test_all_grids_increase_and_native_cells_are_allocation_not_intervals(self):
        sizes=[]
        for n in f.MESHES:
            sim,ports,m=f.build(n,1);sizes.append(m['native_cells'])
            for axis in 'xyz':self.assertTrue(np.all(np.diff(sim.mesh.GetLines(axis))>0))
            self.assertEqual(m['native_cells'],np.prod(m['grid']));self.assertEqual(len(ports),2)
            self.assertEqual(set(m['expected_current_indices']),{f'i{p}_{c}_{j}' for p in range(2) for c in ('inner','outer') for j in range(2)})
            with self.assertRaises(ValueError):sim.to_bundle()
        self.assertTrue(np.all(np.diff(sizes)>0))

    def test_invalid_model_choices_rejected(self):
        for n in (True,1,2.,5):
            with self.assertRaises(ValueError):f.build(n,1)
        for port in (True,0,3):
            with self.assertRaises(ValueError):f.build(2,port)

    def test_independent_controls_change_only_declared_assumption(self):
        _,_,base=f.build(2,1)
        for control in f.CONTROLS[1:]:
            _,_,other=f.build(2,1,control=control)
            self.assertEqual(other['dimensions'],base['dimensions'])
            if control=='boundary':self.assertNotEqual(other['mesh_mm'],base['mesh_mm'])
            else:self.assertEqual(other['mesh_mm'],base['mesh_mm'])
        _,_,time_control=f.build(2,1,control='time')
        self.assertEqual(time_control['cap_s'],2*base['cap_s']);self.assertEqual(time_control['end_db'],base['end_db']-10)
        _,_,dt_control=f.build(2,1,control='dt');self.assertAlmostEqual(dt_control['declared_dt_s']/base['declared_dt_s'],.7)

    def test_frozen_xml_includes_ground_boundary_and_no_lumped_elements(self):
        with tempfile.TemporaryDirectory() as tmp:
            sim,_,m=f.build(2,1);p=Path(tmp)/'input.xml';sim.fdtd.Write2XML(str(p));root=ET.parse(p).getroot()
            bc=root.find('FDTD/BoundaryCond');self.assertEqual(bc.get('zmin'),'PEC')
            self.assertFalse(root.findall('.//LumpedElement'));self.assertEqual(len(root.findall('.//Material')),1)


class StubMeasurementTests(unittest.TestCase):
    def valid_metadata(self):
        _,_,m=f.build(2,1);steps=m['max_timesteps']-100;dt=m['declared_dt_s']
        usage={name:[True] for name in m['solids']}
        m.update(native=dict(cells=m['native_cells'],dt_s=dt,timesteps=steps,numerical_time_s=steps*dt),
            run=dict(grid=m['grid'],converged=True,hit_timestep_limit=False,final_energy_bound_db=m['end_db'],
                     threads=f.THREADS,engine='cpu',exact_endcriteria=True),
            operator_preflight=dict(setup_only=True,run=dict(timestep_s=2*dt),required_usage=deepcopy(usage)),
            required_usage=usage,actual_current_indices=deepcopy(m['expected_current_indices']),
            native_header=dict(version='v0.37.0-rc3',threads=f.THREADS),terminal_tail_db=-80.)
        return m

    def test_source_stopping_geometry_and_tail_are_independent_gates(self):
        meta=self.valid_metadata();self.assertTrue(all(f.quality(meta).values()))
        for key in ('converged','exact_endcriteria'):
            changed=deepcopy(meta);changed['run'][key]=False;self.assertFalse(all(f.quality(changed).values()))
        changed=deepcopy(meta);changed['native']['numerical_time_s']=meta['source_duration_s']/2
        self.assertFalse(f.quality(changed)['source'])
        changed=deepcopy(meta);changed['terminal_tail_db']=-40.;self.assertFalse(f.quality(changed)['tail'])
        changed=deepcopy(meta);changed['required_usage']['stub0']=[False];self.assertFalse(f.quality(changed)['geometry'])
        changed=deepcopy(meta);changed['actual_current_indices']['i0_inner_0'][0][1]+=1
        self.assertFalse(f.quality(changed)['probes'])

    def test_full_incident_matrix_required(self):
        s=f.reference();a=np.broadcast_to(np.array([[1.,.13j],[.07,1.]]),(len(f.FREQUENCIES),2,2))
        b=s@a;v=(np.sqrt(f.Z0)*(a+b)).transpose(2,1,0);i=((a-b)/np.sqrt(f.Z0)).transpose(2,1,0)
        actual,q=f.assemble(v,i);np.testing.assert_allclose(actual,s,atol=2e-14)
        self.assertGreater(q['incident_floor'],.1)
        with self.assertRaises(ValueError):f.assemble(v[:1],i[:1])
        with self.assertRaises(ValueError):f.assemble(np.zeros_like(v),np.zeros_like(i))

    def test_spatial_stagger_and_contour_disagreement(self):
        s=f.reference();a=np.broadcast_to(np.eye(2),(len(f.FREQUENCIES),2,2));b=s@a
        u=(np.sqrt(f.Z0)*(a+b)).transpose(2,1,0);ii=((a-b)/np.sqrt(f.Z0)).transpose(2,1,0)
        theta=.03;factor=np.cos(theta/2)
        v=np.stack((u*np.exp(.03j),u,u*np.exp(-.03j)),axis=2)
        current=np.broadcast_to(ii[:,:,None,None,:]*factor,(2,2,2,2,len(f.FREQUENCIES))).copy()
        got,qa=f.extract(v,current);np.testing.assert_allclose(got,s,atol=2e-13);self.assertLess(qa['contour_s_abs'],1e-14)
        current[:,:,1]*=1.02;_,qa=f.extract(v,current);self.assertGreater(qa['contour_s_abs'],f.LIMITS['contour_s_abs'])

    def test_complete_e_and_half_step_h_clocks(self):
        dt=4e-14;stride=int(1/(2*f.FREQUENCIES[-1]*dt))//f.OVERSAMPLING;steps=3*stride
        meta=dict(native=dict(dt_s=dt,numerical_time_s=steps*dt));times=np.arange(4)*stride*dt
        e=np.column_stack((times,np.ones(4)));h=e.copy();h[:,0]+=dt/2
        f.trace_clock(e,meta);f.trace_clock(h,meta,True)
        for bad in (e[:-1],e+np.array([dt,0.])):
            with self.assertRaises(ValueError):f.trace_clock(bad,meta)
        with self.assertRaises(ValueError):f.trace_clock(h,meta)

    def test_native_header_is_checked_after_marker(self):
        _,_,m=f.build(2,1);x,y,z=m['grid']
        text=f'{f.PROPAGATION_MARKER}\nopenEMS 64bit -- version v0.37.0-rc3\nfixed number of threads: {f.THREADS}\nFDTD simulation size: {x}x{y}x{z} --> {m["native_cells"]} FDTD cells'
        self.assertEqual(f.audit_header(text,m)['threads'],f.THREADS)
        for bad in (text.replace(f'threads: {f.THREADS}','threads: 8'),text+f.PROPAGATION_MARKER,text.replace('v0.37.0-rc3','unknown')):
            with self.assertRaises(ValueError):f.audit_header(bad,m)


class StubAcquisitionTests(unittest.TestCase):
    def test_long_forecast_refused_before_process_or_directory(self):
        with tempfile.TemporaryDirectory() as tmp,patch(__name__+'.popen_group') as launch:
            out=Path(tmp)/'must-not-exist'
            with self.assertRaises(ValueError):acquire_serial(out,n=4,rate=1.)
            launch.assert_not_called();self.assertFalse(out.exists())
        for rate in (0.,-1.,np.nan):
            with self.assertRaises(ValueError):forecast(dict(native_cells=1,max_timesteps=1),rate)

    def test_bad_pilot_not_launched(self):
        with tempfile.TemporaryDirectory() as tmp,patch(__name__+'.popen_group') as launch:
            for cap in (0.,1e-9,float('nan')):
                with self.assertRaises(ValueError):acquire_serial(Path(tmp)/'absent',pilot_s=cap)
            launch.assert_not_called()

    def test_failed_worker_retains_receipt_and_clears_active_pid(self):
        proc=Mock(pid=123,win_job=None);proc.poll.return_value=2
        with tempfile.TemporaryDirectory() as tmp,patch(__name__+'.popen_group',return_value=proc),patch(__name__+'.wait_owned',return_value=2),patch(__name__+'.release_group'):
            folder=Path(tmp)/'failed'
            with self.assertRaises(RuntimeError):acquire_serial(folder,rate=1000.)
            row=json.loads((folder/'progress.json').read_text());receipt=json.loads((folder/'port1.worker.json').read_text())
            self.assertEqual(row['status'],'rejected');self.assertIsNone(row['active_launcher_pid']);self.assertEqual(receipt['exit_code'],2)

    def test_missing_study_is_not_qualified(self):
        with tempfile.TemporaryDirectory() as tmp:
            row=study(tmp);self.assertFalse(row['qualified']);self.assertEqual(len(row['missing']),10)


def main():
    p=argparse.ArgumentParser(description=__doc__);mode=p.add_mutually_exclusive_group(required=True)
    for flag in ('preflight','fdtd','study','worker'):mode.add_argument('--'+flag,action='store_true')
    p.add_argument('--out',type=Path,required=True);p.add_argument('--mesh',type=int,choices=f.MESHES,default=2)
    p.add_argument('--kind',choices=f.KINDS,default='filter');p.add_argument('--control',choices=f.CONTROLS,default='ordinary')
    p.add_argument('--port',type=int,choices=(1,2),default=1);p.add_argument('--rate-mcps',type=float,default=20.)
    p.add_argument('--pilot-seconds',type=float)
    a=p.parse_args()
    if a.worker:f.acquire(a.out,a.mesh,a.port,a.kind,a.control,a.pilot_seconds);return
    if a.preflight:result=preflight(a.out,a.rate_mcps)
    elif a.fdtd:result=acquire_serial(a.out,a.mesh,a.kind,a.control,a.rate_mcps,a.pilot_seconds)
    else:result=study(a.out)
    print(json.dumps(result,indent=2,allow_nan=False))


if __name__=='__main__':
    if any('--'+s in sys.argv for s in ('preflight','fdtd','study','worker')):main()
    else:unittest.main()
