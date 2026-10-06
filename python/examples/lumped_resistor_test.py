"""Standalone reproduction: effective impedance of an openEMS lumped resistor vs frequency and mesh.

Uses only openEMS / CSXCAD / numpy (no fairbeam), so it can be shared as is.

Fixture: two small PEC plates (a x w, a gap g apart in z) in free space. A 50 ohm lumped port
drives the gap at x = 0; the device under test (DUT) bridges the gap at the other end, x = a.
Three runs per mesh (open: no DUT, short: DUT = metal, and the DUT) allow the classic open-short
de-embedding of the fixture, so the DUT impedance comes out without the plate inductance or gap
capacitance:

    Y'_m = 1/Z_m - 1/Z_open,   Y'_s = 1/Z_short - 1/Z_open,   Z_dut = 1/Y'_m - 1/Y'_s

DUT kinds:
    lumped         CSX.AddLumpedElement(ny=2, caps=True,  R=R)   (what openEMS lumped ports use)
    lumped-nocaps  CSX.AddLumpedElement(ny=2, caps=False, R=R)
    port           a passive openEMS LumpedPort (R, excite=0); also reports -U/I at the DUT itself
    material       a thin lossy material block, kappa = g / (R w t)

Usage (one simulation at a time; ~1-10 s each on a laptop):

    python lumped_resistor_test.py --kind lumped --R 100 --cells-g 4 --cells-w 4
    python lumped_resistor_test.py --kind port --R 50 --cell 0.125 --engine gpu   # openEMS GPU fork only
"""

import argparse
import os
import shutil
import tempfile

import numpy as np
from CSXCAD import ContinuousStructure
from openEMS import openEMS
from openEMS.physical_constants import C0

F_REPORT = [0.5e9, 1e9, 2e9, 2.4e9, 3e9, 4e9, 5e9, 6e9]


def run_fixture(kind, R, a, w, g, cells_w, cells_g, pad=25.0, f_max=6.5e9, engine=None, keep=None):
    """Build and run one fixture; return (f, Zin, dut_port_or_None, sim_dir)."""
    unit = 1e-3
    fdtd = openEMS(NrTS=100000, EndCriteria=1e-6)
    # DC-free Gaussian-derivative pulse, -20 dB at f_max (the modulated Gaussian leaves static charge
    # on the open fixture, and the run would never reach the end criterion)
    tau = 1.0 / (np.sqrt(2.0) * np.pi * (f_max / 2.76))
    t0 = 5 * tau
    fdtd.SetCustomExcite(f"-{np.sqrt(2 * np.e):.8f}*((t-{t0:.6e})/{tau:.6e})*exp(-((t-{t0:.6e})/{tau:.6e})^2)",
                         f_max, f_max)
    fdtd.SetBoundaryCond(["MUR"] * 6)
    csx = ContinuousStructure()
    fdtd.SetCSX(csx)
    mesh = csx.GetGrid()
    mesh.SetDeltaUnit(unit)

    t = a / 4 if kind == "material" else 0.0          # material block thickness along x
    plate = csx.AddMetal("plates")
    plate.AddBox([0, -w / 2, 0], [a + t, w / 2, 0], priority=10)
    plate.AddBox([0, -w / 2, g], [a + t, w / 2, g], priority=10)

    port = fdtd.AddLumpedPort(1, 50, [0, -w / 2, 0], [0, w / 2, g], "z", 1.0, priority=5)
    dut_port = None
    box = ([a, -w / 2, 0], [a, w / 2, g])
    if kind in ("lumped", "lumped-nocaps"):
        el = csx.AddLumpedElement("dut", ny=2, caps=(kind == "lumped"), R=R)
        el.AddBox(*box, priority=5)
    elif kind == "port":
        dut_port = fdtd.AddLumpedPort(2, R, box[0], box[1], "z", 0.0, priority=5)
    elif kind == "material":
        kappa = (g * unit) / (R * (w * unit) * (t * unit))
        csx.AddMaterial("dut", kappa=kappa).AddBox([a, -w / 2, 0], [a + t, w / 2, g], priority=5)
    elif kind == "short":
        csx.AddMetal("dut").AddBox(*box, priority=5)
    elif kind != "open":
        raise ValueError(kind)

    # mesh: uniform fixture cells (cells_w across w, cells_g across g, same size along x), graded out
    dw, dg = w / cells_w, g / cells_g
    dx = min(dw, dg)
    xs = np.r_[np.arange(0, a + t + 1e-9, dx), a, a + t]
    mesh.AddLine("x", np.r_[-pad, xs, a + t + pad])
    mesh.AddLine("y", np.r_[-pad - w / 2, np.linspace(-w / 2, w / 2, cells_w + 1), w / 2 + pad])
    mesh.AddLine("z", np.r_[-pad, np.linspace(0, g, cells_g + 1), g + pad])
    mesh.SmoothMeshLines("all", C0 / f_max / unit / 20, 1.3)

    sim_dir = keep or tempfile.mkdtemp(prefix=f"lumped-{kind}-")
    kw = {"engine": engine} if engine else {}
    cwd = os.getcwd()
    try:
        fdtd.Run(sim_dir, cleanup=True, verbose=0, **kw)
    finally:
        os.chdir(cwd)
    f = np.linspace(0.2e9, 6e9, 581)
    port.CalcPort(sim_dir, f)
    zin = port.uf_tot / port.if_tot
    z_dut_direct = None
    if dut_port is not None:
        dut_port.CalcPort(sim_dir, f)
        z_dut_direct = -dut_port.uf_tot / dut_port.if_tot   # current probe points into the structure
    if keep is None:
        shutil.rmtree(sim_dir, ignore_errors=True)
    return f, zin, z_dut_direct


