"""fairbeam.automesh on synthetic geometry (no FDTD runs)."""

import unittest
from pathlib import Path

import numpy as np

from fairbeam import Simulation
from fairbeam.automesh import _nearest, _point_in_edges, _point_in_poly, _poly_edges, fill, format_report
from fairbeam.model import load_model, resolve_params

C0 = 299_792_458.0
TEMPLATES = Path(__file__).resolve().parents[1] / "templates"


def lines(sim, a):
    return np.asarray(sim.mesh.GetLines(a), float)


def near(arr, v, tol=1e-6):
    return bool(np.any(np.abs(np.asarray(arr) - v) < tol))


def patch_sim(boundaries=("MUR",) * 6):
    sim = Simulation(1e9, 3e9, boundaries=list(boundaries))
    h = 1.524
    sim.metal("patch").AddBox(priority=10, start=[-16, -20, h], stop=[16, 20, h])
    sim.dielectric("sub", 3.38).AddBox(priority=0, start=[-30, -30, 0], stop=[30, 30, h])
    sim.metal("gnd").AddBox(priority=10, start=[-30, -30, 0], stop=[30, 30, 0])
    sim.lumped_port(1, 50, [-6, 0, 0], [-6, 0, h], "z")
    return sim


def strip_sim():
    sim = Simulation(1.5e9, 3.5e9, boundaries=["PML_8"] * 6)
    arm = sim.metal("dipole")
    arm.AddBox(priority=10, start=[-0.5, 0, 0.5], stop=[0.5, 0, 29])
    arm.AddBox(priority=10, start=[-0.5, 0, -29], stop=[0.5, 0, -0.5])
    sim.lumped_port(1, 73, [-0.5, 0, -0.5], [0.5, 0, 0.5], "z")
    return sim


class PatchRulesTest(unittest.TestCase):
    def setUp(self):
        self.sim = patch_sim()
        self.rep = self.sim.auto_mesh()
        self.res_air = C0 / 3e9 * 1e3 / 20
        self.res_d = self.res_air / np.sqrt(3.38)

    def test_thirds_rule_on_patch_edges(self):
        x = lines(self.sim, "x")
        d = self.res_d / 2
        for edge, inside in ((-16, +1), (16, -1)):
            self.assertTrue(near(x, edge + inside * d / 3), f"no inner third at {edge}")
            self.assertTrue(near(x, edge - inside * 2 * d / 3), f"no outer third at {edge}")
            self.assertFalse(near(x, edge, 1e-3), f"a line sits on the edge {edge}")

    def test_edge_rule_places_exact_metal_edge_when_selected(self):
        sim = patch_sim()
        report = sim.auto_mesh(edge_rule="edge")
        x = lines(sim, "x")
        self.assertTrue(near(x, -16, 1e-6) and near(x, 16, 1e-6))
        self.assertEqual(report["settings"]["edge_rule"], "edge")

    def test_padding_and_grading_options(self):
        sim = patch_sim()
        report = sim.auto_mesh(pad=20, max_ratio=1.3)
        x = lines(sim, "x")
        self.assertAlmostEqual(x[0], -50, places=6)
        self.assertAlmostEqual(x[-1], 50, places=6)
        self.assertLessEqual(report["max_neighbour_ratio"], 1.35)
        self.assertEqual(report["settings"]["pad"], 20)
        self.assertEqual(report["settings"]["max_ratio"], 1.3)

    def test_invalid_grading_ratio_is_rejected_before_meshing(self):
        for ratio in (0, 1, float("nan"), float("inf")):
            with self.subTest(ratio=ratio), self.assertRaisesRegex(ValueError, "max_ratio"):
                patch_sim().auto_mesh(max_ratio=ratio)

    def test_coarse_air_keeps_dielectric_and_edge_resolution(self):
        self.assertNotIn("air_cells_per_wavelength", self.rep["settings"])
        equivalent = patch_sim()
        equivalent.auto_mesh(air_cells_per_wavelength=20)
        for axis in "xyz":
            np.testing.assert_array_equal(lines(equivalent, axis), lines(self.sim, axis))
        sim = patch_sim()
        rep = sim.auto_mesh(air_cells_per_wavelength=10)
        self.assertAlmostEqual(rep["res_air"], self.res_air * 2, places=3)
        self.assertAlmostEqual(rep["res_dielectric"], self.res_d, places=3)
        x = lines(sim, "x")
        d = self.res_d / 2
        self.assertTrue(near(x, 16 - d / 3) and near(x, 16 + 2 * d / 3))
        self.assertLess(rep["total_cells"], self.rep["total_cells"])
        with self.assertRaises(ValueError):
            patch_sim().auto_mesh(air_cells_per_wavelength=21)

    def test_fixed_planes_and_ports(self):
        z = lines(self.sim, "z")
        for v in (0.0, 1.524):
            self.assertTrue(near(z, v))
        self.assertTrue(near(lines(self.sim, "x"), -6.0))      # port plane
        self.assertTrue(near(lines(self.sim, "x"), 30.0))      # dielectric face / ground edge (exact)

    def test_dielectric_layer_and_max_cell(self):
        z = lines(self.sim, "z")
        inside = z[(z >= -1e-9) & (z <= 1.524 + 1e-9)]
        self.assertEqual(len(inside) - 1, 4)                    # dielectric_cells
        x = lines(self.sim, "x")
        w = np.diff(x)
        mids = (x[1:] + x[:-1]) / 2
        self.assertLessEqual(w[np.abs(mids) < 30].max(), self.res_d * 1.001)
        self.assertLessEqual(w.max(), self.res_air * 1.001)

    def test_domain_padding_and_report(self):
        pad = C0 / 1e9 * 1e3 / 4
        x = lines(self.sim, "x")
        self.assertAlmostEqual(x[0], -30 - pad, places=6)
        self.assertAlmostEqual(x[-1], 30 + pad, places=6)
        r = self.rep
        self.assertEqual(r["total_cells"], int(np.prod(r["cells"])))
        self.assertLessEqual(r["max_neighbour_ratio"], 1.6)
        self.assertGreater(r["timestep_s"], 0)
        self.assertIn("cells", format_report(r))
        b = self.sim.to_bundle({"id": "p", "name": "p"}, [])
        self.assertEqual(b["mesh"]["auto"]["total_cells"], r["total_cells"])


