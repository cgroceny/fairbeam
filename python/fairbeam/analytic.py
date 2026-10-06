"""Closed-form antenna estimates used to sanity-check simulations (docs/VALIDATION.md).

Everything here is textbook first-order theory. It is meant for "is the simulation in the right
place?" checks, not as a substitute for a full-wave result.

Microstrip / patch (transmission-line model; Balanis, *Antenna Theory*, 4th ed., sec. 14.2;
Hammerstad, "Equations for microstrip circuit design", EuMC 1975):

- effective permittivity (Hammerstad)::

      eps_eff = (eps_r + 1)/2 + (eps_r - 1)/2 * (1 + 12 h/W)^(-1/2)          (+ 0.04 (1 - W/h)^2 if W/h < 1)

- fringing length extension of each radiating edge (Hammerstad)::

      dL = 0.412 h (eps_eff + 0.3)(W/h + 0.264) / ((eps_eff - 0.258)(W/h + 0.8))

- TM010 resonance of a patch of resonant length L::

      f_r = c0 / (2 (L + 2 dL) sqrt(eps_eff))

Assumptions: infinite ground and substrate, thin substrate (h << lambda), no feed (probe or inset)
loading, no surface-wave or dispersion correction (quasi-static eps_eff). Typical accuracy is
1-3 %, usually over-estimating f_r for thick or high-eps substrates.

Half-wave dipole (induced-EMF method, sinusoidal current; Balanis sec. 8.5, eqs. 8-60a/8-61a):
input impedance of a centre-fed dipole of total length l and wire radius a, referred from the
current maximum to the feed with 1/sin^2(k l / 2). A flat strip of width w is equivalent to a wire
of radius a = w / 4 (Balanis sec. 9.7). The sinusoidal-current assumption makes the reactance only
approximate near resonance (the resonant length it predicts is good to ~1-2 %).

Homogeneous slab at normal incidence (:func:`slab_s`; Orfanidis, *Electromagnetic Waves and
Antennas*, ch. 6): each layer is a TEM line section of wave impedance eta0 sqrt(mu/eps) and
propagation constant k0 sqrt(eps mu); the cascade is exact for laterally infinite layers.
"""

from __future__ import annotations

import numpy as np

C0 = 299_792_458.0
ETA0 = 376.730313668
EULER_GAMMA = 0.5772156649015329


# ---------------------------------------------------------------------------- special functions

def _cumulative(fun, x: float, n: int = 20001) -> float:
    """Simpson integral of ``fun`` over [0, x]."""
    if x == 0:
        return 0.0
    t = np.linspace(0.0, x, n)
    y = fun(t)
    h = x / (n - 1)
    return float(h / 3 * (y[0] + y[-1] + 4 * y[1:-1:2].sum() + 2 * y[2:-1:2].sum()))


def si(x: float) -> float:
    """Sine integral Si(x) = int_0^x sin(t)/t dt."""
    return _cumulative(lambda t: np.sinc(t / np.pi), x)


def ci(x: float) -> float:
    """Cosine integral Ci(x) = gamma + ln x + int_0^x (cos t - 1)/t dt, x > 0."""
    if x <= 0:
        raise ValueError("Ci(x) needs x > 0")

    def integrand(t):
        out = np.empty_like(t)
        small = np.abs(t) < 1e-4
        out[small] = -t[small] / 2  # (cos t - 1)/t ~ -t/2
        ts = t[~small]
        out[~small] = (np.cos(ts) - 1) / ts
        return out

    return EULER_GAMMA + np.log(x) + _cumulative(integrand, x)


def bessel_j0(x: float) -> float:
    """J0(x) = (1/pi) int_0^pi cos(x sin tau) d tau."""
    return _cumulative(lambda t: np.cos(x * np.sin(t)), np.pi, 2001) / np.pi


# ---------------------------------------------------------------------------- microstrip / patch

def microstrip_eps_eff(eps_r: float, h: float, w: float) -> float:
    """Hammerstad quasi-static effective permittivity of a microstrip of width ``w`` on height ``h``."""
    u = w / h
    e = (eps_r + 1) / 2 + (eps_r - 1) / 2 / np.sqrt(1 + 12 / u)
    if u < 1:
        e += (eps_r - 1) / 2 * 0.04 * (1 - u) ** 2
    return float(e)


