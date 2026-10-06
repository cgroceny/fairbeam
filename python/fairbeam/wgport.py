"""Power calibration of openEMS' rectangular waveguide port (mode-matching probes).

openEMS measures the voltage U and current I of a waveguide port by projecting the node-interpolated
E and H fields of the probe plane on the unit-norm mode templates
(``Common/processmodematch.cpp``). ``P = 1/2 Re(U I*)`` is the power of the mode only if each
template norm is the area of the guide cross-section. Where the guide is closed by metal walls that
does not hold on a real mesh:

* the E node on a wall line interpolates the air edge and the (zero) edge inside the metal, but its
  area weight includes the metal-side half cell, so the template norm counts area the field does
  not occupy (the E projection reads low);
* the H nodes are unweighted averages of the two duals around a node, which is one half of the air
  value on a wall line, and the H probe runs over one node less at the upper wall of each axis than
  the E probe, so half an air cell of the last row is missing (the I projection reads low).

Both errors are set by the size of the wall-adjacent cells relative to the guide, i.e. by the mesh,
not by the frequency (WR-90 horn: P_acc 4.2 % low at 20 cells/lambda, 8.3 % at 30, where the
automatic mesh puts 0.38 mm and 0.77 mm cells next to the broad walls; an exact Yee-lattice flux
through the guide, through the closed NF2FF box and through planes inside the horn agree to
0.1-0.4 %). The mode of a lossless straight guide is known, so the deficit is a pure function of
the mesh: :func:`probe_power_factor` runs the same projection on the ideal mode sampled on the
Yee lattice of the actual mesh and returns ``P_true / P_probe``. ``Simulation.evaluate`` multiplies
U and I by its square root (S-parameters are ratios, so they do not change; incident, reflected and
accepted power do).
"""

from __future__ import annotations

import numpy as np

from openEMS.physical_constants import C0, Z0
from openEMS.ports import Port, RectWGPort


class _FilledRectWGPort(RectWGPort):
    """Rectangular TE port referenced to an explicitly supplied homogeneous filling.

    The native mode profiles are unchanged. openEMS' RectWGPort uses the vacuum
    propagation constant and impedance in CalcPort; changing ref_index alone
    corrects beta but still leaves the medium's wave impedance incorrect.
    Only real, positive, frequency-independent eps_r and mu_r are supported.
    """

    def __init__(self, *args, eps_r: float, mu_r: float, **kwargs):
        super().__init__(*args, **kwargs)
        self.eps_r = eps_r
        self.mu_r = mu_r
        self.ref_index = np.sqrt(eps_r * mu_r)

    def CalcPort(self, sim_path, freq, ref_impedance=None, ref_plane_shift=None,
                 signal_type="pulse", ZL=-1):
        f = np.asarray(freq, dtype=float)
        beta_squared = (2 * np.pi * f / C0) ** 2 * self.eps_r * self.mu_r - self.kc ** 2
        if not np.all(np.isfinite(f)) or np.any(f <= 0) or not np.all(np.isfinite(beta_squared)) or np.any(beta_squared <= 0):
            raise ValueError("filled waveguide port frequencies must be finite and above the mode cutoff")
        self.beta = np.sqrt(beta_squared)
        self.ZL = (Z0 * self.mu_r * (2 * np.pi * f / C0) / self.beta) if ZL <= 0 else ZL
        # A plane shift uses the mode impedance, even when the caller requests
        # a different S-parameter reference. Renormalize only after the shift.
        self.Z_ref = self.ZL
        Port.CalcPort(self, sim_path, freq, None, ref_plane_shift, signal_type)
        if ref_impedance is not None:
            self.Z_ref = ref_impedance
            self.uf_inc = (self.uf_tot + self.Z_ref * self.if_tot) / 2
            self.if_inc = self.uf_inc / self.Z_ref
            self.uf_ref = self.uf_tot - self.uf_inc
            self.if_ref = self.uf_ref / self.Z_ref
            self.P_inc = .5 * np.real(self.uf_inc * np.conj(self.if_inc))
            self.P_ref = .5 * np.real(self.uf_ref * np.conj(self.if_ref))
            if isinstance(self.Z_ref, (int, float)):
                self.ut_inc = (self.ut_tot + self.Z_ref * self.it_tot) / 2
                self.it_inc = self.ut_inc / self.Z_ref
                self.ut_ref = self.ut_tot - self.ut_inc
                self.it_ref = self.ut_ref / self.Z_ref


