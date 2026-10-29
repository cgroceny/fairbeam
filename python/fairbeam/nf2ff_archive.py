"""Owned, hash-bound NF2FF inputs for immutable post-run transforms.

This module does not import a native solver. Admission and file ownership are
separate from the small native adapter in nf2ff_postprocess. Old raw folders are
not adopted: only a successful run can create a retained manifest.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import stat
import sys
import uuid
import threading
from contextlib import contextmanager

from ._filelocks import model_lock

SCHEMA = "fairbeam.nf2ff-retained/1"
MANIFEST = "nf2ff-retained.json"
MAX_FREQUENCIES = 16
MAX_CELLS = 65536
MAX_TOTAL_CELLS = 262144
_RAW_MUTEX = threading.RLock()
_RAW_DEPTH = threading.local()


def encode(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _linked(path: Path) -> bool:
    st = path.lstat()
    return stat.S_ISLNK(st.st_mode) or bool(getattr(st, "st_file_attributes", 0)
                                         & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def safe_root(path: str | Path) -> Path:
    p = Path(path).absolute()
    # Ownership starts here. System/user aliases above this folder (for example
    # macOS /var and /tmp) are allowed, but the owned root itself must be real.
    if os.path.lexists(p) and _linked(p):
        raise ValueError("retained NF2FF paths cannot traverse links or reparse points")
    if not p.is_dir():
        raise ValueError("retained NF2FF folder is missing; run again with retention enabled")
    return p.resolve()


def safe_file(root: Path, relative: str, *, exists=True) -> Path:
    if not isinstance(relative, str):
        raise ValueError("invalid retained NF2FF relative path")
    part = Path(relative)
    if (not isinstance(relative, str) or not relative or part.is_absolute() or part.drive
            or "\\" in relative or any(v in ("", ".", "..") for v in relative.split("/"))):
        raise ValueError("invalid retained NF2FF relative path")
    # Validate the original root before resolving aliases (including Windows
    # short paths), then check every component inside that canonical root.
    root = safe_root(root)
    path = root / part
    for ancestor in [*reversed(path.parents), path]:
        if ancestor == root or root in ancestor.parents:
            if os.path.lexists(ancestor) and _linked(ancestor):
                raise ValueError("retained NF2FF file traverses a link or reparse point")
    if root not in path.resolve().parents:
        raise ValueError("retained NF2FF file escapes its owned folder")
    if exists and not path.is_file():
        raise ValueError("retained NF2FF input is missing; run again")
    return path


@contextmanager
def raw_lock(root=None):
    """Serialize transforms with ancestor-folder cleanup across processes."""
    if not _RAW_MUTEX.acquire(timeout=30):
        raise TimeoutError("raw simulation data is in use; retry shortly")
    try:
        depth = getattr(_RAW_DEPTH, "value", 0)
        _RAW_DEPTH.value = depth + 1
        if depth:
            yield
        else:
            with model_lock(("retained-nf2ff", "raw-data-ownership")):
                yield
    finally:
        _RAW_DEPTH.value = getattr(_RAW_DEPTH, "value", 1) - 1
        _RAW_MUTEX.release()


def write_new(path: Path, data: bytes) -> None:
    """Atomic no-clobber publication, including against a final-name symlink."""
    path.parent.mkdir(parents=True, exist_ok=True)
    stage = path.parent / ("." + path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with stage.open("xb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.link(stage, path, follow_symlinks=False)
    finally:
        stage.unlink(missing_ok=True)


def source_identity(source_bytes: bytes, values: dict) -> str:
    return digest(encode({"input_sha256": digest(source_bytes), "resolved_parameters": values}))


def runtime_identity() -> dict:
    """Fingerprint loaded bindings and the configured native library directory.

    Called only after a real run/transform has loaded its runtime. No solver is
    imported here, and private key/environment values are never recorded.
    """
    paths = {}
    for name in ("openEMS", "openEMS.openEMS", "openEMS._nf2ff", "openEMS.nf2ff",
                 "openEMS.utilities", "CSXCAD", "CSXCAD.CSXCAD", "numpy", "h5py"):
        module = sys.modules.get(name)
        filename = getattr(module, "__file__", None)
        if filename and Path(filename).is_file():
            paths["module:" + name] = file_digest(Path(filename))
    if not all("module:" + name in paths for name in ("openEMS._nf2ff", "openEMS.nf2ff")):
        raise ValueError("loaded NF2FF runtime identity is unavailable")
    prefix = os.environ.get("OPENEMS_INSTALL_PATH") or os.environ.get("CSXCAD_INSTALL_PATH")
    if prefix:
        base = Path(prefix)
        for folder in (base, base / "bin", base / "lib", base / "lib64"):
            if folder.is_dir():
                for path in sorted(folder.iterdir()):
                    if path.is_file() and (path.suffix.lower() in (".dll", ".dylib") or ".so" in path.name):
                        paths["native:" + path.relative_to(base).as_posix()] = file_digest(path)
    if not any(k.startswith("native:") for k in paths):
        raise ValueError("configure the original native installation path to retain/reuse NF2FF data")
    for name in ("simulation.py", "multiport.py", "farfield_fields.py", "pattern_grid.py", "nf2ff_archive.py", "nf2ff_postprocess.py"):
        paths["postprocessor:" + name] = file_digest(Path(__file__).with_name(name))
    return {"python": list(sys.version_info[:3]), "files": paths,
            "native_scope": "configured native library files plus loaded Python bindings"}


def recording_descriptor(sim) -> dict | None:
    """Capture BEFORE CalcNF2FF overwrites the recording object's frequency list."""
    box = sim.nf2ff
    if box is None:
        return None
    import numpy as np
    from .simulation import _center
    mesh = {a: np.asarray(sim.mesh.GetLines(a), dtype=float).tolist() for a in "xyz"}
    recording = {"name": str(box.name), "e_file": str(box.e_file), "h_file": str(box.h_file),
                 "start": np.asarray(box.start, dtype=float).tolist(), "stop": np.asarray(box.stop, dtype=float).tolist(),
                 "directions": [bool(x) for x in box.directions], "mirror": [int(x) for x in box.mirror],
                 "dump_type": int(box.dump_type),
                 "dump_mode": int(box.dump_mode),
                 "frequencies": [] if box.dump_type == 0 else np.atleast_1d(box.freq).astype(float).tolist()}
    center = sim.nf2ff_center if sim.nf2ff_center is not None else _center(sim)
    return {"recording": recording, "mesh": mesh, "mesh_sha256": digest(encode(mesh)),
            "unit_m": float(sim.unit), "band_hz": [float(sim.f_min), float(sim.f_max)],
            "phase_center_m": (np.asarray(center, dtype=float) * sim.unit).tolist(),
            "boundaries": list(sim.boundaries), "complex_fields": bool(sim.complex_field_outputs),
            "circular": bool(sim.cp_outputs), "lossless": bool(sim._is_lossless())}


