// Project bundle schema "fairbeam.project/1" (written by python/fairbeam/simulation.py)

export type Vec3 = [number, number, number];
/** Row-major homogeneous matrix, applied to column vectors in drawing coordinates. */
export type Matrix4Rows = [[number, number, number, number], [number, number, number, number], [number, number, number, number], [number, number, number, number]];

export interface BoxPrim { kind: "box"; start: Vec3; stop: Vec3; priority: number; bbox: [Vec3, Vec3]; exact: true }
export interface PolygonPrim {
  kind: "polygon" | "linpoly";
  normal: 0 | 1 | 2;
  elevation: number;
  /** in-plane coordinates: [axis (n+1)%3, axis (n+2)%3] */
  points: [number, number][];
  length?: number;
  priority: number;
  bbox: [Vec3, Vec3];
  exact: true;
}
export interface CylinderPrim { kind: "cylinder"; start: Vec3; stop: Vec3; radius: number; priority: number; bbox: [Vec3, Vec3]; exact: true }
/** Tube (CSXCAD CylindricalShell): `radius` is the middle of the wall, `shell_width` its thickness. */
export interface ShellPrim { kind: "cylindricalshell"; start: Vec3; stop: Vec3; radius: number; shell_width: number; priority: number; bbox: [Vec3, Vec3]; exact: true }
export interface SpherePrim { kind: "sphere"; center: Vec3; radius: number; priority: number; bbox: [Vec3, Vec3]; exact: true }
/** Thin wire along a polyline: CSXCAD Curve (no radius: rasterised onto mesh edges) or Wire (radius). */
export interface WirePrim { kind: "curve" | "wire"; points: Vec3[]; radius?: number; priority: number; bbox: [Vec3, Vec3]; exact: true }
/** Closed solid from vertices and (triangular) faces, indices into vertices. */
export interface PolyhedronPrim { kind: "polyhedron"; vertices: Vec3[]; faces: number[][]; priority: number; bbox: [Vec3, Vec3]; exact: true }
/** Solid of revolution (CSXCAD RotPoly, a full turn): the (radial, axial) `points` turned about the
 * line through `origin` along axis `axis`; the designer's cone and torus. */
export interface RotPolyPrim { kind: "rotpoly"; axis: 0 | 1 | 2; origin: Vec3; points: [number, number][]; priority: number; bbox: [Vec3, Vec3]; exact: true }
/** Unsupported or transformed primitive: only its bounding box is known. */
export interface BBoxPrim { kind: "bbox"; source_kind: string; priority: number; bbox: [Vec3, Vec3]; exact: false; transformed?: boolean }
export type LocalPrimitive = BoxPrim | PolygonPrim | CylinderPrim | ShellPrim | SpherePrim | WirePrim | PolyhedronPrim | RotPolyPrim;
/** An exact CSXCAD primitive instance with a world-space affine transform. Older readers see an
 * unknown kind rather than mistaking its local coordinates for world coordinates. `matrix` is
 * row-major and maps column vectors; `bbox` is its world-space axis-aligned bound. */
export interface TransformedPrim { kind: "transformed"; primitive: LocalPrimitive; matrix: Matrix4Rows; priority: number; bbox: [Vec3, Vec3]; exact: true }
export type Primitive = LocalPrimitive | TransformedPrim | BBoxPrim;

export interface Part {
  name: string;
  label?: string;
  type: "Metal" | "Material" | "ConductingSheet" | string;
  primitives: Primitive[];
  bbox: [Vec3, Vec3];
  color?: string;
  /** a vacuum carver (a Boolean Subtract of curved shapes): not material; drawn as a ghost and skipped by exporters */
  void?: true;
  material?: {
    eps_r: number; kappa: number; mu_r: number; tan_d: number | null; tan_d_freq: number | null; isotropic: boolean;
    /** a frequency-dependent dielectric (Python Simulation.dispersive); eps_r, mu_r and tan_d are
     * then its values at tan_d_freq, the band centre (docs/BUNDLE.md, parts) */
    dispersion?: Dispersion;
  };
  /** a lossy metal: conductivity in S/m, and the modelled thickness in mm of a ConductingSheet (null
   * for a volume, type "Material", which is still a metal) */
  conductor?: { conductivity: number; thickness: number | null };
}

