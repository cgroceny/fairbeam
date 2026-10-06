"""Check of the dispersive materials: a slab of a Debye, Lorentz, Drude or Djordjevic-Sarkar (FR4)
material at normal incidence in the plane-wave cell.

A fairbeam model module for ``fairbeam material-cell`` (not a bundle in the gallery), built like
slab_cell.py with ``Simulation.dispersive``. ``analytic_layers`` gives the same model to
fairbeam.analytic.slab_s, so the command compares S11 and S21 with the analytic slab and the
NRW / NIST extraction with the model's eps(f). docs/VALIDATION.md section 15c has the results.

    cd python
    python -m fairbeam material-cell examples/dispersive_cell.py --set model=lorentz --nist --threads 4 --out <folder> --sim-root <folder>

Models (band 1-10 GHz):

- ``debye``: eps_inf 3, one Debye pole of 2 relaxing at 3 GHz (eps 5 at DC), given to openEMS as
  fitted Lorentz poles (fairbeam.dispersion: its DebyeMaterial diverges at this delta / eps_inf of 0.67);
- ``lorentz``: eps_inf 2, a Lorentz pole at ``f_pole`` (default 6 GHz, in the band) with plasma
  frequency 3 GHz and damping 0.6 GHz;
- ``drude``: eps_inf 2, plasma frequency 3 GHz, damping 0.5 GHz (eps' < 0 below about 2.1 GHz);
- ``fr4``: Djordjevic-Sarkar FR4, eps_r 4.4 and tan d 0.02 at 1 GHz, fitted to Lorentz poles.
"""

import numpy as np

from fairbeam import Param, Simulation
from fairbeam.dispersion import Debye, Dispersion, DjordjevicSarkar, Drude, Lorentz
from fairbeam.material_cell import PlaneWaveCell

MODEL = {
    "id": "dispersive-cell",
    "name": "Dispersive slab in a plane-wave cell (dispersive-material check)",
    "description": "Debye, Lorentz, Drude or Djordjevic-Sarkar slab at normal incidence against the analytic slab.",
    "reference": "openEMS CalcDebyeMaterial / CalcLorentzMaterial; Djordjevic et al., IEEE Trans. EMC 43(4), 2001",
}

PARAMS = [
    Param("model", "debye", "Material model: debye, lorentz, drude or fr4"),
    Param("thickness", 10.0, "Slab thickness", "mm", minimum=0.1, maximum=200),
    Param("f_pole", 6.0, "Lorentz pole frequency (model lorentz)", "GHz", minimum=0.0, maximum=50),
    Param("cell", 5.0, "Cell size a = b", "mm", minimum=0.5, maximum=100),
    Param("cpw", 20, "Cells per wavelength at f_max (in the slab material)", "", minimum=5, maximum=80),
]

F_MIN, F_MAX = 1e9, 10e9
FR4 = DjordjevicSarkar.from_datasheet([(1e9, 4.4, 0.02)])


def _tau(f_c: float) -> float:
    return 1 / (2 * np.pi * f_c)


def material(p: dict):
    """The slab's model: a Dispersion, or the DjordjevicSarkar laminate (fitted by Simulation.dispersive)."""
    m = p["model"]
    if m == "debye":
        return Dispersion(3.0, (Debye(2.0, _tau(3e9)),))
    if m == "lorentz":
        return Dispersion(2.0, (Lorentz(3e9, p["f_pole"] * 1e9, _tau(0.6e9)),))
    if m == "drude":
        return Dispersion(2.0, (Drude(3e9, _tau(0.5e9)),))
    if m == "fr4":
        return FR4
    raise ValueError(f"model must be debye, lorentz, drude or fr4, not {m!r}")


def build(p: dict) -> Simulation:
    d = p["thickness"]
    sim = Simulation(F_MIN, F_MAX, max_timesteps=300000)
    eps = material(p).eps(np.linspace(F_MIN, F_MAX, 201))
    cell = PlaneWaveCell(sim, p["cell"], p["cell"], 0.0, d, eps_max=float(np.max(np.abs(eps))),
                         cells_per_wavelength=p["cpw"])
    slab = sim.dispersive("slab", material(p), label=f"Slab ({p['model']})")
    slab.AddBox(*cell.span(0.0, d))
    return sim


def analytic_layers(p: dict) -> list[dict]:
    """The slab for fairbeam.analytic.slab_s: the simulated poles. For debye and fr4 these are the
    Lorentz poles Simulation.dispersive fitted to the built mesh's timestep (openEMS'
    DebyeMaterial diverges for larger delta / eps_inf), so this checks the FDTD, not the fit; the fit error against the
    Debye pole or the laminate is in the material record's source.report."""
    m = material(p)
    if isinstance(m, DjordjevicSarkar) or m.model == "debye":
        m = build(p).dispersions["slab"]
    return [{"thickness": p["thickness"], "dispersion": m}]
