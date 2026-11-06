"""Read the explicit numeric subset emitted by Fairbeam, without running a solver.

Unknown cards and changes of the physical model between frequency requests are
errors. This is not a general NEC/4nec2 interpreter; no expressions or includes.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat

from . import nec

MAX_BYTES = 1024 * 1024
MAX_LINES = 4096
_NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eEdD][+-]?[0-9]+)?\Z")
_INTEGER = re.compile(r"[+-]?[0-9]+\Z")
_PATTERN = [0, 19, 37, 1000, 0, 0, 10, 10, 0, 0]


def read_deck(path: Path) -> str:
    """Read at most 1 MiB from the explicitly selected regular file."""
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
            raise ValueError("NEC input must be a regular file of at most 1 MiB")
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("NEC input exceeds 1 MiB")
    try:
        return raw.decode("utf-8")
    except UnicodeError as error:
        raise ValueError("NEC input must be UTF-8 text") from error


def import_file(path: Path, directory: Path, *, reference_ohm: float = 50.0) -> dict:
    """Validate before creating a fresh capture; never run or download a solver."""
    source = read_deck(path)
    imported = parse_deck(source, reference_ohm=reference_ohm)
    directory = nec.export(imported["model"], directory, pattern=imported["pattern"])
    (directory / "source.nec").write_bytes(source.encode("utf-8"))
    for name, value in (("model.json", imported["model"]), ("import.json", imported["report"])):
        (directory / name).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return imported


def parse_deck(source: str, *, reference_ohm: float = 50.0) -> dict:
    """Return a validated wire model and an explicit, non-solved import report.

    Geometry is metres and FR frequencies MHz in the deck, mm/GHz in the model.
    Reference resistance is supplied separately: EX output normalization is not
    a physical port reference and must not silently become one.
    """
    if not isinstance(source, str) or len(source) > MAX_BYTES:
        raise ValueError("NEC input must be text of at most 1 MiB")
    try:
        raw = source.encode("utf-8")
    except UnicodeError as error:
        raise ValueError("NEC input must be valid UTF-8 text") from error
    if len(raw) > MAX_BYTES or len(source.splitlines()) > MAX_LINES:
        raise ValueError("NEC input exceeds its size or line limit")
    if any((ord(c) < 32 and c not in "\t\r\n") or c in "\x7f\x85\u2028\u2029" for c in source):
        raise ValueError("NEC input contains a control character")
    wires, frequencies, cards = [], [], {}
    geometry_done = ended = comments_done = execution_started = False
    controls, feed, pending, pattern = set(), None, None, None

    for line_number, original in enumerate(source.removeprefix("\ufeff").splitlines(), 1):
        line = original.strip(" \t\r")
        if not line:
            continue
        if len(line) > 512:
            raise ValueError(f"NEC line {line_number}: line exceeds 512 characters")

        def require(condition, message):
            if not condition:
                raise ValueError(f"NEC line {line_number}: {message}")

        require(not ended, "content after EN is not supported")
        match = re.fullmatch(r"([A-Za-z]{2})(?:[ \t]+(.*))?", line)
        require(match is not None, "use whitespace-separated numeric cards")
        card, tail = match.group(1).upper(), match.group(2) or ""
        cards[card] = cards.get(card, 0) + 1
        if card == "CM":
            require(not comments_done and not wires and not geometry_done, "CM must precede CE and geometry")
            continue
        if card == "CE":
            require(not tail and not comments_done and not wires and not geometry_done, "unexpected CE")
            comments_done = True
            continue
        require(card in {"GW", "GE", "GN", "EK", "PT", "EX", "FR", "XQ", "RP", "EN"},
                f"unsupported card {card}; no card is silently discarded")
        if cards.get("CM"):
            require(comments_done, "comment block needs CE before geometry")
        # Empty comma fields are deliberately rejected, not shifted to another
        # parameter. Full fixed-column syntax and omitted fields are unsupported.
        parts = re.split(r"[ \t]+", tail) if tail else []
        require(all(_NUMBER.fullmatch(p) for p in parts), "only explicit finite numeric fields are supported")
        values = [float(p.replace("D", "e").replace("d", "e")) for p in parts]
        require(all(math.isfinite(v) for v in values), "nonfinite numeric field")

        def integers(count):
            require(len(parts) >= count and all(_INTEGER.fullmatch(p) for p in parts[:count]),
                    "integer fields must use integer notation")
            return [int(p) for p in parts[:count]]

        if card == "GW":
            require(not geometry_done and len(values) == 9, "GW needs tag, segments, two endpoints and radius before GE")
            tag, segments = integers(2)
            require(len(wires) < nec.MAX_SEGMENTS, "too many wires")
            wires.append(dict(tag=tag, segments=segments, start_mm=[v*1000 for v in values[2:5]],
                              end_mm=[v*1000 for v in values[5:8]], radius_mm=values[8]*1000))
        elif card == "GE":
            require(wires and not geometry_done and values == [0] and integers(1) == [0],
                    "one GE 0 after all wires is required; ground geometry is unsupported")
            geometry_done = True
        else:
            require(geometry_done, "control card before GE")
            if card in {"GN", "EK", "PT"}:
                require(not execution_started and card not in controls, "control changes or duplicate controls are unsupported")
                expected = {"GN": -1, "EK": 0, "PT": -1}[card]
                require(values == [expected] and integers(1) == [expected],
                        f"only {card} {expected} is supported")
                controls.add(card)
            elif card == "EX":
                require(not execution_started and feed is None and len(values) == 6, "one explicit EX source before FR is required")
                kind, tag, segment, normalization = integers(4)
                require(kind == 0 and normalization == 0 and values[4:] == [1, 0],
                        "only a 1 V real applied-field segment source without output normalization is supported")
                feed = dict(tag=tag, segment=segment)
            elif card == "FR":
                require(feed is not None and {"GN", "EK"} <= controls and pending is None and len(values) == 6,
                        "FR needs one source, explicit GN -1 and EK 0, and no pending frequency request")
                mode, count, unused1, unused2 = integers(4)
                require(mode == 0 and unused1 == unused2 == 0 and 1 <= count <= nec.MAX_FREQUENCIES,
                        "only bounded explicit linear frequency sweeps are supported")
                require(values[4] > 0 and (values[5] > 0 if count > 1 else values[5] == 0),
                        "frequencies must increase; a single frequency needs a zero increment")
                require(len(frequencies) + count <= nec.MAX_FREQUENCIES, "too many frequencies")
                pending = [(values[4] + i*values[5])/1000 for i in range(count)]
                execution_started = True
            elif card in {"XQ", "RP"}:
                require(pending is not None, "execution request without a preceding FR")
                this_pattern = card == "RP"
                require(values == (_PATTERN if this_pattern else [0]), "unsupported execution or radiation-pattern request")
                integers(4 if this_pattern else 1)
                require(pattern is None or pattern == this_pattern, "mixed output requests cannot be represented")
                pattern = this_pattern
                frequencies.extend(pending)
                pending = None
            elif card == "EN":
                require(not values and pending is None and frequencies, "EN requires completed frequency requests and no fields")
                ended = True

    if not ended:
        raise ValueError("NEC input needs a final EN")
    model = nec.validate(dict(schema=nec.SCHEMA, name="Imported NEC wire model", wires=wires,
                              feed=feed, frequency_ghz=frequencies, reference_ohm=reference_ohm))
    return dict(model=model, pattern=pattern, report=dict(
        schema="fairbeam.nec-import/1", source_sha256=hashlib.sha256(raw).hexdigest(),
        source_bytes=len(raw), cards=cards, source_geometry_units="m", source_frequency_units="MHz",
        model_geometry_units="mm", model_frequency_units="GHz", reference_ohm=reference_ohm,
        reference_source="explicit import setting; not contained in the NEC deck",
        solver_run=False, numerically_validated=False, unsupported_cards_discarded=False))
