"""Automatic FDTD meshing from the CSXCAD geometry (docs/MESHING.md).

    sim = Simulation(...)
    ... geometry, ports ...
    sim.auto_mesh()                  # instead of hand-written mesh.AddLine(...) + smooth_mesh()
    sim.add_nf2ff_box(...)           # after the mesh: the NF2FF box is placed on the grid

The rules follow the lessons in docs/VALIDATION.md (and the practice of openEMS' own tutorials,
pyems and easyMesh4openEMS; this is an independent implementation):

1. **Fixed lines** where the field or the model needs them exactly: planes of zero-thickness metal
   sheets and polygons, dielectric faces, the port and lumped-element gaps (along their direction
   and in their flat axis), the domain limits. User lines already on the grid are kept.
2. **Metal edges**: the openEMS *thirds rule*, a line 1/3 of the local edge cell inside and 2/3
   outside each free metal edge parallel to an axis. An edge that sits closer than one edge cell to
   another feature (a narrow slot, a port plane, the opposite edge of a strip) gets a line exactly
   on the edge instead. Edges where two metal shapes join are not edges and get nothing.
   Slanted polygon edges get lines at their vertex coordinates.
3. **Narrow metal** (a strip, arm or slot no wider than two local cells) gets at least
   ``metal_cells`` cells across, and zero-thickness sheets get two cells of the same size on each
   side, normal to the sheet (a strip in a coarse normal mesh behaves like a much fatter conductor).
   The free end of such an arm (a wire, a strip dipole's tip) gets cells about as large as the arm is
   wide, grading up from there: with a local cell as large as lambda/20 beyond the tip, a thin
   dipole resonates several per cent low.
4. **Dielectrics**: ``dielectric_cells`` cells across thin layers, and a maximum cell of
   lambda_min / (cells_per_wavelength sqrt(eps_r)) inside the dielectric.
5. **Air**: graded (ratio <= ``max_ratio``) up to lambda_min / ``air_cells_per_wavelength``
   when supplied, otherwise lambda_min / ``cells_per_wavelength``. Metal edge placement and
   dielectric resolution retain ``cells_per_wavelength``. The mesh has
   lambda(f_min)/4 of padding to absorbing boundaries (plus the PML cells for PML boundaries; none
   toward PEC/PMC boundaries, which are the domain edge).
6. **No slivers**: optional lines closer than 0.4 cells to a fixed line are dropped; fixed lines
   closer than ``min_cell`` are merged unless both are hard geometry (reported as a warning).
"""

from __future__ import annotations

import bisect
import math
import os

import numpy as np

C0 = 299_792_458.0
METALS = ("Metal", "ConductingSheet")
SKIP = ("ProbeBox", "DumpBox", "Excitation")
# a material this conductive (S/m) is a metal (a lossy metal volume, simulation.LossyMetal), meshed
# like one; a dielectric's loss conductivity is below 10 S/m at any antenna frequency
CONDUCTOR_KAPPA = 1e4


def _conductor(prop) -> bool:
    return float(np.max(np.atleast_1d(prop.GetMaterialProperty("kappa")))) >= CONDUCTOR_KAPPA
PRIO_DOMAIN, PRIO_HARD, PRIO_EDGE, PRIO_SOFT = 4, 3, 2, 1
# a polygon with more slanted edges than this is a traced outline: its vertex lines are optional
TRACED_EDGES = 16
# The free end of a thin conductor (a wire-like cylinder, a strip arm) is a capacitive tip whose fringing
# field sets the electrical length of the whole arm: a coarse cell beyond the end lengthens the arm and
# a dipole of 1 mm wires meshed at 20 cells per wavelength came out 6 % low. The cells next to such an
# end are TIP_CELL times the conductor's cross-section (its larger transverse dimension), then grade up.
TIP_CELL = 1.0
# Cells next to a zero-thickness sheet, normal to it, as a fraction of the local maximum cell: res / SHEET_CELL
SHEET_CELL = 2.0


# ---------------------------------------------------------------------------- geometry extraction

class Shape:
    """One primitive in a form the mesher can query: bbox, kind, and an inside test for metal."""

    def __init__(self, kind, prop, lo, hi, **kw):
        self.kind, self.prop = kind, prop
        self.lo, self.hi = np.asarray(lo, float), np.asarray(hi, float)
        self.__dict__.update(kw)

    @property
    def flat(self):
        """Axis of zero extent (a sheet), or None."""
        z = np.where(np.isclose(self.lo, self.hi, atol=1e-9))[0]
        return int(z[0]) if len(z) == 1 else None

    def contains(self, p, tol=1e-7):
        p = np.asarray(p, float)
        # the box test in plain floats (the same comparisons as on the arrays; it runs for every
        # sample of every metal edge)
        box = self.__dict__.setdefault("_box", {})
        if tol not in box:
            box[tol] = ((self.lo - tol).tolist(), (self.hi + tol).tolist())
        (lx, ly, lz), (hx, hy, hz) = box[tol]
        px, py, pz = p.tolist()
        if px < lx or py < ly or pz < lz or px > hx or py > hy or pz > hz:
            return False
        if self.kind in ("polygon", "linpoly"):
            n = self.normal
            u, v = (n + 1) % 3, (n + 2) % 3
            if len(self.pts) > _VECTOR_POLY:
                index = self.__dict__.setdefault("_edge_index", {})
                if tol not in index:
                    index[tol] = _EdgeIndex(self.pts, tol)
                return index[tol].inside(float(p[u]), float(p[v]))
            return _point_in_poly(p[u], p[v], self.pts, tol)
        if self.kind in ("cylinder", "cylindricalshell"):
            a, b = self.start, self.stop
            ax = b - a
            t = np.dot(p - a, ax) / np.dot(ax, ax)
            r = np.linalg.norm(p - (a + t * ax))
            return -1e-9 <= t <= 1 + 1e-9 and self.r_inner - tol <= r <= self.radius + tol
        if self.kind == "sphere":
            return np.linalg.norm(p - self.center) <= self.radius + tol
        if self.kind == "rotpoly":
            d = p - self.origin
            r = np.sqrt(sum(d[k] ** 2 for k in range(3) if k != self.axis))
            return _point_in_poly(r, d[self.axis], self.profile, tol)
        if self.kind in ("curve", "wire"):
            if self.radius <= 0:
                return False
            q = self.points
            for a, b in zip(q[:-1], q[1:]):
                ab = b - a
                t = np.clip(np.dot(p - a, ab) / max(np.dot(ab, ab), 1e-30), 0, 1)
                if np.linalg.norm(p - (a + t * ab)) <= self.radius + tol:
                    return True
            return False
        if self.kind == "polyhedron":
            # convex polyhedra (the typical slab/frustum): inside every face plane, oriented by the centroid
            c = self.vertices.mean(axis=0)
            for f in self.faces:
                v = self.vertices[f]
                n = np.cross(v[1] - v[0], v[2] - v[0])
                if np.linalg.norm(n) < 1e-12:
                    continue
                if np.dot(n, c - v[0]) > 0:
                    n = -n
                if np.dot(n, p - v[0]) > tol * np.linalg.norm(n):
                    return False
            return True
        return True


