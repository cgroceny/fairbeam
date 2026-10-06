"""Uniform-transverse grounded scalar dielectric fixture, not a gallery model.

Own parameters for Example 3.4 (p. 139): eps_r=2.55; scale-free thickness
ratios measured at our 10 GHz reference. TM0, TE1, TM1 only. No book content.
Interface equations independently follow Maxwell continuity; see Appendix A:
https://www.mdpi.com/2076-3417/8/1/102 . No anisotropic material is simulated.
"""
import hashlib
import json
from pathlib import Path

import numpy as np

from fairbeam import Simulation
from openEMS.ports import UI_data
from tests.circular_guide_fixture import propagation

C0, EPS_R, F0 = 299792458., 2.55, 10e9
FREQUENCIES = np.linspace(.99 * F0, 1.01 * F0, 41)
MODES = ("TM0", "TE1", "TM1")
CASES = [("TM0", d) for d in (.1, .3, .6, .9, 1.2)] + [
         ("TE1", d) for d in (.3, .6, .9, 1.2)] + [
         ("TM1", d) for d in (.6, .9, 1.2)]
TARGET_REL, MESH_REL, TRIPLET_REL = .005, .0025, .002
MAX_FIXTURE_CELLS = 2_000_000


def parameters(mode, ratio, frequency):
    """Return beta, transverse h and air-decay q from a bracketed mode branch.

    TM: u*tan(u)=eps_r*sqrt(V^2-u^2); TE: -u*cot(u)=sqrt(V^2-u^2).
    V=k0*d*sqrt(eps_r-1), d fixed by ratio at F0 (not retuned with f).
    """
    if mode not in MODES or not np.isfinite(ratio) or not 0 < ratio <= 1.2:
        raise ValueError("supported mode and thickness ratio in (0,1.2] required")
    f = np.asarray(frequency, dtype=float)
    if np.any(~np.isfinite(f)) or np.any(f <= 0):
        raise ValueError("positive finite frequencies required")
    thickness = ratio * C0 / F0
    v = 2 * np.pi * f / C0 * thickness * np.sqrt(EPS_R - 1)
    start = {"TM0": 0., "TE1": np.pi/2, "TM1": np.pi}[mode]
    if np.any(v <= start):
        raise ValueError("mode is below its surface-wave cutoff")
    lo = np.full_like(v, start)
    hi = np.nextafter(np.minimum(v, start + np.pi/2), lo)
    for _ in range(54):
        mid = (lo + hi) / 2
        tail = np.sqrt(np.maximum(v * v - mid * mid, 0))
        residual = (mid * np.tan(mid) - EPS_R * tail if mode.startswith("TM")
                    else -mid / np.tan(mid) - tail)
        lo, hi = np.where(residual < 0, mid, lo), np.where(residual < 0, hi, mid)
    h = (lo + hi) / (2 * thickness)
    k0 = 2 * np.pi * f / C0
    beta = np.sqrt(EPS_R * k0 * k0 - h * h)
    q = np.sqrt(beta * beta - k0 * k0)
    return beta, h, q


def build(layer_cells, mode, ratio, air_decays=6):
    """Four transverse intervals with exact PEC/PMC uniform-field symmetry.

    X propagation, grounded z=0, dielectric z<=d; y is uniform. TE uses
    PEC y walls (Ey normal), TM uses PMC y walls (Hy normal). This is not a
    finite-width device; no Bloch boundary or new core boundary type is needed.
    """
    if (isinstance(layer_cells, bool) or layer_cells != int(layer_cells)
            or layer_cells < 8 or layer_cells > 32 or layer_cells % 4):
        raise ValueError("layer resolution must be a multiple of four in 8..32")
    if not np.isfinite(air_decays) or not 6 <= air_decays <= 10:
        raise ValueError("air truncation must be six to ten decay lengths")
    n = int(layer_cells)
    _, h, q = [float(v) for v in parameters(mode, ratio, F0)]
    if not np.isfinite(h) or not np.isfinite(q) or q <= 0:
        raise ValueError("mode confinement is too weak for a finite air domain")
    d = ratio * C0 / F0 / 1e-3
    h, q = h * 1e-3, q * 1e-3
    dy, dx = .25, 4 / n
    target_dz = min(d, 1/q) / n
    layer_count = int(np.ceil(d / target_dz))
    dz = d / layer_count
    air_count = int(np.ceil(air_decays / (q * dz)))
    # Refuse near-cutoff/thin-sheet cases before creating enormous arrays.
    # A finite-air surface study becomes unbounded as q approaches zero.
    estimated_cells = (15*n + 32) * 4 * (layer_count + air_count + 10)
    if estimated_cells > MAX_FIXTURE_CELLS:
        raise ValueError("surface fixture cell budget exceeded; use a coarser or more confined case")
    z = np.concatenate([[-2*dz, -dz], np.linspace(0, d, layer_count + 1),
                        d + dz * np.arange(1, air_count + 9)])
    z[layer_count+2] = d
    y_wall = "PMC" if mode.startswith("TM") else "PEC"
    # A wider pulse band keeps acquisition short; measurements remain in the
    # narrower interval where the fixed transverse projection is appropriate.
    sim = Simulation(.95*F0, 1.05*F0, excitation="gauss",
        end_criteria_db=-70, max_timesteps=400000,
        boundaries=["PML_8", "PML_8", y_wall, y_wall, "PEC", "PML_8"])
    x = dx * np.arange(-16, 15 * n + 17)
    for i in range(16):
        x[16 + i * n] = 4 * i
    sim.mesh.AddLine("x", x)
    sim.mesh.AddLine("y", np.arange(5)*dy)
    sim.mesh.AddLine("z", z)
    # Make the physical ground an internal interface so modal quadrature can
    # include its first normal-E cell rather than clamp to a mesh boundary.
    sim.metal("PEC_ground").AddBox([x[0], 0, z[0]], [x[-1], 4*dy, 0], priority=10)
    sim.dielectric("slab", EPS_R).AddBox([x[0], 0, 0], [x[-1], 4*dy, d], priority=1)
    function = "cos" if mode.startswith("TM") else "sin"
    inside = f"{function}({h:.17g}*z)"
    outside = f"{function}({h*d:.17g})*exp(-{q:.17g}*(z-{d:.17g}))"
    profile = f"if(z<={d:.17g},{inside},{outside})"
    component = 2 if mode.startswith("TM") else 1
    source_profile = (f"if(z<={d:.17g},({inside})/{EPS_R:.17g},{outside})"
                      if mode.startswith("TM") else profile)
    weights, amplitude = ["0", "0", "0"], [0, 0, 0]
    weights[component], amplitude[component] = source_profile, 1
    source = sim.csx.AddExcitation("surface_source", exc_type=0, exc_val=amplitude)
    source.SetWeightFunction(weights)
    height = z[air_count + layer_count + 2]
    source.AddBox([x[14], 0, 0], [x[14], 4*dy, height])
    probe_mode = ["0", "0", "0"]
    # TM Ez ~ Hy/eps. Weight with Hy so the measured integral has the
    # self-adjoint 1/eps inner product, not a second spurious 1/eps factor.
    probe_mode[component] = profile
    for i in range(1, 7):
        plane = x[16 + (i + 5) * n]
        sim.csx.AddProbe(f"u{i}", p_type=10, mode_function=probe_mode).AddBox(
            [plane, dy, 0], [plane, 3*dy, height])
    return sim


