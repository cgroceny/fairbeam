"""Symmetric stripline research fixture; no gallery or design-format changes.

Own parameters for Example 3.5 (p. 143). The zero-thickness PEC reference
uses conformal mapping, with elliptic integrals evaluated by the AGM:
https://courses.egr.uh.edu/ECE/ECE6382/Class%20Notes/Notes%205%206382%20Conformal%20Mapping.pdf
The physical copper thickness is recorded separately from sheet geometry.
"""
import hashlib
import json
from functools import lru_cache
from pathlib import Path

import numpy as np

from fairbeam import Simulation
from openEMS.ports import UI_data
from openEMS.physical_constants import C0, EPS0, MUE0, Z0 as ETA0

B, EPS_R, F0 = 3.2, 2.2, 10e9
WIDTH_RATIO = 30*np.pi / (np.sqrt(EPS_R)*50) - .441
TAND, COPPER_SIGMA, COPPER_T, GROUND_T = .001, 5.8e7, .01, .035
FREQUENCIES = np.linspace(.99*F0, 1.01*F0, 41)
KINDS = ("pec", "dielectric", "copper-sheet", "both-sheet")
LIMITS = {"beta":(.005, .0025, .001), "z":(.01, .005, .002), "alpha":(.03, .02, .01)}


def agm(a, b):
    for _ in range(24):
        a, b = (a+b)/2, np.sqrt(a*b)
    return a


def impedance(width_ratio, eps_r):
    """Infinite-width, zero-thickness PEC strip; b is full ground separation."""
    if not np.isfinite(width_ratio) or not .1 <= width_ratio <= 5:
        raise ValueError("width/b must be in 0.1..5")
    if not np.isfinite(eps_r) or eps_r < 1:
        raise ValueError("finite relative permittivity >=1 required")
    u = np.pi*width_ratio/2
    # K(sech(u))/K(tanh(u)) from two independent AGM complements.
    return float(ETA0/(4*np.sqrt(eps_r))*agm(1., 1/np.cosh(u))/agm(1., np.tanh(u)))


def targets(kind, width_ratio=WIDTH_RATIO, eps_r=EPS_R):
    if kind not in KINDS:
        raise ValueError("unsupported loss case")
    z = capacitance_reference(256,width_ratio,COPPER_T,eps_r)["z0_ohm"]
    sigma_d = 2*np.pi*F0*EPS0*eps_r*TAND if kind in ("dielectric", "both-sheet") else 0.
    er = eps_r-1j*sigma_d/(2*np.pi*FREQUENCIES*EPS0)
    gamma = 1j*2*np.pi*FREQUENCIES/C0*np.sqrt(er)
    dielectric_z = z*np.sqrt(eps_r/er)
    # Dimensionless rewrite of the incremental-inductance approximation;
    # this is a finite-thickness attenuation reference, not an exact eigenroot.
    u, tau = width_ratio, COPPER_T/B
    effective_u = u-max(.35-u, 0)**2
    design_z = 30*np.pi/(np.sqrt(eps_r)*(effective_u+.441))
    resistance = np.sqrt(np.pi*FREQUENCIES*MUE0/COPPER_SIGMA)
    if np.sqrt(eps_r)*design_z < 120:
        shape = 1+2*u/(1-tau)+(1+tau)/(np.pi*(1-tau))*np.log(2/tau-1)
        conductor = resistance*eps_r*design_z*.0027*shape/(30*np.pi*B*1e-3*(1-tau))
    else:
        shape = 1+( .5+.414*tau/u+np.log(4*np.pi*u/tau)/(2*np.pi))/( .5*u+.7*tau)
        conductor = .16*resistance*shape/(design_z*B*1e-3)
    if kind in ("copper-sheet", "both-sheet"):
        gamma = gamma+conductor
    return gamma, dielectric_z


