"""Fixed physical support for a finite TEM mesh diagnostic (Example 8.1).

The original fixture and its qualification remain unchanged. This adapter
holds a point load or three C/3 columns fixed while refining the interior.
Native execution is opt-in through tests.test_loaded_tem_fixed_support.
"""
from contextlib import contextmanager
from copy import deepcopy
import json
import math
from pathlib import Path
import sys

import numpy as np
from fairbeam.network import network_s
from tests import loaded_tem_cell_fixture as f

PITCH = f.HEIGHT / 32
HALF_DOMAIN, PML_WIDTH, BACKING_PITCH = .02, .001, f.HEIGHT / 4
PILOT_S, PILOT_DEADLINE, DEADLINE = .25e-9, 600., 2700.
WORKER_MODULE = 'tests.test_loaded_tem_fixed_support'
SCOPE = ('Fixed point/three-column support, total incremental C, physical PML extent, '
         'source/measurement/PEC/PMC planes and common clock; interior mesh refinement. '
         'A finite TEM diagnostic, not a whole-example qualification.')
_build, _identity = f.build, f.identity


def identity():
    return {**_identity(), **{name: f.sha(f.ROOT/'python'/name) for name in (
        'tests/loaded_tem_fixed_support_fixture.py', 'tests/test_loaded_tem_fixed_support.py')}}


def build(n, count, port, kind='loaded', control='ordinary', *, pilot=False, element_scale=1):
    f._choice(n, f.MESHES, 'mesh')
    f._choice(port, (1, 2), 'source')
    if (isinstance(count, bool) or not isinstance(count, int) or count != 1 or kind != 'loaded'
            or control not in ('ordinary', 'element') or not isinstance(pilot, bool)
            or isinstance(element_scale, bool) or not isinstance(element_scale, int) or element_scale != 1):
        raise ValueError('one declared loaded fixed-support pair required')
    sim, meta = _build(n, count, port, kind, control)
    old_x = np.asarray(meta['mesh_mm']['x'])
    x = old_x * sim.unit
    core = x[abs(x) <= HALF_DOMAIN-PML_WIDTH+1e-14]
    faces = np.linspace(HALF_DOMAIN-PML_WIDTH, HALF_DOMAIN, 9)
    x = np.unique(np.round(np.r_[core, faces, -faces, np.arange(-8, 9)*PITCH], 15))
    z = np.r_[np.linspace(0., f.HEIGHT, n+1), f.HEIGHT+BACKING_PITCH]
    sim.mesh.SetLines('x', x/sim.unit)
    sim.mesh.SetLines('z', z/sim.unit)
    properties = {p.GetName(): p for p in sim.csx.GetAllProperties()}
    upper = properties['upper_conductor'].GetAllPrimitives()[0]
    a, b = np.array(upper.GetStart()), np.array(upper.GetStop())
    a[0], b[0], b[2] = x[0]/sim.unit, x[-1]/sim.unit, z[-1]/sim.unit
    upper.SetStart(a)
    upper.SetStop(b)

    radius = 1 if control == 'element' else 0
    air = f.EPS0*f.WIDTH*(2*radius+1)*PITCH/f.HEIGHT
    capacitor = properties['cell_C1']
    capacitor.SetCapacity(f.CAPACITANCE+air)
    box = capacitor.GetAllPrimitives()[0]
    a, b = np.array(box.GetStart()), np.array(box.GetStop())
    a[0], b[0] = -radius*PITCH/sim.unit, radius*PITCH/sim.unit
    box.SetStart(a)
    box.SetStop(b)
    declaration = next(p for p in sim.lumped_elements if p['name'] == 'cell_C1')
    declaration.update(C=float(f.CAPACITANCE+air), start=a.tolist(), stop=b.tolist())
    meta['native_capacitors'][0].update(native_capacitance_f=float(f.CAPACITANCE+air),
        replaced_air_capacitance_f=float(air), start_x_m=-radius*PITCH, stop_x_m=radius*PITCH)

    new_x = np.asarray(sim.mesh.GetLines('x'))
    indices = deepcopy(meta['expected_current_indices'])
    for ends in indices.values():
        for end in ends:
            position = old_x[end[0]]
            ix = int(np.argmin(abs(new_x-position)))
            if abs(new_x[ix]-position) > 1e-10:
                raise ValueError('a measurement plane moved during refinement')
            end[0] = ix
    clock = .5/(f.C0*np.sqrt(1/PITCH**2+(max(f.MESHES)/f.HEIGHT)**2+(8*max(f.MESHES)/f.WIDTH)**2))
    cap = PILOT_S if pilot else f.CAP_S
    steps = math.ceil(cap/clock)
    sim.fdtd.SetTimeStep(float(clock))
    sim.fdtd.SetNumberOfTimeSteps(steps)
    sim.max_timesteps = steps
    if pilot:
        sim.fdtd.SetEndCriteria(0.)
    mesh = {axis: sim.mesh.GetLines(axis).tolist() for axis in 'xyz'}
    grid = [len(mesh[axis]) for axis in 'xyz']
    if sim.csx.Update():
        raise ValueError('invalid fixed-support native geometry')
    meta.update(protocol='loaded-tem-fixed-support-v1', mesh_mm=mesh, grid=grid,
        native_cells=math.prod(grid), declared_dt_s=float(clock), max_timesteps=steps, cap_s=cap,
        expected_current_indices=indices, support_pitch_m=PITCH,
        pml_physical_width_m=PML_WIDTH, backing_pitch_m=BACKING_PITCH,
        pilot_only=pilot, scope=SCOPE)
    return sim, meta