_VECTOR_POLY = 16   # outlines with more points than this are tested with numpy (the same arithmetic)


def _poly_edges(pts):
    """Per-edge arrays of a closed outline for :func:`_point_in_edges`."""
    q = np.asarray(pts, float)
    x1, y1 = q[:, 0].copy(), q[:, 1].copy()
    x2, y2 = np.roll(x1, -1), np.roll(y1, -1)
    return (x1, y1, x2, y2, np.minimum(x1, x2), np.maximum(x1, x2), np.minimum(y1, y2), np.maximum(y1, y2),
            np.maximum(1.0, np.hypot(x2 - x1, y2 - y1)))


def _point_in_edges(x, y, edges, tol=1e-7):
    """:func:`_point_in_poly` over all edges at once: the same per-edge arithmetic, so the same
    answer (on the boundary counts as inside; else the parity of the crossings to the right)."""
    x1, y1, x2, y2, xmin, xmax, ymin, ymax, length = edges
    near = (xmin - tol <= x) & (x <= xmax + tol) & (ymin - tol <= y) & (y <= ymax + tol)
    if near.any():
        k = np.nonzero(near)[0]
        cross = (x2[k] - x1[k]) * (y - y1[k]) - (y2[k] - y1[k]) * (x - x1[k])
        if np.any(np.abs(cross) <= tol * length[k]):
            return True
    k = np.nonzero((y1 > y) != (y2 > y))[0]
    if not len(k):
        return False
    xc = (x2[k] - x1[k]) * (y - y1[k]) / (y2[k] - y1[k]) + x1[k]
    return bool(np.count_nonzero(x < xc) % 2)


