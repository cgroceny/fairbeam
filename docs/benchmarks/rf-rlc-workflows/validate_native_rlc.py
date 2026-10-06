"""Bounded native fixture: electrically small parallel-plate connections, 4 CPU threads.
Run manually with the configured openEMS Python. No test suite solver invocation.
"""
import json, sys, time
from pathlib import Path
import numpy as np
from fairbeam.simulation import Simulation
root = Path(sys.argv[1])
unit = float(sys.argv[2]) if len(sys.argv) > 2 else 1e-3
tolerance = 0.10  # Fixed before repeat: max relative complex-Z error across 4–6 GHz.
root.mkdir(parents=True, exist_ok=True)
build_only = "--build-only" in sys.argv
records = []
(root/"fixture-source.py").write_text(Path(__file__).read_text(encoding="utf8"),encoding="utf8")
for topology, values in [("parallel", {"R": 100.}), ("series", {"R": 100., "L": 2e-9, "C": 1e-12}), ("parallel", {"R": 100., "L": 2e-9, "C": 1e-12})]:
    key = "R" if len(values) == 1 else topology
    sim = Simulation(4e9, 6e9, unit=unit, end_criteria_db=-50, max_timesteps=300000)
    metal = sim.metal("plates")
    for z in [0, .2]: metal.AddBox([-.6, -.4, z], [.6, .4, z], priority=10)
    sim.lumped_port(1, 50, [-.5, -.2, 0], [-.3, .2, .2], "z")
    sim.lumped_element("load", [.3, -.2, 0], [.5, .2, .2], "z", topology=topology, **values)
    for axis in "xyz":
        lines = [-4, -2, -1, -.6, -.5, -.3, -.2, 0, .2, .3, .5, .6, 1, 2, 4]
        sim.mesh.AddLine(axis, lines)
    (root/key).mkdir(parents=True, exist_ok=True)
    sim.csx.Write2XML(str(root/key/"geometry.xml"))
    if build_only:
        print(key, "native XML retained", flush=True)
        continue
    started=time.time()
    if (root/key/"port_ut_1").exists():
        sim.sim_path = str(root/key)
        run = {"reused": True}
    else:
        run=sim.run(str(root/key), threads=4, echo=False)
    results=sim.evaluate(n_freq=21)
    f=np.array(results["frequency"]); p=results["ports"]["1"]
    z=np.array(p["zin_re"])+1j*np.array(p["zin_im"])
    omega=2*np.pi*f
    if len(values)==1: expected=np.full_like(z,100)
    elif topology=="series": expected=100+1j*(omega*2e-9-1/(omega*1e-12))
    else: expected=1/(1/100+1/(1j*omega*2e-9)+1j*omega*1e-12)
    error=np.abs(z-expected)/np.abs(expected)
    record={"case":key,"unit_m":unit,"tolerance":tolerance,"pass":bool(error.max() <= tolerance and run.get("converged", False)),"topology":topology,"values":values,"run":run,"seconds":time.time()-started,
            "frequency_hz":f.tolist(),"zin_re":z.real.tolist(),"zin_im":z.imag.tolist(),
            "analytic_re":expected.real.tolist(),"analytic_im":expected.imag.tolist(),
            "relative_error":error.tolist(),"max_relative_error":float(error.max())}
    records.append(record)
    (root/"validation.json").write_text(json.dumps(records,indent=2),encoding="utf8")
    print(key, "max relative error", error.max(), flush=True)
