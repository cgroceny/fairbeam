"""Thin wrapper around openEMS that records everything the viewer and exporters need."""

import ctypes
import os
import platform
import re
import sys
import threading
import time
from contextlib import contextmanager

import numpy as np
from CSXCAD import ContinuousStructure
from openEMS import openEMS
from openEMS.physical_constants import C0, EPS0

from .excitation import dgauss_duration_s, dgauss_expression
from .wgport import _FilledRectWGPort, probe_power_factor

BOUNDARY_NAMES = ("x-", "x+", "y-", "y+", "z-", "z+")

# Efficiency over the band (Simulation._band_efficiency): the angular grid of its NF2FF transform
# (degrees; Prad does not depend on it, see there) and its result file next to the pattern's
# nf2ff.h5. The number of frequencies: fairbeam.design EFFICIENCY_POINTS_*.
EFFICIENCY_THETA_STEP, EFFICIENCY_PHI_STEP = 90.0, 180.0
EFFICIENCY_OUTFILE = "nf2ff_efficiency.h5"
# Reliability of the efficiency over the band (Simulation._pacc_error): the error of the accepted
# power from stopping the run is estimated as the part of Pacc the last EFFICIENCY_TAIL of the
# ring-down contributes; a frequency is reliable when that is at most EFFICIENCY_MAX_ERROR of Pacc.
EFFICIENCY_TAIL = 0.1
EFFICIENCY_MAX_ERROR = 0.1
# A model marked lossless (Simulation.lossless) reports a radiation efficiency of 1 while the
# measured Prad / Pacc stays within this of 1 (Simulation._lossless_efficiency)
LOSSLESS_TOLERANCE = 0.05
# A waveguide port's power calibration (Simulation._calibrate_waveguide_port) is applied only when
# the factor lies within these bounds; outside them the probe box is not a closed metal-walled
# guide of the stated size and the correction would not describe the port
WG_PROBE_FACTOR_RANGE = (0.9, 1.3)


def _load_libc():
    """The C runtime whose stdio buffers openEMS writes through, for fflush(NULL) before the
    output capture is torn down. POSIX: the process' libc. Windows: the Universal CRT that both
    CPython (3.5+) and MSVC builds of openEMS link dynamically (older builds: msvcrt). None when
    neither loads: capture then relies on openEMS flushing its own streams."""
    if sys.platform == "win32":
        for name in ("ucrtbase", "msvcrt"):
            try:
                return ctypes.CDLL(name)
            except OSError:
                continue
        return None
    return ctypes.CDLL(None)


_libc = _load_libc()

# Port number to excite while a model is being built (see excite_only); None = as the model says.
_EXCITE_ONLY: int | None = None


@contextmanager
def excite_only(port: int | None):
    """Build a model with exactly one excited port (all others terminated in their resistance).

    openEMS decides which ports are driven when the port is created, so the multi-port runner
    (``fairbeam.multiport``) rebuilds the model once per excited port inside this context.
    """
    global _EXCITE_ONLY
    old, _EXCITE_ONLY = _EXCITE_ONLY, port
    try:
        yield
    finally:
        _EXCITE_ONLY = old


