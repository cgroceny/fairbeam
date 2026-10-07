// Design files (python/fairbeam/design.py, schema "fairbeam.design/1"): a model as data, edited in
// the designer. Lengths in mm, frequencies in GHz; every value is a number or an expression over
// the parameters ("W/2", "wavelength(f0) / 4").

export type Expr = number | string;
export type Vec3 = [Expr, Expr, Expr];
export type Axis = "x" | "y" | "z";
export type BooleanOperation = "add" | "subtract" | "intersect" | "insert";

export interface DesignParam {
  key: string;
  /** independent parameter (tunable, swept, optimized) */
  default?: number;
  /** derived parameter: computed from the ones above it */
  expr?: string;
  label?: string;
  unit?: string;
  description?: string;
  min?: number | null;
  max?: number | null;
}

export interface DesignMaterial {
  name: string;
  kind: "metal" | "dielectric";
  eps_r?: Expr;
  /** Isotropic loss-free relative permeability, default 1. */
  mu_r?: Expr;
  tan_d?: Expr;
  /** GHz */
  tan_d_freq?: Expr;
  /** metal only: S/m; empty = a perfect conductor (PEC) */
  conductivity?: Expr;
  /** metal with a conductivity: mm, the thickness of its sheets drawn with zero thickness (0.035 if empty) */
  thickness?: Expr;
  color?: string;
  /** the material library entry the values were copied from (src/designer/materials.ts); informational */
  library?: string;
}

/** A brick: start = (Xmin, Ymin, Zmin), stop = (Xmax, Ymax, Zmax). Zero size on one axis: a sheet. */
export interface BoxPrimitive { kind: "box"; start: Vec3; stop: Vec3; priority?: number }
/** Cylinder: center = the two in-plane coordinates in CSXCAD order (axis z: x, y; x: y, z;
 * y: z, x), range = [min, max] along the axis, inner_radius > 0 makes a tube. */
export interface AxisCylinder { kind: "cylinder"; axis: Axis; center: [Expr, Expr]; radius: Expr; inner_radius?: Expr; range: [Expr, Expr]; priority?: number }
/** The older cylinder form: axis end points. */
export interface PointsCylinder { kind: "cylinder"; start: Vec3; stop: Vec3; radius: Expr; inner_radius?: Expr; priority?: number }
export interface SpherePrimitive { kind: "sphere"; center: Vec3; radius: Expr; priority?: number }
export interface PolygonPrimitive { kind: "polygon"; normal: Axis; elevation: Expr; points: [Expr, Expr][]; priority?: number }
export interface LinPolyPrimitive { kind: "linpoly"; normal: Axis; elevation: Expr; length: Expr; points: [Expr, Expr][]; priority?: number }
/** Cone or frustum (CSXCAD rotational polygon): like an axis cylinder, bottom_radius at range[0],
 * top_radius at range[1] (0: a sharp tip). */
export interface ConePrimitive { kind: "cone"; axis: Axis; center: [Expr, Expr]; bottom_radius: Expr; top_radius: Expr; range: [Expr, Expr]; priority?: number }
/** Torus about `axis` through `center`: major_radius to the tube centre, minor_radius of the tube
 * (CSXCAD rotational polygon of a regular 64-gon). */
export interface TorusPrimitive { kind: "torus"; axis: Axis; center: Vec3; major_radius: Expr; minor_radius: Expr; priority?: number }
/** Thin wire (CSXCAD Wire): a polyline of x, y, z points and a radius, rasterised as a volume. */
export interface WirePrimitive { kind: "wire"; points: Vec3[]; radius: Expr; priority?: number }
/** Closed solid (CSXCAD Polyhedron): `vertices` (x, y, z) and polygon `faces` (lists of vertex indices,
 * at least 4 vertices and 4 faces). The build fans each face into triangles, as CSXCAD needs. */
export interface PolyhedronPrimitive { kind: "polyhedron"; vertices: Vec3[]; faces: number[][]; priority?: number }
export type DesignPrimitive = (BoxPrimitive | AxisCylinder | PointsCylinder | SpherePrimitive | PolygonPrimitive | LinPolyPrimitive | ConePrimitive | TorusPrimitive | WirePrimitive | PolyhedronPrimitive) & { label?: string; void?: boolean };

