"""Inset-fed rectangular microstrip patch on FR4 with a 50 ohm microstrip feed line.

Classic 2.4 GHz design (Balanis, *Antenna Theory*, 4th ed., sec. 14.2):

- width  W = c / (2 f0) * sqrt(2 / (eps_r + 1))                      -> 38.0 mm
- length L from the transmission-line model (Hammerstad eps_eff, dL)  -> 29.4 mm for 2.40 GHz
- inset depth y0 for 50 ohm: R_in(y0) = R_in(0) cos^2(pi y0 / L); the textbook slot conductances give
  y0 = 10.9 mm, the FR4 curve fit of Ramesh & Yip gives 9.0 mm
- 50 ohm line width on 1.6 mm FR4 (Hammerstad-Jensen): 3.08 mm

``fairbeam.analytic`` implements all of these. The defaults are the textbook values (Ramesh & Yip inset);
openEMS puts the resonance at ~2.39 GHz with S11 about -20 dB (docs/VALIDATION.md, section 2b).

Feed: the microstrip line runs from the board edge (-x) into the notch. A 50 ohm lumped port sits
across the substrate at the line end on the board edge. The
S-parameters therefore include the line: S11 magnitude is reference-plane independent, phase is not.
"""

import numpy as np
from openEMS.physical_constants import C0

from fairbeam import Param, Simulation
from fairbeam.mesh import merge_lines

MODEL = {
    "id": "inset-patch",
    "name": "Inset-fed patch (FR4, 2.4 GHz)",
    "description": "Rectangular patch on 1.6 mm FR4, inset-fed by a 50 ohm microstrip line with a lumped port at the board edge.",
    "reference": "C. A. Balanis, Antenna Theory, 4th ed., sec. 14.2 (transmission-line model, inset feed)",
}

PARAMS = [
    Param("patch_l", 29.4, "Patch length (resonant, x)", "mm", minimum=5, maximum=200),
    Param("patch_w", 38.0, "Patch width (y)", "mm", minimum=5, maximum=200),
    Param("inset", 9.0, "Inset depth", "mm", minimum=0, maximum=100),
    Param("gap", 1.0, "Inset slot width", "mm", "Gap between the feed line and the patch on each side",
          minimum=0.2, maximum=10),
    Param("feed_w", 3.08, "Feed line width", "mm", "3.08 mm is 50 Ω on 1.6 mm FR4", minimum=0.2, maximum=20),
    Param("feed_len", 14.0, "Feed line length outside the patch", "mm", minimum=2, maximum=200),
    Param("margin", 12.0, "Ground/substrate margin around the patch", "mm", minimum=2, maximum=200),
    Param("sub_h", 1.6, "Substrate thickness", "mm", minimum=0.1, maximum=10),
    Param("eps_r", 4.4, "Substrate permittivity", "", minimum=1, maximum=20),
    Param("tan_d", 0.02, "Loss tangent", "", minimum=0, maximum=0.2),
    Param("slot_cells", 1, "Cells across each inset slot", "", minimum=1, maximum=2),
    Param("sub_cells", 3, "Cells across the substrate thickness", "", minimum=1, maximum=12),
    Param("mesh_div", 20, "Mesh: cells per λ at f max", "",
          "λ in air outside the board, λ / sqrt(eps_r) over the board", minimum=8, maximum=60),
    Param("f_min", 2.0, "Band start", "GHz", minimum=0.1),
    Param("f_max", 3.0, "Band stop", "GHz", minimum=0.2),
]


def thirds(edge, metal_side, d):
    """Mesh lines 1/3 inside and 2/3 outside a metal edge (``metal_side`` = +1 if metal is above)."""
    return [edge + metal_side * d / 3, edge - metal_side * 2 * d / 3]


