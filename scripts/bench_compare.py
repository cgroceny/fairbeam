#!/usr/bin/env python3
"""Compare benchmark bundles of one machine with the committed reference bundles (docs/BENCHMARKS.md).

Bundles are paired by file name. For each model it prints the grid (cells), the stopping timestep(s),
the solver and wall times of every run set, |S11| minimum and its frequency (port 1), Dmax and
radiation efficiency at each far-field frequency, and the differences to the reference. Multi-port
models also get the largest |S_ij| difference in dB over the band.

    python scripts/bench_compare.py --run t4=<dir> --run all=<dir> [--ref public/projects]
                                    [--json out.json] [--markdown]

The first --run is compared with the reference; the others only add their times. Standard library
only.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def load(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def db(re: float, im: float) -> float:
    return 20 * math.log10(max(math.hypot(re, im), 1e-12))


def times(b: dict) -> dict:
    """Solver time summed over all port runs, the total wall time, engine, threads, timesteps."""
    r = b.get("run") or {}
    runs = r.get("port_runs") or []
    solver = sum(p.get("solver_time_s") or 0 for p in runs) if runs else r.get("solver_time_s")
    return {
        "engine": r.get("engine") or "cpu",
        "threads": r.get("threads"),
        "cpu": (r.get("host") or {}).get("cpu"),
        "solver_s": round(solver, 3) if solver is not None else None,
        "wall_s": r.get("wall_time_total_s") or r.get("wall_time_s"),
        "mcells_s": r.get("speed_mcells_s"),
        "timesteps": [p.get("timesteps") for p in runs] if runs else [r.get("timesteps")],
        "runs": max(1, len(runs)),
    }


def cells(b: dict) -> int | None:
    g = (b.get("run") or {}).get("grid")
    return g[0] * g[1] * g[2] if g else None


def s11_min(b: dict) -> tuple[float, float] | None:
    res = b.get("results") or {}
    f, p = res.get("frequency"), (res.get("ports") or {}).get("1")
    if not f or not p:
        return None
    vals = [db(a, c) for a, c in zip(p["s11_re"], p["s11_im"])]
    i = min(range(len(vals)), key=vals.__getitem__)
    return round(vals[i], 3), round(f[i] / 1e9, 4)


def farfield(b: dict) -> list[dict]:
    return [{"f_ghz": round(x["f"] / 1e9, 4), "dmax_dbi": x.get("dmax_dbi"), "eff": x.get("rad_efficiency")}
            for x in (b.get("results") or {}).get("farfield") or []]


def max_dsij(a: dict, b: dict, floor_db: float = -30.0) -> dict | None:
    """Largest |S_ij| difference in dB over the band: over all points, and where either value is above
    `floor_db` (a deep null moving by a few dB says little)."""
    sa, sb = (a.get("results") or {}).get("sparams"), (b.get("results") or {}).get("sparams")
    f = (a.get("results") or {}).get("frequency")
    if not sa or not sb or len(sa["s"]) < 2:
        return None
    worst = {"all": (0.0, None, None), "above": (0.0, None, None)}
    for key, va in sa["s"].items():
        vb = sb["s"].get(key)
        if not vb or len(vb["re"]) != len(va["re"]):
            continue
        for k in range(len(va["re"])):
            x, y = db(va["re"][k], va["im"][k]), db(vb["re"][k], vb["im"][k])
            d = abs(x - y)
            if d > worst["all"][0]:
                worst["all"] = (d, key, f[k] / 1e9)
            if max(x, y) > floor_db and d > worst["above"][0]:
                worst["above"] = (d, key, f[k] / 1e9)
    return {name: {"db": round(d, 3), "sij": key, "f_ghz": round(fr, 4) if fr else None} for name, (d, key, fr) in worst.items()}


def compare(ref: dict, win: dict) -> dict:
    out: dict = {}
    sr, sw = s11_min(ref), s11_min(win)
    if sr and sw:
        out["ds11_min_db"] = round(sw[0] - sr[0], 3)
        out["df_s11_mhz"] = round((sw[1] - sr[1]) * 1e3, 2)
    fr, fw = farfield(ref), farfield(win)
    out["ddmax_db"] = [round(w["dmax_dbi"] - r["dmax_dbi"], 3) for r, w in zip(fr, fw)
                       if r["dmax_dbi"] is not None and w["dmax_dbi"] is not None]
    out["deff"] = [round(w["eff"] - r["eff"], 4) for r, w in zip(fr, fw) if r["eff"] is not None and w["eff"] is not None]
    out["dsij"] = max_dsij(ref, win)
    out["same_grid"] = (ref.get("run") or {}).get("grid") == (win.get("run") or {}).get("grid")
    out["same_timesteps"] = times(ref)["timesteps"] == times(win)["timesteps"]
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--run", action="append", required=True, metavar="LABEL=DIR", help="a set of bundles; the first is compared")
    ap.add_argument("--ref", default=str(REPO / "public" / "projects"), help="reference bundles (default: the committed ones)")
    ap.add_argument("--json", help="write every number to this file")
    ap.add_argument("--markdown", action="store_true", help="print a Markdown table")
    a = ap.parse_args()
    sets = [(s.split("=", 1)[0], Path(s.split("=", 1)[1])) for s in a.run]
    ref_dir = Path(a.ref)
    first_label, first_dir = sets[0]
    rows = []
    for wb in sorted(first_dir.glob("*.json")):
        if wb.name == "index.json":
            continue
        win, ref = load(wb), load(ref_dir / wb.name)
        if win is None:
            continue
        row = {"bundle": wb.stem, "name": win.get("name"), "cells": cells(win), "grid": (win.get("run") or {}).get("grid"),
               "s11_min": s11_min(win), "farfield": farfield(win), "runs": {}}
        for label, d in sets:
            b = load(d / wb.name)
            if b is not None:
                row["runs"][label] = times(b)
        if ref is not None:
            row["ref"] = {"cells": cells(ref), "grid": (ref.get("run") or {}).get("grid"), "s11_min": s11_min(ref),
                          "farfield": farfield(ref), **times(ref)}
            row["diff"] = compare(ref, win)
        rows.append(row)

    if a.json:
        try:
            ref_name = ref_dir.resolve().relative_to(REPO).as_posix()
        except ValueError:
            ref_name = str(ref_dir)
        Path(a.json).write_text(json.dumps({"compared": first_label, "ref": ref_name, "models": rows}, indent=1) + "\n",
                                encoding="utf-8", newline="\n")
    labels = [label for label, _ in sets]
    if a.markdown:
        head = ["model", "cells", "timesteps (ref → this)"] + [f"solver {l} (s)" for l in labels] + \
               ["solver ref (s)", "ref engine", "Δ|S11|min (dB)", "Δf (MHz)", "ΔDmax (dB)", "Δeff", "max Δ|Sij| (dB)"]
        print("| " + " | ".join(head) + " |")
        print("|" + "---|" * len(head))
        for r in rows:
            ref, d = r.get("ref") or {}, r.get("diff") or {}
            ts_this = r["runs"].get(first_label, {}).get("timesteps")
            ts = f"{','.join(map(str, ref.get('timesteps') or []))} → {','.join(map(str, ts_this or []))}"
            if d.get("same_timesteps"):
                ts = f"{','.join(map(str, ts_this or []))} (same)"
            dsij = d.get("dsij")
            cols = [r["bundle"], f"{r['cells']:,}" + ("" if d.get("same_grid", True) else " (grid differs)"), ts]
            cols += [str(r["runs"].get(l, {}).get("solver_s", "–")) for l in labels]
            cols += [str(ref.get("solver_s", "–")), f"{ref.get('engine', '–')}/{ref.get('threads', '–')}",
                     str(d.get("ds11_min_db", "–")), str(d.get("df_s11_mhz", "–")),
                     ", ".join(map(str, d.get("ddmax_db") or [])) or "–", ", ".join(map(str, d.get("deff") or [])) or "–",
                     f"{dsij['above']['db']} ({dsij['above']['sij']}; all: {dsij['all']['db']})" if dsij else "–"]
            print("| " + " | ".join(cols) + " |")
    else:
        for r in rows:
            ref, d = r.get("ref") or {}, r.get("diff") or {}
            t = "  ".join(f"{l} {r['runs'][l]['solver_s']} s/{r['runs'][l]['wall_s']} s" for l in labels if l in r["runs"])
            print(f"{r['bundle']:<38} cells {r['cells']:>9,}  {t}  ref {ref.get('solver_s')} s ({ref.get('engine')}/{ref.get('threads')})")
            print(f"{'':<38} timesteps {r['runs'][first_label]['timesteps']} vs ref {ref.get('timesteps')}  "
                  f"S11 {r['s11_min']} vs {ref.get('s11_min')}  diff {json.dumps({k: v for k, v in d.items() if k not in ('same_grid',)})}")


if __name__ == "__main__":
    main()
