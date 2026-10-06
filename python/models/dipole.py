"""Centre-fed half-wave strip dipole in free space.

The simplest antenna with a well-known answer, used as fairbeam's validation reference
(docs/VALIDATION.md). A flat PEC strip of width w in the y = 0 plane is electrically equivalent to a
round wire of radius a = w / 4 (Balanis, Antenna Theory, 4th ed., sec. 9.7), so the analytic
induced-EMF impedance in ``fairbeam.analytic.dipole_impedance`` can be compared directly.

Expected (thin dipole): resonance (X = 0) at L = 0.47-0.48 lambda, R ~ 65-73 ohm there, Dmax 2.15 dBi,
radiation efficiency 1 (PEC, no dielectric).
"""

from openEMS.physical_constants import C0

from fairbeam import Param, Simulation

MODEL = {
    "id": "dipole",
    "name": "Half-wave dipole",
    "description": "Thin PEC strip dipole with a centre lumped feed, in free space (PML boundaries).",
    "reference": "C. A. Balanis, Antenna Theory, 4th ed., ch. 4 and 8 (half-wave dipole, induced EMF)",
}

PARAMS = [
    Param("length", 58.0, "Total length", "mm", minimum=5, maximum=1000),
    Param("width", 1.0, "Strip width", "mm", "Equivalent wire radius is width / 4", minimum=0.1, maximum=20),
    Param("gap", 1.0, "Feed gap", "mm", minimum=0.2, maximum=10),
    Param("feed_r", 73.0, "Port impedance", "ohm", minimum=1, maximum=1000),
    Param("mesh_div", 20, "Max cell = lambda(f_max) / mesh_div", "", minimum=8, maximum=80),
    Param("edge_div", 4, "Cells across the strip width", "",
          "Mesh lines across the strip; 1 puts lines only on the two strip edges", minimum=1, maximum=16),
    Param("arm_cells", 0, "Minimum intervals per arm", "",
          "Manual mesh only: 0 keeps the original mesh; 6 resolves electrically short arms", minimum=0, maximum=32),
    Param("thirds", 1, "Thirds rule at the arm ends", "",
          "1: mesh lines 1/3 inside and 2/3 outside each arm end; 0: a line on the end", minimum=0, maximum=1),
    Param("y_refine", 1, "Refine the mesh normal to the strip", "",
          "1: the same fine lines as across the strip also in y (normal to the sheet)", minimum=0, maximum=1),
    Param("pad", 0.0, "Free-space margin", "mm",
          "Distance from the dipole to the domain edge; 0 = max(lambda(f_min) / 4, 40 mm), plus 8 cells for PML",
          minimum=0, maximum=2000),
    Param("boundary", "PML_8", "Absorbing boundary", "",
          "MUR (first-order, cheap) or PML_8 (8-cell perfectly matched layer, placed inside the margin)"),
    Param("mesh", "manual", "Mesh", "",
          "manual: the hand-tuned mesh below; auto: fairbeam.automesh with mesh_div cells per wavelength"),
    Param("f_min", 1.5, "Band start", "GHz", minimum=0.1),
    Param("f_max", 3.5, "Band stop", "GHz", minimum=0.2),
]


def build(p: dict) -> Simulation:
    f_min, f_max = p["f_min"] * 1e9, p["f_max"] * 1e9
    if f_max <= f_min:
        raise ValueError("f_max must be above f_min")
    if p["gap"] >= p["length"]:
        raise ValueError("feed gap must be smaller than the total length")
    if p["boundary"] not in ("MUR", "PML_8"):
        raise ValueError("boundary must be MUR or PML_8")
    sim = Simulation(f_min, f_max, boundaries=[p["boundary"]] * 6, end_criteria_db=-60)
    L, w, g = p["length"], p["width"], p["gap"]
    lam_min = C0 / f_max / 1e-3
    lam_max = C0 / f_min / 1e-3
    res = lam_min / p["mesh_div"]

    arm = sim.metal("dipole", label="Dipole arms", color="#c9a227")
    arm.AddBox(priority=10, start=[-w / 2, 0, g / 2], stop=[w / 2, 0, L / 2])
    arm.AddBox(priority=10, start=[-w / 2, 0, -L / 2], stop=[w / 2, 0, -g / 2])
    sim.lumped_port(1, p["feed_r"], [-w / 2, 0, -g / 2], [w / 2, 0, g / 2], "z")

    if p["mesh"] not in ("manual", "auto"):
        raise ValueError("mesh must be manual or auto")
    if p["mesh"] == "auto":
        sim.auto_mesh(cells_per_wavelength=p["mesh_div"], pad=p["pad"] or None)
        sim.set_focus([-10, -10, -L / 2 - 5], [10, 10, L / 2 + 5])
        sim.add_nf2ff_box(center=[0, 0, 0])
        return sim

    # free space: at least lambda/4 at f_min between the dipole and the absorbing boundary
    pad = p["pad"] or max(lam_max / 4, 40.0) + (8 * res if p["boundary"].startswith("PML") else 0)
    if p["boundary"].startswith("PML"):
        # the 8 PML cells sit inside the margin; keep a few free cells for the NF2FF box
        pad = max(pad, 12 * res)
    pad = round(pad, 1)
    n_w = int(p["edge_div"])
    sim.mesh.AddLine("x", [-w / 2 - pad, pad + w / 2] + [-w / 2 + i * w / n_w for i in range(n_w + 1)])
    # the strip is a zero-thickness sheet in y = 0: its near field varies on the scale of w in y as
    # well, and a coarse y mesh makes it look like a much fatter conductor (resonance ~2 % low)
    fine = [-w / 2 + i * w / n_w for i in range(n_w + 1)]
    sim.mesh.AddLine("y", [-pad, 0, pad] + (fine if p["y_refine"] else []))
    arm_cells = int(p.get("arm_cells", 0))
    arm_step = (L - g) / (2 * arm_cells) if arm_cells else res / 2
    if p["thirds"]:
        # openEMS "thirds rule": the field singularity at a metal edge makes an edge that sits on a
        # mesh line look ~half a cell longer; placing lines 1/3 inside and 2/3 outside the edge
        # removes most of that bias at any mesh density.
        # An opt-in geometry scale prevents the end stencil entering a short arm's feed gap.
        d = min(res / 2, arm_step)
        ends = [L / 2 - d / 3, L / 2 + 2 * d / 3]
    else:
        ends = [L / 2]
    z_fine = []
    if arm_cells and res / 2 > arm_step:
        z_fine = [g / 2 + k * arm_step for k in range(1, arm_cells)]
        z_fine += [-v for v in z_fine]
    sim.mesh.AddLine("z", [-L / 2 - pad, -g / 2, g / 2, L / 2 + pad] + ends + [-e for e in ends] + z_fine)
    sim.smooth_mesh(res, 1.4)

    sim.set_focus([-10, -10, -L / 2 - 5], [10, 10, L / 2 + 5])
    sim.add_nf2ff_box(center=[0, 0, 0])
    return sim
