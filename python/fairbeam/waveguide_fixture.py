"""Rectangular-waveguide material fixture: a sample filling the cross-section of an a x b guide,
fed by TE10 ports at both ends (issue #275), the simulated counterpart of the usual X-band
(WR-90) transmission/reflection measurement.

Layout along z (drawing units)::

    PML | port 1 (excitation, probe = reference plane 1) | L1 | sample [front, back] | L2 | port 2 | PML

The guide walls are the PEC domain boundaries in x and y; both ends run into PML, as in
python/examples/waveguide_thru.py. The ports are ``Simulation.waveguide_port`` (openEMS
RectWGPort with the fairbeam.wgport power calibration); their reference planes are the probe
planes. Port 1 is driven and port 2 terminated, which gives S11 and S21.

:func:`run_fixture` runs the fixture with the sample and an empty copy (:meth:`WaveguideFixture.
reference`: same mesh, same ports) at one timestep: each run's own step is read from an openEMS
setup (``setup_only``), both run at the smaller one, and the steps are compared afterwards (from
the port probes' time axis), so the numerical dispersion of the two runs is the same. The empty run gives the guide's numerical
propagation constant beta0, measured between the two reference planes; it refers the sample run
to the sample faces (:func:`deembed`) and is the beta0 of the guided NRW / NIST inversion
(fairbeam.nrw with kc = pi / a). The analytic beta0 = sqrt(k0^2 - (pi/a)^2) is reported only as a
comparison.

Cut-offs (:func:`cutoffs`): the empty guide's TE10 (c / 2a), TE20 (c / a) and TE01 (c / 2b); the
band must start above TE10 (an error otherwise), and a warning is given when it reaches the next
mode of the empty guide. The
filled section's cut-offs (divided by sqrt(eps_r mu_r)) are only reported: a homogeneous sample
that fills the cross-section does not couple TE10 to TE20 or TE01.

Excitation: use the band-limited Gaussian (``Simulation(..., excitation="gauss")``). The default
Gaussian-derivative pulse reaches down to DC, and between the filled section's TE10 cut-off and
the empty guide's its energy propagates in the sample but not in the air beside it: it stays
trapped and the run does not reach the end criterion (the fixture warns).

Air gap: ``gap_x`` / ``gap_y`` leave a gap between the sample and the narrow / broad walls (the
sample over :meth:`WaveguideFixture.sample_span`). The extracted eps_r is then the apparent one;
:func:`gap_correction` corrects it (transverse resonance by default, after NIST TN 1355-R), written next to it, and
:func:`gap_modes` the higher modes such a gap excites, which must decay before the reference planes.

The result is written by ``fairbeam material-cell`` like the plane-wave cell's (``"setup":
"waveguide"``); S-parameters are referred to the empty guide's TE10 wave impedance.
"""

from __future__ import annotations

import time

import numpy as np
from openEMS.physical_constants import C0
from openEMS.physical_constants import Z0 as ETA0

from .material_cell import GRADING, PML_CELLS, PML_MARGIN_CELLS, _outward

#: WR-90 inner size (mm), the default guide
WR90 = (22.86, 10.16)
#: cells between a port's excitation plane and its probe (reference) plane
PORT_PROBE_CELLS = 2
#: port 1's voltage probe (openEMS' port_<ut|it>_<n> files): its time axis gives the step a run used
PORT_PROBE_FILE = "port_ut_1"
#: x-, x+, y-, y+, z-, z+
FIXTURE_BOUNDARIES = ("PEC", "PEC", "PEC", "PEC", "PML_8", "PML_8")
#: cells across an air gap between the sample and a wall, at least
GAP_MIN_CELLS = 2
#: the higher modes an air gap excites must decay by at least this (dB, at f_max) between a sample
#: face and its reference plane; the fixture moves the reference planes out when they would not
HIGHER_MODE_DECAY_DB = 40.0


def cutoffs(a: float, b: float, unit: float = 1e-3, eps_mu: float = 1.0) -> dict:
    """TE10, TE20 and TE01 cut-off frequencies (Hz) of an a x b guide filled with eps_r mu_r = ``eps_mu``."""
    s = np.sqrt(eps_mu)
    return {"TE10": float(C0 / (2 * a * unit * s)), "TE20": float(C0 / (a * unit * s)),
            "TE01": float(C0 / (2 * b * unit * s))}


