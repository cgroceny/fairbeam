"""PCB artwork import (fairbeam.pcb_import): DXF, Gerber RS-274X and Excellon drill files as a design.

The fixtures in tests/fixtures/pcb/ are small synthetic files: a patch, a patch with an inset feed
notch, a circle, an arc-rounded shape, a hole, skipped entities, a region / stroke / flash Gerber
set, a Gerber with arcs, and two drill files. Geometry is checked by area and extent against
closed forms; the design goes through ``design_checks`` (only the expected no-port error is left)
and is built (the geometry preview, no simulation).
"""

import contextlib
import io
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from fairbeam import cli  # noqa: E402
from fairbeam.design import check_design, evaluate  # noqa: E402
from fairbeam.design_checks import lint  # noqa: E402
from fairbeam.pcb_import import (PcbImportError, guess_role, import_pcb, parse_dxf, parse_excellon,  # noqa: E402
                                 parse_gerber, parse_layer_map, read_dxf)
from fairbeam.preview import build_preview  # noqa: E402

FIX = HERE / "fixtures" / "pcb"


def load(*names, **kw):
    return import_pcb([(n, (FIX / n).read_bytes()) for n in names], **kw)


def area(points):
    return abs(sum(points[i][0] * points[(i + 1) % len(points)][1] - points[(i + 1) % len(points)][0] * points[i][1]
                   for i in range(len(points)))) / 2


def part(design, name):
    return next(p for p in design["parts"] if p["name"] == name)


def prim_area(prims):
    return sum(area(p["points"]) for p in prims if p["kind"] == "polygon")


def extent(prims):
    pts = [q for p in prims for q in p["points"]]
    return min(q[0] for q in pts), min(q[1] for q in pts), max(q[0] for q in pts), max(q[1] for q in pts)


def notes(res, severity=None, text=None):
    return [n for n in res["report"]["notes"] if (severity is None or n["severity"] == severity)
            and (text is None or text in n["message"] or text in n["where"])]


def max_sagitta(points, r):
    """Largest distance between a chord and the circle of radius r through its ends."""
    worst = 0.0
    n = len(points)
    for i in range(n):
        a, b = points[i], points[(i + 1) % n]
        half = math.dist(a, b) / 2
        worst = max(worst, r - math.sqrt(max(r * r - half * half, 0.0)))
    return worst


def dxf_text(entities, units=4):
    head = "0\nSECTION\n2\nHEADER\n" + (f"9\n$INSUNITS\n70\n{units}\n" if units is not None else "") + "0\nENDSEC\n"
    return head + "0\nSECTION\n2\nENTITIES\n" + "".join(entities) + "0\nENDSEC\n0\nEOF\n"


def lwpoly(layer, pts, closed=True):
    return f"0\nLWPOLYLINE\n8\n{layer}\n90\n{len(pts)}\n70\n{1 if closed else 0}\n" + "".join(f"10\n{x}\n20\n{y}\n" for x, y in pts)


def dxf_line(layer, a, b):
    return f"0\nLINE\n8\n{layer}\n10\n{a[0]}\n20\n{a[1]}\n11\n{b[0]}\n21\n{b[1]}\n"


class DxfParsing(unittest.TestCase):
    def test_group_codes_units_and_entities(self):
        doc = read_dxf((FIX / "patch_rect.dxf").read_text())
        self.assertEqual(doc["units"], 4)
        self.assertEqual([e["type"] for e in doc["entities"]], ["LWPOLYLINE", "LWPOLYLINE"] + ["LINE"] * 4)

    def test_binary_dxf_and_garbage_are_refused(self):
        with self.assertRaisesRegex(PcbImportError, "binary DXF"):
            read_dxf("AutoCAD Binary DXF\r\n\x1a\x00")
        with self.assertRaisesRegex(PcbImportError, "not a DXF group code"):
            read_dxf("0\nSECTION\nnot a number\nENTITIES\n")

    def test_closed_polyline_becomes_a_ring_on_its_layer(self):
        layers = parse_dxf((FIX / "patch_notch.dxf").read_text(), "n.dxf", units="auto", chord_tol=0.02)
        self.assertEqual([l.name for l in layers], ["TOP"])
        (pts, _label, _line), = layers[0].rings
        self.assertEqual(len(pts), 8)
        self.assertAlmostEqual(area(pts), 30 * 20 - 6 * 8)

    def test_a_polyline_whose_ends_coincide_is_closed(self):
        text = dxf_text([lwpoly("TOP", [(0, 0), (10, 0), (10, 5), (0, 5), (0, 0)], closed=False)])
        (lay,) = parse_dxf(text, "a.dxf", units="auto", chord_tol=0.02)
        self.assertEqual(len(lay.rings), 1)
        self.assertEqual(lay.open, [])
        self.assertAlmostEqual(area(lay.rings[0][0]), 50)

    def test_lines_meeting_end_to_end_form_a_loop_in_any_order_and_direction(self):
        text = dxf_text([dxf_line("L", (10, 0), (10, 5)), dxf_line("L", (0, 0), (10, 0)),
                         dxf_line("L", (0, 5), (10, 5)), dxf_line("L", (0, 5), (0, 0))])
        (lay,) = parse_dxf(text, "a.dxf", units="auto", chord_tol=0.02)
        self.assertEqual((len(lay.rings), len(lay.open)), (1, 0))
        self.assertAlmostEqual(area(lay.rings[0][0]), 50)

    def test_lines_with_a_gap_stay_open(self):
        text = dxf_text([dxf_line("L", (0, 0), (10, 0)), dxf_line("L", (10, 0), (10, 5)), dxf_line("L", (10, 5), (0, 5)),
                         dxf_line("L", (0, 5), (0, 0.5))])
        (lay,) = parse_dxf(text, "a.dxf", units="auto", chord_tol=0.02)
        self.assertEqual((len(lay.rings), len(lay.open)), (0, 4))

    def test_mirrored_extrusion_flips_x(self):
        e = "0\nCIRCLE\n8\nC\n10\n5.0\n20\n1.0\n40\n2.0\n210\n0\n220\n0\n230\n-1\n"
        (lay,) = parse_dxf(dxf_text([e]), "a.dxf", units="auto", chord_tol=0.02)
        pts = lay.rings[0][0]
        self.assertAlmostEqual(sum(p[0] for p in pts) / len(pts), -5.0, places=6)
        self.assertAlmostEqual(sum(p[1] for p in pts) / len(pts), 1.0, places=6)
        tilted = "0\nCIRCLE\n8\nC\n10\n0\n20\n0\n40\n2.0\n210\n1\n220\n0\n230\n0\n"
        (lay,) = parse_dxf(dxf_text([tilted]), "a.dxf", units="auto", chord_tol=0.02)
        self.assertIn(("CIRCLE", "the entity is not in a plane parallel to XY"), lay.skips)

    def test_polyline_with_vertices(self):
        e = ("0\nPOLYLINE\n8\nP\n70\n1\n0\nVERTEX\n8\nP\n10\n0\n20\n0\n0\nVERTEX\n8\nP\n10\n4\n20\n0\n"
             "0\nVERTEX\n8\nP\n10\n4\n20\n3\n0\nSEQEND\n8\nP\n")
        (lay,) = parse_dxf(dxf_text([e]), "a.dxf", units="auto", chord_tol=0.02)
        self.assertAlmostEqual(area(lay.rings[0][0]), 6)


