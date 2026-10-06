"""Exact 2D Boolean operations on polygons (union, subtract, intersect) for the Boolean of extruded
polygons and polygon sheets (:func:`fairbeam.design.boolean_primitives`).

This is the designer's src/designer/polygonClip.ts operation by operation (the same float arithmetic
in the same order, the same tie-breaks), so a live Boolean result recomputed by the build is exactly
the one the designer shows: keep the two in step.

Method: a vertical-strip decomposition. The x of every vertex and of every edge crossing splits the
plane into strips in which no two edges cross; in a strip the edges are ordered by their height at
the strip's middle and a walk from below counts the winding of each operand (each ring
counter-clockwise, nonzero rule, so the rings of one operand are united). The runs where the
operation holds are trapezoids, which is exact. Trapezoids continuing along the same two lines in the
next strip are merged, then pieces sharing one contiguous boundary chain are joined. The result is a
list of simple polygons without holes (CSXCAD and CST polygons have none): a hole leaves its surround
split into several polygons.
"""

from __future__ import annotations

import math

MAX_CLIP_EDGES = 2000
MAX_PIECES = 5000
MERGE_LIMIT = 400


def ring_area(r: list) -> float:
    """Signed area (counter-clockwise positive)."""
    s = 0.0
    n = len(r)
    for i in range(n):
        p, q = r[i], r[(i + 1) % n]
        s += p[0] * q[1] - q[0] * p[1]
    return s / 2


def clip_tolerance(groups: list) -> float:
    """1e-9 of the largest coordinate of these ring lists (at least 1e-9)."""
    scale = 1.0
    for rings in groups:
        for r in rings:
            for p in r:
                scale = max(scale, abs(p[0]), abs(p[1]))
    return 1e-9 * scale


def _simplify(r: list, eps: float) -> list:
    pts = [list(p) for p in r]
    changed = True
    while changed and len(pts) >= 3:
        changed = False
        n = len(pts)
        for i in range(n):
            a, b, c = pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n]
            ux, uy, vx, vy = b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]
            dup = abs(ux) <= eps and abs(uy) <= eps
            cross = ux * vy - uy * vx
            length = math.sqrt(ux * ux + uy * uy) + math.sqrt(vx * vx + vy * vy)
            if dup or abs(cross) <= eps * length:
                del pts[i]
                changed = True
                break
    return pts


def normalise_ring(r: list, eps: float):
    """A clean counter-clockwise ring, or None when it has no area."""
    pts = _simplify(r, eps)
    if len(pts) < 3:
        return None
    a = ring_area(pts)
    if abs(a) <= eps * eps:
        return None
    return pts[::-1] if a < 0 else pts


def _y_at(e: dict, x: float) -> float:
    if x <= e["x0"]:
        return e["y0"]
    if x >= e["x1"]:
        return e["y1"]
    return e["y0"] + (e["y1"] - e["y0"]) * ((x - e["x0"]) / (e["x1"] - e["x0"]))


