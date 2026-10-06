import { createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import type { BooleanOperation, Design, DesignPart, Selection } from "./types";
export type { BooleanOperation } from "./types";
import { draft, edit, names, selection, setSelection, registerPostEditObserver, registerDocumentChangeObserver, registerDeriveHook, revertObservedEdit, setMessage } from "./store";
import { appliedText, BOOLEAN_SYMBOLS, booleanOverlap, booleanPreview, booleanResult, materialiseBoolean, removedMeasure } from "./booleanParts";
import { quickBundle } from "./geometry";
import { flashRemoved, setBooleanPreviewGeometry } from "./booleanPreview";
import { hoverPart } from "../state";
import type { Primitive } from "../types";
import { localeTag, t } from "../i18n";

/** A Boolean being set up: A (kept), the operation and, once chosen, B. */
type Pending = { a: number; operation: BooleanOperation; b?: number };
export const [booleanPending, setBooleanPending] = createSignal<Pending | null>(null);
export const [booleanNotice, setBooleanNotice] = createSignal("");
export type AutomaticOverlap = { a: number; b: number; before: Design; after: Design };
export const [automaticOverlap, setAutomaticOverlap] = createSignal<AutomaticOverlap | null>(null);
export type OverlapChoice = "add" | "subtractAB" | "subtractBA" | "intersect" | "insert" | "keep" | "cancel";
/** The overlap prompt's choice under the pointer or focus: the 3D view previews it. */
export const [overlapChoice, setOverlapChoice] = createSignal<OverlapChoice | null>(null);
/** The operations' names in the current language (getters: read at render, never frozen at import). */
export const BOOLEAN_LABELS: Readonly<Record<BooleanOperation, string>> = {
  get add() { return t("boolean.op.add"); },
  get subtract() { return t("boolean.op.subtract"); },
  get intersect() { return t("boolean.op.intersect"); },
  get insert() { return t("boolean.op.insert"); },
};
export { BOOLEAN_SYMBOLS };
export const booleanHistory = () => draft.parts.flatMap((p, index) => p.booleanHistory ? [{ index, a: p.booleanHistory.A.name, b: p.booleanHistory.B.name, operation: p.booleanHistory.operation, result: p.name }] : []);
export const partTitle = (i: number) => draft.parts[i]?.label || draft.parts[i]?.name || "?";

/** The part of a part or shape selection (a drawn or added shape selects the shape), else -1. */
export const selectedPartIndex = (s: Selection = selection()) => (s.type === "part" || s.type === "primitive") && draft.parts[s.i] ? s.i : -1;

/** Restore the saved operands as editable parts in one undoable design edit. */
export function restoreBooleanPart(index: number) {
  const history = draft.parts[index]?.booleanHistory;
  if (!history) return;
  const used = new Set(draft.parts.filter((_, i) => i !== index).map(p => p.name));
  const name = (base: string) => {
    let candidate = base, n = 2;
    while (used.has(candidate)) candidate = `${base} ${n++}`;
    used.add(candidate);
    return candidate;
  };
  const a = JSON.parse(JSON.stringify(history.A)) as typeof history.A;
  const b = JSON.parse(JSON.stringify(history.B)) as typeof history.B;
  const retainedB = history.operation === "insert" && draft.parts.some((p, i) => i !== index && p.name === b.name);
  a.name = name(a.name);
  if (!retainedB) b.name = name(b.name);
  edit(d => { d.parts.splice(index, 1, ...retainedB ? [a] : [a, b]); });
  setBooleanPending(null);
  setSelection({ type: "part", i: index });
}

/** Start a Boolean with A = the chosen part, or the selected part (or the part of the selected shape). */
export function armBoolean(operation: BooleanOperation, chosen?: number) {
  if (draft.parts.length < 2) { setBooleanNotice(t("boolean.needTwo")); return; }
  const a = chosen ?? selectedPartIndex();
  if (a < 0 || !draft.parts[a]) { setBooleanNotice(t("boolean.selectA")); return; }
  const p = booleanPending();
  setBooleanNotice("");
  // the same A with B already chosen: only the operation changes
  if (p && p.a === a && p.b !== undefined) setBooleanPending({ ...p, operation });
  else setBooleanPending({ a, operation });
}

/** Change the operation of the Boolean being set up. */
export function setBooleanOperation(operation: BooleanOperation) {
  const p = booleanPending();
  if (p && p.a >= 0) { setBooleanPending({ ...p, operation }); setBooleanNotice(""); }
}

/** Exchange A and B of the Boolean being set up. */
export function swapBooleanOperands() {
  const p = booleanPending();
  if (p && p.a >= 0 && p.b !== undefined) { setBooleanPending({ ...p, a: p.b, b: p.a }); setBooleanNotice(""); }
}

// The Boolean's own edit: its result may touch other parts, but it was made on purpose, so the
// overlap prompt stays away.
let applyingBoolean = false;
function booleanEdit(parts: DesignPart[], label: string) {
  applyingBoolean = true;
  try { edit(d => { d.parts = parts; }, "", label); } finally { applyingBoolean = false; }
}

/** Apply a computed Boolean as one undo step and say what happened; false (the reason in the notice) when it cannot be built. */
function commitBoolean(a: number, b: number, operation: BooleanOperation): boolean {
  const result = booleanResult(draft as Design, names().names, a, b, operation);
  if (result.error !== undefined) { setBooleanNotice(result.error); return false; }
  const A = JSON.parse(JSON.stringify(draft.parts[a])) as DesignPart, B = JSON.parse(JSON.stringify(draft.parts[b])) as DesignPart;
  // a Subtract says which solid lost which volume (or that B touched nothing of A), and flashes the removed region
  let removed: ReturnType<typeof removedMeasure> | undefined, flash: Primitive[] = [];
  if (operation === "subtract") {
    const values = names().names;
    removed = removedMeasure(A, B, values);
    const common = removed === "none" ? [] : booleanPreview(A, B, "subtract", values).intersection;
    // no common volume to show (a sheet cut by a volume): the cutter itself flashes
    flash = removed === "none" ? [] : shapes(common.length ? { name: "__boolean_removed", material: A.material, primitives: common } : B);
  }
  booleanEdit(result.parts!, `Boolean ${operation}: ${A.name} ${BOOLEAN_SYMBOLS[operation]} ${B.name}`);
  setBooleanPending(null); setBooleanNotice(""); setSelection({ type: "design" });
  setMessage({ tone: removed === "none" ? "warn" : "good", text: appliedText(operation, A, B, result.parts!.find((p) => p.name === A.name && p.booleanHistory), removed) });
  flashRemoved(flash);
  return true;
}

/** A op B in one go, from a menu that lists the solids ("Subtract ▸ B"): no pending step, one
 * undo step, and a note saying what happened. False (with the reason in the Boolean notice) when
 * it cannot be built. */
export function runBoolean(operation: BooleanOperation, a: number, b: number): boolean {
  if (!draft.parts[a] || !draft.parts[b] || a === b) { setBooleanNotice(t("boolean.differentB")); return false; }
  return commitBoolean(a, b, operation);
}

/** The solids a Boolean with A can take as B, with their names (the menus list these). */
export const booleanTargets = (a: number): { i: number; title: string }[] =>
  draft.parts.flatMap((_, i) => (i === a ? [] : [{ i, title: partTitle(i) }]));

/** Apply the Boolean being set up (its operation, or this one). */
export function applyPendingBoolean(operation?: BooleanOperation) {
  const p = booleanPending();
  if (!p || p.a < 0 || p.b === undefined) return;
  commitBoolean(p.a, p.b, operation ?? p.operation);
}

/** B chosen (a part picked in the tree or the 3D view, or one of its shapes): preview, then Apply. */
export function acceptBooleanPick(index: number) {
  const p = booleanPending(); if (!p || p.a < 0) return;
  if (index === p.a) { if (p.b === undefined) setBooleanNotice(t("boolean.differentB")); return; }
  setBooleanNotice("");
  setBooleanPending({ ...p, b: index });
}

// A part added, removed or renamed (undo, delete, another Boolean) moves the indices A and B point
// at: the Boolean being set up is dropped rather than combining other parts.
createRoot(() => createEffect(on(() => draft.parts?.map((p) => p.name).join("\n"), () => {
  if (booleanPending()) { setBooleanPending(null); setBooleanNotice(""); }
}, { defer: true })));

// The last two parts selected one after the other (by name): "A then B" for the Boolean keys.
let recentParts: string[] = [];
createRoot(() => createEffect(on(selection, (s) => {
  const i = selectedPartIndex(s);
  if (i < 0) { recentParts = []; return; }
  const name = draft.parts[i].name;
  if (recentParts[recentParts.length - 1] !== name) recentParts = [...recentParts.slice(-1), name];
})));
function previousAndCurrent(): [number, number] | null {
  const cur = selectedPartIndex();
  if (cur < 0 || recentParts.length < 2 || recentParts[1] !== draft.parts[cur].name) return null;
  const prev = draft.parts.findIndex((p) => p.name === recentParts[0]);
  return prev >= 0 && prev !== cur ? [prev, cur] : null;
}

/** A then B selected one after the other (A the first, B the second), else null. */
export const selectedPair = (): [number, number] | null => previousAndCurrent();

/** The Boolean keys (+ − * /) belong to the Boolean now: one is being set up, or a solid is selected
 * (and there is a second solid to pick). Otherwise the keys keep their other uses (zoom in the 3D view). */
export function booleanKeysActive(): boolean {
  const p = booleanPending();
  return !!(p && p.a >= 0) || (selectedPartIndex() >= 0 && draft.parts.length >= 2);
}

/**
 * A Boolean key (Keypad + − * /): with a solid selected it starts that operation with the
 * selected solid as A (the first one, kept), and the solid picked next in the tree or the 3D view is B (Enter applies,
 * Esc cancels). The order is always first selected, then picked, whatever was selected before. While a Boolean is
 * being set up, a key changes its operation, and the same key again applies it once B is chosen. False when there is
 * nothing to combine (the key keeps its other use).
 */
export function booleanShortcut(operation: BooleanOperation): boolean {
  const p = booleanPending();
  if (p && p.a >= 0) {
    if (p.b !== undefined && p.operation === operation) applyPendingBoolean(operation);
    else setBooleanOperation(operation);
    return true;
  }
  if (!booleanKeysActive()) return false;
  armBoolean(operation, selectedPartIndex());
  return true;
}

/** One of the two is the result of an Insert of the other. */
const insertPair = (x: DesignPart, y: DesignPart) =>
  (x.booleanHistory?.live && x.booleanHistory.operation === "insert" && x.booleanHistory.B.name === y.name)
  || (y.booleanHistory?.live && y.booleanHistory.operation === "insert" && y.booleanHistory.B.name === x.name);

// Geometry-only comparison intentionally ignores labels, materials and inspector metadata.
const geometryKey = (p: Design["parts"][number]) => JSON.stringify({ primitives: p.primitives, transforms: p.transforms, cuts: p.cuts });
registerPostEditObserver((before, after) => {
  if (!before.parts || !after.parts || applyingBoolean) { setAutomaticOverlap(null); return; }
  const old = new Map(before.parts.map(p => [p.name, geometryKey(p)]));
  const candidates = after.parts.map((p, i) => ({ p, i })).filter(({ p }) => old.get(p.name) !== geometryKey(p));
  for (const { p, i } of candidates) {
    // the two sides of a live Insert overlap by design (the inserted shape sits in what it was cut from)
    const b = after.parts.findIndex((other, j) => j !== i && !insertPair(p, other) && booleanOverlap(p, other, names().names));
    if (b >= 0) { setAutomaticOverlap({ a: i, b, before, after }); return; }
  }
  setAutomaticOverlap(null);
});
// Live Boolean results follow their operands' parameters: recomputed inside each edit (one undo
// step with the parameter change). A value at which the result cannot be built keeps the last
// result and says why. A result counts as edited by hand only when this very edit changed its
// shapes under an unchanged Boolean history: a draft restored by undo, redo or a history jump is
// recomputed, never frozen.
const liveKeys = new Map<string, { key: string; result: string }>();
registerDeriveHook((d, values, before) => {
  const was = new Map((before.parts ?? []).map((p) => [p.name, p]));
  for (const part of d.parts ?? []) {
    const h = part.booleanHistory;
    if (!h?.live) continue;
    // an Insert follows the inserted shape, a part of its own: its later edits (a move, a new size) reach the result
    if (h.operation === "insert") {
      const inserted = (d.parts ?? []).find((q) => q !== part && q.name === h.B.name);
      if (inserted && JSON.stringify(inserted) !== JSON.stringify(h.B)) h.B = JSON.parse(JSON.stringify(inserted));
    }
    const key = JSON.stringify([h, values]), own = JSON.stringify(part.primitives);
    const prev = was.get(part.name);
    if (prev?.booleanHistory && JSON.stringify(prev.booleanHistory) === JSON.stringify(h) && JSON.stringify(prev.primitives) !== own) {
      // its shapes were edited by hand in this edit: keep them, and stop recomputing over them
      h.live = false;
      liveKeys.delete(part.name);
      setMessage({ tone: "warn", text: t("boolean.editedDirectly", { part: part.label || part.name }) });
      continue;
    }
    const last = liveKeys.get(part.name);
    if (last?.key === key && last.result === own) continue;
    try {
      const primitives = materialiseBoolean(h, values);
      if (!primitives.length) throw Error(t("boolean.emptyResult"));
      const result = JSON.stringify(primitives);
      if (result !== own) part.primitives = primitives;
      liveKeys.set(part.name, { key, result });
    } catch (e) {
      liveKeys.set(part.name, { key, result: own });
      setMessage({ tone: "warn", text: t("boolean.cannotRecompute", { part: part.label || part.name, op: BOOLEAN_LABELS[h.operation].toLocaleLowerCase(localeTag()), error: (e as Error).message }) });
    }
  }
});
registerDocumentChangeObserver(() => { setAutomaticOverlap(null); setBooleanNotice(""); setBooleanPending(null); });

/** The overlap prompt's choices, worded with the parts' names (new: the part just edited). */
export function overlapChoices(o: AutomaticOverlap): [OverlapChoice, string][] {
  const n = partTitle(o.a), x = partTitle(o.b);
  return [["add", t("boolean.op.add")], ["subtractAB", t("boolean.overlap.subtract", { a: n, b: x })], ["subtractBA", t("boolean.overlap.subtract", { a: x, b: n })], ["intersect", t("boolean.op.intersect")],
    ["insert", t("boolean.overlap.insert", { a: n, b: x })], ["keep", t("boolean.overlap.keep")], ["cancel", t("boolean.overlap.cancel")]];
}
const choiceOperation = (choice: OverlapChoice | null, o: AutomaticOverlap): { a: number; b: number; operation: BooleanOperation | null } => {
  if (choice === "subtractBA") return { a: o.b, b: o.a, operation: "subtract" };
  if (choice === "add" || choice === "intersect" || choice === "insert") return { a: o.a, b: o.b, operation: choice };
  if (choice === "subtractAB") return { a: o.a, b: o.b, operation: "subtract" };
  return { a: o.a, b: o.b, operation: null };
};

export function resolveAutomaticOverlap(choice: OverlapChoice) {
  const pending = automaticOverlap();
  setOverlapChoice(null);
  if (!pending) return;
  if (JSON.stringify(draft) !== JSON.stringify(pending.after)) { setAutomaticOverlap(null); return; }
  if (choice === "cancel") {
    revertObservedEdit(pending.before, pending.after);
    setAutomaticOverlap(null);
    return;
  }
  if (choice === "keep") { setAutomaticOverlap(null); return; }
  const { a, b, operation } = choiceOperation(choice, pending);
  const done = commitBoolean(a, b, operation!);
  setAutomaticOverlap(null);
  if (!done) return;
}

// ------------------------------------------------------------------ the 3D preview

type PreviewSpec = { a: number; b: number; operation: BooleanOperation | null; candidate: boolean; hideB: boolean };
const previewSpec = createRoot(() => createMemo<PreviewSpec | null>(() => {
  const o = automaticOverlap();
  if (o) return { ...choiceOperation(overlapChoice(), o), candidate: false, hideB: true };
  const p = booleanPending();
  if (!p || p.a < 0 || !draft.parts[p.a]) return null;
  if (p.b !== undefined && draft.parts[p.b]) return { a: p.a, b: p.b, operation: p.operation, candidate: false, hideB: true };
  // B still to be chosen: the part under the pointer is previewed as B
  const h = hoverPart(), i = h ? draft.parts.findIndex((q) => q.name === h) : -1;
  return { a: p.a, b: i !== p.a ? i : -1, operation: p.operation, candidate: true, hideB: false };
}, null, { equals: (x, y) => JSON.stringify(x) === JSON.stringify(y) }));

/** Why the Boolean shown cannot be applied ("" when it can). */
export const [booleanPreviewError, setBooleanPreviewError] = createSignal("");
/** What applying the Boolean shown also does (an empty result removes the part). */
export const [booleanPreviewNote, setBooleanPreviewNote] = createSignal("");

/** A part's shapes as the viewport draws them: the solid ones and its cut-outs (void shapes, a Subtract of curved shapes). */
function shapesAndCuts(part: DesignPart): { solid: Primitive[]; cut: Primitive[] } {
  const b = quickBundle({ ...(draft as Design), ports: [], resistors: [], parts: [part] }, names().names, null);
  return { solid: b?.parts.find((p) => !p.void)?.primitives ?? [], cut: b?.parts.filter((p) => p.void).flatMap((p) => p.primitives) ?? [] };
}
const shapes = (part: DesignPart): Primitive[] => shapesAndCuts(part).solid;

createRoot(() => createEffect(() => {
  const spec = previewSpec();
  const A = spec ? draft.parts[spec.a] : undefined;
  if (!spec || !A) { setBooleanPreviewGeometry(null); setBooleanPreviewError(""); setBooleanPreviewNote(""); return; }
  const B = spec.b >= 0 ? draft.parts[spec.b] : undefined;
  let result: Primitive[] = [], resultCut: Primitive[] = [], intersection: Primitive[] = [], error = "", note = "";
  if (B) {
    const values = names().names;
    const view = booleanPreview(A, B, spec.operation ?? "add", values);
    intersection = view.intersection.length ? shapes({ name: "__boolean_both", material: A.material, primitives: view.intersection }) : [];
    if (spec.operation) {
      error = view.error ?? "";
      if (view.empty) note = spec.operation === "intersect" ? t("boolean.nothingInCommon", { a: A.label || A.name, b: B.label || B.name }) : t("boolean.resultEmpty", { a: A.label || A.name });
      ({ solid: result, cut: resultCut } = view.result.length ? shapesAndCuts({ name: "__boolean_result", material: A.material, primitives: view.result }) : { solid: [], cut: [] });
    }
  }
  setBooleanPreviewError(spec.candidate ? "" : error);
  setBooleanPreviewNote(spec.candidate ? "" : note);
  setBooleanPreviewGeometry({
    operation: spec.operation, a: shapes(A), b: B ? shapes(B) : [], intersection, result, resultCut, candidate: spec.candidate,
    hide: [A.name, ...(B && spec.hideB ? [B.name] : [])],
  });
}));

createRoot(() => createEffect(() => {
  const pending = automaticOverlap();
  if (pending && JSON.stringify(draft) !== JSON.stringify(pending.after)) setAutomaticOverlap(null);
}));
