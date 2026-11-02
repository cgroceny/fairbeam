"""Array/geometry regressions and explicitly opt-in serial native TEM runs.

python -m unittest tests.test_loaded_tem_cell_fixture -q
python -m tests.test_loaded_tem_cell_fixture --preflight --out C:/study/loaded-plan-fresh
python -m tests.test_loaded_tem_cell_fixture --fdtd --mesh 4 --count 1 --rate-mcps 20 --out C:/study/loaded-fresh/n4_N1_loaded
python -m tests.test_loaded_tem_cell_fixture --study --out C:/study/loaded-fresh
"""
import argparse
from copy import deepcopy
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock,patch
import xml.etree.ElementTree as ET

import numpy as np
from fairbeam.network import network_s
from fairbeam.procutil import popen_group,release_group,terminate_group
from tests.test_coax_resonator import wait_owned,forecast
from tests import loaded_tem_cell_fixture as f


def audit_header(text,meta):
    if text.count(f.PROPAGATION_MARKER)!=1:raise ValueError('one marked native propagation required')
    text=text.split(f.PROPAGATION_MARKER,1)[1]
    version=re.search(r'openEMS 64bit -- version (\S+)',text)
    grid=re.search(r'FDTD simulation size: (\d+)x(\d+)x(\d+) --> (\S+) FDTD cells',text)
    interval=re.search(r'Exact-endcriteria: evaluating the end criteria every (\d+) timestep',text)
    if not version or not grid or not interval or version[1]!='v0.37.0-rc3' or 'fixed number of threads: 4' not in text:
        raise ValueError('bundled four-thread native version/grid/energy header required')
    if list(map(int,grid.groups()[:3]))!=meta['grid'] or float(grid[4])!=float(f"{meta['native_cells']:.6g}"):
        raise ValueError('native Cartesian allocation differs from the declared grid')
    if int(interval[1])!=int(1/(2*f.FREQUENCIES[-1]*meta['native']['dt_s'])):
        raise ValueError('native energy schedule differs from the recorded clock')
    return dict(version=version[1],threads=4,nyquist_interval=int(interval[1]))


def preflight(out,rate,element=False):
    out=Path(out);out.mkdir(parents=True,exist_ok=False);rows=[]
    configurations=f.element_configurations() if element else [(*row,1) for row in f.configurations()]
    for name,n,count,kind,control,scale in configurations:
        for port in (1,2):
            sim,meta=f.build(n,count,port,kind,control,element_scale=scale)
            path=out/f'{name}_p{port}.xml';sim.fdtd.Write2XML(str(path))
            sim.fdtd.SetTimeStep(0.);operator=out/f'{name}_p{port}_operator.xml'
            sim.fdtd.Write2XML(str(operator))
            rows.append(dict(name=name,**meta,input_sha256=f.sha(path),operator_input_sha256=f.sha(operator),
                             estimated_seconds=forecast(meta,rate)))
    record=dict(source=f.identity(),runtime=f.runtime_identity(),limits=f.LIMITS,rows=rows,
                rate_mcps=rate,qualified=False,native_propagations=0)
    f.save(out/'preflight.json',record)
    return record


def acquire_serial(out,n,count,kind,control,rate,*,element_scale=1):
    out=Path(out).resolve()
    if out.exists():raise ValueError('use a fresh cohort directory')
    sim,meta=f.build(n,count,1,kind,control,element_scale=element_scale);estimate=forecast(meta,rate);del sim
    if estimate>1800:raise ValueError(f'forecast {estimate/60:.2f} minutes exceeds 30; defer this case')
    out.mkdir(parents=True,exist_ok=False)
    progress=dict(status='running',n=n,count=count,kind=kind,control=control,
        estimated_seconds_per_source=estimate,rate_mcps=rate,source=f.identity(),runtime=f.runtime_identity(),ports=[],qualified=False)
    try:
        for port in (1,2):
            log_path=out/f'port{port}.log'
            command=[sys.executable,'-m','tests.test_loaded_tem_cell_fixture','--worker-case','--mesh',str(n),
                     '--count',str(count),'--port',str(port),'--kind',kind,'--control',control,
                     '--element-scale',str(element_scale),'--out',str(out/f'port{port}')]
            code=None;failure=None;started,wall=time.monotonic(),time.time()
            with log_path.open('w',encoding='utf-8') as log:
                proc=popen_group(command,cwd=f.ROOT/'python',stdout=log,stderr=subprocess.STDOUT,
                    env={**os.environ,'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1'})
                progress.update(active_port=port,active_launcher_pid=proc.pid);f.save(out/'progress.json',progress)
                try:code=wait_owned(proc,seconds=1800.)
                except Exception as error:failure=repr(error);raise
                finally:
                    if proc.poll() is None:terminate_group(proc.pid,grace=0,job=proc.win_job);proc.wait(timeout=15)
                    release_group(proc)
                    f.save(out/f'port{port}.worker.json',dict(command=command,pid=proc.pid,exit_code=code,
                        failure=failure,wall_seconds=time.time()-wall,monotonic_seconds=time.monotonic()-started,
                        deadline_seconds=1800.,estimated_seconds=estimate))
            if code:raise RuntimeError(f'native worker exit {code}; retain {log_path}')
            folder=out/f'port{port}';report=json.loads((folder/'report.json').read_text())
            report['native_header']=audit_header(log_path.read_text(),report);f.save(folder/'report.json',report)
            meta,_,_,quality=f.read(folder);progress['ports'].append(dict(port=port,quality=quality))
            if not all(quality.values()):raise ValueError(f'native source rejected: {quality}')
        _,result=f.matrix(out);progress.update(status='complete',active_port=None,active_launcher_pid=None,result=result)
    except Exception as error:
        progress.update(status='rejected',active_launcher_pid=None,reason=repr(error));raise
    finally:f.save(out/'progress.json',progress)
    return result