def deembed(z_m, z_open, z_short):
    y_m = 1 / z_m - 1 / z_open
    y_s = 1 / z_short - 1 / z_open
    return 1 / y_m - 1 / y_s


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--kind", default="lumped", choices=["lumped", "lumped-nocaps", "port", "material"])
    ap.add_argument("--R", type=float, default=100.0, help="DUT resistance, ohm")
    ap.add_argument("--a", type=float, default=1.0, help="plate length (port to DUT), mm")
    ap.add_argument("--w", type=float, default=1.0, help="plate / DUT width, mm")
    ap.add_argument("--g", type=float, default=1.0, help="gap (DUT length along the current), mm")
    ap.add_argument("--cells-w", type=int, default=4, help="cells across the DUT width")
    ap.add_argument("--cells-g", type=int, default=4, help="cells along the DUT (current direction)")
    ap.add_argument("--engine", default=None, help="'gpu' for the openEMS GPU fork (optional)")
    args = ap.parse_args()

    geo = dict(a=args.a, w=args.w, g=args.g, cells_w=args.cells_w, cells_g=args.cells_g, engine=args.engine)
    f, z_open, _ = run_fixture("open", 0, **geo)
    _, z_short, _ = run_fixture("short", 0, **geo)
    _, z_m, z_direct = run_fixture(args.kind, args.R, **geo)
    z = deembed(z_m, z_open, z_short)
    print(f"DUT {args.kind}, R = {args.R:g} ohm, gap {args.g} mm x width {args.w} mm, "
          f"{args.cells_g} cells along x {args.cells_w} across")
    print("   f/GHz   Re Z_dut   Im Z_dut   Re/R" + ("   -U/I at DUT port" if z_direct is not None else ""))
    for fr in F_REPORT:
        k = int(np.argmin(np.abs(f - fr)))
        line = f"  {f[k] / 1e9:6.2f}  {z[k].real:9.2f}  {z[k].imag:9.2f}  {z[k].real / args.R:6.3f}"
        if z_direct is not None:
            line += f"   {z_direct[k].real:7.2f}{z_direct[k].imag:+7.2f}j"
        print(line)


if __name__ == "__main__":
    main()
