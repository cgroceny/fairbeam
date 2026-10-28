"""Synthetic requirement parity/refusal controls. No openEMS/CSXCAD or solver run."""
import copy
import importlib
import importlib.abc
import json
import math
from pathlib import Path
import sys
import types
import unittest

# fairbeam.__init__ eagerly imports Simulation. Load the exact pure sources under a package
# namespace whose only difference is skipping that unrelated native bootstrap; no SDK stubs.
PACKAGE = "_requirements_sdk_free"
namespace = types.ModuleType(PACKAGE)
namespace.__path__ = [str(Path(__file__).resolve().parents[1] / "fairbeam")]
sys.modules[PACKAGE] = namespace


class RejectNative(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in ("openEMS", "CSXCAD") or fullname in (PACKAGE+".simulation", PACKAGE+".multiport"):
            raise AssertionError(f"native import is forbidden in requirements test: {fullname}")
        return None


guard = RejectNative()
sys.meta_path.insert(0, guard)
try:
    module = importlib.import_module(PACKAGE + ".requirements")
finally:
    sys.meta_path.remove(guard)
evaluate_requirements = module.evaluate_requirements
requirement_segments = module.requirement_segments
requirements_to_goals = module.requirements_to_goals
validate_requirements = module.validate_requirements

FIXTURE = Path(__file__).parent / "fixtures" / "requirements_parity.json"
DATA = json.loads(FIXTURE.read_text(encoding="utf-8"))


def change(value, changes):
    out = copy.deepcopy(value)
    for item in changes:
        parent = out
        for key in item["path"][:-1]:
            parent = parent[key]
        key = item["path"][-1]
        if item.get("remove"):
            del parent[key]
        else:
            parent[key] = item["value"]
    return out


def spec(goal):
    return {"schema": "fairbeam.requirements/1", "items": [{"id": "spec", "goal": goal}]}


def cases():
    return [{"name": c["name"], "evaluation": evaluate_requirements(spec(c["goal"]),
             change(DATA["base"], c.get("changes", [])), change(DATA["context"], c.get("contextChanges", [])))}
            for c in DATA["cases"]]


def integration_cases():
    design = importlib.import_module(PACKAGE+".design")
    checks = importlib.import_module(PACKAGE+".design_checks")
    fixture = json.loads((FIXTURE.parent / "designer_parity.json").read_text(encoding="utf-8"))
    rows = []
    for case in fixture["cases"]:
        if not case["name"].startswith("requirements "):
            continue
        d = design.blank_design("case", "Case")
        d["requirements"] = copy.deepcopy(case["set"]["requirements"])
        rows.append({"name": case["name"], "design": d, "expect": case["expect"],
                     "checks": [c for c in checks.lint(d) if c["code"] in checks.CHEAP]})
    raw = json.dumps({"schema": "fairbeam.design/1", "requirements": spec({"kind": "s11_max", "target": -10, "at": 2.5})}).encode()
    b = module.attach_requirements(DATA["base"], raw, source_id=module.requirement_source_id(raw, {"width": 2.5}), resolved_parameters={"width": 2.5})
    return {"bundle": b, "evaluation": module.evaluate_saved_requirements(b), "designCases": rows}


class Requirements(unittest.TestCase):
    def test_shared_design_admission(self):
        for case in integration_cases()["designCases"]:
            with self.subTest(case=case["name"]):
                keys = [f'{c["severity"]}|{c["code"]}|{c["path"]}' for c in case["checks"]]
                self.assertEqual(sorted(keys), sorted(case["expect"]))

    def test_saved_input_identity_snapshot_and_refusals(self):
        import hashlib
        mask = spec({"kind": "s11_max", "target": -10, "at": 2.5})
        document = {"schema": "fairbeam.design/1", "requirements": mask}
        raw = json.dumps(document).encode("utf-8")
        parameters = {"width": 2.5, "enabled": True, "name": "ölçüm"}
        source = module.requirement_source_id(raw, parameters)
        independent = hashlib.sha256(json.dumps({"input_sha256": hashlib.sha256(raw).hexdigest(),
            "resolved_parameters": parameters}, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()
        self.assertEqual(source, independent)
        b = module.attach_requirements(DATA["base"], raw, source_id=source, resolved_parameters=parameters)
        self.assertNotIn("requirements_snapshot", DATA["base"])
        self.assertEqual(b["requirements_snapshot"]["requirements"], mask)
        self.assertEqual(module.evaluate_saved_requirements(b)["metric"], "pass")
        self.assertEqual(module.evaluate_saved_requirements(b)["mesh"], "unknown")
        self.assertEqual(module.evaluate_saved_requirements(b)["status"], "unknown")
        document["requirements"]["items"][0]["goal"]["target"] = -80
        parameters["width"] = 5
        self.assertEqual(module.evaluate_saved_requirements(b)["metric"], "pass")
        self.assertEqual(b["requirements_source"]["resolved_parameters"]["width"], 2.5)
        self.assertNotEqual(module.requirement_source_id(raw+b"\n", parameters), source)
        for bad_raw, bad_params in ((raw+b"\n", {"width": 2.5}), (raw, parameters)):
            with self.assertRaises(ValueError):
                module.attach_requirements(DATA["base"], bad_raw, source_id=source, resolved_parameters=bad_params)
        for field in ("source_id", "input_sha256"):
            corrupt = copy.deepcopy(b)
            corrupt["requirements_snapshot"][field] = "0"*64
            self.assertEqual(module.evaluate_saved_requirements(corrupt)["metric"], "unknown")
        self.assertEqual(module.evaluate_saved_requirements(DATA["base"])["reason"], "no-snapshot")
        empty_raw = b'{"schema":"fairbeam.design/1"}'
        empty_source = module.requirement_source_id(empty_raw, {})
        empty = module.attach_requirements(b, empty_raw, source_id=empty_source, resolved_parameters={})
        self.assertNotIn("requirements_snapshot", empty)
        for invalid in ({"x": math.nan}, {"x": []}, {"x": {}}, {1: 3}):
            with self.assertRaises(ValueError): module.requirement_source_id(raw, invalid)
        bad_raw = json.dumps({"schema": "fairbeam.design/1", "requirements": {}}).encode()
        with self.assertRaises(ValueError):
            module.attach_requirements(DATA["base"], bad_raw, source_id=module.requirement_source_id(bad_raw, {}), resolved_parameters={})

    def test_stdlib_only_source_helper_and_design_admission(self):
        # Fresh interpreter: block numpy as well as native SDKs, so earlier numerical tests cannot
        # accidentally hide an import introduced into ordinary Design save/check operations.
        import subprocess
        code = r'''
import importlib, importlib.abc, json, sys, types
class Reject(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in ('numpy','scipy','openEMS','CSXCAD'): raise RuntimeError(fullname)
sys.meta_path.insert(0, Reject())
p=types.ModuleType('_source_only'); p.__path__=[sys.argv[1]]; sys.modules[p.__name__]=p
r=importlib.import_module('_source_only.requirements')
d=importlib.import_module('_source_only.design')
raw=b'{"schema":"fairbeam.design/1","requirements":{"schema":"fairbeam.requirements/1","items":[]}}'
assert r.attach_requirements({},raw,source_id=r.requirement_source_id(raw,{}),resolved_parameters={})['requirements_snapshot']
try: d.check_design({'schema':'fairbeam.design/1','requirements':{}})
except d.DesignError as error: assert error.where == 'requirements'
else: raise AssertionError('invalid requirements admitted')
print('PASS source helper and Design admission without numpy/scipy/native SDK')
'''
        result = subprocess.run([sys.executable, "-c", code, str(Path(__file__).resolve().parents[1]/"fairbeam")], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)

    def test_shared_expected_cases(self):
        for source, actual in zip(DATA["cases"], cases()):
            with self.subTest(case=source["name"]):
                e, want = actual["evaluation"], source["expect"]
                self.assertEqual(e["metric"], want["metric"])
                self.assertEqual(e["status"], want["status"])
                for key in ("energy", "mesh"):
                    if key in want:
                        self.assertEqual(e[key], want[key])
                if "parseReason" in want:
                    self.assertEqual(e["reason"], want["parseReason"])
                    self.assertEqual(e["items"], [])
                    continue
                item = e["items"][0]
                for key in ("reason", "samples", "lowerBound"):
                    if key in want:
                        self.assertEqual(item[key], want[key])
                if "value" in want:
                    self.assertAlmostEqual(item["value"], want["value"], places=10)
                if "reciprocal" in want:
                    self.assertEqual(item["sources"][0]["reciprocal"], want["reciprocal"])

    def test_conversion_never_rounds_or_aliases(self):
        goal = {"kind": "sij_min", "target": -6.0123456789, "at": 2.00000011,
                "at_hi": 2.00000012, "ports": [4, 2], "weight": 2.123456789}
        s = spec(goal)
        result = requirements_to_goals(s)
        self.assertEqual(result["goals"], [goal])
        self.assertEqual(result["f0TolerancePct"], .25)
        self.assertTrue(result["qualificationRequired"])
        result["goals"][0]["ports"][0] = 99
        self.assertEqual(s["items"][0]["goal"]["ports"], [4, 2])
        a = spec({"kind": "sij_min", "target": -6, "at": 2.00000011, "ports": [4, 2]})
        a["items"].append({"id": "second", "goal": {"kind": "sij_min", "target": -6, "at": 2.00000012, "ports": [4, 2]}})
        out = evaluate_requirements(a, DATA["base"], DATA["context"])
        self.assertNotEqual(out["items"][0]["value"], out["items"][1]["value"])

    def test_missing_invalid_and_duplicate_snapshot_fields(self):
        valid = spec({"kind": "s11_max", "target": -10, "at": 2.5})
        for s in (None, {}, {**valid, "schema": "future/2"}, {**valid, "unrecognized": True},
                  {**valid, "items": valid["items"]*2}, {**valid, "items": valid["items"]*65}):
            self.assertFalse(validate_requirements(s)["ok"])
        for bad in (math.nan, math.inf, -math.inf, 10**1000, True, "-10", None):
            with self.subTest(bad=bad):
                g = {"kind": "s11_max", "target": bad, "at": 2.5}
                self.assertFalse(validate_requirements(spec(g))["ok"])
        for bad in (math.nan, math.inf, True, "2", None):
            b = copy.deepcopy(DATA["base"])
            b["results"]["sparams"]["s"]["1,1"]["re"][1] = bad
            self.assertEqual(evaluate_requirements(valid, b, DATA["context"])["metric"], "unknown")
        self.assertEqual(evaluate_requirements(valid, DATA["base"])["reason"], "source-mismatch")
        self.assertEqual(evaluate_requirements({"schema": "fairbeam.requirements/1", "items": []}, DATA["base"], DATA["context"])["status"], "unknown")

    def test_masks_are_bounded_and_point_is_not_whole_chart(self):
        s = spec({"kind": "sij_min", "target": -3, "at": 2.4, "at_hi": 2.48, "ports": [4, 2]})
        self.assertEqual(requirement_segments(s), [{"id": "spec", "kind": "sij_min", "ports": [4, 2],
                         "fromHz": 2.4e9, "toHz": 2.48e9, "valueDb": -3, "direction": "min"}])
        del s["items"][0]["goal"]["at_hi"]
        segment = requirement_segments(s)[0]
        self.assertEqual(segment["fromHz"], segment["toHz"])
        self.assertEqual(requirement_segments(spec({"kind": "dmax_min", "target": 2, "at": 2.5})), [])

    def test_bounded_work_refuses_before_quadratic_sampling(self):
        b = copy.deepcopy(DATA["base"])
        b["results"]["frequency"] = [2e9+i for i in range(16000)]
        s = {"schema": "fairbeam.requirements/1", "items": [{"id": f"r{i}", "goal": {"kind": "match_all", "target": -10, "at": 2}} for i in range(64)]}
        out = evaluate_requirements(s, b, DATA["context"])
        self.assertEqual(out["reason"], "work-limit")
        self.assertTrue(all(i["metric"] == "unknown" for i in out["items"]))

    def test_closed_band_and_strict_field_refusals(self):
        b = copy.deepcopy(DATA["base"])
        del b["results"]["sparams"]
        b["results"]["frequency"] = [1e9, 2e9, 3e9, 4e9, 5e9]
        b["results"]["ports"]["2"]["s11_re"] = [.8, .1, .05, .1, .8]
        b["results"]["ports"]["2"]["s11_im"] = [0]*5
        # Same contiguous stored-sample bandwidth definition as the optimizer: 2 to 4 GHz.
        out = evaluate_requirements(spec({"kind": "bw_min", "target": 2000}), b, DATA["context"])
        self.assertEqual(out["items"][0]["value"], 2000)
        self.assertFalse(out["items"][0]["lowerBound"])
        self.assertEqual(out["status"], "pass")
        b = copy.deepcopy(DATA["base"])
        b["results"]["farfield"] *= 2
        self.assertEqual(evaluate_requirements(spec({"kind": "dmax_min", "target": 2, "at": 2.5}), b, DATA["context"])["items"][0]["reason"], "missing-exact-field")
        for field, value in (("prad_w", 2), ("pacc_w", 0), ("rad_efficiency", True), ("realized_gain_dbi", math.nan)):
            b = copy.deepcopy(DATA["base"])
            b["results"]["farfield"][0][field] = value
            self.assertEqual(evaluate_requirements(spec({"kind": "realized_gain_min", "target": 2, "at": 2.5}), b, DATA["context"])["metric"], "unknown")

    def test_sdk_free_and_no_input_mutation(self):
        before = copy.deepcopy(DATA)
        before_modules = set(sys.modules)
        sys.meta_path.insert(0, guard)
        try:
            cases()
        finally:
            sys.meta_path.remove(guard)
        self.assertEqual(DATA, before)
        self.assertFalse(any(name == "openEMS" or name.startswith("openEMS.") or name == "CSXCAD" for name in set(sys.modules)-before_modules))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--dump":
        Path(sys.argv[2]).write_text(json.dumps(cases(), indent=2, allow_nan=False)+"\n", encoding="utf-8")
    elif len(sys.argv) == 3 and sys.argv[1] == "--integration-dump":
        Path(sys.argv[2]).write_text(json.dumps(integration_cases(), indent=2, allow_nan=False)+"\n", encoding="utf-8")
    else:
        unittest.main()
