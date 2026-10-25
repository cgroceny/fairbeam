"""Multi-port simulations: one openEMS run per excited port, assembled into an S-matrix.

Definitions (docs/BUNDLE.md, ``results.sparams``)
    For port i with real reference impedance Z_i (the lumped port's resistance), openEMS gives the
    frequency-domain port voltage U_i and current I_i (flowing into the structure). The power waves
    are::

        a_i = (U_i + Z_i I_i) / (2 sqrt(Z_i)),      b_i = (U_i - Z_i I_i) / (2 sqrt(Z_i))

    i.e. openEMS' ``uf_inc`` and ``uf_ref`` divided by sqrt(Z_i). One run is made per excited port j
    (all other ports present and terminated in their resistance). With the waves of run j as the
    j-th columns of the matrices A and B:

    - all ports excited: ``S = B A^-1`` at every frequency. This is exact even though the
      terminated ports' incident waves are not exactly zero in the FDTD model.
    - otherwise, for the excited columns only: ``S_ij = b_i / a_j`` (terminated ports assumed
      matched, a_i = 0).

    With equal Z_i these are the usual S-parameters. With different Z_i they are power-wave
    S-parameters (Kurokawa) referenced to each port's own Z_i.

QA metrics (``results.sparams.qa``)
    - reciprocity: max over frequency of |S_ij - S_ji| over all pairs with both columns known
      (0 for a reciprocal structure; FDTD typically gives 1e-3..1e-2).
    - passivity: largest singular value squared of the complete finite power-wave matrix.
      Column power is also reported, but cannot establish passivity for coherent excitation.
"""

from __future__ import annotations

import base64
import time
from pathlib import Path

import numpy as np

from .simdata import mark_running
from .simulation import _center, _r, _rf_values, _zref_scalar, excite_only, mirror_planes

ETA0 = 376.730313668


# ---------------------------------------------------------------------------- pure numerics

def assemble_s(a: np.ndarray, b: np.ndarray, excited: list[int], n_ports: int) -> np.ndarray:
    """S-matrix from incident/outgoing power waves.

    ``a``, ``b``: shape (n_runs, n_ports, n_freq); run k excites port ``excited[k]`` (1-based).
    Returns S with shape (n_freq, n_ports, n_ports); unknown columns are NaN.
    """
    a = np.asarray(a, complex)
    b = np.asarray(b, complex)
    n_f = a.shape[2]
    s = np.full((n_f, n_ports, n_ports), np.nan + 0j)
    cols = [p - 1 for p in excited]
    if sorted(cols) == list(range(n_ports)):
        order = np.argsort(cols)
        A = np.transpose(a[order], (2, 1, 0))  # (f, port i, run j)
        B = np.transpose(b[order], (2, 1, 0))
        # S A = B  ->  S = B A^-1, solved as A^T S^T = B^T
        s = np.transpose(np.linalg.solve(np.transpose(A, (0, 2, 1)), np.transpose(B, (0, 2, 1))), (0, 2, 1))
        return s
    for k, j in enumerate(cols):
        s[:, :, j] = (b[k] / a[k, j][None, :]).T
    return s


def qa_metrics(s: np.ndarray, excited: list[int], passive_tol: float = 1e-2) -> dict:
    """Reciprocity and passivity figures of an S-matrix from :func:`assemble_s`."""
    n = s.shape[1]
    known = sorted(p - 1 for p in excited)
    pairs = {}
    for i in range(n):
        for j in range(n):
            if i < j and i in known and j in known:
                v = np.abs(s[:, i, j] - s[:, j, i])
                pairs[f"{i + 1},{j + 1}"] = round(float(v.max()), 6) if v.size and np.all(np.isfinite(v)) else None
    col = {str(j + 1): np.sum(np.abs(s[:, :, j]) ** 2, axis=1) for j in known}
    colmax = {k: round(float(v.max()), 6) if v.size and np.all(np.isfinite(v)) else None for k, v in col.items()}
    complete = bool(s.shape[0]) and known == list(range(n)) and np.all(np.isfinite(s))
    powers = np.linalg.svd(s, compute_uv=False)[:, 0] ** 2 if complete else None
    peak = float(powers.max()) if powers is not None and powers.size else None
    return {
        "reciprocity_max": max(pairs.values()) if pairs and all(v is not None for v in pairs.values()) else None,
        "reciprocity_pairs": pairs,
        "column_power_max": colmax,
        "column_power_min": {k: round(float(v.min()), 6) if v.size and np.all(np.isfinite(v)) else None for k, v in col.items()},
        "passivity_max": round(peak, 6) if peak is not None else None,
        "passive": peak <= 1 + passive_tol if peak is not None else None,
        "passivity_power": powers.tolist() if powers is not None else None,
        "passivity_violations": np.flatnonzero(powers > 1 + passive_tol).tolist() if powers is not None else [],
        "passivity_method": "largest singular value squared; complete finite power-wave matrix required",
        "passive_tol": passive_tol,
    }


