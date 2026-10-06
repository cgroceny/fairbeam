"""Grouped-feed round trips and mode normalization; no FDTD runs."""

import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np

from fairbeam import Simulation
from fairbeam.design import build, to_python
from fairbeam.example_design import ExampleConversionError, convert_example
from fairbeam.model import load_model
from fairbeam.python_design import convert_script
from fairbeam.simulation import GroupedLumpedPort, _time_signals, excite_only
from tests.test_example_ports import SOURCE, feed_count


GROUP = {"connection": "parallel", "members": [
    {"start": [0, 0, 2], "stop": [0, 0, 1], "direction": "z", "polarity": 1}]}
OFFICIAL = SOURCE.replace(
    'lower = sim.lumped_port(1, 100, [0, 0, 0], [0, 0, 1], "z", priority=5)',
    f'lower = sim.lumped_port(1, 50, [0, 0, 0], [0, 0, 1], "z", group={GROUP!r})')


def signature(sim):
    """Compare physical feeds, not just the logical Design count."""
    return [(p.number, p.R, p.start.tolist(), p.stop.tolist(), p.exc_ny,
             p.excite, p.priority, p.prefix) for adapter in sim._port_objs for p in adapter.members]


class GroupedPortRoundTripTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "group.py"

    def test_parallel_and_series_survive_save_apply_and_python_export(self):
        for connection, polarity, r in (("parallel", 1, 50), ("series", -1, 100)):
            with self.subTest(connection=connection):
                group = copy.deepcopy(GROUP)
                group.update(connection=connection, priority=7)
                group["members"][0]["polarity"] = polarity
                source = OFFICIAL.replace(repr(GROUP), repr(group)).replace(
                    "sim.lumped_port(1, 50,", f"sim.lumped_port(1, {r},")
                self.path.write_text(source, encoding="utf-8")
                original = load_model(self.path).build({})
                design = convert_example(self.path, "control", "Control")
                off_grid = copy.deepcopy(design)
                for end in ("start", "stop"):
                    off_grid["ports"][0]["group"]["members"][0][end][0] = .5
                with self.assertRaisesRegex(ValueError, r"ports\[0\].group.members\[0\].start\[0\]"):
                    build(off_grid, {})
                reopened = json.loads(json.dumps(design))
                rebuilt = build(reopened, {})
                applied = build(convert_script(source)["design"], {})
                self.path.write_text(to_python(reopened), encoding="utf-8")
                exported = load_model(self.path).build({})
                for candidate in (rebuilt, applied, exported):
                    self.assertEqual((len(candidate.ports), feed_count(candidate)), (1, 2))
                    self.assertEqual(signature(candidate), signature(original))
                    self.assertEqual(candidate.ports[0]["group"], group)

    def test_member_coordinates_keep_parameter_expressions(self):
        source = OFFICIAL.replace("from fairbeam import Simulation", "from fairbeam import Simulation, Param").replace(
            "PARAMS = []", 'PARAMS = [Param("gap", 1.0, "Gap", "mm")]')
        source = source.replace("def build(_):", "def build(p):").replace(
            "for z in (0, 1, 2):", 'for z in (0, p["gap"], 2*p["gap"]):')
        source = source.replace("[0, 0, 1]", '[0, 0, p["gap"]]').replace(
            "[0, 0, 2]", '[0, 0, 2*p["gap"]]').replace(
            "[-1, 0, 1, 2, 3]", '[-1, 0, p["gap"], 2*p["gap"], 3*p["gap"]]')
        self.path.write_text(source, encoding="utf-8")
        design = convert_example(self.path, "control", "Control")
        self.assertIsInstance(design["ports"][0]["group"]["members"][0]["start"][2], str)
        self.assertEqual(build(design, {"gap": 1.5}).ports[0]["group"]["members"][0]["start"][2], 3)

    def test_all_members_follow_the_logical_excitation_selector(self):
        for selected in (1, 2):
            with excite_only(selected):
                sim = Simulation(1e9, 2e9)
                group = sim.lumped_port(1, 50, [0, 0, 0], [0, 0, 1], "z", group=GROUP)
                second = copy.deepcopy(GROUP)
                for end in ("start", "stop"):
                    second["members"][0][end][0] = 2
                other = sim.lumped_port(2, 50, [2, 0, 0], [2, 0, 1], "z", group=second)
            self.assertEqual([bool(p.excite) for p in group.members], [selected == 1] * 2)
            self.assertEqual([bool(p.excite) for p in other.members], [selected == 2] * 2)
            self.assertEqual((len(sim.ports), feed_count(sim)), (2, 4))
            self.assertEqual(len({p.prefix for port in sim._port_objs for p in port.members}), 4)

    def test_unequal_gaps_have_equal_signed_source_voltage(self):
        group = copy.deepcopy(GROUP)
        group["members"][0].update(start=[0, 0, 3], polarity=-1)
        port = Simulation(1e9, 2e9).lumped_port(1, 50, [0, 0, 0], [0, 0, 1], "z", group=group)
        self.assertEqual([p.excite for p in port.members], [1, -0.5])

    def test_bad_group_is_refused_before_native_geometry_is_created(self):
        for change in ({"connection": "unknown"}, {"members": []}, {"priority": True}, {"hidden": 3}):
            sim = Simulation(1e9, 2e9)
            with self.assertRaises(ValueError):
                sim.lumped_port(1, 50, [0, 0, 0], [0, 0, 1], "z", group={**GROUP, **change})
            self.assertEqual(feed_count(sim), 0)
            self.assertEqual(sim.ports, [])
        sim = Simulation(1e9, 2e9)
        with self.assertRaisesRegex(ValueError, "length"):
            sim.lumped_port(1, 50, [0, 0, 1], [0, 0, 1], "z", group=GROUP)
        self.assertEqual(feed_count(sim), 0)
        for r in ("fifty", None, -50, float("nan")):
            with self.assertRaisesRegex(ValueError, "R must be finite and positive"):
                sim.lumped_port(1, r, [0, 0, 0], [0, 0, 1], "z", group=GROUP)
        self.assertEqual((feed_count(sim), sim.ports), (0, []))

    def test_group_priority_is_ranked_with_fractional_part_priorities(self):
        # A fractional (void-carver style) priority makes the build rank every priority to an
        # integer; the group's own priority must be ranked with them, not written raw above metal.
        group = copy.deepcopy(GROUP)
        group["priority"] = 7
        self.path.write_text(OFFICIAL.replace(repr(GROUP), repr(group)), encoding="utf-8")
        design = convert_example(self.path, "control", "Control")
        design["parts"][0]["primitives"][0]["priority"] = 10.5
        sim = build(design, {})   # ranks: 5 -> 0, 7 -> 1, 10 -> 2, 10.5 -> 3
        self.assertEqual(sim.ports[0]["group"]["priority"], 1)
        self.assertEqual([p.priority for p in sim._port_objs[0].members], [1, 1])
        self.path.write_text(to_python(design), encoding="utf-8")
        self.assertEqual(signature(load_model(self.path).build({})), signature(sim))

    def test_grouped_port_keeps_the_power_wave_reference(self):
        reference = {"real": 20.0, "imag": -15.0}
        source = OFFICIAL.replace('"z", group=', f'"z", reference_impedance={reference!r}, group=')
        self.path.write_text(source, encoding="utf-8")
        original = load_model(self.path).build({})
        self.assertEqual(original.ports[0]["reference_impedance"], reference)
        design = convert_example(self.path, "control", "Control")
        self.assertEqual(design["ports"][0]["reference_impedance"], reference)
        for candidate in (build(design, {}), build(convert_script(source)["design"], {})):
            self.assertEqual(candidate.ports[0]["reference_impedance"], reference)
            self.assertEqual(signature(candidate), signature(original))
        with self.assertRaisesRegex(ValueError, "positive finite real part"):
            Simulation(1e9, 2e9).lumped_port(1, 50, [0, 0, 0], [0, 0, 1], "z",
                                             reference_impedance={"real": 0, "imag": 1}, group=GROUP)

    def test_custom_probe_options_and_mutated_group_are_not_silently_lost(self):
        with self.assertRaisesRegex(ValueError, "custom probe"):
            Simulation(1e9, 2e9).lumped_port(1, 50, [0, 0, 0], [0, 0, 1], "z", group=GROUP, delay=2)
        self.path.write_text(OFFICIAL.replace("# EXTRA_FEED", 'sim.ports[0]["group"]["connection"] = "series"'), encoding="utf-8")
        with self.assertRaisesRegex(ExampleConversionError, "metadata"):
            convert_example(self.path, "control", "Control")
        for mutation in ('lower.members[0].R = 75', 'lower._u_weights[:] = 1'):
            self.path.write_text(OFFICIAL.replace("# EXTRA_FEED", mutation), encoding="utf-8")
            with self.assertRaisesRegex(ExampleConversionError, "group.*changed"):
                convert_example(self.path, "control", "Control")