def hdf5_descriptor(path: Path, expected_type: int, unit: float) -> dict:
    """Read metadata only; FD attributes follow the installed openEMS utilities reader."""
    import h5py
    import numpy as np
    def child(group, key):
        if key not in group or not isinstance(group.get(key, getlink=True), h5py.HardLink):
            raise ValueError("NF2FF HDF5 requires local hard-linked groups and datasets")
        return group[key]
    with h5py.File(path, "r") as f:
        if int(f.attrs.get("dump_type", -1)) != expected_type:
            raise ValueError("NF2FF E/H recording type mismatch")
        mesh = child(f, "Mesh")
        if int(mesh.attrs.get("mesh_type", -1)) != 0 or float(mesh.attrs.get("mesh_scaling", float("nan"))) != unit:
            raise ValueError("NF2FF supports the original Cartesian mesh and exact unit only")
        def local_dataset(group, name):
            ds = child(group, name)
            if not isinstance(ds, h5py.Dataset) or ds.is_virtual or ds.external:
                raise ValueError("NF2FF datasets cannot refer to external or virtual storage")
            return ds
        axes = {a: np.asarray(local_dataset(mesh, a), dtype=float).tolist() for a in "xyz"}
        if any(not x or any(not math.isfinite(v) for v in x) or any(b <= a for a, b in zip(x, x[1:])) for x in axes.values()):
            raise ValueError("invalid NF2FF recording mesh")
        data = child(f, "FieldData")
        mode = "TD" if expected_type in (0, 1) else "FD"
        if set(data.keys()) != {mode}:
            raise ValueError("mixed or missing NF2FF recording domain")
        values = child(data, mode)
        names = sorted(values.keys())
        if not names or len(names) > 1000000:
            raise ValueError("empty or excessive NF2FF recording dataset count")
        times, freqs = [], []
        for name in names:
            ds = local_dataset(values, name)
            order = ds.attrs.get("d_order", "")
            if isinstance(order, bytes):
                order = order.decode("ascii", errors="strict")
            if (not isinstance(ds, h5py.Dataset) or order not in ("NXYZ", "NZYX")
                    or ds.dtype.kind not in "fc" or ds.shape != (3, *[len(axes[a]) for a in ("xyz" if order == "NXYZ" else "zyx")])):
                raise ValueError("invalid NF2FF vector dataset")
            if mode == "TD":
                t = np.asarray(ds.attrs.get("time", []), dtype=float).reshape(-1)
                if t.size != 1 or not np.isfinite(t[0]):
                    raise ValueError("missing NF2FF time sample")
                times.append(float(t[0]))
            elif name.startswith("f") and not name.endswith("_imag"):
                stem = name[1:].removesuffix("_real")
                if not stem.isdigit():
                    raise ValueError("invalid frequency-domain NF2FF dataset name")
                if name.endswith("_real") and name[:-5] + "_imag" not in values:
                    raise ValueError("incomplete frequency-domain NF2FF complex pair")
                frequency = np.asarray(ds.attrs.get("frequency", []), dtype=float).reshape(-1)
                if frequency.size == 1:
                    freqs.append((int(stem), float(frequency[0])))
        result = {"domain": mode, "mesh_sha256": digest(encode(axes)), "datasets": len(names)}
        if mode == "TD":
            if len(times) < 2 or any(b <= a for a, b in zip(times, times[1:])):
                raise ValueError("NF2FF times must be increasing")
            result.update(time_range=[times[0], times[-1]], nyquist_hz=1 / (2 * max(b - a for a, b in zip(times, times[1:]))))
        else:
            import re
            if any(not re.fullmatch(r"f[0-9]+(?:_real|_imag)?", n) for n in names):
                raise ValueError("invalid FD dataset name")
            for name in names:
                if name.endswith("_imag") and name[:-5] + "_real" not in values:
                    raise ValueError("incomplete FD complex pair")
            frequencies = np.asarray(values.attrs.get("frequency", [v for _, v in sorted(freqs)]), dtype=float).reshape(-1).tolist()
            if not frequencies or any(not math.isfinite(v) or v <= 0 for v in frequencies) or len(set(frequencies)) != len(frequencies):
                raise ValueError("missing or ambiguous recorded FD frequencies")
            indices = sorted({int(n[1:].removesuffix("_real").removesuffix("_imag")) for n in names if n.startswith("f")})
            if indices != list(range(len(frequencies))):
                raise ValueError("FD frequencies do not match the stored datasets")
            result["frequencies"] = frequencies
        return result


