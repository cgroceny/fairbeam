"""Opt-in microstrip ring-down study. Ordinary unittest never starts FDTD.

From python/ with the bundled openEMS environment, write outside the repo:
python -m tests.test_microstrip_resonator --preflight --out C:\\Temp\\microstrip-plan
python -m tests.test_microstrip_resonator --fdtd --mesh 4 --case pec --end open --rate-mcps 17 --out C:\\Temp\\microstrip-open
python -m tests.test_microstrip_resonator --analyse --out C:\\Temp\\microstrip-open

Each owned solver worker has a suspend-inclusive 30-minute deadline. A cap or
incomplete mesh/boundary study never qualifies the distributed-loss reference.
"""
import argparse
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
import xml.etree.ElementTree as ET

import numpy as np

from fairbeam.procutil import popen_group, release_group, terminate_group
from tests import microstrip_resonator_fixture as fixture


def forecast(meta,rate):
    if not np.isfinite(rate) or rate<=0:
        raise ValueError("positive conservative measured rate required")
    return 1.15*meta["native_cells"]*meta["max_timesteps"]/(rate*1e6)+20


def wait_owned(process,seconds=1800):
    start,wall=time.monotonic(),time.time()
    while True:
        remaining=seconds-max(time.monotonic()-start,time.time()-wall)
        if remaining<=0:
            if process.poll() is None:
                terminate_group(process.pid,grace=0,job=process.win_job)
            process.wait(timeout=15)
            raise TimeoutError("owned worker exceeded 30 minutes")
        try:
            code=process.wait(timeout=min(1.,remaining))
            if max(time.monotonic()-start,time.time()-wall)>seconds:
                raise TimeoutError("owned worker returned after 30 minutes")
            return code
        except subprocess.TimeoutExpired:
            pass


def audit_header(text,meta):
    if re.search(r"forced timestep:.*larger than calculated timestep",text):
        raise ValueError("native timestep exceeds the engine stability bound")
    version=re.search(r"openEMS 64bit -- version (\S+)",text)
    grid=re.search(r"FDTD simulation size: (\d+)x(\d+)x(\d+) --> (\d+) FDTD cells",text)
    interval=re.search(r"Exact-endcriteria: evaluating the end criteria every (\d+) timestep",text)
    if not version or not grid or not interval or version[1]!="v0.37.0-rc3":
        raise ValueError("audited rc3 engine/grid/clock header required")
    if f"fixed number of threads: {fixture.THREADS}" not in text:
        raise ValueError("four native threads required")
    if list(map(int,grid.groups()[:3]))!=meta["native_lines"] or int(grid[4])!=meta["native_cells"]:
        raise ValueError("native grid differs from declared input")
    if int(interval[1])!=int(1/(2*meta["f_max_hz"]*meta["native"]["dt_s"])):
        raise ValueError("native proxy schedule differs from recorded clock")
    return dict(version=version[1],threads=fixture.THREADS,nyquist_interval=int(interval[1]))


def acquire_serial(out,n,kind,end,air,cap,rate,pulse="auto"):
    out=Path(out).resolve()
    if out.exists():
        raise ValueError("acquisition already exists")
    _,meta=fixture.build(n,kind,end,air,cap,pulse)
    estimate=forecast(meta,rate)
    if estimate>1800:
        raise ValueError(f"forecast {estimate/60:.1f} minutes exceeds 30; defer")
    out.parent.mkdir(parents=True,exist_ok=True)
    command=[sys.executable,"-m","tests.test_microstrip_resonator","--fdtd","--worker-case",
             "--mesh",str(n),"--case",kind,"--end",end,"--air",str(air),
             "--cap-ns",str(cap*1e9),"--pulse",pulse,"--out",str(out)]
    log_path=out.with_name(out.name+".log")
    with log_path.open("w",encoding="utf-8") as log:
        process=popen_group(command,cwd=Path(__file__).resolve().parents[1],
                            stdout=log,stderr=subprocess.STDOUT,
                            env={**os.environ,"OMP_NUM_THREADS":str(fixture.THREADS),"OPENBLAS_NUM_THREADS":"1"})
        start,wall=time.monotonic(),time.time()
        code=None
        try:
            code=wait_owned(process)
        finally:
            if process.poll() is None:
                terminate_group(process.pid,grace=0,job=process.win_job)
                process.wait(timeout=15)
            release_group(process)
            fixture.save(out.with_name(out.name+".worker.json"),dict(command=command,pid=process.pid,
                         exit_code=code,estimated_seconds=estimate,rate_mcps=rate,
                         monotonic_seconds=time.monotonic()-start,wall_seconds=time.time()-wall))
    if code:
        raise RuntimeError(f"native worker exit{code}; retained {log_path}")
    report=json.loads((out/"report.json").read_text(encoding="utf-8"))
    report["native_header"]=audit_header(log_path.read_text(encoding="utf-8"),report)
    fixture.save(out/"report.json",report)
    return fixture.read(out)


