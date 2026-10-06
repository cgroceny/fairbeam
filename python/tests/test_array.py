"""fairbeam.array against the analytic array factor, plus smoke tests of the multi-port models."""

import json
import unittest
from pathlib import Path

import numpy as np

from fairbeam.array import C0, combine, cut, element_patterns, grating_lobes, normalize_weights, steering_weights
from fairbeam.model import load_model, resolve_params
from fairbeam.multiport import ENC_F32, ENC_I16, encode_pattern_fields, reencode_element_patterns, sparams_section
from fairbeam.simulation import excite_only

MODELS = Path(__file__).resolve().parents[1] / "models"
REPO = Path(__file__).resolve().parents[2]
F0 = 2.4e9
THETA = np.arange(0, 181, 3.0)
PHI = np.arange(0, 360, 5.0)


def synthetic_bundle(positions_mm, s=None, element=lambda th, ph: np.ones_like(th), encoding=ENC_I16):
    """Bundle with ideal embedded patterns: E_theta = g(theta, phi) exp(j k r_hat . r_n), E_phi = 0,
    stored in ``encoding`` (the writer's default unless given)."""
    k0 = 2 * np.pi * F0 / C0
    th, ph = np.meshgrid(np.deg2rad(THETA), np.deg2rad(PHI), indexing="ij")
    rhat = np.stack([np.sin(th) * np.cos(ph), np.sin(th) * np.sin(ph), np.cos(th)], axis=-1)
    ports = []
    for n, r in enumerate(positions_mm, 1):
        e = element(th, ph) * np.exp(1j * k0 * rhat @ (np.asarray(r) * 1e-3))
        z = np.zeros_like(th)
        ports.append({"port": n, "position": list(map(float, r)),
                      "fields": [encode_pattern_fields(F0, e, z, encoding)]})
    f = np.linspace(2e9, 3e9, 11)
    n = len(positions_mm)
    s = np.zeros((len(f), n, n), complex) if s is None else s
    return {
        "units": {"length_m": 1e-3},
        "results": {
            "frequency": f.tolist(),
            "sparams": sparams_section(f, s, list(range(1, n + 1)), [50.0] * n, "B A^-1"),
            "element_patterns": {"radius_m": 1.0, "encoding": encoding, "shape": [len(THETA), len(PHI)],
                                 "theta": THETA.tolist(), "phi": PHI.tolist(), "frequencies": [F0],
                                 "mirror_planes": 0, "ports": ports},
        },
    }