def validate_descriptor(d: dict) -> None:
    """Reject unsupported source metadata before opening native code."""
    def finite_list(v, n=None):
        return (isinstance(v, list) and (n is None or len(v) == n) and bool(v)
                and all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in v))
    r = d["recording"]
    if (r["dump_type"] not in (0, 10) or r["dump_mode"] != 1
            or not finite_list(r["start"], 3) or not finite_list(r["stop"], 3)
            or any(a >= b for a, b in zip(r["start"], r["stop"]))
            or not isinstance(r["directions"], list) or len(r["directions"]) != 6
            or any(type(v) is not bool for v in r["directions"]) or not any(r["directions"])
            or not isinstance(r["mirror"], list) or len(r["mirror"]) != 6
            or any(type(v) is not int or v not in (0, 1, 2) for v in r["mirror"])):
        raise ValueError("unsupported NF2FF recording geometry or mode")
    for name in (r["name"], r["e_file"], r["h_file"]):
        if not isinstance(name, str) or not name or name in (".", "..") or any(c in name for c in "/\\:"):
            raise ValueError("invalid NF2FF recording filename")
    if r["e_file"] == r["h_file"]:
        raise ValueError("E and H recordings must be distinct")
    if (not finite_list(d["band_hz"], 2) or not 0 < d["band_hz"][0] < d["band_hz"][1]
            or not isinstance(d["unit_m"], (int, float)) or not math.isfinite(d["unit_m"]) or d["unit_m"] <= 0
            or not finite_list(d["phase_center_m"], 3)):
        raise ValueError("invalid original excitation band, unit or phase center")
    if any(not a * d["unit_m"] <= c <= b * d["unit_m"] for a, b, c in zip(r["start"], r["stop"], d["phase_center_m"])):
        raise ValueError("original phase center is outside the recording box")
    if (r["dump_type"] == 0 and r["frequencies"] != []) or (r["dump_type"] == 10 and (not finite_list(r["frequencies"]) or any(f <= 0 for f in r["frequencies"]))):
        raise ValueError("invalid recording frequencies")
    mesh = d["mesh"]
    if set(mesh) != set("xyz") or any(not finite_list(mesh[a]) or any(b <= c for c, b in zip(mesh[a], mesh[a][1:])) for a in "xyz"):
        raise ValueError("invalid original full mesh")
    if digest(encode(mesh)) != d["mesh_sha256"]:
        raise ValueError("original mesh hash mismatch")
    n = d["network"]
    if (not finite_list(n["frequency_hz"]) or len(n["frequency_hz"]) < 2
            or any(b <= a for a, b in zip(n["frequency_hz"], n["frequency_hz"][1:]))
            or any(not finite_list(n[k], len(n["frequency_hz"])) for k in ("pacc_w", "gamma2"))):
        raise ValueError("original port power measurements are missing or non-finite")


