"""E- and H-field maps on cut planes (optional ``field_planes`` bundle section).

What is recorded
    For every requested plane (a design's ``monitors.field_planes``, ``fairbeam run --field-plane``)
    a frequency-domain openEMS dump of E (dump type 10) or H (type 11) is placed on the mesh line
    nearest the requested position, spanning the whole simulation domain in the plane. The dump uses
    node interpolation (openEMS dump mode 1), so every sample sits on a mesh node.

What is stored
    One entry per plane and frequency: the magnitude of the phasor, |E| = sqrt(|Ex|^2 + |Ey|^2 +
    |Ez|^2) (or |H|), or the magnitude of one Cartesian component, resampled bilinearly from the
    non-uniform FDTD mesh onto a regular grid of at most ``max_samples`` points along the longer side
    (and no finer than the finest mesh cell of the plane) and rounded to 3 significant digits.

    Optionally (``phasor``) the complex components behind the map, so a viewer can show the phase and
    the instantaneous field Re{E e^(j w t)} over one period: the complex components of the same
    resampled grid (all three for |E| / |H|, the one for a single component), each part as a signed
    8-bit integer against the common peak of the plane (base64, [v][u][component][re, im]). About
    6 bytes per pixel for |E|, 2 for one component, before base64.

Normalisation
    openEMS' frequency-domain dumps are the single-sided Fourier transform of the recorded field
    (2 dt sum f(t) exp(-j w t)), the same transform as the port voltages. Dividing by the incident
    wave of the driven port turns them into the field of a time-harmonic excitation: the stored
    values are peak phasor amplitudes (V/m or A/m) for 1 W incident (stimulated) power at the driven
    port, P_inc = |u_inc|^2 / (2 Re Z_ref). Without a single driven port the values are the raw
    transform (``normalization: "none"``). The complex components are also turned by the phase of the
    incident wave (multiplied by conj(u_inc) / |u_inc|), so phase 0 is the incident voltage wave of
    the driven port at t = 0 rather than the arbitrary time origin of the excitation pulse.

Caveats
    - Node interpolation: the normal E component right at a metal or dielectric surface is the
      average of the two neighbouring cells (openEMS documents this), so a plane exactly on a sheet
      or an interface shows an averaged normal field there. Put the plane a cell away for clean
      fringing fields.
    - Absorbing boundaries (PML) are part of the domain: the outermost cells of a PML boundary hold
      absorbed, non-physical fields.
    - Dump frequencies are fixed before the run and stored as recorded.
    - One excitation only, as for the surface currents (fairbeam.fields): in a multi-port run the
      dumps belong to the first excited port's run, the other ports terminated.
"""

from __future__ import annotations

import base64
import os

import numpy as np

PREFIX = "fairbeam_F_"
DUMP_TYPES = {"E": 10, "H": 11}      # openEMS frequency-domain E / H dumps (CSPropDumpBox)
UNITS = {"E": "V/m", "H": "A/m"}
AXES = "xyz"
COMPONENTS = ("abs", "x", "y", "z")
MAX_SAMPLES = 200


def parse_cli(specs) -> list[dict]:
    """``--field-plane Q NORMAL POSITION_MM GHZ[,GHZ...]`` (repeatable) as monitor dicts. Q is E or H,
    optionally with a component (Ex, Hz)."""
    out = []
    for q, normal, pos, freqs in specs or []:
        quantity, component = q[:1].upper(), (q[1:].lower() or "abs")
        if quantity not in DUMP_TYPES or component not in COMPONENTS:
            raise SystemExit(f"--field-plane: quantity {q!r} is E or H, optionally with a component (Ex, Hy, ...)")
        if normal.lower() not in AXES:
            raise SystemExit(f"--field-plane: normal {normal!r} is x, y or z")
        try:
            out.append({"quantity": quantity, "component": component, "normal": normal.lower(),
                        "position": float(pos), "frequencies": [float(f) * 1e9 for f in freqs.split(",") if f.strip()]})
        except ValueError:
            raise SystemExit(f"--field-plane: position {pos!r} (mm) and frequencies {freqs!r} (GHz) are numbers") from None
        if not out[-1]["frequencies"]:
            raise SystemExit("--field-plane: give at least one frequency in GHz")
    return out


