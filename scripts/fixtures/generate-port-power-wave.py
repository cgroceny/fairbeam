"""Independent synthetic nodal controls; no EM solver or Fairbeam transform imports.

Regenerate: python scripts/fixtures/generate-port-power-wave.py
For each excitation solve physical nodal V and I=YV from the incident-wave
boundary condition (Id + diag(Zref)Y)V = diag(2 sqrt(Re Zref)).
Then observe b=(V-diag(conj(Zref))I)/(2 sqrt(Re Zref)).
These are separate circuit solves, not renormalization of an existing S matrix.
"""
import json
from pathlib import Path

import numpy as np


def pairs(a):
    return np.stack([a.real, a.imag], axis=-1).tolist()


def circuit(y, refs):
    root = np.sqrt(refs.real)
    voltage = np.linalg.solve(np.eye(3) + np.diag(refs) @ y, np.diag(2 * root))
    current = y @ voltage
    reflected = (voltage - np.diag(refs.conjugate()) @ current) / (2 * root[:, None])
    # Independent energy identity for the actual solved terminal V/I columns.
    np.testing.assert_allclose(1 - np.sum(abs(reflected) ** 2, axis=0),
                               np.real(np.sum(voltage * current.conjugate(), axis=0)), atol=2e-14)
    return reflected


refs = np.array([35, 50, 90], dtype=complex)
frequency = [0.4e9, 1.0e9, 2.3e9]
# Positive dissipative symmetric part plus a nonsymmetric controlled coupling.
# This is an ideal nonreciprocal small-signal circuit, not a measured component.
conductance = np.array([[.030, -.004, .002], [-.001, .025, -.003], [.004, -.002, .020]])
capacitance = np.array([[1.1, -.13, .07], [-.13, .8, -.09], [.07, -.09, .7]]) * 1e-12
networks = [conductance + 2j * np.pi * f * capacitance for f in frequency]
target = 75 + 25j
payload = {
    "kind": "synthetic nonreciprocal nodal circuit; not an EM run or measurement",
    "generator": "generate-port-power-wave.py: independent V/I boundary solves with NumPy",
    "physical_ports": [7, 2, 19], "source_references_ohm": refs.real.tolist(),
    "target_reference_ohm": [target.real, target.imag], "frequency_hz": frequency,
    "admittance_siemens": [pairs(y) for y in networks],
    "source": [pairs(circuit(y, refs)) for y in networks],
    "target": [pairs(circuit(y, np.full(3, target))) for y in networks],
}
Path(__file__).with_name("port-power-wave.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
print("Generated three independent 3-port V/I power-wave circuit controls; six energy identities passed.")
