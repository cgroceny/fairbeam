"""Deterministic Linux resource probes: no dependency on the test host's cgroups."""

import contextlib
import sys
import unittest
from pathlib import Path, PurePosixPath
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fairbeam import linux_resources, resources  # noqa: E402


def mount(root="/", target="/cg", kind="cgroup2", options="rw"):
    def escape(value):
        return value.replace("\\", r"\134").replace(" ", r"\040").replace("\t", r"\011").replace("\n", r"\012")
    return f"31 20 0:28 {escape(root)} {escape(target)} rw,nosuid shared:8 - {kind} none {options}\n"


@contextlib.contextmanager
def files(contents):
    """Mock every read, including missing and denied files; never read the host."""
    def read(path, *args, **kwargs):
        result = contents.get(path.as_posix(), FileNotFoundError(str(path)))
        if isinstance(result, Exception):
            raise result
        return result
    class MockLinuxPath(PurePosixPath):
        # Model Linux path semantics on every test host, including literal backslashes.
        def read_text(self):
            return reads(self)

    with mock.patch.object(Path, "read_text", autospec=True, side_effect=read) as reads, \
            mock.patch.object(linux_resources, "Path", MockLinuxPath):
        yield reads


def v2(extra=None, member="/job", root="/", target="/cg"):
    result = {"/proc/self/cgroup": f"0::{member}\n", "/proc/self/mountinfo": mount(root, target)}
    result.update(extra or {})
    return result


def v1(extra=None, member="/job", root="/", target="/cg", controllers="cpu,cpuacct,memory"):
    result = {"/proc/self/cgroup": f"7:{controllers}:{member}\n",
              "/proc/self/mountinfo": mount(root, target, "cgroup", f"rw,{controllers}")}
    result.update(extra or {})
    return result


class CgroupCPU(unittest.TestCase):
    def test_v2_quotas_round_up_without_float_conversion(self):
        for value, expected in (("100000 100000", 1), ("150000 100000", 2), ("1 100000", 1),
                                (f"{2 ** 60 + 1} {2 ** 60}", 2), ("max 100000", None)):
            with self.subTest(value=value), files(v2({"/cg/job/cpu.max": value + "\n"})):
                self.assertEqual(linux_resources.cpu_limit(), expected)

    def test_v1_quota_and_unlimited(self):
        for quota, expected in (("250000", 3), ("-1", None), ("0", None)):
            with self.subTest(quota=quota), files(v1({"/cg/job/cpu.cfs_quota_us": quota,
                                                   "/cg/job/cpu.cfs_period_us": "100000"})):
                self.assertEqual(linux_resources.cpu_limit(), expected)

    def test_tightest_visible_ancestor_quota(self):
        data = v2({"/cg/group/job/cpu.max": "800000 100000", "/cg/group/cpu.max": "150000 100000",
                   "/cg/cpu.max": "400000 100000"}, member="/group/job")
        with files(data):
            self.assertEqual(linux_resources.cpu_limit(), 2)

    def test_unlimited_leaf_still_has_parent_quota(self):
        with files(v2({"/cg/job/cpu.max": "max 100000", "/cg/cpu.max": "100000 100000"})):
            self.assertEqual(linux_resources.cpu_limit(), 1)

    def test_malformed_v2_controls_do_not_hide_valid_ancestor(self):
        for value in ("", "broken", "1", "1 2 3", "1.5 100000", "-1 100000", "0 100000",
                      "100000 0", "100000 -1", "100000 nan", PermissionError(), UnicodeError()):
            with self.subTest(value=value), files(v2({"/cg/job/cpu.max": value,
                                                   "/cg/cpu.max": "200000 100000"})):
                self.assertEqual(linux_resources.cpu_limit(), 2)

    def test_malformed_or_missing_v1_period_is_unknown(self):
        for period in (None, "", "invalid", "0", "-1", PermissionError()):
            data = v1({"/cg/job/cpu.cfs_quota_us": "200000"})
            if period is not None:
                data["/cg/job/cpu.cfs_period_us"] = period
            with self.subTest(period=period), files(data):
                self.assertIsNone(linux_resources.cpu_limit())


