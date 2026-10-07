import type { Design } from "./types.ts";

/** Explicit starting points, not accuracy guarantees. Applying is a single undoable edit. The end
 * criteria are the ones the solver field's hint and the end-criterion check name ("−40 quick, −60
 * accurate"): docs/RESULTS.md (End criterion) finds the resonance frequency and Dmax settled at
 * −40 dB, while the S11 depth and the efficiency need −60 dB. */
export const RUN_PROFILES = {
  quick: { cpw: 10, dielectricCells: 2, endDb: -40 },
  balanced: { cpw: 20, dielectricCells: 3, endDb: -40 },
  verification: { cpw: 30, dielectricCells: 4, endDb: -60 },
} as const;
export type RunProfile = keyof typeof RUN_PROFILES;

export const runProfileSupported = (design: Design) => design.mesh.mode !== "manual" && !design.mesh.lines;

export function applyRunProfile(design: Design, profile: RunProfile): boolean {
  if (!runProfileSupported(design)) return false;
  const p = RUN_PROFILES[profile];
  if (design.mesh.mode === "design") {
    design.mesh.overrides = { ...design.mesh.overrides, cells_per_wavelength: p.cpw,
      air_cells_per_wavelength: p.cpw, dielectric_cells: p.dielectricCells };
  } else {
    design.mesh.cells_per_wavelength = p.cpw;
    design.mesh.air_cells_per_wavelength = p.cpw;
  }
  design.simulation.end_criteria_db = p.endDb;
  return true;
}
