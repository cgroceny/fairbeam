"""Equal-split Wilkinson power divider at 2.4 GHz (three 50 ohm ports, 100 ohm isolation resistor).

Layout (microstrip, all edges axis-aligned so the staircase mesh is exact)::

                   yA  +--------- arm 2 (70.7 ohm) ----------+            +---- port 2
                       |                                     |            |
    port 1 ---- 50 ohm +  (T-junction)                       R 100 ohm ---+  (outputs jog outward)
                       |                                     |            |
                  -yA  +--------- arm 3 (70.7 ohm) ----------+            +---- port 3

Each 70.7 ohm arm is a quarter wave at ``f0`` (centreline length, bends included). Its end comes
back toward the centre line so that the resistor bridges a small gap. The output lines leave the
arm ends with a short straight section, jog outward and run to the board edge. Lumped ports sit
across the substrate at the three board edges.

Theory (ideal, lossless): S21 = S31 = -3.01 dB, S11 = S22 = S33 = S23 = 0 (-inf dB) at f0.
The bends, the T-junction and the resistor pads shift the centre frequency by a few percent;
``arm_scale`` trims the arm length.
"""

import numpy as np
from openEMS.physical_constants import C0

from fairbeam import Param, Simulation
from fairbeam.analytic import microstrip_eps_eff, microstrip_width
from fairbeam.mesh import merge_lines

MODEL = {
    "id": "wilkinson-divider",
    "name": "Wilkinson divider (2.4 GHz)",
    "description": "Equal-split microstrip Wilkinson divider on a RO4003C-like substrate: two 70.7 ohm quarter-wave arms, "
                   "100 ohm isolation resistor, three 50 ohm lumped ports.",
    "reference": "E. J. Wilkinson, IRE Trans. MTT 8(1), 1960; D. M. Pozar, Microwave Engineering, 4th ed., sec. 7.3",
}

PARAMS = [
    Param("f0", 2.4, "Design frequency", "GHz", minimum=0.1, maximum=40),
    Param("sub_h", 0.813, "Substrate thickness", "mm", minimum=0.05, maximum=10),
    Param("eps_r", 3.38, "Substrate permittivity", "", minimum=1, maximum=20),
    Param("tan_d", 0.0027, "Loss tangent", "", minimum=0, maximum=0.2),
    Param("r_iso", 100.0, "Isolation resistor", "ohm", minimum=1, maximum=10000),
    Param("gap", 0.0, "Resistor gap", "mm",
          "Gap between the arm ends that the resistor bridges; 0 = the 50 ohm strip width (1.9 mm, about an 0805 part), "
          "which also keeps the mesh free of slivers", minimum=0, maximum=10),
    Param("offset", 5.0, "Arm offset from the centre line", "mm", minimum=1, maximum=50),
    Param("clearance", 3.0, "Output jog clearance", "mm",
          "Gap between an arm's return leg and its output jog", minimum=0.2, maximum=20),
    Param("arm_scale", 1.0, "Arm length scale", "", "Trims the quarter-wave arm length", minimum=0.5, maximum=1.5),
    Param("feed_len", 10.0, "50 ohm line length at each port", "mm", minimum=2, maximum=100),
    Param("strip_cells", 6, "Cells across a 50 ohm strip", "", minimum=1, maximum=12),
    Param("sub_cells", 6, "Cells across the substrate", "", minimum=1, maximum=12),
    Param("mesh_div", 20, "Max cell = lambda(f_max) / mesh_div", "", minimum=8, maximum=60),
    Param("f_min", 1.0, "Band start", "GHz", minimum=0.01),
    Param("f_max", 4.0, "Band stop", "GHz", minimum=0.02),
]


def _thin(lines, tol):
    """Sorted unique lines with neighbours closer than ``tol`` merged (keeps the first)."""
    out = []
    for v in np.sort(np.asarray(lines, float)):
        if not out or v - out[-1] > tol:
            out.append(v)
    return np.array(out)


def box(metal, x0, x1, y0, y1, z):
    metal.AddBox(priority=10, start=[min(x0, x1), min(y0, y1), z], stop=[max(x0, x1), max(y0, y1), z])


