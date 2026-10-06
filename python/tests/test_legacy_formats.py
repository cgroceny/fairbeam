"""Files written by antenlab (0.6.x) still open in Fairbeam, and new files carry the Fairbeam names.

The fixtures in tests/fixtures/legacy/ are in the 0.6.8 format: a design, a project bundle, a study, a
parameter sweep, a CST macro and a generated Python model with ANTENLAB_ORGANIZATION. This is the
one test file (with fairbeam/legacy.py) where the old names may appear. There is no ``antenlab``
package any more: a user's own model that says ``import antenlab`` is rewritten by the desktop
app's import step, not accepted here.
"""

import ast
import importlib.util
import json
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from fairbeam import legacy  # noqa: E402
from fairbeam._meta import BUNDLE_SCHEMA  # noqa: E402
from fairbeam.cli import _read_index_entry  # noqa: E402
from fairbeam.convergence import ServerStudies, new_study  # noqa: E402
from fairbeam.cst_import import import_cst, read_macro  # noqa: E402
from fairbeam.design import DESIGN_SCHEMA, DesignError, blank_design, check_design, module_for, read_design, to_python  # noqa: E402
from fairbeam.design_checks import lint  # noqa: E402
from fairbeam.organization import restore_organization  # noqa: E402
from fairbeam.preview import build_preview  # noqa: E402
from fairbeam.study import STUDY_SCHEMA  # noqa: E402
from test_cst_import import PROJECTS, RoundTrip, same_numbers  # noqa: E402

LEGACY = HERE / "fixtures" / "legacy"


def load(name: str):
    return json.loads((LEGACY / name).read_text(encoding="utf-8"))


class Mapping(unittest.TestCase):
    def test_every_legacy_schema_maps_to_the_fairbeam_one(self):
        for old, new in legacy.LEGACY_SCHEMAS.items():
            self.assertTrue(old.startswith("antenlab.") and new.startswith("fairbeam."), old)
            self.assertEqual(old.split(".", 1)[1], new.split(".", 1)[1])
            self.assertEqual(legacy.current_schema(old), new)
            self.assertEqual(legacy.current_schema(new), new)
        self.assertEqual(legacy.current_schema("other/1"), "other/1")
        self.assertIsNone(legacy.current_schema(None))

    def test_the_fixtures_carry_the_old_ids(self):
        self.assertEqual(load("antenlab-0.6.8.design.json")["schema"], "antenlab.design/1")
        self.assertEqual(load("antenlab-0.6.8.project.json")["schema"], "antenlab.project/1")
        self.assertEqual(load("antenlab-0.6.8.study.json")["schema"], "antenlab.study/1")
        self.assertEqual(load("antenlab-0.6.8.sweep.json")["schema"], "antenlab.parameter-sweep/1")
        self.assertEqual(legacy.current_schema(load("antenlab-0.6.8.sweep.json")["schema"]), "fairbeam.parameter-sweep/1")

    def test_there_is_no_antenlab_package(self):
        self.assertIsNone(importlib.util.find_spec("antenlab"))

    def test_new_files_are_written_with_fairbeam_ids(self):
        self.assertEqual(DESIGN_SCHEMA, "fairbeam.design/1")
        self.assertEqual(BUNDLE_SCHEMA, "fairbeam.project/1")
        self.assertEqual(STUDY_SCHEMA, "fairbeam.study/1")
        self.assertEqual(blank_design("x", "X")["schema"], "fairbeam.design/1")
        self.assertEqual(new_study(name="s", model={}, planned=[1.0], tol={})["schema"], "fairbeam.study/1")
        for ids in legacy.LEGACY_SCHEMAS.values():
            self.assertTrue(ids.startswith("fairbeam."))