class Units(unittest.TestCase):
    def test_insunits_inch(self):
        res = load("patch_inch.dxf")
        x0, y0, x1, y1 = extent(part(res["design"], "top_copper")["primitives"])
        self.assertAlmostEqual(x1 - x0, 1.2 * 25.4, places=5)
        self.assertAlmostEqual(y1 - y0, 0.8 * 25.4, places=5)

    def test_units_flag_overrides_and_warns(self):
        res = load("patch_inch.dxf", units="mm")
        x0, _y0, x1, _y1 = extent(part(res["design"], "top_copper")["primitives"])
        self.assertAlmostEqual(x1 - x0, 1.2, places=5)
        self.assertTrue(notes(res, "warning", "overrides the DXF's own unit"))

    def test_missing_insunits_assumes_mm_with_a_warning(self):
        text = dxf_text([lwpoly("TOP", [(0, 0), (20, 0), (20, 10), (0, 10)])], units=None)
        res = import_pcb([("a.dxf", text)])
        self.assertTrue(notes(res, "warning", "does not say its units"))
        x0, _y0, x1, _y1 = extent(part(res["design"], "top_copper")["primitives"])
        self.assertAlmostEqual(x1 - x0, 20.0)

    def test_gerber_carries_its_own_units(self):
        res = load("patch_bottom.gbl", layer_map="patch_bottom=bottom_copper")   # MOIN, FSLAX24
        x0, y0, x1, y1 = extent(part(res["design"], "bottom_copper")["primitives"])
        self.assertAlmostEqual(x1 - x0, 60.0, delta=0.01)
        self.assertAlmostEqual(y1 - y0, 50.0, delta=0.01)   # 0.9843 in is 25.0012 mm


class Tessellation(unittest.TestCase):
    def circle_ring(self, tol):
        res = load("circle.dxf", chord_tol=tol)
        (prim,) = part(res["design"], "top_copper")["primitives"]
        return prim["points"], res

    def test_chord_error_stays_within_the_tolerance(self):
        for tol in (0.1, 0.02, 0.005):
            pts, _res = self.circle_ring(tol)
            centre = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
            self.assertTrue(all(abs(math.dist(p, centre) - 10) < 1e-5 for p in pts), "vertices on the circle")
            self.assertLessEqual(max_sagitta(pts, 10.0), tol * (1 + 1e-6), f"tol {tol}")
            self.assertGreater(max_sagitta(pts, 10.0), tol * 0.5, "not far finer than asked")

    def test_finer_tolerance_gives_more_points(self):
        coarse, _ = self.circle_ring(0.1)
        fine, _ = self.circle_ring(0.005)
        self.assertGreater(len(fine), 2 * len(coarse))

    def test_bad_tolerance_is_refused(self):
        with self.assertRaises(PcbImportError):
            load("circle.dxf", chord_tol=0)
        with self.assertRaises(PcbImportError):
            load("circle.dxf", chord_tol=50)

    def test_bulge_arcs_are_quarter_circles(self):
        res = load("arc_rounded.dxf", chord_tol=0.005)
        (prim,) = part(res["design"], "top_copper")["primitives"]
        exact = 20 * 12 - (4 - math.pi) * 9
        self.assertLess(area(prim["points"]), exact)
        self.assertGreater(area(prim["points"]), exact - 0.06)
        x0, y0, x1, y1 = extent([prim])
        self.assertEqual((round(x1 - x0, 6), round(y1 - y0, 6)), (20.0, 12.0))

    def test_arc_and_lines_form_a_d_shape(self):
        res = load("arc_rounded.dxf", layer_map="LOOP=top_copper,TOP=ignore", chord_tol=0.005)
        (prim,) = part(res["design"], "top_copper")["primitives"]
        self.assertAlmostEqual(area(prim["points"]), 100 + math.pi * 25 / 2, delta=0.06)
        self.assertTrue(notes(res, "info", "assembled from"))

    def test_gerber_arc_region_and_stroke(self):
        res = load("arcs.gbr", chord_tol=0.005)
        region, stroke = part(res["design"], "top_copper")["primitives"]
        self.assertAlmostEqual(area(region["points"]), 240 - (1 - math.pi / 4) * 9, delta=0.02)
        # a quarter of the band between radius 4.5 and 5.5, with a half disc of radius 0.5 on each end
        self.assertAlmostEqual(area(stroke["points"]), math.pi / 4 * (5.5 ** 2 - 4.5 ** 2) + math.pi * 0.25, delta=0.03)


