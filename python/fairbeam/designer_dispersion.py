"""Designer datasheet intent, separate from the fitted solver poles.

The checks use only the standard library. The build delegates calibration and the
passive Lorentz fit to the existing dispersion API; no new solver approximation.
Frequencies in Design inputs are GHz; model and fit records use Hz.
"""
from __future__ import annotations

import copy
import math

MODEL = "djordjevic-sarkar"
MAX_POLES = 32  # resource control, not an accuracy guarantee


def descriptor_problem(material: dict) -> str | None:
    if "dispersion" not in material:
        return None
    d = material["dispersion"]
    if material.get("kind") != "dielectric":
        return "dispersion requires a dielectric"
    if not isinstance(d, dict) or d.get("model") != MODEL:
        return "dispersion model must be djordjevic-sarkar"
    if set(d) - {"model", "m1", "m2", "n_poles"}:
        return "unknown dispersion input"
    for key in ("m1", "m2"):
        if key in d and (isinstance(d[key], bool) or not isinstance(d[key], (int, float, str))):
            return f"{key} must be a number or expression"
    if "n_poles" in d:
        n = d["n_poles"]
        if isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) or int(n) != n or not 1 <= n <= MAX_POLES:
            return "n_poles must be an integer from 1 to 32"
    return None


def _log(f_ghz: float, m1: float, m2: float) -> tuple[float, float]:
    w = 2 * math.pi * f_ghz * 1e9
    w1, w2 = 10.0 ** m1, 10.0 ** m2
    scale = math.log(10) * (m2 - m1)
    return ((math.log(math.hypot(w2, w)) - math.log(math.hypot(w1, w))) / scale,
            (math.atan2(w, w2) - math.atan2(w, w1)) / scale)


def _calibrated_input(material: dict, evaluate) -> tuple[dict, float, float]:
    """Resolve and validate one nonmagnetic datasheet point, without importing numpy."""
    problem = descriptor_problem(material)
    if problem or "dispersion" not in material:
        raise ValueError(problem or "missing dispersion input")
    def number(value):
        if value is None or isinstance(value, bool):
            raise ValueError("dispersion inputs must resolve to finite numbers")
        try:
            value = evaluate(value)
        except (ValueError, TypeError) as error:
            raise ValueError("could not resolve the datasheet expressions") from error
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError("dispersion inputs must resolve to finite numbers")
        return float(value)
    d = material["dispersion"]
    eps, tan = number(material.get("eps_r", 1)), number(material.get("tan_d", 0))
    f = number(material.get("tan_d_freq"))
    mu = number(material.get("mu_r", 1))
    m1, m2 = number(d.get("m1", 4)), number(d.get("m2", 12))
    if eps < 1 or tan < 0 or f <= 0:
        raise ValueError("a datasheet point needs eps_r >= 1, tan_d >= 0 and a positive reference frequency")
    if mu != 1:
        raise ValueError("Djordjevic-Sarkar requires nonmagnetic mu_r = 1")
    try:
        corners = (10.0 ** m1, 10.0 ** m2)
        if m2 <= m1 or any(not math.isfinite(x) or x <= 0 for x in corners):
            raise ValueError()
        real, imag = _log(f, m1, m2)
        delta = -eps * tan / imag if tan else 0.0
        eps_inf = eps - delta * real
        if not math.isfinite(delta) or delta < 0 or not math.isfinite(eps_inf) or eps_inf <= 0:
            raise ValueError()
    except (ValueError, OverflowError, ZeroDivisionError):
        raise ValueError("corners must satisfy m2 > m1 with finite positive frequencies and a passive positive eps_inf calibration") from None
    resolved = {"kind": "dielectric", "eps_r": eps, "tan_d": tan, "tan_d_freq": f,
            "dispersion": {"model": MODEL, "m1": m1, "m2": m2,
                           **({"n_poles": int(d["n_poles"])} if "n_poles" in d else {})}}
    return resolved, eps_inf, delta


def resolved_input(material: dict, evaluate=lambda x: x) -> dict:
    return _calibrated_input(material, evaluate)[0]


def static_permittivity_bound(material: dict, evaluate=lambda x: x) -> float:
    """Passive DS real-permittivity upper bound for the thin-metal heuristic.

    Re(log((w2+jw)/(w1+jw))) decreases from log(w2/w1) to zero
    for w >= 0 and w2 > w1. Thus eps_inf <= Re(eps) <= eps_inf+delta.
    This stdlib single-point calibration mirrors, and is tested against, the
    canonical numpy from_datasheet path; it does not bound fitted-pole errors.
    """
    _, eps_inf, delta = _calibrated_input(material, evaluate)
    return eps_inf + delta


def add_wideband_material(sim, name: str, material: dict, *, intent: dict | None = None, **display):
    """Fit to *this* simulation band and retain input intent beside the actual fit report."""
    from dataclasses import replace
    from .dispersion import DjordjevicSarkar
    resolved = resolved_input(material)
    d = resolved["dispersion"]
    model = DjordjevicSarkar.from_datasheet([(resolved["tan_d_freq"] * 1e9, resolved["eps_r"], resolved["tan_d"])], m1=d["m1"], m2=d["m2"])
    prop = sim.dispersive(name, model, n_poles=d.get("n_poles"), **display)
    fitted = sim.dispersions[name]
    source = {**(fitted.source or {}), "designer_material": {
        "input": copy.deepcopy(intent if intent is not None else material), "resolved": resolved}}
    fitted = replace(fitted, source=source)
    sim.dispersions[name] = fitted
    sim.materials[name]["dispersion"] = fitted.to_dict()
    return prop


def captured_material(dispersion: dict) -> dict:
    """Recover only an explicitly recorded Designer model; never flatten unknown poles."""
    try:
        source = dispersion["source"]
        if dispersion["model"] not in ("lorentz", "constant") or source["model"] != MODEL:
            raise ValueError("unrecognized fitted model")
        for key in ("f_min", "f_max"):
            if source["fit"][key] != source["report"][key]:
                raise ValueError("inconsistent fitted band")
        return resolved_input(source["designer_material"]["resolved"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("this dispersive material has no supported Designer datasheet intent") from error