@contextmanager
def model_context(pilot=False):
    if not isinstance(pilot, bool) or f.build is not _build or f.identity is not _identity:
        raise ValueError('one non-nested fixed-support context required')
    def model(n, count, port, kind='loaded', control='ordinary', **kwargs):
        return build(n, count, port, kind, control, pilot=pilot, **kwargs)
    try:
        f.build, f.identity = model, identity
        yield
    finally:
        f.build, f.identity = _build, _identity


def reference(control, freq=f.FREQUENCIES):
    if control not in ('ordinary', 'element'):
        raise ValueError('declared point or three-shunt model required')
    # Reuse the existing real-frequency/range admission before nodal stamping.
    f.reference(freq=freq)
    frequencies = np.asarray(freq, float)
    if control == 'ordinary':
        return network_s(frequencies, [0, 2],
            [(0, 1, f.Z0, f.PERIOD/2/f.C0), (1, 2, f.Z0, f.PERIOD/2/f.C0)],
            admittances=[(1, -1, 2j*np.pi*frequencies*f.CAPACITANCE)])
    h = PITCH
    lengths = (f.PERIOD/2-h, h, h, f.PERIOD/2-h)
    return network_s(frequencies, [0, 4],
        [(j, j+1, f.Z0, length/f.C0) for j, length in enumerate(lengths)],
        admittances=[(j, -1, 2j*np.pi*frequencies*f.CAPACITANCE/3) for j in (1, 2, 3)])


def configurations():
    return [(f'n{n}_'+('point' if control == 'ordinary' else 'spread'), n, control)
            for n in f.MESHES for control in ('ordinary', 'element')]


