"""Read-only Linux cgroup limits. Missing/unreadable controls are not invented.

Resolve this process' hierarchy through mountinfo rather than assuming /sys/fs/cgroup.
All visible ancestors constrain a cgroup; limits above a delegated mount are not visible.
"""

from __future__ import annotations

import re
from pathlib import Path, PurePosixPath


def _read(path: Path) -> str | None:
    try:
        return path.read_text()
    except (OSError, ValueError):
        return None


def _unescape(value: str) -> str:
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), value)


def _directories(controller: str):
    """Yield (directory, is_v2, is_leaf), stopping at the visible mount root."""
    memberships = {}
    for line in (_read(Path("/proc/self/cgroup")) or "").splitlines():
        fields = line.split(":", 2)
        if len(fields) == 3 and fields[0].isdigit() and (fields[1] or fields[0] == "0"):
            for name in fields[1].split(","):
                # Unlike mountinfo, /proc/self/cgroup does not octal-escape paths.
                memberships[name] = fields[2]
    seen = set()
    for line in (_read(Path("/proc/self/mountinfo")) or "").splitlines():
        before, sep, after = line.partition(" - ")
        fields, tail = before.split(), after.split()
        if not sep or len(fields) < 6 or len(tail) < 3:
            continue
        v2 = tail[0] == "cgroup2"
        if not v2 and (tail[0] != "cgroup" or controller not in tail[2].split(",")):
            continue
        member = memberships.get("" if v2 else controller)
        if member is None:
            continue
        own, root = PurePosixPath(member), PurePosixPath(_unescape(fields[3]))
        mount = Path(_unescape(fields[4]))
        if not own.is_absolute() or not root.is_absolute() or not mount.is_absolute():
            continue
        if ".." in own.parts or ".." in root.parts or ".." in mount.parts:
            continue
        try:
            relative = own.relative_to(root)
        except ValueError:
            # Both proc files are relative to the reader's cgroup namespace.
            # An unrelated subtree mount is not evidence of our own limits.
            continue
        directory = mount / relative
        leaf = True
        while True:
            key = (str(directory), v2)
            if key not in seen:
                seen.add(key)
                yield directory, v2, leaf
            if directory == mount:
                break
            directory = directory.parent
            leaf = False


def cpu_limit() -> int | None:
    """Tightest visible CPU bandwidth quota, rounded up to at least one worker."""
    limits = []
    for directory, v2, _ in _directories("cpu"):
        try:
            if v2:
                fields = (_read(directory / "cpu.max") or "").split()
                if len(fields) != 2 or fields[0] == "max":
                    continue
                quota, period = map(int, fields)
            else:
                quota = int(_read(directory / "cpu.cfs_quota_us") or "")
                period = int(_read(directory / "cpu.cfs_period_us") or "")
            if quota > 0 and period > 0:
                limits.append((quota + period - 1) // period)
        except ValueError:
            continue
    return min(limits) if limits else None


def memory_headroom() -> int | None:
    """Conservative bytes below visible hard RAM limits, without counting swap.

    This deliberately does not add reclaimable cache back: headroom is a resource
    ceiling, not a prediction of allocations or a replacement for host MemAvailable.
    """
    limits = []
    for directory, v2, leaf in _directories("memory"):
        if not v2 and not leaf and (_read(directory / "memory.use_hierarchy") or "").strip() == "0":
            continue
        maximum = (_read(directory / ("memory.max" if v2 else "memory.limit_in_bytes")) or "").strip()
        current = _read(directory / ("memory.current" if v2 else "memory.usage_in_bytes"))
        if maximum in ("", "max") or current is None:
            continue
        try:
            maximum, current = int(maximum), int(current)
        except ValueError:
            continue
        if maximum >= 0 and current >= 0:
            limits.append(max(0, maximum - current))
    return min(limits) if limits else None
