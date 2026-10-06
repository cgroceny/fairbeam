"""Probe-fed rectangular microstrip patch on a finite substrate and ground plane.

Three parts: a ground plane (PEC sheet at z = 0), a dielectric substrate box, and the patch (PEC
sheet on top of the substrate). A lumped port from ground to patch stands in for the coaxial probe.
The patch length along x sets the resonance (~ c / (2 L sqrt(eps_eff))); moving the feed along x
changes the input resistance.
"""

from fairbeam import Param, Simulation

MODEL = {
    "id": "patch",
    "name": "Probe-fed patch",
    "description": "Rectangular microstrip patch with a probe (lumped) feed on a finite substrate.",
}

PARAMS = [
    Param("patch_l", 32.0, "Patch length (resonant, x)", "mm", minimum=1),
    Param("patch_w", 40.0, "Patch width (y)", "mm", minimum=1),
    Param("sub_size", 60.0, "Substrate / ground size", "mm", minimum=2),
    Param("sub_h", 1.524, "Substrate thickness", "mm", minimum=0.05),
    Param("eps_r", 3.38, "Relative permittivity", "", minimum=1),
    Param("tan_d", 0.001, "Loss tangent", "", minimum=0),
    Param("feed_x", -6.0, "Feed position (x)", "mm", "From the patch centre along its length"),
    Param("f_min", 1.0, "Band start", "GHz", minimum=0.05),
    Param("f_max", 3.0, "Band stop", "GHz", minimum=0.1),
]


def build(p: dict) -> Simulation:
    f_min, f_max = p["f_min"] * 1e9, p["f_max"] * 1e9
    sim = Simulation(f_min, f_max, max_timesteps=30000)
    L, W, s, h = p["patch_l"], p["patch_w"], p["sub_size"], p["sub_h"]

    # Substrate: loss tangent is exact at the band centre (openEMS uses a constant conductivity).
    sub = sim.dielectric("substrate", p["eps_r"], tan_d=p["tan_d"], label="Substrate")
    sub.AddBox(priority=0, start=[-s / 2, -s / 2, 0], stop=[s / 2, s / 2, h])

    ground = sim.metal("ground", label="Ground plane")
    ground.AddBox(priority=10, start=[-s / 2, -s / 2, 0], stop=[s / 2, s / 2, 0])

    patch = sim.metal("patch", label="Patch")
    patch.AddBox(priority=10, start=[-L / 2, -W / 2, h], stop=[L / 2, W / 2, h])

    # Probe feed: ground to patch, at (feed_x, 0).
    x = p["feed_x"]
    sim.lumped_port(1, 50, [x, 0, 0], [x, 0, h], "z", priority=5)

    # Mesh: generated from the geometry (docs/MESHING.md): thirds rule at the patch edges, 4 cells
    # across the substrate, lambda/(20 sqrt(eps_r)) inside it and lambda/20 in air.
    sim.auto_mesh(cells_per_wavelength=20, dielectric_cells=4)

    sim.set_focus([-s / 2 - 5, -s / 2 - 5, -3], [s / 2 + 5, s / 2 + 5, h + 5])
    sim.add_nf2ff_box(center=[0, 0, h])
    return sim
