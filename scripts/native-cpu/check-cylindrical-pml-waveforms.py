"""Explicit private Windows SDK experiment; no installed runtime is changed.

Supply --baseline, --candidate and a fresh --output. Four tiny radial TE
acquisitions run serially; omitted/on/omitted also checks per-run option reset.
This is a reflection diagnostic, not an antenna/resonator-Q qualification.
"""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False)+'\n', encoding='utf-8')


def hankel_one(x):
    """J1+iY1, convergent real-argument series: DLMF 10.2.2 and 10.8.1.

    https://dlmf.nist.gov/10.8.E1 ; small positive arguments only.
    """
    if not 0 < x < 15:
        raise ValueError('Positive diagnostic argument below 15 required')
    term, j, ysum, harmonic = x/2, 0., 0., 0.
    for k in range(100):
        j += term
        ysum += (2*harmonic+1/(k+1)-2*0.5772156649015328606)*term
        if k > 20 and abs(term) < 1e-18:
            break
        harmonic += 1/(k+1)
        term *= -(x*x/4)/((k+1)*(k+2))
    else:
        raise ArithmeticError('Bessel series did not converge')
    return complex(j, 2/math.pi*math.log(x/2)*j-2/(math.pi*x)-ysum/math.pi)


def loaded_dll(sdk):
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    kernel.GetModuleHandleW.restype = wintypes.HMODULE
    kernel.GetModuleFileNameW.argtypes = [wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD]
    kernel.GetModuleFileNameW.restype = wintypes.DWORD
    handle = kernel.GetModuleHandleW('openEMS.dll');name = ctypes.create_unicode_buffer(32768)
    if not 0 < kernel.GetModuleFileNameW(handle, name, len(name)) < len(name):
        raise RuntimeError('Cannot identify the loaded openEMS DLL')
    path = Path(name.value).resolve(strict=True)
    if path != (sdk/'openEMS.dll').resolve(strict=True):
        raise RuntimeError(f'Loaded DLL outside the supplied directory: {path}')
    return dict(path=str(path), sha256=digest(path))


def reject_cartesian(output):
    """Unsupported opt-in use returns native setup code 2, without fields."""
    import numpy as np
    from fairbeam.simulation import Simulation
    sim = Simulation(2.8e9, 3.8e9, boundaries=['PML_8']*6)
    for axis in 'xyz':
        sim.mesh.AddLine(axis, np.linspace(-40., 40., 33))
    sim.csx.AddExcitation('source', exc_type=0, exc_val=[0, 1, 0]).AddBox([0, 0, 0], [0, 1, 0])
    class ReturnSpy:
        def __init__(self, native):self.native, self.code = native, None
        def __getattr__(self, name):return getattr(self.native, name)
        def Run(self, *args, **kwargs):
            self.code = self.native.Run(*args, **kwargs)
            return self.code
    spy = ReturnSpy(sim.fdtd);sim.fdtd = spy
    stats = sim.run(str(output), threads=1, engine='cpu', exact=True, echo=True,
                    setup_only=True, pml_cylindrical_metric='1')
    if spy.code != 2 or stats.get('converged') or stats.get('timesteps', 0):
        raise RuntimeError('Unsupported geometry was not refused before fields')
    save(output/'refusal.json', dict(native_setup_code=spy.code, field_steps=0))


