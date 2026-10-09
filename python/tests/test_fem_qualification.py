"""Solver-free checks for the bounded Elmer dielectric eigenmode qualification."""

import json
import hashlib
import math
import re
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.fem_qualification import (  # noqa: E402
    C0,
    DIMENSIONS_M,
    EPS_R_VALUES,
    MESH_SIZES_MM,
    FEMQualificationError,
    _case_key,
    _run_solver,
    analytic_frequency_per_m,
    assess_case,
    assess_study,
    prepare_study,
    read_mode,
    run_study,
    validate_mode_coverage,
)


def synthetic_mode():
    a, b, d = DIMENSIONS_M
    points = (0.0, 0.0, 0.0, a / 2, b / 2, d / 2, a, b, d)
    return {
        "points": points,
        "elfield": (0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0),
        "elfield Im": (0.0,) * 9,
    }


def write_raw_vtu(path, fields):
    arrays = [("points", fields["points"]), ("elfield", fields["elfield"]),
              ("elfield Im", fields["elfield Im"])]
    xml_arrays = []
    appended = bytearray(b"_")
    for name, values in arrays:
        offset = len(appended) - 1
        name_attribute = "" if name == "points" else f' Name="{name}"'
        xml_arrays.append(
            f'<DataArray type="Float64"{name_attribute} NumberOfComponents="3" '
            f'format="appended" offset="{offset}"/>'
        )
        payload = struct.pack("<" + "d" * len(values), *values)
        appended.extend(struct.pack("<I", len(payload)))
        appended.extend(payload)
    header = (
        '<VTKFile type="UnstructuredGrid" byte_order="LittleEndian">'
        '<UnstructuredGrid><Piece NumberOfPoints="3">'
        f'<Points>{xml_arrays[0]}</Points>'
        f'<PointData>{xml_arrays[1]}{xml_arrays[2]}</PointData>'
        '</Piece></UnstructuredGrid><AppendedData encoding="raw">'
    ).encode("utf-8")
    path.write_bytes(header + bytes(appended) + b"</AppendedData></VTKFile>")


class AnalyticReference(unittest.TestCase):
    def test_eps_four_halves_the_exact_homogeneous_cavity_frequency(self):
        vacuum = analytic_frequency_per_m(1.0)
        dielectric = analytic_frequency_per_m(4.0)
        self.assertEqual(dielectric / vacuum, 0.5)
        self.assertGreater(vacuum * C0, 1e9)
        with self.assertRaisesRegex(ValueError, "eps_r"):
            analytic_frequency_per_m(10 ** 5000)

    def test_case_assessment_checks_analytic_frequency_and_te101_shape(self):
        expected = analytic_frequency_per_m(4.0)
        result = assess_case([expected, expected * 1.6], synthetic_mode(), 4.0, 12.5)
        self.assertEqual(result["status"], "case_validated")
        self.assertAlmostEqual(result["relative_frequency_error"], 0.0)
        self.assertAlmostEqual(result["complex_field_shape_correlation"], 1.0)
        self.assertFalse(result["qualifies_driven_antenna"])

    def test_assessment_rejects_bad_frequencies_and_outside_coordinates(self):
        with self.assertRaisesRegex(FEMQualificationError, "strictly increasing"):
            assess_case([2.0, 1.0], synthetic_mode(), 1.0, 25.0)
        bad_mode = synthetic_mode()
        bad_mode["points"] = (0.0, 0.0, 0.0, 0.05, 0.025, 0.1, 0.1, 0.05, 0.201)
        with self.assertRaisesRegex(FEMQualificationError, "outside"):
            assess_case([analytic_frequency_per_m(1.0), 10.0], bad_mode, 1.0, 25.0)


