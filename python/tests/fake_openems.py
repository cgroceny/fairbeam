"""Stand-in for ``python -m fairbeam run`` in tests: replays a recorded run without openEMS.

    python fake_openems.py MODE OUT_DIR [SPEED]

MODE
    ok       replay fixtures/dipole_run_timed.log (real captured output), write OUT_DIR/fake-dipole.json
    fail     print a few lines, a traceback on stderr, exit 3
    hang     start a sleeping grandchild in the same process group, print its pid, then sleep forever
    slow     like ok but with extra progress lines, 0.2 s apart (for queue tests)
SPEED divides the recorded delays (default 20, i.e. the 6 s run takes 0.3 s).
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def out(line, stream=sys.stdout):
    stream.write(line + "\n")
    stream.flush()


def replay(out_dir: Path, speed: float, extra_progress: int = 0,
           settings: str = "fairbeam: end criterion -50 dB, max timesteps 60000, engine cpu"):
    prev = 0.0
    for raw in (HERE / "fixtures" / "dipole_run_timed.log").read_text(encoding="utf-8").splitlines():
        t, _, line = raw.partition("\t")
        t = float(t)
        time.sleep(max(0.0, t - prev) / speed)
        prev = t
        if line.startswith("fairbeam: wrote "):
            out_dir.mkdir(parents=True, exist_ok=True)
            path = out_dir / "fake-dipole.json"
            path.write_text(json.dumps({"schema": "fairbeam.project/1", "name": "fake dipole",
                                        "model": {"id": "dipole"}, "results": {"bands": []},
                                        "mesh": {"total_cells": 78000}}), encoding="utf-8")
            line = f"fairbeam: wrote {path}"
        if line.startswith("Running FDTD engine") and extra_progress:
            out(line)
            for i in range(1, extra_progress + 1):
                time.sleep(0.2)
                out(f"[@{4 * i:>9}s] Timestep: {1000 * i:>12} || Speed:  141.8 MC/s (5.501e-04 s/TS) || "
                    f"Energy: ~4.46e-25 (-{8.0 * i:.2f}dB)")
            continue
        out(line)
        if line == "fairbeam: Half-wave dipole" and settings:
            # printed by `fairbeam run` since the run server was added (not in the older fixture)
            out(settings)


def main():
    mode, out_dir = sys.argv[1], Path(sys.argv[2])
    speed = float(sys.argv[3]) if len(sys.argv) > 3 else 20.0
    if mode == "ok":
        replay(out_dir, speed)
    elif mode == "slow":
        replay(out_dir, speed, extra_progress=4)
    elif mode == "fail":
        out("fairbeam: Half-wave dipole")
        out("Traceback (most recent call last):", sys.stderr)
        out('  File "dipole.py", line 20, in build', sys.stderr)
        out("ValueError: gap must be smaller than length", sys.stderr)
        sys.exit(3)
    elif mode == "hang":
        # a python sleeper rather than `sleep`, which Windows does not have
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
        out(f"fairbeam: Half-wave dipole")
        out(f"grandchild {child.pid}")
        out("Running FDTD engine... this may take a while... grab a cup of coffee?!?")
        while True:
            time.sleep(1)
    elif mode == "opt":  # fairbeam optimize progress lines (optimize.py format)
        out('fairbeam: optimize start {"name":"fake-opt","file":"optimizations/fake-opt.json","max_evals":3}')
        best = None
        for i, (x, f0, cost) in enumerate([(58.0, 2.415, 0.39), (58.36, 2.401, 0.002), (58.3, 2.4025, 0.01)], 1):
            time.sleep(0.05)
            best = i if best is None or cost < [0.39, 0.002, 0.01][best - 1] else best
            out("fairbeam: optimize eval " + json.dumps({
                "index": i, "params": {"length": x}, "metrics": {"f0_ghz": f0, "s11_f0_db": -50.0}, "cost": cost,
                "met": False, "file": f"optimizations/fake-opt/dipole--length-{x:g}.json", "best_index": best,
                "best_cost": [0.39, 0.002, 0.01][best - 1], "max_evals": 3}))
        out('fairbeam: optimize done {"name":"fake-opt","file":"optimizations/fake-opt.json","reason":"max evaluations",'
            '"evaluations":3,"best":{"index":2,"params":{"length":58.36},"cost":0.002,'
            '"file":"optimizations/fake-opt/dipole--length-58.36.json"},"wall_time_s":0.2}')
        out("fairbeam: optimization written to " + str(out_dir / "optimizations" / "fake-opt.json"))
    else:
        sys.exit(f"unknown mode {mode}")


if __name__ == "__main__":
    main()
