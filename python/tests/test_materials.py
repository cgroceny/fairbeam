"""The material library (fairbeam.materials): pinned to the shared fixture (src/designer/materials.ts
is checked against the same file by scripts/check-designer.mjs), copied into designs, documented."""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.design import build, check_design, empty_design, to_python  # noqa: E402
from fairbeam.materials import LIBRARY, design_material, get, markdown_table  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "material_library.json"


class Library(unittest.TestCase):
    def test_equals_the_shared_fixture(self):
        self.assertEqual(LIBRARY, json.loads(FIXTURE.read_text(encoding="utf-8"))["library"])

    def test_entries(self):
        ids = [m["id"] for m in LIBRARY]
        self.assertEqual(len(ids), len(set(ids)))
        for m in LIBRARY:
            with self.subTest(m=m["id"]):
                self.assertIn(m["kind"], ("metal", "dielectric"))
                self.assertTrue(m["note"].strip())
                if m["kind"] == "dielectric":
                    self.assertGreaterEqual(m["eps_r"], 1)
                    self.assertGreaterEqual(m["tan_d"], 0)
                    self.assertTrue(m["tan_d_freq"] is None or m["tan_d_freq"] > 0)
        # the values asked for (datasheet nominal values)
        self.assertEqual((get("ro4003c")["eps_r"], get("ro4003c")["tan_d"], get("ro4003c")["tan_d_freq"]), (3.38, 0.0027, 10))
        self.assertEqual((get("ro4350b")["eps_r"], get("ro4350b")["tan_d"]), (3.48, 0.0037))
        self.assertEqual((get("rt5880")["eps_r"], get("rt5880")["tan_d"]), (2.20, 0.0009))
        self.assertEqual(get("fr4")["tan_d_freq"], 1)
        with self.assertRaises(KeyError):
            get("unobtainium")

    def test_a_new_empty_design_has_copper_only(self):
        # no dielectric up front: an unused FR4 only cluttered the list; the library still has FR4
        d = empty_design("t", "T")
        self.assertEqual([m["name"] for m in d["materials"]], ["copper"])
        self.assertEqual(design_material("fr4")["kind"], "dielectric")
        check_design(d)

    def test_a_copy_goes_into_the_design_and_builds(self):
        d = empty_design("t", "T")
        d["materials"].append(design_material("rt5880", "sub"))
        self.assertEqual(d["materials"][-1], {"name": "sub", "kind": "dielectric", "eps_r": 2.2, "tan_d": 0.0009,
                                             "tan_d_freq": 10, "library": "rt5880"})
        self.assertNotIn("tan_d_freq", design_material("air"))
        d["parts"] = [{"name": "slab", "material": "sub", "primitives": [{"kind": "box", "start": [0, 0, 0], "stop": [10, 10, 1]}]},
                      {"name": "patch", "material": "copper", "primitives": [{"kind": "box", "start": [2, 2, 1], "stop": [8, 8, 1]}]}]
        check_design(d)
        sim = build(d, {"f0": 2.45})
        self.assertAlmostEqual(sim.materials["slab"]["tan_d"], 0.0009)
        self.assertAlmostEqual(sim.materials["slab"]["tan_d_freq"], 10e9)
        self.assertIn("material library entry 'rt5880'", to_python(d))

    def test_docs_list_the_library(self):
        self.assertIn(markdown_table(), (ROOT / "docs" / "MODELS.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
