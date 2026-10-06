import tempfile
import textwrap
import unittest
from pathlib import Path

from fairbeam.model import Param, load_model, resolve_params

MODELS = Path(__file__).resolve().parents[1] / "models"


class ParamTest(unittest.TestCase):
    def test_float_parse_and_bounds(self):
        p = Param("length", 58.0, "Length", "mm", minimum=5, maximum=100)
        self.assertEqual(p.parse("60"), 60.0)
        self.assertIsInstance(p.parse("60"), float)
        self.assertEqual(p.parse("5"), 5.0)  # bounds are inclusive
        self.assertEqual(p.parse("100"), 100.0)
        with self.assertRaises(ValueError):
            p.parse("4.99")
        with self.assertRaises(ValueError):
            p.parse("100.01")

    def test_int_parse(self):
        p = Param("iterations", 3, "Iterations", minimum=0, maximum=5)
        self.assertEqual(p.parse("2"), 2)
        self.assertIsInstance(p.parse("2"), int)
        with self.assertRaises(ValueError):
            p.parse("2.5")
        with self.assertRaises(ValueError):
            p.parse("6")

    def test_bool_parse(self):
        p = Param("flag", False, "Flag")
        for t in ("1", "true", "Yes", "ON"):
            self.assertIs(p.parse(t), True)
        for t in ("0", "false", "no", "off", "x"):
            self.assertIs(p.parse(t), False)

    def test_string_parse(self):
        self.assertEqual(Param("sub", "FR4", "Substrate").parse("RO4003"), "RO4003")

    def test_garbage_number(self):
        with self.assertRaises(ValueError):
            Param("x", 1.0, "X").parse("abc")

    def test_describe(self):
        d = Param("x", 1.0, "X", "mm", "desc", 0, 2).describe(1.5)
        self.assertEqual(d, {"key": "x", "default": 1.0, "label": "X", "unit": "mm", "description": "desc",
                             "minimum": 0, "maximum": 2, "value": 1.5})


class ResolveTest(unittest.TestCase):
    PARAMS = [Param("a", 1.0, "A", minimum=0), Param("n", 2, "N")]

    def test_defaults(self):
        self.assertEqual(resolve_params(self.PARAMS, {}), {"a": 1.0, "n": 2})

    def test_override(self):
        self.assertEqual(resolve_params(self.PARAMS, {"n": "4"}), {"a": 1.0, "n": 4})

    def test_unknown_key(self):
        with self.assertRaises(KeyError):
            resolve_params(self.PARAMS, {"b": "1"})

    def test_out_of_bounds(self):
        with self.assertRaises(ValueError):
            resolve_params(self.PARAMS, {"a": "-1"})


class LoadModelTest(unittest.TestCase):
    def test_missing_attribute(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "broken.py"
            path.write_text("MODEL = {}\nPARAMS = []\n")
            with self.assertRaises(AttributeError):
                load_model(path)

    def test_loads(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "ok.py"
            path.write_text(textwrap.dedent("""
                MODEL = {"id": "ok", "name": "OK"}
                PARAMS = []
                def build(p):
                    return None
            """))
            self.assertEqual(load_model(path).MODEL["id"], "ok")


class ShippedModelsTest(unittest.TestCase):
    """Every model in python/models declares consistent metadata and valid defaults."""

    def test_models(self):
        files = sorted(MODELS.glob("*.py"))
        self.assertTrue(files)
        for path in files:
            with self.subTest(model=path.name):
                m = load_model(path)
                for key in ("id", "name", "description"):
                    self.assertIn(key, m.MODEL)
                keys = [p.key for p in m.PARAMS]
                self.assertEqual(len(keys), len(set(keys)), "duplicate parameter keys")
                for p in m.PARAMS:
                    # the default must survive its own bounds check
                    self.assertEqual(p.parse(str(p.default)), p.default)
                    if p.minimum is not None and p.maximum is not None:
                        self.assertLess(p.minimum, p.maximum)


if __name__ == "__main__":
    unittest.main()
