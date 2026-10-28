"""Saved requirement masks, without native solver imports.

The schema, sampled metric conventions and refusal codes match src/lib/requirements.ts.
Energy and mesh qualification are separate from satisfying a numeric objective. The caller
verifies immutable source/study membership; a current editor document is not a run snapshot.
"""
from __future__ import annotations

import copy
import math

# Keep design-format admission stdlib-only. Numerical evaluation lazily reuses optimize;
# these JSON grammar rules are checked against make_goal and the TypeScript mirror.
GOAL_KINDS = ("f0", "s11_max", "bw_min", "dmax_min", "sij_max", "sij_min", "match_all", "realized_gain_min", "efficiency_min")
BAND_GOALS = ("s11_max", "sij_max", "sij_min", "match_all")
FREQ_GOALS = BAND_GOALS + ("dmax_min", "realized_gain_min", "efficiency_min")
PAIR_GOALS = ("sij_max", "sij_min")

REQUIREMENTS_SCHEMA = "fairbeam.requirements/1"
REQUIREMENT_LIMIT = 64
F0_TOLERANCE_PCT = 0.25


def requirement_source_id(source_bytes, resolved_parameters):
    """Identity of exact saved input bytes + resolved run parameters; not a file name or mask ID."""
    import hashlib
    import json
    if not isinstance(source_bytes, bytes) or not 0 < len(source_bytes) <= 16 * 1024 * 1024:
        raise ValueError("requirements-source-input")
    if (not isinstance(resolved_parameters, dict) or len(resolved_parameters) > 1024 or
            any(not isinstance(k, str) or not 0 < len(k) <= 256 or
                not (v is None or isinstance(v, bool) or _number(v) or isinstance(v, str) and len(v) <= 4096)
                for k, v in resolved_parameters.items())):
        raise ValueError("requirements-source-parameters")
    identity = {"input_sha256": hashlib.sha256(source_bytes).hexdigest(), "resolved_parameters": resolved_parameters}
    return hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":"),
                                      ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()


def attach_requirements(bundle, source_bytes, *, source_id, resolved_parameters):
    """Bind an original Designer run to its immutable saved document, before writing the result.

    The producer must verify its saved bytes did not change during build/run. Reprocessed results
    retain this original snapshot; they must never bind masks from a later editor document.
    No numerical evaluation or mesh certification is performed by this source-only helper.
    """
    import hashlib
    import json
    expected = requirement_source_id(source_bytes, resolved_parameters)
    if source_id != expected:
        raise ValueError("requirements-source-mismatch")
    document = json.loads(source_bytes.decode("utf-8-sig"))
    if not isinstance(document, dict) or document.get("schema") not in ("fairbeam.design/1", "antenlab.design/1"):
        raise ValueError("requirements-source-design")
    if not isinstance(bundle, dict):
        raise ValueError("requirements-source-bundle")
    digest = hashlib.sha256(source_bytes).hexdigest()
    out = dict(bundle)
    out.pop("requirements_snapshot", None)
    out["requirements_source"] = {"schema": "fairbeam.requirement-source/1", "source_id": expected,
                                  "input_sha256": digest, "resolved_parameters": copy.deepcopy(resolved_parameters)}
    if "requirements" in document:
        parsed = validate_requirements(document["requirements"])
        if not parsed["ok"]:
            raise ValueError(parsed["reason"])
        out["requirements_snapshot"] = {"schema": "fairbeam.requirement-snapshot/1", "source_id": expected,
                                        "input_sha256": digest, "requirements": parsed["value"]}
    return out


def evaluate_saved_requirements(bundle):
    """Re-evaluate the stored snapshot only. Stored/caller-authored verdicts are never trusted."""
    b = _obj(bundle)
    source, snapshot = _obj(b.get("requirements_source")), _obj(b.get("requirements_snapshot"))
    import re
    identity = source.get("source_id")
    valid = (source.get("schema") == "fairbeam.requirement-source/1" and isinstance(identity, str) and
             re.fullmatch(r"[0-9a-f]{64}", identity) is not None and
             isinstance(source.get("input_sha256"), str) and re.fullmatch(r"[0-9a-f]{64}", source["input_sha256"]) is not None and
             snapshot.get("schema") == "fairbeam.requirement-snapshot/1" and
             snapshot.get("input_sha256") == source["input_sha256"])
    context = {"sourceId": identity, "snapshotSourceId": snapshot.get("source_id")} if valid else {}
    evaluation = evaluate_requirements(snapshot.get("requirements"), b, context)
    if "requirements_snapshot" not in b:
        evaluation["reason"] = "no-snapshot"
    return evaluation


