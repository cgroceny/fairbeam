"""E/H field maps on cut planes (fairbeam.field_planes, monitors.field_planes): design validation,
the build and Python export, the dump setup, reading a synthetic openEMS HDF5 dump, the bundle
entries and the `fairbeam run` hooks, all without running openEMS."""

import argparse
import base64
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import h5py
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam import field_planes  # noqa: E402
from fairbeam.fields import _resample  # noqa: E402
from fairbeam.cli import _field_plane_request  # noqa: E402
from fairbeam.design import DesignError, blank_design, check_design, module_for, to_python  # noqa: E402
from fairbeam.design_checks import lint  # noqa: E402
from fairbeam.geometry import read_structure  # noqa: E402
from fairbeam.jsonutil import finite_json  # noqa: E402
from fairbeam.model import resolve_params  # noqa: E402


def plane(**kw):
    return {"quantity": "E", "normal": "z", "position": "h + 1", "frequencies": ["f0"], **kw}


def design(*planes):
    d = blank_design("t", "T")
    d["monitors"] = {"field_planes": list(planes)}
    return d


def build(d):
    m = module_for(d)
    return m.build(resolve_params(m.PARAMS, {}))


class DesignJson(unittest.TestCase):
    def test_structure_errors(self):
        for bad, where in [("E", "monitors.field_planes"), (["E"], "monitors.field_planes[0]"),
                           ([plane(quantity="D")], "monitors.field_planes[0].quantity"),
                           ([plane(normal="w")], "monitors.field_planes[0].normal"),
                           ([plane(component="r")], "monitors.field_planes[0].component"),
                           ([plane(frequencies="f0")], "monitors.field_planes[0].frequencies")]:
            d = blank_design("t", "T")
            d["monitors"] = {"field_planes": bad}
            with self.subTest(where=where), self.assertRaises(DesignError) as e:
                check_design(d)
            self.assertEqual(e.exception.where, where)
        check_design(design(plane(), plane(quantity="H", component="x", normal="y", position=0)))

    def test_position_outside_the_domain_needs_the_bundle(self):
        keys = lambda checks: [(c["severity"], c["code"], c["path"]) for c in checks if c["code"].startswith("field")]  # noqa: E731
        d = design(plane(position=5), plane(normal="x", position=-80))
        self.assertEqual(keys(lint(d)), [])  # no domain without a preview bundle
        bundle = {"domain": {"min": [-60, -60, -10], "max": [60, 60, 40]}, "mesh": {}}
        self.assertEqual(keys(lint(d, bundle=bundle)),
                         [("error", "field-plane-position", "monitors.field_planes[1].position")])
        self.assertIn("outside the simulation domain", next(c for c in lint(d, bundle=bundle)
                                                               if c["code"] == "field-plane-position")["message"])

    def test_build_sets_the_monitors(self):
        self.assertIsNone(build(blank_design("t", "T")).field_plane_monitors)
        sim = build(design(plane(), plane(quantity="H", component="y", normal="x", position=0, frequencies=[2.0, "f0"])))
        self.assertEqual(sim.field_plane_monitors, [
            {"quantity": "E", "normal": "z", "component": "abs", "position": 1.524 + 1, "frequencies": [2.45e9]},
            {"quantity": "H", "normal": "x", "component": "y", "position": 0.0, "frequencies": [2.0e9, 2.45e9]},
        ])
        # a half-typed position leaves that plane out (design_checks reports it) but the build carries on
        with mock.patch("sys.stderr"):
            self.assertIsNone(build(design(plane(position="h +"))).field_plane_monitors)
        self.assertIsNone(build(design(plane(frequencies=[]))).field_plane_monitors)

    def test_python_export_keeps_them(self):
        d = design(plane(component="z"))
        src = to_python(d)
        self.assertIn("sim.field_plane_monitors = [", src)
        ns: dict = {}
        exec(compile(src, "export.py", "exec"), ns)  # noqa: S102 - our own generated source
        sim = ns["build"](resolve_params(ns["PARAMS"], {}))
        self.assertEqual(sim.field_plane_monitors, [
            {"quantity": "E", "normal": "z", "component": "z", "position": 1.524 + 1, "frequencies": [2.45e9]}])