@lru_cache(maxsize=32)
def capacitance_reference(resolution, width_ratio=WIDTH_RATIO, thickness=COPPER_T, eps_r=EPS_R):
    """Independent 2D finite-volume Laplace reference on a finer 1.1-graded mesh.

    Ground/sidewalls have phi=0; the rectangular strip has phi=1. Sum face
    conductances times squared voltage differences to obtain C', then
    Z0=sqrt(eps_r)/(c*C'). No fitted width or FDTD measurements enter this.
    """
    if (isinstance(resolution,bool) or resolution!=int(resolution) or not 32<=resolution<=256
            or not np.isfinite(thickness) or not 0<=thickness<=.1*B):
        raise ValueError("reference resolution in 32..256 and thickness in 0..0.1b required")
    impedance(width_ratio,eps_r)  # validates the material and shape bounds
    ratio,delta,edge = 1.1,B/resolution/12,B*width_ratio/2
    def segment(span):
        count = int(np.ceil(np.log1p(span/delta*(ratio-1))/np.log(ratio)))
        step = span*(ratio-1)/(ratio**count-1)
        points = np.cumsum(step*ratio**np.arange(count))
        points[-1] = span
        return points
    outward = list(np.r_[0.,(edge-segment(edge))[-2::-1],edge])
    step = delta
    while outward[-1]<50*B:
        step *= ratio
        outward.append(min(outward[-1]+step,50*B))
    y = np.r_[-np.asarray(outward[:0:-1]),outward]
    heights = thickness/2+segment((B-thickness)/2)
    middle = [-thickness/2,thickness/2] if thickness else [0.]
    z = np.r_[-heights[::-1],middle,heights]
    dy,dz = np.diff(y),np.diff(z)
    wy = np.r_[dy[0]/2,(dy[:-1]+dy[1:])/2,dy[-1]/2]
    wz = np.r_[dz[0]/2,(dz[:-1]+dz[1:])/2,dz[-1]/2]
    gy,gz = wz[:,None]/dy[None,:],wy[None,:]/dz[:,None]
    electrode = (abs(z[:,None])<=thickness/2)&(abs(y[None,:])<=edge)
    free = ~electrode
    free[[0,-1],:] = False
    free[:,[0,-1]] = False
    def operator(values):
        out = np.zeros_like(values)
        fy,fz = gy*np.diff(values,axis=1),gz*np.diff(values,axis=0)
        out[:,1:] += fy; out[:,:-1] -= fy
        out[1:,:] += fz; out[:-1,:] -= fz
        return out
    diagonal = np.zeros(free.shape)
    diagonal[:,1:] += gy; diagonal[:,:-1] += gy
    diagonal[1:,:] += gz; diagonal[:-1,:] += gz
    fixed = electrode.astype(float)
    rhs = -operator(fixed)[free]
    def product(vector):
        values = np.zeros(free.shape)
        values[free] = vector
        return operator(values)[free]
    inverse = 1/diagonal[free]
    values,residual = np.zeros(rhs.shape),rhs.copy()
    direction = inverse*residual
    scalar = np.dot(residual,direction)
    for iterations in range(1,4001):
        applied = product(direction)
        step = scalar/np.dot(direction,applied)
        values += step*direction; residual -= step*applied
        if np.linalg.norm(residual)<=1e-11*np.linalg.norm(rhs):
            break
        next_scalar = np.dot(residual,inverse*residual)
        direction = inverse*residual+(next_scalar/scalar)*direction
        scalar = next_scalar
    else:
        raise RuntimeError("capacitance reference residual did not converge")
    fixed[free] = values
    energy = np.sum(gy*np.diff(fixed,axis=1)**2)+np.sum(gz*np.diff(fixed,axis=0)**2)
    capacitance = EPS0*eps_r*energy
    return {"z0_ohm":float(np.sqrt(eps_r)/(C0*capacitance)),"capacitance_per_m":float(capacitance),
        "iterations":iterations,"nodes":fixed.size,"residual_rel":float(np.linalg.norm(residual)/np.linalg.norm(rhs))}


def graded_segment(span, delta):
    ratio = 1.3
    count = int(np.ceil(np.log1p(span/delta*(ratio-1))/np.log(ratio)))
    first = span*(ratio-1)/(ratio**count-1)
    half = np.cumsum(first*ratio**np.arange(count))
    half[-1] = span
    return half


def transverse_lines(n, width, finite):
    edge, delta = width/2, B/n/12
    end = edge if finite else edge-delta/3
    positive = list(np.r_[0., (end-graded_segment(end,delta))[-2::-1], end])
    positive.append(edge+delta if finite else edge+2*delta/3)
    step = delta
    while positive[-1] < 50*B:
        step *= 1.3
        positive.append(min(positive[-1]+step, 50*B))
    return np.r_[-np.asarray(positive[:0:-1]), positive]


def vertical_lines(n, thickness):
    # Resolve fringing around the thin strip in both transverse directions.
    # A uniform z grid with fine y edges alone converges impedance slowly.
    delta, gap = B/n/12, (B-thickness)/2
    half = graded_segment(gap,delta)
    physical = thickness/2+half
    outer = B/2 + (half[-1]-half[-2])*np.arange(1, 3)
    positive = np.r_[physical, outer]
    middle = [-thickness/2, thickness/2] if thickness else [0.]
    return np.r_[-positive[::-1], middle, positive], thickness/2+(half[0]+half[1])/2


