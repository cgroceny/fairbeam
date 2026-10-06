import type { Design } from "./types.ts";

/** Explicit starting points, not accuracy guarantees. Applying is a single undoable edit. */
export const RUN_PROFILES = {
  quick: { cpw: 10, dielectricCells: 2, endDb: -30 },
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
