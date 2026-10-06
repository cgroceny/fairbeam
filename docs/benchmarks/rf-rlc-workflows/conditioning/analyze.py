"""Read-only numerical replay; no openEMS import or solver invocation."""
import argparse, json, hashlib
from pathlib import Path
import numpy as np

HERE = Path(__file__).parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--runs', type=Path, required=True, help='Retained final fixture directory containing validation.json and R/series/parallel signals')
parser.add_argument('--source', type=Path, required=True, help='Exact optimized openEMS source tree used for the retained native runs')
parser.add_argument('--output', type=Path, required=True, help='Fresh JSON output path; retained evidence is never overwritten')
args = parser.parse_args()
if args.output.exists():
    parser.error('output already exists; choose a fresh path')
RUN, SRC = args.runs, args.source
# Frozen before evaluating: original complex-Z tolerance and stricter double control.
TOLERANCE = .10
DOUBLE_CONTROL = .005
MEASURED_MATCH_OHM = 3.0
records = json.loads((RUN/'validation.json').read_text())
series = next(x for x in records if x['case']=='series')
freq = np.array(series['frequency_hz'])
ideal = 100+1j*(2*np.pi*freq*2e-9-1/(2*np.pi*freq*1e-12))
measured = np.array(series['zin_re'])+1j*np.array(series['zin_im'])
dt_energy_print = float(np.loadtxt(RUN/'series/et')[1,0])
port_time = np.loadtxt(RUN/'series/port_ut_1',comments='%')[:,0]
sample_stride = int(round(port_time[1]/dt_energy_print))
dt = float(port_time[1]/sample_stride)
R,L,C = 600.,12e-9,1e-12/6

def coefficients(dt, cd, dtype):
    # BuildExtension computes doubles then stores FDTD_FLOAT arrays separately.
    ib0=2*dt*C/(4*L*C+2*dt*R*C+dt*dt)
    b1=(dt*dt-4*L*C)/(dt*C)
    b2=(4*L*C-2*dt*R*C+dt*dt)/(2*dt*C)
    cd=float(dtype(cd)) # EC_C and local Cd are FDTD_FLOAT too.
    return np.array([ib0,b1,b2,.5*dt*ib0/cd,.5*dt*(b1*ib0-1)/cd,
                     .5*dt*b2*ib0/cd,1/(1+.5*dt*ib0/cd)],dtype=dtype)

def impedance(dt, cd, dtype):
    k=coefficients(dt,cd,dtype)
    ib,b1,b2,vv,vj1,vj2,vd=map(float,k)
    # Runtime b1*ib0 and b2*ib0 rounded in FDTD_FLOAT before multiplying state.
    a1=float(dtype(k[0]*k[1])); a2=float(dtype(k[0]*k[2]))
    q=np.exp(-2j*np.pi*freq*dt)
    h=ib*(1-q*q)/(1+a1*q+a2*q*q)
    # Base cell raw voltage = V[n-1]+dt/Cd * external edge current.
    # Eliminate J from actual voltage correction and retain its rounded coefficients.
    y=float(dtype(cd))/dt*(1/vd-q-vv*q*q-(vj1*q+vj2*q*q)*h)
    # Current probes are at half-step: center admittance by exp(+j*w*dt/2).
    z=1/(6*y*np.exp(1j*np.pi*freq*dt))
    z_current=1/(6*h*(1+q)/2*np.exp(1j*np.pi*freq*dt))
    return z,z_current,dict(coefficients=k.tolist(),a1=a1,a2=a2,p_at_1=1+a1+a2,
        effective_C_pF=(dt*dt/(L*(1+a1+a2)))*6*1e12 if 1+a1+a2 else None)

rows=[]
# Dual areas around snapped x/y nodes, dz=.2 units, unit=1e-4 m:
# x dual widths .1/.05 mm-equivalent and y widths .2 => Cd~0.89/1.33e-16.
for factor in [1.,.5,.25,2.]:
    for cd in [8.8541878128e-17,1.32812817192e-16]:
        for dtype in [np.float64,np.float32]:
            z,j,k=impedance(dt*factor,cd,dtype)
            # Removing measured shared shunt is diagnostic only, never changes pass threshold.
            corrected=1/(1/measured-1j*2*np.pi*freq*8.5e-15)
            row=dict(dt_factor=factor,cell_C_F=cd,precision=dtype.__name__,**k,
                max_complex_relative_error=float(np.max(abs(z-ideal)/abs(ideal))),
                max_current_only_relative_error=float(np.max(abs(j-ideal)/abs(ideal))),
                max_measured_corrected_distance_ohm=float(np.max(abs(z-corrected))),
                original_10pct_pass=bool(np.max(abs(z-ideal)/abs(ideal))<=TOLERANCE),
                z_re=z.real.tolist(),z_im=z.imag.tolist())
            rows.append(row)