def renormalize(s: np.ndarray, z_old, z_new) -> np.ndarray:
    """Re-reference power-wave S-parameters (real impedances) from ``z_old`` to ``z_new``.

    With a' = c (a - G b), b' = c (b - G a), c_i = (Z_i + Z'_i) / (2 sqrt(Z_i Z'_i)) and
    G_i = (Z'_i - Z_i) / (Z'_i + Z_i):  S' = C (S - G)(I - G S)^-1 C^-1. Unlike the route through the
    Z-matrix this also works for networks without one (a series element, a through line).
    """
    s = np.asarray(s, complex)
    n = s.shape[-1]
    zo = np.broadcast_to(np.asarray(z_old, float), (n,))
    zn = np.broadcast_to(np.asarray(z_new, float), (n,))
    g = np.diag((zn - zo) / (zn + zo))
    c = (zo + zn) / (2 * np.sqrt(zo * zn))
    eye = np.eye(n)
    # (S - G)(I - G S)^-1  ==  solve((I - G S)^T, (S - G)^T)^T
    m = np.linalg.solve(np.transpose(eye - g @ s, (0, 2, 1)), np.transpose(s - g, (0, 2, 1))).transpose(0, 2, 1)
    return c[:, None] * m / c[None, :]


def sparams_section(f, s: np.ndarray, excited: list[int], z_ref: list[float], method: str) -> dict:
    n = s.shape[1]
    known = sorted(p - 1 for p in excited)
    entries = {}
    for i in range(n):
        for j in known:
            entries[f"{i + 1},{j + 1}"] = {"re": _rf_values(s[:, i, j].real), "im": _rf_values(s[:, i, j].imag)}
    return {"ports": list(range(1, n + 1)), "z_ref": [float(z) for z in z_ref], "excited": sorted(excited),
            "complete": len(known) == n, "method": method, "s": entries, "qa": qa_metrics(s, excited)}


def s_from_section(sp: dict) -> np.ndarray:
    """(n_freq, N, N) complex array from a bundle's ``results.sparams`` (NaN where unknown)."""
    n = len(sp["ports"])
    first = next(iter(sp["s"].values()))
    s = np.full((len(first["re"]), n, n), np.nan + 0j)
    for key, v in sp["s"].items():
        i, j = (int(x) - 1 for x in key.split(","))
        s[:, i, j] = np.asarray(v["re"]) + 1j * np.asarray(v["im"])
    return s


def encode_f32(a) -> str:
    return base64.b64encode(np.ascontiguousarray(np.asarray(a, "<f4")).tobytes()).decode("ascii")


def decode_f32(text: str, shape) -> np.ndarray:
    return np.frombuffer(base64.b64decode(text), "<f4").reshape(shape).astype(float)


# Element-pattern encodings (docs/BUNDLE.md#element_patterns). Readers accept both; the writer
# emits ENC_I16. With one scale per port and frequency (max |component| over the four arrays) the
# int16 quantisation step is 1/32767 of the peak, about -90 dB: far below anything a pattern or an
# array synthesis shows, and it halves the size (neither form compresses much beyond base64).
ENC_F32 = "f32le-base64"
ENC_I16 = "i16le-base64-scaled"
ENCODINGS = (ENC_F32, ENC_I16)
FIELD_KEYS = ("e_theta_re", "e_theta_im", "e_phi_re", "e_phi_im")
I16_FULL = 32767


