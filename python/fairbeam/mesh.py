"""Mesh helpers."""

import numpy as np


def merge_lines(required, uniform, tol):
    """Keep every ``required`` line; add ``uniform`` lines only where they are farther than ``tol``
    from all required ones.

    Mixing a uniform grid with geometry-snapped lines otherwise creates slivers a few microns wide,
    and the smallest cell sets the FDTD timestep for the whole domain.
    """
    req = np.unique(np.asarray(sorted(required), dtype=float))
    extra = [v for v in np.asarray(uniform, dtype=float) if np.min(np.abs(req - v)) > tol]
    return np.unique(np.r_[req, extra])
