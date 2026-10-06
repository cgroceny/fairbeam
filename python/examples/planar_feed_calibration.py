"""Offline matched-feed example using own synthetic ABCD controls; no FDTD.

From python/: python examples/planar_feed_calibration.py
The known synthetic launch factors are used explicitly. A real two-line control
does not identify the two factors separately; feed-only correction leaves them.
"""
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fairbeam.network import shift_reference_planes, two_line_calibration


def line(electrical_length):
    m = np.empty((len(electrical_length), 2, 2), complex)
    m[:, 0, 0] = m[:, 1, 1] = np.cosh(electrical_length)
    m[:, 0, 1], m[:, 1, 0] = 50*np.sinh(electrical_length), np.sinh(electrical_length)/50
    return m


def to_s(m):
    a, b, c, d = (m[:, i, j] for i, j in ((0, 0), (0, 1), (1, 0), (1, 1)))
    den = a + b/50 + 50*c + d
    s = np.empty_like(m)
    s[:, 0, 0] = (a + b/50 - 50*c - d)/den
    s[:, 1, 1] = (-a + b/50 - 50*c + d)/den
    s[:, 1, 0], s[:, 0, 1] = 2/den, 2*(a*d-b*c)/den
    return s


def main():
    f = np.array([1, 2, 2.4, 3, 5])*1e9
    gamma = 1.2*np.sqrt(f/1e9) + 2j*np.pi*f*np.sqrt(3)/299792458
    g1, g2 = .96*np.exp(-2j*np.pi*f*9e-12), .9*np.exp(-2j*np.pi*f*17e-12)
    controls = [to_s(line(gamma*l - np.log(g1*g2))) for l in (.018, .052)]
    cal = two_line_calibration(f, *controls, short_length_m=.018, long_length_m=.052,
                              beta_hint=2*np.pi*f*np.sqrt(2.8)/299792458)
    # Own DUT: a series 25-ohm resistor and 4.7-nH inductance. Ports use 50 ohms.
    dut = np.tile(np.eye(2, dtype=complex), (len(f), 1, 1))
    dut[:, 0, 1] = 25 + 2j*np.pi*f*4.7e-9
    distances = [.011, .019]
    measured = to_s(line(gamma*distances[0] - np.log(g1)) @ dut @
                    line(gamma*distances[1] - np.log(g2)))
    target = to_s(dut)
    feed_only = shift_reference_planes(measured, cal['gamma_per_m'], distances)
    corrected = shift_reference_planes(measured, cal['gamma_per_m'], distances,
                                       launch_factors=np.column_stack([g1, g2]))
    print(f"max abs gamma error: {np.max(abs(cal['gamma_per_m']-gamma)):.6e} 1/m")
    print(f"max abs common launch-product error: {np.max(abs(cal['launch_product']-g1*g2)):.6e}")
    print('f/GHz | max abs S error: raw | feed-only | independently known launches removed')
    for k, frequency in enumerate(f):
        errors = [np.max(abs(v[k]-target[k])) for v in (measured, feed_only, corrected)]
        print(f"{frequency/1e9:.1f} | {errors[0]:.6f} | {errors[1]:.6f} | {errors[2]:.6e}")
    if not np.allclose(corrected, target, rtol=0, atol=1e-12):
        raise AssertionError('synthetic matched-feed correction failed')
    print('Circuit/post-processing control only; no FDTD or mesh convergence claim.')


if __name__ == '__main__':
    main()
