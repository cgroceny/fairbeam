"""Small linear circuit references for multi-port electromagnetic models.

Lossless TEM lines are stamped with their voltage/current equations, rather than a
cotangent admittance. This remains well behaved at integer half wavelengths. Nodes
are zero based; a node of -1 denotes ground for a lumped admittance or impedance. Power waves use
real, positive port reference impedances and the exp(+j omega t) convention.

This solver ignores discontinuities, radiation and dispersion. It provides the
ideal circuit baseline; it does not replace openEMS.
"""
from __future__ import annotations

import numpy as np


def _node(value, *, ground=False):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, np.integer)):
        raise ValueError("nodes must be integers; ground is -1")
    value = int(value)
    if value < (-1 if ground else 0):
        raise ValueError("nodes must be nonnegative; ground is -1")
    return value


def _positive(value, what):
    if np.iscomplexobj(value) or np.ndim(value) != 0:
        raise ValueError(f"{what} must be a positive finite real scalar")
    try:
        value = float(value)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"{what} must be a positive finite real scalar") from None
    if not np.isfinite(value) or value <= 0:
        raise ValueError(f"{what} must be a positive finite real scalar")
    return value


def network_s(f, ports, lines=(), *, z_ref=50.0, admittances=(), impedances=()):
    """Return (frequency, port, port) S for a network of lines and admittances.

    ``ports`` gives the node at each port, in S-matrix order. ``lines`` contains
    (node_a, node_b, impedance_ohm, delay_seconds). ``admittances`` contains
    (node_a, node_b, siemens), where siemens is a scalar or an array matching f.
    ``impedances`` contains (node_a, node_b, ohms), allowing exact series shorts.
    Ground (-1) may be used at one end of an admittance or impedance. Internal nodes must be
    connected and node numbers must span 0..N-1. Frequencies must be positive.

    Each line contributes two current unknowns and its ABCD equations. At the
    ports, KCL is I_network + V/Zref = 2*a/sqrt(Zref); b = V/sqrt(Zref) - a.
    Singular floating or resonant networks raise numpy.linalg.LinAlgError.
    """
    if np.iscomplexobj(f):
        raise ValueError("frequencies must be real")
    f = np.atleast_1d(np.asarray(f, dtype=float))
    if f.ndim != 1 or not f.size or not np.all(np.isfinite(f)) or np.any(f <= 0):
        raise ValueError("frequencies must be a nonempty positive finite vector")
    ports = [_node(n) for n in ports]
    lines, admittances, impedances = list(lines), list(admittances), list(impedances)
    if not ports or len(set(ports)) != len(ports):
        raise ValueError("ports must be distinct nodes")
    nodes = list(ports)
    normalized_lines = []
    for a, b, z, delay in lines:
        a, b = _node(a), _node(b)
        if a == b or a < 0 or b < 0:
            raise ValueError("a line needs two distinct non-ground nodes")
        z, delay = _positive(z, "line impedance"), _positive(delay, "line delay")
        normalized_lines.append((a, b, z, delay))
        nodes.extend((a, b))
    lines = normalized_lines
    ys = []
    for a, b, y in admittances:
        a, b = _node(a, ground=True), _node(b, ground=True)
        if a == b or a < -1 or b < -1:
            raise ValueError("an admittance needs two distinct nodes; ground is -1")
        nodes.extend(n for n in (a, b) if n >= 0)
        y = np.broadcast_to(np.asarray(y, complex), f.shape)
        if not np.all(np.isfinite(y)):
            raise ValueError("admittances must be finite")
        ys.append((a, b, y))
    zs = []
    for a, b, z in impedances:
        a, b = _node(a, ground=True), _node(b, ground=True)
        if a == b or a < -1 or b < -1:
            raise ValueError("an impedance needs two distinct nodes; ground is -1")
        nodes.extend(n for n in (a, b) if n >= 0)
        z = np.broadcast_to(np.asarray(z, complex), f.shape)
        if not np.all(np.isfinite(z)):
            raise ValueError("impedances must be finite")
        zs.append((a, b, z))
    n_nodes = int(max(nodes)) + 1
    if len(set(nodes)) != n_nodes:
        raise ValueError("node numbers must span 0..N-1")
    ports = np.asarray(ports, dtype=int)
    if np.iscomplexobj(z_ref):
        raise ValueError("reference impedances must be real")
    z_ref = np.broadcast_to(np.asarray(z_ref, float), (len(ports),))
    if not np.all(np.isfinite(z_ref)) or np.any(z_ref <= 0):
        raise ValueError("reference impedances must be positive and finite")
    dim = n_nodes + 2 * len(lines) + len(zs)
    out = np.empty((len(f), len(ports), len(ports)), complex)
    drive = np.eye(len(ports))
    rhs = np.zeros((dim, len(ports)), complex)
    rhs[ports] = 2 * drive / np.sqrt(z_ref)[:, None]
    for k, fk in enumerate(f):
        m = np.zeros((dim, dim), complex)
        m[ports, ports] += 1 / z_ref
        for a, b, y in ys:
            for u, v, sign in ((a, a, 1), (b, b, 1), (a, b, -1), (b, a, -1)):
                if u != -1 and v != -1:
                    m[int(u), int(v)] += sign * y[k]
        for q, (a, b, z, delay) in enumerate(lines):
            a, b = int(a), int(b)
            ia, ib = n_nodes + 2*q, n_nodes + 2*q + 1
            theta = 2 * np.pi * fk * delay
            c, s = np.cos(theta), np.sin(theta)
            m[a, ia] += 1
            m[b, ib] += 1
            m[ia, a], m[ia, b], m[ia, ib] = 1, -c, 1j*z*s
            m[ib, ia], m[ib, b], m[ib, ib] = 1, -1j*s/z, c
        for q, (a, b, z) in enumerate(zs):
            iq = n_nodes + 2*len(lines) + q
            if a != -1:
                m[int(a), iq] += 1
                m[iq, int(a)] += 1
            if b != -1:
                m[int(b), iq] -= 1
                m[iq, int(b)] -= 1
            m[iq, iq] = -z[k]
        v = np.linalg.solve(m, rhs)[ports]
        out[k] = v / np.sqrt(z_ref)[:, None] - drive
    return out


