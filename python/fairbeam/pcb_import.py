"""Import 2D PCB antenna artwork (DXF, Gerber RS-274X, Excellon drill) as a design.

The reverse direction of a PCB export: the copper of a printed antenna (a patch, a meander, an
inverted F, a ground plane) becomes parts of ``polygon`` sheets on a z plane, on a substrate box.
It follows :mod:`fairbeam.cst_import`: ``import_pcb`` returns ``{"design", "report"}``, the report
lists what was created and every entity that was not imported, with the reason.

Accepted input (``SUPPORTED`` has the list):

* **DXF** (ASCII, any release): ``LWPOLYLINE`` / ``POLYLINE`` (closed, or open with coinciding
  ends; bulges are arcs), ``CIRCLE``, ``ARC``, ``ELLIPSE`` and ``LINE``; open pieces (lines, arcs,
  open polylines) that meet end to end are assembled into loops. Nothing else is read: text,
  hatches, splines, blocks and dimensions are reported. ``ezdxf`` is not used (it is not part of
  the openEMS environment); the group-code parser here is about 100 lines.
* **Gerber RS-274X**: regions (G36/G37), flashes of the standard apertures (circle, rectangle,
  obround, polygon, with a hole), draws with circle or rectangle apertures (turned into outlines:
  a stroke is the aperture swept along the line or arc), lines and arcs in single or multi
  quadrant mode, mm or inch, leading or trailing zero omission. Aperture macros, block apertures,
  step and repeat and clear polarity are reported, not read.
* **Excellon drill**: plated holes become metal pins between the two copper planes (vias); unplated
  holes and routed slots are reported.

Arcs and circles are tessellated so that no chord is more than ``chord_tol`` (mm) from the curve.
A loop nested in another (a hole cut in a patch) has no place in a ``polygon`` primitive (CSXCAD
polygons have no holes): the copper part becomes a live Boolean subtraction (``booleanHistory``,
:func:`fairbeam.design.boolean_primitives`), so the designer can edit both operands. Coordinates
are converted to mm and rounded to 1e-6 mm.

Ports are never created: the importer cannot know where the feed is.
"""

from __future__ import annotations

import fnmatch
import math
import re
from bisect import bisect_right
from dataclasses import dataclass, field
from pathlib import PurePath

from .design import DesignError, blank_design, boolean_primitives, check_design, resolve_names
from .design_checks import lint, polygon_problems
from .materials import design_material, get as library_get

MAX_SOURCE = 32_000_000       # bytes per file
MAX_RINGS = 20000             # closed outlines per import
MAX_NEST = 1500               # outlines whose nesting (holes) is worked out
MAX_ARC_SEGMENTS = 2048
MAX_VIAS = 5000

ROLES = ("top_copper", "bottom_copper", "outline", "ignore")
_ROLE_ALIAS = {
    "top": "top_copper", "top_copper": "top_copper", "topcopper": "top_copper", "copper_top": "top_copper",
    "bottom": "bottom_copper", "bot": "bottom_copper", "bottom_copper": "bottom_copper",
    "bottomcopper": "bottom_copper", "copper_bottom": "bottom_copper",
    "outline": "outline", "edge": "outline", "profile": "outline", "edge_cuts": "outline", "board": "outline",
    "ignore": "ignore", "skip": "ignore", "none": "ignore", "off": "ignore",
}

SUPPORTED = {
    "dxf": "ASCII DXF: LWPOLYLINE and POLYLINE (closed, or open with coinciding ends; bulges are arcs), CIRCLE, ARC, "
           "ELLIPSE, LINE (lines, arcs and open polylines meeting end to end are assembled into loops); "
           "$INSUNITS; a loop inside a loop is a hole",
    "gerber": "RS-274X: G36/G37 regions, flashes of C, R, O and P apertures (with a hole), draws with circle or "
              "rectangle apertures (linear and G02/G03 arcs, G74/G75), MOMM / MOIN, FS with L or T zero omission, "
              "X2 file function (top / bottom / outline)",
    "drill": "Excellon: METRIC / INCH, LZ / TZ, tool definitions, plated holes as metal pins (vias)",
    "layers": "top copper at z = thickness, bottom copper at z = 0 (sheets of the metal material), the board outline "
              "(Edge.Cuts, Profile, Outline ...) sets the substrate box, else the copper's bounding box plus a margin",
}

# metres per unit of a DXF $INSUNITS code, in mm
_INSUNITS_MM = {1: 25.4, 2: 304.8, 4: 1.0, 5: 10.0, 6: 1000.0, 8: 25.4e-6, 9: 0.0254, 13: 1e-3, 14: 100.0}
_INSUNITS_NAME = {1: "inch", 2: "feet", 4: "mm", 5: "cm", 6: "m", 8: "microinch", 9: "mil", 13: "um", 14: "dm"}


class PcbImportError(ValueError):
    #: for "no copper outlines found": the layers that were read, as ``report["detected"]`` lists them
    detected: list | None = None


# ---------------------------------------------------------------------------- data model

@dataclass
class Poly:
    """One filled outline (mm) and the holes cut out of it. ``depth``: how many outlines enclose it."""
    outer: list
    holes: list = field(default_factory=list)
    depth: int = 0
    label: str = ""
    line: int | None = None


@dataclass
class RawLayer:
    """The geometry of one layer of a file, in mm, before it has a role."""
    name: str
    source: str
    kind: str                                   # "dxf", "gerber" or "drill"
    hint: str | None = None                     # role from the file itself (Gerber X2)
    rings: list = field(default_factory=list)   # closed outlines still to nest: (points, label, line)
    polys: list = field(default_factory=list)   # finished shapes (Gerber)
    open: list = field(default_factory=list)    # open paths that did not close: (points, label, line)
    extent: list = field(default_factory=list)  # points the layer covers (the board outline reads these)
    holes: list = field(default_factory=list)   # drills: {"x", "y", "d", "plated", "line"}
    skips: dict = field(default_factory=dict)   # (what, reason) -> [count, first line]
    notes: list = field(default_factory=list)   # (severity, message)
    counts: dict = field(default_factory=dict)  # entity kind -> number read
    units: str = "mm"

    def skip(self, what: str, reason: str, line: int | None = None, count: int = 1):
        entry = self.skips.setdefault((what, reason), [0, line])
        entry[0] += count

    def read(self, kind: str, n: int = 1):
        self.counts[kind] = self.counts.get(kind, 0) + n


class _Report:
    def __init__(self):
        self.notes: list[dict] = []
        self.created: list[dict] = []

    def note(self, severity: str, message: str, where: str, line: int | None = None):
        self.notes.append({"severity": severity, "where": where, "line": line or 0, "message": message})

    def made(self, kind: str, name: str, detail: str = ""):
        self.created.append({"kind": kind, "name": name, "detail": detail})


# ---------------------------------------------------------------------------- geometry helpers

def _seg_count(r: float, sweep: float, tol: float, minimum: int = 1) -> int:
    """Segments so that no chord of an arc of radius r and angle ``sweep`` is more than tol from it."""
    if sweep <= 0 or r <= 0:
        return minimum
    step = 2 * math.acos(max(-1.0, 1 - tol / r)) if tol < r else math.pi / 2
    n = math.ceil(sweep / step - 1e-9) if step > 1e-9 else MAX_ARC_SEGMENTS
    return max(minimum, min(MAX_ARC_SEGMENTS, n))


def _arc_pts(cx, cy, r, a0, sweep, tol, r1=None) -> list:
    """Points from angle a0 through the signed ``sweep`` (radians), both ends included; the radius
    goes linearly from r to r1 when given."""
    n = _seg_count(max(r, r1 or 0), abs(sweep), tol)
    out = []
    for k in range(n + 1):
        t = k / n
        a = a0 + sweep * t
        rr = r if r1 is None else r + (r1 - r) * t
        out.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return out


def _circle_pts(cx, cy, r, tol, minimum: int = 8) -> list:
    n = _seg_count(r, 2 * math.pi, tol, minimum)
    return [(cx + r * math.cos(2 * math.pi * k / n), cy + r * math.sin(2 * math.pi * k / n)) for k in range(n)]


