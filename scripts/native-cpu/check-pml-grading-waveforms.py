"""Private, opt-in native PML waveform controls. Never patches an installed runtime.

Run with --baseline/--candidate DLL directories and a fresh --output directory.
Five small CPU acquisitions run serially in two isolated children. Their fixed
2400-step cap is diagnostic, not an energy/Q/mesh-convergence qualification.
"""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def loaded_dll(sdk):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    kernel.GetModuleHandleW.restype = wintypes.HMODULE
    kernel.GetModuleFileNameW.argtypes = [wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD]
    kernel.GetModuleFileNameW.restype = wintypes.DWORD
    handle = kernel.GetModuleHandleW("openEMS.dll")
    name = ctypes.create_unicode_buffer(32768)
    count = kernel.GetModuleFileNameW(handle, name, len(name))
    if not 0 < count < len(name):
        raise RuntimeError("Cannot identify the loaded openEMS DLL")
    path = Path(name.value).resolve(strict=True)
    if not path.is_relative_to(sdk):
        raise RuntimeError(f"Loaded DLL outside the supplied private directory: {path}")
    return {"path": str(path), "sha256": digest(path)}


def child(sdk, output, variant):
    import numpy as np
    from CSXCAD import ContinuousStructure
    from openEMS import openEMS

    identity = loaded_dll(sdk)
    cases = [("default", None)] if variant == "baseline" else [
        ("default", None), ("explicit8", 8), ("explicit4", 4), ("reset", None)]
    # New operators in the same candidate process exercise the global option reset.
    for name, reference in cases:
        case = output / name
        case.mkdir()
        fdtd = openEMS(NrTS=2400, EndCriteria=0)
        csx = ContinuousStructure()
        fdtd.SetCSX(csx)
        fdtd.SetGaussExcite(2e9, 1e9)
        fdtd.SetBoundaryCond(["PML_8"] * 6)
        grid = csx.GetGrid()
        grid.SetDeltaUnit(1e-3)
        for axis in "xyz":
            grid.SetLines(axis, np.linspace(-80, 80, 33))
        source = csx.AddExcitation("source", exc_type=0, exc_val=[0, 1, 0])
        source.SetColor([100, 100, 100])
        source.AddBox([0, 0, 0], [0, 5, 0])
        probe = csx.AddProbe("probe", p_type=0)
        probe.SetColor([100, 100, 100])
        probe.AddBox([20, -5, 0], [20, 5, 0])
        fdtd.Write2XML(str(case / "input.xml"))
        options = {"numThreads": 1, "verbose": 2, "dump_statistics": True}
        if reference is not None:
            options["pml_grading_cells"] = reference
        start = time.monotonic()
        returned = fdtd.Run(str(case), cleanup=False, **options)
        if returned not in (None, 0):
            raise RuntimeError(f"Native setup failed: {returned}")
        signal = np.loadtxt(case / "probe", comments="%")
        if signal.ndim != 2 or signal.shape[1] != 2 or signal.shape[0] < 100:
            raise RuntimeError("Probe output is missing or too short")
        if not np.isfinite(signal).all() or not np.all(np.diff(signal[:, 0]) > 0):
            raise RuntimeError("Probe output is nonfinite or time is not increasing")
        peak = float(np.max(np.abs(signal[:, 1])))
        if peak <= 1e-12:
            raise RuntimeError("Probe has no measurable diagnostic excitation")
        save(case / "receipt.json", {"variant": variant, "case": name, "dll": identity,
            "input_sha256": digest(case / "input.xml"), "probe_sha256": digest(case / "probe"),
            "rows": len(signal), "peak": peak, "seconds": time.monotonic() - start,
            "options": options, "pid": os.getpid(), "field_step_cap": 2400,
            "energy_convergence_claim": False, "quality_factor_claim": False})
        del fdtd


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--child", choices=("baseline", "candidate"))
    args = parser.parse_args()
    output = args.output.resolve()
    if args.child:
        sdk = (args.baseline if args.child == "baseline" else args.candidate).resolve(strict=True)
        child(sdk, output, args.child)
        return
    if os.name != "nt" or args.baseline is None or args.candidate is None:
        parser.error("Two explicit private Windows DLL directories are required")
    if output.exists():
        raise RuntimeError("Output must be a fresh directory; prior evidence is retained")
    output.mkdir(parents=True)
    receipt = {"script_sha256": digest(__file__), "stages": [], "complete": False,
        "controls": "No-FDTD parser checks are separate. Fixed-step waveform capability controls only; no antenna, Q, late-growth or mesh qualification."}
    try:
        for variant in ("baseline", "candidate"):
            sdk = getattr(args, variant).resolve(strict=True)
            stage = output / variant
            stage.mkdir()
            env = dict(os.environ, OPENEMS_INSTALL_PATH=str(sdk), CSXCAD_INSTALL_PATH=str(sdk), PYTHONUTF8="1")
            command = [sys.executable, str(Path(__file__).resolve()), "--child", variant,
                       f"--{variant}", str(sdk), "--output", str(stage)]
            start = time.monotonic()
            with (output / f"{variant}.log").open("wb") as log:
                result = subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=120)
            receipt["stages"].append({"variant": variant, "command": command,
                "exit": result.returncode, "seconds": time.monotonic() - start})
            if result.returncode:
                raise RuntimeError(f"{variant} failed; inspect retained log")
        import numpy as np
        cases = {key: output / value for key, value in {
            "baseline": "baseline/default", "default": "candidate/default", "explicit8": "candidate/explicit8",
            "explicit4": "candidate/explicit4", "reset": "candidate/reset"}.items()}
        signals = {key: np.loadtxt(path / "probe", comments="%") for key, path in cases.items()}
        base = signals["baseline"]
        if not all(digest(path / "input.xml") == digest(cases["baseline"] / "input.xml") for path in cases.values()):
            raise AssertionError("Native inputs differ; only runtime grading may vary")
        if not all(a.shape == base.shape and np.array_equal(a[:, 0], base[:, 0]) for a in signals.values()):
            raise AssertionError("Time grids or sample counts differ")
        peak = float(np.max(np.abs(base[:, 1])))
        errors = {key: float(np.max(np.abs(a[:, 1] - base[:, 1])) / peak) for key, a in signals.items()}
        receipt["peak_normalized_errors"] = errors
        if not np.array_equal(signals["default"], base) or not np.array_equal(signals["reset"], base):
            raise AssertionError("Default waveform or per-run reset changed")
        if errors["explicit8"] > 1e-7:
            raise AssertionError("Uniform PML_8 explicit reference 8 differs from native profile")
        if errors["explicit4"] <= 1e-7:
            raise AssertionError("Different explicit reference did not measurably affect the control")
        receipt["complete"] = True
    finally:
        save(output / "receipt.json", receipt)


if __name__ == "__main__":
    main()
