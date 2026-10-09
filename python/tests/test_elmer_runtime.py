"""The managed Elmer package: pinned download, verification, unpacking and discovery (no network)."""
import hashlib
import io
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from fairbeam import elmer_runtime


def fake_zip(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


GOOD = {"Pkg/bin/ElmerSolver.exe": b"solver", "Pkg/bin/ElmerGrid.exe": b"grid",
        "Pkg/share/elmersolver/license_texts/GPL-2.txt": b"GPL"}


class ManagedElmer(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / "state"
        env = mock.patch.dict(os.environ, {"FAIRBEAM_STATE_DIR": str(self.state)})
        env.start()
        self.addCleanup(env.stop)
        elmer_runtime._progress.update(state="idle", received=0, error="")

    def pin(self, payload, **overrides):
        archive = Path(self.tmp.name) / "pkg.zip"
        archive.write_bytes(payload)
        values = {"platform": sys.platform, "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
                  "top": "Pkg", "url": archive.as_uri(), **overrides}
        patcher = mock.patch.dict(elmer_runtime.PIN, values)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_installs_verified_package_into_the_state_folder(self):
        self.pin(fake_zip(GOOD))
        self.assertFalse(elmer_runtime.installed())
        status = elmer_runtime.install()
        self.assertTrue(status["installed"])
        self.assertEqual(status["state"], "done")
        home = elmer_runtime.home()
        self.assertEqual(home, self.state / "elmer" / elmer_runtime.PIN["version"])
        self.assertEqual((home / "bin" / "ElmerSolver.exe").read_bytes(), b"solver")
        self.assertTrue((home / "share/elmersolver/license_texts/GPL-2.txt").is_file())
        self.assertEqual([p.name for p in home.parent.iterdir()], [home.name], "no staging leftovers")
        self.assertTrue(elmer_runtime.install()["installed"], "a second install keeps the existing one")

    def test_wrong_checksum_installs_nothing(self):
        self.pin(fake_zip(GOOD), sha256="0" * 64)
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            elmer_runtime.install()
        self.assertFalse(elmer_runtime.installed())
        self.assertEqual(elmer_runtime.status()["state"], "failed")
        self.assertEqual(list((self.state / "elmer").iterdir()), [], "a failed attempt leaves nothing behind")

    def test_oversized_download_is_refused(self):
        payload = fake_zip(GOOD)
        self.pin(payload, size=len(payload) - 1)
        with self.assertRaisesRegex(ValueError, "larger than the pinned"):
            elmer_runtime.install()
        self.assertFalse(elmer_runtime.installed())

    def test_paths_outside_the_package_are_refused(self):
        self.pin(fake_zip({**GOOD, "Pkg/../evil.txt": b"x"}))
        with self.assertRaisesRegex(ValueError, "unexpected path"):
            elmer_runtime.install()
        self.assertFalse((self.state / "elmer" / "evil.txt").exists())
        self.assertFalse(elmer_runtime.installed())

    def test_missing_executable_is_refused(self):
        self.pin(fake_zip({"Pkg/bin/ElmerSolver.exe": b"solver"}))
        with self.assertRaisesRegex(ValueError, "ElmerGrid"):
            elmer_runtime.install()

    def test_other_platforms_are_told_to_install_elmer_themselves(self):
        self.pin(fake_zip(GOOD), platform="not-this-platform")
        with self.assertRaisesRegex(OSError, "Windows x64 only"):
            elmer_runtime.install()
        with self.assertRaises(OSError):
            elmer_runtime.start_install()
        self.assertFalse(elmer_runtime.status()["supported"])

    @unittest.skipUnless(os.name == "nt", "the managed package holds Windows executables")
    def test_research_falls_back_to_the_managed_package(self):
        import fairbeam_elmer
        from fairbeam import research
        self.pin(fake_zip(GOOD))
        elmer_runtime.install()
        with mock.patch.dict(os.environ, {"FAIRBEAM_ELMER_ROOT": ""}), mock.patch("shutil.which", return_value=None):
            root = research.elmer_root("")
            home, solver, grid = fairbeam_elmer.discover(root)
        self.assertEqual(Path(home), elmer_runtime.home().resolve())
        self.assertEqual(solver.name, "ElmerSolver.exe")
        self.assertEqual(grid.name, "ElmerGrid.exe")

    def test_explicit_choices_win_over_the_managed_package(self):
        from fairbeam import research
        self.pin(fake_zip(GOOD))
        elmer_runtime.install()
        self.assertEqual(research.elmer_root("C:/own/elmer"), "C:/own/elmer")
        with mock.patch.dict(os.environ, {"FAIRBEAM_ELMER_ROOT": "D:/env/elmer"}):
            self.assertEqual(research.elmer_root(""), "")  # discover() then reads the variable
        with mock.patch.dict(os.environ, {"FAIRBEAM_ELMER_ROOT": ""}), mock.patch("shutil.which", return_value="C:/path/ElmerSolver.exe"):
            self.assertEqual(research.elmer_root(""), "")  # Elmer on PATH

    def test_no_package_leaves_the_path_unchanged(self):
        from fairbeam import research
        with mock.patch.dict(os.environ, {"FAIRBEAM_ELMER_ROOT": ""}), mock.patch("shutil.which", return_value=None):
            self.assertEqual(research.elmer_root(""), "")


if __name__ == "__main__":
    unittest.main()