class StripRulesTest(unittest.TestCase):
    def setUp(self):
        self.sim = strip_sim()
        self.sim.auto_mesh()

    def test_narrow_strip_cells_across_and_normal(self):
        x = lines(self.sim, "x")
        across = x[(x >= -0.5 - 1e-9) & (x <= 0.5 + 1e-9)]
        self.assertGreaterEqual(len(across) - 1, 6)
        y = lines(self.sim, "y")
        self.assertTrue(near(y, 0.0))
        self.assertTrue(np.sum(np.abs(y) <= 0.34) >= 5)         # two fine cells on each side of the sheet

    def test_arm_ends_thirds_and_gap(self):
        z = lines(self.sim, "z")
        # the thirds rule with the end cell the width of the 1 mm strip (the tip rule), not lambda/40
        d = min(C0 / 3.5e9 * 1e3 / 20 / 2, 1.0)
        self.assertTrue(near(z, 29 - d / 3) and near(z, 29 + 2 * d / 3))
        self.assertTrue(near(z, 0.5) and near(z, -0.5))         # port gap ends (exact)

    def test_pml_padding(self):
        res = C0 / 3.5e9 * 1e3 / 20
        z = lines(self.sim, "z")
        self.assertAlmostEqual(z[-1], 29 + C0 / 1.5e9 * 1e3 / 4 + 8 * res, places=6)


class OtherRulesTest(unittest.TestCase):
    def test_pec_boundary_side_is_not_padded(self):
        sim = Simulation(1e9, 4e9, boundaries=["MUR", "MUR", "MUR", "MUR", "PEC", "MUR"])
        sim.metal("wire").AddBox(start=[-1, -1, 1], stop=[1, 1, 20])
        sim.lumped_port(1, 50, [-1, -1, 0], [1, 1, 1], "z")
        sim.auto_mesh()
        self.assertAlmostEqual(lines(sim, "z")[0], 0.0, places=9)

    def test_joined_boxes_have_no_internal_edge_lines(self):
        sim = Simulation(1e9, 3e9)
        m = sim.metal("m")
        m.AddBox(start=[0, -10, 0], stop=[10, 10, 0])
        m.AddBox(start=[10, -10, 0], stop=[20, 10, 0])            # continues the first box
        sim.auto_mesh()
        x = lines(sim, "x")
        d = C0 / 3e9 * 1e3 / 20 / 2
        self.assertFalse(near(x, 10 - d / 3, 1e-6) or near(x, 10 + 2 * d / 3, 1e-6))
        self.assertTrue(near(x, 20 + 2 * d / 3))                    # the real outer edge

    def test_collinear_edges_of_an_array_keep_the_thirds_rule(self):
        sim = Simulation(1e9, 3e9)
        m = sim.metal("patches")
        for yc in (-30, 30):
            m.AddBox(start=[-16, yc - 20, 1.5], stop=[16, yc + 20, 1.5])
        sim.auto_mesh()
        x = lines(sim, "x")
        d = C0 / 3e9 * 1e3 / 20 / 2
        self.assertFalse(near(x, 16, 1e-3))
        self.assertTrue(near(x, 16 - d / 3) and near(x, 16 + 2 * d / 3))

    def test_slanted_polygon_vertices(self):
        sim = Simulation(1e9, 6e9)
        sim.metal("tri").AddPolygon(np.array([[0, 20, 0], [0, 0, 17.3]]), "z", 1.0)
        sim.auto_mesh()
        self.assertTrue(near(lines(sim, "z"), 1.0))
        self.assertTrue(near(lines(sim, "y"), 17.3) and near(lines(sim, "x"), 20.0))

    def test_existing_lines_are_kept(self):
        sim = patch_sim()
        sim.mesh.AddLine("x", [7.77])
        sim.auto_mesh()
        self.assertTrue(near(lines(sim, "x"), 7.77))

    def test_no_geometry(self):
        with self.assertRaises(ValueError):
            Simulation(1e9, 2e9).auto_mesh()