def attach(sim, monitors: list[dict]) -> list[dict]:
    """Add one frequency-domain E or H dump per monitor ({quantity, normal, position (drawing
    units), frequencies (Hz), component?}) on the mesh line nearest its position, over the whole
    domain. Call after the mesh is final (after ``build``) and before ``run``; returns the planes
    (also kept as ``sim.field_plane_dumps``)."""
    from .fields import driven_port

    planes = []
    lines = [np.asarray(sim.mesh.GetLines(a), float) for a in AXES]
    for i, m in enumerate(monitors or []):
        axis = AXES.index(m["normal"])
        u, v = (axis + 1) % 3, (axis + 2) % 3
        ln = lines[axis]
        if len(ln) == 0 or not all(len(lines[k]) for k in (u, v)):
            continue
        k = int(np.argmin(np.abs(ln - float(m["position"]))))
        start, stop = [0.0] * 3, [0.0] * 3
        start[axis] = stop[axis] = float(ln[k])
        start[u], stop[u] = float(lines[u][0]), float(lines[u][-1])
        start[v], stop[v] = float(lines[v][0]), float(lines[v][-1])
        name = f"{PREFIX}{m['quantity']}{AXES[axis]}{i}"
        freqs = [float(f) for f in m["frequencies"]]
        dump = sim.csx.AddDump(name, dump_type=DUMP_TYPES[m["quantity"]], file_type=1, frequency=freqs, dump_mode=1)
        dump.AddBox(start, stop)
        planes.append({"name": name, "quantity": m["quantity"], "component": m.get("component") or "abs",
                       "axis": axis, "position": float(ln[k]), "requested": float(m["position"]),
                       "frequencies": freqs,
                       "outside": not ln[0] - 1e-9 <= float(m["position"]) <= ln[-1] + 1e-9})
    sim.field_plane_dumps = planes
    sim.field_plane_port = driven_port(sim)
    return planes


def _incident(sim, f: float):
    """(u_inc(f), P_inc(f)) of the driven port (after ``evaluate``), else None."""
    port = getattr(sim, "field_plane_port", None)
    results = getattr(sim, "results", None) or {}
    grid = results.get("frequency")
    if port is None or not grid:
        return None
    numbers = [p["number"] for p in getattr(sim, "ports", [])]
    if port not in numbers:
        return None
    obj = sim._port_objs[numbers.index(port)]
    uf = getattr(obj, "uf_inc", None)
    if uf is None or len(uf) != len(grid):
        return None
    grid = np.asarray(grid, float)
    uf = np.asarray(uf)
    a = np.interp(f, grid, np.real(uf)) + 1j * np.interp(f, grid, np.imag(uf))
    zr = np.real(np.asarray(obj.Z_ref, dtype=complex))
    z = float(zr) if zr.ndim == 0 else float(np.interp(f, grid, zr))
    p_inc = 0.5 * abs(a) ** 2 / z if z > 0 else 0.0
    return (complex(a), p_inc) if p_inc > 0 else None


def incident_power_scale(sim, f: float) -> float | None:
    """sqrt(1 W / P_inc(f)) of the driven port (after ``evaluate``), else None."""
    inc = _incident(sim, f)
    return float(np.sqrt(1.0 / inc[1])) if inc else None


def incident_phasor_scale(sim, f: float) -> complex | None:
    """The complex factor that turns a dumped transform into the phasor of a 1 W incident excitation
    whose incident voltage wave has phase 0: sqrt(1 W / P_inc) conj(u_inc) / |u_inc|. None without a
    single driven port (the phase of a raw transform has no reference)."""
    inc = _incident(sim, f)
    return float(np.sqrt(1.0 / inc[1])) * np.conj(inc[0]) / abs(inc[0]) if inc else None


def sample_grid(lines_u, lines_v, max_samples: int = MAX_SAMPLES):
    """Regular (u, v) sample positions over the mesh extent, the same step on both sides: as fine
    as the finest mesh cell of the plane (a non-uniform mesh is finest at the model, where the field
    varies fastest), but at most ``max_samples`` along the longer side."""
    lu, lv = np.asarray(lines_u, float), np.asarray(lines_v, float)
    du, dv = lu[-1] - lu[0], lv[-1] - lv[0]
    cells = np.concatenate([np.diff(lu), np.diff(lv)])
    finest = float(cells[cells > 0].min()) if np.any(cells > 0) else 0.0
    n = int(np.ceil(max(du, dv) / finest)) + 1 if finest > 0 else 2
    n = max(2, min(int(max_samples), n))
    step = max(du, dv) / (n - 1) if max(du, dv) > 0 else 1.0
    nu, nv = max(2, int(round(du / step)) + 1), max(2, int(round(dv / step)) + 1)
    return np.linspace(lu[0], lu[-1], nu), np.linspace(lv[0], lv[-1], nv)


def plane_fields(data, axis: int):
    """(3, n_u, n_v) complex components of a (3, Nx, Ny, Nz) dump holding one plane normal to ``axis``."""
    plane = np.take(np.asarray(data), 0, axis=1 + axis)       # (3, n_a, n_b), remaining axes in x/y/z order
    u = (axis + 1) % 3
    rest = [a for a in range(3) if a != axis]
    return np.swapaxes(plane, 1, 2) if rest[1] == u else plane  # to (u, v)


def plane_magnitude(data, axis: int, component: str = "abs"):
    """(u, v) magnitude of a (3, Nx, Ny, Nz) complex dump holding one plane normal to ``axis``."""
    plane = plane_fields(data, axis)
    if component == "abs":
        return np.sqrt(np.sum(np.abs(plane) ** 2, axis=0))
    return np.abs(plane[AXES.index(component)])


