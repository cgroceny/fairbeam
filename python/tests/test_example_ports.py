"""Python-to-Designer conversion must not discard physical feeds or port adapters."""

import tempfile
import unittest
from pathlib import Path

from fairbeam.design import build
from fairbeam.example_design import ExampleConversionError, convert_example
from fairbeam.model import load_model
from fairbeam.python_design import ScriptError, convert_script


SOURCE = '''from fairbeam import Simulation

MODEL = {"id": "feed-control", "name": "Feed control"}
PARAMS = []

class GroupedFeed:
    def __init__(self, lower, upper):
        self.lower, self.upper, self.Z_ref = lower, upper, 50.0

    def CalcPort(self, path, frequency):
        raise RuntimeError("this fixture builds geometry only")

def build(_):
    sim = Simulation(1e9, 2e9)
    metal = sim.metal("conductor")
    for z in (0, 1, 2):
        metal.AddBox([-3, -3, z], [3, 3, z], priority=10)
    lower = sim.lumped_port(1, 100, [0, 0, 0], [0, 0, 1], "z", priority=5)
    # EXTRA_FEED
    for axis in "xy":
        sim.mesh.AddLine(axis, [-4, -3, 0, 3, 4])
    sim.mesh.AddLine("z", [-1, 0, 1, 2, 3])
    return sim
'''

GROUP = '''upper = sim.fdtd.AddLumpedPort(2, 100, [0, 0, 2], [0, 0, 1], "z", 1, priority=5)
    sim._port_objs[0] = GroupedFeed(lower, upper)
    sim.ports[0]["R"] = 50.0'''


def with_feed(extra):
    return SOURCE.replace("# EXTRA_FEED", extra)


def feed_count(sim):
    return sum(p.GetTypeString() == "LumpedElement" for p in sim.csx.GetAllProperties())


class ExamplePortTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = Path(self.tmp.name) / "control.py"

    def convert(self, extra):
        self.source.write_text(with_feed(extra), encoding="utf-8")
        return convert_example(self.source, "control", "Control")

    def test_grouped_adapter_is_refused_before_a_feed_is_lost(self):
        self.source.write_text(with_feed(GROUP), encoding="utf-8")
        original = load_model(self.source).build({})
        self.assertEqual((len(original.ports), feed_count(original)), (1, 2))
        with self.assertRaisesRegex(ExampleConversionError, "port 1.*grouped or custom"):
            convert_example(self.source, "control", "Control")

    def test_python_apply_reports_grouped_feed_refusal(self):
        with self.assertRaisesRegex(ScriptError, "port 1.*grouped or custom"):
            convert_script(with_feed(GROUP))

    def test_unrecorded_native_feed_is_refused_even_when_not_excited(self):
        for excite in (0, 1):
            with self.subTest(excite=excite):
                extra = (f'sim.fdtd.AddLumpedPort(2, 100, [0, 0, 2], [0, 0, 1], '
                         f'"z", {excite}, priority=5)')
                with self.assertRaisesRegex(ExampleConversionError, "unrecorded.*port_resist_2"):
                    self.convert(extra)

    def test_second_primitive_on_a_native_port_is_refused(self):
        with self.assertRaisesRegex(ExampleConversionError, "port 1.*multiple primitives"):
            self.convert('lower.port_props[0].AddBox([0, 0, 2], [0, 0, 1], priority=5)')

    def test_unrecorded_excitation_is_not_silently_discarded(self):
        extra = '''sim.csx.AddExcitation("extra-feed", exc_type=0, exc_val=[0, 0, 1]).AddBox(
        [0, 0, 2], [0, 0, 1], priority=5)'''
        with self.assertRaisesRegex(ExampleConversionError, "unrecorded Excitation.*extra-feed"):
            self.convert(extra)

    def test_custom_native_subclass_is_not_treated_as_an_ordinary_port(self):
        extra = '''class CustomFeed(type(lower)):
        def CalcPort(self, *args, **kwargs):
            raise RuntimeError("custom measurement")
    lower.__class__ = CustomFeed'''
        with self.assertRaisesRegex(ExampleConversionError, "port 1.*grouped or custom"):
            self.convert(extra)

    def test_missing_native_port_object_is_refused(self):
        with self.assertRaisesRegex(ExampleConversionError, "port records.*native port objects"):
            self.convert("sim._port_objs.clear()")

    def test_mismatched_native_port_number_is_refused(self):
        with self.assertRaisesRegex(ExampleConversionError, "port 1.*native port number"):
            self.convert("lower.number = 9")

    def test_ordinary_ports_and_recorded_resistor_keep_all_feeds(self):
        extra = '''sim.lumped_port(2, 100, [0, 0, 2], [0, 0, 1], "z", excite=False, priority=5)
    sim.lumped_resistor("load", 75, [3, 0, 0], [3, 0, 1], "z")'''
        design = self.convert(extra)
        rebuilt = build(design, {})
        original = load_model(self.source).build({})
        self.assertEqual((len(rebuilt.ports), feed_count(rebuilt)), (2, 3))
        self.assertEqual(rebuilt.ports, original.ports)
        self.assertEqual(rebuilt.lumped_elements[0]["R"], 75.0)
        for a, b in zip(rebuilt._port_objs, original._port_objs):
            self.assertEqual(type(a), type(b))
            self.assertEqual([p.GetQtyPrimitives() for p in a.port_props],
                             [p.GetQtyPrimitives() for p in b.port_props])


if __name__ == "__main__":
    unittest.main()
