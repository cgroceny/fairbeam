import type { Bundle } from "../types.ts";

export interface PortProcessingSettings {
  /** Real part of a common Kurokawa power-wave reference, positive ohms. */
  referenceOhm: number;
  referenceImagOhm?: number;
  /** Ordered [+ physical ID, - physical ID] disjoint differential pairs. */
  mixedPairs?: [number, number][];
  /** Physical port ID -> one-way delay removed, in picoseconds. Negative adds line. */
  delayPs: Record<number, number>;
}
export interface PortChannel {
  kind: "single" | "differential" | "common";
  ordinal: number;
  physical: number[];
  /** Original canonical indices; Touchstone descriptors use these, never physical IDs. */
  canonical: number[];
  referenceRe: number;
  referenceIm: number;
}
export const channelLabel = (c: PortChannel) => c.kind === "single" ? `P${c.physical[0]}` : `${c.kind === "differential" ? "D" : "C"}${c.ordinal}(P${c.physical[0]}-P${c.physical[1]})`;
export const channelPairLabel = (a: PortChannel, b: PortChannel) => {
  const tag = (c: PortChannel) => c.kind === "single" ? "s" : c.kind === "differential" ? "d" : "c";
  return `S${tag(a)}${tag(b)}${a.ordinal < 10 && b.ordinal < 10 ? `${a.ordinal}${b.ordinal}` : `${a.ordinal},${b.ordinal}`} [${channelLabel(a)} <- ${channelLabel(b)}]`;
};
export interface PortProcessingInfo {
  source: Bundle;
  settings: PortProcessingSettings;
  physicalPorts: number[];
  sourceReferences: number[];
  missingSamples: number;
  description: string;
  channels: PortChannel[];
  primaryIndex: number;
}
// Session-only provenance. No schema fields, saved files or imported raw results are modified.
const projections = new WeakMap<Bundle, PortProcessingInfo>();
export const portProcessingInfo = (b: Bundle | null | undefined) => b ? projections.get(b) : undefined;
export const originalPortResult = (b: Bundle): Bundle => projections.get(b)?.source ?? b;
export const hasComplexPortReference = (b: Bundle | null | undefined) => !!portProcessingInfo(b)?.channels.some(c => c.referenceIm !== 0);
export const hasMixedPortCoordinates = (b: Bundle | null | undefined) => !!portProcessingInfo(b)?.settings.mixedPairs?.length;
export const primaryPortLabel = (b: Bundle) => {
  const info = portProcessingInfo(b), c = info?.channels[info.primaryIndex - 1];
  return c && hasMixedPortCoordinates(b) ? channelPairLabel(c, c) : "S11";
};
/** Differences in unlike modal/reference coordinates are not comparable network improvements. */
export const samePortProcessing = (a: Bundle, b: Bundle) => {
  const x = portProcessingInfo(a), y = portProcessingInfo(b);
  return !x && !y || !!x && !!y && JSON.stringify(x.settings) === JSON.stringify(y.settings) && JSON.stringify(x.channels) === JSON.stringify(y.channels);
};
export function registerPortProjection(b: Bundle, info: PortProcessingInfo): void {
  info.settings.mixedPairs?.forEach(Object.freeze); if (info.settings.mixedPairs) Object.freeze(info.settings.mixedPairs);
  Object.freeze(info.settings.delayPs); Object.freeze(info.settings);
  Object.freeze(info.physicalPorts); Object.freeze(info.sourceReferences);
  info.channels.forEach(c => { Object.freeze(c.physical); Object.freeze(c.canonical); Object.freeze(c); }); Object.freeze(info.channels);
  projections.set(b, Object.freeze(info));
}
