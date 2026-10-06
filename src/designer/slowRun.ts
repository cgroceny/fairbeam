// A run that is far slower than the estimate (the machine is busy: other runs, other programs, the 3D
// view). The solver's measured speed (MCells/s, from its log) is compared with the speed the pre-run
// estimate assumed (meshStats.ts estimateTime): when it stays below SLOW_FRACTION of it for more than
// SLOW_SECONDS, the live run panel shows a hint. A zero reading counts as slow too ("0 MC/s" for
// minutes), a missing one does not. Pure (no Solid, no DOM), so scripts/check-slow-run.mjs tests it.

/** below this fraction of the expected speed the run counts as slow */
export const SLOW_FRACTION = 0.1;
/** how long it must stay slow before the hint shows (s) */
export const SLOW_SECONDS = 60;

/** The moment (s) the speed fell below the slow limit and has stayed there, or null while it is not
 * slow (the clock restarts whenever a reading is back above the limit). `since` is the previous
 * result. A missing reading or expectation leaves it as it was: nothing is known then. */
export function watchSpeed(
  since: number | null,
  nowS: number,
  measured: number | null | undefined,
  expected: number | null | undefined,
): number | null {
  if (typeof measured !== "number" || !Number.isFinite(measured) || measured < 0) return since;
  if (typeof expected !== "number" || !Number.isFinite(expected) || expected <= 0) return since;
  if (measured >= SLOW_FRACTION * expected) return null;
  return since ?? nowS;
}

/** Whether the hint shows: the speed has been low for more than SLOW_SECONDS. */
export function slowHint(since: number | null, nowS: number): boolean {
  return since !== null && nowS - since > SLOW_SECONDS;
}
