"""Separately named quasi-static open-end layout variant; no response fitting.

The original ideal circuit remains the target. Only the physical open-stub
lengths are shortened by the existing closed-form extension estimate. Tees,
steps, coupling and dispersion remain physical modeling limitations.

No default discovery starts propagation. From python/:
python -m unittest tests.test_stub_lowpass_open_end -q
python -m tests.test_stub_lowpass_open_end --preflight --out C:/study/stub-open-end-plan-fresh
python -m tests.test_stub_lowpass_open_end --fdtd --pilot-seconds 5e-10 --out C:/study/stub-open-end-pilot-fresh
python -m tests.test_stub_lowpass_open_end --fdtd --rate-mcps 25 --out C:/study/stub-open-end-fields-fresh
"""
import argparse
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
import sys
import json
import tempfile
import unittest
from unittest.mock import Mock,patch

import numpy as np
from fairbeam.analytic import patch_delta_l
from tests import stub_lowpass_fixture as f
from tests import test_stub_lowpass_fixture as t
from tests import test_stub_lowpass_cap_diagnostics as d

MODULE='tests.test_stub_lowpass_open_end'
IDENTITY='tests/test_stub_lowpass_open_end.py'
CONTROL='open-end'


@contextmanager
def open_end_context():
    if CONTROL in f.CONTROLS:raise ValueError('nested open-end contexts are not permitted')
    dims,identity,controls,scope,mesh=f.dimensions,f.identity,f.CONTROLS,f.SCOPE,f.mesh_lines
    launch_t,launch_d=t.popen_group,d.popen_group
    def physical_dimensions():
        result=deepcopy(dims())
        for stub in result['stubs']:
            nominal=stub['length_mm'];extension=patch_delta_l(stub['eps_eff'],f.HEIGHT,stub['width_mm'])
            if not 0<extension<nominal:raise ValueError('positive physical open-stub length required')
            stub.update(nominal_length_mm=nominal,open_end_extension_mm=extension,length_mm=nominal-extension)
        return result
    def numerical_identity():
        return {**identity(),IDENTITY:f.sha(Path(__file__))}
    def common_mesh(n,control='ordinary'):
        # Keep exactly the nominal mesh/time step for the controlled layout
        # comparison. The shortened metal ends are voxelized on that mesh.
        current=f.dimensions
        try:f.dimensions=dims;return mesh(n,control)
        finally:f.dimensions=current
    def route(launch):
        def actual(command,*args,**kwargs):
            command=list(command)
            if command[1:3]!=['-m','tests.test_stub_lowpass_fixture'] or '--worker' not in command:
                raise ValueError('only the declared scientific worker can be routed')
            if command[command.index('--control')+1]!=CONTROL:raise ValueError('explicit open-end control required')
            command[2]=MODULE
            return launch(command,*args,**kwargs)
        return actual
    try:
        f.dimensions=physical_dimensions;f.identity=numerical_identity;f.CONTROLS=controls+(CONTROL,)
        f.mesh_lines=common_mesh
        f.SCOPE=scope.replace('uncompensated quasi-static electrical lengths','declared quasi-static open-end compensation')
        t.popen_group=route(launch_t);d.popen_group=route(launch_d)
        yield
    finally:
        f.dimensions,f.identity,f.CONTROLS,f.SCOPE,f.mesh_lines=dims,identity,controls,scope,mesh
        t.popen_group,d.popen_group=launch_t,launch_d


def prepare(out,rate=20.):
    out=Path(out);out.mkdir(parents=True,exist_ok=False);rows=[]
    with open_end_context():
        for n in f.MESHES:
            for kind in f.KINDS:
                for port in (1,2):
                    sim,_,meta=f.build(n,port,kind,CONTROL);name=f'n{n}_{kind}_p{port}'
                    path=out/(name+'.xml');sim.fdtd.Write2XML(str(path))
                    sim.fdtd.SetTimeStep(0.);sim.fdtd.SetNumberOfTimeSteps(f.OPERATOR_STEPS)
                    op=out/(name+'_operator.xml');sim.fdtd.Write2XML(str(op))
                    seconds=t.forecast(meta,rate)
                    rows.append(dict(name=name,**meta,input_sha256=f.sha(path),operator_input_sha256=f.sha(op),estimated_seconds=seconds,deferred=seconds>1800))
        result=dict(source=f.identity(),runtime=f.runtime_identity(),rows=rows,native_propagations=0,qualified=False,
            point_target_replaced=False,dimensions_fitted=False,nominal_mesh_preserved=True,
            note='A separately named layout hypothesis using a preexisting open-edge approximation. Any apparent improvement still requires all numerical and physical checks.')
    f.save(out/'preflight.json',result);return result