def admit_closing(folder, n, control):
    folder = Path(folder).resolve()
    protocol_path = folder/'protocol.json'
    protocol = json.loads(protocol_path.read_text())
    if (protocol['pilot_only'] or protocol['source'] != identity() or protocol['runtime'] != f.runtime_identity()
            or protocol['n'] != n or protocol['control'] != control or protocol['deadline_seconds'] != DEADLINE):
        raise ValueError('matching full fixed-support protocol required')
    for port in (1, 2):
        closing = json.loads((folder/f'port{port}.worker.json').read_text())
        meta = json.loads((folder/f'port{port}/report.json').read_text())
        times = closing['wall_seconds'], closing['monotonic_seconds']
        if (closing['exit_code'] != 0 or closing.get('failure') is not None
                or closing['deadline_seconds'] != DEADLINE
                or not all(isinstance(x, (int, float)) and not isinstance(x, bool)
                           and np.isfinite(x) and 0 <= x <= DEADLINE for x in times)
                or meta['pilot_only'] or meta['fixed_support_protocol_sha256'] != f.sha(protocol_path)):
            raise ValueError('owned full-source closing admission failed')
        pid = closing['pid']
        if (isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0
                or pid not in (meta['worker_pid'], meta['worker_parent_pid'])
                or max(times) < meta['native']['iteration_wall_s']
                or f.sha(folder/f'port{port}.log') != meta['native_log_sha256']):
            raise ValueError('native worker ownership, timing or log differs from its receipt')
        command = closing['command']
        if (command[:3] != [sys.executable, '-m', WORKER_MODULE] or '--worker' not in command
                or '--pilot' in command):
            raise ValueError('unexpected native worker route')
        for flag, value in (('--mesh', n), ('--control', control), ('--port', port)):
            if command.count(flag) != 1 or command[command.index(flag)+1] != str(value):
                raise ValueError('native worker arguments differ from the cohort')
        if (command.count('--out') != 1
                or Path(command[command.index('--out')+1]).resolve() != folder/f'port{port}'):
            raise ValueError('native worker output differs from the cohort')
        row = next(x for x in protocol['rows'] if x['port'] == port)
        if (f.sha(folder/f'port{port}/input.xml') != row['input_sha256']
                or f.sha(folder/f'port{port}/operator-input.xml') != row['operator_input_sha256']):
            raise ValueError('captured native input differs from its prospective hash')


def difference(a, b):
    ga, za = f.bloch(f.chain(a))
    gb, zb = f.bloch(f.chain(b))
    return dict(s_abs=float(abs(b-a).max()), phase_deg=f.phase_change(b, a),
                beta_rel=float(abs(gb.imag/ga.imag-1).max()), z_rel=float(abs(zb/za-1).max()))


def passes(row, family):
    return all(np.isfinite(row[key]) and row[key] <= f.LIMITS[limit] for key, limit in (
        ('s_abs', f's_{family}_abs'), ('phase_deg', f'phase_{family}_deg'),
        ('beta_rel', f'beta_{family}_rel'), ('z_rel', f'z_{family}_rel')))


def study(root):
    data, cohorts, missing, rejected = {}, [], [], []
    with model_context():
        for name, n, control in configurations():
            folder = Path(root)/name
            try:
                admit_closing(folder, n, control)
                actual, record = f.matrix(folder)
                target = reference(control)
                error = float(abs(actual-target).max())
                phase = f.phase_change(actual, target)
                good = (record['all_native_complete'] and record['target_passes']
                    and error <= f.LIMITS['s_target_abs'] and phase <= f.LIMITS['phase_target_deg'])
                if not good:
                    raise ValueError('native, measurement or circuit-reference gate failed')
                data[n, control] = actual
                cohorts.append(dict(name=name, **record, separate_reference_s_error=error,
                                    separate_reference_phase_deg=phase))
            except FileNotFoundError:
                missing.append(name)
            except (AssertionError, KeyError, ValueError, StopIteration) as error:
                rejected.append(dict(name=name, reason=repr(error)))
    meshes, controls = [], []
    for control in ('ordinary', 'element'):
        for a, b in zip(f.MESHES, f.MESHES[1:]):
            if (a, control) in data and (b, control) in data:
                row = difference(data[a, control], data[b, control])
                meshes.append(dict(meshes=[a, b], control=control, **row, passes=passes(row, 'mesh')))
    for n in f.MESHES:
        if (n, 'ordinary') in data and (n, 'element') in data:
            row = difference(data[n, 'ordinary'], data[n, 'element'])
            controls.append(dict(n=n, **row, passes=passes(row, 'control')))
    good = (not missing and not rejected and len(cohorts) == 6 and len(meshes) == 4 and len(controls) == 3
            and all(x['passes'] for x in meshes+controls))
    return dict(scope=SCOPE, support_pitch_m=PITCH, total_incremental_c_f=f.CAPACITANCE,
        limits=f.LIMITS, cohorts=cohorts, missing=missing, rejected=rejected,
        mesh_changes=meshes, point_spread_controls=controls, fixed_geometry_mesh_passes=bool(good),
        qualified=False, original_study_reclassified=False,
        limitation='Only this finite fixed-support family; the original study and additional independence requirements remain separate.')