class PreparedStudy(unittest.TestCase):
    def test_prepare_writes_four_small_cases_with_explicit_active_body_mapping(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "dielectric-study"
            manifest = prepare_study(root)
            self.assertEqual(manifest["status"], "inputs_ready")
            self.assertFalse(manifest["solver_executed"])
            self.assertEqual(len(manifest["case_order"]), 4)
            self.assertEqual(set(manifest["eps_r_values"]), set(EPS_R_VALUES))
            self.assertIn("design.py", manifest["source_provenance"]["source_files"])
            self.assertIn("fem_geometry.py", manifest["source_provenance"]["source_files"])
            self.assertIn("fem_qualification.py", manifest["source_provenance"]["source_files"])
            for eps_r in EPS_R_VALUES:
                for mesh_size_mm in MESH_SIZES_MM:
                    name = _case_key(eps_r, mesh_size_mm)
                    case = root / name
                    case_manifest = json.loads((case / "manifest.json").read_text(encoding="utf-8"))
                    self.assertEqual(case_manifest["active_body_ids"], [2])
                    self.assertEqual(case_manifest["body_material_map"], {"2": 1})
                    self.assertEqual(case_manifest["sif_body_records"], [{
                        "sif_body_id": 1, "target_mesh_body_ids": [2],
                        "equation_id": 1, "material_id": 1,
                    }])
                    self.assertEqual(case_manifest["mesh_summary"]["regions"][0]["element_count"], 0)
                    self.assertEqual(case_manifest["mesh_summary"]["regions"][1]["element_count"],
                                     64 if mesh_size_mm == 25 else 512)
                    element_records = [line.split() for line in
                                       (case / "mesh" / "mesh.elements").read_text(encoding="ascii").splitlines()]
                    self.assertTrue(element_records)
                    self.assertEqual({int(record[1]) for record in element_records}, {2})
                    sif = (case / "case.sif").read_text(encoding="ascii")
                    body_match = re.search(r"(?ms)^Body 1\s*(.*?)^End\s*$", sif)
                    material_match = re.search(r"(?ms)^Material 1\s*(.*?)^End\s*$", sif)
                    equation_match = re.search(r"(?ms)^Equation 1\s*(.*?)^End\s*$", sif)
                    self.assertIsNotNone(body_match)
                    self.assertIsNotNone(material_match)
                    self.assertIsNotNone(equation_match)
                    self.assertIn("Target Bodies(1) = 2", body_match[1])
                    self.assertIn("Material = 1", body_match[1])
                    self.assertNotIn("Target Bodies", equation_match[1])
                    self.assertNotIn("Body 2", sif)
                    self.assertIn(f"Relative Permittivity = {int(eps_r)}", material_match[1])
                    expected_shift = 1500 / eps_r
                    self.assertIn(f"Eigen System Shift = Real {expected_shift:g}", sif)
                    mesh_file = case / "mesh" / "mesh.elements"
                    self.assertEqual(case_manifest["input_sha256"]["mesh/mesh.elements"],
                                     hashlib.sha256(mesh_file.read_bytes()).hexdigest())

    def test_prepare_refuses_an_existing_output_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "existing"
            root.mkdir()
            with self.assertRaises(FileExistsError):
                prepare_study(root)

    def test_run_requires_explicit_opt_in_before_creating_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "never-created"
            with self.assertRaisesRegex(ValueError, "--experimental"):
                run_study(root)
            self.assertFalse(root.exists())

    def test_launch_failure_does_not_record_solver_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            solver = directory / "ElmerSolver.exe"
            solver.write_bytes(b"synthetic solver identifier; never executed")
            study = directory / "study"
            with patch("fairbeam.fem_qualification.discover_solver", return_value=(directory, solver)), \
                    patch("fairbeam.fem_qualification._source_provenance", return_value={}), \
                    patch("fairbeam.fem_qualification.subprocess.Popen", side_effect=OSError("synthetic launch failure")):
                with self.assertRaisesRegex(OSError, "synthetic launch failure"):
                    run_study(study, experimental=True)
            manifest = json.loads((study / "manifest.json").read_text(encoding="utf-8"))
            case = study / "inputs" / _case_key(1.0, 25.0)
            case_manifest = json.loads((case / "manifest.json").read_text(encoding="utf-8"))
            for record in (manifest, case_manifest):
                self.assertEqual(record["status"], "failed")
                self.assertFalse(record["solver_executed"])
                self.assertIn("launch_requested", [entry["stage"] for entry in record["stage_history"]])
                self.assertNotIn("solver_started", [entry["stage"] for entry in record["stage_history"]])

    def test_later_launch_failure_preserves_previous_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            solver = directory / "ElmerSolver.exe"
            solver.write_bytes(b"synthetic solver identifier; never executed")
            study = directory / "study"

            def simulate_run(solver, home, case, *, on_started):
                if case.name == _case_key(1.0, 25.0):
                    on_started()
                    (case / "eigen.dat").write_text("synthetic retained output", encoding="ascii")
                    (case / "mesh" / "mode_t0001.vtu").write_bytes(b"synthetic retained mode")
                    return 0, 0.001, "ALL DONE"
                raise OSError("synthetic second launch failure")

            with patch("fairbeam.fem_qualification.discover_solver", return_value=(directory, solver)), \
                    patch("fairbeam.fem_qualification._source_provenance", return_value={}), \
                    patch("fairbeam.fem_qualification._run_solver", side_effect=simulate_run), \
                    patch("fairbeam.fem_qualification._read_eigenvalues", return_value=[analytic_frequency_per_m(1), 10.0]), \
                    patch("fairbeam.fem_qualification.validate_mode_coverage", return_value={"matches_prepared_mesh": True}), \
                    patch("fairbeam.fem_qualification.read_mode", return_value=synthetic_mode()):
                with self.assertRaisesRegex(OSError, "synthetic second launch failure"):
                    run_study(study, experimental=True)
            manifest = json.loads((study / "manifest.json").read_text(encoding="utf-8"))
            self.assertTrue(manifest["solver_executed"])
            self.assertEqual(len([stage for stage in manifest["stage_history"] if stage["stage"] == "solver_started"]), 1)
            case = study / "inputs" / _case_key(1.0, 12.5)
            case_manifest = json.loads((case / "manifest.json").read_text(encoding="utf-8"))
            self.assertFalse(case_manifest["solver_executed"])


class StudyCriteria(unittest.TestCase):
    def test_matched_mesh_scaling_and_refinement_are_assessed(self):
        mode = synthetic_mode()
        results = []
        for eps_r in EPS_R_VALUES:
            for mesh_size in MESH_SIZES_MM:
                error = 0.02 if mesh_size == 25 else 0.005
                frequency = analytic_frequency_per_m(eps_r) * (1 + error)
                results.append(assess_case([frequency, frequency * 1.6], mode, eps_r, mesh_size))
        summary = assess_study(results)
        self.assertEqual(summary["status"], "study_validated")
        self.assertEqual(summary["case_count"], 4)
        self.assertTrue(all(row["passed"] for row in summary["same_mesh_scaling"]))
        self.assertTrue(all(row["error_decreased"] for row in summary["refinement"]))

    def test_same_mesh_scaling_failure_is_not_accepted(self):
        mode = synthetic_mode()
        results = []
        for eps_r in EPS_R_VALUES:
            for mesh_size in MESH_SIZES_MM:
                error = 0.02 if mesh_size == 25 else 0.005
                frequency = analytic_frequency_per_m(eps_r) * (1 + error)
                if eps_r == 4 and mesh_size == 12.5:
                    frequency *= 1.0001
                results.append(assess_case([frequency, frequency * 1.6], mode, eps_r, mesh_size))
        summary = assess_study(results)
        self.assertEqual(summary["status"], "validation_failed")
        self.assertFalse(summary["same_mesh_scaling"][1]["passed"])

    def test_study_rejects_duplicate_or_incomplete_case_results(self):
        mode = synthetic_mode()
        result = []
        for eps_r in EPS_R_VALUES:
            for mesh_size in MESH_SIZES_MM:
                frequency = analytic_frequency_per_m(eps_r)
                result.append(assess_case([frequency, frequency * 1.6], mode, eps_r, mesh_size))
        with self.assertRaisesRegex(FEMQualificationError, "exactly four"):
            assess_study(result[:3])
        with self.assertRaisesRegex(FEMQualificationError, "duplicate"):
            assess_study([result[0], result[1], result[2], result[0]])


class ModeFileQA(unittest.TestCase):
    def prepared_nodes(self, directory):
        points = synthetic_mode()["points"]
        path = Path(directory) / "mesh.nodes"
        path.write_text("\n".join(
            f"{index + 1} -1 {x:.17g} {y:.17g} {z:.17g}"
            for index, (x, y, z) in enumerate(zip(points[0::3], points[1::3], points[2::3]))
        ) + "\n", encoding="ascii")
        return path

    def test_coverage_allows_reordered_nodes_and_small_roundoff(self):
        with tempfile.TemporaryDirectory() as temp:
            nodes = self.prepared_nodes(temp)
            mode = synthetic_mode()
            triples = [mode["points"][offset:offset + 3] for offset in (6, 0, 3)]
            mode["points"] = tuple(value + 1e-14 for triple in triples for value in triple)
            coverage = validate_mode_coverage(mode, nodes, 3)
            self.assertTrue(coverage["matches_prepared_mesh"])
            self.assertEqual(coverage["point_count"], 3)
            self.assertEqual(coverage["coordinate_tolerance_m"], 1e-12)

    def test_coverage_rejects_missing_output_nodes(self):
        with tempfile.TemporaryDirectory() as temp:
            nodes = self.prepared_nodes(temp)
            mode = synthetic_mode()
            mode["points"] = mode["points"][:6]
            with self.assertRaisesRegex(FEMQualificationError, "point count"):
                validate_mode_coverage(mode, nodes, 3)

    def test_coverage_rejects_duplicate_output_coordinates(self):
        with tempfile.TemporaryDirectory() as temp:
            nodes = self.prepared_nodes(temp)
            mode = synthetic_mode()
            mode["points"] = mode["points"][:6] + mode["points"][3:6]
            with self.assertRaisesRegex(FEMQualificationError, "duplicate"):
                validate_mode_coverage(mode, nodes, 3)

    def test_coverage_rejects_shifted_output_coordinates(self):
        with tempfile.TemporaryDirectory() as temp:
            nodes = self.prepared_nodes(temp)
            mode = synthetic_mode()
            coordinates = list(mode["points"])
            coordinates[3] += 1e-8
            mode["points"] = tuple(coordinates)
            with self.assertRaisesRegex(FEMQualificationError, "do not match"):
                validate_mode_coverage(mode, nodes, 3)

    def test_reads_expected_finite_vtu_layout(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "mode.vtu"
            expected = synthetic_mode()
            write_raw_vtu(path, expected)
            self.assertEqual(read_mode(path), expected)

    def test_rejects_nonfinite_vtu_field(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "mode.vtu"
            bad = synthetic_mode()
            bad["elfield"] = (0.0, 0.0, 0.0, 0.0, math.inf, 0.0, 0.0, 0.0, 0.0)
            write_raw_vtu(path, bad)
            with self.assertRaisesRegex(FEMQualificationError, "non-finite"):
                read_mode(path)


class ProcessBounds(unittest.TestCase):
    class HangingProcess:
        def __init__(self, *args, **kwargs):
            self.returncode = None
            self.terminated = False
            self.killed = False
            kwargs["stdout"].write(b"partial native solver log\n")

        def poll(self):
            return self.returncode

        def terminate(self):
            self.terminated = True
            self.returncode = -15

        def kill(self):
            self.killed = True
            self.returncode = -9

        def wait(self, timeout=None):
            return self.returncode

    def test_start_callback_runs_once_after_successful_process_creation(self):
        with tempfile.TemporaryDirectory() as temp:
            case = Path(temp)
            callbacks = []
            children = []

            def spawn(*args, **kwargs):
                child = self.HangingProcess(*args, **kwargs)
                child.returncode = 0
                children.append(child)
                return child

            def started():
                self.assertEqual(len(children), 1)
                callbacks.append("started")

            with patch("fairbeam.fem_qualification.subprocess.Popen", side_effect=spawn):
                code, _, _ = _run_solver(Path("solver"), case, case, on_started=started)
            self.assertEqual(code, 0)
            self.assertEqual(callbacks, ["started"])

    def test_start_callback_failure_terminates_launched_process(self):
        with tempfile.TemporaryDirectory() as temp:
            case = Path(temp)
            children = []

            def spawn(*args, **kwargs):
                child = self.HangingProcess(*args, **kwargs)
                children.append(child)
                return child

            def started():
                raise RuntimeError("synthetic callback failure")

            with patch("fairbeam.fem_qualification.subprocess.Popen", side_effect=spawn):
                with self.assertRaisesRegex(RuntimeError, "synthetic callback failure"):
                    _run_solver(Path("solver"), case, case, on_started=started)
            self.assertTrue(children[0].terminated)
            self.assertIn("partial native solver log", (case / "solver.log").read_text(encoding="utf-8"))

    def test_timeout_terminates_process_and_preserves_partial_log(self):
        with tempfile.TemporaryDirectory() as temp:
            case = Path(temp)
            children = []
            def spawn(*args, **kwargs):
                child = self.HangingProcess(*args, **kwargs)
                children.append(child)
                return child
            clock_values = iter((0.0, 0.02))
            with patch("fairbeam.fem_qualification.subprocess.Popen", side_effect=spawn), \
                    patch("fairbeam.fem_qualification.time.monotonic", side_effect=lambda: next(clock_values)), \
                    patch("fairbeam.fem_qualification.time.sleep"):
                with self.assertRaisesRegex(FEMQualificationError, "exceeded 0.01 second limit"):
                    _run_solver(Path("solver"), Path(temp), case, timeout_seconds=0.01)
            self.assertEqual(len(children), 1)
            self.assertTrue(children[0].terminated)
            self.assertFalse(children[0].killed)
            log = (case / "solver.log").read_text(encoding="utf-8")
            self.assertIn("partial native solver log", log)

    def test_log_size_limit_terminates_process_and_retains_log(self):
        with tempfile.TemporaryDirectory() as temp:
            case = Path(temp)
            children = []
            def spawn(*args, **kwargs):
                child = self.HangingProcess(*args, **kwargs)
                children.append(child)
                return child
            with patch("fairbeam.fem_qualification.subprocess.Popen", side_effect=spawn):
                with self.assertRaisesRegex(FEMQualificationError, "exceeded 4 byte limit"):
                    _run_solver(Path("solver"), Path(temp), case, max_log_bytes=4)
            self.assertTrue(children[0].terminated)
            self.assertGreater((case / "solver.log").stat().st_size, 4)


if __name__ == "__main__":
    unittest.main()
