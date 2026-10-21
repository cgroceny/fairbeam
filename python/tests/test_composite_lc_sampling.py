"""Independent observation-stride control for the finite composite LC fixture.

From python/ in the bundled openEMS environment (after the ordinary cohort):
python -m tests.test_composite_lc_sampling --fdtd --baseline C:/study/lc/n1_filter --out C:/study/lc/sampling17
python -m tests.test_composite_lc_sampling --compare --baseline C:/study/lc/n1_filter --out C:/study/lc/sampling17

This research-only context changes output sampling, never the circuit, mesh,
clock, source, energy threshold or time cap. Original failed stopping flags
remain failed. No capped measurement or sampling comparison is qualified.
"""
import argparse
from contextlib import contextmanager
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock,patch
import xml.etree.ElementTree as ET

import numpy as np
from tests import composite_lc_filter_fixture as f
from tests import test_composite_lc_filter_fixture as t

CONTROL_OVERSAMPLING=17


def physics_xml(path):
    root=ET.parse(path).getroot();fdtd=root.find('FDTD')
    sampling=int(fdtd.attrib.pop('OverSampling'))
    return ET.tostring(root),sampling


@contextmanager
def sampling_context():
    """Restore every override even on failure; no shared/product module changes."""
    original=f.OVERSAMPLING;identity=f.identity;launch=t.popen_group
    def source():
        return {**identity(),'tests/test_composite_lc_sampling.py':f.sha(__file__),
            'observation_oversampling':str(CONTROL_OVERSAMPLING)}
    def worker_command(command,**kwargs):
        command=list(command);index=command.index('tests.test_composite_lc_filter_fixture')
        command[index]='tests.test_composite_lc_sampling'
        return launch(command,**kwargs)
    try:
        f.OVERSAMPLING=CONTROL_OVERSAMPLING;f.identity=source;t.popen_group=worker_command
        yield
    finally:f.OVERSAMPLING=original;f.identity=identity;t.popen_group=launch


def prepare(out,baseline):
    out,baseline=Path(out).resolve(),Path(baseline).resolve();side=out.with_name(out.name+'-protocol')
    if out.exists() or side.exists():raise ValueError('fresh cohort and protocol directories required')
    _,old_result=f.matrix(baseline,True)
    old=json.loads((baseline/'port1/report.json').read_text())
    if old['n']!=1 or old['kind']!='filter' or old['control']!='ordinary' or old['oversampling']!=16:
        raise ValueError('ordinary coarse sixteen-times-sampled baseline required')
    side.mkdir(parents=True);rows=[]
    for port in (1,2):
        sim,meta=f.build(1,port);base=side/f'baseline-p{port}.xml';sim.fdtd.Write2XML(str(base))
        if base.read_bytes()!=(baseline/f'port{port}/input.xml').read_bytes():raise ValueError('baseline input is not reproduced exactly')
        with sampling_context():
            sim,meta=f.build(1,port);control=side/f'control-p{port}.xml';sim.fdtd.Write2XML(str(control))
            if physics_xml(base)[0]!=physics_xml(control)[0]:raise ValueError('sampling control changed the physical input')
            sim.fdtd.SetTimeStep(0.);sim.fdtd.SetNumberOfTimeSteps(f.OPERATOR_STEPS)
            operator=side/f'operator-p{port}.xml';sim.fdtd.Write2XML(str(operator))
            rows.append(dict(port=port,input_sha256=f.sha(control),operator_input_sha256=f.sha(operator),
                forecast_seconds=t.forecast(meta,85.,40.)))
    with sampling_context():source=f.identity()
    record=dict(source=source,runtime=f.runtime_identity(),rows=rows,baseline=str(baseline),
        baseline_source_sha256=old['source_sha256'],baseline_comparison_sha256=f.sha(baseline/'cap-diagnostic-comparison.json'),
        old_oversampling=16,new_oversampling=CONTROL_OVERSAMPLING,only_xml_difference='FDTD.OverSampling',
        hypothesis='The narrow 0.815 MHz V/I anomaly may be temporal aliasing of a non-circuit mode. A physical low-frequency feature should not move when only the output stride changes.',
        limits=f.LIMITS,qualified=False,baseline_target_passes=old_result['target_passes'])
    f.save(side/'protocol.json',record);return record


def acquire(out,baseline):
    prepare(out,baseline)
    with sampling_context():return t.acquire_serial(out,1,'filter','ordinary',1,85.,40.,True)


