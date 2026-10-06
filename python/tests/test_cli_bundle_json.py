import json
import math
import tempfile
import unittest
from pathlib import Path

import numpy as np

from fairbeam.cli import _write


class CliBundleJsonTest(unittest.TestCase):
    def test_write_normalizes_non_finite_far_field_values(self):
        bundle = {
            "schema": "fairbeam.project/1",
            "name": "Synthetic far field",
            "model": {"id": "synthetic"},
            "mesh": {"total_cells": 1},
            "results": {
                "bands": [],
                "farfield": [{
                    "directivity_dbi": [[-math.inf, 1.25], [np.inf, np.nan]],
                    "sample_array": np.array([2.5, -np.inf]),
                    "finite_scalar": np.float64(3.75),
                }],
            },
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            out_dir = Path(temp_dir)
            path = _write(bundle, out_dir, "synthetic")

            text = path.read_text(encoding="utf-8")
            written = json.loads(text)
            farfield = written["results"]["farfield"][0]
            self.assertEqual(farfield["directivity_dbi"], [[None, 1.25], [None, None]])
            self.assertEqual(farfield["sample_array"], [2.5, None])
            self.assertEqual(farfield["finite_scalar"], 3.75)
            self.assertNotIn("NaN", text)
            self.assertNotIn("Infinity", text)
            self.assertEqual(list(out_dir.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
