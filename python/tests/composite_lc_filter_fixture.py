"""Own finite LC circuit realization: Example 8.2, p. 398.

The ideal positive-element circuit and the finite PEC geometry are separate
references. No component or layout is fitted to a measured response. Native
runs are opt-in; a physical enclosure is not an ideal circuit certificate.
"""
import json
import math
from pathlib import Path
import sys

import numpy as np
import CSXCAD
from openEMS import ports as native_ports

from fairbeam import Simulation, excitation, multiport
from fairbeam.network import network_s
from tests.coax_resonator_fixture import save,sha,runtime_identity as base_runtime

ROOT=Path(__file__).resolve().parents[2]
R0, FC, F_ZERO, MATCH = 75.,2e6,2.05e6,.6
CELL=0.004
FREQUENCIES=np.linspace(.5e6,3e6,501)
MESHES=(1,2,3)
KINDS=('filter','through','open')
CONTROLS=('ordinary','time','dt','enclosure','scale')
THREAD_CHOICES=(1,4)
CAP_S, END_DB, OVERSAMPLING = 65e-6,-100.,16
OPERATOR_STEPS=1024
PROTOCOL='composite-lc-filter-v1'
PROPAGATION_MARKER='FAIRBEAM-COMPOSITE-LC-PROPAGATION-BEGIN'
SCOPE=('Own positive-L/C image-filter circuit in a finite PEC enclosure, '
       'two native 75-ohm terminal ports. Intrinsic finite-geometry parasitics '
       'remain; no component fitting, coils, packages or fabricated-filter claim.')
LIMITS=dict(s_target_abs=.005,phase_target_deg=.5,s_mesh_abs=.0025,phase_mesh_deg=.2,
    s_control_abs=.001,phase_control_deg=.1,probe_s_abs=.001,reciprocity_abs=.001,
    singular_power_max=1.005,incident_condition=30.,incident_floor=.02,
    attenuation_error_db=.2,ripple_error_db=.1,feature_frequency_rel=.005,
    group_delay_rel=.02,terminal_energy_end_db=-90.,blank_s_abs=.02,
    open_coupling_abs=.001,resolution_ratio=10.)


def identity():
    names=('tests/composite_lc_filter_fixture.py','tests/test_composite_lc_filter_fixture.py',
        'tests/coax_resonator_fixture.py','tests/test_coax_resonator.py',
        'fairbeam/simulation.py','fairbeam/excitation.py','fairbeam/multiport.py',
        'fairbeam/network.py','fairbeam/procutil.py')
    return {name:sha(ROOT/'python'/name) for name in names}


def runtime_identity():
    value=base_runtime();value.update(python=sys.version,executable=sys.executable,numpy=np.__version__,
        native_ports_sha256=sha(native_ports.__file__))
    value['csxcad_bindings']={str(p.resolve()):sha(p) for p in sorted(Path(CSXCAD.__file__).parent.glob('*.pyd'))+
        sorted(Path(CSXCAD.__file__).parent.glob('*.so'))+[Path(CSXCAD.__file__)]}
    return value


def elements(kind='filter'):
    """Own composite: matching half sections, constant-k T, finite-pole T."""
    if kind not in KINDS:raise ValueError('declared circuit kind required')
    if kind=='through':return []
    l,c=R0/(np.pi*FC),1/(np.pi*FC*R0)
    m=float(np.sqrt(1-(FC/F_ZERO)**2))
    rows=[dict(name=f'L{j}{j+1}',kind='L',a=j,b=j+1,value_si=float(v))
        for j,v in enumerate((MATCH*l/2,l/2,l/2,m*l/2,m*l/2,MATCH*l/2))]
    for node,other,mm,half in ((0,7,MATCH,True),(4,8,m,False),(6,9,MATCH,True)):
        rows.extend((dict(name=f'L{node}{other}',kind='L',a=node,b=other,
            value_si=float((1-mm*mm)*l/((2 if half else 4)*mm))),
            dict(name=f'C{other}g',kind='C',a=other,b=-1,value_si=float(mm*c/(2 if half else 1)))))
    rows.append(dict(name='C2g',kind='C',a=2,b=-1,value_si=float(c)))
    return [row for row in rows if kind!='open' or row['name']!='L34']