def retain(raw_root: Path, parent_path: Path, source_bytes: bytes, source_name: str, values: dict,
           sources: list[dict], *, runtime=None) -> dict:
    root = safe_root(raw_root)
    if not sources or len(sources) > 32:
        raise ValueError("retention needs 1–32 recorded driven ports")
    if (root / MANIFEST).exists():
        raise ValueError("retained NF2FF source already exists; use a new run name")
    if any(type(s.get("port")) is not int or s["port"] <= 0 for s in sources) or len({s["port"] for s in sources}) != len(sources):
        raise ValueError("retained driven ports must be distinct positive integers")
    records = []
    for source in sources:
        descriptor = source["descriptor"]
        validate_descriptor(descriptor)
        recording = descriptor["recording"]
        # Keep the spelling below the owned root until safe_file has checked it:
        # resolving a per-port directory here would hide an internal link.
        directory = Path(source["path"]).absolute()
        try:
            relative_dir = directory.relative_to(Path(raw_root).absolute()).as_posix()
        except ValueError:
            relative_dir = directory.relative_to(root).as_posix()
        relative_dir = "" if relative_dir == "." else relative_dir + "/"
        actual = []
        for n, enabled in enumerate(recording["directions"]):
            for prefix, kind in ((recording["e_file"], recording["dump_type"]), (recording["h_file"], recording["dump_type"] + 1)):
                relative = f"{relative_dir}{prefix}_{n}.h5"
                path = safe_file(root, relative, exists=enabled)
                if not enabled:
                    if path.exists():
                        raise ValueError("unexpected disabled-face NF2FF dump")
                    continue
                info = hdf5_descriptor(path, kind, descriptor["unit_m"])
                if info["domain"] == "FD" and info["frequencies"] != recording["frequencies"]:
                    raise ValueError("FD dump frequencies differ from the original recording request")
                actual.append({"path": relative, "bytes": path.stat().st_size, "sha256": file_digest(path), **info})
        if not actual:
            raise ValueError("no enabled NF2FF recording faces")
        records.append({"port": source["port"], "directory": relative_dir.rstrip("/"), "descriptor": descriptor, "files": actual})
    parent = parent_path.read_bytes()
    parsed = json.loads(parent)
    manifest = {"schema": SCHEMA, "root": str(root), "parent": {"filename": parent_path.name, "sha256": digest(parent)},
                "source": {"name": Path(source_name).name, "sha256": digest(source_bytes), "identity": source_identity(source_bytes, values), "parameters": values},
                "model_id": parsed.get("model", {}).get("id"), "generator": parsed.get("generator"),
                "runtime": runtime if runtime is not None else runtime_identity(), "ports": records}
    write_new(root / "retained-input.snapshot", source_bytes)
    write_new(root / "retained-parent.json", parent)
    write_new(root / MANIFEST, encode(manifest))
    return manifest