def timing_worker(out,n,control,element_scale=1):
    """A source-incomplete 0.25 ns throughput sample; never supplies S."""
    out=Path(out);out.mkdir(parents=True,exist_ok=False)
    sim,meta=f.build(n,1,1,'loaded',control,element_scale=element_scale)
    source,runtime=f.identity(),f.runtime_identity()
    operator=f.operator_preflight(out,n,1,1,'loaded',control,element_scale=element_scale)
    steps=math.ceil(.25e-9/meta['declared_dt_s'])
    sim.fdtd.SetNumberOfTimeSteps(steps);sim.max_timesteps=steps
    meta.update(max_timesteps=steps,cap_s=.25e-9,pilot_only=True,source_sha256=source,runtime=runtime)
    sim.fdtd.Write2XML(str(out/'timing-input.xml'))
    print(f.PROPAGATION_MARKER,flush=True)
    sim.run(str(out/'raw'),threads=f.THREADS,exact=True,echo=True,dump_statistics=True)
    stats=np.loadtxt(out/'raw/openEMS_stats.txt',comments='%')
    if (source!=f.identity() or runtime!=f.runtime_identity() or int(stats[0])!=meta['native_cells']
            or abs(stats[1]/meta['declared_dt_s']-1)>1e-8 or int(stats[2])<.99*steps or stats[4]<=0):
        raise ValueError('incomplete or changed timing sample')
    meta.update(operator_preflight=operator,input_sha256=f.sha(out/'timing-input.xml'),
        native=dict(cells=int(stats[0]),dt_s=float(stats[1]),timesteps=int(stats[2]),
            numerical_time_s=float(stats[3]),iteration_wall_s=float(stats[4])),qualified=False)
    f.save(out/'timing.json',meta)
    return meta


def timing_serial(out,n,control,rate,element_scale=1):
    out=Path(out).resolve()
    if out.exists():raise ValueError('retain timing epoch; use a fresh path')
    _,meta=f.build(n,1,1,'loaded',control,element_scale=element_scale)
    meta['max_timesteps']=math.ceil(.25e-9/meta['declared_dt_s'])
    estimate=forecast(meta,rate)
    if estimate>600:raise ValueError('timing forecast exceeds 10 minutes; defer before launch')
    out.parent.mkdir(parents=True,exist_ok=True)
    command=[sys.executable,'-m','tests.test_loaded_tem_cell_fixture','--timing-worker',
             '--mesh',str(n),'--control',control,'--element-scale',str(element_scale),'--out',str(out)]
    code=None;failure=None;start,wall=time.monotonic(),time.time()
    with out.with_suffix('.log').open('x',encoding='utf-8') as log:
        proc=popen_group(command,cwd=f.ROOT/'python',stdout=log,stderr=subprocess.STDOUT,
            env={**os.environ,'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1'})
        try:code=wait_owned(proc,seconds=600.)
        except BaseException as error:failure=repr(error);raise
        finally:
            if proc.poll() is None:terminate_group(proc.pid,grace=0,job=proc.win_job);proc.wait(timeout=15)
            release_group(proc)
            f.save(out.with_suffix('.worker.json'),dict(pid=proc.pid,exit_code=code,failure=failure,
                wall_seconds=time.time()-wall,monotonic_seconds=time.monotonic()-start,deadline_seconds=600.))
    if code!=0:raise RuntimeError('timing worker failed; epoch retained')
    record=json.loads((out/'timing.json').read_text())
    audit_header(out.with_suffix('.log').read_text(encoding='utf-8'),record)
    native=record['native'];record.update(estimated_seconds=estimate,
        conservative_rate_mcps=.8*native['cells']*native['timesteps']/native['iteration_wall_s']/1e6)
    return record


def synthetic(s,n=4):
    """Independent traveling waves at local probe coordinates, including reverse waves."""
    nf=len(f.FREQUENCIES);v=np.empty((2,2,3,nf),complex);i=np.empty((2,2,2,2,nf),complex)
    incoming=np.array([[1.,.15j],[.1-.2j,.8]],complex)
    outgoing=np.einsum('fij,je->fie',s,incoming)
    beta=2*np.pi*f.FREQUENCIES/f.C0;dx=f.HEIGHT/n
    for e in range(2):
        for p,sign in ((0,1),(1,-1)):
            for j,offset in enumerate((-dx,0.,dx)):
                v[e,p,j]=np.sqrt(f.Z0)*(incoming[p,e]*np.exp(-1j*beta*sign*offset)+outgoing[:,p,e]*np.exp(1j*beta*sign*offset))
            for j,offset in enumerate((-dx/2,dx/2)):
                current=sign/np.sqrt(f.Z0)*(incoming[p,e]*np.exp(-1j*beta*sign*offset)-outgoing[:,p,e]*np.exp(1j*beta*sign*offset))
                i[e,p,:,j]=current
    return v,i


