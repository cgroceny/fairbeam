"""Normal-incidence plane-wave unit cell for material and surface samples (issue #271).

A TEM plane wave in a cell with PEC walls normal to E (y- / y+) and PMC walls normal to H
(x- / x+) behaves like a normally incident plane wave on a sample that is infinite in x and y,
provided the sample is symmetric with respect to these walls. Both ends of the cell run into PML.

Layout along z (the propagation direction, drawing units)::

    PML | source | ... | ref. plane 1 | gap | sample [front, back] | gap | ref. plane 2 | ... | PML

The excitation is a soft E_y sheet over the whole cross-section (openEMS excitation type 0, as in
openEMS' Metamaterial_PlaneWave_Drude example); openEMS' TF/SF plane wave (type 10) must not touch
any material and would need its box to reach through the cell. Each reference plane carries a
voltage probe from the y- to the y+ wall (V = integral of E_y dy), which in a TEM cell is the wave
amplitude up to a constant.

The model builds the cell with the sample (``PlaneWaveCell``); :func:`run_cell` runs it and an
empty copy with the identical mesh, source and probes (:meth:`PlaneWaveCell.reference`). The empty
run gives the incident wave at both reference planes; :func:`cell_sparams` turns the two runs
into S11 and S21 referred to the sample faces. ``fairbeam material-cell`` is the command line.
"""

import json
import os
import sys
import time
from pathlib import Path

import numpy as np
from openEMS.physical_constants import C0, Z0

from .jsonutil import finite_json

#: x-, x+, y-, y+, z-, z+: PMC walls normal to H (x), PEC walls normal to E (y), PML along z
CELL_BOUNDARIES = ("PMC", "PMC", "PEC", "PEC", "PML_8", "PML_8")
PML_CELLS = 8
#: cells between a PML and the nearest source or probe plane
PML_MARGIN_CELLS = 4
#: cells from the source sheet to reference plane 1
SOURCE_CELLS = 4
#: largest ratio of neighbouring cells where the mesh grades from the sample to the air cells
GRADING = 1.3
PROBE_NAMES = ("mc_v1", "mc_v2")
EXCITATION_NAME = "mc_plane_wave"
RESULT_KIND = "fairbeam.material-cell"
#: ``material-cell --nist`` warns when the NRW median mu_r' differs from 1 by more than this
MAGNETIC_HINT = 0.05


