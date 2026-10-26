"""Independent, opt-in clock controls for the existing TE10 step model.

Only the native clock and corresponding step allocation change. The geometry,
Gaussian source, measurement planes and analytical/numerical limits come from
waveguide_step_fixture. No gallery or production source is modified.
"""
import hashlib
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

import numpy as np
from fairbeam.multiport import assemble_s
from tests import waveguide_step_fixture as base
from tests import coupled_stripline_fixture as environment

ROOT = Path(__file__).resolve().parents[2]
FACTORS = (1., .9, .75)
PROTOCOL = 'te10-step-clock-control-v1'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False)+'\n', encoding='utf-8')


def identity():
    names = ('tests/waveguide_step_clock_fixture.py', 'tests/test_waveguide_step_clock.py',
             'tests/waveguide_step_fixture.py', 'tests/test_coax_resonator.py',
             'tests/coupled_stripline_fixture.py', 'fairbeam/simulation.py',
             'fairbeam/multiport.py', 'fairbeam/procutil.py')
    return {name: sha(ROOT/'python'/name) for name in names}


def max_steps(factor):
    if isinstance(factor, bool) or not isinstance(factor, (int, float)) or factor not in FACTORS:
        raise ValueError('clock factor must be 1, 0.9 or 0.75')
    return math.ceil(200000/factor)


def build(cpw, excited, padding=base.PADDING, *, factor=1.):
    steps = max_steps(factor)
    sim = base.build(cpw, excited, padding)
    if factor != 1.:
        sim.fdtd.SetTimeStepFactor(factor)
        sim.fdtd.SetNumberOfTimeSteps(steps)
        sim.max_timesteps = steps
    sim._step_clock_factor = factor
    return sim


def write_input(sim, path):
    sim.fdtd.Write2XML(str(path))
    if sim._step_clock_factor != 1.:
        # The installed native writer omits factors below one, although its
        # operator applies them and its XML reader accepts this attribute.
        tree = ET.parse(path)
        tree.getroot().find('FDTD').set('TimeStepFactor', str(sim._step_clock_factor))
        tree.write(path, encoding='utf-8', xml_declaration=True)


def physical_sha(path):
    root = ET.parse(path).getroot()
    for parent in root.iter():
        for child in list(parent):
            if child.tag in ('FillColor', 'EdgeColor'):
                parent.remove(child)
    return hashlib.sha256(ET.tostring(root)).hexdigest()


def clock_quality(audit, actual_dt):
    try:
        factor = audit['factor']
        reference, selected = audit['reference'], audit['selected']
        clocks = [v['run']['timestep_s'] for v in (reference, selected)]
        return bool(all(not isinstance(t, bool) and isinstance(t, (int, float)) and np.isfinite(t) and t > 0
                        for t in clocks+[actual_dt])
            and abs(clocks[1]/clocks[0]-factor) <= 6e-6
            and abs(actual_dt/clocks[1]-1) <= 6e-6
            and reference['run']['grid'] == selected['run']['grid']
            and reference['max_timesteps'] == 200000 and selected['max_timesteps'] == max_steps(factor)
            and all(v['run'].get('timesteps', 0) == 0 and v['run']['threads'] == 4
                    and v['run']['engine'] == 'cpu' and v['run']['exact_endcriteria'] is True
                    and v['run'].get('converged') is False for v in (reference, selected)))
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return False


def admit_clock(out, cpw, excited, padding, factor):
    audit = dict(factor=factor)
    for name, selected in (('reference', 1.), ('selected', factor)):
        sim = build(cpw, excited, padding, factor=selected)
        path = Path(out)/(name+'-clock.xml')
        write_input(sim, path)
        run = sim.run(str(Path(out)/(name+'-clock')), threads=4, exact=True, echo=True, setup_only=True)
        audit[name] = dict(run=run, max_timesteps=max_steps(selected), input_sha256=sha(path))
    save(Path(out)/'clock-audit.json', audit)
    if not clock_quality(audit, audit['selected']['run']['timestep_s']):
        raise ValueError('native clock reduction failed admission before propagation')
    return audit


