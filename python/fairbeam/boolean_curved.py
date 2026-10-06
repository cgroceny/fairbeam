"""Booleans with curved shapes (cylinders, tubes, cones, spheres, tori, wires, polyhedra): the helpers
of :func:`fairbeam.design.boolean_primitives` that are not about bricks and polygons. It is
src/designer/booleanCurved.ts step by step (the same float arithmetic in the same order), so a live
result recomputed by the build is exactly the one the designer shows: keep the two in step.

A cut-out is a primitive with ``"void": true``: the build makes it openEMS vacuum with a priority just
above its part's own shapes (fairbeam.design.resolve_parts), which erases what lies under it. Its
priority is left out: the build chooses it (host + 0.5).
"""

from __future__ import annotations

import math

AXES = ("x", "y", "z")
#: a cylinder's ring is a regular polygon of this many sides when it is clipped as a prism
FACETS = 64

BOOLEAN_KIND_NAMES = {"box": "a brick", "polygon": "a polygon", "linpoly": "an extruded polygon", "cylinder": "a cylinder",
                      "tube": "a tube", "sphere": "a sphere", "cone": "a cone", "torus": "a torus", "wire": "a wire",
                      "polyhedron": "a polyhedron"}

INTERSECT_MESSAGE = ("Intersect of {a} ({ka}) and {b} ({kb}) is not supported: {why}. Intersect is exact for bricks and polygons, "
                     "coaxial cylinders and tubes, a cylinder clipped by bricks or polygons along its axis, a tube or cone trimmed by "
                     "a brick across its axis, and a shape lying completely inside a brick. Instead, Subtract the part you do not "
                     "want (for example a brick on each side to cut away), or draw the common shape as an extruded polygon or a polyhedron.")
INTERSECT_WHY = {"axes": "the cylinders do not share one axis (crossing or offset cylinders)",
                 "curved": "intersecting curved shapes needs a general solid intersection",
                 "partial": "the shapes do not line up along one axis, or the curved shape is only partly inside the brick"}
HAS_CUT = ("{name} has a cut-out from an earlier Subtract: {op} needs a part without one. Subtract from the result instead, "
           "or restore the operands from the Boolean history.")
B_HAS_CUT = ("{name} has a cut-out of its own (from an earlier Subtract) and cannot be the part that is subtracted. "
             "Restore its operands from the Boolean history first.")
SHEET_VOLUME = ("{op} cannot combine a sheet with a volume: a sheet has zero thickness. "
                "Make both operands sheets or both solids.")
FLAT_CARVER = ("{name} has a sheet (zero thickness) among its shapes: a flat cut-out removes nothing from {a}. Give it a thickness, "
               "or subtract sheets from sheets using bricks and polygons only.")


def in_plane(n: int) -> tuple[int, int]:
    return (n + 1) % 3, (n + 2) % 3


def is_p(p: dict) -> bool:
    return p.get("kind") in ("box", "polygon", "linpoly")


def is_void(p: dict) -> bool:
    return p.get("void") is True


def is_tube(p: dict) -> bool:
    ri = p.get("inner_radius")
    return p.get("kind") == "cylinder" and isinstance(ri, (int, float)) and not isinstance(ri, bool) and ri > 0


def kind_name(p: dict) -> str:
    return BOOLEAN_KIND_NAMES.get("tube" if is_tube(p) else p.get("kind"), str(p.get("kind")))


def unresolve(q: dict) -> dict:
    """A resolved world shape as a design primitive in numbers (the inverse of resolving, for what the
    quarter-turn maps leave: a cylinder keeps its axis form when axis-aligned, a cone and a torus are
    read back from their outline)."""
    kind = q["kind"]
    if kind == "box":
        return {"kind": "box", "start": list(q["start"]), "stop": list(q["stop"])}
    if kind == "cylinder":
        a, c = q["start"], q["stop"]
        inner = {"inner_radius": q["inner_radius"]} if q.get("inner_radius", 0) > 0 else {}
        n = next((k for k in range(3) if all(a[m] == c[m] for m in in_plane(k))), None)
        if n is None:
            return {"kind": "cylinder", "start": list(a), "stop": list(c), "radius": q["radius"], **inner}
        u, v = in_plane(n)
        return {"kind": "cylinder", "axis": AXES[n], "center": [a[u], a[v]], "radius": q["radius"], **inner, "range": [a[n], c[n]]}
    if kind == "sphere":
        return {"kind": "sphere", "center": list(q["center"]), "radius": q["radius"]}
    if kind == "wire":
        return {"kind": "wire", "points": [list(p) for p in q["points"]], "radius": q["radius"]}
    if kind == "polyhedron":
        return {"kind": "polyhedron", "vertices": [list(p) for p in q["vertices"]], "faces": [list(f) for f in q["faces"]]}
    if kind == "cone":
        o, a = q["origin"], q["axis"]
        u, v = in_plane(a)
        hs = [p[1] for p in q["profile"]]
        lo, hi = min(hs), max(hs)

        def radius_at(h):
            return max([0.0] + [p[0] for p in q["profile"] if p[1] == h])

        return {"kind": "cone", "axis": AXES[a], "center": [o[u], o[v]], "bottom_radius": radius_at(lo),
                "top_radius": radius_at(hi), "range": [o[a] + lo, o[a] + hi]}
    if kind == "torus":
        rs = [p[0] for p in q["profile"]]
        hi, lo = max(rs), min(rs)
        return {"kind": "torus", "axis": AXES[q["axis"]], "center": list(q["origin"]), "major_radius": (hi + lo) / 2,
                "minor_radius": (hi - lo) / 2}
    out = {"kind": kind, "normal": AXES[q["normal"]], "elevation": q["elevation"], "points": [[p[0], p[1]] for p in q["points"]]}
    if kind == "linpoly":
        out["length"] = q["length"]
    return out


