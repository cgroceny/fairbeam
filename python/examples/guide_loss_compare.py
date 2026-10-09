"""Serial, four-thread acquisition and two-length analysis for rectangular_guide_loss.

From python/: python examples/guide_loss_compare.py --out <outside-repo-directory>
The default 20/30/40 study takes minutes. Raw solver output is never a source artifact.
Native-sheet controls are diagnostics; the halfspace case tests attenuation only.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

from fairbeam.model import load_model, resolve_params
from fairbeam.multiport import assemble_s, run_model
from fairbeam import multiport, simulation, wgport

MODEL_PATH = Path(__file__).with_name("rectangular_guide_loss.py")
PROTOCOL = "rectangular-guide-completed-source-v1"
LOSSES = ("none", "dielectric", "copper", "both", "native_sheet")
# Predefined across the full 201-point band, not just the middle frequency.
TARGET_ALPHA_REL = .03
MESH_ALPHA_REL = .02
TARGET_BETA_REL = .005
MESH_BETA_REL = .0025


def source_ids():
    paths = {"model": MODEL_PATH, "reader": Path(__file__),
             "simulation": Path(simulation.__file__), "multiport": Path(multiport.__file__),
             "wgport": Path(wgport.__file__)}
    return {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in paths.items()}


def sources_completed(meta):
    """Historical or incomplete records cannot establish a post-source scope."""
    columns = meta.get("source_columns")
    if (meta.get("protocol") != PROTOCOL or meta.get("source_ids") != source_ids()
            or not isinstance(columns, list) or len(columns) != 2):
        return False
    p = meta["parameters"]
    end_db = p.get("end_criteria_db", -70)
    if (isinstance(end_db, bool) or not isinstance(end_db, (int, float))
            or not np.isfinite(end_db) or not -100 <= end_db <= -20):
        return False
    pulse_s = 9 / (np.pi * (p["f_max"]-p["f_min"]) * .5e9)
    for pn, column in enumerate(columns, 1):
        if not isinstance(column, dict) or not isinstance(column.get("run"), dict):
            return False
        dt, length = column.get("dt_s"), column.get("signal_steps")
        run = column.get("run", {})
        steps = run.get("timesteps")
        energy = [run.get(key) for key in ("final_energy_db", "final_energy_bound_db")]
        energy = [v for v in energy if isinstance(v, (int, float))
                  and not isinstance(v, bool) and np.isfinite(v)]
        if (column.get("port") != pn or isinstance(column.get("port"), bool)
                or isinstance(dt, bool) or not isinstance(dt, (int, float)) or not np.isfinite(dt) or dt <= 0
                or isinstance(length, bool) or not isinstance(length, int)
                or isinstance(steps, bool) or not isinstance(steps, int) or not 0 < steps < 100000
                or abs(length-int(np.ceil(pulse_s/dt))) > 1 or steps < length
                or run.get("converged") is not True or column.get("exact_endcriteria") is not True
                or column.get("threads") != 4 or run.get("engine") != "cpu"
                or not energy or max(energy) > end_db+1e-9):
            return False
    return True


def propagation(short, long, length_difference, beta_hint):
    """gamma=alpha+j*beta; beta_hint selects the integer phase branch only."""
    ratio = np.asarray(long) / np.asarray(short)
    phase = -np.unwrap(np.angle(ratio))
    branch = (np.asarray(beta_hint) * length_difference - phase) / (2 * np.pi)
    turns = np.rint(branch)
    if np.any(np.isclose(np.abs(branch - turns), .5, atol=1e-8, rtol=0)):
        raise ValueError("ambiguous phase branch")
    if not np.all(turns == turns[0]):
        raise ValueError("inconsistent phase branch across the evaluation band")
    return (-np.log(np.abs(ratio)) + 1j * (phase + 2 * np.pi * turns[0])) / length_difference


def acquire(model, values, out):
    out.mkdir(parents=True, exist_ok=False)
    built = []
    sim = run_model(model, values, excite="all", sim_path=str(out / "raw"),
                    threads=4, n_freq=201, element_patterns=False, exact=True,
                    before_run=built.append)
    # Use the existing power-wave assembler before bundle decimal rounding.
    a, b = [], []
    for item in built:
        a.append([p.uf_inc / np.sqrt(np.real(p.Z_ref)) for p in item._port_objs])
        b.append([p.uf_ref / np.sqrt(np.real(p.Z_ref)) for p in item._port_objs])
    s = assemble_s(np.asarray(a), np.asarray(b), [1, 2], 2)
    f = np.asarray(sim.results["frequency"])
    np.savez_compressed(out / "data.npz", f=f, s=s, **model.analytical(f, values))
    columns = []
    for pn, (item, run) in enumerate(zip(built, sim.run_stats["port_runs"]), 1):
        signal = np.loadtxt(Path(item.sim_path) / "et")
        columns.append({"port": pn, "dt_s": float(np.diff(signal[:2, 0])[0]),
                        "signal_steps": len(signal), "run": dict(run),
                        "threads": item.run_stats["threads"],
                        "exact_endcriteria": item.run_stats["exact_endcriteria"]})
    report = {"parameters": values, "run": sim.run_stats,
              "protocol": PROTOCOL, "source_ids": source_ids(), "source_columns": columns,
              "model_sha256": hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest(),
              "excitation": sim.excitation["type"], "dt_s": columns[0]["dt_s"],
              "cells": int(np.prod([len(sim.mesh.GetLines(axis)) - 1 for axis in "xyz"])),
              "scope": "Acquisition; energy stopping is not mesh convergence."}
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def analyse(root, meshes):
    rows, previous = [], {}
    for cpw in meshes:
        samples = {}
        for loss in LOSSES:
            pair = []
            for sections in (1, 3):
                path = root / f"m{cpw}-{sections}-{loss}"
                meta = json.loads((path / "report.json").read_text(encoding="utf-8"))
                data = np.load(path / "data.npz")
                pair.append((meta, {k: data[k] for k in data.files}))
            (sm, sd), (lm, ld) = pair
            sp, lp = sm["parameters"], lm["parameters"]
            if (sp["length_sections"], lp["length_sections"]) != (1, 3):
                raise ValueError("the length pair must be 30/90 mm")
            if any(sp[k] != lp[k] for k in sp if k != "length_sections"):
                raise ValueError("the paired models differ beyond length")
            expected = {"cpw": cpw, "mode": "TE10", "eps_r": 2.08, "f_min": 14.5,
                        "f_max": 15.5, "sheet_thickness": .035,
                        "tan_d": .0004 if loss in ("dielectric", "both") else 0,
                        "wall_sigma": 5.8e7 if loss in ("copper", "both", "native_sheet") else 0,
                        "wall_model": "halfspace" if loss in ("copper", "both") else "sheet"}
            if any(sp.get(k) != v for k, v in expected.items()):
                raise ValueError("acquisition parameters do not match this comparison protocol")
            if sm["excitation"] != "gaussian" or lm["excitation"] != "gaussian":
                raise ValueError("use the fixture's narrow-band Gaussian excitation")
            if not np.isclose(sm["dt_s"], lm["dt_s"], rtol=1e-8, atol=0):
                raise ValueError("the two lengths must use the same time step")
            np.testing.assert_array_equal(sd["f"], ld["f"])
            np.testing.assert_array_equal(sd["f"], np.linspace(14.5e9, 15.5e9, 201))
            gamma = propagation(sd["s"][:, 1, 0], ld["s"][:, 1, 0], .06, sd["beta"])
            samples[loss] = (gamma, sd, sm, lm)
        pec = samples["none"][0]
        for loss, (gamma, data, sm, lm) in samples.items():
            energy = all(meta["run"].get("converged") for meta in
                         (sm, lm, samples["none"][2], samples["none"][3]))
            complete = all(sources_completed(meta) for meta in
                           (sm, lm, samples["none"][2], samples["none"][3]))
            # Remove the measured PEC bias of the identical mesh/lengths.
            # Keep the raw bias visible; do not clip a negative attenuation.
            excess = (gamma - pec).real
            target = data["alpha"]
            if loss == "native_sheet":
                target = data["alpha_c"]  # deliberately the one-sided target
            key = (loss, "alpha")
            error = None if loss == "none" else float(np.max(np.abs(excess / target - 1)))
            mesh_error = (None if key not in previous or loss == "none" else
                          float(np.max(np.abs(excess - previous[key]) / target)))
            beta_error = float(np.max(np.abs(pec.imag / data["beta"] - 1)))
            beta_mesh = (None if "beta" not in previous else
                         float(np.max(np.abs(pec.imag - previous["beta"]) / data["beta"])))
            matches = beta_error <= TARGET_BETA_REL and (error is None or error <= TARGET_ALPHA_REL)
            converges = beta_mesh is not None and beta_mesh <= MESH_BETA_REL and (
                loss == "none" or mesh_error is not None and mesh_error <= MESH_ALPHA_REL)
            mid = len(data["f"]) // 2
            rows.append({"cpw": cpw, "loss": loss, "energy_stopped": energy,
                         "source_completed": complete,
                         "cells": [sm["cells"], lm["cells"]], "dt_ps": sm["dt_s"] * 1e12,
                         "alpha_raw_mid": float(gamma.real[mid]),
                         "pec_bias_mid": float(pec.real[mid]),
                         "alpha_excess_mid": float(excess[mid]), "target_mid": float(target[mid]),
                         "target_alpha_rel_max": error, "mesh_alpha_rel_max": mesh_error,
                         "target_beta_rel_max": beta_error, "mesh_beta_rel_max": beta_mesh,
                         "matches": matches, "mesh_pair_passes": converges,
                         "scope": {"none": "PEC TE10 propagation", "dielectric": "weak dielectric loss",
                                   "copper": "one-sided surrogate attenuation only",
                                   "both": "combined dielectric and surrogate attenuation only",
                                   "native_sheet": "native sheet diagnostic"}[loss]})
            previous[key] = excess
        previous["beta"] = pec.imag
    # A pair passing alone is not enough: require two consecutive pairs.
    for loss in LOSSES:
        items = [r for r in rows if r["loss"] == loss]
        for i, row in enumerate(items):
            row["validated_scope"] = bool(i >= 2 and loss != "native_sheet" and
                all(r["energy_stopped"] and r["source_completed"] for r in items[i-2:i+1]) and
                row["matches"] and items[i-1]["matches"] and
                row["mesh_pair_passes"] and items[i-1]["mesh_pair_passes"])
    (root / "comparison.json").write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--meshes", default="20,30,40")
    parser.add_argument("--analyse-only", action="store_true")
    parser.add_argument("--end-criteria-db", type=float, choices=(-70., -80., -90.), default=-70.,
                        help="opt-in stricter energy stop; source completion is checked separately")
    args = parser.parse_args()
    meshes = [int(v) for v in args.meshes.split(",")]
    if len(meshes) < 3 or meshes != sorted(set(meshes)) or not all(10 <= v <= 100 for v in meshes):
        parser.error("use at least three increasing distinct mesh levels in 10..100")
    if not args.analyse_only:
        model = load_model(MODEL_PATH)
        default = resolve_params(model.PARAMS, {})
        for cpw in meshes:
            for loss in LOSSES:
                for sections in (1, 3):
                    values = default | {"cpw": cpw, "length_sections": sections,
                        "end_criteria_db": args.end_criteria_db,
                        "tan_d": .0004 if loss in ("dielectric", "both") else 0,
                        "wall_sigma": 5.8e7 if loss in ("copper", "both", "native_sheet") else 0,
                        "wall_model": "halfspace" if loss in ("copper", "both") else "sheet"}
                    acquire(model, values, args.out / f"m{cpw}-{sections}-{loss}")
    print(json.dumps(analyse(args.out, meshes), indent=2))


if __name__ == "__main__":
    main()