class PlaneWaveCell:
    """The cell around a sample between ``front`` and ``back`` (z, drawing units; ``front <=
    back``) in a cross-section ``a`` (x, along H) by ``b`` (y, along E) centred on x = y = 0.

    Sets the cell boundaries on ``sim``, writes the whole mesh (z: uniform inside the sample at
    ``cells_per_wavelength`` cells per wavelength in the densest material, ``eps_max * mu_max``,
    graded to the air cells outside; x and y: uniform), and adds the source sheet and the two
    probes. ``interfaces`` are extra z lines inside the sample (layer boundaries). ``gap`` is the
    distance from each sample face to its reference plane (default: the larger of a, b and a
    quarter wavelength at f_max), so that evanescent fields of a structured sample have decayed
    there. Add the sample itself with the usual CSXCAD calls, spanning the whole cross-section
    (:meth:`span`). The model may add further mesh lines afterwards; the source and probe planes
    stay on lines.
    """

    def __init__(self, sim, a: float, b: float, front: float, back: float, *, eps_max: float = 1.0,
                 mu_max: float = 1.0, cells_per_wavelength: float = 20, interfaces=(), gap: float | None = None,
                 transverse_cells: int | None = None):
        if not (a > 0 and b > 0):
            raise ValueError("the cell cross-section a x b must be positive")
        if back < front:
            raise ValueError(f"the sample's back face ({back:g}) lies in front of its front face ({front:g})")
        if eps_max < 1 or mu_max < 1:
            raise ValueError("eps_max and mu_max are at least 1 (vacuum)")
        self.sim = sim
        self.a, self.b = float(a), float(b)
        self.front, self.back = float(front), float(back)
        self.f_mode_any, self.f_mode_centred = higher_mode_frequencies(self.a, self.b, sim.unit)
        #: notes for the user when the band reaches the cell's higher-order modes (see mode_warnings)
        self.warnings = mode_warnings(sim.f_max, self.f_mode_any, self.f_mode_centred)
        sim.boundaries = list(CELL_BOUNDARIES)
        sim.fdtd.SetBoundaryCond(sim.boundaries)

        air = C0 / sim.f_max / sim.unit / float(cells_per_wavelength)
        dense = air / np.sqrt(eps_max * mu_max)
        if gap is None:
            gap = max(self.a, self.b, C0 / sim.f_max / sim.unit / 4)
        self.gap = float(gap)

        inside = sorted({self.front, self.back, *(float(z) for z in interfaces if front < z < back)})
        z = [inside[0]]
        for lo, hi in zip(inside, inside[1:]):
            n = max(int(np.ceil((hi - lo) / dense - 1e-9)), 1)
            z.extend(np.linspace(lo, hi, n + 1)[1:])
        first = min(np.diff(z)) if len(z) > 1 else dense
        front_off, k1 = _outward(first, air, self.gap, SOURCE_CELLS + PML_MARGIN_CELLS + PML_CELLS)
        back_off, k2 = _outward(first, air, self.gap, PML_MARGIN_CELLS + PML_CELLS)
        z = np.concatenate([self.front - front_off[::-1], z, self.back + back_off])
        self.z1 = float(self.front - front_off[k1])
        self.z2 = float(self.back + back_off[k2])
        self.z_source = float(self.front - front_off[k1 + SOURCE_CELLS])

        nx = transverse_cells or max(int(np.ceil(self.a / air - 1e-9)), 2)
        ny = transverse_cells or max(int(np.ceil(self.b / air - 1e-9)), 2)
        xs = np.linspace(-self.a / 2, self.a / 2, nx + 1)
        sim.mesh.AddLine("x", xs)
        sim.mesh.AddLine("y", np.linspace(-self.b / 2, self.b / 2, ny + 1))
        sim.mesh.AddLine("z", z)
        #: x of the probe lines (the cell's line nearest x = 0), fixed here for both runs
        self.probe_x = float(xs[np.argmin(np.abs(xs))])
        self._attach(sim)
        sim.material_cell = self

    def span(self, z0: float, z1: float):
        """``start, stop`` of a box over the whole cross-section from z0 to z1."""
        return [-self.a / 2, -self.b / 2, z0], [self.a / 2, self.b / 2, z1]

    def _attach(self, sim):
        """The source sheet and the two probes (from wall to wall along y at ``probe_x``)."""
        exc = sim.csx.AddExcitation(EXCITATION_NAME, exc_type=0, exc_val=[0, 1, 0])
        exc.AddBox(*self.span(self.z_source, self.z_source))
        x = self.probe_x
        for name, zp in zip(PROBE_NAMES, (self.z1, self.z2)):
            sim.csx.AddProbe(name, p_type=0).AddBox([x, -self.b / 2, zp], [x, self.b / 2, zp])

    def reference(self):
        """The empty cell: a new Simulation with this cell's band, excitation, end criterion,
        boundaries, mesh, source and probes, and no sample."""
        from .simulation import Simulation

        sim = self.sim
        excitation = "dgauss" if sim.excitation["type"] == "gaussian-derivative" else "gauss"
        ref = Simulation(sim.f_min, sim.f_max, unit=sim.unit, boundaries=sim.boundaries, excitation=excitation,
                         end_criteria_db=sim.end_criteria_db, max_timesteps=sim.max_timesteps)
        for axis in "xyz":
            ref.mesh.AddLine(axis, np.asarray(sim.mesh.GetLines(axis)))
        self._attach(ref)
        return ref

    def describe(self) -> dict:
        """The cell geometry for the result file (drawing units)."""
        return {"a": self.a, "b": self.b, "front": self.front, "back": self.back, "gap": self.gap,
                "z_ref1": self.z1, "z_ref2": self.z2, "z_source": self.z_source,
                "polarization": "E along y, H along x, k along +z",
                "boundaries": dict(zip(("x-", "x+", "y-", "y+", "z-", "z+"), self.sim.boundaries)),
                "f_higher_mode": {"any": self.f_mode_any, "centred": self.f_mode_centred},
                "warnings": list(self.warnings)}


def higher_mode_frequencies(a: float, b: float, unit: float = 1e-3) -> tuple[float, float]:
    """Cut-off frequencies (Hz) of the cell's first higher-order modes in vacuum, where the
    reference planes are.

    The PEC/PMC cell is a waveguide whose modes vary as cos(m pi (x + a/2) / a) and
    cos(n pi (y + b/2) / b), with cut-off c / 2 * sqrt((m / a)^2 + (n / b)^2). The TEM wave (m = n =
    0) is the plane wave. A sample that is not mirror-symmetric about the cell's centre planes
    x = 0 and y = 0 can excite the first odd mode, at c / (2 max(a, b)); a centred sample only
    excites even modes, from c / max(a, b) on (the first Floquet harmonic of the equivalent
    periodic array at normal incidence). A homogeneous slab excites none of them."""
    size = max(float(a), float(b)) * unit
    return float(C0 / (2 * size)), float(C0 / size)


