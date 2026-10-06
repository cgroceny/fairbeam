"""The user's material library ("My materials"): the list a user saves from designs, kept next to the
other workspace files as ``<workspace>/materials.json`` (GET/PUT /api/materials/user).

It is only a source for new copies: a design always carries the full copy of every material it
uses, and the .design.json format is unchanged. src/designer/userMaterials.ts holds the same
validation for the browser (localStorage, JSON import); python/tests/fixtures/user_materials.json
pins both.

An entry: ``{id, name, kind, eps_r?, tan_d?, tan_d_freq?, conductivity?, thickness?, color?}``.
Numbers are plain numbers (a design parameter expression cannot be saved); ``tan_d_freq`` is in GHz,
``conductivity`` in S/m, ``thickness`` in mm.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

from .modelfiles import _write_atomic

FILE_NAME = "materials.json"
MAX_ENTRIES = 500
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
_ID = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


def _num(v) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    return v


def clean_entry(raw) -> tuple[dict | None, str]:
    """(the normalized entry, "") or (None, why it is skipped)."""
    if not isinstance(raw, dict):
        return None, "not an object"
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 80:
        return None, "missing name"
    kind = raw.get("kind")
    if kind not in ("metal", "dielectric"):
        return None, "kind must be metal or dielectric"
    id_ = raw.get("id")
    if not isinstance(id_, str) or not _ID.match(id_):
        return None, "missing id"
    out: dict = {"id": id_, "name": name.strip(), "kind": kind}
    if kind == "dielectric":
        eps = _num(raw.get("eps_r"))
        if eps is None or eps < 1:
            return None, "eps_r must be a number of at least 1"
        tan = _num(raw.get("tan_d", 0))
        if tan is None or tan < 0:
            return None, "tan_d must be a number of at least 0"
        if raw.get("mu_r") is not None:
            mu = _num(raw["mu_r"])
            if mu is None or mu <= 0:
                return None, "mu_r must be a positive number"
            out["mu_r"] = mu
        out["eps_r"], out["tan_d"] = eps, tan
        if raw.get("tan_d_freq") is not None:
            f = _num(raw["tan_d_freq"])
            if f is None or f <= 0:
                return None, "tan_d_freq must be a positive number"
            out["tan_d_freq"] = f
    elif raw.get("conductivity") is not None:
        s = _num(raw["conductivity"])
        if s is None or s <= 0:
            return None, "conductivity must be a positive number"
        out["conductivity"] = s
        if raw.get("thickness") is not None:
            th = _num(raw["thickness"])
            if th is None or th <= 0:
                return None, "thickness must be a positive number"
            out["thickness"] = th
    color = raw.get("color")
    if color is not None:
        if not isinstance(color, str) or not _COLOR.match(color):
            return None, "color must be #rrggbb"
        out["color"] = color.lower()
    return out, ""


def clean_list(raw) -> tuple[list[dict], list[str]]:
    """The valid entries (first of a repeated id or name wins) and a warning per skipped one."""
    items = raw.get("materials") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return [], ["the file has no materials list"]
    out: list[dict] = []
    warnings: list[str] = []
    ids: set[str] = set()
    names: set[str] = set()
    for i, item in enumerate(items):
        if len(out) >= MAX_ENTRIES:
            warnings.append(f"entry {i + 1}: more than {MAX_ENTRIES} materials, the rest is skipped")
            break
        entry, why = clean_entry(item)
        if entry is None:
            warnings.append(f"entry {i + 1}: {why}")
        elif entry["id"] in ids or entry["name"] in names:
            warnings.append(f"entry {i + 1} ({entry['name']}): id or name used twice")
        else:
            ids.add(entry["id"])
            names.add(entry["name"])
            out.append(entry)
    return out, warnings


def load(path: Path) -> tuple[list[dict], list[str]]:
    """The saved list; a missing file is an empty list, a damaged one too (with a warning)."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        return [], []
    except OSError as e:
        return [], [f"cannot read {FILE_NAME}: {e}"]
    try:
        return clean_list(json.loads(text))
    except ValueError:
        return [], [f"{FILE_NAME} is not valid JSON and was ignored"]


def save(path: Path, raw) -> tuple[list[dict], list[str]]:
    """Validate and write the list (atomic); returns what was kept and the warnings."""
    items, warnings = clean_list(raw)
    text = json.dumps({"version": 1, "materials": items}, indent=2, ensure_ascii=False) + "\n"
    _write_atomic(Path(path), text)
    return items, warnings
