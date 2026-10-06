"""OS-held server ownership; helpers never run jobs/openEMS."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from fairbeam.jobs_owner import JobsOwner, WorkspaceInUse
from fairbeam import server

MODULE = Path(__file__).parents[1] / "fairbeam/jobs_owner.py"
LOAD = "import importlib.util;spec=importlib.util.spec_from_file_location('owner',sys.argv[1]);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);"
FLAGS = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}

class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "jobs"

    def helper(self, code, *, stdin=None, close_fds=True):
        return subprocess.Popen([getattr(sys, "_base_executable", sys.executable), "-u", "-c", "import sys;" + LOAD + code, str(MODULE), str(self.root)], stdin=stdin, close_fds=close_fds, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **FLAGS)

    def test_live_owner_refuses_canonical_alias_without_touching_jobs(self):
        self.root.mkdir(); record=self.root/'job.json';record.write_bytes(b'active evidence')
        with JobsOwner(self.root):
            with mock.patch.object(server, "App") as app:
                with self.assertRaisesRegex(WorkspaceInUse,"workspace_in_use"):
                    server.serve(port=0, models_dir=self.root, projects_dir=self.root, jobs_dir=self.root/'..'/'jobs')
                app.assert_not_called()
            self.assertEqual(record.read_bytes(),b'active evidence')
        with JobsOwner(self.root):pass
        self.assertTrue((self.root/'.server-owner.lock').exists())

    def test_cli_contender_returns_clear_error(self):
        with JobsOwner(self.root):
            result=subprocess.run([sys.executable,'-m','fairbeam','serve','--port','0',
                                   '--jobs',str(self.root),'--models',str(self.root/'models'),
                                   '--projects',str(self.root/'projects')],capture_output=True,text=True,timeout=10,**FLAGS)
        self.assertEqual(result.returncode,2,result.stderr)
        self.assertIn('workspace_in_use',result.stderr)
        self.assertNotIn('Traceback',result.stderr)
        self.assertFalse((self.root/'models').exists())
        self.assertFalse((self.root/'projects').exists())

    def test_process_contention_and_crash_release(self):
        owner=self.helper("lease=mod.JobsOwner(sys.argv[2]);lease.__enter__();print('ready',flush=True);sys.stdin.readline()",stdin=subprocess.PIPE)
        try:
            self.assertEqual(owner.stdout.readline().strip(),b'ready')
            with self.assertRaises(WorkspaceInUse):
                with JobsOwner(self.root):pass
            owner.kill();owner.wait(timeout=5)
            with JobsOwner(self.root):pass
        finally:
            if owner.poll() is None:owner.kill();owner.wait(timeout=5)
            for stream in [owner.stdin,owner.stdout,owner.stderr]:stream.close()

    def test_descriptor_noninheritance_and_independent_roots(self):
        with JobsOwner(self.root) as owner:
            self.assertFalse(os.get_inheritable(owner.fd))
            with JobsOwner(self.root.parent/'other'):pass
        with JobsOwner(self.root):pass

    def test_live_child_does_not_inherit_lease(self):
        with JobsOwner(self.root):
            child=self.helper("print('ready',flush=True);sys.stdin.readline()",stdin=subprocess.PIPE,close_fds=False)
            self.assertEqual(child.stdout.readline().strip(),b'ready')
        try:
            # Even with close_fds=False, our non-inheritable lock has left the parent.
            with JobsOwner(self.root):pass
        finally:
            child.stdin.close();child.wait(timeout=5)
            child.stdout.close();child.stderr.close()

    def test_stale_contents_exception_release_and_permission_error(self):
        self.root.mkdir();(self.root/'.server-owner.lock').write_text('stale PID diagnostic')
        with self.assertRaises(RuntimeError):
            with JobsOwner(self.root):raise RuntimeError('constructor failure')
        with JobsOwner(self.root):pass
        with mock.patch('fairbeam.jobs_owner.os.open',side_effect=PermissionError('denied')):
            with self.assertRaisesRegex(ValueError,'Cannot open jobs-directory ownership'):
                with JobsOwner(self.root):pass

    def test_constructor_failure_releases_owner(self):
        with mock.patch.object(server,'App',side_effect=RuntimeError('constructor failed')):
            with self.assertRaisesRegex(RuntimeError,'constructor failed'):
                server.serve(port=0,models_dir=self.root,projects_dir=self.root,jobs_dir=self.root)
        with JobsOwner(self.root):pass

    def test_bind_failure_and_close_failure_join_before_release(self):
        app=mock.Mock();app.close.side_effect=RuntimeError('close failed')
        def joined():
            with self.assertRaises(WorkspaceInUse):
                with JobsOwner(self.root):pass
        app.manager.worker.join.side_effect=joined
        with mock.patch.object(server,'App',return_value=app),mock.patch.object(server,'make_server',side_effect=OSError('bind failed')):
            with self.assertRaisesRegex(RuntimeError,'close failed'):
                server.serve(port=0,models_dir=self.root,projects_dir=self.root,jobs_dir=self.root)
        app.close.assert_called_once();app.manager.worker.join.assert_called_once()
        with JobsOwner(self.root):pass

if __name__=='__main__':unittest.main()
