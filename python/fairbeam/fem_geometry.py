"""Bounded, export-only geometry preparation for the experimental Elmer FEM path.

This module is deliberately independent of CSXCAD and solver execution. It evaluates Fairbeam
design geometry, accepts only resolved axis-aligned box volumes, and creates a conforming
rectilinear mesh with Elmer's native linear hexahedra. It does not implement an FEM solve.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any

MM_TO_M = 1e-3
MAX_BOXES = 500
MAX_REGIONS = 128
MAX_GRID_CELLS = 100_000
MAX_GRID_NODES = 250_000
MAX_BOUNDARY_QUADS = 1_000_000

# Elmer mesh.boundary IDs 1..6 are a stable axis/side contract for all exported meshes.
_EXTERIOR_FACES = (
    ("x_min", 0, -1),
    ("x_max", 0, 1),
    ("y_min", 1, -1),
    ("y_max", 1, 1),
    ("z_min", 2, -1),
    ("z_max", 2, 1),
)


class FEMGeometryError(ValueError):
    """A design or mesh request outside this module's supported FEM geometry subset."""


@dataclass(frozen=True)
class StructuredMesh:
    """Serial linear-hexahedron Elmer mesh records, with node IDs implicit in tuple order.

    ``nodes`` contains ``(x_m, y_m, z_m)`` coordinates. Each ``elements`` record is
    ``(body_id, (eight one-based node IDs))``. Each boundary record is
    ``(boundary_id, parent_element_id, (four one-based node IDs))``; the second parent is zero
    when written, as required for an exterior boundary face.
    """

    nodes: tuple[tuple[float, float, float], ...]
    elements: tuple[tuple[int, tuple[int, ...]], ...]
    boundary_elements: tuple[tuple[int, int, tuple[int, ...]], ...]
    regions: tuple[dict[str, Any], ...]
    boundary_tags: tuple[dict[str, Any], ...]
    domain_mm: tuple[float, float, float, float, float, float]
    max_cell_mm: float
    cell_counts: tuple[int, int, int]
    full_grid_cell_count: int
    excluded_pec_cell_count: int
    min_jacobian_determinant_m3: float
    source: dict[str, Any]

    def summary(self) -> dict[str, Any]:
        """Return compact, JSON-safe mesh provenance and material/interface tag metadata."""
        region_element_counts = {int(r["id"]): 0 for r in self.regions}
        for body_id, _ in self.elements:
            region_element_counts[body_id] = region_element_counts.get(body_id, 0) + 1
        tag_counts = {int(t["id"]): 0 for t in self.boundary_tags}
        for tag_id, _, _ in self.boundary_elements:
            tag_counts[tag_id] = tag_counts.get(tag_id, 0) + 1

        regions = []
        for region in self.regions:
            record = dict(region)
            record["element_count"] = region_element_counts.get(int(region["id"]), 0)
            regions.append(record)
        tags = []
        for tag in self.boundary_tags:
            record = dict(tag)
            record["quad_count"] = tag_counts.get(int(tag["id"]), 0)
            tags.append(record)

        return {
            "schema": "fairbeam.elmer-mesh-input/1",
            "status": "mesh_input_ready",
            "backend": "elmer-native-mesh-input",
            "solver_executed": False,
            "mesh_format": "Elmer serial ASCII mesh",
            "element_family": "linear_hexahedron",
            "element_code": 808,
            "boundary_element_family": "linear_quadrilateral",
            "boundary_element_code": 404,
            "coordinate_units": "m",
            "design_length_units": "mm",
            "domain_mm": list(self.domain_mm),
            "domain_m": [v * MM_TO_M for v in self.domain_mm],
            "max_cell_mm": self.max_cell_mm,
            "max_cell_m": self.max_cell_mm * MM_TO_M,
            "structured_cell_counts_xyz": list(self.cell_counts),
            "full_grid_cell_count": self.full_grid_cell_count,
            "hexahedron_count": len(self.elements),
            "excluded_pec_cell_count": self.excluded_pec_cell_count,
            "node_count": len(self.nodes),
            "boundary_quad_count": len(self.boundary_elements),
            "min_jacobian_determinant_m3": self.min_jacobian_determinant_m3,
            "regions": regions,
            "material_ids": {str(r["id"]): {"name": r["name"], "kind": r["kind"]}
                             for r in regions},
            "boundary_tags": tags,
            "interface_tags": [t for t in tags if t["kind"] == "pec_interface"],
            "source": dict(self.source),
            "limitations": [
                "Axis-aligned box volumes only; no general CAD, imported meshes, sheets or wires.",
                "PEC boxes are removed from the bulk mesh and represented by tagged interface faces.",
                "This artifact contains no SIF, solver execution or RF result.",
            ],
        }