def wilkinson_s(f, f0, z0=50.0):
    """Ideal equal-split Wilkinson; ports input, output 2, output 3 (Pozar 7.2)."""
    f0, z0 = _positive(f0, "design frequency"), _positive(z0, "reference impedance")
    arm = z0 * np.sqrt(2)
    return network_s(f, [0, 1, 2], [(0, 1, arm, 1/(4*f0)), (0, 2, arm, 1/(4*f0))],
                     z_ref=z0, admittances=[(1, 2, 1/(2*z0))])


def branchline_s(f, f0, z0=50.0):
    """Ideal 90-degree hybrid; ports top-left, top-right, bottom-right, bottom-left."""
    f0, z0 = _positive(f0, "design frequency"), _positive(z0, "reference impedance")
    t = 1/(4*f0)
    return network_s(f, [0, 1, 2, 3], [(0, 1, z0/np.sqrt(2), t), (1, 2, z0, t),
                                      (2, 3, z0/np.sqrt(2), t), (3, 0, z0, t)], z_ref=z0)


def _s_matrix(s, n_freq=None, n_ports=None):
    s = np.asarray(s, complex)
    if (s.ndim != 3 or not s.shape[0] or not s.shape[1] or s.shape[1] != s.shape[2]
            or (n_freq is not None and s.shape[0] != n_freq)
            or (n_ports is not None and s.shape[1] != n_ports) or not np.isfinite(s).all()):
        raise ValueError("S must be a complete finite (frequency, port, port) matrix")
    return s


def _real_nonnegative(value, what):
    if isinstance(value, (bool, np.bool_)) or np.iscomplexobj(value) or np.ndim(value):
        raise ValueError(f"{what} must be a nonnegative finite real scalar")
    try:
        value = float(value)
    except (ValueError, TypeError, OverflowError):
        raise ValueError(f"{what} must be a nonnegative finite real scalar") from None
    if not np.isfinite(value) or value < 0:
        raise ValueError(f"{what} must be a nonnegative finite real scalar")
    return value


