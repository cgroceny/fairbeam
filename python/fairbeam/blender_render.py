"""Blender side of Fairbeam's "Render with Blender" (docs/RENDER-BLENDER.md).

Run headless, never in a Blender window:

    blender -b --factory-startup -P blender_render.py -- job.json

``job.json`` is written by fairbeam/blender_job.py: the GLB, the per-part material info, the ports and the
lumped elements (in metres, Blender Z-up like the design), the camera angles and the render options. The
script imports the GLB, assigns Principled BSDF materials (the look table in docs/RENDER-BLENDER.md, the same
values as the in-app renderer), builds the SMA connectors / port markers / SMD boxes, lights the scene with a
three-point studio and a neutral world, then renders one PNG per angle. It prints ``@AL ...`` marker lines
that the server turns into progress.

The module also imports without Blender (the helpers up to ``# ---- bpy`` are pure Python and unit tested).
Written for Blender 3.6 to 4.2: Principled input names changed in 4.0, EEVEE was renamed in 4.2, AgX arrived
in 4.0 (Filmic before).
"""

from __future__ import annotations

import json
import math
import re
import sys
import time

# ----------------------------------------------------------------------------------------------- look table
# The look of every material class, the SAME numbers as MATERIAL_LOOKS in src/render/materials.ts (that file is
# authoritative; scripts/check-blender-render.mjs fails when the two differ): base colour (sRGB hex), roughness,
# metallic, coat weight, coat roughness. The Blender-only extras (subsurface, transmission) are in material_for.
LOOK_TABLE = {
    "copper": ("#B87333", 0.25, 1.0, 0.0, 0.0),
    "gold": ("#D4AF37", 0.20, 1.0, 0.0, 0.0),
    "silver": ("#C8C8C8", 0.20, 1.0, 0.0, 0.0),
    "tin": ("#C8C8C8", 0.20, 1.0, 0.0, 0.0),
    "nickel": ("#C8C8C8", 0.20, 1.0, 0.0, 0.0),
    "aluminium": ("#D0D3D4", 0.35, 1.0, 0.0, 0.0),
    "brass": ("#C8A24A", 0.30, 1.0, 0.0, 0.0),
    "steel": ("#9A9DA1", 0.35, 1.0, 0.0, 0.0),
    "fr4": ("#C9C46A", 0.50, 0.0, 0.0, 0.0),
    "solder-mask": ("#1B6B38", 0.32, 0.0, 0.6, 0.15),
    "ptfe": ("#EDE6D6", 0.60, 0.0, 0.0, 0.0),
    "ceramic": ("#F1F0EC", 0.40, 0.0, 0.15, 0.3),
    "dielectric": ("#BDB6A8", 0.55, 0.0, 0.0, 0.0),
    "sma-body": ("#D4AF37", 0.22, 1.0, 0.0, 0.0),
    "sma-nut": ("#C8C8C8", 0.28, 1.0, 0.0, 0.0),
    "sma-dielectric": ("#F4F1EA", 0.50, 0.0, 0.0, 0.0),
    "sma-pin": ("#D4AF37", 0.18, 1.0, 0.0, 0.0),
    "smd-body": ("#1B1B1D", 0.45, 0.0, 0.2, 0.35),
    "smd-cap": ("#C8C8C8", 0.30, 1.0, 0.0, 0.0),
    "marker": ("#D3201F", 0.15, 0.0, 1.0, 0.05),
}
METAL_LOOKS = {k: (LOOK_TABLE[k][0], LOOK_TABLE[k][1]) for k in ("copper", "gold", "silver", "aluminium", "brass", "steel")}
# name patterns (lower case) in the order they are tried
def _w(word: str) -> str:
    """A whole abbreviation (``al`` in ``ground_Al`` but not in ``alumina``): not touching other letters."""
    return r"(?<![a-z])" + word + r"(?![a-z])"


METAL_NAMES = [
    ("copper", r"copper|" + _w("cu") + r"|pec|rolled"),
    ("gold", r"gold|" + _w("au") + r"|enig"),
    ("silver", r"silver|" + _w("ag") + "|" + _w("tin") + r"|nickel|" + _w("ni") + r"|solder|hasl"),
    ("aluminium", r"alumin|" + _w("al")),
    ("brass", r"brass"),
    ("steel", r"steel|stainless|iron"),
]
FR4_RE = r"fr[-_ ]?4|fr[-_ ]?5|" + _w("g10") + r"|pcb|laminate|epoxy"
ROGERS_RE = r"rogers|\bro\s?\d|\brt\s?[-_]?\d|tly|taconic|ptfe|teflon|duroid|rf[-_ ]?35|ro4|isola|arlon|ceramic[-_ ]?filled"
CERAMIC_RE = r"alumina|ceramic|\bal2o3\b|porcelain|\bsapphire\b"
MASK_GREEN = LOOK_TABLE["solder-mask"][0]


