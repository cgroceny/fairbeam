"""Opt-in known-cap diagnostics; numerical acquisition stays in the base fixture.

No failed flag is repaired. Capped matrices are separate, never qualified.
The base fixture's source identity is unchanged: this file is an analysis and
serial-launch driver, not a change to the scientific worker or native inputs.

From python/ in the openEMS environment:
python -m unittest tests.test_stub_lowpass_cap_diagnostics -q
python -m tests.test_stub_lowpass_cap_diagnostics --fdtd --rate-mcps 25 --out C:/study/stub-cap-fresh
python -m tests.test_stub_lowpass_cap_diagnostics --compare --out C:/study/stub-cap-fresh
Use --resume-rejected only for a closed, rejected base-fixture cohort with an
unchanged pre-field plan; earlier source records are retained byte-for-byte.
"""
import argparse
from copy import deepcopy
from datetime import datetime,timezone
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import numpy as np
from fairbeam.procutil import popen_group,release_group,terminate_group
from tests.test_coax_resonator import wait_owned
from tests import stub_lowpass_fixture as f
from tests import test_stub_lowpass_fixture as t


def admissible(meta,checks):
    failed=[key for key,value in checks.items() if not value]
    if not failed:return True
    return (failed==['stopping'] and meta['native']['timesteps']==meta['max_timesteps']
            and meta['native']['numerical_time_s']>=meta['cap_s'])


def read(out):
    """Strict raw replay with an explicitly retained native stopping deviation."""
    out=Path(out);meta=json.loads((out/'report.json').read_text())
    _,_,expected=f.build(meta['n'],meta['excited_port'],meta['kind'],meta['control'],meta['cap_s'])
    if any(meta.get(k)!=v for k,v in expected.items()) or meta['source']!=f.identity() or meta['runtime']!=f.runtime_identity():
        raise ValueError('numerical source/runtime/model identity differs')
    checks=f.quality(meta)
    if not admissible(meta,checks):raise ValueError(f'non-cap failure remains rejected: {checks}')
    pairs=[('input.xml',meta['input_sha256']),('operator-input.xml',meta['operator_preflight']['input_sha256']),
           ('operator.json',meta['operator_sha256']),('data.npz',meta['data_sha256'])]
    if any(f.sha(out/name)!=value for name,value in pairs):raise ValueError('stored input/operator/data changed')
    if json.loads((out/'operator.json').read_text())!=meta['operator_preflight']:
        raise ValueError('operator admission differs from its original record')
    log=out.parent/f'port{meta["excited_port"]}.log'
    if f.sha(log)!=meta['native_log_sha256'] or f.audit_header(log.read_text(),meta)!=meta['native_header']:
        raise ValueError('native log/header changed')
    stats=np.loadtxt(out/'raw/openEMS_stats.txt',comments='%')
    actual=dict(cells=int(stats[0]),dt_s=float(stats[1]),timesteps=int(stats[2]),
                numerical_time_s=float(stats[3]),iteration_wall_s=float(stats[4]))
    if actual!=meta['native']:raise ValueError('native statistics changed')
    plan=json.loads((out.parent/'plan.json').read_text());row=next(r for r in plan['ports'] if r['excited_port']==meta['excited_port'])
    if plan['source']!=f.identity() or plan['runtime']!=f.runtime_identity():raise ValueError('frozen plan identity changed')
    if row['input_sha256']!=meta['input_sha256'] or row['operator_input_sha256']!=meta['operator_preflight']['input_sha256']:
        raise ValueError('native input differs from the pre-field plan')
    receipt=json.loads((out.parent/f'port{meta["excited_port"]}.worker.json').read_text())
    if receipt['exit_code']!=0 or receipt['failure'] is not None or receipt['deadline_seconds']!=1800. or max(receipt['wall_seconds'],receipt['monotonic_seconds'])>1800.:
        raise ValueError('owned worker did not complete inside its deadline')
    with np.load(out/'data.npz') as stored:data=dict(stored)
    if not np.array_equal(data.get('frequency_hz'),f.FREQUENCIES):raise ValueError('frequency grid changed')
    vn,cn=f.probe_names();spectra=[];tails=[]
    for name in vn+cn:
        path=out/'raw'/name
        if f.sha(path)!=meta['raw_sha256'][name]:raise ValueError('raw trace changed')
        trace=np.loadtxt(path,comments='%',ndmin=2);f.trace_clock(trace,meta,name in cn)
        clock,value=trace[:,0],trace[:,1]
        spectra.append(np.array([2*(clock[1]-clock[0])*np.sum(value*np.exp(-2j*np.pi*freq*clock)) for freq in f.FREQUENCIES]))
        mask=clock>=actual['numerical_time_s']-.5e-9
        tails.append(float(10*np.log10(max(np.mean(value[mask]**2),np.finfo(float).tiny)/max(np.max(value**2),np.finfo(float).tiny))))
        if name in cn:
            header='\n'.join(path.read_text().splitlines()[:3])
            indices=[list(map(int,r)) for r in re.findall(r'-> \[(\d+),(\d+),(\d+)\]',header)]
            if indices!=meta['expected_current_indices'][name]:raise ValueError('current contour indices changed')
    np.testing.assert_allclose(np.asarray(spectra[:len(vn)]).reshape(2,3,-1),data['v'],rtol=3e-13,atol=1e-23)
    np.testing.assert_allclose(np.asarray(spectra[len(vn):]).reshape(2,2,2,-1),data['i'],rtol=3e-13,atol=1e-23)
    if max(tails)!=meta['terminal_tail_db'] or f.source_info(out/'raw/et',meta)!=meta['source_trace']:
        raise ValueError('source waveform or independent terminal tail changed')
    return meta,data,checks


