"""Immutable far-field transforms of owned, retained raw data. Never runs FDTD."""
from __future__ import annotations

import copy
from pathlib import Path
import tempfile
import time

from . import nf2ff_archive as archive


def _runtime():
    # Match imports used by the original Simulation; no Simulation is built and
    # no model code is loaded. CalcNF2FF is the only native computation below.
    from . import simulation  # noqa: F401
    from openEMS import nf2ff  # noqa: F401
    return archive.runtime_identity()


def native_transform(root: Path, port: dict, request: dict, output: Path) -> list[dict]:
    import numpy as np
    from openEMS.nf2ff import nf2ff
    from .pattern_grid import angular_grid
    from .simulation import Simulation, _circular, _r, _pattern_directivity, _efficiency_warning, mirror_planes
    from .farfield_fields import encode_farfield_fields

    d = port["descriptor"]
    r = d["recording"]
    box = nf2ff.__new__(nf2ff)
    # Restore only the recorded adapter fields. Calling __init__ would create
    # dumps in a new CSX model; that is deliberately excluded from this path.
    for key in ("name", "start", "stop", "directions", "mirror", "e_file", "h_file", "dump_type", "dump_mode"):
        setattr(box, key, copy.deepcopy(r[key]))
    theta, phi = angular_grid(request["theta_step"], request["phi_step"])
    frequencies = request["frequencies_hz"]
    res = box.CalcNF2FF(str(root / port["directory"]), frequencies, theta, phi,
                       center=d["phase_center_m"], radius=1.0, outfile=str(output.resolve()), read_cached=False)
    mirrors = mirror_planes(d["boundaries"])
    factor = 2.0 ** mirrors
    network = d["network"]
    entries = []
    for i, frequency in enumerate(frequencies):
        e = np.asarray(res.E_norm[i], dtype=float)
        dmax = float(res.Dmax[i]) * factor
        prad = float(res.Prad[i]) / factor
        if (e.shape != (len(theta), len(phi)) or not np.all(np.isfinite(e))
                or np.any(e < 0) or not e.max() > 0 or not np.isfinite(dmax) or dmax <= 0
                or not np.isfinite(prad) or prad < 0):
            raise ValueError("NF2FF transform produced invalid radiation values")
        with np.errstate(divide="ignore"):
            grid = np.maximum(20 * np.log10(e / e.max()) + 10 * np.log10(dmax), 10 * np.log10(dmax) - 60)
        pacc = float(np.interp(frequency, network["frequency_hz"], network["pacc_w"]))
        gamma2 = float(np.interp(frequency, network["frequency_hz"], network["gamma2"]))
        raw = prad / pacc if pacc > 0 else None
        eff, note = Simulation._lossless_efficiency(raw, frequency, network["port_type"], d["lossless"])
        entry = {"port": port["port"], "f": frequency, "theta": theta.tolist(), "phi": phi.tolist(),
                 "requested_steps": [request["theta_step"], request["phi_step"]],
                 "directivity_dbi": [_r(row, 2) for row in grid], "dmax_dbi": round(10 * np.log10(dmax), 3),
                 "prad_w": prad, "pacc_w": pacc, "rad_efficiency": None if eff is None else round(eff, 4),
                 "mirror_planes": mirrors, "port_power_source": "interpolated-original-drive-sweep"}
        if d["lossless"]:
            entry["rad_efficiency_raw"] = None if raw is None else round(raw, 4)
        pat = _pattern_directivity(e, theta, phi, factor)
        if pat is not None:
            entry["dmax_pattern_dbi"] = round(10 * np.log10(pat), 3)
        if d["circular"]:
            entry["cp"] = _circular(res, i, grid, theta, phi)
        if d["complex_fields"]:
            entry["fields"] = encode_farfield_fields(frequency, theta, phi, res.E_theta[i], res.E_phi[i],
                mirror_planes=mirrors, phase_center_m=d["phase_center_m"], radius_m=float(np.asarray(res.r).item()))
        if eff is not None and eff > 0:
            entry["gain_dbi"] = round(10 * np.log10(eff * dmax), 3)
            if 0 <= gamma2 < 1:
                entry["realized_gain_dbi"] = round(10 * np.log10(eff * dmax * (1 - gamma2)), 3)
        warning = note or _efficiency_warning(eff, frequency, network["port_type"])
        if warning:
            entry["qa_warnings"] = [warning]
        entries.append(entry)
    return entries