class Simulation:
    """An openEMS FDTD setup plus the metadata required to describe and export it.

    Geometry is created through the usual CSXCAD calls on :attr:`csx`; the helpers here only exist
    where openEMS does not keep the information we need to export later (material loss definition,
    port definitions, excitation, boundaries).
    """

    def __init__(self, f_min: float, f_max: float, *, unit: float = 1e-3,
                 boundaries=("MUR",) * 6, excitation: str = "dgauss",
                 end_criteria_db: float = -60.0, max_timesteps: int = 60000):
        if excitation not in ("dgauss", "gauss"):
            raise ValueError("excitation must be 'dgauss' or 'gauss'")
        if not 0 <= float(f_min) < float(f_max):
            raise ValueError(f"frequency band must satisfy 0 <= f_min < f_max (got {f_min:g} .. {f_max:g} Hz)")
        self.f_min, self.f_max, self.unit = float(f_min), float(f_max), float(unit)
        self.boundaries = list(boundaries)
        self.end_criteria_db = float(end_criteria_db)
        self.max_timesteps = int(max_timesteps)

        self.fdtd = openEMS(NrTS=self.max_timesteps, EndCriteria=10 ** (self.end_criteria_db / 10))
        if excitation == "dgauss":
            expr = dgauss_expression(self.f_max)
            self.fdtd.SetCustomExcite(expr, self.f_max, self.f_max)
            self.excitation = {"type": "gaussian-derivative", "f_min": self.f_min, "f_max": self.f_max,
                               "expression": expr, "dc_free": True}
        else:
            f0, fc = (self.f_min + self.f_max) / 2, (self.f_max - self.f_min) / 2
            self.fdtd.SetGaussExcite(f0, fc)
            self.excitation = {"type": "gaussian", "f0": f0, "fc": fc, "f_min": self.f_min,
                               "f_max": self.f_max, "dc_free": False}
        self.fdtd.SetBoundaryCond(self.boundaries)

        self.csx = ContinuousStructure()
        self.fdtd.SetCSX(self.csx)
        self.mesh = self.csx.GetGrid()
        self.mesh.SetDeltaUnit(self.unit)

        self.materials: dict[str, dict] = {}
        #: dispersive materials by name (fairbeam.dispersion.Dispersion), see dispersive()
        self.dispersions: dict = {}
        self.ports: list[dict] = []
        self._port_objs = []
        self.lumped_elements: list[dict] = []
        #: thin metal built as sheets (fairbeam.design.thin_sheets); the bundle shows the drawn bricks
        self.thin_sheets: list[dict] = []
        self.nf2ff = None
        self.nf2ff_center = None
        self.focus = None
        self.run_stats: dict | None = None
        self.results: dict | None = None
        self.sim_path: str | None = None
        #: add RHCP/LHCP directivity and axial ratio to every far-field entry (bundle field "cp")
        self.cp_outputs = False
        # default far-field frequencies (Hz) when evaluate() gets none; None = band centres. For
        # broadband antennas (horns, helices) the S11 minimum says little about the design frequency.
        self.pattern_freqs = None
        # surface-current maps (Hz) that `fairbeam run` records when no --fields flag is given
        # (fairbeam.fields; a design's monitors.currents); None = none
        self.current_freqs = None
        # E/H field maps on cut planes that `fairbeam run` records when no --field-plane flag is given
        # (fairbeam.field_planes; a design's monitors.field_planes): [{quantity, normal, position,
        # frequencies (Hz), component}]; None = none
        self.field_plane_monitors = None
        # radiation efficiency over the band (bundle results.efficiency): this many frequencies from
        # f_min to f_max, post-processed from the NF2FF box's time-domain dumps (a design's
        # monitors.efficiency, `fairbeam run --efficiency`); None = off
        self.efficiency_points = None
        #: the model has no loss mechanism (PEC metals, loss-free materials, no resistors), so its
        #: radiation efficiency is 1 and Prad / Pacc only measures numerical agreement; checked at
        #: evaluate() (_is_lossless), reported within LOSSLESS_TOLERANCE (_lossless_efficiency)
        self.lossless = False
        #: correct a waveguide port's incident / reflected / accepted power for the mesh-dependent
        #: deficit of openEMS' mode-matching probes at the guide walls (fairbeam.wgport, #12)
        self.wg_probe_correction = True

    # ------------------------------------------------------------------ structure helpers

    def metal(self, name: str, label: str | None = None, color: str | None = None,
              conductivity: float | None = None, thickness: float | None = None):
        """A metal: a perfect conductor (openEMS ``AddMetal``) unless ``conductivity`` (S/m) is
        given. A lossy metal (:class:`LossyMetal`) builds its sheets as openEMS conducting sheets
        of ``thickness`` (drawing units; default ``SHEET_THICKNESS_MM``) and its volumes as a
        material of that conductivity."""
        if conductivity is None:
            self._record(name, label=label, color=color, kind="metal")
            return self.csx.AddMetal(name)
        return LossyMetal(self, name, float(conductivity), thickness, label=label, color=color)

    def dielectric(self, name: str, eps_r: float, tan_d: float = 0.0, tan_d_freq: float | None = None,
                   label: str | None = None, color: str | None = None, mu_r: float = 1.0,
                   void: bool = False):
        """Lossy dielectric. openEMS models loss as a constant conductivity, so tan δ is exact only
        at ``tan_d_freq`` (defaults to the band centre). ``mu_r`` is a loss-free relative
        permeability (openEMS ``mue``); it is recorded only when it is not 1. ``void`` marks a vacuum
        carver (a Boolean Subtract's cut-out); it is recorded for the bundle and viewers."""
        f_ref = tan_d_freq or (self.f_min + self.f_max) / 2
        kappa = tan_d * 2 * np.pi * f_ref * EPS0 * eps_r
        mu_r = float(mu_r)
        self._record(name, label=label, color=color, kind="dielectric", tan_d=tan_d, tan_d_freq=f_ref,
                     mu_r=None if mu_r == 1.0 else mu_r, void=True if void else None)
        if mu_r == 1.0:
            return self.csx.AddMaterial(name, epsilon=eps_r, kappa=kappa)
        return self.csx.AddMaterial(name, epsilon=eps_r, mue=mu_r, kappa=kappa)

    def dispersive(self, name: str, model, label: str | None = None, color: str | None = None,
                   n_poles: int | None = None, dt: float | None = None):
        """A frequency-dependent dielectric (fairbeam.dispersion): a ``Dispersion`` of Lorentz and
        Drude poles (given to openEMS as they are), or one with Debye poles (any Lorentz and Drude
        poles next to them are kept), or a
        ``DjordjevicSarkar`` laminate. The last two are fitted here to overdamped Lorentz poles over
        this band, since openEMS' DebyeMaterial diverges for larger delta / eps_inf (fairbeam.debye_fit.fit_model;
        ``n_poles``, and ``dt``, the timestep the poles must be resolved by: default
        :meth:`cfl_timestep` when the mesh is already built, else the CFL step of a 20 cells/lambda
        cube mesh at f_max inside the material; build the mesh first where possible). The fitted
        poles are what is simulated and recorded (``self.dispersions[name]``), with the model and
        the fit report in their ``source``. The run checks the poles against the real timestep
        (``run_stats["dispersion_problems"]``). The bundle part is a ``"Material"`` with the values
        at the band centre and the simulated model in ``material.dispersion`` (docs/BUNDLE.md)."""
        from .dispersion import Dispersion, DjordjevicSarkar, model_from_dict

        if isinstance(model, dict):     # a model read from JSON (to_dict, a .dispersion.json, a bundle record)
            model = model_from_dict(model)
        if isinstance(model, DjordjevicSarkar) or (isinstance(model, Dispersion) and model.model == "debye"):
            from .debye_fit import fit_model

            disp, rep = fit_model(model, self.f_min, self.f_max, n_poles=n_poles, dt=dt or self.cfl_timestep())
            disp = Dispersion(disp.eps_inf, disp.eps_poles, disp.kappa, disp.mu_inf, disp.mu_poles,
                              source={**disp.source, "report": rep})
        elif isinstance(model, Dispersion):
            disp = model
        else:
            raise TypeError("dispersive() takes a fairbeam.dispersion Dispersion or DjordjevicSarkar, "
                            "or the to_dict() of one")
        f_c = (self.f_min + self.f_max) / 2
        eps, mu = complex(disp.eps(f_c)), complex(disp.mu(f_c))
        if not np.isfinite(eps) or not np.isfinite(mu):
            raise ValueError("dispersive material has non-finite band-center constants")
        # The constant fields describe the material at the band centre, as for Simulation.dielectric:
        # kappa is the conductivity that gives the whole loss there (kappa = tan_d 2 pi f eps0 eps_r),
        # so a consumer that takes the loss as a conductivity (the CST export) keeps it; the static
        # conductivity is in dispersion.kappa.
        self._record(name, label=label, color=color, kind="dielectric", eps_r=eps.real, mu_r=mu.real,
                     kappa=float(-eps.imag * 2 * np.pi * f_c * EPS0),
                     tan_d=-eps.imag / eps.real if eps.real != 0 else None,
                     tan_d_freq=f_c, dispersion=disp.to_dict())
        self.dispersions[name] = disp
        return disp.add_to(self.csx, name)

    def lumped_port(self, number: int, R: float, start, stop, direction: str, excite: bool = True,
                    reference_impedance=None, *, group: dict | None = None, **kw):
        """Discrete feed; opt-in ``group`` combines additional feeds into one signed mode.

        The first feed is start/stop/direction with positive polarity. ``group`` contains
        connection (parallel or series) and 1..15 additional members, each with start, stop,
        direction and optional polarity (+1 or -1). R is the logical reference resistance.
        """
        if _EXCITE_ONLY is not None:
            excite = number == _EXCITE_ONLY
        if reference_impedance is not None:
            zr = complex(reference_impedance["real"], reference_impedance["imag"])
            if not np.isfinite(zr) or zr.real <= 0:
                raise ValueError("power-wave reference requires a positive finite real part")
        if group is not None:
            from .design import DesignError, check_port_group, port_feeds
            try:
                R = float(R)
            except (TypeError, ValueError):
                raise ValueError("grouped port R must be finite and positive") from None
            record = {"number": number, "type": "lumped", "R": R, "direction": direction,
                      **({"reference_impedance": dict(reference_impedance)} if reference_impedance is not None else {}),
                      "start": list(start), "stop": list(stop), "excite": bool(excite), "group": group}
            try:
                check_port_group(record, "port")
            except DesignError as error:
                raise ValueError(str(error)) from None
            if not isinstance(number, int) or isinstance(number, bool) or number < 1 or any(
                    p["number"] == number for p in self.ports):
                raise ValueError("grouped port number must be a unique positive integer")
            R = record["R"]
            if not np.isfinite(R) or R <= 0:
                raise ValueError("grouped port R must be finite and positive")
            if set(kw) - {"priority"}:
                raise ValueError("grouped ports support priority only; custom probe/source options are not recorded")
            priority = kw.get("priority", group.get("priority", 5))
            if "priority" in group and priority != group["priority"]:
                raise ValueError("group priority disagrees with the priority argument")
            if (isinstance(priority, bool) or not isinstance(priority, (int, float))
                    or not np.isfinite(priority) or priority < 0 or int(priority) != priority):
                raise ValueError("group priority must be a nonnegative integer")
            priority = int(priority)
            feeds = []
            for path, feed in port_feeds(record, "port"):
                a, b = np.asarray(feed["start"], float), np.asarray(feed["stop"], float)
                if a.shape != (3,) or b.shape != (3,) or not np.isfinite([a, b]).all():
                    raise ValueError(f"{path}: feed coordinates must be finite triples")
                if feed["direction"] not in ("x", "y", "z"):
                    raise ValueError(f"{path}: direction must be x, y or z")
                length = abs(b["xyz".index(feed["direction"])] - a["xyz".index(feed["direction"])])
                if length == 0:
                    raise ValueError(f"{path}: feed must have length along its direction")
                feeds.append({"start": a.tolist(), "stop": b.tolist(), "direction": feed["direction"],
                              "polarity": int(feed.get("polarity", 1))})
            count = len(feeds)
            parallel = group["connection"] == "parallel"
            member_r = R * count if parallel else R / count
            if not np.isfinite(member_r) or member_r <= 0:
                raise ValueError("group member resistance must be finite and positive")
            native = []
            for j, feed in enumerate(feeds):
                length = abs(feed["stop"]["xyz".index(feed["direction"])] - feed["start"]["xyz".index(feed["direction"])])
                # Equal modal voltages even when the member gaps have different lengths.
                amplitude = feed["polarity"] / length / (1 if parallel else count) if excite else 0.0
                native.append(self.fdtd.AddLumpedPort(number, member_r, feed["start"], feed["stop"],
                              feed["direction"], amplitude, priority=priority,
                              PortNamePrefix=f"group_{number}_{j}_"))
            record.update(start=feeds[0]["start"], stop=feeds[0]["stop"])
            record["group"] = {"connection": group["connection"], "members": feeds[1:],
                               **({"priority": priority} if priority != 5 else {})}
            port = GroupedLumpedPort(record, native)
            self.ports.append(record)
            self._port_objs.append(port)
            return port
        port = self.fdtd.AddLumpedPort(number, R, start, stop, direction, 1.0 if excite else 0.0, **kw)
        self.ports.append({"number": number, "type": "lumped", "R": float(R), "direction": direction,
                           **({"reference_impedance": dict(reference_impedance)} if reference_impedance is not None else {}),
                           "start": [float(v) for v in start], "stop": [float(v) for v in stop],
                           "excite": bool(excite)})
        self._port_objs.append(port)
        return port

    def waveguide_port(self, number: int, start, stop, direction: str, a: float, b: float, mode: str = "TE10",
                       excite: bool = True, *, eps_r: float = 1.0, mu_r: float = 1.0, **kw):
        """Rectangular waveguide port (openEMS ``RectWGPort``) exciting/measuring one TE_mn mode.

        ``start``/``stop`` span the waveguide cross-section; the excitation sits in the ``start``
        plane and the voltage/current (mode amplitude) probes in the ``stop`` plane, a cell or so
        further along ``direction``. ``a`` is the broad wall along axis (direction+1)%3 and ``b``
        along (direction+2)%3, in drawing units. The reference impedance is the frequency-dependent
        TE wave impedance Z_TE = eta0 k / beta, so S11 is the ratio of reflected to incident mode
        amplitude (docs/BUNDLE.md, ports). Terminate the guide behind the port in a PML (run it
        through the boundary) so the backward wave is absorbed.

        ``eps_r``/``mu_r`` opt in to the reference of a homogeneous, isotropic,
        nondispersive filling: beta = sqrt(k0**2 eps_r mu_r - kc**2) and
        Z_TE = eta0 mu_r k0 / beta. These values describe the port reference;
        they do not create material. Use matching material across the entire
        port cross-section. Evaluation is supported above the mode cutoff.
        The Python-only options are not inferred or added to the design schema.
        A filled reference is recorded in the port entry (``eps_r``, ``mu_r``), as
        ``dielectric`` records ``mu_r``; the air reference adds neither key.
        """
        for name, value in (("eps_r", eps_r), ("mu_r", mu_r)):
            if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, float, np.integer, np.floating)):
                raise ValueError(f"waveguide port {name} must be a finite positive real number")
            if not np.isfinite(value) or value <= 0:
                raise ValueError(f"waveguide port {name} must be a finite positive real number")
        eps_r, mu_r = float(eps_r), float(mu_r)
        if not np.isfinite(eps_r * mu_r) or eps_r * mu_r == 0:
            raise ValueError("waveguide port eps_r * mu_r must be finite and positive")
        if _EXCITE_ONLY is not None:
            excite = number == _EXCITE_ONLY
        if eps_r == 1.0 and mu_r == 1.0:
            port = self.fdtd.AddRectWaveGuidePort(number, start, stop, direction, a * self.unit, b * self.unit, mode,
                                                  1 if excite else 0, **kw)
        else:
            port = _FilledRectWGPort(self.csx, number, start, stop, direction, a * self.unit, b * self.unit, mode,
                                    1 if excite else 0, eps_r=eps_r, mu_r=mu_r, **kw)
        m, n = int(mode[2]), int(mode[3])
        kc = np.sqrt((m * np.pi / (a * self.unit)) ** 2 + (n * np.pi / (b * self.unit)) ** 2)
        f_c = kc * C0 / (2 * np.pi * np.sqrt(eps_r * mu_r))
        f_mid = (self.f_min + self.f_max) / 2
        z_mid = 376.730313668 * (np.sqrt(mu_r) / np.sqrt(eps_r)) / np.sqrt(max(1 - (f_c / f_mid) ** 2, 1e-12))
        filled = isinstance(port, _FilledRectWGPort)
        self.ports.append({"number": number, "type": "waveguide", "mode": mode, "a": float(a), "b": float(b),
                           "f_cutoff": float(f_c), "R": round(float(z_mid), 3), "direction": direction,
                           "start": [float(v) for v in start], "stop": [float(v) for v in stop],
                           "excite": bool(excite), **({"eps_r": eps_r, "mu_r": mu_r} if filled else {})})
        self._port_objs.append(port)
        return port

    def lumped_resistor(self, name: str, R: float, start, stop, direction: str, label: str | None = None,
                        priority: int = 5):
        """A lumped resistor (openEMS LumpedElement, R only) across ``start``-``stop`` along
        ``direction``, e.g. the isolation resistor of a Wilkinson divider. Recorded in the bundle's
        ``lumped_elements`` so the viewer and the CST exporter can show it."""
        return self.lumped_element(name, start, stop, direction, R=R, label=label, priority=priority)

    def lumped_element(self, name: str, start, stop, direction: str, R=None, L=None, C=None,
                       topology="parallel", label=None, priority=5):
        """Native ideal R/L/C; L in H and C in F. Absent branches are omitted."""
        if topology not in ("parallel", "series"):
            raise ValueError("lumped topology must be parallel or series")
        values = {key: float(value) for key, value in (("R", R), ("L", L), ("C", C)) if value is not None}
        if not values or any(not np.isfinite(value) or value <= 0 for value in values.values()):
            raise ValueError("at least one positive finite R, L or C is required")
        el = self.csx.AddLumpedElement(name, ny="xyz".index(direction), caps=True, **values)
        if L is not None or len(values) > 1 or topology == "series":
            if not hasattr(el, "SetLEtype"):
                raise RuntimeError("native RLC requires CSXCAD/openEMS 0.37 or later")
            el.SetLEtype(1 if topology == "series" else 0)
        el.AddBox(start, stop, priority=priority)
        self.lumped_elements.append({"name": name, "label": label or name,
                                     "type": "resistor" if set(values) == {"R"} else "rlc",
                                     **values, "topology": topology, "direction": direction,
                                     "start": [float(v) for v in start], "stop": [float(v) for v in stop]})
        return el

    def lumped_inductor(self, name: str, L: float, start, stop, direction: str, label: str | None = None,
                        priority: int = 5):
        """An ideal inductor, ``L`` in henries, across a box in drawing units: :meth:`lumped_element`
        with L alone (native parallel type, LEtype=0), recorded as an ``"rlc"`` element.

        For a series LC, connect separate elements geometrically in series; the combined native
        series element (``topology="series"``) has not met its circuit check
        (docs/benchmarks/rf-rlc-workflows).
        """
        return self._lumped_single(name, "L", L, start, stop, direction, label, priority)

    def lumped_capacitor(self, name: str, C: float, start, stop, direction: str, label: str | None = None,
                         priority: int = 5):
        """An ideal capacitor, ``C`` in farads, across a box in drawing units (see
        :meth:`lumped_inductor`)."""
        return self._lumped_single(name, "C", C, start, stop, direction, label, priority)

    def _lumped_single(self, name, key, value, start, stop, direction, label, priority):
        """One ideal L or C through :meth:`lumped_element`, with the box checked first so that a
        bad call creates no property."""
        if direction not in ("x", "y", "z"):
            raise ValueError("direction must be x, y or z")
        a, c = np.asarray(start, dtype=float), np.asarray(stop, dtype=float)
        if a.shape != (3,) or c.shape != (3,) or not np.isfinite(a).all() or not np.isfinite(c).all():
            raise ValueError("start and stop must contain three finite coordinates")
        ny = "xyz".index(direction)
        if a[ny] == c[ny]:
            raise ValueError("the element must have length along its current direction")
        return self.lumped_element(name, a.tolist(), c.tolist(), direction, label=label, priority=priority,
                                   **{key: value})

    def auto_mesh(self, verbose: bool = False, **kw) -> dict:
        """Generate the whole FDTD mesh from the geometry (``fairbeam.automesh.generate``; see
        docs/MESHING.md). Call after the geometry and ports, before ``add_nf2ff_box``. Returns the
        report (also kept in ``self.mesh_report`` and written to the bundle's ``mesh.auto``)."""
        from .automesh import format_report, generate

        report = generate(self, **kw)
        if verbose:
            print(format_report(report))
        return report

    def smooth_mesh(self, max_res: float | None = None, ratio: float = 1.4):
        """Graded smoothing; default max cell is λ/20 at ``f_max``."""
        max_res = max_res or C0 / self.f_max / self.unit / 20
        self.mesh.SmoothMeshLines("all", max_res, ratio)

    def add_nf2ff_box(self, center=None, directions=None):
        """Near-to-far-field recording box. ``center`` (drawing units) is the phase centre.
        ``directions`` (6 flags, x- x+ y- y+ z- z+) skips faces, e.g. the face a feed waveguide
        passes through (its guided fields are not radiation)."""
        self.nf2ff_faces = None if directions is None else [bool(v) for v in directions]
        if directions is None:
            self.nf2ff = self.fdtd.CreateNF2FFBox()
        else:
            self.nf2ff = self._nf2ff_box_faces(self.nf2ff_faces)
        self.nf2ff_center = None if center is None else [float(v) for v in center]
        return self.nf2ff

    def remove_nf2ff_box(self) -> bool:
        """Remove this box's E/H recording properties before a run.

        Clearing only ``nf2ff`` skips the later transform but leaves openEMS sampling and writing
        the attached HDF5 dumps. Other field monitors and the physical geometry are left alone.
        A completed run is never changed. Returns False without changing anything when an older
        CSXCAD binding has no property-deletion method.
        """
        if self.sim_path is not None:
            raise RuntimeError("remove the NF2FF box before run()")
        if self.nf2ff is None:
            return True
        delete = getattr(self.csx, "DeleteProperty", None)
        if not callable(delete):
            return False
        delete(self.nf2ff.e_dump)
        delete(self.nf2ff.h_dump)
        self.nf2ff = None
        self.nf2ff_center = None
        self.nf2ff_faces = None
        return True

    def _nf2ff_box_faces(self, faces):
        """``CreateNF2FFBox`` with some faces left out (openEMS' own helper fixes them from the
        boundaries). Same placement rule: the box sits one cell inside a PML (PML_n: n + 1 lines),
        two lines inside MUR, on PEC/PMC with mirroring."""
        from openEMS import nf2ff
        grid = self.csx.GetGrid()
        start, stop = np.zeros(3), np.zeros(3)
        mirror, dirs = [0] * 6, list(faces)
        for n in range(6):
            bc = str(self.boundaries[n]).upper()
            size = 0
            if bc in ("PEC", "0", "PMC", "1"):
                mirror[n], dirs[n] = (1 if bc in ("PEC", "0") else 2), False
            elif bc.startswith("MUR") or bc == "2":
                size = 2
            elif bc.startswith("PML"):
                size = int(bc.split("_")[1]) + 1 if "_" in bc else 9
            lines = np.asarray(grid.GetLines(n // 2))
            if n % 2 == 0:
                start[n // 2] = lines[size]
            else:
                stop[n // 2] = lines[-size - 1]
        return nf2ff.nf2ff(self.csx, "nf2ff", start, stop, directions=dirs, mirror=mirror)

    def cfl_timestep(self) -> float | None:
        """The vacuum CFL timestep of the current mesh (s), 1 / (c0 sqrt(1/dx^2 + 1/dy^2 + 1/dz^2))
        with each axis' smallest cell; None until every axis has at least two lines. For the
        plane-wave cells of docs/VALIDATION.md section 15 it equals openEMS' own step for the empty
        cell; openEMS takes a longer one when the cell holds a dielectric."""
        lines = [np.asarray(self.mesh.GetLines(a), float) for a in "xyz"]
        if any(len(v) < 2 for v in lines):
            return None
        inv = sum(1 / (np.min(np.diff(np.sort(v))) * self.unit) ** 2 for v in lines)
        return float(1 / (C0 * np.sqrt(inv)))

    def set_focus(self, lo, hi):
        """Region the viewer frames by default (drawing units)."""
        self.focus = {"min": [float(v) for v in lo], "max": [float(v) for v in hi]}

    def _record(self, name, **meta):
        self.materials[name] = {k: v for k, v in meta.items() if v is not None}

    # ------------------------------------------------------------------ run

    def run(self, sim_path: str, threads: int = 0, echo: bool = True, engine: str = "cpu",
            exact: bool | None = None, **openems_kw) -> dict:
        """Run openEMS.

        ``engine``: "cpu" (multithreaded SSE engine) or "gpu" (Metal/CUDA engine of the openEMS GPU
        fork, see scripts/install-openems-gpu-macos.sh). Upstream openEMS silently ignores an unknown
        engine, so the engine actually used is read back from the log and recorded.
        ``exact`` (default True): evaluate the end criterion every Nyquist period instead of every
        ~4 s of wall time, so the stopping point (and therefore S11 depth / efficiency of high-Q
        structures) does not depend on machine speed.
        ``openems_kw`` are passed to ``openEMS.Run``.
        """
        if engine not in ("cpu", "gpu"):
            raise ValueError("engine must be 'cpu' or 'gpu'")
        # refuse meshes that would exhaust memory (about 90 bytes per cell in the CPU engine)
        cells = int(np.prod([max(len(self.mesh.GetLines(a)) - 1, 1) for a in "xyz"]))
        limit = int(float(os.environ.get("FAIRBEAM_MAX_CELLS", 40e6)))
        if cells > limit:
            raise ValueError(f"mesh has {cells / 1e6:.1f} M cells (about {cells * 90 / 2**30:.1f} GiB), over the "
                             f"{limit / 1e6:g} M limit: coarsen the mesh or lower f_max "
                             "(set FAIRBEAM_MAX_CELLS to raise the limit)")
        # Admission is refreshed at the actual solver boundary, using the built
        # mesh, not a client's optional preview count. Queued runs, sweeps and
        # optimization evaluations all reach this point after they build.
        from . import resources
        resource_check = resources.preflight(cells, engine, resources.free_memory_bytes())
        if resource_check["level"] == "refuse":
            raise ValueError(resource_check["messages"][0])
        if resource_check["level"] == "warn":
            print("fairbeam: resource check: " + "; ".join(resource_check["messages"]), file=sys.stderr)
        if engine == "gpu":
            openems_kw["engine"] = "gpu"
        openems_kw.setdefault("exact_endcriteria", True if exact is None else bool(exact))
        # openEMS chdirs into sim_path and does not change back; keep relative paths working
        sim_path = os.path.abspath(sim_path)
        os.makedirs(sim_path, exist_ok=True)
        self.sim_path = sim_path
        t0 = time.time()
        cwd = os.getcwd()
        try:
            with _capture_output(echo) as log:
                try:
                    self.fdtd.Run(sim_path, cleanup=True, numThreads=threads, verbose=0, **openems_kw)
                except RuntimeError as e:
                    # builds without --exact-endcriteria (e.g. the GPU fork, which evaluates the
                    # energy on the device at a fine cadence anyway): retry without it
                    if "exact-endcriteria" not in str(e) or not openems_kw.pop("exact_endcriteria", False):
                        raise
                    self.fdtd.Run(sim_path, cleanup=True, numThreads=threads, verbose=0, **openems_kw)
        finally:
            os.chdir(cwd)
        text = b"".join(log).decode(errors="replace")
        if _aborted(text):
            # openEMS caught Ctrl+C (SIGINT; on Windows also CTRL_BREAK, which is how the run server
            # cancels a job) and stopped early: the fields are not converged, so nothing may be
            # post-processed or exported as if they were
            raise KeyboardInterrupt("openEMS run aborted by Ctrl+C / Ctrl+Break")
        stats = _parse_log(text, self.end_criteria_db, self.max_timesteps)
        if stats.get("timestep_s") and self.excitation["type"] == "gaussian-derivative":
            # openEMS reports a custom excitation as max-timesteps long; the pulse itself is shorter.
            # A run cannot converge before it has ended (lib/run.ts names this cause).
            stats["excitation_timesteps"] = int(round(dgauss_duration_s(self.f_max) / stats["timestep_s"]))
        used = "gpu" if "enabled GPU engine" in text else "cpu"
        stats.update({"wall_time_s": round(time.time() - t0, 2), "threads": threads,
                      "engine": used, "engine_requested": engine,
                      "resource_preflight": resource_check,
                      "exact_endcriteria": bool(openems_kw.get("exact_endcriteria")),
                      "host": {"os": platform.system(), "machine": platform.machine(),
                               "cpu": _cpu_name()}})
        if engine == "gpu" and used != "gpu":
            stats["engine_warning"] = ("this openEMS build has no GPU engine; the run used the CPU "
                                       "(see scripts/install-openems-gpu-macos.sh)")
            print(f"fairbeam: warning: {stats['engine_warning']}", file=sys.stderr, flush=True)
        if self.dispersions and stats.get("timestep_s") and not openems_kw.get("setup_only"):
            from .dispersion import resolution_problems

            problems = [f"{name}: {msg}" for name, disp in self.dispersions.items()
                        for msg in resolution_problems(disp, stats["timestep_s"])]
            if problems:
                stats["dispersion_problems"] = problems
                for msg in problems:
                    print(f"fairbeam: warning: dispersive material {msg}", file=sys.stderr, flush=True)
        self.run_stats = stats
        return stats

    # ------------------------------------------------------------------ post-processing

    def evaluate(self, n_freq: int = 801, pattern_freqs=None, theta_step: float = 3.0,
                 phi_step: float = 5.0, s11_band_db: float = -10.0, efficiency_points: int | None = None) -> dict:
        """Port quantities, bands and far field of the finished run. ``efficiency_points``
        (default ``self.efficiency_points``) adds ``efficiency``: Prad / Pacc at that many
        frequencies across the band (:meth:`_band_efficiency`)."""
        if self.sim_path is None:
            raise RuntimeError("run() first")
        f = np.linspace(self.f_min, self.f_max, n_freq)
        out = {"frequency": f.tolist(), "ports": {}, "bands": [], "farfield": [], "signals": {}}

        port = None
        for p_meta, p in zip(self.ports, self._port_objs):
            p.CalcPort(self.sim_path, f)
            factor = self._calibrate_waveguide_port(p_meta, p)
            s11 = p.uf_ref / p.uf_inc
            zin = p.uf_tot / p.if_tot
            p_acc = 0.5 * np.real(p.uf_tot * np.conj(p.if_tot))
            out["ports"][str(p_meta["number"])] = {
                "s11_re": _r(s11.real), "s11_im": _r(s11.imag),
                "zin_re": _r(zin.real, 3), "zin_im": _r(zin.imag, 3), "z_ref": _zref_scalar(p.Z_ref, f),
                **({"z_ref_f": _r(np.real(p.Z_ref), 3)} if np.ndim(p.Z_ref) else {}),
                **({"probe_power_factor": round(factor, 4)} if factor is not None else {}),
            }
            if "reference_impedance" in p_meta:
                ref = p_meta["reference_impedance"]
                zr = complex(ref["real"], ref["imag"])
                gamma = (zin - np.conj(zr)) / (zin + zr)
                out["ports"][str(p_meta["number"])]["power_wave_reference"] = {
                    **ref, "convention": "Kurokawa", "gamma_re": _r(gamma.real),
                    "gamma_im": _r(gamma.imag), "power_transfer": _r(1 - np.abs(gamma) ** 2),
                }
            if p_meta["excite"]:
                port = (p_meta, p, s11, p_acc)
                # time signals need a scalar reference impedance (lumped ports); waveguide ports have none
                out["signals"] = _time_signals(p) if not np.ndim(p.Z_ref) else {}

        if port is None:
            self.results = out
            return out
        p_meta, p, s11, p_acc = port
        s11_db = 20 * np.log10(np.abs(s11))
        out["bands"] = _bands(f, s11_db, s11_band_db)

        if self.nf2ff is not None:
            if pattern_freqs is None:
                pattern_freqs = self.pattern_freqs
            if pattern_freqs is None:
                pattern_freqs = [b["f_center"] for b in out["bands"]][:4] or [float(f[np.argmin(s11_db)])]
            pattern_freqs = [float(v) for v in pattern_freqs]
            theta = np.arange(0.0, 180.0 + 1e-9, theta_step)
            phi = np.arange(0.0, 360.0, phi_step)
            center = np.array(self.nf2ff_center if self.nf2ff_center is not None else _center(self))
            res = self.nf2ff.CalcNF2FF(self.sim_path, pattern_freqs, theta, phi, center=center * self.unit)
            # kept for the embedded element patterns of multi-port runs (fairbeam.multiport)
            self._nf2ff = {"res": res, "freqs": pattern_freqs, "theta": theta, "phi": phi}
            # With PEC/PMC boundaries openEMS mirrors the recording surface, so Prad (and the Dmax
            # derived from it) cover the full image space. Undo that for the physical half space.
            mirrors = mirror_planes(self.boundaries)
            mirror_factor = 2.0 ** mirrors
            lossless = self._is_lossless()
            for i, fp in enumerate(pattern_freqs):
                e = np.asarray(res.E_norm[i])
                d_max = float(res.Dmax[i]) * mirror_factor
                with np.errstate(divide="ignore"):
                    d_dbi = 20 * np.log10(e / e.max()) + 10 * np.log10(d_max)
                d_dbi = np.maximum(d_dbi, 10 * np.log10(d_max) - 60)
                prad = float(res.Prad[i]) / mirror_factor
                pacc = float(np.interp(fp, f, p_acc))
                gamma2 = float(np.interp(fp, f, np.abs(s11) ** 2))
                raw = prad / pacc if pacc > 0 else None
                eff, note = self._lossless_efficiency(raw, fp, p_meta.get("type"), lossless)
                entry = {"f": fp, "theta": _r(theta, 2), "phi": _r(phi, 2),
                         "directivity_dbi": [_r(row, 2) for row in d_dbi],
                         "dmax_dbi": round(10 * np.log10(d_max), 3), "prad_w": prad, "pacc_w": pacc,
                         "rad_efficiency": None if eff is None else round(eff, 4),
                         "mirror_planes": mirrors}
                if lossless:
                    entry["rad_efficiency_raw"] = None if raw is None else round(raw, 4)
                d_pat = _pattern_directivity(e, theta, phi, mirror_factor)
                if d_pat is not None:
                    entry["dmax_pattern_dbi"] = round(10 * np.log10(d_pat), 3)
                if self.cp_outputs:
                    entry["cp"] = _circular(res, i, d_dbi, theta, phi)
                if eff is not None and eff > 0:
                    entry["gain_dbi"] = round(10 * np.log10(eff * d_max), 3)
                    entry["realized_gain_dbi"] = round(10 * np.log10(eff * d_max * (1 - gamma2)), 3)
                if (w := note or _efficiency_warning(eff, fp, p_meta.get("type"))) is not None:
                    entry["qa_warnings"] = [w]
                    print(f"fairbeam: {'note' if note and eff == 1.0 else 'warning'}: {w}", file=sys.stderr, flush=True)
                out["farfield"].append(entry)
            n_eff = self.efficiency_points if efficiency_points is None else efficiency_points
            if n_eff:
                out["efficiency"] = [self._band_efficiency(int(n_eff), f, p_acc, center, mirrors,
                                                           p_meta.get("type"), port=p, lossless=lossless)]
        self.results = out
        return out

    def _calibrate_waveguide_port(self, p_meta: dict, p) -> float | None:
        """Scale a rectangular waveguide port's voltage and current so that ``1/2 Re(U I*)`` is the
        mode power on this mesh (:mod:`fairbeam.wgport`: openEMS' mode-matching probes read the
        power low by an amount set by the wall-adjacent cells, 4 % at 20 cells/lambda and 8 % at 30
        on the pyramidal horn's WR-90 feed). Returns the power factor applied, or None (lumped
        port, disabled, or a probe box that is not a closed guide of the stated size). S-parameters
        are ratios of these quantities and do not change."""
        if p_meta.get("type") != "waveguide" or not self.wg_probe_correction:
            return None
        if any(k not in p_meta for k in ("a", "b", "mode", "direction", "start", "stop")):
            return None   # not a port made by waveguide_port(): nothing to describe the probe box
        ny ="xyz".index(p_meta["direction"])
        ax = ((ny + 1) % 3, (ny + 2) % 3)
        lo = np.minimum(p_meta["start"], p_meta["stop"])
        hi = np.maximum(p_meta["start"], p_meta["stop"])
        try:
            c = probe_power_factor(self.mesh.GetLines(ax[0]), self.mesh.GetLines(ax[1]),
                                   (lo[ax[0]], lo[ax[1]]), (hi[ax[0]], hi[ax[1]]),
                                   p_meta["a"], p_meta["b"], p_meta["mode"],
                                   inset_cells=getattr(p, "_fairbeam_probe_inset_cells", 0))
        except ValueError as e:
            print(f"fairbeam: note: waveguide port {p_meta['number']}: power calibration skipped ({e})",
                  file=sys.stderr, flush=True)
            return None
        if not WG_PROBE_FACTOR_RANGE[0] <= c <= WG_PROBE_FACTOR_RANGE[1]:
            print(f"fairbeam: note: waveguide port {p_meta['number']}: power calibration factor {c:.3f} is "
                  "outside the plausible range; not applied (is the probe box the guide cross-section?)",
                  file=sys.stderr, flush=True)
            return None
        s = np.sqrt(c)
        for name in ("uf_tot", "if_tot", "uf_inc", "if_inc", "uf_ref", "if_ref"):
            setattr(p, name, getattr(p, name) * s)
        for name in ("P_inc", "P_ref", "P_acc"):
            if hasattr(p, name):
                setattr(p, name, getattr(p, name) * c)
        return float(c)

    def _is_lossless(self) -> bool:
        """Whether the model opted in to ``lossless`` and has no loss mechanism: every dielectric
        without loss, every metal a perfect conductor, no resistor. An opt-in the model does not
        live up to is ignored, with a warning."""
        if not self.lossless:
            return False
        lossy = [n for n, m in self.materials.items()
                 if (m.get("kind") == "dielectric" and m.get("tan_d")) or m.get("conductivity") is not None]
        lossy += [e["name"] for e in self.lumped_elements if "R" in e]   # L/C alone are lossless
        for prop in self.csx.GetAllProperties():
            if prop.GetTypeString() == "Material" and prop.GetName() not in self.materials:
                if float(np.max(np.atleast_1d(prop.GetMaterialProperty("kappa")))) > 0:
                    lossy.append(prop.GetName())
        if lossy:
            print(f"fairbeam: warning: the model is marked lossless but {', '.join(sorted(set(lossy)))} "
                  "has loss: its radiation efficiency is reported as measured", file=sys.stderr, flush=True)
            return False
        return True

    @staticmethod
    def _lossless_efficiency(raw, f, port_type, lossless: bool):
        """(reported efficiency, QA note) for a measured Prad / Pacc ``raw``. A lossless model
        (:meth:`_is_lossless`) radiates everything it accepts, so its radiation efficiency is 1 and
        ``raw`` only measures how well the two numerical powers agree: within
        ``LOSSLESS_TOLERANCE`` the efficiency is reported as 1 with that power balance in the note,
        beyond it as measured with a warning (something is wrong beyond the usual discretisation
        error). Any other model reports ``raw`` (the > 100 % warning is added by the caller)."""
        if not lossless or raw is None:
            return raw, None
        dev = raw - 1.0
        if abs(dev) <= LOSSLESS_TOLERANCE:
            return 1.0, (f"lossless model (PEC and loss-free materials only): radiation efficiency 100 % at "
                         f"{f / 1e9:.3f} GHz by construction, gain = directivity. The measured power balance "
                         f"Prad / Pacc is {raw * 100:.1f} % ({dev * 100:+.1f} %, within the "
                         f"{LOSSLESS_TOLERANCE * 100:.0f} % tolerance): the numerical disagreement of the "
                         "NF2FF box and the port (rad_efficiency_raw)")
        return raw, (f"lossless model, but the measured power balance Prad / Pacc is {raw * 100:.1f} % at "
                     f"{f / 1e9:.3f} GHz ({dev * 100:+.1f} %), beyond the {LOSSLESS_TOLERANCE * 100:.0f} % "
                     "tolerance: the efficiency is reported as measured. Check the mesh at the "
                     + ("waveguide port" if port_type == "waveguide" else "port")
                     + " and around the NF2FF box")

    def _band_efficiency(self, n: int, f, p_acc, center, mirrors: int, port_type=None, port=None,
                         lossless: bool = False) -> dict:
        """Radiation efficiency at ``n`` frequencies from f_min to f_max (bundle ``efficiency``).

        The NF2FF box records time-domain dumps, so the transform works at any frequency after the
        run. openEMS' Prad is the Poynting flux through the box surface (nf2ff_calc.cpp), which
        does not depend on the angular grid: on the patch example Prad came out bit-identical from
        3°/5° down to 90°/180°, and the transform of 21 frequencies took 2.3 s on the 3°/5° grid,
        0.9 s on 5°/10° and 0.27 s on 90°/180° (the floor: reading and transforming the dumps).
        So the grid (``EFFICIENCY_THETA_STEP`` / ``EFFICIENCY_PHI_STEP``) is the coarsest that
        spans the sphere: θ 0, 90, 180 and φ 0, 180. Its own ``outfile`` leaves the
        pattern's ``nf2ff.h5`` alone. Prad is mirror-corrected as for the pattern; Pacc is the
        port's accepted power interpolated at each frequency.

        Reliability (``pacc_error``, ``reliable``): away from the match the port reflects almost all
        of the incident power, and Pacc = Pinc (1 - |S11|²) is a small difference of two large
        numbers. Stopping the run at the end criterion truncates the ring-down, which leaves an
        error of about the same absolute size at every frequency, so there the ratio is ill-
        conditioned: the patch starter's efficiency zig-zagged from 15 to 85 % at -50 dB and was
        smooth at -60 and -70 dB, with Prad within a few % in all three (docs/BUNDLE.md#efficiency).
        :meth:`_pacc_error` estimates that error; above ``EFFICIENCY_MAX_ERROR`` the value is kept
        but marked unreliable."""
        t0 = time.time()
        fe = np.linspace(self.f_min, self.f_max, n)
        theta = np.arange(0.0, 180.0 + 1e-9, EFFICIENCY_THETA_STEP)
        phi = np.arange(0.0, 360.0, EFFICIENCY_PHI_STEP)
        res = self.nf2ff.CalcNF2FF(self.sim_path, fe.tolist(), theta, phi, center=center * self.unit,
                                   outfile=EFFICIENCY_OUTFILE)
        prad = np.asarray(res.Prad, dtype=float) / 2.0 ** mirrors
        pacc = np.interp(fe, f, p_acc)
        eff = [round(float(pr / pa), 4) if pa > 0 else None for pr, pa in zip(prad, pacc)]
        entry = {"f": fe.tolist(), "prad_w": prad.tolist(), "pacc_w": pacc.tolist(),
                 "rad_efficiency": eff, "mirror_planes": mirrors,
                 "theta_step": EFFICIENCY_THETA_STEP, "phi_step": EFFICIENCY_PHI_STEP}
        warnings = []
        err = self._pacc_error(port, fe) if port is not None else None
        if err is not None:
            ok = [bool(e is not None and pa > 0 and v <= EFFICIENCY_MAX_ERROR)
                  for e, pa, v in zip(eff, pacc, err)]
            entry["pacc_error"] = [round(float(v), 4) if np.isfinite(v) else None for v in err]
            entry["reliable"] = ok
            gamma = np.interp(fe, f, np.abs(port.uf_ref / port.uf_inc) ** 2)
            if (w := _unreliable_warning(fe, ok, 1 - gamma, self.end_criteria_db)) is not None:
                warnings.append(w)
        else:
            ok = [True] * n
        if lossless:
            # as for the pattern frequencies (_lossless_efficiency): 1 within the tolerance
            rep = [self._lossless_efficiency(e, fk, port_type, True) for e, fk in zip(eff, fe)]
            entry["rad_efficiency_raw"] = eff
            entry["rad_efficiency"] = eff = [None if e is None else round(e, 4) for e, _ in rep]
            outside = [fk for (e, note), fk in zip(rep, fe) if note and e != 1.0]
            if outside:
                warnings.append(f"efficiency over the band: lossless model, but at {len(outside)} of {n} "
                                f"frequencies the power balance Prad / Pacc is more than "
                                f"{LOSSLESS_TOLERANCE * 100:.0f} % from 1: reported as measured there")
        elif (w := _band_efficiency_warning(fe, [e if k else None for e, k in zip(eff, ok)], port_type)) is not None:
            warnings.append(w)
        if warnings:
            entry["qa_warnings"] = warnings
            for w in warnings:
                print(f"fairbeam: warning: {w}", file=sys.stderr, flush=True)
        dt = round(time.time() - t0, 2)
        if self.run_stats is not None:
            self.run_stats["efficiency_time_s"] = dt
        print(f"fairbeam: note: radiation efficiency at {n} frequencies in {dt} s (post-processing)", flush=True)
        return entry

    def _pacc_error(self, port, fe) -> np.ndarray | None:
        """Estimated relative error of the accepted power at ``fe`` from stopping the run: the change
        of ½ Re(U I*) when the last ``EFFICIENCY_TAIL`` of the ring-down (after the excitation pulse)
        is left out of the DFT. While the signals decay, what the run did not record is of the order
        of that stretch or smaller, so this errs on the safe side (patch starter, 11 frequencies:
        estimated 2-51 % at -50 dB against 0.4-24 % actual, 0.2-20 % at -60 dB against 0.1-7 %, the
        actual taken against a -70 dB run). The error of Prad from the same truncation was smaller
        (a few %) and is not included. None when the port has no time signals."""
        try:
            tu, u = np.asarray(port.u_time, float), np.asarray(port.ut_tot, float)
            ti, i = np.asarray(port.i_time, float), np.asarray(port.it_tot, float)
        except (AttributeError, TypeError, ValueError):
            return None
        if tu.size < 4 or ti.size < 4 or tu.shape != u.shape or ti.shape != i.shape:
            return None
        pulse = dgauss_duration_s(self.f_max) if self.excitation["type"] == "gaussian-derivative" else 0.0

        def dft(t, v, cut):
            # the single-sided DFT of openEMS.utilities.DFT_time2freq, over t >= cut only
            m = t >= cut
            return 2 * (t[1] - t[0]) * (np.exp(-2j * np.pi * np.outer(fe, t[m])) @ v[m])

        t_end = max(tu[-1], ti[-1])
        cut = t_end - EFFICIENCY_TAIL * max(t_end - pulse, 0.0)
        uf, i_f = dft(tu, u, -np.inf), dft(ti, i, -np.inf)
        du, di = dft(tu, u, cut), dft(ti, i, cut)
        full = 0.5 * np.real(uf * np.conj(i_f))
        short = 0.5 * np.real((uf - du) * np.conj(i_f - di))
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.where(full > 0, np.abs(full - short) / full, np.inf)

    # ------------------------------------------------------------------ export

    def to_bundle(self, model: dict, params: list[dict], name: str | None = None) -> dict:
        from ._meta import BUNDLE_SCHEMA, __version__
        from .geometry import read_structure
        import CSXCAD
        import openEMS as _openems

        parts, _helpers, nf2ff_box = read_structure(self.csx, self.materials, self.unit)
        _show_drawn_thickness(parts, self.thin_sheets)
        lines = {a: np.asarray(self.mesh.GetLines(a)) for a in "xyz"}
        cells = [int(len(lines[a]) - 1) for a in "xyz"]
        widths = np.concatenate([np.diff(lines[a]) for a in "xyz"])
        half_space = None
        if self.boundaries[4] == "PEC":
            half_space = {"axis": "z", "side": "min", "position": float(lines["z"][0]), "kind": "PEC"}

        return {
            "schema": BUNDLE_SCHEMA,
            "generator": {"name": "fairbeam", "version": __version__,
                          "openems": getattr(_openems, "__version__", None),
                          "csxcad": getattr(CSXCAD, "__version__", None),
                          "python": platform.python_version()},
            "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "name": name or model.get("name"),
            "model": {**model, "params": params},
            "units": {"length": "mm" if abs(self.unit - 1e-3) < 1e-12 else f"{self.unit} m",
                      "length_m": self.unit, "frequency": "Hz"},
            "solver": {"engine": "openEMS", "method": "FDTD (Yee, staircase)",
                       "excitation": self.excitation,
                       "boundaries": dict(zip(BOUNDARY_NAMES, self.boundaries)),
                       "end_criteria_db": self.end_criteria_db, "max_timesteps": self.max_timesteps},
            "parts": parts,
            "ports": self.ports,
            "half_space": half_space,
            "mesh": {"x": _r(lines["x"], 4), "y": _r(lines["y"], 4), "z": _r(lines["z"], 4),
                     "cells": cells, "total_cells": int(np.prod(cells)),
                     "min_cell": round(float(widths.min()), 5), "max_cell": round(float(widths.max()), 5),
                     **({"auto": getattr(self, "mesh_report")} if getattr(self, "mesh_report", None) else {})},
            "domain": {"min": [float(lines[a][0]) for a in "xyz"], "max": [float(lines[a][-1]) for a in "xyz"]},
            "nf2ff_box": ({**nf2ff_box, "faces": self.nf2ff_faces}
                          if nf2ff_box and getattr(self, "nf2ff_faces", None) else nf2ff_box),
            "nf2ff_center": [float(v) for v in (self.nf2ff_center if self.nf2ff_center is not None
                                                 else _center(self))] if self.nf2ff is not None else None,
            "focus": self.focus,
            **({"lumped_elements": self.lumped_elements} if self.lumped_elements else {}),
            "run": self.run_stats,
            "results": self.results,
        }


# Sheet thickness of a lossy metal drawn with zero thickness (1 oz copper), in mm
SHEET_THICKNESS_MM = 0.035


class LossyMetal:
    """A metal of finite conductivity, used like a CSXCAD property (``AddBox``, ``AddPolygon``, ...).

    openEMS has no single property for it: a conducting sheet (``AddConductingSheet``, a surface
    impedance model of a thin conductor of the given conductivity and thickness) works on 2D
    primitives only and falls back to PEC on anything else, and a volume needs a material with
    that conductivity (``kappa``). So each primitive goes to the property its shape needs: sheets
    (a box flat in one direction, a polygon) to a conducting sheet of ``thickness``, or of
    ``drawn_thickness`` when it is set (a thin brick built as a sheet keeps its drawn thickness; an
    extrusion thinner than ``sheet_limit`` becomes a sheet of its length), volumes to a material,
    and wires and lines to a perfect conductor (a conducting sheet cannot
    hold them). The first property takes ``name``; any further one ``name`` plus a suffix, so a
    part with sheets and volumes shows as several parts in the bundle, each with its ``conductor``.

    A volume's loss is only right where the mesh resolves the skin depth (about 1.3 µm for copper
    at 2.45 GHz), which an antenna mesh never does; there the volume behaves almost like PEC.
    Printed copper is best drawn as sheets (the default thin-metal build does that)."""

    def __init__(self, sim: Simulation, name: str, conductivity: float, thickness: float | None = None,
                 label: str | None = None, color: str | None = None):
        if not (np.isfinite(conductivity) and conductivity > 0):
            raise ValueError(f"metal {name!r}: the conductivity must be > 0 S/m (got {conductivity:g})")
        t = SHEET_THICKNESS_MM if thickness is None else float(thickness)
        if not (np.isfinite(t) and t > 0):
            raise ValueError(f"metal {name!r}: the sheet thickness must be > 0 (got {t:g})")
        self.sim, self.name, self.conductivity, self.thickness = sim, name, float(conductivity), t
        self.label, self.color = label, color
        self.drawn_thickness: float | None = None
        #: extrusions (AddLinPoly) thinner than this (drawing units) become sheets; None: none do
        self.sheet_limit: float | None = None
        self.props: dict[tuple, object] = {}

    def _prop(self, key: tuple):
        if key not in self.props:
            suffix = f"sheet_{key[1]:g}".replace(".", "p") if key[0] == "sheet" else {"volume": "volume", "pec": "wire"}[key[0]]
            name = self.name if not self.props else f"{self.name}__{suffix}"
            sim = self.sim
            meta = {"label": self.label, "color": self.color, "kind": "metal"}
            if key[0] == "sheet":
                sim._record(name, **meta, conductivity=self.conductivity, thickness=key[1])
                prop = sim.csx.AddConductingSheet(name, conductivity=self.conductivity, thickness=key[1] * sim.unit)
            elif key[0] == "volume":
                sim._record(name, **meta, conductivity=self.conductivity)
                prop = sim.csx.AddMaterial(name, epsilon=1.0, kappa=self.conductivity)
            else:
                sim._record(name, **meta)
                prop = sim.csx.AddMetal(name)
            self.props[key] = prop
        return self.props[key]

    def _sheet(self):
        t = self.drawn_thickness if self.drawn_thickness else self.thickness
        return self._prop(("sheet", float(t)))

    def AddBox(self, start=None, stop=None, **kw):
        flat = sum(abs(float(a) - float(b)) < 1e-12 for a, b in zip(start, stop))
        prop = self._sheet() if flat == 1 else self._prop(("volume",) if flat == 0 else ("pec",))
        return prop.AddBox(start=start, stop=stop, **kw)

    def AddPolygon(self, *a, **kw):
        return self._sheet().AddPolygon(*a, **kw)

    def AddLinPoly(self, points, norm_dir, elevation, length, **kw):
        # an extruded outline thinner than ``sheet_limit`` (printed copper imported from CST as a
        # 35 µm extrusion) is a sheet in its base plane with that thickness, as design.thin_sheets
        # makes of a thin brick: a volume that thin would only average the conductivity into its cell
        t = abs(float(length))
        if self.sheet_limit and 0 < t < self.sheet_limit:
            return self._prop(("sheet", t)).AddPolygon(points, norm_dir, elevation, **kw)
        return self._prop(("volume",)).AddLinPoly(points, norm_dir, elevation, length, **kw)

    def AddWire(self, points, radius=0.0, **kw):
        from .design import add_wire
        return add_wire(self, points, radius, **kw)

    def AddCurve(self, *a, **kw):
        return self._prop(("pec",)).AddCurve(*a, **kw)

    def __getattr__(self, attr):
        # every other primitive (LinPoly, Cylinder, CylindricalShell, Sphere, RotPoly, Polyhedron)
        # is a volume
        if attr.startswith("Add"):
            return getattr(self._prop(("volume",)), attr)
        raise AttributeError(attr)


# ---------------------------------------------------------------------- helpers

def _circular(res, i, d_dbi, theta, phi) -> dict:
    """Circular-polarisation split of the far field (IEEE, e^{jwt}): E_R = (E_theta + j E_phi)/sqrt 2,
    E_L = (E_theta - j E_phi)/sqrt 2 (openEMS' E_cprh / E_cplh up to a phase). The partial
    directivities are D * |E_R|^2 / |E|^2 and D * |E_L|^2 / |E|^2; the axial ratio is
    (|E_R| + |E_L|) / | |E_R| - |E_L| | (0 dB = circular, large = linear)."""
    et, ep = np.asarray(res.E_theta[i]), np.asarray(res.E_phi[i])
    er, el = np.abs(et + 1j * ep) / np.sqrt(2), np.abs(et - 1j * ep) / np.sqrt(2)
    tot = er ** 2 + el ** 2
    with np.errstate(divide="ignore", invalid="ignore"):
        d_lin = 10 ** (np.asarray(d_dbi) / 10)
        dr = 10 * np.log10(np.maximum(d_lin * er ** 2 / tot, 1e-12))
        dl = 10 * np.log10(np.maximum(d_lin * el ** 2 / tot, 1e-12))
        ar = 20 * np.log10(np.minimum((er + el) / np.maximum(np.abs(er - el), 1e-30), 1e6))
    floor = float(np.max(d_dbi)) - 60
    k = np.unravel_index(int(np.argmax(d_dbi)), np.shape(d_dbi))
    return {
        "rhcp_dbi": [_r(row, 2) for row in np.maximum(dr, floor)],
        "lhcp_dbi": [_r(row, 2) for row in np.maximum(dl, floor)],
        "axial_ratio_db": [_r(row, 2) for row in np.minimum(ar, 60)],
        "peak": {"theta": float(theta[k[0]]), "phi": float(phi[k[1]]), "rhcp_dbi": round(float(dr[k]), 3),
                 "lhcp_dbi": round(float(dl[k]), 3), "axial_ratio_db": round(float(min(ar[k], 60)), 3)},
        "boresight": {"theta": 0.0, "rhcp_dbi": round(float(dr[0, 0]), 3), "lhcp_dbi": round(float(dl[0, 0]), 3),
                      "axial_ratio_db": round(float(min(ar[0, 0], 60)), 3)},
    }


def _zref_scalar(z_ref, f) -> float:
    """A port's reference impedance as one number: the value itself (lumped ports) or the
    frequency-dependent TE wave impedance at the band centre (waveguide ports)."""
    if np.ndim(z_ref) == 0:
        return float(z_ref)
    z = np.real(np.asarray(z_ref))
    return round(float(np.interp((f[0] + f[-1]) / 2, f, z)), 3)


def _r(a, nd=5):
    return np.round(np.asarray(a, dtype=float), nd).tolist()


def mirror_planes(boundaries) -> int:
    """Image planes the NF2FF applies: one per axis with a PEC/PMC face (openEMS keeps a single
    mirror per axis, so PEC on both faces of an axis still mirrors once). Accepts names or the
    integer codes 0 (PEC) / 1 (PMC)."""
    def mirrored(b):
        return str(b).upper() in ("PEC", "PMC", "0", "1")
    return sum(any(mirrored(boundaries[2 * a + s]) for s in (0, 1)) for a in range(3))


def _pattern_directivity(e_norm, theta_deg, phi_deg, mirror_factor=1.0):
    """Maximum directivity from the pattern alone: 4 pi U_max / (integral of U over the sphere).

    openEMS' own Dmax divides by the power flowing through the NF2FF box; this estimate integrates
    the transformed far field instead. The two agree when the near-field data are
    clean; a gap of more than ~0.1 dB points at boundary reflections or a coarse NF2FF surface.
    Needs a full sphere: theta 0..180 and a uniform phi grid over 360 degrees; otherwise ``None``.
    ``mirror_factor`` (2^m) converts the image-space integral to the physical half/quarter space.
    """
    th, ph = np.deg2rad(np.asarray(theta_deg, float)), np.asarray(phi_deg, float)
    if len(th) < 3 or len(ph) < 2 or abs(th[0]) > 1e-9 or abs(th[-1] - np.pi) > 1e-9:
        return None
    dphi = np.diff(ph)
    if not np.allclose(dphi, dphi[0]) or abs(len(ph) * dphi[0] - 360.0) > 1e-6:
        return None
    u = np.asarray(e_norm, float) ** 2
    integral = np.trapezoid(u.mean(axis=1) * np.sin(th), th) * 2 * np.pi
    return float(4 * np.pi * u.max() / integral * mirror_factor) if integral > 0 else None


def _center(sim: Simulation):
    if sim.focus:
        return (np.array(sim.focus["min"]) + np.array(sim.focus["max"])) / 2
    return np.zeros(3)


def _bands(f, s11_db, threshold):
    below = s11_db < threshold
    bands, i = [], 0
    while i < len(f):
        if below[i]:
            j = i
            while j + 1 < len(f) and below[j + 1]:
                j += 1
            k = i + int(np.argmin(s11_db[i:j + 1]))
            bands.append({"f_lo": float(f[i]), "f_hi": float(f[j]), "f_center": float(f[k]),
                          "s11_min_db": round(float(s11_db[k]), 3),
                          "fractional_bw": round(float((f[j] - f[i]) / f[k]), 5),
                          "edge_lo": bool(i == 0), "edge_hi": bool(j == len(f) - 1)})
            i = j + 1
        else:
            i += 1
    return bands


class GroupedLumpedPort:
    """One selected mode of N resistive feeds, compatible with evaluate/multiport.

    Parallel: U = mean(s*U_i), I = sum(s*I_i), R_i = N*R.
    Series: U = sum(s*U_i), I = mean(s*I_i), R_i = R/N.
    This projects one mode; orthogonal member modes are not included in its power.
    """

    def __init__(self, record, members):
        import copy
        self.number, self.Z_ref = record["number"], record["R"]
        self.definition = copy.deepcopy(record)
        self.members = tuple(members)
        self.port_props = [prop for p in members for prop in p.port_props]
        self._signs = np.array([1] + [p["polarity"] for p in record["group"]["members"]])
        count = len(members)
        parallel = record["group"]["connection"] == "parallel"
        self._u_weights = self._signs / count if parallel else self._signs
        self._i_weights = self._signs if parallel else self._signs / count

    def CalcPort(self, sim_path, frequency):
        for member in self.members:
            member.CalcPort(sim_path, frequency)
        for name in ("u_time", "i_time"):
            first = np.asarray(getattr(self.members[0], name))
            if any(not np.array_equal(first, getattr(p, name)) for p in self.members[1:]):
                raise ValueError(f"grouped port {self.number}: members need identical {name} grids")
            setattr(self, name, first)
        for name, weights in (("uf_tot", self._u_weights), ("if_tot", self._i_weights),
                              ("ut_tot", self._u_weights), ("it_tot", self._i_weights)):
            setattr(self, name, np.sum([w * np.asarray(getattr(p, name)) for w, p in zip(weights, self.members)], axis=0))
        z = self.Z_ref
        self.uf_inc = (self.uf_tot + z * self.if_tot) / 2
        self.uf_ref = (self.uf_tot - z * self.if_tot) / 2
        self.if_inc, self.if_ref = self.uf_inc / z, self.uf_ref / z
        # Yee voltage/current samples are staggered. Align them before forming time waves.
        current_at_u = np.interp(self.u_time, self.i_time, self.it_tot)
        voltage_at_i = np.interp(self.i_time, self.u_time, self.ut_tot)
        self.ut_inc, self.ut_ref = (self.ut_tot + z * current_at_u) / 2, (self.ut_tot - z * current_at_u) / 2
        self.it_inc, self.it_ref = (self.it_tot + voltage_at_i / z) / 2, (voltage_at_i / z - self.it_tot) / 2
        self.P_inc = .5 * np.real(self.uf_inc * np.conj(self.if_inc))
        self.P_ref = .5 * np.real(self.uf_ref * np.conj(self.if_ref))
        self.P_acc = .5 * np.real(self.uf_tot * np.conj(self.if_tot))


def _time_signals(p, max_points=1500):
    t = np.asarray(p.u_time)
    step = max(1, int(np.ceil(len(t) / max_points)))
    z = float(p.Z_ref)
    current = (np.interp(t, p.i_time, p.it_tot) if isinstance(p, GroupedLumpedPort)
               else np.asarray(p.it_tot))
    return {
        "time_ns": _r(t[::step] * 1e9, 5),
        "u_inc": _r(np.asarray(p.ut_inc)[::step], 6),
        "u_ref": _r(np.asarray(p.ut_ref)[::step], 6),
        "u_tot": _r(np.asarray(p.ut_tot)[::step], 6),
        "i_tot_scaled": _r(current[::step] * z, 6),
        "dt_s": float(t[1] - t[0]) if len(t) > 1 else None,
        "samples": int(len(t)),
    }


@contextmanager
def _capture_output(echo: bool):
    """Capture C++ stdout/stderr of openEMS (file descriptors 1 and 2) while optionally echoing."""
    sys.stdout.flush()
    sys.stderr.flush()
    saved_out, saved_err = os.dup(1), os.dup(2)
    r, w = os.pipe()
    os.dup2(w, 1)
    os.dup2(w, 2)
    os.close(w)
    chunks: list[bytes] = []

    def pump():
        with os.fdopen(r, "rb", buffering=0) as src:
            while True:
                data = src.read(8192)
                if not data:
                    break
                chunks.append(data)
                if echo:
                    os.write(saved_out, data)

    th = threading.Thread(target=pump, daemon=True)
    th.start()
    try:
        yield chunks
    finally:
        if _libc is not None:
            _libc.fflush(None)
        sys.stdout.flush()
        sys.stderr.flush()
        os.dup2(saved_out, 1)
        os.dup2(saved_err, 2)
        # restoring 1 and 2 closed the pipe's write end: let the pump drain it (and echo the
        # rest through saved_out) before closing saved_out, or its last write fails with EBADF
        # and the tail of openEMS' output runs into the next line (e.g. multi-port "run k/n")
        th.join(timeout=5)
        os.close(saved_out)
        os.close(saved_err)


_RE = {
    "size": re.compile(r"FDTD simulation size: (\d+)x(\d+)x(\d+)"),
    "time": re.compile(r"Time for (\d+) iterations with ([\d.e+]+) cells : ([\d.]+) sec"),
    "speed": re.compile(r"Speed: ([\d.]+) MCells/s"),
    "energy": re.compile(r"Timestep:\s+(\d+).*?Energy: ~\s*([\d.e+-]+) \(-\s*([\d.]+)dB\)"),
    "nyquist": re.compile(r"Nyquist rate: (\d+) timesteps @([\d.e+]+) Hz"),
    "dt": re.compile(r"FDTD timestep is: ([\d.e+-]+) s"),
}


_ABORT_RE = re.compile(r"aborting simulation gracefully|Gracefully aborting simulation", re.I)


def _show_drawn_thickness(parts: list[dict], sheets: list[dict]):
    """Give the sheets built from thin metal bricks their drawn thickness back in the bundle, so the
    viewer and the CST export show the copper as drawn, and mark them ``"sheet": {axis, at,
    thickness}`` (what the solver saw). One pass over the primitives: an 8 x 8 array's sheets are
    found by their coordinates, not by a search per sheet."""
    key = lambda part, a, b: (part, *(round(float(v), 4) for v in (*a, *b)))  # noqa: E731
    todo: dict[tuple, list[dict]] = {}
    for sh in sheets:
        if sh.get("start") is None:
            continue   # a flattened extruded outline (polygon): drawn flat, there is no brick to restore
        todo.setdefault(key(sh["part"], sh["start"], sh["stop"]), []).append(sh)
    for entry in parts:
        touched = False
        for p in entry["primitives"]:
            if p.get("kind") != "box" or "sheet" in p:
                continue
            waiting = todo.get(key(entry["name"], p["start"], p["stop"]))
            if not waiting:
                continue
            sh = waiting.pop()
            n, (lo, hi) = sh["axis"], sh["drawn"]
            a, b = list(p["start"]), list(p["stop"])
            a[n], b[n] = lo[n], hi[n]
            p.update(start=_r(a, 6), stop=_r(b, 6),
                     bbox=[_r(np.minimum(a, b), 6), _r(np.maximum(a, b), 6)],
                     sheet={"axis": "xyz"[n], "at": round(float(sh["at"]), 6),
                            "thickness": round(float(sh["thickness"]), 6)})
            touched = True
        if touched:
            bb = np.array([p["bbox"] for p in entry["primitives"]])
            entry["bbox"] = [_r(bb[:, 0].min(axis=0), 6), _r(bb[:, 1].max(axis=0), 6)]


def _aborted(text: str) -> bool:
    """True when openEMS' own interrupt handler ended the run early. It prints
    ``openEMS::CheckAbortCond(): Received SIGINT, aborting simulation gracefully...`` (and, on
    Windows, ``Signal::Win32GracefulExitHandler(): Gracefully aborting simulation now``), then
    returns from Run normally, as if the end criterion had been met."""
    return bool(_ABORT_RE.search(text))


def _parse_log(text: str, end_db: float, max_timesteps: int | None = None) -> dict:
    """Run statistics from openEMS' captured output.

    Convergence is decided from the timestep count, not from the log text: a run can only stop
    before ``max_timesteps`` through the energy end criterion. openEMS prints the "Max. number of
    timesteps was reached" warning only for its own Gaussian excitation (not for the custom
    Gaussian-derivative pulse), and prints "Energy:" lines only every ~4 s of wall time, so a fast
    run may have none. Then the final energy is only known to be at most the criterion
    (``final_energy_bound_db``). The same holds when the last energy line predates the stop (the
    GPU engine logs every few thousand timesteps): a converged run stopped *because* the energy
    reached the criterion, so that older, higher sample is not the final energy.
    """
    s: dict = {"log_tail": text.strip().splitlines()[-12:]}
    if m := _RE["size"].search(text):
        s["grid"] = [int(m.group(i)) for i in (1, 2, 3)]
    if m := _RE["time"].search(text):
        s["timesteps"] = int(m.group(1))
        s["solver_time_s"] = float(m.group(3))
    if m := _RE["speed"].search(text):
        s["speed_mcells_s"] = float(m.group(1))
    if m := _RE["dt"].search(text):
        s["timestep_s"] = float(m.group(1))
    energy = [(int(a), -float(c)) for a, _b, c in _RE["energy"].findall(text)]
    s["energy_trace"] = [{"timestep": a, "db": b} for a, b in energy]
    ts = s.get("timesteps")
    limit_text = "Max. number of timesteps was reached" in text
    if max_timesteps is not None and ts is not None:
        s["hit_timestep_limit"] = bool(limit_text or ts >= max_timesteps)
        s["converged"] = not s["hit_timestep_limit"]
    else:  # limit unknown: fall back to the log text
        s["hit_timestep_limit"] = limit_text
        s["converged"] = bool(ts is not None and not limit_text and (not energy or energy[-1][1] <= end_db))
    stale = bool(energy) and ts is not None and energy[-1][0] < ts and energy[-1][1] > end_db
    if energy and not (stale and s["converged"]):
        s["final_energy_db"] = energy[-1][1]
    elif s["converged"]:
        s["final_energy_bound_db"] = float(end_db)
    return s


def _efficiency_warning(eff, f, port_type=None):
    """QA note for a radiation efficiency above 100 % (None otherwise).

    Prad (Poynting flux through the NF2FF box) and Pacc (0.5 Re(U I*) at the port's probes, the
    same as openEMS' ``Port.P_acc`` = P_inc - P_ref) are two independent numerical measurements; for
    a passive antenna Prad <= Pacc. Above 100 % one of them is off by at least the excess, and the
    gain (eff * Dmax) exceeds Dmax by the same factor. The values are kept as computed, flagged."""
    if eff is None or eff <= 1.0:
        return None
    where = ("the waveguide port's mode-matched U and I probes (mesh too coarse across the guide, "
             "or the probe plane too close to the excitation)" if port_type == "waveguide"
             else "the port's U and I probes (mesh too coarse at the feed)")
    return (f"radiation efficiency {eff * 100:.1f} % at {f / 1e9:.3f} GHz exceeds 100 %: the power "
            f"radiated through the NF2FF box is {(eff - 1) * 100:.1f} % above the port's accepted "
            f"power, so gain and realized gain are overestimated by {10 * np.log10(eff):.2f} dB. "
            f"Refine the mesh at {where}, or move the NF2FF box further from the PML")


def _band_efficiency_warning(f, eff, port_type=None):
    """One QA note for all frequencies of the efficiency sweep above 100 % (None if there are none);
    the reasons and remedies are those of :func:`_efficiency_warning`."""
    over = [(fk, e) for fk, e in zip(f, eff) if e is not None and e > 1.0]
    if not over:
        return None
    f_worst, worst = max(over, key=lambda x: x[1])
    note = _efficiency_warning(worst, f_worst, port_type)
    span = (f"at {over[0][0] / 1e9:.3f} GHz" if len(over) == 1
            else f"between {over[0][0] / 1e9:.3f} and {over[-1][0] / 1e9:.3f} GHz")
    return (f"efficiency over the band: {len(over)} of {len(eff)} frequencies {span} exceed 100 %; "
            f"worst: {note}")


def _unreliable_warning(f, reliable, accepted, end_db):
    """One QA note for the frequencies of the efficiency sweep marked unreliable (None if none):
    where the port accepts little of the incident power the ratio Prad / Pacc is ill-conditioned
    (:meth:`Simulation._band_efficiency`)."""
    bad = [k for k, ok in enumerate(reliable) if not ok]
    if not bad:
        return None
    acc = [max(float(accepted[k]), 0.0) * 100 for k in bad]
    span = ("at " + ", ".join(f"{f[k] / 1e9:.3f}" for k in bad) + " GHz" if len(bad) <= 4
            else f"between {f[bad[0]] / 1e9:.3f} and {f[bad[-1]] / 1e9:.3f} GHz")
    lo, hi = min(acc), max(acc)
    share = f"{lo:.1f} %" if abs(hi - lo) < 0.05 else f"{lo:.1f}-{hi:.1f} %"
    return (f"efficiency over the band: {len(bad)} of {len(reliable)} frequencies {span} are unreliable: "
            f"the port accepts only {share} of the incident power there, and the run stopped "
            f"({end_db:g} dB) before the ring-down was small against that, so the accepted power is "
            f"uncertain by more than {EFFICIENCY_MAX_ERROR * 100:.0f} %. The values are kept and marked; "
            f"a lower end criterion ({end_db - 10:g} dB) makes more of the band reliable")


def _cpu_name():
    try:
        if platform.system() == "Darwin":
            import subprocess
            return subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True,
                                  text=True, timeout=2).stdout.strip() or platform.processor()
        if platform.system() == "Windows":  # platform.processor() is only "Intel64 Family 6 ..."
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
                return str(winreg.QueryValueEx(k, "ProcessorNameString")[0]).strip() or platform.processor()
        if platform.system() == "Linux":
            with open("/proc/cpuinfo", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if line.startswith("model name"):
                        return line.split(":", 1)[1].strip()
    except Exception:
        pass
    return platform.processor() or None
