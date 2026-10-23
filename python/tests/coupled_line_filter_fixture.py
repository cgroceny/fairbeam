"""Own thin-PEC stripline realization associated with Example 8.7, p. 435.

The specified circuit has no prescribed physical substrate. The declared
homogeneous stripline realization uses Cohn's existing conformal-map helper;
finite open ends and width junctions remain distinct from ideal modal lines.
No field response enters the synthesis or numerical acceptance limits.
"""
import math
import json
import re
import sys
from pathlib import Path

import numpy as np
from openEMS.physical_constants import C0
from openEMS import ports as native_ports
from openEMS.ports import UI_data
from fairbeam import Simulation, excitation, multiport
from tests.coax_resonator_fixture import save, sha

from tests import coupled_stripline_fixture as cohn
from tests.microstrip_fixture import graded

ROOT = Path(__file__).resolve().parents[2]
F0, FBW, RIPPLE_DB, Z0 = 2e9, .1, .5, 50.
B, ER, ORDER = 3.2, 2.2, 3
FREQUENCIES = np.linspace(1.5e9, 2.5e9, 401)
MESHES, KINDS = (0, 1, 2, 3), ('through', 'filter')
LOSSES = ('pec',)
STUDY_CONTROLS = ('time', 'dt', 'sidewall', 'plane', 'source')
DIAGNOSTIC_CONTROLS = ()
CONTROLS = ('ordinary', *STUDY_CONTROLS)
OVERSAMPLING = 4
MARKER = 'FAIRBEAM-COUPLED-LINE-FILTER-PROPAGATION-BEGIN'
FACTORS = {0: .4, 1: .5, 2: .75, 3: 1.}
CAP_S, END_DB, THREADS = 48e-9, -80., 4
LIMITS = dict(s_abs=.02, phase_deg=2., mesh_s_abs=.005, mesh_phase_deg=.5,
    control_s_abs=.0025, control_phase_deg=.2, contour_s_abs=.0025,
    recurrence_rel=.005, ground_half_rel=.005, incident_condition=30.,
    incident_floor=.02, reciprocity_abs=.005, singular_power_max=1.01,
    terminal_tail_db=-70.)


def prototype():
    epsilon = np.sqrt(10**(RIPPLE_DB/10)-1)
    gamma = np.sinh(np.arcsinh(1/epsilon)/ORDER)
    a = np.sin((2*np.arange(1, ORDER+1)-1)*np.pi/(2*ORDER))
    b = gamma**2+np.sin(np.arange(1, ORDER)*np.pi/ORDER)**2
    g = [1., 2*a[0]/gamma]
    for k in range(1, ORDER):
        g.append(4*a[k-1]*a[k]/(b[k-1]*g[-1]))
    return np.r_[g, 1.]


def modal_targets():
    g = prototype()
    j = np.r_[np.sqrt(np.pi*FBW/(2*g[0]*g[1])),
        np.pi*FBW/(2*np.sqrt(g[1:-2]*g[2:-1])),
        np.sqrt(np.pi*FBW/(2*g[-2]*g[-1]))]
    np.testing.assert_allclose(j, j[::-1], rtol=0, atol=1e-14)
    # Preserve the exact mathematical mirror rather than sub-ulp edge gaps.
    j[2:] = j[1::-1]
    return [(float(Z0*(1+k+k*k)), float(Z0*(1-k+k*k))) for k in j]


def _modulus(z):
    if not np.isfinite(z) or z <= 0:
        raise ValueError('positive modal impedance required')
    if (cohn.B, cohn.ER) != (B, ER):
        raise ValueError('declared Cohn substrate and helper disagree')
    lo, hi = 1e-12, 1-1e-12
    for _ in range(64):
        mid = (lo+hi)/2
        if cohn.mode_impedance(mid) > z:
            lo = mid
        else:
            hi = mid
    return (lo+hi)/2


def dimensions():
    sections = []
    for ze, zo in modal_targets():
        ke, ko = _modulus(ze), _modulus(zo)
        u, v = np.arctanh(np.sqrt(ke*ko)), np.arctanh(np.sqrt(ke/ko))
        sections.append(dict(even_ohm=ze, odd_ohm=zo,
            width_mm=float(2*B*u/np.pi), gap_mm=float(2*B*(v-u)/np.pi)))
    centre = 0.
    for k, section in enumerate(sections):
        if k:
            # Keep the new width step away from the preceding open tip.
            # A fixed centre with different widths can short that tip.
            centre = sections[k-1]['output_y_mm']+abs(section['width_mm']-sections[k-1]['width_mm'])/2
        section.update(input_y_mm=centre, output_y_mm=centre+section['width_mm']+section['gap_mm'])
    feed_width = float(2*B*np.arctanh(_modulus(Z0))/np.pi)
    feeds = np.array([sections[0]['input_y_mm']-(feed_width-sections[0]['width_mm'])/2,
        sections[-1]['output_y_mm']+(feed_width-sections[-1]['width_mm'])/2])
    origin = float(feeds.mean()); feeds -= origin
    for section in sections:
        for key in ('input_y_mm', 'output_y_mm'): section[key] -= origin
    length = C0/(4*F0*np.sqrt(ER))*1e3
    return dict(sections=sections, quarter_length_mm=length,
        junctions_mm=(np.arange(5)*length).tolist(), feed_centres_mm=feeds.tolist(),
        feed_width_mm=feed_width,
        ground_separation_mm=B, epsilon_r=ER, metal='zero-thickness PEC')


