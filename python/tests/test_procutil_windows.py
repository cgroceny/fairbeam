"""Native Windows handle-width checks for process liveness probes."""

import ctypes
from ctypes import wintypes
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock


PROCUTIL_PATH = Path(__file__).resolve().parents[1] / "fairbeam" / "procutil.py"
SPEC = importlib.util.spec_from_file_location("fairbeam_procutil_windows_test", PROCUTIL_PATH)
procutil = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(procutil)

LARGE_HANDLE = 0x1234567887654321


def fake_kernel32(handle, query_succeeds=True):
    """Expose callback addresses as raw WinDLL function pointers.

    A WINFUNCTYPE callback has a fixed prototype and would coerce HANDLE
    arguments even if pid_alive forgot to set argtypes. WinDLL's raw _FuncPtr
    starts without argtypes, just like a real kernel32 export.
    """
    raw_function = ctypes.WinDLL("kernel32")._FuncPtr
    calls = {"open": [], "query": [], "close": []}

    @ctypes.WINFUNCTYPE(wintypes.HANDLE, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    def open_process(access, inherit, pid):
        calls["open"].append((access, inherit, pid))
        return handle

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    def get_exit_code(actual_handle, code):
        calls["query"].append(actual_handle)
        if query_succeeds:
            code[0] = 259  # STILL_ACTIVE
            return 1
        return 0

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HANDLE)
    def close_handle(actual_handle):
        calls["close"].append(actual_handle)
        return 1

    callbacks = (open_process, get_exit_code, close_handle)
    raw = [raw_function(ctypes.cast(callback, ctypes.c_void_p).value)
           for callback in callbacks]
    kernel32 = SimpleNamespace(OpenProcess=raw[0], GetExitCodeProcess=raw[1],
                               CloseHandle=raw[2], callbacks=callbacks)
    return kernel32, calls


@unittest.skipUnless(sys.platform == "win32" and ctypes.sizeof(ctypes.c_void_p) == 8,
                     "requires 64-bit Windows")
class PidAliveNativeHandles(unittest.TestCase):
    def test_large_handle_reaches_query_and_close(self):
        kernel32, calls = fake_kernel32(LARGE_HANDLE)
        self.assertIsNone(kernel32.GetExitCodeProcess.argtypes)
        self.assertIsNone(kernel32.CloseHandle.argtypes)

        with mock.patch.object(ctypes, "WinDLL", return_value=kernel32):
            self.assertTrue(procutil.pid_alive(4242))

        self.assertEqual(calls["open"], [(0x1000, 0, 4242)])
        self.assertEqual(calls["query"], [LARGE_HANDLE])
        self.assertEqual(calls["close"], [LARGE_HANDLE])

    def test_failed_query_still_closes_large_handle(self):
        kernel32, calls = fake_kernel32(LARGE_HANDLE, query_succeeds=False)

        with mock.patch.object(ctypes, "WinDLL", return_value=kernel32):
            self.assertFalse(procutil.pid_alive(4242))

        self.assertEqual(calls["query"], [LARGE_HANDLE])
        self.assertEqual(calls["close"], [LARGE_HANDLE])

    def test_failed_open_reports_access_denied_as_alive_only(self):
        for winerror, expected in ((5, True), (87, False)):
            with self.subTest(winerror=winerror):
                kernel32, calls = fake_kernel32(0)
                with mock.patch.object(ctypes, "WinDLL", return_value=kernel32), \
                        mock.patch.object(ctypes, "get_last_error", return_value=winerror):
                    self.assertIs(procutil.pid_alive(4242), expected)
                self.assertEqual(calls["open"], [(0x1000, 0, 4242)])
                self.assertEqual(calls["query"], [])
                self.assertEqual(calls["close"], [])


if __name__ == "__main__":
    unittest.main()