class CombineTest(unittest.TestCase):
    def test_two_element_array_factor(self):
        lam = C0 / F0 * 1e3
        d = 0.5 * lam
        b = synthetic_bundle([(0, -d / 2, 0), (0, d / 2, 0)])
        beta = 60.0
        r = combine(b, {1: 1, 2: (1, beta)})
        k = 2 * np.pi / lam
        th, ph = np.meshgrid(np.deg2rad(THETA), np.deg2rad(PHI), indexing="ij")
        af = np.abs(1 + np.exp(1j * (k * d * np.sin(th) * np.sin(ph) + np.deg2rad(beta)))) ** 2
        want = 10 * np.log10(af / (np.trapezoid(af.mean(axis=1) * np.sin(np.deg2rad(THETA)), np.deg2rad(THETA)) / 2))
        got = np.asarray(r["directivity_dbi"])
        m = want > want.max() - 40
        np.testing.assert_allclose(got[m], want[m], atol=0.02)

    def test_isotropic_single_element(self):
        r = combine(synthetic_bundle([(0, 0, 0), (0, 60, 0)]), {1: 1})
        self.assertAlmostEqual(r["dmax_dbi"], 0.0, delta=0.01)
        # realized gain: |E| = 1 V/m at 1 m per unit incident wave -> 4 pi r^2 |E|^2 / (eta0 |a|^2)
        self.assertAlmostEqual(r["realized_gain_max_dbi"], 10 * np.log10(4 * np.pi / 376.730313668), delta=0.01)

    def test_broadside_gain_of_n_elements(self):
        lam = C0 / F0 * 1e3
        pos = [(0, i * lam / 2, 0) for i in range(4)]
        b = synthetic_bundle(pos, element=lambda th, ph: np.cos(th / 2) ** 2)  # forward-leaning element
        one = combine(b, {1: 1})["dmax_dbi"]
        four = combine(b, [1, 1, 1, 1])
        self.assertEqual((four["peak_theta"], ), (0.0, ))
        self.assertTrue(10 * np.log10(4) - 1.0 < four["dmax_dbi"] - one < 10 * np.log10(4) + 0.5)

    def test_steering(self):
        lam = C0 / F0 * 1e3
        pos = [(0, i * lam / 2, 0) for i in range(8)]
        b = synthetic_bundle(pos, element=lambda th, ph: np.cos(th / 2) ** 2)  # no backward twin beam
        for th0 in (0, 20, 40):
            r = combine(b, steering_weights(b, th0, 90))
            t, d = cut(r, 90)
            self.assertAlmostEqual(abs(t[int(np.argmax(d))]), th0, delta=3.1)
            # the grid maximum lies on the steering cone: direction cosine along the array axis
            v = np.sin(np.deg2rad(r["peak_theta"])) * np.sin(np.deg2rad(r["peak_phi"]))
            self.assertAlmostEqual(v, np.sin(np.deg2rad(th0)), delta=0.03)

    def test_active_reflection(self):
        s = np.zeros((11, 2, 2), complex)
        s[:, 0, 0] = s[:, 1, 1] = 0.1
        s[:, 0, 1] = s[:, 1, 0] = 0.2j
        b = synthetic_bundle([(0, -30, 0), (0, 30, 0)], s=s)
        r = combine(b, {1: 1, 2: (1, 90)})
        # Gamma_1 = S11 + S12 w2 / w1 = 0.1 + 0.2j * 1j = -0.1 ; Gamma_2 = S22 + S21 w1 / w2 = 0.1 + 0.2j / 1j = 0.3
        self.assertAlmostEqual(r["gamma_active_at_f"][1], -0.1 + 0j, places=4)
        self.assertAlmostEqual(r["gamma_active_at_f"][2], 0.3 + 0j, places=4)
        self.assertEqual(len(r["gamma_active"][1]), 11)

    def test_grating_lobes(self):
        lam = C0 / F0 * 1e3
        half = synthetic_bundle([(0, i * lam / 2, 0) for i in range(4)])
        g = grating_lobes(half, 45, 90)
        self.assertAlmostEqual(g["spacing_wavelengths"], 0.5, places=6)
        self.assertAlmostEqual(g["limit_spacing_wavelengths"], 1 / (1 + np.sin(np.pi / 4)), places=6)
        self.assertEqual(g["visible"], [])
        wide = synthetic_bundle([(0, i * 0.7 * lam, 0) for i in range(4)])
        g = grating_lobes(wide, 45, 90)
        self.assertEqual(len(g["visible"]), 1)
        self.assertAlmostEqual(g["visible"][0]["direction_cosine"], np.sin(np.pi / 4) - 1 / 0.7, places=4)
        # and the combined pattern really has a second beam there
        r = combine(wide, steering_weights(wide, 45, 90))
        t, d = cut(r, 90)
        tg = g["visible"][0]["angle_from_broadside_deg"]
        k = int(np.argmin(np.abs(t - tg)))
        self.assertGreater(d[k], d.max() - 3.5)

    def test_weights(self):
        w = normalize_weights({2: (2.0, 90)}, [1, 2])
        self.assertEqual(w[1], 0)
        self.assertAlmostEqual(w[2], 2j)
        with self.assertRaises(ValueError):
            normalize_weights({3: 1}, [1, 2])
        with self.assertRaises(ValueError):
            combine(synthetic_bundle([(0, 0, 0)]), {1: 0})