class CgroupPaths(unittest.TestCase):
    def test_delegated_mount_root_and_no_reads_above_it(self):
        data = v2({"/limits/job/cpu.max": "400000 100000", "/limits/cpu.max": "200000 100000",
                   "/cpu.max": "100000 100000"}, member="/parent/job", root="/parent", target="/limits")
        with files(data) as reads:
            self.assertEqual(linux_resources.cpu_limit(), 2)
            self.assertNotIn(Path("/cpu.max"), [call.args[0] for call in reads.call_args_list])

    def test_namespace_root_and_child(self):
        for member in ("/", "/child"):
            with self.subTest(member=member), files(v2({"/limits/cpu.max": "150000 100000"},
                                                     member=member, target="/limits")):
                self.assertEqual(linux_resources.cpu_limit(), 2)

    def test_nonstandard_escaped_mount_and_raw_membership(self):
        # Cgroup membership paths are raw; only mountinfo uses octal escapes.
        root = "/parent with space"
        leaf = r"worker\040name:0"
        target = "/custom cgroups\twith\\slash"
        data = v2({f"{target}/{leaf}/cpu.max": "300000 100000"},
                  member=f"{root}/{leaf}", root=root, target=target)
        with files(data):
            self.assertEqual(linux_resources.cpu_limit(), 3)

    def test_trailing_space_in_membership_is_preserved(self):
        with files(v2({"/cg/job /cpu.max": "100000 100000"}, member="/job ")):
            self.assertEqual(linux_resources.cpu_limit(), 1)

    def test_unrelated_subtree_mounts_are_not_guessed(self):
        for member, root in (("/", "/other"), ("/parent2/job", "/parent"), ("/ours", "/other")):
            with self.subTest(member=member, root=root), files(v2({"/cg/cpu.max": "100000 100000"},
                                                                 member=member, root=root)):
                self.assertIsNone(linux_resources.cpu_limit())

    def test_ambiguous_or_unsafe_paths_are_not_followed(self):
        for member, root, target in (("/../job", "/", "/cg"), ("/job", "/..", "/cg"),
                                     ("/job", "/", "/cg/../elsewhere"), ("job", "/", "/cg"),
                                     ("/job", "relative", "/cg"), ("/job", "/", "relative")):
            with self.subTest(paths=(member, root, target)), files(v2({"/cg/cpu.max": "1 1"},
                                                                    member=member, root=root, target=target)):
                self.assertIsNone(linux_resources.cpu_limit())

    def test_separate_v1_controller_mounts(self):
        data = {"/proc/self/cgroup": "7:cpu,cpuacct:/work\n4:memory:/ram\n0::/unified\n",
                "/proc/self/mountinfo": mount(target="/cpu", kind="cgroup", options="rw,cpu,cpuacct")
                + mount(target="/memory", kind="cgroup", options="rw,memory") + mount(target="/v2"),
                "/cpu/work/cpu.cfs_quota_us": "250000", "/cpu/work/cpu.cfs_period_us": "100000",
                "/memory/ram/memory.limit_in_bytes": "1000", "/memory/ram/memory.usage_in_bytes": "300"}
        with files(data):
            self.assertEqual(linux_resources.cpu_limit(), 3)
            self.assertEqual(linux_resources.memory_headroom(), 700)

    def test_missing_unreadable_or_malformed_proc_files(self):
        for path in ("/proc/self/cgroup", "/proc/self/mountinfo"):
            for value in ("", "malformed", PermissionError(), UnicodeError()):
                data = v2({"/cg/job/cpu.max": "1 1", "/cg/job/memory.max": "1000",
                           "/cg/job/memory.current": "0", path: value})
                with self.subTest(path=path, value=value), files(data):
                    self.assertIsNone(linux_resources.cpu_limit())
                    self.assertIsNone(linux_resources.memory_headroom())
        with files({}):
            self.assertIsNone(linux_resources.cpu_limit())

    def test_other_filesystems_and_controllers_are_ignored(self):
        data = v2({"/cg/job/cpu.max": "1 1"})
        for info in (mount(kind="tmpfs"), mount(kind="cgroup", options="rw,cpuset"),
                     "31 20 0:28 / /cg - cgroup2 none rw", " - cgroup2", ""):
            data["/proc/self/mountinfo"] = info
            with self.subTest(info=info), files(data):
                self.assertIsNone(linux_resources.cpu_limit())

    def test_duplicate_mount_entries_are_read_once(self):
        data = v2({"/cg/job/cpu.max": "1 1"})
        data["/proc/self/mountinfo"] *= 2
        with files(data) as reads:
            self.assertEqual(linux_resources.cpu_limit(), 1)
            self.assertEqual([call.args[0].as_posix() for call in reads.call_args_list].count("/cg/job/cpu.max"), 1)


