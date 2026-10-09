"""Normal Fairbeam CLI and the isolated experimental Elmer console entry point."""

import contextlib
import importlib
import io
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fairbeam import cli  # noqa: E402

PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def scripts() -> dict:
    """The [project.scripts] table (a small reader: tomllib needs Python 3.11, the package 3.10)."""
    text = PYPROJECT.read_text(encoding="utf-8")
    body = re.search(r"^\[project\.scripts\]\n(.*?)(?=^\[|\Z)", text, re.M | re.S)
    assert body, "pyproject.toml has no [project.scripts]"
    return dict(re.findall(r'^([\w-]+)\s*=\s*"([^"]+)"', body.group(1), re.M))


class EntryPoints(unittest.TestCase):
    def test_normal_and_experimental_scripts_are_separate(self):
        table = scripts()
        self.assertEqual(table, {"fairbeam": "fairbeam.cli:main",
                                 "fairbeam-elmer": "fairbeam_elmer:main"})
        module, _, attr = table["fairbeam"].partition(":")
        self.assertIs(getattr(importlib.import_module(module), attr), cli.main)
        experiment = importlib.import_module("fairbeam_elmer")
        self.assertIsNot(experiment.main, cli.main)

    def test_the_package_name_is_fairbeam(self):
        text = PYPROJECT.read_text(encoding="utf-8")
        self.assertRegex(text, r'(?m)^name = "fairbeam"$')
        self.assertRegex(text, r'(?m)^packages = \["fairbeam"\]$')

    def test_help_names_the_command(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(SystemExit) as raised:
            cli.main(["--help"])
        self.assertEqual(raised.exception.code, 0)
        self.assertIn("usage: fairbeam ", out.getvalue())


if __name__ == "__main__":
    unittest.main()