def native_stats(path):
    a = np.loadtxt(path, comments='%')
    return dict(cells=int(a[0]), dt_s=float(a[1]), timesteps=int(a[2]),
                numerical_time_s=float(a[3]), iteration_wall_s=float(a[4]))


def source_cache(raw, dt):
    records = {}
    for name, offset in (('et', 0.), ('ht', .5)):
        path = Path(raw)/name
        a = np.loadtxt(path, ndmin=2)
        expected = int(np.ceil(base.PULSE_END_S/dt))
        if (a.ndim != 2 or a.shape[1] != 2 or not np.isfinite(a).all()
                or not np.any(a[:, 1])
                or abs(len(a)-expected) > 1
                or not np.allclose(a[:, 0], (np.arange(len(a))+offset)*dt, rtol=6e-6, atol=dt*1e-5)):
            raise ValueError('native Gaussian cache/support/clock changed')
        records[name] = dict(sha256=sha(path), samples=len(a))
    return dict(records=records, complete_after_steps=int(np.ceil(base.PULSE_END_S/dt))+1)


def port_data(sim, raw):
    sim.sim_path = str(raw)
    sim.evaluate(n_freq=len(base.FREQUENCIES))
    ports = sim._port_objs
    z = np.array([np.broadcast_to(p.Z_ref, base.FREQUENCIES.shape) for p in ports])
    return dict(f=base.FREQUENCIES, a=np.array([p.uf_inc for p in ports])/np.sqrt(z),
                b=np.array([p.uf_ref for p in ports])/np.sqrt(z), z_ref=z,
                voltage=np.array([p.uf_tot for p in ports]), current=np.array([p.if_tot for p in ports]))


def acquire(out, cpw, excited, padding=base.PADDING, *, factor=1.):
    sim = build(cpw, excited, padding, factor=factor)
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    source, runtime = identity(), environment.runtime_identity()
    write_input(sim, out/'input.xml')
    audit = admit_clock(out, cpw, excited, padding, factor) if factor != 1. else None
    print('FAIRBEAM-STEP-CLOCK-PROPAGATION-BEGIN', flush=True)
    sim.run(str(out/'raw'), threads=4, exact=True, echo=True, dump_statistics=True)
    native = native_stats(out/'raw/openEMS_stats.txt')
    if audit is not None and not clock_quality(audit, native['dt_s']):
        raise ValueError('actual propagation clock differs from admitted operator')
    data = port_data(sim, out/'raw')
    np.savez_compressed(out/'data.npz', **data)
    names = {name for p in sim._port_objs for name in tuple(p.U_filenames)+tuple(p.I_filenames)}
    meta = dict(protocol=PROTOCOL, cpw=cpw, excited=excited, padding=padding, factor=factor,
                max_timesteps=max_steps(factor), geometry=base.geometry(), frequency_hz=base.FREQUENCIES.tolist(),
                limits=base.LIMITS, source=source, runtime=runtime, native=native, run=sim.run_stats,
                input_sha256=sha(out/'input.xml'), physical_input_sha256=physical_sha(out/'input.xml'),
                data_sha256=sha(out/'data.npz'), native_stats_sha256=sha(out/'raw/openEMS_stats.txt'),
                probe_sha256={name: sha(out/'raw'/name) for name in sorted(names)},
                source_cache=source_cache(out/'raw', native['dt_s']), clock_audit=audit,
                clock_audit_sha256=sha(out/'clock-audit.json') if audit is not None else None)
    if identity() != source or environment.runtime_identity() != runtime:
        raise ValueError('source/runtime changed during capture')
    save(out/'report.json', meta)
    return meta


