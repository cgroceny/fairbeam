"""Bounded, opt-in complex NF2FF storage; no solver/native imports.

The four real component arrays share one int16 scale, preserving relative phase
to quantization precision. Values are the native spherical E fields, not port-
normalized embedded element patterns. The containing FarField owns the axes and
the mirror-corrected Dmax used for partial directivity.
"""
import base64
import math

FIELDS_SCHEMA = "fairbeam.farfield-fields/1"
FIELDS_ENCODING = "i16le-base64-scaled"
FIELD_KEYS = ("e_theta_re", "e_theta_im", "e_phi_re", "e_phi_im")
FIELD_CELLS_MAX = 65536
FIELD_FREQS_MAX = 16
FIELD_TOTAL_CELLS_MAX = 262144
I16_FULL = 32767


def encode_i16_scaled(arrays) -> tuple[float, list[str]]:
    """Common int16 codec for single-field and embedded-pattern storage.

    Same arithmetic/bytes as the original multiport.encode_i16_scaled.
    """
    import numpy as np

    arrs = [np.asarray(a, float) for a in arrays]
    if not all(np.all(np.isfinite(a)) for a in arrs):
        raise ValueError("non-finite values cannot be encoded as scaled int16")
    scale = max((float(np.max(np.abs(a))) for a in arrs if a.size), default=0.0)
    div = scale if scale > 0 else 1.0
    return scale, [base64.b64encode(np.ascontiguousarray(np.round(a / div * I16_FULL).astype("<i2"))
                                    .tobytes()).decode("ascii") for a in arrs]


def check_field_budget(rows: int, cols: int, frequencies: int) -> None:
    """Per driven-port evaluation; fail before NF2FF, never silently decimate."""
    if any(isinstance(v, bool) or not isinstance(v, int) or v <= 0
           for v in (rows, cols, frequencies)):
        raise ValueError("complex far-field storage needs nonempty integer grid/frequency counts")
    if (rows * cols > FIELD_CELLS_MAX or frequencies > FIELD_FREQS_MAX
            or rows * cols * frequencies > FIELD_TOTAL_CELLS_MAX):
        raise ValueError("complex far-field storage permits at most 65536 cells per frequency, "
                         "16 frequencies and 262144 cells total per driven port; use coarser "
                         "angular steps/fewer frequencies or disable complex_fields")


def field_budget_for_steps(theta_step: float, phi_step: float, frequencies: int) -> None:
    """Same count as angular_grid, without importing NumPy into design lint."""
    from .pattern_grid import pattern_steps
    theta_step, phi_step = pattern_steps(theta_step, phi_step)
    check_field_budget(math.ceil((180 - 1e-9) / theta_step) + 1,
                       math.ceil((360 - 1e-9) / phi_step), frequencies)


def encode_farfield_fields(frequency, theta, phi, e_theta, e_phi, *, mirror_planes,
                          phase_center_m, radius_m) -> dict:
    """Encode finite, exactly aligned native components. Invalid evidence fails closed."""
    import numpy as np

    rows, cols = len(theta), len(phi)
    check_field_budget(rows, cols, 1)
    theta, phi = np.asarray(theta, float), np.asarray(phi, float)
    for axis, limit, inclusive in ((theta, 180, True), (phi, 360, False)):
        if (axis.ndim != 1 or not np.all(np.isfinite(axis)) or axis[0] < 0
                or np.any(np.diff(axis) <= 0) or axis[-1] > limit
                or (not inclusive and axis[-1] == limit)):
            raise ValueError("complex far-field axes must be increasing theta 0..180 / phi 0..<360")
    if (not math.isfinite(frequency) or frequency <= 0 or not math.isfinite(radius_m)
            or radius_m <= 0 or isinstance(mirror_planes, bool)
            or not isinstance(mirror_planes, int) or not 0 <= mirror_planes <= 3):
        raise ValueError("invalid complex far-field frequency, radius or mirror count")
    center = np.asarray(phase_center_m, float)
    if center.shape != (3,) or not np.all(np.isfinite(center)):
        raise ValueError("complex far-field phase center must be three finite coordinates in metres")
    et, ep = np.asarray(e_theta, complex), np.asarray(e_phi, complex)
    if et.shape != (rows, cols) or ep.shape != et.shape:
        raise ValueError("complex far-field components must match the complete theta/phi grid")
    arrays = (et.real, et.imag, ep.real, ep.imag)
    if not all(np.all(np.isfinite(a)) for a in arrays):
        raise ValueError("complex far-field components must be finite")
    scale, texts = encode_i16_scaled(arrays)
    # Retain the original normalization explicitly. A reader must not silently
    # renormalize a cropped/decimated grid to a peak which disappeared from it.
    peak = float(np.max(sum((a / (scale or 1.)) ** 2 for a in arrays)))
    return {"schema": FIELDS_SCHEMA, "encoding": FIELDS_ENCODING, "basis": "theta-phi",
            "normalization": "native-E-theta-phi", "f": float(frequency),
            "shape": [rows, cols], "scale": scale, "power_peak": peak, "radius_m": float(radius_m),
            "phase_center_m": center.tolist(), "mirror_planes": mirror_planes,
            **dict(zip(FIELD_KEYS, texts))}
