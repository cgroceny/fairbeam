"""A finite lumped-source footprint is explicit and keeps its physical size."""
from pathlib import Path
import unittest
import numpy as np
from fairbeam.model import load_model, resolve_params


class PatchFeedFootprintTest(unittest.TestCase):
    def setUp(self):
        self.model = load_model(Path(__file__).resolve().parents[1] / "models/patch_antenna.py")

    def build(self, **overrides):
        return self.model.build(resolve_params(self.model.PARAMS, overrides))

    def test_default_preserves_ideal_line_source(self):
        sim = self.build()
        self.assertEqual(sim.ports[0]["start"], [-6, 0, 0])
        self.assertEqual(sim.ports[0]["stop"], [-6, 0, 1.524])
        self.assertEqual(np.prod([len(sim.mesh.GetLines(a)) - 1 for a in "xyz"]), 263568)
        self.assertEqual(sim.max_timesteps, 30000)
        self.assertEqual(self.build(max_timesteps=350000).max_timesteps, 350000)

    def test_refinement_keeps_finite_footprint_fixed_in_both_mesh_modes(self):
        for mode in ("auto", "manual"):
            previous = None
            for count in (2, 4, 8):
                sim = self.build(mesh=mode, feed_width=1, feed_cells=count)
                self.assertEqual(sim.ports[0]["start"], [-6.5, -.5, 0])
                self.assertEqual(sim.ports[0]["stop"], [-5.5, .5, 1.524])
                for axis, center in (("x", -6), ("y", 0)):
                    lines = np.asarray(sim.mesh.GetLines(axis))
                    local = lines[(lines >= center - .5) & (lines <= center + .5)]
                    self.assertLessEqual(np.diff(local).max(), 1/count + 1e-9)
                cells = np.prod([len(sim.mesh.GetLines(a)) - 1 for a in "xyz"])
                if previous is not None:self.assertGreater(cells, previous)
                previous = cells

    def test_invalid_or_disconnected_footprint_is_rejected(self):
        for overrides in ({"feed_width": -1}, {"feed_width": 40}, {"feed_width": 1, "feed_x": -16}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                self.build(**overrides)
        values = resolve_params(self.model.PARAMS, {})
        with self.assertRaises(ValueError):
            self.model.build({**values, "feed_cells": 2.5})

    def test_conversion_preserves_port_topology_and_mesh_alignment(self):
        from fairbeam.example_design import convert_example
        from fairbeam.design import build

        source = Path(__file__).resolve().parents[1] / "models/patch_antenna.py"
        line = convert_example(source, "line_patch", "Line patch")
        self.assertNotIn("feed_width", {p["key"] for p in line["params"]})
        notes = " ".join(n["text"] for n in line["model"]["conversion"]["notes"])
        self.assertIn("feed_width=0.0", notes)
        finite = convert_example(source, "finite_patch", "Finite patch", {"feed_width": "1"})
        defaults = {p["key"]: p["default"] for p in finite["params"]}
        self.assertIn("feed_width", defaults)
        for width in (0.9, 1.1):
            actual = build(finite, {**defaults, "feed_width": width})
            expected = self.build(feed_width=width)
            np.testing.assert_allclose(actual.ports[0]["start"], expected.ports[0]["start"], atol=1e-6)
            np.testing.assert_allclose(actual.ports[0]["stop"], expected.ports[0]["stop"], atol=1e-6)


if __name__ == "__main__":
    unittest.main()
