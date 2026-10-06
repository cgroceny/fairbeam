"""Linux installer preflight must reject invalid venvs before native-file writes."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


INSTALLER = Path(__file__).resolve().parents[2] / "scripts" / "install-openems-linux.sh"


@unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("bash"), "requires Linux and bash")
class LinuxInstallerPreflight(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fairbeam linux preflight ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.prefix = self.root / "runtime"
        self.src = self.root / "sources"
        self.trace = self.root / "native-commands.log"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("git", "cmake", "make", "test-cc", "test-cxx"):
            path = self.bin / name
            path.write_text('#!/bin/sh\nprintf "%s\\n" "$0" >> "$TRACE_FILE"\n', encoding="utf-8")
            path.chmod(0o755)

    def run_installer(self, *args):
        env = dict(os.environ, PREFIX=str(self.prefix), SRC=str(self.src), PYTHON=sys.executable,
                   JOBS="2", CC="test-cc", CXX="test-cxx", TRACE_FILE=str(self.trace),
                   PATH=str(self.bin) + os.pathsep + os.environ.get("PATH", ""))
        return subprocess.run(["bash", str(INSTALLER), *args], env=env, cwd=self.root,
                              capture_output=True, text=True, timeout=20)

    def assert_rejected_before_mutation(self):
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.trace.exists(), result.stdout + result.stderr)
        self.assertFalse(self.src.exists(), result.stdout + result.stderr)

    def test_invalid_venv_directory_is_not_modified(self):
        venv = self.prefix / "venv"
        venv.mkdir(parents=True)
        marker = venv / "keep.txt"
        marker.write_text("existing user data", encoding="utf-8")
        self.assert_rejected_before_mutation()
        self.assertEqual(marker.read_text(encoding="utf-8"), "existing user data")

    def test_file_instead_of_venv_is_not_modified(self):
        self.prefix.mkdir()
        venv = self.prefix / "venv"
        venv.write_text("existing file", encoding="utf-8")
        self.assert_rejected_before_mutation()
        self.assertEqual(venv.read_text(encoding="utf-8"), "existing file")

    def test_system_interpreter_is_not_treated_as_venv(self):
        bin_dir = self.prefix / "venv" / "bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "python").symlink_to(getattr(sys, "_base_executable", sys.executable))
        self.assert_rejected_before_mutation()

    def test_check_missing_prefix_creates_nothing(self):
        result = self.run_installer("--check")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.prefix.exists())
        self.assertFalse(self.src.exists())
        self.assertFalse(self.trace.exists())

    def test_build_cache_for_another_prefix_is_rejected(self):
        build = self.src / "build-linux-fparser"
        build.mkdir(parents=True)
        cache = build / "CMakeCache.txt"
        original = "CMAKE_INSTALL_PREFIX:PATH=/previous/runtime\n"
        cache.write_text(original, encoding="utf-8")
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.trace.exists(), result.stdout + result.stderr)
        self.assertFalse(self.prefix.exists())
        self.assertEqual(cache.read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
