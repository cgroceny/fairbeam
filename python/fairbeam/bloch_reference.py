"""Reference kernels for complex Bloch seams on a one-dimensional Yee line.

This module is an isolated mathematical reference. It is not connected to
Fairbeam's run path or to openEMS. Fields are represented as two real arrays,
which lets the seam rotation be compared directly with a complex-valued
reference without adding complex arithmetic to a native real-valued engine.

The convention is exp(-i omega t) * exp(+i k x). The positive-x ghost of E
uses exp(+i theta), and the negative-x ghost of H uses its conjugate. E samples
are at x=i*dx and H samples are at x=(i+1/2)*dx. The returned derivatives are
the 1-D transverse Maxwell pair dE_z/dx (sampled at H_y) and dH_y/dx (sampled
at E_z); with this component choice, both time-update terms have a plus sign.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import TypeAlias

import numpy as np
from numpy.typing import ArrayLike, NDArray

FloatArray: TypeAlias = NDArray[np.float64]


@dataclass(frozen=True)
class FieldQuadratures:
    """A one-dimensional complex field stored as separate real and imaginary arrays."""

    real: ArrayLike
    imag: ArrayLike

    def __post_init__(self) -> None:
        real = np.asarray(self.real)
        imag = np.asarray(self.imag)
        if np.iscomplexobj(real) or np.iscomplexobj(imag):
            raise ValueError("quadrature arrays must be real-valued")
        if not np.issubdtype(real.dtype, np.number) or not np.issubdtype(imag.dtype, np.number):
            raise ValueError("quadrature arrays must contain numeric values")
        real = np.array(real, dtype=np.float64, copy=True)
        imag = np.array(imag, dtype=np.float64, copy=True)
        if real.ndim != 1 or imag.ndim != 1 or real.shape != imag.shape or real.size == 0:
            raise ValueError("quadratures must be non-empty, equal-length one-dimensional arrays")
        if not np.isfinite(real).all() or not np.isfinite(imag).all():
            raise ValueError("quadratures must be finite")
        object.__setattr__(self, "real", real)
        object.__setattr__(self, "imag", imag)

    @property
    def complex(self) -> NDArray[np.complex128]:
        """Return a complex copy for comparisons with a complex reference implementation."""

        return np.asarray(self.real) + 1j * np.asarray(self.imag)


@dataclass(frozen=True)
class YeeCurl1D:
    """Directional derivatives from one 1-D transverse Yee curl stencil."""

    d_electric_dx_at_h: FieldQuadratures
    d_magnetic_dx_at_e: FieldQuadratures


def _finite_scalar(name: str, value: float) -> float:
    if isinstance(value, (bool, np.bool_)):
        raise ValueError(f"{name} must be a finite real scalar")
    try:
        scalar = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{name} must be a finite real scalar") from exc
    if not math.isfinite(scalar):
        raise ValueError(f"{name} must be a finite real scalar")
    return scalar


def _rotate(field: FieldQuadratures, phase_rad: float) -> tuple[FloatArray, FloatArray]:
    """Multiply a quadrature field by exp(i*phase_rad)."""

    cosine = math.cos(phase_rad)
    sine = math.sin(phase_rad)
    real = np.asarray(field.real)
    imag = np.asarray(field.imag)
    return cosine * real - sine * imag, sine * real + cosine * imag


def bloch_yee_curl_1d(
    electric: FieldQuadratures,
    magnetic: FieldQuadratures,
    *,
    phase_rad: float,
    spacing_m: float,
) -> YeeCurl1D:
    """Apply the 1-D Yee derivative pair with a Bloch phase across the seam.

    ``electric`` is sampled at integer positions ``i*spacing_m`` and
    ``magnetic`` at half-cell positions ``(i+1/2)*spacing_m``. On the positive
    seam, the missing electric neighbor is ``electric[0]*exp(+i*phase_rad)``;
    on the negative seam, the missing magnetic neighbor is
    ``magnetic[-1]*exp(-i*phase_rad)``. This orientation makes the two discrete
    derivative operators adjoints with the sign required for lossless energy
    conservation when ``phase_rad`` is real.

    The phase is the unwrapped k*L value in radians. No frequency, constitutive
    update, excitation, PML state, or native solver integration is provided.
    """

    if not isinstance(electric, FieldQuadratures) or not isinstance(magnetic, FieldQuadratures):
        raise TypeError("electric and magnetic fields must be FieldQuadratures")
    if electric.real.shape != magnetic.real.shape:
        raise ValueError("electric and magnetic fields must have the same sample count")
    phase = _finite_scalar("phase_rad", phase_rad)
    spacing = _finite_scalar("spacing_m", spacing_m)
    if spacing <= 0:
        raise ValueError("spacing_m must be greater than zero")

    # Forward E difference at the H locations; only the final sample crosses +x.
    electric_positive_real, electric_positive_imag = _rotate(electric, phase)
    e_next_real = np.empty_like(electric.real)
    e_next_imag = np.empty_like(electric.imag)
    e_next_real[:-1] = electric.real[1:]
    e_next_imag[:-1] = electric.imag[1:]
    e_next_real[-1] = electric_positive_real[0]
    e_next_imag[-1] = electric_positive_imag[0]
    d_e_real = (e_next_real - electric.real) / spacing
    d_e_imag = (e_next_imag - electric.imag) / spacing

    # Backward H difference at the E locations; only the first sample crosses -x.
    magnetic_negative_real, magnetic_negative_imag = _rotate(magnetic, -phase)
    h_prev_real = np.empty_like(magnetic.real)
    h_prev_imag = np.empty_like(magnetic.imag)
    h_prev_real[0] = magnetic_negative_real[-1]
    h_prev_imag[0] = magnetic_negative_imag[-1]
    h_prev_real[1:] = magnetic.real[:-1]
    h_prev_imag[1:] = magnetic.imag[:-1]
    d_h_real = (magnetic.real - h_prev_real) / spacing
    d_h_imag = (magnetic.imag - h_prev_imag) / spacing

    return YeeCurl1D(
        d_electric_dx_at_h=FieldQuadratures(d_e_real, d_e_imag),
        d_magnetic_dx_at_e=FieldQuadratures(d_h_real, d_h_imag),
    )