def process(raw_root: Path, *, expected_sha256: str, frequencies, output: Path,
            theta_step=3, phi_step=5, parent_path: Path | None = None,
            _runtime_identity=None, _transform=None) -> Path:
    """Verify under ownership lock, transform, rehash, then publish once.

    The private injections let pure tests verify failure/ownership semantics
    without importing a solver. Production calls always use the native adapter.
    """
    from .simdata import mark_running
    root = archive.safe_root(raw_root)
    output = Path(output).absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    canonical_output = archive.safe_file(output.parent, output.name, exists=False)
    if output.suffix != ".json" or output.name == "index.json" or root in canonical_output.parents or output.exists():
        raise ValueError("postprocessing needs a new .json result outside the original raw folder")
    with archive.raw_lock(), mark_running(root):
        identity = _runtime_identity if _runtime_identity is not None else _runtime()
        manifest, parent, manifest_sha = archive.load_verified(root, expected_sha256=expected_sha256,
            parent_path=parent_path, runtime=identity)
        request = archive.admit_request(manifest, frequencies, theta_step, phi_step)
        transform = _transform or native_transform
        fields, outputs = [], []
        t0 = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="fairbeam-nf2ff-") as temporary:
            for port in manifest["ports"]:
                h5 = Path(temporary) / f"port-{port['port']}.h5"
                fields.extend(transform(root, port, request, h5))
                if h5.exists():
                    outputs.append({"port": port["port"], "sha256": archive.file_digest(h5), "bytes": h5.stat().st_size})
        # Native analysis must not change any input or the source result.
        archive.load_verified(root, expected_sha256=manifest_sha, parent_path=parent_path, runtime=identity)
        result = copy.deepcopy(parent)
        result["name"] = f"{parent.get('name') or parent.get('model', {}).get('id', 'Result')} · Far field"
        result["created"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        result["results"]["farfield"] = fields
        # Existing element patterns and efficiency sweeps keep their original
        # grids/frequencies. Only farfield[] is replaced by this transform.
        result["postprocess"] = {"schema": "fairbeam.nf2ff-postprocess/1", "method": "NF2FF-only",
            "fdtd_rerun": False, "parent_sha256": manifest["parent"]["sha256"],
            "parent_filename": manifest["parent"]["filename"], "manifest_sha256": manifest_sha,
            "source_identity": manifest["source"]["identity"], "request": request,
            "runtime": identity, "native_outputs": outputs, "elapsed_s": round(time.monotonic() - t0, 6),
            "port_power": "linear interpolation of the original per-drive Pacc and |reflection|² sweep",
            "unchanged_sections": ["network", "element_patterns", "efficiency", "run", "requirements_source", "requirements_snapshot"]}
        archive.write_new(output, archive.encode(result))
    return output


def main(argv=None):
    import argparse
    import json
    ap = argparse.ArgumentParser(description="Run an admitted immutable NF2FF transform; no FDTD")
    ap.add_argument("--request", required=True)
    ap.add_argument("--sha256", required=True)
    args = ap.parse_args(argv)
    path = Path(args.request)
    if path.is_symlink() or path.stat().st_size > 64 * 1024:
        raise ValueError("invalid NF2FF request snapshot")
    data = path.read_bytes()
    if archive.digest(data) != args.sha256:
        raise ValueError("NF2FF request snapshot changed")
    spec = json.loads(data)
    if spec.get("schema") != "fairbeam.nf2ff-request/1":
        raise ValueError("unsupported NF2FF request schema")
    print("fairbeam: postprocessing retained NF2FF data (no FDTD)", flush=True)
    output = process(Path(spec["source"]), expected_sha256=spec["manifest_sha256"],
        parent_path=Path(spec["parent"]), frequencies=spec["frequencies_hz"], output=Path(spec["output"]),
        theta_step=spec["theta_step"], phi_step=spec["phi_step"])
    print(f"fairbeam: wrote {output}", flush=True)


if __name__ == "__main__":
    main()
