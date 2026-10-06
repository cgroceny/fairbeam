"""S-matrix assembly, QA metrics, renormalisation and N-port Touchstone (synthetic data, no openEMS run)."""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from fairbeam.multiport import (ENC_F32, ENC_I16, assemble_s, decode_f32, decode_i16_scaled, decode_pattern_fields,
                                element_pattern_section, encode_f32, encode_i16_scaled, encode_pattern_fields, parse_excite, qa_metrics,
                                reencode_element_patterns, renormalize, s_from_section, sparams_section)
from fairbeam.touchstone import format_snp, full_matrix, read_snp, write_snp

RNG = np.random.default_rng(7)


def random_passive_s(n, n_f=5, reciprocal=True):
    """Random S-matrices scaled to be strictly passive (largest singular value 0.9)."""
    s = RNG.normal(size=(n_f, n, n)) + 1j * RNG.normal(size=(n_f, n, n))
    if reciprocal:
        s = (s + np.transpose(s, (0, 2, 1))) / 2
    for k in range(n_f):
        s[k] *= 0.9 / np.linalg.svd(s[k], compute_uv=False)[0]
    return s


def runs_from_s(s, leak=0.05):
    """Waves of one run per port: the driven port gets a ~1 incident wave, the terminated ports a
    small spurious incident wave (imperfect FDTD terminations); b = S a."""
    n_f, n, _ = s.shape
    a = np.zeros((n, n, n_f), complex)
    for j in range(n):
        a[j] = leak * (RNG.normal(size=(n, n_f)) + 1j * RNG.normal(size=(n, n_f)))
        a[j, j] = 0.8 + 0.3j
    b = np.einsum("fik,jkf->jif", s, a)
    return a, b


class AssembleTest(unittest.TestCase):
    def test_full_excitation_is_exact_despite_leaky_terminations(self):
        s = random_passive_s(3)
        a, b = runs_from_s(s, leak=0.1)
        got = assemble_s(a, b, [1, 2, 3], 3)
        np.testing.assert_allclose(got, s, atol=1e-12)

    def test_run_order_does_not_matter(self):
        s = random_passive_s(2)
        a, b = runs_from_s(s)
        got = assemble_s(a[::-1], b[::-1], [2, 1], 2)
        np.testing.assert_allclose(got, s, atol=1e-12)

    def test_partial_excitation_uses_b_over_a(self):
        s = random_passive_s(3)
        a, b = runs_from_s(s, leak=0.0)  # perfect terminations: b_i / a_j is exact
        got = assemble_s(a[:1], b[:1], [1], 3)
        np.testing.assert_allclose(got[:, :, 0], s[:, :, 0], atol=1e-12)
        self.assertTrue(np.isnan(got[:, :, 1:]).all())

    def test_two_port_textbook_values(self):
        # matched attenuator: S11 = S22 = 0, S21 = S12 = 0.5
        s = np.tile(np.array([[0, 0.5], [0.5, 0]], complex), (4, 1, 1))
        a, b = runs_from_s(s)
        np.testing.assert_allclose(assemble_s(a, b, [1, 2], 2), s, atol=1e-12)


class QATest(unittest.TestCase):
    def test_reciprocal_passive(self):
        s = random_passive_s(3)
        qa = qa_metrics(s, [1, 2, 3])
        self.assertLess(qa["reciprocity_max"], 1e-12)
        self.assertEqual(set(qa["reciprocity_pairs"]), {"1,2", "1,3", "2,3"})
        self.assertTrue(qa["passive"])
        self.assertLessEqual(qa["passivity_max"], 0.81 + 1e-9)  # column power <= sigma_max^2

    def test_non_reciprocal_and_active(self):
        s = np.tile(np.array([[0, 0.2], [0.9, 0]], complex), (3, 1, 1))
        qa = qa_metrics(s, [1, 2])
        self.assertAlmostEqual(qa["reciprocity_max"], 0.7, places=6)
        self.assertTrue(qa["passive"])
        s2 = np.tile(np.array([[0.5, 0], [1.0, 0]], complex), (3, 1, 1))
        qa2 = qa_metrics(s2, [1, 2])
        self.assertFalse(qa2["passive"])
        self.assertAlmostEqual(qa2["column_power_max"]["1"], 1.25, places=6)

    def test_partial_columns(self):
        s = random_passive_s(3)
        s[:, :, 1:] = np.nan
        qa = qa_metrics(s, [1])
        self.assertIsNone(qa["reciprocity_max"])
        self.assertEqual(list(qa["column_power_max"]), ["1"])


