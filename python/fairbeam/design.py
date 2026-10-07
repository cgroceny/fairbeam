"""Design files: a model described as data instead of Python (``<id>.design.json``).

The visual designer in the viewer edits these files; everything else (``fairbeam run``, the preview
worker, sweeps, the optimizer, jobs) treats them like any model, because :func:`module_for`
returns an object with the same ``MODEL`` / ``PARAMS`` / ``build`` interface as a model module
(``fairbeam.model.load_model`` calls it for ``*.design.json``).

The geometry maps one to one onto CSXCAD primitives, the same ones Python models use::

    {
      "schema": "fairbeam.design/1",
      "model": {"id": "my-patch", "name": "My patch", "description": "..."},
      "params": [                                   # independent: tunable, swept, optimized
        {"key": "L", "default": 32, "label": "Patch length", "unit": "mm", "min": 10, "max": 60},
        {"key": "lam", "expr": "wavelength(f0)", "label": "Wavelength at f0", "unit": "mm"}  # derived
      ],
      "simulation": {"f_min": "1", "f_max": "3", "boundaries": ["MUR", ...6], "end_criteria_db": -60},
      "materials": [{"name": "copper", "kind": "metal"},
                    {"name": "ro4003c", "kind": "dielectric", "eps_r": "3.38", "tan_d": "0.0027", "tan_d_freq": "2"}],
      "parts": [{"name": "patch", "material": "copper", "primitives": [
                  {"kind": "box", "start": ["-W/2", "-L/2", "h"], "stop": ["W/2", "L/2", "h"]}]}],
      "ports": [{"type": "lumped", "number": 1, "R": "50", "start": [...], "stop": [...], "direction": "z"},
                {"type": "waveguide", "number": 2, "mode": "TE10", "a": "22.86", "b": "10.16",
                 "start": [...], "stop": [...], "direction": "z"}],
      "resistors": [{"name": "r1", "R": "100", "start": [...], "stop": [...], "direction": "y"}],
      "mesh": {"mode": "auto", "cells_per_wavelength": 20, "refine_features": false},
      "far_field": {"enabled": true, "frequencies": ["f0"]},   # optional "faces": 6 flags x- x+ y- y+ z- z+
      "monitors": {"currents": ["f0"],              # optional: surface-current maps (GHz)
                   "efficiency": {"points": 21},     # optional: radiation efficiency over the band
                   "field_planes": [{"quantity": "E", "normal": "z", "position": "h + 1",
                                     "frequencies": ["f0"]}]}  # optional: E/H maps on cut planes
    }

``monitors.currents`` records surface-current maps on the metal sheets at these frequencies, as
``fairbeam run --fields`` does; the build sets ``Simulation.current_freqs`` and ``fairbeam run``
honours it when no ``--fields`` flag is given. ``monitors.efficiency`` ({"points": N}, 3 to 201,
default 21) adds the radiation efficiency at N frequencies across the band (bundle
``results.efficiency``), post-processed from the far-field box after the run. It needs the far
field; the build sets ``Simulation.efficiency_points``, as ``fairbeam run --efficiency N`` does.
``monitors.field_planes`` (up to 4 planes of up to 4 frequencies each) records the magnitude of E or
H (``quantity``; ``component`` "abs" (default), "x", "y" or "z") on a plane normal to ``normal`` at
``position`` (mm) across the whole domain (fairbeam.field_planes, bundle ``field_planes``); the
build sets ``Simulation.field_plane_monitors``, as ``fairbeam run --field-plane`` does.

``model.conversion`` (optional, informational) records how a design was made from a bundled
example (fairbeam.example_design): ``{"source": "patch-antenna.json", "notes": [{"code":
"meshLines", "text": "...", "values": {...}}]}``. The designer shows the notes in Properties, in the
interface language (``code`` and ``values``); ``text`` is the English sentence. The build ignores it.

Units: lengths in mm, frequencies in GHz. Every number may instead be an expression over the
parameters (``"W/2 + 0.5"``, ``"wavelength(f0) / 4"``), evaluated by a small safe evaluator (no
attribute access, no calls other than the whitelisted maths functions; plain decimal numbers).

Primitive kinds (simple modelling shapes, each one maps to one CSXCAD primitive):

``box`` (a brick)
    ``start`` / ``stop``: the x, y, z minimum and maximum (the designer shows Xmin/Xmax, ...).
    Zero thickness along exactly one axis makes a sheet.
``cylinder``
    Axis form: ``axis`` (x/y/z), ``center`` (the two in-plane coordinates, in CSXCAD's order: axis
    z -> [x, y], x -> [y, z], y -> [z, x]), ``radius`` (outer), ``inner_radius`` (0 or absent:
    solid) and ``range`` ([min, max] along the axis). A solid one is CSXCAD ``AddCylinder``, one
    with an inner radius (a tube) ``AddCylindricalShell``. The older form ``start`` / ``stop`` /
    ``radius`` (axis end points) is still read. A ``range`` with min = max is a **flat circle** (a
    ring with an inner radius): a sheet, built as a regular polygon (:func:`disc_ring`: vertices on
    the circle, an even number of sides keeping the edge within ``DISC_SAG_MM`` of the arc, at least
    ``DISC_MIN_SEGMENTS``); a ring is two half rings (:func:`disc_halves`), since CSXCAD polygons
    have no holes. A zero-length CSXCAD cylinder would carve nothing, so none is ever built.
``sphere``
    ``center`` (x, y, z) and ``radius``: CSXCAD ``AddSphere``.
``polygon``
    flat, on a plane ``normal`` = x/y/z at ``elevation``; ``points`` are in-plane coordinates in
    the same order as a cylinder's centre.
``linpoly``
    a polygon extruded by ``length`` along its normal.
``cone``
    Axis form like a cylinder: ``axis``, ``center`` (two in-plane coordinates), ``bottom_radius`` at
    ``range[0]``, ``top_radius`` at ``range[1]`` (0: a sharp cone). CSXCAD ``AddRotPoly``: the
    trapezoid (radial, axial) turned about the axis, moved to the centre by a translation.
``torus``
    ``axis``, ``center`` (x, y, z), ``major_radius`` (axis to the tube centre) and ``minor_radius``
    (the tube): CSXCAD ``AddRotPoly`` of a regular 64-gon (``TORUS_SEGMENTS``) turned about the axis.
``wire``
    a thin wire: ``points`` (a polyline of x, y, z points, at least 2) and ``radius``. With a radius it is built
    as a solid: a flat-ended cylinder along every segment and a sphere at every bend (:func:`add_wire`; CSXCAD's
    ``AddWire`` snaps the line to the mesh edges and resonates a dipole 15 % low), so the mesh needs cells about as small as
    the radius; the automatic mesh refines the free ends and the surface lines. A radius under 0.02 mm, or a wire with a
    slanted segment, stays CSXCAD's wire (a bare line of mesh edges).

``polyhedron``
    a closed solid from ``vertices`` (x, y, z points, at least 4, expressions allowed) and ``faces``
    (lists of vertex indices, at least 3 each and at least 4 faces): CSXCAD ``AddPolyhedron``.
    CSXCAD rasterises triangles only, so the build fans every polygon face into triangles
    (:func:`polyhedron_triangles`) and orients them by the enclosed volume, so a mirrored copy
    still builds. Transforms move the vertices.

A part may carry ``transforms`` ("transform with copies"), applied in order to all of its
shapes and expanded exactly when the design is built (every copy is a real primitive)::

    "transforms": [{"type": "translate", "copies": "N - 1", "step": ["pitch", 0, 0]},
                   {"type": "mirror", "plane": "x", "keep": true}]

``move`` shifts every existing primitive by ``offset`` (three expressions, in world coordinates),
without adding copies: ``{"type": "move", "offset": ["dx", 0, "h"]}``.
``translate`` adds ``copies`` copies, the k-th shifted by k x ``step`` (the original stays);
``mirror`` reflects across the axis-aligned plane ``plane`` through ``point`` (a three-expression
vector defaulting to [0, 0, 0]), keeping the original unless ``keep`` is false. ``scale`` takes
positive uniform ``factors`` and an ``origin``; zero copies applies the scale once, while a positive
copy count keeps the original and adds cumulative scaled copies. Nonuniform scaling is rejected
because it cannot represent every supported primitive exactly.
``rotate`` takes ``axis`` (x/y/z), ``center`` (three expressions), ``angle`` (degrees, any value an
expression evaluates to) and optional ``copies`` (default 0). Zero copies rotates the original; a
positive count retains it and adds copies at k x angle, k = 1..copies. Quarter turns remap axes
exactly for every shape. Any other angle keeps the shape's own exact local form and attaches the
rotation as a CSXCAD affine matrix (nothing is replaced by a bounding box or tessellated); the
meshing and the bounds follow the rotated shape. Two things stay refused: a zero-thickness metal
sheet tilted off the Yee grid (:func:`sheet_transform_issues`: rotate it about its own normal, or
give it thickness) and a live Boolean operand rotated off the axes.

Ports are ``lumped`` (openEMS LumpedPort: ``R``, a probe or strip between ``start`` and ``stop``
along ``direction``) or ``waveguide`` (openEMS RectWGPort through ``Simulation.waveguide_port``:
one TE_mn ``mode``, "TE10" by default, of a rectangular guide with the broad wall ``a`` along
axis (direction + 1) % 3 and ``b`` along (direction + 2) % 3; ``start`` / ``stop`` span the guide
cross-section, the excitation in the ``start`` plane and the mode probes in the ``stop`` plane).

A part may carry ``cuts`` (a boolean subtraction for flat sheets: slots, U-slots, E-shapes, inset
notches, clearance holes). A cut is a rectangle given like a sheet brick (``start`` / ``stop``,
min = max on exactly one axis), a round hole (``"kind": "circle"``: ``normal``, ``elevation``,
``center`` in the plane's in-plane coordinates, ``radius``; the regular polygon of :func:`disc_ring`)
or a polygon (``"kind": "polygon"``: ``normal``, ``elevation``, ``points``). It is subtracted from
the part's flat sheets in the same plane (rectangular sheets, polygons, flat circles), before its
transforms. CSXCAD polygons cannot have holes, so the build replaces each cut sheet by the exact
difference: disjoint rectangles when only rectangles cut a rectangular sheet
(:func:`_sheet_minus`), else polygons clipped in 2D (:mod:`fairbeam.polyclip`; a hole leaves its
surround as several polygons). Cuts remove area, not volume: a solid the cut plane crosses is left
whole (a check says so)::

    "cuts": [{"start": ["-ws/2", "-ls/2", "h"], "stop": ["ws/2", "ls/2", "h"]},
             {"kind": "circle", "normal": "z", "elevation": "h", "center": [0, 0], "radius": 2}]

Thin metal: a metal brick much thinner than the mesh can resolve (PCB copper, 17 to 70 µm) is
built as a zero-thickness PEC sheet (:func:`thin_sheets`), so the mesh gets no cells of the copper
thickness and the timestep stays reasonable. The limit is a tenth of the finest cell the automatic
mesh aims for (λ at f max / cells per wavelength / √εr of the densest dielectric). The sheet sits
on the face that coincides with or touches a dielectric (the substrate side), else in the middle;
port and resistor ends inside the drawn thickness move onto it. The bundle keeps the drawn
thickness for display and the exports. ``"mesh": {"thin_metal": "volume"}`` keeps the volumes of plates at least 0.6 of the finest cell thick
(:data:`VOLUME_COST_FACTOR`); thinner ones are still sheets there, because cells across them would make the timestep
more than 5x smaller and the run never end.

Lossy metal: a metal material with ``"conductivity"`` (S/m, e.g. 5.8e7 for copper; empty or absent =
PEC, as before) builds its sheets as openEMS conducting sheets of ``"thickness"`` (mm, default
0.035; a thin brick built as a sheet keeps its drawn thickness) and its volumes as a material of that
conductivity (:func:`metal_loss`, ``simulation.LossyMetal``).

A part made by a Boolean operation in the designer (add, subtract, intersect, insert, #80) carries
``booleanHistory``: the operation and its operands A and B (whole parts, with their cuts,
transforms and nested histories). Operands are bricks, rectangular sheets, polygons (flat, or
``linpoly`` extruded along their normal) and curved shapes (cylinders, tubes, cones, spheres, tori, wires,
polyhedra). Its ``primitives`` are the result at the design's own values: Add and Intersect of boxes are boxes (the
exact box partition); Subtract (and Insert) of bricks and polygons is as compact as it stays exact, the fewest shapes
of ``linpoly`` / ``polygon`` primitives (a rectangle that comes out of bricks is a brick; a sheet minus a volume uses
the volume's cross-section at its plane) or the part kept whole with B as a cut-out (a pocket); an operand's round or
polygon cut, or its cut-outs of bricks and polygons, are folded in first. Otherwise ``linpoly`` / ``polygon`` primitives (every polygon must share one
normal: the operands are cut into slabs along it and each slab is clipped exactly in 2D by
:mod:`fairbeam.polyclip`; a hole leaves its surround as several simple polygons, since CSXCAD polygons
have none). With curved shapes (:mod:`fairbeam.boolean_curved`): Add keeps all shapes (bricks and polygons
united), Insert keeps A whole (the designer lifts B above it), Subtract keeps A and adds B's shapes as
cut-outs (``"void": true``, vacuum above the part, see below; a cylinder minus a coaxial cylinder or tube is
exactly a tube), Intersect is exact for coaxial cylinders and tubes, trims by a brick, cylinders along a
common polygon axis (clipped as 64-gon prisms, the native cylinder when the clip leaves its ring) and
shapes inside a brick, and refuses the rest with the combination and what to do instead. When ``live`` is
set, the build recomputes the result from the operands at the values it builds with
(:func:`boolean_primitives`, the same arithmetic as the designer's src/designer/booleanParts.ts and
polygonClip.ts), so sweeps and optimisation follow the operands' parameters. The Python export
writes the result at the default values.

A primitive with ``"void": true`` is a cut-out: the build makes it vacuum (eps_r 1; a property named
"<part> (cut)") with the priority of its part's solid shapes + 0.5 (or its own ``priority``), so it erases
what has the same or a lower priority inside it. Priorities may be fractional; the build ranks them to
integers only when one is (:func:`build`).

A part may carry a ``component`` path (component folders), e.g. ``"antenna/feed"``: the
designer's tree groups parts in folders by it. The build and the exports ignore it (the Python
export keeps it as a comment).

Errors are :class:`DesignError` and carry the JSON path of the offending field (``where``), so
the designer can point at it. The checks against absurd but buildable states (a port in the air,
a brick with min > max, ...) are in :mod:`fairbeam.design_checks`.
"""

from __future__ import annotations

import ast
import json
import keyword
import math
import re
import sys
import types
from pathlib import Path

from .legacy import is_reserved_name, schema_is
from .materials import design_material
from .boolean_curved import (FACETS, INTERSECT_MESSAGE, INTERSECT_WHY, B_HAS_CUT, FLAT_CARVER, HAS_CUT, SHEET_VOLUME, coaxial_rects, cylinder_cell,
                             design_bounds, facet_ring, flat_axis, is_p, is_tube, is_void, kind_name, same_ring, snap_to_sheet, unresolve)
from .polyclip import clip_polygons, clip_tolerance

DESIGN_SCHEMA = "fairbeam.design/1"
DESIGN_SUFFIX = ".design.json"
C0 = 299_792_458.0

KINDS = ("box", "cylinder", "sphere", "polygon", "linpoly", "cone", "torus", "wire", "polyhedron")
# a torus is the rotation of a regular polygon of this many sides (CSXCAD has no torus primitive)
TORUS_SEGMENTS = 64
# A flat circle (a cylinder of zero length, a hole cut in a sheet) is a regular polygon: its vertices
# sit on the circle, and the number of sides keeps the sagitta (the gap between a side and the arc)
# under DISC_SAG_MM, at least DISC_MIN_SEGMENTS (cst_import.CIRCLE_SEGMENTS) and at most
# DISC_MAX_SEGMENTS. Always even, so that a ring splits into two half rings along a diameter.
DISC_SAG_MM = 0.01
DISC_MIN_SEGMENTS = 64
DISC_MAX_SEGMENTS = 512
TRANSFORMS = ("move", "translate", "mirror", "rotate", "scale")
AXES = ("x", "y", "z")
CUT_SHAPES = ("rect", "circle", "polygon")
PORT_TYPES = ("lumped", "waveguide")
WG_MODE = re.compile(r"TE(\d)(\d)")
# upper bounds on what transforms may expand to (a typo like 1000 copies must not hang the preview)
MAX_COPIES = 1000
MAX_PRIMITIVES = 5000
BOUNDARY_CHOICES = ("PEC", "PMC", "MUR", "PML_8")
# efficiency over the band (monitors.efficiency.points, fairbeam run --efficiency N): number of
# frequencies, default and allowed range (src/designer/checks.ts EFFICIENCY_POINTS_*)
EFFICIENCY_POINTS_DEFAULT = 21
EFFICIENCY_POINTS_MIN, EFFICIENCY_POINTS_MAX = 3, 201
# E/H field maps on cut planes (monitors.field_planes; src/designer/checks.ts FIELD_PLANES_MAX /
# FIELD_PLANE_FREQS_MAX): at most this many planes, each at up to this many frequencies
FIELD_PLANES_MAX = 4
FIELD_PLANE_FREQS_MAX = 4
FIELD_QUANTITIES = ("E", "H")
FIELD_COMPONENTS = ("abs", "x", "y", "z")


class DesignError(ValueError):
    """A problem in a design file; ``where`` is the JSON path of the field, e.g. ``parts[1].primitives[0].stop[2]``."""

    def __init__(self, message: str, where: str = ""):
        super().__init__(f"{where}: {message}" if where else message)
        self.where = where
        self.detail = message


def is_design(path) -> bool:
    return str(path).endswith(DESIGN_SUFFIX)


def design_key(path) -> str:
    """``foo.design.json`` -> ``foo`` (the model key, like the stem of ``foo.py``)."""
    name = Path(path).name
    return name[: -len(DESIGN_SUFFIX)] if name.endswith(DESIGN_SUFFIX) else Path(path).stem


# ---------------------------------------------------------------------------- expressions

def wavelength(f_ghz):
    """Free-space wavelength in mm at ``f_ghz`` GHz."""
    return C0 / (float(f_ghz) * 1e9) * 1e3


def _round(x, n=None):
    """round(x[, n]) where n is a whole number, also written as a float (round(x, 2.0)), as in
    src/designer/expr.ts: every value in an expression is a float."""
    if n is None:
        return round(x)
    if not float(n).is_integer():
        raise ValueError("round() digits must be a whole number")
    return round(x, int(n))


FUNCS = {
    "sqrt": math.sqrt, "sin": math.sin, "cos": math.cos, "tan": math.tan, "asin": math.asin,
    "acos": math.acos, "atan": math.atan, "atan2": math.atan2, "exp": math.exp, "log": math.log,
    "log10": math.log10, "abs": abs, "min": min, "max": max, "round": _round, "floor": math.floor,
    "ceil": math.ceil, "radians": math.radians, "degrees": math.degrees, "wavelength": wavelength,
}
CONSTANTS = {"pi": math.pi, "c0": C0, "eps0": 8.8541878128e-12, "mu0": 1.25663706212e-6}
RESERVED = set(FUNCS) | set(CONSTANTS)
# A parameter key: an ASCII identifier that is not a function, a constant or a Python keyword
# (src/designer/expr.ts paramKeyError refuses the same keys in the designer).
_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def param_key_error(key) -> str | None:
    """Why ``key`` cannot be a parameter key, or None."""
    if not isinstance(key, str) or not _KEY.fullmatch(key):
        return "use letters, digits and _, starting with a letter or _"
    if key in RESERVED:
        return "that is a function or constant name"
    if keyword.iskeyword(key):
        return "that is a Python keyword"
    return None