class GerberParsing(unittest.TestCase):
    def parse(self, body, name="t.gbr"):
        return parse_gerber("%FSLAX24Y24*%\n%MOMM*%\n" + body + "M02*\n", name, chord_tol=0.01)

    def test_regions_flashes_and_draws(self):
        lay = parse_gerber((FIX / "patch_top.gtl").read_text(), "patch_top.gtl", chord_tol=0.01)
        self.assertEqual(lay.hint, "top_copper")
        self.assertEqual(lay.counts, {"region": 1, "draw": 1, "flash": 3})
        by = {p.label: p for p in lay.polys}
        self.assertAlmostEqual(area(by["region"].outer), 552.0)
        # a 2 mm round stroke 18 mm long: a rectangle and two half discs
        stroke = by["stroke"]
        self.assertAlmostEqual(area(stroke.outer), 18 * 2 + math.pi, delta=0.05)
        rect = by["flash D11"]
        self.assertAlmostEqual(area(rect.outer), 4.5)
        ring = by["flash D12"]
        self.assertEqual(len(ring.holes), 1)
        self.assertAlmostEqual(area(ring.outer) - area(ring.holes[0]), math.pi * (0.64 - 0.16), delta=0.03)
        self.assertAlmostEqual(area(by["flash D13"].outer), 2 * 2 + math.pi, delta=0.06)

    def test_leading_and_trailing_zero_omission(self):
        lead = self.parse("%ADD10R,1X1*%\nD10*\nX15000Y-5000D03*\n")     # FSLAX24: 2 integer, 4 decimal digits
        self.assertEqual(lead.extent[0], (1.5, -0.5))
        trail = parse_gerber("%FSTAX24Y24*%\n%MOMM*%\n%ADD10R,1X1*%\nD10*\nX15Y-05D03*\nM02*\n", "t.gbr", chord_tol=0.01)
        self.assertEqual(trail.extent[0], (15.0, -5.0))

    def test_inch_units_convert_to_mm(self):
        lay = parse_gerber("%FSLAX24Y24*%\n%MOIN*%\n%ADD10C,0.1*%\nD10*\nX10000Y20000D03*\nM02*\n", "t.gbr", chord_tol=0.01)
        self.assertEqual(lay.units, "inch")
        self.assertAlmostEqual(lay.extent[0][0], 25.4)
        self.assertAlmostEqual(lay.extent[0][1], 50.8)
        p = lay.polys[0]
        self.assertAlmostEqual(max(q[0] for q in p.outer) - min(q[0] for q in p.outer), 2.54, delta=0.03)

    def test_single_quadrant_arc_picks_the_centre_by_the_sign_combination(self):
        # G74: I and J are unsigned; a clockwise quarter from (5, 0) to (0, -5) round the origin has I = -5, J = 0
        lay = self.parse("%ADD10C,0.2*%\nG74*\nD10*\nX50000Y0D02*\nG02*\nX0Y-50000I50000J0D01*\n")
        pts = lay.extent
        self.assertTrue(all(abs(math.hypot(x, y) - 5) < 1e-6 for x, y in pts))
        self.assertTrue(all(x >= -1e-9 and y <= 1e-9 for x, y in pts))

    def test_full_circle_in_multi_quadrant_mode_is_an_annulus(self):
        lay = self.parse("%ADD10C,1*%\nG75*\nD10*\nX50000Y0D02*\nG03*\nX50000Y0I-50000J0D01*\n")
        (poly,) = lay.polys
        self.assertEqual(len(poly.holes), 1)
        self.assertAlmostEqual(area(poly.outer) - area(poly.holes[0]), math.pi * (5.5 ** 2 - 4.5 ** 2), delta=0.2)

    def test_rectangle_aperture_draw_is_a_rectangle(self):
        lay = self.parse("%ADD10R,1X2*%\nD10*\nX0Y0D02*\nX100000Y0D01*\n")
        (poly,) = lay.polys
        self.assertAlmostEqual(area(poly.outer), 11 * 2)

    def test_skips_are_reported_not_dropped(self):
        lay = parse_gerber((FIX / "arcs.gbr").read_text(), "arcs.gbr", chord_tol=0.01)
        keys = {what for what, _reason in lay.skips}
        self.assertEqual(keys, {"flash of aperture macro THERM", "clear polarity object"})

    def test_incremental_coordinates_are_refused(self):
        with self.assertRaisesRegex(PcbImportError, "incremental"):
            parse_gerber("%FSLIX24Y24*%\n%MOMM*%\nM02*\n", "t.gbr", chord_tol=0.01)

    def test_coordinates_before_the_format_are_refused(self):
        with self.assertRaisesRegex(PcbImportError, "unit statement"):
            parse_gerber("X1Y1D03*\nM02*\n", "t.gbr", chord_tol=0.01)


class Excellon(unittest.TestCase):
    def test_metric_decimal_holes(self):
        lay = parse_excellon((FIX / "vias.drl").read_text(), "vias.drl")
        self.assertEqual([(h["x"], h["y"], h["d"], h["plated"]) for h in lay.holes],
                         [(-5.0, -5.0, 0.8, True), (5.0, -5.0, 0.8, True), (20.0, 20.0, 1.2, True)])

    def test_nonplated_flag_from_the_comment_and_file_name(self):
        self.assertFalse(parse_excellon((FIX / "mount-NPTH.drl").read_text(), "mount-NPTH.drl").holes[0]["plated"])
        self.assertFalse(parse_excellon("M48\nMETRIC\nT1C1.0\n%\nT1\nX1.0Y1.0\nM30\n", "board-NPTH.drl").holes[0]["plated"])

    def test_integer_coordinates_with_zero_suppression(self):
        inch_lz = parse_excellon("M48\nINCH,LZ\nT1C0.02\n%\nT1\nX12500Y-5000\nM30\n", "a.drl")
        self.assertAlmostEqual(inch_lz.holes[0]["x"], 1.25 * 25.4)
        self.assertAlmostEqual(inch_lz.holes[0]["y"], -0.5 * 25.4)
        self.assertAlmostEqual(inch_lz.holes[0]["d"], 0.02 * 25.4)
        metric_tz = parse_excellon("M48\nMETRIC,TZ\nT1C0.5\n%\nT1\nX125Y005\nM30\n", "a.drl")   # 3.3 format, trailing zeros omitted
        self.assertAlmostEqual(metric_tz.holes[0]["x"], 125.0)
        self.assertAlmostEqual(metric_tz.holes[0]["y"], 5.0)

    def test_routed_slots_are_reported(self):
        lay = parse_excellon("M48\nMETRIC\nT1C1.0\n%\nT1\nG00X0Y0\nM15\nG01X5Y0\nM16\nM30\n", "a.drl")
        self.assertTrue(lay.skips)


