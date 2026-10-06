"""A Python model script as a Design, without running the solver (the designer's Python panel, Apply).

The script is a model file (``MODEL``, ``PARAMS``, ``build``) such as ``design.to_python`` writes. It
runs in a child process of its own (``python -m fairbeam.python_design``) with a time limit: the child
builds the CSXCAD structure at the parameter defaults and reads it back with the example converter
(``example_design.convert_example``), so the expression and parameter rules are the converter's.
The solver is never started: ``openEMS.Run`` and ``Simulation.run`` are replaced by a function that
raises before the script is imported.

This is not a sandbox. The script is the user's own Python and can do whatever Python can; the child
only bounds the time, keeps the server process safe from crashes and hangs, and keeps stray output
out of the server's log.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

from . import procutil

TIMEOUT_S = 20.0
MAX_SOURCE = 512 * 1024
OUTPUT_LIMIT = 4000


class ScriptError(Exception):
    """The script did not become a design. ``line`` is the 1-based line of the script it stopped at."""

    def __init__(self, message: str, line: int | None = None, timeout: bool = False):
        super().__init__(message)
        self.message, self.line, self.timeout = message, line, timeout


def _script_location(exc: BaseException, script: str):
    """(innermost message, line in the script) along the ``__cause__``/``__context__`` chain."""
    line, message, seen = None, f"{type(exc).__name__}: {exc}", set()
    chain, cur = [], exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        chain.append(cur)
        cur = cur.__cause__ or cur.__context__
    for e in chain:  # outermost first; the converter's wrappers carry no script frame
        if isinstance(e, SyntaxError) and e.filename == script and e.lineno:
            return f"SyntaxError: {e.msg}", e.lineno
        for frame in traceback.extract_tb(e.__traceback__):
            if frame.filename == script:
                line = frame.lineno
                message = f"{type(e).__name__}: {e}"
    return message, line


def _forbid_solver():
    """The solver classes are compiled (immutable), so the ``openEMS`` class is replaced by a
    subclass whose ``Run`` raises, wherever a script or the fairbeam wrapper looks it up."""
    def refused(*_a, **_k):
        raise RuntimeError("the solver is not run here: Apply only builds the geometry (remove FDTD.Run / RunOpenEMS)")

    import openEMS
    from . import simulation
    base = openEMS.openEMS
    guarded = type("openEMS", (base,), {"Run": refused})
    openEMS.openEMS = guarded
    sys.modules["openEMS.openEMS"].openEMS = guarded
    simulation.openEMS = guarded
    simulation.Simulation.run = refused


def _child(script: str, out: str) -> int:
    sys.dont_write_bytecode = True
    try:
        _forbid_solver()
        from .example_design import convert_example
        result = {"design": convert_example(Path(script), "python-edit", "Python design")}
    except BaseException as e:  # noqa: BLE001 - the script may raise anything, even SystemExit
        message, line = _script_location(e, script)
        result = {"error": message, "line": line}
    Path(out).write_text(json.dumps(result, allow_nan=False, default=str), encoding="utf-8")
    return 0


def convert_script(source: str, timeout: float = TIMEOUT_S) -> dict:
    """``{design, output}``: the design (``fairbeam.design/1``) the script builds and what it printed.

    Raises ``ScriptError`` (with the line, when it is in the script) for a script that fails, does
    not build, or runs longer than ``timeout`` seconds."""
    if not isinstance(source, str) or not source.strip():
        raise ScriptError("the script is empty")
    if len(source.encode("utf-8")) > MAX_SOURCE:
        raise ScriptError(f"the script is larger than {MAX_SOURCE // 1024} KB")
    with tempfile.TemporaryDirectory(prefix="fairbeam-py-") as tmp:
        script, out = str(Path(tmp, "design_script.py").resolve()), str(Path(tmp, "result.json"))
        Path(script).write_text(source, encoding="utf-8")
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8",
                   PYTHONPATH=os.pathsep.join([str(Path(__file__).resolve().parents[1]), os.environ.get("PYTHONPATH", "")]))
        with open(Path(tmp, "stdout.txt"), "wb") as sink:
            proc = procutil.popen_group([sys.executable, "-m", "fairbeam.python_design", script, out],
                                        stdin=subprocess.DEVNULL, stdout=sink, stderr=subprocess.STDOUT, cwd=tmp, env=env)
            try:
                try:
                    proc.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    raise ScriptError(f"the script ran longer than {timeout:g} s and was stopped", timeout=True) from None
            finally:
                procutil.kill_tree(proc.pid)  # anything the script left running
                proc.wait()
                procutil.release_group(proc)
        text = Path(tmp, "stdout.txt").read_text(encoding="utf-8", errors="replace")[-OUTPUT_LIMIT:]
        try:
            result = json.loads(Path(out).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            tail = text.strip().splitlines()[-1:] or ["no result"]
            raise ScriptError(f"the script ended the process (exit code {proc.returncode}): {tail[0]}") from None
        if "error" in result:
            raise ScriptError(result["error"], result.get("line"))
        return {"design": result["design"], "output": text}


def _same(a: dict, b: dict) -> bool:
    """The two designs are the same up to the name, the mesh settings the converter fits to its source
    and the last digits of numbers written into expressions (the mesh lines are fitted expressions)."""
    def strip(d):
        d = {k: ({m: w for m, w in v.items() if m != "automatic"} if k == "mesh" else v) for k, v in d.items() if k != "model"}
        return re.sub(r"-?\d+\.\d+(?:[eE][-+]?\d+)?", lambda m: f"{float(m.group()):.4g}", json.dumps(d, sort_keys=True))
    return strip(a) == strip(b)


def apply_script(source: str, timeout: float = TIMEOUT_S, model: dict | None = None) -> dict:
    """``convert_script`` (``model``: the name, id and description of the design that is open) plus the round trip: ``python`` is the script regenerated from the design
    and ``normalized`` is False when that script builds the same design as ``source`` (the editor
    then keeps the user's text), True when it differs or cannot be checked."""
    from .design import DesignError, to_python

    res = convert_script(source, timeout)
    if model:  # the open design's own name, id and description head the regenerated script
        res["design"]["model"] = {**res["design"]["model"], **model}
    try:
        regenerated = to_python(res["design"])
    except DesignError as e:
        raise ScriptError(str(e)) from None
    try:
        normalized = not _same(res["design"], convert_script(regenerated, timeout)["design"])
    except ScriptError:
        normalized = True
    return {"design": res["design"], "output": res["output"], "python": regenerated, "normalized": normalized}


if __name__ == "__main__":
    raise SystemExit(_child(sys.argv[1], sys.argv[2]))
