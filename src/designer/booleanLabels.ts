import type { DesignPart, DesignPrimitive } from './types.ts';
import { materialiseBoolean } from './booleanParts.ts';

type History = NonNullable<DesignPart['booleanHistory']>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const primitiveGeometry = (primitives: DesignPrimitive[]) => JSON.stringify(primitives.map(({ label: _label, ...shape }) => shape));

/** Persist a label edit in its retained source primitive, not in a transient result index.
 * A disposable materialization traces unique source labels through the existing operations.
 * Generated topology and one-to-many copies have no unique editable source and are refused.
 * No tracing marker is saved. The ordinary TS/Python history format remains sufficient. */
export function relabelBooleanSources(history: History, before: DesignPrimitive[], edited: DesignPrimitive[], values: Record<string, number>): { history: History; primitives: DesignPrimitive[] } | null {
  if (primitiveGeometry(before) !== primitiveGeometry(edited)) return null;
  try {
    const candidate = clone(history), probe = clone(history);
    let prefix = '__fairbeam_source_label_';
    const serialized = JSON.stringify(history);
    while (serialized.includes(prefix)) prefix += '_';
    const sources = new Map<string, DesignPrimitive>();
    const tag = (source: DesignPart, traced: DesignPart) => {
      if (source.booleanHistory?.live && traced.booleanHistory?.live) {
        tag(source.booleanHistory.A, traced.booleanHistory.A);
        tag(source.booleanHistory.B, traced.booleanHistory.B);
      } else source.primitives.forEach((primitive, index) => {
        const token = `${prefix}${sources.size}`;
        sources.set(token, primitive);
        traced.primitives[index].label = token;
      });
    };
    tag(candidate.A, probe.A); tag(candidate.B, probe.B);
    const traced = materialiseBoolean(probe, values);
    if (primitiveGeometry(traced) !== primitiveGeometry(before)) return null;
    const occurrences = new Map<string, number>();
    for (const primitive of traced) if (primitive.label) occurrences.set(primitive.label, (occurrences.get(primitive.label) ?? 0) + 1);
    for (let i = 0; i < edited.length; i++) {
      if (before[i].label === edited[i].label) continue;
      const token = traced[i].label;
      if (!token || !sources.has(token) || occurrences.get(token) !== 1) return null;
      const source = sources.get(token)!;
      if (edited[i].label === undefined || edited[i].label === '') delete source.label;
      else source.label = edited[i].label;
    }
    // Refresh nested cached results as well, so Restore operands shows the renamed source.
    const refresh = (part: DesignPart) => {
      if (!part.booleanHistory?.live) return;
      refresh(part.booleanHistory.A); refresh(part.booleanHistory.B);
      // Children already have fresh cached geometry. Detach only these disposable inputs,
      // avoiding repeated traversal of a long history chain; stored histories stay live.
      const cached = (child: DesignPart): DesignPart => ({ ...child, booleanHistory: undefined });
      part.primitives = materialiseBoolean({ ...part.booleanHistory, A: cached(part.booleanHistory.A), B: cached(part.booleanHistory.B) }, values);
    };
    refresh(candidate.A); refresh(candidate.B);
    const primitives = materialiseBoolean(candidate, values);
    if (primitiveGeometry(primitives) !== primitiveGeometry(before)) return null;
    for (let i = 0; i < edited.length; i++) {
      if ((edited[i].label ?? '') !== (primitives[i].label ?? '')) return null;
    }
    return { history: candidate, primitives };
  } catch { return null; } // Failed/ambiguous materialization never detaches live geometry.
}
