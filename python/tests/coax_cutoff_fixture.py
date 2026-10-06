"""Raw annular TE11 cutoff study; not a gallery or Designer model.

Own parameters for Example 3.3 (p. 132): radii .81915/2.7305 mm,
homogeneous eps_r=2.2, PEC conductors. No cable loss/launch model.
Bessel Y series: https://dlmf.nist.gov/10.8.E1 (small positive arguments).
"""
import hashlib
import json
import math
from pathlib import Path

import numpy as np

from tests.circular_guide_fixture import RawCylindricalSimulation, bessel_j, propagation
from CSXCAD import ContinuousStructure
from openEMS.ports import UI_data

C0 = 299792458.0
INNER, OUTER, EPS_R = .00081915, .0027305, 2.2
FREQUENCIES = np.linspace(19e9, 22e9, 121)
TARGET_REL, MESH_REL, TRIPLET_REL = .005, .0025, .001


def bessel_y(order, x):
    """Real Y0/Y1 power series, only the bounded small-argument study range."""
    x = np.asarray(x, dtype=float)
    if order not in (0, 1) or np.any(~np.isfinite(x)) or np.any(x <= 0) or np.any(x > 3):
        raise ValueError("Y series requires order zero/one and 0 < x <= 3")
    term = (x / 2) ** order / math.factorial(order)
    harmonic = 0.0
    result = np.zeros_like(x)
    for k in range(32):
        harmonic_next = harmonic + (1 / (k + 1) if order else 0)
        result += (harmonic + harmonic_next) * term
        harmonic += 1 / (k + 1)
        term = -term * x * x / (4 * (k + 1) * (k + order + 1))
    singular = -2 / (np.pi * x) if order else 0
    return (2 / np.pi * (np.log(x / 2) + np.euler_gamma) * bessel_j(order, x)
            + singular - result / np.pi)


def derivative(kind, x):
    return (bessel_j(0, x) - bessel_j(1, x) / x if kind == "j"
            else bessel_y(0, x) - bessel_y(1, x) / x)


def determinant(x):
    """Neumann TE11 boundary conditions at both conductor surfaces; x=kc*a."""
    outer = x * OUTER / INNER
    return derivative("j", x) * derivative("y", outer) - derivative("j", outer) * derivative("y", x)


