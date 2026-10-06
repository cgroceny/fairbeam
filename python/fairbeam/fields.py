"""Surface-current maps on planar metal sheets (optional ``fields`` bundle section).

What is recorded
    For every plane that holds zero-thickness metal (a box with zero extent on one axis, or a
    polygon), a frequency-domain openEMS dump of **rot(H)** (dump type 13, total current density)
    is placed exactly on the sheet's mesh plane. On a PEC sheet the loop integral of H around an
    in-plane Yee edge encloses the sheet's surface current, so the in-plane components of rot(H)
    equal J_s / Δn, where Δn is the (constant) dual cell width normal to the plane. The normalised
    magnitude sqrt(|J_u|^2 + |J_v|^2) is therefore the surface current density magnitude |J_s|,
    in A/m, up to one constant per plane.

What is stored
    The magnitude is resampled bilinearly from the (non-uniform) FDTD mesh onto a regular grid of
    at most ``max_samples`` points along the longer side. It is normalised to 1 at its maximum over
    the metal at each frequency and quantised to integers 0..1000. Samples outside the metal are -1.
    The metal mask uses the exact primitives, not the staircase approximation.
    The complex in-plane components are also stored as signed int8 samples relative to that same
    peak, so a viewer can reconstruct a phase-resolved current vector.

Caveats
    - ``values`` are phasor magnitudes (peak over one RF cycle), not an instantaneous snapshot.
    - Right at metal edges the FDTD current is the staircase current of the edge cell. The edge
      singularity is resolved only as far as the mesh allows, so the peak value depends on the mesh.
      Compare shapes, not absolute peaks.
    - Dump frequencies are fixed before the run. Without explicit frequencies a uniform grid is
      dumped and the sample nearest each far-field frequency is stored. The stored ``f`` is the
      frequency actually used.
    - One excitation only: the maps come from a single openEMS run. In a multi-port run
      (``fairbeam.multiport``, one run per excited port) the dumps are attached to the first
      excited port's run, with the other ports terminated. The section's ``port`` names that
      driven port; there are no per-port maps.
"""

from __future__ import annotations

import base64
import os

import numpy as np

PREFIX = "fairbeam_J_"
METAL_TYPES = ("Metal", "ConductingSheet")


def sheet_planes(sim, max_planes: int = 4) -> list[dict]:
    """Planes (axis, position) holding zero-thickness metal, with their primitives and extent."""
    planes: dict[tuple, dict] = {}
    for prim in sim.csx.GetAllPrimitives():
        prop = prim.GetProperty()
        if prop.GetTypeString() not in METAL_TYPES:
            continue
        kind = prim.GetTypeName()
        if kind == "Box":
            a, b = np.array(prim.GetStart(), float), np.array(prim.GetStop(), float)
            flat = np.where(np.isclose(a, b))[0]
            if len(flat) != 1:
                continue
            axis = int(flat[0])
            u, v = (axis + 1) % 3, (axis + 2) % 3
            shape = {"kind": "rect", "u": sorted([a[u], b[u]]), "v": sorted([a[v], b[v]])}
            pos = a[axis]
        elif kind == "Polygon":
            axis = int(prim.GetNormDir())
            c0, c1 = prim.GetCoords()
            shape = {"kind": "poly", "pts": np.c_[np.asarray(c0, float), np.asarray(c1, float)]}
            pos = float(prim.GetElevation())
        else:
            continue
        key = (axis, round(float(pos), 6))
        entry = planes.setdefault(key, {"axis": axis, "position": float(pos), "shapes": [], "parts": []})
        entry["shapes"].append(shape)
        if prop.GetName() not in entry["parts"]:
            entry["parts"].append(prop.GetName())
    out = []
    for entry in planes.values():
        us, vs = [], []
        for s in entry["shapes"]:
            if s["kind"] == "rect":
                us += s["u"]
                vs += s["v"]
            else:
                us += list(s["pts"][:, 0])
                vs += list(s["pts"][:, 1])
        entry["u_range"] = [float(min(us)), float(max(us))]
        entry["v_range"] = [float(min(vs)), float(max(vs))]
        out.append(entry)
    # largest sheets last so a cap keeps the radiating ones (patch, strip) rather than huge grounds
    out.sort(key=lambda e: (e["u_range"][1] - e["u_range"][0]) * (e["v_range"][1] - e["v_range"][0]))
    return out[:max_planes]