def _obj(v):
    return v if isinstance(v, dict) else {}


def _list(v):
    return v if isinstance(v, list) else []


def _number(v):
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        return False
    try:
        return math.isfinite(v)
    except OverflowError:
        return False


def _id(v):
    return _number(v) and int(v) == v and 0 < v <= 9007199254740991


def _text(v):
    return isinstance(v, str) and bool(v.strip()) and len(v) <= 256


def _vector(v, n=None):
    return isinstance(v, list) and (n is None or len(v) == n) and all(_number(x) for x in v)


def _ids(v):
    return isinstance(v, list) and 0 < len(v) <= 64 and all(_id(x) for x in v) and len(set(v)) == len(v)


def _db(v):
    return 20 * math.log10(max(v, 1e-9))  # optimizer numeric floor, not dynamic-range evidence


def validate_requirements(value):
    """Validate without numeric coercion, ignored fields or silently dropped port selectors."""
    import re
    s = _obj(value)
    if (set(s) - {"schema", "items"} or s.get("schema") != REQUIREMENTS_SCHEMA or
            not isinstance(s.get("items"), list) or len(s["items"]) > REQUIREMENT_LIMIT):
        return {"ok": False, "reason": "requirements-schema"}
    seen = set()
    for raw in s["items"]:
        r = _obj(raw)
        g = _obj(r.get("goal"))
        k, target = g.get("kind"), g.get("target")
        if (set(r) - {"id", "label", "goal"} or not isinstance(r.get("id"), str) or
                re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", r["id"]) is None or r["id"] in seen or
                ("label" in r and (not isinstance(r["label"], str) or len(r["label"]) > 160))):
            return {"ok": False, "reason": "requirement-id"}
        if (set(g) - {"kind", "target", "at", "at_hi", "weight", "ports"} or k not in GOAL_KINDS or
                not _number(target) or ("weight" in g and (not _number(g["weight"]) or g["weight"] <= 0))):
            return {"ok": False, "reason": "requirement-goal"}
        at, hi, ports = g.get("at"), g.get("at_hi"), g.get("ports")
        if (k in FREQ_GOALS and (not _number(at) or at <= 0 or not math.isfinite(at * 1e9))) or (k not in FREQ_GOALS and at is not None):
            return {"ok": False, "reason": "requirement-frequency"}
        if hi is not None and (k not in BAND_GOALS or not _number(hi) or not math.isfinite(hi * 1e9) or hi <= at):
            return {"ok": False, "reason": "requirement-band"}
        if ((k in PAIR_GOALS and (not isinstance(ports, list) or len(ports) != 2 or not all(_id(p) for p in ports))) or
                (k not in PAIR_GOALS and ports is not None)):
            return {"ok": False, "reason": "requirement-ports"}
        if ((k in ("f0", "bw_min") and target <= 0) or
                (k in ("s11_max", "sij_max", "match_all") and target >= 0) or
                (k == "sij_min" and target > 0) or (k == "efficiency_min" and not 0 < target <= 100)):
            return {"ok": False, "reason": "requirement-target"}
        seen.add(r["id"])
    return {"ok": True, "value": copy.deepcopy(s)}


def requirements_to_goals(value):
    """Lossless numeric grammar conversion; optimizer success is not requirement certification."""
    p = validate_requirements(value)
    if not p["ok"]:
        return p
    return {"ok": True, "goals": [r["goal"] for r in p["value"]["items"]],
            "f0TolerancePct": F0_TOLERANCE_PCT, "qualificationRequired": True,
            "admission": "requirements-stricter-than-optimizer"}