def band_warnings(f_min: float, f_max: float, empty: dict) -> list[str]:
    """Warnings for a band that reaches the empty guide's next mode; a band starting at or below
    its TE10 cut-off is an error (the ports do not propagate there)."""
    if f_min <= empty["TE10"]:
        raise ValueError(f"f_min {f_min / 1e9:.4g} GHz is at or below the empty guide's TE10 cut-off "
                         f"{empty['TE10'] / 1e9:.4g} GHz: start the band above it")
    out = []
    upper = min(empty["TE20"], empty["TE01"])
    if f_max >= upper:
        mode = "TE20" if empty["TE20"] <= empty["TE01"] else "TE01"
        out.append(f"f_max {f_max / 1e9:.4g} GHz reaches the empty guide's {mode} cut-off {upper / 1e9:.4g} GHz: "
                   "the guide is no longer single-mode there")
    return out


def gap_modes(a: float, b: float, gap_x: float, gap_y: float, unit: float = 1e-3) -> list[dict]:
    """The modes a symmetric air gap couples TE10 to, with their empty-guide cut-offs (Hz).

    TE10's E_y is even about both centre planes of the guide, and so is a sample with equal gaps
    on opposite sides, so only modes of the same parity are excited: m odd and n even. Gaps at the
    narrow walls alone (the sample still spans the full height) give TE30, TE50, ...; gaps at the
    broad walls alone give TE12 / TM12, TE14 / TM14, ...; both, also TE32 / TM32, .... The lowest
    of each kind is returned (the others decay faster)."""
    out = []

    def fc(m, n):
        return float(C0 / 2 * np.hypot(m / (a * unit), n / (b * unit)))

    if gap_x > 0:
        out.append({"mode": "TE30", "f_cutoff": fc(3, 0)})
    if gap_y > 0:
        out += [{"mode": "TE12", "f_cutoff": fc(1, 2)}, {"mode": "TM12", "f_cutoff": fc(1, 2)}]
    if gap_x > 0 and gap_y > 0:
        out += [{"mode": "TE32", "f_cutoff": fc(3, 2)}, {"mode": "TM32", "f_cutoff": fc(3, 2)}]
    return out


def mode_decay_db(f: float, f_cutoff: float, distance: float, unit: float = 1e-3) -> float:
    """How far (dB) an evanescent mode of cut-off ``f_cutoff`` decays over ``distance`` at ``f``
    (0 when it propagates)."""
    if f >= f_cutoff:
        return 0.0
    alpha = 2 * np.pi / C0 * np.sqrt(f_cutoff ** 2 - f ** 2)
    return float(20 * np.log10(np.e) * alpha * distance * unit)


#: models of :func:`gap_correction`
GAP_MODELS = ("resonance", "capacitor")
#: Newton iterations / relative tolerance of the transverse-resonance gap correction
GAP_NEWTON_ITER = 50
GAP_NEWTON_TOL = 1e-12


