"""Solver-free round trips for exact native affine geometry imports."""

import math
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from fairbeam import Simulation
from fairbeam.design import _pt, build, to_python, transform_maps
from fairbeam.example_design import (ExampleConversionError, _read_design, _similarity_transforms,
                                     _slot_axis, _slot_paths)
from fairbeam.geometry import read_structure
from fairbeam.model import load_model


def _matrix(rx, ry, rz, scale=1.0, reflected=False, offset=(0.0, 0.0, 0.0)):
    ax, ay, az = (math.radians(v) for v in (rx, ry, rz))
    cx, sx = math.cos(ax), math.sin(ax)
    cy, sy = math.cos(ay), math.sin(ay)
    cz, sz = math.cos(az), math.sin(az)
    rxm = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]], dtype=float)
    rym = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], dtype=float)
    rzm = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]], dtype=float)
    mirror = np.diag([-1.0, 1.0, 1.0]) if reflected else np.eye(3)
    result = np.eye(4)
    result[:3, :3] = scale * (rzm @ rym @ rxm @ mirror)
    result[:3, 3] = offset
    return result


class TransformedExampleImportTests(unittest.TestCase):
    def test_decomposed_maps_reconstruct_gimbal_and_reflected_matrices(self):
        points = ([0.0, 0.0, 0.0], [1.0, 2.0, 3.0], [-8.0, 1.0, 0.5])
        for ry in (90, -90, 89.999999999, 0):
            for reflected in (False, True):
                matrix = _matrix(37, ry, -21, scale=1.4, reflected=reflected,
                                 offset=(3, -4, 2))
                transforms = _similarity_transforms(matrix)
                scale, offset = transform_maps(transforms, {}, "parts[0]")[0]
                for point in points:
                    with self.subTest(ry=ry, reflected=reflected, point=point):
                        expected = matrix[:3, :3] @ np.asarray(point) + matrix[:3, 3]
                        np.testing.assert_allclose(_pt(scale, offset, point), expected, rtol=0, atol=1e-9)

    def test_similarity_decomposition_rejects_distortion(self):
        shear = np.eye(4)
        shear[0, 1] = 0.1
        nonuniform = np.diag([1.0, 2.0, 1.0, 1.0])
        near_shear = np.eye(4)
        near_shear[0, 1] = 2e-12
        near_nonuniform = np.diag([1.0, 1.0 + 2e-12, 1.0, 1.0])
        for matrix in (shear, nonuniform, near_shear, near_nonuniform):
            with self.subTest(matrix=matrix.tolist()), self.assertRaises(ExampleConversionError):
                _similarity_transforms(matrix)

    def test_native_rotated_box_sheet_and_reflection_round_trip(self):
        sim = Simulation(1e9, 2e9, max_timesteps=8)
        prop = sim.metal("affine metal")
        rotated = _matrix(0, 0, 45, scale=1.25, offset=(3, -2, 1))
        reflected = _matrix(15, 35, -20, scale=0.75, reflected=True, offset=(-1, 4, 2))

        box = prop.AddBox(priority=7, start=[0, 0, 0], stop=[4, 2, 1])
        box.AddTransform("Matrix", rotated)
        sheet = prop.AddBox(priority=7, start=[0, 0, 2], stop=[2, 1, 2])
        sheet.AddTransform("Matrix", rotated)
        reflected_box = prop.AddBox(priority=7, start=[0, 0, 4], stop=[3, 2, 5])
        reflected_box.AddTransform("Matrix", reflected)

        module = SimpleNamespace(build=lambda _values: sim)
        _, core = _read_design(module, {}, Path("affine-python-model.py"))

        self.assertEqual([part["name"] for part in core["parts"]], ["affine metal", "affine metal [2]"])
        self.assertEqual([len(part["primitives"]) for part in core["parts"]], [2, 1])
        self.assertTrue(all(p["kind"] == "box" for part in core["parts"] for p in part["primitives"]))
        self.assertIn({"type": "mirror", "plane": "x", "keep": False}, core["parts"][1]["transforms"])
        transform_paths = [path for path in _slot_paths(core)
                           if len(path) > 2 and path[0] == "parts" and path[2] == "transforms"]
        self.assertTrue(transform_paths)
        self.assertTrue(all(_slot_axis(core, path) is None for path in transform_paths))

        lines = {axis: [-20.0, -10.0, 0.0, 10.0, 20.0] for axis in "xyz"}
        design = {
            "schema": "fairbeam.design/1",
            "model": {"id": "affine-import", "name": "Affine import"},
            "params": [],
            "simulation": core["simulation"],
            "materials": core["materials"],
            "parts": core["parts"],
            "ports": [],
            "resistors": [],
            "far_field": {"enabled": False},
            "mesh": {"mode": "manual", "lines": lines},
        }
        rebuilt = build(design, {})
        source_primitives = [p for part in read_structure(sim.csx, sim.materials)[0]
                             for p in part["primitives"]]
        rebuilt_primitives = [p for part in read_structure(rebuilt.csx, rebuilt.materials)[0]
                              for p in part["primitives"]]
        source_bounds = sorted(tuple(v for corner in p["bbox"] for v in corner) for p in source_primitives)
        rebuilt_bounds = sorted(tuple(v for corner in p["bbox"] for v in corner) for p in rebuilt_primitives)
        np.testing.assert_allclose(rebuilt_bounds, source_bounds, rtol=0, atol=1e-6)

        # The Python panel regenerates a model from Design and imports it again to decide whether
        # the user's source can be preserved. Exercise that geometry-only leg without Run/solver.
        with tempfile.TemporaryDirectory(prefix="fairbeam-affine-roundtrip-") as temp:
            script_path = Path(temp) / "affine_roundtrip.py"
            script_path.write_text(to_python(design), encoding="utf-8")
            generated = load_model(script_path)
            generated_sim = generated.build({})
            _, generated_core = _read_design(generated, {}, script_path)
            self.assertEqual([len(part["primitives"]) for part in generated_core["parts"]], [2, 1])
            generated_primitives = [p for part in read_structure(generated_sim.csx, generated_sim.materials)[0]
                                    for p in part["primitives"]]
            generated_bounds = sorted(tuple(v for corner in p["bbox"] for v in corner)
                                      for p in generated_primitives)
            np.testing.assert_allclose(generated_bounds, source_bounds, rtol=0, atol=1e-6)


if __name__ == "__main__":
    unittest.main()