class _EdgeIndex:
    """:func:`_point_in_edges` for one outline and tolerance, asking only the edges that can matter.

    Both tests of an edge need the point's v inside the edge's v extent (the boundary test within
    ``tol``, the crossing test without), so the edges are bucketed by that extent widened by ``tol``
    and a point looks at its own bucket only: a detailed outline (a fractal of hundreds of edges)
    has a handful of edges at any one height. Every edge in the bucket gets the per-edge arithmetic
    of :func:`_point_in_poly`, so the answer is the same."""

    def __init__(self, pts, tol):
        x1, y1, x2, y2, xmin, xmax, ymin, ymax, length = _poly_edges(pts)
        self.tol = tol
        lo, hi = ymin - tol, ymax + tol
        self.y0, self.y1 = float(lo.min()), float(hi.max())
        self.nb = nb = int(min(4096, max(1, len(x1) // 2)))
        self.wb = (self.y1 - self.y0) / nb if self.y1 > self.y0 else 1.0
        # a bucket is floor((v - y0) / wb); the floating point operations are monotonic, so a point
        # inside an edge's widened extent lands between the edge's first and last bucket (one more
        # on each side for good measure)
        first = np.clip(np.floor((lo - self.y0) / self.wb).astype(int) - 1, 0, nb - 1)
        last = np.clip(np.floor((hi - self.y0) / self.wb).astype(int) + 1, 0, nb - 1)
        rows = list(zip(*(a.tolist() for a in (x1, y1, x2, y2, xmin, xmax, ymin, ymax, length))))
        self.buckets = [[] for _ in range(nb)]
        for row, b0, b1 in zip(rows, first.tolist(), last.tolist()):
            for b in range(b0, b1 + 1):
                self.buckets[b].append(row)

    def inside(self, x, y):
        tol = self.tol
        if not self.y0 <= y <= self.y1:
            return False   # beyond every edge's extent: neither on the boundary nor crossing
        b = min(self.nb - 1, max(0, int((y - self.y0) / self.wb)))
        odd = False
        for x1, y1, x2, y2, xmin, xmax, ymin, ymax, length in self.buckets[b]:
            # on the boundary counts as inside
            if xmin - tol <= x <= xmax + tol and ymin - tol <= y <= ymax + tol:
                if abs((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) <= tol * length:
                    return True
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                odd = not odd
        return odd


def _point_in_poly(x, y, pts, tol=1e-7):
    inside = False
    n = len(pts)
    for i in range(n):
        (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % n]
        # on the boundary counts as inside
        if min(x1, x2) - tol <= x <= max(x1, x2) + tol and min(y1, y2) - tol <= y <= max(y1, y2) + tol:
            cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)
            if abs(cross) <= tol * max(1.0, np.hypot(x2 - x1, y2 - y1)):
                return True
        if (y1 > y) != (y2 > y):
            xc = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < xc:
                inside = not inside
    return inside


def extract(csx):
    """Shapes of every physical primitive, grouped as (metals, dielectrics, others)."""
    metals, diel, other = [], [], []
    for prim in csx.GetAllPrimitives():
        prop = prim.GetProperty()
        ptype = prop.GetTypeString()
        if ptype in SKIP:
            continue
        kind = prim.GetTypeName()
        bb = np.array(prim.GetBoundBox(), float)
        lo, hi = bb.min(axis=0), bb.max(axis=0)
        kw = {}
        if kind == "Box":
            k = "box"
        elif kind in ("Polygon", "LinPoly"):
            k = kind.lower()
            c0, c1 = prim.GetCoords()
            kw = {"normal": int(prim.GetNormDir()), "elevation": float(prim.GetElevation()),
                  "pts": np.c_[np.asarray(c0, float), np.asarray(c1, float)]}
            if k == "linpoly":
                kw["length"] = float(prim.GetLength())
        elif kind == "Cylinder":
            k = "cylinder"
            kw = {"start": np.asarray(prim.GetStart(), float), "stop": np.asarray(prim.GetStop(), float),
                  "radius": float(prim.GetRadius()), "r_inner": 0.0}
        elif kind == "CylindricalShell":
            # CSXCAD's radius is the middle of the wall
            k = "cylindricalshell"
            r, w = float(prim.GetRadius()), float(prim.GetShellWidth())
            kw = {"start": np.asarray(prim.GetStart(), float), "stop": np.asarray(prim.GetStop(), float),
                  "radius": r + w / 2, "r_inner": max(r - w / 2, 0.0)}
        elif kind == "Sphere":
            k = "sphere"
            kw = {"center": np.asarray(prim.GetCenter(), float), "radius": float(prim.GetRadius())}
        elif kind in ("Curve", "Wire"):
            k = kind.lower()
            kw = {"points": np.array([prim.GetPoint(i) for i in range(prim.GetNumberOfPoints())], float),
                  "radius": float(prim.GetWireRadius()) if kind == "Wire" else 0.0}
        elif kind == "Polyhedron":
            k = "polyhedron"
            verts = np.array([prim.GetVertex(i) for i in range(prim.GetNumVertices())], float)
            faces = [list(prim.GetFace(i)) for i in range(prim.GetNumFaces())]
            kw = {"vertices": verts, "faces": faces}
        elif kind == "RotPoly":
            # exact when fairbeam.geometry can export it (full turn, translated at most); CSXCAD's
            # own bounding box ignores the rotation, so take the exported one
            from .geometry import _rotpoly
            rot = _rotpoly(prim)
            if rot is not None:
                k = "rotpoly"
                lo, hi = np.array(rot["bbox"][0], float), np.array(rot["bbox"][1], float)
                kw = {"axis": rot["axis"], "origin": np.array(rot["origin"], float),
                      "profile": np.array(rot["points"], float)}
            else:
                k = "bbox"
        else:
            k = "bbox"
        if prim.HasTransform() and k != "rotpoly":
            # CSXCAD's GetBoundBox() ignores the transform (a box rotated by 30 degrees would put its
            # mesh lines at the unrotated corners), so use the world-space bounds geometry computes:
            # tight for exact shapes under any affine matrix, the transformed local box otherwise
            from .geometry import _primitive
            wb = np.asarray(_primitive(prim)["bbox"], float)
            lo, hi = wb.min(axis=0), wb.max(axis=0)
            k, kw = "bbox", {}
        s = Shape(k, prop, lo, hi, **kw)
        if ptype in METALS or (ptype == "Material" and _conductor(prop)):
            metals.append(s)
        elif ptype == "Material":
            eps = np.atleast_1d(prop.GetMaterialProperty("epsilon")).astype(float)
            mu = np.atleast_1d(prop.GetMaterialProperty("mue")).astype(float)
            # Internal wavelength factor n² = εr μr; default μr=1 preserves existing meshes.
            s.eps_r = float(eps.max() * mu.max())
            diel.append(s)
        else:
            other.append(s)   # lumped elements etc.
    return metals, diel, other


# ---------------------------------------------------------------------------- line bookkeeping

class Lines:
    def __init__(self):
        self.fixed = {a: [] for a in range(3)}     # (coord, priority, tag)
        self.optional = {a: [] for a in range(3)}

    def add(self, axis, coords, prio, tag=""):
        if isinstance(coords, (float, int, np.floating, np.integer)):
            self.fixed[axis].append((float(coords), prio, tag))
            return
        for c in (coords if isinstance(coords, (list, tuple)) else np.atleast_1d(coords)):
            self.fixed[axis].append((float(c), prio, tag))

    def opt(self, axis, coords, h=None):
        """Optional lines with their intended cell size ``h`` (default: their own spacing)."""
        c = np.sort(np.atleast_1d(np.asarray(coords, float)))
        if h is None:
            h = float(np.min(np.diff(c))) if len(c) > 1 else np.inf
        self.optional[axis] += [(float(v), float(h)) for v in c]


def _from_single(values) -> np.ndarray:
    """Coordinates CSXCAD stores in single precision (polyhedron vertices) as the shortest decimals
    that round to the same float: 5.079999923706055 back to 5.08. Kept as they are, such a line sits
    a hair off the double-precision face of a box it should coincide with, and when it falls just
    outside the metal the edges on it are not metal: the pyramidal horn's feed guide was a cell too
    tall at y = +b/2 (the 5.08 of the wall box met the vertex 5.0799999 of a flare wall), and the
    port read 3.7 % (cpw 20) to 8.5 % (cpw 30) too little power (#12)."""
    return np.array([float(str(np.float32(v))) for v in np.atleast_1d(values)], float)


def _resolve(fixed, min_cell, warnings, axis):
    """Sort fixed lines and remove slivers: of two lines closer than ``min_cell`` the lower priority
    one is dropped; equal low priorities are merged to their midpoint; two hard lines are kept."""
    pts = sorted(fixed)
    out = []
    for c, p, tag in pts:
        if out and c - out[-1][0] < min_cell:
            c0, p0, t0 = out[-1]
            # coincident: CSXCAD stores some coordinates (polyhedron vertices) in single precision,
            # so the "same" coordinate can differ by ~1e-7 relative between primitives
            if abs(c - c0) < max(1e-9, 1e-6 * max(1.0, abs(c)), 1e-3 * min_cell):
                out[-1] = (c0, max(p, p0), t0 if p0 >= p else tag)
                continue
            if p > p0:
                out[-1] = (c, p, tag)
            elif p < p0:
                continue
            elif p >= PRIO_EDGE:
                warnings.append(f"{'xyz'[axis]}: {t0} at {c0:g} and {tag} at {c:g} are only {c - c0:.3g} apart "
                                f"(smaller than min_cell {min_cell:.3g}); both kept")
                out.append((c, p, tag))
            else:
                out[-1] = ((c0 + c) / 2, p, tag)
        else:
            out.append((c, p, tag))
    return np.array([c for c, _, _ in out])


def _nearest(values, c, skip=None):
    """Smallest |x - c| over the sorted list ``values`` (inf when empty); with ``skip``, values
    closer than ``skip`` to ``c`` do not count."""
    i = bisect.bisect_left(values, c)
    best = np.inf
    j = i - 1
    while j >= 0 and skip is not None and abs(values[j] - c) < skip:
        j -= 1
    if j >= 0:
        best = abs(values[j] - c)
    j = i
    while j < len(values) and skip is not None and abs(values[j] - c) < skip:
        j += 1
    if j < len(values):
        best = min(best, abs(values[j] - c))
    return best


def _thin(lines, tol):
    out = []
    for v in np.sort(np.asarray(lines, float)):
        if not out or v - out[-1] > tol:
            out.append(v)
    return np.array(out)


# ---------------------------------------------------------------------------- main entry

def _tip_width(m, a, local_res):
    """The larger transverse dimension of ``m`` when it is a thin arm along axis ``a`` (a wire-like cylinder or
    box, a strip), else None. Thin: no wider than two local cells and at least twice as long as wide; a
    cylinder must lie along the axis. Its free ends along ``a`` are tips (see TIP_CELL)."""
    if m.kind not in ("box", "cylinder"):
        return None
    ext = m.hi - m.lo
    if m.kind == "cylinder":
        d = np.abs(m.stop - m.start)
        if d.max() - d[a] > 1e-9 or m.r_inner > 0:
            return None
    w = max(ext[b] for b in range(3) if b != a)
    if w <= 1e-9 or ext[a] < 2 * w or w > 2 * local_res(a, m.lo[a], m.hi[a]):
        return None
    return float(w)


def generate(sim, f_max: float | None = None, cells_per_wavelength: float = 20, edge_rule: str = "thirds",
             max_ratio: float = 1.4, min_cell: float | None = None, dielectric_cells: int = 4,
             pad: float | None = None, metal_cells: int = 6, edge_res: float | None = None,
             keep_existing: bool = True, air_cells_per_wavelength: float | None = None,
             refine_features: bool = True) -> dict:
    """Mesh ``sim`` (an :class:`fairbeam.Simulation`) and return a report dict.

    Lengths are in drawing units (``sim.unit`` metres). ``f_max`` defaults to the simulation's.
    ``edge_res`` overrides the metal edge cell (default: half the local maximum cell).
    """
    if edge_rule not in ("thirds", "edge"):
        raise ValueError("edge_rule must be 'thirds' or 'edge'")
    if not np.isfinite(cells_per_wavelength) or cells_per_wavelength <= 0:
        raise ValueError("cells_per_wavelength must be finite and > 0")
    if not np.isfinite(max_ratio) or max_ratio <= 1:
        raise ValueError("max_ratio must be finite and > 1")
    if air_cells_per_wavelength is not None and (not np.isfinite(air_cells_per_wavelength)
                                                  or not 0 < air_cells_per_wavelength <= cells_per_wavelength):
        raise ValueError("air_cells_per_wavelength must be finite, > 0 and <= cells_per_wavelength")
    requested_min_cell = min_cell
    f_max = float(f_max or sim.f_max)
    unit = sim.unit
    lam_min = C0 / f_max / unit
    lam_max = C0 / sim.f_min / unit
    res_feature = lam_min / cells_per_wavelength
    res_air = lam_min / (air_cells_per_wavelength or cells_per_wavelength)
    metals, diel, other = extract(sim.csx)
    if not metals and not diel:
        raise ValueError("auto_mesh: no metal or dielectric geometry to mesh")
    eps_max = max([d.eps_r for d in diel] + [1.0])
    res_min = res_feature / np.sqrt(eps_max)
    warnings: list[str] = []
    intended: list[float] = []      # cell sizes the rules ask for (sets the default min_cell)
    L = Lines()

    def local_res(axis, c0, c1=None):
        """Largest allowed cell around coordinate(s) c0..c1 on ``axis``: lambda/cells, divided by
        sqrt(eps_r) of every dielectric whose extent covers it."""
        c1 = c0 if c1 is None else c1
        r = res_feature
        for d in diel:
            # an interval overlaps the dielectric (a point may sit on its face)
            if (c1 > c0 and d.lo[axis] < c1 - 1e-9 and c0 < d.hi[axis] - 1e-9) or \
                    (c1 <= c0 and d.lo[axis] - 1e-9 <= c0 <= d.hi[axis] + 1e-9):
                r = min(r, res_feature / np.sqrt(d.eps_r))
        return r

    diel_boxes = [((d.lo - 1e-9).tolist(), (d.hi + 1e-9).tolist(), d.eps_r) for d in diel]

    def local_res_pt(p):
        # the dielectric box test in plain floats (the same comparisons as on the arrays)
        p = [float(v) for v in p]
        r = res_feature
        for lo_d, hi_d, eps_r in diel_boxes:
            if all(p[k] >= lo_d[k] for k in range(3)) and all(p[k] <= hi_d[k] for k in range(3)):
                r = min(r, res_feature / np.sqrt(eps_r))
        return r

    # ---- 1. fixed geometry lines -------------------------------------------------------------
    for d in diel:
        for a in range(3):
            L.add(a, [d.lo[a], d.hi[a]], PRIO_HARD, "dielectric face")
            t = d.hi[a] - d.lo[a]
            rl = res_feature / np.sqrt(d.eps_r)
            if 0 < t <= dielectric_cells * rl:     # thin layer: N cells across its thickness
                L.opt(a, np.linspace(d.lo[a], d.hi[a], dielectric_cells + 1)[1:-1])
                intended.append(t / dielectric_cells)

    from .design import port_feeds
    feeds = [member for p in getattr(sim, "ports", []) for _path, member in port_feeds(p, "port")]
    for p in feeds + list(getattr(sim, "lumped_elements", [])):
        st, sp = np.asarray(p["start"], float), np.asarray(p["stop"], float)
        k = "xyz".index(p["direction"])
        for a in range(3):
            if a == k or abs(sp[a] - st[a]) < 1e-9:
                L.add(a, [st[a], sp[a]], PRIO_HARD, f"port {p.get('number', p.get('name', ''))}")
            else:
                L.add(a, [st[a], sp[a]], PRIO_SOFT, "port side")

    # ---- 2. metal: sheet planes, edges, narrow features ----------------------------------------
    edge_list = []   # (axis, coord, inside_sign, d, tag) candidates for the thirds rule
    for m in metals:
        f = m.flat
        if m.kind == "polyhedron":
            # slanted faces: lines at the vertex coordinates (no thirds rule for oblique edges)
            for a in range(3):
                L.add(a, np.unique(_from_single(m.vertices[:, a])), PRIO_EDGE, "polyhedron vertex")
            continue
        if m.kind in ("curve", "wire"):
            # thin wires are rasterised onto the nearest mesh edges: a fine uniform cover over the
            # wire's extent keeps the staircase close to the curve
            for a in range(3):
                if m.hi[a] - m.lo[a] > 1e-9:
                    h = edge_res or local_res(a, m.lo[a], m.hi[a]) / 2
                    L.opt(a, np.linspace(m.lo[a], m.hi[a], max(2, int(np.ceil((m.hi[a] - m.lo[a]) / h))) + 1))
                    intended.append(h)
                else:
                    L.add(a, m.lo[a], PRIO_HARD, "wire plane")
            # a wire with a radius is rasterised as a volume: every axis-parallel segment of a bent
            # wire gets lines on its axis and at its surface across it (the cover above is coarse
            # across a long bent wire's box)
            if m.radius > 0:
                for p0, p1 in zip(m.points[:-1], m.points[1:]):
                    for a in range(3):
                        if abs(p1[a] - p0[a]) < 1e-9 and m.hi[a] - m.lo[a] > 2 * m.radius + 1e-9:
                            L.opt(a, [p0[a] - m.radius, p0[a], p0[a] + m.radius], m.radius)
            continue
        if m.kind in ("polygon", "linpoly"):
            n = m.normal
            L.add(n, [m.lo[n], m.hi[n]], PRIO_HARD, "polygon plane")
            u, v = (n + 1) % 3, (n + 2) % 3
            pts = m.pts.tolist()   # plain floats: the same numbers, without numpy scalar overhead
            # a traced outline (a CST import, a digitised shape: tens of slanted edges) gets its vertex
            # lines only where they fit the grid; the uniform cover below resolves the outline. Hard
            # lines at every vertex give cells of 1e-4 mm and hundreds of lines per axis
            traced = sum(1 for p1, p2 in zip(pts, pts[1:] + pts[:1])
                         if abs(p1[0] - p2[0]) > 1e-9 and abs(p1[1] - p2[1]) > 1e-9) > TRACED_EDGES
            for i in range(len(pts)):
                p1, p2 = pts[i], pts[(i + 1) % len(pts)]
                for (ax, ia, ib) in ((u, 0, 1), (v, 1, 0)):
                    if abs(p1[ia] - p2[ia]) < 1e-9 and abs(p1[ib] - p2[ib]) > 1e-9:   # axis-parallel edge
                        mid = [0.0, 0.0, 0.0]
                        mid[n] = m.lo[n]
                        mid[u], mid[v] = (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2
                        edge_list.append((ax, p1[ia], m, mid, (min(p1[ib], p2[ib]), max(p1[ib], p2[ib])),
                                          (v if ax == u else u)))
                    elif abs(p1[ia] - p2[ia]) > 1e-9 and abs(p1[ib] - p2[ib]) > 1e-9:  # slanted: vertices
                        if traced:   # at the cover's cell size: vertex pairs don't make their own tiny cell
                            L.opt(ax, [p1[ia], p2[ia]], edge_res or local_res(ax, m.lo[ax], m.hi[ax]) / 2)
                        else:
                            # soft: a staircased slant gains nothing from two lines closer than min_cell
                            L.add(ax, [p1[ia], p2[ia]], PRIO_SOFT, "polygon vertex")
            # slanted polygons: fine uniform cover over the polygon extent (vertex lines alone are sparse)
            if any(abs(p1[0] - p2[0]) > 1e-9 and abs(p1[1] - p2[1]) > 1e-9
                   for p1, p2 in zip(pts, pts[1:] + pts[:1])):
                for ax in (u, v):
                    r = (edge_res or local_res(ax, m.lo[ax], m.hi[ax]) / 2)
                    L.opt(ax, np.arange(m.lo[ax], m.hi[ax] + 1e-9, r))
        else:
            for a in range(3):
                if f == a:
                    L.add(a, m.lo[a], PRIO_HARD, "sheet plane")
                    continue
                if m.kind in ("cylinder", "sphere", "rotpoly"):
                    L.add(a, [m.lo[a], m.hi[a]], PRIO_EDGE, f"{m.kind} extent")
                    if m.kind == "cylinder" and _tip_width(m, a, local_res) is not None:
                        # a thin cylinder's end faces: the tip rule below refines the cells next to a free one
                        for c in (m.lo[a], m.hi[a]):
                            mid_c = (m.lo + m.hi) / 2
                            mid_c[a] = c
                            edge_list.append((a, c, m, mid_c, None, None))
                    if m.kind == "rotpoly" and a == m.axis and len(m.profile) <= 8:
                        # the corners of a simple profile along the axis (a stepped cone's faces)
                        L.add(a, np.unique(np.round(m.origin[a] + m.profile[:, 1], 9)), PRIO_SOFT, "rotpoly profile")
                    continue
                if m.kind == "cylindricalshell":
                    # the wall: outer and inner faces across the axis, and cells across a thin wall
                    ax = int(np.argmax(np.abs(m.stop - m.start)))
                    if a == ax:
                        L.add(a, [m.lo[a], m.hi[a]], PRIO_EDGE, "tube extent")
                        continue
                    c, ro, ri = (m.lo[a] + m.hi[a]) / 2, m.radius, m.r_inner
                    L.add(a, [c - ro, c - ri, c + ri, c + ro], PRIO_EDGE, "tube wall")
                    wall = ro - ri
                    r_loc = local_res(a, c - ro, c + ro)
                    if 0 < wall <= 2 * r_loc:
                        n_c = max(2, int(np.ceil(wall / (edge_res or r_loc / 2))))
                        for c0 in (c - ro, c + ri):
                            L.opt(a, np.linspace(c0, c0 + wall, n_c + 1))
                        intended.append(wall / n_c)
                    continue
                for c, sign in ((m.lo[a], +1), (m.hi[a], -1)):
                    b = [x for x in range(3) if x != a and x != f]
                    # the edge runs along the remaining in-plane axis (or two axes for solids)
                    mid = (m.lo + m.hi) / 2
                    mid[a] = c
                    edge_list.append((a, c, m, mid, None, b[0] if b else None))

        # narrow features: at least metal_cells across, and the same cell size normal to sheets
        finest = None
        for a in range(3):
            w = m.hi[a] - m.lo[a]
            if w <= 1e-9 or m.kind == "polygon" and a == m.normal:
                continue
            r = local_res(a, m.lo[a], m.hi[a])
            if w <= 2 * r:
                n_c = max(metal_cells, int(np.ceil(w / (edge_res or r / 2))))
                L.opt(a, np.linspace(m.lo[a], m.hi[a], n_c + 1))
                h = w / n_c
                intended.append(h)
                finest = h if finest is None else min(finest, h)
        # a narrow zero-thickness strip also needs that cell size normal to it (two cells each side),
        # except where a thin dielectric layer already sets the normal mesh
        n_axis = f if f is not None else (m.normal if m.kind == "polygon" else None)
        if n_axis is not None and finest is not None:
            c = m.lo[n_axis]
            for q in (c - 2 * finest, c - finest, c + finest, c + 2 * finest):
                p_q = (m.lo + m.hi) / 2
                p_q[n_axis] = q
                if not any(np.all(p_q >= d.lo - 1e-9) and np.all(p_q <= d.hi + 1e-9) for d in diel):
                    L.opt(n_axis, q, finest)
        elif n_axis is not None and m.kind in ("box", "polygon", "linpoly"):
            # a wide sheet (a blade, a ground plane): the field and the surface current change fastest
            # across the sheet, so the cells next to it, normal to it, are half the local cell. Without
            # this a lambda/20 mesh puts cells of lambda/20 on both sides of a blade and a UAV blade
            # monopole came out 7 % low (it converges to its answer only at 40 cells per wavelength)
            c = m.lo[n_axis]
            h = edge_res or local_res(n_axis, c, c) / SHEET_CELL
            for q in (c - h, c + h):
                p_q = (m.lo + m.hi) / 2
                p_q[n_axis] = q
                if not any(np.all(p_q >= d.lo - 1e-9) and np.all(p_q <= d.hi + 1e-9) for d in diel):
                    L.opt(n_axis, q, h)
                    intended.append(h)

    # free edges: skip joins between metal shapes, then thirds or an exact line
    # the bounding boxes of all metal shapes at once: only the shapes whose box holds the point are
    # asked (Shape.contains starts with the same box test, so the answer is unchanged)
    metal_lo = np.array([s.lo for s in metals]).reshape(-1, 3) - 1e-7
    metal_hi = np.array([s.hi for s in metals]).reshape(-1, 3) + 1e-7

    def covered(p):
        p = np.asarray(p, float)
        hit = np.nonzero(((p >= metal_lo) & (p <= metal_hi)).all(axis=1))[0]
        return any(metals[i].contains(p) for i in hit)

    hard_coords = {a: sorted({c for c, pr, _ in L.fixed[a] if pr >= PRIO_EDGE}) for a in range(3)}
    edge_coords = {a: [] for a in range(3)}
    free_edges = []
    tips = []   # (axis, coord, inside_sign, cell) at the free ends of thin cylinders
    for (a, c, m, mid, seg, along) in edge_list:
        d_loc = edge_res or local_res_pt(mid) / 2
        eps = max(1e-6, 1e-4 * d_loc)
        # sample along the edge; an edge is free if metal is missing just outside at any sample
        samples = []
        if along is not None:
            lo_b, hi_b = (seg if seg is not None else (m.lo[along], m.hi[along]))
            for t in (0.2, 0.5, 0.8):
                q = np.array(mid, float)
                q[along] = lo_b + t * (hi_b - lo_b)
                samples.append(q)
        else:
            samples.append(np.array(mid, float))
        # inside direction: the side where this shape has metal
        q_in, q_out = samples[len(samples) // 2].copy(), samples[len(samples) // 2].copy()
        q_in[a] += eps
        q_out[a] -= eps
        sign = +1 if m.contains(q_in) else -1
        free = False
        for q in samples:
            qo = q.copy()
            qo[a] -= sign * eps
            if not covered(qo):
                free = True
                break
        if not free:
            continue
        w_tip = _tip_width(m, a, local_res)
        if m.kind == "cylinder":
            # the end of a thin cylinder keeps its exact end line (the extent line); fine cells on both sides
            if w_tip is not None:
                tips.append((a, c, sign, TIP_CELL * w_tip))
            continue
        if m.kind not in ("polygon", "linpoly") and 0 < m.hi[a] - m.lo[a] <= 2 * local_res(a, m.lo[a], m.hi[a]):
            d_loc = 0.0   # narrow feature (already subdivided across): exact edge lines, no thirds
        elif w_tip is not None:
            d_loc = min(d_loc, TIP_CELL * w_tip)   # the end of a thin arm: a cell as wide as the arm
        free_edges.append((a, c, sign, d_loc))
        edge_coords[a].append(c)

    intended += [d / 3 for (_, _, _, d) in free_edges if d > 0]
    intended += [h for (_, _, _, h) in tips]
    min_cell = float(min_cell or max(res_min / 200, 0.45 * min(intended + [res_min / 20])))
    edge_sorted = {(a, sg): sorted(x for b, x, s_, _ in free_edges if b == a and s_ == sg)
                   for a in range(3) for sg in (+1, -1)}
    for k, (a, c, sign, d) in enumerate(free_edges):
        # distance to the nearest other feature: any hard line (also one on this very coordinate,
        # e.g. a dielectric face or port plane) or another free edge
        # collinear edges of other shapes (same coordinate, metal on the same side, e.g. the patches
        # of an array) are the same edge line, not a neighbouring feature
        gap = min(_nearest(hard_coords[a], c), _nearest(edge_sorted[(a, -sign)], c),
                  _nearest(edge_sorted[(a, sign)], c, skip=1e-9))
        if edge_rule == "thirds" and d > 0 and gap >= d:
            L.add(a, [c + sign * d / 3, c - sign * 2 * d / 3], PRIO_SOFT + 0.5, "thirds")
        else:
            L.add(a, c, PRIO_EDGE, "metal edge")

    for (a, c, sign, h) in tips:
        L.opt(a, [c - sign * h, c + sign * h], h)

    # ---- 3. domain ------------------------------------------------------------------------------
    allshapes = metals + diel + other
    lo = np.min([s.lo for s in allshapes], axis=0)
    hi = np.max([s.hi for s in allshapes], axis=0)
    for p in feeds:
        lo = np.minimum(lo, np.minimum(p["start"], p["stop"]))
        hi = np.maximum(hi, np.maximum(p["start"], p["stop"]))
    if pad is None:
        pads = [lam_max / 4] * 6
    elif np.ndim(pad) == 0:
        pads = [float(pad)] * 6
    else:
        pads = [float(v) for v in pad]
        if len(pads) != 6:
            raise ValueError("pad must be a number or 6 values (x-, x+, y-, y+, z-, z+)")
    pad_air = pads[0]
    dom_lo, dom_hi = lo.copy(), hi.copy()
    bnd = list(sim.boundaries)
    for a in range(3):
        for side, sgn in ((0, -1), (1, +1)):
            kind = str(bnd[2 * a + side]).upper()
            if kind in ("PEC", "PMC", "0", "1"):
                continue   # symmetry / ground plane: the structure touches the boundary
            extra = pads[2 * a + side]
            if extra == 0:
                continue   # the structure runs into the boundary (e.g. a waveguide through the PML)
            if kind.startswith("PML"):
                n_pml = int(kind.split("_")[1]) if "_" in kind else 8
                extra += n_pml * res_air
            if side == 0:
                dom_lo[a] -= extra
            else:
                dom_hi[a] += extra
        if dom_hi[a] - dom_lo[a] <= 0:
            raise ValueError(f"auto_mesh: the domain has zero extent along {'xyz'[a]} "
                             "(flat structure with no padding on that axis): give that axis padding")
        L.add(a, [dom_lo[a], dom_hi[a]], PRIO_DOMAIN, "domain")

    # user lines already on the grid
    grid = sim.mesh
    if keep_existing:
        for a in range(3):
            ex = np.asarray(grid.GetLines(a), float)
            if len(ex):
                L.add(a, ex, PRIO_HARD, "user line")
    # ---- 4. merge, fill and grade -----------------------------------------------------------------
    required = []
    for a in range(3):
        fixed = [(c, p, t) for c, p, t in L.fixed[a] if dom_lo[a] - 1e-9 <= c <= dom_hi[a] + 1e-9]
        req = _resolve(fixed, min_cell, warnings, a)
        required.append(req)
        opt = sorted((c, min(h, res_min)) for c, h in L.optional[a] if dom_lo[a] < c < dom_hi[a])
        # optional lines survive if they are more than 0.4 of their intended cell from a fixed line,
        # and more than half of it from the previous kept one (fills of neighbouring features
        # interleave; the finer fill wins because its lines come with the smaller cell)
        kept, last_h = [], None
        for c, h in opt:
            if np.min(np.abs(req - c)) <= max(min_cell, 0.4 * h):
                continue
            if kept and c - kept[-1] <= max(min_cell, 0.5 * min(h, last_h)):
                if h < last_h:   # prefer the line of the finer fill
                    kept[-1], last_h = c, h
                continue
            kept.append(c)
            last_h = h
        base = np.unique(np.r_[req, kept])
        grid.SetLines("xyz"[a], fill(base, lambda t, a=a: _cap_array(t, a, diel, res_air, res_feature), max_ratio))
    settings = {
        "f_max": f_max, "cells_per_wavelength": cells_per_wavelength, "edge_rule": edge_rule,
        "max_ratio": max_ratio, "dielectric_cells": dielectric_cells, "metal_cells": metal_cells,
        "refine_features": refine_features,
        "pad": pads if len(set(pads)) > 1 else pad_air, "min_cell": min_cell, "edge_res": edge_res}
    if air_cells_per_wavelength is not None:
        settings["air_cells_per_wavelength"] = air_cells_per_wavelength
    # Measure the original grid first. Features already resolved keep exactly the
    # same mesh, and this also gives the cell-count impact without a solver run.
    from .mesh_refinement import (collect_features, measure_features, refinement_caps, cap_sizes,
                                  refinement_cell_lower_bound, refine_axis)
    features = (collect_features(metals, feeds + list(getattr(sim, "lumped_elements", [])), 2 * res_feature)
                if refine_features else [])
    baseline_lines = [np.asarray(grid.GetLines(a), float) for a in range(3)]
    before = measure_features(features, baseline_lines)
    unresolved = [f for f in before if not f["resolved"]]
    baseline_cells = int(np.prod([len(x) - 1 for x in baseline_lines]))
    cell_limit = int(float(os.environ.get("FAIRBEAM_MAX_CELLS", 40e6)))
    skipped_cell_limit, required_lower_bound = False, baseline_cells
    dropped = []
    candidates = list(unresolved) if refine_features else []
    grading_ratio = 1 + 0.9 * (max_ratio - 1)

    def estimated_cost(feature):
        # Largest Cartesian footprint first, including the small sheet-normal
        # cells. This orders removals without allocating each candidate mesh.
        caps = refinement_caps([feature], requested_min_cell)
        return refinement_cell_lower_bound(caps, (dom_lo, dom_hi))

    candidates.sort(key=estimated_cost)
    while candidates:
        caps = refinement_caps(candidates, requested_min_cell)
        required_lower_bound = refinement_cell_lower_bound(caps, (dom_lo, dom_hi))
        try:
            if required_lower_bound > cell_limit:
                raise OverflowError("fine-feature refinement exceeds cell limit")
            refined_lines = list(baseline_lines)
            for a in range(3):
                if not caps[a]:
                    continue
                base_cap = lambda t, a=a: _cap_array(t, a, diel, res_air, res_feature)
                refined_cap = lambda t, a=a, base_cap=base_cap: cap_sizes(t, base_cap, caps[a], grading_ratio)
                other_cells = math.prod(len(refined_lines[b]) - 1 for b in range(3) if b != a)
                refined_lines[a] = refine_axis(baseline_lines[a], required[a], refined_cap, grading_ratio,
                                              cell_limit // max(1, other_cells))
            if math.prod(len(lines) - 1 for lines in refined_lines) > cell_limit:
                raise OverflowError("fine-feature refinement exceeds cell limit")
            for a, lines in enumerate(refined_lines):
                grid.SetLines(a, lines)
            break
        except OverflowError:
            skipped_cell_limit = True
            dropped.append(candidates.pop())
    report = mesh_report(sim, res_air, res_min, min_cell, warnings, settings)
    report["fine_features"] = measure_features(features, [grid.GetLines(a) for a in range(3)])
    report["fine_feature_refinement"] = {
        "baseline_cells": baseline_cells, "total_cells": report["total_cells"],
        "added_cells": report["total_cells"] - baseline_cells,
        "ratio": report["total_cells"] / baseline_cells,
        "cell_limit": cell_limit, "required_cells_lower_bound": required_lower_bound,
        "skipped_cell_limit": skipped_cell_limit,
        "enabled": refine_features, "dropped_features": len(dropped),
        "retained_features": len(candidates),
    }
    sim.mesh_report = report
    return report


def fill(lines, cap, ratio: float, samples: int = 400, monotone: bool = False,
         max_cells: int | None = None, boundary_cells=None) -> np.ndarray:
    """Fill the gaps between sorted ``lines`` with smoothly graded cells.

    A size field s(x) = min_j (h_j + (ratio - 1) |x - x_j|), capped by ``cap(x)``, is built from
    the given lines, where h_j is the smaller of the two gaps next to line j (the local feature
    size). Linear growth of s by (ratio - 1) per unit length is exactly a geometric cell sequence
    with that ratio. Each gap then gets n = ceil(integral dx / s) cells, placed at equal steps of
    that integral, so cells follow the size field and land exactly on the given lines.
    ``cap(x)`` takes an array of positions and returns the largest allowed cell there.
    ``monotone`` uses endpoint-dense quadrature and keeps the smallest realized
    boundary sizes within a local refill window. Optional cover lines must not be
    treated as fixed constraints during that refill. ``boundary_cells`` sets the
    neighboring cell sizes just outside the window. The default retains existing
    grids. ``max_cells`` guards line allocations.
    """
    x = np.unique(np.asarray(lines, float))
    if len(x) < 2:
        return x
    w = np.diff(x)
    cx = np.asarray(cap(x), float)
    h = np.minimum(cx, np.minimum(np.r_[np.inf, w], np.r_[w, np.inf]))
    if boundary_cells is not None:
        h[[0, -1]] = np.minimum(h[[0, -1]], boundary_cells)
    g = 0.85 * (ratio - 1.0)   # discretising the size field overshoots slightly; stay below ratio
    # every gap at once: row i holds the samples of gap i (the per-gap numpy calls were the cost of
    # meshing detailed geometry); each row gets the arithmetic the gap got on its own
    if monotone:
        # Resolve steep size-field gradients near fixed endpoints without a
        # huge uniform quadrature array in a long air interval.
        fraction = (1 - np.cos(np.linspace(0, np.pi, samples))) / 2
        ts = x[:-1, None] + w[:, None] * fraction
    else:
        ts = np.linspace(x[:-1], x[1:], samples, axis=1)
    c = np.asarray(cap(ts.ravel()), float)
    caps = np.minimum(np.full(ts.shape, np.inf), c.reshape(ts.shape) if c.shape == (ts.size,) else c)
    dts = np.diff(ts, axis=1)
    right = np.full(len(x), np.inf)   # realised cell to the right of each line (previous pass)
    left = np.full(len(x), np.inf)    # ... and to its left
    idx = np.arange(len(x))
    # the first cell of a field starting at s0 and growing by g per unit length is s0 (e^g - 1)/g
    # long; start from the neighbour times this factor so it is at most (1 + g) times the cell
    # across the line
    grow = (1.0 + g) * g / np.expm1(g) if g > 0 else 1.0
    m = len(w)
    allocated_cells = m
    if max_cells is not None and m > max_cells:
        raise OverflowError("fine-feature refinement exceeds cell limit")
    # the outcome of each gap (its first and last cell, its inner lines) from the last pass that
    # computed it, and the inputs it was computed from: a gap whose inputs did not change between
    # passes is not computed again (the same arithmetic on the same numbers gives the same lines)
    first, last, inners, prev = w.copy(), w.copy(), {}, None
    for _ in range(max(30, 2 * len(x)) if monotone else 30):
        # a gap split into n cells makes the cell next to a line smaller than the h_j the field
        # assumed there; each gap grades from the cells actually placed on the far side of its end
        # lines (never from its own, which would feed back on itself): gap i takes h_i from `left`
        # only and h_(i+1) from `right` only, every other line from both
        hh = np.minimum(h, grow * np.minimum(right, left))
        hh_i = np.minimum(h, grow * left)     # line i as the left end of gap i
        hh_j = np.minimum(h, grow * right)    # line i + 1 as the right end of gap i
        # size field in gap i: min over lines j of hh_j + g |t - x_j|. For the lines left of the
        # gap that is g t + (hh_j - g x_j), for those right of it (hh_j + g x_j) - g t: the smallest
        # key wins at every t of the gap, so only the lines with the smallest key on either side
        # (plus the gap's own two ends) can hold the minimum (the O(lines) scan per gap was the
        # cost of meshing detailed geometry)
        kl, kr = hh - g * x, hh + g * x
        run = np.minimum.accumulate(kl)
        best_l = np.maximum.accumulate(np.where(kl <= run, idx, 0))           # argmin of kl over 0..j
        run = np.minimum.accumulate(kr[::-1])[::-1]
        best_r = np.minimum.accumulate(np.where(kr <= run, idx, len(x))[::-1])[::-1]   # ... over j..end
        # that line left of gap i (none for the first gap) and right of it (none for the last); a
        # missing line contributes inf, which leaves the size field as it is
        jl, jr = np.zeros(m, int), np.zeros(m, int)
        jl[1:], jr[:-1] = best_l[:m - 1], best_r[2:]
        hl, hr = hh[jl], hh[jr]
        hl[0], hr[-1] = np.inf, np.inf
        key = np.stack([hh_i[:-1], hh_j[1:], jl, hl, jr, hr])
        rows = np.arange(m) if prev is None else np.nonzero(np.any(key != prev, axis=0))[0]
        prev = key
        for r0 in range(0, len(rows), _FILL_ROWS):
            i = rows[r0:r0 + _FILL_ROWS]
            t = ts[i]
            size = np.minimum(hh_i[i, None] + g * np.abs(t - x[i, None]),
                              hh_j[i + 1, None] + g * np.abs(t - x[i + 1, None]))
            size = np.minimum(size, hl[i, None] + g * np.abs(t - x[jl[i], None]))
            size = np.minimum(size, hr[i, None] + g * np.abs(t - x[jr[i], None]))
            size = np.minimum(size, caps[i])
            dens = 1.0 / size
            cum = np.zeros(t.shape)
            np.cumsum((dens[:, 1:] + dens[:, :-1]) / 2 * dts[i], axis=1, out=cum[:, 1:])
            total = cum[:, -1]
            # a gap at most 10 % over the local size stays one cell (splitting it would leave two
            # slivers of half the size, which then propagate into the neighbouring gaps)
            split = total > 1.1
            for k in np.nonzero(~split)[0].tolist():
                g_i = int(i[k])
                first[g_i] = last[g_i] = w[g_i]
                allocated_cells -= len(inners.pop(g_i, ()))
            for k in np.nonzero(split)[0].tolist():
                g_i, n = int(i[k]), int(np.ceil(total[k] - 1e-3))
                allocated_cells += n - 1 - len(inners.get(g_i, ()))
                if max_cells is not None and allocated_cells > max_cells:
                    raise OverflowError("fine-feature refinement exceeds cell limit")
                inner = np.interp(np.arange(1, n) * total[k] / n, cum[k], t[k])
                inners[g_i] = inner
                first[g_i], last[g_i] = inner[0] - x[g_i], x[g_i + 1] - inner[-1]
        new_r, new_l = np.full(len(x), np.inf), np.full(len(x), np.inf)
        new_r[:-1], new_l[1:] = first, last
        if monotone:
            new_r = np.minimum(new_r, right)
            new_l = np.minimum(new_l, left)
        if np.allclose(new_r, right) and np.allclose(new_l, left):
            break
        right, left = new_r, new_l
    pieces = [x[:1]]
    for i in range(m):
        if i in inners:
            pieces.append(inners[i])
        pieces.append(x[i + 1:i + 2])
    return np.concatenate(pieces)


_FILL_ROWS = 2048   # gaps per block in fill(): bounds the temporary arrays for very long line sets


def _cap_array(t, axis, diel, res_air, res_feature=None):
    """Largest allowed cell in air and in each dielectric along an axis."""
    t = np.asarray(t, float)
    c = np.full(t.shape, res_air)
    res_feature = res_air if res_feature is None else res_feature
    for d in diel:
        inside = (t >= d.lo[axis] - 1e-9) & (t <= d.hi[axis] + 1e-9)
        c = np.where(inside, np.minimum(c, res_feature / np.sqrt(d.eps_r)), c)
    return c


def mesh_report(sim, res_air, res_min, min_cell, warnings, settings) -> dict:
    lines = [np.asarray(sim.mesh.GetLines(a), float) for a in range(3)]
    cells = [len(l) - 1 for l in lines]
    widths = [np.diff(l) for l in lines]
    dmin = [float(w.min()) for w in widths]
    ratio = max(float(np.max(np.maximum(w[1:] / w[:-1], w[:-1] / w[1:]))) if len(w) > 1 else 1.0 for w in widths)
    dt = sim.unit / (C0 * np.sqrt(sum(1 / d ** 2 for d in dmin)))
    total = int(np.prod(cells))
    return {
        "settings": settings,
        "cells": cells, "total_cells": total,
        "min_cell": round(min(dmin), 5), "max_cell": round(max(float(w.max()) for w in widths), 5),
        "max_neighbour_ratio": round(ratio, 3),
        "res_air": round(res_air, 4), "res_dielectric": round(res_min, 4),
        "timestep_s": float(dt),
        "timesteps_per_ns": round(1e-9 / dt, 1),
        "memory_mb_estimate": round(total * 90 / 1e6, 1),
        "warnings": warnings,
    }


def format_report(r: dict) -> str:
    c = r["cells"]
    s = (f"auto_mesh: {c[0]} x {c[1]} x {c[2]} = {r['total_cells']:,} cells, cell {r['min_cell']:.3g}"
         f"..{r['max_cell']:.3g} (air max {r['res_air']:.3g}, dielectric max {r['res_dielectric']:.3g}), "
         f"max ratio {r['max_neighbour_ratio']}, dt {r['timestep_s'] * 1e12:.3g} ps, ~{r['memory_mb_estimate']} MB")
    for w in r["warnings"]:
        s += f"\n  warning: {w}"
    return s
