"""CI: sanity-check a bundle written by a real openEMS run (used by .github/workflows/ci.yml).

    python scripts/ci-check-bundle.py path/to/bundle.json

The run statistics are parsed from openEMS' captured stdout, so empty statistics mean the output
capture failed on this platform.
"""
import json
import sys

b = json.load(open(sys.argv[1], encoding="utf-8"))
run = b.get("run") or {}
print("timesteps", run.get("timesteps"), "| energy points", len(run.get("energy_trace") or []),
      "| engine", run.get("engine"), "| cpu", (run.get("host") or {}).get("cpu"),
      "| converged", run.get("converged"))
assert run.get("timesteps"), "no timesteps parsed: openEMS output capture failed"
assert run.get("energy_trace"), "no energy trace parsed from the openEMS log"
assert (b.get("results") or {}).get("ports"), "no port results"
assert (b.get("results") or {}).get("farfield"), "no far field"
print("ok")
