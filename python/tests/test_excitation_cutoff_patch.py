"""Refusal/atomicity checks for the opt-in native source patch; no fields."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/native-cpu/apply-excitation-cutoff.py'
spec = importlib.util.spec_from_file_location('excitation_cutoff_applier', SCRIPT)
applier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(applier)


class PublishedPatch(unittest.TestCase):
    def test_frozen_patch_fingerprint_and_line_ending_normalization(self):
        self.assertEqual(applier.digest(applier.PATCH), applier.PATCH_SHA)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'own.txt'
            path.write_bytes(b'own\ntext\n')
            expected = applier.digest(path)
            path.write_bytes(b'own\r\ntext\r\n')
            self.assertEqual(applier.digest(path), expected)


@unittest.skipUnless(shutil.which('git'), 'Git is required for native patch admission')
class PatchAdmission(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / 'source'
        self.target = self.root / 'FDTD/excitation.cpp'
        self.target.parent.mkdir(parents=True)
        self.original = b'before-one\nfirst-context\nmiddle\nlast-context\nbefore-two\n'
        self.changed = b'after-one\nfirst-context\nmiddle\nlast-context\nafter-two\n'
        self.target.write_bytes(self.original)
        before = applier.digest(self.target)
        self.target.write_bytes(self.changed)
        after = applier.digest(self.target)
        self.target.write_bytes(self.original)
        self.git('init', '-q')
        self.git('config', 'core.autocrlf', 'false')
        self.git('add', '.')
        self.git('-c', 'user.name=Patch fixture', '-c', 'user.email=fixture@example.invalid',
                 '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + str(self.root / 'no-hooks'),
                 'commit', '-qm', 'own synthetic source')
        self.patchfile = Path(temp.name) / 'own.patch'
        self.patchfile.write_text('--- a/FDTD/excitation.cpp\n+++ b/FDTD/excitation.cpp\n'
            '@@ -1,2 +1,2 @@\n-before-one\n+after-one\n first-context\n'
            '@@ -4,2 +4,2 @@\n last-context\n-before-two\n+after-two\n', encoding='utf-8', newline='\n')
        override = patch.multiple(applier, REVISIONS=(self.git('rev-parse', 'HEAD'),),
            BEFORE={'FDTD/excitation.cpp': before}, AFTER={'FDTD/excitation.cpp': after},
            PATCH=self.patchfile, PATCH_SHA=applier.digest(self.patchfile))
        override.start()
        self.addCleanup(override.stop)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], encoding='utf-8',
                                       stderr=subprocess.STDOUT).strip()

    def assert_unchanged(self):
        self.assertEqual(self.target.read_bytes(), self.original)
        self.assertEqual(self.git('status', '--porcelain'), '')

    def test_check_apply_and_reapplication_refusal(self):
        self.assertEqual(applier.apply(self.root, check_only=True)['files_changed'], 0)
        self.assert_unchanged()
        self.assertEqual(applier.apply(self.root)['files_changed'], 1)
        self.assertEqual(self.target.read_bytes(), self.changed)
        with self.assertRaisesRegex(ValueError, 'clean'):
            applier.apply(self.root)
        self.assertEqual(self.target.read_bytes(), self.changed)

    def test_revision_patch_and_source_tampering_refused_without_edits(self):
        for values in ({'REVISIONS': ('0' * 40,)}, {'PATCH_SHA': '0' * 64},
                       {'BEFORE': {'FDTD/excitation.cpp': '0' * 64}}):
            with self.subTest(values=values), patch.multiple(applier, **values):
                with self.assertRaises(ValueError):
                    applier.apply(self.root)
                self.assert_unchanged()

    def test_bad_second_hunk_never_applies_the_first(self):
        self.patchfile.write_text(self.patchfile.read_text().replace('-before-two', '-absent'),
                                  encoding='utf-8', newline='\n')
        with patch.object(applier, 'PATCH_SHA', applier.digest(self.patchfile)):
            with self.assertRaisesRegex(RuntimeError, 'git apply failed'):
                applier.apply(self.root)
        self.assert_unchanged()

    def test_tracked_and_personal_changes_retained(self):
        self.target.write_bytes(b'personal edit\n')
        with self.assertRaisesRegex(ValueError, 'clean'):
            applier.apply(self.root)
        self.assertEqual(self.target.read_bytes(), b'personal edit\n')
        self.target.write_bytes(self.original)
        own = self.root / 'personal.txt'
        own.write_bytes(b'keep me\n')
        with self.assertRaisesRegex(ValueError, 'clean'):
            applier.apply(self.root)
        self.assertEqual(own.read_bytes(), b'keep me\n')
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_missing_and_linked_files_refused(self):
        with patch.object(Path, 'is_symlink', return_value=True):
            with self.assertRaisesRegex(ValueError, 'Regular'):
                applier.apply(self.root)
        self.assert_unchanged()
        self.target.unlink()
        with self.assertRaisesRegex(ValueError, 'Regular'):
            applier.apply(self.root)

    def test_post_apply_mismatch_preserved_for_inspection(self):
        with patch.object(applier, 'AFTER', {'FDTD/excitation.cpp': '0' * 64}):
            with self.assertRaisesRegex(RuntimeError, 'retain files'):
                applier.apply(self.root)
        self.assertEqual(self.target.read_bytes(), self.changed)


if __name__ == '__main__':
    unittest.main()