def encode_i16_scaled(arrays) -> tuple[float, list[str]]:
    """``(scale, [base64 ...])``: every array as round(v / scale * 32767), little-endian int16, with
    scale = max |v| over all the arrays (a shared scale keeps E_theta and E_phi comparable)."""
    arrs = [np.asarray(a, float) for a in arrays]
    if not all(np.all(np.isfinite(a)) for a in arrs):
        raise ValueError("non-finite values cannot be encoded as scaled int16")
    scale = max((float(np.max(np.abs(a))) for a in arrs if a.size), default=0.0)
    div = scale if scale > 0 else 1.0
    return scale, [base64.b64encode(np.ascontiguousarray(np.round(a / div * I16_FULL).astype("<i2"))
                                    .tobytes()).decode("ascii") for a in arrs]


def decode_i16_scaled(text: str, shape, scale: float) -> np.ndarray:
    return np.frombuffer(base64.b64decode(text), "<i2").reshape(shape) * (float(scale) / I16_FULL)


def encode_pattern_fields(f: float, e_theta, e_phi, encoding: str = ENC_I16) -> dict:
    """One ``ports[].fields[]`` entry of ``results.element_patterns`` for complex E_theta, E_phi."""
    e_theta, e_phi = np.asarray(e_theta), np.asarray(e_phi)
    arrays = (e_theta.real, e_theta.imag, e_phi.real, e_phi.imag)
    if encoding == ENC_F32:
        return {"f": float(f), **{k: encode_f32(a) for k, a in zip(FIELD_KEYS, arrays)}}
    if encoding == ENC_I16:
        scale, texts = encode_i16_scaled(arrays)
        return {"f": float(f), "scale": scale, **dict(zip(FIELD_KEYS, texts))}
    raise ValueError(f"unknown element-pattern encoding {encoding!r} (known: {', '.join(ENCODINGS)})")


def decode_pattern_fields(section: dict, entry: dict) -> tuple[np.ndarray, np.ndarray]:
    """Complex ``(E_theta, E_phi)`` [theta][phi] of one fields entry, for either encoding."""
    shape = tuple(section["shape"])
    enc = section.get("encoding", ENC_F32)
    if enc == ENC_F32:
        a = [decode_f32(entry[k], shape) for k in FIELD_KEYS]
    elif enc == ENC_I16:
        a = [decode_i16_scaled(entry[k], shape, entry["scale"]) for k in FIELD_KEYS]
    else:
        raise ValueError(f"unknown element-pattern encoding {enc!r} (known: {', '.join(ENCODINGS)})")
    return a[0] + 1j * a[1], a[2] + 1j * a[3]


def reencode_element_patterns(bundle: dict, encoding: str = ENC_I16) -> bool:
    """Convert a bundle's ``results.element_patterns`` to ``encoding`` in place (e.g. an older
    float32 bundle to scaled int16). Nothing else is touched. Returns False when there is nothing to
    do (no section, or already in that encoding)."""
    sec = (bundle.get("results") or {}).get("element_patterns")
    if not isinstance(sec, dict) or sec.get("encoding", ENC_F32) == encoding:
        return False
    for p in sec["ports"]:
        p["fields"] = [encode_pattern_fields(e["f"], *decode_pattern_fields(sec, e), encoding) for e in p["fields"]]
    sec["encoding"] = encoding
    return True


# ---------------------------------------------------------------------------- running

def default_excite(n_ports: int) -> list[int]:
    return list(range(1, n_ports + 1)) if n_ports <= 4 else [1]


def parse_excite(spec: str | None, port_numbers: list[int], excitable: list[int] | None = None) -> list[int]:
    """The ports to excite, one run each. Without ``spec`` only the ports the model marks as
    excitable (a design port's ``excite``) are run, by the usual rule (all of them for up to four
    ports numbered 1..n, else the first); a model that marks none keeps the old choice. An explicit
    ``spec`` ("all", "1,3") is taken as asked, whatever the marks."""
    if spec in (None, "", "auto"):
        ports = [p for p in port_numbers if excitable is None or p in excitable] or port_numbers
        if ports == port_numbers:
            return default_excite(len(port_numbers)) if port_numbers == list(range(1, len(port_numbers) + 1)) \
                else port_numbers[:1]
        consecutive = port_numbers == list(range(1, len(port_numbers) + 1))
        return list(ports) if consecutive and len(ports) <= 4 else ports[:1]
    if spec == "all":
        return list(port_numbers)
    out = [int(x) for x in spec.split(",") if x.strip()]
    bad = set(out) - set(port_numbers)
    if bad:
        raise ValueError(f"--excite: no port(s) {sorted(bad)}; the model has {port_numbers}")
    return sorted(set(out))


