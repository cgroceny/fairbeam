"""Pure scalar radiation-over-frequency contracts with a mocked NF2FF result.

No Simulation constructor, model/mesh build, native transform, solver or UI.
--json emits synthetic EfficiencySweep entries for the Node integration controls.
"""
import contextlib
import copy
import io
import json
import math
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fairbeam.jsonutil import finite_json
from fairbeam.multiport import merge
from fairbeam.simulation import (EFFICIENCY_OUTFILE, EFFICIENCY_PHI_STEP, EFFICIENCY_THETA_STEP,
                                 Simulation, _band_radiation, _circular, _finite_interpolation)


F = np.array([1e9, 2e9, 3e9])
THETA = np.array([0., 90., 180.])
PHI = np.array([0., 180.])
NORM = np.array([[.1, .1], [1., .5], [.2, .2]])
PEAK_DB = 10 * math.log10(4)


def result(mirrors=0, eta=(.5, .8, 1.1)):
    # +z is circular, the sampled peak at +x has 2:1 ellipticity.
    ratio = np.full(NORM.shape, .5)
    ratio[0, :] = 1
    et = (NORM / np.sqrt(1 + ratio ** 2)).astype(complex)
    ep = -1j * ratio * et
    return SimpleNamespace(Prad=np.array(eta) * 2 ** mirrors,
                           Dmax=np.full(3, 4. / 2 ** mirrors),
                           E_norm=[NORM.copy() for _ in F],
                           E_theta=[et.copy() for _ in F], E_phi=[ep.copy() for _ in F])


def capture(*, cp=True, mirrors=0, eta=(.5, .8, 1.1), source_f=F, gamma=(.1, .2, .3),
            errors=None, lossless=False, modify=None, port_present=True, n=3, pacc=None):
    """Call the production band method on a plain spy object, never a Simulation."""
    res = result(mirrors, eta)
    if modify:
        modify(res)
    source_f = np.asarray(source_f, float)
    port = SimpleNamespace(uf_inc=np.ones(len(source_f), complex),
                           uf_ref=np.asarray(gamma, complex)) if port_present else None
    nf = SimpleNamespace(CalcNF2FF=Mock(return_value=res))
    sim = SimpleNamespace(f_min=1e9, f_max=3e9, unit=1e-3, sim_path="/synthetic-no-native-call",
                          nf2ff=nf, cp_outputs=cp, end_criteria_db=-60, run_stats={},
                          _pacc_error=Mock(return_value=None if errors is None else np.asarray(errors)),
                          _lossless_efficiency=Simulation._lossless_efficiency)
    powers = np.ones(len(source_f)) if pacc is None else np.asarray(pacc, float)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        entry = Simulation._band_efficiency(sim, n, source_f, powers, np.array([1., 2., 3.]),
                                           mirrors, "lumped", port, lossless)
    return entry, nf.CalcNF2FF, res, sim


def synthetic_records():
    configurations = [
        ("baseline", {}),
        ("cp-off", {"cp": False}),
        ("cp-missing", {"modify": lambda r: delattr(r, "E_phi")}),
        ("unreliable", {"errors": [.05, .11, math.inf]}),
        ("lossless", {"eta": [.98, 1.02, 1.2], "lossless": True}),
        ("gapped-mismatch", {"gamma": [.1, math.nan, .3]}),
        ("missing-port", {"port_present": False}),
    ]
    return [{"name": name, "port": 7, **capture(**kwargs)[0]} for name, kwargs in configurations]