class Designs(unittest.TestCase):
    def test_an_antenlab_design_opens_and_is_read_as_a_fairbeam_design(self):
        design = read_design(LEGACY / "antenlab-0.6.8.design.json")
        self.assertEqual(design["schema"], "fairbeam.design/1")
        self.assertEqual(design["model"]["id"], "blade-867")
        self.assertEqual([i for i in lint(design) if i.get("severity") == "error"], [])
        self.assertTrue(module_for(design).PARAMS)

    def test_a_design_dict_with_the_old_id_passes_the_check_unchanged(self):
        design = load("antenlab-0.6.8.design.json")
        check_design(design)
        self.assertEqual(design["schema"], "antenlab.design/1")   # the check does not rewrite what it is given

    def test_an_antenlab_design_is_saved_with_the_fairbeam_id(self):
        # the workspace import leaves the file as it is; GET /api/designs/{id} returns it raw and
        # the viewer sends it back unchanged, so the save is where the id changes
        from fairbeam import modelfiles
        with tempfile.TemporaryDirectory() as tmp:
            models, history = Path(tmp) / "models", Path(tmp) / "history"
            models.mkdir()
            path = models / "blade.design.json"
            shutil.copyfile(LEGACY / "antenlab-0.6.8.design.json", path)
            record = modelfiles.read_design_file(models, "blade")
            self.assertEqual(record["design"]["schema"], "antenlab.design/1", "read as it is")
            saved = modelfiles.save_design(models, history, "blade", record["design"], record["hash"])
            self.assertIsNotNone(saved["backup"], "the antenlab version is kept in the history")
            written = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(written["schema"], "fairbeam.design/1")
            self.assertEqual(list(written)[0], "schema", "the key keeps its place")
            self.assertEqual({**written, "schema": None}, {**record["design"], "schema": None}, "nothing else changes")

    def test_an_unknown_schema_is_still_refused(self):
        design = load("antenlab-0.6.8.design.json")
        design["schema"] = "antenlab.design/2"
        with self.assertRaises(DesignError):
            check_design(design)
        design["schema"] = "other.design/1"
        with self.assertRaises(DesignError):
            check_design(design)

    def test_reserved_part_names_cover_both_prefixes(self):
        for name in ("fairbeam_J_x", "antenlab_J_x"):
            design = load("antenlab-0.6.8.design.json")
            design["parts"][0]["name"] = name
            with self.assertRaises(DesignError, msg=name):
                check_design(design)
        self.assertTrue(legacy.is_reserved_name("antenlab_F_Ez0"))
        self.assertFalse(legacy.is_reserved_name("antenlab"))
        self.assertFalse(legacy.is_reserved_name("antenlab2_part"))

    def test_the_design_builds_a_preview(self):
        design = read_design(LEGACY / "antenlab-0.6.8.design.json")
        bundle = build_preview(None, {}, design=design)["bundle"]
        self.assertEqual(bundle["schema"], "fairbeam.project/1")
        self.assertTrue(bundle["parts"])


class Projects(unittest.TestCase):
    def test_an_antenlab_bundle_is_listed_in_the_project_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copy(LEGACY / "antenlab-0.6.8.project.json", Path(tmp) / "dipole.json")
            entry = _read_index_entry(Path(tmp) / "dipole.json")
        self.assertIsNotNone(entry)
        self.assertEqual(entry["model"], "dipole")
        self.assertTrue(entry["simulated"])

    def test_the_fairbeam_id_is_listed_too_and_a_foreign_file_is_not(self):
        bundle = load("antenlab-0.6.8.project.json")
        with tempfile.TemporaryDirectory() as tmp:
            for schema, listed in (("fairbeam.project/1", True), ("antenlab.project/1", True), ("something.else/1", False), (None, False)):
                bundle["schema"] = schema
                path = Path(tmp) / "b.json"
                path.write_text(json.dumps(bundle), encoding="utf-8")
                from fairbeam import cli
                cli._INDEX_CACHE.clear()
                self.assertEqual(_read_index_entry(path) is not None, listed, schema)


class Studies(unittest.TestCase):
    def test_an_antenlab_study_is_loaded_with_the_new_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "studies"
            folder.mkdir()
            shutil.copy(LEGACY / "antenlab-0.6.8.study.json", folder / "dipole-length-sweep.json")
            study = ServerStudies(None, Path(tmp)).load("dipole-length-sweep")
        self.assertEqual(study["schema"], "fairbeam.study/1")
        self.assertEqual(study["name"], "dipole-length-sweep")
        self.assertEqual(len(study["members"]), 3)

    def test_the_sweep_definition_maps(self):
        sweep = load("antenlab-0.6.8.sweep.json")
        self.assertEqual(len(sweep["sequences"]), 2)
        self.assertTrue(legacy.schema_is(sweep["schema"], "fairbeam.parameter-sweep/1"))
        self.assertTrue(legacy.schema_family(sweep["schema"], "fairbeam.parameter-sweep/"))
        self.assertFalse(legacy.schema_family("other/1", "fairbeam.parameter-sweep/"))