def run_model(module, values: dict, *, excite: str | None = None, sim_path: str, threads: int = 0,
              echo: bool = False, engine: str = "cpu", exact: bool = True, end_db: float | None = None,
              n_freq: int = 801, pattern_freqs=None, element_patterns: bool | None = None,
              before_run=None, log=print, efficiency_points: int | None = None, pattern_steps: tuple[float, float] | None = None):
    """Build and run ``module`` once per excited port and merge the results.

    Returns the primary (first excited port) :class:`~fairbeam.simulation.Simulation`, whose
    ``results`` and ``run_stats`` hold the merged data, so ``sim.to_bundle`` works as usual.
    ``before_run(sim)`` is called on every build before it runs (e.g. to attach field dumps).
    ``efficiency_points`` sets ``sim.efficiency_points`` on every build (efficiency over the band)
    and adds the NF2FF box to a model that has none.
    ``pattern_steps=(theta, phi)`` overrides the model's angular steps in degrees on every run.
    """
    probe = module.build(values)
    numbers = [p["number"] for p in probe.ports]
    excitable = [p["number"] for p in probe.ports if p.get("excite", True)]
    del probe
    ports_to_run = parse_excite(excite, numbers, excitable)
    if element_patterns is None:
        element_patterns = len(ports_to_run) > 1
    sims, t0 = [], time.time()
    with mark_running(sim_path):  # raw data in use until every evaluate() is done
        for k, pn in enumerate(ports_to_run):
            with excite_only(pn if len(numbers) > 1 or excite not in (None, "", "auto") else None):
                sim = module.build(values)
            if end_db is not None:
                sim.end_criteria_db = float(end_db)
                sim.fdtd.SetEndCriteria(10 ** (end_db / 10))
            if efficiency_points:
                sim.efficiency_points = int(efficiency_points)
                if sim.nf2ff is None:
                    if k == 0:
                        log("fairbeam: note: the model records no far field; adding the NF2FF box for the efficiency")
                    sim.add_nf2ff_box()
            if before_run:
                before_run(sim)
            steps = pattern_steps if pattern_steps is not None else getattr(sim, "pattern_steps", None)
            angular = {}
            if steps is not None:
                from .pattern_grid import pattern_steps as validate_steps
                theta_step, phi_step = validate_steps(*steps)
                angular = {"theta_step": theta_step, "phi_step": phi_step}
            path = sim_path if len(ports_to_run) == 1 else str(Path(sim_path) / f"excite-{pn}")
            if len(ports_to_run) > 1:
                log(f"fairbeam: run {k + 1}/{len(ports_to_run)}: port {pn} excited, "
                    f"{len(numbers) - 1} terminated")
            sim.run(path, threads=threads, echo=echo, engine=engine, exact=exact)
            sim.evaluate(n_freq=n_freq, pattern_freqs=pattern_freqs, **angular)
            if pattern_freqs is None and sim.results.get("farfield"):
                pattern_freqs = [ff["f"] for ff in sim.results["farfield"]]  # same frequencies for all runs
            sims.append((pn, sim))
    if not sims:
        # nothing was excited (no ports, or none marked as excited): say so instead of an IndexError
        raise ValueError("the model has no excited port: add a port (or mark one as excited) before running")
    primary = sims[0][1]
    merge(primary, sims, numbers, element_patterns)
    primary.run_stats["wall_time_total_s"] = round(time.time() - t0, 2)
    return primary