def _bulge_pts(p, q, bulge, tol) -> list:
    """The arc from p to q with this DXF bulge (tan of a quarter of the included angle; positive:
    counter-clockwise), the ends included."""
    if abs(bulge) < 1e-12:
        return [p, q]
    dx, dy = q[0] - p[0], q[1] - p[1]
    chord = math.hypot(dx, dy)
    if chord < 1e-12:
        return [p, q]
    theta = 4 * math.atan(bulge)
    half = chord / 2
    r = half / math.sin(abs(theta) / 2)
    off = half / math.tan(theta / 2)
    cx = (p[0] + q[0]) / 2 + (-dy / chord) * off
    cy = (p[1] + q[1]) / 2 + (dx / chord) * off
    a0 = math.atan2(p[1] - cy, p[0] - cx)
    pts = _arc_pts(cx, cy, r, a0, theta, tol)
    pts[0], pts[-1] = p, q
    return pts


def _dist(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _area(r) -> float:
    return sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r))) / 2


def _bbox(pts):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def _clean_ring(pts, eps: float = 1e-9):
    """Without repeated points and the closing repeat; None below three points."""
    out = []
    for p in pts:
        if not out or _dist(p, out[-1]) > eps:
            out.append((p[0], p[1]))
    while len(out) > 1 and _dist(out[0], out[-1]) <= eps:
        out.pop()
    return out if len(out) >= 3 else None


def _pip(pt, ring) -> int:
    """1 inside, 0 outside, -1 on the boundary (within 1e-6) of a ring."""
    x, y = pt
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        l2 = dx * dx + dy * dy
        t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / l2))
        if math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= 1e-6:
            return -1
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * dx / (y2 - y1):
            inside = not inside
    return 1 if inside else 0


def _contains(outer, inner, obox, ibox) -> bool:
    if ibox[0] < obox[0] - 1e-6 or ibox[1] < obox[1] - 1e-6 or ibox[2] > obox[2] + 1e-6 or ibox[3] > obox[3] + 1e-6:
        return False
    inside = 0
    for p in inner:
        s = _pip(p, outer)
        if s == 0:
            return False
        inside += s == 1
    return inside > 0


def _nest(rings: list) -> tuple[list, bool]:
    """Polys from closed outlines ``(points, label, line)``: an outline inside one is its hole, one
    inside that hole is a new shape again (even depth: filled, odd: hole). Returns (polys, nested)."""
    n = len(rings)
    if n > MAX_NEST or n < 2:
        return [Poly(list(p), [], 0, label, line) for p, label, line in rings], n <= MAX_NEST
    areas = [abs(_area(p)) for p, _l, _n in rings]
    boxes = [_bbox(p) for p, _l, _n in rings]
    order = sorted(range(n), key=lambda i: -areas[i])
    parent = [None] * n
    for pos, i in enumerate(order):
        best = None
        for j in order[:pos]:
            if areas[j] > areas[i] * (1 + 1e-9) and (best is None or areas[j] < areas[best]) \
                    and _contains(rings[j][0], rings[i][0], boxes[j], boxes[i]):
                best = j
        parent[i] = best
    depth = [0] * n
    for i in order:
        depth[i] = 0 if parent[i] is None else depth[parent[i]] + 1
    polys: dict[int, Poly] = {}
    for i in order:
        if depth[i] % 2 == 0:
            p, label, line = rings[i]
            polys[i] = Poly(list(p), [], depth[i], label, line)
    for i in order:
        if depth[i] % 2 == 1 and parent[i] in polys:
            polys[parent[i]].holes.append(list(rings[i][0]))
    return [polys[i] for i in order if i in polys], True


def _chain(paths: list, tol: float):
    """Assemble open paths ``(points, label, line)`` that meet end to end (within ``tol``) into
    closed loops. Returns (rings, the paths left over)."""
    n = len(paths)
    grid: dict = {}

    def key(p):
        return (round(p[0] / tol), round(p[1] / tol))

    for i, (pts, _l, _n) in enumerate(paths):
        for end, p in ((0, pts[0]), (1, pts[-1])):
            grid.setdefault(key(p), []).append((i, end))
    unused = set(range(n))

    def find(p):
        kx, ky = key(p)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i, end in grid.get((kx + dx, ky + dy), ()):
                    if i in unused:
                        q = paths[i][0][0 if end == 0 else -1]
                        if _dist(p, q) <= tol:
                            return i, end
        return None

    rings, left = [], []
    for start in range(n):
        if start not in unused:
            continue
        unused.discard(start)
        chain = list(paths[start][0])
        used = [start]
        closed = False
        for side in ("tail", "head"):
            while True:
                if len(chain) >= 4 and _dist(chain[0], chain[-1]) <= tol:
                    closed = True
                    break
                hit = find(chain[-1] if side == "tail" else chain[0])
                if hit is None:
                    break
                i, end = hit
                unused.discard(i)
                used.append(i)
                seg = list(paths[i][0])
                if side == "tail":
                    chain += (seg if end == 0 else seg[::-1])[1:]
                else:
                    chain = (seg[::-1] if end == 0 else seg)[:-1] + chain
            if closed:
                break
        if closed:
            label = paths[start][1] if len(used) == 1 else f"{len(used)} joined segments"
            rings.append((chain[:-1], label, paths[used[0]][2]))
        else:
            left += [paths[i] for i in used]
    return rings, left


def _hull(points) -> list:
    pts = sorted(set((round(x, 9), round(y, 9)) for x, y in points))
    if len(pts) < 3:
        return pts

    def half(seq):
        h = []
        for p in seq:
            while len(h) >= 2 and (h[-1][0] - h[-2][0]) * (p[1] - h[-2][1]) - (h[-1][1] - h[-2][1]) * (p[0] - h[-2][0]) <= 0:
                h.pop()
            h.append(p)
        return h

    lower, upper = half(pts), half(pts[::-1])
    return lower[:-1] + upper[:-1]


def _capsule(p0, p1, r, tol) -> list:
    """The outline of the disc of radius r swept from p0 to p1."""
    if _dist(p0, p1) < 1e-9:
        return _circle_pts(p0[0], p0[1], r, tol)
    phi = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
    a = _arc_pts(p1[0], p1[1], r, phi - math.pi / 2, math.pi, tol)
    b = _arc_pts(p0[0], p0[1], r, phi + math.pi / 2, math.pi, tol)
    return a + b


# ---------------------------------------------------------------------------- DXF

_DXF_SKIP = {
    "TEXT": "text is not geometry", "MTEXT": "text is not geometry", "ATTRIB": "text is not geometry",
    "ATTDEF": "text is not geometry",
    "HATCH": "a hatch fill is not read; draw its boundary as a closed polyline on the layer",
    "SPLINE": "splines are not read; export the outline as polylines and arcs",
    "SOLID": "filled solids are not read; draw the outline as a closed polyline", "TRACE": "traces are not read",
    "3DFACE": "3D faces are not read", "INSERT": "block references are not expanded; explode the blocks in the CAD tool",
    "DIMENSION": "dimensions are not geometry", "LEADER": "leaders are not geometry", "POINT": "points are not geometry",
    "IMAGE": "images are not geometry", "MLINE": "multilines are not read", "RAY": "construction lines are not geometry",
    "XLINE": "construction lines are not geometry", "VIEWPORT": "viewports are not geometry",
    "REGION": "regions (ACIS solids) are not read", "3DSOLID": "3D solids are not read", "BODY": "3D solids are not read",
    "MESH": "meshes are not read", "WIPEOUT": "wipeouts are not read", "TOLERANCE": "tolerances are not geometry",
}


def _dxf_pairs(text: str):
    lines = text.splitlines()
    if lines and lines[0].startswith("AutoCAD Binary DXF"):
        raise PcbImportError("binary DXF is not supported: save the drawing as ASCII DXF")
    for k in range(0, len(lines) - 1, 2):
        try:
            code = int(lines[k].strip())
        except ValueError:
            raise PcbImportError(f"line {k + 1}: '{lines[k].strip()[:20]}' is not a DXF group code (is this an ASCII DXF?)") from None
        yield code, lines[k + 1].strip(), k + 1


def read_dxf(text: str) -> dict:
    """``{"units": $INSUNITS or None, "entities": [{"type", "codes", "line"}]}`` of an ASCII DXF."""
    units = None
    entities: list[dict] = []
    section = None
    var = None
    cur = None
    for code, val, ln in _dxf_pairs(text):
        if code == 0:
            if cur is not None:
                entities.append(cur)
                cur = None
            if val == "SECTION":
                section = "?"
            elif val == "ENDSEC":
                section = None
            elif val == "EOF":
                break
            elif section == "ENTITIES":
                cur = {"type": val, "codes": [], "line": ln}
            continue
        if section == "?" and code == 2:
            section = val
        elif section == "HEADER":
            if code == 9:
                var = val
            elif var == "$INSUNITS" and code == 70:
                try:
                    units = int(val)
                except ValueError:
                    pass
        elif cur is not None:
            cur["codes"].append((code, val, ln))
    if cur is not None:
        entities.append(cur)
    if not entities and units is None and section is None and not text.lstrip().startswith("0"):
        raise PcbImportError("not a DXF file")
    return {"units": units, "entities": entities}


