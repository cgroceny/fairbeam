// What the 3D view draws while a Boolean is set up (booleanUi.ts computes it, scene/booleanOverlay.ts
// draws it): operand A (kept) and operand B in their own translucent colours, B's colour telling
// the operation (red: removed from A, green: added or kept in common, violet: no operation chosen
// yet), their common volume highlighted, and the ghost of the result.
import { createSignal } from "solid-js";
import type { Primitive } from "../types";
import type { BooleanOperation } from "./types";

export interface BooleanPreviewGeometry {
  /** null: operands shown, no operation chosen yet (the overlap prompt before a choice) */
  operation: BooleanOperation | null;
  a: Primitive[];
  b: Primitive[];
  intersection: Primitive[];
  result: Primitive[];
  /** the result's cut-outs (void shapes of a Subtract of curved shapes), drawn as a dashed hole */
  resultCut: Primitive[];
  /** B is only the part under the pointer (not chosen yet): its own mesh stays */
  candidate: boolean;
  /** part names whose own meshes give way to the preview colours */
  hide: string[];
}

export const [booleanPreviewGeometry, setBooleanPreviewGeometry] = createSignal<BooleanPreviewGeometry | null>(null);

/** The colour token of operand B for an operation. */
export const operandBToken = (op: BooleanOperation | null) =>
  op === "subtract" || op === "insert" ? "--al-3d-bool-sub" : op === "add" || op === "intersect" ? "--al-3d-bool-add" : "--al-3d-bool-other";

/** The region a Subtract just removed: the 3D view flashes it in the cut-out colour for a moment (scene/booleanOverlay.ts). */
export const FLASH_MS = 2200;
export const [booleanFlash, setBooleanFlash] = createSignal<{ shapes: Primitive[]; id: number } | null>(null);
let flashId = 0, flashTimer: ReturnType<typeof setTimeout> | undefined;
export function flashRemoved(shapes: Primitive[]) {
  clearTimeout(flashTimer);
  if (!shapes.length) { setBooleanFlash(null); return; }
  const id = ++flashId;
  setBooleanFlash({ shapes, id });
  flashTimer = setTimeout(() => { if (flashId === id) setBooleanFlash(null); }, FLASH_MS);
}
