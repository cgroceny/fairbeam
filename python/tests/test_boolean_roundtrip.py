"""Materialized boolean boxes have the same build and Python export geometry."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.design import blank_design, check_design, to_python  # noqa: E402
from fairbeam.preview import build_preview  # noqa: E402


class BooleanRoundtrip(unittest.TestCase):
    def test_sheet_difference_and_saved_operands(self):
        design = blank_design("boolean", "Boolean")
        a = {"name": "A", "material": "copper", "primitives": [
            {"kind": "box", "start": [0, 0, 1], "stop": [4, 1, 1]},
            {"kind": "box", "start": [0, 1, 1], "stop": [1, 4, 1]},
        ]}
        b = {"name": "B", "material": "copper", "primitives": [
            {"kind": "box", "start": [0, 0, 1], "stop": [1, 1, 1]},
        ]}
        # A - B, stored as the same ordinary boxes produced by the web designer.
        result = {"name": "A", "material": "copper", "primitives": [
            {"kind": "box", "start": [1, 0, 1], "stop": [4, 1, 1]},
            {"kind": "box", "start": [0, 1, 1], "stop": [1, 4, 1]},
        ], "booleanHistory": {"operation": "subtract", "A": a, "B": b}}
        design["parts"] = [result]
        check_design(design)
        direct = build_preview(None, {}, design=design)["bundle"]["parts"]
        self.assertEqual(len(direct[0]["primitives"]), 2)
        self.assertEqual(sum((p["stop"][0] - p["start"][0]) * (p["stop"][1] - p["start"][1])
                             for p in direct[0]["primitives"]), 6)
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "boolean.py"
            script.write_text(to_python(design))
            exported = build_preview(str(script), {})["bundle"]["parts"]
        self.assertEqual(json.dumps(direct, sort_keys=True), json.dumps(exported, sort_keys=True))


if __name__ == "__main__":
    unittest.main()
