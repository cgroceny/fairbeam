"""Pure controls and explicit serial FDTD; outputs must be fresh and outside Git.

From python/, with the bundled runtime:
python -m tests.test_branchline_fixture --preflight --rate-mcps 40 --out C:\\study\\hybrid-plan
python -m tests.test_branchline_fixture --fdtd --mesh 4 --rate-mcps 40 --out C:\\study\\hybrid\\n4
python -m tests.test_branchline_fixture --study --out C:\\study\\hybrid
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import numpy as np

from fairbeam.procutil import popen_group, release_group, terminate_group
from tests import branchline_fixture as f
from tests.test_coax_resonator import wait_owned


def forecast(meta,rate):
    if isinstance(rate,bool) or not np.isfinite(rate) or rate<=0:
        raise ValueError("positive finite conservative throughput required")
    return 20+1.15*meta["native_cells"]*meta["max_timesteps"]/(rate*1e6)


def audit_header(text,meta):
    if re.search(r"forced timestep:.*larger than calculated timestep",text):
        raise ValueError("native stability bound exceeded")
    grid=re.search(r"FDTD simulation size: (\d+)x(\d+)x(\d+) --> (\d+) FDTD cells",text)
    interval=re.search(r"Exact-endcriteria: evaluating the end criteria every (\d+) timestep",text)
    pulse=re.search(r"Excitation signal length is: (\d+) timesteps",text)
    if ("openEMS 64bit -- version v0.37.0-rc3" not in text or not grid or not interval or not pulse
            or f"fixed number of threads: {f.THREADS}" not in text):
        raise ValueError("complete native runtime/grid/clock/source header required")
    if list(map(int,grid.groups()[:3]))!=meta["native_lines"] or int(grid[4])!=meta["native_cells"]:
        raise ValueError("native grid differs from preflight")
    if int(interval[1])!=int(1/(2*meta["f_max_hz"]*meta["native"]["dt_s"])):
        raise ValueError("native sampling clock differs from preflight")
    # A native custom waveform allocates the full declared time window;
    # physical pulse completion is checked separately using dgauss_duration_s.
    if int(pulse[1])!=meta["max_timesteps"]:
        raise ValueError("native custom-source length differs from declared window")
    return dict(version="v0.37.0-rc3",threads=f.THREADS,nyquist_interval=int(interval[1]),
                excitation_timesteps=int(pulse[1]))


def acquire_serial(out,n,rate=10.,**options):
    out=Path(out).resolve()
    if out.exists():
        raise ValueError("fresh output directory required")
    _,meta=f.build(n,1,**options)
    estimate=forecast(meta,rate)
    if estimate>1800:
        raise ValueError(f"forecast {estimate/60:.2f} min per port exceeds 30; defer before launch")
    out.mkdir(parents=True)
    source,runtime=f.identity(),f.runtime_identity()
    progress=dict(status="prepared",options=options,n=n,source_sha256=source,runtime=runtime,
        limits=f.LIMITS,estimated_seconds_per_port=estimate,rate_assumption_mcps=rate,ports=[])
    f.save(out/"progress.json",progress)
    for port in range(1,5 if meta["kind"]=="hybrid" else 3):
        if source!=f.identity() or runtime!=f.runtime_identity():
            raise RuntimeError("source/runtime changed between excitations")
        destination=out/f"port{port}"
        command=[sys.executable,"-m","tests.test_branchline_fixture","--fdtd","--worker-case",
                 "--mesh",str(n),"--port",str(port),"--out",str(destination)]
        for name,flag in (("kind","--kind"),("line_mm","--line-mm"),("feed","--feed-mm"),
                          ("padding","--padding-mm"),("end_db","--end-db"),("cap_s","--cap-ns"),
                          ("dt_factor","--dt-factor")):
            if name in options:
                value=options[name]*1e9 if name=="cap_s" else options[name]
                command += [flag,str(value)]
        log_path=out/f"port{port}.log"
        start,wall=time.monotonic(),time.time()
        code,failure=None,None
        with log_path.open("w",encoding="utf-8") as log:
            proc=popen_group(command,cwd=f.ROOT/"python",stdout=log,stderr=subprocess.STDOUT,
                env={**os.environ,"OMP_NUM_THREADS":str(f.THREADS),"OPENBLAS_NUM_THREADS":"1"})
            progress.update(status="running",active_port=port,active_launcher_pid=proc.pid)
            f.save(out/"progress.json",progress)
            try:
                code=wait_owned(proc,seconds=1800.)
            except BaseException as error:
                failure=repr(error)
                raise
            finally:
                if proc.poll() is None:
                    terminate_group(proc.pid,grace=0,job=proc.win_job)
                    proc.wait(timeout=15)
                release_group(proc)
                f.save(out/f"port{port}.worker.json",dict(command=command,pid=proc.pid,exit_code=code,
                    failure=failure,wall_seconds=time.time()-wall,monotonic_seconds=time.monotonic()-start,
                    deadline_seconds=1800.,estimated_seconds=estimate))
                if failure or code:
                    progress.update(status="failed",reason=failure or f"worker exit {code}",qualified=False,active_launcher_pid=None)
                    f.save(out/"progress.json",progress)
        if code:
            raise RuntimeError(f"native worker failed; preserve {log_path}")
        try:
            report=json.loads((destination/"report.json").read_text(encoding="utf-8"))
            report["native_header"]=audit_header(log_path.read_text(encoding="utf-8"),report)
            f.save(destination/"report.json",report)
            _,_,_,quality=f.read(destination)
        except BaseException as error:
            progress.update(status="rejected",reason=repr(error),qualified=False,active_launcher_pid=None)
            f.save(out/"progress.json",progress)
            raise
        progress["ports"].append(dict(port=port,quality=quality))
        if not all(quality.values()):
            progress.update(status="rejected",reason="native source/grid/clock/energy audit failed",qualified=False,active_launcher_pid=None)
            f.save(out/"progress.json",progress)
            raise ValueError("native audit failed; no next excitation")
        f.save(out/"progress.json",progress)
    _,result=f.matrix(out)
    progress.update(status="complete",active_port=None,active_launcher_pid=None,completed_utc=datetime.now(timezone.utc).isoformat())
    f.save(out/"progress.json",progress)
    return result


class BranchlineControls(unittest.TestCase):
    def test_center_frequency_matches_closed_form_quadrature_and_energy(self):
        s=f.reference([f.F0])[0]
        self.assertAlmostEqual(s[1,0],-1j/np.sqrt(2),places=14)
        self.assertAlmostEqual(s[2,0],-1/np.sqrt(2),places=14)
        self.assertLess(abs(s[0,0])+abs(s[3,0]),1e-15)
        all_s=f.reference()
        np.testing.assert_allclose(all_s@all_s.conj().transpose(0,2,1),np.broadcast_to(np.eye(4),all_s.shape),atol=2e-15)
        np.testing.assert_allclose(all_s,all_s.transpose(0,2,1),atol=2e-15)
        np.testing.assert_allclose(all_s,f.network.branchline_s(f.FREQUENCIES,f.F0),atol=2e-15)
        self.assertAlmostEqual(f.relative_phase(all_s)[100],90.,places=12)

    def test_fixed_dimensions_scale_and_exact_source_nodes(self):
        original=f.geometry()
        for n in f.MESHES:
            for port in range(1,5):
                sim,meta=f.build(n,port)
                self.assertEqual(meta["geometry"],original)
                self.assertEqual(meta["geometry"]["scale"],1.)
                self.assertEqual([p["number"] for p in sim.ports if p["excite"]],[port])
                for p in sim.ports:
                    self.assertIn(p["start"][0],meta["mesh_mm"]["x"])
                    self.assertAlmostEqual(p["stop"][1]-p["start"][1],original["w50_mm"],places=13)
                    for z in (p["start"][2],p["stop"][2]):
                        self.assertIn(z,meta["mesh_mm"]["z"])

    def test_thirds_brackets_cover_actual_metal_edges_without_sliver_cells(self):
        for n in f.MESHES:
            for kind in ("hybrid","line"):
                _,meta=f.build(n,1,kind=kind)
                width=meta["geometry"]["w50_mm"]
                center=meta["geometry"]["vertical_mm"]/2 if kind=="hybrid" else 0.
                for edge,sign in ((center-width/2,1),(center+width/2,-1)):
                    lines=np.array(meta["mesh_mm"]["y"])
                    inside=(lines-edge)*sign
                    delta=meta["edge_spacing_mm"]["y"]
                    self.assertAlmostEqual(inside[inside>0].min(),delta/3,places=12)
                    self.assertAlmostEqual(-inside[inside<0].max(),2*delta/3,places=12)
                    self.assertFalse(np.any(abs(lines-edge)<1e-12))
                for axis in "xyz":
                    lines=np.array(meta["mesh_mm"][axis])
                    self.assertGreater(np.diff(lines).min(),.05)
                    if axis!="z":
                        np.testing.assert_allclose(lines,-lines[::-1],atol=1e-12)

    def test_boundary_control_retains_every_interior_node_and_clock(self):
        for n in f.MESHES:
            _,a=f.build(n,1);_,b=f.build(n,1,padding=f.FAR_PAD)
            self.assertEqual(a["declared_dt_s"],b["declared_dt_s"])
            self.assertEqual(a["geometry"],b["geometry"])
            for axis in "xyz":
                old,new=np.array(a["mesh_mm"][axis]),np.array(b["mesh_mm"][axis])
                np.testing.assert_array_equal(new[(new>=old[0])&(new<=old[-1])],old)
                self.assertGreaterEqual(b["boundary_extension_actual_mm"][axis],8.)

    def test_clock_control_keeps_geometry_mesh_and_source_planes_fixed(self):
        for n in f.MESHES:
            _,ordinary=f.build(n,1)
            _,control=f.build(n,1,dt_factor=f.CONTROL_DT_FACTOR)
            for key in ("geometry","ports","mesh_mm","native_cells","cap_s","end_db"):
                self.assertEqual(ordinary[key],control[key])
            self.assertAlmostEqual(control["declared_dt_s"]/ordinary["declared_dt_s"],
                                   f.CONTROL_DT_FACTOR/f.DT_FACTOR,places=14)
            self.assertGreater(control["max_timesteps"],ordinary["max_timesteps"])

    def test_longitudinal_mesh_is_symmetric_bounded_and_refines(self):
        values=[]
        for n in f.MESHES:
            _,meta=f.build(n,1)
            values.append(meta["longitudinal_max_mm"])
            for axis in "xy":
                lines=np.array(meta["mesh_mm"][axis])
                np.testing.assert_allclose(lines,-lines[::-1],atol=1e-13,rtol=0)
                self.assertGreater(np.min(np.diff(lines)),0)
            center=f.axis_lines([-10.,10.],f.geometry()["w50_mm"]/n,f.PAD,
                                meta["longitudinal_max_mm"])
            inside=center[(center>=-10.)&(center<=10.)]
            self.assertLessEqual(float(np.max(np.diff(inside))),meta["longitudinal_max_mm"]*(1+1e-12))
        self.assertTrue(all(a>b for a,b in zip(values,values[1:])))

    def test_phase_is_compared_to_band_dependent_reference_and_wraps(self):
        ref=f.reference()
        shifted=ref.copy();shifted[:,1,0]*=np.exp(1j*np.deg2rad(359.8))
        np.testing.assert_allclose(f.phase_delta(shifted,ref),-.2,atol=1e-12)
        self.assertGreater(np.ptp(f.relative_phase(ref)),1.)
        bad=ref.copy();bad[:,2,0]=0
        with self.assertRaisesRegex(ValueError,"non-null"):
            f.relative_phase(bad)

    def test_full_inverse_removes_other_incident_waves_for_two_and_four_ports(self):
        rng=np.random.default_rng(775)
        for count in (2,4):
            s=.1*(rng.normal(size=(201,count,count))+1j*rng.normal(size=(201,count,count)))
            a=np.broadcast_to(np.eye(count)+.08j*np.ones((count,count)),s.shape)
            b=s@a
            v=(np.sqrt(f.Z0)*(a+b)).transpose(2,1,0)
            i=((a-b)/np.sqrt(f.Z0)).transpose(2,1,0)
            actual,q=f.waves_to_s(v,i)
            np.testing.assert_allclose(actual,s,atol=5e-16,rtol=0)
            self.assertLess(q["inverse_residual_abs"],5e-16)
        for bad in (np.zeros((4,4,201)),np.ones((4,4,201)),np.full((4,4,201),np.nan)):
            with self.assertRaises(ValueError):
                f.waves_to_s(bad,bad)

    def test_line_control_and_extended_feed_do_not_change_hybrid_arms(self):
        for length in f.LINE_LENGTHS:
            sim,meta=f.build(6,2,kind="line",line_mm=length)
            self.assertEqual(len(sim.ports),2)
            self.assertEqual([p["number"] for p in sim.ports if p["excite"]],[2])
        _,a=f.build(6,1);_,b=f.build(6,1,feed=f.LONG_FEED)
        self.assertEqual(a["geometry"],b["geometry"])
        self.assertAlmostEqual(abs(b["ports"][0]["start"][0])-abs(a["ports"][0]["start"][0]),5.)

    def test_native_header_requires_grid_clock_threads_and_custom_source_window(self):
        _,meta=f.build(4,1);meta["native"]=dict(dt_s=meta["declared_dt_s"])
        interval=int(1/(2*meta["f_max_hz"]*meta["declared_dt_s"]))
        shape="x".join(str(v) for v in meta["native_lines"])
        text=(f"openEMS 64bit -- version v0.37.0-rc3\nfixed number of threads: 4\n"
            f"FDTD simulation size: {shape} --> {meta['native_cells']} FDTD cells\n"
            f"Exact-endcriteria: evaluating the end criteria every {interval} timestep\n"
            f"Excitation signal length is: {meta['max_timesteps']} timesteps\n")
        self.assertEqual(audit_header(text,meta)["nyquist_interval"],interval)
        with self.assertRaisesRegex(ValueError,"custom-source"):
            audit_header(text.replace(f"{meta['max_timesteps']} timesteps","7 timesteps"),meta)
        with self.assertRaisesRegex(ValueError,"stability"):
            audit_header("forced timestep: 1 ps larger than calculated timestep",{})

    def test_trace_clock_nonfinite_and_capped_energy_are_rejected(self):
        native=dict(dt_s=1e-12,numerical_time_s=1e-9)
        stride=int(1/(2*f.FREQUENCIES[-1]*native["dt_s"]*4))
        data=np.column_stack((np.arange(12)*stride*native["dt_s"],np.ones(12)))
        self.assertEqual(f.trace_clock(data,native)["stride_steps"],stride)
        for bad in (data*[2,1],data*np.nan,np.vstack((data[:5],data[4:]))):
            with self.assertRaises(ValueError):
                f.trace_clock(bad,native)
        _,meta=f.build(4,1)
        steps=int(np.ceil(2*meta["source_duration_s"]/meta["declared_dt_s"]))
        meta["native"]=dict(cells=meta["native_cells"],dt_s=meta["declared_dt_s"],timesteps=steps,
                            numerical_time_s=steps*meta["declared_dt_s"])
        meta["run"]=dict(grid=meta["native_lines"],converged=True,exact_endcriteria=True,threads=4)
        meta["native_header"]=dict(version="v0.37.0-rc3",threads=4,
            nyquist_interval=int(1/(2*meta["f_max_hz"]*meta["declared_dt_s"])),excitation_timesteps=meta["max_timesteps"])
        self.assertTrue(all(f.record_quality(meta).values()))
        meta["run"]["hit_timestep_limit"]=True
        self.assertFalse(f.record_quality(meta)["native_stop"])
        meta["native"]["numerical_time_s"]=.5*meta["source_duration_s"]
        self.assertFalse(f.record_quality(meta)["source_completed"])

    def test_invalid_controls_and_over_budget_are_refused_before_launch(self):
        for n,p,options in ((True,1,{}),(7,1,{}),(4,True,{}),(4,5,{}),(4,1,dict(kind="other")),
                (4,1,dict(line_mm=21.)),(4,1,dict(feed=14.)),(4,1,dict(cap_s=1e-9)),
                (4,1,dict(dt_factor=True)),(4,1,dict(dt_factor=1.1))):
            with self.assertRaises(ValueError):
                f.build(n,p,**options)
        for freq in ([],[0],[np.nan],[4e9]):
            with self.assertRaises(ValueError):
                f.reference(freq)
        with tempfile.TemporaryDirectory() as temp,patch(__name__+".popen_group") as start:
            out=Path(temp)/"not-started"
            with self.assertRaisesRegex(ValueError,"exceeds 30"):
                acquire_serial(out,8,.01)
            self.assertFalse(out.exists());start.assert_not_called()
        for rate in (True,0,-1,np.nan):
            with self.assertRaises(ValueError):
                forecast({},rate)

    def test_failed_native_audit_retains_receipt_and_stops_next_excitation(self):
        class ReturnedWorker:
            pid,win_job=777,None
            def wait(self,timeout=None):
                return 0
            def poll(self):
                return 0
        with tempfile.TemporaryDirectory() as temp:
            out=Path(temp)/"control"
            def launch(command,**options):
                destination=Path(command[command.index("--out")+1]);destination.mkdir()
                f.save(destination/"report.json",{})
                return ReturnedWorker()
            with patch(__name__+".popen_group",side_effect=launch) as start, \
                    patch(__name__+".release_group"),patch(__name__+".audit_header",return_value={}), \
                    patch.object(f,"read",return_value=(None,None,None,dict(native_stop=False))):
                with self.assertRaisesRegex(ValueError,"native audit"):
                    acquire_serial(out,4,79.325356669)
                self.assertEqual(start.call_count,1)
            progress=json.loads((out/"progress.json").read_text())
            self.assertEqual(progress["status"],"rejected")
            self.assertIsNone(progress["active_launcher_pid"])
            self.assertTrue((out/"port1.worker.json").is_file())

    def test_successful_last_mesh_does_not_hide_failed_first_mesh(self):
        ref=f.reference()
        beta=2*np.pi*f.FREQUENCIES/f.C0*np.sqrt(f.analytic.microstrip_eps_eff(f.ER,f.H,f.geometry()["w50_mm"]))
        def fake(path):
            name=path.name
            n=int(name[1:].split("_")[0])
            kind="line" if "line" in name else "hybrid"
            length=30. if name.endswith("line30") else 20.
            s=ref.copy()
            if name=="n3":
                s[:,0,0]+=.02
            if kind=="line":
                s=np.zeros((201,2,2),complex)
                s[:,0,1]=s[:,1,0]=np.exp(-1j*beta*length*1e-3)
            if name.endswith("feed"):
                s*=np.exp(-2j*beta*.005)[:,None,None]
            row=dict(n=n,kind=kind,line_mm=length,feed_mm=f.LONG_FEED if name.endswith("feed") else f.FEED,
                padding_mm=f.FAR_PAD if name.endswith("pad") else f.PAD,
                end_db=-90. if name.endswith("time") else f.END_DB,
                cap_s=2*f.CAP_S if name.endswith("time") else f.CAP_S,
                dt_factor=f.CONTROL_DT_FACTOR if name.endswith("dt") else f.DT_FACTOR,
                all_native_complete=True,target_passes=True)
            return s,row
        with tempfile.TemporaryDirectory() as temp,patch.object(f,"matrix",side_effect=fake):
            result=f.study(temp)
        self.assertFalse(result["qualified"])
        self.assertGreater(result["mesh_changes"][0],f.LIMITS["complex_mesh_abs"])
        self.assertEqual(result["mesh_changes"][1],0.)
        self.assertTrue(result["controls"]["feed"]["passes"])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    action=parser.add_mutually_exclusive_group(required=True)
    for name in ("preflight","fdtd","analyse","study"):
        action.add_argument("--"+name,action="store_true")
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--mesh",type=int,choices=f.MESHES+f.DEFERRED_MESHES,default=f.MESHES[0])
    parser.add_argument("--kind",choices=("hybrid","line"),default="hybrid")
    parser.add_argument("--line-mm",type=float,choices=f.LINE_LENGTHS,default=20.)
    parser.add_argument("--feed-mm",type=float,choices=(f.FEED,f.LONG_FEED),default=f.FEED)
    parser.add_argument("--padding-mm",type=float,choices=(f.PAD,f.FAR_PAD),default=f.PAD)
    parser.add_argument("--end-db",type=float,choices=(-80.,-90.),default=f.END_DB)
    parser.add_argument("--cap-ns",type=float,default=f.CAP_S*1e9)
    parser.add_argument("--dt-factor",type=float,choices=(f.CONTROL_DT_FACTOR,f.DT_FACTOR),default=f.DT_FACTOR)
    parser.add_argument("--rate-mcps",type=float,default=10.)
    parser.add_argument("--worker-case",action="store_true",help=argparse.SUPPRESS)
    parser.add_argument("--port",type=int,choices=(1,2,3,4),default=1,help=argparse.SUPPRESS)
    args=parser.parse_args()
    options=dict(kind=args.kind,line_mm=args.line_mm,feed=args.feed_mm,padding=args.padding_mm,
                 end_db=args.end_db,cap_s=args.cap_ns/1e9,dt_factor=args.dt_factor)
    if args.preflight:
        args.out.mkdir(parents=True,exist_ok=False);rows=[]
        for n in f.MESHES:
            sim,meta=f.build(n,1,**options)
            path=args.out/f"n{n}.xml";sim.fdtd.Write2XML(str(path))
            rows.append(dict(meta=meta,input_sha256=f.sha(path),forecast_seconds=forecast(meta,args.rate_mcps)))
        f.save(args.out/"plan.json",dict(rows=rows,source=f.identity(),runtime=f.runtime_identity(),limits=f.LIMITS))
        print(json.dumps(rows,indent=2))
    elif args.analyse:
        print(json.dumps(f.matrix(args.out)[1],indent=2))
    elif args.study:
        print(json.dumps(f.study(args.out),indent=2))
    elif args.worker_case:
        print(json.dumps(f.acquire(args.out,args.mesh,args.port,**options),indent=2))
    else:
        print(json.dumps(acquire_serial(args.out,args.mesh,args.rate_mcps,**options),indent=2))


if __name__=="__main__":
    if len(sys.argv)==1:
        unittest.main()
    else:
        main()
