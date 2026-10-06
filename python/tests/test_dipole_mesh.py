"""Opt-in short-arm mesh resolution and the frozen gallery mesh."""
import hashlib
import json
import unittest
from pathlib import Path

import numpy as np

from fairbeam.model import load_model, resolve_params


class DipoleMeshTests(unittest.TestCase):
    def setUp(self):
        self.model = load_model(Path(__file__).resolve().parents[1] / "models/dipole.py")

    def build(self, **overrides):
        return self.model.build(resolve_params(self.model.PARAMS, {k: str(v) for k, v in overrides.items()}))

    def test_gallery_defaults_keep_the_reference_mesh(self):
        sim = self.build()
        lines = {a: np.asarray(sim.mesh.GetLines(a)).round(9).tolist() for a in "xyz"}
        digest = hashlib.sha256(json.dumps(lines, sort_keys=True).encode()).hexdigest()
        # Recorded from main before this change: 185,024 intervals, 194,940 native grid cells.
        self.assertEqual(digest, "74ab81ccac184a10518b523d1c248ff34feb510d2cac4d9256e4ec9637a1f742")
        opt = self.build(arm_cells=6)
        for axis in "xyz":
            np.testing.assert_array_equal(sim.mesh.GetLines(axis), opt.mesh.GetLines(axis))

    def test_short_arms_are_resolved_without_moving_the_feed(self):
        values = dict(length=15., width=.6, gap=.4, mesh_div=12, edge_div=3, f_min=.8, f_max=1.2)
        old, new = self.build(**values), self.build(**values, arm_cells=6)
        self.assertEqual(old.ports, new.ports)
        for sign in (-1, 1):
            z = sign * np.asarray(new.mesh.GetLines("z"))
            z = np.sort(z[(z >= .2) & (z <= 7.5)])
            self.assertGreaterEqual(len(z), 6)
            self.assertLessEqual(float(np.diff(z).max()), 7.3 / 6 + 1e-9)
        self.assertGreater(len(new.mesh.GetLines("z")), len(old.mesh.GetLines("z")))
        np.testing.assert_array_equal(new.mesh.GetLines("x"), old.mesh.GetLines("x"))
        np.testing.assert_array_equal(new.mesh.GetLines("y"), old.mesh.GetLines("y"))

    def test_opt_in_without_thirds_rule(self):
        sim = self.build(length=5., gap=.4, f_min=.8, f_max=1.2, arm_cells=6, thirds=0)
        z = np.asarray(sim.mesh.GetLines("z"))
        self.assertGreaterEqual(np.count_nonzero((z >= .2) & (z <= 2.5)), 7)

    def test_auto_mesh_keeps_its_own_resolution(self):
        a, b = self.build(mesh="auto"), self.build(mesh="auto", arm_cells=6)
        for axis in "xyz":
            np.testing.assert_array_equal(a.mesh.GetLines(axis), b.mesh.GetLines(axis))

    def test_gap_must_leave_two_arms(self):
        for gap in (5., 6.):
            with self.subTest(gap=gap), self.assertRaisesRegex(ValueError, "feed gap"):
                self.build(length=5., gap=gap)


if __name__ == "__main__":
    unittest.main()
