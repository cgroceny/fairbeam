"""Pinned native experiment admission; ordinary tests propagate no fields."""
import importlib.util
import ctypes
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[2]/'scripts/native-cpu/apply-cylindrical-pml-metric.py'
spec = importlib.util.spec_from_file_location('cylindrical_pml_applier', PATH)
applier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(applier)
WAVEFORM = PATH.with_name('check-cylindrical-pml-waveforms.py')
spec = importlib.util.spec_from_file_location('cylindrical_pml_waveforms', WAVEFORM)
waveforms = importlib.util.module_from_spec(spec)
spec.loader.exec_module(waveforms)


class AnalyticReference(unittest.TestCase):
    def test_hankel_value_and_argument_scope(self):
        self.assertAlmostEqual(abs(waveforms.hankel_one(1.)-
            complex(.4400505857449335, -.7812128213002887)), 0., places=14)
        for x in (0., -1., 15., float('inf'), float('nan')):
            with self.assertRaises(ValueError):waveforms.hankel_one(x)

    @unittest.skipUnless(os.name == 'nt', 'Independent Microsoft CRT Bessel reference')
    def test_series_against_independent_crt_over_diagnostic_range(self):
        crt = ctypes.CDLL('ucrtbase.dll')
        for name in ('_j1', '_y1'):
            function = getattr(crt, name);function.argtypes = [ctypes.c_double];function.restype = ctypes.c_double
        for i in range(1, 120):
            x = i/10
            with self.subTest(x=x):
                expected = complex(crt._j1(x), crt._y1(x))
                self.assertLess(abs(waveforms.hankel_one(x)-expected), 1e-11)


@unittest.skipUnless(shutil.which('git'), 'Git is required for patch admission')
class PatchAdmission(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)/'source';self.root.mkdir()
        self.names = ('main.cpp', 'nested/operator.cpp')
        self.before, self.after = {}, {}
        hunks = []
        for name in self.names:
            p = self.root/name;p.parent.mkdir(exist_ok=True)
            p.write_bytes(b'before\n');self.before[name] = applier.digest(p)
            p.write_bytes(b'after\n');self.after[name] = applier.digest(p);p.write_bytes(b'before\n')
            hunks.append(f'--- a/{name}\n+++ b/{name}\n@@ -1 +1 @@\n-before\n+after\n')
        self.git('init', '-q');self.git('add', '.')
        self.git('-c', 'user.name=Patch fixture', '-c', 'user.email=fixture@example.invalid',
                 '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath='+str(self.root/'no-hooks'),
                 'commit', '-qm', 'own synthetic source')
        self.patchfile = self.root.parent/'own.patch'
        self.patchfile.write_text(''.join(hunks), encoding='utf-8', newline='\n')
        override = patch.multiple(applier, BEFORE=self.before, AFTER=self.after,
            REVISION=self.git('rev-parse', 'HEAD'), PATCH=self.patchfile, PATCH_SHA=applier.digest(self.patchfile))
        override.start();self.addCleanup(override.stop)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args],
                                       encoding='utf-8', stderr=subprocess.STDOUT).strip()

    def unchanged(self):
        for name in self.names:self.assertEqual((self.root/name).read_bytes(), b'before\n')

    def test_dry_run_atomic_two_file_apply_and_reapplication_refusal(self):
        self.assertEqual(applier.apply(self.root, check_only=True)['files_changed'], 0)
        self.unchanged();self.assertEqual(self.git('status', '--porcelain'), '')
        self.assertEqual(applier.apply(self.root)['files_changed'], 2)
        applied = {name:(self.root/name).read_bytes() for name in self.names}
        for name in self.names:self.assertEqual((self.root/name).read_text(), 'after\n')
        with self.assertRaisesRegex(ValueError, 'clean'):applier.apply(self.root)
        for name in self.names:self.assertEqual((self.root/name).read_bytes(), applied[name])

    def test_wrong_revision_and_each_bad_fingerprint_refuse_before_mutation(self):
        for overrides in (dict(REVISION='0'*40), dict(PATCH_SHA='0'*64),
                          *(dict(BEFORE={**self.before, name:'0'*64}) for name in self.names)):
            with self.subTest(overrides=overrides), patch.multiple(applier, **overrides):
                with self.assertRaises(ValueError):applier.apply(self.root)
                self.unchanged();self.assertEqual(self.git('status', '--porcelain'), '')

    def test_bad_second_hunk_does_not_partially_apply_first_file(self):
        first, last = self.patchfile.read_text().rsplit('-before', 1)
        self.patchfile.write_text(first+'-absent'+last, encoding='utf-8', newline='\n')
        with patch.object(applier, 'PATCH_SHA', applier.digest(self.patchfile)):
            with self.assertRaisesRegex(RuntimeError, 'git apply failed'):applier.apply(self.root)
        self.unchanged();self.assertEqual(self.git('status', '--porcelain'), '')

    def test_dirty_tracked_and_personal_files_are_retained(self):
        for name in (*self.names, 'personal.txt'):
            with self.subTest(name=name):
                p = self.root/name;old = p.read_bytes() if p.exists() else None;p.write_bytes(b'own edit\n')
                with self.assertRaisesRegex(ValueError, 'clean'):applier.apply(self.root)
                self.assertEqual(p.read_bytes(), b'own edit\n')
                if old is None:p.unlink()
                else:p.write_bytes(old)
        self.unchanged()

    def test_missing_or_linked_source_refuses_before_mutation(self):
        with patch.object(Path, 'is_symlink', return_value=True):
            with self.assertRaisesRegex(ValueError, 'Regular'):applier.apply(self.root)
        self.unchanged()
        p = self.root/self.names[1];p.unlink()
        with self.assertRaisesRegex(ValueError, 'Regular'):applier.apply(self.root)
        self.assertEqual((self.root/self.names[0]).read_bytes(), b'before\n')

    def test_post_apply_failure_is_reported_and_preserved(self):
        with patch.object(applier, 'AFTER', {name:'0'*64 for name in self.names}):
            with self.assertRaisesRegex(RuntimeError, 'retain files'):applier.apply(self.root)
        for name in self.names:self.assertEqual((self.root/name).read_text(), 'after\n')


if __name__ == '__main__':
    unittest.main()