def _f(codes, code, default=0.0):
    for c, v, _l in codes:
        if c == code:
            try:
                return float(v)
            except ValueError:
                return default
    return default


def _layer_of(codes) -> str:
    for c, v, _l in codes:
        if c == 8:
            return v or "0"
    return "0"


def _flip(codes) -> bool | None:
    """True for a mirrored OCS (extrusion -z), False for +z, None for any other extrusion."""
    nz = _f(codes, 230, 1.0)
    nx, ny = _f(codes, 210, 0.0), _f(codes, 220, 0.0)
    if abs(nx) > 1e-9 or abs(ny) > 1e-9:
        return None
    return nz < 0


def _ellipse_pts(codes, tol):
    cx, cy = _f(codes, 10), _f(codes, 20)
    mx, my = _f(codes, 11), _f(codes, 21)
    ratio = _f(codes, 40, 1.0)
    t0, t1 = _f(codes, 41, 0.0), _f(codes, 42, 2 * math.pi)
    if t1 <= t0:
        t1 += 2 * math.pi
    a = math.hypot(mx, my)
    n = _seg_count(a, t1 - t0, tol, 8)
    sx, sy = -my * ratio, mx * ratio
    pts = [(cx + mx * math.cos(t0 + (t1 - t0) * k / n) + sx * math.sin(t0 + (t1 - t0) * k / n),
            cy + my * math.cos(t0 + (t1 - t0) * k / n) + sy * math.sin(t0 + (t1 - t0) * k / n)) for k in range(n + 1)]
    return pts, abs((t1 - t0) - 2 * math.pi) < 1e-9


def _lwpolyline(codes, tol):
    verts = []
    closed = False
    for c, v, _l in codes:
        try:
            x = float(v)
        except ValueError:
            continue
        if c == 10:
            verts.append([x, 0.0, 0.0])
        elif c == 20 and verts:
            verts[-1][1] = x
        elif c == 42 and verts:
            verts[-1][2] = x
        elif c == 70:
            closed = bool(int(x) & 1)
    return verts, closed


def _poly_pts(verts, closed, tol):
    pts = []
    n = len(verts)
    for i in range(n if closed else n - 1):
        a, b = verts[i], verts[(i + 1) % n]
        seg = _bulge_pts((a[0], a[1]), (b[0], b[1]), a[2], tol)
        pts += seg if not pts else seg[1:]
    if closed and len(pts) > 1:
        pts.pop()   # the closing segment ends where the polyline started
    return pts


def parse_dxf(text: str, source: str, *, units: str, chord_tol: float) -> list[RawLayer]:
    """The layers of an ASCII DXF as :class:`RawLayer` (mm)."""
    doc = read_dxf(text)
    code = doc["units"]
    if units == "auto":
        if code in _INSUNITS_MM:
            scale, unit = _INSUNITS_MM[code], _INSUNITS_NAME[code]
            note = None
        elif code in (None, 0):
            scale, unit = 1.0, "mm"
            note = ("warning", "the DXF does not say its units ($INSUNITS): mm assumed (use --units inch if the drawing is in inches)")
        else:
            scale, unit = 1.0, "mm"
            note = ("warning", f"DXF unit code {code} is not known: mm assumed (use --units)")
    else:
        scale, unit = {"mm": 1.0, "inch": 25.4}[units], units
        note = None
        if code in _INSUNITS_MM and abs(_INSUNITS_MM[code] - scale) > 1e-9:
            note = ("warning", f"--units {units} overrides the DXF's own unit ({_INSUNITS_NAME[code]})")
    tol = chord_tol / scale
    layers: dict[str, RawLayer] = {}

    def layer(name):
        if name not in layers:
            layers[name] = RawLayer(name, source, "dxf", units=unit)
            if note:
                layers[name].notes.append(note)
        return layers[name]

    def add(lay, pts, closed, label, line):
        pts = [(x * scale, y * scale) for x, y in pts]
        lay.extent += pts
        if closed:
            lay.rings.append((pts, label, line))
        else:
            lay.open.append((pts, label, line))

    ents = doc["entities"]
    i = 0
    while i < len(ents):
        e = ents[i]
        i += 1
        t, codes, ln = e["type"], e["codes"], e["line"]
        lay = layer(_layer_of(codes))
        if t == "VERTEX" or t == "SEQEND":
            continue
        if t in ("LWPOLYLINE", "POLYLINE", "CIRCLE", "ARC", "ELLIPSE", "LINE"):
            flip = _flip(codes)
            if flip is None:
                lay.skip(t, "the entity is not in a plane parallel to XY", ln)
                if t == "POLYLINE":
                    while i < len(ents) and ents[i]["type"] != "SEQEND":
                        i += 1
                continue
        if t == "LWPOLYLINE":
            verts, closed = _lwpolyline(codes, tol)
            if len(verts) < 2:
                lay.skip(t, "fewer than two vertices", ln)
                continue
            pts = _poly_pts(verts, closed, tol)
            if flip:
                pts = [(-x, y) for x, y in pts]
            if not closed and len(pts) >= 4 and _dist(pts[0], pts[-1]) <= 1e-6 / scale:
                closed, pts = True, pts[:-1]
            lay.read(t)
            add(lay, pts, closed, "polyline", ln)
        elif t == "POLYLINE":
            flags = int(_f(codes, 70, 0))
            verts = []
            while i < len(ents) and ents[i]["type"] != "SEQEND":
                if ents[i]["type"] == "VERTEX":
                    vc = ents[i]["codes"]
                    vf = int(_f(vc, 70, 0))
                    if not vf & 16:   # 16: spline frame control point
                        verts.append([_f(vc, 10), _f(vc, 20), _f(vc, 42)])
                i += 1
            if flags & (8 | 16 | 64):
                lay.skip(t, "3D polylines and meshes are not read", ln)
            elif flags & 4 or int(_f(codes, 75, 0)):
                lay.skip(t, "spline-fit polylines are not read; export the outline as polylines and arcs", ln)
            elif len(verts) < 2:
                lay.skip(t, "fewer than two vertices", ln)
            else:
                closed = bool(flags & 1)
                pts = _poly_pts(verts, closed, tol)
                if flip:
                    pts = [(-x, y) for x, y in pts]
                if not closed and len(pts) >= 4 and _dist(pts[0], pts[-1]) <= 1e-6 / scale:
                    closed, pts = True, pts[:-1]
                lay.read(t)
                add(lay, pts, closed, "polyline", ln)
        elif t == "CIRCLE":
            r = _f(codes, 40)
            if r <= 0:
                lay.skip(t, "the radius is not positive", ln)
                continue
            cx = -_f(codes, 10) if flip else _f(codes, 10)
            lay.read(t)
            add(lay, _circle_pts(cx, _f(codes, 20), r, tol), True, f"circle r={r * scale:.4g}", ln)
        elif t == "ARC":
            r = _f(codes, 40)
            a0, a1 = math.radians(_f(codes, 50)), math.radians(_f(codes, 51))
            if r <= 0:
                lay.skip(t, "the radius is not positive", ln)
                continue
            if a1 <= a0:
                a1 += 2 * math.pi
            cx, cy = _f(codes, 10), _f(codes, 20)
            pts = _arc_pts(cx, cy, r, a0, a1 - a0, tol)
            if flip:
                pts = [(-x, y) for x, y in pts]
            lay.read(t)
            add(lay, pts, False, "arc", ln)
        elif t == "LINE":
            p = (_f(codes, 10), _f(codes, 20))
            q = (_f(codes, 11), _f(codes, 21))
            if flip:
                p, q = (-p[0], p[1]), (-q[0], q[1])
            lay.read(t)
            add(lay, [p, q], False, "line", ln)
        elif t == "ELLIPSE":
            pts, full = _ellipse_pts(codes, tol)
            lay.read(t)
            if flip:
                pts = [(-x, y) for x, y in pts]
            add(lay, pts[:-1] if full else pts, full, "ellipse", ln)
        elif t in _DXF_SKIP:
            lay.skip(t, _DXF_SKIP[t], ln)
        else:
            lay.skip(t, "this entity type is not read", ln)
    # lines, arcs and open polylines meeting end to end form loops
    join = 1e-3
    for lay in layers.values():
        if lay.open:
            before = len(lay.open)
            rings, left = _chain(lay.open, join)
            joined = sum(1 for r in rings if r[1].endswith("segments"))
            lay.rings += rings
            lay.open = left
            if joined:
                lay.notes.append(("info", f"{joined} loop(s) assembled from {before - len(left)} lines, arcs and open polylines "
                                  f"meeting end to end (within {join * 1000:g} um)"))
    return [lay for lay in layers.values() if lay.rings or lay.open or lay.skips]