def hex_to_rgb(value: str) -> tuple[float, float, float]:
    v = value.strip().lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    if not re.fullmatch(r"[0-9a-fA-F]{6}", v):
        raise ValueError(f"bad colour {value!r}")
    return tuple(int(v[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_colour(value: str) -> tuple[float, float, float, float]:
    r, g, b = (srgb_to_linear(c) for c in hex_to_rgb(value))
    return (r, g, b, 1.0)


def _text(*parts) -> str:
    return " ".join(str(p) for p in parts if p).lower()


def classify_part(part: dict) -> dict:
    """The look of one part: ``{"look": ..., "colour": hex, "roughness", "metallic", "kind"}``.

    ``part`` has ``kind`` ("metal" | "dielectric" | "void"), and optionally ``material`` (the design's material name),
    ``library`` (the material library id), ``name``, ``color`` (the Properties override, wins for metals and
    dielectrics alike), ``eps_r``. Voids are never rendered (``look`` = "void").
    """
    kind = part.get("kind") or "dielectric"
    if part.get("void") or kind == "void":
        return {"look": "void", "kind": "void"}
    text = _text(part.get("library"), part.get("material"), part.get("name"))
    override = part.get("color")
    if override:
        try:
            hex_to_rgb(override)
        except ValueError:
            override = None
    if kind == "metal":
        look = None
        for name, pattern in METAL_NAMES:
            if re.search(pattern, text):
                look = name
                break
        look = look or "copper"
        colour, rough = METAL_LOOKS[look]
        return {"look": look, "kind": "metal", "colour": override or colour, "roughness": rough, "metallic": 1.0}
    eps = part.get("eps_r")
    try:
        eps = float(eps) if eps is not None else None
    except (TypeError, ValueError):
        eps = None
    if eps is not None and eps <= 1.0001 and re.search(r"air|vacuum|free", text):
        return {"look": "void", "kind": "void"}
    if re.search(FR4_RE, text):
        look = "fr4"
    elif re.search(ROGERS_RE, text):
        look = "rogers"
    elif re.search(CERAMIC_RE, text) or (eps is not None and eps >= 7.0):
        look = "ceramic"
    elif eps is not None and 3.9 <= eps <= 5.2:
        look = "fr4"            # a generic board-like laminate by its permittivity
    elif eps is not None and eps <= 3.9:
        look = "rogers"         # low-loss PTFE-like laminates are cream
    else:
        look = "dielectric"
    colour, rough = LOOK_TABLE[{"rogers": "ptfe"}.get(look, look)][:2]
    return {"look": look, "kind": "dielectric", "colour": override or colour, "roughness": rough, "metallic": 0.0}


# ----------------------------------------------------------------------------------------------- cameras
# direction from the target to the camera, and the up vector (design axes, Z up)
ANGLES = {
    "iso": ((1.0, -1.0, 0.8), (0, 0, 1)),
    "top": ((0, 0, 1), (0, 1, 0)),
    "bottom": ((0, 0, -1), (0, 1, 0)),
    "front": ((0, -1, 0), (0, 0, 1)),
    "back": ((0, 1, 0), (0, 0, 1)),
    "right": ((1, 0, 0), (0, 0, 1)),
    "left": ((-1, 0, 0), (0, 0, 1)),
}


def _norm(v):
    n = math.sqrt(sum(c * c for c in v)) or 1.0
    return tuple(c / n for c in v)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def angle_view(angle) -> tuple[str, tuple, tuple]:
    """``(name, direction, up)`` of an angle: a preset name, or ``{"name", "direction", "up"}`` ("current view")."""
    if isinstance(angle, str):
        key = angle.lower()
        if key not in ANGLES:
            raise ValueError(f"unknown camera angle {angle!r}")
        d, u = ANGLES[key]
        return key, _norm(d), _norm(u)
    d = _norm(angle["direction"])
    u = _norm(angle.get("up") or (0, 0, 1))
    if abs(_dot(d, u)) > 0.999:
        u = (0, 1, 0) if abs(d[1]) < 0.9 else (1, 0, 0)
    return re.sub(r"[^a-z0-9]+", "-", str(angle.get("name") or "current").lower()).strip("-") or "current", d, u


def fit_camera(points, direction, up, aspect, *, fov_y=None, margin=0.07, ortho=False):
    """Camera placement that frames ``points`` looking along ``-direction``.

    Returns ``{"location", "target", "right", "up", "distance", "ortho_scale"}``. Perspective with vertical field of
    view ``fov_y`` (radians); the 2D bounds of the points are centred and padded by ``margin``.
    """
    d = _norm(direction)
    right = _norm(_cross(up, d)) if abs(_dot(up, d)) < 0.9999 else (1.0, 0.0, 0.0)
    cam_up = _norm(_cross(d, right))
    centre = tuple(sum(p[i] for p in points) / len(points) for i in range(3))
    rel = [tuple(p[i] - centre[i] for i in range(3)) for p in points]
    # camera space: x right, y up, z toward the camera
    cs = [(_dot(r, right), _dot(r, cam_up), _dot(r, d)) for r in rel]
    pad = 1.0 + 2 * margin
    if ortho:
        xmin, xmax = min(c[0] for c in cs), max(c[0] for c in cs)
        ymin, ymax = min(c[1] for c in cs), max(c[1] for c in cs)
        w, h = max(xmax - xmin, 1e-9) * pad, max(ymax - ymin, 1e-9) * pad
        scale = max(w, h * aspect)
        shift = ((xmin + xmax) / 2, (ymin + ymax) / 2, 0.0)
        zmax = max(c[2] for c in cs)
        distance = zmax + max(scale, 1e-6) * 2
    else:
        ty = math.tan(fov_y / 2) / pad
        tx = ty * aspect
        # two passes: the centring shift moves the points, which moves the distance
        shift = (0.0, 0.0, 0.0)
        distance = 0.0
        for _ in range(3):
            q = [(c[0] - shift[0], c[1] - shift[1], c[2]) for c in cs]
            distance = max(max(p[2] + abs(p[0]) / tx, p[2] + abs(p[1]) / ty) for p in q)
            # centre the projected bounds: x/depth extremes
            xs = [p[0] / max(distance - p[2], 1e-9) for p in q]
            ys = [p[1] / max(distance - p[2], 1e-9) for p in q]
            dx = (min(xs) + max(xs)) / 2 * distance
            dy = (min(ys) + max(ys)) / 2 * distance
            shift = (shift[0] + dx, shift[1] + dy, 0.0)
        scale = 0.0
    target = tuple(centre[i] + right[i] * shift[0] + cam_up[i] * shift[1] for i in range(3))
    location = tuple(target[i] + d[i] * distance for i in range(3))
    return {"location": location, "target": target, "right": right, "up": cam_up, "distance": distance,
            "ortho_scale": scale}


# ----------------------------------------------------------------------------------------------- connectors
SMA = {
    "hex_af": 6.35e-3,        # hex nut, across flats
    "hex_len": 2.6e-3,
    "barrel_od": 5.4e-3,      # threaded outer conductor
    "barrel_id": 4.3e-3,
    "barrel_len": 6.4e-3,
    "ptfe_od": 4.3e-3,
    "ptfe_len": 4.4e-3,       # sits recessed in the barrel
    "pin_d": 1.27e-3,
    "pin_stub": 0.6e-3,       # past the dielectric face, up to the barrel mouth (a female contact would be hollow: simplified)
    "flange": 12.7e-3,
    "flange_t": 1.6e-3,
    "hole_d": 2.2e-3,
    "hole_pitch": 9.5e-3,
}


def sma_dims(scale: float = 1.0) -> dict:
    return {k: v * scale for k, v in SMA.items()}


def _bbox_of(m):
    """``(lo, hi)`` of a ``{"lo": [..], "hi": [..]}`` record."""
    return tuple(m["lo"]), tuple(m["hi"])


def _flat_axis(lo, hi, tol):
    """Axis index of a flat sheet (zero thickness along one axis), else None."""
    spans = [hi[i] - lo[i] for i in range(3)]
    ax = min(range(3), key=lambda i: spans[i])
    others = [spans[i] for i in range(3) if i != ax]
    return ax if spans[ax] <= tol and min(others) > tol * 5 else None


def plan_port_mount(port: dict, sheets: list[dict], tol: float, edge_tol: float = 2.5e-3,
                    min_flange: float = SMA["flange"]) -> dict | None:
    """Where an SMA fits a discrete (lumped) port, or None (the red marker is drawn instead).

    ``port``: ``start``/``stop`` in metres and ``direction`` ("x"|"y"|"z"). ``sheets``: flat metal parts as
    ``{"lo", "hi", "axis"}`` (bounding box in metres, the axis the sheet is flat in). Returns
    ``{"mode": "probe"|"edge"|"free", "axis": unit vector pointing from the mount outwards (the connector body
    side), "origin": the point on the mount plane the pin axis passes through, "pin_to": the far point of the pin
    (the port end the pin soldered to)}`` or None.

    * probe  -  one end of the port rests on a ground-plane sheet big enough for the flange and the port is not
      near its edge: the connector sits under the sheet, its pin runs through the port (probe feed).
    * edge   -  the same, but the port is within ``edge_tol`` of the sheet's edge: an edge-launch connector lies in
      the sheet's plane, pointing out of the nearest edge, its flange flush against the edge and centred on the
      board thickness (``origin``); ``trace`` is where its pin lies on the trace.
    * free   -  the port bridges a gap between small sheets (a dipole): a thin semi-rigid coax leaves the gap
      perpendicular to the sheet (see free_feed_layout); never a flange over the feed.
    """
    axis_of = {"x": 0, "y": 1, "z": 2}
    d = axis_of.get(str(port.get("direction")).lower())
    if d is None:
        return None
    a, b = list(port["start"]), list(port["stop"])
    ends = [a, b]
    # which sheet each end touches (normal axis == port axis, within the sheet's footprint)
    touching = []
    for k, end in enumerate(ends):
        best = None
        for sh in sheets:
            lo, hi = sh["lo"], sh["hi"]
            if sh["axis"] != d:
                continue
            if abs(end[d] - lo[d]) > tol * 4:
                continue
            if all(lo[i] - tol * 4 <= end[i] <= hi[i] + tol * 4 for i in range(3) if i != d):
                area = (hi[(d + 1) % 3] - lo[(d + 1) % 3]) * (hi[(d + 2) % 3] - lo[(d + 2) % 3])
                if best is None or area > best[1]:
                    best = (sh, area)
        touching.append(best)
    length = abs(b[d] - a[d])
    # a ground sheet: bigger than the flange in both directions
    def big(entry):
        if not entry:
            return False
        lo, hi = entry[0]["lo"], entry[0]["hi"]
        return min(hi[(d + 1) % 3] - lo[(d + 1) % 3], hi[(d + 2) % 3] - lo[(d + 2) % 3]) >= min_flange * 0.9
    ground_end = None
    if big(touching[0]) and (not big(touching[1]) or touching[0][1] >= touching[1][1]):
        ground_end = 0
    elif big(touching[1]):
        ground_end = 1
    if ground_end is not None and length > tol * 4:
        g_end, far_end = ends[ground_end], ends[1 - ground_end]
        sheet = touching[ground_end][0]
        lo, hi = sheet["lo"], sheet["hi"]
        # distance of the port to the sheet's edges in its plane
        near = None
        for i in range(3):
            if i == d:
                continue
            for side, edge in ((-1, lo[i]), (1, hi[i])):
                gap = abs(g_end[i] - edge)
                if near is None or gap < near[0]:
                    near = (gap, i, side)
        outward = [0.0, 0.0, 0.0]
        sign = 1.0 if far_end[d] > g_end[d] else -1.0       # from the ground toward the other end
        up = [0.0, 0.0, 0.0]
        up[d] = sign
        centre = [(a[i] + b[i]) / 2 for i in range(3)]
        if near and near[0] <= edge_tol:
            outward[near[1]] = float(near[2])
            # the flange sits flush against the board edge, centred on the board thickness; the pin ends on the
            # trace top at the port (its blade lies flat on it, see edge_launch_extras)
            origin = list(centre)
            origin[near[1]] = (lo if near[2] < 0 else hi)[near[1]]
            origin[d] = (g_end[d] + far_end[d]) / 2
            trace = list(centre)
            trace[near[1]] = origin[near[1]]
            trace[d] = far_end[d]
            return {"mode": "edge", "axis": tuple(outward), "origin": tuple(origin), "pin_to": tuple(origin),
                    "up": tuple(up), "trace": tuple(trace), "ground": g_end[d]}
        outward[d] = -sign
        origin = list(g_end)
        return {"mode": "probe", "axis": tuple(outward), "origin": tuple(origin), "pin_to": tuple(far_end)}
    # free: the port bridges a gap, or sits on small sheets
    anchors = [t for t in touching if t]
    sheet_axes = {sh["axis"] for sh in sheets if any(
        all(sh["lo"][i] - tol * 4 <= e[i] <= sh["hi"][i] + tol * 4 for i in range(3) if i != sh["axis"]) and
        abs(e[sh["axis"]] - sh["lo"][sh["axis"]]) <= tol * 4 for e in ends)}
    normal = next((n for n in sorted(sheet_axes) if n != d), None)
    if normal is None and anchors:
        return None
    if normal is None:
        # a sheet normal to d cannot be an in-plane gap: look for any flat sheet near the port
        near_sheets = [sh for sh in sheets if all(
            sh["lo"][i] - 4e-3 <= (a[i] + b[i]) / 2 <= sh["hi"][i] + 4e-3 for i in range(3) if i != sh["axis"])]
        normal = next((sh["axis"] for sh in near_sheets if sh["axis"] != d), None)
    if normal is None:
        return None
    centre = [(a[i] + b[i]) / 2 for i in range(3)]
    # the cable leaves on the side away from the default (iso) camera, so it never covers the feed
    vec = [0.0, 0.0, 0.0]
    vec[normal] = -1.0 if ANGLES["iso"][0][normal] > 0 else 1.0
    return {"mode": "free", "axis": tuple(vec), "origin": tuple(centre), "pin_to": tuple(centre),
            "dir": d, "start": tuple(a), "stop": tuple(b)}


# edge launch: the pin's blade, post, ground tab and fillet (metres)
EDGE = {"blade_len": 3.5e-3, "blade_w": 0.8e-3, "blade_t": 0.2e-3, "post_r": 0.3e-3,
        "tab_len": 4.0e-3, "tab_w": 6.0e-3, "tab_t": 0.4e-3, "fillet_r": 0.6e-3}


def edge_launch_extras(mount: dict, edge: dict = EDGE) -> dict:
    """Axis-aligned pieces of an edge-launch connector in world metres: the pin's flat blade lying on the trace top,
    the post that carries it up from the pin axis, the ground tab under the board and the solder fillet at the
    blade tip. ``mount`` is a ``plan_port_mount`` result with ``mode == "edge"``."""
    axis = mount["axis"]
    ai = max(range(3), key=lambda i: abs(axis[i]))
    sgn = 1.0 if axis[ai] > 0 else -1.0                 # outward; the board lies on the other side
    up = mount["up"]
    ui = max(range(3), key=lambda i: abs(up[i]))
    usg = 1.0 if up[ui] > 0 else -1.0
    si = 3 - ai - ui
    o, trace, ground = mount["origin"], mount["trace"], mount["ground"]

    def box(a0, a1, u0, u1, half_s):
        lo, hi = [0.0] * 3, [0.0] * 3
        lo[ai], hi[ai] = sorted((a0, a1))
        lo[ui], hi[ui] = sorted((u0, u1))
        lo[si], hi[si] = o[si] - half_s, o[si] + half_s
        return {"lo": tuple(lo), "hi": tuple(hi)}

    e = o[ai]
    inward = -sgn
    top = trace[ui]
    blade = box(e, e + inward * edge["blade_len"], top, top + usg * edge["blade_t"], edge["blade_w"] / 2)
    tab = box(e, e + inward * edge["tab_len"], ground - usg * edge["tab_t"], ground, edge["tab_w"] / 2)
    post_a = list(o)
    post_a[ai] = e
    post_b = list(post_a)
    post_b[ui] = top + usg * edge["blade_t"]
    tip = list(o)
    tip[ai] = e + inward * edge["blade_len"]
    tip[ui] = top + usg * edge["blade_t"] * 0.5
    return {"blade": blade, "tab": tab, "post": {"a": tuple(post_a), "b": tuple(post_b), "r": edge["post_r"]},
            "fillet": {"centre": tuple(tip), "r": edge["fillet_r"]}}


# free feed (a dipole): a thin semi-rigid coax
COAX = {"od": 2.19e-3, "centre_d": 0.51e-3, "length": 28e-3, "gap_to_sheet": 0.8e-3, "plug_len": 14e-3}


def free_feed_layout(mount: dict, coax: dict = COAX) -> dict:
    """The cable of a free feed in world metres. It leaves the feed gap perpendicular to the sheets, offset along the
    port direction so its jacket rests on the *start* arm; the centre conductor ends on the sheet plane and a short
    wire bridges from there to the other arm. Returns jacket / centre / solder / bridge pieces as cylinders (a, b, r),
    the outward ``axis``, the plug's start offset along it and ``origin`` (a point of the cable's axis on the sheet plane)."""
    axis = mount["axis"]
    ai = max(range(3), key=lambda i: abs(axis[i]))
    sgn = 1.0 if axis[ai] > 0 else -1.0
    d = mount["dir"]
    a, b = mount["start"], mount["stop"]
    sd = 1.0 if b[d] > a[d] else -1.0                    # from the start arm toward the stop arm
    r = coax["od"] / 2
    line = list(mount["origin"])                         # the coax axis passes through here ...
    line[d] = a[d] - sd * (r + 0.15e-3)                  # ... moved onto the start arm
    plane = mount["origin"][ai]
    off = coax["gap_to_sheet"]
    end = off + coax["length"]

    def at(offset, base=line):
        p = list(base)
        p[ai] = plane + sgn * offset
        return tuple(p)

    bridge_a = list(mount["origin"])
    bridge_a[d] = line[d]
    bridge_b = list(bridge_a)
    bridge_b[d] = b[d] + sd * 0.5e-3
    return {"axis": tuple(sgn if i == ai else 0.0 for i in range(3)),
            "jacket": {"a": at(off), "b": at(end), "r": r},
            "centre": {"a": at(0.0), "b": at(off + 0.2e-3), "r": coax["centre_d"] / 2},
            "solder": {"a": at(0.0), "b": at(off), "r": r * 0.8},
            "bridge": {"a": at(0.15e-3, bridge_a), "b": at(0.15e-3, bridge_b), "r": coax["centre_d"] / 2},
            "joint": at(0.15e-3, bridge_b), "plug_from": end, "plug_len": coax["plug_len"], "origin": at(0.0)}


# ---- bpy ------------------------------------------------------------------------------------------------------
try:  # pragma: no cover - only inside Blender
    import bpy
    import bmesh
    from mathutils import Vector, Matrix
except ImportError:  # the pure helpers above are importable without Blender
    bpy = None


def say(*parts) -> None:
    print("@AL", *parts, flush=True)


def first_input(node, names):
    for n in names:
        if n in node.inputs:
            return node.inputs[n]
    return None


def set_input(node, names, value) -> bool:
    socket = first_input(node, names if isinstance(names, (list, tuple)) else [names])
    if socket is None:
        return False
    try:
        socket.default_value = value
    except (TypeError, ValueError):
        return False
    return True


def make_principled(name, colour_hex, roughness, metallic=0.0, **extra):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    colour = linear_colour(colour_hex)
    set_input(bsdf, "Base Color", colour)
    set_input(bsdf, "Roughness", roughness)
    set_input(bsdf, "Metallic", metallic)
    mat.diffuse_color = colour
    mat.metallic = metallic
    mat.roughness = roughness
    for key, value in extra.items():
        set_input(bsdf, {"specular": ["Specular IOR Level", "Specular"], "transmission": ["Transmission Weight", "Transmission"],
                         "subsurface": ["Subsurface Weight", "Subsurface"], "coat": ["Coat Weight", "Clearcoat"],
                         "coat_rough": ["Coat Roughness", "Clearcoat Roughness"], "ior": ["IOR"],
                         "emission": ["Emission Strength"], "alpha": ["Alpha"]}.get(key, [key]), value)
    return mat, bsdf


def boost_saturation(value: str, factor: float) -> str:
    """The sRGB colour with its saturation scaled: AgX desaturates pale colours, a cream laminate would turn grey."""
    import colorsys
    r, g, b = hex_to_rgb(value)
    h, sat, v = colorsys.rgb_to_hsv(r, g, b)
    r, g, b = colorsys.hsv_to_rgb(h, min(1.0, sat * factor), v)
    return "#%02X%02X%02X" % tuple(int(round(c * 255)) for c in (r, g, b))


def material_for(look: dict, scale: float, solder_mask: bool, cache: dict):
    """A Principled material for a classified part (cached per look/colour)."""
    key = (look["look"], look.get("colour"), solder_mask)
    if key in cache:
        return cache[key]
    name = "Fairbeam " + look["look"] + (" mask" if solder_mask and look["look"] == "fr4" else "")
    if look["kind"] == "dielectric":
        look = dict(look, colour=boost_saturation(look["colour"], 1.7 if look["look"] != "fr4" else 1.15))
    if look["kind"] == "metal":
        mat, bsdf = make_principled(name, look["colour"], look["roughness"], 1.0)
    elif look["look"] == "fr4" and solder_mask:
        _c, _r, _m, coat, coat_rough = LOOK_TABLE["solder-mask"]
        mat, bsdf = make_principled(name, _c, _r, _m, coat=coat, coat_rough=coat_rough, specular=0.45)
    elif look["look"] == "fr4":
        # laminate: translucent yellow-green, a little subsurface glow, no mirror
        mat, bsdf = make_principled(name, look["colour"], look["roughness"], 0.0, subsurface=0.35, transmission=0.12,
                                    specular=0.4, ior=1.5)
        set_input(bsdf, "Subsurface Radius", (1.0 * 2e-3 * scale, 0.9 * 2e-3 * scale, 0.35 * 2e-3 * scale))
        set_input(bsdf, "Subsurface Color", linear_colour("#D6CE7A"))
    elif look["look"] == "rogers":
        mat, bsdf = make_principled(name, look["colour"], look["roughness"], 0.0, subsurface=0.15, specular=0.35)
        set_input(bsdf, "Subsurface Radius", (1.0 * 1.5e-3 * scale, 0.9 * 1.5e-3 * scale, 0.7 * 1.5e-3 * scale))
    elif look["look"] == "ceramic":
        mat, bsdf = make_principled(name, look["colour"], look["roughness"], 0.0, specular=0.6,
                                    coat=LOOK_TABLE["ceramic"][3], coat_rough=LOOK_TABLE["ceramic"][4])
    else:
        mat, bsdf = make_principled(name, look["colour"], look["roughness"], 0.0, subsurface=0.1, transmission=0.08,
                                    specular=0.4)
    cache[key] = mat
    return mat


def simple_material(name, colour_hex, roughness, metallic=0.0, **extra):
    return make_principled(name, colour_hex, roughness, metallic, **extra)[0]


def assign(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.material_index = 0


def world_points(meshes, decimate=1):
    pts = []
    for obj in meshes:
        mw = obj.matrix_world
        verts = obj.data.vertices
        step = max(1, len(verts) // 4000) * decimate
        for i in range(0, len(verts), step):
            p = mw @ verts[i].co
            pts.append((p.x, p.y, p.z))
        for c in obj.bound_box:
            p = mw @ Vector(c)
            pts.append((p.x, p.y, p.z))
    return pts


def mesh_bounds(obj):
    pts = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    return (tuple(min(p[i] for p in pts) for i in range(3)), tuple(max(p[i] for p in pts) for i in range(3)))


def part_key(obj, parts_by_name):
    """The job part a GLB mesh belongs to: the glTF extras ``component``, else the node name minus ``_N``."""
    comp = obj.get("component") if hasattr(obj, "get") else None
    if comp in parts_by_name:
        return comp
    parent = obj.parent
    while parent is not None:
        c = parent.get("component")
        if c in parts_by_name:
            return c
        if parent.name in parts_by_name:
            return parent.name
        parent = parent.parent
    base = re.sub(r"\.\d+$", "", obj.name)
    base = re.sub(r"_\d+$", "", base)
    if base in parts_by_name:
        return base
    if obj.data.materials and obj.data.materials[0]:
        m = re.sub(r"\.\d+$", "", obj.data.materials[0].name)
        if m in parts_by_name:
            return m
    return None


def thicken_sheet(obj, direction, thickness):
    """Give a flat sheet a real film thickness (35 um-like) on the side ``direction`` (world unit vector).

    A zero-thickness sheet on a substrate face is coplanar with it: Cycles speckles. The film also catches
    light on its edge. The mesh is extruded once and made closed; dimensions in the design are unchanged to
    within the film thickness.
    """
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    inv = obj.matrix_world.to_3x3().inverted()
    local = inv @ Vector(direction)
    local = local / local.length if local.length else Vector((0, 0, 1))
    ret = bmesh.ops.extrude_face_region(bm, geom=list(bm.faces))
    moved = [e for e in ret["geom"] if isinstance(e, bmesh.types.BMVert)]
    # thickness is in world metres; the object may carry a scale
    sc = (obj.matrix_world.to_3x3() @ local).length or 1.0
    bmesh.ops.translate(bm, vec=local * (thickness / sc), verts=moved)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()


def add_box(name, lo, hi, mat, collection):
    cx, cy, cz = [(lo[i] + hi[i]) / 2 for i in range(3)]
    sx, sy, sz = [max(hi[i] - lo[i], 1e-9) for i in range(3)]
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(cx, cy, cz))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (sx, sy, sz)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    assign(obj, mat)
    move_to(obj, collection)
    return obj


def move_to(obj, collection):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    collection.objects.link(obj)


def add_cylinder(name, radius, depth, centre, axis_vec, mat, collection, vertices=48, smooth=True):
    """Cylinder with its axis along ``axis_vec`` (unit)."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=centre)
    obj = bpy.context.active_object
    obj.name = name
    z = Vector((0, 0, 1))
    a = Vector(axis_vec).normalized()
    quat = z.rotation_difference(a)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = quat
    if smooth:
        for p in obj.data.polygons:
            p.use_smooth = True
    assign(obj, mat)
    move_to(obj, collection)
    return obj


def add_tube(name, r_out, r_in, length, centre, axis_vec, mat, collection, vertices=64):
    """Hollow tube (outer radius r_out, bore r_in) along ``axis_vec`` built with a boolean-free profile."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    n = vertices
    ring = []
    for z, r in ((-length / 2, r_out), (length / 2, r_out), (length / 2, r_in), (-length / 2, r_in)):
        ring.append([bm.verts.new((r * math.cos(2 * math.pi * k / n), r * math.sin(2 * math.pi * k / n), z)) for k in range(n)])
    for i in range(4):
        a, b = ring[i], ring[(i + 1) % 4]
        for k in range(n):
            bm.faces.new((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    for p in mesh.polygons:
        p.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.location = centre
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(Vector(axis_vec).normalized())
    assign(obj, mat)
    return obj


def add_hex(name, af, depth, centre, axis_vec, mat, collection):
    r = af / math.sqrt(3)            # circumradius of the hexagon
    bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=r, depth=depth, location=centre)
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(Vector(axis_vec).normalized())
    # a hex nut: bevel the corners lightly so it catches light
    mod = obj.modifiers.new("bevel", "BEVEL")
    mod.width = af * 0.02
    mod.segments = 2
    assign(obj, mat)
    move_to(obj, collection)
    return obj


class Materials:
    """The few extra materials of connectors, markers and SMD parts (created once per scene)."""

    def __init__(self):
        def look(key, name, **extra):
            colour, rough, metallic, coat, coat_rough = LOOK_TABLE[key]
            if coat:
                extra.update(coat=coat, coat_rough=coat_rough)
            return simple_material(name, colour, rough, metallic, **extra)

        self.gold = look("sma-body", "Fairbeam SMA gold")
        self.nut = look("sma-nut", "Fairbeam SMA nut")
        self.ptfe = look("sma-dielectric", "Fairbeam PTFE", specular=0.4)
        self.pin = look("sma-pin", "Fairbeam SMA pin")
        self.dark = simple_material("Fairbeam bore", "#1A1816", 0.5, 0.0)
        self.steel = look("steel", "Fairbeam steel")
        self.marker = look("marker", "Fairbeam port marker", emission=0.0)
        self.smd_body = look("smd-body", "Fairbeam SMD body", specular=0.4)
        self.smd_cap = look("smd-cap", "Fairbeam SMD cap")
        self.smd_tan = simple_material("Fairbeam SMD ceramic", "#9C8157", 0.45, 0.0)
        self.solder = look("tin", "Fairbeam solder")
        self.ground = None


def add_between(name, a, b, radius, mat, collection, vertices=24):
    a, b = Vector(a), Vector(b)
    axis = b - a
    return add_cylinder(name, radius, max(axis.length, 1e-9), (a + b) / 2, axis if axis.length else (0, 0, 1), mat, collection, vertices)


def build_edge_extras(name, mount, mats, collection):
    """The flat pin blade on the trace, its post, the ground tab under the board and a solder fillet."""
    ex = edge_launch_extras(mount)
    out = [add_box(name + " pin blade", ex["blade"]["lo"], ex["blade"]["hi"], mats.pin, collection),
           add_box(name + " ground tab", ex["tab"]["lo"], ex["tab"]["hi"], mats.gold, collection),
           add_between(name + " pin post", ex["post"]["a"], ex["post"]["b"], ex["post"]["r"], mats.pin, collection)]
    f = ex["fillet"]
    bpy.ops.mesh.primitive_uv_sphere_add(radius=f["r"], location=f["centre"], segments=32, ring_count=16)
    o = bpy.context.active_object
    o.name = name + " solder fillet"
    up = Vector(mount["up"])
    o.scale = Vector((1, 1, 1)) - Vector((abs(up.x), abs(up.y), abs(up.z))) * 0.5     # flattened along the board normal
    for poly in o.data.polygons:
        poly.use_smooth = True
    assign(o, mats.solder)
    move_to(o, collection)
    out.append(o)
    return out


def build_coax(name, mount, mats, collection):
    """A thin semi-rigid coax from the feed gap: tin jacket on one arm, centre conductor bridged to the other, a
    small SMA plug at the far end."""
    lay = free_feed_layout(mount)
    ax = Vector(lay["axis"])
    out = [add_between(name + " jacket", lay["jacket"]["a"], lay["jacket"]["b"], lay["jacket"]["r"], mats.solder, collection, 40),
           add_between(name + " solder", lay["solder"]["a"], lay["solder"]["b"], lay["solder"]["r"], mats.solder, collection, 32),
           add_between(name + " centre", lay["centre"]["a"], lay["centre"]["b"], lay["centre"]["r"], mats.pin, collection),
           add_between(name + " bridge", lay["bridge"]["a"], lay["bridge"]["b"], lay["bridge"]["r"], mats.pin, collection)]
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.45e-3, location=lay["joint"], segments=24, ring_count=12)
    j = bpy.context.active_object
    j.name = name + " joint"
    assign(j, mats.solder)
    move_to(j, collection)
    out.append(j)
    # the SMA plug: crimp ferrule, hex coupling nut, barrel with its PTFE face
    base = Vector(lay["origin"])
    z = lay["plug_from"]
    d = sma_dims(1.0)

    def at(offset):
        return base + ax * offset

    out.append(add_cylinder(name + " ferrule", 1.5e-3, 5e-3, at(z + 2.5e-3), ax, mats.gold, collection, 32))
    z += 5e-3
    out.append(add_hex(name + " plug nut", d["hex_af"], 4e-3, at(z + 2e-3), ax, mats.nut, collection))
    z += 4e-3
    out.append(add_cylinder(name + " plug body", d["barrel_od"] / 2, 5e-3, at(z + 2.5e-3), ax, mats.gold, collection, 48))
    out.append(add_cylinder(name + " plug face", d["ptfe_od"] / 2 * 0.9, 0.3e-3, at(z + 5e-3), ax, mats.ptfe, collection, 40))
    out.append(add_cylinder(name + " plug pin", d["pin_d"] / 2, 1.5e-3, at(z + 5.5e-3), ax, mats.pin, collection, 24))
    return out


def build_sma(name, mount, dims, mats, collection, scale_note=""):
    """A female SMA jack (4-hole flange, hex nut, threaded barrel with a PTFE insert and the centre pin)."""
    axis = Vector(mount["axis"]).normalized()           # outward from the mount plane (the connector side)
    origin = Vector(mount["origin"])
    pin_to = Vector(mount["pin_to"])
    d = dims
    parts = []
    # a local frame: the flange perpendicular to the axis
    ref = Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((1, 0, 0))
    u = axis.cross(ref).normalized()
    v = axis.cross(u).normalized()
    z0 = 0.0
    def at(offset):
        return origin + axis * offset
    # flange plate (square, rotated to be a plate along axis)
    flange = add_box_oriented(name + " flange", (d["flange"], d["flange"], d["flange_t"]), at(z0 + d["flange_t"] / 2), u, v, axis, mats.gold, collection)
    parts.append(flange)
    for sx in (-1, 1):
        for sy in (-1, 1):
            hole = add_cylinder(name + " hole", d["hole_d"] / 2, d["flange_t"] * 1.02, at(z0 + d["flange_t"] / 2) + u * sx * d["hole_pitch"] / 2 + v * sy * d["hole_pitch"] / 2,
                                axis, mats.dark, collection, vertices=24)
            parts.append(hole)
    z = z0 + d["flange_t"]
    parts.append(add_hex(name + " nut", d["hex_af"], d["hex_len"], at(z + d["hex_len"] / 2), axis, mats.nut, collection))
    z += d["hex_len"]
    barrel = add_tube(name + " barrel", d["barrel_od"] / 2, d["barrel_id"] / 2, d["barrel_len"], at(z + d["barrel_len"] / 2), axis, mats.gold, collection)
    parts.append(barrel)
    # a thin knurl ring to read as a threaded barrel
    for k in range(3):
        parts.append(add_cylinder(name + " thread", d["barrel_od"] / 2 * 1.015, d["barrel_len"] * 0.07, at(z + d["barrel_len"] * (0.2 + 0.25 * k)), axis, mats.gold, collection, vertices=48))
    z_top = z + d["barrel_len"]
    ptfe_len = d["ptfe_len"]
    ptfe_top = z_top - 0.6e-3 * (d["barrel_od"] / SMA["barrel_od"])
    parts.append(add_cylinder(name + " bore", d["barrel_id"] / 2 * 0.999, d["barrel_len"] * 0.9, at(z + d["barrel_len"] * 0.45), axis, mats.dark, collection, vertices=48))
    ring = add_tube(name + " PTFE", d["ptfe_od"] / 2 * 0.985, d["pin_d"] / 2, ptfe_len, at(ptfe_top - ptfe_len / 2), axis, mats.ptfe, collection)
    parts.append(ring)
    # PTFE face disc to close the ring visibly
    pin_len_ext = (pin_to - origin).dot(axis)  # negative: the pin toward the port end
    top = ptfe_top + d["pin_stub"]
    bottom = pin_len_ext                      # may be negative (toward the board)
    parts.append(add_cylinder(name + " pin", d["pin_d"] / 2, top - bottom, at((top + bottom) / 2), axis, mats.pin, collection, vertices=24))
    return parts


def add_box_oriented(name, size, centre, u, v, w, mat, collection):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=centre)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    m = Matrix(((u.x, v.x, w.x), (u.y, v.y, w.y), (u.z, v.z, w.z)))
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = m.to_quaternion()
    # keep the scale (size) local: rotate after scaling
    assign(obj, mat)
    move_to(obj, collection)
    return obj


def add_solder(point, radius, mats, collection):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=point, segments=32, ring_count=16)
    obj = bpy.context.active_object
    obj.name = "Fairbeam solder joint"
    obj.scale = (1.0, 1.0, 0.55)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    assign(obj, mats.solder)
    move_to(obj, collection)
    return obj


def build_marker(port, mats, collection, radius):
    a, b = Vector(port["start"]), Vector(port["stop"])
    ax = b - a
    length = ax.length
    out = []
    if port.get("type") == "waveguide":
        d = {"x": 0, "y": 1, "z": 2}[str(port["direction"]).lower()]
        lo = [min(a[i], b[i]) for i in range(3)]
        hi = [max(a[i], b[i]) for i in range(3)]
        t = radius * 0.5
        o = [i for i in range(3) if i != d]
        plane = a[d]
        for k in (0, 1):
            for side in (lo, hi):
                lo2, hi2 = list(lo), list(hi)
                lo2[d] = hi2[d] = plane
                lo2[d] -= t / 2
                hi2[d] += t / 2
                if k == 0:
                    lo2[o[0]] = side[o[0]] - (t if side is lo else 0)
                    hi2[o[0]] = side[o[0]] + (0 if side is lo else t)
                else:
                    lo2[o[1]] = side[o[1]] - (t if side is lo else 0)
                    hi2[o[1]] = side[o[1]] + (0 if side is lo else t)
                out.append(add_box("Fairbeam waveguide port frame", lo2, hi2, mats.marker, collection))
        return out
    if length < 1e-12:
        bpy.ops.mesh.primitive_uv_sphere_add(radius=radius * 1.6, location=a, segments=32, ring_count=16)
        o = bpy.context.active_object
        o.name = "Fairbeam port marker"
        assign(o, mats.marker)
        move_to(o, collection)
        return [o]
    out.append(add_cylinder("Fairbeam port rod", radius, length, (a + b) / 2, ax, mats.marker, collection, vertices=24))
    for p in (a, b):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=radius * 1.9, location=p, segments=32, ring_count=16)
        o = bpy.context.active_object
        o.name = "Fairbeam port bead"
        for poly in o.data.polygons:
            poly.use_smooth = True
        assign(o, mats.marker)
        move_to(o, collection)
        out.append(o)
    return out


def build_smd(el, mats, collection):
    a, b = Vector(el["start"]), Vector(el["stop"])
    d = {"x": 0, "y": 1, "z": 2}.get(str(el.get("direction")).lower(), 0)
    lo = [min(a[i], b[i]) for i in range(3)]
    hi = [max(a[i], b[i]) for i in range(3)]
    length = hi[d] - lo[d]
    if length < 1e-9:
        return []
    for i in range(3):
        if i != d and hi[i] - lo[i] < length * 0.35:
            mid = (lo[i] + hi[i]) / 2
            lo[i], hi[i] = mid - length * 0.35, mid + length * 0.35
    cap = length * 0.2
    body_mat = {"resistor": mats.smd_body}.get(el.get("type"), mats.smd_body)
    if el.get("type") == "rlc" and el.get("C") and not el.get("R") and not el.get("L"):
        body_mat = mats.smd_tan
    out = []
    blo, bhi = list(lo), list(hi)
    blo[d] += cap * 0.9
    bhi[d] -= cap * 0.9
    out.append(add_box("Fairbeam SMD " + str(el.get("name", "")), blo, bhi, body_mat, collection))
    for side in (0, 1):
        clo, chi = list(lo), list(hi)
        if side == 0:
            chi[d] = lo[d] + cap
        else:
            clo[d] = hi[d] - cap
        out.append(add_box("Fairbeam SMD cap", clo, chi, mats.smd_cap, collection))
    return out


# ----------------------------------------------------------------------------------------------- scene
def clean_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)


