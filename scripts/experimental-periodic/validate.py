"""Sequential, bounded native solver checks. No installed binaries are modified."""
import argparse, csv, hashlib, json, os, platform, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path
import xml.etree.ElementTree as ET
import numpy as np

SOURCE=Path(__file__).resolve().parent
ROOT=SOURCE
EXECUTABLES={}
REPO=SOURCE.parents[1]
sys.path.insert(0,str(REPO/'python'))
from engine import check_capabilities
from fairbeam import Simulation
from fairbeam.material_cell import PlaneWaveCell, cell_sparams
from fairbeam.analytic import slab_s
from fairbeam.simulation import _parse_log
from openEMS.ports import UI_data
from precise_xml import write

def save(path,data): path.write_text(json.dumps(data,indent=2,allow_nan=False)+'\n',encoding='utf-8')
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def stamp(): return datetime.now(timezone.utc).isoformat()

def build(kind,cpw,shift=0,periodic=True,bias=0,pml=8,uniform_z=False):
    sim=Simulation(1e9,10e9,max_timesteps=80000,end_criteria_db=-70)
    n=6 if kind in ('slab','empty') else int(cpw*0.6)
    size=6 if kind in ('slab','empty') else 8
    depth=10 if kind in ('slab','empty') else 2
    cell=PlaneWaveCell(sim,size,size,0,depth,eps_max=6,cells_per_wavelength=cpw,gap=15,transverse_cells=n)
    if uniform_z:
        old=np.asarray(sim.mesh.GetLines('z'))
        h=depth/np.ceil(depth/(299792458/10e9/1e-3/cpw/np.sqrt(6)))
        sim.mesh.SetLines('z',np.arange(np.floor(old[0]/h),np.ceil(old[-1]/h)+1)*h)
        for prop in sim.csx.GetAllProperties():
            for prim in prop.GetAllPrimitives():
                start=prim.GetStart();stop=prim.GetStop()
                start[2]=round(start[2]/h)*h;stop[2]=round(stop[2]/h)*h
                prim.SetStart(start);prim.SetStop(stop)
        cell.z1=round(cell.z1/h)*h;cell.z2=round(cell.z2/h)*h;cell.z_source=round(cell.z_source/h)*h
    if pml!=8:
        if pml<8 or pml>20: raise ValueError('experimental PML range is 8..20')
        zs=np.asarray(sim.mesh.GetLines('z')); extra=pml-8
        sim.mesh.SetLines('z',np.r_[zs[0]-(zs[1]-zs[0])*np.arange(extra,0,-1),zs,zs[-1]+(zs[-1]-zs[-2])*np.arange(1,extra+1)])
        sim.boundaries=['PMC','PMC','PEC','PEC',f'PML_{pml}',f'PML_{pml}']
        sim.fdtd.SetBoundaryCond(sim.boundaries)
    if kind=='pec': sim.csx.AddMetal('sheet').AddBox(*cell.span(0,0))
    if kind=='slab': sim.dielectric('sample',4,0).AddBox(*cell.span(0,depth))
    if kind in ('inclusion','metal-pattern'):
        mat=sim.csx.AddMetal('sample') if kind=='metal-pattern' else sim.dielectric('sample',6,0)
        # Explicit periodic images of an asymmetric rectangle, clipped to the unit cell.
        for x0,x1,y0,y1 in [(-2,0,-2,1),(0,1,-2,0)]:
            for image in (-1,0,1):
                lo=x0+bias+shift+image*size; hi=x1+bias+shift+image*size
                lo=max(lo,-size/2);hi=min(hi,size/2)
                if hi>lo:mat.AddBox([lo,y0+bias,0],[hi,y1+bias,depth])
    # Average line-integrated Ey over all unique x nodes, excluding the duplicated endpoint.
    probe_names=[]
    zinc=float(min(sim.mesh.GetLines('z'),key=lambda z:abs(z-(cell.z1+7.5))))
    probe_z=(cell.z1,cell.z2,zinc)
    for plane,z in enumerate(probe_z):
        names=[]
        for i,x in enumerate(sim.mesh.GetLines('x')[:-1]):
            name=f'avg_{plane}_{i}';names.append(name)
            sim.csx.AddProbe(name,p_type=0).AddBox([x,-size/2,z],[x,size/2,z])
        probe_names.append(names)
    mesh={a:sim.mesh.GetLines(a).tolist() for a in 'xyz'}
    dt=.8/(299792458*np.sqrt(sum(1/(np.min(np.diff(mesh[a]))*sim.unit)**2 for a in 'xyz')))
    sim.fdtd.SetTimeStep(dt)
    return sim,cell,probe_names,{'uniform_z':uniform_z,'pml_cells':pml,'bias_mm':bias,'probe_z_mm':probe_z,'mesh_mm':mesh,'dt_s':dt,'cpw':cpw,'kind':kind,'shift_mm':shift,'periodic':periodic,'cells':int(np.prod([len(mesh[a])-1 for a in 'xyz']))}

