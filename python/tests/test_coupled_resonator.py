"""Effective-TEM coupled-resonator checks; native actions are explicitly opt-in."""
import argparse
import json
from pathlib import Path
import re
import sys
import subprocess
import time
import unittest
from unittest.mock import patch

import numpy as np
from fairbeam.procutil import popen_group, release_group, terminate_group
from tests import coupled_resonator_fixture as fixture


def forecast(meta,rate):
    if not np.isfinite(rate) or rate<=0:
        raise ValueError('positive measured throughput required')
    return 20+1.15*meta['native_cells']*meta['max_timesteps']/(rate*1e6)


def audit_header(log,meta):
    version=re.search(r'openEMS 64bit -- version (\S+)',log)
    grid=re.search(r'FDTD simulation size: (\d+)x(\d+)x(\d+) --> (\d+) FDTD cells',log)
    interval=re.search(r'Exact-endcriteria: evaluating the end criteria every (\d+) timestep',log)
    if not version or version[1]!='v0.37.0-rc3' or f'fixed number of threads: {fixture.THREADS}' not in log:
        raise ValueError('expected native version and one worker header')
    if not grid or list(map(int,grid.groups()[:3]))!=meta['grid'] or int(grid[4])!=meta['native_cells']:
        raise ValueError('native allocation differs')
    if not interval or int(interval[1])!=int(1/(2*meta['source_max_hz']*meta['native']['dt_s'])):
        raise ValueError('native exact completion schedule differs')
    if re.search(r'forced timestep:.*larger than calculated timestep|resetting to PEC',log,re.I):
        raise ValueError('native timestep or boundary fallback')
    return dict(version=version[1],threads=fixture.THREADS,nyquist_interval=int(interval[1]))


def serial(out,n,kind,feed,backing,cap_s,rate,cell_map=False,end_db=fixture.END_DB):
    out=Path(out).resolve()
    if out.exists():
        raise ValueError('fresh native output directory required')
    _,meta=fixture.build(n,kind,feed,backing,cap_s,cell_map,end_db)
    seconds=forecast(meta,rate)
    if seconds>1800:
        raise ValueError(f'forecast {seconds/60:.2f} minutes exceeds 30-minute limit')
    out.parent.mkdir(parents=True,exist_ok=True)
    command=[sys.executable,'-m','tests.test_coupled_resonator','--fdtd','--worker',
        '--out',str(out),'--mesh',str(n),'--case',kind,'--feed',str(feed),
        '--backing',str(backing),'--cap-ns',str(cap_s*1e9),'--end-db',str(end_db)]
    if cell_map:
        command.append('--cell-map')
    start,wall=time.monotonic(),time.time()
    log_path=out.with_name(out.name+'.log')
    with log_path.open('w',encoding='utf-8') as log:
        process=popen_group(command,cwd=Path(__file__).resolve().parents[1],stdout=log,stderr=subprocess.STDOUT)
        try:
            while True:
                remaining=1800-max(time.monotonic()-start,time.time()-wall)
                if remaining<=0:
                    raise TimeoutError('owned 30-minute native deadline including suspend')
                try:
                    code=process.wait(timeout=min(remaining,1.))
                    break
                except subprocess.TimeoutExpired:
                    pass
            if code:
                raise RuntimeError('native action failed; retained logs are not qualified')
        finally:
            if process.poll() is None:
                terminate_group(process.pid,grace=0,job=process.win_job)
                process.wait(timeout=15)
            release_group(process)
    elapsed=max(time.monotonic()-start,time.time()-wall)
    path=out/'report.json'
    meta=json.loads(path.read_text(encoding='utf-8'))
    meta['native_header']=audit_header(log_path.read_text(encoding='utf-8'),meta)
    fixture.save(path,meta)
    fixture.save(out.with_name(out.name+'.worker.json'),
        dict(pid=process.pid,command=command,exit_code=code,wall_seconds=elapsed,forecast_seconds=seconds))
    return fixture.read(out)[0]