class LayerMap(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_layer_map("TOP=top_copper, BOT=bottom_copper,Edge.Cuts=edge,SILK=skip"),
                         {"TOP": "top_copper", "BOT": "bottom_copper", "Edge.Cuts": "outline", "SILK": "ignore"})
        self.assertEqual(parse_layer_map(None), {})
        with self.assertRaisesRegex(PcbImportError, "the role must be"):
            parse_layer_map("TOP=copper_ish")
        with self.assertRaisesRegex(PcbImportError, "NAME=role"):
            parse_layer_map("TOP")

    def test_name_guesses(self):
        cases = {"F.Cu": "top_copper", "F_Cu": "top_copper", "B.Cu": "bottom_copper", "Top Layer": "top_copper",
                 "BOTTOM": "bottom_copper", "board.GTL": "top_copper", "Edge.Cuts": "outline", "Board Outline": "outline",
                 "F.SilkS": "ignore", "F.Mask": "ignore", "Top Overlay": "ignore", "0": None, "LOOP": None}
        for name, role in cases.items():
            self.assertEqual(guess_role(name), role, name)

    def test_map_overrides_the_guess_and_the_top_copper_moves(self):
        res = load("patch_rect.dxf", layer_map="F.Cu=bottom_copper,B.Cu=top_copper")
        # swapped: the 60 x 50 ground is now the top sheet at z = h, the 30 x 20 patch at z = 0
        top = part(res["design"], "top_copper")["primitives"][0]
        self.assertEqual(top["elevation"], "h")
        self.assertAlmostEqual(area(top["points"]), 60 * 50)
        bottom = part(res["design"], "bottom_copper")["primitives"][0]
        self.assertEqual(bottom["elevation"], 0)
        self.assertAlmostEqual(area(bottom["points"]), 30 * 20)

    def test_pattern_and_file_name_match(self):
        res = load("patch_top.gtl", "patch_bottom.gbl", "patch_edge.gko", layer_map="*_top=ignore,patch_edge.gko=ignore")
        roles = {l["layer"]: l["role"] for l in res["report"]["layers"]}
        self.assertEqual(roles["patch_top"], "ignore")
        self.assertEqual(roles["patch_edge"], "ignore")
        self.assertEqual(roles["patch_bottom"], "bottom_copper")

    def test_unmatched_map_entry_is_a_warning(self):
        res = load("patch_rect.dxf", layer_map="NOPE=top_copper")
        self.assertTrue(notes(res, "warning", "matches no layer"))

    def test_unrecognised_layers_are_not_guessed_when_copper_exists(self):
        res = load("arc_rounded.dxf")   # TOP is copper; LOOP is unknown
        self.assertEqual({l["layer"] for l in res["report"]["layers"]}, {"TOP"})
        self.assertTrue(notes(res, "warning", "role is not clear"))

    def test_a_lone_unrecognised_layer_is_taken_as_top_copper_with_a_warning(self):
        res = load("circle.dxf")
        self.assertEqual([(l["layer"], l["role"]) for l in res["report"]["layers"]], [("0", "top_copper")])
        self.assertTrue(notes(res, "warning", "taken as top copper"))

    def test_x2_file_function_gives_the_role(self):
        res = load("patch_top.gtl", "patch_bottom.gbl", "patch_edge.gko")
        self.assertEqual({l["source"]: (l["role"], l["because"]) for l in res["report"]["layers"]},
                         {"patch_top.gtl": ("top_copper", "Gerber file function"),
                          "patch_bottom.gbl": ("bottom_copper", "Gerber file function"),
                          "patch_edge.gko": ("outline", "Gerber file function")})


class Assembly(unittest.TestCase):
    def test_patch_on_a_board_outline(self):
        res = load("patch_rect.dxf")
        d = res["design"]
        self.assertEqual([p["name"] for p in d["parts"]], ["substrate", "top_copper", "bottom_copper"])
        self.assertEqual(d["parts"][0]["primitives"], [{"kind": "box", "start": [-30.0, -25.0, 0], "stop": [30.0, 25.0, "h"]}])
        top, bottom = part(d, "top_copper"), part(d, "bottom_copper")
        self.assertEqual((top["material"], bottom["material"]), ("copper", "copper"))
        self.assertEqual(extent(top["primitives"]), (-15.0, -10.0, 15.0, 10.0))     # centred: the board was at (100, 80)
        self.assertEqual(top["primitives"][0]["elevation"], "h")
        self.assertEqual(bottom["primitives"][0]["elevation"], 0)
        self.assertEqual([p["key"] for p in d["params"]], ["f0", "h"])
        self.assertEqual(d["params"][1]["default"], 1.6)
        self.assertEqual(d["ports"], [])
        self.assertEqual(res["report"]["offset"], [-100.0, -80.0])
        self.assertEqual(res["report"]["counts"], {"material": 2, "part": 3, "polygon": 2, "hole": 0, "via": 0, "port": 0})

    def test_origin_keep(self):
        d = load("patch_rect.dxf", origin="keep")["design"]
        self.assertEqual(extent(part(d, "top_copper")["primitives"]), (85.0, 70.0, 115.0, 90.0))
        self.assertEqual(d["parts"][0]["primitives"][0]["start"], [70.0, 55.0, 0])

    def test_no_outline_layer_uses_the_margin(self):
        d = load("patch_notch.dxf", margin=3.0)["design"]
        self.assertEqual((d["parts"][0]["primitives"][0]["start"], d["parts"][0]["primitives"][0]["stop"]),
                         ([-18.0, -13.0, 0], [18.0, 13.0, "h"]))
        res = load("patch_notch.dxf")
        self.assertTrue(notes(res, "info", "no board outline"))

    def test_notch_keeps_its_shape(self):
        d = load("patch_notch.dxf")["design"]
        (prim,) = part(d, "top_copper")["primitives"]
        self.assertEqual(len(prim["points"]), 8)
        self.assertAlmostEqual(area(prim["points"]), 552.0)
        self.assertIn([-3.0, -2.0], prim["points"])

    def test_substrate_options(self):
        d = load("patch_rect.dxf", substrate="RO4003C", thickness=0.813)["design"]
        mat = next(m for m in d["materials"] if m["kind"] == "dielectric")
        self.assertEqual((mat["name"], mat["eps_r"], mat["tan_d"], mat["tan_d_freq"]), ("RO4003C", 3.38, 0.0027, "f0"))
        self.assertEqual(d["params"][1]["default"], 0.813)
        d = load("patch_rect.dxf", eps_r=2.55, tan_d=0.001)["design"]
        mat = next(m for m in d["materials"] if m["kind"] == "dielectric")
        self.assertEqual((mat["eps_r"], mat["tan_d"]), (2.55, 0.001))
        res = load("patch_rect.dxf", substrate="Mystery", eps_r=3.0)
        self.assertFalse(notes(res, "warning", "not in the material library"))
        self.assertTrue(notes(load("patch_rect.dxf", substrate="Mystery"), "warning", "not in the material library"))

    def test_hole_is_a_live_boolean_subtraction(self):
        res = load("hole.dxf", chord_tol=0.005)
        d = res["design"]
        top = part(d, "top_copper")
        hist = top["booleanHistory"]
        self.assertEqual((hist["operation"], hist["live"]), ("subtract", True))
        self.assertEqual(len(hist["A"]["primitives"]), 1)
        self.assertEqual(len(hist["B"]["primitives"]), 1)
        # the stored result is the exact difference: the patch less the hole (several simple polygons)
        self.assertAlmostEqual(prim_area(top["primitives"]), 600 - area(hist["B"]["primitives"][0]["points"]), places=5)
        self.assertGreater(len(top["primitives"]), 1)
        # the island in the hole is its own part
        island = part(d, "top_copper_islands")
        self.assertAlmostEqual(prim_area(island["primitives"]), math.pi * 4, delta=0.06)
        self.assertNotIn("booleanHistory", island)
        self.assertEqual(res["report"]["counts"]["hole"], 1)
        # the design's own build recomputes the Boolean at build values, and gives the same sheets
        from fairbeam.design import resolve_names, resolve_parts
        parts = resolve_parts(d, resolve_names(d, {}))
        got = next(p for p in parts if p["name"] == "top_copper")["prims"]
        self.assertAlmostEqual(prim_area(got), prim_area(top["primitives"]), places=5)
        self.assertTrue(all(p["elevation"] == 1.6 for p in got))

    def test_gerber_flash_with_a_hole(self):
        d = load("patch_top.gtl")["design"]
        top = part(d, "top_copper")
        self.assertEqual(top["booleanHistory"]["operation"], "subtract")
        self.assertEqual(len(top["booleanHistory"]["B"]["primitives"]), 1)
        self.assertEqual(len(top["booleanHistory"]["A"]["primitives"]), 5)

    def test_vias_are_metal_pins_and_unplated_holes_are_reported(self):
        res = load("patch_top.gtl", "patch_bottom.gbl", "patch_edge.gko", "vias.drl", "mount-NPTH.drl")
        vias = part(res["design"], "vias")
        self.assertEqual(vias["material"], "copper")
        self.assertEqual(vias["primitives"][0], {"kind": "cylinder", "axis": "z", "center": [-5.0, -5.0], "radius": 0.4, "range": [0, "h"]})
        self.assertEqual(len(vias["primitives"]), 3)
        self.assertEqual(vias["primitives"][2]["radius"], 0.6)
        self.assertEqual(res["report"]["counts"]["via"], 3)
        self.assertTrue(notes(res, "refused", "unplated"))

    def test_gerber_set_extent_and_outline(self):
        res = load("patch_top.gtl", "patch_bottom.gbl", "patch_edge.gko")
        d = res["design"]
        self.assertEqual(d["parts"][0]["primitives"][0]["start"], [-30.0, -25.0, 0])   # the outline's centre line, not its 0.1 mm stroke
        self.assertEqual(d["parts"][0]["primitives"][0]["stop"], [30.0, 25.0, "h"])
        bottom = part(d, "bottom_copper")
        self.assertAlmostEqual(prim_area(bottom["primitives"]), 60 * 50, delta=0.2)

    def test_polygons_have_no_repeated_or_closing_points(self):
        d = load("patch_rect.dxf")["design"]
        for name in ("top_copper", "bottom_copper"):
            pts = part(d, name)["primitives"][0]["points"]
            self.assertEqual(len(pts), 4)
            self.assertEqual(len({tuple(p) for p in pts}), 4)

    def test_repeated_outlines_are_merged(self):
        text = dxf_text([lwpoly("TOP", [(0, 0), (10, 0), (10, 5), (0, 5)])] * 3)
        res = import_pcb([("a.dxf", text)])
        self.assertEqual(len(part(res["design"], "top_copper")["primitives"]), 1)
        self.assertTrue(notes(res, "info", "repeated outline"))

    def test_self_crossing_outline_is_skipped_with_a_reason(self):
        text = dxf_text([lwpoly("TOP", [(0, 0), (10, 10), (10, 0), (0, 10)]), lwpoly("TOP", [(20, 0), (30, 0), (30, 5), (20, 5)])])
        res = import_pcb([("a.dxf", text)])
        self.assertEqual(len(part(res["design"], "top_copper")["primitives"]), 1)
        self.assertTrue(notes(res, "refused", "crosses itself"))