def matrix(root):
    root=Path(root);records=[read(root/f'port{p}') for p in (1,2)]
    metas=[m for m,_,_ in records];data=[d for _,d,_ in records];checks=[q for _,_,q in records]
    if any(m['excited_port']!=p or any(m[k]!=metas[0][k] for k in ('n','kind','control','cap_s','mesh_mm','plane_mm')) for p,m in enumerate(metas,1)):
        raise ValueError('same numerical model and distinct source columns required')
    actual,diag=f.extract(np.array([d['v'] for d in data]),np.array([d['i'] for d in data]))
    target=f.reference(kind=metas[0]['kind'],plane_mm=metas[0]['plane_mm']);difference=f.difference(actual,target)
    result=dict(n=metas[0]['n'],kind=metas[0]['kind'],control=metas[0]['control'],**difference,
        native_quality=checks,native_complete=all(all(q.values()) for q in checks),qualified=False,
        numerical_source=f.identity(),analysis_source_sha256=f.sha(Path(__file__)),
        contour_s_abs=diag['contour_s_abs'],recurrence_rel=diag['recurrence_rel'],
        reciprocity_abs=float(abs(actual-actual.transpose(0,2,1)).max()),
        singular_power_max=float((np.linalg.svd(actual,compute_uv=False)[:,0]**2).max()),
        application_errors=f.application_errors(actual,target) if metas[0]['kind']=='filter' else None,
        note='Explicit complete-window diagnostic only. Native stopping deviations remain false, and no mesh/time/dynamic-range validation is inferred.')
    values=dict(frequency_hz=f.FREQUENCIES,s=actual,reference=target,**diag)
    record=root/'cap-diagnostic-comparison.json';arrays=root/'cap-diagnostic-matrix.npz'
    if record.exists() or arrays.exists():
        if not record.exists() or not arrays.exists() or json.loads(record.read_text())!=result:raise ValueError('changed stored diagnostic comparison')
        with np.load(arrays) as stored:
            if set(stored)!=set(values):raise ValueError('changed diagnostic arrays')
            for key,value in values.items():np.testing.assert_array_equal(stored[key],value)
    else:np.savez_compressed(arrays,**values);f.save(record,result)
    return actual,result


