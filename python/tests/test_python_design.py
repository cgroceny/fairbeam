"""The Python panel's Apply: a model script becomes a design without running the solver, a failure
names its line, a slow script is stopped, and the endpoint says the same over HTTP."""

import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from fairbeam.design import DesignError, blank_design, check_design, module_for, to_python  # noqa: E402
from fairbeam.geometry import read_structure  # noqa: E402
from fairbeam.jobs import JobManager  # noqa: E402
from fairbeam import modelfiles  # noqa: E402
from fairbeam.server import ApiError  # noqa: E402
from fairbeam.python_design import ScriptError, apply_script, convert_script  # noqa: E402
from fairbeam.server import App, make_server  # noqa: E402

SOURCE = to_python(blank_design("p", "P"))


def geometry(design):
    return json.dumps(design["parts"], sort_keys=True)


class ConvertScript(unittest.TestCase):
    def test_a_script_becomes_a_design_and_an_edit_changes_it(self):
        base = apply_script(SOURCE)
        self.assertEqual(base["design"]["schema"], "fairbeam.design/1")
        self.assertTrue(base["design"]["parts"] and base["design"]["ports"])
        self.assertFalse(base["normalized"])  # the regenerated script builds the same design
        self.assertIn("MODEL", base["python"])
        self.assertIn("'W'", SOURCE)
        edited = SOURCE.replace("Param('W', 32.0", "Param('W', 40.0")
        self.assertNotEqual(edited, SOURCE)
        self.assertIn('"W/2"', geometry(base["design"]))  # the converter's expressions over the parameters
        self.assertEqual(next(p["default"] for p in apply_script(edited)["design"]["params"] if p["key"] == "W"), 40.0)
        # a coordinate edited to a number changes the geometry itself
        moved = SOURCE.replace("p['W'] / 2", "25")
        self.assertNotEqual(moved, SOURCE)
        self.assertNotEqual(geometry(apply_script(moved)["design"]), geometry(base["design"]))

    def test_an_error_names_the_line(self):
        lines = SOURCE.splitlines()
        i = next(n for n, s in enumerate(lines) if s.startswith("def build"))
        lines.insert(i + 1, "    raise ValueError('bad dimension')")
        with self.assertRaises(ScriptError) as ctx:
            convert_script("\n".join(lines) + "\n")
        self.assertEqual(ctx.exception.line, i + 2)
        self.assertIn("bad dimension", ctx.exception.message)
        with self.assertRaises(ScriptError) as ctx:
            convert_script("MODEL = {}\nPARAMS = [\nx = (\n")
        self.assertEqual(ctx.exception.line, 3)
        self.assertIn("SyntaxError", ctx.exception.message)
        with self.assertRaises(ScriptError) as ctx:
            convert_script("import sys\nsys.exit(3)\n")
        self.assertIn("SystemExit", ctx.exception.message)
        with self.assertRaises(ScriptError):
            convert_script("   \n")

    def test_the_solver_is_never_run(self):
        script = SOURCE + "\nfrom openEMS import openEMS\nopenEMS().Run('x')\n"
        with self.assertRaises(ScriptError) as ctx:
            convert_script(script)
        self.assertIn("solver is not run", ctx.exception.message)
        self.assertEqual(ctx.exception.line, len(script.splitlines()))

    def test_direct_conducting_sheet_keeps_its_finite_metal_values(self):
        sim_line = next(line for line in SOURCE.splitlines() if line.startswith("    sim = Simulation("))
        sheet = (
            sim_line + "\n"
            "    copper = sim.csx.AddConductingSheet('copper', conductivity=5.8e7, thickness=35e-6)\n"
            "    copper.AddBox(priority=10, start=[-8, -4, 2], stop=[8, 4, 2])"
        )
        source = SOURCE.replace(sim_line, sheet, 1)

        result = apply_script(source)
        metal = next(m for m in result["design"]["materials"] if m.get("conductivity"))
        self.assertEqual(metal["kind"], "metal")
        self.assertAlmostEqual(float(metal["conductivity"]), 5.8e7)
        self.assertAlmostEqual(float(metal["thickness"]), 0.035)
        self.assertFalse(result["normalized"])

        rebuilt = module_for(result["design"]).build({p["key"]: p["default"] for p in result["design"]["params"]})
        copper = next(p for p in read_structure(rebuilt.csx, rebuilt.materials, rebuilt.unit)[0] if p["name"] == "copper")
        self.assertEqual(copper["type"], "ConductingSheet")
        self.assertAlmostEqual(copper["conductor"]["conductivity"], 5.8e7)
        self.assertAlmostEqual(copper["conductor"]["thickness"], 0.035)
        # GetThickness is SI metres. The exported design stores thickness in its own geometry
        # unit, so changing the simulation's length unit changes only that displayed value.
        for length_unit, expected in ((1.0, 35e-6), (0.01, 0.0035)):
            with self.subTest(length_unit=length_unit):
                parts, _, _ = read_structure(rebuilt.csx, rebuilt.materials, length_unit)
                item = next(p for p in parts if p["name"] == "copper")
                self.assertAlmostEqual(item["conductor"]["thickness"], expected)

    def test_a_slow_script_is_stopped(self):
        with self.assertRaises(ScriptError) as ctx:
            convert_script("import time\ntime.sleep(60)\n", timeout=1.5)
        self.assertTrue(ctx.exception.timeout)


class Endpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        (root / "projects").mkdir()
        manager = JobManager(root / "jobs", root / "projects", grace_s=1.0, command_factory=lambda job: [sys.executable, "-c", ""])
        cls.app = App(models_dir=HERE.parent / "models", projects_dir=root / "projects", jobs_dir=root / "jobs",
                      manager=manager, heartbeat_s=0.2)
        cls.srv = make_server(cls.app, "127.0.0.1", 0, quiet=True)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stopping = True
        cls.srv.shutdown()
        cls.app.close()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def post(self, body):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        conn.request("POST", "/api/design/from-python", body=json.dumps(body).encode(),
                     headers={"Host": f"127.0.0.1:{self.port}", "Content-Type": "application/json"})
        r = conn.getresponse()
        payload = json.loads(r.read() or b"null")
        conn.close()
        return r.status, payload

    def test_converts_a_script_and_reports_an_error_line(self):
        status, body = self.post({"source": SOURCE})
        self.assertEqual(status, 200)
        self.assertEqual(body["design"]["schema"], "fairbeam.design/1")
        self.assertFalse(body["normalized"])
        self.assertIn("PARAMS", body["python"])
        status, body = self.post({"source": SOURCE, "model": {"id": "mine", "name": "My patch"}})
        self.assertEqual(status, 200)
        self.assertIn("My patch", body["python"])
        status, _ = self.post({"source": SOURCE, "model": {"id": 3}})
        self.assertEqual(status, 422)
        status, body = self.post({"source": "x = 1\ny = 1 / 0\n"})
        self.assertEqual(status, 422)
        self.assertEqual(body["line"], 2)
        self.assertIn("ZeroDivisionError", body["error"])
        status, body = self.post({"source": "MODEL = {}\nPARAMS = []\nraise KeyError('k')\n"})
        self.assertEqual((status, body["line"]), (422, 3))
        status, body = self.post({"source": 3})
        self.assertEqual(status, 422)


class CreatePythonDesign(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.models = self.root / "models"
        self.projects = self.root / "projects"
        self.jobs = self.root / "jobs"
        self.models.mkdir()
        self.projects.mkdir()
        self.jobs.mkdir()
        modelfiles.create_model(self.models, "source_model", SOURCE, "Source model")
        self.original_source = modelfiles.read_model(self.models, "source_model")["source"]
        manager = JobManager(self.jobs, self.projects, grace_s=1.0,
                             command_factory=lambda job: [sys.executable, "-c", ""])
        self.app = App(models_dir=self.models, projects_dir=self.projects, jobs_dir=self.jobs, manager=manager,
                       heartbeat_s=0.2, templates_dir=self.root / "templates", history_dir=self.root / "history")

    def tearDown(self):
        self.app.close()
        self.tmp.cleanup()

    def test_creation_is_atomic_and_keeps_a_link_to_editable_source(self):
        result = self.app.create_design({
            "id": "source_design",
            "name": "Source model",
            "python": {"source_model": "source_model", "model": {"id": "source_model", "name": "Source model"}},
        })
        design = modelfiles.read_design_file(self.models, "source_design")["design"]
        source = modelfiles.read_model(self.models, "source_model")
        self.assertEqual(result["id"], "source_design")
        self.assertEqual(design["python_source_model"], "source_model")
        self.assertEqual(design["python_source_hash"], source["hash"])
        self.assertEqual(source["source"], self.original_source)
        self.assertEqual(design["model"]["name"], "Source model")

    def test_conversion_failure_does_not_leave_an_empty_design(self):
        broken = "MODEL = {'id': 'broken', 'name': 'Broken'}\nPARAMS = []\ndef build(p):\n    raise ValueError('bad model')\n"
        modelfiles.create_model(self.models, "broken_model", broken, "Broken")
        with self.assertRaises(ApiError) as ctx:
            self.app.create_design({"id": "broken_design", "python": {"source_model": "broken_model"}})
        self.assertEqual(ctx.exception.status, 422)
        self.assertFalse(modelfiles.design_path(self.models, "broken_design").exists())

    def test_model_list_reports_the_design_link_for_reuse(self):
        self.app.create_design({"id": "source_design", "python": {"source_model": "source_model"}})
        entries = self.app.models()["models"]
        linked = next(m for m in entries if m["key"] == "source_design")
        self.assertEqual(linked["python_source_model"], "source_model")

    def test_design_link_metadata_is_validated(self):
        for field, value in (("python_source_model", "../source"), ("python_source_hash", "bad")):
            design = blank_design("linked", "Linked")
            design["python_source_model"] = "source_model"
            design["python_source_hash"] = "0" * 64
            design[field] = value
            with self.subTest(field=field), self.assertRaises(DesignError):
                check_design(design)

if __name__ == "__main__":
    unittest.main()