def gap_correction(eps_apparent, gap_x: float, gap_y: float, a: float, b: float, f=None, *,
                   model: str = "resonance", unit: float = 1e-3):
    """Air-gap correction of a permittivity measured in an a x b guide (TE10) on a sample with a
    gap ``gap_x`` to each narrow wall and ``gap_y`` to each broad wall (same units as a and b;
    ``unit`` in metres). Complex in and out (e^{+j w t}), so the loss tangent is corrected too;
    ``f`` (Hz, one per value) is needed by the default model.

    The apparent eps is the one a full sample would need for the measured propagation constant,
    beta^2 = k0^2 eps_apparent - (pi / a)^2. Formulas written out here from the models of NIST
    Technical Note 1355-R (Baker-Jarvis et al., 1993), Appendix C:

    - Broad walls, ``model="resonance"`` (C.1.1, eqs. C.1-C.4, transverse resonance): with equal
      gaps the centre plane y = 0 is a plane of symmetry, so the half guide above it holds a
      sample of height d = b/2 - gap_y and a gap of gap_y. The transverse wavenumbers are
      k1 = k0 sqrt(eps - eps_column) in the sample and j kappa, kappa = k0 sqrt(eps_column - 1), in
      the gap (evanescent across it); the transverse-resonance condition, multiplied out so that
      it has no poles, is k1 sin(k1 d) - eps kappa tanh(kappa gap_y) cos(k1 d) = 0. It is solved for the sample's
      eps at each frequency by complex Newton, from the capacitor value. Both sides are even in
      k1 and in kappa, so the square roots' branches do not matter; the root taken is the
      fundamental one (|k1 d| < pi / 2), which the capacitor start lies next to.
    - Broad walls, ``model="capacitor"`` (C.2.2, eqs. C.23-C.24, written there for a total gap
      b - d): the sample and the two gaps as capacitors in series, b / eps_column = (b - 2 gap_y)
      / eps + 2 gap_y. It is the low-frequency limit of the resonance model and, being
      frequency-independent (quasi-static), over-corrects as the gap and the frequency grow.
    - Narrow walls (both models; not in TN 1355-R, derived here): the gaps and the sample lie
      side by side along E, weighted by TE10's field energy sin^2(pi x / a). The two gaps carry
      w = 2 gap_x / a - sin(2 pi gap_x / a) / pi of it (about (4/3) pi^2 (gap_x/a)^3 for a thin
      gap), and eps_apparent = w + (1 - w) eps_column; first order in the gap.

    The narrow-wall step is undone first, then the broad-wall one."""
    if model not in GAP_MODELS:
        raise ValueError(f"model must be one of {GAP_MODELS}, not {model!r}")
    eps = np.asarray(eps_apparent, complex)
    w = 2 * gap_x / a - np.sin(2 * np.pi * gap_x / a) / np.pi
    column = (eps - w) / (1 - w)
    if gap_y <= 0:
        return column
    capacitor = (b - 2 * gap_y) / (b / column - 2 * gap_y)
    if model == "capacitor":
        return capacitor
    if f is None:
        raise ValueError("the resonance gap correction needs the frequencies f (Hz); or use model='capacitor'")
    f = np.broadcast_to(np.asarray(f, float), column.shape)
    out = np.empty(column.shape, complex)
    for i in np.ndindex(column.shape):
        out[i] = _eplane_resonance(complex(column[i]), complex(capacitor[i]), float(f[i]), gap_y * unit, b * unit)
    return out


def _eplane_residual(eps_s, eps_o, k0: float, d: float, g: float):
    """The transverse resonance of the half guide (TN 1355-R eq. C.1, multiplied out): zero when
    a sample of ``eps_s`` (height d) with an air gap g to the wall is observed as ``eps_o``."""
    k1 = k0 * np.sqrt(eps_s - eps_o + 0j)
    kappa = k0 * np.sqrt(eps_o - 1 + 0j)
    return k1 * np.sin(k1 * d) - eps_s * kappa * np.tanh(kappa * g) * np.cos(k1 * d)


def _eplane_resonance(eps_o: complex, start: complex, f: float, g: float, b: float) -> complex:
    """The sample eps observed as ``eps_o`` with a gap g (m) to each broad wall of a guide of
    height b (m), at f: Newton on :func:`_eplane_residual` from ``start``. NaN when it does not
    converge to the fundamental root."""
    if not (np.isfinite(eps_o) and np.isfinite(start) and f > 0):
        return complex(np.nan, np.nan)
    k0, d = 2 * np.pi * f / C0, b / 2 - g
    e = start
    for _ in range(GAP_NEWTON_ITER):
        r = _eplane_residual(e, eps_o, k0, d, g)
        h = 1e-7 * max(abs(e), 1.0)
        step = -r / ((_eplane_residual(e + h, eps_o, k0, d, g) - r) / h)   # holomorphic in eps_s
        e += step
        if abs(step) < GAP_NEWTON_TOL * max(abs(e), 1.0):
            k1d = k0 * np.sqrt(e - eps_o + 0j) * d
            return e if abs(k1d) < np.pi / 2 else complex(np.nan, np.nan)
    return complex(np.nan, np.nan)