class LoadedTEMReferenceTests(unittest.TestCase):
    def test_timing_budget_refuses_before_launch_and_refined_worker_is_forwarded(self):
        with tempfile.TemporaryDirectory() as tmp,patch(__name__+'.popen_group') as launch:
            root=Path(tmp)/'absent'
            with self.assertRaisesRegex(ValueError,'defer'):
                timing_serial(root,4,'element',.0001,8)
            self.assertFalse(root.exists())
            launch.assert_not_called()
        proc=Mock(pid=1234,win_job=object());proc.poll.return_value=1
        with tempfile.TemporaryDirectory() as tmp,patch(__name__+'.popen_group',return_value=proc) as launch,\
             patch(__name__+'.wait_owned',side_effect=TimeoutError('owned deadline')) as wait,\
             patch(__name__+'.release_group'),patch.object(f,'runtime_identity',return_value={}):
            root=Path(tmp)/'failed'
            with self.assertRaises(TimeoutError):
                acquire_serial(root,4,1,'loaded','element',1000.,element_scale=8)
            wait.assert_called_once_with(proc,seconds=1800.)
            command=launch.call_args.args[0]
            self.assertEqual(command[command.index('--element-scale')+1],'8')
            self.assertEqual(json.loads((root/'port1.worker.json').read_text())['deadline_seconds'],1800.)
            self.assertFalse((root/'matrix.npz').exists())

    def test_separate_spread_reference_matches_independent_nodal_shunts(self):
        for scale in f.ELEMENT_SCALES:
            dx=f.HEIGHT/f.CONTROL_MESH/scale
            lengths=[f.PERIOD/2-dx,dx,dx,f.PERIOD/2-dx]
            lines=[(j,j+1,f.Z0,length/f.C0) for j,length in enumerate(lengths)]
            loads=[(j,-1,2j*np.pi*f.FREQUENCIES*f.CAPACITANCE/3) for j in (1,2,3)]
            nodal=network_s(f.FREQUENCIES,[0,4],lines,admittances=loads)
            actual,cell=f.spread_reference(dx)
            np.testing.assert_allclose(actual,nodal,rtol=0,atol=3e-14)
            np.testing.assert_allclose(f.chain(actual),cell,rtol=0,atol=3e-12)
        point,_=f.reference()
        np.testing.assert_allclose(f.spread_reference(0.)[0],point,rtol=0,atol=1e-15)

    def test_fixed_total_capacitance_has_a_shrinking_support_limit(self):
        point,_=f.reference()
        errors=[abs(f.spread_reference(f.HEIGHT/f.CONTROL_MESH/scale)[0]-point).max() for scale in f.ELEMENT_SCALES]
        self.assertGreater(errors[0],errors[1]);self.assertGreater(errors[1],errors[2])
        self.assertGreater(errors[0],f.LIMITS['s_control_abs'])
        self.assertLess(errors[-1],f.LIMITS['s_control_abs'])
        for spacing in (True,-1.,f.PERIOD/2,float('nan'),float('inf')):
            with self.assertRaises(ValueError):f.spread_reference(spacing)

    def test_local_mesh_is_limited_and_keeps_physical_planes_and_total_capacitance(self):
        self.assertEqual(f.MESHES,(4,6,8));self.assertEqual(len(f.configurations()),19)
        _,base=f.build(4,1,1)
        for scale in f.ELEMENT_SCALES:
            for control in ('ordinary','element'):
                _,meta=f.build(4,1,1,'loaded',control,element_scale=scale)
                for key in ('planes_m','source_planes_m','physical_pmc_planes_m','width_m','height_m'):
                    self.assertEqual(meta[key],base[key])
                self.assertEqual(meta['mesh_mm']['x'][0],base['mesh_mm']['x'][0])
                self.assertEqual(meta['mesh_mm']['x'][-1],base['mesh_mm']['x'][-1])
                cap=meta['native_capacitors'][0]
                self.assertEqual(cap['capacitance_f'],f.CAPACITANCE)
                self.assertAlmostEqual(cap['native_capacitance_f']-cap['replaced_air_capacitance_f'],f.CAPACITANCE,places=24)
                spacing=(cap['stop_x_m']-cap['start_x_m'])/2
                if control=='element':self.assertAlmostEqual(spacing,f.HEIGHT/4/scale,places=15)
        for n,count,kind,control in ((6,1,'loaded','ordinary'),(4,2,'loaded','ordinary'),(4,1,'unloaded','ordinary'),(4,1,'loaded','boundary')):
            with self.assertRaises(ValueError):f.build(n,count,1,kind,control,element_scale=4)
        for value in (True,0,2,4.,float('nan')):
            with self.assertRaises(ValueError):f.build(4,1,1,element_scale=value)

    def test_independent_nodal_cell_cascades(self):
        for count in f.COUNTS:
            for kind in ('loaded','unloaded'):
                with self.subTest(count=count,kind=kind):
                    lengths=[f.PERIOD/2]+[f.PERIOD]*(count-1)+[f.PERIOD/2]
                    lines=[(j,j+1,f.Z0,d/f.C0) for j,d in enumerate(lengths)]
                    loads=[] if kind=='unloaded' else [(j,-1,2j*np.pi*f.FREQUENCIES*f.CAPACITANCE) for j in range(1,count+1)]
                    actual=network_s(f.FREQUENCIES,[0,count+1],lines,admittances=loads)
                    expected,cell=f.reference(count,kind)
                    np.testing.assert_allclose(actual,expected,rtol=0,atol=2e-14)
                    np.testing.assert_allclose(f.chain(actual),np.linalg.matrix_power(cell,count),rtol=0,atol=2e-12)

    def test_closed_dispersion_and_reference_plane_impedance(self):
        _,cell=f.reference();g,z=f.bloch(cell)
        theta=2*np.pi*f.FREQUENCIES*f.PERIOD/f.C0
        cosine=np.cos(theta)-np.pi*f.FREQUENCIES*f.CAPACITANCE*f.Z0*np.sin(theta)
        np.testing.assert_allclose(g.imag,np.arccos(cosine)/f.PERIOD,rtol=0,atol=1e-12)
        self.assertAlmostEqual(g[60].imag,150.08682123252598,places=10)
        self.assertAlmostEqual(z[60].real,17.43658819691341,places=11)
        # Moving the cell boundary to its shunt node keeps trace, not B/C.
        line=np.empty_like(cell);line[:,0,0]=line[:,1,1]=np.cos(theta/2)
        line[:,0,1],line[:,1,0]=1j*f.Z0*np.sin(theta/2),1j*np.sin(theta/2)/f.Z0
        changed=np.linalg.solve(line,cell@line)
        np.testing.assert_allclose(np.trace(changed,axis1=1,axis2=2),np.trace(cell,axis1=1,axis2=2),atol=2e-14)
        self.assertGreater(abs(np.sqrt(changed[:,0,1]/changed[:,1,0])-z).max(),1.)

    def test_reference_passivity_reciprocity_and_empty_line(self):
        for count in f.COUNTS:
            s,_=f.reference(count)
            np.testing.assert_allclose(s,s.transpose(0,2,1),atol=3e-15)
            np.testing.assert_allclose(s.conj().transpose(0,2,1)@s,np.broadcast_to(np.eye(2),s.shape),atol=3e-15)
        s,cell=f.reference(1,'unloaded');g,z=f.bloch(cell)
        np.testing.assert_allclose(g,2j*np.pi*f.FREQUENCIES/f.C0,atol=1e-12)
        np.testing.assert_allclose(z,f.Z0,atol=2e-13)
        np.testing.assert_allclose(s[:,0,0],0,atol=2e-15)

    def test_signed_attenuation_is_not_clipped(self):
        _,t=f.reference(1,'unloaded')
        phase=2j*np.pi*f.FREQUENCIES*f.PERIOD/f.C0-.002
        t[:,0,0]=t[:,1,1]=np.cosh(phase)
        t[:,0,1],t[:,1,0]=f.Z0*np.sinh(phase),np.sinh(phase)/f.Z0
        g,_=f.bloch(t)
        np.testing.assert_allclose(g.real,-.2,atol=2e-13)

    def test_invalid_and_singular_reference_data(self):
        for count in (True,0,4,1.0):
            with self.assertRaises(ValueError):f.reference(count)
        for frequency in ([0.],[float('nan')],[4e9],[[3e9]]):
            with self.assertRaises(ValueError):f.reference(freq=frequency)
        for value in (np.zeros((81,2,2)),np.full((81,2,2),np.nan),np.ones((80,2,2))):
            with self.assertRaises(ValueError):f.chain(value)