_BINOPS = {ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b, ast.Mult: lambda a, b: a * b,
           ast.Div: lambda a, b: a / b, ast.Pow: lambda a, b: a ** b, ast.Mod: lambda a, b: a % b,
           ast.FloorDiv: lambda a, b: a // b}
_UNOPS = {ast.USub: lambda a: -a, ast.UAdd: lambda a: a}


# a numeric literal (not a digit inside a name like W1_a) written with _ or as 0x.., 0o.., 0b..
_NUMBER = re.compile(r"(?<![A-Za-z_\d.])\d[\w.]*")
# a character the designer's tokenizer does not read (src/designer/expr.ts): a comment (#), a line
# continuation (\), a non-ASCII letter or space (Python would read "ｗ" as w), quotes, brackets ...
_FOREIGN = re.compile(r"[^A-Za-z0-9_.+\-*/%(), \t\n\r\f\v]")


def parse_expr(text) -> ast.Expression:
    """Parse and check an expression (numbers, + - * / // % **, parentheses, names, whitelisted calls)."""
    if isinstance(text, bool) or not isinstance(text, (str, int, float)):
        raise DesignError(f"expected a number or an expression, got {type(text).__name__}")
    if isinstance(text, str):
        if any("_" in m or m[:2].lower() in ("0x", "0o", "0b") for m in _NUMBER.findall(text)):
            raise DesignError(f"{text!r}: write plain decimal numbers (no 0x.., 0b.., 1_000)")
        bad = _FOREIGN.search(text)
        if bad:
            raise DesignError(f"{text!r}: unexpected {bad.group()!r}")
    try:
        # whitespace (line breaks included) only separates tokens, as in the designer
        tree = ast.parse(" ".join(str(text).split()), mode="eval")
    except SyntaxError as e:
        raise DesignError(f"cannot parse {text!r}: {e.msg}") from None
    for node in ast.walk(tree):
        if isinstance(node, (ast.Expression, ast.Load)) or type(node) in _BINOPS or type(node) in _UNOPS:
            continue
        if isinstance(node, (ast.BinOp, ast.UnaryOp, ast.Name)):
            continue
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            continue
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in FUNCS and not node.keywords:
            continue
        raise DesignError(f"{text!r}: {type(node).__name__} is not allowed in an expression")
    return tree


def names_in(text) -> set[str]:
    """Parameter names an expression refers to (functions and constants excluded)."""
    tree = parse_expr(text)
    called = {n.func.id for n in ast.walk(tree) if isinstance(n, ast.Call)}
    return {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} - called - set(CONSTANTS)


class _NotFinite(Exception):
    pass


def _double(v) -> float:
    """``v`` under the shared number rule (src/designer/expr.ts): a finite IEEE-754 double. An int
    becomes the nearest float (9007199254740993 -> 9007199254740992.0, as JSON and JavaScript
    read it); a value that does not fit, NaN, an infinity or a complex result is refused."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise _NotFinite
    try:
        f = float(v)
    except OverflowError:
        raise _NotFinite from None
    if not math.isfinite(f):
        raise _NotFinite
    return f


def evaluate(text, names: dict) -> float:
    """Value of a number or expression; ``names`` maps parameter keys to numbers. A plain number
    goes through the same finite check as an expression (json reads NaN and Infinity).

    Numbers follow one rule in the browser and here: every literal, name, operation and function
    result is a finite float (a double); Python's exact integer arithmetic is not used, so
    ``9007199254740993 - 9007199254740992`` is 0.0, as in src/designer/expr.ts, and a step that
    overflows is an error even when a later step would bring it back (``1 / (1e308 * 10)``)."""

    def ev(node):
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant):
            return _double(node.value)
        if isinstance(node, ast.Name):
            if node.id in names:
                return _double(names[node.id])
            if node.id in CONSTANTS:
                return _double(CONSTANTS[node.id])
            raise DesignError(f"unknown name {node.id!r} in {text!r}")
        if isinstance(node, ast.BinOp):
            return _double(_BINOPS[type(node.op)](ev(node.left), ev(node.right)))
        if isinstance(node, ast.UnaryOp):
            return _double(_UNOPS[type(node.op)](ev(node.operand)))
        if isinstance(node, ast.Call):
            return _double(FUNCS[node.func.id](*[ev(a) for a in node.args]))
        raise DesignError(f"{text!r}: unsupported {type(node).__name__}")

    try:
        if isinstance(text, (int, float)) and not isinstance(text, bool):
            return _double(text)
        tree = parse_expr(text)
        try:
            return ev(tree)
        except (DesignError, _NotFinite):
            raise
        except (ArithmeticError, ValueError, TypeError) as e:
            raise DesignError(f"{text!r}: {e}") from None
    except _NotFinite:
        raise DesignError(f"{text!r} is not a finite number") from None


# ---------------------------------------------------------------------------- reading and checking

def read_design(path) -> dict:
    try:
        design = json.loads(Path(path).read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise DesignError(f"not valid JSON: {e.msg} (line {e.lineno}, column {e.colno})") from None
    check_design(design)
    design["schema"] = DESIGN_SCHEMA   # a file fairbeam wrote is read as a Fairbeam design; saving writes the new id
    return design


def _need(obj, key, where, kind=None):
    if not isinstance(obj, dict) or key not in obj:
        raise DesignError(f"missing {key!r}", where)
    v = obj[key]
    if kind is not None and not isinstance(v, kind):
        raise DesignError(f"{key!r} must be {getattr(kind, '__name__', kind)}", f"{where}.{key}" if where else key)
    return v


_HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")


def _check_color(obj: dict, where: str) -> None:
    """An optional display colour, "#rrggbb" (drawing only: the solver ignores it)."""
    c = obj.get("color")
    if c is not None and not (isinstance(c, str) and _HEX_COLOR.fullmatch(c)):
        raise DesignError("color is a hex colour such as '#c8a040'", f"{where}.color")


def check_design(d: dict) -> None:
    """Structure and names only (values are checked when the design is built)."""
    if not isinstance(d, dict):
        raise DesignError("a design is a JSON object")
    if not schema_is(d.get("schema"), DESIGN_SCHEMA):
        raise DesignError(f"schema must be {DESIGN_SCHEMA!r}", "schema")
    from .organization import organization_issues
    for path, detail in organization_issues(d):
        raise DesignError(detail, path)
    m = _need(d, "model", "", dict)
    for k in ("id", "name"):
        if not isinstance(m.get(k), str) or not m[k].strip():
            raise DesignError(f"{k!r} must be a non-empty string", f"model.{k}")
    if "conversion" in m:
        conversion = m["conversion"]
        notes = conversion.get("notes") if isinstance(conversion, dict) else None
        if not isinstance(notes, list) or not all(
                isinstance(n, dict) and isinstance(n.get("code"), str) and isinstance(n.get("text"), str)
                and isinstance(n.get("values", {}), dict) for n in notes):
            raise DesignError("conversion is {source, notes: [{code, text, values}]}", "model.conversion")
    if "python_source_model" in d:
        source_model = d["python_source_model"]
        source_hash = d.get("python_source_hash")
        if not isinstance(source_model, str) or not re.fullmatch(r"[a-z][a-z0-9_]{1,40}", source_model):
            raise DesignError("must be a Python model id", "python_source_model")
        if not isinstance(source_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", source_hash):
            raise DesignError("must be the source model's SHA-256 hash", "python_source_hash")
    elif "python_source_hash" in d:
        raise DesignError("needs python_source_model", "python_source_hash")
    keys: set[str] = set()
    for i, p in enumerate(d.get("params", [])):
        w = f"params[{i}]"
        key = _need(p, "key", w, str)
        bad = param_key_error(key)
        if bad:
            raise DesignError(f"{key!r} is not a valid parameter name: {bad}", f"{w}.key")
        if key in keys:
            raise DesignError(f"duplicate parameter {key!r}", f"{w}.key")
        keys.add(key)
        if "expr" in p:
            names_in(p["expr"])
        elif not isinstance(p.get("default"), (int, float)) or isinstance(p.get("default"), bool):
            raise DesignError("a parameter needs a numeric 'default' (or an 'expr' for a derived one)", f"{w}.default")
        else:
            try:
                evaluate(p["default"], {})   # a finite number (json reads NaN and Infinity)
            except DesignError as e:
                raise DesignError(e.detail, f"{w}.default") from None
    mats: set[str] = set()
    for i, mt in enumerate(d.get("materials", [])):
        w = f"materials[{i}]"
        name = _need(mt, "name", w, str)
        if name in mats:
            raise DesignError(f"duplicate material {name!r}", f"{w}.name")
        mats.add(name)
        if mt.get("kind") not in ("metal", "dielectric"):
            raise DesignError("kind must be 'metal' or 'dielectric'", f"{w}.kind")
        _check_color(mt, w)
    parts: set[str] = set()
    for i, pt in enumerate(d.get("parts", [])):
        w = f"parts[{i}]"
        name = _need(pt, "name", w, str)
        if not name or is_reserved_name(name) or name in parts:
            raise DesignError(f"part name {name!r} is empty, reserved or used twice", f"{w}.name")
        parts.add(name)
        if pt.get("material") not in mats:
            raise DesignError(f"unknown material {pt.get('material')!r}", f"{w}.material")
        _check_color(pt, w)
        if "component" in pt and not isinstance(pt["component"], str):
            raise DesignError("component is a folder path such as 'antenna/feed'", f"{w}.component")
        for j, pr in enumerate(_need(pt, "primitives", w, list)):
            wp = f"{w}.primitives[{j}]"
            if not isinstance(pr, dict) or pr.get("kind") not in KINDS:
                raise DesignError(f"kind must be one of {', '.join(KINDS)}", f"{wp}.kind")
            if (pr["kind"] in ("cone", "torus") or (pr["kind"] == "cylinder" and "axis" in pr)) and pr.get("axis") not in AXES:
                raise DesignError("axis must be x, y or z", f"{wp}.axis")
            if pr["kind"] in ("polygon", "linpoly") and pr.get("normal", "z") not in AXES:
                raise DesignError("normal must be x, y or z", f"{wp}.normal")
        cuts = pt.get("cuts", [])
        if not isinstance(cuts, list):
            raise DesignError("cuts is a list of rectangles, circles and polygons", f"{w}.cuts")
        for k, c in enumerate(cuts):
            if not isinstance(c, dict):
                raise DesignError("a cut is a rectangle (start, stop), a circle or a polygon", f"{w}.cuts[{k}]")
            shape = c.get("kind", "rect")
            if shape not in CUT_SHAPES:
                raise DesignError(f"a cut's kind is one of {', '.join(CUT_SHAPES)}", f"{w}.cuts[{k}].kind")
            if shape == "rect":
                _need(c, "start", f"{w}.cuts[{k}]", list)
                _need(c, "stop", f"{w}.cuts[{k}]", list)
            else:
                if c.get("normal", "z") not in AXES:
                    raise DesignError("normal must be x, y or z", f"{w}.cuts[{k}].normal")
                _need(c, "center" if shape == "circle" else "points", f"{w}.cuts[{k}]", list)
        tr = pt.get("transforms", [])
        if not isinstance(tr, list):
            raise DesignError("transforms is a list", f"{w}.transforms")
        for k, t in enumerate(tr):
            wt = f"{w}.transforms[{k}]"
            if not isinstance(t, dict) or t.get("type") not in TRANSFORMS:
                raise DesignError(f"type must be one of {', '.join(TRANSFORMS)}", f"{wt}.type")
            if t["type"] == "mirror":
                if t.get("plane") not in AXES:
                    raise DesignError("plane must be x, y or z (the plane x = 0, y = 0 or z = 0)", f"{wt}.plane")
                if not isinstance(t.get("keep", True), bool):
                    raise DesignError("keep must be true or false", f"{wt}.keep")
                if "point" in t:
                    _need(t, "point", wt, list)
            elif t["type"] == "move":
                _need(t, "offset", wt, list)
            elif t["type"] == "scale":
                _need(t, "factors", wt, list)
                _need(t, "origin", wt, list)
            elif t["type"] == "rotate":
                if t.get("axis") not in AXES:
                    raise DesignError("axis must be x, y or z", f"{wt}.axis")
                _need(t, "center", wt, list)
                _need(t, "angle", wt)
            elif t["type"] == "translate":
                _need(t, "copies", wt)
                _need(t, "step", wt, list)
    numbers: set[int] = set()
    for i, po in enumerate(d.get("ports", [])):
        w = f"ports[{i}]"
        check_port_group(po, w)
        if po.get("type", "lumped") not in PORT_TYPES:
            raise DesignError("a port is 'lumped' or 'waveguide'", f"{w}.type")
        if "reference_impedance" in po:
            ref = po["reference_impedance"]
            if not isinstance(ref, dict) or set(ref) != {"real", "imag"}:
                raise DesignError("reference_impedance needs real and imag", f"{w}.reference_impedance")
            if po.get("type", "lumped") != "lumped":
                raise DesignError("complex reference is supported on lumped ports only", f"{w}.reference_impedance")
        if po.get("type") == "waveguide":
            for k in ("a", "b"):
                _need(po, k, w)
            if not isinstance(po.get("mode", "TE10"), str):
                raise DesignError("mode is a name such as 'TE10'", f"{w}.mode")
        n = po.get("number")
        if not isinstance(n, int) or n < 1 or n in numbers:
            raise DesignError("port numbers are 1, 2, ... and unique", f"{w}.number")
        numbers.add(n)
        if po.get("direction") not in AXES:
            raise DesignError("direction must be x, y or z", f"{w}.direction")
    for i, r in enumerate(d.get("resistors", [])):
        if r.get("topology", "parallel") not in ("parallel", "series"):
            raise DesignError("topology must be parallel or series", f"resistors[{i}].topology")
        if r.get("direction") not in AXES:
            raise DesignError("direction must be x, y or z", f"resistors[{i}].direction")
    mesh = d.get("mesh", {})
    if not isinstance(mesh, dict):
        raise DesignError("mesh must be an object", "mesh")
    if "refine_features" in mesh and not isinstance(mesh["refine_features"], bool):
        raise DesignError("refine features must be true or false", "mesh.refine_features")
    if mesh.get("mode", "auto") not in ("auto", "design", "manual"):
        raise DesignError('mesh.mode must be "auto", "design" or "manual"', "mesh.mode")
    if mesh.get("mode") == "manual":
        lines = mesh.get("lines")
        if not isinstance(lines, dict):
            raise DesignError("lines must be an object with x, y and z arrays", "mesh.lines")
        for axis in AXES:
            if not isinstance(lines.get(axis), list) or len(lines[axis]) < 2:
                raise DesignError("at least two lines are required", f"mesh.lines.{axis}")
    _check_monitors(d)
    b = d.get("simulation", {}).get("boundaries", "MUR")
    bl = [b] * 6 if isinstance(b, str) else b
    if not isinstance(bl, list) or len(bl) != 6 or any(not isinstance(x, str) for x in bl):
        raise DesignError("boundaries is one name or a list of six (x- x+ y- y+ z- z+)", "simulation.boundaries")


def check_port_group(po: dict, path: str) -> None:
    """The optional group adds feeds; the ordinary port remains its first positive member."""
    if "group" not in po:
        return
    group = po["group"]
    w = f"{path}.group"
    if po.get("type", "lumped") != "lumped" or not isinstance(group, dict):
        raise DesignError("group is an object on a lumped port", w)
    if group.get("connection") not in ("parallel", "series"):
        raise DesignError("connection must be parallel or series", f"{w}.connection")
    members = group.get("members")
    if not isinstance(members, list) or not 1 <= len(members) <= 15:
        raise DesignError("group needs 1 to 15 additional feeds", f"{w}.members")
    priority = group.get("priority", 5)
    if (isinstance(priority, bool) or not isinstance(priority, (int, float))
            or not math.isfinite(priority) or priority < 0 or int(priority) != priority):
        raise DesignError("priority must be a nonnegative integer", f"{w}.priority")
    if set(group) - {"connection", "members", "priority"}:
        raise DesignError("group contains connection, members and priority only", w)
    for j, member in enumerate(members):
        wm = f"{w}.members[{j}]"
        if not isinstance(member, dict):
            raise DesignError("member must be an object", wm)
        for key in ("start", "stop"):
            if not isinstance(member.get(key), list) or len(member[key]) != 3:
                raise DesignError("expected three coordinates", f"{wm}.{key}")
        if member.get("direction") not in AXES:
            raise DesignError("direction must be x, y or z", f"{wm}.direction")
        if isinstance(member.get("polarity", 1), bool) or member.get("polarity", 1) not in (-1, 1):
            raise DesignError("polarity must be +1 or -1", f"{wm}.polarity")
        if set(member) - {"start", "stop", "direction", "polarity"}:
            raise DesignError("members contain coordinates, direction and polarity only", wm)


def port_feeds(po: dict, path: str):
    """Physical feed records and their exact Design paths, preserving logical number/settings."""
    yield path, po
    group = po.get("group")
    if isinstance(group, dict) and isinstance(group.get("members"), list):
        for j, member in enumerate(group["members"]):
            if isinstance(member, dict):
                yield f"{path}.group.members[{j}]", {**po, **member}


def _check_monitors(d: dict) -> None:
    """Optional ``monitors``: {"currents": [GHz, ...]} (surface-current maps) and
    {"efficiency": {"points": N}} (efficiency over the band; design_checks checks N)."""
    mon = d.get("monitors")
    if mon is None:
        return
    if not isinstance(mon, dict):
        raise DesignError("monitors is an object, e.g. {\"currents\": [\"f0\"]}", "monitors")
    cur = mon.get("currents", [])
    if not isinstance(cur, list):
        raise DesignError("monitors.currents is a list of frequencies in GHz", "monitors.currents")
    eff = mon.get("efficiency")
    if eff is not None and not isinstance(eff, dict):
        raise DesignError('monitors.efficiency is an object, e.g. {"points": 21}', "monitors.efficiency")
    planes = mon.get("field_planes", [])
    if not isinstance(planes, list):
        raise DesignError('monitors.field_planes is a list, e.g. [{"quantity": "E", "normal": "z", '
                          '"position": "h + 1", "frequencies": ["f0"]}]', "monitors.field_planes")
    for k, pl in enumerate(planes):
        w = f"monitors.field_planes[{k}]"
        if not isinstance(pl, dict):
            raise DesignError("a field plane is an object with quantity, normal, position and frequencies", w)
        if pl.get("quantity") not in FIELD_QUANTITIES:
            raise DesignError('quantity is "E" or "H"', f"{w}.quantity")
        if pl.get("normal") not in AXES:
            raise DesignError('normal is "x", "y" or "z"', f"{w}.normal")
        if pl.get("component", "abs") not in FIELD_COMPONENTS:
            raise DesignError('component is "abs", "x", "y" or "z"', f"{w}.component")
        if not isinstance(pl.get("frequencies", []), list):
            raise DesignError("frequencies is a list of frequencies in GHz", f"{w}.frequencies")


def field_plane_monitors(d: dict, num) -> list[dict]:
    """The design's field planes for ``Simulation.field_plane_monitors`` (position in mm, frequencies
    in Hz), evaluated with ``num(expr, where)``. Planes beyond the limits, and those whose values do
    not evaluate, are left out with a warning (design_checks reports them as errors that block a
    designer run; the build carries on so the geometry preview survives a half-typed value)."""
    out = []
    for k, pl in enumerate(((d.get("monitors") or {}).get("field_planes") or [])[:FIELD_PLANES_MAX]):
        w = f"monitors.field_planes[{k}]"
        try:
            freqs = [num(f, f"{w}.frequencies[{j}]") * 1e9 for j, f in enumerate(pl.get("frequencies") or [])]
            pos = num(pl.get("position"), f"{w}.position")
        except DesignError as e:
            print(f"fairbeam: warning: {w} ignored: {e}", file=sys.stderr, flush=True)
            continue
        if freqs:
            out.append({"quantity": pl["quantity"], "normal": pl["normal"], "component": pl.get("component", "abs"),
                        "position": pos, "frequencies": freqs[:FIELD_PLANE_FREQS_MAX]})
    return out


def efficiency_points(d: dict) -> int | None:
    """The design's efficiency-over-the-band points (``monitors.efficiency.points``, default 21),
    or None without that monitor. Anything but a whole number from 3 to 201 raises."""
    eff = (d.get("monitors") or {}).get("efficiency")
    if not isinstance(eff, dict):
        return None
    n = eff.get("points", EFFICIENCY_POINTS_DEFAULT)
    if isinstance(n, float) and n.is_integer():
        n = int(n)
    if not isinstance(n, int) or isinstance(n, bool) or not EFFICIENCY_POINTS_MIN <= n <= EFFICIENCY_POINTS_MAX:
        raise DesignError(f"the number of frequencies is a whole number from {EFFICIENCY_POINTS_MIN} to "
                          f"{EFFICIENCY_POINTS_MAX}", "monitors.efficiency.points")
    return n


# ---------------------------------------------------------------------------- parameters

def design_params(d: dict):
    """The independent parameters as :class:`fairbeam.model.Param` (derived ones are not tunable)."""
    from .model import Param

    out = []
    for p in d.get("params", []):
        if "expr" in p:
            continue
        default = p["default"]
        out.append(Param(p["key"], float(default) if isinstance(default, (int, float)) else default,
                         p.get("label") or p["key"], p.get("unit", ""), p.get("description", ""),
                         p.get("min"), p.get("max")))
    return out


def resolve_names(d: dict, values: dict) -> dict:
    """Independent values plus the derived parameters, in file order (a derived one may use any
    parameter above it)."""
    names = {k: float(v) for k, v in values.items()}
    for i, p in enumerate(d.get("params", [])):
        if "expr" in p:
            try:
                names[p["key"]] = evaluate(p["expr"], names)
            except DesignError as e:
                raise DesignError(e.detail, f"params[{i}].expr") from None
        elif p["key"] not in names:
            names[p["key"]] = float(p["default"])
    return names


# ---------------------------------------------------------------------------- geometry (numbers)
#
# The build works in two steps: every primitive is evaluated into numbers in CSXCAD's terms (a
# "resolved" primitive, a plain dict), and each part's transforms become a list of maps
# p -> s * p + t (s: a sign per axis, t: an offset), applied to every resolved primitive. The
# same resolved geometry feeds the checks in fairbeam.design_checks.

IDENTITY = ((1.0, 1.0, 1.0), (0.0, 0.0, 0.0))


def in_plane(n: int) -> tuple[int, int]:
    """The in-plane axes of normal ``n``, in CSXCAD's order: ((n + 1) % 3, (n + 2) % 3)."""
    return (n + 1) % 3, (n + 2) % 3


def _evaluator(names: dict):
    def num(v, where):
        try:
            return evaluate(v, names)
        except DesignError as e:
            raise DesignError(e.detail, where) from None

    def vec(v, where, n=3):
        if not isinstance(v, list) or len(v) != n:
            raise DesignError(f"expected a list of {n} values", where)
        return [num(x, f"{where}[{k}]") for k, x in enumerate(v)]

    return num, vec


def cone_profile(lo: float, hi: float, rb: float, rt: float) -> list:
    """(radial, axial) outline of a cone or frustum from axial lo (radius rb) to hi (radius rt)."""
    pts = [[0.0, lo]]
    if rb > 0:
        pts.append([rb, lo])
    if rt > 0:
        pts.append([rt, hi])
    pts.append([0.0, hi])
    return pts


def torus_profile(big: float, small: float, n: int = TORUS_SEGMENTS) -> list:
    """(radial, axial) outline of a torus' tube: a regular n-gon of radius ``small`` at radial ``big``."""
    return [[big + small * math.cos(2 * math.pi * k / n), small * math.sin(2 * math.pi * k / n)] for k in range(n)]


def disc_segments(radius: float) -> int:
    """The number of sides of the polygon that stands for a flat circle of this radius (mm)."""
    ratio = DISC_SAG_MM / radius if radius > 0 else 2.0
    n = DISC_MIN_SEGMENTS if ratio >= 1 else math.ceil(math.pi / math.acos(1 - ratio))
    n = max(DISC_MIN_SEGMENTS, min(DISC_MAX_SEGMENTS, n))
    return n + n % 2


def disc_ring(cu: float, cv: float, radius: float, n: int | None = None) -> list:
    """The counter-clockwise regular polygon on the circle (centre ``cu``, ``cv``): a vertex at angle 0."""
    n = n or disc_segments(radius)
    return [[cu + radius * math.cos(2 * math.pi * k / n), cv + radius * math.sin(2 * math.pi * k / n)] for k in range(n)]


def disc_halves(cu: float, cv: float, radius: float, inner: float, n: int | None = None) -> list:
    """A flat ring (annulus) as two simple polygons, the half rings above and below the diameter
    through the vertices at angles 0 and 180 degrees (CSXCAD and CST polygons have no holes)."""
    n = n or disc_segments(radius)
    outer, inn = disc_ring(cu, cv, radius, n), disc_ring(cu, cv, inner, n)
    h = n // 2
    return [outer[:h + 1] + inn[:h + 1][::-1], outer[h:] + [outer[0]] + [inn[0]] + inn[h:][::-1]]


def polygon_ring_area(ring: list) -> float:
    """Signed area of a ring of [u, v] points (counter-clockwise positive)."""
    return sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(ring, ring[1:] + ring[:1])) / 2


def polyhedron_faces(faces, n_vertices: int, wp: str) -> list:
    """A polyhedron's faces as lists of ints: at least 4 faces of at least 3 distinct, in-range
    vertex indices each."""
    if not isinstance(faces, list) or len(faces) < 4:
        raise DesignError("a polyhedron needs at least 4 vertices and 4 faces", f"{wp}.faces")
    out = []
    for k, f in enumerate(faces):
        ok = isinstance(f, list) and len(f) >= 3 and all(isinstance(i, int) and not isinstance(i, bool) for i in f)
        if not ok:
            raise DesignError("a face is a list of at least 3 vertex indices", f"{wp}.faces[{k}]")
        for i in f:
            if i < 0 or i >= n_vertices:
                raise DesignError(f"vertex index {i} is out of range (0 to {n_vertices - 1})", f"{wp}.faces[{k}]")
        if len(set(f)) < 3:
            raise DesignError("a face needs at least 3 different vertices", f"{wp}.faces[{k}]")
        out.append(list(f))
    return out


def polyhedron_triangles(vertices: list, faces: list) -> list:
    """The triangles CSXCAD rasterises: every polygon face fanned from its first vertex, all
    reversed when the mesh encloses a negative volume (a mirrored copy)."""
    tris = [[f[0], f[k], f[k + 1]] for f in faces for k in range(1, len(f) - 1)]
    vol = 0.0
    for a, b, c in tris:
        p, q, r = vertices[a], vertices[b], vertices[c]
        vol += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0])
                + p[2] * (q[0] * r[1] - q[1] * r[0]))
    return [[a, c, b] for a, b, c in tris] if vol < 0 else tris


def add_polyhedron(prop, vertices, faces, priority):
    """CSXCAD ``AddPolyhedron`` of the design's vertices and faces (triangulated, outward)."""
    ph = prop.AddPolyhedron(priority=priority)
    for v in vertices:
        ph.AddVertex(*[float(c) for c in v])
    for tri in polyhedron_triangles(vertices, faces):
        ph.AddFace([int(i) for i in tri])
    return ph


def _priority(value):
    """A priority: an int stays an int, a whole float becomes one, any other float stays a float
    (a void carver sits at its host's priority + 0.5)."""
    if isinstance(value, float) and value != int(value):
        return value
    return int(value)


