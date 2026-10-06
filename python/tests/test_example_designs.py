"""The example designs in examples/designs/ load, build and pass the design checks without errors
or warnings (notes are allowed), at their defaults and across the ranges of their parameters."""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.design import check_design, design_key, module_for  # noqa: E402
from fairbeam.design_checks import lint  # noqa: E402
from fairbeam.preview import build_preview  # noqa: E402

DESIGNS = sorted((Path(__file__).resolve().parents[2] / "examples" / "designs").glob("*.design.json"))


def problems(d, values=None, bundle=None):
    return [f"{c['severity']} {c['code']} {c.get('path', '')}: {c['message']}"
            for c in lint(d, values, bundle) if c["severity"] in ("error", "warning")]


class ExampleDesigns(unittest.TestCase):
    def test_there_are_examples(self):
        self.assertGreaterEqual(len(DESIGNS), 1)

    def test_clean_at_the_defaults(self):
        for path in DESIGNS:
            with self.subTest(path.name):
                d = json.loads(path.read_text(encoding="utf-8"))
                check_design(d)
                self.assertEqual(design_key(path), path.name[: -len(".design.json")])
                bundle = build_preview(None, {}, design=d)["bundle"]
                self.assertEqual(problems(d, None, bundle), [])
                self.assertTrue(d.get("far_field", {}).get("enabled"))
                self.assertEqual(len(module_for(d).MODEL["id"]) > 0, True)

    def test_blade_is_fed_not_floating(self):
        # the tuning range of the blade: the blade stays on the port, so the optimizer never skips it
        path = next(p for p in DESIGNS if p.name == "blade_867.design.json")
        d = json.loads(path.read_text(encoding="utf-8"))
        for values in ({"h": 40.0}, {"h": 120.0}, {"wb": 20.0, "wt": 10.0}, {"sweep": 0.0}, {"g": 1.0, "wf": 2.0}):
            with self.subTest(values):
                self.assertEqual(problems(d, values), [])

    # --- wideband_dipole_867 (slotted planar dipole, no ground plane) ---

    def test_wideband_dipole_slots_stay_clean(self):
        # the tuning range of the slotted dipole: every cut still removes copper (h_arm above
        # slot_top), the arms stay on the port and on the board (no floating or overhanging metal)
        path = next(p for p in DESIGNS if p.name == "wideband_dipole_867.design.json")
        d = json.loads(path.read_text(encoding="utf-8"))
        part = next(pt for pt in d["parts"] if pt["name"] == "arms")
        self.assertEqual(len(part["cuts"]), 8)   # four slot pairs per arm, mirrored to the other arm
        self.assertEqual(part["transforms"], [{"type": "mirror", "plane": "z", "keep": True}])
        for values in ({"h_arm": 50.0}, {"h_arm": 80.0}, {"l_s": 5.0}, {"l_s": 19.0}, {"p_s": 8.0, "w_s": 1.0},
                       {"w_arm": 50.0, "wf": 10.0}, {"g": 1.0}, {"wf": 3.0, "ht": 4.0}):
            with self.subTest(values):
                self.assertEqual(problems(d, values), [])
        # below slot_top the last slot pair misses the arm: the checks must say so
        codes = {c.split()[1] for c in problems(d, {"h_arm": 46.0})}
        self.assertEqual(codes, {"cut-unused"})

    # --- meander_dipole_867 (printed meander dipole, no ground plane) ---

    def test_meander_dipole_is_fed_not_floating(self):
        # the arms stay on the board and on the port across the tuning ranges of the meander
        path = next(p for p in DESIGNS if p.name == "meander_dipole_867.design.json")
        d = json.loads(path.read_text(encoding="utf-8"))
        for values in ({"n": 1.0}, {"n": 4.0}, {"n": 2.6}, {"l_end": 0.0}, {"l_end": 12.0}, {"l_feed": 10.0},
                       {"a": 8.0}, {"w": 1.0, "p": 4.0}, {"w": 3.0}, {"g": 1.0}, {"sweep": 0.0}):
            with self.subTest(values):
                self.assertEqual(problems(d, values), [])
        # a trace as wide as half the pitch closes the gaps between the rungs: a check error, so the
        # optimizer skips such a point instead of simulating it
        self.assertTrue(any(c.startswith("error") for c in problems(d, {"w": 5.0, "p": 8.0})))

    def test_meander_dipole_mesh_resolves_the_gaps(self):
        # at least two cells across the feed gap (the board joint at z = 0 adds the middle line) and
        # across the gaps between the meander rungs
        path = next(p for p in DESIGNS if p.name == "meander_dipole_867.design.json")
        d = json.loads(path.read_text(encoding="utf-8"))
        mesh = build_preview(None, {}, design=d)["bundle"]["mesh"]
        z = mesh["z"]
        g, w, p, z1 = 2.0, 2.0, 8.0, 1.0 + 30.0

        def cells(lo, hi):
            return sum(1 for a, b in zip(z, z[1:]) if a >= lo - 1e-6 and b <= hi + 1e-6)

        self.assertGreaterEqual(cells(-g / 2, g / 2), 2)
        self.assertGreaterEqual(cells(z1 + w, z1 + p / 2), 2)
        self.assertGreaterEqual(cells(-(z1 + p / 2), -(z1 + w)), 2)

    # --- sleeve_dipole_867 (printed sleeve dipole, coax-fed, no ground plane) ---

    def test_sleeve_dipole_stays_clean(self):
        # the tuning range of the sleeve dipole: the arm, the sleeve strips and the coax strip stay
        # joined (bridge and port), on the board and inside its edges
        path = next(p for p in DESIGNS if p.name == "sleeve_dipole_867.design.json")
        d = json.loads(path.read_text(encoding="utf-8"))
        for values in ({"l_up": 40.0, "l_sl": 40.0}, {"l_up": 120.0, "l_sl": 120.0}, {"l_up": 60.0, "l_sl": 75.0},
                       {"w_sl": 8.0, "w_up": 4.0}, {"wb": 16.0, "w_sl": 16.0, "w_up": 16.0},
                       {"g": 1.0, "s": 0.5, "w_f": 1.0}, {"m": 0.0}, {"t": 0.8}, {"hb": 1.0}):
            with self.subTest(values):
                self.assertEqual(problems(d, values), [])
        # a sleeve wider than the board reaches into the air: the checks must say so
        codes = {c.split()[1] for c in problems(d, {"w_sl": 24.0})}
        self.assertEqual(codes, {"metal-overhang"})

    def test_sleeve_dipole_mesh_resolves_the_gaps(self):
        # at least two cells across the smallest gaps: the slot s beside the coax and the feed gap g
        path = next(p for p in DESIGNS if p.name == "sleeve_dipole_867.design.json")
        d = json.loads(path.read_text(encoding="utf-8"))
        v = {p["key"]: p["default"] for p in d["params"] if "default" in p}
        mesh = build_preview(None, {}, design=d)["bundle"]["mesh"]
        eps = 1e-6
        slot = [x for x in mesh["x"] if v["w_f"] / 2 + eps < x < v["w_f"] / 2 + v["s"] - eps]
        gap = [z for z in mesh["z"] if -v["g"] / 2 + eps < z < v["g"] / 2 - eps]
        self.assertGreaterEqual(len(slot), 1)
        self.assertGreaterEqual(len(gap), 1)

    # --- collinear_867 (sleeve dipole + phasing meander + upper element, no ground plane) ---

    def test_collinear_stays_clean(self):
        # the tuning ranges of the collinear: the meander stays joined to the arm and to the upper
        # element, the feed trace stays on the port and the via, and all the copper stays on the board
        path = next(p for p in DESIGNS if p.name == "collinear_867.design.json")
        d = json.loads(path.read_text(encoding="utf-8"))
        for values in ({"n_m": 4.0}, {"n_m": 7.0, "a_m": 12.0}, {"n_m": 5.4}, {"a_m": 9.0}, {"p_m": 9.0},
                       {"p_m": 16.0}, {"w_m": 1.0}, {"l_t": 30.0}, {"l_t": 60.0}, {"w_t": 1.6, "w_f": 1.6},
                       {"l_top": 120.0}, {"l_top": 160.0}, {"l_up": 60.0, "l_sl": 60.0},
                       {"l_up": 75.0, "l_sl": 75.0}, {"w_up": 6.0, "w_top": 6.0}, {"m": 0.0},
                       {"g": 1.0, "s": 0.5}):
            with self.subTest(values):
                self.assertEqual(problems(d, values), [])
        # a meander wider than the board reaches into the air: the checks must say so
        codes = {c.split()[1] for c in problems(d, {"a_m": 16.0})}
        self.assertEqual(codes, {"metal-overhang"})
        # a feed trace longer than the board leaves the port in the air
        codes = {c.split()[1] for c in problems(d, {"l_t": 80.0})}
        self.assertEqual(codes, {"port-floating", "metal-overhang"})

    def test_collinear_mesh_resolves_the_gaps(self):
        # at least two cells across the smallest gaps and strips: the slot s beside the braid strip,
        # the feed gap g, the feed trace w_t, the gaps between the meander rungs, and four through
        # the board that carries the feed line
        path = next(p for p in DESIGNS if p.name == "collinear_867.design.json")
        d = json.loads(path.read_text(encoding="utf-8"))
        v = {p["key"]: p["default"] for p in d["params"] if "default" in p}
        mesh = build_preview(None, {}, design=d)["bundle"]["mesh"]
        eps = 1e-6

        def inside(axis, lo, hi):
            return [c for c in mesh[axis] if lo + eps < c < hi - eps]

        z0 = v["g"] / 2 + v["l_up"] - v["w_m"]
        self.assertGreaterEqual(len(inside("x", v["w_f"] / 2, v["w_f"] / 2 + v["s"])), 1)
        self.assertGreaterEqual(len(inside("z", -v["g"] / 2, v["g"] / 2)), 1)
        self.assertGreaterEqual(len(inside("x", -v["w_t"] / 2, v["w_t"] / 2)), 1)
        self.assertGreaterEqual(len(inside("z", z0 + v["w_m"], z0 + v["p_m"] / 2)), 1)
        self.assertGreaterEqual(len(inside("y", -v["t"], 0)), 3)

    # --- yagi_867 (5-element ground-station Yagi, hairpin match, strips in the air) ---

    def test_yagi_stays_clean(self):
        # the tuning ranges of the Yagi: the parasitic elements are isolated on purpose and far enough
        # from the driven element and the hairpin not to count as floating metal
        path = next(p for p in DESIGNS if p.name == "yagi_867.design.json")
        d = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(sum(1 for pt in d["parts"] if pt["component"].startswith("antenna/directors")), 3)
        for values in ({"L_de": 140.0}, {"L_de": 170.0}, {"l_hp": 2.0}, {"l_hp": 50.0}, {"d": 2.0}, {"d": 6.0},
                       {"d": 8.0, "l_hp": 2.0}, {"s_r": 50.0}, {"s_r": 150.0}, {"s_1": 20.0}, {"s_2": 20.0},
                       {"s_3": 150.0}, {"L_r": 200.0}, {"L_d1": 100.0, "L_d2": 100.0, "L_d3": 100.0},
                       {"g": 2.0}, {"g": 20.0}):
            with self.subTest(values):
                self.assertEqual(problems(d, values), [])
        # a reflector pulled in onto the hairpin's short: the checks must say so
        codes = {c.split()[1] for c in problems(d, {"s_r": 40.0})}
        self.assertEqual(codes, {"metal-floating"})

    def test_yagi_mesh_resolves_the_strips(self):
        # at least two cells across every element strip, across the feed gap and the hairpin rails,
        # and on each side of the sheet plane
        path = next(p for p in DESIGNS if p.name == "yagi_867.design.json")
        d = json.loads(path.read_text(encoding="utf-8"))
        v = {p["key"]: p["default"] for p in d["params"] if "default" in p}
        mesh = build_preview(None, {}, design=d)["bundle"]["mesh"]
        eps = 1e-6
        w = 2 * v["d"]

        def inside(axis, lo, hi):
            return [c for c in mesh[axis] if lo + eps < c < hi - eps]

        centres = {"reflector": -v["s_r"], "driven": 0.0, "d1": v["s_1"], "d2": v["s_1"] + v["s_2"],
                   "d3": v["s_1"] + v["s_2"] + v["s_3"]}
        for name, x in centres.items():
            with self.subTest(name):
                self.assertGreaterEqual(len(inside("x", x - w / 2, x + w / 2)), 1)
        self.assertGreaterEqual(len(inside("z", -v["g"] / 2, v["g"] / 2)), 1)
        self.assertGreaterEqual(len(inside("z", v["g"] / 2, v["g"] / 2 + w)), 1)
        self.assertGreaterEqual(len(inside("y", -w, 0)), 1)
        self.assertGreaterEqual(len(inside("y", 0, w)), 1)


if __name__ == "__main__":
    unittest.main()