def design_bounds(p: dict) -> tuple[list, list]:
    """The bounds of a design primitive in numbers."""
    from .design import prim_bbox, resolve_primitive
    return prim_bbox(resolve_primitive(p, {}, "", 0))


def flat_axis(p: dict) -> int:
    """The normal axis of a flat (zero thickness) primitive, else -1."""
    kind = p["kind"]
    if kind == "box":
        z = [k for k in range(3) if float(p["start"][k]) == float(p["stop"][k])]
        return z[0] if len(z) == 1 else -1
    if kind == "polygon":
        return AXES.index(p["normal"])
    if kind == "linpoly":
        return AXES.index(p["normal"]) if float(p["length"]) == 0 else -1
    return -1


def snap_to_sheet(p: dict, n: int, z0: float) -> dict:
    """A cut-out only removes a sheet (zero thickness, normal axis ``n``, at ``z0``) it reaches: measured with
    openEMS, a volume whose face lies ON the sheet cuts it as well as one crossing it, while one with a gap, or
    a flat one (zero thickness), cuts nothing. A face that lies on the sheet up to rounding is made to lie
    exactly on it (a brick, extrusion, cylinder or cone), so the cut does not depend on the last bit of an
    expression; the rest (a shape already crossing, a sphere, a shape lying away) stays as it is."""
    lo3, hi3 = design_bounds(p)
    lo, hi = lo3[n], hi3[n]
    tol = 1e-9 * max(1.0, abs(z0))
    snap_lo, snap_hi = lo != z0 and abs(lo - z0) <= tol, hi != z0 and abs(hi - z0) <= tol
    if not snap_lo and not snap_hi:
        return p
    nlo = z0 if snap_lo else lo
    nhi = z0 if snap_hi else hi

    def put(a, b):
        return [nlo, nhi] if a <= b else [nhi, nlo]

    kind = p["kind"]
    if kind == "box":
        start, stop = list(p["start"]), list(p["stop"])
        start[n], stop[n] = put(float(p["start"][n]), float(p["stop"][n]))
        return {**p, "start": start, "stop": stop}
    if kind == "linpoly" and AXES.index(p["normal"]) == n:
        return {**p, "elevation": nlo, "length": nhi - nlo}
    if kind == "cylinder" and "axis" in p and AXES.index(p["axis"]) == n:
        return {**p, "range": put(float(p["range"][0]), float(p["range"][1]))}
    if kind == "cylinder" and "start" in p:
        start, stop = list(p["start"]), list(p["stop"])
        u, v = in_plane(n)
        if start[u] != stop[u] or start[v] != stop[v]:
            return p
        start[n], stop[n] = put(float(p["start"][n]), float(p["stop"][n]))
        return {**p, "start": start, "stop": stop}
    if kind == "cone" and AXES.index(p["axis"]) == n:
        return {**p, "range": [nlo, nhi]}
    return p


def coaxial_rects(shapes: list):
    """Cylinders and tubes that share one axis (axis-aligned, the same in-plane centre) as (radius, height)
    rectangles ``(axis, centre, rects)``; None when any shape is something else or the axes differ."""
    axis, centre, rects = -1, [0.0, 0.0], []
    for p in shapes:
        if p["kind"] != "cylinder" or "axis" not in p:
            return None
        n = AXES.index(p["axis"])
        c = [float(p["center"][0]), float(p["center"][1])]
        tol = 1e-9 * max(1.0, abs(c[0]), abs(c[1]))
        if axis < 0:
            axis, centre = n, c
        elif n != axis or abs(c[0] - centre[0]) > tol or abs(c[1] - centre[1]) > tol:
            return None
        lo, hi = min(float(p["range"][0]), float(p["range"][1])), max(float(p["range"][0]), float(p["range"][1]))
        rects.append([(float(p.get("inner_radius", 0)), float(p["radius"])), (lo, hi), (0.0, 0.0)])
    return None if axis < 0 else (axis, centre, rects)


def cylinder_cell(axis: int, centre: list, r0: float, r1: float, h0: float, h1: float) -> dict:
    """A cell of radii r0..r1 and heights h0..h1 as a cylinder (r0 = 0) or a tube."""
    out = {"kind": "cylinder", "axis": AXES[axis], "center": [centre[0], centre[1]], "radius": r1}
    if r0 > 0:
        out["inner_radius"] = r0
    out["range"] = [h0, h1]
    return out


def facet_ring(centre: list, r: float, n: int = FACETS) -> list:
    """The regular FACETS-gon with its vertices on a cylinder's circle, counter-clockwise in (u, v) of its axis."""
    return [[centre[0] + r * math.cos(2 * math.pi * k / n), centre[1] + r * math.sin(2 * math.pi * k / n)] for k in range(n)]


def same_ring(a: list, b: list, eps: float) -> bool:
    """Two counter-clockwise rings with the same vertices (any start)."""
    if len(a) != len(b):
        return False

    def close(p, q):
        return abs(p[0] - q[0]) <= eps and abs(p[1] - q[1]) <= eps

    at = next((i for i, q in enumerate(b) if close(a[0], q)), -1)
    return at >= 0 and all(close(p, b[(i + at) % len(b)]) for i, p in enumerate(a))
