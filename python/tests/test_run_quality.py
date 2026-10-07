"""Run quality in the project index: the Python rules (fairbeam.cli.run_quality) match
src/lib/runQuality.ts, rebuild_index writes the field, and the mtime cache keeps working."""

import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam import cli  # noqa: E402
from fairbeam.cli import rebuild_index, run_quality  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
PROJECTS = REPO / "public" / "projects"


def patch_bundle():
    return json.loads((PROJECTS / "patch-antenna.json").read_text("utf-8"))


class RunQualityRules(unittest.TestCase):
    def test_the_same_cases_as_check_run_quality(self):
        base = patch_bundle()
        self.assertEqual(run_quality(base), "converged")

        cut = copy.deepcopy(base)
        cut["run"]["converged"] = False
        self.assertEqual(run_quality(cut), "not-converged")

        multi = copy.deepcopy(base)
        multi["run"]["port_runs"] = [{"port": 1, "converged": True}, {"port": 2, "converged": False}]
        self.assertEqual(run_quality(multi), "not-converged")
        multi["run"]["port_runs"][1]["converged"] = True
        multi["run"]["converged"] = False  # port_runs win when present
        self.assertEqual(run_quality(multi), "converged")

        gain = copy.deepcopy(base)
        port = next(iter(gain["results"]["ports"].values()))
        port["s11_re"][10], port["s11_im"][10] = 1.05, 0.0  # |S11| = +0.42 dB
        self.assertEqual(run_quality(gain), "suspicious")

        ripple = copy.deepcopy(base)
        next(iter(ripple["results"]["ports"].values()))["s11_re"][10] = 1.005  # +0.04 dB: numerical
        self.assertEqual(run_quality(ripple), "converged")

        eff = copy.deepcopy(base)
        eff["results"]["farfield"][0]["rad_efficiency"] = 1.08
        self.assertEqual(run_quality(eff), "suspicious")
        eff["results"]["farfield"][0]["rad_efficiency"] = 1.04
        self.assertEqual(run_quality(eff), "converged")

        both = copy.deepcopy(base)
        both["run"]["converged"] = False
        both["results"]["farfield"][0]["rad_efficiency"] = 1.2
        self.assertEqual(run_quality(both), "not-converged")  # not converged outranks suspicious

        # an uncoupled port (a feed that no longer spans a gap, e.g. after a rotation): |S11| about 0 dB
        # over the whole band and/or a total efficiency of a few percent at most
        dead = copy.deepcopy(base)
        port = next(iter(dead["results"]["ports"].values()))
        n = len(port["s11_re"])
        port["s11_re"], port["s11_im"] = [0.995] * n, [0.0] * n   # -0.04 dB everywhere
        self.assertEqual(run_quality(dead), "suspicious")
        port["s11_re"] = [0.95] * n                               # -0.45 dB: still no coupling
        self.assertEqual(run_quality(dead), "suspicious")
        port["s11_re"] = [0.94] * n                               # -0.54 dB: just past the limit
        self.assertEqual(run_quality(dead), "converged")
        port["s11_re"] = [0.9] * n                                # -0.92 dB: some power gets in
        dead_eta = copy.deepcopy(dead)
        for ff in dead_eta["results"]["farfield"]:
            ff["rad_efficiency"] = 0.01
        self.assertEqual(run_quality(dead_eta), "suspicious", "total efficiency below 2 % on its own")
        shallow = copy.deepcopy(base)
        port = next(iter(shallow["results"]["ports"].values()))
        port["s11_re"], port["s11_im"] = [0.7] * n, [0.0] * n     # -3 dB: poorly matched, but coupled
        self.assertEqual(run_quality(shallow), "converged")
        weak = copy.deepcopy(base)
        weak["results"]["farfield"][0]["rad_efficiency"] = 0.01
        self.assertEqual(run_quality(weak), "suspicious", "total efficiency of 1 %")
        weak["results"]["farfield"][0]["rad_efficiency"] = 0.05
        self.assertEqual(run_quality(weak), "converged", "5 % is poor but not uncoupled")
        weak["results"]["farfield"][0]["rad_efficiency"] = 0.01
        weak["results"]["farfield"].append({**weak["results"]["farfield"][0], "rad_efficiency": 0.9})
        self.assertEqual(run_quality(weak), "converged", "one far-field entry above 2 % keeps the run clean")
        unknown = copy.deepcopy(base)
        unknown["results"]["farfield"][0]["rad_efficiency"] = None
        self.assertEqual(run_quality(unknown), "converged", "an unknown efficiency is not judged")

        preview = copy.deepcopy(base)
        del preview["results"]
        self.assertIsNone(run_quality(preview))
        norun = copy.deepcopy(base)
        del norun["run"]
        self.assertIsNone(run_quality(norun))

    def test_zero_and_non_finite_samples_are_skipped(self):
        b = patch_bundle()
        port = next(iter(b["results"]["ports"].values()))
        port["s11_re"][3], port["s11_im"][3] = 0.0, 0.0  # log10(0)
        port["s11_re"][4] = float("nan")
        b["results"]["farfield"][0]["rad_efficiency"] = None
        self.assertEqual(run_quality(b), "converged")

    @unittest.skipUnless(shutil.which("node"), "node is needed to run runQuality.ts")
    def test_matches_run_quality_ts_on_the_bundled_examples(self):
        out = subprocess.run(
            ["node", "--experimental-strip-types", "--no-warnings", str(REPO / "scripts" / "print-run-quality.mjs"),
             str(PROJECTS)], capture_output=True, text=True, cwd=REPO, encoding="utf-8")
        if out.returncode != 0:
            self.skipTest("node could not run runQuality.ts: " + out.stderr[-200:])
        expected = json.loads(out.stdout)
        self.assertGreaterEqual(len(expected), 10)
        got = {}
        for f in sorted(PROJECTS.glob("*.json")):
            if f.name == "index.json":
                continue
            q = run_quality(json.loads(f.read_text("utf-8")))
            if q:
                got[f.name] = q
        self.assertEqual(got, expected)