def build(p: dict) -> Simulation:
    f_min, f_max, f0 = p["f_min"] * 1e9, p["f_max"] * 1e9, p["f0"] * 1e9
    if f_max <= f_min:
        raise ValueError("f_max must be above f_min")
    h, er = p["sub_h"], p["eps_r"]
    w5 = round(microstrip_width(50.0, er, h), 3)
    w7 = round(microstrip_width(50.0 * np.sqrt(2), er, h), 3)
    lam_g = C0 / f0 / np.sqrt(microstrip_eps_eff(er, h, w7)) / 1e-3
    arm = lam_g / 4 * p["arm_scale"]
    g, yA, Lf = p["gap"] or w5, p["offset"], p["feed_len"]
    yr = g / 2 + w7 / 2                      # centreline y of the arm ends at the resistor
    # electrical arm length: from the edge of the input line (y = w5/2) to where the output stub
    # takes over (y = g/2 + w5), along the centreline
    La = arm - (yA - w5 / 2) - (yA - (g / 2 + w5))
    if La <= 2 * w7:
        raise ValueError("offset too large for the arm length; reduce offset")
    # the two output stubs run side by side (gap g) only until the outward jog: keep that short, since
    # coupling between them limits the isolation; clear the arm's return leg by max(1 mm, h)
    t = w7 / 2 + p["clearance"] + w5 / 2
    yO = yA + 2.0                            # output line centreline
    x_end = La + t + Lf                      # right board edge (ports 2, 3)
    x_in = -Lf                               # left board edge (port 1)
    margin = 6.0
    y_hi = yO + w5 / 2 + margin

    sim = Simulation(f_min, f_max, boundaries=["MUR"] * 6, max_timesteps=100000)
    sub = sim.dielectric("substrate", er, tan_d=p["tan_d"], tan_d_freq=f0, label="Substrate")
    sub.AddBox(priority=0, start=[x_in, -y_hi, 0], stop=[x_end, y_hi, h])
    box(sim.metal("gnd", label="Ground plane"), x_in, x_end, -y_hi, y_hi, 0)

    m = sim.metal("strips", label="Divider traces")
    z = h
    box(m, x_in, w7 / 2, -w5 / 2, w5 / 2, z)                          # port 1 line into the junction
    for s in (+1, -1):
        box(m, -w7 / 2, w7 / 2, 0, s * (yA + w7 / 2), z)             # arm: up/down from the junction
        box(m, -w7 / 2, La + w7 / 2, s * (yA - w7 / 2), s * (yA + w7 / 2), z)   # arm: along x
        box(m, La - w7 / 2, La + w7 / 2, s * (yA + w7 / 2), s * (g / 2), z)     # arm: back to the gap
        box(m, La - w7 / 2, La + t + w5 / 2, s * (g / 2), s * (g / 2 + w5), z)  # output stub
        box(m, La + t - w5 / 2, La + t + w5 / 2, s * (g / 2), s * (yO + w5 / 2), z)  # jog outward
        box(m, La + t - w5 / 2, x_end, s * (yO - w5 / 2), s * (yO + w5 / 2), z)  # output line to the edge

    sim.lumped_resistor("r_iso", p["r_iso"], [La - w7 / 2, -g / 2, z], [La + w7 / 2, g / 2, z], "y",
                        label=f"Isolation resistor {p['r_iso']:g} ohm")
    sim.lumped_port(1, 50, [x_in, -w5 / 2, 0], [x_in, w5 / 2, h], "z", priority=5)
    sim.lumped_port(2, 50, [x_end, yO - w5 / 2, 0], [x_end, yO + w5 / 2, h], "z", priority=5)
    sim.lumped_port(3, 50, [x_end, -yO - w5 / 2, 0], [x_end, -yO + w5 / 2, h], "z", priority=5)

    # ---- mesh: lines on every strip edge, a uniform fill at the strip resolution, graded outward
    res = C0 / f_max / 1e-3 / p["mesh_div"]
    fine = min(w5 / p["strip_cells"], w7 / 2, g / 2)  # smallest intended cell
    xs_req = {x_in, x_end, -w7 / 2, w7 / 2, La - w7 / 2, La + w7 / 2, La + t - w5 / 2, La + t + w5 / 2}
    ys_req = {-y_hi, y_hi, 0.0}
    for s in (+1, -1):
        ys_req |= {s * w5 / 2, s * (yA - w7 / 2), s * (yA + w7 / 2), s * g / 2, s * (g / 2 + w5),
                   s * (yO - w5 / 2), s * (yO + w5 / 2)}
    n = int(p["strip_cells"])

    def across(c, w):  # lines across a strip of width w centred at c (at least 2 cells for 70.7 ohm)
        k = max(2, int(np.ceil(n * w / w5)))
        return set(np.round(c - w / 2 + np.arange(k + 1) * w / k, 6))
    # optional lines: dropped where they would come closer than 0.45 cells to a strip edge
    x_opt = across(0.0, w7) | across(La, w7) | across(La + t, w5)
    y_opt = {v for v in across(0.0, w5) | across(yA, w7) | across(g / 2 + w5 / 2, w5) | across(yO, w5) if v >= 0}
    step = max(fine, res / np.sqrt(er) / 2)
    xs = merge_lines(xs_req, _thin(np.r_[np.arange(x_in, x_end + 1e-9, step), sorted(x_opt)], 0.45 * fine), 0.45 * fine)
    # build the upper half and mirror it, so ports 2 and 3 see identical meshes
    y_up = merge_lines({v for v in ys_req if v >= 0},
                       _thin(np.r_[np.arange(0, y_hi + 1e-9, step), sorted(y_opt)], 0.45 * fine), 0.45 * fine)
    ys = np.unique(np.r_[-y_up, y_up])
    pad_xy, pad_up, pad_dn = 8.0, 12.0, 4.0
    sim.mesh.AddLine("x", np.r_[x_in - pad_xy, xs, x_end + pad_xy])
    sim.mesh.AddLine("y", np.r_[-y_hi - pad_xy, ys, y_hi + pad_xy])
    sim.mesh.AddLine("z", np.r_[-pad_dn, np.linspace(0, h, int(p["sub_cells"]) + 1), h + pad_up])
    sim.smooth_mesh(res, 1.3)
    sim.set_focus([x_in - 2, -y_hi - 2, -1], [x_end + 2, y_hi + 2, h + 3])
    return sim
