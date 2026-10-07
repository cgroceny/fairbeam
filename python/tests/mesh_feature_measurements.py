"""Geometric mesh measurements; no field solution or convergence claim."""

from pathlib import Path

import numpy as np

from fairbeam.model import load_model, resolve_params

FIXTURE = Path(__file__).parent / "fixtures" / "blade_fine_features.design.json"


def build_blade():
    model = load_model(FIXTURE)
    return model.build(resolve_params(model.PARAMS, {}))


def _max_cell(lines, lo, hi):
    lengths = np.diff(lines)
    overlapping = (lines[:-1] < hi - 1e-9) & (lines[1:] > lo + 1e-9)
    return float(max(lengths[overlapping]))


def blade_measurements(sim):
    """Cells across use feature width / largest intersecting cell, including partial cells.

    Strip resolution projects the local x/z cell diagonal onto the strip normal.
    Strip connectivity connects grid nodes when their intervening electric-edge midpoint
    lies inside the rectangle. This is a geometric staircase check, not an openEMS run.
    """
    x, _, z = [np.asarray(sim.mesh.GetLines(a)) for a in range(3)]
    normal = np.array([2, -1]) / np.sqrt(5)
    tangent = np.array([1, 2]) / np.sqrt(5)
    start = np.array([-20, 20])
    length = np.sqrt(25**2 + 50**2)
    worst = 0.0
    for t in np.linspace(0.01, 0.99, 501):
        p = start + tangent * length * t
        i, k = np.searchsorted(x, p[0]) - 1, np.searchsorted(z, p[1]) - 1
        worst = max(worst, abs(normal[0]) * (x[i+1] - x[i]) + abs(normal[1]) * (z[k+1] - z[k]))
    xi = np.flatnonzero((x >= -21) & (x <= 6))
    zi = np.flatnonzero((z >= 19) & (z <= 71))
    parent = {}

    def find(node):
        parent.setdefault(node, node)
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def inside(px, pz):
        offset = np.array([px, pz]) - start
        along = float(offset @ tangent)
        return -1e-8 <= along <= length + 1e-8 and abs(float(offset @ normal)) <= 0.2 + 1e-8

    for i in xi[:-1]:
        for k in zi[:-1]:
            for end, midpoint in [((i+1, k), ((x[i]+x[i+1])/2, z[k])),
                                  ((i, k+1), (x[i], (z[k]+z[k+1])/2))]:
                if inside(*midpoint):
                    parent[find((i, k))] = find(end)
    components = len({find(node) for node in list(parent)})
    r = sim.mesh_report
    return {"cells": r["cells"], "total_cells": r["total_cells"], "min_cell_mm": r["min_cell"],
            "max_neighbour_ratio": r["max_neighbour_ratio"],
            "notch_cells_across": [round(1 / _max_cell(z, low, low + 1), 5) for low in [30, 45, 60]],
            "feed_cells_across": round(1.35 / _max_cell(z, 0, 1.35), 5),
            "strip_cells_across": round(0.4 / worst, 5), "strip_midpoint_components": components}


def example_measurements():
    """Rebuild automatic meshes for each baseline example, including manual-only sources."""
    import json
    root = Path(__file__).resolve().parents[2]
    baseline = json.loads((FIXTURE.parent / "automesh_fine_features_before.json").read_text())
    rows = {}
    for name, old in baseline["examples"].items():
        module = load_model(root / old["source"])
        sim = module.build(resolve_params(module.PARAMS, old["overrides"]))
        if old["mode"] == "automatic from geometry at defaults":
            sim.auto_mesh(keep_existing=False)
        report = sim.mesh_report
        rows[name] = {key: report[key] for key in ("cells", "total_cells", "min_cell", "max_neighbour_ratio")}
        if "fine_feature_refinement" in report:
            rows[name]["fine_feature_refinement"] = report["fine_feature_refinement"]
    return rows


if __name__ == "__main__":
    import argparse
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--examples", action="store_true", help="Also measure every bundled example")
    parser.add_argument("--reference-revision", help="Read the original mesher from a local Git revision")
    args = parser.parse_args()
    if args.reference_revision:
        import subprocess
        import sys
        import types
        import fairbeam
        source = subprocess.check_output(
            ["git", "show", f"{args.reference_revision}:python/fairbeam/automesh.py"], text=True)
        reference = types.ModuleType("fairbeam.automesh")
        reference.__package__ = "fairbeam"
        sys.modules["fairbeam.automesh"] = reference
        exec(compile(source, "<reference automesh>", "exec"), reference.__dict__)
        fairbeam.automesh = reference
    measured = {"blade": blade_measurements(build_blade())}
    if args.examples:
        measured["examples"] = example_measurements()
    print(json.dumps(measured, indent=2))
