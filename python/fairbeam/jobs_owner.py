"""Exclusive local jobs-directory ownership for a server, before orphan recovery.

The persistent file is never removed: unlinking a held lock could create two owners.
The kernel releases the non-inherited descriptor on close/process exit, so stale files
need no PID-based deletion or takeover.
"""
from __future__ import annotations

import errno
import os
from pathlib import Path


class WorkspaceInUse(ValueError):
    """A live process already owns this jobs directory."""


class JobsOwner:
    def __init__(self, jobs_dir: str | Path):
        self.root = Path(jobs_dir).resolve()
        self.fd: int | None = None

    def __enter__(self):
        try:
            self.root.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise ValueError(f"Cannot prepare jobs-directory ownership at {self.root}: {error}") from error
        path = self.root / ".server-owner.lock"
        try:
            fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        except OSError as error:
            raise ValueError(f"Cannot open jobs-directory ownership file {path}: {error}") from error
        try:
            os.set_inheritable(fd, False)
            if os.name == "nt":
                import msvcrt
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # Windows byte-range locking permits a range beyond EOF. Initialize only
            # after acquisition, so a contender never writes into an owner's lock.
            if os.fstat(fd).st_size == 0:
                os.write(fd, b"\0")
        except OSError as error:
            os.close(fd)
            if error.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                raise WorkspaceInUse(f"workspace_in_use: another Fairbeam server owns jobs directory {self.root}. Close that server or use a different workspace.") from error
            raise ValueError(f"Cannot acquire jobs-directory ownership at {path}: {error}") from error
        except BaseException:
            os.close(fd)
            raise
        self.fd = fd
        return self

    def __exit__(self, *_):
        if self.fd is not None:
            fd, self.fd = self.fd, None
            os.close(fd)  # closes the lease even when its owner is interrupted