def reference(freq=FREQUENCIES, kind='filter', plane_mm=6., loss='pec'):
    if np.iscomplexobj(freq) or loss != 'pec':
        raise ValueError('real frequencies and the declared lossless case required')
    f = np.asarray(freq, float)
    if (kind not in KINDS or np.iscomplexobj(freq) or f.ndim != 1 or not f.size
            or not np.isfinite(f).all() or np.any((f < 1e9) | (f > 3e9))
            or not np.isfinite(plane_mm) or plane_mm <= 0):
        raise ValueError('declared kind, real frequencies in 1..3 GHz and positive planes required')
    total = np.broadcast_to(np.eye(2, dtype=complex), (len(f), 2, 2)).copy()
    if kind == 'through':
        theta = 2*np.pi*f*np.sqrt(ER)/C0*dimensions()['junctions_mm'][-1]*1e-3
        total[:, 0, 0] = total[:, 1, 1] = np.cos(theta)
        total[:, 0, 1], total[:, 1, 0] = 1j*Z0*np.sin(theta), 1j*np.sin(theta)/Z0
    else:
        theta = np.pi*f/(2*F0)
        for ze, zo in modal_targets():
            diagonal, cross = -1j*(ze+zo)/(2*np.tan(theta)), -1j*(ze-zo)/(2*np.sin(theta))
            block = np.empty_like(total)
            block[:, 0, 0] = block[:, 1, 1] = diagonal/cross
            block[:, 0, 1], block[:, 1, 0] = (diagonal**2-cross**2)/cross, 1/cross
            total = total@block
    theta = 2*np.pi*f*np.sqrt(ER)/C0*plane_mm*1e-3
    feed = np.empty_like(total)
    feed[:, 0, 0] = feed[:, 1, 1] = np.cos(theta)
    feed[:, 0, 1], feed[:, 1, 0] = 1j*Z0*np.sin(theta), 1j*np.sin(theta)/Z0
    t = feed@total@feed
    a, b, c, d = (t[:, i, j] for i, j in ((0, 0), (0, 1), (1, 0), (1, 1)))
    den = a+b/Z0+c*Z0+d
    s = np.empty_like(t)
    s[:, 0, 0], s[:, 1, 1] = (a+b/Z0-c*Z0-d)/den, (-a+b/Z0-c*Z0+d)/den
    # Every declared ideal reciprocal section has determinant one:
    # (diagonal/cross)^2 - ((diagonal^2-cross^2)/cross)/cross = 1,
    # and each matched feed has cos(theta)^2 + sin(theta)^2 = 1.
    # Their cascade therefore has S12 = S21 = 2/den. Recomputing a*d-b*c
    # subtracts large near-equal products in the stopband and loses digits.
    # This is an analytic reference identity, never a correction to measured S.
    s[:, 1, 0] = s[:, 0, 1] = 2/den
    return s


def prototype_loss(freq=FREQUENCIES):
    x = (np.asarray(freq)/F0-F0/np.asarray(freq))/FBW
    return 10*np.log10(1+(10**(RIPPLE_DB/10)-1)*(4*x**3-3*x)**2)


def _balanced(anchors, maximum):
    anchors = np.unique(np.round(anchors, 12))
    values = np.unique(np.concatenate([np.linspace(a, b, int(np.ceil((b-a)/maximum-1e-12))+1)
        for a, b in zip(anchors[:-1], anchors[1:])]))
    for _ in range(10000):
        h = np.diff(values)
        growth = np.maximum(h[1:]/h[:-1], h[:-1]/h[1:])
        if growth.max() <= 2*(1+1e-12): return values
        j = int(growth.argmax()); large = j if h[j] > h[j+1] else j+1
        count = int(np.ceil(h[large]/(2*min(h[j], h[j+1]))-1e-12))
        values = np.sort(np.r_[values, np.linspace(values[large], values[large+1], count+1)[1:-1]])
    raise ValueError('mesh neighbour growth did not settle')


