// How hard the 3D view draws. While a local CPU run is active the machine's cores belong to the solver
// (the run's speed falls when something else competes: a high-resolution canvas redrawn on every
// camera move or label update), so the canvas is drawn at one pixel per CSS pixel instead of up to
// two. The picture stays the same size and sharpness returns when the run ends. Pure (no DOM), so
// scripts/check-slow-run.mjs tests it.
export const MAX_PIXEL_RATIO = 2;
export const BUSY_PIXEL_RATIO = 1;

/** The renderer's pixel ratio for a display ratio, with a local run busy or not. */
export function renderPixelRatio(devicePixelRatio: number, busy: boolean): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, busy ? BUSY_PIXEL_RATIO : MAX_PIXEL_RATIO);
}
