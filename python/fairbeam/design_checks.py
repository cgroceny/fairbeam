"""Checks against absurd design states: ``lint(design, values, bundle=None)``.

:func:`fairbeam.design.build` refuses what cannot be built at all. Many states build fine and are
still nonsense: a brick whose minimum is above its maximum, a port hanging in the air, a far-field
frequency outside the band, a mesh too big to run. ``lint`` finds them and returns a list of::

    {"severity": "error" | "warning", "path": "parts[1].primitives[0].radius",
     "code": "radius", "message": "the radius must be > 0"}

``path`` is the JSON path of the field (the designer marks it and jumps to it), ``code`` names the
check. Saving is always allowed (a work in progress may have errors; they come back with the save).
Errors stop a design from running: the server refuses a run, sweep or optimization of a design with
check errors (HTTP 422 with the list); warnings do not. The server runs ``lint`` with every design
preview, validation and save (with the preview bundle when there is one, for the mesh checks). The
cheap checks are mirrored in TypeScript (src/designer/checks.ts, same codes and paths) for instant
feedback while typing; scripts/check-designer.mjs keeps the two in step.

Pure Python (no numpy, no CSXCAD), so it runs in the server process as well as in the preview worker.
"""

from __future__ import annotations

import bisect
import copy
import math
import os
import re

from .design import (AXES, DT_SAFETY, auto_timesteps, ringdown_steps, EFFICIENCY_POINTS_DEFAULT, EFFICIENCY_POINTS_MAX, EFFICIENCY_POINTS_MIN, FIELD_PLANE_FREQS_MAX,
                     FIELD_PLANES_MAX, IDENTITY,
                     MAX_PRIMITIVES, DesignError, polyhedron_faces, apply_cuts, cut_pieces, sheet_plane, check_design, evaluate, in_plane, live_primitives, map_primitive, names_in, on_plane, prim_bbox, prim_contains, resolve_cuts,
                     port_feeds, resolve_primitive, sheet_transform_issues, thin_metal_limit, thin_sheets, transform_maps, wg_cutoff_ghz,
                     wg_mode)

EPS = 1e-9
# the Gaussian-derivative excitation (fairbeam.excitation, which needs numpy): -20 dB at f max, the
# pulse lasts 10 tau (its center is at 5 tau)
_DGAUSS_RATIO = 2.76
WARN_CELLS = 20e6
MAX_RATIO = 50
MAX_CELLS_DEFAULT = 40e6
# The end-criterion policy (src/designer/checks.ts END_DB_MIN / END_DB_MAX, the Solver field's min and
# max): simulation.end_criteria_db is a number of dB from -300 (the lowest a run accepts, server.py
# _settings) to -10. Above -10 dB a run stops before the fields have meaningfully decayed; this is
# fairbeam's limit for usable results, not a physical one. The error blocks the run.
END_DB_MIN = -300
END_DB_MAX = -10

# checks that src/designer/checks.ts also runs; the rest need the resolved geometry or the bundle
CHEAP = frozenset({
    "expr", "param-range", "part-name-duplicate", "part-empty", "brick-flat", "brick-inverted", "radius",
    "inner-radius", "cylinder-length", "polygon-points", "polygon-area", "polygon-self-intersect",
    "linpoly-length", "polyhedron", "polyhedron-flat", "copies", "mu-r", "eps-r", "tan-d", "tan-d-freq", "f-min", "f-order", "f-ratio", "ff-band", "nf2ff-pec",
    "cells-per-wavelength", "end-criterion", "port-length", "port-volume", "port-r", "port-reference", "port-overlap", "no-port",
    "no-metal", "resistor-r", "resistor-length", "component-path", "cone-radii", "cone-length", "torus-radii",
    "wire-points", "wg-mode", "wg-size", "wg-cutoff", "wg-aperture", "cut-sheet", "boolean-transform-angle", "sheet-transform-angle", "scale", "mesh-lines",
    "monitor-efficiency", "field-plane", "conductivity", "metal-thickness", "tan-d-band",
})


# Plain-language guidance shared by server checks and the live CHEAP checks.
EXPLANATIONS = {
    "port-reference": 'A complex power-wave reference is supported only on lumped ports and must contain exactly real and imag expressions. It is separate from the physical source resistance.',
    "boolean-transform-angle": "A live Boolean needs axis-aligned operands so its result stays exact. Use quarter-turn rotations for its operands, or materialise the Boolean before applying an arbitrary angle.",
    "sheet-transform-angle": "Zero-thickness metal sheets must stay parallel to the solver's coordinate planes. A lossy sheet must also keep its original plane normal because openEMS uses local CSXCAD bounding-box axes to set tangential loss. Rotate within the sheet plane, or give the metal finite thickness and refine the mesh.",
    "scale": "Every primitive remains exact only under positive uniform scaling. Use the same positive factor on x, y and z; nonuniform or nonpositive factors are unsupported.",
    "expr": "This value cannot be evaluated, so the geometry or simulation setting is unknown. Enter a valid number or expression and check its parameter names.",
    "param-range": "The parameter limits or default disagree, so edits and sweeps cannot use a consistent range. Put the minimum below the maximum and keep the default within those limits.",
    "part-name-duplicate": "Two solids share a name, which makes selection and geometry references ambiguous. Give each solid a unique name.",
    "part-empty": "This solid contains no shapes and contributes no geometry to the simulation. Add a shape or remove the unused solid.",
    "brick-flat": "The brick has no area because two or more dimensions are zero. Give it extent along at least two axes; one zero dimension is allowed for a sheet.",
    "brick-inverted": "A minimum coordinate is above its maximum, so the shape bounds are reversed. Swap the coordinates or correct the expressions that set them.",
    "radius": "An invalid radius prevents the shape from being built. Use a positive radius; a cone may have one zero radius for a sharp tip.",
    "inner-radius": "The tube needs a wall between its inner and outer radii. Set the inner radius to zero for a solid cylinder or to a positive value smaller than the outer radius.",
    "cylinder-length": "The cylinder axis has no valid length, so it cannot define a volume. Separate its endpoints or put the range minimum below the maximum.",
    "polygon-points": "A polygon needs at least three distinct vertices to enclose an area. Add or move points to form a closed outline.",
    "polygon-area": "The polygon points lie on a line, so the shape has no area. Move a vertex away from that line to give the outline a width.",
    "polygon-self-intersect": "The outline crosses itself, so its inside and outside are ambiguous. Reorder or move the vertices until only neighboring edges meet.",
    "polyhedron": "A polyhedron is a closed solid. It needs at least 4 vertices and 4 faces, and every face lists at least 3 different vertex numbers that exist (0 up to the number of vertices minus 1).",
    "polyhedron-flat": "All the vertices lie in one plane on some axis, so the solid has no thickness. Move at least one vertex off that plane.",
    "linpoly-length": "A zero extrusion length leaves a flat polygon instead of a solid. Enter a nonzero length if you intended a volume, or keep it flat intentionally.",
    "copies": "The copy count is invalid or produces more geometry than the designer allows. Use a whole number of zero or more and reduce combined transforms to at most 1000 copies.",
    "mu-r": "Relative permeability must be positive in the isotropic loss-free material model. Magnetic loss and dispersion are not represented.",
    "eps-r": "Relative permittivity below one is outside the dielectric model supported here. Use a value of at least one from the material data at your operating frequency.",
    "tan-d": "A negative loss tangent describes gain instead of a passive dielectric. Use zero for a lossless material or a positive loss tangent from its data sheet.",
    "tan-d-freq": "The loss model needs a positive reference frequency to interpret the loss tangent. Enter the frequency in GHz at which the material's loss tangent was specified.",
    "tan-d-band": "openEMS models dielectric loss as a constant conductivity, so the loss tangent is exact only at the frequency given with it and scales as that frequency over f elsewhere. A datasheet value at 10 GHz used for a 2.45 GHz antenna makes its loss about four times too high. Give the frequency the design works at, for example f0, or leave the field empty for the band center.",
    "conductivity": "A metal's conductivity must be positive to describe a lossy conductor. Enter it in S/m (copper 5.8e7, aluminium 3.5e7, gold 4.1e7), or leave it empty for a perfect conductor.",
    "metal-thickness": "A lossy metal sheet is modeled with a finite thickness, which must be positive. Enter the copper thickness in mm (0.035 for 1 oz copper), or leave it empty for the default 0.035 mm.",
    "f-min": "The simulated band must start above zero for the excitation and frequency results to be meaningful. Set a positive minimum frequency in GHz.",
    "f-order": "An empty or reversed frequency band cannot define the simulation. Set the maximum frequency above the minimum.",
    "f-ratio": "A very wide band combines a fine mesh with a long simulation time. Narrow the band to the frequencies you need or split it into separate runs.",
    "nf2ff-pec": "The far-field box leaves out a face that lies on a PEC or PMC boundary (the wall mirrors it), so enabling that face has no effect. Turn the face off to match what is simulated; ground-plane and half-space models skip the face on the ground.",
    "ff-band": "A far-field result outside the simulated band is not reliable. Move this frequency into the band or expand the simulation band to include it.",
    "cells-per-wavelength": "Too few cells cannot accurately represent the changing electromagnetic fields. Set a positive resolution, usually at least 15 cells per wavelength, and check convergence with a finer mesh.",
    "end-criterion": "The stop threshold measures how far the field energy has decayed below its peak, in dB. Fairbeam accepts -10 to -300 dB, because a run stopped above -10 dB has not meaningfully decayed. Use about -40 dB for a quick look and -60 dB for accurate S-parameters and efficiency.",
    "port-length": "The port has no length along its excitation direction, so it cannot drive or measure the intended field. Separate start and stop on that axis; an excited waveguide port needs at least a mesh cell between excitation and probe.",
    "port-volume": "A lumped port with width in both transverse directions fills a volume instead of the intended feed gap. Make it a line or sheet by matching start and stop on at least one transverse axis.",
    "port-r": "The port impedance must be positive to define a physical load and meaningful S-parameters. Enter a positive resistance in ohms, commonly 50.",
    "port-overlap": "Overlapping ports drive or measure the same region and can interfere with each other. Move or resize the ports so their bounds do not touch or overlap.",
    "no-port": "Without a port the design has no excitation or S-parameter measurement. Add a suitable lumped or waveguide port and connect it to the intended feed.",
    "no-metal": "There is no metal solid to carry the antenna current in this design. Add a conductor or assign a metal material to the intended conducting solid.",
    "resistor-r": "A zero or negative resistance does not define the passive resistor expected here. Enter a positive resistance in ohms.",
    "resistor-length": "The resistor has no extent along its current direction, so it cannot bridge a gap. Separate its endpoints on the selected direction axis.",
    "component-path": "An empty folder name makes the component hierarchy ambiguous. Use nonempty names separated by slashes, such as antenna/feed, or leave the whole path empty.",
    "cone-radii": "With both radii zero the cone collapses to a line and has no volume. Give at least one end a positive radius.",
    "cone-length": "The cone needs a positive axial length to define a volume. Put its range minimum below its maximum.",
    "torus-radii": "The tube radius reaches or crosses the torus axis, creating an unsupported shape. Make the minor radius smaller than the major radius and keep both positive.",
    "wire-points": "The wire has no path unless it contains at least two distinct points. Add an endpoint or move a point away from the others.",
    "wg-mode": "The waveguide excitation needs a supported rectangular TE mode. Enter TEmn with single-digit indices, such as TE10, and do not use TE00.",
    "wg-size": "A waveguide needs a positive width and height to define its mode field. Set both a and b to positive dimensions in millimeters.",
    "wg-cutoff": "Below cutoff the selected mode does not propagate, so its S-parameters are not meaningful there. Raise the band above cutoff or enlarge the guide to lower cutoff.",
    "wg-aperture": "The port cross-section does not match the dimensions used to calculate its mode field. Adjust the port bounds or a and b so the aperture and mode dimensions agree.",
    "cut-sheet": "A rectangle cut must lie in the plane of the sheet it removes material from. Make start and stop equal on exactly one axis and give the other two axes a positive extent.",
    "monitor-efficiency": "The efficiency over the band is computed from the far-field box after the run, so it needs the far field and a usable number of frequencies. Turn the far field on and use a whole number of frequencies from 3 to 201; 21 is usually enough.",
    "field-plane": "A field plane records E or H at a few frequencies inside the simulated band, and each map adds to the run's memory and result size. Give each plane one to four frequencies within the band and use at most four planes.",
    "field-plane-position": "A field plane outside the simulation domain cannot be recorded where it was placed; the run would record it at the domain's edge instead. Move the plane's position inside the domain shown by the 3D view's domain box.",
    "monitor-band": "A current monitor outside the simulated band cannot give a reliable frequency result. Move its frequency into the band or expand the band to include it.",
    "smallest-cell": "The timestep follows the smallest cell, so the shape named here sets how long the run takes. Make that detail coarser, model thin metal as a sheet, or merge outlines that differ by a hair.",
    "thin-metal-volume": "Meshing thin metal as a volume needs cells a few micrometres wide. The timestep follows the smallest cell, so the run would need tens of times more timesteps and often never converge. Thin plates are therefore built as sheets even with thin metal set to volume; the sheet keeps the thickness for losses and exports.",
    "slow-ringdown": "A thin, low-loss substrate between a patch and its ground is a high-Q cavity: after the excitation its fields ring for tens of nanoseconds, and the fine timestep of a thin substrate turns that into hundreds of thousands of timesteps. The run stops at max timesteps, so a limit below the ring-down leaves the result unconverged. Raise max timesteps (or leave it empty for the automatic limit).",
    "run-too-long": "The excitation pulse and the fields' decay after it would need more cells x timesteps than the run budget, usually because a tiny cell (thin metal kept as a volume, or two outlines a hair apart) forces a very small timestep. Remove the cause named in the message, or accept a long run by setting max timesteps yourself.",
    "thin-metal": "This thin conductor is simulated as a sheet so its thickness does not force tiny mesh cells and a very short timestep. No fix is needed for an intended sheet model; the thickness is kept for the losses and the exports. Metal at least 0.6 cells thick keeps its volume.",
    "port-floating": "This port endpoint touches no conductor, so the feed may not deliver current to the antenna. Move the endpoint onto the intended metal face and check both ends of the feed gap.",
    "port-in-metal": "Metal covers part of the port and can short its excitation. Place the endpoints on the facing conductor surfaces so the port spans only the gap between them.",
    "metal-overhang": "This metal lies on a dielectric face but reaches past the dielectric's edge, so part of it hangs in the air where a printed conductor has no board. Shrink or move the metal, or enlarge the dielectric under it, unless the overhang is intended.",
    "metal-floating": "This metal touches no other metal, no dielectric and no port, so it is an isolated conductor in the air that only coupling can reach. Move it onto the intended face or conductor; a deliberate parasitic element (a director, a reflector, a stacked patch) may stay as it is.",
    "port-at-null": "If this thin conductor is a resonant patch above a substrate and ground, a center feed can sit near a fundamental-mode voltage null and couple poorly. Move it off center along the resonant length if that matches your design; the fix button offers a starting offset to tune.",
    "part-hidden": "Another solid with equal or higher priority fully covers this solid, so it has no effect on the simulation. Raise its priority if it should replace that material, move it, or remove it if unused.",
    "boolean-cut-erases": "A cut-out (a subtracted curved shape) is a vacuum shape above its host solid, so everything with the same or a lower priority inside it is erased too, not only the host. Raise the priority of a solid that must stay inside the cut-out, such as a pin or the substrate.",
    "boolean-cut-reach": "A cut-out only removes what it reaches. This one leaves a gap to a zero-thickness sheet of its own solid, or has no thickness itself, so the sheet stays whole there. Let the cut-out touch or cross the sheet, and give it a thickness.",
    "cut-unsupported": "A cut removes area from flat sheets in its plane (rectangular sheets, polygons, flat circles), not volume from a solid. The cut plane crosses a solid of this part: make that shape a sheet, or carve it with a Boolean subtract.",
    "cut-unused": "This cut touches no flat sheet in its plane, so it removes nothing. Move it onto the intended sheet and check that its outline overlaps the sheet.",
    "cut-all": "The cuts remove the entire sheet, leaving no conductor or material there. Reduce or move the cuts if any of the sheet should remain.",
    "mesh-cells": "A large mesh needs more memory and time and may exceed the server's cell limit. Reduce cells per wavelength, lower the maximum frequency, or simplify fine details while checking accuracy.",
    "mesh-warning": "The automatic mesher found geometry or spacing that may make the grid costly or inaccurate. Review the detail in this message and adjust the nearby geometry or mesh settings before running again.",
    "mesh-feature": "This feature falls between mesh lines and may disappear from the simulated geometry. Thicken it, model thin metal as a sheet, or refine the mesh until it is resolved.",
    "mesh-lines": "Manual mesh lines need at least two finite, strictly increasing coordinates on each axis. Correct the line list or switch to automatic mesh.",
    "mesh-lines-parity": "The built mesh differs from the manual line list. Rebuild the preview and check that no line was omitted or changed.",
    "air-pad": "The open boundaries absorb the outgoing wave only if they stand far enough from the structure; with the air padding this small the reflections from them, and the box the far field is computed on, come too near the antenna. Use about a quarter wavelength at f min, which the automatic padding gives when the field is left empty.",
    "excitation-too-long": "The excitation pulse uses too much of the timestep budget, leaving too little time for fields to decay and results to converge. Model thin metal as sheets, coarsen the finest detail, or increase max timesteps and check convergence.",
    "wire-thin": "The mesh is wider than the wire, so the simulated radius is controlled by the grid instead of the drawn radius. Increase the wire radius or refine the mesh across it and check convergence.",
    "structure": "The design contains an invalid or missing field, so further checks cannot safely inspect it. Correct the field named in the message and validate the design again.",
    "build": "The server could not build the simulation geometry or settings, so no valid preview can be produced. Correct the field or unsupported geometry described in the message and try the preview again."
}

