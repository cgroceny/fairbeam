"""The macOS default for the native CPU patches (fairbeam/__init__.py, docs/CPU-OPTIMIZATION.md)."""

import os
import sys
import unittest
from unittest import mock

import fairbeam

NAMES = [n for n, _ in fairbeam._NATIVE_CPU_ENV]
EXPECTED = dict(fairbeam._NATIVE_CPU_ENV)


def clean_env(**extra):
    env = {k: v for k, v in os.environ.items() if k not in NAMES and k != "FAIRBEAM_NATIVE_CPU"}
    env.update(extra)
    return mock.patch.dict(os.environ, env, clear=True)


class NativeCpuDefault(unittest.TestCase):
    def test_variables_and_values(self):
        self.assertEqual(EXPECTED, {
            "OPENEMS_EXPERIMENTAL_CPU_PHASE_DISPATCH": "phase-lists",
            "OPENEMS_EXPERIMENTAL_CPU_UPML_CURSOR": "cursor",
            "OPENEMS_EXPERIMENTAL_CPU_UPML_ROWS": "rows",
        })

    def test_macos_sets_all_three(self):
        with clean_env(), mock.patch.object(sys, "platform", "darwin"):
            fairbeam._native_cpu_defaults()
            for name, value in EXPECTED.items():
                self.assertEqual(os.environ[name], value)
            note = fairbeam.native_cpu_note()
            self.assertIn("macOS default", note)
            self.assertIn("FAIRBEAM_NATIVE_CPU=0", note)

    def test_opt_out(self):
        for off in ("0", "off", "False", "no"):
            with clean_env(FAIRBEAM_NATIVE_CPU=off), mock.patch.object(sys, "platform", "darwin"):
                fairbeam._native_cpu_defaults()
                self.assertFalse(any(n in os.environ for n in NAMES), off)
                self.assertIsNone(fairbeam.native_cpu_note())

    def test_windows_and_linux_unchanged(self):
        for platform in ("win32", "linux"):
            with clean_env(), mock.patch.object(sys, "platform", platform):
                fairbeam._native_cpu_defaults()
                self.assertFalse(any(n in os.environ for n in NAMES), platform)
                self.assertIsNone(fairbeam.native_cpu_note())

    def test_user_values_are_kept(self):
        with clean_env(OPENEMS_EXPERIMENTAL_CPU_UPML_ROWS="off"), mock.patch.object(sys, "platform", "darwin"):
            fairbeam._native_cpu_defaults()
            self.assertEqual(os.environ["OPENEMS_EXPERIMENTAL_CPU_UPML_ROWS"], "off")
            self.assertEqual(os.environ["OPENEMS_EXPERIMENTAL_CPU_UPML_CURSOR"], "cursor")
            self.assertIsNone(fairbeam.native_cpu_note())  # not all three requested as validated

    def test_explicit_environment_without_default(self):
        with clean_env(**EXPECTED), mock.patch.object(sys, "platform", "win32"):
            self.assertIn("environment", fairbeam.native_cpu_note())


if __name__ == "__main__":
    unittest.main()