def mode_warnings(f_max: float, f_any: float, f_centred: float) -> list[str]:
    """Warnings for a band that reaches the cell's higher-order modes: above their cut-off the
    reference planes see more than the plane wave, so S11 and S21 of a structured sample are
    no longer the plane-wave response."""
    if f_max > f_centred:
        return [f"f_max {f_max / 1e9:.4g} GHz is above {f_centred / 1e9:.4g} GHz, where higher-order modes of the "
                f"cell propagate even for a sample centred in the cell: S11 and S21 of a structured sample are not "
                f"the plane-wave response there (a homogeneous slab is unaffected). Use a smaller cell or a lower "
                f"f_max."]
    if f_max > f_any:
        return [f"f_max {f_max / 1e9:.4g} GHz is above {f_any / 1e9:.4g} GHz, where a sample that is not "
                f"mirror-symmetric about the cell's centre planes (x = 0, y = 0) excites higher-order modes of the "
                f"cell. A centred or homogeneous sample is valid up to {f_centred / 1e9:.4g} GHz."]
    return []


def _outward(first: float, cell: float, gap: float, extra: int):
    """Mesh offsets (> 0) from a sample face outward and the index of the reference plane among
    them: cells growing by at most GRADING from ``first`` to ``cell`` until the first offset at or
    beyond ``gap`` (the reference plane), then ``extra`` cells of ``cell`` (source, margin, PML)."""
    out, step = [], first
    while not out or out[-1] < gap - 1e-9:
        step = min(step * GRADING, cell)
        out.append((out[-1] if out else 0.0) + step)
    probe = len(out) - 1
    out.extend(out[-1] + cell * np.arange(1, extra + 1))
    return np.asarray(out), probe


# ---------------------------------------------------------------------------- post-processing

def cell_sparams(f, inc, tot, z1: float, z2: float, front: float, back: float, unit: float = 1e-3) -> dict:
    """S11 and S21 of the sample, referred to its faces, from the probe voltages of the empty run
    (``inc`` = (V1, V2): the incident wave) and of the sample run (``tot`` = (V1, V2)).

    Reference plane 1 (z1, in front) sees the incident plus the reflected wave, plane 2 (z2,
    behind) only the transmitted wave. With the incident wave A exp(-j k0 z) and a sample of
    thickness d = back - front::

        S11 = (V1 - V1_inc) / V1_inc * exp(+2 j k0 (front - z1))
        S21 = V2 / V2_inc * exp(-j k0 d)

    The planes are in vacuum; dividing by the empty run's voltages at the same planes removes the
    excitation spectrum and the propagation from the source.
    """
    f = np.asarray(f, float)
    k0 = 2 * np.pi * f / C0
    inc1, inc2 = (np.asarray(v, complex) for v in inc)
    tot1, tot2 = (np.asarray(v, complex) for v in tot)
    s11 = (tot1 - inc1) / inc1 * np.exp(2j * k0 * (front - z1) * unit)
    s21 = tot2 / inc2 * np.exp(-1j * k0 * (back - front) * unit)
    r2, t2 = np.abs(s11) ** 2, np.abs(s21) ** 2
    return {"f": f, "s11": s11, "s21": s21, "R2": r2, "T2": t2, "absorption": 1 - r2 - t2}


def compare(result: dict, s_ref) -> dict:
    """Largest deviations of a cell result from an analytic S-matrix (n_f, 2, 2)."""
    s_ref = np.asarray(s_ref)
    d11 = np.abs(result["s11"] - s_ref[:, 0, 0])
    d21 = np.abs(result["s21"] - s_ref[:, 1, 0])
    db21 = 20 * np.log10(np.abs(result["s21"]) / np.abs(s_ref[:, 1, 0]))
    ph21 = np.degrees(np.angle(result["s21"] / s_ref[:, 1, 0]))
    return {"max_abs_ds11": float(d11.max()), "max_abs_ds21": float(d21.max()),
            "max_s21_db_error": float(np.abs(db21).max()), "max_s21_phase_error_deg": float(np.abs(ph21).max())}


def _resolution_problems(disp, dt: float) -> list[str]:
    from .dispersion import resolution_problems

    return resolution_problems(disp, dt)


def _probe_voltages(sim_path: str, f):
    from openEMS.ports import UI_data

    u = UI_data(list(PROBE_NAMES), sim_path, f)
    return u.ui_f_val[0], u.ui_f_val[1]


def _complex(v) -> dict:
    return {"re": [float(x) for x in np.real(v)], "im": [float(x) for x in np.imag(v)]}


