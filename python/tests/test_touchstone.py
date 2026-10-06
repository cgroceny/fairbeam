import json
import re
import tempfile
import unittest
from pathlib import Path

import numpy as np

from fairbeam.touchstone import parse_touchstone, read_s1p, read_snp, read_touchstone, reflection, write_s1p

ROOT = Path(__file__).resolve().parents[2]
PATCH = ROOT / "public" / "projects" / "patch-antenna.json"
# shared with the browser importer's check (scripts/check-import.mjs)
FIXTURES = ROOT / "examples" / "import-fixtures" / "touchstone"


def bundle(z_port=73.0):
    f = np.linspace(1e9, 2e9, 11)
    zin = 60 + 1j * np.linspace(-40, 40, 11)
    s = (zin - z_port) / (zin + z_port)
    return {"name": "test", "model": {"id": "t"}, "ports": [{"number": 1, "excite": True}],
            "results": {"frequency": f.tolist(),
                        "ports": {"1": {"s11_re": s.real.tolist(), "s11_im": s.imag.tolist(),
                                        "zin_re": zin.real.tolist(), "zin_im": zin.imag.tolist(),
                                        "z_ref": z_port}}}}, f, zin


class TouchstoneTest(unittest.TestCase):
    def test_renormalise_to_50(self):
        b, f, zin = bundle(73.0)
        _, s, z, key = reflection(b, z_ref=50.0)
        self.assertEqual((z, key), (50.0, "1"))
        np.testing.assert_allclose(s, (zin - 50) / (zin + 50), atol=1e-12)

    def test_native_reference(self):
        b, f, zin = bundle(73.0)
        _, s, z, _ = reflection(b, z_ref=None)
        self.assertEqual(z, 73.0)
        np.testing.assert_allclose(s, (zin - 73) / (zin + 73), atol=1e-12)

    def test_round_trip(self):
        b, f, zin = bundle(50.0)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "t.s1p"
            text = write_s1p(b, path)
            self.assertIn("# GHz S RI R 50", text)
            f2, s2, z2 = read_s1p(path)
        self.assertEqual(z2, 50.0)
        np.testing.assert_allclose(f2, f, rtol=1e-9)
        np.testing.assert_allclose(s2, (zin - 50) / (zin + 50), atol=1e-8)

    def test_committed_patch_bundle(self):
        b = json.loads(PATCH.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "p.s1p"
            write_s1p(b, path)
            f, s, _ = read_s1p(path)
        self.assertEqual(len(f), len(b["results"]["frequency"]))
        k = int(np.argmin(np.abs(s)))
        self.assertAlmostEqual(f[k], b["results"]["bands"][0]["f_center"], delta=5e6)

    def test_errors(self):
        with self.assertRaises(ValueError):
            reflection({"results": None})
        b, _, _ = bundle()
        with self.assertRaises(ValueError):
            reflection(b, port=2)


class TouchstoneReaderTest(unittest.TestCase):
    """The fixtures and their closed-form answers are shared with src/import/touchstone.ts."""

    def test_fixtures(self):
        expected = json.loads((FIXTURES / "expected.json").read_text(encoding="utf-8"))["files"]
        self.assertGreaterEqual(len(expected), 17)
        for name, e in expected.items():
            with self.subTest(name):
                if "error" in e:
                    with self.assertRaisesRegex(ValueError, re.escape(e["error"])):
                        read_touchstone(FIXTURES / name)
                    continue
                t = read_touchstone(FIXTURES / name)
                want = np.array(e["s"], float)
                self.assertEqual((t.ports, t.z0), (e["ports"], e["z0"]))
                np.testing.assert_allclose(t.f, e["f"], rtol=1e-12)
                np.testing.assert_allclose(t.s, want[..., 0] + 1j * want[..., 1], atol=e.get("tol", 1e-9))
                self.assertEqual(t.noise_frequencies, e.get("noise", 0))
                for w in e.get("warn", []):
                    self.assertTrue(any(w in x for x in t.warnings), f"no warning with {w!r} in {t.warnings}")
                _, s, _ = read_snp(FIXTURES / name)
                np.testing.assert_array_equal(s, t.s)

    def test_known_networks(self):
        # matched load, series and shunt 50 ohm resistors, spelled out
        _, s11, _ = read_s1p(FIXTURES / "z_matched_load.s1p")
        self.assertAlmostEqual(abs(s11[0]), 0.0, places=12)
        _, s, _ = read_snp(FIXTURES / "y_series_50ohm.s2p")
        np.testing.assert_allclose(s[0], [[1 / 3, 2 / 3], [2 / 3, 1 / 3]], atol=1e-12)
        _, s, _ = read_snp(FIXTURES / "z_shunt_resistor.s2p")
        np.testing.assert_allclose(s[0], [[-1 / 3, 2 / 3], [2 / 3, -1 / 3]], atol=1e-12)

    def test_read_s1p_refuses_multiport(self):
        with self.assertRaisesRegex(ValueError, "2-port data"):
            read_s1p(FIXTURES / "v2_order_12_21.ts")

    def test_errors(self):
        head = "[Version] 2.0\n# GHz S RI R 50\n[Number of Ports] 1\n"
        cases = {
            head + "[Number of Frequencies] 3\n1 0 0\n2 0 0\n": r"\[Number of Frequencies\] is 3, but the file has 2",
            head + "[Matrix Format] Diagonal\n1 0 0\n": r"Invalid \[Matrix Format\]",
            head + "[Mixed-Mode Order] D1,2 C1,2\n1 0 0\n": "Mixed-mode",
            "[Version] 2.0\n[Reference] 50\n[Number of Ports] 1\n1 0 0\n": "must come after",
            "[Version] 2.0\n[Number of Ports] 2\n[Reference] 50\n[Two-Port Data Order] 12_21\n1 0 0 0 0 0 0 0 0\n": "needs 2 values",
            "[Version] 3.0\n1 0 0\n": "not supported",
            "# GHz S RI R -5\n1 0 0\n": "Invalid reference impedance",
            "# GHz S RI R 50\n1 0 0 x\n": "Not a number",
            "# GHz S RI R 50\n1 0 0\n2 0\n": "does not fit 1 port",
            "# GHz S RI R 50\n! nothing\n": "No Touchstone network data",
            "# GHz S RI R 50\n1 0 0 0 0\n": "Cannot tell the port count",
        }
        for text, msg in cases.items():
            with self.subTest(msg), self.assertRaisesRegex(ValueError, msg):
                parse_touchstone(text, "x.ts")

    def test_misc_rules(self):
        # [Begin Information] blocks are skipped, unknown keywords warned about, only the first
        # option line counts, commas and Fortran exponents are accepted
        t = parse_touchstone("[Version] 2.1\n# MHz S RI R 50\n# GHz Z MA R 75\n[Number of Ports] 1\n"
                             "[Begin Information]\n[Anything] 1 2 3\n[End Information]\n[Frobnicate] x\n"
                             "[Network Data]\n100, 0.5D-00, 0.25\n[End]\n", "x.ts")
        self.assertEqual((t.f[0], t.s[0, 0, 0], t.z0, t.unit), (1e8, 0.5 + 0.25j, 50.0, "MHz"))
        self.assertTrue(any("Frobnicate" in w for w in t.warnings))
        # an explicit n must agree with [Number of Ports]
        with self.assertRaisesRegex(ValueError, "asked for"):
            parse_touchstone("[Number of Ports] 1\n1 0 0\n", "x.ts", n=2)
        # a v1 2-port frequency that drops back without 5-number lines is not a noise block
        with self.assertRaisesRegex(ValueError, "not strictly increasing"):
            parse_touchstone("# GHz S RI R 50\n2 0 0 0 0 0 0 0 0\n1 0 0 0 0 0 0 0 0\n", "x.s2p")
        # v1 Z-parameters are normalised to R: z = 1 at R 75 is a matched 75 ohm load
        t = parse_touchstone("# GHz Z RI R 75\n1 1 0\n", "x.s1p")
        self.assertEqual((t.z0, abs(t.s[0, 0, 0])), (75.0, 0.0))


if __name__ == "__main__":
    unittest.main()