def microstrip_z0(eps_r: float, h: float, w: float) -> float:
    """Hammerstad-Jensen-style characteristic impedance (zero thickness), ohm."""
    u = w / h
    e = microstrip_eps_eff(eps_r, h, w)
    if u <= 1:
        return float(60 / np.sqrt(e) * np.log(8 / u + u / 4))
    return float(120 * np.pi / (np.sqrt(e) * (u + 1.393 + 0.667 * np.log(u + 1.444))))


def microstrip_width(z0: float, eps_r: float, h: float) -> float:
    """Strip width giving characteristic impedance ``z0`` (bisection on :func:`microstrip_z0`)."""
    lo, hi = 1e-4 * h, 50.0 * h
    for _ in range(200):
        mid = np.sqrt(lo * hi)
        if microstrip_z0(eps_r, h, mid) > z0:
            lo = mid
        else:
            hi = mid
    return float(np.sqrt(lo * hi))


def patch_delta_l(eps_eff: float, h: float, w: float) -> float:
    """Hammerstad fringing extension of one radiating edge (same length unit as ``h``)."""
    u = w / h
    return float(0.412 * h * (eps_eff + 0.3) * (u + 0.264) / ((eps_eff - 0.258) * (u + 0.8)))


def patch_resonance(length: float, width: float, h: float, eps_r: float, unit: float = 1e-3) -> dict:
    """TM010 resonance of a rectangular patch (transmission-line model).

    ``length`` is the resonant dimension, ``width`` the radiating-edge width, ``h`` the substrate
    thickness, all in ``unit`` metres. Returns f_r in Hz plus the intermediate quantities.
    """
    e = microstrip_eps_eff(eps_r, h, width)
    dl = patch_delta_l(e, h, width)
    f = C0 / (2 * (length + 2 * dl) * unit * np.sqrt(e))
    f_cavity = C0 / (2 * length * unit * np.sqrt(eps_r))  # ideal cavity: eps_r, no fringing
    return {"f_r": float(f), "eps_eff": e, "delta_l": dl, "f_r_no_fringing": float(f_cavity)}


def patch_design(f0: float, h: float, eps_r: float, unit: float = 1e-3) -> dict:
    """Classical patch design for resonance ``f0`` (Hz): width for good radiation efficiency,
    then the resonant length from the transmission-line model. Lengths in ``unit`` metres."""
    w = C0 / (2 * f0) * np.sqrt(2 / (eps_r + 1)) / unit
    e = microstrip_eps_eff(eps_r, h, w)
    dl = patch_delta_l(e, h, w)
    length = C0 / (2 * f0 * np.sqrt(e)) / unit - 2 * dl
    return {"width": float(w), "length": float(length), "eps_eff": e, "delta_l": dl}


def patch_edge_resistance(length: float, width: float, f: float, unit: float = 1e-3) -> float:
    """Edge input resistance R_in(0) = 1 / (2 (G1 + G12)) of a TM010 patch (Balanis eqs. 14-12,
    14-17, 14-18a). Ignores the substrate in the slot conductances, like the textbook."""
    k0 = 2 * np.pi * f / C0
    w, L = width * unit, length * unit
    th = np.linspace(1e-6, np.pi - 1e-6, 4001)
    base = np.sin(k0 * w / 2 * np.cos(th)) ** 2 / np.cos(th) ** 2 * np.sin(th) ** 3
    g1 = np.trapezoid(base, th) / (120 * np.pi ** 2)
    j0 = np.array([bessel_j0(k0 * L * np.sin(t)) for t in th[::8]])
    g12 = np.trapezoid(base[::8] * j0, th[::8]) / (120 * np.pi ** 2)
    return float(1 / (2 * (g1 + g12)))


def inset_depth(r_target: float, length: float, width: float, f: float, unit: float = 1e-3) -> float:
    """Inset depth y0 with R_in(y0) = R_in(0) cos^2(pi y0 / L) = ``r_target`` (same unit as length)."""
    r0 = patch_edge_resistance(length, width, f, unit)
    if r_target >= r0:
        return 0.0
    return float(length / np.pi * np.arccos(np.sqrt(r_target / r0)))