def build(p: dict) -> Simulation:
    f_min, f_max = p["f_min"] * 1e9, p["f_max"] * 1e9
    if f_max <= f_min:
        raise ValueError("f_max must be above f_min")
    L, W, y0, g, wf = p["patch_l"], p["patch_w"], p["inset"], p["gap"], p["feed_w"]
    h, er = p["sub_h"], p["eps_r"]
    if y0 >= L:
        raise ValueError("inset must be shorter than the patch")
    if wf / 2 + g >= W / 2:
        raise ValueError("feed line plus slots wider than the patch")

    sim = Simulation(f_min, f_max, boundaries=["PML_8"] * 6, end_criteria_db=-60, max_timesteps=60000)
    lam0 = C0 / f_max / 1e-3
    res_air = lam0 / p["mesh_div"]
    res_sub = res_air / np.sqrt(er)
    d_edge = min(h, res_sub / 2)  # cell at the radiating edges <= substrate height

    # board: patch centred at the origin, feed from -x
    x_feed = -L / 2 - p["feed_len"]          # board edge on the feed side, where the port sits
    x_lo, x_hi = x_feed, L / 2 + p["margin"]
    y_lo, y_hi = -W / 2 - p["margin"], W / 2 + p["margin"]
    x_in = -L / 2 + y0                       # bottom of the inset notch

    sub = sim.dielectric("substrate", er, tan_d=p["tan_d"], tan_d_freq=2.4e9, label="FR4 substrate")
    sub.AddBox(priority=0, start=[x_lo, y_lo, 0], stop=[x_hi, y_hi, h])
    gnd = sim.metal("gnd", label="Ground plane")
    gnd.AddBox(priority=10, start=[x_lo, y_lo, 0], stop=[x_hi, y_hi, 0])

    patch = sim.metal("patch", label="Patch + feed line")
    s = wf / 2 + g
    patch.AddBox(priority=10, start=[x_in, -W / 2, h], stop=[L / 2, W / 2, h])      # body past the notch
    patch.AddBox(priority=10, start=[-L / 2, s, h], stop=[x_in, W / 2, h])          # beside the notch
    patch.AddBox(priority=10, start=[-L / 2, -W / 2, h], stop=[x_in, -s, h])
    patch.AddBox(priority=10, start=[x_feed, -wf / 2, h], stop=[x_in, wf / 2, h])   # feed line

    sim.lumped_port(1, 50, [x_feed, -wf / 2, 0], [x_feed, wf / 2, h], "z", priority=5)

    # ---- mesh
    pad = max(C0 / f_min / 1e-3 / 4, 30.0) + 8 * res_air   # lambda/4 free space + PML
    fine = p["slot_cells"] > 1  # a mid line in each inset slot (halves the timestep)
    xs_req = ({x_lo, x_hi, x_in} | ({round(x_in - g / 2, 6)} if fine else set()) | set(thirds(-L / 2, +1, d_edge))
              | set(thirds(L / 2, -1, d_edge)))
    ys_req = ({y_lo, y_hi, -wf / 2, 0.0, wf / 2, -s, s, -wf / 4, wf / 4}
              | ({-wf / 2 - g / 2, wf / 2 + g / 2} if fine else set())
              | set(thirds(-W / 2, +1, d_edge)) | set(thirds(W / 2, -1, d_edge)))
    xs = merge_lines(xs_req, np.arange(x_lo, x_hi + 1e-9, res_sub), 0.4 * res_sub)
    ys = merge_lines(ys_req, np.arange(y_lo, y_hi + 1e-9, res_sub), 0.4 * res_sub)
    sim.mesh.AddLine("x", np.r_[x_lo - pad, xs, x_hi + pad])
    sim.mesh.AddLine("y", np.r_[y_lo - pad, ys, y_hi + pad])
    sim.mesh.AddLine("z", np.r_[-pad, np.linspace(0, h, p["sub_cells"] + 1), h + pad])
    sim.smooth_mesh(res_air, 1.4)

    sim.set_focus([x_lo - 3, y_lo - 3, -3], [x_hi + 3, y_hi + 3, h + 5])
    sim.add_nf2ff_box(center=[0, 0, h])
    return sim