def read_source(path, cpw, excited, padding, factor):
    path = Path(path)
    m = json.loads((path/'report.json').read_text(encoding='utf-8'))
    expected = dict(protocol=PROTOCOL, cpw=cpw, excited=excited, padding=padding, factor=factor,
                    max_timesteps=max_steps(factor), geometry=base.geometry(), frequency_hz=base.FREQUENCIES.tolist(),
                    limits=base.LIMITS, source=identity(), runtime=environment.runtime_identity())
    if any(m.get(k) != v for k, v in expected.items()):
        raise ValueError('clock cohort/source/runtime/model identity mismatch')
    run, native = m['run'], m['native']
    energy = [run[k] for k in ('final_energy_db', 'final_energy_bound_db')
              if isinstance(run.get(k), (int, float)) and np.isfinite(run[k])]
    if (run.get('converged') is not True or run.get('hit_timestep_limit') is not False
            or run.get('threads') != 4 or run.get('engine') != 'cpu' or run.get('exact_endcriteria') is not True
            or not 0 < native['timesteps'] == run.get('timesteps') < max_steps(factor)
            or not energy or max(energy) > base.END_DB+1e-9
            or not isinstance(m.get('case_elapsed_s'), (int, float))
            or not np.isfinite(m['case_elapsed_s']) or not 0 < m['case_elapsed_s'] <= base.CASE_SECONDS
            or not 0 < run.get('wall_time_s', float('inf')) <= base.CASE_SECONDS):
        raise ValueError('source lacks a complete in-budget exact native stop')
    receipt = json.loads(path.with_name(path.name+'.worker.json').read_text(encoding='utf-8'))
    if (receipt['exit_code'] != 0 or receipt['failure'] is not None or receipt['deadline_seconds'] != base.CASE_SECONDS
            or max(receipt['wall_seconds'], receipt['monotonic_seconds']) > base.CASE_SECONDS
            or receipt['source'] != m['source']):
        raise ValueError('owned worker receipt changed or exceeded its deadline')
    for rel, key in (('input.xml', 'input_sha256'), ('data.npz', 'data_sha256'),
                     ('raw/openEMS_stats.txt', 'native_stats_sha256')):
        if sha(path/rel) != m[key]:
            raise ValueError('native input/data/statistics changed')
    if native != native_stats(path/'raw/openEMS_stats.txt') or native['cells'] != int(np.prod(run['grid'])):
        raise ValueError('native statistics mismatch')
    if not np.isclose(native['numerical_time_s'], native['dt_s']*native['timesteps'], rtol=1e-8, atol=0):
        raise ValueError('native time mismatch')
    cache = source_cache(path/'raw', native['dt_s'])
    if cache != m['source_cache'] or native['timesteps'] < cache['complete_after_steps']:
        raise ValueError('incomplete native source')
    if factor != 1.:
        audit = json.loads((path/'clock-audit.json').read_text(encoding='utf-8'))
        if (audit != m['clock_audit'] or audit['factor'] != factor or not clock_quality(audit, native['dt_s'])
                or audit['selected']['run']['grid'] != run['grid'] or sha(path/'clock-audit.json') != m['clock_audit_sha256']
                or any(sha(path/(name+'-clock.xml')) != audit[name]['input_sha256'] for name in ('reference', 'selected'))):
            raise ValueError('native operator clock admission changed')
    sim = build(cpw, excited, padding, factor=factor)
    import tempfile
    with tempfile.TemporaryDirectory() as folder:
        rebuilt = Path(folder)/'input.xml'
        write_input(sim, rebuilt)
        if physical_sha(rebuilt) != m['physical_input_sha256']:
            raise ValueError('rebuilt native physical input changed')
    for name, want in m['probe_sha256'].items():
        if sha(path/'raw'/name) != want:
            raise ValueError('raw port probe changed')
    with np.load(path/'data.npz', allow_pickle=False) as archive:
        data = dict(archive)
    sim.run_stats = run
    fresh = port_data(sim, path/'raw')
    for key in fresh:
        np.testing.assert_array_equal(fresh[key], data[key])
    if (not np.array_equal(data['f'], base.FREQUENCIES)
            or any(data[k].shape != (2, len(base.FREQUENCIES)) or not np.isfinite(data[k]).all()
                   for k in ('a', 'b', 'z_ref'))
            or not np.allclose(data['z_ref'], base.modes()[1], rtol=1e-8, atol=0)):
        raise ValueError('finite fixed-grid modal spectra required')
    return m, data