/** A dispersive material's model (fairbeam.dispersion). Pole frequencies in Hz, times in s. */
export interface Dispersion {
  model: "debye" | "lorentz" | "constant" | string;
  eps_inf?: number;
  kappa?: number;
  eps_poles?: DispersionPole[];
  mu_inf?: number;
  mu_poles?: DispersionPole[];
  /** where the poles came from, e.g. a Djordjevic-Sarkar laminate and its fit report */
  source?: Record<string, unknown>;
}

export type DispersionPole =
  | { type: "debye"; delta: number; tau: number }
  | { type: "lorentz"; f_plasma: number; f_pole: number; tau: number };

export interface Port {
  number: number;
  /** "lumped" (openEMS LumpedPort) or "waveguide" (RectWGPort, one TE mode) */
  type: "lumped" | "waveguide";
  /** lumped: port resistance; waveguide: TE wave impedance at the band centre (ohm) */
  R: number;
  direction: "x" | "y" | "z";
  /** waveguide: the excitation plane is at start, the mode probes at stop (along direction) */
  start: Vec3;
  stop: Vec3;
  excite: boolean;
  reference_impedance?: { real: number; imag: number };
  /** waveguide ports: mode name (e.g. "TE10"), broad/narrow wall (drawing units), cutoff (Hz) */
  mode?: string;
  a?: number;
  b?: number;
  f_cutoff?: number;
  /** Opt-in selected mode. This port's start/stop/direction is the first positive feed. */
  group?: {
    connection: "parallel" | "series";
    members: { start: Vec3; stop: Vec3; direction: "x" | "y" | "z"; polarity?: 1 | -1 }[];
    priority?: number;
  };
}

/** Lumped circuit element that is not a port (e.g. a Wilkinson isolation resistor). */
export interface LumpedElement {
  name: string;
  label: string;
  type: "resistor" | "rlc";
  /** native values in ohms, henries and farads */
  R?: number;
  L?: number;
  C?: number;
  topology?: "parallel" | "series";
  /** direction of the element current */
  direction: "x" | "y" | "z";
  start: Vec3;
  stop: Vec3;
}

export interface SParamQA {
  /** max over frequency and pairs of |S_ij - S_ji| (null if fewer than two columns are known) */
  reciprocity_max: number | null;
  reciprocity_pairs: Record<string, number>;
  /** per excited port j: max / min over frequency of sum_i |S_ij|^2 */
  column_power_max: Record<string, number>;
  column_power_min: Record<string, number>;
  /** max of column_power_max (must be <= 1 for a passive structure) */
  passivity_max: number | null;
  passive: boolean;
  passive_tol: number;
}

/** N-port S-matrix: one openEMS run per excited port; see docs/BUNDLE.md#sparams */
export interface SParams {
  /** 1-based matrix indices, in matrix order */
  ports: number[];
  /** reference impedance of each port (ohm): the lumped port resistance */
  z_ref: number[];
  /** ports that were driven (the known columns) */
  excited: number[];
  /** true when every port was excited (full matrix) */
  complete: boolean;
  /** "B A^-1" (complete) or "b_i / a_j" (partial, terminated ports assumed matched) */
  method: string;
  /** keys "i,j" = S_ij (receiving port i, driven port j), arrays aligned with results.frequency */
  s: Record<string, { re: number[]; im: number[] }>;
  qa: SParamQA;
  /** model port numbers when they are not 1..N (matrix index k -> port_numbers[k-1]) */
  port_numbers?: number[];
}

/** Embedded element patterns, compact encoding; see docs/BUNDLE.md#element_patterns */
export interface ElementPatternsSection {
  normalization: string;
  radius_m: number;
  /** "i16le-base64-scaled" (current writer): little-endian int16 q, value = q * fields[].scale / 32767;
   *  "f32le-base64" (older bundles): little-endian float32 */
  encoding: "i16le-base64-scaled" | "f32le-base64";
  /** [n_theta, n_phi]; every field array holds n_theta * n_phi values, row-major [theta][phi] */
  shape: [number, number];
  theta: number[];
  phi: number[];
  frequencies: number[];
  /** angular decimation factor applied to the far-field grid (1 = none) */
  decimation: number;
  mirror_planes: number;
  phase_center: Vec3;
  ports: {
    port: number;
    /** port centre (drawing units), used as the element position for steering */
    position: Vec3;
    /** scale = max |component| over the entry's four arrays (only with "i16le-base64-scaled") */
    fields: { f: number; scale?: number; e_theta_re: string; e_theta_im: string; e_phi_re: string; e_phi_im: string }[];
  }[];
}

