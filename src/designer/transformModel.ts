import { evaluate } from "./expr.ts";
import { portFeedEntries } from "../lib/portGroups.ts";
import type { Design, DesignPart, DesignTransform, Selection } from "./types.ts";

export type TransformTarget = Extract<Selection, { type: "part" | "primitive" }>
  | { type: "component"; indices: number[]; name: string };

type GeometryTarget = Extract<Selection, { type: "part" | "primitive" }>;

/** The selected geometry, retaining the order of its existing cuts and transforms. */
export function transformPart(d: Design, target: GeometryTarget, transform: DesignTransform): DesignPart {
  const part = d.parts[target.i];
  return {
    ...part,
    primitives: target.type === "primitive" ? [part.primitives[target.j]] : part.primitives,
    transforms: [...(part.transforms ?? []), transform],
  };
}

/** Geometry shown by the Transform dialog. Each selected member is derived from the same baseline,
 * and the preview contains no ports or resistors because those stay at their world coordinates. */
export function transformPreview(d: Design, target: TransformTarget, transform: DesignTransform): Design {
  const parts = target.type === "component"
    ? componentIndices(d, target).map((i) => transformPart(d, { type: "part", i }, transform))
    : [transformPart(d, target, transform)];
  return { ...d, ports: [], resistors: [], parts };
}

/** Whether the transform moves, turns, mirrors or scales the selected shapes themselves, leaving no
 * original in place: a move, a rotation or scale without copies, a mirror that does not keep the
 * original. With copies the original stays where it is, so a port that touches it still does. */
export function displacesOriginal(t: DesignTransform): boolean {
  switch (t.type) {
    case "move": return true;
    case "translate": return false;
    case "mirror": return t.keep === false;
    case "rotate": case "scale": {
      // a plain zero (or none) is no copy; an expression is taken to make copies
      const c = t.copies;
      return c === undefined || c === 0 || (typeof c === "string" && c.trim() !== "" && Number(c) === 0);
    }
  }
}

export type Bounds3 = [readonly number[], readonly number[]];
export interface AffectedPort { index: number; number: number }

/** The ports with an end on or inside one of these boxes (the bounds of the selected shapes before
 * the transform), within a tolerance. Ports are placed by their own start and stop coordinates, not
 * attached to a shape, so they stay where they are when it moves: they no longer span its feed gap
 * (the run then gives |S11| of about 0 dB and no radiation). Pure; the dialog warns and offers to
 * select them. An expression that does not evaluate leaves that port out. */
export function portsAtShapes(d: Pick<Design, "ports">, boxes: readonly Bounds3[], names: Record<string, number>): AffectedPort[] {
  const size = Math.max(1, ...boxes.flatMap((b) => b[1].map((hi, k) => Math.abs(hi - b[0][k]))));
  const tol = 1e-6 * size;
  const out: AffectedPort[] = [];
  (d.ports ?? []).forEach((port, index) => {
    // every physical feed of a grouped port counts (portFeedEntries: the port itself, then its members)
    const ends = portFeedEntries(port, "").flatMap(([, feed]) => [feed.start, feed.stop]).map((end) => {
      try { return end.map((v) => evaluate(v, names)); } catch { return null; }
    });
    const touches = ends.some((p) => p && p.every((v) => Number.isFinite(v)) && boxes.some((b) => p.every((v, k) => v >= b[0][k] - tol && v <= b[1][k] + tol)));
    if (touches) out.push({ index, number: port.number });
  });
  return out;
}

function componentIndices(d: Design, target: Extract<TransformTarget, { type: "component" }>): number[] {
  if (!target.indices.length || new Set(target.indices).size !== target.indices.length
    || target.indices.some((i) => !Number.isInteger(i) || !d.parts[i])) {
    throw new Error("A component transform needs distinct, valid member indices.");
  }
  return target.indices;
}

/** One undoable edit. Detach a shape only when its siblings must stay in place. */
export function applyTransform(d: Design, target: TransformTarget, transform: DesignTransform): number {
  if (target.type === "component") {
    const indices = componentIndices(d, target);
    // Prepare every result before writing any of them, so a malformed target cannot leave a partial
    // component transform. One call from the dialog is wrapped in one store edit/undo entry.
    const results = indices.map((i) => JSON.parse(JSON.stringify(
      transformPart(d, { type: "part", i }, transform),
    )) as DesignPart);
    indices.forEach((i, n) => { d.parts[i] = results[n]; });
    return indices[0];
  }
  // Store drafts may be proxies. Copy the JSON data so later edits to a detached part's
  // cuts or earlier transforms cannot also change its siblings through shared references.
  const result = JSON.parse(JSON.stringify(transformPart(d, target, transform))) as DesignPart;
  if (target.type === "primitive" && d.parts[target.i].primitives.length > 1) {
    const base = `${result.name}_shape`;
    let name = base, n = 2;
    while (d.parts.some((p) => p.name === name)) name = `${base}_${n++}`;
    result.name = name;
    result.label = result.primitives[0].label || name;
    d.parts[target.i].primitives.splice(target.j, 1);
    d.parts.push(result);
    return d.parts.length - 1;
  }
  d.parts[target.i] = result;
  return target.i;
}
