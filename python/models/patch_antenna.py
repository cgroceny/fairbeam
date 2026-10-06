"""Probe-fed rectangular microstrip patch.

Adapted from the openEMS "Simple Patch Antenna" tutorial (T. Liebig): 32 x 40 mm patch on a
60 x 60 mm, 1.524 mm substrate (eps_r 3.38, RO4003C-like), 50 ohm lumped feed offset in x.
"""

import numpy as np
from openEMS.physical_constants import C0

from fairbeam import Param, Simulation

MODEL = {
    "id": "patch-antenna",
    "name": "Rectangular patch antenna",
    "description": "Probe-fed microstrip patch on a finite RO4003C-like substrate and ground plane.",
    "reference": "openEMS tutorial 'Simple Patch Antenna' (T. Liebig)",
}

PARAMS = [
    Param("patch_w", 32.0, "Patch length (resonant, x)", "mm", minimum=1),
    Param("patch_l", 40.0, "Patch width (y)", "mm", minimum=1),
    Param("sub_size", 60.0, "Substrate / ground size", "mm", minimum=1),
    Param("sub_h", 1.524, "Substrate thickness", "mm", minimum=0.05),
    Param("eps_r", 3.38, "Substrate permittivity", "", minimum=1),
    Param("tan_d", 1e-3, "Loss tangent", "", minimum=0),
    Param("feed_x", -6.0, "Feed position (x)", "mm"),
    Param("mesh_div", 30, "Max cell = lambda(f_max) / mesh_div", "",
          "30 is within 0.1 % of the converged resonance (docs/VALIDATION.md); 20 reads ~0.9 % low",
          minimum=8, maximum=80),
    Param("sub_cells", 4, "Mesh cells across the substrate thickness", "", minimum=1, maximum=16),
    Param("mesh", "manual", "Mesh", "",
          "manual: the hand-tuned mesh below; auto: fairbeam.automesh with auto_cpw cells per wavelength"),
    Param("auto_cpw", 20, "Cells per wavelength (auto mesh)", "", minimum=8, maximum=80),
    Param("f_min", 1.0, "Band start", "GHz", minimum=0.01),
    Param("f_max", 3.0, "Band stop", "GHz", minimum=0.02),
]


def build(p: dict) -> Simulation:
    f_min, f_max = p["f_min"] * 1e9, p["f_max"] * 1e9
    # -60 dB: S11 depth and radiation efficiency need the ring-down to decay well below -40 dB
    sim = Simulation(f_min, f_max, boundaries=["MUR"] * 6, max_timesteps=30000, end_criteria_db=-60)
    mesh = sim.mesh
    res = C0 / f_max / 1e-3 / p["mesh_div"]
    if p["mesh"] not in ("manual", "auto"):
        raise ValueError("mesh must be manual or auto")
    auto = p["mesh"] == "auto"

    if not auto:
        box = np.array([200.0, 200.0, 150.0])
        mesh.AddLine("x", [-box[0] / 2, box[0] / 2])
        mesh.AddLine("y", [-box[1] / 2, box[1] / 2])
        mesh.AddLine("z", [-box[2] / 3, box[2] * 2 / 3])

    w, l, s, h = p["patch_w"], p["patch_l"], p["sub_size"], p["sub_h"]

    patch = sim.metal("patch", label="Patch")
    patch.AddBox(priority=10, start=[-w / 2, -l / 2, h], stop=[w / 2, l / 2, h])
    if not auto:
        sim.fdtd.AddEdges2Grid(dirs="xy", properties=patch, metal_edge_res=res / 2)

    sub = sim.dielectric("substrate", p["eps_r"], tan_d=p["tan_d"], tan_d_freq=(f_min + f_max) / 2,
                         label="Substrate")
    sub.AddBox(priority=0, start=[-s / 2, -s / 2, 0], stop=[s / 2, s / 2, h])
    if not auto:
        mesh.AddLine("z", np.linspace(0, h, p["sub_cells"] + 1))

    gnd = sim.metal("gnd", label="Ground plane")
    gnd.AddBox(priority=10, start=[-s / 2, -s / 2, 0], stop=[s / 2, s / 2, 0])
    if not auto:
        sim.fdtd.AddEdges2Grid(dirs="xy", properties=gnd)

    sim.lumped_port(1, 50, [p["feed_x"], 0, 0], [p["feed_x"], 0, h], "z", priority=5,
                    **({} if auto else {"edges2grid": "xy"}))

    if auto:
        sim.auto_mesh(cells_per_wavelength=p["auto_cpw"], dielectric_cells=p["sub_cells"])
    else:
        sim.smooth_mesh(res, 1.4)
    sim.set_focus([-s / 2 - 5, -s / 2 - 5, -3], [s / 2 + 5, s / 2 + 5, h + 5])
    sim.add_nf2ff_box(center=[0, 0, 1])
    return sim