# ---------------------------------------------------------------------------- Gerber

def _line_index(text: str):
    starts = [0]
    for m in re.finditer("\n", text):
        starts.append(m.end())
    return starts


class _Gerber:
    def __init__(self, text: str, source: str, chord_tol: float):
        self.lay = RawLayer(re.sub(r"\.[^.]*$", "", PurePath(source).name) or source, source, "gerber")
        self.text = text
        self.tol = chord_tol
        self.unit = None       # mm per unit
        self.fmt = None        # (int digits x, dec x, int y, dec y)
        self.zero = "L"
        self.apertures: dict[int, dict] = {}
        self.macros: set[str] = set()
        self.cur = None
        self.mode = 1
        self.multi = True
        self.region = False
        self.contour: list = []
        self.pos = (0.0, 0.0)
        self.dark = True
        self.last_op = 2
        self.line = 0
        self.starts = _line_index(text)
        self.stroked = 0
        self.role_note = None

    # ---- numbers
    def num(self, s: str, dec: int, integer: int) -> float:
        sign = -1.0 if s.startswith("-") else 1.0
        body = s.lstrip("+-")
        if "." in body:
            return sign * float(body) * self.unit
        if self.zero == "T":
            body = body.ljust(integer + dec, "0")
        return sign * (int(body or "0") / 10 ** dec) * self.unit

    def skip(self, what, reason, count=1):
        self.lay.skip(what, reason, self.line, count)

    # ---- objects
    def add_poly(self, outer, holes=(), label=""):
        if not self.dark:
            self.skip("clear polarity object", "clear polarity (LPC) objects are not applied; the dark copper under them stays")
            return
        if len(self.lay.polys) >= MAX_RINGS:
            raise PcbImportError(f"{self.lay.source}: more than {MAX_RINGS} shapes")
        self.lay.polys.append(Poly(list(outer), [list(h) for h in holes], 0, label, self.line))

    def flash(self, x, y):
        ap = self.apertures.get(self.cur)
        if ap is None:
            self.skip("flash", f"aperture D{self.cur} is not defined")
            return
        kind = ap["type"]
        if kind == "bad":
            self.skip("flash", f"aperture D{self.cur} could not be read")
            return
        if kind not in ("C", "R", "O", "P"):
            self.skip(f"flash of aperture macro {kind}", "aperture macros (AM) are not read; use standard apertures or regions")
            return
        self.lay.extent.append((x, y))
        hole = ap.get("hole")
        if kind == "C":
            outer = _circle_pts(x, y, ap["d"] / 2, self.tol)
        elif kind == "R":
            w, h = ap["w"] / 2, ap["h"] / 2
            outer = [(x - w, y - h), (x + w, y - h), (x + w, y + h), (x - w, y + h)]
        elif kind == "O":
            w, h = ap["w"], ap["h"]
            if w >= h:
                outer = _capsule((x - (w - h) / 2, y), (x + (w - h) / 2, y), h / 2, self.tol)
            else:
                outer = _capsule((x, y - (h - w) / 2), (x, y + (h - w) / 2), w / 2, self.tol)
        else:
            n, r = int(ap["n"]), ap["d"] / 2
            rot = math.radians(ap.get("rot", 0.0))
            outer = [(x + r * math.cos(rot + 2 * math.pi * k / n), y + r * math.sin(rot + 2 * math.pi * k / n)) for k in range(n)]
        holes = [_circle_pts(x, y, hole / 2, self.tol)] if hole and hole > 0 else []
        self.lay.read("flash")
        self.add_poly(outer, holes, f"flash D{self.cur}")

    def arc_geometry(self, p0, p1, i, j):
        """(centre, start angle, signed sweep, r0, r1) of the arc p0 -> p1, or None."""
        cw = self.mode == 2
        same = _dist(p0, p1) < 1e-9
        if self.multi:
            cands = [(p0[0] + i, p0[1] + j)]
        else:
            cands = [(p0[0] + sx * abs(i), p0[1] + sy * abs(j)) for sx in (1, -1) for sy in (1, -1)]
        best = None
        for c in cands:
            r0, r1 = _dist(c, p0), _dist(c, p1)
            if r0 < 1e-12:
                continue
            a0 = math.atan2(p0[1] - c[1], p0[0] - c[0])
            a1 = math.atan2(p1[1] - c[1], p1[0] - c[0])
            sweep = -((a0 - a1) % (2 * math.pi)) if cw else (a1 - a0) % (2 * math.pi)
            if same:
                sweep = (-2 * math.pi if cw else 2 * math.pi) if self.multi else 0.0
            if not self.multi and abs(sweep) > math.pi / 2 + 1e-6:
                continue
            err = abs(r0 - r1)
            if best is None or err < best[0]:
                best = (err, c, a0, sweep, r0, r1)
        return None if best is None else best[1:]

    def draw(self, p0, p1, i, j, has_ij):
        ap = self.apertures.get(self.cur)
        if ap is None:
            self.skip("draw", f"aperture D{self.cur} is not defined")
            return
        if ap["type"] not in ("C", "R"):
            what = "obround or polygon" if ap["type"] in ("O", "P") else "macro"
            self.skip("draw", f"draws with a {what} aperture are not read; use a circle or rectangle aperture")
            return
        arc = self.mode in (2, 3)
        self.lay.read("draw")
        pts = [p0, p1]
        geo = None
        if arc:
            if not has_ij:
                self.skip("arc draw", "arc without I/J offsets")
                return
            geo = self.arc_geometry(p0, p1, i, j)
            if geo is None:
                self.skip("arc draw", "the arc centre could not be found")
                return
            c, a0, sweep, r0, r1 = geo
            pts = _arc_pts(c[0], c[1], r0, a0, sweep, self.tol, r1)
        self.lay.extent += pts
        if not self.dark:
            self.skip("clear polarity object", "clear polarity (LPC) objects are not applied; the dark copper under them stays")
            return
        if ap["type"] == "C":
            w = ap["d"] / 2
            if w <= 0:
                return
            if geo is not None:
                c, a0, sweep, r0, r1 = geo
                R = (r0 + r1) / 2
                if abs(sweep) >= 2 * math.pi - 1e-6 and R > w:
                    self.add_poly(_circle_pts(c[0], c[1], R + w, self.tol), [_circle_pts(c[0], c[1], R - w, self.tol)], "arc stroke")
                    return
                if R > w:
                    a1 = a0 + sweep
                    sg = 1 if sweep > 0 else -1
                    outer = _arc_pts(c[0], c[1], R + w, a0, sweep, self.tol)
                    inner = _arc_pts(c[0], c[1], R - w, a1, -sweep, self.tol)
                    pe = (c[0] + R * math.cos(a1), c[1] + R * math.sin(a1))
                    ps = (c[0] + R * math.cos(a0), c[1] + R * math.sin(a0))
                    cap_e = _arc_pts(pe[0], pe[1], w, a1, sg * math.pi, self.tol)[1:-1]
                    cap_s = _arc_pts(ps[0], ps[1], w, a0 + math.pi, sg * math.pi, self.tol)[1:-1]
                    self.add_poly(outer + cap_e + inner + cap_s, (), "arc stroke")
                    return
            for a, b in zip(pts, pts[1:]):
                self.add_poly(_capsule(a, b, w, self.tol), (), "stroke")
        else:
            hw, hh = ap["w"] / 2, ap["h"] / 2
            if arc:
                self.lay.notes.append(("info", "an arc drawn with a rectangle aperture is a chain of straight strokes"))
            for a, b in zip(pts, pts[1:]):
                corners = [(a[0] + sx * hw, a[1] + sy * hh) for sx in (-1, 1) for sy in (-1, 1)]
                corners += [(b[0] + sx * hw, b[1] + sy * hh) for sx in (-1, 1) for sy in (-1, 1)]
                self.add_poly(_hull(corners), (), "stroke")

    def contour_add(self, p1, i, j, has_ij):
        if not self.contour:
            self.contour.append(self.pos)
        if self.mode in (2, 3):
            geo = self.arc_geometry(self.pos, p1, i, j) if has_ij else None
            if geo is None:
                self.skip("region arc", "arc without a usable centre; drawn as a line")
                self.contour.append(p1)
                return
            c, a0, sweep, r0, r1 = geo
            self.contour += _arc_pts(c[0], c[1], r0, a0, sweep, self.tol, r1)[1:]
        else:
            self.contour.append(p1)

    def contour_close(self):
        pts = self.contour
        self.contour = []
        if len(pts) < 3:
            if pts:
                self.skip("region contour", "fewer than three points")
            return
        if _dist(pts[0], pts[-1]) > 1e-4:
            self.lay.notes.append(("warning", "a region contour did not end where it started: closed with a straight line"))
        self.lay.extent += pts
        self.lay.read("region")
        self.add_poly(pts, (), "region")

    # ---- commands
    def apply(self, op, x, y, i, j, has_ij):
        p1 = (x, y)
        if self.region:
            if op == 2:
                self.contour_close()
                self.contour = [p1]
            elif op == 1:
                self.contour_add(p1, i, j, has_ij)
            else:
                self.skip("flash in a region", "a flash inside G36/G37 is not allowed")
        else:
            if op == 1:
                self.draw(self.pos, p1, i, j, has_ij)
            elif op == 3:
                self.flash(x, y)
        self.pos = p1

    def extended(self, cmd: str):
        cmd = re.sub(r"\s+", "", cmd)
        if cmd.startswith("FS"):
            m = re.match(r"FS([LTD]?)([AI]?)X(\d)(\d)Y(\d)(\d)", cmd)
            if not m:
                raise PcbImportError(f"{self.lay.source}: unreadable format statement %{cmd}%")
            self.zero = "T" if m.group(1) == "T" else "L"
            if m.group(2) == "I":
                raise PcbImportError(f"{self.lay.source}: incremental coordinates are not supported")
            self.fmt = (int(m.group(3)), int(m.group(4)), int(m.group(5)), int(m.group(6)))
        elif cmd.startswith("MO"):
            self.unit = 25.4 if cmd[2:4] == "IN" else 1.0
            self.lay.units = "inch" if self.unit == 25.4 else "mm"
        elif cmd.startswith("AD"):
            m = re.match(r"ADD(\d+)([A-Za-z_][\w.$]*)(?:,(.*))?$", cmd)
            if not m:
                return
            d, kind, params = int(m.group(1)), m.group(2), m.group(3)
            try:
                v = [float(x) for x in params.split("X")] if params else []
            except ValueError:
                v = []
            u = self.unit or 1.0
            if kind == "C" and v:
                self.apertures[d] = {"type": "C", "d": v[0] * u, "hole": v[1] * u if len(v) > 1 else None}
            elif kind in ("R", "O") and len(v) >= 2:
                self.apertures[d] = {"type": kind, "w": v[0] * u, "h": v[1] * u, "hole": v[2] * u if len(v) > 2 else None}
            elif kind == "P" and len(v) >= 2:
                self.apertures[d] = {"type": "P", "d": v[0] * u, "n": v[1], "rot": v[2] if len(v) > 2 else 0.0,
                                     "hole": v[3] * u if len(v) > 3 else None}
            elif kind in ("C", "R", "O", "P"):
                self.apertures[d] = {"type": "bad"}
            else:
                self.apertures[d] = {"type": kind}   # a macro
        elif cmd.startswith("AM"):
            self.macros.add(cmd[2:].split("*")[0])
        elif cmd.startswith("LP"):
            self.dark = cmd[2:3] != "C"
        elif cmd.startswith(("SR",)) and cmd != "SR":
            self.skip("step and repeat", "step and repeat (SR) blocks are not expanded; only one copy is read")
        elif cmd.startswith(("AB",)) and cmd != "AB":
            self.skip("block aperture", "block apertures (AB) are not read")
        elif cmd[:2] in ("LM", "LR", "LS") and not re.fullmatch(r"L[MRS](N|0|1(\.0*)?)?", cmd):
            self.skip("aperture transform", "aperture mirroring, rotation and scaling (LM, LR, LS) are not applied")
        elif cmd.startswith("TF.FileFunction"):
            self.file_function(cmd.split(",")[1:])

    def file_function(self, f):
        if not f:
            return
        kind = f[0].lower()
        if kind == "copper":
            side = (f[2].lower() if len(f) > 2 else "")
            self.lay.hint = "top_copper" if side.startswith("top") else "bottom_copper" if side.startswith("bot") else "ignore"
            if self.lay.hint == "ignore":
                self.role_note = "inner copper layers are not imported"
        elif kind == "profile":
            self.lay.hint = "outline"
        elif kind in ("legend", "soldermask", "paste", "glue", "carbonmask", "goldmask", "peelablemask", "other", "drillmap",
                      "fabrication", "vcut", "vcutmap", "assembly", "array", "keepout", "component", "depthroute", "viafill"):
            self.lay.hint = "ignore"

    def word(self, cmd: str):
        cmd = re.sub(r"\s+", "", cmd)
        if not cmd or cmd.startswith("G04"):
            return
        if cmd.startswith(("M02", "M00", "M30")):
            return
        vals = {}
        gs = []
        d = None
        for letter, num in re.findall(r"([GDMXYIJN])([+-]?[\d.]+)", cmd):
            if letter == "G":
                gs.append(int(float(num)))
            elif letter == "D":
                d = int(float(num))
            elif letter in "XYIJ":
                vals[letter] = num
        for g in gs:
            if g in (1, 2, 3):
                self.mode = g
            elif g == 36:
                self.region, self.contour = True, []
            elif g == 37:
                self.contour_close()
                self.region = False
            elif g == 74:
                self.multi = False
            elif g == 75:
                self.multi = True
            elif g == 70:
                self.unit = 25.4
            elif g == 71:
                self.unit = 1.0
            elif g == 91:
                raise PcbImportError(f"{self.lay.source}: incremental coordinates are not supported")
        if d is not None and d >= 10:
            self.cur = d
            return
        if self.unit is None:
            raise PcbImportError(f"{self.lay.source}: coordinates before the unit statement (MOMM / MOIN)")
        if self.fmt is None:
            raise PcbImportError(f"{self.lay.source}: coordinates before the format statement (FS)")
        if not vals and d is None:
            return
        xi, xd, yi, yd = self.fmt
        x = self.num(vals["X"], xd, xi) if "X" in vals else self.pos[0]
        y = self.num(vals["Y"], yd, yi) if "Y" in vals else self.pos[1]
        i = self.num(vals["I"], xd, xi) if "I" in vals else 0.0
        j = self.num(vals["J"], yd, yi) if "J" in vals else 0.0
        op = d if d in (1, 2, 3) else self.last_op
        self.last_op = op
        self.apply(op, x, y, i, j, "I" in vals or "J" in vals)

    def run(self) -> RawLayer:
        for m in re.finditer(r"%([^%]*)%|([^*%]*)\*", self.text):
            self.line = bisect_right(self.starts, m.start())
            if m.group(1) is not None:
                for part in m.group(1).split("*"):
                    if part.strip():
                        self.extended(part)
            else:
                self.word(m.group(2))
        if self.region and self.contour:
            self.contour_close()
        for name in sorted(self.macros):
            n = sum(1 for a in self.apertures.values() if a["type"] == name)
            if n:
                self.lay.notes.append(("info", f"aperture macro {name} used by {n} aperture(s)"))
        if self.role_note:
            self.lay.notes.append(("info", self.role_note))
        return self.lay


