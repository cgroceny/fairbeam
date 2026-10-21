"""Pure regressions and opt-in, serial, bounded native research measurements.

From python/ in the openEMS environment:
python -m unittest tests.test_composite_lc_filter_fixture -q
python -m tests.test_composite_lc_filter_fixture --preflight --out C:/study/lc-plan-fresh
python -m tests.test_composite_lc_filter_fixture --fdtd --mesh 1 --kind through --out C:/study/lc-fresh/n1_through
python -m tests.test_composite_lc_filter_fixture --fdtd --mesh 1 --out C:/study/lc-fresh/n1_filter
python -m tests.test_composite_lc_filter_fixture --study --out C:/study/lc-fresh

Rate and I/O forecasts do not override the 30-minute owned worker deadline.
Raw fields stay outside Git. No unittest discovery starts native propagation.
"""
import argparse
from copy import deepcopy
import json
import os
import sys
import tempfile
import time
from pathlib import Path
import re
import subprocess
import unittest
from unittest.mock import Mock,patch
import xml.etree.ElementTree as ET
import numpy as np
from fairbeam.procutil import popen_group,release_group,terminate_group
from tests.test_coax_resonator import wait_owned
from tests import composite_lc_filter_fixture as f


def configurations():
    return [(f'n{n}_{kind}',n,kind,'ordinary') for n in f.MESHES for kind in f.KINDS]+[
        (f'n1_filter_{c}',1,'filter',c) for c in f.CONTROLS[1:]]


def forecast(meta,rate,io_s_per_mstep=40.):
    if not np.isfinite(rate) or rate<=0 or not np.isfinite(io_s_per_mstep) or io_s_per_mstep<0:
        raise ValueError('positive throughput and nonnegative source-I/O allowance required')
    return 1.15*meta['native_cells']*meta['max_timesteps']/(rate*1e6)+io_s_per_mstep*meta['max_timesteps']/1e6+20


def preflight(out,rate=85.,io=40.,threads=1):
    out=Path(out);out.mkdir(parents=True,exist_ok=False);rows=[]
    for name,n,kind,control in configurations():
        for port in (1,2):
            sim,meta=f.build(n,port,kind,control,threads);path=out/f'{name}_p{port}.xml';sim.fdtd.Write2XML(str(path))
            sim.fdtd.SetTimeStep(0.);sim.fdtd.SetNumberOfTimeSteps(f.OPERATOR_STEPS)
            operator=out/f'{name}_p{port}_operator.xml';sim.fdtd.Write2XML(str(operator))
            estimate=forecast(meta,rate,io)
            rows.append(dict(name=name,**meta,input_sha256=f.sha(path),operator_input_sha256=f.sha(operator),
                estimated_seconds=estimate,deferred=estimate>1800))
    result=dict(source=f.identity(),runtime=f.runtime_identity(),rows=rows,limits=f.LIMITS,
        rate_mcps=rate,io_s_per_mstep=io,native_propagations=0,qualified=False)
    f.save(out/'preflight.json',result);return result


def audit_header(text,meta):
    return f.audit_header(text,meta)


def acquire_serial(out,n=1,kind='filter',control='ordinary',threads=1,rate=85.,io=40.):
    out=Path(out).resolve()
    if out.exists():raise ValueError('fresh cohort directory required')
    _,meta=f.build(n,1,kind,control,threads);estimate=forecast(meta,rate,io)
    if estimate>1800:raise ValueError(f'forecast {estimate/60:.2f} min exceeds 30; defer this case')
    out.mkdir(parents=True,exist_ok=False)
    progress=dict(status='prepared',source=f.identity(),runtime=f.runtime_identity(),ports=[],qualified=False,
        estimated_seconds_per_source=estimate,rate_mcps=rate,io_s_per_mstep=io,active_launcher_pid=None)
    f.save(out/'progress.json',progress)
    try:
        for port in (1,2):
            if f.identity()!=progress['source'] or f.runtime_identity()!=progress['runtime']:raise ValueError('source/runtime changed before launch')
            command=[sys.executable,'-m','tests.test_composite_lc_filter_fixture','--worker','--mesh',str(n),
                '--port',str(port),'--kind',kind,'--control',control,'--threads',str(threads),'--out',str(out/f'port{port}')]
            code=None;failure=None;start,wall=time.monotonic(),time.time()
            with (out/f'port{port}.log').open('w',encoding='utf-8') as log:
                proc=popen_group(command,cwd=f.ROOT/'python',stdout=log,stderr=subprocess.STDOUT,
                    env={**os.environ,'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1'})
                progress.update(status='running',active_port=port,active_launcher_pid=proc.pid);f.save(out/'progress.json',progress)
                try:code=wait_owned(proc,seconds=1800.)
                except BaseException as error:failure=repr(error);raise
                finally:
                    if proc.poll() is None:terminate_group(proc.pid,grace=0,job=proc.win_job);proc.wait(timeout=15)
                    release_group(proc)
                    f.save(out/f'port{port}.worker.json',dict(command=command,pid=proc.pid,exit_code=code,failure=failure,
                        wall_seconds=time.time()-wall,monotonic_seconds=time.monotonic()-start,deadline_seconds=1800.,estimated_seconds=estimate))
            if code:raise RuntimeError(f'native worker exit {code}; retain partial evidence')
            folder=out/f'port{port}';report=json.loads((folder/'report.json').read_text())
            report.update(native_header=audit_header((out/f'port{port}.log').read_text(),report),
                native_log_sha256=f.sha(out/f'port{port}.log'));f.save(folder/'report.json',report)
            meta,_,_,quality=f.read(folder);progress['ports'].append(dict(port=port,quality=quality))
            if not all(quality.values()):raise ValueError(f'rejected native source: {quality}')
        _,result=f.matrix(out);progress.update(status='complete',result=result)
    except BaseException as error:
        progress.update(status='rejected',reason=repr(error));raise
    finally:
        progress.update(active_launcher_pid=None,active_port=None);f.save(out/'progress.json',progress)
    return result


