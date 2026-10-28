"""Patch admission and opt-in native argument checks; no field propagation."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
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


@unittest.skipUnless(os.name == 'nt' and os.environ.get('FAIRBEAM_TEST_PML_GRADING_SDK'),
                     'Native argument checks require an explicitly supplied private Windows '
                     'PML SDK (FAIRBEAM_TEST_PML_GRADING_SDK); no installed runtime is patched')
class NativeArgumentAdmission(unittest.TestCase):
    """Exercise the real native parser without creating an operator or propagating fields.

    The candidate must already have been built separately. This test never builds,
    installs, patches or changes the default runtime. A fresh process checks the DLL
    actually loaded before trusting the option probes; the ordinary suite skips it.
    Empty arguments and recovery are parser checks, not proof of the operator profile.
    """

    def test_bounds_wraparound_overflow_and_error_recovery(self):
        sdk = Path(os.environ['FAIRBEAM_TEST_PML_GRADING_SDK']).resolve(strict=True)
        self.assertTrue(sdk.is_dir(), 'The private SDK must be a directory')
        script = textwrap.dedent(r'''
            import ctypes
            from ctypes import wintypes
            import json
            import os
            from pathlib import Path
            from openEMS import openEMS

            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
            kernel.GetModuleHandleW.restype = wintypes.HMODULE
            kernel.GetModuleFileNameW.argtypes = [wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD]
            kernel.GetModuleFileNameW.restype = wintypes.DWORD
            handle = kernel.GetModuleHandleW('openEMS.dll')
            if not handle:
                raise RuntimeError('The imported native openEMS DLL was not found')
            path = ctypes.create_unicode_buffer(32768)
            length = kernel.GetModuleFileNameW(handle, path, len(path))
            if not 0 < length < len(path):
                raise RuntimeError('The loaded openEMS DLL path could not be verified')
            loaded = Path(path.value).resolve(strict=True)
            sdk = Path(os.environ['FAIRBEAM_TEST_PML_GRADING_SDK']).resolve(strict=True)
            if not loaded.is_relative_to(sdk):
                raise RuntimeError(f'Loaded DLL is outside the supplied private SDK: {loaded}')

            simulation = openEMS()
            accepted, rejected = [], []
            for value in ('1', '8', '64'):
                simulation._SetLibraryArguments({'pml_grading_cells': value})
                accepted.append(value)
            # Unsigned lexical conversion used to turn these negatives into 1/8/64.
            invalid = ('0', '65', '-1', '-4294967295', '-4294967288', '-4294967232',
                       '2147483648', '4294967295', '4294967296', '-2147483649',
                       '999999999999999999999999', '', 'invalid', '8.5')
            for value in invalid:
                try:
                    simulation._SetLibraryArguments({'pml_grading_cells': value})
                except Exception as error:
                    rejected.append({'value': value, 'type': type(error).__name__})
                else:
                    raise AssertionError(f'Invalid PML reference was accepted: {value!r}')
                # No failed parse may poison the next accepted parse in this process.
                simulation._SetLibraryArguments({'pml_grading_cells': '8'})
                simulation._SetLibraryArguments({})
            print('PML_ARGUMENT_REPORT=' + json.dumps({
                'loaded_dll': str(loaded), 'accepted': accepted, 'rejected': rejected,
                'operator_setups': 0, 'field_steps': 0}))
        ''')
        env = dict(os.environ, OPENEMS_INSTALL_PATH=str(sdk), CSXCAD_INSTALL_PATH=str(sdk))
        result = subprocess.run([sys.executable, '-c', script], capture_output=True,
                                text=True, encoding='utf-8', env=env, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + '\n' + result.stderr)
        report_line = next(line for line in result.stdout.splitlines()
                           if line.startswith('PML_ARGUMENT_REPORT='))
        report = json.loads(report_line.partition('=')[2])
        self.assertEqual(report['accepted'], ['1', '8', '64'])
        self.assertEqual(len(report['rejected']), 14)
        self.assertEqual((report['operator_setups'], report['field_steps']), (0, 0))


if __name__ == '__main__':
    unittest.main()
