"""Experimental driven Maxwell adapter, independent of the openEMS build path.

Rectilinear dielectric volumes, PEC sheets and a finite rectangular terminal.
The terminal width is explicit: a zero-width Design feed is not a FEM surface.
"""
from pathlib import Path
import copy
import json
import math
import os
import re
import struct
import subprocess

import numpy as np

from .design import check_design, design_params, resolve_names, resolve_parts, evaluate
from .model import resolve_params
from .fem_geometry import _refined_axis, _cell_node_ids, _face_node_ids

C0 = 299792458.0
MU0 = 4e-7 * math.pi
EPS0 = 1 / (MU0 * C0 * C0)


def prepare(design, *, cell_mm=8., padding_mm=40., feed_width_mm=1., approximate_metals=False, dielectric_cells=2):
    check_design(design)
    if type(dielectric_cells) is not int or not 2 <= dielectric_cells <= 10:
        raise ValueError('Substrate thickness needs 2 to 10 cells')
    design = copy.deepcopy(design)
    if approximate_metals:
        for material in design.get('materials', []):
            if material.get('kind') == 'metal' and material.get('conductivity') is not None:
                material.pop('conductivity', None)
                material.pop('thickness', None)
    for value in (cell_mm, padding_mm, feed_width_mm):
        if isinstance(value, bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value <= 0:
            raise ValueError("Mesh, padding and finite feed width must be positive")
    names = resolve_names(design, resolve_params(design_params(design), {}))
    ports = design.get("ports", [])
    if len(ports) != 1 or ports[0].get("type", "lumped") != "lumped":
        raise ValueError("Driven Elmer currently needs one rectangular lumped port")
    if design.get("resistors") or design.get("lumped_elements"):
        raise ValueError("Additional lumped elements are not yet supported by driven Elmer")
    port = ports[0]
    if port.get('excite', True) is False:
        raise ValueError('The single driven port must be excited')
    if set(port)-{'type','number','R','start','stop','direction','excite','priority','name','label'}:
        raise ValueError('Unsupported port properties must not be silently discarded')
    direction = "xyz".index(port["direction"])
    a, b = [np.array([float(evaluate(v, names)) for v in port[key]]) for key in ("start", "stop")]
    lo, hi = np.minimum(a, b), np.maximum(a, b)
    length = hi[direction] - lo[direction]
    if length <= 0:
        raise ValueError("Feed must span a nonzero gap along its excitation direction")
    transverse = [k for k in range(3) if k != direction]
    if any(hi[k] != lo[k] for k in transverse):
        raise ValueError("Initial driven adapter expects an ideal line feed with explicit FEM width")
    width_axis, normal_axis = transverse
    lo[width_axis] -= feed_width_mm / 2
    hi[width_axis] += feed_width_mm / 2
    impedance = float(evaluate(port.get("R", 50), names))
    if not math.isfinite(impedance) or impedance <= 0 or port.get("X"):
        raise ValueError("Initial driven adapter needs a positive real reference impedance")
    sheets, boxes, materials = [], [], []
    for part in resolve_parts(design, names):
        original = design["parts"][part["index"]]
        if original.get("transforms") or original.get("cuts") or part.get("voids"):
            raise ValueError("Initial driven adapter supports untransformed boxes and sheets")
        material = part["material"]
        metal = material["kind"] == "metal"
        if not metal and material["kind"] != "dielectric":
            raise ValueError("Only PEC and isotropic dielectric materials are supported")
        allowed = {"name", "kind", "label", "color", "opacity", "library", "description"}
        if not metal:
            allowed |= {"eps_r", "mu_r", "tan_d", "tan_d_freq"}
        if set(material) - allowed:
            raise ValueError("Unsupported material properties must not be silently discarded")
        eps = float(evaluate(material.get("eps_r", 1), names))
        mu = float(evaluate(material.get("mu_r", 1), names))
        loss = float(evaluate(material.get("tan_d", 0), names))
        if loss and 'tan_d_freq' not in material:
            raise ValueError('Lossy dielectric needs an explicit tan_d_freq reference in GHz')
        ref = float(evaluate(material.get("tan_d_freq", 1), names)) * 1e9
        if not all(math.isfinite(v) for v in (eps, mu, loss, ref)) or min(eps, mu, ref) <= 0 or loss < 0:
            raise ValueError("Invalid dielectric properties")
        materials.append((eps, mu, 2 * math.pi * ref * EPS0 * eps * loss))
        rid = len(materials) + 1
        for p in part["prims"]:
            if p["kind"] != "box" or p.get("_matrix"):
                raise ValueError("Initial driven adapter supports axis-aligned boxes and PEC sheets")
            low, high = np.minimum(p["start"], p["stop"]), np.maximum(p["start"], p["stop"])
            flat = np.where(high == low)[0]
            if metal:
                if len(flat) != 1:
                    raise ValueError("Initial driven metal geometry must be a PEC sheet")
                sheets.append((low, high, int(flat[0])))
            else:
                if len(flat):
                    raise ValueError("Dielectric geometry must have volume")
                boxes.append((low, high, rid))
    if not boxes or not sheets:
        raise ValueError("Driven patch prototype requires dielectric volumes and PEC sheets")
    for endpoint in (a,b):
        if not any(n==direction and abs(endpoint[n]-left[n])<1e-9 and all(
                left[q]<=lo[q] and hi[q]<=right[q] for q in range(3) if q!=n) for left,right,n in sheets):
            raise ValueError('Both ends of the finite feed must contact PEC sheets across its full width')
    if any(n==direction and lo[n]<left[n]<hi[n] and all(left[q]<=a[q]<=right[q] for q in range(3) if q!=n)
           for left,right,n in sheets):
        raise ValueError('A PEC sheet crosses the feed gap')
    all_lo = [q[0] for q in boxes + sheets] + [lo]
    all_hi = [q[1] for q in boxes + sheets] + [hi]
    low = np.min(all_lo, axis=0) - padding_mm
    high = np.max(all_hi, axis=0) + padding_mm
    breaks = []
    for k in range(3):
        values = {float(low[k]), float(high[k]), float(lo[k]), float(hi[k])}
        for left, right, *_ in boxes + sheets:
            values.update((float(left[k]), float(right[k])))
        # Resolve substrate and feed gap through their thickness, even for coarse air cells.
        for left, right, _ in boxes:
            values.add(float((left[k] + right[k]) / 2))
            if k == direction:
                values.update(float(v) for v in np.linspace(left[k], right[k], dielectric_cells+1))
        if k == direction:
            values.add(float((lo[k] + hi[k]) / 2))
        breaks.append(sorted(values))
    counts=[sum(max(1,math.ceil((b-a)/cell_mm)) for a,b in zip(axis,axis[1:])) for axis in breaks]
    if math.prod(counts)>10000:
        raise ValueError('Driven prototype limited to 10000 cells; increase mesh size')
    axes=[np.array(_refined_axis(axis,cell_mm)[0])*.001 for axis in breaks]
    nx, ny, nz = [len(v) - 1 for v in axes]
    if nx * ny * nz > 10000:
        raise ValueError("Driven prototype limited to 10000 cells; increase mesh size")
    nodes = [(x, y, z) for z in axes[2] for y in axes[1] for x in axes[0]]
    elements, boundaries = [], []
    for k in range(nz):
        for j in range(ny):
            for i in range(nx):
                ijk = (i, j, k)
                center = np.array([(axes[q][v] + axes[q][v + 1]) * 500 for q, v in enumerate(ijk)])
                hits = [rid for left, right, rid in boxes if np.all(center > left) and np.all(center < right)]
                if len(hits) > 1:
                    raise ValueError("Overlapping dielectric volumes are unsupported")
                conn = _cell_node_ids(i, j, k, nx + 1, ny + 1)
                elements.append((hits[0] if hits else 1, conn))
                parent = len(elements)
                for axis in range(3):
                    for side in (0, 1):
                        v = ijk[axis] + side
                        exterior = v == 0 or v == len(axes[axis]) - 1
                        # Emit interior surfaces once, from the lower-index cell.
                        if not exterior and side == 0:
                            continue
                        pos = center.copy(); pos[axis] = axes[axis][v] * 1000
                        pec = any(axis == n and abs(pos[n] - left[n]) < 1e-9
                                  and all(left[q] < pos[q] < right[q] for q in range(3) if q != n)
                                  for left, right, n in sheets)
                        feed = axis == normal_axis and abs(pos[axis] - lo[axis]) < 1e-9 and all(
                            lo[q] < pos[q] < hi[q] for q in range(3) if q != axis)
                        if pec and feed:
                            raise ValueError("FEM feed overlaps a PEC surface")
                        tag = 1 if exterior else 3 if feed else 2 if pec else 0
                        if tag:
                            face = _face_node_ids(conn, f'{"xyz"[axis]}_{"max" if side else "min"}')
                            boundaries.append((tag, parent, face))
    if not any(tag == 3 for tag, *_ in boundaries):
        raise ValueError("No finite FEM port surface was meshed")
    return dict(nodes=nodes, elements=elements, boundaries=boundaries,
                materials=[(1., 1., 0.), *materials], impedance=impedance,
                port_direction=(direction + 1) * (1 if b[direction] > a[direction] else -1),
                feed_width_mm=feed_width_mm, padding_mm=padding_mm, cell_mm=cell_mm)


def write_mesh(mesh, folder):
    folder.mkdir()
    nodes, elements, boundaries = (mesh[k] for k in ("nodes", "elements", "boundaries"))
    (folder / "mesh.header").write_text(f"{len(nodes)} {len(elements)} {len(boundaries)}\n2\n808 {len(elements)}\n404 {len(boundaries)}\n")
    (folder / "mesh.nodes").write_text("".join(f"{i} -1 {x:.17g} {y:.17g} {z:.17g}\n" for i, (x,y,z) in enumerate(nodes,1)))
    (folder / "mesh.elements").write_text("".join(f"{i} {r} 808 {' '.join(map(str,c))}\n" for i,(r,c) in enumerate(elements,1)))
    (folder / "mesh.boundary").write_text("".join(f"{i} {tag} {parent} 0 404 {' '.join(map(str,c))}\n" for i,(tag,parent,c) in enumerate(boundaries,1)))


def sif(mesh, frequency):
    text = f'''Check Keywords "Warn"
Header
 Mesh DB "." "mesh"
End
Simulation
 Coordinate System = "Cartesian 3D"
 Simulation Type = Steady
 Steady State Max Iterations = 1
 Max Output Level = 5
End
Equation 1
 Active Solvers(3) = 1 2 3
 Angular Frequency = Real {2*math.pi*frequency:.17g}
End
'''
    used = sorted({r for r, _ in mesh['elements']})
    for index, rid in enumerate(used,1):
        eps,mu,sigma=mesh['materials'][rid-1]
        # Elmer model 20 / VectorHelmholtz reads inverse relative permeability.
        # "Relative Permeability" belongs to other modules and is ignored here.
        # https://www.nic.funet.fi/pub/org/net/CSC/software/elmer/doc/ElmerModelsManual.pdf
        reluctivity = 1 / mu
        if not math.isfinite(reluctivity):
            raise ValueError('Relative permeability has no finite reciprocal for Elmer')
        text += f'''Body {index}
 Target Bodies(1) = {rid}
 Equation = 1
 Material = {index}
End
Material {index}
 Relative Permittivity = Real {eps:.17g}
 Relative Reluctivity = Real {reluctivity:.17g}
 Electric Conductivity = Real {sigma:.17g}
End
'''
    return text + f'''Solver 1
 Equation = VectorHelmholtz
 Procedure = "VectorHelmholtz" "VectorHelmholtzSolver"
 Linear System Symmetric = Logical False
 Linear System Solver = Direct
 Linear System Direct Method = UMFPACK
 Linear System Iterative Method = IDRS
 Linear System Preconditioning = ILUT
 Linear System ILUT Tolerance = 0.003
 Linear System Max Iterations = 4000
 Linear System Convergence Tolerance = 1.0e-9
 Linear System Abort Not Converged = Logical True
 Linear System Residual Output = 100
 Constraint Modes Analysis = Logical True
 Constraint Modes Lumped = Logical True
 Constraint Modes Fluxes = Logical True
 Constraint Modes EM Wave = Logical True
 Constraint Modes Fluxes Results = Logical True
 Constraint Modes Fluxes Filename = File "SMatrix.dat"
End
Solver 2
 Equation = calcfields
 Procedure = "VectorHelmholtz" "VectorHelmholtzCalcFields"
 Calculate Electric Field = Logical True
 Calculate Magnetic Field Strength = Logical True
 Calculate Elemental Fields = Logical False
 Linear System Solver = Iterative
 Linear System Iterative Method = CG
 Linear System Preconditioning = None
 Linear System Max Iterations = 5000
 Linear System Convergence Tolerance = 1e-9
 Linear System Abort Not Converged = Logical True
End
Solver 3
 Equation = ResultOutput
 Procedure = "ResultOutputSolve" "ResultOutputSolver"
 Output File Name = fields
 Vtu Format = Logical True
 Binary Output = Logical True
End
Boundary Condition 1
 Target Boundaries(1) = 1
 Absorbing BC = Logical True
End
Boundary Condition 2
 Target Boundaries(1) = 2
 E re {{e}} = Real 0
 E im {{e}} = Real 0
End
Boundary Condition 3
 Target Boundaries(1) = 3
 Port Type = String "rectangular"
 Port Impedance = Real {mesh['impedance']:.17g}
 Port Direction = Integer {mesh['port_direction']}
 Constraint Mode = Integer 1
End
'''


def solve_one(mesh, frequency, out, root):
    import fairbeam_elmer
    home, solver, _ = fairbeam_elmer.discover(root)
    out = Path(out); out.mkdir(parents=True, exist_ok=False)
    write_mesh(mesh, out/'mesh')
    (out/'case.sif').write_text(sif(mesh,frequency),encoding='utf-8')
    manifest={'frequency_hz':frequency,'threads':1,'solver_sha256':fairbeam_elmer.digest(solver),
              'generator_sha256':fairbeam_elmer.digest(__file__),
              'feed_width_mm':mesh['feed_width_mm'],'padding_mm':mesh['padding_mm'],'cell_mm':mesh['cell_mm'],
              'sha256':{str(p.relative_to(out)):fairbeam_elmer.digest(p) for p in [out/'case.sif',*sorted((out/'mesh').glob('mesh.*'))]}}
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    env={**os.environ,'ELMER_HOME':str(home),'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1',
         'PATH':str(solver.parent)+os.pathsep+os.environ.get('PATH','')}
    with (out/'solver.log').open('w',encoding='utf-8') as log:
        run=subprocess.run([str(solver),'case.sif'],cwd=out,env=env,stdin=subprocess.DEVNULL,
                           stdout=log,stderr=subprocess.STDOUT,timeout=180,
                           creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    log=(out/'solver.log').read_text(errors='replace')
    if run.returncode or 'ALL DONE' not in log or re.search(r'FATAL|ERROR::|WARNING::.*FAILED',log):
        raise ValueError('Driven Elmer solve failed; inspect solver.log')
    s=complex(float((out/'SMatrix.dat').read_text()),float((out/'SMatrix.dat_im').read_text()))
    if not math.isfinite(abs(s)) or abs(s)>1.01:
        raise ValueError('Nonfinite or nonpassive driven S11; result rejected')
    return s


def fields(path):
    """Read bounded native uncompressed VTU vectors, rejecting unsupported layouts."""
    raw = Path(path).read_bytes()
    if len(raw) > 64*1024*1024:
        raise ValueError('Field export exceeds 64 MiB')
    start = raw.find(b'<AppendedData encoding="raw">')
    if start < 0:
        raise ValueError('Expected native raw VTU output')
    head = raw[:start].decode('utf-8')
    if 'byte_order="LittleEndian"' not in head or 'compressor=' in head or 'header_type="UInt64"' in head:
        raise ValueError('Unsupported VTU encoding')
    offset = raw.index(b'_', start)+1
    count = int(re.search(r'NumberOfPoints="(\d+)"', head)[1])
    values = {}
    for tag in re.findall(r'<DataArray[^>]+>', head):
        if 'type="Float64"' not in tag:
            continue
        if 'NumberOfComponents="3"' not in tag or 'format="appended"' not in tag:
            raise ValueError('Unsupported field layout')
        at = offset + int(re.search(r'offset="(\d+)"',tag)[1])
        size = struct.unpack_from('<I',raw,at)[0]
        if size != count*24 or at+4+size > len(raw):
            raise ValueError('Truncated field export')
        data = np.frombuffer(raw,dtype='<f8',count=count*3,offset=at+4).reshape(-1,3).copy()
        if not np.isfinite(data).all():
            raise ValueError('Nonfinite exported field')
        name = re.search(r'Name="([^"]+)"',tag)
        values[name[1] if name else 'points'] = data
    return values


def huygens_pattern(centers, normals, areas, electric, magnetic, frequency):
    """Vacuum equivalence surface, e^(-i wt) convention used by VectorHelmholtz.

    Returns normalized directivity only. Gain/efficiency require accepted-power qualification.
    """
    eta = MU0*C0; k = 2*math.pi*frequency/C0
    je = np.cross(normals,magnetic); jm = -np.cross(normals,electric)
    theta = np.linspace(0,math.pi,37); phi = np.linspace(0,2*math.pi,72,endpoint=False)
    tt,pp = np.meshgrid(theta,phi,indexing='ij')
    dirs = np.stack((np.sin(tt)*np.cos(pp),np.sin(tt)*np.sin(pp),np.cos(tt)),axis=-1).reshape(-1,3)
    intensity=[]
    for r in dirs:
        phase = np.exp(-1j*k*(centers@r))*areas
        j = np.sum(je*phase[:,None],axis=0); m = np.sum(jm*phase[:,None],axis=0)
        e = 1j*k/(4*math.pi)*(eta*(j-r*np.dot(r,j))+np.cross(m,r))
        intensity.append(float(np.vdot(e,e).real/(2*eta)))
    u=np.array(intensity).reshape(tt.shape)
    power=float(np.trapezoid(np.sum(u,axis=1)*np.sin(theta),theta)*(2*math.pi/len(phi)))
    if not math.isfinite(power) or power<=0:
        raise ValueError('No finite radiated power from equivalence surface')
    return dict(theta_deg=np.rad2deg(theta).tolist(),phi_deg=np.rad2deg(phi).tolist(),
                directivity=(4*math.pi*u/power).tolist(),radiated_power_w=power,
                peak_directivity_dbi=float(10*np.log10(4*math.pi*u.max()/power)),
                method='Huygens E/H surface integration; vacuum; exp(-i omega t)',
                gain_qualified=False)


def farfield(mesh, frequency, path):
    data=fields(path)
    lookup={tuple(np.round(p,12)):i for i,p in enumerate(data['points'])}
    indices=[lookup[tuple(np.round(p,12))] for p in mesh['nodes']]
    electric=(data['electric field re']+1j*data['electric field im'])[indices]
    magnetic=(data['magnetic field strength re']+1j*data['magnetic field strength im'])[indices]
    nodes=np.asarray(mesh['nodes']); centers=[]; normals=[]; areas=[]; ef=[]; hf=[]
    for tag,parent,face in mesh['boundaries']:
        if tag!=1: continue
        ids=np.array(face)-1; p=nodes[ids]; center=p.mean(axis=0)
        normal=np.cross(p[1]-p[0],p[3]-p[0]); area=np.linalg.norm(normal); normal/=area
        volume_center=nodes[np.array(mesh['elements'][parent-1][1])-1].mean(axis=0)
        if np.dot(normal,center-volume_center)<0: normal=-normal
        centers.append(center); normals.append(normal); areas.append(area)
        ef.append(electric[ids].mean(axis=0)); hf.append(magnetic[ids].mean(axis=0))
    return huygens_pattern(np.array(centers),np.array(normals),np.array(areas),np.array(ef),np.array(hf),frequency)


SCHEMA = 'fairbeam.elmer-driven-result/1'


def settings_mesh(design, settings):
    allowed={'analysis','cell_mm','padding_mm','feed_width_mm','dielectric_cells','f_min_hz','f_max_hz','points','farfield_hz','accept_finite_feed','approximate_metals'}
    if set(settings)-allowed or settings.get('analysis')!='driven' or settings.get('accept_finite_feed') is not True:
        raise ValueError('Explicit experimental finite-feed acceptance is required')
    for key in ('f_min_hz','f_max_hz','farfield_hz'):
        v=settings.get(key)
        if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not 1e6<=v<=1e11:
            raise ValueError('Frequency must be between 1 MHz and 100 GHz')
    if not settings['f_min_hz']<=settings['farfield_hz']<=settings['f_max_hz'] or settings['f_min_hz']==settings['f_max_hz']:
        raise ValueError('Far-field frequency must lie inside a nonzero sweep band')
    points=settings.get('points')
    if type(points) is not int or not 3<=points<=21:
        raise ValueError('Initial driven sweep supports 3 to 21 frequency points')
    if type(settings.get('approximate_metals', False)) is not bool:
        raise ValueError('approximate_metals must be boolean')
    return prepare(design,cell_mm=settings.get('cell_mm',12),padding_mm=settings.get('padding_mm',40),feed_width_mm=settings.get('feed_width_mm',1),approximate_metals=settings.get('approximate_metals',False),dielectric_cells=settings.get('dielectric_cells',2))


def run(design, settings, outdir, root):
    mesh=settings_mesh(design,settings)
    out=Path(outdir); out.mkdir(parents=True,exist_ok=False)
    frequencies=sorted(set(np.linspace(settings['f_min_hz'],settings['f_max_hz'],settings['points']).tolist()+[settings['farfield_hz']]))
    result=dict(schema=SCHEMA,status='solver_started',frequency_hz=[],s11_real=[],s11_imag=[],
                precision_converged=False,settings=settings,
                mesh=dict(elements=len(mesh['elements']),nodes=len(mesh['nodes'])),
                limitations=['Finite rectangular feed replaces ideal line only in this FEM run.',
                             'First-order absorbing outer boundary; mesh and padding convergence are not certified.',
                             'Far field is directivity only, not qualified gain or efficiency.'])
    (out/'design.json').write_text(json.dumps(design,indent=2),encoding='utf-8')
    result['pec_approximations'] = [m['name'] for m in design.get('materials', []) if settings.get('approximate_metals') and m.get('kind') == 'metal' and m.get('conductivity') is not None]
    if result['pec_approximations']:
        result['limitations'].append('Finite conductor loss omitted by PEC approximation: ' + ', '.join(result['pec_approximations']))
    try:
        for i,f in enumerate(frequencies):
            folder=out/f'frequency-{i:03d}'
            s=solve_one(mesh,f,folder,root)
            result['frequency_hz'].append(f); result['s11_real'].append(s.real); result['s11_imag'].append(s.imag)
            if f==settings['farfield_hz']:
                result['farfield']={**farfield(mesh,f,folder/'mesh/fields_t0001.vtu'),'frequency_hz':f}
            (out/'progress.json').write_text(json.dumps(result,allow_nan=False),encoding='utf-8')
        result['status']='results_exported'
        return validate_result(result)
    except BaseException as exc:
        result.update(status='failed',error=str(exc))
        (out/'progress.json').write_text(json.dumps(result,allow_nan=False),encoding='utf-8')
        raise


def validate_result(value):
    if value.get('schema')!=SCHEMA or value.get('status')!='results_exported' or value.get('precision_converged') is not False:
        raise ValueError('Driven Elmer result must remain experimental')
    fs=np.asarray(value['frequency_hz'])
    reals=np.asarray(value.get('s11_real',[])); imags=np.asarray(value.get('s11_imag',[]))
    if reals.shape!=fs.shape or imags.shape!=fs.shape or not np.isfinite(reals+1j*imags).all() or np.any(np.hypot(reals,imags)>1.01):
        raise ValueError('Invalid driven S11 trace')
    ff=value.get('farfield',{})
    d=np.asarray(ff.get('directivity',[]))
    if d.shape!=(37,72) or not np.isfinite(d).all() or np.any(d<0) or ff.get('gain_qualified') is not False:
        raise ValueError('Invalid directivity export')
    return value


