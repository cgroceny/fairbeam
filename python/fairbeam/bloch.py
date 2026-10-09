"""Bloch/Floquet mathematics for homogeneous, lossless isotropic half-spaces.

This module is independent of the native solver. It does not admit oblique runs.
SI units, angular wavevectors (rad/m), and exp(-i omega t + i k.r) are used.
Existing openEMS/Fairbeam complex results use the opposite time convention;
they require a verified E/H conjugation, scaling, and collocation adapter.
See docs/BLOCH-FOUNDATION.md for conventions, sources, and sampling limitations.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
from numbers import Integral, Real
from typing import Iterable

import numpy as np

C0 = 299_792_458.0
ETA0 = 376.730313668
MAX_ORDERS = 4096
MAX_GRID_SAMPLES = 1_048_576
CUTOFF_RTOL = 1e-12


def _real(value, name: str) -> float:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Real):
        raise ValueError(f"{name} must be a finite real number")
    try:
        result = float(value)
    except (OverflowError, ValueError):
        raise ValueError(f"{name} must be a finite real number") from None
    if not math.isfinite(result):
        raise ValueError(f"{name} must be a finite real number")
    return result


def _positive(value, name: str) -> float:
    result = _real(value, name)
    if result <= 0:
        raise ValueError(f"{name} must be positive")
    return result


def _vector2(value, name: str) -> tuple[float, float]:
    try:
        if len(value) != 2:
            raise ValueError
        return (_real(value[0], name), _real(value[1], name))
    except (TypeError, IndexError):
        raise ValueError(f"{name} must have two finite real components") from None


def _complex(value, name: str) -> complex:
    if isinstance(value, (bool, np.bool_, str, bytes)):
        raise ValueError(f"{name} must be a finite complex number")
    try:
        result = complex(value)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"{name} must be a finite complex number") from None
    if not math.isfinite(result.real) or not math.isfinite(result.imag):
        raise ValueError(f"{name} must be a finite complex number")
    return result


def _medium(frequency_hz, eps_r, mu_r) -> tuple[float, float, float, float, float]:
    f = _positive(frequency_hz, "frequency_hz")
    eps = _positive(eps_r, "eps_r")
    mu = _positive(mu_r, "mu_r")
    k = (2 * math.pi / C0) * f * math.sqrt(eps) * math.sqrt(mu)
    eta = ETA0 * math.sqrt(mu) / math.sqrt(eps)
    if not math.isfinite(k) or k <= 0 or not math.isfinite(eta) or eta <= 0:
        raise ValueError("Medium wavevector and impedance must be finite and positive")
    return f, eps, mu, k, eta


def _orders(values: Iterable[tuple[int, int]]) -> tuple[tuple[int, int], ...]:
    result = []
    seen = set()
    try:
        iterator = iter(values)
    except TypeError:
        raise ValueError("orders must be an iterable of integer pairs") from None
    for pair in iterator:
        if len(result) >= MAX_ORDERS:
            raise ValueError(f"At most {MAX_ORDERS} diffraction orders are supported")
        try:
            if len(pair) != 2 or any(isinstance(x, (bool, np.bool_)) or
                                     not isinstance(x, Integral) for x in pair):
                raise ValueError
            order = (int(pair[0]), int(pair[1]))
        except (TypeError, IndexError, ValueError):
            raise ValueError("Each diffraction order must be a pair of integers") from None
        if order in seen:
            raise ValueError("Diffraction orders must be unique")
        # Avoid integer-to-float overflow and meaningless floating-point indices.
        if max(abs(order[0]), abs(order[1])) > 2 ** 52:
            raise ValueError("Diffraction order indices exceed exact floating-point range")
        seen.add(order)
        result.append(order)
    if not result:
        raise ValueError("At least one diffraction order is required")
    return tuple(result)


@dataclass(frozen=True)
class Lattice2D:
    """Two non-collinear translation vectors in the xy plane, in meters.

    Vectors are rows; reciprocal rows satisfy a_i dot b_j = 2 pi delta_ij.
    Their orientation may be either handedness. Geometry is bounded to avoid
    ill-conditioned phase inversion; this does not imply a solver mesh.
    """

    a1_m: tuple[float, float]
    a2_m: tuple[float, float]

    def __post_init__(self):
        object.__setattr__(self, "a1_m", _vector2(self.a1_m, "a1_m"))
        object.__setattr__(self, "a2_m", _vector2(self.a2_m, "a2_m"))
        matrix = np.asarray((self.a1_m, self.a2_m))
        scale = float(np.max(np.abs(matrix)))
        if scale == 0:
            raise ValueError("Lattice translations must be non-collinear")
        scaled = matrix / scale
        determinant = float(np.linalg.det(scaled))
        if determinant == 0 or np.linalg.cond(scaled) > 1e12:
            raise ValueError("Lattice translations must be non-collinear and well-conditioned")
        area = abs(determinant) * scale * scale
        if not math.isfinite(area) or area <= 0:
            raise ValueError("Lattice area must be finite and positive")
        reciprocal = (2 * math.pi / scale) * np.linalg.inv(scaled).T
        if not np.isfinite(reciprocal).all():
            raise ValueError("Reciprocal lattice must be finite")

    @property
    def area_m2(self) -> float:
        scale = max(abs(x) for vector in (self.a1_m, self.a2_m) for x in vector)
        return abs(float(np.linalg.det(np.asarray((self.a1_m, self.a2_m)) / scale))) * scale * scale

    @property
    def reciprocal_rad_m(self) -> tuple[tuple[float, float], tuple[float, float]]:
        matrix = np.asarray((self.a1_m, self.a2_m))
        scale = float(np.max(np.abs(matrix)))
        result = (2 * math.pi / scale) * np.linalg.inv(matrix / scale).T
        return tuple(tuple(float(x) for x in row) for row in result)

    def phase_rad(self, kt_rad_m) -> tuple[float, float]:
        """Unwrapped positive-face phases; fields translate by exp(+i phase)."""
        kt = _vector2(kt_rad_m, "kt_rad_m")
        phase = np.asarray((self.a1_m, self.a2_m)) @ kt
        if not np.isfinite(phase).all():
            raise ValueError("Bloch phases must be finite")
        return tuple(float(x) for x in phase)

    def transverse_k_rad_m(self, phases_rad) -> tuple[float, float]:
        """Invert explicitly unwrapped phases; no Brillouin-zone choice is made."""
        phases = _vector2(phases_rad, "phases_rad")
        kt = np.linalg.solve(np.asarray((self.a1_m, self.a2_m)), phases)
        if not np.isfinite(kt).all():
            raise ValueError("Transverse wavevector must be finite")
        return tuple(float(x) for x in kt)


def transverse_k_from_angles(frequency_hz, theta_rad, phi_rad, *, eps_r=1.0,
                             mu_r=1.0) -> tuple[float, float]:
    """Real transverse k at one frequency; theta is from +z, phi from +x.

    Theta is in [0, pi/2]. The longitudinal direction is selected separately.
    This function does not specify constant-angle broadband FDTD excitation.
    """
    _, _, _, k, _ = _medium(frequency_hz, eps_r, mu_r)
    theta = _real(theta_rad, "theta_rad")
    phi = _real(phi_rad, "phi_rad")
    if not 0 <= theta <= math.pi / 2:
        raise ValueError("theta_rad must lie in [0, pi/2]")
    transverse = k * math.sin(theta)
    return (transverse * math.cos(phi), transverse * math.sin(phi))


def fixed_kt_angle_rad(kt_rad_m, frequency_hz, *, eps_r=1.0, mu_r=1.0) -> float:
    """Angle at this frequency for a fixed real kt; reject evanescent incidence."""
    kt = _vector2(kt_rad_m, "kt_rad_m")
    _, _, _, k, _ = _medium(frequency_hz, eps_r, mu_r)
    ratio = math.hypot(*kt) / k
    if ratio > 1 + CUTOFF_RTOL:
        raise ValueError("Fixed transverse wavevector is evanescent at this frequency")
    return math.asin(min(1.0, ratio))


@dataclass(frozen=True)
class FloquetOrder:
    """Derived order in a homogeneous positive, real epsilon/mu half-space.

    kz is the outgoing +z branch: positive real for propagation, positive
    imaginary for decay. For the -z half-space use -kz in exp(i kz z).
    Near-cutoff orders are represented by kz=0 and cannot be decomposed.
    """

    m: int
    n: int
    kx_rad_m: float
    ky_rad_m: float
    kz_rad_m: complex
    classification: str
    frequency_hz: float
    eps_r: float
    mu_r: float

    def tangential_basis(self) -> tuple[tuple[float, float], tuple[float, float]]:
        """(TE, TM) orthonormal xy electric directions, same for both z signs.

        TM is parallel to kt, TE = z cross TM. At kt=0 choose TM=+x, TE=+y.
        These are tangential bases, not full 3D unit electric vectors.
        """
        length = math.hypot(self.kx_rad_m, self.ky_rad_m)
        tm = (self.kx_rad_m / length, self.ky_rad_m / length) if length else (1.0, 0.0)
        return ((-tm[1], tm[0]), tm)

    def admittance_siemens(self, polarization: str) -> complex:
        """Tangential-E admittance: Y_TE=kz/(omega mu), Y_TM=omega eps/kz."""
        if polarization not in ("TE", "TM"):
            raise ValueError("polarization must be TE or TM")
        if self.classification == "cutoff":
            raise ValueError("Cutoff orders have singular wave separation/normalization")
        _, _, _, k, eta = _medium(self.frequency_hz, self.eps_r, self.mu_r)
        result = self.kz_rad_m / k / eta if polarization == "TE" else k / self.kz_rad_m / eta
        if not math.isfinite(result.real) or not math.isfinite(result.imag) or result == 0:
            raise ValueError("Modal admittance must be finite and nonzero")
        return result

    def power_watts(self, amplitude_v_m, polarization: str, area_m2) -> float:
        """Unsigned normal power of one isolated wave, for peak complex E_t.

        Evanescent isolated waves have zero real normal power. Superposed
        counter-decaying evanescent waves may carry interference flux.
        """
        amplitude = _complex(amplitude_v_m, "amplitude_v_m")
        area = _positive(area_m2, "area_m2")
        y = self.admittance_siemens(polarization)
        if y.real == 0:
            return 0.0
        try:
            power = 0.5 * area * y.real * abs(amplitude) ** 2
        except OverflowError:
            raise ValueError("Modal power must be finite") from None
        if not math.isfinite(power):
            raise ValueError("Modal power must be finite")
        return power

    def power_normalized_amplitude(self, amplitude_v_m, polarization: str, area_m2) -> complex:
        """Propagating-mode amplitude in sqrt(W); squared magnitude is power."""
        amplitude = _complex(amplitude_v_m, "amplitude_v_m")
        area = _positive(area_m2, "area_m2")
        if self.classification != "propagating":
            raise ValueError("Only propagating orders admit real-power normalization")
        scale = math.sqrt(area) * math.sqrt(self.admittance_siemens(polarization).real / 2)
        result = amplitude * scale
        return _complex(result, "power-normalized amplitude")


def diffraction_orders(lattice: Lattice2D, kt_rad_m, frequency_hz, orders, *,
                       eps_r=1.0, mu_r=1.0) -> tuple[FloquetOrder, ...]:
    """Enumerate explicitly requested integer orders; not an automatic mode cutoff.

    kt_mn = kt + m b1 + n b2. Classification uses a relative 1e-12 tolerance
    on k^2-|kt_mn|^2, scaled by max(k^2, |kt_mn|^2). Both signs of integer
    orders must be requested when needed. Outputs retain the caller's order.
    """
    if not isinstance(lattice, Lattice2D):
        raise ValueError("lattice must be a Lattice2D")
    kt = _vector2(kt_rad_m, "kt_rad_m")
    f, eps, mu, k, _ = _medium(frequency_hz, eps_r, mu_r)
    requested = _orders(orders)
    reciprocal = np.asarray(lattice.reciprocal_rad_m)
    result = []
    for m, n in requested:
        with np.errstate(over="ignore", invalid="ignore"):
            transverse = np.asarray(kt) + np.asarray((m, n)) @ reciprocal
        if not np.isfinite(transverse).all():
            raise ValueError("Diffraction-order transverse wavevector must be finite")
        length = math.hypot(*transverse)
        if not math.isfinite(length):
            raise ValueError("Diffraction-order transverse magnitude must be finite")
        # Scale before squaring, so large but finite physical inputs do not overflow.
        scale = max(k, length)
        delta = (k / scale) ** 2 - (length / scale) ** 2
        if abs(delta) <= CUTOFF_RTOL:
            classification, kz = "cutoff", 0j
        elif delta > 0:
            classification, kz = "propagating", complex(scale * math.sqrt(delta), 0)
        else:
            classification, kz = "evanescent", complex(0, scale * math.sqrt(-delta))
        result.append(FloquetOrder(m, n, float(transverse[0]), float(transverse[1]),
                                  kz, classification, f, eps, mu))
    return tuple(result)


@dataclass(frozen=True)
class ModalAmplitudes:
    """Peak complex tangential-E coefficients (V/m) at the sampled z plane."""

    mode: FloquetOrder
    te_plus_v_m: complex
    te_minus_v_m: complex
    tm_plus_v_m: complex
    tm_minus_v_m: complex


def _field_grid(value, name: str) -> np.ndarray:
    try:
        array = np.asarray(value)
        if array.ndim != 3 or array.shape[-1] != 2 or min(array.shape[:2]) < 2:
            raise ValueError(f"{name} must have shape (N1, N2, 2) with N1,N2 >= 2")
        if array.shape[0] * array.shape[1] > MAX_GRID_SAMPLES:
            raise ValueError(f"Grid exceeds {MAX_GRID_SAMPLES} samples")
        if array.dtype.kind not in "fciu":
            raise ValueError(f"{name} must contain numeric field samples")
        array = np.asarray(array, dtype=np.complex128)
    except (TypeError, OverflowError):
        raise ValueError(f"{name} must contain finite numeric field samples") from None
    if not np.isfinite(array).all():
        raise ValueError(f"{name} must contain finite numeric field samples")
    return array


def project_tangential_fields(lattice: Lattice2D, kt_rad_m, frequency_hz, orders,
                             e_t_v_m, h_t_a_m, *, eps_r=1.0, mu_r=1.0,
                             origin_m=(0.0, 0.0)) -> tuple[ModalAmplitudes, ...]:
    """Demodulated spatial DFT and +/-z TE/TM separation on one cell plane.

    E/H arrays have shape (N1,N2,2), ordered as xy components. Both fields must
    already be collocated spatially and temporally. Sample (i,j) is at
    origin + i*a1/N1 + j*a2/N2; the repeated endpoint is excluded. Complex
    peak phasors follow exp(-i omega t). Coefficients multiply exp(i kt_mn.r)
    in global xy coordinates, with z referenced to the sampled plane.
    Existing openEMS spectra use exp(+i omega t): conjugate both E and H via
    a verified producer-specific adapter, checking scaling and timestamps.

    Only the centered FFT order interval [-(N//2),(N-1)//2] is admitted per
    axis. This prevents requesting aliases; actual unresolved high-order
    fields still alias and require sampling convergence. Cutoff is refused.
    """
    modes = diffraction_orders(lattice, kt_rad_m, frequency_hz, orders, eps_r=eps_r, mu_r=mu_r)
    origin = _vector2(origin_m, "origin_m")
    e = _field_grid(e_t_v_m, "e_t_v_m")
    h = _field_grid(h_t_a_m, "h_t_a_m")
    if e.shape != h.shape:
        raise ValueError("E and H grids must have identical shapes")
    n1, n2, _ = e.shape
    for mode in modes:
        if not -(n1 // 2) <= mode.m <= (n1 - 1) // 2 or not -(n2 // 2) <= mode.n <= (n2 - 1) // 2:
            raise ValueError("Requested diffraction orders exceed the unaliased FFT intervals")
        if mode.classification == "cutoff":
            raise ValueError("Cutoff orders cannot be separated into +/-z waves")
    u = np.arange(n1)[:, None] / n1
    v = np.arange(n2)[None, :] / n2
    base_phase = lattice.phase_rad(kt_rad_m)
    phase = (base_phase[0] * u + base_phase[1] * v +
             np.dot(_vector2(kt_rad_m, "kt_rad_m"), origin))
    if not np.isfinite(phase).all():
        raise ValueError("Sample phases must be finite")
    demodulate = np.exp(-1j * phase)[..., None]
    e_fft = np.fft.fft2(e * demodulate, axes=(0, 1)) / (n1 * n2)
    h_fft = np.fft.fft2(h * demodulate, axes=(0, 1)) / (n1 * n2)
    reciprocal = np.asarray(lattice.reciprocal_rad_m)
    result = []
    for mode in modes:
        reciprocal_phase = np.dot(np.asarray((mode.m, mode.n)) @ reciprocal, origin)
        if not math.isfinite(reciprocal_phase):
            raise ValueError("Sample origin phase must be finite")
        origin_factor = np.exp(-1j * reciprocal_phase)
        ec = e_fft[mode.m % n1, mode.n % n2] * origin_factor
        hc = h_fft[mode.m % n1, mode.n % n2] * origin_factor
        # g = -z cross H = (Hy,-Hx); g_pol = Y_pol (a_plus-a_minus).
        gc = np.asarray((hc[1], -hc[0]))
        te, tm = mode.tangential_basis()
        coefficients = []
        for polarization, basis in (("TE", te), ("TM", tm)):
            electric = np.dot(ec, basis)
            magnetic = np.dot(gc, basis) / mode.admittance_siemens(polarization)
            coefficients.extend((_complex(0.5 * (electric + magnetic), "modal amplitude"),
                                 _complex(0.5 * (electric - magnetic), "modal amplitude")))
        result.append(ModalAmplitudes(mode, *coefficients))
    return tuple(result)
