"""Array patterns from embedded element patterns (docs/ARRAYS.md).

A multi-port antenna run (``fairbeam run --excite all``) stores one complex far-field pattern per
excited port in ``results.element_patterns``: the field radiated when that port is driven with a
unit incident power wave and every other port is terminated in its reference resistance. Because
the other elements are present and loaded, these *embedded* patterns already contain the mutual
coupling. For excitation weights w_j (complex incident waves), superposition gives the array field::

    E(theta, phi) = sum_j w_j E_j(theta, phi)

and the active reflection coefficient of port i::

    Gamma_active,i = sum_j S_ij w_j / w_i

Nothing here re-runs openEMS: any number of steering states comes from one set of simulations.
"""

from __future__ import annotations

import numpy as np

from .multiport import decode_pattern_fields, s_from_section

C0 = 299_792_458.0
ETA0 = 376.730313668


def element_patterns(bundle: dict, f: float | None = None):
    """``(section, k, {port: (E_theta, E_phi)})`` at the stored frequency nearest ``f``."""
    ep = (bundle.get("results") or {}).get("element_patterns")
    if not ep:
        raise ValueError("bundle has no results.element_patterns (run a multi-port antenna with --excite all)")
    freqs = np.asarray(ep["frequencies"])
    k = 0 if f is None else int(np.argmin(np.abs(freqs - f)))
    fields = {p["port"]: decode_pattern_fields(ep, p["fields"][k]) for p in ep["ports"]}  # f32 or scaled int16
    return ep, k, fields


def normalize_weights(weights, ports: list[int]) -> dict[int, complex]:
    """Accepts {port: complex}, {port: (amplitude, phase_deg)} or a sequence in port order.
    Ports without a weight get 0 (terminated, not driven)."""
    if isinstance(weights, dict):
        items = weights.items()
    else:
        items = zip(ports, weights)
    out = {p: 0j for p in ports}
    for p, w in items:
        if int(p) not in out:
            raise ValueError(f"port {p} has no element pattern (available: {ports})")
        if isinstance(w, (tuple, list)):
            amp, ph = w
            w = amp * np.exp(1j * np.deg2rad(ph))
        out[int(p)] = complex(w)
    return out


def steering_weights(bundle: dict, theta0: float, phi0: float = 0.0, f: float | None = None,
                     amplitudes: dict | None = None) -> dict[int, complex]:
    """Progressive phases that point the main beam to (theta0, phi0) degrees at frequency ``f``:
    w_n = A_n exp(-j k r0 . r_n), with r_n the port centre (drawing units). This is the textbook
    phase taper; mutual coupling and element pattern asymmetry can still move the actual peak, which
    :func:`combine` reports."""
    ep = bundle["results"]["element_patterns"]
    freqs = np.asarray(ep["frequencies"])
    fk = float(freqs[0] if f is None else freqs[int(np.argmin(np.abs(freqs - f)))])
    k0 = 2 * np.pi * fk / C0
    unit = bundle.get("units", {}).get("length_m", 1e-3)
    th, ph = np.deg2rad(theta0), np.deg2rad(phi0)
    r0 = np.array([np.sin(th) * np.cos(ph), np.sin(th) * np.sin(ph), np.cos(th)])
    out = {}
    for p in ep["ports"]:
        a = 1.0 if amplitudes is None else float(amplitudes.get(p["port"], 0.0))
        out[p["port"]] = a * np.exp(-1j * k0 * float(np.dot(r0, np.asarray(p["position"]) * unit)))
    return out


