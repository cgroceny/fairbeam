"""Sierpinski gasket fractal monopole over an infinite ground plane.

Puente et al., "Fractal multiband antenna based on the Sierpinski gasket", Electronics Letters
32(1), 1996, and "On the behavior of the Sierpinski multiband fractal antenna", IEEE TAP 46(4),
1998. The original gasket is 89 mm tall with a 60 degree flare; bands appear at ~0.52, 1.74, 3.51,
6.95 and 13.89 GHz (log-period ~2). Heights here are scaled freely.

Modelling notes
- The ground plane is a PEC boundary at z = 0 (image theory: half the domain, exact infinite plane).
- The gasket is a zero-thickness PEC sheet in the y = 0 plane, apex down, fed by a 50 ohm lumped
  port across a small gap.
- Sub-triangles touch at single points; on a staircase FDTD grid that contact can vanish, so each
  contact vertex gets a small square bridge (clipped to the outer triangle).
"""

import numpy as np

from fairbeam import Param, Simulation
from fairbeam.mesh import merge_lines

MODEL = {
    "id": "sierpinski-monopole",
    "name": "Sierpinski gasket monopole",
    "description": "Fractal multiband monopole (60° gasket) over an infinite PEC ground.",
    "reference": "C. Puente et al., IEEE Trans. Antennas Propag. 46(4), 1998",
}

PARAMS = [
    Param("iterations", 3, "Fractal iterations", "", minimum=0, maximum=5),
    Param("height", 48.0, "Gasket height", "mm", minimum=5),
    Param("flare", 60.0, "Flare angle", "deg", minimum=10, maximum=120),
    Param("gap", 1.0, "Feed gap", "mm", minimum=0.2),
    Param("bridge", 1.2, "Contact bridge size", "mm", minimum=0),
    Param("cell", 0.8, "Mesh cell on the gasket", "mm", minimum=0.1),
    Param("f_min", 0.5, "Band start", "GHz", minimum=0.01),
    Param("f_max", 8.0, "Band stop", "GHz", minimum=0.1),
]

DOMAIN = {"x": 100.0, "y": 100.0, "z": 130.0}


def gasket(n, w, h, g):
    a, b, c = np.array([0.0, g]), np.array([-w / 2, g + h]), np.array([w / 2, g + h])
    tris = [(a, b, c)]
    for _ in range(n):
        tris = [t for (p, q, r) in tris
                for t in ((p, (p + q) / 2, (r + p) / 2), ((p + q) / 2, q, (q + r) / 2), ((r + p) / 2, (q + r) / 2, r))]
    return tris


def contacts(tris):
    count = {}
    for t in tris:
        for v in t:
            k = (round(v[0], 6), round(v[1], 6))
            count[k] = count.get(k, 0) + 1
    return [np.array(k) for k, c in count.items() if c >= 2]


def _cross(u, v):
    return u[0] * v[1] - u[1] * v[0]


def clip_to_triangle(poly, tri):
    """Sutherland-Hodgman clip of a polygon (x, z) to a convex triangle."""
    t = np.array(tri)
    orient = np.sign(_cross(t[1] - t[0], t[2] - t[0]))
    for i in range(3):
        a, b = t[i], t[(i + 1) % 3]
        inside = lambda p: orient * _cross(b - a, p - a) >= -1e-12  # noqa: E731
        out = []
        for j in range(len(poly)):
            p, q = poly[j], poly[(j + 1) % len(poly)]
            if inside(q):
                if not inside(p):
                    out.append(_intersect(p, q, a, b))
                out.append(q)
            elif inside(p):
                out.append(_intersect(p, q, a, b))
        poly = np.array(out)
    return poly


def _intersect(p, q, a, b):
    d1, d2 = q - p, b - a
    return p + _cross(a - p, d2) / _cross(d1, d2) * d1


def build(p: dict) -> Simulation:
    n, h, g = p["iterations"], p["height"], p["gap"]
    w = 2 * h * np.tan(np.deg2rad(p["flare"] / 2))
    sim = Simulation(p["f_min"] * 1e9, p["f_max"] * 1e9,
                     boundaries=["MUR", "MUR", "MUR", "MUR", "PEC", "MUR"], max_timesteps=60000)

    metal = sim.metal("gasket", label="Sierpinski gasket")
    tris = gasket(n, w, h, g)
    for t in tris:
        pts = np.array(t)  # (x, z); for normal 'y' CSXCAD expects (z, x)
        metal.AddPolygon(np.array([pts[:, 1], pts[:, 0]]), "y", 0.0, priority=10)
    outer = gasket(0, w, h, g)[0]
    d = p["bridge"] / 2
    bridges = contacts(tris) if d > 0 else []
    for x0, z0 in bridges:
        sq = np.array([[x0 - d, z0 - d], [x0 + d, z0 - d], [x0 + d, z0 + d], [x0 - d, z0 + d]])
        q = clip_to_triangle(sq, outer)
        metal.AddPolygon(np.array([q[:, 1], q[:, 0]]), "y", 0.0, priority=10)
    # feed tab: guarantees the port reaches metal at the apex
    metal.AddPolygon(np.array([[g, g, g + 1.6, g + 1.6], [-0.8, 0.8, 0.8, -0.8]]), "y", 0.0, priority=10)

    sim.lumped_port(1, 50, [0, 0, 0], [0, 0, g], "z", priority=5)

    cell = p["cell"]
    xs = merge_lines({0.0} | {round(v[0], 4) for t in tris for v in t},
                     np.arange(-w / 2 - 2, w / 2 + 2 + 1e-9, cell), 0.45 * cell)
    zs = merge_lines({0.0, g} | {round(v[1], 4) for t in tris for v in t},
                     np.arange(g, g + h + 2 + 1e-9, cell), 0.45 * cell)
    sim.mesh.AddLine("x", np.r_[-DOMAIN["x"], xs, DOMAIN["x"]])
    sim.mesh.AddLine("y", [-DOMAIN["y"], -2 * cell, -cell, 0, cell, 2 * cell, DOMAIN["y"]])
    sim.mesh.AddLine("z", np.r_[zs, DOMAIN["z"]])
    sim.smooth_mesh(ratio=1.3)

    sim.set_focus([-w / 2 - 4, -8, -1], [w / 2 + 4, 8, g + h + 4])
    sim.add_nf2ff_box(center=[0, 0, g + h / 2])
    return sim