def mesh_lines(n, control='ordinary'):
    if isinstance(n, bool) or not isinstance(n, int) or n not in MESHES or control not in CONTROLS:
        raise ValueError('declared integer mesh required')
    d = dimensions(); factor = FACTORS[n]; end = d['junctions_mm'][-1]
    maximum, dx = B/(2*factor), B/(8*factor)
    anchors = [-30., end+30., -24., end+24., -12., end+12., *d['junctions_mm']]
    for centre in (-9., -6., end+6., end+9.): anchors.extend((centre-dx, centre, centre+dx))
    x = _balanced(anchors, maximum)
    smallest = min([d['feed_width_mm'], *[s[k] for s in d['sections'] for k in ('width_mm', 'gap_mm')]])
    target = smallest/(3*factor)
    edge = max(abs(s[key])+s['width_mm']/2 for s in d['sections'] for key in ('input_y_mm', 'output_y_mm'))
    edge = max(edge, max(abs(c) for c in d['feed_centres_mm'])+d['feed_width_mm']/2)
    extent = edge+(8 if control == 'sidewall' else 6)*B
    inner = edge+2*target
    count = 2*math.ceil(inner/target)
    inside = np.linspace(-inner, inner, count+1); dy = inside[1]-inside[0]
    outward = graded(extent-inner, dy, maximum)
    if outward[-1]-outward[-2] < (outward[-2]-outward[-3])/2:
        outward[-2] = (outward[-3]+outward[-1])/2
    y = np.r_[-inner-outward[:0:-1], inside, inner+outward[1:]]
    positive = graded(B/2, dy/2, B/(4*factor))
    if positive[-1]-positive[-2] < (positive[-2]-positive[-3])/2:
        positive[-2] = (positive[-3]+positive[-1])/2
    z = np.r_[-positive[:0:-1], positive]
    return (np.r_[x[0]-maximum*np.arange(8, 0, -1), x, x[-1]+maximum*np.arange(1, 9)], y, z)


def identity():
    names = ('tests/coupled_line_filter_fixture.py', 'tests/test_coupled_line_filter_fixture.py',
        'tests/coupled_stripline_fixture.py', 'tests/microstrip_fixture.py',
        'tests/coax_resonator_fixture.py', 'tests/test_coax_resonator.py',
        'fairbeam/simulation.py', 'fairbeam/design.py', 'fairbeam/excitation.py',
        'fairbeam/multiport.py', 'fairbeam/procutil.py')
    return {name: sha(ROOT/'python'/name) for name in names}


def runtime_identity():
    value = cohn.runtime_identity()
    value['native_ports_sha256'] = sha(native_ports.__file__)
    return value


class CoupledFilterSimulation(Simulation):
    def to_bundle(self, *args, **kwargs):
        raise ValueError('research ground-half and contour probes have no bundle representation')


