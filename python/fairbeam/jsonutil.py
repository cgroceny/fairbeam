"""Strict JSON at the file boundary: non-finite floats (-inf dB of a zero far field, NaN) become null.

Bundles, study summaries and optimizer files are written with ``json.dumps(..., allow_nan=False)``
(the viewer and the browser's JSON.parse reject ``NaN``/``Infinity``). :func:`finite_json` replaces
the non-finite values first, so a run with an essentially zero far field still writes its results
(#57); the viewer treats null samples as missing.
"""

from __future__ import annotations

import math

try:  # numpy is optional here: the server process imports this without it
    import numpy as _np
except ImportError:  # pragma: no cover - numpy is installed wherever results are written
    _np = None


def finite_json(value):
    """A copy of ``value`` with numpy arrays/scalars as plain Python and non-finite floats as None."""
    if _np is not None:
        if isinstance(value, _np.ndarray):
            return finite_json(value.tolist())
        if isinstance(value, _np.generic):
            return finite_json(value.item())
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: finite_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [finite_json(item) for item in value]
    return value