def build(n, kind="pec", width_ratio=WIDTH_RATIO, eps_r=EPS_R, geometry_thickness=COPPER_T):
    if isinstance(n, bool) or n != int(n) or n < 8 or n > 32 or n % 4:
        raise ValueError("resolution must be a multiple of four in 8..32")
    if kind not in KINDS:
        raise ValueError("unsupported loss case")
    if not np.isfinite(geometry_thickness) or not 0 <= geometry_thickness <= .1*B:
        raise ValueError("conductor thickness must be in 0..0.1b")
    reference = impedance(width_ratio, eps_r)
    n, width = int(n), B*width_ratio
    dx = 4/n
    x = dx*np.arange(-16, 15*n+17)
    for i in range(16):
        x[16+i*n] = 4*i
    y = transverse_lines(n, width, bool(geometry_thickness))
    z, loop_z = vertical_lines(n, geometry_thickness)
    cells = (len(x)-1)*(len(y)-1)*(len(z)-1)
    if cells > 4_000_000:
        raise ValueError("stripline fixture cell budget exceeded")
    sim = Simulation(.1*F0, 1.9*F0, excitation="gauss", end_criteria_db=-70,
        max_timesteps=2_000_000, boundaries=["PML_8", "PML_8", "PEC", "PEC", "PEC", "PEC"])
    for a, lines in zip("xyz", (x, y, z)):
        sim.mesh.AddLine(a, lines)
    dielectric = kind in ("dielectric", "both-sheet")
    sim.dielectric("substrate", eps_r, tan_d=TAND if dielectric else 0).AddBox(
        [x[0], y[0], -B/2], [x[-1], y[-1], B/2], priority=1)
    lossy = kind in ("copper-sheet", "both-sheet")
    # Explicit one-sided attenuation surrogate on a finite rectangular shell.
    # Native thick two-sided sheets have Re(Z)=Rs/2; sigma/4 restores Rs.
    # Twice the physical thickness preserves the skin-depth/thickness ratio.
    # This does not assert bulk-metal reactive phase or penetration equivalence.
    finite = bool(geometry_thickness)
    strip = sim.metal("strip", conductivity=COPPER_SIGMA/(4 if finite else 1) if lossy else None,
                      thickness=2*COPPER_T if finite else COPPER_T)
    for height in sorted(set((-geometry_thickness/2, geometry_thickness/2))):
        strip.AddBox([x[0], -width/2, height], [x[-1], width/2, height], priority=10)
    if finite:
        for side in (-width/2, width/2):
            strip.AddBox([x[0], side, -geometry_thickness/2],
                         [x[-1], side, geometry_thickness/2], priority=10)
    ground = sim.metal("grounds", conductivity=COPPER_SIGMA/4 if lossy else None, thickness=GROUND_T)
    for sign in (-1, 1):
        ground.AddBox([x[0], y[0], sign*B/2], [x[-1], y[-1], sign*B/2], priority=10)
    sim.lumped_port(1, reference, [x[14], -width/2, -B/2], [x[14], width/2, -geometry_thickness/2], "z",
        group={"connection":"parallel", "members":[{"start":[x[14], -width/2, geometry_thickness/2],
              "stop":[x[14], width/2, B/2], "direction":"z", "polarity":-1}]})
    metal_y = np.flatnonzero(abs(y) <= width/2)
    low, high = metal_y[0], metal_y[-1]
    loop_low = y[low]-(y[low]-y[low-1])/2
    loop_high = y[high]+(y[high+1]-y[high])/2
    for p, centre in enumerate((24., 28., 32., 36., 40., 44.)):
        index = int(np.flatnonzero(x == centre)[0])
        for j, plane in enumerate(x[index-1:index+2]):
            for half, a, b, weight in ((0, -B/2, -geometry_thickness/2, -.5),
                                     (1, geometry_thickness/2, B/2, .5)):
                sim.csx.AddProbe(f"v{p}_{j}_{half}", p_type=0, weight=weight).AddBox(
                    [plane, 0, a], [plane, 0, b])
        for j, plane in enumerate((centre-dx/2, centre+dx/2)):
            sim.csx.AddProbe(f"i{p}_{j}", p_type=1, norm_dir=0).AddBox(
                [plane, loop_low, -loop_z], [plane, loop_high, loop_z])
    return sim