def _spectrum(bundle):
    b = _obj(bundle)
    r = _obj(b.get("results"))
    f = r.get("frequency")
    if (not _vector(f) or not 2 <= len(f) <= 1_000_000 or any(x <= 0 for x in f) or
            any(y <= x for x, y in zip(f, f[1:])) or b.get("port_processing") is not None or r.get("port_processing") is not None):
        return None
    physical = [_obj(p).get("number") for p in _list(b.get("ports"))]
    if not _ids(physical) or len(f)*len(physical) > 2_000_000:
        return None
    excited = [_obj(p)["number"] for p in b["ports"] if _obj(p).get("excite") is True]
    primary = excited[0] if len(excited) == 1 else physical[0] if len(physical) == 1 else None
    if r.get("sparams") is not None:
        sp = _obj(r["sparams"])
        ix = sp.get("ports")
        ns = sp.get("port_numbers", ix)
        if (not _ids(ix) or not _ids(ns) or len(ix) != len(ns) or
                ("port_numbers" in sp and ix != list(range(1, len(ix) + 1))) or
                len(ns) != len(physical) or set(ns) != set(physical) or not _obj(sp.get("s"))):
            return None
        return {"f": f, "numbers": ns, "indices": ix, "entries": sp["s"], "primary": primary, "legacy": False}
    entries = {}
    for p in physical:
        pr = _obj(_obj(r.get("ports")).get(str(int(p))))
        if pr:
            entries[f"{int(p)},{int(p)}"] = {"re": pr.get("s11_re"), "im": pr.get("s11_im")}
    return {"f": f, "numbers": physical, "indices": physical, "entries": entries, "primary": primary, "legacy": True}


def _column(s, i, j):
    if i not in s["numbers"] or j not in s["numbers"]:
        return None
    a, b = s["numbers"].index(i), s["numbers"].index(j)
    key = f'{int(s["indices"][a])},{int(s["indices"][b])}'
    reciprocal = False
    if key not in s["entries"] and a != b:
        key = f'{int(s["indices"][b])},{int(s["indices"][a])}'
        reciprocal = True
    c = _obj(s["entries"].get(key))
    if not _vector(c.get("re"), len(s["f"])) or not _vector(c.get("im"), len(s["f"])):
        return None
    mag = [math.hypot(re, im) for re, im in zip(c["re"], c["im"])]
    return {"magnitude": mag, "reciprocal": reciprocal, "re": c["re"], "im": c["im"]} if all(map(math.isfinite, mag)) else None


def _interp(f, values, at):
    if at < f[0] or at > f[-1]:
        return math.nan
    for k, x in enumerate(f):
        if x >= at:
            return values[k] if k == 0 or x == at else values[k-1] + (values[k]-values[k-1]) * ((at-f[k-1])/(x-f[k-1]))
    return math.nan


def _blank(r, reason):
    k = r["goal"]["kind"]
    unit = "GHz" if k == "f0" else "MHz" if k == "bw_min" else "%" if k == "efficiency_min" else "dBi" if k in ("dmax_min", "realized_gain_min") else "dB"
    return {"id": r["id"], "metric": "unknown", "value": None, "reason": reason, "unit": unit,
            "method": None, "samples": 0, "frequenciesHz": [], "sources": [], "lowerBound": False}


def _finish(r, value, **detail):
    from .optimize import make_goal, goal_cost
    if not _number(value):
        return _blank(r, "invalid-data")
    raw = r["goal"]
    if raw["kind"] == "f0" and not math.isfinite(100 * (value - raw["target"]) / raw["target"]):
        return _blank(r, "invalid-data")
    g = make_goal(raw["kind"], raw["target"], raw.get("at"), raw.get("weight", 1), raw.get("ports"), raw.get("at_hi"))
    # Reuse optimizer comparator (including f0 tolerance); only data admission/extraction differs.
    if g.at_hi is not None:
        metrics = {"band_goals": {g.metric_key(): {"values": [value]}}}
    elif g.kind in ("realized_gain_min", "efficiency_min"):
        metrics = {"radiation_goals": {g.metric_key(): {"value": value}}}
    elif g.kind in ("f0", "bw_min"):
        metrics = {"f0_ghz" if g.kind == "f0" else "bw_mhz": value}
    elif g.kind in ("s11_max", "dmax_min"):
        metrics = {"s11_at" if g.kind == "s11_max" else "dmax_at": {f"{g.at:g}": value}}
    elif g.kind == "match_all":
        metrics = {"match_all_at": {f"{g.at:g}": {"max": value}}}
    else:
        metrics = {"sij_at": {f"{g.ports[0]},{g.ports[1]}@{g.at:g}": value}}
    _, met, admitted = goal_cost(g, metrics, F0_TOLERANCE_PCT)
    if admitted is None:
        # Overflow of the optimizer's *squared cost* is not missing measurement data.
        met = abs(100 * (value-g.target)/g.target) <= F0_TOLERANCE_PCT if g.kind == "f0" else value <= g.target if g.kind in ("s11_max", "sij_max", "match_all") else value >= g.target
    return {**_blank(r, None), "metric": "pass" if met else "fail", "value": value, **detail}