def acquire(out,n=2,kind='filter',control='ordinary',rate=20.,resume_rejected=False):
    """Keep existing rejected records; continue only the same frozen source plan."""
    out=Path(out).resolve();_,_,meta=f.build(n,1,kind,control);estimate=t.forecast(meta,rate)
    if estimate>1800:raise ValueError('forecast exceeds 30 minutes; defer this cohort')
    if out.exists():
        if not resume_rejected:raise ValueError('fresh output or explicit rejected-cohort continuation required')
        old=json.loads((out/'progress.json').read_text())
        if old['status']!='rejected' or old.get('active_launcher_pid') is not None:raise ValueError('base worker is not closed/rejected')
    else:
        if resume_rejected:raise ValueError('no rejected cohort to continue')
        out.mkdir(parents=True,exist_ok=False);planned=[]
        for port in (1,2):
            sim,_,m=f.build(n,port,kind,control);path=out/f'planned-p{port}.xml';sim.fdtd.Write2XML(str(path))
            sim.fdtd.SetTimeStep(0.);sim.fdtd.SetNumberOfTimeSteps(f.OPERATOR_STEPS)
            op=out/f'planned-p{port}-operator.xml';sim.fdtd.Write2XML(str(op))
            planned.append(dict(**m,input_sha256=f.sha(path),operator_input_sha256=f.sha(op)))
        f.save(out/'plan.json',dict(source=f.identity(),runtime=f.runtime_identity(),ports=planned))
    progress=out/'cap-diagnostic-progress.json'
    if progress.exists():raise ValueError('diagnostic execution already exists; preserve it')
    plan=json.loads((out/'plan.json').read_text())
    if plan['source']!=f.identity() or plan['runtime']!=f.runtime_identity():raise ValueError('pre-field plan changed')
    original={str(p.relative_to(out)):f.sha(p) for p in out.rglob('*') if p.is_file()}
    state=dict(started_utc=datetime.now(timezone.utc).isoformat(),status='prepared',native_complete=False,qualified=False,
        numerical_source=f.identity(),analysis_source_sha256=f.sha(Path(__file__)),rate_mcps=rate,
        estimated_seconds_per_source=estimate,retained_original_record_hashes=original,
        analysis_driver_head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=f.ROOT,text=True).strip(),active_launcher_pid=None)
    f.save(progress,state)
    try:
        for port in (1,2):
            folder=out/f'port{port}'
            if folder.exists():read(folder);continue
            if (f.identity()!=state['numerical_source'] or plan['runtime']!=f.runtime_identity()
                    or f.sha(Path(__file__))!=state['analysis_source_sha256']):raise ValueError('numerical source/runtime/driver changed')
            row=next(r for r in plan['ports'] if r['excited_port']==port)
            if any(row.get(k)!=v for k,v in f.build(n,port,kind,control)[2].items()):raise ValueError('continuation model differs from the original plan')
            command=[sys.executable,'-m','tests.test_stub_lowpass_fixture','--worker','--mesh',str(n),'--port',str(port),
                     '--kind',kind,'--control',control,'--out',str(folder)]
            start,wall=time.monotonic(),time.time();code=None;failure=None
            with (out/f'port{port}.log').open('x',encoding='utf-8') as log:
                proc=popen_group(command,cwd=f.ROOT/'python',stdout=log,stderr=subprocess.STDOUT)
                state.update(status='running',active_port=port,active_launcher_pid=proc.pid);f.save(progress,state)
                try:code=wait_owned(proc,seconds=1800.)
                except BaseException as error:failure=repr(error);raise
                finally:
                    if proc.poll() is None:terminate_group(proc.pid,grace=0,job=proc.win_job);proc.wait(timeout=15)
                    release_group(proc)
                    f.save(out/f'port{port}.worker.json',dict(command=command,pid=proc.pid,exit_code=code,failure=failure,
                        wall_seconds=time.time()-wall,monotonic_seconds=time.monotonic()-start,deadline_seconds=1800.,estimated_seconds=estimate,
                        analysis_driver_head=state['analysis_driver_head']))
            if code:raise RuntimeError('diagnostic worker failed; partial evidence retained')
            report=json.loads((folder/'report.json').read_text())
            report.update(native_header=f.audit_header((out/f'port{port}.log').read_text(),report),native_log_sha256=f.sha(out/f'port{port}.log'))
            f.save(folder/'report.json',report);read(folder)
        if f.sha(Path(__file__))!=state['analysis_source_sha256']:raise ValueError('analysis driver changed during acquisition')
        _,result=matrix(out);state.update(status='complete_with_known_deviation' if not result['native_complete'] else 'complete',result=result)
    except BaseException as error:state.update(status='rejected',reason=repr(error));raise
    finally:
        unchanged=all(f.sha(out/name)==value for name,value in original.items())
        state.update(active_port=None,active_launcher_pid=None,retained_original_records_unchanged=unchanged)
        f.save(progress,state)
        if not unchanged:raise ValueError('an earlier source record was modified')
    return result


