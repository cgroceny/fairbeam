"""The CLI comparison must not displace flat sources through XML rounding."""
import tempfile
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

import numpy as np
from CSXCAD import ContinuousStructure
from tests.native_gallery_study import catalog, build
from tests.native_gallery_xml import write


class NativeGalleryXmlTest(unittest.TestCase):
    def test_gallery_preserves_native_geometry_material_and_mesh_precision(self):
        with tempfile.TemporaryDirectory() as temporary:
            for case in catalog():
                with self.subTest(model=case["id"]):
                    sim, _ = build(case, 1)
                    path = Path(temporary) / "model.xml"
                    write(sim, path)
                    ET.ElementTree(ET.parse(path).find("ContinuousStructure")).write(path)
                    other = ContinuousStructure()
                    error = other.ReadFromXML(str(path))
                    self.assertFalse(error)
                    for axis in "xyz":
                        np.testing.assert_array_equal(sim.mesh.GetLines(axis), other.GetGrid().GetLines(axis))
                    expected, actual = sim.csx.GetAllProperties(), other.GetAllProperties()
                    self.assertEqual(len(expected), len(actual))
                    for p, q in zip(expected, actual):
                        self.assertEqual((p.GetName(), p.GetTypeString()), (q.GetName(), q.GetTypeString()))
                        if p.GetTypeString() == "Material":
                            for key in ("epsilon", "mue", "kappa", "sigma"):
                                self.assertEqual(p.GetMaterialProperty(key), q.GetMaterialProperty(key))
                        self.assertEqual(p.GetQtyPrimitives(), q.GetQtyPrimitives())
                        for a, b in zip(p.GetAllPrimitives(), q.GetAllPrimitives()):
                            np.testing.assert_array_equal(a.GetBoundBox(), b.GetBoundBox())
                            self.assertEqual(a.GetPriority(), b.GetPriority())
                            if a.GetTypeName() == "Box":
                                np.testing.assert_array_equal(a.GetStart(), b.GetStart())
                                np.testing.assert_array_equal(a.GetStop(), b.GetStop())
                            elif a.GetTypeName() in ("Polygon", "LinPoly"):
                                np.testing.assert_array_equal(a.GetCoords(), b.GetCoords())
                                self.assertEqual(a.GetElevation(), b.GetElevation())
                            elif a.GetTypeName() == "Curve":
                                for i in range(a.GetNumberOfPoints()):
                                    np.testing.assert_array_equal(a.GetPoint(i), b.GetPoint(i))
                            elif a.GetTypeName() == "Polyhedron":
                                for i in range(a.GetNumVertices()):
                                    np.testing.assert_array_equal(a.GetVertex(i), b.GetVertex(i))


if __name__ == "__main__":
    unittest.main()
