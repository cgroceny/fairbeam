// Human labels for undo steps ("Change length", "Move Patch") and the rule that merges typing into
// one step. Pure (no store, no DOM) so scripts/check-history-labels.mjs runs it directly.
import { t } from "../i18n/index.ts";
import type { Design } from "./types.ts";

/** Consecutive edits of the same field of the same object within this long are one step. */
export const MERGE_WINDOW_MS = 1500;

export interface MergeState { key: string; at: number; el: unknown }
const isTextInput = (el: unknown): boolean => {
  const e = el as { tagName?: string; isContentEditable?: boolean } | null;
  return !!e && (e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.isContentEditable === true);
};
/** Same field of the same object (the key carries its path) within the window, or while the same
 * text input keeps the focus. An edit with no key never merges. */
export function mergesWithPrevious(prev: MergeState, key: string, now: number, active: unknown): boolean {
  if (!key || key !== prev.key) return false;
  if (now - prev.at < MERGE_WINDOW_MS) return true;
  return isTextInput(active) && active === prev.el;
}

const FIELDS = ["start", "stop", "center", "radius", "height", "length", "width", "thickness", "axis", "material", "color", "name", "label", "component", "priority", "points", "eps_r", "tan_d", "conductivity", "kind", "direction", "number", "mode", "excite", "offset", "angle", "copies", "step", "factors", "origin", "plane", "f_min", "f_max", "boundaries", "pad", "key", "default", "unit", "min", "max", "resistance", "cut"] as const;
const ALIAS: Record<string, string> = { fmin: "f_min", fmax: "f_max", R: "resistance", r: "radius" };

/** The last field of a path, in words: "parts[0].primitives[1].length" -> "length". */
export function fieldOf(key: string): string {
  const last = key.replace(/\[\d+\]/g, "").split(/[.[\]]/).filter(Boolean).at(-1) ?? "";
  return ALIAS[last] ?? last;
}
export function fieldText(field: string): string {
  if ((FIELDS as readonly string[]).includes(field)) return t(`history.field.${field}`);
  return field.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() || t("history.field.value");
}

const partName = (p: { name?: string; label?: string } | undefined) => p?.label || p?.name || t("history.part");
const nameOf = (o: { name?: string; label?: string; key?: string } | undefined, fallback: string) => o?.label || o?.name || o?.key || fallback;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function labelForKey(key: string, after: Design): string | null {
  if (!key) return null;
  const m = /^(parts|materials|ports|resistors|params)\[(\d+)\]/.exec(key);
  const field = fieldOf(key);
  if (!m) return key === "model.name" ? t("history.renameDesign") : t("history.change", { field: fieldText(field) });
  const i = Number(m[2]), kind = m[1];
  if (kind === "parts") {
    const part = after.parts?.[i];
    const name = partName(part);
    const tr = /\.transforms\[(\d+)\]/.exec(key);
    if (tr) return part?.transforms?.[Number(tr[1])]?.type === "move" ? t("history.move", { name }) : t("history.transform", { name });
    if (/\.cuts\[/.test(key)) return t("history.change", { field: fieldText("cut") });
    if (field === "color") return t("history.setColor", { name });
    if (field === "material" || field === "component") return t("history.setField", { field: fieldText(field), name });
  }
  if (kind === "materials" && field === "color") return t("history.setColor", { name: nameOf(after.materials?.[i], t("history.material")) });
  return t("history.change", { field: fieldText(field) });
}

/** The label of an edit, from the design before and after it and the edit's key; an explicit label
 * given to edit() wins over this. */
export function inferLabel(before: Design, after: Design, key: string): string {
  const byKey = labelForKey(key, after);
  if (byKey) return byKey;
  const count = (k: "parts" | "ports" | "materials" | "params" | "resistors") => [before[k]?.length ?? 0, after[k]?.length ?? 0] as const;
  const [p0, p1] = count("parts");
  if (p1 > p0) return t("history.add", { name: partName(after.parts[p1 - 1]) });
  if (p1 < p0) {
    const gone = before.parts.find((p) => !after.parts.some((q) => q.name === p.name)) ?? before.parts[p0 - 1];
    return t("history.delete", { name: partName(gone) });
  }
  const [q0, q1] = count("ports");
  if (q1 > q0) return t(after.ports[q1 - 1]?.type === "waveguide" ? "history.addWaveguidePort" : "history.addDiscretePort");
  if (q1 < q0) return t("history.deletePort");
  const [r0, r1] = count("resistors");
  if (r1 > r0) return t("history.addResistor");
  if (r1 < r0) return t("history.deleteResistor");
  const [m0, m1] = count("materials");
  if (m1 > m0) return t("history.addMaterial", { name: nameOf(after.materials[m1 - 1], t("history.material")) });
  if (m1 < m0) return t("history.deleteMaterial");
  const [a0, a1] = count("params");
  if (a1 > a0) return t("history.addParam");
  if (a1 < a0) return t("history.deleteParam");
  for (let i = 0; i < p1; i++) {
    const a = before.parts[i], b = after.parts[i];
    if (same(a, b)) continue;
    const name = partName(b);
    if ((b.cuts?.length ?? 0) > (a.cuts?.length ?? 0)) return t("history.subtract", { cut: t("history.cutName"), name });
    if ((b.cuts?.length ?? 0) < (a.cuts?.length ?? 0)) return t("history.removeCut", { name });
    if (b.primitives.length > a.primitives.length) return t("history.addTo", { what: b.primitives.at(-1)?.kind ?? "", name });
    if (b.primitives.length < a.primitives.length) return t("history.removeFrom", { name });
    if (!same(a.transforms, b.transforms)) return b.transforms?.at(-1)?.type === "move" ? t("history.move", { name }) : t("history.transform", { name });
    if (a.color !== b.color) return t("history.setColor", { name });
    if (a.material !== b.material) return t("history.setField", { field: fieldText("material"), name });
    if (a.component !== b.component) return t("history.setField", { field: fieldText("component"), name });
    if (!same(a.primitives, b.primitives)) return t("history.moveVertex", { name });
    return t("history.edit", { name });
  }
  if (!same(before.ports, after.ports)) return t("history.editPort");
  return t("history.editDesign");
}