def run(case_dir,sim,settings,route):
    case_dir.mkdir(parents=True,exist_ok=False)
    xml=case_dir/'model.xml';write(sim,xml)
    if settings['periodic']:
        tree=ET.parse(xml);bc=tree.find('.//BoundaryCond')
        for a in ('xmin','xmax','ymin','ymax'):bc.set(a,'PERIODIC_TEST')
        tree.write(xml,encoding='utf-8',xml_declaration=True)
    exe=EXECUTABLES[route]
    command=[str(exe),str(xml),'--engine=basic']
    manifest={'schema_version':1,'run_id':case_dir.name,'status':'model_built','started_utc':stamp(),'settings':settings,
              'source_sha256':sha(Path(__file__)),'xml_sha256':sha(xml),'exe_sha256':sha(exe),'dll_sha256':sha(exe.parent/'openEMS.dll') if (exe.parent/'openEMS.dll').exists() else None,
              'command':command,'requested_acceleration':'CPU basic','threads':1,'evidence_domain':'synthetic','platform':platform.platform()}
    save(case_dir/'manifest.json',manifest)
    t=time.monotonic()
    try:
        manifest['status']='solver_started';save(case_dir/'manifest.json',manifest)
        with (case_dir/'solver.log').open('w',encoding='utf-8') as log:
            proc=subprocess.run(command,cwd=case_dir,stdout=log,stderr=subprocess.STDOUT,timeout=120,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        manifest.update(exit_code=proc.returncode,wall_s=time.monotonic()-t,finished_utc=stamp())
        if proc.returncode:raise RuntimeError(f'{case_dir.name}: solver exit {proc.returncode}')
        log=(case_dir/'solver.log').read_text(encoding='utf-8',errors='replace')
        manifest.update(status='solver_returned',stats=_parse_log(log,-70,80000))
        save(case_dir/'manifest.json',manifest)
    except Exception as e:
        manifest.update(status='failed',failure=repr(e));save(case_dir/'manifest.json',manifest);raise
    return manifest

def pair(out,kind,cpw,shift=0,route='candidate',periodic=True,bias=0,pml=8,uniform_z=False):
    sim,cell,names,settings=build(kind,cpw,shift,periodic,bias,pml,uniform_z)
    ref=cell.reference()
    # reference() recreates only the original probes; add identical averaging probes.
    for plane,z in enumerate(settings['probe_z_mm']):
        for name,x in zip(names[plane],sim.mesh.GetLines('x')[:-1]):
            ref.csx.AddProbe(name,p_type=0).AddBox([x,-cell.b/2,z],[x,cell.b/2,z])
    ref.fdtd.SetTimeStep(settings['dt_s']); ref.fdtd.SetEndCriteria(1e-7)
    f=np.linspace(1e9,10e9,301);waves=[];stats=[]
    for label,s in [('reference',ref),('sample',sim)]:
        path=out/label
        manifest=run(path,s,{**settings,'role':label},route)
        vals=[]
        for group in names:
            u=UI_data(group,str(path),f); vals.append(np.mean(u.ui_f_val,axis=0))
        if not all(np.isfinite(v).all() for v in vals):raise ValueError('nonfinite probes')
        waves.append(vals);stats.append(manifest['stats'])
        manifest.update(status='results_exported',probe_sha256={name:sha(path/name) for g in names for name in g})
        save(path/'manifest.json',manifest)
    res=cell_sparams(f,waves[0][:2],waves[1][:2],cell.z1,cell.z2,cell.front,cell.back,sim.unit)
    # Independent two-plane forward/backward decomposition in the empty reference.
    # This is a real check; dividing an empty sample by itself is only normalization QA.
    phase=np.exp(-2j*np.pi*f/299792458*(settings['probe_z_mm'][2]-cell.z1)*sim.unit)
    backward=(waves[0][2]-waves[0][0]*phase)/(1/phase-phase)
    forward=waves[0][0]-backward
    np.savez(out/'empty-reference-waves.npz',frequency_hz=f,forward=forward,backward=backward)
    np.savez(out/'complex.npz',frequency_hz=f,s11=res['s11'],s21=res['s21'])
    with (out/'sparameters.csv').open('w',newline='',encoding='utf-8') as file:
        w=csv.writer(file);w.writerow(['frequency_hz','port_i','port_j','s_real','s_imag'])
        for i,v in [(1,res['s11']),(2,res['s21'])]:
            for freq,z in zip(f,v):w.writerow([freq,i,1,z.real,z.imag])
    result={'case':out.name,'kind':kind,'cpw':cpw,'shift_mm':shift,'route':route,'periodic':periodic,'cells':settings['cells'],
            'uniform_z':uniform_z,'pml_cells':pml,'bias_mm':bias,'status':'results_exported','energy_converged':all(s.get('converged') for s in stats),'run_stats':stats,
            'power_min':float(np.min(res['R2']+res['T2'])),'power_max':float(np.max(res['R2']+res['T2'])),
            'empty_reference_max_reflection':float(np.max(abs(backward/forward))),
            'csv_sha256':sha(out/'sparameters.csv')}
    if kind=='pec':
        result['analytic_max_complex_error']=float(max(np.max(abs(res['s11']+1)),np.max(abs(res['s21']))))
    if kind in ('slab','empty'):
        analytic=slab_s(f,[{'thickness':cell.back,'eps_r':4 if kind=='slab' else 1}],unit=sim.unit)
        result['analytic_max_complex_error']=float(max(np.max(abs(res['s11']-analytic[:,0,0])),np.max(abs(res['s21']-analytic[:,1,0]))))
    save(out/'summary.json',result);print(json.dumps(result,default=str),flush=True)
    return result

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--suite',default='pilot',choices=['pilot','slabs','translation','offset-diagnostic','baseline','pml','uniform','uniform-translation','pec','metal-translation'])
    ap.add_argument('--candidate',required=True,type=Path,help='Explicit experimental native executable; no automatic fallback')
    ap.add_argument('--baseline',type=Path,help='Unmodified same-commit basic executable for baseline suite')
    ap.add_argument('--output',required=True,type=Path,help='Parent directory for immutable run folders')
    args=ap.parse_args()
    global ROOT,EXECUTABLES
    check_capabilities(args.candidate)
    if args.suite=='baseline' and not args.baseline: ap.error('--baseline is required for baseline suite')
    ROOT=args.output.resolve();ROOT.mkdir(parents=True,exist_ok=True)
    EXECUTABLES={'candidate':args.candidate.resolve(),'baseline':args.baseline.resolve() if args.baseline else None}
    suite=ROOT/('runs-'+args.suite+'-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'));suite.mkdir()
    shutil=__import__('shutil');shutil.copy2(__file__,suite/'validate-source.py');shutil.copy2(SOURCE/'precise_xml.py',suite/'precise_xml.py');shutil.copy2(SOURCE/'engine.py',suite/'engine.py');shutil.copy2(SOURCE/'study-contract.json',suite/'study-contract.json')
    rows=[]
    if args.suite=='pilot': rows.append(pair(suite/'slab-20','slab',20))
    elif args.suite=='pec':
        for cpw in (20,30,40): rows.append(pair(suite/f'pec-{cpw}','pec',cpw,pml=16,uniform_z=True))
    elif args.suite=='metal-translation':
        for cpw in (20,30,40):
            for shift in (0,16/3): rows.append(pair(suite/f'metal-{cpw}-shift{shift:g}','metal-pattern',cpw,shift,pml=16,uniform_z=True))
    elif args.suite=='uniform-translation':
        for cpw in (20,30,40):
            for shift in (0,16/3): rows.append(pair(suite/f'inclusion-{cpw}-shift{shift:g}','inclusion',cpw,shift,pml=16,uniform_z=True))
    elif args.suite=='uniform':
        for cpw in (20,30,40): rows.append(pair(suite/f'slab-{cpw}','slab',cpw,pml=16,uniform_z=True))
    elif args.suite=='pml':
        for pml in (8,12,16): rows.append(pair(suite/f'empty-pml{pml}','empty',40,pml=pml))
    elif args.suite=='slabs':
        for cpw in (20,30,40): rows.append(pair(suite/f'slab-{cpw}','slab',cpw))
        rows.append(pair(suite/'empty-40','empty',40))
    elif args.suite in ('translation','offset-diagnostic'):
        for cpw in (20,30,40):
            # Two-thirds-period shift splits the L shape across the seam, at integer cells.
            for shift in (0,16/3): rows.append(pair(suite/f'inclusion-{cpw}-shift{shift:g}','inclusion',cpw,shift,bias=0.137 if args.suite=='offset-diagnostic' else 0))
    else:
        for route in ('baseline','candidate'): rows.append(pair(suite/route,'slab',20,route=route,periodic=False))
    save(suite/'summary.json',rows)
    print('SUITE',suite,flush=True)

if __name__=='__main__':main()