def load_verified(raw_root: Path, *, expected_sha256: str, parent_path: Path | None = None, runtime=None) -> tuple[dict, dict, str]:
    root = safe_root(raw_root)
    path = safe_file(root, MANIFEST)
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("NF2FF manifest exceeds the metadata budget")
    data = path.read_bytes()
    if not isinstance(expected_sha256, str) or len(expected_sha256) != 64 or digest(data) != expected_sha256:
        raise ValueError("retained NF2FF manifest differs from the original run receipt")
    m = json.loads(data)
    if m.get("schema") != SCHEMA or m.get("root") != str(root):
        raise ValueError("NF2FF archive is not owned by this original run folder")
    parent = safe_file(root, "retained-parent.json").read_bytes()
    source = safe_file(root, "retained-input.snapshot").read_bytes()
    if digest(parent) != m["parent"]["sha256"] or digest(source) != m["source"]["sha256"]:
        raise ValueError("NF2FF source snapshot hash mismatch; run again")
    if source_identity(source, m["source"]["parameters"]) != m["source"]["identity"]:
        raise ValueError("NF2FF resolved source identity mismatch")
    if parent_path is not None and file_digest(parent_path) != m["parent"]["sha256"]:
        raise ValueError("original result changed; retained NF2FF cannot be attached to it")
    if (runtime if runtime is not None else runtime_identity()) != m["runtime"]:
        raise ValueError("NF2FF runtime changed; use the original runtime or run again")
    ports = m.get("ports")
    if not isinstance(ports, list) or not 1 <= len(ports) <= 32 or len({p.get("port") for p in ports}) != len(ports):
        raise ValueError("invalid retained driven-port set")
    for port in ports:
        d = port["descriptor"]
        validate_descriptor(d)
        if digest(encode(d["mesh"])) != d["mesh_sha256"]:
            raise ValueError("NF2FF mesh identity mismatch")
        for f in port["files"]:
            path = safe_file(root, f["path"])
            if path.stat().st_size != f["bytes"] or file_digest(path) != f["sha256"]:
                raise ValueError("NF2FF raw input hash mismatch; run again")
        r = d["recording"]
        prefix = port["directory"] + "/" if port["directory"] else ""
        expected = {f"{prefix}{name}_{i}.h5" for i, enabled in enumerate(r["directions"]) if enabled for name in (r["e_file"], r["h_file"])}
        if len(port["files"]) != len(expected) or {f["path"] for f in port["files"]} != expected:
            raise ValueError("retained E/H face set is incomplete")
        for i, enabled in enumerate(r["directions"]):
            if not enabled and any(safe_file(root, f"{prefix}{name}_{i}.h5", exists=False).exists() for name in (r["e_file"], r["h_file"])):
                raise ValueError("unexpected NF2FF file could alter the original recording surface")
    bundle = json.loads(parent)
    if bundle.get("model", {}).get("id") != m.get("model_id"):
        raise ValueError("NF2FF parent model identity mismatch")
    return m, bundle, digest(data)


def admit_request(manifest: dict, frequencies, theta_step=3, phi_step=5) -> dict:
    from .pattern_grid import angular_grid, pattern_steps
    if not isinstance(frequencies, list) or not 1 <= len(frequencies) <= MAX_FREQUENCIES:
        raise ValueError("request 1–16 retained far-field frequencies")
    if any(isinstance(f, bool) or not isinstance(f, (int, float)) or not math.isfinite(f) or f <= 0 for f in frequencies):
        raise ValueError("far-field frequencies must be finite positive Hz")
    if len(set(frequencies)) != len(frequencies):
        raise ValueError("far-field frequencies must be distinct")
    ts, ps = pattern_steps(theta_step, phi_step)
    theta, phi = angular_grid(ts, ps)
    if len(theta) * len(phi) > MAX_CELLS or len(theta) * len(phi) * len(frequencies) > MAX_TOTAL_CELLS:
        raise ValueError("post-run far-field angular/frequency budget exceeded")
    for port in manifest["ports"]:
        lo, hi = port["descriptor"]["band_hz"]
        if any(not lo <= f <= hi for f in frequencies):
            raise ValueError("requested frequency lies outside the original excitation band")
        for raw in port["files"]:
            if raw["domain"] == "TD" and any(f > raw["nyquist_hz"] * (1 + 1e-12) for f in frequencies):
                raise ValueError("requested frequency exceeds retained time-sample Nyquist limit")
            if raw["domain"] == "FD" and any(f not in raw["frequencies"] for f in frequencies):
                raise ValueError("frequency-domain dumps support only their recorded frequencies")
    return {"frequencies_hz": [float(f) for f in frequencies], "theta_step": ts, "phi_step": ps}