class CgroupMemory(unittest.TestCase):
    def test_headroom_includes_parent_usage_from_siblings(self):
        data = v2({"/cg/group/job/memory.max": "1000", "/cg/group/job/memory.current": "100",
                   "/cg/group/memory.max": "2000", "/cg/group/memory.current": "1800",
                   "/cg/memory.max": "5000", "/cg/memory.current": "2000"}, member="/group/job")
        with files(data):
            self.assertEqual(linux_resources.memory_headroom(), 200)

    def test_unlimited_leaf_uses_parent_headroom(self):
        with files(v2({"/cg/job/memory.max": "max\n", "/cg/job/memory.current": "1",
                       "/cg/memory.max": "1000", "/cg/memory.current": "700"})):
            self.assertEqual(linux_resources.memory_headroom(), 300)

    def test_zero_or_exhausted_memory_is_zero(self):
        for maximum, current in (("0", "0"), ("1000", "1000"), ("1000", "1001")):
            with self.subTest(maximum=maximum, current=current), files(v2({"/cg/job/memory.max": maximum,
                                                                        "/cg/job/memory.current": current})):
                self.assertEqual(linux_resources.memory_headroom(), 0)

    def test_unknown_or_invalid_values_are_ignored(self):
        for maximum, current in (("max", "50"), ("-1", "1"), ("1000", "-1"), ("junk", "0"),
                                 ("1000", "junk"), ("1000", ""), ("", "1"),
                                 (PermissionError(), "1"), ("1000", UnicodeError())):
            with self.subTest(maximum=maximum, current=current), files(v2({"/cg/job/memory.max": maximum,
                                                                        "/cg/job/memory.current": current})):
                self.assertIsNone(linux_resources.memory_headroom())
        with files(v2({"/cg/job/memory.max": "1000"})):
            self.assertIsNone(linux_resources.memory_headroom())

    def test_v1_hierarchy_flag_only_changes_ancestor_limits(self):
        data = v1({"/cg/job/memory.limit_in_bytes": "1000", "/cg/job/memory.usage_in_bytes": "100",
                   "/cg/job/memory.use_hierarchy": "0\n", "/cg/memory.limit_in_bytes": "2000",
                   "/cg/memory.usage_in_bytes": "1900"})
        for hierarchy, expected in (("0\n", 900), ("1\n", 100)):
            data["/cg/memory.use_hierarchy"] = hierarchy
            with self.subTest(hierarchy=hierarchy), files(data):
                self.assertEqual(linux_resources.memory_headroom(), expected)

    def test_v1_unlimited_sentinel_does_not_limit_host_available_memory(self):
        data = v1({"/cg/job/memory.limit_in_bytes": "9223372036854771712",
                   "/cg/job/memory.usage_in_bytes": "10000", "/proc/meminfo": "MemAvailable: 2048 kB\n"})
        with mock.patch("sys.platform", "linux"), files(data):
            self.assertEqual(resources.free_memory_bytes(), 2048 * 1024)

    def test_hard_ram_limit_does_not_add_swap_or_cache(self):
        data = v2({"/cg/job/memory.max": "1000", "/cg/job/memory.current": "600",
                   "/cg/job/memory.high": "500", "/cg/job/memory.swap.max": "5000",
                   "/cg/job/memory.stat": "inactive_file 400\n"})
        with files(data):
            self.assertEqual(linux_resources.memory_headroom(), 400)

    def test_headroom_is_not_cached(self):
        data = v2({"/cg/job/memory.max": "1000", "/cg/job/memory.current": "100"})
        with files(data):
            self.assertEqual(linux_resources.memory_headroom(), 900)
            data["/cg/job/memory.current"] = "950"
            self.assertEqual(linux_resources.memory_headroom(), 50)


