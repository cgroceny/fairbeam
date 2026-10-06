"""Frequency-dependent (dispersive) materials for openEMS: Debye, Lorentz, Drude and the
Djordjevic-Sarkar wideband model (issue #271).

Conventions are openEMS' own (CSXCAD ``DebyeMaterial`` / ``LorentzMaterial``, matlab
``CalcDebyeMaterial`` / ``CalcLorentzMaterial``), e^{+j w t}, frequencies in Hz, checked against
FDTD runs of a slab in the plane-wave cell (docs/VALIDATION.md section 15c)::

    Debye:    eps(w) = eps_inf + sum_p delta_p / (1 + j w tau_p)                   - j kappa / (w eps0)
    Lorentz:  eps(w) = eps_inf [1 - sum_p wp_p^2 / (w^2 - wL_p^2 - j w / tau_p)]   - j kappa / (w eps0)
    Drude:    Lorentz with wL = 0;    wp = 2 pi f_plasma, wL = 2 pi f_pole

The Lorentz terms are scaled by eps_inf (and the magnetic ones by mu_inf); magnetic dispersion
exists only for Lorentz/Drude.

openEMS 0.37.0rc3's DebyeMaterial diverges once sum(delta) / eps_inf exceeds about 0.55-0.64 in a
1D plane-wave channel and about 0.29-0.33 in 3D (a closed PEC cavity, no PML), depending on the
mesh, for one pole or several, at openEMS' own timestep (docs/VALIDATION.md section 15c; reported
as https://github.com/thliebig/openEMS/issues/229, also on master). Physical Debye media often
exceed that by far, and a Djordjevic-Sarkar FR4 laminate (0.25) is at the 3D limit. Its LorentzMaterial is stable in all
of those cases. So Debye poles describe a material here but are never given to openEMS as such:
Simulation.dispersive realizes them, like a Djordjevic-Sarkar laminate or a measured eps_r(f), as
a fit of overdamped Lorentz poles over the band (fairbeam.debye_fit.fit_model), which is passive,
causal and Debye-like below the poles' damping rate. :meth:`Dispersion.add_to` refuses Debye poles.

Every pole must be resolved by the FDTD timestep (:func:`resolution_problems`).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

def _finite(value, name: str, *, positive: bool = False):
    if not np.isfinite(value) or (value <= 0 if positive else value < 0):
        bound = "positive" if positive else "non-negative"
        raise ValueError(f"{name} must be finite and {bound}")


def _frequencies(f):
    f = np.asarray(f, float)
    if not np.all(np.isfinite(f)) or np.any(f < 0):
        raise ValueError("frequencies must be finite and non-negative")
    return f


EPS0 = 8.8541878128e-12
TWO_PI = 2 * np.pi

#: largest dt / tau of a pole (relaxation time, Lorentz damping 1 / gamma)
DT_PER_TAU_MAX = 0.5
#: largest omega dt of a Lorentz pole or plasma frequency
OMEGA_DT_MAX = 0.5
#: Djordjevic-Sarkar defaults: the model's corner frequencies are 10^m1 and 10^m2 rad/s
DS_M1, DS_M2 = 4.0, 12.0
#: result kind of a saved Dispersion (fairbeam debye-fit)
DISPERSION_KIND = "fairbeam.dispersion"

#: openEMS issue for the DebyeMaterial instability (reproduced on 0.37.0rc3 and on master 6970767)
OPENEMS_DEBYE_ISSUE = "https://github.com/thliebig/openEMS/issues/229"
NATIVE_DEBYE = ("openEMS 0.37.0rc3's DebyeMaterial is unstable once sum(delta) / eps_inf exceeds about 0.3 in 3D "
                f"(0.6 in 1D; docs/VALIDATION.md section 15c, {OPENEMS_DEBYE_ISSUE}): Debye poles are given to openEMS as "
                "fitted Lorentz poles; use Simulation.dispersive, or fairbeam.debye_fit.fit_model for the poles")


@dataclass(frozen=True)
class Debye:
    """A Debye relaxation: delta / (1 + j w tau)."""
    delta: float
    tau: float

    def __post_init__(self):
        _finite(self.delta, "Debye delta")
        _finite(self.tau, "Debye tau", positive=True)

    def term(self, w):
        return self.delta / (1 + 1j * w * self.tau)

    def to_dict(self) -> dict:
        return {"type": "debye", "delta": self.delta, "tau": self.tau}


@dataclass(frozen=True)
class Lorentz:
    """A Lorentz pole in openEMS' form: -scale wp^2 / (w^2 - wL^2 - j w / tau) with wp = 2 pi
    f_plasma and wL = 2 pi f_pole (Hz); ``scale`` is eps_inf (or mu_inf). f_pole = 0 is Drude."""
    f_plasma: float
    f_pole: float
    tau: float

    def __post_init__(self):
        _finite(self.f_plasma, "plasma frequency")
        _finite(self.f_pole, "pole frequency")
        _finite(self.tau, "Lorentz tau", positive=True)

    def term(self, w, scale: float = 1.0):
        if self.f_plasma == 0:
            return np.zeros_like(w, dtype=complex)
        wp, wl = TWO_PI * self.f_plasma, TWO_PI * self.f_pole
        return -scale * wp ** 2 / (w ** 2 - wl ** 2 - 1j * w / self.tau)

    def to_dict(self) -> dict:
        return {"type": "lorentz", "f_plasma": self.f_plasma, "f_pole": self.f_pole, "tau": self.tau}


def Drude(f_plasma: float, tau: float) -> Lorentz:   # noqa: N802 - a constructor, like the classes
    """A Drude pole: a Lorentz pole at zero frequency."""
    return Lorentz(f_plasma, 0.0, tau)


def _pole(d: dict):
    kind = d.get("type")
    if kind == "debye":
        return Debye(float(d["delta"]), float(d["tau"]))
    if kind in ("lorentz", "drude"):
        return Lorentz(float(d["f_plasma"]), float(d.get("f_pole", 0.0)), float(d["tau"]))
    raise ValueError(f"unknown pole type {kind!r} (debye, lorentz or drude)")


@dataclass(frozen=True)
class Dispersion:
    """A dispersive material: eps_inf and eps poles (Debye, Lorentz or Drude), a static
    conductivity ``kappa`` (S/m), and mu_inf with Lorentz/Drude mu poles. ``source`` is free
    metadata (e.g. the Djordjevic-Sarkar parameters and the fit report it came from). A material
    with Debye poles is realized for openEMS by Simulation.dispersive (module docstring)."""
    eps_inf: float = 1.0
    eps_poles: tuple = ()
    kappa: float = 0.0
    mu_inf: float = 1.0
    mu_poles: tuple = ()
    source: dict | None = field(default=None, compare=False)

    def __post_init__(self):
        object.__setattr__(self, "eps_poles", tuple(self.eps_poles))
        object.__setattr__(self, "mu_poles", tuple(self.mu_poles))
        if any(not isinstance(p, (Debye, Lorentz)) for p in self.eps_poles):
            raise ValueError("eps poles must be Debye, Lorentz or Drude")
        if any(not isinstance(p, Lorentz) for p in self.mu_poles):
            raise ValueError("mu poles must be Lorentz or Drude (openEMS has no magnetic Debye material)")
        _finite(self.eps_inf, "eps_inf", positive=True)
        _finite(self.mu_inf, "mu_inf", positive=True)
        _finite(self.kappa, "kappa")
        for p in self.eps_poles + self.mu_poles:
            _finite(p.tau, "pole tau", positive=True)
            if isinstance(p, Debye):
                _finite(p.delta, "Debye delta")
            if isinstance(p, Lorentz):
                _finite(p.f_plasma, "plasma frequency")
                _finite(p.f_pole, "pole frequency")

    @property
    def model(self) -> str:
        if any(isinstance(p, Debye) for p in self.eps_poles):
            return "debye"
        return "lorentz" if (self.eps_poles or self.mu_poles) else "constant"

    def eps(self, f):
        """Complex relative permittivity at ``f`` (Hz)."""
        f = _frequencies(f)
        if np.any(f == 0) and (self.kappa or any(isinstance(p, Lorentz) and p.f_pole == 0 and p.f_plasma > 0 for p in self.eps_poles)):
            raise ValueError("a conductive or Drude permittivity is singular at zero frequency")
        w = TWO_PI * f
        e = np.full(np.shape(f), self.eps_inf, complex)
        for p in self.eps_poles:
            e = e + (p.term(w) if isinstance(p, Debye) else p.term(w, self.eps_inf))
        if self.kappa:
            e = e - 1j * self.kappa / (w * EPS0)
        return e

    def mu(self, f):
        """Complex relative permeability at ``f`` (Hz)."""
        f = _frequencies(f)
        if np.any(f == 0) and any(p.f_pole == 0 and p.f_plasma > 0 for p in self.mu_poles):
            raise ValueError("a Drude permeability is singular at zero frequency")
        w = TWO_PI * f
        m = np.full(np.shape(f), self.mu_inf, complex)
        for p in self.mu_poles:
            m = m + p.term(w, self.mu_inf)
        return m

    def tan_d(self, f):
        e = self.eps(f)
        return -e.imag / e.real

    # ---------------------------------------------------------------- openEMS
    def add_to(self, csx, name: str):
        """Create the CSXCAD property (a LorentzMaterial, or a plain Material without poles) and
        return it. Debye poles are refused (``NATIVE_DEBYE``): realize them first."""
        if self.model == "constant":
            return csx.AddMaterial(name, epsilon=self.eps_inf, mue=self.mu_inf, kappa=self.kappa)
        if self.model == "debye":
            raise ValueError(NATIVE_DEBYE)
        from CSXCAD.CSProperties import CSProperties

        order = max(len(self.eps_poles), len(self.mu_poles))
        prop = CSProperties.fromTypeName("LorentzMaterial", csx.GetParameterSet(), order=order, epsilon=self.eps_inf,
                                         mue=self.mu_inf, kappa=self.kappa)
        prop.SetName(name)
        csx.AddProperty(prop)
        for k in range(order):
            kw = {}
            if k < len(self.eps_poles):
                p = self.eps_poles[k]
                kw.update(eps_plasma=float(p.f_plasma), eps_pole_freq=float(p.f_pole), eps_relax=float(p.tau))
            if k < len(self.mu_poles):
                p = self.mu_poles[k]
                kw.update(mue_plasma=float(p.f_plasma), mue_pole_freq=float(p.f_pole), mue_relax=float(p.tau))
            prop.SetDispersiveMaterialProperty(k, **kw)
        return prop

    # ---------------------------------------------------------------- serialisation
    def to_dict(self) -> dict:
        d = {"model": self.model, "eps_inf": self.eps_inf, "kappa": self.kappa,
             "eps_poles": [p.to_dict() for p in self.eps_poles]}
        if self.mu_inf != 1.0 or self.mu_poles:
            d.update(mu_inf=self.mu_inf, mu_poles=[p.to_dict() for p in self.mu_poles])
        if self.source:
            d["source"] = self.source
        return d

    @classmethod
    def from_dict(cls, d: dict) -> Dispersion:
        """The pole model of :meth:`to_dict`. A dictionary of another model (a Djordjevic-Sarkar
        laminate) is refused rather than read as poles it does not have; :func:`model_from_dict`
        takes either."""
        model = d.get("model")
        if model not in (None, "debye", "lorentz", "constant"):
            raise ValueError(f"not a pole model: {model!r} (use fairbeam.dispersion.model_from_dict)")
        return cls(float(d.get("eps_inf", 1.0)), tuple(_pole(p) for p in d.get("eps_poles", [])),
                   float(d.get("kappa", 0.0)), float(d.get("mu_inf", 1.0)),
                   tuple(_pole(p) for p in d.get("mu_poles", [])), d.get("source"))

    def save(self, path) -> Path:
        path = Path(path)
        path.write_text(json.dumps({"kind": DISPERSION_KIND, "version": 1, **self.to_dict()}, indent=1),
                        encoding="utf-8")
        return path

    @classmethod
    def load(cls, path) -> Dispersion:
        d = json.loads(Path(path).read_text(encoding="utf-8"))
        if d.get("kind") not in (None, DISPERSION_KIND):
            raise ValueError(f"{path}: not an {DISPERSION_KIND} file")
        return cls.from_dict(d)


def resolution_problems(disp: Dispersion, dt: float) -> list[str]:
    """The poles the FDTD timestep ``dt`` (s) does not resolve: dt / tau above DT_PER_TAU_MAX
    (openEMS skips a Debye pole with too small a relaxation time without failing the run), or an
    omega dt of a pole or plasma frequency above OMEGA_DT_MAX. Empty when all are resolved."""
    _finite(dt, "timestep", positive=True)
    out = []
    for label, poles in (("eps", disp.eps_poles), ("mu", disp.mu_poles)):
        for k, p in enumerate(poles):
            name = f"{label} pole {k + 1} ({type(p).__name__})"
            if dt / p.tau > DT_PER_TAU_MAX:
                out.append(f"{name}: tau {p.tau:.3g} s is below {1 / DT_PER_TAU_MAX:g} timesteps ({dt:.3g} s)")
            if isinstance(p, Lorentz):
                for what, fr in (("pole", p.f_pole), ("plasma", p.f_plasma)):
                    if TWO_PI * fr * dt > OMEGA_DT_MAX:
                        out.append(f"{name}: {what} frequency {fr / 1e9:.4g} GHz gives omega dt "
                                   f"{TWO_PI * fr * dt:.2f} > {OMEGA_DT_MAX:g}")
    return out


# ---------------------------------------------------------------------------- Djordjevic-Sarkar

@dataclass(frozen=True)
class DjordjevicSarkar:
    """The wideband Debye (Djordjevic-Sarkar) model of a laminate::

        eps(w) = eps_inf + delta / (m2 - m1) * log10((w2 + j w) / (w1 + j w)),   w_i = 10^m_i rad/s

    a continuous distribution of Debye relaxations between w1 and w2, so that eps' falls slowly
    and tan d is nearly constant in between (Djordjevic et al., IEEE Trans. EMC 43(4), 2001).
    It is causal but has no finite pole form: :func:`fairbeam.debye_fit.fit_ds` gives openEMS a
    sum of poles fitted over the simulation band."""
    eps_inf: float
    delta: float
    m1: float = DS_M1
    m2: float = DS_M2

    def __post_init__(self):
        if not np.isfinite(self.m1) or not np.isfinite(self.m2) or not self.m2 > self.m1:
            raise ValueError("Djordjevic-Sarkar needs m2 > m1")
        with np.errstate(over="ignore", under="ignore"):
            corners = np.power(10.0, [self.m1, self.m2])
        if not np.all(np.isfinite(corners)) or np.any(corners <= 0):
            raise ValueError("Djordjevic-Sarkar corner frequencies must be finite and positive")
        _finite(self.delta, "Djordjevic-Sarkar delta")
        _finite(self.eps_inf, "Djordjevic-Sarkar eps_inf", positive=True)

    def _log(self, f):
        w = TWO_PI * _frequencies(f)
        return np.log10((10 ** self.m2 + 1j * w) / (10 ** self.m1 + 1j * w)) / (self.m2 - self.m1)

    def eps(self, f):
        return self.eps_inf + self.delta * self._log(f)

    def tan_d(self, f):
        e = self.eps(f)
        return -e.imag / e.real

    @classmethod
    def from_datasheet(cls, points, m1: float = DS_M1, m2: float = DS_M2) -> DjordjevicSarkar:
        """The model through datasheet values ``[(f_Hz, eps_r, tan_d), ...]``: exact for one
        point, least squares (real and imaginary parts, relative) for several."""
        pts = [(float(f), float(e), float(t)) for f, e, t in points]
        if not pts:
            raise ValueError("Djordjevic-Sarkar needs at least one (f, eps_r, tan_d) point")
        unit = cls(1.0, 1.0, m1, m2)
        rows, rhs = [], []
        for f, e, t in pts:
            _finite(f, "datasheet frequency", positive=True)
            _finite(e, "datasheet eps_r", positive=True)
            _finite(t, "datasheet tan_d")
            g = unit._log(f)
            scale = 1 / e
            rows += [[scale, g.real * scale], [0.0, -g.imag * scale]]
            rhs += [1.0, t]          # eps' / eps' = 1, eps'' / eps' = tan d
        (eps_inf, delta), *_ = np.linalg.lstsq(np.array(rows), np.array(rhs), rcond=None)
        return cls(float(eps_inf), float(delta), m1, m2)

    def to_dict(self) -> dict:
        return {"model": "djordjevic-sarkar", "eps_inf": self.eps_inf, "delta": self.delta,
                "m1": self.m1, "m2": self.m2}

    @classmethod
    def from_dict(cls, d: dict) -> DjordjevicSarkar:
        if d.get("model") != "djordjevic-sarkar":
            raise ValueError(f"not a Djordjevic-Sarkar model: {d.get('model')!r}")
        return cls(float(d["eps_inf"]), float(d["delta"]), float(d.get("m1", DS_M1)), float(d.get("m2", DS_M2)))


def model_from_dict(d: dict):
    """A material model from its ``to_dict()``: a :class:`DjordjevicSarkar` laminate for
    ``"model": "djordjevic-sarkar"``, a :class:`Dispersion` for ``"debye"``, ``"lorentz"`` and
    ``"constant"`` (or no model, as in older pole dictionaries). Any other model is an error, so
    that no frequency dependence is dropped silently."""
    if not isinstance(d, dict):
        raise TypeError(f"a material model dictionary is expected, not {type(d).__name__}")
    if d.get("model") == "djordjevic-sarkar":
        return DjordjevicSarkar.from_dict(d)
    return Dispersion.from_dict(d)