def phasor_payload(grids: list[np.ndarray], components: list[str]) -> dict | None:
    """The complex (nv, nu) ``grids`` of ``components`` as the bundle's ``phasor``: signed 8-bit
    [v][u][component][re, im] against the common peak (base64). None when the field is zero."""
    peak = max((float(np.abs(g).max()) if g.size else 0.0) for g in grids)
    peak = float(f"{peak:.4g}")
    if not peak > 0:
        return None
    stack = np.stack([np.stack([g.real, g.imag], axis=-1) for g in grids], axis=-2)   # (nv, nu, comp, 2)
    q = np.clip(np.round(127 * stack / peak), -127, 127).astype(np.int8)
    return {"components": list(components), "peak": peak, "data": base64.b64encode(q.tobytes(order="C")).decode("ascii")}


def _round3(a: np.ndarray) -> list:
    return [[float(f"{x:.3g}") for x in row] for row in a]


def collect(sim, max_samples: int = MAX_SAMPLES, phasor: bool = True) -> list[dict] | None:
    """Read the dumps after ``run`` (and ``evaluate``) and build the bundle's ``field_planes``, with
    the complex components (``phasor``) unless ``phasor`` is False."""
    from openEMS.utilities import HDF5Dump

    from .fields import _resample

    planes = getattr(sim, "field_plane_dumps", None)
    if not planes or sim.sim_path is None:
        return None
    port = getattr(sim, "field_plane_port", None)
    out = []
    for pl in planes:
        path = os.path.join(sim.sim_path, pl["name"] + ".h5")
        if not os.path.exists(path):
            continue
        axis = pl["axis"]
        u, v = (axis + 1) % 3, (axis + 2) % 3
        with HDF5Dump(path) as h5:
            lines = [np.asarray(l, float) / sim.unit for l in h5.GetMesh()["lines"]]
            gu, gv = sample_grid(lines[u], lines[v], max_samples)
            # `frequencies` in current openEMS, the `Frequencies` property in older builds (the GPU one)
            dumped = np.asarray(h5.frequencies if hasattr(h5, "frequencies") else h5.Frequencies, float)
            for ft in pl["frequencies"]:
                k = int(np.argmin(np.abs(dumped - ft)))
                fields = plane_fields(h5.GetFieldAtFrequency(float(dumped[k])), axis)
                comps = list(AXES) if pl["component"] == "abs" else [pl["component"]]
                mag = (np.sqrt(np.sum(np.abs(fields) ** 2, axis=0)) if pl["component"] == "abs"
                       else np.abs(fields[AXES.index(pl["component"])]))
                scale = incident_power_scale(sim, float(dumped[k]))
                if scale is not None:
                    mag = mag * scale
                grid = _resample(lines[u], lines[v], mag, gu, gv)        # (nv, nu)
                grid = np.where(np.isfinite(grid), np.maximum(grid, 0.0), 0.0)
                pay = None
                if phasor:
                    turn = incident_phasor_scale(sim, float(dumped[k]))
                    grids = []
                    for c in comps:
                        z = fields[AXES.index(c)] * (turn if turn is not None else 1.0)
                        g = _resample(lines[u], lines[v], z.real, gu, gv) + 1j * _resample(lines[u], lines[v], z.imag, gu, gv)
                        grids.append(np.where(np.isfinite(g), g, 0.0))
                    pay = phasor_payload(grids, comps)
                out.append(entry(pl, float(dumped[k]), gu, gv, grid, port, normalized=scale is not None, phasor=pay))
    return out or None


def entry(pl: dict, f: float, gu, gv, grid: np.ndarray, port: int | None, normalized: bool, phasor: dict | None = None) -> dict:
    """One ``field_planes`` entry: a (nv, nu) magnitude map on a regular grid, with its ``phasor``."""
    axis = pl["axis"]
    peak = float(grid.max()) if grid.size else 0.0
    return {
        "quantity": pl["quantity"], "component": pl["component"], "normal": AXES[axis],
        "axis": axis, "u_axis": (axis + 1) % 3, "v_axis": (axis + 2) % 3,
        "position_mm": round(pl["position"], 6), "requested_mm": round(pl["requested"], 6),
        "f": f, "u_range": [round(float(gu[0]), 6), round(float(gu[-1]), 6)],
        "v_range": [round(float(gv[0]), 6), round(float(gv[-1]), 6)], "nu": int(len(gu)), "nv": int(len(gv)),
        "unit": UNITS[pl["quantity"]] if normalized else "arb.",
        "normalization": "1 W incident power at the driven port (peak phasor)" if normalized else "none",
        "max": float(f"{peak:.4g}"), "magnitude": _round3(grid),
        **({"port": int(port)} if port is not None else {}),
        **({"phasor": phasor} if phasor else {}),
    }
