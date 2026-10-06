"""Native model building and roundtrip only; no solver invocation."""
import tempfile
import types
import unittest
from pathlib import Path
from fairbeam.design import blank_design, module_for, to_python
from fairbeam.example_design import _read_design
from fairbeam.simulation import Simulation

class RFWorkflows(unittest.TestCase):
    def test_native_rlc_and_legacy_resistor(self):
        sim = Simulation(1e9, 2e9)
        old = sim.lumped_resistor("R", 100, [0,0,0], [0,0,1], "z")
        self.assertEqual(old.GetResistance(), 100)
        for topology, native in [("parallel", 0), ("series", 1)]:
            prop = sim.lumped_element(topology,[0,0,0],[0,0,1],"z",R=20,L=1e-9,C=1e-12,topology=topology)
            self.assertEqual(prop.GetLEtype(), native)
            self.assertEqual(prop.GetInductance(), 1e-9)
            self.assertEqual(prop.GetCapacity(), 1e-12)
        with self.assertRaises(ValueError): sim.lumped_element("empty",[0,0,0],[0,0,1],"z")
        with self.assertRaises(ValueError): sim.lumped_element("negative",[0,0,0],[0,0,1],"z",C=-1e-12)

    def test_python_export_and_readback(self):
        d = blank_design("rf_test","RF test")
        d["components"] = ["Assembly/Feed", "Empty/Folder"]
        d["parts"][0]["component"] = "Assembly/Feed"
        d["far_field"]["enabled"] = False
        d["materials"][1]["mu_r"] = 2
        d["ports"][0]["reference_impedance"] = {"real":20,"imag":-150}
        d["resistors"] = [{"name":"chip","R":20,"L":1e-9,"C":1e-12,"topology":"series", "start":[0,0,0],"stop":[0,0,1],"direction":"z"}]
        src = to_python(d)
        exported = types.ModuleType("exported_rf")
        exec(compile(src,"rf_export.py","exec"), exported.__dict__)
        values = {p.key:p.default for p in exported.PARAMS}
        direct = module_for(d).build(values)
        restored = exported.build(values)
        self.assertEqual(direct.lumped_elements, restored.lumped_elements)
        self.assertEqual(restored.ports[0]["R"], 50)
        self.assertEqual(restored.ports[0]["reference_impedance"], {"real":20,"imag":-150})
        sim, core = _read_design(exported, values, Path("rf_export.py"))
        self.assertEqual(core["components"], d["components"])
        self.assertEqual(core["parts"][0]["component"], "Assembly/Feed")
        del exported.FAIRBEAM_ORGANIZATION
        _, legacy = _read_design(exported, values, Path("rf_export.py"))
        self.assertNotIn("components", legacy)
        self.assertTrue(all("component" not in part for part in legacy["parts"]))
        self.assertEqual(core["resistors"][0]["topology"], "series")
        self.assertAlmostEqual(float(core["resistors"][0]["C"]), 1e-12)
        self.assertEqual(core["ports"][0]["reference_impedance"], {"real":20,"imag":-150})
        self.assertTrue(any(float(m.get("mu_r",1)) == 2 for m in core["materials"]))

    def test_permeability_mesh_and_user_library(self):
        from fairbeam.automesh import extract
        from fairbeam.usermaterials import clean_entry
        sim = Simulation(1e9,2e9)
        sim.dielectric("magnetic",4,mu_r=3).AddBox([0,0,0],[1,1,1])
        _, dielectrics, _ = extract(sim.csx)
        self.assertEqual(dielectrics[0].eps_r,12)
        entry, why = clean_entry({"id":"magnetic","name":"Magnetic","kind":"dielectric","eps_r":4,"mu_r":3})
        self.assertEqual(why,"")
        self.assertEqual(entry["mu_r"],3)
        self.assertIsNone(clean_entry({"id":"bad","name":"Bad","kind":"dielectric","eps_r":4,"mu_r":0})[0])

    def test_organization_matches_only_unique_existing_names(self):
        from fairbeam.organization import restore_organization
        module = types.SimpleNamespace(FAIRBEAM_ORGANIZATION={"components": ["Empty"], "parts": {"unique": "A", "duplicate": "B", "removed": "C"}})
        core = {"parts": [{"name": "unique"}, {"name": "duplicate"}, {"name": "duplicate"}, {"name": "new"}]}
        restore_organization(module, core)
        self.assertEqual(core["parts"][0]["component"], "A")
        self.assertTrue(all("component" not in part for part in core["parts"][1:]))
        module.FAIRBEAM_ORGANIZATION["components"] = ["/bad"]
        with self.assertRaises(ValueError): restore_organization(module, core)

    def test_full_python_import_retains_organization(self):
        from fairbeam.example_design import convert_example
        d = blank_design("folders", "Folders")
        d["far_field"]["enabled"] = False
        d["components"] = ["Assembly/Feed", "Empty/Folder"]
        d["parts"][0]["component"] = "Assembly/Feed"
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "folders.py"
            source.write_text(to_python(d), encoding="utf-8")
            result = convert_example(source, "folders", "Folders")
        restored = result
        self.assertEqual(restored["components"], d["components"])
        self.assertEqual(restored["parts"][0]["component"], "Assembly/Feed")

    def test_thin_metal_limit_uses_each_used_medium_wavelength(self):
        from fairbeam.design import C0, THIN_METAL_FRACTION, thin_metal_limit
        vacuum_limit = C0 / 3e9 * 1e3 / 20 / THIN_METAL_FRACTION
        design = {"simulation": {"f_max": 3}, "mesh": {"cells_per_wavelength": 20},
                  "parts": [{"material": "magnetic"}],
                  "materials": [{"name": "magnetic", "kind": "dielectric", "eps_r": 1, "mu_r": "mu"}]}
        magnetic_limit = thin_metal_limit(design, {"mu": 100})
        self.assertAlmostEqual(magnetic_limit, vacuum_limit / 10)
        # A 0.1 mm plate is resolvable under this policy: epsilon-only handling would flatten it.
        self.assertLess(magnetic_limit, 0.1)
        self.assertGreater(vacuum_limit, 0.1)
        design["materials"][0].pop("mu_r")
        self.assertAlmostEqual(thin_metal_limit(design, {}), vacuum_limit)
        # The densest medium is epsilon=25, mu=1. Independent maxima would incorrectly yield 400.
        design["materials"] = [
            {"name": "electric", "kind": "dielectric", "eps_r": 25, "mu_r": 1},
            {"name": "magnetic", "kind": "dielectric", "eps_r": 1, "mu_r": 16},
            {"name": "unused", "kind": "dielectric", "eps_r": 100, "mu_r": 100},
            {"name": "metal", "kind": "metal", "eps_r": 100, "mu_r": 100},
        ]
        design["parts"] += [{"material": "electric"}, {"material": "metal"}]
        self.assertAlmostEqual(thin_metal_limit(design, {}), vacuum_limit / 5)
        design["mesh"] = {"mode": "design", "overrides": {"cells_per_wavelength": 40}}
        self.assertAlmostEqual(thin_metal_limit(design, {}), vacuum_limit / 10)
        design["mesh"]["thin_metal"] = "volume"
        # "volume" keeps only plates at least 0.6 of the finest cell thick (6x the sheet limit); force gives the sheet limit
        from fairbeam.design import VOLUME_COST_FACTOR
        self.assertAlmostEqual(thin_metal_limit(design, {}), VOLUME_COST_FACTOR * vacuum_limit / 10)
        self.assertAlmostEqual(thin_metal_limit(design, {}, force=True), vacuum_limit / 10)

    def test_exported_transform_copies_use_property_provenance(self):
        import copy
        d = blank_design("copies", "Copies")
        d["far_field"]["enabled"] = False
        d["components"] = ["Main", "Literal"]
        d["parts"][0]["component"] = "Main"
        d["parts"][0]["transforms"] = [{"type": "rotate", "axis": "z", "center": [0,0,0], "angle": 45, "copies": 1}]
        literal = copy.deepcopy(d["parts"][0])
        literal.update(name="substrate [2]", component="Literal", transforms=[])
        d["parts"].append(literal)
        module = types.ModuleType("copies")
        exec(to_python(d), module.__dict__)
        values = {p.key:p.default for p in module.PARAMS}
        _, core = _read_design(module, values, Path("copies.py"))
        folders = {part["name"]:part.get("component") for part in core["parts"]}
        self.assertEqual(folders["substrate"], "Main")
        self.assertEqual(folders["substrate [2]"], "Main", "generated group must not use literal suffix-name metadata")
        self.assertEqual(folders["substrate [2] [2]"], "Literal", "collision-renamed literal part keeps its actual source folder")
        from fairbeam.example_design import convert_example
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "copies.py"
            source.write_text(to_python(d), encoding="utf-8")
            converted = convert_example(source, "copies", "Copies")
        self.assertEqual({part["name"]:part.get("component") for part in converted["parts"]}, folders)

    def test_duplicate_native_property_names_do_not_restore_folders(self):
        from fairbeam.organization import restore_organization
        module = types.SimpleNamespace(FAIRBEAM_ORGANIZATION={"parts": {"duplicate": "Folder"}})
        core = {"parts": [{"name":"duplicate"}, {"name":"duplicate [2]"}]}
        restore_organization(module, core, {"duplicate":"duplicate", "duplicate [2]":"duplicate"}, {"duplicate":2})
        self.assertTrue(all("component" not in part for part in core["parts"]))