class SolidAndWireRulesTest(unittest.TestCase):
    @staticmethod
    def slab(prop, inner, offset):
        v = np.vstack([inner, inner + np.asarray(offset, float)])
        ph = prop.AddPolyhedron(priority=10)
        for q in v:
            ph.AddVertex(*[float(c) for c in q])
        for f in ((0, 1, 2), (0, 2, 3), (4, 6, 5), (4, 7, 6), (0, 4, 5), (0, 5, 1),
                  (1, 5, 6), (1, 6, 2), (2, 6, 7), (2, 7, 3), (3, 7, 4), (3, 4, 0)):
            ph.AddFace(list(f))
        return ph

    def test_polyhedron_vertices_and_single_precision_coincidence(self):
        # CSXCAD stores polyhedron vertices in single precision: 11.43 comes back as 11.4300003,
        # which must merge with the box edge at 11.43 instead of leaving a 3e-7 sliver
        sim = Simulation(8e9, 12e9, boundaries=["PML_8"] * 6)
        m = sim.metal("horn")
        m.AddBox(start=[-11.43, -5.08, -20], stop=[11.43, -3.08, 0])
        inner = np.array([[-11.43, -3.08, 0], [11.43, -3.08, 0], [30.1, 20.2, 40], [-30.1, 20.2, 40]])
        self.slab(m, inner, [0, 2, 0])
        sim.auto_mesh()
        x = lines(sim, "x")
        self.assertTrue(near(x, 11.43, 1e-5) and near(x, 30.1, 1e-5))
        self.assertTrue(near(lines(sim, "y"), 20.2, 1e-5) and near(lines(sim, "z"), 40, 1e-5))
        self.assertGreater(np.diff(x).min(), 0.05)
        self.assertLessEqual(sim.mesh_report["max_neighbour_ratio"], 1.5)

    def test_polyhedron_inside_test(self):
        from fairbeam.automesh import extract
        sim = Simulation(1e9, 2e9)
        inner = np.array([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], float)
        self.slab(sim.metal("cube"), inner, [0, 0, 10])
        shape = extract(sim.csx)[0][0]
        self.assertEqual(shape.kind, "polyhedron")
        self.assertTrue(shape.contains([5, 5, 5]) and shape.contains([10, 10, 10]))
        self.assertFalse(shape.contains([5, 5, 10.5]))

    def test_curve_gets_a_fine_cover(self):
        sim = Simulation(2e9, 3e9)
        t = np.linspace(0, 4 * np.pi, 73)
        pts = [20 * np.cos(t), 20 * np.sin(t), 3 + 29 * t / (2 * np.pi)]
        sim.metal("helix").AddCurve(pts)
        sim.metal("gnd").AddBox(start=[-50, -50, 0], stop=[50, 50, 0])
        sim.lumped_port(1, 120, [20, 0, 0], [20, 0, 3], "z")
        sim.auto_mesh()
        res = C0 / 3e9 * 1e3 / 20
        for a in "xyz":
            ln = lines(sim, a)
            inside = ln[(ln > -19) & (ln < 19)] if a != "z" else ln[(ln > 4) & (ln < 60)]
            self.assertLessEqual(np.diff(inside).max(), res / 2 + 1e-6, a)
        self.assertLessEqual(sim.mesh_report["max_neighbour_ratio"], 1.45)

    def test_per_face_pad_zero_runs_into_the_boundary(self):
        sim = Simulation(8e9, 12e9, boundaries=["PML_8"] * 6)
        sim.metal("wg").AddBox(start=[-5, -5, -30], stop=[5, 5, 0])
        sim.auto_mesh(pad=[5, 5, 5, 5, 0, 5])
        z = lines(sim, "z")
        self.assertAlmostEqual(z[0], -30, places=6)
        self.assertGreater(z[-1], 5)
        self.assertEqual(sim.mesh_report["settings"]["pad"], [5.0, 5.0, 5.0, 5.0, 0.0, 5.0])
        with self.assertRaises(ValueError):
            sim.auto_mesh(pad=[1, 2, 3])