def set_view_transform(scene):
    vs = scene.view_settings
    for name in ("AgX", "Filmic", "Standard"):
        try:
            vs.view_transform = name
            break
        except TypeError:
            continue
    import os
    forced = os.environ.get("FAIRBEAM_LOOK")
    # look names carry the transform's name in 4.x ("AgX - Punchy"), bare names in 3.x Filmic
    for look in ([forced] if forced else []) + ["AgX - Medium High Contrast", "Medium High Contrast", "Filmic - Medium High Contrast", "None"]:
        try:
            vs.look = look
            break
        except TypeError:
            continue
    try:
        scene.display_settings.display_device = "sRGB"
    except TypeError:
        pass
    vs.exposure = 0.0
    vs.gamma = 1.0


def setup_world(scene, background, radius):
    world = bpy.data.worlds.new("Fairbeam studio")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    # reflections: a soft gradient studio (bright above, dark floor) that metals can mirror
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    env = nt.nodes.new("ShaderNodeBackground")
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    nt.links.new(geo.outputs["Incoming"], sep.inputs[0])
    ramp.color_ramp.interpolation = "EASE"
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = linear_colour("#3A3C40")
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = linear_colour("#F4F5F7")
    mid = ramp.color_ramp.elements.new(0.5)
    mid.color = linear_colour("#9CA0A6")
    # incoming vector points toward the surface: z of the *viewing* direction -> remap -1..1 to 0..1
    mapr = nt.nodes.new("ShaderNodeMapRange")
    mapr.inputs["From Min"].default_value = 1.0
    mapr.inputs["From Max"].default_value = -1.0
    mapr.inputs["To Min"].default_value = 0.0
    mapr.inputs["To Max"].default_value = 1.0
    nt.links.new(sep.outputs["Z"], mapr.inputs["Value"])
    nt.links.new(mapr.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], env.inputs["Color"])
    env.inputs["Strength"].default_value = 0.4
    # what the camera sees directly: flat studio grey or dark
    cam_col = {"studio": "#F2F2F4", "dark": "#1B1D22"}.get(background)
    if cam_col is None:
        nt.links.new(env.outputs["Background"], out.inputs["Surface"])
    else:
        lp = nt.nodes.new("ShaderNodeLightPath")
        flat = nt.nodes.new("ShaderNodeBackground")
        flat.inputs["Color"].default_value = linear_colour(cam_col)
        flat.inputs["Strength"].default_value = 2.0 if background == "studio" else 1.0
        mix = nt.nodes.new("ShaderNodeMixShader")
        nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs["Fac"])
        nt.links.new(env.outputs["Background"], mix.inputs[1])
        nt.links.new(flat.outputs["Background"], mix.inputs[2])
        nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    scene.world = world