class KnownCapTests(unittest.TestCase):
    def test_only_full_cap_with_a_sole_stopping_failure_is_admitted(self):
        meta=dict(native=dict(timesteps=10,numerical_time_s=1.),max_timesteps=10,cap_s=1.)
        good={key:True for key in ('source','clock','time','geometry','operator','probes','header','engine','tail','stopping')}
        q=dict(good,stopping=False);self.assertTrue(admissible(meta,q));self.assertFalse(q['stopping'])
        for key in good:
            if key=='stopping':continue
            self.assertFalse(admissible(meta,dict(q,**{key:False})))
        bad=deepcopy(meta);bad['native']['timesteps']=9;self.assertFalse(admissible(bad,q))

    def test_diagnostic_matrix_cannot_promote_a_failed_native_flag(self):
        target=f.reference();a=np.broadcast_to(np.eye(2),(len(f.FREQUENCIES),2,2));b=target@a
        v=(np.sqrt(f.Z0)*(a+b)).transpose(2,1,0)
        i=((a-b)/np.sqrt(f.Z0)).transpose(2,1,0);theta=.03
        vv=np.stack((v*np.exp(1j*theta),v,v*np.exp(-1j*theta)),axis=2)
        ii=np.broadcast_to(i[:,:,None,None,:]*np.cos(theta/2),(2,2,2,2,len(f.FREQUENCIES)))
        def source(path):
            port=int(path.name[-1]);meta=dict(n=2,kind='filter',control='ordinary',cap_s=6e-9,plane_mm=4.,mesh_mm={},excited_port=port)
            return meta,dict(v=vv[port-1],i=ii[port-1]),dict(stopping=False,source=True,tail=True)
        with tempfile.TemporaryDirectory() as tmp,patch(__name__+'.read',side_effect=source):
            root=Path(tmp);_,result=matrix(root)
            self.assertFalse(result['native_complete']);self.assertFalse(result['qualified'])
            self.assertFalse(result['native_quality'][0]['stopping'])
            self.assertTrue((root/'cap-diagnostic-matrix.npz').exists());self.assertFalse((root/'matrix.npz').exists())
            matrix(root)
            changed=json.loads((root/'cap-diagnostic-comparison.json').read_text());changed['qualified']=True
            f.save(root/'cap-diagnostic-comparison.json',changed)
            with self.assertRaises(ValueError):matrix(root)

    def test_long_diagnostic_refused_before_output_or_process(self):
        with tempfile.TemporaryDirectory() as tmp,patch(__name__+'.popen_group') as launch:
            out=Path(tmp)/'absent'
            with self.assertRaises(ValueError):acquire(out,rate=1.)
            self.assertFalse(out.exists());launch.assert_not_called()

    def test_resume_is_explicit_and_cannot_attach_to_a_live_base_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp)
            with self.assertRaises(ValueError):acquire(out,rate=1000.)
            f.save(out/'progress.json',dict(status='running',active_launcher_pid=123))
            with self.assertRaises(ValueError):acquire(out,rate=1000.,resume_rejected=True)


def main():
    p=argparse.ArgumentParser(description=__doc__);mode=p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--fdtd',action='store_true');mode.add_argument('--compare',action='store_true')
    p.add_argument('--out',type=Path,required=True);p.add_argument('--mesh',type=int,choices=f.MESHES,default=2)
    p.add_argument('--kind',choices=f.KINDS,default='filter');p.add_argument('--control',choices=f.CONTROLS,default='ordinary')
    p.add_argument('--rate-mcps',type=float,default=20.);p.add_argument('--resume-rejected',action='store_true')
    a=p.parse_args()
    result=acquire(a.out,a.mesh,a.kind,a.control,a.rate_mcps,a.resume_rejected) if a.fdtd else matrix(a.out)[1]
    print(json.dumps(result,indent=2,allow_nan=False))


if __name__=='__main__':
    if '--fdtd' in sys.argv or '--compare' in sys.argv:main()
    else:unittest.main()