def resolve_primitive(pr: dict, names: dict, wp: str, priority: int) -> dict:
    """One design primitive in numbers (CSXCAD terms). Raises :class:`DesignError` for what cannot
    be built at all; the milder absurdities are left to the checks."""
    num, vec = _evaluator(names)
    kind = pr["kind"]
    out: dict = {"kind": kind, "priority": _priority(pr.get("priority", priority)), "where": wp}
    if pr.get("void"):
        out["void"] = True
    if kind == "box":
        a, c = vec(pr.get("start"), f"{wp}.start"), vec(pr.get("stop"), f"{wp}.stop")
        if sum(1 for k in range(3) if abs(a[k] - c[k]) < 1e-12) > 1:
            raise DesignError("a brick needs extent in at least two directions", f"{wp}.stop")
        out.update(start=a, stop=c)
    elif kind == "cylinder":
        r = num(pr.get("radius"), f"{wp}.radius")
        ri = num(pr.get("inner_radius", 0), f"{wp}.inner_radius")
        if "axis" in pr:
            n = AXES.index(pr["axis"])
            u, v = in_plane(n)
            cu, cv = vec(pr.get("center"), f"{wp}.center", 2)
            lo, hi = vec(pr.get("range"), f"{wp}.range", 2)
            if hi - lo < -1e-9:
                raise DesignError("a cylinder's range minimum must not exceed its maximum", f"{wp}.range[1]")
            if r <= 0:
                raise DesignError("the radius must be > 0", f"{wp}.radius")
            if ri < 0 or ri >= r:
                raise DesignError("the inner radius must be 0 (solid) or between 0 and the outer radius", f"{wp}.inner_radius")
            if abs(hi - lo) < 1e-9:
                # zero length: a flat circle (a disc, or a ring), built as a regular polygon sheet; a
                # zero-length CSXCAD cylinder would carve nothing. "disc" lets the cuts and the
                # build split a ring into two half rings (expand_discs); the points are the outer ring.
                out.update(kind="polygon", normal=n, elevation=lo, points=disc_ring(cu, cv, r),
                           disc={"center": [cu, cv], "radius": r, "inner_radius": ri})
                return out
            a, c = [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
            a[n], c[n], a[u], c[u], a[v], c[v] = lo, hi, cu, cu, cv, cv
        else:
            a, c = vec(pr.get("start"), f"{wp}.start"), vec(pr.get("stop"), f"{wp}.stop")
            if all(abs(a[k] - c[k]) < 1e-12 for k in range(3)):
                raise DesignError("a cylinder needs start != stop", f"{wp}.stop")
        if r <= 0:
            raise DesignError("the radius must be > 0", f"{wp}.radius")
        if ri < 0 or ri >= r:
            raise DesignError("the inner radius must be 0 (solid) or between 0 and the outer radius", f"{wp}.inner_radius")
        out.update(start=a, stop=c, radius=r, inner_radius=ri)
    elif kind == "sphere":
        ctr = vec(pr.get("center"), f"{wp}.center")
        r = num(pr.get("radius"), f"{wp}.radius")
        if r <= 0:
            raise DesignError("the radius must be > 0", f"{wp}.radius")
        out.update(center=ctr, radius=r)
    elif kind == "cone":
        a = AXES.index(pr["axis"])
        u, v = in_plane(a)
        cu, cv = vec(pr.get("center"), f"{wp}.center", 2)
        lo, hi = vec(pr.get("range"), f"{wp}.range", 2)
        rb, rt = num(pr.get("bottom_radius"), f"{wp}.bottom_radius"), num(pr.get("top_radius", 0), f"{wp}.top_radius")
        if hi - lo < 1e-12:
            raise DesignError("a cone needs a length along its axis (min < max)", f"{wp}.range[1]")
        if rb < 0 or rt < 0 or (rb <= 0 and rt <= 0):
            raise DesignError("the radii must be >= 0 and not both 0", f"{wp}.bottom_radius")
        origin = [0.0, 0.0, 0.0]
        origin[u], origin[v] = cu, cv
        out.update(axis=a, origin=origin, profile=cone_profile(lo, hi, rb, rt))
    elif kind == "torus":
        a = AXES.index(pr["axis"])
        ctr = vec(pr.get("center"), f"{wp}.center")
        big, small = num(pr.get("major_radius"), f"{wp}.major_radius"), num(pr.get("minor_radius"), f"{wp}.minor_radius")
        if big <= 0:
            raise DesignError("the radius must be > 0", f"{wp}.major_radius")
        if small <= 0:
            raise DesignError("the radius must be > 0", f"{wp}.minor_radius")
        if small >= big:
            raise DesignError("the minor (tube) radius must be below the major radius", f"{wp}.minor_radius")
        out.update(axis=a, origin=ctr, profile=torus_profile(big, small), major=big, minor=small)
    elif kind == "wire":
        pts = pr.get("points")
        if not isinstance(pts, list) or len(pts) < 2:
            raise DesignError("a wire needs at least 2 points", f"{wp}.points")
        pts = [vec(q, f"{wp}.points[{k}]") for k, q in enumerate(pts)]
        if all(math.dist(pts[0], q) < 1e-12 for q in pts):
            raise DesignError("a wire needs two distinct points", f"{wp}.points")
        r = num(pr.get("radius"), f"{wp}.radius")
        if r <= 0:
            raise DesignError("the radius must be > 0", f"{wp}.radius")
        out.update(points=pts, radius=r)
    elif kind == "polyhedron":
        verts, faces = pr.get("vertices"), pr.get("faces")
        if not isinstance(verts, list) or len(verts) < 4:
            raise DesignError("a polyhedron needs at least 4 vertices and 4 faces", f"{wp}.vertices")
        verts = [vec(q, f"{wp}.vertices[{k}]") for k, q in enumerate(verts)]
        faces = polyhedron_faces(faces, len(verts), wp)
        out.update(vertices=verts, faces=faces)
    else:
        n = AXES.index(pr.get("normal", "z"))
        pts = pr.get("points")
        if not isinstance(pts, list) or len(pts) < 3:
            raise DesignError("a polygon needs at least 3 points", f"{wp}.points")
        out.update(normal=n, elevation=num(pr.get("elevation", 0), f"{wp}.elevation"),
                   points=[vec(q, f"{wp}.points[{k}]", 2) for k, q in enumerate(pts)])
        if kind == "linpoly":
            out["length"] = num(pr.get("length"), f"{wp}.length")
    return out


def transform_maps(transforms: list, names: dict, w: str) -> list:
    """The maps (s, t) of a part's transforms, in order, starting from identity."""
    num, vec = _evaluator(names)
    maps = [IDENTITY]
    for k, tr in enumerate(transforms or []):
        wt = f"{w}.transforms[{k}]"
        if tr["type"] == "move":
            d = vec(tr.get("offset"), f"{wt}.offset")
            maps = [(s, tuple(t[a] + d[a] for a in range(3))) for s, t in maps]
        elif tr["type"] == "rotate":
            angle = num(tr.get("angle"), f"{wt}.angle")
            n = num(tr.get("copies", 0), f"{wt}.copies")
            if abs(n - round(n)) > 1e-9 or n < 0:
                raise DesignError("the number of copies must be a whole number >= 0", f"{wt}.copies")
            n = int(round(n))
            if (n + 1) * len(maps) > MAX_COPIES + 1:
                raise DesignError(f"at most {MAX_COPIES} copies of a part", f"{wt}.copies")
            center = vec(tr.get("center"), f"{wt}.center")
            turns = int(round(angle / 90))
            axis = AXES.index(tr["axis"])
            quarter_turn = abs(angle / 90 - round(angle / 90)) <= 1e-9
            if quarter_turn:
                # Keep the established signed-permutation path exactly as it was.
                maps = [_rotate(s, t, axis, center, turns * k)
                        for k in (range(n + 1) if n else (1,)) for s, t in maps]
            else:
                maps = [((s, t) if k == 0 else _rotate_any(s, t, axis, center, (angle % 360.0) * k))
                        for k in (range(n + 1) if n else (1,)) for s, t in maps]
        elif tr["type"] == "translate":
            n = num(tr.get("copies"), f"{wt}.copies")
            if abs(n - round(n)) > 1e-9 or n < 0:
                raise DesignError("the number of copies must be a whole number >= 0", f"{wt}.copies")
            n = int(round(n))
            if (n + 1) * len(maps) > MAX_COPIES + 1:
                raise DesignError(f"at most {MAX_COPIES} copies of a part", f"{wt}.copies")
            d = vec(tr.get("step"), f"{wt}.step")
            maps = [(s, (t[0] + i * d[0], t[1] + i * d[1], t[2] + i * d[2])) for i in range(n + 1) for s, t in maps]
        elif tr["type"] == "scale":
            factors = vec(tr.get("factors"), f"{wt}.factors")
            if any(f <= 0 for f in factors):
                raise DesignError("scale factors must be positive", f"{wt}.factors")
            if max(factors) - min(factors) > 1e-12 * max(1.0, *(abs(f) for f in factors)):
                raise DesignError("nonuniform scaling is unsupported; all three factors must be equal", f"{wt}.factors")
            n = num(tr.get("copies", 0), f"{wt}.copies")
            if abs(n - round(n)) > 1e-9 or n < 0:
                raise DesignError("the number of copies must be a whole number >= 0", f"{wt}.copies")
            n = int(round(n))
            if (n + 1) * len(maps) > MAX_COPIES + 1:
                raise DesignError(f"at most {MAX_COPIES} copies of a part", f"{wt}.copies")
            origin = vec(tr.get("origin"), f"{wt}.origin")
            factor = sum(factors) / 3
            if n:
                base, scaled = list(maps), list(maps)
                copies = []
                for _ in range(n):
                    scaled = [_scale(s, t, factor, origin) for s, t in scaled]
                    copies.extend(scaled)
                maps = base + copies
            else:
                maps = [_scale(s, t, factor, origin) for s, t in maps]
        else:
            a = AXES.index(tr["plane"])
            point = vec(tr.get("point", [0, 0, 0]), f"{wt}.point")
            flipped = [flip(s, t, a, point[a]) for s, t in maps]
            maps = maps + flipped if tr.get("keep", True) else flipped
            if len(maps) > MAX_COPIES + 1:
                raise DesignError(f"at most {MAX_COPIES} copies of a part", f"{wt}.plane")
    return maps


def flip(s, t, a, point=0):
    """Map (s, t) followed by the mirror across axis ``a`` through ``point``."""
    s, t = list(s), list(t)
    s[a] = tuple(-x for x in s[a]) if isinstance(s[a], (tuple, list)) else -s[a]
    t[a] = 2 * point - t[a]
    return tuple(s), tuple(t)


def _scale(s, t, factor, origin):
    """Compose a positive uniform scale about origin after an existing affine map."""
    if isinstance(s[0], (tuple, list)):
        s = tuple(tuple(factor * x for x in row) for row in s)
    else:
        s = tuple(factor * x for x in s)
    t = tuple(factor * (t[i] - origin[i]) + origin[i] for i in range(3))
    return s, t


def _pt(s, t, p):
    if isinstance(s[0], (tuple, list)):
        return [sum(s[i][j] * p[j] for j in range(3)) + t[i] for i in range(3)]
    return [s[i] * p[i] + t[i] for i in range(3)]


def _mapped_axis(s, axis):
    """Output axis and direction of an input axis under a signed permutation."""
    if not isinstance(s[0], (tuple, list)):
        return axis, s[axis]
    out = next(i for i in range(3) if s[i][axis])
    return out, s[out][axis]


def _map_scale(s):
    return max(abs(x) for row in s for x in row) if isinstance(s[0], (tuple, list)) else abs(s[0])


def _rotate(s, t, axis, center, turns):
    """Compose exact right-handed quarter turns after an existing affine map."""
    m = [list(row) for row in s] if isinstance(s[0], (tuple, list)) else [
        [s[i] if i == j else 0 for j in range(3)] for i in range(3)]
    t = [t[i] - center[i] for i in range(3)]
    u, v = (axis + 1) % 3, (axis + 2) % 3
    for _ in range(turns % 4):
        m[u], m[v] = [-x for x in m[v]], m[u]
        t[u], t[v] = -t[v], t[u]
    return tuple(tuple(row) for row in m), tuple(t[i] + center[i] for i in range(3))


def _linear(s):
    """Return the row-major 3x3 linear part of a legacy vector or matrix map."""
    if isinstance(s[0], (tuple, list)):
        return [list(row) for row in s]
    return [[s[i] if i == j else 0.0 for j in range(3)] for i in range(3)]


def _matmul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def _rotate_any(s, t, axis, center, angle):
    """Compose an exact right-handed rotation by any finite angle after an existing map."""
    radians = math.radians(angle % 360.0)
    c, sn = math.cos(radians), math.sin(radians)
    if axis == 0:
        r = [[1.0, 0.0, 0.0], [0.0, c, -sn], [0.0, sn, c]]
    elif axis == 1:
        r = [[c, 0.0, sn], [0.0, 1.0, 0.0], [-sn, 0.0, c]]
    else:
        r = [[c, -sn, 0.0], [sn, c, 0.0], [0.0, 0.0, 1.0]]
    linear = _matmul(r, _linear(s))
    delta = [t[i] - center[i] for i in range(3)]
    moved = [sum(r[i][j] * delta[j] for j in range(3)) + center[i] for i in range(3)]
    return tuple(tuple(row) for row in linear), tuple(moved)


def _axis_map(s, tol=1e-12):
    """Whether a map is still representable by the existing axis-aligned primitive mapper."""
    m = _linear(s)
    used = set()
    for row in m:
        nz = [j for j, x in enumerate(row) if abs(x) > tol]
        if len(nz) != 1 or nz[0] in used:
            return False
        used.add(nz[0])
    return len(used) == 3


def _matrix4(s, t):
    m = _linear(s)
    return [m[i] + [float(t[i])] for i in range(3)] + [[0.0, 0.0, 0.0, 1.0]]


def map_primitive(p: dict, s, t) -> dict:
    """A resolved primitive moved by p -> s * p + t (exact for every kind)."""
    q = dict(p)
    if not _axis_map(s):
        # Preserve the exact local native shape. Its world geometry is carried by this matrix;
        # do not replace it with transformed bounds or a tessellation.
        q["_matrix"] = _matrix4(s, t)
        return q
    kind = p["kind"]
    factor = _map_scale(s)
    if kind in ("box", "cylinder"):
        q["start"], q["stop"] = _pt(s, t, p["start"]), _pt(s, t, p["stop"])
        if kind == "cylinder":
            q["radius"] = p["radius"] * factor
            if "inner_radius" in p:
                q["inner_radius"] = p["inner_radius"] * factor
    elif kind == "sphere":
        q["center"] = _pt(s, t, p["center"])
        q["radius"] = p["radius"] * factor
    elif kind == "wire":
        q["points"] = [_pt(s, t, x) for x in p["points"]]
        q["radius"] = p["radius"] * factor
    elif kind == "polyhedron":
        q["vertices"] = [_pt(s, t, x) for x in p["vertices"]]
    elif kind in ("cone", "torus"):
        # rotationally symmetric: a mirror across a plane containing the axis leaves the profile,
        # one across a plane normal to it flips the axial coordinate
        q["origin"] = _pt(s, t, p["origin"])
        q["axis"], sign = _mapped_axis(s, p["axis"])
        q["profile"] = [[factor * r, sign * h] for r, h in p["profile"]]
    else:
        n = p["normal"]
        u, v = in_plane(n)
        q["normal"], sign = _mapped_axis(s, n)
        ou, ov = in_plane(q["normal"])
        points = []
        for a, b in p["points"]:
            point = [0.0] * 3
            point[n], point[u], point[v] = p["elevation"], a, b
            moved = _pt(s, t, point)
            points.append([moved[ou], moved[ov]])
        q["points"] = points
        if kind == "linpoly" and sign < 0:
            # keep the extrusion direction: the mirrored slab starts at the far face
            q["elevation"] = sign * (p["elevation"] + p["length"]) + t[q["normal"]]
        else:
            q["elevation"] = sign * p["elevation"] + t[q["normal"]]
        if kind == "linpoly":
            q["length"] = p["length"] * factor
    return q


def _matrix_point(matrix, point):
    return [sum(matrix[i][j] * point[j] for j in range(3)) + matrix[i][3] for i in range(3)]


def _inverse_matrix_point(matrix, point):
    """Map a world point back to local coordinates for the nonsingular 3x3 affine matrix."""
    a = [row[:3] for row in matrix[:3]]
    d = [point[i] - matrix[i][3] for i in range(3)]
    det = (a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
           - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
           + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]))
    if abs(det) < 1e-30:
        raise DesignError("primitive transform matrix is singular")
    inv = [
        [(a[1][1] * a[2][2] - a[1][2] * a[2][1]) / det,
         (a[0][2] * a[2][1] - a[0][1] * a[2][2]) / det,
         (a[0][1] * a[1][2] - a[0][2] * a[1][1]) / det],
        [(a[1][2] * a[2][0] - a[1][0] * a[2][2]) / det,
         (a[0][0] * a[2][2] - a[0][2] * a[2][0]) / det,
         (a[0][2] * a[1][0] - a[0][0] * a[1][2]) / det],
        [(a[1][0] * a[2][1] - a[1][1] * a[2][0]) / det,
         (a[0][1] * a[2][0] - a[0][0] * a[2][1]) / det,
         (a[0][0] * a[1][1] - a[0][1] * a[1][0]) / det],
    ]
    return [sum(inv[i][j] * d[j] for j in range(3)) for i in range(3)]


def _points_bbox(points, expand=None):
    expand = expand or [0.0, 0.0, 0.0]
    return ([min(p[k] for p in points) - expand[k] for k in range(3)],
            [max(p[k] for p in points) + expand[k] for k in range(3)])


def _transformed_bbox(p):
    """Tight world-space AABB of an exact primitive with an affine native transform."""
    matrix = p["_matrix"]
    linear = [row[:3] for row in matrix[:3]]
    scale = math.sqrt(sum(x * x for x in linear[0]))
    columns = [[linear[i][j] for i in range(3)] for j in range(3)]
    norms = [math.sqrt(sum(x * x for x in col)) for col in columns]
    similarity = max(norms) > 0 and max(norms) - min(norms) <= 1e-9 * max(norms) and all(
        abs(sum(columns[i][k] * columns[j][k] for k in range(3))) <= 1e-9 * max(norms) ** 2
        for i in range(3) for j in range(i + 1, 3))
    if not similarity:
        # Native affine matrices may also come from external models and need not be rigid or
        # uniformly scaled. Keep their exact transformed shape, with a conservative transformed
        # local AABB for culling and display limits.
        local = {k: v for k, v in p.items() if k != "_matrix"}
        lo, hi = prim_bbox(local)
        corners = [[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
        return _points_bbox([_matrix_point(matrix, q) for q in corners])
    kind = p["kind"]
    if kind == "box":
        lo = [min(p["start"][k], p["stop"][k]) for k in range(3)]
        hi = [max(p["start"][k], p["stop"][k]) for k in range(3)]
        return _points_bbox([_matrix_point(matrix, [x, y, z]) for x in (lo[0], hi[0])
                             for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
    if kind == "cylinder":
        a, c = _matrix_point(matrix, p["start"]), _matrix_point(matrix, p["stop"])
        axis = [c[k] - a[k] for k in range(3)]
        length = math.sqrt(sum(x * x for x in axis)) or 1.0
        r = p["radius"] * scale
        return _points_bbox([a, c], [r * math.sqrt(max(0.0, 1 - (x / length) ** 2)) for x in axis])
    if kind == "sphere":
        center = _matrix_point(matrix, p["center"])
        r = p["radius"] * scale
        return ([x - r for x in center], [x + r for x in center])
    if kind == "wire":
        return _points_bbox([_matrix_point(matrix, q) for q in p["points"]], [p["radius"] * scale] * 3)
    if kind == "polyhedron":
        return _points_bbox([_matrix_point(matrix, q) for q in p["vertices"]])
    if kind in ("cone", "torus"):
        origin = _matrix_point(matrix, p["origin"])
        axis = p["axis"]
        direction = [linear[k][axis] / scale for k in range(3)]
        lo, hi = list(origin), list(origin)
        for k in range(3):
            radial = math.sqrt(max(0.0, 1 - direction[k] ** 2))
            values = [scale * (h * direction[k] + r * radial) for r, h in p["profile"]]
            lows = [scale * (h * direction[k] - r * radial) for r, h in p["profile"]]
            lo[k] += min(lows)
            hi[k] += max(values)
        return lo, hi
    n = p["normal"]
    u, v = in_plane(n)
    levels = [p["elevation"]]
    if kind == "linpoly":
        levels.append(p["elevation"] + p["length"])
    pts = []
    for e in levels:
        for a, b in p["points"]:
            q = [0.0, 0.0, 0.0]
            q[n], q[u], q[v] = e, a, b
            pts.append(_matrix_point(matrix, q))
    return _points_bbox(pts)


def prim_bbox(p: dict) -> tuple[list, list]:
    if "_matrix" in p:
        return _transformed_bbox(p)
    kind = p["kind"]
    if kind == "box":
        return ([min(p["start"][k], p["stop"][k]) for k in range(3)], [max(p["start"][k], p["stop"][k]) for k in range(3)])
    if kind == "cylinder":
        a, c, r = p["start"], p["stop"], p["radius"]
        axis = [c[k] - a[k] for k in range(3)]
        length = math.sqrt(sum(x * x for x in axis))
        # exact for any axis direction: the disc radius along axis k is r * sqrt(1 - (d_k / |d|)^2)
        ext = [r * math.sqrt(max(0.0, 1 - (axis[k] / length) ** 2)) for k in range(3)]
        return ([min(a[k], c[k]) - ext[k] for k in range(3)], [max(a[k], c[k]) + ext[k] for k in range(3)])
    if kind == "sphere":
        return ([x - p["radius"] for x in p["center"]], [x + p["radius"] for x in p["center"]])
    if kind == "wire":
        # CSXCAD's own box: the points' extent grown by the radius on every side (the ends are round)
        r = p["radius"]
        return ([min(q[k] for q in p["points"]) - r for k in range(3)], [max(q[k] for q in p["points"]) + r for k in range(3)])
    if kind == "polyhedron":
        return ([min(q[k] for q in p["vertices"]) for k in range(3)], [max(q[k] for q in p["vertices"]) for k in range(3)])
    if kind in ("cone", "torus"):
        a, o = p["axis"], p["origin"]
        rmax = max(r for r, _ in p["profile"])
        lo, hi = [x - rmax for x in o], [x + rmax for x in o]
        lo[a], hi[a] = o[a] + min(h for _, h in p["profile"]), o[a] + max(h for _, h in p["profile"])
        return lo, hi
    n = p["normal"]
    u, v = in_plane(n)
    e0 = p["elevation"]
    e1 = e0 + p.get("length", 0.0) if kind == "linpoly" else e0
    lo, hi = [0.0] * 3, [0.0] * 3
    lo[n], hi[n] = min(e0, e1), max(e0, e1)
    lo[u], hi[u] = min(q[0] for q in p["points"]), max(q[0] for q in p["points"])
    lo[v], hi[v] = min(q[1] for q in p["points"]), max(q[1] for q in p["points"])
    return lo, hi


def point_in_polygon(x, y, pts, tol=1e-7) -> bool:
    """Inside or on the boundary (within ``tol``)."""
    inside = False
    n = len(pts)
    for i in range(n):
        (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % n]
        if min(x1, x2) - tol <= x <= max(x1, x2) + tol and min(y1, y2) - tol <= y <= max(y1, y2) + tol:
            cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)
            if abs(cross) <= tol * max(1.0, math.hypot(x2 - x1, y2 - y1)):
                return True
        if (y1 > y) != (y2 > y):
            if x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                inside = not inside
    return inside


def wire_distance(points, q) -> float:
    """Distance from point ``q`` to a polyline."""
    best = math.inf
    for a, b in zip(points[:-1], points[1:]):
        ab = [b[k] - a[k] for k in range(3)]
        L2 = sum(x * x for x in ab)
        t = 0.0 if L2 < 1e-30 else max(0.0, min(1.0, sum((q[k] - a[k]) * ab[k] for k in range(3)) / L2))
        best = min(best, math.dist(q, [a[k] + t * ab[k] for k in range(3)]))
    return best


def wire_contains(points, radius, q, tol=1e-6) -> bool:
    """Whether ``q`` is inside the solid a wire builds (see :func:`add_wire`): a cylinder with flat ends along
    every segment, and a sphere at each bend. A free end is a flat face, so a point just beyond it (a port
    starting on the end face) is outside. A wire with no radius is a line of mesh edges."""
    r = radius + tol
    n = len(points)
    for i, (a, b) in enumerate(zip(points[:-1], points[1:])):
        ab = [b[k] - a[k] for k in range(3)]
        L2 = sum(x * x for x in ab)
        if L2 < 1e-30:
            continue
        t = sum((q[k] - a[k]) * ab[k] for k in range(3)) / L2
        slack = tol / math.sqrt(L2)
        if -slack <= t <= 1 + slack and math.dist(q, [a[k] + t * ab[k] for k in range(3)]) <= r:
            return True
    return any(math.dist(q, points[i]) <= r for i in range(1, n - 1))


def _in_mesh(verts, tris, q, tol) -> bool:
    """Whether ``q`` is inside a closed triangle mesh or within ``tol`` of its surface: the parity
    of the crossings of a ray along +x (a slightly tilted one, to avoid grazing edges)."""
    d = (1.0, 1.7e-4, 2.9e-4)
    inside = False
    for a, b, c in tris:
        p0, p1, p2 = verts[a], verts[b], verts[c]
        e1 = [p1[k] - p0[k] for k in range(3)]
        e2 = [p2[k] - p0[k] for k in range(3)]
        n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
        nn = math.sqrt(sum(x * x for x in n))
        if nn < 1e-18:
            continue
        w = [q[k] - p0[k] for k in range(3)]
        if abs(sum(w[k] * n[k] for k in range(3))) / nn <= tol:
            # on the triangle's plane: on the surface when the projection falls inside it
            dot = lambda u, v: sum(u[k] * v[k] for k in range(3))  # noqa: E731
            d11, d12, d22, dw1, dw2 = dot(e1, e1), dot(e1, e2), dot(e2, e2), dot(w, e1), dot(w, e2)
            den = d11 * d22 - d12 * d12
            if abs(den) > 1e-24:
                bu, bv = (d22 * dw1 - d12 * dw2) / den, (d11 * dw2 - d12 * dw1) / den
                m = tol / math.sqrt(max(d11, d22))
                if bu >= -m and bv >= -m and bu + bv <= 1 + 2 * m:
                    return True
        # Moeller-Trumbore
        h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]]
        det = sum(e1[k] * h[k] for k in range(3))
        if abs(det) < 1e-18:
            continue
        s = [q[k] - p0[k] for k in range(3)]
        u = sum(s[k] * h[k] for k in range(3)) / det
        if u < 0 or u > 1:
            continue
        cr = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]]
        v = sum(d[k] * cr[k] for k in range(3)) / det
        if v < 0 or u + v > 1:
            continue
        if sum(e2[k] * cr[k] for k in range(3)) / det > 0:
            inside = not inside
    return inside


def prim_contains(p: dict, q, tol=1e-6) -> bool:
    """Whether point ``q`` is inside (or on the surface of) a resolved primitive."""
    lo, hi = prim_bbox(p)
    if any(q[k] < lo[k] - tol or q[k] > hi[k] + tol for k in range(3)):
        return False
    if "_matrix" in p:
        local = {k: v for k, v in p.items() if k != "_matrix"}
        return prim_contains(local, _inverse_matrix_point(p["_matrix"], q), tol)
    kind = p["kind"]
    if kind == "box":
        return True
    if kind == "cylinder":
        a, c = p["start"], p["stop"]
        ax = [c[k] - a[k] for k in range(3)]
        t = sum((q[k] - a[k]) * ax[k] for k in range(3)) / sum(x * x for x in ax)
        length = math.sqrt(sum(x * x for x in ax))
        if t < -tol / length or t > 1 + tol / length:
            return False
        dist = math.sqrt(sum((q[k] - a[k] - t * ax[k]) ** 2 for k in range(3)))
        return dist <= p["radius"] + tol and dist >= p.get("inner_radius", 0.0) - tol
    if kind == "sphere":
        return math.dist(q, p["center"]) <= p["radius"] + tol
    if kind == "wire":
        return wire_contains(p["points"], p["radius"], q, tol)
    if kind == "polyhedron":
        return _in_mesh(p["vertices"], polyhedron_triangles(p["vertices"], p["faces"]), q, tol)
    if kind in ("cone", "torus"):
        a, o = p["axis"], p["origin"]
        r = math.sqrt(sum((q[k] - o[k]) ** 2 for k in range(3) if k != a))
        return point_in_polygon(r, q[a] - o[a], p["profile"], tol)
    u, v = in_plane(p["normal"])
    return point_in_polygon(q[u], q[v], p["points"], tol)