def mode_functions(m: int, n: int, a: float, b: float):
    """(e_P, e_PP, h_P, h_PP) of openEMS' RectWGPort TE_mn template as functions of the coordinates
    (x along the broad wall a, y along b) measured from the guide's lower-left corner."""
    pi = np.pi

    def e_p(x, y):
        return (n / b) * np.cos(m * pi * x / a) * np.sin(n * pi * y / b) if n > 0 else np.zeros(np.broadcast(x, y).shape)

    def e_pp(x, y):
        return -(m / a) * np.sin(m * pi * x / a) * np.cos(n * pi * y / b) if m > 0 else np.zeros(np.broadcast(x, y).shape)

    def h_p(x, y):
        return (m / a) * np.sin(m * pi * x / a) * np.cos(n * pi * y / b) if m > 0 else np.zeros(np.broadcast(x, y).shape)

    def h_pp(x, y):
        return (n / b) * np.cos(m * pi * x / a) * np.sin(n * pi * y / b) if n > 0 else np.zeros(np.broadcast(x, y).shape)

    return e_p, e_pp, h_p, h_pp


def _nearest(lines: np.ndarray, v: float) -> int:
    return int(np.argmin(np.abs(np.asarray(lines, float) - v)))


def _dual_width(lines: np.ndarray) -> np.ndarray:
    """openEMS node width on the primary mesh: half the distance between the neighbouring lines."""
    w = np.empty(len(lines))
    w[1:-1] = 0.5 * (lines[2:] - lines[:-2])
    w[0] = lines[1] - lines[0]
    w[-1] = lines[-1] - lines[-2]
    return w


def _inset_range(lines, low, high, cells):
    if isinstance(cells, bool) or not isinstance(cells, (int, np.integer)) or cells < 1:
        raise ValueError("probe inset must be a positive integer number of cells")
    lines = np.asarray(lines, float)
    if lines.ndim != 1 or len(lines) < 2 or not np.all(np.isfinite(lines)) or np.any(np.diff(lines) <= 0):
        raise ValueError("probe inset requires finite, increasing mesh lines")
    i0, i1 = _nearest(lines, low), _nearest(lines, high)
    if not np.allclose([lines[i0], lines[i1]], [low, high], rtol=0, atol=1e-9 * max(high - low, 1)):
        raise ValueError("the guide walls must lie on mesh lines before insetting probes")
    if i1 - i0 - 2 * cells < 2:
        raise ValueError("the inset probe must retain at least two transverse cells")
    return i0 + int(cells), i1 - int(cells)


def inset_mode_probes(port, *, cells: int = 1):
    """Opt in to TE10 mode probes inset from both broad walls by ``cells`` mesh intervals.

    Call with the native port returned by ``Simulation.waveguide_port`` after finalizing the
    mesh, before running; call again if that mesh changes. The E/H probe boxes alone move along
    the port's b axis. Sources, mode origin, physical port corners and measurement plane stay
    unchanged. TE10 is uniform along b; other modes and cylindrical grids are not supported.
    All ports used in one S-matrix should use the same inset policy. Returns ``port``.

    This is the scoped shared-wall correction from #301: a full-width node-interpolated probe
    can include fields from the neighboring guide across a zero-thickness PEC wall.
    """
    if getattr(port, "WG_mode", None) != "TE10":
        raise ValueError("probe insetting supports rectangular TE10 ports only")
    grid = port.CSX.GetGrid()
    if grid.GetMeshType() != 0:
        raise ValueError("probe insetting requires a Cartesian mesh")
    axis = port.ny_PP
    low, high = sorted((float(port.start[axis]), float(port.stop[axis])))
    lines = np.asarray(grid.GetLines(axis), float)
    i0, i1 = _inset_range(lines, low, high, cells)
    probes = [p for p in port.port_props if p.GetTypeString() == "ProbeBox"]
    if len(probes) != 2 or any(p.GetQtyPrimitives() != 1 for p in probes):
        raise ValueError("expected one E and one H mode-probe box")
    # Validate every box before changing any of them. Repeated calls use the physical corners,
    # so the inset is idempotent rather than cumulative, including reversed transverse corners.
    boxes = []
    for prop in probes:
        box = prop.GetPrimitive(0)
        first, last = np.array(box.GetStart()), np.array(box.GetStop())
        first[axis], last[axis] = (lines[i0], lines[i1]) if port.start[axis] <= port.stop[axis] else (lines[i1], lines[i0])
        boxes.append((box, first, last))
    for box, first, last in boxes:
        box.SetStart(first)
        box.SetStop(last)
    port._fairbeam_probe_inset_cells = int(cells)
    return port