class GroupedModeTests(unittest.TestCase):
    def mode(self, connection, r, signs, voltages, currents):
        # Native time samples are staggered; all members share each probe grid.
        members = [SimpleNamespace(CalcPort=Mock(), port_props=[], uf_tot=np.array(u, complex),
                   if_tot=np.array(i, complex), u_time=np.array([0., 1., 2.]),
                   i_time=np.array([0., .5, 1., 1.5, 2.]), ut_tot=np.array([1., 2., 3.]) * sign,
                   it_tot=np.array([0., 1., 2., 3., 4.]) * sign / r)
                   for sign, u, i in zip(signs, voltages, currents)]
        record = {"number": 1, "R": r, "group": {"connection": connection,
                  "members": [{"polarity": sign} for sign in signs[1:]]}}
        port = GroupedLumpedPort(record, members)
        port.CalcPort("unused", [1e9])
        return port

    def test_parallel_matched_mode_and_power(self):
        port = self.mode("parallel", 50, [1, 1], [[2], [2]], [[.02], [.02]])
        np.testing.assert_allclose(port.uf_tot / port.if_tot, [50])
        np.testing.assert_allclose(port.uf_ref, [0], atol=1e-15)
        np.testing.assert_allclose(port.P_acc, [.04])  # two times .5 * 2 * .02
        np.testing.assert_allclose(port.P_inc - port.P_ref, port.P_acc)

    def test_differential_series_mode_and_power(self):
        port = self.mode("series", 100, [1, -1], [[3+4j], [-3-4j]], [[.06+.08j], [-.06-.08j]])
        np.testing.assert_allclose(port.uf_tot, [6+8j])
        np.testing.assert_allclose(port.if_tot, [.06+.08j])
        np.testing.assert_allclose(port.uf_ref, [0], atol=1e-15)
        np.testing.assert_allclose(port.P_acc, [.5])  # sum of two .25 W member powers

    def test_complex_reflection_uses_logical_reference_resistance(self):
        port = self.mode("parallel", 50, [1, 1], [[3+1j], [3+1j]], [[.01-.02j], [.01-.02j]])
        np.testing.assert_allclose(port.uf_inc, [2-.5j])
        np.testing.assert_allclose(port.uf_ref, [1+1.5j])
        np.testing.assert_allclose(port.P_inc - port.P_ref, port.P_acc)
        # Aligned time current is [0, .08, .16], not the first 3 native samples.
        np.testing.assert_allclose(port.ut_inc, [.5, 3, 5.5])
        signals = _time_signals(port)
        np.testing.assert_allclose(signals["i_tot_scaled"], [0, 4, 8])
        self.assertEqual(len(signals["i_tot_scaled"]), len(signals["time_ns"]))

    def test_orthogonal_member_mode_is_excluded_not_counted_as_modal_power(self):
        port = self.mode("parallel", 50, [1, 1], [[2], [-2]], [[.02], [-.02]])
        np.testing.assert_allclose(port.P_acc, [0])  # physical member sum is .04 W

    def test_different_member_sampling_is_refused(self):
        port = self.mode("parallel", 50, [1, 1], [[2], [2]], [[.02], [.02]])
        port.members[1].i_time = np.array([0., 1., 2.])
        with self.assertRaisesRegex(ValueError, "identical i_time"):
            port.CalcPort("unused", [1e9])


if __name__ == "__main__":
    unittest.main()
