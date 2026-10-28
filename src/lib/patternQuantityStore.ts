// The far-field quantity shown by the 3D pattern, the pattern cuts and the far-field card (Directivity,
// Gain, Realized gain, circular/Ludwig-3 parts and ratios), and the Efficiency view's unit: one choice for the whole app,
// remembered for the browser session (sessionStorage; the choice still works when storage is blocked).
import { createSignal } from "solid-js";
import { normalizeLudwigReference } from "./ludwig.ts";
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

/** Fixed Ludwig-3 reference in the global xy plane, +x toward +y; not fitted to an antenna's beam. */
export const LUDWIG_REFERENCE_KEY = "fairbeam:ludwig-reference-deg";
function readReference(): number {
  try {
    const raw = sessionStorage.getItem(LUDWIG_REFERENCE_KEY);
    if (raw !== null && raw.trim() !== "" && Number.isFinite(Number(raw))) return normalizeLudwigReference(Number(raw));
  } catch { /* storage unavailable */ }
  return 0;
}
const [reference, changeReference] = createSignal(readReference());
export const ludwigReferenceDeg = reference;
export function setLudwigReferenceDeg(value: number) {
  if (!Number.isFinite(value)) return;
  const next = normalizeLudwigReference(value);
  changeReference(next); write(LUDWIG_REFERENCE_KEY, String(next));
}