def _sheet_minus(start, stop, cuts):
    """The rectangle sheet start..stop (zero size on one axis) minus the rectangles ``cuts`` (pairs of
    corners in its plane): the exact difference as disjoint rectangles, a list of (start, stop).

    The sheet is split on a grid of every cut edge inside it; the free cells are merged along the
    first in-plane axis into runs, and runs over runs of the same span into rectangles. The designer's
    instant preview (src/designer/geometry.ts, sheetMinus) and exported Python models run the same
    steps, so all three produce the same pieces in the same order."""
    tol = 1e-9
    n = [k for k in range(3) if abs(stop[k] - start[k]) < 1e-12][0]
    u, v = (n + 1) % 3, (n + 2) % 3
    u0, u1 = min(start[u], stop[u]), max(start[u], stop[u])
    v0, v1 = min(start[v], stop[v]), max(start[v], stop[v])
    rel = []
    for a, b in cuts:
        cu0, cu1 = max(min(a[u], b[u]), u0), min(max(a[u], b[u]), u1)
        cv0, cv1 = max(min(a[v], b[v]), v0), min(max(a[v], b[v]), v1)
        if cu1 - cu0 > tol and cv1 - cv0 > tol:
            rel.append((cu0, cu1, cv0, cv1))
    if not rel:
        return [(list(start), list(stop))]

    def grid(values):
        out = []
        for x in sorted(values):
            if not out or x - out[-1] > tol:
                out.append(x)
        return out

    us = grid([u0, u1] + [c[0] for c in rel] + [c[1] for c in rel])
    vs = grid([v0, v1] + [c[2] for c in rel] + [c[3] for c in rel])
    rects, open_ = [], {}
    for j in range(len(vs) - 1):
        vm = (vs[j] + vs[j + 1]) / 2
        runs, run = [], None
        for i in range(len(us) - 1):
            um = (us[i] + us[i + 1]) / 2
            free = not any(c[0] <= um <= c[1] and c[2] <= vm <= c[3] for c in rel)
            if free and run is None:
                run = i
            if not free and run is not None:
                runs.append((us[run], us[i]))
                run = None
        if run is not None:
            runs.append((us[run], us[-1]))
        nxt = {}
        for r in runs:
            if r in open_:
                rects[open_[r]][3] = vs[j + 1]
                nxt[r] = open_[r]
            else:
                rects.append([r[0], r[1], vs[j], vs[j + 1]])
                nxt[r] = len(rects) - 1
        open_ = nxt
    out = []
    for a0, a1, b0, b1 in rects:
        lo, hi = [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
        lo[n] = hi[n] = start[n]
        lo[u], hi[u], lo[v], hi[v] = a0, a1, b0, b1
        out.append((lo, hi))
    return out


def resolve_cuts(pt: dict, names: dict, w: str) -> list:
    """A part's cuts in numbers, one dict each: ``axis`` (the normal of the plane), ``plane`` (its
    position along the normal), ``shape`` ("rect", "circle" or "polygon"), ``ring`` (the outline as
    [u, v] points in the plane's in-plane coordinates; a circle is a regular polygon,
    :func:`disc_ring`), ``bounds`` of the ring and ``where``; a rectangle also ``a`` and ``b``, its
    corners (so that sheets that only meet rectangles keep their exact box pieces)."""
    num, vec = _evaluator(names)
    out = []
    for k, c in enumerate(pt.get("cuts") or []):
        wc = f"{w}.cuts[{k}]"
        shape = c.get("kind", "rect")
        if shape == "rect":
            a, b = vec(c.get("start"), f"{wc}.start"), vec(c.get("stop"), f"{wc}.stop")
            flat = [q for q in range(3) if abs(b[q] - a[q]) < 1e-12]
            if len(flat) != 1:
                raise DesignError("a rectangle cut lies on a plane: min = max on exactly one axis", f"{wc}.stop")
            n = flat[0]
            u, v = in_plane(n)
            u0, u1, v0, v1 = min(a[u], b[u]), max(a[u], b[u]), min(a[v], b[v]), max(a[v], b[v])
            cut = {"axis": n, "plane": a[n], "shape": "rect", "a": a, "b": b, "ring": [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]}
        elif shape == "circle":
            n = AXES.index(c.get("normal", "z"))
            cu, cv = vec(c.get("center"), f"{wc}.center", 2)
            r = num(c.get("radius"), f"{wc}.radius")
            if not r > 0:
                raise DesignError("the radius must be > 0", f"{wc}.radius")
            cut = {"axis": n, "plane": num(c.get("elevation", 0), f"{wc}.elevation"), "shape": "circle",
                   "ring": disc_ring(cu, cv, r)}
        elif shape == "polygon":
            pts = c.get("points")
            if not isinstance(pts, list) or len(pts) < 3:
                raise DesignError("a polygon cut needs at least 3 points", f"{wc}.points")
            cut = {"axis": AXES.index(c.get("normal", "z")), "plane": num(c.get("elevation", 0), f"{wc}.elevation"),
                   "shape": "polygon", "ring": [vec(q, f"{wc}.points[{m}]", 2) for m, q in enumerate(pts)]}
        else:
            raise DesignError(f"a cut's kind is one of {', '.join(CUT_SHAPES)}", f"{wc}.kind")
        cut["bounds"] = _ring_bounds(cut["ring"])
        cut["where"] = wc
        out.append(cut)
    return out


def sheet_axis(p: dict):
    """The flat axis of a resolved rectangular sheet (a box with zero size on one axis), else None."""
    if p["kind"] != "box":
        return None
    flat = [k for k in range(3) if abs(p["stop"][k] - p["start"][k]) < 1e-12]
    return flat[0] if len(flat) == 1 else None


def sheet_plane(p: dict):
    """``(normal axis, position)`` of a resolved flat sheet a cut can remove area from (a
    rectangular sheet, or a polygon: a drawn one, a flat circle), else ``(None, None)``."""
    if p["kind"] == "box":
        n = sheet_axis(p)
        return (n, p["start"][n]) if n is not None else (None, None)
    if p["kind"] == "polygon":
        return p["normal"], p["elevation"]
    return None, None


def on_plane(x: float, y: float) -> bool:
    return abs(x - y) <= 1e-9 * max(1.0, abs(x), abs(y))


def _ring_bounds(ring: list):
    us, vs = [q[0] for q in ring], [q[1] for q in ring]
    return min(us), min(vs), max(us), max(vs)


def expand_discs(p: dict) -> list:
    """A resolved primitive as it is built: a flat ring (a zero-length tube) becomes its two half
    rings (:func:`disc_halves`), the helper data of a flat circle is dropped, anything else stays."""
    d = p.get("disc")
    if d is None:
        return [p]
    base = {k: v for k, v in p.items() if k != "disc"}
    if d["inner_radius"] > 0:
        cu, cv = d["center"]
        return [{**base, "points": h} for h in disc_halves(cu, cv, d["radius"], d["inner_radius"], len(p["points"]))]
    return [base]


def _box_ring(p: dict, n: int) -> list:
    u, v = in_plane(n)
    return [[min(p["start"][u], p["stop"][u]), min(p["start"][v], p["stop"][v])],
            [max(p["start"][u], p["stop"][u]), min(p["start"][v], p["stop"][v])],
            [max(p["start"][u], p["stop"][u]), max(p["start"][v], p["stop"][v])],
            [min(p["start"][u], p["stop"][u]), max(p["start"][v], p["stop"][v])]]


def cut_pieces(p: dict, cuts: list) -> list:
    """What the cuts of a part leave of one resolved primitive: the primitive itself when it is not
    a flat sheet in a cut's plane, else its pieces. A rectangular sheet that only rectangles cut
    becomes the exact difference as boxes (:func:`_sheet_minus`); any other sheet (a polygon, a flat
    circle, a sheet with a round or polygonal cut) is clipped in 2D (:mod:`fairbeam.polyclip`) into
    simple polygons, since CSXCAD polygons have no holes: a hole leaves its surround as several."""
    n, level = sheet_plane(p)
    mine = [c for c in cuts if n is not None and c["axis"] == n and on_plane(c["plane"], level)]
    out = []
    for q in expand_discs(p):
        if not mine:
            out.append(q)
        elif q["kind"] == "box" and all(c["shape"] == "rect" for c in mine):
            for lo, hi in _sheet_minus(q["start"], q["stop"], [(c["a"], c["b"]) for c in mine]):
                out.append({**q, "start": lo, "stop": hi, "cut": True})
        else:
            ring = q["points"] if q["kind"] == "polygon" else _box_ring(q, n)
            rb = _ring_bounds(ring)
            tol = 1e-9 * max(1.0, *(abs(x) for x in rb))
            hit = [c for c in mine if min(rb[2], c["bounds"][2]) - max(rb[0], c["bounds"][0]) > tol
                   and min(rb[3], c["bounds"][3]) - max(rb[1], c["bounds"][1]) > tol]
            if not hit:
                out.append(q)
                continue
            try:
                rings = clip_polygons([ring], [c["ring"] for c in hit], "subtract")
            except ValueError as e:
                raise DesignError(str(e), q.get("where", "")) from None
            base = {k: v for k, v in q.items() if k not in ("start", "stop", "points")}
            out.extend({**base, "kind": "polygon", "normal": n, "elevation": level, "points": r, "cut": True}
                       for r in rings)
    return out


def apply_cuts(base: list, cuts: list) -> list:
    """Resolved primitives after the part's cuts: every flat sheet in a cut's plane replaced by its
    pieces (:func:`cut_pieces`), every flat ring by its half rings."""
    out = []
    for p in base:
        out.extend(cut_pieces(p, cuts))
    return out


def resolve_parts(d: dict, names: dict) -> list[dict]:
    """Every part with its primitives in numbers, expanded by its transforms (build order)."""
    materials = {m["name"]: m for m in d.get("materials", [])}
    out, total = [], 0
    for i, pt in enumerate(d.get("parts", [])):
        w = f"parts[{i}]"
        mt = materials[pt["material"]]
        metal = mt["kind"] == "metal"
        raws = live_primitives(pt, names, w)
        base = [resolve_primitive(pr, names, f"{w}.primitives[{j}]", 10 if metal else 0)
                for j, pr in enumerate(raws)]
        # void carvers: vacuum shapes above the part's own solids (not cut by the sheet cuts)
        solids = [p for p in base if not p.get("void")]
        voids = [p for p, pr in zip(base, raws) if p.get("void")]
        if voids:
            above = max([p["priority"] for p in solids] or [10 if metal else 0]) + 0.5
            voids = [p if "priority" in pr else {**p, "priority": above}
                     for p, pr in zip(voids, [q for q in raws if q.get("void")])]
        base = apply_cuts(solids, resolve_cuts(pt, names, w))
        maps = transform_maps(pt.get("transforms", []), names, w)
        copy = (lambda items: items) if maps == [IDENTITY] else (
            lambda items: [dict(map_primitive(p, s, t), copy=k) for k, (s, t) in enumerate(maps) for p in items])
        prims, voids = copy(base), copy(voids)
        total += len(prims) + len(voids)
        if total > MAX_PRIMITIVES:
            raise DesignError(f"the transforms expand to more than {MAX_PRIMITIVES} shapes", f"{w}.transforms")
        out.append({"index": i, "name": pt["name"], "material": mt, "metal": metal, "prims": prims,
                    "voids": voids, "copies": len(maps)})
    return out


def _group_priorities(d: dict) -> list:
    """The priorities of the grouped lumped ports' feeds (opt-in ``ports[].group.priority``,
    default 5): ranked with the parts' so a fractional void priority keeps them in order."""
    return [po["group"].get("priority", 5) for po in d.get("ports", [])
            if isinstance(po, dict) and isinstance(po.get("group"), dict)]


def priority_ranks(priorities) -> dict | None:
    """When any priority is fractional (a void carver sits at its host + 0.5), the map that ranks
    every priority, and the lumped ports' and resistors' 5, to consecutive integers (order and ties
    kept: CSXCAD priorities are integers); None when they are all whole (nothing changes)."""
    values = set(priorities)
    if all(float(v) == int(v) for v in values):
        return None
    return {v: k for k, v in enumerate(sorted(values | {5}))}


# ---------------------------------------------------------------------------- live Booleans

BOOLEAN_MAX_BOXES = 5000


def live_primitives(pt: dict, names: dict, w: str) -> list:
    """A part's primitives at these values: a live Boolean result recomputed from its operands."""
    h = pt.get("booleanHistory")
    if isinstance(h, dict) and h.get("live"):
        return boolean_primitives(h, names, f"{w}.booleanHistory")
    return pt["primitives"]


def sheet_transform_issues(d: dict, names: dict) -> list[tuple[str, str]]:
    """Return unsupported zero-thickness metal sheet transforms as (JSON path, message).

    A non-quarter rotation makes the native primitive keep its local shape and attach a CSXCAD
    matrix. Oblique sheets are not reliably represented on the axis-aligned Yee grid. The native
    ConductingSheet operator also selects its tangential direction from local bounds, so a lossy
    sheet must keep the normal axis of its original local polygon/box.
    """
    materials = {m.get("name"): m for m in d.get("materials", []) if isinstance(m, dict)}
    issues, reported = [], set()

    def rotate(normal, axis, degrees):
        angle = math.radians(degrees % 360.0)
        c, s = math.cos(angle), math.sin(angle)
        x, y, z = normal
        if axis == 0:
            return [x, c * y - s * z, s * y + c * z]
        if axis == 1:
            return [c * x + s * z, y, -s * x + c * z]
        return [c * x - s * y, s * x + c * y, z]

    for i, pt in enumerate(d.get("parts", [])):
        if not isinstance(pt, dict):
            continue
        mt = materials.get(pt.get("material"), {})
        if mt.get("kind") != "metal":
            continue
        lossy = _given(mt.get("conductivity"))
        w = f"parts[{i}]"
        try:
            raw_shapes = live_primitives(pt, names, w)
        except (DesignError, TypeError, ValueError, KeyError):
            continue  # the normal design checks report the unresolved Boolean operand
        for j, raw in enumerate(raw_shapes):
            try:
                p = resolve_primitive(raw, names, f"{w}.primitives[{j}]", 10)
            except (DesignError, TypeError, ValueError, KeyError):
                continue  # the primitive checks report its invalid dimensions
            normal_axis = sheet_axis(p) if p["kind"] == "box" else None
            if p["kind"] == "polygon":
                normal_axis = p["normal"]
            elif p["kind"] == "linpoly" and abs(p.get("length", 0.0)) < 1e-12:
                normal_axis = p["normal"]
            if normal_axis is None:
                continue
            initial = [1.0 if axis == normal_axis else 0.0 for axis in range(3)]
            # normal, native-matrix-active, last transform field that set the final orientation
            states = [(initial, False, None)]
            for k, tr in enumerate(pt.get("transforms") or []):
                if not isinstance(tr, dict):
                    continue
                typ = tr.get("type")
                if typ == "rotate":
                    axis = AXES.index(tr.get("axis")) if tr.get("axis") in AXES else -1
                    try:
                        angle = evaluate(tr.get("angle"), names)
                        count = evaluate(tr.get("copies", 0), names)
                    except (DesignError, TypeError, ValueError):
                        continue
                    if axis < 0 or count < 0 or abs(count - round(count)) > 1e-9 or count > MAX_COPIES:
                        continue
                    count = int(round(count))
                    quarter = abs(angle / 90.0 - round(angle / 90.0)) <= 1e-9
                    indices = [1] if count == 0 else range(count + 1)
                    next_states = []
                    for normal, affine, path in states:
                        for copy in indices:
                            rotated = rotate(normal, axis, angle * copy)
                            active = affine or (not quarter and copy != 0)
                            if count == 0 and not quarter:
                                active = True
                            changed = copy != 0 or count == 0
                            next_path = f"{w}.transforms[{k}].angle" if changed and (active or affine) else path
                            next_states.append((rotated, active, next_path))
                            if len(next_states) >= MAX_COPIES + 1:
                                break
                        if len(next_states) >= MAX_COPIES + 1:
                            break
                    states = next_states
                elif typ == "mirror":
                    axis = AXES.index(tr.get("plane")) if tr.get("plane") in AXES else -1
                    if axis < 0:
                        continue
                    next_states = []
                    for normal, affine, path in states:
                        if tr.get("keep") is not False:
                            next_states.append((normal, affine, path))
                        flipped = list(normal)
                        flipped[axis] = -flipped[axis]
                        next_states.append((flipped, affine, path))
                    states = next_states[:MAX_COPIES + 1]
                # move/translate and positive uniform scale do not change the plane normal or
                # whether the composition already requires a native matrix.
            for normal, affine, path in states:
                if not affine:
                    continue  # legacy signed-axis quarter turns are baked into the primitive
                norm = math.sqrt(sum(x * x for x in normal))
                if not norm or not math.isfinite(norm):
                    continue
                world_axis = max(range(3), key=lambda axis: abs(normal[axis]))
                aligned = abs(abs(normal[world_axis]) - norm) <= 1e-9 * norm
                if aligned and (not lossy or world_axis == normal_axis):
                    continue
                if aligned:
                    message = (
                        "this lossy zero-thickness metal sheet changes its local normal under the transform; "
                        "openEMS may select the wrong tangential conductivity direction. Keep the original "
                        "normal or model it as finite-thickness metal"
                    )
                else:
                    message = (
                        "this zero-thickness metal sheet is tilted relative to the Yee grid; keep its normal "
                        "axis-aligned or give it finite thickness and refine the mesh"
                    )
                path = path or f"{w}.primitives[{j}]"
                key = (path, message)
                if key not in reported:
                    reported.add(key)
                    issues.append(key)
    return issues


def require_safe_sheet_transforms(d: dict, names: dict) -> None:
    """Refuse unsupported sheet geometry at native build and generated-Python boundaries."""
    issues = sheet_transform_issues(d, names)
    if issues:
        path, message = issues[0]
        raise DesignError(message, path)


_BOOLEAN_KINDS = ("box", "polygon", "linpoly")
_BOOLEAN_KIND_NAMES = {"cylinder": "a cylinder", "sphere": "a sphere", "cone": "a cone", "torus": "a torus", "wire": "a wire",
                       "polyhedron": "a polyhedron"}


def _boolean_prims(pt: dict, names: dict, w: str, curved: bool = True) -> list:
    """An operand's (live) primitives, checked: one priority (of its solid shapes). Without ``curved``
    (the CST importer, which models such cuts as vacuum shapes of its own): bricks, sheets and polygons only."""
    name = pt.get("name", "?")
    prims = live_primitives(pt, names, w)
    if not prims:
        raise DesignError(f"{name} has no primitives", w)
    if len({p.get("priority") for p in prims if not is_void(p)}) > 1:
        raise DesignError(f"{name} has mixed primitive priorities; boolean operations require one priority per operand", w)
    if not curved:
        for j, p in enumerate(prims):
            if p.get("kind") not in _BOOLEAN_KINDS or is_void(p):
                what = _BOOLEAN_KIND_NAMES.get(p.get("kind"), p.get("kind"))
                raise DesignError(f"{name} shape {j + 1} ({what}) is unsupported: Booleans work on bricks, rectangular sheets and "
                                  "flat or extruded polygons; curved shapes (cylinders, spheres, cones, tori) and wires are not supported",
                                  f"{w}.primitives[{j}]")
    return prims


def _boolean_world(pt: dict, prims: list, names: dict, w: str) -> list:
    """An operand's primitives in world coordinates, after its cuts and transforms."""
    base = [resolve_primitive(p, names, f"{w}.primitives[{j}]", 0) for j, p in enumerate(prims)]
    base = apply_cuts(base, resolve_cuts(pt, names, w))
    world = [map_primitive(p, s_, t_) for s_, t_ in transform_maps(pt.get("transforms", []), names, w) for p in base]
    if any("_matrix" in p for p in world):
        raise DesignError("live Boolean operands must stay axis-aligned; arbitrary-angle rotations are not supported", w)
    return world


def _boolean_operand(pt: dict, prims: list, names: dict, w: str) -> dict:
    """An operand made of boxes in world coordinates: sheet or volume."""
    name = pt.get("name", "?")
    world = _boolean_world(pt, prims, names, w)
    bounds = [[(min(q["start"][k], q["stop"][k]), max(q["start"][k], q["stop"][k])) for k in range(3)] for q in world]
    if any(not math.isfinite(x) for b in bounds for pair in b for x in pair):
        raise DesignError(f"{name} has non-finite coordinates", w)
    zero = [[k for k in range(3) if b[k][0] == b[k][1]] for b in bounds]
    if any(len(z) > 1 for z in zero) or any(len(z) != len(zero[0]) for z in zero):
        raise DesignError(f"{name} mixes sheets and volumes or has a degenerate primitive", w)
    sheet = len(zero[0]) == 1
    if sheet and (any(z[0] != zero[0][0] for z in zero) or any(b[zero[0][0]][0] != bounds[0][zero[0][0]][0] for b in bounds)):
        raise DesignError(f"{name} sheets are not coplanar", w)
    return {"sheet": sheet, "bounds": bounds, "plane": zero[0][0] if sheet else None, "priority": prims[0].get("priority")}


def _boolean_cells(A: list, B: list, dims: list, mode: str) -> list:
    """booleanParts.ts partition: the grid of all box edges, the occupied cells, merged greedily."""
    axes = [sorted({x for b in A + B for x in b[d]}) for d in dims]
    counts = [len(x) - 1 for x in axes]
    cell_count = math.prod(counts)
    if cell_count > 100_000 or cell_count * (len(A) + len(B)) > 2_000_000:
        raise ValueError("Boolean partition is too large")

    def occupied(boxes, lo, hi):
        return any(all(b[d][0] <= lo[k] and b[d][1] >= hi[k] for k, d in enumerate(dims)) for b in boxes)

    cells = []
    for i in range(counts[0]):
        for j in range(counts[1]):
            for k in range(counts[2] if len(dims) == 3 else 1):
                ix = [i, j, k][:len(dims)]
                lo = [axes[n][v] for n, v in enumerate(ix)]
                hi = [axes[n][v + 1] for n, v in enumerate(ix)]
                aa, bb = occupied(A, lo, hi), occupied(B, lo, hi)
                if (aa or bb) if mode == "union" else (aa and not bb) if mode == "subtract" else (aa and bb):
                    cells.append({"lo": lo, "hi": hi})
    changed = True
    while changed:
        changed = False
        for d in range(len(dims)):
            groups: dict = {}
            for cell in cells:
                key = tuple(x for n in range(len(dims)) if n != d for x in (cell["lo"][n], cell["hi"][n]))
                groups.setdefault(key, []).append(cell)
            cells = []
            for group in groups.values():
                group.sort(key=lambda c: c["lo"][d])
                last = None
                for cell in group:
                    if last is not None and last["hi"][d] == cell["lo"][d]:
                        last["hi"][d] = cell["hi"][d]
                        changed = True
                    else:
                        cells.append(cell)
                        last = cell
    if len(cells) > BOOLEAN_MAX_BOXES:
        raise ValueError(f"Boolean result exceeds the {BOOLEAN_MAX_BOXES}-primitive limit")
    return cells


def _boolean_solids(pt: dict, prims: list, names: dict, w: str) -> list:
    """booleanParts.ts solids: each world primitive as a box (any axis) or a polygon prism."""
    name = pt.get("name", "?")
    out = []
    for q in _boolean_world(pt, prims, names, w):
        if q["kind"] == "box":
            box = [(min(q["start"][k], q["stop"][k]), max(q["start"][k], q["stop"][k])) for k in range(3)]
            if any(not math.isfinite(x) for pair in box for x in pair):
                raise DesignError(f"{name} has non-finite coordinates", w)
            zero = [k for k in range(3) if box[k][0] == box[k][1]]
            if len(zero) > 1:
                raise DesignError(f"{name} mixes sheets and volumes or has a degenerate primitive", w)
            out.append({"box": box, "axis": -1, "lo": 0.0, "hi": 0.0, "sheet_axis": zero[0] if zero else -1})
            continue
        e = q["elevation"]
        length = q["length"] if q["kind"] == "linpoly" else 0
        lo, hi = min(e, e + length), max(e, e + length)
        if not (math.isfinite(lo) and math.isfinite(hi)) or any(not math.isfinite(x) for pnt in q["points"] for x in pnt):
            raise DesignError(f"{name} has non-finite coordinates", w)
        out.append({"axis": q["normal"], "ring": [[pnt[0], pnt[1]] for pnt in q["points"]], "lo": lo, "hi": hi,
                    "sheet_axis": q["normal"] if lo == hi else -1})
    return out


def _polygon_boolean(a: dict, b: dict, pa: list, pb: list, names: dict, w: str, mode: str, op: str) -> list:
    """booleanParts.ts polygonBoolean: slabs along the common polygon axis, each clipped in 2D
    (:mod:`fairbeam.polyclip`), as extruded polygons (sheets: flat polygons)."""
    SA, SB = _boolean_solids(a, pa, names, f"{w}.A"), _boolean_solids(b, pb, names, f"{w}.B")
    return _polygon_solids((a.get("name", "?"), b.get("name", "?")), SA, SB, pa[0].get("priority"), w, mode, operation=op)


def _solid_of(name: str, q: dict, w: str) -> dict:
    """booleanParts.ts solidOf: a world design primitive as a brick or polygon prism."""
    if q["kind"] == "box":
        box = [(min(float(q["start"][k]), float(q["stop"][k])), max(float(q["start"][k]), float(q["stop"][k]))) for k in range(3)]
        zero = [k for k in range(3) if box[k][0] == box[k][1]]
        if len(zero) > 1:
            raise DesignError(f"{name} mixes sheets and volumes or has a degenerate primitive", w)
        return {"box": box, "axis": -1, "lo": 0.0, "hi": 0.0, "sheet_axis": zero[0] if zero else -1}
    if q["kind"] in ("polygon", "linpoly"):
        e = float(q["elevation"])
        length = float(q["length"]) if q["kind"] == "linpoly" else 0.0
        lo, hi = min(e, e + length), max(e, e + length)
        normal = AXES.index(q["normal"])
        return {"axis": normal, "ring": [[float(p[0]), float(p[1])] for p in q["points"]], "lo": lo, "hi": hi,
                "sheet_axis": normal if lo == hi else -1}
    raise DesignError(f"{name} mixes sheets and volumes or has a degenerate primitive", w)


def _cuts_make_polygons(pt: dict, prims: list, names: dict, w: str) -> bool:
    """booleanParts.ts cutsMakePolygons: an operand's round or polygon cuts turn its sheets into polygons (a part of
    bricks only is then clipped as polygons: the box partition cannot hold them)."""
    if not any(isinstance(c, dict) and c.get("kind", "rect") != "rect" for c in (pt.get("cuts") or [])):
        return False
    try:
        return any(q["kind"] in ("polygon", "linpoly") for q in _boolean_shapes(pt, prims, names, w))
    except (DesignError, TypeError, ValueError, KeyError):
        return False


def _needs_polygons(a: dict, b: dict, pa: list, pb: list, names: dict, w: str) -> bool:
    return (any(p.get("kind") in ("polygon", "linpoly") for p in pa + pb)
            or _cuts_make_polygons(a, pa, names, f"{w}.A") or _cuts_make_polygons(b, pb, names, f"{w}.B"))


def _rectangle_brick(ring: list, axis: int, lo: float, hi: float, priority):
    """booleanParts.ts rectangleBrick: a result ring that is an axis-aligned rectangle (four corners, nothing else)
    as a brick; None for any other ring."""
    if len(ring) != 4:
        return None
    us, vs = [p[0] for p in ring], [p[1] for p in ring]
    u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
    if not (u1 > u0 and v1 > v0):
        return None
    corners = {(0 if p[0] == u0 else 1 if p[0] == u1 else 2, 0 if p[1] == v0 else 1 if p[1] == v1 else 2) for p in ring}
    if len(corners) != 4 or any(2 in c for c in corners):
        return None
    u, v = (axis + 1) % 3, (axis + 2) % 3
    start, stop = [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
    start[axis], stop[axis] = lo, hi
    start[u], stop[u] = u0, u1
    start[v], stop[v] = v0, v1
    return {"kind": "box", **({} if priority is None else {"priority": priority}), "start": start, "stop": stop}


def _sheet_volume(op: str) -> str:
    return SHEET_VOLUME.format(op=op.capitalize())


def _polygon_solids(part_names: tuple, SA: list, SB: list, priority, w: str, mode: str, native=None, axis_hint=None, operation=None) -> list:
    """booleanParts.ts polygonSolids: the slab clipping on ready solids. ``native(ring, lo, hi, eps)`` may
    replace a result ring by the shape it came from (a cylinder whose ring the clip left untouched).
    ``axis_hint`` is the extrusion axis when the operands have no polygon to give one (bricks only: a sheet's
    normal, else z); ``operation`` words the refusals. A sheet minus a volume (Subtract, Insert) is cut with the
    volume's cross-section at the sheet's plane. A ring that is an axis-aligned rectangle comes out as a brick, when
    the operands are bricks only."""
    operation = operation or ("add" if mode == "union" else "intersect" if mode == "intersect" else "subtract")
    sheet_a, sheet_b = SA[0]["sheet_axis"] >= 0, SB[0]["sheet_axis"] >= 0
    first = next((s for s in SA + SB if s["axis"] >= 0), None)
    if sheet_a:
        axis = SA[0]["sheet_axis"]
    elif first is not None:
        axis = first["axis"]
    elif axis_hint is not None:
        axis = axis_hint
    else:
        axis = SB[0]["sheet_axis"] if sheet_b else 2
    for name, solids in ((part_names[0], SA), (part_names[1], SB)):
        other = next((s for s in solids if s["axis"] >= 0 and s["axis"] != axis), None)
        if other is not None:
            raise DesignError(f"{name} has a polygon along {AXES[other['axis']]}, the other along {AXES[axis]}: "
                              "Booleans of polygons need one common extrusion axis", w)
        if any(s["sheet_axis"] >= 0 for s in solids) and any(s["sheet_axis"] < 0 for s in solids):
            raise DesignError(f"{name} mixes sheets and volumes or has a degenerate primitive", w)
    sheet = sheet_a
    # a sheet is cut by the cross-section of a volume; a flat shape cuts nothing from a volume
    cross = sheet_a and not sheet_b and mode == "subtract"
    if sheet_a != sheet_b and not cross:
        raise DesignError(FLAT_CARVER.format(name=part_names[1], a=part_names[0]) if operation == "subtract" else _sheet_volume(operation), w)
    u, v = (axis + 1) % 3, (axis + 2) % 3

    def prism(s):
        if "box" in s:
            bx = s["box"]
            return {"ring": [[bx[u][0], bx[v][0]], [bx[u][1], bx[v][0]], [bx[u][1], bx[v][1]], [bx[u][0], bx[v][1]]],
                    "lo": bx[axis][0], "hi": bx[axis][1]}
        return {"ring": s["ring"], "lo": s["lo"], "hi": s["hi"]}

    A, B = [prism(s) for s in SA], [prism(s) for s in SB]
    eps = clip_tolerance([[p["ring"] for p in A], [p["ring"] for p in B]])
    zscale = 1.0
    for p in A + B:
        zscale = max(zscale, abs(p["lo"]), abs(p["hi"]))
    zeps = 1e-9 * zscale
    extra = {} if priority is None else {"priority": priority}
    out = []
    # bricks only: a rectangle that comes out is a brick again (with a polygon among the operands it stays a polygon)
    bricks_only = all(s["axis"] < 0 for s in SA + SB)

    def emit(ring, lo, hi, flat):
        kept = native(ring, lo, hi, eps) if native else _rectangle_brick(ring, axis, lo, hi, priority) if bricks_only else None
        if kept:
            out.append({**kept, **extra})
        elif flat:
            out.append({"kind": "polygon", "normal": AXES[axis], "elevation": lo, "points": ring, **extra})
        else:
            out.append({"kind": "linpoly", "normal": AXES[axis], "elevation": lo, "length": hi - lo, "points": ring, **extra})

    try:
        if sheet:
            if any(s["sheet_axis"] != axis for s in SA) or (not cross and any(s["sheet_axis"] != axis for s in SB)):
                raise DesignError("Boolean sheets must be coplanar and have the same orientation", w)
            plane = A[0]["lo"]
            if any(abs(p["lo"] - plane) > zeps for p in A + ([] if cross else B)):
                raise DesignError("Boolean sheets must lie in the same plane", w)
            if cross:
                B = [p for p in B if p["lo"] <= plane + zeps and p["hi"] >= plane - zeps]
            for r in clip_polygons([p["ring"] for p in A], [p["ring"] for p in B], mode, eps):
                emit(r, plane, plane, True)
        else:
            cuts: list = []
            for z in sorted(x for p in A + B for x in (p["lo"], p["hi"])):
                if not cuts or z - cuts[-1] > zeps:
                    cuts.append(z)
            slabs: list = []
            for k in range(len(cuts) - 1):
                lo, hi = cuts[k], cuts[k + 1]
                zm = (lo + hi) / 2
                ra = [p["ring"] for p in A if p["lo"] < zm and p["hi"] > zm]
                rb = [p["ring"] for p in B if p["lo"] < zm and p["hi"] > zm]
                rings = clip_polygons(ra, rb, mode, eps) if ra or mode == "union" else []
                if not rings:
                    continue
                if slabs and slabs[-1]["hi"] == lo and slabs[-1]["rings"] == rings:
                    slabs[-1]["hi"] = hi  # the same cross-section: one taller extrusion
                else:
                    slabs.append({"rings": rings, "lo": lo, "hi": hi})
            for sl in slabs:
                for r in sl["rings"]:
                    emit(r, sl["lo"], sl["hi"], False)
    except DesignError:
        raise
    except ValueError as e:
        raise DesignError(str(e), w) from None
    if len(out) > BOOLEAN_MAX_BOXES:
        raise DesignError(f"Boolean result exceeds the {BOOLEAN_MAX_BOXES}-primitive limit", w)
    return out


# ---------------------------------------------------------------------------- Subtract: the fewest shapes that stay exact

def _fewest_slabs(part_names: tuple, SA: list, SB: list, priority, w: str, operation: str) -> list:
    """booleanParts.ts fewestSlabs: A - B as extruded polygons (sheets: flat polygons, bricks where a ring is a
    rectangle), along the axis that gives the fewest: the polygons' own axis, else (bricks only) the best of z, x, y."""
    sheet = SA[0]["sheet_axis"] >= 0
    polygon = next((s for s in SA + SB if s["axis"] >= 0), None)
    axes = [SA[0]["sheet_axis"]] if sheet else [polygon["axis"]] if polygon else [2, 0, 1]
    best = None
    for axis in axes:
        out = _polygon_solids(part_names, SA, SB, priority, w, "subtract", None, axis, operation)
        if best is None or len(out) < len(best):
            best = out
    return best


def _trim_cutout(p: dict, lo: list, hi: list) -> list:
    """booleanParts.ts trimCutout: B's shapes as cut-outs of A's bounding box (a brick is trimmed to it, a shape
    beside it cuts nothing, a polygon stays as it is)."""
    plo, phi = design_bounds(p)
    if any(phi[k] <= lo[k] or plo[k] >= hi[k] for k in range(3)):
        return []
    if p["kind"] != "box":
        return [p]
    start = [max(min(float(p["start"][k]), float(p["stop"][k])), lo[k]) for k in range(3)]
    stop = [min(max(float(p["start"][k]), float(p["stop"][k])), hi[k]) for k in range(3)]
    return [{**p, "start": start, "stop": stop}]


def _compact_subtract(a: dict, b: dict, pa: list, pb: list, names: dict, w: str, operation: str, cutouts_ok: bool = True) -> list:
    """booleanParts.ts compactSubtract: Subtract (and Insert: no cut-outs) of bricks and polygons as compact as it
    stays exact: polygons along one axis (a sheet minus a volume uses the volume's cross-section), else A whole plus
    B as a vacuum cut-out; the fewest shapes win (the polygons on a tie). cutouts_ok is False for the callers
    that cannot take cut-outs (the CST importer)."""
    priority = pa[0].get("priority")
    an, bn = a.get("name", "?"), b.get("name", "?")
    SA, SB = _boolean_solids(a, pa, names, f"{w}.A"), _boolean_solids(b, pb, names, f"{w}.B")
    out = _fewest_slabs((an, bn), SA, SB, priority, w, operation)
    if operation == "subtract" and cutouts_ok and SA[0]["sheet_axis"] < 0:
        WA, WB = _boolean_shapes(a, pa, names, f"{w}.A"), _boolean_shapes(b, pb, names, f"{w}.B")
        lo, hi = _bounds_of(WA)
        cutouts = [q for p in WB for q in _trim_cutout(p, lo, hi)]
        if len(WA) + len(cutouts) < len(out):
            return _stamp(WA, priority) + [{**p, "label": f"{bn} (cut-out)", "void": True} for p in cutouts]
    if len(out) > 1:
        n = len(out)
        out = [{**p, "label": f"{an} (part {k + 1} of {n})"} for k, p in enumerate(out)]
    return out


def _folded_operand(pt: dict, prims: list, names: dict, w: str):
    """booleanParts.ts foldedOperand: an operand with cut-outs of bricks and polygons as the shapes that remain
    (its solids less its cut-outs), for the operations that cannot carry cut-outs. None when it has none or they
    are curved (the operation then says so). Returns (part, primitives)."""
    V, S = [p for p in prims if is_void(p)], [p for p in prims if not is_void(p)]
    if not V or not all(is_p(p) for p in S) or not all(is_p(p) for p in V):
        return None
    name = pt.get("name", "?")
    priority = S[0].get("priority")
    WS = _boolean_shapes(pt, S, names, w)
    flat = all(flat_axis(p) >= 0 for p in WS)
    WV = [p for p in _boolean_shapes(pt, V, names, w) if flat or flat_axis(p) < 0]
    if WV:
        left = _fewest_slabs((name, name), [_solid_of(name, p, w) for p in WS], [_solid_of(name, p, w) for p in WV], priority, w, "subtract")
    else:
        left = WS
    if not left:
        raise DesignError(f"{name} has no primitives", w)
    plain_part = {k: v for k, v in pt.items() if k not in ("transforms", "cuts", "booleanHistory")}
    plain_part["primitives"] = left
    return plain_part, left


def _boolean_shapes(pt: dict, prims: list, names: dict, w: str) -> list:
    """booleanCurved.ts worldShapes: an operand's shapes in world coordinates after its cuts and all its
    transform instances (map-major), as design primitives in numbers. Cut-outs keep ``void``; sheet cuts
    apply to solid bricks only."""
    cuts = resolve_cuts(pt, names, w)
    base = []
    for j, p in enumerate(prims):
        r = resolve_primitive(p, names, f"{w}.primitives[{j}]", 0)
        if is_void(p):
            base.append((True, r))
        else:
            base += [(False, s) for s in apply_cuts([r], cuts)]
    out = []
    for s_, t_ in transform_maps(pt.get("transforms", []), names, w):
        for hole, r in base:
            q = map_primitive(r, s_, t_)
            if "_matrix" in q:
                raise DesignError("live Boolean operands must stay axis-aligned; arbitrary-angle rotations are not supported", w)
            d = unresolve(q)
            if hole:
                d["void"] = True
            out.append(d)
    return out


def _stamp(shapes: list, priority) -> list:
    return shapes if priority is None else [p if is_void(p) else {**p, "priority": priority} for p in shapes]


def _kinds_of(shapes: list) -> str:
    seen: list = []
    for p in shapes:
        name = kind_name(p)
        if name not in seen:
            seen.append(name)
    return ", ".join(seen)


def _coaxial_pair(WA: list, WB: list):
    ra, rb = coaxial_rects(WA), coaxial_rects(WB)
    if ra is None or rb is None or ra[0] != rb[0]:
        return None
    tol = 1e-9 * max([1.0] + [abs(x) for x in ra[1] + rb[1]])
    return (ra, rb) if abs(ra[1][0] - rb[1][0]) <= tol and abs(ra[1][1] - rb[1][1]) <= tol else None


def _coaxial_boolean(pair: tuple, mode: str, priority, w: str) -> list:
    ra, rb = pair
    try:
        cells = _boolean_cells(ra[2], rb[2], [0, 1], mode)
    except ValueError as e:
        raise DesignError(str(e), w) from None
    return _stamp([cylinder_cell(ra[0], ra[1], c["lo"][0], c["hi"][0], c["lo"][1], c["hi"][1]) for c in cells], priority)


def _trimmed(R: dict, K: dict, w: str):
    """booleanParts.ts trimmed: a tube or cone clipped to a brick's extent along its axis, when the brick covers
    the whole disc across; None otherwise."""
    if K["kind"] != "box" or not (R["kind"] == "cone" or (R["kind"] == "cylinder" and "axis" in R)):
        return None
    n = AXES.index(R["axis"])
    u, v = (n + 1) % 3, (n + 2) % 3
    klo, khi = design_bounds(K)
    rmax = max(float(R["bottom_radius"]), float(R["top_radius"])) if R["kind"] == "cone" else float(R["radius"])
    c = [float(R["center"][0]), float(R["center"][1])]
    tol = 1e-9 * max(1.0, abs(c[0]), abs(c[1]), rmax)
    if klo[u] > c[0] - rmax + tol or khi[u] < c[0] + rmax - tol or klo[v] > c[1] - rmax + tol or khi[v] < c[1] + rmax - tol:
        return None
    if klo[n] == khi[n]:
        raise DesignError(_sheet_volume("intersect"), w)
    lo0, hi0 = min(float(R["range"][0]), float(R["range"][1])), max(float(R["range"][0]), float(R["range"][1]))
    lo, hi = max(lo0, klo[n]), min(hi0, khi[n])
    if not hi > lo:
        return []
    if R["kind"] == "cylinder":
        return [{**R, "range": [lo, hi]}]
    rb, rt = float(R["bottom_radius"]), float(R["top_radius"])
    slope = (rt - rb) / (hi0 - lo0)
    rb2, rt2 = max(0.0, rb + slope * (lo - lo0)), max(0.0, rt + slope * (hi - hi0))
    return [] if rb2 <= 0 and rt2 <= 0 else [{**R, "range": [lo, hi], "bottom_radius": rb2, "top_radius": rt2}]


def _faceted_intersect(a: dict, b: dict, WA: list, WB: list, priority, w: str):
    """booleanParts.ts facetedIntersect: cylinders (without a bore) and bricks or polygons along one axis,
    the cylinders clipped as 64-gon prisms; a cylinder whose ring is left untouched stays a cylinder."""
    allp = WA + WB
    cyls = [p for p in allp if p["kind"] == "cylinder"]
    if not cyls or not all((("axis" in p and not is_tube(p)) if p["kind"] == "cylinder" else is_p(p)) for p in allp):
        return None
    polygon = next((p for p in allp if p["kind"] in ("polygon", "linpoly")), None)
    axis = AXES.index(polygon["normal"]) if polygon else AXES.index(cyls[0]["axis"])
    if any(AXES.index(c["axis"]) != axis for c in cyls):
        return None
    rings: list = []

    def solid(name):
        def make(q):
            if q["kind"] != "cylinder":
                return _solid_of(name, q, w)
            centre, radius = [float(q["center"][0]), float(q["center"][1])], float(q["radius"])
            ring = facet_ring(centre, radius, FACETS)
            rings.append((ring, centre, radius))
            r0, r1 = float(q["range"][0]), float(q["range"][1])
            return {"axis": axis, "ring": ring, "lo": min(r0, r1), "hi": max(r0, r1), "sheet_axis": -1}
        return make

    an, bn = a.get("name", "?"), b.get("name", "?")
    SA, SB = [solid(an)(q) for q in WA], [solid(bn)(q) for q in WB]

    def native(ring, lo, hi, eps):
        hit = next((c for c in rings if same_ring(ring, c[0], eps)), None)
        return cylinder_cell(axis, hit[1], 0.0, hit[2], lo, hi) if hit else None

    return _polygon_solids((an, bn), SA, SB, priority, w, "intersect", native)


def _bounds_of(shapes: list) -> tuple:
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    for p in shapes:
        l, h = design_bounds(p)
        for k in range(3):
            lo[k], hi[k] = min(lo[k], l[k]), max(hi[k], h[k])
    return lo, hi


def _intersect_curved(a: dict, b: dict, WA: list, WB: list, priority, w: str) -> list:
    pair = _coaxial_pair(WA, WB)
    if pair:
        return _coaxial_boolean(pair, "intersect", priority, w)
    for R, K in ((WA, WB), (WB, WA)):   # a tube or cone trimmed by one brick across its axis
        if len(R) == 1 and len(K) == 1:
            out = _trimmed(R[0], K[0], w)
            if out is not None:
                return _stamp(out, priority)
    faceted = _faceted_intersect(a, b, WA, WB, priority, w)
    if faceted is not None:
        return faceted
    # a shape inside a brick stays as it is; shapes that cannot meet leave nothing
    (alo, ahi), (blo, bhi) = _bounds_of(WA), _bounds_of(WB)
    tol = 1e-9 * max([1.0] + [abs(x) for x in alo + ahi + blo + bhi])
    if any(min(ahi[k], bhi[k]) < max(alo[k], blo[k]) - tol for k in range(3)):
        return []

    def brick(ps):
        return len(ps) == 1 and ps[0]["kind"] == "box" and flat_axis(ps[0]) < 0

    def within(lo, hi, klo, khi):
        return all(lo[k] >= klo[k] - tol and hi[k] <= khi[k] + tol for k in range(3))

    if brick(WB) and within(alo, ahi, blo, bhi):
        return _stamp(WA, priority)
    if brick(WA) and within(blo, bhi, alo, ahi):
        return _stamp(WB, priority)
    allp = WA + WB
    if all(p["kind"] == "cylinder" for p in allp):
        why = "axes"
    elif any(p["kind"] not in ("cylinder", "cone") and not is_p(p) for p in allp) or all(not is_p(p) for p in allp):
        why = "curved"
    else:
        why = "partial"
    raise DesignError(INTERSECT_MESSAGE.format(a=a.get("name", "?"), ka=_kinds_of(WA), b=b.get("name", "?"), kb=_kinds_of(WB),
                                               why=INTERSECT_WHY[why]), w)


def _carvers(a: dict, b: dict, WA: list, WB: list, w: str) -> list:
    """booleanParts.ts carvers: B's shapes as cut-outs of A. A flat
    shape cuts nothing from a solid; what touches a sheet lies exactly on it."""
    flats = [flat_axis(p) for p in WA]
    sheet = all(n >= 0 for n in flats)
    if not sheet and any(n >= 0 for n in flats):
        raise DesignError(f"{a.get('name', '?')} mixes sheets and volumes or has a degenerate primitive", w)
    if not sheet:
        if any(flat_axis(p) >= 0 for p in WB):
            raise DesignError(FLAT_CARVER.format(name=b.get("name", "?"), a=a.get("name", "?")), w)
        return [{**p, "void": True} for p in WB]
    if any(n != flats[0] for n in flats):
        raise DesignError("Boolean sheets must be coplanar and have the same orientation", w)
    n = flats[0]

    def level(p):
        return float(p["start"][n]) if p["kind"] == "box" else float(p["elevation"])

    if any(level(p) != level(WA[0]) for p in WA):
        raise DesignError(f"{a.get('name', '?')} sheets are not coplanar", w)
    out = []
    for p in WB:
        if flat_axis(p) >= 0:
            raise DesignError(FLAT_CARVER.format(name=b.get("name", "?"), a=a.get("name", "?")), w)
        out.append({**snap_to_sheet(p, n, level(WA[0])), "void": True})
    return out


def _curved_boolean(a: dict, b: dict, pa: list, pb: list, names: dict, w: str, op: str) -> list:
    """booleanParts.ts curvedBoolean: Add concatenates the shapes (bricks and polygons united), Insert
    keeps A whole, Subtract keeps A and adds B as a cut-out, Intersect is exact where it can be."""
    SA, SB = [p for p in pa if not is_void(p)], [p for p in pb if not is_void(p)]
    VA, VB = [p for p in pa if is_void(p)], [p for p in pb if is_void(p)]
    priority = SA[0].get("priority")
    an, bn = a.get("name", "?"), b.get("name", "?")
    if op == "subtract" and VB:
        raise DesignError(B_HAS_CUT.format(name=bn), w)
    if op in ("add", "intersect") and (VA or VB):
        raise DesignError(HAS_CUT.format(name=an if VA else bn, op=op.capitalize() if op == "add" else "Intersect"), w)
    wa, wb = f"{w}.A", f"{w}.B"
    if op == "add":
        PA, PB = [p for p in SA if is_p(p)], [p for p in SB if is_p(p)]
        if PA and PB:
            if _needs_polygons(a, b, PA, PB, names, w):
                out = _polygon_boolean(a, b, PA, PB, names, w, "union", "add")
            else:
                out = _box_boolean(a, b, PA, PB, names, w, "union", "add")
        else:
            out = _stamp((_boolean_shapes(a, PA, names, wa) if PA else []) + (_boolean_shapes(b, PB, names, wb) if PB else []), priority)
        out = out + _stamp(_boolean_shapes(a, [p for p in SA if not is_p(p)], names, wa)
                           + _boolean_shapes(b, [p for p in SB if not is_p(p)], names, wb), priority)
    elif op == "insert":
        _boolean_shapes(b, SB, names, wb)   # A stays whole; B (a part of its own) is lifted above it by the designer
        out = _stamp(_boolean_shapes(a, SA, names, wa), priority) + _boolean_shapes(a, VA, names, wa)
    else:
        WA, WB = _boolean_shapes(a, SA, names, wa), _boolean_shapes(b, SB, names, wb)
        if op == "intersect":
            out = _intersect_curved(a, b, WA, WB, priority, w)
        else:
            pair = None if VA else _coaxial_pair(WA, WB)
            if pair:
                out = _coaxial_boolean(pair, "subtract", priority, w)
            else:
                out = _stamp(WA, priority) + _boolean_shapes(a, VA, names, wa) + _carvers(a, b, WA, WB, w)
    if len(out) > BOOLEAN_MAX_BOXES:
        raise DesignError(f"Boolean result exceeds the {BOOLEAN_MAX_BOXES}-primitive limit", w)
    return out


def _box_boolean(a: dict, b: dict, pa: list, pb: list, names: dict, w: str, mode: str, op: str) -> list:
    """The exact box partition of two operands made of bricks (sheets or volumes)."""
    A, B = _boolean_operand(a, pa, names, f"{w}.A"), _boolean_operand(b, pb, names, f"{w}.B")
    if A["sheet"] != B["sheet"]:
        raise DesignError(_sheet_volume(op), w)
    if A["sheet"] and (A["plane"] != B["plane"] or A["bounds"][0][A["plane"]][0] != B["bounds"][0][B["plane"]][0]):
        raise DesignError("Boolean sheets must lie in the same plane", w)
    dims = [k for k in range(3) if k != A["plane"]] if A["sheet"] else [0, 1, 2]
    try:
        cells = _boolean_cells(A["bounds"], B["bounds"], dims, mode)
    except ValueError as e:
        raise DesignError(str(e), w) from None
    out = []
    for cell in cells:
        lo, hi = [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
        if A["sheet"]:
            lo[A["plane"]] = hi[A["plane"]] = A["bounds"][0][A["plane"]][0]
        for k, d in enumerate(dims):
            lo[d], hi[d] = cell["lo"][k], cell["hi"][k]
        prim = {"kind": "box", "start": lo, "stop": hi}
        if A["priority"] is not None:
            prim["priority"] = A["priority"]
        out.append(prim)
    return out


def boolean_primitives(h: dict, names: dict, w: str, curved: bool = True) -> list:
    """The result primitives of a Boolean (``booleanHistory``) at these values, in world coordinates:
    exactly what the designer's materialiseBoolean gives (boxes for parts of boxes, extruded or flat
    polygons when a polygon is involved, and with curved shapes or an earlier cut-out the shapes of
    :func:`_curved_boolean`). ``curved=False`` refuses curved shapes and cut-outs, as before (the CST
    importer models such cuts as vacuum shapes of its own)."""
    op, a, b = h.get("operation"), h.get("A"), h.get("B")
    if op not in ("add", "subtract", "intersect", "insert") or not isinstance(a, dict) or not isinstance(b, dict):
        raise DesignError("a Boolean history needs an operation and the operands A and B", w)
    if op in ("add", "intersect") and a.get("material") != b.get("material"):
        raise DesignError("add and intersect require parts with the same material", w)
    pa, pb = _boolean_prims(a, names, f"{w}.A", curved), _boolean_prims(b, names, f"{w}.B", curved)
    sa, sb = [p for p in pa if not is_void(p)], [p for p in pb if not is_void(p)]
    if op in ("add", "intersect") and sa[0].get("priority") != sb[0].get("priority"):
        raise DesignError("add and intersect require parts with the same priority", w)
    mode = "union" if op == "add" else "intersect" if op == "intersect" else "subtract"
    # cut-outs of bricks and polygons (an earlier Subtract) are folded in first, where the operation cannot carry them:
    # Subtract keeps A's own cut-outs, every other operand and operation takes the shapes that remain
    if op != "subtract":
        folded = _folded_operand(a, pa, names, f"{w}.A")
        if folded:
            a, pa = folded
    folded = _folded_operand(b, pb, names, f"{w}.B")
    if folded:
        b, pb = folded
    if not all(is_p(p) and not is_void(p) for p in pa + pb):
        out = _curved_boolean(a, b, pa, pb, names, w, op)
    elif op in ("subtract", "insert"):
        out = _compact_subtract(a, b, pa, pb, names, w, op, curved)   # curved=False (the CST importer): no cut-outs
    elif _needs_polygons(a, b, pa, pb, names, w):
        out = _polygon_boolean(a, b, pa, pb, names, w, mode, op)
    else:
        out = _box_boolean(a, b, pa, pb, names, w, mode, op)
    if not out:
        raise DesignError("the Boolean result is empty at these values", w)
    return out


# ---------------------------------------------------------------------------- timestep budget

#: a run is never given fewer timesteps than this (the long-standing default limit)
AUTO_MIN_TIMESTEPS = 60000
#: the automatic limit covers the excitation pulse and this many pulse lengths in all (the pulse plus
#: its decay); a resonant antenna rings for a few pulse lengths at most before -50 dB
AUTO_PULSES = 4
#: the real openEMS timestep was 0.79 to 0.96 of the Courant estimate (3.86e-13 s against 4.04e-13 s
#: predicted on the fixed design; 3.08e-14 s against 3.88e-14 s on the broken one), so every
#: prediction assumes this fraction of the analytic timestep
DT_SAFETY = 0.8
#: cells x timesteps a run may need before Run is blocked: about 20 minutes on a CPU at 250 MCells/s
RUN_BUDGET_CELL_STEPS = 2.0e11
#: ... and only when the pulse alone takes this fraction of the long-standing 60000 limit: a big mesh
#: whose pulse fits comfortably (a 3.5 M cell collinear array, 37000 steps) is slow but fine, while a mesh
#: whose pulse leaves no room for the decay in 60000 is the failure this budget exists for
BLOCK_PULSE_FRACTION = 0.75
#: the limit an automatic run is allowed when nothing says it must stop earlier: cells x timesteps up to this
#: (about 7 minutes on a CPU at 250 MCells/s). The end criterion stops a converging run long before; the high
#: limit only costs time on runs that would otherwise be cut off while a thin, high-Q cavity is still ringing
#: (a 0.254 mm RT5880 patch needs 3 to 4 times the old 60000)
AUTO_BUDGET_CELL_STEPS = 1.0e11
#: ... and never more than this many timesteps, whatever the mesh
AUTO_MAX_TIMESTEPS = 600000


def auto_timesteps(dt_s: float, f_max_hz: float, nodes: float) -> dict:
    """The automatic max timesteps for a mesh: room for the excitation pulse plus its decay.

    ``dt_s`` is the analytic Courant timestep of the mesh, ``nodes`` the line product (openEMS's "FDTD
    cells"). Returns ``steps`` (the limit to use: at least :data:`AUTO_MIN_TIMESTEPS`, the pulse
    and its decay rounded up to ten thousand, or what :data:`AUTO_BUDGET_CELL_STEPS` allows on this many cells,
    whichever is most; at most :data:`AUTO_MAX_TIMESTEPS` unless the pulse needs more), ``pulse_steps`` (the pulse alone, at the safe timestep),
    ``needed`` (what the pulse plus decay takes), ``work`` (cells x needed timesteps, the run's cost) and
    ``over_budget`` (the cost is more than :data:`RUN_BUDGET_CELL_STEPS` and the pulse alone takes more than
    :data:`BLOCK_PULSE_FRACTION` of :data:`AUTO_MIN_TIMESTEPS`)."""
    from .excitation import dgauss_duration_s

    dt = dt_s * DT_SAFETY
    pulse = dgauss_duration_s(f_max_hz) / dt
    needed = AUTO_PULSES * pulse
    budget = int(min(AUTO_MAX_TIMESTEPS, AUTO_BUDGET_CELL_STEPS / max(float(nodes), 1.0)) // 10000) * 10000
    steps = max(AUTO_MIN_TIMESTEPS, int(math.ceil(needed / 10000.0)) * 10000, budget)
    work = float(nodes) * needed
    return {"steps": steps, "pulse_steps": pulse, "needed": needed, "work": work,
            "over_budget": work > RUN_BUDGET_CELL_STEPS and pulse > BLOCK_PULSE_FRACTION * AUTO_MIN_TIMESTEPS,
            "dt_s": dt}


#: Q of the dominant mode of a patch-like cavity, fitted to what the solver needed (a 0.254 mm RT5880 patch rang for
#: 52 ns, Q about 67; 1.6 mm FR-4 about 10): Q_rad = RINGDOWN_K εr² / ((εr - 1) h/λ0), 1/Q = 1/Q_rad + RINGDOWN_LOSS tan δ
#: (the port and the box add loading on top of the substrate's own loss; 1.5 matches 1.6 mm and 0.3 mm FR-4 at Q 11 and 24)
RINGDOWN_K = 0.037
RINGDOWN_LOSS = 1.5


def ringdown_steps(eps_r: float, tan_d: float, h_mm: float, f_hz: float, dt_s: float, end_db: float,
                   f_max_hz: float | None = None) -> dict | None:
    """Timesteps a thin dielectric plate of thickness ``h_mm`` (between metal, like a patch's substrate) needs for its
    fields to decay by ``end_db`` dB after the excitation pulse, from the Q of the cavity (radiation, which grows
    as the plate gets thin, and dielectric loss). ``dt_s`` is the real timestep (:data:`DT_SAFETY` applied). Returns
    ``q``, ``seconds`` (ring-down), ``steps`` (pulse plus ring-down), or None when the plate is not thin
    (h/λ0 above 0.03) or the values do not allow an estimate."""
    from .excitation import dgauss_duration_s

    if not (eps_r > 1 and h_mm > 0 and f_hz > 0 and dt_s > 0 and end_db > 0):
        return None
    ratio = h_mm * 1e-3 * f_hz / (C0)
    if ratio > 0.03:
        return None
    q_rad = RINGDOWN_K * eps_r ** 2 / ((eps_r - 1) * ratio)
    q = 1.0 / (1.0 / q_rad + RINGDOWN_LOSS * max(tan_d, 0.0))
    seconds = q / (2 * math.pi * f_hz) * math.log(10) * end_db / 10
    pulse = dgauss_duration_s(f_max_hz or f_hz * 1.4)
    return {"q": q, "seconds": seconds, "steps": (pulse + seconds) / dt_s}


# ---------------------------------------------------------------------------- thin metal

THIN_METAL_FRACTION = 10     # metal thinner than 1/10 of the finest target cell becomes a sheet
THIN_METAL_ASPECT = 0.25     # ... and only a plate: thinner than 1/4 of its next size
#: ``mesh.thin_metal`` "volume" keeps a plate's thickness only while that costs at most about 5x in timestep: the mesh puts
#: three cells across the metal, so a plate thinner than 0.6 of the finest target cell (6x the sheet limit) would make cells
#: more than 5x finer than the design needs (35 µm copper: 50x to 60x, a run of 20 minutes that never converges). Thinner
#: plates are meshed as sheets; losses still use the thickness.
VOLUME_COST_FACTOR = 6


def thin_metal_limit(d: dict, names: dict, force: bool = False) -> float | None:
    """Metal bricks thinner than this (mm) along one axis are built as sheets: a tenth of the finest
    cell the automatic mesh aims for, λ at f max over cells per wavelength in the medium
    with the largest εr μr product among the materials the parts use. With ``mesh.thin_metal`` "volume" the limit is
    :data:`VOLUME_COST_FACTOR` times larger (only a plate thick enough to cost little in timestep keeps its thickness)
    unless ``force``: the limit of the default "sheet" setting, for the checks that say what "volume" costs. None when the values do not resolve."""
    m = d.get("mesh") or {}
    factor = VOLUME_COST_FACTOR if m.get("thin_metal", "sheet") == "volume" and not force else 1
    num, _ = _evaluator(names)
    try:
        f_max = num(d.get("simulation", {}).get("f_max", 3), "simulation.f_max") * 1e9
        density = m.get("overrides", {}) if m.get("mode") == "design" else m
        cpw = num(density.get("cells_per_wavelength", 20), "mesh.cells_per_wavelength")
        used = {pt.get("material") for pt in d.get("parts", [])}
        wavelength_factors = [
            num(mt.get("eps_r", 1), f"materials.{mt['name']}.eps_r")
            * num(mt.get("mu_r", 1), f"materials.{mt['name']}.mu_r")
            for mt in d.get("materials", [])
            if mt.get("kind") != "metal" and mt.get("name") in used
        ]
    except (DesignError, TypeError, ValueError, KeyError):
        return None
    if not (f_max > 0 and cpw > 0):
        return None
    return C0 / f_max * 1e3 / cpw / math.sqrt(max([1.0, *(f for f in wavelength_factors if f > 0)])) / THIN_METAL_FRACTION * factor


def thin_sheets(parts: list[dict], limit: float | None) -> list[dict]:
    """The metal bricks of resolved ``parts`` thinner than ``limit`` along one axis, and the sheet
    each becomes: ``part`` / ``prim`` (indices into ``parts`` and its ``prims``), ``axis``, ``at``
    (the sheet's plane), ``thickness``, ``side`` ("min", "max" or "middle") and the drawn corners
    ``lo`` / ``hi``.

    The sheet goes where the mesh has a line anyway: on a face that coincides with a dielectric's
    face (a patch on the substrate's top, a ground under it), else on a face that touches a
    dielectric, else in the middle."""
    if not limit:
        return []
    diel = [(q, prim_bbox(q)) for part in parts if not part["metal"] for q in part["prims"]]
    scale = max([1.0] + [abs(x) for _q, (lo, hi) in diel for x in lo + hi])
    tol = 1e-9 * scale
    out = []
    for i, part in enumerate(parts):
        if not part["metal"]:
            continue
        for j, p in enumerate(part["prims"]):
            if "_matrix" in p:
                continue
            if p["kind"] == "linpoly":
                # printed copper drawn as an extruded outline (a ground plane, a patch with rounded corners):
                # a plate along its normal. Parts with transforms keep their volume (copies would need the
                # export to follow the same rule).
                if part["copies"] != 1 or not 1e-12 < abs(p["length"]) < limit:
                    continue
            elif p["kind"] != "box":
                continue
            lo, hi = prim_bbox(p)
            size = [hi[k] - lo[k] for k in range(3)]
            n, next_axis = sorted(range(3), key=lambda k: size[k])[:2]
            if p["kind"] == "linpoly":
                n = AXES.index(p["normal"]) if isinstance(p["normal"], str) else p["normal"]
                next_axis = min((k for k in range(3) if k != n), key=lambda k: size[k])
            t = size[n]
            if not (1e-12 < t < limit and t <= THIN_METAL_ASPECT * size[next_axis]):
                continue
            u, v = in_plane(n)
            centre = [(lo[k] + hi[k]) / 2 for k in range(3)]

            def score(z, outside):
                if any(all(b[0][a] < hi[a] - tol and b[1][a] > lo[a] + tol for a in (u, v))
                       and (abs(b[0][n] - z) <= tol or abs(b[1][n] - z) <= tol) for _q, b in diel):
                    return 2
                q = list(centre)
                q[n] = outside
                return 1 if any(prim_contains(dq, q, 0.0) for dq, _b in diel) else 0

            s_lo, s_hi = score(lo[n], lo[n] - t / 2), score(hi[n], hi[n] + t / 2)
            if max(s_lo, s_hi) == 0:
                at, side = centre[n], "middle"
            elif s_lo >= s_hi:
                at, side = lo[n], "min"
            else:
                at, side = hi[n], "max"
            out.append({"part": i, "prim": j, "axis": n, "at": at, "thickness": t, "side": side,
                        "lo": lo, "hi": hi, "where": p.get("where")})
    return out


def as_sheet(p: dict, sheet: dict) -> dict:
    """Brick ``p`` flattened onto the plane of its ``sheet`` (from :func:`thin_sheets`)."""
    n = sheet["axis"]
    if p["kind"] == "linpoly":
        return {k: v for k, v in p.items() if k != "length"} | {"kind": "polygon", "elevation": sheet["at"]}
    a, b = list(p["start"]), list(p["stop"])
    a[n] = b[n] = sheet["at"]
    return {**p, "start": a, "stop": b}


def snap_to_sheets(a: list, c: list, k: int, sheets: list[dict]) -> tuple[list, list]:
    """Port or resistor ends ``a``, ``c`` (along axis ``k``) moved onto the sheets whose drawn
    thickness they lie in: a probe drawn from the bottom of a 35 µm ground to the top of a 35 µm
    patch then spans the substrate between the two sheets. Unchanged when that would leave no
    length along ``k``."""
    tol = 1e-9 * max([1.0] + [abs(x) for x in a + c])
    mid = [(a[q] + c[q]) / 2 for q in range(3)]
    ends = [list(a), list(c)]
    for e in ends:
        q = list(mid)
        q[k] = e[k]
        for sh in sheets:
            n, lo, hi = sh["axis"], sh["lo"], sh["hi"]
            if lo[n] - tol <= e[n] <= hi[n] + tol and all(lo[m] - tol <= q[m] <= hi[m] + tol for m in in_plane(n)):
                e[n] = sh["at"]
                break
    if abs(ends[1][k] - ends[0][k]) < 1e-12:
        return list(a), list(c)
    return ends[0], ends[1]


# ---------------------------------------------------------------------------- build

def _given(v) -> bool:
    return v is not None and not (isinstance(v, str) and not v.strip())


def metal_loss(mt: dict, num) -> tuple[float | None, float | None]:
    """A metal material's ``conductivity`` (S/m) and sheet ``thickness`` (mm), each None when not
    given: no conductivity is a perfect conductor (PEC), no thickness the default sheet thickness
    (simulation.SHEET_THICKNESS_MM). ``num`` evaluates an expression field."""
    w = f"materials.{mt['name']}"
    if not _given(mt.get("conductivity")):
        return None, None   # PEC: a thickness means nothing
    sigma = num(mt["conductivity"], f"{w}.conductivity")
    if not sigma > 0:
        raise DesignError("the conductivity must be > 0 S/m (leave it empty for a perfect conductor)", f"{w}.conductivity")
    thick = num(mt["thickness"], f"{w}.thickness") if _given(mt.get("thickness")) else None
    if thick is not None and not thick > 0:
        raise DesignError("the sheet thickness must be > 0 mm", f"{w}.thickness")
    return sigma, thick


def build(d: dict, values: dict):
    """A configured :class:`fairbeam.Simulation` from a design and resolved parameter values."""
    import numpy as np

    from .simulation import LossyMetal, Simulation

    check_design(d)
    names = resolve_names(d, values)
    require_safe_sheet_transforms(d, names)
    num, vec = _evaluator(names)

    s = d.get("simulation", {})
    f_min, f_max = num(s.get("f_min", 1), "simulation.f_min") * 1e9, num(s.get("f_max", 3), "simulation.f_max") * 1e9
    if not 0 < f_min < f_max:
        raise DesignError("need 0 < f_min < f_max", "simulation.f_max")
    b = s.get("boundaries", "MUR")
    sim = Simulation(f_min, f_max, boundaries=[b] * 6 if isinstance(b, str) else list(b),
                     end_criteria_db=float(s.get("end_criteria_db", -60)),
                     max_timesteps=60000 if s.get("max_timesteps") in (None, "auto") else int(s["max_timesteps"]))

    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)

    def grow(*pts):
        for p in pts:
            lo[:] = np.minimum(lo, p)
            hi[:] = np.maximum(hi, p)

    parts = resolve_parts(d, names)
    if d.get("mesh", {}).get("thin_metal", "sheet") not in ("sheet", "volume"):
        raise DesignError('thin_metal is "sheet" (thin metal built as sheets) or "volume"', "mesh.thin_metal")
    thin_limit = thin_metal_limit(d, names)
    ranks = priority_ranks([p["priority"] for part in parts for p in part["prims"] + part["voids"]]
                           + _group_priorities(d))
    if ranks:
        for part in parts:
            part["prims"] = [{**p, "priority": ranks[p["priority"]]} for p in part["prims"]]
            part["voids"] = [{**p, "priority": ranks[p["priority"]]} for p in part["voids"]]
    port_priority = ranks[5] if ranks else 5
    sheets = thin_sheets(parts, thin_limit)
    flat = {(sh["part"], sh["prim"]): sh for sh in sheets}
    for i, (part, pt) in enumerate(zip(parts, d.get("parts", []))):
        mt = part["material"]
        label, color = pt.get("label"), pt.get("color") or mt.get("color")
        if part["metal"]:
            sigma, thick = metal_loss(mt, num)
            prop = sim.metal(pt["name"], label=label, color=color, conductivity=sigma, thickness=thick)
            if isinstance(prop, LossyMetal):
                prop.sheet_limit = thin_limit
        else:
            tan_f = mt.get("tan_d_freq")
            prop = sim.dielectric(pt["name"], num(mt.get("eps_r", 1), f"materials.{mt['name']}.eps_r"),
                                  tan_d=num(mt.get("tan_d", 0), f"materials.{mt['name']}.tan_d"),
                                  tan_d_freq=None if tan_f is None else num(tan_f, f"materials.{mt['name']}.tan_d_freq") * 1e9,
                                  label=label, color=color,
                                  mu_r=num(mt.get("mu_r", 1), f"materials.{mt['name']}.mu_r"))
        for j, p in enumerate(part["prims"]):
            sh = flat.get((i, j))
            if sh:
                p = as_sheet(p, sh)
                sim.thin_sheets.append({"part": pt["name"], "axis": sh["axis"], "at": sh["at"], "side": sh["side"],
                                        "thickness": sh["thickness"], "start": p.get("start"), "stop": p.get("stop"),
                                        "drawn": [sh["lo"], sh["hi"]]})
            if isinstance(prop, LossyMetal):
                prop.drawn_thickness = sh["thickness"] if sh else None   # a thin brick keeps its own
            add_primitive(prop, p)
            grow(*prim_bbox(p))
        if part["voids"]:
            # the part's carvers: vacuum above its own shapes (added after them)
            vacuum = sim.dielectric(f"{pt['name']} (cut)", 1.0, tan_d=0.0, label=label, color=color, mu_r=1.0, void=True)
            for p in part["voids"]:
                add_primitive(vacuum, p)
                grow(*prim_bbox(p))

    for i, po in enumerate(d.get("ports", [])):
        w = f"ports[{i}]"
        a, c = vec(po.get("start"), f"{w}.start"), vec(po.get("stop"), f"{w}.stop")
        if po.get("type") != "waveguide":
            a, c = snap_to_sheets(a, c, AXES.index(po["direction"]), sheets)
        if po.get("type") == "waveguide":
            m, n = wg_mode(po.get("mode", "TE10"), f"{w}.mode")
            wa, wb = num(po.get("a"), f"{w}.a"), num(po.get("b"), f"{w}.b")
            if wa <= 0 or wb <= 0:
                raise DesignError("the waveguide width and height must be > 0", f"{w}.{'a' if wa <= 0 else 'b'}")
            k = AXES.index(po["direction"])
            if po.get("excite", True) and abs(c[k] - a[k]) < 1e-12:
                raise DesignError("an excited waveguide port needs a length along its direction (the probes sit at stop)", f"{w}.stop[{k}]")
            sim.waveguide_port(po["number"], a, c, po["direction"], wa, wb, f"TE{m}{n}", excite=bool(po.get("excite", True)))
        else:
            group, priority = None, port_priority
            if "group" in po:
                members = []
                for wm, member in list(port_feeds(po, w))[1:]:
                    ma, mc = snap_to_sheets(vec(member["start"], f"{wm}.start"), vec(member["stop"], f"{wm}.stop"),
                                           AXES.index(member["direction"]), sheets)
                    members.append({"start": ma, "stop": mc, "direction": member["direction"],
                                    "polarity": member.get("polarity", 1)})
                    grow(ma, mc)
                # a group's own priority is ranked with the parts' like the ordinary ports' 5
                priority = po["group"].get("priority", 5)
                priority = ranks[priority] if ranks else priority
                group = {**po["group"], "members": members, "priority": priority}
            sim.lumped_port(po["number"], num(po.get("R", 50), f"{w}.R"), a, c, po["direction"],
                            excite=bool(po.get("excite", True)), group=group, priority=priority,
                            reference_impedance={key: num(value, f"{w}.reference_impedance.{key}")
                                                 for key, value in po["reference_impedance"].items()}
                            if "reference_impedance" in po else None)
        grow(a, c)
    for i, r in enumerate(d.get("resistors", [])):
        w = f"resistors[{i}]"
        a, c = snap_to_sheets(vec(r.get("start"), f"{w}.start"), vec(r.get("stop"), f"{w}.stop"),
                              AXES.index(r["direction"]), sheets)
        sim.lumped_element(r.get("name") or f"R{i + 1}", a, c, r["direction"],
                           **{key: num(r[key], f"{w}.{key}") for key in ("R", "L", "C") if key in r},
                           topology=r.get("topology", "parallel"),
                            label=r.get("label"), **({"priority": port_priority} if ranks else {}))
        grow(a, c)
    if not np.all(np.isfinite(lo)):
        raise DesignError("the design has no geometry yet", "parts")

    m = d.get("mesh", {})
    mode = m.get("mode", "auto")
    if mode not in ("auto", "design", "manual"):
        raise DesignError('mesh.mode must be "auto", "design" or "manual"', "mesh.mode")
    manual_lines = None
    if mode == "manual":
        raw = m.get("lines")
        if not isinstance(raw, dict):
            raise DesignError("lines must be an object with x, y and z arrays", "mesh.lines")
        manual_lines = []
        for ax, name in enumerate(AXES):
            vals = raw.get(name)
            if not isinstance(vals, list) or len(vals) < 2:
                raise DesignError("at least two lines are required", f"mesh.lines.{name}")
            resolved = [num(v, f"mesh.lines.{name}[{i}]") for i, v in enumerate(vals)]
            if any(b <= a for a, b in zip(resolved, resolved[1:])):
                raise DesignError("lines must be strictly increasing in input order", f"mesh.lines.{name}")
            if resolved[0] > lo[ax] + 1e-6 or resolved[-1] < hi[ax] - 1e-6:
                raise DesignError("mesh lines must enclose all resolved geometry", f"mesh.lines.{name}")
            manual_lines.append(resolved)
        for i, po in enumerate(d.get("ports", [])):
            for w, member in port_feeds(po, f"ports[{i}]"):
                a, c = vec(member.get("start"), f"{w}.start"), vec(member.get("stop"), f"{w}.stop")
                if po.get("type") != "waveguide":
                    a, c = snap_to_sheets(a, c, AXES.index(member["direction"]), sheets)
                for label, point in (("start", a), ("stop", c)):
                    for ax, name in enumerate(AXES):
                        if min(abs(v - point[ax]) for v in manual_lines[ax]) > 1e-6:
                            raise DesignError("port coordinate must lie on a mesh line (within 1e-6 mm)",
                                              f"{w}.{label}[{ax}]")
        for ax, lines in enumerate(manual_lines):
            sim.mesh.AddLine(AXES[ax], lines)
        cells = [len(x) - 1 for x in manual_lines]
        widths = [[b-a for a, b in zip(x, x[1:])] for x in manual_lines]
        dmin = [min(x) for x in widths]
        import numpy as np
        dt = sim.unit / (C0 * np.sqrt(sum(1 / x**2 for x in dmin)))
        # the exact lines (the bundle rounds its mesh arrays for size): a CST export can carry them
        sim.mesh_report = {"settings": {"mode": "manual", "lines": {AXES[a]: [round(v, 6) for v in x] for a, x in enumerate(manual_lines)}},
                           "cells": cells,
                           "total_cells": int(np.prod(cells)), "min_cell": min(dmin),
                           "max_cell": max(max(x) for x in widths), "warnings": [],
                           "timestep_s": float(dt), "timesteps_per_ns": 1e-9 / float(dt),
                           "memory_mb_estimate": int(np.prod(cells)) * 90 / 1e6,
                           "max_neighbour_ratio": max(max((max(a/b,b/a) for a,b in zip(x,x[1:])), default=1) for x in widths)}
        sim.set_focus(lo.tolist(), hi.tolist())
    if mode == "design":
        overrides = m.get("overrides", {})
        allowed = {"cells_per_wavelength", "edge_rule", "air_cells_per_wavelength", "max_ratio", "pad", "dielectric_cells"}
        if not isinstance(overrides, dict):
            raise DesignError("overrides must be an object", "mesh.overrides")
        unknown = set(overrides) - allowed
        if unknown:
            key = sorted(unknown)[0]
            raise DesignError("unknown mesh override", f"mesh.overrides.{key}")
        density = sum(len(p["prims"]) for p in parts)
        thin_sheet = bool(sheets)
        has_dielectric = any(not p["metal"] for p in parts)
        cpw = 30 if thin_sheet and density >= 3 else 24
        air = max(8, min(cpw, round(cpw / (1 + max(0, density - 1) / 8))))
        pad = (C0 / f_min / sim.unit) * (0.25 if d.get("far_field", {}).get("enabled", True) else 0.125)
        chosen = {"cells_per_wavelength": cpw, "edge_rule": "edge" if thin_sheet else "thirds",
                  "air_cells_per_wavelength": air, "max_ratio": 1.4, "pad": pad,
                  "dielectric_cells": 5 if has_dielectric else 4}
        notes = {
            "cells_per_wavelength": f"{cpw} cells/λ at f max: {density} primitives" + (" including thin metal sheets" if thin_sheet else ""),
            "edge_rule": "Exact edges for thin patterned metal" if thin_sheet else "Thirds placement for this geometry without thin converted sheets",
            "air_cells_per_wavelength": f"{air} cells/λ in air from {cpw} feature cells/λ and {density} primitives",
            "max_ratio": "1.4 limits growth between neighbouring cells",
            "pad": ("λ/4 at f min gives the NF2FF box clearance from the radiator and boundary" if d.get("far_field", {}).get("enabled", True)
                    else "λ/8 at f min; no far-field box is requested"),
            "dielectric_cells": ("At least five cells across dielectric thickness" if has_dielectric
                                 else "No dielectric; this minimum is unused"),
        }
        for key, value in overrides.items():
            if key == "edge_rule":
                if value not in ("edge", "thirds"):
                    raise DesignError('edge_rule must be "thirds" or "edge"', f"mesh.overrides.{key}")
            elif key == "dielectric_cells":
                value = num(value, f"mesh.overrides.{key}")
                if not value.is_integer() or not 1 <= value <= 20:
                    raise DesignError("must be an integer from 1 to 20", f"mesh.overrides.{key}")
                value = int(value)
            else:
                value = num(value, f"mesh.overrides.{key}")
                if key in ("cells_per_wavelength", "air_cells_per_wavelength") and value <= 0:
                    raise DesignError("must be > 0", f"mesh.overrides.{key}")
                if key == "max_ratio" and value <= 1:
                    raise DesignError("must be > 1", f"mesh.overrides.{key}")
                if key == "pad" and value < 0:
                    raise DesignError("must be >= 0", f"mesh.overrides.{key}")
            chosen[key] = value
            notes[key] = f"Manual override: {value}"
        if "air_cells_per_wavelength" not in overrides:
            air = min(chosen["cells_per_wavelength"], max(8, round(
                chosen["cells_per_wavelength"] / (1 + max(0, density - 1) / 8))))
            chosen["air_cells_per_wavelength"] = air
            notes["air_cells_per_wavelength"] = (f"{air} cells/λ in air from "
                f"{chosen['cells_per_wavelength']} feature cells/λ and {density} primitives")
        if chosen["air_cells_per_wavelength"] > chosen["cells_per_wavelength"]:
            raise DesignError("must be <= cells_per_wavelength", "mesh.overrides.air_cells_per_wavelength")
        kw = chosen
    elif mode == "auto":
        kw = {"cells_per_wavelength": num(m.get("cells_per_wavelength", 20), "mesh.cells_per_wavelength")}
    if mode != "manual" and kw["cells_per_wavelength"] <= 0:
        raise DesignError("cells per wavelength must be > 0", "mesh.cells_per_wavelength")
    if mode == "auto" and m.get("pad") is not None:
        kw["pad"] = num(m["pad"], "mesh.pad")
        if kw["pad"] < 0:
            raise DesignError("pad must be >= 0", "mesh.pad")
    if mode == "auto" and "edge_rule" in m:
        if m["edge_rule"] not in ("thirds", "edge"):
            raise DesignError('edge_rule must be "thirds" or "edge"', "mesh.edge_rule")
        kw["edge_rule"] = m["edge_rule"]
    if mode == "auto" and "max_ratio" in m:
        kw["max_ratio"] = num(m["max_ratio"], "mesh.max_ratio")
        if kw["max_ratio"] <= 1:
            raise DesignError("max_ratio must be > 1", "mesh.max_ratio")
    if mode == "auto" and m.get("air_cells_per_wavelength") is not None:
        kw["air_cells_per_wavelength"] = num(m["air_cells_per_wavelength"], "mesh.air_cells_per_wavelength")
        if not 0 < kw["air_cells_per_wavelength"] <= kw["cells_per_wavelength"]:
            raise DesignError("air cells per wavelength must be > 0 and <= cells per wavelength",
                              "mesh.air_cells_per_wavelength")
    if mode != "manual":
        kw["refine_features"] = m.get("refine_features", False)
        sim.auto_mesh(**kw)
    if mode == "design":
        report = getattr(sim, "mesh_report", None)
        if report is not None:
            report["settings"]["mode"] = "design"
            report["notes"] = notes
    sim.set_focus(lo.tolist(), hi.tolist())
    report = getattr(sim, "mesh_report", None)
    if s.get("max_timesteps") in (None, "auto") and report and report.get("timestep_s"):
        # no limit was chosen: cover the excitation pulse and its decay (it was a fixed 60000, which a
        # mesh with tiny cells spent on the pulse alone)
        nodes = float(np.prod([len(sim.mesh.GetLines(a)) for a in "xyz"]))
        auto = auto_timesteps(report["timestep_s"], f_max, nodes)
        sim.max_timesteps = auto["steps"]
        sim.fdtd.SetNumberOfTimeSteps(auto["steps"])
        sim.auto_timesteps = auto

    ff = d.get("far_field", {"enabled": True})
    if ff.get("enabled", True):
        faces = ff.get("faces")
        if faces is not None and (not isinstance(faces, list) or len(faces) != 6 or not any(faces)):
            raise DesignError("faces is 6 true/false flags (x-, x+, y-, y+, z-, z+), at least one true", "far_field.faces")
        skip = {"directions": [bool(v) for v in faces]} if faces is not None and not all(faces) else {}
        if ff.get("phase_center") is not None:
            sim.add_nf2ff_box(center=vec(ff["phase_center"], "far_field.phase_center"), **skip)
        else:
            sim.add_nf2ff_box(**skip)
        if ff.get("frequencies"):
            sim.pattern_freqs = [num(f, f"far_field.frequencies[{k}]") * 1e9 for k, f in enumerate(ff["frequencies"])]
    cur = (d.get("monitors") or {}).get("currents") or []
    if cur:  # fairbeam run records surface currents at these frequencies (cli._field_request)
        sim.current_freqs = [num(f, f"monitors.currents[{k}]") * 1e9 for k, f in enumerate(cur)]
    planes = field_plane_monitors(d, num)
    if planes:  # fairbeam run records these E/H maps (cli._field_plane_request, fairbeam.field_planes)
        sim.field_plane_monitors = planes
    # A bad count or a missing far field is a design_checks error (monitor-efficiency), which blocks
    # a designer run; the build itself carries on, so the geometry preview survives a half-typed
    # value, and says why it records nothing.
    try:
        n_eff = efficiency_points(d)
    except DesignError as e:
        print(f"fairbeam: warning: monitors.efficiency ignored: {e.detail}", file=sys.stderr, flush=True)
        n_eff = None
    if n_eff is not None and sim.nf2ff is not None:
        sim.efficiency_points = n_eff
    return sim


def wg_mode(mode, where: str = "") -> tuple[int, int]:
    """(m, n) of a rectangular waveguide mode name "TEmn" (openEMS RectWGPort: TE modes only)."""
    mt = WG_MODE.fullmatch(mode) if isinstance(mode, str) else None
    if not mt or mt.group(1) == mt.group(2) == "0":
        raise DesignError(f"{mode!r} is not a rectangular waveguide mode: write TEmn, e.g. TE10 (openEMS excites TE modes only)", where)
    return int(mt.group(1)), int(mt.group(2))


def wg_cutoff_ghz(m: int, n: int, a_mm: float, b_mm: float) -> float:
    """Cut-off frequency (GHz) of the TE_mn mode of an a x b (mm) rectangular guide, air filled."""
    return C0 * 1e-6 / 2 * math.sqrt((m / a_mm) ** 2 + (n / b_mm) ** 2)


def add_primitive(prop, p: dict):
    """Add one resolved primitive to a CSXCAD property."""
    import numpy as np

    kind, prio = p["kind"], p["priority"]
    if kind == "box":
        prim = prop.AddBox(priority=prio, start=p["start"], stop=p["stop"])
    elif kind == "cylinder":
        r, ri = p["radius"], p.get("inner_radius", 0.0)
        if ri > 0:
            prim = prop.AddCylindricalShell(p["start"], p["stop"], (r + ri) / 2, r - ri, priority=prio)
        else:
            prim = prop.AddCylinder(p["start"], p["stop"], r, priority=prio)
    elif kind == "sphere":
        prim = prop.AddSphere(p["center"], p["radius"], priority=prio)
    elif kind in ("cone", "torus"):
        prim = add_rotpoly(prop, p["axis"], p["origin"], p["profile"], prio)
    elif kind == "wire":
        prim = add_wire(prop, np.array(p["points"], float).T, p["radius"], priority=prio)
    elif kind == "polyhedron":
        prim = add_polyhedron(prop, p["vertices"], p["faces"], prio)
    else:
        coords = np.array(p["points"], float).T
        if kind == "polygon":
            prim = prop.AddPolygon(coords, p["normal"], p["elevation"], priority=prio)
        else:
            prim = prop.AddLinPoly(coords, p["normal"], p["elevation"], p["length"], priority=prio)
    if "_matrix" in p:
        prim.AddTransform("Matrix", np.asarray(p["_matrix"], dtype=float))
    return prim


def _bend(a, b, c) -> bool:
    """True when the polyline turns at ``b`` (a straight continuation needs no joint sphere)."""
    import numpy as np

    u, v = b - a, c - b
    return float(np.linalg.norm(np.cross(u, v))) > 1e-9 * float(np.linalg.norm(u) * np.linalg.norm(v))


# A wire thinner than this (mm: the 0.01 mm the CST import gives a wire with no thickness) stays a bare line of
# mesh edges: as a cylinder it would force cells a few micrometres wide and a tiny timestep.
WIRE_SOLID_MIN = 0.02


def add_wire(prop, points, radius, **kw):
    """A wire of ``radius`` as solid conductor: a cylinder along every segment of the polyline and a sphere at
    each bend, which the mesher treats like any thin cylinder (cells at the free ends, lines at the surface).
    CSXCAD's own ``AddWire`` snaps the polyline to the nearest mesh edges whatever the radius, and a half-wave
    dipole of it resonated 15 % below the same dipole drawn as cylinders. A wire thinner than
    ``WIRE_SOLID_MIN`` stays a CSXCAD wire, a bare line of mesh edges, and so does a wire with a slanted segment (an oblique cylinder
    would not export to CST as one). Returns the primitive, or an object that forwards
    ``AddTransform`` to every one of them."""
    import numpy as np

    if hasattr(prop, "_prop"):   # a lossy metal: its wires stay perfect conductors
        prop = prop._prop(("pec",))
    pts = np.asarray(points, float)
    if not radius or float(radius) < WIRE_SOLID_MIN or pts.ndim != 2 or pts.shape[0] != 3 or pts.shape[1] < 2:
        return prop.AddWire(points, radius, **kw)
    seg = np.abs(np.diff(pts, axis=1))
    if any(float(np.sort(c)[1]) > 1e-9 for c in seg.T):   # a slanted segment: a cylinder there would not export or mesh as one
        return prop.AddWire(points, radius, **kw)
    r = float(radius)
    keep = [i for i in range(pts.shape[1]) if i == 0 or float(np.linalg.norm(pts[:, i] - pts[:, i - 1])) > 1e-12]
    pts = pts[:, keep]
    prims = [prop.AddCylinder(pts[:, i].tolist(), pts[:, i + 1].tolist(), r, **kw) for i in range(pts.shape[1] - 1)]
    prims += [prop.AddSphere(pts[:, i].tolist(), r, **kw) for i in range(1, pts.shape[1] - 1)
              if _bend(pts[:, i - 1], pts[:, i], pts[:, i + 1])]

    class _Group:
        def AddTransform(self, *a, **k):
            for q in prims:
                q.AddTransform(*a, **k)

    return prims[0] if len(prims) == 1 else _Group()


def add_rotpoly(prop, axis: int, origin, profile, priority: int):
    """A solid of revolution: the (radial, axial) ``profile`` turned about the line through ``origin``
    along ``axis``. CSXCAD ``AddRotPoly`` turns a polygon about a coordinate axis through 0: the
    polygon lies in the plane normal to (axis + 1) % 3, whose in-plane axes are (axis + 2) % 3
    (radial) and axis (axial); a translation moves it to ``origin`` (fairbeam.geometry exports that
    exactly as the bundle kind ``rotpoly``)."""
    import numpy as np

    coords = np.array([[r for r, _ in profile], [h for _, h in profile]], float)
    prim = prop.AddRotPoly(coords, (axis + 1) % 3, 0.0, axis, angle=[0.0, 2 * np.pi], priority=priority)
    if any(abs(x) > 0 for x in origin):
        prim.AddTransform("Translate", [float(x) for x in origin])
    return prim


# ---------------------------------------------------------------------------- the model interface

def module_for(path_or_design, name: str | None = None):
    """A model-module stand-in (``MODEL``, ``PARAMS``, ``build``) for a design file or dict."""
    d = read_design(path_or_design) if not isinstance(path_or_design, dict) else path_or_design
    check_design(d)
    mod = types.SimpleNamespace()
    mod.DESIGN = d
    mod.MODEL = {k: v for k, v in d["model"].items() if isinstance(v, str)}
    mod.MODEL.setdefault("description", "")
    mod.PARAMS = design_params(d)
    mod.build = lambda values: build(d, values)
    mod.__doc__ = d["model"].get("description", "")
    mod.__name__ = name or f"fairbeam_design_{d['model']['id']}"
    return mod


# ---------------------------------------------------------------------------- export as Python

_PY_FUNCS = {"sqrt": "np.sqrt", "sin": "np.sin", "cos": "np.cos", "tan": "np.tan", "asin": "np.arcsin",
             "acos": "np.arccos", "atan": "np.arctan", "atan2": "np.arctan2", "exp": "np.exp", "log": "np.log",
             "log10": "np.log10", "abs": "abs", "min": "min", "max": "max", "round": "round",
             "floor": "np.floor", "ceil": "np.ceil", "radians": "np.radians", "degrees": "np.degrees",
             "wavelength": "wavelength"}
_PY_CONST = {"pi": "np.pi", "c0": "C0", "eps0": "8.8541878128e-12", "mu0": "1.25663706212e-6"}


def _py(text, independent: set[str]) -> str:
    """An expression as Python source: independent parameters become ``p["key"]``."""
    if isinstance(text, (int, float)) and not isinstance(text, bool):
        return repr(float(text)) if isinstance(text, float) else str(text)
    tree = parse_expr(text)

    class T(ast.NodeTransformer):
        def visit_Call(self, node):
            self.generic_visit(node)
            node.func = ast.parse(_PY_FUNCS[node.func.id], mode="eval").body
            return node

        def visit_Name(self, node):
            if node.id in _PY_CONST:
                return ast.parse(_PY_CONST[node.id], mode="eval").body
            if node.id in independent:
                return ast.Subscript(value=ast.Name("p", ast.Load()), slice=ast.Constant(node.id), ctx=ast.Load())
            return node

    return ast.unparse(ast.fix_missing_locations(T().visit(tree)).body)


def _thin_faces(d: dict, e) -> tuple[list, list, dict]:
    """For the export, at the default values: the bricks the build turns into sheets
    (``thin_sheets``) as ``(part, primitive, drawn axis, plane expression, plane value)``, and the sheets
    themselves for moving port ends onto them (``snap_to_sheets``)."""
    values = {p["key"]: float(p["default"]) for p in d.get("params", []) if "expr" not in p}
    try:
        names = resolve_names(d, values)
        parts = resolve_parts(d, names)
    except (DesignError, TypeError, ValueError, KeyError):
        return [], [], {}
    sheets = thin_sheets(parts, thin_metal_limit(d, names))
    faces, seen = [], set()
    for sh in sheets:
        m = re.fullmatch(r"parts\[(\d+)\]\.primitives\[(\d+)\]", sh.get("where") or "")
        if not m or (int(m[1]), int(m[2])) in seen:
            continue
        i, j = int(m[1]), int(m[2])
        seen.add((i, j))
        pr, n = d["parts"][i]["primitives"][j], sh["axis"]
        if pr.get("kind") == "linpoly":
            # an extruded outline flattened onto its base or top plane (untransformed parts only)
            e0, ln = e(pr.get("elevation", 0)), e(pr["length"])
            base = resolve_primitive(pr, names, sh["where"], 0)
            if sh["side"] == "middle":
                expr = f"(({e0}) + ({e0}) + ({ln})) / 2"
            else:
                expr = e0 if on_plane(base["elevation"], sh["at"]) else f"({e0}) + ({ln})"
            faces.append((i, j, n, expr, sh["at"]))
            continue
        maps = transform_maps(d["parts"][i].get("transforms", []), names, f"parts[{i}]")
        s, t = maps[sh["prim"] // (len(parts[sh["part"]]["prims"]) // len(maps))]
        # Flatten in drawn coordinates, before the export applies this copy's transform.
        drawn_axis = next(a for a in range(3) if _mapped_axis(s, a)[0] == n)
        if sh["side"] == "middle":
            expr = f"(({e(pr['start'][drawn_axis])}) + ({e(pr['stop'][drawn_axis])})) / 2"
        else:
            # which drawn face the sheet is on: the base brick's faces through this copy's transform
            base = resolve_primitive(pr, names, sh["where"], 0)
            expr = e(pr["start"][drawn_axis] if on_plane(_pt(s, t, base["start"])[n], sh["at"]) else pr["stop"][drawn_axis])
        faces.append((i, j, drawn_axis, expr, sh["at"]))
    return faces, sheets, names


def _snapped_ends(po: dict, faces: list, sheets: list, names: dict, d: dict, e) -> tuple[str, str] | None:
    """A port's or resistor's ends moved onto the thin-metal sheets as the build moves them, as
    expression lists; None when nothing moves. A plane from an untransformed part keeps its
    expression, other planes are written as numbers."""
    num = _evaluator(names)[0]
    try:
        a, c = [num(x, "") for x in po["start"]], [num(x, "") for x in po["stop"]]
    except (DesignError, TypeError, ValueError):
        return None
    a2, c2 = snap_to_sheets(a, c, AXES.index(po["direction"]), sheets)
    if a2 == a and c2 == c:
        return None
    out = []
    for old, new, src in ((a, a2, po["start"]), (c, c2, po["stop"])):
        ends = [e(x) for x in src]
        for q in range(3):
            if new[q] != old[q]:
                face = next((f for i, _j, n, f, at in faces
                             if n == q and on_plane(at, new[q]) and not d["parts"][i].get("transforms")), None)
                ends[q] = face if face is not None else repr(round(new[q], 9))
        out.append("[" + ", ".join(ends) + "]")
    return out[0], out[1]


def _static_priorities(d: dict) -> list:
    """Per part, the effective priority of each of its primitives as the build gives it (a void
    carver without its own priority sits 0.5 above the part's highest solid)."""
    materials = {m["name"]: m for m in d.get("materials", [])}
    out = []
    for pt in d.get("parts", []):
        dp = 10 if materials[pt["material"]]["kind"] == "metal" else 0
        prims = pt.get("primitives", [])
        solid = [_priority(pr.get("priority", dp)) for pr in prims if not pr.get("void")]
        above = max(solid or [dp]) + 0.5
        out.append([_priority(pr["priority"]) if pr.get("void") and "priority" in pr
                    else above if pr.get("void") else _priority(pr.get("priority", dp)) for pr in prims])
    return out


def to_python(d: dict) -> str:
    """The design as an equivalent Python model file (one-way: for moving on to code). Thin metal
    is written as the sheets the build makes of it (``thin_sheets``, at the default values)."""
    check_design(d)
    require_safe_sheet_transforms(d, resolve_names(d, {}))
    guard_materials = [mt for mt in d.get("materials", []) if mt.get("kind") == "metal"]
    guard_names = {mt["name"] for mt in guard_materials}
    guard_parts = []
    for pt in d.get("parts", []):
        if pt.get("material") not in guard_names:
            # Keep part indices stable so generated-build errors point back to the source design.
            guard_parts.append({"material": pt.get("material"), "primitives": [], "transforms": []})
            continue
        history = pt.get("booleanHistory")
        live = isinstance(history, dict) and history.get("live")
        primitives = pt.get("primitives", [])
        if not live:
            # Only these native kinds can be a zero-thickness sheet. Include boxes regardless of
            # default thickness because an independent parameter may flatten one at runtime.
            primitives = [p for p in primitives if p.get("kind") in ("box", "polygon", "linpoly")]
        guard_parts.append({"material": pt["material"], "primitives": primitives,
                            "transforms": pt.get("transforms", []),
                            **({"booleanHistory": history} if live else {})})
    guard_design = {"params": d.get("params", []), "materials": guard_materials, "parts": guard_parts}
    indep = {p["key"] for p in d.get("params", []) if "expr" not in p}
    need: set[str] = set()
    e = lambda v: _py(v, indep)  # noqa: E731
    vec = lambda v: "[" + ", ".join(e(x) for x in v) + "]"  # noqa: E731
    faces, sheets, thin_names = _thin_faces(d, e)
    flat = {(i, j): (n, f) for i, j, n, f, _at in faces}
    m = d["model"]
    organization = {"parts": {part["name"]: part["component"] for part in d["parts"] if "component" in part}}
    if "components" in d:
        organization["components"] = d["components"]
    eff = _static_priorities(d)
    ranks = priority_ranks([v for part in eff for v in part] + _group_priorities(d))
    rank = (lambda v: ranks[v]) if ranks else (lambda v: v)  # noqa: E731
    out = [f'"""{m["name"]}' + (f"\n\n{m['description']}" if m.get("description") else "")
           + f'\n\nExported from the design file {m["id"]}{DESIGN_SUFFIX}.\n"""', "",
           "import numpy as np", "", "from fairbeam import Param, Simulation",
           "from fairbeam.design import require_safe_sheet_transforms, resolve_names", "",
           f"_SHEET_GUARD = {guard_design!r}", "",
           f"FAIRBEAM_ORGANIZATION = {organization!r}", "",
           "C0 = 299_792_458.0", "", "",
           "def wavelength(f_ghz):", '    """Free-space wavelength in mm at f_ghz GHz."""',
           "    return C0 / (f_ghz * 1e9) * 1e3", "", "",
           "MODEL = " + json.dumps({k: v for k, v in m.items() if isinstance(v, str)}, ensure_ascii=False), "",
           "PARAMS = ["]
    for p in d.get("params", []):
        if "expr" in p:
            continue
        args = [repr(p["key"]), repr(float(p["default"])), repr(p.get("label") or p["key"]), repr(p.get("unit", ""))]
        extra = []
        if p.get("description"):
            extra.append(f"description={p['description']!r}")
        if p.get("min") is not None:
            extra.append(f"minimum={p['min']!r}")
        if p.get("max") is not None:
            extra.append(f"maximum={p['max']!r}")
        out.append(f"    Param({', '.join(args + extra)}),")
    out += ["]", "", "", "def build(p: dict) -> Simulation:",
            "    require_safe_sheet_transforms(_SHEET_GUARD, resolve_names(_SHEET_GUARD, p))"]
    for p in d.get("params", []):
        if "expr" in p:
            out.append(f"    {p['key']} = {e(p['expr'])}")
    s = d.get("simulation", {})
    b = s.get("boundaries", "MUR")
    out.append(f"    sim = Simulation(({e(s.get('f_min', 1))}) * 1e9, ({e(s.get('f_max', 3))}) * 1e9, "
               f"boundaries={[b] * 6 if isinstance(b, str) else list(b)!r}, "
               f"end_criteria_db={float(s.get('end_criteria_db', -60))!r}, max_timesteps={60000 if s.get('max_timesteps') in (None, 'auto') else int(s['max_timesteps'])})")
    materials = {mt["name"]: mt for mt in d.get("materials", [])}
    for i, pt in enumerate(d.get("parts", [])):
        mt = materials[pt["material"]]
        var = "prop"
        if pt.get("component"):
            out.append(f"    # component {pt['component']!r}")
        if (pt.get("booleanHistory") or {}).get("live"):
            out.append(f"    # {pt['name']!r}: Boolean {pt['booleanHistory'].get('operation')} result at the default values "
                       "(the design file recomputes it for other values)")
        if mt.get("library"):
            out.append(f"    # material {mt['name']!r}: values from the fairbeam material library entry {mt['library']!r}")
        lbl = f", label={pt['label']!r}" if pt.get("label") else ""
        col = pt.get("color") or mt.get("color")
        col = f", color={col!r}" if col else ""
        if mt["kind"] == "metal":
            loss = ""
            if _given(mt.get("conductivity")):
                # lossy: sheets become conducting sheets of the material's thickness (the build
                # gives a thin brick built as a sheet its drawn thickness instead), volumes a material
                loss = f", conductivity={e(mt['conductivity'])}"
                if _given(mt.get("thickness")):
                    loss += f", thickness={e(mt['thickness'])}"
            out.append(f"    {var} = sim.metal({pt['name']!r}{lbl}{col}{loss})")
            dp = 10
        else:
            tf = mt.get("tan_d_freq")
            tf = f", tan_d_freq=({e(tf)}) * 1e9" if tf is not None else ""
            mu = f", mu_r={e(mt['mu_r'])}" if "mu_r" in mt else ""
            out.append(f"    {var} = sim.dielectric({pt['name']!r}, {e(mt.get('eps_r', 1))}, tan_d={e(mt.get('tan_d', 0))}{tf}{lbl}{col}{mu})")
            dp = 0
        tr = pt.get("transforms") or []
        ind = "    "
        if tr:
            need.add("maps")
            out.append("    _maps = [((1.0, 1.0, 1.0), (0.0, 0.0, 0.0))]")
            for t in tr:
                if t["type"] == "move":
                    st = [e(x) for x in t["offset"]]
                    out.append(f"    _maps = [(_s, (_t[0] + ({st[0]}), _t[1] + ({st[1]}), _t[2] + ({st[2]}))) "
                               "for _s, _t in _maps]")
                elif t["type"] == "rotate":
                    need.add("rotate")
                    out.append(f"    _maps = _rotation(_maps, {AXES.index(t['axis'])}, {vec(t['center'])}, "
                               f"{e(t['angle'])}, {e(t.get('copies', 0))})")
                elif t["type"] == "translate":
                    st = [e(x) for x in t["step"]]
                    out.append(f"    _maps = [(_s, (_t[0] + _i * ({st[0]}), _t[1] + _i * ({st[1]}), _t[2] + _i * ({st[2]}))) "
                               f"for _i in range(int(round({e(t['copies'])})) + 1) for _s, _t in _maps]")
                elif t["type"] == "scale":
                    need.add("scale")
                    out.append(f"    _maps = _scaling(_maps, {vec(t['factors'])}, {vec(t['origin'])}, "
                               f"{e(t.get('copies', 0))})")
                else:
                    a = AXES.index(t["plane"])
                    keep = "_maps + " if t.get("keep", True) else ""
                    out.append(f"    _maps = {keep}[_flip(_s, _t, {a}, {vec(t.get('point', [0, 0, 0]))}[{a}]) for _s, _t in _maps]")
            ind = "        "
        P = (lambda v: f"_world_point(_s, _t, {v})") if tr else (lambda v: v)  # noqa: E731

        def emit_primitive(call, line_indent=ind, apply_map=True):
            if tr and apply_map:
                out.append(f"{line_indent}_prim = {call}")
                out.append(f"{line_indent}_finish_primitive(_prim, _s, _t)")
            else:
                out.append(f"{line_indent}{call}")

        cuts = pt.get("cuts") or []
        rect_cuts = all(c.get("kind", "rect") == "rect" for c in cuts)
        if cuts and rect_cuts:
            need.add("cuts")
            cut_src = "[" + ", ".join(f"({vec(c['start'])}, {vec(c['stop'])})" for c in cuts) + "]"

        def raw_shape(pr):
            """A primitive as the design's own resolver reads it, every value a Python expression: the
            exported file resolves it, cuts it and adds it with the build's functions (flat circles
            and rings become polygons, polygon sheets and round holes are clipped in 2D)."""
            if pr["kind"] == "box":
                body = f'"start": {vec(pr["start"])}, "stop": {vec(pr["stop"])}'
            elif pr["kind"] == "polygon":
                body = (f'"normal": {pr.get("normal", "z")!r}, "elevation": {e(pr.get("elevation", 0))}, '
                        f'"points": [' + ", ".join(vec(q) for q in pr["points"]) + "]")
            else:
                body = (f'"axis": {pr["axis"]!r}, "center": {vec(pr["center"])}, "radius": {e(pr["radius"])}, '
                        f'"inner_radius": {e(pr.get("inner_radius", 0))}, "range": {vec(pr["range"])}')
            return "{" + f'"kind": {pr["kind"]!r}, {body}' + "}"

        def raw_cut(c):
            shape = c.get("kind", "rect")
            if shape == "rect":
                return f'{{"start": {vec(c["start"])}, "stop": {vec(c["stop"])}}}'
            plane = f'"normal": {c.get("normal", "z")!r}, "elevation": {e(c.get("elevation", 0))}'
            if shape == "circle":
                return f'{{"kind": "circle", {plane}, "center": {vec(c["center"])}, "radius": {e(c["radius"])}}}'
            return f'{{"kind": "polygon", {plane}, "points": [' + ", ".join(vec(q) for q in c["points"]) + "]}"

        # the generic route: a flat circle or ring (a cylinder of zero length at some values), or
        # anything cut by a round or polygon hole, or a polygon cut at all
        generic = any(pr["kind"] == "cylinder" and "axis" in pr for pr in pt["primitives"]) or bool(cuts and (
            not rect_cuts or any(pr["kind"] == "polygon" for pr in pt["primitives"])))
        order = [(j, pr) for j, pr in enumerate(pt["primitives"]) if not pr.get("void")]
        order += [(j, pr) for j, pr in enumerate(pt["primitives"]) if pr.get("void")]
        group = None
        for j, pr in order:
            is_void = bool(pr.get("void"))
            if is_void != group:
                # the solids first, then the carvers: vacuum above the part's own shapes
                if is_void:
                    out.append(f"    {var} = sim.dielectric({pt['name'] + ' (cut)'!r}, 1.0, tan_d=0.0{lbl}{col}, mu_r=1.0, void=True)")
                if tr:
                    out.append("    for _s, _t in _maps:")
                group = is_void
            prio = rank(eff[i][j])
            kind = pr["kind"]
            if generic and not is_void and (i, j) not in flat and (kind in ("box", "polygon") and cuts
                                                                    or kind == "cylinder" and "axis" in pr):
                need.add("generic")
                if cuts and not any(ln.startswith(f"    _cuts_{i} = ") for ln in out):
                    cut_list = "[" + ", ".join(raw_cut(c) for c in cuts) + "]"
                    at = max(k for k, ln in enumerate(out) if ln == "    for _s, _t in _maps:") if tr else len(out)
                    out.insert(at, f"    _cuts_{i} = resolve_cuts({{'cuts': {cut_list}}}, {{}}, '')")
                cuts_name = f"_cuts_{i}" if cuts else "[]"
                out.append(f"{ind}for _q in apply_cuts([resolve_primitive({raw_shape(pr)}, {{}}, '', {prio})], {cuts_name}):")
                out.append(f"{ind}    add_primitive({var}, map_primitive(_q, _s, _t))" if tr else f"{ind}    add_primitive({var}, _q)")
            elif (i, j) in flat:
                # thin metal: the sheet the build makes of it (cuts do not apply to a drawn brick)
                n, plane = flat[(i, j)]
                if kind == "linpoly":
                    pts = "[" + ", ".join(vec(q) for q in pr["points"]) + "]"
                    out.append(f"{ind}# {e(pr['length'])} along {pr.get('normal', 'z')}: thin metal, built as a sheet")
                    emit_primitive(f"{var}.AddPolygon(np.array({pts}).T, {pr.get('normal', 'z')!r}, {plane}, priority={prio})")
                    continue
                a, c = [e(x) for x in pr["start"]], [e(x) for x in pr["stop"]]
                a[n] = c[n] = plane
                out.append(f"{ind}# {pr['start'][n]!s}..{pr['stop'][n]!s} along {AXES[n]}: thin metal, built as a sheet")
                emit_primitive(f"{var}.AddBox(priority={prio}, start={P('[' + ', '.join(a) + ']')}, stop={P('[' + ', '.join(c) + ']')})")
            elif kind == "box" and cuts and not is_void:
                # the part's cuts: a rectangular sheet in a cut's plane becomes its pieces
                out.append(f"{ind}for _a, _b in _cut({vec(pr['start'])}, {vec(pr['stop'])}, {cut_src}):")
                emit_primitive(f"{var}.AddBox(priority={prio}, start={P('_a')}, stop={P('_b')})", f"{ind}    ")
            elif kind == "box":
                emit_primitive(f"{var}.AddBox(priority={prio}, start={P(vec(pr['start']))}, stop={P(vec(pr['stop']))})")
            elif kind == "cylinder":
                if "axis" in pr:
                    n = AXES.index(pr["axis"])
                    u, v = in_plane(n)
                    a, c = [""] * 3, [""] * 3
                    a[n], c[n] = e(pr["range"][0]), e(pr["range"][1])
                    a[u] = c[u] = e(pr["center"][0])
                    a[v] = c[v] = e(pr["center"][1])
                    start, stop = "[" + ", ".join(a) + "]", "[" + ", ".join(c) + "]"
                else:
                    start, stop = vec(pr["start"]), vec(pr["stop"])
                ri = pr.get("inner_radius", 0)
                if isinstance(ri, (int, float)) and not isinstance(ri, bool) and ri == 0:
                    radius = f"_mapped_radius(_s, {e(pr['radius'])})" if tr else e(pr['radius'])
                    emit_primitive(f"{var}.AddCylinder({P(start)}, {P(stop)}, {radius}, priority={prio})")
                else:
                    need.add("cylinder")
                    radius = f"_mapped_radius(_s, {e(pr['radius'])})" if tr else e(pr['radius'])
                    inner = f"_mapped_radius(_s, {e(ri)})" if tr else e(ri)
                    emit_primitive(f"_cylinder({var}, {P(start)}, {P(stop)}, {radius}, {inner}, {prio})")
            elif kind == "sphere":
                radius = f"_mapped_radius(_s, {e(pr['radius'])})" if tr else e(pr['radius'])
                emit_primitive(f"{var}.AddSphere({P(vec(pr['center']))}, {radius}, priority={prio})")
            elif kind == "wire":
                pts = "[" + ", ".join(vec(q) for q in pr["points"]) + "]"
                if tr:
                    pts = f"[_world_point(_s, _t, _q) for _q in {pts}]"
                radius = f"_mapped_radius(_s, {e(pr['radius'])})" if tr else e(pr['radius'])
                need.add("wire")
                emit_primitive(f"add_wire({var}, np.array({pts}, float).T, {radius}, priority={prio})")
            elif kind == "polyhedron":
                need.add("polyhedron")
                verts = "[" + ", ".join(vec(q) for q in pr["vertices"]) + "]"
                if tr:
                    verts = f"[_world_point(_s, _t, _q) for _q in {verts}]"
                emit_primitive(f"add_polyhedron({var}, {verts}, {json.dumps(pr['faces'])}, {prio})")
            elif kind in ("cone", "torus"):
                need.add("rotpoly")
                a = AXES.index(pr["axis"])
                if kind == "cone":
                    u, v = in_plane(a)
                    o = ["0"] * 3
                    o[u], o[v] = e(pr["center"][0]), e(pr["center"][1])
                    origin = "[" + ", ".join(o) + "]"
                    prof = f"_cone({e(pr['range'][0])}, {e(pr['range'][1])}, {e(pr['bottom_radius'])}, {e(pr.get('top_radius', 0))})"
                else:
                    need.add("torus")
                    origin = vec(pr["center"])
                    prof = f"_torus({e(pr['major_radius'])}, {e(pr['minor_radius'])})"
                st = ", _s, _t" if tr else ""
                emit_primitive(f"_rotpoly({var}, {a}, {origin}, {prof}, {prio}{st})", apply_map=False)
            else:
                pts = "[" + ", ".join(vec(q) for q in pr["points"]) + "]"
                normal = pr.get("normal", "z")
                elev = e(pr.get("elevation", 0))
                call = "AddPolygon" if kind == "polygon" else "AddLinPoly"
                if tr:
                    need.add("poly")
                    length = f", {e(pr['length'])}" if kind == "linpoly" else ""
                    emit_primitive(f"{var}.{call}(*_poly(_s, _t, {AXES.index(normal)}, {pts}, {elev}{length}), priority={prio})")
                elif kind == "polygon":
                    emit_primitive(f"{var}.AddPolygon(np.array({pts}).T, {normal!r}, {elev}, priority={prio})")
                else:
                    length = f"_mapped_radius(_s, {e(pr['length'])})" if tr else e(pr['length'])
                    emit_primitive(f"{var}.AddLinPoly(np.array({pts}).T, {normal!r}, {elev}, {length}, priority={prio})")
    for po in d.get("ports", []):
        exc = "" if po.get("excite", True) else ", excite=False"
        if po.get("type") == "waveguide":
            out.append(f"    sim.waveguide_port({po['number']}, {vec(po['start'])}, {vec(po['stop'])}, {po['direction']!r}, "
                       f"{e(po['a'])}, {e(po['b'])}, {po.get('mode', 'TE10')!r}{exc})")
            continue
        start, stop = _snapped_ends(po, faces, sheets, thin_names, d, e) or (vec(po["start"]), vec(po["stop"]))
        ref = po.get("reference_impedance")
        ref_arg = ", reference_impedance={" + ", ".join(f"{key!r}: {e(ref[key])}" for key in ("real", "imag")) + "}" if ref else ""
        group_kw = ""
        if "group" in po:
            members = []
            for _wm, member in list(port_feeds(po, "port"))[1:]:
                ma, mc = _snapped_ends(member, faces, sheets, thin_names, d, e) or (vec(member["start"]), vec(member["stop"]))
                members.append("{'start': " + ma + ", 'stop': " + mc + f", 'direction': {member['direction']!r}, 'polarity': {member.get('polarity', 1)}}}")
            group_kw = f", group={{'connection': {po['group']['connection']!r}, 'members': [" + ", ".join(members) + "]}"
        out.append(f"    sim.lumped_port({po['number']}, {e(po.get('R', 50))}, {start}, {stop}, "
                   f"{po['direction']!r}{exc}{group_kw}, priority={rank(po.get('group', {}).get('priority', 5))}{ref_arg})")
    for i, r in enumerate(d.get("resistors", [])):
        lbl = f", label={r['label']!r}" if r.get("label") else ""
        prio_arg = f", priority={rank(5)}" if ranks else ""
        start, stop = _snapped_ends(r, faces, sheets, thin_names, d, e) or (vec(r["start"]), vec(r["stop"]))
        if "L" not in r and "C" not in r and "topology" not in r:
            out.append(f"    sim.lumped_resistor({(r.get('name') or f'R{i + 1}')!r}, {e(r['R'])}, {start}, "
                       f"{stop}, {r['direction']!r}{lbl}{prio_arg})")
            continue
        values = "".join(f", {key}={e(r[key])}" for key in ("R", "L", "C") if key in r)
        out.append(f"    sim.lumped_element({(r.get('name') or f'R{i + 1}')!r}, {start}, "
                   f"{stop}, {r['direction']!r}{values}, topology={r.get('topology', 'parallel')!r}{lbl}{prio_arg})")
    mm = d.get("mesh", {})
    if mm.get("mode") == "manual":
        for ax in AXES:
            out.append(f"    sim.mesh.AddLine({ax!r}, [" + ", ".join(e(v) for v in mm["lines"][ax]) + "])" )
        out.append("    sim.mesh_report = {'settings': {'mode': 'manual'}, 'cells': [len(sim.mesh.GetLines(a)) - 1 for a in range(3)], 'warnings': []}")
    elif mm.get("mode") == "design":
        ov = mm.get("overrides", {})
        adaptive_sheets = bool(sheets)
        density = sum(len(pt["prims"]) for pt in resolve_parts(d, thin_names))
        has_dielectric = any(materials[pt["material"]].get("kind") == "dielectric"
                             for pt in d.get("parts", []))
        cpw = e(ov["cells_per_wavelength"]) if "cells_per_wavelength" in ov else str(30 if adaptive_sheets and density >= 3 else 24)
        air = (e(ov["air_cells_per_wavelength"]) if "air_cells_per_wavelength" in ov else
               f"min(({cpw}), max(8, round(({cpw}) / {1 + max(0, density - 1) / 8})))")
        ff_enabled = d.get("far_field", {}).get("enabled", True)
        fmin = e(d.get("simulation", {}).get("f_min", 1))
        pad_expr = f"(C0 / (({fmin}) * 1e9) / sim.unit) * {0.25 if ff_enabled else 0.125}"
        adaptive = {"cells_per_wavelength": cpw,
                    "edge_rule": repr(ov.get("edge_rule", "edge" if adaptive_sheets else "thirds")),
                    "air_cells_per_wavelength": air,
                    "max_ratio": e(ov["max_ratio"]) if "max_ratio" in ov else "1.4", "dielectric_cells": e(ov["dielectric_cells"]) if "dielectric_cells" in ov else ("5" if has_dielectric else "4"),
                    "pad": e(ov["pad"]) if "pad" in ov else pad_expr}
        adaptive["refine_features"] = repr(mm.get("refine_features", False))
        args = ", ".join(f"{k}={v}" for k, v in adaptive.items())
        out.append(f"    sim.auto_mesh({args})")
        note_keys = list(adaptive)
        out.append("    sim.mesh_report['settings']['mode'] = 'design'")
        out.append("    sim.mesh_report['notes'] = " + repr({k: ("overridden" if k in ov else "selected from design geometry, materials, frequency band, and far-field setting") for k in note_keys}))
    else:
        pad = f", pad={e(mm['pad'])}" if mm.get("pad") is not None else ""
        edge_rule = f", edge_rule={mm['edge_rule']!r}" if "edge_rule" in mm else ""
        max_ratio = f", max_ratio={e(mm['max_ratio'])}" if "max_ratio" in mm else ""
        air_cpw = (f", air_cells_per_wavelength={e(mm['air_cells_per_wavelength'])}"
                   if mm.get("air_cells_per_wavelength") is not None else "")
        out.append(f"    sim.auto_mesh(cells_per_wavelength={e(mm.get('cells_per_wavelength', 20))}{edge_rule}{max_ratio}{air_cpw}{pad}, refine_features={mm.get('refine_features', False)!r})")
    ff = d.get("far_field", {"enabled": True})
    if ff.get("enabled", True):
        args = []
        if ff.get("phase_center") is not None:
            args.append("center=[" + ", ".join(e(v) for v in ff["phase_center"]) + "]")
        if ff.get("faces") is not None and not all(ff["faces"]):
            args.append(f"directions={[bool(v) for v in ff['faces']]}")
        out.append(f"    sim.add_nf2ff_box({', '.join(args)})")
        if ff.get("frequencies"):
            out.append("    sim.pattern_freqs = [" + ", ".join(f"({e(f)}) * 1e9" for f in ff["frequencies"]) + "]")
    cur = (d.get("monitors") or {}).get("currents") or []
    if cur:
        out.append("    sim.current_freqs = [" + ", ".join(f"({e(f)}) * 1e9" for f in cur) + "]  # surface-current maps")
    n_eff = efficiency_points(d)
    if n_eff is not None and ff.get("enabled", True):
        out.append(f"    sim.efficiency_points = {n_eff}  # radiation efficiency over the band")
    planes = [pl for pl in ((d.get("monitors") or {}).get("field_planes") or [])[:FIELD_PLANES_MAX]
              if pl.get("frequencies")]
    if planes:
        out.append("    sim.field_plane_monitors = [  # E/H maps on cut planes (position in mm)")
        for pl in planes:
            freqs = ", ".join(f"({e(f)}) * 1e9" for f in pl["frequencies"][:FIELD_PLANE_FREQS_MAX])
            out.append(f"        {{'quantity': {pl['quantity']!r}, 'normal': {pl['normal']!r}, "
                       f"'component': {pl.get('component', 'abs')!r}, 'position': {e(pl['position'])}, "
                       f"'frequencies': [{freqs}]}},")
        out.append("    ]")
    out += ["    return sim", ""]
    helpers = []
    if need & {"maps", "rotpoly"}:
        helpers += _PY_HELPERS["maps"]
    if "rotate" in need:
        helpers += _PY_HELPERS["rotate"]
    if "scale" in need:
        helpers += _PY_HELPERS["scale"]
    if "poly" in need:
        helpers += _PY_HELPERS["poly"]
    if "cylinder" in need:
        helpers += _PY_HELPERS["cylinder"]
    if "wire" in need:
        helpers += ["from fairbeam.design import add_wire", "", ""]
    if "polyhedron" in need:
        import inspect

        helpers += (inspect.getsource(polyhedron_triangles).splitlines() + ["", ""]
                    + inspect.getsource(add_polyhedron).splitlines() + ["", ""])
    if "generic" in need:
        helpers += ["from fairbeam.design import add_primitive, apply_cuts, map_primitive, resolve_cuts, resolve_primitive", "", ""]
    if "cuts" in need:
        import inspect

        helpers += inspect.getsource(_sheet_minus).splitlines() + ["", ""] + _PY_HELPERS["cuts"]
    if "rotpoly" in need:
        helpers += _PY_HELPERS["rotpoly"]
    if "torus" in need:
        helpers += _PY_HELPERS["torus"]
    at = out.index("MODEL = " + json.dumps({k: v for k, v in m.items() if isinstance(v, str)}, ensure_ascii=False))
    return "\n".join(out[:at] + helpers + out[at:])


# helper functions the exported file needs for transforms and tubes (same arithmetic as the build)
_PY_HELPERS = {
    "maps": [
        "def _pt(s, t, p):",
        "    if isinstance(s[0], (tuple, list)):",
        "        return [sum(s[i][j] * p[j] for j in range(3)) + t[i] for i in range(3)]",
        "    return [s[i] * p[i] + t[i] for i in range(3)]", "", "",
        "def _mapped_axis(s, axis):",
        "    if not isinstance(s[0], (tuple, list)):", "        return axis, s[axis]",
        "    out = next(i for i in range(3) if s[i][axis])", "    return out, s[out][axis]", "", "",
        "def _scale_value(s, value):",
        "    factor = max(abs(x) for row in s for x in row) if isinstance(s[0], (tuple, list)) else abs(s[0])",
        "    return factor * value", "", "",
        "def _linear(s):",
        "    if isinstance(s[0], (tuple, list)): return [list(row) for row in s]",
        "    return [[s[i] if i == j else 0.0 for j in range(3)] for i in range(3)]", "", "",
        "def _axis_map(s):",
        "    used = set()",
        "    for row in _linear(s):",
        "        nz = [j for j, x in enumerate(row) if abs(x) > 1e-12]",
        "        if len(nz) != 1 or nz[0] in used: return False",
        "        used.add(nz[0])",
        "    return len(used) == 3", "", "",
        "def _matrix4(s, t):",
        "    m = _linear(s)",
        "    return [m[i] + [float(t[i])] for i in range(3)] + [[0.0, 0.0, 0.0, 1.0]]", "", "",
        "def _world_point(s, t, p):",
        "    return _pt(s, t, p) if _axis_map(s) else list(p)", "", "",
        "def _mapped_radius(s, value):",
        "    return _scale_value(s, value) if _axis_map(s) else value", "", "",
        "def _finish_primitive(prim, s, t):",
        '    if not _axis_map(s): prim.AddTransform("Matrix", np.array(_matrix4(s, t), float))',
        "    return prim", "", "",
        "def _flip(s, t, a, point=0):",
        "    s, t = list(s), list(t)",
        "    s[a] = tuple(-x for x in s[a]) if isinstance(s[a], (tuple, list)) else -s[a]",
        "    t[a] = 2 * point - t[a]", "    return tuple(s), tuple(t)", "", ""],
    "scale": [
        "def _scale(s, t, factor, origin):",
        "    if isinstance(s[0], (tuple, list)):",
        "        s = tuple(tuple(factor * x for x in row) for row in s)",
        "    else:", "        s = tuple(factor * x for x in s)",
        "    t = tuple(factor * (t[i] - origin[i]) + origin[i] for i in range(3))",
        "    return s, t", "", "",
        "def _scaling(maps, factors, origin, copies):",
        "    if any(x <= 0 for x in factors):", "        raise ValueError('scale factors must be positive')",
        "    if max(factors) - min(factors) > 1e-12 * max(1.0, *(abs(x) for x in factors)):",
        "        raise ValueError('nonuniform scaling is unsupported; all three factors must be equal')",
        "    if copies < 0 or abs(copies - round(copies)) > 1e-9:",
        "        raise ValueError('the number of copies must be a whole number >= 0')",
        "    copies = int(round(copies))",
        f"    if (copies + 1) * len(maps) > {MAX_COPIES + 1}:",
        f"        raise ValueError('at most {MAX_COPIES} copies of a part')",
        "    factor = sum(factors) / 3", "    scaled = list(maps)",
        "    result = list(maps) if copies else []",
        "    for _ in range(copies if copies else 1):",
        "        scaled = [_scale(s, t, factor, origin) for s, t in scaled]",
        "        result.extend(scaled)" , "    return result", "", ""],
    "rotate": [
        "def _rotate(s, t, axis, center, turns):",
        "    m = [list(row) for row in s] if isinstance(s[0], (tuple, list)) else [",
        "        [s[i] if i == j else 0 for j in range(3)] for i in range(3)]",
        "    t = [t[i] - center[i] for i in range(3)]",
        "    u, v = (axis + 1) % 3, (axis + 2) % 3",
        "    for _ in range(turns % 4):",
        "        m[u], m[v] = [-x for x in m[v]], m[u]",
        "        t[u], t[v] = -t[v], t[u]",
        "    return tuple(tuple(row) for row in m), tuple(t[i] + center[i] for i in range(3))", "", "",
        "def _rotate_any(s, t, axis, center, angle):",
        "    radians = np.radians(angle % 360.0)", "    c, sn = float(np.cos(radians)), float(np.sin(radians))",
        "    if axis == 0: r = [[1., 0., 0.], [0., c, -sn], [0., sn, c]]",
        "    elif axis == 1: r = [[c, 0., sn], [0., 1., 0.], [-sn, 0., c]]",
        "    else: r = [[c, -sn, 0.], [sn, c, 0.], [0., 0., 1.]]",
        "    m = _linear(s)",
        "    linear = [[sum(r[i][k] * m[k][j] for k in range(3)) for j in range(3)] for i in range(3)]",
        "    delta = [t[i] - center[i] for i in range(3)]",
        "    moved = [sum(r[i][j] * delta[j] for j in range(3)) + center[i] for i in range(3)]",
        "    return tuple(tuple(row) for row in linear), tuple(moved)", "", "",
        "def _rotation(maps, axis, center, angle, copies):",
        "    if copies < 0 or abs(copies - round(copies)) > 1e-9:",
        "        raise ValueError('the number of copies must be a whole number >= 0')",
        "    copies = int(round(copies))",
        f"    if (copies + 1) * len(maps) > {MAX_COPIES + 1}:",
        f"        raise ValueError('at most {MAX_COPIES} copies of a part')",
        "    quarter = abs(angle / 90 - round(angle / 90)) <= 1e-9",
        "    if quarter:",
        "        return [_rotate(s, t, axis, center, int(round(angle / 90)) * k)",
        "                for k in (range(copies + 1) if copies else (1,)) for s, t in maps]",
        "    return [(s, t) if k == 0 else _rotate_any(s, t, axis, center, (angle % 360.0) * k)",
        "            for k in (range(copies + 1) if copies else (1,)) for s, t in maps]", "", ""],
    "poly": [
        "def _poly(s, t, n, pts, elevation, length=None):",
        '    """AddPolygon / AddLinPoly arguments of a transformed copy (normal n as 0/1/2)."""',
        "    if not _axis_map(s):",
        "        coords = np.array(pts, float).T",
        "        return (coords, n, elevation) if length is None else (coords, n, elevation, length)",
        "    u, v = (n + 1) % 3, (n + 2) % 3",
        "    normal, sign = _mapped_axis(s, n)",
        "    ou, ov = (normal + 1) % 3, (normal + 2) % 3",
        "    points = []", "    for a, b in pts:", "        p = [0.0] * 3",
        "        p[n], p[u], p[v] = elevation, a, b", "        moved = _pt(s, t, p)",
        "        points.append([moved[ou], moved[ov]])",
        "    coords = np.array(points).T",
        "    if length is None:", "        return coords, normal, sign * elevation + t[normal]",
        "    scaled_length = _scale_value(s, length)",
        "    if sign < 0:", "        return coords, normal, sign * (elevation + length) + t[normal], scaled_length",
        "    return coords, normal, sign * elevation + t[normal], scaled_length", "", ""],
    "cylinder": [
        "def _cylinder(prop, start, stop, r, ri, priority):",
        '    """A solid cylinder, or a tube (cylindrical shell) when the inner radius ri > 0."""',
        "    if ri > 0:", "        return prop.AddCylindricalShell(start, stop, (r + ri) / 2, r - ri, priority=priority)",
        "    return prop.AddCylinder(start, stop, r, priority=priority)", "", ""],
    "cuts": [
        "def _cut(start, stop, cuts):",
        '    """The designer\'s part cuts: a rectangular sheet (zero size on one axis) in the plane of cuts',
        '    becomes the disjoint rectangles of the difference; any other box stays as it is."""',
        "    flat = [k for k in range(3) if abs(stop[k] - start[k]) < 1e-12]",
        "    if len(flat) != 1:", "        return [(start, stop)]", "    n = flat[0]",
        "    mine = [(a, b) for a, b in cuts if abs(b[n] - a[n]) < 1e-12",
        "            and abs(a[n] - start[n]) <= 1e-9 * max(1.0, abs(a[n]), abs(start[n]))]",
        "    return _sheet_minus(start, stop, mine) if mine else [(start, stop)]", "", ""],
    "rotpoly": [
        "def _cone(lo, hi, rb, rt):",
        '    """(radial, axial) outline of a cone or frustum from axial lo (radius rb) to hi (radius rt)."""',
        "    pts = [[0.0, lo]]", "    if rb > 0:", "        pts.append([rb, lo])", "    if rt > 0:",
        "        pts.append([rt, hi])", "    pts.append([0.0, hi])", "    return pts", "", "",
        "def _rotpoly(prop, axis, origin, profile, priority, s=(1.0, 1.0, 1.0), t=(0.0, 0.0, 0.0)):",
        '    """The (radial, axial) profile turned about the line through origin along axis (0/1/2):',
        "    CSXCAD AddRotPoly (in the plane normal to (axis + 1) % 3) moved there by a translation;",
        '    (s, t): a copy made by the designer\'s transforms."""',
        "    if not _axis_map(s):",
        "        coords = np.array([[r for r, _ in profile], [h for _, h in profile]], float)",
        "        prim = prop.AddRotPoly(coords, (axis + 1) % 3, 0.0, axis, angle=[0.0, 2 * np.pi], priority=priority)",
        '        if any(abs(x) > 0 for x in origin): prim.AddTransform("Translate", [float(x) for x in origin])',
        '        prim.AddTransform("Matrix", np.array(_matrix4(s, t), float))',
        "        return prim",
        "    o = _pt(s, t, origin)",
        "    axis, sign = _mapped_axis(s, axis)",
        "    factor = max(abs(x) for row in s for x in row) if isinstance(s[0], (tuple, list)) else abs(s[0])",
        "    coords = np.array([[factor * r for r, _ in profile], [sign * h for _, h in profile]], float)",
        "    prim = prop.AddRotPoly(coords, (axis + 1) % 3, 0.0, axis, angle=[0.0, 2 * np.pi], priority=priority)",
        "    if any(abs(x) > 0 for x in o):", '        prim.AddTransform("Translate", [float(x) for x in o])',
        "    return prim", "", ""],
    "torus": [
        f"def _torus(big, small, n={TORUS_SEGMENTS}):",
        '    """(radial, axial) outline of a torus tube: a regular n-gon of radius small at radial big."""',
        "    import math", "",
        "    return [[big + small * math.cos(2 * math.pi * k / n), small * math.sin(2 * math.pi * k / n)] for k in range(n)]",
        "", ""],
}


def empty_design(id_: str, name: str) -> dict:
    """A blank project: a band and one metal, no geometry yet. No dielectric is added up front (an unused FR4
    only cluttered the list): Materials › Add dielectric copies one from the library when a substrate is needed."""
    return {
        "schema": DESIGN_SCHEMA,
        "model": {"id": id_, "name": name, "description": ""},
        "params": [{"key": "f0", "default": 2.45, "label": "Design frequency", "unit": "GHz", "min": 0.1, "max": 100}],
        "simulation": {"f_min": "f0 * 0.6", "f_max": "f0 * 1.4", "boundaries": "MUR", "end_criteria_db": -50},
        # a copy of the material library's value (fairbeam.materials): the file stays self-contained
        "materials": [design_material("pec")],
        "parts": [],
        "ports": [],
        "resistors": [],
        "mesh": {"mode": "auto", "cells_per_wavelength": 20, "refine_features": False},
        "far_field": {"enabled": True, "frequencies": ["f0"]},
    }


# the Start screen's starting points (src/designer/templates.ts lists the same keys); the starters
# other than these two are in fairbeam.starters
TEMPLATES = {"empty": "empty_design", "patch": "blank_design", "dipole": "starters.dipole_design",
             "monopole": "starters.monopole_design", "sleeve-dipole": "starters.sleeve_dipole_design",
             "open-waveguide": "starters.open_waveguide_design", "microstrip": "starters.microstrip_design"}


def template_design(template: str, id_: str, name: str) -> dict:
    """A new design from a template name (a key of ``TEMPLATES``: "empty", "patch", "dipole", ...)."""
    if template not in TEMPLATES:
        raise DesignError(f"unknown template {template!r}; choose one of {', '.join(TEMPLATES)}", "template")
    target = TEMPLATES[template]
    if target.startswith("starters."):
        from . import starters

        return getattr(starters, target.split(".", 1)[1])(id_, name)
    return globals()[target](id_, name)


def blank_design(id_: str, name: str) -> dict:
    """A starting point: a probe-fed patch on a substrate over a ground plane, fully parametric."""
    return {
        "schema": DESIGN_SCHEMA,
        "model": {"id": id_, "name": name, "description": "Probe-fed rectangular patch, drawn in the designer."},
        "params": [
            {"key": "f0", "default": 2.45, "label": "Design frequency", "unit": "GHz", "min": 0.5, "max": 20},
            {"key": "W", "default": 32.0, "label": "Patch width (x)", "unit": "mm", "min": 5, "max": 100},
            {"key": "L", "default": 40.0, "label": "Patch length (y)", "unit": "mm", "min": 5, "max": 100},
            {"key": "h", "default": 1.524, "label": "Substrate thickness", "unit": "mm", "min": 0.1, "max": 10},
            {"key": "G", "default": 60.0, "label": "Ground plane size", "unit": "mm", "min": 10, "max": 300},
            {"key": "feed", "default": -6.0, "label": "Feed offset (x)", "unit": "mm", "min": -50, "max": 50},
        ],
        # -60 dB: the efficiency off resonance, where almost all the incident power is reflected, needs
        # the ring-down well below -50 dB (docs/BUNDLE.md, results.efficiency)
        "simulation": {"f_min": "f0 * 0.6", "f_max": "f0 * 1.3", "boundaries": "MUR", "end_criteria_db": -60},
        # RO4003C-like. openEMS applies tan δ as a constant conductivity, so it holds at tan_d_freq
        # only: at the design frequency, not the datasheet's 10 GHz (that made the loss at 2.45 GHz
        # four times too high: 65 % radiation efficiency instead of 89 %)
        "materials": [
            {"name": "copper", "kind": "metal"},
            {"name": "substrate", "kind": "dielectric", "eps_r": "3.38", "tan_d": "0.0027", "tan_d_freq": "f0"},
        ],
        "parts": [
            {"name": "substrate", "material": "substrate", "label": "Substrate",
             "primitives": [{"kind": "box", "start": ["-G/2", "-G/2", "0"], "stop": ["G/2", "G/2", "h"]}]},
            {"name": "gnd", "material": "copper", "label": "Ground plane",
             "primitives": [{"kind": "box", "start": ["-G/2", "-G/2", "0"], "stop": ["G/2", "G/2", "0"]}]},
            {"name": "patch", "material": "copper", "label": "Patch",
             "primitives": [{"kind": "box", "start": ["-W/2", "-L/2", "h"], "stop": ["W/2", "L/2", "h"]}]},
        ],
        "ports": [{"type": "lumped", "number": 1, "R": "50", "start": ["feed", "0", "0"], "stop": ["feed", "0", "h"],
                   "direction": "z"}],
        "resistors": [],
        "mesh": {"mode": "auto", "cells_per_wavelength": 20, "refine_features": False},
        "far_field": {"enabled": True, "frequencies": ["f0"]},
    }
