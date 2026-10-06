"""Model definition helpers.

A model is a Python file exposing::

    MODEL = {"id": "...", "name": "...", "description": "...", "reference": "..."}
    PARAMS = [Param(...), ...]
    def build(p: dict) -> Simulation: ...

``build`` receives resolved parameter values and returns a fully configured
:class:`~fairbeam.simulation.Simulation` (geometry, ports, mesh, NF2FF box).
"""

import importlib.util
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass
class Param:
    key: str
    default: float | int | str
    label: str
    unit: str = ""
    description: str = ""
    minimum: float | None = None
    maximum: float | None = None

    def parse(self, text: str):
        if isinstance(self.default, bool):
            return text.lower() in ("1", "true", "yes", "on")
        if isinstance(self.default, int):
            value = int(text)
        elif isinstance(self.default, float):
            value = float(text)
        else:
            return text
        if self.minimum is not None and value < self.minimum:
            raise ValueError(f"{self.key}={value} is below the minimum {self.minimum}")
        if self.maximum is not None and value > self.maximum:
            raise ValueError(f"{self.key}={value} is above the maximum {self.maximum}")
        return value

    def describe(self, value) -> dict:
        d = asdict(self)
        d["value"] = value
        return d


def load_model(path: str | Path):
    """A model module from a ``.py`` file, or a stand-in with the same interface for a
    ``.design.json`` file (fairbeam.design)."""
    path = Path(path).resolve()
    if path.name.endswith(".design.json"):
        from .design import module_for
        return module_for(path)
    spec = importlib.util.spec_from_file_location(f"fairbeam_model_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load model {path}")
    module = importlib.util.module_from_spec(spec)
    # model files are the user's (workspace/models): leave no __pycache__ next to them
    before, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = before
    for attr in ("MODEL", "PARAMS", "build"):
        if not hasattr(module, attr):
            raise AttributeError(f"model {path.name} does not define {attr}")
    return module


def resolve_params(params: list[Param], overrides: dict[str, str]) -> dict:
    known = {p.key: p for p in params}
    unknown = set(overrides) - set(known)
    if unknown:
        raise KeyError(f"unknown parameter(s): {', '.join(sorted(unknown))}; "
                       f"available: {', '.join(known)}")
    return {p.key: (p.parse(overrides[p.key]) if p.key in overrides else p.default) for p in params}
