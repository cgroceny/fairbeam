"""Pure controls for the opt-in coupled-stripline research fixture.

Native acquisition is deliberately excluded from default unittest discovery.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import numpy as np

from tests import coupled_stripline_fixture as f
from tests.stripline_fixture import impedance
from fairbeam.procutil import popen_group, release_group, terminate_group
from tests.test_coax_resonator import wait_owned


def forecast(meta,rate):
    if isinstance(rate,bool) or not np.isfinite(rate) or rate<=0:
        raise ValueError('positive finite conservative throughput required')
    return 20+1.15*meta['native_cells']*meta['max_timesteps']/(rate*1e6)


def audit_header(text,meta):
    text=text.rsplit(f.PROPAGATION_MARKER,1)[-1]
    if re.search(r'forced timestep:.*larger than calculated timestep',text):
        raise ValueError('forced step exceeds native stability bound')
    grid=re.search(r'FDTD simulation size: (\d+)x(\d+)x(\d+) --> (\d+) FDTD cells',text)
    interval=re.search(r'Exact-endcriteria: evaluating the end criteria every (\d+) timestep',text)
    pulse=re.search(r'Excitation signal length is: (\d+) timesteps',text)
    if ('openEMS 64bit -- version v0.37.0-rc3' not in text or not grid or not interval or not pulse
            or f'fixed number of threads: {f.THREADS}' not in text):
        raise ValueError('complete native runtime/grid/clock/source header required')
    if list(map(int,grid.groups()[:3]))!=meta['native_lines'] or int(grid[4])!=meta['native_cells']:
        raise ValueError('native grid differs from preflight')
    if int(interval[1])!=int(1/(2*f.FREQUENCIES[-1]*meta['native']['dt_s'])) or int(pulse[1])!=meta['max_timesteps']:
        raise ValueError('native probe/source clock differs from preflight')
    return dict(version='v0.37.0-rc3',threads=f.THREADS,nyquist_interval=int(interval[1]),
                excitation_timesteps=int(pulse[1]))


def acquire_serial(out,n,rate=40.,control='ordinary'):
    out=Path(out).resolve()
    if out.exists():
        raise ValueError('fresh output directory required')
    _,meta=f.build(n,1,control=control)
    estimate=forecast(meta,rate)
    if estimate>1800:
        raise ValueError(f'forecast {estimate/60:.2f} min per port exceeds 30; defer before launch')
    out.mkdir(parents=True)
    source,runtime=f.identity(),f.runtime_identity()
    progress=dict(status='prepared',n=n,control=control,source_sha256=source,runtime=runtime,
                  limits=f.LIMITS,estimated_seconds_per_port=estimate,rate_assumption_mcps=rate,ports=[])
    f.save(out/'progress.json',progress)
    for port in range(1,5):
        if source!=f.identity() or runtime!=f.runtime_identity():
            raise RuntimeError('source/runtime changed between excitations')
        destination=out/f'port{port}'
        command=[sys.executable,'-m','tests.test_coupled_stripline_fixture','--fdtd','--worker-case',
                 '--mesh',str(n),'--port',str(port),'--control',control,'--out',str(destination)]
        start,wall=time.monotonic(),time.time()
        code,failure=None,None
        with (out/f'port{port}.log').open('w',encoding='utf-8') as log:
            proc=popen_group(command,cwd=f.ROOT/'python',stdout=log,stderr=subprocess.STDOUT,
                             env={**os.environ,'OMP_NUM_THREADS':'4','OPENBLAS_NUM_THREADS':'1'})
            progress.update(status='running',active_port=port,active_launcher_pid=proc.pid)
            f.save(out/'progress.json',progress)
            try:
                code=wait_owned(proc,seconds=1800.)
            except BaseException as error:
                failure=repr(error)
                raise
            finally:
                if proc.poll() is None:
                    terminate_group(proc.pid,grace=0,job=proc.win_job)
                    proc.wait(timeout=15)
                release_group(proc)
                f.save(out/f'port{port}.worker.json',dict(command=command,pid=proc.pid,exit_code=code,
                    failure=failure,wall_seconds=time.time()-wall,monotonic_seconds=time.monotonic()-start,
                    deadline_seconds=1800.,estimated_seconds=estimate))
                if failure or code:
                    progress.update(status='failed',reason=failure or f'worker exit {code}',qualified=False,active_launcher_pid=None)
                    f.save(out/'progress.json',progress)
        if code:
            raise RuntimeError('native worker failed; retain its log and raw input')
        try:
            report=json.loads((destination/'report.json').read_text(encoding='utf-8'))
            report['native_header']=audit_header((out/f'port{port}.log').read_text(encoding='utf-8'),report)
            f.save(destination/'report.json',report)
            *_,quality=f.read(destination)
            if not all(quality.values()):
                raise ValueError('native grid/clock/source/energy audit failed; no next source')
        except BaseException as error:
            progress.update(status='rejected',reason=repr(error),qualified=False,active_launcher_pid=None)
            f.save(out/'progress.json',progress)
            raise
        progress['ports'].append(dict(port=port,quality=quality))
        f.save(out/'progress.json',progress)
    _,result=f.matrix(out)
    progress.update(status='complete',active_port=None,active_launcher_pid=None,
                    completed_utc=datetime.now(timezone.utc).isoformat())
    f.save(out/'progress.json',progress)
    return result


def synthetic():
    """Independent exact uniform fields with mixed incoming source columns."""
    target=f.reference()
    a=np.broadcast_to(np.eye(4)+.08j*np.ones((4,4)),target.shape)
    b=target@a
    voltage=(np.sqrt(f.Z0)*(a+b)).transpose(2,1,0)
    entering=((a-b)/np.sqrt(f.Z0)).transpose(2,1,0)
    gamma=2j*np.pi*f.FREQUENCIES*np.sqrt(f.ER)/f.C0
    dx=f.geometry()['length_mm']/(8*4)*1e-3
    z=np.array(f.geometry()['modal_impedances_ohm'])[:,None]
    q=np.array([[1,1],[1,-1]])/np.sqrt(2)
    v=np.zeros((4,4,3,len(f.FREQUENCIES)),complex)
    current=np.zeros((4,4,2,2,len(f.FREQUENCIES)),complex)
    for ids,sign in (((0,3),1),((1,2),-1)):
        vm=np.einsum('mc,ecf->emf',q,voltage[:,ids])
        im=np.einsum('mc,ecf->emf',q,sign*entering[:,ids])
        for j,x in enumerate((-dx,0.,dx)):
            value=vm*np.cosh(gamma*x)-z*im*np.sinh(gamma*x)
            v[:,ids,j]=np.einsum('cm,emf->ecf',q.T,value)
        for j,x in enumerate((-dx/2,dx/2)):
            value=im*np.cosh(gamma*x)-vm/z*np.sinh(gamma*x)
            for loop in (0,1):
                current[:,ids,j,loop]=np.einsum('cm,emf->ecf',q.T,value)
    return v,current,dx,target


class CoupledStriplineControls(unittest.TestCase):
    def test_conformal_map_inverse_and_isolated_strip_limit(self):
        g=f.geometry()
        np.testing.assert_allclose(f.impedances(g['width_mm'],g['gap_mm']),
                                   g['modal_impedances_ohm'],rtol=0,atol=3e-13)
        self.assertAlmostEqual(g['width_mm'],2.5938277250430373,places=12)
        self.assertAlmostEqual(g['gap_mm'],.9807882793153582,places=12)
        self.assertAlmostEqual(g['length_mm'],16.843336162593108,places=12)
        isolated=impedance(g['width_mm']/f.B,f.ER)
        np.testing.assert_allclose(f.impedances(g['width_mm'],100*f.B),isolated,atol=1e-13)

    def test_reference_matches_separate_closed_form_and_is_unitary_reciprocal(self):
        s=f.reference()
        theta=np.pi*f.FREQUENCIES/(2*f.F0)
        t=np.sqrt(1-f.COUPLING**2)
        den=t*np.cos(theta)+1j*np.sin(theta)
        np.testing.assert_allclose(s[:,1,0],t/den,atol=8e-16)
        np.testing.assert_allclose(s[:,3,0],1j*f.COUPLING*np.sin(theta)/den,atol=8e-16)
        self.assertLess(abs(s[:,(0,2),0]).max(),2e-15)
        np.testing.assert_allclose(s,s.transpose(0,2,1),atol=5e-16)
        np.testing.assert_allclose(s@s.conj().transpose(0,2,1),np.broadcast_to(np.eye(4),s.shape),atol=2e-15)
        center=f.reference([f.F0])[0]
        self.assertAlmostEqual(center[3,0],.1,places=14)
        self.assertAlmostEqual(center[1,0],-1j*np.sqrt(.99),places=14)

    def test_full_inverse_and_measured_staggering_recover_all_source_columns(self):
        v,i,dx,target=synthetic()
        actual,row=f.extract(v,i,dx)
        np.testing.assert_allclose(actual,target,atol=3e-14,rtol=0)
        self.assertLess(row['contour_s_abs'],1e-14)
        self.assertLess(row['recurrence_residual'],1e-14)
        self.assertGreater(row['staggering_s_abs'],1e-4)
        # acosh near one amplifies roundoff in the three-voltage recurrence.
        np.testing.assert_allclose(row['gamma_per_m'],
            np.broadcast_to(2j*np.pi*f.FREQUENCIES*np.sqrt(f.ER)/f.C0,(2,2,len(f.FREQUENCIES))),atol=1e-11,rtol=3e-12)
        z=np.array(f.geometry()['modal_impedances_ohm'])[None,None,:,None]
        np.testing.assert_allclose(row['modal_z_ohm'],np.broadcast_to(z,(2,2,2,len(f.FREQUENCIES))),atol=1e-11,rtol=3e-12)

    def test_the_extractor_does_not_force_a_wrong_impedance_toward_the_reference(self):
        v,i,dx,target=synthetic()
        actual,row=f.extract(v,1.1*i,dx)
        self.assertGreater(abs(actual-target).max(),.04)
        target_z=np.array(f.geometry()['modal_impedances_ohm'])[None,None,:,None]
        np.testing.assert_allclose(row['modal_z_ohm'],np.broadcast_to(target_z/1.1,(2,2,2,len(f.FREQUENCIES))),atol=1e-11,rtol=3e-12)

    def test_independent_current_contour_disagreement_remains_visible(self):
        v,i,dx,_=synthetic()
        i[:,:,:,1]*=1.01
        _,row=f.extract(v,i,dx)
        self.assertGreater(row['contour_s_abs'],f.LIMITS['contour_s_abs'])

    def test_missing_modes_nodes_and_invalid_arrays_are_refused(self):
        v,i,dx,_=synthetic()
        for bad_v,bad_i,spacing in ((v*0,i*0,dx),(v*np.nan,i,dx),(v,i,0.),(v[:3],i,dx)):
            with self.assertRaises(ValueError):
                f.extract(bad_v,bad_i,spacing)
        v[:,:,1]=0
        with self.assertRaisesRegex(ValueError,'node'):
            f.extract(v,i,dx)

    def test_fixed_geometry_and_grouped_two_ground_feeds(self):
        geometry=f.geometry()
        for n in f.MESHES:
            for p in range(1,5):
                sim,row=f.build(n,p)
                self.assertEqual(row['geometry'],geometry)
                self.assertEqual(row['voltage_planes_mm'],[-geometry['length_mm']/2,geometry['length_mm']/2])
                self.assertEqual([port['number'] for port in sim.ports if port['excite']],[p])
                self.assertEqual(len(sim._port_objs),4)
                self.assertTrue(all(len(obj.members)==2 for obj in sim._port_objs))
                for logical in sim.ports:
                    self.assertEqual(logical['R'],50.)
                    self.assertEqual(logical['group']['connection'],'parallel')
                    self.assertEqual(logical['group']['members'][0]['polarity'],-1)
                for axis in 'xyz':
                    lines=np.array(row['mesh_mm'][axis])
                    self.assertGreater(np.diff(lines).min(),0.)
                    np.testing.assert_allclose(lines,-lines[::-1],atol=1e-12,rtol=0)
                self.assertLess(row['ampere_heights_mm'][0],row['ampere_heights_mm'][1])
                self.assertLess(row['ampere_heights_mm'][1],f.B/2)

    def test_controls_preserve_measurement_planes_and_interior_grid(self):
        _,a=f.build(f.CONTROL_MESH,1)
        for kind in f.CONTROLS[1:]:
            _,b=f.build(f.CONTROL_MESH,1,control=kind)
            self.assertEqual(a['geometry'],b['geometry'])
            self.assertEqual(a['voltage_planes_mm'],b['voltage_planes_mm'])
            for axis in 'xyz':
                old,new=np.array(a['mesh_mm'][axis]),np.array(b['mesh_mm'][axis])
                np.testing.assert_array_equal(new[(new>=old[0])&(new<=old[-1])],old)
            if kind!='dt':
                self.assertEqual(a['declared_dt_s'],b['declared_dt_s'])
            if kind=='guard':
                self.assertGreater(b['source_distance_mm'],a['source_distance_mm'])
            else:
                self.assertEqual(b['source_distance_mm'],a['source_distance_mm'])
        _,time=f.build(f.CONTROL_MESH,1,control='time')
        self.assertEqual(time['end_db'],-90.)
        self.assertGreater(time['cap_s'],a['cap_s'])
        _,dt=f.build(f.CONTROL_MESH,1,control='dt')
        self.assertLess(dt['declared_dt_s'],a['declared_dt_s'])

    def test_undeclared_choices_are_refused(self):
        for n,p,control in ((True,1,'ordinary'),(5,1,'ordinary'),(4,True,'ordinary'),
                            (4,0,'ordinary'),(4,1,'unknown')):
            with self.assertRaises(ValueError):
                f.build(n,p,control=control)
        for freq in ([],[0.],[np.nan],[6e9]):
            with self.assertRaises(ValueError):
                f.reference(freq)

    def test_unsafe_native_operator_stops_before_field_propagation(self):
        _,meta=f.build(4,1)
        native=dict(timestep_s=.95*meta['declared_dt_s'],grid=meta['native_lines'],threads=4,
                    engine='cpu',exact_endcriteria=True,converged=False,energy_trace=[])
        with tempfile.TemporaryDirectory() as temp,patch.object(f,'runtime_identity',return_value={}), \
                patch.object(f.Simulation,'run',return_value=native) as run:
            out=Path(temp)/'unsafe'
            with self.assertRaisesRegex(ValueError,'native stability'):
                f.acquire(out,4,1)
            self.assertEqual(run.call_count,1)
            self.assertTrue(run.call_args.kwargs['setup_only'])
            self.assertFalse((out/'raw').exists())
            self.assertFalse((out/'waves.npz').exists())
            self.assertFalse(json.loads((out/'operator.json').read_text())['passes'])

    def test_over_budget_is_refused_before_directory_or_worker(self):
        with tempfile.TemporaryDirectory() as temp,patch(__name__+'.popen_group') as start:
            out=Path(temp)/'not-created'
            with self.assertRaisesRegex(ValueError,'exceeds 30'):
                acquire_serial(out,8,.01)
            self.assertFalse(out.exists());start.assert_not_called()
        for rate in (True,0,-1,np.nan):
            with self.assertRaises(ValueError):
                forecast({},rate)

    def test_native_header_and_field_sampling_clock_are_checked(self):
        _,meta=f.build(4,1)
        meta['native']=dict(dt_s=meta['declared_dt_s'],numerical_time_s=2e-9)
        interval=int(1/(2*f.FREQUENCIES[-1]*meta['declared_dt_s']))
        shape='x'.join(str(v) for v in meta['native_lines'])
        text=(f'openEMS 64bit -- version v0.37.0-rc3\nfixed number of threads: 4\n'
            f'FDTD simulation size: {shape} --> {meta["native_cells"]} FDTD cells\n'
            f'Exact-endcriteria: evaluating the end criteria every {interval} timestep\n'
            f'Excitation signal length is: {meta["max_timesteps"]} timesteps\n')
        self.assertEqual(audit_header(text,meta)['nyquist_interval'],interval)
        with self.assertRaisesRegex(ValueError,'clock'):
            audit_header(text.replace(f'{interval} timestep','1 timestep'),meta)
        with self.assertRaisesRegex(ValueError,'stability'):
            audit_header('forced timestep: 1 ps larger than calculated timestep',{})
        dt=meta['declared_dt_s'];stride=int(1/(2*f.FREQUENCIES[-1]*dt*4))
        data=np.column_stack((np.arange(12)*stride*dt,np.ones(12)))
        self.assertEqual(f.trace_clock(data,meta)['stride_steps'],stride)
        for bad in (data*[2,1],data*np.nan,np.vstack((data[:5],data[4:]))):
            with self.assertRaises(ValueError):
                f.trace_clock(bad,meta)

    def test_last_passing_mesh_does_not_hide_missing_earlier_convergence(self):
        ref=f.reference()
        def fake(path):
            name=path.name;n=int(name[1:].split('_')[0])
            control=name.split('_')[1] if '_' in name else 'ordinary'
            s=ref.copy()
            if n==4:
                s[:,0,0]+=.01
            return s,dict(n=n,control=control,all_native_complete=True,target_passes=True,
                          contour_s_abs=0.,recurrence_residual=0.)
        with tempfile.TemporaryDirectory() as temp,patch.object(f,'matrix',side_effect=fake):
            row=f.study(temp)
        self.assertFalse(row['qualified'])
        self.assertFalse(row['directivity_qualified'])
        self.assertGreater(row['mesh_changes'][0]['s_abs'],f.LIMITS['s_mesh_abs'])
        self.assertEqual(row['mesh_changes'][1]['s_abs'],0.)

    def test_energy_cap_and_missing_source_completion_prevent_native_acceptance(self):
        _,meta=f.build(4,1)
        steps=20000;dt=meta['declared_dt_s']
        meta['native']=dict(cells=meta['native_cells'],dt_s=dt,timesteps=steps,numerical_time_s=steps*dt)
        meta['run']=dict(grid=meta['native_lines'],converged=True,exact_endcriteria=True,threads=4)
        meta['native_header']=dict(version='v0.37.0-rc3',threads=4,
            nyquist_interval=int(1/(2*f.FREQUENCIES[-1]*dt)),excitation_timesteps=meta['max_timesteps'])
        meta['operator_preflight']=dict(setup_only=True,ratio_limit=f.NATIVE_STEP_RATIO_MAX,planned_dt_s=dt,
            run=dict(timestep_s=2*dt,grid=meta['native_lines'],threads=4,engine='cpu',
                     exact_endcriteria=True,converged=False,energy_trace=[]))
        self.assertTrue(all(f.quality(meta).values()))
        meta['run']['hit_timestep_limit']=True
        self.assertFalse(f.quality(meta)['energy'])
        meta['native']['numerical_time_s']=meta['source_duration_s']/2
        self.assertFalse(f.quality(meta)['source'])
        meta['operator_preflight']['run']['timestep_s']=dt
        self.assertFalse(f.quality(meta)['operator'])

    def test_allocated_source_has_its_own_text_precision_not_a_field_clock(self):
        _,meta=f.build(4,1)
        dt=meta['declared_dt_s'];meta['native']=dict(dt_s=dt)
        data=np.column_stack((np.arange(meta['max_timesteps'])*dt,np.zeros(meta['max_timesteps'])))
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'et'
            np.savetxt(path,data,fmt='%.6g')
            self.assertEqual(f.source_trace_info(path,meta)['samples'],meta['max_timesteps'])
            np.savetxt(path,data*[1.01,1.],fmt='%.6g')
            with self.assertRaisesRegex(ValueError,'timestamps'):
                f.source_trace_info(path,meta)

    def test_native_audit_failure_retains_receipt_and_stops_next_source(self):
        class Worker:
            pid,win_job=777,None
            def wait(self,timeout=None): return 0
            def poll(self): return 0
        with tempfile.TemporaryDirectory() as temp:
            out=Path(temp)/'cohort'
            def launch(command,**options):
                dest=Path(command[command.index('--out')+1]);dest.mkdir()
                f.save(dest/'report.json',{})
                return Worker()
            with patch(__name__+'.popen_group',side_effect=launch) as start, \
                    patch(__name__+'.release_group'),patch(__name__+'.audit_header',return_value={}), \
                    patch.object(f,'read',return_value=(None,None,None,dict(energy=False))):
                with self.assertRaisesRegex(ValueError,'native grid'):
                    acquire_serial(out,4,40.)
                self.assertEqual(start.call_count,1)
            row=json.loads((out/'progress.json').read_text())
            self.assertEqual(row['status'],'rejected')
            self.assertIsNone(row['active_launcher_pid'])
            self.assertTrue((out/'port1.worker.json').exists())


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    modes=parser.add_mutually_exclusive_group(required=True)
    for name in ('preflight','fdtd','analyse','study'):
        modes.add_argument('--'+name,action='store_true')
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--mesh',type=int,choices=f.MESHES,default=f.MESHES[0])
    parser.add_argument('--control',choices=f.CONTROLS,default='ordinary')
    parser.add_argument('--rate-mcps',type=float,default=40.)
    parser.add_argument('--worker-case',action='store_true',help=argparse.SUPPRESS)
    parser.add_argument('--port',type=int,choices=(1,2,3,4),default=1,help=argparse.SUPPRESS)
    args=parser.parse_args()
    if args.preflight:
        args.out.mkdir(parents=True,exist_ok=False);rows=[]
        for n in f.MESHES:
            for control in f.CONTROLS if n==f.CONTROL_MESH else ('ordinary',):
                sim,meta=f.build(n,1,control=control)
                path=args.out/f'n{n}_{control}.xml';sim.fdtd.Write2XML(str(path))
                seconds=forecast(meta,args.rate_mcps)
                rows.append(dict(meta=meta,input_sha256=f.sha(path),forecast_seconds=seconds,deferred=seconds>1800))
        f.save(args.out/'plan.json',dict(protocol=f.PROTOCOL,rows=rows,source=f.identity(),runtime=f.runtime_identity(),limits=f.LIMITS))
        print(json.dumps([dict(n=r['meta']['n'],control=r['meta']['control'],cells=r['meta']['native_cells'],
                              seconds=r['forecast_seconds'],deferred=r['deferred']) for r in rows],indent=2))
    elif args.analyse:
        print(json.dumps(f.matrix(args.out)[1],indent=2))
    elif args.study:
        print(json.dumps(f.study(args.out),indent=2))
    elif args.worker_case:
        meta=f.acquire(args.out,args.mesh,args.port,args.control)
        print(json.dumps(dict(n=args.mesh,port=args.port,native=meta['native']),indent=2))
    else:
        print(json.dumps(acquire_serial(args.out,args.mesh,args.rate_mcps,args.control),indent=2))


if __name__=='__main__':
    if len(sys.argv)==1:
        unittest.main()
    else:
        main()