class Report(unittest.TestCase):
    def test_skipped_entities_have_reasons_and_lines(self):
        res = load("skipped.dxf")
        refused = notes(res, "refused")
        by = {n["message"].split(":")[0]: n for n in refused}
        self.assertEqual(set(by), {"1 x TEXT", "1 x SPLINE", "1 x HATCH", "1 x open polyline (3 points)", "1 x INSERT"})
        self.assertIn("not geometry", by["1 x TEXT"]["message"])
        self.assertIn("splines are not read", by["1 x SPLINE"]["message"])
        self.assertIn("ends do not meet", by["1 x open polyline (3 points)"]["message"])
        self.assertTrue(all(n["line"] > 0 and n["where"] == "skipped.dxf · layer TOP" for n in refused))
        self.assertEqual(res["report"]["refused"], 5)
        # the text on the ignored silk layer is not reported: the layer is not used
        self.assertFalse(any("SILK" in n["where"] and n["severity"] == "refused" for n in res["report"]["notes"]))
        self.assertTrue(notes(res, "info", "layer ignored"))
        # the good patch is still there
        self.assertAlmostEqual(prim_area(part(res["design"], "top_copper")["primitives"]), 600.0)

    def test_notes_are_sorted_refused_first(self):
        sev = [n["severity"] for n in load("skipped.dxf")["report"]["notes"]]
        order = {"refused": 0, "warning": 1, "info": 2}
        self.assertEqual(sev, sorted(sev, key=order.get))

    def test_no_port_note_and_no_ports(self):
        res = load("patch_rect.dxf")
        self.assertEqual(res["design"]["ports"], [])
        (note,) = notes(res, "warning", "add a port at the feed")
        self.assertEqual(note["where"], "ports")
        self.assertEqual(res["report"]["counts"]["port"], 0)

    def test_created_list(self):
        created = {(c["kind"], c["name"]) for c in load("patch_rect.dxf")["report"]["created"]}
        self.assertEqual(created, {("material", "copper"), ("material", "FR4"), ("part", "substrate"), ("part", "top_copper"),
                                   ("part", "bottom_copper")})

    def test_missing_ground_is_a_warning(self):
        self.assertTrue(notes(load("patch_notch.dxf"), "warning", "no ground plane"))
        self.assertFalse(notes(load("patch_rect.dxf"), "warning", "no ground plane"))

    def test_gerber_skips(self):
        res = load("arcs.gbr")
        msgs = [n["message"] for n in notes(res, "refused")]
        self.assertTrue(any("aperture macros" in m for m in msgs))
        self.assertTrue(any("clear polarity" in m for m in msgs))
        self.assertTrue(all(n["line"] > 0 for n in notes(res, "refused")))


