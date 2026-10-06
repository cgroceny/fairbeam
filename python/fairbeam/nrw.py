"""Material parameters of a sample from its S11 and S21 at normal incidence (issue #271).

Input: S11 and S21 of a sample of thickness d in vacuum, referred to its faces, with the vacuum
wave impedance as the reference (``fairbeam.material_cell``), e^{+j w t} convention, so a lossy
material has eps = eps' - j eps'' and tan d = eps'' / eps'.

:func:`nrw` is the Nicolson-Ross-Weir inversion (Nicolson and Ross, IEEE Trans. IM-19, 1970;
Weir, Proc. IEEE 62, 1974) for eps_r and mu_r::

    X = (S11^2 - S21^2 + 1) / (2 S11),   Gamma = X -+ sqrt(X^2 - 1)  with |Gamma| <= 1
    T = (S11 + S21 - Gamma) / (1 - (S11 + S21) Gamma)               (T = exp(-j k0 n d))
    z = (1 + Gamma) / (1 - Gamma),   n = j ln(T) / (k0 d),   mu_r = n z,   eps_r = n / z

ln(T) is multivalued: n' = -(phi + 2 pi M) / (k0 d) for the unwrapped phase phi of T and any
integer M. The branch is chosen with the group delay (Weir): the group index c tau_g / d,
tau_g = -d phi / d omega, does not depend on M, and the phase index n' equals it for a
non-dispersive sample, so M is the integer that brings n' closest to the group index (one M for
each stretch the phase is unwrapped across). In a dispersive sample the two differ by
f dn'/df, so M is taken from a BRANCH_WINDOW of the stretch's reliable frequencies (at least
BRANCH_MIN_POINTS) at its low or its high end, whichever has the flatter group index; the
difference must stay below lambda0 / (2 d) there. A stretch is the band between opaque
frequencies (below), so a strong Lorentz absorption line splits the band, and the part above it
is decided at its high end, away from the line. The phase turned inside an opaque band cannot
be recovered from S11 and S21, and above a strong line in a thick sample the two indices can
differ by more than the branch spacing even there. So a stretch that does not start at the
band's first sample (``segments[k]["after_opaque"]``, an initially opaque band included) is
marked unreliable, unless the sample is declared non-magnetic (``nonmagnetic``) and the unit-mu
branch resolves: the one integer M whose complex mu_r stays within BRANCH_MU_TOL of 1 over the
stretch (a wrong branch moves mu_r by about the branch spacing). With the declaration the first
stretch is checked too: a resolved unit-mu branch must agree with the group-delay branch, or the
stretch is unreliable (BRANCH_MU_TOL); when it does not resolve (a magnetic sample), the first
stretch keeps the group-delay branch, as without the declaration. Opaque and isolated samples get
no values at all.

In a waveguide (TE10 of an a x b guide, fairbeam.waveguide_fixture) the same inversion holds with
the guided wave: ``kc`` = pi / a is the cut-off wavenumber, so 1/Lambda^2 = eps mu / lambda0^2 -
1/lambda_c^2, and ``beta0`` the empty guide's propagation constant (measured, or sqrt(k0^2 - kc^2)).
With beta_s = j ln(T) / d in the sample: mu_r = z beta_s / beta0 and eps_r mu_r = (beta_s^2 + kc^2) /
(beta0^2 + kc^2) (:func:`_material`); kc = 0 and beta0 = k0 is the free-space form above.

NRW fails where the sample is a multiple of half a wavelength thick (beta' d = m pi, m >= 1):
there S11 -> 0 for a low-loss sample and X is 0 / 0. Those frequencies are marked unreliable
(|sin(beta' d)| < ``sin_floor``) and left out of the branch choice, as are frequencies where
|S21| < S21_FLOOR (an opaque sample: a Drude metal below its plasma frequency, a Lorentz
absorption line), whose phase is not measurable and would lose turns of the unwrapping.

:func:`nist_eps` is the iterative method of Baker-Jarvis et al. (NIST; IEEE Trans. MTT-38, 1990)
for non-magnetic samples: with mu_r = 1, eps at each frequency is the least-squares fit of the
slab's closed-form S11 and S21 to the measured ones (complex Gauss-Newton), started from the NRW
value at the lowest reliable frequency and continued from each solution to the next frequency.
It has no half-wave instability.
"""

