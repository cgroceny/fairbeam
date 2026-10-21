"""Opt-in MUR-boundary diagnostic of the finite LC realization.

python -m unittest tests.test_composite_lc_boundary -q
python -m tests.test_composite_lc_boundary --fdtd --baseline C:/study/lc/n1_filter --out C:/study/lc/mur-boundary
python -m tests.test_composite_lc_boundary --compare --baseline C:/study/lc/n1_filter --out C:/study/lc/mur-boundary

This changes a physical boundary assumption, not the mesh resolution. The
small MUR enclosure is not an open-space boundary-convergence certificate.
The point circuit remains the original target; no part value is fitted.
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


def without_boundary(path):
    root=ET.parse(path).getroot();fdtd=root.find('FDTD');boundary=fdtd.find('BoundaryCond')
    if boundary is None:raise ValueError('explicit native boundaries required')
    faces=dict(boundary.attrib);fdtd.remove(boundary)
    return ET.tostring(root),faces


@contextmanager
def boundary_context():
    build,identity,launch=f.build,f.identity,t.popen_group
    def model(*args,**kwargs):
        sim,meta=build(*args,**kwargs)
        if meta['n']!=1 or meta['kind']!='filter' or meta['control']!='ordinary':raise ValueError('coarse ordinary filter boundary control required')
        sim.boundaries=['MUR']*6;sim.fdtd.SetBoundaryCond(sim.boundaries)
        meta.update(outer_boundaries=['MUR']*6,scope='Own finite LC with PEC ground and six MUR outer faces; independent boundary diagnostic, not an open-space certificate.')
        return sim,meta
    def source():return {**identity(),'tests/test_composite_lc_boundary.py':f.sha(__file__),'outer_boundary_control':'MUR'}
    def route(command,**kwargs):
        command=list(command);command[command.index('tests.test_composite_lc_filter_fixture')]='tests.test_composite_lc_boundary'
        return launch(command,**kwargs)
    try:f.build=model;f.identity=source;t.popen_group=route;yield
    finally:f.build=build;f.identity=identity;t.popen_group=launch


def prepare(out,baseline):
    out,baseline=Path(out).resolve(),Path(baseline).resolve();side=out.with_name(out.name+'-protocol')
    if out.exists() or side.exists():raise ValueError('fresh boundary cohort and protocol required')
    f.matrix(baseline,True);side.mkdir(parents=True);rows=[]
    for port in (1,2):
        sim,_=f.build(1,port);base=side/f'baseline-p{port}.xml';sim.fdtd.Write2XML(str(base))
        if base.read_bytes()!=(baseline/f'port{port}/input.xml').read_bytes():raise ValueError('baseline input not reproduced exactly')
        with boundary_context():
            sim,meta=f.build(1,port);path=side/f'control-p{port}.xml';sim.fdtd.Write2XML(str(path))
            if without_boundary(base)[0]!=without_boundary(path)[0]:raise ValueError('boundary diagnostic changed other native input')
            sim.fdtd.SetTimeStep(0.);sim.fdtd.SetNumberOfTimeSteps(f.OPERATOR_STEPS)
            op=side/f'operator-p{port}.xml';sim.fdtd.Write2XML(str(op))
            rows.append(dict(port=port,input_sha256=f.sha(path),operator_input_sha256=f.sha(op),forecast_seconds=t.forecast(meta,85.,40.)))
    with boundary_context():source=f.identity()
    f.save(side/'protocol.json',dict(source=source,runtime=f.runtime_identity(),rows=rows,baseline=str(baseline),
        baseline_comparison_sha256=f.sha(baseline/'cap-diagnostic-comparison.json'),only_input_change='Six outer BoundaryCond faces PEC to MUR; internal PEC ground unchanged',qualified=False))


def worker(out,port):
    out=Path(out).resolve();side=out.parent.with_name(out.parent.name+'-protocol');protocol=json.loads((side/'protocol.json').read_text())
    row=next(x for x in protocol['rows'] if x['port']==port);original=f.CircuitSimulation.run
    def guarded(self,sim_path,*args,**kwargs):
        operator=bool(kwargs.get('setup_only'));folder=Path(sim_path).parent
        path=folder/('operator-before-native.xml' if operator else 'scientific-before-native.xml')
        if f.identity()!=protocol['source'] or f.runtime_identity()!=protocol['runtime']:raise ValueError('boundary source/runtime changed')
        self.fdtd.Write2XML(str(path))
        if f.sha(path)!=row['operator_input_sha256' if operator else 'input_sha256']:raise ValueError('changed boundary input before native execution')
        return original(self,sim_path,*args,**kwargs)
    with boundary_context():
        try:f.CircuitSimulation.run=guarded;f.acquire(out,1,port)
        finally:f.CircuitSimulation.run=original


def compare(out,baseline):
    nominal,old=f.matrix(baseline,True)
    with boundary_context():actual,new=f.matrix(out,True)
    difference=f.response_difference(actual,nominal,abs(f.reference()[:,1,0])>=.01)
    result=dict(variant='MUR outer boundary',physical_model_changed=True,old=old,new=new,**difference,qualified=False,
        note='Boundary change is a model-assumption diagnostic, not mesh refinement or a replacement point target.')
    path=Path(out)/'boundary-comparison.json'
    if path.exists() and json.loads(path.read_text())!=result:raise ValueError('changed stored boundary comparison')
    if not path.exists():f.save(path,result)
    return result


class CompositeBoundaryTests(unittest.TestCase):
    def test_only_outer_faces_change_and_ground_and_values_are_fixed(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths=[Path(tmp)/name for name in ('base','mur')]
            sim,base=f.build(1,1);sim.fdtd.Write2XML(str(paths[0]))
            with boundary_context():sim,mur=f.build(1,1);sim.fdtd.Write2XML(str(paths[1]))
            self.assertEqual(without_boundary(paths[0])[0],without_boundary(paths[1])[0])
            self.assertEqual(set(without_boundary(paths[1])[1].values()),{'MUR'})
            self.assertEqual(base['elements'],mur['elements']);self.assertEqual(base['mesh_mm'],mur['mesh_mm'])
            self.assertEqual(base['declared_dt_s'],mur['declared_dt_s']);self.assertIn('ground',mur['solids'])

    def test_context_restores_every_override_even_on_failure(self):
        build,identity,launch=f.build,f.identity,t.popen_group
        with self.assertRaises(ValueError):
            with boundary_context():f.build(2,1)
        self.assertIs(f.build,build);self.assertIs(f.identity,identity);self.assertIs(t.popen_group,launch)

    def test_worker_keeps_existing_serial_budget_and_source_arguments(self):
        command=['python','-m','tests.test_composite_lc_filter_fixture','--worker','--port','2','--threads','1','--out','fresh/port2']
        with patch.object(t,'popen_group',return_value=Mock(pid=123)) as launch:
            with boundary_context():t.popen_group(command,cwd=f.ROOT/'python')
            actual=launch.call_args.args[0];self.assertEqual(actual[2],'tests.test_composite_lc_boundary');self.assertEqual(actual[3:],command[3:])


def main():
    p=argparse.ArgumentParser(description=__doc__);mode=p.add_mutually_exclusive_group(required=True)
    for name in ('fdtd','compare','worker'):mode.add_argument('--'+name,action='store_true')
    p.add_argument('--out',type=Path,required=True);p.add_argument('--baseline',type=Path);p.add_argument('--port',type=int,choices=(1,2),default=1)
    p.add_argument('--mesh',type=int,choices=(1,),default=1);p.add_argument('--kind',choices=('filter',),default='filter')
    p.add_argument('--control',choices=('ordinary',),default='ordinary');p.add_argument('--threads',type=int,choices=(1,),default=1)
    a=p.parse_args()
    if a.worker:worker(a.out,a.port);return
    if a.baseline is None:p.error('--baseline required')
    if a.fdtd:
        prepare(a.out,a.baseline)
        with boundary_context():result=t.acquire_serial(a.out,1,'filter','ordinary',1,85.,40.,True)
    else:result=compare(a.out,a.baseline)
    print(json.dumps(result,indent=2,allow_nan=False))


if __name__=='__main__':
    if any('--'+name in sys.argv for name in ('fdtd','compare','worker')):main()
    else:unittest.main()