def _finite_exp(value):
    with np.errstate(over="ignore", under="ignore", invalid="ignore"):
        out = np.exp(value)
    if not np.isfinite(out).all() or np.any(out == 0):
        raise ValueError("feed correction overflows or underflows; use a shorter distance/band")
    return out


def two_line_calibration(f, s_short, s_long, *, short_length_m, long_length_m,
                         beta_hint, match_tol=0.05, reciprocity_tol=0.01,
                         transmission_floor=1e-6):
    """Extract gamma = alpha + j*beta and the common launch product from two lines.

    Model: S21(l) = g1*g2*exp(-gamma*l), exp(+j omega t) convention.
    Both controls must have identical reciprocal, matched launches, cross-section,
    port reference impedances and frequency grid. This is NOT a full TRL/error-box
    calibration. Low measured reflections are necessary, not proof of these assumptions.

    f is a strictly increasing positive Hz vector. beta_hint is a nonnegative real
    rad/m vector at every frequency, accurate within pi/(long_length-short_length)
    of the physical beta. It selects the otherwise ambiguous logarithm branch;
    no frequency unwrapping or implicit material estimate chooses the branch.
    A hint at a branch tie is refused. Loss is never clipped to make a line passive.

    Returns an in-memory dict with frequency_hz, gamma_per_m, launch_product,
    branch (one column per direction), length_difference_m, match_max and
    reciprocity_max. Individual g1/g2 cannot be recovered from their product.
    No bundle, schema, port metadata or saved result is modified.
    """
    if np.iscomplexobj(f):
        raise ValueError("frequencies must be real")
    f = np.asarray(f, float)
    if (f.ndim != 1 or not f.size or not np.isfinite(f).all()
            or np.any(f <= 0) or np.any(np.diff(f) <= 0)):
        raise ValueError("frequencies must be a strictly increasing positive finite vector")
    short = _real_nonnegative(short_length_m, "short length")
    long = _real_nonnegative(long_length_m, "long length")
    if long <= short:
        raise ValueError("long length must exceed short length")
    dl = long - short
    match_tol = _real_nonnegative(match_tol, "match tolerance")
    reciprocity_tol = _real_nonnegative(reciprocity_tol, "reciprocity tolerance")
    floor = _positive(transmission_floor, "transmission floor")
    if match_tol >= 1 or reciprocity_tol >= 1 or floor >= 1:
        raise ValueError("control tolerances and transmission floor must be below 1")
    if np.iscomplexobj(beta_hint):
        raise ValueError("beta_hint must be a nonnegative real rad/m vector matching f")
    hint = np.asarray(beta_hint, float)
    if hint.shape != f.shape or not np.isfinite(hint).all() or np.any(hint < 0):
        raise ValueError("beta_hint must be a nonnegative finite rad/m vector matching f")
    controls = [_s_matrix(s, len(f), 2) for s in (s_short, s_long)]
    match = max(float(np.max(np.abs(s[:, (0, 1), (0, 1)]))) for s in controls)
    if match > match_tol:
        raise ValueError(f"line control reflection {match:g} exceeds match_tol {match_tol:g}; "
                         "matched-feed extraction cannot remove launch mismatch")
    transmissions = [s[:, (1, 0), (0, 1)] for s in controls]  # forward, reverse
    if any(np.any(np.abs(t) < floor) for t in transmissions):
        raise ValueError("line control transmission is below transmission_floor")
    reciprocity = max(float(np.max(np.abs(t[:, 0] - t[:, 1]) / np.max(np.abs(t), axis=1)))
                      for t in transmissions)
    if reciprocity > reciprocity_tol:
        raise ValueError(f"line control reciprocity error {reciprocity:g} exceeds reciprocity_tol")
    ts, tl = transmissions
    # Angles/log magnitudes avoid a potentially ill-conditioned complex division.
    phase = (np.angle(tl) - np.angle(ts) + np.pi) % (2 * np.pi) - np.pi
    principal = -phase / dl
    with np.errstate(over="ignore", invalid="ignore"):
        branch_float = (hint[:, None] - principal) * dl / (2 * np.pi)
    if not np.isfinite(branch_float).all() or np.any(np.abs(branch_float) > 2**52):
        raise ValueError("beta_hint is too large to select a reliable phase branch")
    branch = np.rint(branch_float)
    if np.any(np.abs(np.abs(branch_float - branch) - .5) < 1e-10):
        raise ValueError("beta_hint is at an ambiguous logarithm branch tie")
    alpha = -(np.log(np.abs(tl)) - np.log(np.abs(ts))) / dl
    beta = principal + 2 * np.pi * branch / dl
    if np.any(np.abs(beta[:, 0] - beta[:, 1]) * dl >= np.pi):
        raise ValueError("beta_hint selects incompatible forward/reverse phase branches")
    gamma = np.mean(alpha + 1j * beta, axis=1)
    if not np.isfinite(gamma).all():
        raise ValueError("line propagation constant is not finite")
    launch = np.mean(ts, axis=1) * _finite_exp(gamma * short)
    if not np.isfinite(launch).all() or np.any(launch == 0):
        raise ValueError("common launch product is not finite/nonzero")
    return {"frequency_hz": f.copy(), "gamma_per_m": gamma, "launch_product": launch,
            "length_difference_m": dl, "branch": branch.astype(np.int64),
            "match_max": match, "reciprocity_max": reciprocity}


