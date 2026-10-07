r"""Example 3.6 (p. 146): physical PEC impedance versus a uniform-charge approximation.

python -m tests.test_stripline_capacitance --fdtd --out C:\Temp\stripline-widths
Ordinary discovery is pure; the explicit sweep is serial, four threads/case.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from tests import stripline_fixture as fixture
from fairbeam.procutil import popen_group, release_group, terminate_group

WIDTHS, EPS_R, TERMS = (.25, .5, 1., 2., 5.), 2.55, (4096, 8192, 16384)
F0 = 1e9  # Reduce the observed wide-strip higher-mode contamination.
FREQUENCIES = np.linspace(.99*F0,1.01*F0,41)
GRADES = (1.3,1.2,1.1)


def mesh_control(grading):
    """Optional transverse refinement, preserving the physical metal edges.

    The default reuses the parent functions exactly. Changing n alone makes
    the smallest edge cell finer but leaves much of the outer fringing grid
    almost unchanged; the separate grading sweep addresses that error floor.
    """
    if grading not in GRADES:
        raise ValueError("grading must be 1.3, 1.2 or 1.1")
    if grading == 1.3:
        return {}

    def segment(span,delta):
        count = int(np.ceil(np.log1p(span/delta*(grading-1))/np.log(grading)))
        first = span*(grading-1)/(grading**count-1)
        points = np.cumsum(first*grading**np.arange(count))
        points[-1] = span
        return points

    def transverse(n,width,finite):
        edge,delta = width/2,fixture.B/n/12
        end = edge if finite else edge-delta/3
        positive = list(np.r_[0.,(end-segment(end,delta))[-2::-1],end])
        positive.append(edge+delta if finite else edge+2*delta/3)
        step = delta
        while positive[-1]<50*fixture.B:
            step *= grading
            positive.append(min(positive[-1]+step,50*fixture.B))
        return np.r_[-np.asarray(positive[:0:-1]),positive]

    return {"graded_segment":segment,"transverse_lines":transverse}


def acquire_one(out,n,width,grading=1.3):
    sha = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    # Restore all parent globals after this isolated research acquisition.
    with patch.multiple(fixture,F0=F0,FREQUENCIES=FREQUENCIES,**mesh_control(grading)):
        meta = fixture.acquire(out,n,"pec",width,EPS_R,0.)
    meta["frequency_center_hz"],meta["study_sha256"] = F0,sha
    meta["grading_ratio"] = grading
    (Path(out)/"report.json").write_text(json.dumps(meta,indent=2)+"\n",encoding="utf-8")
    return meta


def acquire_serial(out,n,width,grading=1.3):
    mesh_control(grading)  # Reject invalid controls before allocating a worker.
    out = Path(out).resolve()
    if out.exists():
        raise ValueError(f"acquisition directory exists: {out}")
    out.parent.mkdir(parents=True,exist_ok=True)
    command = [sys.executable,"-m","tests.test_stripline_capacitance","--fdtd","--worker-case",
        "--mesh",str(n),"--width-ratio",str(width),"--grading",str(grading),"--out",str(out)]
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


def uniform_charge_z(width_ratio, terms, eps_r=EPS_R):
    """Own modal energy calculation with b=1, a=100 and total charge Q=1.

    Odd cosine modes k=(2n+1)pi/a satisfy the grounded sidewalls. The sheet
    source coefficient is 4 sin(kw/2)/(awk). Grounded planes give potential
    coefficient rho_k*tanh(kb/2)/(2 epsilon k). Average potential over the
    uniformly charged strip, then Z0=V_average/(Q*v). This trial charge is
    not the equilibrium edge charge and is not a physical-impedance target.
    """
    fixture.impedance(width_ratio,eps_r)
    if isinstance(terms,bool) or terms != int(terms) or not 32 <= terms <= 262144:
        raise ValueError("32..262144 integer modal terms required")
    k = (2*np.arange(int(terms))+1)*np.pi/100
    energy = np.sum(np.sin(k*width_ratio/2)**2*np.tanh(k/2)/k**3)
    return float(fixture.ETA0/np.sqrt(eps_r)*4/(100*width_ratio**2)*energy)


def location(root,width,n,grading=None):
    leaf = f"n{n}" if grading is None else "r"+str(grading).replace(".","p")
    return Path(root)/("w"+str(width).replace(".","p"))/leaf


def analyse(root,meshes,grading_sweep=False):
    """Qualify one mesh axis, not an arbitrary mixture of acquired controls.

    Run both the n refinement and the separate transverse grading family
    before reporting physical impedance convergence. Each family must have
    one source fingerprint; original default-grading records remain readable.
    """
    if grading_sweep:
        if meshes != [8]:
            raise ValueError("grading sweep requires fixed n=8")
        settings = [(8,r) for r in GRADES]
    else:
        if len(meshes)<3 or meshes != sorted(set(meshes)):
            raise ValueError("three increasing mesh levels required")
        settings = [(n,1.3) for n in meshes]
    rows, fingerprint = [], None
    target_beta = 2*np.pi*FREQUENCIES/fixture.C0*np.sqrt(EPS_R)
    for width in WIDTHS:
        group, previous = [], None
        exact = fixture.impedance(width,EPS_R)
        corrected_width = width-max(.35-width,0)**2
        design_approx = 30*np.pi/(np.sqrt(EPS_R)*(corrected_width+.441))
        uniform = [uniform_charge_z(width,n) for n in TERMS]
        for n,grading in settings:
            dest = location(root,width,n,grading if grading_sweep else None)
            meta = json.loads((dest/"report.json").read_text(encoding="utf-8"))
            identity = (meta["resolution"],meta["kind"],meta["width_ratio"],meta["eps_r"],
                meta["geometry_thickness_mm"],meta["a_over_b"],meta["run"].get("threads"),
                meta.get("frequency_center_hz"),meta.get("grading_ratio",1.3))
            if identity != (n,"pec",width,EPS_R,0.,100,4,F0,grading):
                raise ValueError("PEC zero-thickness sweep identity differs")
            sha = (meta.get("fixture_sha256"),meta.get("study_sha256"))
            if not all(sha) or (fingerprint is not None and sha != fingerprint):
                raise ValueError("acquisitions must share one source fingerprint")
            fingerprint = sha
            with np.load(dest/"data.npz") as data:
                np.testing.assert_array_equal(data["f"],FREQUENCIES)
                z,gamma = data["z"].copy(),data["gamma"].copy()
            if z.shape!=(6,41) or gamma.shape!=(2,41) or np.any(~np.isfinite(z)) or np.any(~np.isfinite(gamma)):
                raise ValueError("invalid impedance or propagation spectra")
            values, expected = {"z":z,"beta":gamma.imag},{"z":exact,"beta":target_beta}
            metrics = {}
            for key,value in values.items():
                target,mesh_limit,spread_limit = fixture.LIMITS[key]
                error = float(np.max(abs(value/expected[key]-1)))
                spread = float(np.max(abs(value-np.mean(value,axis=0))/abs(expected[key])))
                change = None if previous is None else float(np.max(abs(value-previous[key])/abs(expected[key])))
                metrics[key] = {"target_rel_max":error,"spread_rel_max":spread,"mesh_rel_max":change,
                    "matches":error<=target and spread<=spread_limit,
                    "mesh_pair_passes":change is not None and change<=mesh_limit}
            run = meta["run"]
            stopped = bool(run.get("converged") and run.get("exact_endcriteria")
                and not run.get("hit_timestep_limit",False)
                and run.get("final_energy_db",run.get("final_energy_bound_db",0))<=-70)
            group.append({"width_ratio":width,"resolution":n,"exact_z_ohm":exact,
                "grading_ratio":grading,"mesh_axis":"transverse-grading" if grading_sweep else "edge-and-axial",
                "design_approx_z_ohm":float(design_approx),
                "uniform_charge_z_ohm":uniform,"uniform_charge_error_rel":uniform[-1]/exact-1,
                "z_mid":[float(np.mean(z[:,20]).real),float(np.mean(z[:,20]).imag)],
                "beta_mid":float(np.mean(gamma.imag[:,20])),"raw_alpha_mid":gamma.real[:,20].tolist(),
                "cells":meta["cells"],"dt_ps":meta["dt_s"]*1e12,"energy_stopped":stopped,
                "metrics":metrics,"accepted_scope":{"z":False,"beta":False}})
            previous = values
        for index,row in enumerate(group):
            if index<2:
                continue
            for key in row["metrics"]:
                row["accepted_scope"][key] = bool(all(r["energy_stopped"] for r in group[index-2:index+1])
                    and all(r["metrics"][key]["matches"] and r["metrics"][key]["mesh_pair_passes"]
                        for r in group[index-1:index+1]))
        rows.extend(group)
    (Path(root)/"comparison.json").write_text(json.dumps(rows,indent=2)+"\n",encoding="utf-8")
    return rows


class StriplineCapacitanceTests(unittest.TestCase):
    def test_modal_trial_charge_against_independent_green_function_integral(self):
        nodes,weights = np.polynomial.legendre.leggauss(256)
        t = (nodes+1)/2
        for width in WIDTHS:
            # Infinite-sidewall Green function at the center of two grounded
            # planes: log(coth(pi*distance/(2b)))/(2*pi*epsilon).
            # At a/b=100, sidewall corrections are exponentially small.
            distance = width*t**4
            integral = np.sum(weights/2*4*width*t**3*(width-distance)
                *np.log(1/np.tanh(np.pi*distance/2)))
            independent = fixture.ETA0/np.sqrt(EPS_R)/(np.pi*width**2)*integral
            np.testing.assert_allclose(uniform_charge_z(width,131072),independent,rtol=2e-7)
            estimates = [uniform_charge_z(width,n) for n in TERMS]
            self.assertTrue(np.all(abs(np.diff(estimates)/estimates[1:])<1e-4))
            self.assertGreater(estimates[-1],fixture.impedance(width,EPS_R))
        for n in (True,1,32.5,262145):
            with self.assertRaises(ValueError):
                uniform_charge_z(1.,n)

    def test_thin_geometry_retains_the_balanced_feed_and_thirds_edges(self):
        for width in (.25,5.):
            sim = fixture.build(8,"pec",width,EPS_R,0.)
            self.assertIn(0.,sim.mesh.GetLines("z"))
            edge = width*fixture.B/2
            lines = sim.mesh.GetLines("y")
            self.assertNotIn(edge,lines)
            self.assertLess(max(lines[lines<edge]),edge)
            self.assertGreater(min(lines[lines>edge]),edge)
            self.assertEqual(sim.ports[0]["group"]["connection"],"parallel")
            self.assertEqual(sim.ports[0]["group"]["members"][0]["polarity"],-1)

    def synthetic(self,root,*,trial_charge=False,failed_coarse=False,grading_sweep=False):
        beta = 2*np.pi*FREQUENCIES/fixture.C0*np.sqrt(EPS_R)
        for width in WIDTHS:
            z = uniform_charge_z(width,TERMS[-1]) if trial_charge else fixture.impedance(width,EPS_R)
            settings = [(8,r) for r in GRADES] if grading_sweep else [(n,1.3) for n in (8,12,16)]
            for n,grading in settings:
                dest = location(root,width,n,grading if grading_sweep else None)
                dest.mkdir(parents=True)
                np.savez(dest/"data.npz",f=FREQUENCIES,
                    z=np.full((6,41),z,dtype=complex),gamma=np.tile(1j*beta,(2,1)))
                meta = {"resolution":n,"kind":"pec","width_ratio":width,"eps_r":EPS_R,
                    "geometry_thickness_mm":0.,"a_over_b":100,"cells":1000,"dt_s":1e-13,
                    "fixture_sha256":"synthetic","study_sha256":"synthetic-study","frequency_center_hz":F0,
                    "grading_ratio":grading,
                    "run":{"threads":4,"converged":not(failed_coarse and n==8),
                        "exact_endcriteria":True,"final_energy_bound_db":-70.1}}
                (dest/"report.json").write_text(json.dumps(meta),encoding="utf-8")

    def test_stable_uniform_charge_value_cannot_validate_physical_impedance(self):
        with tempfile.TemporaryDirectory() as folder:
            self.synthetic(folder,trial_charge=True)
            rows = analyse(folder,[8,12,16])
            self.assertTrue(all(r["accepted_scope"]["beta"] for r in rows[2::3]))
            self.assertTrue(all(not r["accepted_scope"]["z"] for r in rows[2::3]))

    def test_failed_stop_or_changed_geometry_cannot_enter_acceptance(self):
        with tempfile.TemporaryDirectory() as folder:
            self.synthetic(folder,failed_coarse=True)
            rows = analyse(folder,[8,12,16])
            self.assertTrue(all(not any(r["accepted_scope"].values()) for r in rows))
            path = location(folder,.25,16)/"report.json"
            meta = json.loads(path.read_text(encoding="utf-8"))
            meta["geometry_thickness_mm"] = .01
            path.write_text(json.dumps(meta),encoding="utf-8")
            with self.assertRaisesRegex(ValueError,"identity"):
                analyse(folder,[8,12,16])

    def test_frequency_patch_is_restored_and_a_different_protocol_is_rejected(self):
        old_f0,old_frequencies = fixture.F0,fixture.FREQUENCIES
        def fake(out,n,kind,width,eps,thickness):
            self.assertEqual(fixture.F0,1e9)
            np.testing.assert_array_equal(fixture.FREQUENCIES,FREQUENCIES)
            return {"kind":kind}
        with tempfile.TemporaryDirectory() as folder,patch.object(fixture,"acquire",fake):
            acquire_one(folder,8,.25)
        self.assertEqual(fixture.F0,old_f0)
        self.assertIs(fixture.FREQUENCIES,old_frequencies)
        with tempfile.TemporaryDirectory() as folder:
            self.synthetic(folder)
            path = location(folder,5.,8)/"report.json"
            meta = json.loads(path.read_text(encoding="utf-8"))
            meta["frequency_center_hz"] = 10e9
            path.write_text(json.dumps(meta),encoding="utf-8")
            with self.assertRaisesRegex(ValueError,"identity"):
                analyse(folder,[8,12,16])

    def test_global_grading_refines_fringing_and_restores_parent_mesh_functions(self):
        old_segment,old_transverse = fixture.graded_segment,fixture.transverse_lines
        self.assertEqual(mesh_control(1.3),{})
        for width in (.25,5.):
            grids = []
            for grading in GRADES:
                with patch.multiple(fixture,F0=F0,FREQUENCIES=FREQUENCIES,**mesh_control(grading)):
                    sim = fixture.build(8,"pec",width,EPS_R,0.)
                    grids.append([sim.mesh.GetLines(a).copy() for a in "xyz"])
            for grid in grids[1:]:
                np.testing.assert_array_equal(grid[0],grids[0][0])
                self.assertEqual(grid[1][0],grids[0][1][0])
                self.assertEqual(grid[1][-1],grids[0][1][-1])
                self.assertIn(0.,grid[2])
                self.assertIn(fixture.B/2,grid[2])
                edge,delta = fixture.B*width/2,fixture.B/8/12
                self.assertAlmostEqual(min(grid[1][grid[1]>edge]),edge+2*delta/3)
                self.assertAlmostEqual(max(grid[1][grid[1]<edge]),edge-delta/3)
            max_z = [max(np.diff(z[abs(z)<=fixture.B/2])) for _,_,z in grids]
            self.assertTrue(np.all(np.diff(max_z)<0))
        self.assertIs(fixture.graded_segment,old_segment)
        self.assertIs(fixture.transverse_lines,old_transverse)
        for grading in (True,1.,1.09,1.31,float("nan")):
            with self.assertRaises(ValueError):
                mesh_control(grading)

    def test_grading_sweep_cannot_mix_mesh_identities_or_source_versions(self):
        with tempfile.TemporaryDirectory() as folder:
            self.synthetic(folder,grading_sweep=True)
            rows = analyse(folder,[8],grading_sweep=True)
            self.assertTrue(all(all(r["accepted_scope"].values()) for r in rows[2::3]))
            path = location(folder,.25,8,1.2)/"report.json"
            meta = json.loads(path.read_text(encoding="utf-8"))
            meta["grading_ratio"] = 1.3
            path.write_text(json.dumps(meta),encoding="utf-8")
            with self.assertRaisesRegex(ValueError,"identity"):
                analyse(folder,[8],grading_sweep=True)
            meta["grading_ratio"],meta["study_sha256"] = 1.2,"different-source"
            path.write_text(json.dumps(meta),encoding="utf-8")
            with self.assertRaisesRegex(ValueError,"fingerprint"):
                analyse(folder,[8],grading_sweep=True)
        with self.assertRaisesRegex(ValueError,"fixed n=8"):
            analyse("unused",[8,12,16],grading_sweep=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fdtd",action="store_true")
    parser.add_argument("--analyse-only",action="store_true")
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--meshes",default="8,12,16")
    parser.add_argument("--mesh",type=int,choices=range(8,33,4))
    parser.add_argument("--width-ratio",type=float,choices=WIDTHS)
    parser.add_argument("--grading",type=float,choices=GRADES,default=1.3,help="single-case transverse grading")
    parser.add_argument("--grading-sweep",action="store_true",help="separate n=8 family: 1.3, 1.2, 1.1")
    parser.add_argument("--worker-case",action="store_true",help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.mesh is not None or args.width_ratio is not None:
        if args.mesh is None or args.width_ratio is None or not args.fdtd or args.analyse_only or args.grading_sweep:
            parser.error("one case requires --fdtd --mesh --width-ratio")
        run = acquire_one if args.worker_case else acquire_serial
        print(json.dumps(run(args.out,args.mesh,args.width_ratio,args.grading),indent=2))
        return
    if args.worker_case:
        parser.error("worker flag requires one case")
    if args.grading != 1.3:
        parser.error("--grading applies to one case; use --grading-sweep for the comparison")
    meshes = [8] if args.grading_sweep else [int(n) for n in args.meshes.split(",")]
    if not args.grading_sweep and (len(meshes)<3 or meshes!=sorted(set(meshes)) or any(n<8 or n>32 or n%4 for n in meshes)):
        parser.error("three increasing multiples of four in 8..32")
    if not args.analyse_only:
        if not args.fdtd:
            parser.error("explicit --fdtd required")
        for width in WIDTHS:
            settings = [(8,r) for r in GRADES] if args.grading_sweep else [(n,1.3) for n in meshes]
            for n,grading in settings:
                meta = acquire_serial(location(args.out,width,n,grading if args.grading_sweep else None),n,width,grading)
                print(json.dumps({"width_ratio":width,"mesh":n,"energy_stopped":meta["run"].get("converged"),
                    "grading":grading,"seconds":meta["run"].get("wall_time_s")}),flush=True)
    print(json.dumps(analyse(args.out,meshes,grading_sweep=args.grading_sweep),indent=2))


if __name__ == "__main__":
    unittest.main() if len(sys.argv)==1 else main()
