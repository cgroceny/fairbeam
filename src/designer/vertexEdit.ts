// Vertex editing state (#66): which polygon or wire has its points editable in the 3D view, the
// picked vertex, and the design edits. Each insert, move and delete is exactly one undo step.
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { draft, edit, file, selection, setMessage } from "./store";
import { insertVertex, isVertexPrimitive, minVertices, moveVertex, removeVertex, type VertexPrimitive } from "./vertexModel";
import type { Expr } from "./types";

export interface VertexTarget { i: number; j: number }
const [target, setTarget] = createSignal<VertexTarget | null>(null);
const [picked, setPicked] = createSignal<number | null>(null);
export const vertexTarget = target;
export const pickedVertex = picked;

export function targetPrimitive(t = target()): VertexPrimitive | null {
  const p = t ? draft.parts?.[t.i]?.primitives[t.j] : undefined;
  return isVertexPrimitive(p) ? p : null;
}

/** The polygon or wire the current selection points at: a shape, or a part with exactly one. */
export function selectedVertexTarget(): VertexTarget | null {
  const s = selection();
  if (s.type === "primitive") return isVertexPrimitive(draft.parts[s.i]?.primitives[s.j]) ? { i: s.i, j: s.j } : null;
  if (s.type !== "part" || !draft.parts[s.i]) return null;
  const js = draft.parts[s.i].primitives.flatMap((p, j) => (isVertexPrimitive(p) ? [j] : []));
  return js.length === 1 ? { i: s.i, j: js[0] } : null;
}

export function startVertexEdit(t: VertexTarget) {
  if (!targetPrimitive(t)) return;
  setPicked(null);
  setTarget(t);
}
export function stopVertexEdit() {
  setPicked(null);
  setTarget(null);
}
export function toggleVertexEdit(t: VertexTarget) {
  const cur = target();
  if (cur && cur.i === t.i && cur.j === t.j) stopVertexEdit();
  else startVertexEdit(t);
}

/** Pick a vertex (highlight it and show its row in the inspector). */
export function pickVertex(k: number | null) {
  const t = target();
  setPicked(k);
  if (t && k !== null) {
    window.dispatchEvent(new CustomEvent("fairbeam:reveal-point", { detail: { path: `parts[${t.i}].primitives[${t.j}].points[${k}]` } }));
  }
}

const edited = (i: number, j: number, fn: (p: VertexPrimitive) => void) =>
  edit((d) => { const p = d.parts[i]?.primitives[j]; if (isVertexPrimitive(p)) fn(p); }, "");

export function insertVertexAt(t: VertexTarget, after: number, point: Expr[]) {
  edited(t.i, t.j, (p) => insertVertex(p, after, point));
  if (target()?.i === t.i && target()?.j === t.j) pickVertex(after + 1);
}

export function moveVertexTo(t: VertexTarget, k: number, point: Expr[]) {
  edited(t.i, t.j, (p) => moveVertex(p, k, point));
}

export function deleteVertex(t: VertexTarget, k: number): boolean {
  const p = targetPrimitive(t);
  if (!p) return false;
  if (p.points.length <= minVertices(p)) {
    setMessage({ tone: "warn", text: `A ${p.kind === "wire" ? "wire keeps at least two points" : "polygon keeps at least three points"}; point ${k + 1} was not removed.` });
    return false;
  }
  edited(t.i, t.j, (q) => { removeVertex(q, k); });
  if (target()?.i === t.i && target()?.j === t.j) setPicked(null);
  return true;
}

// Leave vertex editing when its shape goes away (undo, delete, another document) or the selection
// moves to other geometry; a picked vertex past the end is dropped.
createRoot(() => {
  createEffect(on(() => file()?.id, stopVertexEdit, { defer: true }));
  createEffect(() => {
    const t = target();
    if (!t) return;
    const p = targetPrimitive(t);
    if (!p) { stopVertexEdit(); return; }
    const k = picked();
    if (k !== null && k >= p.points.length) setPicked(null);
  });
  createEffect(on(selection, (s) => {
    const t = target();
    if (!t) return;
    if (!((s.type === "part" && s.i === t.i) || (s.type === "primitive" && s.i === t.i && s.j === t.j))) stopVertexEdit();
  }, { defer: true }));
});
