"""Saved mesh compatibility and the design-level fine-feature switch."""
import copy
import json
import unittest

import numpy as np

from fairbeam.design import DesignError, TEMPLATES, check_design, module_for, template_design, to_python
from tests.mesh_feature_measurements import FIXTURE


class FeatureSettingTest(unittest.TestCase):
    def test_new_templates_enable_refinement(self):
        for name in TEMPLATES:
            with self.subTest(template=name):
                self.assertIs(template_design(name, "new", "New")["mesh"]["refine_features"], True)

    def test_saved_design_and_python_export_preserve_the_switch(self):
        for mode in ("auto", "design"):
            base = json.loads(FIXTURE.read_text())
            base["mesh"] = {"mode": mode}
            builds = {}
            for setting in (None, False, True):
                d = copy.deepcopy(base)
                if setting is not None:
                    d["mesh"]["refine_features"] = setting
                module = module_for(d)
                sim = module.build({})
                exported = {}
                exec(to_python(d), exported)
                other = exported["build"]({})
                for axis in range(3):
                    np.testing.assert_array_equal(sim.mesh.GetLines(axis), other.mesh.GetLines(axis))
                self.assertIs(sim.mesh_report["settings"]["refine_features"], setting is True)
                builds[setting] = sim
            for axis in range(3):
                np.testing.assert_array_equal(builds[None].mesh.GetLines(axis), builds[False].mesh.GetLines(axis))
            self.assertGreater(builds[True].mesh_report["total_cells"], builds[None].mesh_report["total_cells"])
            if mode == "design":
                self.assertEqual(builds[None].mesh_report["total_cells"], 213696)

    def test_non_boolean_values_are_rejected(self):
        for value in (0, 1, "true", None, []):
            d = json.loads(FIXTURE.read_text())
            d["mesh"]["refine_features"] = value
            with self.subTest(value=value), self.assertRaises(DesignError):
                check_design(d)


if __name__ == "__main__":
    unittest.main()