def _transverse_lines(width: float, gap: float, cell: float, n_min: int) -> np.ndarray:
    """Mesh lines across a guide side of ``width``, centred on 0. Without an air gap: uniform at
    ``cell`` (at least ``n_min`` cells). With a ``gap`` to each wall: at least GAP_MIN_CELLS cells
    across the gap, then cells growing by at most GRADING up to ``cell``, uniform across the
    middle; the sample's edges (+-(width / 2 - gap)) are lines."""
    if gap <= 0:
        return np.linspace(-width / 2, width / 2, max(int(np.ceil(width / cell - 1e-9)), n_min) + 1)
    n_gap = max(GAP_MIN_CELLS, int(np.ceil(gap / cell - 1e-9)))
    side = list(-width / 2 + gap * np.arange(n_gap + 1) / n_gap)
    step = gap / n_gap
    while step < cell and side[-1] + 2 * min(step * GRADING, cell) < 0:
        step = min(step * GRADING, cell)
        side.append(side[-1] + step)
    def middle_cells():
        # the uniform middle's cells: at most ``cell`` and at most GRADING times the last graded one
        span = -2 * side[-1]
        return max(int(np.ceil(span / cell - 1e-9)), int(np.ceil(span / ((side[-1] - side[-2]) * GRADING) - 1e-9)), 1)

    # ... and not smaller than the last graded one by more than GRADING either
    while len(side) > n_gap + 1 and (side[-1] - side[-2]) / (-2 * side[-1] / middle_cells()) > GRADING + 1e-9:
        side.pop()
    n_mid = middle_cells()
    middle = np.linspace(side[-1], -side[-1], n_mid + 1)
    side = np.asarray(side)
    return np.concatenate([side, middle[1:-1], -side[::-1]])