def build(n, port, kind='filter', loss='pec', control='ordinary', cap_s=None):
    if isinstance(port, bool) or port not in (1, 2) or kind not in KINDS or loss != 'pec':
        raise ValueError('declared source, kind and lossless case required')
    x, y, z = mesh_lines(n, control); grid = [len(a) for a in (x, y, z)]
    d = dimensions(); end = d['junctions_mm'][-1]; factor = FACTORS[n]
    cells = int(np.prod(grid))
    if cells > 4_000_000: raise ValueError('allocation exceeds four million cells')
    # Homogeneous epsilon_r raises the native material CFL bound. Still check
    # against the actual operator's bound before every propagation.
    dt = (.675 if control == 'dt' else .9)/(C0*np.sqrt(sum(
        1/(np.diff(a).min()*1e-3)**2 for a in (x, y, z))))
    cap = CAP_S*(3 if control == 'time' else 1) if cap_s is None else float(cap_s)
    if not np.isfinite(cap) or cap <= 0: raise ValueError('positive finite window required')
    steps = math.ceil(cap/dt); end_db = END_DB-(10 if control == 'time' else 0)
    sim = CoupledFilterSimulation(FREQUENCIES[0], FREQUENCIES[-1], excitation='dgauss',
        end_criteria_db=end_db, max_timesteps=steps,
        boundaries=['PML_8', 'PML_8', 'PEC', 'PEC', 'PEC', 'PEC'])
    for axis, lines in zip('xyz', (x, y, z)): sim.mesh.AddLine(axis, lines)
    sim.fdtd.SetTimeStep(float(dt)); sim.fdtd.SetOverSampling(OVERSAMPLING)
    sim.dielectric('homogeneous', ER).AddBox([x[0],y[0],z[0]],[x[-1],y[-1],z[-1]],priority=1)
    wf = d['feed_width_mm']; feeds = d['feed_centres_mm']; rectangles = []
    if kind == 'through':
        rectangles.append((0, x[0], x[-1], feeds[0]-wf/2, feeds[0]+wf/2))
        feeds = [feeds[0], feeds[0]]
    else:
        rectangles.extend(((0,x[0],0.,feeds[0]-wf/2,feeds[0]+wf/2),
            (4,end,x[-1],feeds[1]-wf/2,feeds[1]+wf/2)))
        for k, section in enumerate(d['sections']):
            for owner, key in ((k,'input_y_mm'),(k+1,'output_y_mm')):
                centre = section[key]; width = section['width_mm']
                rectangles.append((owner,d['junctions_mm'][k],d['junctions_mm'][k+1],centre-width/2,centre+width/2))
    wires = {}
    for owner, a, b, lo, hi in rectangles:
        if owner not in wires: wires[owner] = sim.metal(f'wire{owner}')
        wires[owner].AddBox([a,lo,0.],[b,hi,0.],priority=10)
    solids = ['homogeneous', *[f'wire{k}' for k in sorted(wires)]]
    plane = 9. if control == 'plane' else 6.
    distance = 12. if control == 'source' else 24.
    groups = []; ports = []; indices = {}; dx = B/(8*factor)
    mid_y, mid_z = (y[:-1]+y[1:])/2, (z[:-1]+z[1:])/2
    heights = [int(np.searchsorted(mid_z, height)) for height in (B/4,3*B/8)]
    if len(set(heights)) != 2: raise ValueError('independent contour heights collapsed')
    for endpoint, cy in enumerate(feeds):
        number, direction = endpoint+1, 1 if endpoint == 0 else -1
        source = -distance if endpoint == 0 else end+distance
        # A zero-width transverse source must use the actual native grid
        # coordinate, not a sub-ulp-different analytical endpoint sum.
        source = float(x[np.argmin(abs(x-source))])
        lo, hi = cy-wf/2, cy+wf/2
        record = dict(number=number,R=Z0,start=[source,lo,-B/2],stop=[source,hi,0.],direction='z',
            excite=number == port,group=dict(connection='parallel',members=[dict(
                start=[source,lo,0.],stop=[source,hi,B/2],direction='z',polarity=-1)]))
        ports.append(sim.lumped_port(**record)); groups.append(record)
        centre = -plane if endpoint == 0 else end+plane
        ix = int(np.argmin(abs(x-centre)))
        np.testing.assert_allclose(x[ix-1:ix+2],[centre-dx,centre,centre+dx],atol=1e-12,rtol=0)
        for j, sx in enumerate(x[ix-1:ix+2]):
            for half, a, b, weight in ((0,-B/2,0.,-.5),(1,0.,B/2,.5)):
                sim.csx.AddProbe(f'v{endpoint}_{j}_{half}',p_type=0,weight=weight).AddBox([sx,cy,a],[sx,cy,b])
        yl = int(np.searchsorted(mid_y,lo)-1); yh = int(np.searchsorted(mid_y,hi))
        for loop, zh in enumerate(heights):
            zl = len(z)-2-zh
            for j, sx in enumerate(((x[ix-1]+centre)/2,(centre+x[ix+1])/2)):
                low, high = yl-loop, yh+loop
                name = f'i{endpoint}_{loop}_{j}'
                sim.csx.AddProbe(name,p_type=1,norm_dir=0,weight=direction).AddBox(
                    [sx,mid_y[low],mid_z[zl]],[sx,mid_y[high],mid_z[zh]])
                indices[name] = [[ix+j-1,low,zl],[ix+j-1,high,zh]]
    for prop in sim.csx.GetAllProperties(): prop.SetColor((128,128,128),alpha=prop.GetFillColor()[3])
    if sim.csx.Update(): raise ValueError('invalid native geometry')
    required = solids+[p.GetName() for p in sim.csx.GetAllProperties()
        if '_port_resist_' in p.GetName() or '_port_excite_' in p.GetName()]
    smallest_gap = min(s['gap_mm'] for s in d['sections'])
    return sim, ports, dict(protocol='coupled-line-filter-v1',n=n,excited_port=port,kind=kind,loss=loss,
        control=control,dimensions=d,grid=grid,native_cells=cells,
        mesh_mm={a:v.tolist() for a,v in zip('xyz',(x,y,z))},plane_mm=plane,
        declared_dt_s=float(dt),cap_s=cap,max_timesteps=steps,end_db=end_db,threads=THREADS,
        source_duration_s=excitation.dgauss_duration_s(FREQUENCIES[-1]),solids=solids,
        expected_current_indices=indices,source_distance_mm=distance,native_copper=False,
        required_properties=required,
        grouped_feeds=groups,minimum_nominal_gap_cells=smallest_gap/np.diff(y).min(),
        scope='Own homogeneous finite stripline; ideal modal circuit excludes open-end and width-junction fields')

