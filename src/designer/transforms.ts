import { createSignal } from "solid-js";
import type { Primitive } from "../types";
import type { DesignTransform } from "./types";
import type { TransformTarget } from "./transformModel";

export const [transformRequest, setTransformRequest] = createSignal<{
  type: DesignTransform["type"]; target: TransformTarget;
} | null>(null);

/** Dialog-only geometry: never feeds the draft or the server preview queue. */
export const [previewGeometry, setPreviewGeometry] = createSignal<Primitive[]>([]);

export function openTransform(type: DesignTransform["type"], target: TransformTarget) {
  setTransformRequest({ type, target: { ...target } });
}

/** World-space operation reference; drawing guides never enter saved RF geometry. */
export const [transformGuide, setTransformGuide] = createSignal<{kind:"axis"|"plane"; axis:number; point:[number,number,number]} | null>(null);

export const [transformSourceGeometry, setTransformSourceGeometry] = createSignal<Primitive[]>([]);