class EncodingTest(unittest.TestCase):
    """Both element-pattern encodings (docs/BUNDLE.md#element-pattern-encodings) give the same arrays."""

    def test_int16_matches_float32(self):
        lam = C0 / F0 * 1e3
        pos = [(0, i * lam / 2, 0) for i in range(4)]
        g = lambda th, ph: np.cos(th / 2) ** 2  # noqa: E731
        b32, b16 = synthetic_bundle(pos, element=g, encoding=ENC_F32), synthetic_bundle(pos, element=g, encoding=ENC_I16)
        self.assertIn("scale", b16["results"]["element_patterns"]["ports"][0]["fields"][0])
        for th0 in (0, 30, 60):
            w = steering_weights(b32, th0, 90)
            r32, r16 = combine(b32, w), combine(b16, w)
            self.assertEqual((r32["peak_theta"], r32["peak_phi"]), (r16["peak_theta"], r16["peak_phi"]))
            self.assertAlmostEqual(r32["dmax_dbi"], r16["dmax_dbi"], delta=1e-3)
            d32, d16 = np.asarray(r32["directivity_dbi"]), np.asarray(r16["directivity_dbi"])
            m = d32 > r32["dmax_dbi"] - 40
            self.assertLess(np.abs(d32 - d16)[m].max(), 0.02)

    def test_float32_fixture(self):
        """examples/fixtures/element-patterns-f32.json keeps the pre-int16 encoding of the committed
        2x1 array (every 2nd theta/phi sample): it must still decode, agree with the re-encoded
        bundle to within the int16 step, and combine to a broadside beam."""
        old = json.loads((REPO / "examples/fixtures/element-patterns-f32.json").read_text(encoding="utf-8"))
        new = json.loads((REPO / "public/projects/patch-array-2x1.json").read_text(encoding="utf-8"))
        so, sn = old["results"]["element_patterns"], new["results"]["element_patterns"]
        self.assertEqual((so["encoding"], sn["encoding"]), (ENC_F32, ENC_I16))
        _, _, fo = element_patterns(old)
        _, _, fn = element_patterns(new)
        ti = [sn["theta"].index(t) for t in so["theta"]]
        pi = [sn["phi"].index(p) for p in so["phi"]]
        for port, entry in zip((p["port"] for p in sn["ports"]), (p["fields"][0] for p in sn["ports"])):
            step = entry["scale"] / 32767
            for a, b in zip(fo[port], fn[port]):
                err = np.abs(a - b[np.ix_(ti, pi)])
                self.assertLessEqual(err.max(), step)  # 0.5 step per component, re and im
        r = combine(old, [1, 1])
        self.assertEqual(r["peak_theta"], 0.0)
        self.assertAlmostEqual(r["dmax_dbi"], combine(new, [1, 1])["dmax_dbi"], delta=0.3)  # coarser grid
        # and converting the fixture reproduces the committed encoding's accuracy
        conv = json.loads(json.dumps(old))
        self.assertTrue(reencode_element_patterns(conv))
        self.assertFalse(reencode_element_patterns(conv))
        _, _, fc = element_patterns(conv)
        for port in fo:
            for a, c in zip(fo[port], fc[port]):
                self.assertLess(np.abs(a - c).max(), np.abs(a).max() / 32767 + 1e-12)


class MultiportModelTest(unittest.TestCase):
    """Geometry-only builds (no FDTD run) of the multi-port models."""

    def build(self, name, **overrides):
        m = load_model(MODELS / name)
        return m.build(resolve_params(m.PARAMS, {k: str(v) for k, v in overrides.items()}))

    @staticmethod
    def min_cells(sim):
        return [float(np.diff(np.asarray(sim.mesh.GetLines(a))).min()) for a in "xyz"]

    def test_microstrip_line(self):
        sim = self.build("microstrip_line.py")
        self.assertEqual([p["number"] for p in sim.ports], [1, 2])
        self.assertTrue(all(p["excite"] for p in sim.ports))  # the runner decides which one is driven
        self.assertGreater(min(self.min_cells(sim)), 0.05)
        self.assertIsNone(sim.nf2ff)

    def test_wilkinson(self):
        sim = self.build("wilkinson_divider.py")
        self.assertEqual([p["number"] for p in sim.ports], [1, 2, 3])
        self.assertEqual(len(sim.lumped_elements), 1)
        self.assertEqual(sim.lumped_elements[0]["R"], 100.0)
        y = np.asarray(sim.mesh.GetLines("y"))
        np.testing.assert_allclose(np.sort(-y), y, atol=1e-6)  # ports 2 and 3 see mirrored meshes
        self.assertGreater(min(self.min_cells(sim)), 0.1)
        b = sim.to_bundle({"id": "w", "name": "w"}, [])
        self.assertEqual(b["lumped_elements"][0]["direction"], "y")
        self.assertFalse(any(p["type"] == "LumpedElement" for p in b["parts"]))

    def test_patch_array(self):
        sim = self.build("patch_array_2x1.py")
        self.assertEqual(len(sim.ports), 2)
        ys = sorted((p["start"][1] + p["stop"][1]) / 2 for p in sim.ports)
        self.assertAlmostEqual(ys[1] - ys[0], 61.2)
        self.assertIsNotNone(sim.nf2ff)

    def test_excite_only(self):
        m = load_model(MODELS / "wilkinson_divider.py")
        values = resolve_params(m.PARAMS, {})
        with excite_only(2):
            sim = m.build(values)
        self.assertEqual([p["excite"] for p in sim.ports], [False, True, False])
        sim = m.build(values)  # the override does not leak out of the context
        self.assertEqual([p["excite"] for p in sim.ports], [True, True, True])

    def test_bad_parameters(self):
        with self.assertRaises(ValueError):
            self.build("patch_array_2x1.py", spacing=40)  # below the minimum (patches would touch)
        with self.assertRaises(ValueError):
            self.build("wilkinson_divider.py", offset=12)  # arm too short for the offset


if __name__ == "__main__":
    unittest.main()
