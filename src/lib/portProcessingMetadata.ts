import type { Bundle } from "../types.ts";

export interface PortProcessingSettings {
  /** One common positive real power-wave reference in ohms. */
  referenceOhm: number;
  /** Physical port ID -> one-way delay removed, in picoseconds. Negative adds line. */
  delayPs: Record<number, number>;
}
export interface PortProcessingInfo {
  source: Bundle;
  settings: PortProcessingSettings;
  physicalPorts: number[];
  sourceReferences: number[];
  missingSamples: number;
  description: string;
}
// Session-only provenance. No schema fields, saved files or imported raw results are modified.
const projections = new WeakMap<Bundle, PortProcessingInfo>();
export const portProcessingInfo = (b: Bundle | null | undefined) => b ? projections.get(b) : undefined;
export const originalPortResult = (b: Bundle): Bundle => projections.get(b)?.source ?? b;
export function registerPortProjection(b: Bundle, info: PortProcessingInfo): void {
  Object.freeze(info.settings.delayPs); Object.freeze(info.settings);
  Object.freeze(info.physicalPorts); Object.freeze(info.sourceReferences);
  projections.set(b, Object.freeze(info));
}