class OpenEndTests(unittest.TestCase):
    def test_original_target_is_preserved_and_lengths_are_formula_derived(self):
        dims=f.dimensions();target=f.reference()
        with open_end_context():
            other=f.dimensions();np.testing.assert_array_equal(f.reference(),target)
            self.assertEqual(other['unit'],dims['unit']);self.assertEqual(other['feed'],dims['feed'])
            for base,actual in zip(dims['stubs'],other['stubs']):
                self.assertEqual(actual['nominal_length_mm'],base['length_mm'])
                expected=patch_delta_l(base['eps_eff'],f.HEIGHT,base['width_mm'])
                self.assertAlmostEqual(actual['length_mm'],base['length_mm']-expected,places=14)
                for key in ('width_mm','eps_eff','impedance_ohm'):self.assertEqual(base[key],actual[key])

    def test_context_restores_all_overrides_after_failure(self):
        original=(f.dimensions,f.identity,f.CONTROLS,f.SCOPE,f.mesh_lines,t.popen_group,d.popen_group)
        with self.assertRaises(RuntimeError):
            with open_end_context():
                self.assertIn(IDENTITY,f.identity());self.assertIn(CONTROL,f.CONTROLS)
                raise RuntimeError('intentional')
        self.assertEqual((f.dimensions,f.identity,f.CONTROLS,f.SCOPE,f.mesh_lines,t.popen_group,d.popen_group),original)

    def test_mesh_clock_and_native_parameters_are_explicit_for_each_variant(self):
        _,_,base=f.build(2,1)
        original_meshes={n:f.build(n,1)[2] for n in f.MESHES}
        with open_end_context():
            for n in f.MESHES:
                _,_,m=f.build(n,1,control=CONTROL)
                self.assertEqual(m['control'],CONTROL);self.assertEqual(m['cap_s'],base['cap_s']);self.assertEqual(m['end_db'],base['end_db'])
                self.assertEqual(m['plane_mm'],base['plane_mm']);self.assertEqual(m['threads'],base['threads'])
                self.assertEqual(m['mesh_mm'],original_meshes[n]['mesh_mm'])
                self.assertEqual(m['declared_dt_s'],original_meshes[n]['declared_dt_s'])
                for values in m['mesh_mm'].values():
                    h=np.diff(values);self.assertLessEqual(np.maximum(h[1:]/h[:-1],h[:-1]/h[1:]).max(),2.+1e-10)
            with self.assertRaises(ValueError):
                with open_end_context():pass

    def test_owned_worker_routing_keeps_every_declared_argument(self):
        command=['python','-m','tests.test_stub_lowpass_fixture','--worker','--mesh','2','--port','2',
                 '--kind','filter','--control',CONTROL,'--out','fresh/port2']
        with patch.object(d,'popen_group',return_value=Mock(pid=123)) as launch:
            with open_end_context():d.popen_group(command,cwd=f.ROOT/'python')
            actual=launch.call_args.args[0]
            self.assertEqual(actual[2],MODULE);self.assertEqual(actual[3:],command[3:])
            self.assertIs(d.popen_group,launch)


def main():
    p=argparse.ArgumentParser(description=__doc__);mode=p.add_mutually_exclusive_group(required=True)
    for flag in ('preflight','fdtd','compare','worker'):mode.add_argument('--'+flag,action='store_true')
    p.add_argument('--out',type=Path,required=True);p.add_argument('--mesh',type=int,choices=f.MESHES,default=2)
    p.add_argument('--kind',choices=f.KINDS,default='filter');p.add_argument('--control',choices=(CONTROL,),default=CONTROL)
    p.add_argument('--port',type=int,choices=(1,2),default=1);p.add_argument('--rate-mcps',type=float,default=20.)
    p.add_argument('--pilot-seconds',type=float);a=p.parse_args()
    if a.preflight:result=prepare(a.out,a.rate_mcps)
    else:
        with open_end_context():
            if a.worker:f.acquire(a.out,a.mesh,a.port,a.kind,CONTROL,a.pilot_seconds);return
            if a.compare:result=d.matrix(a.out)[1]
            elif a.pilot_seconds is not None:result=t.acquire_serial(a.out,a.mesh,a.kind,CONTROL,a.rate_mcps,a.pilot_seconds)
            else:result=d.acquire(a.out,a.mesh,a.kind,CONTROL,a.rate_mcps)
    print(json.dumps(result,indent=2,allow_nan=False))


if __name__=='__main__':
    if any('--'+flag in sys.argv for flag in ('preflight','fdtd','compare','worker')):main()
    else:unittest.main()
