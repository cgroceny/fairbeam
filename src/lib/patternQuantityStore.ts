// The far-field quantity shown by the 3D pattern, the pattern cuts and the far-field card (Directivity,
// Gain, Realized gain, RHCP/LHCP), and the Efficiency view's unit: one choice for the whole app,
// remembered for the browser session (sessionStorage; the choice still works when storage is blocked).
import { createSignal } from "solid-js";
import { isPatternQuantity, type PatternQuantity } from "./farfieldQuantity.ts";
import { isRadiationQuantity, type RadiationQuantity } from "./radiationFrequency.ts";

export const PATTERN_QUANTITY_KEY = "fairbeam:pattern-quantity";
export const EFFICIENCY_UNIT_KEY = "fairbeam:efficiency-unit";
export type EfficiencyUnit = "pct" | "db";

function read<T>(key: string, ok: (v: unknown) => v is T, fallback: T): T {
  try {
    const v = sessionStorage.getItem(key);
    if (ok(v)) return v;
  } catch { /* storage blocked: the default for this page */ }
  return fallback;
}
function write(key: string, value: string) {
  try { sessionStorage.setItem(key, value); } catch { /* kept in memory for this page */ }
}

const [quantity, setQuantity] = createSignal<PatternQuantity>(read(PATTERN_QUANTITY_KEY, isPatternQuantity, "directivity"));
/** The chosen quantity (an entry without it draws directivity: farfieldQuantity.effectiveQuantity). */
export const patternQuantity = quantity;
export function setPatternQuantity(q: PatternQuantity) {
  if (!isPatternQuantity(q)) return;
  setQuantity(q);
  write(PATTERN_QUANTITY_KEY, q);
}

const isUnit = (v: unknown): v is EfficiencyUnit => v === "pct" || v === "db";
const [unit, setUnit] = createSignal<EfficiencyUnit>(read(EFFICIENCY_UNIT_KEY, isUnit, "pct"));
export const efficiencyUnit = unit;
export function setEfficiencyUnit(u: EfficiencyUnit) {
  if (!isUnit(u)) return;
  setUnit(u);
  write(EFFICIENCY_UNIT_KEY, u);
}

export type EfficiencyQuantity = "efficiency" | RadiationQuantity;
const efficiencyKey = "fairbeam:efficiency-quantity";
const isEfficiencyQuantity = (v: unknown): v is EfficiencyQuantity => v === "efficiency" || isRadiationQuantity(v);
const [effQuantity, changeEffQuantity] = createSignal<EfficiencyQuantity>(read(efficiencyKey, isEfficiencyQuantity, "efficiency"));
export const efficiencyQuantity = effQuantity;
export const radiationQuantity = (): RadiationQuantity => isRadiationQuantity(effQuantity()) ? effQuantity() as RadiationQuantity : "realized_peak_dbi";
export function setEfficiencyQuantity(q: EfficiencyQuantity) {
  if (!isEfficiencyQuantity(q)) return;
  changeEffQuantity(q); write(efficiencyKey, q);
}