class WaveguideFixture:
    """The fixture around a sample between ``front`` and ``back`` (z, drawing units) in an
    ``a`` (x, broad wall) by ``b`` (y) guide centred on x = y = 0.

    Sets the PEC/PML boundaries on ``sim``, writes the whole mesh (z: uniform inside the sample at
    ``cells_per_wavelength`` cells per free-space wavelength at f_max in the densest material,
    ``eps_max * mu_max``, graded to the air cells outside; x and y uniform at the air resolution,
    graded around an air gap)
    and adds the two TE10 ports ``gap`` (default: the larger of a and a quarter wavelength at
    f_max) from the sample faces. Add the sample with the usual calls over :meth:`sample_span`.
    ``eps_max`` / ``mu_max`` also give the filled section's reported cut-offs.

    ``gap_x`` and ``gap_y`` (default 0: the sample fills the guide) are air gaps between the
    sample and each narrow wall (x) and each broad wall (y), the same on both sides. The mesh puts
    at least GAP_MIN_CELLS cells across each gap, graded to the air resolution. A gap makes the
    cross-section inhomogeneous and excites higher modes (:func:`gap_modes`); if those would not
    decay by HIGHER_MODE_DECAY_DB at f_max before the reference planes, the planes are moved out
    (with a warning). Not to be confused with ``gap``, the distance from a sample face to its
    reference plane.
    """

    def __init__(self, sim, front: float, back: float, a: float = WR90[0], b: float = WR90[1], *,
                 eps_max: float = 1.0, mu_max: float = 1.0, cells_per_wavelength: float = 20, gap: float | None = None,
                 gap_x: float = 0.0, gap_y: float = 0.0):
        if not (a > 0 and b > 0):
            raise ValueError("the guide a x b must be positive")
        if not back > front:
            raise ValueError(f"the sample's back face ({back:g}) must lie behind its front face ({front:g})")
        if eps_max < 1 or mu_max < 1:
            raise ValueError("eps_max and mu_max are at least 1 (vacuum)")
        if not (0 <= gap_x < a / 2 and 0 <= gap_y < b / 2):
            raise ValueError(f"the air gaps must satisfy 0 <= gap_x < a/2 and 0 <= gap_y < b/2 (got {gap_x:g}, {gap_y:g})")
        self.sim = sim
        self.a, self.b = float(a), float(b)
        self.gap_x, self.gap_y = float(gap_x), float(gap_y)
        self.front, self.back = float(front), float(back)
        self.eps_mu = float(eps_max * mu_max)
        self.empty_cutoffs = cutoffs(self.a, self.b, sim.unit)
        self.filled_cutoffs = cutoffs(self.a, self.b, sim.unit, self.eps_mu)
        self.warnings = band_warnings(sim.f_min, sim.f_max, self.empty_cutoffs)
        if sim.excitation["type"] == "gaussian-derivative" and self.eps_mu > 1:
            self.warnings.append(
                "the Gaussian-derivative pulse reaches down to DC: between the filled section's TE10 cut-off "
                f"({self.filled_cutoffs['TE10'] / 1e9:.4g} GHz) and the empty guide's "
                f"({self.empty_cutoffs['TE10'] / 1e9:.4g} GHz) its energy is trapped in the sample, so the run "
                "may not reach the end criterion; use Simulation(..., excitation=\"gauss\")")
        sim.boundaries = list(FIXTURE_BOUNDARIES)
        sim.fdtd.SetBoundaryCond(sim.boundaries)

        air = C0 / sim.f_max / sim.unit / float(cells_per_wavelength)
        dense = air / np.sqrt(self.eps_mu)
        self.gap = float(gap if gap is not None else max(self.a, C0 / sim.f_max / sim.unit / 4))
        self.higher_modes = gap_modes(self.a, self.b, self.gap_x, self.gap_y, sim.unit)
        if self.higher_modes:
            slowest = min(self.higher_modes, key=lambda m: m["f_cutoff"])
            per_mm = mode_decay_db(sim.f_max, slowest["f_cutoff"], 1.0, sim.unit)
            needed = HIGHER_MODE_DECAY_DB / per_mm if per_mm > 0 else float("inf")
            if not np.isfinite(needed):
                raise ValueError(f"{slowest['mode']} (cut-off {slowest['f_cutoff'] / 1e9:.4g} GHz), which the air gap "
                                 f"excites, propagates at f_max {sim.f_max / 1e9:.4g} GHz in the empty guide")
            if needed > self.gap:
                self.warnings.append(
                    f"reference planes moved from {self.gap:.4g} to {needed:.4g} from the sample faces, so that "
                    f"{slowest['mode']}, which the air gap excites, decays by {HIGHER_MODE_DECAY_DB:g} dB at f_max")
                self.gap = float(needed)
            for m in self.higher_modes:
                m["decay_db"] = mode_decay_db(sim.f_max, m["f_cutoff"], self.gap, sim.unit)
        n_in = max(int(np.ceil((self.back - self.front) / dense - 1e-9)), 1)
        z_in = np.linspace(self.front, self.back, n_in + 1)
        first = float(np.diff(z_in).min())
        # outward from each face: graded air cells to the probe plane (the gap), then the port's
        # probe-to-excitation cells, the margin and the PML
        extra = PORT_PROBE_CELLS + PML_MARGIN_CELLS + PML_CELLS
        off1, k1 = _outward(first, air, self.gap, extra)
        off2, k2 = _outward(first, air, self.gap, extra)
        z = np.concatenate([self.front - off1[::-1], z_in, self.back + off2])
        self.z_ref1 = float(self.front - off1[k1])
        self.z_ref2 = float(self.back + off2[k2])
        z_exc1 = float(self.front - off1[k1 + PORT_PROBE_CELLS])
        z_exc2 = float(self.back + off2[k2 + PORT_PROBE_CELLS])
        sim.mesh.AddLine("x", _transverse_lines(self.a, self.gap_x, air, 4))
        sim.mesh.AddLine("y", _transverse_lines(self.b, self.gap_y, air, 2))
        sim.mesh.AddLine("z", z)
        self._planes = (z_exc1, self.z_ref1, z_exc2, self.z_ref2)
        self._attach(sim)
        sim.waveguide_fixture = self

    @property
    def kc(self) -> float:
        """The TE10 cut-off wavenumber pi / a (rad/m)."""
        return float(np.pi / (self.a * self.sim.unit))

    def span(self, z0: float, z1: float):
        """``start, stop`` of a box over the whole guide cross-section from z0 to z1."""
        return [-self.a / 2, -self.b / 2, z0], [self.a / 2, self.b / 2, z1]

    def sample_span(self, z0: float, z1: float):
        """``start, stop`` of the sample's box from z0 to z1: the cross-section less the air gaps
        (the whole cross-section without them)."""
        hx, hy = self.a / 2 - self.gap_x, self.b / 2 - self.gap_y
        return [-hx, -hy, z0], [hx, hy, z1]

    def _attach(self, sim):
        z_exc1, z_ref1, z_exc2, z_ref2 = self._planes
        lo, hi = [-self.a / 2, -self.b / 2], [self.a / 2, self.b / 2]
        sim.waveguide_port(1, lo + [z_exc1], hi + [z_ref1], "z", self.a, self.b, "TE10", excite=True)
        sim.waveguide_port(2, lo + [z_exc2], hi + [z_ref2], "z", self.a, self.b, "TE10", excite=False)

    def reference(self):
        """The empty guide: a new Simulation with this fixture's band, excitation, end criterion,
        boundaries, mesh and ports, and no sample."""
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
        """The fixture geometry and cut-offs for the result file (drawing units, Hz)."""
        return {"setup": "waveguide", "mode": "TE10", "a": self.a, "b": self.b, "front": self.front,
                "back": self.back, "gap": self.gap, "z_ref1": self.z_ref1, "z_ref2": self.z_ref2,
                "port_planes": {"excitation": [self._planes[0], self._planes[2]],
                                "reference": [self.z_ref1, self.z_ref2]},
                "cutoffs_empty": self.empty_cutoffs,
                "cutoffs_filled": {**self.filled_cutoffs, "eps_r_mu_r": self.eps_mu},
                "air_gap": {"gap_x": self.gap_x, "gap_y": self.gap_y, "higher_modes": self.higher_modes},
                "boundaries": dict(zip(("x-", "x+", "y-", "y+", "z-", "z+"), self.sim.boundaries)),
                "warnings": list(self.warnings)}