import numpy as np

from .analytic import C0

#: |sin(beta' d)| below this marks an NRW frequency near a half-wave resonance as unreliable. The
#: errors of S11 and S21 enter eps and mu about as 1 / |sin(beta' d)|: on the slab_cell example
#: (FDTD, 20 cells/lambda) the largest tan d error over the reliable points is 0.036 at 0.15, 0.020
#: at 0.3 and 0.011 at 0.5 (docs/VALIDATION.md section 15b)
SIN_FLOOR = 0.3
#: |S21| below this (-60 dB, about the dynamic range of an FDTD run) marks a frequency unreliable
S21_FLOOR = 1e-3
#: the branch is chosen on this fraction of the reliable frequencies from the low end of the band
BRANCH_WINDOW = 0.1
BRANCH_MIN_POINTS = 5
#: Unit-mu constraint (``nonmagnetic``): the branch resolves only when exactly one integer M keeps
#: the complex mu_r within this distance of 1 at every reliable frequency of the stretch. A wrong
#: branch moves mu_r by about the branch spacing, but over a narrow band a thick magnetic sample
#: has a wrong branch that stays near 1 (test_dispersion_validation:
#: test_thick_magnetic_sample_in_a_narrow_band_is_not_taken_for_mu_1). The first stretch therefore
#: also needs the group-delay branch to agree. Above an opaque band the group delay is no guide and
#: the declaration is trusted; the dispersion that makes a band opaque spreads a wrong branch's
#: mu_r there (test_false_nonmagnetic_declaration_cannot_resolve_a_branch), but a narrow, nearly
#: non-dispersive stretch above an opaque band would accept a false declaration.
BRANCH_MU_TOL = 0.1
NIST_MAX_ITER = 50
NIST_TOL = 1e-10


