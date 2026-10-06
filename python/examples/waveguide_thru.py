"""Check of the waveguide-port support: a straight WR-90 guide between two TE10 ports.

A fairbeam model module (not a bundle in the gallery). The guide walls are the PEC domain
boundaries in x and y; both ends run into PML. With ideal ports S11 = 0 and S21 = exp(-j beta L)
with beta = sqrt(k^2 - (pi/a)^2), so this exercises the port excitation, the mode-matched voltage
and current probes, the frequency-dependent reference impedance (Z_TE) and the two-port assembly
in fairbeam.multiport. docs/VALIDATION.md section 13 has the result (GPU engine, cpw 20):
|S11| < -40 dB, |S21| = 0 +- 0.004 dB, phase of S21 within 1.5 deg of beta L (beta within 0.2 %).

    PYTHONPATH=python python -m fairbeam run python/examples/waveguide_thru.py --engine gpu
"""

import numpy as np
from openEMS.physical_constants import C0

from fairbeam import Param, Simulation

MODEL = {
    "id": "waveguide-thru",
    "name": "WR-90 through guide (waveguide-port check)",
    "description": "Straight WR-90 guide between two TE10 waveguide ports; S21 should be exp(-j beta L).",
    "reference": "D. M. Pozar, Microwave Engineering, 4th ed., sec. 3.3 (rectangular waveguide)",
}

PARAMS = [
    Param("length", 60.0, "Guide length between the ports' planes (approx.)", "mm", minimum=10, maximum=500),
    Param("cpw", 20, "Cells per wavelength at f_max", "", minimum=5, maximum=60),
]

A, B = 22.86, 10.16   # WR-90


def build(p: dict) -> Simulation:
    L = p["length"]
    sim = Simulation(8e9, 12e9, boundaries=["PEC", "PEC", "PEC", "PEC", "PML_8", "PML_8"], max_timesteps=60000)
    res = C0 / 12e9 / 1e-3 / p["cpw"]
    sim.mesh.AddLine("x", np.linspace(-A / 2, A / 2, int(np.ceil(A / res)) + 1))
    sim.mesh.AddLine("y", np.linspace(-B / 2, B / 2, int(np.ceil(B / res)) + 1))
    z = np.arange(-L / 2 - 20 * res, L / 2 + 20 * res + 1e-9, res)
    sim.mesh.AddLine("z", z)
    # excitation planes 12 cells from the ends (outside the 8-cell PML), probes 2 cells inward
    sim.waveguide_port(1, [-A / 2, -B / 2, z[12]], [A / 2, B / 2, z[12] + 2 * res], "z", A, B, "TE10")
    sim.waveguide_port(2, [-A / 2, -B / 2, z[-13]], [A / 2, B / 2, z[-13] - 2 * res], "z", A, B, "TE10")
    return sim
