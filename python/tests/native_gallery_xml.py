"""Preserve native getter precision when replaying the gallery through XML.

CSXCAD's default writer formats parameterized primitive coordinates at six
decimal places in scientific notation, but grid lines at higher precision.
Never use that mismatch to test an on-grid zero-thickness source.
This adapter deliberately rejects shapes outside the measured gallery.
"""
import xml.etree.ElementTree as ET
import numpy as np

def number(value):
    return format(float(value), ".17g")


def xyz(node, values):
    for key, value in zip("XYZ", values):
        node.set(key, number(value))


def write(sim, path):
    sim.fdtd.Write2XML(str(path))
    tree = ET.parse(path)
    grid = tree.find(".//RectilinearGrid")
    for axis in "xyz":
        grid.find(axis.upper() + "Lines").text = ",".join(map(number, sim.mesh.GetLines(axis)))
    props = {int(p.get("ID")): p for p in tree.find(".//Properties")}
    for prop in sim.csx.GetAllProperties():
        node = props[prop.GetID()]
        if prop.GetTypeString() == "Material":
            if not prop.GetIsotropy():
                raise ValueError("anisotropic material outside gallery control")
            attrs = node.find("Property")
            for key in ("Epsilon", "Mue", "Kappa", "Sigma"):
                values = attrs.get(key).split(",")
                values[0] = number(prop.GetMaterialProperty(key.lower()))
                attrs.set(key, ",".join(values))
        shapes, original = list(node.find("Primitives")), prop.GetAllPrimitives()
        if len(shapes) != len(original):
            raise ValueError("primitive count changed during XML export")
        for element, primitive in zip(shapes, original):
            kind = primitive.GetTypeName()
            if primitive.HasTransform():
                raise ValueError("transformed primitive outside gallery control")
            if kind == "Box":
                xyz(element.find("P1"), primitive.GetStart())
                xyz(element.find("P2"), primitive.GetStop())
            elif kind in ("Polygon", "LinPoly"):
                element.set("Elevation", number(primitive.GetElevation()))
                if kind == "LinPoly":
                    element.set("Length", number(primitive.GetLength()))
                for vertex, (x, y) in zip(element.findall("Vertex"), np.asarray(primitive.GetCoords()).T):
                    vertex.set("X1", number(x))
                    vertex.set("X2", number(y))
            elif kind == "Curve":
                for index, vertex in enumerate(element.findall("Vertex")):
                    xyz(vertex, primitive.GetPoint(index))
            elif kind == "Polyhedron":
                for index, vertex in enumerate(element.findall("Vertex")):
                    vertex.text = ",".join(map(number, primitive.GetVertex(index)))
            else:
                raise ValueError("unsupported gallery primitive " + kind)
    tree.write(path, encoding="utf-8", xml_declaration=True)