def parse_gerber(text: str, source: str, *, chord_tol: float) -> RawLayer:
    return _Gerber(text, source, chord_tol).run()


# ---------------------------------------------------------------------------- Excellon

def parse_excellon(text: str, source: str) -> RawLayer:
    lay = RawLayer(re.sub(r"\.[^.]*$", "", PurePath(source).name) or source, source, "drill", hint="drill")
    unit = None
    zero = "L"
    tools: dict[int, float] = {}
    cur = None
    header = False
    plated = True
    for ln, raw in enumerate(text.splitlines(), 1):
        s = raw.strip()
        if not s:
            continue
        if s.startswith(";"):
            low = s.lower()
            if "nonplated" in low or "non-plated" in low or "npth" in low:
                plated = False
            elif "plated" in low or "pth" in low:
                plated = True
            continue
        if s == "M48":
            header = True
            continue
        if s in ("%", "M95"):
            header = False
            continue
        if s.startswith(("M30", "M00")):
            continue
        m = re.match(r"(METRIC|INCH)(?:,(LZ|TZ))?", s)
        if m:
            unit = 25.4 if m.group(1) == "INCH" else 1.0
            if m.group(2):
                zero = "T" if m.group(2) == "TZ" else "L"
            continue
        m = re.match(r"T(\d+)(?:.*?C([\d.]+))", s)
        if m and (header or "C" in s):
            tools[int(m.group(1))] = float(m.group(2))
            continue
        m = re.fullmatch(r"T(\d+)", s)
        if m:
            cur = int(m.group(1))
            header = False
            continue
        if re.match(r"(G0[0-3]|G8[5]|M1[56])", s):
            lay.skip("routed slot or path", "routed slots (G00-G03, G85, M15/M16) are not read", ln)
            continue
        if s.startswith(("G05", "G90", "G91", "FMAT", "ICI", "VER", "R", "%")):
            continue
        m = re.match(r"X([+-]?[\d.]+)Y([+-]?[\d.]+)$", s)
        if m and not header:
            if cur is None or cur not in tools:
                lay.skip("hole", "no tool selected or defined for the hole", ln)
                continue
            u = unit
            if u is None:
                u = 1.0
                if not any(n[1].startswith("the drill file") for n in lay.notes):
                    lay.notes.append(("warning", "the drill file does not say its units (METRIC / INCH): mm assumed"))

            def conv(v):
                sign = -1.0 if v.startswith("-") else 1.0
                body = v.lstrip("+-")
                if "." in body:
                    return sign * float(body) * u
                dec = 4 if u == 25.4 else 3
                total = 6
                if zero == "T":
                    body = body.ljust(total, "0")
                return sign * int(body) / 10 ** dec * u

            d = tools[cur] * u
            if d > 0:
                lay.holes.append({"x": conv(m.group(1)), "y": conv(m.group(2)), "d": d, "plated": plated, "line": ln})
                lay.extent.append((lay.holes[-1]["x"], lay.holes[-1]["y"]))
            continue
    if not lay.holes and not lay.skips:
        lay.notes.append(("warning", "no holes found in the drill file"))
    if re.search(r"npth|non[-_ ]?plated", source, re.I):
        for h in lay.holes:
            h["plated"] = False
    return lay