class CstMacros(RoundTrip):
    """Macros exported before the rename (0.7.0) say "generated by antenlab", carry ``antenlab-data``
    records and use the component "antenlab": they still import, with their name and their records."""

    def test_antenlab_macro_still_imports(self):
        macro = LEGACY / "cst-0.6.bas"
        text = macro.read_text(encoding="utf-8")
        self.assertIn("generated by antenlab", text.splitlines()[1])
        self.assertIn('Component.New ""antenlab""', text)
        self.assertIn("antenlab-data:", text)
        original = json.loads((PROJECTS / "dipole.json").read_text(encoding="utf-8"))
        res = import_cst(text, filename=macro.name)
        design, report = res["design"], res["report"]
        self.assertEqual(report["refused"], 0, [n for n in report["notes"] if n["severity"] == "refused"])
        self.assertEqual(design["model"]["name"], original["name"])
        self.assertTrue(any("restored from the" in n["message"] for n in report["notes"]), "the antenlab-data records are used")
        bundle = build_preview(None, {}, design=design)["bundle"]
        self.assert_same_build(original, bundle, "dipole", set())
        for a in "xyz":
            self.assertTrue(same_numbers(original["mesh"][a], bundle["mesh"][a], 1e-4), f"mesh lines along {a}")

    def test_both_headers_name_the_design(self):
        for maker in ("antenlab 0.6.8", "Fairbeam 0.7.0"):
            with self.subTest(maker=maker):
                _blocks, _meta, _notes, name = read_macro(
                    f"' My antenna\n' CST Studio Suite macro generated by {maker} from an openEMS project\n"
                    "Sub Main ()\nEnd Sub\n")
                self.assertEqual(name, "My antenna")

    def test_both_markers_give_the_same_records(self):
        for marker in ("antenlab-data", "fairbeam-data"):
            with self.subTest(marker=marker):
                _blocks, meta, notes, _name = read_macro(f"' {marker}: {{\"mesh\": {{\"cells_per_wavelength\": 20}}}}\nSub Main ()\nEnd Sub\n")
                self.assertEqual(meta, [{"mesh": {"cells_per_wavelength": 20}}])
                self.assertEqual(notes, [])

    def test_the_helper_block_of_both_names_is_skipped(self):
        for marker in ("antenlab-helper", "fairbeam-helper"):
            with self.subTest(marker=marker):
                blocks, _meta, _notes, _name = read_macro(
                    f"' {marker}: begin\nDim s As String\n' {marker}: end\nSub Main ()\nEnd Sub\n")
                self.assertEqual([stmt for b in blocks for stmt in b.stmts], [])


class GeneratedPython(unittest.TestCase):
    def test_the_old_attribute_still_restores_the_folders(self):
        tree = ast.parse((LEGACY / "antenlab-0.6.8.model.py").read_text(encoding="utf-8"))
        value = next(ast.literal_eval(n.value) for n in tree.body
                     if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "ANTENLAB_ORGANIZATION")
        self.assertEqual(value["components"], ["Antenna/Blade", "Ground"])
        module = types.SimpleNamespace(ANTENLAB_ORGANIZATION=value)   # what the model file defines once it can be imported
        core = {"parts": [{"name": n} for n in value["parts"]]}
        restore_organization(module, core)
        self.assertEqual(core["components"], ["Antenna/Blade", "Ground"])
        self.assertEqual({p["name"]: p["component"] for p in core["parts"]}, value["parts"])

    def test_the_new_attribute_wins_and_errors_name_the_attribute_in_use(self):
        old = {"parts": {"a": "Old"}}
        new = {"parts": {"a": "New"}}
        core = {"parts": [{"name": "a"}]}
        restore_organization(types.SimpleNamespace(ANTENLAB_ORGANIZATION=old, FAIRBEAM_ORGANIZATION=new), core)
        self.assertEqual(core["parts"][0]["component"], "New")
        with self.assertRaisesRegex(ValueError, "ANTENLAB_ORGANIZATION"):
            restore_organization(types.SimpleNamespace(ANTENLAB_ORGANIZATION={"components": ["/bad"], "parts": {}}), {"parts": []})
        with self.assertRaisesRegex(ValueError, "FAIRBEAM_ORGANIZATION"):
            restore_organization(types.SimpleNamespace(FAIRBEAM_ORGANIZATION={"components": ["/bad"], "parts": {}}), {"parts": []})

    def test_a_new_export_imports_fairbeam_and_writes_the_new_attribute(self):
        design = read_design(LEGACY / "antenlab-0.6.8.design.json")
        text = to_python(design)
        self.assertIn("from fairbeam import Param, Simulation", text)
        self.assertIn("FAIRBEAM_ORGANIZATION = ", text)
        self.assertNotIn("import antenlab", text)
        self.assertNotIn("from antenlab", text)


if __name__ == "__main__":
    unittest.main()