# ---------------------------------------------------------------------------- post-processing

def two_port_s(sim) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """``(f, S11, S21)`` of an evaluated fixture run (port 1 driven): b1 / a1 and b2 / a1 with the
    power waves of the two (calibrated) TE10 ports, a = uf_inc / sqrt(Z_ref), b = uf_ref / sqrt(Z_ref)."""
    f = np.asarray(sim.results["frequency"], float)
    waves = []
    for p in sim._port_objs:
        zr = np.sqrt(np.real(np.asarray(p.Z_ref, complex)))
        waves.append((np.asarray(p.uf_inc) / zr, np.asarray(p.uf_ref) / zr))
    (a1, b1), (_, b2) = waves[0], waves[1]
    return f, b1 / a1, b2 / a1


def measured_beta(f, s21_empty, length: float, kc: float, unit: float = 1e-3) -> np.ndarray:
    """The empty guide's numerical propagation constant (rad/m) from S21 between the reference
    planes, ``length`` apart: beta = -phase / L, unwrapped over the band, with the 2 pi multiple
    that brings it nearest to the analytic sqrt(k0^2 - kc^2) at the lowest frequency."""
    f = np.asarray(f, float)
    L = length * unit
    phase = np.unwrap(np.angle(np.asarray(s21_empty, complex)))
    turns = np.round((phase[0] + analytic_beta(f, kc)[0] * L) / (2 * np.pi))
    return -(phase - 2 * np.pi * turns) / L


def analytic_beta(f, kc: float) -> np.ndarray:
    k0 = 2 * np.pi * np.asarray(f, float) / C0
    return np.sqrt(np.maximum(k0 ** 2 - kc ** 2, 0.0))


def deembed(f, s11, s21, s21_empty, beta0, l1: float, d: float, unit: float = 1e-3) -> dict:
    """S11 and S21 of the sample referred to its faces from the sample run (``s11``, ``s21`` at the
    reference planes) and the empty run (``s21_empty``), with the empty guide's ``beta0``.

    With the reference plane 1 ``l1`` in front of the sample and the sample ``d`` thick::

        S11 = S11_planes exp(+2 j beta0 l1)
        S21 = S21_planes / S21_empty exp(-j beta0 d)

    The empty run's S21 holds the air sections and both ports exactly as in the sample run, so
    the ratio leaves the sample's transmission times the air it replaced."""
    b = np.asarray(beta0, float)
    s11f = np.asarray(s11, complex) * np.exp(2j * b * l1 * unit)
    s21f = np.asarray(s21, complex) / np.asarray(s21_empty, complex) * np.exp(-1j * b * d * unit)
    r2, t2 = np.abs(s11f) ** 2, np.abs(s21f) ** 2
    return {"f": np.asarray(f, float), "s11": s11f, "s21": s21f, "R2": r2, "T2": t2, "absorption": 1 - r2 - t2}


# ---------------------------------------------------------------------------- runner

