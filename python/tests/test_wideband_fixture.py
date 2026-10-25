"""The web parity bridge must work with only Python's standard library."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


BRIDGE = Path(__file__).with_name("wideband_fixture.py").resolve()
FIXTURE = json.loads(BRIDGE.with_name("fixtures").joinpath("wideband_materials.json").read_text())


def bridge(*args, designs=None):
    # Isolated mode ignores user packages/PYTHONPATH; -S removes site-packages.
    # A separate cwd also prevents an installed/local SDK from masking imports.
    with tempfile.TemporaryDirectory(prefix="fairbeam-stdlib-fixture-") as cwd:
        result = subprocess.run(
            [sys.executable, "-I", "-S", str(BRIDGE), *args], cwd=cwd,
            input=None if designs is None else json.dumps(designs),
            text=True, capture_output=True, check=True, timeout=10,
        )
    return json.loads(result.stdout)


class WidebandFixtureStdlib(unittest.TestCase):
    def test_all_shared_cases_without_site_packages(self):
        output = bridge()
        self.assertEqual(len(output["cases"]), len(FIXTURE["cases"]))
        for case, result in zip(FIXTURE["cases"], output["cases"]):
            with self.subTest(case=case["name"]):
                self.assertEqual("input" in result, case["valid"])
                self.assertEqual("error" in result, not case["valid"])
                self.assertIsInstance(result["checks"], list)

    def test_post_edit_designs_without_site_packages(self):
        design = bridge()["blank"]
        known = {param["key"] for param in design["params"]}
        design["params"] += [{"key": key, "default": value}
                             for key, value in FIXTURE["names"].items() if key not in known]
        design["materials"].append(copy.deepcopy(FIXTURE["base"]))
        invalid = copy.deepcopy(design)
        invalid["materials"][-1]["dispersion"]["m2"] = "-1"
        good, bad = bridge("--designs", designs=[design, invalid])
        self.assertIn("input", good["materials"][0])
        self.assertIn("error", bad["materials"][0])
        self.assertTrue(any(check.startswith("error|dispersion|") for check in bad["checks"]))


if __name__ == "__main__":
    unittest.main()
