"""Minkowski-island fractal patch, probe-fed, on a RO4003C-like substrate.

Every side of a square patch is replaced by the Minkowski generator: the middle third of each segment
is pushed inward by ``depth`` times a third of the segment length, and this repeats for
``iterations``. The longer current path lowers the TM10 resonance of a patch of the same outer size.
That is the miniaturisation effect described by Gianvittorio and Rahmat-Samii. All edges are
axis-aligned, so the staircase FDTD mesh represents the geometry exactly (no slanted-edge error),
which makes this a clean model for comparison with CST.

Mesh lines sit on every metal edge. There is no thirds rule, because the indentations are too close
together for it. Such edges read electrically slightly large, so check with
``fairbeam converge ... --param cell=1.25,0.9,0.6``.
"""

import numpy as np
from openEMS.physical_constants import C0

from fairbeam import Param, Simulation
from fairbeam.mesh import merge_lines

MODEL = {
    "id": "minkowski-patch",
    "name": "Minkowski fractal patch",
    "description": "Probe-fed Minkowski-island patch (square generator, axis-aligned) on a 1.524 mm RO4003C-like substrate.",
    "reference": "J. P. Gianvittorio, Y. Rahmat-Samii, IEEE Antennas Propag. Mag. 44(1), 2002",
}

PARAMS = [
    Param("iterations", 1, "Fractal iterations", "",
          "0 = plain square patch; 3 would need sub-0.3 mm cells (very slow), hence the limit", minimum=0, maximum=2),
    Param("size", 30.0, "Outer patch size", "mm", minimum=5, maximum=200),
    Param("depth", 0.5, "Indentation depth ratio", "", "Indentation / (segment / 3)", minimum=0.05, maximum=0.9),
    Param("feed_x", -3.5, "Probe position (x)", "mm", "-3.5 mm matches iteration 1 to 50 ohm (S11 about -30 dB)"),
    Param("sub_size", 60.0, "Substrate / ground size", "mm", minimum=10, maximum=400),
    Param("sub_h", 1.524, "Substrate thickness", "mm", minimum=0.1, maximum=10),
    Param("eps_r", 3.38, "Substrate permittivity", "", minimum=1, maximum=20),
    Param("tan_d", 0.0027, "Loss tangent", "", minimum=0, maximum=0.2),
    Param("cell", 1.25, "Mesh cell on the patch", "mm", minimum=0.1, maximum=5),
    Param("mesh_div", 20, "Max cell = lambda(f_max) / mesh_div", "", minimum=8, maximum=60),
    Param("boundary", "MUR", "Absorbing boundary", "",
          "MUR (fast; fine for a patch radiating away from the boundaries) or PML_8 (for CST comparison)"),
    Param("f_min", 1.6, "Band start", "GHz", minimum=0.1),
    Param("f_max", 3.2, "Band stop", "GHz", minimum=0.2),
]


def minkowski(size: float, iterations: int, depth: float) -> np.ndarray:
    """Counter-clockwise outline (N, 2) of a Minkowski island centred on the origin."""
    a = size / 2
    pts = [np.array(v, float) for v in ((-a, -a), (a, -a), (a, a), (-a, a))]
    for _ in range(iterations):
        out = []
        for i, p in enumerate(pts):
            q = pts[(i + 1) % len(pts)]
            seg = q - p
            s = np.linalg.norm(seg)
            u = seg / s
            n = np.array([-u[1], u[0]])  # inward for a counter-clockwise outline
            d = depth * s / 3
            out += [p, p + u * s / 3, p + u * s / 3 + n * d, p + u * 2 * s / 3 + n * d, p + u * 2 * s / 3]
        pts = out
    return np.round(np.array(pts), 9)


def build(p: dict) -> Simulation:
    f_min, f_max = p["f_min"] * 1e9, p["f_max"] * 1e9
    if f_max <= f_min:
        raise ValueError("f_max must be above f_min")
    h, er, S = p["sub_h"], p["eps_r"], p["sub_size"]
    outline = minkowski(p["size"], p["iterations"], p["depth"])
    if S <= p["size"]:
        raise ValueError("sub_size must exceed the patch size")
    if p["boundary"] not in ("MUR", "PML_8"):
        raise ValueError("boundary must be MUR or PML_8")
    sim = Simulation(f_min, f_max, boundaries=[p["boundary"]] * 6, end_criteria_db=-60, max_timesteps=60000)
    res_air = C0 / f_max / 1e-3 / p["mesh_div"]
    res_sub = res_air / np.sqrt(er)
    cell = min(p["cell"], res_sub)

    sub = sim.dielectric("substrate", er, tan_d=p["tan_d"], label="Substrate")
    sub.AddBox(priority=0, start=[-S / 2, -S / 2, 0], stop=[S / 2, S / 2, h])
    gnd = sim.metal("gnd", label="Ground plane")
    gnd.AddBox(priority=10, start=[-S / 2, -S / 2, 0], stop=[S / 2, S / 2, 0])
    patch = sim.metal("patch", label="Minkowski patch")
    patch.AddPolygon(outline.T, "z", h, priority=10)  # normal z: points are (x, y)

    fx = p["feed_x"]
    sim.lumped_port(1, 50, [fx, 0, 0], [fx, 0, h], "z", priority=5)

    pad = max(C0 / f_min / 1e-3 / 4, 30.0) + (8 * res_air if p["boundary"] == "PML_8" else 0)
    a = p["size"] / 2 + 2
    # fine uniform lines over the patch, substrate-resolution lines over the rest of the board
    fine = np.arange(-a, a + 1e-9, cell)
    coarse = np.arange(-S / 2, S / 2 + 1e-9, res_sub)
    uniform = np.r_[fine, coarse[np.abs(coarse) > a + 0.5 * res_sub]]
    xs = merge_lines(set(outline[:, 0]) | {fx, -S / 2, S / 2, 0.0}, uniform, 0.45 * cell)
    ys = merge_lines(set(outline[:, 1]) | {-S / 2, S / 2, 0.0}, uniform, 0.45 * cell)
    sim.mesh.AddLine("x", np.r_[-S / 2 - pad, xs, S / 2 + pad])
    sim.mesh.AddLine("y", np.r_[-S / 2 - pad, ys, S / 2 + pad])
    sim.mesh.AddLine("z", np.r_[-pad, np.linspace(0, h, 4), h + pad])
    sim.smooth_mesh(res_air, 1.4)

    sim.set_focus([-S / 2 - 3, -S / 2 - 3, -3], [S / 2 + 3, S / 2 + 3, h + 5])
    sim.add_nf2ff_box(center=[0, 0, h])
    return sim
