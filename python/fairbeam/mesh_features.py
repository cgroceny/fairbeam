"""Geometric widths for local mesh refinement of polygonal conductors.

Widths come from facing parallel edges with a finite shared length, not distances
between arbitrary vertices. This avoids treating a small corner or a short outline
segment as a narrow conductor. All lengths use the geometry's drawing units.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class FineFeature:
    kind: str
    width: float
    lo: tuple[float, float, float]
    hi: tuple[float, float, float]
    axes: tuple[int, int]
    normal: tuple[float, float, float]
    shape_indices: tuple[int, int]
    edge_indices: tuple[int, int]


def _outline(shape):
    if shape.kind in ("polygon", "linpoly"):
        return shape.normal, np.asarray(shape.pts, float)
    if shape.kind == "box" and shape.flat is not None:
        n = shape.flat
        u, v = (n + 1) % 3, (n + 2) % 3
        return n, np.array([[shape.lo[u], shape.lo[v]], [shape.hi[u], shape.lo[v]],
                            [shape.hi[u], shape.hi[v]], [shape.lo[u], shape.hi[v]]])
    return None


def detect_features(metals, max_width=None):
    """Return strips, notches and coplanar gaps bounded by parallel outline edges.

    Polygon and extruded-polygon in-plane widths are supported. Inter-primitive
    gaps require matching extrusion intervals; overlapping or stacked conductors
    are not interpreted as gaps. Boxes contribute edges only to inter-primitive
    gap detection because the existing mesher already resolves their own widths.
    A feature must extend along its edges by at least its perpendicular width.
    """
    outlines = []
    for shape_index, shape in enumerate(metals):
        outline = _outline(shape)
        if outline is None:
            continue
        n, pts = outline
        u, v = (n + 1) % 3, (n + 2) % 3
        # Normalize winding so that edge orientations have consistent interiors.
        area = np.sum(pts[:, 0] * np.roll(pts[:, 1], -1) - pts[:, 1] * np.roll(pts[:, 0], -1))
        if abs(area) <= 1e-15:
            continue
        edges = []
        for i, (p, q) in enumerate(zip(pts, np.roll(pts, -1, axis=0))):
            if area < 0:
                p, q = q, p
            d = q - p
            length = float(np.linalg.norm(d))
            if length > 1e-9:
                edges.append((i, p, q, d / length))
        # Vectorized bounds reject distant edges before parallel/overlap tests.
        edge_lo = np.array([np.minimum(e[1], e[2]) for e in edges]).reshape(-1, 2)
        edge_hi = np.array([np.maximum(e[1], e[2]) for e in edges]).reshape(-1, 2)
        outlines.append((shape_index, shape, n, u, v, edges, edge_lo, edge_hi))

    metal_lo = np.array([m.lo for m in metals]).reshape(-1, 3)
    metal_hi = np.array([m.hi for m in metals]).reshape(-1, 3)
    outline_lo = np.array([entry[1].lo for entry in outlines]).reshape(-1, 3)
    outline_hi = np.array([entry[1].hi for entry in outlines]).reshape(-1, 3)
    outline_normals = np.array([entry[2] for entry in outlines])
    features = []
    for oi, (si, shape, n, u, v, edges, _, _) in enumerate(outlines):
        nearby_outlines = ((outline_normals == n) &
                           (np.abs(outline_lo[:, n] - shape.lo[n]) <= 1e-9) &
                           (np.abs(outline_hi[:, n] - shape.hi[n]) <= 1e-9))
        if max_width is not None:
            nearby_outlines &= (np.all(outline_hi >= shape.lo - max_width, axis=1) &
                                np.all(outline_lo <= shape.hi + max_width, axis=1))
        nearby_outlines[:oi] = False
        for other_index in np.flatnonzero(nearby_outlines):
            sj, other, nn, _, _, other_edges, other_lo, other_hi = outlines[other_index]
            same = si == sj
            if same and shape.kind == "box":
                continue
            for ei, p, q, tangent in edges:
                perpendicular = np.array([-tangent[1], tangent[0]])
                if max_width is None:
                    nearby = range(len(other_edges))
                else:
                    low_box, high_box = np.minimum(p, q) - max_width, np.maximum(p, q) + max_width
                    nearby = np.flatnonzero(np.all(other_hi >= low_box, axis=1) &
                                            np.all(other_lo <= high_box, axis=1))
                for index in nearby:
                    ej, r, s, other_tangent = other_edges[index]
                    if same and ej <= ei:
                        continue
                    # Consistent outline winding: only opposite-facing edges.
                    if float(np.dot(tangent, other_tangent)) > -1 + 1e-12:
                        continue
                    if abs(float(tangent[0] * other_tangent[1] - tangent[1] * other_tangent[0])) > 1e-8:
                        continue
                    separation = float(np.dot(r - p, perpendicular))
                    width = abs(separation)
                    if width <= 1e-9 or max_width is not None and width > max_width:
                        continue
                    a0, a1 = sorted((float(np.dot(p, tangent)), float(np.dot(q, tangent))))
                    b0, b1 = sorted((float(np.dot(r, tangent)), float(np.dot(s, tangent))))
                    low, high = max(a0, b0), min(a1, b1)
                    if high - low < width * (1 - 1e-8):
                        continue
                    # The interior lies to the left of each directed edge.
                    is_metal = separation > 0
                    if not same and is_metal:
                        continue  # an overlap, not an air gap
                    base = float(np.dot(p, perpendicular))
                    corners = [tangent * t + perpendicular * b
                               for t in (low, high) for b in (base, base + separation)]
                    z = float((shape.lo[n] + shape.hi[n]) / 2)

                    def point(t, fraction):
                        xy = tangent * t + perpendicular * (base + fraction * separation)
                        xyz = np.zeros(3)
                        xyz[n], xyz[u], xyz[v] = z, xy[0], xy[1]
                        return xyz

                    # Check both the region between the edges and their metal sides.
                    # Other outlines can bridge a notch or fill an apparent gap.
                    valid = True
                    def occupied_at(point):
                        hits = np.flatnonzero(np.all(metal_lo <= point + 1e-9, axis=1) &
                                              np.all(metal_hi >= point - 1e-9, axis=1))
                        return any(metals[i].contains(point, tol=1e-9) for i in hits)
                    for t in (low + (high - low) * f for f in (0.15, 0.5, 0.85)):
                        for fraction in (0.2, 0.5, 0.8):
                            occupied = occupied_at(point(t, fraction))
                            if occupied != is_metal:
                                valid = False
                                break
                        if not valid:
                            break
                        # Keep the exterior sample outside the containment tolerance
                        # even when the strip is much thinner than a drawing unit.
                        epsilon = min(0.1, max(min(1e-3, 1e-4 / width), 4e-9 / width))
                        metal_fractions = (epsilon, 1 - epsilon) if is_metal else (-epsilon, 1 + epsilon)
                        if not all(occupied_at(point(t, f)) for f in metal_fractions):
                            valid = False
                            break
                        if is_metal and any(occupied_at(point(t, f)) for f in (-epsilon, 1 + epsilon)):
                            valid = False  # the candidate edge is buried in another conductor
                            break
                    if not valid:
                        continue
                    lo, hi, normal = np.zeros(3), np.zeros(3), np.zeros(3)
                    c = np.asarray(corners)
                    lo[n], hi[n] = shape.lo[n], shape.hi[n]
                    lo[u], lo[v] = c.min(axis=0)
                    hi[u], hi[v] = c.max(axis=0)
                    normal[u], normal[v] = perpendicular
                    features.append(FineFeature("strip" if is_metal else "notch" if same else "gap",
                                                width, tuple(lo), tuple(hi), (u, v), tuple(normal),
                                                (si, sj), (ei, ej)))
    return features