# ---------------------------------------------------------------------------- runner

def probe_timestep(path, dt_nominal: float) -> float:
    """The timestep (s) a finished run used, from the time column of one of its probe files.
    openEMS writes a probe every n-th timestep (n from the Nyquist rate), so it is the sample
    spacing divided by the whole n nearest to it over ``dt_nominal``."""
    t = np.loadtxt(path, comments="%", usecols=0, ndmin=1)
    if len(t) < 2:
        raise RuntimeError(f"{path} holds fewer than two samples: no timestep to read")
    spacing = (t[-1] - t[0]) / (len(t) - 1)
    return float(spacing / max(round(spacing / dt_nominal), 1))


def run_at_one_timestep(runs: dict, sim_path: str, probe: str, *, threads=0, echo: bool = False,
                        engine: str = "cpu", exact: bool = True, log=print) -> dict:
    """Run the empty reference and the sample (``runs``: {"reference": sim, "sample": sim}, in
    folders of those names under ``sim_path``) at one timestep and return their run statistics,
    with ``timestep_own_s`` and ``timestep_forced_s``.

    openEMS picks the step from the mesh and the materials: about 20 % longer for a plane-wave
    cell with an eps_r 4 slab and 28 % for a WR-90 guide filled with one, and a dispersive sample
    can need a shorter step than vacuum (a Drude eps' < 1). So each run's own step is read from an
    openEMS setup (no timesteps) and both run at the smaller one. The sample's dispersive poles
    are checked against that step first; a step that does not resolve them is refused. After the
    runs the step each one used is read from its ``probe`` file (:func:`probe_timestep`), not from
    the log: openEMS' progress line (openems.cpp, "Speed" / "Energy") leaves cout in std::fixed
    with two decimals, so after any run long enough to print progress, the next run in the same
    process logs its step as "0.00 s" (reported upstream:
    https://github.com/thliebig/openEMS/issues/229#issuecomment-5970656429)."""
    own = {label: s.run(str(Path(sim_path) / label), threads=threads, echo=False, engine=engine,
                        setup_only=True).get("timestep_s") for label, s in runs.items()}
    if not all(own.values()):
        raise RuntimeError(f"openEMS reported no timestep at setup ({own}); cannot match the two runs")
    dt = min(own.values())
    problems = [f"{name}: {msg}" for name, disp in getattr(runs["sample"], "dispersions", {}).items()
                for msg in _resolution_problems(disp, dt)]
    if problems:
        raise ValueError("the timestep does not resolve the dispersive material: " + "; ".join(problems)
                         + " (refine the mesh or refit with fairbeam debye-fit --dt)")
    stats = {}
    for label, s in runs.items():
        s.fdtd.SetTimeStep(dt)
        log(f"fairbeam: {label} run")
        stats[label] = s.run(str(Path(sim_path) / label), threads=threads, echo=echo, engine=engine, exact=exact)
        log(f"fairbeam: {label}: {stats[label].get('timesteps')} timesteps in {stats[label].get('solver_time_s')} s, "
            f"converged={stats[label].get('converged')}")
    used = {label: probe_timestep(Path(s.sim_path) / probe, dt) for label, s in runs.items()}
    for label, v in used.items():
        stats[label]["timestep_s"], stats[label]["timestep_source"] = v, f"{probe} time axis"
    if abs(used["sample"] / used["reference"] - 1) > 1e-6 or abs(used["reference"] / dt - 1) > 1e-5:
        raise RuntimeError(f"the runs did not use the forced timestep {dt} s ({used}): the sample and the "
                           "reference are not comparable")
    stats["timestep_own_s"], stats["timestep_forced_s"] = own, dt
    return stats