def merge(primary, sims, numbers: list[int], element_patterns: bool):
    """Combine per-run results into ``primary.results`` / ``primary.run_stats`` (in place)."""
    res = primary.results
    f = np.asarray(res["frequency"])
    idx = {n: i for i, n in enumerate(numbers)}
    z_ref = [_zref_scalar(p.Z_ref, f) for p in primary._port_objs]
    a = np.zeros((len(sims), len(numbers), len(f)), complex)
    b = np.zeros_like(a)
    for k, (pn, sim) in enumerate(sims):
        for i, p in enumerate(sim._port_objs):
            zr = np.sqrt(np.real(np.asarray(p.Z_ref, dtype=complex)))   # scalar, or per frequency (waveguide)
            a[k, i] = np.asarray(p.uf_inc) / zr
            b[k, i] = np.asarray(p.uf_ref) / zr
        if sim is not primary:
            res["ports"][str(pn)] = sim.results["ports"][str(pn)]
    excited_idx = [idx[pn] + 1 for pn, _ in sims]
    s = assemble_s(a, b, excited_idx, len(numbers))
    method = "B A^-1" if len(sims) == len(numbers) else "b_i / a_j"
    res["sparams"] = sparams_section(f, s, excited_idx, z_ref, method)
    from .simulation import _bands
    # Public matched bands belong to the same Sii shown in plots and Touchstone exports.
    diagonal = s[:, idx[sims[0][0]], idx[sims[0][0]]]
    res["bands"] = (_bands(f, 20 * np.log10(np.maximum(np.abs(diagonal), 1e-15)), res.get("s11_band_db", -10.0))
                    if np.all(np.isfinite(diagonal)) else [])
    if numbers != list(range(1, len(numbers) + 1)):
        res["sparams"]["port_numbers"] = numbers
    # keep the per-port reflection data only for ports that were actually driven
    driven = {str(pn) for pn, _ in sims}
    res["ports"] = {k: v for k, v in res["ports"].items() if k in driven}
    for ff in res["farfield"]:
        ff["port"] = sims[0][0]
    for pn, sim in sims[1:]:
        for ff in sim.results.get("farfield", []):
            res["farfield"].append({**ff, "port": pn})
    # efficiency over the band: one entry per driven port, like farfield[].port
    eff = [{**e, "port": pn} for pn, sim in sims for e in sim.results.get("efficiency") or []]
    if eff:
        res["efficiency"] = eff
    if len(sims) > 1:
        runs = []
        for pn, sim in sims:
            st = sim.run_stats
            runs.append({"port": pn, **{k: st.get(k) for k in ("timesteps", "solver_time_s", "wall_time_s",
                                                               "final_energy_db", "converged", "engine")},
                         **({"final_energy_bound_db": st["final_energy_bound_db"]}
                            if "final_energy_bound_db" in st else {})})
        primary.run_stats["port_runs"] = runs
        primary.run_stats["converged"] = all(r["converged"] for r in runs)
    if element_patterns and all(getattr(sim, "_nf2ff", None) for _, sim in sims):
        try:
            res["element_patterns"] = element_pattern_section(primary, sims, f)
            section = res["element_patterns"]
            if section["decimation"] > 1:
                import sys
                source, stored = section["source_shape"], section["shape"]
                print(f"fairbeam: warning: embedded element patterns reduced from {source[0]} x {source[1]} "
                      f"to {stored[0]} x {stored[1]} angular samples for the storage budget; array synthesis "
                      "uses this coarser grid and can miss narrow beams. Per-port far fields retain their grid.",
                      file=sys.stderr, flush=True)
        except ValueError as exc:
            res.pop("element_patterns", None)
            res["element_patterns_unavailable"] = str(exc)


