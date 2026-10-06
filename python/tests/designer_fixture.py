"""The shared designer cases (fixtures/designer_parity.json), for the Python tests and for
scripts/check-designer.mjs (which compares src/designer/expr.ts and checks.ts with them)."""

import copy
import json
import re
from pathlib import Path

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "designer_parity.json"


def load() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _tokens(path: str):
    for name, index in re.findall(r"([A-Za-z_]\w*)|\[(\d+)\]", path):
        yield name if name else int(index)


def set_path(obj, path: str, value):
    """Set ``obj`` at a JSON path like ``parts[2].primitives[0].start[0]``."""
    toks = list(_tokens(path))
    for t in toks[:-1]:
        obj = obj[t]
    obj[toks[-1]] = copy.deepcopy(value)


def case_design(case: dict) -> dict:
    from fairbeam.design import blank_design

    d = blank_design("case", "Case")
    for path, value in (case.get("set") or {}).items():
        set_path(d, path, value)
    for key, item in (case.get("append") or {}).items():
        d[key].append(copy.deepcopy(item))
    return d


def number_results(entry: dict) -> dict:
    """A 'numbers' entry through evaluate() and as a parameter default (check_design)."""
    from fairbeam.design import DesignError, blank_design, check_design, evaluate

    x = float(entry["number"])
    out = {}
    try:
        out["value"] = evaluate(x, {})
    except DesignError as e:
        out["error"] = e.detail
    d = blank_design("case", "Case")
    d["params"].append({"key": "q", "default": x})
    try:
        check_design(d)
    except DesignError as e:
        out["default_error"] = f"{e.where}: {e.detail}"
    return out


def param_results(entry: dict) -> dict:
    """A 'params' entry: the refused key (check_design), else every key's value or error in order
    (as paramValues in src/designer/expr.ts) and what resolve_names() gives or where it stops."""
    from fairbeam.design import DesignError, blank_design, check_design, evaluate, resolve_names

    d = blank_design("case", "Case")
    d["params"] = copy.deepcopy(entry["params"])
    try:
        check_design(d)
    except DesignError as e:
        return {"key_error": e.where}
    values, errors = {}, []
    for p in d["params"]:
        try:
            values[p["key"]] = evaluate(p["expr"], values) if "expr" in p else evaluate(p["default"], {})
        except DesignError:
            errors.append(p["key"])
    out = {"values": values, "errors": errors}
    try:
        out["resolved"] = resolve_names(d, {})
    except DesignError as e:
        out["resolve_error"] = e.where
    return out


def key(check: dict) -> str:
    return f"{check['severity']}|{check['code']}|{check['path']}"


if __name__ == "__main__":
    # for scripts/check-designer.mjs: every case's design and its Python checks, and the evaluator's
    # results. design.py and design_checks.py need only the standard library: load them without the
    # package's __init__ (which imports CSXCAD), so this also runs where openEMS is not installed.
    import sys
    import types

    if "fairbeam" not in sys.modules:
        pkg = types.ModuleType("fairbeam")
        pkg.__path__ = [str(Path(__file__).resolve().parents[1] / "fairbeam")]
        sys.modules["fairbeam"] = pkg

    from fairbeam.design import (DesignError, disc_segments, evaluate, prim_bbox, resolve_names, resolve_parts, wg_cutoff_ghz,
                                 wg_mode)
    from fairbeam.design_checks import CHEAP, lint

    fx = load()
    out = {"cheap": sorted(CHEAP), "cases": [], "expressions": []}
    for c in fx["cases"]:
        d = case_design(c)
        out["cases"].append({"name": c["name"], "design": d, "checks": lint(d)})
    out["geometry"] = []
    for g in fx.get("geometry", []):
        d = case_design(g)
        parts = resolve_parts(d, resolve_names(d, {}))
        names = resolve_names(d, {})
        wgs = []
        for po in d.get("ports", []):
            if po.get("type") == "waveguide":
                m, n = wg_mode(po.get("mode", "TE10"))
                a, b = evaluate(po["a"], names), evaluate(po["b"], names)
                wgs.append({"number": po["number"], "mode": f"TE{m}{n}", "a": a, "b": b, "f_cutoff_ghz": wg_cutoff_ghz(m, n, a, b)})
        groups = [{"number": po["number"], "group": {**po["group"], "members": [
            {**member, "start": [evaluate(x, names) for x in member["start"]],
             "stop": [evaluate(x, names) for x in member["stop"]], "polarity": member.get("polarity", 1)}
            for member in po["group"]["members"]]}} for po in d["ports"] if "group" in po]
        out["geometry"].append({"name": g["name"], "design": d, "waveguides": wgs, "groups": groups, "parts": [
            {"name": p["name"], "prims": [{**{k: v for k, v in q.items() if k != "material"}, "bbox": prim_bbox(q)} for q in p["prims"]]}
            for p in parts]})
    for e in fx["expressions"]:
        try:
            out["expressions"].append({"value": evaluate(e["expr"], fx["names"])})
        except DesignError as err:
            out["expressions"].append({"error": err.detail})
    out["discs"] = [{"radius": r, "segments": disc_segments(r)} for r in (1e-9, 0.01, 0.5, 2, 5, 12.7, 30, 80, 150, 400, 5000)]
    out["numbers"] = [number_results(n) for n in fx.get("numbers", [])]
    out["params"] = [param_results(p) for p in fx.get("params", [])]
    import keyword
    out["keywords"] = sorted(keyword.kwlist)
    json.dump(out, sys.stdout)