def extract(v, i, dx):
    """Exact uniform-line inversion on staggered V/I spatial samples.

    v: (...,3,f) at x-dx,x,x+dx; i: (...,2,f) at x-dx/2,x+dx/2.
    The inverse-sinh removes spatial differencing bias. Branch signs keep
    positive phase and positive-real impedance; signed loss is not clipped.
    """
    v, i = np.asarray(v), np.asarray(i)
    if v.shape[-2] != 3 or i.shape[-2] != 2 or v.shape[:-2] != i.shape[:-2] or v.shape[-1] != i.shape[-1]:
        raise ValueError("three voltages and two currents on matching frequency grids required")
    if not np.isfinite(dx) or dx <= 0 or not np.all(np.isfinite(v)) or not np.all(np.isfinite(i)):
        raise ValueError("finite data and positive spacing required")
    u, current = v[..., 1, :], np.mean(i, axis=-2)
    dv, di = (v[..., 2, :]-v[..., 0, :])/(2*dx), (i[..., 1, :]-i[..., 0, :])/dx
    if np.any(abs(u)==0) or np.any(abs(current)==0) or np.any(abs(di)==0):
        raise ValueError("singular local propagation or impedance estimate")
    if np.any(abs(u) < .01*np.max(abs(v), axis=-2)) or np.any(abs(current) < .01*np.max(abs(i), axis=-2)):
        raise ValueError("standing-wave node makes local inversion ill-conditioned")
    wave = np.sqrt(dv*di/(u*current))
    gamma = 2/dx*np.arcsinh(dx*wave/2)
    gamma = np.where(gamma.imag < 0, -gamma, gamma)
    z = np.sqrt(u*dv/(current*di))
    z = np.where(z.real < 0, -z, z)
    if np.any(~np.isfinite(gamma)) or np.any(~np.isfinite(z)):
        raise ValueError("singular local propagation or impedance estimate")
    return gamma, z


def propagation(v):
    """Reflection-independent gamma from two triplets separated by 8 mm.

    This fixed 9.9..10.1 GHz, eps_r<=3 protocol is below the principal
    phase branch. Signed attenuation, including numerical bias, is retained.
    """
    u, distance = np.asarray(v)[:, 1, :], .008
    if u.shape[0] != 6 or np.any(~np.isfinite(u)):
        raise ValueError("six finite phase-plane spectra required")
    rows = []
    for offset in (0, 1):
        a, b, c = u[offset:offset+5:2]
        if np.any(abs(a)+abs(b)+abs(c)==0):
            raise ValueError("singular triplet propagation estimate")
        if np.any(abs(b) < .01*np.maximum(abs(a), abs(c))):
            raise ValueError("standing-wave node makes triplet inversion ill-conditioned")
        g = np.arccosh((a+c)/(2*b))/distance
        if np.any(~np.isfinite(g)):
            raise ValueError("singular triplet propagation estimate")
        rows.append(np.where(g.imag < 0, -g, g))
    return np.asarray(rows)


def acquire(out, n, kind, width_ratio=WIDTH_RATIO, eps_r=EPS_R, geometry_thickness=COPPER_T):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sha = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    if not 1 <= eps_r <= 3:
        raise ValueError("fixed phase-triplet protocol supports eps_r in 1..3")
    sim = build(n, kind, width_ratio, eps_r, geometry_thickness)
    cells = int(np.prod([len(sim.mesh.GetLines(a))-1 for a in "xyz"]))
    sim.run(str(out/"raw"), threads=4, exact=True, echo=False)
    try:
        v = np.asarray(UI_data([f"v{p}_{j}_{h}" for p in range(6) for j in range(3) for h in range(2)],
            str(out/"raw"), FREQUENCIES).ui_f_val).reshape(6, 3, 2, -1).sum(axis=2)
        i = np.asarray(UI_data([f"i{p}_{j}" for p in range(6) for j in range(2)],
            str(out/"raw"), FREQUENCIES).ui_f_val).reshape(6, 2, -1)
    except Exception:
        (out/"failure.json").write_text(json.dumps(sim.run_stats, indent=2)+"\n", encoding="utf-8")
        raise
    t = np.loadtxt(out/"raw/et", max_rows=2)[:, 0]
    local_gamma, z = extract(v, i, 4/n*sim.unit)
    gamma = propagation(v)
    np.savez_compressed(out/"data.npz", f=FREQUENCIES, v=v, i=i, gamma=gamma, z=z, local_gamma=local_gamma)
    meta = {"resolution":n, "kind":kind, "width_ratio":width_ratio, "eps_r":eps_r,
        "a_over_b":100, "geometry_thickness_mm":geometry_thickness, "physical_sheet_thickness_mm":COPPER_T,
        "cells":cells, "dt_s":float(t[1]-t[0]), "run":sim.run_stats,
        "ground_sheet_thickness_mm":GROUND_T, "fixture_sha256":sha,
        "gamma_mid":[[float(a.real),float(a.imag)] for a in gamma[:,20]],
        "z_mid":[[float(a.real),float(a.imag)] for a in z[:,20]]}
    (out/"report.json").write_text(json.dumps(meta, indent=2)+"\n", encoding="utf-8")
    return meta