def add_area_light(scene, name, direction, centre, radius, energy_rel, size_rel, colour=(1, 1, 1), collection=None):
    data = bpy.data.lights.new(name, "AREA")
    data.shape = "DISK"
    data.size = radius * size_rel
    # power scales with the lit area so millimetre and metre designs are exposed alike
    data.energy = energy_rel * 1000.0 * (radius * 2.0) ** 2 * 0.07
    data.color = colour
    obj = bpy.data.objects.new(name, data)
    (collection or scene.collection).objects.link(obj)
    dirv = Vector(direction).normalized()
    obj.location = Vector(centre) + dirv * radius * 4.0
    obj.rotation_euler = (Vector(centre) - obj.location).to_track_quat("-Z", "Y").to_euler()
    return obj


def setup_lights(scene, centre, radius, view_dir, view_right, view_up, collection=None):
    """Three-point studio in the camera's frame: a soft key (upper left), a fill (right, weaker), a rim behind."""
    vd = Vector(view_dir).normalized()          # toward the camera
    vr = Vector(view_right).normalized()
    vu = Vector(view_up).normalized()
    key = add_area_light(scene, "Key", vd * 0.6 - vr * 0.9 + vu * 0.9, centre, radius, 1.0, 3.2, (1.0, 0.97, 0.93), collection)
    fill = add_area_light(scene, "Fill", vd * 0.9 + vr * 1.1 + vu * 0.15, centre, radius, 0.3, 4.5, (0.9, 0.95, 1.0), collection)
    rim = add_area_light(scene, "Rim", -vd * 0.9 + vr * 0.5 + vu * 0.8, centre, radius, 1.1, 2.0, (1.0, 1.0, 1.0), collection)
    top = add_area_light(scene, "Top", vd + vu * 0.15, centre, radius, 0.3, 6.0, (1.0, 1.0, 1.0), collection)
    return [key, fill, rim, top]