def shift_reference_planes(s, gamma_per_m, distances_m, *, launch_factors=None):
    """Return a copy of S with matched feed sections removed, for any port count.

    Positive distances move into the device; negative distances add line back.
    gamma has shape (frequency,) for a common line or (frequency, port).
    distances is one real scalar for all ports or a real (port,) vector in meters.
    S'_ij = S_ij * exp(gamma_i*d_i + gamma_j*d_j); reflection uses twice the distance.
    The port reference impedances must match each feed's characteristic impedance.

    Optional launch_factors is a finite nonzero complex (frequency, port) array
    of independently known matched one-way g_i, dividing S'_ij by g_i*g_j.
    Two lines only determine g1*g2; this API never invents a split or square root.
    Feed mismatch, higher modes, radiation, renormalization, fixture cross-coupling
    and a full TRL/error-box calibration are outside this model.
    """
    s = _s_matrix(s)
    n_f, n, _ = s.shape
    gamma = np.asarray(gamma_per_m, complex)
    if gamma.shape == (n_f,):
        gamma = np.broadcast_to(gamma[:, None], (n_f, n))
    if gamma.shape != (n_f, n) or not np.isfinite(gamma).all():
        raise ValueError("gamma_per_m must be finite with shape (frequency,) or (frequency, port)")
    if np.iscomplexobj(distances_m):
        raise ValueError("distances_m must be real meters")
    distances = np.asarray(distances_m, float)
    if distances.shape not in ((), (n,)) or not np.isfinite(distances).all():
        raise ValueError("distances_m must be a finite scalar or (port,) vector")
    exponent = gamma * distances
    factor = _finite_exp(exponent[:, :, None] + exponent[:, None, :])
    if launch_factors is not None:
        launch = np.asarray(launch_factors, complex)
        if launch.shape != (n_f, n) or not np.isfinite(launch).all() or np.any(launch == 0):
            raise ValueError("launch_factors must be finite/nonzero with shape (frequency, port)")
        with np.errstate(over="ignore", under="ignore", invalid="ignore", divide="ignore"):
            product = launch[:, :, None] * launch[:, None, :]
            if not np.isfinite(product).all() or np.any(product == 0):
                raise ValueError("launch product overflows or underflows")
            factor = factor / product
    with np.errstate(over="ignore", invalid="ignore"):
        out = s * factor
    if not np.isfinite(factor).all() or np.any(factor == 0) or not np.isfinite(out).all():
        raise ValueError("matched-feed correction is not finite")
    return out
