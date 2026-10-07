"""Two probe-fed patches on one substrate (2 x 1 array along y, H-plane), one port each.

The foundation model for phased arrays (docs/ARRAYS.md). ``fairbeam run`` drives each port in
turn with the other terminated in 50 ohm, which gives:

- the 2 x 2 S-matrix (S21 = mutual coupling between the elements), and
- the complex embedded element pattern of each port (``results.element_patterns``).

Any excitation (broadside, steered, tapered) can then be evaluated afterwards with
``fairbeam.array.combine`` without running openEMS again.

Each element is the patch of ``patch_antenna.py``: 32 x 40 mm on a 1.524 mm, eps_r 3.38 substrate,
fed at x = -6 mm. The default spacing is lambda0 / 2 at 2.45 GHz (61.2 mm, centre to centre).
"""

import numpy as np
from openEMS.physical_constants import C0

from fairbeam import Param, Simulation

MODEL = {
    "id": "patch-array-2x1",
    "name": "Patch array 2 x 1",
    "description": "Two probe-fed rectangular patches on one RO4003C-like substrate, lambda/2 apart in the H-plane, "
                   "one 50 ohm port each.",
    "reference": "R. J. Mailloux, Phased Array Antenna Handbook, 2nd ed., ch. 1 and 6 (embedded element patterns)",
}

PARAMS = [
    Param("spacing", 61.2, "Element spacing (y, centre to centre)", "mm", minimum=41, maximum=400),
    Param("patch_w", 32.0, "Patch length (resonant, x)", "mm", minimum=1),
    Param("patch_l", 40.0, "Patch width (y)", "mm", minimum=1),
    Param("margin", 10.0, "Substrate margin around the patches", "mm", minimum=1),
    Param("sub_h", 1.524, "Substrate thickness", "mm", minimum=0.05),
    Param("eps_r", 3.38, "Substrate permittivity", "", minimum=1),
    Param("tan_d", 1e-3, "Loss tangent", "", minimum=0),
    Param("feed_x", -6.0, "Feed position (x)", "mm"),
    Param("mesh_div", 20, "Mesh: cells per λ at f max", "", minimum=8, maximum=60),
    Param("f_min", 1.8, "Band start", "GHz", minimum=0.01),
    Param("f_max", 3.0, "Band stop", "GHz", minimum=0.02),
]


def build(p: dict) -> Simulation:
    f_min, f_max = p["f_min"] * 1e9, p["f_max"] * 1e9
    if f_max <= f_min:
        raise ValueError("f_max must be above f_min")
    w, l, h, d = p["patch_w"], p["patch_l"], p["sub_h"], p["spacing"]
    if d <= l:
        raise ValueError("spacing must exceed the patch width (y)")
    sim = Simulation(f_min, f_max, boundaries=["MUR"] * 6, max_timesteps=60000)
    mesh = sim.mesh
    res = C0 / f_max / 1e-3 / p["mesh_div"]
    sx, sy = w + 2 * p["margin"] + 14, d + l + 2 * p["margin"]   # substrate / ground
    pad = C0 / f_min / 1e-3 / 4                                  # lambda/4 of free space to the MUR walls
    mesh.AddLine("x", [-sx / 2 - pad, sx / 2 + pad])
    mesh.AddLine("y", [-sy / 2 - pad, sy / 2 + pad])
    mesh.AddLine("z", [-pad / 2, h + pad])

    patch = sim.metal("patches", label="Patches")
    for k, yc in enumerate((-d / 2, d / 2)):
        patch.AddBox(priority=10, start=[-w / 2, yc - l / 2, h], stop=[w / 2, yc + l / 2, h])
    sim.fdtd.AddEdges2Grid(dirs="xy", properties=patch, metal_edge_res=res / 2)

    sub = sim.dielectric("substrate", p["eps_r"], tan_d=p["tan_d"], tan_d_freq=2.45e9, label="Substrate")
    sub.AddBox(priority=0, start=[-sx / 2, -sy / 2, 0], stop=[sx / 2, sy / 2, h])
    mesh.AddLine("z", np.linspace(0, h, 5))
    gnd = sim.metal("gnd", label="Ground plane")
    gnd.AddBox(priority=10, start=[-sx / 2, -sy / 2, 0], stop=[sx / 2, sy / 2, 0])
    sim.fdtd.AddEdges2Grid(dirs="xy", properties=gnd)

    for k, yc in enumerate((-d / 2, d / 2)):
        sim.lumped_port(k + 1, 50, [p["feed_x"], yc, 0], [p["feed_x"], yc, h], "z", priority=5, edges2grid="xy")

    sim.smooth_mesh(res, 1.4)
    sim.set_focus([-sx / 2 - 5, -sy / 2 - 5, -3], [sx / 2 + 5, sy / 2 + 5, h + 5])
    sim.add_nf2ff_box(center=[0, 0, h])
    return sim
