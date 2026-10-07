"""50 ohm microstrip through-line with lumped ports at both ends (a two-port reference).

The simplest multi-port structure: S21 should be ~0 dB minus conductor-free dielectric loss, S11 low
wherever the line impedance matches the 50 ohm ports. The line impedance and effective permittivity
are extracted from the simulated S-matrix (``fairbeam.analytic.line_from_s2p``) and compared with
the quasi-static Hammerstad formulas in ``fairbeam.analytic`` (docs/VALIDATION.md, section 7).

Ports: vertical lumped ports (ground to strip) across the strip at the two board edges. The strip,
ground and substrate end at the port planes. The domain is closed with MUR boundaries a few
substrate heights away; the line does not radiate much, so no lambda/4 margin is needed.
"""

import numpy as np
from openEMS.physical_constants import C0

from fairbeam import Param, Simulation
from fairbeam.analytic import microstrip_width
from fairbeam.mesh import merge_lines

MODEL = {
    "id": "microstrip-line",
    "name": "Microstrip line (50 ohm, two-port)",
    "description": "Straight microstrip line on a RO4003C-like substrate with 50 ohm lumped ports at both ends.",
    "reference": "E. Hammerstad, O. Jensen, 'Accurate models for microstrip computer-aided design', IEEE MTT-S 1980",
}

PARAMS = [
    Param("length", 40.0, "Line length", "mm", minimum=2, maximum=500),
    Param("width", 0.0, "Strip width", "mm", "0 = 50 Ω width from the Hammerstad formula", minimum=0, maximum=50),
    Param("sub_h", 0.813, "Substrate thickness", "mm", minimum=0.05, maximum=10),
    Param("eps_r", 3.38, "Substrate permittivity", "", minimum=1, maximum=20),
    Param("tan_d", 0.0027, "Loss tangent", "", minimum=0, maximum=0.2),
    Param("board_w", 20.0, "Board width", "mm", minimum=2, maximum=500),
    Param("strip_cells", 8, "Cells across the strip", "", minimum=1, maximum=16),
    Param("sub_cells", 8, "Cells across the substrate", "", minimum=1, maximum=16),
    Param("mesh_div", 20, "Mesh: cells per λ at f max", "", minimum=8, maximum=80),
    Param("f_min", 0.5, "Band start", "GHz", minimum=0.01),
    Param("f_max", 6.0, "Band stop", "GHz", minimum=0.02),
]


def build(p: dict) -> Simulation:
    f_min, f_max = p["f_min"] * 1e9, p["f_max"] * 1e9
    if f_max <= f_min:
        raise ValueError("f_max must be above f_min")
    h, er, L, B = p["sub_h"], p["eps_r"], p["length"], p["board_w"]
    w = p["width"] or round(microstrip_width(50.0, er, h), 3)
    if w >= B:
        raise ValueError("strip wider than the board")
    sim = Simulation(f_min, f_max, boundaries=["MUR"] * 6, max_timesteps=100000)
    res = C0 / f_max / 1e-3 / p["mesh_div"]
    res_sub = res / np.sqrt(er)

    sub = sim.dielectric("substrate", er, tan_d=p["tan_d"], label="Substrate")
    sub.AddBox(priority=0, start=[-L / 2, -B / 2, 0], stop=[L / 2, B / 2, h])
    sim.metal("gnd", label="Ground plane").AddBox(priority=10, start=[-L / 2, -B / 2, 0], stop=[L / 2, B / 2, 0])
    sim.metal("strip", label="Microstrip").AddBox(priority=10, start=[-L / 2, -w / 2, h], stop=[L / 2, w / 2, h])
    sim.lumped_port(1, 50, [-L / 2, -w / 2, 0], [-L / 2, w / 2, h], "z", priority=5)
    sim.lumped_port(2, 50, [L / 2, -w / 2, 0], [L / 2, w / 2, h], "z", priority=5)

    # mesh: uniform across the strip, thirds-rule lines just outside its edges, graded outward
    n = int(p["strip_cells"])
    d = w / n
    ys = [-w / 2 + i * d for i in range(n + 1)] + [-w / 2 - 2 * d / 3, w / 2 + 2 * d / 3]
    xs = merge_lines({-L / 2, L / 2}, np.arange(-L / 2, L / 2 + 1e-9, res_sub), 0.4 * res_sub)
    pad_xy, pad_up, pad_dn = max(10 * h, 8.0), max(15 * h, 12.0), max(5 * h, 4.0)
    sim.mesh.AddLine("x", np.r_[-L / 2 - pad_xy, xs, L / 2 + pad_xy])
    sim.mesh.AddLine("y", np.r_[-B / 2 - pad_xy, -B / 2, ys, B / 2, B / 2 + pad_xy])
    sim.mesh.AddLine("z", np.r_[-pad_dn, np.linspace(0, h, int(p["sub_cells"]) + 1), h + pad_up])
    sim.smooth_mesh(res, 1.3)
    sim.set_focus([-L / 2 - 2, -B / 2 - 2, -1], [L / 2 + 2, B / 2 + 2, h + 3])
    return sim
