"""Opt-in, one-source, high-rate E/H diagnostic; never an LC qualification.

From python/ with the same SDK as an already audited ordinary n1/port1:
python -m unittest tests.test_composite_lc_field_floor -q
python -m tests.test_composite_lc_field_floor --fdtd --pilot --baseline D:/study/baseline/port1 --out D:/study/floor-pilot
python -m tests.test_composite_lc_field_floor --fdtd --rate-mcps 85 --baseline D:/study/baseline/port1 --out D:/study/floor-full
python -m tests.test_composite_lc_field_floor --analyse --out D:/study/floor-full

Four additive field probes override only their sampling. Existing geometry,
30 terminal probes, source, 65 us cap, clock and stopping gates stay fixed.
Pilots are source-incomplete timing only; no S matrix or bundle is produced.
"""
import argparse
from contextlib import contextmanager
import json
import math
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import numpy as np
from tests import composite_lc_filter_fixture as f
from tests import test_composite_lc_filter_fixture as t

OVERSAMPLING, PILOT_S, DEADLINE = 2704, .25e-6, 1800.
POINTS = {'element': (.008, 0., .010), 'air': (0., .012, .016)}
PROBES = {f'floor_{kind}_{name}': dict(kind=kind, position_m=list(point))
    for name, point in POINTS.items() for kind in ('E', 'H')}


@contextmanager
def field_context(pilot=False):
    build, identity = f.build, f.identity
    def model(n, port, kind='filter', control='ordinary', threads=1):
        if n != 1 or port != 1 or kind != 'filter' or control != 'ordinary' or threads != 1:
            raise ValueError('one-thread ordinary n1/port1 diagnostic required')
        sim, meta = build(n, port, kind, control, threads)
        if 'field_floor' in meta:
            raise ValueError('nested diagnostic context')
        for name, box in PROBES.items():
            xyz = np.array(box['position_m'])/sim.unit
            sim.csx.AddProbe(name, p_type=2 if box['kind']=='E' else 3,
                over_sampling=OVERSAMPLING).AddBox(xyz, xyz)
        if pilot:
            steps = math.ceil(PILOT_S/meta['declared_dt_s'])
            sim.fdtd.SetNumberOfTimeSteps(steps); sim.max_timesteps = steps
            meta.update(cap_s=PILOT_S, max_timesteps=steps)
        if sim.csx.Update():
            raise ValueError('diagnostic probe geometry failed')
        meta['field_floor'] = dict(probes=PROBES, over_sampling=OVERSAMPLING,
            pilot_only=pilot, one_source_only=True)
        return sim, meta
    def source():
        return {**identity(), 'tests/test_composite_lc_field_floor.py': f.sha(__file__)}
    try:
        f.build, f.identity = model, source
        yield
    finally:
        f.build, f.identity = build, identity


def preserved_input(path, pilot=False):
    root = ET.parse(path).getroot()
    for parent in root.iter():
        for child in list(parent):
            if child.tag=='ProbeBox' and child.get('Name') in PROBES:
                parent.remove(child)
    if pilot:
        for node in root.iter('FDTD'):
            node.attrib.pop('NumberOfTimesteps', None)
    for node in root.iter():
        if node.text is not None and not node.text.strip():node.text=None
        if node.tail is not None and not node.tail.strip():node.tail=None
    return ET.tostring(root)


def prepare(out, baseline, pilot=False, rate=85., io=40.):
    out, baseline = Path(out).resolve(), Path(baseline).resolve()
    side = out.with_name(out.name+'-protocol')
    if out.exists() or side.exists() or out.is_relative_to(f.ROOT):
        raise ValueError('fresh external capture and protocol required')
    with field_context(pilot):
        _, meta = f.build(1,1); source = f.identity()
    estimate = t.forecast(meta,rate,io); limit = 120. if pilot else DEADLINE
    if estimate > limit:
        raise ValueError('diagnostic budget exceeded; defer before launch')
    old, _, _, quality = f.read(baseline)
    if (any(old[k]!=v for k,v in dict(n=1,excited_port=1,kind='filter',control='ordinary',threads=1).items())
            or old['cap_s']!=f.CAP_S or not f.admissible_source(old,quality,True)):
        raise ValueError('audited ordinary n1/port1 baseline required')
    side.mkdir(parents=True)
    sim, _ = f.build(1,1); sim.fdtd.Write2XML(str(side/'baseline.xml'))
    if f.sha(side/'baseline.xml') != old['input_sha256']:
        raise ValueError('baseline physical input changed')
    with field_context(pilot):
        sim, _ = f.build(1,1); sim.fdtd.Write2XML(str(side/'field.xml'))
        if preserved_input(side/'field.xml',pilot) != preserved_input(side/'baseline.xml',pilot):
            raise ValueError('changed input beyond declared probes/pilot window')
        sim.fdtd.SetTimeStep(0.);sim.fdtd.SetNumberOfTimeSteps(f.OPERATOR_STEPS)
        sim.fdtd.Write2XML(str(side/'operator.xml'))
    protocol = dict(baseline=str(baseline), baseline_report_sha256=f.sha(baseline/'report.json'),
        source=source,runtime=f.runtime_identity(),pilot_only=pilot,estimated_seconds=estimate,
        deadline_seconds=limit,input_sha256=f.sha(side/'field.xml'),
        operator_input_sha256=f.sha(side/'operator.xml'),qualified=False)
    f.save(side/'protocol.json',protocol)
    return protocol


