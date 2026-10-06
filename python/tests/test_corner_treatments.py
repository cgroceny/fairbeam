"""The designer corner tool stores real native polygons, also used by Python export."""
import json
from pathlib import Path
import tempfile
import unittest
from fairbeam.design import blank_design, check_design, to_python
from fairbeam.preview import build_preview

class CornerTreatmentGeometry(unittest.TestCase):
    def test_native_and_python_export_match(self):
        shapes = json.loads((Path(__file__).parent / "fixtures" / "corner_treatments.json").read_text())
        for name, primitive in shapes.items():
            with self.subTest(name=name):
                d = blank_design("corners", "Corners")
                d["parts"] = [{"name": name, "material": "copper", "component": "antenna",
                    "primitives": [primitive], "transforms": [{"type": "rotate", "axis": "z",
                    "center": [5, 3, 1], "angle": 45}]}]
                check_design(d)
                reopened = json.loads(json.dumps(d))
                direct = build_preview(None, {}, design=reopened)["bundle"]
                with tempfile.TemporaryDirectory() as tmp:
                    path = Path(tmp) / "corners.py"
                    path.write_text(to_python(d))
                    generated = build_preview(str(path), {})["bundle"]
                self.assertEqual(direct["parts"], generated["parts"])
                self.assertEqual(direct["mesh"], generated["mesh"])
