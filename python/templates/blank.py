"""Blank model: a metal post on a finite ground plane, fed by a lumped port.

Start here to write your own antenna. Every section below is explained; replace the geometry and
keep the structure (MODEL, PARAMS, build). All lengths are in millimetres, frequencies in Hz inside
build() (the parameters are in GHz for convenience).
"""

from fairbeam import Param, Simulation

# --- 1. Identity -------------------------------------------------------------------------------
# Shown in the viewer and written into every project bundle. "id" is a short slug; the app sets
# "id" and "name" when it creates a model from this template.
MODEL = {
    "id": "blank",
    "name": "Blank model",
    "description": "A metal post on a finite ground plane with a lumped feed. Replace it with your antenna.",
}

# --- 2. Parameters -----------------------------------------------------------------------------
# Param(key, default, label, unit, description, minimum, maximum). The type of the default sets the
# type of the value (float here; use 3 instead of 3.0 for a whole number). The Run panel builds its
# form from this list and checks minimum/maximum before anything runs.
PARAMS = [
    Param("post_h", 25.0, "Post height", "mm", "Height of the metal post above the ground", minimum=1),
    Param("post_w", 2.0, "Post width", "mm", minimum=0.2),
    Param("gap", 1.0, "Feed gap", "mm", "Gap between ground and post, bridged by the port", minimum=0.2),
    Param("ground", 60.0, "Ground plane size", "mm", minimum=5),
    Param("f_min", 1.0, "Band start", "GHz", minimum=0.1),
    Param("f_max", 4.0, "Band stop", "GHz", minimum=0.2),
]


def build(p: dict) -> Simulation:
    # --- 3. Solver ---------------------------------------------------------------------------------
    # Frequencies in Hz. Six MUR (absorbing) boundaries by default; the excitation is a DC-free pulse
    # covering f_min..f_max. max_timesteps caps runs that never reach the energy end criterion.
    sim = Simulation(p["f_min"] * 1e9, p["f_max"] * 1e9, max_timesteps=30000)

    h, w, g, gnd = p["post_h"], p["post_w"], p["gap"], p["ground"]

    # --- 4. Geometry -------------------------------------------------------------------------------
    # sim.metal() returns a CSXCAD property; add primitives to it. A box with zero thickness in one
    # axis is a sheet (the ground plane here). Higher priority wins where primitives overlap.
    ground = sim.metal("ground", label="Ground plane")
    ground.AddBox(priority=10, start=[-gnd / 2, -gnd / 2, 0], stop=[gnd / 2, gnd / 2, 0])

    post = sim.metal("post", label="Post")
    post.AddBox(priority=10, start=[-w / 2, -w / 2, g], stop=[w / 2, w / 2, g + h])

    # --- 5. Port -----------------------------------------------------------------------------------
    # A 50 ohm lumped port from the ground (z = 0) to the bottom of the post (z = gap), oriented in z.
    # It excites the structure and gives S11 and the input impedance.
    sim.lumped_port(1, 50, [-w / 2, -w / 2, 0], [w / 2, w / 2, g], "z")

    # --- 6. Mesh -----------------------------------------------------------------------------------
    # auto_mesh() builds the whole FDTD mesh from the geometry above (docs/MESHING.md): lines at
    # the metal edges (thirds rule), at the port and sheet planes, lambda/20 at f_max in air (finer
    # in dielectrics), graded cells, and lambda/4 at f_min of air to the absorbing boundaries.
    # Call it after the geometry and ports and before add_nf2ff_box(). Options, e.g.
    # sim.auto_mesh(cells_per_wavelength=30) for a finer mesh; the report is in the bundle.
    sim.auto_mesh()

    # --- 7. Viewer framing and far field ------------------------------------------------------------
    # set_focus() is the region the 3D view frames by default. The NF2FF box records the fields for
    # the radiation pattern; its centre is the phase centre of the pattern.
    sim.set_focus([-gnd / 2, -gnd / 2, -2], [gnd / 2, gnd / 2, g + h + 4])
    sim.add_nf2ff_box(center=[0, 0, g])
    return sim
