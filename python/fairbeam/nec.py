"""Bounded NEC-2 thin-wire models and external NEC2++ execution.

This is a separate free-space PEC wire model, never an implicit conversion of a
Fairbeam solid, substrate, strip, lumped port, or FDTD result. Units at the public
boundary are mm/GHz; NEC cards use m/MHz. See docs/NEC.md for capabilities.
"""
from __future__ import annotations

import copy
import csv
import hashlib
import json
import math
import os
import re
import subprocess
import time
import platform
from datetime import datetime, timezone
from pathlib import Path

from .procutil import popen_group, release_group, terminate_group

SCHEMA = "fairbeam.nec/1"
MAX_SEGMENTS = 399
MAX_FREQUENCIES = 81
C0 = 299792458.0


def _number(value, name, *, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number")
    try:
        number = float(value)
    except OverflowError:
        raise ValueError(f"{name} must be a finite number") from None
    if not math.isfinite(number):
        raise ValueError(f"{name} must be a finite number")
    if positive and number <= 0:
        raise ValueError(f"{name} must be positive")
    return number


def _integer(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"{name} must be an integer in {low}..{high}")
    return value


def _keys(value, allowed, required, name):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        raise ValueError(f"{name} has missing or unsupported fields; supported: {', '.join(allowed)}")


def _wire_separation(a, b):
    """Minimum distance of two closed center-line segments, in model units."""
    def sub(x, y):
        return [u - v for u, v in zip(x, y)]
    def dot(x, y):
        return sum(u * v for u, v in zip(x, y))
    p, q = a['start_mm'], b['start_mm']
    u, v, w = sub(a['end_mm'], p), sub(b['end_mm'], q), sub(p, q)
    aa, bb, cc, dd, ee = dot(u, u), dot(u, v), dot(v, v), dot(u, w), dot(v, w)
    clip = lambda x: min(1., max(0., x))
    candidates = [(0., clip(ee / cc)), (1., clip((ee + bb) / cc)),
                  (clip(-dd / aa), 0.), (clip((bb - dd) / aa), 1.)]
    determinant = aa * cc - bb * bb
    if determinant > 1e-12 * aa * cc:
        s, t = (bb * ee - cc * dd) / determinant, (aa * ee - bb * dd) / determinant
        if 0 <= s <= 1 and 0 <= t <= 1:
            candidates.append((s, t))
    return min(math.sqrt(sum((w[i] + s * u[i] - t * v[i]) ** 2 for i in range(3))) for s, t in candidates)


def _connections(wires):
    for i, a in enumerate(wires):
        for b in wires[i + 1:]:
            endpoints_a, endpoints_b = [a['start_mm'], a['end_mm']], [b['start_mm'], b['end_mm']]
            common = [p for p in endpoints_a if p in endpoints_b]
            if len(common) == 2:
                raise ValueError('duplicate or overlapping wire center lines')
            if common:
                p = common[0]
                u = [x - y for x, y in zip(next(x for x in endpoints_a if x != p), p)]
                v = [x - y for x, y in zip(next(x for x in endpoints_b if x != p), p)]
                cosine = sum(x * y for x, y in zip(u, v)) / math.hypot(*u) / math.hypot(*v)
                if cosine > .999999:
                    raise ValueError('overlapping wires at a shared endpoint')
                # A deliberately conservative junction subset for this adapter.
                if cosine > .5 or a['radius_mm'] != b['radius_mm']:
                    raise ValueError('connected wires need equal radii and a junction angle of at least 60 degrees')
            elif _wire_separation(a, b) <= a['radius_mm'] + b['radius_mm']:
                raise ValueError('wires touch or intersect away from an exact shared endpoint')


def validate(model: dict) -> dict:
    """Admit the explicit wire subset, reject unsupported physics before export/run."""
    _keys(model, ("schema", "name", "wires", "feed", "frequency_ghz", "reference_ohm"),
          ("schema", "wires", "feed", "frequency_ghz", "reference_ohm"), "NEC model")
    if model["schema"] != SCHEMA:
        raise ValueError(f"expected {SCHEMA}; general Design files cannot be converted implicitly")
    name = model.get("name", "Wire antenna")
    if not isinstance(name, str) or len(name) > 120 or any(ord(c) < 32 for c in name):
        raise ValueError("name must be a single line of at most 120 characters")
    freq = model["frequency_ghz"]
    if not isinstance(freq, list) or not 1 <= len(freq) <= MAX_FREQUENCIES:
        raise ValueError(f"provide 1..{MAX_FREQUENCIES} frequencies")
    freq = [_number(f, "frequency_ghz", positive=True) for f in freq]
    if any(b <= a for a, b in zip(freq, freq[1:])):
        raise ValueError("frequencies must be strictly increasing")
    if freq[-1] > 1000 or freq[0] < 1e-6:
        raise ValueError("frequencies must be within 1 kHz..1 THz")
    _number(model["reference_ohm"], "reference_ohm", positive=True)
    wires = model["wires"]
    if not isinstance(wires, list) or not 1 <= len(wires) <= MAX_SEGMENTS:
        raise ValueError("provide a nonempty bounded wire list")
    tags, total = set(), 0
    for wire in wires:
        _keys(wire, ("tag", "segments", "start_mm", "end_mm", "radius_mm"),
              ("tag", "segments", "start_mm", "end_mm", "radius_mm"), "wire")
        tag = _integer(wire["tag"], "wire tag", 1, 9999)
        if tag in tags:
            raise ValueError("wire tags must be unique")
        tags.add(tag)
        segments = _integer(wire["segments"], "segments", 1, MAX_SEGMENTS)
        total += segments
        for key in ("start_mm", "end_mm"):
            if not isinstance(wire[key], list) or len(wire[key]) != 3:
                raise ValueError(f"{key} must contain three coordinates")
            if any(abs(_number(v, key)) > 1e9 for v in wire[key]):
                raise ValueError("wire coordinates exceed the supported range")
        radius = _number(wire["radius_mm"], "radius_mm", positive=True)
        length = math.dist(wire["start_mm"], wire["end_mm"])
        segment_length = length / segments
        if segment_length < 8 * radius:
            raise ValueError("segment length must be at least 8 wire radii; refine radius/model, not just segmentation")
        wavelength_mm = C0 / (freq[-1] * 1e6)
        if segment_length > wavelength_mm / 20:
            raise ValueError("segment length exceeds wavelength/20 at the highest frequency")
    if total > MAX_SEGMENTS:
        raise ValueError(f"at most {MAX_SEGMENTS} total wire segments are supported")
    _connections(wires)
    feed = model["feed"]
    _keys(feed, ("tag", "segment"), ("tag", "segment"), "feed")
    tag = _integer(feed["tag"], "feed tag", 1, 9999)
    wire = next((w for w in wires if w["tag"] == tag), None)
    if wire is None:
        raise ValueError("feed tag does not identify a wire")
    _integer(feed["segment"], "feed segment", 1, wire["segments"])
    return copy.deepcopy(model)


def dipole(length_mm: float, radius_mm: float, segments: int, frequencies: list[float], reference_ohm=50.0) -> dict:
    """One straight PEC wire with an applied-field 1 V source on its center segment."""
    length = _number(length_mm, "length_mm", positive=True)
    _integer(segments, "segments", 3, MAX_SEGMENTS)
    if segments % 2 != 1:
        raise ValueError("a center-fed dipole needs an odd segment count")
    return validate({"schema": SCHEMA, "name": "Free-space thin-wire dipole", "frequency_ghz": frequencies,
                     "reference_ohm": reference_ohm,
                     "wires": [{"tag": 1, "segments": segments, "start_mm": [0, 0, -length / 2],
                                "end_mm": [0, 0, length / 2], "radius_mm": radius_mm}],
                     "feed": {"tag": 1, "segment": (segments + 1) // 2}})


def deck(model: dict, *, frequency_ghz: float | None = None, pattern=False) -> str:
    """Numeric NEC cards; no user strings enter command cards or comment lines."""
    model = validate(model)
    frequencies = model["frequency_ghz"]
    if frequency_ghz is not None:
        if frequency_ghz not in frequencies:
            raise ValueError("requested frequency is absent from the model")
        frequencies = [frequency_ghz]
    lines = ["CM Fairbeam PEC thin-wire model; free space; coordinates in meters", "CE"]
    for w in model["wires"]:
        coords = [*w["start_mm"], *w["end_mm"], w["radius_mm"]]
        lines.append(f"GW {w['tag']} {w['segments']} " + " ".join(format(x / 1000, ".12g") for x in coords))
    lines += ["GE 0", "GN -1", "EK 0", "PT -1"]
    feed = model["feed"]
    lines.append(f"EX 0 {feed['tag']} {feed['segment']} 0 1 0")
    for f in frequencies:
        lines.append(f"FR 0 1 0 0 {f * 1000:.12g} 0")
        # A complete sphere, including its seam. Output is a sampled pattern, not a peak guarantee.
        lines.append("RP 0 19 37 1000 0 0 10 10 0 0" if pattern else "XQ 0")
    lines.append("EN")
    return "\n".join(lines) + "\n"


def manifest(model: dict, text: str) -> dict:
    model = validate(model)
    return {"schema": "fairbeam.nec-export/1", "model": model,
            "deck_sha256": hashlib.sha256(text.encode("ascii")).hexdigest(),
            "geometry_units": "m", "frequency_units": "MHz", "ground": "free-space",
            "material": "PEC", "source": "applied-field voltage, 1 V real",
            "reference_ohm": model["reference_ohm"],
            "approximations": ["thin straight round wires", "finite segmentation", "ideal segment voltage source"],
            "solver_run": False, "numerically_validated": False}


def export(model: dict, directory: Path, *, pattern=False) -> Path:
    """Write into a new directory only. Never overwrite a user's previous export."""
    text = deck(model, pattern=pattern)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "model.nec").write_text(text, encoding="ascii", newline="\n")
    (directory / "manifest.json").write_text(json.dumps(manifest(model, text), indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return directory


_FLOAT = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][+-]?\d+)?"


def parse_output(text: str, model: dict, frequency: float, *, pattern=False) -> dict:
    """Read one NEC2++ text result, checking frequency, feed, and complete samples."""
    model = validate(model)
    if frequency not in model['frequency_ghz']:
        raise ValueError('output frequency was not requested by the model')
    if re.search(r"\b(?:nan|inf|infinity)\b|ERROR|FATAL", text, re.I):
        raise ValueError("NEC output contains an error or nonfinite value")
    found = re.findall(r"FREQUENCY\s*=\s*(" + _FLOAT + r")\s*MHZ", text)
    if len(found) != 1 or not math.isclose(float(found[0].replace('D', 'E').replace('d', 'e')), frequency * 1000, rel_tol=6e-5):
        raise ValueError("missing, duplicate, or unexpected NEC output frequency")
    sections = text.split("ANTENNA INPUT PARAMETERS")
    if len(sections) != 2:
        raise ValueError("expected exactly one antenna input section")
    rows = []
    for line in sections[1].splitlines():
        fields = line.split()
        if len(fields) == 11 and all(re.fullmatch(_FLOAT, f) for f in fields):
            rows.append([float(v.replace("D", "E").replace("d", "e")) for v in fields])
        elif rows:
            break
    if len(rows) != 1:
        raise ValueError("expected exactly one driven port record")
    row = rows[0]
    if not all(math.isfinite(v) for v in row):
        raise ValueError('nonfinite antenna input record')
    feed = model["feed"]
    absolute_segment = feed["segment"]
    for w in model["wires"]:
        if w["tag"] == feed["tag"]:
            break
        absolute_segment += w["segments"]
    if row[:2] != [feed["tag"], absolute_segment]:
        raise ValueError("output feed identity does not match the requested source")
    voltage, current, impedance = complex(*row[2:4]), complex(*row[4:6]), complex(*row[6:8])
    if abs(voltage - 1) > 1e-6 or abs(current) == 0 or impedance.real <= 0 or row[10] <= 0:
        raise ValueError("invalid voltage, current, impedance, or accepted power")
    if abs(voltage / current - impedance) > 5e-4 * max(1, abs(impedance)):
        raise ValueError("inconsistent NEC voltage/current and impedance")
    z0 = model["reference_ohm"]
    reflection = (impedance - z0) / (impedance + z0)
    if not all(math.isfinite(v) for v in (reflection.real, reflection.imag)) or abs(reflection) > 1 + 1e-9:
        raise ValueError('nonfinite or nonpassive reflection coefficient')
    expected_power = .5 * (voltage * current.conjugate()).real
    if not math.isclose(row[10], expected_power, rel_tol=.001, abs_tol=1e-15):
        raise ValueError('inconsistent accepted power and voltage/current')
    result = {"frequency_hz": frequency * 1e9, "impedance_ohm": [impedance.real, impedance.imag],
              "s11": [reflection.real, reflection.imag], "accepted_power_w": row[10]}
    if pattern:
        sections = text.split("RADIATION PATTERNS")
        if len(sections) != 2:
            raise ValueError("expected exactly one radiation pattern")
        samples = []
        for line in sections[1].splitlines():
            fields = line.split()
            # NEC2++ omits polarization sense at the printed gain floor. Retain
            # these nulls instead of discarding the pole rows or inventing gain.
            if len(fields) == 11 and all(re.fullmatch(_FLOAT, f) for f in fields) and fields[4] == '-999.99':
                fields.insert(7, 'UNDEFINED')
            if len(fields) == 12 and fields[7] in ("LINEAR", "RIGHT", "LEFT", "UNDEFINED"):
                try:
                    theta, phi, gain = float(fields[0]), float(fields[1]), float(fields[4])
                    et, ep = [float(v) for v in fields[8:10]], [float(v) for v in fields[10:12]]
                except ValueError as exc:
                    raise ValueError("invalid radiation pattern sample") from exc
                if not all(math.isfinite(v) for v in [theta, phi, gain, *et, *ep]) or et[0] < 0 or ep[0] < 0:
                    raise ValueError("invalid radiation pattern value")
                samples.append({"theta_deg": theta, "phi_deg": phi, "gain_dbi": None if gain == -999.99 else gain,
                                "gain_below_output_floor": gain == -999.99,
                                "e_theta_magnitude_phase": et, "e_phi_magnitude_phase": ep})
        expected = {(t, p) for p in range(0, 361, 10) for t in range(0, 181, 10)}
        if len(samples) != len(expected) or {(s["theta_deg"], s["phi_deg"]) for s in samples} != expected:
            raise ValueError("radiation pattern is incomplete or contains duplicate angles")
        result["pattern"] = samples
        gains = [s['gain_dbi'] for s in samples if s['gain_dbi'] is not None]
        if not gains:
            raise ValueError('radiation pattern has no resolved gain samples')
        result["sampled_peak_gain_dbi"] = max(gains)
    return result


def _execute(command, directory: Path, log: Path, deadline: float, cancel=None, watched=(), wall_deadline=None):
    """Own the process tree; bound elapsed time and output, retain logs on failure."""
    env = {**os.environ, "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"}
    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    if wall_deadline is None:
        wall_deadline = time.time() + max(0, deadline - time.monotonic())
    def check():
        if cancel is not None and cancel():
            raise InterruptedError("NEC solve cancelled")
        if time.monotonic() >= deadline or time.time() >= wall_deadline:
            raise TimeoutError("NEC wall-time budget exhausted")
        if any(p.exists() and p.stat().st_size > 8 * 1024 * 1024 for p in (log, *watched)):
            raise ValueError("NEC output exceeds the 8 MiB per-file limit")
    check()
    with log.open("xb") as stream:
        proc = popen_group(command, cwd=directory, stdin=subprocess.DEVNULL,
                           stdout=stream, stderr=subprocess.STDOUT, env=env, **kwargs)
        try:
            while True:
                check()
                try:
                    code = proc.wait(timeout=min(0.1, max(0.001, deadline - time.monotonic())))
                except subprocess.TimeoutExpired:
                    continue
                check()
                if code != 0:
                    raise RuntimeError(f"NEC2++ exited with status {code}; see {log.name}")
                break
        finally:
            if proc.poll() is None:
                terminate_group(proc.pid, grace=0, job=proc.win_job)
                proc.wait(timeout=15)
            release_group(proc)


def solve(model: dict, directory: Path, executable: Path, *, timeout=30.0, pattern=False, cancel=None) -> dict:
    """Run an explicitly selected NEC2++ executable. Failed captures are retained."""
    model = validate(model)
    timeout = _number(timeout, "timeout", positive=True)
    if timeout > 1800:
        raise ValueError("NEC runs are limited to 1800 seconds")
    executable = Path(executable).resolve(strict=True)
    if not executable.is_file():
        raise ValueError("NEC2++ executable must be a file")
    directory = export(model, directory, pattern=pattern).resolve()
    started, wall_started = time.monotonic(), time.time()
    deadline = started + timeout
    with executable.open('rb') as stream:
        executable_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
    receipt = {"schema": "fairbeam.nec-run/1", "state": "running", "model": model,
               "started_utc": datetime.now(timezone.utc).isoformat(),
               "host": {"os": platform.platform(), "machine": platform.machine()},
               "adapter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "acceleration": "CPU; no GPU requested", "port_indices": [1],
               "solver": {"name": "NEC2++", "executable": str(executable),
                          "sha256": executable_hash},
               "timeout_s": timeout, "threads_requested": 1,
               "numerically_validated": False, "samples": []}
    def save():
        receipt["wall_time_s"] = max(time.monotonic() - started, time.time() - wall_started)
        receipt["updated_utc"] = datetime.now(timezone.utc).isoformat()
        temporary = directory / "run.json.tmp"
        temporary.write_text(json.dumps(receipt, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        temporary.replace(directory / "run.json")
    save()
    try:
        version_log = directory / "version.log"
        _execute([str(executable), "-v"], directory, version_log, min(deadline, started + 10), cancel,
                 wall_deadline=wall_started + min(timeout, 10))
        version = version_log.read_text(encoding="utf-8", errors="replace").strip()
        if not re.match(r"nec2\+\+ 2\.3\.4\b", version) or len(version) > 1000:
            raise ValueError("this adapter requires NEC2++ 2.3.4; unrecognized solver/version")
        receipt["solver"]["version"] = version
        for i, frequency in enumerate(model["frequency_ghz"]):
            inp, out, log = (directory / f"f{i:03d}{suffix}" for suffix in (".nec", ".out", ".log"))
            inp.write_text(deck(model, frequency_ghz=frequency, pattern=pattern), encoding="ascii", newline="\n")
            _execute([str(executable), "-i", inp.name, "-o", out.name], directory, log, deadline, cancel, (out,),
                     wall_deadline=wall_started + timeout)
            if not out.is_file() or out.stat().st_size > 8 * 1024 * 1024:
                raise ValueError("NEC output is missing or too large")
            sample = parse_output(out.read_text(encoding="ascii", errors="strict"), model, frequency, pattern=pattern)
            sample["output_sha256"] = hashlib.sha256(out.read_bytes()).hexdigest()
            receipt["samples"].append(sample)
            save()
        with (directory / 's11.csv').open('x', encoding='ascii', newline='') as stream:
            writer = csv.writer(stream)
            writer.writerow(['frequency_hz', 'port_i', 'port_j', 's_real', 's_imag', 'z_real_ohm', 'z_imag_ohm', 'reference_ohm'])
            for s in receipt['samples']:
                writer.writerow([s['frequency_hz'], 1, 1, *s['s11'], *s['impedance_ohm'], model['reference_ohm']])
        receipt['s11_csv_sha256'] = hashlib.sha256((directory/'s11.csv').read_bytes()).hexdigest()
        if max(time.monotonic() - started, time.time() - wall_started) >= timeout:
            raise TimeoutError('NEC wall-time budget exhausted during result validation')
        receipt["state"] = "completed"
        save()
        return receipt
    except BaseException as exc:
        receipt["state"] = "cancelled" if isinstance(exc, (InterruptedError, KeyboardInterrupt)) else "failed"
        receipt["error"] = str(exc)
        save()
        raise


def optimize_dipole(length_bounds: tuple[float, float], radius_mm: float, segments: int,
                    frequency_ghz: float, directory: Path, executable: Path, *,
                    reference_ohm=50.0, target_db=-15.0, max_evals=12, timeout=300.0, cancel=None) -> dict:
    """Use Fairbeam's bounded optimizer with actual NEC evaluations of dipole length.

    A single-frequency matching goal is deliberately separate from radiation
    quality or segmentation convergence. Every candidate keeps its own capture.
    """
    from .optimize import Goal, Vary, optimize
    lo, hi = length_bounds
    vary = Vary("length_mm", _number(lo, "minimum length", positive=True),
                _number(hi, "maximum length", positive=True))
    target_db = _number(target_db, "target_db")
    if target_db >= 0 or target_db < -60:
        raise ValueError("target_db must be within -60..0 dB, excluding 0")
    _integer(max_evals, "max_evals", 1, 30)
    timeout = _number(timeout, "timeout", positive=True)
    if timeout > 1800:
        raise ValueError("optimization wall-time budget cannot exceed 1800 seconds")
    for length in length_bounds:
        dipole(length, radius_mm, segments, [frequency_ghz], reference_ohm)
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    started, wall_started, count = time.monotonic(), time.time(), 0
    def evaluate(params):
        nonlocal count
        remaining = timeout - max(time.monotonic() - started, time.time() - wall_started)
        if remaining <= 0 or (cancel is not None and cancel()):
            raise KeyboardInterrupt("NEC optimization cancelled or wall-time budget exhausted")
        capture = directory / f"evaluation-{count:03d}"
        count += 1
        model = dipole(params["length_mm"], radius_mm, segments, [frequency_ghz], reference_ohm)
        try:
            result = solve(model, capture, executable, timeout=min(30, remaining), cancel=cancel)
        except InterruptedError as exc:
            raise KeyboardInterrupt(str(exc)) from exc  # do not penalize cancellation and continue searching
        reflection = complex(*result["samples"][0]["s11"])
        db = 20 * math.log10(max(abs(reflection), 1e-15))
        return {"metrics": {"s11_at": {f"{frequency_ghz:g}": db}},
                "file": f"{capture.name}/run.json", "wall_time_s": result["wall_time_s"]}
    report = {"schema": "fairbeam.nec-optimization/1", "state": "running", "numerically_validated": False,
              "frequency_ghz": frequency_ghz, "radius_mm": radius_mm, "segments": segments,
              "length_bounds_mm": list(length_bounds), "target_db": target_db,
              "reference_ohm": reference_ohm, "evaluations": []}
    def save(evaluation=None):
        if evaluation is not None:
            report["evaluations"].append(evaluation)
        report["wall_time_s"] = max(time.monotonic() - started, time.time() - wall_started)
        (directory / "optimization.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    save()
    try:
        report["result"] = optimize([vary], [Goal("s11_max", target_db, at=frequency_ghz)], evaluate,
                                    method="nelder-mead", max_evals=max_evals, on_eval=save)
        report["state"] = "completed" if report["result"].get("best") is not None else "failed"
        save()
        return report
    except BaseException as exc:
        report.update(state="cancelled" if isinstance(exc, (KeyboardInterrupt, InterruptedError)) else "failed", error=str(exc))
        save()
        raise


def add_commands(sub):
    """CLI-only opt-in entry points; no solver download or launch during import."""
    p = sub.add_parser("nec-import", help="import an explicit numeric free-space PEC wire deck without solving")
    p.add_argument("source", type=Path)
    p.add_argument("--reference-ohm", type=float, default=50, help="S11 reference, not stored in NEC cards")
    p.add_argument("--out", type=Path, required=True, help="new capture directory")
    p.set_defaults(func=_cmd_import)
    p = sub.add_parser("nec-dipole", help="export or solve a free-space PEC thin-wire dipole with NEC2++")
    p.add_argument("--length-mm", type=float, required=True)
    p.add_argument("--radius-mm", type=float, required=True)
    p.add_argument("--segments", type=int, default=31)
    p.add_argument("--frequency-ghz", type=float, nargs="+", required=True)
    p.add_argument("--reference-ohm", type=float, default=50)
    p.add_argument("--out", type=Path, required=True, help="new capture directory")
    p.add_argument("--solver", type=Path, help="NEC2++ 2.3.4 executable; omit to export only")
    p.add_argument("--pattern", action="store_true", help="request a complete 10-degree sampled pattern")
    p.add_argument("--timeout", type=float, default=30, help="whole solve wall seconds (maximum 1800)")
    p.set_defaults(func=_cmd_dipole)
    p = sub.add_parser("nec-run", help="solve an explicit fairbeam.nec/1 wire model with NEC2++")
    p.add_argument("model", type=Path)
    p.add_argument("--solver", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--pattern", action="store_true")
    p.add_argument("--timeout", type=float, default=30)
    p.set_defaults(func=_cmd_run)
    p = sub.add_parser("nec-optimize", help="optimize thin-wire dipole length for a single-frequency matching goal")
    p.add_argument("--length-mm", type=float, nargs=2, required=True, metavar=("MIN", "MAX"))
    p.add_argument("--radius-mm", type=float, required=True)
    p.add_argument("--segments", type=int, default=31)
    p.add_argument("--frequency-ghz", type=float, required=True)
    p.add_argument("--reference-ohm", type=float, default=50)
    p.add_argument("--target-db", type=float, default=-15)
    p.add_argument("--max-evals", type=int, default=12)
    p.add_argument("--timeout", type=float, default=300)
    p.add_argument("--solver", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.set_defaults(func=_cmd_optimize)


def _cli_call(call):
    import sys
    try:
        result = call()
    except (InterruptedError, KeyboardInterrupt) as exc:
        print(f"fairbeam NEC: {exc}", file=sys.stderr)
        return 130
    except (OSError, RuntimeError) as exc:
        print(f"fairbeam NEC: {exc}", file=sys.stderr)
        return 2
    if isinstance(result, dict) and result.get("state") == "failed":
        return 2
    return 0


def _cmd_dipole(args):
    model = dipole(args.length_mm, args.radius_mm, args.segments, args.frequency_ghz, args.reference_ohm)
    return _cli_call(lambda: solve(model, args.out, args.solver, timeout=args.timeout, pattern=args.pattern)
                     if args.solver else export(model, args.out, pattern=args.pattern))


def _cmd_import(args):
    from .nec_import import import_file
    return _cli_call(lambda: import_file(args.source, args.out, reference_ohm=args.reference_ohm))


def _cmd_run(args):
    def run():
        if args.model.stat().st_size > 1024 * 1024:
            raise ValueError("NEC model exceeds 1 MiB")
        model = json.loads(args.model.read_text(encoding="utf-8"))
        return solve(model, args.out, args.solver, timeout=args.timeout, pattern=args.pattern)
    return _cli_call(run)


def _cmd_optimize(args):
    return _cli_call(lambda: optimize_dipole(tuple(args.length_mm), args.radius_mm, args.segments,
                                           args.frequency_ghz, args.out, args.solver,
                                           reference_ohm=args.reference_ohm, target_db=args.target_db,
                                           max_evals=args.max_evals, timeout=args.timeout))