def nrw(f, s11, s21, d: float, unit: float = 1e-3, sin_floor: float = SIN_FLOOR,
        nonmagnetic: bool = False, kc: float = 0.0, beta0=None) -> dict:
    """eps_r(f) and mu_r(f) of a sample of thickness ``d`` (drawing units) by NRW.

    Returns ``eps_r``, ``mu_r`` (complex arrays), ``tan_d`` (dielectric), ``tan_d_mu``
    (magnetic), ``n`` (refractive index, beta_s / beta0 in a guide), ``group_index``, ``branch``
    (M of the first stretch), ``segments`` (each stretch between opaque bands: f_min, f_max,
    branch, misfit, how the branch was chosen), ``reliable`` (bool array) and ``sin_floor``.
    Frequencies where the inversion is undefined are NaN and unreliable. ``nonmagnetic`` declares
    mu_r = 1: the unit-mu branch where it resolves, which a stretch above an opaque band needs
    (module docstring). ``kc``
    (rad/m) and ``beta0`` (rad/m per frequency) give the guided form; the defaults are free space.
    """
    f = np.asarray(f, float)
    s11, s21 = np.asarray(s11, complex), np.asarray(s21, complex)
    if f.ndim != 1 or len(f) < 2 or s11.shape != f.shape or s21.shape != f.shape:
        raise ValueError("NRW needs matching one-dimensional arrays with at least two samples")
    if not np.all(np.isfinite(f)) or np.any(f <= 0) or np.any(np.diff(f) <= 0):
        raise ValueError("NRW frequencies must be finite, positive and strictly increasing")
    if not np.isfinite(d) or d <= 0 or not np.isfinite(unit) or unit <= 0:
        raise ValueError("NRW needs a finite positive thickness and length unit")
    if not np.isfinite(sin_floor) or not 0 <= sin_floor <= 1:
        raise ValueError("NRW sin_floor must be finite and between zero and one")
    length = d * unit
    k0 = _effective_k0(f, kc, beta0)
    with np.errstate(divide="ignore", invalid="ignore"):
        x = (s11 ** 2 - s21 ** 2 + 1) / (2 * s11)
        root = np.sqrt(x ** 2 - 1)
        gamma = np.where(np.abs(x + root) <= 1, x + root, x - root)
        t = (s11 + s21 - gamma) / (1 - (s11 + s21) * gamma)
        z = (1 + gamma) / (1 - gamma)
    ok = np.isfinite(t) & np.isfinite(z) & (np.abs(t) > 0)
    if not ok.any():
        raise ValueError("NRW: no frequency with a finite inversion")
    wrapped = np.angle(t)
    seen = ok & (np.abs(s21) >= S21_FLOOR)       # transmission above the dynamic range
    # The phase of T is continuous across a half-wave resonance but not across an opaque band
    # (|S21| below the floor), where it can turn any number of times: each stretch between opaque
    # bands is unwrapped and gets its branch on its own.
    beta_s = np.full(len(f), np.nan + 0j)
    group = np.full(len(f), np.nan)
    reliable = np.zeros(len(f), bool)
    segments = []
    for idx in _runs(seen):
        use = np.zeros(len(f), bool)
        use[idx] = True
        # pass 1: all of the stretch, to locate the half-wave resonances
        phase = _unwrap(f, wrapped, use)
        m, _ = _branch(f, phase, k0, length, use, kc)
        rel = use & ~_near_half_wave(-(phase + 2 * np.pi * m), sin_floor)   # beta' d
        if rel.sum() < 2:
            rel = use
        # pass 2: unwrap and choose the branch on the reliable points only, then put every point
        # of the stretch on the 2 pi multiple nearest to the phase interpolated from them
        phase_rel = _unwrap(f, wrapped, rel)
        guide = np.interp(f[idx], f[rel], phase_rel[rel])
        phase = np.full(len(f), np.nan)
        phase[idx] = wrapped[idx] + 2 * np.pi * np.round((guide - wrapped[idx]) / (2 * np.pi))
        m, misfit = _branch(f, phase, k0, length, rel, kc)
        # a stretch that does not start at the band's first sample follows an opaque (or
        # undefined) part whose phase turns are lost
        after_opaque = idx[0] > 0
        branch_resolved = not after_opaque
        how = "group delay" if branch_resolved else \
            "group delay (unreliable above an opaque band; declare the sample non-magnetic to use mu_r = 1)"
        if nonmagnetic:
            m_mu, mu_resolved = _branch_mu1(phase, t, z, k0, length, rel, kc)
            if mu_resolved and (after_opaque or m_mu == m):
                m, branch_resolved, how = m_mu, True, "mu_r = 1"
            elif mu_resolved:
                # Over a narrow band a thick magnetic sample has a wrong branch with mu_r ~ 1
                # (an eps / mu_r slab one 2 pi turn off); only the group delay tells them apart
                branch_resolved = False
                how = "mu_r = 1 and the group delay disagree (unreliable: magnetic, or too dispersive)"
            elif after_opaque:
                how = "mu_r = 1 unresolved (unreliable above an opaque band)"
            else:       # the group delay holds without the declaration; mu_r' != 1 is then reported
                how = "group delay (mu_r = 1 unresolved: the sample may be magnetic)"
        with np.errstate(divide="ignore", invalid="ignore"):
            beta_s[idx] = (1j * np.log(np.abs(t[idx])) - (phase[idx] + 2 * np.pi * m)) / length
            group[idx] = _group_index(f, phase, length, rel)[idx]
        reliable[idx] = branch_resolved & ~_near_half_wave(beta_s[idx].real * length, sin_floor)
        segments.append({"f_min": float(f[idx[0]]), "f_max": float(f[idx[-1]]), "branch": int(m),
                         "misfit": round(misfit, 4), "after_opaque": bool(after_opaque), "method": how, "branch_resolved": bool(branch_resolved)})
    # Opaque and isolated samples have no phase guide: leave their retrieval undefined.
    with np.errstate(divide="ignore", invalid="ignore"):
        eps, mu, n = _material(beta_s, z, k0, kc)
    return {"eps_r": eps, "mu_r": mu, "tan_d": -eps.imag / eps.real, "tan_d_mu": -mu.imag / mu.real, "n": n,
            "group_index": group, "branch": segments[0]["branch"] if segments else None, "segments": segments, "reliable": reliable,
            "sin_floor": float(sin_floor)}