def usage(sim, names):
    return {p.GetName(): [bool(v.GetPrimitiveUsed()) for v in p.GetAllPrimitives()]
        for p in sim.csx.GetAllProperties() if p.GetName() in names}


def probe_names():
    return ([f'v{p}_{j}_{half}' for p in range(2) for j in range(3) for half in range(2)],
            [f'i{p}_{c}_{j}' for p in range(2) for c in range(2) for j in range(2)])


def trace_clock(data, meta, magnetic=False):
    data = np.asarray(data, float); native = meta['native']; dt = native['dt_s']
    stride = int(1/(2*FREQUENCIES[-1]*dt))//OVERSAMPLING
    count = round(native['numerical_time_s']/dt)//stride+1 if stride > 0 else 0
    expected = (np.arange(count)*stride+(.5 if magnetic else 0.))*dt
    if (count < 3 or data.shape != (count, 2) or not np.isfinite(data).all()
            or not np.allclose(data[:, 0], expected, rtol=2e-10, atol=dt*1e-5)):
        raise ValueError('complete native electric/magnetic clock required')


def source_info(path, meta):
    data = np.loadtxt(path, comments='%', ndmin=2); dt = meta['native']['dt_s']
    if data.shape not in ((meta['max_timesteps'], 2), (meta['max_timesteps']+1, 2)) or not np.isfinite(data).all():
        raise ValueError('complete allocated excitation trace required')
    clock = np.arange(len(data))*dt
    if not np.allclose(data[:, 0], clock, rtol=6e-6, atol=dt*1e-6):
        raise ValueError('excitation clock changed')
    tau = 1/(np.sqrt(2)*np.pi*FREQUENCIES[-1]/2.76)
    t0, tau = float(f'{5*tau:.6e}'), float(f'{tau:.6e}')
    q = (clock-t0)/tau
    expected = -float(f'{np.sqrt(2*np.e):.8f}')*q*np.exp(-q*q)
    error = float(abs(data[:, 1]-expected).max()/max(abs(expected).max(), np.finfo(float).tiny))
    if error > 6e-6: raise ValueError('excitation waveform changed')
    return dict(sha256=sha(path), waveform_error_rel=error)


def audit_header(text, meta):
    text_after = text.split(MARKER)[-1]
    grid = re.search(r'FDTD simulation size: (\d+)x(\d+)x(\d+) --> (\d+) FDTD cells', text_after)
    if (text.count(MARKER) != 1 or re.findall(r'openEMS 64bit -- version (\S+)', text_after) != ['v0.37.0-rc3']
            or f'fixed number of threads: {THREADS}' not in text_after or not grid
            or list(map(int, grid.groups()[:3])) != meta['grid'] or int(grid[4]) != meta['native_cells']):
        raise ValueError('native propagation version/thread/grid header mismatch')
    return dict(version='v0.37.0-rc3', threads=THREADS)


def quality(meta):
    native, run, op = meta['native'], meta['run'], meta['operator']
    energies = [run.get(k) for k in ('final_energy_db', 'final_energy_bound_db')]
    energies = [v for v in energies if isinstance(v, (int, float)) and not isinstance(v, bool) and np.isfinite(v)]
    return {k: bool(v) for k, v in dict(
        grid=native['cells'] == meta['native_cells'] and run.get('grid') == meta['grid'],
        clock=abs(native['dt_s']/meta['declared_dt_s']-1) < 1e-8,
        time=native['timesteps'] > 0 and abs(native['numerical_time_s']/(native['timesteps']*native['dt_s'])-1) < 1e-8,
        source=native['numerical_time_s'] >= meta['source_duration_s'],
        stopping=run.get('converged') is True and run.get('hit_timestep_limit') is False
            and bool(energies) and max(energies) <= meta['end_db']+1e-7,
        operator=0 < meta['declared_dt_s'] <= .8*op['run'].get('timestep_s', 0.),
        geometry=meta['required_usage'] == op['required_usage'] and set(meta['required_usage']) == set(meta['required_properties'])
            and all(v and all(v) for v in meta['required_usage'].values()),
        probes=meta['actual_current_indices'] == meta['expected_current_indices'],
        header=meta.get('native_header') == dict(version='v0.37.0-rc3', threads=THREADS),
        engine=run.get('threads') == THREADS and run.get('engine') == 'cpu' and run.get('exact_endcriteria') is True,
        ground=meta['ground_half_rel'] <= LIMITS['ground_half_rel'],
        tail=meta['terminal_tail_db'] <= LIMITS['terminal_tail_db']).items()}


def admissible(meta, checks, allow_cap=False):
    failed = [k for k, v in checks.items() if not v]
    return not failed or (allow_cap and failed == ['stopping']
        and meta['native']['timesteps'] == meta['max_timesteps']
        and meta['native']['numerical_time_s'] >= meta['cap_s'])