def enable_gpu(scene, want: str):
    """Pick the best Cycles GPU backend; returns a description (or "cpu")."""
    if want == "cpu":
        scene.cycles.device = "CPU"
        return "cpu"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
    except KeyError:
        scene.cycles.device = "CPU"
        return "cpu"
    for backend in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
        try:
            prefs.compute_device_type = backend
        except TypeError:
            continue
        try:
            prefs.get_devices()
        except Exception:  # noqa: BLE001
            continue
        gpus = [d for d in prefs.devices if d.type == backend]
        if not gpus:
            continue
        for d in prefs.devices:
            d.use = d.type == backend
        scene.cycles.device = "GPU"
        return backend.lower() + ":" + ", ".join(d.name for d in gpus)
    scene.cycles.device = "CPU"
    return "cpu"


def configure_render(scene, job):
    opts = job["options"]
    scene.render.engine = "CYCLES"
    cy = scene.cycles
    final = opts.get("quality") == "final"
    cy.samples = 256 if final else 32
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = 0.01 if final else 0.03
    cy.use_denoising = True
    try:
        cy.denoiser = "OPENIMAGEDENOISE"
    except TypeError:
        pass
    cy.max_bounces = 12 if final else 8
    cy.glossy_bounces = 8 if final else 6
    cy.transmission_bounces = 8 if final else 6
    cy.diffuse_bounces = 4
    cy.sample_clamp_indirect = 8.0
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    cy.film_exposure = 1.0
    device = enable_gpu(scene, job.get("device", "auto"))
    if device == "cpu" and job.get("threads"):
        scene.render.threads_mode = "FIXED"
        scene.render.threads = int(job["threads"])
    scene.render.resolution_x = int(opts["width"])
    scene.render.resolution_y = int(opts["height"])
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 15
    scene.render.film_transparent = opts.get("background") == "transparent"
    scene.render.use_file_extension = True
    set_view_transform(scene)
    return device