# ---------------------------------------------------------------------------- layer roles

def parse_layer_map(text: str | dict | None) -> dict:
    """``"TOP=top_copper,BOT=bottom_copper"`` (or a dict) as ``{name: role}``; the role is one of
    ``ROLES`` (aliases such as top, bot, edge and skip are accepted)."""
    if not text:
        return {}
    pairs = text.items() if isinstance(text, dict) else []
    if isinstance(text, str):
        pairs = []
        for item in text.split(","):
            if not item.strip():
                continue
            if "=" not in item:
                raise PcbImportError(f"layer map entry '{item.strip()}' needs the form NAME=role")
            k, v = item.split("=", 1)
            pairs.append((k.strip(), v.strip()))
    out = {}
    for k, v in pairs:
        role = _ROLE_ALIAS.get(str(v).strip().lower().replace("-", "_").replace(" ", "_").replace(".", "_"))
        if not k or role is None:
            raise PcbImportError(f"layer map entry '{k}={v}': the role must be one of {', '.join(ROLES)} "
                                 "(top, bottom, edge and skip are accepted too)")
        out[str(k)] = role
    return out


def guess_role(name: str) -> str | None:
    """A role from a layer or file name (KiCad, Altium, Eagle and generic names), else None."""
    low = name.lower()
    tokens = set(t for t in re.split(r"[^a-z0-9]+", low) if t)
    joined = re.sub(r"[^a-z0-9]", "", low)
    if tokens & {"silk", "silks", "silkscreen", "mask", "paste", "overlay", "legend", "fab", "crtyd", "courtyard", "gto",
                 "gts", "gtp", "gbo", "gbs", "gbp", "assembly", "adhesive", "drill", "drl", "comment", "comments"}:
        return "ignore"
    if tokens & {"outline", "profile", "gko", "gm1", "gml", "edge", "edgecuts", "boardoutline"} or "edgecuts" in joined \
            or "boardoutline" in joined:
        return "outline"
    if tokens & {"top", "gtl", "front", "toplayer", "l1"} or {"f", "cu"} <= tokens or "topcopper" in joined or "coppertop" in joined:
        return "top_copper"
    if tokens & {"bottom", "bot", "gbl", "back", "bottomlayer", "botlayer", "l2"} or {"b", "cu"} <= tokens \
            or "bottomcopper" in joined or "copperbottom" in joined:
        return "bottom_copper"
    return None


def _match_map(layer_map: dict, lay: RawLayer):
    """(role, key) from the user's layer map for this layer, else (None, None)."""
    names = {lay.name.lower(), PurePath(lay.source).name.lower(), PurePath(lay.source).stem.lower()}
    for key, role in layer_map.items():
        k = key.lower()
        if k in names or any(fnmatch.fnmatchcase(n, k) for n in names):
            return role, key
    return None, None


def sniff(name: str, text: str) -> str:
    """"dxf", "gerber" or "drill" from the file name and content."""
    ext = PurePath(name).suffix.lower()
    head = text[:4000]
    if ext == ".dxf" or re.match(r"\s*0\s*\r?\n\s*SECTION", head):
        return "dxf"
    if re.search(r"^M48\s*$", head, re.M) or ext in (".drl", ".xln", ".exc", ".ncd") and "%FS" not in head:
        return "drill"
    if "%FS" in head or "%MO" in head or ext in (".gbr", ".ger", ".gtl", ".gbl", ".gko", ".gm1", ".gbo", ".gto", ".gts", ".gbs"):
        return "gerber"
    raise PcbImportError(f"{name}: not recognised as DXF, Gerber or Excellon (expected .dxf, a Gerber file with %FS ... %, "
                         "or an Excellon drill with M48)")


# ---------------------------------------------------------------------------- the import

def _decode(data) -> str:
    if isinstance(data, str):
        return data.lstrip("﻿")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("cp1252", errors="replace")


def _poly_prim(ring, elev) -> dict:
    return {"kind": "polygon", "normal": "z", "elevation": elev, "points": [[round(x, 6), round(y, 6)] for x, y in ring]}


def _round_ring(ring, dx, dy):
    return _clean_ring([(round(x + dx, 6), round(y + dy, 6)) for x, y in ring], 1e-7)