def capture(out, n, port, kind='filter', loss='pec', control='ordinary', cap_s=None):
    out = Path(out); out.mkdir(parents=True, exist_ok=False)
    sim, ports, meta = build(n, port, kind, loss, control, cap_s)
    meta.update(source=identity(), runtime=runtime_identity())
    sim.fdtd.Write2XML(str(out/'input.xml')); meta['input_sha256'] = sha(out/'input.xml')
    plan = json.loads((out.parent/'plan.json').read_text())
    row = next(r for r in plan['ports'] if r['excited_port'] == port)
    if (plan['source'] != meta['source'] or plan['runtime'] != meta['runtime']
            or any(row.get(k) != v for k, v in meta.items() if k not in ('source', 'runtime'))):
        raise ValueError('native inputs differ from the pre-field plan')
    setup_holder = build(n, port, kind, loss, control, cap_s)
    setup = setup_holder[0]; setup.fdtd.SetTimeStep(0.); setup.fdtd.SetNumberOfTimeSteps(1024)
    setup.fdtd.Write2XML(str(out/'operator-input.xml'))
    if sha(out/'operator-input.xml') != row['operator_input_sha256']:
        raise ValueError('operator input differs from the pre-field plan')
    op = dict(run=setup.run(str(out/'operator'), threads=THREADS, exact=True, echo=True, setup_only=True),
        required_usage=usage(setup, meta['required_properties']), input_sha256=sha(out/'operator-input.xml'))
    save(out/'operator.json', op)
    if (not 0 < meta['declared_dt_s'] <= .8*op['run'].get('timestep_s', 0.)
            or op['run'].get('grid') != meta['grid'] or set(op['required_usage']) != set(meta['required_properties'])
            or not all(v and all(v) for v in op['required_usage'].values())):
        raise ValueError('operator CFL/material-usage preflight failed')
    if identity() != meta['source'] or runtime_identity() != meta['runtime']:
        raise ValueError('source or runtime changed before fields')
    print(MARKER, flush=True)
    sim.run(str(out/'raw'), threads=THREADS, exact=True, echo=True, dump_statistics=True)
    stats = np.loadtxt(out/'raw/openEMS_stats.txt', comments='%')
    native = dict(cells=int(stats[0]), dt_s=float(stats[1]), timesteps=int(stats[2]),
        numerical_time_s=float(stats[3]), iteration_wall_s=float(stats[4]))
    meta.update(native=native, run=sim.run_stats, operator=op, required_usage=usage(sim, meta['required_properties']))
    vn, cn = probe_names(); values = []; tails = []; indices = {}; raw_hashes = {}
    for name in vn+cn:
        path = out/'raw'/name; data = np.loadtxt(path, comments='%', ndmin=2)
        trace_clock(data, meta, name in cn)
        values.append(np.asarray(UI_data([name], str(out/'raw'), FREQUENCIES).ui_f_val)[0])
        mask = data[:, 0] >= native['numerical_time_s']-.5e-9
        tails.append(float(10*np.log10(max(np.mean(data[mask, 1]**2), np.finfo(float).tiny)
            / max(np.max(data[:, 1]**2), np.finfo(float).tiny))))
        raw_hashes[name] = sha(path)
        if name in cn:
            header = '\n'.join(path.read_text().splitlines()[:3])
            indices[name] = [list(map(int, v)) for v in re.findall(r'-> \[(\d+),(\d+),(\d+)\]', header)]
    vh = np.asarray(values[:12]).reshape(2, 3, 2, -1)
    ground_rel = float(abs(vh[:, :, 0]-vh[:, :, 1]).max()/max(abs(vh.sum(axis=2)).max(), np.finfo(float).tiny))
    meta['ground_half_rel'] = ground_rel
    meta.update(actual_current_indices=indices, terminal_tail_db=max(tails), raw_sha256=raw_hashes,
        source_trace=source_info(out/'raw/et', meta))
    np.savez_compressed(out/'data.npz', frequency_hz=FREQUENCIES,
        v=vh.sum(axis=2), v_halves=vh, i=np.asarray(values[12:]).reshape(2, 2, 2, -1))
    if identity() != meta['source'] or runtime_identity() != meta['runtime']:
        raise ValueError('source or runtime changed during fields')
    meta.update(data_sha256=sha(out/'data.npz'), operator_sha256=sha(out/'operator.json'))
    save(out/'report.json', meta)
    return meta