def probe_power_factor(lines_p, lines_pp, low, high, a: float, b: float, mode: str = "TE10", *,
                       inset_cells: int = 0) -> float:
    """``P_true / P_probe`` for the ideal TE_mn mode of an a x b guide on the mesh ``lines_p`` x
    ``lines_pp`` (the two axes transverse to the propagation direction, in drawing units).

    ``low`` / ``high`` are the (P, PP) coordinates of the probe box corners (the port's ``start`` /
    ``stop`` in the transverse plane), which snap to the nearest mesh lines like the CSXCAD probe.
    Everything outside the box is metal: its edges carry no field. The interpolation and the
    integration follow openEMS (E: node values, linear between the two edges of an axis, weighted by
    half the neighbouring cell sizes; H: unweighted mean of the four surrounding dual values, of
    which the two along the propagation axis are equal for a plane wave; E on primary nodes, H on
    cell centres, one node less at the upper end). ``inset_cells`` describes the optional TE10
    inset along b, while the physical guide, mode origin and true-power integral remain full width.
    """
    if not (mode.startswith("TE") and len(mode) == 4):
        raise ValueError(f"unsupported waveguide mode {mode!r}")
    m, n = int(mode[2]), int(mode[3])
    lp, lq = np.asarray(lines_p, float), np.asarray(lines_pp, float)
    i0, i1 = sorted((_nearest(lp, low[0]), _nearest(lp, high[0])))
    j0, j1 = sorted((_nearest(lq, low[1]), _nearest(lq, high[1])))
    if i1 - i0 < 2 or j1 - j0 < 2:
        raise ValueError("the probe box spans fewer than two cells")
    if isinstance(inset_cells, bool) or not isinstance(inset_cells, (int, np.integer)) or inset_cells < 0:
        raise ValueError("inset_cells must be a nonnegative integer")
    jq0, jq1 = j0, j1
    if inset_cells:
        if mode != "TE10":
            raise ValueError("probe insetting supports rectangular TE10 ports only")
        jq0, jq1 = _inset_range(lq, min(low[1], high[1]), max(low[1], high[1]), inset_cells)
    # ProcessModeMatch::InitProcess: the probe leaves out a box side on the first / last mesh line
    # (the domain boundary), and the H probe (dual mesh) drops one more node at the top unless that
    # rule already did
    ranges = []
    for lo, hi, size in ((i0, i1, len(lp)), (jq0, jq1, len(lq))):
        e0 = lo + 1 if lo == 0 else lo
        top = hi == size - 1
        e1 = hi - 1 if top else hi
        h1 = e1 if top else (hi - 1 if hi > e0 + 1 else hi)
        ranges.append((e0, e1, h1))
    (ie0, ie1, ih1), (je0, je1, jh1) = ranges
    x0, y0 = lp[i0], lq[j0]
    e_p, e_pp, h_p, h_pp = mode_functions(m, n, a, b)

    xl, yl = lp - x0, lq - y0                       # lines, from the corner
    xc, yc = 0.5 * (xl[1:] + xl[:-1]), 0.5 * (yl[1:] + yl[:-1])   # cell centres
    dp, dq = np.diff(lp), np.diff(lq)               # cell widths
    np_l, nq_l = len(lp), len(lq)
    cell_in_p = np.zeros(np_l - 1, bool); cell_in_p[i0:i1] = True
    cell_in_q = np.zeros(nq_l - 1, bool); cell_in_q[j0:j1] = True
    line_in_p = np.zeros(np_l, bool); line_in_p[i0:i1 + 1] = True
    line_in_q = np.zeros(nq_l, bool); line_in_q[j0:j1 + 1] = True

    def grid(fn, px, py, mask_p, mask_q):
        out = fn(px[:, None], py[None, :]) * np.ones((len(px), len(py)))
        return np.where(mask_p[:, None] & mask_q[None, :], out, 0.0)

    # Yee-lattice samples of the ideal fields (zero in the metal)
    E_p = grid(e_p, xc, yl, cell_in_p, line_in_q)      # (cell, line)
    E_q = grid(e_pp, xl, yc, line_in_p, cell_in_q)     # (line, cell)
    H_p = grid(h_p, xl, yc, line_in_p, cell_in_q)      # (line, cell)
    H_q = grid(h_pp, xc, yl, cell_in_p, line_in_q)     # (cell, line)

    def lin_axis(v, cells, axis):
        """Node value on lines from the edges (cells) along ``axis``, weighted like openEMS."""
        v = np.moveaxis(v, axis, 0)
        out = np.zeros((len(cells) + 1,) + v.shape[1:])
        for k in range(1, len(cells)):
            up, down = cells[k], cells[k - 1]
            out[k] = (v[k] * down + v[k - 1] * up) / (up + down)
        out[0] = v[0]
        out[-1] = v[-1]
        return np.moveaxis(out, 0, axis)

    def mean_axis(v, axis):
        """Unweighted mean of the two duals around each node (cells k-1 and k); zero at the ends."""
        v = np.moveaxis(v, axis, 0)
        out = np.zeros((v.shape[0] + 1,) + v.shape[1:])
        out[1:-1] = 0.5 * (v[1:] + v[:-1])
        return np.moveaxis(out, 0, axis)

    Enp = lin_axis(E_p, dp, 0)               # (line, line)
    Enq = lin_axis(E_q, dq, 1)
    Hnp = mean_axis(H_p, 1)                  # (line, line)
    Hnq = mean_axis(H_q, 0)

    # E probe: primary nodes i0..i1, j0..j1; template at the node, node area = dual widths
    wp, wq = _dual_width(lp), _dual_width(lq)
    sl_e = (slice(ie0, ie1 + 1), slice(je0, je1 + 1))
    area_e = (wp[:, None] * wq[None, :])[sl_e]
    t_ep = e_p(xl[:, None], yl[None, :])[sl_e] * np.ones_like(area_e)
    t_eq = e_pp(xl[:, None], yl[None, :])[sl_e] * np.ones_like(area_e)
    norm_e = np.sqrt(((t_ep ** 2 + t_eq ** 2) * area_e).sum())
    u = ((Enp[sl_e] * t_ep + Enq[sl_e] * t_eq) * area_e).sum() / norm_e

    # H probe: one node less at the top, template at the cell centre
    sl_h = (slice(ie0, ih1 + 1), slice(je0, jh1 + 1))
    area_h = (dp[:, None] * dq[None, :])[sl_h]
    t_hp = h_p(xc[:, None], yc[None, :])[sl_h] * np.ones_like(area_h)
    t_hq = h_pp(xc[:, None], yc[None, :])[sl_h] * np.ones_like(area_h)
    norm_h = np.sqrt(((t_hp ** 2 + t_hq ** 2) * area_h).sum())
    i_ = ((Hnp[sl_h] * t_hp + Hnq[sl_h] * t_hq) * area_h).sum() / norm_h
    p_probe = 0.5 * u * i_

    # ideal mode power: 1/2 integral of (e_P h_PP - e_PP h_P) over the guide (midpoint rule, fine grid)
    ng = 400
    gx = (np.arange(ng) + 0.5) * a / ng
    gy = (np.arange(ng) + 0.5) * b / ng
    X, Y = np.meshgrid(gx, gy, indexing="ij")
    p_true = 0.5 * ((e_p(X, Y) * h_pp(X, Y) - e_pp(X, Y) * h_p(X, Y)).sum() * (a / ng) * (b / ng))
    if p_probe == 0 or not np.isfinite(p_probe):
        raise ValueError("degenerate probe")
    return float(abs(p_true / p_probe))
