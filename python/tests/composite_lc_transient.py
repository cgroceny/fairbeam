"""Test-only transient reference for a positive-L/grounded-C terminal graph.

States are normalized so stored energy is x.T @ x / 2. Zero-storage,
unterminated nodes impose KCL constraints on inductor currents; their
voltages are eliminated rather than supplied with artificial capacitance.
For matched Thevenin source voltages u: dx/dt = a*x + b*u,
i = current_map*x + direct_current*u, and v = u - resistance*i.
No native solver, geometry change, component fit or qualification flag.
"""
from dataclasses import dataclass
import numpy as np


@dataclass(frozen=True)
class Circuit:
    a: np.ndarray
    b: np.ndarray
    current_map: np.ndarray
    direct_current: np.ndarray
    resistance: float

    def scattering(self, frequencies):
        f = np.asarray(frequencies)
        if (np.iscomplexobj(f) or f.ndim != 1 or not len(f)
                or not np.isfinite(f).all() or np.any(f <= 0)):
            raise ValueError('finite positive frequency vector required')
        n = len(self.a)
        response = np.empty((len(f), 2, 2), complex)
        for j, frequency in enumerate(f):
            state = np.linalg.solve(2j * np.pi * frequency * np.eye(n) - self.a, self.b)
            response[j] = np.eye(2) - 2 * self.resistance * (
                self.current_map @ state + self.direct_current)
        return response


def build(elements, ports=(0, 6), resistance=75.):
    """Ideal wires for an empty graph; otherwise L branches and grounded C.

    The two resistively terminated port nodes must have no capacitor.
    This is the composite fixture's graph class, not a general MNA solver.
    """
    if (len(ports) != 2 or len(set(ports)) != 2
            or any(isinstance(p, bool) or not isinstance(p, int) or p < 0 for p in ports)
            or isinstance(resistance, bool) or not np.isfinite(resistance) or resistance <= 0):
        raise ValueError('two distinct nodes and a positive resistance required')
    rows = list(elements)
    if not rows:
        return Circuit(np.empty((0, 0)), np.empty((0, 2)), np.empty((2, 0)),
            np.array([[1., -1.], [-1., 1.]]) / (2 * resistance), float(resistance))
    for row in rows:
        if (row['kind'] not in ('L', 'C') or row['a'] == row['b']
                or any(isinstance(row[k], bool) or not isinstance(row[k], int)
                    or row[k] < -1 for k in ('a', 'b'))
                or row['a'] < 0 or isinstance(row['value_si'], bool)
                or not np.isfinite(row['value_si']) or row['value_si'] <= 0
                or (row['kind'] == 'C' and (row['b'] != -1 or row['a'] in ports))):
            raise ValueError('positive L branches and nonterminal grounded C required')
    nodes = sorted(set(ports) | {row[k] for row in rows for k in ('a', 'b') if row[k] >= 0})
    index = {node: j for j, node in enumerate(nodes)}
    inductors = [row for row in rows if row['kind'] == 'L']
    incidence = np.zeros((len(nodes), len(inductors)))
    for j, row in enumerate(inductors):
        incidence[index[row['a']], j] = 1
        if row['b'] >= 0:
            incidence[index[row['b']], j] = -1
    capacitance = {}
    for row in rows:
        if row['kind'] == 'C':
            capacitance[row['a']] = capacitance.get(row['a'], 0.) + row['value_si']
    capacitive = sorted(capacitance)
    zero_storage = [node for node in nodes if node not in ports and node not in capacitance]
    constraint = incidence[[index[node] for node in zero_storage]]
    if constraint.size:
        _, singular, vh = np.linalg.svd(constraint, full_matrices=True)
        tolerance = np.finfo(float).eps * max(constraint.shape) * singular[0]
        basis = vh[int(np.count_nonzero(singular > tolerance)):].T
    else:
        basis = np.eye(len(inductors))
    if not basis.shape[1]:
        raise ValueError('no current state reaches the declared terminal graph')
    magnetic = basis.T @ np.diag([row['value_si'] for row in inductors]) @ basis
    eigenvalue, eigenvector = np.linalg.eigh(magnetic)
    if np.any(eigenvalue <= 0):
        raise ValueError('positive magnetic energy required')
    inverse_root = (eigenvector / np.sqrt(eigenvalue)) @ eigenvector.T
    dc = incidence[[index[node] for node in capacitive]] @ basis
    dp = incidence[[index[node] for node in ports]] @ basis
    coupling = dc @ inverse_root / np.sqrt([capacitance[node] for node in capacitive])[:, None]
    terminal = dp @ inverse_root
    nc = len(capacitive)
    a = np.block([[np.zeros((nc, nc)), -coupling],
                  [coupling.T, -resistance * terminal.T @ terminal]])
    b = np.vstack((np.zeros((nc, 2)), terminal.T))
    current_map = np.hstack((np.zeros((2, nc)), terminal))
    return Circuit(a, b, current_map, np.zeros((2, 2)), float(resistance))