def analyse(root, meshes):
    """Limited, separately gated phase, impedance and attenuation comparisons."""
    if len(meshes) < 3 or meshes != sorted(set(meshes)):
        raise ValueError("three increasing mesh levels required")
    root, records, fingerprint = Path(root), {}, None
    for kind in KINDS:
        for n in meshes:
            dest = root/kind/f"n{n}"
            meta = json.loads((dest/"report.json").read_text(encoding="utf-8"))
            identity = (meta["resolution"],meta["kind"],meta["width_ratio"],meta["eps_r"],
                        meta["geometry_thickness_mm"],meta["a_over_b"])
            if identity != (n,kind,WIDTH_RATIO,EPS_R,COPPER_T,100) or meta["run"].get("threads") != 4:
                raise ValueError("acquisition identity or four-thread protocol differs")
            sha = meta.get("fixture_sha256")
            if not sha or (fingerprint is not None and sha != fingerprint):
                raise ValueError("all acquisitions must share one source fingerprint")
            fingerprint = sha
            with np.load(dest/"data.npz") as data:
                np.testing.assert_array_equal(data["f"], FREQUENCIES)
                gamma, z = data["gamma"].copy(),data["z"].copy()
            if gamma.shape != (2,len(FREQUENCIES)) or z.shape != (6,len(FREQUENCIES)) or np.any(~np.isfinite(gamma)) or np.any(~np.isfinite(z)):
                raise ValueError("invalid propagation or impedance spectra")
            records[kind,n] = meta,gamma,z
    rows, last = [], {}
    for kind in KINDS:
        previous, group = None, []
        target_g, target_z = targets(kind)
        for n in meshes:
            meta,gamma,z = records[kind,n]
            pec_meta,pec_gamma,_ = records["pec",n]
            quantities = {"beta":gamma.imag,"z":z,
                          "alpha":gamma.real-pec_gamma.real}
            expected = {"beta":target_g.imag,"z":target_z,"alpha":target_g.real}
            metrics = {}
            for key, value in quantities.items():
                if key == "alpha" and kind == "pec":
                    continue
                ref = expected[key]
                error = float(np.max(abs((value-ref)/ref)))
                spread = float(np.max(abs(value-np.mean(value,axis=0))/abs(ref)))
                change = None if previous is None else float(np.max(abs(value-previous[key])/abs(ref)))
                a,b,c = LIMITS[key]
                metrics[key] = {"target_rel_max":error,"spread_rel_max":spread,"mesh_rel_max":change,
                                "matches":error<=a and spread<=c,"mesh_pair_passes":change is not None and change<=b}
            stopped = lambda r: bool(r.get("converged") and r.get("exact_endcriteria")
                and not r.get("hit_timestep_limit",False)
                and r.get("final_energy_db",r.get("final_energy_bound_db",0))<=-70)
            row = {"kind":kind,"resolution":n,"cells":meta["cells"],"dt_ps":meta["dt_s"]*1e12,
                "energy_stopped":stopped(meta["run"]) and stopped(pec_meta["run"]),"metrics":metrics,
                "beta_mid":float(np.mean(gamma.imag[:,20])),
                "alpha_corrected_mid":float(np.mean(quantities["alpha"][:,20])),
                "raw_alpha_mid":gamma.real[:,20].tolist(),
                "z_mid":[float(np.mean(z[:,20]).real),float(np.mean(z[:,20]).imag)],
                "accepted_scope":{key:False for key in metrics}}
            group.append(row)
            previous = quantities
        for index,row in enumerate(group):
            if index < 2:
                continue
            for key in row["metrics"]:
                row["accepted_scope"][key] = bool(all(r["energy_stopped"] for r in group[index-2:index+1])
                    and all(r["metrics"][key]["matches"] and r["metrics"][key]["mesh_pair_passes"] for r in group[index-1:index+1]))
            # No independent bulk-copper reactive-phase or impedance reference.
            if kind in ("copper-sheet", "both-sheet"):
                row["accepted_scope"]["beta"] = row["accepted_scope"]["z"] = False
            if kind == "both-sheet":
                row["accepted_scope"]["alpha"] &= all(last[k][index]["accepted_scope"]["alpha"] for k in ("dielectric","copper-sheet"))
        last[kind] = group
        rows.extend(group)
    (root/"comparison.json").write_text(json.dumps(rows,indent=2)+"\n",encoding="utf-8")
    return rows