def cutoff():
    lo, hi = .3, .6
    if determinant(lo) * determinant(hi) >= 0:
        raise ValueError("TE11 root is not bracketed")
    for _ in range(54):
        mid = (lo + hi) / 2
        if determinant(lo) * determinant(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2 / INNER * C0 / (2 * np.pi * np.sqrt(EPS_R))


CUTOFF = cutoff()
KC = 2 * np.pi * CUTOFF * np.sqrt(EPS_R) / C0
Y_RATIO = float(derivative("j", KC * INNER) / derivative("y", KC * INNER))


def radial_h(r):
    x = KC * np.asarray(r)
    return bessel_j(1, x) - Y_RATIO * bessel_y(1, x)


def _y_expression(order, x):
    # Expand only the Y correction. Native j0/j1, log and a short Horner
    # polynomial suffice; no assumption that the parser supports Y functions.
    harmonic, coeff = 0.0, []
    for k in range(12):
        next_h = harmonic + (1 / (k + 1) if order else 0)
        coeff.append((harmonic + next_h) * (-.25) ** k /
                     (2 ** order * math.factorial(k) * math.factorial(k + order)))
        harmonic += 1 / (k + 1)
    polynomial = f"{coeff[-1]:.17g}"
    for value in reversed(coeff[:-1]):
        polynomial = f"({value:.17g}+({x})^2*{polynomial})"
    correction = polynomial if order == 0 else f"({x})*{polynomial}"
    singular = f"-2/(pi*({x}))" if order else ""
    return (f"(2/pi*(log(({x})/2)+{np.euler_gamma:.17g})*j{order}({x})"
            f"{singular}-({correction})/pi)")


def build(radial_cells):
    if (isinstance(radial_cells, bool) or radial_cells != int(radial_cells)
            or radial_cells < 8 or radial_cells > 24 or radial_cells % 4):
        raise ValueError("radial_cells must be a multiple of four in 8..24")
    n = int(radial_cells)
    sim = RawCylindricalSimulation(FREQUENCIES[0], FREQUENCIES[-1], excitation="gauss",
        end_criteria_db=-70, max_timesteps=400000,
        boundaries=["PEC", "PEC", "PEC", "PEC", "PML_8", "PML_8"])
    csx = ContinuousStructure(CoordSystem=1)
    sim.fdtd.SetCSX(csx)
    sim.csx, sim.mesh = csx, csx.GetGrid()
    sim.mesh.SetDeltaUnit(sim.unit)
    sim.fdtd.SetCoordSystem(1)
    sim.mesh.SetMeshType(1)
    a, b = INNER / sim.unit, OUTER / sim.unit
    dr, dz = (b - a) / n, 3 / n
    radius = a + dr * np.arange(-2, n + 3)
    radius[2], radius[n + 2] = a, b
    if radius[0] <= 0:
        raise ValueError("the annular mesh must not reach the cylindrical axis")
    sim.mesh.AddLine("x", radius)
    sim.mesh.AddLine("y", np.linspace(0, 2 * np.pi, 4 * n + 1))
    z = dz * np.arange(-16, 9 * n + 17)
    for i in range(10):
        z[16 + i * n] = 3 * i
    sim.mesh.AddLine("z", z)
    sim.dielectric("filling", EPS_R).AddBox([a, 0, z[0]], [b, 2 * np.pi, z[-1]], priority=1)
    for name, r in (("inner_PEC", a), ("outer_PEC", b)):
        sim.metal(name).AddBox([r, 0, z[0]], [r, 2 * np.pi, z[-1]], priority=10)
    kd = KC * sim.unit
    x = f"({kd:.17g}*rho)"
    y0, y1 = _y_expression(0, x), _y_expression(1, x)
    h = f"(j1({x})-{Y_RATIO:.17g}*{y1})"
    hp = f"(j0({x})-j1({x})/({x})-{Y_RATIO:.17g}*({y0}-{y1}/({x})))"
    er = f"-cos(a)*{h}/(({kd:.17g})^2*rho)"
    ea = f"sin(a)*{hp}/({kd:.17g})"
    mode = [er, ea, "0"]
    source = csx.AddExcitation("TE11_source", exc_type=0, exc_val=[1, 1, 0])
    source.SetWeightFunction(mode)
    source.AddBox([a, 0, z[14]], [b, 2 * np.pi, z[14]])
    for i in range(1, 7):
        plane = z[16 + (i + 1) * n]
        csx.AddProbe(f"u{i}", p_type=10, mode_function=mode).AddBox([a, 0, plane], [b, 2 * np.pi, plane])
    return sim


def beta_reference():
    return 2 * np.pi * np.sqrt(EPS_R) / C0 * np.sqrt(FREQUENCIES ** 2 - CUTOFF ** 2)


def acquire(out, radial_cells):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sha = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    sim = build(radial_cells)
    cells = int(np.prod([len(sim.mesh.GetLines(axis)) - 1 for axis in "xyz"]))
    sim.run(str(out / "raw"), threads=4, exact=True, echo=False)
    u = np.asarray(UI_data([f"u{i}" for i in range(1, 7)], str(out / "raw"), FREQUENCIES).ui_f_val)
    t = np.loadtxt(out / "raw/et", max_rows=2)[:, 0]
    np.savez_compressed(out / "data.npz", f=FREQUENCIES, u=u)
    meta = {"radial_cells": radial_cells, "cells": cells, "dt_s": float(t[1] - t[0]),
            "run": sim.run_stats, "fixture_sha256": sha,
            "scope": "PEC annular TE11 eigen-cutoff inferred from above-cutoff dispersion"}
    (out / "report.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta


def analyse(root, meshes):
    if len(meshes) < 3 or meshes != sorted(set(meshes)):
        raise ValueError("three or more distinct increasing meshes required")
    rows, previous, source_sha = [], None, None
    for n in meshes:
        dest = Path(root) / f"n{n}"
        meta = json.loads((dest / "report.json").read_text(encoding="utf-8"))
        if meta["radial_cells"] != n or meta["run"].get("threads") != 4:
            raise ValueError("mesh identity and four-thread budget required")
        if not meta.get("fixture_sha256") or (source_sha is not None and meta["fixture_sha256"] != source_sha):
            raise ValueError("all meshes must use the same recorded fixture source")
        source_sha = meta["fixture_sha256"]
        with np.load(dest / "data.npz") as data:
            np.testing.assert_array_equal(data["f"], FREQUENCIES)
            gamma = propagation(data["u"], beta_reference(), distance=.006)
        radicand = FREQUENCIES ** 2 - (C0 * gamma.imag / (2 * np.pi * np.sqrt(EPS_R))) ** 2
        if np.any(radicand <= 0):
            raise ValueError("inferred cutoff is not real; reject the mode/branch extraction")
        inferred = np.sqrt(radicand)
        error = float(np.max(abs(inferred / CUTOFF - 1)))
        spread = float(np.max(abs(inferred[0] - inferred[1]) / CUTOFF))
        change = None if previous is None else float(np.max(abs(inferred - previous) / CUTOFF))
        rows.append({"radial_cells": n, "cells": meta["cells"], "dt_ps": meta["dt_s"] * 1e12,
            "energy_stopped": bool(meta["run"].get("converged")),
            "fc_mid_ghz": (inferred[:, 60] / 1e9).tolist(), "target_ghz": CUTOFF / 1e9,
            "fc_min_ghz": float(inferred.min() / 1e9), "fc_max_ghz": float(inferred.max() / 1e9),
            "target_rel_max": error, "triplet_rel_max": spread, "mesh_rel_max": change,
            "raw_alpha_mid": gamma.real[:, 60].tolist(),
            "matches": error <= TARGET_REL and spread <= TRIPLET_REL,
            "mesh_pair_passes": change is not None and change <= MESH_REL,
            "validated_scope": False})
        previous = inferred
    for i, row in enumerate(rows):
        row["validated_scope"] = bool(i >= 2 and all(r["energy_stopped"] for r in rows[i-2:i+1])
            and all(r["matches"] and r["mesh_pair_passes"] for r in rows[i-1:i+1]))
    (Path(root) / "comparison.json").write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    return rows