class RenormalizeTest(unittest.TestCase):
    def test_one_port(self):
        z = np.array([30 + 20j, 50, 120 - 40j])
        g73 = ((z - 73) / (z + 73)).reshape(-1, 1, 1)
        g50 = renormalize(g73, [73], [50])
        np.testing.assert_allclose(g50[:, 0, 0], (z - 50) / (z + 50), atol=1e-12)

    def test_round_trip_and_identity(self):
        s = random_passive_s(3)
        np.testing.assert_allclose(renormalize(s, [50] * 3, [50] * 3), s, atol=1e-12)
        back = renormalize(renormalize(s, [50, 73, 100], [50, 50, 50]), [50, 50, 50], [50, 73, 100])
        np.testing.assert_allclose(back, s, atol=1e-10)

    def test_series_resistor(self):
        # series R between two ports: S21 = 2 Z0 / (2 Z0 + R) for equal references
        R = 100.0

        def s_series(z0):
            return np.array([[[R / (R + 2 * z0), 2 * z0 / (R + 2 * z0)], [2 * z0 / (R + 2 * z0), R / (R + 2 * z0)]]], complex)
        np.testing.assert_allclose(renormalize(s_series(50.0), [50, 50], [75, 75]), s_series(75.0), atol=1e-12)


class SectionTest(unittest.TestCase):
    def test_section_round_trip(self):
        s = random_passive_s(3, n_f=11)
        sec = sparams_section(np.linspace(1e9, 2e9, 11), s, [1, 2, 3], [50, 50, 50], "B A^-1")
        self.assertTrue(sec["complete"])
        self.assertEqual(len(sec["s"]), 9)
        self.assertEqual(sec["ports"], [1, 2, 3])
        np.testing.assert_allclose(s_from_section(sec), s, atol=1e-5)  # rounded to 5 decimals

    def test_f32_codec(self):
        a = RNG.normal(size=(61, 72)) * 1e-9
        self.assertEqual(decode_f32(encode_f32(a), (61, 72)).shape, (61, 72))
        np.testing.assert_allclose(decode_f32(encode_f32(a), (61, 72)), a, rtol=1e-6)

    def test_i16_codec(self):
        arrays = [RNG.normal(size=(61, 72)) * 1e-3 * k for k in (1, 0.5, 2, 0.01)]
        scale, texts = encode_i16_scaled(arrays)
        self.assertEqual(scale, max(np.abs(a).max() for a in arrays))  # one shared scale
        self.assertEqual(len(texts[0]), (61 * 72 * 2 + 2) // 3 * 4)       # 2 bytes per value
        for a, t in zip(arrays, texts):
            d = decode_i16_scaled(t, (61, 72), scale)
            self.assertEqual(d.shape, (61, 72))
            self.assertLessEqual(np.abs(d - a).max(), 0.5 * scale / 32767 * (1 + 1e-9))
        # the peak itself is exact to the step and stays in range
        k = int(np.argmax([np.abs(a).max() for a in arrays]))
        q = np.frombuffer(__import__("base64").b64decode(texts[k]), "<i2")
        self.assertEqual(np.abs(q).max(), 32767)
        # all zeros: scale 0, decodes to zeros
        s0, t0 = encode_i16_scaled([np.zeros((3, 4))] * 4)
        self.assertEqual(s0, 0.0)
        np.testing.assert_array_equal(decode_i16_scaled(t0[0], (3, 4), s0), np.zeros((3, 4)))
        with self.assertRaises(ValueError):
            encode_i16_scaled([np.array([1.0, np.nan])])

    def test_pattern_fields_both_encodings(self):
        et = RNG.normal(size=(7, 9)) + 1j * RNG.normal(size=(7, 9))
        ep = 0.1 * (RNG.normal(size=(7, 9)) + 1j * RNG.normal(size=(7, 9)))
        for enc, tol in ((ENC_F32, 1e-6), (ENC_I16, 1 / 32767)):
            e = encode_pattern_fields(2.4e9, et, ep, enc)
            self.assertEqual(("scale" in e), enc == ENC_I16)
            a, b = decode_pattern_fields({"encoding": enc, "shape": [7, 9]}, e)
            peak = max(np.abs(et.real).max(), np.abs(et.imag).max())
            self.assertLess(np.abs(a - et).max(), tol * peak * 1.5)
            self.assertLess(np.abs(b - ep).max(), tol * peak * 1.5)
        with self.assertRaises(ValueError):
            encode_pattern_fields(1e9, et, ep, "f64")
        with self.assertRaises(ValueError):
            decode_pattern_fields({"encoding": "f64", "shape": [7, 9]}, e)
        # a section without "encoding" is read as float32 (the only form before int16)
        e32 = encode_pattern_fields(2.4e9, et, ep, ENC_F32)
        np.testing.assert_allclose(decode_pattern_fields({"shape": [7, 9]}, e32)[0], et, rtol=1e-6)

    def test_reencode_bundle(self):
        et = RNG.normal(size=(5, 6)) + 1j * RNG.normal(size=(5, 6))
        sec = {"encoding": ENC_F32, "shape": [5, 6], "theta": list(range(5)), "phi": list(range(6)), "frequencies": [1e9],
               "ports": [{"port": 1, "position": [0, 0, 0], "fields": [encode_pattern_fields(1e9, et, 2 * et, ENC_F32)]}]}
        b = {"name": "x", "results": {"frequency": [1e9, 2e9], "element_patterns": sec}}
        self.assertTrue(reencode_element_patterns(b))
        self.assertEqual(sec["encoding"], ENC_I16)
        self.assertEqual(list(sec["ports"][0]["fields"][0]), ["f", "scale", "e_theta_re", "e_theta_im", "e_phi_re", "e_phi_im"])
        a, c = decode_pattern_fields(sec, sec["ports"][0]["fields"][0])
        self.assertLess(np.abs(c - 2 * et).max(), 2 * np.abs(2 * et.real).max() / 32767 + 1e-6)
        self.assertFalse(reencode_element_patterns(b))
        self.assertFalse(reencode_element_patterns({"results": {}}))
        self.assertEqual(b["name"], "x")

    def test_writer_section(self):
        """element_pattern_section on stand-in simulation objects (no openEMS): int16 by default,
        float32 on request or when the far field is not finite; values per unit incident wave."""
        theta, phi, f = np.arange(0, 181, 30.0), np.arange(0, 360, 60.0), np.linspace(1e9, 2e9, 5)
        def sim(n, gain):
            et = [gain * (np.cos(np.deg2rad(theta))[:, None] + 0j) * np.ones(len(phi))]
            res = SimpleNamespace(E_theta=et, E_phi=[0.5j * et[0]], r=1.0)
            port = SimpleNamespace(uf_inc=np.full(len(f), 2.0 + 0j), Z_ref=50.0)
            return SimpleNamespace(_nf2ff={"theta": theta, "phi": phi, "freqs": [1.5e9], "res": res}, _port_objs=[port],
                                   ports=[{"number": n, "start": [n, 0, 0], "stop": [n, 0, 1]}],
                                   boundaries=["MUR"] * 6, nf2ff_center=[0, 0, 0])
        sims = [(1, sim(1, 1.0)), (2, sim(2, 3.0))]
        a = 2.0 / np.sqrt(50.0)
        sec = element_pattern_section(sims[0][1], sims, f)
        self.assertEqual(sec["encoding"], ENC_I16)
        for (pn, _), p, g in zip(sims, sec["ports"], (1.0, 3.0)):
            self.assertAlmostEqual(p["fields"][0]["scale"], g / a)
            et, ep = decode_pattern_fields(sec, p["fields"][0])
            np.testing.assert_allclose(et[:, 0].real, g / a * np.cos(np.deg2rad(theta)), atol=g / a / 32767)
            np.testing.assert_allclose(ep[:, 0].imag, 0.5 * g / a * np.cos(np.deg2rad(theta)), atol=g / a / 32767)
        self.assertEqual(element_pattern_section(sims[0][1], sims, f, encoding=ENC_F32)["encoding"], ENC_F32)
        sims[1][1]._nf2ff["res"].E_phi[0][0, 0] = np.nan
        self.assertEqual(element_pattern_section(sims[0][1], sims, f)["encoding"], ENC_F32)

    def test_parse_excite(self):
        self.assertEqual(parse_excite(None, [1]), [1])
        self.assertEqual(parse_excite(None, [1, 2, 3]), [1, 2, 3])
        self.assertEqual(parse_excite(None, [1, 2, 3, 4, 5]), [1])
        self.assertEqual(parse_excite("all", [1, 2, 3, 4, 5]), [1, 2, 3, 4, 5])
        self.assertEqual(parse_excite("3,1", [1, 2, 3]), [1, 3])
        # a design port marked "not excited" is not run by default, only when asked for explicitly
        self.assertEqual(parse_excite(None, [1, 2, 3], excitable=[1, 3]), [1, 3])
        self.assertEqual(parse_excite(None, [1, 2], excitable=[2]), [2])
        self.assertEqual(parse_excite("all", [1, 2, 3], excitable=[1]), [1, 2, 3])
        self.assertEqual(parse_excite("2", [1, 2, 3], excitable=[1]), [2])
        self.assertEqual(parse_excite(None, [1, 2], excitable=[]), [1, 2])      # none marked: as before
        self.assertEqual(parse_excite(None, [2, 3], excitable=[3]), [3])        # not 1..n: the first marked one
        self.assertEqual(parse_excite(None, [1, 2, 3, 4, 5], excitable=[1, 2, 3, 4, 5]), [1])  # unchanged rule
        with self.assertRaises(ValueError):
            parse_excite("4", [1, 2, 3])


def bundle_with(s, excited=None, z=(50.0,)):
    n_f, n, _ = s.shape
    excited = excited or list(range(1, n + 1))
    f = np.linspace(1e9, 3e9, n_f)
    sec = sparams_section(f, s, excited, list(z) * (n // len(z)), "B A^-1" if len(excited) == n else "b_i / a_j")
    return {"name": "test", "model": {"id": "t"}, "results": {"frequency": f.tolist(), "sparams": sec}}


class TouchstoneNPortTest(unittest.TestCase):
    def round_trip(self, n, reciprocal=False):
        s = random_passive_s(n, n_f=4, reciprocal=reciprocal)  # non-reciprocal: catches S21/S12 swaps
        b = bundle_with(s)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / f"t.s{n}p"
            text = write_snp(b, path)
            f, s2, z = read_snp(path)
        self.assertEqual(z, 50.0)
        np.testing.assert_allclose(s2, s_from_section(b["results"]["sparams"]), atol=1e-8)
        return text

    def test_two_port_single_line_column_order(self):
        text = self.round_trip(2)
        data = [ln for ln in text.splitlines() if ln and not ln.startswith(("!", "#"))]
        self.assertEqual(len(data), 4)
        self.assertEqual(len(data[0].split()), 9)

    def test_three_port_row_per_line(self):
        text = self.round_trip(3)
        data = [ln for ln in text.splitlines() if ln and not ln.startswith(("!", "#"))]
        self.assertEqual(len(data), 4 * 3)
        self.assertEqual(len(data[0].split()), 7)  # frequency + 3 pairs
        self.assertEqual(len(data[1].split()), 6)  # continuation row

    def test_five_port_wraps_after_four_pairs(self):
        text = self.round_trip(5)
        data = [ln for ln in text.splitlines() if ln and not ln.startswith(("!", "#"))]
        self.assertEqual(len(data), 4 * 5 * 2)
        self.assertEqual(len(data[0].split()), 9)  # frequency + 4 pairs
        self.assertEqual(len(data[1].split()), 2)  # 5th pair of row 1

    def test_missing_columns(self):
        s = random_passive_s(3)
        s[:, :, 1:] = np.nan
        with self.assertRaises(ValueError):
            full_matrix(bundle_with(s, excited=[1]))

    def test_renormalised_header(self):
        s = random_passive_s(2)
        b = bundle_with(s, z=(73.0,))
        with tempfile.TemporaryDirectory() as d:
            text = write_snp(b, Path(d) / "t.s2p", z_ref=50.0)
        self.assertIn("# GHz S RI R 50", text)
        self.assertIn("renormalised to 50 ohm", text)

    def test_format_snp_is_ascii(self):
        s = random_passive_s(4, n_f=2)
        text = format_snp(np.array([1e9, 2e9]), s, 50.0, ["x"])
        text.encode("ascii")


if __name__ == "__main__":
    unittest.main()
