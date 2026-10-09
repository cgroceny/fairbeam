import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from qualify import delta, summarize


def wave(folder, reflection=0.):
    folder.mkdir(parents=True, exist_ok=True)
    np.savez(folder / "complex.npz", frequency_hz=[1e9, 2e9], s11=[reflection, 0.], s21=[1., 1.])


def fixture(root):
    folders = {k: root / k for k in ("uniform", "uniform-translation", "pec", "metal-translation", "baseline")}
    row = {"analytic_max_complex_error": 0., "empty_reference_max_reflection": 0.,
           "power_max": 1., "energy_converged": True}
    for kind, directory in folders.items():
        directory.mkdir()
        (directory / "summary.json").write_text(json.dumps([row]))
        if kind == "baseline":
            for build in ("candidate", "baseline"):
                for role in ("reference", "sample"):
                    path = directory / build / role
                    path.mkdir(parents=True)
                    np.savetxt(path / "avg_0", [[0., 1.], [1., 0.]])
            continue
        for c in (20, 30, 40):
            if kind in ("uniform", "pec"):
                case = directory / f"{'slab' if kind == 'uniform' else 'pec'}-{c}"
                wave(case)
                (case / "summary.json").write_text(json.dumps(row))
            else:
                for shift in ("0", "5.33333"):
                    wave(directory / f"{'inclusion' if kind == 'uniform-translation' else 'metal'}-{c}-shift{shift}")
    return folders


class QualificationTests(unittest.TestCase):
    def test_translation_failure_is_retained_as_failed_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            folders = fixture(Path(tmp))
            self.assertTrue(all(summarize(folders, {"case": {"pass": True}})["gates"].values()))
            wave(folders["uniform-translation"] / "inclusion-30-shift5.33333", .003342)
            result = summarize(folders, {"case": {"pass": True}})
            self.assertFalse(result["gates"]["translation_including_box_face_ties"])
            self.assertEqual(result["status"], "research gate failed")

    def test_missing_guards_cannot_be_vacuously_successful(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = summarize(fixture(Path(tmp)), {})
            self.assertFalse(result["gates"]["unsupported_inputs_rejected"])

    def test_nonfinite_waves_fail_instead_of_passing_maximum(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp) / "a", Path(tmp) / "b"
            wave(a); wave(b, float("nan"))
            with self.assertRaisesRegex(ValueError, "Nonfinite"):
                delta(a, b)


if __name__ == "__main__":
    unittest.main()