def run_cell(module, values: dict, *, sim_path: str, threads: int | str = 0, echo: bool = False,
             engine: str = "cpu", exact: bool = True, end_db: float | None = None, n_freq: int = 401,
             nist: bool = False, nrw_floor: float | None = None, log=print) -> dict:
    """Build the model's cell, run it and the empty reference, and return the result (S11, S21,
    |R|^2, |T|^2, absorption over ``n_freq`` frequencies across the band; with the model's
    ``analytic_layers(p)`` also the analytic slab and the deviations from it). ``threads="auto"``
    is resolved from the built cell's mesh, as ``fairbeam run`` does; both runs share the mesh.
    A sample of positive thickness also gets its material parameters (:func:`extract_material`;
    ``nist`` adds the eps-only iterative method for non-magnetic samples)."""
    from .simdata import mark_running

    sim = module.build(values)
    cell = getattr(sim, "material_cell", None)
    fixture = getattr(sim, "waveguide_fixture", None)
    if cell is None and fixture is None:
        raise ValueError("the model builds no plane-wave cell or waveguide fixture: create an "
                         "fairbeam.material_cell.PlaneWaveCell or fairbeam.waveguide_fixture.WaveguideFixture in build()")
    if threads == "auto":
        from .cli import _resolve_run_threads

        threads = _resolve_run_threads("auto", sim)
        log(f"fairbeam: threads {threads} (auto)")
    if fixture is not None:
        from .waveguide_fixture import run_fixture

        return run_fixture(module, values, sim, sim_path=sim_path, threads=threads, echo=echo, engine=engine,
                           exact=exact, end_db=end_db, n_freq=n_freq, nist=nist, nrw_floor=nrw_floor, log=log)
    for w in cell.warnings:
        log(f"fairbeam: warning: {w}")
    ref = cell.reference()
    if end_db is not None:
        for s in (sim, ref):
            s.end_criteria_db = float(end_db)
            s.fdtd.SetEndCriteria(10 ** (end_db / 10))
    f = np.linspace(sim.f_min, sim.f_max, int(n_freq))
    t0 = time.time()
    with mark_running(sim_path):
        # the soft source adds its amplitude once per timestep, so the launched wave scales with
        # 1 / dt: the two probe voltages are comparable only at one step
        stats = run_at_one_timestep({"reference": ref, "sample": sim}, sim_path, PROBE_NAMES[0], threads=threads,
                                    echo=echo, engine=engine, exact=exact, log=log)
        tot = _probe_voltages(sim.sim_path, f)
        inc = _probe_voltages(ref.sim_path, f)
    res = cell_sparams(f, inc, tot, cell.z1, cell.z2, cell.front, cell.back, sim.unit)
    out = {"result": res, "cell": cell.describe(), "run_stats": stats,
           "wall_time_total_s": round(time.time() - t0, 2), "sim": sim}
    layers_fn = getattr(module, "analytic_layers", None)
    layers = layers_fn(values) if layers_fn is not None else None
    if layers is not None:
        from .analytic import slab_s

        s_ref = slab_s(f, layers, unit=sim.unit)
        out["analytic"] = {"s11": s_ref[:, 0, 0], "s21": s_ref[:, 1, 0], "deviation": compare(res, s_ref)}
    if cell.back > cell.front:
        try:
            out["material"] = extract_material(res, cell.back - cell.front, sim.unit, nist=nist,
                                               expected=layers[0] if layers and len(layers) == 1 else None,
                                               sin_floor=nrw_floor)
        except ValueError as e:     # e.g. no reflection at all: S11 and S21 are still written
            log(f"fairbeam: note: no material parameters: {e}")
    else:
        log("fairbeam: note: the sample has no thickness (a sheet): no material parameters extracted")
    return out


def extract_material(res: dict, thickness: float, unit: float = 1e-3, *, nist: bool = False,
                     expected: dict | None = None, sin_floor: float | None = None, kc: float = 0.0,
                     beta0=None) -> dict:
    """eps_r(f), mu_r(f) and the loss tangents of a sample of ``thickness`` (drawing units) from a
    cell result (:func:`cell_sparams`) by NRW (fairbeam.nrw; ``sin_floor``: its reliability
    criterion, default ``fairbeam.nrw.SIN_FLOOR``), and with ``nist`` eps_r(f) by the NIST
    iterative method (mu_r = 1). ``expected`` (one :func:`fairbeam.analytic.slab_s` layer) adds the
    deviations from its eps and mu: NRW over its reliable frequencies, NIST over all. ``kc`` and
    ``beta0`` select the guided form (fairbeam.waveguide_fixture)."""
    from .analytic import layer_constants
    from .nrw import SIN_FLOOR, compare_material, nist_eps, nrw

    f = res["f"]
    floor = SIN_FLOOR if sin_floor is None else float(sin_floor)
    # --nist declares the sample non-magnetic; NRW then also picks the branch above an opaque band by mu_r = 1
    out = {"thickness": float(thickness),
           "nrw": nrw(f, res["s11"], res["s21"], thickness, unit, floor, nonmagnetic=nist, kc=kc, beta0=beta0)}
    if nist:
        out["nist"] = nist_eps(f, res["s11"], res["s21"], thickness, unit, kc=kc, beta0=beta0)
    if expected is not None:
        eps_x, mu_x = layer_constants(f, expected)
        out["expected"] = {"eps_r": eps_x, "mu_r": mu_x}
        out["deviation"] = {"nrw": compare_material(f, out["nrw"], eps_x, mu_x, out["nrw"]["reliable"])}
        if nist:
            out["deviation"]["nist"] = compare_material(f, out["nist"], eps_x)
    return out