@dataclass(frozen=True)
class _Box:
    part_name: str
    material_name: str
    region_id: int
    kind: str
    start_mm: tuple[float, float, float]
    stop_mm: tuple[float, float, float]
    where: str


def _finite(value: Any, what: str) -> float:
    if isinstance(value, bool):
        raise FEMGeometryError(f"{what} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        raise FEMGeometryError(f"{what} must be a finite number") from None
    if not math.isfinite(number):
        raise FEMGeometryError(f"{what} must be a finite number")
    return number


def _triplet(values, what: str) -> tuple[float, float, float]:
    if not isinstance(values, (list, tuple)) or len(values) != 3:
        raise FEMGeometryError(f"{what} must contain exactly three values")
    return tuple(_finite(v, what) for v in values)


def _slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_")
    return slug or "unnamed"


def _is_given(value) -> bool:
    return value is not None and value != ""


def _material_properties(material: dict, names: dict) -> dict[str, Any]:
    from .design import evaluate

    label = material["name"]
    kind = material["kind"]
    display_fields = {"name", "kind", "label", "color", "library", "description"}
    if kind == "metal":
        extra = set(material) - display_fields
        if extra:
            detail = ", ".join(sorted(extra))
            raise FEMGeometryError(
                f"metal material {label!r} has unsupported property/properties: {detail}; "
                "only lossless PEC volumes are supported"
            )
        return {"kind": "pec", "eps_r": None, "mu_r": None}

    if kind != "dielectric":
        raise FEMGeometryError(f"material {label!r} is not a dielectric or PEC")
    allowed_fields = display_fields | {"eps_r", "mu_r", "tan_d", "tan_d_freq"}
    extra = set(material) - allowed_fields
    if extra:
        detail = ", ".join(sorted(extra))
        raise FEMGeometryError(f"dielectric material {label!r} has unsupported property/properties: {detail}")
    try:
        eps_r = _finite(evaluate(material.get("eps_r", 1), names), f"material {label!r} eps_r")
        mu_r = _finite(evaluate(material.get("mu_r", 1), names), f"material {label!r} mu_r")
        tan_d = _finite(evaluate(material.get("tan_d", 0), names), f"material {label!r} tan_d")
    except (ValueError, TypeError, ZeroDivisionError, OverflowError) as exc:
        raise FEMGeometryError(f"cannot evaluate material {label!r}: {exc}") from None
    if eps_r <= 0 or mu_r <= 0:
        raise FEMGeometryError(f"material {label!r} must have positive eps_r and mu_r")
    if tan_d != 0:
        raise FEMGeometryError(f"lossy dielectric material {label!r} is unsupported")
    return {"kind": "dielectric", "eps_r": eps_r, "mu_r": mu_r}


def _resolve_design(design, overrides: dict | None):
    if design is None:
        if overrides:
            raise FEMGeometryError("parameter overrides require a Fairbeam design")
        return None, [], {"id": "vacuum-control", "name": "Vacuum control"}

    from .design import (check_design, design_params, read_design, resolve_names, resolve_parts)
    from .model import resolve_params

    if isinstance(design, (str, Path)):
        data = read_design(design)
        source_path = str(Path(design).resolve())
    elif isinstance(design, dict):
        data = design
        source_path = None
    else:
        raise FEMGeometryError("design must be a Fairbeam design dictionary, .design.json path, or None")
    check_design(data)
    for index, part in enumerate(data.get("parts", [])):
        for field in ("transforms", "cuts", "booleanHistory"):
            if part.get(field):
                raise FEMGeometryError(
                    f"parts[{index}].{field} is unsupported by the axis-aligned box mesher"
                )
    unsupported_inputs = ("ports", "resistors", "lumped_elements", "lumpedElements",
                          "excitations", "excitation")
    for field in unsupported_inputs:
        if data.get(field):
            raise FEMGeometryError(f"design {field} are unsupported by this geometry-only FEM foundation")
    simulation = data.get("simulation", {})
    if isinstance(simulation, dict):
        for field in ("lumped_elements", "lumpedElements", "excitations", "excitation"):
            if simulation.get(field):
                raise FEMGeometryError(f"simulation {field} are unsupported by this geometry-only FEM foundation")
    supplied = overrides or {}
    if not isinstance(supplied, dict):
        raise FEMGeometryError("overrides must be a mapping of parameter names to values")
    normalized = {str(k): str(v) for k, v in supplied.items()}
    try:
        values = resolve_params(design_params(data), normalized)
        names = resolve_names(data, values)
        parts = resolve_parts(data, names)
    except (ValueError, KeyError, TypeError) as exc:
        raise FEMGeometryError(f"cannot evaluate design geometry: {exc}") from None
    source = {"design_id": data.get("model", {}).get("id", ""),
              "design_name": data.get("model", {}).get("name", ""),
              "design_path": source_path,
              "resolved_parameters": values}
    return data, parts, source


def _normalize_domain(domain_mm, boxes: list[_Box], tol: float):
    if domain_mm is None:
        if not boxes:
            raise FEMGeometryError("domain_mm is required when a design has no supported box geometry")
        lows = tuple(min(box.start_mm[a] for box in boxes) for a in range(3))
        highs = tuple(max(box.stop_mm[a] for box in boxes) for a in range(3))
        domain = lows + highs
    else:
        if not isinstance(domain_mm, (list, tuple)) or len(domain_mm) != 6:
            raise FEMGeometryError("domain_mm must be [xmin, ymin, zmin, xmax, ymax, zmax]")
        domain = tuple(_finite(v, "domain_mm") for v in domain_mm)
    lo, hi = domain[:3], domain[3:]
    if any(hi[a] - lo[a] <= tol for a in range(3)):
        raise FEMGeometryError("domain_mm must have positive extent along x, y and z")
    for box in boxes:
        if any(box.start_mm[a] < lo[a] - tol or box.stop_mm[a] > hi[a] + tol for a in range(3)):
            raise FEMGeometryError(f"box {box.where} falls outside domain_mm")
    return tuple(domain)


def _merge_breaks(values: list[float], tol: float) -> tuple[list[float], dict[float, int]]:
    values.sort()
    merged = []
    for value in values:
        if not merged or value - merged[-1] > tol:
            merged.append(value)
    lookup = {}
    for value in values:
        index = min(range(len(merged)), key=lambda i: abs(merged[i] - value))
        if abs(merged[index] - value) > tol:
            raise FEMGeometryError("could not resolve a box face on the structured mesh")
        lookup[value] = index
    return merged, lookup


def _refined_axis(breaks: list[float], max_cell_mm: float):
    coords = []
    breakpoint_indices = [0] * len(breaks)
    for i, (lo, hi) in enumerate(zip(breaks, breaks[1:])):
        if i == 0:
            coords.append(lo)
        breakpoint_indices[i] = len(coords) - 1
        divisions = max(1, math.ceil((hi - lo) / max_cell_mm))
        for step in range(1, divisions + 1):
            coords.append(hi if step == divisions else lo + (hi - lo) * step / divisions)
        breakpoint_indices[i + 1] = len(coords) - 1
    return coords, breakpoint_indices


def _box_index_range(box: _Box, axis: int, breaks: list[float], breakpoint_indices, tol: float):
    low = min(range(len(breaks)), key=lambda i: abs(breaks[i] - box.start_mm[axis]))
    high = min(range(len(breaks)), key=lambda i: abs(breaks[i] - box.stop_mm[axis]))
    if abs(breaks[low] - box.start_mm[axis]) > tol or abs(breaks[high] - box.stop_mm[axis]) > tol:
        raise FEMGeometryError(f"could not align box {box.where} with mesh planes")
    return breakpoint_indices[low], breakpoint_indices[high]


def _overlaps(left: _Box, right: _Box, tol: float) -> bool:
    return all(min(left.stop_mm[a], right.stop_mm[a]) - max(left.start_mm[a], right.start_mm[a]) > tol
               for a in range(3))


def _cell_index(i: int, j: int, k: int, nx: int, ny: int) -> int:
    return i + nx * (j + ny * k)


def _node_index(i: int, j: int, k: int, nx: int, ny: int) -> int:
    return 1 + i + nx * (j + ny * k)


def _cell_node_ids(i: int, j: int, k: int, nx: int, ny: int) -> tuple[int, ...]:
    n000 = _node_index(i, j, k, nx, ny)
    n100 = _node_index(i + 1, j, k, nx, ny)
    n110 = _node_index(i + 1, j + 1, k, nx, ny)
    n010 = _node_index(i, j + 1, k, nx, ny)
    n001 = _node_index(i, j, k + 1, nx, ny)
    n101 = _node_index(i + 1, j, k + 1, nx, ny)
    n111 = _node_index(i + 1, j + 1, k + 1, nx, ny)
    n011 = _node_index(i, j + 1, k + 1, nx, ny)
    return (n000, n100, n110, n010, n001, n101, n111, n011)


def _face_node_ids(cell_nodes: tuple[int, ...], side: str) -> tuple[int, int, int, int]:
    # Ordering follows Elmer's 808 local node convention and points out of the parent cell.
    faces = {
        "x_min": (0, 4, 7, 3),
        "x_max": (1, 2, 6, 5),
        "y_min": (0, 1, 5, 4),
        "y_max": (2, 3, 7, 6),
        "z_min": (0, 3, 2, 1),
        "z_max": (4, 5, 6, 7),
    }
    return tuple(cell_nodes[n] for n in faces[side])


def mesh_design(
    design=None,
    *,
    domain_mm=None,
    max_cell_mm: float = 25.0,
    overrides: dict | None = None,
) -> StructuredMesh:
    """Evaluate a Fairbeam design and prepare a bounded conforming Elmer hexahedral mesh.

    ``design`` may be a design dictionary, a ``.design.json`` path, or ``None`` for a vacuum
    control volume. Design dimensions, ``domain_mm`` and ``max_cell_mm`` are in millimetres;
    generated node coordinates are converted to metres exactly once. Every box face becomes a
    structured-grid plane, so neighboring dielectric and PEC interfaces are conforming.

    Supported solids are axis-aligned rectangular boxes with constant, lossless isotropic
    dielectric material or PEC. PEC volumes are omitted from bulk elements, and their interfaces
    with active mesh cells receive named quad boundary tags. Overlapping boxes, ports and unsupported
    primitives or material loss are rejected.
    """
    max_cell_mm = _finite(max_cell_mm, "max_cell_mm")
    if max_cell_mm <= 0:
        raise FEMGeometryError("max_cell_mm must be greater than zero")

    data, parts, source = _resolve_design(design, overrides)

    # Material 1 is always the background vacuum region. Fairbeam part materials retain stable IDs
    # in first-use order; even PEC regions have an ID in metadata although they have no bulk cells.
    regions: list[dict[str, Any]] = [{"id": 1, "name": "vacuum", "kind": "vacuum",
                                     "eps_r": 1.0, "mu_r": 1.0, "source_parts": []}]
    region_ids: dict[str, int] = {}
    resolved_names = {}
    if data is not None:
        from .design import resolve_names
        from .model import resolve_params

        values = source.get("resolved_parameters", {})
        resolved_names = resolve_names(data, values)

    boxes: list[_Box] = []
    for part in parts:
        if part.get("voids"):
            raise FEMGeometryError(f"void/cut-out geometry in part {part['name']!r} is unsupported")
        if data is not None:
            original = data["parts"][part["index"]]
            if original.get("cuts"):
                raise FEMGeometryError(f"cut geometry in part {part['name']!r} is unsupported")
        material = part["material"]
        material_name = material["name"]
        if material_name not in region_ids:
            props = _material_properties(material, resolved_names)
            rid = len(regions) + 1
            region_ids[material_name] = rid
            regions.append({"id": rid, "name": material_name, **props, "source_parts": []})
        rid = region_ids[material_name]
        if part["name"] not in regions[rid - 1]["source_parts"]:
            regions[rid - 1]["source_parts"].append(part["name"])
        for primitive in part["prims"]:
            where = primitive.get("where", f"parts[{part['index']}]")
            if primitive.get("kind") != "box":
                raise FEMGeometryError(f"{where}: only resolved box volumes are supported")
            if primitive.get("_matrix") or primitive.get("void"):
                raise FEMGeometryError(f"{where}: transformed CAD and void boxes are unsupported")
            start = _triplet(primitive.get("start"), f"{where}.start")
            stop = _triplet(primitive.get("stop"), f"{where}.stop")
            low = tuple(min(start[a], stop[a]) for a in range(3))
            high = tuple(max(start[a], stop[a]) for a in range(3))
            boxes.append(_Box(part["name"], material_name, rid, regions[rid - 1]["kind"], low, high, where))
            if len(boxes) > MAX_BOXES:
                raise FEMGeometryError(f"at most {MAX_BOXES} resolved box volumes are supported")
    if len(regions) > MAX_REGIONS:
        raise FEMGeometryError(f"at most {MAX_REGIONS} material regions are supported")

    scale = max((abs(v) for box in boxes for v in box.start_mm + box.stop_mm), default=1.0)
    span = max((box.stop_mm[a] - box.start_mm[a] for box in boxes for a in range(3)), default=1.0)
    tol = max(1e-12, max(scale, span, 1.0) * 1e-12)
    for box in boxes:
        if any(box.stop_mm[a] - box.start_mm[a] <= tol for a in range(3)):
            raise FEMGeometryError(f"{box.where}: sheets and zero-thickness boxes are unsupported")
    for index, left in enumerate(boxes):
        for right in boxes[index + 1:]:
            if _overlaps(left, right, tol):
                raise FEMGeometryError(
                    f"overlapping box volumes are ambiguous ({left.where} and {right.where}); "
                    "split them into non-overlapping boxes"
                )

    domain = _normalize_domain(domain_mm, boxes, tol)
    lo, hi = domain[:3], domain[3:]
    if boxes:
        for axis in range(3):
            if any(abs(box.start_mm[axis] - lo[axis]) <= tol and box.start_mm[axis] < lo[axis]
                   or abs(box.stop_mm[axis] - hi[axis]) <= tol and box.stop_mm[axis] > hi[axis]
                   for box in boxes):
                raise FEMGeometryError("a box lies just outside domain_mm; correct its evaluated bounds")

    axis_breaks = []
    for axis in range(3):
        values = [lo[axis], hi[axis]]
        for box in boxes:
            values.extend((box.start_mm[axis], box.stop_mm[axis]))
        merged, _ = _merge_breaks(values, tol)
        # Domain ends must remain the actual outer coordinates after tolerance merging.
        merged[0], merged[-1] = lo[axis], hi[axis]
        axis_breaks.append(merged)

    axis_cell_counts = []
    for breaks in axis_breaks:
        total = 0
        for left, right in zip(breaks, breaks[1:]):
            ratio = (right - left) / max_cell_mm
            if not math.isfinite(ratio):
                raise FEMGeometryError("requested max_cell_mm would create an unbounded mesh")
            total += max(1, math.ceil(ratio))
            if total > MAX_GRID_CELLS:
                break
        axis_cell_counts.append(total)
    if math.prod(axis_cell_counts) > MAX_GRID_CELLS:
        raise FEMGeometryError(
            f"structured grid would exceed the {MAX_GRID_CELLS}-cell limit at max_cell_mm={max_cell_mm}"
        )
    if math.prod(v + 1 for v in axis_cell_counts) > MAX_GRID_NODES:
        raise FEMGeometryError(f"structured grid would exceed the {MAX_GRID_NODES}-node limit")

    axes_mm = []
    breakpoint_indices = []
    for breaks in axis_breaks:
        coordinates, indices = _refined_axis(breaks, max_cell_mm)
        axes_mm.append(coordinates)
        breakpoint_indices.append(indices)
    axes_m = [tuple(v * MM_TO_M for v in axis) for axis in axes_mm]
    cells_xyz = tuple(len(axis) - 1 for axis in axes_mm)
    full_cell_count = math.prod(cells_xyz)
    node_grid_count = math.prod(v + 1 for v in cells_xyz)
    if full_cell_count > MAX_GRID_CELLS:
        raise FEMGeometryError(f"structured grid has {full_cell_count} cells; limit is {MAX_GRID_CELLS}")
    if node_grid_count > MAX_GRID_NODES:
        raise FEMGeometryError(f"structured grid has {node_grid_count} nodes; limit is {MAX_GRID_NODES}")

    nx, ny, nz = cells_xyz
    states = [1] * full_cell_count
    for box in boxes:
        ranges = [_box_index_range(box, axis, axis_breaks[axis], breakpoint_indices[axis], tol)
                  for axis in range(3)]
        (i0, i1), (j0, j1), (k0, k1) = ranges
        if min(i1 - i0, j1 - j0, k1 - k0) <= 0:
            raise FEMGeometryError(f"{box.where}: box is smaller than the structured-grid tolerance")
        for k in range(k0, k1):
            for j in range(j0, j1):
                base = nx * (j + ny * k)
                for i in range(i0, i1):
                    idx = base + i
                    if states[idx] != 1:
                        # The geometric overlap check above should make this unreachable.
                        raise FEMGeometryError(f"material assignment conflict at {box.where}")
                    states[idx] = box.region_id

    pec_regions = {int(r["id"]): r for r in regions if r["kind"] == "pec"}
    boundary_tags = [
        {"id": i + 1, "name": name, "kind": "exterior", "axis": "xyz"[axis],
         "side": "min" if direction < 0 else "max"}
        for i, (name, axis, direction) in enumerate(_EXTERIOR_FACES)
    ]
    pec_boundary_ids = {}
    for rid, region in pec_regions.items():
        tag_id = len(boundary_tags) + 1
        pec_boundary_ids[rid] = tag_id
        boundary_tags.append({"id": tag_id, "name": f"PEC_INTERFACE_{_slug(region['name'])}",
                              "kind": "pec_interface", "region_id": rid,
                              "region_name": region["name"]})

    # Add only active (vacuum/dielectric) hexes. The cell-to-element table lets boundary records
    # name their real parent element after PEC volume exclusion.
    grid_node_x, grid_node_y = nx + 1, ny + 1
    elements = []
    parent_ids = [0] * full_cell_count
    cell_counts_by_region = {int(r["id"]): 0 for r in regions}
    volumes_by_region = {int(r["id"]): 0.0 for r in regions}
    jacobians = []
    for k in range(nz):
        dz = axes_m[2][k + 1] - axes_m[2][k]
        for j in range(ny):
            dy = axes_m[1][j + 1] - axes_m[1][j]
            for i in range(nx):
                dx = axes_m[0][i + 1] - axes_m[0][i]
                volume = dx * dy * dz
                jacobian = volume / 8.0
                if not math.isfinite(jacobian) or jacobian <= 0:
                    raise FEMGeometryError("structured mesh contains a nonpositive hexahedron Jacobian")
                jacobians.append(jacobian)
                idx = _cell_index(i, j, k, nx, ny)
                rid = states[idx]
                cell_counts_by_region[rid] = cell_counts_by_region.get(rid, 0) + 1
                volumes_by_region[rid] = volumes_by_region.get(rid, 0.0) + volume
                if rid in pec_regions:
                    continue
                conn = _cell_node_ids(i, j, k, grid_node_x, grid_node_y)
                parent_ids[idx] = len(elements) + 1
                elements.append((rid, conn))

    boundary_elements = []
    side_by_axis = {0: ("x_min", "x_max"), 1: ("y_min", "y_max"), 2: ("z_min", "z_max")}
    exterior_id = {tag["name"]: int(tag["id"]) for tag in boundary_tags if tag["kind"] == "exterior"}

    def emit_face(side: str, i: int, j: int, k: int, parent: int, tag_id: int):
        conn = _cell_node_ids(i, j, k, grid_node_x, grid_node_y)
        boundary_elements.append((tag_id, parent, _face_node_ids(conn, side)))

    for k in range(nz):
        for j in range(ny):
            for i in range(nx):
                idx = _cell_index(i, j, k, nx, ny)
                rid = states[idx]
                if rid in pec_regions:
                    continue
                parent = parent_ids[idx]
                for axis, side_index, neighbor in (
                    (0, 0, _cell_index(i - 1, j, k, nx, ny) if i > 0 else -1),
                    (0, 1, _cell_index(i + 1, j, k, nx, ny) if i + 1 < nx else -1),
                    (1, 0, _cell_index(i, j - 1, k, nx, ny) if j > 0 else -1),
                    (1, 1, _cell_index(i, j + 1, k, nx, ny) if j + 1 < ny else -1),
                    (2, 0, _cell_index(i, j, k - 1, nx, ny) if k > 0 else -1),
                    (2, 1, _cell_index(i, j, k + 1, nx, ny) if k + 1 < nz else -1),
                ):
                    side = side_by_axis[axis][side_index]
                    if neighbor < 0:
                        emit_face(side, i, j, k, parent, exterior_id[side])
                    elif states[neighbor] in pec_regions:
                        emit_face(side, i, j, k, parent, pec_boundary_ids[states[neighbor]])
    if len(boundary_elements) > MAX_BOUNDARY_QUADS:
        raise FEMGeometryError(f"mesh has {len(boundary_elements)} boundary quads; limit is {MAX_BOUNDARY_QUADS}")

    total_volume = math.prod((hi[a] - lo[a]) * MM_TO_M for a in range(3))
    assigned_volume = math.fsum(volumes_by_region.values())
    if not math.isclose(assigned_volume, total_volume, rel_tol=1e-10, abs_tol=1e-18):
        raise FEMGeometryError("material assignment does not cover the requested domain exactly")

    # Compact away nodes used only by excluded conductor cells. All elements and boundary quads
    # still share the same global node IDs, so interfaces remain conforming.
    used_nodes = set()
    for _, conn in elements:
        used_nodes.update(conn)
    for _, _, conn in boundary_elements:
        used_nodes.update(conn)
    if len(used_nodes) > MAX_GRID_NODES:
        raise FEMGeometryError(f"mesh has {len(used_nodes)} nodes; limit is {MAX_GRID_NODES}")
    old_to_new = {old_id: new_id for new_id, old_id in enumerate(sorted(used_nodes), 1)}

    def node_coordinates(old_id: int):
        zero = old_id - 1
        ix = zero % grid_node_x
        iy = (zero // grid_node_x) % grid_node_y
        iz = zero // (grid_node_x * grid_node_y)
        return axes_m[0][ix], axes_m[1][iy], axes_m[2][iz]

    nodes = tuple(node_coordinates(old_id) for old_id in sorted(used_nodes))
    compact_elements = tuple((body_id, tuple(old_to_new[n] for n in conn)) for body_id, conn in elements)
    compact_boundary = tuple((tag_id, parent_id, tuple(old_to_new[n] for n in conn))
                             for tag_id, parent_id, conn in boundary_elements)
    excluded = sum(cell_counts_by_region.get(rid, 0) for rid in pec_regions)
    for region in regions:
        rid = int(region["id"])
        region["cell_count"] = cell_counts_by_region.get(rid, 0)
        region["volume_m3"] = volumes_by_region.get(rid, 0.0)
        if region["kind"] == "pec":
            region["volume_role"] = "excluded_conductor_volume"
    if not compact_elements:
        raise FEMGeometryError("all cells are PEC; no active finite-element volume remains")

    return StructuredMesh(
        nodes=nodes,
        elements=compact_elements,
        boundary_elements=compact_boundary,
        regions=tuple(regions),
        boundary_tags=tuple(boundary_tags),
        domain_mm=domain,
        max_cell_mm=max_cell_mm,
        cell_counts=cells_xyz,
        full_grid_cell_count=full_cell_count,
        excluded_pec_cell_count=excluded,
        min_jacobian_determinant_m3=min(jacobians),
        source=source,
    )


def _mesh_names(mesh: StructuredMesh) -> str:
    lines = ["! ----- names for bodies -----"]
    element_counts = {}
    for body_id, _ in mesh.elements:
        element_counts[body_id] = element_counts.get(body_id, 0) + 1
    for region in mesh.regions:
        if region["kind"] == "pec" or not element_counts.get(int(region["id"]), 0):
            continue
        lines.append(f"$ R{region['id']}_{_slug(region['name'])} = {region['id']}")
    lines.append("! ----- names for boundaries -----")
    for tag in mesh.boundary_tags:
        lines.append(f"$ B{tag['id']}_{_slug(tag['name'])} = {tag['id']}")
    return "\n".join(lines) + "\n"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_elmer_mesh(mesh: StructuredMesh, out_dir: str | Path) -> dict[str, Any]:
    """Write a fresh native Elmer mesh directory and its compact metadata; never launches a solver.

    The output path must not exist. Native files follow the serial ASCII layout documented in the
    ElmerSolver Manual: ``mesh.header``, ``mesh.nodes``, ``mesh.elements`` and ``mesh.boundary``.
    ``mesh.names`` and ``mesh.metadata.json`` carry readable Fairbeam tags and provenance.
    """
    if not isinstance(mesh, StructuredMesh):
        raise TypeError("mesh must be the StructuredMesh returned by mesh_design")
    out = Path(out_dir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=False)

    tag_counts = {int(tag["id"]): 0 for tag in mesh.boundary_tags}
    for tag_id, _, _ in mesh.boundary_elements:
        tag_counts[tag_id] = tag_counts.get(tag_id, 0) + 1
    regions = []
    element_counts = {}
    for body_id, _ in mesh.elements:
        element_counts[body_id] = element_counts.get(body_id, 0) + 1
    for region in mesh.regions:
        record = dict(region)
        record["element_count"] = element_counts.get(int(region["id"]), 0)
        regions.append(record)
    tags = []
    for tag in mesh.boundary_tags:
        record = dict(tag)
        record["quad_count"] = tag_counts.get(int(tag["id"]), 0)
        tags.append(record)

    header_types = []
    if mesh.boundary_elements:
        header_types.append((404, len(mesh.boundary_elements)))
    if mesh.elements:
        header_types.append((808, len(mesh.elements)))
    header = (f"{len(mesh.nodes)} {len(mesh.elements)} {len(mesh.boundary_elements)}\n"
              f"{len(header_types)}\n" + "".join(f"{code} {count}\n" for code, count in header_types))
    (out / "mesh.header").write_text(header, encoding="ascii", newline="\n")

    with (out / "mesh.nodes").open("w", encoding="ascii", newline="\n") as file:
        for node_id, (x, y, z) in enumerate(mesh.nodes, 1):
            file.write(f"{node_id} -1 {x:.17g} {y:.17g} {z:.17g}\n")
    with (out / "mesh.elements").open("w", encoding="ascii", newline="\n") as file:
        for element_id, (body_id, conn) in enumerate(mesh.elements, 1):
            file.write(f"{element_id} {body_id} 808 " + " ".join(str(n) for n in conn) + "\n")
    with (out / "mesh.boundary").open("w", encoding="ascii", newline="\n") as file:
        for boundary_id, (tag_id, parent_id, conn) in enumerate(mesh.boundary_elements, 1):
            file.write(f"{boundary_id} {tag_id} {parent_id} 0 404 " + " ".join(str(n) for n in conn) + "\n")
    (out / "mesh.names").write_text(_mesh_names(mesh), encoding="ascii", newline="\n")

    metadata = {
        "schema": "fairbeam.elmer-mesh-input/1",
        "status": "mesh_input_ready",
        "backend": "elmer-native-mesh-input",
        "solver_executed": False,
        "mesh_format": "Elmer serial ASCII mesh",
        "coordinate_units": "m",
        "design_length_units": "mm",
        "domain_mm": list(mesh.domain_mm),
        "domain_m": [v * MM_TO_M for v in mesh.domain_mm],
        "max_cell_mm": mesh.max_cell_mm,
        "max_cell_m": mesh.max_cell_mm * MM_TO_M,
        "structured_cell_counts_xyz": list(mesh.cell_counts),
        "full_grid_cell_count": mesh.full_grid_cell_count,
        "node_count": len(mesh.nodes),
        "hexahedron_count": len(mesh.elements),
        "boundary_quad_count": len(mesh.boundary_elements),
        "excluded_pec_cell_count": mesh.excluded_pec_cell_count,
        "min_jacobian_determinant_m3": mesh.min_jacobian_determinant_m3,
        "regions": regions,
        "material_ids": {str(r["id"]): {"name": r["name"], "kind": r["kind"]}
                         for r in regions},
        "boundary_tags": tags,
        "interface_tags": [t for t in tags if t["kind"] == "pec_interface"],
        "source": dict(mesh.source),
        "files": {},
        "limitations": [
            "Axis-aligned box volumes only; no general CAD, imported meshes, sheets or wires.",
            "PEC boxes are removed from the bulk mesh and represented by tagged interface faces.",
            "This artifact contains no SIF, solver execution or RF result.",
        ],
    }
    for name in ("mesh.header", "mesh.nodes", "mesh.elements", "mesh.boundary", "mesh.names"):
        metadata["files"][name] = {"sha256": _sha256(out / name), "bytes": (out / name).stat().st_size}
    meta_path = out / "mesh.metadata.json"
    meta_path.write_text(json.dumps(metadata, indent=2, allow_nan=False) + "\n", encoding="utf-8", newline="\n")
    return metadata