def _branch_mu1(phase, t, z, k0, length: float, use, kc: float = 0.0) -> tuple[int, bool]:
    """Choose the unit-mu integer analytically, without a bounded branch search.

    Only trust it if exactly one candidate satisfies the complex unit-mu tolerance.
    This constraint is available solely when the caller declares a non-magnetic sample.
    """
    kd = np.sqrt(k0[use] ** 2 - kc ** 2) * length       # beta0 d
    base = 1j * np.log(np.abs(t[use])) - phase[use]
    target = (base - kd / z[use]).real / (2 * np.pi)
    if not np.all(np.isfinite(target)):
        return 0, False
    center = int(np.round(np.median(target)))
    candidates = range(center - 1, center + 2)
    costs = [float(np.max(np.abs((base - 2 * np.pi * m) / kd * z[use] - 1))) for m in candidates]
    best = int(np.argmin(costs))
    resolved = sum(c <= BRANCH_MU_TOL for c in costs) == 1
    return list(candidates)[best], resolved


def _runs(mask):
    """Index arrays of the contiguous True runs of ``mask`` (at least two points each)."""
    idx = np.flatnonzero(mask)
    if not len(idx):
        return []
    cuts = np.flatnonzero(np.diff(idx) > 1) + 1
    return [r for r in np.split(idx, cuts) if len(r) >= 2]


def _effective_k0(f, kc: float, beta0):
    """sqrt(beta0^2 + kc^2): k0 in free space; in a guide the wavenumber that the measured (or
    analytic) empty-guide beta0 implies, so numerical dispersion of the air sections cancels."""
    f = np.asarray(f, float)
    if beta0 is None:
        return 2 * np.pi * f / C0
    return np.sqrt(np.asarray(beta0, float) ** 2 + kc ** 2)


def _material(beta_s, z, k0, kc: float):
    """(eps_r, mu_r, n) from the sample's propagation constant beta_s, its normalized impedance z
    and k0 (:func:`_effective_k0`): mu_r = z beta_s / beta0, eps_r mu_r = (beta_s^2 + kc^2) / k0^2.
    The only place the free-space and the guided forms differ; kc = 0 gives mu = n z, eps = n / z."""
    beta0 = np.sqrt(k0 ** 2 - kc ** 2)
    mu = z * beta_s / beta0
    eps = (beta_s ** 2 + kc ** 2) / (k0 ** 2 * mu)
    return eps, mu, beta_s / beta0


def _near_half_wave(beta_d, sin_floor: float):
    """beta' d within ``sin_floor`` (in |sin|) of a multiple of pi, from the first half wave on."""
    beta_d = np.nan_to_num(np.asarray(beta_d, float))
    return (beta_d > np.pi / 2) & (np.abs(np.sin(beta_d)) < sin_floor)


def _unwrap(f, wrapped, use):
    """The phase unwrapped over the points ``use`` in frequency order (NaN elsewhere). Each point
    takes the 2 pi multiple nearest to the value extrapolated from the two previous points, so
    gaps (left-out resonances) do not lose a turn as long as the phase slope holds across them."""
    out = np.full(len(f), np.nan)
    idx = np.flatnonzero(use)
    for j, k in enumerate(idx):
        if j == 0:
            out[k] = wrapped[k]
            continue
        p = idx[j - 1]
        pred = out[p]
        if j >= 2:
            q = idx[j - 2]
            pred += (out[p] - out[q]) / (f[p] - f[q]) * (f[k] - f[p])
        out[k] = wrapped[k] + 2 * np.pi * np.round((pred - wrapped[k]) / (2 * np.pi))
    return out


def _group_index(f, phase, length: float, use):
    """c tau_g / d with tau_g = -d phase / d omega, from the points ``use``, interpolated to all."""
    fu = f[use]
    tau = -np.gradient(phase[use], 2 * np.pi * fu) if len(fu) > 1 else np.zeros(len(fu))
    return np.interp(f, fu, C0 * tau / length)