class DumpSetup(unittest.TestCase):
    def test_dump_types_box_and_snapping(self):
        sim = build(design(plane(position=2.0), plane(quantity="H", normal="x", position=0.3, frequencies=[2.0, 2.5])))
        calls = []
        csx = sim.csx

        def spy(name, **kw):
            calls.append((name, kw))
            return csx.AddDump(name, **kw)

        sim.csx = types.SimpleNamespace(AddDump=spy)  # the CSX object's methods are read-only
        try:
            planes = field_planes.attach(sim, sim.field_plane_monitors)
        finally:
            sim.csx = csx
        self.assertEqual([c[0] for c in calls], ["fairbeam_F_Ez0", "fairbeam_F_Hx1"])
        self.assertEqual(calls[0][1], {"dump_type": 10, "file_type": 1, "frequency": [2.45e9], "dump_mode": 1})
        self.assertEqual(calls[1][1]["dump_type"], 11)
        self.assertEqual(calls[1][1]["frequency"], [2.0e9, 2.5e9])
        z = np.asarray(sim.mesh.GetLines("z"))
        self.assertIn(planes[0]["position"], z.tolist())       # snapped onto a mesh line
        self.assertAlmostEqual(planes[0]["position"], z[np.argmin(np.abs(z - 2.0))])
        self.assertEqual(planes[0]["requested"], 2.0)
        self.assertFalse(planes[0]["outside"])
        # the box spans the whole domain in the plane and is not taken for the NF2FF box
        _, helpers, nf2ff = read_structure(sim.csx, sim.materials)
        box = next(h for h in helpers if h["name"] == "fairbeam_F_Ez0")
        x, y = np.asarray(sim.mesh.GetLines("x")), np.asarray(sim.mesh.GetLines("y"))
        np.testing.assert_allclose(box["bbox"][0][:2], [x[0], y[0]], atol=1e-5)
        np.testing.assert_allclose(box["bbox"][1][:2], [x[-1], y[-1]], atol=1e-5)
        self.assertIsNotNone(nf2ff)
        self.assertLess(nf2ff["max"][0], x[-1])
        self.assertEqual(sim.field_plane_port, 1)

    def test_outside_the_domain_is_flagged(self):
        sim = build(design(plane(position=500)))
        pl = field_planes.attach(sim, sim.field_plane_monitors)[0]
        self.assertTrue(pl["outside"])
        self.assertEqual(pl["position"], float(np.asarray(sim.mesh.GetLines("z"))[-1]))


def write_dump(path, lines_m, fields_by_f):
    """A frequency-domain dump as openEMS writes it (non-legacy layout, (3, Nx, Ny, Nz))."""
    with h5py.File(path, "w") as h5:
        h5.attrs["openEMS_HDF5_version"] = 0.3
        h5.attrs["dump_type"] = 10
        mesh = h5.create_group("Mesh")
        for n, ln in zip("xyz", lines_m):
            mesh.create_dataset(n, data=np.asarray(ln, float))
        fd = h5.create_group("FieldData/FD")
        fd.attrs["frequency"] = np.asarray(list(fields_by_f), float)
        for k, data in enumerate(fields_by_f.values()):
            for part, fn in (("real", np.real), ("imag", np.imag)):
                ds = fd.create_dataset(f"f{k}_{part}", data=fn(data).astype(np.float32))
                ds.attrs["d_order"] = "NXYZ"