def _s_metric(r, s):
    from .optimize import sampled_band
    g = r["goal"]
    lo, hi = g["at"] * 1e9, (g.get("at_hi") or g["at"]) * 1e9
    if not math.isfinite(lo) or not math.isfinite(hi) or lo < s["f"][0] or hi > s["f"][-1]:
        return _blank(r, "incomplete-band")
    pairs = ([g["ports"]] if g["kind"] in PAIR_GOALS else [[n, n] for n in s["numbers"]] if g["kind"] == "match_all" else
             [[s["primary"], s["primary"]]] if s["primary"] is not None else [])
    if not pairs:
        return _blank(r, "missing-driven-port")
    x = [lo] if lo == hi else [lo, *[f for f in s["f"] if lo < f < hi], hi]
    values, sources = [], []
    for i, j in pairs:
        c = _column(s, i, j)
        if c is None:
            return _blank(r, "missing-or-invalid-trace")
        data = list(map(_db, c["magnitude"])) if g["kind"] == "s11_max" else c["magnitude"]
        # Reuse optimizer band edge and interior sampling; point paths use the same interpolation.
        sampled = [_interp(s["f"], data, lo)] if lo == hi else sampled_band(s["f"], data, lo, hi)
        if sampled is None:
            return _blank(r, "missing-or-invalid-trace")
        values.extend(sampled if g["kind"] == "s11_max" else map(_db, sampled))
        sources.append({"ports": [i, j], "reciprocal": c["reciprocal"]})
    worst = min(values) if g["kind"] == "sij_min" else max(values)
    return _finish(r, worst, method="sampled-db-interpolation" if g["kind"] == "s11_max" else "sampled-magnitude-interpolation",
                   samples=len(values), frequenciesHz=x, sources=sources)


