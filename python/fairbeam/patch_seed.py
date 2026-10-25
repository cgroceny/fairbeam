"""Small scalar synthesis helpers for Designer expressions (mm, GHz, ohms).

Mirrored by src/designer/patchSeed.ts. Same quasi-static line and slot model as
analytic.py (Balanis sec. 14.2 / Hammerstad); these are estimates, not full-wave
matching or resonance results. The bounded J0 series replaces the reference's
nested quadrature, not its conductance model.
"""
import math
from functools import lru_cache

C0_MM_GHZ = 299.792458


def _positive(*values):
    if any(not math.isfinite(v) or v <= 0 for v in values):
        raise ValueError("synthesis inputs must be finite and positive")


def _z0(eps_r, u):
    ee = (eps_r + 1) / 2 + (eps_r - 1) / 2 / math.sqrt(1 + 12 / u)
    if u < 1:
        ee += (eps_r - 1) / 2 * 0.04 * (1 - u) ** 2
    if u <= 1:
        return 60 / math.sqrt(ee) * math.log(8 / u + u / 4)
    return 120 * math.pi / (math.sqrt(ee) * (u + 1.393 + 0.667 * math.log(u + 1.444)))


@lru_cache(maxsize=64)
def microstrip_width(z0, eps_r, h):
    """Invert the reference quasi-static Z0 model; h and returned width are mm."""
    _positive(z0, eps_r, h)
    if not 1 <= eps_r <= 20:
        raise ValueError("microstrip_width needs 1 <= eps_r <= 20")
    lo, hi = 1e-4, 50.0
    if not _z0(eps_r, hi) <= z0 <= _z0(eps_r, lo):
        raise ValueError("requested impedance is outside the width synthesis range")
    for _ in range(64):
        mid = math.sqrt(lo * hi)
        if _z0(eps_r, mid) > z0:
            lo = mid
        else:
            hi = mid
    result = h * math.sqrt(lo * hi)
    _positive(result)
    if abs(_z0(eps_r, result / h) - z0) > 1e-9 * z0:
        raise ValueError("target impedance falls in the piecewise line model discontinuity")
    return result


def _j0(x):
    # |x| <= pi below. 32 terms make the omitted term < 1e-55 in this domain.
    term = total = 1.0
    for k in range(1, 32):
        term *= -(x * x / 4) / (k * k)
        total += term
    return total


@lru_cache(maxsize=64)
def patch_inset(r_target, length, width, f_ghz):
    """Inset estimate from R(y)=R_edge cos²(pi*y/L); refuses a nonexistent inset.

    Fixed 4001/501-node trapezoids match analytic.patch_edge_resistance. Restrict
    L,W <= lambda/2 to bound the approximation and series work for edited files.
    """
    _positive(r_target, length, width, f_ghz)
    lam = C0_MM_GHZ / f_ghz
    if length > lam / 2 or width > lam / 2:
        raise ValueError("patch_inset needs patch length and width <= wavelength/2")
    k0 = 2 * math.pi / lam
    step = (math.pi - 2e-6) / 4000
    g1 = g12 = 0.0
    for i in range(4001):
        theta = 1e-6 + i * step
        ct, st = math.cos(theta), math.sin(theta)
        # Continuous limit at cos(theta)=0, avoiding division by a tiny number.
        a = k0 * width / 2
        slot = a if abs(ct) < 1e-12 else math.sin(a * ct) / ct
        base = slot * slot * st ** 3
        weight = 0.5 if i in (0, 4000) else 1.0
        g1 += weight * base
        if i % 8 == 0:
            g12 += weight * base * _j0(k0 * length * st)
    conductance = (g1 + 8 * g12) * step / (120 * math.pi ** 2)
    if not math.isfinite(conductance) or conductance <= 0:
        raise ValueError("patch slot conductance is outside the synthesis range")
    edge = 1 / (2 * conductance)
    if r_target >= edge:
        raise ValueError("target resistance must be below the estimated patch edge resistance")
    result = length / math.pi * math.acos(math.sqrt(r_target / edge))
    if not 0 < result < length / 2:
        raise ValueError("inset must be strictly inside the half patch")
    return result
