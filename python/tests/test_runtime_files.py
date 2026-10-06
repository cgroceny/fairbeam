"""Retry behavior for Windows runtime file operations."""

import ctypes
from ctypes import wintypes
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock
import zipfile
from contextlib import redirect_stderr
from io import StringIO


INSTALL_PATH = Path(__file__).resolve().parents[2] / "runtime" / "install.py"
PINS_PATH = Path(__file__).resolve().parents[2] / "runtime" / "pins.json"
SPEC = importlib.util.spec_from_file_location("fairbeam_runtime_install", INSTALL_PATH)
install = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(install)


def win_error(code):
    error = OSError(f"Windows error {code}")
    error.winerror = code
    return error


class RuntimeEngineSelection(unittest.TestCase):
    def test_gpu_pin_is_separate_from_cpu_pin(self):
        pins = json.loads(PINS_PATH.read_text(encoding="utf-8"))
        cpu_group, cpu = install.select_openems_pin(pins, "windows-x64", "cpu")
        gpu_group, gpu = install.select_openems_pin(pins, "windows-x64", "gpu")

        self.assertEqual(cpu_group, pins["openems"])
        self.assertEqual(cpu["version"] if "version" in cpu else cpu_group["version"], "v0.37.0-rc3")
        self.assertEqual(gpu_group["version"], "v0.37.0-beta1+gpu")
        self.assertEqual(gpu["sha256"], "ca308c03de41054056b20b4d40c3fe51c07f2a7fb5702fe1042d6406f741764f")
        self.assertEqual(gpu["size"], 66009500)
        self.assertEqual(install.select_openems_pin(pins, "macos-arm64", "gpu")[1], {})

    def test_gpu_engine_help_marker_is_specific(self):
        self.assertTrue(install.gpu_engine_listed("engines:\n  cpu: multithreaded\n  gpu: CUDA"))
        self.assertFalse(install.gpu_engine_listed("engines:\n  cpu: multithreaded\n  gpu backend disabled"))
        self.assertFalse(install.gpu_engine_listed("engines:\n  cpu: multithreaded"))

    def test_bad_gpu_archive_hash_preserves_existing_manifest_and_engine(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "gpu-runtime-test"
            py = root / "venv" / "Scripts" / "python.exe"
            uv = root / "uv" / "uv.exe"
            py.parent.mkdir(parents=True)
            uv.parent.mkdir(parents=True)
            py.write_bytes(b"mock python")
            uv.write_bytes(b"mock uv")
            existing_manifest = root / "manifest.json"
            original_manifest = json.dumps({
                "marker": install.MARKER,
                "engine": "gpu",
                "openems": "existing working build",
            }).encode("utf-8")
            existing_manifest.write_bytes(original_manifest)
            openems_exe = root / "openEMS" / "openEMS.exe"
            openems_exe.parent.mkdir()
            openems_exe.write_bytes(b"existing working engine")
            bad_archive = Path(tmp) / "wrong-openems.zip"
            bad_archive.write_bytes(b"not the pinned archive")
            stderr = StringIO()
            args = [
                "install.py", "--runtime-root", str(root), "--resources",
                str(INSTALL_PATH.parents[1]), "--engine", "gpu", "--openems-archive",
                str(bad_archive),
            ]

            with mock.patch.object(install.sys, "platform", "win32"), \
                    mock.patch.object(install, "platform_key", return_value="windows-x64"), \
                    mock.patch.object(install.sys, "argv", args), \
                    redirect_stderr(stderr):
                with self.assertRaises(SystemExit) as raised:
                    install.main()

            self.assertEqual(raised.exception.code, 1)
            self.assertIn("SHA-256 does not match", stderr.getvalue())
            self.assertEqual(existing_manifest.read_bytes(), original_manifest)
            self.assertEqual(openems_exe.read_bytes(), b"existing working engine")


class WindowsFileRetry(unittest.TestCase):
    def test_transient_failures_then_success_return_result(self):
        result = object()
        outcomes = [win_error(5), win_error(32), result]
        calls = []

        def operation():
            calls.append(1)
            value = outcomes.pop(0)
            if isinstance(value, Exception):
                raise value
            return value

        with mock.patch.object(install.sys, "platform", "win32"):
            actual = install._retry_windows_file_operation(
                operation, attempts=3, delay=0,
            )
        self.assertIs(actual, result)
        self.assertEqual(len(calls), 3)

    def test_exhausted_retries_raise_final_exception(self):
        errors = [win_error(32), win_error(33), win_error(5)]
        calls = []

        def operation():
            calls.append(1)
            raise errors[len(calls) - 1]

        with mock.patch.object(install.sys, "platform", "win32"):
            with self.assertRaises(OSError) as raised:
                install._retry_windows_file_operation(
                    operation, attempts=3, delay=0,
                )
        self.assertIs(raised.exception, errors[-1])
        self.assertEqual(len(calls), 3)

    def test_unrelated_windows_error_is_not_retried(self):
        error = win_error(2)
        calls = []

        def operation():
            calls.append(1)
            raise error

        with mock.patch.object(install.sys, "platform", "win32"):
            with self.assertRaises(OSError) as raised:
                install._retry_windows_file_operation(
                    operation, attempts=4, delay=0,
                )
        self.assertIs(raised.exception, error)
        self.assertEqual(len(calls), 1)

    def test_non_windows_error_is_not_retried(self):
        error = win_error(32)
        calls = []

        def operation():
            calls.append(1)
            raise error

        with mock.patch.object(install.sys, "platform", "linux"):
            with self.assertRaises(OSError) as raised:
                install._retry_windows_file_operation(
                    operation, attempts=4, delay=0,
                )
        self.assertIs(raised.exception, error)
        self.assertEqual(len(calls), 1)


class RuntimePublicationRetry(unittest.TestCase):
    def test_unpack_openems_retries_atomic_flat_directory_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "İzmir çalışma" / "runtime"
            root.mkdir(parents=True)
            archive = root / "tiny-openems.zip"
            with zipfile.ZipFile(archive, "w") as packed:
                packed.writestr("archive-folder/bin/openEMS.exe", b"fake executable")
                packed.writestr("archive-folder/bin/solver.dll", b"fake library")
            target = root / "openEMS"
            real_replace = install.os.replace
            publications = []

            def replace_once(source, destination):
                if Path(destination) != target:
                    return real_replace(source, destination)
                source = Path(source)
                publications.append(source)
                self.assertTrue(source.is_dir())
                self.assertEqual((source / "openEMS.exe").read_bytes(), b"fake executable")
                self.assertFalse((source / "openEMS").exists())
                if len(publications) == 1:
                    raise win_error(32)
                self.assertEqual(source, publications[0])
                return real_replace(source, destination)

            with mock.patch.object(install.sys, "platform", "win32"), \
                    mock.patch.object(install.time, "sleep") as sleep, \
                    mock.patch.object(install.os, "replace", side_effect=replace_once):
                result = install.unpack_openems(archive, "msvc-zip", root, "test-digest")

            self.assertEqual(result, target)
            self.assertEqual(len(publications), 2)
            sleep.assert_called_once()
            self.assertEqual((target / "openEMS.exe").read_bytes(), b"fake executable")
            self.assertEqual((target / "solver.dll").read_bytes(), b"fake library")
            self.assertFalse((target / "openEMS").exists())
            self.assertEqual(json.loads((target / install.STAMP).read_text(encoding="utf-8"))["sha256"],
                             "test-digest")

    def test_install_app_retries_directory_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "İzmir çalışma"
            root = base / "runtime"
            package = base / "resources" / "python" / "fairbeam"
            site = base / "site packages"
            root.mkdir(parents=True)
            package.mkdir(parents=True)
            site.mkdir()
            (package / "__init__.py").write_text("from ._meta import __version__\n", encoding="utf-8")
            (package / "_meta.py").write_text("__version__ = '1.2.3'\n", encoding="utf-8")
            app = root / "app"
            staging = root / "app.new"
            real_replace = install.os.replace
            publications = []

            def replace_once(source, destination):
                self.assertEqual(Path(source), staging)
                self.assertEqual(Path(destination), app)
                publications.append(1)
                self.assertTrue((staging / "fairbeam" / "_meta.py").is_file())
                if len(publications) == 1:
                    raise win_error(32)
                return real_replace(source, destination)

            with mock.patch.object(install.sys, "platform", "win32"), \
                    mock.patch.object(install.time, "sleep") as sleep, \
                    mock.patch.object(install.os, "replace", side_effect=replace_once), \
                    mock.patch.object(install, "site_packages", return_value=site):
                version = install.install_app(root, base / "resources", Path("unused-python"))

            self.assertEqual(version, "1.2.3")
            self.assertEqual(len(publications), 2)
            sleep.assert_called_once()
            self.assertTrue((app / "fairbeam" / "__init__.py").is_file())
            self.assertFalse(staging.exists())
            self.assertEqual((site / "fairbeam.pth").read_text(encoding="utf-8"), str(app) + "\n")

    def test_manifest_replacement_retries_with_temp_source_intact(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "İzmir çalışma" / "runtime"
            root.mkdir(parents=True)
            target = root / "manifest.json"
            target.write_text('{"old": true}', encoding="utf-8")
            source = root / "manifest.json.tmp"
            manifest = {"marker": "fairbeam runtime v1", "fairbeam": "1.2.3"}
            real_replace = install.os.replace
            publications = []

            def replace_once(actual_source, destination):
                self.assertEqual(Path(actual_source), source)
                self.assertEqual(Path(destination), target)
                publications.append(1)
                self.assertEqual(json.loads(source.read_text(encoding="utf-8")), manifest)
                if len(publications) == 1:
                    raise win_error(32)
                return real_replace(actual_source, destination)

            with mock.patch.object(install.sys, "platform", "win32"), \
                    mock.patch.object(install.time, "sleep") as sleep, \
                    mock.patch.object(install.os, "replace", side_effect=replace_once):
                install.write_manifest(root, manifest)

            self.assertEqual(len(publications), 2)
            sleep.assert_called_once()
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), manifest)
            self.assertFalse(source.exists())