# ---------------------------------------------------------------------------- dipole

def dipole_impedance(length: float, radius: float, f, unit: float = 1e-3):
    """Induced-EMF input impedance (ohm, complex) of a centre-fed dipole of total ``length`` and wire
    ``radius`` (``unit`` metres) at frequency/frequencies ``f`` (Hz)."""
    f_arr = np.atleast_1d(np.asarray(f, dtype=float))
    out = np.empty(f_arr.shape, dtype=complex)
    l, a = length * unit, radius * unit
    for i, fi in enumerate(f_arr):
        k = 2 * np.pi * fi / C0
        kl = k * l
        rr = ETA0 / (2 * np.pi) * (
            EULER_GAMMA + np.log(kl) - ci(kl)
            + 0.5 * np.sin(kl) * (si(2 * kl) - 2 * si(kl))
            + 0.5 * np.cos(kl) * (EULER_GAMMA + np.log(kl / 2) + ci(2 * kl) - 2 * ci(kl)))
        xm = ETA0 / (4 * np.pi) * (
            2 * si(kl) + np.cos(kl) * (2 * si(kl) - si(2 * kl))
            - np.sin(kl) * (2 * ci(kl) - ci(2 * kl) - ci(2 * k * a ** 2 / l)))
        s2 = np.sin(kl / 2) ** 2
        out[i] = complex(rr / s2, xm / s2)
    return out if np.ndim(f) else complex(out[0])


def dipole_resonance(length: float, radius: float, f_lo: float, f_hi: float, unit: float = 1e-3) -> dict:
    """First series resonance (X_in = 0, rising through zero) between ``f_lo`` and ``f_hi`` (Hz)."""
    f = np.linspace(f_lo, f_hi, 401)
    x = dipole_impedance(length, radius, f, unit).imag
    idx = np.where((x[:-1] < 0) & (x[1:] >= 0))[0]
    if not len(idx):
        raise ValueError("no resonance in range")
    a, b = f[idx[0]], f[idx[0] + 1]
    for _ in range(40):
        m = (a + b) / 2
        if dipole_impedance(length, radius, m, unit).imag < 0:
            a = m
        else:
            b = m
    fr = (a + b) / 2
    return {"f_r": float(fr), "r_in": float(dipole_impedance(length, radius, fr, unit).real),
            "length_over_lambda": float(length * unit * fr / C0)}


def dipole_directivity(length: float, f: float, unit: float = 1e-3) -> float:
    """Directivity (linear) of a thin centre-fed dipole with sinusoidal current (Balanis eq. 4-62)."""
    kl2 = np.pi * f / C0 * length * unit
    th = np.linspace(1e-6, np.pi - 1e-6, 20001)
    u = ((np.cos(kl2 * np.cos(th)) - np.cos(kl2)) / np.sin(th)) ** 2
    return float(2 * u.max() / np.trapezoid(u * np.sin(th), th))


# ---------------------------------------------------------------------------- dipole, moment method

_GL_X, _GL_W = np.polynomial.legendre.leggauss(8)