def read(out, allow_cap=False):
    out = Path(out); meta = json.loads((out/'report.json').read_text())
    holder = build(meta['n'], meta['excited_port'], meta['kind'], meta['loss'], meta['control'], meta['cap_s'])
    if (any(meta.get(k) != v for k, v in holder[2].items())
            or meta['source'] != identity() or meta['runtime'] != runtime_identity()):
        raise ValueError('stored model/source/runtime differs')
    checks = quality(meta)
    if not admissible(meta, checks, allow_cap): raise ValueError(f'rejected source: {checks}')
    for name, expected in [('input.xml', meta['input_sha256']), ('operator-input.xml', meta['operator']['input_sha256']),
            ('operator.json', meta['operator_sha256']), ('data.npz', meta['data_sha256'])]:
        if sha(out/name) != expected: raise ValueError('stored input/operator/data changed')
    if json.loads((out/'operator.json').read_text()) != meta['operator']:
        raise ValueError('operator admission record changed')
    plan = json.loads((out.parent/'plan.json').read_text()); row = next(r for r in plan['ports'] if r['excited_port'] == meta['excited_port'])
    if (plan['source'] != identity() or plan['runtime'] != runtime_identity()
            or any(row.get(k) != v for k, v in holder[2].items())
            or row['input_sha256'] != meta['input_sha256']
            or row['operator_input_sha256'] != meta['operator']['input_sha256']):
        raise ValueError('stored plan changed')
    log = out.parent/f'port{meta["excited_port"]}.log'
    if sha(log) != meta['native_log_sha256'] or audit_header(log.read_text(), meta) != meta['native_header']:
        raise ValueError('native log/header changed')
    receipt = json.loads((out.parent/f'port{meta["excited_port"]}.worker.json').read_text())
    if (receipt['exit_code'] != 0 or receipt['failure'] is not None or receipt['deadline_seconds'] != 1800.
            or max(receipt['wall_seconds'], receipt['monotonic_seconds']) > 1800.):
        raise ValueError('worker did not complete within its owned deadline')
    stats = np.loadtxt(out/'raw/openEMS_stats.txt', comments='%')
    if dict(cells=int(stats[0]), dt_s=float(stats[1]), timesteps=int(stats[2]),
            numerical_time_s=float(stats[3]), iteration_wall_s=float(stats[4])) != meta['native']:
        raise ValueError('native statistics changed')
    vn, cn = probe_names(); values = []; tails = []
    for name in vn+cn:
        path = out/'raw'/name
        if sha(path) != meta['raw_sha256'][name]: raise ValueError('raw probe changed')
        trace = np.loadtxt(path, comments='%', ndmin=2); trace_clock(trace, meta, name in cn)
        clock, value = trace[:, 0], trace[:, 1]
        values.append(np.asarray([2*(clock[1]-clock[0])*np.sum(value*np.exp(-2j*np.pi*f*clock)) for f in FREQUENCIES]))
        mask = clock >= meta['native']['numerical_time_s']-.5e-9
        tails.append(float(10*np.log10(max(np.mean(value[mask]**2), np.finfo(float).tiny)
            / max(np.max(value**2), np.finfo(float).tiny))))
        if name in cn:
            indices = [list(map(int, v)) for v in re.findall(r'-> \[(\d+),(\d+),(\d+)\]', '\n'.join(path.read_text().splitlines()[:3]))]
            if indices != meta['expected_current_indices'][name]: raise ValueError('current indices changed')
    with np.load(out/'data.npz') as stored: data = dict(stored)
    if not np.array_equal(data['frequency_hz'], FREQUENCIES): raise ValueError('frequency grid changed')
    vh = np.asarray(values[:12]).reshape(2, 3, 2, -1)
    np.testing.assert_allclose(vh, data['v_halves'], rtol=3e-13, atol=1e-23)
    np.testing.assert_allclose(vh.sum(axis=2), data['v'], rtol=3e-13, atol=1e-23)
    np.testing.assert_allclose(np.asarray(values[12:]).reshape(2, 2, 2, -1), data['i'], rtol=3e-13, atol=1e-23)
    if float(abs(vh[:, :, 0]-vh[:, :, 1]).max()/max(abs(vh.sum(axis=2)).max(), np.finfo(float).tiny)) != meta['ground_half_rel']:
        raise ValueError('ground-half record changed')
    if max(tails) != meta['terminal_tail_db'] or source_info(out/'raw/et', meta) != meta['source_trace']:
        raise ValueError('source or tail record changed')
    return meta, data, checks