class WindowsLockedFileIntegration(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "win32", "Windows file sharing only")
    def test_locked_file_is_deleted_after_handle_releases(self):
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateFileW.argtypes = (
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        )
        kernel32.CreateFileW.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel32.CloseHandle.restype = wintypes.BOOL
        generic_read = 0x80000000
        share_read_write = 0x00000001 | 0x00000002  # Deliberately omit FILE_SHARE_DELETE.
        open_existing = 3
        file_attribute_normal = 0x80

        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "İzmir çalışma"
            folder.mkdir()
            target = folder / "openEMS archive.zip"
            target.write_bytes(b"temporary")
            handle = kernel32.CreateFileW(
                str(target), generic_read, share_read_write, None,
                open_existing, file_attribute_normal, None,
            )
            if handle == wintypes.HANDLE(-1).value:
                raise ctypes.WinError(ctypes.get_last_error())

            first_failure = threading.Event()
            close_errors = []
            observed_errors = []
            calls = []

            def release_handle():
                first_failure.wait(5)
                if not kernel32.CloseHandle(handle):
                    close_errors.append(ctypes.WinError(ctypes.get_last_error()))

            releaser = threading.Thread(target=release_handle, daemon=True)
            releaser.start()

            def delete_locked_file():
                calls.append(1)
                try:
                    target.unlink()
                except OSError as error:
                    observed_errors.append(error.winerror)
                    first_failure.set()
                    raise

            try:
                install._retry_windows_file_operation(
                    delete_locked_file, attempts=8, delay=0.05,
                )
            finally:
                first_failure.set()
                releaser.join(timeout=5)

            self.assertFalse(releaser.is_alive())
            self.assertEqual(close_errors, [])
            self.assertTrue(observed_errors)
            self.assertIn(observed_errors[0], {5, 32, 33})
            self.assertGreaterEqual(len(calls), 2)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
