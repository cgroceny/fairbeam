"""Host resources for runs: Auto thread count, a memory preflight and measured throughput.

Policy (see docs/BENCHMARKS.md "Threads"): openEMS's CPU engine is memory-bound and scales
poorly past a few threads on small grids (7900X: 4 -> 24 threads gave 0.6x to 2.4x, below 1x
on several 0.2-0.5 M cell models). Auto therefore uses physical cores (not hyperthreads), keeps
one core free for the app when there are four or more, and caps the count by grid size.
Nothing here changes power, fan or firmware settings; thread limits are resource controls only.
"""

from __future__ import annotations

import json
import os
import platform
import statistics
import subprocess
import sys
from pathlib import Path

from . import linux_resources

BYTES_PER_CELL = 90            # rough CPU-engine footprint, not an exact peak
WARN_FRACTION = 0.60           # of free RAM
REFUSE_FRACTION = 0.90
GiB = 2 ** 30


def available_cpus() -> int:
    """Usable CPUs, limited by process affinity and visible Linux bandwidth quotas."""
    try:
        count = max(1, len(os.sched_getaffinity(0)))  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        if sys.platform == "win32":
            restricted = _windows_available_cpus()
            if restricted is not None:
                return restricted
        count = max(1, os.cpu_count() or 1)
    if sys.platform.startswith("linux"):
        quota = linux_resources.cpu_limit()
        if quota is not None:
            count = min(count, quota)
    return count


def _windows_available_cpus() -> int | None:
    """Process affinity on a single processor group; best effort for larger hosts.

    On >64-CPU Windows hosts an unrestricted primary-group mask does not describe
    all usable groups. Leave that case to the portable count rather than reporting
    the primary group as the entire machine. Never change the process affinity.
    """
    try:
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        current = kernel.GetCurrentProcess
        current.argtypes, current.restype = [], wintypes.HANDLE
        affinity = kernel.GetProcessAffinityMask
        affinity.argtypes = [wintypes.HANDLE, ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_size_t)]
        affinity.restype = wintypes.BOOL
        process_mask, system_mask = ctypes.c_size_t(), ctypes.c_size_t()
        if not affinity(current(), ctypes.byref(process_mask), ctypes.byref(system_mask)):
            return None
        if not process_mask.value:
            return None
        if (os.cpu_count() or 1) > 64 and process_mask.value == system_mask.value:
            return None
        return process_mask.value.bit_count()
    except (AttributeError, OSError, ValueError):
        return None


def physical_cores(logical: int | None = None) -> int:
    """Physical core count, best effort; never more than ``logical``. Unknown -> half the logical
    CPUs when there are more than two (assume SMT), else the logical count."""
    logical = logical or available_cpus()
    n = None
    try:
        if sys.platform == "darwin":
            n = int(subprocess.run(["sysctl", "-n", "hw.physicalcpu"], capture_output=True, text=True,
                                   timeout=2).stdout.strip() or 0)
        elif sys.platform.startswith("linux"):
            n = _linux_physical_cores()
        elif sys.platform == "win32":
            n = _windows_physical_cores()
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        n = None
    if not n or n < 1:
        n = logical // 2 if logical > 2 else logical
    return max(1, min(n, logical))


def _linux_physical_cores() -> int | None:
    """Count distinct socket/core pairs only for CPUs in this process's affinity.

    Incomplete topology is unknown, rather than a complete count of a partial file.
    Architectures without these cpuinfo fields keep the usual logical-count fallback.
    """
    try:
        affinity = os.sched_getaffinity(0)  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        affinity = None
    topology = {}
    record = {}
    for line in Path("/proc/cpuinfo").read_text().splitlines() + [""]:
        if line.strip():
            key, sep, value = line.partition(":")
            if sep:
                record[key.strip()] = value.strip()
            continue
        fields, record = record, {}
        if "processor" not in fields:
            continue
        try:
            processor = int(fields["processor"])
        except ValueError:
            return None
        if affinity is not None and processor not in affinity:
            continue
        try:
            pair = (int(fields["physical id"]), int(fields["core id"]))
        except (KeyError, ValueError):
            return None
        if processor < 0 or min(pair) < 0 or (processor in topology and topology[processor] != pair):
            return None
        topology[processor] = pair
    if affinity is not None and topology.keys() != affinity:
        return None
    return len(set(topology.values())) or None


def _windows_physical_cores() -> int | None:
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    size = wintypes.DWORD(0)
    k32.GetLogicalProcessorInformationEx(0, None, ctypes.byref(size))  # RelationProcessorCore
    buf = ctypes.create_string_buffer(size.value)
    if not k32.GetLogicalProcessorInformationEx(0, buf, ctypes.byref(size)):
        return None
    count, off = 0, 0
    while off + 8 <= size.value:
        rec = int.from_bytes(buf[off + 4:off + 8], "little")  # record size
        if rec <= 0:
            break
        count += 1
        off += rec
    return count or None


def auto_threads(logical: int, physical: int | None = None, cells: float | None = None) -> int:
    """The thread count "Auto" means for a host with ``logical`` usable CPUs and ``physical`` cores
    and a grid of ``cells`` (None: unknown, treated as small)."""
    logical = max(1, int(logical))
    physical = max(1, min(int(physical or logical), logical))
    if physical >= 4:
        n = physical - 1      # keep a core for the app
    elif physical <= 2:
        n = 1
    else:
        n = physical
    if not cells or cells < 500_000:
        cap = 4
    elif cells < 2_000_000:
        cap = 8
    else:
        cap = 12
    return max(1, min(n, cap, logical))


