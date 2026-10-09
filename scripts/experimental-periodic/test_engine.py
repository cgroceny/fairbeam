import copy
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from engine import check_capabilities, validate_capabilities

CAPS = {"schema": 1, "backend": "fairbeam-periodic-cpu", "revision": 4,
        "boundary": "PERIODIC_TEST", "phase": "zero", "axes": "xy",
        "engine": "basic", "geometry": "axis-aligned-boxes"}


class HandshakeTests(unittest.TestCase):
    def test_stock_or_different_physics_cannot_silently_run(self):
        for key in CAPS:
            value = copy.copy(CAPS)
            del value[key]
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_capabilities(value)
        for value in (None, [], {**CAPS, "phase": "bloch"}, {**CAPS, "engine": "gpu"}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_capabilities(value)
        self.assertEqual(validate_capabilities(CAPS), CAPS)

    def test_rejects_unrecognized_stdout_and_nonzero_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            exe = Path(tmp) / "engine"
            exe.touch()
            for result in (subprocess.CompletedProcess([], 0, "openEMS usage", ""),
                           subprocess.CompletedProcess([], 2, "{}", "")):
                with patch("engine.subprocess.run", return_value=result) as run:
                    with self.assertRaises(ValueError):
                        check_capabilities(exe)
                    self.assertEqual(run.call_args.args[0][1], "--fairbeam-periodic-capabilities")

    def test_missing_executable_does_not_launch(self):
        with tempfile.TemporaryDirectory() as tmp, patch("engine.subprocess.run") as run:
            with self.assertRaises(FileNotFoundError):
                check_capabilities(Path(tmp) / "missing")
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