def import_pcb(files, *, layer_map=None, substrate: str = "FR4", thickness: float = 1.6, eps_r: float | None = None,
               tan_d: float | None = None, units: str = "auto", chord_tol: float = 0.02, margin: float = 2.0,
               f0: float = 2.45, origin: str = "center", model_id: str = "imported-pcb", name: str | None = None) -> dict:
    """``{"design", "report"}`` of PCB artwork.

    ``files``: ``[(file name, bytes or text), ...]`` of DXF, Gerber and Excellon files.
    ``layer_map``: ``"TOP=top_copper,BOT=bottom_copper"`` or a dict (layer name, file name or a
    pattern -> top_copper / bottom_copper / outline / ignore); names not mapped are guessed.
    ``substrate`` is a library id (fr4, ro4003c ...) or a name; ``eps_r`` / ``tan_d`` override it.
    ``units``: ``auto`` (DXF $INSUNITS; Gerber and Excellon carry their own), ``mm`` or ``inch``.
    ``chord_tol``: largest distance (mm) between a tessellated arc's chord and the arc.
    ``margin``: mm added around the copper when there is no board outline layer.
    ``origin``: ``center`` moves the board centre to x = y = 0, ``keep`` keeps the file's coordinates.
    """
    units = {"in": "inch", "inches": "inch", "millimeter": "mm"}.get(str(units).lower(), str(units).lower())
    if units not in ("auto", "mm", "inch"):
        raise PcbImportError("units must be auto, mm or inch")
    if origin not in ("center", "keep"):
        raise PcbImportError("origin must be center or keep")
    if not (thickness > 0 and math.isfinite(thickness)):
        raise PcbImportError("the substrate thickness must be positive")
    if not (1e-4 <= chord_tol <= 5):
        raise PcbImportError("the chord tolerance must be between 0.0001 and 5 mm")
    if margin < 0 or not math.isfinite(margin):
        raise PcbImportError("the margin cannot be negative")
    if not (f0 > 0 and math.isfinite(f0)):
        raise PcbImportError("f0 must be positive")
    lmap = parse_layer_map(layer_map)
    files = list(files)
    if not files:
        raise PcbImportError("no files to import")
    rep = _Report()
    raw: list[RawLayer] = []
    for fname, data in files:
        fname = PurePath(str(fname)).name
        if len(data) > MAX_SOURCE:
            raise PcbImportError(f"{fname} is larger than {MAX_SOURCE // 1_000_000} MB")
        text = _decode(data)
        kind = sniff(fname, text)
        try:
            if kind == "dxf":
                layers = parse_dxf(text, fname, units=units, chord_tol=chord_tol)
                if not layers:
                    rep.note("warning", "no drawable entities found", fname)
            elif kind == "gerber":
                layers = [parse_gerber(text, fname, chord_tol=chord_tol)]
                if units != "auto" and layers[0].units != units:
                    rep.note("info", f"--units applies to DXF files; {fname} says its own units ({layers[0].units})", fname)
            else:
                layers = [parse_excellon(text, fname)]
        except RecursionError:
            raise PcbImportError(f"{fname} could not be read") from None
        raw += layers
    if sum(len(lay.rings) + len(lay.polys) for lay in raw) > MAX_RINGS:
        raise PcbImportError(f"more than {MAX_RINGS} outlines in the files")

    # ---- roles
    used_keys = set()
    roles: dict[int, str | None] = {}
    why: dict[int, str] = {}
    for n, lay in enumerate(raw):
        role, key = _match_map(lmap, lay)
        if role is not None:
            used_keys.add(key)
            roles[n], why[n] = role, f"layer map {key}"
        elif lay.kind == "drill":
            roles[n], why[n] = "drill", "Excellon file"
        elif lay.hint:
            roles[n], why[n] = lay.hint, "Gerber file function"
        else:
            g = guess_role(lay.name) if lay.kind == "dxf" else (guess_role(lay.name) or guess_role(PurePath(lay.source).suffix.lstrip(".")))
            roles[n], why[n] = g, "layer name"
    for key in lmap:
        if key not in used_keys:
            rep.note("warning", f"layer map entry '{key}' matches no layer (layers found: "
                     f"{', '.join(sorted({l.name for l in raw})[:12]) or 'none'})", "layer map")
    # a lone unrecognised layer of geometry is the copper
    def has_geo(lay):
        return bool(lay.rings or lay.polys or lay.open)

    if not any(r in ("top_copper", "bottom_copper") for r in roles.values()):
        cand = [n for n, lay in enumerate(raw) if roles[n] is None and lay.kind != "drill" and (lay.rings or lay.polys)]
        if len(cand) == 1:
            roles[cand[0]], why[cand[0]] = "top_copper", "the only layer with outlines"
            rep.note("warning", f"layer '{raw[cand[0]].name}' is not recognised as copper: taken as top copper "
                     f"(--layer-map {raw[cand[0]].name}=top_copper|bottom_copper|outline|ignore to choose)", raw[cand[0]].source)
    layer_info = []
    detected = []  # every layer of the files, also the ones without a role (the import dialog's table)
    for n, lay in enumerate(raw):
        role = roles[n]
        detected.append({"source": lay.source, "layer": lay.name, "kind": lay.kind, "role": role,
                         "because": why[n] if role is not None else "no hint in the layer name",
                         "outlines": len(lay.rings) + len(lay.polys) + len(lay.open), "holes": len(lay.holes),
                         "entities": sum(lay.counts.values())})
        where = f"{lay.source} · layer {lay.name}" if lay.kind == "dxf" else lay.source
        if role is None:
            if has_geo(lay) or lay.holes:
                rep.note("warning", f"layer not used: its role is not clear (--layer-map {lay.name}=top_copper|bottom_copper|outline|ignore)", where)
            continue
        layer_info.append({"source": lay.source, "layer": lay.name, "role": role, "because": why[n]})

    # ---- copper
    names0 = {"h": thickness, "f0": f0}
    copper: dict[str, list[Poly]] = {"top_copper": [], "bottom_copper": []}
    outline_pts: list = []
    drills: list = []
    src_of: dict[str, list[str]] = {"top_copper": [], "bottom_copper": [], "outline": []}
    for n, lay in enumerate(raw):
        role = roles[n]
        where = f"{lay.source} · layer {lay.name}" if lay.kind == "dxf" else lay.source
        if role in (None, "ignore"):
            if role == "ignore":
                rep.note("info", f"layer ignored ({why[n]})", where)
            continue
        for sev, msg in lay.notes:
            rep.note(sev, msg, where)
        for (what, reason), (count, line) in lay.skips.items():
            rep.note("refused", f"{count} x {what}: {reason}", where, line)
        if role == "outline":
            outline_pts += lay.extent
            src_of["outline"].append(where)
            continue
        if role == "drill":
            drills += [(lay, h) for h in lay.holes]
            continue
        src_of[role].append(where)
        if lay.kind == "drill":
            continue
        # clean, validate, nest
        rings = []
        seen = set()
        dup = 0
        for pts, label, line in lay.rings:
            r = _clean_ring(pts, 1e-7)
            if r is None:
                rep.note("refused", f"{label}: fewer than three distinct points", where, line)
                continue
            key = tuple(sorted((round(x, 5), round(y, 5)) for x, y in r))
            if key in seen:
                dup += 1
                continue
            seen.add(key)
            bad = polygon_problems([list(p) for p in r])
            if bad:
                rep.note("refused", f"{label}: {bad[0][1]}", where, line)
                continue
            rings.append((r, label, line))
        if dup:
            rep.note("info", f"{dup} repeated outline(s) merged", where)
        polys, nested = _nest(rings)
        if not nested:
            rep.note("warning", f"more than {MAX_NEST} outlines: holes are not looked for (every outline is filled)", where)
        for poly in lay.polys:
            r = _clean_ring(poly.outer, 1e-7)
            bad = polygon_problems([list(p) for p in r]) if r else [("polygon-points", "fewer than three distinct points")]
            if bad:
                rep.note("refused", f"{poly.label}: {bad[0][1]}", where, poly.line)
                continue
            holes = [h for h in (_clean_ring(h, 1e-7) for h in poly.holes) if h and not polygon_problems([list(p) for p in h])]
            polys.append(Poly(r, holes, 0, poly.label, poly.line))
        for pts, label, line in lay.open:
            rep.note("refused", f"1 x open {label} ({len(pts)} points): its ends do not meet another entity, so it is not a closed outline; "
                     "close it or fix the gap", where, line)
        copper[role] += polys

    if not copper["top_copper"] and not copper["bottom_copper"]:
        err = PcbImportError("no copper outlines found: nothing is on a copper layer (check --layer-map; "
                             + (f"layers found: {', '.join(sorted({l.name for l in raw}))}" if raw else "no layers") + ")")
        err.detected = detected  # the layers with their roles: the import dialog still lists them, to choose the copper
        raise err

    # ---- board box
    pts = []
    for role in ("top_copper", "bottom_copper"):
        for p in copper[role]:
            pts += p.outer
    if outline_pts:
        x0, y0, x1, y1 = _bbox(outline_pts)
        box_from = "board outline"
    else:
        x0, y0, x1, y1 = _bbox(pts)
        x0, y0, x1, y1 = x0 - margin, y0 - margin, x1 + margin, y1 + margin
        box_from = f"copper bounding box plus {margin:g} mm"
        rep.note("info", f"no board outline layer: the substrate spans the copper's bounding box plus {margin:g} mm "
                 "(map an Edge.Cuts / Profile / Outline layer with --layer-map NAME=outline)", "substrate")
    if x1 - x0 < 1e-6 or y1 - y0 < 1e-6:
        raise PcbImportError("the board outline has no area")
    dx = dy = 0.0
    if origin == "center":
        dx, dy = -(x0 + x1) / 2, -(y0 + y1) / 2
        rep.note("info", f"the board centre ({(x0 + x1) / 2:.4f}, {(y0 + y1) / 2:.4f} mm in the files) is moved to x = y = 0; "
                 "add these to a design coordinate for the file position (--origin keep leaves it)", "coordinates")
    sx0, sy0, sx1, sy1 = round(x0 + dx, 6), round(y0 + dy, 6), round(x1 + dx, 6), round(y1 + dy, 6)

    # ---- eps_r, tan d
    lib = None
    try:
        lib = library_get(re.sub(r"[^a-z0-9]", "", substrate.lower()).replace("rogers", ""))
    except KeyError:
        try:
            lib = library_get(substrate.lower())
        except KeyError:
            lib = None
    if lib is not None and lib["kind"] != "dielectric":
        lib = None
    if lib is None and eps_r is None:
        rep.note("warning", f"substrate '{substrate}' is not in the material library: FR4 values (eps_r 4.3, tan d 0.02) used "
                 "(--eps-r, --tan-d)", "substrate")
    base = design_material(lib["id"], re.sub(r"[^A-Za-z0-9_ .-]", "", substrate)[:40] or "substrate") if lib else \
        {"name": re.sub(r"[^A-Za-z0-9_ .-]", "", substrate)[:40] or "substrate", "kind": "dielectric", "eps_r": 4.3, "tan_d": 0.02,
         "tan_d_freq": 1}
    if eps_r is not None:
        if not eps_r >= 1:
            raise PcbImportError("eps_r must be at least 1")
        base["eps_r"] = eps_r
    if tan_d is not None:
        if tan_d < 0:
            raise PcbImportError("tan d cannot be negative")
        base["tan_d"] = tan_d
    # openEMS applies tan d as a constant conductivity, exact at one frequency only: the design
    # frequency (a datasheet's 1 or 10 GHz value would misstate the loss at the band centre)
    base["tan_d_freq"] = "f0"
    base.pop("library", None)
    sub_name = base["name"]
    if sub_name == "copper":
        sub_name = "substrate"
        base["name"] = sub_name

    # ---- the design
    d = blank_design(model_id, name or model_id)
    d["model"]["description"] = "Imported from PCB artwork (" + ", ".join(PurePath(str(f[0])).name for f in files)[:200] + \
        "). Ports are not imported: add one at the feed."
    d["params"] = [
        {"key": "f0", "default": f0, "label": "Design frequency", "unit": "GHz", "min": min(0.05, f0 / 2), "max": max(20, f0 * 2)},
        {"key": "h", "default": thickness, "label": "Substrate thickness", "unit": "mm", "min": min(0.1, thickness / 2),
         "max": max(10, thickness * 2)},
    ]
    d["materials"] = [{"name": "copper", "kind": "metal"}, base]
    parts = [{"name": "substrate", "material": sub_name, "label": "Substrate",
              "primitives": [{"kind": "box", "start": [sx0, sy0, 0], "stop": [sx1, sy1, "h"]}]}]
    d["ports"] = []
    d["resistors"] = []
    rep.made("material", "copper", "metal (perfect conductor); thin sheets")
    rep.made("material", sub_name, f"dielectric, eps_r {base['eps_r']}, tan d {base['tan_d']} at f0")
    rep.made("part", "substrate", f"box {sx1 - sx0:.4g} x {sy1 - sy0:.4g} x {thickness:g} mm ({box_from})")
    if len(outline_pts):
        rep.note("info", "the substrate is the box spanning the board outline's bounding box", "substrate")
    hole_count = 0
    n_poly = 0
    for role, pname, label, elev in (("top_copper", "top_copper", "Top copper", "h"), ("bottom_copper", "bottom_copper", "Bottom copper", 0)):
        polys = []
        for p in copper[role]:
            o = _round_ring(p.outer, dx, dy)
            if o is None:
                continue
            hs = [h for h in (_round_ring(h, dx, dy) for h in p.holes) if h]
            polys.append(Poly(o, hs, p.depth, p.label, p.line))
        if not polys:
            continue
        levels: dict[int, list[Poly]] = {}
        for p in polys:
            levels.setdefault(p.depth // 2, []).append(p)
        for lv in sorted(levels):
            group = levels[lv]
            pn = pname if lv == 0 else f"{pname}_islands" + ("" if lv == 1 else str(lv))
            outers = [_poly_prim(p.outer, elev) for p in group]
            holes = [_poly_prim(h, elev) for p in group for h in p.holes]
            part = {"name": pn, "material": "copper", "label": label if lv == 0 else f"{label} (inside holes)", "primitives": outers}
            done = f"{len(outers)} polygon(s)"
            if holes:
                hist = {"operation": "subtract", "live": True,
                        "A": {"name": f"{pn} outlines", "material": "copper", "primitives": outers},
                        "B": {"name": f"{pn} holes", "material": "copper", "primitives": holes}}
                try:
                    names = resolve_names(d, {})
                    res = boolean_primitives(hist, names, f"parts[{len(parts)}].booleanHistory")
                    for prim in res:
                        prim["elevation"] = elev
                    part["primitives"], part["booleanHistory"] = res, hist
                    done += f", {len(holes)} hole(s) cut by a live Boolean subtraction"
                    hole_count += len(holes)
                except (DesignError, ValueError, ArithmeticError, RecursionError) as e:
                    rep.note("refused", f"{len(holes)} hole(s) in {label.lower()} not imported (the Boolean subtraction failed: "
                             f"{getattr(e, 'detail', e)}); the outline is filled", pn)
            parts.append(part)
            n_poly += len(part["primitives"])
            rep.made("part", pn, f"{done}, z = {'thickness' if elev == 'h' else '0'}" +
                     (f" (from {'; '.join(src_of[role])})" if src_of[role] else ""))
    if not copper["bottom_copper"]:
        rep.note("warning", "no bottom copper: the design has no ground plane (a patch or monopole usually needs one; "
                 "map the ground layer with --layer-map or draw a ground plane in the designer)", "parts")
    if not copper["top_copper"]:
        rep.note("warning", "no top copper: only the bottom copper was imported", "parts")
    # ---- vias
    vias, npth = [], 0
    for lay, h in drills:
        if h["plated"]:
            vias.append(h)
        else:
            npth += 1
    if npth:
        rep.note("refused", f"{npth} unplated hole(s): the substrate is not cut (openEMS would need an air cylinder "
                 "with a higher priority: add one in the designer)", "drill")
    if len(vias) > MAX_VIAS:
        rep.note("refused", f"{len(vias) - MAX_VIAS} via(s) beyond the first {MAX_VIAS} are not imported", "drill")
        vias = vias[:MAX_VIAS]
    if vias:
        prims = [{"kind": "cylinder", "axis": "z", "center": [round(h["x"] + dx, 6), round(h["y"] + dy, 6)],
                  "radius": round(h["d"] / 2, 6), "range": [0, "h"]} for h in vias]
        parts.append({"name": "vias", "material": "copper", "label": "Vias", "primitives": prims})
        rep.made("part", "vias", f"{len(prims)} plated hole(s) as solid metal pins between the copper planes")
    d["parts"] = parts
    rep.note("warning", "no port imported (the importer cannot know the feed): add a port at the feed (Setup > Port), e.g. a "
             "lumped port from the ground plane to the feed edge of the patch, or between the two halves of a dipole", "ports")
    try:
        check_design(d)
    except DesignError as e:
        raise PcbImportError(f"the imported design is not valid ({e}); please report the files") from None
    # the design's own checks, except the port
    try:
        for c in lint(d):
            if c["code"] != "no-port":
                rep.note("warning" if c["severity"] != "info" else "info", f"check {c['code']}: {c['message']}", c.get("path", "checks"))
    except Exception as e:  # pragma: no cover - lint failing must not lose the import
        rep.note("warning", f"the design checks could not run ({type(e).__name__})", "checks")

    order = {"refused": 0, "warning": 1, "info": 2}
    notes = sorted(rep.notes, key=lambda n: (order.get(n["severity"], 3), n["line"] or 0))
    counts = {"material": sum(1 for c in rep.created if c["kind"] == "material"),
              "part": sum(1 for c in rep.created if c["kind"] == "part"), "polygon": n_poly, "hole": hole_count,
              "via": len(vias), "port": 0}
    report = {"created": rep.created, "notes": notes, "counts": counts,
              "refused": sum(1 for n in notes if n["severity"] == "refused"),
              "warnings": sum(1 for n in notes if n["severity"] == "warning"),
              "layers": layer_info, "detected": detected, "offset": [round(dx, 6), round(dy, 6)], "chord_tol": chord_tol,
              "suggested_name": name or model_id, "supported": SUPPORTED}
    return {"design": d, "report": report}