def case_name(mode, ratio):
    return f"{mode}-d{ratio:g}"


def acquire(out, layer_cells, mode, ratio, air_decays=6):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sha = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    sim = build(layer_cells, mode, ratio, air_decays)
    cells = int(np.prod([len(sim.mesh.GetLines(a)) - 1 for a in "xyz"]))
    sim.run(str(out / "raw"), threads=4, exact=True, echo=False)
    try:
        u = np.asarray(UI_data([f"u{i}" for i in range(1, 7)], str(out / "raw"), FREQUENCIES).ui_f_val)
    except Exception:
        # A native setup failure may return without probe files. Retain its
        # diagnostics, but no completed report/data pair for validation.
        (out / "failure.json").write_text(json.dumps(sim.run_stats, indent=2) + "\n", encoding="utf-8")
        raise
    t = np.loadtxt(out / "raw/et", max_rows=2)[:, 0]
    np.savez_compressed(out / "data.npz", f=FREQUENCIES, u=u)
    meta = {"layer_cells": layer_cells, "mode": mode, "ratio": ratio, "air_decays": air_decays,
            "cells": cells, "dt_s": float(t[1]-t[0]), "fixture_sha256": sha,
            "run": sim.run_stats, "scope": "Uniform-transverse scalar grounded surface wave"}
    (out / "report.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta


def analyse(root, meshes, cases=CASES):
    if len(meshes) < 3 or meshes != sorted(set(meshes)):
        raise ValueError("three increasing mesh levels required")
    root, rows = Path(root), []
    for mode, ratio in cases:
        previous, source_sha, group = None, None, []
        beta, _, _ = parameters(mode, ratio, FREQUENCIES)
        for n in meshes:
            dest = root / case_name(mode, ratio) / f"n{n}"
            meta = json.loads((dest / "report.json").read_text(encoding="utf-8"))
            if (meta["layer_cells"], meta["mode"], meta["ratio"], meta["air_decays"]) != (n, mode, ratio, 6):
                raise ValueError("case identity or air-domain protocol differs")
            if meta["run"].get("threads") != 4:
                raise ValueError("four-thread acquisition budget required")
            if not meta.get("fixture_sha256") or (source_sha is not None and meta["fixture_sha256"] != source_sha):
                raise ValueError("all meshes in a case must share the same source fingerprint")
            source_sha = meta["fixture_sha256"]
            with np.load(dest / "data.npz") as data:
                np.testing.assert_array_equal(data["f"], FREQUENCIES)
                gamma = propagation(data["u"], beta, distance=.008)
            error = float(np.max(abs(gamma.imag / beta - 1)))
            spread = float(np.max(abs(gamma[0].imag - gamma[1].imag) / beta))
            change = None if previous is None else float(np.max(abs(gamma.imag - previous) / beta))
            group.append({"mode": mode, "ratio": ratio, "layer_cells": n,
                "cells": meta["cells"], "dt_ps": meta["dt_s"] * 1e12,
                "beta_mid": gamma.imag[:, 20].tolist(), "target_beta_mid": float(beta[20]),
                "raw_alpha_mid": gamma.real[:, 20].tolist(),
                "target_rel_max": error, "triplet_rel_max": spread, "mesh_rel_max": change,
                "energy_stopped": bool(meta["run"].get("converged")),
                "matches": error <= TARGET_REL and spread <= TRIPLET_REL,
                "mesh_pair_passes": change is not None and change <= MESH_REL,
                "validated_scope": False})
            previous = gamma.imag
        for i, row in enumerate(group):
            row["validated_scope"] = bool(i >= 2 and all(r["energy_stopped"] for r in group[i-2:i+1])
                and all(r["matches"] and r["mesh_pair_passes"] for r in group[i-1:i+1]))
        rows.extend(group)
    (root / "comparison.json").write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    return rows
