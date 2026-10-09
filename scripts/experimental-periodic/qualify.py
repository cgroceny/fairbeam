"""Run the complete bounded research gate, preserving every input and result."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

import numpy as np

from engine import check_capabilities
from negative_guards import run_guards


def delta(a, b):
    with np.load(a / "complex.npz") as x, np.load(b / "complex.npz") as y:
        if not np.array_equal(x["frequency_hz"], y["frequency_hz"]):
            raise ValueError("Frequency grids must match")
        if any(not np.isfinite(z[k]).all() for z in (x, y) for k in ("s11", "s21")):
            raise ValueError("Nonfinite complex results cannot pass a comparison")
        return float(max(np.max(abs(x[k] - y[k])) for k in ("s11", "s21")))


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def summarize(folders, guards):
    criteria = read(Path(__file__).with_name("study-contract.json"))["criteria"]
    slabs, trans, pec, base = (folders[k] for k in ("uniform", "uniform-translation", "pec", "baseline"))
    levels = (20, 30, 40)
    rows = [read(slabs / f"slab-{c}" / "summary.json") for c in levels]
    metal = [read(pec / f"pec-{c}" / "summary.json") for c in levels]
    changes = [delta(slabs / f"slab-{a}", slabs / f"slab-{b}") for a, b in ((20, 30), (30, 40))]
    shifts = [delta(trans / f"inclusion-{c}-shift0", trans / f"inclusion-{c}-shift5.33333") for c in levels]
    metal_trans = folders["metal-translation"]
    metal_shifts = [delta(metal_trans / f"metal-{c}-shift0", metal_trans / f"metal-{c}-shift5.33333") for c in levels]
    raw_max, count = 0., 0
    for role in ("reference", "sample"):
        files = list((base / "candidate" / role).glob("avg_*"))
        if not files:
            raise ValueError("Baseline probes are missing")
        for file in files:
            a, b = np.loadtxt(file, comments="%"), np.loadtxt(base / "baseline" / role / file.name, comments="%")
            if a.shape != b.shape:
                raise ValueError("Baseline time grids differ")
            if not (np.isfinite(a).all() and np.isfinite(b).all()):
                raise ValueError("Nonfinite raw probes cannot pass baseline comparison")
            raw_max = max(raw_max, float(np.max(abs(a - b))))
            count += 1
    all_rows = [r for folder in folders.values() for r in read(folder / "summary.json")]
    gates = {
        "slab_analytic": all(r["analytic_max_complex_error"] <= criteria["max_complex_s_error_analytic"] for r in rows),
        "slab_two_refinements": all(d <= criteria["max_complex_s_change_each_of_two_refinements"] for d in changes),
        "translation_including_box_face_ties": all(d <= criteria["translation_max_complex_s_change"] for d in shifts),
        "pec_pattern_translation": all(d <= criteria["translation_max_complex_s_change"] for d in metal_shifts),
        "independent_empty_reference": all(r["empty_reference_max_reflection"] <= criteria["empty_reflection"] for r in rows + metal),
        "pec_sheet_analytic": all(r["analytic_max_complex_error"] <= criteria["max_complex_s_error_analytic"] for r in metal),
        "co_polar_power_upper_bound": all(r["power_max"] <= 1 + criteria["passivity_power_excess"] for r in all_rows),
        "energy_stop": all(r["energy_converged"] for r in all_rows),
        "ordinary_boundary_raw_probes_unchanged": raw_max == 0 and count > 0,
        "unsupported_inputs_rejected": bool(guards) and all(r["pass"] for r in guards.values()),
    }
    return {"status": "research gates passed" if all(gates.values()) else "research gate failed",
            "gates": gates, "slabs": rows, "pec_sheet": metal,
            "slab_refinement_max_complex_delta": changes, "translation_max_complex_delta": shifts,
            "pec_pattern_translation_max_complex_delta": metal_shifts,
            "ordinary_boundary_raw_max_delta": raw_max, "ordinary_boundary_probe_files": count,
            "guards": guards, "evidence": {k: str(v) for k, v in folders.items()},
            "limitations": ["Zero phase, normal incidence, co-polar fundamental amplitudes only.",
                            "No oblique/Bloch/Floquet modal ports, dispersion, GPU or general-shape support.",
                            "Structured cells still need independent full-wave validation; no production qualification.",
                            "Energy termination and mesh convergence are separate gates; co-polar power is not full multimode passivity."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="New, nonexistent output directory")
    args = parser.parse_args()
    check_capabilities(args.candidate)
    if not args.baseline.is_file():
        parser.error("--baseline must be an unmodified same-commit native executable")
    if args.candidate.resolve() == args.baseline.resolve():
        parser.error("The baseline and candidate must be separate builds")
    args.output.mkdir(parents=True, exist_ok=False)
    folders = {}
    for suite in ("uniform", "uniform-translation", "pec", "metal-translation", "baseline"):
        command = [sys.executable, str(Path(__file__).with_name("validate.py")), "--candidate", str(args.candidate.resolve()),
                   "--baseline", str(args.baseline.resolve()), "--output", str(args.output.resolve()), "--suite", suite]
        with (args.output / f"{suite}.log").open("w", encoding="utf-8") as log:
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
        folders[suite] = next(p for p in args.output.glob(f"runs-{suite}-*") if (p / "summary.json").exists()
                              and p.name[len(f"runs-{suite}-"):].startswith("20"))
        print(f"Completed {suite}", flush=True)
    guards = run_guards(args.candidate.resolve(), folders["uniform"] / "slab-30/sample/model.xml", args.output / "guards")
    summary = summarize(folders, guards)
    (args.output / "qualification.json").write_text(json.dumps(summary, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps(summary["gates"], indent=2))
    return 0 if all(summary["gates"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
