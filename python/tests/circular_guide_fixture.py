"""Raw cylindrical TE11 propagation fixture; deliberately not a Designer model.

Own parameters for Example 3.2 (p. 127): R=5 mm, eps_r=2.08, tan_delta
=0.0004 at 14 GHz, nominal gold conductivity=4.1e7 S/m. No book content.
Use the manual entry point in test_circular_guide_loss.py; ordinary tests do
not run FDTD. Cylindrical coordinates cannot be exported as Cartesian boxes.
"""
import hashlib
import json
import math
from pathlib import Path

import numpy as np

from fairbeam import Simulation
from CSXCAD import ContinuousStructure
from openEMS.ports import UI_data

C0, MU0, Z0 = 299792458.0, 4e-7 * np.pi, 376.730313668
RADIUS, EPS_R, REFERENCE_F = .005, 2.08, 14e9
CONDUCTIVITY, TAN_DELTA, SHEET_M = 4.1e7, .0004, 35e-6
FREQUENCIES = np.linspace(13.5e9, 14.5e9, 201)
LOSSES = ("none", "dielectric", "gold", "both", "native_sheet")
TARGET_ALPHA_REL, MESH_ALPHA_REL = .03, .02
TARGET_BETA_REL, MESH_BETA_REL = .005, .0025


def bessel_j(order, x):
    """Power series for small arguments in this fixture; no SciPy dependency."""
    x = np.asarray(x, dtype=float)
    term = (x / 2) ** order / math.factorial(order)
    result = term.copy()
    for k in range(1, 32):
        term = -term * x * x / (4 * k * (k + order))
        result += term
    return result