class LoadedTEMMeasurementTests(unittest.TestCase):
    def test_staggered_bidirectional_waves_recover_finite_network(self):
        for count in f.COUNTS:
            expected,_=f.reference(count);v,i=synthetic(expected)
            actual,diag=f.extract(v,i)
            np.testing.assert_allclose(actual,expected,rtol=0,atol=1e-14)
            self.assertLess(diag['recurrence_residual'],1e-14)
            self.assertEqual(diag['contour_s_abs'],0)

    def test_wrong_direction_and_contour_are_not_silently_normalized(self):
        s,_=f.reference();v,i=synthetic(s)
        wrong=i.copy();wrong[:,1]*=-1
        actual,_=f.extract(v,wrong)
        self.assertGreater(abs(actual-s).max(),.1)
        wrong=i.copy();wrong[:,:,1]*=1.1
        _,diag=f.extract(v,wrong)
        self.assertGreater(diag['contour_s_abs'],f.LIMITS['contour_s_abs'])

    def test_missing_column_and_sampling_shape_rejected(self):
        s,_=f.reference();v,i=synthetic(s)
        for a,b in ((v[:1],i[:1]),(np.zeros_like(v),i),(v,np.full_like(i,np.nan))):
            with self.assertRaises(ValueError):f.extract(a,b)
        with self.assertRaises(ValueError):f.assemble(np.ones((2,2,81)),np.ones((2,2,81)))


