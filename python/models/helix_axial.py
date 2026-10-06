"""Axial-mode helix (Kraus) over a square ground plane, 2.4 GHz, right-hand wound.

Design (Kraus & Marhefka, *Antennas*, 3rd ed., ch. 8; ``fairbeam.analytic.helix_axial_mode``):
circumference C = lambda at the design frequency (radius 19.9 mm at 2.4 GHz), pitch angle 13 deg
(turn spacing S = C tan 13 deg = 28.8 mm), N = 7 turns, so the helix is 1.6 lambda long. Kraus'
estimates for this helix: D = 10.8 + 10 log10(C^2 N S / lambda^3) = 13.8 dBi (known to be 1-3 dB
high), R_in = 140 C/lambda = 140 ohm, AR = (2N + 1)/(2N) = 0.6 dB at boresight.

Model:
- the helix is a thin PEC wire (CSXCAD ``Curve``, 36 points per turn), the classic openEMS helix
  model (openEMS Helical_Antenna tutorial). FDTD puts a thin wire on the nearest mesh edges, so
  ``auto_mesh`` covers the helix extent with half-size cells. The effective wire radius is a
  fraction of a cell, so the wire gets thinner as the mesh is refined: the input resistance rises
  with ``cpw`` (138 / 164 / 181 ohm mean over 2.0-2.9 GHz at cpw 20 / 30 / 40) while the pattern
  converges (D at 2.4 GHz 12.1 / 11.6 / 11.4 dBi). docs/VALIDATION.md section 14.
- right-hand winding (angle increases with z): axial-mode radiation is RHCP along +z.
- the feed is a lumped port (120 ohm, near Kraus' R_in) from the ground plane up to the start of
  the helix, ``feed_gap`` high, at radius R. The first turn starts from the port top.
- square ground plane ``gnd`` wide (Kraus: at least 3/4 lambda); PML boundaries lambda/4 away at
  f_min (with MUR boundaries this model went unstable after ~20k timesteps on the GPU engine).
  Circular-polarisation outputs (RHCP/LHCP directivity, axial ratio) are switched on.
"""

import numpy as np
from openEMS.physical_constants import C0

from fairbeam import Param, Simulation

MODEL = {
    "id": "helix-axial",
    "name": "Axial-mode helix (2.4 GHz, RHCP)",
    "description": "Kraus axial-mode helix, C = lambda, 13 deg pitch, 7 turns over a square ground plane, lumped-port fed; RHCP outputs.",
    "reference": "J. D. Kraus, R. J. Marhefka, Antennas, 3rd ed., ch. 8 (axial-mode helix)",
}

PARAMS = [
    Param("f0", 2.4, "Design frequency", "GHz", "C = lambda here", minimum=0.3, maximum=30),
    Param("c_lambda", 1.0, "Circumference", "lambda", "In wavelengths at f0 (axial mode: 3/4 to 4/3)", minimum=0.7, maximum=1.4),
    Param("pitch_deg", 13.0, "Pitch angle", "deg", minimum=5, maximum=25),
    Param("turns", 7.0, "Turns", "", minimum=1, maximum=20),
    Param("feed_gap", 3.0, "Feed gap", "mm", "Port height above the ground plane", minimum=0.5, maximum=20),
    Param("gnd", 100.0, "Ground plane side", "mm", minimum=10, maximum=1000),
    Param("port_r", 120.0, "Port impedance", "ohm", minimum=10, maximum=500),
    Param("pts_turn", 36, "Points per turn", "", minimum=8, maximum=120),
    Param("cpw", 30, "Mesh cells per wavelength", "", "At f_max; the helix gets half-size cells", minimum=10, maximum=40),
    Param("f_min", 1.8, "Band start", "GHz", minimum=0.1),
    Param("f_max", 3.0, "Band stop", "GHz", minimum=0.2),
]


def helix_points(radius, spacing, turns, z0, n_turn):
    """Right-hand helix from (radius, 0, z0): angle and height both increase."""
    t = np.linspace(0, 2 * np.pi * turns, int(round(n_turn * turns)) + 1)
    return np.column_stack([radius * np.cos(t), radius * np.sin(t), z0 + spacing * t / (2 * np.pi)])


def build(p: dict) -> Simulation:
    f_min, f_max, f0 = p["f_min"] * 1e9, p["f_max"] * 1e9, p["f0"] * 1e9
    if f_max <= f_min:
        raise ValueError("f_max must be above f_min")
    lam0 = C0 / f0 / 1e-3
    circ = p["c_lambda"] * lam0
    radius = circ / (2 * np.pi)
    spacing = circ * np.tan(np.radians(p["pitch_deg"]))
    g, gp = p["feed_gap"], p["gnd"]
    if gp < 2.2 * radius:
        raise ValueError("ground plane narrower than the helix")

    sim = Simulation(f_min, f_max, boundaries=["PML_8"] * 6, max_timesteps=60000)
    sim.metal("gnd", label="Ground plane").AddBox(priority=10, start=[-gp / 2, -gp / 2, 0], stop=[gp / 2, gp / 2, 0])
    pts = helix_points(radius, spacing, p["turns"], g, p["pts_turn"])
    helix = sim.metal("helix", label="Helix (thin wire)")
    helix.AddCurve(pts.T.tolist(), priority=10)   # CSXCAD wants (3, N)
    sim.lumped_port(1, p["port_r"], [radius, 0, 0], [radius, 0, g], "z")

    sim.auto_mesh(cells_per_wavelength=p["cpw"])
    top = float(pts[-1, 2])
    sim.set_focus([-gp / 2, -gp / 2, 0], [gp / 2, gp / 2, top])
    sim.add_nf2ff_box(center=[0, 0, top / 2])
    sim.cp_outputs = True
    sim.pattern_freqs = [f for f in (0.875 * f0, f0, 1.125 * f0) if f_min <= f <= f_max] or [f0]
    return sim
