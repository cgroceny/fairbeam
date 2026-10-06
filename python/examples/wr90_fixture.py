"""Check of the waveguide material fixture: a homogeneous sample filling a WR-90 guide (X band).

A fairbeam model module for ``fairbeam material-cell`` (not a bundle in the gallery). The sample
fills the 22.86 x 10.16 mm cross-section between two TE10 ports (fairbeam.waveguide_fixture); S11
and S21 come from the sample run and an empty-guide reference run at one timestep and are
referred to the sample faces with the empty guide's measured propagation constant. The command
compares them with the guided transfer-matrix slab (fairbeam.analytic.slab_s with kc = pi / a) and
extracts eps_r, mu_r and tan d by the guided NRW (``--nist``: also the eps-only iterative method).
docs/VALIDATION.md section 17 has the result. ``eps_r`` 1 is the empty-guide check (S11 = 0, S21 =
1 at the faces). ``gap_x`` / ``gap_y`` leave an air gap between the sample and each narrow /
broad wall; the command then also gives eps_r corrected for it (VALIDATION.md section 17b).

    cd python
    python -m fairbeam material-cell examples/wr90_fixture.py --threads 4 --out <folder> --sim-root <folder>
"""

from fairbeam import Param, Simulation
from fairbeam.waveguide_fixture import WR90, WaveguideFixture

MODEL = {
    "id": "wr90-fixture",
    "name": "Sample in a WR-90 waveguide fixture (material-cell check)",
    "description": "Homogeneous sample filling a WR-90 guide between TE10 ports; S11 and S21 should follow the "
                   "guided transfer-matrix slab.",
    "reference": "W. B. Weir, Proc. IEEE 62, 1974 (transmission/reflection in a waveguide); D. M. Pozar, "
                 "Microwave Engineering, 4th ed., sec. 3.3",
}

PARAMS = [
    Param("thickness", 10.0, "Sample thickness", "mm", minimum=0.1, maximum=200),
    Param("eps_r", 4.0, "Relative permittivity", "", minimum=1.0, maximum=100),
    Param("tan_d", 0.0, "Loss tangent at the band centre", "", minimum=0.0, maximum=1.0),
    Param("mu_r", 1.0, "Relative permeability (loss-free)", "", minimum=1.0, maximum=100),
    Param("cpw", 20, "Cells per wavelength at f_max (in the sample material)", "", minimum=5, maximum=80),
    Param("gap_x", 0.0, "Air gap between the sample and each narrow wall", "mm", minimum=0.0, maximum=5.0),
    Param("gap_y", 0.0, "Air gap between the sample and each broad wall", "mm", minimum=0.0, maximum=2.5),
]

# WR-90 recommended band; TE10 cut-off 6.557 GHz, TE20 13.11 GHz
F_MIN, F_MAX = 8.2e9, 12.4e9


def _f_ref() -> float:
    return (F_MIN + F_MAX) / 2


def build(p: dict) -> Simulation:
    d = p["thickness"]
    # band-limited Gaussian: no energy below the empty guide's cut-off, which a sample with
    # eps_r mu_r > 1 would trap (fairbeam.waveguide_fixture)
    sim = Simulation(F_MIN, F_MAX, excitation="gauss", max_timesteps=200000)
    fx = WaveguideFixture(sim, 0.0, d, *WR90, eps_max=p["eps_r"], mu_max=p["mu_r"], cells_per_wavelength=p["cpw"],
                          gap_x=p["gap_x"], gap_y=p["gap_y"])
    sample = sim.dielectric("sample", p["eps_r"], p["tan_d"], tan_d_freq=_f_ref(), label="Sample", mu_r=p["mu_r"])
    sample.AddBox(*fx.sample_span(0.0, d))
    return sim


def analytic_layers(p: dict) -> list[dict]:
    return [{"thickness": p["thickness"], "eps_r": p["eps_r"], "tan_d": p["tan_d"], "tan_d_freq": _f_ref(),
             "mu_r": p["mu_r"]}]