def _resonance_metric(r, b, s):
    primary = s["primary"]
    if primary is None:
        return _blank(r, "missing-driven-port")
    c = _column(s, primary, primary)
    if c is None:
        return _blank(r, "missing-or-invalid-trace")
    if _obj(b.get("results")).get("s11_band_db", -10) != -10:
        return _blank(r, "unsupported-band-threshold")
    # Match study._matched_bands' -300 dB floor when locating the band minimum.
    d = [20*math.log10(max(v, 1e-15)) for v in c["magnitude"]]
    begin = next((i for i, x in enumerate(d) if x < -10), -1)
    detail = {"samples": len(s["f"]), "frequenciesHz": [s["f"][0], s["f"][-1]],
              "sources": [{"ports": [primary, primary], "reciprocal": False}]}
    if begin >= 0:
        end = begin
        while end + 1 < len(d) and d[end+1] < -10:
            end += 1
        peak = min(range(begin, end+1), key=lambda i: d[i])
        lower = begin == 0 or end == len(d)-1
        if r["goal"]["kind"] == "bw_min":
            out = _finish(r, (s["f"][end]-s["f"][begin])/1e6, **detail, method="sampled-minus10db-width", lowerBound=lower)
            if lower and out["metric"] == "fail":
                out.update(metric="unknown", reason="open-band-lower-bound")
            return out
        return _finish(r, s["f"][peak]/1e9, **detail, method="first-matched-band-sampled-minimum")
    if r["goal"]["kind"] == "bw_min":
        return _finish(r, 0, **detail, method="no-sampled-minus10db-band")
    pr = _obj(_obj(_obj(b.get("results")).get("ports")).get(str(int(primary))))
    reactance = None
    if _obj(b.get("reference")).get("phaseKnown") is not False:
        if s["legacy"] and _vector(pr.get("zin_im"), len(s["f"])):
            reactance = pr["zin_im"]
        elif not s["legacy"]:
            z = pr.get("z_ref_f", pr.get("z_ref"))
            refs = [z]*len(s["f"]) if _number(z) else z if _vector(z, len(s["f"])) else None
            if refs and all(x > 0 for x in refs):
                try:
                    x = [2*z*im / ((1-re)**2+im**2) for z, re, im in zip(refs, c["re"], c["im"])]
                    if all(map(math.isfinite, x)):
                        reactance = x
                except (ZeroDivisionError, OverflowError):
                    pass
    if reactance:
        for i in range(len(reactance)-1):
            if reactance[i] < 0 <= reactance[i+1]:
                f = s["f"][i] - reactance[i] * (s["f"][i+1]-s["f"][i]) / (reactance[i+1]-reactance[i])
                return _finish(r, f/1e9, **detail, method="first-upward-reactance-zero")
    k = min(range(len(d)), key=lambda i: c["magnitude"][i])
    return _finish(r, s["f"][k]/1e9, **detail, method="sampled-reflection-minimum")


def _energy(b):
    run = _obj(b.get("run"))
    if (run.get("converged") is False or run.get("hit_timestep_limit") is True or
            any(_obj(p).get("converged") is False for p in _list(run.get("port_runs")))):
        return "not-converged"
    if (run.get("converged") is not True or ("hit_timestep_limit" in run and not isinstance(run["hit_timestep_limit"], bool)) or ("port_runs" in run and not isinstance(run["port_runs"], list)) or
            any(_obj(p).get("converged") is not True for p in _list(run.get("port_runs")))):
        return "unknown"
    res = _obj(b.get("results"))
    qa = _obj(_obj(res.get("sparams")).get("qa"))
    if "passive" in qa and not isinstance(qa["passive"], bool):
        return "unknown"
    if any("qa_warnings" in (ff := _obj(p)) and (not isinstance(ff["qa_warnings"], list) or not all(isinstance(v, str) for v in ff["qa_warnings"])) for p in _list(res.get("farfield"))):
        return "unknown"
    if qa.get("passive") is False:
        return "suspicious"
    for raw in _list(res.get("farfield")):
        ff = _obj(raw)
        if "qa_warnings" in ff and (not isinstance(ff["qa_warnings"], list) or not all(isinstance(v, str) for v in ff["qa_warnings"])):
            return "unknown"
        if _list(ff.get("qa_warnings")) or (_number(ff.get("rad_efficiency")) and ff["rad_efficiency"] > 1.05):
            return "suspicious"
    s = _spectrum(b)
    if s and len(s["numbers"]) > 1:
        sp = _obj(res.get("sparams"))
        stored = [_obj(p).get("port") for p in _list(run.get("port_runs"))]
        expected = ([s["primary"]] if s["primary"] is not None else []) if s["legacy"] else s["numbers"] if sp.get("complete") is True else [s["numbers"][s["indices"].index(p)] for p in sp["excited"]] if _ids(sp.get("excited")) and all(p in s["indices"] for p in sp["excited"]) else []
        if not expected or (len(expected) > 1 and not stored) or (stored and (not _ids(stored) or any(p not in s["numbers"] for p in stored) or any(p not in stored for p in expected))):
            return "unknown"
    if s:
        for p in s["numbers"]:
            c = _column(s, p, p)
            if c and (any(_db(v) > .1 for v in c["magnitude"]) or all(_db(v) >= -.5 for v in c["magnitude"])):
                return "suspicious"
    return "converged"


