"""Resource admission uses actual mesh cells and fresh memory; no solver runs."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from fairbeam import resources
from fairbeam.simulation import Simulation


class SolverAdmission(unittest.TestCase):
    def simulation(self):
        s = Simulation.__new__(Simulation)
        s.mesh = SimpleNamespace(GetLines=lambda axis: list(range(11)))  # 1,000 cells
        s.fdtd = SimpleNamespace(Run=mock.Mock(side_effect=RuntimeError("test sentinel: no solver")))
        return s

    def test_refuses_actual_mesh_before_solver_or_output_creation(self):
        s = self.simulation()
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.object(resources, "free_memory_bytes", return_value=10):
            with self.assertRaisesRegex(ValueError, "GiB.*free"):
                s.run(root + "/not-created", threads=1)
            self.assertFalse(Path(root, "not-created").exists())
        s.fdtd.Run.assert_not_called()

    def test_refreshes_available_memory_for_each_evaluation(self):
        s = self.simulation()
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.object(resources, "free_memory_bytes", side_effect=[1_000_000, 10]):
            with self.assertRaisesRegex(RuntimeError, "test sentinel"):
                s.run(root + "/first", threads=1)
            with self.assertRaisesRegex(ValueError, "GiB.*free"):
                s.run(root + "/second", threads=1)
        self.assertEqual(s.fdtd.Run.call_count, 1)

    def test_unknown_memory_is_not_mislabeled_as_refusal(self):
        s = self.simulation()
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.object(resources, "free_memory_bytes", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "test sentinel"):
                s.run(root, threads=1)
        s.fdtd.Run.assert_called_once()