def _branch(f, phase, k0, length: float, use, kc: float = 0.0) -> tuple[int, float]:
    """(M, misfit): the integer M that brings the phase index -(phase + 2 pi M) / (k0 d) closest
    to the group index, the median over a BRANCH_WINDOW of the points ``use`` at the low or the
    high end, whichever has the flatter group index (the weaker dispersion, where the two indices
    agree best; above an absorption line that is the high end). ``misfit`` is that median
    distance in units of the branch spacing lambda0 / d: near 0 for a clear choice, up to 0.5 for
    none. See the module docstring. In a guide (``kc``) the group index g of a non-dispersive
    sample gives g k0 = (beta^2 + kc^2) / beta, and M brings beta_M = -(phase + 2 pi M) / d
    closest to the root of that quadratic (g k0 itself in free space)."""
    group = _group_index(f, phase, length, use)
    idx = np.flatnonzero(use)
    width = min(len(idx), max(BRANCH_MIN_POINTS, int(np.ceil(BRANCH_WINDOW * len(idx)))))

    def spread(w):
        g = group[w]
        return np.ptp(g) / max(abs(np.median(g)), 1e-12)

    lo, hi = idx[:width], idx[-width:]
    idx = lo if spread(lo) <= spread(hi) else hi
    k, ph = k0[idx], phase[idx]
    gk = group[idx] * k
    target = (gk + np.sqrt(np.maximum(gk ** 2 - 4 * kc ** 2, 0.0))) / 2
    m0 = int(np.round(np.median((-target * length - ph) / (2 * np.pi))))
    cands = range(m0 - 2, m0 + 3)
    cost = [np.median(np.abs(-(ph + 2 * np.pi * m) / length - target) / k) for m in cands]
    best = int(np.argmin(cost))
    return list(cands)[best], float(cost[best] / np.median(2 * np.pi / (k * length)))


# ---------------------------------------------------------------------------- NIST iterative

def slab_s_single(f, eps, d: float, unit: float = 1e-3, mu=1.0, kc: float = 0.0, beta0=None):
    """Closed-form S11 and S21 of one slab (complex eps, mu; arrays or scalars) in vacuum, or in
    a guide with cut-off wavenumber ``kc`` and empty-guide ``beta0`` (see :func:`nrw`)."""
    k0 = _effective_k0(f, kc, beta0)
    eps, mu = np.asarray(eps, complex), np.asarray(mu, complex)
    # principal roots: for Re(eps mu) > 0 they are the decaying wave (Im n <= 0 for a lossy
    # sample, e^{+j w t}) and stay holomorphic across the real axis, which the Gauss-Newton
    # iteration of nist_eps needs (a lossless sample sits on that axis)
    beta_s = np.sqrt(eps * mu * k0 ** 2 - kc ** 2)
    eta = mu * np.sqrt(k0 ** 2 - kc ** 2) / beta_s        # Z_s / Z_0: sqrt(mu / eps) when kc = 0
    r = (eta - 1) / (eta + 1)
    h = np.exp(-1j * beta_s * d * unit)
    den = 1 - r ** 2 * h ** 2
    return r * (1 - h ** 2) / den, (1 - r ** 2) * h / den


def nist_eps(f, s11, s21, d: float, unit: float = 1e-3, start=None, max_iter: int = NIST_MAX_ITER,
             tol: float = NIST_TOL, kc: float = 0.0, beta0=None) -> dict:
    """eps_r(f) of a non-magnetic sample (mu_r = 1) by the NIST iterative method.

    ``start`` (complex eps at the first frequency of the continuation) defaults to the NRW value
    at the lowest reliable frequency. Returns ``eps_r``, ``tan_d``, ``iterations``,
    ``converged`` and ``residual`` (|S_model - S| over S11 and S21, per frequency). ``kc`` and
    ``beta0``: the guided form, as for :func:`nrw`.
    """
    f = np.asarray(f, float)
    s11, s21 = np.asarray(s11, complex), np.asarray(s21, complex)
    k = 0
    if start is None:
        r = nrw(f, s11, s21, d, unit, nonmagnetic=True, kc=kc, beta0=beta0)
        rel = np.flatnonzero(r["reliable"] & np.isfinite(r["eps_r"]))
        if not len(rel):
            raise ValueError("NIST: no reliable NRW value to start from; pass start=")
        k = int(rel[0])
        start = r["eps_r"][k]
    eps = np.full(len(f), np.nan + 0j)
    iters = np.zeros(len(f), int)
    conv = np.zeros(len(f), bool)
    resid = np.full(len(f), np.nan)
    b0 = None if beta0 is None else np.asarray(beta0, float)
    order = list(range(k, len(f))) + list(range(k - 1, -1, -1))
    guess = complex(start)
    for i in order:
        if i == k - 1:                       # continue downwards from the start frequency
            guess = eps[k]
        e, it, ok, res = _fit_one(f[i], s11[i], s21[i], d, unit, guess, max_iter, tol, kc,
                                  None if b0 is None else b0[i])
        eps[i], iters[i], conv[i], resid[i] = e, it, ok, res
        guess = e
    return {"eps_r": eps, "tan_d": -eps.imag / eps.real, "iterations": iters, "converged": conv,
            "residual": resid, "start_index": k}