def run(job_path: str) -> int:
    with open(job_path, "r", encoding="utf-8") as fh:
        job = json.load(fh)
    opts = job["options"]
    t_start = time.time()
    say("stage", "import")
    clean_scene()
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    bpy.ops.import_scene.gltf(filepath=job["glb"])
    meshes = [o for o in scene.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("the GLB has no mesh objects")
    parts = {p["name"]: p for p in job.get("parts", [])}
    studio = bpy.data.collections.new("Fairbeam studio")
    scene.collection.children.link(studio)
    mats_cache: dict = {}
    pts0 = world_points(meshes)
    radius0 = max(max(max(p[i] for p in pts0) - min(p[i] for p in pts0) for i in range(3)) / 2, 1e-6)
    solder_mask = opts.get("solderMask") in ("green", True)

    say("stage", "materials")
    classified = {}
    for obj in list(meshes):
        key = part_key(obj, parts)
        info = parts.get(key, {"name": obj.name, "kind": "metal" if (obj.data.materials and obj.data.materials[0] and _gltf_metallic(obj.data.materials[0])) else "dielectric"})
        look = classify_part(info)
        classified[obj.name] = (obj, look)
        if look["look"] == "void":
            bpy.data.objects.remove(obj, do_unlink=True)
            continue
        assign(obj, material_for(look, radius0, solder_mask, mats_cache))
        for poly in obj.data.polygons:
            poly.use_smooth = False
    meshes = [o for o in scene.objects if o.type == "MESH"]
    classified = {n: v for n, v in classified.items() if v[0].name in bpy.data.objects}

    # --- film thickness for flat metal sheets (and the sheet list for connector planning)
    film = max(35e-6, radius0 * 2e-5)
    dielectrics = [(o, l) for o, l in classified.values() if l["kind"] == "dielectric"]
    sheets = []
    for obj, look in list(classified.values()):
        if look["kind"] != "metal":
            continue
        lo, hi = mesh_bounds(obj)
        tol = radius0 * 1e-6
        ax = _flat_axis(lo, hi, max(tol, 1e-9))
        if ax is None:
            continue
        sheets.append({"lo": lo, "hi": hi, "axis": ax, "obj": obj})
        # which side faces away from a touching dielectric
        direction = [0.0, 0.0, 0.0]
        plane = lo[ax]
        sign = 1.0
        for dobj, _l in dielectrics:
            dlo, dhi = mesh_bounds(dobj)
            if all(dlo[i] - tol * 10 <= hi[i] and lo[i] - tol * 10 <= dhi[i] for i in range(3) if i != ax):
                if abs(dhi[ax] - plane) <= max(radius0 * 1e-5, 1e-9):
                    sign = 1.0
                    break
                if abs(dlo[ax] - plane) <= max(radius0 * 1e-5, 1e-9):
                    sign = -1.0
                    break
        direction[ax] = sign
        thicken_sheet(obj, direction, film)
        lo2, hi2 = mesh_bounds(obj)
        sheets[-1]["lo"], sheets[-1]["hi"] = (lo, hi)  # the nominal sheet plane

    # --- ports, connectors, lumped elements
    say("stage", "ports")
    mats = Materials()
    port_mode = opts.get("ports", "auto")
    coll = studio
    marker_radius = max(radius0 * 0.006, 0.15e-3)
    extra_objects = []
    notes = []
    if port_mode != "hidden":
        for port in job.get("ports", []):
            placed = False
            if port.get("type") == "lumped" and port_mode in ("auto", "connector"):
                plan = plan_port_mount(port, [{"lo": s["lo"], "hi": s["hi"], "axis": s["axis"]} for s in sheets], radius0 * 1e-4 + 1e-6)
                if plan is not None:
                    if plan["mode"] == "free":
                        extra_objects += build_coax("Coax port %s" % port.get("number", ""), plan, mats, coll)
                    else:
                        extra_objects += build_sma("SMA port %s" % port.get("number", ""), plan, sma_dims(1.0), mats, coll)
                        if plan["mode"] == "edge":
                            extra_objects += build_edge_extras("SMA port %s" % port.get("number", ""), plan, mats, coll)
                    notes.append("port %s: %s (%s)" % (port.get("number"), "coax" if plan["mode"] == "free" else "SMA", plan["mode"]))
                    if plan["mode"] == "probe":     # the solder joint where the pin meets the patch
                        extra_objects.append(add_solder(plan["pin_to"], SMA["pin_d"] * 0.95, mats, coll))
                    placed = True
            if not placed:
                extra_objects += build_marker(port, mats, coll, marker_radius)
                notes.append("port %s: marker" % port.get("number"))
    for el in job.get("lumped", []):
        extra_objects += build_smd(el, mats, coll)
    say("note", "; ".join(notes) or "no ports")

    # --- ground shadow catcher
    all_meshes = [o for o in scene.objects if o.type == "MESH"]
    pts = world_points(all_meshes)
    lo = tuple(min(p[i] for p in pts) for i in range(3))
    hi = tuple(max(p[i] for p in pts) for i in range(3))
    centre = tuple((lo[i] + hi[i]) / 2 for i in range(3))
    radius = max(max(hi[i] - lo[i] for i in range(3)) / 2, 1e-6)
    ground_obj = None
    if opts.get("groundShadow"):
        bpy.ops.mesh.primitive_plane_add(size=radius * 40, location=(centre[0], centre[1], lo[2] - radius * 0.002))
        ground = bpy.context.active_object
        ground.name = "Fairbeam ground"
        move_to(ground, studio)
        ground.is_shadow_catcher = True
        ground_obj = ground
        gmat = bpy.data.materials.new("Fairbeam ground")
        gmat.use_nodes = True
        ground.data.materials.append(gmat)

    configure = configure_render(scene, job)
    setup_world(scene, opts.get("background", "transparent"), radius)

    # --- cameras
    cam_data = bpy.data.cameras.new("Fairbeam camera")
    cam = bpy.data.objects.new("Fairbeam camera", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    ortho = opts.get("projection") == "orthographic"
    cam_data.type = "ORTHO" if ortho else "PERSP"
    cam_data.lens = 70.0
    cam_data.sensor_width = 36.0
    cam_data.sensor_fit = "AUTO"
    aspect = opts["width"] / opts["height"]
    # lens fov along the sensor-fit axis: for AUTO that is the longer side
    long_fov = 2 * math.atan(cam_data.sensor_width / 2 / cam_data.lens)
    fov_y = 2 * math.atan(math.tan(long_fov / 2) / max(aspect, 1.0)) if aspect >= 1 else long_fov
    cam_data.clip_start = radius * 0.01
    cam_data.clip_end = radius * 400

    outputs = []
    angles = job["angles"]
    say("device", configure)
    say("count", len(angles))
    stamp = job["stamp"]
    for idx, angle in enumerate(angles):
        name, direction, up = angle_view(angle)
        fit = fit_camera(pts, direction, up, aspect, fov_y=fov_y, ortho=ortho)
        cam.location = fit["location"]
        cam.rotation_euler = (Vector(fit["target"]) - Vector(fit["location"])).to_track_quat("-Z", "Y").to_euler()
        # Y up of the camera must follow the requested up vector
        fwd = (Vector(fit["target"]) - Vector(fit["location"])).normalized()
        rot_up = Vector(up)
        quat = fwd.to_track_quat("-Z", "Y")
        cam.rotation_euler = quat.to_euler()
        cam.rotation_mode = "QUATERNION"
        z_axis = -fwd
        x_axis = Vector(up).cross(z_axis).normalized()
        y_axis = z_axis.cross(x_axis).normalized()
        cam.rotation_quaternion = Matrix(((x_axis.x, y_axis.x, z_axis.x), (x_axis.y, y_axis.y, z_axis.y), (x_axis.z, y_axis.z, z_axis.z))).to_quaternion()
        if ortho:
            cam_data.ortho_scale = fit["ortho_scale"]
        for obj in [o for o in scene.objects if o.type == "LIGHT"]:
            bpy.data.objects.remove(obj, do_unlink=True)
        setup_lights(scene, centre, radius, direction, fit["right"], fit["up"], studio)
        if ground_obj is not None:
            ground_obj.hide_render = direction[2] < -0.05      # looking from below: the floor would block the view
        path = job["outputs"][idx]
        scene.render.filepath = path[:-4] if path.lower().endswith(".png") else path
        if idx == 0 and job.get("blend"):
            # the scene as the user can open it in Blender: the first angle's camera and lights
            bpy.ops.wm.save_as_mainfile(filepath=job["blend"], compress=True)
            say("blend", job["blend"])
        say("angle", idx + 1, len(angles), name)
        t0 = time.time()
        bpy.ops.render.render(write_still=True)
        say("done", idx + 1, len(angles), path, round(time.time() - t0, 2))
        outputs.append(path)
    say("finished", round(time.time() - t_start, 2))
    return 0


def _gltf_metallic(mat) -> bool:
    try:
        node = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        return node.inputs["Metallic"].default_value > 0.5
    except (StopIteration, AttributeError, KeyError):
        return False


def main(argv=None) -> int:
    argv = sys.argv if argv is None else argv
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    if not args:
        print("usage: blender -b --factory-startup -P blender_render.py -- job.json")
        return 2
    try:
        return run(args[0])
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        say("error", f"{type(exc).__name__}: {exc}")
        return 1


if bpy is not None and __name__ == "__main__":
    code = main()
    if code:
        sys.exit(code)
