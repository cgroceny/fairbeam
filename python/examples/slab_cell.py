"""Check of the plane-wave material cell: a homogeneous dielectric slab at normal incidence.

A fairbeam model module for ``fairbeam material-cell`` (not a bundle in the gallery). The slab
fills the cross-section of a TEM cell (PMC walls in x, PEC walls in y, PML in z), which emulates a
laterally infinite slab; S11 and S21 come from the sample run and an empty reference run
(fairbeam.material_cell). ``analytic_layers`` gives the slab to fairbeam.analytic.slab_s, so the
command prints the deviation from the transfer-matrix result. docs/VALIDATION.md section 15 has
the result. With the defaults (10 mm, eps_r 4) the slab is a half wave thick at 7.5 GHz, where
S11 has a null. The command also extracts eps_r, mu_r and tan d from S11 and S21 (fairbeam.nrw;
``--nist`` adds the eps-only iterative method); ``mu_r`` makes the slab magnetic (avoid mu_r =
eps_r: the slab is then matched to vacuum, S11 vanishes and NRW has nothing to invert).

    cd python
    python -m fairbeam material-cell examples/slab_cell.py --threads 4 --out <folder> --sim-root <folder>
"""

from fairbeam import Param, Simulation
from fairbeam.material_cell import PlaneWaveCell

MODEL = {
    "id": "slab-cell",
    "name": "Dielectric slab in a plane-wave cell (material-cell check)",
    "description": "Homogeneous slab at normal incidence; S11 and S21 should follow the transfer-matrix slab.",
    "reference": "S. J. Orfanidis, Electromagnetic Waves and Antennas, ch. 6 (multilayer structures)",
}

PARAMS = [
    Param("thickness", 10.0, "Slab thickness", "mm", minimum=0.1, maximum=200),
    Param("eps_r", 4.0, "Relative permittivity", "", minimum=1.0, maximum=100),
    Param("tan_d", 0.0, "Loss tangent at the band centre", "", minimum=0.0, maximum=1.0),
    Param("mu_r", 1.0, "Relative permeability (loss-free)", "", minimum=1.0, maximum=100),
    Param("cell", 5.0, "Cell size a = b", "mm", minimum=0.5, maximum=100),
    Param("cpw", 20, "Cells per wavelength at f_max (in the slab material)", "", minimum=5, maximum=80),
]

F_MIN, F_MAX = 1e9, 10e9


def _f_ref() -> float:
    return (F_MIN + F_MAX) / 2


def build(p: dict) -> Simulation:
    d = p["thickness"]
    sim = Simulation(F_MIN, F_MAX, max_timesteps=100000)
    cell = PlaneWaveCell(sim, p["cell"], p["cell"], 0.0, d, eps_max=p["eps_r"], mu_max=p["mu_r"],
                         cells_per_wavelength=p["cpw"])
    slab = sim.dielectric("slab", p["eps_r"], p["tan_d"], tan_d_freq=_f_ref(), label="Slab", mu_r=p["mu_r"])
    slab.AddBox(*cell.span(0.0, d))
    return sim


def analytic_layers(p: dict) -> list[dict]:
    return [{"thickness": p["thickness"], "eps_r": p["eps_r"], "tan_d": p["tan_d"], "tan_d_freq": _f_ref(),
             "mu_r": p["mu_r"]}]
