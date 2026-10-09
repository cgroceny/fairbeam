"""Bounded design-to-Elmer mesh-input preparation; no native solver is launched here."""

import copy
import json
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.design import blank_design  # noqa: E402
from fairbeam.fem_geometry import (FEMGeometryError, mesh_design, write_elmer_mesh)  # noqa: E402


def design_with(parts, materials=None):
    design = blank_design("fem-geometry-test", "FEM geometry test")
    design["materials"] = materials or [
        {"name": "substrate", "kind": "dielectric", "eps_r": 4, "tan_d": 0},
    ]
    design["parts"] = copy.deepcopy(parts)
    design["ports"] = []
    design["resistors"] = []
    return design


def block(name, material, start, stop):
    return {"name": name, "material": material, "primitives": [
        {"kind": "box", "start": list(start), "stop": list(stop)},
    ]}


class VacuumCavityControl(unittest.TestCase):
    def test_original_cavity_mesh_is_a_reproducible_control(self):
        mesh = mesh_design(None, domain_mm=(0, 0, 0, 100, 50, 200), max_cell_mm=25)
        summary = mesh.summary()
        self.assertEqual(mesh.cell_counts, (4, 2, 8))
        self.assertEqual((len(mesh.nodes), len(mesh.elements), len(mesh.boundary_elements)), (135, 64, 112))
        self.assertEqual(summary["hexahedron_count"], 64)
        self.assertEqual(summary["solver_executed"], False)
        self.assertAlmostEqual(mesh.regions[0]["volume_m3"], 1e-3, places=15)
        self.assertGreater(mesh.min_jacobian_determinant_m3, 0)

        counts = Counter(tag_id for tag_id, _, _ in mesh.boundary_elements)
        self.assertEqual(counts, Counter({1: 16, 2: 16, 3: 32, 4: 32, 5: 8, 6: 8}))
        self.assertEqual([tag["id"] for tag in mesh.boundary_tags], [1, 2, 3, 4, 5, 6])

    def test_refined_cavity_counts_match_the_native_control_refinement(self):
        mesh = mesh_design(None, domain_mm=(0, 0, 0, 100, 50, 200), max_cell_mm=12.5)
        self.assertEqual(mesh.cell_counts, (8, 4, 16))
        self.assertEqual((len(mesh.nodes), len(mesh.elements), len(mesh.boundary_elements)), (765, 512, 448))

    def test_export_writes_native_elmer_mesh_files_and_metadata(self):
        mesh = mesh_design(None, domain_mm=(0, 0, 0, 100, 50, 200), max_cell_mm=25)
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "cavity"
            metadata = write_elmer_mesh(mesh, output)
            self.assertEqual((output / "mesh.header").read_text(encoding="ascii"),
                             "135 64 112\n2\n404 112\n808 64\n")
            self.assertEqual((output / "mesh.elements").read_text(encoding="ascii").splitlines()[0],
                             "1 1 808 1 2 7 6 16 17 22 21")
            self.assertEqual(len((output / "mesh.nodes").read_text(encoding="ascii").splitlines()), 135)
            self.assertEqual(len((output / "mesh.boundary").read_text(encoding="ascii").splitlines()), 112)
            self.assertEqual(metadata["solver_executed"], False)
            self.assertEqual(set(metadata["files"]), {
                "mesh.header", "mesh.nodes", "mesh.elements", "mesh.boundary", "mesh.names",
            })
            saved = json.loads((output / "mesh.metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(saved["structured_cell_counts_xyz"], [4, 2, 8])
            with self.assertRaises(FileExistsError):
                write_elmer_mesh(mesh, output)


class EvaluatedDesignGeometry(unittest.TestCase):
    def test_parameter_evaluation_unit_conversion_and_pec_interface_tags(self):
        design = design_with([
            block("left", "substrate", [0, 0, 0], [1, 1, 1]),
            block("electrode", "copper", [1, 0, 0], [2, 1, 1]),
            block("right", "substrate", [2, 0, 0], [3, 1, 1]),
        ], [
            {"name": "substrate", "kind": "dielectric", "eps_r": "eps", "tan_d": 0},
            {"name": "copper", "kind": "metal"},
        ])
        design["params"].append({"key": "eps", "default": 4})
        mesh = mesh_design(design, domain_mm=(0, 0, 0, 3, 1, 1), max_cell_mm=1,
                           overrides={"eps": 3.2})

        self.assertEqual(mesh.cell_counts, (3, 1, 1))
        self.assertEqual((len(mesh.elements), mesh.excluded_pec_cell_count), (2, 1))
        self.assertAlmostEqual(max(node[0] for node in mesh.nodes), 0.003)
        self.assertAlmostEqual(mesh.regions[1]["eps_r"], 3.2)
        self.assertEqual(mesh.regions[2]["kind"], "pec")
        summary = mesh.summary()
        self.assertEqual(summary["regions"][2]["element_count"], 0)
        pec_tag = summary["interface_tags"][0]
        self.assertEqual(pec_tag["name"], "PEC_INTERFACE_copper")
        self.assertEqual(pec_tag["quad_count"], 2)
        self.assertEqual([tag["id"] for tag in summary["boundary_tags"][:6]], [1, 2, 3, 4, 5, 6])

        for _, conn in mesh.elements:
            self.assertEqual(len(conn), 8)
            self.assertEqual(len(set(conn)), 8)
            p000, p100, _, p010, p001, *_ = (mesh.nodes[node_id - 1] for node_id in conn)
            dx = p100[0] - p000[0]
            dy = p010[1] - p000[1]
            dz = p001[2] - p000[2]
            self.assertGreater(dx * dy * dz, 0.0)

    def test_adjacent_boxes_share_nodes_and_volume_material_interfaces_are_conforming(self):
        design = design_with([
            block("left", "substrate", [0, 0, 0], [1, 1, 1]),
            block("right", "airlike", [1, 0, 0], [2, 1, 1]),
        ], [
            {"name": "substrate", "kind": "dielectric", "eps_r": 4, "tan_d": 0},
            {"name": "airlike", "kind": "dielectric", "eps_r": 2, "tan_d": 0},
        ])
        mesh = mesh_design(design, domain_mm=(0, 0, 0, 2, 1, 1), max_cell_mm=1)
        self.assertEqual(len(mesh.elements), 2)
        self.assertEqual(len(mesh.nodes), 12)
        self.assertEqual(len(mesh.boundary_elements), 10)  # no artificial material-interface boundary
        left_nodes = set(mesh.elements[0][1])
        right_nodes = set(mesh.elements[1][1])
        self.assertEqual(len(left_nodes & right_nodes), 4)

    def test_volumetric_overlap_is_rejected_even_when_priorities_differ(self):
        parts = [
            block("one", "substrate", [0, 0, 0], [2, 2, 2]),
            block("two", "second", [1, 1, 1], [3, 3, 3]),
        ]
        parts[0]["primitives"][0]["priority"] = 1
        parts[1]["primitives"][0]["priority"] = 20
        design = design_with(parts, [
            {"name": "substrate", "kind": "dielectric", "eps_r": 4, "tan_d": 0},
            {"name": "second", "kind": "dielectric", "eps_r": 2, "tan_d": 0},
        ])
        with self.assertRaisesRegex(FEMGeometryError, "overlapping box volumes"):
            mesh_design(design, domain_mm=(0, 0, 0, 3, 3, 3), max_cell_mm=1)

    def test_unsupported_transforms_are_rejected_before_geometry_expansion(self):
        design = design_with([block("part", "substrate", [0, 0, 0], [1, 1, 1])])
        design["parts"][0]["transforms"] = [
            {"type": "translate", "copies": 1000, "step": [2, 0, 0]},
        ]
        with self.assertRaisesRegex(FEMGeometryError, r"parts\[0\]\.transforms"):
            mesh_design(design, domain_mm=(0, 0, 0, 2000, 1, 1), max_cell_mm=1)

    def test_boolean_and_cut_geometry_are_rejected_before_resolution(self):
        for field, value in (("cuts", [{"start": [0, 0, 0], "stop": [1, 1, 0]}]),
                             ("booleanHistory", {"operation": "subtract"})):
            with self.subTest(field=field):
                design = design_with([block("part", "substrate", [0, 0, 0], [1, 1, 1])])
                design["parts"][0][field] = value
                with self.assertRaisesRegex(FEMGeometryError, field):
                    mesh_design(design, domain_mm=(0, 0, 0, 1, 1, 1), max_cell_mm=1)

    def test_ports_and_lumped_element_definitions_are_rejected(self):
        design = design_with([block("part", "substrate", [0, 0, 0], [1, 1, 1])])
        design["ports"] = [{"type": "lumped", "number": 1, "R": 50,
                             "start": [0, 0, 0], "stop": [0, 0, 1], "direction": "z"}]
        with self.assertRaisesRegex(FEMGeometryError, "ports"):
            mesh_design(design)
        design["ports"] = []
        design["lumped_elements"] = [{"name": "feed"}]
        with self.assertRaisesRegex(FEMGeometryError, "lumped_elements"):
            mesh_design(design)

    def test_loss_dispersion_tensor_and_nonbox_geometry_are_rejected(self):
        unsupported_materials = [
            {"name": "lossy", "kind": "dielectric", "eps_r": 4, "tan_d": 0.01},
            {"name": "dispersive", "kind": "dielectric", "eps_r": 4, "dispersion": {"type": "debye"}},
            {"name": "tensor", "kind": "dielectric", "eps_r": 4, "epsilon_tensor": [4, 3, 2]},
            {"name": "conductive", "kind": "dielectric", "eps_r": 4, "conductivity": 1},
            {"name": "lossy-copper", "kind": "metal", "conductivity": 5.8e7},
        ]
        for material in unsupported_materials:
            with self.subTest(material=material["name"]):
                design = design_with([block("part", material["name"], [0, 0, 0], [1, 1, 1])], [material])
                with self.assertRaises(FEMGeometryError):
                    mesh_design(design, domain_mm=(0, 0, 0, 1, 1, 1), max_cell_mm=1)

        design = design_with([{
            "name": "cylinder", "material": "substrate", "primitives": [
                {"kind": "cylinder", "axis": "z", "center": [0.5, 0.5], "range": [0, 1], "radius": 0.4},
            ],
        }])
        with self.assertRaisesRegex(FEMGeometryError, "only resolved box volumes"):
            mesh_design(design, domain_mm=(0, 0, 0, 1, 1, 1), max_cell_mm=1)

    def test_tiny_cell_request_is_rejected_by_preflight_without_allocating_grid(self):
        with self.assertRaisesRegex(FEMGeometryError, "100000-cell limit"):
            mesh_design(None, domain_mm=(0, 0, 0, 100, 50, 200), max_cell_mm=1e-100)


if __name__ == "__main__":
    unittest.main()