def study(root):
    root=Path(root);cohorts=[];data={};missing=[];rejected=[]
    for name,n,kind,control in configurations():
        folder=root/name
        if not all((folder/f'port{p}/report.json').is_file() for p in (1,2)):missing.append(name);continue
        try:s,result=f.matrix(folder)
        except (ValueError,AssertionError,FileNotFoundError) as error:rejected.append(dict(name=name,reason=repr(error)));continue
        data[name]=s;cohorts.append(dict(name=name,**result))
    meshes=[];controls={};mask=abs(f.reference()[:,1,0])>=.01
    for kind in f.KINDS:
        for a,b in zip(f.MESHES,f.MESHES[1:]):
            names=(f'n{a}_{kind}',f'n{b}_{kind}')
            if not all(name in data for name in names):continue
            domain=mask if kind=='filter' else np.full(len(f.FREQUENCIES),kind=='through',bool)
            difference=f.response_difference(*(data[name] for name in names),domain)
            meshes.append(dict(kind=kind,meshes=[a,b],**difference,passes=difference['s_abs']<=f.LIMITS['s_mesh_abs']
                and (kind=='open' or difference['phase_deg']<=f.LIMITS['phase_mesh_deg'])))
    if 'n1_filter' in data:
        for c in f.CONTROLS[1:]:
            if 'n1_filter_'+c not in data:continue
            difference=f.response_difference(data['n1_filter_'+c],data['n1_filter'],mask)
            controls[c]=dict(**difference,passes=difference['s_abs']<=f.LIMITS['s_control_abs'] and difference['phase_deg']<=f.LIMITS['phase_control_deg'],
                scope='model-assumption diagnostic' if c in ('scale','enclosure') else 'numerical control')
    # Filter qualification also needs attenuation/feature/delay resolution, not
    # just a complex-S tolerance. Those application gates are deliberately not
    # certified by this first research fixture.
    return dict(scope=f.SCOPE,limits=f.LIMITS,cohorts=cohorts,missing=missing,rejected=rejected,
        mesh_changes=meshes,controls=controls,application_resolution_qualified=False,qualified=False)


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


