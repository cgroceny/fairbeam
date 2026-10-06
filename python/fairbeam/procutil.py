"""Cross-platform process helpers for the run server: child processes in their own group, stopping
a whole process tree, and checking whether a pid is still alive.

POSIX: a new session (``start_new_session``), SIGTERM to the group, SIGKILL after a grace period.
Windows: a new process group (``CREATE_NEW_PROCESS_GROUP``) inside a job object (``popen_group``),
CTRL_BREAK_EVENT to the group (during a run openEMS' own console handler aborts the simulation and
``fairbeam run`` exits without a bundle; elsewhere Python has no handler for it and the default one
ends the process), then the job object is terminated, which stops every process the child
started, including ones whose parent already exited. The venv ``python.exe`` is only a
launcher that runs the real interpreter as its child, so every Python child is a tree of at least
two processes. Without a job object, ``taskkill /T /F`` after the grace period.

Never ``os.kill(pid, 0)`` on Windows to probe a pid: any signal other than CTRL_C/CTRL_BREAK is
``TerminateProcess`` there.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time

WINDOWS = sys.platform == "win32"


def new_group_kwargs() -> dict:
    """``subprocess.Popen`` keyword arguments that put the child in its own process group."""
    if WINDOWS:
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


class WinJob:
    """A Windows job object that kills its processes when it is terminated or closed, and when the
    server itself dies (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: the last handle closes with it)."""

    def __init__(self):
        import ctypes
        from ctypes import wintypes

        k32 = self._k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
        k32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
        k32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        k32.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        k32.CloseHandle.argtypes = (wintypes.HANDLE,)

        class BASIC(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                        ("SchedulingClass", wintypes.DWORD)]

        class EXTENDED(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BASIC), ("IoInfo", ctypes.c_uint64 * 6),
                        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        self._lock = threading.Lock()
        self._handle = k32.CreateJobObjectW(None, None)
        if not self._handle:
            raise ctypes.WinError(ctypes.get_last_error())
        info = EXTENDED()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(self._handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
            err = ctypes.get_last_error()
            self.close()
            raise ctypes.WinError(err)  # 9: JobObjectExtendedLimitInformation

    def assign(self, pid: int) -> bool:
        PROCESS_TERMINATE, PROCESS_SET_QUOTA = 0x0001, 0x0100
        h = self._k32.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, False, pid)
        if not h:
            return False
        try:
            with self._lock:
                return bool(self._handle) and bool(self._k32.AssignProcessToJobObject(self._handle, h))
        finally:
            self._k32.CloseHandle(h)

    def terminate(self, exit_code: int = 1) -> None:
        """Stop every process still in the job (a no-op once closed: the handle may be reused)."""
        with self._lock:
            if self._handle:
                self._k32.TerminateJobObject(self._handle, exit_code)

    def close(self) -> None:
        """Release the job; processes still in it are killed (KILL_ON_JOB_CLOSE)."""
        with self._lock:
            h, self._handle = self._handle, None
            if h:
                self._k32.CloseHandle(h)


def _resume_process(pid: int) -> bool:
    import ctypes
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    ntdll = ctypes.WinDLL("ntdll")
    ntdll.NtResumeProcess.argtypes = (wintypes.HANDLE,)
    ntdll.NtResumeProcess.restype = ctypes.c_long
    h = k32.OpenProcess(0x0800, False, pid)  # PROCESS_SUSPEND_RESUME
    if not h:
        return False
    try:
        return ntdll.NtResumeProcess(h) == 0
    finally:
        k32.CloseHandle(h)


def popen_group(args, **kwargs) -> subprocess.Popen:
    """``subprocess.Popen`` with the child in its own process group (``new_group_kwargs``).

    Windows: the child is started suspended, put into a new ``WinJob`` (``proc.win_job``, None when
    that failed) and only then resumed, so every process it starts belongs to the job as well. Pass
    ``proc.win_job`` to ``terminate_group`` and call ``release_group(proc)`` once the child exited.
    """
    if not WINDOWS:
        proc = subprocess.Popen(args, **kwargs, **new_group_kwargs())
        proc.win_job = None
        return proc
    CREATE_SUSPENDED = 0x00000004
    flags = kwargs.pop("creationflags", 0) | subprocess.CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED
    proc = subprocess.Popen(args, creationflags=flags, **kwargs)
    job = None
    try:
        job = WinJob()
        if not job.assign(proc.pid):
            job.close()
            job = None
    except OSError:
        job = None
    finally:
        if not _resume_process(proc.pid):  # never leave a suspended child behind
            proc.kill()
            proc.wait()
            if job is not None:
                job.close()
            raise OSError(f"could not resume the child process {proc.pid}")
    proc.win_job = job
    return proc


def release_group(proc: subprocess.Popen) -> None:
    """After ``proc`` (from ``popen_group``) exited: Windows closes its job object, which also
    stops anything it left running. POSIX: nothing to do."""
    job = getattr(proc, "win_job", None)
    if job is not None:
        job.close()


def pid_alive(pid: int) -> bool:
    """True when a process with this pid exists (it may belong to another user)."""
    if pid <= 0:
        return False
    if WINDOWS:
        import ctypes
        from ctypes import wintypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        k32.CloseHandle.argtypes = (wintypes.HANDLE,)
        h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return ctypes.get_last_error() == 5  # ERROR_ACCESS_DENIED: exists, not ours
        try:
            code = wintypes.DWORD()
            ok = k32.GetExitCodeProcess(h, ctypes.byref(code))
            return bool(ok) and code.value == STILL_ACTIVE
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def windows_process_info(pid: int) -> dict | None:
    """``{"start": epoch seconds, "command": command line}`` of a running Windows process, else
    None (gone, exited, or not ours to query). ctypes only: GetProcessTimes for the creation time,
    NtQueryInformationProcess(ProcessCommandLineInformation) for the command line (Windows 8.1+;
    "" when that is unavailable)."""
    if not WINDOWS or pid <= 0:
        return None
    import ctypes
    from ctypes import wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    k32.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(wintypes.FILETIME),) * 4
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return None
    try:
        code = wintypes.DWORD()
        if not k32.GetExitCodeProcess(h, ctypes.byref(code)) or code.value != STILL_ACTIVE:
            return None
        times = [wintypes.FILETIME() for _ in range(4)]
        if not k32.GetProcessTimes(h, *(ctypes.byref(t) for t in times)):
            return None
        ticks = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime  # 100 ns since 1601
        start = (ticks - 116444736000000000) / 1e7

        class UNICODE_STRING(ctypes.Structure):
            _fields_ = [("Length", wintypes.USHORT), ("MaximumLength", wintypes.USHORT),
                        ("Buffer", ctypes.c_void_p)]

        command = ""
        try:
            ntdll = ctypes.WinDLL("ntdll")
            query = ntdll.NtQueryInformationProcess
            query.restype = ctypes.c_long
            query.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.ULONG,
                              ctypes.POINTER(wintypes.ULONG))
            size = wintypes.ULONG(0)
            query(h, 60, None, 0, ctypes.byref(size))  # ProcessCommandLineInformation: needed size
            if size.value:
                buf = ctypes.create_string_buffer(size.value)
                if query(h, 60, buf, size.value, ctypes.byref(size)) == 0:
                    us = UNICODE_STRING.from_buffer(buf)
                    if us.Buffer and us.Length:
                        command = ctypes.wstring_at(us.Buffer, us.Length // 2)
        except (OSError, AttributeError, ValueError):
            pass
        return {"start": start, "command": command}
    finally:
        k32.CloseHandle(h)


def kill_tree(pid: int) -> None:
    """Force-stop ``pid`` and all its descendants at once (Windows: ``taskkill /T /F``; POSIX:
    SIGKILL to the process group ``pid`` leads)."""
    if WINDOWS:
        try:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True, timeout=15,
                           stdin=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            pass
        return
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def terminate_group(pid: int, grace: float = 5.0, wait=None, job: WinJob | None = None) -> None:
    """Ask the process group led by ``pid`` to stop, force it after ``grace`` seconds.

    ``wait(timeout) -> bool`` reports whether the leader exited (e.g. ``Popen.wait``); without it
    the pid is polled. ``job`` (Windows, ``popen_group``): terminated after the leader exited or the
    grace period ran out, so processes that missed the CTRL_BREAK (started just after it, or whose
    parent is a launcher that ignores it) are stopped too.
    """
    def exited(timeout: float) -> bool:
        if wait is not None:
            return wait(timeout)
        end = time.time() + timeout
        while time.time() < end:
            if not pid_alive(pid):
                return True
            time.sleep(0.1)
        return not pid_alive(pid)

    if WINDOWS:
        try:
            os.kill(pid, signal.CTRL_BREAK_EVENT)  # the whole console process group
        except (OSError, ValueError):
            pass
        leader_exited = exited(grace)
        if job is not None:
            job.terminate()
        elif not leader_exited:
            kill_tree(pid)
        return
    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        return
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    if not exited(grace):
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