export interface Param {
  key: string;
  label: string;
  unit: string;
  value: number | string;
  default: number | string;
  description: string;
  minimum: number | null;
  maximum: number | null;
}

export interface FarField {
  f: number;
  theta: number[];
  phi: number[];
  /** [theta][phi] */
  directivity_dbi: number[][];
  dmax_dbi: number;
  /** Dmax from integrating the pattern itself (4 pi U_max / integral U), mirror-corrected; optional */
  dmax_pattern_dbi?: number;
  gain_dbi?: number;
  realized_gain_dbi?: number;
  rad_efficiency: number | null;
  /** lossless models (sim.lossless): the measured prad_w / pacc_w, while rad_efficiency is 1 (docs/BUNDLE.md) */
  rad_efficiency_raw?: number | null;
  prad_w: number;
  pacc_w: number;
  /** exporter QA notes, e.g. a radiation efficiency above 100 % (see lib/run.efficiencyWarning) */
  qa_warnings?: string[];
  mirror_planes?: number;
  /** excited port this pattern belongs to (multi-port runs; one entry per excited port and frequency) */
  port?: number;
  /** circular polarisation (models that set cp_outputs); IEEE convention, see docs/BUNDLE.md */
  cp?: CircularPolarisation;
}

/** Radiation efficiency Prad / Pacc at N frequencies from f_min to f_max (results.efficiency). Total
 * efficiency is rad_efficiency · (1 − |S11|²) with S11 of `port` at `f`. */
export interface EfficiencySweep {
  port?: number; f: number[]; prad_w: number[]; pacc_w: number[]; rad_efficiency: (number | null)[]; mirror_planes: number; theta_step: number; phi_step: number; qa_warnings?: string[];
  /** estimated relative error of pacc_w from where the run stopped (docs/BUNDLE.md#efficiency) */
  pacc_error?: (number | null)[];
  /** false where that error exceeds 10 %: the value is kept, but it is not trustworthy */
  reliable?: boolean[];
  /** lossless models: the measured prad_w / pacc_w */
  rad_efficiency_raw?: (number | null)[];
}

export interface CPPoint { theta: number; phi?: number; rhcp_dbi: number; lhcp_dbi: number; axial_ratio_db: number }
export interface CircularPolarisation {
  /** partial directivities D |E_R|^2 / |E|^2 and D |E_L|^2 / |E|^2, [theta][phi], dBi (floor Dmax - 60) */
  rhcp_dbi: number[][];
  lhcp_dbi: number[][];
  /** axial ratio (|E_R| + |E_L|) / ||E_R| - |E_L||, [theta][phi], dB (0 = circular, capped at 60) */
  axial_ratio_db: number[][];
  /** at the directivity peak and at theta = 0 */
  peak: CPPoint;
  boresight: CPPoint;
}

export interface Band {
  f_lo: number;
  f_hi: number;
  f_center: number;
  s11_min_db: number;
  fractional_bw: number;
  edge_lo: boolean;
  edge_hi: boolean;
}

export interface PortResult {
  power_wave_reference?: { real: number; imag: number; convention: "Kurokawa"; gamma_re: number[]; gamma_im: number[]; power_transfer: number[] };
  s11_re: number[]; s11_im: number[]; zin_re: number[]; zin_im: number[];
  /** reference impedance; waveguide ports: the TE wave impedance at the band centre */
  z_ref: number;
  /** waveguide ports: the frequency-dependent reference impedance S11 is referred to */
  z_ref_f?: number[];
  /** waveguide ports: the factor the port's incident, reflected and accepted power were multiplied by
   *  (mode-matching probe calibration, docs/BUNDLE.md); absent when it was not applied */
  probe_power_factor?: number;
}

export interface Signals {
  time_ns: number[];
  u_inc: number[];
  u_ref: number[];
  u_tot: number[];
  i_tot_scaled: number[];
  dt_s: number | null;
  samples: number;
}

export interface PortRun {
  port: number;
  timesteps?: number;
  solver_time_s?: number;
  wall_time_s?: number;
  final_energy_db?: number;
  final_energy_bound_db?: number;
  converged: boolean;
  engine?: string;
}