class Errors(unittest.TestCase):
    def test_no_files_and_unknown_files(self):
        with self.assertRaisesRegex(PcbImportError, "no files"):
            import_pcb([])
        with self.assertRaisesRegex(PcbImportError, "not recognised"):
            import_pcb([("notes.txt", "hello")])

    def test_nothing_on_a_copper_layer(self):
        with self.assertRaisesRegex(PcbImportError, "no copper outlines"):
            import_pcb([("a.dxf", dxf_text([lwpoly("F.SilkS", [(0, 0), (1, 0), (1, 1)])]))])
        with self.assertRaisesRegex(PcbImportError, "no copper outlines"):
            load("patch_rect.dxf", layer_map="F.Cu=ignore,B.Cu=ignore")

    def test_binary_dxf(self):
        with self.assertRaisesRegex(PcbImportError, "binary DXF"):
            import_pcb([("a.dxf", b"AutoCAD Binary DXF\r\n\x1a\x00\x00")])

    def test_bad_arguments(self):
        for kw in ({"units": "furlong"}, {"origin": "left"}, {"thickness": 0}, {"margin": -1}, {"f0": 0}, {"eps_r": 0.5},
                   {"tan_d": -1}):
            with self.assertRaises(PcbImportError, msg=str(kw)):
                load("patch_rect.dxf", **kw)


class DesignChecks(unittest.TestCase):
    """Every fixture combination imports to a design whose only error is the missing port."""

    CASES = [("patch_rect.dxf",), ("patch_notch.dxf",), ("circle.dxf",), ("hole.dxf",), ("patch_inch.dxf",),
             ("skipped.dxf",), ("patch_top.gtl", "patch_bottom.gbl", "patch_edge.gko", "vias.drl"), ("arcs.gbr", "patch_bottom.gbl")]

    def test_only_the_port_check_fails(self):
        for names in self.CASES:
            with self.subTest(names=names):
                d = load(*names)["design"]
                check_design(d)
                checks = lint(d)
                self.assertEqual([c["code"] for c in checks if c["severity"] == "error"], ["no-port"], checks)
                self.assertEqual([c for c in checks if c["severity"] == "warning"], [], checks)

    def test_design_round_trips_through_json(self):
        d = load("hole.dxf")["design"]
        self.assertEqual(json.loads(json.dumps(d)), d)
        check_design(json.loads(json.dumps(d)))

    def test_params_evaluate(self):
        d = load("patch_rect.dxf")["design"]
        self.assertEqual(evaluate(d["simulation"]["f_max"], {"f0": 2.45}), 2.45 * 1.3)


class EndToEnd(unittest.TestCase):
    """Import, then build the geometry preview (no simulation)."""

    def test_dxf_patch_with_a_substrate_builds(self):
        d = load("patch_rect.dxf", thickness=1.524)["design"]
        b = build_preview(None, {}, design=d)["bundle"]
        self.assertTrue(b["preview"])
        names = [p["name"] for p in b["parts"]]
        self.assertEqual(names, ["substrate", "top_copper", "bottom_copper"])
        top = next(p for p in b["parts"] if p["name"] == "top_copper")
        zs = {round(z, 9) for prim in top["primitives"] for z in ([prim["elevation"]] if "elevation" in prim else [])}
        self.assertEqual(zs, {1.524})

    def test_substrate_thickness_parameter_moves_the_top_copper(self):
        d = load("patch_rect.dxf")["design"]
        b = build_preview(None, {"h": "2.4"}, design=d)["bundle"]
        top = next(p for p in b["parts"] if p["name"] == "top_copper")
        self.assertEqual({prim["elevation"] for prim in top["primitives"]}, {2.4})

    def test_gerber_set_with_a_hole_and_vias_builds(self):
        d = load("patch_top.gtl", "patch_bottom.gbl", "patch_edge.gko", "vias.drl")["design"]
        b = build_preview(None, {}, design=d)["bundle"]
        self.assertEqual([p["name"] for p in b["parts"]], ["substrate", "top_copper", "bottom_copper", "vias"])

    def test_hole_geometry_builds(self):
        b = build_preview(None, {}, design=load("hole.dxf")["design"])["bundle"]
        self.assertEqual([p["name"] for p in b["parts"]], ["substrate", "top_copper", "top_copper_islands"])