/** A transform with copies, applied in order to all shapes of a part and expanded exactly. */
export type DesignTransform =
  /** shift the existing geometry, without adding copies */
  | { type: "move"; offset: Vec3 }
  /** right-handed rotation by angle degrees about an axis through center; positive copies retain the original */
  | { type: "rotate"; axis: Axis; center: Vec3; angle: Expr; copies?: Expr }
  /** `copies` more copies, the k-th shifted by k × step (the original stays) */
  | { type: "translate"; copies: Expr; step: Vec3 }
  /** positive uniform scale about origin; zero copies scales in place, positive copies retain the original */
  | { type: "scale"; factors: Vec3; origin: Vec3; copies?: Expr }
  /** reflect across the plane `plane` = point[plane] (default 0), keeping the original unless keep is false */
  | { type: "mirror"; plane: Axis; point?: Vec3; keep?: boolean };

export interface DesignPart {
  name: string;
  label?: string;
  /** Component folder path, e.g. "antenna/feed" (the tree groups by it; build and export ignore it) */
  component?: string;
  material: string;
  color?: string;
  primitives: DesignPrimitive[];
  transforms?: DesignTransform[];
  /** rectangles (like a sheet brick: min = max on one axis), round holes and polygons cut out of the
   * part's flat sheets (rectangular sheets, polygons, flat circles) in their plane, before the
   * transforms: slots, U-slots, E-shapes, inset notches, clearance holes */
  cuts?: DesignCut[];
  /** The operands this part was made from (whole parts, nested Boolean histories included). A live
   * result's primitives are recomputed from them whenever parameter values change (the stored
   * primitives are the result at the design's own values). */
  booleanHistory?: { operation: BooleanOperation; A: DesignPart; B: DesignPart; live?: boolean };
}

/** A rectangle cut: start = (Xmin, Ymin, Zmin), stop = (Xmax, Ymax, Zmax), zero size on exactly one axis. */
export interface RectCut { kind?: "rect"; start: Vec3; stop: Vec3 }
/** A round hole: a circle in the plane normal to `normal` (default z) at `elevation`, `center` the two
 * in-plane coordinates in CSXCAD order (like a cylinder's), built as a regular polygon (design.disc_ring). */
export interface CircleCut { kind: "circle"; normal?: Axis; elevation?: Expr; center: [Expr, Expr]; radius: Expr }
/** A polygon hole: `points` are in-plane coordinates in CSXCAD order, in the plane `normal` = `elevation`. */
export interface PolygonCut { kind: "polygon"; normal?: Axis; elevation?: Expr; points: [Expr, Expr][] }
export type DesignCut = RectCut | CircleCut | PolygonCut;

/** A lumped port (R, a probe or strip from start to stop along direction) or a rectangular
 * waveguide port (one TE mode, broad wall a along (direction+1)%3, b along (direction+2)%3; start /
 * stop span the cross-section, the excitation at start, the mode probes at stop). */
export interface DesignPort {
  type: "lumped" | "waveguide";
  number: number;
  /** lumped only */
  R?: Expr;
  /** Postprocessing power-wave reference only; the native source/load R stays real. */
  reference_impedance?: { real: Expr; imag: Expr };
  /** waveguide only: "TE10" (default), "TE20", "TE11", … */
  mode?: string;
  a?: Expr;
  b?: Expr;
  start: Vec3;
  stop: Vec3;
  direction: Axis;
  excite?: boolean;
  /** Additional feeds; first feed is this port's start/stop/direction with positive polarity. */
  group?: {
    connection: "parallel" | "series";
    members: { start: Vec3; stop: Vec3; direction: Axis; polarity?: 1 | -1 }[];
    priority?: number;
  };
}

export interface DesignResistor {
  name?: string;
  label?: string;
  R?: Expr;
  /** Ideal native lumped values in henries and farads. */
  L?: Expr;
  C?: Expr;
  topology?: "series" | "parallel";
  start: Vec3;
  stop: Vec3;
  direction: Axis;
}

