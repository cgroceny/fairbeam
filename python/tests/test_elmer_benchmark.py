"""External FEM adapter contracts; no native solver execution in this test suite."""
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fairbeam_elmer as fem


def samples():
    points = [0., 0., 0., .025, .025, .05, .05, .025, .1, .075, .025, .15, .1, .05, .2]
    field = []
    for x, y, z in zip(points[0::3], points[1::3], points[2::3]):
        field.extend([0., math.sin(math.pi*x/.1)*math.sin(math.pi*z/.2), 0.])
    return {"points": points, "elfield": field, "elfield Im": [0.] * len(field)}


def vtu(fields):
    blocks, arrays, offset = [], [], 0
    for name, values in fields.items():
        block = struct.pack('<I', len(values)*8) + struct.pack('<'+'d'*len(values), *values)
        label = '' if name == 'points' else f' Name="{name}"'
        arrays.append(f'<DataArray type="Float64"{label} NumberOfComponents="3" format="appended" offset="{offset}"/>')
        blocks.append(block)
        offset += len(block)
    head = ('<VTKFile byte_order="LittleEndian"><Piece NumberOfPoints="5">' + ''.join(arrays) + '</Piece><AppendedData encoding="raw">_').encode()
    return head + b''.join(blocks) + b'</AppendedData></VTKFile>'


class ElmerBenchmark(unittest.TestCase):
    def test_import_does_not_load_openems(self):
        script = 'import sys; import fairbeam_elmer; assert "openEMS" not in sys.modules; assert "fairbeam" not in sys.modules'
        subprocess.run([sys.executable, '-c', script], cwd=Path(__file__).resolve().parents[1], check=True)

    def test_unsupported_physics_geometry_and_mesh(self):
        for args in ((.025, fem.DIMENSIONS_M, 'driven'), (.025, (1., 1., 1.), 'pec_rectangular_cavity_benchmark'), (math.nan,), (.001,)):
            with self.subTest(args=args), self.assertRaises(ValueError):
                fem.validate_case(*args)

    def test_missing_executable_and_discovery_does_not_run(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(fem.subprocess, 'run') as launch:
            self.assertFalse(fem.capabilities(directory)['available'])
            with self.assertRaises(FileNotFoundError):
                fem.discover(directory)
            launch.assert_not_called()

    def test_opt_in_required_before_output_or_discovery(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)/'new'
            with self.assertRaisesRegex(ValueError, 'opt-in'):
                fem.run_cavity(out)
            self.assertFalse(out.exists())

    def test_exact_reference_and_wrong_field(self):
        expected = .5*math.sqrt(125)
        result = fem.assess([expected, expected*1.2], samples())
        self.assertEqual(result['status'], 'results_validated')
        self.assertAlmostEqual(result['frequency_hz'][0], 1675890788.0743763, delta=1e-6)
        wrong = samples()
        wrong['elfield'] = [1., 0., 0.] * 5
        self.assertEqual(fem.assess([expected, expected*1.2], wrong)['status'], 'validation_failed')
        self.assertEqual(fem.assess([expected*1.04, expected*1.2], samples())['status'], 'validation_failed')
        mixed = samples()
        mixed['elfield Im'] = [100., 0., 0.] * 5
        self.assertEqual(fem.assess([expected, expected*1.2], mixed)['status'], 'validation_failed')
        self.assertIsNone(result['s_parameters'])
        self.assertFalse(result['qualifies_driven_antenna'])

    def test_invalid_frequency_output(self):
        for frequencies in ([1.], [2., 1.], [math.nan, 7.], [0., 7.], [5., math.inf]):
            with self.subTest(frequencies=frequencies), self.assertRaises(ValueError):
                fem.assess(frequencies, samples())

    def test_invalid_field_coordinates(self):
        bad = samples()
        bad['points'][0] = 1.
        with self.assertRaises(ValueError):
            fem.assess([5.59, 7.1], bad)

    def test_raw_field_parser_and_truncated_nonfinite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'field.vtu'
            path.write_bytes(vtu(samples()))
            parsed = fem.read_mode(path)
            self.assertEqual(list(parsed['elfield']), samples()['elfield'])
            path.write_bytes(vtu(samples())[:-100])
            with self.assertRaises(ValueError):
                fem.read_mode(path)
            bad = samples()
            bad['elfield'][0] = math.nan
            path.write_bytes(vtu(bad))
            with self.assertRaisesRegex(ValueError, 'Non-finite'):
                fem.read_mode(path)

    def test_parser_rejects_unsupported_vtu(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'field.vtu'
            for data in (b'<VTKFile/>', vtu(samples()).replace(b'LittleEndian', b'BigEndian'), vtu(samples()).replace(b'<VTKFile ', b'<VTKFile compressor="zlib" ')):
                path.write_bytes(data)
                with self.assertRaises(ValueError):
                    fem.read_mode(path)

    def test_existing_run_directory_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(fem, 'discover', return_value=(Path(directory), Path(__file__), Path(__file__))):
            with self.assertRaises(FileExistsError):
                fem.run_cavity(directory, experimental=True)

    def test_failed_process_keeps_log_and_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process = subprocess.CompletedProcess([], 1, 'failed mesh')
            with patch.object(fem, 'discover', return_value=(root, Path(__file__), Path(__file__))), patch.object(fem.subprocess, 'run', return_value=process):
                with self.assertRaises(RuntimeError):
                    fem.run_cavity(root/'run', experimental=True)
            manifest = json.loads((root/'run/manifest.json').read_text())
            self.assertEqual(manifest['status'], 'failed')
            self.assertEqual((root/'run/mesh.log').read_text(), 'failed mesh')

    def test_timeout_keeps_partial_log(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            timeout = subprocess.TimeoutExpired([], 55, output=b'partial native output')
            with patch.object(fem, 'discover', return_value=(root, Path(__file__), Path(__file__))), patch.object(fem.subprocess, 'run', side_effect=timeout):
                with self.assertRaisesRegex(RuntimeError, '55 second'):
                    fem.run_cavity(root/'run', experimental=True)
            self.assertEqual((root/'run/mesh.log').read_text(), 'partial native output')
            self.assertEqual(json.loads((root/'run/manifest.json').read_text())['status'], 'failed')


if __name__ == '__main__':
    unittest.main()