class LoadedTEMAdmissionTests(unittest.TestCase):
    def test_exact_mesh_sources_nominal_capacitors_and_independent_contours(self):
        for n in f.MESHES:
            sim,meta=f.build(n,3,1)
            x=np.asarray(sim.mesh.GetLines('x'))*sim.unit
            self.assertTrue(all(s in x for s in meta['source_planes_m']))
            self.assertEqual(len(meta['native_capacitors']),3)
            self.assertTrue(all(c['capacitance_f']==f.CAPACITANCE for c in meta['native_capacitors']))
            capacitors=[p for p in sim.csx.GetAllProperties() if p.GetName().startswith('cell_C')]
            self.assertEqual(len(capacitors),3)
            for p,c in zip(capacitors,meta['native_capacitors']):
                self.assertEqual(p.GetCapacity(),c['native_capacitance_f'])
                self.assertEqual(p.GetLEtype(),0)
            self.assertNotEqual(meta['current_contours']['outer'],meta['current_contours']['inner'])
            for c in meta['current_contours'].values():
                self.assertAlmostEqual(c['weight']*c['enclosed_span_m'],f.WIDTH,places=14)
            with self.assertRaises(ValueError):sim.to_bundle({},[])

    def test_independent_controls_preserve_nominal_capacitance_and_clock(self):
        _,base=f.build(4,1,1)
        for control in f.CONTROLS[1:]:
            _,meta=f.build(4,1,1,control=control)
            self.assertEqual(meta['native_capacitors'][0]['capacitance_f'],f.CAPACITANCE)
            if control!='dt':self.assertEqual(meta['declared_dt_s'],base['declared_dt_s'])
            else:self.assertAlmostEqual(meta['declared_dt_s']/base['declared_dt_s'],.7)
        self.assertEqual(len(f.configurations()),19)

    def test_fixed_physical_pmc_width_and_incremental_capacitance(self):
        # Count actual included E nodes, including a three-column element.
        # This catches both ghost-row dilution and forgetting replaced air.
        for n in f.MESHES:
            for control in ('ordinary','transverse','element'):
                sim,meta=f.build(n,1,1,control=control)
                y=np.asarray(sim.mesh.GetLines('y'))*sim.unit
                np.testing.assert_allclose(meta['physical_pmc_planes_m'],[0.,f.WIDTH],rtol=0,atol=1e-17)
                self.assertAlmostEqual(meta['current_contours']['outer']['weight'],1.,places=14)
                prop=next(p for p in sim.csx.GetAllProperties() if p.GetName()=='cell_C1')
                box=prop.GetAllPrimitives()[0]
                start=np.asarray(box.GetStart())*sim.unit;stop=np.asarray(box.GetStop())*sim.unit
                live=(y>=start[1]-1e-15)&(y<=stop[1]+1e-15)
                self.assertEqual(np.flatnonzero(live).tolist(),list(range(1,len(y)-1)))
                c=meta['native_capacitors'][0];columns=c['longitudinal_voltage_columns']
                self.assertEqual(columns,3 if control=='element' else 1)
                self.assertEqual(c['active_voltage_rows'],int(live.sum()))
                air=f.EPS0*f.WIDTH*(f.HEIGHT/n)*columns/f.HEIGHT
                self.assertAlmostEqual(c['replaced_air_capacitance_f']/air,1.,places=14)
                self.assertAlmostEqual((prop.GetCapacity()-air)/f.CAPACITANCE,1.,places=14)

    def test_invalid_model_choices_and_forecast_never_launch(self):
        for args in ((True,1,1),(4,0,1),(4,1,3),(5,1,1),(4,1.0,1)):
            with self.assertRaises(ValueError):f.build(*args)
        with tempfile.TemporaryDirectory() as tmp,patch(__name__+'.popen_group') as launch:
            with self.assertRaises(ValueError):acquire_serial(Path(tmp)/'over',8,3,'loaded','ordinary',.00001)
            launch.assert_not_called()

    def test_missing_controls_and_meshes_cannot_qualify(self):
        with tempfile.TemporaryDirectory() as tmp:
            result=f.study(tmp)
            self.assertFalse(result['qualified']);self.assertEqual(len(result['missing']),19)

    def test_native_xml_is_reproducible_before_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths=[Path(tmp)/name for name in ('a.xml','b.xml')]
            for path in paths:
                sim,_=f.build(6,2,2);sim.fdtd.Write2XML(str(path))
            self.assertEqual(paths[0].read_bytes(),paths[1].read_bytes())
            self.assertEqual(len(ET.parse(paths[0]).findall('.//ContinuousStructure/Properties/LumpedElement')),4)

    def test_native_header_uses_propagation_not_operator_and_retains_print_precision(self):
        meta=dict(grid=[201,201,101],native_cells=4080501,native=dict(dt_s=1e-13))
        text=('irrelevant earlier setup header\n'+f.PROPAGATION_MARKER+'\n'
              'openEMS 64bit -- version v0.37.0-rc3\nfixed number of threads: 4\n'
              'FDTD simulation size: 201x201x101 --> 4.0805e+06 FDTD cells\n'
              'Exact-endcriteria: evaluating the end criteria every 1562 timestep\n')
        self.assertEqual(audit_header(text,meta)['threads'],4)
        for a,b in (('threads: 4','threads: 8'),('201x201x101','202x201x101'),('1562 timestep','1563 timestep'),
                    ('4.0805e+06','4.0806e+06'),(f.PROPAGATION_MARKER,'')):
            with self.subTest(a=a),self.assertRaises(ValueError):audit_header(text.replace(a,b),meta)

    def test_operator_requires_actual_capacitor_use_and_safe_clock(self):
        _,meta=f.build(4,1,1)
        usage={'upper_conductor':[True],'cell_C1':[True]}
        operator=dict(setup_only=True,planned_dt_s=meta['declared_dt_s'],ratio_limit=.97,
            required_usage=usage,run=dict(timestep_s=2*meta['declared_dt_s'],grid=meta['grid'],threads=4))
        self.assertTrue(f.native_bound_ok({**meta,'operator_preflight':operator}))
        for bound in (None,True,float('nan'),0.,meta['declared_dt_s']/.98):
            changed=deepcopy(operator);changed['run']['timestep_s']=bound
            self.assertFalse(f.native_bound_ok({**meta,'operator_preflight':changed}))
        changed=deepcopy(operator);changed['required_usage']['cell_C1']=[False]
        self.assertFalse(f.native_bound_ok({**meta,'operator_preflight':changed}))

    def test_source_completion_geometry_and_native_cap_are_independent_gates(self):
        _,meta=f.build(4,1,1);dt=meta['declared_dt_s'];steps=meta['max_timesteps']-1
        usage={'upper_conductor':[True],'cell_C1':[True]}
        meta.update(operator_preflight=dict(setup_only=True,planned_dt_s=dt,ratio_limit=.97,required_usage=usage,
            run=dict(timestep_s=2*dt,grid=meta['grid'],threads=4)),required_usage=deepcopy(usage),
            native=dict(cells=meta['native_cells'],dt_s=dt,timesteps=steps,numerical_time_s=steps*dt),
            run=dict(grid=meta['grid'],threads=4,converged=True),actual_current_indices=deepcopy(meta['expected_current_indices']),
            native_header=dict(version='v0.37.0-rc3',threads=4,nyquist_interval=int(1/(2*f.FREQUENCIES[-1]*dt))))
        self.assertTrue(all(f.quality(meta).values()))
        changed=deepcopy(meta);changed['native'].update(timesteps=10,numerical_time_s=10*dt)
        self.assertFalse(f.quality(changed)['source'])
        changed=deepcopy(meta);changed['native'].update(timesteps=meta['max_timesteps'],numerical_time_s=meta['max_timesteps']*dt)
        self.assertFalse(f.quality(changed)['energy'])
        changed=deepcopy(meta);changed['required_usage']['cell_C1']=[False]
        self.assertFalse(f.quality(changed)['geometry'])
        changed=deepcopy(meta);changed['actual_current_indices']['i0_outer_0'][0][1]+=1
        self.assertFalse(f.quality(changed)['probes'])

    def test_native_probe_clock_rejects_truncation_and_wrong_stride(self):
        dt=1e-13;stride=int(1/(2*f.FREQUENCIES[-1]*dt))//4
        data=np.column_stack((np.arange(100)*stride*dt,np.sin(np.arange(100))))
        meta=dict(native=dict(dt_s=dt,numerical_time_s=(99*stride+stride//2)*dt))
        self.assertEqual(f.trace_clock(data,meta)['stride_steps'],stride)
        for changed in (data[:-2],data[::2],np.full_like(data,np.nan),data[:,0],data[:,:1]):
            with self.assertRaises(ValueError):f.trace_clock(changed,meta)

    def test_native_source_formula_checks_allocated_length_and_waveform(self):
        dt=1e-11;steps=300;time=np.arange(steps)*dt
        tau=1/(np.sqrt(2)*np.pi*f.FREQUENCIES[-1]/2.76)
        x=(time-float(f'{5*tau:.6e}'))/float(f'{tau:.6e}')
        expected=-float(f'{np.sqrt(2*np.e):.8f}')*x*np.exp(-x*x)
        meta=dict(native=dict(dt_s=dt),max_timesteps=steps)
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'et';np.savetxt(path,np.column_stack((time,expected)))
            self.assertLess(f.source_trace_info(path,meta)['waveform_error_rel'],1e-14)
            np.savetxt(path,np.column_stack((time,expected*1.01)))
            with self.assertRaises(ValueError):f.source_trace_info(path,meta)
            np.savetxt(path,np.column_stack((time[:-2],expected[:-2])))
            with self.assertRaises(ValueError):f.source_trace_info(path,meta)

    def test_native_magnetic_clock_keeps_yee_half_step_at_exact_stop(self):
        dt=7.859226349050691e-14;stride=int(1/(2*f.FREQUENCIES[-1]*dt))//4
        steps=76*stride;meta=dict(native=dict(dt_s=dt,numerical_time_s=steps*dt))
        for magnetic,offset in ((False,0.),(True,.5)):
            stamps=(np.arange(77)*stride+offset)*dt
            # The native text export stores twelve significant digits.
            stamps=np.array([float(f'{t:.12g}') for t in stamps])
            data=np.column_stack((stamps,np.ones(77)))
            self.assertEqual(f.trace_clock(data,meta,magnetic=magnetic)['offset_steps'],offset)
            if magnetic:self.assertGreater(stamps[-1],meta['native']['numerical_time_s'])
            for bad in (data[:-1],data[1:],data+np.array([dt,0.])):
                with self.assertRaises(ValueError):f.trace_clock(bad,meta,magnetic=magnetic)
            with self.assertRaises(ValueError):f.trace_clock(data,meta,magnetic=not magnetic)

    def test_expired_owned_worker_preserves_failure_and_never_starts_second_source(self):
        proc=Mock(pid=1234,win_job=object());proc.poll.return_value=1
        with tempfile.TemporaryDirectory() as tmp,patch(__name__+'.popen_group',return_value=proc) as launch,\
                patch(__name__+'.wait_owned',side_effect=TimeoutError('owned deadline')),patch(__name__+'.release_group'),\
                patch.object(f,'runtime_identity',return_value={}):
            root=Path(tmp)/'failed'
            with self.assertRaises(TimeoutError):acquire_serial(root,4,1,'loaded','ordinary',1000.)
            self.assertEqual(launch.call_count,1)
            receipt=json.loads((root/'port1.worker.json').read_text())
            self.assertEqual(receipt['deadline_seconds'],1800.)
            self.assertIn('owned deadline',receipt['failure'])
            self.assertEqual(json.loads((root/'progress.json').read_text())['status'],'rejected')
            self.assertFalse((root/'matrix.npz').exists())


class LoadedTEMRecordTests(unittest.TestCase):
    def element_records(self,root):
        records={}
        for name,n,count,kind,control,scale in f.element_configurations():
            folder=root/name;folder.mkdir()
            for port in (1,2):
                f.save(folder/f'port{port}.worker.json',dict(exit_code=0,failure=None,
                    deadline_seconds=2700,wall_seconds=10.,monotonic_seconds=10.))
            s=f.reference()[0] if control=='ordinary' else f.spread_reference(f.HEIGHT/n/scale)[0]
            records[name]=(s,dict(all_native_complete=True,target_passes=control=='ordinary',
                contour_s_abs=0.,recurrence_residual=0.,incident_condition=1.,incident_floor=1.,
                reciprocity_abs=0.,singular_power_max=1.))
        return records

    def test_regularization_is_separate_from_the_failed_original_control(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);rows=self.element_records(root)
            with patch.object(f,'matrix',side_effect=lambda p:rows[p.name]):result=f.element_study(root)
        self.assertTrue(result['regularization_passes'],result)
        self.assertFalse(result['meshes'][0]['point_control_passes'])
        self.assertFalse(result['original_study_reclassified']);self.assertFalse(result['qualified'])

    def test_failed_receipt_or_unshrinking_support_cannot_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);rows=self.element_records(root)
            failed=root/'scale8_element/port2.worker.json'
            f.save(failed,dict(exit_code=1,failure='interrupted',deadline_seconds=2700,
                             wall_seconds=2701.,monotonic_seconds=2701.))
            with patch.object(f,'matrix',side_effect=lambda p:rows[p.name]):result=f.element_study(root)
            self.assertFalse(result['regularization_passes']);self.assertTrue(result['rejected'])
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);rows=self.element_records(root)
            rows['scale8_element']=rows['scale1_element']
            with patch.object(f,'matrix',side_effect=lambda p:rows[p.name]):result=f.element_study(root)
            self.assertFalse(result['regularization_passes']);self.assertFalse(result['control_differences_decrease'])

    def test_matching_model_cannot_override_bad_measurement_quality(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);rows=self.element_records(root)
            rows['scale8_element'][1]['contour_s_abs']=.01
            with patch.object(f,'matrix',side_effect=lambda p:rows[p.name]):result=f.element_study(root)
            self.assertFalse(result['regularization_passes']);self.assertTrue(result['rejected'])

    @staticmethod
    def records():
        target,_=f.reference();v,i=synthetic(target);_,base=f.build(4,1,1)
        return [(dict(base,excited_port=p),v[p-1],i[p-1],{'all':True}) for p in (1,2)]

    def test_reanalysis_preserves_original_matrix_bytes_and_rejects_changed_comparison(self):
        rows=self.records()
        with tempfile.TemporaryDirectory() as tmp,patch.object(f,'read',side_effect=lambda p:rows[int(p.name[-1])-1]):
            root=Path(tmp);actual,result=f.matrix(root)
            before=f.sha(root/'matrix.npz');f.matrix(root)
            self.assertEqual(f.sha(root/'matrix.npz'),before)
            changed=dict(result,target_passes=False);f.save(root/'comparison.json',changed)
            with self.assertRaises(ValueError):f.matrix(root)
            self.assertEqual(json.loads((root/'comparison.json').read_text()),changed)

    def test_rejected_native_source_never_produces_matrix(self):
        rows=self.records();rows[1][3]['all']=False
        with tempfile.TemporaryDirectory() as tmp,patch.object(f,'read',side_effect=lambda p:rows[int(p.name[-1])-1]):
            with self.assertRaises(ValueError):f.matrix(tmp)
            self.assertFalse((Path(tmp)/'matrix.npz').exists())

    def test_input_tamper_rejected_before_model_rebuild_or_spectral_replay(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'input.xml').write_text('original')
            report=dict(source_sha256={},runtime={},limits=f.LIMITS,input_sha256=f.sha(root/'input.xml'))
            f.save(root/'report.json',report);(root/'input.xml').write_text('changed')
            with patch.object(f,'identity',return_value={}),patch.object(f,'runtime_identity',return_value={}),patch.object(f,'build') as build:
                with self.assertRaises(ValueError):f.read(root)
                build.assert_not_called()

    def test_complete_but_corrupt_cohort_is_reported_as_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder=root/'n4_N1_loaded'
            for p in (1,2):
                (folder/f'port{p}').mkdir(parents=True);(folder/f'port{p}/report.json').write_text('{}')
            with patch.object(f,'matrix',side_effect=ValueError('changed native trace')):
                result=f.study(root)
            self.assertFalse(result['qualified']);self.assertEqual(len(result['rejected']),1)
            self.assertIn('changed native trace',result['rejected'][0]['reason'])

    @staticmethod
    def synthetic_study(root,change=None):
        rows={}
        for name,n,count,kind,control in f.configurations():
            folder=root/name
            for port in (1,2):
                (folder/f'port{port}').mkdir(parents=True);(folder/f'port{port}/report.json').write_text('{}')
            s,_=f.reference(count,kind)
            if change:s=change(name,s)
            rows[name]=(s,dict(n=n,count=count,kind=kind,control=control,target_passes=True))
        return rows

    def test_two_mesh_transitions_are_required_even_when_targets_are_marked_passed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);rows=self.synthetic_study(root)
            with patch.object(f,'matrix',side_effect=lambda p:rows[p.name]):
                complete=f.study(root)
                self.assertTrue(complete['qualified']);self.assertEqual(len(complete['mesh_changes']),8)
                (root/'n6_N1_loaded/port2/report.json').unlink()
                incomplete=f.study(root)
            self.assertFalse(incomplete['qualified'])
            self.assertFalse(any(x['kind']=='loaded' and x['count']==1 for x in incomplete['mesh_changes']))

    def test_independent_control_failure_cannot_be_replaced_by_mesh_agreement(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);rows=self.synthetic_study(root,lambda name,s:s*np.exp(.003j) if name.endswith('_guard') else s)
            with patch.object(f,'matrix',side_effect=lambda p:rows[p.name]):result=f.study(root)
            self.assertTrue(all(x['passes'] for x in result['mesh_changes']))
            self.assertFalse(result['controls']['guard']['passes']);self.assertFalse(result['qualified'])

    def test_finite_cell_count_failure_cannot_be_replaced_by_mesh_and_control_agreement(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);rows=self.synthetic_study(root,lambda name,s:s*np.exp(.004j) if '_N3_' in name else s)
            with patch.object(f,'matrix',side_effect=lambda p:rows[p.name]):result=f.study(root)
            self.assertTrue(all(x['passes'] for x in result['mesh_changes']))
            self.assertTrue(all(x['passes'] for x in result['controls'].values()))
            self.assertFalse(all(x['passes'] for x in result['cell_count_checks']));self.assertFalse(result['qualified'])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    mode=parser.add_mutually_exclusive_group(required=True)
    for name in ('preflight','element-preflight','fdtd','analyse','study','element-study','timing','timing-worker','worker-case'):
        mode.add_argument('--'+name,action='store_true')
    parser.add_argument('--mesh',type=int,default=4,choices=f.MESHES)
    parser.add_argument('--count',type=int,default=1,choices=f.COUNTS)
    parser.add_argument('--kind',choices=('loaded','unloaded'),default='loaded')
    parser.add_argument('--control',choices=f.CONTROLS,default='ordinary')
    parser.add_argument('--port',type=int,choices=(1,2),default=1)
    parser.add_argument('--rate-mcps',type=float,default=20.)
    parser.add_argument('--element-scale',type=int,choices=f.ELEMENT_SCALES,default=1)
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args()
    if args.preflight:result=preflight(args.out,args.rate_mcps)
    elif args.element_preflight:result=preflight(args.out,args.rate_mcps,element=True)
    elif args.timing_worker:result=timing_worker(args.out,args.mesh,args.control,args.element_scale)
    elif args.timing:result=timing_serial(args.out,args.mesh,args.control,args.rate_mcps,args.element_scale)
    elif args.worker_case:result=f.acquire(args.out,args.mesh,args.count,args.port,args.kind,args.control,element_scale=args.element_scale)
    elif args.fdtd:result=acquire_serial(args.out,args.mesh,args.count,args.kind,args.control,args.rate_mcps,
                                      element_scale=args.element_scale)
    elif args.analyse:_,result=f.matrix(args.out)
    elif args.element_study:result=f.element_study(args.out)
    else:
        result=f.study(args.out)
        if (args.out/'study.json').exists():raise ValueError('preserve prior study output; use an independent audit')
        f.save(args.out/'study.json',result)
    print(json.dumps(result,indent=2))


if __name__=='__main__':
    if any(x in sys.argv for x in ('--preflight','--element-preflight','--fdtd','--analyse','--study','--element-study','--timing','--timing-worker','--worker-case')):main()
    else:unittest.main()