class PcbApi(unittest.TestCase):
    """POST /api/import/pcb (a report before creating) and POST /api/designs with pcb."""

    @classmethod
    def setUpClass(cls):
        import threading

        from fairbeam.jobs import JobManager
        from fairbeam.server import App, make_server

        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.models = root / "models"
        cls.models.mkdir()
        (root / "projects").mkdir()
        manager = JobManager(root / "jobs", root / "projects", command_factory=lambda job: [sys.executable, "-c", "pass"])
        cls.app = App(models_dir=cls.models, projects_dir=root / "projects", jobs_dir=root / "jobs",
                      templates_dir=HERE.parents[1] / "python" / "templates", manager=manager)
        cls.srv = make_server(cls.app, "127.0.0.1", 0, quiet=True)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.app.close()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None):
        import http.client

        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=120)
        conn.request(method, path, body=json.dumps(body).encode(),
                     headers={"Host": f"127.0.0.1:{self.port}", "Content-Type": "application/json"})
        r = conn.getresponse()
        payload = json.loads(r.read() or b"null")
        conn.close()
        return r.status, payload

    @staticmethod
    def files(*names):
        import base64

        return [{"name": n, "content_base64": base64.b64encode((FIX / n).read_bytes()).decode()} for n in names]

    @staticmethod
    def blob(name, data):
        import base64

        return {"name": name, "content_base64": base64.b64encode(data).decode()}

    def error(self, body, status=422, path="/api/import/pcb"):
        st, err = self.request("POST", path, body)
        self.assertEqual(st, status, err)
        self.assertIn("error", err)
        return err

    def test_preview_of_a_dxf_lists_the_layers_with_the_reason(self):
        before = sorted(self.models.iterdir())
        st, res = self.request("POST", "/api/import/pcb", {"files": self.files("patch_rect.dxf")})
        self.assertEqual(st, 200, res)
        self.assertEqual({"design", "report", "layers", "checks"}, set(res))
        roles = {l["layer"]: (l["role"], l["because"]) for l in res["layers"]}
        self.assertEqual(roles, {"F.Cu": ("top_copper", "layer name"), "B.Cu": ("bottom_copper", "layer name"),
                                 "Edge.Cuts": ("outline", "layer name")})
        self.assertEqual({l["source"] for l in res["layers"]}, {"patch_rect.dxf"})
        self.assertEqual(res["report"]["counts"]["port"], 0)
        # only the missing port is wrong with the design
        self.assertEqual([c["code"] for c in res["checks"] if c["severity"] == "error"], ["no-port"])
        self.assertIn("patch_rect.dxf", res["design"]["model"]["description"])
        self.assertEqual(sorted(self.models.iterdir()), before, "the preview saves nothing")

    def test_options_reach_the_importer(self):
        opts = {"layer_map": {"F.Cu": "bottom_copper", "B.Cu": "top_copper", "Edge.Cuts": "ignore"},
                "substrate": "RO4003C", "thickness": 0.813, "eps_r": 3.55, "tan_d": 0.0027, "f0": 5.8, "units": "mm",
                "chord_tol": 0.05, "margin": 3, "origin": "keep"}
        st, res = self.request("POST", "/api/import/pcb", {"files": self.files("patch_rect.dxf"), "options": opts, "name": "Swapped"})
        self.assertEqual(st, 200, res)
        roles = {l["layer"]: (l["role"], l["because"]) for l in res["layers"]}
        self.assertEqual(roles["F.Cu"], ("bottom_copper", "layer map F.Cu"))
        self.assertEqual(roles["Edge.Cuts"], ("ignore", "layer map Edge.Cuts"))
        d = res["design"]
        self.assertEqual(d["model"]["name"], "Swapped")
        params = {p["key"]: p["default"] for p in d["params"]}
        self.assertEqual((params["f0"], params["h"]), (5.8, 0.813))
        sub = next(m for m in d["materials"] if m["kind"] == "dielectric")
        self.assertEqual((sub["eps_r"], sub["tan_d"]), (3.55, 0.0027))
        self.assertEqual(res["report"]["offset"], [0.0, 0.0])
        self.assertEqual(res["report"]["chord_tol"], 0.05)

    def test_unclear_layers_are_listed_also_when_nothing_is_copper_yet(self):
        text = dxf_text([lwpoly("LOOP", [(0, 0), (10, 0), (10, 6), (0, 6)]), lwpoly("0", [(20, 0), (30, 0), (30, 6), (20, 6)])])
        files = [self.blob("two.dxf", text.encode())]
        st, err = self.request("POST", "/api/import/pcb", {"files": files})
        self.assertEqual(st, 422, err)
        self.assertIn("no copper outlines", err["error"])
        self.assertEqual({l["layer"]: (l["role"], l["outlines"]) for l in err["layers"]}, {"LOOP": (None, 1), "0": (None, 1)})
        st, res = self.request("POST", "/api/import/pcb", {"files": files, "options": {"layer_map": {"LOOP": "top_copper"}}})
        self.assertEqual(st, 200, res)
        self.assertEqual({l["layer"]: l["role"] for l in res["layers"]}, {"LOOP": "top_copper", "0": None})
        self.assertTrue(any("layer not used" in n["message"] for n in res["report"]["notes"]))

    def test_a_layer_key_with_pattern_characters_matches_only_that_layer(self):
        # the dialog keys the layer map by layer name with [ * ? escaped as one-character classes
        text = dxf_text([lwpoly("Cu[1]", [(0, 0), (10, 0), (10, 6), (0, 6)]), lwpoly("Cu1", [(20, 0), (30, 0), (30, 6), (20, 6)])])
        st, res = self.request("POST", "/api/import/pcb", {"files": [self.blob("m.dxf", text.encode())],
                                                           "options": {"layer_map": {"Cu[[]1]": "top_copper", "Cu1": "bottom_copper"}}})
        self.assertEqual(st, 200, res)
        self.assertEqual({l["layer"]: l["role"] for l in res["layers"]}, {"Cu[1]": "top_copper", "Cu1": "bottom_copper"})

    def test_a_gerber_set_with_a_drill_file(self):
        st, res = self.request("POST", "/api/import/pcb", {"files": self.files("patch_top.gtl", "patch_bottom.gbl", "patch_edge.gko", "vias.drl")})
        self.assertEqual(st, 200, res)
        self.assertEqual([(l["source"], l["kind"], l["role"], l["because"]) for l in res["layers"]],
                         [("patch_top.gtl", "gerber", "top_copper", "Gerber file function"),
                          ("patch_bottom.gbl", "gerber", "bottom_copper", "Gerber file function"),
                          ("patch_edge.gko", "gerber", "outline", "Gerber file function"),
                          ("vias.drl", "drill", "drill", "Excellon file")])
        self.assertGreater(res["report"]["counts"]["via"], 0)

    def test_refused_entries_come_first_in_the_report(self):
        st, res = self.request("POST", "/api/import/pcb", {"files": self.files("skipped.dxf")})
        self.assertEqual(st, 200, res)
        severities = [n["severity"] for n in res["report"]["notes"]]
        self.assertEqual(severities, sorted(severities, key={"refused": 0, "warning": 1, "info": 2}.get))
        self.assertGreaterEqual(res["report"]["refused"], 4)

    def test_create_the_design_from_the_files(self):
        body = {"id": "pcb_patch", "name": "PCB patch",
                "pcb": {"files": self.files("patch_rect.dxf"), "options": {"thickness": 1.524, "f0": 2.4}}}
        st, made = self.request("POST", "/api/designs", body)
        self.assertEqual(st, 201, made)
        self.assertEqual(made["design"]["model"]["id"], "pcb-patch")
        self.assertEqual(made["design"]["model"]["name"], "PCB patch")
        self.assertEqual(made["import_report"]["counts"]["part"], 3)
        self.assertEqual(made["design"]["ports"], [])
        self.assertTrue((self.models / "pcb_patch.design.json").is_file())
        st, again = self.request("POST", "/api/designs", body)
        self.assertEqual(st, 409, again)
        # a broken import creates nothing
        st, err = self.request("POST", "/api/designs", {"id": "pcb_bad", "pcb": {"files": [self.blob("x.dxf", b"hello")]}})
        self.assertEqual(st, 422, err)
        self.assertFalse((self.models / "pcb_bad.design.json").exists())
        st, err = self.request("POST", "/api/designs", {"id": "pcb_bad", "pcb": "nope"})
        self.assertEqual(st, 422, err)

    def test_files_are_checked(self):
        f = self.files("patch_rect.dxf")
        for files, text in ((None, "no files"), ([], "no files"), ("x", "no files"), ([f[0]] * 2, "listed twice"),
                            ([{"name": "a.dxf"}], "content_base64 must be a string"),
                            ([{"name": "a.dxf", "content_base64": "###"}], "not valid base64"),
                            ([{"name": "a.dxf", "content_base64": ""}], "is empty"),
                            ([{"name": "", "content_base64": "AAAA"}], "invalid file name"),
                            ([{"name": "a.dxf", "content_base64": "AAAA", "path": "/etc/passwd"}], "must be"),
                            ([{"name": "a\nb.dxf", "content_base64": "AAAA"}], "invalid file name"),
                            ([self.blob("notes.txt", b"just some words")], "not recognised"),
                            ([self.blob("empty.dxf", b"0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n")], "no copper"),
                            (["x"] * 13, "at most 12")):
            with self.subTest(text=text):
                err = self.error({"files": files})
                self.assertIn(text, err["error"])
        # a path in the name is dropped: only the file name counts
        st, res = self.request("POST", "/api/import/pcb", {"files": [{**f[0], "name": "C:\\cad\\out/patch_rect.dxf"}]})
        self.assertEqual(st, 200, res)
        self.assertEqual({l["source"] for l in res["layers"]}, {"patch_rect.dxf"})

    def test_size_limits(self):
        from fairbeam.server import MAX_PCB_FILE, MAX_PCB_FILES, MAX_PCB_TOTAL, ApiError

        big = self.blob("big.dxf", b"0\n" * (MAX_PCB_FILE // 2 + 10))
        st, err = self.request("POST", "/api/import/pcb", {"files": [big]})
        self.assertEqual(st, 413, err)
        self.assertIn("larger than", err["error"])
        one = self.blob("a.dxf", b"0" * 5_500_000)
        with self.assertRaisesRegex(ApiError, "together are larger") as cm:
            self.app.import_pcb({"files": [one, {**one, "name": "b.dxf"}, {**one, "name": "c.dxf"}]})
        self.assertEqual(cm.exception.status, 413)
        self.assertEqual((MAX_PCB_FILES, MAX_PCB_FILE, MAX_PCB_TOTAL), (12, 8_000_000, 16_000_000))
        # the body limit: 1 MiB for the other routes (the CST macro import too), the base64 of all files for the two PCB
        # routes (a declared length is enough: the server refuses before it reads)
        import http.client

        from fairbeam.server import MAX_BODY, MAX_PCB_BODY

        for path, size in (("/api/import/cst", MAX_BODY + 1), ("/api/import/pcb", MAX_PCB_BODY + 1),
                           ("/api/designs", MAX_PCB_BODY + 1)):
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
            conn.request("POST", path, headers={"Host": f"127.0.0.1:{self.port}", "Content-Type": "application/json",
                                                "Content-Length": str(size)})
            self.assertEqual(conn.getresponse().status, 413, path)
            conn.close()

    def test_options_are_checked(self):
        f = self.files("patch_rect.dxf")
        cases = {
            "thickness": [0, -1, 101, "1.6", True, None, float("nan"), float("inf")],
            "eps_r": [0.5, 201, "4", False, float("nan")],
            "tan_d": [-0.1, 1.5, "0.02", True],
            "f0": [0, -2, 1001, "2.45", float("inf")],
            "chord_tol": [0, 6, "0.02"],
            "margin": [-1, 1001, "2"],
            "units": ["cm", 1, "in", ""],
            "origin": ["middle", 0],
            "substrate": ["", "x" * 41, 5, "a\nb"],
            "layer_map": ["F.Cu=top_copper", {"F.Cu": "copper"}, {"F.Cu": 1}, {"": "outline"}, {"F.Cu": "top"}, []],
        }
        for key, values in cases.items():
            for v in values:
                with self.subTest(option=key, value=v):
                    err = self.error({"files": f, "options": {key: v}})
                    self.assertIn(key if key != "substrate" else "substrate", err["error"])
        self.assertIn("unknown option", self.error({"files": f, "options": {"path": "/tmp"}})["error"])
        self.assertIn("options must be an object", self.error({"files": f, "options": [1]})["error"])
        self.assertIn("unknown field", self.error({"files": f, "cwd": "/"})["error"])
        self.assertIn("invalid name", self.error({"files": f, "name": "a\nb"})["error"])
        # null options fall back to the defaults
        st, res = self.request("POST", "/api/import/pcb", {"files": f, "options": {"eps_r": None, "tan_d": None, "substrate": None, "units": None}})
        self.assertEqual(st, 200, res)

    def test_body_is_json_only(self):
        import http.client

        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        conn.request("POST", "/api/import/pcb", body=b"{}", headers={"Host": f"127.0.0.1:{self.port}", "Content-Type": "text/plain"})
        self.assertEqual(conn.getresponse().status, 415)
        conn.close()


class Cli(unittest.TestCase):
    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.main(list(argv))
        return rc, out.getvalue(), err.getvalue()

    def test_import_pcb_writes_a_design_and_prints_the_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "my.design.json"
            rc, out, err = self.run_cli("import-pcb", str(FIX / "patch_rect.dxf"), "--out", str(dest),
                                        "--layer-map", "F.Cu=top_copper,B.Cu=bottom_copper", "--substrate", "FR4", "--thickness", "1.6",
                                        "--eps-r", "4.3", "--tan-d", "0.02", "--units", "auto", "--chord-tol", "0.02")
            self.assertEqual((rc, err), (0, ""))
            d = json.loads(dest.read_text())
            check_design(d)
            self.assertEqual(d["model"]["id"], "patch-rect")
            self.assertIn("wrote", out)
            self.assertIn("top_copper (layer map F.Cu)", out)
            self.assertIn("add a port at the feed", out)

    def test_several_files_and_default_output_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            import os
            cwd = os.getcwd()
            os.chdir(tmp)
            try:
                rc, out, _err = self.run_cli("import-pcb", str(FIX / "patch_top.gtl"), str(FIX / "patch_bottom.gbl"),
                                             str(FIX / "patch_edge.gko"), str(FIX / "vias.drl"))
            finally:
                os.chdir(cwd)
            self.assertEqual(rc, 0)
            d = json.loads((Path(tmp) / "patch_top.design.json").read_text())
            self.assertIn("vias", [p["name"] for p in d["parts"]])

    def test_errors_exit_nonzero_with_a_message(self):
        rc, _out, err = self.run_cli("import-pcb", str(FIX / "does-not-exist.dxf"))
        self.assertEqual(rc, 2)
        self.assertIn("no such file", err)
        rc, _out, err = self.run_cli("import-pcb", str(FIX / "patch_rect.dxf"), "--layer-map", "F.Cu=nonsense")
        self.assertEqual(rc, 2)
        self.assertIn("the role must be", err)


if __name__ == "__main__":
    unittest.main()