class IndexField(unittest.TestCase):
    def test_rebuild_index_writes_quality_only_for_results(self):
        stopped = patch_bundle()
        stopped["name"] = "stopped"
        stopped["run"]["converged"] = False
        preview = patch_bundle()
        preview["name"] = "preview"
        del preview["results"]
        with tempfile.TemporaryDirectory() as d:
            for name, b in {"ok.json": patch_bundle(), "stopped.json": stopped, "preview.json": preview}.items():
                (Path(d) / name).write_text(json.dumps(b), encoding="utf-8")
            rebuild_index(Path(d))
            rows = {e["file"]: e for e in json.loads((Path(d) / "index.json").read_text("utf-8"))["projects"]}
        self.assertEqual(rows["ok.json"]["quality"], "converged")
        self.assertEqual(rows["stopped.json"]["quality"], "not-converged")
        self.assertNotIn("quality", rows["preview.json"])

    def test_band_ranges_for_the_picker(self):
        # each band's edges in GHz and whether it runs into the edge of the simulated range
        # (src/lib/bands.ts pickerBands: the middle of a closed band, the range of an open one)
        b = patch_bundle()
        band = b["results"]["bands"][0]
        horn = patch_bundle()
        horn["results"]["bands"] = [{**band, "f_lo": 8e9, "f_hi": 12e9, "f_center": 11.16e9, "edge_lo": True, "edge_hi": True}]
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "patch.json").write_text(json.dumps(b), encoding="utf-8")
            (Path(d) / "horn.json").write_text(json.dumps(horn), encoding="utf-8")
            entry = cli._read_index_entry(Path(d) / "patch.json")
            open_band = cli._read_index_entry(Path(d) / "horn.json")
        self.assertEqual(entry["band_ranges"], [{"lo": round(band["f_lo"] / 1e9, 4), "hi": round(band["f_hi"] / 1e9, 4),
                                                 "edge_lo": False, "edge_hi": False}])
        self.assertEqual(open_band["band_ranges"], [{"lo": 8.0, "hi": 12.0, "edge_lo": True, "edge_hi": True}])
        self.assertEqual(open_band["bands"], [11.16], "the band list keeps the |S11| minimum")
        committed = json.loads((PROJECTS / "index.json").read_text("utf-8"))["projects"]
        for e in committed:
            if e.get("simulated"):
                bundle = json.loads((PROJECTS / e["file"]).read_text("utf-8"))
                self.assertEqual(e.get("band_ranges"), cli._index_band_ranges(bundle["results"]["bands"]) or None, e["file"])

    def test_the_mtime_cache_keeps_the_field_and_follows_a_rewritten_bundle(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "run.json"
            f.write_text(json.dumps(patch_bundle()), encoding="utf-8")
            first = cli._index_entry(f)
            self.assertEqual(first["quality"], "converged")
            calls = []
            real = cli._read_index_entry
            cli._read_index_entry = lambda p: (calls.append(p), real(p))[1]
            try:
                again = cli._index_entry(f)
                self.assertEqual(calls, [], "unchanged file: served from the cache")
                self.assertEqual(again["quality"], "converged")
                again["quality"] = "mutated"  # callers get a copy
                self.assertEqual(cli._index_entry(f)["quality"], "converged")
                b = patch_bundle()
                b["run"]["converged"] = False
                f.write_text(json.dumps(b), encoding="utf-8")
                st = f.stat()
                os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
                self.assertEqual(cli._index_entry(f)["quality"], "not-converged")
                self.assertEqual(len(calls), 1, "a rewritten file is read again")
            finally:
                cli._read_index_entry = real


if __name__ == "__main__":
    unittest.main()
