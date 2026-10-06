"""Own homogeneous-guide fixture: fixed measurement planes and weak-loss references."""
import numpy as np

from fairbeam import Param, Simulation

C0 = 299792458.0
MODEL = {"id": "filled-rectangular-guide", "name": "Homogeneous rectangular guide",
         "description": "Fixed TE reference planes; PEC, native sheet or explicit one-sided wall surrogate.",
         "reference": "Pozar, Microwave Engineering, 4th ed., Example 3.1 (p. 116); independently defined fixture"}
PARAMS = [
    Param("length_sections", 1, "Length in 30 mm sections", minimum=1, maximum=10),
    Param("cpw", 20, "Cells per bulk wavelength", minimum=10, maximum=100),
    Param("eps_r", 2.08, "Relative permittivity", minimum=1, maximum=20),
    Param("tan_d", .0004, "Loss tangent at 15 GHz", minimum=0, maximum=.01),
    Param("wall_sigma", 5.8e7, "Wall conductivity; 0 selects PEC", "S/m", minimum=0),
    Param("wall_model", "sheet", "sheet (native diagnostic) or halfspace (one-sided surrogate)"),
    Param("sheet_thickness", .035, "Conducting-sheet thickness", "mm", minimum=.001, maximum=1),
    Param("mode", "TE10", "Rectangular TE mode"),
    Param("f_min", 14.5, "Band start", "GHz", minimum=.1),
    Param("f_max", 15.5, "Band stop", "GHz", minimum=.1),
]


def sheet_conductivity(p):
    """Explicit thick-skin mapping, not a change to the supplied bulk conductivity.

    Native openEMS sheets have Y = 2 sigma/gamma * tanh(gamma*t/2).
    Thus Re(1/Y) -> Rs/2 for t >> skin depth, whereas a one-sided
    half-space wall has Re(Zs) = Rs. Selecting sigma_sheet = sigma/4
    recovers that *resistive* limit. The engine's ADE fit approximates
    its reactive part differently; this is an attenuation surrogate,
    not a resolved bulk-conductor or finite-thickness transmission model.
    See openEMS FDTD/extensions/OptimizeCondSheetParameter.m and
    python/Tests/Conducting_Sheet.py in the upstream source.
    """
    kind = p["wall_model"]
    if kind not in ("sheet", "halfspace"):
        raise ValueError("wall_model must be sheet or halfspace")
    sigma = p["wall_sigma"]
    if not sigma or kind == "sheet":
        return sigma
    effective_sigma = sigma / 4
    delta = np.sqrt(1 / (np.pi * p["f_min"] * 1e9 * (4e-7 * np.pi) * effective_sigma))
    if p["sheet_thickness"] * 1e-3 < 10 * delta:
        raise ValueError("halfspace surrogate requires sheet thickness >= 10 mapped skin depths")
    return effective_sigma


def build(p):
    a, b, base_length = 10.7, 4.3, 30.0
    length = base_length * p["length_sections"]
    f_min, f_max, er = p["f_min"] * 1e9, p["f_max"] * 1e9, p["eps_r"]
    mode = p["mode"]
    if (len(mode) != 4 or not mode.startswith("TE") or not mode[2:].isdigit()
            or mode[2:] == "00"):
        raise ValueError("this fixture needs a nonzero rectangular TE mode")
    fc = C0 / (2 * np.sqrt(er)) * np.hypot(int(mode[2]) / (a * 1e-3), int(mode[3]) / (b * 1e-3))
    if not fc < f_min < f_max:
        raise ValueError("the fixture's evaluation band must be entirely above the mode cutoff")
    if p["length_sections"] != int(p["length_sections"]) or p["length_sections"] < 1:
        raise ValueError("length_sections must be a positive integer")
    # This narrow band is above cutoff. A modulated Gaussian avoids driving
    # the below-cutoff/near-cutoff spectrum of a broadband derivative pulse.
    sim = Simulation(f_min, f_max, boundaries=["PEC"] * 4 + ["PML_8"] * 2, excitation="gauss",
                     max_timesteps=100000, end_criteria_db=-70)
    target = C0 / f_max / np.sqrt(er) / 1e-3 / p["cpw"]
    n_base = int(np.ceil(base_length / target))
    dz = base_length / n_base
    nz = n_base * p["length_sections"]
    for axis, size in (("x", a), ("y", b)):
        n = int(np.ceil(size / target))
        lines = np.linspace(-size / 2, size / 2, n + 1)
        dx = size / n
        sim.mesh.AddLine(axis, np.r_[lines[0] - 2 * dx, lines[0] - dx,
                                    lines, lines[-1] + dx, lines[-1] + 2 * dx])
    z = dz * np.arange(-16, nz + 17)
    z[16], z[nz + 16] = 0, length
    sim.mesh.AddLine("z", z)
    filling = sim.dielectric("filling", er, tan_d=p["tan_d"], tan_d_freq=15e9)
    filling.AddBox([-a / 2, -b / 2, z[0]], [a / 2, b / 2, z[-1]], priority=1)
    sigma = sheet_conductivity(p)
    walls = sim.metal("walls" if p["wall_model"] == "sheet" else "one_sided_wall_surrogate",
                      conductivity=sigma or None, thickness=p["sheet_thickness"])
    for x in (-a / 2, a / 2):
        walls.AddBox([x, -b / 2, z[0]], [x, b / 2, z[-1]], priority=10)
    for y in (-b / 2, b / 2):
        walls.AddBox([-a / 2, y, z[0]], [a / 2, y, z[-1]], priority=10)
    sim.waveguide_port(1, [-a / 2, -b / 2, z[14]], [a / 2, b / 2, z[16]],
                       "z", a, b, p["mode"], eps_r=er)
    sim.waveguide_port(2, [-a / 2, -b / 2, z[-15]], [a / 2, b / 2, z[-17]],
                       "z", a, b, p["mode"], eps_r=er)
    return sim


def analytical(f, p):
    """Own TE10 weak-loss formulas; SI units and exact C0."""
    f = np.asarray(f)
    a, b = .0107, .0043
    er = p["eps_r"]
    m, n = int(p["mode"][2]), int(p["mode"][3])
    kc = np.pi * np.hypot(m / a, n / b)
    k0 = 2 * np.pi * f / C0
    beta = np.sqrt(k0 ** 2 * er - kc ** 2)
    fc = kc * C0 / (2 * np.pi * np.sqrt(er))
    # The model uses constant kappa: its loss tangent is specified at 15 GHz.
    tan = p["tan_d"] * 15e9 / f
    alpha_d = k0 ** 2 * er * tan / (2 * beta)
    alpha_c = np.zeros_like(f)
    if p["wall_sigma"]:
        if p["mode"] != "TE10":
            raise ValueError("conductor-loss reference is defined only for TE10")
        rs = np.sqrt(np.pi * f * (4e-7 * np.pi) / p["wall_sigma"])
        eta = 376.730313668 / np.sqrt(er)
        alpha_c = rs / (b * eta * np.sqrt(1 - (fc / f) ** 2)) * (1 + 2 * b / a * (fc / f) ** 2)
    return {"beta": beta, "alpha_d": alpha_d, "alpha_c": alpha_c,
            "alpha": alpha_d + alpha_c, "cutoff": fc}