def scattering(v, i):
    v, i = np.asarray(v, complex), np.asarray(i, complex)
    if (v.shape != (2, 2, len(FREQUENCIES)) or i.shape != v.shape
            or not np.isfinite(v).all() or not np.isfinite(i).all()):
        raise ValueError('two complete finite source columns required')
    a, b = (v+Z0*i)/(2*np.sqrt(Z0)), (v-Z0*i)/(2*np.sqrt(Z0))
    singular = np.linalg.svd(a.transpose(2, 1, 0), compute_uv=False)
    condition = float(np.max(singular[:, 0]/np.maximum(singular[:, -1], np.finfo(float).tiny)))
    floor = float(singular[:, -1].min()/max(singular[:, 0].max(), np.finfo(float).tiny))
    if condition > LIMITS['incident_condition'] or floor < LIMITS['incident_floor']:
        raise ValueError('ill-conditioned incident matrix')
    return multiport.assemble_s(a, b, [1, 2], 2)


def extract(v, i):
    v, i = np.asarray(v), np.asarray(i)
    if v.shape != (2, 2, 3, len(FREQUENCIES)) or i.shape != (2, 2, 2, 2, len(FREQUENCIES)):
        raise ValueError('three voltage planes and two dual currents on both contours required')
    u = v[:, :, 1]; den = 2*np.sum(abs(u)**2, axis=0)
    if np.any(den < .01*np.max(np.sum(abs(v)**2, axis=0), axis=1)) or np.any(den == 0):
        raise ValueError('voltage node in feed recurrence')
    recurrence = np.sum(np.conj(u)*(v[:, :, 0]+v[:, :, 2]), axis=0)/den
    half = np.sqrt((recurrence+1)/2)
    if not np.isfinite(half).all() or np.any((abs(half) < .5) | (abs(half) > 1.5)):
        raise ValueError('invalid stagger correction')
    rows = [scattering(u, i[:, :, loop].mean(axis=2)/half) for loop in range(2)]
    return rows[0], dict(contour_s_abs=float(abs(rows[0]-rows[1]).max()),
        recurrence_rel=float(abs(v[:, :, 0]+v[:, :, 2]-2*recurrence[None]*u).max()/abs(v).max()))


def difference(a, b):
    mask = abs(b[:, 1, 0]) >= .01
    return dict(s_abs=float(abs(a-b).max()), phase_deg=float(abs(np.angle(a[mask, 1, 0]/b[mask, 1, 0], deg=True)).max()))


def matrix(root, allow_cap=False):
    root = Path(root); rows = [read(root/f'port{p}', allow_cap) for p in (1, 2)]
    metas = [m for m, _, _ in rows]
    if any(m['excited_port'] != p or any(m[k] != metas[0][k] for k in ('n', 'kind', 'loss', 'control', 'cap_s', 'mesh_mm', 'plane_mm'))
            for p, m in enumerate(metas, 1)):
        raise ValueError('same model and distinct source columns required')
    actual, qa = extract(np.asarray([d['v'] for _, d, _ in rows]), np.asarray([d['i'] for _, d, _ in rows]))
    target = reference(kind=metas[0]['kind'], plane_mm=metas[0]['plane_mm'], loss=metas[0]['loss'])
    result = dict(n=metas[0]['n'], kind=metas[0]['kind'], loss=metas[0]['loss'], control=metas[0]['control'],
        **difference(actual, target), **qa, native_complete=all(all(q.values()) for _, _, q in rows),
        native_quality=[q for _, _, q in rows], qualified=False,
        reciprocity_abs=float(abs(actual-actual.transpose(0, 2, 1)).max()),
        singular_power_max=float((np.linalg.svd(actual, compute_uv=False)[:, 0]**2).max()),
        native_copper=False, numerical_source=identity())
    result['measurement_passes'] = all(result[k] <= LIMITS[k] for k in ('contour_s_abs', 'recurrence_rel', 'reciprocity_abs', 'singular_power_max'))
    result['point_target_passes'] = result['s_abs'] <= LIMITS['s_abs'] and result['phase_deg'] <= LIMITS['phase_deg']
    result['samples'] = [dict(f_hz=float(FREQUENCIES[k]), native_loss_db=float(-20*np.log10(abs(actual[k, 1, 0]))),
        line_loss_db=float(-20*np.log10(abs(target[k, 1, 0]))),
        prototype_loss_db=float(prototype_loss()[k]) if metas[0]['kind'] == 'filter' else 0.)
        for k in (120, 160, 200, 240, 280)]
    prefix = 'cap-diagnostic-' if allow_cap else ''
    report, arrays = root/(prefix+'comparison.json'), root/(prefix+'matrix.npz')
    if report.exists() or arrays.exists():
        if not report.exists() or not arrays.exists() or json.loads(report.read_text()) != result:
            raise ValueError('stored comparison changed')
        with np.load(arrays) as old:
            for k, v in dict(frequency_hz=FREQUENCIES, s=actual, reference=target).items(): np.testing.assert_array_equal(old[k], v)
    else:
        save(report, result); np.savez_compressed(arrays, frequency_hz=FREQUENCIES, s=actual, reference=target)
    return actual, result
