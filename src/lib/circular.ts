// Circular-polarization display contract. Stored IEEE components come from the
// complex Etheta/Ephi backend; a scalar directivity grid cannot reconstruct them.
import type { FarField } from "../types";

export const AXIAL_RATIO_MAX_DB = 60; // backend saturation, not a measured 60 dB value
export const AXIAL_RATIO_MASK_DB = 20; // show only D >= stored Dmax - 20 dB
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Missing, invalid and low-directivity samples stay gaps, never zero (ideal CP).
 * Mask before cuts/interpolation so downstream plots cannot bridge an excluded region. */
export function axialRatioGrid(ff: FarField): number[][] {
  return ff.theta.map((_, i) => ff.phi.map((_, j) => {
    const ar = ff.cp?.axial_ratio_db?.[i]?.[j], d = ff.directivity_dbi?.[i]?.[j];
    return finite(ar) && ar >= 0 && ar <= AXIAL_RATIO_MAX_DB && finite(d) && finite(ff.dmax_dbi)
      && d >= ff.dmax_dbi - AXIAL_RATIO_MASK_DB ? ar : NaN;
  }));
}

export function axialRatioReadouts(ff: FarField): { peak: number | null; boresight: number | null } {
  const grid = axialRatioGrid(ff);
  let peakI = -1, peakJ = -1, peakD = -Infinity;
  for (let i = 0; i < ff.theta.length; i++) for (let j = 0; j < ff.phi.length; j++) {
    const d = ff.directivity_dbi?.[i]?.[j];
    if (finite(d) && d > peakD) { peakD = d; peakI = i; peakJ = j; }
  }
  const value = (i: number, j: number) => finite(grid[i]?.[j]) ? grid[i][j] : null;
  // At theta=0 all phi entries name +z. Do not call the first row boresight
  // when a saved angular grid starts elsewhere.
  const zero = ff.theta.findIndex(theta => finite(theta) && Math.abs(theta) < 1e-9);
  return { peak: value(peakI, peakJ), boresight: value(zero, 0) };
}
