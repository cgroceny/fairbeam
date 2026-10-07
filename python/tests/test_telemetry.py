"""Legacy telemetry environment variables cannot enable run-server counters."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from fairbeam.jobs import JobManager
from fairbeam.server import App

MODELS = Path(__file__).resolve().parents[1] / "models"

class NoServerCounters(unittest.TestCase):
    def test_legacy_environment_cannot_enable_counting(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            counts = root / "telemetry"
            with mock.patch.dict(os.environ, {"FAIRBEAM_TELEMETRY_DIR": str(counts), "FAIRBEAM_NO_TELEMETRY": "0"}):
                app = App(models_dir=MODELS, projects_dir=root / "projects", jobs_dir=root / "jobs",
                          manager=JobManager(root / "jobs", root / "projects", autostart=False))
                try:
                    self.assertFalse(hasattr(app.manager, "on_started"))
                    self.assertFalse(counts.exists())
                finally:
                    app.close()

if __name__ == "__main__":
    unittest.main()