def _material_json(m: dict) -> dict:
    r = m["nrw"]
    doc = {"thickness": m["thickness"],
           "nrw": {"method": "Nicolson-Ross-Weir, branch by group delay", "eps_r": _complex(r["eps_r"]),
                   "mu_r": _complex(r["mu_r"]), "tan_d": r["tan_d"], "tan_d_mu": r["tan_d_mu"],
                   "group_index": r["group_index"], "branch": r["branch"], "segments": r["segments"],
                   "reliable": [bool(v) for v in r["reliable"]],
                   "criterion": f"unreliable where |sin(beta' d)| < {r['sin_floor']:g} beyond the first half wave"}}
    if "nist" in m:
        n = m["nist"]
        doc["nist"] = {"method": "NIST iterative (Baker-Jarvis 1990), mu_r = 1", "eps_r": _complex(n["eps_r"]),
                       "tan_d": n["tan_d"], "iterations": [int(v) for v in n["iterations"]],
                       "converged": [bool(v) for v in n["converged"]], "residual": n["residual"]}
    if "expected" in m:
        doc["expected"] = {"eps_r": _complex(m["expected"]["eps_r"]), "mu_r": _complex(m["expected"]["mu_r"])}
        doc["deviation"] = m["deviation"]
    if "gap_correction" in m:       # waveguide fixture with an air gap: nrw / nist above are the apparent values
        def corrected(g):
            out = {k: g[k] for k in ("gap_x", "gap_y", "model", "deviation") if k in g}
            for method in ("nrw", "nist"):
                if method in g:
                    out[method] = {"eps_r": _complex(g[method]["eps_r"]), "tan_d": g[method]["tan_d"]}
            return out

        g = m["gap_correction"]
        doc["gap_correction"] = corrected(g)
        if "capacitor" in g:
            doc["gap_correction"]["capacitor"] = corrected(g["capacitor"])
    return doc


def to_json(out: dict, model: dict, params: list, name: str) -> dict:
    """The result file of ``fairbeam material-cell`` (not a project bundle)."""
    from ._meta import __version__

    res, sim = out["result"], out["sim"]
    doc = {"kind": RESULT_KIND, "version": 1, "name": name, "model": model, "params": params,
           "fairbeam": __version__, "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
           "unit": sim.unit, "band": {"f_min": sim.f_min, "f_max": sim.f_max}, "excitation": sim.excitation,
           "z_ref": float(Z0), "cell": out["cell"], "materials": sim.materials,
           "frequency": [float(x) for x in res["f"]], "s11": _complex(res["s11"]), "s21": _complex(res["s21"]),
           "R2": [float(x) for x in res["R2"]], "T2": [float(x) for x in res["T2"]],
           "absorption": [float(x) for x in res["absorption"]],
           "run_stats": out["run_stats"], "wall_time_total_s": out["wall_time_total_s"]}
    doc["setup"] = out.get("setup", "plane-wave")
    if doc["setup"] == "waveguide":
        b = out["beta0"]
        doc["z_ref"] = [float(x) for x in out["z_ref"]]     # TE10 wave impedance per frequency
        doc["beta0"] = {"measured": [float(x) for x in b["measured"]], "analytic": [float(x) for x in b["analytic"]],
                        "max_rel_difference": b["max_rel_difference"],
                        "note": "measured in the empty run between the reference planes; used for de-embedding "
                                "and in NRW / NIST"}
        doc["empty"] = {"s11": _complex(out["empty"]["s11"]), "s21_faces": _complex(out["empty"]["s21_faces"])}
    if "analytic" in out:
        a = out["analytic"]
        doc["analytic"] = {"method": a.get("method", "transfer matrix (homogeneous layers, normal incidence)"),
                           "s11": _complex(a["s11"]), "s21": _complex(a["s21"]), "deviation": a["deviation"]}
    if "material" in out:
        doc["material"] = _material_json(out["material"])
    return doc


# ---------------------------------------------------------------------------- command line