class CompositeMeasurementTests(unittest.TestCase):
    def test_full_incident_matrix_with_reverse_incident_waves(self):
        s=f.reference();incoming=np.broadcast_to(np.array([[1,.12j],[.1-.04j,.8]]),(len(f.FREQUENCIES),2,2))
        outgoing=s@incoming
        v=(np.sqrt(f.R0)*(incoming+outgoing)).transpose(2,1,0)
        i=((incoming-outgoing)/np.sqrt(f.R0)).transpose(2,1,0)
        actual,quality=f.assemble(v,i);np.testing.assert_allclose(actual,s,atol=5e-16)
        self.assertGreater(quality['incident_floor'],.1)
        with self.assertRaises(ValueError):f.assemble(v[:1],i[:1])
        with self.assertRaises(ValueError):f.assemble(v*0,i*0)
        v[1]=v[0];i[1]=i[0]
        with self.assertRaises(ValueError):f.assemble(v,i)

    def test_unresolved_zero_has_no_phase_claim(self):
        s=f.reference(kind='open');difference=f.response_difference(s,s,np.zeros(len(f.FREQUENCIES),bool))
        self.assertIsNone(difference['phase_deg']);self.assertEqual(difference['s_abs'],0.)

    def test_expected_uniform_grid_yee_indices(self):
        _,meta=f.build(1,1);layout=f.probe_layout(meta)
        self.assertEqual(f.expected_indices(meta,layout['port_ut_1']),[[4,5,1],[4,5,3]])
        self.assertEqual(f.expected_indices(meta,layout['port_it_1']),[[2,4,1],[5,6,1]])
        self.assertEqual(f.expected_indices(meta,layout['lc_i_L01']),[[5,1,2],[5,6,4]])
        self.assertEqual(f.expected_indices(meta,layout['lc_i_C7g']),[[2,1,1],[5,3,1]])
        self.assertEqual(f.expected_indices(meta,layout['lc_v_C7g']),[[4,2,1],[4,2,2]])

    def test_probe_clock_rejects_missing_or_shifted_half_step(self):
        _,meta=f.build(1,1);dt=meta['declared_dt_s'];stride=int(1/(2*f.FREQUENCIES[-1]*dt))//f.OVERSAMPLING
        meta['native']=dict(dt_s=dt,numerical_time_s=3*stride*dt)
        trace=np.column_stack(((np.arange(4)*stride+.5)*dt,np.arange(4)))
        self.assertEqual(f.trace_clock(trace,meta,True)['offset_steps'],.5)
        with self.assertRaises(ValueError):f.trace_clock(trace,meta,False)
        with self.assertRaises(ValueError):f.trace_clock(trace[:-1],meta,True)
        trace[2,0]+=dt
        with self.assertRaises(ValueError):f.trace_clock(trace,meta,True)

    def test_chunked_source_verification_and_truncation(self):
        dt=1e-11;steps=180000;t=np.arange(steps)*dt;tau=1/(np.sqrt(2)*np.pi*f.FREQUENCIES[-1]/2.76)
        x=(t-float(f'{5*tau:.6e}'))/float(f'{tau:.6e}');v=-float(f'{np.sqrt(2*np.e):.8f}')*x*np.exp(-x*x)
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'et';np.savetxt(path,np.column_stack((t,v)))
            meta=dict(max_timesteps=steps,native=dict(dt_s=dt))
            self.assertLess(f.source_trace_info(path,meta)['waveform_error_rel'],1e-14)
            with self.assertRaises(ValueError):f.source_trace_info(path,{**meta,'max_timesteps':steps+2})
            v[70000]+=.01;np.savetxt(path,np.column_stack((t,v)))
            with self.assertRaises(ValueError):f.source_trace_info(path,meta)

    def test_late_terminal_energy_detects_a_retained_mode(self):
        _,meta=f.build(1,1);t=np.linspace(0,20e-6,2001)
        def traces(damping):
            value=np.exp(-damping*t)*np.sin(2*np.pi*1e6*t)
            return {key:np.column_stack((t,value)) for e in meta['elements'] for key in ('lc_v_'+e['name'],'lc_i_'+e['name'])}
        self.assertGreater(f.terminal_energy(traces(0),meta)['end_db'],-.1)
        self.assertLess(f.terminal_energy(traces(1e6),meta)['end_db'],-100.)