export interface RunStats {
  /** multi-port runs: one entry per excited port (the other RunStats fields describe the first run) */
  port_runs?: PortRun[];
  /** wall time of all runs of a multi-port simulation, s */
  wall_time_total_s?: number;
  grid?: Vec3;
  timesteps?: number;
  solver_time_s?: number;
  wall_time_s?: number;
  speed_mcells_s?: number;
  /** FDTD timestep from the openEMS log (s); older bundles lack it */
  timestep_s?: number;
  /** length of the excitation pulse in timesteps: the run cannot converge before it has ended */
  excitation_timesteps?: number;
  final_energy_db?: number;
  /** present instead of final_energy_db for a converged run whose last energy line (if any) predates
   * the stop: the run stopped at the end criterion, so the energy is at most this (dB). Older bundles
   * may carry that stale sample as final_energy_db; use lib/run.finalEnergy to read either. */
  final_energy_bound_db?: number;
  energy_trace: { timestep: number; db: number }[];
  hit_timestep_limit: boolean;
  converged: boolean;
  threads: number;
  /** engine actually used (read back from the openEMS log); older bundles lack it */
  engine?: "cpu" | "gpu";
  engine_requested?: "cpu" | "gpu";
  engine_warning?: string;
  exact_endcriteria?: boolean;
  host: { os: string; machine: string; cpu: string | null };
  log_tail: string[];
}

export interface Bundle {
  /** "fairbeam.project/1"; a bundle with the older id is read as that (src/lib/legacy.ts) */
  schema: string;
  /** set on geometry-only bundles returned by the run server's live preview */
  preview?: boolean;
  generator: { name: string; version: string; openems: string | null; csxcad: string | null; python: string };
  created: string;
  name: string;
  model: { id: string; name: string; description: string; reference?: string; params: Param[] };
  units: { length: string; length_m: number; frequency: string };
  solver: {
    engine: string;
    method: string;
    excitation: { type: string; f_min: number; f_max: number; dc_free: boolean; expression?: string; f0?: number; fc?: number };
    boundaries: Record<"x-" | "x+" | "y-" | "y+" | "z-" | "z+", string>;
    end_criteria_db: number;
    max_timesteps: number;
  };
  parts: Part[];
  ports: Port[];
  /** lumped elements that are not ports (absent when there are none) */
  lumped_elements?: LumpedElement[];
  half_space: { axis: "z"; side: "min"; position: number; kind: string } | null;
  mesh: {
    x: number[]; y: number[]; z: number[]; cells: Vec3; total_cells: number; min_cell: number; max_cell: number;
    /** automatic mesh settings and report (Simulation.auto_mesh; docs/MESHING.md) */
    auto?: {
      settings: Record<string, number | string | boolean | null>;
      notes?: Record<string, string>;
      cells: Vec3;
      total_cells: number;
      min_cell: number;
      max_cell: number;
      max_neighbour_ratio: number;
      res_air: number;
      res_dielectric: number;
      timestep_s: number;
      timesteps_per_ns: number;
      memory_mb_estimate: number;
      warnings: string[];
      fine_features?: {
        kind: "strip" | "notch" | "gap" | "feed";
        width: number; lo: Vec3; hi: Vec3; normal: Vec3; axes: number[];
        shape_indices: number[]; edge_indices: number[];
        cells_across: number; required_cells: number; resolved: boolean;
      }[];
      fine_feature_refinement?: {
        baseline_cells: number; total_cells: number; added_cells: number; ratio: number;
        cell_limit: number; required_cells_lower_bound: number; skipped_cell_limit: boolean;
        enabled?: boolean; dropped_features?: number; retained_features?: number;
      };
    };
  };
  domain: { min: Vec3; max: Vec3 };
  /** faces: recorded faces x-, x+, y-, y+, z-, z+ when some are skipped (absent = all six) */
  nf2ff_box: { min: Vec3; max: Vec3; faces?: boolean[] } | null;
  nf2ff_center: Vec3 | null;
  focus: { min: Vec3; max: Vec3 } | null;
  run: RunStats | null;
  results: {
    frequency: number[];
    ports: Record<string, PortResult>;
    bands: Band[];
    farfield: FarField[];
    signals: Signals | Record<string, never>;
    /** N-port S-matrix (bundles written since multi-port support) */
    sparams?: SParams;
    /** complex embedded element patterns (multi-port antennas, fairbeam run --excite all) */
    element_patterns?: ElementPatternsSection;
    /** radiation efficiency over the band, one entry per driven port (fairbeam run --efficiency,
     * a design's monitors.efficiency); see docs/BUNDLE.md */
    efficiency?: EfficiencySweep[];
  } | null;
  /** optional surface-current maps (fairbeam run --fields); see docs/BUNDLE.md */
  fields?: FieldsSection;
  /** optional E/H field maps on cut planes, one entry per plane and frequency (a design's
   * monitors.field_planes, fairbeam run --field-plane); see docs/BUNDLE.md "field_planes" */
  field_planes?: FieldPlaneMap[];
}

