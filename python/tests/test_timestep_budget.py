"""The automatic timestep budget and 35 µm copper drawn as an extruded outline (lane CONV).

The reported design: an FR-4 patch whose ground plane is a 35 µm *extruded polygon* (not a brick). Thin
metal built as sheets only flattened bricks, so that ground kept its thickness: the mesh got 11.7 µm cells,
the timestep fell to 31 fs, the excitation pulse alone took the whole 60000 timesteps and the run never
converged, whatever "mesh › thin metal" said."""

import copy
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fairbeam.design import (AUTO_BUDGET_CELL_STEPS, AUTO_MAX_TIMESTEPS, AUTO_MIN_TIMESTEPS, DT_SAFETY, RUN_BUDGET_CELL_STEPS, auto_timesteps, build,  # noqa: E402
                             VOLUME_COST_FACTOR, resolve_names, resolve_parts, thin_metal_limit, thin_sheets, to_python)
from fairbeam.design_checks import errors, lint  # noqa: E402
from fairbeam.excitation import dgauss_duration_s  # noqa: E402
from fairbeam.preview import build_preview  # noqa: E402


def rounded_board(half=25.0, r=1.0, n=8):
    """A rounded rectangle outline, counter-clockwise, as the designer writes one."""
    pts = []
    for cx, cy, a0 in ((half - r, -half + r, -90), (half - r, half - r, 0), (-half + r, half - r, 90), (-half + r, -half + r, 180)):
        for k in range(n + 1):
            a = math.radians(a0 + 90 * k / n)
            pts.append([round(cx + r * math.cos(a), 6), round(cy + r * math.sin(a), 6)])
    return pts


def reported_design(thin_metal=None):
    """The reported patch: substrate and ground are extruded outlines, patch and feed are bricks."""
    outline = rounded_board()
    d = {
        "schema": "fairbeam.design/1",
        "model": {"id": "reported", "name": "Reported", "description": ""},
        "params": [{"key": "f0", "default": 2.45, "label": "f0", "unit": "GHz"}],
        "simulation": {"f_min": "f0 * 0.6", "f_max": "f0 * 1.4", "boundaries": "MUR", "end_criteria_db": -50},
        "materials": [{"name": "copper", "kind": "metal", "library": "pec"},
                      {"name": "fr4", "kind": "dielectric", "eps_r": 4.3, "tan_d": 0.02, "tan_d_freq": "f0"}],
        "parts": [
            {"name": "substrate", "material": "fr4", "primitives": [
                {"kind": "linpoly", "normal": "z", "elevation": -1.6, "points": outline, "length": 1.6}]},
            {"name": "patch", "material": "copper", "primitives": [
                {"kind": "box", "start": [-15, -20, 0], "stop": [15, 20, 0.035]}]},
            {"name": "feed", "material": "copper", "primitives": [
                {"kind": "box", "start": [-1, -25, 0], "stop": [1, -20, 0.035]}]},
            {"name": "ground", "material": "copper", "primitives": [
                {"kind": "linpoly", "normal": "z", "elevation": -1.6, "points": outline, "length": "-(0.035)"}]},
        ],
        "ports": [{"type": "lumped", "number": 1, "R": 50, "start": [0, -24.15, -1.6], "stop": [0, -24.15, 0], "direction": "z"}],
        "resistors": [],
        "mesh": {"mode": "auto", "cells_per_wavelength": 20},
        "far_field": {"enabled": True, "frequencies": ["f0"]},
    }
    if thin_metal:
        d["mesh"]["thin_metal"] = thin_metal
    return d


