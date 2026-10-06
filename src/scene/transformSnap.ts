import { createSignal } from "solid-js";

export interface TransformPlacement { part: string }

const [placement, setPlacement] = createSignal<TransformPlacement | null>(null);
const [anchor, setAnchor] = createSignal<[number, number, number] | null>(null);

export const transformPlacement = placement;
export const transformAnchor = anchor;

export function startTransformPlacement(part: string) {
  setAnchor(null);
  setPlacement({ part });
}

export function stopTransformPlacement() {
  setPlacement(null);
  setAnchor(null);
}

export function setTransformAnchor(point: [number, number, number]) { setAnchor(point); }