def run_fixture(module, values: dict, sim, *, sim_path: str, threads=0, echo: bool = False, engine: str = "cpu",
                exact: bool = True, end_db: float | None = None, n_freq: int = 401, nist: bool = False,
                nrw_floor: float | None = None, log=print) -> dict:
    """Run the model's waveguide fixture (``sim``, built by ``module.build(values)``) and its empty
    reference, and return the result in the form of :func:`fairbeam.material_cell.run_cell`."""
    from .analytic import slab_s
    from .material_cell import compare, extract_material, run_at_one_timestep
    from .simdata import mark_running

    fx = sim.waveguide_fixture
    for w in fx.warnings:
        log(f"fairbeam: warning: {w}")
    ref = fx.reference()
    if end_db is not None:
        for s in (sim, ref):
            s.end_criteria_db = float(end_db)
            s.fdtd.SetEndCriteria(10 ** (end_db / 10))
    t0 = time.time()
    with mark_running(sim_path):
        # one step for both runs, so the numerical dispersion of their air sections is the same
        stats = run_at_one_timestep({"reference": ref, "sample": sim}, sim_path, PORT_PROBE_FILE, threads=threads,
                                    echo=echo, engine=engine, exact=exact, log=log)
        for s in (ref, sim):
            s.evaluate(n_freq=int(n_freq))
    f, s11, s21 = two_port_s(sim)
    _, s11_e, s21_e = two_port_s(ref)
    length = fx.z_ref2 - fx.z_ref1
    beta0 = measured_beta(f, s21_e, length, fx.kc, sim.unit)
    beta_a = analytic_beta(f, fx.kc)
    res = deembed(f, s11, s21, s21_e, beta0, fx.front - fx.z_ref1, fx.back - fx.front, sim.unit)
    k0 = 2 * np.pi * f / C0
    out = {"result": res, "cell": fx.describe(), "run_stats": stats, "setup": "waveguide",
           "wall_time_total_s": round(time.time() - t0, 2), "sim": sim,
           "z_ref": ETA0 * k0 / beta_a,
           "beta0":{"measured": beta0, "analytic": beta_a,
                     "max_rel_difference": float(np.max(np.abs(beta0 / beta_a - 1)))},
           "empty": {"s11": s11_e, "s21_planes": s21_e,
                     "s21_faces": s21_e * np.exp(1j * beta0 * length * sim.unit)}}
    layers_fn = getattr(module, "analytic_layers", None)
    layers = layers_fn(values) if layers_fn is not None else None
    if layers is not None:
        s_ref = slab_s(f, layers, unit=sim.unit, kc=fx.kc)
        method = "transfer matrix of the guided TE10 sections"
        if fx.gap_x or fx.gap_y:
            method += " (the sample filling the guide: the air gap is not in it)"
        out["analytic"] = {"s11": s_ref[:, 0, 0], "s21": s_ref[:, 1, 0], "deviation": compare(res, s_ref),
                           "method": method}
    try:
        out["material"] = extract_material(res, fx.back - fx.front, sim.unit, nist=nist,
                                           expected=layers[0] if layers and len(layers) == 1 else None,
                                           sin_floor=nrw_floor, kc=fx.kc, beta0=beta0)
    except ValueError as e:     # e.g. no reflection at all: S11 and S21 are still written
        log(f"fairbeam: note: no material parameters: {e}")
    if "material" in out and (fx.gap_x or fx.gap_y):
        out["material"]["gap_correction"] = correct_material(out["material"], fx, f)
    return out


def correct_material(m: dict, fx: WaveguideFixture, f) -> dict:
    """The air-gap corrected eps_r (:func:`gap_correction`) of an extracted material ``m``
    (fairbeam.material_cell.extract_material): for NRW and, when present, NIST; with the
    deviations from the expected material when that is known. The resonance model's values come
    first, the capacitor model's under ``capacitor`` for comparison. The extracted (apparent)
    values stay where they are."""
    from .nrw import compare_material

    narrow = "narrow walls: TE10-weighted parallel layers"

    def corrected(model):
        out = {}
        for method in ("nrw", "nist"):
            if method not in m:
                continue
            eps = gap_correction(m[method]["eps_r"], fx.gap_x, fx.gap_y, fx.a, fx.b, f, model=model,
                                 unit=fx.sim.unit)
            out[method] = {"eps_r": eps, "tan_d": -eps.imag / eps.real}
            if "expected" in m:
                mask = m["nrw"]["reliable"] if method == "nrw" else None
                out.setdefault("deviation", {})[method] = compare_material(f, out[method], m["expected"]["eps_r"],
                                                                           mask=mask)
        return out

    return {"gap_x": fx.gap_x, "gap_y": fx.gap_y,
            "model": f"resonance: broad walls by transverse resonance (TN 1355-R C.1), {narrow}",
            **corrected("resonance"),
            "capacitor": {"model": f"capacitor: broad walls as series layers (TN 1355-R C.23-C.24), {narrow}",
                          **corrected("capacitor")}}