class ResourceIntegration(unittest.TestCase):
    def test_limits_reach_resources_and_preflight(self):
        data = v2({"/cg/job/cpu.max": "150000 100000", "/cg/job/memory.max": "1000000000",
                   "/cg/job/memory.current": "800000000", "/proc/meminfo": "MemAvailable: 8000000 kB\n"})
        with mock.patch("sys.platform", "linux"), files(data), \
                mock.patch("os.sched_getaffinity", return_value=set(range(16)), create=True):
            self.assertEqual(resources.available_cpus(), 2)
            free = resources.free_memory_bytes()
            self.assertEqual(free, 200000000)
            self.assertEqual(resources.preflight(3000000, free=free)["level"], "refuse")

    def test_affinity_and_quota_use_the_lower_count(self):
        with mock.patch("sys.platform", "linux"), mock.patch("os.sched_getaffinity", return_value={2, 6, 8, 9}, create=True):
            for quota, expected in ((None, 4), (1, 1), (3, 3), (8, 4)):
                with self.subTest(quota=quota), mock.patch.object(linux_resources, "cpu_limit", return_value=quota):
                    self.assertEqual(resources.available_cpus(), expected)

    def test_cpu_quota_still_applies_without_affinity(self):
        with mock.patch("sys.platform", "linux"), mock.patch("os.sched_getaffinity", side_effect=OSError(), create=True), \
                mock.patch("os.cpu_count", return_value=32), mock.patch.object(linux_resources, "cpu_limit", return_value=2):
            self.assertEqual(resources.available_cpus(), 2)

    def test_other_platforms_do_not_probe_cgroups(self):
        for platform in ("win32", "darwin", "freebsd"):
            with self.subTest(platform=platform), mock.patch("sys.platform", platform), \
                    mock.patch("os.sched_getaffinity", side_effect=AttributeError(), create=True), \
                    mock.patch("os.cpu_count", return_value=12), \
                    mock.patch.object(resources, "_windows_available_cpus", return_value=None), \
                    mock.patch.object(linux_resources, "cpu_limit") as probe:
                self.assertEqual(resources.available_cpus(), 12)
                probe.assert_not_called()

    def test_mem_available_capped_by_headroom_and_preserves_zero(self):
        with mock.patch("sys.platform", "linux"), files({"/proc/meminfo": "MemAvailable: 2048 kB\n"}):
            for headroom, expected in ((None, 2097152), (1024, 1024), (0, 0), (4000000, 2097152)):
                with self.subTest(headroom=headroom), mock.patch.object(linux_resources, "memory_headroom", return_value=headroom):
                    self.assertEqual(resources.free_memory_bytes(), expected)

    def test_unreadable_or_invalid_host_memory_stays_unknown(self):
        for info in ("", "MemFree: 1024 kB\n", "MemAvailable: broken kB\n", "MemAvailable: -1 kB\n",
                     "MemAvailable: 1024 MB\n", "MemAvailable: 1024\n", PermissionError(), UnicodeError()):
            with self.subTest(info=info), mock.patch("sys.platform", "linux"), files({"/proc/meminfo": info}), \
                    mock.patch.object(linux_resources, "memory_headroom", return_value=1000000):
                self.assertIsNone(resources.free_memory_bytes())

    def test_macos_probes_are_unchanged(self):
        with mock.patch("sys.platform", "darwin"), mock.patch("subprocess.run") as run, \
                mock.patch.object(linux_resources, "memory_headroom") as probe:
            run.return_value.stdout = "8\n"
            self.assertEqual(resources.physical_cores(16), 8)
            run.return_value.stdout = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\n'
            self.assertEqual(resources.free_memory_bytes(), 30 * 16384)
            probe.assert_not_called()

    def test_windows_physical_probe_is_unchanged(self):
        with mock.patch("sys.platform", "win32"), mock.patch.object(resources, "_windows_physical_cores", return_value=6):
            self.assertEqual(resources.physical_cores(12), 6)

    def test_windows_memory_probe_is_unchanged(self):
        def memory_status(pointer):
            pointer._obj.avail = 123456789
            return 1
        with mock.patch("sys.platform", "win32"), mock.patch("ctypes.windll", create=True) as windll, \
                mock.patch.object(linux_resources, "memory_headroom") as probe:
            windll.kernel32.GlobalMemoryStatusEx.side_effect = memory_status
            self.assertEqual(resources.free_memory_bytes(), 123456789)
            probe.assert_not_called()


