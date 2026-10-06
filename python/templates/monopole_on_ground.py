"""Quarter-wave monopole over an infinite ground plane (PEC half space).

The ground is not a metal sheet here but a PEC boundary at z = 0 (the "z-" face of the domain). By
image theory this is an exact infinite ground plane and halves the simulated volume. fairbeam
reports directivity for the physical half space above the ground.
"""

from fairbeam import Param, Simulation

MODEL = {
    "id": "monopole",
    "name": "Monopole on ground",
    "description": "Quarter-wave wire monopole over an infinite PEC ground (half-space boundary).",
}

PARAMS = [
    Param("height", 25.0, "Monopole height", "mm", "About a quarter wavelength at resonance", minimum=2),
    Param("width", 1.0, "Wire width", "mm", "Square cross-section", minimum=0.1),
    Param("gap", 1.0, "Feed gap", "mm", "Between the ground and the wire", minimum=0.2),
    Param("f_min", 1.0, "Band start", "GHz", minimum=0.1),
    Param("f_max", 5.0, "Band stop", "GHz", minimum=0.2),
]


def build(p: dict) -> Simulation:
    # Boundary order: x-, x+, y-, y+, z-, z+. PEC on z- is the ground plane.
    sim = Simulation(p["f_min"] * 1e9, p["f_max"] * 1e9,
                     boundaries=["MUR", "MUR", "MUR", "MUR", "PEC", "MUR"], max_timesteps=30000)
    h, w, g = p["height"], p["width"], p["gap"]

    wire = sim.metal("monopole", label="Monopole")
    wire.AddBox(priority=10, start=[-w / 2, -w / 2, g], stop=[w / 2, w / 2, g + h])

    # 50 ohm feed from the ground (z = 0) to the wire.
    sim.lumped_port(1, 50, [-w / 2, -w / 2, 0], [w / 2, w / 2, g], "z")

    # Mesh: generated from the geometry (docs/MESHING.md). The domain starts at z = 0 because z- is
    # a PEC boundary; lambda/4 at f_min of air is added toward the absorbing boundaries.
    sim.auto_mesh()

    sim.set_focus([-15, -15, 0], [15, 15, g + h + 4])
    sim.add_nf2ff_box(center=[0, 0, 0])
    return sim