def combine(bundle: dict, weights, f: float | None = None) -> dict:
    """Array pattern and active reflection coefficients for complex port weights.

    Returns a dict with the directivity grid (dBi, [theta][phi]), its maximum and direction, the
    realized gain (4 pi U / P_incident, so mismatch, coupling and loss included), the total
    efficiency P_rad / P_inc, and ``gamma_active`` per port over the bundle's frequency axis (only
    when the S-matrix is complete).
    """
    ep, k, fields = element_patterns(bundle, f)
    ports = [p["port"] for p in ep["ports"]]
    w = normalize_weights(weights, ports)
    if not any(abs(v) > 0 for v in w.values()):
        raise ValueError("all weights are zero")
    et = sum(w[p] * fields[p][0] for p in ports)
    epf = sum(w[p] * fields[p][1] for p in ports)
    u = np.abs(et) ** 2 + np.abs(epf) ** 2                          # proportional to radiation intensity
    theta = np.deg2rad(np.asarray(ep["theta"], float))
    phi = np.asarray(ep["phi"], float)
    m = 2.0 ** ep.get("mirror_planes", 0)
    integral = np.trapezoid(u.mean(axis=1) * np.sin(theta), theta) * 2 * np.pi / m  # physical space
    d = 4 * np.pi * u / integral
    i, j = np.unravel_index(int(np.argmax(u)), u.shape)
    r = float(ep.get("radius_m", 1.0))
    p_inc = 0.5 * sum(abs(v) ** 2 for v in w.values())
    p_rad = r ** 2 / (2 * ETA0) * integral
    g_real = 4 * np.pi * r ** 2 * u / (2 * ETA0) / p_inc
    with np.errstate(divide="ignore"):
        d_db = np.maximum(10 * np.log10(d), 10 * np.log10(d.max()) - 60)
        g_db = np.maximum(10 * np.log10(g_real), 10 * np.log10(g_real.max()) - 60)
    out = {
        "f": float(ep["frequencies"][k]), "weights": {p: [float(abs(v)), float(np.degrees(np.angle(v)))] for p, v in w.items()},
        "theta": ep["theta"], "phi": ep["phi"],
        "directivity_dbi": d_db, "dmax_dbi": float(10 * np.log10(d.max())),
        "peak_theta": float(np.degrees(theta[i])), "peak_phi": float(phi[j]),
        "realized_gain_dbi": g_db, "realized_gain_max_dbi": float(10 * np.log10(g_real.max())),
        "p_inc_w": float(p_inc), "p_rad_w": float(p_rad), "total_efficiency": float(p_rad / p_inc),
    }
    sp = bundle["results"].get("sparams")
    if sp and sp.get("complete"):
        s = s_from_section(sp)
        idx = {n: i for i, n in enumerate(sp.get("port_numbers", sp["ports"]))}
        wv = np.zeros(s.shape[1], complex)
        for p, v in w.items():
            wv[idx[p]] = v
        b = np.einsum("fij,j->fi", s, wv)
        out["gamma_active"] = {p: (b[:, idx[p]] / w[p]) if abs(w[p]) > 0 else None for p in ports}
        fr = np.asarray(bundle["results"]["frequency"])
        kf = int(np.argmin(np.abs(fr - out["f"])))
        out["gamma_active_at_f"] = {p: (None if g is None else complex(g[kf])) for p, g in out["gamma_active"].items()}
    return out


def cut(result: dict, phi_deg: float) -> tuple[np.ndarray, np.ndarray]:
    """Elevation cut (theta, directivity dBi) of a :func:`combine` result at the stored phi nearest
    ``phi_deg``, extended over -180..180 degrees with the opposite half-plane."""
    phi = np.asarray(result["phi"], float)
    th = np.asarray(result["theta"], float)
    d = np.asarray(result["directivity_dbi"])
    j = int(np.argmin(np.abs((phi - phi_deg + 180) % 360 - 180)))
    j2 = int(np.argmin(np.abs((phi - phi_deg) % 360 - 180)))
    return np.r_[-th[::-1], th[1:]], np.r_[d[::-1, j2], d[1:, j]]


def grating_lobes(bundle: dict, theta0: float, phi0: float = 0.0, f: float | None = None) -> dict:
    """Grating-lobe check for a uniformly spaced linear array (element positions = port centres).

    For spacing d along the array axis u and scan direction r0, grating lobes point where
    u . r = u . r0 + m lambda / d (m = +-1, +-2, ...). They are visible when |u . r| <= 1. The
    classic no-grating-lobe condition is d / lambda < 1 / (1 + |sin theta_scan|), with theta_scan
    measured from broadside of the array axis. Returns the spacing, the limit, and the visible lobes
    as direction cosines along u plus their angle from broadside in the scan plane.
    """
    ep = bundle["results"]["element_patterns"]
    freqs = np.asarray(ep["frequencies"])
    fk = float(freqs[0] if f is None else freqs[int(np.argmin(np.abs(freqs - f)))])
    lam = C0 / fk / bundle.get("units", {}).get("length_m", 1e-3)
    pos = np.array([p["position"] for p in ep["ports"]], float)
    if len(pos) < 2:
        return {"spacing": None, "visible": []}
    axis = pos[-1] - pos[0]
    length = np.linalg.norm(axis)
    u = axis / length
    proj = np.sort(pos @ u)
    d = float(np.mean(np.diff(proj)))
    th, ph = np.deg2rad(theta0), np.deg2rad(phi0)
    r0 = np.array([np.sin(th) * np.cos(ph), np.sin(th) * np.sin(ph), np.cos(th)])
    c0 = float(np.dot(u, r0))
    visible = []
    for m in range(-4, 5):
        if m == 0:
            continue
        c = c0 + m * lam / d
        if abs(c) <= 1:
            visible.append({"m": m, "direction_cosine": round(c, 4), "angle_from_broadside_deg": round(float(np.degrees(np.arcsin(c))), 2)})
    uniform = float(np.std(np.diff(proj)) / d) < 1e-3 if len(proj) > 2 else True
    return {"f": fk, "wavelength": lam, "spacing": d, "spacing_wavelengths": d / lam, "uniform": uniform,
            "scan_from_broadside_deg": float(np.degrees(np.arcsin(np.clip(c0, -1, 1)))),
            "limit_spacing_wavelengths": 1 / (1 + abs(c0)), "visible": visible}