def dipole_impedance_mom(length: float, radius: float, f, n_seg: int = 120, unit: float = 1e-3):
    """Input impedance of a centre-fed thin-wire dipole from Hallen's integral equation.

    A small, independent full-wave reference for the FDTD dipole: piecewise-linear (triangle)
    current basis with zero current at the wire ends, delta-gap feed at the centre, reduced
    thin-wire kernel ``exp(-jkR) / (4 pi R)`` with ``R = sqrt((z - z')^2 + a^2)``, point matching at
    segment centres. The static part of the kernel is integrated analytically and the smooth
    remainder with 8-point Gauss-Legendre per segment. ``n_seg`` must be even (a node at the feed).
    Accurate to about 1 % in R and a few ohm in X for length/radius > ~100 and segment length > radius.

    Hallen's equation (e^{jwt} convention)::

        int I(z') K(z - z') dz' = -(j / eta) [C cos(k z) + (V / 2) sin(k |z|)]
    """
    if n_seg % 2:
        raise ValueError("n_seg must be even")
    f_arr = np.atleast_1d(np.asarray(f, dtype=float))
    h, a = length * unit / 2, radius * unit
    nodes = np.linspace(-h, h, n_seg + 1)
    dz = nodes[1] - nodes[0]
    zm = (nodes[:-1] + nodes[1:]) / 2                        # matching points (segment centres)
    z0 = nodes[:-1]                                          # segment start
    # Gauss points on every segment: shape (n_seg, 8)
    zq = z0[:, None] + (_GL_X[None, :] + 1) / 2 * dz
    tq = (zq - z0[:, None]) / dz                             # 0..1 along the segment
    # analytic static part: int (1 - t) / R and int t / R over each segment for each match point
    u0 = z0[None, :] - zm[:, None]
    u1 = u0 + dz
    asinh = np.arcsinh(u1 / a) - np.arcsinh(u0 / a)
    rootd = np.sqrt(u1 ** 2 + a ** 2) - np.sqrt(u0 ** 2 + a ** 2)
    s_t = (rootd - u0 * asinh) / dz                          # int t / R dz'
    s_1mt = asinh - s_t                                      # int (1 - t) / R dz'
    out = np.empty(f_arr.shape, dtype=complex)
    for i, fi in enumerate(f_arr):
        k = 2 * np.pi * fi / C0
        r = np.sqrt((zm[:, None, None] - zq[None, :, :]) ** 2 + a ** 2)   # (match, seg, gauss)
        smooth = np.where(k * r < 1e-6, -1j * k, (np.exp(-1j * k * r) - 1) / r)
        wq = _GL_W[None, None, :] * dz / 2
        d_1mt = np.sum(smooth * (1 - tq)[None] * wq, axis=2)
        d_t = np.sum(smooth * tq[None] * wq, axis=2)
        left = (s_1mt + d_1mt) / (4 * np.pi)                 # current value at segment start node
        right = (s_t + d_t) / (4 * np.pi)                    # current value at segment end node
        # node n (1..n_seg-1) is the end of segment n-1 and the start of segment n
        z_mat = np.zeros((n_seg, n_seg), dtype=complex)
        z_mat[:, :n_seg - 1] = right[:, :-1] + left[:, 1:]
        z_mat[:, n_seg - 1] = 1j / ETA0 * np.cos(k * zm)     # unknown C
        rhs = -1j / ETA0 * 0.5 * np.sin(k * np.abs(zm))      # V = 1
        sol = np.linalg.solve(z_mat, rhs)
        out[i] = 1.0 / sol[n_seg // 2 - 1]                   # node at z = 0
    return out if np.ndim(f) else complex(out[0])


# ---------------------------------------------------------------------------- two-port line extraction

def line_from_s2p(f, s, length: float, z_ref: float = 50.0, unit: float = 1e-3) -> dict:
    """Characteristic impedance and effective permittivity of a uniform line from its S-matrix.

    ``s``: (n_freq, 2, 2) complex S-parameters referenced to ``z_ref`` (both ports), ``length`` in
    ``unit`` metres. Uses the ABCD matrix of a uniform line (A = D = cosh(gamma l),
    B = Z0 sinh(gamma l), C = sinh(gamma l) / Z0), so Z0 = sqrt(B / C). The effective permittivity
    comes from the unwrapped phase of S21 (valid while the line is well matched, |S11| << 1), and
    the loss from |S21| corrected for mismatch. Port transition parasitics are included in the
    extracted values, so Z0 drifts slightly toward the upper band edge.
    """
    f = np.asarray(f, float)
    s = np.asarray(s, complex)
    s11, s12, s21, s22 = s[:, 0, 0], s[:, 0, 1], s[:, 1, 0], s[:, 1, 1]
    den = 2 * s21
    b = z_ref * ((1 + s11) * (1 + s22) - s12 * s21) / den
    c = ((1 - s11) * (1 - s22) - s12 * s21) / (den * z_ref)
    z0 = np.sqrt(b / c)
    z0 = np.where(z0.real < 0, -z0, z0)
    phase = -np.unwrap(np.angle(s21))
    beta = phase / (length * unit)
    eps_eff = (beta * C0 / (2 * np.pi * f)) ** 2
    loss_db = -20 * np.log10(np.abs(s21)) + 10 * np.log10(np.maximum(1 - np.abs(s11) ** 2, 1e-12))
    return {"z0": z0, "eps_eff": eps_eff, "loss_db": loss_db}


def line_z0_estimate(f, s, length: float, z_ref: float = 50.0, unit: float = 1e-3, min_sin: float = 0.95) -> dict:
    """Robust line impedance from :func:`line_from_s2p`: the median of Re Z0 over the frequencies
    where the line is close to an odd multiple of a quarter wave (|sin(beta l)| > ``min_sin``).

    Near half-wave points B and C both vanish and sqrt(B/C) is dominated by the port transition
    parasitics, so the raw curve oscillates; at quarter-wave points it is best conditioned.
    """
    r = line_from_s2p(f, s, length, z_ref, unit)
    bl = np.sqrt(np.maximum(r["eps_eff"], 0)) * 2 * np.pi * np.asarray(f) / C0 * length * unit
    m = np.abs(np.sin(bl)) > min_sin
    if not m.any():
        raise ValueError("the band contains no quarter-wave point of this line; use a longer line")
    z = r["z0"].real[m]
    return {"z0": float(np.median(z)), "z0_p10": float(np.percentile(z, 10)), "z0_p90": float(np.percentile(z, 90)),
            "frequencies": np.asarray(f)[m]}


# ---------------------------------------------------------------------------- low-pass filters

def lowpass_prototype(n: int, ripple_db: float = 0.0) -> list[float]:
    """Element values g_1..g_{n+1} of the low-pass prototype (Pozar, Microwave Engineering, 4th ed.,
    sec. 8.3): maximally flat (Butterworth) for ``ripple_db`` = 0, equal-ripple (Chebyshev) otherwise.
    g_{n+1} is the load (1 for Butterworth and odd-order Chebyshev)."""
    if ripple_db <= 0:
        g = [2 * np.sin((2 * k - 1) * np.pi / (2 * n)) for k in range(1, n + 1)]
        return g + [1.0]
    beta = np.log(1 / np.tanh(ripple_db / 17.37))
    gamma = np.sinh(beta / (2 * n))
    a = [np.sin((2 * k - 1) * np.pi / (2 * n)) for k in range(1, n + 1)]
    b = [gamma ** 2 + np.sin(k * np.pi / n) ** 2 for k in range(1, n + 1)]
    g = [2 * a[0] / gamma]
    for k in range(2, n + 1):
        g.append(4 * a[k - 2] * a[k - 1] / (b[k - 2] * g[-1]))
    g_load = 1.0 if n % 2 else 1 / np.tanh(beta / 4) ** 2
    return g + [float(g_load)]


def lowpass_prototype_s21(f, fc: float, n: int, ripple_db: float = 0.0):
    """|S21| (linear) of the ideal lumped low-pass prototype with cutoff ``fc``: Butterworth
    1 / (1 + (f/fc)^(2n)), Chebyshev 1 / (1 + eps^2 T_n^2(f/fc)) in power."""
    x = np.asarray(f, float) / fc
    if ripple_db <= 0:
        return 1 / np.sqrt(1 + x ** (2 * n))
    eps2 = 10 ** (ripple_db / 10) - 1
    t = np.where(np.abs(x) <= 1, np.cos(n * np.arccos(np.clip(x, -1, 1))), np.cosh(n * np.arccosh(np.maximum(np.abs(x), 1))))
    return 1 / np.sqrt(1 + eps2 * t ** 2)


def stepped_impedance_lowpass(fc: float, n: int, ripple_db: float, z0: float, z_high: float, z_low: float,
                              eps_r: float, h: float, unit: float = 1e-3, first: str = "C") -> list[dict]:
    """Stepped-impedance microstrip low-pass (Pozar sec. 8.6): inductors become short high-impedance
    lines with beta*l = g*z0/z_high, capacitors short low-impedance lines with beta*l = g*z_low/z0,
    evaluated at the cutoff ``fc``. ``first`` = "C" starts with a shunt capacitor (low-Z section).
    Returns sections from port 1 to port 2: {kind, g, z, width, eps_eff, beta_l, length}."""
    g = lowpass_prototype(n, ripple_db)[:n]
    out = []
    for k, gk in enumerate(g):
        is_c = (k % 2 == 0) == (first == "C")
        z = z_low if is_c else z_high
        bl = gk * z_low / z0 if is_c else gk * z0 / z_high
        w = microstrip_width(z, eps_r, h)
        e = microstrip_eps_eff(eps_r, h, w)
        length = bl / (2 * np.pi * fc * np.sqrt(e) / C0) / unit
        out.append({"kind": "C" if is_c else "L", "g": float(gk), "z": float(z), "width": float(w), "eps_eff": float(e),
                    "beta_l": float(bl), "length": float(length)})
    return out


def cascade_lines_s(f, sections, z0: float = 50.0, unit: float = 1e-3):
    """S-matrix (n_f, 2, 2) of a cascade of ideal lossless TEM line sections ``{z, eps_eff, length}``
    (quasi-static, no step discontinuities) between ``z0`` ports."""
    f = np.asarray(f, float)
    out = np.empty((len(f), 2, 2), complex)
    for i, fi in enumerate(f):
        m = np.eye(2, dtype=complex)
        for sec in sections:
            bl = 2 * np.pi * fi * np.sqrt(sec["eps_eff"]) / C0 * sec["length"] * unit
            z = sec["z"]
            m = m @ np.array([[np.cos(bl), 1j * z * np.sin(bl)], [1j * np.sin(bl) / z, np.cos(bl)]])
        a, b, c, d = m[0, 0], m[0, 1], m[1, 0], m[1, 1]
        den = a + b / z0 + c * z0 + d
        out[i] = [[(a + b / z0 - c * z0 - d) / den, 2 * (a * d - b * c) / den],
                  [2 / den, (-a + b / z0 - c * z0 + d) / den]]
    return out


def layer_constants(f, layer: dict):
    """Complex relative permittivity and permeability of a :func:`slab_s` layer at ``f`` (Hz):
    eps = eps_r (1 - j tan_d tan_d_freq / f), or eps_r (1 - j tan_d) without ``tan_d_freq``;
    mu = mu_r (loss-free). A frequency-dependent layer gives ``dispersion`` instead (an object
    with ``eps(f)`` and optionally ``mu(f)``, e.g. fairbeam.dispersion's Dispersion or
    DjordjevicSarkar, or its ``to_dict()``), or ``eps`` / ``mu`` as functions of f."""
    f = np.asarray(f, float)
    disp = layer.get("dispersion")
    if isinstance(disp, dict):          # a serialized model: dispatched by its "model"
        from .dispersion import model_from_dict
        disp = model_from_dict(disp)
    eps_fn = disp.eps if disp is not None else layer.get("eps")
    mu_fn = getattr(disp, "mu", None) if disp is not None else layer.get("mu")
    if eps_fn is not None:
        eps = np.asarray(eps_fn(f), complex)
        mu = np.asarray(mu_fn(f), complex) if mu_fn is not None else np.full(np.shape(f), complex(layer.get("mu_r", 1.0)))
        return (complex(eps), complex(mu)) if np.ndim(f) == 0 else (eps * np.ones(np.shape(f)), mu * np.ones(np.shape(f)))
    tan_d = float(layer.get("tan_d", 0.0))
    f_ref = layer.get("tan_d_freq")
    eps = layer["eps_r"] * (1 - 1j * tan_d * (f_ref / f if f_ref else np.ones(np.shape(f))))
    mu = np.full(np.shape(f), complex(layer.get("mu_r", 1.0)))
    return (complex(eps), complex(mu)) if np.ndim(f) == 0 else (np.asarray(eps, complex), mu)


def slab_s(f, layers, unit: float = 1e-3, kc: float = 0.0):
    """S-matrix (n_f, 2, 2) of homogeneous layers in vacuum at normal incidence (transfer matrix),
    referred to the outer faces, with the vacuum wave impedance as the reference on both sides.

    ``layers`` (front to back): ``{thickness, eps_r, tan_d=0, tan_d_freq=None, mu_r=1}``. Loss
    follows ``Simulation.dielectric``: a constant conductivity that gives ``tan_d`` at
    ``tan_d_freq``, so eps = eps_r (1 - j tan_d tan_d_freq / f) (exp(+j w t) convention); without
    ``tan_d_freq`` the loss tangent is the same at every frequency.

    ``kc`` (rad/m) gives the layers filling a waveguide in its TE mode of that cut-off wavenumber
    (TE10 of an a-wide guide: pi / a): each layer a section of propagation constant
    beta = sqrt(eps mu k0^2 - kc^2) and wave impedance eta0 mu k0 / beta, referred to the empty
    guide's TE impedance eta0 k0 / beta0 on both sides."""
    f = np.asarray(f, float)
    out = np.empty((len(f), 2, 2), complex)
    for i, fi in enumerate(f):
        k0 = 2 * np.pi * fi / C0
        z0 = ETA0 * k0 / np.sqrt(complex(k0 ** 2 - kc ** 2))
        m = np.eye(2, dtype=complex)
        for lay in layers:
            eps, mu = layer_constants(fi, lay)
            beta = np.sqrt(eps * mu * k0 ** 2 - kc ** 2)
            beta = -beta if beta.imag > 0 else beta         # Im <= 0: the wave decays along +z
            z =ETA0 * mu * k0 / beta
            kd = beta * lay["thickness"] * unit
            m = m @ np.array([[np.cos(kd), 1j * z * np.sin(kd)], [1j * np.sin(kd) / z, np.cos(kd)]])
        a, b, c, d = m[0, 0], m[0, 1], m[1, 0], m[1, 1]
        den = a + b / z0 + c * z0 + d
        out[i] = [[(a + b / z0 - c * z0 - d) / den, 2 * (a * d - b * c) / den],
                  [2 / den, (-a + b / z0 - c * z0 + d) / den]]
    return out


# ---------------------------------------------------------------------------- horn and helix

def pyramidal_horn_design(g0_dbi: float, f: float, a: float, b: float, unit: float = 1e-3) -> dict:
    """Optimum-gain pyramidal horn for gain ``g0_dbi`` fed by an a x b waveguide (Balanis,
    *Antenna Theory*, 4th ed., sec. 13.4.3): solve
    (sqrt(2 chi) - b/lambda)^2 (2 chi - 1) = (G0/(2 pi) sqrt(3/(2 pi chi)) - a/lambda)^2 (G0^2/(6 pi^3 chi) - 1)
    for chi, then rho_e = chi lambda, rho_h = G0^2 lambda / (8 pi^3 chi), A = sqrt(3 lambda rho_h),
    B = sqrt(2 lambda rho_e); the E- and H-plane axial lengths p_e = p_h are equal (realisable).
    Lengths in ``unit`` metres. The aperture efficiency of such a horn is ~0.51."""
    lam = C0 / f / unit
    g0 = 10 ** (g0_dbi / 10)

    def fn(chi):
        lhs = (np.sqrt(2 * chi) - b / lam) ** 2 * (2 * chi - 1)
        rhs = (g0 / (2 * np.pi) * np.sqrt(3 / (2 * np.pi)) / np.sqrt(chi) - a / lam) ** 2 * (g0 ** 2 / (6 * np.pi ** 3 * chi) - 1)
        return lhs - rhs

    lo, hi = 0.51, 50.0
    for _ in range(200):
        m = (lo + hi) / 2
        if fn(lo) * fn(m) <= 0:
            hi = m
        else:
            lo = m
    chi = (lo + hi) / 2
    rho_e, rho_h = chi * lam, g0 ** 2 / (8 * np.pi ** 3 * chi) * lam
    A = g0 / (2 * np.pi) * np.sqrt(3 / (2 * np.pi * chi)) * lam
    B = np.sqrt(2 * chi) * lam
    pe = (B - b) * np.sqrt((rho_e / B) ** 2 - 0.25)
    ph = (A - a) * np.sqrt((rho_h / A) ** 2 - 0.25)
    return {"A": float(A), "B": float(B), "length": float(pe), "length_h": float(ph), "rho_e": float(rho_e),
            "rho_h": float(rho_h), "chi": float(chi), "aperture_efficiency": float(g0 / (4 * np.pi * A * B / lam ** 2))}


def horn_estimates(A: float, B: float, f: float, efficiency: float = 0.51, unit: float = 1e-3) -> dict:
    """Aperture estimates for a horn of aperture A (H-plane) x B (E-plane): gain
    G = eff 4 pi A B / lambda^2, and half-power beamwidths of the ideal aperture distributions,
    uniform in the E-plane (50.8 deg lambda/B) and cosine in the H-plane (68.8 deg lambda/A).
    Optimum horns have quadratic phase error that broadens both, typically by 10-20 %."""
    lam = C0 / f / unit
    return {"gain_dbi": float(10 * np.log10(efficiency * 4 * np.pi * A * B / lam ** 2)),
            "hpbw_e_deg": float(50.8 * lam / B), "hpbw_h_deg": float(68.8 * lam / A)}


def horn_aperture(A: float, B: float, rho1: float, rho2: float, f: float, unit: float = 1e-3) -> dict:
    """Pyramidal-horn aperture model with quadratic phase error (Balanis sec. 13.2-13.4):
    aperture field E_y = cos(pi x / A) exp(-j k (x^2 / (2 rho2) + y^2 / (2 rho1))), where rho1 and
    rho2 are the apex-to-aperture distances along the axis in the E- and H-plane.

    Returns the directivity (numerically identical to Balanis eq. 13-54, the Fresnel-integral
    formula, which is this aperture integral in closed form) and the E-/H-plane half-power
    beamwidths from the aperture integral with the Huygens obliquity factor (1 + cos theta)/2.
    Edge diffraction and wall currents are ignored (a few tenths of a dB)."""
    lam = C0 / f / unit
    k = 2 * np.pi / lam
    n = 801
    x = np.linspace(-A / 2, A / 2, n)
    y = np.linspace(-B / 2, B / 2, n)
    ex = np.cos(np.pi * x / A) * np.exp(-1j * k * x ** 2 / (2 * rho2))
    ey = np.exp(-1j * k * y ** 2 / (2 * rho1))
    # D = 4 pi / lambda^2 |int E|^2 / int |E|^2 (separable aperture)
    d = 4 * np.pi / lam ** 2 * (abs(np.trapezoid(ex, x)) ** 2 / np.trapezoid(abs(ex) ** 2, x)) \
        * (abs(np.trapezoid(ey, y)) ** 2 / np.trapezoid(abs(ey) ** 2, y))

    def hpbw(s, e):
        th = np.radians(np.linspace(0, 90, 9001))
        pat = np.abs(np.exp(1j * k * np.outer(np.sin(th), s)) @ e) * (1 + np.cos(th)) / 2
        pat = pat / pat[0]
        i = int(np.argmax(pat < np.sqrt(0.5)))
        return float(2 * np.degrees(np.interp(np.sqrt(0.5), [pat[i], pat[i - 1]], [th[i], th[i - 1]])))

    return {"directivity_dbi": float(10 * np.log10(d)), "aperture_efficiency": float(d / (4 * np.pi * A * B / lam ** 2)),
            "hpbw_e_deg": hpbw(y, ey * (y[1] - y[0])), "hpbw_h_deg": hpbw(x, ex * (x[1] - x[0]))}


def helix_axial_mode(circumference: float, pitch: float, turns: float, f: float, unit: float = 1e-3) -> dict:
    """Kraus' axial-mode helix estimates (Kraus & Marhefka, *Antennas*, 3rd ed., ch. 8), with C, S
    in ``unit`` metres: directivity D = 15 C^2 N S / lambda^3 (10.8 + 10 log10(C^2 N S / lambda^3) dBi;
    known to overestimate by 1-3 dB, King & Wong 1980 / Emerson 1995), input resistance
    R = 140 C/lambda ohm, HPBW = 52 lambda^(3/2) / (C sqrt(N S)) deg, and axial ratio
    AR = (2N + 1) / (2N) at boresight."""
    lam = C0 / f / unit
    c, s = circumference / lam, pitch / lam
    return {"directivity_dbi": float(10 * np.log10(15 * c ** 2 * turns * s)), "r_in": float(140 * c),
            "hpbw_deg": float(52 / (c * np.sqrt(turns * s))), "axial_ratio_db": float(20 * np.log10((2 * turns + 1) / (2 * turns))),
            "pitch_angle_deg": float(np.degrees(np.arctan(pitch / circumference)))}
