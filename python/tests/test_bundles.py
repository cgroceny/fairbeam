"""Schema sanity checks on the committed example bundles (public/projects/*.json)."""

import json
import math
import unittest
from pathlib import Path

PROJECTS = Path(__file__).resolve().parents[2] / "public" / "projects"

TOP_LEVEL = ["schema", "generator", "created", "name", "model", "units", "solver", "parts", "ports",
             "half_space", "mesh", "domain", "nf2ff_box", "nf2ff_center", "focus", "run", "results"]
BAND_KEYS = {"f_lo", "f_hi", "f_center", "s11_min_db", "fractional_bw", "edge_lo", "edge_hi"}
FF_KEYS = {"f", "theta", "phi", "directivity_dbi", "dmax_dbi", "prad_w", "pacc_w", "rad_efficiency",
           "mirror_planes"}


def bundles():
    return [p for p in sorted(PROJECTS.glob("*.json")) if p.name != "index.json"]


def finite_numbers(obj):
    if isinstance(obj, float):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from finite_numbers(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from finite_numbers(v)


class BundleSchemaTest(unittest.TestCase):
    def test_there_are_bundles(self):
        self.assertTrue(bundles())

    def test_bundles(self):
        for path in bundles():
            with self.subTest(bundle=path.name):
                self.check_bundle(json.loads(path.read_text(encoding="utf-8")))

    def check_bundle(self, b):
        for key in TOP_LEVEL:
            self.assertIn(key, b)
        self.assertTrue(b["schema"].startswith("fairbeam.project/"))
        self.assertTrue(all(math.isfinite(x) for x in finite_numbers(b)))

        m = b["mesh"]
        cells = [len(m[a]) - 1 for a in "xyz"]
        self.assertEqual(m["cells"], cells)
        self.assertEqual(m["total_cells"], cells[0] * cells[1] * cells[2])
        for a in "xyz":
            self.assertTrue(all(q > p for p, q in zip(m[a], m[a][1:])), f"mesh {a} not increasing")
        for k, idx in (("min", 0), ("max", -1)):  # mesh lines are rounded to 4 decimals, domain is not
            for got, want in zip(b["domain"][k], [m[a][idx] for a in "xyz"]):
                self.assertAlmostEqual(got, want, delta=1e-4)

        self.assertEqual(set(b["solver"]["boundaries"]), {"x-", "x+", "y-", "y+", "z-", "z+"})
        for part in b["parts"]:
            self.assertTrue(part["primitives"])
            for prim in part["primitives"]:
                self.assertIn(prim["kind"], ("box", "polygon", "linpoly", "cylinder", "curve", "wire",
                                             "polyhedron", "bbox"))
                if prim["kind"] in ("polygon", "linpoly"):
                    self.assertIn(prim["normal"], (0, 1, 2))
                    self.assertTrue(all(len(pt) == 2 for pt in prim["points"]))
                if prim["kind"] in ("curve", "wire"):
                    self.assertGreaterEqual(len(prim["points"]), 2)
                    self.assertTrue(all(len(pt) == 3 for pt in prim["points"]))
                if prim["kind"] == "polyhedron":
                    nv = len(prim["vertices"])
                    self.assertTrue(all(len(f) >= 3 and all(0 <= i < nv for i in f) for f in prim["faces"]))
        for port in b["ports"]:
            self.assertIn(port["direction"], ("x", "y", "z"))
            self.assertIn(port.get("type", "lumped"), ("lumped", "waveguide"))
            if port.get("type") == "waveguide":
                self.assertTrue({"mode", "a", "b", "f_cutoff"} <= set(port))
        keys = {p["key"] for p in b["model"]["params"]}
        self.assertEqual(len(keys), len(b["model"]["params"]))

        res = b["results"]
        if res is None:
            self.assertIsNone(b["run"])
            return
        n = len(res["frequency"])
        self.assertTrue(all(q > p for p, q in zip(res["frequency"], res["frequency"][1:])))
        excited = {str(p["number"]) for p in b["ports"] if p["excite"]}
        self.assertTrue(excited <= set(res["ports"]))
        for pr in res["ports"].values():
            for k in ("s11_re", "s11_im", "zin_re", "zin_im"):
                self.assertEqual(len(pr[k]), n, k)
            # passive structure: |S11| <= 1 (small numerical tolerance)
            self.assertTrue(all(r * r + i * i <= 1.0 + 1e-3 for r, i in zip(pr["s11_re"], pr["s11_im"])))
        f_lo, f_hi = res["frequency"][0], res["frequency"][-1]
        for band in res["bands"]:
            self.assertEqual(set(band), BAND_KEYS)
            self.assertTrue(f_lo <= band["f_lo"] <= band["f_center"] <= band["f_hi"] <= f_hi)
            self.assertLess(band["s11_min_db"], -10)
        for ff in res["farfield"]:
            self.assertTrue(FF_KEYS <= set(ff))
            grid = ff["directivity_dbi"]
            self.assertEqual(len(grid), len(ff["theta"]))
            self.assertTrue(all(len(row) == len(ff["phi"]) for row in grid))
            peak = max(max(row) for row in grid)
            self.assertAlmostEqual(peak, ff["dmax_dbi"], delta=0.02)
            if ff["rad_efficiency"] is not None:
                # a passive antenna cannot radiate more than it accepts (allow FDTD/NF2FF error)
                self.assertLess(ff["rad_efficiency"], 1.1)
        sig = res["signals"]
        if sig:
            for k in ("u_inc", "u_ref", "u_tot", "i_tot_scaled"):
                self.assertEqual(len(sig[k]), len(sig["time_ns"]))
        self.assertIsNotNone(b["run"])
        self.assertIn("converged", b["run"])

    def test_index_matches_bundles(self):
        index = json.loads((PROJECTS / "index.json").read_text(encoding="utf-8"))
        files = {e["file"] for e in index["projects"]}
        self.assertEqual(files, {p.name for p in bundles()})
        for e in index["projects"]:
            b = json.loads((PROJECTS / e["file"]).read_text(encoding="utf-8"))
            self.assertEqual(e["model"], b["model"]["id"])
            self.assertEqual(e["simulated"], bool(b["results"]))
            self.assertEqual(e["cells"], b["mesh"]["total_cells"])


if __name__ == "__main__":
    unittest.main()