def gaussian_derivative(time_s, f_max_hz=3e6):
    """Causal reference with the native expression's recorded rounding."""
    if not np.isfinite(f_max_hz) or f_max_hz <= 0:
        raise ValueError('finite positive pulse frequency required')
    tau = 1 / (np.sqrt(2) * np.pi * f_max_hz / 2.76)
    t0, tau = float(f'{5 * tau:.6e}'), float(f'{tau:.6e}')
    time = np.asarray(time_s, float)
    x = (time - t0) / tau
    return np.where(time >= 0, -float(f'{np.sqrt(2 * np.e):.8f}') * x * np.exp(-x * x), 0.)


def transient(circuit, time_s, drive_port=0, f_max_hz=3e6):
    """Zero initial state; eight-point Gaussian quadrature in each interval."""
    time = np.asarray(time_s)
    if (np.iscomplexobj(time) or time.ndim != 1 or len(time) < 2
            or not np.isfinite(time).all() or time[0] != 0 or np.any(np.diff(time) <= 0)
            or isinstance(drive_port, bool) or drive_port not in (0, 1)):
        raise ValueError('increasing finite clock starting at zero and one drive port required')
    pulse = gaussian_derivative(time, f_max_hz)
    tau = 2.76 / (np.sqrt(2) * np.pi * f_max_hz)
    if np.diff(time).max() > tau / 2:
        raise ValueError('clock is too coarse for the pulse quadrature')
    state = np.zeros((len(time), len(circuit.a)))
    if len(circuit.a):
        pole, vector = np.linalg.eig(circuit.a)
        if np.linalg.cond(vector) > 1e8 or pole.real.max() > 1e-10 * np.linalg.norm(circuit.a, 2):
            raise ValueError('unresolved or growing modal system')
        force = np.linalg.solve(vector, circuit.b[:, drive_port])
        modal = np.zeros(len(pole), complex)
        node, weight = np.polynomial.legendre.leggauss(8)
        for j, step in enumerate(np.diff(time), 1):
            samples = time[j-1] + step * (node + 1) / 2
            drive = gaussian_derivative(samples, f_max_hz) * weight * step / 2
            integral = np.exp(pole[:, None] * step * (1-node) / 2) @ drive
            modal = np.exp(pole * step) * modal + force * integral
            value = vector @ modal
            if abs(value.imag).max() > 1e-10 * max(abs(value.real).max(), 1e-30):
                raise ValueError('complex residual in a real transient')
            state[j] = value.real
    source = np.zeros((len(time), 2)); source[:, drive_port] = pulse
    current = state @ circuit.current_map.T + source @ circuit.direct_current.T
    return dict(time_s=time.astype(float), voltage_v=source-circuit.resistance*current,
        current_a=current, energy_j=np.sum(state*state, axis=1)/2)


def window_s(circuit, time_s, frequencies, f_max_hz=3e6):
    """Uniform-clock estimate after the source, within f_max/6..f_max."""
    f = np.asarray(frequencies)
    circuit.scattering(f)  # Same finite positive-frequency admission.
    if np.any((f < f_max_hz/6) | (f > f_max_hz)):
        raise ValueError('frequencies must stay inside the declared pulse band')
    rows = [transient(circuit, time_s, port, f_max_hz) for port in (0, 1)]
    time = rows[0]['time_s']; step = np.diff(time)
    if time[-1] < 10*2.76/(np.sqrt(2)*np.pi*f_max_hz):
        raise ValueError('record must include the complete source')
    if not np.allclose(step, step[0], rtol=1e-9, atol=0):
        raise ValueError('uniform Fourier clock required')
    if f.max() >= 1/(2*step[0]):
        raise ValueError('frequency exceeds the sampling Nyquist limit')
    transform = 2*step[0]*np.exp(-2j*np.pi*np.outer(f, time))
    v = np.stack([transform @ row['voltage_v'] for row in rows], axis=2)
    i = np.stack([transform @ row['current_a'] for row in rows], axis=2)
    a = (v+circuit.resistance*i)/(2*np.sqrt(circuit.resistance))
    b = (v-circuit.resistance*i)/(2*np.sqrt(circuit.resistance))
    if not np.isfinite(a).all() or np.linalg.cond(a).max() > 30:
        raise ValueError('unexcited or ill-conditioned incident waves')
    s = np.linalg.solve(a.transpose(0, 2, 1), b.transpose(0, 2, 1)).transpose(0, 2, 1)
    return dict(s=s, records=rows, qualified=False)