def replay(dtype,steps):
    # Prescribed Gaussian voltage: exercises exact engine J arithmetic, not spatial field coupling.
    n=np.arange(steps);t=n*dt;v=np.exp(-((t-5e-10)/7e-11)**2).astype(dtype)
    k=coefficients(dt,8.8541878128e-17,dtype);ib,b1,b2=k[:3]
    j=np.zeros(len(n),dtype=dtype)
    for i in range(2,len(n)):
        j[i]=dtype(dtype(ib*dtype(v[i]-v[i-2]))-dtype(dtype(b1*ib)*j[i-1])-dtype(dtype(b2*ib)*j[i-2]))
    kernel=np.exp(-2j*np.pi*freq[:,None]*t)
    h=(kernel@j.astype(float))/(kernel@v.astype(float))
    q=np.exp(-2j*np.pi*freq*dt)
    z=1/(6*h*(1+q)/2*np.exp(1j*np.pi*freq*dt))
    return dict(precision=dtype.__name__,steps=steps,max_complex_relative_error=float(np.max(abs(z-ideal)/abs(ideal))),
        tail_max_abs_current=float(np.max(abs(j[-1000:]))),z_re=z.real.tolist(),z_im=z.imag.tolist())

tails=[]
for case in ['R','series','parallel']:
    v=np.loadtxt(RUN/case/'port_ut_1',comments='%')
    # 44-ish retained samples and source still present: log slope is descriptive, not pole identification.
    for start in [.7e-9,.8e-9]:
        mask=(v[:,0]>=start)&(abs(v[:,1])>0)
        slope=float(np.polyfit(v[mask,0],np.log(abs(v[mask,1])),1)[0]) if mask.sum()>2 else None
        tails.append(dict(case=case,start_s=start,samples=int(mask.sum()),log_abs_voltage_slope_per_s=slope))

paths=['tools/constants.h','FDTD/operator.cpp','FDTD/extensions/operator_ext_lumpedRLC.cpp',
       'FDTD/extensions/engine_ext_lumpedRLC.cpp','FDTD/extensions/operator_ext_lumpedRLC.h']
rounded_z,_,rounded_k=impedance(dt_energy_print,8.8541878128e-17,np.float32)
out=dict(tolerance=TOLERANCE,double_control_tolerance=DOUBLE_CONTROL,measured_match_ohm=MEASURED_MATCH_OHM,
    dt_s=dt,dt_energy_print_s=dt_energy_print,port_sample_stride=sample_stride,
    source_sha256={p:hashlib.sha256((SRC/p).read_bytes()).hexdigest() for p in paths},
    input_sha256={str(p.relative_to(RUN)):hashlib.sha256(p.read_bytes()).hexdigest()
        for p in [RUN/'validation.json',RUN/'series/port_ut_1',RUN/'series/port_it_1',RUN/'series/et']},
    rounded_log_timestep_sensitivity=dict(**rounded_k,max_complex_relative_error=float(np.max(abs(rounded_z-ideal)/abs(ideal)))),
    retained_series_original_error=series['max_relative_error'],coefficient_cases=rows,
    prescribed_voltage_replay=[replay(precision,steps) for steps in [49676,150000] for precision in [np.float64,np.float32]],tail_descriptive_slopes=tails,
    limitations=['No spatial fields, source-port coupling, compiler FMA behavior, or SSE execution replayed.',
      'Cd range estimates from mesh; exact stored edge coefficients unavailable.',
      'Tail slopes are not fitted physical poles: few samples and continuing source prohibit reliable Prony attribution.'])
args.output.write_text(json.dumps(out,indent=2), encoding='utf-8')
for r in rows:
    print(r['dt_factor'],r['precision'],r['cell_C_F'],'P(1)',r['p_at_1'],'error',r['max_complex_relative_error'],'match ohm',r['max_measured_corrected_distance_ohm'])
print('replay',out['prescribed_voltage_replay']);print('tails',tails)
