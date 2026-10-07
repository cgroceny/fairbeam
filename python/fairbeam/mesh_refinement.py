"""Local Cartesian size caps and resolution diagnostics for automatic meshes."""
from __future__ import annotations

import numpy as np

REQUIRED_CELLS = 3


def collect_features(metals, feeds, max_width):
    from dataclasses import asdict
    from .mesh_features import detect_features

    features = [asdict(f) for f in detect_features(metals, max_width=max_width)]
    for p in feeds:
        if p.get("type") == "waveguide":
            continue
        lo = np.minimum(p["start"], p["stop"])
        hi = np.maximum(p["start"], p["stop"])
        axis = "xyz".index(p["direction"])
        width = float(hi[axis] - lo[axis])
        if not 1e-9 < width <= max_width:
            continue
        normal = [0.0] * 3
        normal[axis] = 1.0
        features.append({"kind": "feed", "width": width, "lo": lo.tolist(), "hi": hi.tolist(),
                         "axes": [axis], "normal": normal, "shape_indices": [], "edge_indices": []})
    # Reports are JSON data, including when detector coordinates are numpy arrays.
    for f in features:
        for key in ("lo", "hi", "normal"):
            f[key] = [float(v) for v in f[key]]
        f["axes"] = list(f["axes"])
    return features


def measure_features(features, lines):
    """Conservative cells across: width / largest projected cell over the feature.

    For a slanted pair, a Cartesian cell spans |nx| dx + |ny| dy across its
    normal. Using the worst intersecting cell on each axis avoids mistaking a
    handful of lines near one tip for resolution along the entire strip.
    """
    measured = []
    for f in features:
        projected = 0.0
        for a, component in enumerate(f["normal"]):
            if abs(component) < 1e-9:
                continue
            x = np.asarray(lines[a], float)
            lo, hi = f["lo"][a], f["hi"][a]
            mask = (x[1:] > lo + 1e-9) & (x[:-1] < hi - 1e-9)
            widths = np.diff(x)[mask]
            if not len(widths) or x[0] > lo + 1e-9 or x[-1] < hi - 1e-9:
                projected = np.inf
                break
            projected += abs(component) * float(widths.max())
        across = float(f["width"] / projected) if projected > 0 else 0.0
        measured.append({**f, "cells_across": across, "required_cells": REQUIRED_CELLS,
                         "resolved": across >= REQUIRED_CELLS * (1 - 1e-6)})
    return measured


def refinement_caps(features, min_cell=None):
    """(lo, hi, h) per axis; leave 10% headroom for fill's single-cell rule."""
    caps = [[] for _ in range(3)]
    for f in features:
        h = f["width"] / (REQUIRED_CELLS * 1.1 * sum(abs(v) for v in f["normal"]))
        h = max(h, min_cell or 0.0)
        for a, component in enumerate(f["normal"]):
            if abs(component) > 1e-9:
                caps[a].append((f["lo"][a], f["hi"][a], h))
        # Fine in-plane detail also needs small cells next to its sheet. A feed
        # can be a line (two flat axes); refine both so its fringing field is covered.
        for a in range(3):
            if abs(f["hi"][a] - f["lo"][a]) < 1e-9:
                c = f["lo"][a]
                caps[a].append((c - 2 * h, c + 2 * h, h))
    return caps


def cap_sizes(t, base_cap, intervals, ratio):
    """Continuous size field, graded from each feature back to the global cap."""
    t = np.asarray(t, float)
    c = np.asarray(base_cap(t), float)
    for lo, hi, h in intervals:
        distance = np.maximum(0.0, np.maximum(lo - t, t - hi))
        c = np.minimum(c, h + 0.85 * (ratio - 1) * distance)
    return c


def refinement_cell_lower_bound(caps, domain):
    """Minimum cell product implied by the strongest interval on each axis.

    ``domain`` is (lower_corner, upper_corner). Intervals are clipped to that
    domain, and the 10% single-cell tolerance is included. Taking the largest
    individual interval requirement avoids double-counting overlapping caps.
    The bound deliberately omits grading and the rest of the domain, so it can
    reject a request that cannot fit the cell limit without allocating its grid.
    """
    import math

    lower, upper = domain
    required = []
    for axis, intervals in enumerate(caps):
        count = 1
        for lo, hi, h in intervals:
            length = max(0.0, min(hi, upper[axis]) - max(lo, lower[axis]))
            count = max(count, math.floor(length / (1.1 * h)))
        required.append(count)
    return math.prod(required)
