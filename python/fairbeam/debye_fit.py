"""Fit a pole model to eps_r(f): a Djordjevic-Sarkar laminate, a measured or an NRW-extracted
permittivity (issue #271), for use in any model through ``Simulation.dispersive``.

The model is eps_inf + sum_k of overdamped Lorentz poles, each a Debye-like relaxation::

    eps(w) = eps_inf + sum_k d_k wL_k^2 / (wL_k^2 - w^2 + j w gamma),   d_k >= 0, eps_inf >= 1

which openEMS runs as a LorentzMaterial (fairbeam.dispersion: f_plasma = f_pole sqrt(d_k /
eps_inf), tau = 1 / gamma). A pole relaxes at w_k = wL_k^2 / gamma; below gamma it is a Debye
pole of strength d_k. The poles are not Debye poles because openEMS 0.37.0rc3 is unstable with
more than one of those. The relaxation frequencies are log-spaced over the fit range and the
strengths come from non-negative least squares on the real and imaginary parts (relative to
|eps|), so the result is passive and causal (Kramers-Kronig) by construction, and what openEMS
simulates is exactly the fitted function.

The poles must be resolved by the FDTD timestep dt (fairbeam.dispersion.resolution_problems, _finite):
gamma = DT_PER_TAU_MAX / dt (the fastest damping that is resolved) and the highest relaxation
frequency is capped so that omega dt of every pole frequency stays within OMEGA_DT_MAX. Without a
known dt the fit assumes the material is meshed as a uniform cube of DT_CELLS_PER_WAVELENGTH cells
per wavelength at f_max inside it (dt = 1 / (cpw sqrt(3) sqrt(eps_r') f_max), the CFL limit); a
run checks the poles against its real timestep (``run_stats["dispersion_problems"]``), and the
material cell refuses to run with unresolved poles.

    fairbeam debye-fit --datasheet 1e9:4.4:0.02 --f-min 1e9 --f-max 10e9 -o fr4.dispersion.json
    fairbeam debye-fit result.cell.json --method nist -o measured.dispersion.json
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import numpy as np

from .dispersion import (DT_PER_TAU_MAX, OMEGA_DT_MAX, TWO_PI, Dispersion, DjordjevicSarkar, Lorentz,
                         resolution_problems, _finite)

#: the uniform-cube mesh density behind the default timestep estimate
DT_CELLS_PER_WAVELENGTH = 20
#: a Djordjevic-Sarkar laminate is fitted from f_min / DS_SPAN to f_max * DS_SPAN
DS_SPAN = 10.0
#: default number of candidate poles: this many per decade of the fit range, at least MIN_POLES
#: (non-negative least squares sets the ones it does not need to zero, and they are dropped)
POLES_PER_DECADE = 4.0
MIN_POLES = 5
FIT_POINTS = 400
#: the poles stay this fraction inside the resolution limits (rounding must not cross them)
LIMIT_MARGIN = 0.98


def default_dt(f_max: float, eps_r: float = 1.0) -> float:
    """The CFL timestep of a uniform cubic mesh of DT_CELLS_PER_WAVELENGTH cells per wavelength
    at f_max in a material of ``eps_r`` (which the material's own region needs)."""
    _finite(f_max, "maximum frequency", positive=True)
    _finite(eps_r, "permittivity estimate", positive=True)
    return 1 / (DT_CELLS_PER_WAVELENGTH * np.sqrt(3) * np.sqrt(max(eps_r, 1.0)) * f_max)


def pole_limits(dt: float) -> tuple[float, float]:
    """(gamma, f_relax_max): the damping of every pole and the highest relaxation frequency (Hz)
    that keep omega_pole dt <= OMEGA_DT_MAX and dt gamma <= DT_PER_TAU_MAX."""
    _finite(dt, "timestep", positive=True)
    gamma = LIMIT_MARGIN * DT_PER_TAU_MAX / dt
    w_max = (LIMIT_MARGIN * OMEGA_DT_MAX / dt) ** 2 / gamma
    return gamma, w_max / TWO_PI


def _basis(f, f_relax, gamma):
    """(n_f, n_poles) overdamped Lorentz poles of unit low-frequency strength relaxing at f_relax."""
    w = TWO_PI * np.asarray(f, float)[:, None]
    wl2 = TWO_PI * np.asarray(f_relax, float)[None, :] * gamma
    return wl2 / (wl2 - w ** 2 + 1j * w * gamma)


def nnls(a, b, max_iter: int | None = None, tol: float | None = None):
    """Non-negative least squares min ||a x - b||, x >= 0 (Lawson and Hanson, ch. 23)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    if a.ndim != 2 or b.shape != (a.shape[0],) or not a.size or not np.all(np.isfinite(a)) or not np.all(np.isfinite(b)):
        raise ValueError("nnls needs a finite nonempty matrix and matching finite vector")
    if max_iter is not None and (not isinstance(max_iter, (int, np.integer)) or max_iter < 1):
        raise ValueError("max_iter must be a positive integer")
    if tol is not None:
        _finite(tol, "nnls tolerance", positive=True)
    m, n = a.shape
    max_iter = max_iter or 3 * n
    tol = tol or 10 * np.finfo(float).eps * np.linalg.norm(a, 1) * max(m, n)
    x = np.zeros(n)
    passive = np.zeros(n, bool)
    w = a.T @ (b - a @ x)
    it = 0
    while (~passive).any() and np.max(np.where(~passive, w, -np.inf)) > tol:
        j = int(np.argmax(np.where(~passive, w, -np.inf)))
        passive[j] = True
        while True:
            it += 1
            if it > max_iter * 10:
                raise RuntimeError("nnls did not converge")
            z = np.zeros(n)
            z[passive] = np.linalg.lstsq(a[:, passive], b, rcond=None)[0]
            if np.all(z[passive] > 0):
                x = z
                break
            neg = passive & (z <= 0)
            alpha = np.min(x[neg] / (x[neg] - z[neg]))
            x = x + alpha * (z - x)
            passive &= x > tol
            x[~passive] = 0.0
        w = a.T @ (b - a @ x)
    return x


def fit(f, eps, *, n_poles: int | None = None, f_lo: float | None = None, f_hi: float | None = None,
        dt: float | None = None, f_max: float | None = None, fit_kappa: bool = False, source: dict | None = None):
    """Fit eps_inf + overdamped Lorentz poles to complex eps(f) samples.

    ``f_lo``, ``f_hi`` bound the pole relaxation frequencies (default: the data range); the upper
    one is capped by the timestep (``dt``, default :func:`default_dt` of ``f_max`` or of the
    highest sample). ``fit_kappa`` adds a static conductivity. Returns ``(Dispersion, report)``.
    """
    f = np.asarray(f, float)
    eps = np.asarray(eps, complex)
    if f.ndim != 1 or eps.shape != f.shape:
        raise ValueError("fit needs matching one-dimensional frequency and permittivity arrays")
    for name, value in (("f_lo", f_lo), ("f_hi", f_hi), ("dt", dt), ("f_max", f_max)):
        if value is not None:
            _finite(value, name, positive=True)
    if n_poles is not None and (not isinstance(n_poles, (int, np.integer)) or n_poles < 1):
        raise ValueError("n_poles must be a positive integer")
    ok = np.isfinite(eps) & np.isfinite(f) & (f > 0)
    f, eps = f[ok], eps[ok]
    if len(f) < 3:
        raise ValueError(f"debye_fit needs at least three valid samples, got {len(f)}")
    f_max = f_max or f.max()
    dt = dt or default_dt(f_max, float(np.max(eps.real)))
    gamma, f_cap = pole_limits(dt)
    lo, hi = f_lo or f.min(), min(f_hi or f.max(), f_cap)
    if hi <= lo:
        raise ValueError(f"the timestep {dt:.3g} s allows relaxation frequencies only up to {f_cap / 1e9:.3g} GHz, "
                         f"below the fit range from {lo / 1e9:.3g} GHz")
    decades = np.log10(hi / lo)
    n = n_poles or max(MIN_POLES, int(np.ceil(POLES_PER_DECADE * decades)) + 1)
    unknowns = 1 + n + (1 if fit_kappa else 0)
    if len(f) < unknowns:
        raise ValueError(f"only {len(f)} valid samples for {n} candidate poles: the fit has {unknowns} unknowns "
                         f"(eps_inf, the poles{', kappa' if fit_kappa else ''}) and needs at least that many samples; "
                         "use fewer poles (--poles) or more valid frequencies")
    f_relax = np.geomspace(lo, hi, n)
    cols = [np.ones(len(f), complex), _basis(f, f_relax, gamma)]
    if fit_kappa:
        cols.append(-1j / (TWO_PI * f[:, None] * 8.8541878128e-12))
    basis = np.column_stack([c if c.ndim == 2 else c[:, None] for c in cols])
    # A finite absolute weight handles a physical zero of permittivity.
    scale = 1 / np.maximum(np.abs(eps), np.finfo(float).eps)
    rhs = eps - 1.0                                           # eps_inf = 1 + x0, x0 >= 0
    a = np.vstack([(basis * scale[:, None]).real, (basis * scale[:, None]).imag])
    b = np.concatenate([(rhs * scale).real, (rhs * scale).imag])
    norms = np.linalg.norm(a, axis=0)
    norms[norms == 0] = 1.0
    x = nnls(a / norms, b) / norms
    eps_inf = 1.0 + x[0]
    strengths = x[1:1 + n]
    kappa = float(x[-1]) if fit_kappa else 0.0
    poles = tuple(Lorentz(float(fr * np.sqrt(d / eps_inf)), float(fr), float(1 / gamma))
                  for fr, d in zip(np.sqrt(f_relax * gamma / TWO_PI), strengths) if d > 0)
    disp = Dispersion(float(eps_inf), poles, kappa, source=source)
    return disp, report(disp, f, eps, dt)


def report(disp: Dispersion, f, eps, dt: float | None = None) -> dict:
    """Fit errors of ``disp`` against eps(f): eps_r' relative and tan d absolute (max and rms), and
    the complex relative error |d eps| / |eps| (``max_rel_eps``), which stays meaningful where a
    Lorentz or Drude eps' crosses zero."""
    model = disp.eps(f)
    rel = np.abs(model.real - eps.real) / np.abs(eps.real)
    dtan = np.abs(-model.imag / model.real - (-eps.imag / eps.real))
    out = {"points": int(len(f)), "f_min": float(np.min(f)), "f_max": float(np.max(f)), "poles": len(disp.eps_poles),
           "max_rel_eps_real": float(rel.max()), "rms_rel_eps_real": float(np.sqrt(np.mean(rel ** 2))),
           "max_abs_tan_d": float(dtan.max()), "rms_abs_tan_d": float(np.sqrt(np.mean(dtan ** 2))),
           "max_rel_eps": float(np.max(np.abs(model - eps) / np.abs(eps)))}
    if dt is not None:
        out["dt"] = float(dt)
        out["resolution_problems"] = resolution_problems(disp, dt)
    return out


def fit_model(model, f_min: float, f_max: float, *, n_poles: int | None = None, dt: float | None = None,
              span: float = DS_SPAN):
    """Any eps(f) model (an object with ``eps(f)`` and ``to_dict()``: a Djordjevic-Sarkar laminate,
    a Debye Dispersion) as poles for the band f_min..f_max, fitted from f_min / span to
    f_max * span (the edges of the band need the relaxations outside it). A Dispersion keeps its
    static conductivity, its mu (Lorentz) poles and its Lorentz / Drude eps poles (their plasma
    frequencies rescaled to the fitted eps_inf, which openEMS multiplies them by); only eps_inf
    and the Debye poles are fitted, since the overdamped poles cannot represent a resonance or an
    eps' below 1. Returns ``(Dispersion, report)``; the report's errors are over the band itself."""
    _finite(f_min, "minimum frequency", positive=True)
    _finite(f_max, "maximum frequency", positive=True)
    _finite(span, "fit span", positive=True)
    if f_max <= f_min or span < 1:
        raise ValueError("fit_model needs f_max > f_min and span >= 1")
    if dt is not None:
        _finite(dt, "timestep", positive=True)
    lo, hi = f_min / span, f_max * span
    f = np.geomspace(lo, hi, FIT_POINTS)
    kappa = float(getattr(model, "kappa", 0.0) or 0.0)
    if isinstance(model, Dispersion):
        kept = tuple(p for p in model.eps_poles if isinstance(p, Lorentz))
        base = Dispersion(model.eps_inf, tuple(p for p in model.eps_poles if not isinstance(p, Lorentz)))
        lossless = Dispersion(model.eps_inf, model.eps_poles)
    else:
        kept, base, lossless = (), model, model
    dt = dt or default_dt(f_max, float(np.max(lossless.eps(f).real)))
    disp, _ = fit(f, base.eps(f), n_poles=n_poles, f_lo=lo, f_hi=hi, dt=dt, f_max=f_max,
                  source={**model.to_dict(), "fit": {"f_min": f_min, "f_max": f_max, "span": span}})
    if isinstance(model, Dispersion):
        scale = np.sqrt(model.eps_inf / disp.eps_inf)       # the Lorentz terms are scaled by eps_inf
        kept = tuple(Lorentz(p.f_plasma * scale, p.f_pole, p.tau) for p in kept)
        disp = Dispersion(disp.eps_inf, disp.eps_poles + kept, kappa, model.mu_inf, model.mu_poles,
                          source=disp.source)
    band = np.linspace(f_min, f_max, FIT_POINTS)
    return disp, report(disp, band, model.eps(band), dt)


def fit_ds(ds: DjordjevicSarkar, f_min: float, f_max: float, *, n_poles: int | None = None,
           dt: float | None = None, span: float = DS_SPAN):
    """A Djordjevic-Sarkar laminate as poles for the band f_min..f_max (:func:`fit_model`)."""
    return fit_model(ds, f_min, f_max, n_poles=n_poles, dt=dt, span=span)


# ---------------------------------------------------------------------------- input files

def _mask(values, n: int, what: str, path) -> np.ndarray:
    """A saved boolean mask, checked against the number of frequencies."""
    if not isinstance(values, list) or len(values) != n or not all(isinstance(v, bool) for v in values):
        raise ValueError(f"{path}: {what} must be a list of {n} booleans, one per frequency")
    return np.asarray(values, bool)


def _complex_list(e: dict, n: int, what: str, path) -> np.ndarray:
    re, im = e.get("re"), e.get("im")
    if not isinstance(re, list) or not isinstance(im, list) or len(re) != n or len(im) != n:
        raise ValueError(f"{path}: {what} must hold {n} re and {n} im values, one per frequency")
    return np.array([complex(r if r is not None else np.nan, i if i is not None else np.nan) for r, i in zip(re, im)])


def read_eps(path, method: str = "auto"):
    """``(f, eps, info)`` from a ``.cell.json`` or a CSV.

    A ``.cell.json`` gives ``material.nist`` or ``material.nrw``. By default it leaves out every
    frequency that is not a valid measurement:
    - non-finite eps;
    - |S21| below fairbeam.nrw.S21_FLOOR (an opaque sample, whose phase is not measurable);
    - for NIST, the frequencies where the iteration did not converge (``nist.converged``);
    - for NRW, the ones its ``reliable`` mask rejects (half-wave resonances, and stretches above an
      opaque band without a clear branch).
    The masks are checked against the number of frequencies. A CSV has a header: f (Hz) and
    eps_re, eps_im (eps' - j eps'', so eps_im <= 0 for a lossy sample), or f, eps_r, tan_d; it
    loses only its non-finite rows. ``info`` reports how many frequencies were read, used and
    left out, and why (each one counted under the first reason that applies)."""
    from .nrw import S21_FLOOR

    path = Path(path)
    if path.suffix.lower() == ".json":
        doc = json.loads(path.read_text(encoding="utf-8"))
        mat = doc.get("material")
        if not mat:
            raise ValueError(f"{path}: no material section (run fairbeam material-cell on a sample of positive thickness)")
        if method == "auto":
            method = "nist" if "nist" in mat else "nrw"
        if method not in mat:
            raise ValueError(f"{path}: no {method} result (run fairbeam material-cell with --nist)")
        f = np.asarray(doc["frequency"], float)
        n = len(f)
        eps = _complex_list(mat[method].get("eps_r") or {}, n, f"material.{method}.eps_r", path)
        reasons = [("non_finite", np.isfinite(eps) & (f > 0))]
        if "s21" in doc:
            s21 = _complex_list(doc["s21"], n, "s21", path)
            reasons.append(("low_s21", np.isfinite(s21) & (np.abs(s21) >= S21_FLOOR)))
        if method == "nist":
            if "converged" in mat["nist"]:
                reasons.append(("not_converged", _mask(mat["nist"]["converged"], n, "material.nist.converged", path)))
        else:
            reasons.append(("unreliable", _mask(mat["nrw"].get("reliable"), n, "material.nrw.reliable", path)))
        keep = np.ones(n, bool)
        dropped = {}
        for name, ok in reasons:
            dropped[name] = int((keep & ~ok).sum())
            keep &= ok
        info = {"input": str(path), "method": method, "points": n, "used": int(keep.sum()), "dropped": dropped,
                "s21_floor": S21_FLOOR}
        return f[keep], eps[keep], info
    with path.open(newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(line for line in fh if not line.lstrip().startswith("#")))
    if not rows:
        raise ValueError(f"{path}: no data rows")
    keys = {k.strip().lower(): k for k in rows[0]}
    fk = next((keys[k] for k in ("f", "freq", "frequency", "f_hz") if k in keys), None)
    if fk is None:
        raise ValueError(f"{path}: needs a frequency column (f, freq, frequency or f_hz, in Hz)")
    f = np.array([float(r[fk]) for r in rows])
    if "eps_re" in keys and "eps_im" in keys:
        eps = np.array([complex(float(r[keys["eps_re"]]), float(r[keys["eps_im"]])) for r in rows])
    elif "eps_r" in keys and "tan_d" in keys:
        er = np.array([float(r[keys["eps_r"]]) for r in rows])
        eps = er * (1 - 1j * np.array([float(r[keys["tan_d"]]) for r in rows]))
    else:
        raise ValueError(f"{path}: needs columns eps_re, eps_im or eps_r, tan_d")
    keep = np.isfinite(eps) & np.isfinite(f) & (f > 0)
    info = {"input": str(path), "method": "csv", "points": len(f), "used": int(keep.sum()),
            "dropped": {"non_finite": int((~keep).sum())}}
    return f[keep], eps[keep], info


def _datasheet(text: str):
    try:
        f, e, t = (float(v) for v in text.split(":"))
    except ValueError:
        raise ValueError(f"--datasheet expects F_HZ:EPS_R:TAN_D, got {text!r}") from None
    return f, e, t


# ---------------------------------------------------------------------------- command line

def add_command(sub):
    p = sub.add_parser("debye-fit", help="fit a pole model (overdamped Lorentz) to eps_r(f): a datasheet "
                                         "(Djordjevic-Sarkar), a .cell.json or a CSV")
    p.add_argument("input", nargs="?", help=".cell.json (material-cell result) or CSV (f, eps_re, eps_im | eps_r, tan_d)")
    p.add_argument("--datasheet", action="append", metavar="F_HZ:EPS_R:TAN_D",
                   help="datasheet value for a Djordjevic-Sarkar model (repeat for several frequencies)")
    p.add_argument("--m1", type=float, default=4.0, help="Djordjevic-Sarkar lower corner, 10^m1 rad/s (default 4)")
    p.add_argument("--m2", type=float, default=12.0, help="Djordjevic-Sarkar upper corner, 10^m2 rad/s (default 12)")
    p.add_argument("--f-min", type=float, help="simulation band lower edge in Hz (datasheet: required)")
    p.add_argument("--f-max", type=float, help="simulation band upper edge in Hz (datasheet: required)")
    p.add_argument("--method", choices=["auto", "nist", "nrw"], default="auto",
                   help=".cell.json: which extraction to fit (default: nist if present, else nrw)")
    p.add_argument("--poles", type=int, help="number of poles (default: 4 per decade of the fit range, at least 5)")
    p.add_argument("--dt", type=float, help="FDTD timestep in s the poles must be resolved by "
                                            "(default: CFL of a 20 cells/lambda cubic mesh at f_max)")
    p.add_argument("--kappa", action="store_true", help="also fit a static conductivity (measured data)")
    p.add_argument("-o", "--out", help="write the model here (default: <input>.dispersion.json or ds.dispersion.json)")
    p.set_defaults(func=cmd_debye_fit)


def cmd_debye_fit(args):
    if bool(args.datasheet) == bool(args.input):
        raise ValueError("give either an input file or --datasheet")
    if args.datasheet:
        if args.f_min is None or args.f_max is None:
            raise ValueError("--datasheet needs --f-min and --f-max (the simulation band)")
        ds = DjordjevicSarkar.from_datasheet([_datasheet(t) for t in args.datasheet], args.m1, args.m2)
        disp, rep = fit_ds(ds, args.f_min, args.f_max, n_poles=args.poles, dt=args.dt)
        print(f"fairbeam: Djordjevic-Sarkar eps_inf {ds.eps_inf:.4g}, delta {ds.delta:.4g} "
              f"(m1 {ds.m1:g}, m2 {ds.m2:g})")
        out = Path(args.out or "ds.dispersion.json")
    else:
        f, eps, info = read_eps(args.input, args.method)
        left_out = ", ".join(f"{v} {k.replace('_', ' ')}" for k, v in info["dropped"].items() if v)
        print(f"fairbeam: {info['used']} of {info['points']} frequencies used ({info['method']})"
              + (f"; left out: {left_out}" if left_out else ""))
        disp, rep = fit(f, eps, n_poles=args.poles, f_lo=args.f_min, f_hi=args.f_max, dt=args.dt,
                        fit_kappa=args.kappa, source={"model": "fit", "input": str(args.input), "samples": info})
        name = Path(args.input).name
        for suffix in (".cell.json", ".json", ".csv"):
            if name.lower().endswith(suffix):
                name = name[: -len(suffix)]
                break
        out = Path(args.out or Path(args.input).with_name(name + ".dispersion.json"))
    disp = Dispersion(disp.eps_inf, disp.eps_poles, disp.kappa, source={**(disp.source or {}), "report": rep})
    print(f"fairbeam: {rep['poles']} poles, eps_inf {disp.eps_inf:.4g}: eps_r' within "
          f"{100 * rep['max_rel_eps_real']:.2f} %, tan d within {rep['max_abs_tan_d']:.2g} over "
          f"{rep['f_min'] / 1e9:.4g}-{rep['f_max'] / 1e9:.4g} GHz")
    for msg in rep.get("resolution_problems", []):
        print(f"fairbeam: warning: {msg}", file=sys.stderr)
    disp.save(out)
    print(f"fairbeam: wrote {out}")
    return 0