class FillTest(unittest.TestCase):
    def test_grading_from_a_small_cell(self):
        x = fill([-100, -0.5, 0.5, 100], lambda t: np.full(np.shape(t), 5.0), 1.4)
        w = np.diff(x)
        r = np.maximum(w[1:] / w[:-1], w[:-1] / w[1:])
        self.assertLessEqual(r.max(), 1.45)
        self.assertLessEqual(w.max(), 5.0 + 1e-9)
        self.assertTrue(near(x, 0.5) and near(x, -0.5))

    def test_split_gap_grades_its_neighbour(self):
        # a 3 mm gap split into two cells: the gap on the other side of the line must grade from
        # the ~1.5 mm cell actually placed, not from the 3 mm gap (was a 2.1 ratio)
        base = [-41.6, 0.0, 3.0] + list(3.0 + 2.49 * np.arange(1, 20))
        x = fill(base, lambda t: np.full(np.shape(t), 5.0), 1.4)
        w = np.diff(x)
        self.assertLessEqual(np.maximum(w[1:] / w[:-1], w[:-1] / w[1:]).max(), 1.45)

    def test_no_sliver_cascade(self):
        # uniform fine lines next to a coarser gap stay unsplit (no halving that spreads outwards)
        base = [-0.949, -0.4745, -0.1876, -0.0938, 0, 0.0938, 0.1876, 0.4745, 0.949, 10]
        x = fill(base, lambda t: np.full(np.shape(t), 2.5), 1.4)
        self.assertGreater(np.diff(x).min(), 0.07)

    def test_cap_function(self):
        x = fill([0, 100], lambda t: np.where(np.asarray(t) < 50, 1.0, 4.0), 1.3)
        w = np.diff(x)
        self.assertLessEqual(w[(x[1:] <= 50)].max(), 1.0 + 1e-6)


def fill_full_scan(lines, cap, ratio, samples=400):
    """fill() as it was before the size field kept only the nearest lines of each side: every line
    scanned for every gap (the reference for FastPathTest)."""
    x = np.unique(np.asarray(lines, float))
    w = np.diff(x)
    cx = np.asarray(cap(x), float)
    h = np.minimum(cx, np.minimum(np.r_[np.inf, w], np.r_[w, np.inf]))
    g = 0.85 * (ratio - 1.0)
    caps = [np.minimum(np.full(samples, np.inf), cap(np.linspace(x[i], x[i + 1], samples))) for i in range(len(w))]
    right, left = np.full(len(x), np.inf), np.full(len(x), np.inf)
    for _ in range(30):
        out = [x[0]]
        new_r, new_l = np.full(len(x), np.inf), np.full(len(x), np.inf)
        for i in range(len(w)):
            a, b = x[i], x[i + 1]
            grow = (1.0 + g) * g / np.expm1(g) if g > 0 else 1.0
            hh = np.minimum(h, grow * np.minimum(right, left))
            hh[i] = min(h[i], grow * left[i])
            hh[i + 1] = min(h[i + 1], grow * right[i + 1])
            t = np.linspace(a, b, samples)
            size = np.minimum(np.min(hh[:, None] + g * np.abs(t[None, :] - x[:, None]), axis=0), caps[i])
            dens = 1.0 / size
            cum = np.r_[0.0, np.cumsum((dens[1:] + dens[:-1]) / 2 * np.diff(t))]
            n = 1 if cum[-1] <= 1.1 else int(np.ceil(cum[-1] - 1e-3))
            inner = list(np.interp(np.arange(1, n) * cum[-1] / n, cum, t)) if n > 1 else []
            seg = [a] + inner + [b]
            new_r[i], new_l[i + 1] = seg[1] - seg[0], seg[-1] - seg[-2]
            out += inner + [b]
        if np.allclose(new_r, right) and np.allclose(new_l, left):
            break
        right, left = new_r, new_l
    return np.array(out)