def attach(sim, freqs, max_planes: int = 4) -> list[dict]:
    """Add rot(H) frequency-domain dumps on every metal sheet plane. Call after ``build`` and
    before ``run``. Returns the plane descriptions (also kept as ``sim.field_planes``)."""
    freqs = [float(f) for f in freqs]
    planes = sheet_planes(sim, max_planes)
    for i, pl in enumerate(planes):
        axis = pl["axis"]
        u, v = (axis + 1) % 3, (axis + 2) % 3
        start, stop = [0.0] * 3, [0.0] * 3
        start[axis] = stop[axis] = pl["position"]
        pad_u = 0.02 * (pl["u_range"][1] - pl["u_range"][0]) + 1e-6
        pad_v = 0.02 * (pl["v_range"][1] - pl["v_range"][0]) + 1e-6
        start[u], stop[u] = pl["u_range"][0] - pad_u, pl["u_range"][1] + pad_u
        start[v], stop[v] = pl["v_range"][0] - pad_v, pl["v_range"][1] + pad_v
        pl["name"] = f"{PREFIX}{'xyz'[axis]}{i}"
        dump = sim.csx.AddDump(pl["name"], dump_type=13, file_type=1, frequency=freqs, dump_mode=1)
        dump.AddBox(start, stop)
    sim.field_planes = planes
    sim.field_freqs = freqs
    sim.field_port = driven_port(sim)
    return planes


def driven_port(sim) -> int | None:
    """Number of the one excited port of this build (the excitation behind its field dumps), or
    None when no port or several ports are excited, or the model's ports are not recorded."""
    excited = [p["number"] for p in getattr(sim, "ports", []) if p.get("excite")]
    return int(excited[0]) if len(excited) == 1 else None


def _inside(shapes, uu, vv):
    mask = np.zeros(uu.shape, bool)
    for s in shapes:
        if s["kind"] == "rect":
            mask |= (uu >= s["u"][0] - 1e-9) & (uu <= s["u"][1] + 1e-9) & (vv >= s["v"][0] - 1e-9) & (vv <= s["v"][1] + 1e-9)
        else:  # even-odd ray casting
            pts = s["pts"]
            inside = np.zeros(uu.shape, bool)
            for (u1, v1), (u2, v2) in zip(pts, np.roll(pts, -1, axis=0)):
                cond = (v1 > vv) != (v2 > vv)
                with np.errstate(divide="ignore", invalid="ignore"):
                    x_cross = (u2 - u1) * (vv - v1) / (v2 - v1) + u1
                inside ^= cond & (uu < x_cross)
            mask |= inside
    return mask


def _resample(lines_u, lines_v, values, grid_u, grid_v):
    """Separable bilinear interpolation from a rectilinear (u, v) grid."""
    tmp = np.array([np.interp(grid_u, lines_u, values[:, j]) for j in range(values.shape[1])])  # (nv_in, nu)
    return np.array([np.interp(grid_v, lines_v, tmp[:, i]) for i in range(tmp.shape[1])]).T      # (nv, nu)


def _phase_payload(ju, jv, lines_u, lines_v, grid_u, grid_v, mask, peak, transpose=False):
    """Encode resampled [Ju.re, Ju.im, Jv.re, Jv.im] as signed int8 base64."""
    if transpose:
        ju, jv = ju.T, jv.T
    components = [_resample(lines_u, lines_v, c, grid_u, grid_v)
                  for c in (ju.real, ju.imag, jv.real, jv.imag)]
    denom = peak if peak > 0 else 1.0
    quantized = np.clip(np.round(127 * np.stack(components, axis=-1) / denom), -128, 127).astype(np.int8)
    quantized[~mask] = 0
    return base64.b64encode(quantized.tobytes(order="C")).decode("ascii")


