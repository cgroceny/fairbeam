"""Explicit handshake for the opt-in research executable; never fall back to stock openEMS."""
import json
from pathlib import Path
import subprocess


def validate_capabilities(value):
    expected = {"schema": 1, "backend": "fairbeam-periodic-cpu", "revision": 4,
                "boundary": "PERIODIC_TEST", "phase": "zero", "axes": "xy",
                "engine": "basic", "geometry": "axis-aligned-boxes"}
    if not isinstance(value, dict) or any(value.get(k) != v for k, v in expected.items()):
        raise ValueError("A revision 4 experimental periodic CPU executable is required; no fallback is allowed")
    return value


def check_capabilities(executable):
    executable = Path(executable).resolve(strict=True)
    if not executable.is_file():
        raise ValueError("The candidate must be a native executable file")
    result = subprocess.run([str(executable), "--fairbeam-periodic-capabilities"],
                            capture_output=True, text=True, timeout=10,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode != 0:
        raise ValueError("The candidate rejected the periodic capability handshake; no simulation started")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("The candidate did not provide periodic capabilities; stock openEMS cannot run this study") from exc
    return validate_capabilities(value)
