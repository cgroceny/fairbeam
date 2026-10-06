"""fairbeam: openEMS antenna simulations exported as viewer-ready project bundles."""

import os as _os
import sys as _sys


def _windows_dll_dirs():
    """Windows: Python (3.8+) no longer searches PATH for the DLLs of extension modules, so the
    CSXCAD/openEMS wheels cannot find CSXCAD.dll, openEMS.dll, hdf5, VTK ... unless their folder is
    registered. Use OPENEMS_INSTALL_PATH, else CSXCAD_INSTALL_PATH (what the openEMS README asks
    for; the wheels themselves honour both), else the conventional C:\\opt\\openEMS."""
    if _sys.platform != "win32":
        return
    root = (_os.environ.get("OPENEMS_INSTALL_PATH") or _os.environ.get("CSXCAD_INSTALL_PATH")
            or r"C:\opt\openEMS")
    for d in (root, _os.path.join(root, "bin")):
        if _os.path.isdir(d):
            try:
                _os.add_dll_directory(d)
            except OSError:
                pass


_windows_dll_dirs()

# The native CPU patches of the macOS openEMS pack (scripts/native-cpu, docs/CPU-OPTIMIZATION.md) are
# switched on by these variables, which libopenEMS reads when it loads: set them before openEMS is
# imported. A library without the patches ignores them. Default on for macOS only; the
# environment variable FAIRBEAM_NATIVE_CPU=0 turns the default off, and a value the user already
# set for one of the three variables is never replaced.
_NATIVE_CPU_ENV = (
    ("OPENEMS_EXPERIMENTAL_CPU_PHASE_DISPATCH", "phase-lists"),
    ("OPENEMS_EXPERIMENTAL_CPU_UPML_CURSOR", "cursor"),
    ("OPENEMS_EXPERIMENTAL_CPU_UPML_ROWS", "rows"),
)


def native_cpu_default() -> bool:
    """True when this process turns the native CPU patches on by default (macOS, unless opted out)."""
    return _sys.platform == "darwin" and _os.environ.get("FAIRBEAM_NATIVE_CPU", "").strip().lower() not in (
        "0", "off", "false", "no")


def _native_cpu_defaults():
    if native_cpu_default():
        for name, value in _NATIVE_CPU_ENV:
            _os.environ.setdefault(name, value)


def native_cpu_note() -> str | None:
    """The run-log line that says the patches are requested (None when they are not). openEMS itself
    prints one line per patch it actually applied; a build without the patches prints none."""
    if all(_os.environ.get(name) == value for name, value in _NATIVE_CPU_ENV):
        source = "macOS default" if native_cpu_default() else "environment"
        return (f"native CPU patches requested ({source}; FAIRBEAM_NATIVE_CPU=0 turns the default off); "
                "the openEMS lines 'Experimental CPU ...' below show what this build applied")
    return None


_native_cpu_defaults()

from ._meta import BUNDLE_SCHEMA, __version__  # noqa: E402
from .model import Param  # noqa: E402
from .simulation import Simulation  # noqa: E402

__all__ = ["BUNDLE_SCHEMA", "Param", "Simulation", "__version__"]
