"""Half-wave strip dipole with a centre lumped feed.

A thin metal strip in the y = 0 plane, split by a feed gap. The total length is about half a
wavelength at resonance, slightly less because of the strip width (58 mm resonates near 2.25 GHz).
"""

from fairbeam import Param, Simulation

MODEL = {
    "id": "dipole-template",
    "name": "Strip dipole",
    "description": "Thin-strip half-wave dipole with a centre lumped feed.",
}

PARAMS = [
    Param("length", 58.0, "Total length", "mm", "Tip to tip, including the feed gap", minimum=5),
    Param("width", 1.0, "Strip width", "mm", minimum=0.1),
    Param("gap", 1.0, "Feed gap", "mm", minimum=0.2),
    Param("z_feed", 73.0, "Port resistance", "ohm", "Reference impedance of the port", minimum=1),
    Param("f_min", 1.5, "Band start", "GHz", minimum=0.1),
    Param("f_max", 3.5, "Band stop", "GHz", minimum=0.2),
]


def build(p: dict) -> Simulation:
    sim = Simulation(p["f_min"] * 1e9, p["f_max"] * 1e9)   # MUR boundaries, DC-free pulse
    L, w, g = p["length"], p["width"], p["gap"]

    # Two zero-thickness arms (y = 0 sheets) above and below the gap.
    arm = sim.metal("dipole", label="Dipole arms")
    arm.AddBox(priority=10, start=[-w / 2, 0, g / 2], stop=[w / 2, 0, L / 2])
    arm.AddBox(priority=10, start=[-w / 2, 0, -L / 2], stop=[w / 2, 0, -g / 2])

    # The port spans the gap in z. A half-wave dipole is ~73 ohm at resonance.
    sim.lumped_port(1, p["z_feed"], [-w / 2, 0, -g / 2], [w / 2, 0, g / 2], "z")

    # Mesh: generated from the geometry (docs/MESHING.md): thirds rule at the arm ends, six cells
    # across the narrow strip and the same fine cells normal to it, graded to lambda/20 in air.
    sim.auto_mesh()

    sim.set_focus([-10, -10, -L / 2 - 5], [10, 10, L / 2 + 5])
    sim.add_nf2ff_box(center=[0, 0, 0])
    return sim