def read_pair(root, cpw, padding, factor):
    data = [read_source(Path(root)/f'cpw{cpw}'/f'pad{padding}'/f'e{pn}', cpw, pn, padding, factor)[1] for pn in (1, 2)]
    incoming = np.array([d['a'] for d in data])
    if np.any(np.linalg.cond(incoming.transpose(2, 1, 0)) > 1e4):
        raise ValueError('ill-conditioned incoming-wave matrix')
    return assemble_s(incoming, np.array([d['b'] for d in data]), [1, 2], 2)


def compare(root, factor):
    max_steps(factor)
    spectra, rejected = {}, []
    cohorts = [(n, base.PADDING) for n in base.MESHES]+[(base.CONTROL_MESH, base.CONTROL_PADDING)]
    for cpw, padding in cohorts:
        try:
            spectra[cpw, padding] = read_pair(root, cpw, padding, factor)
        except (FileNotFoundError, ValueError, AssertionError) as error:
            rejected.append(dict(cpw=cpw, padding=padding, reason=repr(error)))

    def metrics(s):
        result = dict(target_abs_max=float(abs(s-base.reference()).max()),
                      reciprocity_abs_max=float(abs(s[:, 0, 1]-s[:, 1, 0]).max()),
                      power_error_max=float(abs(np.sum(abs(s)**2, axis=1)-1).max()))
        result['passes'] = (result['target_abs_max'] <= base.LIMITS['target_abs']
                            and result['reciprocity_abs_max'] <= base.LIMITS['reciprocity_abs']
                            and result['power_error_max'] <= base.LIMITS['power_abs'])
        return result

    rows = [dict(cpw=n, **metrics(spectra[n, base.PADDING])) for n in base.MESHES if (n, base.PADDING) in spectra]
    changes = []
    for first, second in zip(base.MESHES, base.MESHES[1:]):
        if (first, base.PADDING) in spectra and (second, base.PADDING) in spectra:
            change = float(abs(spectra[second, base.PADDING]-spectra[first, base.PADDING]).max())
            changes.append(dict(first=first, second=second, change_abs_max=change, passes=change <= base.LIMITS['mesh_abs']))
    boundary, control = None, None
    if (base.CONTROL_MESH, base.PADDING) in spectra and (base.CONTROL_MESH, base.CONTROL_PADDING) in spectra:
        control_s = spectra[base.CONTROL_MESH, base.CONTROL_PADDING]
        boundary = float(abs(control_s-spectra[base.CONTROL_MESH, base.PADDING]).max())
        control = metrics(control_s)
    checks_pass = bool(not rejected and len(rows) == 3 and all(r['passes'] for r in rows)
                     and len(changes) == 2 and all(r['passes'] for r in changes)
                     and boundary is not None and boundary <= base.LIMITS['boundary_abs']
                     and control is not None and control['passes'])
    return dict(protocol=PROTOCOL, factor=factor, limits=base.LIMITS, rows=rows, changes=changes,
                rejected=rejected, boundary_abs_max=boundary, boundary_control=control,
                numerical_checks_pass=checks_pass, qualified_scope=False, diagnostic_only=True,
                qualification_blocker='First native energy-threshold crossing is not a late-time stability certificate; '
                    'independent continuation evidence is required.',
                scope='TE10 clock-sensitivity diagnostic; no temporal-stability or application qualification')
