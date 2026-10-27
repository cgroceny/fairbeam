"""Patch admission controls using disposable Git repositories; no native runs."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


PATH = Path(__file__).resolve().parents[2]/'scripts/native-cpu/apply-pml-grading-cells.py'
spec = importlib.util.spec_from_file_location('pml_grading_applier', PATH)
applier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(applier)


@unittest.skipUnless(shutil.which('git'), 'Git is required for native source patch admission')
class PatchAdmission(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base/'source';self.root.mkdir()
        self.target = self.root/'openems.cpp'
        self.target.write_text('before\n', encoding='utf-8', newline='\n')
        self.run_git('init', '-q')
        self.run_git('add', 'openems.cpp')
        self.run_git('-c', 'user.name=Patch fixture', '-c', 'user.email=fixture@example.invalid',
                     '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath='+str(self.base/'no-hooks'),
                     'commit', '-qm', 'own synthetic source')
        self.patchfile = self.base/'own.patch'
        self.patchfile.write_text('--- a/openems.cpp\n+++ b/openems.cpp\n@@ -1 +1 @@\n-before\n+after\n',
                                  encoding='utf-8', newline='\n')
        after = self.base/'after';after.write_text('after\n', encoding='utf-8', newline='\n')
        overrides = dict(REVISION=self.run_git('rev-parse', 'HEAD'), PATCH=self.patchfile,
            BEFORE_SHA=applier.digest(self.target), AFTER_SHA=applier.digest(after),
            PATCH_SHA=applier.digest(self.patchfile))
        control = patch.multiple(applier, **overrides);control.start();self.addCleanup(control.stop)

    def run_git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args],
                                       encoding='utf-8', stderr=subprocess.STDOUT).strip()

    def test_check_then_apply_and_refuse_reapplication_without_changing_it(self):
        before = self.target.read_bytes()
        self.assertEqual(applier.apply(self.root, check_only=True)['files_changed'], 0)
        self.assertEqual(self.target.read_bytes(), before)
        self.assertEqual(self.run_git('status', '--porcelain'), '')
        self.assertEqual(applier.apply(self.root)['files_changed'], 1)
        self.assertEqual(self.target.read_text(encoding='utf-8'), 'after\n')
        applied = self.target.read_bytes()
        with self.assertRaisesRegex(ValueError, 'clean'):
            applier.apply(self.root)
        self.assertEqual(self.target.read_bytes(), applied)

    def test_wrong_revision_refuses_before_mutation(self):
        with patch.object(applier, 'REVISION', '0'*40):
            with self.assertRaisesRegex(ValueError, 'revision'):
                applier.apply(self.root)
        self.assertEqual(self.target.read_bytes(), b'before\n')

    def test_dirty_tracked_or_untracked_source_is_retained(self):
        for name in ('openems.cpp', 'personal.txt'):
            path = self.root/name;original = path.read_bytes() if path.exists() else None
            path.write_bytes(b'own local edit\n')
            with self.assertRaisesRegex(ValueError, 'clean'):
                applier.apply(self.root)
            self.assertEqual(path.read_bytes(), b'own local edit\n')
            if original is None:path.unlink()
            else:path.write_bytes(original)

    def test_changed_patch_or_source_fingerprint_refuses_before_mutation(self):
        for name in ('PATCH_SHA', 'BEFORE_SHA'):
            with patch.object(applier, name, '0'*64):
                with self.assertRaisesRegex(ValueError, 'fingerprint'):
                    applier.apply(self.root)
            self.assertEqual(self.target.read_bytes(), b'before\n')

    def test_nonmatching_reviewed_hunk_is_atomic(self):
        self.patchfile.write_text('--- a/openems.cpp\n+++ b/openems.cpp\n@@ -1 +1 @@\n-absent\n+after\n',
                                  encoding='utf-8', newline='\n')
        with patch.object(applier, 'PATCH_SHA', applier.digest(self.patchfile)):
            with self.assertRaisesRegex(RuntimeError, 'git apply failed'):
                applier.apply(self.root)
        self.assertEqual(self.target.read_bytes(), b'before\n')
        self.assertEqual(self.run_git('status', '--porcelain'), '')

    def test_post_apply_corruption_is_reported_and_retained(self):
        with patch.object(applier, 'AFTER_SHA', '0'*64):
            with self.assertRaisesRegex(RuntimeError, 'retain files'):
                applier.apply(self.root)
        self.assertEqual(self.target.read_text(encoding='utf-8'), 'after\n')

    def test_symlink_or_missing_native_source_refuses_before_mutation(self):
        with patch.object(Path, 'is_symlink', return_value=True):
            with self.assertRaisesRegex(ValueError, 'regular openems.cpp'):
                applier.apply(self.root)
        self.assertEqual(self.target.read_bytes(), b'before\n')
        with self.assertRaisesRegex(ValueError, 'regular openems.cpp'):
            applier.apply(self.base)


if __name__ == '__main__':
    unittest.main()
