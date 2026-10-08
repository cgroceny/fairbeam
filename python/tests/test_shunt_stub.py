"""Pure references and explicit opt-in planar stub acquisition; no FDTD in discovery."""
import argparse
import json
import unittest
from pathlib import Path

import numpy as np

from fairbeam.network import network_s
from tests import shunt_stub_fixture as f


class ShuntStubControls(unittest.TestCase):
    def test_two_independent_solutions_match(self):
        load = complex(f.LOAD_R, f.LOAD_X)
        y = f.Z0/load
        for theta, stub in f.synthesis():
            line = (y+1j*np.tan(theta))/(1+1j*y*np.tan(theta))
            np.testing.assert_allclose(line-1j/np.tan(stub), 1., atol=2e-15)
        self.assertAlmostEqual(f.reference('stub')[50].real, f.Z0, delta=1e-12)
        self.assertAlmostEqual(f.reference('stub')[50].imag, 0., delta=1e-12)

    def test_reference_against_independently_stamped_lines(self):
        delay = lambda length: length*1e-3*np.sqrt(f.EPS_EFF)/299792458.
        load = f.LOAD_R+1/(2j*np.pi*f.FREQUENCIES*f.LOAD_C)
        for kind in ('bare', 'stub'):
            lines = [(0, 1, f.Z0, delay(f.D))]
            impedances = [(1, -1, load)]
            if kind == 'stub':
                lines.append((0, 2, f.Z0, delay(f.STUB_LENGTH)))
                impedances.append((2, -1, 0.))
            s = network_s(f.FREQUENCIES, [0], lines, impedances=impedances)[:, 0, 0]
            z = f.reference(kind)
            np.testing.assert_allclose(s, (z-f.Z0)/(z+f.Z0), atol=2e-14)

    def test_complex_line_plane_inversion(self):
        g = .02+2j*np.pi*f.FREQUENCIES/1.1e8
        zc, load = 51.+.15j, 60.-25j
        t = np.tanh(g*.008)
        at_feed = zc*(load+zc*t)/(zc+load*t)
        np.testing.assert_allclose(f.move_plane(at_feed, g, zc, .008), load, atol=8e-14)

    def test_reflected_calibration_keeps_loss_and_spatial_stagger(self):
        g = -.02+2j*np.pi*f.FREQUENCIES/1.1e8
        zc, dx, r = 51.+.02j, .0001, .3+.2j
        v = np.array([np.exp(-g*x)+r*np.exp(g*x) for x in (-dx, 0., dx)])
        i = np.array([(np.exp(-g*x)-r*np.exp(g*x))/zc for x in (-dx/2, dx/2)])
        measured, z, aligned = f.line_parameters(v, i, dx)
        np.testing.assert_allclose(measured, g, atol=2e-10, rtol=0)
        np.testing.assert_allclose(z, zc, atol=3e-11, rtol=0)
        np.testing.assert_allclose(aligned, (1-r)/zc, atol=1e-15)
        with self.assertRaises(ValueError):
            f.line_parameters(v, i, 0.)

    def test_mesh_geometry_and_actual_dual_current_contours(self):
        old_cells = 0
        for n in f.MESHES:
            sim, _ = f.build(n, 'stub')
            axes = [sim.mesh.GetLines(a) for a in 'xyz']
            self.assertTrue(all(np.all(np.diff(a) > 0) for a in axes))
            cells = int(np.prod([len(a)-1 for a in axes]))
            self.assertGreater(cells, old_cells)
            old_cells = cells
            self.assertIn(f.H, axes[2])
            self.assertIn(f.STUB_LENGTH, axes[1])
            for p, centre in enumerate(f.MEAS_PLANES):
                x = axes[0]
                ix = int(np.flatnonzero(x == centre)[0])
                np.testing.assert_allclose(np.diff(x[ix-1:ix+2]), f.H/n, rtol=1e-12)
                for j, plane in enumerate(((x[ix-1]+centre)/2, (centre+x[ix+1])/2)):
                    box = sim.csx.GetPropertiesByName(f'i{p}_{j}')[0].GetPrimitive(0)
                    self.assertEqual(box.GetStart()[0], plane)
                    self.assertEqual(box.GetStop()[0], plane)
        with self.assertRaises(ValueError):
            f.build(True, 'stub')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--preflight', action='store_true')
    mode.add_argument('--fdtd', action='store_true')
    parser.add_argument('--out', type=Path)
    parser.add_argument('--mesh', type=int, choices=f.MESHES, default=f.MESHES[0])
    parser.add_argument('--kind', choices=f.KINDS, default='stub')
    parser.add_argument('--expanded', action='store_true')
    args = parser.parse_args()
    if args.preflight:
        for n in f.MESHES:
            sim, _ = f.build(n, 'stub', args.expanded)
            print(json.dumps(dict(mesh=n, cells=int(np.prod([len(sim.mesh.GetLines(a))-1 for a in 'xyz'])),
                dt_ps=sim.cfl_timestep()*1e12, w_mm=f.W, d_mm=f.D, stub_length_mm=f.STUB_LENGTH,
                pulse_end_s=f.excitation.dgauss_duration_s(sim.f_max), max_steps=sim.max_timesteps)))
    elif args.fdtd:
        if args.out is None:
            parser.error('--out is required')
        print(json.dumps(f.acquire(args.out, args.mesh, args.kind, args.expanded)))
    else:
        unittest.main(argv=[__name__])


if __name__ == '__main__':
    main()