def _radiation_metric(r, b, s):
    from .optimize import make_goal, radiation_metric
    primary = s["primary"]
    if primary is None:
        return _blank(r, "missing-driven-port")
    g = r["goal"]
    candidates = [ff for raw in _list(_obj(b.get("results")).get("farfield"))
                  if (ff := _obj(raw)) and _number(ff.get("f")) and _id(ff.get("port", primary)) and ff.get("port", primary) == primary and
                  math.isclose(ff["f"]/1e9, g["at"], rel_tol=1e-9, abs_tol=1e-12)]
    if len(candidates) != 1:
        return _blank(r, "missing-exact-field")
    ff = candidates[0]
    if not s["f"][0] <= ff["f"] <= s["f"][-1] or _energy(b) != "converged":
        return _blank(r, "unqualified-field")
    detail = {"method": "stored-frequency-field", "samples": 1, "frequenciesHz": [ff["f"]]}
    if g["kind"] == "dmax_min":
        return _finish(r, ff.get("dmax_dbi"), **detail)
    # The existing optimizer's strict scalar power consistency, convergence and writer-precision
    # admission remain authoritative; the wrapper has already refused malformed grids/port IDs.
    pr = _obj(_obj(_obj(b.get("results")).get("ports")).get(str(int(primary))))
    if g["kind"] == "realized_gain_min" and (not _vector(pr.get("s11_re"), len(s["f"])) or not _vector(pr.get("s11_im"), len(s["f"]))):
        return _blank(r, "unqualified-field-power")
    try:
        # JSON permits 1.0 for integer IDs; normalize that representation, never their mapping.
        native = {**b, "ports": [{**p, "number": int(p["number"])} for p in b["ports"]],
                  "results": {**b["results"], "farfield": [{**ff, "port": int(primary)}]}}
        value = radiation_metric(native, make_goal(g["kind"], g["target"], g["at"]))["value"]
    except (ValueError, TypeError, KeyError, IndexError, OverflowError):
        value = None
    return _finish(r, value, **detail) if _number(value) else _blank(r, "unqualified-field-power")


def evaluate_requirements(value, bundle, context=None):
    p, b, context = validate_requirements(value), _obj(bundle), _obj(context)
    s = _spectrum(b)
    source = context.get("sourceId") if _text(context.get("sourceId")) else None
    bound = source is not None and context.get("snapshotSourceId") == source
    energy, m = _energy(b), _obj(context.get("mesh"))
    mesh = m["status"] if bound and m.get("sourceId") == source and _text(m.get("studyId")) and m.get("status") in ("converged", "not-converged") else "unknown"
    reason = p["reason"] if not p["ok"] else "source-mismatch" if not bound else "invalid-spectrum" if s is None else "no-requirements" if not p["value"]["items"] else "work-limit" if len(s["f"])*len(s["numbers"])*len(p["value"]["items"]) > 2_000_000 else None
    items = []
    if p["ok"]:
        for r in p["value"]["items"]:
            items.append(_blank(r, reason) if reason else _s_metric(r, s) if r["goal"]["kind"] in BAND_GOALS else
                         _resonance_metric(r, b, s) if r["goal"]["kind"] in ("f0", "bw_min") else _radiation_metric(r, b, s))
    metric = "unknown" if not items or any(x["metric"] == "unknown" for x in items) else "fail" if any(x["metric"] == "fail" for x in items) else "pass"
    return {"schema": "fairbeam.requirement-evaluation/1", "sourceId": source, "requirements": p["value"] if p["ok"] else None,
            "status": metric if energy == mesh == "converged" else "unknown", "metric": metric,
            "energy": energy, "mesh": mesh,
            "reason": reason or ("energy-unqualified" if energy != "converged" else "mesh-unqualified" if mesh != "converged" else None), "items": items}


def requirement_segments(value):
    p = validate_requirements(value)
    return [{"id": r["id"], "kind": r["goal"]["kind"], "ports": copy.deepcopy(r["goal"].get("ports")),
             "fromHz": r["goal"]["at"]*1e9, "toHz": (r["goal"].get("at_hi") or r["goal"]["at"])*1e9,
             "valueDb": r["goal"]["target"], "direction": "min" if r["goal"]["kind"] == "sij_min" else "max"}
            for r in p["value"]["items"] if r["goal"]["kind"] in BAND_GOALS] if p["ok"] else []
