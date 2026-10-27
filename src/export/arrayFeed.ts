import type { Bundle } from "../types.ts";
import { elementPatterns } from "../lib/sparams.ts";

/** An explicit session frequency exports only that stored set. Older programmatic callers
 * without a frequency retain their fixed-weight, all-frequency report contract. */
export function arrayExportSets(b: Bundle, frequencyHz?: number) {
  const sets = elementPatterns(b);
  return frequencyHz === undefined ? sets : sets.filter(set => set.f === frequencyHz);
}

export const arrayExportScope = (frequencyHz?: number) => frequencyHz === undefined
  ? "The same fixed amplitude and phase weights are applied at every stored element-pattern frequency; no frequency-specific re-steering is performed."
  : `Feed snapshot at ${frequencyHz} Hz. Synthesized array figures and active reflection use this selected stored frequency only; other stored patterns remain unmodified.`;
