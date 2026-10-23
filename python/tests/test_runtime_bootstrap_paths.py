"""Offline Windows tests for the managed-Python directory's physical path.

The shared fixture loads function definitions only, never the installer body.
Every created file belongs to a TemporaryDirectory; no runtime or profile is used.
"""

import os
from pathlib import Path
import tempfile
import unittest

from test_runtime_bootstrap import POWERSHELL, ps_string, run_powershell


def comparable_path(path):
    return os.path.normcase(os.path.normpath(str(path)))


@unittest.skipUnless(os.name == "nt" and Path(POWERSHELL).is_file(),
                     "requires Windows PowerShell 5.1")
class RuntimeBootstrapPaths(unittest.TestCase):
    def resolved_by_powershell(self, directory):
        result = run_powershell(
            "Write-Line ([Console]::Out) (Get-PhysicalDirectory %s)"
            % ps_string(directory)
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        lines = result.stdout.strip().splitlines()
        self.assertEqual(len(lines), 1, result.stdout)
        resolved = Path(lines[0])
        self.assertTrue(resolved.is_absolute(), result.stdout)
        return resolved

    def test_existing_directory_preserves_spaces_unicode_and_quotes(self):
        with tempfile.TemporaryDirectory(prefix="fairbeam-path-") as tmp:
            directory = Path(tmp) / "runtime path \u0131\u011f\u00fc 'quoted'" / "python"
            directory.mkdir(parents=True)
            sentinel = directory / "unchanged.txt"
            sentinel.write_bytes(b"physical-path fixture")
            expected = directory.resolve(strict=True)

            actual = self.resolved_by_powershell(directory)

            self.assertEqual(comparable_path(actual), comparable_path(expected))
            self.assertEqual(sentinel.read_bytes(), b"physical-path fixture")
            self.assertEqual((actual / sentinel.name).read_bytes(), sentinel.read_bytes())
            self.assertEqual({p.name for p in directory.iterdir()}, {sentinel.name})

    def test_missing_directory_fails_without_creating_it(self):
        with tempfile.TemporaryDirectory(prefix="fairbeam-path-") as tmp:
            directory = Path(tmp) / "not-created"

            result = run_powershell(
                "Write-Line ([Console]::Out) (Get-PhysicalDirectory %s)"
                % ps_string(directory)
            )

            self.assertNotEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertEqual(result.stdout.strip(), "", result.stdout)
            self.assertFalse(directory.exists())
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_file_is_rejected_without_modifying_it(self):
        with tempfile.TemporaryDirectory(prefix="fairbeam-path-") as tmp:
            path = Path(tmp) / "python"
            path.write_bytes(b"not a directory")

            result = run_powershell(
                "Write-Line ([Console]::Out) (Get-PhysicalDirectory %s)"
                % ps_string(path)
            )

            self.assertNotEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertEqual(result.stdout.strip(), "", result.stdout)
            self.assertEqual(path.read_bytes(), b"not a directory")
            self.assertEqual({p.name for p in Path(tmp).iterdir()}, {path.name})

    def test_resolver_releases_handle_before_same_process_recreation(self):
        with tempfile.TemporaryDirectory(prefix="fairbeam-path-") as tmp:
            directory = Path(tmp) / "python"
            directory.mkdir()
            expected = directory.resolve(strict=True)
            # Recreate before PowerShell exits: process teardown must not hide a
            # leaked handle that leaves the old directory pending deletion.
            result = run_powershell("""
$fixtureDirectory = %s
Write-Line ([Console]::Out) (Get-PhysicalDirectory $fixtureDirectory)
[System.IO.Directory]::Delete($fixtureDirectory, $false)
[void][System.IO.Directory]::CreateDirectory($fixtureDirectory)
Write-Line ([Console]::Out) (Get-PhysicalDirectory $fixtureDirectory)
""" % ps_string(directory))

            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            lines = result.stdout.strip().splitlines()
            self.assertEqual(len(lines), 2, result.stdout)
            for actual in lines:
                self.assertEqual(comparable_path(actual), comparable_path(expected))
            self.assertTrue(directory.is_dir())
            self.assertEqual(list(directory.iterdir()), [])

    def test_virtualized_local_appdata_uses_physical_directory(self):
        local_appdata = os.environ.get("LOCALAPPDATA")
        if not local_appdata or not Path(local_appdata).is_dir():
            self.skipTest("LOCALAPPDATA is not an available directory")
        # Only this newly allocated folder is touched. Derive the actual physical
        # location independently; do not assume an MSIX package name or layout.
        with tempfile.TemporaryDirectory(prefix="fairbeam-path-msix-",
                                         dir=local_appdata) as tmp:
            directory = Path(tmp) / "runtime" / "python"
            directory.mkdir(parents=True)
            logical = directory.absolute()
            expected = directory.resolve(strict=True)
            if comparable_path(logical) == comparable_path(expected):
                self.skipTest("this process has no observable LOCALAPPDATA redirection")
            sentinel = directory / "unchanged.txt"
            sentinel.write_bytes(b"MSIX physical directory fixture")

            actual = self.resolved_by_powershell(logical)

            self.assertNotEqual(comparable_path(actual), comparable_path(logical))
            self.assertEqual(comparable_path(actual), comparable_path(expected))
            self.assertEqual((actual / sentinel.name).read_bytes(), sentinel.read_bytes())
            self.assertEqual({p.name for p in directory.iterdir()}, {sentinel.name})


if __name__ == "__main__":
    unittest.main()