def collect(sim, target_freqs, max_samples: int = 100) -> dict | None:
    """Read the dumps after ``run`` and build the bundle's ``fields`` section."""
    from openEMS.utilities import HDF5Dump

    planes = getattr(sim, "field_planes", None)
    if not planes or sim.sim_path is None:
        return None
    dumped = np.asarray(sim.field_freqs)
    out_planes = []
    for pl in planes:
        path = os.path.join(sim.sim_path, pl["name"] + ".h5")
        if not os.path.exists(path):
            continue
        axis = pl["axis"]
        u, v = (axis + 1) % 3, (axis + 2) % 3
        du = pl["u_range"][1] - pl["u_range"][0]
        dv = pl["v_range"][1] - pl["v_range"][0]
        step = max(du, dv) / (max_samples - 1)
        nu, nv = max(2, int(round(du / step)) + 1), max(2, int(round(dv / step)) + 1)
        gu = np.linspace(pl["u_range"][0], pl["u_range"][1], nu)
        gv = np.linspace(pl["v_range"][0], pl["v_range"][1], nv)
        uu, vv = np.meshgrid(gu, gv)
        mask = _inside(pl["shapes"], uu, vv)
        entries = []
        with HDF5Dump(path) as h5:
            mesh = h5.GetMesh()
            lines = [np.asarray(l) / sim.unit for l in mesh["lines"]]
            for ft in target_freqs:
                k = int(np.argmin(np.abs(dumped - ft)))
                data = np.asarray(h5.GetFieldAtFrequency(float(dumped[k])))  # (3, Nx, Ny, Nz) complex
                plane = np.take(data, 0, axis=1 + axis)                       # drop the normal axis
                # remaining axes are in x, y, z order without `axis`; map them to (u, v)
                rest = [a for a in range(3) if a != axis]
                comp = {rest[0]: 0, rest[1]: 1}
                ju, jv = plane[u], plane[v]
                mag = np.sqrt(np.abs(ju) ** 2 + np.abs(jv) ** 2)
                if comp[u] == 1:  # stored (v, u): transpose to (u, v)
                    mag = mag.T
                grid = _resample(lines[u], lines[v], mag, gu, gv)
                peak = float(grid[mask].max()) if mask.any() else float(grid.max())
                q = np.where(mask, np.round(1000 * grid / peak) if peak > 0 else 0, -1).astype(int)
                # Keep the component phase in the same (v, u) row-major layout as `values`.
                # `plane`'s remaining axes are in natural x/y/z order; transpose when u is second.
                phasors = _phase_payload(ju, jv, lines[u], lines[v], gu, gv, mask, peak,
                                         transpose=comp[u] == 1)
                entries.append({"f": float(dumped[k]), "f_target": float(ft), "values": q.ravel().tolist(),
                                "phasors": phasors})
        out_planes.append({
            "name": pl["name"], "parts": pl["parts"], "axis": axis, "position": round(pl["position"], 6),
            "u_axis": u, "v_axis": v, "u_range": [round(x, 6) for x in pl["u_range"]],
            "v_range": [round(x, 6) for x in pl["v_range"]], "nu": nu, "nv": nv, "frequencies": entries,
        })
    if not out_planes:
        return None
    return section(out_planes, getattr(sim, "field_port", None))


def section(planes: list[dict], port: int | None) -> dict:
    """The bundle's ``fields`` section for resampled ``planes``; ``port`` is the driven port of the
    run that recorded them (omitted when unknown)."""
    return {
        "quantity": "surface_current",
        "definition": "|J_s| from the in-plane components of an openEMS rot(H) frequency-domain dump on the "
                      "metal sheet plane (phasor magnitude); bilinear resampling onto a regular grid",
        "units": "normalised: 1000 = maximum over the metal of the plane at that frequency; -1 = no metal",
        "phase_version": 1,
        **({"port": int(port)} if port is not None else {}),
        "planes": planes,
    }