class CoupledResonatorTests(unittest.TestCase):
    def test_line_design_uses_explicit_si_loss_and_geometry(self):
        self.assertAlmostEqual(fixture.F0/1e9,4.999823177956395)
        self.assertAlmostEqual(fixture.QU,627.2994730307316)
        self.assertAlmostEqual(fixture.CAP_APPROX*1e15,31.85795973079832)
        self.assertAlmostEqual(fixture.CAP_CRITICAL*1e15,32.45441682002833)
        g,z=fixture.line(np.array([fixture.F0]))
        self.assertGreater(g[0].real,0)
        self.assertAlmostEqual(g[0].real/fixture.ALPHA,1,places=5)
        self.assertAlmostEqual(z[0].real,50,places=4)

    def test_constant_reference_matches_independent_series_capacitor(self):
        f=fixture.FREQUENCIES
        g,z=fixture.line(f,exact=False)
        for kind,c in (('approx',fixture.CAP_APPROX),('critical',fixture.CAP_CRITICAL)):
            zin=z/np.tanh(g*fixture.LENGTH)+1/(1j*2*np.pi*f*c)
            target=(zin-fixture.Z0)/(zin+fixture.Z0)
            measured,actual=fixture.reference(kind,f,exact=False)
            np.testing.assert_allclose(actual,zin,rtol=1e-12,atol=1e-10)
            np.testing.assert_allclose(measured,target,rtol=1e-12,atol=1e-12)

    def test_exact_critical_capacitor_matches_without_tuning_approximate_design(self):
        f=np.array([fixture.F_CRITICAL])
        g,z=fixture.reference('critical',f,exact=False)
        self.assertLess(abs(g[0]),1e-12)
        self.assertAlmostEqual(z[0].real,50)
        self.assertLess(abs(z[0].imag),1e-9)
        self.assertNotEqual(fixture.CAP_APPROX,fixture.CAP_CRITICAL)

    def test_lossy_tem_reference_and_passivity_are_separate(self):
        a,_=fixture.reference('critical',exact=False)
        b,_=fixture.reference('critical')
        self.assertGreater(np.max(abs(a-b)),1e-6)
        self.assertLess(np.max(abs(b)),1)
        self.assertGreater(np.min(1-abs(b)**2),0)

    def test_deembedding_inverts_a_lossy_abcd_line(self):
        g,z=fixture.line(fixture.FREQUENCIES)
        _,load=fixture.reference('approx')
        vd=np.ones(len(g),dtype=complex)
        id_=vd/(fixture.Z0**2/load)
        d=.004
        v=vd*np.cosh(g*d)+z*id_*np.sinh(g*d)
        i=id_*np.cosh(g*d)+vd/z*np.sinh(g*d)
        vv,ii=fixture.deembed(v,i,d)
        np.testing.assert_allclose(vv,vd,rtol=1e-12,atol=1e-12)
        np.testing.assert_allclose(ii,id_,rtol=1e-12,atol=1e-12)
        for distance in (-1,np.nan):
            with self.assertRaises(ValueError):
                fixture.deembed(v,i,distance)

    def test_loaded_q_requires_resolved_half_power_edges(self):
        for kind in ('approx','critical'):
            result=fixture.features(fixture.reference(kind)[0])
            self.assertTrue(4.8e9<result['f_hz']<5e9)
            self.assertTrue(200<result['q_loaded']<400)
            self.assertGreater(result['high_hz'],result['low_hz'])
        with self.assertRaises(ValueError):
            fixture.features(np.ones(len(fixture.FREQUENCIES))*2)
        with self.assertRaises(ValueError):
            fixture.features(np.zeros(len(fixture.FREQUENCIES)))

    def test_lorentzian_bandwidth_interpolation(self):
        f=np.linspace(4.8e9,5.2e9,1601)
        q=300
        x=2*q*(f/5e9-1)
        gamma=1j*x/(1+1j*x)
        result=fixture.features(gamma,f)
        self.assertAlmostEqual(result['f_hz'],5e9,delta=1)
        self.assertAlmostEqual(result['q_loaded'],q,delta=.1)

    def test_mesh_controls_preserve_physical_line_and_lumped_value(self):
        for n in fixture.MESHES:
            for feed,backing in ((1,1),(2,1),(1,2)):
                sim,meta=fixture.build(n,'critical',feed,backing)
                self.assertEqual(meta['physical_length_m'],fixture.LENGTH)
                self.assertEqual(meta['declared_dt_s'],fixture.DT)
                self.assertLess(fixture.DT,sim.cfl_timestep())
                self.assertAlmostEqual(meta['dual_shunt_l_h'],fixture.CAP_CRITICAL*2500)
                self.assertEqual(len(sim.lumped_elements),1)
                self.assertEqual(sim.lumped_elements[0]['topology'],'parallel')
                self.assertEqual(sim.boundaries,['PMC','PEC','PMC','PMC','PEC','PEC'])
                self.assertAlmostEqual(meta['source_plane_m']-meta['mesh_lower_x_m'],meta['dx_m'])
                self.assertAlmostEqual(meta['source_plane_m'],-feed*fixture.LENGTH/11)
                self.assertEqual(sim.ports[0]['start'][0],float(sim.mesh.GetLines('x')[1]))
                self.assertEqual(sim.ports[0]['stop'][0],float(sim.mesh.GetLines('x')[1]))
                for contour in meta['current_contours'].values():
                    self.assertTrue(0<contour['lo']<contour['hi']<fixture.WIDTH)
                    self.assertAlmostEqual(contour['weight']*(contour['hi']-contour['lo']),fixture.WIDTH)
                with self.assertRaisesRegex(ValueError,'no Designer bundle'):
                    sim.to_bundle()

    def test_rejects_unsupported_and_invalid_acquisition_parameters(self):
        for n,kind,feed,backing,cap in ((True,'bare',1,1,400e-9),(7,'bare',1,1,400e-9),
                (1,'unknown',1,1,400e-9),(1,'bare',3,1,400e-9),(1,'bare',1,True,400e-9),
                (1,'bare',1,1,np.nan),(1,'bare',1,1,1e-9)):
            with self.assertRaises(ValueError):
                fixture.build(n,kind,feed,backing,cap)
        for f in ([0],[np.nan],[-1],[]):
            with self.assertRaises(ValueError):
                fixture.line(f)

    def test_serialized_current_boxes_have_rounding_margin(self):
        import tempfile
        import xml.etree.ElementTree as ET
        for n in fixture.MESHES:
            for feed,backing in ((1,1),(2,1),(1,2)):
                sim,meta=fixture.build(n,'critical',feed,backing)
                with tempfile.TemporaryDirectory() as tmp:
                    path=Path(tmp)/'probes.xml'
                    sim.fdtd.Write2XML(str(path))
                    probes={p.get('Name'):p for p in ET.parse(path).getroot().findall('.//ProbeBox')}
                for name in meta['expected_current_indices']:
                    box=probes[name].find('.//Box')
                    label=name[0]
                    dy=fixture.WIDTH/(4*n)
                    actual=meta['current_contours'][label]
                    lo=float(box.find('P1').get('Y'))*sim.unit
                    hi=float(box.find('P2').get('Y'))*sim.unit
                    # Enclosure boundaries must be strictly inside their
                    # intended end dual nodes after native XML precision.
                    self.assertGreater(lo-actual['lo'],.005*dy)
                    self.assertGreater(actual['hi']-hi,.005*dy)
                    self.assertLess(lo-actual['lo'],.02*dy)
                    self.assertLess(actual['hi']-hi,.02*dy)
                    dz=fixture.HEIGHT/(2*n)
                    zlo=float(box.find('P1').get('Z'))*sim.unit
                    zhi=float(box.find('P2').get('Z'))*sim.unit
                    self.assertGreater(zlo-(fixture.HEIGHT-dz/2),.005*dz)
                    self.assertGreater((fixture.HEIGHT+dz/2)-zhi,.005*dz)
                    self.assertAlmostEqual(actual['weight']*(actual['hi']-actual['lo']),fixture.WIDTH)

    def test_forecast_guard_precedes_directory_and_worker_creation(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp)/'never-created'
            with patch('tests.test_coupled_resonator.popen_group') as spawn:
                with self.assertRaisesRegex(ValueError,'30-minute'):
                    serial(out,3,'critical',1,1,400e-9,.01)
                self.assertFalse(out.exists())
                spawn.assert_not_called()
        for rate in (0,-1,np.nan):
            with self.assertRaises(ValueError):
                forecast(dict(native_cells=1,max_timesteps=1),rate)

    def test_native_header_rejects_wrong_version_or_thread_count(self):
        _,meta=fixture.build(1,'critical')
        meta['native']=dict(dt_s=fixture.DT)
        interval=int(1/(2*meta['source_max_hz']*fixture.DT))
        log=f"openEMS 64bit -- version v0.37.0-rc3\nfixed number of threads: 1\nFDTD simulation size: {'x'.join(map(str,meta['grid']))} --> {meta['native_cells']} FDTD cells\nExact-endcriteria: evaluating the end criteria every {interval} timestep"
        self.assertEqual(audit_header(log,meta),
            dict(version='v0.37.0-rc3',threads=1,nyquist_interval=interval))
        for bad in (log.replace('v0.37.0-rc3','v0.36.0'),log.replace('threads: 1','threads: 4'),'',
                log.replace(str(meta['native_cells'])+' FDTD cells','1 FDTD cells'),
                log+'\nforced timestep: larger than calculated timestep'):
            with self.assertRaises(ValueError):
                audit_header(bad,meta)

    def test_native_adapter_restores_handle_after_failure(self):
        from unittest.mock import Mock
        sim=fixture.CoupledSimulation(4.7e9,5.05e9)
        native=sim.fdtd
        with patch.object(fixture.Simulation,'run',side_effect=RuntimeError('owned failure')):
            with self.assertRaises(RuntimeError):
                sim.run('unused')
        self.assertIs(sim.fdtd,native)
        native=Mock()
        adapter=fixture._NativeLog(native)
        adapter.Run('unused',verbose=0)
        native.Run.assert_called_once_with('unused',verbose=2)

    def test_reader_rejects_capped_truncated_wrong_clock_and_changed_input(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp)
            _,meta=fixture.build(1,'critical')
            tend=(meta['max_timesteps']-10)*fixture.DT
            stride=int(1/(2*meta['source_max_hz']*fixture.DT))//4*fixture.DT
            clocks=dict(samples=int(tend/stride)+1,first_s=0,last_s=int(tend/stride)*stride,
                stride_s=stride,uniform_rel=0)
            meta.update(source_sha256=fixture.source_identity(),runtime=fixture.runtime_identity(),
                native=dict(cells=meta['native_cells'],dt_s=fixture.DT,
                    timesteps=meta['max_timesteps']-10,numerical_time_s=tend),
                run=dict(grid=meta['grid'],threads=1,converged=True),
                actual_current_indices=meta['expected_current_indices'],
                native_header=dict(version='v0.37.0-rc3',threads=1,
                    nyquist_interval=int(1/(2*meta['source_max_hz']*fixture.DT))),
                probe_clocks={name:dict(clocks) for name in ('et',*[f'v{p}_{j}' for p in range(2) for j in range(3)],
                    *[f'{label}{p}_{j}' for label in ('i','j') for p in range(2) for j in range(2)])})
            (out/'input.xml').write_text('<own-synthetic-test-input/>',encoding='utf-8')
            meta['input_sha256']=fixture.sha(out/'input.xml')
            _,original_z=fixture.reference('critical')
            vd=np.ones(len(fixture.FREQUENCIES),complex)
            id_=vd/(fixture.Z0**2/original_z)
            g,z=fixture.line(fixture.FREQUENCIES)
            vs,cs=[],[]
            for plane in meta['planes_m']:
                d=-plane
                vv=vd*np.cosh(g*d)+z*id_*np.sinh(g*d)
                ii=(id_*np.cosh(g*d)+vd/z*np.sinh(g*d))*np.cosh(g*meta['dx_m']/2)
                vs.append([vv,vv,vv]); cs.append([ii,ii])
            np.savez_compressed(out/'data.npz',f=fixture.FREQUENCIES,v=vs,i=cs,i_check=cs)
            meta['data_sha256']=fixture.sha(out/'data.npz')
            fixture.save(out/'report.json',meta)
            value,_=fixture.read(out)
            self.assertTrue(value['target_passes'])
            self.assertFalse(value['qualified'])
            with np.load(out/'data.npz') as valid:
                retained={key:valid[key].copy() for key in valid.files}
            np.savez_compressed(out/'data.npz',**{key:np.zeros_like(value) if key!='f' else value for key,value in retained.items()})
            empty=dict(meta,data_sha256=fixture.sha(out/'data.npz'))
            fixture.save(out/'report.json',empty)
            with self.assertRaisesRegex(ValueError,'singular incident spectrum'):
                fixture.read(out)
            np.savez_compressed(out/'data.npz',**retained)
            meta['data_sha256']=fixture.sha(out/'data.npz')
            fixture.save(out/'report.json',meta)
            for key,change in (('run',dict(meta['run'],converged=False)),
                    ('native',dict(meta['native'],dt_s=fixture.DT*2)),
                    ('native_header',{}),
                    ('actual_current_indices',{}),
                    ('probe_clocks',dict(v0_0=dict(clocks,last_s=tend-1e-9)))):
                altered=dict(meta,**{key:change})
                fixture.save(out/'report.json',altered)
                self.assertFalse(fixture.read(out)[0]['quality_ok'])
            fixture.save(out/'report.json',meta)
            (out/'input.xml').write_text('<changed/>',encoding='utf-8')
            with self.assertRaisesRegex(ValueError,'input or data'):
                fixture.read(out)

    def test_serialized_lumped_inductor_uses_native_parallel_type(self):
        import tempfile
        import xml.etree.ElementTree as ET
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'input.xml'
            sim,meta=fixture.build(1,'critical')
            sim.fdtd.Write2XML(str(path))
            root=ET.parse(path).getroot()
            elements=root.findall('.//LumpedElement')
            coupling=next(e for e in elements if e.get('Name')=='dual_coupling_L')
            self.assertAlmostEqual(float(coupling.get('L')),meta['dual_shunt_l_h'])
            self.assertEqual(float(coupling.get('LEtype')),0)

    def test_opt_in_node_density_map_preserves_physical_component_and_reference(self):
        import tempfile
        import xml.etree.ElementTree as ET
        for n in fixture.COHORT:
            ordinary,plain=fixture.build(n,'critical',cap_s=100e-9)
            mapped,meta=fixture.build(n,'critical',cap_s=100e-9,cell_map=True)
            self.assertEqual(meta['original_series_c_f'],plain['original_series_c_f'])
            self.assertEqual(meta['dual_shunt_l_h'],plain['dual_shunt_l_h'])
            dy=fixture.WIDTH/(4*n)
            engine_parallel_nodes=4*n+1
            target_density_l=meta['dual_shunt_l_h']*fixture.WIDTH/dy
            self.assertAlmostEqual(meta['native_shunt_l_h']*engine_parallel_nodes/target_density_l,1)
            with tempfile.TemporaryDirectory() as tmp:
                path=Path(tmp)/'mapped.xml'
                mapped.fdtd.Write2XML(str(path))
                element=next(e for e in ET.parse(path).getroot().findall('.//LumpedElement') if e.get('Name')=='dual_coupling_L')
                self.assertAlmostEqual(float(element.get('L'))/meta['native_shunt_l_h'],1)
            self.assertEqual(ordinary.excitation,mapped.excitation)
        with self.assertRaises(ValueError):
            fixture.build(3,'critical',cell_map=1)

    def test_cohort_does_not_accept_missing_quality_or_physical_gap(self):
        base=dict(kind='critical',cell_map=False,end_criteria_db=fixture.END_DB,
            target_passes=True,measured=dict(f_hz=4.92e9,q_loaded=310.))
        gamma=fixture.reference('critical')[0]
        records=[(dict(base,n=n,feed=1,backing=1),gamma) for n in (1,2,3)]
        records += [(dict(base,n=2,feed=2,backing=1),gamma),(dict(base,n=2,feed=1,backing=2),gamma)]
        import tempfile
        with tempfile.TemporaryDirectory() as tmp,patch.object(fixture,'read',side_effect=records):
            value=fixture.study(tmp,'critical')
            self.assertTrue(value['numerical_circuit_scope_passes'])
            self.assertFalse(value['qualified_physical_microstrip_gap'])
        records[1][0]['target_passes']=False
        with tempfile.TemporaryDirectory() as tmp,patch.object(fixture,'read',side_effect=records):
            self.assertFalse(fixture.study(tmp,'critical')['numerical_circuit_scope_passes'])

    def test_stricter_native_stopping_is_opt_in_and_serialized(self):
        import tempfile
        import xml.etree.ElementTree as ET
        plain,baseline=fixture.build(5,'critical',cap_s=150e-9,cell_map=True)
        self.assertEqual(plain.end_criteria_db,-70.)
        for end_db in (-90.,-100.):
            sim,meta=fixture.build(5,'critical',cap_s=150e-9,cell_map=True,end_db=end_db)
            self.assertEqual(meta,{**baseline,'end_criteria_db':end_db})
            with tempfile.TemporaryDirectory() as tmp:
                path=Path(tmp)/'stop.xml'
                sim.fdtd.Write2XML(str(path))
                fdtd=ET.parse(path).getroot().find('FDTD')
                self.assertAlmostEqual(float(fdtd.get('endCriteria'))/10**(end_db/10),1)
        for invalid in (-80.,0.,np.nan,True):
            with self.assertRaises(ValueError):
                fixture.build(5,'critical',end_db=invalid)

    def test_time_control_rejects_missing_unchanged_and_inconsistent_results(self):
        import tempfile
        base=dict(kind='critical',cell_map=True,end_criteria_db=-90.,target_passes=True,
            measured=dict(f_hz=4.92e9,q_loaded=310.))
        gamma=fixture.reference('critical')[0]
        records={f'n{n}':(dict(base,n=n,feed=1,backing=1),gamma) for n in fixture.COHORT}
        records.update(n5_feed=(dict(base,n=5,feed=2,backing=1),gamma),
            n5_backing=(dict(base,n=5,feed=1,backing=2),gamma))
        def read(path):
            key=Path(path).parent.name
            if key not in records:
                raise FileNotFoundError(key)
            return records[key]
        def check(required):
            with tempfile.TemporaryDirectory() as tmp,patch.object(fixture,'read',side_effect=read):
                return fixture.study(tmp,'critical',fixture.COHORT,True,required)
        self.assertFalse(check(False)['time_convergence_proven'])
        with self.assertRaises(FileNotFoundError):
            check(True)
        temporal=dict(base,n=5,feed=1,backing=1)
        records['n5_time']=(temporal,gamma)
        with self.assertRaisesRegex(ValueError,'strictly tighter'):
            check(True)
        temporal['end_criteria_db']=-100.
        self.assertTrue(check(True)['time_convergence_proven'])
        self.assertFalse(check(True)['qualified_physical_microstrip_gap'])
        records['n5_time']=(temporal,gamma*np.exp(.004j))
        self.assertFalse(check(True)['numerical_circuit_scope_passes'])
        records['n5_time']=(dict(temporal,target_passes=False),gamma)
        self.assertFalse(check(True)['time_convergence_proven'])
        records['n4']=(dict(records['n4'][0],end_criteria_db=-70.),gamma)
        with self.assertRaisesRegex(ValueError,'stopping criteria differ'):
            check(False)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    group=p.add_mutually_exclusive_group(required=True)
    for action in ('preflight','fdtd','analyse','study'):
        group.add_argument('--'+action,action='store_true')
    p.add_argument('--out',type=Path,required=True)
    p.add_argument('--mesh',type=int,choices=fixture.MESHES,default=1)
    p.add_argument('--case',choices=fixture.KINDS,default='critical')
    p.add_argument('--feed',type=int,choices=(1,2),default=1)
    p.add_argument('--backing',type=int,choices=(1,2),default=1)
    p.add_argument('--cap-ns',type=float,default=400.)
    p.add_argument('--rate-mcps',type=float,default=20.)
    p.add_argument('--worker',action='store_true',help=argparse.SUPPRESS)
    p.add_argument('--cell-map',action='store_true',help='Opt-in TEM node-density map; physical and native L recorded separately')
    p.add_argument('--end-db',type=float,choices=fixture.END_CHOICES,default=fixture.END_DB,
        help='Requested native fast-energy proxy stop; independent of physical stored energy')
    p.add_argument('--time-control',action='store_true',help='Require a stricter n<mid>_time record for the cohort')
    p.add_argument('--meshes',type=int,nargs=3,help='Three increasing meshes for the comparison cohort')
    a=p.parse_args()
    cap=a.cap_ns/1e9
    if a.preflight:
        a.out.mkdir(parents=True,exist_ok=False)
        rows=[]
        for n,feed,backing in [(n,1,1) for n in fixture.MESHES]+[(2,2,1),(2,1,2)]:
            for kind in fixture.KINDS:
                sim,meta=fixture.build(n,kind,feed,backing,cap,a.cell_map,a.end_db)
                xml=a.out/f'{kind}_n{n}_f{feed}_b{backing}.xml'
                sim.fdtd.Write2XML(str(xml))
                rows.append(dict(**meta,input_sha256=fixture.sha(xml),forecast_seconds=forecast(meta,a.rate_mcps)))
        fixture.save(a.out/'preflight.json',dict(rows=rows,source_sha256=fixture.source_identity(),
            runtime=fixture.runtime_identity(),qualified_physical_microstrip_gap=False))
        print(json.dumps(dict(cases=len(rows),deferred=sum(r['forecast_seconds']>1800 for r in rows))))
    elif a.analyse:
        print(json.dumps(fixture.read(a.out)[0],indent=2))
    elif a.study:
        print(json.dumps(fixture.study(a.out,a.case,a.meshes or (fixture.COHORT if a.cell_map else (1,2,3)),a.cell_map,a.time_control),indent=2))
    elif a.worker:
        print(json.dumps(fixture.acquire(a.out,a.mesh,a.case,a.feed,a.backing,cap,a.cell_map,a.end_db),indent=2))
    else:
        print(json.dumps(serial(a.out,a.mesh,a.case,a.feed,a.backing,cap,a.rate_mcps,a.cell_map,a.end_db),indent=2))


if __name__=='__main__':
    if len(sys.argv)==1:
        unittest.main()
    else:
        main()