def _trapezoids(A: list, B: list, mode: str, eps: float) -> list:
    edges: list = []
    xs: list = []
    for op, rings in enumerate((A, B)):
        for r in rings:
            n = len(r)
            for i in range(n):
                p, q = r[i], r[(i + 1) % n]
                xs.append(p[0])
                if abs(q[0] - p[0]) <= eps:
                    continue  # vertical: it bounds no strip
                up = p[0] < q[0]
                a, b = (p, q) if up else (q, p)
                edges.append({"x0": a[0], "y0": a[1], "x1": b[0], "y1": b[1], "w": 1 if up else -1, "op": op,
                              "id": len(edges), "slope": (b[1] - a[1]) / (b[0] - a[0]), "ym": 0.0})
    if len(edges) > MAX_CLIP_EDGES:
        raise ValueError(f"the polygons have more than {MAX_CLIP_EDGES} edges")
    for i, e in enumerate(edges):
        for f in edges[i + 1:]:
            if f["x0"] >= e["x1"] or e["x0"] >= f["x1"]:
                continue
            dx1, dy1, dx2, dy2 = e["x1"] - e["x0"], e["y1"] - e["y0"], f["x1"] - f["x0"], f["y1"] - f["y0"]
            den = dx1 * dy2 - dy1 * dx2
            if den == 0:
                continue
            t = ((f["x0"] - e["x0"]) * dy2 - (f["y0"] - e["y0"]) * dx2) / den
            u = ((f["x0"] - e["x0"]) * dy1 - (f["y0"] - e["y0"]) * dx1) / den
            if 0 < t < 1 and 0 < u < 1:
                xs.append(e["x0"] + t * dx1)
    xs.sort()
    cuts: list = []
    for x in xs:
        if not cuts or x - cuts[-1] > eps:
            cuts.append(x)
    out: list = []
    open_: list = []
    for k in range(len(cuts) - 1):
        xa, xb = cuts[k], cuts[k + 1]
        xm = (xa + xb) / 2
        act = [e for e in edges if e["x0"] < xm and e["x1"] > xm]
        for e in act:
            e["ym"] = _y_at(e, xm)
        act.sort(key=lambda e: (e["ym"], e["slope"], e["id"]))
        nxt: list = []
        wa = wb = 0
        inside = False
        bottom = None
        g = 0
        while g < len(act):
            y0 = act[g]["ym"]
            h = g
            while h < len(act) and act[h]["ym"] - y0 <= eps:
                if act[h]["op"] == 0:
                    wa += act[h]["w"]
                else:
                    wb += act[h]["w"]
                h += 1
            ina, inb = wa != 0, wb != 0
            now = (ina or inb) if mode == "union" else (ina and not inb) if mode == "subtract" else (ina and inb)
            if now and not inside:
                bottom = act[g]
            elif not now and inside and bottom is not None:
                top = act[g]
                t = {"xa": xa, "xb": xb, "yba": _y_at(bottom, xa), "ybb": _y_at(bottom, xb),
                     "yta": _y_at(top, xa), "ytb": _y_at(top, xb)}
                if t["yta"] - t["yba"] > eps or t["ytb"] - t["ybb"] > eps:
                    o = next((o for o in open_ if abs(o["ybb"] - t["yba"]) <= eps and abs(o["ytb"] - t["yta"]) <= eps
                              and abs(o["yba"] + (o["ybb"] - o["yba"]) * ((t["xb"] - o["xa"]) / (o["xb"] - o["xa"])) - t["ybb"]) <= eps
                              and abs(o["yta"] + (o["ytb"] - o["yta"]) * ((t["xb"] - o["xa"]) / (o["xb"] - o["xa"])) - t["ytb"]) <= eps),
                             None)
                    if o is not None:
                        o["xb"], o["ybb"], o["ytb"] = t["xb"], t["ybb"], t["ytb"]
                        nxt.append(o)
                    else:
                        out.append(t)
                        nxt.append(t)
                        if len(out) > MAX_PIECES:
                            raise ValueError("the Boolean result is too fragmented")
            inside = now
            g = h
        open_ = nxt
    return out


def _same(p, q, eps: float) -> bool:
    return abs(p[0] - q[0]) <= eps and abs(p[1] - q[1]) <= eps


def _on_boundary(p, r: list, eps: float) -> bool:
    n = len(r)
    for i in range(n):
        a, b = r[i], r[(i + 1) % n]
        dx, dy = b[0] - a[0], b[1] - a[1]
        l2 = dx * dx + dy * dy
        t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 if l2 > 0 else 0.0
        t = 0.0 if t < 0 else 1.0 if t > 1 else t
        ex, ey = a[0] + t * dx - p[0], a[1] + t * dy - p[1]
        if ex * ex + ey * ey <= eps * eps:
            return True
    return False


def _run(flags: list):
    n = len(flags)
    count = starts = 0
    s = -1
    for i in range(n):
        if flags[i]:
            count += 1
        if flags[i] and not flags[(i + n - 1) % n]:
            starts += 1
            s = i
    if count < 2 or count >= n or starts != 1:
        return None
    return s, (s + count - 1) % n