export interface FieldPlaneMap {
  quantity: "E" | "H";
  /** "abs": |E| (|H|) of all three components; x/y/z: the magnitude of that component */
  component: "abs" | "x" | "y" | "z";
  normal: "x" | "y" | "z";
  /** plane normal axis and in-plane axes: u = (axis + 1) % 3, v = (axis + 2) % 3 */
  axis: 0 | 1 | 2;
  u_axis: 0 | 1 | 2;
  v_axis: 0 | 1 | 2;
  /** the mesh line the map was recorded on, and the position asked for (drawing units) */
  position_mm: number;
  requested_mm: number;
  /** frequency (Hz) */
  f: number;
  /** nu (nv) samples spread evenly over u_range (v_range), end points included */
  u_range: [number, number];
  v_range: [number, number];
  nu: number;
  nv: number;
  /** "V/m" or "A/m" (normalised to 1 W incident power at the driven port), else "arb." */
  unit: string;
  normalization: string;
  /** the largest value of the map */
  max: number;
  /** nv rows of nu phasor magnitudes (peak) */
  magnitude: number[][];
  /** the driven port of the run that recorded the map */
  port?: number;
  /** the complex components behind the map (phase, the field over one period); absent in older
   * bundles, which show the magnitude only */
  phasor?: FieldPlanePhasor;
}

/** Complex components of a field-plane map: signed int8 [v][u][component][re, im] against `peak`
 * (base64), referenced to the incident wave of the driven port; docs/BUNDLE.md "field_planes" */
export interface FieldPlanePhasor {
  /** "x", "y", "z" for a map of |E| (|H|), else the one stored component */
  components: ("x" | "y" | "z")[];
  /** the int8 full scale (127), in the map's unit */
  peak: number;
  data: string;
}

export interface FieldFrequency {
  /** frequency actually dumped (Hz) */
  f: number;
  /** far-field frequency this map belongs to (Hz) */
  f_target: number;
  /** nv x nu integers, row-major with v as the row: 0..1000 = |J_s| / max, -1 = no metal */
  values: number[];
  /** Optional signed-int8 interleaved [Ju.re, Ju.im, Jv.re, Jv.im] per pixel, /127 of common peak. */
  phasors?: string;
}

export interface FieldPlane {
  name: string;
  parts: string[];
  /** plane normal axis and its coordinate (drawing units) */
  axis: 0 | 1 | 2;
  position: number;
  /** in-plane axes: u = (axis + 1) % 3, v = (axis + 2) % 3 */
  u_axis: 0 | 1 | 2;
  v_axis: 0 | 1 | 2;
  /** sample positions: nu (nv) points spread evenly over u_range (v_range), end points included */
  u_range: [number, number];
  v_range: [number, number];
  nu: number;
  nv: number;
  frequencies: FieldFrequency[];
}

export interface FieldsSection {
  quantity: "surface_current";
  definition: string;
  units: string;
  /** Version 1 stores compact complex surface-current vectors in each frequency entry. */
  phase_version?: 1;
  /** number of the port driven in the one run that recorded the maps (a multi-port run records the
   * first excited port's run, the other ports terminated); absent in older bundles: unknown */
  port?: number;
  planes: FieldPlane[];
}

export interface ProjectIndexEntry {
  file: string;
  name: string;
  model: string;
  created: string;
  simulated: boolean;
  /** the |S11| minimum of each -10 dB band (GHz) */
  bands: number[];
  /** each -10 dB band's edges (GHz) and whether it runs into the edge of the simulated range
   * (src/lib/bands.ts); newer indexes only */
  band_ranges?: { lo: number; hi: number; edge_lo: boolean; edge_hi: boolean }[];
  cells: number;
  /** "CPU", "Metal", "CUDA" or "GPU"; newer indexes only (see src/lib/projectLabels.ts) */
  engine?: string;
  /** parameters set to something other than their default; newer indexes only */
  params?: Record<string, number | string | boolean>;
  /** the run quality verdict (src/lib/runQuality.ts), so the tree can badge a run without reading its
   * bundle; newer indexes only, and absent for a bundle without results */
  quality?: "converged" | "not-converged" | "suspicious";
}
