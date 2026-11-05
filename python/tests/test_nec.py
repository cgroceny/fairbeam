"""NEC admission, card semantics, output refusal, and owned-process controls.

No installed solver is required by ordinary discovery. The native validation
cohort is an explicit developer check documented in docs/NEC.md.
"""
import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from fairbeam import nec


def model():
    return nec.dipole(500, 0.05, 31, [0.29, 0.30, 0.31])


def output():
    return """FREQUENCY= 3.0000E+02 MHZ
----- ANTENNA INPUT PARAMETERS -----
 TAG SEG VOLTAGE CURRENT IMPEDANCE ADMITTANCE POWER
 1 16 1.0000E+00 0.0000E+00 1.0000E-02 -1.0000E-02 5.0000E+01 5.0000E+01 1.0000E-02 -1.0000E-02 5.0000E-03

"""


class NecAdmission(unittest.TestCase):
    def test_wire_connectivity_and_overlap(self):
        good = model()
        good['wires'].append({**good['wires'][0], 'tag': 2, 'start_mm': [0, 0, 250], 'end_mm': [0, 0, 750]})
        nec.validate(good)  # exactly joined equal-radius wires
        for end in ([0, 0, 0], [0, 0, -250]):
            bad = copy.deepcopy(good)
            bad['wires'][1]['end_mm'] = end
            with self.assertRaisesRegex(ValueError, 'overlap'):
                nec.validate(bad)
        for start, end in [([-250, 0, 0], [250, 0, 0]), ([0.05, 0, -250], [0.05, 0, 250])]:
            bad = copy.deepcopy(good)
            bad['wires'][1].update(start_mm=start, end_mm=end)
            with self.assertRaisesRegex(ValueError, 'touch or intersect'):
                nec.validate(bad)
        bad['wires'][1].update(start_mm=[10, 0, -250], end_mm=[10, 0, 250])
        nec.validate(bad)  # separated parasitic wire is permitted

    def test_pattern_null_poles_and_complete_angular_grid(self):
        lines = []
        for phi in range(0, 361, 10):
            for theta in range(0, 181, 10):
                if theta in (0, 180):
                    lines.append(f'{theta} {phi} -999.99 -999.99 -999.99 0 0  0 0 0 0')
                else:
                    lines.append(f'{theta} {phi} 2.15 -999.99 2.15 0 0 LINEAR 0.6 58 0 0')
        text = output() + 'RADIATION PATTERNS\n' + '\n'.join(lines)
        result = nec.parse_output(text, model(), .3, pattern=True)
        self.assertEqual(len(result['pattern']), 703)
        self.assertEqual(result['sampled_peak_gain_dbi'], 2.15)
        self.assertIsNone(result['pattern'][0]['gain_dbi'])
        for broken in [text + '\n' + lines[0], text.rsplit('\n', 1)[0]]:
            with self.assertRaisesRegex(ValueError, 'incomplete|duplicate'):
                nec.parse_output(broken, model(), .3, pattern=True)

    def test_optimizer_uses_actual_metrics_and_refuses_failed_candidates(self):
        with tempfile.TemporaryDirectory() as root:
            def evaluate(m, directory, executable, **kwargs):
                self.assertEqual(m['reference_ohm'], 50)
                self.assertLessEqual(kwargs['timeout'], 30)
                return {'samples': [{'s11': [.1, 0]}], 'wall_time_s': .02}
            with patch.object(nec, 'solve', side_effect=evaluate) as run:
                result = nec.optimize_dipole((450, 520), .05, 61, .3, Path(root)/'ok', Path('fake'))
            self.assertEqual(run.call_count, 1)
            self.assertEqual(result['result']['reason'], 'goals met')
            self.assertEqual(result['result']['best']['metrics']['s11_at']['0.3'], -20)
            with patch.object(nec, 'solve', side_effect=ValueError('incomplete output')) as run:
                result = nec.optimize_dipole((450, 520), .05, 61, .3, Path(root)/'bad', Path('fake'), max_evals=2)
            self.assertEqual(run.call_count, 2)
            self.assertEqual(result['state'], 'failed')
            self.assertIsNone(result['result']['best'])
            self.assertTrue(all('incomplete output' in e['error'] for e in result['evaluations']))

    def test_solver_version_failure_retains_failed_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'capture'
            def fake_run(command, directory, log, *args, **kwargs):
                log.write_text('unknown solver 9.9')
            with patch.object(nec, '_execute', side_effect=fake_run), self.assertRaisesRegex(ValueError, 'version'):
                nec.solve(model(), path, Path(sys.executable))
            receipt = json.loads((path/'run.json').read_text())
            self.assertEqual(receipt['state'], 'failed')
            self.assertEqual(receipt['samples'], [])
            self.assertTrue((path/'model.nec').exists())

    def test_units_feed_and_frequency_cards(self):
        text = nec.deck(model())
        self.assertIn("GW 1 31 0 0 -0.25 0 0 0.25 5e-05\n", text)
        self.assertIn("EX 0 1 16 0 1 0\n", text)
        self.assertIn("GN -1\n", text)
        self.assertEqual([line for line in text.splitlines() if line.startswith("FR ")],
                         ["FR 0 1 0 0 290 0", "FR 0 1 0 0 300 0", "FR 0 1 0 0 310 0"])
        self.assertEqual(text.count("XQ 0"), 3)

    def test_pattern_request_is_explicit(self):
        self.assertNotIn("RP ", nec.deck(model()))
        self.assertEqual(nec.deck(model(), pattern=True).count("RP 0 19 37 1000 0 0 10 10 0 0"), 3)

    def test_unsupported_physics_and_general_design_refused(self):
        for key in ("substrate", "ground", "ports", "loads", "transforms", "booleanHistory"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                nec.validate({**model(), key: []})
        with self.assertRaises(ValueError):
            nec.validate({"schema": "fairbeam.design/1", "parts": []})

    def test_invalid_wire_dimensions_and_discretization(self):
        for length, radius, segments in [(0, .05, 31), (500, 0, 31), (500, -1, 31),
                                         (500, .05, 30), (500, .05, 1), (500, 10, 31),
                                         (500, .05, 401), (500, .05, True), (float('inf'), .05, 31)]:
            with self.subTest(values=(length, radius, segments)), self.assertRaises(ValueError):
                nec.dipole(length, radius, segments, [.3])
        with self.assertRaisesRegex(ValueError, "wavelength"):
            nec.dipole(500, .05, 3, [.3])

    def test_frequency_and_reference_admission(self):
        for values in [[], [.3, .3], [.3, .2], [0], [float('nan')], [True], [1e9], [.3] * 82]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                nec.dipole(500, .05, 31, values)
        for reference in [0, -1, float('inf'), True]:
            with self.assertRaises(ValueError):
                nec.dipole(500, .05, 31, [.3], reference)

    def test_feed_and_duplicate_tags(self):
        for field, value in [("tag", 2), ("tag", 1.0), ("segment", 0), ("segment", 32)]:
            bad = model()
            bad['feed'][field] = value
            with self.assertRaises(ValueError):
                nec.validate(bad)
        bad = model()
        bad['wires'] *= 2
        with self.assertRaisesRegex(ValueError, "unique"):
            nec.validate(bad)

    def test_export_manifest_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'new'
            original = model()
            before = copy.deepcopy(original)
            nec.export(original, path)
            self.assertEqual(original, before)
            receipt = json.loads((path / 'manifest.json').read_text())
            self.assertFalse(receipt['solver_run'])
            self.assertFalse(receipt['numerically_validated'])
            self.assertEqual(receipt['source'], 'applied-field voltage, 1 V real')
            data = (path / 'model.nec').read_bytes()
            self.assertEqual(receipt['deck_sha256'], nec.hashlib.sha256(data).hexdigest())
            with self.assertRaises(FileExistsError):
                nec.export(original, path)
            self.assertEqual((path / 'model.nec').read_bytes(), data)

    def test_parse_impedance_and_reflection(self):
        value = nec.parse_output(output(), model(), .3)
        self.assertEqual(value['impedance_ohm'], [50., 50.])
        self.assertAlmostEqual(value['s11'][0], .2)
        self.assertAlmostEqual(value['s11'][1], .4)
        self.assertEqual(value['frequency_hz'], 3e8)

    def test_output_errors_and_identity_refused(self):
        for text in ["", output() * 2, output().replace('3.0000E+02', '4.0000E+02'),
                     output().replace(' 1 16 ', ' 1 15 '), output().replace(' 1 16 ', ' 2 16 '),
                     output().replace('5.0000E+01', 'NaN'), output() + ' ERROR bad geometry',
                     output().replace('1.0000E-02 -1.0000E-02 5.0000E+01', '2.0000E-02 -1.0000E-02 5.0000E+01')]:
            with self.subTest(text=text[:60]), self.assertRaises(ValueError):
                nec.parse_output(text, model(), .3)

    def test_requested_pattern_cannot_be_missing(self):
        with self.assertRaisesRegex(ValueError, "pattern"):
            nec.parse_output(output(), model(), .3, pattern=True)

    def test_process_failure_timeout_and_cancellation(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            with self.assertRaisesRegex(RuntimeError, 'status 7'):
                nec._execute([sys.executable, '-c', 'raise SystemExit(7)'], directory,
                             directory / 'failure.log', time.monotonic() + 5)
            with self.assertRaises(TimeoutError):
                nec._execute([sys.executable, '-c', 'import time; time.sleep(30)'], directory,
                             directory / 'timeout.log', time.monotonic() + .2)
            with self.assertRaises(InterruptedError):
                nec._execute([sys.executable, '-c', 'import time; time.sleep(30)'], directory,
                             directory / 'cancel.log', time.monotonic() + 5, lambda: True)


if __name__ == '__main__':
    unittest.main()
