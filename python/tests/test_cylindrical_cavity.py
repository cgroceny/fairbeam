r"""Opt-in closed TE011 controls, Example 6.4.

From python/ in the bundled openEMS environment, using fresh external paths:
python -m unittest tests.test_cylindrical_cavity -q
python -m tests.test_cylindrical_cavity --preflight --out C:\Temp\cyl-plan
python -m tests.test_cylindrical_cavity --fdtd --case pec --cap-ns 230 --out C:\Temp\cyl-pec
python -m tests.test_cylindrical_cavity --analyse --out C:\Temp\cyl-pec

Ordinary unittest never runs FDTD. Explicit acquisitions refuse forecasts
over 30 minutes and bound the owned worker including suspend time.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET

import numpy as np

from fairbeam.procutil import popen_group, release_group, terminate_group
from tests.test_coax_resonator import forecast, wait_owned
from tests import cylindrical_cavity_fixture as fixture


def audit_header(text, meta):
    version=re.search(r'openEMS 64bit -- version (\S+)',text)
    grid=re.search(r'FDTD simulation size: (\d+)x(\d+)x(\d+) --> (\d+) FDTD cells',text)
    interval=re.search(r'Exact-endcriteria: evaluating the end criteria every (\d+) timestep',text)
    if not version or not grid or not interval:
        raise ValueError('native version/grid/sampling header missing')
    if version[1]!='v0.37.0-rc3' or f'fixed number of threads: {fixture.THREADS}' not in text:
        raise ValueError('bundled rc3 and declared thread count required')
    if list(map(int,grid.groups()[:3]))!=meta['reported_grid_lines'] or int(grid[4])!=meta['native_cells']:
        raise ValueError('native allocation differs from declared cylindrical grid')
    if int(interval[1])!=int(1/(2*meta['f_max_hz']*meta['native']['dt_s'])):
        raise ValueError('native sampling schedule differs')
    if not all(v in text for v in ('Create cylindrical FDTD operator','r=0 included...',
                                  'Alpha is a full 2*PI => closed Cylinder')):
        raise ValueError('native axis/closed cylindrical geometry not confirmed')
    if re.search(r'forced timestep:.*larger than calculated timestep',text,re.I):
        raise ValueError('native stability bound exceeded')
    return dict(version=version[1],threads=fixture.THREADS,nyquist_interval=int(interval[1]),axis_included=True,closed_alpha=True)


def acquire_serial(out,n,kind,angular,margin,cap_s,rate):
    out=Path(out).resolve()
    if out.exists():
        raise ValueError('retain existing acquisition; choose a fresh output')
    _,meta=fixture.build(n,kind,angular,margin,cap_s)
    estimate=forecast(meta,rate)
    if estimate>1800:
        raise ValueError(f'forecast {estimate/60:.2f} minutes exceeds 30; defer before launch')
    out.parent.mkdir(parents=True,exist_ok=True)
    command=[sys.executable,'-m','tests.test_cylindrical_cavity','--fdtd','--worker-case',
        '--mesh',str(n),'--case',kind,'--angular',str(angular),'--margin',str(margin),
        '--cap-ns',str(meta['cap_s']*1e9),'--out',str(out)]
    log_path=out.with_name(out.name+'.log')
    code=None
    with log_path.open('w',encoding='utf-8') as log:
        process=popen_group(command,cwd=Path(__file__).resolve().parents[1],stdout=log,stderr=subprocess.STDOUT,
            env={**os.environ,'OMP_NUM_THREADS':str(fixture.THREADS),'OPENBLAS_NUM_THREADS':'1'})
        start,wall=time.monotonic(),time.time()
        try:
            code=wait_owned(process)
        finally:
            if process.poll() is None:
                terminate_group(process.pid,grace=0,job=process.win_job)
                process.wait(timeout=15)
            release_group(process)
            fixture.save(out.with_name(out.name+'.worker.json'),dict(command=command,pid=process.pid,
                exit_code=code,estimated_seconds=estimate,rate_mcps=rate,
                monotonic_seconds=time.monotonic()-start,wall_seconds=time.time()-wall))
    if code:
        raise RuntimeError(f'native exit {code}; raw and log retained')
    report=json.loads((out/'report.json').read_text(encoding='utf-8'))
    report['native_header']=audit_header(log_path.read_text(encoding='utf-8'),report)
    fixture.save(out/'report.json',report)
    return fixture.read(out)


class References(unittest.TestCase):
    def test_root_and_closed_geometry_frequency(self):
        self.assertAlmostEqual(fixture.CHI,3.831705970207512,places=12)
        r=fixture.reference('both_sheet')
        a,d=r['radius_mm']*1e-3,r['length_mm']*1e-3
        f=fixture.C0/(2*np.pi*np.sqrt(fixture.ER))*np.sqrt((fixture.CHI/a)**2+(np.pi/d)**2)
        self.assertAlmostEqual(f/fixture.F0,1,places=13)
        self.assertEqual(d,2*a)
        self.assertAlmostEqual(r['qc'],29318.52634628573,places=6)

    def test_loss_sum_and_reference_frequency_scaling(self):
        qd=fixture.reference('dielectric')['qd']
        qc=fixture.reference('copper_sheet')['qc']
        q=fixture.reference('both_sheet')['q_unloaded']
        self.assertAlmostEqual(1/q,1/qc+1/qd,places=13)
        self.assertAlmostEqual(fixture.reference('copper_sheet',4*fixture.F0)['qc']/qc,2)
        self.assertAlmostEqual(fixture.reference('dielectric',2*fixture.F0)['qd']/qd,2)
        self.assertIsNone(fixture.reference('pec')['q_unloaded'])

    def test_independent_volume_curved_wall_and_both_cap_integrals(self):
        ref=fixture.reference('both_sheet')
        a,d=ref['radius_mm']*1e-3,ref['length_mm']*1e-3
        kr,kz=ref['kr_rad_m'],ref['kz_rad_m']
        radius=(np.arange(20000)+.5)*a/20000
        z=(np.arange(20000)+.5)*d/20000
        j0,j1=fixture.bessel_j(0,kr*radius),fixture.bessel_j(1,kr*radius)
        ir0=np.sum(radius*j0*j0)*a/20000
        ir1=np.sum(radius*j1*j1)*a/20000
        izs=np.sum(np.sin(kz*z)**2)*d/20000
        izc=np.sum(np.cos(kz*z)**2)*d/20000
        volume=2*np.pi*(kz*kz*ir1*izc+kr*kr*ir0*izs)
        side=2*np.pi*a*kr*kr*float(fixture.bessel_j(0,kr*a))**2*izs
        caps=4*np.pi*kz*kz*ir1
        self.assertAlmostEqual((side+caps)/volume/ref['wall_volume_ratio_m_inv'],1,places=7)
        self.assertGreater(caps,0)
        self.assertLess(side/volume,ref['wall_volume_ratio_m_inv'])

    def test_exact_walls_axis_and_periodic_allocation(self):
        dims=None
        for n,angular,margin in [(n,8,1) for n in fixture.MESHES]+[(28,8,2),(24,16,1)]:
            sim,meta=fixture.build(n,'dielectric',angular,margin,300e-9)
            with tempfile.TemporaryDirectory() as directory:
                xml=Path(directory)/'input.xml'
                sim.fdtd.Write2XML(str(xml))
                tree=ET.parse(xml).getroot()
                self.assertEqual(tree.find('ContinuousStructure').get('CoordSystem'),'1')
                self.assertEqual(tree.find('FDTD').get('CylinderCoords'),'1')
            r=np.asarray(sim.mesh.GetLines('x'))
            z=np.asarray(sim.mesh.GetLines('z'))
            self.assertEqual(r[0],0.)
            self.assertIn(fixture.RADIUS_MM,r)
            self.assertIn(0.,z)
            self.assertIn(fixture.LENGTH_MM,z)
            self.assertEqual(meta['native_lines'][1],angular+2)
            self.assertEqual(meta['reported_grid_lines'][1],angular)
            self.assertEqual(meta['native_cells'],int(np.prod(meta['native_lines'])))
            if dims is None:
                dims=meta['physical_dimensions_mm']
            self.assertEqual(meta['physical_dimensions_mm'],dims)
            with self.assertRaisesRegex(ValueError,'no Cartesian bundle'):
                sim.to_bundle()

    def test_angular_and_backing_controls_keep_the_same_clock(self):
        cases=[fixture.build(24,'both_sheet',angular,margin,300e-9)[1] for angular,margin in ((8,1),(16,1),(8,2))]
        self.assertEqual(len({v['declared_dt_s'] for v in cases}),1)
        self.assertTrue(all(v['sheet_sigma_s_m']==fixture.SIGMA/4 for v in cases))
        self.assertTrue(all(v['axis_included'] for v in cases))

    def test_invalid_parameters_and_duration_caps(self):
        for n,kind,angular,margin,cap in ((True,'pec',8,1,300e-9),(20,'pec',8,1,300e-9),
            (24,'bulk',8,1,300e-9),(24,'pec',8.,1,300e-9),(24,'pec',12,1,300e-9),
            (24,'pec',8,2.,300e-9),(24,'pec',8,3,300e-9),(24,'pec',8,1,220e-9),
            (24,'pec',8,1,np.nan),(24,'pec',8,1,16.01e-6)):
            with self.assertRaises(ValueError):
                fixture.build(n,kind,angular,margin,cap)
        self.assertEqual(fixture.build(24,'copper_sheet',cap_s=16000/1e9)[1]['cap_s'],16e-6)
        for f in (0,-1,np.nan,np.inf):
            with self.assertRaises(ValueError):
                fixture.reference('dielectric',f)


class Analysis(unittest.TestCase):
    def test_native_geometry_logging_preserves_runner_options_and_handle(self):
        sim,_=fixture.build(24,'pec')
        native=Mock()
        sim.fdtd=native
        result={'kept':'production runner result'}
        native.Run.return_value=result
        def runner(*args,**kwargs):
            sim.fdtd.SetCSX('delegated geometry')
            return sim.fdtd.Run('raw',verbose=0,numThreads=fixture.THREADS,cleanup=True)
        with patch.object(fixture.Simulation,'run',side_effect=runner):
            self.assertIs(sim.run('raw',threads=fixture.THREADS),result)
        native.SetCSX.assert_called_once_with('delegated geometry')
        native.Run.assert_called_once_with('raw',verbose=1,numThreads=fixture.THREADS,cleanup=True)
        self.assertIs(sim.fdtd,native)
        with patch.object(fixture.Simulation,'run',side_effect=RuntimeError('native failure')):
            with self.assertRaisesRegex(RuntimeError,'native failure'):
                sim.run('raw')
        self.assertIs(sim.fdtd,native)

    def test_free_signed_field_pole_and_multimode_residual(self):
        t=np.arange(0,80e-9,20e-12)
        f,q=4.821e9,2187.
        y=2.1*np.exp(-np.pi*f/q*t)*np.cos(2*np.pi*f*t+.13)+.005
        value=fixture.pole(t,y)
        self.assertAlmostEqual(value['f_hz']/f,1,places=10)
        self.assertAlmostEqual(value['q']/q,1,places=8)
        growth=fixture.pole(t,np.exp(1e6*t)*np.cos(2*np.pi*f*t))
        self.assertLess(growth['alpha_s'],0)
        self.assertIsNone(growth['q'])
        multi=fixture.pole(t,y+.35*np.cos(2*np.pi*5.3e9*t))
        self.assertGreater(multi['relative_residual'],fixture.GATES['residual'])
        for clock,signal in ((t[::-1],y),(t,np.zeros_like(t)),(t[:20],y[:20]),(t,y*np.nan)):
            with self.assertRaises(ValueError):
                fixture.pole(clock,signal)

    def test_native_closed_axis_header_and_stability_warning(self):
        meta=dict(reported_grid_lines=[26,8,51],native_cells=13260,f_max_hz=5.5e9,native=dict(dt_s=1e-12))
        text=(f'openEMS 64bit -- version v0.37.0-rc3\nfixed number of threads: {fixture.THREADS}\n'
            'FDTD simulation size: 26x8x51 --> 13260 FDTD cells\n'
            'Exact-endcriteria: evaluating the end criteria every 90 timestep(s)\n'
            'Create cylindrical FDTD operator\nr=0 included...\nAlpha is a full 2*PI => closed Cylinder')
        value=audit_header(text,meta)
        self.assertTrue(value['axis_included'] and value['closed_alpha'])
        for old,new in (('rc3','rc4'),(f'threads: {fixture.THREADS}','threads: 8'),('26x8','27x8'),('every 90','every 91'),
                        ('r=0 included','axis absent'),('closed Cylinder','open sector')):
            with self.assertRaises(ValueError):
                audit_header(text.replace(old,new),meta)
        with self.assertRaisesRegex(ValueError,'stability'):
            audit_header(text+'\nforced timestep: 2e-12s is larger than calculated timestep: 1e-12s!',meta)

    def test_budget_refusal_before_launch_and_sparse_energy(self):
        with tempfile.TemporaryDirectory() as directory,patch('tests.test_cylindrical_cavity.popen_group') as launch:
            with self.assertRaisesRegex(ValueError,'exceeds 30'):
                acquire_serial(Path(directory)/'case',32,'copper_sheet',16,2,16e-6,1.)
            launch.assert_not_called()
        _,m=fixture.build(24,'dielectric')
        for rate in (0,-1,np.nan,np.inf):
            with self.assertRaises(ValueError):
                forecast(m,rate)
        with self.assertRaisesRegex(ValueError,'20 positive'):
            fixture.energy_decay(np.arange(10)*1e-9,np.exp(-np.arange(10)),5e9)

    def test_record_requires_stop_axis_clock_and_complete_windows(self):
        cases=(('dielectric',True,False,False),('dielectric',False,False,False),
               ('dielectric',True,True,False),('copper_sheet',True,False,False),
               ('dielectric',True,False,True))
        for kind,stopped,wrong_clock,short in cases:
            with tempfile.TemporaryDirectory() as directory:
                out=Path(directory)
                _,m=fixture.build(24,kind,cap_s=230e-9)
                dt=m['declared_dt_s']
                stride=dt*m['probe_stride_steps']
                t=np.arange(m['max_timesteps']//m['probe_stride_steps']+1)*stride
                if wrong_clock:
                    t*=2
                if short:
                    t=t[t<170e-9]
                (out/'input.xml').write_text('<own-synthetic-input/>',encoding='utf-8')
                np.savez_compressed(out/'data.npz',t=t,u=np.array([np.cos(2*np.pi*fixture.F0*t)]*2),
                    energy_t=np.linspace(25e-9,200e-9,60),energy=np.geomspace(1,1e-5,60))
                m.update(source_sha256=fixture.identity(),runtime=fixture.runtime_identity(),gates=fixture.GATES,
                    input_sha256=fixture.sha(out/'input.xml'),data_sha256=fixture.sha(out/'data.npz'),
                    native=dict(cells=m['native_cells'],dt_s=dt,numerical_time_s=230e-9,
                                timesteps=m['max_timesteps']-(2 if stopped else 0)),
                    run=dict(grid=m['reported_grid_lines'],converged=stopped,threads=fixture.THREADS),
                    native_header=dict(version='v0.37.0-rc3',threads=fixture.THREADS,axis_included=True,closed_alpha=True,
                        nyquist_interval=int(1/(2*m['f_max_hz']*dt))))
                fixture.save(out/'report.json',m)
                q=fixture.reference(kind)['q_unloaded']
                with patch.object(fixture,'pole',return_value=dict(f_hz=fixture.F0,q=q,alpha_s=1.,relative_residual=0.)), \
                    patch.object(fixture,'energy_decay',return_value=dict(q=q,fitted_span_db=50.,log_rms=0.,q_rel_95_uncertainty=.001)):
                    value=fixture.read(out)
                self.assertEqual(value['matches'],kind=='dielectric' and stopped and not wrong_clock and not short)
                self.assertFalse(value['qualified'])
                if short:
                    self.assertTrue(any('incomplete' in e for e in value['extraction_errors']))
                if kind=='dielectric' and stopped and not wrong_clock and not short:
                    m['native_header']['axis_included']=False
                    fixture.save(out/'report.json',m)
                    self.assertFalse(fixture.read(out)['header_ok'])
                    (out/'input.xml').write_text('<changed/>',encoding='utf-8')
                    with self.assertRaisesRegex(ValueError,'input or data'):
                        fixture.read(out)

    def test_radial_and_independent_control_cohort(self):
        base=dict(kind='dielectric',angular=8,margin=1,f_hz=fixture.F0,q=2500.,matches=True)
        rows=[dict(base,n=n) for n in fixture.MESHES]+[dict(base,n=28,margin=2),dict(base,n=24,angular=16)]
        with tempfile.TemporaryDirectory() as directory,patch.object(fixture,'read',side_effect=rows):
            self.assertTrue(fixture.study(directory)['qualified'])
        for index,key,value in ((1,'n',24),(2,'kind','both_sheet'),(3,'margin',1),(4,'angular',8)):
            broken=[dict(r) for r in rows]
            broken[index][key]=value
            with tempfile.TemporaryDirectory() as directory,patch.object(fixture,'read',side_effect=broken):
                with self.assertRaisesRegex(ValueError,'identity'):
                    fixture.study(directory)
        for index in (2,3,4):
            broken=[dict(r) for r in rows]
            broken[index]['q']=2600.
            with tempfile.TemporaryDirectory() as directory,patch.object(fixture,'read',side_effect=broken):
                self.assertFalse(fixture.study(directory)['qualified'])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    actions=parser.add_mutually_exclusive_group(required=True)
    for action in ('preflight','fdtd','analyse','study'):
        actions.add_argument('--'+action,action='store_true')
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--mesh',type=int,choices=fixture.MESHES,default=24)
    parser.add_argument('--case',choices=fixture.KINDS,default='dielectric')
    parser.add_argument('--angular',type=int,choices=(8,16),default=8)
    parser.add_argument('--margin',type=int,choices=(1,2),default=1)
    parser.add_argument('--cap-ns',type=float)
    parser.add_argument('--rate-mcps',type=float,default=80.)
    parser.add_argument('--worker-case',action='store_true',help=argparse.SUPPRESS)
    args=parser.parse_args()
    cap=args.cap_ns/1e9 if args.cap_ns is not None else None
    if args.preflight:
        args.out.mkdir(parents=True,exist_ok=False)
        rows=[]
        for n,angular,margin in [(n,8,1) for n in fixture.MESHES]+[(28,8,2),(24,16,1)]:
            for kind in fixture.KINDS:
                sim,m=fixture.build(n,kind,angular,margin,cap)
                xml=args.out/f'{kind}_n{n}_a{angular}_margin{margin}.xml'
                sim.fdtd.Write2XML(str(xml))
                rows.append(dict(**m,input_sha256=fixture.sha(xml),estimated_seconds=forecast(m,args.rate_mcps)))
        fixture.save(args.out/'preflight.json',dict(rows=rows,source_sha256=fixture.identity(),runtime=fixture.runtime_identity(),
            gates=fixture.GATES,rate_mcps=args.rate_mcps,qualified=False))
        print(json.dumps(dict(cases=len(rows),deferred=sum(r['estimated_seconds']>1800 for r in rows),
            max_forecast_seconds=max(r['estimated_seconds'] for r in rows))))
    elif args.analyse:
        print(json.dumps(fixture.read(args.out),indent=2))
    elif args.study:
        print(json.dumps(fixture.study(args.out,args.case),indent=2))
    elif args.worker_case:
        print(json.dumps(fixture.acquire(args.out,args.mesh,args.case,args.angular,args.margin,cap),indent=2))
    else:
        print(json.dumps(acquire_serial(args.out,args.mesh,args.case,args.angular,args.margin,cap,args.rate_mcps),indent=2))


if __name__=='__main__':
    if len(sys.argv)==1:
        unittest.main()
    else:
        main()