def fill_per_gap(lines, cap, ratio, samples=400, monotone=False, max_cells=None, boundary_cells=None):
    """fill() as it was before the gaps of a pass were computed together and unchanged gaps were
    reused: one gap at a time, every pass (the reference for FastPathTest and test_design)."""
    x = np.unique(np.asarray(lines, float))
    if len(x) < 2:
        return x
    w = np.diff(x)
    cx = np.asarray(cap(x), float)
    h = np.minimum(cx, np.minimum(np.r_[np.inf, w], np.r_[w, np.inf]))
    if boundary_cells is not None:
        h[[0, -1]] = np.minimum(h[[0, -1]], boundary_cells)
    g = 0.85 * (ratio - 1.0)
    fraction = (1 - np.cos(np.linspace(0, np.pi, samples))) / 2
    ts = [(x[i] + w[i] * fraction if monotone else np.linspace(x[i], x[i + 1], samples))
          for i in range(len(w))]
    caps = [np.minimum(np.full(samples, np.inf), cap(t)) for t in ts]
    right = np.full(len(x), np.inf)
    left = np.full(len(x), np.inf)
    idx = np.arange(len(x))
    grow = (1.0 + g) * g / np.expm1(g) if g > 0 else 1.0
    for _ in range(max(30, 2 * len(x)) if monotone else 30):
        out = [x[0]]
        new_r, new_l = np.full(len(x), np.inf), np.full(len(x), np.inf)
        hh = np.minimum(h, grow * np.minimum(right, left))
        hh_i = np.minimum(h, grow * left)
        hh_j = np.minimum(h, grow * right)
        kl, kr = hh - g * x, hh + g * x
        run = np.minimum.accumulate(kl)
        best_l = np.maximum.accumulate(np.where(kl <= run, idx, 0))
        run = np.minimum.accumulate(kr[::-1])[::-1]
        best_r = np.minimum.accumulate(np.where(kr <= run, idx, len(x))[::-1])[::-1]
        for i in range(len(w)):
            a, b = x[i], x[i + 1]
            t = ts[i]
            size = np.minimum(hh_i[i] + g * np.abs(t - a), hh_j[i + 1] + g * np.abs(t - b))
            if i > 0:
                j = best_l[i - 1]
                size = np.minimum(size, hh[j] + g * np.abs(t - x[j]))
            if i + 2 < len(x):
                j = best_r[i + 2]
                size = np.minimum(size, hh[j] + g * np.abs(t - x[j]))
            size = np.minimum(size, caps[i])
            dens = 1.0 / size
            cum = np.r_[0.0, np.cumsum((dens[1:] + dens[:-1]) / 2 * np.diff(t))]
            n = 1 if cum[-1] <= 1.1 else int(np.ceil(cum[-1] - 1e-3))
            if max_cells is not None and len(out) - 1 + n + len(w) - i - 1 > max_cells:
                raise OverflowError("fine-feature refinement exceeds cell limit")
            inner = list(np.interp(np.arange(1, n) * cum[-1] / n, cum, t)) if n > 1 else []
            seg = [a] + inner + [b]
            new_r[i], new_l[i + 1] = seg[1] - seg[0], seg[-1] - seg[-2]
            out += inner + [b]
        if monotone:
            new_r, new_l = np.minimum(new_r, right), np.minimum(new_l, left)
        if np.allclose(new_r, right) and np.allclose(new_l, left):
            break
        right, left = new_r, new_l
    return np.array(out)


class ScanIndex:
    """automesh._EdgeIndex without the buckets: every edge asked (the reference for the tests)."""

    def __init__(self, pts, tol):
        self.edges, self.tol = _poly_edges(pts), tol

    def inside(self, x, y):
        return _point_in_edges(x, y, self.edges, self.tol)


def koch(level, size=24.0):
    """A Koch snowflake outline (3 * 4**level points, edges at multiples of 60 degrees)."""
    pts = [(0.0, 0.0), (size, 0.0), (size / 2, size * np.sqrt(3) / 2)]
    for _ in range(level):
        out = []
        for i, a in enumerate(pts):
            b = pts[(i + 1) % len(pts)]
            dx, dy = (b[0] - a[0]) / 3, (b[1] - a[1]) / 3
            ang = np.arctan2(dy, dx) - np.pi / 3
            p1, p2 = (a[0] + dx, a[1] + dy), (a[0] + 2 * dx, a[1] + 2 * dy)
            ln = np.hypot(dx, dy)
            out += [a, p1, (p1[0] + ln * np.cos(ang), p1[1] + ln * np.sin(ang)), p2]
        pts = out
    return [(float(x), float(y)) for x, y in pts]