def add_command(sub, defaults: dict):
    """Register ``material-cell`` on the fairbeam argparse subparsers."""
    from .cli import _thread_count

    p = sub.add_parser("material-cell", help="normal-incidence plane-wave cell or TE10 waveguide fixture: S11 and "
                                             "S21 of a sample from a sample run and an empty reference run")
    p.add_argument("model", help="path to a model .py file that builds a fairbeam.material_cell.PlaneWaveCell or "
                                 "a fairbeam.waveguide_fixture.WaveguideFixture")
    p.add_argument("--set", action="append", metavar="KEY=VALUE", help="override a model parameter")
    p.add_argument("--name", help="result file name (without .cell.json)")
    p.add_argument("--out", default=".", help="folder for the result file (default: the current folder)")
    p.add_argument("--sim-root", default=str(defaults["sim"]), help="folder for raw openEMS output")
    p.add_argument("--threads", type=_thread_count, default="auto", metavar="N|auto",
                   help="FDTD threads (default: Auto from host and built mesh)")
    p.add_argument("--points", type=int, default=401, help="frequency points (default 401)")
    p.add_argument("--quiet", action="store_true", help="do not echo openEMS output")
    p.add_argument("--engine", choices=["cpu", "gpu"], default=os.environ.get("FAIRBEAM_ENGINE", "cpu"),
                   help="FDTD engine; gpu needs the openEMS GPU build")
    p.add_argument("--end-db", type=float, help="energy end criterion in dB (default: the model's, -60 unless set)")
    p.add_argument("--no-exact", action="store_true",
                   help="check the end criterion every ~4 s of wall time instead of every Nyquist period")
    p.add_argument("--tol", type=float, metavar="DS",
                   help="exit with status 1 when |S11| or |S21| deviates from the model's analytic slab by more "
                        "than DS (linear, complex difference)")
    p.add_argument("--nist", action="store_true",
                   help="declare the sample non-magnetic: also extract eps_r with the NIST iterative method "
                        "(mu_r = 1), and let NRW choose its branch above an opaque band by mu_r = 1")
    p.add_argument("--nrw-floor", type=float, metavar="S",
                   help="NRW reliability criterion: frequencies with |sin(beta' d)| < S beyond the first half wave "
                        "are unreliable (default 0.3)")
    p.add_argument("--tol-material", type=float, metavar="REL",
                   help="exit with status 1 when the extracted eps_r' or mu_r' deviates from the model's single "
                        "analytic layer by more than REL (relative), or a loss tangent by more than REL (absolute)")
    p.set_defaults(func=cmd_material_cell)


def cmd_material_cell(args):
    from .cli import _overrides, _slug
    from .model import load_model, resolve_params

    module = load_model(args.model)
    overrides = _overrides(args.set)
    values = resolve_params(module.PARAMS, overrides)
    params = [p.describe(values[p.key]) for p in module.PARAMS]
    slug = args.name or _slug(module.MODEL["id"], overrides)
    label = module.MODEL["name"] + ("" if not overrides else " · " + ", ".join(
        f"{k}={v}" for k, v in sorted(overrides.items())))
    print(f"fairbeam: {label}", flush=True)
    out = run_cell(module, values, sim_path=str(Path(args.sim_root) / slug), threads=args.threads, echo=not args.quiet,
                   engine=args.engine, exact=not args.no_exact, end_db=args.end_db, n_freq=args.points,
                   nist=args.nist, nrw_floor=args.nrw_floor)
    res = out["result"]
    print(f"fairbeam: |S11| {_db_range(res['s11'])} dB, |S21| {_db_range(res['s21'])} dB, "
          f"absorption {res['absorption'].min():.4f} .. {res['absorption'].max():.4f}")
    status = 0
    if "analytic" in out:
        d = out["analytic"]["deviation"]
        print(f"fairbeam: analytic slab: max |dS11| {d['max_abs_ds11']:.4f}, max |dS21| {d['max_abs_ds21']:.4f}, "
              f"|S21| within {d['max_s21_db_error']:.3f} dB and {d['max_s21_phase_error_deg']:.2f} deg")
        if args.tol is not None and max(d["max_abs_ds11"], d["max_abs_ds21"]) > args.tol:
            print(f"fairbeam: deviation from the analytic slab above --tol {args.tol:g}", file=sys.stderr)
            status = 1
    elif args.tol is not None:
        print("fairbeam: --tol given but the model defines no analytic_layers(p)", file=sys.stderr)
        status = 1
    if "material" in out:
        status = max(status, _print_material(out["material"], res["f"], args.tol_material))
    elif args.tol_material is not None:
        print("fairbeam: --tol-material given but no material parameters were extracted", file=sys.stderr)
        status = 1
    doc = to_json(out, module.MODEL, params, label)
    folder = Path(args.out)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{slug}.cell.json"
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(finite_json(doc), separators=(",", ":"), allow_nan=False), encoding="utf-8")
    os.replace(tmp, path)
    print(f"fairbeam: wrote {path}")
    return status