def element_pattern_section(primary, sims, f, max_bytes: float = 2.5e6, encoding: str = ENC_I16) -> dict:
    """Complex embedded element patterns per excited port, normalised to a unit incident wave
    (``encoding``: ENC_I16 by default, ENC_F32 for the older float32 form)."""
    nf = sims[0][1]._nf2ff
    theta, phi, freqs = np.asarray(nf["theta"]), np.asarray(nf["phi"]), list(nf["freqs"])
    numbers = [p["number"] for p in primary.ports]
    if sorted(pn for pn, _ in sims) != sorted(numbers):
        raise ValueError("Matched element patterns require one excitation run for every port")
    # E = F A: the same incident-wave basis used by S = B A^-1 must be used for F.
    # Dividing each run by its driven wave alone leaves leakage from the other incident waves.
    ordered = [next(sim for pn, sim in sims if pn == number) for number in numbers]
    center = primary.nf2ff_center if primary.nf2ff_center is not None else _center(primary)
    radius = float(np.atleast_1d(getattr(nf["res"], "r", 1.0))[0])
    waves = []
    for sim in ordered:
        other = sim._nf2ff
        other_center = sim.nf2ff_center if sim.nf2ff_center is not None else _center(sim)
        if ([p["number"] for p in sim.ports] != numbers or
                any(not np.array_equal(other[key], nf[key]) for key in ("theta", "phi", "freqs")) or
                not np.array_equal(center, other_center) or
                float(np.atleast_1d(getattr(other["res"], "r", 1.0))[0]) != radius):
            raise ValueError("Element-pattern runs must share port order, angular/frequency grids, phase center and radius")
        run_waves = []
        for port in sim._port_objs:
            zr = np.broadcast_to(np.real(np.asarray(port.Z_ref, complex)), np.shape(f))
            inc = np.asarray(port.uf_inc) / np.sqrt(zr)
            if not np.all(np.isfinite(inc)) or any(fk < f[0] or fk > f[-1] for fk in freqs):
                raise ValueError("Element patterns require finite incident waves within the sampled frequency band")
            run_waves.append(np.interp(freqs, f, inc.real) + 1j * np.interp(freqs, f, inc.imag))
        waves.append(run_waves)
    incident = np.transpose(np.asarray(waves), (2, 1, 0))  # frequency, port, run
    if np.any(np.linalg.cond(incident) > 1e10):
        raise ValueError("Incident-wave matrix is singular or ill-conditioned; matched element patterns unavailable")
    transformed = []
    for k, _ in enumerate(freqs):
        fields = []
        for component in ("E_theta", "E_phi"):
            raw = np.stack([np.asarray(getattr(sim._nf2ff["res"], component)[k]) for sim in ordered], axis=-1)
            fields.append(np.linalg.solve(incident[k].T, raw.reshape(-1, len(numbers)).T).T.reshape(raw.shape))
        transformed.append(fields)
    # decimate the angular grid if the section would get too large (4 arrays x 4 bytes x 4/3 base64;
    # the float32 budget is kept for int16 too, so the default grid does not change with the encoding)
    if not len(theta) or not len(phi):
        raise ValueError("Element patterns require a nonempty angular grid")
    if not np.isfinite(max_bytes) or max_bytes <= 0:
        raise ValueError("Element-pattern storage budget must be finite and positive")
    # Count the retained endpoint in the budget too. Bound the search even if a caller supplies
    # a budget too small for the poles, one phi sample and all port/frequency fields.
    for step in range(1, max(len(theta), len(phi)) + 1):
        ti, pi = np.arange(0, len(theta), step), np.arange(0, len(phi), step)
        if ti[-1] != len(theta) - 1:
            ti = np.r_[ti, len(theta) - 1]  # keep theta = 180 for the sphere integral
        if len(ti) * len(pi) * 4 * 4 * 4 / 3 * len(freqs) * len(sims) <= max_bytes:
            break
    else:
        raise ValueError("Element-pattern storage budget cannot retain both theta poles")
    mirrors = mirror_planes(primary.boundaries)
    out_ports = []
    for pn, sim in sims:
        meta = sim.ports[[p["number"] for p in sim.ports].index(pn)]
        fields = []
        for k, fk in enumerate(freqs):
            et, ep = [component[:, :, numbers.index(pn)][np.ix_(ti, pi)] for component in transformed[k]]
            fields.append((float(fk), et, ep))
        centre = [(s + e) / 2 for s, e in zip(meta["start"], meta["stop"])]
        out_ports.append({"port": pn, "position": [round(v, 6) for v in centre], "fields": fields})
    # scaled int16 needs finite data; a broken far field keeps float32 so nothing is hidden
    finite = all(np.all(np.isfinite(x)) for p in out_ports for _, et, ep in p["fields"] for x in (et, ep))
    enc = encoding if finite else ENC_F32
    for p in out_ports:
        p["fields"] = [encode_pattern_fields(fk, et, ep, enc) for fk, et, ep in p["fields"]]
    radius = float(np.atleast_1d(getattr(sims[0][1]._nf2ff["res"], "r", 1.0))[0])
    return {
        "normalization": "far-field E (V/m) at radius_m per unit incident power wave a = 1 sqrt(W) at the port "
                         "(a = U_inc / sqrt(Z_ref), peak phasor); all other incident waves zero; F = E A^-1",
        "basis": "matched-incident-waves",
        "radius_m": radius, "encoding": enc, "shape": [int(len(ti)), int(len(pi))],
        "theta": theta[ti].tolist(), "phi": phi[pi].tolist(), "frequencies": [float(v) for v in freqs],
        "decimation": step, "mirror_planes": mirrors,
        "source_shape": [int(len(theta)), int(len(phi))],
        **({"requested_steps": list(nf["requested_steps"])} if "requested_steps" in nf else {}),
        "phase_center": [float(v) for v in (primary.nf2ff_center if primary.nf2ff_center is not None
                                            else _center(primary))],
        "ports": out_ports,
    }