class FastPathTest(unittest.TestCase):
    """The shortcuts for detailed geometry give the answers of the plain scans."""

    def test_fill_matches_the_full_scan(self):
        rng = np.random.default_rng(7)
        for k in range(12):
            base = np.cumsum(rng.choice([0.05, 0.3, 1.0, 4.0, 12.0], size=40)) - 50
            cap = (lambda t: np.full(np.shape(t), 5.0)) if k % 2 else (lambda t: np.where(np.asarray(t) < 0, 1.0, 4.0))
            np.testing.assert_array_equal(fill(base, cap, 1.4), fill_full_scan(base, cap, 1.4))

    def test_polygon_inside_test_matches_the_loop(self):
        # a Minkowski-like outline (many axis-parallel edges) plus slanted ones
        pts = [(0, 0), (4, 0), (4, 1), (5, 1), (5, 0), (9, 0), (9, 9), (5, 9), (4.5, 8), (4, 9), (0, 9), (0, 5), (1, 5), (1, 4), (0, 4)]
        pts = [(x + 0.1 * np.sin(k), y) for k, (x, y) in enumerate(pts * 2)][: len(pts)] + [(0, 2), (-0.5, 1)]
        edges = _poly_edges(pts)
        rng = np.random.default_rng(3)
        probes = [tuple(q) for q in rng.uniform(-1, 10, size=(400, 2))] + pts
        probes += [((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) for a, b in zip(pts, pts[1:] + pts[:1])]
        for x, y in probes:
            self.assertEqual(_point_in_edges(x, y, edges), _point_in_poly(x, y, pts), (x, y))

    def test_fill_matches_the_per_gap_passes(self):
        # the gaps of a pass computed together, in blocks, and only when their inputs changed: the
        # same lines as one gap at a time
        import fairbeam.automesh as am
        rng = np.random.default_rng(11)
        caps = [lambda t: np.full(np.shape(t), 5.0), lambda t: np.where(np.asarray(t) < 0, 1.0, 4.0),
                lambda t: np.where(np.abs(np.asarray(t)) < 20, 0.7, 3.0)]
        rows = am._FILL_ROWS
        try:
            for k in range(24):
                am._FILL_ROWS = (7, 64, rows)[k % 3]
                base = np.cumsum(rng.choice([0.01, 0.05, 0.3, 1.0, 4.0, 12.0, 30.0], size=int(rng.integers(2, 160)))) - 60
                cap, ratio = caps[k % 3], (1.3, 1.4, 1.5, 1.2)[k % 4]
                np.testing.assert_array_equal(fill(base, cap, ratio), fill_per_gap(base, cap, ratio), err_msg=str(k))
        finally:
            am._FILL_ROWS = rows

    def test_edge_index_matches_the_scan(self):
        # a fractal outline: bucketed edges answer as every edge does, on and off the outline
        from fairbeam.automesh import _EdgeIndex
        pts = koch(3)
        rng = np.random.default_rng(5)
        probes = [tuple(q) for q in rng.uniform(-2, 26, size=(600, 2))] + pts
        probes += [((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) for a, b in zip(pts, pts[1:] + pts[:1])]
        probes += [(x, y + d) for x, y in pts[::5] for d in (-1e-7, -5e-8, 5e-8, 1e-7, 2e-7)]
        probes += [(float(x), y) for _, y in pts[::7] for x in rng.uniform(-2, 26, size=6)]
        probes += [(12.0, -1.0), (12.0, 40.0), (-5.0, 5.0)]
        for tol in (1e-7, 1e-3):
            index, scan = _EdgeIndex(pts, tol), ScanIndex(pts, tol)
            for x, y in probes:
                self.assertEqual(index.inside(x, y), scan.inside(x, y), (tol, x, y))

    def test_nearest(self):
        self.assertEqual(_nearest([], 1.0), np.inf)
        self.assertAlmostEqual(_nearest([0.0, 2.0, 5.0], 2.4), 0.4)
        self.assertEqual(_nearest([0.0, 2.0, 2.0, 5.0], 2.0), 0.0)
        self.assertEqual(_nearest([0.0, 2.0, 2.0, 5.0], 2.0, skip=1e-9), 2.0)
        self.assertEqual(_nearest([2.0], 2.0, skip=1e-9), np.inf)


class TemplatesTest(unittest.TestCase):
    def test_templates_use_automesh(self):
        for path in sorted(TEMPLATES.glob("*.py")):
            with self.subTest(template=path.name):
                m = load_model(path)
                sim = m.build(resolve_params(m.PARAMS, {}))
                self.assertIsNotNone(getattr(sim, "mesh_report", None))
                self.assertLessEqual(sim.mesh_report["max_neighbour_ratio"], 1.8)
                self.assertLess(sim.mesh_report["total_cells"], 2_000_000)


if __name__ == "__main__":
    unittest.main()


def wire_dipole(radius=1.0, arm=77.0, gap=2.0, f=(0.7e9, 1.1e9)):
    """A thin-wire dipole: two round arms along y, a lumped port across the gap."""
    sim = Simulation(f[0], f[1], boundaries=["PML_8"] * 6)
    m = sim.metal("wire")
    m.AddCylinder([0, gap / 2, 0], [0, arm, 0], radius, priority=10)
    m.AddCylinder([0, -arm, 0], [0, -gap / 2, 0], radius, priority=10)
    sim.lumped_port(1, 50, [-radius, -gap / 2, -radius], [radius, gap / 2, radius], "y")
    return sim


class ThinWireTipTest(unittest.TestCase):
    """The free end of a thin wire gets cells as wide as the wire (a dipole of 1 mm wires meshed at
    lambda/20 resonated 6 % low when the cell beyond the tip was 14 mm)."""

    def cells_near(self, y, centre, span):
        sel = y[(y >= centre - span) & (y <= centre + span)]
        return np.diff(sel)

    def test_tip_cells_follow_the_wire_diameter(self):
        sim = wire_dipole()
        sim.auto_mesh()
        y = lines(sim, "y")
        res = C0 / 1.1e9 * 1e3 / 20
        self.assertGreater(res, 13)           # the air cells far from the wire are still lambda/20
        for tip in (77.0, -77.0):
            self.assertTrue(near(y, tip))      # the end of the wire is on a line
            self.assertLessEqual(self.cells_near(y, tip, 2.5).max(), 2.0 + 1e-6)   # about one diameter
            self.assertLessEqual(self.cells_near(y, tip, 8.0).max(), 4.0)          # graded up, ratio <= 1.4
        self.assertLessEqual(np.diff(y).max() / res, 1.0 + 1e-6)

    def test_cells_across_the_wire_and_the_gap(self):
        sim = wire_dipole()
        sim.auto_mesh()
        x = lines(sim, "x")
        across = x[(x >= -1 - 1e-9) & (x <= 1 + 1e-9)]
        self.assertGreaterEqual(len(across) - 1, 6)
        y = lines(sim, "y")
        self.assertTrue(near(y, 1.0) and near(y, -1.0))   # the port gap is on lines

    def test_tip_rule_scales_with_the_radius(self):
        sim = wire_dipole(radius=0.5)
        sim.auto_mesh()
        y = lines(sim, "y")
        self.assertLessEqual(self.cells_near(y, 77.0, 1.2).max(), 1.0 + 1e-6)

    def test_joined_end_is_not_a_tip(self):
        # a monopole on a ground plane: the foot is on metal, the top is the only free end
        sim = Simulation(0.7e9, 1.1e9, boundaries=["PML_8"] * 4 + ["PEC", "PML_8"])
        m = sim.metal("mono")
        m.AddCylinder([0, 0, 1], [0, 0, 75], 1.0, priority=10)
        sim.metal("gnd").AddBox(priority=10, start=[-60, -60, 0], stop=[60, 60, 0])
        sim.lumped_port(1, 50, [-1, -1, 0], [1, 1, 1], "z")
        sim.auto_mesh()
        z = lines(sim, "z")
        self.assertLessEqual(self.cells_near(z, 75.0, 2.5).max(), 2.0 + 1e-6)
        # the grading from the free end reaches the coarse cells (no fine cells at the foot, which is on metal)
        mid = np.diff(z[(z >= 20) & (z <= 60)])
        self.assertGreater(mid.min(), 3.0)

    def test_thick_cylinder_is_unchanged(self):
        # a 30 mm radius rod is not a thin arm: the mesh is what it was without the tip rule
        import fairbeam.automesh as am

        def mesh():
            sim = Simulation(0.7e9, 1.1e9, boundaries=["PML_8"] * 6)
            sim.metal("rod").AddCylinder([0, -60, 0], [0, 60, 0], 30.0, priority=10)
            sim.lumped_port(1, 50, [-30, -1, -1], [30, 1, 1], "y")
            sim.auto_mesh()
            return [lines(sim, a) for a in "xyz"]

        with_rule = mesh()
        original = am._tip_width
        am._tip_width = lambda *a, **k: None
        try:
            without = mesh()
        finally:
            am._tip_width = original
        for a, b in zip(with_rule, without):
            np.testing.assert_allclose(a, b)

    def test_resolution_of_the_tip_does_not_depend_on_density(self):
        # the tip cells come from the wire, so the end looks the same at 20 and 40 cells per wavelength
        ends = []
        for cpw in (20, 40):
            sim = wire_dipole()
            sim.auto_mesh(cells_per_wavelength=cpw)
            y = lines(sim, "y")
            ends.append(self.cells_near(y, 77.0, 2.5).max())
        self.assertLessEqual(max(ends), 2.0 + 1e-6)


class SheetNormalCellsTest(unittest.TestCase):
    """A wide zero-thickness sheet gets cells of half the local maximum next to it, normal to it (a blade
    on a lambda/20 mesh had 14 mm cells straddling it and resonated 7 % low)."""

    def blade_sim(self):
        sim = Simulation(0.7e9, 1.05e9, boundaries=["MUR"] * 6)
        # a 60 mm wide, 80 mm tall blade in the plane y = 0 (x across, z up) on a 300 mm ground plane
        sim.metal("blade").AddPolygon(np.array([[-30, 30, 30, -30], [2, 2, 82, 82]]), "y", 0.0, priority=10)
        sim.metal("gnd").AddBox(priority=10, start=[-150, -150, 0], stop=[150, 150, 0])
        sim.lumped_port(1, 50, [0, 0, 0], [0, 0, 2], "z")
        return sim

    def test_cells_next_to_a_blade_are_half_the_local_cell(self):
        sim = self.blade_sim()
        sim.auto_mesh(refine_features=False)
        y = lines(sim, "y")
        res = C0 / 1.05e9 * 1e3 / 20
        self.assertTrue(near(y, 0.0))
        self.assertTrue(near(y, res / 2) and near(y, -res / 2))
        self.assertLessEqual(np.diff(y[(y >= -res / 2 - 1e-9) & (y <= res / 2 + 1e-9)]).max(), res / 2 + 1e-6)
        z = lines(sim, "z")
        self.assertTrue(near(z, res / 2) or near(z, 0.0))   # the ground plane's normal cells too

    def test_no_line_inside_a_substrate(self):
        # a patch on its substrate: the substrate layer sets the cells below the patch, the rule only adds air above
        sim = patch_sim()
        sim.auto_mesh()
        z = lines(sim, "z")
        h = 1.524
        res = C0 / 3e9 * 1e3 / 20 / np.sqrt(3.38) / 2   # the patch sits on the substrate face: the dielectric cell, halved
        self.assertTrue(near(z, h + res))
        inside = z[(z > 0) & (z < h)]
        self.assertGreaterEqual(len(inside), 3)             # dielectric_cells layers, as before

    def test_a_denser_mesh_refines_the_sheet_too(self):
        coarse, dense = self.blade_sim(), self.blade_sim()
        # With no feed gap the wavelength still controls the normal cell.
        # A feed gap now sets its own local cap, independent of global density.
        coarse.ports.clear()
        dense.ports.clear()
        coarse.auto_mesh(cells_per_wavelength=20)
        dense.auto_mesh(cells_per_wavelength=40)
        near_sheet = lambda sim: np.diff(lines(sim, "y")[(lines(sim, "y") >= -1e-9) & (lines(sim, "y") <= 12)])[0]
        self.assertAlmostEqual(near_sheet(coarse) / near_sheet(dense), 2.0, places=3)


class CurvedShapesTest(unittest.TestCase):
    """Tubes (CylindricalShell) and spheres, the designer's tube and sphere shapes."""

    def test_tube_wall_and_sphere_extent(self):
        sim = patch_sim()
        # a thin-walled tube along z (outer 1.2, inner 1.0) and a sphere above the patch
        sim.metal("tube").AddCylindricalShell([20, 20, 0], [20, 20, 1.524], 1.1, 0.2, priority=10)
        sim.metal("ball").AddSphere([-20, 20, 6], 2.0, priority=10)
        sim.auto_mesh()
        x, y, z = lines(sim, "x"), lines(sim, "y"), lines(sim, "z")
        for c in (18.8, 19.0, 21.0, 21.2):   # outer and inner wall faces
            self.assertTrue(near(x, c) and near(y, c), f"no wall line at {c}")
        # at least two cells across the 0.2 mm wall
        self.assertGreaterEqual(int(np.sum((x > 18.8 - 1e-9) & (x < 19.0 + 1e-9))), 3)
        for v, arr in ((-22, x), (-18, x), (18, y), (22, y), (4, z), (8, z)):
            self.assertTrue(near(arr, v), f"no sphere extent line at {v}")


class RotatedShapeBoundsTest(unittest.TestCase):
    """CSXCAD's GetBoundBox() ignores a primitive's transform: the mesh must follow the rotated shape."""

    @staticmethod
    def rotated_box_sim(angle, rotate=("z",)):
        sim = Simulation(1e9, 3e9, boundaries=["MUR"] * 6)
        blk = sim.metal("blk").AddBox(priority=10, start=[-5, -2, 0], stop=[5, 2, 2])
        for ax in rotate:
            blk.AddTransform("RotateAxis", ax, angle)
        sim.dielectric("sub", 3.38).AddBox(priority=0, start=[-30, -30, -3], stop=[30, 30, 0])
        sim.lumped_port(1, 50, [-4, 0, -3], [-4, 0, 0], "z")
        return sim, blk

    @staticmethod
    def world_extent(angle):
        c, s = np.cos(np.radians(angle)), np.sin(np.radians(angle))
        corners = [(x, y) for x in (-5, 5) for y in (-2, 2)]
        xs = [c * x - s * y for x, y in corners]
        ys = [s * x + c * y for x, y in corners]
        return max(xs), max(ys)

    def test_csxcad_bound_box_ignores_the_transform(self):
        _, blk = self.rotated_box_sim(30)
        # the premise of the fix: CSXCAD reports the local box, so automesh must not use it
        np.testing.assert_allclose(np.asarray(blk.GetBoundBox(), float), [[-5, -2, 0], [5, 2, 2]])

    def test_mesh_lines_on_the_rotated_box_extent(self):
        for angle in (30, 45, -20, 135):
            with self.subTest(angle=angle):
                sim, _ = self.rotated_box_sim(angle)
                sim.auto_mesh(edge_rule="edge")
                ex, ey = self.world_extent(angle)
                x, y = lines(sim, "x"), lines(sim, "y")
                for v in (-ex, ex):
                    self.assertTrue(near(x, v, 1e-5), f"no x line on the rotated extent {v:.4f} at {angle} deg")
                for v in (-ey, ey):
                    self.assertTrue(near(y, v, 1e-5), f"no y line on the rotated extent {v:.4f} at {angle} deg")

    def test_default_rule_brackets_the_rotated_extent(self):
        sim, _ = self.rotated_box_sim(30)
        sim.auto_mesh()
        ex, ey = self.world_extent(30)
        x, y = lines(sim, "x"), lines(sim, "y")
        # the thirds rule leaves lines on both sides of the extent, within the local cell size
        for arr, v in ((x, ex), (x, -ex), (y, ey), (y, -ey)):
            self.assertTrue(np.any(arr < v - 1e-6) and np.any(arr > v + 1e-6))
            self.assertLess(float(np.min(np.abs(arr - v))), 1.5)

    def test_rotation_about_x_moves_the_z_extent(self):
        sim, _ = self.rotated_box_sim(50, rotate=("x",))
        sim.auto_mesh(edge_rule="edge")
        c, s = np.cos(np.radians(50)), np.sin(np.radians(50))
        zs = [s * y + c * z for y in (-2, 2) for z in (0, 2)]
        z = lines(sim, "z")
        for v in (min(zs), max(zs)):
            self.assertTrue(near(z, v, 1e-5), f"no z line on the rotated extent {v:.4f}")
