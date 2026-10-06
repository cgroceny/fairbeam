r"""Explicit stripline FDTD comparison; ordinary discovery is pure.

python -m tests.test_stripline_fixture --fdtd --out C:\Temp\stripline-study
Twelve serial cases, three meshes, four threads, 30-minute owned case limit.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import numpy as np

from tests import stripline_fixture as fixture
from fairbeam.procutil import popen_group, release_group, terminate_group


def acquire_serial(out, mesh, kind, width_ratio=fixture.WIDTH_RATIO,
                   eps_r=fixture.EPS_R, geometry_thickness=fixture.COPPER_T, loss_region="both"):
    out = Path(out).resolve()
    if out.exists():
        raise ValueError(f"acquisition directory exists: {out}")
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable,"-m","tests.test_stripline_fixture","--fdtd","--mesh",str(mesh),
        "--kind",kind,"--width-ratio",str(width_ratio),"--eps-r",str(eps_r),
        "--geometry-thickness",str(geometry_thickness),"--out",str(out),"--worker-case"]
    if loss_region != "both":
        command.extend(["--loss-region",loss_region])
    with out.with_name(out.name+".log").open("w",encoding="utf-8") as log:
        process = popen_group(command,stdout=log,stderr=subprocess.STDOUT,
            cwd=Path(__file__).resolve().parents[1],
            env={**os.environ,"OPENBLAS_NUM_THREADS":"1","OMP_NUM_THREADS":"1"})
        try:
            try:
                code = process.wait(timeout=1800)
            except subprocess.TimeoutExpired:
                terminate_group(process.pid,grace=0,job=process.win_job)
                process.wait(timeout=15)
                raise RuntimeError(f"30-minute case limit; incomplete data retained: {out}") from None
        finally:
            if process.poll() is None:
                terminate_group(process.pid,grace=0,job=process.win_job)
                process.wait(timeout=15)
            release_group(process)
    if code:
        raise RuntimeError(f"acquisition failed; see {out.name}.log")
    return json.loads((out/"report.json").read_text(encoding="utf-8"))


def loss_control(out,mesh,kind,width_ratio,eps_r,geometry_thickness,loss_region="both"):
    if loss_region == "both":
        return fixture.acquire(out,mesh,kind,width_ratio,eps_r,geometry_thickness)
    if kind != "copper-sheet" or loss_region not in ("strip","grounds"):
        raise ValueError("regional loss control requires a copper-sheet case")
    original = fixture.Simulation.metal
    def selected(sim,name,*args,**kw):
        if name in ("strip","grounds") and name != loss_region:
            kw["conductivity"] = None
        return original(sim,name,*args,**kw)
    # Only this isolated child's fixture constructor is changed; no core file,
    # gallery model or global state in another process is modified.
    with patch.object(fixture.Simulation,"metal",selected):
        meta = fixture.acquire(out,mesh,kind,width_ratio,eps_r,geometry_thickness)
    meta["kind"] = loss_region+"-only-control"
    meta["loss_region"] = loss_region
    import hashlib
    meta["control_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    (Path(out)/"report.json").write_text(json.dumps(meta,indent=2)+"\n",encoding="utf-8")
    return meta


class StriplineFixtureTests(unittest.TestCase):
    def test_elliptic_reference_against_independent_quadrature(self):
        nodes,weights = np.polynomial.legendre.leggauss(256)
        t = (nodes+1)/2
        theta = np.pi/2*(1-t**3)
        jacobian = 3*np.pi/2*t**2
        def integral(k):
            return np.sum(weights/2*jacobian/np.sqrt(1-k*k*np.sin(theta)**2))
        for ratio in (.25,.5,1.,2.,5.):
            u = np.pi*ratio/2
            expected = fixture.ETA0/(4*np.sqrt(2.55))*integral(1/np.cosh(u))/integral(np.tanh(u))
            self.assertAlmostEqual(fixture.impedance(ratio,2.55)/expected,1.,places=8)
        self.assertAlmostEqual(fixture.B*fixture.WIDTH_RATIO,2.6554777631342783)

    def test_reflected_line_inversion_retains_signed_loss_and_complex_impedance(self):
        dx = .0005
        for loss in (.1,-.01):
            g = loss+1j*np.linspace(300.,320.,41)
            z = np.full(41,50.+.2j)
            reflection = .15j
            def voltage(x):
                return np.exp(-g*x)+reflection*np.exp(g*x)
            def current(x):
                return (np.exp(-g*x)-reflection*np.exp(g*x))/z
            centres = np.arange(24,45,4)*1e-3
            v = np.asarray([[voltage(x+d) for d in (-dx,0,dx)] for x in centres])
            i = np.asarray([[current(x+d) for d in (-dx/2,dx/2)] for x in centres])
            local,z_measured = fixture.extract(v,i,dx)
            np.testing.assert_allclose(local,np.broadcast_to(g,local.shape),rtol=1e-12,atol=1e-10)
            np.testing.assert_allclose(z_measured,np.broadcast_to(z,z_measured.shape),rtol=1e-12)
            triplets = fixture.propagation(v)
            np.testing.assert_allclose(triplets,np.broadcast_to(g,triplets.shape),atol=1e-10)

    def test_independent_static_reference_converges_and_recovers_thin_limit(self):
        for thickness in (0.,fixture.COPPER_T):
            records = [fixture.capacitance_reference(n,thickness=thickness) for n in (64,128,256)]
            impedances = np.array([r["z0_ohm"] for r in records])
            self.assertTrue(np.all(abs(np.diff(impedances)/impedances[1:])<.0005))
            self.assertTrue(all(r["residual_rel"]<1e-11 for r in records))
            if thickness == 0:
                self.assertLess(abs(impedances[-1]/fixture.impedance(fixture.WIDTH_RATIO,fixture.EPS_R)-1),.001)

    def test_probe_and_geometry_alignment_with_balanced_feed(self):
        for n in (8,12,16):
            sim = fixture.build(n)
            y,z = sim.mesh.GetLines("y"),sim.mesh.GetLines("z")
            for edge in (-fixture.B*fixture.WIDTH_RATIO/2,fixture.B*fixture.WIDTH_RATIO/2):
                self.assertIn(edge,y)
            for height in (-fixture.B/2,-fixture.COPPER_T/2,fixture.COPPER_T/2,fixture.B/2):
                self.assertIn(height,z)
            self.assertEqual(sim.ports[0]["group"]["connection"],"parallel")
            self.assertEqual(sim.ports[0]["group"]["members"][0]["polarity"],-1)
            for x in (24,28,32,36,40,44):
                self.assertIn(x,sim.mesh.GetLines("x"))
            self.assertLess(int(np.prod([len(sim.mesh.GetLines(a))-1 for a in "xyz"])),4_000_000)
        for args in ((7,"pec"),(8,"invalid")):
            with self.assertRaises(ValueError):
                fixture.build(*args)
        with self.assertRaises(ValueError):
            fixture.build(8,geometry_thickness=-.01)

    def test_standing_wave_nodes_and_singular_data_are_rejected(self):
        with self.assertRaisesRegex(ValueError,"singular"):
            fixture.propagation(np.zeros((6,3,41),complex))
        v = np.ones((6,3,41),complex)
        v[2,1,:] = 0
        with self.assertRaisesRegex(ValueError,"node"):
            fixture.propagation(v)
        with self.assertRaisesRegex(ValueError,"matching"):
            fixture.extract(np.ones((6,2,41)),np.ones((6,2,41)),.001)

    def synthetic(self,root,*,failed_coarse=False,conductor_scale=1):
        for kind in fixture.KINDS:
            g,z = fixture.targets(kind)
            if kind == "copper-sheet":
                g = conductor_scale*g.real+1j*g.imag
            for n in (8,12,16):
                dest = root/kind/f"n{n}"
                dest.mkdir(parents=True)
                np.savez(dest/"data.npz",f=fixture.FREQUENCIES,
                         gamma=np.tile(g,(2,1)),z=np.tile(z,(6,1)))
                meta = {"resolution":n,"kind":kind,"width_ratio":fixture.WIDTH_RATIO,"eps_r":fixture.EPS_R,
                    "geometry_thickness_mm":fixture.COPPER_T,"a_over_b":100,
                    "fixture_sha256":"synthetic-test","cells":100,"dt_s":1e-12,
                    "run":{"threads":4,"converged":not(failed_coarse and n==8),
                           "exact_endcriteria":True,"final_energy_bound_db":-70}}
                (dest/"report.json").write_text(json.dumps(meta),encoding="utf-8")

    def test_matching_meshes_with_failed_coarse_energy_cannot_be_accepted(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.synthetic(root,failed_coarse=True)
            rows = fixture.analyse(root,[8,12,16])
            self.assertTrue(all(r["metrics"]["beta"]["matches"] for r in rows))
            self.assertFalse(any(any(r["accepted_scope"].values()) for r in rows))

    def test_terminal_energy_sample_is_also_a_valid_stop_record(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.synthetic(root)
            for path in root.glob("*/*/report.json"):
                meta = json.loads(path.read_text(encoding="utf-8"))
                meta["run"].pop("final_energy_bound_db")
                meta["run"]["final_energy_db"] = -70.1
                path.write_text(json.dumps(meta),encoding="utf-8")
            rows = fixture.analyse(root,[8,12,16])
            self.assertTrue(rows[2]["accepted_scope"]["beta"] and rows[2]["accepted_scope"]["z"])
            self.assertTrue(rows[5]["accepted_scope"]["alpha"])

    def test_matching_total_loss_cannot_hide_a_failed_conductor_component(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.synthetic(root,conductor_scale=1.3)
            rows = fixture.analyse(root,[8,12,16])
            both = rows[-1]
            self.assertTrue(both["metrics"]["alpha"]["matches"])
            self.assertFalse(both["accepted_scope"]["alpha"])

    def test_regional_control_cannot_replace_the_full_conductor_case(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.synthetic(root)
            path = root/"copper-sheet/n16/report.json"
            meta = json.loads(path.read_text(encoding="utf-8"))
            meta["kind"] = "strip-only-control"
            path.write_text(json.dumps(meta),encoding="utf-8")
            with self.assertRaisesRegex(ValueError,"identity"):
                fixture.analyse(root,[8,12,16])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fdtd",action="store_true")
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--meshes",default="8,12,16")
    parser.add_argument("--mesh",type=int)
    parser.add_argument("--kind",choices=fixture.KINDS)
    parser.add_argument("--width-ratio",type=float,default=fixture.WIDTH_RATIO)
    parser.add_argument("--eps-r",type=float,default=fixture.EPS_R)
    parser.add_argument("--geometry-thickness",type=float,default=fixture.COPPER_T)
    parser.add_argument("--loss-region",choices=("both","strip","grounds"),default="both")
    parser.add_argument("--analyse-only",action="store_true")
    parser.add_argument("--worker-case",action="store_true",help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.mesh is not None or args.kind is not None:
        if args.mesh is None or args.kind is None or not args.fdtd or args.analyse_only:
            parser.error("one case requires --fdtd --mesh --kind")
        if args.loss_region != "both" and args.kind != "copper-sheet":
            parser.error("regional control requires --kind copper-sheet")
        run = loss_control if args.worker_case else acquire_serial
        meta = run(args.out,args.mesh,args.kind,args.width_ratio,args.eps_r,args.geometry_thickness,args.loss_region)
        print(json.dumps({k:v for k,v in meta.items() if k != "run"} | {
            "energy_stopped":meta["run"].get("converged"),"seconds":meta["run"].get("wall_time_s")},indent=2))
        return
    if (args.worker_case or args.width_ratio != fixture.WIDTH_RATIO or args.eps_r != fixture.EPS_R
            or args.geometry_thickness != fixture.COPPER_T or args.loss_region != "both"):
        parser.error("custom geometry or worker flag requires one case")
    meshes = [int(v) for v in args.meshes.split(",")]
    if len(meshes)<3 or meshes!=sorted(set(meshes)) or any(n<8 or n>32 or n%4 for n in meshes):
        parser.error("three increasing multiples of four in 8..32")
    if not args.analyse_only:
        if not args.fdtd:
            parser.error("explicit --fdtd required")
        for kind in fixture.KINDS:
            for n in meshes:
                meta = acquire_serial(args.out/kind/f"n{n}",n,kind)
                print(json.dumps({"kind":kind,"mesh":n,"energy_stopped":meta["run"].get("converged"),
                                  "seconds":meta["run"].get("wall_time_s")}),flush=True)
    print(json.dumps(fixture.analyse(args.out,meshes),indent=2))


if __name__ == "__main__":
    unittest.main() if len(sys.argv)==1 else main()
