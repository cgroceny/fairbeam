"""Contract checks for the standalone kernel runner, without a compiler or EM solve."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock
from unittest.mock import patch

SCRIPT = Path(__file__).parent / "native-bloch" / "run_native_tests.py"
SPEC = importlib.util.spec_from_file_location("native_bloch_runner", SCRIPT)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class NativeBlochRunnerTests(unittest.TestCase):
    def valid(self) -> dict:
        return {"schema": 1, "status": "passed", "groups": 9, "checks": 186034,
                "max_scaled_error": 2.7e-15, "native_openems_support": False,
                "physical_validation": False}

    def test_requires_narrow_kernel_contract(self) -> None:
        self.assertEqual(runner.parse_native_result(json.dumps(self.valid())), self.valid())
        for key, value in (("physical_validation", True), ("native_openems_support", True),
                           ("max_scaled_error", 2e-12), ("max_scaled_error", float("nan")),
                           ("groups", 8), ("checks", True), ("status", "failed")):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                data = self.valid()
                data[key] = value
                runner.parse_native_result(json.dumps(data))

    def test_existing_evidence_directory_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            marker = directory / "marker.txt"
            marker.write_text("retained", encoding="utf-8")
            with patch.object(runner.subprocess, "Popen") as command:
                with self.assertRaises(FileExistsError):
                    runner.run_study(directory)
                command.assert_not_called()
            self.assertEqual(marker.read_text(encoding="utf-8"), "retained")

    def test_resource_cap_before_creating_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "new"
            for jobs in (0, 3, -1):
                with self.subTest(jobs=jobs), self.assertRaises(ValueError):
                    runner.run_study(directory, jobs=jobs)
            self.assertFalse(directory.exists())

    def test_missing_tool_retains_failed_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "new"
            with patch.object(runner.subprocess, "Popen", side_effect=FileNotFoundError("synthetic missing cmake")):
                with self.assertRaises(FileNotFoundError):
                    runner.run_study(directory)
            report = json.loads((directory / "report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "failed")
            self.assertFalse(report["physical_validation"])
            self.assertTrue(report["source_sha256"])
            frozen_runner = directory / "source" / SCRIPT.name
            self.assertEqual(frozen_runner.read_bytes(), SCRIPT.read_bytes())
            self.assertEqual(report["source_sha256"][str(SCRIPT.relative_to(runner.REPOSITORY)).replace("\\", "/")],
                             runner.sha256(frozen_runner))

    def test_timeout_preserves_diagnostics_and_stops_own_windows_process_tree(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "new"
            process = MagicMock()
            process.pid = 12345
            process.returncode = -9
            process.poll.return_value = -9
            process.communicate.side_effect = [runner.subprocess.TimeoutExpired("cmake", 120),
                                               ("retained output", "retained diagnostics")]
            with patch.object(runner.sys, "platform", "win32"), \
                 patch.object(runner.subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True), \
                 patch.object(runner.subprocess, "Popen", return_value=process) as launch, \
                 patch.object(runner.subprocess, "run", return_value=MagicMock(returncode=0)) as cleanup:
                with self.assertRaises(runner.subprocess.TimeoutExpired):
                    runner.run_study(directory)
            self.assertEqual(launch.call_args.kwargs["creationflags"], 0x08000000)
            self.assertEqual(cleanup.call_args.args[0], ["taskkill", "/PID", "12345", "/T", "/F"])
            report = json.loads((directory / "report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "failed")
            self.assertEqual(report["commands"][0]["status"], "timed_out")
            self.assertEqual((directory / "cmake-version.stdout.txt").read_text(encoding="utf-8"), "retained output")

    def test_taskkill_timeout_falls_back_to_child_kill_and_retains_logs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "new"
            process = MagicMock()
            process.pid = 12345
            process.returncode = -9
            process.poll.return_value = None
            process.communicate.side_effect = [runner.subprocess.TimeoutExpired("cmake", 120),
                                               ("retained output", "retained diagnostics")]
            taskkill_timeout = runner.subprocess.TimeoutExpired("taskkill", 10)
            with patch.object(runner.sys, "platform", "win32"), \
                 patch.object(runner.subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True), \
                 patch.object(runner.subprocess, "Popen", return_value=process), \
                 patch.object(runner.subprocess, "run", side_effect=taskkill_timeout):
                with self.assertRaises(runner.subprocess.TimeoutExpired):
                    runner.run_study(directory)
            process.kill.assert_called_once()
            self.assertEqual((directory / "cmake-version.stdout.txt").read_text(encoding="utf-8"),
                             "retained output")
            report = json.loads((directory / "report.json").read_text(encoding="utf-8"))
            command = report["commands"][0]
            self.assertEqual(report["status"], "failed")
            self.assertEqual(command["status"], "timed_out")
            self.assertTrue(command["process_tree_cleanup_attempted"])
            self.assertIn("taskkill: TimeoutExpired", command["process_cleanup_errors"][0])

    def test_keyboard_interrupt_terminates_and_records_interrupted_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "new"
            process = MagicMock()
            process.pid = 12345
            process.returncode = -9
            process.poll.return_value = -9
            process.communicate.side_effect = [KeyboardInterrupt(), ("partial output", "partial error")]
            with patch.object(runner.sys, "platform", "win32"), \
                 patch.object(runner.subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True), \
                 patch.object(runner.subprocess, "Popen", return_value=process), \
                 patch.object(runner.subprocess, "run", return_value=MagicMock(returncode=0)):
                with self.assertRaises(KeyboardInterrupt):
                    runner.run_study(directory)
            report = json.loads((directory / "report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "interrupted")
            self.assertEqual(report["commands"][0]["status"], "interrupted")
            self.assertTrue(report["commands"][0]["process_tree_cleanup_attempted"])
            self.assertEqual((directory / "cmake-version.stdout.txt").read_text(encoding="utf-8"),
                             "partial output")
            self.assertEqual((directory / "cmake-version.stderr.txt").read_text(encoding="utf-8"),
                             "partial error")

    def test_posix_tree_cleanup_error_falls_back_to_child_kill(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "new"
            process = MagicMock()
            process.pid = 12345
            process.returncode = -9
            process.poll.return_value = None
            process.communicate.side_effect = [runner.subprocess.TimeoutExpired("cmake", 120),
                                               ("retained output", "retained diagnostics")]
            with patch.object(runner.sys, "platform", "linux"), \
                 patch.object(runner.subprocess, "Popen", return_value=process), \
                 patch.object(runner.signal, "SIGKILL", 9, create=True) as sigkill, \
                 patch.object(runner.os, "killpg", side_effect=PermissionError("synthetic denied"),
                              create=True) as killpg:
                with self.assertRaises(runner.subprocess.TimeoutExpired):
                    runner.run_study(directory)
            killpg.assert_called_once_with(12345, sigkill)
            process.kill.assert_called_once()
            report = json.loads((directory / "report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["commands"][0]["status"], "timed_out")
            self.assertIn("killpg: PermissionError", report["commands"][0]["process_cleanup_errors"][0])
            self.assertEqual((directory / "cmake-version.stderr.txt").read_text(encoding="utf-8"),
                             "retained diagnostics")


if __name__ == "__main__":
    unittest.main()