def _root(derivative):
    lo, hi = (1.0, 2.0) if derivative else (2.0, 3.0)
    def value(x):
        return (bessel_j(0, x) - bessel_j(2, x)) / 2 if derivative else bessel_j(0, x)
    for _ in range(54):
        mid = (lo + hi) / 2
        if value(lo) * value(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


TE11_ROOT, TM01_ROOT = _root(True), _root(False)


def reference(frequency, loss):
    """Weak-loss gamma from dispersion and the wall's magnetic-field integral.

    alpha_c = Rs * integral_wall(|Ht|^2) / (4*P). The scalar-conductivity
    dielectric has tan_delta(f)=tan_delta(14 GHz)*14 GHz/f. The conductor
    target is an opaque one-sided wall, not the native two-sided sheet.
    """
    if loss not in LOSSES:
        raise ValueError("unknown loss case")
    f = np.asarray(frequency, dtype=float)
    kc = TE11_ROOT / RADIUS
    k = 2 * np.pi * f * np.sqrt(EPS_R) / C0
    if np.any(~np.isfinite(f)) or np.any(k <= kc):
        raise ValueError("frequencies must be finite and above TE11 cutoff")
    beta = np.sqrt(k * k - kc * kc)
    alpha_d = (k * k * TAN_DELTA * REFERENCE_F / f / (2 * beta)
               if loss in ("dielectric", "both") else np.zeros_like(f))
    rs = np.sqrt(np.pi * f * MU0 / CONDUCTIVITY)
    alpha_c = (rs / (RADIUS * k * (Z0 / np.sqrt(EPS_R)) * beta)
               * (kc * kc + k * k / (TE11_ROOT * TE11_ROOT - 1))
               if loss in ("gold", "both", "native_sheet") else np.zeros_like(f))
    return {"beta": beta, "alpha_d": alpha_d, "alpha_c": alpha_c,
            "alpha": alpha_d + alpha_c}


class RawCylindricalSimulation(Simulation):
    def to_bundle(self, *args, **kwargs):
        raise ValueError("raw cylindrical fixture has no Cartesian bundle/Designer representation")


def build(radial_cells, loss, multigrid_levels=1):
    """One fixed 40 mm guide, six exact planes; one worker per native subgrid.

    One fixed multigrid split R/2 is used for the 8/12/16 comparison.
    The opt-in gold cases use sigma_sheet=sigma_bulk/4, the thick-sheet
    resistive half-space limit. This is NOT a model of bulk-metal phase or
    penetration. The native_sheet control retains the nominal conductivity.
    """
    if (isinstance(radial_cells, bool) or radial_cells != int(radial_cells)
            or radial_cells < 8 or radial_cells % 4):
        raise ValueError("radial_cells must be a multiple of four, at least eight")
    if multigrid_levels not in (0, 1, 2, 3):
        raise ValueError("at most three multigrid layers (four compute engines)")
    n = int(radial_cells)
    if multigrid_levels and n < 4 * 2 ** multigrid_levels:
        raise ValueError("multigrid's innermost split needs four radial intervals")
    if loss not in LOSSES:
        raise ValueError("unknown loss case")
    sigma = CONDUCTIVITY if loss == "native_sheet" else CONDUCTIVITY / 4
    skin = np.sqrt(1 / (np.pi * FREQUENCIES[0] * MU0 * sigma))
    if SHEET_M < 10 * skin:
        raise ValueError("half-space attenuation surrogate needs ten sheet skin depths")
    sim = RawCylindricalSimulation(FREQUENCIES[0], FREQUENCIES[-1], excitation="gauss",
        end_criteria_db=-70, max_timesteps=400000,
        boundaries=["PEC", "PEC", "PEC", "PEC", "PML_8", "PML_8"])
    csx = ContinuousStructure(CoordSystem=1)
    sim.fdtd.SetCSX(csx)
    sim.csx, sim.mesh = csx, csx.GetGrid()
    sim.mesh.SetDeltaUnit(sim.unit)
    sim.fdtd.SetCoordSystem(1)
    sim.mesh.SetMeshType(1)
    radius, sector, dr = RADIUS / sim.unit, 2 * np.pi, RADIUS / sim.unit / n
    if multigrid_levels:
        sim.fdtd.SetMultiGrid([radius / 2 ** k for k in range(multigrid_levels, 0, -1)])
    sim.mesh.AddLine("x", dr * np.arange(n + 3))
    sim.mesh.AddLine("y", np.linspace(0, sector, 4 * n + 1))
    z = dr * np.arange(-16, 8 * n + 17)
    for i in range(9):
        z[16 + n * i] = 5 * i
    sim.mesh.AddLine("z", z)
    sim.dielectric("filling", EPS_R, TAN_DELTA if loss in ("dielectric", "both") else 0,
                   REFERENCE_F).AddBox([0, 0, z[0]], [radius, sector, z[-1]], priority=1)
    lossy = loss in ("gold", "both", "native_sheet")
    wall_name = "native_sheet" if loss == "native_sheet" else "one_sided_wall_surrogate" if lossy else "PEC_wall"
    sim.metal(wall_name, conductivity=sigma if lossy else None,
              thickness=SHEET_M / sim.unit).AddBox([radius, 0, z[0]], [radius, sector, z[-1]], priority=10)
    kd = TE11_ROOT / radius
    e_r = f"-cos(a)*j1({kd:.17g}*rho)/(({kd:.17g})^2*(rho+1e-12))"
    e_a = f"sin(a)*0.5*(j0({kd:.17g}*rho)-jn(2,{kd:.17g}*rho))/({kd:.17g})"
    source = sim.csx.AddExcitation("mode_source", exc_type=0, exc_val=[1, 1, 0])
    source.SetWeightFunction([e_r, e_a, "0"])
    source.AddBox([0, 0, z[14]], [radius, sector, z[14]], priority=0)
    for i in range(1, 7):
        zp = z[16 + (i + 1) * n]
        sim.csx.AddProbe(f"u{i}", p_type=10, mode_function=[e_r, e_a, "0"]).AddBox(
            [0, 0, zp], [radius, sector, zp])
    return sim


def propagation(voltages, beta_hint, distance=.01):
    """Two independent three-plane extractions, including arbitrary reflections.

    (U(z-d)+U(z+d))/(2 U(z)) = cosh(gamma*d). A beta hint chooses the
    inverse-cosh sign/phase branch only; loss is measured without clipping.
    """
    u, hint = np.asarray(voltages), np.asarray(beta_hint)
    if u.shape != (6, hint.size) or not np.all(np.isfinite(u)):
        raise ValueError("six finite modal-voltage spectra are required")
    if not np.isfinite(distance) or distance <= 0 or np.any(~np.isfinite(hint)):
        raise ValueError("finite positive spacing and finite beta hint required")
    if np.any(abs(np.sin(hint * distance)) < .05):
        raise ValueError("ambiguous/ill-conditioned inverse-cosh spacing near a half guided wavelength")
    output = []
    for indices in ((0, 2, 4), (1, 3, 5)):
        minus, middle, plus = u[list(indices)]
        if np.any(np.abs(middle) <= 1e-8 * np.max(np.abs(u), axis=0)):
            raise ValueError("central probe is near a standing-wave node")
        principal = np.arccosh((minus + plus) / (2 * middle)) / distance
        candidates = []
        for sign in (-1, 1):
            turns = np.rint((hint - sign * principal.imag) * distance / (2 * np.pi))
            candidates.append(sign * principal + 1j * 2 * np.pi * turns / distance)
        candidates = np.asarray(candidates)
        errors = abs(candidates.imag - hint)
        if np.any(np.isclose(errors[0], errors[1], atol=1e-6, rtol=1e-8)):
            raise ValueError("ambiguous propagation branch")
        selected = candidates[np.argmin(errors, axis=0), np.arange(hint.size)]
        output.append(selected)
    return np.asarray(output)


def acquire(out, radial_cells, loss, multigrid_levels=1):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    source_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    sim = build(radial_cells, loss, multigrid_levels)
    input_cells = int(np.prod([len(sim.mesh.GetLines(axis)) - 1 for axis in "xyz"]))
    # The native engine creates a worker group per subgrid, not per whole run.
    sim.run(str(out / "raw"), threads=1, exact=True, echo=False)
    u = np.asarray(UI_data([f"u{i}" for i in range(1, 7)], str(out / "raw"), FREQUENCIES).ui_f_val)
    times = np.loadtxt(out / "raw/et", max_rows=2)
    np.savez_compressed(out / "data.npz", f=FREQUENCIES, u=u)
    meta = {"radial_cells": radial_cells, "loss": loss, "multigrid_levels": multigrid_levels,
        "compute_workers": 1 + multigrid_levels,
        "cells": input_cells, "cells_definition": "input bounding mesh intervals, before multigrid reduction",
        "dt_s": float(np.diff(times[:, 0])[0]), "run": sim.run_stats,
        "fixture_sha256": source_hash,
        "scope": "Raw modal-voltage propagation; no S parameters or Cartesian export."}
    (out / "report.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta


def analyse(root, meshes):
    """Require energy stopping, both triplets and two consecutive mesh pairs."""
    if len(meshes) < 3 or meshes != sorted(set(meshes)):
        raise ValueError("use at least three distinct increasing mesh levels")
    root = Path(root)
    rows, previous = [], {}
    for n in meshes:
        samples = {}
        for loss in LOSSES:
            dest = root / f"n{n}-{loss}"
            meta = json.loads((dest / "report.json").read_text(encoding="utf-8"))
            if (meta["radial_cells"], meta["loss"], meta["multigrid_levels"]) != (n, loss, 1):
                raise ValueError("comparison requires matched one-layer multigrid acquisitions")
            if meta["compute_workers"] != 2 or meta["run"].get("threads") != 1:
                raise ValueError("acquisition exceeds the four-worker limit")
            with np.load(dest / "data.npz") as data:
                np.testing.assert_array_equal(data["f"], FREQUENCIES)
                gamma = propagation(data["u"], reference(FREQUENCIES, loss)["beta"])
            samples[loss] = (gamma, meta)
        pec, pec_meta = samples["none"]
        beta_ref = reference(FREQUENCIES, "none")["beta"]
        beta_error = float(np.max(abs(pec.imag / beta_ref - 1)))
        beta_mesh = None if "beta" not in previous else float(np.max(abs(
            pec.imag - previous["beta"]) / beta_ref))
        for loss, (gamma, meta) in samples.items():
            if meta["cells"] != pec_meta["cells"] or not np.isclose(
                    meta["dt_s"], pec_meta["dt_s"], rtol=1e-8, atol=0):
                raise ValueError("loss and PEC control must use identical mesh size and time step")
            ref = reference(FREQUENCIES, loss)
            excess, target = (gamma - pec).real, ref["alpha"]
            error = None if loss == "none" else float(np.max(abs(excess / target - 1)))
            mesh_error = (None if loss == "none" or loss not in previous else
                          float(np.max(abs(excess - previous[loss]) / target)))
            # Agreement between spatially separated triplets is an independent
            # check against source/PML contamination or additional modes.
            triplet_error = None if loss == "none" else float(np.max(abs(
                excess[0] - excess[1]) / target))
            matches = beta_error <= TARGET_BETA_REL and (loss == "none" or
                error <= TARGET_ALPHA_REL and triplet_error <= MESH_ALPHA_REL)
            pair = beta_mesh is not None and beta_mesh <= MESH_BETA_REL and (
                loss == "none" or mesh_error is not None and mesh_error <= MESH_ALPHA_REL)
            rows.append({"radial_cells": n, "loss": loss, "cells": meta["cells"],
                "dt_ps": meta["dt_s"] * 1e12,
                "energy_stopped": bool(meta["run"].get("converged") and pec_meta["run"].get("converged")),
                "alpha_raw_mid": gamma.real[:, 100].tolist(),
                "pec_bias_mid": pec.real[:, 100].tolist(),
                "alpha_excess_mid": excess[:, 100].tolist(),
                "target_mid": float(target[100]), "beta_mid": pec.imag[:, 100].tolist(),
                "target_alpha_rel_max": error, "mesh_alpha_rel_max": mesh_error,
                "triplet_alpha_rel_max": triplet_error,
                "target_beta_rel_max": beta_error, "mesh_beta_rel_max": beta_mesh,
                "matches": bool(matches), "mesh_pair_passes": bool(pair),
                "scope": {"none": "PEC TE11 propagation", "dielectric": "weak dielectric loss",
                          "gold": "one-sided resistive surrogate; known discrepancy",
                          "both": "combined loss requires both components to match",
                          "native_sheet": "two-sided native sheet diagnostic"}[loss]})
            previous[loss] = excess
        previous["beta"] = pec.imag
    for loss in LOSSES:
        items = [r for r in rows if r["loss"] == loss]
        for i, row in enumerate(items):
            row["validated_scope"] = bool(i >= 2 and loss != "native_sheet" and
                all(r["energy_stopped"] for r in items[i-2:i+1]) and
                all(r["matches"] and r["mesh_pair_passes"] for r in items[i-1:i+1]))
    # A large dielectric loss must not hide an incorrect conductor component.
    for n in meshes:
        group = {r["loss"]: r for r in rows if r["radial_cells"] == n}
        group["both"]["validated_scope"] &= (
            group["dielectric"]["validated_scope"] and group["gold"]["validated_scope"])
    (root / "comparison.json").write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    return rows