def worker(out,port):
    out=Path(out).resolve();side=out.parent.with_name(out.parent.name+'-protocol')
    protocol=json.loads((side/'protocol.json').read_text());row=next(r for r in protocol['rows'] if r['port']==port)
    original=f.CircuitSimulation.run
    def guarded(self,sim_path,*args,**kwargs):
        operator=bool(kwargs.get('setup_only'));folder=Path(sim_path).parent
        path=folder/('operator-before-native.xml' if operator else 'scientific-before-native.xml')
        if f.identity()!=protocol['source'] or f.runtime_identity()!=protocol['runtime']:raise ValueError('sampling control source/runtime changed')
        self.fdtd.Write2XML(str(path))
        if f.sha(path)!=row['operator_input_sha256' if operator else 'input_sha256']:raise ValueError('sampling input changed before native execution')
        return original(self,sim_path,*args,**kwargs)
    with sampling_context():
        try:f.CircuitSimulation.run=guarded;f.acquire(out,1,port)
        finally:f.CircuitSimulation.run=original


def compare(out,baseline):
    out,baseline=Path(out),Path(baseline)
    nominal,old=f.matrix(baseline,True)
    with sampling_context():actual,new=f.matrix(out,True)
    mask=abs(f.reference()[:,1,0])>=.01;difference=f.response_difference(actual,nominal,mask)
    row=dict(old=old,new=new,**difference,qualified=False,
        sampling_stable=difference['s_abs']<=f.LIMITS['s_control_abs'] and difference['phase_deg']<=f.LIMITS['phase_control_deg'],
        note='A failed sampling control is a measurement limitation, not mesh convergence. All original native energy flags are retained.')
    path=out/'sampling-comparison.json'
    if path.exists() and json.loads(path.read_text())!=row:raise ValueError('changed stored sampling comparison')
    if not path.exists():f.save(path,row)
    return row


class CompositeSamplingTests(unittest.TestCase):
    def test_context_restores_after_an_exception(self):
        identity=f.identity;launch=t.popen_group
        with self.assertRaises(RuntimeError):
            with sampling_context():
                self.assertEqual(f.OVERSAMPLING,17);self.assertIn('tests/test_composite_lc_sampling.py',f.identity())
                raise RuntimeError('intentional')
        self.assertEqual(f.OVERSAMPLING,16);self.assertIs(f.identity,identity);self.assertIs(t.popen_group,launch)

    def test_only_xml_sampling_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            base,control=Path(tmp)/'base',Path(tmp)/'control'
            sim,meta=f.build(1,1);sim.fdtd.Write2XML(str(base))
            with sampling_context():sim,other=f.build(1,1);sim.fdtd.Write2XML(str(control))
            self.assertEqual(physics_xml(base)[0],physics_xml(control)[0]);self.assertEqual(physics_xml(control)[1],17)
            self.assertEqual(meta['elements'],other['elements']);self.assertEqual(meta['mesh_mm'],other['mesh_mm'])

    def test_probe_clock_rejects_an_undeclared_observation_stride(self):
        with sampling_context():
            _,meta=f.build(1,1);dt=meta['declared_dt_s'];stride=int(1/(2*f.FREQUENCIES[-1]*dt))//17
            meta['native']=dict(dt_s=dt,numerical_time_s=3*stride*dt)
            trace=np.column_stack((np.arange(4)*stride*dt,np.zeros(4)))
            f.trace_clock(trace,meta)
        with self.assertRaises(ValueError):f.trace_clock(trace,meta)

    def test_serial_worker_keeps_the_owned_protocol_and_routes_the_control(self):
        command=['python','-m','tests.test_composite_lc_filter_fixture','--worker','--mesh','1','--port','2','--kind','filter','--control','ordinary','--threads','1','--out','fresh/port2']
        with patch.object(t,'popen_group',return_value=Mock(pid=123)) as launch:
            with sampling_context():t.popen_group(command,cwd=f.ROOT/'python')
            actual=launch.call_args.args[0]
            self.assertEqual(actual[2],'tests.test_composite_lc_sampling');self.assertEqual(actual[3:],command[3:])
            self.assertIs(t.popen_group,launch)


def main():
    p=argparse.ArgumentParser(description=__doc__);mode=p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--fdtd',action='store_true');mode.add_argument('--compare',action='store_true');mode.add_argument('--worker',action='store_true')
    p.add_argument('--out',type=Path,required=True);p.add_argument('--baseline',type=Path);p.add_argument('--port',type=int,choices=(1,2),default=1)
    # Accepted solely for the existing serial worker protocol; none is silently ignored.
    p.add_argument('--mesh',type=int,choices=(1,),default=1);p.add_argument('--kind',choices=('filter',),default='filter')
    p.add_argument('--control',choices=('ordinary',),default='ordinary');p.add_argument('--threads',type=int,choices=(1,),default=1)
    a=p.parse_args()
    if a.worker:worker(a.out,a.port);return
    if a.baseline is None:p.error('--baseline is required')
    result=acquire(a.out,a.baseline) if a.fdtd else compare(a.out,a.baseline)
    print(json.dumps(result,indent=2,allow_nan=False))


if __name__=='__main__':
    if any('--'+s in sys.argv for s in ('fdtd','compare','worker')):main()
    else:unittest.main()
