"""Four probe-fed patches on one substrate (4 x 1 linear array along y, H-plane), one port each.

The phased-array reference model (docs/ARRAYS.md). ``fairbeam run`` drives each port in turn with
the others terminated in 50 ohm (4 runs), which gives:

- the 4 x 4 S-matrix (S21, S31, S41: coupling to the first, second and third neighbour), and
- the complex embedded element pattern of each port (``results.element_patterns``).

Any excitation (broadside, steered, tapered) can then be evaluated afterwards with
``fairbeam.array.combine`` without running openEMS again.

Each element is the patch of ``patch_antenna.py``: 32 x 40 mm on a 1.524 mm, eps_r 3.38 substrate,
fed at x = -6 mm. The default spacing is lambda0 / 2 at 2.45 GHz (61.2 mm, centre to centre).
Elements are numbered 1..N along +y. PML boundaries (directivity matters here) and the automatic
mesh (docs/MESHING.md).
"""


from fairbeam import Param, Simulation

MODEL = {
    "id": "patch-array-4x1",
    "name": "Patch array 4 x 1",
    "description": "Four probe-fed rectangular patches on one RO4003C-like substrate, lambda/2 apart in the H-plane, "
                   "one 50 ohm port each (automatic mesh, PML).",
    "reference": "R. J. Mailloux, Phased Array Antenna Handbook, 2nd ed., ch. 1 and 6 (embedded element patterns)",
}

PARAMS = [
    Param("elements", 4, "Number of elements", "", minimum=2, maximum=8),
    Param("spacing", 61.2, "Element spacing (y, centre to centre)", "mm", minimum=41, maximum=400),
    Param("patch_w", 32.0, "Patch length (resonant, x)", "mm", minimum=1),
    Param("patch_l", 40.0, "Patch width (y)", "mm", minimum=1),
    Param("margin", 10.0, "Substrate margin around the patches", "mm", minimum=1),
    Param("sub_h", 1.524, "Substrate thickness", "mm", minimum=0.05),
    Param("eps_r", 3.38, "Substrate permittivity", "", minimum=1),
    Param("tan_d", 1e-3, "Loss tangent", "", minimum=0),
    Param("feed_x", -6.0, "Feed position (x)", "mm"),
    Param("cpw", 20, "Mesh cells per wavelength", "", minimum=8, maximum=60),
    Param("f_min", 1.8, "Band start", "GHz", minimum=0.01),
    Param("f_max", 3.0, "Band stop", "GHz", minimum=0.02),
]


def build(p: dict) -> Simulation:
    f_min, f_max = p["f_min"] * 1e9, p["f_max"] * 1e9
    if f_max <= f_min:
        raise ValueError("f_max must be above f_min")
    n, w, l, h, d = int(p["elements"]), p["patch_w"], p["patch_l"], p["sub_h"], p["spacing"]
    if d <= l:
        raise ValueError("spacing must exceed the patch width (y)")
    sim = Simulation(f_min, f_max, boundaries=["PML_8"] * 6, max_timesteps=60000)
    ys = [(k - (n - 1) / 2) * d for k in range(n)]
    sx, sy = w + 2 * p["margin"] + 14, (n - 1) * d + l + 2 * p["margin"]

    sim.dielectric("substrate", p["eps_r"], tan_d=p["tan_d"], tan_d_freq=2.45e9, label="Substrate").AddBox(
        priority=0, start=[-sx / 2, -sy / 2, 0], stop=[sx / 2, sy / 2, h])
    sim.metal("gnd", label="Ground plane").AddBox(priority=10, start=[-sx / 2, -sy / 2, 0], stop=[sx / 2, sy / 2, 0])
    patch = sim.metal("patches", label="Patches")
    for yc in ys:
        patch.AddBox(priority=10, start=[-w / 2, yc - l / 2, h], stop=[w / 2, yc + l / 2, h])
    for k, yc in enumerate(ys):
        sim.lumped_port(k + 1, 50, [p["feed_x"], yc, 0], [p["feed_x"], yc, h], "z", priority=5)

    sim.auto_mesh(cells_per_wavelength=p["cpw"], dielectric_cells=4)
    sim.set_focus([-sx / 2 - 5, -sy / 2 - 5, -3], [sx / 2 + 5, sy / 2 + 5, h + 5])
    sim.add_nf2ff_box(center=[0, 0, h])
    return sim