class AutoBudget(unittest.TestCase):
    def test_floor_scale_and_budget(self):
        f_max = 3.43e9
        pulse = dgauss_duration_s(f_max)
        # a normal mesh (timestep 0.4 ps, 0.65 M cells): the pulse needs far less than 60000, and the limit is
        # what the cell-step budget allows (a converging run stops earlier; a slowly ringing cavity gets the room)
        a = auto_timesteps(4.0e-13, f_max, 6.5e5)
        self.assertEqual(a["steps"], int(AUTO_BUDGET_CELL_STEPS / 6.5e5) // 10000 * 10000)
        self.assertGreater(a["steps"], AUTO_MIN_TIMESTEPS)
        self.assertFalse(a["over_budget"])
        # a big mesh gets the floor, a tiny one the cap
        self.assertEqual(auto_timesteps(4.0e-13, f_max, 4.0e6)["steps"], AUTO_MIN_TIMESTEPS)
        self.assertEqual(auto_timesteps(4.0e-13, f_max, 1.0e4)["steps"], AUTO_MAX_TIMESTEPS)
        self.assertAlmostEqual(a["pulse_steps"], pulse / (4.0e-13 * DT_SAFETY), places=3)
        # a 31 fs timestep: the pulse alone is ~58000 steps; the limit covers it and its decay, but the cost is too much
        b = auto_timesteps(3.88e-14, f_max, 1.52e6)
        self.assertGreater(b["pulse_steps"], 55000)
        self.assertGreaterEqual(b["steps"], 4 * b["pulse_steps"])
        self.assertEqual(b["steps"] % 10000, 0)
        self.assertTrue(b["over_budget"])
        self.assertAlmostEqual(b["work"], 1.52e6 * 4 * b["pulse_steps"])
        self.assertGreater(b["work"], RUN_BUDGET_CELL_STEPS)
        # the same timestep on a tiny mesh is cheap: allowed, with the long limit
        c = auto_timesteps(3.88e-14, f_max, 2.0e4)
        self.assertFalse(c["over_budget"])
        self.assertGreater(c["steps"], AUTO_MIN_TIMESTEPS)


class ExtrudedOutlineSheets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sheet = build_preview(None, {}, design=reported_design())["bundle"]
        cls.volume = build_preview(None, {}, design=reported_design("volume"))["bundle"]

    def test_the_ground_outline_becomes_a_sheet(self):
        d = reported_design()
        names = resolve_names(d, {})
        parts = resolve_parts(d, names)
        sheets = thin_sheets(parts, thin_metal_limit(d, names))
        self.assertEqual(sorted(parts[s["part"]]["name"] for s in sheets), ["feed", "ground", "patch"])
        ground = next(s for s in sheets if parts[s["part"]]["name"] == "ground")
        self.assertEqual((ground["axis"], ground["side"], round(ground["at"], 6)), (2, "max", -1.6))   # on the substrate's bottom face
        self.assertAlmostEqual(ground["thickness"], 0.035)
        # "volume" no longer keeps 35 µm: cells across it would make the timestep 50x smaller (lane MCONV)
        vol = {**d, "mesh": {**d["mesh"], "thin_metal": "volume"}}
        self.assertEqual(sorted(parts[s["part"]]["name"] for s in thin_sheets(parts, thin_metal_limit(vol, names))),
                         ["feed", "ground", "patch"])
        self.assertAlmostEqual(thin_metal_limit(vol, names), VOLUME_COST_FACTOR * thin_metal_limit(d, names))
        self.assertAlmostEqual(thin_metal_limit(vol, names, force=True), thin_metal_limit(d, names))
        # a plate at least 0.6 of the finest cell thick keeps its volume in "volume" mode
        thick = copy.deepcopy(vol)
        thick["parts"][3]["primitives"][0]["length"] = -1.5
        parts = resolve_parts(thick, names)
        self.assertNotIn("ground", [parts[s["part"]]["name"] for s in thin_sheets(parts, thin_metal_limit(thick, names))])
        # a thick extrusion is not a sheet
        thick = copy.deepcopy(d)
        thick["parts"][3]["primitives"][0]["length"] = -0.4
        parts = resolve_parts(thick, names)
        self.assertNotIn("ground", [parts[s["part"]]["name"] for s in thin_sheets(parts, thin_metal_limit(thick, names))])

    def test_the_mesh_and_the_timestep(self):
        self.assertGreater(self.sheet["mesh"]["min_cell"], 0.1)
        # "volume" meshes the same (no 12 µm cells, no 30 fs timestep) ...
        self.assertGreater(self.volume["mesh"]["min_cell"], 0.1)
        self.assertEqual(self.volume["mesh"]["total_cells"], self.sheet["mesh"]["total_cells"])
        self.assertAlmostEqual(self.volume["mesh"]["auto"]["timestep_s"], self.sheet["mesh"]["auto"]["timestep_s"])
        # ... and a ground thick enough to matter still gets its cells: the volume setting is honoured there
        d = reported_design("volume")
        d["parts"][3]["primitives"][0]["length"] = -1.5
        thick = build_preview(None, {}, design=d)["bundle"]
        self.assertLess(thick["mesh"]["auto"]["timestep_s"], self.sheet["mesh"]["auto"]["timestep_s"])

    def test_the_port_spans_the_substrate_between_the_sheets(self):
        port = self.sheet["ports"][0]
        self.assertEqual((port["start"][2], port["stop"][2]), (-1.6, 0.0))

    def test_the_limit_is_chosen_by_the_build(self):
        # no explicit limit: at least the long-standing default, and the pulse with its decay
        sheet_limit = self.sheet["solver"]["max_timesteps"]
        self.assertGreaterEqual(sheet_limit, AUTO_MIN_TIMESTEPS)
        pulse = dgauss_duration_s(self.sheet["solver"]["excitation"]["f_max"]) / self.sheet["mesh"]["auto"]["timestep_s"]
        self.assertGreater(sheet_limit, 3 * pulse)
        volume_limit = self.volume["solver"]["max_timesteps"]
        self.assertEqual(volume_limit, sheet_limit)
        d = reported_design("volume")
        d["simulation"]["max_timesteps"] = 12345
        self.assertEqual(build_preview(None, {}, design=d)["bundle"]["solver"]["max_timesteps"], 12345)
        d["simulation"]["max_timesteps"] = "auto"
        self.assertEqual(build_preview(None, {}, design=d)["bundle"]["solver"]["max_timesteps"], volume_limit)

    def test_checks_with_sheets(self):
        c = lint(reported_design(), None, self.sheet)
        self.assertEqual(errors(c), [])
        codes = [x["code"] for x in c]
        self.assertNotIn("thin-metal-volume", codes)
        self.assertNotIn("run-too-long", codes)
        notes = [x["message"] for x in c if x["code"] == "thin-metal"]
        self.assertEqual(len(notes), 3)   # patch, feed and the extruded ground
        self.assertTrue(any(m.startswith("'ground': 35 µm metal is modeled as a sheet at z = -1.6") for m in notes))

    def test_checks_with_volume_say_it_is_a_sheet_and_do_not_block(self):
        d = reported_design("volume")
        c = lint(d, None, self.volume)
        codes = [x["code"] for x in c]
        self.assertEqual(errors(c), [])
        self.assertNotIn("run-too-long", codes)
        self.assertNotIn("thin-metal", codes)
        warns = [x for x in c if x["code"] == "thin-metal-volume"]
        self.assertEqual(len(warns), 3)   # patch, feed and the extruded ground
        self.assertEqual({w["severity"] for w in warns}, {"warning"})
        ground = next(w for w in warns if w["message"].startswith("'ground'"))
        self.assertIn("modeled as a sheet at z = -1.6", ground["message"])
        self.assertRegex(ground["message"], r"about \d+x smaller")

    def test_an_explicit_limit_is_still_checked(self):
        d = reported_design()
        d["simulation"]["max_timesteps"] = 1000
        b = build_preview(None, {}, design=d)["bundle"]
        c = lint(d, None, b)
        err = next(x for x in c if x["code"] == "excitation-too-long")
        self.assertEqual(err["severity"], "error")
        self.assertEqual(err["fix"]["set"], {"simulation.max_timesteps": err["fix"]["set"]["simulation.max_timesteps"]})
        self.assertNotIn("run-too-long", [x["code"] for x in c])

    def test_the_python_export_flattens_the_outline_too(self):
        src = to_python(reported_design())
        self.assertIn("AddPolygon", src)
        self.assertIn("thin metal, built as a sheet", src)


def thin_patch(h=0.254, eps=2.2, tan=0.0009, max_steps=None):
    """A 70 mm RT5880-like patch board, probe fed, ground and patch as 35 µm copper."""
    d = {
        "schema": "fairbeam.design/1",
        "model": {"id": "rt", "name": "RT", "description": ""},
        "params": [],
        "simulation": {"f_min": 1.5, "f_max": 3.4, "boundaries": "MUR", "end_criteria_db": -50},
        "materials": [{"name": "copper", "kind": "metal", "library": "pec"},
                      {"name": "sub", "kind": "dielectric", "eps_r": eps, "tan_d": tan, "tan_d_freq": 2.45}],
        "parts": [
            {"name": "substrate", "material": "sub", "primitives": [{"kind": "box", "start": [-35, -35, -h], "stop": [35, 35, 0]}]},
            {"name": "ground", "material": "copper", "primitives": [{"kind": "box", "start": [-35, -35, -h - 0.035], "stop": [35, 35, -h]}]},
            {"name": "patch", "material": "copper", "primitives": [{"kind": "box", "start": [-20, -20, 0], "stop": [20, 20, 0.035]}]},
        ],
        "ports": [{"type": "lumped", "number": 1, "R": 50, "start": [0, -6, -h - 0.035], "stop": [0, -6, 0.035], "direction": "z"}],
        "resistors": [],
        "mesh": {"mode": "auto", "cells_per_wavelength": 20},
        "far_field": {"enabled": True, "frequencies": [2.45]},
    }
    if max_steps:
        d["simulation"]["max_timesteps"] = max_steps
    return d


class RingDown(unittest.TestCase):
    def test_estimate_follows_the_cavity(self):
        from fairbeam.design import ringdown_steps
        # the 0.254 mm RT5880 patch rang for about 50 ns (282,000 steps of 0.18 ps were needed)
        r = ringdown_steps(2.2, 0.0009, 0.254, 2.45e9, 1.47e-13, 50, 3.43e9)
        self.assertGreater(r["q"], 50)
        self.assertLess(r["q"], 90)
        self.assertGreater(r["seconds"], 35e-9)
        self.assertLess(r["seconds"], 70e-9)
        # thicker and lossier substrates ring much shorter; a thick slab is not a cavity at all
        fr4 = ringdown_steps(4.3, 0.02, 1.6, 2.45e9, 8e-13, 50, 3.43e9)
        self.assertLess(fr4["q"], 15)
        self.assertLess(fr4["steps"], 60000)
        self.assertIsNone(ringdown_steps(4.3, 0.02, 20.0, 2.45e9, 8e-13, 50))
        # thinner means higher Q
        self.assertGreater(ringdown_steps(2.2, 0.0009, 0.127, 2.45e9, 1e-13, 50)["q"], r["q"])

    def test_the_automatic_limit_covers_the_ring_down_and_a_short_one_is_flagged(self):
        d = thin_patch()
        b = build_preview(None, {}, design=d)["bundle"]
        need = 282000   # measured on the GPU engine, 0.254 mm RT5880
        self.assertGreater(b["solver"]["max_timesteps"], need)
        self.assertEqual([x["code"] for x in lint(d, None, b) if x["code"] == "slow-ringdown"], [])
        short = thin_patch(max_steps=60000)
        c = [x for x in lint(short, None, build_preview(None, {}, design=short)["bundle"]) if x["code"] == "slow-ringdown"]
        self.assertEqual(len(c), 1)
        self.assertEqual(c[0]["severity"], "warning")
        self.assertIn("high-Q cavity", c[0]["message"])
        self.assertEqual(list(c[0]["fix"]["set"]), ["simulation.max_timesteps"])
        self.assertGreater(c[0]["fix"]["set"]["simulation.max_timesteps"], need)
        # an ordinary 1.6 mm FR-4 board does not
        fr4 = thin_patch(h=1.6, eps=4.3, tan=0.02, max_steps=60000)
        self.assertEqual([x["code"] for x in lint(fr4, None, build_preview(None, {}, design=fr4)["bundle"]) if x["code"] == "slow-ringdown"], [])

    def test_thin_copper_volume_builds_like_sheets(self):
        d = thin_patch(h=1.6, eps=4.3, tan=0.02)
        sheet = build_preview(None, {}, design=d)["bundle"]
        d["mesh"]["thin_metal"] = "volume"
        vol = build_preview(None, {}, design=d)["bundle"]
        self.assertEqual(vol["mesh"]["total_cells"], sheet["mesh"]["total_cells"])
        self.assertEqual(vol["solver"]["max_timesteps"], sheet["solver"]["max_timesteps"])
        self.assertGreater(vol["mesh"]["min_cell"], 0.1)


if __name__ == "__main__":
    unittest.main()