def _print_material(m: dict, f, tol: float | None) -> int:
    """Print the extracted material summary; 1 when a deviation exceeds ``tol`` (for a
    frequency-dependent expected layer the complex relative errors, else all of them)."""
    r = m["nrw"]
    dispersive = "expected" in m and np.ptp(np.asarray(m["expected"]["eps_r"]).real) > 0
    rel = r["reliable"]
    mid = int(np.argmin(np.abs(f - (f[0] + f[-1]) / 2)))

    def rng(v):
        v = np.asarray(v)[rel]
        return f"{np.nanmin(v):.4g} .. {np.nanmax(v):.4g}" if len(v) else "unavailable"

    print(f"fairbeam: NRW (d = {m['thickness']:g}, branch {r['branch']}, {int(rel.sum())}/{len(rel)} frequencies "
          f"reliable): eps_r' {rng(r['eps_r'].real)}, tan d {rng(r['tan_d'])}, mu_r' {rng(r['mu_r'].real)}")
    if "nist" in m:
        n = m["nist"]
        print(f"fairbeam: NIST (mu_r = 1, {int(n['converged'].sum())}/{len(f)} converged): eps_r' "
              f"{np.nanmin(n['eps_r'].real):.4g} .. {np.nanmax(n['eps_r'].real):.4g}, tan d at "
              f"{f[mid] / 1e9:.3g} GHz {n['tan_d'][mid]:.4g}")
        mu_med = float(np.nanmedian(r["mu_r"].real[rel])) if rel.any() else float("nan")
        if abs(mu_med - 1) > MAGNETIC_HINT:
            print(f"fairbeam: warning: NRW finds mu_r' = {mu_med:.3g}, so the sample is magnetic and the NIST "
                  "result (which assumes mu_r = 1) does not describe it")
    gap = m.get("gap_correction")
    if gap:
        for method in ("nrw", "nist"):
            if method in gap:
                e = gap[method]
                pick = rel if method == "nrw" else np.ones(len(f), bool)
                print(f"fairbeam: {method.upper()} corrected for the air gap, resonance model (gap_x {gap['gap_x']:g}, gap_y "
                      f"{gap['gap_y']:g}): eps_r' {np.nanmin(e['eps_r'].real[pick]):.4g} .. "
                      f"{np.nanmax(e['eps_r'].real[pick]):.4g}, tan d at {f[mid] / 1e9:.3g} GHz {e['tan_d'][mid]:.4g}"
                      if pick.any() else f"fairbeam: {method.upper()} corrected for the air gap: unavailable")
    if not rel.any() and not ("nist" in m and m["nist"]["converged"].any()):
        print("fairbeam: no reliable material retrieval (opaque, isolated or unresolved samples)", file=sys.stderr)
        return 1
    if "deviation" not in m:
        if tol is not None:
            print("fairbeam: --tol-material given but the model defines no single analytic layer", file=sys.stderr)
            return 1
        return 0
    status = 0
    # with an air gap the extracted values are apparent ones: --tol-material checks the corrected
    deviations = [(f"{k.upper()} (apparent, air gap not corrected)", d, False) for k, d in m["deviation"].items()]
    if gap and "deviation" in gap:
        deviations += [(f"{k.upper()} (air gap corrected, resonance)", d, True) for k, d in gap["deviation"].items()]
        deviations += [(f"{k.upper()} (air gap corrected, capacitor)", d, False)
                       for k, d in gap.get("capacitor", {}).get("deviation", {}).items()]
    else:
        deviations = [(k.upper(), d, True) for k, d in m["deviation"].items()]
    for label, d, checked in deviations:
        mu = (f", mu_r' {100 * d['max_rel_mu_real']:.2f} %, tan d_mu {d['max_abs_tan_d_mu']:.4f}, "
              f"|d mu| / |mu| {100 * d['max_rel_mu']:.2f} %" if "max_rel_mu_real" in d else "")
        print(f"fairbeam: {label} vs the analytic layer ({d['points']} frequencies): eps_r' within "
              f"{100 * d['max_rel_eps_real']:.2f} %, tan d within {d['max_abs_tan_d']:.4f}, |d eps| / |eps| "
              f"{100 * d['max_rel_eps']:.2f} %{mu}")
        # a dispersive eps' can cross zero: there only the complex relative errors mean something
        keys = (("max_rel_eps", "max_rel_mu") if dispersive
                else tuple(k for k in d if k not in ("points", "max_rel_eps", "max_rel_mu")))
        worst = max(d[k] for k in keys if k in d)
        if checked and tol is not None and not worst <= tol:
            print(f"fairbeam: {label} deviation above --tol-material {tol:g}", file=sys.stderr)
            status = 1
    return status


def _db_range(s) -> str:
    db = 20 * np.log10(np.maximum(np.abs(s), 1e-15))
    return f"{db.min():.2f} .. {db.max():.2f}"