def worker(out, protocol):
    out = Path(out).resolve(); original = f.CircuitSimulation.run
    def guarded(sim, path, *args, **kw):
        if f.identity()!=protocol['source'] or f.runtime_identity()!=protocol['runtime']:
            raise ValueError('diagnostic source/runtime changed before propagation')
        check = out/('before-operator.xml' if kw.get('setup_only') else 'before-field.xml')
        sim.fdtd.Write2XML(str(check))
        key = 'operator_input_sha256' if kw.get('setup_only') else 'input_sha256'
        if f.sha(check)!=protocol[key]:
            raise ValueError('diagnostic native input changed before execution')
        return original(sim,path,*args,**kw)
    with field_context(protocol['pilot_only']):
        try:
            f.CircuitSimulation.run = guarded
            if not protocol['pilot_only']:
                return f.acquire(out,1,1)
            out.mkdir(parents=True,exist_ok=False);sim,meta=f.build(1,1)
            sim.fdtd.Write2XML(str(out/'input.xml'))
            meta.update(source_sha256=f.identity(),runtime=f.runtime_identity(),
                input_sha256=f.sha(out/'input.xml'))
            meta['operator_preflight']=f.operator_preflight(out,1,1,'filter','ordinary',1)
            print(f.PROPAGATION_MARKER,flush=True)
            sim.run(str(out/'raw'),threads=1,exact=True,echo=True,dump_statistics=True)
            meta.update(native=f.native_statistics(out/'raw'),run=sim.run_stats,pilot_only=True,qualified=False)
            f.save(out/'report.json',meta)
            return meta
        finally:
            f.CircuitSimulation.run = original


def field_clock(data, meta, magnetic):
    dt = meta['native']['dt_s']; nyquist=int(1/(2*f.FREQUENCIES[-1]*dt))
    stride = nyquist//OVERSAMPLING
    if stride<1 or data.ndim!=2 or data.shape[1]!=4 or not np.isfinite(data).all():
        raise ValueError('finite vector-field samples required')
    expected=(np.arange(len(data))*stride+(.5 if magnetic else 0.))*dt
    if (len(data)!=meta['native']['timesteps']//stride+1
            or not np.allclose(data[:,0],expected,rtol=2e-10,atol=dt*1e-5)):
        raise ValueError('dense field clock differs from native operator')
    return stride


def late_power(data, window_s=15e-6):
    if (data.ndim!=2 or data.shape[1]!=4 or not np.isfinite(data).all()
            or len(data)<8 or np.any(np.diff(data[:,0])<=0) or window_s<=0
            or data[-1,0]-data[0,0]<window_s):
        raise ValueError('complete finite late field window required')
    dt=data[1,0]-data[0,0]
    if not np.allclose(np.diff(data[:,0]),dt,rtol=1e-7,atol=dt*1e-5):
        raise ValueError('uniform field clock required')
    selected=data[data[:,0]>=data[-1,0]-window_s,1:]
    z=np.fft.rfft(selected*np.hanning(len(selected))[:,None],axis=0)
    power=np.sum(abs(z)**2,axis=1);power[1:-1]*=2
    frequency=np.fft.rfftfreq(len(selected),dt);total=float(power.sum())
    if total<=0:
        raise ValueError('unexcited late field probe')
    low=frequency<=f.FREQUENCIES[-1];high=frequency>4*f.FREQUENCIES[-1]
    return dict(window_s=window_s,samples=len(selected),sample_nyquist_hz=float(frequency[-1]),
        peak_hz=float(frequency[power.argmax()]),in_band_fraction=float(power[low].sum()/total),
        above_12mhz_fraction=float(power[high].sum()/total),
        scope='Sampled point-field spectrum, not volume energy or convergence qualification')


