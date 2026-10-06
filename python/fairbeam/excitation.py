"""Excitation signals.

openEMS' built-in Gaussian is a *modulated* pulse. When the requested band is wide relative to its
centre (f_min / f_max small, e.g. 0.5-8 GHz) that pulse carries a noticeable DC component. The
static charge it deposits never radiates away, so the field energy plateaus above the end criterion
and the run spins until the timestep limit. S-parameters are unaffected, but the run is ~10x longer.

The derivative of a Gaussian has exactly zero DC content, which avoids the plateau entirely.
"""

import numpy as np

# f / f_peak at which |S(f)| of a Gaussian derivative falls to -20 dB of its peak
_MINUS_20_DB_RATIO = 2.76


def dgauss_expression(f_max: float) -> str:
    """fparser expression for a unit-peak Gaussian-derivative pulse, -20 dB at ``f_max``.

    Spectrum: |S(f)| ~ f * exp(-(pi f tau)^2), peak at f_p = 1 / (sqrt(2) pi tau).
    """
    f_peak = f_max / _MINUS_20_DB_RATIO
    tau = 1.0 / (np.sqrt(2.0) * np.pi * f_peak)
    t0 = 5.0 * tau
    # x * exp(-x^2) peaks at 1/sqrt(2e); scale to unit amplitude
    scale = np.sqrt(2.0 * np.e)
    return f"-{scale:.8f}*((t-{t0:.6e})/{tau:.6e})*exp(-((t-{t0:.6e})/{tau:.6e})^2)"


def dgauss_duration_s(f_max: float) -> float:
    """Length (s) of :func:`dgauss_expression`'s pulse: 10 tau (centred at 5 tau). The end criterion
    can only be met after it (fairbeam.design_checks has the same formula without numpy)."""
    return 10.0 / (np.sqrt(2.0) * np.pi * f_max / _MINUS_20_DB_RATIO)


def dgauss_relative_level_db(f: np.ndarray, f_max: float) -> np.ndarray:
    """Relative spectral level (dB re. peak) of :func:`dgauss_expression` at frequencies ``f``."""
    x = np.asarray(f, dtype=float) / (f_max / _MINUS_20_DB_RATIO)
    with np.errstate(divide="ignore"):
        return 20.0 * np.log10(x * np.exp((1.0 - x**2) / 2.0))
