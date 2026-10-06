#!/usr/bin/env python3
"""In-memory benchmark of the two large-geometry preview costs of #105 (no files, no solver).

    python scripts/bench_preview.py [--repeat 5]

``large preview``: the review's detailed-array fixture (rp1_perf_big): an 8 x 8 array of 35 um
copper squares, each topped by a level-4 Koch outline (768 points), on a 180 mm substrate. It is
built as the preview worker builds an unsaved design (fairbeam.preview.build_preview: resolve,
CSXCAD, automatic mesh, bundle) and linted with that bundle.
``overlaid lint``: three equal copper arrays of 1000 coincident sheet squares each, linted
directly (the hidden-part check).

Prints the median and every time in seconds. Needs the CSXCAD Python module (as fairbeam does).
"""

from __future__ import annotations

import argparse
import math
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))


def koch(level: int, size: float = 24.0) -> list:
    pts = [[0.0, 0.0], [size, 0.0], [size / 2, size * math.sqrt(3) / 2]]
    for _ in range(level):
        out = []
        for i, a in enumerate(pts):
            b = pts[(i + 1) % len(pts)]
            dx, dy = (b[0] - a[0]) / 3, (b[1] - a[1]) / 3
            ln, ang = math.hypot(dx, dy), math.atan2(dy, dx) - math.pi / 3
            p1 = [a[0] + dx, a[1] + dy]
            out += [a, p1, [p1[0] + ln * math.cos(ang), p1[1] + ln * math.sin(ang)], [a[0] + 2 * dx, a[1] + 2 * dy]]
        pts = out
    return pts


def large_array_design() -> dict:
    from fairbeam.design import blank_design

    d = blank_design("rp1_perf_big", "rp1 perf big array")
    d["parts"] = [
        {"name": "substrate", "material": "substrate", "primitives": [{"kind": "box", "start": [-90, -90, 0], "stop": [90, 90, 1.6]}]},
        {"name": "array", "material": "copper", "primitives": [
            {"kind": "box", "start": [-9, -9, 1.6], "stop": [9, 9, 1.635]},
            {"kind": "polygon", "normal": "z", "elevation": 1.635, "points": koch(4)}],
         "transforms": [{"type": "translate", "copies": 7, "step": [22, 0, 0]},
                        {"type": "translate", "copies": 7, "step": [0, 22, 0]}]},
        {"name": "ground", "material": "copper", "primitives": [{"kind": "box", "start": [-90, -90, 0], "stop": [90, 90, 0]}]}]
    d["ports"] = [{"type": "lumped", "number": 1, "R": 50, "start": [0, 0, 1.6], "stop": [0, 0, 1.635], "direction": "z"}]
    return d


def overlaid_arrays_design() -> dict:
    from fairbeam.design import blank_design

    d = blank_design("rp5-overlaplint", "Overlaid array lint profile")
    for i in range(3):
        d["parts"].append({"name": f"array{i}", "material": "copper", "primitives": [
            {"kind": "box", "start": ["0", "0", "2"], "stop": ["1", "1", "2"]}],
            "transforms": [{"type": "translate", "copies": "999", "step": ["4", "0", "0"]}]})
    return d


def timed(fn, repeat: int) -> list[float]:
    out = []
    for _ in range(repeat):
        t0 = time.perf_counter()
        fn()
        out.append(time.perf_counter() - t0)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repeat", type=int, default=5)
    args = ap.parse_args(argv)
    from fairbeam.design_checks import lint
    from fairbeam.preview import build_preview, design_checks

    big, overlaid = large_array_design(), overlaid_arrays_design()
    result = build_preview(None, {}, design=big)
    checks = design_checks(big, {}, result["bundle"])
    rows = [("large preview build", timed(lambda: build_preview(None, {}, design=big), args.repeat)),
            ("large preview lint", timed(lambda: design_checks(big, {}, result["bundle"]), args.repeat)),
            ("overlaid lint", timed(lambda: lint(overlaid, {}), args.repeat))]
    print(f"large preview: {len(checks)} checks, mesh {result['bundle']['mesh']['cells']} cells")
    print(f"overlaid lint: {sum(c['code'] == 'part-hidden' for c in lint(overlaid, {}))} part-hidden warnings")
    for name, ts in rows:
        print(f"{name:22s} median {statistics.median(ts):7.3f} s   ({', '.join(f'{t:.3f}' for t in ts)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