def free_memory_bytes() -> int | None:
    """Memory available to start a program without swapping, or None when it cannot be read."""
    try:
        if sys.platform.startswith("linux"):
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemAvailable:"):
                    fields = line.split()
                    if len(fields) != 3 or fields[2] != "kB":
                        return None
                    available = int(fields[1]) * 1024
                    if available < 0:
                        return None
                    headroom = linux_resources.memory_headroom()
                    return min(available, headroom) if headroom is not None else available
        elif sys.platform == "darwin":
            out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=2).stdout
            page = 4096
            counts = {}
            for line in out.splitlines():
                if "page size of" in line:
                    page = int(line.split("page size of")[1].split()[0])
                elif ":" in line:
                    k, v = line.split(":", 1)
                    counts[k.strip()] = int(v.strip().rstrip("."))
            pages = sum(counts.get(k, 0) for k in ("Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"))
            return pages * page or None
        elif sys.platform == "win32":
            import ctypes

            class Mem(ctypes.Structure):
                _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong),
                            ("avail", ctypes.c_ulonglong), ("tpf", ctypes.c_ulonglong), ("apf", ctypes.c_ulonglong),
                            ("tv", ctypes.c_ulonglong), ("av", ctypes.c_ulonglong), ("ave", ctypes.c_ulonglong)]
            m = Mem()
            m.length = ctypes.sizeof(Mem)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):  # type: ignore[attr-defined]
                return int(m.avail)
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        pass
    return None


def preflight(cells, engine: str = "cpu", free: int | None = None, busy: bool = False,
              load: float | None = None, cpus: int | None = None, external: int = 0) -> dict:
    """Estimate memory for ``cells`` and compare it with ``free`` bytes. Returns ``{"level":
    "ok"|"warn"|"refuse"|"unknown", "messages": [...], "estimate_bytes", "free_bytes"}``.

    The estimate (about 90 bytes per cell) is rough. CUDA keeps the fields in GPU memory, which is
    not read here: that case is "unknown", never counted against system RAM. The Metal engine
    uses unified memory, so the system-RAM figure applies once, not twice. Nothing is ever
    coarsened or relaxed; the run is either allowed or refused.

    ``busy``: the server is running another job (this one waits in its queue). ``external``: runs of
    ``fairbeam run`` started outside the server (simdata.live_runs); the queue does not wait for
    them, so both run at the same time."""
    out = {"level": "ok", "messages": [], "estimate_bytes": None, "free_bytes": free}
    if isinstance(cells, bool) or not isinstance(cells, (int, float)) or cells <= 0:
        out["level"] = "unknown"
        out["messages"].append("cells unknown: memory not checked")
        return out
    est = int(cells * BYTES_PER_CELL)
    out["estimate_bytes"] = est
    gb = est / GiB
    if engine == "gpu" and sys.platform != "darwin":
        out["level"] = "unknown"
        out["messages"].append(f"about {gb:.1f} GiB needed; GPU memory is not read, so this is not checked")
    elif free is None:
        out["level"] = "unknown"
        out["messages"].append(f"about {gb:.1f} GiB needed; free memory could not be read")
    elif est > REFUSE_FRACTION * free:
        out["level"] = "refuse"
        out["messages"].append(f"this mesh needs about {gb:.1f} GiB but only {free / GiB:.1f} GiB is free "
                               f"(over {REFUSE_FRACTION:.0%}). Close other programs or use a coarser mesh.")
    elif est > WARN_FRACTION * free:
        out["level"] = "warn"
        out["messages"].append(f"this mesh needs about {gb:.1f} GiB of {free / GiB:.1f} GiB free "
                               f"(over {WARN_FRACTION:.0%}); the machine may slow down or swap.")
    if busy:
        out["messages"].append("another run is using the CPU; this one waits in the queue")
        if out["level"] == "ok":
            out["level"] = "warn"
    if external:
        out["messages"].append(f"{external} run{'s' if external != 1 else ''} started outside the app "
                               "(fairbeam run in a terminal) "
                               f"{'are' if external != 1 else 'is'} using the CPU; this one does not wait for "
                               f"{'them' if external != 1 else 'it'}, so both will be slower")
        if out["level"] == "ok":
            out["level"] = "warn"
    if load is not None and cpus and load >= 0.9 * cpus:
        out["messages"].append(f"the machine is already busy (load {load:.1f} on {cpus} CPUs)")
        if out["level"] == "ok":
            out["level"] = "warn"
    return out


def host_load() -> float | None:
    try:
        return os.getloadavg()[0]
    except (AttributeError, OSError):
        return None


def measured_throughput(projects_dir: Path, host_cpu: str | None = None) -> dict:
    """Median MCells/s of this machine's past runs per engine ("cpu"/"gpu"), from index.json
    (``speed_mcells_s`` and ``host_cpu`` of newer indexes). ``{}`` when there are none."""
    try:
        entries = json.loads((Path(projects_dir) / "index.json").read_text(encoding="utf-8")).get("projects", [])
    except (OSError, ValueError, AttributeError):
        return {}
    speeds: dict[str, list[float]] = {}
    for e in sorted((e for e in entries if isinstance(e, dict)), key=lambda e: str(e.get("created") or "")):
        s = e.get("speed_mcells_s")
        if not isinstance(s, (int, float)) or isinstance(s, bool) or s <= 0:
            continue
        if host_cpu and e.get("host_cpu") and e["host_cpu"] != host_cpu:
            continue
        speeds.setdefault("cpu" if e.get("engine") == "CPU" else "gpu", []).append(float(s))
    return {k: {"mcells_s": round(statistics.median(v[-10:]), 1), "runs": len(v[-10:])} for k, v in speeds.items()}


def host_cpu_name() -> str | None:
    try:
        from .simulation import _cpu_name
        return _cpu_name() or platform.processor() or None
    except Exception:
        return platform.processor() or None
