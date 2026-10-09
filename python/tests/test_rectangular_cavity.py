r"""TE101/102 reference and bounded native controls, Example 6.3.

From python/ in the bundled openEMS environment, using fresh external paths:
python -m unittest tests.test_rectangular_cavity -q
python -m tests.test_rectangular_cavity --preflight --out C:\Temp\cavity-plan
python -m tests.test_rectangular_cavity --fdtd --mode 1 --case dielectric --out C:\Temp\cavity-d-n18
python -m tests.test_rectangular_cavity --analyse --out C:\Temp\cavity-d-n18

Ordinary unittest never starts FDTD. Every explicit acquisition rejects a
forecast over 30 minutes and has a suspend-inclusive owned-worker deadline.
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
from unittest.mock import patch
import xml.etree.ElementTree as ET

import numpy as np

from fairbeam.procutil import popen_group, release_group, terminate_group
from tests.coax_resonator_fixture import save
from tests.test_coax_resonator import forecast, wait_owned
from tests import rectangular_cavity_fixture as fixture


def audit_header(text, meta):
    version = re.search(r'openEMS 64bit -- version (\S+)', text)
    grid = re.search(r'FDTD simulation size: (\d+)x(\d+)x(\d+) --> (\d+) FDTD cells', text)
    interval = re.search(r'Exact-endcriteria: evaluating the end criteria every (\d+) timestep', text)
    if not version or not grid or not interval:
        raise ValueError('native version/grid/sampling header missing')
    if version[1]!='v0.37.0-rc3' or 'fixed number of threads: 4' not in text:
        raise ValueError('bundled rc3 and four threads required')
    if list(map(int,grid.groups()[:3]))!=meta['native_lines'] or int(grid[4])!=meta['native_cells']:
        raise ValueError('native allocation differs from declared Cartesian grid')
    if int(interval[1])!=int(1/(2*meta['f_max_hz']*meta['native']['dt_s'])):
        raise ValueError('native sampling schedule differs')
    if re.search(r'forced timestep:.*larger than calculated timestep', text, re.I):
        raise ValueError('native stability bound exceeded')
    return dict(version=version[1], threads=fixture.THREADS, nyquist_interval=int(interval[1]))


def acquire_serial(out, n, mode, kind, margin, cap_s, rate):
    out = Path(out).resolve()
    if out.exists():
        raise ValueError('retain existing acquisition; choose a fresh output')
    _, meta = fixture.build(n, mode, kind, margin, cap_s)
    estimate = forecast(meta, rate)
    if estimate>1800:
        raise ValueError(f'forecast {estimate/60:.2f} minutes exceeds 30; defer before launch')
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, '-m', 'tests.test_rectangular_cavity', '--fdtd', '--worker-case',
               '--mesh', str(n), '--mode', str(mode), '--case', kind, '--margin', str(margin),
               '--cap-ns', str(meta['cap_s']*1e9), '--out', str(out)]
    log_path = out.with_name(out.name+'.log')
    code = None
    with log_path.open('w',encoding='utf-8') as log:
        process = popen_group(command, cwd=Path(__file__).resolve().parents[1],
                              stdout=log, stderr=subprocess.STDOUT,
                              env={**os.environ,'OMP_NUM_THREADS':'4','OPENBLAS_NUM_THREADS':'1'})
        monotonic, wall = time.monotonic(), time.time()
        try:
            code = wait_owned(process)
        finally:
            if process.poll() is None:
                terminate_group(process.pid, grace=0, job=process.win_job)
                process.wait(timeout=15)
            release_group(process)
            save(out.with_name(out.name+'.worker.json'),dict(command=command,pid=process.pid,exit_code=code,
                estimated_seconds=estimate, rate_mcps=rate, monotonic_seconds=time.monotonic()-monotonic,
                wall_seconds=time.time()-wall))
    if code:
        raise RuntimeError(f'native exit {code}; raw and log retained')
    report = json.loads((out/'report.json').read_text(encoding='utf-8'))
    report['native_header'] = audit_header(log_path.read_text(encoding='utf-8'), report)
    save(out/'report.json', report)
    return fixture.read(out)


class References(unittest.TestCase):
    def test_fixed_geometry_and_both_axial_orders(self):
        for mode in fixture.MODES:
            r = fixture.reference(mode,'dielectric')
            actual = fixture.C0/(2*np.sqrt(fixture.ER))*np.sqrt((1/(fixture.A*1e-3))**2+(mode/(r['length_mm']*1e-3))**2)
            self.assertAlmostEqual(actual/fixture.F0,1,places=14)
        self.assertAlmostEqual(fixture.reference(2,'pec')['length_mm']/fixture.reference(1,'pec')['length_mm'],2)

    def test_wall_integral_is_independent_of_closed_form(self):
        # Numerical Hx/Hz wall/volume integrals; include all six walls.
        for mode in fixture.MODES:
            r = fixture.reference(mode,'copper_sheet')
            a,b,d = fixture.A*1e-3,fixture.B*1e-3,r['length_mm']*1e-3
            kx,kz = np.pi/a,mode*np.pi/d
            x,z = np.linspace(0,a,101),np.linspace(0,d,101)
            hx = kz*np.sin(kx*x[:,None])*np.cos(kz*z[None,:])
            hz = kx*np.cos(kx*x[:,None])*np.sin(kz*z[None,:])
            integ = lambda y,v,axis=-1: np.trapezoid(y,v,axis=axis)
            volume = b*integ(integ(hx*hx+hz*hz,z),x)
            surface = 2*b*integ(kx*kx*np.sin(kz*z)**2,z)
            surface += 2*integ(integ(hx*hx+hz*hz,z),x)
            surface += 2*b*integ(kz*kz*np.sin(kx*x)**2,x)
            self.assertAlmostEqual(surface/volume/r['wall_volume_ratio_m_inv'],1,places=12)

    def test_loss_addition_frequency_scaling_and_end_caps(self):
        for mode in fixture.MODES:
            d,c,total = [fixture.reference(mode,k) for k in ('dielectric','copper_sheet','both_sheet')]
            self.assertAlmostEqual(1/total['q_unloaded'],1/d['qd']+1/c['qc'],places=15)
            self.assertEqual(d['qd'],2500)
            self.assertTrue(c['all_six_wall_losses_included'])
            self.assertAlmostEqual(fixture.reference(mode,'dielectric',4e9)['qd']/d['qd'],.8)
            self.assertAlmostEqual(fixture.reference(mode,'copper_sheet',4e9)['qc']/c['qc'],np.sqrt(.8))
        self.assertGreater(fixture.reference(2,'copper_sheet')['qc'],fixture.reference(1,'copper_sheet')['qc'])
        self.assertIsNone(fixture.reference(1,'pec')['q_unloaded'])

    def test_mesh_and_backing_control_preserve_physical_cavity(self):
        for mode in fixture.MODES:
            dimensions = None
            for n,margin in [(n,1) for n in fixture.MESHES]+[(22,2)]:
                sim,meta = fixture.build(n,mode,'both_sheet',margin,300e-9)
                if dimensions is None:
                    dimensions=meta['physical_dimensions_mm']
                self.assertEqual(meta['physical_dimensions_mm'],dimensions)
                self.assertEqual(meta['sheet_sigma_s_m'],fixture.SIGMA/4)
                self.assertEqual(meta['threads'],4)
                for axis,length in zip('xyz',dimensions):
                    lines=np.asarray(sim.mesh.GetLines(axis))
                    self.assertLess(np.min(abs(lines)),1e-10)
                    self.assertLess(np.min(abs(lines-length)),1e-10)
                with self.assertRaisesRegex(ValueError,'no exportable ports'):
                    sim.to_bundle()

    def test_bad_parameters_and_cap_roundtrip(self):
        for n,mode,kind,margin,cap in ((True,1,'pec',1,300e-9),(20,1,'pec',1,300e-9),
                                      (18,3,'pec',1,300e-9),(18,1,'bulk',1,300e-9),
                                      (18,1,'pec',3,300e-9),(18,1,'pec',1,220e-9),
                                      (18,1,'pec',1,np.nan),(18,1,'pec',1,8.01e-6)):
            with self.assertRaises(ValueError):
                fixture.build(n,mode,kind,margin,cap)
        self.assertEqual(fixture.build(18,1,'copper_sheet',cap_s=8000/1e9)[1]['cap_s'],8e-6)

    def test_uniform_yee_dispersion_is_separate_from_static_target(self):
        for mode in fixture.MODES:
            errors=[]
            for n in fixture.MESHES:
                _,meta=fixture.build(n,mode,'dielectric')
                self.assertEqual(meta['reference']['f_target_hz'],fixture.F0)
                self.assertLess(meta['lossless_uniform_yee_frequency_hz'],fixture.F0)
                errors.append(1-meta['lossless_uniform_yee_frequency_hz']/fixture.F0)
            self.assertGreater(errors[0],errors[1])
            self.assertGreater(errors[1],errors[2])


class Analysis(unittest.TestCase):
    def test_free_decaying_pole_does_not_receive_target(self):
        t=np.arange(0,80e-9,20e-12)
        frequency,q=4.823e9,1937.
        alpha=np.pi*frequency/q
        result=fixture.pole(t,2.3*np.exp(-alpha*t)*np.cos(2*np.pi*frequency*t+.31)+.007)
        self.assertAlmostEqual(result['f_hz']/frequency,1,places=10)
        self.assertAlmostEqual(result['q']/q,1,places=8)
        self.assertLess(result['relative_residual'],1e-12)

    def test_growth_and_bad_clock_are_not_valid_q(self):
        t=np.arange(0,80e-9,20e-12)
        y=np.exp(1e6*t)*np.cos(2*np.pi*4.7e9*t)
        result=fixture.pole(t,y)
        self.assertLess(result['alpha_s'],0)
        self.assertIsNone(result['q'])
        for clock,signal in ((t[::-1],y),(t,np.zeros_like(t)),(t[:50],y[:50]),(t,y*np.nan)):
            with self.assertRaises(ValueError):
                fixture.pole(clock,signal)

    def test_multimode_and_sparse_proxy_diagnostics(self):
        t=np.arange(0,80e-9,20e-12)
        y=np.cos(2*np.pi*4.7e9*t)+.35*np.cos(2*np.pi*5.3e9*t)
        self.assertGreater(fixture.pole(t,y)['relative_residual'],fixture.GATES['residual'])
        with self.assertRaisesRegex(ValueError,'20 positive'):
            fixture.energy_decay(np.arange(10)*1e-9,np.exp(-np.arange(10)),5e9)

    def test_native_header_and_stability_warning(self):
        meta=dict(native_lines=[30,20,25],native_cells=15000,f_max_hz=5.5e9,native=dict(dt_s=1e-12))
        text=('openEMS 64bit -- version v0.37.0-rc3\nfixed number of threads: 4\n'
              'FDTD simulation size: 30x20x25 --> 15000 FDTD cells\n'
              'Exact-endcriteria: evaluating the end criteria every 90 timestep(s)')
        self.assertEqual(audit_header(text,meta)['nyquist_interval'],90)
        for old,new in (('rc3','rc4'),('30x20','31x20'),('every 90','every 91'),('threads: 4','threads: 8')):
            with self.assertRaises(ValueError):
                audit_header(text.replace(old,new),meta)
        with self.assertRaisesRegex(ValueError,'stability'):
            audit_header(text+'\nWarning, forced timestep: 2e-12s is larger than calculated timestep: 1e-12s!',meta)

    def test_forecast_refuses_large_case_before_launch(self):
        with tempfile.TemporaryDirectory() as directory, patch('tests.test_rectangular_cavity.popen_group') as launch:
            with self.assertRaisesRegex(ValueError,'exceeds 30'):
                acquire_serial(Path(directory)/'case',26,2,'copper_sheet',2,8e-6,1.)
            launch.assert_not_called()
        _,meta=fixture.build(18,1,'dielectric')
        for rate in (0,np.inf,np.nan,-1):
            with self.assertRaises(ValueError):
                forecast(meta,rate)

    def test_stop_probe_clock_sheet_and_window_refusals(self):
        cases=(('dielectric',True,False,False),('dielectric',False,False,False),
               ('dielectric',True,True,False),('copper_sheet',True,False,False),
               ('dielectric',True,False,True))
        for kind,stopped,wrong_clock,short_window in cases:
            with tempfile.TemporaryDirectory() as directory:
                out=Path(directory)
                _,meta=fixture.build(18,1,kind,cap_s=230e-9)
                dt=meta['declared_dt_s']
                stride=dt*meta['probe_stride_steps']
                t=np.arange(meta['max_timesteps']//meta['probe_stride_steps']+1)*stride
                if wrong_clock:
                    t*=2
                if short_window:
                    t=t[t<170e-9]
                (out/'input.xml').write_text('<own-synthetic-input/>',encoding='utf-8')
                np.savez_compressed(out/'data.npz',t=t,u=np.array([np.cos(2*np.pi*fixture.F0*t)]*2),
                                    energy_t=np.linspace(25e-9,200e-9,60),energy=np.geomspace(1,1e-5,60))
                meta.update(source_sha256=fixture.identity(),runtime=fixture.runtime_identity(),gates=fixture.GATES,
                    input_sha256=fixture.sha(out/'input.xml'),data_sha256=fixture.sha(out/'data.npz'),
                    native=dict(cells=meta['native_cells'],dt_s=dt,numerical_time_s=230e-9,
                                timesteps=meta['max_timesteps']-(2 if stopped else 0)),
                    run=dict(grid=meta['native_lines'],converged=stopped,threads=4),
                    native_header=dict(version='v0.37.0-rc3',threads=4,nyquist_interval=int(1/(2*meta['f_max_hz']*dt))))
                save(out/'report.json',meta)
                q=fixture.reference(1,kind)['q_unloaded']
                with patch.object(fixture,'pole',return_value=dict(f_hz=fixture.F0,q=q,alpha_s=1.,relative_residual=0.)), \
                     patch.object(fixture,'energy_decay',return_value=dict(q=q,fitted_span_db=50.,log_rms=0.,q_rel_95_uncertainty=.001)):
                    result=fixture.read(out)
                self.assertEqual(result['matches'],kind=='dielectric' and stopped and not wrong_clock and not short_window)
                self.assertFalse(result['qualified'])
                if short_window:
                    self.assertTrue(any('incomplete' in e for e in result['extraction_errors']))
                if kind=='dielectric' and stopped and not wrong_clock and not short_window:
                    meta['native_header']['threads']=8
                    save(out/'report.json',meta)
                    self.assertFalse(fixture.read(out)['header_ok'])
                    (out/'input.xml').write_text('<changed/>',encoding='utf-8')
                    with self.assertRaisesRegex(ValueError,'input or data'):
                        fixture.read(out)

    def test_cohort_requires_distinct_mode_mesh_and_backing(self):
        base=dict(mode=1,kind='dielectric',margin=1,f_hz=fixture.F0,q=2500.,matches=True)
        rows=[dict(base,n=n) for n in fixture.MESHES]+[dict(base,n=22,margin=2)]
        with tempfile.TemporaryDirectory() as directory, patch.object(fixture,'read',side_effect=rows):
            self.assertTrue(fixture.study(directory,1)['qualified'])
        for index,key,value in ((1,'n',18),(2,'mode',2),(3,'margin',1)):
            broken=[dict(r) for r in rows]
            broken[index][key]=value
            with tempfile.TemporaryDirectory() as directory, patch.object(fixture,'read',side_effect=broken):
                with self.assertRaisesRegex(ValueError,'identity'):
                    fixture.study(directory,1)
        broken=[dict(r) for r in rows]
        broken[2]['q']=2600.
        with tempfile.TemporaryDirectory() as directory, patch.object(fixture,'read',side_effect=broken):
            self.assertFalse(fixture.study(directory,1)['qualified'])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    actions=parser.add_mutually_exclusive_group(required=True)
    for action in ('preflight','fdtd','analyse','study'):
        actions.add_argument('--'+action,action='store_true')
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--mesh',type=int,choices=fixture.MESHES,default=18)
    parser.add_argument('--mode',type=int,choices=fixture.MODES,default=1)
    parser.add_argument('--case',choices=fixture.KINDS,default='dielectric')
    parser.add_argument('--margin',type=int,choices=(1,2),default=1)
    parser.add_argument('--cap-ns',type=float)
    parser.add_argument('--rate-mcps',type=float,default=80.)
    parser.add_argument('--worker-case',action='store_true',help=argparse.SUPPRESS)
    args=parser.parse_args()
    cap=args.cap_ns/1e9 if args.cap_ns is not None else None
    if args.preflight:
        args.out.mkdir(parents=True,exist_ok=False)
        rows=[]
        for mode in fixture.MODES:
            for n,margin in [(n,1) for n in fixture.MESHES]+[(22,2)]:
                for kind in fixture.KINDS:
                    sim,meta=fixture.build(n,mode,kind,margin,cap)
                    file=args.out/f'm{mode}_{kind}_n{n}_margin{margin}.xml'
                    sim.fdtd.Write2XML(str(file))
                    rows.append(dict(**meta,input_sha256=fixture.sha(file),
                                     estimated_seconds=forecast(meta,args.rate_mcps)))
        save(args.out/'preflight.json',dict(source_sha256=fixture.identity(),runtime=fixture.runtime_identity(),
             gates=fixture.GATES,rows=rows,rate_mcps=args.rate_mcps,qualified=False))
        print(json.dumps(dict(cases=len(rows),deferred=sum(r['estimated_seconds']>1800 for r in rows),
                              max_forecast_seconds=max(r['estimated_seconds'] for r in rows))))
    elif args.analyse:
        print(json.dumps(fixture.read(args.out),indent=2))
    elif args.study:
        print(json.dumps(fixture.study(args.out,args.mode,args.case),indent=2))
    elif args.worker_case:
        print(json.dumps(fixture.acquire(args.out,args.mesh,args.mode,args.case,args.margin,cap),indent=2))
    else:
        print(json.dumps(acquire_serial(args.out,args.mesh,args.mode,args.case,args.margin,cap,args.rate_mcps),indent=2))


if __name__=='__main__':
    if len(sys.argv)==1:
        unittest.main()
    else:
        main()