def analyse(out):
    out=Path(out).resolve();side=out.with_name(out.name+'-protocol')
    protocol=json.loads((side/'protocol.json').read_text());baseline=Path(protocol['baseline'])
    if protocol['pilot_only']:
        raise ValueError('timing pilot cannot supply late-field evidence')
    if f.sha(baseline/'report.json')!=protocol['baseline_report_sha256']:
        raise ValueError('baseline report changed')
    old,_,_,oldq=f.read(baseline)
    with field_context():
        if f.identity()!=protocol['source'] or f.runtime_identity()!=protocol['runtime']:
            raise ValueError('diagnostic source/runtime changed')
        meta,_,_,quality=f.read(out/'port1')
    if not f.admissible_source(old,oldq,True) or not f.admissible_source(meta,quality,True):
        raise ValueError('original cap-diagnostic admissions failed')
    a,_=f.raw_probes(baseline/'raw',old);b,_=f.raw_probes(out/'port1/raw',meta)
    for name in a:
        np.testing.assert_array_equal(a[name],b[name],err_msg='original probe changed: '+name)
    if meta['source_trace']['sha256']!=old['source_trace']['sha256']:
        raise ValueError('allocated excitation waveform changed')
    points={}
    for name,box in PROBES.items():
        path=out/'port1/raw'/name;data=np.loadtxt(path,comments='%',ndmin=2)
        stride=field_clock(data,meta,box['kind']=='H')
        points[name]=dict(sha256=f.sha(path),stride_steps=stride,
            spectra=[late_power(data,window) for window in (5e-6,10e-6,15e-6)])
    return dict(points=points,original_30_probe_samples_unchanged=True,source_waveform_unchanged=True,
        native_quality=quality,baseline_quality=oldq,native_complete=all(quality.values()),
        one_source_only=True,qualified=False,original_example_reclassified=False)


def acquire(out, baseline, pilot=False, rate=85., io=40.):
    out=Path(out).resolve();protocol=prepare(out,baseline,pilot,rate,io)
    out.mkdir();command=[sys.executable,'-m','tests.test_composite_lc_field_floor',
        '--worker','--out',str(out)]
    start,wall=time.monotonic(),time.time();code=None;failure=None
    with (out/'port1.log').open('w',encoding='utf-8') as log:
        proc=t.popen_group(command,cwd=f.ROOT/'python',stdout=log,stderr=t.subprocess.STDOUT)
        f.save(out/'progress.json',dict(active_launcher_pid=proc.pid,command=command,qualified=False))
        try:code=t.wait_owned(proc,seconds=protocol['deadline_seconds'])
        except BaseException as exc:failure=repr(exc);raise
        finally:
            if proc.poll() is None:
                t.terminate_group(proc.pid,grace=0,job=proc.win_job);proc.wait(timeout=15)
            t.release_group(proc)
            f.save(out/'port1.worker.json',dict(command=command,pid=proc.pid,exit_code=code,failure=failure,
                wall_seconds=time.time()-wall,monotonic_seconds=time.monotonic()-start,
                deadline_seconds=protocol['deadline_seconds']))
            f.save(out/'progress.json',dict(active_launcher_pid=None,exit_code=code,qualified=False))
    if code:
        raise RuntimeError('native field diagnostic failed; retain this epoch')
    meta=json.loads((out/'port1/report.json').read_text());text=(out/'port1.log').read_text()
    meta.update(native_header=f.audit_header(text,meta),native_log_sha256=f.sha(out/'port1.log'))
    f.save(out/'port1/report.json',meta)
    result=dict(pilot_only=True,native=meta['native'],qualified=False) if pilot else analyse(out)
    f.save(out/'field-floor.json',result)
    return result


