"""Microstrip line on a substrate, with lumped ports at both ends (future multi-port example).

A 50 ohm-ish strip (about 3.4 mm wide on 1.524 mm, eps_r 3.38) over a ground plane. Port 1 drives
the line; port 2 at the far end is a matched 50 ohm termination that is NOT excited.

Multi-port status: fairbeam evaluates S11 and the input impedance at the excited port. Port 2
terminates the line, so S11 shows how well the line and the lumped transitions are matched, but
S21 is not computed yet: the bundle's entry for port 2 is the reflection seen at that port, not a
transmission. This template is kept two-port-ready for when multi-port evaluation lands.

There is no NF2FF box: a line is not meant to radiate, so no far field is computed.
"""

from fairbeam import Param, Simulation

MODEL = {
    "id": "microstrip",
    "name": "Microstrip line",
    "description": "Two-port-ready microstrip line with lumped ports at both ends (port 2 terminated, not excited).",
}

PARAMS = [
    Param("line_l", 40.0, "Line length", "mm", minimum=2),
    Param("line_w", 3.4, "Line width", "mm", "About 50 ohm for the default substrate", minimum=0.1),
    Param("sub_w", 20.0, "Substrate width", "mm", minimum=1),
    Param("sub_h", 1.524, "Substrate thickness", "mm", minimum=0.05),
    Param("eps_r", 3.38, "Relative permittivity", "", minimum=1),
    Param("f_min", 0.5, "Band start", "GHz", minimum=0.05),
    Param("f_max", 6.0, "Band stop", "GHz", minimum=0.1),
]


def build(p: dict) -> Simulation:
    f_max = p["f_max"] * 1e9
    sim = Simulation(p["f_min"] * 1e9, f_max, max_timesteps=30000)
    L, w, sw, h = p["line_l"], p["line_w"], p["sub_w"], p["sub_h"]

    sub = sim.dielectric("substrate", p["eps_r"], label="Substrate")
    sub.AddBox(priority=0, start=[-L / 2, -sw / 2, 0], stop=[L / 2, sw / 2, h])

    ground = sim.metal("ground", label="Ground plane")
    ground.AddBox(priority=10, start=[-L / 2, -sw / 2, 0], stop=[L / 2, sw / 2, 0])

    strip = sim.metal("strip", label="Strip")
    strip.AddBox(priority=10, start=[-L / 2, -w / 2, h], stop=[L / 2, w / 2, h])

    # Vertical lumped ports (ground -> strip) at both ends. Port 2 is a passive 50 ohm load.
    sim.lumped_port(1, 50, [-L / 2, -w / 2, 0], [-L / 2, w / 2, h], "z")
    sim.lumped_port(2, 50, [L / 2, -w / 2, 0], [L / 2, w / 2, h], "z", excite=False)

    # Mesh: generated from the geometry (docs/MESHING.md): six cells across the strip, 4 across the
    # substrate, fine cells above the strip. A line radiates little, so 15 mm of air is enough.
    sim.auto_mesh(pad=15)

    sim.set_focus([-L / 2 - 2, -sw / 2 - 2, -1], [L / 2 + 2, sw / 2 + 2, h + 3])
    return sim