def _fit_one(f, s11, s21, d, unit, eps, max_iter, tol, kc=0.0, beta0=None):
    """Complex Gauss-Newton on r(eps) = [S11_model - S11, S21_model - S21], with step halving."""
    meas = np.array([s11, s21])

    def resid(e):
        a, b = slab_s_single(f, e, d, unit, kc=kc, beta0=beta0)
        return np.array([a, b]) - meas

    r = resid(eps)
    for it in range(1, max_iter + 1):
        h = 1e-7 * max(abs(eps), 1.0)
        jac = (resid(eps + h) - r) / h       # the model is holomorphic in eps
        step = -np.vdot(jac, r) / np.vdot(jac, jac).real
        cost = np.vdot(r, r).real
        for _ in range(20):
            trial = eps + step
            rt = resid(trial)
            if np.vdot(rt, rt).real <= cost:
                break
            step /= 2
        eps, r = trial, rt
        if abs(step) < tol * max(abs(eps), 1.0):
            return eps, it, True, float(np.sqrt(np.vdot(r, r).real))
    return eps, max_iter, False, float(np.sqrt(np.vdot(r, r).real))


# ---------------------------------------------------------------------------- comparison

def compare_material(f, extracted: dict, eps_expected, mu_expected=None, mask=None) -> dict:
    """Largest deviations of extracted eps_r (and mu_r) from expected values over ``mask``
    (default: all finite points): relative error of the real parts, absolute error of the loss
    tangents, and the complex relative error |d eps| / |eps| (``max_rel_eps``, ``max_rel_mu``),
    which stays meaningful where a dispersive eps' crosses zero (Lorentz, Drude) and the other
    two do not."""
    eps = extracted["eps_r"]
    mask = np.isfinite(eps) if mask is None else (np.asarray(mask, bool) & np.isfinite(eps))
    if not mask.any():
        # No trusted data is a failed comparison, never a zero-error success.
        out = {"points": 0, "max_rel_eps_real": float("inf"), "max_abs_tan_d": float("inf"), "max_rel_eps": float("inf")}
        if mu_expected is not None and "mu_r" in extracted:
            out.update(max_rel_mu_real=float("inf"), max_abs_tan_d_mu=float("inf"), max_rel_mu=float("inf"))
        return out
    eps_x = np.asarray(eps_expected, complex)
    out = {"points": int(mask.sum()),
           "max_rel_eps_real": float(np.max(np.abs(eps.real - eps_x.real)[mask] / np.abs(eps_x.real[mask]))),
           "max_abs_tan_d": float(np.max(np.abs(extracted["tan_d"] - (-eps_x.imag / eps_x.real))[mask])),
           "max_rel_eps": float(np.max(np.abs(eps - eps_x)[mask] / np.abs(eps_x[mask])))}
    if mu_expected is not None and "mu_r" in extracted:
        mu, mu_x = extracted["mu_r"], np.asarray(mu_expected, complex)
        out["max_rel_mu_real"] = float(np.max(np.abs(mu.real - mu_x.real)[mask] / np.abs(mu_x.real[mask])))
        out["max_abs_tan_d_mu"] = float(np.max(np.abs(extracted["tan_d_mu"] - (-mu_x.imag / mu_x.real))[mask]))
        out["max_rel_mu"] = float(np.max(np.abs(mu - mu_x)[mask] / np.abs(mu_x[mask])))
    return out