class FieldFloorTests(unittest.TestCase):
    def test_only_four_probes_change_the_full_native_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            a,b=Path(tmp)/'a',Path(tmp)/'b';sim,old=f.build(1,1);sim.fdtd.Write2XML(str(a))
            with field_context():
                sim,new=f.build(1,1);sim.fdtd.Write2XML(str(b))
                extra=[p for p in sim.csx.GetAllProperties() if p.GetName() in PROBES]
                self.assertEqual(len(extra),4)
                self.assertTrue(all(p.GetOverSampling()==OVERSAMPLING for p in extra))
            self.assertEqual(preserved_input(a),preserved_input(b))
            for key in old:self.assertEqual(old[key],new[key])

    def test_identity_and_builder_restore_after_failure(self):
        before=f.build,f.identity,f.identity()
        with self.assertRaises(ValueError):
            with field_context():f.build(2,1)
        self.assertEqual((f.build,f.identity,f.identity()),before)

    def test_pilot_changes_only_its_declared_window_and_extra_probes(self):
        with tempfile.TemporaryDirectory() as tmp:
            a,b=Path(tmp)/'full',Path(tmp)/'pilot';sim,_=f.build(1,1);sim.fdtd.Write2XML(str(a))
            with field_context(True):
                sim,meta=f.build(1,1);sim.fdtd.Write2XML(str(b))
            self.assertEqual(meta['cap_s'],PILOT_S)
            self.assertTrue(meta['field_floor']['pilot_only'])
            self.assertNotEqual(preserved_input(a),preserved_input(b))
            self.assertEqual(preserved_input(a,True),preserved_input(b,True))

    def test_input_comparison_retains_existing_probe_and_element_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            a,b=Path(tmp)/'a',Path(tmp)/'b';sim,_=f.build(1,1);sim.fdtd.Write2XML(str(a))
            for tag,key in (('LumpedElement','L'),('ProbeBox','Weight')):
                tree=ET.parse(a);node=next(x for x in tree.iter(tag) if key in x.attrib)
                node.set(key,'0.01');tree.write(b)
                self.assertNotEqual(preserved_input(a),preserved_input(b))

    def test_dense_clock_keeps_magnetic_half_step_and_rejects_duplicates(self):
        dt=3.851666403092941e-12;meta={'native':{'dt_s':dt,'timesteps':64}}
        for magnetic in (False,True):
            data=np.ones((5,4));data[:,0]=(np.arange(5)*16+(.5 if magnetic else 0))*dt
            self.assertEqual(field_clock(data,meta,magnetic),16)
            data[-1,0]=data[-2,0]
            with self.assertRaises(ValueError):field_clock(data,meta,magnetic)

    def test_spectral_control_distinguishes_source_band_from_high_frequency(self):
        time=np.arange(20001)*1e-9;data=np.zeros((len(time),4));data[:,0]=time
        data[:,1]=np.cos(2*np.pi*2e6*time)+7*np.cos(2*np.pi*200e6*time)
        result=late_power(data)
        self.assertAlmostEqual(result['above_12mhz_fraction'],.98,places=5)
        self.assertLess(abs(result['peak_hz']/200e6-1),.001)
        data[:,1]=np.cos(2*np.pi*2e6*time)
        self.assertLess(late_power(data)['above_12mhz_fraction'],1e-12)

    def test_unexcited_or_incomplete_late_window_is_not_a_spectrum(self):
        data=np.zeros((20001,4));data[:,0]=np.arange(len(data))*1e-9
        with self.assertRaisesRegex(ValueError,'unexcited'):late_power(data)
        with self.assertRaisesRegex(ValueError,'complete'):late_power(data[:100])

    def test_long_forecast_refuses_before_baseline_read_or_output(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(f,'read') as read:
            out=Path(tmp)/'fresh'
            with self.assertRaisesRegex(ValueError,'budget'):prepare(out,Path(tmp)/'missing',rate=.01)
            read.assert_not_called();self.assertFalse(out.exists())
            self.assertFalse(out.with_name('fresh-protocol').exists())

    def test_pilot_cannot_be_analysed_as_completed_late_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp)/'pilot';side=out.with_name('pilot-protocol');side.mkdir()
            f.save(side/'protocol.json',dict(pilot_only=True,baseline='unused'))
            with self.assertRaisesRegex(ValueError,'timing pilot'):analyse(out)

    def test_changed_protocol_refuses_before_native_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp)/'port1'
            def attempt(folder,*args):
                folder.mkdir();sim,_=f.build(1,1);sim.run(str(folder/'raw'))
            with patch.object(f,'acquire',side_effect=attempt),patch.object(f.CircuitSimulation,'run') as native:
                with self.assertRaisesRegex(ValueError,'source/runtime changed'):
                    worker(out,dict(pilot_only=False,source={},runtime={}))
                native.assert_not_called()


def main():
    p=argparse.ArgumentParser(description=__doc__);g=p.add_mutually_exclusive_group(required=True)
    for name in ('plan','fdtd','analyse','worker'):g.add_argument('--'+name,action='store_true')
    p.add_argument('--out',type=Path,required=True);p.add_argument('--baseline',type=Path)
    p.add_argument('--pilot',action='store_true');p.add_argument('--rate-mcps',type=float,default=85.)
    p.add_argument('--io-s-per-mstep',type=float,default=40.);a=p.parse_args()
    if a.worker:
        side=a.out.with_name(a.out.name+'-protocol');worker(a.out/'port1',json.loads((side/'protocol.json').read_text()));return
    if a.analyse:result=analyse(a.out)
    else:
        if a.baseline is None:p.error('--baseline required')
        action=prepare if a.plan else acquire
        result=action(a.out,a.baseline,a.pilot,a.rate_mcps,a.io_s_per_mstep)
    print(json.dumps(result,indent=2,allow_nan=False))


if __name__=='__main__':
    if any('--'+flag in sys.argv for flag in ('plan','fdtd','analyse','worker')):main()
    else:unittest.main()
