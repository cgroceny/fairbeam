"""simulation._capture_output: the echo of openEMS' C++ output is complete and ends before the next
Python line (the pump used to write to an already closed descriptor, losing the tail and gluing
it to the next line, e.g. a multi-port "fairbeam: run k/n" header). No openEMS needed."""

import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from fairbeam.simulation import _capture_output  # noqa: E402


class Capture(unittest.TestCase):
    def test_echo_is_complete_and_ordered(self):
        errors = []
        hook = threading.excepthook
        threading.excepthook = lambda a: errors.append(repr(a.exc_value))
        payload = b"x" * 1_000_000 + b"\nSpeed: 1 MCells/s \n"
        marker = b"fairbeam: run 2/3: port 2 excited, 2 terminated\n"
        with tempfile.TemporaryFile() as out:
            real = os.dup(1)
            sys.stdout.flush()
            os.dup2(out.fileno(), 1)
            try:
                for _ in range(3):
                    with _capture_output(echo=True) as chunks:
                        os.write(1, payload)
                    os.write(1, marker)
            finally:
                os.dup2(real, 1)
                os.close(real)
                threading.excepthook = hook
            out.seek(0)
            text = out.read()
        self.assertEqual(errors, [])
        self.assertEqual(b"".join(chunks), payload)
        self.assertEqual(text, (payload + marker) * 3)


if __name__ == "__main__":
    unittest.main()