class MicrostripResonatorTests(unittest.TestCase):
    def test_reference_geometry_and_independent_q_filling_factor(self):
        ref=fixture.reference("dielectric")
        self.assertAlmostEqual(ref["z_ohm"],50.,places=10)
        self.assertAlmostEqual(ref["length_mm"]*1e-3*np.sqrt(ref["eps_eff"])*2*fixture.F0,fixture.C0,places=5)
        expected=ref["eps_eff"]*(fixture.ER-1)/(fixture.ER*(ref["eps_eff"]-1)*fixture.TAN_D)
        self.assertAlmostEqual(ref["qd"],expected,places=8)
        self.assertGreater(ref["qd"],1/fixture.TAN_D)
        self.assertLess(ref["fringe_frequency_hz"],fixture.F0)

    def test_loss_addition_and_constant_dielectric_conductivity(self):
        d,c,b=[fixture.reference(k) for k in ("dielectric","copper_sheet","both_sheet")]
        self.assertAlmostEqual(1/b["q_distributed"],1/d["q_distributed"]+1/c["q_distributed"])
        shifted=fixture.reference("dielectric",4e9)
        self.assertEqual(shifted["sigma_dielectric_s_m"],d["sigma_dielectric_s_m"])
        self.assertAlmostEqual(shifted["qd"]/d["qd"],.8)
        self.assertIsNone(fixture.reference("pec")["q_distributed"])

    def test_geometry_symmetry_and_declared_end_plane(self):
        for end in fixture.ENDS:
            sim,meta=fixture.build(6,"pec",end)
            x,y,z=[np.asarray(sim.mesh.GetLines(a)) for a in "xyz"]
            self.assertEqual(x[0],0.)
            self.assertAlmostEqual((y[0]+y[1])/2,0.)
            self.assertEqual(z[1],0.)
            self.assertIn(fixture.H,z)
            self.assertEqual(meta["native_cells"],len(x)*len(y)*len(z))
            self.assertLessEqual(meta["declared_dt_s"],.5*sim.cfl_timestep())
            if end!="open":
                self.assertAlmostEqual((x[-2]+x[-1])/2,meta["physical_half_length_mm"])
            self.assertEqual(sim.boundaries[3],"PEC" if end=="boxed" else "PML_8")
            with self.assertRaisesRegex(ValueError,"ports"):
                sim.to_bundle()

    def test_material_surrogate_is_explicit_and_not_tuned(self):
        sim,meta=fixture.build(4,"both_sheet")
        self.assertEqual(meta["sheet_sigma_s_m"],fixture.SIGMA/4)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"input.xml"
            sim.fdtd.Write2XML(str(path))
            properties=ET.parse(path).getroot().find("ContinuousStructure/Properties")
            sheets=properties.findall("ConductingSheet")
            self.assertEqual(len(sheets),2)
            self.assertTrue(all(float(s.get("Conductivity"))==fixture.SIGMA/4 for s in sheets))
            self.assertEqual(len(properties.findall("LumpedElement")),0)

    def test_geometry_is_fixed_between_loss_and_air_controls(self):
        ref=fixture.build(6,"pec")[1]
        for kind in fixture.KINDS:
            meta=fixture.build(6,kind)[1]
            for name in ("physical_half_length_mm","probes_mm","native_lines","declared_dt_s"):
                self.assertEqual(meta[name],ref[name])
        expanded=fixture.build(6,"pec",air_h=8)[1]
        self.assertEqual(expanded["reference"],ref["reference"])
        self.assertGreater(expanded["native_cells"],ref["native_cells"])

    def test_narrow_pulse_is_dc_free_and_windows_are_after_source(self):
        t=np.arange(0,20e-9,1e-12)
        u=fixture.narrow_signal(t)
        self.assertLess(abs(np.trapezoid(u,t))/np.trapezoid(abs(u),t),1e-10)
        fundamental=abs(np.trapezoid(u*np.exp(-2j*np.pi*fixture.PULSE_F*t),t))
        cavity_mode=abs(np.trapezoid(u*np.exp(-2j*np.pi*8.8e9*t),t))
        self.assertLess(cavity_mode/fundamental,1e-9)
        narrow,meta=fixture.build(4,"pec","boxed")
        broad,before=fixture.build(4,"pec","boxed",pulse="broad")
        self.assertEqual(meta["excitation"]["expression"],fixture.narrow_expression())
        self.assertTrue(meta["excitation"]["dc_free"])
        self.assertGreater(meta["windows_s"][0][0],meta["source_duration_s"])
        self.assertEqual(meta["native_lines"],before["native_lines"])
        self.assertEqual(meta["reference"],before["reference"])
        self.assertEqual(broad.f_max,8e9)
        self.assertEqual(narrow.f_max,6e9)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"input.xml"
            narrow.fdtd.Write2XML(str(path))
            node=ET.parse(path).getroot().find("FDTD/Excitation")
            self.assertEqual(float(node.get("f0")),narrow.f_max)
        self.assertLess(meta["reference"]["guide_frequency_hz"],fixture.F0)
        with self.assertRaisesRegex(ValueError,"post-source"):
            fixture.build(4,"pec","boxed",cap_s=30e-9)
        self.assertEqual(fixture.build(4,"pec","open")[1]["pulse"],"broad")
        self.assertEqual(fixture.build(4,"pec","boxed")[1]["pulse"],"narrow")

    def test_free_pole_frequency_damping_and_offset(self):
        t=np.arange(0,40e-9,2e-12)
        for f,q in ((4.7e9,150.),(5.03e9,3000.)):
            y=np.exp(-np.pi*f*t/q)*np.cos(2*np.pi*f*t+.23)+.017
            fitted=fixture.field_pole(t,y)
            self.assertLess(abs(fitted["f_hz"]/f-1),1e-9)
            self.assertLess(abs(fitted["q"]/q-1),1e-7)
            self.assertTrue(fitted["decaying"])

    def test_field_fit_retains_growth_and_exposes_multiple_modes(self):
        t=np.arange(6000)*5e-12
        growth=fixture.field_pole(t,np.exp(1e7*t)*np.cos(2*np.pi*5e9*t))
        self.assertFalse(growth["decaying"])
        self.assertLess(growth["alpha_s"],0)
        self.assertIsNone(growth["q"])
        mixed=np.exp(-1e7*t)*(np.cos(2*np.pi*5e9*t)+.5*np.cos(2*np.pi*8e9*t))
        self.assertGreater(fixture.field_pole(t,mixed)["relative_residual"],fixture.GATES["ar_residual"])
        bad=t.copy(); bad[100]+=.8e-12
        for clock,signal in ((bad,mixed),(t,np.zeros(len(t))),(t,np.ones(len(t)))):
            with self.assertRaises(ValueError):
                fixture.field_pole(clock,signal)

    def test_independent_proxy_slope_and_sparse_sample_refusal(self):
        t=np.linspace(10e-9,1e-6,100)
        energy=3*np.exp(-2*np.pi*5e9*t/1500)
        fitted=fixture.energy_trend(t,energy,5e9)
        self.assertLess(abs(fitted["q"]/1500-1),1e-12)
        self.assertFalse(fitted["physical_energy"])
        for clock,e in ((t[:19],energy[:19]),(t,np.ones(len(t))),(t,np.zeros(len(t)))):
            with self.assertRaises(ValueError):
                fixture.energy_trend(clock,e,5e9)

    def test_budget_refuses_before_any_worker_is_started(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch(__name__+".popen_group") as spawn:
                with self.assertRaisesRegex(ValueError,"defer"):
                    acquire_serial(Path(directory)/"unstarted",8,"pec","open",6,fixture.CAP_S,1.)
                spawn.assert_not_called()
        for n in (True,0,4.,5,12):
            with self.assertRaises(ValueError):
                fixture.build(n,"pec")
        self.assertEqual(fixture.CAP_S*1e9/1e9,fixture.CAP_S)

    def test_suspend_and_late_completion_cannot_hide_deadline(self):
        class Process:
            pid,win_job=12345,object()
            def poll(self): return None
            def wait(self,timeout): return 0
        for values in ((100.,2000.),(100.,100.1,2000.)):
            with patch(__name__+".time.monotonic",return_value=10.), \
                 patch(__name__+".time.time",side_effect=values), \
                 patch(__name__+".terminate_group") as stop:
                with self.assertRaises(TimeoutError):
                    wait_owned(Process())
                self.assertEqual(stop.call_count,1 if len(values)==2 else 0)

    def test_native_grid_clock_and_version_header(self):
        meta=dict(native_lines=[60,30,25],native_cells=45000,f_max_hz=8e9,native=dict(dt_s=.3e-12))
        text=("openEMS 64bit -- version v0.37.0-rc3\nfixed number of threads: 4\n"
              "FDTD simulation size: 60x30x25 --> 45000 FDTD cells\n"
              "Exact-endcriteria: evaluating the end criteria every 208 timestep(s)")
        self.assertEqual(audit_header(text,meta)["nyquist_interval"],208)
        for old,new in (("0.37.0-rc3","0.38"),("60x30","60x31"),("every 208","every 207"),("threads: 4","threads: 8")):
            with self.assertRaises(ValueError):
                audit_header(text.replace(old,new),meta)
        with self.assertRaisesRegex(ValueError,"stability"):
            audit_header(text+"\nWarning, forced timestep: 6e-13s is larger than calculated timestep: 5e-13s!",meta)

    def test_cap_open_end_and_wrong_probe_clock_cannot_qualify(self):
        # An otherwise perfect synthetic result must not hide a cap, a wrong
        # probe clock or the open-end model's different physical assumptions.
        cases=(("boxed",True,False),("boxed",False,False),("open",True,False),
               ("pmc",True,False),("boxed",True,True))
        for end,stopped,wrong_clock in cases:
            with tempfile.TemporaryDirectory() as directory:
                out=Path(directory)
                _,meta=fixture.build(4,"dielectric",end)
                dt=meta["declared_dt_s"]
                t=np.arange(meta["max_timesteps"]//meta["probe_stride_steps"]+1)*dt*meta["probe_stride_steps"]
                if wrong_clock:
                    t*=2
                (out/"input.xml").write_text("<own-synthetic-input/>",encoding="utf-8")
                np.savez_compressed(out/"data.npz",t=t,u=np.array([np.cos(2*np.pi*fixture.F0*t)]*2),
                                    energy_t=np.linspace(4e-9,25e-9,30),energy=np.linspace(1,.01,30))
                f=fixture.F0
                q=fixture.reference("dielectric",f)["q_distributed"]
                meta.update(source_sha256=fixture.identity(),runtime=fixture.runtime_identity(),gates=fixture.GATES,
                            input_sha256=fixture.sha(out/"input.xml"),data_sha256=fixture.sha(out/"data.npz"),
                            native=dict(dt_s=dt,cells=meta["native_cells"],timesteps=meta["max_timesteps"]-(2 if stopped else 0),numerical_time_s=fixture.CAP_S),
                            run=dict(grid=meta["native_lines"],converged=stopped,threads=fixture.THREADS),
                            native_header=dict(version="v0.37.0-rc3",threads=fixture.THREADS,
                                nyquist_interval=int(1/(2*meta["f_max_hz"]*dt))))
                fixture.save(out/"report.json",meta)
                with patch.object(fixture,"field_pole",return_value=dict(f_hz=f,q=q,alpha_s=1.,decaying=True,relative_residual=0.)), \
                     patch.object(fixture,"energy_decay",return_value=dict(q=q,fitted_span_db=50.,log_rms=0.,q_rel_95_uncertainty=.001)):
                    result=fixture.read(out)
                self.assertEqual(result["matches"],end=="boxed" and stopped and not wrong_clock)
                self.assertFalse(result["qualified"])
                if wrong_clock:
                    self.assertFalse(result["probe_clock_ok"])
                if end=="boxed" and stopped and not wrong_clock:
                    # A matching alternate dispersion approximation cannot
                    # silently replace the frozen 5 GHz acceptance target.
                    with patch.object(fixture,"field_pole",return_value=dict(
                            f_hz=meta["reference"]["guide_frequency_hz"],q=q,alpha_s=1.,decaying=True,relative_residual=0.)):
                        self.assertFalse(fixture.read(out)["matches"])
                    meta["native_header"]["threads"]=8
                    fixture.save(out/"report.json",meta)
                    self.assertFalse(fixture.read(out)["header_ok"])

    def test_early_stop_cannot_substitute_a_partial_window(self):
        with tempfile.TemporaryDirectory() as directory:
            out=Path(directory)
            _,meta=fixture.build(4,"pec","open",pulse="narrow")
            dt=meta["declared_dt_s"]
            t=np.arange(int(36e-9/(dt*meta["probe_stride_steps"])))*dt*meta["probe_stride_steps"]
            (out/"input.xml").write_text("<own-synthetic-input/>",encoding="utf-8")
            np.savez_compressed(out/"data.npz",t=t,u=np.array([np.cos(2*np.pi*fixture.F0*t)]*2),energy_t=[],energy=[])
            meta.update(source_sha256=fixture.identity(),runtime=fixture.runtime_identity(),gates=fixture.GATES,
                input_sha256=fixture.sha(out/"input.xml"),data_sha256=fixture.sha(out/"data.npz"),
                native=dict(dt_s=dt,cells=meta["native_cells"],timesteps=int(36e-9/dt),numerical_time_s=36e-9),
                run=dict(grid=meta["native_lines"],converged=True,threads=fixture.THREADS))
            fixture.save(out/"report.json",meta)
            result=fixture.read(out)
            self.assertFalse(result["matches"])
            self.assertTrue(any("incomplete" in e for e in result["extraction_errors"]))

    def test_study_requires_distinct_fine_mesh_and_boundary_identity(self):
        base=dict(n=4,kind="dielectric",end="pmc",air_h=6,pulse="narrow",f_hz=fixture.F0,q=2900.,matches=True)
        rows=[dict(base,n=n) for n in fixture.MESHES]+[dict(base,n=6,air_h=8)]
        for index in (1,3):
            broken=[dict(row) for row in rows]
            broken[index]["n"]=4
            with tempfile.TemporaryDirectory() as directory,patch.object(fixture,"read",side_effect=broken):
                with self.assertRaisesRegex(ValueError,"identity"):
                    fixture.study(directory,"dielectric","pmc")

    def test_growing_and_different_pulse_cohorts_cannot_qualify(self):
        base=dict(kind="pec",end="boxed",air_h=6,pulse="narrow",f_hz=fixture.F0,q=None,matches=False)
        rows=[dict(base,n=n) for n in fixture.MESHES]+[dict(base,n=6,air_h=8)]
        with tempfile.TemporaryDirectory() as directory,patch.object(fixture,"read",side_effect=rows):
            self.assertFalse(fixture.study(directory,"pec","boxed")["qualified"])
        rows[-1]["pulse"]="broad"
        with tempfile.TemporaryDirectory() as directory,patch.object(fixture,"read",side_effect=rows):
            with self.assertRaisesRegex(ValueError,"pulse cohort"):
                fixture.study(directory,"pec","boxed")


def main():
    p=argparse.ArgumentParser(description=__doc__)
    actions=p.add_mutually_exclusive_group(required=True)
    for action in ("preflight","fdtd","analyse","study"):
        actions.add_argument("--"+action,action="store_true")
    p.add_argument("--out",type=Path,required=True)
    p.add_argument("--mesh",type=int,choices=fixture.MESHES,default=4)
    p.add_argument("--case",choices=fixture.KINDS,default="pec")
    p.add_argument("--end",choices=fixture.ENDS,default="open")
    p.add_argument("--pulse",choices=fixture.PULSES,default="auto")
    p.add_argument("--air",type=int,choices=(6,8),default=6)
    p.add_argument("--cap-ns",type=float,default=fixture.CAP_S*1e9)
    p.add_argument("--rate-mcps",type=float,default=15.)
    p.add_argument("--worker-case",action="store_true",help=argparse.SUPPRESS)
    a=p.parse_args()
    cap=a.cap_ns/1e9
    if a.preflight:
        a.out.mkdir(parents=True,exist_ok=False)
        rows=[]
        for end in fixture.ENDS:
            for n,air in ((4,6),(6,6),(8,6),(6,8)):
                for kind in fixture.KINDS:
                    sim,meta=fixture.build(n,kind,end,air,cap,a.pulse)
                    path=a.out/f"{end}_{kind}_n{n}_air{air}.xml"
                    sim.fdtd.Write2XML(str(path))
                    rows.append(dict(**meta,input_sha256=fixture.sha(path),estimated_seconds=forecast(meta,a.rate_mcps)))
        fixture.save(a.out/"preflight.json",dict(source_sha256=fixture.identity(),gates=fixture.GATES,
                     rate_mcps=a.rate_mcps,rows=rows,qualified=False))
        print(json.dumps(dict(cases=len(rows),max_forecast_seconds=max(r["estimated_seconds"] for r in rows))))
    elif a.analyse:
        print(json.dumps(fixture.read(a.out),indent=2))
    elif a.study:
        print(json.dumps(fixture.study(a.out,a.case,a.end),indent=2))
    elif a.worker_case:
        print(json.dumps(fixture.acquire(a.out,a.mesh,a.case,a.end,a.air,cap,a.pulse),indent=2))
    else:
        print(json.dumps(acquire_serial(a.out,a.mesh,a.case,a.end,a.air,cap,a.rate_mcps,a.pulse),indent=2))


if __name__=="__main__":
    if len(sys.argv)==1:
        unittest.main()
    else:
        main()
