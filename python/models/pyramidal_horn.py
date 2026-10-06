"""Pyramidal horn, WR-90 fed, optimum-gain design for 16 dBi at 10 GHz.

Design (Balanis, *Antenna Theory*, 4th ed., sec. 13.4.3; ``fairbeam.analytic.pyramidal_horn_design``):
for gain G0 the optimum horn has aperture A x B = 86.2 x 64.5 mm and an axial length of 51.8 mm
from the waveguide (22.86 x 10.16 mm) to the aperture. Its aperture efficiency is ~0.51.

Model:
- the feed is a WR-90 section driven by an openEMS rectangular waveguide port in the TE10 mode.
  The guide runs through the PML at z- (``auto_mesh`` pad 0 on that face), which absorbs the
  backward wave, so S11 is the reflection of the horn transition and aperture alone.
- each flared wall is a closed slab (``Polyhedron``, triangulated) of thickness ``wall``, not a
  rotated primitive, so the geometry export and the viewer reproduce it exactly.
- PML on all faces. The NF2FF box skips its z- face, which the feed waveguide crosses.
- mesh from ``auto_mesh`` (lambda/20 at 12 GHz = 1.25 mm; lines at every wall vertex).
"""

import numpy as np
from openEMS.physical_constants import C0

from fairbeam import Param, Simulation
from fairbeam.analytic import pyramidal_horn_design

MODEL = {
    "id": "pyramidal-horn",
    "name": "Pyramidal horn (WR-90, 10 GHz)",
    "description": "Optimum-gain pyramidal horn for 16 dBi at 10 GHz, fed by a WR-90 waveguide port (TE10), PML boundaries.",
    "reference": "C. A. Balanis, Antenna Theory, 4th ed., sec. 13.4 (pyramidal horn design)",
}

PARAMS = [
    Param("gain", 16.0, "Design gain", "dBi", "Sets aperture and length by the optimum-horn equations", minimum=10, maximum=25),
    Param("f0", 10.0, "Design frequency", "GHz", minimum=1, maximum=100),
    Param("wg_a", 22.86, "Waveguide broad wall a", "mm", minimum=1, maximum=500),
    Param("wg_b", 10.16, "Waveguide narrow wall b", "mm", minimum=0.5, maximum=500),
    Param("wall", 2.0, "Wall thickness", "mm", minimum=0.5, maximum=20),
    Param("feed_len", 30.0, "Feed waveguide length (incl. PML)", "mm", minimum=15, maximum=500),
    Param("cpw", 20, "Mesh cells per wavelength", "", minimum=10, maximum=40),
    Param("pad", 0.25, "Air gap to the PML", "lambda", "In wavelengths at f_min, on every face but z-", minimum=0.1, maximum=2),
    Param("f_min", 8.0, "Band start", "GHz", minimum=0.1),
    Param("f_max", 12.0, "Band stop", "GHz", minimum=0.2),
]


def slab(prop, inner, offset):
    """Closed hexahedron: quad ``inner`` (4 x 3) and the same quad shifted by ``offset``, as 12
    triangles (CSXCAD rasterises triangular faces only)."""
    v = np.vstack([inner, inner + np.asarray(offset, float)])
    ph = prop.AddPolyhedron(priority=10)
    for p in v:
        ph.AddVertex(*[float(c) for c in p])
    quads = [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    c = v.mean(axis=0)
    for q in quads:
        for tri in ((q[0], q[1], q[2]), (q[0], q[2], q[3])):
            n = np.cross(v[tri[1]] - v[tri[0]], v[tri[2]] - v[tri[0]])
            if np.dot(n, v[tri[0]] - c) < 0:   # orient outward
                tri = (tri[0], tri[2], tri[1])
            ph.AddFace(list(tri))
    return ph


def build(p: dict) -> Simulation:
    f_min, f_max, f0 = p["f_min"] * 1e9, p["f_max"] * 1e9, p["f0"] * 1e9
    if f_max <= f_min:
        raise ValueError("f_max must be above f_min")
    a, b, t = p["wg_a"], p["wg_b"], p["wall"]
    fc = C0 / (2 * a * 1e-3)
    if f_min <= fc * 1.05:
        raise ValueError(f"f_min must be above the TE10 cutoff ({fc / 1e9:.2f} GHz) of the feed")
    d = pyramidal_horn_design(p["gain"], f0, a, b)
    A, B, L = d["A"], d["B"], d["length"]

    sim = Simulation(f_min, f_max, boundaries=["PML_8"] * 6, max_timesteps=60000)
    # PEC walls in vacuum: nothing can dissipate, so the radiation efficiency is 1 and gain equals
    # directivity; the measured Prad / Pacc (0.99-1.00 since the waveguide port is calibrated,
    # fairbeam.wgport, #12) stays in the bundle as rad_efficiency_raw (Simulation.lossless)
    sim.lossless = True
    horn = sim.metal("horn", label="Horn and feed waveguide")
    z0 = -p["feed_len"]
    # feed waveguide walls (x = +-a/2 side walls, y = +-b/2 broad walls)
    horn.AddBox(priority=10, start=[-a / 2 - t, -b / 2 - t, z0], stop=[a / 2 + t, -b / 2, 0])
    horn.AddBox(priority=10, start=[-a / 2 - t, b / 2, z0], stop=[a / 2 + t, b / 2 + t, 0])
    horn.AddBox(priority=10, start=[-a / 2 - t, -b / 2, z0], stop=[-a / 2, b / 2, 0])
    horn.AddBox(priority=10, start=[a / 2, -b / 2, z0], stop=[a / 2 + t, b / 2, 0])
    # flared walls: inner faces run from the guide (z = 0) to the aperture (z = L)
    for s in (+1, -1):   # E-plane walls (y = +-), spanning the side-wall thickness at the corners
        inner = np.array([[-a / 2 - t, s * b / 2, 0], [a / 2 + t, s * b / 2, 0],
                          [A / 2 + t, s * B / 2, L], [-A / 2 - t, s * B / 2, L]])
        slab(horn, inner, [0, s * t, 0])
    for s in (+1, -1):   # H-plane walls (x = +-)
        inner = np.array([[s * a / 2, -b / 2, 0], [s * a / 2, b / 2, 0],
                          [s * A / 2, B / 2, L], [s * A / 2, -B / 2, L]])
        slab(horn, inner, [s * t, 0, 0])

    # TE10 port: excitation plane 12 cells from the boundary (outside the 8-cell PML), probes 2 mm on
    res = C0 / f_max / 1e-3 / p["cpw"]
    zp = z0 + 12 * res
    if zp + 2.0 >= -2 * res:
        raise ValueError("feed_len too short for the PML plus the port")
    sim.waveguide_port(1, [-a / 2, -b / 2, zp], [a / 2, b / 2, zp + 2.0], "z", a, b, "TE10")

    q = C0 / f_min / 1e-3 * p["pad"]   # air to the PML, none at z- (the guide runs into it)
    sim.auto_mesh(cells_per_wavelength=p["cpw"], pad=[q, q, q, q, 0.0, q])
    sim.set_focus([-A / 2 - 5, -B / 2 - 5, z0], [A / 2 + 5, B / 2 + 5, L + 5])
    sim.add_nf2ff_box(center=[0, 0, L], directions=[1, 1, 1, 1, 0, 1])
    sim.pattern_freqs = sorted({f_min, f0, f_max}) if f_min < f0 < f_max else [f_min, f_max]
    return sim