class PhysicalTopology(unittest.TestCase):
    @staticmethod
    def cpuinfo(rows):
        return "\n\n".join(f"processor\t: {cpu}\nphysical id\t: {socket}\ncore id\t: {core}" for cpu, socket, core in rows)

    def probe(self, info, affinity, logical):
        with mock.patch("sys.platform", "linux"), files({"/proc/cpuinfo": info}), \
                mock.patch("os.sched_getaffinity", return_value=affinity, create=True):
            return resources.physical_cores(logical)

    def test_only_affinity_members_contribute(self):
        info = self.cpuinfo([(0, 0, 0), (1, 0, 1), (2, 0, 0), (3, 0, 1), (4, 1, 0)])
        self.assertEqual(self.probe(info, {0, 2}, 2), 1, "SMT siblings share one physical core")
        self.assertEqual(self.probe(info, {0, 1}, 2), 2)
        self.assertEqual(self.probe(info, {0, 2, 4}, 3), 2, "socket IDs disambiguate core IDs")

    def test_quota_capped_logical_count_is_preserved(self):
        info = self.cpuinfo([(cpu, 0, cpu) for cpu in range(8)])
        self.assertEqual(self.probe(info, set(range(8)), 2), 2)

    def test_no_affinity_uses_complete_host_topology(self):
        info = self.cpuinfo([(0, 0, 0), (1, 0, 0), (2, 1, 0), (3, 1, 0)])
        with mock.patch("sys.platform", "linux"), files({"/proc/cpuinfo": info}), \
                mock.patch("os.sched_getaffinity", side_effect=OSError(), create=True):
            self.assertEqual(resources.physical_cores(4), 2)

    def test_partial_or_missing_topology_uses_fallback(self):
        complete = self.cpuinfo([(0, 0, 0)])
        for info in ("", complete, complete + "\n\nprocessor: 1\nphysical id: 1\n",
                     complete + "\n\nprocessor: 1\ncore id: 1\n", "processor: not-a-number\ncore id: 0",
                     "processor: 0\nphysical id: 0\ncore id: bad\n", PermissionError(), UnicodeError()):
            with self.subTest(info=info):
                self.assertEqual(self.probe(info, {0, 1, 2, 3, 4, 5}, 6), 3)

    def test_unselected_partial_record_does_not_leak_fields(self):
        info = "processor: 99\nphysical id: 99\n\n" + self.cpuinfo([(0, 0, 0), (1, 0, 0)])
        self.assertEqual(self.probe(info, {0, 1}, 2), 1)

    def test_conflicting_duplicate_processor_is_unknown(self):
        info = self.cpuinfo([(0, 0, 0), (0, 1, 0)])
        self.assertEqual(self.probe(info, {0, 1}, 2), 2)


if __name__ == "__main__":
    unittest.main()