class ReadAndResample(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # a z plane over a non-uniform mesh: x 0..40 mm (finer in the middle), y 0..20 mm
        self.x = np.r_[np.linspace(0, 15, 6), np.linspace(16, 24, 9), np.linspace(25, 40, 6)]
        self.y = np.linspace(0, 20, 11)
        xx, yy = np.meshgrid(self.x, self.y, indexing="ij")
        ex = (xx + 2 * yy) * (1 + 1j)                        # |Ex| = sqrt(2) (x + 2y), linear: bilinear is exact
        ey = 3j * np.ones_like(xx)
        ez = np.zeros_like(xx)
        data = np.stack([ex, ey, ez])[:, :, :, None]          # (3, Nx, Ny, 1)
        write_dump(os.path.join(self.tmp.name, "fairbeam_F_Ez0.h5"),
                   [self.x * 1e-3, self.y * 1e-3, [3e-3]], {2.4e9: data, 2.5e9: 2 * data})
        self.expected = lambda u, v, s=1.0: s * np.sqrt(2 * (u + 2 * v) ** 2 + 9)  # noqa: E731

    def fake_sim(self, component="abs", port=None, uf_inc=None):
        pl = {"name": "fairbeam_F_Ez0", "quantity": "E", "component": component, "axis": 2, "position": 3.0,
              "requested": 3.1, "frequencies": [2.5e9, 2.4e9], "outside": False}
        sim = types.SimpleNamespace(sim_path=self.tmp.name, unit=1e-3, field_plane_dumps=[pl], field_plane_port=port,
                                    results={"frequency": [2.0e9, 3.0e9]}, ports=[{"number": 1, "excite": True}],
                                    _port_objs=[types.SimpleNamespace(uf_inc=uf_inc, Z_ref=50.0)])
        return sim

    def test_grid_is_capped_by_the_mesh_and_max_samples(self):
        gu, gv = field_planes.sample_grid(self.x, self.y, 200)
        self.assertEqual(len(gu), 41)                         # the finest cell (1 mm) over 40 mm
        self.assertEqual(len(gv), 21)                         # the same step on the shorter side
        gu, gv = field_planes.sample_grid(np.linspace(0, 100, 900), np.linspace(0, 50, 400), 200)
        self.assertEqual((len(gu), len(gv)), (200, 101))

    def test_magnitude_orientation_and_components(self):
        data = np.zeros((3, 2, 1, 3), complex)                # a y-normal plane: remaining axes (x, z) = (v, u)
        data[2, 1, 0, 2] = 5
        mag = field_planes.plane_magnitude(data, 1)
        self.assertEqual(mag.shape, (3, 2))                   # (u = z, v = x)
        self.assertEqual(mag[2, 1], 5)
        self.assertEqual(field_planes.plane_magnitude(data, 1, "x").max(), 0)
        self.assertEqual(field_planes.plane_magnitude(data, 1, "z")[2, 1], 5)

    def test_collect_reads_resamples_and_rounds(self):
        maps = field_planes.collect(self.fake_sim(), max_samples=200)
        self.assertEqual([m["f"] for m in maps], [2.5e9, 2.4e9])  # in the requested order
        m = maps[1]
        self.assertEqual((m["quantity"], m["normal"], m["axis"], m["u_axis"], m["v_axis"]), ("E", "z", 2, 0, 1))
        self.assertEqual((m["position_mm"], m["requested_mm"]), (3.0, 3.1))
        self.assertEqual((m["u_range"], m["v_range"]), ([0.0, 40.0], [0.0, 20.0]))
        self.assertEqual((m["nu"], m["nv"]), (41, 21))
        self.assertEqual((m["unit"], m["normalization"]), ("arb.", "none"))  # no driven port known
        self.assertNotIn("port", m)
        grid = np.asarray(m["magnitude"])
        self.assertEqual(grid.shape, (m["nv"], m["nu"]))       # rows are v
        gu, gv = np.linspace(0, 40, 41), np.linspace(0, 20, 21)
        # |Ex| is linear, the magnitude is not: compare on mesh nodes (exact) and loosely elsewhere
        self.assertAlmostEqual(grid[0, 0], 3.0, places=5)
        self.assertAlmostEqual(grid[20, 40], self.expected(40, 20), delta=0.01 * self.expected(40, 20))
        ref = _resample(self.x, self.y, self.expected(self.x[:, None], self.y[None, :]), gu, gv)  # bilinear of the node values
        np.testing.assert_allclose(grid, ref, rtol=5e-3)                                           # 3 significant digits
        self.assertAlmostEqual(m["max"], self.expected(40, 20), delta=0.05)
        self.assertAlmostEqual(maps[0]["max"], 2 * self.expected(40, 20), delta=0.1)
        # 3 significant digits
        self.assertTrue(all(float(f"{x:.3g}") == x for x in grid.ravel()))
        json.dumps(finite_json(maps), allow_nan=False)

    def test_one_component(self):
        m = field_planes.collect(self.fake_sim(component="y"))[0]
        np.testing.assert_allclose(np.asarray(m["magnitude"]), 6.0)  # |Ey| = 3, doubled at 2.5 GHz
        self.assertEqual(m["component"], "y")

    def test_normalised_to_one_watt_incident(self):
        uf = np.array([2.0 + 0j, 4.0 + 0j])                   # |u_inc| = 3 V at 2.5 GHz
        m = field_planes.collect(self.fake_sim(port=1, uf_inc=uf))[1]
        p_inc = 0.5 * 2.8 ** 2 / 50                           # 2.4 GHz: |u_inc| = 2.8 V
        self.assertEqual((m["unit"], m["port"]), ("V/m", 1))
        self.assertIn("1 W incident", m["normalization"])
        self.assertAlmostEqual(m["magnitude"][0][0], 3.0 / np.sqrt(p_inc), delta=0.01 * 3.0 / np.sqrt(p_inc))

    @staticmethod
    def decode(phasor, nu, nv):
        """The phasor payload as (comp, nv, nu) complex, in the payload's own units."""
        q = np.frombuffer(base64.b64decode(phasor["data"]), np.int8).reshape(nv, nu, len(phasor["components"]), 2)
        return (q[..., 0] + 1j * q[..., 1]).transpose(2, 0, 1) * phasor["peak"] / 127

    def test_phasor_holds_the_complex_components(self):
        m = field_planes.collect(self.fake_sim(), max_samples=200)[1]              # 2.4 GHz, no driven port
        p = m["phasor"]
        self.assertEqual(p["components"], ["x", "y", "z"])
        self.assertEqual(len(base64.b64decode(p["data"])), m["nu"] * m["nv"] * 3 * 2)
        c = self.decode(p, m["nu"], m["nv"])
        gu, gv = np.linspace(0, 40, 41), np.linspace(0, 20, 21)
        uu, vv = np.meshgrid(gu, gv)
        # Ex = (x + 2 y)(1 + j) and Ey = 3j are linear or constant: bilinear resampling is exact
        tol = p["peak"] / 127                                    # one int8 step; the real and imaginary part round separately
        np.testing.assert_allclose(c[0], (uu + 2 * vv) * (1 + 1j), atol=tol)
        np.testing.assert_allclose(c[1], 3j * np.ones_like(uu), atol=tol)
        np.testing.assert_allclose(c[2], 0, atol=tol)
        self.assertAlmostEqual(p["peak"], 80 * np.sqrt(2), delta=0.01 * p["peak"])
        # the phasor agrees with the stored magnitude where the field is well above the quantisation step
        mag = np.asarray(m["magnitude"])
        np.testing.assert_allclose(np.sqrt((np.abs(c) ** 2).sum(axis=0)), mag, atol=3 * tol)
        json.dumps(finite_json(m), allow_nan=False)

    def test_phasor_of_one_component_and_orientation(self):
        m = field_planes.collect(self.fake_sim(component="y"))[0]
        self.assertEqual(m["phasor"]["components"], ["y"])
        c = self.decode(m["phasor"], m["nu"], m["nv"])
        np.testing.assert_allclose(c[0], 6j, atol=m["phasor"]["peak"] / 127)              # Ey = 3j, doubled at 2.5 GHz
        # a y-normal plane (u = z, v = x): the components follow the (u, v) grid, not the dump's axis order
        data = np.zeros((3, 2, 1, 3), complex)
        data[2, 1, 0, 2] = 5j
        f = field_planes.plane_fields(data, 1)
        self.assertEqual(f.shape, (3, 3, 2))
        self.assertEqual(f[2, 2, 1], 5j)

    def test_phasor_is_referenced_to_the_incident_wave(self):
        uf = np.array([1j * 2.0, 1j * 4.0])                    # the incident wave is a quarter turn ahead
        with_phase = field_planes.collect(self.fake_sim(component="y", port=1, uf_inc=uf))[1]
        self.assertEqual(with_phase["unit"], "V/m")
        c = self.decode(with_phase["phasor"], with_phase["nu"], with_phase["nv"])[0]
        # Ey = 3j / (j) = 3: real and positive after the turn, at the magnitude of the normalised map
        self.assertTrue(np.allclose(c.imag, 0, atol=with_phase["phasor"]["peak"] / 127))
        np.testing.assert_allclose(c.real, with_phase["magnitude"][0][0], rtol=0.01)
        sim = self.fake_sim(port=1, uf_inc=uf)
        scale = field_planes.incident_phasor_scale(sim, 2.4e9)
        self.assertAlmostEqual(abs(scale), field_planes.incident_power_scale(sim, 2.4e9))
        self.assertAlmostEqual(np.angle(scale), -np.pi / 2)
        self.assertIsNone(field_planes.incident_phasor_scale(self.fake_sim(), 2.4e9))

    def test_phasor_can_be_left_out_and_a_zero_field_has_none(self):
        self.assertNotIn("phasor", field_planes.collect(self.fake_sim(), phasor=False)[0])
        self.assertIsNone(field_planes.phasor_payload([np.zeros((3, 4), complex)], ["z"]))

    def test_bundle_size_with_phasors(self):
        rng = np.random.default_rng(2)
        grids = [rng.normal(size=(200, 200)) + 1j * rng.normal(size=(200, 200)) for _ in range(3)]
        pay = field_planes.phasor_payload(grids, list("xyz"))
        self.assertEqual(len(pay["data"]), 4 * ((200 * 200 * 6 + 2) // 3))              # base64 of 6 bytes per pixel
        self.assertLess(len(pay["data"]), 330_000)                                        # the worst case, |E| at 200 x 200
        one = field_planes.phasor_payload(grids[:1], ["z"])
        self.assertLess(len(one["data"]), 110_000)

    def test_missing_file_or_no_planes(self):
        sim = self.fake_sim()
        sim.field_plane_dumps[0]["name"] = "fairbeam_F_Ez9"
        self.assertIsNone(field_planes.collect(sim))
        self.assertIsNone(field_planes.collect(types.SimpleNamespace(field_plane_dumps=None, sim_path="x")))

    def test_bundle_size_of_a_full_map(self):
        grid = np.random.default_rng(1).random((101, 200)) * 123.4
        pl = {"quantity": "E", "component": "abs", "axis": 2, "position": 3.0, "requested": 3.0}
        e = field_planes.entry(pl, 2.45e9, np.linspace(0, 100, 200), np.linspace(0, 50, 101), grid, 1, True)
        size = len(json.dumps(finite_json(e), separators=(",", ":")))
        self.assertLess(size, 150_000)                         # about 0.1 MB per 200 x 101 map


class RunHooks(unittest.TestCase):
    def test_cli_flag_wins_over_the_model(self):
        args = argparse.Namespace(field_plane=[["Ex", "z", "3", "2.4,2.5"], ["H", "y", "-1.5", "2.45"]])
        own = types.SimpleNamespace(field_plane_monitors=[{"quantity": "E"}])
        req = _field_plane_request(args, own)
        self.assertEqual(req, [
            {"quantity": "E", "component": "x", "normal": "z", "position": 3.0, "frequencies": [2.4e9, 2.5e9]},
            {"quantity": "H", "component": "abs", "normal": "y", "position": -1.5, "frequencies": [2.45e9]}])
        plain = argparse.Namespace(field_plane=None)
        self.assertEqual(_field_plane_request(plain, own), [{"quantity": "E"}])
        self.assertIsNone(_field_plane_request(plain, types.SimpleNamespace()))

    def test_cli_refuses_bad_specs(self):
        for spec in (["D", "z", "1", "2"], ["E", "w", "1", "2"], ["E", "z", "a", "2"], ["E", "z", "1", ""], ["Eq", "z", "1", "2"]):
            with self.subTest(spec=spec), self.assertRaises(SystemExit):
                field_planes.parse_cli([spec])


if __name__ == "__main__":
    unittest.main()