def acquire(output, metric, dll):
    import numpy as np
    from CSXCAD import ContinuousStructure
    from tests import dielectric_resonator_fixture as fixture
    from openEMS.physical_constants import C0
    output.mkdir()
    # Uniform vacuum between probes, closed azimuth, z-independent TEphi field.
    start, dt, actual = 34.13, 2.8975964117282395e-13, 16
    sim = fixture.ResonatorSimulation(2.8e9, 3.8e9,
        boundaries=['PEC', 'PML_16', 'PEC', 'PEC', 'PMC', 'PMC'], end_criteria_db=-80)
    csx = ContinuousStructure(CoordSystem=1);sim.fdtd.SetCSX(csx)
    sim.csx, sim.mesh = csx, csx.GetGrid();sim.mesh.SetDeltaUnit(sim.unit)
    sim.mesh.SetMeshType(1);sim.fdtd.SetCoordSystem(1)
    for axis, lines in zip('xyz', (np.r_[np.arange(0, 34., .5), start,
            start+np.arange(1, actual+1)*1.5], np.linspace(0, 2*np.pi, 5), [-1., 0., 1.])):
        sim.mesh.AddLine(axis, lines)
    steps = math.ceil(20e-9/dt);sim.max_timesteps = steps
    sim.fdtd.SetTimeStep(dt);sim.fdtd.SetNumberOfTimeSteps(steps);sim.fdtd.SetOverSampling(4)
    csx.AddExcitation('radial_TE_source', exc_type=0, exc_val=[0, 1, 0]).AddBox(
        [2., 0., -1.], [3., 2*np.pi, 1.])
    radii = np.array([12., 18., 24., 30.])*sim.unit
    for i, r in enumerate(radii/sim.unit):
        csx.AddProbe(f'e{i}', p_type=0).AddBox([r, 0., 0.], [r, np.pi/2, 0.])
    sim.fdtd.Write2XML(str(output/'input.xml'))
    options = dict(pml_grading_cells='8', dump_statistics=True)
    if metric:
        options['pml_cylindrical_metric'] = '1'
    sim.run(str(output/'raw'), threads=1, engine='cpu', exact=True, echo=True, **options)
    stats = np.loadtxt(output/'raw/openEMS_stats.txt', comments='%')
    if stats[0] != 1530 or not np.isclose(stats[1], dt, rtol=1e-12, atol=0):
        raise RuntimeError('Native grid or clock differs')
    if not sim.run_stats.get('converged') or not 2e-9 < stats[3] < steps*dt:
        raise RuntimeError('Completed source and natural stop required')
    traces = [np.loadtxt(output/f'raw/e{i}', comments='%') for i in range(4)]
    for trace in traces:
        if trace.ndim != 2 or trace.shape[1] != 2 or len(trace) < 32 or not np.isfinite(trace).all():
            raise RuntimeError('Finite matching diagnostic traces required')
        np.testing.assert_array_equal(trace[:, 0], traces[0][:, 0])
    t = traces[0][:, 0]
    fields = np.array([v[:, 1] for v in traces])/(radii[:, None]*np.pi/2)
    if float(np.max(abs(fields))) <= 1e-12:
        raise RuntimeError('Diagnostic excitation is not measurable')
    rows = []
    for frequency in (3e9, 3.3e9, 3.6e9):
        amplitude = np.trapezoid(fields*np.exp(-2j*np.pi*frequency*t), x=t, axis=1)
        h = np.array([hankel_one(2*np.pi*frequency*r/C0) for r in radii])
        design = np.array([h.conj(), h]).T
        fit = np.linalg.solve(design[[0, 2]], amplitude[[0, 2]])
        heldout = max(abs((design@fit-amplitude)[[1, 3]]))/max(abs(amplitude))
        if np.linalg.cond(design[[0, 2]]) > 10 or heldout > .005:
            raise RuntimeError('Outgoing/incoming fit is not identifiable on held-out probes')
        rows.append(dict(f_hz=frequency, incoming_over_outgoing=float(abs(fit[1]/fit[0])),
                         heldout_relative=float(heldout)))
    save(output/'receipt.json', dict(dll=dll, options=options, source_cache={
        name:digest(output/'raw'/name) for name in ('et', 'ht')}, rows=rows,
        native_stats=stats.tolist(), input_sha256=digest(output/'input.xml'), qualified=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path);parser.add_argument('--candidate', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--child', choices=('baseline', 'candidate'))
    args = parser.parse_args();output = args.output.resolve()
    if args.child:
        from openEMS import openEMS  # Load from the explicitly supplied prefix before auditing.
        sdk = getattr(args, args.child).resolve(strict=True);dll = loaded_dll(sdk)
        if args.child == 'candidate':
            reject_cartesian(output/'unsupported-cartesian')
        for name, metric in ([('default', False)] if args.child == 'baseline' else
                             [('default', False), ('metric', True), ('reset', False)]):
            print('CASE_BEGIN:'+name, flush=True);acquire(output/name, metric, dll)
            print('CASE_END:'+name, flush=True)
        return
    if os.name != 'nt' or args.baseline is None or args.candidate is None:
        parser.error('Two explicit private Windows SDK directories required')
    if output.exists():
        raise RuntimeError('Use a fresh output; existing evidence is retained')
    output.mkdir(parents=True)
    from fairbeam.procutil import popen_group, release_group, terminate_group
    record = dict(script_sha256=digest(__file__), complete=False, qualified=False, stages=[])
    try:
        for variant in ('baseline', 'candidate'):
            sdk = getattr(args, variant).resolve(strict=True);stage = output/variant;stage.mkdir()
            env = dict(os.environ, OPENEMS_INSTALL_PATH=str(sdk), CSXCAD_INSTALL_PATH=str(sdk),
                       OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1', PYTHONUTF8='1')
            command = [sys.executable, str(Path(__file__).resolve()), '--child', variant,
                       f'--{variant}', str(sdk), '--output', str(stage)]
            with (output/f'{variant}.log').open('wb') as log:
                process = popen_group(command, stdout=log, stderr=subprocess.STDOUT, env=env)
                start, wall = time.monotonic(), time.time()
                try:
                    while True:
                        remaining = 120-max(time.monotonic()-start, time.time()-wall)
                        if remaining <= 0:
                            raise TimeoutError('Private diagnostic exceeded 120 wall seconds')
                        try:
                            code = process.wait(timeout=min(1., remaining))
                            if max(time.monotonic()-start, time.time()-wall) > 120:
                                raise TimeoutError('Private diagnostic exceeded 120 wall seconds')
                            break
                        except subprocess.TimeoutExpired:
                            pass
                finally:
                    if process.poll() is None:
                        terminate_group(process.pid, grace=0, job=process.win_job);process.wait(timeout=15)
                    release_group(process)
            record['stages'].append(dict(variant=variant, command=command, exit=code))
            if code:
                raise RuntimeError(f'{variant} failed; retain its log')
        import numpy as np
        baseline = output/'baseline/default'
        for name in ('default', 'reset'):
            candidate = output/f'candidate/{name}'
            for i in range(4):
                np.testing.assert_array_equal(np.loadtxt(baseline/f'raw/e{i}', comments='%'),
                                              np.loadtxt(candidate/f'raw/e{i}', comments='%'))
        original = json.loads((baseline/'receipt.json').read_text())['rows']
        corrected = json.loads((output/'candidate/metric/receipt.json').read_text())['rows']
        if any(b['incoming_over_outgoing'] > .005 or b['incoming_over_outgoing'] >= a['incoming_over_outgoing']/10
               for a, b in zip(original, corrected)):
            raise AssertionError('Metric did not reduce identifiable reflection by at least ten times')
        record.update(complete=True, original=original, corrected=corrected, defaults_bitwise_equal=True)
    finally:
        save(output/'receipt.json', record)


if __name__ == '__main__':
    main()