def _join(P: list, Q: list, eps: float):
    rp = _run([_on_boundary(p, Q, eps) for p in P])
    if rp is None:
        return None
    rq = _run([_on_boundary(q, P, eps) for q in Q])
    if rq is None:
        return None
    if not _same(P[rp[0]], Q[rq[1]], eps) or not _same(P[rp[1]], Q[rq[0]], eps):
        return None
    n, m = len(P), len(Q)
    k = rp[0]
    while k != rp[1]:
        a, b = P[k], P[(k + 1) % n]
        if not _on_boundary([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], Q, eps):
            return None
        k = (k + 1) % n
    k = rq[0]
    while k != rq[1]:
        a, b = Q[k], Q[(k + 1) % m]
        if not _on_boundary([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], P, eps):
            return None
        k = (k + 1) % m
    out = []
    k = rp[1]
    while True:
        out.append(P[k])
        if k == rp[0]:
            break
        k = (k + 1) % n
    k = (rq[1] + 1) % m
    while k != rq[0]:
        out.append(Q[k])
        k = (k + 1) % m
    return out


def _bounds(r: list):
    x0 = y0 = math.inf
    x1 = y1 = -math.inf
    for p in r:
        x0, y0, x1, y1 = min(x0, p[0]), min(y0, p[1]), max(x1, p[0]), max(y1, p[1])
    return x0, y0, x1, y1


def clip_polygons(A: list, B: list, mode: str, eps: float | None = None) -> list:
    """A op B for rings (any orientation; the rings of one operand are united): simple
    counter-clockwise polygons without holes as lists of [u, v], in a deterministic order."""
    if eps is None:
        eps = clip_tolerance([A, B])
    clean = lambda rings: [r for r in (normalise_ring(q, eps) for q in rings) if r is not None]  # noqa: E731
    traps = _trapezoids(clean(A), clean(B), mode, eps)
    pieces = []
    for t in traps:
        r = [[t["xa"], t["yba"]], [t["xb"], t["ybb"]]]
        if t["ytb"] - t["ybb"] > eps:
            r.append([t["xb"], t["ytb"]])
        if t["yta"] - t["yba"] > eps:
            r.append([t["xa"], t["yta"]])
        pieces.append(r)
    # T-junctions: the corners of the other pieces on a vertical side become points of that side
    corners: dict = {}
    for r in pieces:
        for p in r:
            corners.setdefault(p[0], []).append(p[1])
    joined_sides = []
    for r in pieces:
        out = []
        n = len(r)
        for i in range(n):
            p, q = r[i], r[(i + 1) % n]
            out.append(p)
            if p[0] != q[0]:
                continue
            lo, hi = min(p[1], q[1]) + eps, max(p[1], q[1]) - eps
            ys = sorted((y for y in corners.get(p[0], []) if lo < y < hi), reverse=not q[1] > p[1])
            last = p[1]
            for y in ys:
                if abs(y - last) > eps:
                    out.append([p[0], y])
                    last = y
        joined_sides.append(out)
    pieces = joined_sides
    if len(pieces) <= MERGE_LIMIT:
        box = [_bounds(r) for r in pieces]
        changed = True
        while changed:
            changed = False
            i = 0
            while i < len(pieces):
                j = i + 1
                while j < len(pieces):
                    a, b = box[i], box[j]
                    touch = a[0] <= b[2] + eps and b[0] <= a[2] + eps and a[1] <= b[3] + eps and b[1] <= a[3] + eps
                    joined = _join(pieces[i], pieces[j], eps) if touch else None
                    if joined is not None:
                        pieces[i] = joined
                        box[i] = _bounds(joined)
                        del pieces[j]
                        del box[j]
                        changed = True
                        j = i + 1
                    else:
                        j += 1
                i += 1
    return [r for r in (normalise_ring(q, eps) for q in pieces) if r is not None]
