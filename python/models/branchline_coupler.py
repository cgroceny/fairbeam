"""Branch-line (90 degree hybrid) coupler at 2.4 GHz, four 50 ohm ports.

Layout (microstrip, axis-aligned)::

      port 1 ---A===== 35.4 ohm, lambda/4 =====B--- port 2 (through, -90 deg)
                |                              |
             50 ohm                         50 ohm
            lambda/4                       lambda/4
                |                              |
      port 4 ---D===== 35.4 ohm, lambda/4 =====C--- port 3 (coupled, -180 deg)
      (isolated)

Theory (Pozar, *Microwave Engineering*, 4th ed., sec. 7.5): at f0, S21 = -j/sqrt(2) and
S31 = -1/sqrt(2) (both -3.01 dB, 90 degrees apart), and S11 = S41 = 0. Branch lengths are
quarter waves along the centre lines between the junction centres; the junction squares make the
electrical lengths shorter (the coupler centres 3.8 % high at scale 1.0), and ``scale`` trims them. The mesh comes from
``Simulation.auto_mesh``.
"""

import numpy as np
from openEMS.physical_constants import C0

from fairbeam import Param, Simulation
from fairbeam.analytic import microstrip_eps_eff, microstrip_width

MODEL = {
    "id": "branchline-coupler",
    "name": "Branch-line coupler (2.4 GHz)",
    "description": "90 degree hybrid: 35.4 ohm and 50 ohm quarter-wave branches on a RO4003C-like substrate, four 50 ohm lumped ports.",
    "reference": "D. M. Pozar, Microwave Engineering, 4th ed., sec. 7.5 (quadrature hybrid)",
}

PARAMS = [
    Param("f0", 2.4, "Design frequency", "GHz", minimum=0.1, maximum=40),
    Param("scale", 1.035, "Branch length scale", "",
          "Trims both branch lengths; 1.0 = textbook centre-line quarter waves (centred at 2.49 GHz here, the T-junctions "
          "shorten the electrical length), 1.035 centres the coupler at 2.40 GHz", minimum=0.5, maximum=1.5),
    Param("feed_len", 10.0, "50 Ω feed length", "mm", minimum=2, maximum=100),
    Param("sub_h", 0.813, "Substrate thickness", "mm", minimum=0.05, maximum=10),
    Param("eps_r", 3.38, "Substrate permittivity", "", minimum=1, maximum=20),
    Param("tan_d", 0.0027, "Loss tangent", "", minimum=0, maximum=0.2),
    Param("cpw", 20, "Mesh cells per wavelength", "", minimum=8, maximum=60),
    Param("f_min", 1.0, "Band start", "GHz", minimum=0.01),
    Param("f_max", 4.0, "Band stop", "GHz", minimum=0.02),
]


def build(p: dict) -> Simulation:
    f_min, f_max, f0 = p["f_min"] * 1e9, p["f_max"] * 1e9, p["f0"] * 1e9
    if f_max <= f_min:
        raise ValueError("f_max must be above f_min")
    h, er = p["sub_h"], p["eps_r"]
    w50 = microstrip_width(50.0, er, h)
    w35 = microstrip_width(50.0 / np.sqrt(2), er, h)

    def quarter(w):
        return C0 / f0 / np.sqrt(microstrip_eps_eff(er, h, w)) / 4 / 1e-3 * p["scale"]

    lh, lv = quarter(w35), quarter(w50)           # centre-to-centre branch lengths
    lf = p["feed_len"]
    xa, ya = lh / 2, lv / 2                        # junction centres at (+-xa, +-ya)
    x_edge = xa + w50 / 2 + lf                     # board edge where the ports sit
    y_half = ya + w35 / 2 + 6.0

    sim = Simulation(f_min, f_max, boundaries=["MUR"] * 6, max_timesteps=100000)
    sim.dielectric("substrate", er, tan_d=p["tan_d"], tan_d_freq=f0, label="Substrate").AddBox(
        priority=0, start=[-x_edge, -y_half, 0], stop=[x_edge, y_half, h])
    sim.metal("gnd", label="Ground plane").AddBox(priority=10, start=[-x_edge, -y_half, 0], stop=[x_edge, y_half, 0])
    m = sim.metal("coupler", label="Coupler traces")
    for s in (+1, -1):
        # 35.4 ohm series branches (top and bottom), extended over the junction squares
        m.AddBox(priority=10, start=[-xa - w50 / 2, s * ya - w35 / 2, h], stop=[xa + w50 / 2, s * ya + w35 / 2, h])
        # 50 ohm shunt branches (left and right)
        m.AddBox(priority=10, start=[s * xa - w50 / 2, -ya - w35 / 2, h], stop=[s * xa + w50 / 2, ya + w35 / 2, h])
    for sx in (+1, -1):
        for sy in (+1, -1):   # feed lines from each junction to the board edge
            m.AddBox(priority=10, start=[sx * (xa + w50 / 2), sy * ya - w50 / 2, h],
                     stop=[sx * x_edge, sy * ya + w50 / 2, h])
    corners = {1: (-1, +1), 2: (+1, +1), 3: (+1, -1), 4: (-1, -1)}
    for n, (sx, sy) in corners.items():
        sim.lumped_port(n, 50, [sx * x_edge, sy * ya - w50 / 2, 0], [sx * x_edge, sy * ya + w50 / 2, h], "z",
                        priority=5)
    sim.auto_mesh(cells_per_wavelength=p["cpw"], pad=12.0)
    sim.set_focus([-x_edge - 2, -y_half - 2, -1], [x_edge + 2, y_half + 2, h + 3])
    return sim
