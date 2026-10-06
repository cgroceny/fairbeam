"""Unused optimizer NF2FF recordings are removed without changing other geometry."""

import copy
from pathlib import Path
import unittest

import numpy as np

from fairbeam.model import load_model, resolve_params


MODEL = Path(__file__).resolve().parents[1] / "models/patch_antenna.py"


def build():
    module = load_model(str(MODEL))
    return module.build(resolve_params(module.PARAMS, {}))


def property_names(sim):
    return {prop.GetName() for prop in sim.csx.GetAllProperties()}


class LegacyCSX:
    """Older bindings have no Python DeleteProperty method."""

    def __init__(self, csx):
        self.csx = csx

    def __getattr__(self, key):
        if key == "DeleteProperty":
            raise AttributeError(key)
        return getattr(self.csx, key)


class NF2FFRecordingRemoval(unittest.TestCase):
    def test_removes_owned_dumps_and_preserves_other_model_state(self):
        sim = build()
        user_dump = sim.csx.AddDump("field_user", dump_type=0, file_type=1)
        user_dump.AddBox([0, 0, 0], [1, 1, 0])
        before = property_names(sim)
        mesh = {axis: sim.mesh.GetLines(axis).copy() for axis in "xyz"}
        ports, materials = copy.deepcopy(sim.ports), copy.deepcopy(sim.materials)
        owned = {sim.nf2ff.e_dump.GetName(), sim.nf2ff.h_dump.GetName()}

        self.assertTrue(sim.remove_nf2ff_box())
        self.assertIsNone(sim.nf2ff)
        self.assertIsNone(sim.nf2ff_center)
        self.assertEqual(property_names(sim), before - owned)
        self.assertIn("field_user", property_names(sim))
        self.assertEqual(sim.ports, ports)
        self.assertEqual(sim.materials, materials)
        for axis in "xyz":
            np.testing.assert_array_equal(sim.mesh.GetLines(axis), mesh[axis])

        self.assertTrue(sim.remove_nf2ff_box())  # idempotent
        sim.add_nf2ff_box(center=[0, 0, 1])
        self.assertEqual(property_names(sim), before)

    def test_completed_run_is_not_changed(self):
        sim = build()
        before = property_names(sim)
        sim.sim_path = "finished"
        with self.assertRaisesRegex(RuntimeError, "before run"):
            sim.remove_nf2ff_box()
        self.assertEqual(property_names(sim), before)

    def test_legacy_binding_keeps_geometry_unchanged(self):
        sim = build()
        before = property_names(sim)
        sim.csx = LegacyCSX(sim.csx)
        self.assertFalse(sim.remove_nf2ff_box())
        self.assertIsNotNone(sim.nf2ff)
        self.assertEqual(property_names(sim), before)