class CompositeAdmissionTests(unittest.TestCase):
    def valid(self,control='ordinary'):
        _,meta=f.build(1,1,control=control);dt=meta['declared_dt_s']
        names=set(meta['solids'])|{e['name'] for e in meta['elements']}|{'port_resist_1','port_resist_2','port_excite_1'}
        usage={name:[True] for name in names};steps=meta['max_timesteps'] if control=='time' else int(60e-6/dt)
        meta.update(native=dict(cells=meta['native_cells'],dt_s=dt,timesteps=steps,numerical_time_s=steps*dt),
            run=dict(grid=meta['grid'],converged=control!='time'),required_usage=usage,
            terminal_energy=dict(available=True,end_db=-110.),native_header=dict(version='v0.37.0-rc3',threads=1,nyquist_interval=int(1/(2*f.FREQUENCIES[-1]*dt))))
        meta['operator_preflight']=dict(setup_only=True,planned_dt_s=dt,required_usage=deepcopy(usage),run=dict(grid=meta['grid'],threads=1,timestep_s=2*dt))
        return meta

    def test_native_checks_are_independent_and_forced_time_is_not_energy_convergence(self):
        ordinary=self.valid();forced=self.valid('time')
        self.assertTrue(all(f.quality(ordinary).values()));self.assertTrue(all(f.quality(forced).values()))
        self.assertFalse(forced['run']['converged']);self.assertEqual(forced['native']['timesteps'],forced['max_timesteps'])
        for key,value in (('converged',False),):
            changed=deepcopy(ordinary);changed['run'][key]=value;self.assertFalse(f.quality(changed)['stopping'])
        changed=deepcopy(ordinary);changed['terminal_energy']['end_db']=-40.;self.assertFalse(f.quality(changed)['terminal_energy'])
        changed=deepcopy(ordinary);changed['required_usage']['L01']=[False];self.assertFalse(f.quality(changed)['geometry'])
        changed=deepcopy(ordinary);changed['operator_preflight']['run']['timestep_s']=ordinary['declared_dt_s']*.9
        self.assertFalse(f.quality(changed)['operator'])

    def test_native_header_requires_correct_threads_and_schedule(self):
        meta=self.valid();text=f.PROPAGATION_MARKER+'\nopenEMS 64bit -- version v0.37.0-rc3\nfixed number of threads: 1\nFDTD simulation size: 33x9x7 --> 2079 FDTD cells\nExact-endcriteria: evaluating the end criteria every '+str(meta['native_header']['nyquist_interval'])+' timestep(s)'
        self.assertEqual(audit_header(text,meta),meta['native_header'])
        for wrong in (text.replace('threads: 1','threads: 4'),text.replace('2079','2000'),text+f.PROPAGATION_MARKER):
            with self.assertRaises(ValueError):audit_header(wrong,meta)

    def test_long_forecast_refused_before_any_directory_or_process(self):
        with tempfile.TemporaryDirectory() as tmp,patch(__name__+'.popen_group') as launch:
            folder=Path(tmp)/'must-not-exist'
            with self.assertRaises(ValueError):acquire_serial(folder,n=3)
            self.assertFalse(folder.exists());launch.assert_not_called()
        for value in (0.,float('nan'),-1.):
            with self.assertRaises(ValueError):forecast(dict(native_cells=1,max_timesteps=1),value)

    def test_failed_worker_clears_running_state_and_preserves_receipt(self):
        proc=Mock(pid=123,win_job=None);proc.poll.return_value=2
        with tempfile.TemporaryDirectory() as tmp,patch(__name__+'.popen_group',return_value=proc),patch(__name__+'.wait_owned',return_value=2),patch(__name__+'.release_group'):
            folder=Path(tmp)/'failed'
            with self.assertRaises(RuntimeError):acquire_serial(folder,kind='through')
            status=json.loads((folder/'progress.json').read_text());receipt=json.loads((folder/'port1.worker.json').read_text())
            self.assertEqual(status['status'],'rejected');self.assertIsNone(status['active_launcher_pid']);self.assertEqual(receipt['exit_code'],2)

    def test_missing_study_does_not_qualify(self):
        with tempfile.TemporaryDirectory() as tmp:
            result=study(tmp);self.assertEqual(len(result['missing']),13);self.assertFalse(result['qualified'])


def main():
    p=argparse.ArgumentParser(description=__doc__)
    mode=p.add_mutually_exclusive_group(required=True)
    for flag in ('preflight','fdtd','study','worker'):mode.add_argument('--'+flag,action='store_true')
    p.add_argument('--out',type=Path,required=True);p.add_argument('--mesh',type=int,choices=f.MESHES,default=1)
    p.add_argument('--kind',choices=f.KINDS,default='filter');p.add_argument('--control',choices=f.CONTROLS,default='ordinary')
    p.add_argument('--port',type=int,choices=(1,2),default=1);p.add_argument('--threads',type=int,choices=f.THREAD_CHOICES,default=1)
    p.add_argument('--rate-mcps',type=float,default=85.);p.add_argument('--io-s-per-mstep',type=float,default=40.)
    a=p.parse_args()
    if a.worker:f.acquire(a.out,a.mesh,a.port,a.kind,a.control,a.threads);return
    if a.preflight:result=preflight(a.out,a.rate_mcps,a.io_s_per_mstep,a.threads)
    elif a.fdtd:result=acquire_serial(a.out,a.mesh,a.kind,a.control,a.threads,a.rate_mcps,a.io_s_per_mstep)
    else:result=study(a.out);f.save(a.out/'study.json',result)
    print(json.dumps(result,indent=2,allow_nan=False))


if __name__=='__main__':
    if any('--'+s in sys.argv for s in ('preflight','fdtd','study','worker')):main()
    else:unittest.main()
