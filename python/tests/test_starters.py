"""The Start screen's starting points (design.TEMPLATES, fairbeam.starters): every one builds and
passes the design checks without errors or warnings, at its defaults and across its tuning ranges,
with the shared defaults (PML 8, auto mesh, -60 dB, far field for the antennas, tan δ at f0); the
list in src/designer/templates.ts has the same keys; the run server creates each one."""

import http.client
import json
import re
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.design import TEMPLATES, check_design, evaluate, module_for, resolve_names, template_design  # noqa: E402
from fairbeam.design_checks import lint  # noqa: E402
from fairbeam.jobs import JobManager  # noqa: E402
from fairbeam.preview import build_preview  # noqa: E402
from fairbeam.server import App, make_server  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
STARTERS = ("dipole", "monopole", "open-waveguide", "sleeve-dipole", "microstrip")


def problems(d, values=None, bundle=None):
    return [f"{c['severity']} {c['code']} {c.get('path', '')}: {c['message']}"
            for c in lint(d, values, bundle) if c["severity"] in ("error", "warning")]


def values_of(d, **over):
    return resolve_names(d, {**{p["key"]: p["default"] for p in d["params"] if "default" in p}, **over})


class Starters(unittest.TestCase):
    def test_keys_match_the_start_screen(self):
        ts = (REPO / "src" / "designer" / "templates.ts").read_text(encoding="utf-8")
        keys = re.findall(r'\{ key: "([a-z-]+)"', ts)
        self.assertEqual(sorted(keys), sorted(TEMPLATES))
        self.assertEqual(set(STARTERS) | {"empty", "patch"}, set(TEMPLATES))

    def test_clean_at_the_defaults(self):
        for key in TEMPLATES:
            with self.subTest(key):
                d = template_design(key, f"t-{key}", "T")
                check_design(d)
                self.assertEqual(d["model"]["id"], f"t-{key}")
                if key == "empty":
                    continue
                self.assertTrue(d["model"]["description"])
                bundle = build_preview(None, {}, design=d)["bundle"]
                self.assertEqual(problems(d, None, bundle), [])
                self.assertTrue(module_for(d).MODEL["id"])

    def test_shared_defaults(self):
        for key in STARTERS:
            with self.subTest(key):
                d = template_design(key, "t", "T")
                s = d["simulation"]
                self.assertEqual(s["boundaries"], "PML_8")
                self.assertEqual(s["end_criteria_db"], -60)
                self.assertEqual(d["mesh"]["mode"], "auto")
                self.assertIn("f0", {p["key"] for p in d["params"]})
                # far field for the antennas; a line is not meant to radiate
                self.assertEqual(d["far_field"]["enabled"], key != "microstrip")
                for mt in d["materials"]:
                    if mt["kind"] == "dielectric":
                        self.assertEqual(mt["tan_d_freq"], "f0")

    def test_sizes_follow_f0(self):
        # the dipole and the monopole scale with the design frequency and stay clean
        for key, name in (("dipole", "L"), ("monopole", "H")):
            d = template_design(key, "t", "T")
            with self.subTest(key):
                self.assertAlmostEqual(values_of(d)[name] * 2, values_of(d, f0=1.2)[name], places=6)
                for f0 in (0.9, 5.8):
                    self.assertEqual(problems(d, {"f0": f0}), [])
        # the dipole's default is about 0.466 λ tip to tip at 2.4 GHz (docs/VALIDATION.md)
        self.assertAlmostEqual(values_of(template_design("dipole", "t", "T"))["L"], 58.2, places=1)

    def test_tuning_ranges_stay_clean(self):
        cases = {
            "dipole": ({"k": 0.4}, {"k": 0.55}, {"w": 3.0}, {"g": 3.0}),
            "monopole": ({"k": 0.2}, {"kg": 0.5}, {"kg": 2.0}, {"w": 3.0, "g": 2.0}),
            "microstrip": ({"l": 10.0}, {"l": 100.0}, {"w": 1.0}, {"h": 0.8, "w": 1.5}, {"eps_r": 3.38, "w": 3.6}),
            "open-waveguide": ({"l": 30.0}, {"l": 100.0}, {"a": 40.0, "b": 20.0, "f0": 5.0}),
            "sleeve-dipole": ({"l_up": 60.0, "l_sl": 75.0}, {"g": 1.0}),
        }
        for key, sets in cases.items():
            d = template_design(key, "t", "T")
            for values in sets:
                with self.subTest(key=key, values=values):
                    self.assertEqual(problems(d, values), [])

    def test_microstrip_is_fifty_ohm(self):
        # the Hammerstad estimate the parameters show, and two ports at the line ends
        d = template_design("microstrip", "t", "T")
        v = values_of(d)
        self.assertAlmostEqual(v["Z0"], 50.0, delta=1.0)
        self.assertEqual([p["number"] for p in d["ports"]], [1, 2])
        mod = module_for(d)
        sim = mod.build({p["key"]: p["default"] for p in d["params"] if "default" in p})
        self.assertEqual(len(sim.ports), 2)

    def test_open_waveguide_band_is_above_cutoff(self):
        d = template_design("open-waveguide", "t", "T")
        v = values_of(d)
        self.assertAlmostEqual(v["fc"], 6.557, places=2)
        self.assertGreater(evaluate(d["simulation"]["f_min"], v), v["fc"] * 1.15)
        # the excitation a quarter guide wavelength in front of the short, the probes inside the guide
        self.assertAlmostEqual(v["zp"], v["lam_g"] / 4)
        self.assertLess(v["zp"] + 5, v["l"] - 20)

    def test_sleeve_dipole_is_the_example(self):
        # the template is the example design, parametrised the same way (only the model block and
        # the shortened description differ)
        ex = json.loads((REPO / "examples" / "designs" / "sleeve_dipole_867.design.json").read_text(encoding="utf-8"))
        d = template_design("sleeve-dipole", "sleeve", "Sleeve")
        self.assertTrue(d["mesh"]["refine_features"])
        ex["mesh"]["refine_features"] = True  # New starters opt in; saved examples retain their mesh.
        for k in ex:
            if k != "model":
                with self.subTest(k):
                    self.assertEqual(d[k], ex[k])
        self.assertEqual(set(d), set(ex))


class StartersApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        (root / "models").mkdir()
        (root / "projects").mkdir()
        manager = JobManager(root / "jobs", root / "projects", command_factory=lambda job: [sys.executable, "-c", "pass"])
        cls.app = App(models_dir=root / "models", projects_dir=root / "projects", jobs_dir=root / "jobs",
                      templates_dir=REPO / "python" / "templates", manager=manager)
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
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        h = {"Host": f"127.0.0.1:{self.port}", "Content-Type": "application/json"}
        conn.request(method, path, body=json.dumps(body).encode() if body is not None else None, headers=h)
        r = conn.getresponse()
        payload = json.loads(r.read() or b"null")
        conn.close()
        return r.status, payload

    def test_create_each_starter(self):
        for key in STARTERS:
            with self.subTest(key):
                mid = "s_" + key.replace("-", "_")
                st, body = self.request("POST", "/api/designs", {"id": mid, "name": f"My {key}", "template": key})
                self.assertEqual(st, 201, body)
                self.assertEqual(body["design"]["model"]["name"], f"My {key}")
                self.assertEqual(body["design"]["model"]["id"], mid.replace("_", "-"))
                self.assertEqual([c for c in body["validation"]["checks"] if c["severity"] in ("error", "warning")], [])


if __name__ == "__main__":
    unittest.main()
