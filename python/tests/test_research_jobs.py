"""Shared research admission/queue/API contracts; all subprocesses are harmless stand-ins."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fairbeam import research
from fairbeam.jobs import JobManager
from fairbeam.procutil import pid_alive
from fairbeam.server import App, make_server

FAKE = str(Path(__file__).with_name('fake_openems.py'))
WRITER = '''import json,sys,time
from pathlib import Path
out=Path(sys.argv[1]);out.mkdir()
time.sleep(.05)
result=json.loads(sys.argv[2]);(out/'result.json').write_text(json.dumps(result))
print('fairbeam: wrote fake-antenna.json',flush=True)
print('fairbeam-research: {"type":"phase","phase":"results_exported"}',flush=True)
'''


def wait_for(pred, timeout=15):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        if pred(): return True
        time.sleep(.02)
    return False


def result(backend='elmer', status='results_validated'):
    value={'research_schema':'fairbeam-research-result-1','backend':backend,'status':status,
           'frequency_hz':[1e9,2e9]}
    if backend=='elmer':
        value['frequency_hz'][0]=1675890788.0743763
        value.update(mode1={'family':'TE101 (z axis)','analytic_frequency_hz':1675890788.0743763,
                            'relative_frequency_error':0.,'complex_field_shape_correlation':1.},
                     s_parameters=None,qualifies_driven_antenna=False)
    else:
        value.update(schema='fairbeam.periodic-result/1',s11_real=[0.,0.],s11_imag=[0.,0.],
                     s21_real=[1.,1.],s21_imag=[0.,0.],
                     qa={'energy_converged':True,'empty_reference_pass':True,'co_polar_power_upper_bound_pass':True})
    return value


class ResearchContracts(unittest.TestCase):
    def test_refuses_unknown_nonfinite_and_unsupported_inputs(self):
        for body in ({'backend':'other'}, {'backend':'elmer','out':'escape'},
                     {'backend':'elmer','settings':{'mesh_size':float('nan')}},
                     {'backend':'elmer','settings':{'mesh_size':True}},
                     {'backend':'elmer','design':{}}, {'backend':'elmer','settings':{'ports':1}}):
            with self.subTest(body=body), self.assertRaises(ValueError): research.prepare(body)

    def test_missing_probe_is_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(research.probe({'backend':'elmer','path':tmp})['available'])
            with self.assertRaises(FileNotFoundError): research.prepare({'backend':'elmer','path':tmp})

    def test_validation_rejects_wrong_schema_nan_trace_and_axis(self):
        for change in ({'research_schema':'wrong'},{'backend':'other'},{'frequency_hz':[2.,1.]},
                       {'frequency_hz':[float('nan')]},{'s11_real':[0.]},{'schema':'other'}):
            value=result('periodic');value.update(change)
            with self.subTest(change=change), self.assertRaises(ValueError): research.validate_result(value,'periodic')
        bad=result('periodic');bad['qa']['energy_converged']=False
        with self.assertRaisesRegex(ValueError,'contradicts'):research.validate_result(bad,'periodic')
        bad=result();bad['mode1']['complex_field_shape_correlation']=.5
        with self.assertRaisesRegex(ValueError,'contradicts'):research.validate_result(bad,'elmer')
        self.assertEqual(research.validate_result(result(),'elmer')['status'],'results_validated')

    def test_execute_checks_snapshot_before_any_solver_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'snapshot.json';p.write_text('{}')
            with self.assertRaisesRegex(ValueError,'snapshot changed'):
                research.execute(p,Path(tmp)/'out','not-the-input-hash')
            self.assertFalse((Path(tmp)/'out').exists())

    def test_pins_include_adjacent_native_library(self):
        with tempfile.TemporaryDirectory() as tmp:
            exe=Path(tmp)/'candidate.exe';exe.write_bytes(b'exe')
            dll=Path(tmp)/'openEMS.dll';dll.write_bytes(b'dll')
            self.assertIn(str(dll.resolve()),research.binary_pins([exe]))


class ResearchFixtures:
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.bin=self.root/'native';self.bin.mkdir()
        self.exe=self.bin/'solver.exe';self.exe.write_bytes(b'fixture executable identity')
        self.dll=self.bin/'openEMS.dll';self.dll.write_bytes(b'fixture native library identity')
        self.calls=[];self.managers=[]

    def tearDown(self):
        for manager in self.managers: manager.shutdown(timeout=5)
        self.tmp.cleanup()

    def spec(self,backend='elmer'):
        return {'schema':'fairbeam-research-input-1','backend':backend,'path':str(self.bin),
                'settings':{'mesh_size':.025},'design':None,'normalized':{'mesh_size':.025},
                'binary_sha256':research.binary_pins([self.exe])}

    def factory(self,job):
        self.calls.append(job.id)
        if job.params.get('hang'):
            return [sys.executable,FAKE,'hang',str(self.root/'projects')]
        if job.kind!='research':
            return [sys.executable,FAKE,'ok',str(self.root/'projects')]
        value=result(job.research['backend'], job.params.get('result_status','results_validated'))
        value['input_sha256']=job.params.get('wrong_hash') or job.research['snapshot_sha256']
        return [sys.executable,'-c',WRITER,str(job.dir/'research'),json.dumps(value)]

    def manager(self,autostart=True):
        m=JobManager(self.root/'jobs',self.root/'projects',command_factory=self.factory,
                     grace_s=.1,autostart=autostart)
        self.managers.append(m);return m

    def submit(self,m,**params):
        return m.submit(model='research:elmer',model_path='',kind='research',research_input=self.spec(),params=params)


class SharedResearchQueue(ResearchFixtures, unittest.TestCase):
    def test_research_and_antenna_jobs_use_one_serial_queue(self):
        m=self.manager();first=m.submit(model='dipole',model_path='not-real',params={'hang':True})
        self.assertTrue(wait_for(lambda:first.status=='running'))
        second=self.submit(m);third=m.submit(model='dipole',model_path='not-real')
        time.sleep(.1)
        self.assertEqual(second.status,'queued');self.assertEqual(third.status,'queued')
        self.assertEqual(self.calls,[first.id])
        m.cancel(first.id)
        self.assertTrue(wait_for(lambda:third.terminal))
        self.assertEqual(first.status,'cancelled');self.assertEqual(second.status,'done');self.assertEqual(third.status,'done')
        self.assertGreaterEqual(second.started,first.finished);self.assertGreaterEqual(third.started,second.finished)
        self.assertIsNone(second.bundle);self.assertIsNotNone(third.bundle)

    def test_snapshot_and_dependency_mutation_fail_before_launch(self):
        for mutation in ('snapshot','library'):
            with self.subTest(mutation=mutation):
                m=self.manager(autostart=False);job=self.submit(m)
                if mutation=='snapshot':(job.dir/'input/research.json').write_text('{}')
                else:self.dll.write_bytes(b'changed library')
                m.worker.start();self.assertTrue(wait_for(lambda:job.terminal))
                self.assertEqual(job.status,'failed');self.assertNotIn(job.id,self.calls)
                m.shutdown(timeout=5);self.managers.remove(m)
                # Use a separate root for the next persisted-history case.
                self.root=self.root/'next';self.root.mkdir();self.bin=self.root/'native';self.bin.mkdir()
                self.exe=self.bin/'solver.exe';self.exe.write_bytes(b'exe');self.dll=self.bin/'openEMS.dll';self.dll.write_bytes(b'dll')

    def test_detached_settings_and_restart_history(self):
        m=self.manager(autostart=False);spec=self.spec()
        job=m.submit(model='research:elmer',model_path='',kind='research',research_input=spec)
        spec['settings']['mesh_size']=.0125
        self.assertEqual(job.research['settings']['mesh_size'],.025)
        m.worker.start();self.assertTrue(wait_for(lambda:job.terminal));m.shutdown(timeout=5)
        restored=self.manager(autostart=False).get(job.id)
        self.assertEqual(restored.status,'done');self.assertEqual(restored.result['backend'],'elmer')
        self.assertIsNone(restored.bundle)

    def test_queued_restart_is_interrupted_without_launch(self):
        m=self.manager(autostart=False);job=self.submit(m)
        recovered=self.manager(autostart=False).get(job.id)
        self.assertEqual(recovered.status,'interrupted');self.assertFalse(self.calls)

    def test_unvalidated_export_and_wrong_identity_are_not_done(self):
        m=self.manager()
        unvalidated=self.submit(m,result_status='results_exported')
        wrong=self.submit(m,wrong_hash='changed')
        self.assertTrue(wait_for(lambda:wrong.terminal))
        self.assertEqual(unvalidated.status,'failed');self.assertEqual(unvalidated.result['status'],'results_exported')
        self.assertEqual(wrong.status,'failed');self.assertIsNone(wrong.result)

    def test_shutdown_interrupts_running_research_and_preserves_history(self):
        m=self.manager();job=self.submit(m,hang=True)
        self.assertTrue(wait_for(lambda:any('grandchild ' in e.get('line','') for e in job.events)))
        m.shutdown(timeout=5)
        self.assertEqual(job.status,'interrupted')
        self.assertIsNone(job.result)
        recovered=self.manager(autostart=False).get(job.id)
        self.assertEqual(recovered.status,'interrupted')
        self.assertEqual(recovered.research['snapshot_sha256'],job.research['snapshot_sha256'])

    def test_cancel_stops_research_worker_and_grandchild_before_next_job(self):
        m=self.manager();job=self.submit(m,hang=True);next_job=self.submit(m)
        self.assertTrue(wait_for(lambda:any('grandchild' in e.get('line','') for e in job.events)))
        line=next(e['line'] for e in job.events if 'grandchild' in e.get('line',''))
        child_pid=int(re.search(r'grandchild (\d+)',line)[1])
        m.cancel(job.id);self.assertTrue(wait_for(lambda:next_job.terminal))
        self.assertEqual(job.status,'cancelled');self.assertEqual(next_job.status,'done')
        self.assertFalse(pid_alive(child_pid));self.assertGreaterEqual(next_job.started,job.finished)


class ResearchHTTP(ResearchFixtures, unittest.TestCase):
    def setUp(self):
        super().setUp();m=self.manager()
        with mock.patch('fairbeam.server._versions',return_value={}),mock.patch('fairbeam.server.detect_engines',return_value=['cpu']):
            self.app=App(models_dir=self.root/'models',projects_dir=self.root/'projects',jobs_dir=self.root/'jobs',manager=m)
        self.server=make_server(self.app,'127.0.0.1',0,quiet=True)
        self.thread=threading.Thread(target=self.server.serve_forever,kwargs={'poll_interval':.05},daemon=True);self.thread.start()

    def tearDown(self):
        self.server.stopping=True;self.server.shutdown();self.server.server_close();self.thread.join(timeout=5)
        self.app.close();super().tearDown()

    def request(self,method,path,body=None):
        c=http.client.HTTPConnection('127.0.0.1',self.server.server_address[1],timeout=15)
        headers={};data=None
        if body is not None:data=json.dumps(body);headers['Content-Type']='application/json'
        c.request(method,path,data,headers);response=c.getresponse();payload=json.loads(response.read());c.close()
        return response.status,payload

    # Inherited queue tests use the same HTTP-owned manager; keep only endpoint-specific methods.
    def test_routes_isolate_history_and_detect_result_tampering(self):
        with mock.patch('fairbeam.research.prepare',return_value=self.spec()):
            code,doc=self.request('POST','/api/research/runs',{'backend':'elmer','settings':{}})
        self.assertEqual(code,201);job=self.app.manager.get(doc['id'])
        self.assertTrue(wait_for(lambda:job.terminal));self.assertEqual(job.status,'done')
        ordinary=self.app.manager.submit(model='dipole',model_path='not-real')
        self.assertTrue(wait_for(lambda:ordinary.terminal))
        code,history=self.request('GET','/api/research/runs');self.assertEqual(code,200)
        self.assertEqual([r['id'] for r in history['runs']],[job.id])
        self.assertEqual(self.request('GET','/api/research/runs/'+ordinary.id)[0],404)
        self.assertEqual(self.request('POST','/api/research/runs/'+ordinary.id+'/cancel',{})[0],404)
        self.assertEqual(self.request('GET','/api/research/runs/'+job.id)[1]['result']['backend'],'elmer')
        output=job.dir/'research/result.json';data=json.loads(output.read_text());data['inspection_note']='changed after completion';output.write_text(json.dumps(data))
        self.assertEqual(self.request('GET','/api/research/runs/'+job.id)[0],409)

    def test_probe_admission_health_and_queued_cancel(self):
        self.assertTrue(self.request('GET','/api/health')[1]['research'])
        self.assertEqual(self.request('POST','/api/research/probe',{'backend':'unknown'})[0],400)
        self.assertFalse(self.request('POST','/api/research/probe',{'backend':'elmer','path':str(self.root/'absent')})[1]['available'])
        self.assertEqual(self.request('POST','/api/research/runs',{'backend':'elmer','settings':{'mesh_size':False}})[0],400)
        hang=self.app.manager.submit(model='dipole',model_path='not-real',params={'hang':True})
        self.assertTrue(wait_for(lambda:hang.status=='running'))
        with mock.patch('fairbeam.research.prepare',return_value=self.spec()):
            _,doc=self.request('POST','/api/research/runs',{'backend':'elmer'})
        code,cancelled=self.request('POST','/api/research/runs/'+doc['id']+'/cancel',{})
        self.assertEqual(code,202);self.assertEqual(cancelled['status'],'cancelled');self.assertNotIn(doc['id'],self.calls)
        self.app.manager.cancel(hang.id)


if __name__=='__main__':unittest.main()