def max_cells() -> float:
    return float(os.environ.get("FAIRBEAM_MAX_CELLS", MAX_CELLS_DEFAULT))


def _given(v) -> bool:
    """An optional expression field that is set (not missing, None or blank)."""
    return v is not None and not (isinstance(v, str) and not v.strip())


def _num(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _num_text(v: float) -> str:
    """A coordinate as a fix writes it: at most six decimals, no trailing zeros."""
    t = f"{round(v, 6):.6f}".rstrip("0").rstrip(".")
    return "0" if t in ("", "-0") else t


def _time_text(seconds: float) -> str:
    """A duration in the unit that keeps 1 to 999 in front: 1.18 ps, 35.1 fs, 1.81 ns (never 1.18e+03 fs)."""
    units = (("fs", 1e-15), ("ps", 1e-12), ("ns", 1e-9), ("µs", 1e-6), ("ms", 1e-3), ("s", 1.0))
    for i, (name, size) in enumerate(units):
        value = float(f"{seconds / size:.3g}")
        if value < 1000 or i == len(units) - 1:
            return f"{value:g} {name}"
    return f"{seconds:g} s"


class _Lint:
    def __init__(self, design: dict, values: dict | None, bundle: dict | None):
        self.d, self.bundle = design, bundle
        self.values = values or {}
        self.out: list[dict] = []
        self.V: dict[str, float] = {}   # path -> value of every expression field that evaluates
        self.names: dict[str, float] = {}
        self.failed: set[str] = set()   # parameters that do not evaluate
        self.band: tuple[float, float] | None = None   # (f min, f max) in GHz when both evaluate
        self.sheets: list[dict] = []   # thin metal the build turns into sheets (design.thin_sheets)
        self.thin_volume: list[dict] = []   # thin metal kept as a volume (mesh.thin_metal volume)
        self._boxes: dict[int, tuple] = {}   # id(resolved primitive) -> prim_bbox, for this run
        self.partial = False   # some geometry did not resolve (see _resolve)

    def _bbox(self, p: dict):
        box = self._boxes.get(id(p))
        if box is None:
            box = self._boxes[id(p)] = prim_bbox(p)
        return box

    def _holds(self, p: dict, q, tol: float) -> bool:
        """prim_contains(p, q, tol) with p's bounding box computed once per run: the geometry checks
        ask every metal shape about every port end, so for an array (N ports, N patches) the box test
        that rejects almost every pair was most of an N² cost."""
        lo, hi = self._bbox(p)
        if any(q[k] < lo[k] - tol or q[k] > hi[k] + tol for k in range(3)):
            return False   # the same first test as prim_contains
        return prim_contains(p, q, tol)

    def add(self, severity: str, path: str, code: str, message: str, fix: dict | None = None):
        """``fix``: an edit the designer offers as a button, ``{"label", "set": {path: value}}``."""
        c = {"severity": severity, "path": path, "code": code, "message": message}
        if explain := EXPLANATIONS.get(code):
            c["explain"] = explain
        if fix:
            c["fix"] = fix
        self.out.append(c)

    def error(self, path, code, message, fix=None):
        self.add("error", path, code, message, fix)

    def warn(self, path, code, message, fix=None):
        self.add("warning", path, code, message, fix)

    def info(self, path, code, message):
        """A note: nothing is wrong, but the build does something the drawing does not show."""
        self.add("info", path, code, message)

    # ---------------------------------------------------------------- values

    def ev(self, path: str, expr, optional=False):
        """Evaluate one expression field; record an error (unless it only fails because a
        parameter it uses failed, which is reported there)."""
        if expr is None or expr == "":
            if not optional:
                self.error(path, "expr", "needs a value")
            return None
        try:
            v = evaluate(expr, self.names)
        except DesignError as e:
            try:
                if names_in(expr) & self.failed:
                    return None
            except DesignError:
                pass
            self.error(path, "expr", e.detail)
            return None
        self.V[path] = v
        return v

    def vec(self, path: str, v, n=3):
        if not isinstance(v, list) or len(v) != n:
            self.error(path, "expr", f"expected a list of {n} values")
            return None
        out = [self.ev(f"{path}[{k}]", x) for k, x in enumerate(v)]
        return None if any(x is None for x in out) else out

    def params(self):
        for i, p in enumerate(self.d.get("params", [])):
            w = f"params[{i}]"
            key = p["key"]
            if "expr" in p:
                v = self.ev(f"{w}.expr", p["expr"])
                if v is None:
                    self.failed.add(key)
                else:
                    self.names[key] = v
                continue
            value = self.values.get(key, p["default"])
            self.names[key] = float(value)
            lo, hi = p.get("min"), p.get("max")
            if _num(lo) and _num(hi) and lo > hi:
                self.error(f"{w}.max", "param-range", f"the minimum {lo:g} is above the maximum {hi:g}")
            elif _num(lo) and p["default"] < lo:
                self.error(f"{w}.default", "param-range", f"the default {p['default']:g} is below the minimum {lo:g}")
            elif _num(hi) and p["default"] > hi:
                self.error(f"{w}.default", "param-range", f"the default {p['default']:g} is above the maximum {hi:g}")

    # ---------------------------------------------------------------- per field

    def materials(self):
        for m in self.d.get("materials", []):
            w = f"materials.{m['name']}"
            if m["kind"] == "metal":
                # lossy metal (design.metal_loss): empty conductivity = PEC
                if _given(m.get("conductivity")):
                    s = self.ev(f"{w}.conductivity", m["conductivity"])
                    if s is not None and s <= 0:
                        self.error(f"{w}.conductivity", "conductivity",
                                   f"σ = {s:g} S/m: the conductivity must be > 0 (leave it empty for a perfect conductor)")
                    if _given(m.get("thickness")):
                        t = self.ev(f"{w}.thickness", m["thickness"])
                        if t is not None and t <= 0:
                            self.error(f"{w}.thickness", "metal-thickness", "the sheet thickness must be > 0 mm")
                continue
            if m["kind"] != "dielectric":
                continue
            mu = self.ev(f"{w}.mu_r", m.get("mu_r", 1))
            if mu is not None and mu <= 0:
                self.error(f"{w}.mu_r", "mu-r", "relative permeability must be > 0")
            eps = self.ev(f"{w}.eps_r", m.get("eps_r", 1))
            if eps is not None and eps < 1:
                self.error(f"{w}.eps_r", "eps-r", f"εr = {eps:g} is below 1 (vacuum)")
            tan = self.ev(f"{w}.tan_d", m.get("tan_d", 0))
            if tan is not None and tan < 0:
                self.error(f"{w}.tan_d", "tan-d", f"tan δ = {tan:g} is negative (a material with gain)")
            if m.get("tan_d_freq") is not None:
                f = self.ev(f"{w}.tan_d_freq", m["tan_d_freq"])
                if f is not None and f <= 0:
                    self.error(f"{w}.tan_d_freq", "tan-d-freq", "the loss tangent frequency must be > 0")

    def primitive(self, pr: dict, wp: str):
        kind = pr["kind"]
        if kind == "box":
            a, c = self.vec(f"{wp}.start", pr.get("start")), self.vec(f"{wp}.stop", pr.get("stop"))
            if a is None or c is None:
                return
            flat = [k for k in range(3) if abs(c[k] - a[k]) < EPS]
            for k in range(3):
                if a[k] - c[k] >= EPS:
                    X = AXES[k].upper()
                    self.error(f"{wp}.stop[{k}]", "brick-inverted", f"{X}min ({a[k]:g}) is above {X}max ({c[k]:g})")
            if len(flat) > 1:
                ax = " and ".join(AXES[k].upper() for k in flat)
                self.error(f"{wp}.stop[{flat[-1]}]", "brick-flat",
                           f"zero size along {ax}: a brick needs extent in at least two directions (one zero is a sheet)")
        elif kind == "cylinder":
            r = self.ev(f"{wp}.radius", pr.get("radius"))
            ri = self.ev(f"{wp}.inner_radius", pr.get("inner_radius", 0), optional=True) if "inner_radius" in pr else 0.0
            if r is not None and r <= 0:
                self.error(f"{wp}.radius", "radius", "the radius must be > 0")
            if ri is not None and (ri < 0 or (r is not None and r > 0 and ri >= r)):
                self.error(f"{wp}.inner_radius", "inner-radius",
                           "the inner radius must be 0 (solid) or between 0 and the outer radius")
            if "axis" in pr:
                self.vec(f"{wp}.center", pr.get("center"), 2)
                rg = self.vec(f"{wp}.range", pr.get("range"), 2)
                if rg is not None and rg[1] - rg[0] < -EPS:
                    # equal ends are fine: a flat circle (a disc or ring), built as a polygon sheet
                    A = pr["axis"].upper()
                    self.error(f"{wp}.range[1]", "cylinder-length",
                               f"{A}min ({rg[0]:g}) must be below {A}max ({rg[1]:g})")
            else:
                a, c = self.vec(f"{wp}.start", pr.get("start")), self.vec(f"{wp}.stop", pr.get("stop"))
                if a is not None and c is not None and all(abs(a[k] - c[k]) < EPS for k in range(3)):
                    self.error(f"{wp}.stop", "cylinder-length", "the axis start and stop are the same point")
        elif kind == "sphere":
            self.vec(f"{wp}.center", pr.get("center"))
            r = self.ev(f"{wp}.radius", pr.get("radius"))
            if r is not None and r <= 0:
                self.error(f"{wp}.radius", "radius", "the radius must be > 0")
        elif kind == "cone":
            self.vec(f"{wp}.center", pr.get("center"), 2)
            rb = self.ev(f"{wp}.bottom_radius", pr.get("bottom_radius"))
            rt = self.ev(f"{wp}.top_radius", pr.get("top_radius", 0))
            for r, key in ((rb, "bottom_radius"), (rt, "top_radius")):
                if r is not None and r < 0:
                    self.error(f"{wp}.{key}", "radius", "the radius must be >= 0 (0: a sharp tip)")
            if rb is not None and rt is not None and rb <= 0 and rt <= 0 and rb > -EPS and rt > -EPS:
                self.error(f"{wp}.bottom_radius", "cone-radii", "both radii are 0: the cone has no volume")
            rg = self.vec(f"{wp}.range", pr.get("range"), 2)
            if rg is not None and rg[1] - rg[0] < EPS:
                A = pr["axis"].upper()
                self.error(f"{wp}.range[1]", "cone-length", f"{A}min ({rg[0]:g}) must be below {A}max ({rg[1]:g})")
        elif kind == "wire":
            r = self.ev(f"{wp}.radius", pr.get("radius"))
            if r is not None and r <= 0:
                self.error(f"{wp}.radius", "radius", "the radius must be > 0")
            pts = pr.get("points")
            if not isinstance(pts, list):
                self.error(f"{wp}.points", "wire-points", "a wire needs at least 2 distinct points")
                return
            xyz = [self.vec(f"{wp}.points[{k}]", q) for k, q in enumerate(pts)]
            if any(q is None for q in xyz):
                return
            if len(xyz) < 2 or all(math.dist(xyz[0], q) < EPS for q in xyz):
                self.error(f"{wp}.points", "wire-points", "a wire needs at least 2 distinct points")
        elif kind == "polyhedron":
            verts = pr.get("vertices")
            if not isinstance(verts, list) or len(verts) < 4:
                self.error(f"{wp}.vertices", "polyhedron", "a polyhedron needs at least 4 vertices and 4 faces")
                return
            xyz = [self.vec(f"{wp}.vertices[{k}]", q) for k, q in enumerate(verts)]
            try:
                polyhedron_faces(pr.get("faces"), len(verts), wp)
            except DesignError as e:
                self.error(e.where or f"{wp}.faces", "polyhedron", e.detail)
                return
            if all(q is not None for q in xyz):
                lo = [min(q[k] for q in xyz) for k in range(3)]
                hi = [max(q[k] for q in xyz) for k in range(3)]
                if sum(1 for k in range(3) if hi[k] - lo[k] < EPS) >= 1:
                    self.error(f"{wp}.vertices", "polyhedron-flat", "all vertices lie in one plane on an axis: the polyhedron has no volume")
        elif kind == "torus":
            self.vec(f"{wp}.center", pr.get("center"))
            big = self.ev(f"{wp}.major_radius", pr.get("major_radius"))
            small = self.ev(f"{wp}.minor_radius", pr.get("minor_radius"))
            for r, key in ((big, "major_radius"), (small, "minor_radius")):
                if r is not None and r <= 0:
                    self.error(f"{wp}.{key}", "radius", "the radius must be > 0")
            if big is not None and small is not None and 0 < big <= small:
                self.error(f"{wp}.minor_radius", "torus-radii",
                           f"the tube radius ({small:g}) must be below the major radius ({big:g}): the tube would cross the axis")
        else:
            self.ev(f"{wp}.elevation", pr.get("elevation", 0))
            pts = pr.get("points")
            if not isinstance(pts, list):
                self.error(f"{wp}.points", "polygon-points", "a polygon needs at least 3 distinct points")
                return
            uv = [self.vec(f"{wp}.points[{k}]", q, 2) for k, q in enumerate(pts)]
            if kind == "linpoly":
                length = self.ev(f"{wp}.length", pr.get("length"))
                if length is not None and abs(length) < EPS:
                    self.warn(f"{wp}.length", "linpoly-length", "zero extrusion length: this is a flat polygon")
            if any(q is None for q in uv):
                return
            for code, msg in polygon_problems(uv):
                self.error(f"{wp}.points", code, msg)

    def parts(self):
        seen: set[str] = set()

        def boolean_operand_transforms(operand, path):
            for k, tr in enumerate(operand.get("transforms") or []):
                if tr.get("type") != "rotate":
                    continue
                wt = f"{path}.transforms[{k}]"
                angle = self.ev(f"{wt}.angle", tr.get("angle"))
                if angle is not None and abs(angle / 90 - round(angle / 90)) > 1e-9:
                    self.error(f"{wt}.angle", "boolean-transform-angle",
                               "live Boolean operands must stay axis-aligned (quarter turns are allowed)")
            history = operand.get("booleanHistory")
            if isinstance(history, dict) and history.get("live"):
                boolean_operand_transforms(history.get("A") or {}, f"{path}.booleanHistory.A")
                boolean_operand_transforms(history.get("B") or {}, f"{path}.booleanHistory.B")

        for i, pt in enumerate(self.d.get("parts", [])):
            w = f"parts[{i}]"
            if pt["name"] in seen:
                self.error(f"{w}.name", "part-name-duplicate", f"another solid is already called {pt['name']!r}")
            seen.add(pt["name"])
            if not pt["primitives"]:
                self.warn(w, "part-empty", "this solid has no shapes")
            comp = pt.get("component")
            if comp is not None and comp != "" and any(not seg.strip() for seg in comp.split("/")):
                self.warn(f"{w}.component", "component-path",
                          f"component {comp!r} has an empty folder name (write folders as 'antenna/feed')")
            for j, pr in enumerate(pt["primitives"]):
                self.primitive(pr, f"{w}.primitives[{j}]")
            for k, c in enumerate(pt.get("cuts") or []):
                wc = f"{w}.cuts[{k}]"
                if c.get("kind", "rect") == "circle":
                    self.vec(f"{wc}.center", c.get("center"), 2)
                    self.ev(f"{wc}.elevation", c.get("elevation", 0))
                    r = self.ev(f"{wc}.radius", c.get("radius"))
                    if r is not None and r <= 0:
                        self.error(f"{wc}.radius", "radius", "the radius must be > 0")
                    continue
                if c.get("kind", "rect") == "polygon":
                    self.ev(f"{wc}.elevation", c.get("elevation", 0))
                    pts = c.get("points")
                    if not isinstance(pts, list):
                        self.error(f"{wc}.points", "polygon-points", "a polygon needs at least 3 distinct points")
                        continue
                    uv = [self.vec(f"{wc}.points[{m}]", q, 2) for m, q in enumerate(pts)]
                    if all(q is not None for q in uv):
                        for code, msg in polygon_problems(uv):
                            self.error(f"{wc}.points", code, msg)
                    continue
                a, b = self.vec(f"{wc}.start", c.get("start")), self.vec(f"{wc}.stop", c.get("stop"))
                if a is None or b is None:
                    continue
                flat = [q for q in range(3) if abs(b[q] - a[q]) < EPS]
                if len(flat) != 1:
                    self.error(f"{wc}.stop", "cut-sheet",
                               "a cut is a rectangle on a plane: min = max on exactly one axis (the plane of the sheets it cuts)")
                    continue
                for q in range(3):
                    if a[q] - b[q] >= EPS:
                        X = AXES[q].upper()
                        self.error(f"{wc}.stop[{q}]", "brick-inverted", f"{X}min ({a[q]:g}) is above {X}max ({b[q]:g})")
            count = 1
            for k, tr in enumerate(pt.get("transforms") or []):
                wt = f"{w}.transforms[{k}]"
                if tr["type"] == "move":
                    self.vec(f"{wt}.offset", tr.get("offset"))
                elif tr["type"] == "scale":
                    factors = self.vec(f"{wt}.factors", tr.get("factors"))
                    self.vec(f"{wt}.origin", tr.get("origin"))
                    n = self.ev(f"{wt}.copies", tr.get("copies", 0))
                    if factors is not None:
                        if any(x <= 0 for x in factors):
                            self.error(f"{wt}.factors", "scale", "scale factors must be positive")
                        elif max(factors) - min(factors) > 1e-12 * max(1.0, *(abs(x) for x in factors)):
                            self.error(f"{wt}.factors", "scale",
                                       "nonuniform scaling is unsupported; all three factors must be equal")
                    if n is None:
                        continue
                    if abs(n - round(n)) > 1e-9 or n < 0:
                        self.error(f"{wt}.copies", "copies", "the number of copies must be a whole number >= 0")
                        continue
                    count *= int(round(n)) + 1
                    if count > 1001:
                        self.error(f"{wt}.copies", "copies", "at most 1000 copies of a solid")
                elif tr["type"] == "rotate":
                    self.vec(f"{wt}.center", tr.get("center"))
                    self.ev(f"{wt}.angle", tr.get("angle"))
                    n = self.ev(f"{wt}.copies", tr.get("copies", 0))
                    if n is None:
                        continue
                    if abs(n - round(n)) > 1e-9 or n < 0:
                        self.error(f"{wt}.copies", "copies", "the number of copies must be a whole number >= 0")
                        continue
                    count *= int(round(n)) + 1
                    if count > 1001:
                        self.error(f"{wt}.copies", "copies", "at most 1000 copies of a solid")
                elif tr["type"] == "translate":
                    n = self.ev(f"{wt}.copies", tr.get("copies"))
                    self.vec(f"{wt}.step", tr.get("step"))
                    if n is None:
                        continue
                    if abs(n - round(n)) > 1e-9 or n < 0:
                        self.error(f"{wt}.copies", "copies", "the number of copies must be a whole number >= 0")
                        continue
                    count *= int(round(n)) + 1
                    if count > 1001:
                        self.error(f"{wt}.copies", "copies", "at most 1000 copies of a solid")
                else:
                    if tr.get("point") is not None:
                        self.vec(f"{wt}.point", tr.get("point"))
                    if tr.get("keep", True):
                        count *= 2
                        if count > 1001:
                            self.error(f"{wt}.plane", "copies", "at most 1000 copies of a solid")
            history = pt.get("booleanHistory")
            if isinstance(history, dict) and history.get("live"):
                boolean_operand_transforms(history.get("A") or {}, f"{w}.booleanHistory.A")
                boolean_operand_transforms(history.get("B") or {}, f"{w}.booleanHistory.B")
        if not any(self._metal(pt) for pt in self.d.get("parts", [])):
            self.error("parts", "no-metal", "the design has no metal solid: nothing to excite or radiate")

    def _metal(self, pt) -> bool:
        return any(m["name"] == pt["material"] and m["kind"] == "metal" for m in self.d.get("materials", []))

    def loss_band(self):
        """A loss tangent given at a frequency outside the band: openEMS applies tan δ as a constant
        conductivity (simulation.Simulation.dielectric), so at f the loss is tan δ · f_ref / f."""
        if not self.band:
            return
        f0, f1 = self.band
        fc = (f0 + f1) / 2
        for m in self.d.get("materials", []):
            w = f"materials.{m['name']}"
            f_ref, tan = self.V.get(f"{w}.tan_d_freq"), self.V.get(f"{w}.tan_d")
            if m["kind"] != "dielectric" or f_ref is None or f_ref <= 0 or not tan or tan <= 0 or f0 <= f_ref <= f1:
                continue
            # the one-click fix: the design frequency when the design has an f0 parameter inside the
            # band, else the band center (src/designer/checks.ts does the same)
            k = next(i for i, x in enumerate(self.d["materials"]) if x is m)
            if "f0" in {p.get("key") for p in self.d.get("params", [])} and f0 <= self.names.get("f0", -1) <= f1:
                fix = {"label": "Give tan δ at f0", "set": {f"materials[{k}].tan_d_freq": "f0"}}
            else:
                fix = {"label": f"Give tan δ at the band center ({fc:g} GHz)", "set": {f"materials[{k}].tan_d_freq": f"{fc:g}"}}
            self.warn(f"{w}.tan_d_freq", "tan-d-band",
                      f"tan δ holds at {f_ref:g} GHz only, outside the band ({f0:g} to {f1:g} GHz): openEMS applies "
                      f"it as a constant conductivity, so at the band center the loss is {f_ref / fc:.2f} times "
                      "the given tan δ. Give the frequency the design works at (e.g. f0), or leave it empty "
                      "for the band center", fix)

    def simulation(self):
        s = self.d.get("simulation", {})
        f0 = self.ev("simulation.f_min", s.get("f_min", 1))
        f1 = self.ev("simulation.f_max", s.get("f_max", 3))
        band = None
        if f0 is not None and f0 <= 0:
            self.error("simulation.f_min", "f-min", "f min must be > 0")
        elif f0 is not None and f1 is not None:
            if f0 >= f1:
                self.error("simulation.f_max", "f-order", f"f max ({f1:g} GHz) must be above f min ({f0:g} GHz)")
            else:
                band = self.band = (f0, f1)
                if f1 / f0 > MAX_RATIO:
                    self.warn("simulation.f_max", "f-ratio",
                              f"f max / f min = {f1 / f0:.0f}: a band this wide needs a very long run and a fine mesh")
        if "end_criteria_db" in s:
            end = s["end_criteria_db"]
            if not _num(end) or not math.isfinite(end):
                self.error("simulation.end_criteria_db", "end-criterion",
                           f"the end criterion is a number of dB from {END_DB_MIN} to {END_DB_MAX}")
            elif end > END_DB_MAX:
                self.error("simulation.end_criteria_db", "end-criterion",
                           f"{end:g} dB is above the {END_DB_MAX} dB limit: the run would stop before the field energy "
                           f"has decayed by {-END_DB_MAX} dB (-40 quick, -60 accurate)")
            elif end < END_DB_MIN:
                self.error("simulation.end_criteria_db", "end-criterion",
                           f"{end:g} dB is below the {END_DB_MIN} dB limit that runs accept")
        m = self.d.get("mesh", {})
        if m.get("mode") == "manual":
            raw = m.get("lines")
            if not isinstance(raw, dict):
                self.error("mesh.lines", "mesh-lines", "manual mesh needs x, y and z line arrays")
            else:
                for ax in "xyz":
                    vals = raw.get(ax)
                    if not isinstance(vals, list) or len(vals) < 2:
                        self.error(f"mesh.lines.{ax}", "mesh-lines", "at least two lines are required")
                        continue
                    resolved = [self.ev(f"mesh.lines.{ax}[{i}]", v) for i, v in enumerate(vals)]
                    if any(v is None for v in resolved):
                        continue
                    if any(b <= a for a, b in zip(resolved, resolved[1:])):
                        self.error(f"mesh.lines.{ax}", "mesh-lines", "lines must be strictly increasing in input order")
                    if mesh := (self.bundle or {}).get("mesh"):
                        actual = mesh.get(ax)
                        # the bundle stores its mesh arrays rounded to 1e-4 mm: compare within that rounding
                        if isinstance(actual, list) and len(actual) == len(resolved) and any(abs(a-b) > 6e-5 for a,b in zip(actual,resolved)):
                            self.error(f"mesh.lines.{ax}", "mesh-lines-parity", "built mesh lines differ from the design")
            # stale automatic settings are not used; the far-field and monitor checks below still apply
            m = {}
        adaptive = m.get("mode") == "design"
        if adaptive:
            m = m.get("overrides", {})
            if not isinstance(m, dict):
                m = {}  # build reports the schema error
        cpw = (None if adaptive and "cells_per_wavelength" not in m else
               self.ev("mesh.cells_per_wavelength", m.get("cells_per_wavelength", 20)))
        if cpw is not None and cpw <= 0:
            self.error("mesh.cells_per_wavelength", "cells-per-wavelength", "cells per wavelength must be > 0")
        elif cpw is not None and cpw < 10:
            self.warn("mesh.cells_per_wavelength", "cells-per-wavelength",
                      f"{cpw:g} cells per wavelength is coarse; FDTD needs about 15 or more for usable accuracy")
        if m.get("pad") is not None:
            pad = self.ev("mesh.pad", m["pad"])
            if pad is not None and pad < 0:
                self.error("mesh.pad", "expr", "pad must be >= 0")
            elif pad is not None and band:
                self.air_pad(pad, "mesh.overrides.pad" if adaptive else "mesh.pad")
        if "edge_rule" in m and m["edge_rule"] not in ("thirds", "edge"):
            self.error("mesh.edge_rule", "expr", "edge rule must be thirds or edge")
        if "max_ratio" in m:
            ratio = self.ev("mesh.max_ratio", m["max_ratio"])
            if ratio is not None and ratio <= 1:
                self.error("mesh.max_ratio", "expr", "maximum cell ratio must be finite and > 1")
        if m.get("air_cells_per_wavelength") is not None:
            air_cpw = self.ev("mesh.air_cells_per_wavelength", m["air_cells_per_wavelength"])
            if air_cpw is not None and (air_cpw <= 0 or (cpw is not None and air_cpw > cpw)):
                self.error("mesh.air_cells_per_wavelength", "cells-per-wavelength",
                           "air cells per wavelength must be > 0 and no greater than the metal and dielectric setting")
        ff = self.d.get("far_field", {})
        if ff.get("enabled", True):
            if ff.get("phase_center") is not None:
                center = self.vec("far_field.phase_center", ff["phase_center"])
                if center is not None and not all(math.isfinite(v) for v in center):
                    self.error("far_field.phase_center", "expr", "phase center coordinates must be finite")
            faces = ff.get("faces")
            if faces is not None and (not isinstance(faces, list) or len(faces) != 6
                                      or not all(isinstance(v, bool) for v in faces) or not any(faces)):
                self.error("far_field.faces", "expr", "faces is 6 true/false flags (x-, x+, y-, y+, z-, z+), at least one true")
            elif faces is not None:
                bounds = self.d.get("simulation", {}).get("boundaries")
                walls = list(bounds) if isinstance(bounds, list) else [] if bounds is None else [bounds] * 6
                for k, name in enumerate(("x-", "x+", "y-", "y+", "z-", "z+")):
                    if faces[k] and k < len(walls) and str(walls[k]).upper() == "PEC":
                        self.warn(f"far_field.faces[{k}]", "nf2ff-pec",
                                  f"the far-field box face {name} is on, but that boundary is PEC: the box skips a face on a PEC wall")
            for k, f in enumerate(ff.get("frequencies") or []):
                v = self.ev(f"far_field.frequencies[{k}]", f)
                if v is not None and band and not band[0] - 1e-9 <= v <= band[1] + 1e-9:
                    self.error(f"far_field.frequencies[{k}]", "ff-band",
                               f"{v:g} GHz is outside the simulated band {band[0]:g}–{band[1]:g} GHz")
        for k, f in enumerate((self.d.get("monitors") or {}).get("currents") or []):
            v = self.ev(f"monitors.currents[{k}]", f)
            if v is not None and band and not band[0] - 1e-9 <= v <= band[1] + 1e-9:
                self.error(f"monitors.currents[{k}]", "monitor-band",
                           f"{v:g} GHz is outside the simulated band {band[0]:g}–{band[1]:g} GHz")
        eff = (self.d.get("monitors") or {}).get("efficiency")
        if isinstance(eff, dict):
            n = eff.get("points", EFFICIENCY_POINTS_DEFAULT)
            if not (_num(n) and math.isfinite(n) and n == int(n) and EFFICIENCY_POINTS_MIN <= n <= EFFICIENCY_POINTS_MAX):
                self.error("monitors.efficiency.points", "monitor-efficiency",
                           f"the number of frequencies is a whole number from {EFFICIENCY_POINTS_MIN} to {EFFICIENCY_POINTS_MAX}")
            if not ff.get("enabled", True):
                self.error("monitors.efficiency", "monitor-efficiency",
                           "the efficiency over the band needs the far field: turn the far field on or remove this monitor")
        self.field_planes(band)

    def air_pad(self, pad: float, path: str):
        """An explicit air padding well under what the automatic one gives (a quarter wavelength at f
        min for the far-field box, an eighth without it): the absorbing boundaries and the far-field
        box then sit too close to the structure. Zero is kept (the structure runs into the boundary)
        and so is a design whose sides are all PEC / PMC."""
        b = self.d.get("simulation", {}).get("boundaries", "MUR")
        sides = [b] * 6 if isinstance(b, str) else list(b)
        if pad <= 0 or all(str(x).upper() in ("PEC", "PMC", "0", "1") for x in sides):
            return
        far = self.d.get("far_field", {}).get("enabled", True)
        lam = 299.792458 / self.band[0]   # mm at f min (GHz)
        target = round(lam / (4 if far else 8), 1)
        if pad >= target / 2:
            return
        which = "λ/4" if far else "λ/8"
        self.warn(path, "air-pad",
                  f"the air padding is {pad:g} mm, under half of {which} at f min ({target:g} mm at {self.band[0]:g} GHz): "
                  "the open boundaries and the far-field box sit close to the structure",
                  {"label": f"Set the air padding to {which} ({target:g} mm)", "set": {path: _num_text(target)}})

    def field_planes(self, band):
        """monitors.field_planes: the count, each plane's position and frequencies (in the band)."""
        planes = (self.d.get("monitors") or {}).get("field_planes") or []
        if len(planes) > FIELD_PLANES_MAX:
            self.error("monitors.field_planes", "field-plane",
                       f"{len(planes)} field planes: use at most {FIELD_PLANES_MAX} (each map adds to the run's memory and result)")
        self.plane_positions = []
        for k, pl in enumerate(planes):
            w = f"monitors.field_planes[{k}]"
            pos = self.ev(f"{w}.position", pl.get("position"))
            if pos is not None:
                self.plane_positions.append((w, AXES.index(pl["normal"]), pos))
            freqs = pl.get("frequencies") or []
            if not freqs:
                self.error(f"{w}.frequencies", "field-plane", "a field plane needs at least one frequency")
            elif len(freqs) > FIELD_PLANE_FREQS_MAX:
                self.error(f"{w}.frequencies", "field-plane",
                           f"{len(freqs)} frequencies: a field plane records at most {FIELD_PLANE_FREQS_MAX}")
            for j, f in enumerate(freqs):
                v = self.ev(f"{w}.frequencies[{j}]", f)
                if v is not None and band and not band[0] - 1e-9 <= v <= band[1] + 1e-9:
                    self.error(f"{w}.frequencies[{j}]", "field-plane",
                               f"{v:g} GHz is outside the simulated band {band[0]:g}–{band[1]:g} GHz")

    def field_plane_domain(self):
        """A field plane's position must lie inside the simulation domain (the bundle's)."""
        dom = (self.bundle or {}).get("domain")
        if not dom:
            return
        for w, axis, pos in getattr(self, "plane_positions", []):
            lo, hi = dom["min"][axis], dom["max"][axis]
            if not lo - 1e-6 <= pos <= hi + 1e-6:
                self.error(f"{w}.position", "field-plane-position",
                           f"{AXES[axis]} = {pos:g} mm is outside the simulation domain ({lo:.2f} to {hi:.2f} mm): "
                           "the plane would be recorded at the domain's edge")

    def ports(self):
        boxes = []
        ports = self.d.get("ports", [])
        if not ports:
            self.error("ports", "no-port", "the design has no port: nothing is excited and there is no S11; add a port before running")
        elif not any(po.get("excite", True) for po in ports):
            self.error("ports", "no-port", "no port is excited: mark at least one port as excited (driven) before running")
        physical = [(i, w, feed) for i, po in enumerate(ports) for w, feed in port_feeds(po, f"ports[{i}]")]
        for i, w, po in physical:
            wg = po.get("type") == "waveguide"
            if wg:
                self.waveguide(po, w)
            elif w == f"ports[{i}]":
                r = self.ev(f"{w}.R", po.get("R", 50))
                if r is not None and r <= 0:
                    self.error(f"{w}.R", "port-r", "the port impedance must be > 0 Ω")
                ref = po.get("reference_impedance")
                if ref is not None:
                    re = self.ev(f"{w}.reference_impedance.real", ref.get("real"))
                    self.ev(f"{w}.reference_impedance.imag", ref.get("imag"))
                    if re is not None and re <= 0:
                        self.error(f"{w}.reference_impedance.real", "port-r", "power-wave reference real part must be > 0 Ω")
            a, c = self.vec(f"{w}.start", po.get("start")), self.vec(f"{w}.stop", po.get("stop"))
            if a is None or c is None:
                continue
            k = AXES.index(po["direction"])
            if wg:
                if abs(c[k] - a[k]) < EPS and po.get("excite", True):
                    self.error(f"{w}.stop[{k}]", "port-length",
                               f"an excited waveguide port needs a length along {po['direction']}: the excitation is at start, "
                               "the mode probes at stop (a cell or more further)")
                self._aperture(po, w, a, c, k)
            elif abs(c[k] - a[k]) < EPS:
                self.error(f"{w}.stop[{k}]", "port-length",
                           f"the port has no length along its direction {po['direction']}: start and stop must differ in {po['direction']}")
            else:
                u, v = in_plane(k)
                if abs(c[u] - a[u]) >= EPS and abs(c[v] - a[v]) >= EPS:
                    self.warn(f"{w}.stop", "port-volume",
                              f"the port has extent across its direction in both {AXES[u]} and {AXES[v]} (a volume); "
                              "a lumped port is a line (a probe) or a sheet (a strip feed)")
            box = ([min(a[q], c[q]) for q in range(3)], [max(a[q], c[q]) for q in range(3)])
            for j, other, other_k in boxes:
                overlap = all(box[0][q] <= other[1][q] + EPS and other[0][q] <= box[1][q] + EPS for q in range(3))
                # Members may meet at a conductor face; they must not drive the same gap.
                def at_end(axis, bounds):
                    lo = max(box[0][axis], other[0][axis])
                    hi = min(box[1][axis], other[1][axis])
                    return hi - lo <= EPS and min(abs(lo - bounds[side][axis]) for side in (0, 1)) <= EPS
                shared_end = at_end(k, box) and at_end(other_k, other)
                if overlap and (i != j or not shared_end):
                    self.error(f"{w}.start", "port-overlap", f"port {po['number']} overlaps port {ports[j]['number']}")
            boxes.append((i, box, k))
            if ".group.members[" in w and self.d.get("mesh", {}).get("mode") == "manual":
                for end, point in (("start", a), ("stop", c)):
                    for ax, name in enumerate(AXES):
                        lines = [self.ev(f"mesh.lines.{name}[{j}]", value) for j, value in enumerate(self.d["mesh"].get("lines", {}).get(name, []))]
                        if lines and all(v is not None for v in lines) and min(abs(v - point[ax]) for v in lines) > 1e-6:
                            self.error(f"{w}.{end}[{ax}]", "expr", "port coordinate must lie on a manual mesh line")
        for i, re in enumerate(self.d.get("resistors", [])):
            w = f"resistors[{i}]"
            if not any(key in re for key in ("R", "L", "C")):
                self.error(f"{w}.R", "resistor-r", "at least one R, L or C value is required")
            for key in ("R", "L", "C"):
                if key not in re:
                    continue
                value = self.ev(f"{w}.{key}", re[key])
                if value is not None and value <= 0:
                    self.error(f"{w}.{key}", "resistor-r", "the resistance must be > 0 Ω" if key == "R" else "lumped values must be > 0")
            if re.get("topology", "parallel") not in ("parallel", "series"):
                self.error(f"{w}.topology", "resistor-r", "topology must be parallel or series")
            a, c = self.vec(f"{w}.start", re.get("start")), self.vec(f"{w}.stop", re.get("stop"))
            k = AXES.index(re["direction"])
            if a is not None and c is not None and abs(c[k] - a[k]) < EPS:
                self.error(f"{w}.stop[{k}]", "resistor-length",
                           f"the resistor has no length along its direction {re['direction']}")

    def waveguide(self, po: dict, w: str):
        """A rectangular waveguide port: a TE mode, a positive cross-section, a mode that propagates."""
        try:
            m, n = wg_mode(po.get("mode", "TE10"))
        except DesignError as e:
            self.error(f"{w}.mode", "wg-mode", e.detail)
            m = n = None
        wa, wb = self.ev(f"{w}.a", po.get("a")), self.ev(f"{w}.b", po.get("b"))
        for v, key in ((wa, "a"), (wb, "b")):
            if v is not None and v <= 0:
                self.error(f"{w}.{key}", "wg-size", f"the waveguide {'width a' if key == 'a' else 'height b'} must be > 0")
        if m is None or wa is None or wb is None or wa <= 0 or wb <= 0 or not self.band:
            return
        fc = wg_cutoff_ghz(m, n, wa, wb)
        mode = f"TE{m}{n}"
        if fc >= self.band[1]:
            self.error(f"{w}.a", "wg-cutoff",
                       f"the {mode} mode is cut off in the whole band: its cut-off is {fc:.4g} GHz, above f max {self.band[1]:g} GHz "
                       "(widen the guide or raise the band)")
        elif fc > self.band[0]:
            self.warn(f"{w}.a", "wg-cutoff",
                      f"below the {mode} cut-off ({fc:.4g} GHz) the mode does not propagate: the S-parameters under "
                      f"{fc:.4g} GHz are not meaningful (raise f min above it)")

    def _aperture(self, po: dict, w: str, a, c, k: int):
        """The port box spans the guide cross-section: a along (k+1)%3, b along (k+2)%3."""
        wa, wb = self.V.get(f"{w}.a"), self.V.get(f"{w}.b")
        if wa is None or wb is None or wa <= 0 or wb <= 0:
            return
        u, v = in_plane(k)
        du, dv = abs(c[u] - a[u]), abs(c[v] - a[v])
        if abs(du - wa) > 1e-6 * max(1.0, wa) or abs(dv - wb) > 1e-6 * max(1.0, wb):
            self.warn(f"{w}.stop", "wg-aperture",
                      f"the port spans {du:g} × {dv:g} mm across {po['direction']} but the mode is set for a = {wa:g} "
                      f"(along {AXES[u]}) × b = {wb:g} (along {AXES[v]}): the excited field would not fit the guide")

    # ---------------------------------------------------------------- geometry (server only)

    def geometry(self):
        """Checks on the resolved, transformed geometry: floating feeds, hidden parts and misplaced
        metal (overhanging its substrate, floating in the air)."""
        parts = self._resolve()
        metal = [p for part in parts if part["metal"] for p in part["prims"]]
        for path, message in sheet_transform_issues(self.d, self.names):
            self.error(path, "sheet-transform-angle", message)
        self.sheets = thin_sheets(parts, thin_metal_limit(self.d, self.names))
        flat = {id(parts[sh["part"]]["prims"][sh["prim"]]) for sh in self.sheets}
        volume_mode = self.d.get("mesh", {}).get("thin_metal", "sheet") == "volume"
        limit_sheet = thin_metal_limit(self.d, self.names, force=True)
        told: set[int] = set()
        for sh in self.sheets:
            if sh["part"] in told:
                continue   # one note per part (an array's copies say the same)
            told.add(sh["part"])
            ax, t = AXES[sh["axis"]], sh["thickness"]
            where = {"min": f"on its {ax}-min face", "max": f"on its {ax}-max face", "middle": "in its middle"}[sh["side"]]
            who = f"{parts[sh['part']]['name']!r}: {t * 1000:.3g} µm metal is modeled as a sheet at {ax} = {sh['at']:g} ({where})"
            if volume_mode:
                # "volume" asked to keep it, but cells across it would cost far more than they are worth
                cell = ((self.bundle or {}).get("mesh") or {}).get("min_cell")   # the finest cell now; three cells would go across t
                ratio = max(1.0, 3 * cell / t) if _num(cell) and cell > 0 else (30 * limit_sheet / t if limit_sheet else 0)
                self.warn(sh["where"] or f"parts[{parts[sh['part']]['index']}]", "thin-metal-volume",
                          f"{who} although mesh › thin metal is \"volume\": cells across it would make the timestep about "
                          f"{ratio:.0f}x smaller (a run of many minutes that may never converge). The sheet keeps the drawn "
                          "thickness for the losses and the exports")
            else:
                self.info(sh["where"] or f"parts[{parts[sh['part']]['index']}]", "thin-metal",
                          f"{who}: thinner than the mesh can resolve, so its thickness would only shrink the timestep")
        self.thin_volume = []
        scale = 1.0
        for part in parts:
            for p in part["prims"]:
                lo, hi = self._bbox(p)
                scale = max(scale, *(abs(x) for x in lo + hi))
        tol = max(1e-6, 1e-7 * scale)
        pec = self._pec_faces()
        inside = self._solid_probe(parts, flat)
        voids = [v for part in parts for v in part["voids"]]
        self._no_port_fix(parts, tol)
        for w, po in (entry for i, p in enumerate(self.d.get("ports", [])) for entry in port_feeds(p, f"ports[{i}]")):
            if po.get("type") == "waveguide":
                continue   # a guide's cross-section, not a feed between two conductors
            try:
                a = [evaluate(x, self.names) for x in po["start"]]
                c = [evaluate(x, self.names) for x in po["stop"]]
            except (DesignError, TypeError, KeyError):
                continue
            k = AXES.index(po["direction"])
            if abs(c[k] - a[k]) < EPS:
                continue
            for end, name in ((a, "start"), (c, "stop")):
                q = [(a[m] + c[m]) / 2 for m in range(3)]
                q[k] = end[k]
                if any(self._holds(p, q, tol) and not self._carved(p, q, voids) for p in metal) or any(
                        abs(q[ax] - pos) <= tol for ax, pos in pec):
                    continue
                at = ", ".join(f"{x:g}" for x in q)
                self.warn(f"{w}.{name}", "port-floating",
                          f"the {name} end of port {po['number']} at ({at}) touches no metal: a floating feed",
                          self._snap_fix(f"{w}.{name}", a, c, k, name == "start", parts, inside, tol))
            self._port_in_metal(po, w, a, c, k, parts, inside, tol)
            self._port_at_null(po, w, a, c, k, parts, tol)
        self.cut_checks()
        self.void_checks(parts)
        containers: dict = {}   # id(part) -> _BoxIndex of its primitives, shared by every part's test
        for part in parts:
            if not part["prims"]:
                continue
            by = self._hidden_by(part, parts, self._bbox, containers)
            if by is not None:
                self.warn(f"parts[{part['index']}]", "part-hidden",
                          f"{part['name']!r} lies completely inside {by!r}, which has the same or a higher priority: "
                          "it has no effect (raise its priority or remove it)")
        # metal placement needs the whole geometry as meant: not with shapes that did not resolve,
        # nor while errors (an inverted brick, a value out of range) make the drawing unreliable
        if not self.partial and not any(c["severity"] == "error" for c in self.out):
            _MetalPlacement(self, parts, scale).run()
        return parts


    def cut_checks(self):
        """Cuts that cut nothing, overlap a solid of their part (a cut removes area from flat sheets,
        not from a solid) or remove a whole sheet."""
        materials = {m["name"]: m for m in self.d.get("materials", [])}
        for i, pt in enumerate(self.d.get("parts", [])):
            if not pt.get("cuts"):
                continue
            w = f"parts[{i}]"
            try:
                cuts = resolve_cuts(pt, self.names, w)
            except (DesignError, TypeError, ValueError, KeyError):
                continue   # reported at the cut's fields
            metal = materials[pt["material"]]["kind"] == "metal"
            base = []
            for j, pr in enumerate(pt["primitives"]):
                try:
                    base.append(resolve_primitive(pr, self.names, f"{w}.primitives[{j}]", 10 if metal else 0))
                except (DesignError, TypeError, ValueError, KeyError):
                    continue
            for k, cut in enumerate(cuts):
                n, plane = cut["axis"], cut["plane"]
                u, v = in_plane(n)
                cb = cut["bounds"]
                used, blocked = False, None
                for p in base:
                    lo, hi = prim_bbox(p)
                    area = min(hi[u], cb[2]) - max(lo[u], cb[0]) > EPS and min(hi[v], cb[3]) - max(lo[v], cb[1]) > EPS
                    if not area or not lo[n] - EPS <= plane <= hi[n] + EPS:
                        continue
                    pn, level = sheet_plane(p)
                    if pn == n and on_plane(level, plane):
                        used = True
                    elif pn is None and blocked is None and not (p["kind"] == "linpoly" and abs(p.get("length", 0.0)) < EPS):
                        blocked = p   # a solid the cut plane crosses (a flat sheet in another plane is only touched along a line)
                if blocked is not None:
                    kind = "brick" if blocked["kind"] == "box" else blocked["kind"]
                    self.warn(f"{w}.cuts[{k}]", "cut-unsupported",
                              f"the cut overlaps {blocked['where'].split('.', 1)[1]} (a {kind} with thickness at the cut's plane): "
                              "a cut removes area from flat sheets (a zero-thickness brick, a polygon or a flat circle in the cut's plane), "
                              "not from a solid; make that shape a sheet or subtract it with a Boolean")
                elif not used:
                    self.warn(f"{w}.cuts[{k}]", "cut-unused",
                              f"the cut touches no flat sheet of {pt['name']!r} in its plane ({AXES[n]} = {plane:g}): it removes nothing")
            for p in base:
                try:
                    pieces = cut_pieces(p, cuts)
                except DesignError:
                    continue
                n, _level = sheet_plane(p)
                if n is not None and not pieces and any(c["axis"] == n for c in cuts):
                    self.warn(p["where"], "cut-all", "the cuts remove this whole sheet")

    def void_checks(self, parts):
        """Cut-outs (void carvers): what else they erase, and sheets they do not reach."""
        for host in parts:
            if not host["voids"]:
                continue
            hw = f"parts[{host['index']}]"
            for other in parts:
                if other is host or not other["prims"]:
                    continue
                if any(self._void_hits(v, p) for v in host["voids"] for p in other["prims"]
                       if p.get("priority", 0) <= v["priority"]):
                    self.warn(hw, "boolean-cut-erases",
                              f"the cut-out in {host['name']!r} also erases part of {other['name']!r}, which has the same "
                              f"or a lower priority: give {other['name']!r} a higher priority (above {host['name']!r}) to keep it")
            told: set = set()
            for v in host["voids"]:
                vlo, vhi = self._bbox(v)
                for p in host["prims"]:
                    lo, hi = self._bbox(p)
                    flat = [k for k in range(3) if hi[k] - lo[k] < EPS]
                    if len(flat) != 1 or p["kind"] not in ("box", "polygon", "linpoly"):
                        continue
                    n = flat[0]
                    u, w = in_plane(n)
                    if any(min(hi[k], vhi[k]) - max(lo[k], vlo[k]) <= EPS for k in (u, w)):
                        continue   # no overlap in the sheet's plane
                    if vhi[n] - vlo[n] > EPS and vlo[n] <= hi[n] + EPS and vhi[n] >= lo[n] - EPS:
                        continue   # touches or crosses the sheet: a volume cuts it (measured with openEMS)
                    key = (v["where"], p["where"])
                    if key in told:
                        continue
                    told.add(key)
                    self.warn(v["where"], "boolean-cut-reach",
                              f"the cut-out in {host['name']!r} does not reach the zero-thickness sheet in {host['name']!r}: "
                              "it removes nothing there (a gap, or no thickness: let it touch or cross the sheet)")

    def _void_hits(self, v: dict, p: dict) -> bool:
        """Whether the carver v really overlaps the shape p: their boxes share a volume and a point of a
        5 x 5 x 5 grid over the shared box lies in both."""
        vlo, vhi = self._bbox(v)
        lo, hi = self._bbox(p)
        a = [max(vlo[k], lo[k]) for k in range(3)]
        b = [min(vhi[k], hi[k]) for k in range(3)]
        if any(b[k] - a[k] <= EPS for k in range(3)):
            return False
        for i in range(5):
            for j in range(5):
                for m in range(5):
                    q = [a[k] + (b[k] - a[k]) * (f + 0.5) / 5 for k, f in enumerate((i, j, m))]
                    if prim_contains(v, q, 0.0) and prim_contains(p, q, 0.0):
                        return True
        return False

    def _carved(self, p: dict, q, voids: list) -> bool:
        """Whether a void carver (vacuum of a higher priority) erases the metal shape p at point q."""
        return any(v.get("priority", 0) > p.get("priority", 10) and self._holds(v, q, 0.0) for v in voids)

    def _solid_probe(self, parts, flat: set):
        """``inside(q)``: ``(part name, primitive)`` of the metal volume holding point q, else None.
        Thin metal that becomes a sheet is left out (the build moves a port's ends onto the sheet); a
        non-metal shape of higher priority over the metal wins there (openEMS), e.g. the vacuum of a
        connector's bore modeled over its body."""
        solid = [(part["name"], p) for part in parts if part["metal"] for p in part["prims"] if id(p) not in flat]
        over = [p for part in parts if not part["metal"] for p in part["prims"]]
        over += [p for part in parts for p in part.get("voids", [])]   # carvers: vacuum above their host

        def inside(q):
            return next(((name, p) for name, p in solid if self._holds(p, q, 0.0) and not any(
                o.get("priority", 0) > p.get("priority", 10) and self._holds(o, q, 0.0) for o in over)), None)

        return inside

    def _port_in_metal(self, po: dict, w: str, a, c, k: int, parts, inside, tol: float):
        """A lumped port whose end lies inside a metal volume (metal on both sides of the end along
        the port), or whose middle does: the metal shorts it."""
        d = max(10 * tol, 1e-3 * abs(c[k] - a[k]))
        mid = [(a[m] + c[m]) / 2 for m in range(3)]

        # metal across the port's middle shorts the whole excitation: the run cannot give a result, so
        # it is an error (the run is refused); an end that only reaches into metal stays a warning
        if hit := inside(mid):
            self.error(f"{w}.start", "port-in-metal",
                       f"port {po['number']} runs through {hit[0]!r}: metal across its middle shorts it. A lumped port spans "
                       "the gap between two conductors, from the face of one to the face of the other")
            return
        for end, other, which in ((a, c, "start"), (c, a, "stop")):
            # just inside the port from this end: metal there means the end is inside the metal or on
            # its far face, and the port reaches into it
            q = list(mid)
            sign = 1 if other[k] > end[k] else -1
            q[k] = end[k] + sign * d
            if hit := inside(q):
                name, p = hit
                fix = None
                if _faces_along(p, k):
                    # the end goes to the face of that metal on the port's side, where the gap begins
                    lo, hi = self._bbox(p)
                    face = hi[k] if sign > 0 else lo[k]
                    if self._end_ok(a, c, k, which == "start", face, inside, tol):
                        fix = {"label": f"Move the end onto the face of {name!r} ({AXES[k]} = {face:g} mm)",
                               "set": {f"{w}.{which}[{k}]": self._coord(p, k, face)}}
                self.warn(f"{w}.{which}", "port-in-metal",
                          f"the {which} end of port {po['number']} reaches into {name!r}: the metal covers part of the port "
                          "and shorts it there. A lumped port spans the gap between two conductors, from the face of one to "
                          "the face of the other", fix)
                return

    def _end_ok(self, a, c, k: int, is_start: bool, new: float, inside, tol: float) -> bool:
        """Whether a lumped port with one end moved to ``new`` along axis k still spans a gap: it keeps
        its direction and has a length, and no metal lies across its middle or just inside from the
        moved end."""
        e, o = (a[k], c[k]) if is_start else (c[k], a[k])
        sign = 1 if o > e else -1
        if sign * (o - new) <= 10 * tol:
            return False
        mid = [(a[m] + c[m]) / 2 for m in range(3)]
        mid[k] = (new + o) / 2
        if inside(mid):
            return False
        q = list(mid)
        q[k] = new + sign * max(10 * tol, 1e-3 * abs(o - new))
        return inside(q) is None

    def _snap_fix(self, path: str, a, c, k: int, is_start: bool, parts, inside, tol: float) -> dict | None:
        """A floating end of a lumped port: the nearest face of a metal along the port's axis, when it
        lies within half the port's length, the port keeps a gap and no metal covers it there."""
        e, o = (a[k], c[k]) if is_start else (c[k], a[k])
        reach = 0.5 * abs(o - e)
        mid = [(a[m] + c[m]) / 2 for m in range(3)]
        best = None
        for part in parts:
            if not part["metal"]:
                continue
            for p in part["prims"]:
                if not _faces_along(p, k):
                    continue
                lo, hi = self._bbox(p)
                for face in {lo[k], hi[k]}:
                    if abs(face - e) > reach or (best is not None and abs(face - e) >= best[0]):
                        continue
                    q = list(mid)
                    q[k] = face
                    if self._holds(p, q, tol) and self._end_ok(a, c, k, is_start, face, inside, tol):
                        best = (abs(face - e), face, part["name"], p)
        if best is None:
            return None
        _, face, name, p = best
        return {"label": f"Move the end onto the nearest metal face ({name!r}, {AXES[k]} = {face:g} mm)",
                "set": {f"{path}[{k}]": self._coord(p, k, face)}}

    def _coord(self, p: dict, k: int, value: float) -> str:
        """Coordinate k of a fix: the design's own expression of box ``p`` when it gives ``value`` (so
        the edited design stays parametric), else the number."""
        m = re.fullmatch(r"parts\[(\d+)\]\.primitives\[(\d+)\]", p.get("where") or "")
        if m and p["kind"] == "box":
            try:
                pr = self.d["parts"][int(m[1])]["primitives"][int(m[2])]
                for key in ("start", "stop"):
                    e = pr[key][k]
                    if isinstance(e, str) and e.strip() and abs(evaluate(e, self.names) - value) <= 1e-7 * max(1.0, abs(value)):
                        return e
            except (DesignError, TypeError, ValueError, KeyError, IndexError):
                pass
        return _num_text(value)

    def _no_port_fix(self, parts, tol: float):
        """A design without a port that is a patch over a ground plane and nothing else: two metal
        bricks, plates normal to one axis, the smaller over the larger and clear of it. The offer is a
        probe from the ground's face to the patch's, 0.15 x the patch's shorter side off its center
        (as for port-at-null). Anything else (more metal, an array, a feed line) is not unambiguous."""
        chk = next((c for c in self.out if c["code"] == "no-port" and c["path"] == "ports"), None)
        metals = [pt for pt in parts if pt["metal"]]
        if chk is None or self.d.get("ports") or self.partial or len(metals) != 2:
            return
        if any(len(pt["prims"]) != 1 or pt["prims"][0]["kind"] != "box" for pt in metals):
            return
        boxes = [self._bbox(pt["prims"][0]) for pt in metals]
        found = []
        for k in range(3):
            u, v = in_plane(k)
            if not all(_MetalPlacement._plate_normal(pt["prims"][0], *b, tol, k) for pt, b in zip(metals, boxes)):
                continue
            area = [(b[1][u] - b[0][u]) * (b[1][v] - b[0][v]) for b in boxes]
            if abs(area[0] - area[1]) <= 1e-9 * max(area):
                continue
            g, q = (0, 1) if area[0] > area[1] else (1, 0)
            (glo, ghi), (plo, phi) = boxes[g], boxes[q]
            if any(plo[m] < glo[m] - tol or phi[m] > ghi[m] + tol for m in (u, v)):
                continue
            if plo[k] - ghi[k] > tol:        # the patch over the ground: the probe runs up
                found.append((k, q, (g, ghi[k]), (q, plo[k])))
            elif glo[k] - phi[k] > tol:      # the patch under the ground
                found.append((k, q, (q, phi[k]), (g, glo[k])))
        if len(found) != 1:
            return
        k, q, (i0, z0), (i1, z1) = found[0]
        u, v = in_plane(k)
        lo, hi = boxes[q]
        ax = u if hi[u] - lo[u] <= hi[v] - lo[v] else v
        at = [0.0] * 3
        for m in (u, v):
            at[m] = (lo[m] + hi[m]) / 2
        at[ax] = round(at[ax] - 0.15 * (hi[ax] - lo[ax]), 3)
        start, stop = [_num_text(x) for x in at], [_num_text(x) for x in at]
        start[k] = self._coord(metals[i0]["prims"][0], k, z0)
        stop[k] = self._coord(metals[i1]["prims"][0], k, z1)
        g = 1 - q
        port = {"type": "lumped", "number": 1, "R": "50", "start": start, "stop": stop, "direction": AXES[k]}
        chk["fix"] = {"label": f"Add a probe port between {metals[g]['name']!r} and {metals[q]['name']!r}",
                      "set": {"ports": [port]}}

    def _port_at_null(self, po: dict, w: str, a, c, k: int, parts, tol: float):
        """A centerd probe on a thin patch over dielectric and a larger ground plane."""
        u, v = in_plane(k)
        mid = [(a[m] + c[m]) / 2 for m in range(3)]
        touched = []
        for part in parts:
            if not part["metal"]:
                continue
            for p in part["prims"]:
                if p["kind"] != "box":
                    continue
                lo, hi = self._bbox(p)
                su, sv = hi[u] - lo[u], hi[v] - lo[v]
                if su <= EPS or sv <= EPS or hi[k] - lo[k] > 0.25 * min(su, sv):
                    continue   # not a plate normal to the port
                for end in (a, c):
                    q = list(mid)
                    q[k] = end[k]
                    if self._holds(p, q, tol):
                        touched.append((su * sv, part["name"], lo, hi))
                        break
        if len({t[1] for t in touched}) < 2:
            return
        area, name, lo, hi = min(touched, key=lambda t: t[0])
        if area >= max(t[0] for t in touched) * (1 - 1e-9):
            return
        # Two metal plates alone do not establish a resonant patch antenna. A centerd feed
        # into a larger brick is a normal feed in other designs (including imported VBA macro models).
        if hi[k] - lo[k] > 0.02 * min(hi[u] - lo[u], hi[v] - lo[v]):
            return
        ground = next((t for t in touched if t[0] > area and t[1] != name), None)
        if ground is None:
            return
        _, _, glo, ghi = ground
        patch_at = (lo[k] + hi[k]) / 2
        ground_at = (glo[k] + ghi[k]) / 2
        if abs(patch_at - ground_at) <= tol:
            return
        low, high = sorted((patch_at, ground_at))
        substrate = False
        for part in parts:
            if not part["dielectric"]:
                continue
            for p in part["prims"]:
                if p["kind"] != "box":
                    continue
                s, t = self._bbox(p)
                if (t[k] - s[k] > tol and s[k] < high - tol and t[k] > low + tol
                        and s[u] <= lo[u] + tol and t[u] >= hi[u] - tol
                        and s[v] <= lo[v] + tol and t[v] >= hi[v] - tol):
                    substrate = True
                    break
            if substrate:
                break
        if not substrate:
            return
        du, dv = mid[u] - (lo[u] + hi[u]) / 2, mid[v] - (lo[v] + hi[v]) / 2
        if abs(du) <= 0.05 * (hi[u] - lo[u]) and abs(dv) <= 0.05 * (hi[v] - lo[v]):
            # the offer: 0.15 x the shorter side off the center, along that side (the usual
            # resonant length of a rectangular patch; the patch template's feed offset too)
            ax = u if hi[u] - lo[u] <= hi[v] - lo[v] else v
            size = hi[ax] - lo[ax]
            to = round((lo[ax] + hi[ax]) / 2 - 0.15 * size, 3)
            self.warn(f"{w}.start", "port-at-null",
                      f"port {po['number']} feeds {name!r} at its center. If this is a resonant patch, a center feed can sit "
                      "near the voltage null of a fundamental mode and couple poorly. Consider moving it along the "
                      "resonant length; 0.15 × that length off center is a starting point to tune, not a guaranteed 50 Ω feed.",
                      self._move_port_fix(po, w, ax, to, size))

    def _move_port_fix(self, po: dict, w: str, ax: int, to: float, size: float) -> dict:
        """Move a port's two ends to ``to`` along axis ``ax``: through the parameter when both ends
        name the same one (the patch template's ``feed``), else by setting the coordinates."""
        a, c = po["start"][ax], po["stop"][ax]
        label = f"Move the feed to {AXES[ax]} = {to:g} mm (0.15 × the {size:g} mm side off the center)"
        params = self.d.get("params", [])
        k = next((i for i, p in enumerate(params) if isinstance(a, str) and a.strip() == p.get("key") and "default" in p), None)
        if k is not None and isinstance(c, str) and c.strip() == a.strip():
            return {"label": label, "set": {f"params[{k}].default": to}}
        return {"label": label, "set": {f"{w}.start[{ax}]": f"{to:g}", f"{w}.stop[{ax}]": f"{to:g}"}}

    def _resolve(self) -> list[dict]:
        """Like design.resolve_parts, but skipping what does not resolve (reported at its field).
        Sets ``partial`` when anything was skipped: the checks that need the whole geometry (a
        metal part touching nothing) do not run on a part of it."""
        materials = {m["name"]: m for m in self.d.get("materials", [])}
        out, total = [], 0
        self.partial = False
        for i, pt in enumerate(self.d.get("parts", [])):
            metal = materials[pt["material"]]["kind"] == "metal"
            base, explicit = [], []
            shapes = pt["primitives"]
            h = pt.get("booleanHistory")
            if isinstance(h, dict) and h.get("live"):
                try:   # a live Boolean is rebuilt at these values, as the build does
                    shapes = live_primitives(pt, self.names, f"parts[{i}]")
                except (DesignError, TypeError, ValueError, KeyError):
                    self.partial = True
            for j, pr in enumerate(shapes):
                try:
                    base.append(resolve_primitive(pr, self.names, f"parts[{i}].primitives[{j}]", 10 if metal else 0))
                    explicit.append("priority" in pr)
                except (DesignError, TypeError, ValueError, KeyError):
                    self.partial = True
                    continue
            # void carvers (design.resolve_parts): vacuum just above the part's own solids
            solids = [p for p in base if not p.get("void")]
            above = max([p["priority"] for p in solids] or [10 if metal else 0]) + 0.5
            voids = [p if e else {**p, "priority": above}
                     for p, e in [(p, e) for p, e in zip(base, explicit) if p.get("void")]]
            base = solids
            try:
                base = apply_cuts(base, resolve_cuts(pt, self.names, f"parts[{i}]"))
            except (DesignError, TypeError, ValueError, KeyError):
                self.partial = True   # an unfinished cut is reported at its fields; check the uncut shapes
            try:
                maps = transform_maps(pt.get("transforms", []), self.names, f"parts[{i}]")
            except (DesignError, TypeError, ValueError, KeyError):
                maps = [IDENTITY]
                self.partial = True
            prims = base if maps == [IDENTITY] else [map_primitive(p, s, t) for s, t in maps for p in base]
            if maps != [IDENTITY]:
                voids = [map_primitive(p, s, t) for s, t in maps for p in voids]
            total += len(prims) + len(voids)
            if total > MAX_PRIMITIVES:
                self.partial = True
                break
            out.append({"index": i, "name": pt["name"], "metal": metal,
                        "dielectric": materials[pt["material"]]["kind"] == "dielectric", "prims": prims,
                        "voids": voids, "copies": len(maps)})
        return out

    def _pec_faces(self):
        """(axis, position) of domain faces with a PEC boundary (needs the bundle's domain)."""
        dom = (self.bundle or {}).get("domain")
        if not dom:
            return []
        b = self.d.get("simulation", {}).get("boundaries", "MUR")
        bl = [b] * 6 if isinstance(b, str) else list(b)
        out = []
        for n, name in enumerate(bl):
            if str(name).upper() == "PEC":
                out.append((n // 2, dom["min" if n % 2 == 0 else "max"][n // 2]))
        return out

    @staticmethod
    def _hidden_by(part, parts, bbox=prim_bbox, containers: dict | None = None):
        """The first other part that holds every primitive of ``part`` in one of its own of the same
        or a higher priority. Only the primitives whose bounding box can hold the primitive's box are
        asked (``_inside`` starts with that box test, so the answer is the same): a large array
        inside another would otherwise be tested against every copy. ``containers`` caches each
        part's index across calls."""
        containers = {} if containers is None else containers

        def union(pt):
            # the box around a part's primitives, cached with the part's index
            key = ("union", id(pt))
            if key not in containers:
                boxes = [bbox(q) for q in pt["prims"]]
                containers[key] = None if not boxes else (
                    [min(b[0][k] for b in boxes) for k in range(3)], [max(b[1][k] for b in boxes) for k in range(3)])
            return containers[key]

        mine = union(part)
        for other in parts:
            if other is part:
                continue
            # a part hidden by `other` has every primitive's box inside one of other's, so its whole
            # box lies inside other's: skip the rest (the same answer, as _inside starts with that
            # test). This keeps a design of hundreds of separate parts from testing every pair.
            theirs = union(other)
            if mine is not None and (theirs is None or any(
                    mine[0][k] < theirs[0][k] - 1e-9 or mine[1][k] > theirs[1][k] + 1e-9 for k in range(3))):
                continue
            index = containers.get(id(other))
            if index is None:
                index = containers[id(other)] = _BoxIndex(other["prims"], bbox)
            if all(any(q["priority"] >= p["priority"] and _inside(p, q, bbox) for q in index.candidates(bbox(p)[0]))
                   for p in part["prims"]):
                return other["name"]
        return None

    def mesh(self, parts):
        b = self.bundle or {}
        mesh = b.get("mesh") or {}
        total = mesh.get("total_cells")
        if _num(total):
            limit = max_cells()
            why = self._mostly_air(b)
            if total > limit:
                self.error("mesh", "mesh-cells",
                           f"the mesh has {total / 1e6:.1f} M cells, over the server's {limit / 1e6:g} M limit "
                           f"(FAIRBEAM_MAX_CELLS): {why or 'coarsen it or lower f max'}")
            elif total > WARN_CELLS:
                self.warn("mesh", "mesh-cells",
                          f"the mesh has {total / 1e6:.1f} M cells: a long run and several GB of memory"
                          + (f"; {why}" if why else ""))
        for w in (mesh.get("auto") or {}).get("warnings") or []:
            self.warn("mesh", "mesh-warning", f"automatic mesh: {w}")
        self._excitation(mesh, parts)
        self._ringdown(mesh, parts)
        lines = [mesh.get(a) for a in "xyz"]
        if parts is None or not all(isinstance(l, list) and len(l) > 1 for l in lines):
            return
        # a solid thinner than the mesh: no mesh line crosses it along some axis, so FDTD drops it
        # (thin metal that the build turns into a sheet is a sheet in the mesh, not dropped)
        flat = {id(parts[sh["part"]]["prims"][sh["prim"]]) for sh in self.sheets}
        worst = None
        for part in parts:
            for p in part["prims"]:
                if id(p) in flat:
                    continue
                lo, hi = prim_bbox(p)
                for ax in range(3):
                    t = hi[ax] - lo[ax]
                    if t < EPS or (p["kind"] == "polygon"):
                        continue
                    for seg in _solid_spans(p, ax, lo, hi):
                        n = bisect.bisect_right(lines[ax], seg[1] + 5e-5) - bisect.bisect_left(lines[ax], seg[0] - 5e-5)
                        if n == 0 and (worst is None or seg[1] - seg[0] < worst[0]):
                            worst = (seg[1] - seg[0], p["where"], AXES[ax])
        self._thin_wires(parts, lines)
        if worst:
            self.warn(worst[1], "mesh-feature",
                      f"a feature {worst[0]:.3g} mm thick along {worst[2]} falls between mesh lines: "
                      "the automatic mesh cannot resolve it and FDTD drops it (make it thicker or a sheet, "
                      "or raise cells per wavelength)")

    def _mostly_air(self, b: dict) -> str | None:
        """When the domain is mostly air because of the open boundaries' distance (a quarter
        wavelength at f min unless mesh.pad is set), say so: lowering f min grows every side."""
        dom, parts = b.get("domain"), b.get("parts") or []
        boxes = [p.get("bbox") for p in parts if p.get("bbox")]
        if not dom or not boxes or not self.band:
            return None
        size = [dom["max"][k] - dom["min"][k] for k in range(3)]
        model = [max(bb[1][k] for bb in boxes) - min(bb[0][k] for bb in boxes) for k in range(3)]
        vol = lambda v: max(v[0], 1e-9) * max(v[1], 1e-9) * max(v[2], 1e-9)  # noqa: E731
        if vol(model) * 20 > vol(size):
            return None
        pad = self.d.get("mesh", {}).get("pad")
        dims = " × ".join(f"{x:.0f}" for x in size)
        if pad is None or pad == "":
            lam4 = 299.792458 / self.band[0] / 4
            return (f"the domain ({dims} mm) is mostly air: the open boundaries sit a quarter wavelength at f min "
                    f"({lam4:.0f} mm at {self.band[0]:g} GHz) from the model on every side. Raise f min, or set a "
                    "smaller distance under Simulation settings › Boundaries (Open, add space)")
        return (f"the domain ({dims} mm) is mostly air: reduce the open boundaries' distance (Simulation settings › Boundaries) "
                "or coarsen the mesh")

    def _smallest_cell(self, mesh: dict, parts) -> str | None:
        """Where the smallest cell comes from: its size, its axis and position, and the shape that
        asked for it (a thin solid, or two outlines a hair apart), from the mesh lines."""
        best = None
        for ax, name in enumerate(AXES):
            line = mesh.get(name)
            if not (isinstance(line, list) and len(line) > 1):
                continue
            for lo, hi in zip(line, line[1:]):
                if best is None or hi - lo < best[0]:
                    best = (hi - lo, ax, lo, hi)
        if best is None:
            return None
        size, ax, lo, hi = best
        cause = None
        for part in parts or []:
            for p in part["prims"]:
                if p["kind"] == "wire":
                    continue
                pl, ph = self._bbox(p)
                t = ph[ax] - pl[ax]
                if 1e-9 < t <= 6 * size and pl[ax] <= lo + 5 * size and ph[ax] >= hi - 5 * size:
                    if cause is None or t < cause[0]:
                        cause = (t, part["name"], part["metal"])
        if cause:
            t, name, metal = cause
            what = ("metal kept as a volume" if self.d.get("mesh", {}).get("thin_metal", "sheet") == "volume" else "metal") if metal else "material"
            return (f"the smallest cell, {size:.3g} mm along {AXES[ax]} at {AXES[ax]} = {lo:.4g}, comes from {name!r}: "
                    f"{t * 1000:.3g} µm {what}")
        return f"the smallest cell is {size:.3g} mm along {AXES[ax]} at {AXES[ax]} = {lo:.4g}"

    def _excitation(self, mesh: dict, parts=None):
        """The excitation pulse must end well within the timestep limit: the end criterion can only
        be met once the pulse is over and the fields have decayed. The pulse length is fixed by f max,
        the timestep by the smallest cell (CFL), so thin metal or a tiny gap can make the pulse alone
        longer than the limit.

        Without an explicit ``simulation.max_timesteps`` the build chooses the limit itself (the pulse
        and its decay, :func:`design.auto_timesteps`); then the run is refused only when that would cost
        more than the budget, with the fix that removes the cause."""
        dt = (mesh.get("auto") or {}).get("timestep_s")
        given = self.d.get("simulation", {}).get("max_timesteps")
        explicit = _num(given)
        limit = given if explicit else 60000
        if not (self.band and _num(dt) and dt > 0 and _num(limit) and limit > 0):
            return
        dt_real = dt * DT_SAFETY   # openEMS's timestep was 0.8 to 0.96 of the Courant estimate
        pulse_s = 10 / (math.sqrt(2) * math.pi * self.band[1] * 1e9 / _DGAUSS_RATIO)
        n = pulse_s / dt_real
        cell = mesh.get("min_cell")
        why = (f"a timestep of {_time_text(dt_real)}, set by the smallest cell ({cell:.3g} mm)" if _num(cell)
               else f"a timestep of {_time_text(dt_real)}")
        cause = self._smallest_cell(mesh, parts)
        sheets_fix = self._sheets_fix()
        fix = "model thin metal as sheets, coarsen the finest detail, or raise max timesteps"
        if not explicit:
            nodes = 1.0
            for a in "xyz":
                line = mesh.get(a)
                nodes *= len(line) if isinstance(line, list) else 1
            if nodes <= 1:
                nodes = float(mesh.get("total_cells") or 0)
            auto = auto_timesteps(dt, self.band[1] * 1e9, nodes)
            if not auto["over_budget"]:
                return
            minutes = auto["work"] / 250e6 / 60
            run_time = f"{minutes / 60:.1f} h" if minutes >= 90 else f"{minutes:.0f} min"
            self.error("simulation.max_timesteps", "run-too-long",
                       f"this run would need about {auto['needed']:,.0f} timesteps (the {_time_text(pulse_s)} excitation pulse "
                       f"and its decay at {why}) on {nodes / 1e6:.2f} M cells: roughly {run_time} on a CPU, more than "
                       f"the run budget. To fix: model thin metal as sheets or coarsen the finest detail", sheets_fix)
            if cause:
                self.info("mesh", "smallest-cell", cause)
            return
        if n < limit / 2:
            return
        # the one-click fix: room for the pulse and for the fields to decay after it (the pulse may
        # take up to half the limit before this warns), in round tens of thousands
        want = math.ceil(2.5 * n / 10000) * 10000
        button = sheets_fix or {"label": f"Set max timesteps to {want:,}", "set": {"simulation.max_timesteps": want}}
        if n >= limit:
            # a setting, not the design, makes this run useless (the estimate is optimistic: the
            # real timestep is smaller still), so it does not run
            self.error("simulation.max_timesteps", "excitation-too-long",
                       f"the excitation pulse alone takes about {n:,.0f} timesteps ({_time_text(pulse_s)} at {why}), more "
                       f"than max timesteps ({limit:,}): the run stops before the fields can decay and cannot converge. "
                       f"To fix: {fix}", button)
            if cause:
                self.info("mesh", "smallest-cell", cause)
        else:
            self.warn("simulation.max_timesteps", "excitation-too-long",
                      f"the excitation pulse alone takes about {n:,.0f} of the {limit:,} timesteps ({_time_text(pulse_s)} at "
                      f"{why}), which leaves little time for the fields to decay: the run may stop before it converges. "
                      f"To fix: {fix}", button)
            if cause:
                self.info("mesh", "smallest-cell", cause)

    def _ringdown(self, mesh: dict, parts):
        """A thin, low-loss substrate under a patch is a high-Q cavity: after the pulse its fields ring for tens
        of nanoseconds, and a fine timestep (the cells follow the thin substrate) turns that into hundreds of
        thousands of timesteps. The excitation check only looks at the pulse, so this estimates the decay from
        the substrate (see :func:`design.ringdown_steps`) and warns when the limit would stop the run before
        the end criterion is met."""
        dt = (mesh.get("auto") or {}).get("timestep_s")
        if not (self.band and parts and _num(dt) and dt > 0):
            return
        if any(x["code"] in ("run-too-long", "excitation-too-long") for x in self.out):
            return   # the run is already refused or warned about, for a worse reason
        given = self.d.get("simulation", {}).get("max_timesteps")
        solver = (self.bundle or {}).get("solver") or {}
        limit = given if _num(given) else solver.get("max_timesteps")
        if not (_num(limit) and limit > 0):
            return
        end_db = self.d.get("simulation", {}).get("end_criteria_db", -60)
        if not _num(end_db):
            return
        est = None
        for part in parts:
            if part["metal"] or not part.get("dielectric"):
                continue
            w = f"materials.{self.d['parts'][part['index']]['material']}"
            eps, tan = self.V.get(f"{w}.eps_r"), self.V.get(f"{w}.tan_d", 0.0)
            if not _num(eps) or eps <= 1:
                continue
            for p in part["prims"]:
                lo, hi = self._bbox(p)
                size = [hi[k] - lo[k] for k in range(3)]
                n = min(range(3), key=lambda k: size[k])
                if size[n] <= 0 or any(size[k] < 5 * size[n] for k in range(3) if k != n):
                    continue
                # a ground or a patch on one of its faces, else it is a slab, not a cavity
                if not self._metal_on_face(parts, n, lo, hi, size[n]):
                    continue
                n_steps = ringdown_steps(eps, tan if _num(tan) else 0.0, size[n], (self.band[0] + self.band[1]) / 2 * 1e9,
                                         dt * DT_SAFETY, abs(end_db), self.band[1] * 1e9)
                if n_steps and (est is None or n_steps["steps"] > est["steps"]):
                    est = {**n_steps, "h": size[n], "eps": eps, "tan": tan if _num(tan) else 0.0, "name": part["name"]}
        if est is None or est["steps"] <= limit:
            return
        want = math.ceil(1.3 * est["steps"] / 10000) * 10000
        cells = ((self.bundle or {}).get("mesh") or {}).get("total_cells") or 0
        minutes = max(1, round(cells * want / 90e6 / 60))
        self.warn("simulation.max_timesteps", "slow-ringdown",
                  f"{est['name']!r}: a {est['h']:.3g} mm substrate (εr {est['eps']:g}, tan δ {est['tan']:g}) is a high-Q cavity "
                  f"(Q about {est['q']:.0f}): the fields ring for about {_time_text(est['seconds'])} after the pulse, which is about "
                  f"{est['steps']:,.0f} timesteps at this mesh, more than the {limit:,.0f} the run may take, so it may stop before it "
                  f"converges. Running to {want:,} timesteps takes roughly {minutes} min on a CPU",
                  {"label": f"Set max timesteps to {want:,}", "set": {"simulation.max_timesteps": want}})

    def _metal_on_face(self, parts, n: int, lo, hi, h: float) -> bool:
        """The plate (thickness ``h`` along axis ``n``) is a patch cavity: one metal shape covers at least 60 % of one
        face (a ground plane) and some metal lies on the other face (the patch). A dipole printed on a board is not."""
        u, v = [k for k in range(3) if k != n]
        area = (hi[u] - lo[u]) * (hi[v] - lo[v])
        covered = [0.0, 0.0]
        touched = [False, False]
        for part in parts:
            if not part["metal"]:
                continue
            for q in part["prims"]:
                ql, qh = self._bbox(q)
                overlap = [min(hi[k], qh[k]) - max(lo[k], ql[k]) for k in (u, v)]
                if min(overlap) <= 0:
                    continue
                for side, face in enumerate((lo[n], hi[n])):
                    if any(abs(e - face) <= 0.25 * h for e in (ql[n], qh[n])) and (qh[n] - ql[n] <= 0.25 * h or abs(qh[n] - ql[n]) < 1e-9):
                        touched[side] = True
                        covered[side] = max(covered[side], overlap[0] * overlap[1])
        return area > 0 and all(touched) and max(covered) >= 0.6 * area

    def _sheets_fix(self) -> dict | None:
        """The one-click fix of a mesh made fine by thin metal kept as a volume, else None."""
        if self.d.get("mesh", {}).get("thin_metal", "sheet") != "volume" or not self.thin_volume:
            return None
        t = min(sh["thickness"] for sh in self.thin_volume) * 1000
        return {"label": f"Model {t:.3g} µm metal as sheets", "set": {"mesh.thin_metal": "sheet"}}

    def _thin_wires(self, parts, lines):
        """A wire is rasterised as a volume: where the cell across it is wider than its diameter,
        FDTD sees a line of cell edges (an effective radius set by the mesh), not its radius."""
        for part in parts:
            for p in part["prims"]:
                if p["kind"] != "wire":
                    continue
                r, worst = p["radius"], 0.0
                for a, b in zip(p["points"][:-1], p["points"][1:]):
                    for ax in range(3):
                        if abs(b[ax] - a[ax]) > EPS:
                            continue   # along the segment, not across it
                        ln, c = lines[ax], a[ax]
                        i = bisect.bisect_left(ln, c)
                        near = [ln[j + 1] - ln[j] for j in (i - 1, i) if 0 <= j < len(ln) - 1]
                        if near:
                            worst = max(worst, min(near))
                if worst > 2 * r + EPS:
                    self.warn(f"{p['where']}.radius", "wire-thin",
                              f"the wire's radius ({r:g} mm) is below the mesh cell across it ({worst:.3g} mm): FDTD sees a "
                              "line of cell edges whose effective radius is set by the mesh, not by the radius (raise the "
                              "radius or refine the mesh)")
                    break   # one per part (an array's copies say the same)

    def run(self) -> list[dict]:
        # duplicate part names have their own check: validate the structure under unique names
        d = self.d
        names = [pt.get("name") for pt in d.get("parts", []) if isinstance(pt, dict)]
        if len(set(names)) != len(names):
            d = copy.deepcopy(d)
            seen: set = set()
            for pt in d["parts"]:
                while pt.get("name") in seen:
                    pt["name"] = f"{pt['name']}_dup"
                seen.add(pt.get("name"))
        from .organization import organization_issues
        organization = organization_issues(d)
        if organization:
            for path, detail in organization:
                self.error(path, "component-path", detail)
            return self.out
        reference_errors = False
        for i, port in enumerate(d.get("ports", [])):
            if not isinstance(port, dict) or "reference_impedance" not in port:
                continue
            ref = port["reference_impedance"]
            path = f"ports[{i}].reference_impedance"
            if not isinstance(ref, dict) or set(ref) != {"real", "imag"}:
                self.error(path, "port-reference", "reference_impedance needs exactly real and imag")
                reference_errors = True
            elif port.get("type", "lumped") != "lumped":
                self.error(path, "port-reference", "complex reference is supported on lumped ports only")
                reference_errors = True
        if reference_errors:
            return self.out
        try:
            check_design(d)
        except DesignError as e:
            self.error(e.where or "", "expr" if ".group" in (e.where or "") else "structure", e.detail)
            return self.out
        self.params()
        self.materials()
        self.parts()
        self.simulation()
        self.loss_band()
        self.ports()
        parts = self.geometry()
        if self.bundle:
            self.mesh(parts)
            self.field_plane_domain()
        return self.out


# ---------------------------------------------------------------- metal placement (server only)

# Kinds whose bounding box is reached by the shape itself on every side (a polygon's extreme
# vertices, a brick's faces): the only metal the placement checks judge, so that a box that
# over-approximates a round or bent shape never raises a false alarm.
_PLATES = ("box", "polygon", "linpoly")
# the codes a candidate of the optimizer is skipped for (besides errors), when they are new
PLACEMENT = frozenset({"metal-overhang", "metal-floating"})


def _faces_along(p: dict, k: int) -> bool:
    """Whether the faces of p's bounding box normal to axis k are faces of p itself (a brick, a
    polygon or slab with normal k, a cylinder along k): what a plate can lie on."""
    kind = p["kind"]
    if kind == "box":
        return True
    if kind in ("polygon", "linpoly"):
        return p["normal"] == k
    if kind == "cylinder":
        a, c = p["start"], p["stop"]
        return all(abs(c[q] - a[q]) < 1e-12 for q in range(3) if q != k)
    return False


def _gap(a, b) -> list:
    """Per axis, the gap between boxes a and b (0 where their ranges overlap)."""
    return [max(0.0, b[0][q] - a[1][q], a[0][q] - b[1][q]) for q in range(3)]


def _touch_pairs(boxes: list, tol: float) -> list:
    """Index pairs (i < j) of the boxes that touch or overlap within ``tol``: a sweep along the
    axis on which the boxes spread the most (an array along y is swept along y)."""
    n = len(boxes)
    if n < 2:
        return []

    def spread(k):
        size = sorted(b[1][k] - b[0][k] for b in boxes)[n // 2]
        return (max(b[1][k] for b in boxes) - min(b[0][k] for b in boxes)) / max(size, tol)

    k = max(range(3), key=spread)
    order = sorted(range(n), key=lambda i: boxes[i][0][k])
    out = []
    for a, i in enumerate(order):
        lo, hi = boxes[i]
        for j in order[a + 1:]:
            qlo, qhi = boxes[j]
            if qlo[k] > hi[k] + tol:
                break
            if all(qlo[q] <= hi[q] + tol and lo[q] <= qhi[q] + tol for q in range(3)):
                out.append((i, j) if i < j else (j, i))
    return out


def _covered(rect, rects, tol: float) -> bool:
    """Whether the rectangles ``rects`` (u0, u1, v0, v1) cover ``rect`` (up to ``tol``)."""
    u0, u1, v0, v1 = rect
    cut = [(max(a0, u0), min(a1, u1), max(b0, v0), min(b1, v1)) for a0, a1, b0, b1 in rects]
    cut = [c for c in cut if c[1] - c[0] > tol and c[3] - c[2] > tol]
    if len(cut) > 400:
        return True   # too many pieces to test: say covered (no warning rather than a slow check)

    def grid(values):
        out = []
        for x in sorted(values):
            if not out or x - out[-1] > tol:
                out.append(x)
        return out

    us = grid([u0, u1] + [c[0] for c in cut] + [c[1] for c in cut])
    vs = grid([v0, v1] + [c[2] for c in cut] + [c[3] for c in cut])
    for i in range(len(us) - 1):
        mu = (us[i] + us[i + 1]) / 2
        for j in range(len(vs) - 1):
            mv = (vs[j] + vs[j + 1]) / 2
            if not any(c[0] - tol <= mu <= c[1] + tol and c[2] - tol <= mv <= c[3] + tol for c in cut):
                return False
    return True


class _MetalPlacement:
    """``metal-overhang`` and ``metal-floating`` on the resolved, transformed geometry.

    Both work on bounding boxes, which are exact for bricks, sheets and (quarter-turn) rotated
    copies of them and outer bounds for everything else. Only metal whose box its own shape
    reaches (``_PLATES``) is judged, and every other shape counts with its (larger) box as
    something the metal may touch or lie on: a box that is too big can hide a problem, never make
    one up. The tolerance is a few µm plus 1e-6 of the model size."""

    def __init__(self, lint: _Lint, parts: list, scale: float):
        self.lint = lint
        self.tol = 0.003 + 1e-6 * scale
        self.ok = True   # every port and resistor resolved (else a floating check could be wrong)
        self.items: list[dict] = []   # kind: "metal", "dielectric" or "feed" (a port or a resistor)
        for part in parts:
            name = lint.d["parts"][part["index"]]["material"]
            air = part["dielectric"] and self._air(name)
            kind = "metal" if part["metal"] else "dielectric"
            for p in part["prims"]:
                self.items.append({"kind": kind, "part": part, "prim": p, "box": lint._bbox(p), "air": air})
        # every physical feed of a grouped port holds metal, not only the port's first one
        feeds = [f for i, po in enumerate(lint.d.get("ports", [])) for _, f in port_feeds(po, f"ports[{i}]")]
        for po in feeds + list(lint.d.get("resistors", [])):
            try:
                a = [evaluate(x, lint.names) for x in po["start"]]
                c = [evaluate(x, lint.names) for x in po["stop"]]
            except (DesignError, TypeError, KeyError):
                self.ok = False
                continue
            box = ([min(a[q], c[q]) for q in range(3)], [max(a[q], c[q]) for q in range(3)])
            self.items.append({"kind": "feed", "part": None, "prim": None, "box": box, "air": False})

    def _air(self, material: str) -> bool:
        """A dielectric with εr = 1 and no loss (a vacuum region): nothing a conductor is printed on."""
        eps = self.lint.V.get(f"materials.{material}.eps_r")
        tan = self.lint.V.get(f"materials.{material}.tan_d", 0.0)
        return eps is not None and abs(eps - 1) < 1e-9 and tan <= 0

    def run(self):
        if not any(it["kind"] == "metal" for it in self.items):
            return
        nb: list[list[int]] = [[] for _ in self.items]
        for i, j in _touch_pairs([it["box"] for it in self.items], self.tol):
            nb[i].append(j)
            nb[j].append(i)
        self.overhang(nb)
        if self.ok:
            self.floating(nb)

    @staticmethod
    def _plate_normal(p: dict, lo, hi, tol: float, k: int) -> bool:
        """Whether metal ``p`` is a plate normal to axis k: thin along k against its size across."""
        u, v = in_plane(k)
        su, sv = hi[u] - lo[u], hi[v] - lo[v]
        if su <= tol or sv <= tol or hi[k] - lo[k] > 0.25 * min(su, sv):
            return False
        return p["kind"] == "box" or p["normal"] == k

    # ------------------------------------------------------------ metal-overhang

    def overhang(self, nb):
        """A metal plate on a dielectric face (or inside a dielectric layer) that reaches past
        everything below and above it: past the dielectric, and past any metal body it runs onto.
        A plate thicker than half the dielectric under it is not judged (a chassis, a reflector
        block), nor is metal that lies on no dielectric at all (a horn, a wire in the air)."""
        tol, worst = self.tol, {}
        for i, it in enumerate(self.items):
            p = it["prim"]
            if it["kind"] != "metal" or p["kind"] not in _PLATES:
                continue
            lo, hi = it["box"]
            for k in range(3):
                if not self._plate_normal(p, lo, hi, tol, k):
                    continue
                u, v = in_plane(k)
                t = hi[k] - lo[k]
                supports, cover = [], []
                for j in nb[i]:
                    o = self.items[j]
                    if o["kind"] == "feed":
                        continue
                    olo, ohi = o["box"]
                    if (min(hi[u], ohi[u]) - max(lo[u], olo[u]) <= tol
                            or min(hi[v], ohi[v]) - max(lo[v], olo[v]) <= tol):
                        continue   # no area in common across k: beside the plate, not under it
                    if o["kind"] == "dielectric":
                        cover.append(o)
                        on = (abs(ohi[k] - lo[k]) <= tol or abs(olo[k] - hi[k]) <= tol
                              or (olo[k] - tol <= lo[k] and hi[k] <= ohi[k] + tol))
                        if on and not o["air"] and _faces_along(o["prim"], k) and t <= 0.5 * (ohi[k] - olo[k]):
                            supports.append(o)
                    elif olo[k] < lo[k] - tol or ohi[k] > hi[k] + tol:
                        cover.append(o)   # a metal body the plate runs onto (a connector, a wall)
                if not supports:
                    continue
                rects = [(o["box"][0][u], o["box"][1][u], o["box"][0][v], o["box"][1][v]) for o in cover]
                if _covered((lo[u], hi[u], lo[v], hi[v]), rects, tol):
                    continue
                sides = []
                for ax, (a0, a1) in ((u, (0, 1)), (v, (2, 3))):
                    top = max(r[a1] for r in rects)
                    bottom = min(r[a0] for r in rects)
                    if hi[ax] - top > tol:
                        sides.append((hi[ax] - top, f"{AXES[ax]}+"))
                    if bottom - lo[ax] > tol:
                        sides.append((bottom - lo[ax], f"{AXES[ax]}-"))
                if not sides:
                    continue   # a hole in the dielectric under it (an air cavity), not an edge
                sides.sort(key=lambda x: (-x[0], x[1]))

                def area(o):
                    olo, ohi = o["box"]
                    return (min(hi[u], ohi[u]) - max(lo[u], olo[u])) * (min(hi[v], ohi[v]) - max(lo[v], olo[v]))

                under = max(supports, key=area)["part"]["name"]
                idx = it["part"]["index"]
                if idx not in worst or sides[0][0] > worst[idx][0]:
                    by = " and ".join(f"{a:.3g} mm ({s})" for a, s in sides)
                    worst[idx] = (sides[0][0], p["where"],
                                  f"{it['part']['name']!r} overhangs {under!r} by {by}: the metal lies on the dielectric's "
                                  "face but reaches past its edge into the air",
                                  self._trim_fix(i, k, cover, rects, nb, under))
        for idx in sorted(worst):
            amount, where, message, fix = worst[idx]
            self.warn(where, "metal-overhang", message, amount, fix)

    def _trim_fix(self, i: int, k: int, cover: list, rects: list, nb, under: str) -> dict | None:
        """Clip a brick's extent across axis k to the bounding box of what it lies on. Only for a brick
        drawn as it is (no transforms, cuts or live Boolean on its part, start and stop giving its
        box), and only when the clipped brick is fully supported and still touches every port and
        resistor that touched it."""
        it, tol, lint = self.items[i], self.tol, self.lint
        part = lint.d["parts"][it["part"]["index"]]
        m = re.fullmatch(r"parts\[(\d+)\]\.primitives\[(\d+)\]", it["prim"].get("where") or "")
        if (not m or int(m[1]) != it["part"]["index"] or part.get("transforms") or part.get("cuts")
                or isinstance(part.get("booleanHistory"), dict) and part["booleanHistory"].get("live")):
            return None
        pr = part["primitives"][int(m[2])]
        lo, hi = it["box"]
        try:
            if pr["kind"] != "box" or any(abs(evaluate(pr["start"][q], lint.names) - lo[q]) > tol
                                          or abs(evaluate(pr["stop"][q], lint.names) - hi[q]) > tol for q in range(3)):
                return None
        except (DesignError, TypeError, KeyError, IndexError):
            return None
        new_lo, new_hi, sets = list(lo), list(hi), {}
        for ax in in_plane(k):
            for side, want in ((0, max), (1, min)):
                edge = (min if side == 0 else max)(o["box"][side][ax] for o in cover)
                value = want(edge, (lo, hi)[side][ax])
                if abs(value - (lo, hi)[side][ax]) <= tol:
                    continue
                (new_lo, new_hi)[side][ax] = value
                src = next(o for o in cover if abs(o["box"][side][ax] - edge) <= tol)
                sets[f"{it['prim']['where']}.{('start', 'stop')[side]}[{ax}]"] = lint._coord(src["prim"], ax, value)
        u, v = in_plane(k)
        if not sets or new_hi[u] - new_lo[u] <= tol or new_hi[v] - new_lo[v] <= tol:
            return None
        if not _covered((new_lo[u], new_hi[u], new_lo[v], new_hi[v]), rects, tol):
            return None
        for j in nb[i]:
            f = self.items[j]
            if f["kind"] == "feed" and not all(f["box"][0][q] <= new_hi[q] + tol and new_lo[q] <= f["box"][1][q] + tol
                                               for q in range(3)):
                return None   # the trim would cut the metal off a port
        return {"label": f"Trim the metal to {under!r}", "set": sets}

    def warn(self, where: str, code: str, message: str, excess: float, fix: dict | None = None):
        """A placement warning with ``excess_mm``: how far the metal is off (the largest overhang,
        or the gap), which grades the optimizer's penalty for a skipped candidate."""
        self.lint.warn(where, code, message, fix)
        self.lint.out[-1]["excess_mm"] = round(excess, 6)

    # ------------------------------------------------------------ metal-floating

    def _pec_anchors(self):
        """Boxes standing for the PEC domain faces a metal may rest on: the bundle's domain when
        there is one, else the model's own extent on each PEC side (where the face is at the latest)."""
        faces = self.lint._pec_faces()
        if faces:
            return faces
        b = self.lint.d.get("simulation", {}).get("boundaries", "MUR")
        bl = [b] * 6 if isinstance(b, str) else list(b)
        if not any(str(x).upper() == "PEC" for x in bl) or not self.items:
            return []
        lo = [min(it["box"][0][q] for it in self.items) for q in range(3)]
        hi = [max(it["box"][1][q] for it in self.items) for q in range(3)]
        return [(n // 2, (lo if n % 2 == 0 else hi)[n // 2]) for n, x in enumerate(bl) if str(x).upper() == "PEC"]

    def floating(self, nb):
        """A group of touching metal bricks and polygons that touches no other metal, no dielectric,
        no port, no resistor and no PEC boundary, and that lies close to the structure (within 5 %
        of its own size of a dielectric or of connected metal, or in the plane of a dielectric face
        within its own size of that dielectric) or is a solid block. Plates, strips and sheets far
        off in the air (a director, a reflector, an FSS in free space) are left alone: they are
        probably meant to be parasitic."""
        tol, items = self.tol, self.items
        parent = list(range(len(items)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        for i, it in enumerate(items):
            if it["kind"] == "metal":
                for j in nb[i]:
                    if items[j]["kind"] == "metal":
                        parent[find(i)] = find(j)
        pec = self._pec_anchors()
        anchored, groups = set(), {}
        for i, it in enumerate(items):
            if it["kind"] != "metal":
                continue
            r = find(i)
            groups.setdefault(r, []).append(i)
            lo, hi = it["box"]
            if any(items[j]["kind"] != "metal" for j in nb[i]) or any(lo[ax] - tol <= at <= hi[ax] + tol for ax, at in pec):
                anchored.add(r)
        told = set()
        for r, members in groups.items():
            if r in anchored or any(items[m]["prim"]["kind"] not in _PLATES for m in members):
                continue
            first = items[members[0]]
            if first["part"]["index"] in told:
                continue
            clo = [min(items[m]["box"][0][q] for m in members) for q in range(3)]
            chi = [max(items[m]["box"][1][q] for m in members) for q in range(3)]
            size = max(chi[q] - clo[q] for q in range(3))
            found = self._near((clo, chi), size, anchored, find) or self._beside(members) or self._block(members)
            if found is None:
                continue
            message, excess = found
            told.add(first["part"]["index"])
            names = list(dict.fromkeys(items[m]["part"]["name"] for m in members))
            what = repr(names[0]) if len(names) == 1 else "the connected metal " + ", ".join(map(repr, names))
            self.warn(first["prim"]["where"], "metal-floating",
                      f"{what} touches no other metal, no dielectric and no port: {message}", excess)

    def _near(self, box, size: float, anchored: set, find) -> tuple | None:
        """Within 5 % of ``size`` of a dielectric or of metal that is connected to the structure."""
        best = None
        for j, o in enumerate(self.items):
            if o["kind"] == "feed" or (o["kind"] == "metal" and find(j) not in anchored):
                continue
            g = _gap(box, o["box"])
            d = math.sqrt(sum(x * x for x in g))
            if d <= 0.05 * size and (best is None or d < best[0]):
                best = (d, g, o)
        if best is None:
            return None
        d, g, o = best
        ax = max(range(3), key=lambda q: g[q])
        side = "+" if box[0][ax] >= o["box"][1][ax] - self.tol else "-"
        return f"it floats {d:.3g} mm off {o['part']['name']!r}, on its {AXES[ax]}{side} side (an isolated conductor in the air)", d

    def _block(self, members) -> tuple | None:
        """A solid block (no side under a quarter of the longest) in the air: parasitic elements are
        plates, strips or wires, so a lone block is almost always misplaced."""
        for m in members:
            lo, hi = self.items[m]["box"]
            dims = [hi[q] - lo[q] for q in range(3)]
            if min(dims) > self.tol and min(dims) >= 0.25 * max(dims):
                size = " × ".join(f"{x:.3g}" for x in dims)
                return f"it is a solid {size} mm block isolated in the air", 0.0
        return None

    def _beside(self, members) -> tuple | None:
        """A plate in the plane of a dielectric face, off that face but within its own size of it
        (a patch moved off the edge of its substrate)."""
        tol = self.tol
        for m in members:
            it = self.items[m]
            lo, hi = it["box"]
            for k in range(3):
                if not self._plate_normal(it["prim"], lo, hi, tol, k):
                    continue
                u, v = in_plane(k)
                reach = max(hi[u] - lo[u], hi[v] - lo[v])
                for o in self.items:
                    if o["kind"] != "dielectric" or o["air"] or not _faces_along(o["prim"], k):
                        continue
                    olo, ohi = o["box"]
                    if abs(ohi[k] - lo[k]) <= tol:
                        face = f"{AXES[k]}+"
                    elif abs(olo[k] - hi[k]) <= tol:
                        face = f"{AXES[k]}-"
                    else:
                        continue
                    g = _gap(it["box"], o["box"])
                    if max(g[u], g[v]) > reach:
                        continue
                    ax = u if g[u] >= g[v] else v
                    side = "+" if lo[ax] >= ohi[ax] - tol else "-"
                    return (f"it lies in the plane of the {face} face of {o['part']['name']!r} ({AXES[k]} = "
                            f"{(ohi[k] if face.endswith('+') else olo[k]):g}) but {g[ax]:.3g} mm past its {AXES[ax]}{side} edge",
                            g[ax])
        return None


class _BoxIndex:
    """The primitives of a part in a uniform grid of their bounding boxes, for :func:`_inside`.

    A box that holds another box holds its low corner, so :meth:`candidates` returns the primitives
    whose box (widened by the tolerance of ``_inside``, and by one more cell each side against
    rounding) covers the grid cell of that corner: every primitive that could pass the box test of
    ``_inside``, in no particular order (the callers only ask whether any of them holds it). A box
    that spans much of the grid is always a candidate. Few primitives, or boxes that are not all
    finite, are not indexed: every primitive is a candidate."""

    MIN_PRIMS = 32

    def __init__(self, prims: list, bbox=prim_bbox):
        self.prims, self.cells = prims, None
        if len(prims) < self.MIN_PRIMS:
            return
        boxes = [bbox(q) for q in prims]
        lo = [min(b[0][k] for b in boxes) for k in range(3)]
        hi = [max(b[1][k] for b in boxes) for k in range(3)]
        if not all(math.isfinite(v) for v in lo + hi):
            return
        # about one typical box per cell along each axis, at most ~4 cells per primitive in all
        n = len(prims)
        self.n = [1, 1, 1]
        for k in range(3):
            if hi[k] > lo[k]:
                size = sorted(b[1][k] - b[0][k] for b in boxes)[n // 2]
                self.n[k] = max(1, min(n, round((hi[k] - lo[k]) / size) if size > 0 else n))
        excess = self.n[0] * self.n[1] * self.n[2] / (4 * n)
        if excess > 1:
            active = sum(1 for c in self.n if c > 1)
            self.n = [max(1, int(c / excess ** (1 / active))) if c > 1 else 1 for c in self.n]
        self.o = lo
        self.w = [(hi[k] - lo[k]) / self.n[k] if hi[k] > lo[k] else 1.0 for k in range(3)]
        limit = max(8, self.n[0] * self.n[1] * self.n[2] // 8)
        self.always: list[int] = []
        self.cells: dict[tuple, list[int]] = {}
        for i, (qlo, qhi) in enumerate(boxes):
            span = [range(self._cell(k, qlo[k] - EPS, -1), self._cell(k, qhi[k] + EPS, +1) + 1) for k in range(3)]
            if len(span[0]) * len(span[1]) * len(span[2]) > limit:
                self.always.append(i)
                continue
            for cx in span[0]:
                for cy in span[1]:
                    for cz in span[2]:
                        self.cells.setdefault((cx, cy, cz), []).append(i)

    def _cell(self, k: int, v: float, pad: int = 0) -> int:
        return min(self.n[k] - 1, max(0, math.floor((v - self.o[k]) / self.w[k]) + pad))

    def candidates(self, lo) -> list:
        if self.cells is None:
            return self.prims
        found = self.cells.get(tuple(self._cell(k, lo[k]) for k in range(3)), [])
        return [self.prims[i] for i in (found + self.always if self.always else found)]


def _inside(p: dict, q: dict, bbox=prim_bbox) -> bool:
    """Whether resolved primitive ``p`` lies inside ``q`` (tested on p's bounding-box corners, so
    only for convex containers: bricks, solid cylinders, spheres, convex polygons, cones, straight
    wires). ``bbox``: prim_bbox, or a cached version of it."""
    (plo, phi), (qlo, qhi) = bbox(p), bbox(q)
    if any(plo[k] < qlo[k] - 1e-9 or phi[k] > qhi[k] + 1e-9 for k in range(3)):
        return False   # a corner outside q's box: prim_contains below would say so for that corner
    if (q["kind"] == "cylinder" and q.get("inner_radius", 0) > 0) or q["kind"] == "torus":
        return False
    if q["kind"] == "polyhedron":
        return False   # not known to be convex
    if q["kind"] == "wire" and len(q["points"]) > 2:
        return False   # a bent wire is not convex (a straight one is a capsule)
    if q["kind"] in ("polygon", "linpoly") and not _convex(q["points"]):
        return False
    lo, hi = plo, phi
    corners = {(x, y, z) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])}
    return all(prim_contains(q, c, 1e-9) for c in corners)


def _convex(pts) -> bool:
    sign = 0
    n = len(pts)
    for i in range(n):
        (x0, y0), (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % n], pts[(i + 2) % n]
        cr = (x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1)
        if abs(cr) > 1e-12:
            if sign and (cr > 0) != (sign > 0):
                return False
            sign = cr
    return True


def _solid_spans(p: dict, ax: int, lo, hi):
    """Intervals along ``ax`` that a primitive fills (a tube's wall on either side of its bore)."""
    if p["kind"] == "cylinder" and p.get("inner_radius", 0) > 0:
        a, c = p["start"], p["stop"]
        along = max(range(3), key=lambda k: abs(c[k] - a[k]))
        if ax != along and sum(abs(c[k] - a[k]) > EPS for k in range(3)) == 1:
            ctr, ro, ri = a[ax], p["radius"], p["inner_radius"]
            return [(ctr - ro, ctr - ri), (ctr + ri, ctr + ro)]
    if p["kind"] == "torus" and ax != p["axis"]:
        ctr, big, small = p["origin"][ax], p["major"], p["minor"]
        return [(ctr - big - small, ctr - big + small), (ctr + big - small, ctr + big + small)]
    return [(lo[ax], hi[ax])]


def polygon_problems(uv: list) -> list[tuple[str, str]]:
    """Fewer than 3 distinct points, zero area or self-intersections of a closed polygon."""
    pts = []
    for q in uv:
        if not pts or abs(q[0] - pts[-1][0]) > EPS or abs(q[1] - pts[-1][1]) > EPS:
            pts.append(q)
    if len(pts) > 1 and abs(pts[0][0] - pts[-1][0]) <= EPS and abs(pts[0][1] - pts[-1][1]) <= EPS:
        pts.pop()
    if len({(round(x, 9), round(y, 9)) for x, y in pts}) < 3:
        return [("polygon-points", "a polygon needs at least 3 distinct points")]
    # zero area: every point on the line through the first point and the one farthest from it
    x0, y0 = pts[0]
    fx, fy = max(pts, key=lambda q: (q[0] - x0) ** 2 + (q[1] - y0) ** 2)
    span2 = (fx - x0) ** 2 + (fy - y0) ** 2
    if all(abs((fx - x0) * (y - y0) - (fy - y0) * (x - x0)) <= 1e-9 * span2 for x, y in pts):
        return [("polygon-area", "the polygon has zero area (its points are on one line)")]
    n = len(pts)
    if n <= 400:
        hit = _first_crossing(pts)
        if hit is not None:
            i, j = hit
            return [("polygon-self-intersect",
                     f"the outline crosses itself (edges {i + 1}–{i + 2} and {j + 1}–{(j + 1) % n + 1})")]
    return []


def _first_crossing(pts) -> tuple[int, int] | None:
    """The first pair of edges (i < j, in that order) of a closed outline that touch or cross,
    leaving out neighbouring edges. Only pairs whose x ranges overlap are tested (a sweep over the
    edges sorted by their left end): the same answer as testing every pair, without the n² cost
    on detailed outlines."""
    n = len(pts)
    ends = [(pts[i], pts[(i + 1) % n]) for i in range(n)]
    lo = [min(a[0], b[0]) for a, b in ends]
    hi = [max(a[0], b[0]) for a, b in ends]
    ylo = [min(a[1], b[1]) for a, b in ends]
    yhi = [max(a[1], b[1]) for a, b in ends]
    # far wider than any tolerance of _segments_cross (EPS on the ends, 1e-12 on orientations)
    margin = 1e-6 * max([1.0] + [abs(c) for q in pts for c in q])
    order = sorted(range(n), key=lo.__getitem__)
    best = None
    for k, i in enumerate(order):
        for j in order[k + 1:]:
            if lo[j] > hi[i] + margin:
                break
            if ylo[j] > yhi[i] + margin or ylo[i] > yhi[j] + margin:
                continue
            a, b = (i, j) if i < j else (j, i)
            if b == a + 1 or (a == 0 and b == n - 1):
                continue   # neighbouring edges share a vertex
            if (best is None or (a, b) < best) and _segments_cross(*ends[a], *ends[b]):
                best = (a, b)
    return best


def _segments_cross(p1, p2, p3, p4) -> bool:
    """Whether two segments touch or cross (including collinear overlap)."""
    def orient(a, b, c):
        v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        return 0 if abs(v) < 1e-12 else (1 if v > 0 else -1)

    def on_seg(a, b, c):
        return min(a[0], b[0]) - EPS <= c[0] <= max(a[0], b[0]) + EPS and min(a[1], b[1]) - EPS <= c[1] <= max(a[1], b[1]) + EPS

    o1, o2, o3, o4 = orient(p1, p2, p3), orient(p1, p2, p4), orient(p3, p4, p1), orient(p3, p4, p2)
    if o1 != o2 and o3 != o4 and o1 * o2 <= 0 and o3 * o4 <= 0:
        return True
    return ((o1 == 0 and on_seg(p1, p2, p3)) or (o2 == 0 and on_seg(p1, p2, p4))
            or (o3 == 0 and on_seg(p3, p4, p1)) or (o4 == 0 and on_seg(p3, p4, p2)))


def lint(design: dict, values: dict | None = None, bundle: dict | None = None) -> list[dict]:
    """Checks for a design (see the module docstring). ``values``: independent parameter values
    (defaults when omitted); ``bundle``: its preview bundle, for the mesh checks."""
    if not isinstance(design, dict):
        return [{"severity": "error", "path": "", "code": "structure", "message": "a design is a JSON object",
                 "explain": EXPLANATIONS["structure"]}]
    return _Lint(design, values, bundle).run()


def errors(checks: list[dict]) -> list[dict]:
    return [c for c in checks if c["severity"] == "error"]


def run_blockers(checks: list[dict], allowed: frozenset | set = frozenset()) -> list[dict]:
    """The checks that keep a design point from being simulated (the optimizer skips such a
    candidate): every error, and a metal placement warning (``PLACEMENT``) unless its
    ``(code, path)`` is in ``allowed`` (the design as drawn already has it: meant, not caused by
    the candidate's values)."""
    return [c for c in checks if c["severity"] == "error"
            or (c["code"] in PLACEMENT and (c["code"], c["path"]) not in allowed)]