def reference(freq=FREQUENCIES,kind='filter'):
    if np.iscomplexobj(freq):raise ValueError('real frequency vector required')
    f=np.asarray(freq,float)
    if f.ndim!=1 or not len(f) or not np.isfinite(f).all() or np.any((f<.5e6)|(f>3e6)):
        raise ValueError('finite frequencies in the declared 0.5..3 MHz band required')
    if kind=='through':
        s=np.zeros((len(f),2,2),complex);s[:,0,1]=s[:,1,0]=1.;return s
    rows=elements(kind)
    return network_s(f,[0,6],z_ref=R0,admittances=[(row['a'],row['b'],
        1/(2j*np.pi*f*row['value_si']) if row['kind']=='L' else 2j*np.pi*f*row['value_si']) for row in rows])


def independent_abcd(freq=FREQUENCIES):
    """Image-section impedance composition, independent of the nodal graph."""
    w=2*np.pi*np.asarray(freq,float);l=R0/(np.pi*FC);c=1/(np.pi*FC*R0)
    m=np.sqrt(1-(FC/F_ZERO)**2)
    def series(z):
        t=np.broadcast_to(np.eye(2,dtype=complex),(len(w),2,2)).copy();t[:,0,1]=z;return t
    def shunt(y):
        t=np.broadcast_to(np.eye(2,dtype=complex),(len(w),2,2)).copy();t[:,1,0]=y;return t
    # ABCD is evaluated away from the exact attenuation pole. The nodal
    # reference remains finite there and is used for the full complex S gate.
    if np.any(abs(w/(2*np.pi)-F_ZERO)<1e-6):raise ValueError('use nodal reference at the exact attenuation pole')
    def y(mm):return 1/(1j*w*(1-mm*mm)*l/(4*mm)+1/(1j*w*mm*c))
    a=shunt(y(MATCH)/2)@series(1j*w*MATCH*l/2)
    b=series(1j*w*l/2)@shunt(1j*w*c)@series(1j*w*l/2)
    d=series(1j*w*m*l/2)@shunt(y(m))@series(1j*w*m*l/2)
    e=series(1j*w*MATCH*l/2)@shunt(y(MATCH)/2)
    total=a@b@d@e
    aa,bb,cc,dd=(total[:,i,j] for i,j in ((0,0),(0,1),(1,0),(1,1)))
    den=aa+bb/R0+cc*R0+dd;s=np.empty_like(total)
    s[:,0,0],s[:,1,1]=(aa+bb/R0-cc*R0-dd)/den,(-aa+bb/R0-cc*R0+dd)/den
    s[:,1,0],s[:,0,1]=2/den,2*(aa*dd-bb*cc)/den
    return s,total


def _integer(value,choices,label):
    if isinstance(value,bool) or not isinstance(value,int) or value not in choices:
        raise ValueError('declared integer '+label+' required')


class CircuitSimulation(Simulation):
    def to_bundle(self,*args,**kwargs):
        raise ValueError('research circuit probes have no Designer bundle representation')