/** One E/H field map on a cut plane (monitors.field_planes; python/fairbeam/field_planes.py). */
export interface DesignFieldPlane {
  quantity: "E" | "H";
  /** "abs" (default): |E| or |H| of all three components; x/y/z: the magnitude of one component */
  component?: "abs" | Axis;
  normal: Axis;
  /** mm along the normal */
  position: Expr;
  /** GHz, 1 to 4 inside the band */
  frequencies: Expr[];
}

export interface Design {
  /** Explicit component folders, including empty folders; geometry remains on parts. */
  components?: string[];
  schema: "fairbeam.design/1";
  model: { id: string; name: string; description?: string; reference?: string; conversion?: DesignConversion };
  /** Saved Python model whose code created this Design; the source panel can keep using that script. */
  python_source_model?: string;
  /** SHA-256 of that source when it was converted, so later source edits can be identified. */
  python_source_hash?: string;
  params: DesignParam[];
  simulation: { f_min: Expr; f_max: Expr; boundaries: string | string[]; end_criteria_db?: number; max_timesteps?: number };
  materials: DesignMaterial[];
  parts: DesignPart[];
  ports: DesignPort[];
  resistors: DesignResistor[];
  mesh: {
    /** Missing in saved designs means off; new designs explicitly enable refinement. */
    refine_features?: boolean;
    /** Missing/auto keeps the legacy editor and server auto-mesh behavior. */
    mode?: "auto" | "design" | "manual";
    lines?: Record<Axis, Expr[]>;
    automatic?: { mode?: "auto" | "design"; refine_features?: boolean; overrides?: Partial<Record<"cells_per_wavelength" | "edge_rule" | "air_cells_per_wavelength" | "max_ratio" | "pad" | "dielectric_cells", Expr | null | "thirds" | "edge">> };
    overrides?: Partial<Record<"cells_per_wavelength" | "edge_rule" | "air_cells_per_wavelength" | "max_ratio" | "pad" | "dielectric_cells", Expr | null | "thirds" | "edge">>;
    cells_per_wavelength?: Expr; pad?: Expr | null;
    edge_rule?: "thirds" | "edge"; max_ratio?: Expr; air_cells_per_wavelength?: Expr | null;
    /** "sheet" (default): metal bricks much thinner than the mesh are built as zero-thickness sheets */
    thin_metal?: "sheet" | "volume";
  };
  far_field: { enabled: boolean; frequencies?: Expr[]; phase_center?: [Expr, Expr, Expr]; /** which NF2FF box faces record (x-, x+, y-, y+, z-, z+); omitted: all */ faces?: boolean[] };
  parameter_sweep?: ParameterSweepDefinition;
  /** The work coordinate system (WCS) the drawing tools use; absent: the global one. w points
   * along `normal` (negative with `flip`), `origin` is in global coordinates, `angle` turns u and v
   * about `normal`. Geometry never depends on it: shapes drawn in a local WCS store their own transforms. */
  wcs?: DesignWcs;
}

/** How a design was made from a bundled example (python/fairbeam/example_design.py): the example
 * and the conversion notes. A note's `code` names its text (exampleCopy.note.<code>, filled in with
 * `values`); `text` is the English sentence, for a code this version does not know. */
export interface DesignConversion { source?: string; notes: { code: string; text: string; values?: Record<string, string | number> }[] }

export interface DesignWcs { normal: Axis; origin: [Expr, Expr, Expr]; angle: 0 | 90 | 180 | 270; flip?: boolean }

export interface ParameterSweepAxis {
  key: string;
  kind: "range";
  start: string;
  stop: string;
  steps: string;
}
export interface ParameterSweepListAxis { key: string; kind: "list"; list: string }
export interface ParameterSweepSequence { name: string; axes: (ParameterSweepAxis | ParameterSweepListAxis)[] }
export interface ParameterSweepDefinition { schema: "fairbeam.parameter-sweep/1"; sequences: ParameterSweepSequence[] }

/** What the inspector shows: a JSON path into the design. */
export type Selection =
  | { type: "design" }
  | { type: "param"; i: number }
  | { type: "material"; i: number }
  | { type: "part"; i: number }
  | { type: "primitive"; i: number; j: number }
  | { type: "port"; i: number }
  | { type: "resistor"; i: number }
  | { type: "simulation" }
  | { type: "optimization"; id: string };