class RadiationFrequency(unittest.TestCase):
    def test_same_single_transform_and_aligned_scalar_schema(self):
        entry, transform, _, _ = capture()
        transform.assert_called_once()
        args, kw = transform.call_args
        self.assertEqual(args[0], "/synthetic-no-native-call")
        self.assertEqual(args[1], F.tolist())
        np.testing.assert_array_equal(args[2], THETA)
        np.testing.assert_array_equal(args[3], PHI)
        np.testing.assert_array_equal(kw["center"], [.001, .002, .003])
        self.assertEqual(kw["outfile"], EFFICIENCY_OUTFILE)
        self.assertEqual(set(kw), {"center", "outfile"})
        r = entry["radiation"]
        self.assertEqual(r["source"], "band-efficiency-nf2ff")
        self.assertEqual((r["theta"], r["phi"]), (THETA.tolist(), PHI.tolist()))
        self.assertEqual((entry["theta_step"], entry["phi_step"]), (EFFICIENCY_THETA_STEP, EFFICIENCY_PHI_STEP))
        self.assertIs(r["cp_requested"], True)
        self.assertEqual(r["ar_mask_db"], 20)
        for key, values in r.items():
            if isinstance(values, list) and key not in ("theta", "phi"):
                self.assertEqual(len(values), len(entry["f"]), key)
        self.assertNotIn("directivity_dbi", entry)
        self.assertNotIn("farfield", entry)
        self.assertNotIn("E_theta", r)
        self.assertEqual(entry["prad_w"], [.5, .8, 1.1])
        self.assertEqual(entry["pacc_w"], [1.] * 3)
        self.assertEqual(entry["rad_efficiency"], [.5, .8, 1.1])

    def test_analytical_d_gain_realized_and_cp_same_pass(self):
        with patch("fairbeam.simulation._circular", wraps=_circular) as cp:
            entry, transform, res, _ = capture()
        self.assertEqual(cp.call_count, len(F))
        self.assertTrue(all(call.args[0] is res for call in cp.call_args_list))
        self.assertEqual(transform.call_count, 1)
        r = entry["radiation"]
        self.assertEqual(r["peak_theta_deg"], [90.] * 3)
        self.assertEqual(r["peak_phi_deg"], [0.] * 3)
        self.assertEqual(r["d_peak_dbi"], [round(PEAK_DB, 3)] * 3)
        self.assertEqual(r["d_boresight_dbi"], [round(PEAK_DB - 20, 3)] * 3)
        self.assertEqual(r["ar_peak_db"], [6.021] * 3)
        self.assertEqual(r["ar_boresight_db"], [0.] * 3)
        np.testing.assert_allclose(r["mismatch_efficiency"], [.99, .96, .91])
        for i, eta in enumerate(entry["rad_efficiency"]):
            gain = PEAK_DB + 10 * math.log10(eta)
            realized = gain + 10 * math.log10(r["mismatch_efficiency"][i])
            self.assertEqual(r["gain_peak_dbi"][i], round(gain, 3))
            self.assertEqual(r["gain_boresight_dbi"][i], round(gain - 20, 3))
            self.assertEqual(r["realized_peak_dbi"][i], round(realized, 3))
            self.assertEqual(r["realized_boresight_dbi"][i], round(realized - 20, 3))

    def test_mirror_and_lossless_policies_are_retained(self):
        base = capture()[0]
        for mirrors in (1, 2):
            entry = capture(mirrors=mirrors)[0]
            self.assertEqual(entry["mirror_planes"], mirrors)
            self.assertEqual(entry["prad_w"], base["prad_w"])
            self.assertEqual(entry["rad_efficiency"], base["rad_efficiency"])
            self.assertEqual(entry["radiation"], base["radiation"])
        entry = capture(eta=[.98, 1.02, 1.2], lossless=True)[0]
        self.assertEqual(entry["rad_efficiency_raw"], [.98, 1.02, 1.2])
        self.assertEqual(entry["rad_efficiency"], [1., 1., 1.2])
        self.assertEqual(entry["radiation"]["gain_peak_dbi"][:2], [round(PEAK_DB, 3)] * 2)
        self.assertEqual(entry["radiation"]["gain_peak_dbi"][2], round(PEAK_DB + 10 * math.log10(1.2), 3))
        self.assertTrue(entry["qa_warnings"])

    def test_cp_off_missing_fields_and_mask_do_not_create_values(self):
        with patch("fairbeam.simulation._circular", wraps=_circular) as cp:
            off = capture(cp=False)[0]["radiation"]
        cp.assert_not_called()
        self.assertNotIn("ar_peak_db", off)
        self.assertNotIn("ar_boresight_db", off)
        missing = capture(modify=lambda r: delattr(r, "E_phi"))[0]["radiation"]
        self.assertEqual(missing["ar_peak_db"], [None] * 3)
        self.assertEqual(missing["d_peak_dbi"], off["d_peak_dbi"])

        def low_and_zero(res):
            for key in ("E_norm", "E_theta", "E_phi"):
                getattr(res, key)[0][0, :] *= .999
                getattr(res, key)[1][0, :] = 0
            res.E_theta[2][1, 0] = complex(math.nan, 0)
        r = capture(modify=low_and_zero)[0]["radiation"]
        self.assertIsNone(r["ar_boresight_db"][0])  # just below sampled peak -20 dB
        self.assertIsNone(r["d_boresight_dbi"][1])
        self.assertIsNone(r["ar_boresight_db"][1])
        self.assertIsNone(r["ar_peak_db"][2])
        self.assertIsNotNone(r["d_peak_dbi"][2])

    def test_nonfinite_invalid_power_and_missing_boresight_remain_unavailable(self):
        def bad(res):
            res.Dmax[0] = math.nan
            res.E_norm[1][:] = 0
            res.E_norm[2][0, :] = math.inf
        r = capture(modify=bad)[0]["radiation"]
        self.assertEqual(r["d_peak_dbi"][:2], [None, None])
        self.assertEqual(r["ar_peak_db"][:2], [None, None])
        self.assertIsNone(r["d_boresight_dbi"][2])
        negative = capture(pacc=[0, -1, 1])[0]
        self.assertEqual(negative["rad_efficiency"][:2], [None, None])
        self.assertEqual(negative["radiation"]["gain_peak_dbi"][:2], [None, None])
        self.assertEqual(negative["radiation"]["realized_peak_dbi"][:2], [None, None])
        off_pole = _band_radiation(result(), F, [5, 90, 180], PHI, 0, [.5] * 3, F, None, True)
        self.assertEqual(off_pole["d_boresight_dbi"], [None] * 3)
        self.assertEqual(off_pole["ar_boresight_db"], [None] * 3)
        json.dumps(finite_json(r), allow_nan=False)

    def test_mismatch_has_no_extrapolation_or_gap_bridging(self):
        q = [0, 1, 1.5, 2, 2.5, 3, 4]
        expected = [math.nan, .1, math.nan, math.nan, math.nan, .3, math.nan]
        np.testing.assert_allclose(_finite_interpolation([1, 2, 3], [.1, math.nan, .3], q), expected, equal_nan=True)
        for bad_x in ([1, 1, 3], [3, 2, 1], [1, math.nan, 3]):
            self.assertTrue(np.all(np.isnan(_finite_interpolation(bad_x, [.1, .2, .3], q))))
        gapped = capture(gamma=[.1, math.nan, .3])[0]["radiation"]
        self.assertEqual(gapped["mismatch_efficiency"], [.99, None, .91])
        self.assertIsNone(gapped["realized_peak_dbi"][1])
        self.assertIsNotNone(gapped["gain_peak_dbi"][1])
        narrow = capture(source_f=[1.5e9, 2e9, 2.5e9])[0]["radiation"]
        self.assertEqual(narrow["mismatch_efficiency"], [None, .96, None])
        self.assertEqual(narrow["realized_peak_dbi"][::2], [None, None])
        unmatched = capture(gamma=[1., 1.1, .3])[0]["radiation"]
        self.assertEqual(unmatched["realized_peak_dbi"][:2], [None, None])
        self.assertLess(unmatched["mismatch_efficiency"][1], 0)
        missing = capture(port_present=False)[0]["radiation"]
        self.assertEqual(missing["mismatch_efficiency"], [None] * 3)
        self.assertEqual(missing["realized_peak_dbi"], [None] * 3)

    def test_reliability_is_preserved_without_erasing_raw_values(self):
        entry = capture(errors=[.05, .11, math.inf])[0]
        self.assertEqual(entry["reliable"], [True, False, False])
        self.assertEqual(entry["pacc_error"], [.05, .11, None])
        self.assertEqual(entry["rad_efficiency"], [.5, .8, 1.1])
        self.assertTrue(all(v is not None for v in entry["radiation"]["gain_peak_dbi"]))
        self.assertTrue(all(v is not None for v in entry["radiation"]["realized_peak_dbi"]))
        self.assertTrue(any("unreliable" in w for w in entry["qa_warnings"]))

    def test_nonconsecutive_port_identity_survives_existing_merge(self):
        numbers = [2, 7]
        sims = []
        for own, pn in enumerate(numbers):
            entry = capture(gamma=[.1 + own * .1] * 3)[0]
            ports = [SimpleNamespace(Z_ref=50., uf_inc=np.full(3, 1. if own == j else .2),
                                     uf_ref=np.full(3, .1)) for j in range(2)]
            sim = SimpleNamespace(_port_objs=ports, run_stats={"converged": True},
                                  results={"frequency": F.tolist(), "ports": {str(pn): {}},
                                           "farfield": [], "efficiency": [entry]})
            sims.append((pn, sim))
        snapshots = [copy.deepcopy(sim.results["efficiency"][0]) for _, sim in sims]
        primary = sims[0][1]
        merge(primary, sims, numbers, False)
        self.assertEqual([e["port"] for e in primary.results["efficiency"]], numbers)
        for entry, expected in zip(primary.results["efficiency"], snapshots):
            self.assertEqual({k: v for k, v in entry.items() if k != "port"}, expected)
        self.assertNotEqual(primary.results["efficiency"][0]["radiation"]["mismatch_efficiency"],
                            primary.results["efficiency"][1]["radiation"]["mismatch_efficiency"])

    def test_json_records_are_strict_and_do_not_store_field_grids(self):
        records = json.loads(json.dumps(finite_json(synthetic_records()), allow_nan=False))
        self.assertEqual({r["name"] for r in records},
                         {"baseline", "cp-off", "cp-missing", "unreliable", "lossless", "gapped-mismatch", "missing-port"})
        for entry in records:
            self.assertEqual(entry["port"], 7)
            self.assertEqual(entry["f"], F.tolist())
            self.assertFalse(any(k in entry["radiation"] for k in ("E_norm", "E_theta", "E_phi", "directivity_dbi")))


if __name__ == "__main__":
    if "--json" in sys.argv:
        print(json.dumps(finite_json(synthetic_records()), allow_nan=False))
    else:
        unittest.main()