def build(n,port,kind='filter',control='ordinary',threads=1):
    _integer(n,MESHES,'mesh');_integer(port,(1,2),'source');_integer(threads,THREAD_CHOICES,'thread count')
    if kind not in KINDS or control not in CONTROLS or (control!='ordinary' and (n!=1 or kind!='filter')):
        raise ValueError('declared independent coarse-filter control required')
    cell=CELL*(.5 if control=='scale' else 1.)
    dx=cell/n;guard=2 if control=='enclosure' else 0
    coords=[np.arange(-(16+guard)*n,(16+guard)*n+1)*dx,
        np.arange(-(4+guard)*n,(4+guard)*n+1)*dx,
        np.arange(-(1+guard)*n,(5+guard)*n+1)*dx]
    dt=(.35 if control=='dt' else .5)*dx/(299792458.*np.sqrt(3.))
    cap=(8e-6 if kind=='through' else CAP_S)*(2 if control=='time' else 1.)
    steps=math.ceil(cap/dt);end=END_DB-10 if control=='time' else END_DB
    sim=CircuitSimulation(FREQUENCIES[0],FREQUENCIES[-1],excitation='dgauss',
        boundaries=['PEC']*6,end_criteria_db=end,max_timesteps=steps)
    for axis,values in zip('xyz',coords):sim.mesh.AddLine(axis,values/sim.unit)
    sim.fdtd.SetTimeStep(float(dt));sim.fdtd.SetOverSampling(OVERSAMPLING)
    if control=='time':sim.fdtd.SetEndCriteria(0.)  # An actual extended trace, not another early-stop threshold.
    solids=[];boxes={};probe_boxes={}
    def metal(name,a,b):
        p=sim.metal(name);p.AddBox(np.asarray(a)*cell/sim.unit,np.asarray(b)*cell/sim.unit,priority=10)
        solids.append(name)
    metal('ground',[-(16+guard),-(4+guard),0],[(16+guard),(4+guard),0])
    for node in range(7):
        x=4*(node-3);metal(f'node_{node}',[x-1,-2,2],[x+1,2,3])
    if kind!='through':
        for node,other in ((0,7),(4,8),(6,9)):
            x=4*(node-3);metal(f'node_{other}',[x-1,-2,1],[x+1,-1,1])
    else:
        for node in range(6):
            x=4*(node-3);metal(f'bridge_{node}',[x+1,-2,2],[x+3,2,3])
    for number,node in ((1,0),(2,6)):
        x=4*(node-3)
        sim.lumped_port(number,R0,np.array([x-1,1,0])*cell/sim.unit,
            np.array([x+1,2,2])*cell/sim.unit,'z',excite=number==port)
    records=elements(kind)
    for row in records:
        axis='x' if row['kind']=='L' and row['b']==row['a']+1 and row['a']<6 else 'z'
        if axis=='x':
            x=4*(row['a']-3);a,b=[x+1,-2,2],[x+3,2,3];weight=1
        else:
            node=row['a'] if row['a']<7 else {7:0,8:4,9:6}[row['a']]
            x=4*(node-3)
            a,b=([x-1,-2,1],[x+1,-1,2]) if row['kind']=='L' else (
                ([x-1,-2,0],[x+1,-1,2]) if row['name']=='C2g' else ([x-1,-2,0],[x+1,-1,1]))
            weight=-1
        a,b=np.asarray(a,float)*cell,np.asarray(b,float)*cell
        method=sim.lumped_inductor if row['kind']=='L' else sim.lumped_capacitor
        method(row['name'],row['value_si'],a/sim.unit,b/sim.unit,axis)
        boxes[row['name']]=dict(axis=axis,start_m=a.tolist(),stop_m=b.tolist())
        va,vb=(a+b)/2,(a+b)/2;ny='xyz'.index(axis);va[ny]=a[ny];vb[ny]=b[ny]
        vn='lc_v_'+row['name'];sim.csx.AddProbe(vn,p_type=0,weight=weight).AddBox(va/sim.unit,vb/sim.unit)
        ia,ib=a.copy(),b.copy();ia[ny]=ib[ny]=(a[ny]+b[ny])/2
        cn='lc_i_'+row['name'];sim.csx.AddProbe(cn,p_type=1,norm_dir=ny,weight=weight).AddBox(ia/sim.unit,ib/sim.unit)
        probe_boxes[vn]=dict(kind='voltage',start_m=va.tolist(),stop_m=vb.tolist(),weight=weight)
        probe_boxes[cn]=dict(kind='current',axis=ny,start_m=ia.tolist(),stop_m=ib.tolist(),weight=weight)
    port_names=[]
    for p in sim._port_objs:
        port_names.append(dict(voltage=p.U_filenames,current=p.I_filenames))
    for prop in sim.csx.GetAllProperties():prop.SetColor((128,128,128),alpha=prop.GetFillColor()[3])
    if sim.csx.Update():raise ValueError('invalid native finite-circuit geometry')
    meta=dict(protocol=PROTOCOL,n=n,kind=kind,control=control,excited_port=port,threads=threads,
        cell_m=cell,grid=[len(v) for v in coords],native_cells=int(np.prod([len(v) for v in coords])),
        mesh_mm={a:sim.mesh.GetLines(a).tolist() for a in 'xyz'},declared_dt_s=float(dt),
        max_timesteps=steps,cap_s=cap,requested_end_db=end,native_end_ratio=0. if control=='time' else 10**(end/10),
        forced_time_control=control=='time',operator_steps=OPERATOR_STEPS,source_duration_s=excitation.dgauss_duration_s(FREQUENCIES[-1]),
        reference_ohm=R0,elements=records,element_boxes=boxes,solids=solids,port_names=port_names,
        probe_boxes=probe_boxes,oversampling=OVERSAMPLING,scope=SCOPE)
    return sim,meta
